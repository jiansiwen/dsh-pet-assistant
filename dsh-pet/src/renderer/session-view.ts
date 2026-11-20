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

/** 会话框停靠方式：top = 固定头顶；auto = 按屏幕剩余空间在上/下/左/右里选，避开宠物。 */
export type ChatDock = 'top' | 'auto'

/** 会话框相对宠物的落位方向，供连接短线朝向使用。 */
export type OverlaySide = 'above' | 'below' | 'left' | 'right'

export interface OverlaySize {
  width: number
  height: number
}

export interface OverlayViewport {
  width: number
  height: number
}

export interface OverlayPlacement {
  x: number
  y: number
  side: OverlaySide
}

const OVERLAY_GAP = 12
const OVERLAY_MARGIN = 8

function viewportOverflow(
  box: { x: number; y: number },
  size: OverlaySize,
  viewport: OverlayViewport,
): number {
  return Math.max(0, OVERLAY_MARGIN - box.x)
    + Math.max(0, OVERLAY_MARGIN - box.y)
    + Math.max(0, box.x + size.width - (viewport.width - OVERLAY_MARGIN))
    + Math.max(0, box.y + size.height - (viewport.height - OVERLAY_MARGIN))
}

function fitsViewport(
  box: { x: number; y: number },
  size: OverlaySize,
  viewport: OverlayViewport,
): boolean {
  return viewportOverflow(box, size, viewport) === 0
}

/** 会话框与宠物包围盒（含间隙）的重叠面积；>0 表示会挡住宠物。 */
function petOverlapArea(
  box: { x: number; y: number },
  size: OverlaySize,
  pet: { x1: number; y1: number; x2: number; y2: number },
): number {
  const x1 = Math.max(box.x, pet.x1 - OVERLAY_GAP)
  const y1 = Math.max(box.y, pet.y1 - OVERLAY_GAP)
  const x2 = Math.min(box.x + size.width, pet.x2 + OVERLAY_GAP)
  const y2 = Math.min(box.y + size.height, pet.y2 + OVERLAY_GAP)
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
}

/**
 * 会话框相对宠物锚点的落位。
 *
 * top：优先挂在头顶；若头顶会被屏幕裁切（对话框被挡住），改走与 auto 相同的避让。
 * auto：依次尝试上、右、左、下；只接受「完全在屏内且不压住宠物」的位置。
 * 四个方向都放不下时，在夹回可视区后优先选挡住宠物最少、其次屏幕溢出最少的方向。
 */
export function overlayPosition(
  anchor: { x: number; y: number },
  size: OverlaySize,
  petWidth: number,
  viewport: OverlayViewport,
  dock: ChatDock = 'auto',
): OverlayPlacement {
  const maxX = Math.max(OVERLAY_MARGIN, viewport.width - size.width - OVERLAY_MARGIN)
  const maxY = Math.max(OVERLAY_MARGIN, viewport.height - size.height - OVERLAY_MARGIN)
  const clamp = (value: number, max: number) => Math.min(Math.max(value, OVERLAY_MARGIN), max)
  const centerX = anchor.x + petWidth / 2
  const centerY = anchor.y + petWidth / 2
  const above = { x: centerX - size.width / 2, y: anchor.y - size.height - OVERLAY_GAP, side: 'above' as const }
  // 固定头顶：只有完整可见时才钉死；被屏幕挡住就继续往下走避让逻辑。
  if (dock === 'top' && fitsViewport(above, size, viewport)) return above

  const pet = {
    x1: anchor.x,
    y1: anchor.y,
    x2: anchor.x + petWidth,
    y2: anchor.y + petWidth,
  }
  const candidates: OverlayPlacement[] = [
    above,
    { x: anchor.x + petWidth + OVERLAY_GAP, y: centerY - size.height / 2, side: 'right' },
    { x: anchor.x - size.width - OVERLAY_GAP, y: centerY - size.height / 2, side: 'left' },
    { x: centerX - size.width / 2, y: anchor.y + petWidth + OVERLAY_GAP, side: 'below' },
  ]
  for (const candidate of candidates) {
    if (fitsViewport(candidate, size, viewport) && petOverlapArea(candidate, size, pet) === 0) {
      return candidate
    }
  }

  let best = candidates[0]
  let bestScore = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const clamped = { x: clamp(candidate.x, maxX), y: clamp(candidate.y, maxY), side: candidate.side }
    // 压住宠物的代价远高于屏幕溢出：宁可贴边露一点，也不要盖住角色。
    const score = petOverlapArea(clamped, size, pet) * 1000 + viewportOverflow(candidate, size, viewport)
    if (score < bestScore) {
      bestScore = score
      best = clamped
    }
  }
  return best
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
