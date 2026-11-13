/**
 * M2：近期工作上下文注入。
 *
 * 变量回调依赖宿主 ctx（装配期才存在），测不了闭包；逻辑被抽成纯函数
 * `buildWorkContext` / `selectWorkContext` / `renderWorkContext`，这里测四件事：
 *
 * 1. 时间窗与过滤（窗外、evidence_removed、动作为空都不进）；
 * 2. 排序与截断是确定性的（updatedAt 倒序 → start 倒序 → id 升序）；
 * 3. 渲染格式逐字可控，且**只带指针**（不泄漏 summary / sources / 讨论主题）；
 * 4. 装配层两段拼接不会产出空串，也不会留连续空行。
 *
 * 时间断言一律用固定时间戳 + 本机本地时区换算，不写死某个时区：
 * 实现契约是"本地时区 HH:mm"，写死时区会让用例在别的机器上凭空调红。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildWorkContext,
  selectWorkContext,
  WORK_CONTEXT_HEADER,
  WORK_CONTEXT_LIMIT,
  WORK_CONTEXT_WINDOW_MS,
  type WorkContextItem,
} from '../src/work-context.ts'
import { joinSections, renderPreferences, renderWorkContext, type PreferencesSource } from '../src/tools.ts'

/** 固定"现在"：2025-11-12T10:00:00Z。所有时间窗用例都以它为基准。 */
const NOW = Date.UTC(2025, 10, 12, 10, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * 抬头的期望值。这里**字面重抄**而不是只从实现 import：抬头是给模型看的语义契约，
 * "只是背景，不是本轮任务"这句话被删掉或被改软，必须有用例失败。
 */
const EXPECTED_HEADER = '以下是最近 24 小时的工作事项（只是背景，不是本轮任务）：'

/** 与实现同口径的本地时间戳渲染，用来做逐字比对（不依赖机器时区）。 */
function expectedStamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function item(overrides: Partial<WorkContextItem> & { id: string }): WorkContextItem {
  return {
    project: 'dsh-pet',
    start: NOW - 30 * MINUTE,
    end: NOW - 20 * MINUTE,
    action: '修改输入队列',
    outcome: '队列用例全过',
    status: 'user_confirmed',
    updatedAt: NOW - 10 * MINUTE,
    ...overrides,
  }
}

const days = (count: number): number => count * 24 * HOUR

// ---------------------------------------------------------------------------
// 1. 空输入
// ---------------------------------------------------------------------------

test('buildWorkContext：没有事项就返回空串（调用方据此不追加段落）', () => {
  assert.equal(buildWorkContext([], { now: NOW }), '')
  // 计数上限为 0 时同样是空串，不是"抬头 + 空行"。
  assert.equal(buildWorkContext([item({ id: 'w1' })], { now: NOW, limit: 0 }), '')
  // 防御：上游给 undefined（未装配／桩不完整）不能崩。
  assert.equal(buildWorkContext(undefined as unknown as WorkContextItem[], { now: NOW }), '')
})

test('selectWorkContext：空输入给空数组，且不改动入参', () => {
  assert.deepEqual(selectWorkContext([], { now: NOW }), [])
  const input = [item({ id: 'w-a', updatedAt: NOW - 5 * MINUTE }), item({ id: 'w-b', updatedAt: NOW - 1 * MINUTE })]
  const snapshot = input.map(entry => entry.id)
  selectWorkContext(input, { now: NOW })
  // 排序必须发生在副本上：入参顺序被就地打乱会让别的调用方拿到意外结果。
  assert.deepEqual(input.map(entry => entry.id), snapshot)
})

// ---------------------------------------------------------------------------
// 2. 渲染格式（逐字）
// ---------------------------------------------------------------------------

test('buildWorkContext：抬头逐字一致', () => {
  assert.equal(WORK_CONTEXT_HEADER, EXPECTED_HEADER)
  assert.ok(buildWorkContext([item({ id: 'w1' })], { now: NOW }).startsWith(`${EXPECTED_HEADER}\n`))
})

test('buildWorkContext：三条正常事项逐字符合约定格式', () => {
  const first = NOW - 50 * MINUTE
  const second = NOW - 40 * MINUTE
  const third = NOW - 30 * MINUTE
  const items = [
    item({ id: 'w1', project: 'dsh-pet', action: '修改输入队列', outcome: '队列用例全过', status: 'user_confirmed', start: first, updatedAt: NOW - 1 * MINUTE }),
    item({ id: 'w2', project: null, action: '排查 WPS 翻页', outcome: '', status: 'inferred', start: second, updatedAt: NOW - 2 * MINUTE }),
    item({ id: 'w3', project: 'dsh-personal-assistant', action: '补 M2 工作上下文', outcome: 'tsc 通过', status: 'direct', start: third, updatedAt: NOW - 3 * MINUTE }),
  ]
  const expected = [
    EXPECTED_HEADER,
    `- [已确认] 项目：dsh-pet · 修改输入队列 → 队列用例全过（${expectedStamp(first)}）`,
    `- [推断] 无项目 · 排查 WPS 翻页 → （无成果记录）（${expectedStamp(second)}）`,
    `- [直接证据] 项目：dsh-personal-assistant · 补 M2 工作上下文 → tsc 通过（${expectedStamp(third)}）`,
  ].join('\n')
  assert.equal(buildWorkContext(items, { now: NOW }), expected)
})

test('buildWorkContext：一条一行，动作里的换行被压平', () => {
  const text = buildWorkContext([item({ id: 'w1', action: '改队列\n\n然后跑用例', outcome: '全过' })], { now: NOW })
  const lines = text.split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[1], /- \[已确认\] 项目：dsh-pet · 改队列 然后跑用例 → 全过/)
})

test('buildWorkContext：只带指针，不泄漏 summary / sources / 讨论主题', () => {
  // 真实 WorkItem 上还有 summary、sources、discussionTopic。它们都不该出现在提示词里：
  // summary 是模型自写的概括，sources 是一串 ref，正文一多就把当前任务的材料挤掉。
  const withExtras = {
    ...item({ id: 'w1' }),
    summary: '这是一段很长的概括正文不该出现',
    discussionTopic: '讨论主题也不该出现',
    sources: [{ kind: 'chat_text', ref: 'chat-1', summary: '聊天片段也不该出现' }],
  } as unknown as WorkContextItem
  const text = buildWorkContext([withExtras], { now: NOW })
  assert.ok(!text.includes('这是一段很长的概括正文'))
  assert.ok(!text.includes('讨论主题'))
  assert.ok(!text.includes('chat-1'))
  assert.ok(!text.includes('聊天片段'))
})

// ---------------------------------------------------------------------------
// 3. 排序与截断
// ---------------------------------------------------------------------------

test('selectWorkContext：按 updatedAt 倒序，而不是按 start 倒序', () => {
  // 关键用例：A 开始得更早但更新得更晚，它才是"刚才那个"，必须排第一。
  const items = [
    item({ id: 'a-early-start-late-update', start: NOW - 6 * HOUR, updatedAt: NOW - 1 * MINUTE }),
    item({ id: 'b-late-start-early-update', start: NOW - 10 * MINUTE, updatedAt: NOW - 3 * HOUR }),
  ]
  assert.deepEqual(
    selectWorkContext(items, { now: NOW }).map(entry => entry.id),
    ['a-early-start-late-update', 'b-late-start-early-update'],
  )
})

test('selectWorkContext：同时刻 updatedAt 用 start 倒序，再同时刻用 id 升序', () => {
  const same = NOW - 5 * MINUTE
  const items = [
    item({ id: 'z', start: same, updatedAt: same }),
    item({ id: 'a', start: same, updatedAt: same }),
    item({ id: 'm', start: same + MINUTE, updatedAt: same }),
  ]
  // start 倒序：m（更晚）在前；a/z 同 start 时按 id 升序。
  assert.deepEqual(selectWorkContext(items, { now: NOW, limit: 5 }).map(entry => entry.id), ['m', 'a', 'z'])
})

test('buildWorkContext：默认最多 3 条', () => {
  assert.equal(WORK_CONTEXT_LIMIT, 3)
  const items = Array.from({ length: 5 }, (_, index) => item({
    id: `w-${index}`,
    start: NOW - (index + 1) * MINUTE,
    updatedAt: NOW - (index + 1) * MINUTE,
  }))
  const lines = buildWorkContext(items, { now: NOW }).split('\n')
  assert.equal(lines.length, 4)
  // 截断留下的是最新的三条（updatedAt 最大），不是最早的三条。
  assert.deepEqual(selectWorkContext(items, { now: NOW }).map(entry => entry.id), ['w-0', 'w-1', 'w-2'])
})

test('selectWorkContext：limit 可调，超限只留最新的几条', () => {
  const items = Array.from({ length: 5 }, (_, index) => item({
    id: `w-${index}`,
    start: NOW - (index + 1) * MINUTE,
    updatedAt: NOW - (index + 1) * MINUTE,
  }))
  assert.deepEqual(selectWorkContext(items, { now: NOW, limit: 2 }).map(entry => entry.id), ['w-0', 'w-1'])
})

// ---------------------------------------------------------------------------
// 4. 过滤
// ---------------------------------------------------------------------------

test('selectWorkContext：开始时间落在窗外的被排除（过旧、未来、刚好边界）', () => {
  const items = [
    item({ id: 'old', start: NOW - days(1) - MINUTE, updatedAt: NOW }),
    item({ id: 'edge-old', start: NOW - days(1), updatedAt: NOW }),
    item({ id: 'inside', start: NOW - HOUR, updatedAt: NOW }),
    item({ id: 'edge-now', start: NOW, updatedAt: NOW }),
    item({ id: 'future', start: NOW + MINUTE, updatedAt: NOW }),
  ]
  // 两端都闭：正好 24 小时前与正好此刻都算"最近"，超出 1ms 就不算。
  // 三条的 updatedAt 相同，所以这里顺带验证了第二级排序（start 倒序）。
  assert.deepEqual(
    selectWorkContext(items, { now: NOW, limit: 10 }).map(entry => entry.id),
    ['edge-now', 'inside', 'edge-old'],
  )
})

test('selectWorkContext：窗口宽度可调', () => {
  // 放宽：30 小时前的事项默认被 24h 窗丢掉，放到 48h 窗里就进来。
  const old = [item({ id: 'w-30h', start: NOW - 30 * HOUR, updatedAt: NOW })]
  assert.deepEqual(selectWorkContext(old, { now: NOW }), [])
  assert.deepEqual(selectWorkContext(old, { now: NOW, windowMs: 48 * HOUR }).map(entry => entry.id), ['w-30h'])
  // 收窄：2 小时前的事项在默认窗内，1 小时窗里就不该再出现。
  const recent = [item({ id: 'w-2h', start: NOW - 2 * HOUR, updatedAt: NOW })]
  assert.deepEqual(selectWorkContext(recent, { now: NOW }).map(entry => entry.id), ['w-2h'])
  assert.deepEqual(selectWorkContext(recent, { now: NOW, windowMs: HOUR }), [])
})

test('selectWorkContext：evidence_removed 被排除', () => {
  // 来源删光的事项已经没有依据；拿它当"今天干了啥"的答案，说不出出处又听起来很确定。
  const items = [
    item({ id: 'gone', status: 'evidence_removed', updatedAt: NOW }),
    item({ id: 'kept', status: 'inferred', updatedAt: NOW - MINUTE }),
  ]
  assert.deepEqual(selectWorkContext(items, { now: NOW }).map(entry => entry.id), ['kept'])
  assert.equal(buildWorkContext([items[0]], { now: NOW }), '')
  // 全部被排除时是空串，不是"抬头 + 空行"。
  assert.equal(buildWorkContext(items.map(entry => ({ ...entry, status: 'evidence_removed' })), { now: NOW }), '')
})

test('selectWorkContext：动作为空的被排除（没有指针就只是噪音）', () => {
  const items = [
    item({ id: 'blank', action: '' }),
    item({ id: 'spaces', action: '  \n\t ' }),
    item({ id: 'ok', action: '有动作' }),
  ]
  assert.deepEqual(selectWorkContext(items, { now: NOW }).map(entry => entry.id), ['ok'])
})

test('selectWorkContext：开始时间不是有限数的被排除', () => {
  const items = [item({ id: 'nan', start: Number.NaN }), item({ id: 'ok', start: NOW - MINUTE })]
  assert.deepEqual(selectWorkContext(items, { now: NOW }).map(entry => entry.id), ['ok'])
})

// ---------------------------------------------------------------------------
// 5. 字段兜底与状态映射
// ---------------------------------------------------------------------------

test('buildWorkContext：project 为 null 或空白写「无项目」', () => {
  const nullProject = buildWorkContext([item({ id: 'w1', project: null })], { now: NOW })
  assert.match(nullProject, /\n- \[已确认\] 无项目 · 修改输入队列/)
  const blankProject = buildWorkContext([item({ id: 'w1', project: '   ' })], { now: NOW })
  assert.match(blankProject, /\n- \[已确认\] 无项目 · 修改输入队列/)
  // 有项目时带「项目：」前缀，和无项目形态可区分。
  const withProject = buildWorkContext([item({ id: 'w1', project: 'dsh-pet' })], { now: NOW })
  assert.match(withProject, /\n- \[已确认\] 项目：dsh-pet · /)
})

test('buildWorkContext：outcome 为空写「（无成果记录）」', () => {
  const text = buildWorkContext([item({ id: 'w1', outcome: '' })], { now: NOW })
  assert.match(text, /→ （无成果记录）（\d{2}-\d{2} \d{2}:\d{2}）$/)
  // 只有空白同样算空。
  assert.match(buildWorkContext([item({ id: 'w1', outcome: ' \n ' })], { now: NOW }), /→ （无成果记录）/)
})

test('buildWorkContext：状态映射成中文，未知状态原样保留', () => {
  const label = (status: string): string =>
    buildWorkContext([item({ id: 'w1', status })], { now: NOW }).split('\n')[1]
  assert.match(label('user_confirmed'), /^- \[已确认\] /)
  // 早期契约里的名字仍然认，避免旧库渲染成英文。
  assert.match(label('confirmed'), /^- \[已确认\] /)
  assert.match(label('direct'), /^- \[直接证据\] /)
  assert.match(label('inferred'), /^- \[推断\] /)
  // 未知状态不许静默变成空方括号或丢掉状态。
  assert.match(label('weird'), /^- \[weird\] /)
})

test('buildWorkContext：时间是本地时区的 MM-DD HH:mm', () => {
  const start = NOW - 37 * MINUTE
  const text = buildWorkContext([item({ id: 'w1', start })], { now: NOW })
  // 形状断言：与机器时区无关。
  assert.match(text, /（\d{2}-\d{2} \d{2}:\d{2}）$/)
  // 语义断言：月日时分来自 start 的本地字段（不是 UTC、不是 updatedAt、不是 end）。
  const date = new Date(start)
  const pad = (value: number): string => String(value).padStart(2, '0')
  assert.ok(text.endsWith(`（${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}）`))
})

// ---------------------------------------------------------------------------
// 6. 装配层：joinSections / renderWorkContext
// ---------------------------------------------------------------------------

test('joinSections：空段被丢掉，不产生连续空行', () => {
  assert.equal(joinSections('a', ''), 'a')
  assert.equal(joinSections('', ''), '')
  assert.equal(joinSections('a', undefined, '  \n ', null, 'b'), 'a\nb')
  assert.equal(joinSections(undefined, null), '')
  assert.equal(joinSections('a'), 'a')
})

test('renderWorkContext：未装配 workItems 时返回空串', () => {
  const source = { memories: { injectable: () => [] }, maxInjectedMemories: 0 } as unknown as PreferencesSource
  assert.equal(renderWorkContext(source, NOW), '')
})

test('renderWorkContext：按 24 小时窗取数，上界多留 1ms 兜住"正好此刻"', () => {
  const calls: Array<[number, number]> = []
  const source = {
    workItems: {
      listInRange: (from: number, to: number) => {
        calls.push([from, to])
        return []
      },
    },
  } as unknown as PreferencesSource
  assert.equal(renderWorkContext(source, NOW), '')
  assert.deepEqual(calls, [[NOW - WORK_CONTEXT_WINDOW_MS, NOW + 1]])
})

test('renderWorkContext：取数抛错时返回空串，绝不把提示词炸掉', () => {
  const source = {
    workItems: {
      listInRange: () => {
        throw new Error('库挂了')
      },
    },
  } as unknown as PreferencesSource
  assert.equal(renderWorkContext(source, NOW), '')
})

test('renderWorkContext：有事项时渲染出指针', () => {
  const start = NOW - 20 * MINUTE
  const source = {
    workItems: { listInRange: () => [item({ id: 'w1', action: '补 M2', outcome: 'tsc 通过', start })] },
  } as unknown as PreferencesSource
  assert.equal(
    renderWorkContext(source, NOW),
    `${EXPECTED_HEADER}\n- [已确认] 项目：dsh-pet · 补 M2 → tsc 通过（${expectedStamp(start)}）`,
  )
})

test('装配：两段拼接后永远非空；没有工作事项时与 M1 输出逐字一致', () => {
  const base = { memories: { injectable: () => [] }, maxInjectedMemories: 3 } as unknown as PreferencesSource
  const preferencesOnly = renderPreferences(base, '', NOW)
  // 宿主把"变量没有值"当装配错误，所以拼接结果不能因为工作上下文为空就变空串。
  assert.equal(joinSections(preferencesOnly, renderWorkContext(base, NOW)), preferencesOnly)
  assert.notEqual(preferencesOnly.trim(), '')

  const withWork = {
    ...base,
    workItems: { listInRange: () => [item({ id: 'w1', action: '补 M2' })] },
  } as unknown as PreferencesSource
  const merged = joinSections(renderPreferences(withWork, '', NOW), renderWorkContext(withWork, NOW))
  // 顺序是"规则在前、背景在后"，且两段都在。
  assert.ok(merged.startsWith(preferencesOnly))
  assert.ok(merged.includes(EXPECTED_HEADER))
  // 拼接处只有一个换行，不留连续空行。
  assert.ok(!merged.includes('\n\n'))
})
