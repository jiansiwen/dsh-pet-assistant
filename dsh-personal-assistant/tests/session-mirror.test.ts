import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { SessionBridge, type BridgeAgent, type BridgeEvent } from '../src/bridge.ts'
import { SessionProjection, type MirrorEvent } from '../src/session-mirror.ts'
import type { SessionResult, SessionUpdate } from '../../dsh-pet/src/session-types.ts'

type Request = { rpcId: string; payload: Record<string, unknown> }
const success = (request: Request, value: unknown) => ({ rpcId: request.rpcId, result: { ok: true, value } })
const failure = (request: Request, message: string) => ({ rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message, details: {} } } })

function nativeAgent(id = 'session-a') {
  const events: MirrorEvent[] = []
  const calls: Array<{ method: string; request: Request }> = []
  const state = { permission: 'ask', model: 'm1', commandError: '', modelError: '', models: 0, cancel: 0, inbox: ['queued'], pageStart: 0 }
  const agent: BridgeAgent = { id, status: 'idle', session: { id, events }, followup() { throw new Error('普通输入不得直接 followup') } }
  const append = (type: string, data: Record<string, unknown>) => events.push({ type, data, seq: events.length })
  const sessions = {
    async history(request: Request): Promise<unknown> {
      calls.push({ method: 'history', request })
      const before = request.payload.beforeSeq as number | undefined
      const page = before === undefined ? events.slice(state.pageStart) : events.filter(event => event.seq! < before)
      return success(request, { events: page.map(event => ({ event })), hasMore: before === undefined && state.pageStart > 0,
        projections: { asOfSeq: events.length - 1, values: { permissions: { currentValue: state.permission, options: [{ value: 'ask', name: '询问' }] } } } })
    },
    async models(request: Request) {
      state.models += 1
      return success(request, { current: { provider: 'native', model: state.model }, routable: true,
        groups: [{ id: 'native', name: '原生', models: [{ id: 'm1', name: '模型一' }, { id: 'm2', name: '模型二' }] }], failures: [] })
    },
    async selectModel(request: Request) {
      calls.push({ method: 'selectModel', request })
      if (state.modelError) return failure(request, state.modelError)
      state.model = String(request.payload.model)
      return success(request, { selected: { provider: request.payload.provider, model: state.model, reasoningEffort: request.payload.reasoningEffort } })
    },
    async prompt(request: Request) {
      calls.push({ method: 'prompt', request })
      agent.status = 'running'
      append('turn/start', { turn: 1 })
      append('user/message', { id: 'native-user', content: request.payload.content, source: { kind: 'user', rpcId: request.rpcId } })
      return success(request, { accepted: true })
    },
    async cancel(request: Request) {
      calls.push({ method: 'cancel', request })
      state.cancel += 1
      // 与安装实现一致：取消在途轮次，不清空待处理收件箱，也不假装已经 idle。
      return success(request, { accepted: true })
    },
  }
  const services: Record<string, unknown> = {
    apiProxy: { sessions },
    permissionPresets: { names: ['ask', 'full'], optionOf: (value: string) => ({ value, name: value === 'ask' ? '询问' : '完全访问' }), current: () => state.permission },
    sessionProjections: { snapshot: () => ({ values: { permissions: { currentValue: state.permission, options: [{ value: 'ask', name: '询问' }, { value: 'full', name: '完全访问' }] } } }) },
    commands: {
      find: (_agent: BridgeAgent, name: string) => name === 'permission' ? {} : undefined,
      async execute(target: BridgeAgent, line: string, images: unknown[], signal: AbortSignal) {
        assert.equal(target, agent); assert.deepEqual(images, []); assert.equal(signal.aborted, false)
        if (state.commandError) return { result: { kind: 'error', text: state.commandError } }
        if (!line.startsWith('/permission ')) return undefined
        state.permission = line.slice('/permission '.length)
        append('permission/preset', { preset: state.permission })
        return { result: { kind: 'success', text: state.permission } }
      },
    },
  }
  agent.ctx = { get: name => services[name] }
  return { agent, append, state, sessions, services, calls }
}

async function fixture(t: TestContext, native = nativeAgent()) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-session-mirror-'))
  const events: BridgeEvent[] = []
  const bridge = new SessionBridge({ dshHome: home, onEvent: event => events.push(event) })
  t.after(() => { bridge.dispose(); rmSync(home, { recursive: true, force: true }) })
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

test('快照包含无 chunk 的完成消息、思考、用户输入，最近页和旧页不重叠', async t => {
  const native = nativeAgent()
  turn(native.append, 1, '较早回复')
  native.state.pageStart = native.agent.session.events.length
  turn(native.append, 2, '最新回复')
  const f = await fixture(t, native)
  const latest = (await f.bridge.getSession()).state!
  assert.equal(latest.hasMore, true)
  assert.equal(latest.beforeSeq, 4)
  assert.deepEqual(latest.entries.map(entry => entry.text), ['问题2', '可见思考', '最新回复'])
  assert.ok(latest.entries.every(entry => entry.turn === 2 && entry.streaming === false))
  const older = (await f.bridge.getSession(latest.beforeSeq, f.bindingId)).state!
  assert.equal(older.hasMore, false)
  assert.deepEqual(older.entries.map(entry => entry.text), ['问题1', '可见思考', '较早回复'])
  assert.equal(new Set([...latest.entries, ...older.entries].map(entry => entry.id)).size, 6)
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

test('原生 prompt/cancel 使用 RPC 信封，运行态以宿主为准，保留排队输入', async t => {
  const f = await fixture(t)
  assert.equal((await f.bridge.sessionCommand({ kind: 'prompt', bindingId: f.bindingId, text: '原生输入' })).ok, true)
  const prompt = f.calls.find(call => call.method === 'prompt')!.request
  assert.ok(prompt.rpcId)
  assert.equal(prompt.payload.sessionId, f.agent.id)
  assert.equal(prompt.payload.mode, 'queue')
  assert.deepEqual(prompt.payload.content, [{ type: 'text', text: '原生输入' }])
  f.bridge.onAgentStatus(f.agent, 'running')
  assert.equal((await f.bridge.getSession()).state!.status, 'running')
  assert.equal((await f.bridge.sessionCommand({ kind: 'cancel', bindingId: f.bindingId })).ok, true)
  assert.equal(f.state.cancel, 1)
  assert.deepEqual(f.state.inbox, ['queued'])
  assert.equal((await f.bridge.getSession()).state!.status, 'running')
  f.bridge.onAgentStatus(f.agent, 'idle')
  assert.equal((await f.bridge.getSession()).state!.status, 'idle')
  assert.equal((await f.bridge.sessionCommand({ kind: 'prompt', bindingId: f.bindingId, text: '朗读', spoken: true })).ok, false)
  assert.equal(f.calls.filter(call => call.method === 'prompt').length, 1)
})

test('模型和权限错误如实返回，不乐观修改；权限走原生命令而不是模型输入', async t => {
  const f = await fixture(t)
  f.state.modelError = '模型不可用'
  assert.match((await f.bridge.sessionCommand({ kind: 'model', bindingId: f.bindingId, provider: 'native', model: 'm2' })).error!, /模型不可用/)
  assert.equal((await f.bridge.getSession()).state!.model!.model, 'm1')
  f.state.modelError = ''
  assert.equal((await f.bridge.sessionCommand({ kind: 'model', bindingId: f.bindingId, provider: 'native', model: 'm2', reasoningEffort: 'high' })).ok, true)
  assert.equal((await f.bridge.getSession()).state!.model!.reasoningEffort, 'high')
  assert.equal((await f.bridge.sessionCommand({ kind: 'permission', bindingId: f.bindingId, value: 'unknown' })).ok, false)
  f.state.commandError = '权限被拒绝'
  assert.match((await f.bridge.sessionCommand({ kind: 'permission', bindingId: f.bindingId, value: 'full' })).error!, /权限被拒绝/)
  assert.equal((await f.bridge.getSession()).state!.permission, 'ask')
  f.state.commandError = ''
  assert.equal((await f.bridge.sessionCommand({ kind: 'permission', bindingId: f.bindingId, value: 'full' })).ok, true)
  assert.equal((await f.bridge.getSession()).state!.permission, 'full')
  assert.equal(f.calls.filter(call => call.method === 'prompt').length, 0)
  assert.equal((await f.bridge.sessionCommand({ kind: 'prompt', bindingId: f.bindingId, text: '/unknown' })).ok, false)
})

test('模型目录缓存避免每拍查询，缓存过期后可看到原生端选择', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 20; i += 1) f.bridge.onAgentStatus(f.agent, i % 2 ? 'idle' : 'running')
  await f.bridge.getSession()
  assert.equal(f.state.models, 1)
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + 31_000)
  f.state.model = 'm2'
  assert.equal((await f.bridge.getSession()).state!.model!.model, 'm2')
  assert.equal(f.state.models, 2)
})

test('绑定切换隔离迟到历史及操作回执，定时器扫描新 agent', async t => {
  const f = await fixture(t)
  let release!: (value: unknown) => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  f.sessions.history = async request => {
    entered()
    return new Promise(resolve => { release = value => resolve(success(request, value)) })
  }
  const late = f.bridge.getSession(3, f.bindingId)
  await ready
  const next = nativeAgent('session-b')
  await f.bridge.bind(next.agent)
  const state = (await f.bridge.getSession()).state!
  assert.notEqual(state.bindingId, f.bindingId)
  assert.deepEqual(state.entries, [])
  release({ events: [], hasMore: false })
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

test('换绑期间原生模型操作的迟到成功不能污染新会话', async t => {
  const f = await fixture(t)
  let release!: () => void
  t.mock.method(f.sessions, 'selectModel', async (request: Request) => new Promise<ReturnType<typeof success>>(resolve => {
    release = () => resolve(success(request, { selected: { provider: 'native', model: 'late-model' } }))
  }))
  const pending = f.bridge.sessionCommand({ kind: 'model', bindingId: f.bindingId, provider: 'native', model: 'late-model' })
  const next = nativeAgent('new-session')
  await f.bridge.bind(next.agent)
  release()
  assert.equal((await pending).ok, false)
  const state = (await f.bridge.getSession()).state!
  assert.equal(state.sessionId, 'new-session')
  assert.equal(state.model!.model, 'm1')
})

test('RPC 错误与不匹配的响应身份不能冒充成功，模型查询错误可见且缓存', async t => {
  const f = await fixture(t)
  t.mock.method(f.sessions, 'cancel', async (request: Request) => ({ ...success(request, { accepted: true }), rpcId: 'wrong-id' }))
  assert.match((await f.bridge.sessionCommand({ kind: 'cancel', bindingId: f.bindingId })).error!, /请求身份/)
  t.mock.method(f.sessions, 'models', async (request: Request) => failure(request, '模型目录无法读取'))
  f.append('request/header', { header: { config: { provider: 'native', model: 'm1' } } })
  f.bridge.onAgentStatus(f.agent, 'running')
  const state = (await f.bridge.getSession()).state!
  assert.match(state.error!, /模型目录无法读取/)
  assert.equal(state.model!.model, 'm1')
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
