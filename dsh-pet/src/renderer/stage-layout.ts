/**
 * 舞台的纯逻辑层：座位排布、状态投影、命中盒。
 *
 * 从 `TeamStage.tsx` 拆出来有两个理由：
 *
 * 1. **可测**。Node 的类型剥离跑得动 `.ts` 但跑不动 `.tsx`，纯函数留在组件文件里就测不了。
 *    这个工程没有测试框架，用 `node --test` 就够 —— 前提是这些函数不沾 JSX。
 * 2. **分层**。这些函数不认识 React：给定坐标和状态就返回结果。组件只负责把它们接到
 *    hook 和 DOM 上。混在一起时，改一个排布算法要在几百行组件里翻找。
 *
 * 后缀不统一是刻意的，别"顺手改整齐"：
 *
 * - **值**导入写 `.ts`（`./pet-metrics.ts`）。Node 的类型剥离不做路径重写，写 `.js` 会让
 *   `node --test` 直接 `ERR_MODULE_NOT_FOUND`。
 * - **纯类型**导入写 `.js`。它们运行时会被擦除，而 `types.d.ts` 只能靠 `.js` 被 tsc 解析
 *   （TS 不接受 `.d.ts` 出现在 import 路径里）。
 *
 * 其余模块（组件、hook）写 `.js` 是因为它们只被 esbuild 打包，从不进 `node --test`。
 */

import { PET_WIDTH, STAGE_MARGIN } from './pet-metrics.ts'
import type { PetAction } from './usePetBehavior.js'
import type { PetTaskStatus, TeamMemberSnapshot, TeamTaskSnapshot } from './types.js'

/**
 * 任务状态与编制成员都取自 `types.d.ts` —— 那里是桥接 HTTP 契约的单一真源，
 * 主进程、preload 与渲染层共用一份，避免三处各写一遍形状然后悄悄漂移。
 *
 * 这里保留 `StageTaskStatus` / `StageMember` 两个名字，是因为舞台内部讲"席位"和"状态"，
 * 而契约那边讲"任务"和"成员"；名字换掉、定义不换。
 */
export type StageTaskStatus = PetTaskStatus

export type StageMember = TeamMemberSnapshot

export type ExitStage = 'none' | 'wave' | 'turn' | 'jump' | 'gone'

export interface Box {
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * 状态优先级：数字大的赢。
 *
 * 一个成员可能同时挂着好几个任务（上一件在复核、下一件已排队），但一个角色只能摆一个动作。
 * 挑哪个不是随便挑的：**会阻塞用户的事必须最先被看见**，所以待批准/待用户排最前；
 * 已取消的排最后 —— 一件被取消的任务不该让角色看起来还在忙。
 */
const STATUS_PRIORITY: Record<string, number> = {
  'awaiting-approval': 5,
  'awaiting-user': 5,
  running: 4,
  review: 3,
  created: 2,
  queued: 2,
  done: 1,
  unknown: 1,
  failed: 1,
  cancelled: 0,
}

function priorityOf(status: string | null | undefined): number {
  return STATUS_PRIORITY[status ?? ''] ?? 1
}

/**
 * 把任务列表投影成"每个角色当前该显示的状态"。
 *
 * 同一优先级下取最近更新的：两件都在跑时，用户关心的是刚刚有动静的那件。
 * 没有任务的成员不出现在结果里 —— 缺席即空闲，比显式写一个 idle 更省一次判断。
 */
export function projectTaskStatuses(
  tasks: readonly TeamTaskSnapshot[] | undefined,
): Record<string, StageTaskStatus> {
  const result: Record<string, StageTaskStatus> = {}
  const chosen: Record<string, TeamTaskSnapshot> = {}
  for (const task of tasks ?? []) {
    const owner = task.ownerId
    if (!owner || !task.status) continue
    const current = chosen[owner]
    if (!current) {
      chosen[owner] = task
      continue
    }
    const byPriority = priorityOf(task.status) - priorityOf(current.status)
    if (byPriority > 0 || (byPriority === 0 && (task.updatedAt ?? 0) > (current.updatedAt ?? 0))) {
      chosen[owner] = task
    }
  }
  for (const [owner, task] of Object.entries(chosen)) {
    result[owner] = task.status as StageTaskStatus
  }
  return result
}

/**
 * 任务状态 → 动作。
 *
 * awaiting-approval / awaiting-user 用招手，review 用看书，running 用写字，done 用一下高兴。
 * 未知状态一律不投影（返回 null），交给行为引擎按生活态自己挑 —— 猜一个动作比不猜更容易误导。
 *
 * 这些动作全是**点缀**，不是信号本身。真正告诉用户"这个角色在等你"的是 `needsAttention` 驱动的
 * 角标（22px 琥珀色、持续脉冲、与皮肤无关），任务详情在面板里。所以 `wave` 只有熊猫画得出来、
 * 两套眼镜皮肤没有这段素材，不算缺口 —— 别为了让它动起来去改判据或补美术。
 *
 * 反过来说，任何"用户必须看见否则就出事"的状态，都得先有角标或面板兜着，才轮到这里挑动作。
 */
export function actionForStatus(status: StageTaskStatus | undefined): PetAction | null {
  switch (status) {
    case 'running':
      return 'write'
    case 'review':
      return 'read'
    case 'awaiting-approval':
    case 'awaiting-user':
      return 'wave'
    case 'done':
      return 'happy'
    default:
      return null
  }
}

/** 任务是否把这个角色拴在工作上：不该睡觉、不该玩耍、不该走开。 */
export function isWorking(status: StageTaskStatus | undefined): boolean {
  if (!status) return false
  return status !== 'done' && status !== 'failed' && status !== 'cancelled'
}

/** 需要用户处理的状态。角标与面板都用它，避免两处各判一次判出不同结果。 */
export function needsAttention(status: StageTaskStatus | undefined): boolean {
  return status === 'awaiting-approval' || status === 'awaiting-user'
}

/**
 * 命中盒相对角色定位点的外扩量。
 *
 * 上边留 130px 是为了把头顶的说话气泡整个包住 —— 盒子包不住它的话，那次点击会
 * 直接穿透到桌面上去。名牌已按用户要求移除，不再占用上方空间。
 */
export const HITBOX_INSET = { left: 14, top: 130, right: 14, bottom: 16 } as const

/**
 * 提醒气泡挂在角色头顶时与 styles.css `.proactive-bubble` 对齐的 bottom 定位值。
 * 两处必须一起改：命中盒的几何是照着这个值算的。
 */
export const PROACTIVE_BUBBLE_BOTTOM = 214

/** 头顶挂着可点击的提醒气泡时，命中盒在既有上扩量之外还要再让出的空间。 */
export function proactiveHitboxExtra(bubbleHeight: number): number {
  // 气泡 bottom 相对角色 div 底边，所以气泡底边在定位点上方 PROACTIVE_BUBBLE_BOTTOM - PET_WIDTH。
  const aboveAnchor = PROACTIVE_BUBBLE_BOTTOM - PET_WIDTH + bubbleHeight
  return Math.max(0, aboveAnchor + 12 - HITBOX_INSET.top)
}

export function characterHitbox(x: number, y: number, extraTop = 0): Box {
  return {
    x1: x - HITBOX_INSET.left,
    y1: y - HITBOX_INSET.top - extraTop,
    x2: x + PET_WIDTH + HITBOX_INSET.right,
    y2: y + PET_WIDTH + HITBOX_INSET.bottom,
  }
}

/**
 * 命中盒注册表：角色 + 面板都登记在这里，穿透判断只读这一个入口。
 *
 * 键是 assistantId（面板用固定的 PANEL_HITBOX_KEY）。渲染层写、App 读，两边都不经过
 * React 状态 —— 角色走动是 16ms 一次的 interval，任何走 state 的上报都会把根组件拖进
 * 重渲染风暴。
 */
const hitboxes = new Map<string, Box>()

export const PANEL_HITBOX_KEY = '__panel__'

export function stageHitboxes(): ReadonlyMap<string, Box> {
  return hitboxes
}

export function registerCharacterHitbox(assistantId: string, box: Box): void {
  hitboxes.set(assistantId, box)
}

export function unregisterCharacterHitbox(assistantId: string): void {
  hitboxes.delete(assistantId)
}

export function registerPanelHitbox(box: Box | null): void {
  if (box) hitboxes.set(PANEL_HITBOX_KEY, box)
  else hitboxes.delete(PANEL_HITBOX_KEY)
}

/** 舞台卸载或测试之间清空，否则上一个实例留下的盒子会让穿透判断永远命中。 */
export function clearStageHitboxes(): void {
  hitboxes.clear()
}

export function hitTest(x: number, y: number): boolean {
  for (const box of hitboxes.values()) {
    if (x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2) return true
  }
  return false
}

/**
 * 座位：沿屏幕底部把 n 个角色排开。
 *
 * 每个角色占一格，格宽取"刚好不叠"与"均分可用宽度"里的较大者；整组再居中。
 * 算整组宽度时必须把最后一个 sprite 自身算进去 —— 座位记的是 sprite 左上角，
 * 少算这 150px 会让整组右偏半个身位。
 *
 * 角色各自还会在 ±WANDER_RADIUS 内徘徊，完全避免交错需要 PET_WIDTH + 2*WANDER_RADIUS
 * = 330px，五个角色要 1650px。窄屏放不下时改成铺满可用区间：挤一点，也比把最后几个
 * clamp 到右边界、叠成一摞强。
 */
export function seatPositions(count: number, width: number, height: number): Array<{ x: number; y: number }> {
  if (count <= 0) return []
  const y = Math.max(STAGE_MARGIN, height - PET_WIDTH - STAGE_MARGIN)
  const minX = STAGE_MARGIN
  // 右边界扣掉 sprite 自身宽度：座位是左上角坐标。
  const maxX = Math.max(minX, width - PET_WIDTH - STAGE_MARGIN)
  const usable = Math.max(width - STAGE_MARGIN * 2, PET_WIDTH)
  const cell = Math.max(PET_WIDTH + 24, usable / count)
  const group = cell * (count - 1) + PET_WIDTH
  const fits = group <= usable
  const start = fits ? minX + (usable - group) / 2 : minX
  const spacing = fits ? cell : (maxX - minX) / Math.max(count - 1, 1)
  return Array.from({ length: count }, (_, index) => ({
    x: Math.round(Math.min(Math.max(start + index * spacing, minX), maxX)),
    y,
  }))
}

/**
 * 把存下来的位置夹回当前可见区域。
 *
 * 座位可能是在另一块屏幕、另一个 DPI 下存的；直接用的话角色会待在屏幕外，
 * 用户只会觉得"宠物不见了"，而且穿透判断还留着一个永远点不到的命中盒。
 */
export function clampToViewport(
  pos: { x: number; y: number },
  width: number,
  height: number,
): { x: number; y: number } {
  const maxX = Math.max(STAGE_MARGIN, width - PET_WIDTH - STAGE_MARGIN)
  const maxY = Math.max(STAGE_MARGIN, height - PET_WIDTH - STAGE_MARGIN)
  return {
    x: Math.round(Math.min(Math.max(pos.x, STAGE_MARGIN), maxX)),
    y: Math.round(Math.min(Math.max(pos.y, STAGE_MARGIN), maxY)),
  }
}
