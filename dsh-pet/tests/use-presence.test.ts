/**
 * 事实 → 事件的测试：哪些变化该说话、哪些**不该**说话。
 *
 * 这一份钉的判据是「界面显示的九态与后台真实状态一致」。反过来说同等重要：**没有事实支撑的
 * 结论一个都不许发** —— `busy` 由真变假不发成功、错误提示消失不发"恢复"、念完但没有会话回落
 * 不发"收束"。这些"少说一句"的决定最容易在后来的改动里被顺手补上，所以逐条写死。
 *
 * 除了映射本身，这里还把事件喂给真的 `reducePresence`，钉住"三种干活形态各落哪一格"，
 * 免得映射对了、组合起来却落在错的格子上。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  EMPTY_FACTS,
  factsToEvents,
  intentOf,
  type PresenceFacts,
} from '../src/renderer/presence-facts.ts'
import {
  initialPresence,
  reducePresence,
  type PresenceEvent,
  type PresenceSnapshot,
} from '../src/renderer/presence-view.ts'

function facts(over: Partial<PresenceFacts>): PresenceFacts {
  return { ...EMPTY_FACTS, ...over }
}

/** 把一串事件顺着喂进状态机，返回终态（时间隔 1 秒，避开驻留门）。 */
function apply(events: PresenceEvent[], from: PresenceSnapshot = initialPresence(0)): PresenceSnapshot {
  return events.reduce((snapshot, event) => reducePresence(snapshot, event), from)
}

describe('从空闲到干活：三种形态各说各的话', () => {
  test('正文流式条目出现 → delta-text → 回答中', () => {
    const events = factsToEvents(EMPTY_FACTS, facts({ hasStreamingText: true }), 1000)
    assert.deepEqual(events.map(event => event.kind), ['delta-text'])
    assert.equal(apply(events).state, 'answering')
  })

  test('思考流式条目出现 → delta-think → 思考中', () => {
    const events = factsToEvents(EMPTY_FACTS, facts({ hasStreamingThink: true }), 1000)
    assert.deepEqual(events.map(event => event.kind), ['delta-think'])
    assert.equal(apply(events).state, 'thinking')
  })

  test('工具调用流式条目出现 → delta-tool → 工作中', () => {
    const events = factsToEvents(EMPTY_FACTS, facts({ hasStreamingTool: true }), 1000)
    assert.deepEqual(events.map(event => event.kind), ['delta-tool'])
    assert.equal(apply(events).state, 'working')
  })

  test('团队任务在跑 → task-running → 工作中', () => {
    const events = factsToEvents(EMPTY_FACTS, facts({ taskRunning: true }), 1000)
    assert.deepEqual(events.map(event => event.kind), ['task-running'])
    assert.equal(apply(events).state, 'working')
  })

  test('听写开始/结束 → 听写中 / 识别中', () => {
    const started = factsToEvents(EMPTY_FACTS, facts({ listening: true }), 0)
    assert.deepEqual(started.map(event => event.kind), ['dictation-start'])
    assert.equal(apply(started).state, 'listening')
    const ended = factsToEvents(facts({ listening: true }), facts({ listening: false }), 1000)
    assert.deepEqual(ended.map(event => event.kind), ['dictation-end'])
    assert.equal(apply(ended, apply(started)).state, 'recognizing')
  })

  test('会话进入运行 → turn-start，并把会话级闩锁拉上', () => {
    const events = factsToEvents(EMPTY_FACTS, facts({ sessionStatus: 'running' }), 1000)
    assert.deepEqual(events.map(event => event.kind), ['turn-start'])
    const snapshot = apply(events)
    assert.equal(snapshot.state, 'thinking')
    assert.equal(snapshot.active, true, 'assistantActive 靠这条闩锁复活')
  })
})

describe('收束条件：少说一句比说错一句好', () => {
  test('念完了但提交仍在途（busy 仍真）→ 不出 turn-settled', () => {
    const prev = facts({ speaking: true, busy: true, sessionStatus: 'running' })
    const next = facts({ speaking: false, busy: true, sessionStatus: 'running' })
    assert.deepEqual(factsToEvents(prev, next, 1000).map(event => event.kind), ['speech-end'])
  })

  test('念完了、提交结束，但会话还在跑 → 也不收束', () => {
    const prev = facts({ speaking: true, sessionStatus: 'running' })
    const next = facts({ speaking: false, sessionStatus: 'running' })
    assert.deepEqual(factsToEvents(prev, next, 1000).map(event => event.kind), ['speech-end'])
  })

  test('念完了 + 提交结束 + 会话空闲 → speech-end 与 turn-settled 同时给出，按序落地', () => {
    const prev = facts({ speaking: true, sessionStatus: 'idle' })
    const next = facts({ speaking: false, sessionStatus: 'idle' })
    assert.deepEqual(factsToEvents(prev, next, 1000).map(event => event.kind), ['speech-end', 'turn-settled'])
  })

  test('busy 由真变假本身不发任何事件（提交结束不等于成功）', () => {
    assert.deepEqual(factsToEvents(facts({ busy: true, sessionStatus: 'running' }), facts({ busy: false, sessionStatus: 'running' }), 1000), [])
  })

  test('任务由跑到停不发"完成"：那要等回执', () => {
    assert.deepEqual(factsToEvents(facts({ taskRunning: true }), facts({ taskRunning: false }), 1000), [])
  })

  test('流式条目布尔量保持不变时不会反复触发（累积条目不产生重复事件）', () => {
    const steady = facts({ hasStreamingText: true, sessionStatus: 'running' })
    assert.deepEqual(factsToEvents(steady, steady, 1000), [])
    assert.deepEqual(factsToEvents(steady, { ...steady }, 1000), [])
  })
})

describe('失败与断线', () => {
  test('错误文本由空变非空 → receipt-failed', () => {
    const events = factsToEvents(EMPTY_FACTS, facts({ errorText: '语音合成起不来' }), 1000)
    assert.deepEqual(events.map(event => event.kind), ['receipt-failed'])
    assert.equal(apply(events).state, 'failed')
  })

  test('错误文本换了一条 → 仍然算新错误，要再被看见一次', () => {
    const events = factsToEvents(facts({ errorText: '甲' }), facts({ errorText: '乙' }), 1000)
    assert.deepEqual(events.map(event => event.kind), ['receipt-failed'])
  })

  test('错误文本被清空 → session-idle，不猜"恢复了"', () => {
    const events = factsToEvents(facts({ errorText: '甲' }), facts({ errorText: '' }), 5000)
    assert.deepEqual(events.map(event => event.kind), ['session-idle'])
    assert.notEqual(apply(events, apply([{ kind: 'receipt-failed', at: 0 }])).state, 'failed')
  })

  test('会话断开 → session-lost，且不猜成失败', () => {
    const events = factsToEvents(facts({ sessionStatus: 'running' }), facts({ sessionStatus: 'disconnected' }), 1000)
    assert.deepEqual(events.map(event => event.kind), ['session-lost'])
    const snapshot = apply(events, apply([{ kind: 'delta-text', at: 0 }]))
    assert.equal(snapshot.state, 'answering', '断线不猜状态，只松闩锁')
    assert.equal(snapshot.active, false)
  })
})

describe('同帧多事实：顺序稳定且失败优先', () => {
  test('出错 + 会话回落 + 播报停止同帧发生 → 失败排第一', () => {
    const prev = facts({ speaking: true, sessionStatus: 'running' })
    const next = facts({ speaking: false, sessionStatus: 'idle', errorText: '消息未提交' })
    const kinds = factsToEvents(prev, next, 1000).map(event => event.kind)
    assert.equal(kinds[0], 'receipt-failed', `实际顺序：${kinds.join(' → ')}`)
    assert.deepEqual(kinds, ['receipt-failed', 'session-idle', 'speech-end', 'turn-settled'])
  })

  test('三种流式条目同帧出现 → 思考 → 正文 → 工具，按序给事件', () => {
    const events = factsToEvents(EMPTY_FACTS, facts({
      sessionStatus: 'running', hasStreamingThink: true, hasStreamingText: true, hasStreamingTool: true,
    }), 1000)
    assert.deepEqual(events.map(event => event.kind), ['turn-start', 'delta-think', 'delta-text', 'delta-tool'])
  })

  test('同一批事件在驻留期满后重放"最后一个意图"会继续推进，且不会退回思考中', () => {
    // 一帧里三条都到了，但节奏上只能换一格：这是设计，不是 bug。
    const events = factsToEvents(EMPTY_FACTS, facts({
      sessionStatus: 'running', hasStreamingThink: true, hasStreamingText: true, hasStreamingTool: true,
    }), 1000)
    const first = apply(events, initialPresence(0))
    assert.equal(first.state, 'thinking', '思考中要先亮满 400ms')

    // hook 的重试只重放"最后那个要改状态的事件"（这里是 delta-tool）。
    const intent = intentOf(events)
    assert.equal(intent?.kind, 'delta-tool')

    // 到期后重放意图 → 直接落到"工作中"。
    const second = reducePresence(first, { ...intent!, at: 1400 }, 1400)
    assert.equal(second.state, 'working')

    // 反例：从"工作中"整批重放，`turn-start`（优先级 50）会立刻把状态推回"思考中"，
    // 随后的正文/工具事件又被新的驻留门挡下 —— 越重试越退。这正是"只重放意图"存在的原因。
    const replayAll = events.reduce((snapshot, event) => reducePresence(snapshot, { ...event, at: 1800 }, 1800), second)
    assert.equal(replayAll.state, 'thinking')
  })

  test('intentOf 跳过不改状态的事件（speech-end）与空批次', () => {
    assert.equal(intentOf([]), null)
    assert.equal(intentOf([{ kind: 'speech-end', at: 0 }]), null)
    assert.equal(intentOf([{ kind: 'delta-text', at: 0 }, { kind: 'speech-end', at: 1 }])?.kind, 'delta-text')
    assert.equal(intentOf([{ kind: 'turn-start', at: 0 }, { kind: 'delta-tool', at: 1 }])?.kind, 'delta-tool')
  })
})

describe('静音与连续对话', () => {
  test('静音开关只翻标记，不覆盖活跃态', () => {
    const on = factsToEvents(facts({ sessionStatus: 'running' }), facts({ sessionStatus: 'running', muted: true }), 1000)
    assert.deepEqual(on.map(event => event.kind), ['mute-on'])
    const snapshot = apply(on, apply([{ kind: 'delta-text', at: 0 }]))
    assert.equal(snapshot.state, 'answering')
    assert.equal(snapshot.muted, true)
    const off = factsToEvents(facts({ muted: true }), facts({ muted: false }), 2000)
    assert.deepEqual(off.map(event => event.kind), ['mute-off'])
  })

  test('连续对话起停只翻闩锁', () => {
    const started = factsToEvents(EMPTY_FACTS, facts({ continuous: true }), 0)
    assert.deepEqual(started.map(event => event.kind), ['continuous-start'])
    assert.equal(apply(started).active, true)
    const stopped = factsToEvents(facts({ continuous: true }), facts({ continuous: false }), 1000)
    assert.deepEqual(stopped.map(event => event.kind), ['continuous-stop'])
    assert.equal(apply(stopped, apply(started)).active, false)
  })
})

describe('什么都不变就什么都不说', () => {
  test('两帧完全相同 → 空数组（调用方据此跳过重渲染）', () => {
    const steady = facts({ sessionStatus: 'idle', listening: false, speaking: false })
    assert.deepEqual(factsToEvents(steady, steady, 1000), [])
    assert.deepEqual(factsToEvents(steady, { ...steady }, 1000), [])
  })

  test('空基线对空基线 → 空数组：刚打开界面不该冒出任何事件', () => {
    assert.deepEqual(factsToEvents(EMPTY_FACTS, EMPTY_FACTS, 0), [])
  })
})

describe('一整轮走完：从待命回到待命', () => {
  test('运行 → 思考 → 回答 → 念完收束，全程闩锁只在该翻的时候翻', () => {
    let snapshot = initialPresence(0)
    let previous = EMPTY_FACTS
    const step = (next: PresenceFacts, at: number): void => {
      for (const event of factsToEvents(previous, next, at)) snapshot = reducePresence(snapshot, event, at)
      previous = next
    }

    step(facts({ sessionStatus: 'running' }), 100)
    assert.equal(snapshot.state, 'thinking')
    assert.equal(snapshot.active, true)

    step(facts({ sessionStatus: 'running', hasStreamingThink: true }), 200)
    step(facts({ sessionStatus: 'running', hasStreamingThink: true, hasStreamingText: true }), 1000)
    assert.equal(snapshot.state, 'answering')

    step(facts({ sessionStatus: 'running', hasStreamingText: true, speaking: true }), 1500)
    assert.equal(snapshot.state, 'answering')

    step(facts({ sessionStatus: 'idle', hasStreamingText: true, speaking: true }), 3000)
    assert.equal(snapshot.state, 'answering', '会话空闲但还在念：不许熄灯')

    step(facts({ sessionStatus: 'idle', hasStreamingText: false }), 6000)
    assert.equal(snapshot.state, 'idle')
    assert.equal(snapshot.active, false, '收束之后闩锁放开，下一轮重新拉')
  })
})
