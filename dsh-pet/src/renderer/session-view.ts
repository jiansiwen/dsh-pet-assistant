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

/** 会话框停靠方式：top = 固定头顶；auto = 按屏幕剩余空间在上/下/左/右里选。 */
export type ChatDock = 'top' | 'auto'

export interface OverlaySize {
  width: number
  height: number
}

export interface OverlayViewport {
  width: number
  height: number
}

const OVERLAY_GAP = 8
const OVERLAY_MARGIN = 8

/**
 * 会话框相对宠物锚点的落位。
 *
 * top：始终挂在头顶，不做夹紧 —— 用户明确选择固定位置，宠物贴边时宁可超出屏幕也不挪位。
 * auto：依次尝试上、下、左、右，优先完全可见的那个；四个方向都放不下时取溢出最少的方向，
 * 再整体夹回可视区，保证框至少整体在屏幕内。
 */
export function overlayPosition(
  anchor: { x: number; y: number },
  size: OverlaySize,
  petWidth: number,
  viewport: OverlayViewport,
  dock: ChatDock = 'top',
): { x: number; y: number } {
  const maxX = Math.max(OVERLAY_MARGIN, viewport.width - size.width - OVERLAY_MARGIN)
  const maxY = Math.max(OVERLAY_MARGIN, viewport.height - size.height - OVERLAY_MARGIN)
  const clamp = (value: number, max: number) => Math.min(Math.max(value, OVERLAY_MARGIN), max)
  const centerX = anchor.x + petWidth / 2
  const centerY = anchor.y + petWidth / 2
  const above = { x: centerX - size.width / 2, y: anchor.y - size.height - OVERLAY_GAP }
  if (dock === 'top') return above

  const candidates = [
    above,
    { x: centerX - size.width / 2, y: anchor.y + petWidth + OVERLAY_GAP },
    { x: anchor.x - size.width - OVERLAY_GAP, y: centerY - size.height / 2 },
    { x: anchor.x + petWidth + OVERLAY_GAP, y: centerY - size.height / 2 },
  ]
  for (const candidate of candidates) {
    if (candidate.x >= OVERLAY_MARGIN && candidate.y >= OVERLAY_MARGIN
      && candidate.x + size.width <= viewport.width - OVERLAY_MARGIN
      && candidate.y + size.height <= viewport.height - OVERLAY_MARGIN) return candidate
  }
  let best = candidates[0]
  let bestOverflow = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const overflow = Math.max(0, OVERLAY_MARGIN - candidate.x)
      + Math.max(0, OVERLAY_MARGIN - candidate.y)
      + Math.max(0, candidate.x + size.width - (viewport.width - OVERLAY_MARGIN))
      + Math.max(0, candidate.y + size.height - (viewport.height - OVERLAY_MARGIN))
    if (overflow < bestOverflow) {
      bestOverflow = overflow
      best = candidate
    }
  }
  return { x: clamp(best.x, maxX), y: clamp(best.y, maxY) }
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
