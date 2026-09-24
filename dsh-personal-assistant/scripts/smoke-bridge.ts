/**
 * 会话桥接的冒烟验证：HTTP 契约、两种凭据互不通用、串行队列与回复归属。
 *
 * 桥接是宠物与 dsh 之间唯一的通道，它出错的表现是「宠物不说话」或者「把别人的回答算到我头上」，
 * 这两类都只有真跑一遍 HTTP 才看得见。这里用假 agent 顶替主会话、用假宿主顶替子代理，
 * 事件流走真实的长轮询：桥接一 push，阻塞中的 /events 就应当立刻返回。
 *
 * 跑法：npm run smoke
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApprovalError, ApprovalService, type GateCall } from '../src/approval.ts'
import { SessionBridge, type BridgeAgent, type BridgeEvent } from '../src/bridge.ts'
import { ReportStore } from '../src/report.ts'
import { ReportApprovalService } from '../src/report-approval.ts'
import { openAssistantStore } from '../src/store.ts'
import { TeamService, type TeamOptions } from '../src/team.ts'
import { TeamStore } from '../src/team-domain.ts'

/** 假装宿主里存在的工具，名字取自 0.1.1-rc.2 安装产物；只读专家的 deny 名单只能含真实存在的名字。 */
const existingTools = new Set([
  'read', 'read_image', 'glob', 'grep', 'job_list', 'job_output', 'get_goal', 'web_fetch', 'web_search', 'report',
  'bash', 'pwsh', 'write', 'edit', 'str_replace_editor', 'skill', 'job_kill', 'todo_write', 'create_goal', 'update_goal',
  'subagent', 'subagent_fork', 'workflow', 'ralph', 'send_message', 'interrupt_agent',
])
const delegations: Array<Record<string, any>> = []
let expertResult: { output: Array<{ type: string; text?: string }>; structured?: unknown; stopReason: string } = {
  output: [],
  stopReason: 'completed',
}

/** 进程内子代理的最小假形状：installReadOnlyGate 要求 ctx.agent.ctx 指回 ctx 本身。 */
function fakeLocalAgent(id: string) {
  const ctx: any = { tools: { guard: () => () => undefined } }
  ctx.agent = { id, ctx }
  return { id, ctx }
}

const fakeCtx = {
  subagents: {
    start: async (_provider: string, request: Record<string, any>) => {
      delegations.push(request)
      return {
        id: `child-${delegations.length}`,
        // 只读团队只接受进程内 spawn：拿不到 localAgent 的运行会被失败关闭。
        localAgent: fakeLocalAgent(`child-agent-${delegations.length}`),
        result: Promise.resolve(expertResult),
        async dispose() {},
      }
    },
  },
  tools: {
    get: (name: string) => (existingTools.has(name) ? {} : undefined),
    // installDelegationReadOnlyGate 装在宿主 ctx 上；桥接套件不验守卫行为（那是套件一的事）。
    guard: () => () => undefined,
  },
}

const teamOptions: Omit<TeamOptions, 'approvals'> = {
  teamId: 'bridge-smoke-team',
  provider: 'spawn',
  maxConcurrentInference: 2,
  maxConcurrentSideEffect: 1,
  taskTimeoutMs: 60_000,
  // 宿主无法硬约束累计预算：非零预算的任务会在启动前被拒，点名委派就永远跑不起来。
  defaultBudgetTokens: 0,
  seats: [],
  denyExpertTools: ['web_fetch'],
  logger: { info() {}, warn() {}, error() {} },
}

let passed = 0

async function checkAsync(label: string, body: () => Promise<void>): Promise<void> {
  await body()
  passed += 1
  console.log(`  ok   ${label}`)
}

/** 取出抛出的异常本体；没有抛错就算失败。assert.throws 不返回异常，不能拿来当捕获用。 */
function thrownBy(body: () => unknown): unknown {
  try {
    body()
  } catch (error) {
    return error
  }
  return new Error('expected the call to throw, but it returned normally')
}

/** 审批失败一律按错误码断言：message 是给人看的，code 才是执行点的判据。 */
function approvalCode(error: unknown): string {
  if (!(error instanceof ApprovalError)) return `NOT_AN_APPROVAL_ERROR: ${String(error)}`
  return error.code
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-smoke-'))
const infoFile = path.join(dir, 'personal-assistant', 'bridge.json')
const approvalFile = path.join(dir, 'personal-assistant', 'bridge-approval.json')

let base = ''
let token = ''
let port = 0
let cursor = 0
let draining = false
const seen: BridgeEvent[] = []
let activeBridge: SessionBridge | null = null
let activeStore: TeamStore | null = null
let activeReportDb: ReturnType<typeof openAssistantStore> | null = null

interface HttpResult {
  status: number
  body: any
}

async function request(
  method: string,
  pathname: string,
  init: { body?: unknown; token?: string | false; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const query =
    init.token === false ? '' : `${pathname.includes('?') ? '&' : '?'}token=${typeof init.token === 'string' ? init.token : token}`
  const hasBody = init.body !== undefined
  const response = await fetch(`${base}${pathname}${query}`, {
    method,
    headers: {
      // 关掉连接复用：测试结束后服务应当能真正关闭，不留半开连接吊住进程。
      connection: 'close',
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    body: hasBody ? (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : undefined,
  })
  const raw = await response.text()
  return { status: response.status, body: raw === '' ? null : (JSON.parse(raw) as any) }
}

/**
 * 后台长轮询读取器。桥接一 push 就会唤醒所有等待者，所以事件到达时这里立刻返回；
 * 只有在真没事件时才会阻塞到超时，而那正是我们不关心结果的时候。
 */
async function drainLoop(): Promise<void> {
  while (draining) {
    try {
      const result = await request('GET', `/events?since=${cursor}`)
      const events = Array.isArray(result.body?.events) ? (result.body.events as BridgeEvent[]) : []
      for (const event of events) {
        seen.push(event)
        if (event.seq > cursor) cursor = event.seq
      }
    } catch {
      if (!draining) return
      await settle(50)
    }
  }
}

function settle(ms = 200): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function eventsOf(type: string, id?: string): BridgeEvent[] {
  return seen.filter((event) => event.type === type && (id === undefined || event.id === id))
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await settle(30)
  }
  const received = seen.map((event) => `${event.type}${event.id ? `#${event.id}` : ''}`).join(', ')
  throw new Error(`等待超时：${label}；已收到 [${received}]`)
}

const activeAgentEvents: Array<{ type: string; data: Record<string, unknown> }> = []
const injected: Array<{ role: string; sourceKind: string; text: string; id: string }> = []
/** 当前轮次号与步号：followup 开一个新轮次，assistantSays 在其中自增步号。 */
let activeTurn = 0
let activeStep = 0

/** 让主会话在当前轮次「说一句话」：追加一条带 turn/step 的 assistant/message（因果折叠按它取回复）。 */
function assistantSays(text: string): void {
  activeStep += 1
  activeAgentEvents.push({
    type: 'assistant/message',
    data: {
      turn: activeTurn,
      step: activeStep,
      message: {
        id: `assistant-${activeTurn}-${activeStep}`,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'fake', model: 'fake' },
      },
    },
  })
}

/** 关闭当前轮次；reason.kind 默认 completed，也可造 interrupted 等非正常结束。 */
function endActiveTurn(kind = 'completed'): void {
  activeAgentEvents.push({ type: 'turn/end', data: { turn: activeTurn, reason: { kind } } })
}

/** 往当前轮次再塞一条 user/message，模拟共享会话里网页端也插了一句。 */
function injectExtraUser(id: string, sourceKind: unknown = 'user'): void {
  activeAgentEvents.push({
    type: 'user/message',
    data: { id, role: 'user', content: [{ type: 'text', text: '插话' }], source: { kind: sourceKind } },
  })
}

/** 注入之前造一个「别人已问完并答完」的完整轮次，验证因果折叠只认自己那条消息的轮次。 */
function pushHistoryTurn(question: string, answer: string): void {
  activeTurn += 1
  activeStep = 0
  activeAgentEvents.push({ type: 'turn/start', data: { turn: activeTurn } })
  activeAgentEvents.push({
    type: 'user/message',
    data: { id: `history-${activeTurn}`, role: 'user', content: [{ type: 'text', text: question }], source: { kind: 'user' } },
  })
  assistantSays(answer)
  endActiveTurn('completed')
}

const agent: BridgeAgent = {
  session: { events: activeAgentEvents },
  followup(message: unknown) {
    const raw = message as { id?: string; role?: string; source?: { kind?: string }; content?: Array<{ type: string; text?: string }> }
    injected.push({
      role: String(raw.role),
      sourceKind: String(raw.source?.kind),
      id: String(raw.id),
      text: (raw.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join(''),
    })
    // 宿主领取这条消息：开一个新轮次，把消息本体（含真实 id）写进日志，供因果折叠定位。
    activeTurn += 1
    activeStep = 0
    activeAgentEvents.push({ type: 'turn/start', data: { turn: activeTurn } })
    activeAgentEvents.push({
      type: 'user/message',
      data: { id: raw.id, role: raw.role, content: raw.content ?? [], source: raw.source ?? { kind: 'user' } },
    })
  },
}

async function main(): Promise<void> {
  const bridge = new SessionBridge({ dshHome: dir, logger: { info() {} } })
  activeBridge = bridge

  console.log('== 发现文件与鉴权')
  await checkAsync('bind 写发现文件，宠物据此拿到端口、令牌与代次', async () => {
    const bound = await bridge.bind(agent)
    port = bound.port
    base = `http://127.0.0.1:${port}`
    assert.ok(port > 0)
    const info = JSON.parse(readFileSync(infoFile, 'utf8')) as Record<string, unknown>
    token = String(info.token)
    assert.equal(info.port, port)
    assert.equal(info.epoch, bound.epoch)
    assert.equal(info.pid, process.pid)
    assert.ok(Number(info.startedAt) > 0)
    assert.ok(token.length > 0)
    assert.equal(bridge.bound, true)
    draining = true
    void drainLoop()
  })

  await checkAsync('/health 只认聊天令牌，未知路径 404', async () => {
    const ok = await request('GET', '/health')
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body, { ok: true, bound: true, epoch: bridge.epoch, team: false })
    assert.equal((await request('GET', '/health', { token: false })).status, 401)
    assert.equal((await request('GET', '/health', { token: 'not-the-token' })).status, 401)
    assert.equal((await request('GET', '/nope')).status, 404)
  })

  await checkAsync('团队未接上时 /team 是空快照，/approval 明说没启用', async () => {
    const snapshot = await request('GET', '/team')
    assert.equal(snapshot.status, 200)
    assert.deepEqual(snapshot.body, { epoch: bridge.epoch, team: false, members: [], tasks: [], running: 0, proposals: [] })
    const approval = await request('POST', '/approval', { body: { proposalId: 'x', decision: 'approve', epoch: bridge.epoch } })
    assert.equal(approval.status, 404)
    assert.equal(injected.length, 0, '查询类端点不得触碰主会话')
  })

  console.log('\n== 非团队日报审批')
  const reportDb = openAssistantStore(path.join(dir, 'personal-assistant', 'assistant.sqlite'))
  activeReportDb = reportDb
  const reports = new ReportStore(reportDb)
  let reportModeActive = true
  let reportStops = 0
  const reportApprovals = new ReportApprovalService(reportDb, reports, {
    epoch: bridge.epoch,
    reportDir: path.join(dir, 'reports'),
    ttlMs: 60_000,
    active: () => reportModeActive,
    stop: async () => { reportStops += 1; reportModeActive = false },
  })
  const reportId = 'daily:2026-09-18'
  const reportContent = '# 日报审批冒烟\n\n只允许可信 HTTP 批准后发布。\n'
  let reportProposalId = ''
  let reportTarget = ''
  await checkAsync('团队关闭也能提交日报：独立凭据落盘，全文通过事件和重连快照可见', async () => {
    bridge.attachReportApprovals(reportApprovals)
    reports.saveDraft(reportId, reportContent, Date.now())
    const proposal = bridge.submitReport(reportId)
    reportProposalId = proposal.proposalId
    reportTarget = proposal.target
    assert.equal(existsSync(reportTarget), false, '提交不能发布')
    assert.equal(reportStops, 0)
    const credential = JSON.parse(readFileSync(approvalFile, 'utf8'))
    assert.equal(credential.reportApprovalToken, reportApprovals.approvalCapabilityToken)
    assert.equal(credential.approvalToken, undefined, '日报凭据不能依赖团队启用')
    assert.equal(credential.token, undefined)
    assert.notEqual(credential.reportApprovalToken, token)
    assert.equal(readFileSync(infoFile, 'utf8').includes(credential.reportApprovalToken), false)
    const snapshot = await request('GET', '/team')
    assert.equal(snapshot.body.team, false)
    assert.deepEqual(snapshot.body.members, [])
    assert.deepEqual(snapshot.body.proposals, [proposal])
    assert.equal(snapshot.body.proposals[0].content, reportContent)
    assert.equal(JSON.stringify(snapshot.body).includes(credential.reportApprovalToken), false)
    assert.deepEqual((await request('GET', '/team')).body, snapshot.body)
    await waitFor('日报快照事件', () => eventsOf('team/snapshot').some(event =>
      (event.payload as { proposals?: Array<{ proposalId: string }> })?.proposals?.some(item => item.proposalId === reportProposalId) === true))
  })

  await checkAsync('聊天令牌不能批准日报；可信 HTTP 无需聊天令牌，发布一次并拒绝重放', async () => {
    const body = { proposalId: reportProposalId, decision: 'approve', epoch: bridge.epoch }
    const headers = { 'x-dsh-approval-token': reportApprovals.approvalCapabilityToken }
    assert.equal((await request('POST', '/report-approval', { body, token: false })).status, 403)
    assert.equal((await request('POST', '/report-approval', { body })).status, 403)
    assert.equal((await request('POST', '/report-approval', { body, headers: { 'x-dsh-approval-token': token } })).status, 403)
    assert.equal((await request('GET', '/health', { token: reportApprovals.approvalCapabilityToken })).status, 401)
    const stale = await request('POST', '/report-approval', { body: { ...body, epoch: '旧运行时代次' }, headers, token: false })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error, 'EPOCH_MISMATCH')
    assert.equal(existsSync(reportTarget), false)
    assert.equal(reportStops, 0)
    const approved = await request('POST', '/report-approval', { body, headers, token: false })
    assert.equal(approved.status, 200)
    assert.equal(approved.body.confirmed, true)
    assert.equal(approved.body.modeExited, true)
    assert.equal(readFileSync(reportTarget, 'utf8'), reportContent)
    assert.equal(reports.current(reportId)?.state, 'archived')
    assert.equal(reportStops, 1)
    assert.deepEqual((await request('GET', '/team')).body.proposals, [])
    const replay = await request('POST', '/report-approval', { body, headers, token: false })
    assert.equal(replay.status, 409)
    assert.equal(replay.body.error, 'ALREADY_CONSUMED')
    assert.equal(reportStops, 1)
    assert.equal(injected.length, 0, '日报审批不能注入主会话或调用模型')
  })

  console.log('\n== 主会话注入与因果归属')
  await checkAsync('/chat 挡住旧代次、空文本与畸形请求体', async () => {
    const stale = await request('POST', '/chat', { body: { text: '来自已死进程的消息', epoch: 'epoch-of-a-dead-process' } })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.epoch, bridge.epoch, '要把当前代次告诉宠物，它才知道该重连')
    assert.equal((await request('POST', '/chat', { body: { text: '   ' } })).status, 400)
    assert.equal((await request('POST', '/chat', { body: {} })).status, 400)
    assert.equal((await request('POST', '/chat', { body: 'not json' })).status, 400)
    assert.equal(injected.length, 0, '被拒的请求不得注入主会话')
    assert.equal(eventsOf('reply').length, 0)
  })

  await checkAsync('因果折叠：只认本消息进入的轮次，历史轮次不冒充，回复标记 causal', async () => {
    // 注入之前先有一个别人问完答完的完整轮次；因果折叠必须按消息 id 跳过它。
    pushHistoryTurn('别人的问题', '这是别人问出来的回答')
    const accepted = await request('POST', '/chat', { body: { requestId: 'req-causal', text: '今天做了什么' } })
    assert.deepEqual(accepted.body, { accepted: true, requestId: 'req-causal', epoch: bridge.epoch })
    // 宠物消息必须是 user 来源，且桥接要记住它的 id —— 因果折叠全靠这个 id 定位轮次。
    const lastInjected = injected.at(-1)!
    assert.equal(lastInjected.role, 'user')
    assert.equal(lastInjected.sourceKind, 'user', 'plugin 来源会被 dsh web 折叠成「上下文注入」，用户看不到原话')
    assert.equal(lastInjected.text, '今天做了什么')
    assert.ok(lastInjected.id.length > 0, '必须记住注入消息的稳定 id')

    // 本轮次还没结束（无 turn/end）：idle 必须保持 pending，绝不拿历史轮次的回答冒充。
    bridge.onAgentIdle(agent)
    await settle()
    assert.equal(eventsOf('reply', 'req-causal').length, 0, '轮次未结束不得结算，更不得拿历史消息冒充回复')

    // 补完本轮次：assistant 文本 + turn/end completed，才结算。
    assistantSays('今天写了桥接冒烟')
    endActiveTurn('completed')
    bridge.onAgentIdle(agent)
    await waitFor('causal 回复', () => eventsOf('reply', 'req-causal').length === 1)
    const reply = eventsOf('reply', 'req-causal')[0]
    assert.equal(reply.ok, true)
    assert.equal(reply.reply, '今天写了桥接冒烟', '只取本轮次文本，不取历史轮次的「这是别人问出来的回答」')
    assert.equal(reply.attribution, 'causal')
    assert.equal(reply.turn, activeTurn, '结算要落在本消息所属的那个轮次上')
  })

  await checkAsync('共享会话混入其他用户输入：拒绝猜测，标记 mixed', async () => {
    assert.equal((await request('POST', '/chat', { body: { requestId: 'req-mixed', text: '我在宠物上问的' } })).status, 200)
    // 网页端在同一轮次里也插了一句（source.kind 同为 user）——无法分辨回复归属。
    injectExtraUser('web-user-msg', 'user')
    assistantSays('把两个人的问题一起答了')
    endActiveTurn('completed')
    bridge.onAgentIdle(agent)
    await waitFor('mixed 失败', () => eventsOf('reply', 'req-mixed').length === 1)
    const reply = eventsOf('reply', 'req-mixed')[0]
    assert.equal(reply.ok, false)
    assert.equal(reply.attribution, 'mixed')
    assert.match(reply.error ?? '', /分开|混入/)
  })

  await checkAsync('串行队列：上一条没结算时下一条只排队，结算后才注入', async () => {
    const before = injected.length
    for (const [id, text] of [
      ['req-a', '第一条'],
      ['req-b', '第二条'],
      ['req-c', '第三条'],
    ] as Array<[string, string]>) {
      assert.equal((await request('POST', '/chat', { body: { requestId: id, text } })).status, 200)
    }
    assert.equal(injected.length, before + 1, '同一时刻只能有一条在飞')
    assert.equal(injected.at(-1)?.text, '第一条')

    assistantSays('第一条的回答')
    endActiveTurn('completed')
    bridge.onAgentIdle(agent)
    await waitFor('req-a 回复', () => eventsOf('reply', 'req-a').length === 1)
    assert.equal(injected.length, before + 2)
    assert.equal(injected.at(-1)?.text, '第二条')
    assert.equal(eventsOf('reply', 'req-a')[0].reply, '第一条的回答')

    assistantSays('第二条的回答')
    endActiveTurn('completed')
    bridge.onAgentIdle(agent)
    await waitFor('req-b 回复', () => eventsOf('reply', 'req-b').length === 1)
    assert.equal(injected.at(-1)?.text, '第三条')

    assistantSays('第三条的回答')
    endActiveTurn('completed')
    bridge.onAgentIdle(agent)
    await waitFor('req-c 回复', () => eventsOf('reply', 'req-c').length === 1)
    assert.equal(injected.length, before + 3, '队列最终要排空')
    assert.deepEqual(
      seen.filter((event) => event.type === 'reply' && event.attribution === 'causal').map((event) => event.id),
      ['req-causal', 'req-a', 'req-b', 'req-c'],
      '每条成功回复都要落到发起它的那个 requestId 上',
    )
  })

  await checkAsync('点名不存在的成员：立刻回绝，不换人也不注入主会话', async () => {
    const before = injected.length
    assert.equal((await request('POST', '/chat', { body: { requestId: 'req-ghost', text: '帮我查一下', assistantId: '哪吒' } })).status, 200)
    await waitFor('回绝不存在的成员', () => eventsOf('reply', 'req-ghost').length === 1)
    const reply = eventsOf('reply', 'req-ghost')[0]
    assert.equal(reply.ok, false)
    assert.match(reply.error ?? '', /不会替你换人/)
    assert.equal(injected.length, before)
  })

  await checkAsync('排队到上限后直接 429，不再往没人读的空洞里塞消息', async () => {
    const before = injected.length
    assert.equal((await request('POST', '/chat', { body: { requestId: 'req-hold', text: '占住轮次' } })).status, 200)
    assert.equal(injected.at(-1)?.text, '占住轮次')
    for (let index = 0; index < 32; index += 1) {
      const queued = await request('POST', '/chat', { body: { requestId: `req-fill-${index}`, text: `排队 ${index}` } })
      assert.equal(queued.status, 200, `第 ${index} 条应当被受理`)
    }
    const overflow = await request('POST', '/chat', { body: { requestId: 'req-overflow', text: '第 33 条' } })
    assert.equal(overflow.status, 429)
    assert.equal(injected.length, before + 1, '排队的消息一条都不该被注入')
  })

  await checkAsync('主会话销毁：在飞与排队的请求全部有交代，宠物收到 session-ended', async () => {
    bridge.onAgentDisposed({ session: { events: [] }, followup() {} })
    await settle()
    assert.equal(eventsOf('session-ended').length, 0, '别的 agent 销毁不得让当前会话退场')
    assert.equal(bridge.bound, true)

    bridge.onAgentDisposed(agent)
    await waitFor('退场事件', () => eventsOf('session-ended').length === 1)
    assert.equal(bridge.bound, false)
    const failed = seen.filter((event) => event.type === 'reply' && event.ok === false && event.error === '主会话已结束')
    assert.equal(failed.length, 33, '在飞 1 条 + 排队 32 条都要失败退场')
    assert.ok(failed.some((event) => event.id === 'req-hold'))
    assert.ok(failed.some((event) => event.id === 'req-fill-31'))
  })

  await checkAsync('重新绑定沿用同一代次，宠物不必换凭据', async () => {
    const again = await bridge.bind(agent)
    assert.equal(again.epoch, bridge.epoch)
    assert.equal(again.port, port)
    assert.equal(bridge.bound, true)
    assert.equal((await request('GET', '/health')).body.bound, true)
  })

  console.log('\n== 团队委派与审批凭据')
  const store = new TeamStore(path.join(dir, 'desktop-team', 'team.sqlite'))
  activeStore = store
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: bridge.epoch })
  const team = new TeamService(fakeCtx as never, store, { ...teamOptions, approvals })
  team.ensureRoster()

  await checkAsync('接上团队后快照反映真实编制，审批凭据单独落盘', async () => {
    bridge.bindTeamAgent({ session: { id: 'bridge-smoke-parent' } } as never)
    bridge.attachTeam(team, approvals)
    bridge.writeApprovalCredential(approvals)
    assert.equal(bridge.teamEnabled, true)
    await waitFor('团队快照事件', () => eventsOf('team/snapshot').some(event => (event.payload as { team?: boolean })?.team === true))
    assert.equal((await request('GET', '/health')).body.team, true)

    const snapshot = await request('GET', '/team')
    assert.equal(snapshot.body.team, true)
    assert.equal(snapshot.body.members.length, 5)
    assert.equal(snapshot.body.members.filter((member: any) => member.enabled).length, 3)
    assert.equal(snapshot.body.running, 0)
    assert.ok(Array.isArray(snapshot.body.tasks))

    const credential = JSON.parse(readFileSync(approvalFile, 'utf8')) as Record<string, unknown>
    assert.equal(credential.approvalToken, approvals.approvalCapabilityToken)
    assert.equal(credential.reportApprovalToken, reportApprovals.approvalCapabilityToken)
    assert.notEqual(credential.reportApprovalToken, credential.approvalToken)
    assert.equal(credential.epoch, bridge.epoch)
    assert.equal(credential.port, port)
    assert.equal(credential.token, undefined, '审批凭据文件不得混进聊天令牌')
  })

  await checkAsync('重连后快照仍带待批准提案，过期与已决定的不算待办', async () => {
    const task = team.submitTask({ goal: '把结论落盘', ownerId: 'member-tangseng' })
    const pending = approvals.propose({
      taskId: task.taskId,
      assistantId: 'member-tangseng',
      summary: '写入汇总文件',
      tool: 'write',
      target: 'D:/tmp/summary.md',
      params: null,
      inputRevision: task.revision,
      risk: 'low',
    })
    // 负 ttl 造一条窗口已经关掉的提案：它的 state 还停在 pending，因为没人去签发过它。
    const expired = approvals.propose(
      {
        taskId: task.taskId,
        assistantId: 'member-tangseng',
        summary: '窗口已过期的提案',
        tool: 'bash',
        target: 'rm -rf D:/tmp/stale',
        params: null,
        inputRevision: task.revision,
        risk: 'high',
      },
      -1000,
    )

    // 事件流按 since 游标增量重放：桌面壳错过 proposal/created 就再也收不到那条事件。
    // 快照自带待办，重连才等价于重新看到全部待批准事项。
    const proposals = (await request('GET', '/team')).body.proposals as Array<Record<string, unknown>>
    const ids = proposals.map((item) => item.proposalId)
    assert.ok(ids.includes(pending.proposalId), '还等得到决定的提案必须出现在快照里')
    assert.equal(ids.includes(expired.proposalId), false, '过期提案批不动，报出去只会让用户点了拿到 409')

    const card = proposals.find((item) => item.proposalId === pending.proposalId)!
    assert.equal(card.tool, 'write', '审批卡要说清将调用哪个宿主工具，光一句 summary 不够用户判断')
    assert.equal(card.target, 'D:/tmp/summary.md')
    assert.equal(card.assistantId, 'member-tangseng')

    approvals.issue(pending.proposalId, { channel: 'desktop-shell', windowId: 7 }, true)
    const decided = (await request('GET', '/team')).body.proposals as Array<Record<string, unknown>>
    assert.equal(
      decided.some((item) => item.proposalId === pending.proposalId),
      false,
      '已经批准过的不再是待办',
    )
  })

  await checkAsync('点名专家：先出 task/created，再用子代理结果归属回复并带上产物', async () => {
    expertResult = {
      output: [{ type: 'text', text: '兜底文本' }],
      structured: {
        summary: '找到两处空指针',
        artifacts: ['src/a.ts:12 未判空', 'src/b.ts:40 未判空'],
        blockers: [],
        needsApproval: ['需要写入修复补丁'],
      },
      stopReason: 'completed',
    }
    const before = injected.length
    assert.equal((await request('POST', '/chat', { body: { requestId: 'req-wukong', text: '排查空指针', assistantId: '悟空' } })).status, 200)
    assert.equal(injected.length, before, '点名专家不得注入主会话')

    await waitFor('task/created', () => eventsOf('task/created', 'req-wukong').length === 1)
    const created = eventsOf('task/created', 'req-wukong')[0]
    assert.equal(created.assistantId, 'member-wukong')
    assert.equal(created.displayName, '孙悟空')
    assert.equal(created.skinId, 'boy-glasses')
    assert.ok(created.taskId)

    await waitFor('任务回复', () => eventsOf('reply', 'req-wukong').length === 1)
    const reply = eventsOf('reply', 'req-wukong')[0]
    assert.equal(reply.attribution, 'task')
    assert.equal(reply.ok, true)
    assert.equal(reply.status, 'awaiting-approval', '有 needsApproval 的任务停在待批，不伪装完成')
    assert.equal(reply.reply, '找到两处空指针')
    assert.deepEqual(reply.artifacts, ['src/a.ts:12 未判空', 'src/b.ts:40 未判空'], '专家的证据必须传到宠物气泡')
    assert.deepEqual(reply.needsApproval, ['需要写入修复补丁'])
    assert.equal(delegations.length, 1)
    // 工具面是白名单：只有已核实的观测工具进得来；report 留在子代理自身层，不进 restrict。
    const allow = delegations[0].toolFilter.allow as string[]
    for (const name of ['read', 'glob', 'grep']) {
      assert.ok(allow.includes(name), `${name} 是观测工具，禁掉专家就废了`)
    }
    assert.equal(allow.includes('report'), false, 'report 在子代理自身层注册，不能进 restrict 名单')
    assert.equal(allow.includes('web_fetch'), false, 'denyExpertTools 配置追加要生效')
    for (const name of ['bash', 'pwsh', 'write', 'edit', 'str_replace_editor', 'skill', 'job_kill', 'subagent', 'subagent_fork', 'workflow', 'send_message', 'interrupt_agent']) {
      assert.equal(allow.includes(name), false, `${name} 绝不能进 allow 名单：副作用与再委派都不得交给专家`)
    }
    assert.ok((await request('GET', '/team')).body.tasks.length >= 1)
  })

  await checkAsync('点到未启用的席位照样回绝，不降级给别人', async () => {
    assert.equal((await request('POST', '/chat', { body: { requestId: 'req-shaseng', text: '去干点活', assistantId: '沙僧' } })).status, 200)
    await waitFor('回绝未启用席位', () => eventsOf('reply', 'req-shaseng').length === 1)
    const reply = eventsOf('reply', 'req-shaseng')[0]
    assert.equal(reply.ok, false)
    assert.match(reply.error ?? '', /不会替你换人/)
    assert.equal(delegations.length, 1, '未启用席位不得产生委派')
  })

  let proposalId = ''
  let approvedCall: GateCall
  await checkAsync('审批端点只认独立凭据：匿名与聊天令牌都换不来批准', async () => {
    const created = team.submitTask({ goal: '需要副作用的任务', ownerId: 'member-tangseng', toolScope: 'side-effect' })
    // 模拟已领取的调用，不启动真实子代理；批准必须绑定运行中的同一成员、参数与修订。
    const task = store.updateTask(created.taskId, created.revision, { status: 'running' })
    assert.ok(task)
    approvedCall = {
      taskId: task.taskId, assistantId: task.ownerId, tool: 'write', target: 'D:/tmp/report.md',
      params: { mode: 'append' }, inputRevision: task.revision,
    }
    proposalId = approvals.propose({
      ...approvedCall,
      summary: '把结论写进 report.md',
      risk: 'medium',
    }).proposalId
    await waitFor('提案事件转发给宠物', () => eventsOf('proposal/created').length >= 1)

    const body = { proposalId, decision: 'approve', epoch: bridge.epoch }
    const headers = { 'x-dsh-approval-token': approvals.approvalCapabilityToken }
    assert.equal((await request('POST', '/approval', { body })).status, 403)
    assert.equal((await request('POST', '/approval', { body, headers: { 'x-dsh-approval-token': token } })).status, 403, '聊天令牌不是审批凭据')
    assert.equal(store.getProposal(proposalId)?.state, 'pending')

    const staleEpoch = await request('POST', '/approval', { body: { ...body, epoch: 'epoch-stale' }, headers })
    assert.equal(staleEpoch.status, 409)
    assert.equal(staleEpoch.body.error, 'EPOCH_MISMATCH')

    const missing = await request('POST', '/approval', { body: { decision: 'approve', epoch: bridge.epoch }, headers })
    assert.equal(missing.status, 400)
    assert.equal(store.getProposal(proposalId)?.state, 'pending', '各种无效尝试都不得改动提案状态')
  })

  await checkAsync('桌面壳批准后，执行点才拿得到可消费且只能消费一次的批准', async () => {
    const headers = { 'x-dsh-approval-token': approvals.approvalCapabilityToken }
    const approved = await request('POST', '/approval', {
      body: { proposalId, decision: 'approve', epoch: bridge.epoch, windowId: 3 },
      headers,
    })
    assert.equal(approved.status, 200)
    assert.ok(approved.body.approvalId)
    assert.ok(approved.body.expiresAt > Date.now())
    assert.equal(store.getProposal(proposalId)?.state, 'approved')

    // 仅验证执行点记账，不实际调用写入工具。
    const operation = approvals.consumeByProposal(proposalId, 'write', approvedCall)
    assert.equal(operation.state, 'planned')
    assert.equal(operation.kind, 'write')
    assert.equal(approvalCode(thrownBy(() => approvals.consumeByProposal(proposalId, 'write', approvedCall))), 'ALREADY_CONSUMED')
    approvals.settle(operation.operationId, 'succeeded', 'digest-bridge')
    assert.equal(store.getOperation(operation.operationId)?.state, 'succeeded')
    assert.ok(store.updateTask(approvedCall.taskId, approvedCall.inputRevision, { status: 'done' }))
    await waitFor('副作用账目转发给宠物', () => eventsOf('operation/updated').length >= 1)
  })

  await checkAsync('桌面壳拒绝后，执行点拿不到批准', async () => {
    const task = team.submitTask({ goal: '会被拒绝的任务', ownerId: 'member-tangseng' })
    const rejected = approvals.propose({
      taskId: task.taskId,
      assistantId: 'member-tangseng',
      summary: '删掉整个目录',
      tool: 'bash',
      target: 'rm -rf D:/tmp/whole-dir',
      params: null,
      inputRevision: task.revision,
      risk: 'high',
    })
    const result = await request('POST', '/approval', {
      body: { proposalId: rejected.proposalId, decision: 'reject', epoch: bridge.epoch },
      headers: { 'x-dsh-approval-token': approvals.approvalCapabilityToken },
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.decision, 'rejected')
    assert.equal(store.getProposal(rejected.proposalId)?.state, 'rejected')
    assert.equal(approvalCode(thrownBy(() => approvals.consumeByProposal(rejected.proposalId, 'bash'))), 'NOT_FOUND')
    assert.equal(approvals.operations(task.taskId).length, 0, '被拒绝的提案不得留下副作用账目')
  })

  console.log('\n== 主动提醒（§2.7）')
  await checkAsync('proactive 事件与反馈端点：令牌语义、回调归属与状态上报', async () => {
    const feedback: string[] = []
    bridge.onProactiveFeedback(kind => feedback.push(kind))

    // 令牌语义与 /chat 同级：匿名 401，聊天令牌放行。
    assert.equal((await request('POST', '/proactive/decline', { token: false })).status, 401)

    // 推送：文案与建议关闭标志都按原样到达宠物侧事件流。
    bridge.pushProactive('需要我一起看一下吗？', false)
    await waitFor('proactive 事件', () => eventsOf('proactive').length >= 1)
    const event = eventsOf('proactive')[0]
    assert.equal(event.message, '需要我一起看一下吗？')
    assert.equal((event.payload as { suggestDisable?: boolean } | undefined)?.suggestDisable, false)

    // 四种回执都到达装配侧回调，畸形 token 之外的路径不该有惊喜。
    for (const kind of ['accept', 'decline', 'disable', 'enable'] as const) {
      assert.equal((await request('POST', `/proactive/${kind}`)).status, 200)
    }
    await waitFor('四个回执全部到达', () => feedback.length >= 4)
    assert.deepEqual(feedback.slice(0, 4), ['accept', 'decline', 'disable', 'enable'])

    // 宠物状态上报：评估输入靠它实现"专注/隐藏不提醒"。
    assert.equal((await request('POST', '/pet-state', { body: { focus: true, visible: false } })).status, 200)
    assert.deepEqual(bridge.getPetState(), { focus: true, visible: false })
    assert.equal((await request('POST', '/pet-state', { body: { focus: 1 } })).status, 200, '非布尔字段直接忽略')
    assert.deepEqual(bridge.getPetState(), { focus: true, visible: false }, '部分更新不覆盖另一字段')
  })

  await checkAsync('团队凭据与日报凭据互不通用；关闭团队不丢日报待批，仍能可信拒绝回草稿', async () => {
    reports.saveDraft(reportId, `${reportContent}\n- 补充第二版。`, Date.now())
    const pending = bridge.submitReport(reportId)
    const body = { proposalId: pending.proposalId, decision: 'reject', epoch: bridge.epoch }
    assert.equal((await request('POST', '/report-approval', {
      body, token: false, headers: { 'x-dsh-approval-token': approvals.approvalCapabilityToken },
    })).status, 403)
    assert.equal((await request('POST', '/approval', {
      body: { proposalId, decision: 'approve', epoch: bridge.epoch }, token: false,
      headers: { 'x-dsh-approval-token': reportApprovals.approvalCapabilityToken },
    })).status, 403)
    bridge.detachTeam()
    const snapshot = await request('GET', '/team')
    assert.equal(snapshot.body.team, false)
    assert.deepEqual(snapshot.body.members, [])
    assert.deepEqual(snapshot.body.proposals, [pending])
    const credential = JSON.parse(readFileSync(approvalFile, 'utf8'))
    assert.equal(credential.approvalToken, undefined)
    assert.equal(credential.reportApprovalToken, reportApprovals.approvalCapabilityToken)
    const rejected = await request('POST', '/report-approval', {
      body, token: false, headers: { 'x-dsh-approval-token': credential.reportApprovalToken },
    })
    assert.equal(rejected.status, 200)
    assert.equal(rejected.body.decision, 'rejected')
    assert.equal(reports.current(reportId)?.state, 'draft')
    assert.deepEqual((await request('GET', '/team')).body.proposals, [])
    assert.equal(readFileSync(reportTarget, 'utf8'), reportContent, '拒绝新版本不能改动已发布文件')
    assert.equal(reportStops, 1)
  })

  console.log('\n== 退场')
  await checkAsync('dispose 关服务、删两个发现文件，且幂等', async () => {
    draining = false
    await settle(100)
    await team.dispose()
    bridge.dispose()
    bridge.dispose()
    assert.equal(existsSync(infoFile), false)
    assert.equal(existsSync(approvalFile), false)
    await assert.rejects(async () => request('GET', '/health'), '服务必须真的关掉')
    await assert.rejects(async () => bridge.bind(agent), /disposed/)
  })

  store.close()
  activeStore = null
  activeBridge = null
  console.log(`\n全部通过：${passed} 项`)
}

/** 运行器入口：停轮询、关库、删临时目录都要在失败路径上走到，否则 Windows 会挡住目录删除。 */
export async function run(): Promise<void> {
  try {
    await main()
  } catch (error) {
    console.error('\n桥接冒烟失败：', error)
    process.exitCode = 1
  } finally {
    draining = false
    try {
      activeBridge?.dispose()
    } catch {
      // 已经关过了
    }
    try {
      activeStore?.close()
    } catch {
      // 已经关过了
    }
    activeReportDb?.close()
    activeReportDb = null
    activeBridge = null
    activeStore = null
    rmSync(dir, { recursive: true, force: true })
  }
}
