import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { SessionBridge, type BridgeAgent, type BridgeEvent } from '../src/bridge.ts'
import { SessionMirror, SessionProjection, type MirrorEvent } from '../src/session-mirror.ts'
import type { SessionResult, SessionUpdate } from '../../dsh-pet/src/session-types.ts'

function nativeAgent(id = 'session-a') {
  const events: MirrorEvent[] = []
  const calls: Array<{ method: string; value: unknown }> = []
  const state = { permission: 'ask', commandError: '', modelError: '', cancelError: '', models: 0, cancel: 0, inbox: ['queued'] }
  const append = (type: string, data: Record<string, unknown>) => events.push({ type, data, seq: events.length })
  const agent = { id, status: 'idle', session: { id, events, snapshotEvents: () => events }, options: { provider: 'native', model: 'm1' },
    followup(value: unknown) {
      const message = value as { id: string; content: unknown; source: unknown }
      calls.push({ method: 'prompt', value: message })
      agent.status = 'running'
      append('turn/start', { turn: 1 })
      append('user/message', { id: message.id, content: message.content, source: message.source })
    },
    cancel(cause: unknown, options?: { keepInbox?: boolean }) {
      calls.push({ method: 'cancel', value: { cause, options } })
      if (state.cancelError) throw new Error(state.cancelError)
      state.cancel += 1
      if (!options?.keepInbox) state.inbox.length = 0
    },
    ctx: undefined as BridgeAgent['ctx'],
  }
  const llm = {
    listProviders: () => [{ id: 'native', name: '原生' }],
    async listModels(_provider: string) {
      state.models += 1
      if (state.modelError) throw new Error(state.modelError)
      return [{ id: 'm1', name: '模型一' }, { id: 'm2', name: '模型二' }]
    },
  }
  const commands = {
    find: (_agent: BridgeAgent, name: string) => name === 'permission' ? {} : undefined,
    async execute(target: BridgeAgent, line: string, images: unknown[], signal: AbortSignal) {
      assert.equal(target, agent); assert.deepEqual(images, []); assert.equal(signal.aborted, false)
      calls.push({ method: 'command', value: line })
      if (state.commandError) return { result: { kind: 'error', text: state.commandError } }
      if (!line.startsWith('/permission ')) return undefined
      state.permission = line.slice('/permission '.length)
      append('permission/preset', { preset: state.permission })
      return { result: { kind: 'success', text: state.permission } }
    },
  }
  const services: Record<string, unknown> = {
    llm,
    permissionPresets: { names: ['ask', 'full'], optionOf: (value: string) => ({ value, name: value === 'ask' ? '询问' : '完全访问' }), current: () => state.permission },
    sessionProjections: { snapshot: () => ({ values: { permissions: { currentValue: state.permission, options: [{ value: 'ask', name: '询问' }, { value: 'full', name: '完全访问' }] } } }) },
    commands,
  }
  agent.ctx = { get: name => services[name] }
  return { agent, append, state, llm, commands, services, calls }
}

async function fixture(t: TestContext, native = nativeAgent()) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-session-mirror-'))
  const events: BridgeEvent[] = []
  const bridge = new SessionBridge({ dshHome: home, onEvent: event => events.push(event) })
  t.after(async () => { await bridge.dispose(); rmSync(home, { recursive: true, force: true }) })
  await bridge.bind(native.agent)
  const info = JSON.parse(readFileSync(path.join(home, 'personal-assistant', 'bridge.json'), 'utf8')) as { port: number; token: string }
  const url = `http://127.0.0.1:${info.port}`
  const result = await bridge.getSession()
  assert.equal(result.ok, true)
  return { bridge, events, info, url, bindingId: result.state!.bindingId, ...native }
}

function updates(events: BridgeEvent[]): SessionUpdate[] {
  return events.filter(event => event.type === 'session/update').map(event => event.payload as SessionUpdate)
}

function turn(append: ReturnType<typeof nativeAgent>['append'], n: number, body: string) {
  append('turn/start', { turn: n })
  append('user/message', { id: `u${n}`, content: [{ type: 'text', text: `问题${n}` }], source: { kind: 'user' } })
  append('assistant/message', { turn: n, step: 1, message: { id: `a${n}`, content: [{ type: 'reasoning', text: '可见思考' }, { type: 'text', text: body }] } })
  append('turn/end', { turn: n, reason: { kind: 'completed' } })
}

test('当前宿主取消当前轮次时保留其他已排队输入', async () => {
  const inbox = ['网页已有委托']
  const calls: unknown[] = []
  const agent = { id: 'isolated-agent', status: 'running', session: { id: 'isolated-agent', events: [] }, followup() {},
    cancel(cause: unknown, options?: { keepInbox?: boolean }) {
      calls.push({ cause, options })
      if (!options?.keepInbox) inbox.length = 0
    } } as BridgeAgent
  const mirror = new SessionMirror(agent, () => {})
  try {
    const result = await mirror.command({ kind: 'cancel', bindingId: mirror.bindingId }, () => {})
    assert.equal(result.ok, true)
    assert.deepEqual(inbox, ['网页已有委托'])
    assert.deepEqual(calls, [{ cause: { kind: 'user' }, options: { keepInbox: true } }])
  } finally { mirror.close() }
})

test('宿主不能从宠物侧切换模型时不能宣称选择能力可用', async () => {
  const agent = { id: 'isolated-agent', status: 'idle', session: { id: 'isolated-agent', events: [] }, followup() {},
    options: { provider: '测试提供方', model: '模型甲' }, ctx: { get: (name: string) => name === 'llm'
      ? { listProviders: () => [{ id: '测试提供方' }], listModels: async () => [{ id: '模型甲', name: '模型甲' }] } : undefined } } as BridgeAgent
  const mirror = new SessionMirror(agent, () => {})
  try {
    const state = (await mirror.snapshot(undefined, undefined, () => {})).state!
    assert.equal(state.capabilities.models, false)
    assert.equal(state.model?.model, '模型甲')
    const result = await mirror.command({ kind: 'model', bindingId: mirror.bindingId, provider: '测试提供方', model: '模型乙' }, () => {})
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /不支持.*切换/u)
  } finally { mirror.close() }
})

test('模型目录异常明确提示，不能丢失已知当前模型或泄露异常细节', async () => {
  const agent = { id: 'isolated-agent', status: 'idle', session: { id: 'isolated-agent', events: [] }, followup() {},
    options: { provider: '测试提供方', model: '模型甲' }, ctx: { get: (name: string) => name === 'llm'
      ? { listProviders: () => [{ id: '测试提供方' }], listModels: async () => { throw new Error('隔离凭据细节') } } : undefined } } as BridgeAgent
  const mirror = new SessionMirror(agent, () => {})
  try {
    const state = (await mirror.snapshot(undefined, undefined, () => {})).state!
    assert.match(state.error ?? '', /模型目录.*失败/u)
    assert.equal(state.model?.model, '模型甲')
    assert.doesNotMatch(state.error ?? '', /隔离凭据细节/u)
  } finally { mirror.close() }
})

test('一个提供方的模型目录失败时保留其他提供方并显示部分失败', async () => {
  const agent = { id: 'isolated-agent', status: 'idle', session: { id: 'isolated-agent', events: [] }, followup() {},
    options: { provider: '正常提供方', model: '模型甲' }, ctx: { get: (name: string) => name === 'llm'
      ? { listProviders: () => [{ id: '正常提供方' }, { id: '异常提供方' }], listModels: async (provider: string) => {
        if (provider === '异常提供方') throw new Error('隔离凭据细节')
        return [{ id: '模型甲', name: '可用模型' }]
      } } : undefined } } as BridgeAgent
  const mirror = new SessionMirror(agent, () => {})
  try {
    const state = (await mirror.snapshot(undefined, undefined, () => {})).state!
    assert.deepEqual(state.models, [{ provider: '正常提供方', model: '模型甲', label: '可用模型' }])
    assert.equal(state.model?.label, '可用模型')
    assert.match(state.error ?? '', /部分模型目录读取失败/u)
    assert.doesNotMatch(state.error ?? '', /隔离凭据细节/u)
  } finally { mirror.close() }
})

test('一条回复跨越历史页事件边界时，最近页仍显示完整回复', async () => {
  const events: MirrorEvent[] = []
  const append = (type: string, data: Record<string, unknown>) => events.push({ type, data, seq: events.length })
  append('turn/start', { turn: 1 })
  append('user/message', { id: 'user-1', content: [{ type: 'text', text: '隔离提问' }], source: { kind: 'user' } })
  append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: '部分' } })
  for (let i = 0; i < 55; i++) append('testing/other', { index: i })
  append('assistant/message', { turn: 1, step: 1, message: { id: 'reply-1', content: [{ type: 'text', text: '完整回复' }] } })
  append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const agent = { id: 'isolated-agent', status: 'idle', session: { id: 'isolated-agent', events }, followup() {} } as BridgeAgent
  const mirror = new SessionMirror(agent, () => {})
  events.forEach((event, index) => mirror.observe(event, index))
  try {
    const state = (await mirror.snapshot(undefined, undefined, () => {})).state!
    assert.ok(state.entries.some(entry => entry.text === '完整回复' && entry.streaming === false))
  } finally { mirror.close() }
})

test('历史分页不拆分同一事件的正文与思考，也不重复或漏掉条目', async () => {
  const events: MirrorEvent[] = []
  const append = (type: string, data: Record<string, unknown>) => events.push({ type, data, seq: events.length })
  for (let i = 0; i < 3; i++) append('user/message', { id: `early-${i}`, content: [{ type: 'text', text: `早${i}` }] })
  append('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '正文' }] } })
  for (let i = 0; i < 49; i++) append('user/message', { id: `late-${i}`, content: [{ type: 'text', text: `晚${i}` }] })
  const agent = { id: 'isolated-agent', status: 'idle', session: { id: 'isolated-agent', events }, followup() {} } as BridgeAgent
  const mirror = new SessionMirror(agent, () => {})
  events.forEach((event, index) => mirror.observe(event, index))
  try {
    const latest = (await mirror.snapshot(undefined, undefined, () => {})).state!
    assert.equal(latest.hasMore, true)
    assert.equal(latest.beforeSeq, 3)
    assert.ok(latest.entries.some(entry => entry.text === '思考'))
    assert.ok(latest.entries.some(entry => entry.text === '正文'))
    const older = (await mirror.snapshot(latest.beforeSeq, mirror.bindingId, () => {})).state!
    assert.equal(older.hasMore, false)
    assert.equal(older.entries.length + latest.entries.length, 54)
    assert.equal(new Set([...older.entries, ...latest.entries].map(entry => entry.id)).size, 54)
  } finally { mirror.close() }
})

test('快照包含无 chunk 的完成消息、思考、用户输入，最近页和旧页不重叠', async t => {
  const native = nativeAgent()
  turn(native.append, 1, '较早回复')
  for (let i = 0; i < 47; i++) native.append('user/message', { id: `middle-${i}`, content: [{ type: 'text', text: `中间${i}` }], source: { kind: 'user' } })
  turn(native.append, 2, '最新回复')
  const f = await fixture(t, native)
  const latest = (await f.bridge.getSession()).state!
  assert.equal(latest.hasMore, true)
  assert.equal(latest.beforeSeq, 4)
  assert.deepEqual(latest.entries.slice(-3).map(entry => entry.text), ['问题2', '可见思考', '最新回复'])
  assert.ok(latest.entries.slice(-3).every(entry => entry.turn === 2 && entry.streaming === false))
  const older = (await f.bridge.getSession(latest.beforeSeq, f.bindingId)).state!
  assert.equal(older.hasMore, false)
  assert.deepEqual(older.entries.map(entry => entry.text), ['问题1', '可见思考', '较早回复'])
  assert.equal(new Set([...latest.entries, ...older.entries].map(entry => entry.id)).size, 53)
  assert.equal((await f.bridge.getSession(4)).ok, false)
})

test('增量只发送改变的完整条目，工具结果按 callId 更新，轮次结束关闭 streaming', async t => {
  const f = await fixture(t)
  f.append('turn/start', { turn: 1 })
  f.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '甲' } })
  f.bridge.onAgentStatus(f.agent, 'running')
  const first = updates(f.events).at(-1)!
  assert.equal(first.entries[0].text, '甲')
  const id = first.entries[0].id
  const seq = first.entries[0].seq
  f.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '乙' } })
  f.bridge.onAgentStatus(f.agent, 'running')
  const next = updates(f.events).at(-1)!
  assert.equal(next.reset, undefined)
  assert.equal(next.entries.length, 1)
  assert.deepEqual(next.entries[0], { id, seq, turn: 1, role: 'assistant', kind: 'text', text: '甲乙', streaming: true })
  f.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'Read', arguments: '{"path":"a"}' })
  f.bridge.onAgentStatus(f.agent, 'running')
  const tool = updates(f.events).at(-1)!.entries[0]
  f.append('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '结果' }], isError: true }] } })
  f.append('turn/end', { turn: 1, reason: { kind: 'aborted' } })
  f.bridge.onAgentStatus(f.agent, 'idle')
  const end = updates(f.events).at(-1)!
  assert.equal(end.status, 'idle')
  assert.ok(end.entries.every(entry => !entry.streaming))
  assert.equal(end.entries.find(entry => entry.id === tool.id)?.result, '结果')
  assert.equal(end.entries.find(entry => entry.id === tool.id)?.status, 'error')
  const count = updates(f.events).length
  f.bridge.onAgentStatus(f.agent, 'idle')
  assert.equal(updates(f.events).length, count)
  f.append('turn/start', { turn: 2 })
  f.append('assistant/chunk', { turn: 2, step: 1, chunk: { type: 'text-delta', text: '新轮次' } })
  f.bridge.onAgentStatus(f.agent, 'running')
  assert.notEqual(updates(f.events).at(-1)!.entries[0].id, id)
  assert.equal(updates(f.events).at(-1)!.entries[0].text, '新轮次')
})

test('完成消息覆盖已有 chunk，保留稳定身份和序号', () => {
  const projection = new SessionProjection()
  projection.apply({ type: 'assistant/chunk', seq: 10, data: { turn: 3, step: 1, chunk: { type: 'text-delta', text: '部分' } } }, 10)
  const first = projection.values()[0]
  projection.apply({ type: 'assistant/message', seq: 11, data: { turn: 3, step: 1, message: { id: 'done', content: [{ type: 'text', text: '完整正文' }] } } }, 11)
  assert.deepEqual(projection.values(), [{ ...first, text: '完整正文', streaming: false }])
  projection.drain()
  projection.apply({ type: 'assistant/message', seq: 11, data: { turn: 3, step: 1, message: { id: 'done', content: [{ type: 'text', text: '完整正文' }] } } }, 11)
  assert.deepEqual(projection.drain(), [])
})

test('原生 followup/cancel 使用当前宿主接口，运行态以宿主为准，保留排队输入', async t => {
  const f = await fixture(t)
  assert.equal((await f.bridge.sessionCommand({ kind: 'prompt', bindingId: f.bindingId, text: '原生输入' })).ok, true)
  const prompt = f.calls.find(call => call.method === 'prompt')!.value as { id: string; content: unknown; source: { kind: string } }
  assert.ok(prompt.id)
  assert.equal(prompt.source.kind, 'user')
  assert.deepEqual(prompt.content, [{ type: 'text', text: '原生输入' }])
  f.bridge.onAgentStatus(f.agent, 'running')
  assert.equal((await f.bridge.getSession()).state!.status, 'running')
  assert.equal((await f.bridge.sessionCommand({ kind: 'cancel', bindingId: f.bindingId })).ok, true)
  assert.equal(f.state.cancel, 1)
  assert.deepEqual(f.calls.find(call => call.method === 'cancel')!.value, { cause: { kind: 'user' }, options: { keepInbox: true } })
  assert.deepEqual(f.state.inbox, ['queued'])
  assert.equal((await f.bridge.getSession()).state!.status, 'running')
  f.bridge.onAgentStatus(f.agent, 'idle')
  assert.equal((await f.bridge.getSession()).state!.status, 'idle')
  assert.equal((await f.bridge.sessionCommand({ kind: 'prompt', bindingId: f.bindingId, text: '朗读', spoken: true })).ok, false)
  assert.equal(f.calls.filter(call => call.method === 'prompt').length, 1)
})

test('模型切换不支持时如实拒绝；权限走原生命令且错误不乐观修改', async t => {
  const f = await fixture(t)
  assert.equal((await f.bridge.getSession()).state!.capabilities.models, false)
  assert.match((await f.bridge.sessionCommand({ kind: 'model', bindingId: f.bindingId, provider: 'native', model: 'm2' })).error!, /不支持.*切换/)
  assert.equal((await f.bridge.getSession()).state!.model!.model, 'm1')
  assert.equal(f.agent.options.model, 'm1', '未支持的切换不能改动宿主当前模型')
  assert.equal((await f.bridge.sessionCommand({ kind: 'permission', bindingId: f.bindingId, value: 'unknown' })).ok, false)
  f.state.commandError = '权限被拒绝'
  assert.match((await f.bridge.sessionCommand({ kind: 'permission', bindingId: f.bindingId, value: 'full' })).error!, /权限被拒绝/)
  assert.equal((await f.bridge.getSession()).state!.permission, 'ask')
  f.state.commandError = ''
  assert.equal((await f.bridge.sessionCommand({ kind: 'permission', bindingId: f.bindingId, value: 'full' })).ok, true)
  assert.equal((await f.bridge.getSession()).state!.permission, 'full')
  assert.equal(f.calls.filter(call => call.method === 'prompt').length, 0)
  assert.equal(f.calls.filter(call => call.method === 'command').length, 2)
  assert.equal((await f.bridge.sessionCommand({ kind: 'prompt', bindingId: f.bindingId, text: '/unknown' })).ok, false)
})

test('模型目录缓存避免每拍查询，缓存过期后可看到原生端选择', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 20; i += 1) f.bridge.onAgentStatus(f.agent, i % 2 ? 'idle' : 'running')
  await f.bridge.getSession()
  assert.equal(f.state.models, 1)
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + 6_000)
  f.agent.options.model = 'm2'
  assert.equal((await f.bridge.getSession()).state!.model!.model, 'm2')
  assert.equal(f.state.models, 2)
})

test('绑定切换隔离迟到模型目录与历史查询，定时器扫描新 agent', async t => {
  const f = await fixture(t)
  let release: ((value: Array<{ id: string; name: string }>) => void) | undefined
  f.llm.listModels = async () => new Promise(resolve => { release = resolve })
  f.append('request/header', { header: { config: { provider: 'native', model: 'm1' } } })
  f.bridge.onAgentStatus(f.agent, 'running')
  assert.ok(release, '应实际进入旧会话的异步模型目录查询')
  const late = f.bridge.getSession(3, f.bindingId)
  const next = nativeAgent('session-b')
  await f.bridge.bind(next.agent)
  const state = (await f.bridge.getSession()).state!
  assert.notEqual(state.bindingId, f.bindingId)
  assert.deepEqual(state.entries, [])
  release([{ id: 'late', name: '旧模型' }])
  assert.equal((await late).ok, false)
  assert.equal((await f.bridge.sessionCommand({ kind: 'cancel', bindingId: f.bindingId })).ok, false)
  next.append('turn/start', { turn: 1 })
  next.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: '新 agent 内容' } })
  f.append('assistant/chunk', { turn: 99, step: 1, chunk: { type: 'text-delta', text: '旧 agent 内容' } })
  await new Promise(resolve => setTimeout(resolve, 200))
  const entry = updates(f.events).filter(update => update.bindingId === state.bindingId).flatMap(update => update.entries)
  assert.ok(entry.some(item => item.text === '新 agent 内容'))
  assert.ok(entry.every(item => item.text !== '旧 agent 内容'))
  assert.equal(updates(f.events).filter(update => update.bindingId === state.bindingId && update.reset).length, 1)
  await f.bridge.bind(next.agent)
  assert.equal((await f.bridge.getSession()).state!.bindingId, state.bindingId)
})

test('换绑期间原生权限操作的迟到成功不能污染新会话', async t => {
  const f = await fixture(t)
  let release: (() => void) | undefined
  t.mock.method(f.commands, 'execute', async () => new Promise(resolve => {
    release = () => resolve({ result: { kind: 'success', text: 'full' } })
  }))
  const pending = f.bridge.sessionCommand({ kind: 'permission', bindingId: f.bindingId, value: 'full' })
  assert.ok(release, '必须实际进入旧会话的权限命令')
  const next = nativeAgent('new-session')
  await f.bridge.bind(next.agent)
  release()
  assert.equal((await pending).ok, false)
  const state = (await f.bridge.getSession()).state!
  assert.equal(state.sessionId, 'new-session')
  assert.equal(state.model!.model, 'm1')
  assert.equal(state.permission, 'ask')
})

test('宿主取消异常不能冒充成功，模型查询错误可见且缓存', async t => {
  const f = await fixture(t)
  f.state.cancelError = '隔离停止失败'
  assert.match((await f.bridge.sessionCommand({ kind: 'cancel', bindingId: f.bindingId })).error!, /隔离停止失败/)
  assert.deepEqual(f.state.inbox, ['queued'])
  f.state.modelError = '内部凭据细节'
  f.append('request/header', { header: { config: { provider: 'native', model: 'm1' } } })
  f.bridge.onAgentStatus(f.agent, 'running')
  const state = (await f.bridge.getSession()).state!
  assert.match(state.error!, /模型目录.*失败/)
  assert.doesNotMatch(state.error!, /内部凭据细节/)
  assert.equal(state.model!.model, 'm1')
  const queries = f.state.models
  await f.bridge.getSession()
  assert.equal(f.state.models, queries, '失败结果也应短暂缓存，不能每次刷屏重试')
})

test('缺少宿主服务时能力为 false，不伪造 idle 或执行成功', async t => {
  const f = await fixture(t)
  const minimal: BridgeAgent = { session: { events: [] }, followup() {} }
  await f.bridge.bind(minimal)
  const state = (await f.bridge.getSession()).state!
  assert.equal(state.sessionId, null)
  assert.equal(state.status, 'disconnected')
  assert.ok(Object.values(state.capabilities).every(value => value === false))
  assert.equal((await f.bridge.sessionCommand({ kind: 'cancel', bindingId: state.bindingId })).ok, false)
  await f.bridge.bind(f.agent)
  delete f.services.commands
  assert.equal((await f.bridge.getSession()).state!.capabilities.permissions, false)
})

test('HTTP 会话沿用聊天鉴权，历史绑定校验和 ring 缺口保留 events/epoch', async t => {
  const f = await fixture(t)
  const unauthorized = await fetch(`${f.url}/session`)
  assert.equal(unauthorized.status, 401)
  assert.equal((await unauthorized.json() as SessionResult).ok, false)
  const url = `${f.url}/session?token=${f.info.token}`
  const get = await fetch(url)
  assert.equal((await get.json() as SessionResult).ok, true)
  const old = await fetch(`${url}&beforeSeq=1&bindingId=wrong`)
  assert.equal((await old.json() as SessionResult).ok, false)
  const command = await fetch(url, { method: 'POST', body: JSON.stringify({ kind: 'cancel', bindingId: f.bindingId }) })
  assert.equal((await command.json() as SessionResult).ok, true)
  const oldVoice = await fetch(`${f.url}/chat?token=${f.info.token}`, {
    method: 'POST', body: JSON.stringify({ text: '语音输入', bindingId: 'retired-binding' }),
  })
  assert.equal(oldVoice.status, 409)
  assert.equal((await oldVoice.json() as { error: string }).error, 'stale binding')
  for (let i = 0; i < 520; i += 1) f.bridge.notifyApprovalSnapshot()
  const events = await fetch(`${f.url}/events?token=${f.info.token}&since=0`)
  const body = await events.json() as { reset: boolean; epoch: string; events: BridgeEvent[] }
  assert.equal(body.reset, true)
  assert.equal(body.epoch, f.bridge.epoch)
  assert.equal(body.events.length, 512)
  const continuous = await fetch(`${f.url}/events?token=${f.info.token}&since=${body.events[0].seq - 1}`)
  assert.equal((await continuous.json() as { reset?: boolean }).reset, undefined)
})
