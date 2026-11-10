/**
 * 主动帮助的策略引擎（design.md §2.7「主动帮助」；四大块设计 §4.7「主动陪伴增强」）。
 *
 * 设计原文的边界，逐条落在这里：
 * - 触发：无输入超过阈值（首轮建议 8 分钟，可配置实验值，不是人的认知判断），
 *   且不在会议 / 演示 / 免打扰 / 投屏 / 锁屏 —— 落到本项目就是专注模式开着、会议中、
 *   投屏中、锁屏中、或角色被隐藏时不提醒。
 * - 频控：同一任务最多提醒一次、默认冷却 60 分钟。"任务"边界没有可靠信号，
 *   所以取保守下界：一个连续空闲期最多提醒一次，跨空闲期再叠加全局冷却。
 * - episode 治理（§4.7）：每天最多 maxOffersPerDay 次（默认 1）、同主题 topicCooldownMs
 *   冷却（默认 24h）、offer 发出后 offerTtlMs（默认 2 分钟）无响应自动到期关闭，
 *   关闭后进 closedTopics —— 不追问、不换渠道，须用户显式 enableTopic 才解除。
 * - 形式：先只显示无声小气泡；建议内容来自可观察事实（offerSource 由装配注入），
 *   不推断情绪/健康。用户不回应就到此为止 —— 不读取更多资料、不开始代理任务。
 *   这些"不做"是结构性的：本模块只产生文案，产生不了任何资料读取或任务派发。
 * - 反复拒绝时建议关闭；用户关闭后彻底安静，直到他重新打开。关闭陪伴不取消委托提醒、
 *   不停采样、不删记忆（本模块根本不碰那些真源）。
 *
 * 评估是**拉模型**：上层定时器周期性地用最新采样调 evaluate，拿到决策再执行副作用。
 * 本模块不设定时器、不碰文件、不发网络请求 —— 所有输入显式传入，全部状态显式持有，
 * 决策对同样的 (state, input, config) 永远一样，这才测试得住。
 *
 * 向后兼容：不注入 offerSource 时（旧装配），保持 §2.7 的旧行为 —— 不做 episode 治理、
 * 决策不带 topicKey、同一天可多次提醒。注入 offerSource 后（§4.7 新装配）治理才生效。
 */
import { localDateOf } from './time.ts'

export interface ProactiveConfig {
  /** 功能总开关（用户显式关掉后引擎直接安静）。 */
  enabled: boolean
  /** 触发提醒的无输入时长下限（毫秒）。 */
  idleMs: number
  /** 两次提醒之间的最小间隔（毫秒），跨空闲期生效。 */
  cooldownMs: number
  /** 每个本地日最多发出几次陪伴 offer（§4.7）；缺省 1。仅在注入 offerSource 时记账生效。 */
  maxOffersPerDay?: number
  /** 同一主题两次 offer 的最小间隔（毫秒，§4.7）；缺省 24 小时。 */
  topicCooldownMs?: number
  /** offer 发出后多久无响应即到期关闭（毫秒，§4.7）；缺省 2 分钟。 */
  offerTtlMs?: number
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
  /** 锁屏中（§4.7）：用户不在机器前，静默。缺省按未锁屏处理，与旧装配兼容。 */
  locked?: boolean
  /** 投屏 / 屏幕共享中（§4.7）：内容会出现在别人屏幕上，静默。缺省按未投屏处理。 */
  screenSharing?: boolean
  /** 已经在一起看（主动帮助 episode 进行中）：不再重复打扰。 */
  engaged?: boolean
}

export type ProactiveDecision =
  | { kind: 'remind'; message: string; topicKey?: string }
  | { kind: 'suggest-disable'; message: string; topicKey?: string }
  | { kind: 'none'; reason: ProactiveSkipReason }

export type ProactiveSkipReason =
  | 'disabled'
  | 'capture-inactive'
  | 'stale-sample'
  | 'not-development-app'
  | 'task-running'
  | 'focus-mode'
  | 'meeting'
  | 'locked'
  | 'screen-sharing'
  | 'stage-hidden'
  | 'help-in-progress'
  | 'no-idle-data'
  | 'not-idle-enough'
  | 'cooldown'
  | 'already-reminded-in-period'
  | 'declined-out'
  | 'daily-cap'
  | 'topic-cooldown'
  | 'topic-closed'

/** 一条已经发出、还没被回应（接受/拒绝）的陪伴 offer；到期无响应即自动关闭。 */
export interface ProactiveOpenEpisode {
  topicKey: string
  offeredAt: number
  expiresAt: number
}

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
  /** 当日计数归属的本地日期键（YYYY-MM-DD）；null = 还没评估过。跨天把 offersToday 清零。 */
  dayKey: string | null
  /** 本地日期键 dayKey 当天已经发出的 offer 次数（§4.7 每天上限）。 */
  offersToday: number
  /** 每个主题上次 offer 的时刻（§4.7 同主题冷却）。 */
  topicLastOfferedAt: Record<string, number>
  /** 当前待回应的 offer；null = 没有。到期无响应自动关闭并进 closedTopics。 */
  openEpisode: ProactiveOpenEpisode | null
  /** 无响应到期关闭的主题：不追问、不换渠道，须用户显式 enableTopic 才解除。 */
  closedTopics: string[]
}

/** 连续拒绝到几次之后，下一次候选改成"要不要干脆关掉"。 */
export const DECLINE_THRESHOLD = 3

export const REMIND_MESSAGE = '需要我一起看一下吗？'
export const SUGGEST_DISABLE_MESSAGE = '这段时间你都没需要我 —— 要我把主动提醒关掉吗？'

/** §4.7 治理默认值：每天 1 次、同主题 24h 冷却、offer 2 分钟无响应到期。 */
export const DEFAULT_MAX_OFFERS_PER_DAY = 1
export const DEFAULT_TOPIC_COOLDOWN_MS = 24 * 60 * 60_000
export const DEFAULT_OFFER_TTL_MS = 120_000
/** offerSource 缺省/返回 null 时回退用的中性主题键。 */
export const IDLE_HELP_TOPIC = 'idle-help'

export const INITIAL_PROACTIVE_STATE: ProactiveState = {
  lastNotifiedAt: null,
  idlePeriodStart: null,
  notifiedInPeriod: false,
  declineStreak: 0,
  disabled: false,
  dayKey: null,
  offersToday: 0,
  topicLastOfferedAt: {},
  openEpisode: null,
  closedTopics: [],
}

/**
 * 评估一次候选。返回新状态与决策；不修改传入对象。
 *
 * 判定顺序有讲究：先判"这会儿就不该打扰"（开关 / 专注 / 会议 / 锁屏 / 投屏 / 隐藏），
 * 再判"还不算空闲"，最后才是频控（空闲期一次 / 全局冷却 / 每日上限）。原因：用户回来看
 * 结果时，第一眼要知道的是"为什么没提醒"，与人的直觉一致的顺序才好排查。
 *
 * 主题级闸门（topic-cooldown / topic-closed）需要知道候选主题，而主题来自装配注入的
 * offerSource —— 它只在成为真实候选后才被调用，所以那两个闸门在 ProactiveHelpFlow 里判。
 * 本纯函数只做不依赖主题的治理：跨天计数清零、到期自动关闭 openEpisode、每日上限。
 * 本函数不记账 offersToday / topicLastOfferedAt / openEpisode（那些要等主题确定后由 flow 记）。
 */
export function evaluateProactive(
  state: ProactiveState,
  input: ProactiveInput,
  config: ProactiveConfig,
): { state: ProactiveState; decision: ProactiveDecision } {
  const next: ProactiveState = { ...state }

  // 跨本地日：当日 offer 计数清零（每天≤N 次）。日期键用与采样/日报一致的本地口径。
  const today = localDateOf(input.now)
  if (next.dayKey !== today) {
    next.dayKey = today
    next.offersToday = 0
  }

  // 每拍先关闭过期 openEpisode：无响应到期 → 进 closedTopics，不追问、不换渠道。
  if (next.openEpisode !== null && input.now >= next.openEpisode.expiresAt) {
    const topic = next.openEpisode.topicKey
    if (!next.closedTopics.includes(topic)) next.closedTopics = [...next.closedTopics, topic]
    next.openEpisode = null
  }

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
  if (input.locked === true) return skip('locked')
  if (input.screenSharing === true) return skip('screen-sharing')
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
  if (next.offersToday >= (config.maxOffersPerDay ?? DEFAULT_MAX_OFFERS_PER_DAY)) return skip('daily-cap')

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

/**
 * 用户显式重新启用某个到期关闭的主题（§4.7）：从 closedTopics 移除。
 * 只解除"关闭"，不清同主题冷却与当日计数 —— 那些闸门照常生效。
 */
export function recordEnableTopic(state: ProactiveState, topicKey: string): ProactiveState {
  return { ...state, closedTopics: state.closedTopics.filter(topic => topic !== topicKey) }
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

/**
 * 从 user_flags 恢复。空闲段是瞬时信息，不持久（重启后由第一拍采样重新判定）。
 * 治理状态（当日计数、主题冷却、待回应 offer、关闭主题）跨重启成立；坏值一律降级成
 * 安全默认（最坏多一次冷却外的判定，绝不会误开已关闭的主题或误复活已关闭的提醒）。
 */
export function restoreProactiveState(flags: FlagStore): ProactiveState {
  let saved: Record<string, unknown> = {}
  try {
    const raw = flags.get(PROACTIVE_STATE_FLAG)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>
    }
  } catch { /* 写坏的状态当成没有。 */ }
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const count = (value: unknown) => Math.max(0, Math.floor(number(value) ?? 0))

  // 主题冷却表：只保留键为非空字符串、值为有限数字的条目。
  const topicLastOfferedAt: Record<string, number> = {}
  const rawTopics = saved.topicLastOfferedAt
  if (rawTopics && typeof rawTopics === 'object' && !Array.isArray(rawTopics)) {
    for (const [key, value] of Object.entries(rawTopics as Record<string, unknown>)) {
      const at = number(value)
      if (key && at !== null) topicLastOfferedAt[key] = at
    }
  }

  // 待回应 offer：形状不对（缺字段/类型错）当成 null，绝不凭空恢复一条半截 offer。
  let openEpisode: ProactiveOpenEpisode | null = null
  const rawOpen = saved.openEpisode
  if (rawOpen && typeof rawOpen === 'object' && !Array.isArray(rawOpen)) {
    const row = rawOpen as Record<string, unknown>
    const offeredAt = number(row.offeredAt)
    const expiresAt = number(row.expiresAt)
    if (typeof row.topicKey === 'string' && row.topicKey && offeredAt !== null && expiresAt !== null) {
      openEpisode = { topicKey: row.topicKey, offeredAt, expiresAt }
    }
  }

  // 关闭主题：只保留非空字符串并去重。
  const closedTopics: string[] = []
  if (Array.isArray(saved.closedTopics)) {
    for (const item of saved.closedTopics) {
      if (typeof item === 'string' && item && !closedTopics.includes(item)) closedTopics.push(item)
    }
  }

  return {
    ...INITIAL_PROACTIVE_STATE,
    lastNotifiedAt: number(saved.lastNotifiedAt),
    declineStreak: count(saved.declineStreak),
    disabled: flags.get(PROACTIVE_DISABLED_FLAG) === 'true',
    dayKey: typeof saved.dayKey === 'string' && saved.dayKey ? saved.dayKey : null,
    offersToday: count(saved.offersToday),
    topicLastOfferedAt,
    openEpisode,
    closedTopics,
  }
}

export function persistProactiveState(flags: FlagStore, state: ProactiveState): void {
  flags.set(PROACTIVE_DISABLED_FLAG, state.disabled ? 'true' : 'false')
  flags.set(PROACTIVE_STATE_FLAG, JSON.stringify({
    lastNotifiedAt: state.lastNotifiedAt,
    declineStreak: state.declineStreak,
    dayKey: state.dayKey,
    offersToday: state.offersToday,
    topicLastOfferedAt: state.topicLastOfferedAt,
    openEpisode: state.openEpisode,
    closedTopics: state.closedTopics,
  }))
}

// ───────────────────────────── 提醒 → 帮助 episode 的装配 ─────────────────────────────

/** HelpEpisodeStore 满足这个形状（help-context.ts）。 */
export interface ProactiveEpisodes {
  offer(now: number, idlePeriodStart: number | null): unknown
  accept(now: number, facts: () => unknown): unknown
  decline(now: number): unknown
  active(now: number): unknown
}

export type ProactiveFeedback = 'accept' | 'decline' | 'disable' | 'enable' | 'enable-topic'

/** 事实型建议源（§4.7）：只描述可观察事实，不推断情绪/健康。由装配注入，本模块不读资料。 */
export type ProactiveOfferSource = () => { topicKey: string; message: string } | null

/**
 * 主动提醒的一站式装配：评估 → 弹气泡时记 episode → 用户点选时推进状态机与 episode → 落 user_flags。
 *
 * 结构性的「不做」都在这里：拒绝、关闭、不回应三条路上 facts / offerSource 根本不会被调用
 * （不生成候选、不读任何东西）；已经在一起看的时候不再提醒；关闭写进 user_flags，重启后仍然关闭。
 * 本类不设定时器、不碰文件：装配侧负责周期调用 evaluate 与转发点选。
 *
 * episode 治理（每日上限 / 同主题冷却 / 到期关闭 / closedTopics）只在注入 offerSource 时生效：
 * 候选主题由 offerSource 决定，故主题级闸门在拿到主题后才判；不注入时保持 §2.7 旧行为。
 */
export class ProactiveHelpFlow {
  private current: ProactiveState
  private readonly flags: FlagStore
  private readonly episodes: ProactiveEpisodes | undefined
  private readonly config: ProactiveConfig
  private readonly facts: () => unknown
  private readonly offerSource: ProactiveOfferSource | undefined

  constructor(options: {
    flags: FlagStore
    config: ProactiveConfig
    episodes?: ProactiveEpisodes
    facts: () => unknown
    offerSource?: ProactiveOfferSource
  }) {
    this.flags = options.flags
    this.episodes = options.episodes
    this.config = options.config
    this.facts = options.facts
    this.offerSource = options.offerSource
    this.current = restoreProactiveState(options.flags)
  }

  get state(): ProactiveState {
    return { ...this.current }
  }

  /** 治理状态是否变化（跨天清零 / 到期关闭）：用于决定 none 拍要不要落盘。 */
  private governanceChanged(before: ProactiveState, after: ProactiveState): boolean {
    return before.dayKey !== after.dayKey
      || before.offersToday !== after.offersToday
      || before.openEpisode !== after.openEpisode
      || before.closedTopics !== after.closedTopics
  }

  /**
   * 评估一拍；真的要提醒时先记一条 offered episode，再把决定交给装配侧推气泡。
   * offerSource 只在纯引擎判定为真实候选后才调用；拒绝/关闭/各类 skip 路径上一律不调用。
   */
  evaluate(input: ProactiveInput): ProactiveDecision {
    const engaged = input.engaged === true || (this.episodes?.active(input.now) ?? null) !== null
    const before = this.current
    const { state, decision } = evaluateProactive(before, { ...input, engaged }, this.config)
    this.current = state

    if (decision.kind === 'none') {
      // 到期自动关闭 / 跨天清零可能改了治理状态，落盘以便重启后成立。
      if (this.governanceChanged(before, state)) persistProactiveState(this.flags, state)
      return decision
    }

    // 旧装配（无 offerSource）：保持 §2.7 旧行为 —— 不做治理记账、决策不带 topicKey。
    if (this.offerSource === undefined) {
      this.episodes?.offer(input.now, state.idlePeriodStart)
      persistProactiveState(this.flags, state)
      return decision
    }

    // 真实候选才问事实型建议源；返回 null 回退中性固定文案 + idle-help 主题。
    const offer = this.offerSource()
    const topicKey = offer && typeof offer.topicKey === 'string' && offer.topicKey ? offer.topicKey : IDLE_HELP_TOPIC
    const message = decision.kind === 'suggest-disable'
      ? SUGGEST_DISABLE_MESSAGE
      : (offer && typeof offer.message === 'string' && offer.message ? offer.message : REMIND_MESSAGE)

    // 主题级闸门（需要 topicKey，故在 offerSource 之后）。被拦下不算打扰：撤销纯引擎的候选记账，
    // 不消耗全局冷却、不记当日 offer、不开 episode。
    const topicCooldownMs = this.config.topicCooldownMs ?? DEFAULT_TOPIC_COOLDOWN_MS
    const lastOfferedAt = state.topicLastOfferedAt[topicKey]
    const blocked: ProactiveSkipReason | null = state.closedTopics.includes(topicKey)
      ? 'topic-closed'
      : (typeof lastOfferedAt === 'number' && Number.isFinite(lastOfferedAt) && input.now - lastOfferedAt < topicCooldownMs)
        ? 'topic-cooldown'
        : null
    if (blocked !== null) {
      this.current = { ...state, lastNotifiedAt: before.lastNotifiedAt, notifiedInPeriod: false }
      if (this.governanceChanged(before, this.current)) persistProactiveState(this.flags, this.current)
      return { kind: 'none', reason: blocked }
    }

    // 记账：当日计数 +1、主题冷却起点、开一条待回应 offer（offerTtlMs 无响应自动关闭）。
    const offerTtlMs = this.config.offerTtlMs ?? DEFAULT_OFFER_TTL_MS
    const recorded: ProactiveState = {
      ...state,
      offersToday: state.offersToday + 1,
      topicLastOfferedAt: { ...state.topicLastOfferedAt, [topicKey]: input.now },
      openEpisode: { topicKey, offeredAt: input.now, expiresAt: input.now + offerTtlMs },
    }
    this.current = recorded
    this.episodes?.offer(input.now, recorded.idlePeriodStart)
    persistProactiveState(this.flags, recorded)
    return { kind: decision.kind, message, topicKey }
  }

  /**
   * 用户在气泡上的点选。只有「好」会生成候选；其余几条路什么都不读（facts / offerSource 都不调用）。
   * topicKey 仅 'enable-topic' 用；旧调用不传第三个参数照常工作（向后兼容）。
   */
  feedback(kind: ProactiveFeedback, now: number, topicKey?: string): void {
    if (kind === 'accept') {
      // 已回应：清掉待回应 offer（不是到期关闭，不进 closedTopics）。
      this.current = { ...recordAccept(this.current), openEpisode: null }
      this.episodes?.accept(now, this.facts)
    } else if (kind === 'decline') {
      this.current = { ...recordDecline(this.current), openEpisode: null }
      this.episodes?.decline(now)
    } else if (kind === 'disable') {
      this.current = { ...recordDisable(this.current), openEpisode: null }
      this.episodes?.decline(now)
    } else if (kind === 'enable-topic') {
      if (typeof topicKey === 'string' && topicKey) this.current = recordEnableTopic(this.current, topicKey)
    } else {
      this.current = recordEnable(this.current)
    }
    persistProactiveState(this.flags, this.current)
  }

  /** 用户显式重新启用某个到期关闭的主题（feedback('enable-topic') 的便捷等价）。 */
  enableTopic(topicKey: string, now: number): void {
    this.feedback('enable-topic', now, topicKey)
  }
}
