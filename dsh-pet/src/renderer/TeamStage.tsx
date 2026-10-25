/** 多角色舞台：共享素材、位置命中盒与场景编排。交互动画、睡眠不接受场景或任务动作抢占。 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import PetSprite from './PetSprite.js'
import PortalExit, { type PortalPhase } from './PortalExit.js'
import { manifestFor, markForeground, type CharacterManifest, type SkinOverrides } from './character-manifest.js'
import type { CharacterMenuTarget } from './types.js'
import type { ConversationEvent } from './pet-interaction.js'
import { depthToZIndex, type SceneRole } from './group-scene.js'
import { PET_WIDTH } from './pet-metrics.js'
import { proactiveButtons } from './proactive-ui.js'
import { useGroupScene } from './useGroupScene.js'
import { usePetBehavior, type PetAction, type PetBehavior } from './usePetBehavior.js'
import { usePetFrames, usePetSkinImages, usePetVideos } from './usePetImage.js'
import {
  actionForStatus, characterHitbox, clampToViewport, isWorking, needsAttention, proactiveHitboxExtra,
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
  anchorPosition(): { x: number; y: number } | null
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
  proactive: { message: string; suggestDisable: boolean } | null
  onProactiveRespond(kind: 'accept' | 'decline' | 'disable'): void
  onBehavior(behavior: PetBehavior | null): void
  onSelect(position: { x: number; y: number }): void
  onPersist(x: number, y: number): void
  onContextMenu(): void
  onDragStart(event: React.MouseEvent, behavior: PetBehavior): void
}

function CharacterSlot({ manifest, home, scene, assistantActive, status, selected, hideBubble, exitStage, portalPhase,
  showPortal, quiet, idleSleepMinutes, sleepMinutes, proactive, onProactiveRespond, onBehavior,
  onSelect, onPersist, onContextMenu, onDragStart }: CharacterSlotProps) {
  const behavior = usePetBehavior({ assistantActive, lines: manifest.lines, home, working: isWorking(status),
    sceneBound: scene.bound, quiet, idleSleepMinutes, sleepMinutes, onPersist })
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
    if (!behavior.protected && projected) force(projected)
  }, [projected, force, behavior.protected])
  /**
   * 任务/会话结束后必须**主动收回**工作姿态。
   *
   * `actionForStatus` 在"没有状态"时返回 null 表示"不投影"，但 force 是一次性赋值：
   * 上一拍设成 write/read 之后，没有任何代码把它改回去 —— 于是回复结束了，角色还在
   * 对着电脑敲个不停。这里盯住"从有动作变回没有动作"这个沿，把它收回 idle。
   */
  const previousProjected = useRef<PetAction | null>(null)
  useEffect(() => {
    const wasWorking = previousProjected.current !== null
    previousProjected.current = projected
    if (behavior.protected || projected !== null || !wasWorking) return
    force('idle')
  }, [projected, force, behavior.protected])

  const markForegroundColor = useMemo(() => markForeground(manifest.markColor), [manifest.markColor])
  const attention = needsAttention(status)
  const facing = behavior.protected ? behavior.facing : scene.facing ?? behavior.facing
  return (
    <div
      className={['pet-stage', 'character-slot', `action-${behavior.action}`, facing === -1 ? 'facing-left' : '',
        exitStage === 'turn' ? 'exit-turn' : '', exitStage === 'jump' ? 'exit-jump' : '', selected ? 'selected' : ''].filter(Boolean).join(' ')}
      style={{ left: behavior.x, top: behavior.y, width: PET_WIDTH, zIndex: depthToZIndex(scene.depth),
        ['--mark' as string]: manifest.markColor, ['--mark-fg' as string]: markForegroundColor }}
      data-assistant-id={manifest.assistantId}
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
  onPersist(assistantId: string, x: number, y: number): void
  onContextMenu(target: CharacterMenuTarget): void
  onDragStart(event: React.MouseEvent, behavior: PetBehavior): void
  proactive: { message: string; suggestDisable: boolean } | null
  onProactiveRespond(kind: 'accept' | 'decline' | 'disable'): void
  handleRef?: React.MutableRefObject<TeamStageHandle | null>
}

export default function TeamStage({ members, assistantActive, statusByAssistant, positions, selectedId, chatOpen = false, onSelect,
  exitStage, portalPhase, showPortal = false, focusMode = false, characterSkins, idleSleepMinutes = 2, sleepMinutes = 20,
  onPersist, onContextMenu, onDragStart, proactive, onProactiveRespond, handleRef }: TeamStageProps) {
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
    const saved = positions?.[manifest.assistantId]
    return saved ? clampToViewport(saved, viewport.width, viewport.height) : seats[index] ?? { x: 8, y: 8 }
  }), [cast, positions, seats, viewport])

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
          if (assistantId === selectedRef.current) {
            for (const callback of anchorListeners.current) callback()
          }
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
      anchorPosition() {
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
        return <CharacterSlot key={manifest.assistantId} manifest={manifest} home={home}
          scene={scene.roleOf(manifest.assistantId, home)} assistantActive={assistantActive}
          status={statusByAssistant?.[manifest.assistantId]} selected={manifest.assistantId === selected}
          hideBubble={chatOpen && manifest.assistantId === selected}
          exitStage={exitStage} portalPhase={portalPhase} showPortal={showPortal} quiet={focusMode}
          idleSleepMinutes={idleSleepMinutes} sleepMinutes={sleepMinutes}
          proactive={manifest.assistantId === selected ? proactive : null} onProactiveRespond={onProactiveRespond}
          onBehavior={callbackFor(manifest.assistantId)} onSelect={position => onSelect(manifest.assistantId, position)}
          onPersist={(x, y) => onPersist(manifest.assistantId, x, y)}
          onContextMenu={() => onContextMenu({ assistantId: manifest.assistantId, displayName: manifest.displayName, skin: manifest.skin })}
          onDragStart={onDragStart} />
      })}
    </>
  )
}
