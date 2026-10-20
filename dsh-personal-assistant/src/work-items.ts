/**
 * 工作事项与证据关联（M3-01）。
 *
 * 旧的语义事项（domain.ts 的 SemanticEvent）只有一句 summary 和一串窗口标题字符串，
 * 说不清"这条结论靠什么撑着"，删掉活动原文之后也没法知道哪条结论失去了依据。
 * 这里把事项拆成 项目 / 时间范围 / 动作 / 成果 / 来源引用 / 状态，来源逐条入表：
 *
 * - 来源必须能在本地查到（观察库、当天笔记、已登记的项目证据读取），查不到整批拒绝；
 * - 证据类型由系统按实际查到的来源判定，不采信模型自报；
 * - 模型只能声明 direct 或 inferred，direct 还要求至少一条直接证据；
 * - user_confirmed 只能由可信审批闭包调用 {@link WorkItemStore.confirm} 设置；
 * - 来源被删时沿引用传播，失去全部来源的事项落 evidence_removed。
 *
 * 纯决策（{@link planWorkItem}）不碰 SQLite，便于直接测试。
 */
import type { DatabaseSync } from 'node:sqlite'
import { dryRun, inTransaction, sha256, text, type Row } from './store.ts'
import type { MemoryActor } from './memory.ts'
import type { ProjectEvidence } from './help-context.ts'

export const WORK_ITEM_STATUSES = ['direct', 'user_confirmed', 'inferred', 'evidence_removed'] as const
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number]

/** 模型提交时允许声明的状态；其余两种只能由可信审批或删除传播产生。 */
export const CLAIMABLE_STATUSES = ['direct', 'inferred'] as const
export type ClaimableStatus = (typeof CLAIMABLE_STATUSES)[number]

export const WORK_ITEM_SOURCE_KINDS = [
  /** 观察库里的观察（活动片段等），ref = observation_id。 */
  'activity_observation',
  /** 用户随手记（import_records 的 manual 来源），ref = noteId。 */
  'user_note',
  /** 用户导入的原文（聊天导出、粘贴的测试输出等），ref = noteId。 */
  'import_material',
  /** 已授权项目的只读证据读取，ref = read_project_evidence 返回的 evidenceId。 */
  'project_evidence',
  /**
   * 用户确认过的会议纪要，ref = `POST /evidence/intake` 返回的 materialId。
   *
   * 它是**用户亲手确认过**的原文，与导入原文同性质，可支撑 direct；也是"会上讨论了什么"
   * 的正当来源。但它只代表纪要记下来的内容，不代表会上说过的每一句话。
   */
  'meeting_minutes',
  /**
   * 用户主动记录的一次窗口文本，ref 同上。
   *
   * 窗口里显示过一段测试输出，不等于你跑了测试；显示了一封邮件，不等于你发出去了。
   * 所以它**不在直接证据里**，只能支撑 inferred。
   */
  'window_text',
] as const
export type WorkItemSourceKind = (typeof WORK_ITEM_SOURCE_KINDS)[number]

/**
 * 证据类型。由系统依据实际查到的来源判定。
 *
 * 直接证据只有：文件差异（项目证据里有工作区改动，或经授权读取的仓库差异原文）、导入原文
 * （含用户粘贴的真实测试输出——本插件的项目证据读取不运行测试，测试输出只能以导入原文的形式进来）、
 * 聊天片段原文（只证明片段里说过的话）。
 * 窗口标题和进程停留只证明"用过"，不证明"做成"，只能支撑 inferred；项目文件正文只说明文件现在长什么样，
 * 不说明谁改过它，同样只能支撑 inferred。
 *
 * 两个收件来源（见 `evidence-intake.ts`）的定级刻意不同：
 * - 会议纪要是**用户确认过的原文** → 与导入原文同级，可支撑 direct；
 * - 窗口文本是"当时屏幕上有什么" → 与窗口标题同级，只能支撑 inferred。
 *   这个区别不是保守，是准确的：屏幕上有测试输出 ≠ 你跑了测试。
 */
export type EvidenceType = 'window_title' | 'process_dwell' | 'legacy_event' | 'user_note' | 'import_text' | 'chat_text'
  | 'file_content' | 'file_diff' | 'project_snapshot'
  | 'meeting_minutes' | 'window_text'
/**
 * 只有这些证据类型能支撑 `direct`。
 *
 * `meeting_minutes` 在这里**是**例外里的一条，理由：它是用户亲手确认过的原文，
 * 与"导入原文"同性质。单独给它一个类型（而不是复用 `import_text`）是为了让日报里
 * 能如实写出"证据：产品评审会纪要"，而不是笼统一句"导入文本"。
 *
 * `window_text` **刻意不在这里**：屏幕上有测试输出不等于你跑了测试。
 */
export const DIRECT_EVIDENCE_TYPES: ReadonlySet<EvidenceType> = new Set<EvidenceType>([
  'file_diff', 'import_text', 'chat_text', 'meeting_minutes',
])

/**
 * 只有活动线索（窗口标题、进程停留）时不得出现的说法：没有聊天或会议内容，就说不出讨论了什么。
 * 这是兜底的文本检查；结构化的"讨论主题"字段另有更严的要求（必须引用聊天片段）。
 */
const DISCUSSION_CLAIM = /讨论|沟通|商量|商讨|聊了|聊到|谈了|谈到|约定了|达成一致/

export interface WorkItemSource {
  kind: WorkItemSourceKind
  ref: string
  evidenceType: EvidenceType
  /** 项目证据：授权范围的实际路径；其余为 null。 */
  projectDir: string | null
  /** 项目证据：读取时间；其余为 null。 */
  readAt: number | null
  /** 项目证据：读取结果的摘要；其余为 null。 */
  digest: string | null
  /** 给人看的一句话证据说明。 */
  summary: string
}

export interface WorkItem {
  id: string
  /** 项目：项目证据的实际路径，或用户/模型给的项目名；无项目为 null。 */
  project: string | null
  start: number
  end: number
  /** 动作：做了什么（如"修改日报审批逻辑"）。 */
  action: string
  /** 成果：产出了什么（如"测试全部通过"）；没有可证实成果时为空串。 */
  outcome: string
  summary: string
  /** 讨论主题：只有引用了聊天片段原文才允许有；其余为 null。 */
  discussionTopic: string | null
  status: WorkItemStatus
  /** 模型提交时声明的状态，审计用。 */
  declaredStatus: ClaimableStatus
  confirmedBy: string | null
  revision: number
  createdAt: number
  updatedAt: number
  removedReason: string | null
  sources: WorkItemSource[]
}

export interface WorkItemInput {
  start: number
  end: number
  summary: string
  project?: string | null
  action?: string | null
  outcome?: string | null
  /** 讨论主题；必须引用至少一条聊天片段资料。 */
  discussionTopic?: string | null
  status: string
  sources?: { kind: string; ref: string }[] | null
}

/**
 * 解析一条来源引用：查到返回来源，查不到返回拒绝原因。
 * materialKind 只在解析资料时给出，用来判定讨论主题有没有聊天原文撑着；不落库。
 */
export type SourceResolver = (kind: WorkItemSourceKind, ref: string) =>
  (Omit<WorkItemSource, 'kind' | 'ref'> & { materialKind?: string | null }) | string

export type PlannedWorkItem = Omit<WorkItem, 'id' | 'confirmedBy' | 'revision' | 'createdAt' | 'updatedAt' | 'removedReason'>

const SOURCE_KIND_SET = new Set<string>(WORK_ITEM_SOURCE_KINDS)

/** 校验一条模型提交的事项并解析来源；任何一处不成立都拒绝，不做降级猜测。 */
export function planWorkItem(input: WorkItemInput, resolve: SourceResolver): { ok: true; item: PlannedWorkItem } | { ok: false; message: string } {
  const start = Number(input.start), end = Number(input.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return { ok: false, message: '时间范围无效：结束不能早于开始' }
  const summary = String(input.summary ?? '').trim()
  if (!summary) return { ok: false, message: '事项概括不能为空' }
  if (input.status === 'user_confirmed') return { ok: false, message: 'user_confirmed 只能由用户在桌面可信审批窗口批准后设置，模型不能自行声明' }
  if (input.status === 'evidence_removed') return { ok: false, message: 'evidence_removed 只由来源删除传播产生，不能提交' }
  if (input.status !== 'direct' && input.status !== 'inferred') return { ok: false, message: '状态只能声明 direct 或 inferred' }
  const refs = input.sources ?? []
  if (!Array.isArray(refs) || refs.length === 0) return { ok: false, message: '事项必须至少引用一条可在本地查到的来源' }
  const sources: WorkItemSource[] = []
  const materialKinds: string[] = []
  const seen = new Set<string>()
  for (const raw of refs) {
    const kind = String(raw?.kind ?? ''), ref = String(raw?.ref ?? '').trim()
    if (!SOURCE_KIND_SET.has(kind)) return { ok: false, message: `来源类型不认识：${kind}` }
    if (!ref) return { ok: false, message: '来源引用不能为空' }
    const key = `${kind}|${ref}`
    if (seen.has(key)) continue
    seen.add(key)
    const resolved = resolve(kind as WorkItemSourceKind, ref)
    if (typeof resolved === 'string') return { ok: false, message: `来源 ${kind}:${ref} 无法在本地查到：${resolved}` }
    const { materialKind, ...source } = resolved
    if (materialKind) materialKinds.push(materialKind)
    sources.push({ kind: kind as WorkItemSourceKind, ref, ...source })
  }
  if (input.status === 'direct' && !sources.some(source => DIRECT_EVIDENCE_TYPES.has(source.evidenceType))) {
    return { ok: false, message: '只有文件差异、导入原文、聊天片段原文这类直接证据才能声明 direct；仅凭窗口标题、进程停留、项目文件现状或随手记只能声明 inferred' }
  }
  const discussionTopic = String(input.discussionTopic ?? '').trim() || null
  // 讨论主题必须来自"人说过什么"的原文：聊天片段，或用户确认过的会议纪要。
  // 窗口标题、进程停留、窗口里的正文都不行 —— 那些只说明屏幕上有什么。
  const hasDiscussionSource = materialKinds.includes('chat_excerpt') || materialKinds.includes('meeting_minutes')
  if (discussionTopic && !hasDiscussionSource) {
    return { ok: false, message: '没有引用聊天片段或会议纪要原文，不能生成讨论主题：聊天窗口标题、进程停留或窗口里的文字只说明看到过什么，说明不了聊了什么。请改用用户导入的聊天片段、已确认的会议纪要，或去掉讨论主题' }
  }
  const action = String(input.action ?? '').trim()
  const outcome = String(input.outcome ?? '').trim()
  // 只有"被动观察"类来源时禁止写"讨论了…"。
  // 窗口文本也算被动观察：屏幕上有段对话，说明不了你参与了它。
  const onlyPassive = sources.every(source => source.kind === 'activity_observation' || source.kind === 'window_text')
  if (onlyPassive && DISCUSSION_CLAIM.test(`${summary}\n${action}\n${outcome}`)) {
    return { ok: false, message: '只有活动线索（窗口标题、进程停留、窗口里显示的文字），没有任何聊天或会议内容，不能写"讨论/沟通了什么"。请只描述可见的活动，或请用户导入相关聊天片段、确认会议纪要' }
  }
  const projectDirs = [...new Set(sources.map(source => source.projectDir).filter((dir): dir is string => !!dir))]
  if (projectDirs.length > 1) return { ok: false, message: '一条事项不能同时引用多个项目的证据，请拆开提交' }
  const declaredProject = String(input.project ?? '').trim() || null
  if (projectDirs.length === 1 && declaredProject && declaredProject !== projectDirs[0]) {
    return { ok: false, message: `事项项目与引用的项目证据不一致（证据来自 ${projectDirs[0]}）` }
  }
  return {
    ok: true,
    item: {
      project: projectDirs[0] ?? declaredProject,
      start, end, summary, action, outcome, discussionTopic,
      status: input.status, declaredStatus: input.status, sources,
    },
  }
}

export interface ProjectEvidenceRead {
  evidenceId: string
  projectDir: string
  readAt: number
  digest: string
  summary: string
  hasDiff: boolean
}

export interface SourceRemovalOutcome {
  /** 删掉的来源引用条数。 */
  refsRemoved: number
  /** 失去全部来源、已标为 evidence_removed 的事项。 */
  evidenceRemoved: WorkItem[]
  /** 仍有来源但失去全部直接证据、从 direct 退回 inferred 的事项。 */
  downgraded: WorkItem[]
}

let idCounter = 0
function makeId(prefix: string, now: number): string {
  idCounter += 1
  return `${prefix}-${now.toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 项目证据的一句话摘要：只留计数与分支，不复制文件名或提交信息正文。 */
export function summarizeProjectEvidence(evidence: ProjectEvidence): string {
  if (!evidence.git) return `非 Git 或文件级授权：顶层条目 ${evidence.entries.length} 个`
  return `分支 ${evidence.branch ?? '未知'}；变更文件 ${evidence.changedFiles.length} 个；差异统计 ${evidence.diffStat.length} 行；最近提交 ${evidence.recentCommits.length} 条`
}

export class WorkItemStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    // 新表只用 IF NOT EXISTS 追加，不提高库版本：旧插件遇到更高版本会拒绝启动。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        item_id TEXT PRIMARY KEY,
        project TEXT,
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL,
        action TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        declared_status TEXT NOT NULL,
        confirmed_by TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        removed_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS work_item_sources (
        item_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        project_dir TEXT,
        read_at INTEGER,
        digest TEXT,
        summary TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (item_id, source_kind, source_ref)
      );

      CREATE TABLE IF NOT EXISTS project_evidence_reads (
        evidence_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        read_at INTEGER NOT NULL,
        digest TEXT NOT NULL,
        summary TEXT NOT NULL,
        has_diff INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_work_items_range ON work_items (start_at);
      CREATE INDEX IF NOT EXISTS idx_work_item_sources_ref ON work_item_sources (source_kind, source_ref);
    `)
    // 追加列同样不提版本：先查列，缺了才加，旧库与新库都只走一次。
    const columns = (this.db.prepare('PRAGMA table_info(work_items)').all() as Row[]).map(row => String(row.name))
    if (!columns.includes('discussion_topic')) this.db.exec('ALTER TABLE work_items ADD COLUMN discussion_topic TEXT')
  }

  /** 登记一次已授权项目的证据读取，返回可被事项引用的 evidenceId。 */
  recordProjectEvidence(evidence: ProjectEvidence, now: number): ProjectEvidenceRead {
    const record: ProjectEvidenceRead = {
      evidenceId: makeId('pev', now),
      projectDir: evidence.projectDir,
      readAt: now,
      digest: sha256(JSON.stringify(evidence)),
      summary: summarizeProjectEvidence(evidence),
      hasDiff: evidence.git && (evidence.diffStat.length > 0 || evidence.changedFiles.length > 0),
    }
    this.db.prepare(`INSERT INTO project_evidence_reads (evidence_id, project_dir, read_at, digest, summary, has_diff)
      VALUES (?, ?, ?, ?, ?, ?)`).run(record.evidenceId, record.projectDir, record.readAt, record.digest, record.summary, record.hasDiff ? 1 : 0)
    return record
  }

  projectEvidence(evidenceId: string): ProjectEvidenceRead | null {
    const row = this.db.prepare('SELECT * FROM project_evidence_reads WHERE evidence_id = ?').get(evidenceId) as Row | undefined
    if (!row) return null
    return {
      evidenceId: String(row.evidence_id), projectDir: String(row.project_dir), readAt: Number(row.read_at),
      digest: String(row.digest), summary: String(row.summary), hasDiff: Number(row.has_diff) === 1,
    }
  }

  /** 一批事项在一个事务里写入；调用方须先用 {@link planWorkItem} 全部校验通过。 */
  commit(items: readonly PlannedWorkItem[], now: number): WorkItem[] {
    return inTransaction(this.db, () => items.map(item => {
      const id = makeId('work', now)
      this.db.prepare(`INSERT INTO work_items (item_id, project, start_at, end_at, action, outcome, summary, discussion_topic, status,
          declared_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, text(item.project), item.start, item.end, item.action, item.outcome, item.summary, text(item.discussionTopic),
          item.status, item.declaredStatus, now, now)
      for (const source of item.sources) {
        this.db.prepare(`INSERT OR IGNORE INTO work_item_sources (item_id, source_kind, source_ref, evidence_type, project_dir, read_at, digest, summary)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, source.kind, source.ref, source.evidenceType, text(source.projectDir), source.readAt, text(source.digest), source.summary)
      }
      return this.get(id)!
    }))
  }

  get(id: string): WorkItem | null {
    const row = this.db.prepare('SELECT * FROM work_items WHERE item_id = ?').get(id) as Row | undefined
    return row ? this.toItem(row) : null
  }

  /** 开始时间落在 [from, to) 的事项，按开始时间升序。 */
  listInRange(from: number, to: number): WorkItem[] {
    const rows = this.db.prepare('SELECT * FROM work_items WHERE start_at >= ? AND start_at < ? ORDER BY start_at, item_id').all(from, to) as Row[]
    return rows.map(row => this.toItem(row))
  }

  /** 引用了任一给定来源的事项；删除影响快照用。 */
  referencing(kind: WorkItemSourceKind, refs: readonly string[]): WorkItem[] {
    const ids = new Set<string>()
    const stmt = this.db.prepare('SELECT item_id FROM work_item_sources WHERE source_kind = ? AND source_ref = ?')
    for (const ref of refs) for (const row of stmt.all(kind, ref) as Row[]) ids.add(String(row.item_id))
    return [...ids].sort().map(id => this.get(id)!)
  }

  /**
   * 可信审批闭包内调用：把事项标为用户已确认。
   * 非用户身份、事项不存在或证据已删除时返回 null 且不写入。
   */
  confirm(id: string, actor: MemoryActor, now: number): WorkItem | null {
    if (!actor.isUser) return null
    return inTransaction(this.db, () => {
      const current = this.get(id)
      if (!current || current.status === 'evidence_removed') return null
      this.db.prepare(`UPDATE work_items SET status = 'user_confirmed', confirmed_by = ?, revision = revision + 1, updated_at = ?
        WHERE item_id = ?`).run(actor.id, now, id)
      return this.get(id)
    })
  }

  /**
   * 删除指定来源引用并沿事项传播。
   * 失去全部来源 → evidence_removed（含曾经用户确认过的：确认针对的依据已不存在）；
   * 仍有来源但没有直接证据的 direct → inferred；user_confirmed 只要还有来源就保留。
   */
  removeSources(kind: WorkItemSourceKind, refs: readonly string[], reason: string, now: number): SourceRemovalOutcome {
    return inTransaction(this.db, () => {
      const affected = this.referencing(kind, refs)
      let refsRemoved = 0
      const stmt = this.db.prepare('DELETE FROM work_item_sources WHERE source_kind = ? AND source_ref = ?')
      for (const ref of refs) refsRemoved += Number(stmt.run(kind, ref).changes)
      const evidenceRemoved: WorkItem[] = []
      const downgraded: WorkItem[] = []
      for (const before of affected) {
        const item = this.get(before.id)!
        if (item.sources.length === 0) {
          if (item.status !== 'evidence_removed') {
            this.db.prepare(`UPDATE work_items SET status = 'evidence_removed', removed_reason = ?, revision = revision + 1, updated_at = ?
              WHERE item_id = ?`).run(reason, now, item.id)
          }
          evidenceRemoved.push(this.get(item.id)!)
        } else if (item.status === 'direct' && !item.sources.some(source => DIRECT_EVIDENCE_TYPES.has(source.evidenceType))) {
          this.db.prepare(`UPDATE work_items SET status = 'inferred', revision = revision + 1, updated_at = ? WHERE item_id = ?`).run(now, item.id)
          downgraded.push(this.get(item.id)!)
        }
      }
      return { refsRemoved, evidenceRemoved, downgraded }
    })
  }

  /** 删除影响预览：真实跑一遍来源删除再整体回滚，返回"将会"失效与降级的事项。 */
  previewRemoveSources(kind: WorkItemSourceKind, refs: readonly string[], now: number): SourceRemovalOutcome {
    return dryRun(this.db, () => this.removeSources(kind, refs, '预览', now))
  }

  private toItem(row: Row): WorkItem {
    const id = String(row.item_id)
    const sources = (this.db.prepare('SELECT * FROM work_item_sources WHERE item_id = ? ORDER BY source_kind, source_ref').all(id) as Row[])
      .map(source => ({
        kind: String(source.source_kind) as WorkItemSourceKind,
        ref: String(source.source_ref),
        evidenceType: String(source.evidence_type) as EvidenceType,
        projectDir: text(source.project_dir),
        readAt: source.read_at === null || source.read_at === undefined ? null : Number(source.read_at),
        digest: text(source.digest),
        summary: String(source.summary ?? ''),
      }))
    return {
      id,
      project: text(row.project),
      start: Number(row.start_at),
      end: Number(row.end_at),
      action: String(row.action ?? ''),
      outcome: String(row.outcome ?? ''),
      summary: String(row.summary),
      discussionTopic: text(row.discussion_topic),
      status: String(row.status) as WorkItemStatus,
      declaredStatus: String(row.declared_status) as ClaimableStatus,
      confirmedBy: text(row.confirmed_by),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      removedReason: text(row.removed_reason),
      sources,
    }
  }
}
