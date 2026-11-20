/**
 * 主动陪伴增强（四大块设计 §4.7）的 episode 治理测试。
 *
 * 每条都是"打扰用户"或"越权读取"的闸门：每天上限、同主题冷却、offer 到期自动关闭后
 * 不追问不换渠道（须显式 enableTopic 才解除）、锁屏/投屏静默、建议源只在真实候选时被问、
 * 拒绝/关闭/到期路径一个字节都不读、坏持久化值降级成安全默认、治理状态跨重启成立。
 * 同时守住向后兼容：不注入 offerSource 的旧装配保持 §2.7 旧行为。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ProactiveHelpFlow,
  evaluateProactive,
  restoreProactiveState,
  persistProactiveState,
  recordEnableTopic,
  INITIAL_PROACTIVE_STATE,
  REMIND_MESSAGE,
  IDLE_HELP_TOPIC,
  PROACTIVE_STATE_FLAG,
  PROACTIVE_DISABLED_FLAG,
  type FlagStore,
  type ProactiveConfig,
  type ProactiveEpisodes,
  type ProactiveInput,
  type ProactiveState,
} from '../src/proactive.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** 固定基准：2026-06-15 正午 UTC。+25h 在任何时区都跨入下一个本地日；≤3h 都还在同一本地日。 */
const T0 = Date.UTC(2026, 5, 15, 12, 0, 0)
const FACT_MESSAGE = '要不要把刚才确认的行动项加入待办？'

const baseConfig: ProactiveConfig = {
  enabled: true, idleMs: 480_000, cooldownMs: HOUR,
  maxOffersPerDay: 1, topicCooldownMs: DAY, offerTtlMs: 120_000,
}

function memoryFlags(seed: Record<string, string> = {}): FlagStore {
  const map = new Map<string, string>(Object.entries(seed))
  return { get: key => map.get(key) ?? null, set: (key, value) => { map.set(key, value) } }
}

function input(now: number, overrides: Partial<ProactiveInput> = {}): ProactiveInput {
  return {
    now, idleMs: 600_000, focusMode: false, stageVisible: true, captureActive: true,
    sampleAt: now, sampleIntervalMs: 5000, developmentApp: true, taskRunning: false, ...overrides,
  }
}

/** 让用户"回来动一下"，结束当前空闲期；下一拍空闲才算新的一段。 */
function resetIdle(flow: ProactiveHelpFlow, now: number): void {
  flow.evaluate(input(now, { idleMs: 1000 }))
}

function makeFlow(opts: {
  config?: ProactiveConfig
  flags?: FlagStore
  offer?: () => { topicKey: string; message: string } | null
  legacy?: boolean
} = {}) {
  const flags = opts.flags ?? memoryFlags()
  let offerCalls = 0
  let factsCalls = 0
  const episodeCalls = { offer: 0, accept: 0, decline: 0 }
  const episodes: ProactiveEpisodes = {
    offer: () => { episodeCalls.offer += 1; return {} },
    accept: (_now: number, facts: () => unknown) => { episodeCalls.accept += 1; facts(); return {} },
    decline: () => { episodeCalls.decline += 1; return {} },
    active: () => null,
  }
  const flow = new ProactiveHelpFlow({
    flags,
    config: opts.config ?? baseConfig,
    episodes,
    facts: () => { factsCalls += 1; return {} },
    offerSource: opts.legacy
      ? undefined
      : () => { offerCalls += 1; return opts.offer ? opts.offer() : { topicKey: 'action-items', message: FACT_MESSAGE } },
  })
  return { flow, flags, calls: () => offerCalls, factsCalls: () => factsCalls, episodeCalls }
}

test('每日上限：同一天最多 1 次 offer，第二次候选被 daily-cap 拦；跨本地日计数清零恢复', () => {
  const h = makeFlow()
  const d1 = h.flow.evaluate(input(T0))
  assert.equal(d1.kind, 'remind')
  if (d1.kind === 'remind') {
    assert.equal(d1.topicKey, 'action-items')
    assert.equal(d1.message, FACT_MESSAGE)
  }
  assert.equal(h.flow.state.offersToday, 1)
  assert.equal(h.calls(), 1)

  // 回应一下清掉待回应 offer，避免到期关闭干扰本用例。
  h.flow.feedback('decline', T0 + 1000)
  resetIdle(h.flow, T0 + 30 * 60_000)
  const d2 = h.flow.evaluate(input(T0 + 2 * HOUR))
  assert.deepEqual(d2, { kind: 'none', reason: 'daily-cap' })
  assert.equal(h.calls(), 1, 'daily-cap 在纯引擎拦住，offerSource 不该再被调用')
  assert.equal(h.flow.state.offersToday, 1)

  // 跨本地日（+25h 保证进入下一天）：计数清零，恢复一次 offer。
  resetIdle(h.flow, T0 + 25 * HOUR - 60_000)
  const d3 = h.flow.evaluate(input(T0 + 25 * HOUR))
  assert.equal(d3.kind, 'remind')
  assert.equal(h.flow.state.offersToday, 1)
  assert.equal(h.calls(), 2)
})

test('同主题 24h 冷却：同主题第二次被 topic-cooldown 拦，换主题不受影响，满 24h 恢复', () => {
  let topic = 'action-items'
  const h = makeFlow({
    config: { ...baseConfig, maxOffersPerDay: 10 },
    offer: () => ({ topicKey: topic, message: `建议:${topic}` }),
  })
  const d1 = h.flow.evaluate(input(T0))
  assert.equal(d1.kind, 'remind')
  if (d1.kind === 'remind') assert.equal(d1.topicKey, 'action-items')
  h.flow.feedback('decline', T0 + 1000)

  resetIdle(h.flow, T0 + 30 * 60_000)
  const d2 = h.flow.evaluate(input(T0 + 2 * HOUR))
  assert.deepEqual(d2, { kind: 'none', reason: 'topic-cooldown' })
  assert.equal(h.flow.state.offersToday, 1, '被主题冷却拦下不算一次 offer')
  assert.equal(h.flow.state.lastNotifiedAt, T0, '被拦下不消耗全局冷却')

  // 换个主题：不受 action-items 冷却影响。
  topic = 'meeting-todo'
  resetIdle(h.flow, T0 + 2 * HOUR + 30 * 60_000)
  const d3 = h.flow.evaluate(input(T0 + 3 * HOUR))
  assert.equal(d3.kind, 'remind')
  if (d3.kind === 'remind') assert.equal(d3.topicKey, 'meeting-todo')
  h.flow.feedback('decline', T0 + 3 * HOUR + 1000)

  // action-items 满 24h 后恢复。
  topic = 'action-items'
  resetIdle(h.flow, T0 + 25 * HOUR - 60_000)
  const d4 = h.flow.evaluate(input(T0 + 25 * HOUR))
  assert.equal(d4.kind, 'remind')
  if (d4.kind === 'remind') assert.equal(d4.topicKey, 'action-items')
})

test('offer 2 分钟无响应自动到期关闭进 closedTopics；同主题不再 offer 直到显式 enableTopic', () => {
  const h = makeFlow({ config: { ...baseConfig, maxOffersPerDay: 10 } })
  const d1 = h.flow.evaluate(input(T0))
  assert.equal(d1.kind, 'remind')
  assert.deepEqual(h.flow.state.openEpisode, { topicKey: 'action-items', offeredAt: T0, expiresAt: T0 + 120_000 })

  // 不回应，越过 2 分钟：下一拍自动关闭（不追问），主题进 closedTopics。
  const tick = h.flow.evaluate(input(T0 + 120_001))
  assert.equal(tick.kind, 'none')
  assert.equal(h.flow.state.openEpisode, null)
  assert.deepEqual(h.flow.state.closedTopics, ['action-items'])

  // 即使过了 24h 主题冷却、跨了天，closedTopics 仍拦着同主题（不追问、不换渠道）。
  resetIdle(h.flow, T0 + 25 * HOUR - 60_000)
  const d2 = h.flow.evaluate(input(T0 + 25 * HOUR))
  assert.deepEqual(d2, { kind: 'none', reason: 'topic-closed' })
  assert.equal(h.flow.state.offersToday, 0, '被 topic-closed 拦下不算 offer')

  // 用户显式 enableTopic 才解除。
  h.flow.enableTopic('action-items', T0 + 25 * HOUR + 1000)
  assert.deepEqual(h.flow.state.closedTopics, [])
  resetIdle(h.flow, T0 + 25 * HOUR + 30 * 60_000)
  const d3 = h.flow.evaluate(input(T0 + 26 * HOUR))
  assert.equal(d3.kind, 'remind')
  if (d3.kind === 'remind') assert.equal(d3.topicKey, 'action-items')
})

test('锁屏 / 投屏静默：紧邻会议判定，不消耗冷却与当日计数，也不调用 offerSource', () => {
  const locked = evaluateProactive(INITIAL_PROACTIVE_STATE, input(T0, { locked: true }), baseConfig)
  assert.deepEqual(locked.decision, { kind: 'none', reason: 'locked' })
  assert.equal(locked.state.lastNotifiedAt, null)
  assert.equal(locked.state.offersToday, 0)

  const sharing = evaluateProactive(INITIAL_PROACTIVE_STATE, input(T0, { screenSharing: true }), baseConfig)
  assert.deepEqual(sharing.decision, { kind: 'none', reason: 'screen-sharing' })
  assert.equal(sharing.state.lastNotifiedAt, null)

  const h = makeFlow()
  assert.deepEqual(h.flow.evaluate(input(T0, { locked: true })), { kind: 'none', reason: 'locked' })
  assert.deepEqual(h.flow.evaluate(input(T0, { screenSharing: true })), { kind: 'none', reason: 'screen-sharing' })
  assert.deepEqual(h.flow.evaluate(input(T0, { meetingActive: true })), { kind: 'none', reason: 'meeting' })
  assert.equal(h.calls(), 0)
  assert.equal(h.flow.state.lastNotifiedAt, null)
  // 解除后照常提醒。
  assert.equal(h.flow.evaluate(input(T0 + 1000)).kind, 'remind')
  assert.equal(h.calls(), 1)
})

test('offerSource 只在真实候选时调用；各类 skip 与拒绝/关闭/启用反馈都不调用', () => {
  const h = makeFlow()
  h.flow.evaluate(input(T0, { focusMode: true }))
  h.flow.evaluate(input(T0, { locked: true }))
  h.flow.evaluate(input(T0, { screenSharing: true }))
  h.flow.evaluate(input(T0, { meetingActive: true }))
  h.flow.evaluate(input(T0, { stageVisible: false }))
  h.flow.evaluate(input(T0, { idleMs: 1000 }))
  assert.equal(h.calls(), 0, '各类 skip 都不该问建议源')

  assert.equal(h.flow.evaluate(input(T0)).kind, 'remind')
  assert.equal(h.calls(), 1)

  h.flow.feedback('decline', T0 + 1000)
  h.flow.feedback('disable', T0 + 2000)
  h.flow.feedback('enable', T0 + 3000)
  h.flow.feedback('enable-topic', T0 + 4000, 'action-items')
  assert.equal(h.calls(), 1, '反馈路径一律不调用 offerSource')

  // 每日上限拦住的候选也不调用 offerSource。
  resetIdle(h.flow, T0 + 30 * 60_000)
  assert.deepEqual(h.flow.evaluate(input(T0 + 2 * HOUR)), { kind: 'none', reason: 'daily-cap' })
  assert.equal(h.calls(), 1)
})

test('结构性边界：offer 不读事实；只有接受才读；拒绝/关闭/启用路径都不调用 offerSource 与 facts', () => {
  const h = makeFlow()
  assert.equal(h.flow.evaluate(input(T0)).kind, 'remind')
  assert.equal(h.calls(), 1)
  assert.equal(h.episodeCalls.offer, 1)
  assert.equal(h.factsCalls(), 0, 'offer 阶段不读任何事实')

  h.flow.feedback('accept', T0 + 1000)
  assert.equal(h.factsCalls(), 1, '只有接受才生成候选/读事实')
  assert.equal(h.episodeCalls.accept, 1)
  assert.equal(h.calls(), 1, '接受不再调用 offerSource')

  const factsBefore = h.factsCalls()
  h.flow.feedback('decline', T0 + 2000)
  h.flow.feedback('disable', T0 + 3000)
  h.flow.feedback('enable', T0 + 4000)
  h.flow.feedback('enable-topic', T0 + 5000, 'action-items')
  assert.equal(h.factsCalls(), factsBefore, '拒绝/关闭/启用路径都不读事实')
  assert.equal(h.calls(), 1, '反馈路径一律不调用 offerSource')
})

test('offerSource 返回 null 时回退中性固定文案与 idle-help 主题', () => {
  const h = makeFlow({ offer: () => null })
  const d = h.flow.evaluate(input(T0))
  assert.equal(d.kind, 'remind')
  if (d.kind === 'remind') {
    assert.equal(d.message, REMIND_MESSAGE)
    assert.equal(d.topicKey, IDLE_HELP_TOPIC)
  }
  assert.equal(h.flow.state.openEpisode?.topicKey, IDLE_HELP_TOPIC)
  assert.deepEqual(h.flow.state.topicLastOfferedAt, { [IDLE_HELP_TOPIC]: T0 })
})

test('坏持久化值恢复：非法 JSON / 错类型字段一律降级成安全默认，不误开关闭主题', () => {
  const broken = memoryFlags({ [PROACTIVE_STATE_FLAG]: '{not json', [PROACTIVE_DISABLED_FLAG]: 'true' })
  const s0 = restoreProactiveState(broken)
  assert.equal(s0.disabled, true)
  assert.equal(s0.lastNotifiedAt, null)
  assert.equal(s0.offersToday, 0)
  assert.equal(s0.dayKey, null)
  assert.deepEqual(s0.topicLastOfferedAt, {})
  assert.equal(s0.openEpisode, null)
  assert.deepEqual(s0.closedTopics, [])

  const bad = memoryFlags({
    [PROACTIVE_STATE_FLAG]: JSON.stringify({
      lastNotifiedAt: 'abc', declineStreak: -5, offersToday: 'x', dayKey: 123,
      topicLastOfferedAt: { good: 500, bad: 'no', '': 9, nested: {} },
      openEpisode: { topicKey: 999, offeredAt: 'x' },
      closedTopics: ['A', 2, '', 'A', null, 'B'],
    }),
  })
  const s1 = restoreProactiveState(bad)
  assert.equal(s1.lastNotifiedAt, null)
  assert.equal(s1.declineStreak, 0)
  assert.equal(s1.offersToday, 0)
  assert.equal(s1.dayKey, null)
  assert.deepEqual(s1.topicLastOfferedAt, { good: 500 })
  assert.equal(s1.openEpisode, null)
  assert.deepEqual(s1.closedTopics, ['A', 'B'])

  // 合法治理状态往返一致。
  const flags = memoryFlags()
  const state: ProactiveState = {
    ...INITIAL_PROACTIVE_STATE, lastNotifiedAt: T0, declineStreak: 2, dayKey: '2026-06-15', offersToday: 1,
    topicLastOfferedAt: { 'action-items': T0 },
    openEpisode: { topicKey: 'action-items', offeredAt: T0, expiresAt: T0 + 120_000 },
    closedTopics: ['old-topic'],
  }
  persistProactiveState(flags, state)
  assert.deepEqual(restoreProactiveState(flags), state)
})

test('治理状态跨重启成立：closedTopics / 当日计数 / 主题冷却落 user_flags，重启后照旧拦', () => {
  const flags = memoryFlags()
  const config: ProactiveConfig = { ...baseConfig, maxOffersPerDay: 10 }
  const h1 = makeFlow({ flags, config })
  h1.flow.evaluate(input(T0))
  h1.flow.evaluate(input(T0 + 120_001)) // 无响应到期关闭
  assert.deepEqual(h1.flow.state.closedTopics, ['action-items'])

  // 重启：同一份 flags、新的状态机。
  const h2 = makeFlow({ flags, config })
  assert.deepEqual(h2.flow.state.closedTopics, ['action-items'])
  assert.equal(h2.flow.state.offersToday, 1)
  assert.deepEqual(h2.flow.state.topicLastOfferedAt, { 'action-items': T0 })
  resetIdle(h2.flow, T0 + 2 * HOUR - 60_000)
  assert.deepEqual(h2.flow.evaluate(input(T0 + 2 * HOUR)), { kind: 'none', reason: 'topic-closed' })
})

test('recordEnableTopic 与 feedback(enable-topic) 只移除指定主题，不动其他治理状态', () => {
  const s: ProactiveState = { ...INITIAL_PROACTIVE_STATE, closedTopics: ['A', 'B'], offersToday: 1, topicLastOfferedAt: { A: 100 } }
  const s2 = recordEnableTopic(s, 'A')
  assert.deepEqual(s2.closedTopics, ['B'])
  assert.equal(s2.offersToday, 1)
  assert.deepEqual(s2.topicLastOfferedAt, { A: 100 })
  assert.deepEqual(s.closedTopics, ['A', 'B'], '不改传入状态')

  const h = makeFlow({ flags: memoryFlags({ [PROACTIVE_STATE_FLAG]: JSON.stringify({ closedTopics: ['A', 'B'] }) }) })
  h.flow.feedback('enable-topic', T0, 'B')
  assert.deepEqual(h.flow.state.closedTopics, ['A'])
})

test('向后兼容：不注入 offerSource 时保持旧行为（决策不带 topicKey、同一天可多次提醒、不做治理记账）', () => {
  const h = makeFlow({ legacy: true })
  const d1 = h.flow.evaluate(input(T0))
  assert.deepEqual(d1, { kind: 'remind', message: REMIND_MESSAGE })
  assert.equal(h.calls(), 0)
  assert.equal(h.flow.state.offersToday, 0, '旧装配不做当日计数')
  h.flow.feedback('decline', T0 + 1000)
  resetIdle(h.flow, T0 + 30 * 60_000)
  const d2 = h.flow.evaluate(input(T0 + 2 * HOUR))
  assert.deepEqual(d2, { kind: 'remind', message: REMIND_MESSAGE }, '同一天第二次仍提醒（无每日上限）')
})