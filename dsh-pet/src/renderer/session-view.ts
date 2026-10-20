import type { SessionEntry, SessionSnapshot, SessionUpdate } from '../session-types.js'

export function mergeEntries(previous: SessionEntry[], incoming: SessionEntry[]): SessionEntry[] {
  const entries = new Map(previous.map(entry => [entry.id, entry]))
  for (const entry of incoming) entries.set(entry.id, entry)
  return [...entries.values()].sort((a, b) => a.seq - b.seq)
}

export function mergeSession(previous: SessionSnapshot | null, update: SessionUpdate): SessionSnapshot {
  if (!previous || previous.bindingId !== update.bindingId || update.reset) return update
  if (update.cursor < previous.cursor) return previous
  return {
    ...update,
    entries: mergeEntries(previous.entries, update.entries),
    hasMore: previous.hasMore,
    beforeSeq: previous.beforeSeq,
  }
}

export function overlayPosition(x: number, y: number, width: number, height: number, petWidth: number) {
  return { x: x + petWidth / 2 - width / 2, y: y - height - 8 }
}

/**
 * 演示隐私模式下的可见条目（M5-05）。
 *
 * `cutoff` 是"开启演示模式那一刻已存在条目的最大 seq"；`null` 表示不隐藏。
 * 只隐藏 `seq <= cutoff` 的，之后新产生的照常显示 —— 用户演示的正是这些新内容。
 *
 * 用 `seq` 而不是数组下标：往上翻历史会在数组**前面**插入条目（`mergeEntries` 按 seq 排序），
 * 按下标分界会让"藏起来"的旧消息随着翻页一条条重新露出来。
 *
 * 这里只决定**渲染哪些**，不删任何数据：关掉演示模式后同一个数组原样全部可见。
 */
export function entriesForPresentation(
  entries: readonly SessionEntry[],
  cutoff: number | null,
): { visible: SessionEntry[]; hidden: number } {
  if (cutoff === null) return { visible: [...entries], hidden: 0 }
  const visible = entries.filter(entry => entry.seq > cutoff)
  return { visible, hidden: entries.length - visible.length }
}

/**
 * 开启演示模式时要记下的分界值：当前已存在条目的最大 seq，空历史时为 null（没得藏）。
 */
export function presentationCutoffOf(entries: readonly SessionEntry[]): number | null {
  if (entries.length === 0) return null
  let max = entries[0].seq
  for (const entry of entries) if (entry.seq > max) max = entry.seq
  return max
}
