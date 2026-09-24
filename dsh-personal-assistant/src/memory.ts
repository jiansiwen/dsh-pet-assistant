/**
 * 记忆服务：带来源、范围、版本、状态和删除传播的长期记忆读写。
 *
 * 与旧的 `preferences` 表（domain.ts）相比，这里补的是四件旧模型压根没有的事：
 *
 * 1. **来源**（sourceRefs + memory_sources）——一条结论由哪些证据支撑，删证据能传到结论。
 * 2. **范围**（scope）——"日报别写午休"落在项目还是落在用户全局，生效面完全不同。
 *    旧偏好是全局无维度的（tools.ts 里那句注释就是这么写的），跨项目一律生效。
 * 3. **状态**（candidate/confirmed/conflicting/expired）——专家只能提交候选，
 *    只有用户本人能把一条记忆抬成"已确认"。design.md §2.6。
 * 4. **删除账本**（deletion_ledger）——从备份恢复时不能把用户已经删掉的东西复活。
 *
 * 纯决策部分（权重、可见性、冲突判定、删除报告）都不碰 SQLite，
 * 这样 node --test 能直接跑，不需要把 cordis 或文件系统拖进测试。
 */
import type { DatabaseSync } from 'node:sqlite'
import { inTransaction, sha256, text, type Row } from './store.ts'

/** 记忆的六类。design.md §2.6。 */
export const MEMORY_KINDS = [
  /** 用户偏好：日报口径、交互习惯等长期有效的喜好。 */
  'user_preference',
  /** 项目事实：这个仓库/这项工作的客观情况，通常由专家观察后提交。 */
  'project_fact',
  /** 待办断点：上次做到哪儿、下一步是什么。 */
  'task_breakpoint',
  /** 团队共同经历：几个角色一起做过的事，用来建立默契。 */
  'team_experience',
  /** 角色表达偏好：某个角色该怎么说话，优先级最低。 */
  'role_expression',
  /** 临时对话：只在当前上下文有意义，到期即弃。 */
  'ephemeral_chat',
] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export const MEMORY_STATUSES = ['candidate', 'confirmed', 'conflicting', 'expired'] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

/** 可见范围。global 的 id 恒为空串，其余必须带 id。 */
export const SCOPE_KINDS = ['global', 'project', 'team', 'role', 'session'] as const
export type ScopeKind = (typeof SCOPE_KINDS)[number]

export interface MemoryScope {
  kind: ScopeKind
  id: string
}

/** 敏感级别。sensitive 在加密落地之前一律拒绝入库，见 {@link MemoryStore.put}。 */
export const SENSITIVITY_LEVELS = ['normal', 'sensitive'] as const
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number]

/** 写入者身份。只有 isUser 为真时才能直接产生"已确认"记忆。 */
export interface MemoryActor {
  id: string
  isUser: boolean
}

export interface MemoryRecord {
  id: string
  kind: MemoryKind
  scope: MemoryScope
  /** 这条记忆的主题分类；同主题不代表互斥，替换关系须由用户点名。 */
  topic: string
  text: string
  sourceRefs: string[]
  status: MemoryStatus
  sensitivity: Sensitivity
  createdBy: string
  confirmedBy: string | null
  revision: number
  createdAt: number
  updatedAt: number
  expiresAt: number | null
  /** 非空表示这是从旧数据迁移进来的，不是本系统原生观察到的。 */
  importBatch: string | null
}

/** 查询记忆时的当前上下文；缺哪一维就看不到那一维的范围记忆。 */
export interface MemoryContext {
  projectId?: string | null
  teamId?: string | null
  roleId?: string | null
  sessionId?: string | null
}

const KIND_SET = new Set<string>(MEMORY_KINDS)
const SCOPE_SET = new Set<string>(SCOPE_KINDS)
const SENSITIVITY_SET = new Set<string>(SENSITIVITY_LEVELS)

// ---------------------------------------------------------------------------
// 纯决策：校验、权重、可见性、冲突
// ---------------------------------------------------------------------------

export type WriteRejection =
  | 'unknown_kind'
  | 'unknown_scope'
  | 'missing_scope_id'
  | 'empty_text'
  | 'unknown_sensitivity'
  | 'sensitive_without_encryption'
  | 'replacement_requires_user'
  | 'invalid_replacement'

/**
 * 模型给的字段先过一遍白名单。
 *
 * 认不出来就拒绝，不做"猜一个最接近的"兜底：kind 和 scope 决定这条记忆能在多大范围
 * 生效，猜错的方向永远是多生效而不是少生效。宁可让模型重写一次。
 */
export function validateMemoryInput(input: {
  kind: string
  scopeKind: string
  scopeId?: string | null
  text: string
  sensitivity?: string | null
}): WriteRejection | null {
  if (!KIND_SET.has(input.kind)) return 'unknown_kind'
  if (!SCOPE_SET.has(input.scopeKind)) return 'unknown_scope'
  if (input.scopeKind !== 'global' && !(input.scopeId ?? '').trim()) return 'missing_scope_id'
  if (!input.text.trim()) return 'empty_text'
  const sensitivity = input.sensitivity ?? 'normal'
  if (!SENSITIVITY_SET.has(sensitivity)) return 'unknown_sensitivity'
  return null
}

export const WRITE_REJECTION_MESSAGES: Record<WriteRejection, string> = {
  unknown_kind: '记忆类型不认识，只能用 user_preference / project_fact / task_breakpoint / team_experience / role_expression / ephemeral_chat 之一',
  unknown_scope: '生效范围不认识，只能用 global / project / team / role / session 之一',
  missing_scope_id: '这个范围必须带上具体 id（项目 id、团队 id、角色 id 或会话 id）',
  empty_text: '记忆内容不能为空',
  unknown_sensitivity: '敏感级别不认识，只能用 normal 或 sensitive',
  sensitive_without_encryption:
    '这条被标成敏感内容，但本机还没有落地加密存储（数据密钥 + Windows DPAPI + 密钥恢复提示），所以拒绝写入。请改标 normal，或先在配置里启用加密。',
  replacement_requires_user: '只有用户明确指定的替换才能让旧记忆失效，助理只能提交候选',
  invalid_replacement: '替换目标必须存在、尚未失效，且与新记忆类型和范围一致；不能替换选中的记忆自身',
}

/**
 * 提示词里的排序权重，大的先进。
 *
 * design.md §2.6 给的顺序是"安全规则 → 当前用户指令 → 项目已确认偏好 → 用户全局偏好 →
 * 角色表达设定"。前两级不是记忆（安全规则在门禁里，当前指令就是本轮用户消息），
 * 所以这里只排后三级。区分靠 kind 基准分 + scope 调整分：同一条"日报别写午休"，
 * 落在项目范围必须压过落在用户全局的那条，否则用户在项目里做的更正会被全局旧偏好盖回去。
 */
const KIND_WEIGHT: Record<MemoryKind, number> = {
  project_fact: 400,
  user_preference: 300,
  task_breakpoint: 250,
  team_experience: 200,
  role_expression: 100,
  ephemeral_chat: 50,
}

const SCOPE_WEIGHT: Record<ScopeKind, number> = {
  project: 50,
  global: 30,
  team: 20,
  role: 10,
  session: 0,
}

export function memoryWeight(record: MemoryRecord): number {
  return KIND_WEIGHT[record.kind] + SCOPE_WEIGHT[record.scope.kind]
}

/**
 * 读取时刻的真实状态。
 *
 * 过期不靠后台任务改行——进程可能几天不重启，行里的 status 还是 confirmed，
 * 而它早就该失效了。所以每次读都按当前时间重算，status 列只作为可提前失效的标记。
 */
export function effectiveStatus(record: MemoryRecord, now: number): MemoryStatus {
  if (record.expiresAt !== null && record.expiresAt <= now) return 'expired'
  return record.status
}

/** 能进提示词的只有"已确认且未过期"。候选和冲突都只能展示给用户，不能当成事实喂给模型。 */
export function isInjectable(record: MemoryRecord, now: number): boolean {
  return effectiveStatus(record, now) === 'confirmed'
}

/** 当前上下文能看到哪些范围。global 永远可见；其余只在 id 对上时可见。 */
export function visibleScopes(context: MemoryContext): MemoryScope[] {
  const scopes: MemoryScope[] = [{ kind: 'global', id: '' }]
  if (context.projectId) scopes.push({ kind: 'project', id: context.projectId })
  if (context.teamId) scopes.push({ kind: 'team', id: context.teamId })
  if (context.roleId) scopes.push({ kind: 'role', id: context.roleId })
  if (context.sessionId) scopes.push({ kind: 'session', id: context.sessionId })
  return scopes
}

/** 主题归一化用于分类与同文去重，不用来推断规则互斥。 */
export function normalizeTopic(topic: string): string {
  return topic.trim().replace(/\s+/g, ' ').toLowerCase()
}

export interface MemoryInput {
  kind: string
  scopeKind: string
  scopeId?: string | null
  topic?: string | null
  text: string
  sourceRefs?: string[] | null
  sensitivity?: string | null
  expiresAt?: number | null
  /** 用户明确要替换的旧记忆 id；省略即追加兼容规则，不按主题推断矛盾。 */
  replaceIds?: string[]
  actor: MemoryActor
}

export type PutResult =
  | { ok: true; record: MemoryRecord; conflicts: MemoryRecord[]; superseded: MemoryRecord[] }
  | { ok: false; rejection: WriteRejection; message: string }

export interface DeletionOutcome {
  /** 真正从库里删掉的（含被传播掉的派生记忆）。 */
  deleted: MemoryRecord[]
  /** 来源减少或间接失效、本体仍保留但不再注入的记忆。 */
  weakened: MemoryRecord[]
  /** 历史冲突解除的剩余项；有确认记录才恢复 confirmed，否则退回 candidate。 */
  restored: MemoryRecord[]
  ledgerEntries: number
}

/** 库外的副本情况。调用方按自己知道的填，不知道的填 false——不要替用户猜"应该没有吧"。 */
export interface ExternalCopies {
  /** 旧 personal_assistant 存储域里还有同一条（迁移默认不删旧数据）。 */
  legacyDomain: boolean
  /** 采样 JSONL 原文还在磁盘上。 */
  sampleFiles: string[]
  /** 已经发布/导出出去的日报文件。 */
  exportedFiles: string[]
  /** 内容曾经发给过云端模型。 */
  sentToProvider: boolean
}

export interface DeletionReport {
  deleted: string[]
  invalidated: string[]
  retained: string[]
  uncontrolled: string[]
}

/**
 * 把删除结果翻译成必须给用户看的四类清单。design.md §9.4。
 *
 * 这一步存在的理由：只清理新库然后回一句"已经全部忘记"是假的。旧域副本、磁盘上的
 * JSONL、早就导出出去的 Markdown、发给过云端的正文，都不在这次删除的覆盖范围里。
 * 用户需要知道哪些还在，才知道要不要再点一次别的清理。
 */
export function deletionReport(outcome: DeletionOutcome, external: ExternalCopies): DeletionReport {
  const deleted = outcome.deleted.map(
    record => `${labelOf(record)}（${record.id}）已从记忆库删除`,
  )
  const invalidated = outcome.weakened.map(
    record => `${labelOf(record)}（${record.id}）仍在库里，但支撑它的来源减少或失效，已不再作为已确认事实注入`,
  )
  const retained = outcome.restored.map(record =>
    `${labelOf(record)}（${record.id}）仍保留，历史冲突已解除，${record.status === 'confirmed' ? '已恢复为已确认并参与注入' : '待用户确认，暂不注入'}`,
  )
  if (external.legacyDomain) {
    retained.push('旧 personal_assistant 存储域里的同一条偏好仍在（迁移默认只读导入、不删旧数据）')
  }
  for (const file of external.sampleFiles) retained.push(`采样原文仍在：${file}`)
  for (const file of external.exportedFiles) retained.push(`已导出的日报文件仍在：${file}`)
  const uncontrolled: string[] = []
  if (external.sentToProvider) {
    uncontrolled.push('这段内容曾经发给过云端模型，本地删除追不回供应商侧的副本，只能按供应商接口另行申请')
  }
  uncontrolled.push('任何已经被复制到本应用之外的内容（截图、手动粘贴、外部备份）无法追回')
  return { deleted, invalidated, retained, uncontrolled }
}

function labelOf(record: MemoryRecord): string {
  const topic = record.topic ? `「${record.topic}」` : ''
  return `${record.kind}${topic}`
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

let idCounter = 0
/** 进程内单调 id。前缀带上 kind 便于日志里一眼看出是什么。 */
export function makeMemoryId(prefix: string, now: number): string {
  idCounter += 1
  return `${prefix}-${now.toString(36)}-${idCounter.toString(36)}`
}

export class MemoryStore {
  private readonly db: DatabaseSync

  // 不用构造函数参数属性（`constructor(private readonly db: ...)`）：Node 的 strip-only
  // TypeScript 模式不支持那个语法，用了这里的代码就没法被 node --test 直接导入。
  constructor(db: DatabaseSync) {
    this.db = db
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        memory_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL DEFAULT '',
        topic TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        sensitivity TEXT NOT NULL DEFAULT 'normal',
        created_by TEXT NOT NULL,
        confirmed_by TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        import_batch TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_sources (
        source_id TEXT NOT NULL,
        derived_id TEXT NOT NULL,
        PRIMARY KEY (source_id, derived_id)
      );

      CREATE TABLE IF NOT EXISTS deletion_ledger (
        dedup_key TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        reason TEXT NOT NULL,
        deleted_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_visible ON memories (scope_kind, scope_id, status);
      CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories (kind, scope_kind, scope_id, topic);
      CREATE INDEX IF NOT EXISTS idx_memory_sources_derived ON memory_sources (derived_id);
    `)
  }

  close(): void {
    this.db.close()
  }

  /**
   * 写入一条记忆。
   *
   * 助理（含专家）只能落 candidate；只有 actor.isUser 为真时才可能直接 confirmed。
   * 这不是风格问题：design.md §2.6 明确"专家只能提交候选事实"，模型说自己确认过
   * 不算确认，正如模型说"用户已同意"不算审批（§10.2）。
   *
   * sensitive 一律拒写。加密存储（数据密钥 + DPAPI + 密钥恢复提示）还没落地，
   * 与其把敏感正文以明文写进 SQLite 再声称受保护，不如现在就不收。
   */
  put(input: MemoryInput, now: number): PutResult {
    const rejection = validateMemoryInput(input)
      ?? ((input.sensitivity ?? 'normal') === 'sensitive' ? 'sensitive_without_encryption' : null)
    if (rejection) {
      return { ok: false, rejection, message: WRITE_REJECTION_MESSAGES[rejection] }
    }

    const kind = input.kind as MemoryKind
    const scope: MemoryScope = {
      kind: input.scopeKind as ScopeKind,
      id: input.scopeKind === 'global' ? '' : String(input.scopeId ?? '').trim(),
    }
    const topic = normalizeTopic(input.topic ?? '')
    const text = input.text.trim()
    const sensitivity = (input.sensitivity ?? 'normal') as Sensitivity
    const sourceRefs = [...new Set((input.sourceRefs ?? []).filter(item => typeof item === 'string' && item.trim()))]
    const status: MemoryStatus = input.actor.isUser ? 'confirmed' : 'candidate'

    return inTransaction(this.db, () => {
      // 同主题只是分类，不是互斥声明；只有用户明确给出的 id 才能被替换。
      const replaceIds = input.replaceIds ?? []
      if (replaceIds.length > 0 && !input.actor.isUser) {
        return { ok: false, rejection: 'replacement_requires_user', message: WRITE_REJECTION_MESSAGES.replacement_requires_user }
      }
      const superseded = this.replacementTargets(replaceIds, kind, scope, now)
      if (!superseded) {
        return { ok: false, rejection: 'invalid_replacement', message: WRITE_REJECTION_MESSAGES.invalid_replacement }
      }
      // 空主题也只按同文去重，不把无关的旧偏好视作冲突。
      const duplicate = this.findByTopic(kind, scope, topic).find(record =>
        effectiveStatus(record, now) !== 'expired'
        && !replaceIds.includes(record.id)
        && normalizeTopic(record.text) === normalizeTopic(text),
      )
      if (duplicate && replaceIds.length === 0) {
        return { ok: true, record: duplicate, conflicts: [], superseded: [] }
      }

      const id = duplicate?.id ?? makeMemoryId(kind.slice(0, 4), now)
      if (duplicate) {
        this.setStatus(id, 'confirmed', now, input.actor.id)
      } else {
        this.write(id, {
          kind,
          scope,
          topic,
          text,
          sourceRefs,
          status,
          sensitivity,
          createdBy: input.actor.id,
          confirmedBy: status === 'confirmed' ? input.actor.id : null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          expiresAt: input.expiresAt ?? null,
          importBatch: null,
        })
      }
      // 明确替换保留旧行供追溯；没有点名的兼容规则和历史冲突均不受影响。
      for (const record of superseded) this.setStatus(record.id, 'expired', now, null)
      const stored = this.get(id, now)
      if (!stored) throw new Error(`记忆 ${id} 在写入事务中消失`)
      return {
        ok: true,
        record: stored,
        conflicts: [],
        superseded: superseded.map(record => this.get(record.id, now)!),
      }
    })
  }

  private write(id: string, record: Omit<MemoryRecord, 'id'>): void {
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO memories (memory_id, kind, scope_kind, scope_id, topic, body, status, sensitivity,
             created_by, confirmed_by, revision, created_at, updated_at, expires_at, import_batch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          record.kind,
          record.scope.kind,
          record.scope.id,
          record.topic,
          record.text,
          record.status,
          record.sensitivity,
          record.createdBy,
          text(record.confirmedBy),
          record.revision,
          record.createdAt,
          record.updatedAt,
          record.expiresAt,
          text(record.importBatch),
        )
      for (const sourceId of record.sourceRefs) {
        this.db
          .prepare('INSERT OR IGNORE INTO memory_sources (source_id, derived_id) VALUES (?, ?)')
          .run(sourceId, id)
      }
    })
  }

  /** 迁移与恢复入口：主键保证幂等，删除账本阻止同内容换 id 或跨批次复活。 */
  importRecord(record: MemoryRecord): boolean {
    return inTransaction(this.db, () => {
      const exists = this.db.prepare('SELECT 1 FROM memories WHERE memory_id = ?').get(record.id)
      if (exists || this.filterRestored([record]).blocked.length > 0) return false
      this.write(record.id, record)
      return true
    })
  }

  get(id: string, now: number): MemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE memory_id = ?').get(id) as Row | undefined
    if (!row) return null
    const record = rowToMemory(row, this.sourcesOf(id))
    return { ...record, status: effectiveStatus(record, now) }
  }

  private sourcesOf(id: string): string[] {
    const rows = this.db
      .prepare('SELECT source_id FROM memory_sources WHERE derived_id = ? ORDER BY source_id')
      .all(id) as Row[]
    return rows.map(row => String(row.source_id))
  }

  findByTopic(kind: MemoryKind, scope: MemoryScope, topic: string): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE kind = ? AND scope_kind = ? AND scope_id = ? AND topic = ?
         ORDER BY created_at`,
      )
      .all(kind, scope.kind, scope.id, topic) as Row[]
    return rows.map(row => rowToMemory(row, this.sourcesOf(String(row.memory_id))))
  }

  /** 当前上下文能看到的记忆，按权重降序。已过期的会被折算成 expired 状态返回。 */
  list(context: MemoryContext, now: number): MemoryRecord[] {
    const scopes = visibleScopes(context)
    const clause = scopes.map(() => '(scope_kind = ? AND scope_id = ?)').join(' OR ')
    const params = scopes.flatMap(scope => [scope.kind, scope.id])
    const rows = this.db.prepare(`SELECT * FROM memories WHERE ${clause} ORDER BY created_at`).all(...params) as Row[]
    return rows
      .map(row => rowToMemory(row, this.sourcesOf(String(row.memory_id))))
      .map(record => ({ ...record, status: effectiveStatus(record, now) }))
      .sort((a, b) => memoryWeight(b) - memoryWeight(a) || b.updatedAt - a.updatedAt)
  }

  /** 只有已确认的才进提示词。候选和冲突留给界面展示，不喂给模型当事实。 */
  injectable(context: MemoryContext, now: number): MemoryRecord[] {
    return this.list(context, now).filter(record => record.status === 'confirmed')
  }

  /**
   * 用户确认候选或选择历史冲突中的一条；只失效 replaceIds 点名的旧记忆。
   * 省略 replaceIds 时其余同主题规则不变，可逐条确认多条兼容的历史冲突。
   * 非用户、已过期的选择或无效替换目标返回 null，且整次不写入。
   */
  confirm(id: string, actor: MemoryActor, now: number, replaceIds: string[] = []): MemoryRecord | null {
    if (!actor.isUser) return null
    return inTransaction(this.db, () => {
      const current = this.get(id, now)
      if (!current || current.status === 'expired' || replaceIds.includes(id)) return null
      const superseded = this.replacementTargets(replaceIds, current.kind, current.scope, now)
      if (!superseded) return null
      this.setStatus(id, 'confirmed', now, actor.id)
      for (const record of superseded) this.setStatus(record.id, 'expired', now, null)
      return this.get(id, now)
    })
  }

  /** 只校验身份已明确指定的目标，不根据文本或主题猜测替换关系。 */
  private replacementTargets(ids: string[], kind: MemoryKind, scope: MemoryScope, now: number): MemoryRecord[] | null {
    const records: MemoryRecord[] = []
    for (const id of new Set(ids)) {
      const record = this.get(id, now)
      if (!record || record.status === 'expired' || record.kind !== kind
        || record.scope.kind !== scope.kind || record.scope.id !== scope.id) return null
      records.push(record)
    }
    return records
  }

  private setStatus(id: string, status: MemoryStatus, now: number, confirmedBy: string | null): void {
    this.db
      .prepare(
        `UPDATE memories SET status = ?, revision = revision + 1, updated_at = ?,
           confirmed_by = COALESCE(?, confirmed_by)
         WHERE memory_id = ?`,
      )
      .run(status, now, text(confirmedBy), id)
  }

  /**
   * 删除一条记忆，并沿来源引用传播。
   *
   * 全部来源消失的派生记忆一起删除；仍有来源的保留，但它及下游结论都退回候选，
   * 不能把来源变少前的确认继续当成有效确认。已过期的记忆不会重新激活。
   * 历史冲突只剩一项时，有确认记录才恢复已确认，否则仍需用户确认。
   */
  delete(id: string, reason: string, now: number): DeletionOutcome {
    return inTransaction(this.db, () => {
      const deleted: MemoryRecord[] = []
      const weakened: MemoryRecord[] = []
      const restored: MemoryRecord[] = []
      const target = this.get(id, now)
      if (!target) return { deleted, weakened, restored, ledgerEntries: 0 }

      const ledgerBefore = this.ledgerSize()
      const remaining = new Set(this.dependentsOf(id))
      this.removeRow(target, reason, now)
      deleted.push(target)

      // ponytail: 小规模记忆图反复扫描至稳定，最坏 O(n²)；规模增大再换入度队列。
      // 不能只遍历一次：多路径引用中，后处理的父项可能删掉先处理子项的最后一个来源。
      let changed: boolean
      do {
        changed = false
        for (const derivedId of remaining) {
          const record = this.get(derivedId, now)
          if (!record) {
            remaining.delete(derivedId)
          } else if (record.sourceRefs.length === 0) {
            this.removeRow(record, `来源记忆 ${id} 被删除`, now)
            deleted.push(record)
            remaining.delete(derivedId)
            changed = true
          }
        }
      } while (changed)

      for (const derivedId of remaining) {
        const record = this.get(derivedId, now)!
        this.setStatus(derivedId, record.status === 'expired' ? 'expired' : 'candidate', now, null)
        weakened.push(this.get(derivedId, now)!)
      }

      for (const record of deleted) {
        if (!record.topic) continue
        // 仅检查旧版本标记过的冲突；后来追加的同主题兼容规则不算冲突对手。
        const survivors = this.findByTopic(record.kind, record.scope, record.topic)
          .filter(item => effectiveStatus(item, now) === 'conflicting')
        if (survivors.length !== 1) continue
        const survivor = survivors[0]
        this.setStatus(survivor.id, survivor.confirmedBy ? 'confirmed' : 'candidate', now, null)
        restored.push(this.get(survivor.id, now)!)
      }
      return { deleted, weakened, restored, ledgerEntries: this.ledgerSize() - ledgerBefore }
    })
  }

  /** 传递闭包：id 的所有下游派生记忆，按发现顺序。自身不含在内。 */
  private dependentsOf(id: string): string[] {
    const seen = new Set<string>([id])
    const queue = [id]
    const order: string[] = []
    while (queue.length > 0) {
      const current = queue.shift()!
      const rows = this.db
        .prepare('SELECT derived_id FROM memory_sources WHERE source_id = ? ORDER BY derived_id')
        .all(current) as Row[]
      for (const row of rows) {
        const derivedId = String(row.derived_id)
        if (seen.has(derivedId)) continue
        seen.add(derivedId)
        order.push(derivedId)
        queue.push(derivedId)
      }
    }
    return order
  }

  private removeRow(record: MemoryRecord, reason: string, now: number): void {
    // 账本按内容摘要去重，不按 id：从备份恢复时同一条内容可能带着别的 id 回来，
    // 只认 id 就挡不住复活。
    this.db
      .prepare(
        `INSERT OR IGNORE INTO deletion_ledger
           (dedup_key, memory_id, kind, scope_kind, scope_id, topic, content_digest, reason, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ledgerKey(record),
        record.id,
        record.kind,
        record.scope.kind,
        record.scope.id,
        record.topic,
        sha256(record.text),
        reason,
        now,
      )
    // 两个方向的边都要删：只删"指向这条"的边，下游派生记忆在数剩余来源时还会把
    // 已经删掉的这条数进去，于是永远判定成"还有依据"，传播就断在第一层。
    // 级联闭包在 dependentsOf 里已经提前算完，这里删边不会丢路径。
    this.db.prepare('DELETE FROM memory_sources WHERE derived_id = ?').run(record.id)
    this.db.prepare('DELETE FROM memory_sources WHERE source_id = ?').run(record.id)
    this.db.prepare('DELETE FROM memories WHERE memory_id = ?').run(record.id)
  }

  /**
   * 备份恢复前过一遍删除账本。design.md §9.2：备份恢复时不能复活已删除记忆。
   *
   * 只在恢复路径上生效，正常写入不查账本——用户删掉一条之后又主动重新记一遍，
   * 那是新的明确意图，不该被几个月前的一次删除拦住。
   */
  filterRestored(records: MemoryRecord[]): { accepted: MemoryRecord[]; blocked: MemoryRecord[] } {
    const accepted: MemoryRecord[] = []
    const blocked: MemoryRecord[] = []
    const stmt = this.db.prepare('SELECT 1 FROM deletion_ledger WHERE dedup_key = ?')
    for (const record of records) {
      if (stmt.get(ledgerKey(record))) blocked.push(record)
      else accepted.push(record)
    }
    return { accepted, blocked }
  }

  ledgerSize(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM deletion_ledger').get() as Row
    return Number(row.n)
  }

  /**
   * 到期清理。临时对话直接删（它本来就只在当下有意义），其余标 expired 保留行，
   * 因为"已确认成果与偏好直到用户删除"——到期不等于用户想让它消失。
   */
  applyRetention(now: number): { deleted: number; expired: number } {
    const rows = this.db
      .prepare('SELECT * FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .all(now) as Row[]
    let deleted = 0
    let expired = 0
    for (const row of rows) {
      const record = rowToMemory(row, this.sourcesOf(String(row.memory_id)))
      if (record.status === 'expired') continue
      if (record.kind === 'ephemeral_chat') {
        this.removeRow(record, '临时对话到期', now)
        deleted += 1
      } else {
        this.setStatus(record.id, 'expired', now, null)
        expired += 1
      }
    }
    return { deleted, expired }
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as Row
    return Number(row.n)
  }
}

function ledgerKey(record: MemoryRecord): string {
  return [record.kind, record.scope.kind, record.scope.id, record.topic, sha256(record.text)].join('|')
}

function rowToMemory(row: Row, sourceRefs: string[]): MemoryRecord {
  return {
    id: String(row.memory_id),
    kind: String(row.kind) as MemoryKind,
    scope: { kind: String(row.scope_kind) as ScopeKind, id: String(row.scope_id ?? '') },
    topic: String(row.topic ?? ''),
    text: String(row.body),
    sourceRefs,
    status: String(row.status) as MemoryStatus,
    sensitivity: String(row.sensitivity ?? 'normal') as Sensitivity,
    createdBy: String(row.created_by),
    confirmedBy: text(row.confirmed_by),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
    importBatch: text(row.import_batch),
  }
}

// ---------------------------------------------------------------------------
// 提示词渲染
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<MemoryKind, string> = {
  user_preference: '用户偏好',
  project_fact: '项目事实',
  task_breakpoint: '待办断点',
  team_experience: '团队共同经历',
  role_expression: '角色表达',
  ephemeral_chat: '临时上下文',
}

export function kindLabel(kind: MemoryKind): string {
  return KIND_LABEL[kind] ?? kind
}

/**
 * 注入系统提示词的记忆段。
 *
 * 范围要写出来：一条项目范围的偏好被渲染成"始终遵守"，用户在别的项目里就会被它莫名管着。
 * 导入进来的记忆也标一下——它是从旧数据搬过来的，不是本系统观察到的，可信度不一样。
 */
export function renderMemorySection(records: MemoryRecord[], context: MemoryContext): string | undefined {
  if (records.length === 0) return undefined
  return records
    .map(record => {
      const marks: string[] = []
      if (record.scope.kind !== 'global') marks.push(scopeLabel(record.scope, context))
      if (record.importBatch) marks.push('导入')
      const suffix = marks.length > 0 ? `（${marks.join('，')}）` : ''
      return `- [${kindLabel(record.kind)}]${suffix} ${record.text}`
    })
    .join('\n')
}

export function scopeLabel(scope: MemoryScope, context: MemoryContext): string {
  switch (scope.kind) {
    case 'global':
      return '全局'
    case 'project':
      return scope.id === context.projectId ? '本项目' : `项目 ${scope.id}`
    case 'team':
      return `团队 ${scope.id}`
    case 'role':
      return `角色 ${scope.id}`
    case 'session':
      return '仅本次会话'
    default:
      return scope.kind
  }
}

/** 冲突清单：界面上要拿这个让用户挑一条，不能自己替用户决定。 */
export function describeConflict(record: MemoryRecord, rivals: MemoryRecord[]): string {
  const others = rivals.map(rival => `「${rival.text}」（${rival.id}）`).join('；')
  return `关于${record.topic || '同一件事'}，已经记着${others}，和这条「${record.text}」对不上。请确认保留哪一条。`
}
