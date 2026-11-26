/** 多角色舞台：共享素材、位置命中盒与场景编排。交互动画、睡眠不接受场景或任务动作抢占。 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import PetSprite from './PetSprite.js'
import PortalExit, { type PortalPhase } from './PortalExit.js'
import { manifestFor, markForeground, type CharacterManifest, type SkinOverrides } from './character-manifest.js'
import { PET_TRANSFORM_ORIGIN, characterTransform, normalizePetOpacity, normalizePetScale, surfaceOpacity } from './pet-appearance.js'
import type { CharacterMenuTarget } from './types.js'
import type { ConversationEvent } from './pet-interaction.js'
import { depthToZIndex, type SceneRole } from './group-scene.js'
import { PET_WIDTH } from './pet-metrics.js'
import { proactiveButtons } from './proactive-ui.js'
import { useGroupScene } from './useGroupScene.js'
import { usePetBehavior, type PetAction, type PetBehavior } from './usePetBehavior.js'
import { usePetFrames, usePetSkinImages, usePetVideos } from './usePetImage.js'
import {
  actionForStatus, characterHitbox, clampToViewport, isWorking, needsAttention, presentationSeat, proactiveHitboxExtra,
  registerCharacterHitbox, seatPositions, unregisterCharacterHitbox,
  type ExitStage, type StageMember, type StageTaskStatus,
} from './stage-layout.js'

export interface TeamStageHandle {
  sayTo(assistantId: string, text: string, ms?: number): void
  pokeOf(assistantId: string): void
  wakeOf(assistantId: string): void
  writeOf(assistantId: string): void
  conversationOf(assistantId: string, event: ConversationEvent): void
  freezeAll(): void
  forceAll(action: PetAction): void
  /** 取指定成员（传 assistantId）或当前选中角色的头顶锚点；指定成员不在台上时返回 null，不回退到总助理。 */
  anchorPosition(assistantId?: string): { x: number; y: number } | null
  subscribeAnchor(callback: () => void): () => void
}
interface CharacterSlotProps {
  manifest: CharacterManifest
  home: { x: number; y: number }
  scene: SceneRole
  assistantActive: boolean
  status: StageTaskStatus | undefined
  selected: boolean
  hideBubble: boolean
  exitStage: ExitStage
  portalPhase: PortalPhase
  showPortal: boolean
  quiet: boolean
  idleSleepMinutes: number
  sleepMinutes: number
  /** 角色大小档位（0.8 / 1 / 1.2），按底部中心缩放。 */
  petScale?: number
  /** 角色透明度档位（0.6 / 0.8 / 1）：只作用于角色图，不作用于气泡与工具栏。 */
  petOpacity?: number
  proactive: { message: string; suggestDisable: boolean } | null
  onProactiveRespond(kind: 'accept' | 'decline' | 'disable'): void
  onBehavior(behavior: PetBehavior | null): void
  onSelect(position: { x: number; y: number }): void
  onPersist(x: number, y: number): void
  onContextMenu(): void
  onDragStart(event: React.MouseEvent, behavior: PetBehavior): void
  /** 交接登场/退场标记：由 App 的交接编排下发，只影响容器动画。 */
  entering?: boolean
  leaving?: boolean
}

function CharacterSlot({ manifest, home, scene, assistantActive, status, selected, hideBubble, exitStage, portalPhase,
  showPortal, quiet, idleSleepMinutes, sleepMinutes, petScale = 1, petOpacity = 1, proactive, onProactiveRespond, onBehavior,
  onSelect, onPersist, onContextMenu, onDragStart, entering = false, leaving = false }: CharacterSlotProps) {
  const behavior = usePetBehavior({ assistantActive, lines: manifest.lines, home, working: isWorking(status),
    sceneBound: scene.bound, quiet, idleSleepMinutes, sleepMinutes, randomActions: manifest.randomActions, onPersist })
  const images = usePetSkinImages(manifest.skin)
  const frames = usePetFrames(manifest.skin)
  const videos = usePetVideos(manifest.skin)
  useLayoutEffect(() => {
    onBehavior(behavior)
  }, [behavior, onBehavior])
  useLayoutEffect(() => () => onBehavior(null), [onBehavior])

  // 仅在座位真正变化时重新夹紧，不让每帧渲染覆盖用户拖到的位置。
  const appliedSeat = useRef(home)
  const setPos = behavior.setPos
  useEffect(() => {
    const previous = appliedSeat.current
    if (previous.x === home.x && previous.y === home.y) return
    appliedSeat.current = home
    setPos(home.x, home.y)
  }, [home, setPos])

  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const [bubbleHeight, setBubbleHeight] = useState(0)
  useLayoutEffect(() => {
    setBubbleHeight(proactive ? bubbleRef.current?.offsetHeight ?? 0 : 0)
  }, [proactive])
  useEffect(() => {
    const extra = proactive ? proactiveHitboxExtra(bubbleHeight) : 0
    registerCharacterHitbox(manifest.assistantId, characterHitbox(behavior.x, behavior.y, extra))
    return () => unregisterCharacterHitbox(manifest.assistantId)
  }, [manifest.assistantId, behavior.x, behavior.y, proactive, bubbleHeight])

  const walkTo = behavior.walkTo
  const destX = scene.destination?.x
  const destY = scene.destination?.y
  useEffect(() => {
    if (destX == null || destY == null || behavior.protected) return
    walkTo(destX, destY)
  }, [destX, destY, walkTo, behavior.protected])

  const projected = actionForStatus(status)
  const sceneAction = scene.action
  const force = behavior.force
  useEffect(() => {
    if (!behavior.protected && sceneAction && !projected) force(sceneAction)
  }, [sceneAction, projected, force, behavior.protected])
  useEffect(() => {
    // write 走下面的工作弧线（开电脑→敲键盘循环），force 一次性赋值演不出收电脑。
    if (!behavior.protected && projected && projected !== 'write') force(projected)
  }, [projected, force, behavior.protected])
  /**
   * 工作投影接交互弧线：running 出现时开电脑进入 write 循环（streaming 闩住不让它收），
   * running 落下时 stop → laptop-out → idle，把"收起电脑站起来"整段演完。
   */
  const workRoundRef = useRef(0)
  const wasWorkingRef = useRef(false)
  const conversation = behavior.conversation
  useEffect(() => {
    const working = projected === 'write'
    if (working === wasWorkingRef.current) return
    wasWorkingRef.current = working
    if (working) {
      workRoundRef.current += 1
      conversation({ type: 'start', id: workRoundRef.current })
      conversation({ type: 'delta', id: workRoundRef.current })
    } else {
      conversation({ type: 'stop', id: workRoundRef.current })
    }
  }, [projected, conversation])
  /**
   * 任务/会话结束后必须**主动收回**工作姿态。
   *
   * `actionForStatus` 在"没有状态"时返回 null 表示"不投影"，但 force 是一次性赋值：
   * 上一拍设成 read/wave 之后，没有任何代码把它改回去 —— 于是回复结束了，角色还在
   * 演那个动作。这里盯住"从有动作变回没有动作"这个沿，把它收回 idle；
   * write 的收交由工作弧线自己演（收电脑站起来），不能硬切。
   */
  const previousProjected = useRef<PetAction | null>(null)
  useEffect(() => {
    const was = previousProjected.current
    previousProjected.current = projected
    if (behavior.protected || projected !== null || was === null || was === 'write') return
    force('idle')
  }, [projected, force, behavior.protected])

  const markForegroundColor = useMemo(() => markForeground(manifest.markColor), [manifest.markColor])
  // 归一化一次：设置文件可以被手改，传进来的值不一定是三档之一。
  const scale = normalizePetScale(petScale)
  const opacity = normalizePetOpacity(petOpacity)
  const attention = needsAttention(status)
  const facing = behavior.protected ? behavior.facing : scene.facing ?? behavior.facing
  return (
    <div
      className={['pet-stage', 'character-slot', `action-${behavior.action}`, facing === -1 ? 'facing-left' : '',
        exitStage === 'turn' ? 'exit-turn' : '', exitStage === 'jump' ? 'exit-jump' : '', selected ? 'selected' : '',
        entering ? 'entering' : '', leaving ? 'leaving' : ''].filter(Boolean).join(' ')}
      style={{ left: behavior.x, top: behavior.y, width: PET_WIDTH, zIndex: depthToZIndex(scene.depth),
        // 缩放锚在底部中心：放大时脚不离地，看起来是"站起来"而不是"掉下去"。
        // 只在这一层做 transform —— 位置仍由座位坐标（left/top）负责，两者混在一起会互相打架。
        transform: characterTransform(scale),
        transformOrigin: PET_TRANSFORM_ORIGIN,
        // 透明度以 CSS 变量下发，只作用于 .pet-svg/.pet-img/.pet-video（见 pet-anim.css）；
        // 气泡、徽标、悬停工具栏都是交互元素，不跟着变淡。
        ['--pet-opacity' as string]: String(surfaceOpacity('character', opacity)),
        ['--mark' as string]: manifest.markColor, ['--mark-fg' as string]: markForegroundColor }}
      data-assistant-id={manifest.assistantId}
      data-skin={manifest.skin}
      data-interactive
      onMouseEnter={behavior.wake}
      onMouseDown={event => { onSelect({ x: behavior.x, y: behavior.y }); onDragStart(event, behavior) }}
      onContextMenu={event => { event.preventDefault(); behavior.wake(); onContextMenu() }}
    >
      {showPortal && <PortalExit phase={portalPhase} />}
      {behavior.bubble && !behavior.dragging && !hideBubble && <div className="pet-bubble">{behavior.bubble}</div>}
      {proactive && (
        <div ref={bubbleRef} className="proactive-bubble" data-interactive role="dialog" aria-label="主动提醒">
          <p className="proactive-text">{proactive.message}</p>
          <div className="proactive-actions">
            {proactiveButtons(proactive.suggestDisable).map(button => (
              <button key={button.kind} type="button" className="proactive-btn" onClick={() => onProactiveRespond(button.kind)}>{button.label}</button>
            ))}
          </div>
        </div>
      )}
      {attention ? <div className="character-alert" title="有事等你处理">!</div>
        : assistantActive && <div className="pet-badge" title="个人助理模式运行中" />}
      {exitStage !== 'gone' && (
        <PetSprite skin={manifest.skin} images={images} frames={frames} videos={videos} action={behavior.action}
          dragging={behavior.dragging} animationVersion={behavior.animationVersion} onComplete={behavior.completeAnimation} />
      )}
    </div>
  )
}

export interface TeamStageProps {
  members: readonly StageMember[]
  assistantActive: boolean
  statusByAssistant?: Readonly<Record<string, StageTaskStatus>>
  positions?: Readonly<Record<string, { x: number; y: number }>>
  selectedId: string | null
  chatOpen?: boolean
  onSelect(assistantId: string, position: { x: number; y: number }): void
  exitStage: ExitStage
  portalPhase: PortalPhase
  showPortal?: boolean
  focusMode?: boolean
  characterSkins?: SkinOverrides
  idleSleepMinutes?: number
  sleepMinutes?: number
  /** 角色大小档位（0.8 / 1 / 1.2），透传给每个角色容器。 */
  petScale?: number
  /** 角色透明度档位（0.6 / 0.8 / 1），只作用于角色图。 */
  petOpacity?: number
  /**
   * 已收起成停靠态的角色：这一位不再渲染（改由 `DockedPet` 那个小圆代表它）。
   *
   * 只跳过渲染、不动 `positions`：取消停靠时按原坐标重新挂载，位置和动画状态天然回到原处。
   */
  dockedId?: string | null
  onPersist(assistantId: string, x: number, y: number): void
  onContextMenu(target: CharacterMenuTarget): void
  onDragStart(event: React.MouseEvent, behavior: PetBehavior): void
  proactive: { message: string; suggestDisable: boolean } | null
  onProactiveRespond(kind: 'accept' | 'decline' | 'disable'): void
  handleRef?: React.MutableRefObject<TeamStageHandle | null>
  /** 交接中的登场/退场角色 id 集合。 */
  enteringIds?: ReadonlySet<string> | null
  leavingIds?: ReadonlySet<string> | null
  /** 正在进行文档演讲的角色 id：演讲期间默认站在屏幕左下角，讲完恢复原位，不改写平时保存的坐标。 */
  presentingId?: string | null
}

export default function TeamStage({ members, assistantActive, statusByAssistant, positions, selectedId, chatOpen = false, onSelect,
  exitStage, portalPhase, showPortal = false, focusMode = false, characterSkins, idleSleepMinutes = 2, sleepMinutes = 20,
  petScale = 1, petOpacity = 1, dockedId = null,
  onPersist, onContextMenu, onDragStart, proactive, onProactiveRespond, handleRef, enteringIds = null, leavingIds = null,
  presentingId = null }: TeamStageProps) {
  const cast = useMemo(() => members.filter(member => member.enabled !== false && member.assistantId)
    .map(member => manifestFor(member, characterSkins)), [members, characterSkins])
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === 'undefined' ? 1920 : window.innerWidth,
    height: typeof window === 'undefined' ? 1080 : window.innerHeight,
  }))
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const seats = useMemo(() => seatPositions(cast.length, viewport.width, viewport.height), [cast.length, viewport])
  const homes = useMemo(() => cast.map((manifest, index) => {
    // 演讲中的助理默认站在屏幕左下角（不覆盖用户平时保存的 positions），讲完自动回到原位。
    if (presentingId && manifest.assistantId === presentingId) {
      return presentationSeat(viewport.width, viewport.height)
    }
    const saved = positions?.[manifest.assistantId]
    return saved ? clampToViewport(saved, viewport.width, viewport.height) : seats[index] ?? { x: 8, y: 8 }
  }), [cast, positions, seats, viewport, presentingId])

  // 只把可参与场景的状态提到舞台；位置每帧更新仍留在角色内部。
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(() => new Set())
  const sceneCast = useMemo(() => focusMode ? [] : cast.map(manifest => ({
    assistantId: manifest.assistantId,
    working: isWorking(statusByAssistant?.[manifest.assistantId]) || unavailable.has(manifest.assistantId),
  })), [cast, statusByAssistant, focusMode, unavailable])
  const scene = useGroupScene({ cast: sceneCast, width: viewport.width, height: viewport.height })
  const selected = useMemo(() => selectedId && cast.some(item => item.assistantId === selectedId)
    ? selectedId : cast[0]?.assistantId ?? null, [selectedId, cast])
  const behaviors = useRef(new Map<string, PetBehavior>())
  const anchorListeners = useRef(new Set<() => void>())
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const callbacks = useRef(new Map<string, (behavior: PetBehavior | null) => void>())
  const callbackFor = useCallback((assistantId: string) => {
    let slot = callbacks.current.get(assistantId)
    if (!slot) {
      slot = (behavior: PetBehavior | null) => {
        if (behavior) {
          behaviors.current.set(assistantId, behavior)
          for (const callback of anchorListeners.current) callback()
          setUnavailable(previous => {
            if (previous.has(assistantId) === behavior.protected) return previous
            const next = new Set(previous)
            if (behavior.protected) next.add(assistantId)
            else next.delete(assistantId)
            return next
          })
        } else behaviors.current.delete(assistantId)
      }
      callbacks.current.set(assistantId, slot)
    }
    return slot
  }, [])

  useLayoutEffect(() => {
    if (!handleRef) return
    handleRef.current = {
      sayTo(assistantId, text, ms) { behaviors.current.get(assistantId)?.say(text, ms) },
      pokeOf(assistantId) { behaviors.current.get(assistantId)?.poke() },
      wakeOf(assistantId) { behaviors.current.get(assistantId)?.wake() },
      writeOf(assistantId) { behaviors.current.get(assistantId)?.doWrite() },
      conversationOf(assistantId, event) { behaviors.current.get(assistantId)?.conversation(event) },
      freezeAll() { for (const behavior of behaviors.current.values()) behavior.freeze() },
      forceAll(action) { for (const behavior of behaviors.current.values()) behavior.force(action) },
      anchorPosition(assistantId?: string) {
        if (assistantId) {
          const index = cast.findIndex(item => item.assistantId === assistantId)
          if (index < 0) return null
          const behavior = behaviors.current.get(assistantId)
          return behavior ? { x: behavior.x, y: behavior.y } : homes[index] ?? null
        }
        const index = selected ? cast.findIndex(item => item.assistantId === selected) : -1
        const behavior = selected ? behaviors.current.get(selected) : undefined
        return behavior ? { x: behavior.x, y: behavior.y } : homes[Math.max(index, 0)] ?? null
      },
      subscribeAnchor(callback) {
        anchorListeners.current.add(callback)
        callback()
        return () => { anchorListeners.current.delete(callback) }
      },
    }
    for (const callback of anchorListeners.current) callback()
    return () => { handleRef.current = null }
  }, [handleRef, selected, cast, homes])
  useEffect(() => {
    const alive = new Set(cast.map(item => item.assistantId))
    for (const key of [...behaviors.current.keys()]) {
      if (!alive.has(key)) { behaviors.current.delete(key); callbacks.current.delete(key) }
    }
  }, [cast])

  return (
    <>
      {scene.prop && <div className={`scene-prop scene-prop-${scene.prop.shape}`} aria-hidden
        style={{ left: scene.prop.x, top: scene.prop.y, width: scene.prop.width, height: scene.prop.height, zIndex: depthToZIndex(scene.prop.depth) }} />}
      {cast.map((manifest, index) => {
        const home = homes[index] ?? { x: 8, y: 8 }
        // 收起的角色不渲染：它的替身是屏幕边上那个 48×48 的小圆。
        if (manifest.assistantId === dockedId) return null
        return <CharacterSlot key={manifest.assistantId} manifest={manifest} home={home}
          scene={scene.roleOf(manifest.assistantId, home)} assistantActive={assistantActive}
          status={statusByAssistant?.[manifest.assistantId]} selected={manifest.assistantId === selected}
          hideBubble={chatOpen && manifest.assistantId === selected}
          exitStage={exitStage} portalPhase={portalPhase} showPortal={showPortal} quiet={focusMode}
          idleSleepMinutes={idleSleepMinutes} sleepMinutes={sleepMinutes}
          petScale={petScale} petOpacity={petOpacity}
          proactive={manifest.assistantId === selected ? proactive : null} onProactiveRespond={onProactiveRespond}
          entering={enteringIds?.has(manifest.assistantId) ?? false} leaving={leavingIds?.has(manifest.assistantId) ?? false}
          onBehavior={callbackFor(manifest.assistantId)} onSelect={position => onSelect(manifest.assistantId, position)}
          onPersist={(x, y) => onPersist(manifest.assistantId, x, y)}
          onContextMenu={() => onContextMenu({ assistantId: manifest.assistantId, displayName: manifest.displayName, skin: manifest.skin })}
          onDragStart={onDragStart} />
      })}
    </>
  )
}
