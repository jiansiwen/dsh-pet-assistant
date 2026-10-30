import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, assembleContextFor, type Agent, type AgentFactory, type AssistantStreamFrame, type CreateAgentOptions, type ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, StreamChunk, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ApprovalService } from '../src/approval.ts'
import type { MemberDraft } from '../src/member-contract.ts'
import { MemberRuntime, type MemberDirectory } from '../src/member-runtime.ts'
import { TeamStore } from '../src/team-domain.ts'
import { TeamService, watchReplyDeltas } from '../src/team.ts'
import { registerTeamTools } from '../src/team-tools.ts'

const require = createRequire(import.meta.url)
const sdkRequire = createRequire(require.resolve('@deepseek-ai/dsh-agent'))
const { default: SystemPrompt, renderPrompt } = await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-system-prompt')).href)
const { createScope, scopeTarget } = await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-scope')).href)
const quiet = { info() {}, warn() {}, error() {} }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const draft = (displayName: string, patch: Partial<MemberDraft> = {}): MemberDraft => ({
  displayName, description: `${displayName}的独立职责`, persona: '依据事实回答', skinId: 'panda', enabled: true,
  provider: '成员提供方', model: '成员模型', maxTokens: 80, capabilities: [], allowedTools: [],
  dailyTokenLimit: 1000, totalTokenLimit: 2000, thresholdPercent: 80, timezone: 'Asia/Shanghai', ...patch,
})
const usage = (tokens: number): TokenUsage => ({ inputTokens: tokens, outputTokens: 0 })
type Event = { type: string; data: Record<string, any> }

/** 只替换代理驱动与日志介质；请求 waterfall、作用域、工具 schema/restrict/guard 均使用真实 SDK。 */
class Driver {
  agent: Agent
  scope!: { ctx: Context; dispose(): Promise<void> }
  readonly done = deferred<void>()
  readonly controller = new AbortController()
  events: Event[]
  turn: number
  input?: UserMessage
  cancelCalls = 0
  disposeCalls = 0
  failDispose = false
  currentAttempt = ''
  revision = 0
  index = 0
  closed = false
  readonly root: Context
  readonly accepted: (driver: Driver) => void
  constructor(root: Context, id: string, history: Event[], accepted: (driver: Driver) => void) {
    this.root = root
    this.accepted = accepted
    this.events = [...history]
    this.turn = history.filter(event => event.type === 'turn/start').length + 1
    this.agent = {
      id, options: {}, session: { header: { id }, snapshotEvents: () => this.events }, inbox: { nextTurn: [], nextStep: [] },
      status: 'idle', followup: (message: UserMessage) => {
        this.input = message
        this.record('turn/start', { turn: this.turn })
        agentEvents(root, this.agent).emit('agent/inbox/claimed', { message, turn: this.turn })
        this.accepted(this)
      },
      whenIdle: () => this.done.promise,
      cancel: () => {
        this.cancelCalls++
        this.controller.abort('测试取消')
        this.end('canceled')
      },
    } as unknown as Agent
  }
  record(type: string, data: Record<string, any>): void {
    const event = { type, data }
    this.events.push(event)
    this.root.emit(scopeTarget(this.agent.session, this.agent), 'session/event', this.agent.session, event as never)
  }
  payload(agent = this.agent) { return { agent, turn: this.turn, step: this.revision + 1, signal: this.controller.signal } }
  async request(next = async (): Promise<LlmCallConfig> => ({ provider: '宿主', model: '宿主模型', maxTokens: 999 })): Promise<LlmCallConfig> {
    return agentEvents(this.root, this.agent).waterfall('agent/request', this.payload(), next)
  }
  async preStep(): Promise<unknown> {
    return agentEvents(this.root, this.agent).waterfall('agent/pre-step', { ...this.payload(), messages: this.input ? [this.input] : [] }, async () => ({ kind: 'enter', messages: [] }))
  }
  frame(frame: object, agent = this.agent): void {
    agentEvents(this.root, agent).emit('agent/assistant-stream', { frame: frame as AssistantStreamFrame })
  }
  startAttempt(): void {
    this.revision++
    this.currentAttempt = `请求-${this.revision}`
    this.index = 0
    this.frame({ type: 'start', turn: this.turn, step: this.revision, revision: this.revision, attemptId: this.currentAttempt })
  }
  chunk(chunk: StreamChunk): void {
    this.frame({ type: 'chunk', attemptId: this.currentAttempt, revision: this.revision, index: this.index++, time: Date.now(), chunk })
  }
  finish(value?: TokenUsage, failure = false): void {
    if (value) this.chunk({ type: 'usage', usage: value })
    this.chunk({ type: 'finish', reason: failure ? { kind: 'error', failure: { message: '测试失败', code: 'UNKNOWN' } } : { kind: 'stop' } })
    this.endAttempt()
  }
  endAttempt(): void {
    this.frame({ type: 'end', attemptId: this.currentAttempt, revision: this.revision, index: this.index,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } })
  }
  end(reason = 'completed', text = '本次成员回复'): void {
    if (this.closed) return
    this.closed = true
    if (text) this.record('assistant/message', { turn: this.turn, step: 1, message: { content: [{ type: 'text', text }] } })
    this.record('turn/end', { turn: this.turn, reason: { kind: reason } })
    this.done.resolve()
  }
  tool(name: string, args: unknown = {}, agent = this.agent) {
    return this.root.tools.execute({ name, arguments: args, callId: `调用-${Math.random()}` as never, agent, signal: this.controller.signal })
  }
  async prompt(agent = this.agent): Promise<string> {
    return renderPrompt(await this.root.systemPrompt.assemble(assembleContextFor(agent, this.controller.signal)))
  }
}

async function fixture(t: TestContext, file?: string) {
  const root = new Context()
  const plugins = [root.plugin(SystemPrompt, {}), root.plugin(ToolRuntime), root.plugin(AgentRegistry)]
  for (const plugin of plugins) await plugin
  const store = new TeamStore(file ?? ':memory:')
  let enabled = true
  let notifications = 0
  const memories = new Map<string, string>()
  const proposals: Array<{ id: string; input: unknown }> = []
  const desktopCalls: Array<{ command: string; payload: Record<string, unknown> }> = []
  const mailReads: number[] = []
  const logs = new Map<string, Event[]>()
  const drivers: Driver[] = []
  const bodies: string[] = []
  const calls: Array<{ kind: string; id: string }> = []
  const arrivals: Driver[] = []
  const waiters: Array<(driver: Driver) => void> = []
  let failResume = false
  let beforeSetup: ((driver: Driver) => void) | undefined
  let runtime!: MemberRuntime
  const globalNames = ['read', 'web_search', 'bash', 'write', 'subagent', 'desktop_team_assign', 'personal_assistant_remember_preference',
    'personal_assistant_list_preferences', 'personal_assistant_start', 'personal_assistant_delete_activity', 'companion_set_owner',
    'personal_assistant_send_mail', 'personal_assistant_today', 'personal_assistant_get_draft', 'personal_assistant_save_draft',
    'companion_create_reminder', 'companion_create_task', 'companion_task_status']
  for (const name of globalNames) root.tools.register(defineTool({ name, description: '无副作用测试工具', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    execute: async () => { bodies.push(name); return name === 'personal_assistant_send_mail' ? '待本人审批' : '测试回执' },
  }))
  root.systemPrompt.variable('personal_assistant_preferences', () => '总助理私有偏好')
  root.systemPrompt.variable('personal_assistant_memory_conflicts', () => '总助理私有冲突')
  root.systemPrompt.section({ name: '共享记忆模板', order: 100, text: '{{personal_assistant_preferences}}\n{{personal_assistant_memory_conflicts}}' })
  const make = async (ownerCtx: Context, options: CreateAgentOptions | ResumeAgentOptions) => {
    const resume = 'resumeSessionId' in options
    const id = String(resume ? options.resumeSessionId : options.sessionId)
    calls.push({ kind: resume ? 'resume' : 'create', id })
    if (resume && (failResume || !logs.has(id))) throw new Error('持久日志读取失败')
    const driver = new Driver(root, id, logs.get(id) ?? [], driver => {
      assert.equal(store.directory.list().find(member => member.sessionId === id)?.sessionId, id, '先持久 sessionId 再 followup')
      const waiter = waiters.shift()
      if (waiter) waiter(driver); else arrivals.push(driver)
    })
    // 实际工厂的 agent scope 继承驱动插件已声明的服务依赖，不从 registry 的代理调用上下文猜依赖。
    driver.scope = createScope(ctx, driver.agent)
    Object.assign(driver.agent, { ctx: driver.scope.ctx })
    beforeSetup?.(driver)
    try { await options.setup?.(driver.scope.ctx, driver.agent) }
    catch (error) { await driver.scope.dispose(); throw error }
    drivers.push(driver)
    await agentEvents(root, driver.agent).serial('agent/created', { source: resume ? 'resume' : 'startup' })
    return { agent: driver.agent, dispose: async () => {
      driver.disposeCalls++
      if (driver.failDispose) throw new Error('测试释放失败')
      if (!driver.closed) driver.agent.cancel({ kind: 'disposed' })
      logs.set(id, [...driver.events])
      await driver.scope.dispose()
    } }
  }
  root.agents.setFactory({ createAgent: make, resume: make } as AgentFactory)
  let ctx!: Context
  const owner = root.plugin(Object.assign((inner: Context) => { ctx = inner }, { inject: ['agents', 'tools', 'systemPrompt'] }))
  await owner
  const options = { ctx, directory: store.directory as MemberDirectory, enabled: () => enabled,
    defaultModel: () => ({ provider: '默认提供方', model: '默认模型' }),
    memories: { injectable: (id: string) => memories.get(id) ?? '', propose: (id: string, input: unknown) => { proposals.push({ id, input }); return { status: 'candidate' } } },
    desktop: { request: async (command: string, payload: Record<string, unknown>) => { desktopCalls.push({ command, payload }); return { ok: true, command } } },
    mailUnread: async (limit?: number) => { mailReads.push(limit ?? 5); return { uidValidity: '1', messages: [{ uid: 1, subject: '主题', from: 'a@example.com', date: '', text: '正文' }] } },
    onChange: () => { notifications++ },
  }
  runtime = new MemberRuntime(options)
  t.after(async () => {
    for (const driver of drivers) driver.failDispose = false
    await runtime.dispose()
    for (const driver of drivers) await driver.scope.dispose()
    await owner.dispose()
    for (const plugin of plugins.reverse()) await plugin.dispose()
    store.close()
  })
  return { root, store, calls, drivers, logs, memories, proposals, desktopCalls, mailReads, bodies, options,
    get runtime() { return runtime }, restart() { runtime = new MemberRuntime(options); return runtime },
    notifications: () => notifications, setEnabled: (value: boolean) => { enabled = value },
    failResume: () => { failResume = true }, beforeSetup: (callback: (driver: Driver) => void) => { beforeSetup = callback },
    next: () => arrivals.length ? Promise.resolve(arrivals.shift()!) : new Promise<Driver>(resolve => waiters.push(resolve)),
    async start(id: string, signal = new AbortController().signal, taskId?: string) {
      const started = await runtime.start(id, [{ type: 'text', text: '只处理本次任务' }], signal, taskId)
      return { ...started, driver: drivers.find(driver => driver.agent === started.child)! }
    },
  }
}

async function complete(driver: Driver, value = 10, text = '本次成员回复') {
  await driver.preStep(); await driver.request(); driver.startAttempt(); driver.finish(usage(value)); driver.end('completed', text)
}

test('不同成员会话隔离，任务与聊天共享持久 id，重建运行时只 resume，流式不重放历史', async t => {
  const h = await fixture(t)
  const a = h.store.directory.create(draft('甲'))
  const b = h.store.directory.create(draft('乙'))
  const first = await h.start(a.assistantId)
  await complete(first.driver, 10, '旧历史文字')
  await first.activation.dispose()
  const second = await h.start(b.assistantId)
  await complete(second.driver)
  await second.activation.dispose()
  await h.runtime.dispose(); h.restart()
  const third = await h.start(a.assistantId, undefined, '任务一')
  assert.equal(third.child.id, first.child.id)
  assert.notEqual(second.child.id, first.child.id)
  assert.deepEqual(h.calls.map(item => item.kind), ['create', 'create', 'resume'])
  assert.equal(third.activation.replyEvents.length, 0)
  await third.driver.request(); third.driver.startAttempt()
  third.driver.chunk({ type: 'text-delta', index: 0, text: '新增片段' })
  third.driver.finish(usage(5)); third.driver.end('completed', '新任务回答')
  assert.equal((await third.activation.result).stopReason, 'completed')
  assert.doesNotMatch(JSON.stringify(third.activation.replyEvents), /旧历史文字/)
  await third.activation.dispose()
  // 清掉手工 start 的到达记录，再走独立聊天入口。
  await h.next(); await h.next(); await h.next()
  const chat = h.runtime.chat(a.assistantId, '新的聊天')
  const driver = await h.next()
  await complete(driver, 7, '聊天结果')
  assert.equal(await chat, '聊天结果')
  assert.equal(driver.agent.id, first.child.id)
  assert.equal(h.store.directory.quota(a.assistantId).totalUsed, 22)
})

test('恢复失败不创建替代会话，持久收件箱残留不自动重发', async t => {
  const h = await fixture(t)
  const member = h.store.directory.create(draft('持久成员'))
  const first = await h.start(member.assistantId)
  await complete(first.driver); await first.activation.dispose()
  h.beforeSetup(driver => { Object.assign(driver.agent.inbox, { nextTurn: [{}] }) })
  await assert.rejects(h.start(member.assistantId), /不可用.*未结输入/)
  h.failResume()
  await assert.rejects(h.start(member.assistantId), /不可用.*读取失败/)
  assert.equal(h.calls.filter(item => item.kind === 'create').length, 1)
  assert.equal(h.store.directory.get(member.assistantId)?.sessionId, first.child.id)
  assert.equal(h.runtime.busy(), false)
})

test('真实工具过滤与 guard，零能力仍可回答及提交本成员记忆，引用不可伪造', async t => {
  const h = await fixture(t)
  const member = h.store.directory.create(draft('无外部能力'))
  h.memories.set(member.assistantId, '仅甲的记忆 {{字面量}}')
  h.memories.set('其他成员', '乙的私密记忆')
  const { driver, activation } = await h.start(member.assistantId)
  const prompt = await driver.prompt()
  assert.match(prompt, /仅甲的记忆 \{\{字面量\}\}/)
  assert.doesNotMatch(prompt, /总助理私有|乙的私密/)
  for (const name of ['read', 'bash', 'write', 'subagent', 'desktop_team_assign', 'personal_assistant_remember_preference', 'personal_assistant_list_preferences', 'companion_set_owner']) {
    assert.equal((await driver.tool(name)).isError, true, name)
    assert.equal(h.root.tools.get(name, driver.agent), undefined, '模型看不到未授权全局工具')
  }
  const remembered = await driver.tool('companion_member_remember', { kind: 'project_fact', topic: '事项', text: '记忆候选', assistantId: '其他成员', sourceRefs: ['伪造'] })
  assert.equal(remembered.isError, false)
  assert.deepEqual(h.proposals, [{ id: member.assistantId, input: { kind: 'project_fact', topic: '事项', text: '记忆候选',
    sourceRefs: [`session:${driver.agent.id}`, `message:${driver.input!.id}`] } }])
  const other = { id: '外部', session: {}, ctx: {} } as Agent
  const childScope = createScope(driver.scope.ctx, other, { parent: driver.agent })
  Object.assign(other, { ctx: childScope.ctx })
  try {
    assert.equal((await driver.tool('companion_member_remember', { kind: 'project_fact', topic: '事项', text: '不能越权' }, other)).isError, true)
    assert.doesNotMatch(await driver.prompt(other), /仅甲的记忆/)
    const original = { provider: '外部提供方', model: '外部模型', maxTokens: 12 }
    assert.deepEqual(await agentEvents(h.root, other).waterfall('agent/request', { turn: 1, step: 1, signal: driver.controller.signal }, async () => original), original)
    driver.frame({ type: 'start', turn: 1, attemptId: '跨代理', revision: 1, step: 1 }, other)
    assert.equal(h.store.directory.quota(member.assistantId).totalUsed, 0)
  } finally { await childScope.dispose() }
  await complete(driver); await activation.dispose()
  assert.equal(h.root.tools.get('companion_member_remember', driver.agent), undefined, '局部工具随上下文释放')
})

test('能力精确映射，允许工具仍与只读白名单取交集，邮件不绕过原审批', async t => {
  const h = await fixture(t)
  const member = h.store.directory.create(draft('能力成员', { capabilities: ['mail', 'activity', 'reminders'], allowedTools: ['read'] }))
  // 恶意或旧目录数据也不能把白名单外工具带入运行时；仅覆盖 get，其他方法保留真实目录的 this。
  h.options.directory = new Proxy(h.store.directory, { get(target, key) {
    if (key === 'get') return (id: string) => ({ ...target.get(id)!, allowedTools: ['read', 'bash', 'write', 'subagent', 'personal_assistant_list_preferences'] })
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  const { driver, activation } = await h.start(member.assistantId)
  for (const name of ['read', 'personal_assistant_today', 'personal_assistant_get_draft', 'personal_assistant_save_draft', 'companion_create_reminder', 'companion_task_status']) assert.equal((await driver.tool(name)).isError, false, name)
  const mail = await driver.tool('personal_assistant_send_mail')
  assert.match(JSON.stringify(mail), /待本人审批/)
  for (const name of ['bash', 'write', 'subagent', 'personal_assistant_list_preferences', 'personal_assistant_start', 'personal_assistant_delete_activity', 'companion_set_owner']) assert.equal((await driver.tool(name)).isError, true, name)
  await complete(driver); await activation.dispose()
})

test('会议能力只在桌面来源注册工具，并驱动一次性桌面命令', async t => {
  const h = await fixture(t)
  const member = h.store.directory.create(draft('会议成员', { capabilities: ['meeting'] }))
  const first = await h.start(member.assistantId)
  await h.next()
  const started = await first.driver.tool('companion_meeting_start', { name: '周会' })
  assert.equal(started.isError, false)
  assert.deepEqual(h.desktopCalls[0], { command: 'meeting.start', payload: { name: '周会', sources: 'mic+loopback', retentionDays: 30 } })
  const status = await first.driver.tool('companion_meeting_status')
  assert.equal(status.isError, false)
  assert.match(JSON.stringify(status), /meeting.status/)
  await complete(first.driver)
  await first.activation.dispose()

  const second = await h.runtime.start(member.assistantId, [{ type: 'text', text: '邮件来源不能开麦' }], new AbortController().signal, undefined, 'mail')
  const driver = await h.next()
  const denied = await driver.tool('companion_meeting_start', { name: '不该开' })
  assert.equal(denied.isError, true)
  assert.equal(h.desktopCalls.length, 2)
  await complete(driver)
  await second.activation.dispose()
})

test('文档能力只读取授权文档参数，非桌面来源不注册工具', async t => {
  const h = await fixture(t)
  const member = h.store.directory.create(draft('文档成员', { capabilities: ['document'] }))
  const first = await h.start(member.assistantId)
  await h.next()
  const read = await first.driver.tool('companion_document_read', { name: '产品说明', section: 1, maxChars: 2000 })
  assert.equal(read.isError, false)
  assert.deepEqual(h.desktopCalls[0], { command: 'document.read', payload: { name: '产品说明', section: 1, maxChars: 2000 } })
  await complete(first.driver)
  await first.activation.dispose()

  const second = await h.runtime.start(member.assistantId, [{ type: 'text', text: '企业微信来源不能读文档' }], new AbortController().signal, undefined, 'wecom')
  const driver = await h.next()
  assert.equal((await driver.tool('companion_document_read', { name: '产品说明' })).isError, true)
  await complete(driver)
  await second.activation.dispose()
})

test('真实宿主的会话 assistant/message 用量快照会结算，不把已发生用量记未知', async t => {
  const h = await fixture(t)
  const member = h.store.directory.create(draft('会话用量成员'))
  const { driver, activation } = await h.start(member.assistantId)
  await driver.preStep()
  await driver.request()
  driver.startAttempt()
  driver.chunk({ type: 'finish', reason: { kind: 'tool-calls' } })
  driver.endAttempt()
  driver.record('assistant/message', { turn: driver.turn, step: 1, message: { content: [{ type: 'text', text: '调用工具' }] }, usage: usage(30) })
  driver.end('completed', '完成')
  await activation.result
  const quota = h.store.directory.quota(member.assistantId)
  assert.equal(quota.totalUsed, 30)
  assert.equal(quota.unknown, false)
  await activation.dispose()
})

test('邮件能力可只读检查未读；邮件来源和企微来源不能拿这个工具', async t => {
  const h = await fixture(t)
  const member = h.store.directory.create(draft('邮件成员', { capabilities: ['mail'] }))
  const first = await h.start(member.assistantId)
  await h.next()
  const result = await first.driver.tool('companion_mail_unread', { limit: 3 })
  assert.equal(result.isError, false)
  assert.match(JSON.stringify(result), /正文/)
  assert.deepEqual(h.mailReads, [3])
  await complete(first.driver)
  await first.activation.dispose()

  const second = await h.runtime.start(member.assistantId, [{ type: 'text', text: '邮件值守不能调工具' }], new AbortController().signal, undefined, 'mail')
  const driver = await h.next()
  assert.equal((await driver.tool('companion_mail_unread', { limit: 3 })).isError, true)
  await complete(driver)
  await second.activation.dispose()
})

test('每请求覆盖模型与输出上限，usage 快照不累加，重复终止与跨代理帧不重复结账', async t => {
  const h = await fixture(t)
  const member = h.store.directory.create(draft('计量成员', { dailyTokenLimit: 100, totalTokenLimit: 150 }))
  const { driver, activation } = await h.start(member.assistantId)
  assert.deepEqual(await driver.request(), { provider: '成员提供方', model: '成员模型', maxTokens: 80 })
  driver.startAttempt()
  driver.chunk({ type: 'usage', usage: usage(3) })
  driver.finish({ inputTokens: 5, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 15, reasoningTokens: 7, totalTokens: 50 })
  driver.finish(usage(500))
  assert.equal(h.store.directory.quota(member.assistantId).totalUsed, 50)
  assert.equal((await driver.request()).maxTokens, 50)
  driver.startAttempt(); driver.finish(usage(35))
  assert.equal(h.store.directory.requests()[0]?.state, 'pending')
  assert.ok(h.notifications() > 0)
  assert.equal((await driver.request()).maxTokens, 15)
  driver.startAttempt(); driver.finish(usage(25))
  assert.equal(h.store.directory.quota(member.assistantId).totalUsed, 110, '如实记录首输入导致的超线，不伪装硬上限')
  await assert.rejects(driver.request(), /额度/)
  driver.end(); await activation.dispose()
  await assert.rejects(h.start(member.assistantId), /额度/)
})

for (const mode of ['无流', '缺终止', '缺用量', '失败', '无效用量']) {
  test(`${mode}记未知并跨轮阻断，不假装零用量，不允许请求错误钩子重试`, async t => {
    const h = await fixture(t)
    const member = h.store.directory.create(draft('未知成员', { dailyTokenLimit: 0, totalTokenLimit: 0 }))
    const { driver, activation } = await h.start(member.assistantId)
    await driver.request()
    if (mode !== '无流') {
      driver.startAttempt()
      if (mode === '缺终止') { driver.chunk({ type: 'usage', usage: usage(20) }); driver.endAttempt() }
      else driver.finish(mode === '缺用量' ? undefined : mode === '无效用量' ? usage(-1) : usage(20), mode === '失败')
    }
    await assert.rejects(agentEvents(h.root, driver.agent).waterfall('agent/request-error', {
      ...driver.payload(), provider: '测试', failure: { message: '失败', code: 'UNKNOWN' }, retryPolicy: undefined,
    }, async () => ({ kind: 'retry' })), /未知|停止重试/)
    driver.end('error'); await activation.dispose()
    assert.equal(h.store.directory.quota(member.assistantId).unknown, true)
    await assert.rejects(h.start(member.assistantId), /未知/)
  })
}

test('同成员不无界排队，不同成员可并发；signal 取消只影响目标并结算未完用量', async t => {
  const h = await fixture(t)
  const a = h.store.directory.create(draft('取消甲'))
  const b = h.store.directory.create(draft('继续乙'))
  const controller = new AbortController()
  const first = await h.start(a.assistantId, controller.signal)
  await assert.rejects(h.runtime.chat(a.assistantId, '不能混入'), /正在处理/)
  const second = await h.start(b.assistantId)
  await first.driver.request(); first.driver.startAttempt()
  controller.abort('用户取消')
  assert.equal((await first.activation.result).stopReason, 'aborted')
  await first.activation.dispose()
  assert.equal(first.driver.cancelCalls, 1)
  assert.equal(second.driver.cancelCalls, 0)
  assert.equal(h.store.directory.quota(a.assistantId).unknown, true)
  await complete(second.driver); await second.activation.dispose()
  assert.equal(h.runtime.busy(), false)
  h.setEnabled(false)
  await assert.rejects(h.start(b.assistantId), /关闭/)
})

test('释放失败保留成员锁，可重试释放；权限或记忆失效清 session 后不带旧历史', async t => {
  const h = await fixture(t)
  const member = h.store.directory.create(draft('清理成员'))
  const first = await h.start(member.assistantId)
  await complete(first.driver)
  first.driver.failDispose = true
  await assert.rejects(first.activation.dispose(), /释放失败/)
  assert.equal(h.runtime.busy(member.assistantId), true)
  first.driver.failDispose = false
  await first.activation.dispose()
  h.store.directory.setSession(member.assistantId, null)
  h.memories.set(member.assistantId, '新确认的记忆')
  const second = await h.start(member.assistantId)
  assert.notEqual(first.child.id, second.child.id)
  assert.equal(second.driver.events.filter(event => event.type === 'assistant/message').length, 0)
  assert.match(await second.driver.prompt(), /新确认的记忆/)
  await complete(second.driver); await second.activation.dispose()
})

test('真实文件 SQLite 保留成员 session 与用量，重开不重置', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-member-runtime-'))
  const file = path.join(dir, 'team.sqlite')
  const h = await fixture(t, file)
  const member = h.store.directory.create(draft('落库成员'))
  const { driver, activation } = await h.start(member.assistantId)
  await complete(driver, 38); await activation.dispose()
  const reopened = new TeamStore(file)
  try {
    assert.equal(reopened.directory.get(member.assistantId)?.sessionId, driver.agent.id)
    assert.equal(reopened.directory.quota(member.assistantId).totalUsed, 38)
  } finally { reopened.close() }
  t.after(() => rmSync(dir, { recursive: true, force: true }))
})

test('团队接线保留任务账本、通用成员和已保存启用状态，非零旧预算不替代成员额度', async t => {
  const h = await fixture(t)
  const approvals = new ApprovalService(h.store, { ttlMs: 60_000, runtimeEpoch: '成员测试' })
  const team = new TeamService(h.root, h.store, { teamId: '测试团队', provider: '未使用的旧提供方', members: h.runtime,
    maxConcurrentInference: 3, maxConcurrentSideEffect: 1, taskTimeoutMs: 10_000, defaultBudgetTokens: 999,
    seats: [], denyExpertTools: [], approvals, logger: quiet })
  team.ensureRoster()
  const old = h.store.getMember('member-wukong')!
  h.store.upsertMember({ ...old, enabled: false })
  team.ensureRoster()
  assert.equal(h.store.getMember(old.assistantId)?.enabled, false)
  const member = h.store.directory.create(draft('新通用成员', { capabilities: ['mail'] }))
  assert.equal(team.resolveByName(member.assistantId)?.displayName, '新通用成员')
  assert.equal(team.resolveByName('新通用成员')?.assistantId, member.assistantId)
  const task = team.submitTask({ goal: '整理报告', ownerId: member.assistantId })
  const running = team.runTask(task.taskId, {} as Agent, new AbortController().signal)
  const driver = await h.next()
  assert.equal(h.runtime.busy(member.assistantId), true)
  assert.equal((await driver.tool('personal_assistant_send_mail')).isError, false, '旧只读门禁不能阻塞能力工具')
  assert.equal((await driver.tool('write')).isError, true)
  await driver.request(); driver.startAttempt(); driver.finish(usage(9))
  await driver.tool('structured_output', { summary: '已整理', artifacts: ['待核验材料'], blockers: [], needsApproval: [] })
  driver.end()
  const outcome = await running
  assert.equal(outcome?.stopReason, 'completed')
  assert.equal(outcome?.report?.summary, '已整理')
  assert.equal(outcome?.task.status, 'review')
  assert.equal(h.store.listRuns(task.taskId)[0]?.childSessionId, driver.agent.id)
  assert.equal(h.store.directory.quota(member.assistantId).totalUsed, 9)
  assert.equal(h.runtime.busy(), false)
  await team.dispose()
})

test('动态团队提示与工具禁止模型设置额度，不固定成员或要求用户选人', async t => {
  const h = await fixture(t)
  const approvals = new ApprovalService(h.store, { ttlMs: 60_000, runtimeEpoch: '工具测试' })
  const team = new TeamService(h.root, h.store, { teamId: '测试', provider: 'spawn', members: h.runtime,
    maxConcurrentInference: 2, maxConcurrentSideEffect: 1, taskTimeoutMs: 1000, defaultBudgetTokens: 0,
    seats: [], denyExpertTools: [], approvals, logger: quiet })
  team.ensureRoster()
  h.store.directory.create(draft('写作成员', { description: '汇总资料', capabilities: ['activity'] }))
  const definitions = new Map<string, any>()
  const variables = new Map<string, () => string | undefined>()
  let prompt = ''
  const release = registerTeamTools({ tools: { register: (definition: any) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } },
    systemPrompt: { section: section => { prompt = section.text; return () => {} }, variable: (name, value) => { variables.set(name, value); return () => {} } } },
  { team, approvals, bridge: {} as never })
  const assign = definitions.get('desktop_team_assign')
  assert.equal(assign.parameters.properties.budgetTokens, undefined)
  assert.match(prompt, /不要让用户手工挑选/)
  assert.match(variables.get('desktop_team_roster')!()!, /写作成员.*汇总资料.*活动\/日报/)
  const result = await assign.execute({ member: '写作成员', goal: '整理', budgetTokens: 999999 }, { agent: {} })
  assert.match(result, /不能设置或扩大额度/)
  assert.equal(team.listTasks().length, 0)
  release(); await team.dispose()
})

test('增量观察器支持当前输入游标，旧会话文本不重播', async () => {
  const events: Event[] = [{ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '旧' } } }]
  const received = deferred<string>()
  const stop = watchReplyDeltas(() => events, text => received.resolve(text), 1, events.length)
  events.push({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '新' } } })
  const keepAlive = setTimeout(() => received.resolve('超时'), 500)
  try { assert.equal(await received.promise, '新') } finally { clearTimeout(keepAlive); stop() }
})
