/**
 * 概览四格怎么显示：把命令回执的**一句话**翻译成"值区显示什么"。
 *
 * 后端给的约束是硬的：**`text` 原样显示，不要自己算数字**。所以这里做的不是解析，而是
 * "能不能从这句话里挑出一个可以放大的片段"：
 *
 * - 挑得到（`待办 3 项…`、`今天 4 小时 20 分…`）→ 值区放大数字，下面 11.5px 灰字放**原句**；
 * - 挑不到（`没有待办`、`暂时读不到今天的活动`）→ 值区直接放原句，不做假数字。
 *
 * 一条不能越的线：`暂时读不到` 不是 0。会议那格当前恒为读不到，显示成 0 就是编数据。
 */

export type OverviewCommand = 'todo' | 'meeting' | 'summary'

export type OverviewKind =
  /** 有可放大的片段：`value` 是数字或时长短语，`detail` 是原句。 */
  | 'metric'
  /** 没有可放大的片段：`value` 就是原句本身。 */
  | 'plain'
  /** 明确读不到：灰显，且**绝不能**显示成 0。 */
  | 'unavailable'

export interface OverviewReadout {
  readonly value: string
  /** 值区下方的小字（原句）。`null` 表示 value 已经是整句话，不需要重复一遍。 */
  readonly detail: string | null
  readonly kind: OverviewKind
}

const UNAVAILABLE_PREFIX = '暂时读不到'

/**
 * 三类命令各自的"可放大片段"。
 *
 * 待办：`待办 3 项（1 项待你处理）` → `3`
 * 会议：`今天 1 场` → `1`（当前恒为读不到，正则留着是为了后端接上数据源后立刻能用）
 * 活动：`今天 4 小时 20 分，主要在 dsh-pet` → `4 小时 20 分`
 *
 * 活动那条刻意把「分」一起收进捕获组：只取到「4 小时」会丢精度，而用户要看的正是这段时长。
 */
const PATTERNS: Record<OverviewCommand, RegExp> = {
  todo: /待办\s*(\d+)/u,
  meeting: /今天\s*(\d+)\s*场/u,
  summary: /今天\s*(\d+\s*小时(?:\s*\d+\s*分)?)/u,
}

/**
 * 回执文本 → 显示口径。空文本也按"读不到"处理：拿不到话本身就是读不到。
 */
export function overviewValue(command: OverviewCommand, text: string): OverviewReadout {
  const sentence = text.trim()
  if (sentence === '') return { value: '暂时读不到', detail: null, kind: 'unavailable' }
  if (sentence.startsWith(UNAVAILABLE_PREFIX)) return { value: sentence, detail: null, kind: 'unavailable' }

  const matched = PATTERNS[command].exec(sentence)
  if (matched === null) return { value: sentence, detail: null, kind: 'plain' }

  // 只做 trim 与空白折叠，不改数字：`4 小时 20 分` 原样搬过来，不做任何单位换算。
  const value = matched[1].replace(/\s+/gu, ' ').trim()
  return { value, detail: sentence, kind: 'metric' }
}
