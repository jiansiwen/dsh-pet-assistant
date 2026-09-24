/**
 * 主动提醒（design.md §2.7）的策略引擎测试。
 *
 * 这一页上的每条规则都是"打扰用户"的闸门：缺一条，用户就会在一个没料到的时刻
 * 被桌面角色搭话。§2.7 的原文边界在这里逐条有对应的用例 —— 触发阈值、
 * 会议/免打扰限制、同一空闲期一次、60 分钟冷却、拒绝抑制、建议关闭、彻底安静。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  evaluateProactive,
  INITIAL_PROACTIVE_STATE,
  REMIND_MESSAGE,
  recordAccept,
  recordDecline,
  recordDisable,
  recordEnable,
  SUGGEST_DISABLE_MESSAGE,
  DECLINE_THRESHOLD,
  type ProactiveConfig,
  type ProactiveInput,
  type ProactiveState,
} from '../src/proactive.ts'
import { readLastSample, type Sample } from '../src/sampler.ts'
import { getUserFlag, openAssistantStore, setUserFlag } from '../src/store.ts'

const config: ProactiveConfig = { enabled: true, idleMs: 480_000, cooldownMs: 3_600_000 }

function input(overrides: Partial<ProactiveInput> = {}): ProactiveInput {
  return {
    now: 1_000_000, idleMs: 600_000, focusMode: false, stageVisible: true,
    captureActive: true, sampleAt: overrides.now ?? 1_000_000, sampleIntervalMs: 5000,
    developmentApp: true, taskRunning: false, ...overrides,
  }
}

test('够空闲的第一次：提醒，文案是设计原文的固定句', () => {
  const { state, decision } = evaluateProactive(INITIAL_PROACTIVE_STATE, input(), config)
  assert.equal(decision.kind, 'remind')
  if (decision.kind === 'remind') assert.equal(decision.message, REMIND_MESSAGE)
  // 打扰过就要记账：空闲期标记 + 全局冷却都从这一拍起算。
  assert.equal(state.notifiedInPeriod, true)
  assert.equal(state.lastNotifiedAt, input().now)
})

test('不够空闲不提醒；拿不到空闲数据也不提醒 —— 缺数据时宁可不猜', () => {
  const short = evaluateProactive(INITIAL_PROACTIVE_STATE, input({ idleMs: 479_999 }), config)
  assert.equal(short.decision.kind, 'none')
  if (short.decision.kind === 'none') assert.equal(short.decision.reason, 'not-idle-enough')

  const missing = evaluateProactive(INITIAL_PROACTIVE_STATE, input({ idleMs: null }), config)
  assert.equal(missing.decision.kind, 'none')
  if (missing.decision.kind === 'none') assert.equal(missing.decision.reason, 'no-idle-data')
  // 拿不到数据的这一拍不能把空闲期记上：下一拍有数据时它还是"第一次"。
  assert.equal(missing.state.idlePeriodStart, null)
})

test('停采样、过期样本、非开发应用和正在执行任务都不能触发提醒', () => {
  const cases: [Partial<ProactiveInput>, string][] = [
    [{ captureActive: false }, 'capture-inactive'],
    [{ sampleAt: null }, 'stale-sample'],
    [{ sampleAt: 984_999 }, 'stale-sample'],
    [{ sampleAt: 1_000_001 }, 'stale-sample'],
    [{ developmentApp: false }, 'not-development-app'],
    [{ taskRunning: true }, 'task-running'],
    [{ idleMs: NaN }, 'no-idle-data'],
    [{ idleMs: -1 }, 'no-idle-data'],
  ]
  for (const [overrides, reason] of cases) {
    const result = evaluateProactive(INITIAL_PROACTIVE_STATE, input(overrides), config)
    assert.deepEqual(result.decision, { kind: 'none', reason })
    assert.equal(result.state.lastNotifiedAt, null)
  }
})

test('同一个空闲期最多提醒一次', () => {
  const first = evaluateProactive(INITIAL_PROACTIVE_STATE, input(), config)
  const second = evaluateProactive(first.state, input({ now: 1_000_000 + 60_000 }), config)
  assert.equal(second.decision.kind, 'none')
  if (second.decision.kind === 'none') assert.equal(second.decision.reason, 'already-reminded-in-period')
})

test('用户回来动了一下，空闲期结束；冷却期内的新空闲期不再提醒', () => {
  const first = evaluateProactive(INITIAL_PROACTIVE_STATE, input(), config)

  // 有输入：空闲期重置
  const active = evaluateProactive(first.state, input({ idleMs: 5_000 }), config)
  assert.equal(active.state.idlePeriodStart, null)
  assert.equal(active.state.notifiedInPeriod, false)

  // 1 分钟后又走开 10 分钟：新空闲期，但距上次提醒 1 分钟，冷却拦住
  const soon = evaluateProactive(
    active.state,
    input({ now: input().now + 60_000 + 600_000, idleMs: 600_000 }),
    config,
  )
  assert.equal(soon.decision.kind, 'none')
  if (soon.decision.kind === 'none') assert.equal(soon.decision.reason, 'cooldown')

  // 冷却（默认 60 分钟）过了才提醒
  const later = evaluateProactive(
    active.state,
    input({ now: input().now + 3_600_000 + 600_000, idleMs: 600_000 }),
    config,
  )
  assert.equal(later.decision.kind, 'remind')
})

test('专注模式与角色隐藏都不提醒：会议/演示/免打扰是 §2.7 的硬限制', () => {
  const focus = evaluateProactive(INITIAL_PROACTIVE_STATE, input({ focusMode: true }), config)
  assert.equal(focus.decision.kind, 'none')
  if (focus.decision.kind === 'none') assert.equal(focus.decision.reason, 'focus-mode')

  const hidden = evaluateProactive(INITIAL_PROACTIVE_STATE, input({ stageVisible: false }), config)
  assert.equal(hidden.decision.kind, 'none')
  if (hidden.decision.kind === 'none') assert.equal(hidden.decision.reason, 'stage-hidden')
  // 这两种"不该打扰"都不能消耗冷却：等用户回来，提醒还在。
  assert.equal(focus.state.lastNotifiedAt, null)
  assert.equal(hidden.state.lastNotifiedAt, null)
})

test('连续拒绝三次后，下一次候选改成"要不要干脆关掉"', () => {
  let state: ProactiveState = INITIAL_PROACTIVE_STATE
  for (let i = 0; i < DECLINE_THRESHOLD; i += 1) {
    state = recordDecline(state)
  }
  const next = evaluateProactive(state, input(), config)
  assert.equal(next.decision.kind, 'suggest-disable')
  if (next.decision.kind === 'suggest-disable') assert.equal(next.decision.message, SUGGEST_DISABLE_MESSAGE)
})

test('用户关闭后彻底安静 —— 优先于一切条件，重启语义由装配侧的 user_flags 承担', () => {
  const disabled = recordDisable(INITIAL_PROACTIVE_STATE)
  const quiet = evaluateProactive(disabled, input(), config)
  assert.equal(quiet.decision.kind, 'none')
  if (quiet.decision.kind === 'none') assert.equal(quiet.decision.reason, 'disabled')

  // 重新打开后恢复：不再安静，而且这一拍就是一次正常候选。
  const enabled = recordEnable(disabled)
  const again = evaluateProactive(enabled, input(), config)
  assert.equal(again.decision.kind, 'remind')
})

test('用户点「好」清零连续拒绝计数：愿意互动是最强的"还想被提醒"信号', () => {
  let state: ProactiveState = INITIAL_PROACTIVE_STATE
  for (let i = 0; i < DECLINE_THRESHOLD; i += 1) state = recordDecline(state)
  state = recordAccept(state)
  const next = evaluateProactive(state, input(), config)
  assert.equal(next.decision.kind, 'remind', 'accept 之后不该再看到建议关闭')
})

test('evaluateProactive 不改传入状态：决策可重放', () => {
  const before: ProactiveState = { ...INITIAL_PROACTIVE_STATE }
  evaluateProactive(before, input(), config)
  assert.deepEqual(before, INITIAL_PROACTIVE_STATE)
})

test('readLastSample：从尾部取最新一条，被截断的半行不进结果', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'proactive-test-'))
  try {
    const file = path.join(dir, '2026-09-06.jsonl')
    // 制造一个超过 8KB 尾窗的文件，让首行必然被截断
    const padding = 'x'.repeat(9000)
    const samples: Sample[] = [
      { ts: 1, proc: 'old' },
      { ts: 2, proc: 'newest', idleMs: 600_000 },
    ]
    writeFileSync(file, `{broken\n${JSON.stringify(samples[0])}\n${padding}\n${JSON.stringify(samples[1])}\n`, 'utf8')
    const last = readLastSample(file)
    assert.ok(last)
    assert.equal(last.ts, 2)
    assert.equal(last.idleMs, 600_000)

    assert.equal(readLastSample(path.join(dir, 'missing.jsonl')), null, '文件不存在返回 null')
    writeFileSync(path.join(dir, 'empty.jsonl'), '', 'utf8')
    assert.equal(readLastSample(path.join(dir, 'empty.jsonl')), null, '空文件返回 null')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('user_flags：用户意愿跨重启成立', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'flags-test-'))
  try {
    const dbPath = path.join(dir, 'assistant.sqlite')
    const first = openAssistantStore(dbPath)
    assert.equal(getUserFlag(first, 'proactive_disabled'), null, '没有记录返回 null')
    setUserFlag(first, 'proactive_disabled', 'true')
    first.close()

    // 模拟重启：重新打开同一份库，v1 库里没有的表要被补上，意愿还在。
    const second = openAssistantStore(dbPath)
    assert.equal(getUserFlag(second, 'proactive_disabled'), 'true')
    setUserFlag(second, 'proactive_disabled', 'false')
    assert.equal(getUserFlag(second, 'proactive_disabled'), 'false')
    second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
