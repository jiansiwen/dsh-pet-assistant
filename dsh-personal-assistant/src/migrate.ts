/**
 * 旧数据迁移：把 personal_assistant 存储域（版本 0）和采样 JSONL 只读导入新库。
 *
 * 三条硬约束来自 design.md §9.3，违反任何一条都会让用户的数据变得说不清：
 *
 * 1. **旧域不原地升级**。版本 0 就是版本 0，不改 schema、不只把版本号改大。
 *    这里对旧域只有读，没有写；默认也不为了迁移去删旧数据——留着旧副本，
 *    用户才有回头路，代价是"源信息已彻底删除"这句话从此不能说（§9.4 要求明说）。
 * 2. **保留旧 id、时间和来源，不凭空补证据**。旧偏好没有项目维度，就落"旧全局范围"
 *    并标上导入批次；不给它编一个 topic，也不猜它属于哪个项目。
 * 3. **迁移失败不启动采集和自动执行**。返回值里的 complete 就是给调用方看的开关，
 *    半迁移状态下继续采样，会把新旧两套记录搅在一起，之后再也分不清哪条是哪来的。
 *
 * 幂等靠两层：批次层按 (batch_id, source_digest) 判断整批要不要重跑，
 * 行层靠主键冲突（旧 id 派生出稳定新 id）。所以中途崩掉重跑不会插出重复事项。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ActivitySpan, Note, SemanticEvent } from './domain.ts'
import { MemoryStore, type MemoryRecord } from './memory.ts'
import { ObservationStore, type Observation } from './observation.ts'
import { ReportStore, makeReportId } from './report.ts'
import { inTransaction, sha256, type Row } from './store.ts'

/** 迁移要读的旧数据。做成接口是为了让测试能喂夹具，不需要真的开一个存储域。 */
export interface LegacySource {
  /** 旧 preferences 表全量。 */
  preferences(): Array<{ id: string; text: string; createdAt: number }>
  /** 旧 days 表全量（含语义事项与用户导入的原始记录）。 */
  days(): Array<{ date: string; events: SemanticEvent[]; notes: Note[] }>
  /** 旧 reports 表全量。 */
  reports(): Array<{ date: string; draft?: string; filePath?: string; confirmedAt?: number }>
  /** 读一份已归档日报的正文；读不出来返回 null（文件被用户挪走/删掉都算）。 */
  readReportFile(filePath: string): string | null
  /** 某天聚合后的活动片段；只应包含已经收尾的日期。 */
  spans(date: string): ActivitySpan[]
  /** 有采样原文的日期列表，升序。 */
  sampleDates(): string[]
  /** 采样原文路径，用来当 observation 的 payloadRef。 */
  sampleFileOf(date: string): string
}

export interface MigrationOptions {
  /** 只导入这个日期之后（含）的活动；留空表示不设下限。YYYY-MM-DD。 */
  fromDate?: string | null
  /** 不导入这个日期之后（含）的活动。当天还在采样，片段没定型，导进来也对不上。 */
  toDate?: string | null
  timezone: string
}

export interface BatchOutcome {
  id: string
  /** succeeded=这次真跑了；skipped=之前已经跑过同样的内容；failed=这批没成。 */
  state: 'succeeded' | 'skipped' | 'failed'
  imported: number
  skippedRows: number
  message: string
}

export interface MigrationReport {
  batches: BatchOutcome[]
  /** 全部批次都成功或已跳过才为真。为假时调用方必须不启动采集与自动执行。 */
  complete: boolean
  failures: string[]
}

/** 旧 id → 新 id。带前缀是为了在库里一眼看出这条是搬过来的，不是本系统观察到的。 */
export const legacyMemoryId = (legacyId: string): string => `legacy-pref:${legacyId}`
export const legacyEventId = (legacyId: string): string => `legacy-event:${legacyId}`
export const legacyNoteId = (legacyId: string): string => `legacy-note:${legacyId}`
/**
 * 活动片段本来没有 id，用「日期 + 开始时间 + 进程名」拼一个稳定的。
 *
 * 不用序号：同一天重跑时片段可能因为采样文件又长了几行而重新合并，序号会整体错位，
 * 于是重复导入变成"删掉旧的插一批新的"，幂等就没了。开始时间和进程名在片段定型后不会变。
 */
export const legacySpanId = (date: string, span: ActivitySpan): string =>
  `legacy-span:${date}:${span.start}:${span.app || 'idle'}`

export class MigrationStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        batch_id TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        target_version INTEGER NOT NULL,
        state TEXT NOT NULL,
        imported INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        PRIMARY KEY (batch_id, source_digest)
      );
    `)
  }

  /** 这批（这个内容摘要）之前成功过没有。 */
  alreadyDone(batchId: string, sourceDigest: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS hit FROM migrations WHERE batch_id = ? AND source_digest = ? AND state = 'succeeded'`)
      .get(batchId, sourceDigest) as Row | undefined
    return row !== undefined
  }

  record(
    batchId: string,
    sourceDigest: string,
    targetVersion: number,
    state: 'succeeded' | 'failed',
    imported: number,
    skipped: number,
    detail: string,
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO migrations (batch_id, source_digest, target_version, state, imported, skipped, detail, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(batch_id, source_digest) DO UPDATE SET
           state = excluded.state,
           imported = excluded.imported,
           skipped = excluded.skipped,
           detail = excluded.detail,
           finished_at = excluded.finished_at`,
      )
      .run(batchId, sourceDigest, targetVersion, state, imported, skipped, detail, now, now)
  }

  history(): Array<{ batchId: string; state: string; imported: number; detail: string }> {
    const rows = this.db
      .prepare('SELECT * FROM migrations ORDER BY started_at')
      .all() as Row[]
    return rows.map(row => ({
      batchId: String(row.batch_id),
      state: String(row.state),
      imported: Number(row.imported),
      detail: String(row.detail ?? ''),
    }))
  }
}

export interface MigrationDeps {
  /** 事务要拿裸连接：记忆、观察、日报三张表共用一个库，一批导入必须落在同一个事务里。 */
  db: DatabaseSync
  memories: MemoryStore
  observations: ObservationStore
  reports: ReportStore
  migrations: MigrationStore
  source: LegacySource
  /** 新库 schema 版本，记进迁移批次里，方便日后判断这批是哪个形状下导入的。 */
  targetVersion: number
  /** 本次迁移的标识，写进每条导入记录的 importBatch，用来回答"这条是哪一次搬过来的"。 */
  runId: string
  now(): number
}

interface BatchBodyResult {
  imported: number
  skipped: number
  detail: string
}

type BatchBody = (deps: MigrationDeps, options: MigrationOptions) => BatchBodyResult

/**
 * 跑一遍迁移。可以重复调用：已经成功的批次按内容摘要跳过，没跑完的从断点继续。
 *
 * 每个批次自己一个事务。不整个迁移一个大事务，是因为大事务下"断点恢复"根本不存在——
 * 要么全成要么全无，用户第二次点开还是从零开始等。分批之后，崩在第三批，
 * 重跑时前两批直接跳过，只补剩下的。
 */
export function runMigration(deps: MigrationDeps, options: MigrationOptions): MigrationReport {
  const batches: BatchOutcome[] = []
  batches.push(runBatch(deps, 'legacy-preferences', options, importPreferences))
  batches.push(runBatch(deps, 'legacy-days', options, importDays))
  batches.push(runBatch(deps, 'legacy-reports', options, importReports))
  batches.push(runBatch(deps, 'legacy-spans', options, importSpans))

  const failures = batches.filter(batch => batch.state === 'failed').map(batch => `${batch.id}：${batch.message}`)
  return { batches, complete: failures.length === 0, failures }
}

function runBatch(
  deps: MigrationDeps,
  batchId: string,
  options: MigrationOptions,
  body: BatchBody,
): BatchOutcome {
  const now = deps.now()
  let digest: string
  try {
    digest = digestOf(batchId, deps.source, options)
  } catch (error) {
    const message = describe(error)
    deps.migrations.record(batchId, 'unreadable', deps.targetVersion, 'failed', 0, 0, message, now)
    return { id: batchId, state: 'failed', imported: 0, skippedRows: 0, message: `读旧数据失败：${message}` }
  }

  if (deps.migrations.alreadyDone(batchId, digest)) {
    return { id: batchId, state: 'skipped', imported: 0, skippedRows: 0, message: '同样内容之前已经导入过' }
  }

  try {
    const outcome = inTransaction(deps.db, () => body(deps, options))
    deps.migrations.record(batchId, digest, deps.targetVersion, 'succeeded', outcome.imported, outcome.skipped, outcome.detail, now)
    return { id: batchId, state: 'succeeded', imported: outcome.imported, skippedRows: outcome.skipped, message: outcome.detail }
  } catch (error) {
    const message = describe(error)
    // 记账不能在失败的那个事务里做，否则跟着一起回滚，重跑时就查不到"这批失败过"。
    deps.migrations.record(batchId, digest, deps.targetVersion, 'failed', 0, 0, message, now)
    return { id: batchId, state: 'failed', imported: 0, skippedRows: 0, message }
  }
}

/** 批次内容摘要。旧数据没变、导入范围也没变，摘要就不变，整批可以跳过。 */
function digestOf(batchId: string, source: LegacySource, options: MigrationOptions): string {
  const payload: { batchId: string; fromDate: string | null; toDate: string | null; timezone: string } = {
    batchId,
    fromDate: options.fromDate ?? null,
    toDate: options.toDate ?? null,
    timezone: options.timezone,
  }
  switch (batchId) {
    case 'legacy-preferences':
      // 偏好全量导入，不受活动日期范围或时区影响；跨日启动不能让旧偏好重跑。
      return sha256(JSON.stringify({ batchId, rows: source.preferences() }))
    case 'legacy-days':
      return sha256(JSON.stringify({ ...payload, rows: source.days() }))
    case 'legacy-reports':
      return sha256(JSON.stringify({ ...payload, rows: source.reports() }))
    case 'legacy-spans':
      return sha256(JSON.stringify({ ...payload, dates: source.sampleDates().filter(date => inRange(date, options)) }))
    default:
      return sha256(JSON.stringify(payload))
  }
}

function inRange(date: string, options: MigrationOptions): boolean {
  if (options.fromDate && date < options.fromDate) return false
  if (options.toDate && date >= options.toDate) return false
  return true
}

/**
 * 旧偏好 → 记忆。
 *
 * 全部落"旧全局范围"（scope=global，id 空）并标上导入批次：旧系统本来就没有项目维度，
 * 替它挑一个项目就是编造。status 保持 confirmed——这些是用户当时明确说过的偏好，
 * 降级成候选等于升级后助理把用户教过的东西全忘了，那比标清来源更糟。
 */
function importPreferences(deps: MigrationDeps): BatchBodyResult {
  const rows = deps.source.preferences()
  let imported = 0
  let skipped = 0
  for (const row of rows) {
    if (!row.id || !row.text?.trim()) {
      skipped += 1
      continue
    }
    const record: MemoryRecord = {
      id: legacyMemoryId(row.id),
      kind: 'user_preference',
      scope: { kind: 'global', id: '' },
      topic: '',
      text: row.text.trim(),
      sourceRefs: [],
      status: 'confirmed',
      sensitivity: 'normal',
      createdBy: 'migration',
      confirmedBy: 'migration',
      revision: 1,
      createdAt: Number.isFinite(row.createdAt) ? row.createdAt : deps.now(),
      updatedAt: deps.now(),
      expiresAt: null,
      importBatch: deps.runId,
    }
    if (deps.memories.importRecord(record)) imported += 1
    else skipped += 1
  }
  return { imported, skipped, detail: `旧偏好 ${rows.length} 条，新导入 ${imported} 条，已存在、已删除或无效 ${skipped} 条` }
}

/** 旧语义事项与用户笔记 → 观察记录，保留旧 id、时间和来源。 */
function importDays(deps: MigrationDeps, options: MigrationOptions): BatchBodyResult {
  const days = deps.source.days().filter(day => inRange(day.date, options))
  const observations: Observation[] = []
  let invalid = 0
  for (const day of days) {
    for (const event of day.events) {
      if (!event.id || !Number.isFinite(event.start) || !Number.isFinite(event.end)) {
        invalid += 1
        continue
      }
      observations.push({
        id: legacyEventId(event.id),
        source: 'legacy_day_event',
        scopeKind: 'global',
        scopeId: '',
        startAt: event.start,
        endAt: event.end,
        timezone: options.timezone,
        summary: event.summary,
        // 只记来源位置，不把旧结论重新加工一遍：旧系统标了 medium 的推断，
        // 导入之后仍然是推断，置信度不由迁移来提。
        payloadRef: `personal_assistant.days[${day.date}]`,
        sensitivity: 'normal',
        legacyId: event.id,
        importBatch: deps.runId,
      })
    }
    for (const note of day.notes) {
      if (!note.id) {
        invalid += 1
        continue
      }
      const createdAt = Number.isFinite(note.createdAt) ? note.createdAt : deps.now()
      observations.push({
        id: legacyNoteId(note.id),
        source: 'user_note',
        scopeKind: 'global',
        scopeId: '',
        startAt: createdAt,
        endAt: createdAt,
        timezone: options.timezone,
        // 笔记正文可能很长也很私密，库里只留来源标记，不复制全文。
        summary: note.source,
        payloadRef: `personal_assistant.days[${day.date}].notes`,
        sensitivity: 'normal',
        legacyId: note.id,
        importBatch: deps.runId,
      })
    }
  }
  const imported = deps.observations.putBatch(observations)
  const skipped = invalid + (observations.length - imported)
  return {
    imported,
    skipped,
    detail: `${days.length} 天的旧记录，新导入 ${imported} 条，已存在或无效 ${skipped} 条`,
  }
}

/**
 * 旧日报 → 归档版本。
 *
 * 原文件一个字都不改（§9.3）。定稿过的登记成 archived，只有草稿的登记成 draft，
 * 文件读不出来的跳过并在明细里点名——用户需要知道哪几天的日报没搬过来，
 * 而不是看到一个"迁移成功"。
 */
function importReports(deps: MigrationDeps, options: MigrationOptions): BatchBodyResult {
  const rows = deps.source.reports().filter(row => inRange(row.date, options))
  let imported = 0
  let skipped = 0
  const missing: string[] = []
  for (const row of rows) {
    const reportId = makeReportId('daily', row.date)
    const filePath = row.filePath
    const confirmedAt = row.confirmedAt
    if (filePath && typeof confirmedAt === 'number') {
      const content = deps.source.readReportFile(filePath)
      if (content === null) {
        skipped += 1
        missing.push(row.date)
        continue
      }
      if (deps.reports.importArchived(reportId, content, filePath, confirmedAt)) imported += 1
      else skipped += 1
      continue
    }
    if (row.draft && !deps.reports.current(reportId)) {
      deps.reports.saveDraft(reportId, row.draft, deps.now())
      imported += 1
      continue
    }
    skipped += 1
  }
  const detail = missing.length > 0
    ? `旧日报 ${rows.length} 份，导入 ${imported} 份，跳过 ${skipped} 份；这些日期的定稿文件读不出来，需要人工确认：${missing.join('、')}`
    : `旧日报 ${rows.length} 份，导入 ${imported} 份，跳过 ${skipped} 份`
  return { imported, skipped, detail }
}

/**
 * 采样原文 → 活动片段观察。
 *
 * 只导已收尾的日期：当天的文件还在长，片段随时会因为新采样而重新合并，
 * 今天导一次明天导一次会得到两套对不上的 id。toDate 由调用方按"今天"传进来。
 */
function importSpans(deps: MigrationDeps, options: MigrationOptions): BatchBodyResult {
  const dates = deps.source.sampleDates().filter(date => inRange(date, options))
  let imported = 0
  let skipped = 0
  for (const date of dates) {
    const payloadRef = deps.source.sampleFileOf(date)
    const observations: Observation[] = []
    for (const span of deps.source.spans(date)) {
      observations.push({
        id: legacySpanId(date, span),
        source: 'activity_span',
        scopeKind: 'global',
        scopeId: '',
        startAt: span.start,
        endAt: span.end,
        timezone: options.timezone,
        summary: span.title ? `${span.app}｜${span.category}｜${span.title}` : `${span.category}`,
        payloadRef,
        sensitivity: 'normal',
        legacyId: null,
        importBatch: deps.runId,
      })
    }
    const added = deps.observations.putBatch(observations)
    imported += added
    skipped += observations.length - added
  }
  return { imported, skipped, detail: `${dates.length} 天采样原文，导入活动片段 ${imported} 条，已存在 ${skipped} 条` }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
