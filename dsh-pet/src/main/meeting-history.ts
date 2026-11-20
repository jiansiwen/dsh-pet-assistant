/**
 * 历史会议列表的**纯逻辑**：把库里的会议行映射成工作台要的那几列。
 *
 * 为什么单独成文件：这段逻辑要在单测里逐条钉死（四种转写状态、limit 夹取、字段形状），
 * 而 `index.ts` 是主进程入口，测试里只能整份加载、没法只测一个函数。抽出来之后
 * "映射规则"和"IPC 接线"各归各的，改映射不会牵动分派表。
 *
 * 纪律：**只读**。不打开音频、不解密名称、不碰会议状态；输入就是 `listMeetings()` 的返回。
 */

export type TranscriptStatus = '转写失败' | '未转写' | '已转写' | '部分转写' | '状态未知'

/** 允许的最小/最大条数：工作台一屏放不下更多，也给 IPC 一个上界。 */
export const HISTORY_MIN_LIMIT = 1
export const HISTORY_MAX_LIMIT = 50
export const HISTORY_DEFAULT_LIMIT = 20

interface IntegrityTrackLike {
  readonly persisted?: number | null
}

export interface IntegrityLike {
  readonly status?: string
  readonly tracks?: Readonly<Record<string, IntegrityTrackLike | undefined>>
}

/**
 * 转写状态：五个词，从既有字段推导，**不新增字段**。
 *
 * 判序（就是下面代码里的实际顺序，改顺序会改变结果）：
 * 1. `state === 'transcript-failed'` → `转写失败`。**放在最前**，因为整场 ASR 全失败是
 *    一个独立事实：此时 integrity 往往还是 complete、音频也确实落了盘，若按四态判会落到
 *    `已转写` —— 用户点进去发现纪要是空的，那一刻这张表上的任何状态都不可信了。
 *    这一态**不看 persisted**：失败与否不因"有没有落盘"而改变。
 * 2. `persisted` 各轨合计为 0 → `未转写`：这块根本没录到音频，不可能有转写结果；
 * 3. `integrity === 'complete'` 且 persisted > 0 → `已转写`；
 * 4. `integrity === 'incomplete'` → `部分转写`（有缺口，转写只覆盖了一部分）；
 * 5. 其余（`unknown`，或旧记录 `integrity === null` 没有停录证据）→ `状态未知`。
 *
 * 为什么第 2 步在完整性判断之前：一条 integrity=complete 但一块音频都没落盘的记录
 * （例如刚开始就停掉），说"已转写"是错的 —— 它连可转的内容都没有。
 */
export function transcriptStatusOf(
  integrity: IntegrityLike | null | undefined,
  state?: string | null,
): TranscriptStatus {
  if (state === 'transcript-failed') return '转写失败'
  const persisted = persistedCountOf(integrity)
  if (persisted === 0) return '未转写'
  const status = integrity?.status
  if (status === 'complete') return '已转写'
  if (status === 'incomplete') return '部分转写'
  return '状态未知'
}

function persistedCountOf(integrity: IntegrityLike | null | undefined): number {
  const tracks = integrity?.tracks
  if (tracks === undefined || tracks === null) return 0
  let total = 0
  for (const track of Object.values(tracks)) {
    const value = track?.persisted
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) total += value
  }
  return total
}

/** 一条历史会议对外的形状（字段名就是 IPC 回包里的字段名）。 */
export interface MeetingHistoryRow {
  readonly id: string
  readonly name: string
  readonly startedAt: number
  readonly endedAt: number | null
  readonly sources: string
  readonly retentionDays: number
  readonly integrityStatus: string
  readonly transcriptStatus: TranscriptStatus
}

/** 库里的会议行里，这段逻辑真正用到的那几个字段。 */
export interface MeetingRowLike {
  readonly id: string
  readonly name: string
  readonly startedAt: number
  readonly endedAt: number | null
  readonly sources: string
  readonly retentionDays: number
  /** 会议状态；只有 `transcript-failed` 参与判定（见 transcriptStatusOf）。 */
  readonly state?: string | null
  readonly integrity?: IntegrityLike | null
}

/** limit 夹到 1–50，非数字/NaN 一律回缺省 20（不做"猜用户想要多少"）。 */
export function clampHistoryLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return HISTORY_DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(raw), HISTORY_MIN_LIMIT), HISTORY_MAX_LIMIT)
}

/** 映射成回包行。输入已按调用方给的顺序（库按 startedAt 倒序），这里只截断、不重排。 */
export function meetingHistoryRows(meetings: readonly MeetingRowLike[], limit: unknown): MeetingHistoryRow[] {
  return meetings.slice(0, clampHistoryLimit(limit)).map(meeting => ({
    id: meeting.id,
    name: meeting.name,
    startedAt: meeting.startedAt,
    endedAt: meeting.endedAt,
    sources: meeting.sources,
    retentionDays: meeting.retentionDays,
    integrityStatus: meeting.integrity?.status ?? 'unknown',
    transcriptStatus: transcriptStatusOf(meeting.integrity, meeting.state),
  }))
}
