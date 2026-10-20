/**
 * 删除范围与完整删除回执（M3-05）。
 *
 * 六类删除分开处理，各自展示影响、各自取得确认，不提供"全部清空"：
 *
 * | 类别 | 动的是什么 | 确认方式 |
 * |---|---|---|
 * | 草稿条目 | 当前草稿的一行，生成新版本；旧版本留在历史里 | 工作台内确认（可回看的修订，不销毁数据） |
 * | 日报版本 | 某一版的状态改为已撤销；正文与导出文件不动 | 可信审批 |
 * | 时间段活动 | 采样原文、观察、自动事项；派生记忆、事项与未发布日报沿来源失效 | 可信审批 |
 * | 导入资料 | 资料正文与登记、当天笔记及其生成的摘要；事项、记忆、未发布日报沿来源失效 | 可信审批 |
 * | 长期记忆 | 一条记忆及其派生记忆 | 可信审批 |
 * | 导出文件 | 磁盘上的日报文件（内容必须仍是那一版）；库里的版本与状态不动 | 可信审批 |
 *
 * 预览不靠另写一套推算：能在库里模拟的部分（记忆传播、事项失效、日报撤销）直接跑真实代码再整体回滚，
 * 用户看到的影响与批准后实际发生的出自同一段逻辑。每次执行都留回执：已删除 / 已失效 / 仍保留 /
 * 无法控制 / 失败项，存进库里供工作台历史回看。删除后留下的账本（记忆删除账本、资料墓碑、
 * 活动区间账本、导出删除记录）保证重启、旧记录回填和从备份导入记录时不会把它们悄悄带回来。
 */
import { lstatSync, readFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { snapshotDigest, type AssistantSubmission } from './assistant-approval.ts'
import type { ActivitySpan, DayRecord } from './domain.ts'
import { deletionReport, kindLabel, type DeletionOutcome, type MemoryRecord, type MemoryStore } from './memory.ts'
import { isNoteEvent, MATERIAL_KIND_LABEL, materialDigest, materialKindForSource, materialMeta, type MaterialStore } from './materials.ts'
import type { ObservationStore } from './observation.ts'
import { makeReportId, parseReportLines, tempPathFor, type ReportRevision, type ReportStore } from './report.ts'
import { formatLocalTime, sha256 } from './store.ts'
import { localDateOf, startOfLocalDate } from './time.ts'
import type { SourceRemovalOutcome, WorkItem, WorkItemSourceKind, WorkItemStore } from './work-items.ts'

export const DELETION_CATEGORIES = ['draft_entry', 'report_version', 'activity_range', 'material', 'memory', 'exported_file'] as const
export type DeletionCategory = (typeof DELETION_CATEGORIES)[number]

export const DELETION_CATEGORY_LABEL: Record<DeletionCategory, string> = {
  draft_entry: '删除草稿条目',
  report_version: '撤销日报版本',
  activity_range: '删除时间段活动',
  material: '删除导入资料',
  memory: '删除长期记忆',
  exported_file: '删除已导出文件',
}

/** 删除依赖的跟踪器能力。enqueueDayUpdate 只有删资料（当天笔记）时才用得到。 */
export interface DeletionTracker {
  getDay(date: string): DayRecord & { spans: ActivitySpan[] }
  stop(): Promise<void>
  deletionSnapshot(dates: readonly string[], from: number, to: number): unknown
  deleteSampleRange(date: string, from: number, to: number): number
  pruneAutoEvents(date: string, from: number, to: number): Promise<number>
  enqueueDayUpdate?(date: string, mutate: (day: DayRecord) => DayRecord): Promise<DayRecord>
}

export interface DeletionDeps {
  tracker: DeletionTracker
  reports: ReportStore
  memories: MemoryStore
  observations?: ObservationStore
  workItems?: WorkItemStore
  materials?: MaterialStore
  reportDir: string
  legacyCopiesRetained: boolean
  /** 全范围记忆与来源边的固定快照（与记忆类可信提案同一口径）。 */
  memorySnapshot(): unknown
  now(): number
  /** 测试注入：删除文件。缺省 fs.promises.unlink。 */
  unlinkFile?(file: string): Promise<void>
}

export interface DeletionImpact {
  category: DeletionCategory
  label: string
  /** 固定范围（给人看的）。 */
  scope: Record<string, unknown>
  willDelete: string[]
  willInvalidate: string[]
  retained: string[]
  uncontrolled: string[]
  /** 现在不能执行的原因；null 表示可以请求确认。 */
  blocked: string | null
  needsTrustedApproval: boolean
  /** 请求执行时须原样带回：范围变了就要求重新查看。 */
  digest: string
}

export interface DeletionPlan {
  impact: DeletionImpact
  /** 需要可信审批的类别给出提交；草稿条目这类可回看的修订为 null。 */
  submission: AssistantSubmission | null
}

export interface DeletionReceipt {
  category: DeletionCategory
  label: string
  scope: Record<string, unknown>
  at: number
  deleted: string[]
  invalidated: string[]
  retained: string[]
  uncontrolled: string[]
  failures: string[]
}

type PlanResult = { ok: true; plan: DeletionPlan } | { ok: false; message: string }

function impactOf(category: DeletionCategory, fields: Omit<DeletionImpact, 'category' | 'label' | 'needsTrustedApproval' | 'digest'>): DeletionImpact {
  const needsTrustedApproval = category !== 'draft_entry'
  const body = { category, label: DELETION_CATEGORY_LABEL[category], needsTrustedApproval, ...fields }
  return { ...body, digest: snapshotDigest(body) }
}

/** 把回执写进库并返回编号；写回执失败不能吞掉删除结果，原样抛出由调用方报告。 */
export function recordReceipt(reports: ReportStore, receipt: DeletionReceipt): string {
  return reports.recordDeletionReceipt(receipt.category, receipt.scope, receipt, receipt.at)
}

const STATE_LABEL: Record<string, string> = {
  draft: '草稿', pending_confirmation: '待批', approved: '已批准', publishing: '发布中', archived: '已发布', revoked: '已撤销',
}

function revisionLabel(record: ReportRevision): string {
  return `${record.reportId} 第 ${record.revision} 版（${STATE_LABEL[record.state] ?? record.state}）`
}

function itemLabel(item: WorkItem): string {
  return `事项 ${item.id}「${item.summary.slice(0, 40)}${item.summary.length > 40 ? '…' : ''}」`
}

function memoryLabel(record: MemoryRecord): string {
  return `${kindLabel(record.kind)}${record.topic ? `「${record.topic}」` : ''}：${record.text.slice(0, 30)}${record.text.length > 30 ? '…' : ''}（${record.id}）`
}

function mergeMemory(outcomes: readonly DeletionOutcome[]): DeletionOutcome {
  return {
    deleted: outcomes.flatMap(item => item.deleted),
    weakened: outcomes.flatMap(item => item.weakened),
    restored: outcomes.flatMap(item => item.restored),
    ledgerEntries: outcomes.reduce((total, item) => total + item.ledgerEntries, 0),
  }
}

function mergeItems(outcomes: readonly SourceRemovalOutcome[]): SourceRemovalOutcome {
  const removed = new Map<string, WorkItem>()
  const downgraded = new Map<string, WorkItem>()
  for (const outcome of outcomes) {
    for (const item of outcome.evidenceRemoved) removed.set(item.id, item)
    for (const item of outcome.downgraded) downgraded.set(item.id, item)
  }
  for (const id of removed.keys()) downgraded.delete(id)
  return { refsRemoved: outcomes.reduce((total, item) => total + item.refsRemoved, 0), evidenceRemoved: [...removed.values()], downgraded: [...downgraded.values()] }
}

/** 传播结果翻成"将失效"清单：事项、记忆、日报版本各自写清楚变成什么。 */
function invalidationLines(items: SourceRemovalOutcome | null, memory: DeletionOutcome | null, revoked: readonly ReportRevision[]): { deleted: string[]; invalidated: string[] } {
  const deleted = (memory?.deleted ?? []).map(record => `派生记忆 ${memoryLabel(record)} 失去全部来源，随之删除`)
  const invalidated = [
    ...(items?.evidenceRemoved ?? []).map(item => `${itemLabel(item)} 失去全部来源，标为"证据已删除"，不再写入日报`),
    ...(items?.downgraded ?? []).map(item => `${itemLabel(item)} 失去直接证据，从"直接证据"退回"推断"`),
    ...(memory?.weakened ?? []).map(record => `记忆 ${memoryLabel(record)} 来源减少，退回候选，不再作为已确认规则注入`),
    ...revoked.map(record => `${record.reportId} 第 ${record.revision} 版未发布的日报保守撤销：可能含被删内容，需重新生成并批准`),
  ]
  return { deleted, invalidated }
}

function datesBetween(from: number, to: number): string[] | null {
  const dates: string[] = []
  for (const cursor = new Date(startOfLocalDate(localDateOf(from))); localDateOf(cursor.getTime()) <= localDateOf(to - 1); cursor.setDate(cursor.getDate() + 1)) {
    if (dates.length >= 3660) return null
    dates.push(localDateOf(cursor.getTime()))
  }
  return dates
}

// ---------------------------------------------------------------------------
// 时间段活动
// ---------------------------------------------------------------------------

/** 删除区间内的活动。错误返回带上原工具的回复形状（deleted/pending），工具层原样转交。 */
export function planActivityDeletion(deps: DeletionDeps, from: number, to: number, reasonInput?: string):
  PlanResult | { ok: false; message: string; shape: 'deleted' | 'pending' } {
  const observations = deps.observations
  if (!observations) return { ok: false, message: '观察库未装配，不能删除原始记录', shape: 'deleted' }
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return { ok: false, message: '删除区间无效：开始必须早于结束', shape: 'deleted' }
  const dates = datesBetween(from, to)
  if (!dates) return { ok: false, message: '删除范围过大，请分段提交', shape: 'pending' }
  const tracker = deps.tracker
  const retained = dates.map(date => {
    const day = tracker.getDay(date)
    return {
      date,
      userEvents: day.events.filter(event => event.source !== 'auto' && event.start < to && event.end > from).length,
      notes: day.notes.length,
    }
  }).filter(item => item.userEvents > 0 || item.notes > 0)
  const reason = reasonInput ?? '用户要求删除该时段原始记录'
  const fixed = () => {
    const overlapping = observations.listOverlap('activity_span', from, to)
    return {
      from, to, reason, retained,
      days: tracker.deletionSnapshot(dates, from, to),
      observations: overlapping,
      memories: deps.memorySnapshot(),
      workItems: deps.workItems?.referencing('activity_observation', overlapping.map(obs => obs.id)) ?? [],
      reports: dates.map(date => deps.reports.history(makeReportId('daily', date))),
    }
  }
  const before = fixed()
  const unchanged = () => snapshotDigest(before) === snapshotDigest(fixed())

  const ids = before.observations.map(obs => obs.id)
  const sampleCount = Array.isArray(before.days)
    ? (before.days as Array<{ samples?: unknown[] }>).reduce((total, day) => total + (Array.isArray(day.samples) ? day.samples.length : 0), 0)
    : null
  const autoEvents = dates.reduce((total, date) => total + tracker.getDay(date).events
    .filter(event => event.source === 'auto' && event.start < to && event.end > from).length, 0)
  // 能在库里模拟就模拟：记忆传播、事项失效、日报撤销跑一遍真实代码再回滚。
  const simulated = deps.materials
    ? deps.materials.preview(() => ({
        memory: mergeMemory(ids.map(id => deps.memories.deleteSource(id, reason, deps.now()))),
        items: deps.workItems?.removeSources('activity_observation', ids, reason, deps.now()) ?? null,
      }))
    : null
  const propagation = invalidationLines(simulated?.items ?? null, simulated?.memory ?? null, deps.reports.unpublishedFor(dates))
  if (!simulated) {
    if (before.workItems.length > 0) propagation.invalidated.unshift(`引用这些观察的工作事项 ${before.workItems.length} 条将断开引用；失去全部来源的标为"证据已删除"`)
    propagation.invalidated.unshift('由这些观察派生的记忆按来源传播删除或退回候选')
  }
  const impact = impactOf('activity_range', {
    scope: { 开始: formatLocalTime(from), 结束: formatLocalTime(to), 日期: dates, 原因: reason },
    willDelete: [
      `${formatLocalTime(from)} 至 ${formatLocalTime(to)}（不含结束）的采样原文${sampleCount === null ? '' : ` ${sampleCount} 条样本`}`,
      `观察库中的活动片段 ${ids.length} 条`,
      `这些时段里助理自动解释的事项摘要 ${autoEvents} 条`,
      ...propagation.deleted,
    ],
    willInvalidate: propagation.invalidated,
    retained: [
      ...retained.map(item => `${item.date} 的用户笔记 ${item.notes} 条、用户补充事项 ${item.userEvents} 条`),
      '已发布（归档）的日报版本与已导出文件；需要时请分别撤销版本或删除导出文件',
      '区间以外的活动记录',
    ],
    uncontrolled: ['删除前已注入模型提示词的内容无法撤回', '已归档日报、导出文件与任何外部副本不在本次删除范围'],
    blocked: deps.reports.invalidationBlocker(dates),
  })

  const execute = async () => {
    await tracker.stop()
    if (!unchanged()) throw new Error('停止采样后影响范围已变化，未删除原文')
    // 日报前置必须成功，之后才准许触碰观察或采样原文。
    const invalidatedReports = deps.reports.invalidateActivityDates(dates, reason)
    // 区间账本先于删除本体：中途失败时，删了一半的时段也不会在读取时重新出现。
    const range = observations.recordDeletedRange(from, to, reason, deps.now())
    const overlaps = observations.listOverlap('activity_span', from, to)
    const memoryOutcomes = overlaps.map(obs => deps.memories.deleteSource(obs.id, reason, deps.now()))
    // 与记忆来源同一步：先断开事项对这些观察的引用，再删观察本体。
    const workItemOutcome = deps.workItems?.removeSources('activity_observation', overlaps.map(obs => obs.id), reason, deps.now()) ?? null
    const obsDeleted = observations.deleteOverlap('activity_span', from, to)
    let samples = 0
    let pruned = 0
    for (const date of dates) {
      pruned += await tracker.pruneAutoEvents(date, from, to)
      samples += tracker.deleteSampleRange(date, from, to)
    }
    const deletedMemories = memoryOutcomes.reduce((total, item) => total + item.deleted.length, 0)
    const invalidated = memoryOutcomes.reduce((total, item) => total + item.weakened.length, 0)
    const lines = invalidationLines(workItemOutcome, mergeMemory(memoryOutcomes), invalidatedReports)
    const receipt: DeletionReceipt = {
      category: 'activity_range', label: DELETION_CATEGORY_LABEL.activity_range, scope: impact.scope, at: deps.now(),
      deleted: [`采样原文 ${samples} 条`, `观察 ${obsDeleted} 条`, `自动解释事项 ${pruned} 条`, ...lines.deleted,
        `已记下删除区间 ${formatLocalTime(range.from)} 至 ${formatLocalTime(range.to)}：备份还原的采样原文也不会在读取时重新出现`],
      invalidated: lines.invalidated,
      retained: impact.retained,
      uncontrolled: impact.uncontrolled,
      failures: [],
    }
    const receiptId = recordReceipt(deps.reports, receipt)
    return {
      deleted: true,
      deletedCounts: { samples, observations: obsDeleted, autoEvents: pruned, derivedMemories: deletedMemories },
      invalidated,
      invalidatedReports,
      memoryOutcomes,
      workItems: workItemOutcome && {
        refsRemoved: workItemOutcome.refsRemoved,
        evidenceRemoved: workItemOutcome.evidenceRemoved.map(item => ({ id: item.id, status: item.status })),
        downgradedToInferred: workItemOutcome.downgraded.map(item => ({ id: item.id, status: item.status })),
        note: '失去全部来源的工作事项已标为 evidence_removed，不得再写入日报；仍有其他来源的事项保留，失去直接证据的 direct 事项退回 inferred',
      },
      retained,
      uncontrolled: ['删除前已注入模型提示词的内容无法撤回', '已归档日报、导出文件与任何外部副本不在本次删除范围'],
      receiptId,
      receipt,
      message: '已删除该时段的采样原文、观察与自动事项；用户笔记与导入记录保留。派生记忆按来源传播失效；采集保持停止。未采集或删除聊天正文。',
    }
  }

  return {
    ok: true,
    plan: {
      impact,
      submission: {
        subject: 'activity-delete', tool: 'personal_assistant_delete_activity',
        summary: '删除指定区间采样原文、观察与自动解释，先停止采集并撤销相关日期未发布日报，沿观察来源失效派生记忆，并断开工作事项对这些观察的引用（失去全部来源的事项标为 evidence_removed）。保留用户笔记、导入、已归档日报；已发送模型服务商的内容及外部副本不可撤回。不删除聊天正文，因为从未采集该正文。',
        target: `${from} 至 ${to}（不含结束）`, risk: 'high',
        snapshot: { 影响预览: previewView(impact), 固定范围: before },
        validate: unchanged,
        execute,
      },
    },
  }
}

/** 审批卡片上先给人看四类清单，再附机器核对用的固定范围。 */
function previewView(impact: DeletionImpact) {
  return { 将删除: impact.willDelete, 将失效: impact.willInvalidate, 仍保留: impact.retained, 无法控制: impact.uncontrolled }
}

// ---------------------------------------------------------------------------
// 导入资料
// ---------------------------------------------------------------------------

const MATERIAL_SOURCE_KINDS: WorkItemSourceKind[] = ['import_material', 'user_note']

export function planMaterialDeletion(deps: DeletionDeps, materialId: string, options: { date?: string | null; reason?: string | null } = {}): PlanResult {
  const materials = deps.materials
  if (!materials) return { ok: false, message: '资料登记未装配，不能删除导入资料' }
  const id = String(materialId ?? '').trim()
  if (!id) return { ok: false, message: '没有指定要删除的资料' }
  const material = materials.get(id)
  const date = material?.localDate ?? (options.date && /^\d{4}-\d{2}-\d{2}$/.test(options.date) ? options.date : null)
  const day = date ? deps.tracker.getDay(date) : null
  const note = day?.notes.find(item => item.id === id) ?? null
  if (!material && !note) return { ok: false, message: '找不到这份资料（可能已删除；旧导入记录需要同时给出日期）' }
  const reason = options.reason?.trim() || '用户要求删除这份导入资料'
  const legacyObservationId = `legacy-note:${id}`
  const legacyObservation = deps.observations?.get(legacyObservationId) ?? null
  const noteEvents = note && day ? day.events.filter(event => isNoteEvent(event, note)) : []
  const referencing = () => {
    const items = new Map<string, WorkItem>()
    for (const kind of MATERIAL_SOURCE_KINDS) for (const item of deps.workItems?.referencing(kind, [id]) ?? []) items.set(item.id, item)
    for (const item of deps.workItems?.referencing('activity_observation', [legacyObservationId]) ?? []) items.set(item.id, item)
    return [...items.values()]
  }
  const dates = () => [...new Set([date, ...referencing().flatMap(item => [localDateOf(item.start), localDateOf(item.end)])]
    .filter((value): value is string => !!value))].sort()
  const propagate = (now: number) => ({
    revoked: deps.reports.invalidateDates(dates(), reason),
    memory: mergeMemory([deps.memories.deleteSource(id, reason, now), ...(legacyObservation ? [deps.memories.deleteSource(legacyObservationId, reason, now)] : [])]),
    items: mergeItems([
      ...MATERIAL_SOURCE_KINDS.map(kind => deps.workItems?.removeSources(kind, [id], reason, now) ?? { refsRemoved: 0, evidenceRemoved: [], downgraded: [] }),
      deps.workItems?.removeSources('activity_observation', [legacyObservationId], reason, now) ?? { refsRemoved: 0, evidenceRemoved: [], downgraded: [] },
    ]),
  })
  const fixed = () => ({
    material: material ? materialMeta(material) : null,
    note: note ? { id: note.id, source: note.source, createdAt: note.createdAt, digest: materialDigest(note.content) } : null,
    noteEvents: noteEvents.map(event => event.id),
    legacyObservation: legacyObservation !== null && deps.observations?.get(legacyObservationId) !== null,
    workItems: referencing().map(item => ({ id: item.id, status: item.status, revision: item.revision, sources: item.sources.map(source => `${source.kind}:${source.ref}`) })),
    reports: dates().map(value => deps.reports.history(makeReportId('daily', value)).map(record => [record.revision, record.state, record.digest])),
  })
  const blocked = deps.reports.invalidationBlocker(dates())
  // 预览：真实传播一遍再回滚（被发布锁拦住时不模拟，直接说明原因）。
  const simulated = blocked ? null : materials.preview(() => propagate(deps.now()))
  const lines = invalidationLines(simulated?.items ?? null, simulated?.memory ?? null, simulated?.revoked ?? deps.reports.unpublishedFor(dates()))
  const kind = material?.kind ?? materialKindForSource(note!.source)
  const label = `${MATERIAL_KIND_LABEL[kind]}${material?.objectLabel ? ` · ${material.objectLabel}` : ''}（${id}）`
  const origin = material?.origin ?? 'conversation'
  const uncontrolled = [
    ...(origin === 'conversation' ? ['这段内容是在会话里粘贴或口述的：dsh 会话历史里仍有原文，本插件无法删除，需要时请在 dsh 里删除该会话'] : []),
    ...(material?.modelVisible || origin === 'conversation' ? ['正文曾交给模型服务商，服务商侧的副本无法撤回'] : []),
    '原始导出文件、截图、外部备份等本应用之外的副本无法删除',
  ]
  const impact = impactOf('material', {
    scope: { 资料: label, 日期: date, 原因: reason },
    willDelete: [
      `资料「${label}」的正文与登记信息（删除后留墓碑：备份恢复或旧记录回填时不会复活）`,
      ...(note ? [`${date} 当天记录里的同一条导入笔记原文`] : []),
      ...(noteEvents.length > 0 ? [`由这条笔记生成的事项摘要 ${noteEvents.length} 条`] : []),
      ...(legacyObservation ? [`观察库里迁移来的同一笔记（${legacyObservationId}）`] : []),
      ...lines.deleted,
    ],
    willInvalidate: lines.invalidated,
    retained: [
      '其他资料、活动记录与项目证据',
      '工作事项本身保留（失去全部来源的标为"证据已删除"，不再写入日报）',
      '已发布（归档）的日报版本与已导出文件；需要时请分别撤销版本或删除导出文件',
    ],
    uncontrolled,
    blocked,
  })
  const before = fixed()
  const unchanged = () => snapshotDigest(before) === snapshotDigest(fixed())
  return {
    ok: true,
    plan: {
      impact,
      submission: {
        subject: `material-delete:${id}`, tool: 'personal_assistant_delete_material',
        summary: '删除下列导入资料的正文与登记，并沿来源传播：引用它的工作事项断开引用（失去全部来源的标为证据已删除），派生记忆删除或退回候选，相关日期未发布日报保守撤销。已发布日报、导出文件与会话历史里的原文不在本次删除范围。',
        target: label, risk: 'high',
        snapshot: { 影响预览: previewView(impact), 固定范围: before },
        validate: unchanged,
        execute: async () => {
          if (!unchanged()) throw new Error('影响范围已变化，未删除')
          const now = deps.now()
          // 库内的传播、观察与资料本体同一事务：要么全成，要么一行不动。
          const db = materials.atomically(() => {
            const result = propagate(now)
            const legacyObservationDeleted = legacyObservation ? deps.observations!.deleteById(legacyObservationId) : false
            materials.remove(id, reason, now, note ? { content: note.content, kind } : undefined)
            return { ...result, legacyObservationDeleted }
          })
          const failures: string[] = []
          let noteRemoved = false
          let eventsRemoved = 0
          if (note && date) {
            if (!deps.tracker.enqueueDayUpdate) {
              failures.push(`${date} 当天记录里的笔记原文没能删除（跟踪器不支持改写当天记录）；资料已立墓碑，读取时会被挡住`)
            } else {
              try {
                await deps.tracker.enqueueDayUpdate(date, current => {
                  const events = current.events.filter(event => !isNoteEvent(event, note))
                  eventsRemoved = current.events.length - events.length
                  noteRemoved = current.notes.some(item => item.id === id)
                  return { ...current, notes: current.notes.filter(item => item.id !== id), events }
                })
              } catch (error) {
                failures.push(`${date} 当天记录里的笔记原文没能删除：${error instanceof Error ? error.message : String(error)}；资料已立墓碑，读取时会被挡住，可以稍后再删一次`)
              }
            }
          }
          const lines = invalidationLines(db.items, db.memory, db.revoked)
          const receipt: DeletionReceipt = {
            category: 'material', label: DELETION_CATEGORY_LABEL.material, scope: impact.scope, at: now,
            deleted: [
              `资料「${label}」的正文与登记信息，已立墓碑`,
              ...(noteRemoved ? [`${date} 当天记录里的笔记原文`] : []),
              ...(eventsRemoved > 0 ? [`由笔记生成的事项摘要 ${eventsRemoved} 条`] : []),
              ...(db.legacyObservationDeleted ? [`迁移来的同一笔记观察（${legacyObservationId}）`] : []),
              ...lines.deleted,
            ],
            invalidated: lines.invalidated,
            retained: impact.retained,
            uncontrolled,
            failures,
          }
          const receiptId = recordReceipt(deps.reports, receipt)
          return {
            deleted: true, materialId: id, receiptId, receipt,
            workItems: {
              evidenceRemoved: db.items.evidenceRemoved.map(item => ({ id: item.id, status: item.status })),
              downgradedToInferred: db.items.downgraded.map(item => ({ id: item.id, status: item.status })),
            },
            invalidatedReports: db.revoked.map(record => ({ reportId: record.reportId, revision: record.revision, state: record.state })),
          }
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// 长期记忆
// ---------------------------------------------------------------------------

export function planMemoryDeletion(deps: DeletionDeps, args: { id: string; reason?: string }): DeletionPlan {
  const now = deps.now()
  const snapshotOf = () => ({
    memories: deps.memorySnapshot(),
    selected: (args.id ? [args.id] : []).map(id => ({ id, record: deps.memories.get(id, deps.now()) })),
  })
  const before = snapshotOf()
  const target = deps.memories.get(args.id, now)
  const external = { legacyDomain: false, sampleFiles: [], exportedFiles: [], sentToProvider: true }
  const preview = target ? deps.memories.previewDelete(args.id, now) : null
  const report = preview
    ? deletionReport(preview, { ...external, legacyDomain: deps.legacyCopiesRetained && preview.deleted.some(item => item.importBatch !== null) })
    : null
  const impact = impactOf('memory', {
    scope: { 记忆: target ? memoryLabel(target) : args.id, 原因: args.reason ?? '用户要求不再记住这条' },
    willDelete: report?.deleted ?? [],
    willInvalidate: report?.invalidated ?? [],
    retained: [...(report?.retained ?? []), '活动原文、导入资料、日报版本与导出文件不受影响'],
    uncontrolled: report?.uncontrolled ?? [],
    blocked: target ? null : '记忆库里没有这条，或它已经被删过了',
  })
  return {
    impact,
    submission: {
      subject: 'memories', tool: 'personal_assistant_forget_preference',
      summary: '删除指定本机记忆并传播来源失效。不会删除活动原文或导出文件，旧存储副本可能仍保留；已发送模型服务商的提示词无法撤回。',
      target: args.id, risk: 'high',
      snapshot: { args, 影响预览: previewView(impact), memories: before, legacyCopiesRetained: deps.legacyCopiesRetained },
      validate: () => snapshotDigest(before) === snapshotDigest(snapshotOf()),
      execute: () => {
        const outcome = deps.memories.delete(args.id, args.reason ?? '用户要求不再记住这条', deps.now())
        if (outcome.deleted.length === 0) throw new Error(`记忆库里没有 ${args.id} 这条，或者它已经被删过了`)
        const result = deletionReport(outcome, {
          // 只有从旧库导入过的记忆，旧存储域里才可能还留着同一条。
          legacyDomain: deps.legacyCopiesRetained && outcome.deleted.some(item => item.importBatch !== null),
          sampleFiles: [],
          exportedFiles: [],
          // 偏好一旦注入过系统提示词就已经发给过模型。没法逐条查"注入过没有"，
          // 这里宁可多说一份追不回的副本，也不替用户猜"应该没发过吧"。
          sentToProvider: true,
        })
        const receiptId = recordReceipt(deps.reports, {
          category: 'memory', label: DELETION_CATEGORY_LABEL.memory, scope: impact.scope, at: deps.now(),
          deleted: result.deleted, invalidated: result.invalidated, retained: result.retained, uncontrolled: result.uncontrolled, failures: [],
        })
        return { removed: true, ...result, receiptId }
      },
    },
  }
}

// ---------------------------------------------------------------------------
// 日报版本与导出文件
// ---------------------------------------------------------------------------

function wasPublished(deps: DeletionDeps, record: ReportRevision): boolean {
  return record.state === 'archived' || deps.reports.jobsFor(record.reportId)
    .some(job => job.revision === record.revision && job.state === 'succeeded')
}

function fileState(file: string): { exists: false } | { exists: true; regular: boolean; digest: string | null; size: number; mtimeMs: number } {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile()) return { exists: true, regular: false, digest: null, size: stat.size, mtimeMs: stat.mtimeMs }
    return { exists: true, regular: true, digest: sha256(readFileSync(file, 'utf8')), size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return { exists: false }
  }
}

export function planReportRevocation(deps: DeletionDeps, reportId: string, revision: number, reasonInput?: string | null): PlanResult {
  const record = deps.reports.revision(reportId, revision)
  if (!record) return { ok: false, message: `找不到 ${reportId} 第 ${revision} 版` }
  const reason = reasonInput?.trim() || '用户在工作台撤销这一版'
  const running = deps.reports.jobsFor(reportId).some(job => job.state === 'running' || job.state === 'unknown')
  const blocked = record.state === 'revoked' ? '这一版已经撤销过了'
    : record.state === 'publishing' || running ? '这份日报正在发布或发布结果未知，先核对发布结果再撤销'
      : null
  const exported = record.targetPath && wasPublished(deps, record) ? fileState(record.targetPath) : { exists: false as const }
  const impact = impactOf('report_version', {
    scope: { 日报: reportId, 版本: revision, 当前状态: STATE_LABEL[record.state] ?? record.state, 原因: reason },
    willDelete: [],
    willInvalidate: [
      `${revisionLabel(record)} 改为已撤销`,
      ...(record.state === 'pending_confirmation' ? ['这一版的待批发布请求随之作废'] : []),
    ],
    retained: [
      `第 ${revision} 版的正文仍保留在历史里，可以回看`,
      ...(exported.exists ? [`已导出的文件 ${record.targetPath} 仍在磁盘上；删除它请另选"删除已导出文件"`] : []),
      '原始活动、导入资料、工作事项与长期记忆不受影响',
    ],
    uncontrolled: record.state === 'archived' ? ['已经发给别人或复制出去的日报副本无法收回'] : [],
    blocked,
  })
  const fixed = () => {
    const current = deps.reports.revision(reportId, revision)
    return current && [current.state, current.digest, current.targetPath]
  }
  const before = fixed()
  return {
    ok: true,
    plan: {
      impact,
      submission: {
        subject: `report-revoke:${reportId}:${revision}`, tool: 'personal_assistant_revoke_report_version',
        summary: '把下列日报版本的状态改为已撤销。只改状态，不删除正文与已导出文件；待批的发布请求随之作废。',
        target: `${reportId} 第 ${revision} 版`, risk: 'medium',
        snapshot: { 影响预览: previewView(impact), 固定范围: { reportId, revision, state: record.state, digest: record.digest, targetPath: record.targetPath } },
        validate: () => snapshotDigest(before) === snapshotDigest(fixed()),
        execute: () => {
          if (snapshotDigest(before) !== snapshotDigest(fixed())) throw new Error('这一版的状态已经变化，未撤销')
          deps.reports.markRevoked(reportId, revision, reason)
          const receiptId = recordReceipt(deps.reports, {
            category: 'report_version', label: DELETION_CATEGORY_LABEL.report_version, scope: impact.scope, at: deps.now(),
            deleted: [], invalidated: impact.willInvalidate, retained: impact.retained, uncontrolled: impact.uncontrolled, failures: [],
          })
          return { revoked: true, reportId, revision, receiptId }
        },
      },
    },
  }
}

export function planExportedFileDeletion(deps: DeletionDeps, reportId: string, revision: number, reasonInput?: string | null): PlanResult {
  const record = deps.reports.revision(reportId, revision)
  if (!record) return { ok: false, message: `找不到 ${reportId} 第 ${revision} 版` }
  if (!record.targetPath || !wasPublished(deps, record)) return { ok: false, message: '这一版没有发布过，没有导出文件' }
  const file = path.resolve(record.targetPath)
  const reason = reasonInput?.trim() || '用户在工作台删除导出文件'
  const state = fileState(file)
  // 同目录下这份日报留下的临时产物（发布中途失败时保留下来供核对），内容同样是日报正文。
  const temps = deps.reports.history(reportId).map(item => tempPathFor(file, item.revision)).filter(temp => fileState(temp).exists)
  const blocked = !state.exists ? `导出文件 ${file} 已不存在，没有可删除的文件`
    : !state.regular ? `导出路径 ${file} 不是普通文件（可能是链接或文件夹），为避免误删不会删除`
      : state.digest !== record.digest ? `文件 ${file} 的内容已和第 ${revision} 版不一致（可能被手动修改过），为避免误删不会删除；如需删除请手动处理`
        : null
  const impact = impactOf('exported_file', {
    scope: { 日报: reportId, 版本: revision, 文件: file, 原因: reason },
    willDelete: [
      `导出文件 ${file}${state.exists ? `（${state.size} 字节）` : ''}`,
      ...temps.map(temp => `同一日报留下的临时文件 ${temp}`),
    ],
    willInvalidate: [],
    retained: [
      `库里第 ${revision} 版的正文与状态不变（撤销状态请另选"撤销日报版本"）`,
      '其他版本、原始活动、导入资料、工作事项与长期记忆不受影响',
    ],
    uncontrolled: [
      '这份文件被复制、同步到网盘、发给他人或被备份软件收走的副本无法删除',
      '文件系统或固态硬盘可能保留可恢复的残留，删除不保证物理擦除',
    ],
    blocked,
  })
  const fixed = () => ({ file: fileState(file), temps: temps.map(temp => [temp, fileState(temp)]) })
  const before = fixed()
  const remove = deps.unlinkFile ?? (async (target: string) => { await unlink(target) })
  return {
    ok: true,
    plan: {
      impact,
      submission: {
        subject: `export-delete:${file}`, tool: 'personal_assistant_delete_exported_report',
        summary: '删除下列已导出的日报文件。只删除内容仍与这一版一致的那个文件；库里的版本与状态不变。被复制或同步出去的副本无法删除。',
        target: file, risk: 'high',
        snapshot: { 影响预览: previewView(impact), 固定范围: { reportId, revision, digest: record.digest, ...before } },
        validate: () => snapshotDigest(before) === snapshotDigest(fixed()),
        execute: async () => {
          const now = fileState(file)
          if (!now.exists || !now.regular || now.digest !== record.digest) throw new Error('文件在批准前后发生了变化，未删除')
          const deleted: string[] = []
          const failures: string[] = []
          for (const target of [file, ...temps]) {
            try {
              await remove(target)
            } catch (error) {
              failures.push(`${target} 删除失败：${error instanceof Error ? error.message : String(error)}`)
            }
            // 以磁盘上的实际结果为准，不以调用是否报错为准。
            if (fileState(target).exists) {
              if (!failures.some(line => line.startsWith(target))) failures.push(`${target} 删除后仍然存在`)
            } else {
              deleted.push(target === file ? `导出文件 ${target}` : `临时文件 ${target}`)
            }
          }
          if (!fileState(file).exists) deps.reports.recordExportDeletion(reportId, revision, file, record.digest, reason, deps.now())
          const receiptId = recordReceipt(deps.reports, {
            category: 'exported_file', label: DELETION_CATEGORY_LABEL.exported_file, scope: impact.scope, at: deps.now(),
            deleted, invalidated: [], retained: impact.retained, uncontrolled: impact.uncontrolled, failures,
          })
          return { deleted: failures.length === 0, file, failures, receiptId }
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// 草稿条目
// ---------------------------------------------------------------------------

/**
 * 删除草稿里的一条：不需要可信审批——它生成新版本，旧版本原样留在历史里，没有任何数据被销毁；
 * 发布仍要经可信审批。预览照样把影响与保留项摆出来，由工作台内确认。
 */
export function planDraftEntryDeletion(deps: DeletionDeps, input: { reportId: string; revision: number; digest: string; line: number; expectedText: string }): PlanResult {
  const current = deps.reports.current(input.reportId)
  if (!current) return { ok: false, message: '还没有草稿' }
  const lines = parseReportLines(current.content)
  const target = lines[input.line]
  const stale = current.revision !== input.revision || current.digest !== input.digest
  const blocked = stale ? `草稿已经是第 ${current.revision} 版，请刷新后再删`
    : current.state === 'revoked' ? '这一版已撤销，不能在它上面修改'
      : !target || target.kind !== 'entry' || target.text !== String(input.expectedText ?? '').trim() ? '这一条已经变了或不存在，请刷新后再删'
        : null
  const ordinal = lines.filter(line => line.kind === 'entry' && line.index < input.line).length + 1
  const impact = impactOf('draft_entry', {
    scope: { 日报: input.reportId, 版本: input.revision, 条目: ordinal, 原文: target?.text ?? null },
    willDelete: [`第 ${input.revision} 版里的第 ${ordinal} 条「${target?.text ?? ''}」（删除后生成第 ${current.revision + 1} 版）`],
    willInvalidate: current.state === 'pending_confirmation' ? [`第 ${current.revision} 版的待批发布请求随之作废，需要重新请求发布`] : [],
    retained: ['原始活动、导入资料、工作事项和长期记忆都不受影响', `第 ${input.revision} 版仍保留在历史里，可以回看`],
    uncontrolled: current.state === 'archived' ? ['已导出的文件不会改变；需要时请单独删除导出文件'] : [],
    blocked,
  })
  return { ok: true, plan: { impact, submission: null } }
}
