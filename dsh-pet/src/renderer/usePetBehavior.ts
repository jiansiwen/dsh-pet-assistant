/** 定点生活行为、拖拽与会话动画。真实交互优先于随机活动和群体场景。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CharacterLines } from './character-manifest.js'
import { PET_WIDTH, STAGE_MARGIN, WANDER_RADIUS } from './pet-metrics.js'
import { subscribeTick } from './scene-clock.js'
import { initialInteraction, interactionProtected, reduceInteraction, type ConversationEvent, type InteractionEvent } from './pet-interaction.js'

const DRAG_MOVE_THRESHOLD = 6
export type PetAction =
  | 'idle' | 'walk' | 'jump' | 'wave' | 'sleep' | 'happy' | 'sit' | 'read' | 'play' | 'lie' | 'write'
  | 'drop' | 'think' | 'laptop-in' | 'laptop-out'
  /** 走路收步（一次）：走姿 → 站定。走到目标时插在 walk 与 idle 之间 */
  | 'walk-stop'
  /** 打盹三步（与 InteractionPhase 同名，直接投影成动作） */
  | 'sleep-in' | 'sleep-loop' | 'sleep-out'

let speechReservedUntil = 0
function requestSpeech(ms: number): boolean {
  const now = Date.now()
  if (now < speechReservedUntil) return false
  speechReservedUntil = now + ms
  return true
}
export function resetSpeechArbiter(): void { speechReservedUntil = 0 }
function pick<T>(list: readonly T[]): T { return list[Math.floor(Math.random() * list.length)] }

export interface PetBehavior {
  action: PetAction
  facing: 1 | -1
  x: number
  y: number
  bubble: string | null
  dragging: boolean
  frozen: boolean
  protected: boolean
  animationVersion: number
  completeAnimation: (action: string, version: number) => void
  conversation: (event: ConversationEvent) => void
  wake: () => void
  poke: () => void
  say: (text: string, ms?: number) => void
  chatter: (text: string, ms?: number) => boolean
  doWrite: () => void
  startDrag: () => void
  dragMove: (clientX: number, clientY: number) => void
  endDrag: () => boolean
  setPos: (x: number, y: number) => void
  /** 场景走位不更改家。 */
  walkTo: (x: number, y: number) => void
  freeze: () => void
  /** 冻结后仅供退场编排强制切换；其他调用不能抢交互动画。 */
  force: (action: PetAction) => void
}
export interface PetBehaviorOptions {
  assistantActive?: boolean
  lines: CharacterLines
  home?: { x: number; y: number }
  working?: boolean
  sceneBound?: boolean
  quiet?: boolean
  idleSleepMinutes?: number
  sleepMinutes?: number
  onPersist?: (x: number, y: number) => void
}

export function usePetBehavior({ assistantActive = false, lines, home, working = false, sceneBound = false,
  quiet = false, idleSleepMinutes = 2, sleepMinutes = 20, onPersist }: PetBehaviorOptions): PetBehavior {
  const [action, setAction] = useState<PetAction>('idle')
  const [facing, setFacing] = useState<1 | -1>(1)
  const [x, setX] = useState(() => home?.x ?? Math.round(window.innerWidth * 0.7))
  const [y, setY] = useState(() => home?.y ?? Math.round(window.innerHeight - PET_WIDTH - STAGE_MARGIN))
  const [bubble, setBubble] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [frozen, setFrozen] = useState(false)
  const [interaction, setInteraction] = useState(() => initialInteraction(Date.now()))
  const interactionRef = useRef(interaction)
  const frozenRef = useRef(false)
  const actionRef = useRef(action)
  actionRef.current = action
  const optionsRef = useRef({ working, sceneBound, quiet, idleSleepMinutes, sleepMinutes })
  optionsRef.current = { working, sceneBound, quiet, idleSleepMinutes, sleepMinutes }
  const xRef = useRef(x)
  xRef.current = x
  const yRef = useRef(y)
  yRef.current = y
  const homeRef = useRef({ x, y })
  const draggingRef = useRef(false)
  const dragMovedRef = useRef(false)
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null)
  const targetRef = useRef<{ x: number; y: number } | null>(null)
  const bubbleTimer = useRef<number>(0)
  const holdTimer = useRef<number>(0)

  const dispatch = useCallback((event: InteractionEvent) => {
    if (frozenRef.current) return
    const previous = interactionRef.current
    const next = reduceInteraction(previous, event, Date.now())
    if (next === previous) return
    interactionRef.current = next
    setInteraction(next)
    if (next.version !== previous.version) {
      window.clearTimeout(holdTimer.current)
      targetRef.current = null
      const nextAction = next.phase === 'drag' ? 'idle' : next.phase
      actionRef.current = nextAction
      setAction(nextAction)
      if (next.phase === 'sleep-in' || next.phase === 'sleep-loop' || next.phase === 'sleep-out') {
        window.clearTimeout(bubbleTimer.current)
        setBubble(null)
      }
    }
  }, [])
  const wake = useCallback(() => dispatch({ type: 'wake' }), [dispatch])
  const conversation = useCallback((event: ConversationEvent) => dispatch(event), [dispatch])
  const completeAnimation = useCallback((phase: string, version: number) => dispatch({ type: 'complete', phase, version }), [dispatch])

  const say = useCallback((text: string, ms = 3200) => {
    speechReservedUntil = Date.now() + ms
    setBubble(text)
    window.clearTimeout(bubbleTimer.current)
    bubbleTimer.current = window.setTimeout(() => setBubble(null), ms)
  }, [])
  const chatter = useCallback((text: string, ms = 3200): boolean => {
    if (optionsRef.current.quiet || interactionProtected(interactionRef.current) || frozenRef.current) return false
    if (!requestSpeech(ms)) return false
    setBubble(text)
    window.clearTimeout(bubbleTimer.current)
    bubbleTimer.current = window.setTimeout(() => setBubble(null), ms)
    return true
  }, [])
  const clampX = useCallback((v: number) => Math.min(Math.max(v, STAGE_MARGIN), window.innerWidth - PET_WIDTH - STAGE_MARGIN), [])
  const clampY = useCallback((v: number) => Math.min(Math.max(v, STAGE_MARGIN), window.innerHeight - PET_WIDTH - STAGE_MARGIN), [])
  const setPos = useCallback((nx: number, ny: number) => {
    const cx = clampX(nx), cy = clampY(ny)
    setX(cx)
    setY(cy)
    xRef.current = cx
    yRef.current = cy
    homeRef.current = { x: cx, y: cy }
  }, [clampX, clampY])
  const walkTo = useCallback((nx: number, ny: number) => {
    if (frozenRef.current || interactionProtected(interactionRef.current)) return
    targetRef.current = { x: clampX(nx), y: clampY(ny) }
    setAction('walk')
  }, [clampX, clampY])
  const startActivity = useCallback((act: PetAction, minMs = 4500, maxMs = 9000) => {
    if (frozenRef.current || interactionProtected(interactionRef.current)) return
    setAction(act)
    window.clearTimeout(holdTimer.current)
    holdTimer.current = window.setTimeout(() => {
      if (!frozenRef.current && !interactionProtected(interactionRef.current)) setAction(c => c === act ? 'idle' : c)
    }, minMs + Math.random() * (maxMs - minMs))
  }, [])
  const doWrite = useCallback(() => startActivity('write', 3000, 4200), [startActivity])

  useEffect(() => subscribeTick(() => {
    if (frozenRef.current || interactionProtected(interactionRef.current) || actionRef.current !== 'walk') return
    const target = targetRef.current
    if (!target) return
    const speed = 1.1
    const dx = target.x - xRef.current, dy = target.y - yRef.current
    if (Math.abs(dx) <= speed && Math.abs(dy) <= speed) {
      setX(target.x)
      setY(target.y)
      targetRef.current = null
      // 走到目标不直接切 idle —— 先演「收步」把走姿收成站姿，再回 idle。
      // 直接切会让两套素材的姿势硬碰：走路时有一脚在前，idle 是双脚并立。
      // walk-stop 是 3 帧（0.3 秒）。这里不检查素材是否存在：
      // 没有该素材的皮肤由 PetSprite 降级成静态图，300ms 后照样回 idle。
      setAction('walk-stop')
      window.clearTimeout(holdTimer.current)
      holdTimer.current = window.setTimeout(() => {
        setAction(c => (c === 'walk-stop' ? 'idle' : c))
      }, 300)
      return
    }
    if (Math.abs(dx) > speed) {
      const dir = dx > 0 ? 1 : -1
      setFacing(dir)
      setX(xRef.current + speed * dir)
    }
    if (Math.abs(dy) > speed) setY(yRef.current + speed * (dy > 0 ? 1 : -1))
  }), [])

  // 场景不是用户互动，不延长清醒期；进入躺下后舞台会把角色从场景编制中排除。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const opts = optionsRef.current
      dispatch({ type: 'tick', working: opts.working, idleMinutes: opts.idleSleepMinutes, sleepMinutes: opts.sleepMinutes })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [dispatch])

  useEffect(() => {
    let alive = true
    let timer = 0
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (!alive || frozenRef.current) return
        const cur = actionRef.current
        const inActivity = cur === 'sit' || cur === 'read' || cur === 'play' || cur === 'write'
        // happy / drop / walk-stop 都是**一次性演出**，各自带回落定时器，
        // 演出期间不能被这一拍换掉 —— 否则「摔到一半突然开始走路」。
        const oneShotPlaying = cur === 'happy' || cur === 'drop' || cur === 'walk-stop'
        if (!interactionProtected(interactionRef.current) && !optionsRef.current.sceneBound && !inActivity && !oneShotPlaying) {
          if (optionsRef.current.working) {
            startActivity(pick(['write', 'read'] as PetAction[]), 4000, 8000)
            if (Math.random() < 0.3) chatter(pick(lines.work))
          } else {
            const r = Math.random()
            if (r < 0.30) setAction('idle')
            else if (r < 0.55) {
              const max = window.innerWidth - PET_WIDTH - STAGE_MARGIN
              const lo = Math.max(STAGE_MARGIN, homeRef.current.x - WANDER_RADIUS)
              const hi = Math.min(max, homeRef.current.x + WANDER_RADIUS)
              targetRef.current = { x: Math.round(lo + Math.random() * (hi - lo)), y: yRef.current }
              setAction('walk')
            } else if (r < 0.60) setAction('jump')
            else if (r < 0.66) {
              setAction('wave')
              if (Math.random() < 0.5) chatter(pick(lines.greet))
            } else {
              startActivity(pick(['sit', 'read', 'play'] as PetAction[]))
              if (Math.random() < 0.3) chatter(pick(lines.activity))
            }
            if (Math.random() < 0.22) chatter(pick(assistantActive ? lines.work : lines.idle))
          }
        }
        schedule()
      }, 2600 + Math.random() * 3800)
    }
    schedule()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [assistantActive, lines, chatter, startActivity])

  const poke = useCallback(() => {
    if (frozenRef.current) return
    wake()
    if (!interactionProtected(interactionRef.current)) startActivity('happy', 1100, 1100)
    say(pick(lines.poke))
  }, [wake, startActivity, say, lines])
  const startDrag = useCallback(() => {
    if (frozenRef.current) return
    draggingRef.current = true
    dragMovedRef.current = false
    dragOriginRef.current = null
    setDragging(true)
    dispatch({ type: 'grab' })
  }, [dispatch])
  const freeze = useCallback(() => {
    frozenRef.current = true
    setFrozen(true)
    draggingRef.current = false
    setDragging(false)
    targetRef.current = null
    window.clearTimeout(holdTimer.current)
    window.clearTimeout(bubbleTimer.current)
  }, [])
  const force = useCallback((act: PetAction) => {
    if (!frozenRef.current && interactionProtected(interactionRef.current)) return
    window.clearTimeout(holdTimer.current)
    setAction(act)
  }, [])
  const dragMove = useCallback((clientX: number, clientY: number) => {
    if (!draggingRef.current) return
    if (!dragOriginRef.current) dragOriginRef.current = { x: clientX, y: clientY }
    const dx = clientX - dragOriginRef.current.x, dy = clientY - dragOriginRef.current.y
    if (dx * dx + dy * dy > DRAG_MOVE_THRESHOLD * DRAG_MOVE_THRESHOLD) dragMovedRef.current = true
    xRef.current = clampX(clientX - PET_WIDTH / 2)
    yRef.current = clampY(clientY - PET_WIDTH / 2)
    setX(xRef.current)
    setY(yRef.current)
  }, [clampX, clampY])
  const endDrag = useCallback((): boolean => {
    const moved = dragMovedRef.current
    dragOriginRef.current = null
    if (draggingRef.current) {
      homeRef.current = { x: xRef.current, y: yRef.current }
      targetRef.current = null
      draggingRef.current = false
      setDragging(false)
      dispatch({ type: 'release', moved })
      onPersist?.(xRef.current, yRef.current)
    }
    return moved
  }, [onPersist, dispatch])
  useEffect(() => () => {
    window.clearTimeout(holdTimer.current)
    window.clearTimeout(bubbleTimer.current)
  }, [])

  return { action, facing, x, y, bubble, dragging, frozen, protected: frozen || interactionProtected(interaction),
    animationVersion: interaction.version, completeAnimation, conversation, wake,
    poke, say, chatter, doWrite, startDrag, dragMove, endDrag, setPos, walkTo, freeze, force }
}
