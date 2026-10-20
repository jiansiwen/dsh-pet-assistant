/**
 * M1-01 插件侧：桥接加载即监听、未绑定如实拒绝、从桌面开始会话（POST /session/start）与会话所有权。
 *
 * 宿主 ctx.agents 用替身：只记录 create / resume / dispose，不启动模型、不碰真实 ~/.dsh。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { ApprovalService } from '../src/approval.ts'
import { AssistantApprovalService, type AssistantSubmission } from '../src/assistant-approval.ts'
import { SessionBridge, type BridgeAgent, type HostAgentHandle, type HostAgents, type SessionHost } from '../src/bridge.ts'
import { ReportApprovalService } from '../src/report-approval.ts'
import { ReportStore } from '../src/report.ts'
import { openAssistantStore } from '../src/store.ts'
import { TeamStore } from '../src/team-domain.ts'

type FakeAgent = BridgeAgent & { id: string; cancelCalls: number; disposeCalls: number; cancel(): void; dispose(): Promise<void> }

/** 会话替身。cancel / dispose 只计数：桥接若敢碰网页会话，计数会露馅。 */
function fakeAgent(id: string): FakeAgent {
  const agent: FakeAgent = {
    id, status: 'idle', session: { id, events: [] }, followup() {},
    cancelCalls: 0, disposeCalls: 0,
    cancel() { agent.cancelCalls += 1 },
    async dispose() { agent.disposeCalls += 1 },
  }
  return agent
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

interface HostOptions {
  persisted?: string[]
  flag?: string | null
  resumeError?: string
  createError?: string
  available?: boolean
  /** 让 create 卡住直到测试放行，用来制造「等宿主期间网页召唤」的竞态。 */
  holdCreate?: Promise<void>
}

/** ctx.agents 的替身：在线表、持久化表、user_flags 里的自建会话 id。 */
function fakeHost(options: HostOptions = {}) {
  const live = new Map<string, FakeAgent>()
  const persisted = new Set(options.persisted ?? [])
  const calls = { create: [] as Array<{ sessionId: string; cwd?: string }>, resume: [] as string[], disposed: [] as string[] }
  const state = { flag: options.flag ?? null, available: options.available !== false }
  const handleFor = (agent: FakeAgent): HostAgentHandle => {
    let disposing: Promise<void> | undefined
    return {
      agent,
      dispose: () => disposing ??= (async () => {
        calls.disposed.push(agent.id)
        live.delete(agent.id)
      })(),
    }
  }
  const agents: HostAgents = {
    async create({ sessionId, meta }) {
      calls.create.push({ sessionId, cwd: meta?.cwd })
      await options.holdCreate
      if (options.createError) throw new Error(options.createError)
      const agent = fakeAgent(sessionId)
      live.set(sessionId, agent)
      persisted.add(sessionId)
      return handleFor(agent)
    },
    async resume({ resumeSessionId }) {
      calls.resume.push(resumeSessionId)
      if (options.resumeError) throw new Error(options.resumeError)
      if (!persisted.has(resumeSessionId)) throw new Error(`session "${resumeSessionId}" not found in persistence`)
      if (live.has(resumeSessionId)) throw new Error(`session "${resumeSessionId}" already exists`)
      const agent = fakeAgent(resumeSessionId)
      live.set(resumeSessionId, agent)
      return handleFor(agent)
    },
    get: id => live.get(id),
  }
  const host: SessionHost = {
    agents: () => state.available ? agents : undefined,
    readOwnedSessionId: () => state.flag,
    writeOwnedSessionId: id => { state.flag = id },
    cwd: () => path.resolve('fake-cwd'),
  }
  return { host, calls, live, persisted, state }
}

interface Reply { status: number; body: any }

async function fixture(t: TestContext, host?: SessionHost) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-session-start-'))
  const bridge = new SessionBridge({ dshHome: home, sessionHost: host })
  t.after(async () => { await bridge.dispose(); rmSync(home, { recursive: true, force: true }) })
  const started = await bridge.listen()
  const infoPath = path.join(home, 'personal-assistant', 'bridge.json')
  const info = JSON.parse(readFileSync(infoPath, 'utf8')) as { port: number; token: string; epoch: string; pid: number }
  const base = `http://127.0.0.1:${info.port}`
  const call = async (method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}, token: string | false = info.token): Promise<Reply> => {
    const url = token === false ? `${base}${pathname}` : `${base}${pathname}${pathname.includes('?') ? '&' : '?'}token=${token}`
    const response = await fetch(url, {
      method, headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  const start = () => call('POST', '/session/start', {})
  return { home, bridge, started, info, infoPath, call, start }
}

test('加载即监听：未绑定时写出发现文件，/health 如实报 bound:false', async t => {
  const f = await fixture(t)
  assert.equal(f.started.advertised, true)
  assert.equal(f.info.epoch, f.bridge.epoch)
  assert.equal(f.info.pid, process.pid)
  const credential = JSON.parse(readFileSync(path.join(f.home, 'personal-assistant', 'bridge-approval.json'), 'utf8'))
  assert.equal(credential.epoch, f.bridge.epoch)
  assert.equal(credential.token, undefined, '审批凭据文件不得混进聊天令牌')
  assert.equal(f.bridge.bound, false)
  assert.deepEqual((await f.call('GET', '/health')).body, { ok: true, bound: false, epoch: f.bridge.epoch, team: false })
  assert.equal((await f.call('GET', '/health', undefined, {}, false)).status, 401)
  assert.equal((await f.call('POST', '/session/start', {}, {}, false)).status, 401, '开始会话沿用聊天令牌鉴权')
})

test('未绑定时对话、会话命令与三类审批一律明确拒绝，给出可展示原因，不伪装成已连接', async t => {
  const f = await fixture(t)
  const assistant = new AssistantApprovalService({ epoch: f.bridge.epoch, ttlMs: 60_000 })
  f.bridge.attachAssistantApprovals(assistant)
  let executed = 0
  const submission: AssistantSubmission = {
    subject: '测试', tool: '测试工具', summary: '测试说明', target: '本地测试', risk: 'high',
    snapshot: { text: '完整内容' }, validate: () => true, execute: () => { executed += 1; return null },
  }
  const proposal = f.bridge.submitAssistant(submission)

  const dbDir = mkdtempSync(path.join(tmpdir(), 'dsh-session-start-db-'))
  const db = openAssistantStore(path.join(dbDir, 'assistant.sqlite'))
  // 先关库再删目录：Windows 上删不掉仍被打开的 SQLite 文件。
  t.after(() => { db.close(); rmSync(dbDir, { recursive: true, force: true }) })
  const reportApprovals = new ReportApprovalService(db, new ReportStore(db), {
    epoch: f.bridge.epoch, reportDir: path.join(dbDir, 'reports'), ttlMs: 60_000, active: () => false, stop: async () => {},
  })
  f.bridge.attachReportApprovals(reportApprovals)
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  const teamApprovals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: f.bridge.epoch })
  const idleTeam = { roster: () => [], listTasks: () => [], runningCount: () => 0, eventsSince: () => [] }
  f.bridge.attachTeam(idleTeam as never, teamApprovals)

  const chat = await f.call('POST', '/chat', { requestId: 'r1', text: '你好' })
  assert.equal(chat.status, 503)
  assert.equal(chat.body.code, 'unbound')
  assert.match(chat.body.error, /召唤宠物/)
  assert.equal(chat.body.accepted, undefined, '不能先回 accepted 再异步失败')

  const command = await f.call('POST', '/session', { kind: 'prompt', bindingId: 'any', text: '你好' })
  assert.equal(command.status, 503)
  assert.deepEqual([command.body.ok, command.body.code], [false, 'unbound'])
  assert.match(command.body.error, /会话操作/)

  // 读快照照常，但它如实是断开态：没有会话 id、没有任何可用能力。
  const snapshot = await f.call('GET', '/session')
  assert.equal(snapshot.body.ok, true)
  assert.equal(snapshot.body.state.sessionId, null)
  assert.equal(snapshot.body.state.status, 'disconnected')
  assert.ok(Object.values(snapshot.body.state.capabilities).every(value => value === false))

  const approvals: Array<[string, string, Record<string, unknown>]> = [
    ['/assistant-approval', assistant.approvalCapabilityToken, { proposalId: proposal.proposalId, decision: 'approve', epoch: f.bridge.epoch }],
    ['/report-approval', reportApprovals.approvalCapabilityToken, { proposalId: 'p', decision: 'approve', epoch: f.bridge.epoch }],
    ['/approval', teamApprovals.approvalCapabilityToken, { proposalId: 'p', decision: 'approve', epoch: f.bridge.epoch }],
  ]
  for (const [route, token, body] of approvals) {
    // 凭据先核：没有凭据的调用方拿不到绑定状态。
    assert.equal((await f.call('POST', route, body, { 'x-dsh-approval-token': 'wrong' }, false)).status, 403, route)
    const rejected = await f.call('POST', route, body, { 'x-dsh-approval-token': token }, false)
    assert.equal(rejected.status, 503, route)
    assert.deepEqual([rejected.body.ok, rejected.body.code], [false, 'unbound'], route)
    assert.match(rejected.body.message, /审批暂不受理/, route)
  }
  assert.equal(executed, 0, '未绑定时的审批不能落地执行')
  assert.equal(assistant.pendingProposals().length, 1, '拒绝不等于消费：绑定后仍可处理这条待办')
  assert.equal((await f.call('GET', '/health')).body.bound, false)
})

test('开始会话：经 ctx.agents 新建、记下 id 并复用 bind；顺序与并发重复调用都只建一个', async t => {
  const host = fakeHost()
  const f = await fixture(t, host.host)
  const first = await f.start()
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.outcome, 'created')
  assert.equal(first.body.owned, true)
  assert.match(first.body.sessionId, /^pet-/)
  assert.equal(first.body.epoch, f.bridge.epoch)
  assert.deepEqual(host.calls.create, [{ sessionId: first.body.sessionId, cwd: path.resolve('fake-cwd') }])
  assert.equal(host.state.flag, first.body.sessionId, '自建会话 id 记进 user_flags')
  assert.equal(f.bridge.bound, true)
  assert.equal((await f.call('GET', '/health')).body.bound, true)
  assert.equal((await f.call('GET', '/session')).body.state.bindingId, first.body.bindingId)

  const again = await f.start()
  assert.equal(again.body.outcome, 'existing')
  assert.equal(again.body.owned, true)
  assert.equal(again.body.sessionId, first.body.sessionId)
  assert.equal(again.body.bindingId, first.body.bindingId)
  assert.equal(host.calls.create.length, 1)

  const concurrentHost = fakeHost()
  const g = await fixture(t, concurrentHost.host)
  const results = await Promise.all([g.start(), g.start(), g.start()])
  assert.equal(concurrentHost.calls.create.length, 1, '并发开始只建一个会话')
  assert.ok(results.every(result => result.status === 200 && result.body.sessionId === results[0].body.sessionId))
})

test('开始会话：恢复插件上次自建的会话，不新建', async t => {
  const host = fakeHost({ persisted: ['pet-old'], flag: 'pet-old' })
  const f = await fixture(t, host.host)
  const result = await f.start()
  assert.equal(result.body.outcome, 'resumed')
  assert.equal(result.body.sessionId, 'pet-old')
  assert.equal(result.body.owned, true)
  assert.equal(result.body.resumeError, undefined)
  assert.deepEqual(host.calls.resume, ['pet-old'])
  assert.equal(host.calls.create.length, 0)
  assert.equal(host.state.flag, 'pet-old')
})

test('恢复失败时新建会话并如实带回原因；新建也失败就如实失败、保持未绑定', async t => {
  const host = fakeHost({ flag: 'pet-gone', resumeError: 'cannot resume: session persistence is not configured' })
  const f = await fixture(t, host.host)
  const result = await f.start()
  assert.equal(result.status, 200)
  assert.equal(result.body.outcome, 'created')
  assert.match(result.body.resumeError, /pet-gone/)
  assert.match(result.body.resumeError, /session persistence is not configured/)
  assert.deepEqual(host.calls.resume, ['pet-gone'])
  assert.equal(host.calls.create.length, 1)
  assert.equal(host.state.flag, result.body.sessionId, '记录改成新会话')

  const broken = fakeHost({ flag: 'pet-gone', resumeError: '恢复不了', createError: '宿主拒绝新建' })
  const g = await fixture(t, broken.host)
  const failed = await g.start()
  assert.equal(failed.status, 500)
  assert.deepEqual([failed.body.ok, failed.body.code], [false, 'start-failed'])
  assert.match(failed.body.error, /宿主拒绝新建/)
  assert.match(failed.body.resumeError, /恢复不了/)
  assert.equal(g.bridge.bound, false)
  assert.equal(broken.state.flag, 'pet-gone', '失败时不改记录')
})

test('宿主没有 agents 服务：如实拒绝且不降级成假成功；服务出现后现取即可用', async t => {
  const none = await fixture(t)
  const missing = await none.start()
  assert.equal(missing.status, 503)
  assert.deepEqual([missing.body.ok, missing.body.code], [false, 'agents-unavailable'])
  assert.match(missing.body.error, /ctx\.agents/)
  assert.equal(none.bridge.bound, false)

  const host = fakeHost({ available: false })
  const f = await fixture(t, host.host)
  assert.equal((await f.start()).body.code, 'agents-unavailable')
  assert.equal((await f.call('GET', '/health')).body.bound, false)
  host.state.available = true
  const later = await f.start()
  assert.equal(later.body.ok, true)
  assert.equal(later.body.outcome, 'created')
})

test('已绑定网页会话时原样返回；桥接卸载既不 dispose 也不 cancel 网页会话', async t => {
  const host = fakeHost()
  const f = await fixture(t, host.host)
  const web = fakeAgent('web-1')
  host.live.set(web.id, web)
  await f.bridge.bind(web)
  const result = await f.start()
  assert.equal(result.body.outcome, 'existing')
  assert.equal(result.body.owned, false)
  assert.equal(result.body.sessionId, 'web-1')
  assert.equal(host.calls.create.length, 0)
  await f.bridge.dispose()
  assert.equal(web.disposeCalls, 0)
  assert.equal(web.cancelCalls, 0)
  assert.deepEqual(host.calls.disposed, [])
})

test('网页召唤换绑：按现有规则换绑、旧审批失效；卸载只释放自建会话且只释放一次', async t => {
  const host = fakeHost()
  const f = await fixture(t, host.host)
  const assistant = new AssistantApprovalService({ epoch: f.bridge.epoch, ttlMs: 60_000 })
  f.bridge.attachAssistantApprovals(assistant)
  const owned = await f.start()
  let executed = 0
  const proposal = f.bridge.submitAssistant({
    subject: '测试', tool: '测试工具', summary: '测试说明', target: '本地测试', risk: 'high',
    snapshot: { text: '完整内容' }, validate: () => true, execute: () => { executed += 1; return null },
  })
  const web = fakeAgent('web-2')
  host.live.set(web.id, web)
  await f.bridge.bind(web)
  assert.equal(f.bridge.bound, true)
  assert.equal((await f.call('GET', '/session')).body.state.sessionId, 'web-2')
  assert.notEqual((await f.call('GET', '/session')).body.state.bindingId, owned.body.bindingId)
  const late = await f.call('POST', '/assistant-approval', { proposalId: proposal.proposalId, decision: 'approve', epoch: f.bridge.epoch },
    { 'x-dsh-approval-token': assistant.approvalCapabilityToken }, false)
  assert.equal(late.status, 409, '换绑后旧审批失效')
  assert.equal(executed, 0)
  assert.deepEqual(assistant.pendingProposals(), [])

  await f.bridge.dispose()
  await f.bridge.dispose()
  assert.deepEqual(host.calls.disposed, [owned.body.sessionId], '只释放自建会话，且只释放一次')
  assert.equal(web.disposeCalls + web.cancelCalls, 0)
})

test('宿主回收了自建会话：只丢引用不再 dispose；再开始时从持久化恢复', async t => {
  const host = fakeHost()
  const f = await fixture(t, host.host)
  const created = await f.start()
  const agent = host.live.get(created.body.sessionId)!
  host.live.delete(agent.id) // 用户在网页里关掉了这条会话，宿主自己拆掉了它
  f.bridge.onAgentDisposed(agent)
  assert.equal(f.bridge.bound, false)
  assert.equal(f.bridge.ownsAgent(agent), false)
  const resumed = await f.start()
  assert.equal(resumed.body.outcome, 'resumed')
  assert.equal(resumed.body.sessionId, created.body.sessionId)
  assert.deepEqual(host.calls.disposed, [], '宿主已回收的会话桥接不再 dispose')
})

test('网页会话结束后，开始会话接回仍在线的自建会话，不再新建也不恢复', async t => {
  const host = fakeHost()
  const f = await fixture(t, host.host)
  const created = await f.start()
  const web = fakeAgent('web-3')
  host.live.set(web.id, web)
  await f.bridge.bind(web)
  host.live.delete(web.id)
  f.bridge.onAgentDisposed(web)
  const back = await f.start()
  assert.equal(back.body.outcome, 'reattached')
  assert.equal(back.body.owned, true)
  assert.equal(back.body.sessionId, created.body.sessionId)
  assert.equal(host.calls.create.length, 1)
  assert.equal(host.calls.resume.length, 0)
})

test('等宿主建会话期间网页召唤了别的会话：不抢绑定，新会话留作自建、卸载时释放', async t => {
  const gate = deferred<void>()
  const host = fakeHost({ holdCreate: gate.promise })
  const f = await fixture(t, host.host)
  const pending = f.start()
  for (let i = 0; i < 200 && host.calls.create.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(host.calls.create.length, 1)
  const web = fakeAgent('web-4')
  host.live.set(web.id, web)
  await f.bridge.bind(web)
  gate.resolve()
  const result = await pending
  assert.equal(result.body.outcome, 'existing')
  assert.equal(result.body.owned, false)
  assert.equal(result.body.sessionId, 'web-4')
  const createdId = host.calls.create[0].sessionId
  assert.equal(f.bridge.ownsAgent(host.live.get(createdId)), true)
  await f.bridge.dispose()
  assert.deepEqual(host.calls.disposed, [createdId])
  assert.equal(web.disposeCalls + web.cancelCalls, 0)
})

test('发现文件：加载时不抢健康运行时的 bridge.json，召唤时接管，卸载只删自己写的', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-session-discovery-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const infoPath = path.join(home, 'personal-assistant', 'bridge.json')
  const approvalPath = path.join(home, 'personal-assistant', 'bridge-approval.json')
  const epochIn = (file: string) => JSON.parse(readFileSync(file, 'utf8')).epoch as string

  const incumbent = new SessionBridge({ dshHome: home })
  const newcomer = new SessionBridge({ dshHome: home })
  t.after(async () => { await incumbent.dispose(); await newcomer.dispose() })
  assert.equal((await incumbent.listen()).advertised, true)
  const yielded = await newcomer.listen()
  assert.equal(yielded.advertised, false)
  assert.equal(yielded.incumbentPid, process.pid)
  assert.equal(epochIn(infoPath), incumbent.epoch)
  newcomer.attachAssistantApprovals(new AssistantApprovalService({ epoch: newcomer.epoch, ttlMs: 1000 }))
  assert.equal(epochIn(approvalPath), incumbent.epoch, '没接管时也不能改写别人的审批凭据')

  await newcomer.bind(fakeAgent('web-5'))
  assert.equal(epochIn(infoPath), newcomer.epoch, '召唤是明确意愿：接管发现文件')
  assert.equal(epochIn(approvalPath), newcomer.epoch)
  await incumbent.dispose()
  assert.equal(epochIn(infoPath), newcomer.epoch, '退出的一方不能删掉接管方的文件')
  await newcomer.dispose()
  assert.equal(existsSync(infoPath), false)
  assert.equal(existsSync(approvalPath), false)

  // 文件还在、但写它的运行时已经不应答（崩溃残留）：新实例直接接手。
  const dead = createServer()
  await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', () => resolve()))
  const deadPort = (dead.address() as { port: number }).port
  await new Promise<void>(resolve => dead.close(() => resolve()))
  mkdirSync(path.dirname(infoPath), { recursive: true })
  writeFileSync(infoPath, JSON.stringify({ port: deadPort, token: 'stale', pid: 999_999, epoch: 'stale-epoch', startedAt: 1 }))
  const heir = new SessionBridge({ dshHome: home })
  t.after(() => heir.dispose())
  assert.equal((await heir.listen()).advertised, true)
  assert.equal(epochIn(infoPath), heir.epoch)
})
