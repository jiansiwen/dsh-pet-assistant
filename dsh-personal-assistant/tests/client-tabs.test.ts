/**
 * 工作台七个 tab 的配置与状态口径。
 *
 * 钉住两件事：
 * 1. **tab 的标题与顺序**（用户按这个找东西，挪动一处就是换了一条路径）；
 * 2. **空态与"读不到"必须是两句不同的话** —— 「还没有待办」是连上了确实没有，
 *    「暂时读不到待办」是压根没拿到。混成一句会让用户以为事情做完了，或以为系统坏了。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  LIST_TABS, LIST_SEPARATOR, MEETING_HISTORY, MEETING_HISTORY_COMMAND, NARROW_HIDDEN_COLUMNS, SETTINGS_SUMMARY,
  SETTINGS_SUMMARY_COMMAND, TABS,
  PRIORITY_CHOICES, columnClassName, columnTone, narrowTableCss, parseList, parseSettingsSummary,
  priorityCommand, priorityLabel, priorityOutcome, priorityTone, reconcilePending, rowMeetingId, rowTaskId, statusTone, tableView, workbenchEntries,
} from '../src/client/tabs.ts'

/**
 * 取每一行的**可见格**。
 *
 * 解析结果现在按行返回 `{ cells, trailing }`（trailing 是隐藏尾列，如 taskId）。
 * 下面绝大多数断言只关心可见格，所以统一从这个口子取 —— 不是图省事：
 * 如果每处自己写 `.map(row => row.cells)`，改结构时会漏掉几处，而漏掉的那处不会红，只会静默错。
 */
const cells = (parsed: { rows: readonly { cells: readonly string[] }[] }): (readonly string[])[] =>
  parsed.rows.map(row => row.cells)

describe('工作台与设置分组', () => {
  it('保留九项功能，工作与配置分开，其他设置在最后', () => {
    assert.deepEqual(workbenchEntries('workbench').map(item => item.id), ['todo', 'report', 'meeting'])
    assert.deepEqual(workbenchEntries('settings').map(item => item.id), ['team', 'skills', 'pet', 'mail', 'wecom', 'settings'])
    assert.equal(workbenchEntries('settings').at(-1)?.label, '其他设置')
  })

  it('搜索匹配名称与说明，只在所选分组和分类下找功能', () => {
    assert.deepEqual(workbenchEntries('settings', '  唤醒  ').map(item => item.id), ['settings'])
    assert.deepEqual(workbenchEntries('workbench', '唤醒'), [])
    assert.deepEqual(workbenchEntries('settings', '学习样本', 'pet'), [])
    assert.deepEqual(workbenchEntries('settings', '', 'pet').map(item => item.id), ['pet'])
  })

  it('文案里不出现实现词', () => {
    const all = [
      ...TABS.map(tab => tab.label),
      ...Object.values(LIST_TABS).flatMap(item => [item.empty, item.unavailable, item.hint, ...item.columns.map(c => c.label)]),
      ...SETTINGS_SUMMARY.flatMap(item => [item.label, item.note]),
    ].join(' ')
    for (const word of ['FTS', 'ASR', 'token', 'prompt', 'embedding', 'IPC']) {
      assert.ok(!all.includes(word), `出现了实现词「${word}」`)
    }
  })
})

describe('列表 tab 的列与状态说法', () => {
  it('四个列表 tab 各有列定义，命令与服务端一致', () => {
    assert.deepEqual(
      (['todo', 'report', 'meeting', 'team'] as const).map(id => LIST_TABS[id].command),
      ['/assistant-todo-list', '/assistant-report-list', '/assistant-meeting-list', '/assistant-team-list'],
    )
    for (const id of ['todo', 'report', 'meeting', 'team'] as const) {
      assert.ok(LIST_TABS[id].columns.length >= 3, id)
    }
    // 列序由服务端钉死：前端只按 split 取，不重排。这里同时钉住"前端认的列序"。
    assert.deepEqual(LIST_TABS.todo.columns.map(column => column.label), ['标题', '优先级', '来源', '状态', '到期'])
    assert.deepEqual(LIST_TABS.meeting.columns.map(column => column.label), ['时间', '名称', '状态'])
    assert.deepEqual(LIST_TABS.report.columns.map(column => column.label), ['日期', '状态', '摘要'])
    assert.deepEqual(LIST_TABS.team.columns.map(column => column.label), ['名字', '角色', '状态', '额度'])
  })

  it('空态与读不到是两句不同的话', () => {
    for (const id of ['todo', 'report', 'meeting', 'team'] as const) {
      const definition = LIST_TABS[id]
      assert.notEqual(definition.empty, definition.unavailable, id)
      assert.ok(definition.unavailable.startsWith('暂时读不到'), definition.unavailable)
    }
  })

  it('tableView 把三种"没有行"说成三句不同的话，有行时不说话', () => {
    const definition = LIST_TABS.todo
    assert.equal(tableView('rows', definition).message, null)
    assert.equal(tableView('loading', definition).message, '读取中…')
    assert.equal(tableView('empty', definition).message, definition.empty)
    assert.equal(tableView('unavailable', definition).message, definition.unavailable)
  })
})

describe('设置摘要', () => {
  it('三项且都是只读说明；不再为"悬停工具栏"保留占位行', () => {
    assert.deepEqual(SETTINGS_SUMMARY.map(item => item.label), ['唤醒', '播报', '讲解模式'])
    for (const item of SETTINGS_SUMMARY) assert.ok(item.note.length > 0, item.label)
    assert.ok(!SETTINGS_SUMMARY.some(item => item.label.includes('悬停')), '悬停不是持久化设置，不该占一行')
  })

  it('命令名固定', () => {
    assert.equal(SETTINGS_SUMMARY_COMMAND, '/assistant-settings-summary')
  })

  it('两列正常解析：标题 / 值', () => {
    const parsed = parseSettingsSummary('唤醒 | 开 · 只认我的声音\n播报 | 语音发起的会念\n讲解模式 | 原文朗读')
    assert.equal(parsed.state, 'rows')
    assert.deepEqual(parsed.rows, [
      ['唤醒', '开 · 只认我的声音'],
      ['播报', '语音发起的会念'],
      ['讲解模式', '原文朗读'],
    ])
    assert.equal(parsed.message, null)
  })

  it('只认两列：有一行三列就整条降级成提示语，不硬拆成错位的两列', () => {
    const parsed = parseSettingsSummary('唤醒 | 开\n播报 | 念 | 多出来的一列')
    assert.equal(parsed.state, 'unavailable')
    assert.deepEqual(parsed.rows, [])
    assert.equal(parsed.message, '唤醒 | 开')
  })

  it('空回包 / 一句话回包都降级为「暂时读不到设置」', () => {
    for (const text of ['', '   ', '暂时读不到设置']) {
      const parsed = parseSettingsSummary(text)
      assert.equal(parsed.state, 'unavailable', JSON.stringify(text))
      assert.deepEqual(parsed.rows, [])
      assert.ok(parsed.message === '暂时读不到设置', parsed.message ?? '')
    }
  })
})


/**
 * 列表回包的解析（服务端契约：`\n` 分行、`" | "` 分列、缺字段是 `—`）。
 *
 * 这几条钉的是"表格会不会错位"：少一列就整行左移，用户读到的是别人的列。
 */
describe('parseList：分行、分列、空态与降级态', () => {
  // 用「助理团」这张没有历史包袱的四列表来钉通用规则：待办有换列兼容要单独钉（见下一段）。
  const team = LIST_TABS.team

  it('正常表格：按固定分隔符切，列数与表头一致', () => {
    const parsed = parseList('小会 | 助理1 | 在岗 | 1200/8000\n阿七 | 助理2 | 休息 | —', team)
    assert.equal(parsed.state, 'rows')
    assert.equal(parsed.message, null)
    assert.deepEqual(cells(parsed), [
      ['小会', '助理1', '在岗', '1200/8000'],
      ['阿七', '助理2', '休息', '—'],
    ])
  })

  it('分隔符是常量 " | "：单竖线不是分隔符', () => {
    assert.equal(LIST_SEPARATOR, ' | ')
    const parsed = parseList('a | b | c | d', team)
    assert.deepEqual(cells(parsed), [['a', 'b', 'c', 'd']])
    // 没有 " | " 的行不参与表格：整包只有一句话时按空态处理
    assert.equal(parseList('a|b|c|d', team).state, 'empty')
  })

  it('少列时补 `—`，不让整行左移；空单元格也补 `—`', () => {
    assert.deepEqual(cells(parseList('小会 | 助理1', team)), [['小会', '助理1', '—', '—']])
    assert.deepEqual(cells(parseList('小会 |  | 在岗 | 1', team)), [['小会', '—', '在岗', '1']])
  })

  it('多列时截断到表头列数（后端加列也撑不坏别的表）', () => {
    const parsed = parseList('a | b | c | d | 多出来的一列', team)
    assert.equal(parsed.rows[0].cells.length, 4)
    assert.equal(parsed.rows[0].cells[3], 'd')
  })

  it('一句话回包：`暂时读不到…` 是降级态，其余是空态，原句照显示', () => {
    const degraded = parseList('暂时读不到今天的会议', LIST_TABS.meeting)
    assert.equal(degraded.state, 'unavailable')
    assert.equal(degraded.message, '暂时读不到今天的会议')
    assert.deepEqual(degraded.rows, [])

    const empty = parseList('还没有待办', team)
    assert.equal(empty.state, 'empty')
    assert.equal(empty.message, '还没有待办')
    assert.deepEqual(empty.rows, [])
  })

  it('空回包按提示语处理：既不是表格，也不冒充"读不到"', () => {
    const parsed = parseList('   \n  ', team)
    assert.equal(parsed.state, 'empty')
    assert.equal(parsed.message, '还没有数据')
    assert.deepEqual(cells(parsed), [])
  })

  it('每行都是 `—` 的成员表也算表格（额度为空是常态）', () => {
    const parsed = parseList('小会 | 助理1 | 在岗 | 1200/8000\n阿七 | — | 休息 | —', team)
    assert.equal(parsed.state, 'rows')
    assert.equal(parsed.rows.length, 2)
    assert.equal(parsed.rows[1].cells[3], '—')
  })
})


/**
 * 待办从 3 列扩到 5 列（`标题 | 优先级 | 来源 | 状态 | 到期`）。
 *
 * 这段钉三件事：
 * 1. 五列表头的列名与列宽（定宽是给短枚举留的，不能跟着内容抖）；
 * 2. **旧 3 列回包不会错位**——这是本轮唯一有真实风险的地方：新列是插在中间的，
 *    按尾部补 `—` 会让「状态」落到「优先级」列、「到期」落到「来源」列；
 * 3. 优先级只给 `高` 上色，`中`/`低`/未知档一律落灰。
 */
describe('待办：5 列与旧 3 列兼容', () => {
  const todo = LIST_TABS.todo

  it('五列，列名与列宽固定', () => {
    assert.deepEqual(todo.columns.map(column => column.key), ['title', 'priority', 'source', 'status', 'due'])
    assert.deepEqual(todo.columns.map(column => column.width), ['1 1 0', '72px', '72px', '96px', '128px'])
    // 到期 128px：`2026-01-03 08:00` 16 个半角字符、13px 下约 115px，112px 会截断；128px 留 ~13px。
    // 也不取历史会议日期列的 148px —— 到期是次要信息，不该和标题争宽。
    assert.equal(todo.columns[4].width, '128px')
  })

  it('5 列新回包：原样落到对应列，不错位', () => {
    const parsed = parseList('改讲解链路 | 高 | 会议 | 待你处理 | 2026-01-03', todo)
    assert.equal(parsed.state, 'rows')
    assert.deepEqual(cells(parsed), [['改讲解链路', '高', '会议', '待你处理', '2026-01-03']])
  })

  it('5 列缺字段：照服务端约定是 `—`，缺失格补 `—` 而不左移', () => {
    assert.deepEqual(
      cells(parseList('改讲解链路 | 高 | — | 待你处理 | —', todo)),
      [['改讲解链路', '高', '—', '待你处理', '—']],
    )
    // 万一某格是空串（不是 `—`），也补成 `—`
    assert.deepEqual(
      cells(parseList('改讲解链路 |  | 会议 | 待你处理 | 2026-01-03', todo)),
      [['改讲解链路', '—', '会议', '待你处理', '2026-01-03']],
    )
  })

  it('旧 3 列回包：状态搬进第 4 列、到期搬进第 5 列，优先级与来源补 `—`', () => {
    const parsed = parseList('改讲解链路 | 待你处理 | —\n回滚方案 | 进行中 | 2026-01-03', todo)
    assert.equal(parsed.state, 'rows')
    assert.deepEqual(cells(parsed), [
      ['改讲解链路', '—', '—', '待你处理', '—'],
      ['回滚方案', '—', '—', '进行中', '2026-01-03'],
    ])
    // 关键：旧回包的「状态」绝不能出现在优先级列（那是错位），也不能被吞掉
    assert.equal(parsed.rows[1].cells[1], '—')
    assert.equal(parsed.rows[1].cells[3], '进行中')
  })

  it('每行都是 `columns.length` 格：前端永远画五列，列数不会随回包变', () => {
    for (const text of ['a | b | c', 'a | b | c | d | e', 'a | b', 'a']) {
      const parsed = parseList(text, todo)
      for (const row of parsed.rows) assert.equal(row.cells.length, 5, text)
    }
  })

  it('列数判定不会误伤别的表：其他 tab 没有 legacy 映射', () => {
    for (const id of ['report', 'meeting', 'team'] as const) {
      assert.equal(LIST_TABS[id].legacy, undefined, id)
    }
    // 助理团四列，给三格就按原序补一格，不重排
    assert.deepEqual(cells(parseList('小会 | 助理1 | 在岗', LIST_TABS.team)), [['小会', '助理1', '在岗', '—']])
  })
})

describe('优先级配色：只有 `高` 上色', () => {
  it('`高` 用砖红（与「转写失败」同色，都是"要留意"）', () => {
    assert.equal(priorityTone('高'), '#c2410c')
    assert.equal(priorityTone('高'), statusTone('转写失败'))
  })

  it('`中` / `低` / 未知档 / 空值都落默认灰（不抛错、不吞值）', () => {
    for (const value of ['中', '低', '紧急', 'high', '', '—']) {
      assert.equal(priorityTone(value), null, `「${value}」不该上色`)
    }
    assert.equal(priorityTone(' 高 '), '#c2410c')
  })

  it('columnTone 三态：没配色的列 undefined、有配色但没命中 null、命中给颜色', () => {
    assert.equal(columnTone('title', '高'), undefined)
    assert.equal(columnTone(undefined, '高'), undefined)
    assert.equal(columnTone('priority', '中'), null)
    assert.equal(columnTone('priority', '高'), '#c2410c')
    // 状态列行为不变
    assert.equal(columnTone('status', '转写失败'), '#c2410c')
    assert.equal(columnTone('status', '已转写'), null)
  })
})

describe('窄屏（<720px）隐藏列', () => {
  it('待办隐藏「来源」「到期」，历史会议隐藏「来源」「保留期」', () => {
    assert.deepEqual(NARROW_HIDDEN_COLUMNS, [
      { prefix: 'todo', key: 'source' },
      { prefix: 'todo', key: 'due' },
      { prefix: 'history', key: 'source' },
      { prefix: 'history', key: 'retention' },
    ])
  })

  it('生成的选择器带完整前缀（手写 `.wb-col-source` 会静默失配）', () => {
    const css = narrowTableCss()
    assert.ok(css.includes('@media (max-width: 720px)'), css)
    for (const column of NARROW_HIDDEN_COLUMNS) {
      assert.ok(css.includes(`.${columnClassName(column.prefix, column.key)}`), css)
    }
    // 只留标题/优先级/状态：来源与到期不在隐藏清单里的都没有
    assert.ok(!css.includes('.wb-col-todo-title'), css)
    assert.ok(!css.includes('.wb-col-todo-status'), css)
    assert.ok(css.includes('display: none !important'), css)
  })
})


/**
 * 会议 tab 的「最近会议」：五列。
 *
 * 这张表最容易被后端加列悄悄撑坏，所以列数校验放在解析层：**不足补 `—`、超出截断**，
 * 用户永远看到五列。
 */
describe('最近会议：五列与列数校验', () => {
  it('命令名与五列表头固定，状态列右对齐由渲染层负责', () => {
    assert.equal(MEETING_HISTORY_COMMAND, '/assistant-meeting-history')
    assert.equal(MEETING_HISTORY.command, MEETING_HISTORY_COMMAND)
    assert.deepEqual(MEETING_HISTORY.columns.map(column => column.label), ['日期', '名称', '来源', '保留期', '状态'])
    assert.deepEqual(MEETING_HISTORY.columns.map(column => column.width), ['148px', undefined, '132px', '72px', '80px'])
  })

  it('五列正常解析', () => {
    const parsed = parseList('2026-01-02 | 周会 | 麦克风 | 30 天 | 已转写', MEETING_HISTORY)
    assert.equal(parsed.state, 'rows')
    assert.deepEqual(cells(parsed), [['2026-01-02', '周会', '麦克风', '30 天', '已转写']])
  })

  it('列数不足补 `—`，不让整行左移', () => {
    const parsed = parseList('2026-01-02 | 周会', MEETING_HISTORY)
    assert.deepEqual(cells(parsed), [['2026-01-02', '周会', '—', '—', '—']])
  })

  it('列数超出截断到五列（后端将来加列也撑不坏这张表）', () => {
    const parsed = parseList('2026-01-02 | 周会 | 麦克风 | 30 天 | 已转写 | 多出来的一列', MEETING_HISTORY)
    assert.equal(parsed.rows[0].cells.length, 5)
    assert.equal(parsed.rows[0].cells[4], '已转写')
  })

  it('后端实测的三行原文：日期带时分也照原样落第一列', () => {
    const text = [
      '2026-11-12 14:30 | 周会 | 麦克风+系统声 | 30 天 | 已转写',
      '2026-11-11 09:05 | 双人评审 | 仅麦克风 | 7 天 | 部分转写',
      '2026-11-09 16:00 | 旧版记录（没有完整性证据） | 麦克风+系统声 | 30 天 | 未转写',
    ].join('\n')
    const parsed = parseList(text, MEETING_HISTORY)
    assert.equal(parsed.state, 'rows')
    assert.equal(parsed.rows.length, 3)
    // 日期列是 `YYYY-MM-DD HH:mm`（与"今天"列表的 `HH:mm` 不同格式），必须整段落在第 1 列
    assert.equal(parsed.rows[0].cells[0], '2026-11-12 14:30')
    assert.equal(parsed.rows[0].cells[4], '已转写')
    // 状态列原样透传：将来若加第五态（如 `转写失败`），解析层不需要改
    assert.equal(parsed.rows[1].cells[4], '部分转写')
  })

  it('日期列 148px：`2026-11-12 14:30` 在 13px 下约 115px，132px 只剩 17px 余量会被省略号吃掉', () => {
    assert.equal(MEETING_HISTORY.columns[0].width, '148px')
  })

  it('状态配色：只有 `转写失败` 上色，其余与未知状态都落默认灰', () => {
    assert.equal(statusTone('转写失败'), '#c2410c')
    for (const value of ['已转写', '部分转写', '未转写', '状态未知', '将来才会有的新状态', '']) {
      assert.equal(statusTone(value), null, `「${value}」不该有专属配色`)
    }
    // 前后空白不该影响判断（服务端已 trim，这里兜一层）
    assert.equal(statusTone(' 转写失败 '), '#c2410c')
  })

  it('空与读不到是两句不同的话', () => {
    assert.equal(MEETING_HISTORY.empty, '还没有历史会议')
    assert.equal(MEETING_HISTORY.unavailable, '暂时读不到历史会议')
    assert.equal(parseList('还没有历史会议', MEETING_HISTORY).state, 'empty')
    assert.equal(parseList('暂时读不到历史会议', MEETING_HISTORY).state, 'unavailable')
  })
})

/**
 * 隐藏尾列（`trailing`）：后端在行末追加的"机器用"字段，如 `taskId`。
 *
 * 为什么它不是"待办的补丁"：会议历史将来要加"会议 id"、助理团要加"成员 id"，都是同一模式，
 * 所以能力放在列定义与解析层，用 `trailing` 声明、按位置吃。
 *
 * 三条边界：① 多出来的格子进 trailing，**不丢**；② 后端还没输出时是空数组，**不是错误**；
 * ③ 多于声明数量的尾列也照收（证明是"按位置吃"，不是"恰好第 6 格"）。
 */
describe('隐藏尾列 trailing', () => {
  it('6 列：可见 5 格照旧，第 6 格进 trailing（就是 taskId）', () => {
    const parsed = parseList('改讲解链路 | 高 | 会议 | 待你处理 | 2026-01-03 | task-42', LIST_TABS.todo)
    assert.equal(parsed.state, 'rows')
    assert.deepEqual(cells(parsed), [['改讲解链路', '高', '会议', '待你处理', '2026-01-03']])
    assert.deepEqual(parsed.rows[0].trailing, ['task-42'])
  })

  it('5 列（后端还没上）：trailing 是空数组，不报错、不补 `—`、不影响可见格', () => {
    const parsed = parseList('改讲解链路 | 高 | 会议 | 待你处理 | 2026-01-03', LIST_TABS.todo)
    assert.equal(parsed.state, 'rows')
    assert.deepEqual(cells(parsed), [['改讲解链路', '高', '会议', '待你处理', '2026-01-03']])
    assert.deepEqual(parsed.rows[0].trailing, [], '缺尾列是正常情况：后端产物没更新前一直会缺')
  })

  it('7 列：两格都进 trailing —— 证明按位置吃，不是"恰好第 6 格"', () => {
    const parsed = parseList('改讲解链路 | 高 | 会议 | 待你处理 | 2026-01-03 | task-42 | 额外一列', LIST_TABS.todo)
    assert.deepEqual(parsed.rows[0].trailing, ['task-42', '额外一列'])
    assert.equal(parsed.rows[0].cells.length, 5)
  })

  it('待办/会议/历史会议声明了 trailing（id 尾列）；其它表把多余格也照收（不是丢弃）', () => {
    assert.equal(LIST_TABS.todo.trailing, 1)
    assert.equal(LIST_TABS.meeting.trailing, 1, '会议行要按 id 改名/删除')
    assert.equal(MEETING_HISTORY.trailing, 1)
    for (const id of ['report', 'team'] as const) assert.equal(LIST_TABS[id].trailing, undefined, id)
    // 没声明 trailing 的表，多出来的一格同样进 trailing —— 解析规则统一，不按表分叉
    const parsed = parseList('小会 | 助理1 | 在岗 | 1200/8000 | 多出来', LIST_TABS.team)
    assert.equal(parsed.rows[0].cells.length, 4)
    assert.deepEqual(parsed.rows[0].trailing, ['多出来'])
  })

  it('旧 3 列回包没有尾列：trailing 空，且状态仍在第 4 列', () => {
    const parsed = parseList('改讲解链路 | 待你处理 | —', LIST_TABS.todo)
    assert.deepEqual(cells(parsed), [['改讲解链路', '—', '—', '待你处理', '—']])
    assert.deepEqual(parsed.rows[0].trailing, [])
  })

  it('每行都有 trailing 字段（结构恒存在），不是"有的行有、有的行没有"', () => {
    const parsed = parseList('a | b | c | d | e | id-1\nf | g | h | i | j', LIST_TABS.todo)
    assert.deepEqual(parsed.rows.map(row => row.trailing.length), [1, 0])
  })
})

/**
 * 改优先级的纯逻辑：拼命令、这一行能不能点、提交后回读算哪种结局。
 *
 * 这一组的前提是**提案 + 审批**：聊天侧提交只生成待确认的改动，本人在桌面确认后才生效。
 * 所以这里不含任何"乐观"逻辑——界面永远显示服务端的值，判断只看回读出来的状态。
 */
describe('改优先级：命令、可点判定、回读结局', () => {
  it('拼命令：taskId 在前、取值在后', () => {
    assert.equal(priorityCommand('task-42', 'high'), '/assistant-set-task-priority task-42 high')
    assert.equal(priorityCommand('  task-42 ', 'low'), '/assistant-set-task-priority task-42 low')
    // 非法输入返回 null（调用方据此不发命令、只提示），不拼半截参数
    assert.equal(priorityCommand('', 'high'), null)
    assert.equal(priorityCommand('task 42', 'high'), null, '带空白会被拆成两个参数')
    assert.equal(priorityCommand('task-42', 'urgent'), null, '只认三档')
  })

  it('取值 ↔ 显示：与服务端 describePriority 的中文一致', () => {
    assert.deepEqual(PRIORITY_CHOICES.map(choice => [choice.value, choice.label]), [
      ['high', '高'], ['normal', '中'], ['low', '低'],
    ])
    assert.equal(priorityLabel('high'), '高')
    assert.equal(priorityLabel('future-value'), 'future-value', '未知档原样返回，不猜')
  })

  it('可点判定：只有拿到 taskId 的行才给交互（后端没给 id 时整列自动只读）', () => {
    const withId = parseList('标题 | 高 | 会议 | 待办中 | — | task-1', LIST_TABS.todo).rows[0]
    assert.equal(rowTaskId(withId), 'task-1')
    const withoutId = parseList('标题 | 高 | 会议 | 待办中 | —', LIST_TABS.todo).rows[0]
    assert.equal(rowTaskId(withoutId), null, '5 列回包 → 没有 id → 不可点')
    const placeholder = parseList('标题 | 高 | 会议 | 待办中 | — | —', LIST_TABS.todo).rows[0]
    assert.equal(rowTaskId(placeholder), null, '`—` 是占位，不是 id')
    const spaced = parseList('标题 | 高 | 会议 | 待办中 | — | a b', LIST_TABS.todo).rows[0]
    assert.equal(rowTaskId(spaced), null, '含空白的 id 拼进命令会被拆开，宁可不给点')
  })

  it('回读三种结局：已生效 / 待确认 / 行已消失', () => {
    const applied = parseList('标题 | 高 | 会议 | 待办中 | — | task-1', LIST_TABS.todo).rows
    assert.equal(priorityOutcome(applied, 'task-1', 'high'), 'applied')

    const pending = parseList('标题 | 中 | 会议 | 待办中 | — | task-1', LIST_TABS.todo).rows
    assert.equal(priorityOutcome(pending, 'task-1', 'high'), 'pending', '值没变 = 提案还在路上')

    assert.equal(priorityOutcome(applied, 'task-999', 'high'), 'gone', '找不到这一行 = 行已消失')
    assert.equal(priorityOutcome([], 'task-1', 'high'), 'gone')
  })

  it('回读按 taskId 找行，不按行序（列表会按优先级重排）', () => {
    const rows = parseList([
      '别的任务 | 高 | 手动 | 待办中 | — | task-other',
      '目标任务 | 中 | 会议 | 待办中 | — | task-1',
    ].join('\n'), LIST_TABS.todo).rows
    // 第一行的值是「高」，但那是别的任务；目标行仍是「中」→ 待确认
    assert.equal(priorityOutcome(rows, 'task-1', 'high'), 'pending')
  })
})

/**
 * 标记的收口：每次拿到新列表都要与服务端现状对一遍。
 *
 * 没有这一步，用户去桌宠确认之后标记会**永远挂着**——列表已经变成新值，而"确认"这个动作
 * 不会经过前端，不会有任何提交回调来清标记。
 */
describe('待确认标记的收口', () => {
  const rowsOf = (...lines: string[]) => parseList(lines.join('\n'), LIST_TABS.todo).rows
  const pending = { 'task-1': 'high' }

  it('已经生效（列表里是提交的值）→ 清标记', () => {
    assert.deepEqual(reconcilePending(pending, rowsOf('标题 | 高 | 会议 | 待办中 | — | task-1')), {})
  })

  it('还没生效（列表里仍是旧值）→ 保留', () => {
    assert.deepEqual(reconcilePending(pending, rowsOf('标题 | 中 | 会议 | 待办中 | — | task-1')), pending)
  })

  it('那一行没了 → 清标记（否则永远等不到它消失）', () => {
    assert.deepEqual(reconcilePending(pending, rowsOf('别的 | 高 | 手动 | 待办中 | — | task-9')), {})
    assert.deepEqual(reconcilePending(pending, []), {})
  })

  it('没有待确认标记时原样返回同一个引用（不触发无意义重渲染）', () => {
    const empty: Record<string, string> = {}
    assert.equal(reconcilePending(empty, rowsOf('标题 | 高 | 会议 | 待办中 | — | task-1')), empty)
    const unchanged = { 'task-1': 'high' }
    const rows = rowsOf('标题 | 中 | 会议 | 待办中 | — | task-1')
    assert.equal(reconcilePending(unchanged, rows), unchanged)
  })

  it('多条标记各自判：一条生效、一条还在路上、一条行没了', () => {
    const mixed = { 'task-1': 'high', 'task-2': 'low', 'task-3': 'normal' }
    const rows = rowsOf(
      '甲 | 高 | 会议 | 待办中 | — | task-1',
      '乙 | 中 | 手动 | 待办中 | — | task-2',
    )
    assert.deepEqual(reconcilePending(mixed, rows), { 'task-2': 'low' })
  })
})

describe('会议行 id（rowMeetingId）', () => {
  it('尾列有 id 才给交互；缺 id / 占位 — / 带空格都只读', () => {
    const withId = parseList('09:30 | 周会 | 已转写 | m-1', LIST_TABS.meeting)
    assert.equal(rowMeetingId(withId.rows[0]), 'm-1')
    const noId = parseList('09:30 | 周会 | 已转写', LIST_TABS.meeting)
    assert.equal(rowMeetingId(noId.rows[0]), null)
    const placeholder = parseList('09:30 | 周会 | 已转写 | —', LIST_TABS.meeting)
    assert.equal(rowMeetingId(placeholder.rows[0]), null)
    const dirty = parseList('09:30 | 周会 | 已转写 | m 1', LIST_TABS.meeting)
    assert.equal(rowMeetingId(dirty.rows[0]), null)
  })
})
