/**
 * 主动帮助的策略引擎（design.md §2.7「主动帮助」）。
 *
 * 设计原文的边界，逐条落在这里：
 * - 触发：无输入超过阈值（首轮建议 8 分钟，可配置实验值，不是人的认知判断），
 *   且不在会议 / 演示 / 免打扰 —— 落到本项目就是专注模式开着、或角色被隐藏时不提醒。
 * - 频控：同一任务最多提醒一次、默认冷却 60 分钟。"任务"边界没有可靠信号，
 *   所以取保守下界：一个连续空闲期最多提醒一次，跨空闲期再叠加全局冷却。
 * - 形式：先只显示无声小气泡，固定文案；用户不回应就到此为止 ——
 *   不读取更多资料、不开始代理任务。这些"不做"是结构性的：本模块只产生文案，
 *   产生不了任何资料读取或任务派发。
 * - 反复拒绝时建议关闭；用户关闭后彻底安静，直到他重新打开。
 *
 * 评估是**拉模型**：上层定时器周期性地用最新采样调 evaluate，拿到决策再执行副作用。
 * 本模块不设定时器、不碰文件、不发网络请求 —— 所有输入显式传入，全部状态显式持有，
 * 决策对同样的 (state, input, config) 永远一样，这才测试得住。
 */

export interface ProactiveConfig {
  /** 功能总开关（用户显式关掉后引擎直接安静）。 */
  enabled: boolean
  /** 触发提醒的无输入时长下限（毫秒）。 */
  idleMs: number
  /** 两次提醒之间的最小间隔（毫秒），跨空闲期生效。 */
  cooldownMs: number
}

/** 上层每次评估都要带回的最新环境事实。 */
export interface ProactiveInput {
  /** 评估时刻（epoch 毫秒）。 */
  now: number
  /**
   * 最近一次采样里的无输入毫秒数。null 表示采样还没有这个字段（旧采样器或首拍），
   * 此时宁可不提醒 —— 拿不到真实空闲指标就不猜。
   */
  idleMs: number | null
  /** 专注模式开着（会议 / 演示 / 免打扰在本项目里的对应物）。 */
  focusMode: boolean
  /** 角色是否在桌面上可见；被隐藏时用户没要它出现，更不该弹气泡。 */
  stageVisible: boolean
  captureActive: boolean
  sampleAt: number | null
  sampleIntervalMs: number
  developmentApp: boolean
  taskRunning: boolean
  /** 会议进行中（录音 / 会议面板开着）。缺省按没有会议处理，与旧装配兼容。 */
  meetingActive?: boolean
  /** 已经在一起看（主动帮助 episode 进行中）：不再重复打扰。 */
  engaged?: boolean
}

export type ProactiveDecision =
  | { kind: 'remind'; message: string }
  | { kind: 'suggest-disable'; message: string }
  | { kind: 'none'; reason: ProactiveSkipReason }

export type ProactiveSkipReason =
  | 'disabled'
  | 'capture-inactive'
  | 'stale-sample'
  | 'not-development-app'
  | 'task-running'
  | 'focus-mode'
  | 'meeting'
  | 'stage-hidden'
  | 'help-in-progress'
  | 'no-idle-data'
  | 'not-idle-enough'
  | 'cooldown'
  | 'already-reminded-in-period'
  | 'declined-out'

/** 引擎的全部可变状态。上层持久化与否由它自己决定；重启丢状态只影响冷却，不产生错误提醒。 */
export interface ProactiveState {
  /** 上次发出提醒（remind 或 suggest-disable 都算打扰）的时刻；null = 从未。 */
  lastNotifiedAt: number | null
  /** 当前空闲期开始的时刻；null = 用户有输入，不在空闲期。 */
  idlePeriodStart: number | null
  /** 当前空闲期是否已经打扰过。 */
  notifiedInPeriod: boolean
  /** 用户连续点「不用」的次数；≥ declineThreshold 时下一次候选改为建议关闭。 */
  declineStreak: number
  /** 用户显式关闭后为 true，引擎彻底安静。 */
  disabled: boolean
}

/** 连续拒绝到几次之后，下一次候选改成"要不要干脆关掉"。 */
export const DECLINE_THRESHOLD = 3

export const REMIND_MESSAGE = '需要我一起看一下吗？'
export const SUGGEST_DISABLE_MESSAGE = '这段时间你都没需要我 —— 要我把主动提醒关掉吗？'

export const INITIAL_PROACTIVE_STATE: ProactiveState = {
  lastNotifiedAt: null,
  idlePeriodStart: null,
  notifiedInPeriod: false,
  declineStreak: 0,
  disabled: false,
}

/**
 * 评估一次候选。返回新状态与决策；不修改传入对象。
 *
 * 判定顺序有讲究：先判"这会儿就不该打扰"（开关 / 专注 / 隐藏），再判"还不算空闲"，
 * 最后才是频控。原因：用户回来看结果时，第一眼要知道的是"为什么没提醒"，
 * 与人的直觉一致的顺序才好排查。
 */
export function evaluateProactive(
  state: ProactiveState,
  input: ProactiveInput,
  config: ProactiveConfig,
): { state: ProactiveState; decision: ProactiveDecision } {
  const next: ProactiveState = { ...state }

  // 空闲期边界：用户一有输入（idleMs 回落或拿不到数据视为活动），当前空闲期结束。
  // 拿不到 idleMs 视为活动而不是"继续空闲"：数据缺失时不该把上一拍的空闲当成这一拍的。
  const active = input.idleMs === null || !Number.isFinite(input.idleMs) || input.idleMs < config.idleMs
  if (active) {
    next.idlePeriodStart = null
    next.notifiedInPeriod = false
  } else if (input.idleMs !== null && next.idlePeriodStart === null) {
    next.idlePeriodStart = input.now
    next.notifiedInPeriod = false
  }

  const skip = (reason: ProactiveSkipReason): { state: ProactiveState; decision: ProactiveDecision } => ({
    state: next,
    decision: { kind: 'none', reason },
  })

  if (state.disabled || !config.enabled) return skip('disabled')
  if (input.focusMode) return skip('focus-mode')
  if (input.meetingActive === true) return skip('meeting')
  if (!input.stageVisible) return skip('stage-hidden')
  if (input.engaged === true) return skip('help-in-progress')
  if (!input.captureActive) return skip('capture-inactive')
  const maxAgeMs = Math.max(15_000, input.sampleIntervalMs * 3)
  if (input.sampleAt === null || !Number.isFinite(input.sampleAt)
    || input.sampleAt > input.now || input.now - input.sampleAt > maxAgeMs) return skip('stale-sample')
  if (!input.developmentApp) return skip('not-development-app')
  if (input.taskRunning) return skip('task-running')
  if (input.idleMs === null || !Number.isFinite(input.idleMs) || input.idleMs < 0) return skip('no-idle-data')
  if (input.idleMs < config.idleMs) return skip('not-idle-enough')
  if (next.notifiedInPeriod) return skip('already-reminded-in-period')
  if (state.lastNotifiedAt !== null && input.now - state.lastNotifiedAt < config.cooldownMs) {
    return skip('cooldown')
  }

  // 到这里才是一次真实候选。打扰过就记账：remind 与 suggest-disable 都算。
  next.lastNotifiedAt = input.now
  next.notifiedInPeriod = true
  if (next.declineStreak >= DECLINE_THRESHOLD) {
    return { state: next, decision: { kind: 'suggest-disable', message: SUGGEST_DISABLE_MESSAGE } }
  }
  return { state: next, decision: { kind: 'remind', message: REMIND_MESSAGE } }
}

/** 用户点了「不用」。本次空闲期已经处理过，连续拒绝计数 +1。 */
export function recordDecline(state: ProactiveState): ProactiveState {
  return {
    ...state,
    declineStreak: state.declineStreak + 1,
    notifiedInPeriod: true,
  }
}

/** 用户点了「好」。连续拒绝计数清零 —— 愿意互动本身就是最强的"还想被提醒"信号。 */
export function recordAccept(state: ProactiveState): ProactiveState {
  return { ...state, declineStreak: 0, notifiedInPeriod: true }
}

/** 用户点了「关闭提醒」。引擎从此安静，直到显式重新打开。 */
export function recordDisable(state: ProactiveState): ProactiveState {
  return { ...state, disabled: true, declineStreak: 0 }
}

/** 用户重新打开提醒。 */
export function recordEnable(state: ProactiveState): ProactiveState {
  return { ...state, disabled: false, declineStreak: 0, notifiedInPeriod: false }
}

// ───────────────────────────── 持久化（插件现有的 user_flags） ─────────────────────────────

/** user_flags 的读写口；装配侧用 getUserFlag / setUserFlag 包一层传进来，本模块不直接碰库。 */
export interface FlagStore {
  get(key: string): string | null
  set(key: string, value: string): void
}

/** 旧装配就在用的关闭标记：仍是「关没关」的权威来源，重启后关闭照旧成立。 */
export const PROACTIVE_DISABLED_FLAG = 'proactive_disabled'
/** 冷却与连续拒绝计数：重启后不该让刚提醒过的用户马上又被打扰一次。 */
export const PROACTIVE_STATE_FLAG = 'proactive_state'

/** 从 user_flags 恢复。空闲段是瞬时信息，不持久（重启后由第一拍采样重新判定）。 */
export function restoreProactiveState(flags: FlagStore): ProactiveState {
  let saved: Partial<ProactiveState> = {}
  try {
    const raw = flags.get(PROACTIVE_STATE_FLAG)
    if (raw) saved = JSON.parse(raw) as Partial<ProactiveState>
  } catch { /* 写坏的状态当成没有：最坏多一次冷却外的提醒判定，不会误开已关闭的提醒。 */ }
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  return {
    ...INITIAL_PROACTIVE_STATE,
    lastNotifiedAt: number(saved.lastNotifiedAt),
    declineStreak: Math.max(0, Math.floor(number(saved.declineStreak) ?? 0)),
    disabled: flags.get(PROACTIVE_DISABLED_FLAG) === 'true',
  }
}

export function persistProactiveState(flags: FlagStore, state: ProactiveState): void {
  flags.set(PROACTIVE_DISABLED_FLAG, state.disabled ? 'true' : 'false')
  flags.set(PROACTIVE_STATE_FLAG, JSON.stringify({ lastNotifiedAt: state.lastNotifiedAt, declineStreak: state.declineStreak }))
}

// ───────────────────────────── 提醒 → 帮助 episode 的装配 ─────────────────────────────

/** HelpEpisodeStore 满足这个形状（help-context.ts）。 */
export interface ProactiveEpisodes {
  offer(now: number, idlePeriodStart: number | null): unknown
  accept(now: number, facts: () => unknown): unknown
  decline(now: number): unknown
  active(now: number): unknown
}

export type ProactiveFeedback = 'accept' | 'decline' | 'disable' | 'enable'

/**
 * 主动提醒的一站式装配：评估 → 弹气泡时记 episode → 用户点选时推进状态机与 episode → 落 user_flags。
 *
 * 结构性的「不做」都在这里：拒绝、关闭、不回应三条路上 facts 根本不会被调用（不生成候选、不读任何东西）；
 * 已经在一起看的时候不再提醒；关闭写进 user_flags，重启后仍然关闭。
 * 本类不设定时器、不碰文件：装配侧负责周期调用 evaluate 与转发点选。
 */
export class ProactiveHelpFlow {
  private current: ProactiveState
  private readonly flags: FlagStore
  private readonly episodes: ProactiveEpisodes | undefined
  private readonly config: ProactiveConfig
  private readonly facts: () => unknown

  constructor(options: { flags: FlagStore; config: ProactiveConfig; episodes?: ProactiveEpisodes; facts: () => unknown }) {
    this.flags = options.flags
    this.episodes = options.episodes
    this.config = options.config
    this.facts = options.facts
    this.current = restoreProactiveState(options.flags)
  }

  get state(): ProactiveState {
    return { ...this.current }
  }

  /** 评估一拍；真的要提醒时先记一条 offered episode，再把决定交给装配侧推气泡。 */
  evaluate(input: ProactiveInput): ProactiveDecision {
    const engaged = input.engaged === true || (this.episodes?.active(input.now) ?? null) !== null
    const before = this.current
    const { state, decision } = evaluateProactive(before, { ...input, engaged }, this.config)
    this.current = state
    if (decision.kind !== 'none') {
      this.episodes?.offer(input.now, state.idlePeriodStart)
      persistProactiveState(this.flags, state)
    }
    return decision
  }

  /** 用户在气泡上的点选。只有「好」会生成候选；其余几条路什么都不读。 */
  feedback(kind: ProactiveFeedback, now: number): void {
    if (kind === 'accept') {
      this.current = recordAccept(this.current)
      this.episodes?.accept(now, this.facts)
    } else if (kind === 'decline') {
      this.current = recordDecline(this.current)
      this.episodes?.decline(now)
    } else if (kind === 'disable') {
      this.current = recordDisable(this.current)
      this.episodes?.decline(now)
    } else {
      this.current = recordEnable(this.current)
    }
    persistProactiveState(this.flags, this.current)
  }
}
