/**
 * 工作台概览的三行文本：有数据 / 空数据 / 数据源不可用。
 *
 * 这里测的是**格式化与降级**，不碰 SQLite：命令层的价值就在于"数字对不上时仍然说人话"，
 * 而那部分全是纯函数。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  SET_OPTION_HINT,
  describeSetOption,
  parseSetOption,
  UNAVAILABLE_TEXT,
  describeDuration,
  formatMeetingToday,
  formatTodaySummary,
  formatTodoCount,
  summarizeWorkbench,
  type WorkbenchSummarySnapshot,
} from '../src/workbench-summary.ts'

const FULL: WorkbenchSummarySnapshot = {
  openTodos: 3, awaitingUser: 1, meetingsToday: 2, activeMs: 4 * 3_600_000 + 20 * 60_000, topSubject: 'dsh-pet',
}
const EMPTY: WorkbenchSummarySnapshot = {
  openTodos: 0, awaitingUser: 0, meetingsToday: 0, activeMs: 0, topSubject: null,
}

describe('待办数', () => {
  test('有数据：带"待你处理"', () => {
    assert.deepEqual(formatTodoCount(FULL), { text: '待办 3 项（1 项待你处理）', available: true })
  })

  test('有数据但没人等他：不显示括号', () => {
    assert.equal(formatTodoCount({ openTodos: 2, awaitingUser: 0 }).text, '待办 2 项')
  })

  test('空数据：说没有，而不是 0 项', () => {
    assert.deepEqual(formatTodoCount(EMPTY), { text: '没有待办', available: true })
  })

  test('数据源不可用：暂时读不到（不是 0）', () => {
    const line = formatTodoCount({ openTodos: null, awaitingUser: null })
    assert.equal(line.available, false)
    assert.equal(line.text, `${UNAVAILABLE_TEXT}待办数`)
  })
})

describe('今天的会议', () => {
  test('有数据 / 空数据 / 不可用', () => {
    assert.equal(formatMeetingToday(FULL).text, '今天 2 场会议')
    assert.equal(formatMeetingToday(EMPTY).text, '今天还没有会议')
    const missing = formatMeetingToday({ meetingsToday: null })
    assert.equal(missing.available, false)
    assert.equal(missing.text, `${UNAVAILABLE_TEXT}今天的会议`)
  })
})

describe('今日活动摘要', () => {
  test('有数据：时长 + 主要去向', () => {
    assert.deepEqual(formatTodaySummary(FULL), { text: '今天 4 小时 20 分，主要在 dsh-pet', available: true })
  })

  test('没有主要去向时只报时长', () => {
    assert.equal(formatTodaySummary({ activeMs: 90 * 60_000, topSubject: null }).text, '今天 1 小时 30 分')
  })

  test('空数据 / 不可用', () => {
    assert.equal(formatTodaySummary(EMPTY).text, '今天还没有记录到活动')
    const missing = formatTodaySummary({ activeMs: null, topSubject: null })
    assert.equal(missing.available, false)
    assert.equal(missing.text, `${UNAVAILABLE_TEXT}今天的活动`)
  })

  test('时长格式：不到 1 分钟不说成 0', () => {
    assert.equal(describeDuration(0), '不到 1 分钟')
    assert.equal(describeDuration(20_000), '不到 1 分钟')
    assert.equal(describeDuration(60_000), '1 分钟')
    assert.equal(describeDuration(3_600_000), '1 小时')
    assert.equal(describeDuration(3_600_000 + 60_000), '1 小时 1 分')
  })
})

describe('summarizeWorkbench：一次快照算三行', () => {
  test('正常', () => {
    const value = summarizeWorkbench(() => FULL)
    assert.equal(value.todo.text, '待办 3 项（1 项待你处理）')
    assert.equal(value.meeting.text, '今天 2 场会议')
    assert.equal(value.today.text, '今天 4 小时 20 分，主要在 dsh-pet')
  })

  test('快照函数抛异常：三条都降级，绝不抛给命令层', () => {
    const value = summarizeWorkbench(() => { throw new Error('库锁住了') })
    for (const line of [value.todo, value.meeting, value.today]) {
      assert.equal(line.available, false)
      assert.equal(line.text, UNAVAILABLE_TEXT)
    }
  })

  test('每条文案不超过 40 字（前端一行放得下）', () => {
    for (const line of Object.values(summarizeWorkbench(() => FULL))) assert.ok(line.text.length <= 40, line.text)
    for (const line of Object.values(summarizeWorkbench(() => EMPTY))) assert.ok(line.text.length <= 40, line.text)
  })
})

describe('/assistant-set-option 的参数解析', () => {
  test('三种合法键，英文与中文都认', () => {
    assert.deepEqual(parseSetOption('/assistant-set-option wake=on'), { key: 'wake', value: 'on' })
    assert.deepEqual(parseSetOption('/assistant-set-option broadcast=voice'), { key: 'broadcast', value: 'voice' })
    assert.deepEqual(parseSetOption('/assistant-set-option docSpeech=ai'), { key: 'docSpeech', value: 'ai' })
    // 中文键（按钮文案是中文，用户在括号里打中文最自然）
    assert.deepEqual(parseSetOption('/assistant-set-option 唤醒=关'), { key: 'wake', value: 'off' })
    assert.deepEqual(parseSetOption('/assistant-set-option 播报=全部'), { key: 'broadcast', value: 'all' })
    assert.deepEqual(parseSetOption('/assistant-set-option 讲解=原文'), { key: 'docSpeech', value: 'source' })
  })

  test('三种非法输入一律 null，不猜意图', () => {
    assert.equal(parseSetOption('/assistant-set-option'), null, '没参数')
    assert.equal(parseSetOption('/assistant-set-option wake'), null, '缺等号')
    assert.equal(parseSetOption('/assistant-set-option nope=on'), null, '键不认识')
    assert.equal(parseSetOption('/assistant-set-option wake=maybe'), null, '值不在白名单')
    // `broadcast=on` 不能被猜成 all —— 猜错比报错糟得多。
    assert.equal(parseSetOption('/assistant-set-option broadcast=on'), null)
    assert.equal(parseSetOption('/assistant-set-option =on'), null)
    assert.equal(parseSetOption('/assistant-set-option wake='), null)
  })

  test('回执文案逐字', () => {
    assert.equal(describeSetOption('wake', 'on'), '已开启唤醒')
    assert.equal(describeSetOption('wake', 'off'), '已关闭唤醒')
    assert.equal(describeSetOption('broadcast', 'all'), '已设为：所有回复都念')
    assert.equal(describeSetOption('broadcast', 'voice'), '已设为：只念语音发起的')
    assert.equal(describeSetOption('docSpeech', 'ai'), '已设为：AI 讲解')
    assert.equal(describeSetOption('docSpeech', 'source'), '已设为：原文朗读')
  })

  test('参数提示把三组可选值都列出来', () => {
    for (const token of ['wake=on|off', 'broadcast=all|voice', 'docSpeech=source|ai']) {
      assert.ok(SET_OPTION_HINT.includes(token), token)
    }
  })
})
