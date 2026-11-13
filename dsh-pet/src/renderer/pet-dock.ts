/**
 * 边缘吸附与停靠态的纯逻辑。
 *
 * 三件事都写在这里，因为它们都"看不出来错了"：
 *
 * 1. **吸附判定**：拖到离边缘多近才算贴边、角落同时满足两边时该贴哪边 —— 差几像素人眼
 *    分辨不了，但决定了停靠后它出现在屏幕哪一侧；
 * 2. **停靠位置**：48×48 的圆要贴在边内侧 8px，另一边取原位置的**中心** —— 写错会让它
 *    从角色"跳"到屏幕另一端；
 * 3. **状态点优先级**：同时录音 + 有待批时显示哪个？这类"同时成立"的情况必须在纯函数里定死，
 *    否则不同代码路径会给出不同答案。
 */

/** 停靠态直径。小到不挡事，大到能看见形象与点得中。 */
export const DOCK_SIZE = 48
/**
 * 停靠态在命中盒注册表里的键。
 *
 * **没有它，停靠态就点不动**：整层窗口平时是鼠标穿透的，只有落在命中盒里的坐标才会
 * 让主进程 `setIgnoreMouseEvents(false)`。角色收起后它的命中盒随卸载一起注销，
 * 于是那个 48px 的圆既收不到 hover 也收不到 click —— 用户会以为"宠物没了、点也没用"。
 * 这条与用户报障是同一个现场，所以键放在这里、由 `DockedPet` 注册。
 */
export const DOCK_HITBOX_KEY = '__docked__'
/** 贴边内边距：留 8px，别让圆和屏幕边缘糊在一起。 */
export const DOCK_INSET = 8
/**
 * 吸附阈值：距边缘 ≤8px 才算"要贴边"。
 *
 * 原来是 24。**24px 太宽**：用户拖动本来就不精确（1920 宽屏上 24px 只有屏幕宽的 1.2%），
 * 手一抖就进去了，而他并不想收起 —— 收到的是"我的宠物不见了"。
 * 8px 的语义变成"必须明确贴边"：想收起的人会把鼠标顶到边上，不想的人几乎不会停在 8px 内。
 */
export const DOCK_THRESHOLD = 8
/**
 * 停靠态单击恢复的手势容差：按下到抬起位移超过 4px 视为拖拽，不触发恢复。
 *
 * 为什么这里可以有容差：停靠态那个小圆**没有拖拽手势**（没有 pointermove 逻辑），
 * 所以容差不会偷走别的操作，只用来吸收"手抖"。
 * 鼠标点击时指针漂移通常 0–2px；触摸板轻点（tap-to-click）可能到 4–6px，
 * 所以触摸类指针在调用处放宽（见 DockedPet），鼠标保持这个紧的值。
 */
export const DOCK_CLICK_TOLERANCE = 4

export type DockEdge = 'left' | 'right' | 'top' | 'bottom'

export interface Rect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface WorkArea {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * 拖拽结束后该贴哪条边；不贴返回 null。
 *
 * 角落会同时满足两条边，取**更近**的那条 —— 用户把它拖到左上角时，他心里的目标就是更靠的
 * 那一边；随便取一条会显得"没听指挥"。
 */
export function dockEdge(rect: Rect, workArea: WorkArea, threshold = DOCK_THRESHOLD): DockEdge | null {
  const distances: Array<{ edge: DockEdge; distance: number }> = [
    { edge: 'left', distance: rect.left - workArea.left },
    { edge: 'right', distance: workArea.left + workArea.width - (rect.left + rect.width) },
    { edge: 'top', distance: rect.top - workArea.top },
    { edge: 'bottom', distance: workArea.top + workArea.height - (rect.top + rect.height) },
  ]
  let best: { edge: DockEdge; distance: number } | null = null
  for (const candidate of distances) {
    if (candidate.distance > threshold) continue
    if (best === null || candidate.distance < best.distance) best = candidate
  }
  return best?.edge ?? null
}

/**
 * 停靠后那个 48×48 圆的位置（左上角）。
 *
 * 左/右边：垂直方向取原角色的**中心**；上/下边：水平方向取中心。
 * 最后再夹一次工作区，防止原位置本身就在屏幕外（多屏拔掉显示器后的常见情形）。
 */
export function dockPosition(edge: DockEdge, rect: Rect, workArea: WorkArea): { left: number; top: number } {
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  const raw = (() => {
    switch (edge) {
      case 'left': return { left: workArea.left + DOCK_INSET, top: centerY - DOCK_SIZE / 2 }
      case 'right': return { left: workArea.left + workArea.width - DOCK_INSET - DOCK_SIZE, top: centerY - DOCK_SIZE / 2 }
      case 'top': return { left: centerX - DOCK_SIZE / 2, top: workArea.top + DOCK_INSET }
      case 'bottom': return { left: centerX - DOCK_SIZE / 2, top: workArea.top + workArea.height - DOCK_INSET - DOCK_SIZE }
    }
  })()
  return {
    left: Math.round(Math.min(Math.max(raw.left, workArea.left + DOCK_INSET), workArea.left + workArea.width - DOCK_INSET - DOCK_SIZE)),
    top: Math.round(Math.min(Math.max(raw.top, workArea.top + DOCK_INSET), workArea.top + workArea.height - DOCK_INSET - DOCK_SIZE)),
  }
}

export type DockTone = 'error' | 'recording' | 'pending' | 'idle'

export interface DockSignals {
  readonly recording?: boolean
  readonly pendingApproval?: boolean
  readonly error?: boolean
}

/**
 * 停靠态那个小圆点显示什么状态。
 *
 * 优先级：**错误 > 录音 > 待批 > 空闲**。理由：收起之后用户只能看到这一个点，
 * 它必须回答"现在最需要你管的是哪件事"。录音在跑但他知道自己在录；出错他不知道，所以错误最高。
 */
export function dockStatusTone(signals: DockSignals): DockTone {
  if (signals.error === true) return 'error'
  if (signals.recording === true) return 'recording'
  if (signals.pendingApproval === true) return 'pending'
  return 'idle'
}

/** 四种状态点的颜色与是否呼吸。录音用"呼吸"和错误区分开 —— 两者都是红的，但一个在跑、一个坏了。 */
export const DOCK_TONES: Readonly<Record<DockTone, { color: string; breathing: boolean; label: string }>> = {
  error: { color: '#dc2626', breathing: false, label: '出错了' },
  recording: { color: '#ef4444', breathing: true, label: '录音中' },
  pending: { color: '#f59e0b', breathing: false, label: '有待处理事项' },
  idle: { color: '#c9ccd3', breathing: false, label: '空闲' },
}

/** 手势是否算"单击"（用于停靠态恢复）。 */
export function isDockClick(dx: number, dy: number, tolerance = DOCK_CLICK_TOLERANCE): boolean {
  return Math.hypot(dx, dy) <= tolerance
}
