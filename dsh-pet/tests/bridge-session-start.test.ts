/**
 * 桌面开启会话（M1-01 桌面侧）：真 HTTP 假桥接，只说 /health、/session、/session/start、/events 协议。
 * 覆盖：未绑定基线 → 开启后取到新绑定；宿主不支持时如实失败；会话结束后继续轮询，换绑仍能收到。
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { BridgeClient } from '../src/main/harness.ts'
import type { SessionSnapshot, SessionUpdate } from '../src/session-types.ts'

let home = ''
let previousHome: string | undefined
const servers: Server[] = []

before(() => {
  home = mkdtempSync(path.join(tmpdir(), 'dsh-pet-session-start-'))
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

function snapshot(bindingId: string, bound: boolean): SessionSnapshot {
  return {
    sessionId: bound ? `会话-${bindingId}` : null as unknown as string, bindingId, cursor: 0, title: '', status: bound ? 'idle' : 'disconnected',
    entries: [], hasMore: false, model: null, models: [], permission: null, permissions: [],
    capabilities: { prompt: bound, cancel: bound, models: false, permissions: false, history: bound },
  }
}

async function fakeBridge(startReply: { status: number; body: Record<string, unknown> }) {
  const state = { session: snapshot('未绑定-1', false), queue: [] as Array<Record<string, unknown>>, starts: 0, tokens: [] as string[] }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const json = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
    if (url.pathname === '/health') return json(200, { ok: true, epoch: 'e1', bound: state.session.status !== 'disconnected' })
    if (url.pathname === '/session' && request.method === 'GET') return json(200, { ok: true, state: state.session })
    if (url.pathname === '/session/start' && request.method === 'POST') {
      state.starts += 1
      state.tokens.push(url.searchParams.get('token') ?? '')
      if (startReply.status === 200) state.session = snapshot('自建-1', true)
      return json(startReply.status, startReply.body)
    }
    if (url.pathname === '/events') {
      const events = state.queue.splice(0)
      if (events.length) return json(200, { epoch: 'e1', events })
      setTimeout(() => json(200, { epoch: 'e1', events: state.queue.splice(0) }), 40)
      return
    }
    json(404, {})
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  writeFileSync(path.join(home, 'personal-assistant', 'bridge.json'), JSON.stringify({ port, token: 'chat-token', epoch: 'e1' }), 'utf8')
  return state
}

async function until(predicate: () => boolean, message: string, timeout = 5_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(message)
}

function connectClient(updates: SessionUpdate[], ended: string[] = []) {
  const client = new BridgeClient()
  const connected = client.connect({
    onStatus: () => undefined,
    onSessionEnded: () => ended.push('ended'),
    onEvent: event => { if (event.type === 'session/update') updates.push(event.payload as SessionUpdate) },
  })
  return { client, connected }
}

test('未绑定时开启会话：带聊天令牌请求一次，成功后取到新绑定的基线', async () => {
  const bridge = await fakeBridge({ status: 200, body: { ok: true, outcome: 'created', owned: true, sessionId: '会话-自建-1', bindingId: '自建-1', epoch: 'e1' } })
  const updates: SessionUpdate[] = []
  const { client, connected } = connectClient(updates)
  await connected
  assert.equal(client.connected, true)
  assert.equal(updates.at(-1)?.status, 'disconnected', '插件已加载但未绑定，基线如实是未连接会话')

  const result = await client.startSession()
  assert.deepEqual(result, { ok: true, outcome: 'created', owned: true, resumeError: undefined })
  assert.equal(bridge.starts, 1)
  assert.deepEqual(bridge.tokens, ['chat-token'])
  assert.equal(updates.at(-1)?.bindingId, '自建-1')
  assert.equal(updates.at(-1)?.capabilities.prompt, true)
  client.dispose()
})

test('宿主没有 agents 时如实失败，不伪造已开启', async () => {
  await fakeBridge({ status: 503, body: { ok: false, code: 'agents-unavailable', error: '宿主没有会话服务' } })
  const updates: SessionUpdate[] = []
  const { client, connected } = connectClient(updates)
  await connected
  const result = await client.startSession()
  assert.deepEqual(result, { ok: false, error: '宿主没有会话服务', code: 'agents-unavailable' })
  assert.equal(updates.at(-1)?.status, 'disconnected')
  client.dispose()
})

test('会话结束后继续轮询：之后的换绑仍能到达，不需要重启宠物', async () => {
  const bridge = await fakeBridge({ status: 200, body: { ok: true, outcome: 'created', owned: true } })
  bridge.session = snapshot('网页-1', true)
  const updates: SessionUpdate[] = []
  const ended: string[] = []
  const { client, connected } = connectClient(updates, ended)
  await connected
  assert.equal(updates.at(-1)?.bindingId, '网页-1')

  bridge.session = snapshot('未绑定-2', false)
  bridge.queue.push({ seq: 1, type: 'session/update', payload: { ...bridge.session, reset: true } }, { seq: 2, type: 'session-ended' })
  await until(() => ended.length === 1, '没有收到会话结束')
  await until(() => updates.at(-1)?.bindingId === '未绑定-2', '会话结束后没有拿到未绑定基线')

  bridge.session = snapshot('网页-2', true)
  bridge.queue.push({ seq: 3, type: 'session/update', payload: { ...bridge.session, reset: true } })
  await until(() => updates.at(-1)?.bindingId === '网页-2', '会话结束后停止了轮询，收不到新的召唤')
  assert.equal(client.connected, true)
  client.dispose()
})
