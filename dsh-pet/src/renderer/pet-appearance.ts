/**
 * 宠物「大小」与「透明度」的纯逻辑：档位、归一化、以及缩放后矩形怎么算。
 *
 * 为什么单独一层：这两个设置看起来只是两个内联样式，但有三处容易错，而三处都没法靠
 * 开壳看出来：
 *
 * 1. **归一化**：设置文件是用户可以手改的，写了 `1.5` 或 `"0.8"` 不能把角色撑成怪物，
 *    也不能让整页空白 —— 一律退回默认值；
 * 2. **缩放的锚点**：必须按**底部中心**缩放，否则放大时角色会往下沉、脚离地（或穿过任务栏）；
 * 3. **透明度作用于谁**：只作用于角色图；工具栏、提示气泡是交互元素，变淡就看不清 ——
 *    这条写成一个显式的表面表，而不是散在组件里的 if。
 */

/** 大小三档。低档别再往下：再小就点不中，也就没有"可配置"的意义了。 */
export const PET_SCALES = [0.8, 1, 1.2] as const
/**
 * 透明度三档，**下限 0.6**。
 *
 * 不做滑杆是有意的：低于 0.6 用户会在桌面上找不到自己的宠物 —— 那不是"可配置"，
 * 是"自找麻烦"。三档已经够，还省掉一个需要解释的数值。
 */
export const PET_OPACITIES = [0.6, 0.8, 1] as const

export type PetScale = (typeof PET_SCALES)[number]
export type PetOpacity = (typeof PET_OPACITIES)[number]

export const DEFAULT_PET_SCALE: PetScale = 1
export const DEFAULT_PET_OPACITY: PetOpacity = 1

/**
 * 缩放锚点：底部中心。
 *
 * `50%` 让角色在原地横向放大，`100%` 让脚底那条线不动 —— 于是"变大"看起来像站起来，
 * 而不是掉下去。这两个数任何一处写错，1.2 倍时脚都会离地（视觉上像浮空）。
 */
export const PET_TRANSFORM_ORIGIN = '50% 100%'

/** 手改的设置文件、旧版本、脏数据都落到默认值：界面永远只有一个确定的大小。 */
export function normalizePetScale(value: unknown): PetScale {
  return PET_SCALES.find(scale => scale === value) ?? DEFAULT_PET_SCALE
}

export function normalizePetOpacity(value: unknown): PetOpacity {
  return PET_OPACITIES.find(opacity => opacity === value) ?? DEFAULT_PET_OPACITY
}

/** `transform` 字符串。只做缩放，不掺任何位移 —— 位移由座位坐标负责，混在一起会互相打架。 */
export function characterTransform(scale: number): string {
  return `scale(${normalizePetScale(scale)})`
}

export interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * 按底部中心缩放后的**可视**矩形。
 *
 * 用途：悬停工具栏要贴头顶。`getBoundingClientRect()` 本身已经含 transform，所以运行时不
 * 需要这个函数；它存在的意义是**把这个几何关系写下来并被测试**，免得哪天有人把 transform
 * 换成 `top/left` 位移时，工具栏还按旧矩形摆，1.2 倍时压住角色的头。
 */
export function scaledBox(rect: Box, scale: number): Box {
  const height = rect.height * scale
  const width = rect.width * scale
  const bottom = rect.top + rect.height
  return {
    left: rect.left + (rect.width - width) / 2,
    top: bottom - height,
    width,
    height,
  }
}

/** 透明度作用于哪些表面。角色图吃透明度；工具栏与气泡**不吃**。 */
export type Surface = 'character' | 'toolbar' | 'bubble'

const OPACITY_SURFACES: Readonly<Record<Surface, boolean>> = {
  character: true,
  toolbar: false,
  bubble: false,
}

/** 某个表面在给定透明度下的实际值：不该变淡的一律 1。 */
export function surfaceOpacity(surface: Surface, opacity: number): number {
  return OPACITY_SURFACES[surface] ? normalizePetOpacity(opacity) : 1
}
