/**
 * 技能：一个子助理在某一类活上攒下来的做法。
 *
 * 三条硬约束（都来自产品要求，不是实现偏好）：
 *
 * 1. **归属单个助理**。技能只在他自己的会话里注入，**绝不进总助理的提示词** ——
 *    否则十个助理的技能会把总助理的上下文撑爆，而且总助理会拿别人的做法去裁决别的事。
 * 2. **版本化 + 可回滚**。技能会自动演化，演化就会有变差的时候。每次改动留一版，
 *    回滚是"切回去"而不是"删掉重写"，这样历史仍可追溯。
 * 3. **范围不变才自动晋升，扩权必须本人批准**。技能想读新目录、想执行命令，那是权限扩张，
 *    不是学习。这一条在 {@link SkillPlan} 的 `scopeChanged` 里表达，由调用方决定要不要拦。
 *
 * 存储与注入之外，"自动形成"由装配层接上：同类工作攒够可信样本后，
 * 计数归代码、正文归模型，生成后默认自动生效（扩权仍须本人批准），人工只做事后查验。
 * `record()`/`save()` 仍接受显式提交（本人或模型提候选）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { inTransaction } from './store.ts'
import type { SkillSample } from './skill-formation.ts'

export const SKILL_STATUSES = ['candidate', 'active', 'retired'] as const
export type SkillStatus = typeof SKILL_STATUSES[number]

export interface SkillVersion {
  id: string
  assistantId: string
  name: string
  /** 技能正文：做什么、按什么步骤、注意什么。只注入给该助理。 */
  body: string
  version: number
  status: SkillStatus
  createdAt: number
  /** 来源：manual=人工/模型显式提交；auto-verified=本人确认样本自动形成；auto-selfreport=成员自报样本自动形成（待查验）。 */
  origin: 'manual' | 'auto-verified' | 'auto-selfreport'
}

/** 技能的声明式形状；`scopeChanged` 为真表示这次演化扩大了权限，必须本人批准。 */
export interface SkillPlan {
  name: string
  body: string
  scopeChanged?: boolean
}

/** 攒够几次才提示"可以形成技能"。三取决于产品要求，不是调参。 */
export const SKILL_FORM_THRESHOLD = 3

/**
 * 技能成形判据。
 *
 * 只有两件事归代码：**计数**与**判定"够不够"**。
 * 写技能正文归模型 —— 代码编出来的"经验"是伪造的经验，那比没有技能更糟。
 *
 * `shape` 是调用方算出来的"同类"签名（任务类型 + 用到的能力 + 目标模式）。
 * 不在本模块里算，是因为"同类"的定义属于业务判断，而它一旦写死在存储层，
 * 以后想收紧或放宽都得改这里。
 */
export interface SkillEvidence {
  shape: string
  count: number
  lastAt: number
}


export class SkillStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_versions (
        skill_key TEXT NOT NULL,
        assistant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('candidate', 'active', 'retired')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (skill_key, version)
      );
      CREATE INDEX IF NOT EXISTS idx_skill_owner ON skill_versions(assistant_id, skill_key, version DESC);

      /*
       * 技能成形的证据：一次"可信成功"记一行。
       *
       * 只有可信成功才进来（四态回执 succeeded 且验证器读回通过）；
       * unknown / review 绝不入库 —— 否则技能会学出"怎么假装成功"。
       * 按行存而不是按计数存：计数丢了没法查是哪几次，而行能回答
       * "这条技能是从哪三次活里长出来的"。
       */
      CREATE TABLE IF NOT EXISTS skill_evidence (
        assistant_id TEXT NOT NULL,
        shape TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_skill_evidence ON skill_evidence(assistant_id, shape, recorded_at DESC);
    `)
    /*
     * `verified`：这次成功**有没有被独立核实**。
     *
     * 加这一列的原因：`noteSuccess` 是个公开方法，将来一定会有人从"成员自报成功"那条路接进来。
     * 自报不等于成功，而技能一旦从自报样本长出来，学到的就是"怎么说明自己做完了"。
     * 所以默认 0，只有拿到四态回执或本人确认的调用方才能写 1；判定只数 1。
     *
     * 用 PRAGMA + ALTER 而不是重建表：老库里的行默认得 0（未核实），
     * 语义上正好是"历史证据一律不被信任"，不需要回填。
     */
    const columns = (this.db.prepare('PRAGMA table_info(skill_evidence)').all() as Array<Record<string, unknown>>)
      .map(row => String(row.name))
    if (!columns.includes('verified')) this.db.exec('ALTER TABLE skill_evidence ADD COLUMN verified INTEGER NOT NULL DEFAULT 0')
    if (!columns.includes('source_ref')) this.db.exec('ALTER TABLE skill_evidence ADD COLUMN source_ref TEXT')
    if (!columns.includes('sample')) this.db.exec('ALTER TABLE skill_evidence ADD COLUMN sample TEXT')
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_source ON skill_evidence(assistant_id, shape, source_ref) WHERE source_ref IS NOT NULL')
    // 技能来源：老库默认 manual；自动形成的两条路各自打标，界面据此提示"待查验"。
    const skillColumns = (this.db.prepare('PRAGMA table_info(skill_versions)').all() as Array<Record<string, unknown>>)
      .map(row => String(row.name))
    if (!skillColumns.includes('origin')) this.db.exec("ALTER TABLE skill_versions ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'")
  }

  /**
   * 写入一个新版本。
   *
   * 同一个 (assistantId, name) 视为同一个技能：版本号在它上面递增。
   * 这里**不做自动晋升判断**——扩权要不要拦是调用方（审批层）的事，
   * 存储层只负责如实记下"谁在什么时候写了第几版、状态是什么"。
   */
  save(assistantId: string, plan: SkillPlan, status: SkillStatus, now = Date.now(), origin: SkillVersion['origin'] = 'manual'): SkillVersion {
    const owner = assistantId.trim()
    const name = plan.name.trim()
    const body = plan.body.trim()
    if (owner === '') throw new Error('技能必须归属一个助理')
    if (name === '') throw new Error('技能名称不能为空')
    if (body === '') throw new Error('技能正文不能为空')
    if (!SKILL_STATUSES.includes(status)) throw new Error('技能状态无效')
    const key = `${owner}:${name.normalize('NFKC').toLowerCase()}`
    const row = this.db.prepare('SELECT MAX(version) AS v FROM skill_versions WHERE skill_key = ?').get(key) as Record<string, unknown> | undefined
    const version = Number(row?.v ?? 0) + 1
    this.db.prepare(`
      INSERT INTO skill_versions(skill_key, assistant_id, name, body, version, status, created_at, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(key, owner, name, body, version, status, now, origin)
    return { id: key, assistantId: owner, name, body, version, status, createdAt: now, origin }
  }

  /** 删除一个技能的全部版本（界面"删"）。回滚/退役仍走版本化，删除是彻底移除。 */
  remove(id: string): number {
    return inTransaction(this.db, () => {
      const current = this.history(id)[0]
      const changed = this.db.prepare('DELETE FROM skill_versions WHERE skill_key = ?').run(id)
      if (current) this.retract(current.assistantId, current.name)
      return Number(changed.changes)
    })
  }

  /** 某个助理当前生效的技能（每项取最高版本且状态为 active）。 */
  active(assistantId: string): SkillVersion[] {
    const rows = this.db.prepare(`
      SELECT s.* FROM skill_versions s
      JOIN (SELECT skill_key, MAX(version) AS v FROM skill_versions WHERE assistant_id = ? GROUP BY skill_key) latest
        ON s.skill_key = latest.skill_key AND s.version = latest.v
      WHERE s.assistant_id = ? AND s.status = 'active'
      ORDER BY s.name
    `).all(assistantId, assistantId) as Array<Record<string, unknown>>
    return rows.map(row => this.map(row))
  }

  /** 全部技能的最新一版（界面展示用，含候选与退役）。 */
  list(assistantId?: string): SkillVersion[] {
    const sql = `
      SELECT s.* FROM skill_versions s
      JOIN (SELECT skill_key, MAX(version) AS v FROM skill_versions GROUP BY skill_key) latest
        ON s.skill_key = latest.skill_key AND s.version = latest.v
      ${assistantId === undefined ? '' : 'WHERE s.assistant_id = ?'}
      ORDER BY s.assistant_id, s.name
    `
    const rows = (assistantId === undefined ? this.db.prepare(sql).all() : this.db.prepare(sql).all(assistantId)) as Array<Record<string, unknown>>
    return rows.map(row => this.map(row))
  }

  /** 历史版本，最新在前。 */
  history(id: string): SkillVersion[] {
    const rows = this.db.prepare('SELECT * FROM skill_versions WHERE skill_key = ? ORDER BY version DESC').all(id) as Array<Record<string, unknown>>
    return rows.map(row => this.map(row))
  }

  /**
   * 回滚到指定版本：**把它切成新的一版**，而不是删掉后面的版本。
   *
   * 直接改版本号会让历史对不上（"第 3 版被改成了第 1 版的内容"），
   * 而"第 4 版 = 恢复第 2 版的内容"是可追溯的。回滚本身也可能回错，
   * 所以它同样要能再被回滚。
   */
  rollback(id: string, version: number, now = Date.now()): SkillVersion {
    const rows = this.db.prepare('SELECT * FROM skill_versions WHERE skill_key = ? AND version = ?').get(id, version) as Record<string, unknown> | undefined
    if (rows === undefined) throw new Error('目标版本不存在')
    const target = this.map(rows)
    return this.save(target.assistantId, { name: target.name, body: target.body }, 'active', now, target.origin)
  }

  /**
   * 注入给某个助理的段落。**空的时候返回空串**，调用方据此一个字都不加。
   * 段落里明确写"只在你自己的会话里"：技能是别人的经验时不该被当成全局规则。
   */
  renderFor(assistantId: string): string {
    const skills = this.active(assistantId)
    if (skills.length === 0) return ''
    return [
      '以下是你自己攒下来的技能（只属于你，不与其他助理共享；按需参考，不是授权，不改变工具权限）：',
      ...skills.map(item => `- ${item.name}（第 ${item.version} 版）：${item.body}`),
    ].join('\n')
  }

  /**
   * 记一次同类工作的样本。**只有 `verified: true` 才参与成形判定。**
   *
   * `verified` 必须由调用方根据**独立证据**填写（四态回执 succeeded + 语义验证通过，
   * 或本人在桌面确认过）。成员自报成功、模型自述完成、artifacts 非空 —— 都不算。
   * 传 false 也记一行，是为了留痕："这件事做过，但没核实"。
   */
  noteSuccess(assistantId: string, shape: string, verified: boolean, now = Date.now(), evidence?: { ref: string; sample: SkillSample }): number {
    const owner = assistantId.trim()
    const key = shape.trim()
    if (owner === '' || key === '') throw new Error('技能证据需要助理与同类工作签名')
    if (typeof verified !== 'boolean') throw new Error('必须明确这次成功是否已被独立核实')
    this.db.prepare(`INSERT OR IGNORE INTO skill_evidence(assistant_id, shape, recorded_at, verified, source_ref, sample)
      VALUES (?, ?, ?, ?, ?, ?)`).run(owner, key, now, verified ? 1 : 0, evidence?.ref ?? null, evidence ? JSON.stringify(evidence.sample) : null)
    return this.evidenceCount(owner, key)
  }

  verifiedSamples(assistantId: string, shape: string): SkillSample[] {
    const rows = this.db.prepare(`SELECT sample FROM skill_evidence WHERE assistant_id = ? AND shape = ? AND verified = 1
      AND source_ref IS NOT NULL AND sample IS NOT NULL ORDER BY recorded_at DESC, rowid DESC LIMIT 6`).all(assistantId, shape)
    return rows.map(row => JSON.parse(String(row.sample)) as SkillSample)
  }

  /** 某个 shape 里**已核实**的样本数。成形判定与界面都只看这个数。 */
  evidenceCount(assistantId: string, shape: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM skill_evidence WHERE assistant_id = ? AND shape = ? AND verified = 1')
      .get(assistantId.trim(), shape.trim()) as Record<string, unknown> | undefined
    return Number(row?.n ?? 0)
  }

  /** 某个 shape 里未核实的样本数（界面要能显示"还有几次没核实"）。 */
  unverifiedCount(assistantId: string, shape: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM skill_evidence WHERE assistant_id = ? AND shape = ? AND verified = 0')
      .get(assistantId.trim(), shape.trim()) as Record<string, unknown> | undefined
    return Number(row?.n ?? 0)
  }

  /**
   * 把某个 shape 里所有未核实的样本标为已核实。
   *
   * 只给"本人在桌面逐条确认过"这条路用。做成批量而不是逐条，
   * 是因为这条证据链的价值在"同意这几次确实发生过"，逐条点三下没有额外信息。
   */
  verifyAll(assistantId: string, shape: string): number {
    this.db.prepare('UPDATE skill_evidence SET verified = 1 WHERE assistant_id = ? AND shape = ? AND verified = 0')
      .run(assistantId.trim(), shape.trim())
    return this.evidenceCount(assistantId, shape)
  }

  /** 某个助理有样本（不论核实与否）的全部 shape，供界面列出"还有几次没核实"。 */
  listShapes(assistantId: string): string[] {
    const rows = this.db.prepare('SELECT DISTINCT shape FROM skill_evidence WHERE assistant_id = ? ORDER BY shape')
      .all(assistantId.trim()) as Array<Record<string, unknown>>
    return rows.map(row => String(row.shape ?? '')).filter(shape => shape !== '')
  }

  /** 撤回某次记录错的样本（整类清空）。 */
  retract(assistantId: string, shape: string): number {
    const changed = this.db.prepare('DELETE FROM skill_evidence WHERE assistant_id = ? AND shape = ?')
      .run(assistantId.trim(), shape.trim())
    return Number(changed.changes)
  }

  /**
   * 够格形成技能的"同类工作"。
   *
   * 判据三条，缺一不可：
   * 1. 该助理在这个 shape 上有 ≥ {@link SKILL_FORM_THRESHOLD} 次可信成功；
   * 2. 还没有以这个 shape 命名的技能（否则会反复提示同一件事）；
   * 3. 只回**候选**，不回"要不要自动晋升" —— 写正文之后要不要生效，由用户定。
   */
  pendingShapes(assistantId: string, threshold = SKILL_FORM_THRESHOLD): SkillEvidence[] {
    const rows = this.db.prepare(`
      SELECT shape, COUNT(*) AS n, MAX(recorded_at) AS last
      FROM skill_evidence WHERE assistant_id = ? AND verified = 1
      GROUP BY shape HAVING n >= ? ORDER BY n DESC, last DESC
    `).all(assistantId, Math.max(1, threshold)) as Array<Record<string, unknown>>
    const existing = new Set(this.list(assistantId).map(item => item.name.normalize('NFKC').toLowerCase()))
    return rows
      .map(row => ({ shape: String(row.shape ?? ''), count: Number(row.n ?? 0), lastAt: Number(row.last ?? 0) }))
      .filter(item => item.shape !== '' && !existing.has(item.shape.normalize('NFKC').toLowerCase()))
  }

  /** 某个 shape 目前攒了几次可信成功。 */
  private map(row: Record<string, unknown>): SkillVersion {
    const origin = String(row.origin ?? 'manual')
    return {
      id: String(row.skill_key ?? ''), assistantId: String(row.assistant_id ?? ''), name: String(row.name ?? ''),
      body: String(row.body ?? ''), version: Number(row.version ?? 0),
      status: (String(row.status ?? 'candidate') as SkillStatus), createdAt: Number(row.created_at ?? 0),
      origin: origin === 'auto-verified' || origin === 'auto-selfreport' ? origin : 'manual',
    }
  }
}
