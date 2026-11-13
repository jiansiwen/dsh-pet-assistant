/**
 * 历史会议列表的映射规则（四种转写状态、limit 夹取、字段形状）。
 *
 * 纯函数测试：不碰 SQLite、不开音频。四种状态是这轮唯一有判断含量的逻辑，
 * 真机上很难凑齐（要么等一场会真的录坏），所以必须在这里逐条钉死。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  clampHistoryLimit,
  meetingHistoryRows,
  transcriptStatusOf,
  type IntegrityLike,
} from '../src/main/meeting-history.ts'

const integrity = (status: string, persisted: Array<number | null>): IntegrityLike => ({
  status,
  tracks: Object.fromEntries(persisted.map((value, index) => [`t${index}`, { persisted: value }])),
})

describe('transcriptStatusOf：四种状态', () => {
  test('persisted 合计为 0 → 未转写（哪怕 integrity=complete）', () => {
    assert.equal(transcriptStatusOf(integrity('complete', [0, 0])), '未转写')
    assert.equal(transcriptStatusOf(integrity('complete', [null, null])), '未转写')
    assert.equal(transcriptStatusOf(null), '未转写', '旧记录没有完整性证据、也没有块 → 未转写')
  })

  test('complete 且 persisted > 0 → 已转写', () => {
    assert.equal(transcriptStatusOf(integrity('complete', [3, 2])), '已转写')
  })

  test('incomplete 且 persisted > 0 → 部分转写', () => {
    assert.equal(transcriptStatusOf(integrity('incomplete', [4, 0])), '部分转写')
    assert.equal(transcriptStatusOf(integrity('incomplete', [1])), '部分转写')
  })

  test('unknown / 无字段 / 旧记录 → 状态未知（persisted > 0 时）', () => {
    assert.equal(transcriptStatusOf(integrity('unknown', [5])), '状态未知')
    assert.equal(transcriptStatusOf({ tracks: { mic: { persisted: 2 } } }), '状态未知', '没有 status 也算未知')
  })

  test('先判 persisted 再判 integrity：没录到音频绝不说"已转写"', () => {
    assert.equal(transcriptStatusOf(integrity('complete', [0])), '未转写')
  })
})

describe('transcriptStatusOf：第五态「转写失败」（整场 ASR 全失败）', () => {
  // 假绿比缺失更糟：用户看到"已转写"会去翻纪要，结果里面是空的 —— 那一刻这张表上
  // 任何状态都不再可信。所以失败要单独成态，而且判序最前（覆盖 integrity 与 persisted）。
  test('transcript-failed + integrity=complete + persisted>0 → 转写失败（反向证明：四态会误判成"已转写"）', () => {
    assert.equal(transcriptStatusOf(integrity('complete', [9, 8]), 'transcript-failed'), '转写失败')
  })

  test('transcript-failed + persisted=0 → 也是转写失败（失败是整场事实，不因有没有落盘改变）', () => {
    assert.equal(transcriptStatusOf(integrity('complete', [0]), 'transcript-failed'), '转写失败')
    assert.equal(transcriptStatusOf(null, 'transcript-failed'), '转写失败')
  })

  test('其它 state 不抢四态：transcribed/recording 等仍按 integrity+persisted 判', () => {
    assert.equal(transcriptStatusOf(integrity('complete', [3]), 'transcribed'), '已转写')
    assert.equal(transcriptStatusOf(integrity('complete', [0]), 'recording'), '未转写')
    assert.equal(transcriptStatusOf(integrity('incomplete', [2]), 'stopping'), '部分转写')
  })
})

describe('clampHistoryLimit：夹到 1–50，缺省 20', () => {
  test('正常值原样，越界夹紧，非数字回缺省', () => {
    assert.equal(clampHistoryLimit(20), 20)
    assert.equal(clampHistoryLimit(0), 1)
    assert.equal(clampHistoryLimit(-5), 1)
    assert.equal(clampHistoryLimit(999), HISTORY_MAX_LIMIT)
    assert.equal(clampHistoryLimit(3.7), 3)
    assert.equal(clampHistoryLimit(undefined), HISTORY_DEFAULT_LIMIT)
    assert.equal(clampHistoryLimit('30'), HISTORY_DEFAULT_LIMIT)
    assert.equal(clampHistoryLimit(Number.NaN), HISTORY_DEFAULT_LIMIT)
  })
})

describe('meetingHistoryRows：字段形状与截断', () => {
  const row = (over: Partial<Parameters<typeof meetingHistoryRows>[0][number]> = {}) => ({
    id: 'm1', name: '周会', startedAt: 1_700_000_000_000, endedAt: null,
    sources: 'mic+loopback', retentionDays: 30, integrity: integrity('complete', [2]), ...over,
  })

  test('七个字段一个不多一个不少，名称与来源原样带出', () => {
    const [only] = meetingHistoryRows([row()], 20)
    assert.deepEqual(Object.keys(only).sort(), [
      'endedAt', 'id', 'integrityStatus', 'name', 'retentionDays', 'sources', 'startedAt', 'transcriptStatus',
    ].sort())
    assert.equal(only.name, '周会')
    assert.equal(only.sources, 'mic+loopback')
    assert.equal(only.integrityStatus, 'complete')
    assert.equal(only.transcriptStatus, '已转写')
  })

  test('limit 生效，且不重排（保持库给的顺序）', () => {
    const rows = meetingHistoryRows([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })], 2)
    assert.deepEqual(rows.map(item => item.id), ['a', 'b'])
  })

  test('空库 → 空数组，不是报错', () => {
    assert.deepEqual(meetingHistoryRows([], 20), [])
  })

  test('state 参与映射：transcript-failed 的记录整行标转写失败', () => {
    const [only] = meetingHistoryRows([row({ state: 'transcript-failed' })], 20)
    assert.equal(only.transcriptStatus, '转写失败')
  })

  test('旧记录（integrity=null）如实标 unknown / 未转写，不编造', () => {
    const [only] = meetingHistoryRows([row({ integrity: null })], 20)
    assert.equal(only.integrityStatus, 'unknown')
    assert.equal(only.transcriptStatus, '未转写')
  })
})
