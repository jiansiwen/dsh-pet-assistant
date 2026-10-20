/**
 * M1-06 有归属的后台取消与停止回执。
 *
 * 要钉住的事实：
 *  - 插件队列里的宠物请求可撤回，回执 not-executed；
 *  - 已交给共享主会话的请求只停止等待，回执 unknown，绝不取消整个共享 agent（不误伤网页请求 B）；
 *  - 团队任务对插件持有的子代理定向取消，回执只认真实终止证据（运行结束记录 + dispose 完成）；
 *  - 被取消请求的迟到结果不复活；结果不明的副作用不自动重发；
 *  - HTTP 路由鉴权、未绑定 503 unbound、返回 { state, evidence, message }。
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, type TestContext } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRun, SubagentResult, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { SessionBridge, type BridgeAgent, type BridgeEvent } from '../src/bridge.ts'
import { ApprovalService } from '../src/approval.ts'
import { TeamStore } from '../src/team-domain.ts'
import { TeamService } from '../src/team.ts'

type Ev = { type: string; data: Record<string, unknown> }

interface SharedAgent extends BridgeAgent {
  session: { events: Ev[] }
  followed: string[]
  /** 共享 agent 的整体取消：桥接绝不能调用它。 */
  cancelCalls: number
  cancel(): void
}

/**
 * 共享主会话替身：第一条 followup 开一个不结束的轮次（模拟正在跑），之后的消息只进收件箱。
 * webTurn=true 时先放一个网页发起、仍在执行的轮次 B。
 */
function sharedAgent(opts: { removeReturns?: boolean; enterFirst?: boolean; webTurn?: boolean } = {}): SharedAgent {
  const events: Ev[] = []
  if (opts.webTurn) {
    events.push({ type: 'turn/start', data: { turn: 1 } })
    events.push({ type: 'user/message', data: { id: 'web-b', role: 'user', content: [{ type: 'text', text: '网页里的 B' }], source: { kind: 'user' } } })
  }
  const agent: SharedAgent = {
    session: { events },
    followed: [],
    cancelCalls: 0,
    cancel() { agent.cancelCalls += 1 },
    inbox: { remove: () => opts.removeReturns ?? false },
    followup(message: unknown) {
      const msg = message as { id: string; content: unknown; source: unknown }
      agent.followed.push(msg.id)
      if (opts.enterFirst === false || agent.followed.length > 1) return
      const turn = opts.webTurn ? 2 : 1
      events.push({ type: 'turn/start', data: { turn } })
      events.push({ type: 'user/message', data: { id: msg.id, role: 'user', content: msg.content, source: msg.source } })
    },
  }
  return agent
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

const report = { summary: '分析结果', artifacts: ['来源'], blockers: [], needsApproval: [] }
const completed: SubagentResult = { stopReason: 'completed', output: [], structured: report }

/** 团队替身：与 team-reliability 同口径，子代理启动/结果/释放都可由测试控制。 */
function teamFixture(t: TestContext) {
  const store = new TeamStore(':memory:')
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'test' })
  const requests: SubagentStartRequest[] = []
  const parent = { id: 'parent' } as Agent
  const child = { id: 'child' } as Agent
  Object.assign(child, { ctx: { agent: child, tools: { guard: () => () => undefined } } })
  let disposed = 0
  let result = deferred<SubagentResult>()
  let dispose: () => Promise<void> = async () => { disposed += 1 }
  const host = {
    tools: {
      get: (name: string, scope: unknown) => scope === parent && ['read', 'grep'].includes(name),
      guard: () => () => undefined,
    },
    subagents: {
      start: async (_provider: string, request: SubagentStartRequest): Promise<SubagentRun> => {
        requests.push(request)
        return { id: child.id, localAgent: child, result: result.promise, dispose: () => dispose() }
      },
    },
  }
  const team = new TeamService(host as never, store, {
    teamId: 'test', provider: 'spawn', maxConcurrentInference: 2, maxConcurrentSideEffect: 1,
    taskTimeoutMs: 10_000, defaultBudgetTokens: 0, seats: [], denyExpertTools: [], approvals,
    logger: { info() {}, warn() {}, error() {} },
  })
  team.ensureRoster()
  t.after(async () => { result.resolve(completed); dispose = async () => undefined; await team.dispose(); store.close() })
  return {
    team, store, approvals, parent, requests,
    result: () => result,
    resetResult: () => { result = deferred<SubagentResult>() },
    setDispose: (fn: () => Promise<void>) => { dispose = fn },
    disposed: () => disposed,
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

describe('/chat 主会话请求的定向取消', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'dsh-bridge-cancel-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function arrange(agent: SharedAgent) {
    const replies: BridgeEvent[] = []
    const bridge = new SessionBridge({ dshHome: dir, onEvent: event => { if (event.type === 'reply') replies.push(event) } })
    return { bridge, replies, agent }
  }

  test('排队中的请求可撤回：回执未执行，消息从未交给 agent', async () => {
    const { bridge, replies, agent } = arrange(sharedAgent())
    await bridge.bind(agent)
    bridge.enqueueChat('req-a', '第一条')
    bridge.enqueueChat('req-q', '排队的第二条')
    assert.equal(agent.followed.length, 1, '第二条还在插件队列里')
    const { status, receipt } = await bridge.cancelChat('req-q')
    assert.equal(status, 200)
    assert.equal(receipt.state, 'not-executed')
    assert.equal(receipt.evidence.kind, 'queue-withdrawn')
    assert.equal(agent.followed.length, 1, '撤回的消息不会再交给 agent')
    const reply = replies.find(event => event.id === 'req-q')!
    assert.equal(reply.ok, false)
    assert.equal(reply.cancel?.state, 'not-executed')
    // 重复取消返回同一份回执，不再动队列。
    assert.deepEqual((await bridge.cancelChat('req-q')).receipt, receipt)
    await bridge.dispose()
  })

  test('取消已在共享主会话里运行的 A：只停止等待、回执未知，不取消整个 agent，网页里的 B 不受影响', async () => {
    const { bridge, replies, agent } = arrange(sharedAgent({ webTurn: true }))
    await bridge.bind(agent)
    bridge.enqueueChat('req-a', '宠物发起的 A')
    bridge.enqueueChat('req-next', '排在 A 后面的')
    const { receipt } = await bridge.cancelChat('req-a')
    assert.equal(receipt.state, 'unknown')
    assert.equal(receipt.evidence.kind, 'shared-session')
    assert.match(receipt.message, /后台是否停止未知/)
    assert.match(receipt.message, /不会自动重发/)
    assert.equal(agent.cancelCalls, 0, '共享 agent 的整体取消一次都不能调用')
    // 网页 B 的轮次原封不动：日志里没有任何 turn/end 或中止痕迹。
    assert.equal(agent.session.events.some(event => event.type === 'turn/end'), false)
    assert.equal(agent.followed.length, 2, 'A 不再占着串行位，后面的请求照常注入')
    assert.equal(agent.followed.filter(id => id === agent.followed[0]).length, 1, '取消不会重发 A')
    // A 所在轮次之后正常完成：旧结果不能复活成 A 的成功回复。
    const aMessage = agent.followed[0]
    const aTurn = agent.session.events.find(event => event.type === 'user/message' && event.data.id === aMessage)
    assert.ok(aTurn)
    agent.session.events.push({ type: 'assistant/message', data: { turn: 2, step: 1, message: { id: 'late', role: 'assistant', content: [{ type: 'text', text: '迟到的 A 结果' }] } } })
    agent.session.events.push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    bridge.onAgentIdle(agent)
    const forA = replies.filter(event => event.id === 'req-a')
    assert.equal(forA.length, 1, 'A 只有取消那一条回执')
    assert.equal(forA[0].ok, false)
    assert.equal(replies.some(event => event.ok === true && event.reply === '迟到的 A 结果' && event.id === 'req-a'), false)
    await bridge.dispose()
  })

  test('已注入但尚未被领取、宿主撤回成功：回执未执行', async () => {
    const { bridge, agent } = arrange(sharedAgent({ enterFirst: false, removeReturns: true }))
    await bridge.bind(agent)
    bridge.enqueueChat('req-a', '还在收件箱')
    const { receipt } = await bridge.cancelChat('req-a')
    assert.equal(receipt.state, 'not-executed')
    assert.equal(receipt.evidence.kind, 'inbox-withdrawn')
    assert.equal(agent.cancelCalls, 0)
    await bridge.dispose()
  })

  test('已进入模型的消息不尝试撤回：remove 即便返回 true 也不当成未执行', async () => {
    const { bridge, agent } = arrange(sharedAgent({ removeReturns: true }))
    await bridge.bind(agent)
    bridge.enqueueChat('req-a', '已经进了模型')
    const { receipt } = await bridge.cancelChat('req-a')
    assert.equal(receipt.state, 'unknown')
    assert.equal(receipt.evidence.kind, 'shared-session')
    await bridge.dispose()
  })

  test('已结算的请求再取消：已终止且结果不变；找不到的请求 404 未知', async () => {
    const { bridge, agent } = arrange(sharedAgent())
    await bridge.bind(agent)
    bridge.enqueueChat('req-a', '会正常结束')
    agent.session.events.push({ type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'x', role: 'assistant', content: [{ type: 'text', text: '好了' }] } } })
    agent.session.events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    bridge.onAgentIdle(agent)
    const settled = await bridge.cancelChat('req-a')
    assert.equal(settled.receipt.state, 'terminated')
    assert.equal(settled.receipt.evidence.kind, 'already-settled')
    const missing = await bridge.cancelChat('nobody')
    assert.equal(missing.status, 404)
    assert.equal(missing.receipt.state, 'unknown')
    await bridge.dispose()
  })
})

describe('团队任务的定向取消回执', () => {
  test('未开始的任务：回执未执行，之后不会再被领取', async t => {
    const f = teamFixture(t)
    const task = f.team.submitTask({ goal: '还没开始' })
    const receipt = await f.team.cancelWithReceipt(task.taskId)
    assert.equal(receipt?.state, 'not-executed')
    assert.equal(receipt?.evidence.kind, 'never-started')
    assert.equal(f.team.getTask(task.taskId)?.status, 'cancelled')
    await f.team.runReady(f.parent, new AbortController().signal)
    assert.equal(f.requests.length, 0)
  })

  test('已开始的任务：取得运行结束与 dispose 完成的真实证据，迟到成功不复活', async t => {
    const f = teamFixture(t)
    const task = f.team.submitTask({ goal: '运行中取消' })
    const running = f.team.runTask(task.taskId, f.parent, new AbortController().signal)
    await tick()
    assert.equal(f.team.getTask(task.taskId)?.status, 'running')
    const receipt = await f.team.cancelWithReceipt(task.taskId)
    assert.equal(receipt?.state, 'terminated')
    assert.equal(receipt?.evidence.kind, 'run-ended')
    assert.equal(receipt?.evidence.runs?.length, 1)
    assert.equal(receipt?.evidence.runs?.[0].state, 'cancelled')
    assert.equal(receipt?.evidence.runs?.[0].disposed, true)
    assert.ok(receipt?.evidence.runs?.[0].endedAt)
    assert.equal(f.disposed(), 1)
    assert.equal(f.requests[0]?.signal.aborted, true, '中止信号传到了子代理')
    f.result().resolve(completed)
    await running
    assert.equal(f.team.getTask(task.taskId)?.status, 'cancelled', '迟到的成功结果不能把取消改回去')
    assert.equal(f.store.eventsSince(0).filter(event => event.type === 'run/ended').length, 1)
  })

  test('释放迟迟不完成：如实报取消中，不把等待结束当终止', async t => {
    const f = teamFixture(t)
    const release = deferred<void>()
    f.setDispose(() => release.promise)
    const task = f.team.submitTask({ goal: '释放很慢' })
    const running = f.team.runTask(task.taskId, f.parent, new AbortController().signal)
    await tick()
    const receipt = await f.team.cancelWithReceipt(task.taskId, 20)
    assert.equal(receipt?.state, 'cancelling')
    assert.equal(receipt?.evidence.kind, 'abort-signalled')
    release.resolve()
    await running
    const after = await f.team.cancelWithReceipt(task.taskId)
    assert.equal(after?.state, 'terminated', '释放完成后再查即为已终止')
  })

  test('释放失败：结果未知，不重发', async t => {
    const f = teamFixture(t)
    let attempts = 0
    f.setDispose(async () => { attempts += 1; if (attempts === 1) throw new Error('释放未完成') })
    const task = f.team.submitTask({ goal: '释放失败' })
    const running = f.team.runTask(task.taskId, f.parent, new AbortController().signal)
    await tick()
    const receipt = await f.team.cancelWithReceipt(task.taskId)
    await running
    assert.equal(receipt?.state, 'unknown')
    assert.equal(receipt?.evidence.kind, 'dispose-failed')
    assert.equal(f.requests.length, 1)
  })

  test('已有成功副作用：已部分执行；有结果不明的副作用：结果未知且不自动重发', async t => {
    const f = teamFixture(t)
    const partial = f.team.submitTask({ goal: '做了一半' })
    const run1 = f.team.runTask(partial.taskId, f.parent, new AbortController().signal)
    await tick()
    f.store.insertOperation({ operationId: 'done-op', taskId: partial.taskId, approvalId: null, kind: 'write',
      state: 'succeeded', resultDigest: null, startedAt: 1, endedAt: 2 })
    const partialReceipt = await f.team.cancelWithReceipt(partial.taskId)
    await run1
    assert.equal(partialReceipt?.state, 'partially-executed')
    assert.equal(partialReceipt?.evidence.operations?.[0].state, 'succeeded')

    f.resetResult()
    const uncertain = f.team.submitTask({ goal: '副作用不明' })
    const run2 = f.team.runTask(uncertain.taskId, f.parent, new AbortController().signal)
    await tick()
    f.store.insertOperation({ operationId: 'mid-op', taskId: uncertain.taskId, approvalId: null, kind: 'write',
      state: 'running', resultDigest: null, startedAt: 1, endedAt: null })
    const unknownReceipt = await f.team.cancelWithReceipt(uncertain.taskId)
    await run2
    assert.equal(unknownReceipt?.state, 'unknown')
    assert.equal(f.store.getOperation('mid-op')?.state, 'unknown')
    const before = f.requests.length
    await f.team.runReady(f.parent, new AbortController().signal)
    await f.team.runTask(uncertain.taskId, f.parent, new AbortController().signal)
    assert.equal(f.requests.length, before, '结果不明的任务不会被自动重发')
  })

  test('暂停后续步骤：不领取新运行，恢复后才开始', async t => {
    const f = teamFixture(t)
    f.team.setFollowupsPaused(true)
    const task = f.team.submitTask({ goal: '暂停中' })
    const outcome = await f.team.runTask(task.taskId, f.parent, new AbortController().signal)
    assert.equal(outcome?.task.status, 'queued')
    assert.equal(outcome?.stopReason, 'paused')
    assert.equal(f.requests.length, 0)
    f.team.setFollowupsPaused(false)
    f.result().resolve(completed)
    await f.team.runTask(task.taskId, f.parent, new AbortController().signal)
    assert.equal(f.requests.length, 1)
  })
})

describe('桥接：团队委派请求取消与 HTTP 路由', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'dsh-bridge-cancel-http-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test('点名成员的请求按请求 id 定向取消子代理；取消收尾的 reply/done 不复活成成功', async t => {
    const f = teamFixture(t)
    const replies: BridgeEvent[] = []
    const bridge = new SessionBridge({ dshHome: dir, onEvent: event => { if (event.type === 'reply') replies.push(event) } })
    const agent = sharedAgent()
    await bridge.bind(agent)
    bridge.attachTeam(f.team, f.approvals)
    bridge.bindTeamAgent(f.parent)
    bridge.enqueueChat('req-team', '帮我查一下', 'member-wukong')
    await tick()
    const { status, receipt } = await bridge.cancelChat('req-team')
    assert.equal(status, 200)
    assert.equal(receipt.state, 'terminated')
    assert.equal(receipt.evidence.kind, 'run-ended')
    assert.equal(receipt.evidence.requestId, 'req-team')
    assert.equal(agent.cancelCalls, 0, '团队取消不碰共享主会话')
    assert.equal(agent.followed.length, 0)
    f.result().resolve(completed)
    ;(bridge as unknown as { drainTeamEvents(): void }).drainTeamEvents()
    const forTeam = replies.filter(event => event.id === 'req-team')
    assert.ok(forTeam.length >= 1)
    assert.equal(forTeam.some(event => event.ok === true), false, '被取消的团队请求不出现成功回复')
    await bridge.dispose()
  })

  test('路由鉴权、未绑定 503 unbound，已绑定返回 { state, evidence, message }', async t => {
    const f = teamFixture(t)
    const bridge = new SessionBridge({ dshHome: dir })
    await bridge.listen()
    const info = JSON.parse(readFileSync(path.join(dir, 'personal-assistant', 'bridge.json'), 'utf8')) as { port: number; token: string }
    const post = (route: string, body: unknown, token = info.token) => fetch(`http://127.0.0.1:${info.port}${route}?token=${token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal((await post('/chat/cancel', { id: 'x' }, 'wrong')).status, 401)
    const unbound = await post('/chat/cancel', { id: 'x' })
    assert.equal(unbound.status, 503)
    assert.equal(((await unbound.json()) as { code: string }).code, 'unbound')
    assert.equal((await post('/team/cancel', { taskId: 'x' })).status, 503)

    const agent = sharedAgent()
    await bridge.bind(agent)
    bridge.enqueueChat('req-a', '第一条')
    bridge.enqueueChat('req-q', '排队')
    const withdrawn = await post('/chat/cancel', { id: 'req-q' })
    assert.equal(withdrawn.status, 200)
    const body = await withdrawn.json() as { ok: boolean; state: string; evidence: { kind: string }; message: string }
    assert.equal(body.ok, true)
    assert.equal(body.state, 'not-executed')
    assert.equal(body.evidence.kind, 'queue-withdrawn')
    assert.ok(body.message)
    assert.equal((await post('/chat/cancel', {})).status, 400)

    // 团队没开：/team/cancel 如实 404 + 未知。
    const noTeam = await post('/team/cancel', { taskId: 'nope' })
    assert.equal(noTeam.status, 404)
    assert.equal(((await noTeam.json()) as { state: string }).state, 'unknown')

    bridge.attachTeam(f.team, f.approvals)
    const task = f.team.submitTask({ goal: '从团队页取消' })
    const cancelled = await post('/team/cancel', { taskId: task.taskId })
    assert.equal(cancelled.status, 200)
    assert.equal(((await cancelled.json()) as { state: string }).state, 'not-executed')
    const paused = await post('/team/pause', { paused: true })
    assert.equal(paused.status, 200)
    assert.equal(f.team.followupsPaused, true)
    assert.equal((await post('/team/pause', { paused: 'yes' })).status, 400)
    const snapshot = await (await fetch(`http://127.0.0.1:${info.port}/team?token=${info.token}`)).json() as { paused: boolean }
    assert.equal(snapshot.paused, true)
    assert.equal(agent.cancelCalls, 0)
    await bridge.dispose()
  })
})
