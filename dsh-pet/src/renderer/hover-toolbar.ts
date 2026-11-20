/**
 * 悬停快捷工具栏的纯逻辑：什么时候展开、什么时候收起、栏里放什么。
 *
 * 为什么单独一层：这套时序全是"差几十毫秒就变成抖动"的判断 —— 鼠标从宠物挪向工具栏的那一
 * 小段路会先离开宠物，如果立刻收起，工具栏就在指针底下消失，用户永远点不到。这类手感只能靠
 * 逐条用例钉住，靠开壳看是看不出来的（人也测不准 400ms）。
 *
 * 两个硬参数：
 * - **进入 400ms 展开**：太快会误触（用户只是把鼠标停在宠物附近想别的事），太慢会像没反应。
 * - **离开 600ms 收起**：要留出"宠物 → 工具栏"这段距离的通行时间。
 *
 * 一条贯穿全文件的规则：**没展开时，离开不启动收起计时**。否则"进 → 出 → 进"会让两个计时器
 * 互相打架，界面在 400ms 处闪一下又消失。
 */

export type HoverEventKind = 'enter-pet' | 'leave-pet' | 'enter-bar' | 'leave-bar' | 'tick'

export interface HoverEvent {
  readonly kind: HoverEventKind
  readonly at: number
}

export interface HoverState {
  readonly enabled: boolean
  readonly open: boolean
  /** 指针停在宠物上的起点；不在宠物上为 null。 */
  readonly petSince: number | null
  /** 指针离开宠物（且工具栏开着）的时刻，收起计时的起点。 */
  readonly leftPetAt: number | null
  /** 指针离开工具栏的时刻。 */
  readonly leftBarAt: number | null
}

/** 悬停多久展开（可配 300–500，默认 400）。 */
export const HOVER_OPEN_MS = 400
/** 离开多久收起（宠物与工具栏共用同一个值，行为一致才好预期）。 */
export const HOVER_CLOSE_MS = 600

export function initialHover(enabled: boolean): HoverState {
  return { enabled, open: false, petSince: null, leftPetAt: null, leftBarAt: null }
}

function closed(state: HoverState): HoverState {
  return { ...state, open: false, petSince: null, leftPetAt: null, leftBarAt: null }
}

/**
 * 喂一个事件，得到下一份状态。不认识的组合一律按"保持不变"处理 —— 宁可多留一会儿，
 * 也不要在一瞬间把用户正要点的东西收走。
 */
export function reduceHover(prev: HoverState, event: HoverEvent): HoverState {
  // 开关关掉：任何事件都只能得到"收起"。已经在开着的会被下一次事件收掉，不需要额外副作用。
  if (!prev.enabled) return prev.open ? closed(prev) : prev

  switch (event.kind) {
    case 'enter-pet':
      // 回到宠物身上：收起计时作废，展开计时重建（不在宠物上停留够久就不展开）。
      return { ...prev, petSince: prev.petSince ?? event.at, leftPetAt: null, leftBarAt: null }
    case 'leave-pet':
      // 没展开就不启动收起计时 —— 否则"进 → 出"会在 400ms 处闪出一个工具栏。
      return prev.open
        ? { ...prev, petSince: null, leftPetAt: event.at, leftBarAt: null }
        : { ...prev, petSince: null }
    case 'enter-bar':
      // 从宠物挪进工具栏（中间必然先 leave-pet）：两个计时都清掉，保持展开。
      return { ...prev, petSince: null, leftPetAt: null, leftBarAt: null }
    case 'leave-bar':
      return prev.open ? { ...prev, leftBarAt: event.at, leftPetAt: null } : prev
    case 'tick': {
      if (prev.open) {
        const leftAt = prev.leftBarAt ?? prev.leftPetAt
        if (leftAt !== null && event.at - leftAt >= HOVER_CLOSE_MS) return closed(prev)
        return prev
      }
      if (prev.petSince !== null && event.at - prev.petSince >= HOVER_OPEN_MS) return { ...prev, open: true }
      return prev
    }
    default:
      return prev
  }
}

export interface HoverAction {
  readonly id: 'chat' | 'meeting' | 'todo' | 'report' | 'settings'
  readonly label: string
  readonly ariaLabel: string
}

/**
 * 工具栏里的五个按钮，顺序固定：**说话 → 记会议 → 看要办的事 → 写日报 → 改设置**。
 *
 * 顺序是按一天里出现的频率排的：最先要的是"接着说话"，最后才是"调设置"。
 * 会议按钮的文案跟着录音状态走 —— 录音中必须写「停止录音」，否则用户会以为点了是重新开始。
 */
export function hoverActions(recording: boolean): readonly HoverAction[] {
  return [
    { id: 'chat', label: '对话', ariaLabel: '打开对话' },
    { id: 'meeting', label: recording ? '停止录音' : '会议录音', ariaLabel: recording ? '停止会议录音' : '开始会议录音' },
    { id: 'todo', label: '待办', ariaLabel: '打开待办与提醒' },
    { id: 'report', label: '日报', ariaLabel: '打开日报工作台' },
    { id: 'settings', label: '设置', ariaLabel: '打开设置' },
  ]
}
