/**
 * 会话状态纠偏的行为契约。
 *
 * 现场问题：回复早就结束了，宠物还在对着电脑敲。根因是宿主的事件按作用域分发，
 * `agent/status` 未必每次送到插件，会话状态于是永远停在 running。
 * 这条规则让日志本身成为最终依据：最后一条边界是 turn/end 就是空闲。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { latestTurnEnded, type MirrorEvent } from '../src/bridge.ts'

const event = (type: string, data: Record<string, unknown> = {}): MirrorEvent => ({ type, data })
const user = (text: string): MirrorEvent => ({ type: 'user/message', data: { id: 'm1', content: [{ type: 'text', text }] } })

describe('latestTurnEnded', () => {
  test('最后是 turn/end：这一轮结束了', () => {
    const events = [event('turn/start', { turn: 1 }), user('你好'), event('turn/end', { turn: 1, reason: { kind: 'completed' } })]
    assert.equal(latestTurnEnded(events), true)
  })

  test('新一轮已经开始：不是空闲', () => {
    const events = [
      event('turn/start', { turn: 1 }), user('第一句'), event('turn/end', { turn: 1 }),
      event('turn/start', { turn: 2 }), user('第二句'),
    ]
    assert.equal(latestTurnEnded(events), false, '第二轮还在跑，不能报空闲')
  })

  test('只有 turn/start、没有结束：在跑', () => {
    assert.equal(latestTurnEnded([event('turn/start', { turn: 1 }), user('在吗')]), false)
  })

  test('空日志或只有无关事件：不推断空闲', () => {
    assert.equal(latestTurnEnded([]), false)
    assert.equal(latestTurnEnded([event('session/title', { title: 'x' })]), false)
  })

  test('turn/end 之后又来了流水（如标题、工具结果）：仍算结束', () => {
    const events = [
      event('turn/start', { turn: 1 }), event('turn/end', { turn: 1 }),
      event('session/title', { title: '讨论方案' }), event('tool/result', {}),
    ]
    assert.equal(latestTurnEnded(events), true)
  })
})
