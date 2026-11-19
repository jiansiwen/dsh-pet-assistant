/**
 * 四张列表的格式化：有数据 / 空 / 读不到。
 *
 * 这里钉的是**客户端能吃**的契约：一行一条、字段用 ` | ` 分隔、空字段 `—`。
 * 前端按行 split 后直接渲染表格，所以格式一旦漂移，界面上不是"不好看"，是**错列**。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  EMPTY_FIELD,
  FIELD_SEPARATOR,
  clockOf,
  formatMeetingHistory,
  describeMeetingSources,
  formatMeetingList,
  describePriority,
  describeSource,
  formatReportList,
  formatSettingsSummary,
  formatTeamList,
  formatTodoList,
  describeMeetingState,
  describeRole,
  describeTaskStatus,
  stampOf,
} from '../src/workbench-lists.ts'

const lines = (text: string): string[] => text.split('\n')

describe('分隔符与字段清理', () => {
  test('字段分隔符是 " | "（两侧都有空格）', () => {
    assert.equal(FIELD_SEPARATOR, ' | ')
  })

  test('空字段写 —，不是空串（空串会让前端少一列）', () => {
    assert.equal(EMPTY_FIELD, '—')
    const text = formatTodoList([{ goal: '改文档', status: 'queued', deadlineAt: null }])
    assert.equal(lines(text)[0].split(FIELD_SEPARATOR).length, 6, '可见五列 + 隐藏 taskId')
    assert.ok(lines(text)[0].endsWith(EMPTY_FIELD), '没有到期时间应显示 —')
  })

  test('字段里的竖线与换行不会把列冲散', () => {
    const text = formatTodoList([{ goal: 'A | B\nC', status: 'running', deadlineAt: null }])
    const columns = lines(text)[0].split(FIELD_SEPARATOR)
    assert.equal(columns.length, 6, '竖线被换成斜杠、换行被压平，列数不变')
    assert.match(columns[0], /A \/ B C/)
  })

  test('时间格式化：有值与无值', () => {
    assert.equal(stampOf(null), EMPTY_FIELD)
    assert.equal(stampOf(0), EMPTY_FIELD)
    assert.match(stampOf(Date.UTC(2026, 0, 2, 3, 4)), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    assert.match(clockOf(Date.now()), /^\d{2}:\d{2}$/)
    assert.equal(clockOf(null), EMPTY_FIELD)
  })

  test('状态与人话说人话，未知原样输出', () => {
    assert.equal(describeTaskStatus('awaiting-user'), '待你处理')
    assert.equal(describeTaskStatus('weird'), 'weird')
    assert.equal(describeRole('wukong'), '助理1')
    assert.equal(describeRole('nobody'), 'nobody')
    assert.equal(describeMeetingState('transcribed'), '已转写')
  })
})

describe('待办列表 /assistant-todo-list', () => {
  test('有数据：一行一条，可见五列 + 隐藏 taskId', () => {
    const text = formatTodoList([
      { goal: '改文档', status: 'awaiting-user', deadlineAt: Date.UTC(2026, 0, 2, 3, 4), priority: 'high', source: 'meeting', updatedAt: 1 },
      { goal: '发邮件', status: 'running', deadlineAt: null, priority: 'normal', source: 'manual', updatedAt: 2 },
    ])
    assert.equal(lines(text).length, 2)
    assert.equal(lines(text)[0].split(FIELD_SEPARATOR).length, 6)
    assert.match(lines(text)[0], /^改文档 \| 高 \| 会议 \| 待你处理 \| /)
    assert.match(lines(text)[1], /^发邮件 \| 中 \| 手动 \| 进行中 \| — \| —$/)
  })

  test('排序：高优先级在前，同优先级按 updatedAt 倒序', () => {
    const text = formatTodoList([
      { goal: '低-新', status: 'queued', deadlineAt: null, priority: 'low', source: 'manual', updatedAt: 900 },
      { goal: '高-旧', status: 'queued', deadlineAt: null, priority: 'high', source: 'ai', updatedAt: 100 },
      { goal: '中-新', status: 'queued', deadlineAt: null, priority: 'normal', source: 'manual', updatedAt: 800 },
      { goal: '高-新', status: 'queued', deadlineAt: null, priority: 'high', source: 'enterprise', updatedAt: 500 },
    ])
    assert.deepEqual(lines(text).map(line => line.split(FIELD_SEPARATOR)[0]), ['高-新', '高-旧', '中-新', '低-新'])
  })

  test('优先级/来源缺失按 中/手动 兜底，不出现空列', () => {
    const columns = formatTodoList([{ goal: '老任务', status: 'queued', deadlineAt: null }]).split(FIELD_SEPARATOR)
    assert.equal(columns.length, 6)
    assert.equal(columns[1], '中')
    assert.equal(columns[2], '手动')
    assert.equal(columns[5], '—', '没有 taskId 时第 6 格是 —，格数仍然整齐')
  })

  test('四种来源都有人话', () => {
    for (const [value, text] of [['manual', '手动'], ['meeting', '会议'], ['enterprise', '企业'], ['ai', 'AI']] as const) {
      assert.equal(describeSource(value), text)
    }
    assert.equal(describeSource('weird'), '手动')
    for (const [value, text] of [['high', '高'], ['normal', '中'], ['low', '低']] as const) {
      assert.equal(describePriority(value), text)
    }
    assert.equal(describePriority(undefined), '中')
  })

  test('最多 20 条', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ goal: `第${i}条`, status: 'queued', deadlineAt: null }))
    assert.equal(lines(formatTodoList(rows)).length, 20)
  })

  test('空数据 / 读不到', () => {
    assert.equal(formatTodoList([]), '还没有待办')
    assert.equal(formatTodoList(null), '暂时读不到待办')
  })
})

describe('会议列表 /assistant-meeting-list', () => {
  const meeting = { startedAt: new Date(2026, 0, 2, 9, 30).getTime(), name: '周会', state: 'transcribed', id: 'm-1' }

  test('有数据：时间 | 名称 | 状态', () => {
    const text = formatMeetingList([meeting])
    const columns = lines(text)[0].split(FIELD_SEPARATOR)
    assert.deepEqual(columns, ['09:30', '周会', '已转写', 'm-1'], '尾列是会议 id，供改名/删除定位')
  })

  test('最多 10 条', () => {
    assert.equal(lines(formatMeetingList(Array.from({ length: 15 }, () => meeting))).length, 10)
  })

  test('空数据 / 读不到', () => {
    assert.equal(formatMeetingList([]), '今天还没有会议')
    assert.equal(formatMeetingList(null), '暂时读不到今天的会议')
  })
})

describe('日报列表 /assistant-report-list', () => {
  test('有数据：日期 | 状态 | 摘要', () => {
    const text = formatReportList([{ date: '2026-01-02', state: '草稿', summary: '今天改了讲解链路' }])
    assert.deepEqual(lines(text)[0].split(FIELD_SEPARATOR), ['2026-01-02', '草稿', '今天改了讲解链路'])
  })

  test('空数据 / 读不到', () => {
    assert.equal(formatReportList([]), '还没有日报草稿')
    assert.equal(formatReportList(null), '暂时读不到日报')
  })
})

describe('成员列表 /assistant-team-list', () => {
  test('有数据：名字 | 角色 | 状态 | 额度', () => {
    const text = formatTeamList([
      { name: '小会', role: 'wukong', enabled: true, quota: '1200/8000' },
      { name: '小助', role: 'custom', enabled: false, quota: '—' },
    ])
    assert.deepEqual(lines(text)[0].split(FIELD_SEPARATOR), ['小会', '助理1', '在岗', '1200/8000'])
    assert.deepEqual(lines(text)[1].split(FIELD_SEPARATOR), ['小助', '自定义', '停用', '—'])
  })

  test('空数据 / 读不到', () => {
    assert.equal(formatTeamList([]), '还没有成员')
    assert.equal(formatTeamList(null), '暂时读不到成员')
  })
})

describe('设置摘要 /assistant-settings-summary（只三行，第四行没有真值）', () => {
  test('唤醒：三种状态逐字', () => {
    assert.equal(formatSettingsSummary({ wakeEnabled: false }), '唤醒 | 关')
    assert.equal(formatSettingsSummary({ wakeEnabled: true, wakeVoiceprint: true }), '唤醒 | 开 · 只认我的声音')
    assert.equal(formatSettingsSummary({ wakeEnabled: true, wakeVoiceprint: false }), '唤醒 | 开 · 谁都行')
  })

  test('播报：按真正的开关 readReplies 取两种说法', () => {
    assert.equal(formatSettingsSummary({ readReplies: true }), '播报 | 所有回复都念')
    assert.equal(formatSettingsSummary({ readReplies: false }), '播报 | 只念语音发起的')
  })

  test('讲解模式：两种逐字', () => {
    assert.equal(formatSettingsSummary({ docSpeechMode: 'ai' }), '讲解模式 | AI 讲解')
    assert.equal(formatSettingsSummary({ docSpeechMode: 'source' }), '讲解模式 | 原文朗读')
  })

  test('三项齐全时按固定顺序成表，且不含「悬停工具栏」', () => {
    const text = formatSettingsSummary({ wakeEnabled: true, wakeVoiceprint: true, readReplies: false, docSpeechMode: 'ai' })
    assert.deepEqual(text.split('\n'), [
      '唤醒 | 开 · 只认我的声音',
      '播报 | 只念语音发起的',
      '讲解模式 | AI 讲解',
    ])
    assert.equal(text.includes('悬停'), false, '这一行没有主进程数据源，不许出现')
  })

  test('读不到 / 字段缺失：整条降级，不猜值', () => {
    assert.equal(formatSettingsSummary(null), '暂时读不到设置')
    assert.equal(formatSettingsSummary({}), '暂时读不到设置')
    assert.equal(formatSettingsSummary({ wakeEnabled: 'yes', readReplies: 1, docSpeechMode: 'huh' }), '暂时读不到设置')
  })

  test('只有部分字段可读时，只输出读得到的那几行', () => {
    assert.equal(formatSettingsSummary({ readReplies: true }), '播报 | 所有回复都念')
  })
})

describe('历史会议 /assistant-meeting-history', () => {
  const row = (over: Partial<Parameters<typeof formatMeetingHistory>[0] extends readonly (infer T)[] | null ? T : never> = {}) => ({
    startedAt: new Date(2026, 10, 12, 14, 30).getTime(),
    name: '周会', sources: 'mic+loopback', retentionDays: 30, transcriptStatus: '已转写', id: 'm-1', ...over,
  })

  test('有数据：5 列，日期时间带日期（历史跨天）', () => {
    const text = formatMeetingHistory([row()])
    const columns = text.split(' | ')
    assert.equal(columns.length, 6)
    assert.deepEqual(columns, ['2026-11-12 14:30', '周会', '麦克风+系统声', '30 天', '已转写', 'm-1'])
  })

  test('来源三种组合：两种真实值 + 未知', () => {
    assert.equal(describeMeetingSources('mic'), '仅麦克风')
    assert.equal(describeMeetingSources('mic+loopback'), '麦克风+系统声')
    assert.equal(describeMeetingSources('loopback-only'), '—')
    assert.equal(describeMeetingSources(undefined), '—')
  })

  test('字段缺失时该格为 —，列数不变', () => {
    const columns = formatMeetingHistory([{ startedAt: 0 }]).split(' | ')
    assert.equal(columns.length, 6)
    assert.deepEqual(columns, ['—', '—', '—', '—', '—', '—'], '缺 id 时尾列占位 —，不丢行')
  })

  test('每行第 6 格是真实 taskId，且前 5 格与原来逐字一致', () => {
    const text = formatTodoList([
      { goal: '改文档', status: 'queued', deadlineAt: null, priority: 'high', source: 'meeting', updatedAt: 2, taskId: 'task-abc' },
      { goal: '发周报', status: 'queued', deadlineAt: null, priority: 'normal', source: 'manual', updatedAt: 1, taskId: 'task-def' },
    ])
    const rows = text.split('\n').map(line => line.split(FIELD_SEPARATOR))
    assert.deepEqual(rows[0].slice(0, 5), ['改文档', '高', '会议', '排队中', '—'])
    assert.equal(rows[0][5], 'task-abc')
    assert.deepEqual(rows[1].slice(0, 5), ['发周报', '中', '手动', '排队中', '—'])
    assert.equal(rows[1][5], 'task-def')
    // ID 里若混进分隔符，清洗后仍在同一格，不会把行切歪。
    const dirty = formatTodoList([{ goal: 'x', status: 'queued', deadlineAt: null, taskId: 'a | b' }])
    assert.equal(dirty.split(FIELD_SEPARATOR).length, 6)
    assert.equal(dirty.split(FIELD_SEPARATOR)[5], 'a / b')
  })

  test('第五态「转写失败」原样透传：插件侧不做白名单过滤', () => {
    const columns = formatMeetingHistory([row({ transcriptStatus: '转写失败' })]).split(' | ')
    assert.equal(columns[4], '转写失败')
  })

  test('最多 20 行', () => {
    assert.equal(formatMeetingHistory(Array.from({ length: 25 }, () => row())).split('\n').length, 20)
  })

  test('空 / 读不到', () => {
    assert.equal(formatMeetingHistory([]), '还没有历史会议')
    assert.equal(formatMeetingHistory(null), '暂时读不到历史会议')
  })
})
