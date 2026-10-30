import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AssistantAgentSettings } from '../src/assistant-settings.ts'
import { configureChannelAgent, type ChannelAgentContext } from '../src/channel-agent-settings.ts'

type Listener = (...args: unknown[]) => unknown
type PromptContext = { agent?: Agent }
type Section = { name: string; text: string | ((context: PromptContext) => string) }

/** 同步通知、外围优先 waterfall、局部注册释放；不创建模型或读取任何用户配置。 */
class FakeHost {
  listeners = new Map<string, Listener[]>()
  variables = new Map<string, (context: PromptContext) => string>()
  sections = new Map<string, Section>()
  cancelCalls = 0
  number = 0
  signal = new AbortController().signal
  ctx: ChannelAgentContext
  agent: Agent

  constructor() {
    this.ctx = {
      on: (name: string, listener: Listener, options?: { prepend?: boolean }) => {
        const listeners = this.listeners.get(name) ?? []
        if (options?.prepend) listeners.unshift(listener)
        else listeners.push(listener)
        this.listeners.set(name, listeners)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      },
      systemPrompt: {
        variable: (name: string, provider: (context: PromptContext) => string) => {
          this.variables.set(name, provider)
          return () => this.variables.delete(name)
        },
        section: (section: Section) => {
          this.sections.set(section.name, section)
          return () => this.sections.delete(section.name)
        },
      },
    } as unknown as ChannelAgentContext
    this.agent = { ctx: this.ctx, session: {}, cancel: () => { this.cancelCalls++ } } as unknown as Agent
  }

  emit(name: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(name) ?? []) listener(...args)
  }
  async waterfall(name: string, payload: unknown, next: () => Promise<unknown>): Promise<unknown> {
    const listeners = this.listeners.get(name) ?? []
    const run = (index: number): unknown => listeners[index] ? listeners[index](payload, () => run(index + 1)) : next()
    return run(0)
  }
  configure(read: () => AssistantAgentSettings, defaults: () => { provider: string; model: string } | null = () => null): void {
    configureChannelAgent(this.ctx, read, defaults)
    this.emit('agent/created', { agent: this.agent, source: 'startup' })
  }
  start(number = this.number + 1): void {
    this.number = number
    this.signal = new AbortController().signal
    this.emit('session/event', this.agent.session, { type: 'turn/start', data: { turn: number } })
  }
  payload(step = 1) { return { agent: this.agent, turn: this.number, step, signal: this.signal } }
  preStep(step = 1) {
    return this.waterfall('agent/pre-step', { ...this.payload(step), messages: [] }, async () => ({ kind: 'enter', messages: [], startsRequestSeries: true }))
  }
  async request(config: LlmCallConfig = { provider: '宿主', model: '宿主模型' }): Promise<LlmCallConfig> {
    return await this.waterfall('agent/request', this.payload(), async () => config) as LlmCallConfig
  }
  frame(frame: object): void { this.emit('agent/assistant-stream', { agent: this.agent, frame }) }
  attempt(id: string, revision = 1): void { this.frame({ type: 'start', attemptId: id, revision, turn: this.number, step: 1 }) }
  chunk(id: string, chunk: StreamChunk, revision = 1): void {
    this.frame({ type: 'chunk', attemptId: id, revision, index: 0, time: 1, chunk })
  }
  end(id: string, revision = 1): void {
    this.frame({ type: 'end', attemptId: id, revision, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } })
  }
  finish(id: string, usage?: TokenUsage, reason: 'stop' | 'error' = 'stop'): void {
    if (usage) this.chunk(id, { type: 'usage', usage })
    this.chunk(id, { type: 'finish', reason: reason === 'stop' ? { kind: 'stop' } : { kind: 'error', failure: { message: '测试请求失败', code: 'UNKNOWN' } } })
    this.end(id)
  }
  prompt(agent = this.agent): string {
    const context = { agent }
    return [...this.sections.values()].map(section => {
      const text = typeof section.text === 'string' ? section.text : section.text(context)
      return text.replace(/\{\{([a-z_]+)\}\}/g, (_, name: string) => this.variables.get(name)!(context))
    }).join('\n')
  }
  dispose(): void { this.listeners.clear(); this.variables.clear(); this.sections.clear() }
}

const settings = (patch: Partial<AssistantAgentSettings> = {}): AssistantAgentSettings => ({
  name: '渠道小助手', persona: '只处理企业微信中的日常事务', provider: '独立提供方', model: '独立模型', maxTokens: 80, tokenBudget: 0, ...patch,
})
const usage = (total: number): TokenUsage => ({ inputTokens: total, outputTokens: 0 })

async function assertBlocked(host: FakeHost, pattern = /预算|用量未知/): Promise<void> {
  let downstream = 0
  assert.deepEqual(await host.waterfall('agent/pre-step', { ...host.payload(2), messages: [] }, async () => {
    downstream++
    return { kind: 'enter', messages: [] }
  }), { kind: 'reject' })
  assert.equal(downstream, 0, '拒绝时不能启动下游步骤')
  await assert.rejects(host.request(), pattern)
  await assert.rejects(host.waterfall('agent/request-error', host.payload(), async () => ({ kind: 'retry' })), pattern)
  assert.equal(host.cancelCalls, 0)
}

test('每次请求覆盖独立模型与输出上限，完整保留其他配置和下游步骤决策', async () => {
  const host = new FakeHost()
  host.configure(() => settings())
  host.start()
  const original = Object.freeze({ provider: '默认', model: '默认模型', maxTokens: 999, temperature: 0.2, stop: ['停止'], reasoningEffort: 'low' } as LlmCallConfig)
  assert.deepEqual(await host.preStep(), { kind: 'enter', messages: [], startsRequestSeries: true })
  const result = await host.request(original)
  assert.deepEqual(result, { ...original, provider: '独立提供方', model: '独立模型', maxTokens: 80 })
  assert.equal(original.maxTokens, 999)
  assert.equal(result.stop, original.stop)
  assert.notEqual(result, original)
  host.attempt('第一请求'); host.finish('第一请求', usage(10))
  assert.deepEqual(await host.request({ ...original, maxTokens: 1 }), result)
})

test('首步组装前快照名称职责和全部设置，原对象及默认模型变化仅下轮生效', async () => {
  const host = new FakeHost()
  const value = settings({ provider: '', model: '', tokenBudget: 100 })
  const fallback = { provider: '默认甲', model: '模型甲' }
  let reads = 0
  let defaultReads = 0
  host.configure(() => { reads++; return value }, () => { defaultReads++; return fallback })
  host.start()
  assert.match(host.prompt(), /渠道小助手/)
  Object.assign(value, { name: '新名称', persona: '新职责 {{保留原文}}', maxTokens: 60, tokenBudget: 200 })
  Object.assign(fallback, { provider: '默认乙', model: '模型乙' })
  assert.doesNotMatch(host.prompt(), /新名称|新职责/)
  assert.deepEqual(await host.request(), { provider: '默认甲', model: '模型甲', maxTokens: 80 })
  host.attempt('甲'); host.finish('甲', usage(70))
  await host.preStep(1)
  assert.equal((await host.request()).maxTokens, 30)
  assert.equal(reads, 1)
  assert.equal(defaultReads, 1)
  host.start()
  assert.match(host.prompt(), /新名称/)
  assert.match(host.prompt(), /新职责 \{\{保留原文\}\}/)
  assert.deepEqual(await host.request(), { provider: '默认乙', model: '模型乙', maxTokens: 60 })
  assert.equal(reads, 2)
  assert.equal(defaultReads, 2)
})

test('累计未缓存输入、缓存读写和输出，usage 快照及重复 finish/end 不会双计', async () => {
  const host = new FakeHost()
  host.configure(() => settings({ tokenBudget: 100 }))
  host.start()
  await host.request()
  host.attempt('一')
  host.chunk('一', { type: 'usage', usage: usage(40) })
  host.attempt('一')
  host.finish('一', { inputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 15, outputTokens: 20, reasoningTokens: 7, totalTokens: 50 })
  host.finish('一', usage(50))
  host.attempt('一')
  assert.equal((await host.request()).maxTokens, 50)
  host.attempt('二'); host.finish('二', usage(20), 'error')
  assert.deepEqual(await host.waterfall('agent/request-error', host.payload(), async () => ({ kind: 'retry' })), { kind: 'retry' })
  assert.equal((await host.request()).maxTokens, 30)
  host.attempt('三'); host.finish('三', usage(30))
  await assertBlocked(host, /预算/)
})

test('精确 totalTokens 可涵盖额外用量；首个请求不能预知输入，超预算只阻止续跑', async () => {
  const host = new FakeHost()
  host.configure(() => settings({ tokenBudget: 100 }))
  host.start()
  assert.equal((await host.request()).maxTokens, 80)
  host.attempt('一'); host.finish('一', { inputTokens: 10, outputTokens: 10, totalTokens: 65 })
  assert.equal((await host.request()).maxTokens, 35)
  host.attempt('二'); host.finish('二', usage(200))
  await assertBlocked(host)
})

for (const [name, value] of [
  ['缺失', undefined],
  ['负数', { inputTokens: -1, outputTokens: 5 }],
  ['非数值', { inputTokens: NaN, outputTokens: 5 }],
  ['不安全整数', { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 5 }],
  ['总量小于分项', { inputTokens: 10, outputTokens: 5, totalTokens: 3 }],
] as const) {
  test(`usage ${name}：有预算则禁止后续步骤及同一步重试`, async () => {
    const host = new FakeHost()
    host.configure(() => settings({ tokenBudget: 100 }))
    host.start(); await host.request(); host.attempt('一'); host.finish('一', value)
    await assertBlocked(host, /用量未知/)
    host.start()
    assert.equal((await host.request()).maxTokens, 80, '新轮清除未知用量状态')
  })
}

test('预算为零时，缺失 usage 不妨碍续跑，也不降低下一请求输出上限', async () => {
  const host = new FakeHost()
  host.configure(() => settings())
  host.start(); await host.request(); host.attempt('一'); host.finish('一')
  assert.equal((await host.preStep(2) as { kind: string }).kind, 'enter')
  assert.equal((await host.request()).maxTokens, 80)
})

test('请求已准备但没有流、流异常或没有 finish：用量未知禁止续跑', async () => {
  for (const mode of ['无流', '异常', '缺少终止分片']) {
    const host = new FakeHost()
    host.configure(() => settings({ tokenBudget: 100 }))
    host.start(); await host.request()
    if (mode !== '无流') {
      host.attempt('一')
      host.chunk('一', { type: 'usage', usage: usage(20) })
      if (mode === '异常') host.emit('agent/error', { ...host.payload(), error: new Error('测试异常') })
      host.frame({ type: 'end', attemptId: '一', revision: 1, index: 1, outcome: { kind: 'abandoned' } })
    }
    await assertBlocked(host, /用量未知/)
  }
})

test('成功最终文本拿到后即使触线或用量未知，也不取消或篡改 completed 结算', async () => {
  for (const amount of [undefined, usage(100)]) {
    const host = new FakeHost()
    host.configure(() => settings({ tokenBudget: 100 }))
    host.start(); await host.request(); host.attempt('一')
    const text = Object.freeze({ type: 'text-delta', index: 0, text: '已处理完成' } as const)
    host.chunk('一', text)
    host.finish('一', amount)
    const ending = Object.freeze({ type: 'turn/end', data: Object.freeze({ turn: 1, reason: Object.freeze({ kind: 'completed' }) }) })
    host.emit('session/event', host.agent.session, ending)
    assert.equal(ending.data.reason.kind, 'completed')
    assert.equal(text.text, '已处理完成')
    assert.equal(host.cancelCalls, 0)
    host.start(); assert.equal((await host.request()).maxTokens, 80)
  }
})

test('异常后新轮重置：上一轮的迟到流、结束和错误均不污染下一轮', async () => {
  const host = new FakeHost()
  host.configure(() => settings({ tokenBudget: 100 }))
  host.start(); await host.request(); host.attempt('旧')
  host.start(); await host.request(); host.attempt('新')
  host.frame({ type: 'start', attemptId: '旧二', revision: 9, turn: 1, step: 1 })
  host.finish('旧', usage(999))
  host.chunk('新', { type: 'usage', usage: usage(999) }, 2)
  host.emit('agent/error', { ...host.payload(), turn: 1, error: new Error('旧错误') })
  host.emit('session/event', host.agent.session, { type: 'turn/end', data: { turn: 1 } })
  host.finish('新', usage(30))
  assert.equal((await host.request()).maxTokens, 70)
})

test('局部配置不接管其他 agent 或其子 agent，独立渠道之间不共享计量', async () => {
  const first = new FakeHost()
  const second = new FakeHost()
  first.configure(() => settings({ name: '甲', tokenBudget: 100 }))
  second.configure(() => settings({ name: '乙', tokenBudget: 200 }))
  first.start(); second.start()
  const config = { provider: '其他提供方', model: '其他模型', maxTokens: 999 }
  assert.equal(await first.waterfall('agent/request', second.payload(), async () => config), config)
  first.emit('agent/created', { agent: second.agent, source: 'startup' })
  first.emit('session/event', second.agent.session, { type: 'turn/start', data: { turn: 99 } })
  first.emit('agent/assistant-stream', { agent: second.agent, frame: { type: 'start', attemptId: '别人的', turn: 1, step: 1, revision: 1 } })
  assert.equal(first.prompt(second.agent), '')
  assert.match(first.prompt(), /名称：甲/)
  assert.match(second.prompt(), /名称：乙/)
  await first.request(); first.attempt('一'); first.finish('一', usage(100))
  await assertBlocked(first)
  assert.equal((await second.request()).maxTokens, 80)
  second.attempt('一'); second.finish('一', usage(150))
  assert.equal((await second.request()).maxTokens, 50)
  first.dispose()
  first.start()
  assert.equal(first.prompt(), '')
  assert.equal(first.listeners.size, 0)
})

test('没有系统提示词服务或默认模型时明确失败，不静默使用上一轮独立模型', async () => {
  assert.throws(() => configureChannelAgent({ on() {} } as unknown as ChannelAgentContext, () => settings(), () => null), /系统提示词/)
  const host = new FakeHost()
  const value = settings()
  host.configure(() => value)
  host.start(); await host.request(); host.attempt('一'); host.finish('一', usage(1))
  Object.assign(value, { provider: '', model: '' })
  host.start()
  assert.throws(() => host.prompt(), /默认模型不可用/)
  await assert.rejects(host.preStep(), /默认模型不可用/)
  await assert.rejects(host.request(), /默认模型不可用/)
})

test('读取设置失败不会在同一轮重新读取，新轮可恢复；迟到请求不能进入新轮', async () => {
  const host = new FakeHost()
  let reads = 0
  host.configure(() => { if (++reads === 1) throw new Error('设置暂不可用'); return settings() })
  host.start()
  await assert.rejects(host.request(), /设置暂不可用/)
  await assert.rejects(host.preStep(), /设置暂不可用/)
  assert.equal(reads, 1)
  host.start()
  let release!: (value: LlmCallConfig) => void
  const waiting = host.waterfall('agent/request', host.payload(), () => new Promise<LlmCallConfig>(resolve => { release = resolve }))
  host.start()
  release({ provider: '原提供方', model: '原模型' })
  await assert.rejects(waiting, /轮次已结束/)
  assert.equal((await host.request()).maxTokens, 80)
})

test('真实 SDK 的系统提示词注册、变量插值、作用域和释放，无模型调用', async t => {
  const require = createRequire(import.meta.url)
  const sdkRequire = createRequire(require.resolve('@deepseek-ai/dsh-agent'))
  const { default: SystemPrompt, renderPrompt } = await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-system-prompt')).href)
  const { createScope, scopeTarget } = await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-scope')).href)
  const root = new Context()
  const promptPlugin = root.plugin(SystemPrompt, { personaPrefix: '共享基础提示词' })
  await promptPlugin
  t.after(() => promptPlugin.dispose())
  const key = { session: {} } as Agent
  let scope!: { ctx: Context; dispose(): Promise<void> }
  const ownerPlugin = root.plugin(Object.assign((ctx: Context) => { scope = createScope(ctx, key) }, { inject: ['systemPrompt'] }))
  await ownerPlugin
  t.after(() => ownerPlugin.dispose())
  t.after(() => scope.dispose())
  Object.assign(key, { ctx: scope.ctx })
  configureChannelAgent(scope.ctx, () => settings({ persona: '职责保留 {{字面量}}' }), () => null)
  await agentEvents(root, key).serial('agent/created', { source: 'startup' })
  root.emit(scopeTarget(key.session, key), 'session/event', key.session, { type: 'turn/start', data: { turn: 1 } })
  const assembly = await root.systemPrompt.assemble(assembleContextFor(key, new AbortController().signal))
  assert.match(renderPrompt(assembly), /名称：渠道小助手/)
  assert.match(renderPrompt(assembly), /职责保留 \{\{字面量\}\}/)
  assert.match(renderPrompt(assembly), /共享基础提示词/)
  const other = { ctx: {}, session: {} } as Agent
  assert.doesNotMatch(renderPrompt(await root.systemPrompt.assemble(assembleContextFor(other))), /渠道小助手/)
  const child = { ctx: {}, session: {} } as Agent
  const childScope = createScope(scope.ctx, child, { parent: key })
  Object.assign(child, { ctx: childScope.ctx })
  t.after(() => childScope.dispose())
  assert.doesNotMatch(renderPrompt(await root.systemPrompt.assemble(assembleContextFor(child))), /渠道小助手/)
  const original = { provider: '原提供方', model: '原模型', maxTokens: 999 }
  const payload = { turn: 1, step: 1, signal: new AbortController().signal }
  assert.equal((await agentEvents(root, key).waterfall('agent/request', payload, async () => original)).provider, '独立提供方')
  assert.equal(await agentEvents(root, child).waterfall('agent/request', payload, async () => original), original)
  await scope.dispose()
  assert.doesNotMatch(renderPrompt(await root.systemPrompt.assemble(assembleContextFor(key))), /渠道小助手/)
  assert.equal(await agentEvents(root, key).waterfall('agent/request', payload, async () => original), original, '作用域销毁同时解除请求监听器')
})
