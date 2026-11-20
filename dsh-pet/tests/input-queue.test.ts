/**
 * 输入队列的测试：三种拒绝、TTL 边界、失效项跳过、停止回填。
 *
 * 这一份钉的是"忙时说的话不会消失"：每一种拒绝都必须是**可以告诉用户的**（带 reason），
 * 不能是静默返回 null。队列的边界（第 4 条、正好 4000 字、正好 60 秒）在真实使用里一定会
 * 撞上，靠开壳凑不出这些场面，只能靠用例。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  DEFAULT_QUEUE_LIMITS,
  drainForStop,
  dropExpired,
  enqueue,
  removeById,
  takeNext,
  type QueuedInput,
  type QueueLimits,
} from '../src/renderer/input-queue.ts'

function item(id: string, text: string, enqueuedAt = 0, source: QueuedInput['source'] = 'typed'): QueuedInput {
  return { id, text, enqueuedAt, source }
}

/** 造一个已经排好 n 条的队列。 */
function queueOf(...texts: string[]): QueuedInput[] {
  return texts.map((text, index) => item(`q${index}`, text, index * 10))
}

describe('默认限额', () => {
  test('3 条 / 60 秒 / 4000 字', () => {
    assert.deepEqual(DEFAULT_QUEUE_LIMITS, { maxItems: 3, ttlMs: 60_000, maxChars: 4000 })
  })
})

describe('enqueue：三种拒绝都要说清原因', () => {
  test('空文本（含只有空白）拒收，队列原样', () => {
    const queue = queueOf('一')
    for (const text of ['', '   ', '\n\t ']) {
      const outcome = enqueue(queue, item('new', text, 100))
      assert.equal(outcome.ok, false)
      assert.equal(outcome.ok === false && outcome.reason, 'empty')
      assert.equal(outcome.queue.length, 1)
    }
  })

  test('入队时存 trim 后的正本，输入对象本身不被改', () => {
    const input = item('new', '  帮我看下这个 PR\n', 100)
    const outcome = enqueue([], input)
    assert.equal(outcome.ok, true)
    assert.equal(outcome.queue.length, 1)
    assert.equal(outcome.queue[0].text, '帮我看下这个 PR')
    assert.equal(input.text, '  帮我看下这个 PR\n', '原对象不该被就地改写')
  })

  test('恰好到 maxChars 通过，多一个字拒收 too-long', () => {
    const limits: QueueLimits = { maxItems: 3, ttlMs: 60_000, maxChars: 10 }
    assert.equal(enqueue([], item('a', 'x'.repeat(10), 0), limits).ok, true)
    const tooLong = enqueue([], item('b', 'x'.repeat(11), 0), limits)
    assert.equal(tooLong.ok, false)
    assert.equal(tooLong.ok === false && tooLong.reason, 'too-long')
  })

  test('排满 maxItems 后拒收 full，绝不静默丢弃', () => {
    const limits = DEFAULT_QUEUE_LIMITS
    const full = queueOf('一', '二', '三')
    assert.equal(full.length, limits.maxItems)
    const outcome = enqueue(full, item('new', '四', 100), limits)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, 'full')
    assert.equal(outcome.queue.length, 3, '满了就是满了，原队列一条不少')
  })

  test('第 maxItems 条刚好能进', () => {
    const outcome = enqueue(queueOf('一', '二'), item('new', '三', 100))
    assert.equal(outcome.ok, true)
    assert.equal(outcome.queue.length, 3)
  })

  test('返回的队列永远是副本：调用方拿去做状态更新不会串到入参', () => {
    const queue = queueOf('一')
    const outcome = enqueue(queue, item('new', '二', 100))
    assert.notEqual(outcome.queue, queue)
    assert.equal(queue.length, 1)
  })
})

describe('dropExpired：过期由时间清，不由条数清', () => {
  test('正好到 TTL 算过期，差一毫秒还在', () => {
    const queue = [item('old', '旧', 0), item('fresh', '新', 1)]
    const result = dropExpired(queue, 60_000)
    assert.deepEqual(result.dropped.map(entry => entry.id), ['old'])
    assert.deepEqual(result.queue.map(entry => entry.id), ['fresh'])
    assert.equal(dropExpired([item('edge', '旧', 0)], 59_999).queue.length, 1)
  })

  test('全过期时返回空队列与完整 dropped 名单（调用方要据此说一句"有 2 条太旧了"）', () => {
    const result = dropExpired([item('a', '甲', 0), item('b', '乙', 0)], 120_000)
    assert.deepEqual(result.queue, [])
    assert.equal(result.dropped.length, 2)
  })

  test('空队列不报错', () => {
    assert.deepEqual(dropExpired([], 1000), { queue: [], dropped: [] })
  })
})

describe('takeNext：先过期，再取队首，失效项跳过', () => {
  test('队首选出来，剩下的保持原顺序', () => {
    const result = takeNext(queueOf('一', '二', '三'), 100, DEFAULT_QUEUE_LIMITS)
    assert.equal(result.next?.text, '一')
    assert.deepEqual(result.queue.map(entry => entry.text), ['二', '三'])
    assert.deepEqual(result.dropped, [])
  })

  test('队首过期时不会被发出去，改为取下一条', () => {
    const queue = [item('old', '旧', 0), item('ok', '新', 59_000)]
    const result = takeNext(queue, 60_000, DEFAULT_QUEUE_LIMITS)
    assert.equal(result.next?.id, 'ok')
    assert.deepEqual(result.dropped.map(entry => entry.id), ['old'])
  })

  test('isValid 为 false 的带进 dropped 后继续取，不因为一条失效就整队停下', () => {
    const queue = [item('gone', '发给已删掉的会话', 0), item('ok', '这条还在', 10)]
    const result = takeNext(queue, 100, DEFAULT_QUEUE_LIMITS, entry => entry.id !== 'gone')
    assert.equal(result.next?.id, 'ok')
    assert.deepEqual(result.dropped.map(entry => entry.id), ['gone'])
    assert.deepEqual(result.queue, [])
  })

  test('全部失效时 next 为 null 且全部记进 dropped', () => {
    const result = takeNext(queueOf('一', '二'), 100, DEFAULT_QUEUE_LIMITS, () => false)
    assert.equal(result.next, null)
    assert.equal(result.dropped.length, 2)
    assert.deepEqual(result.queue, [])
  })

  test('空队列取不到东西，也不是错误', () => {
    assert.deepEqual(takeNext([], 100, DEFAULT_QUEUE_LIMITS), { next: null, queue: [], dropped: [] })
  })

  test('不传 isValid 时不做失效判断', () => {
    assert.equal(takeNext(queueOf('一'), 100, DEFAULT_QUEUE_LIMITS).next?.text, '一')
  })
})

describe('removeById 与 drainForStop', () => {
  test('按 id 摘一条，找不到就是原样一份', () => {
    const queue = queueOf('一', '二')
    assert.deepEqual(removeById(queue, 'q0').map(entry => entry.text), ['二'])
    assert.deepEqual(removeById(queue, '不存在').map(entry => entry.text), ['一', '二'])
  })

  test('停止生成时清空并按原顺序拼回，供回填输入框', () => {
    const drained = drainForStop([item('a', '第一句', 0), item('b', '第二句', 10, 'voice')])
    assert.deepEqual(drained.queue, [])
    assert.equal(drained.restoredText, '第一句\n第二句')
  })

  test('空队列停止时回填空串，不返回 undefined 让调用方去判空', () => {
    assert.deepEqual(drainForStop([]), { queue: [], restoredText: '' })
  })
})
