/**
 * 群体场景状态机：麻将、开黑、闲聊的编排逻辑。
 *
 * 计划里这一块的要求（design.md §2.12）是「邀请 → 占位 → 入场 → 循环 → 退场」的有限状态场景，
 * **不模拟真实游戏**：四人麻将是桌子、座位与摸牌/出牌/反应的编排动画，五人开黑是围坐设备、
 * 同步准备与庆祝的表演。所以这里没有牌局规则、没有胜负、也没有模型参与 —— 闲暇互动完全由
 * 状态机跑，这是刻意的：持续调用模型既花钱，又会让角色说出没有依据的话。
 *
 * 和 `stage-layout.ts` 一样是不认识 React 的纯层，`.ts` 才进得了 `node --test`。
 *
 * 三条不能让步的不变量：
 *
 * 1. **工作中的角色绝不占娱乐座位**。任务一来，座位在这一次步进里就被放掉，与退场动画无关。
 *    等动画演完再放人就是把表演摆在工作前面，顺序反了。
 * 2. **人数不足就散场重开，不强迫凑数**。五个空闲才开黑、四个才麻将、两个才闲聊。已经占了位
 *    再丢人就散场，歇一小会儿按当时的人数重开 —— 不在演到一半时换种类，那不是切换是穿帮。
 *    邀请阶段还没人起身，可以直接换成更小的场景。绝不把正在干活的角色拉来填座位。
 * 3. **场景有预算也有冷却**。循环演满就收场，收场后一段冷却才允许下一场 —— 这是一个常驻的
 *    透明置顶窗口，角色没完没了地演戏会一直占着 CPU 与合成开销。
 */

import { PET_WIDTH, STAGE_MARGIN } from './pet-metrics.ts'
import type { PetAction } from './usePetBehavior.js'

export type SceneKind = 'mahjong' | 'gaming' | 'chat' | 'none'

export type ScenePhase = 'invite' | 'reserve' | 'enter' | 'loop' | 'exit'

/**
 * 每种场景的最低人数。
 *
 * 数字来自计划原文（四人麻将、五人开黑），不是可调参数 —— 改成 3 人麻将就不是那件事了。
 * `chat` 要 2 个人：一个人自言自语属于生活状态，行为引擎已经在做，不需要场景。
 *
 * 计划里的「散步」不在这里。§2.12 把站立、散步、休息、招呼、闲聊列为**生活状态**，把
 * 邀请→占位→入场→循环→退场列为**场景状态**：散步是个体生活状态，`usePetBehavior` 的
 * 徘徊已经在做。把它升格成群体场景就得把几个角色赶去同一个移动路径点，而那会和行为引擎
 * 自己的徘徊打架（走到点上瞬间在 walk/idle 之间抖）。所以这里只做需要**排座位**的三件事。
 */
export const MIN_HEADCOUNT: Readonly<Record<Exclude<SceneKind, 'none'>, number>> = {
  gaming: 5,
  mahjong: 4,
  chat: 2,
}

/**
 * 阶段时长（毫秒）。
 *
 * `enter` 给到 4200 是因为角色走位速度是每帧 1.1px（约 66px/s），从屏幕边上的座位走到
 * 中央桌边最多要穿过 250px 左右。走不完也不打断：迟到的角色会在循环开始时被切成坐下，
 * 看上去就是"赶上了最后一把"，比让它原地瞬移自然。
 */
export const PHASE_MS: Readonly<Record<ScenePhase, number>> = {
  invite: 1400,
  reserve: 900,
  enter: 4200,
  loop: 48_000,
  exit: 2200,
}

/** 一场自然演完之后的冷却。太短的话角色一天到晚在演戏，用户反而没法忽略它们。 */
export const COOLDOWN_MS = 75_000

/**
 * 被中断（有人接了任务）之后的冷却，比自然收场短得多。
 *
 * 计划要求「人数不足时切换聊天/散步」。如果切换也要等 75 秒，用户看到的就是场景凭空散了、
 * 桌面冷清一分多钟，那不像"切换"，像"坏了"。12 秒够他们站起来走回位置，也够让用户看出
 * 这是两件事而不是同一场戏的卡顿。
 */
export const INTERRUPTED_COOLDOWN_MS = 12_000

/** 循环阶段的节拍：每一拍换一个"轮到谁"。摸牌/出牌/反应都挂在这个节拍上。 */
export const BEAT_MS = 2400

/**
 * 不在场景里的角色的绘制层。
 *
 * 与麻将近排同层，也就是永远画在道具前面。工作中的角色站在自己的座位上，窄屏时可能和
 * 桌子重叠；让它被桌子吞掉，看上去就像这个角色从桌面上消失了。
 */
export const DEFAULT_DEPTH = 2

export interface SceneCandidate {
  readonly assistantId: string
  /** 是否被任务拴住。拴住的角色不进场景，也不占座位。 */
  readonly working: boolean
}

export interface SceneState {
  readonly kind: SceneKind
  /** `kind` 为 `none` 时这个字段没有意义：没有场景就没有阶段可演。 */
  readonly phase: ScenePhase
  /** 座位上的 assistantId，下标即座位号。邀请阶段还没占位，所以是空的。 */
  readonly seated: readonly string[]
  /** 发起邀请的角色。占位之后就不再需要它，清空。 */
  readonly proposer: string | null
  /** 当前阶段起始时刻。推进靠 `now - phaseSince` 与阶段时长比较，不用定时器。 */
  readonly phaseSince: number
  /** 这个时刻之前不允许开新场景。收场时就写好，不等到退场结束再算。 */
  readonly cooldownUntil: number
}

/** 初始状态：没有场景，也不需要冷却，第一次步进就能评估开场。 */
export function idleScene(now: number): SceneState {
  return { kind: 'none', phase: 'exit', seated: [], proposer: null, phaseSince: now, cooldownUntil: 0 }
}

/** 当前还空着的角色，按编制顺序。座位号跟着编制走，所以唐僧永远是 0 号位。 */
export function freeCast(cast: readonly SceneCandidate[]): readonly string[] {
  return cast.filter(member => !member.working).map(member => member.assistantId)
}

/**
 * 人数 → 该开哪种场景。
 *
 * 取能撑住的最大那种：五个人齐了优先开黑而不是麻将 —— 麻将只坐四个，开麻将就会剩一个
 * 站在桌边没座位，那个角色看起来像被排挤了。
 */
export function sceneForHeadcount(count: number): SceneKind {
  if (count >= MIN_HEADCOUNT.gaming) return 'gaming'
  if (count >= MIN_HEADCOUNT.mahjong) return 'mahjong'
  if (count >= MIN_HEADCOUNT.chat) return 'chat'
  return 'none'
}

function fits(kind: SceneKind, count: number): boolean {
  return kind !== 'none' && count >= MIN_HEADCOUNT[kind]
}

/** 彻底收场。冷却在进退场那一刻就定好了，这里原样带过去。 */
function closed(state: SceneState, now: number): SceneState {
  return { kind: 'none', phase: 'exit', seated: [], proposer: null, phaseSince: now, cooldownUntil: state.cooldownUntil }
}

/** 还没占位就散伙（邀请途中人不够了）：没有座位要退，直接进冷却。 */
function aborted(now: number, cooldownMs: number): SceneState {
  return { kind: 'none', phase: 'exit', seated: [], proposer: null, phaseSince: now, cooldownUntil: now + cooldownMs }
}

/**
 * 推进一步场景。
 *
 * 由渲染层按约 250ms 的节奏调用，不是每帧调 —— 阶段时长都是秒级，16ms 步进只是白烧 CPU。
 * 返回新状态；什么都没变时返回**原对象**，调用方靠引用相等就能跳过重渲染。
 *
 * 同一个 `now` 上重复调用是幂等的：阶段推进比的是"这一阶段过了多久"，刚推进过的阶段
 * 经过时间为 0，不会被连着推两级。渲染层因此可以在"任务状态变了"时立刻补一步，
 * 不必担心和定时步进撞车。
 */
export function stepScene(state: SceneState, cast: readonly SceneCandidate[], now: number): SceneState {
  const free = freeCast(cast)
  const freeIds = new Set(free)
  // 座位只保留还空着的人。工作中的角色在这一行就被放掉了，不等任何动画。
  const seated = state.seated.filter(id => freeIds.has(id))
  const lost = seated.length !== state.seated.length

  if (state.kind === 'none') {
    if (now < state.cooldownUntil) return state
    const kind = sceneForHeadcount(free.length)
    if (kind === 'none') return state
    // 邀请阶段先不占位：提议要有一个看得见的瞬间，其他人是在这之后才被安排座位的。
    return { kind, phase: 'invite', seated: [], proposer: free[0] ?? null, phaseSince: now, cooldownUntil: 0 }
  }

  const elapsed = now - state.phaseSince

  if (state.phase === 'exit') {
    // 退场途中人数回升也不复活这一场：让它走完，下一场自然会带上回来的人。
    return elapsed < PHASE_MS.exit ? state : closed(state, now)
  }

  if (state.phase === 'invite') {
    // 还没占位，所以人数变化只影响"开哪种"，不需要退场动画。
    // 这时重选是自然的：五个人走掉一个，给剩下四个开一局麻将，谁都还没起身。占位之后再丢人
    // 就不一样了，那得让他们从桌边站起来走回去，所以走 exit。
    // 重选只会拿到更小的场景（当前这种已经撑不住了），所以"只降不升"仍然成立 ——
    // 邀请途中多出来一个人不会把闲聊升级成麻将，升级等下一场，否则人数在阈值附近
    // 抖动时场景会一直翻烙饼。
    if (fits(state.kind, free.length)) {
      return elapsed < PHASE_MS.invite ? state : { ...state, phase: 'reserve', phaseSince: now, seated: [...free] }
    }
    const smaller = sceneForHeadcount(free.length)
    return smaller === 'none'
      ? aborted(now, INTERRUPTED_COOLDOWN_MS)
      : { ...state, kind: smaller, proposer: free[0] ?? null }
  }

  // 已经占了位（reserve / enter / loop）。撑不住就散场，冷却过后按新人数重开 ——
  // 不在演到一半时换场景种类：四个人围着麻将桌，突然变成三个人坐着聊天，桌子还得原地消失，
  // 那不是切换是穿帮。散场、站起来走回位置、歇一小会儿、再按现在的人数开一场，才看得出是两件事。
  if (!fits(state.kind, seated.length)) {
    return { ...state, phase: 'exit', phaseSince: now, seated, cooldownUntil: now + PHASE_MS.exit + INTERRUPTED_COOLDOWN_MS }
  }

  // 没丢人就保持原对象，别每步都换一个新数组，否则渲染层每 250ms 重渲染一次全舞台。
  const current = lost ? { ...state, seated } : state

  switch (current.phase) {
    case 'reserve':
      return elapsed < PHASE_MS.reserve ? current : { ...current, phase: 'enter', phaseSince: now }
    case 'enter':
      return elapsed < PHASE_MS.enter ? current : { ...current, phase: 'loop', phaseSince: now }
    case 'loop':
      return elapsed < PHASE_MS.loop
        ? current
        : { ...current, phase: 'exit', phaseSince: now, cooldownUntil: now + PHASE_MS.exit + COOLDOWN_MS }
    default:
      return current
  }
}

/** 场景是否在台上（占了位、可能有道具、角色归它调度）。邀请阶段还没占位，不算在台上。 */
export function isSceneOnStage(state: SceneState): boolean {
  return state.kind !== 'none' && state.seated.length > 0
}

/** 循环阶段已经演了多少拍。别的地方（出牌轮次、庆祝时机）都从这里推，不再各算一遍。 */
function absoluteBeat(state: SceneState, now: number): number {
  return state.phase === 'loop' ? Math.floor((now - state.phaseSince) / BEAT_MS) : -1
}

/**
 * 这一拍轮到哪个座位出牌。不在循环阶段返回 -1。
 *
 * 用相位差而不是累加计数器，是为了让状态可以被丢弃重建 —— 舞台隐藏时整个 hook 会卸载，
 * 重新显示时不该要求谁记得上一拍演到哪。
 */
export function sceneBeat(state: SceneState, now: number): number {
  const absolute = absoluteBeat(state, now)
  if (absolute < 0 || state.seated.length === 0) return -1
  return absolute % state.seated.length
}

/**
 * 某个座位此刻该摆什么动作。返回 null 表示场景不干预，交给行为引擎按生活态自己挑。
 *
 * 只用三套皮肤都有的动作（idle / walk / sit / play），外加 `happy`：它没有专属素材，
 * `resolveAction` 会把图降级成 idle，但容器类名用的是**降级前**的动作，`pet-anim.css` 里
 * `.action-happy .pet-flip` 那条 pa-hop 照样生效 —— 三套皮肤都看得见"跳一下"，缺帧也不穿帮。
 *
 * 邀请阶段也返回 null：那时还没有座位，提议者的动作由 `sceneRole` 给。
 */
export function sceneAction(state: SceneState, seatIndex: number, now: number): PetAction | null {
  if (state.kind === 'none' || state.seated.length === 0) return null
  switch (state.phase) {
    case 'enter':
    case 'exit':
      return 'walk'
    case 'loop':
      break
    default:
      return null
  }

  const absolute = absoluteBeat(state, now)
  const turn = absolute % state.seated.length
  switch (state.kind) {
    case 'mahjong':
      // 轮到谁谁出牌，其余人坐着看。每四拍有一次反应（碰/杠/胡的表演），由出牌者的下家做 ——
      // 反应总在别人出牌之后，这个先后才对得上。下家再按轮次错开，不然永远是同一个人有反应。
      if (seatIndex === turn) return 'play'
      if (absolute % 4 === 3 && seatIndex === (turn + 1 + Math.floor(absolute / 4)) % state.seated.length) return 'happy'
      return 'sit'
    case 'gaming':
      // 开黑是同时进行的，不存在轮流。每十六拍一起庆祝两拍，其余时间在打。
      return absolute % 16 >= 14 ? 'happy' : 'play'
    case 'chat':
      // 面对面闲聊：按节拍奇偶错开，一个说的时候另一个听着，别两个人同时做同一个动作。
      return (turn + seatIndex) % 2 === 0 ? 'sit' : 'idle'
    default:
      return null
  }
}

/**
 * 座位朝向。返回 null 表示场景不管朝向，沿用角色自己的。
 *
 * 按座位的**几何位置**算，不按座位下标猜"正中间是第几个"：四人麻将是远近两排、每排两个，
 * 按下标找中位会得出"没有人在正中"，于是左右两半各自同向 —— 两个都朝右就是一起赶路，
 * 不是围着一张桌子。比较 x 与整组中心才对得上：偏左的朝右、偏右的朝左，谁都看向桌子中心，
 * 坐在正中的那个朝观众。
 */
export function sceneFacing(state: SceneState, seatIndex: number, seats: readonly SceneSeat[]): 1 | -1 | null {
  if (state.kind === 'none') return null
  const seat = seats[seatIndex]
  if (!seat || seats.length < 2) return null
  let lo = seat.x
  let hi = seat.x
  for (const item of seats) {
    if (item.x < lo) lo = item.x
    if (item.x > hi) hi = item.x
  }
  const center = (lo + hi) / 2
  if (Math.abs(seat.x - center) < PET_WIDTH * 0.25) return null
  return seat.x < center ? 1 : -1
}

export interface SceneSeat {
  readonly x: number
  readonly y: number
  /** 绘制层。数字大的画在前面。道具夹在远排（0）与近排（2）之间（1）。 */
  readonly depth: number
}

/** 远排比近排抬高多少。这个差值决定了桌子看起来有没有"纵深"。 */
const FAR_ROW_LIFT = 56

/**
 * 把 n 个座位排成居中一排，返回每个座位的左上角 x。
 *
 * 间距先按场景要的样子给，放不下就压到 `usable` 能容的最大值；连 0.6 倍身位都排不下时
 * （极窄屏）接受重叠，把所有人等分铺满 —— 那也比把最后几个 clamp 到右边界、叠成一摞强，
 * 和 `seatPositions` 的取舍一致。
 */
function rowOf(count: number, spacing: number, width: number): readonly number[] {
  if (count <= 0) return []
  const usable = Math.max(width - STAGE_MARGIN * 2, PET_WIDTH)
  const maxX = Math.max(STAGE_MARGIN, width - PET_WIDTH - STAGE_MARGIN)
  const maxStep = count > 1 ? Math.max((usable - PET_WIDTH) / (count - 1), 0) : 0
  const step = Math.min(spacing, maxStep)
  const total = step * (count - 1) + PET_WIDTH
  const start = Math.max(STAGE_MARGIN, Math.min(STAGE_MARGIN + (usable - total) / 2, maxX - step * (count - 1)))
  return Array.from({ length: count }, (_, index) => Math.round(Math.min(Math.max(start + index * step, STAGE_MARGIN), maxX)))
}

/**
 * 场景座位。返回的座位数总是等于 `state.seated.length`；邀请阶段还没占位，返回空数组。
 *
 * 麻将是两排：远排抬高并画在桌子后面，近排画在桌子前面。桌子挡住远排角色的下半身、
 * 又被近排角色挡住，这个前后关系就是"围着一张桌子"的全部视觉依据 —— 现有素材只有侧身
 * 与正面的立绘，没有俯视角的坐姿，靠遮挡关系才读得出纵深。
 */
export function sceneSeats(state: SceneState, width: number, height: number): readonly SceneSeat[] {
  const count = state.seated.length
  if (count === 0 || state.kind === 'none') return []
  const baseY = Math.max(STAGE_MARGIN, height - PET_WIDTH - STAGE_MARGIN)

  if (state.kind === 'mahjong') {
    // 前两席在桌子对面（远排：抬高、画在桌子后），其余在这一侧（近排）。
    const far = rowOf(Math.min(2, count), PET_WIDTH * 0.85, width)
    const near = rowOf(count - far.length, PET_WIDTH * 1.15, width)
    const farY = Math.max(STAGE_MARGIN, baseY - FAR_ROW_LIFT)
    return [
      ...far.map(x => ({ x, y: farY, depth: 0 })),
      ...near.map(x => ({ x, y: baseY, depth: DEFAULT_DEPTH })),
    ]
  }

  const spacing = state.kind === 'gaming' ? PET_WIDTH * 0.92 : PET_WIDTH * (count === 2 ? 1.5 : 1.25)
  return rowOf(count, spacing, width).map(x => ({ x, y: baseY, depth: state.kind === 'chat' ? 1 : 0 }))
}

export interface SceneProp {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly shape: 'table' | 'desk'
  readonly depth: number
}

/**
 * 道具（麻将桌 / 开黑长桌）的位置。
 *
 * 用纯 CSS 形状画，不依赖新素材：一张圆角矩形桌子是这个场景里唯一必须有、而现有素材库里
 * 完全没有的东西。牌与设备同理用小色块示意 —— 计划要的是编排动画，不是真实牌局。
 *
 * 道具**不注册命中盒**：它是装饰，点它应该穿透到桌面。角色自己的命中盒照旧生效。
 *
 * 退场时不返回道具：桌子留在原地、人却一个个走开，看着像场景坏了。先收桌子再走，
 * 才读得出"散场"；反过来（人走光了桌子还摆着 2.2 秒）更像出了 bug。
 */
export function sceneProp(state: SceneState, seats: readonly SceneSeat[], width: number, height: number): SceneProp | null {
  if (state.phase === 'exit') return null
  if (seats.length === 0 || (state.kind !== 'mahjong' && state.kind !== 'gaming')) return null
  const left = Math.min(...seats.map(seat => seat.x))
  const span = Math.max(...seats.map(seat => seat.x)) + PET_WIDTH - left
  const baseY = Math.max(STAGE_MARGIN, height - PET_WIDTH - STAGE_MARGIN)
  const propWidth = Math.round(span * (state.kind === 'mahjong' ? 0.86 : 0.94))
  const propHeight = state.kind === 'mahjong' ? 96 : 44
  // 桌面顶边要压在角色下半身上，这个前后遮挡就是"围着一张桌子"的全部视觉依据。
  // 麻将有远排（y = baseY - 56、身高 150，下摆到 baseY + 94），顶边取 baseY + 18 才盖得住腿、
  // 又不至于遮脸。开黑只有一排，桌子得更低更矮：它还要在桌面上沿托出五块显示器（CSS 画的，
  // 见 pet-anim.css 的 .scene-prop-desk），显示器挡在角色胸口正好，桌子按 +18 摆的话就把脸盖了。
  const topOffset = state.kind === 'mahjong' ? 18 : 62
  const y = Math.round(Math.min(baseY + topOffset, Math.max(STAGE_MARGIN, height - propHeight - STAGE_MARGIN)))
  const x = Math.round(Math.max(STAGE_MARGIN, Math.min(left + (span - propWidth) / 2, width - propWidth - STAGE_MARGIN)))
  return { x, y, width: propWidth, height: propHeight, shape: state.kind === 'mahjong' ? 'table' : 'desk', depth: 1 }
}

/**
 * 一个角色在这一帧归场景管的部分：去哪儿、摆什么动作、朝哪边、画在第几层。
 *
 * 做成一个投影函数，而不是让渲染层自己拼 `sceneSeats` / `sceneAction` / `sceneFacing`：
 * "退场时目的地是自己的家而不是座位""邀请阶段只有提议者要动""退场时朝向交给走路"这几条
 * 规则横跨三个数据源，散在组件里就没法测。
 */
export interface SceneRole {
  /** 该走去的落点。null 表示场景不动它：没占座，或者还在邀请/占位阶段没起步。 */
  readonly destination: { readonly x: number; readonly y: number } | null
  /** 该摆的动作。null 表示交给行为引擎（生活态）或任务投影（工作态）。 */
  readonly action: PetAction | null
  readonly facing: 1 | -1 | null
  /** 绘制层序号，用 `depthToZIndex` 翻成 z-index。 */
  readonly depth: number
  /** 这个人正在发起邀请。动作已经由 `action` 给全了，这个标记只是给渲染层加提示用。 */
  readonly proposing: boolean
  /**
   * 场景是否拴住了这个角色。拴住时行为引擎的随机调度要让路 ——
   * 不让的话两三秒后随机调度就把"坐着打牌"改成"躺平睡觉"，场景演不下去。
   */
  readonly bound: boolean
}

/**
 * `depth` → z-index。
 *
 * `.pet-stage` 原本写死 z-index 5。不在场景里的角色拿 `DEFAULT_DEPTH`（2），算出来正好还是 5 ——
 * 加一层场景不改任何现有角色的层级，也就不可能把气泡、名牌、角标压到别的东西底下。
 */
export function depthToZIndex(depth: number): number {
  return depth + 3
}

export function sceneRole(
  state: SceneState,
  seats: readonly SceneSeat[],
  assistantId: string,
  home: { readonly x: number; readonly y: number },
  now: number,
): SceneRole {
  const seatIndex = state.seated.indexOf(assistantId)

  if (seatIndex < 0) {
    const proposing = state.phase === 'invite' && state.proposer === assistantId
    // 提议用 `happy` 不用 `wave`：wave 只有 panda 有序列帧，另两套皮肤会被 resolveAction
    // 降级成静态 idle，看上去就是"根本没人提议"。happy 靠 CSS 的 pa-hop 跳一下，
    // 跟这套皮肤有没有那一帧无关（见 sceneAction 的说明）。
    return {
      destination: null,
      action: proposing ? 'happy' : null,
      facing: null,
      depth: DEFAULT_DEPTH,
      proposing,
      bound: proposing,
    }
  }

  // 退场是"起身走回自己的位置"，所以目的地换成家：这 2.2 秒里座位已经不代表人在哪儿了，
  // 道具也在这一步收掉（见 sceneProp）。占位阶段还不起步，让"被点到名"有一个静止的瞬间。
  const exiting = state.phase === 'exit'
  const moving = state.phase === 'enter' || exiting
  const seat = seats[seatIndex]
  return {
    // 只取坐标：座位对象还带着 depth，那是绘制层的事，不该混进"去哪儿"里。
    destination: moving ? (exiting ? home : { x: seat.x, y: seat.y }) : null,
    action: sceneAction(state, seatIndex, now),
    // 退场途中朝向由走路自己决定（朝着家的方向），继续盯着已经收掉的桌子会很怪。
    facing: exiting ? null : sceneFacing(state, seatIndex, seats),
    depth: exiting ? DEFAULT_DEPTH : seat.depth,
    proposing: false,
    bound: true,
  }
}
