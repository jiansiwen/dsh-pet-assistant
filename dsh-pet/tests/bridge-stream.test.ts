/**
 * 宠物侧事件流契约：桥接推来的 delta 只喂给当前请求的 onDelta，回复仍走 resolve。
 *
 * 用真的 HTTP 服务端跑一遍连接发现、长轮询与分发 —— 这几步以前只有 typecheck 覆盖，
 * 而"增量到了没喂给气泡"和"喂给了上一个请求"都只有真跑一次才看得出来。
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { BridgeClient } from '../src/main/harness.ts'
import type { BridgeCallbacks } from '../src/main/harness.ts'
import type { SessionResult, SessionSnapshot, SessionUpdate } from '../src/session-types.ts'

let home = ''
let previousHome: string | undefined
const servers: Server[] = []

before(() => {
  home = mkdtempSync(path.join(tmpdir(), 'dsh-pet-bridge-stream-'))
  mkdirSync(path.join(home, 'personal-assistant'), { recursive: true })
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

after(() => {
  for (const server of servers) server.close()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

interface FakeBridge {
  port: number
  /** 下一次 /events 要吐出的事件。 */
  queue: Array<Record<string, unknown>>
  chatIds: string[]
}

/** 一个只说桥接协议的假服务端：/health、/chat、/events。 */
async function fakeBridge(): Promise<FakeBridge> {
  const state = { queue: [] as Array<Record<string, unknown>>, chatIds: [] as string[] }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true, epoch: 'test-epoch' }))
      return
    }
    if (url.pathname === '/chat') {
      let body = ''
      request.on('data', (chunk) => { body += String(chunk) })
      request.on('end', () => {
        const parsed = JSON.parse(body) as { id?: string }
        if (typeof parsed.id === 'string') state.chatIds.push(parsed.id)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ accepted: true }))
      })
      return
    }
    if (url.pathname === '/events') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ epoch: 'test-epoch', events: state.queue.splice(0) }))
      return
    }
    response.writeHead(404).end()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  writeFileSync(path.join(home, 'personal-assistant', 'bridge.json'),
    JSON.stringify({ port, token: 'test-only', epoch: 'test-epoch' }), 'utf8')
  return { port, get queue() { return state.queue }, get chatIds() { return state.chatIds } }
}

/** 等到条件成立，或超时失败：长轮询是异步的，断言不能抢跑。 */
async function until(predicate: () => boolean, message: string, timeout = 5_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(message)
}

test('delta 只喂给发起请求的 onDelta，回复仍按 id 结算', async () => {
  const bridge = await fakeBridge()
  const client = new BridgeClient()
  const statuses: string[] = []
  const events: Array<Record<string, unknown>> = []
  await client.connect({
    onStatus: (status) => statuses.push(status),
    onSessionEnded: () => undefined,
    onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
  })
  assert.deepEqual(statuses, ['connected'])

  const deltas: string[] = []
  const pending = client.chat('今天做了什么', undefined, undefined, (text) => deltas.push(text))
  await until(() => bridge.chatIds.length === 1, '桥接没有收到消息')
  const id = bridge.chatIds[0]

  // 先到两片增量、再到整段回复：气泡应该先长出来，最后被终稿替换。
  bridge.queue.push({ seq: 1, epoch: 'test-epoch', type: 'delta', id, text: '今天写了' })
  bridge.queue.push({ seq: 2, epoch: 'test-epoch', type: 'delta', id, text: '事件流' })
  bridge.queue.push({ seq: 3, epoch: 'test-epoch', type: 'reply', id, ok: true, reply: '今天写了事件流' })

  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.reply, '今天写了事件流')
  assert.deepEqual(deltas, ['今天写了', '事件流'], '增量按到达顺序喂给 onDelta')
  client.dispose()
})

test('别的请求 id 的 delta 不喂给当前请求', async () => {
  const bridge = await fakeBridge()
  const client = new BridgeClient()
  await client.connect({
    onStatus: () => undefined,
    onSessionEnded: () => undefined,
    onEvent: () => undefined,
  })
  const deltas: string[] = []
  const pending = client.chat('你好', undefined, undefined, (text) => deltas.push(text))
  await until(() => bridge.chatIds.length === 1, '桥接没有收到消息')
  const id = bridge.chatIds[0]

  bridge.queue.push({ seq: 1, epoch: 'test-epoch', type: 'delta', id: 'req-other', text: '不该出现的增量' })
  bridge.queue.push({ seq: 2, epoch: 'test-epoch', type: 'reply', id, ok: true, reply: '好' })

  const result = await pending
  assert.equal(result.reply, '好')
  assert.deepEqual(deltas, [], '不是本请求的增量不得落进这个气泡')
  client.dispose()
})

test('服务端不吐增量时，onDelta 一次都不触发，回复照常到', async () => {
  const bridge = await fakeBridge()
  const client = new BridgeClient()
  await client.connect({
    onStatus: () => undefined,
    onSessionEnded: () => undefined,
    onEvent: () => undefined,
  })
  const deltas: string[] = []
  const pending = client.chat('在吗', undefined, undefined, (text) => deltas.push(text))
  await until(() => bridge.chatIds.length === 1, '桥接没有收到消息')
  const id = bridge.chatIds[0]
  bridge.queue.push({ seq: 1, epoch: 'test-epoch', type: 'reply', id, ok: true, reply: '在' })

  const result = await pending
  assert.equal(result.reply, '在')
  assert.deepEqual(deltas, [])
  client.dispose()
})

function sessionState(bindingId = 'binding-a', cursor = 1): SessionSnapshot {
  return { bindingId, cursor, sessionId: bindingId, title: '测试会话', status: 'running', entries: [], hasMore: false,
    model: null, models: [], permission: null, permissions: [],
    capabilities: { prompt: true, cancel: true, models: false, permissions: false, history: true } }
}

function sessionClient() {
  const client = new BridgeClient()
  const updates: SessionUpdate[] = []
  const statuses: string[] = []
  const internals = client as unknown as {
    info: { port: number; token: string; epoch: string } | null
    callbacks: BridgeCallbacks
    pollLoop(): Promise<void>
    pushSessionSnapshot(): Promise<boolean>
    reconnect(): Promise<void>
  }
  internals.info = { port: 12345, token: 'chat-token', epoch: 'test-epoch' }
  internals.callbacks = { onStatus: status => statuses.push(status), onSessionEnded() {},
    onEvent: event => { if (event.type === 'session/update') updates.push(event.payload as SessionUpdate) } }
  return { client, internals, updates, statuses }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

test('连接主动发布会话基线，保留团队快照路径', async t => {
  const client = new BridgeClient()
  t.after(() => client.dispose())
  writeFileSync(path.join(home, 'personal-assistant', 'bridge.json'), JSON.stringify({ port: 12345, token: 'chat-token', epoch: 'test-epoch' }))
  const updates: SessionUpdate[] = []
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input))
    if (url.pathname === '/health') return json({ ok: true })
    if (url.pathname === '/session') return json({ ok: true, state: sessionState() })
    if (url.pathname === '/team') return json({ members: [], tasks: [] })
    client.dispose()
    return json({ events: [], epoch: 'test-epoch' })
  })
  await client.connect({ onStatus() {}, onSessionEnded() {}, onEvent(event) {
    if (event.type === 'session/update') updates.push(event.payload as SessionUpdate)
  } })
  assert.equal(updates.length, 1)
  assert.equal(updates[0].reset, true)
  assert.equal(updates[0].bindingId, 'binding-a')
})

test('ring 缺口主动重取基线，跳过基线前增量，保留之后 upsert', async t => {
  const f = sessionClient()
  t.after(() => f.client.dispose())
  let snapshots = 0
  let polls = 0
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input))
    if (url.pathname === '/session') {
      snapshots += 1
      return json({ ok: true, state: sessionState('binding-a', snapshots === 1 ? 1 : 10) })
    }
    if (++polls === 1) return json({ epoch: 'test-epoch', reset: true, events: [
      { type: 'session/update', seq: 520, payload: { ...sessionState('binding-a', 9), entries: [{ id: 'old', seq: 1, role: 'assistant', kind: 'text', text: '旧片段' }] } },
      { type: 'session/update', seq: 521, payload: { ...sessionState('binding-a', 11), entries: [{ id: 'a', seq: 2, role: 'assistant', kind: 'text', text: '完整新条目' }] } },
    ] })
    f.client.dispose()
    return json({ events: [] })
  })
  await f.internals.pushSessionSnapshot()
  await f.internals.pollLoop()
  assert.equal(snapshots, 2)
  assert.deepEqual(f.updates.map(update => update.cursor), [1, 10, 11])
  assert.equal(f.updates[1].reset, true)
  assert.equal(f.updates[2].entries[0].text, '完整新条目')
})

test('换绑后丢弃迟到旧历史与命令回执，ring 旧 reset 不会切回旧会话', async t => {
  const f = sessionClient()
  t.after(() => f.client.dispose())
  let current = sessionState()
  let releasePage!: () => void
  let releaseCommand!: () => void
  let polls = 0
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/session') {
      if (init?.method === 'POST') return new Promise<Response>(resolve => { releaseCommand = () => resolve(json({ ok: true, state: sessionState() })) })
      if (url.searchParams.has('beforeSeq')) return new Promise<Response>(resolve => { releasePage = () => resolve(json({ ok: true, state: sessionState() })) })
      return json({ ok: true, state: current })
    }
    if (++polls === 1) return json({ events: [{ type: 'session/update', seq: 2, payload: { ...sessionState(), reset: true } }] })
    f.client.dispose()
    return json({ events: [] })
  })
  await f.internals.pushSessionSnapshot()
  const page = f.client.getSession(10, 'binding-a')
  const command = f.client.sessionCommand({ kind: 'cancel', bindingId: 'binding-a' })
  current = sessionState('binding-b', 1)
  await f.internals.pushSessionSnapshot()
  releasePage(); releaseCommand()
  assert.equal((await page).ok, false)
  assert.equal((await command).ok, false)
  await f.internals.pollLoop()
  assert.ok(f.updates.slice(1).every(update => update.bindingId === 'binding-b'))
})

test('同绑定迟到快照不能覆盖已经转发的新增量，历史页仍允许追加', async t => {
  const f = sessionClient()
  t.after(() => f.client.dispose())
  let release!: () => void
  let snapshots = 0
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input))
    if (url.searchParams.has('beforeSeq')) return json({ ok: true, state: sessionState('binding-a', 1) })
    if (++snapshots === 2) return new Promise<Response>(resolve => { release = () => resolve(json({ ok: true, state: sessionState('binding-a', 1) })) })
    return json({ ok: true, state: sessionState('binding-a', snapshots === 1 ? 1 : 3) })
  })
  await f.internals.pushSessionSnapshot()
  const old = f.client.getSession()
  await f.internals.pushSessionSnapshot()
  release()
  assert.equal((await old).ok, false)
  assert.equal((await f.client.getSession(5, 'binding-a')).ok, true)
})

test('基线读取失败后保留重新基线需求，不用残缺增量冒充完整视图', async t => {
  const f = sessionClient()
  t.after(() => f.client.dispose())
  let snapshots = 0
  let polls = 0
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input))
    if (url.pathname === '/session') {
      if (++snapshots === 2) return json({ ok: false, error: '暂时失败' }, 503)
      return json({ ok: true, state: sessionState('binding-a', snapshots === 1 ? 1 : 5) })
    }
    if (++polls <= 2) return json({ reset: polls === 1, events: [{ type: 'session/update', seq: polls, payload: sessionState('binding-a', polls + 1) }] })
    f.client.dispose()
    return json({ events: [] })
  })
  await f.internals.pushSessionSnapshot()
  await f.internals.pollLoop()
  assert.equal(snapshots, 3)
  assert.deepEqual(f.updates.map(update => update.cursor), [1, 5])
})

test('重连接后主动重新发布快照，命令使用聊天令牌与原生请求结构', async t => {
  const f = sessionClient()
  t.after(() => f.client.dispose())
  f.internals.info = null
  writeFileSync(path.join(home, 'personal-assistant', 'bridge.json'), JSON.stringify({ port: 12345, token: 'chat-token', epoch: 'test-epoch' }))
  let posted: unknown
  let releasePoll!: () => void
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input))
    assert.equal(url.searchParams.get('token'), 'chat-token')
    if (url.pathname === '/health') return json({ ok: true })
    if (url.pathname === '/team') return json({ members: [], tasks: [] })
    if (url.pathname === '/session') {
      if (init?.method === 'POST') { posted = JSON.parse(String(init.body)); return json({ ok: true } satisfies SessionResult) }
      return json({ ok: true, state: sessionState() })
    }
    return new Promise<Response>(resolve => { releasePoll = () => resolve(json({ events: [] })) })
  })
  await f.internals.reconnect()
  assert.equal(f.updates[0].reset, true)
  const command = { kind: 'prompt' as const, bindingId: 'binding-a', text: '正常输入' }
  assert.deepEqual(await f.client.sessionCommand(command), { ok: true })
  assert.deepEqual(posted, command)
  f.client.dispose(); releasePoll()
})
