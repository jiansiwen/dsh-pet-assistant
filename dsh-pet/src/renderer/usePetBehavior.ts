/**
 * 宠物行为引擎：定点活动（只在"家"锚点附近随机动作）+ 拖拽 + 随机冒泡说话。
 * 拖拽释放后把释放点设为新的"家"，之后宠物只在该点附近徘徊，不再满屏跑。
 *
 * 多角色舞台上每个角色各持一个本 hook 实例，台词由 character-manifest 按性格注入。
 * 自发的闲聊要过模块级说话仲裁，见 requestSpeech。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CharacterLines } from './character-manifest.js'
import { PET_WIDTH, STAGE_MARGIN, WANDER_RADIUS } from './pet-metrics.js'
import { subscribeTick } from './scene-clock.js'

/** 松手时位移超过这个像素数才算"拖动"，否则视为点击（弹面板）。 */
const DRAG_MOVE_THRESHOLD = 6

export type PetAction = 'idle' | 'walk' | 'jump' | 'wave' | 'sleep' | 'happy' | 'sit' | 'read' | 'play' | 'lie' | 'write'

/**
 * 说话仲裁：同一时刻只让一个角色出声。
 *
 * 五个角色各自按 2.6–6.4 秒的随机周期冒泡，互不知情；不仲裁的话桌面上会同时挂好几个
 * 气泡，变成一片噪音，用户反而谁都读不进去。
 *
 * 只管**自发闲聊**（chatter）。用户戳了谁、给谁发了消息，那个角色必须回应 —— 那种
 * 情况走 say()，直接抢占令牌。让位规则只适用于没人搭理时的自言自语。
 */
let speechReservedUntil = 0

function requestSpeech(ms: number): boolean {
  const now = Date.now()
  if (now < speechReservedUntil) return false
  speechReservedUntil = now + ms
  return true
}

function seizeSpeech(ms: number): void {
  speechReservedUntil = Date.now() + ms
}

/** 舞台卸载或测试之间重置仲裁状态，否则上一个实例的令牌会压住下一个。 */
export function resetSpeechArbiter(): void {
  speechReservedUntil = 0
}

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

export interface PetBehavior {
  action: PetAction
  facing: 1 | -1
  x: number
  y: number
  bubble: string | null
  dragging: boolean
  /** 冻结态：退场动画期间为 true，所有随机行为、拖拽、自动回 idle 全部停止。 */
  frozen: boolean
  poke: () => void
  /** 抢占式出声：回应用户（戳、发消息、审批结果）。别的角色正在闲聊也要让位。 */
  say: (text: string, ms?: number) => void
  /** 仲裁式出声：自发的闲聊。已有角色在说话时直接放弃，不排队。 */
  chatter: (text: string, ms?: number) => boolean
  doWrite: () => void
  startDrag: () => void
  dragMove: (clientX: number, clientY: number) => void
  endDrag: () => boolean
  setPos: (x: number, y: number) => void
  /**
   * 走到指定位置，**不把那里当成新的"家"**。
   *
   * 群体场景用它把角色领到座位上（麻将远排比近排高 56px，所以必须能指定 y）。
   * 和 `setPos` 的区别就在 home：座位是临时的，散场后角色要回自己的徘徊区，
   * 若把座位写进 home，一场麻将之后五个角色的"家"就全搬到桌子边上了。
   */
  walkTo: (x: number, y: number) => void
  /** 进入冻结态：停掉全部定时器与位移目标，用于退场动画。 */
  freeze: () => void
  /** 强制切换动作并取消自动回 idle 的定时器（退场编排用）。 */
  force: (action: PetAction) => void
}

export interface PetBehaviorOptions {
  /** 助理记录模式是否开启，决定闲聊用工作台词还是生活台词。 */
  assistantActive?: boolean
  /** 这个角色的性格台词。 */
  lines: CharacterLines
  /** 初始"家"。多角色舞台上由 TeamStage 按座位算好传进来，不给就沿用老的窗口 70% 处。 */
  home?: { x: number; y: number }
  /**
   * 正在干活。工作态下随机调度只在写字/看书/待机之间换，不会跳去睡觉、玩耍、躺平。
   * 少了这个开关，TeamStage 刚把动作投影成 write，两三秒后随机调度就把它改成 sleep ——
   * 桌面上会出现一个任务正在跑、人却躺平打呼的角色。
   */
  working?: boolean
  /**
   * 群体场景正在驱动这个角色（占了座，或正在发起邀请）。
   *
   * 拴住时随机调度完全让路：不让的话两三秒后它就把"坐着打牌"改成"躺平睡觉"，
   * 场景演不下去。和 `working` 的区别是 working 只在**干活的动作**之间换，
   * 而这里是一个动作都不换 —— 场景自己按节拍发牌。
   */
  sceneBound?: boolean
  /**
   * 安静：压掉**自发**闲聊（`chatter`），不压点名应答（`say`、`poke`）。
   *
   * 专注模式（会议 / 屏幕共享）要的是"别自己插嘴"，不是"变成哑巴"：用户戳一下、唤醒应答、
   * 任务回执都还得有反应，否则看上去就是坏了。闸门因此落在 chatter 内部 —— 那是所有自发
   * 闲聊的唯一咽喉，而 say 是抢占式的另一条路。
   */
  quiet?: boolean
  /** 拖拽释放后持久化新位置。 */
  onPersist?: (x: number, y: number) => void
}

export function usePetBehavior({ assistantActive = false, lines, home, working = false, sceneBound = false, quiet = false, onPersist }: PetBehaviorOptions): PetBehavior {
  const [action, setAction] = useState<PetAction>('idle')
  const [facing, setFacing] = useState<1 | -1>(1)
  const [x, setX] = useState(() => home?.x ?? Math.round(window.innerWidth * 0.7))
  const [y, setY] = useState(() => home?.y ?? Math.round(window.innerHeight - PET_WIDTH - STAGE_MARGIN))
  const [bubble, setBubble] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [frozen, setFrozen] = useState(false)
  const frozenRef = useRef(false)
  frozenRef.current = frozen

  const actionRef = useRef(action)
  actionRef.current = action
  const workingRef = useRef(working)
  workingRef.current = working
  const sceneBoundRef = useRef(sceneBound)
  sceneBoundRef.current = sceneBound
  const quietRef = useRef(quiet)
  quietRef.current = quiet
  const facingRef = useRef(facing)
  facingRef.current = facing
  const xRef = useRef(x)
  xRef.current = x
  const yRef = useRef(y)
  yRef.current = y
  const homeRef = useRef({ x, y })
  const draggingRef = useRef(false)
  const dragMovedRef = useRef(false)
  /** 按下时的鼠标位置：与当前差值过阈值才算拖动，1-2px 的手抖不算。 */
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null)
  /** 位移目标。二维：麻将的远排座位比近排高 56px，只记 x 的话角色走不到座位上去。 */
  const targetRef = useRef<{ x: number; y: number } | null>(null)
  const bubbleTimer = useRef<number>(0)
  const holdTimer = useRef<number>(0)

  const say = useCallback((text: string, ms = 3200) => {
    seizeSpeech(ms)
    setBubble(text)
    window.clearTimeout(bubbleTimer.current)
    bubbleTimer.current = window.setTimeout(() => setBubble(null), ms)
  }, [])

  const chatter = useCallback((text: string, ms = 3200): boolean => {
    // 安静模式（专注 / 会议）：一句话都不自己冒。必须排在 requestSpeech 之前 ——
    // 排在后面的话发言令牌被白白占掉，专注模式一关，第一个想说话的角色还得等令牌过期。
    if (quietRef.current) return false
    // 抢不到就丢掉这句话。排队补说的结果是用户刚读完一个气泡又立刻弹出一个，
    // 比少说一句更吵。
    if (!requestSpeech(ms)) return false
    setBubble(text)
    window.clearTimeout(bubbleTimer.current)
    bubbleTimer.current = window.setTimeout(() => setBubble(null), ms)
    return true
  }, [])

  const clampX = useCallback((v: number) => {
    const max = window.innerWidth - PET_WIDTH - STAGE_MARGIN
    return Math.min(Math.max(v, STAGE_MARGIN), max)
  }, [])

  const clampY = useCallback((v: number) => {
    const max = window.innerHeight - PET_WIDTH - STAGE_MARGIN
    return Math.min(Math.max(v, STAGE_MARGIN), max)
  }, [])

  /** 摆到指定位置，并把它当成新的"家"。拖拽释放与座位重排走这里。 */
  const setPos = useCallback((nx: number, ny: number) => {
    const cx = clampX(nx)
    const cy = clampY(ny)
    setX(cx)
    setY(cy)
    homeRef.current = { x: cx, y: cy }
  }, [clampX, clampY])

  /**
   * 走到指定位置，不把那里当成新的"家"。群体场景领角色去座位用的就是它。
   *
   * 冻结中和拖拽中不接指令：退场动画已经接管了这个角色，而用户的手比场景的编排优先。
   */
  const walkTo = useCallback((nx: number, ny: number) => {
    if (frozenRef.current || draggingRef.current) return
    targetRef.current = { x: clampX(nx), y: clampY(ny) }
    setAction('walk')
  }, [clampX, clampY])

  // 进入一个居家活动，停留一段时间后自动回到 idle
  const startActivity = useCallback((act: PetAction, minMs = 4500, maxMs = 9000) => {
    setAction(act)
    window.clearTimeout(holdTimer.current)
    holdTimer.current = window.setTimeout(() => {
      setAction(c => (c === act ? 'idle' : c))
    }, minMs + Math.random() * (maxMs - minMs))
  }, [])

  // 记事时捧着小本本写
  const doWrite = useCallback(() => {
    startActivity('write', 3000, 4200)
  }, [startActivity])

  // 位移：走路时朝目标点移动；目标点在"家"附近。
  // 挂在共享场景时钟上，五个角色不会各起一个 16ms 定时器；subscribeTick 的返回值
  // 就是退订函数，正好当 effect 的 cleanup 用。
  useEffect(
    () =>
      subscribeTick(() => {
        if (frozenRef.current || draggingRef.current || actionRef.current !== 'walk') return
        const target = targetRef.current
        if (target == null) return
        const speed = 1.1
        const dx = target.x - xRef.current
        const dy = target.y - yRef.current
        // 两轴都进到一步以内才算到达。只判 x 的话纵向会停在半路，角色被"瞬移"上座位。
        if (Math.abs(dx) <= speed && Math.abs(dy) <= speed) {
          setX(target.x)
          setY(target.y)
          targetRef.current = null
          setAction('idle')
          return
        }
        // 朝向只在真的有横向位移时才改：斜着走向远排座位时横向可能只差几像素，
        // 每帧都翻脸的话角色会一路抽搐着走过去。
        if (Math.abs(dx) > speed) {
          const dir = dx > 0 ? 1 : -1
          setFacing(dir as 1 | -1)
          setX(xRef.current + speed * dir)
        }
        if (Math.abs(dy) > speed) setY(yRef.current + speed * (dy > 0 ? 1 : -1))
      }),
    [],
  )

  // 随机行为调度（围绕"家"）
  useEffect(() => {
    let alive = true
    let timer = 0
    const schedule = () => {
      const delay = 2600 + Math.random() * 3800
      timer = window.setTimeout(() => {
        if (!alive || frozenRef.current) return
        const cur = actionRef.current
        const inActivity = cur === 'sit' || cur === 'read' || cur === 'play' || cur === 'lie' || cur === 'write'
        // 被场景拴住时一个动作都不换，也不冒泡：场景是默剧，牌桌上弹出闲聊气泡会把表演盖掉。
        // 读 ref 而不是把 sceneBound 放进 effect 依赖 —— 放依赖会重挂 effect、清掉排好的那一拍，
        // 散场后角色得多等一整轮才恢复生活动作。
        if (!sceneBoundRef.current && !inActivity && cur !== 'happy' && !draggingRef.current) {
          if (workingRef.current) {
            // 工作态：只在干活的动作之间换。不去睡觉玩耍，也不四处走 ——
            // 走开既会和邻座角色叠在一起，也和"这个任务正在跑"的状态对不上。
            startActivity(pick(['write', 'read'] as PetAction[]), 4000, 8000)
            if (Math.random() < 0.3) chatter(pick(lines.work))
          } else {
            const r = Math.random()
            if (r < 0.30) {
              setAction('idle')
            } else if (r < 0.55) {
              // 在"家"附近挑一个目标点走过去
              const max = window.innerWidth - PET_WIDTH - STAGE_MARGIN
              const lo = Math.max(STAGE_MARGIN, homeRef.current.x - WANDER_RADIUS)
              const hi = Math.min(max, homeRef.current.x + WANDER_RADIUS)
              targetRef.current = { x: Math.round(lo + Math.random() * (hi - lo)), y: yRef.current }
              setAction('walk')
            } else if (r < 0.60) setAction('jump')
            else if (r < 0.66) {
              setAction('wave')
              if (Math.random() < 0.5) chatter(pick(lines.greet))
            } else if (r < 0.90) {
              // 居家活动：坐下/看书/玩游戏/躺平
              startActivity(pick(['sit', 'read', 'play', 'lie'] as PetAction[]))
              if (Math.random() < 0.3) chatter(pick(lines.activity))
            } else setAction('sleep')
            if (Math.random() < 0.22) chatter(pick(assistantActive ? lines.work : lines.idle))
          }
        }
        schedule()
      }, delay)
    }
    schedule()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [assistantActive, lines, chatter, startActivity])

  const poke = useCallback(() => {
    if (frozenRef.current) return
    setAction('happy')
    // 用户直接戳的，必须回应：走抢占式 say，不能因为别的角色在闲聊就没反应。
    say(pick(lines.poke))
    window.setTimeout(() => setAction(c => (c === 'happy' ? 'idle' : c)), 1100)
  }, [say, lines])

  const startDrag = useCallback(() => {
    if (frozenRef.current) return
    draggingRef.current = true
    dragMovedRef.current = false
    dragOriginRef.current = null
    setDragging(true)
    setAction('idle')
  }, [])

  /** 进入冻结态：停掉全部定时器与位移目标，退场动画专用。 */
  const freeze = useCallback(() => {
    setFrozen(true)
    draggingRef.current = false
    setDragging(false)
    targetRef.current = null
    window.clearTimeout(holdTimer.current)
  }, [])

  /** 强制切换动作并取消自动回 idle 的定时器（退场编排用）。 */
  const force = useCallback((act: PetAction) => {
    window.clearTimeout(holdTimer.current)
    setAction(act)
  }, [])

  const dragMove = useCallback((clientX: number, clientY: number) => {
    if (!draggingRef.current) return
    // 位移过阈才算"拖过"。Windows 的物理鼠标在按下瞬间几乎必然抖动 1-2px，不设阈值的话
    // 每一次"点击"都会被当成拖动，点角色弹面板就永远轮不到 —— 真机第一轮验收抓到的。
    if (!dragOriginRef.current) dragOriginRef.current = { x: clientX, y: clientY }
    const dx = clientX - dragOriginRef.current.x
    const dy = clientY - dragOriginRef.current.y
    if (dx * dx + dy * dy > DRAG_MOVE_THRESHOLD * DRAG_MOVE_THRESHOLD) dragMovedRef.current = true
    setX(clampX(clientX - PET_WIDTH / 2))
    setY(clampY(clientY - PET_WIDTH / 2))
  }, [clampX, clampY])

  const endDrag = useCallback((): boolean => {
    const moved = dragMovedRef.current
    dragOriginRef.current = null
    if (draggingRef.current) {
      // 释放点成为新的"家"（二维）
      homeRef.current = { x: xRef.current, y: yRef.current }
      targetRef.current = null
      draggingRef.current = false
      setDragging(false)
      setAction('idle')
      onPersist?.(xRef.current, yRef.current)
    }
    return moved
  }, [onPersist])

  return { action, facing, x, y, bubble, dragging, frozen, poke, say, chatter, doWrite, startDrag, dragMove, endDrag, setPos, walkTo, freeze, force }
}
