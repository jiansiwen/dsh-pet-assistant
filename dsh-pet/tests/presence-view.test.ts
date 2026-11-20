/**
 * 九态状态机的测试：优先级、驻留、静音旁路、回执、闩锁。
 *
 * 用 `node --test` 跑。这一份钉的是验收判据「界面显示的九态与后台真实状态一致」：哪条事件能把
 * 状态推到哪一格、什么时候**不许**推，都得有条用例。反过来，如果没有这些用例，改一个驻留数字
 * 或调一个优先级，只能靠开壳等某个瞬间才能发现问题。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  initialPresence,
  PARTIAL_RECEIPT_NOTE,
  PRESENCE_DWELL_MS,
  PRESENCE_PRIORITY,
  reducePresence,
  type PresenceEvent,
  type PresenceEventKind,
  type PresenceSnapshot,
} from '../src/renderer/presence-view.ts'

function ev(kind: PresenceEventKind, at: number, note?: string): PresenceEvent {
  return note === undefined ? { kind, at } : { kind, at, note }
}

/** 把一串事件顺着喂进去，返回最后一份快照。 */
function run(events: PresenceEvent[], from: PresenceSnapshot = initialPresence(0)): PresenceSnapshot {
  return events.reduce((snapshot, event) => reducePresence(snapshot, event), from)
}

describe('优先级表与驻留表', () => {
  test('优先级数值就是验收口径，任何一格改动都要改这条', () => {
    assert.deepEqual(PRESENCE_PRIORITY, {
      failed: 90,
      succeeded: 80,
      listening: 60,
      recognizing: 55,
      thinking: 50,
      answering: 45,
      working: 40,
      muted: 20,
      idle: 0,
    })
  })

  test('驻留表：终端态最久，静音与待命不设门槛', () => {
    assert.deepEqual(PRESENCE_DWELL_MS, {
      failed: 2500,
      succeeded: 2000,
      listening: 400,
      recognizing: 300,
      thinking: 400,
      answering: 400,
      working: 500,
      muted: 0,
      idle: 0,
    })
  })

  test('初始快照：待命、未闩锁、未静音、来源 initial', () => {
    assert.deepEqual(initialPresence(1234), {
      state: 'idle',
      active: false,
      muted: false,
      source: 'initial',
      since: 1234,
      speechActive: false,
    })
  })
})

describe('高优先即时抢占', () => {
  test('失败不等驻留，下一毫秒就接管', () => {
    const listening = run([ev('dictation-start', 100)])
    assert.equal(listening.state, 'listening')
    const failed = reducePresence(listening, ev('receipt-failed', 101))
    assert.equal(failed.state, 'failed')
    assert.equal(failed.since, 101)
    assert.equal(failed.source, 'receipt-failed')
    assert.equal(failed.receipt, 'failed')
  })

  test('成功压过听写、思考、干活与静音', () => {
    for (const kind of ['dictation-start', 'turn-start', 'task-running', 'mute-on'] as const) {
      const before = run([ev(kind, 10), ev('mute-on', 20)])
      const after = reducePresence(before, ev('receipt-succeeded', 30))
      assert.equal(after.state, 'succeeded', kind)
      assert.equal(after.receipt, 'succeeded')
      assert.equal(after.note, undefined)
    }
  })

  test('失败压过成功：同一拍到达时先解释失败', () => {
    const succeeded = run([ev('receipt-succeeded', 0)])
    assert.equal(succeeded.state, 'succeeded')
    assert.equal(reducePresence(succeeded, ev('receipt-failed', 1)).state, 'failed')
  })
})

describe('低优先必须等当前态驻留满', () => {
  test('驻留未满时状态与 since 都不动，来源也不改', () => {
    const listening = run([ev('dictation-start', 1000)])
    const blocked = reducePresence(listening, ev('dictation-end', 1300))
    assert.equal(blocked.state, 'listening', '识别中（55）压不过听写中（60），且听写只亮了 300ms')
    assert.equal(blocked.since, 1000)
    assert.equal(blocked.source, 'dictation-start')
    assert.equal(reducePresence(blocked, ev('dictation-end', 1300)), blocked, '再喂一次同样的还是不动')
  })

  test('恰好满驻留就接管：边界是可用的，不是"差一毫秒就永远不换"', () => {
    const listening = run([ev('dictation-start', 1000)])
    assert.equal(reducePresence(listening, ev('dictation-end', 1399)).state, 'listening')
    const allowed = reducePresence(listening, ev('dictation-end', 1400))
    assert.equal(allowed.state, 'recognizing')
    assert.equal(allowed.since, 1400)
  })

  test('被门挡住期间闩锁照翻：事实与画面分开走', () => {
    const failed = run([ev('receipt-failed', 0)])
    const early = reducePresence(failed, ev('turn-start', 2499))
    assert.equal(early.state, 'failed', '失败态要亮满 2.5 秒')
    assert.equal(early.since, 0, '驻留计时不被拦下的事件清零')
    assert.equal(early.active, true, '新的一轮已经开始，闩锁必须拉上，哪怕画面还在报失败')
    const late = reducePresence(failed, ev('turn-start', 2500))
    assert.equal(late.state, 'thinking')
    assert.equal(late.receipt, undefined, '新一轮开始，上一轮的回执让位')
  })
})

describe('九态的去向', () => {
  test('听写 → 识别 → 思考 → 回答 → 干活 各有其格', () => {
    const states: PresenceSnapshot[] = []
    states.push(run([ev('dictation-start', 0)]))
    states.push(reducePresence(states[0], ev('asr-delta', 500)))
    states.push(reducePresence(states[1], ev('asr-final', 900)))
    states.push(reducePresence(states[2], ev('delta-text', 1400)))
    states.push(reducePresence(states[3], ev('delta-tool', 1900)))
    assert.deepEqual(states.map(s => s.state), ['listening', 'recognizing', 'thinking', 'answering', 'working'])
  })

  test('kind=think 落"思考中"（50），不是"回答中"（45）', () => {
    assert.equal(reducePresence(initialPresence(0), ev('delta-think', 10)).state, 'thinking')
    const back = reducePresence(run([ev('delta-text', 0)]), ev('delta-think', 1))
    assert.equal(back.state, 'thinking', '思考中优先级更高，属即时抢占，不等驻留')
  })

  test('speech-end 只记"说完了"，不动状态', () => {
    const answering = run([ev('delta-text', 0), ev('speech-start', 500)])
    assert.equal(answering.speechActive, true)
    const ended = reducePresence(answering, ev('speech-end', 900))
    assert.equal(ended.state, 'answering', '话说完不等于这一轮结束，工具可能还在跑')
    assert.equal(ended.speechActive, false)
    assert.equal(ended.since, answering.since, '状态没变，驻留起点不该动')
  })
})

describe('turn-settled：只有"回答中说完了"才熄', () => {
  test('语音还在响时拒绝熄灯', () => {
    const speaking = run([ev('delta-text', 0), ev('speech-start', 500)])
    const blocked = reducePresence(speaking, ev('turn-settled', 900))
    assert.equal(blocked, speaking, '还在播报时收到轮次结束：原样返回')
    assert.equal(blocked.state, 'answering')
  })

  test('语音停了、且回答中驻留满 → 待命', () => {
    const settled = run([
      ev('delta-text', 0),
      ev('speech-start', 100),
      ev('speech-end', 500),
      ev('turn-settled', 900),
    ])
    assert.equal(settled.state, 'idle')
    assert.equal(settled.source, 'turn-settled')
  })

  test('语音停了但回答中还没亮满 400ms → 继续显示回答中', () => {
    const early = run([ev('delta-text', 0), ev('speech-end', 100), ev('turn-settled', 300)])
    assert.equal(early.state, 'answering')
    const late = reducePresence(early, ev('turn-settled', 400))
    assert.equal(late.state, 'idle')
  })

  test('不是从回答中收下来的一律不收：干活中的事还没完', () => {
    for (const events of [
      [ev('turn-start', 0)],
      [ev('delta-tool', 0)],
      [ev('dictation-start', 0)],
    ] as PresenceEvent[][]) {
      const before = run(events)
      assert.equal(reducePresence(before, ev('turn-settled', 5000)), before, String(before.state))
    }
  })

  test('静音状态下收束落 muted，不落 idle：用户按过静音，别把开关忘了', () => {
    const muted = run([ev('delta-text', 0), ev('mute-on', 100), ev('speech-end', 200), ev('turn-settled', 900)])
    assert.equal(muted.state, 'muted')
    assert.equal(muted.muted, true)
  })
})

describe('muted 不是独占态', () => {
  test('活跃态下按静音：只翻标记，绝不覆盖状态', () => {
    const answering = run([ev('delta-text', 0), ev('speech-start', 100)])
    const muted = reducePresence(answering, ev('mute-on', 500))
    assert.equal(muted.state, 'answering', '把回答中盖成静音，用户会以为助手停了')
    assert.equal(muted.muted, true)
    assert.equal(muted.since, answering.since)
    const unmuted = reducePresence(muted, ev('mute-off', 600))
    assert.equal(unmuted.state, 'answering')
    assert.equal(unmuted.muted, false)
  })

  test('待命时按静音才落到 muted，取消静音回落 idle', () => {
    const muted = run([ev('mute-on', 10)])
    assert.equal(muted.state, 'muted')
    assert.equal(muted.muted, true)
    const idle = reducePresence(muted, ev('mute-off', 20))
    assert.equal(idle.state, 'idle')
    assert.equal(idle.muted, false)
  })

  test('静音标记跨多格保持：听写、思考都照常显示，标记不动', () => {
    const snapshot = run([ev('mute-on', 0), ev('dictation-start', 100), ev('asr-final', 600), ev('delta-text', 1100)])
    assert.equal(snapshot.state, 'answering')
    assert.equal(snapshot.muted, true)
  })
})

describe('回执：partial / unknown 不许画成成功，也不许熄灯', () => {
  test('干活中收到部分完成：留在 working，写清"未自动重发"', () => {
    const partial = run([ev('turn-start', 0), ev('delta-tool', 500), ev('receipt-partial', 900)])
    assert.equal(partial.state, 'working')
    assert.equal(partial.receipt, 'partial')
    assert.equal(partial.note, PARTIAL_RECEIPT_NOTE)
    assert.ok(partial.note?.includes('未自动重发'))
    assert.notEqual(partial.state, 'succeeded')
    assert.notEqual(partial.state, 'idle')
  })

  test('结果未知同样不落成功，也不重发第二遍', () => {
    const unknown = run([ev('task-running', 0), ev('receipt-unknown', 600)])
    assert.equal(unknown.state, 'working')
    assert.equal(unknown.receipt, 'unknown')
    assert.equal(unknown.note, PARTIAL_RECEIPT_NOTE)
  })

  test('当前格更高时保持当前格，但回执与说明照写（事实先记下）', () => {
    const thinking = run([ev('turn-start', 0)])
    const blocked = reducePresence(thinking, ev('receipt-partial', 100))
    assert.equal(blocked.state, 'thinking', '思考中（50）高于干活中（40），且只亮了 100ms')
    assert.equal(blocked.since, 0)
    assert.equal(blocked.receipt, 'partial')
    assert.equal(blocked.note, PARTIAL_RECEIPT_NOTE)
  })

  test('回执自带更具体的话时以它为准', () => {
    const partial = reducePresence(run([ev('task-running', 0)]), ev('receipt-partial', 600, '已在第一步后终止'))
    assert.equal(partial.note, '已在第一步后终止')
  })

  test('成功回执会清掉上一轮遗留的说明', () => {
    const flow = run([
      ev('task-running', 0),
      ev('receipt-partial', 600),
      ev('receipt-succeeded', 1200),
    ])
    assert.equal(flow.state, 'succeeded')
    assert.equal(flow.receipt, 'succeeded')
    assert.equal(flow.note, undefined, '旧的"部分完成"不能挂在成功上')
  })
})

describe('active 是会话级闩锁，与九态正交', () => {
  test('连续对话开始拉上，一轮结束不松：否则下一轮会被当成新会话', () => {
    const started = run([ev('continuous-start', 0)])
    assert.equal(started.active, true)
    assert.equal(started.state, 'idle', '连续对话开始本身不是九态之一')
    const afterTurn = run([ev('delta-text', 100), ev('speech-end', 200), ev('turn-settled', 700)], started)
    assert.equal(afterTurn.state, 'idle')
    assert.equal(afterTurn.active, true, 'turn-settled 不翻闩锁')
  })

  test('九态内部切换、静音、打断都不翻闩锁', () => {
    const kinds: PresenceEventKind[] = [
      'dictation-start', 'dictation-end', 'asr-delta', 'asr-final', 'turn-start', 'delta-text',
      'delta-think', 'delta-tool', 'speech-start', 'speech-end', 'task-running', 'mute-on', 'mute-off',
      'receipt-partial', 'receipt-unknown',
    ]
    let snapshot: PresenceSnapshot = { ...initialPresence(0), active: true }
    for (const kind of kinds) {
      snapshot = reducePresence(snapshot, ev(kind, 10_000))
      assert.equal(snapshot.active, true, `${kind} 不该翻闩锁`)
    }
  })

  test('continuous-stop / session-idle / session-lost 松闩锁', () => {
    for (const kind of ['continuous-stop', 'session-idle', 'session-lost'] as const) {
      const before: PresenceSnapshot = { ...initialPresence(0), active: true, state: 'thinking', since: 0 }
      assert.equal(reducePresence(before, ev(kind, 1000)).active, false, kind)
    }
  })
})

describe('会话面收束与断线', () => {
  test('session-idle 能把漏掉 turn-settled 的一轮收回待命', () => {
    const answering = run([ev('delta-text', 0), ev('speech-end', 100)])
    const idle = reducePresence(answering, ev('session-idle', 1000))
    assert.equal(idle.state, 'idle', '否则会永远挂在回答中，与真实状态不一致')
    assert.equal(idle.active, false)
  })

  test('还在播报时 session-idle 只松闩锁，不熄灯', () => {
    const speaking = run([ev('delta-text', 0), ev('speech-start', 100)])
    const settled = reducePresence(speaking, ev('session-idle', 1000))
    assert.equal(settled.state, 'answering')
    assert.equal(settled.active, false)
  })

  test('session-lost 不猜状态：断线既不是空闲也不是失败', () => {
    const lost = run([ev('delta-tool', 0), ev('session-lost', 1000)])
    assert.equal(lost.state, 'working')
    assert.equal(lost.active, false)
    assert.equal(lost.receipt, undefined)
  })
})

describe('未知事件 fail-safe', () => {
  test('认不出的 kind 原样返回同一个对象', () => {
    const snapshot = run([ev('delta-text', 0)])
    const unknown = { kind: 'never-heard-of-it' as unknown as PresenceEventKind, at: 9999 }
    assert.equal(reducePresence(snapshot, unknown), snapshot)
  })
})
