/**
 * 概览格显示口径的测试。
 *
 * 钉住一条边界：**「暂时读不到」不是 0**。会议那格当前恒为读不到，一旦有人"顺手补个默认值"，
 * 用户看到的就会是一个煞有介事的 0 —— 那比空着更有害。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { overviewValue } from '../src/client/overview.ts'

describe('有数据：放大片段 + 原句', () => {
  it('待办数', () => {
    assert.deepEqual(overviewValue('todo', '待办 3 项（1 项待你处理）'), {
      value: '3', detail: '待办 3 项（1 项待你处理）', kind: 'metric',
    })
    assert.deepEqual(overviewValue('todo', '待办 2 项'), { value: '2', detail: '待办 2 项', kind: 'metric' })
  })

  it('会议场次（正则保留，等后端接上数据源就能用）', () => {
    assert.deepEqual(overviewValue('meeting', '今天 1 场会议'), { value: '1', detail: '今天 1 场会议', kind: 'metric' })
  })

  it('今日活动：时长整段搬过来，不做单位换算', () => {
    assert.deepEqual(overviewValue('summary', '今天 4 小时 20 分，主要在 dsh-pet'), {
      value: '4 小时 20 分', detail: '今天 4 小时 20 分，主要在 dsh-pet', kind: 'metric',
    })
    assert.deepEqual(overviewValue('summary', '今天 1 小时 30 分'), {
      value: '1 小时 30 分', detail: '今天 1 小时 30 分', kind: 'metric',
    })
  })
})

describe('没有可放大的片段：原句直接放值区', () => {
  it('没有待办', () => {
    assert.deepEqual(overviewValue('todo', '没有待办'), { value: '没有待办', detail: null, kind: 'plain' })
  })

  it('今天还没有记录到活动', () => {
    assert.deepEqual(overviewValue('summary', '今天还没有记录到活动'), {
      value: '今天还没有记录到活动', detail: null, kind: 'plain',
    })
  })
})

describe('读不到：灰显，绝不显示 0', () => {
  it('三类命令的「暂时读不到」都原样显示', () => {
    for (const [command, text] of [
      ['todo', '暂时读不到待办数'],
      ['meeting', '暂时读不到今天的会议'],
      ['summary', '暂时读不到今天的活动'],
    ] as const) {
      const readout = overviewValue(command, text)
      assert.equal(readout.kind, 'unavailable', text)
      assert.equal(readout.value, text)
      assert.equal(readout.detail, null)
      assert.notEqual(readout.value, '0')
    }
  })

  it('空文本按读不到处理，不抛错也不显示空值', () => {
    assert.deepEqual(overviewValue('todo', '   '), { value: '暂时读不到', detail: null, kind: 'unavailable' })
  })
})
