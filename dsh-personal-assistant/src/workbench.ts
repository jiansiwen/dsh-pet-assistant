/**
 * 日报工作台（M3-04）与历史、删除管理（M3-05）的插件侧服务：给桌面工作台窗口提供数据与操作。
 *
 * 显示与批准分开，这是本服务的第一条规矩：
 * - 工作台渲染的是模型写的文字，所以它只能读视图、提交逐条修订（每次产生新版本）、请求发布、请求删除；
 * - "请求发布"只核对用户看到的版本号、摘要与保存路径是否就是库里的当前版本，然后提交日报可信审批，
 *   返回 proposalId；桌面主进程据此打开专用审批窗口，批准只在那里签发；
 * - 删除同理：除草稿条目（生成新版本、旧版本留在历史里的可回看修订）外，一律只生成助理可信审批提案。
 * 本服务没有任何"批准"入口，也不接受渲染层指定的发布路径或正文。
 *
 * 路由挂在桥接的 /workbench/ 下，复用聊天令牌鉴权；未绑定会话时写操作由桥接统一拒绝。
 */
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AssistantProposal, AssistantSubmission } from './assistant-approval.ts'
import {
  DELETION_CATEGORIES,
  planActivityDeletion,
  planDraftEntryDeletion,
  planExportedFileDeletion,
  planMaterialDeletion,
  planMemoryDeletion,
  planReportRevocation,
  recordReceipt,
  type DeletionCategory,
  type DeletionDeps,
  type DeletionTracker,
} from './deletion.ts'
import { materialShareSubmission } from './evidence-import.ts'
import { HelpContextStore } from './help-context.ts'
import { scopeLabel, type MemoryStore } from './memory.ts'
import { MATERIAL_KIND_LABEL, MaterialStore, materialKindForSource, materialMeta, type Material, type MaterialKind } from './materials.ts'
import type { ObservationStore } from './observation.ts'
import {
  isPendingEntry,
  makeReportId,
  parseReportLines,
  REPORT_EVIDENCE_RULES,
  type ReportEdit,
  type ReportEditOp,
  type ReportStore,
} from './report.ts'
import { reportDecisions, type ReportProposal } from './report-approval.ts'
import type { ReportSubmission } from './bridge.ts'
import { formatLocalTime, sha256 } from './store.ts'
import { localDateOf, startOfLocalDate } from './time.ts'
import { WorkItemStore, type EvidenceType, type WorkItem, type WorkItemSource, type WorkItemStatus } from './work-items.ts'

/** 桥接据此把 /workbench/* 交给本服务。 */
export interface WorkbenchHandler {
  handle(method: string, route: string, query: URLSearchParams, body: unknown): Promise<{ status: number; body: unknown }>
}

/** 工作台用到的审批提交能力（桥接提供）。只能提交，不能批准。 */
export interface WorkbenchApprovals {
  submitReport(reportId: string): Promise<ReportSubmission>
  submitAssistant(submission: AssistantSubmission): AssistantProposal
  pendingReportApprovals(): ReportProposal[]
  notifyApprovalSnapshot?(): void
}

/**
 * 工作台改写记忆时用的可信提案能力。
 *
 * 工作台和模型工具一样**不能自己签批**：它只能把"这一条改成什么"提交成待批卡片，
 * 由用户在专用审批窗口看到新旧全文后点头。所以这里要的是 submitAssistant 而不是直接写库。
 */
export interface WorkbenchMemoryWrites {
  /** 记忆写入方式：auto 时工作台直接改写并如实回报，不需要审批卡。 */
  approvalMode(): 'manual' | 'auto'
  /** 提交一条"改写记忆"的可信提案；返回提案编号。 */
  proposeMemoryEdit(input: {
    memoryId: string
    text: string
    topic?: string
    before: { text: string; topic: string }
    scopeLabel: string
  }): string
}

export interface WorkbenchTracker extends DeletionTracker {
  readonly active?: boolean
  readonly capturing?: boolean
}

export interface ReportWorkbenchDeps {
  db: DatabaseSync
  approvals: WorkbenchApprovals
  tracker: WorkbenchTracker
  reports: ReportStore
  memories: MemoryStore
  observations?: ObservationStore
  workItems?: WorkItemStore
  materials?: MaterialStore
  helpContexts?: Pick<HelpContextStore, 'list' | 'authorizedScope'>
  reportDir: string
  legacyCopiesRetained: boolean
  now?: () => number
  unlinkFile?: (file: string) => Promise<void>
  /**
   * 记忆改写入口；未装配时工作台只读（不提供编辑按钮的服务端实现）。
   * 与删除一样：写操作必须经可信审批，工作台自己签不了。
   */
  memoryWrites?: WorkbenchMemoryWrites
}

class InputError extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DIGEST = /^[a-f0-9]{64}$/
const MAX_TEXT = 2000
const DESKTOP_MATERIAL_KINDS: ReadonlySet<MaterialKind> = new Set<MaterialKind>(['chat_excerpt', 'import_text', 'note'])

export const WORK_ITEM_STATUS_LABEL: Record<WorkItemStatus, string> = {
  direct: '直接证据',
  user_confirmed: '你已确认',
  inferred: '推断（待确认）',
  evidence_removed: '证据已删除',
}

const EVIDENCE_LABEL: Record<EvidenceType, string> = {
  window_title: '窗口标题（只说明用过）',
  process_dwell: '进程停留（只说明用过）',
  legacy_event: '旧版事项',
  user_note: '你的随手记',
  import_text: '导入原文',
  chat_text: '聊天片段原文',
  file_content: '项目文件现状',
  file_diff: '文件差异',
  project_snapshot: '项目目录快照',
  meeting_minutes: '你确认过的会议纪要',
  window_text: '窗口记录（只说明当时看到）',
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('请求体必须是对象')
  return value as Record<string, unknown>
}

function dateOf(value: unknown): string {
  if (typeof value !== 'string' || !DATE.test(value)) throw new InputError('日期格式必须是 YYYY-MM-DD')
  return value
}

function integer(value: unknown, label: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) throw new InputError(`${label}必须是不小于 ${min} 的整数`)
  return value
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InputError(`${label}必须是数字`)
  return value
}

function optionalText(value: unknown, label: string, max = MAX_TEXT): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new InputError(`${label}必须是文字`)
  if (value.length > max) throw new InputError(`${label}太长`)
  return value
}

function parseOp(raw: unknown): ReportEditOp {
  const op = object(raw)
  if (op.type === 'rewrite') {
    return { type: 'rewrite', line: integer(op.line, '行号'), expectedText: String(op.expectedText ?? ''), text: String(op.text ?? '') }
  }
  if (op.type === 'delete') return { type: 'delete', line: integer(op.line, '行号'), expectedText: String(op.expectedText ?? '') }
  if (op.type === 'add') {
    const after = op.afterLine
    if (typeof after !== 'number' || !Number.isInteger(after) || after < -1) throw new InputError('补充位置必须是行号或 -1（文末）')
    return { type: 'add', afterLine: after, text: typeof op.text === 'string' ? op.text : '' }
  }
  throw new InputError('修改类型只能是 rewrite / delete / add')
}

function ok(body: Record<string, unknown>, status = 200) {
  return { status, body: { ok: true, ...body } }
}

function fail(status: number, code: string, error: string, extra: Record<string, unknown> = {}) {
  return { status, body: { ok: false, code, error, ...extra } }
}

function fileFacts(file: string): { exists: boolean; digest: string | null } {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile()) return { exists: true, digest: null }
    return { exists: true, digest: sha256(readFileSync(file, 'utf8')) }
  } catch {
    return { exists: false, digest: null }
  }
}

function describeEdit(edit: ReportEdit | undefined): string | null {
  if (!edit) return null
  if (edit.actor === 'assistant') return '助理整篇撰写'
  if (edit.op === 'rewrite') return `你改写了一条：「${edit.before ?? ''}」→「${edit.after ?? ''}」`
  if (edit.op === 'delete') return `你删除了一条：「${edit.before ?? ''}」`
  if (edit.op === 'add') return `你补充了一条：「${edit.after ?? ''}」`
  return null
}

export class ReportWorkbench implements WorkbenchHandler {
  private readonly deps: ReportWorkbenchDeps

  constructor(deps: ReportWorkbenchDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private deletionDeps(): DeletionDeps {
    const db = this.deps.db
    return {
      tracker: this.deps.tracker,
      reports: this.deps.reports,
      memories: this.deps.memories,
      observations: this.deps.observations,
      workItems: this.deps.workItems,
      materials: this.deps.materials,
      reportDir: this.deps.reportDir,
      legacyCopiesRetained: this.deps.legacyCopiesRetained,
      // 与记忆类可信提案同一口径：全范围记忆与来源边，任何变化都让待批失效。
      memorySnapshot: () => ({
        records: db.prepare('SELECT * FROM memories ORDER BY memory_id').all(),
        sources: db.prepare('SELECT * FROM memory_sources ORDER BY source_id, derived_id').all(),
      }),
      now: () => this.now(),
      unlinkFile: this.deps.unlinkFile,
    }
  }

  private targetFor(date: string): string {
    return path.resolve(this.deps.reportDir, `${date}.md`)
  }

  async handle(method: string, route: string, query: URLSearchParams, body: unknown): Promise<{ status: number; body: unknown }> {
    try {
      if (method === 'GET' && route === '/report') return ok(this.view(dateOf(query.get('date') ?? localDateOf(this.now()))))
      if (method === 'POST' && route === '/report/edit') return this.edit(object(body))
      if (method === 'POST' && route === '/report/publish-request') return this.publishRequest(object(body))
      if (method === 'POST' && route === '/materials/import') return this.importMaterial(object(body))
      if (method === 'POST' && route === '/materials/share-request') return this.shareRequest(object(body))
      if (method === 'POST' && route === '/memories/edit') return this.editMemory(object(body))
      if (method === 'POST' && route === '/deletion/preview') return this.deletionPreview(object(body))
      // await：异步路由里的输入错误也要落到下面的 catch，回 400 而不是 500。
      if (method === 'POST' && route === '/deletion/request') return await this.deletionRequest(object(body))
      return fail(404, 'not_found', '没有这个工作台接口；工作台不能批准任何操作，批准只在桌面专用审批窗口签发')
    } catch (error) {
      if (error instanceof InputError) return fail(400, 'bad_request', error.message)
      throw error
    }
  }

  // -------------------------------------------------------------------------
  // 视图
  // -------------------------------------------------------------------------

  view(date: string): Record<string, unknown> {
    const { reports, materials } = this.deps
    const reportId = makeReportId('daily', date)
    const current = reports.current(reportId)
    const parsed = current ? parseReportLines(current.content) : []
    const links = current ? reports.links(reportId, current.revision) : new Map<number, string[]>()
    const ordinals = new Map<number, number>()
    for (const line of parsed) if (line.kind === 'entry') ordinals.set(line.index, ordinals.size + 1)
    const edits = reports.edits(reportId)
    const history = reports.history(reportId)
    const decisions = reportDecisions(this.deps.db, reportId)
    const items = this.itemsOf(date)

    const workItems = items.filter(item => item.status !== 'evidence_removed').map(item => {
      const linked = [...links].filter(([, ids]) => ids.includes(item.id)).map(([line]) => line).sort((a, b) => a - b)
      const entryList = linked.map(line => `第 ${ordinals.get(line) ?? '?'} 条`).join('、')
      let inclusion: { state: string; reason: string; lines: number[] }
      if (linked.length > 0) {
        const unmarked = item.status === 'inferred' && linked.some(line => !parsed[line]?.pending)
        inclusion = unmarked
          ? { state: 'warning', reason: `写入了${entryList}，但这条只是推断：须标注"（待确认）"，或先经你确认`, lines: linked }
          : { state: 'included', reason: item.status === 'inferred' ? `以"待确认"写入${entryList}` : `已写入${entryList}`, lines: linked }
      } else {
        const removedBy = [...edits].reverse().find(edit => edit.op === 'delete' && edit.workItemIds.includes(item.id))
        inclusion = removedBy
          ? { state: 'excluded', reason: `你在第 ${removedBy.revision} 版删除了相关条目`, lines: [] }
          : { state: 'not_linked', reason: item.status === 'inferred' ? '只有推断证据，本版没有关联条目；写入时会标注"（待确认）"' : '本版没有关联到这条事项的条目', lines: [] }
      }
      return {
        id: item.id, project: item.project, start: item.start, end: item.end, time: `${formatLocalTime(item.start)}–${formatLocalTime(item.end).slice(11)}`,
        action: item.action, outcome: item.outcome, summary: item.summary, discussionTopic: item.discussionTopic,
        status: item.status, statusLabel: WORK_ITEM_STATUS_LABEL[item.status],
        sources: item.sources.map(source => this.sourceView(source)),
        inclusion,
      }
    })
    // 证据已删除的事项只给编号与条数：依据已被删掉的结论，不再展示它的概括。
    const removed = items.filter(item => item.status === 'evidence_removed').map(item => ({ id: item.id, removedReason: item.removedReason }))

    const pending = this.deps.approvals.pendingReportApprovals().find(item => item.reportId === reportId) ?? null
    const lastDecision = [...decisions].filter(item => item.result !== null).sort((a, b) => (a.consumedAt ?? 0) - (b.consumedAt ?? 0)).at(-1) ?? null
    const deletedExports = reports.exportDeletions(reportId)
    const exports = history.filter(record => record.targetPath && (record.state === 'archived'
      || reports.jobsFor(reportId).some(job => job.revision === record.revision && job.state === 'succeeded')))
      .map(record => {
        const facts = fileFacts(record.targetPath!)
        const deletion = deletedExports.find(item => item.revision === record.revision && item.path === path.resolve(record.targetPath!))
        return {
          revision: record.revision, path: record.targetPath, exists: facts.exists, matchesRevision: facts.digest === record.digest,
          deletedAt: deletion?.deletedAt ?? null,
        }
      })
    return {
      date,
      reportId,
      targetPath: this.targetFor(date),
      rules: REPORT_EVIDENCE_RULES,
      capture: this.deps.tracker.active === undefined ? null : { active: !!this.deps.tracker.active, capturing: !!this.deps.tracker.capturing },
      current: current && {
        revision: current.revision, digest: current.digest, state: current.state, createdAt: current.createdAt,
        content: current.content, approvedAt: current.approvedAt, boundTarget: current.targetPath, revokedReason: current.revokedReason,
        change: describeEdit(edits.find(edit => edit.revision === current.revision)),
      },
      lines: parsed.map(line => ({
        index: line.index, kind: line.kind, text: line.text, section: line.section, pending: line.pending,
        ordinal: ordinals.get(line.index) ?? null, workItemIds: links.get(line.index) ?? [],
      })),
      stats: {
        entries: ordinals.size,
        pendingEntries: parsed.filter(line => line.kind === 'entry' && line.pending).length,
      },
      workItems,
      evidenceRemoved: { count: removed.length, items: removed },
      materials: this.materialsOf(date),
      memories: this.memoriesView(),
      history: history.map(record => ({
        revision: record.revision, state: record.state, digest: record.digest, createdAt: record.createdAt,
        approvedAt: record.approvedAt, targetPath: record.targetPath, revokedReason: record.revokedReason,
        change: describeEdit(edits.find(edit => edit.revision === record.revision)),
      })),
      decisions: decisions.map(item => ({ proposalId: item.proposalId, revision: item.revision, state: item.state, consumedAt: item.consumedAt, result: item.result })),
      pendingApproval: pending && { proposalId: pending.proposalId, revision: pending.revision, digest: pending.digest, target: pending.target, expiresAt: pending.expiresAt },
      lastPublish: lastDecision && { revision: lastDecision.revision, at: lastDecision.consumedAt, ...lastDecision.result },
      exports,
      receipts: reports.deletionReceipts(30),
      deletionCategories: DELETION_CATEGORIES,
    }
  }

  private itemsOf(date: string): WorkItem[] {
    if (!this.deps.workItems) return []
    const from = startOfLocalDate(date)
    const to = startOfLocalDate(localDateOf(from + 36 * 3_600_000))
    return this.deps.workItems.listInRange(from, to)
  }

  private sourceView(source: WorkItemSource): Record<string, unknown> {
    const base = { kind: source.kind, ref: source.ref, evidenceType: source.evidenceType, evidenceLabel: EVIDENCE_LABEL[source.evidenceType] ?? source.evidenceType }
    if (source.kind === 'activity_observation') {
      const observation = this.deps.observations?.get(source.ref) ?? null
      return {
        ...base, label: '活动线索', available: observation !== null,
        detail: observation ? `${observation.summary}（${formatLocalTime(observation.startAt)}–${formatLocalTime(observation.endAt).slice(11)}）` : '这条观察已不存在',
      }
    }
    if (source.kind === 'project_evidence') {
      const read = this.deps.workItems?.projectEvidence(source.ref) ?? null
      const authorized = read !== null && this.deps.helpContexts?.authorizedScope(read.projectDir)?.projectDir === read.projectDir
      return {
        ...base, label: '项目证据', available: authorized,
        detail: read ? `${read.summary}；${read.projectDir}；读取于 ${formatLocalTime(read.readAt)}${authorized ? '' : '；该项目的帮助授权已撤销或路径已改指'}` : '没有这次读取的登记',
      }
    }
    const material = this.deps.materials?.get(source.ref) ?? null
    if (material) {
      return {
        ...base, label: MATERIAL_KIND_LABEL[material.kind], available: true, object: material.objectLabel,
        coveredFrom: material.coveredFrom, coveredTo: material.coveredTo, detail: material.coverage,
      }
    }
    return { ...base, label: source.kind === 'user_note' ? '随手记' : '导入资料', available: !this.deps.materials?.deletedId(source.ref), detail: source.summary }
  }

  /** 当天资料：登记过的 + 旧版只存在当天记录里的笔记（删过的按墓碑挡住）。正文给用户看，按纯文本渲染。 */
  private materialsOf(date: string): Array<Record<string, unknown>> {
    const materials = this.deps.materials
    const registered: Material[] = materials?.listForDate(date) ?? []
    const known = new Set(registered.map(item => item.id))
    const usage = (id: string) => (this.deps.workItems
      ? [...this.deps.workItems.referencing('import_material', [id]), ...this.deps.workItems.referencing('user_note', [id])]
      : []).map(item => ({ id: item.id, status: item.status }))
    const legacy = this.deps.tracker.getDay(date).notes
      .filter(note => !known.has(note.id) && !materials?.deletedId(note.id))
      .map(note => ({
        id: note.id, kind: materialKindForSource(note.source), kindLabel: MATERIAL_KIND_LABEL[materialKindForSource(note.source)],
        origin: 'conversation', sourceLabel: note.source, object: null, coveredFrom: null, coveredTo: null,
        coverage: '旧版导入记录：没有登记对象与覆盖范围', digest: null, lines: note.content.split('\n').length,
        bytes: Buffer.byteLength(note.content, 'utf8'), truncated: false, modelVisible: true, localDate: date, projectDir: null,
        createdAt: note.createdAt, legacy: true, preview: note.content.slice(0, 2000), usedBy: usage(note.id),
      }))
    return [
      ...registered.map(item => ({ ...materialMeta(item), legacy: false, preview: item.content.slice(0, 2000), usedBy: usage(item.id) })),
      ...legacy,
    ]
  }

  /** 记忆列表：全局 + 仍在有效授权内的项目范围；授权失效的项目只报条数（口径同 list_preferences）。 */
  private memoriesView(): Record<string, unknown> {
    const now = this.now()
    const authorized = new Set((this.deps.helpContexts?.list() ?? [])
      .map(item => this.deps.helpContexts?.authorizedScope(item.projectDir)?.projectDir)
      .filter((dir): dir is string => !!dir))
    const visible = [
      ...this.deps.memories.list({}, now),
      ...[...authorized].flatMap(dir => this.deps.memories.listProject(dir, now)),
    ]
    let hidden = 0
    for (const [scopeId, count] of this.deps.memories.projectScopeCounts()) if (!authorized.has(scopeId)) hidden += count
    return {
      items: visible.map(item => ({
        id: item.id, kind: item.kind, scope: scopeLabel(item.scope, {}), topic: item.topic, text: item.text,
        status: item.status, sourceRefs: item.sourceRefs, updatedAt: item.updatedAt, imported: item.importBatch !== null,
      })),
      hiddenProjectMemories: hidden,
    }
  }

  // -------------------------------------------------------------------------
  // 逐条修订与请求发布
  // -------------------------------------------------------------------------

  private edit(input: Record<string, unknown>) {
    const date = dateOf(input.date)
    const reportId = makeReportId('daily', date)
    const baseRevision = integer(input.baseRevision, '基准版本')
    const baseDigest = typeof input.baseDigest === 'string' ? input.baseDigest : ''
    if (baseRevision > 0 && !DIGEST.test(baseDigest)) throw new InputError('基准摘要缺失')
    const op = parseOp(input.op)
    let workItemIds: string[] | undefined
    const workItemId = optionalText(input.workItemId, '事项编号', 200)
    if (workItemId) {
      if (op.type !== 'add') throw new InputError('只有补充条目时才能关联事项')
      const item = this.deps.workItems?.get(workItemId) ?? null
      if (!item) return fail(404, 'not_found', '找不到这条工作事项')
      if (item.status === 'evidence_removed') return fail(409, 'evidence_removed', '这条事项的证据已删除，不能写入日报')
      workItemIds = [item.id]
      if (!op.text.trim()) op.text = item.summary
      // 推断事项写进日报必须带"待确认"标注（REPORT_EVIDENCE_RULES）。
      if (item.status === 'inferred' && !isPendingEntry(op.text)) op.text = `${op.text.trim()}（待确认）`
    }
    const outcome = this.deps.reports.saveEdit({
      reportId, baseRevision, baseDigest, op, workItemIds, emptyTitle: `${date} 工作日报`, now: this.now(), dryRun: input.dryRun === true,
    })
    if (!outcome.ok) {
      const status = outcome.code === 'stale_base' || outcome.code === 'revoked_base' || outcome.code === 'locked' || outcome.code === 'text_mismatch' ? 409 : 400
      return fail(status, outcome.code, outcome.message, { current: outcome.current })
    }
    if (outcome.saved) this.deps.approvals.notifyApprovalSnapshot?.()
    return ok({
      saved: outcome.saved, preview: outcome.preview, digest: outcome.digest,
      revision: outcome.record?.revision ?? null, state: outcome.record?.state ?? null,
      line: outcome.line, before: outcome.before, after: outcome.after,
    })
  }

  /**
   * 请求发布用户正在看的那一版。版本号、摘要、保存路径三样都要和库里的当前版本一致；
   * 一致才提交可信审批，返回 proposalId 交给桌面主进程打开专用审批窗口。这里不批准、不写文件。
   */
  private async publishRequest(input: Record<string, unknown>) {
    const date = dateOf(input.date)
    const revision = integer(input.revision, '版本号', 1)
    const digest = typeof input.digest === 'string' && DIGEST.test(input.digest) ? input.digest : ''
    const targetPath = optionalText(input.targetPath, '保存路径', 4096)
    if (!digest || !targetPath) throw new InputError('请求发布必须带上你看到的版本号、内容摘要与保存路径')
    const reportId = makeReportId('daily', date)
    const current = this.deps.reports.current(reportId)
    if (!current) return fail(404, 'not_found', '还没有日报草稿')
    if (current.revision !== revision || current.digest !== digest) {
      return fail(409, 'stale_revision', `你看到的是第 ${revision} 版，当前已经是第 ${current.revision} 版；请刷新后核对再请求发布`, { current: { revision: current.revision, digest: current.digest } })
    }
    if (current.state === 'archived') {
      return fail(409, 'already_published', `第 ${revision} 版已经发布到 ${current.targetPath ?? '目标文件'}，不会重复导出；要发布新内容请先修改产生新版本`)
    }
    if (current.state === 'revoked' || current.state === 'publishing' || current.state === 'approved') {
      return fail(409, 'wrong_state', `第 ${revision} 版当前状态是 ${current.state}，不能请求发布`)
    }
    const expected = this.targetFor(date)
    if (path.resolve(targetPath) !== expected) {
      return fail(409, 'target_mismatch', `你看到的保存位置（${targetPath}）与实际发布位置（${expected}）不一致，没有提交`, { expected })
    }
    let proposal: ReportProposal
    try {
      const submission = await this.deps.approvals.submitReport(reportId)
      if (submission.mode === 'auto') {
        // 用户开着"自动记录"：文件已经写了或写失败了，如实回报，不伪装成待批。
        if (!submission.published.ok) {
          return fail(500, 'auto_publish_failed', submission.published.error ?? '自动保存未完成')
        }
        return ok({
          autoPublished: true, revision: submission.published.revision ?? revision,
          digest: submission.published.digest ?? digest, target: expected,
          savedPath: submission.published.savedPath ?? null,
          message: submission.published.existing
            ? '设置里开着"自动记录"：目标文件已是这一版的内容，没有重复写入'
            : '设置里开着"自动记录"：日报已直接写入，跳过审批窗口',
        })
      }
      proposal = submission.proposal
    } catch (error) {
      return fail(409, 'submit_failed', error instanceof Error ? error.message : String(error))
    }
    if (proposal.revision !== revision || proposal.digest !== digest || proposal.target !== expected) {
      return fail(409, 'stale_revision', '提交时草稿刚好又变了；请刷新后再请求发布')
    }
    return ok({
      proposalId: proposal.proposalId, revision: proposal.revision, digest: proposal.digest, target: proposal.target,
      expiresAt: proposal.expiresAt,
      message: '已提交可信审批：请在桌面专用审批窗口核对全文、版本与保存位置后批准；尚未写入文件',
    })
  }

  // -------------------------------------------------------------------------
  // 记忆改写
  // -------------------------------------------------------------------------

  /**
   * 工作台改写一条长期记忆。
   *
   * 与删除同一条纪律：工作台自己不能改，只能把"改成什么"提交成可信待批，由用户在
   * 专用审批窗口看到新旧全文后点头。auto 模式下按用户的配置直接改写并如实回报。
   *
   * 为什么不删掉再新建：记忆的 id 被待批提案、工作事项来源边和冲突记录引用着，
   * 换 id 等于让这些引用指向一个不存在的东西。就地改正文、版本号 +1，历史靠 revision 追溯。
   */
  private editMemory(input: Record<string, unknown>) {
    const memoryId = optionalText(input.memoryId, '记忆编号', 200)
    if (!memoryId) throw new InputError('没有指定要改写的记忆')
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (!text) throw new InputError('改写后的内容不能为空；要撤销这条记忆请用删除')
    if (text.length > MAX_TEXT) throw new InputError('改写后的内容太长')
    const topic = input.topic === undefined ? undefined : optionalText(input.topic, '分类主题', 120) ?? ''
    const now = this.now()
    const record = this.deps.memories.get(memoryId, now)
    if (!record) return fail(404, 'not_found', '找不到这条记忆，可能已被删除')
    if (record.status === 'expired') return fail(409, 'expired', '这条记忆已失效，不能改写')
    // 项目范围记忆须授权仍有效，否则用户看到的是"别人项目里的规则"，不该在这里改。
    const visible = new Set((this.deps.helpContexts?.list() ?? [])
      .map(item => this.deps.helpContexts?.authorizedScope(item.projectDir)?.projectDir)
      .filter((dir): dir is string => !!dir))
    if (record.scope.kind === 'project' && !visible.has(record.scope.id)) {
      return fail(403, 'scope_unavailable', '这条记忆所属项目的帮助授权已撤销或实际路径已改指，暂不能改写；重新授权该目录后可见')
    }
    const label = scopeLabel(record.scope, {})
    if (text === record.text && (topic === undefined || topic === record.topic)) {
      return ok({ saved: false, message: '内容和分类都没有变化，没有提交' })
    }
    const writes = this.deps.memoryWrites
    if (!writes) return fail(404, 'not_wired', '记忆改写未装配；当前版本的工作台只能查看与删除记忆')

    if (writes.approvalMode() === 'auto') {
      const updated = this.deps.memories.revise(memoryId,
        { text, ...(topic === undefined ? {} : { topic }), actor: { id: 'auto-publish', isUser: true } }, this.now())
      if (!updated) return fail(409, 'revise_failed', '改写失败：这条记忆已不存在或已失效')
      return ok({
        saved: true, mode: 'auto', id: updated.id, text: updated.text, topic: updated.topic, revision: updated.revision,
        message: '设置里开着"自动记录"：这条记忆已直接改写',
      })
    }

    let proposalId: string
    try {
      proposalId = writes.proposeMemoryEdit({
        memoryId, text, ...(topic === undefined ? {} : { topic }),
        before: { text: record.text, topic: record.topic }, scopeLabel: label,
      })
    } catch (error) {
      return fail(409, 'submit_failed', error instanceof Error ? error.message : String(error))
    }
    return ok({
      saved: false, pending: true, proposalId, mode: 'manual', id: memoryId,
      message: '已提交可信审批：请在桌面专用审批窗口核对新旧全文后批准；尚未改动',
    })
  }

  // -------------------------------------------------------------------------
  // 资料
  // -------------------------------------------------------------------------

  /** 用户在桌面用系统文件框选中的文件：只登记在本机，正文默认不发送模型。 */
  private importMaterial(input: Record<string, unknown>) {
    const materials = this.deps.materials
    if (!materials) return fail(404, 'not_wired', '资料登记未装配')
    const kind = String(input.kind ?? '') as MaterialKind
    if (!DESKTOP_MATERIAL_KINDS.has(kind)) throw new InputError('桌面导入只支持聊天片段、导入文本与随手记；项目文件与仓库差异须经授权读取')
    const content = typeof input.content === 'string' ? input.content : ''
    const fileName = optionalText(input.fileName, '文件名', 260)
    const date = input.date === undefined ? localDateOf(this.now()) : dateOf(input.date)
    const coveredFrom = input.coveredFrom === undefined || input.coveredFrom === null ? null : finite(input.coveredFrom, '覆盖开始时间')
    const coveredTo = input.coveredTo === undefined || input.coveredTo === null ? null : finite(input.coveredTo, '覆盖结束时间')
    const result = materials.register({
      kind, origin: 'desktop_selection',
      sourceLabel: optionalText(input.sourceLabel, '来源', 80) ?? (fileName ? `file:${path.basename(fileName)}` : 'desktop'),
      objectLabel: optionalText(input.objectLabel, '对象', 200), coveredFrom, coveredTo,
      content, modelVisible: false, localDate: date,
    }, this.now())
    if (!result.ok) return fail(400, 'rejected', result.message)
    return ok({
      material: materialMeta(result.material), duplicate: result.duplicate, previouslyDeleted: result.previouslyDeleted,
      message: result.duplicate
        ? `同样的内容已经导入过（${result.material.id}），没有重复登记`
        : `已登记在本机；正文默认不发送给模型${result.previouslyDeleted ? '；注意：这份内容以前被删除过，这次是你重新导入' : ''}`,
    })
  }

  private shareRequest(input: Record<string, unknown>) {
    const materials = this.deps.materials
    if (!materials) return fail(404, 'not_wired', '资料登记未装配')
    const planned = materialShareSubmission({ materials }, String(input.materialId ?? ''))
    if (!planned.ok) return fail(409, 'rejected', planned.message)
    const proposal = this.deps.approvals.submitAssistant(planned.submission)
    return ok({ proposalId: proposal.proposalId, expiresAt: proposal.expiresAt, message: '已提交可信审批：请在桌面专用审批窗口核对将发送的全文后决定；尚未发送' })
  }

  // -------------------------------------------------------------------------
  // 删除：逐类预览、逐类确认
  // -------------------------------------------------------------------------

  private plan(input: Record<string, unknown>) {
    const category = String(input.category ?? '') as DeletionCategory
    if (!(DELETION_CATEGORIES as readonly string[]).includes(category)) {
      throw new InputError('没有这种删除类别。工作台不提供"全部清空"，请逐类查看影响后分别确认')
    }
    const params = object(input.params ?? {})
    const reason = optionalText(params.reason, '原因', 200)
    const deps = this.deletionDeps()
    switch (category) {
      case 'draft_entry':
        return planDraftEntryDeletion(deps, {
          reportId: makeReportId('daily', dateOf(params.date)), revision: integer(params.revision, '版本号', 1),
          digest: String(params.digest ?? ''), line: integer(params.line, '行号'), expectedText: String(params.expectedText ?? ''),
        })
      case 'report_version':
        return planReportRevocation(deps, makeReportId('daily', dateOf(params.date)), integer(params.revision, '版本号', 1), reason)
      case 'activity_range': {
        const planned = planActivityDeletion(deps, finite(params.from, '开始时间'), finite(params.to, '结束时间'), reason ?? undefined)
        return planned.ok ? planned : { ok: false as const, message: planned.message }
      }
      case 'material':
        return planMaterialDeletion(deps, String(params.materialId ?? ''), { date: typeof params.date === 'string' ? params.date : null, reason })
      case 'memory': {
        const memoryId = optionalText(params.memoryId, '记忆编号', 200)
        if (!memoryId) throw new InputError('没有指定要删除的记忆')
        return { ok: true as const, plan: planMemoryDeletion(deps, { id: memoryId, ...(reason ? { reason } : {}) }) }
      }
      case 'exported_file':
        return planExportedFileDeletion(deps, makeReportId('daily', dateOf(params.date)), integer(params.revision, '版本号', 1), reason)
    }
  }

  private deletionPreview(input: Record<string, unknown>) {
    const planned = this.plan(input)
    if (!planned.ok) return fail(404, 'not_found', planned.message)
    return ok({ impact: planned.plan.impact })
  }

  private async deletionRequest(input: Record<string, unknown>) {
    const planned = this.plan(input)
    if (!planned.ok) return fail(404, 'not_found', planned.message)
    const { impact, submission } = planned.plan
    if (impact.blocked) return fail(409, 'blocked', impact.blocked, { impact })
    if (input.previewDigest !== impact.digest) {
      return fail(409, 'preview_stale', '影响范围和你刚才看到的不一样了，请重新查看后再确认', { impact })
    }
    if (impact.category === 'draft_entry') {
      const params = object(input.params)
      const date = dateOf(params.date)
      const outcome = this.deps.reports.saveEdit({
        reportId: makeReportId('daily', date), baseRevision: integer(params.revision, '版本号', 1), baseDigest: String(params.digest ?? ''),
        op: { type: 'delete', line: integer(params.line, '行号'), expectedText: String(params.expectedText ?? '') }, now: this.now(),
      })
      if (!outcome.ok) return fail(409, outcome.code, outcome.message, { current: outcome.current })
      const receiptId = recordReceipt(this.deps.reports, {
        category: 'draft_entry', label: impact.label, scope: impact.scope, at: this.now(),
        deleted: impact.willDelete, invalidated: impact.willInvalidate, retained: impact.retained, uncontrolled: impact.uncontrolled, failures: [],
      })
      this.deps.approvals.notifyApprovalSnapshot?.()
      return ok({ kind: 'revision', revision: outcome.record?.revision ?? null, digest: outcome.digest, receiptId, message: `已删除这一条，生成第 ${outcome.record?.revision} 版；原始记录不受影响` })
    }
    if (!submission) return fail(500, 'no_submission', '这类删除缺少可信审批提交')
    let proposal: AssistantProposal
    try {
      proposal = this.deps.approvals.submitAssistant(submission)
    } catch (error) {
      return fail(409, 'submit_failed', error instanceof Error ? error.message : String(error))
    }
    return ok({
      kind: 'approval', proposalId: proposal.proposalId, expiresAt: proposal.expiresAt,
      message: '已提交可信审批：请在桌面专用审批窗口核对影响范围后确认；尚未删除任何内容',
    })
  }
}

/**
 * 装配入口：index 里一行调用即可。缺省的存储按同一个库连接现建（这些存储类只是库上的薄封装，
 * 建表语句都是 IF NOT EXISTS），也可以把 index 里已有的实例传进来复用。
 */
export function mountReportWorkbench(
  bridge: WorkbenchApprovals & { attachWorkbench(handler: WorkbenchHandler): void },
  deps: Omit<ReportWorkbenchDeps, 'approvals'>,
): ReportWorkbench {
  const workbench = new ReportWorkbench({
    ...deps,
    approvals: bridge,
    workItems: deps.workItems ?? new WorkItemStore(deps.db),
    materials: deps.materials ?? new MaterialStore(deps.db),
    helpContexts: deps.helpContexts ?? new HelpContextStore(deps.db),
  })
  bridge.attachWorkbench(workbench)
  return workbench
}
