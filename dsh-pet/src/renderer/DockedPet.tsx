/**
 * 停靠态的宠物：屏幕边上一个 48×48 的圆形**宠物头像**，右下角一个小状态徽标。
 *
 * 从前的版本只画了一个圆点，用户真机反馈是"我的宠物形象去哪了" —— 他认不出那是宠物，
 * 只觉得东西丢了。所以这里的第一职责是**让它一眼还是那只宠物**：
 * 用与舞台角色同一份素材（`usePetSkinImages(skin).idle`）做圆形裁切、等比居中。
 *
 * 三件事：
 * 1. 画头像（拿不到素材时退回**剪影**，绝不退回纯色圆点 —— 那正是这次问题的本体）；
 * 2. 单击恢复（拖拽判定在 `isDockClick`，纯函数、有单测）；
 * 3. 告诉读屏软件它现在是什么状态。
 *
 * 为什么状态点移到右下角：48px 的圆里，圆心的点会把脸盖住 —— 用户看不到形象，等于没修。
 * 缩成 12px 徽标压在角上，脸完整露出，状态也仍然"一眼可见"。
 */

import { useLayoutEffect, useRef } from 'react'

import {
  DOCK_CLICK_TOLERANCE, DOCK_HITBOX_KEY, DOCK_SIZE, DOCK_TONES, isDockClick, type DockTone,
} from './pet-dock.js'
import { registerCharacterHitbox, unregisterCharacterHitbox } from './stage-layout.js'
import { usePetSkinImages } from './usePetImage.js'

/**
 * 触摸指针的容差：鼠标保持 4px，手指/触控笔放宽到 10px。
 *
 * 依据不是感觉：手指点击的落点漂移普遍在 5–10px（触摸板 tap-to-click 也会 4–6px），
 * 用 4px 会让人"点了没反应"，而这个按钮**唯一**的作用就是单击 —— 点不动等于彻底坏了。
 * 鼠标没有这个问题，所以不放宽：紧一点反而能挡住"本想拖动却误触"。
 */
const COARSE_POINTER_TOLERANCE = 10

export interface DockedPetProps {
  readonly left: number
  readonly top: number
  readonly tone: DockTone
  /** 取形象用：与舞台上同一份皮肤素材（同一份缓存，不额外读盘）。 */
  readonly skin: string
  /** 单击（非拖拽）时恢复原尺寸与原位置。 */
  onRestore(): void
  /** 右键仍然给菜单：收起不等于失去所有入口。 */
  onContextMenu(event: React.MouseEvent): void
}

/** 拿不到形象时的退路：一只宠物剪影（头 + 两只耳朵）。**不是圆点**。 */
function PetSilhouette() {
  return (
    <svg className="docked-pet-silhouette" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="9" cy="10" r="5" />
      <circle cx="23" cy="10" r="5" />
      <circle cx="16" cy="19" r="11" />
    </svg>
  )
}

export default function DockedPet({ left, top, tone, skin, onRestore, onContextMenu }: DockedPetProps) {
  const start = useRef<{ x: number; y: number } | null>(null)
  const pointerType = useRef<string>('mouse')
  const button = useRef<HTMLButtonElement | null>(null)
  const images = usePetSkinImages(skin)
  const art = images.idle ?? null
  const appearance = DOCK_TONES[tone]

  /**
   * 注册命中盒 —— **不注册就点不动**。
   *
   * 这一层窗口默认鼠标穿透，主进程只把命中盒里的坐标当"可交互"。角色收起后它的命中盒
   * 随卸载注销了，所以必须由停靠态自己登记一块，否则那个 48px 的圆既没有 hover 也没有
   * click：用户看到的是一个点不动的白圆，等于彻底坏了。
   *
   * 用 `getBoundingClientRect()` 而不是拿 `left/top` 直接算：窗口若有缩放/变换，
   * 属性值不等于屏幕坐标；量一次就都对了（与配额横幅、设置面板同一套写法）。
   */
  useLayoutEffect(() => {
    const element = button.current
    if (element === null) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      registerCharacterHitbox(DOCK_HITBOX_KEY, { x1: rect.left, y1: rect.top, x2: rect.right, y2: rect.bottom })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      unregisterCharacterHitbox(DOCK_HITBOX_KEY)
    }
  }, [left, top])

  return (
    <button
      ref={button}
      type="button"
      className={`docked-pet${appearance.breathing ? ' is-breathing' : ''}`}
      style={{ left, top, width: DOCK_SIZE, height: DOCK_SIZE }}
      data-interactive
      aria-label={`宠物已收起 · ${appearance.label}；单击展开`}
      title={`${appearance.label}（单击展开）`}
      onPointerDown={event => {
        start.current = { x: event.clientX, y: event.clientY }
        pointerType.current = event.pointerType
      }}
      onPointerUp={event => {
        const from = start.current
        start.current = null
        if (from === null) return
        const tolerance = pointerType.current === 'mouse' ? DOCK_CLICK_TOLERANCE : COARSE_POINTER_TOLERANCE
        if (isDockClick(event.clientX - from.x, event.clientY - from.y, tolerance)) onRestore()
      }}
      onContextMenu={onContextMenu}
    >
      <span className="docked-pet-face">
        {art === null
          ? <PetSilhouette />
          : <img className="docked-pet-img" src={art} alt="" draggable={false} />}
        <span className="docked-pet-dot" style={{ background: appearance.color }} aria-hidden="true" />
      </span>
    </button>
  )
}
