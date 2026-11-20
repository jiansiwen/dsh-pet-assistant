/**
 * B1：把记忆召回接进主提示词注入。
 *
 * `personal_assistant_preferences` 的变量回调依赖宿主 ctx（agent 装配期才存在），
 * 直接测那个闭包既拿不到上下文也没法定点触发，所以逻辑被抽成纯函数
 * `renderPreferences` / `extractRecallTerms` / `userMessageText`，这里只测三件可确定的事：
 *
 * 1. 查询词抽取是确定性的（切分、去重、上限、过滤）；
 * 2. 四类失败情形（抛异常 / undefined / 空注入串 / 降级）都回退静态注入，且取值**永远是字符串**
 *    —— 宿主把「变量没有值」当装配错误直接炸，这是真机踩过的坑；
 * 3. 正常召回的结果原样透传，不做二次加工。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderMemorySection, type MemoryRecord } from '../src/memory.ts'
import { RECALL_EMPTY_INJECTION, type RecallBundle } from '../src/recall-index.ts'
import {
  RECALL_TERM_LIMIT,
  RECALL_TERM_MAX_CHARS,
  extractRecallTerms,
  registerAssistantTools,
  renderPreferences,
  userMessageText,
} from '../src/tools.ts'

const NOW = 1_757_000_000_000

const RECORD: MemoryRecord = {
  id: 'mem-1',
  kind: 'user_preference',
  scope: { kind: 'global', id: '' },
  topic: '日报',
  text: '日报用 Markdown 输出',
  sourceRefs: [],
  status: 'confirmed',
  sensitivity: 'normal',
  createdBy: 'user',
  confirmedBy: 'user',
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
  expiresAt: null,
  importBatch: null,
}

/** 第二条全局偏好：用来验证「无关轮次必须把多条长期规则都保住」。 */
const RECORD2: MemoryRecord = {
  ...RECORD,
  id: 'mem-2',
  topic: '沟通',
  text: '和我说话尽量短',
}

/**
 * 静态回退的抬头。这里**字面重抄一遍**而不是从实现里 import：
 * 抬头是给模型看的语义契约，措辞被人改了就必须有用例失败，不能跟着实现一起漂。
 */
const STATIC_HEADER = '以下是全局长期规则（本轮未检索到更相关的记忆）：'

/** 静态注入的期望文本 = 抬头 + 真源渲染结果（避免在用例里抄一份标签名）。 */
const STATIC_ONE = `${STATIC_HEADER}\n${renderMemorySection([RECORD], {})}`
const STATIC_TWO = `${STATIC_HEADER}\n${renderMemorySection([RECORD, RECORD2], {})}`
const STATIC_EMPTY = '（暂无已确认的记忆。用户表达长期偏好后会自动出现在这里。）'

/** 只实现被用到的那一个方法：PreferencesSource 只依赖 MemoryStore.injectable。 */
function memoriesOf(records: MemoryRecord[]) {
  return { injectable: () => records }
}

/**
 * 造一个召回结果。`injected` 的条数默认跟着 `injection` 走：有注入串就算 1 条，
 * 空串就算 0 条——上限判定用的是 `empty` 与 `injected.length`，两者必须自洽，
 * 否则用例会悄悄绕过真实语义。
 */
function bundleOf(
  injection: string,
  options: { degraded?: boolean; empty?: boolean; injectedCount?: number } = {},
): RecallBundle {
  const degraded = options.degraded ?? false
  const empty = options.empty ?? injection.trim() === ''
  const injectedCount = options.injectedCount ?? (empty ? 0 : 1)
  return {
    matched: [],
    injected: Array.from({ length: injectedCount }, () => ({ sourceKind: 'memory' }) as never),
    injection,
    matchLimit: 20,
    totalMatched: injectedCount,
    truncated: false,
    aliveChecks: 0,
    deadHitsFiltered: 0,
    empty,
    emptyReason: empty ? 'no-match' : null,
    trace: {
      matchExpr: '"日报"',
      rawMatchCount: 0,
      perChannel: { 'fts-index': injectedCount, rule: 0, 'time-window': 0, project: 0, 'artifact-pointer': 0 },
      budget: { maxItems: 20, maxChars: 4000, applied: false },
      reconcileDelta: 0,
      degraded,
    },
    filtered: { candidate: 0, conflicting: 0, expired: 0, outOfScope: 0, tombstoned: 0 },
    degraded,
    degradeReason: degraded ? 'FTS 检索失败：测试桩' : null,
    generatedAt: NOW,
  }
}

// ---------------------------------------------------------------------------
// 1. 查询词抽取
// ---------------------------------------------------------------------------

test('extractRecallTerms：空串与空白一律给空数组', () => {
  assert.deepEqual(extractRecallTerms(''), [])
  assert.deepEqual(extractRecallTerms('   \n\t '), [])
  // 宿主事件里 content 拿不到时是空串，不是 undefined；这里也不该崩。
  assert.deepEqual(extractRecallTerms(undefined as unknown as string), [])
})

test('extractRecallTerms：中英混排按词切段，单字被过滤', () => {
  // 「把」「的」「吧」都是单字段，没有区分度；中文连续段整体保留（bigram 在召回层做）。
  assert.deepEqual(
    extractRecallTerms('把 日报的格式改成 Markdown 吧'),
    ['日报的格式改成', 'markdown'],
  )
  // 「用」「存」是单字被丢，英文词小写保留。
  assert.deepEqual(extractRecallTerms('用 SQLite 存 记忆'), ['sqlite', '记忆'])
})

test('extractRecallTerms：中英文标点都是切分点', () => {
  assert.deepEqual(extractRecallTerms('日报、周报；月报。'), ['日报', '周报', '月报'])
  assert.deepEqual(extractRecallTerms('日报,Daily/WEEKLY'), ['日报', 'daily', 'weekly'])
  // 全角字母经 NFKC 归一后再小写，不会变成两个不同的词。
  assert.deepEqual(extractRecallTerms('Ｄａｉｌｙ'), ['daily'])
})

test('extractRecallTerms：去重保序', () => {
  assert.deepEqual(extractRecallTerms('日报 周报 日报 Daily daily'), ['日报', '周报', 'daily'])
})

test('extractRecallTerms：最多 8 个、单个不超过 20 字', () => {
  const many = ['一甲', '一乙', '一丙', '一丁', '一戊', '一己', '一庚', '一辛', '一壬', '一癸']
  assert.equal(extractRecallTerms(many.join(' ')).length, RECALL_TERM_LIMIT)

  const long = 'a'.repeat(40)
  const [term] = extractRecallTerms(long)
  assert.equal(term.length, RECALL_TERM_MAX_CHARS)

  const longCjk = '这是一段很长的中文连续段它必须被截断到上限以内'
  const [cjkTerm] = extractRecallTerms(longCjk)
  assert.equal(cjkTerm.length, RECALL_TERM_MAX_CHARS)
})

test('extractRecallTerms：纯单字与单字母给空数组', () => {
  assert.deepEqual(extractRecallTerms('我 的 a b 了'), [])
  assert.deepEqual(extractRecallTerms('x1 ok'), ['x1', 'ok'])
})

// ---------------------------------------------------------------------------
// 2. 回退路径：取值永远是字符串，且失败一律退回静态注入
// ---------------------------------------------------------------------------

test('renderPreferences：正常召回原样透传，不做二次加工', () => {
  const injection = '以下是与本轮请求相关的长期记忆（只含用户已确认内容，按相关度排序）：\n- [偏好] 日报用 Markdown 输出'
  const result = renderPreferences(
    { memories: memoriesOf([RECORD]), maxInjectedMemories: 40, recall: () => bundleOf(injection) },
    '日报用什么格式',
    NOW,
  )
  assert.equal(result, injection)
  // 静态注入里也有同一条记忆，这里刻意断言「召回优先」而不是两者拼接。
  assert.ok(!result.includes(STATIC_EMPTY))
})

test('renderPreferences：召回抛异常 → 静默退回静态注入', () => {
  const result = renderPreferences(
    {
      memories: memoriesOf([RECORD]),
      maxInjectedMemories: 40,
      recall: () => {
        throw new Error('FTS 炸了')
      },
    },
    '日报用什么格式',
    NOW,
  )
  assert.equal(result, STATIC_ONE)
})

test('renderPreferences：召回返回 undefined → 退回静态注入', () => {
  const result = renderPreferences(
    {
      memories: memoriesOf([RECORD]),
      maxInjectedMemories: 40,
      recall: (() => undefined) as unknown as () => RecallBundle,
    },
    '日报用什么格式',
    NOW,
  )
  assert.equal(result, STATIC_ONE)
})

test('renderPreferences：注入串是空串 → 退回静态注入（空串会让宿主报变量没有值）', () => {
  const result = renderPreferences(
    { memories: memoriesOf([RECORD]), maxInjectedMemories: 40, recall: () => bundleOf('') },
    '日报用什么格式',
    NOW,
  )
  assert.equal(result, STATIC_ONE)
})

test('renderPreferences：召回降级（degraded）→ 退回静态注入', () => {
  // recall-index 降级时给的是「未找到相关记忆」空态串；直接返回等于把静态兜底也关掉，
  // 所以这里按「召回不可用」处理，回退到与改造前一致的静态注入。
  const result = renderPreferences(
    {
      memories: memoriesOf([RECORD]),
      maxInjectedMemories: 40,
      recall: () => bundleOf(RECALL_EMPTY_INJECTION, { degraded: true }),
    },
    '日报用什么格式',
    NOW,
  )
  assert.equal(result, STATIC_ONE)
})

// ---------------------------------------------------------------------------
// 2b. 回归：召回「没命中」不等于「用户没有偏好」
//
// 全局偏好是长期规则，不依赖本轮关键词。改造前它们每轮都注入、每轮都生效，
// 所以「这一轮没命中关键词」绝不能把静态注入一起关掉——否则用户随口聊一句
// （「今天天气不错」）就会感觉助理把教过的东西忘了，比不做召回更糟。
// ---------------------------------------------------------------------------

test('renderPreferences：召回 empty（no-match）→ 回退静态注入，且不得出现「未找到相关记忆」空态串', () => {
  const result = renderPreferences(
    {
      memories: memoriesOf([RECORD, RECORD2]),
      maxInjectedMemories: 40,
      recall: () => bundleOf(RECALL_EMPTY_INJECTION, { empty: true, injectedCount: 0 }),
    },
    '今天天气不错',
    NOW,
  )
  assert.equal(result, STATIC_TWO)
  assert.ok(result.includes(RECORD.text))
  assert.ok(result.includes(RECORD2.text))
  assert.ok(!result.includes('未找到相关记忆'), '无关轮次不能把空态文案喂给模型')
})

test('renderPreferences：召回 empty（all-filtered）→ 同样回退静态注入', () => {
  const result = renderPreferences(
    {
      memories: memoriesOf([RECORD, RECORD2]),
      maxInjectedMemories: 40,
      recall: () => ({ ...bundleOf(RECALL_EMPTY_INJECTION, { empty: true }), emptyReason: 'all-filtered' }),
    },
    '今天天气不错',
    NOW,
  )
  assert.equal(result, STATIC_TWO)
})

test('renderPreferences：empty=false 但 injected 为空（防御性）→ 回退静态注入', () => {
  // 这个组合不该出现：上游说"有结果"却没有条目。真出现了说明状态自相矛盾，
  // 这时回退静态注入永远比返回一个可疑串安全。
  const result = renderPreferences(
    {
      memories: memoriesOf([RECORD, RECORD2]),
      maxInjectedMemories: 40,
      recall: () => bundleOf('看起来有内容但其实没有条目', { empty: false, injectedCount: 0 }),
    },
    '日报用什么格式',
    NOW,
  )
  assert.equal(result, STATIC_TWO)
})

test('renderPreferences：没有召回依赖 / 没有用户话语 → 静态注入且不调用召回', () => {
  let calls = 0
  const recall = () => {
    calls += 1
    return bundleOf('不该被用到')
  }
  // 宿主不支持 session/event：lastUserText 永远空，不能拿空查询词去打 FTS。
  assert.equal(renderPreferences({ memories: memoriesOf([RECORD]), maxInjectedMemories: 40, recall }, '', NOW), STATIC_ONE)
  assert.equal(calls, 0)
  // 依赖缺失时同理。
  assert.equal(renderPreferences({ memories: memoriesOf([RECORD]), maxInjectedMemories: 40 }, '日报用什么格式', NOW), STATIC_ONE)
  assert.equal(calls, 0)
})

test('renderPreferences：静态回退带「全局长期规则」抬头，且不出现「未找到」措辞', () => {
  // 召回命中时注入串自带「以下是与本轮请求相关的长期记忆」；回退路径没有抬头的话，
  // 模型容易把常驻规则当成"用户刚才提到了这个"。
  const result = renderPreferences(
    {
      memories: memoriesOf([RECORD, RECORD2]),
      maxInjectedMemories: 40,
      recall: () => bundleOf(RECALL_EMPTY_INJECTION, { empty: true, injectedCount: 0 }),
    },
    '今天天气不错',
    NOW,
  )
  assert.ok(result.startsWith(STATIC_HEADER), '静态回退必须以抬头开头')
  assert.ok(result.includes(RECORD.text) && result.includes(RECORD2.text))
  // 陈述句而非"没找到"：避免模型对用户复述"我没找到相关记忆"。
  assert.ok(!result.includes('未找到相关记忆'))
  // 召回命中时不得出现这个抬头（两种注入的语义必须分得开）。
  const hit = renderPreferences(
    { memories: memoriesOf([RECORD]), maxInjectedMemories: 40, recall: () => bundleOf('召回命中串') },
    '日报用什么格式',
    NOW,
  )
  assert.equal(hit, '召回命中串')
  assert.ok(!hit.includes(STATIC_HEADER))
})

test('renderPreferences：静态 0 条时返回与改造前逐字一致的空态文案，不加抬头', () => {
  const result = renderPreferences(
    {
      memories: memoriesOf([]),
      maxInjectedMemories: 40,
      recall: () => bundleOf(RECALL_EMPTY_INJECTION, { empty: true, injectedCount: 0 }),
    },
    '今天天气不错',
    NOW,
  )
  assert.equal(result, STATIC_EMPTY)
  assert.ok(!result.includes(STATIC_HEADER), '空列表不能带抬头：那会是一句没有指代对象的话')
})

test('renderPreferences：召回拿到的是抽出来的词，不是原句', () => {
  let seen: readonly string[] = []
  const text = '把 日报的格式改成 Markdown 吧'
  renderPreferences(
    {
      memories: memoriesOf([]),
      maxInjectedMemories: 40,
      recall: terms => {
        seen = [...terms]
        return bundleOf('召回内容')
      },
    },
    text,
    NOW,
  )
  assert.deepEqual(seen, extractRecallTerms(text))
})

test('renderPreferences：任何情形下都不抛异常、不给 undefined，取值永远是非空字符串', () => {
  const cases: Array<{ name: string; source: Parameters<typeof renderPreferences>[0] }> = [
    { name: '正常召回', source: { memories: memoriesOf([RECORD]), maxInjectedMemories: 40, recall: () => bundleOf('召回内容') } },
    { name: '召回抛错', source: { memories: memoriesOf([RECORD]), maxInjectedMemories: 40, recall: () => { throw new Error('boom') } } },
    { name: '召回 undefined', source: { memories: memoriesOf([RECORD]), maxInjectedMemories: 40, recall: (() => undefined) as unknown as () => RecallBundle } },
    { name: '空注入串', source: { memories: memoriesOf([RECORD]), maxInjectedMemories: 40, recall: () => bundleOf('') } },
    { name: '降级', source: { memories: memoriesOf([RECORD]), maxInjectedMemories: 40, recall: () => bundleOf(RECALL_EMPTY_INJECTION, { degraded: true }) } },
    { name: '召回没命中', source: { memories: memoriesOf([RECORD]), maxInjectedMemories: 40, recall: () => bundleOf(RECALL_EMPTY_INJECTION, { empty: true, injectedCount: 0 }) } },
    { name: '没命中且无静态记忆', source: { memories: memoriesOf([]), maxInjectedMemories: 40, recall: () => bundleOf(RECALL_EMPTY_INJECTION, { empty: true, injectedCount: 0 }) } },
    { name: '无依赖', source: { memories: memoriesOf([RECORD]), maxInjectedMemories: 40 } },
    { name: '无记忆', source: { memories: memoriesOf([]), maxInjectedMemories: 40 } },
    {
      name: '记忆库抛错',
      source: {
        memories: { injectable: () => { throw new Error('库挂了') } },
        maxInjectedMemories: 40,
        recall: () => {
          throw new Error('一起挂')
        },
      },
    },
  ]
  for (const item of cases) {
    const result = renderPreferences(item.source, '日报用什么格式', NOW)
    assert.equal(typeof result, 'string', `${item.name}：必须是字符串`)
    assert.notEqual(result.trim(), '', `${item.name}：不能是空串（宿主会报变量没有值）`)
  }
})

test('renderPreferences：没有记忆时的兜底文案与改造前逐字一致', () => {
  assert.equal(renderPreferences({ memories: memoriesOf([]), maxInjectedMemories: 40 }, '', NOW), STATIC_EMPTY)
  assert.equal(
    renderPreferences({ memories: memoriesOf([]), maxInjectedMemories: 40, recall: () => null as unknown as RecallBundle }, '日报', NOW),
    STATIC_EMPTY,
  )
  // 上限为 0 时不注入任何记忆，但仍是字符串。
  assert.equal(renderPreferences({ memories: memoriesOf([RECORD]), maxInjectedMemories: 0 }, '', NOW), STATIC_EMPTY)
})

// ---------------------------------------------------------------------------
// 3. 用户话语的载荷解析（形状以宿主类型为准）
// ---------------------------------------------------------------------------

test('userMessageText：按真实 UserMessage 形状取 text 块', () => {
  // @deepseek-ai/dsh-session: `'user/message': UserMessage`，即 data 就是消息本身，
  // content 是 ContentBlock[]，可见文本只在 type === 'text' 的块里。
  const event = {
    type: 'user/message',
    seq: 7,
    data: {
      id: 'msg-1',
      role: 'user',
      content: [
        { type: 'text', text: '日报' },
        { type: 'image', source: { kind: 'inline', mediaType: 'image/png', data: 'AA==' } },
        { type: 'text', text: '用什么格式' },
      ],
      source: { kind: 'user' },
    },
  }
  assert.equal(userMessageText(event), '日报用什么格式')
})

test('userMessageText：注入的上下文不是用户话语', () => {
  const injected = {
    type: 'user/message',
    data: {
      id: 'msg-2',
      role: 'user',
      content: [{ type: 'text', text: '当前时间：2025-08-01 09:00' }],
      source: { kind: 'time-context', form: 'snapshot', sections: [] },
    },
  }
  assert.equal(userMessageText(injected), '')
})

test('userMessageText：非 user/message 与畸形载荷一律空串', () => {
  assert.equal(userMessageText(null), '')
  assert.equal(userMessageText(undefined), '')
  assert.equal(userMessageText({ type: 'assistant/message', data: { content: [{ type: 'text', text: '你好' }] } }), '')
  assert.equal(userMessageText({ type: 'user/message', data: null }), '')
  assert.equal(userMessageText({ type: 'user/message', data: { content: '不是数组也不该崩', source: { kind: 'user' } } }), '不是数组也不该崩')
  // source 缺失时按旧宿主当真人输入处理（与 session-mirror.ts 同一口径）。
  assert.equal(userMessageText({ type: 'user/message', data: { content: [{ type: 'text', text: '在吗' }] } }), '在吗')
})

// ---------------------------------------------------------------------------
// 4. 装配接线：session/event 真的把用户话语喂给了召回
//
// 这一段是纯函数测不到的那一小截：宿主 ctx 上的订阅、事件解析、变量取值串起来之后
// 是否真的按"这一轮用户说的话"召回。用最小假宿主足够——registerAssistantTools 只用到
// tools.register 与 systemPrompt.section/variable，另外我们额外提供 on。
// ---------------------------------------------------------------------------

function fakeHost() {
  const variables = new Map<string, () => string | undefined>()
  const listeners: Array<(session: unknown, event: unknown) => void> = []
  const host = {
    tools: { register: () => () => {} },
    systemPrompt: {
      section: () => () => {},
      variable: (name: string, provider: () => string | undefined) => {
        variables.set(name, provider)
        return () => {}
      },
    },
    on: (event: string, listener: (session: unknown, event: unknown) => void) => {
      if (event === 'session/event') listeners.push(listener)
      return () => {}
    },
  }
  return { host, variables, listeners }
}

/** 只用到 modeDescription：其余方法都在工具 execute 里，注册期不会碰。 */
const TRACKER_STUB = { modeDescription: () => '个人助理模式' } as never

function registerForTest(recallTerms: string[][]) {
  const { host, variables, listeners } = fakeHost()
  registerAssistantTools(host as never, TRACKER_STUB, {
    reportDir: '/tmp',
    bridge: { submitAssistant: () => ({ proposalId: 'p1' }) } as never,
    memories: memoriesOf([RECORD]) as never,
    reports: {} as never,
    maxInjectedMemories: 40,
    captureBlockedReason: () => null,
    legacyCopiesRetained: false,
    enableTeamMode: () => ({ toolsRegistered: false }),
    disableTeamMode: async () => ({ ok: true as const }),
    recall: terms => {
      recallTerms.push([...terms])
      return bundleOf('召回内容')
    },
  })
  return { variables, listeners }
}

test('装配接线：真人话语进入召回，注入上下文不算，变量永远有值', () => {
  const recalled: string[][] = []
  const { variables, listeners } = registerForTest(recalled)
  const preferences = variables.get('personal_assistant_preferences')
  assert.ok(preferences, 'personal_assistant_preferences 必须注册（变量名不能改）')

  // 装配前还没人说话：只能给静态注入，且不能拿空查询词去打 FTS。
  assert.equal(preferences(), STATIC_ONE)
  assert.equal(recalled.length, 0)

  for (const listener of listeners) {
    // 运行时注入的时间块不是用户话语，不能当查询词。
    listener('s1', {
      type: 'user/message',
      data: { id: 'm0', role: 'user', content: [{ type: 'text', text: '当前时间：2025-08-01' }], source: { kind: 'time-context' } },
    })
  }
  assert.equal(preferences(), STATIC_ONE)
  assert.equal(recalled.length, 0)

  for (const listener of listeners) {
    listener('s1', {
      type: 'user/message',
      data: { id: 'm1', role: 'user', content: [{ type: 'text', text: '日报用什么格式' }], source: { kind: 'user' } },
    })
  }
  assert.equal(preferences(), '召回内容')
  assert.deepEqual(recalled.at(-1), extractRecallTerms('日报用什么格式'))
})

test('装配接线：宿主没有 ctx.on 时静默退化，不抛异常', () => {
  const variables = new Map<string, () => string | undefined>()
  registerAssistantTools(
    {
      tools: { register: () => () => {} },
      systemPrompt: {
        section: () => () => {},
        variable: (name: string, provider: () => string | undefined) => {
          variables.set(name, provider)
          return () => {}
        },
      },
    } as never,
    TRACKER_STUB,
    {
      reportDir: '/tmp',
      bridge: {} as never,
      memories: memoriesOf([RECORD]) as never,
      reports: {} as never,
      maxInjectedMemories: 40,
      captureBlockedReason: () => null,
      legacyCopiesRetained: false,
      enableTeamMode: () => ({ toolsRegistered: false }),
      disableTeamMode: async () => ({ ok: true as const }),
    },
  )
  assert.equal(variables.get('personal_assistant_preferences')!(), STATIC_ONE)
})

