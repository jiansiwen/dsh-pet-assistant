/**
 * 增量影子缓冲的测试：追加、乱序门、epoch 切换、无 id 兜底、溢出降级、权威提交。
 *
 * 这一份钉的是"同一个字不出现两份"：影子只能活到权威条目到达为止，且同一轮只能提交一次。
 * 所有这些判据都发生在几百毫秒的窗口里（重放的 seq、半截的 epoch、缺 id 的网页轮次），
 * 开壳基本等不到，只能靠用例。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  commitAuthoritative,
  createDeltaState,
  DELTA_LIMITS,
  pickLiveTurn,
  reduceDelta,
  type DeltaState,
} from '../src/renderer/chat-delta.ts'
import type { BridgeEventPayload } from '../src/renderer/types.js'
import type { SessionEntry } from '../src/session-types.js'

function delta(over: Partial<BridgeEventPayload>): BridgeEventPayload {
  return { type: 'delta', ...over }
}

function entry(over: Partial<SessionEntry>): SessionEntry {
  return { id: 'e', seq: 0, role: 'assistant', kind: 'text', text: '', ...over }
}

/** 顺着喂一串 delta，返回终态。 */
function feed(payloads: BridgeEventPayload[], from: DeltaState = createDeltaState()): DeltaState {
  return payloads.reduce((state, payload) => reduceDelta(state, payload, 0).state, from)
}

describe('边界：只认 delta', () => {
  test('非 delta 事件原样返回，不产生任何轮次', () => {
    const state = createDeltaState()
    for (const type of ['status', 'delta-done', 'task', 'interval']) {
      const result = reduceDelta(state, { type })
      assert.equal(result.changed, false, type)
      assert.equal(result.state, state, type)
    }
    assert.deepEqual(state, { pending: {} })
  })

  test('createDeltaState 从空表开始', () => {
    assert.deepEqual(createDeltaState(), { pending: {} })
    assert.equal(pickLiveTurn(createDeltaState()), null)
  })

  test('限额常量：64KB 正文 / 200 片段', () => {
    assert.deepEqual(DELTA_LIMITS, { maxChars: 64 * 1024, maxChunks: 200 })
  })
})

describe('追加：正文、思考、工具各归各位', () => {
  test('text 追加到正文，firstCharAt 只记第一次', () => {
    let state = reduceDelta(createDeltaState(), delta({ id: 'req-1', kind: 'text', text: '你', seq: 1 }), 100).state
    assert.equal(pickLiveTurn(state)?.text, '你')
    assert.equal(pickLiveTurn(state)?.firstCharAt, 100)
    state = reduceDelta(state, delta({ id: 'req-1', kind: 'text', text: '好', seq: 2 }), 900).state
    assert.equal(pickLiveTurn(state)?.text, '你好')
    assert.equal(pickLiveTurn(state)?.firstCharAt, 100, '首字时刻不是"最后一段到达时刻"')
  })

  test('think 进思考，不混进正文', () => {
    const state = feed([
      delta({ id: 'r', kind: 'think', text: '先看目录', seq: 1 }),
      delta({ id: 'r', kind: 'text', text: '结论是', seq: 2 }),
    ])
    assert.equal(pickLiveTurn(state)?.think, '先看目录')
    assert.equal(pickLiveTurn(state)?.text, '结论是')
  })

  test('tool 记工具名与参数，参数缺失时退到 text', () => {
    const state = feed([
      delta({ id: 'r', kind: 'tool', name: 'Read', arg: 'dsh-pet/README.md', seq: 1 }),
      delta({ id: 'r', kind: 'tool', name: 'Grep', text: 'SessionEntry', seq: 2 }),
    ])
    assert.deepEqual(pickLiveTurn(state)?.tools, [
      { name: 'Read', arg: 'dsh-pet/README.md' },
      { name: 'Grep', arg: 'SessionEntry' },
    ])
  })

  test('kind 缺省按 text 处理', () => {
    const state = feed([delta({ id: 'r', text: '默认是正文', seq: 1 })])
    assert.equal(pickLiveTurn(state)?.text, '默认是正文')
  })
})

describe('seq 单调门：重放与乱序都丢掉', () => {
  test('同一 seq 再来一次不追加，返回同一个 state', () => {
    const state = feed([delta({ id: 'r', kind: 'text', text: '一', seq: 5 })])
    const replay = reduceDelta(state, delta({ id: 'r', kind: 'text', text: '一', seq: 5 }))
    assert.equal(replay.changed, false)
    assert.equal(replay.state, state)
    assert.equal(pickLiveTurn(state)?.text, '一')
  })

  test('比 lastSeq 小的迟到增量丢弃', () => {
    const state = feed([
      delta({ id: 'r', kind: 'text', text: '一', seq: 5 }),
      delta({ id: 'r', kind: 'text', text: '二', seq: 6 }),
    ])
    const late = reduceDelta(state, delta({ id: 'r', kind: 'text', text: '插队的', seq: 4 }))
    assert.equal(late.changed, false)
    assert.equal(pickLiveTurn(state)?.text, '一二')
  })

  test('没有 seq 的增量不做门禁（有些桥接版本只给文本）', () => {
    const state = feed([
      delta({ id: 'r', kind: 'text', text: '一' }),
      delta({ id: 'r', kind: 'text', text: '二' }),
    ])
    assert.equal(pickLiveTurn(state)?.text, '一二')
  })
})

describe('epoch 闸：换会话就作废旧尾巴', () => {
  test('epoch 变化清空 pending，只留新会话的轮次', () => {
    const before = feed([delta({ id: 'old', epoch: 'e1', kind: 'text', text: '旧会话的话', seq: 9 })])
    const after = reduceDelta(before, delta({ id: 'new', epoch: 'e2', kind: 'text', text: '新会话', seq: 1 }))
    assert.equal(after.changed, true)
    assert.deepEqual(Object.keys(after.state.pending), ['id:new'])
    assert.equal(after.state.epoch, 'e2')
    assert.equal(pickLiveTurn(after.state)?.text, '新会话')
  })

  test('同 epoch 的高 seq 不会因为 epoch 被清掉', () => {
    const state = feed([
      delta({ id: 'r', epoch: 'e1', kind: 'text', text: '一', seq: 1 }),
      delta({ id: 'r', epoch: 'e1', kind: 'text', text: '二', seq: 2 }),
    ])
    assert.equal(pickLiveTurn(state)?.text, '一二')
  })
})

describe('无 id 轮次：造稳定的键，绝不猜归属', () => {
  test('缺 id 时键落在 anon 前缀上，不挂到任何宠物请求 id 上', () => {
    const state = feed([delta({ epoch: 'e1', kind: 'text', text: '网页侧的话', seq: 3 })])
    const keys = Object.keys(state.pending)
    assert.deepEqual(keys, ['anon:e1:text:3'])
    assert.ok(keys.every(key => !key.startsWith('id:')), '没有 id 就不许编一个 id 出来')
  })

  test('同一条无 id 流里，后续增量接在同一轮', () => {
    const state = feed([
      delta({ epoch: 'e1', kind: 'text', text: '一', seq: 3 }),
      delta({ epoch: 'e1', kind: 'text', text: '二', seq: 4 }),
    ])
    assert.deepEqual(Object.keys(state.pending), ['anon:e1:text:3'])
    assert.equal(pickLiveTurn(state)?.text, '一二')
  })

  test('kind=user 是轮次边界：新建一轮，且不把用户的原话写进尾巴', () => {
    const state = feed([
      delta({ epoch: 'e1', kind: 'text', text: '上一轮的回答', seq: 3 }),
      delta({ epoch: 'e1', kind: 'user', text: '用户刚说的话', seq: 10 }),
    ])
    const turns = Object.values(state.pending)
    assert.equal(turns.length, 2, '旧轮次留着等权威条目提交，新轮次接着写')
    const boundary = state.pending['anon:e1:user:10']
    assert.equal(boundary.text, '', '用户气泡由权威条目渲染，这里再写一份就是第二份正文')
    for (const turn of turns) {
      assert.ok(!turn.text.includes('用户刚说的话'), `${turn.turnKey} 把用户原话拼进了助手正文`)
      assert.ok(!turn.think.includes('用户刚说的话'))
    }
  })

  test('边界之后的增量落到新的一轮上', () => {
    const state = feed([
      delta({ epoch: 'e1', kind: 'text', text: '上一轮', seq: 3 }),
      delta({ epoch: 'e1', kind: 'user', text: '再问一句', seq: 10 }),
      delta({ epoch: 'e1', kind: 'text', text: '这一轮的回答', seq: 11 }),
    ])
    assert.equal(state.pending['anon:e1:user:10'].text, '这一轮的回答')
    assert.equal(state.pending['anon:e1:text:3'].text, '上一轮', '旧轮次不该被新内容改写')
    assert.equal(pickLiveTurn(state)?.text, '这一轮的回答', '活跃尾巴取 lastSeq 最大的那轮')
  })
})

describe('溢出降级：停手，不截断冒充完整', () => {
  test('恰好到 maxChars 仍收，再多一个字就置 overflowed 且不再追加', () => {
    const full = 'x'.repeat(DELTA_LIMITS.maxChars)
    let state = reduceDelta(createDeltaState(), delta({ id: 'r', kind: 'text', text: full, seq: 1 })).state
    assert.equal(pickLiveTurn(state)?.text.length, DELTA_LIMITS.maxChars, '正好到上限是合法的')

    const over = reduceDelta(state, delta({ id: 'r', kind: 'text', text: '再多一个字', seq: 2 }))
    assert.equal(over.changed, true)
    state = over.state
    const turn = state.pending['id:r']
    assert.equal(turn.overflowed, true)
    assert.equal(turn.text.length, DELTA_LIMITS.maxChars, '不截断、不续写，一个字都不编')
    assert.equal(turn.lastSeq, 2, 'seq 仍推进，乱序判定不能因此失效')
    assert.equal(pickLiveTurn(state), null, '溢出后不作为活跃尾巴显示，界面另说"内容较长，正在整理"')

    const later = reduceDelta(state, delta({ id: 'r', kind: 'text', text: '!', seq: 3 }))
    assert.equal(later.state.pending['id:r'].text.length, DELTA_LIMITS.maxChars)
  })

  test('片段数到 maxChunks 就停（第 201 段丢弃）', () => {
    let state = createDeltaState()
    for (let seq = 1; seq <= DELTA_LIMITS.maxChunks; seq += 1) {
      state = reduceDelta(state, delta({ id: 'r', kind: 'text', text: 'a', seq })).state
    }
    assert.equal(state.pending['id:r'].chunks, DELTA_LIMITS.maxChunks)
    assert.equal(state.pending['id:r'].overflowed, false, '正好到 200 段还没溢出')
    state = reduceDelta(state, delta({ id: 'r', kind: 'text', text: 'a', seq: 201 })).state
    assert.equal(state.pending['id:r'].overflowed, true)
    assert.equal(state.pending['id:r'].text.length, DELTA_LIMITS.maxChunks)
  })

  test('空片段不占片段预算：空事件很多时不至于把真正的内容挤出去', () => {
    let state = createDeltaState()
    for (let seq = 1; seq <= DELTA_LIMITS.maxChunks + 100; seq += 1) {
      state = reduceDelta(state, delta({ id: 'r', kind: 'text', text: '', seq })).state
    }
    assert.equal(state.pending['id:r'].chunks, 0)
    assert.equal(state.pending['id:r'].overflowed, false)
    state = reduceDelta(state, delta({ id: 'r', kind: 'text', text: '真的内容', seq: 999 })).state
    assert.equal(pickLiveTurn(state)?.text, '真的内容')
  })
})

describe('pickLiveTurn：只返回一条该显示的尾巴', () => {
  test('多轮并发取 lastSeq 最大者', () => {
    const state = feed([
      delta({ id: 'slow', kind: 'text', text: '慢的', seq: 3 }),
      delta({ id: 'fast', kind: 'text', text: '快的', seq: 40 }),
    ])
    assert.equal(pickLiveTurn(state)?.text, '快的')
  })

  test('没有 pending 时是 null，不是空轮次', () => {
    assert.equal(pickLiveTurn(createDeltaState()), null)
  })
})

describe('commitAuthoritative：权威一到，影子让位', () => {
  test('按 turn 序号提交对应轮次，并从 pending 删除', () => {
    const state = feed([delta({ epoch: 'e1', kind: 'text', text: '答', seq: 7 })])
    const result = commitAuthoritative(state, [entry({ id: 's9', seq: 9, text: '答', turn: 7 })])
    assert.deepEqual(result.committedKeys, ['anon:e1:text:7'])
    assert.deepEqual(result.state.pending, {})
    assert.equal(pickLiveTurn(result.state), null)
  })

  test('不带 turn 的权威条目视为当前轮：所有 pending 让位', () => {
    const state = feed([
      delta({ id: 'pet-req', epoch: 'e1', kind: 'text', text: '宠物侧', seq: 2 }),
      delta({ epoch: 'e1', kind: 'text', text: '网页侧', seq: 5 }),
    ])
    assert.equal(Object.keys(state.pending).length, 2)
    const result = commitAuthoritative(state, [entry({ id: 's1', seq: 1, text: '答' })])
    assert.equal(result.committedKeys.length, 2)
    assert.deepEqual(result.state.pending, {})
  })

  test('首次拿到 epoch 时，来源不明的旧尾巴一并清掉', () => {
    // 不带 epoch 的增量不知道属于哪个会话；一旦出现带 epoch 的事件，宁可把那条尾巴丢掉，
    // 也不能让它被拼进新会话的正文里。丢尾巴是暂时的（后续增量会重建），串味是永久的。
    const before = feed([delta({ id: 'unknown-epoch', kind: 'text', text: '来路不明', seq: 1 })])
    const after = reduceDelta(before, delta({ epoch: 'e1', kind: 'text', text: '明确会话', seq: 1 }))
    assert.deepEqual(Object.keys(after.state.pending), ['anon:e1:text:1'])
    assert.equal(after.state.epoch, 'e1')
  })

  test('同一轮只提交一次：第二次调用什么都不做', () => {
    const state = feed([delta({ epoch: 'e1', kind: 'text', text: '答', seq: 7 })])
    const entries = [entry({ id: 's1', seq: 7, text: '答', turn: 7 })]
    const first = commitAuthoritative(state, entries)
    assert.deepEqual(first.committedKeys, ['anon:e1:text:7'])
    const second = commitAuthoritative(first.state, entries)
    assert.deepEqual(second.committedKeys, [], '已经提交过的轮次不该被提交第二次')
    assert.equal(second.state, first.state, '没提交就返回同一个 state')
  })

  test('id 键与条目序号对不上时不提交：宁可留着影子，也不把内容藏起来', () => {
    const state = feed([delta({ id: 'pet-req', kind: 'text', text: '宠物侧', seq: 2 })])
    const result = commitAuthoritative(state, [entry({ id: 's1', seq: 1, turn: 1 })])
    assert.deepEqual(result.committedKeys, [])
    assert.equal(pickLiveTurn(result.state)?.text, '宠物侧')
  })

  test('流式条目还不是权威：不提交，影子继续长', () => {
    const state = feed([delta({ id: 'r', kind: 'text', text: '答', seq: 1 })])
    const result = commitAuthoritative(state, [entry({ id: 's1', seq: 1, text: '答', streaming: true })])
    assert.deepEqual(result.committedKeys, [])
    assert.equal(result.state, state)
    assert.equal(pickLiveTurn(result.state)?.text, '答')
  })

  test('不相干的 turn 序号不触发提交', () => {
    const state = feed([delta({ epoch: 'e1', kind: 'text', text: '答', seq: 7 })])
    const result = commitAuthoritative(state, [entry({ id: 's1', seq: 1, turn: 99 })])
    assert.deepEqual(result.committedKeys, [])
    assert.equal(result.state, state)
  })

  test('空条目列表不提交，也不改状态', () => {
    const state = feed([delta({ id: 'r', kind: 'text', text: '答', seq: 1 })])
    assert.deepEqual(commitAuthoritative(state, []), { state, committedKeys: [] })
  })
})
