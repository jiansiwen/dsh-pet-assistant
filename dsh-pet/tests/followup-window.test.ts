/**
 * 答完反问 + 5 秒智能等待：状态机与"明确说继续"的窄匹配。
 *
 * 这个特性在真机上几乎没法复现（要在对的时间说对的话），所以判定全做成纯函数，
 * 时间一律由用例以 `at` 传进来 —— 每条规则都能确定性地钉住。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  DEFAULT_FOLLOWUP,
  EXPLICIT_CONTINUE_MAX_CHARS,
  initialFollowup,
  isExplicitContinue,
  reduceFollowup,
  type FollowupEvent,
  type FollowupState,
} from '../src/main/followup-window.ts'

const OPTIONS = { waitMs: 5_000, maxExtendMs: 30_000 }

/** 开一扇窗，从 t=1000 开始等。 */
function opened(at = 1_000): FollowupState {
  return reduceFollowup(initialFollowup(), { kind: 'start', at }, OPTIONS).state
}

function step(state: FollowupState, event: FollowupEvent) {
  return reduceFollowup(state, event, OPTIONS)
}

describe('默认参数', () => {
  test('等 5 秒、最多延长到 30 秒', () => {
    assert.deepEqual(DEFAULT_FOLLOWUP, { waitMs: 5_000, maxExtendMs: 30_000 })
  })
})

describe('start', () => {
  test('开窗：deadline = at + waitMs，hardDeadline = at + maxExtendMs', () => {
    const { state, action } = reduceFollowup(initialFollowup(), { kind: 'start', at: 1_000 }, OPTIONS)
    assert.equal(action, 'waiting')
    assert.equal(state.active, true)
    assert.equal(state.startedAt, 1_000)
    assert.equal(state.deadline, 6_000)
    assert.equal(state.hardDeadline, 31_000)
  })
})

describe('speech（只认 ASR 识别文本变长）', () => {
  test('有人说话：deadline 从这一次说话重新算 5 秒', () => {
    const { state, action } = step(opened(), { kind: 'speech', at: 4_000 })
    assert.equal(action, 'waiting')
    assert.equal(state.deadline, 9_000, '4 秒时还在说，就该等到 9 秒')
    assert.equal(state.lastSpeechAt, 4_000)
  })

  test('连续说话会不断推迟 deadline', () => {
    let state = opened()
    for (const at of [4_000, 7_000, 12_000, 20_000]) {
      state = step(state, { kind: 'speech', at }).state
      assert.equal(state.deadline, Math.min(at + 5_000, state.hardDeadline))
    }
    assert.equal(state.deadline, 25_000)
  })

  test('推迟但永远不超过 hardDeadline（否则讲解会被识别器永久卡住）', () => {
    const { state } = step(opened(), { kind: 'speech', at: 29_000 })
    assert.equal(state.deadline, 31_000, '29+5 会超出上限，只能取 hardDeadline')
    assert.equal(state.hardDeadline, 31_000)
  })

  test('已过 hardDeadline 的 speech 原样返回，不再推迟', () => {
    const before = opened()
    const { state, action } = step(before, { kind: 'speech', at: 31_000 })
    assert.equal(state, before)
    assert.equal(action, 'waiting')
  })

  test('窗口没开时 speech 不产生任何动作（关掉的窗口不会被迟到的 ASR 唤醒）', () => {
    const { state, action } = step(initialFollowup(), { kind: 'speech', at: 5_000 })
    assert.equal(action, 'idle')
    assert.equal(state.active, false)
  })
})

describe('tick', () => {
  test('没到点：继续等', () => {
    const { state, action } = step(opened(), { kind: 'tick', at: 5_999 })
    assert.equal(action, 'waiting')
    assert.equal(state.active, true)
  })

  test('到点：收束成 continue', () => {
    const { state, action } = step(opened(), { kind: 'tick', at: 6_000 })
    assert.equal(action, 'continue')
    assert.equal(state.active, false)
  })

  test('ASR 一直在出字时，hardDeadline 到点强制 continue', () => {
    let state = opened()
    // 每 4 秒说一次，deadline 一直被推着走。
    for (const at of [5_000, 9_000, 13_000, 17_000, 21_000, 25_000, 29_000]) {
      state = step(state, { kind: 'speech', at }).state
    }
    assert.equal(state.deadline, 31_000)
    // 还没到 hardDeadline：继续等。
    assert.equal(step(state, { kind: 'tick', at: 30_999 }).action, 'waiting')
    // 到 hardDeadline：即使有人还在说也必须往下讲，不能永久卡住。
    assert.equal(step(state, { kind: 'tick', at: 31_000 }).action, 'continue')
  })

  test('窗口没开时 tick 什么都不做', () => {
    const { state, action } = step(initialFollowup(), { kind: 'tick', at: 99_999 })
    assert.equal(action, 'idle')
    assert.equal(state.active, false)
  })
})

describe('explicit-continue / cancel', () => {
  test('明确说继续：立刻 continue', () => {
    const { state, action } = step(opened(), { kind: 'explicit-continue', at: 2_000 })
    assert.equal(action, 'continue')
    assert.equal(state.active, false)
  })

  test('窗口没开时的"继续"不生效（可能是别的语境里说的）', () => {
    assert.equal(step(initialFollowup(), { kind: 'explicit-continue', at: 2_000 }).action, 'idle')
  })

  test('cancel 复位，且之后 speech/explicit-continue 都不再生效', () => {
    const cancelled = step(opened(), { kind: 'cancel' })
    assert.equal(cancelled.action, 'idle')
    assert.deepEqual(cancelled.state, initialFollowup())
    assert.equal(step(cancelled.state, { kind: 'speech', at: 3_000 }).action, 'idle')
    assert.equal(step(cancelled.state, { kind: 'explicit-continue', at: 3_000 }).action, 'idle')
    assert.equal(step(cancelled.state, { kind: 'tick', at: 99_999 }).action, 'idle')
  })
})

describe('isExplicitContinue（窄匹配，只认真正在要求继续的短句）', () => {
  test('常见说法都认', () => {
    for (const said of ['继续', '继续。', '接着讲', '往下', '请继续', '继续往下', '下一个', '下一段', '来，继续']) {
      assert.equal(isExplicitContinue(said), true, said)
    }
  })

  test('长句不认（那是一句话，不是指令）', () => {
    const long = '继续' + '啊'.repeat(EXPLICIT_CONTINUE_MAX_CHARS)
    assert.equal(isExplicitContinue(long), false)
  })

  test('问句不认：含问号或疑问词一律按提问处理', () => {
    assert.equal(isExplicitContinue('这段继续讲讲是什么意思？'), false)
    assert.equal(isExplicitContinue('接着讲是什么意思'), false, '没有问号但确实在提问')
    assert.equal(isExplicitContinue('继续往下讲，为什么这里要这样做'), false)
  })

  test('正常提问不认', () => {
    for (const said of ['这段讲的是什么', '第二段的结论怎么来的', '']) {
      assert.equal(isExplicitContinue(said), false, said)
    }
    assert.equal(isExplicitContinue('   '), false)
  })
})
