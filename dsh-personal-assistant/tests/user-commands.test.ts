import assert from 'node:assert/strict'
import test from 'node:test'
import { registerUserCommands } from '../src/index.ts'

interface Definition {
  name: string
  description: string
  handler: (invocation: { agent?: unknown; rawInput?: string }) => Promise<{ kind: string; text: string }>
}

/**
 * 已注册命令的唯一真源。
 *
 * 以前这份清单在两条用例里各抄一遍，加一条命令就要改两处 —— 漏改一次就是
 * "实现已经注册、断言还停在旧表"的假红（外部同事已经替我踩过一次）。
 * 现在只有这里一处：加命令就加一行。
 */
const EXPECTED_COMMANDS = [
  // 字母序排列（只是可读性）。比较时两边都 sort 过，所以这里怎么排都不影响断言 ——
  // 别再为了"对齐注册顺序"去调这个数组。
  'assistant-mail-config',
  'assistant-meeting-history',
  'assistant-meeting-list',
  'assistant-meeting-set',
  'assistant-meeting-today',
  'assistant-off',
  'assistant-on',
  'assistant-pet-config',
  'assistant-pet-set',
  'assistant-report-list',
  'assistant-set-option',
  'assistant-skill-set',
  'assistant-skills',
  'assistant-set-task-priority',
  'assistant-settings-summary',
  'assistant-state',
  'assistant-task-set',
  'assistant-today-summary',
  'assistant-todo-count',
  'assistant-todo-list',
  'assistant-team-list',
  'assistant-wecom-config',
  // 一键入口与工作台入口
  'bind-pet',
  'open-workbench',
  'summon-pet',
] as const

interface Overrides {
  /** 桌宠在不在；true 时 requestDesktopCommand 正常回包，false 时按超时/断开抛错。 */
  petOnline?: boolean
  /** `meeting.count` 的回包；'timeout' 表示桌面命令超时。 */
  meetingCount?: number | 'timeout'
  /** `meeting.list` 的回包；'timeout' 表示超时。 */
  meetingList?: Array<{ startedAt: number; name: string; state: string }> | 'timeout'
  /** `settings.summary` 的回包；'timeout' 表示超时。 */
  settingsSummary?: Record<string, unknown> | 'timeout'
  /** `meeting.history` 的回包；'timeout' 表示超时。 */
  meetingHistory?: Array<Record<string, unknown>> | 'timeout'
  /** 任务运行时替身：改优先级命令要用它读快照 + 提交提案。 */
  tasks?: { request(method: string, path: string, body: unknown, subject: string): Promise<{ status: number; body: unknown }> }
  /** `settings.set` 的回包：'ok' 表示 applied，'error:<原因>' 表示桌宠拒绝，'timeout' 表示超时。 */
  settingsSet?: 'ok' | `error:${string}` | 'timeout'
  /** 会议改删 / 提醒间隔桌面命令的回包。 */
  meetingSet?: 'ok' | `error:${string}` | 'timeout'
  taskInterval?: 'ok' | `error:${string}` | 'timeout'
  /** `pet.config.summary` 的回包；'timeout' 表示桌宠没在跑。 */
  petConfig?: Record<string, unknown> | 'timeout'
  /** `pet.config.set` 的回包：'ok' 表示 applied，'error:<原因>' 表示拒绝，'timeout' 表示超时。 */
  petSet?: 'ok' | `error:${string}` | 'timeout'
  /** 三张本地列表的数据源；给 null 表示该源读不到。 */
  lists?: {
    todos?: () => Array<{ goal: string; status: string; deadlineAt: number | null }> | null
    reports?: () => Array<{ date: string; state: string; summary: string }> | null
    members?: () => Array<{ name: string; role: string; enabled: boolean; quota: string }> | null
  }
  summary?: () => {
    openTodos: number | null; awaitingUser: number | null; meetingsToday: number | null
    activeMs: number | null; topSubject: string | null
  }
  bind?: () => Promise<{ port: number }>
  launchPet?: () => boolean
  teamEnabled?: boolean
  capturing?: boolean
  scope?: boolean
  blocked?: string | null
  start?: () => Promise<void>
  stop?: () => Promise<void>
}

function harness(overrides: Overrides = {}) {
  const definitions: Definition[] = []
  const events: string[] = []
  const ctx = {
    get: (name: string) => name === 'commands'
      ? { register: (definition: Definition) => { definitions.push(definition); return () => {} } }
      : undefined,
    effect: (run: () => () => void) => run(),
  }
  const desktop: Array<{ command: string; payload: unknown }> = []
  const bridge = {
    teamEnabled: overrides.teamEnabled ?? false,
    bind: overrides.bind ?? (async () => { events.push('bind'); return { port: 4567 } }),
    launchPet: overrides.launchPet ?? (() => { events.push('launch'); return true }),
    requestDesktopCommand: async (command: string, payload: unknown) => {
      events.push(`desktop:${command}`)
      if (overrides.petOnline === false) throw new Error('桌面命令超时')
      desktop.push({ command, payload })
      if (command === 'meeting.count') {
        if (overrides.meetingCount === 'timeout') throw new Error('桌面命令超时')
        return { count: overrides.meetingCount ?? 0 }
      }
      if (command === 'meeting.list') {
        if (overrides.meetingList === 'timeout') throw new Error('桌面命令超时')
        return { meetings: overrides.meetingList ?? [] }
      }
      if (command === 'meeting.history') {
        if (overrides.meetingHistory === 'timeout') throw new Error('桌面命令超时')
        return { meetings: overrides.meetingHistory ?? [] }
      }
      if (command === 'settings.set') {
        const mode = overrides.settingsSet ?? 'ok'
        if (mode === 'timeout') throw new Error('桌面命令超时')
        if (mode.startsWith('error:')) return { applied: false, error: mode.slice('error:'.length) }
        return { applied: true }
      }
      if (command === 'settings.summary') {
        if (overrides.settingsSummary === 'timeout') throw new Error('桌面命令超时')
        return overrides.settingsSummary ?? {}
      }
      if (command === 'meeting.rename' || command === 'meeting.delete' || command === 'task.set-interval') {
        const mode = command === 'task.set-interval' ? (overrides.taskInterval ?? 'ok') : (overrides.meetingSet ?? 'ok')
        if (mode === 'timeout') throw new Error('桌面命令超时')
        if (mode.startsWith('error:')) return { applied: false, error: mode.slice('error:'.length) }
        return { applied: true }
      }
      if (command === 'pet.config.summary') {
        if (overrides.petConfig === 'timeout') throw new Error('桌面命令超时')
        return overrides.petConfig ?? { stageVisible: true, characters: [], skins: [] }
      }
      if (command === 'pet.config.set') {
        const mode = overrides.petSet ?? 'ok'
        if (mode === 'timeout') throw new Error('桌面命令超时')
        if (mode.startsWith('error:')) return { applied: false, error: mode.slice('error:'.length) }
        return { applied: true, note: '已生效' }
      }
      return { ok: true }
    },
  }
  /**
   * 总开关替身：命令层只该转调 enable/disable/state，不再直接动 tracker。
   * 采集范围确认、平台闸门这类判定属于 power 实现（见插件装配测试），这里只验命令接线。
   */
  const powerEvents: string[] = []
  const power = {
    enabled: () => (overrides.injection ?? 'off') === 'on',
    enable: async () => {
      powerEvents.push('enable')
      if (overrides.blocked) {
        return { ok: true, changed: true, capture: 'blocked' as const, text: `个人助理已开启；活动记录未开启：${overrides.blocked}` }
      }
      if (overrides.scope === false) {
        return { ok: true, changed: true, capture: 'pending' as const, text: '个人助理已开启：工具已注入当前会话；活动记录等你在桌面宠物里确认采集范围后开始' }
      }
      if (overrides.capturing) return { ok: true, changed: false, capture: 'recording' as const, text: '个人助理已经在运行' }
      return { ok: true, changed: true, capture: 'recording' as const, text: '个人助理已开启：工具已注入，开始记录活动' }
    },
    disable: async () => {
      powerEvents.push('disable')
      return { ok: true, changed: true, capture: 'off' as const, text: '个人助理已关闭：工具已撤回，活动记录已停止；桌面宠物保留' }
    },
    state: () => ({
      injection: (overrides.injection ?? 'off') as 'on' | 'off',
      capture: (overrides.capturing ? 'recording' : 'off') as 'recording' | 'off',
      blocked: overrides.blocked ?? null,
    }),
  }
  registerUserCommands(ctx as never, {
    bridge: bridge as never,
    power: power as never,
    ...(overrides.summary === undefined ? {} : { summary: overrides.summary }),
    ...(overrides.tasks === undefined ? {} : { tasks: overrides.tasks }),
    ...(overrides.lists === undefined ? {} : {
      lists: {
        todos: overrides.lists.todos ?? (() => null),
        reports: overrides.lists.reports ?? (() => null),
        members: overrides.lists.members ?? (() => null),
      },
    }),
  })
  return { definitions, events, powerEvents, desktop, command: (name: string) => definitions.find(item => item.name === name)! }
}

test('宿主没有 commands 服务时静默跳过，不影响插件加载', () => {
  assert.doesNotThrow(() => registerUserCommands({ effect: (run: () => () => void) => run() } as never, {
    bridge: {} as never,
    power: {} as never,
  }))
})

test('commands 服务晚于插件就绪时，等它出现再注册', () => {
  let ready = false
  let pending: (() => void) | null = null
  const definitions: Definition[] = []
  const service = { register: (definition: Definition) => { definitions.push(definition); return () => {} } }
  const ctx = {
    get: (name: string) => (ready && name === 'commands' ? service : undefined),
    effect: (run: () => () => void) => run(),
    inject: (_deps: string[], callback: (scope: unknown) => void) => { pending = () => callback(ctx) },
  }
  registerUserCommands(ctx as never, {
    bridge: { teamEnabled: false, bind: async () => ({ port: 1 }), launchPet: () => true } as never,
    power: { enabled: () => false } as never,
  })
  assert.equal(definitions.length, 0)
  ready = true
  assert.ok(pending)
  pending!()
  // **排序后比较**：这道断言要证明的是"有哪些命令"，不是"按什么顺序注册"。
  // 注册顺序是实现的偶然属性，把它写进断言，等于让每次无关重构都可能判红；
  // 而被忽略的护栏等于没有护栏。
  // 若将来命令顺序本身有了语义（例如帮助文本按注册序展示），这里要改回有序断言并说明原因。
  assert.deepEqual([...definitions.map(item => item.name)].sort(), [...EXPECTED_COMMANDS].sort())
})

test('注册全部用户命令：一键入口 / 概览数字 / 打开工作台 / 四张列表 / 设置摘要', () => {
  const { definitions } = harness()
  // **排序后比较**：这道断言要证明的是"有哪些命令"，不是"按什么顺序注册"。
  // 注册顺序是实现的偶然属性，把它写进断言，等于让每次无关重构都可能判红；
  // 而被忽略的护栏等于没有护栏。
  // 若将来命令顺序本身有了语义（例如帮助文本按注册序展示），这里要改回有序断言并说明原因。
  assert.deepEqual([...definitions.map(item => item.name)].sort(), [...EXPECTED_COMMANDS].sort())
  for (const item of definitions) assert.ok(item.description.trim().length > 0)
})

test('召唤命令绑定当前会话并拉起桌宠', async () => {
  const { command, events } = harness()
  const result = await command('summon-pet').handler({ agent: { id: 'agent-1' } })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已召唤/)
  assert.deepEqual(events, ['bind', 'launch'])
})

test('团队模式下召唤仍兜底拉起桌宠，不把启动留给不存在的桌面壳', async () => {
  const { command, events } = harness({ teamEnabled: true })
  const result = await command('summon-pet').handler({ agent: { id: 'agent-1' } })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已请求启动桌宠/)
  assert.deepEqual(events, ['bind', 'launch'])
})

/**
 * 桥接端口是对外**契约级**文案：客户端用 `/桥接端口\s*(\d{2,5})/u` 从回执里取端口，
 * 取不到就静默不显示（界面上看不出来、日志里也没有）。所以形状必须由服务端钉住 ——
 * 谁改文案都会先在这里红一条，而不是等用户发现"端口不见了"。
 * 断言形状与客户端正则保持一致：`桥接端口` + 一个半角空格 + 2–5 位数字。
 */
test('回执里的桥接端口形状固定（客户端据此取数）', async () => {
  const bound = await harness().command('bind-pet').handler({ agent: { id: 'agent-1' } })
  assert.match(bound.text, /桥接端口 \d{2,5}/, 'bind-pet 回执必须带可解析的端口')

  // 团队模式：绑定成功但没有"宠物已拉起"那句，端口是客户端唯一的来源。
  const team = await harness({ teamEnabled: true }).command('summon-pet').handler({ agent: { id: 'agent-1' } })
  assert.match(team.text, /桥接端口 \d{2,5}/, '团队模式回执必须带可解析的端口')

  // 拉起失败：仍然要报端口（用户已经绑定成功了，只是桌宠没起来）。
  const unlucky = await harness({ launchPet: () => false }).command('summon-pet').handler({ agent: { id: 'agent-1' } })
  assert.match(unlucky.text, /桥接端口 \d{2,5}/, '拉起失败的回执必须带可解析的端口')
})

test('召唤命令失败时如实返回错误，不假装成功', async () => {
  const { command } = harness({ bind: async () => { throw new Error('bind failed') } })
  const result = await command('summon-pet').handler({ agent: { id: 'agent-1' } })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /bind failed/)
})

test('绑定命令只绑定会话，不启动桌宠', async () => {
  const { command, events } = harness()
  const result = await command('bind-pet').handler({ agent: { id: 'agent-1' } })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已绑定/)
  assert.deepEqual(events, ['bind'])
})

test('没有可绑定会话时仍把宠物叫出来，只是暂不绑定', async () => {
  const { command, events } = harness()
  const result = await command('summon-pet').handler({})
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已启动/)
  assert.deepEqual(events, ['launch'])
})

test('开启命令在范围未确认时仍开工具，并把采集指引说清楚', async () => {
  const h = harness({ scope: false })
  const result = await h.command('assistant-on').handler({})
  assert.equal(result.kind, 'success')
  assert.match(result.text, /采集范围/)
  assert.deepEqual(h.powerEvents, ['enable'])
})

test('开启命令在采集被拦住时仍开工具，如实说明采集没开', async () => {
  const h = harness({ blocked: '平台不支持' })
  const result = await h.command('assistant-on').handler({})
  assert.equal(result.kind, 'success')
  assert.match(result.text, /平台不支持/)
  assert.deepEqual(h.powerEvents, ['enable'])
})

test('开启与关闭命令转调总开关，不直接动 tracker', async () => {
  const on = harness()
  assert.equal((await on.command('assistant-on').handler({})).kind, 'success')
  assert.deepEqual(on.powerEvents, ['enable'])
  assert.deepEqual(on.events, [])

  const running = harness({ capturing: true })
  assert.match((await running.command('assistant-on').handler({})).text, /已经在运行/)
  assert.deepEqual(running.powerEvents, ['enable'])

  const off = harness()
  assert.equal((await off.command('assistant-off').handler({})).kind, 'success')
  assert.deepEqual(off.powerEvents, ['disable'])
  assert.deepEqual(off.events, [])
})

test('状态命令如实回 JSON：注入与采集分开', async () => {
  const on = await harness({ injection: 'on', capturing: true }).command('assistant-state').handler({})
  assert.deepEqual(JSON.parse(on.text), { injection: 'on', capture: 'recording' })
  const blocked = await harness({ blocked: '平台不支持' }).command('assistant-state').handler({})
  assert.deepEqual(JSON.parse(blocked.text), { injection: 'off', capture: 'off', blocked: '平台不支持' })
})

test('宠物配置读：桌宠在线时原样带出 JSON，超时时如实说读不到', async () => {
  const view = {
    stageVisible: false,
    characters: [{ assistantId: 'member-tangseng', displayName: '总助理', roleId: 'tangseng', skin: 'nezha', randomActions: ['recite-poem'], steppedDown: false, chief: true }],
    skins: [{ id: 'panda', label: '国宝熊猫', actions: [{ id: 'walk', label: '走路' }] }],
  }
  const online = await harness({ petConfig: view }).command('assistant-pet-config').handler({})
  assert.equal(online.kind, 'success')
  assert.deepEqual(JSON.parse(online.text), { ok: true, ...view })

  const offline = await harness({ petConfig: 'timeout' }).command('assistant-pet-config').handler({})
  assert.equal(offline.kind, 'success', '桌宠没跑不算命令失败：页面要显示"读不到"而不是一块红')
  assert.equal(JSON.parse(offline.text).unavailable, true)
  assert.match(JSON.parse(offline.text).message, /没在运行/)
})

test('宠物配置写：合法改动转成桌面命令，拒绝与超时都给出原因', async () => {
  const ok = harness()
  const changed = await ok.command('assistant-pet-set').handler({ rawInput: '/assistant-pet-set skin member-tangseng nezha' })
  assert.equal(changed.kind, 'success')
  assert.match(changed.text, /member-tangseng.*nezha/)
  assert.deepEqual(ok.desktop.at(-1), {
    command: 'pet.config.set',
    payload: { kind: 'skin', assistantId: 'member-tangseng', value: 'nezha' },
  })

  const refused = await harness({ petSet: 'error:没有这个形象' }).command('assistant-pet-set').handler({ rawInput: '/assistant-pet-set skin member-tangseng nope' })
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /没有这个形象/)

  const offline = await harness({ petSet: 'timeout' }).command('assistant-pet-set').handler({ rawInput: '/assistant-pet-set stage hide' })
  assert.equal(offline.kind, 'error')
  assert.match(offline.text, /没在运行/)

  const usage = await harness().command('assistant-pet-set').handler({ rawInput: '/assistant-pet-set skin' })
  assert.equal(usage.kind, 'success')
  assert.match(usage.text, /用法/)
})

test('工作台概览：三条只读命令都有数据时各自返回一行短文本', async () => {
  const h = harness({
    meetingCount: 2,
    summary: () => ({ openTodos: 3, awaitingUser: 1, meetingsToday: null, activeMs: 4.33 * 3_600_000, topSubject: 'dsh-pet' }),
  })
  assert.equal((await h.command('assistant-todo-count').handler({})).text, '待办 3 项（1 项待你处理）')
  assert.equal((await h.command('assistant-meeting-today').handler({})).text, '今天 2 场会议')
  assert.match((await h.command('assistant-today-summary').handler({})).text, /^今天 4 小时 \d+ 分，主要在 dsh-pet$/)
  // 只读：不写库、不起停采集、不绑会话、不拉起桌宠。
  assert.deepEqual(h.events, ['desktop:meeting.count'])
  assert.deepEqual(h.desktop[0], { command: 'meeting.count', payload: { from: h.desktop.length > 0 ? (h.desktop[0].payload as { from: number }).from : 0, to: (h.desktop[0].payload as { to: number }).to } })
  const sent = h.desktop[0].payload as { from: number; to: number }
  const start = new Date(sent.to - 1); start.setHours(0, 0, 0, 0)
  assert.equal(sent.from, start.getTime(), 'from 必须是今天 0 点')
  assert.ok(sent.to > sent.from)
})

test('工作台概览：空数据与数据源不可用分别说人话，不冒充 0', async () => {
  // 桌宠在线但今天确实没开会：给 0 场，说「今天还没有会议」——不是"读不到"。
  const empty = harness({
    meetingCount: 0,
    summary: () => ({ openTodos: 0, awaitingUser: 0, meetingsToday: null, activeMs: 0, topSubject: null }),
  })
  assert.equal((await empty.command('assistant-todo-count').handler({})).text, '没有待办')
  assert.equal((await empty.command('assistant-meeting-today').handler({})).text, '今天还没有会议')
  assert.equal((await empty.command('assistant-today-summary').handler({})).text, '今天还没有记录到活动')

  const broken = harness({ meetingCount: 'timeout', summary: () => { throw new Error('库锁住了') } })
  for (const name of ['assistant-todo-count', 'assistant-meeting-today', 'assistant-today-summary']) {
    const result = await broken.command(name).handler({})
    assert.equal(result.kind, 'success', '读不到也算成功返回，前端才好显示占位')
    assert.match(result.text, /暂时读不到/)
  }
})

test('工作台概览：宿主没接数据源时命令仍然存在（待办/活动读不到，会议照常问桌宠）', async () => {
  const h = harness()
  for (const name of ['assistant-todo-count', 'assistant-today-summary']) {
    const result = await h.command(name).handler({})
    assert.equal(result.kind, 'success')
    assert.match(result.text, /暂时读不到/)
  }
  // 会议数走的是桌宠的只读命令，不依赖宿主的 summary 数据源。
  assert.equal((await h.command('assistant-meeting-today').handler({})).text, '今天还没有会议')
})

test('打开工作台：六个页面各自转发正确的 page', async () => {
  const pages = ['todo', 'meeting', 'report', 'team', 'doc', 'general'] as const
  for (const page of pages) {
    const h = harness({ petOnline: true })
    const result = await h.command('open-workbench').handler({ rawInput: `/open-workbench ${page}` })
    assert.equal(result.kind, 'success', page)
    assert.deepEqual(h.desktop, [{ command: 'workbench.open', payload: { page } }], page)
    assert.match(result.text, /^已打开工作台的「/)
  }
})

test('打开工作台：中文页名也认（按钮文案是中文）', async () => {
  const h = harness({ petOnline: true })
  await h.command('open-workbench').handler({ rawInput: '/open-workbench 日报' })
  assert.deepEqual(h.desktop, [{ command: 'workbench.open', payload: { page: 'report' } }])
})

test('打开工作台：参数缺失或非法 → 列出可选页，算 success 且不碰桌宠', async () => {
  for (const rawInput of ['/open-workbench', '/open-workbench 首页', '']) {
    const h = harness({ petOnline: true })
    const result = await h.command('open-workbench').handler({ rawInput })
    assert.equal(result.kind, 'success', rawInput)
    assert.match(result.text, /要打开哪一页？可选：待办、会议、日报、助理团、文档、通用/)
    assert.deepEqual(h.desktop, [], '参数不对不该往桌宠发命令')
  }
})

test('打开工作台：桌宠没在运行 → 明确文案，且不静默拉起', async () => {
  const h = harness({ petOnline: false })
  const result = await h.command('open-workbench').handler({ rawInput: '/open-workbench todo' })
  assert.equal(result.kind, 'success')
  assert.equal(result.text, '桌面宠物没在运行，先召唤它再打开工作台')
  assert.equal(h.events.includes('launch'), false, '拉起是 /summon-pet 的职责，不能混进来')
})

test('会议数：桌面命令超时 → 「暂时读不到今天的会议」，绝不当成 0', async () => {
  const h = harness({ meetingCount: 'timeout' })
  const result = await h.command('assistant-meeting-today').handler({})
  assert.equal(result.kind, 'success')
  assert.equal(result.text, '暂时读不到今天的会议')
  assert.notEqual(result.text, '今天还没有会议', '读不到与 0 场必须分开')
})

test('会议数：桌宠没在跑（通道断开）同样是「暂时读不到」，且另外两条命令不受影响', async () => {
  const h = harness({ petOnline: false, summary: () => ({ openTodos: 1, awaitingUser: 0, meetingsToday: null, activeMs: 0, topSubject: null }) })
  assert.equal((await h.command('assistant-meeting-today').handler({})).text, '暂时读不到今天的会议')
  // 另外两条各自独立：不依赖桌宠，照常给数。
  assert.equal((await h.command('assistant-todo-count').handler({})).text, '待办 1 项')
  assert.equal((await h.command('assistant-today-summary').handler({})).text, '今天还没有记录到活动')
})

test('待办列表：有数据 / 空 / 读不到 三种形态', async () => {
  const filled = harness({ lists: { todos: () => [
    { goal: '改讲解链路', status: 'awaiting-user', deadlineAt: null },
    { goal: '发周报', status: 'running', deadlineAt: null },
  ] } })
  const rows = (await filled.command('assistant-todo-list').handler({})).text.split('\n')
  assert.equal(rows.length, 2)
  // 可见 5 列 + 末尾隐藏的第 6 格 taskId。
  assert.equal(rows[0].split(' | ').length, 6, '每行六格（第 6 格是隐藏的 taskId）')
  // 缺 priority/source 时按 中/手动 兜底（老数据）；缺 taskId 时第 6 格是 —，格数仍然整齐。
  assert.match(rows[0], /^改讲解链路 \| 中 \| 手动 \| 待你处理 \| — \| —$/)

  const empty = harness({ lists: { todos: () => [] } })
  assert.equal((await empty.command('assistant-todo-list').handler({})).text, '还没有待办')

  const broken = harness({ lists: { todos: () => null } })
  assert.equal((await broken.command('assistant-todo-list').handler({})).text, '暂时读不到待办')
  // 宿主完全没接列表数据源：命令仍存在，回「暂时读不到」。
  assert.equal((await harness().command('assistant-todo-list').handler({})).text, '暂时读不到')
})

test('会议列表：有数据 / 空 / 桌宠超时 三种形态', async () => {
  const startedAt = new Date(2026, 0, 2, 9, 30).getTime()
  const filled = harness({ meetingList: [{ startedAt, name: '周会', state: 'transcribed', id: 'm-1' }] })
  const text = (await filled.command('assistant-meeting-list').handler({})).text
  assert.deepEqual(text.split('\n')[0].split(' | '), ['09:30', '周会', '已转写', 'm-1'])

  const empty = harness({ meetingList: [] })
  assert.equal((await empty.command('assistant-meeting-list').handler({})).text, '今天还没有会议')

  const timeout = harness({ meetingList: 'timeout' })
  assert.equal((await timeout.command('assistant-meeting-list').handler({})).text, '暂时读不到今天的会议')
})

test('日报列表：有数据 / 空 / 读不到 三种形态', async () => {
  const filled = harness({ lists: { reports: () => [{ date: '2026-01-02', state: '草稿', summary: '改了讲解链路' }] } })
  assert.deepEqual((await filled.command('assistant-report-list').handler({})).text.split(' | '), ['2026-01-02', '草稿', '改了讲解链路'])
  assert.equal((await harness({ lists: { reports: () => [] } }).command('assistant-report-list').handler({})).text, '还没有日报草稿')
  assert.equal((await harness({ lists: { reports: () => null } }).command('assistant-report-list').handler({})).text, '暂时读不到日报')
})

test('成员列表：有数据 / 空 / 读不到 三种形态', async () => {
  const filled = harness({ lists: { members: () => [{ name: '小会', role: 'wukong', enabled: true, quota: '1200/8000' }] } })
  assert.deepEqual((await filled.command('assistant-team-list').handler({})).text.split(' | '), ['小会', '助理1', '在岗', '1200/8000'])
  assert.equal((await harness({ lists: { members: () => [] } }).command('assistant-team-list').handler({})).text, '还没有成员')
  assert.equal((await harness({ lists: { members: () => null } }).command('assistant-team-list').handler({})).text, '暂时读不到成员')
})

test('列表命令一律只读：不发会话、不绑、不拉起', async () => {
  const h = harness({
    meetingList: [],
    lists: { todos: () => [], reports: () => [], members: () => [] },
  })
  for (const name of ['assistant-todo-list', 'assistant-meeting-list', 'assistant-report-list', 'assistant-team-list']) {
    const result = await h.command(name).handler({})
    assert.equal(result.kind, 'success')
  }
  assert.deepEqual(h.events, ['desktop:meeting.list'], '只有会议列表会打一次只读桌面命令')
})

test('设置摘要：三行真值按固定顺序，读不到时整条降级', async () => {
  const filled = harness({ settingsSummary: { wakeEnabled: true, wakeVoiceprint: false, readReplies: true, docSpeechMode: 'source' } })
  const text = (await filled.command('assistant-settings-summary').handler({})).text
  assert.deepEqual(text.split('\n'), ['唤醒 | 开 · 谁都行', '播报 | 所有回复都念', '讲解模式 | 原文朗读'])
  // 只有一次只读桌面命令，没有别的副作用。
  assert.deepEqual(filled.events, ['desktop:settings.summary'])

  const timeout = harness({ settingsSummary: 'timeout' })
  assert.equal((await timeout.command('assistant-settings-summary').handler({})).text, '暂时读不到设置')

  const partial = harness({ settingsSummary: { wakeEnabled: false } })
  assert.equal((await partial.command('assistant-settings-summary').handler({})).text, '唤醒 | 关')
})

test('历史会议列表：5 列、来源三种组合、空与读不到分开', async () => {
  const startedAt = new Date(2026, 10, 12, 14, 30).getTime()
  const filled = harness({ meetingHistory: [
    { id: 'm1', name: '周会', startedAt, endedAt: null, sources: 'mic+loopback', retentionDays: 30, integrityStatus: 'complete', transcriptStatus: '已转写' },
    { id: 'm2', name: '双人评审', startedAt, endedAt: null, sources: 'mic', retentionDays: 7, integrityStatus: 'incomplete', transcriptStatus: '部分转写' },
  ] })
  const rows = (await filled.command('assistant-meeting-history').handler({})).text.split('\n')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0].split(' | '), ['2026-11-12 14:30', '周会', '麦克风+系统声', '30 天', '已转写', 'm1'])
  assert.deepEqual(rows[1].split(' | '), ['2026-11-12 14:30', '双人评审', '仅麦克风', '7 天', '部分转写', 'm2'])
  // 只读：只发了一条 meeting.history 桌面命令。
  assert.deepEqual(filled.events, ['desktop:meeting.history'])

  const empty = harness({ meetingHistory: [] })
  assert.equal((await empty.command('assistant-meeting-history').handler({})).text, '还没有历史会议')

  const timeout = harness({ meetingHistory: 'timeout' })
  assert.equal((await timeout.command('assistant-meeting-history').handler({})).text, '暂时读不到历史会议')
})

test('历史会议列表：字段缺失时该格为 —，列数不变', async () => {
  const partial = harness({ meetingHistory: [{ startedAt: 0 }] })
  const columns = (await partial.command('assistant-meeting-history').handler({})).text.split(' | ')
  assert.equal(columns.length, 6)
  assert.deepEqual(columns, ['—', '—', '—', '—', '—', '—'])
})

test('改设置：三种合法参数各自转发正确的 key/value', async () => {
  for (const [rawInput, key, value] of [
    ['/assistant-set-option wake=on', 'wake', 'on'],
    ['/assistant-set-option broadcast=voice', 'broadcast', 'voice'],
    ['/assistant-set-option docSpeech=ai', 'docSpeech', 'ai'],
  ] as const) {
    const h = harness({ settingsSet: 'ok' })
    const result = await h.command('assistant-set-option').handler({ rawInput })
    assert.equal(result.kind, 'success', rawInput)
    assert.deepEqual(h.desktop, [{ command: 'settings.set', payload: { key, value } }], rawInput)
    assert.match(result.text, /^已/)
  }
  // 中文键同样转发英文 key
  const zh = harness({ settingsSet: 'ok' })
  await zh.command('assistant-set-option').handler({ rawInput: '/assistant-set-option 唤醒=关' })
  assert.deepEqual(zh.desktop, [{ command: 'settings.set', payload: { key: 'wake', value: 'off' } }])
})

test('改设置：三种非法参数只回提示，不碰桌宠', async () => {
  for (const rawInput of ['/assistant-set-option', '/assistant-set-option nope=on', '/assistant-set-option wake=maybe']) {
    const h = harness({ settingsSet: 'ok' })
    const result = await h.command('assistant-set-option').handler({ rawInput })
    assert.equal(result.kind, 'success', rawInput)
    assert.match(result.text, /用法：\/assistant-set-option 键=值/)
    assert.deepEqual(h.desktop, [], '参数不对不该往桌宠发命令')
  }
})

test('改设置：桌宠拒绝与超时都如实说，不报成功', async () => {
  const refused = harness({ settingsSet: 'error:唤醒没能启动：本地唤醒模型没有安装' })
  const denied = await refused.command('assistant-set-option').handler({ rawInput: '/assistant-set-option wake=on' })
  // 写失败必须是 error：让客户端按 kind 分支，而不是靠文案前缀猜。
  assert.equal(denied.kind, 'error')
  assert.equal(denied.text, '设置没改成：唤醒没能启动：本地唤醒模型没有安装')

  const timeout = harness({ settingsSet: 'timeout' })
  const offline = await timeout.command('assistant-set-option').handler({ rawInput: '/assistant-set-option wake=on' })
  assert.equal(offline.kind, 'error')
  assert.equal(offline.text, '设置没改成：桌面宠物没在运行，先召唤它')
})

test('改优先级命令：合法调用只提交提案，库里 priority 不变', async () => {
  const calls: Array<{ method: string; path: string; subject: string }> = []
  const h = harness({
    tasks: {
      async request(method: string, path: string, _body: unknown, subject: string) {
        calls.push({ method, path, subject })
        if (method === 'GET') return { status: 200, body: { task: { revision: 7, title: '写周报' } } }
        return { status: 202, body: { requiresApproval: true } }
      },
    },
  })
  const result = await h.command('assistant-set-task-priority').handler({ rawInput: '/assistant-set-task-priority task-1 high' })
  assert.equal(result.kind, 'success')
  // 带标题：用户要知道"改的是哪一条"；但措辞只能是"已提交"，不能是"已改成"。
  assert.equal(result.text, '已提交「写周报」改成高优先级，请在桌面宠物里确认')
  // 只提案不改库：两次调用都是 client 身份，且没有任何"直接改"的路径。
  assert.deepEqual(calls.map(call => `${call.method} ${call.subject}`), ['GET client', 'POST client'])
  // 标题缺失时退回不带标题的说法，且仍然说"已提交"。
  const noTitle = harness({ tasks: {
    async request(method: string) { return method === 'GET' ? { status: 200, body: { task: { revision: 1 } } } : { status: 202, body: {} } },
  } })
  const fallback = await noTitle.command('assistant-set-task-priority').handler({ rawInput: '/assistant-set-task-priority t high' })
  assert.equal(fallback.text, '已提交，请在桌面宠物里确认')
  assert.match(calls[1].path, /\/companion\/v1\/tasks\/task-1\/set-priority$/)
})

test('改优先级命令：参数个数不对（提示 success）与值非法（失败 error），且都不碰运行时', async () => {
  let touched = 0
  const h = harness({ tasks: { async request() { touched++; return { status: 200, body: {} } } } })
  const usage = await h.command('assistant-set-task-priority').handler({ rawInput: '/assistant-set-task-priority task-1' })
  assert.equal(usage.kind, 'success')
  assert.equal(usage.text, '用法：/assistant-set-task-priority <任务ID> high|normal|low')
  // 值非法 = **没办成** → error（参数没给全是提示 → success，见上一条断言）。
  const bad = await h.command('assistant-set-task-priority').handler({ rawInput: '/assistant-set-task-priority task-1 urgent' })
  assert.equal(bad.kind, 'error')
  assert.equal(bad.text, '优先级只能是 high、normal 或 low')
  // 大写不是合法的三个 token 之一 → 失败。
  const upper = await h.command('assistant-set-task-priority').handler({ rawInput: '/assistant-set-task-priority task-1 HIGH' })
  assert.equal(upper.kind, 'error')
  assert.equal(upper.text, '优先级只能是 high、normal 或 low')
  // **空值不属于"值非法"，属于"参数没给全"**：`/cmd task-1 ` 里第二个参数根本不存在，
  // 用户需要的是"我该怎么写"，不是"你给的值不行"。所以回用法提示（success）。
  const empty = await h.command('assistant-set-task-priority').handler({ rawInput: '/assistant-set-task-priority task-1 ' })
  assert.equal(empty.kind, 'success')
  assert.equal(empty.text, '用法：/assistant-set-task-priority <任务ID> high|normal|low')
  assert.equal(touched, 0, '参数不对不该碰运行时')
})

test('改优先级命令：运行时拒绝时如实报错，不报成功', async () => {
  const h = harness({ tasks: {
    async request(method: string) {
      if (method === 'GET') return { status: 200, body: { task: { revision: 3 } } }
      return { status: 409, body: { message: '任务已变化，请刷新后重新确认' } }
    },
  } })
  const result = await h.command('assistant-set-task-priority').handler({ rawInput: '/assistant-set-task-priority task-1 low' })
  assert.equal(result.kind, 'error')
  assert.equal(result.text, '优先级没改成：任务已变化，请刷新后重新确认')
})

test('待办列表：真实 taskId 会出现在第 6 格（前端点的就是它）', async () => {
  // 这条补的是"命令层"的缺口：前面的用例给的是没有 taskId 的行（第 6 格为 —），
  // 只证明了"格数整齐"；这里证明**有 ID 时它确实落在第 6 格、且一字不差**。
  const h = harness({ lists: { todos: () => [
    { goal: '改讲解链路', status: 'awaiting-user', deadlineAt: null, priority: 'high', source: 'meeting',
      updatedAt: 2, taskId: '9f2a41c7-3d5e-4b8a-9c1d-7e6f0a2b3c4d' },
    { goal: '回滚方案', status: 'running', deadlineAt: null, priority: 'normal', source: 'manual',
      updatedAt: 1, taskId: '1b7c9e02-8a4d-4f61-b3c5-2d9e8f7a6b10' },
  ] } })
  const rows = (await h.command('assistant-todo-list').handler({})).text.split('\n').map(line => line.split(' | '))
  assert.equal(rows.length, 2)
  for (const row of rows) assert.equal(row.length, 6, '每行六格')
  // 第 1 行是 high（排序在前），第 6 格必须是它自己的 id —— 不是另一条的。
  assert.equal(rows[0][0], '改讲解链路')
  assert.equal(rows[0][5], '9f2a41c7-3d5e-4b8a-9c1d-7e6f0a2b3c4d')
  assert.equal(rows[1][5], '1b7c9e02-8a4d-4f61-b3c5-2d9e8f7a6b10')
})

test('待办改标题/取消：提交待批提案（client），不直接落库', async () => {
  const calls: Array<{ method: string; path: string; subject: string }> = []
  const tasks = {
    request: async (method: string, path: string, _body: unknown, subject: string) => {
      calls.push({ method, path, subject })
      if (method === 'GET') return { status: 200, body: { task: { revision: 3, title: '旧标题' } } }
      return { status: 202, body: {} }
    },
  }
  const h = harness({ tasks })
  const titled = await h.command('assistant-task-set').handler({ rawInput: '/assistant-task-set title task-1 新标题' })
  assert.equal(titled.kind, 'success')
  assert.match(titled.text, /已提交.*新标题.*确认/)
  assert.equal(calls.at(-1)!.path, '/companion/v1/tasks/task-1/set-title')
  assert.equal(calls.at(-1)!.subject, 'client', '聊天/面板侧只能提案，不能直接写')

  const cancelled = await h.command('assistant-task-set').handler({ rawInput: '/assistant-task-set cancel task-1' })
  assert.match(cancelled.text, /取消/)
  assert.equal(calls.at(-1)!.path, '/companion/v1/tasks/task-1/cancel')
})

test('待办改期：人工待办用 deadlineAt；提醒保留重复规则只换首次时间', async () => {
  const posts: Array<{ path: string; payload: Record<string, unknown> }> = []
  const make = (spec?: unknown) => ({
    request: async (method: string, path: string, body: unknown) => {
      if (method === 'GET') return { status: 200, body: { task: { revision: 1, title: 't', ...(spec ? { schedule: { spec } } : {}) } } }
      posts.push({ path, payload: (body as { payload: Record<string, unknown> }).payload })
      return { status: 202, body: {} }
    },
  })
  const iso = '2026-11-17T15:00:00+08:00'
  const manual = harness({ tasks: make() })
  await manual.command('assistant-task-set').handler({ rawInput: `/assistant-task-set deadline task-1 ${iso}` })
  assert.deepEqual(posts.at(-1)!.payload, { deadlineAt: iso })

  const reminder = harness({ tasks: make({ kind: 'interval', timezone: 'UTC', runAt: '2026-11-17T09:00:00+08:00', everySeconds: 300 }) })
  await reminder.command('assistant-task-set').handler({ rawInput: `/assistant-task-set deadline task-2 ${iso}` })
  const payload = posts.at(-1)!.payload as { schedule: { runAt: string; everySeconds: number } }
  assert.equal(payload.schedule.runAt, iso)
  assert.equal(payload.schedule.everySeconds, 300, '重复规则不能被改期抹掉')
})

test('提醒间隔走桌宠本机确认；拒绝与超时如实报错', async () => {
  const ok = harness()
  const done = await ok.command('assistant-task-set').handler({ rawInput: '/assistant-task-set interval task-1 600' })
  assert.equal(done.kind, 'success')
  assert.match(done.text, /10 分钟/)
  assert.deepEqual(ok.desktop.at(-1), { command: 'task.set-interval', payload: { taskId: 'task-1', repeatEverySeconds: 600 } })

  const refused = await harness({ taskInterval: 'error:已取消修改' }).command('assistant-task-set').handler({ rawInput: '/assistant-task-set interval task-1 600' })
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /已取消修改/)
})

test('会议重命名/删除走桌宠；取消删除如实报错', async () => {
  const h = harness()
  const renamed = await h.command('assistant-meeting-set').handler({ rawInput: '/assistant-meeting-set rename m-1 新名字' })
  assert.equal(renamed.kind, 'success')
  assert.match(renamed.text, /新名字/)
  assert.deepEqual(h.desktop.at(-1), { command: 'meeting.rename', payload: { meetingId: 'm-1', name: '新名字' } })

  const deleted = await h.command('assistant-meeting-set').handler({ rawInput: '/assistant-meeting-set delete m-1' })
  assert.match(deleted.text, /已删除整场/)
  assert.deepEqual(h.desktop.at(-1), { command: 'meeting.delete', payload: { meetingId: 'm-1' } })

  const cancelled = await harness({ meetingSet: 'error:已取消删除' }).command('assistant-meeting-set').handler({ rawInput: '/assistant-meeting-set delete m-1' })
  assert.equal(cancelled.kind, 'error')
  assert.match(cancelled.text, /已取消删除/)
})

test('改删命令非法参数回用法提示，不发任何写命令', async () => {
  const h = harness()
  for (const raw of ['/assistant-task-set', '/assistant-task-set title', '/assistant-task-set interval task-1 5', '/assistant-meeting-set rename', '/assistant-meeting-set wat m-1']) {
    const result = await h.command(raw.startsWith('/assistant-task') ? 'assistant-task-set' : 'assistant-meeting-set').handler({ rawInput: raw })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /用法/)
  }
  assert.deepEqual(h.desktop, [])
})
