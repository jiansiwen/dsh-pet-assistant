/**
 * 观察记录：外部世界发生过什么，以及它是从哪儿看到的。
 *
 * 和记忆分开存是有意的。记忆是**结论**（"用户不喜欢日报里出现午休"），
 * 观察是**依据**（"9:00-9:40 前台是 Excel，标题 xxx.xlsx"）。混在一张表里的话，
 * 删除传播就没法表达"结论的依据没了"这件事——design.md §9.2 把 observations
 * 和 memories/memory_sources 分成三张表就是这个理由。
 *
 * 原始采样是每 5 秒一行，一天一万七千条，直接灌进库里既没用也撑不住。
 * 这里存的是聚合后的活动片段（tracker.buildSpans 的产物），原始 JSONL 留在磁盘上，
 * 库里只记它的路径作为 payloadRef。
 */
import type { DatabaseSync } from 'node:sqlite'
import { inTransaction, text, type Row } from './store.ts'

/** 观察来源。认不出来的来源不许写，见 {@link validateObservation}。 */
export const OBSERVATION_SOURCES = [
  /** 采样日志聚合出来的前台活动片段。 */
  'activity_span',
  /** 旧存储域里的语义事项（迁移导入）。 */
  'legacy_day_event',
  /** 用户自己粘贴/导入的原始记录。 */
  'user_note',
] as const
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number]

export interface Observation {
  id: string
  source: ObservationSource
  /** 归属范围；迁移进来的旧数据没有项目维度，一律落"旧全局范围"。 */
  scopeKind: 'global' | 'project'
  scopeId: string
  startAt: number
  endAt: number
  /** 事件发生时的时区名。日报按用户指定时区归属日期，跨午夜时要靠它切分。 */
  timezone: string
  summary: string
  /** 原始落点（JSONL 路径、旧域表名等）。删除报告要靠它说清"原文还在不在"。 */
  payloadRef: string | null
  sensitivity: 'normal' | 'sensitive'
  /** 旧系统里的事项 id，迁移时原样保留，方便回头对账。 */
  legacyId: string | null
  importBatch: string | null
}

/**
 * 时间与敏感级别准入。
 *
 * 结束早于开始、或者时间根本不是有限数的，一律拒——这种行进了库之后，
 * 按日期范围查询会静默漏掉它，比当场报错难查得多。
 * sensitive 同记忆：加密没落地之前不收。
 */
export function validateObservation(input: {
  source: string
  startAt: number
  endAt: number
  sensitivity?: string | null
}): 'unknown_source' | 'bad_range' | 'sensitive_without_encryption' | null {
  const sources: readonly string[] = OBSERVATION_SOURCES
  if (!sources.includes(input.source)) return 'unknown_source'
  if (!Number.isFinite(input.startAt) || !Number.isFinite(input.endAt)) return 'bad_range'
  if (input.endAt < input.startAt) return 'bad_range'
  if ((input.sensitivity ?? 'normal') === 'sensitive') return 'sensitive_without_encryption'
  return null
}

export class ObservationStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        observation_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL DEFAULT '',
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL,
        timezone TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        payload_ref TEXT,
        sensitivity TEXT NOT NULL DEFAULT 'normal',
        legacy_id TEXT,
        import_batch TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_observations_range ON observations (start_at, end_at);
      CREATE INDEX IF NOT EXISTS idx_observations_source ON observations (source, start_at);
    `)
  }

  /**
   * 写入一条观察。id 由调用方给：迁移要用旧 id 派生出稳定 id，
   * 重复导入靠主键冲突自然幂等（返回 false），不需要额外查一遍。
   */
  put(observation: Observation): boolean {
    const rejection = validateObservation(observation)
    if (rejection) throw new Error(`observation rejected: ${rejection}`)
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO observations
           (observation_id, source, scope_kind, scope_id, start_at, end_at, timezone,
            summary, payload_ref, sensitivity, legacy_id, import_batch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        observation.id,
        observation.source,
        observation.scopeKind,
        observation.scopeId,
        observation.startAt,
        observation.endAt,
        observation.timezone,
        observation.summary,
        text(observation.payloadRef),
        observation.sensitivity,
        text(observation.legacyId),
        text(observation.importBatch),
      )
    return Number(result.changes) > 0
  }

  /** 一批写在一个事务里：中途出错整批回滚，不留半天的活动。 */
  putBatch(observations: Observation[]): number {
    return inTransaction(this.db, () => {
      let imported = 0
      for (const observation of observations) if (this.put(observation)) imported += 1
      return imported
    })
  }

  /** 时间区间内的观察，按开始时间升序。区间是闭开区间 [from, to)。 */
  listInRange(from: number, to: number): Observation[] {
    const rows = this.db
      .prepare('SELECT * FROM observations WHERE start_at >= ? AND start_at < ? ORDER BY start_at')
      .all(from, to) as Row[]
    return rows.map(rowToObservation)
  }

  /** 某个来源在某个区间里已经导入过没有——迁移时用来判断能不能跳过整天。 */
  hasInRange(source: ObservationSource, from: number, to: number): boolean {
    const row = this.db
      .prepare('SELECT 1 AS hit FROM observations WHERE source = ? AND start_at >= ? AND start_at < ? LIMIT 1')
      .get(source, from, to) as Row | undefined
    return row !== undefined
  }

  /** 删除某来源某区间的全部观察，返回删掉的行数。保留期清理用。 */
  deleteRange(source: ObservationSource, before: number): number {
    const result = this.db
      .prepare('DELETE FROM observations WHERE source = ? AND end_at < ?')
      .run(source, before)
    return Number(result.changes)
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM observations').get() as Row
    return Number(row.n)
  }
}

function rowToObservation(row: Row): Observation {
  return {
    id: String(row.observation_id),
    source: String(row.source) as ObservationSource,
    scopeKind: String(row.scope_kind) as 'global' | 'project',
    scopeId: String(row.scope_id ?? ''),
    startAt: Number(row.start_at),
    endAt: Number(row.end_at),
    timezone: String(row.timezone),
    summary: String(row.summary ?? ''),
    payloadRef: text(row.payload_ref),
    sensitivity: String(row.sensitivity ?? 'normal') as 'normal' | 'sensitive',
    legacyId: text(row.legacy_id),
    importBatch: text(row.import_batch),
  }
}
