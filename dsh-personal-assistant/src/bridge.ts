/**
 * 会话桥接：桌面宠物 ↔ dsh 主会话 ↔ 团队任务。
 *
 * 传输层：node:http 长轮询（零外部依赖）。宠物从 bridge.json 读取端口与 token 后接入：
 *   - POST /chat                 宠物发消息；点名成员时走子代理任务，否则注入主会话
 *   - GET  /events?since=N       长轮询事件流（reply / 团队状态 / session-ended）
 *   - GET  /team                 成员、任务与当前待批准提案的快照
 *   - POST /approval             审批决定，需要独立于聊天令牌的审批凭据
 *   - GET  /health               探活
 *
 * 回复归属：宿主契约明确 `followup()` 不提供逐消息完成结果，因此注入主会话的请求按
 * 「本请求的收件箱回执 → 下一次整机 idle」这个显式区间取回复，并标记 attribution='interval'；
 * 串行队列保证同一时刻只有一个区间在飞，不会把别人的轮次算到这条请求上。
 * 点名专家时改走 `ctx.subagents.start()`，每次委派有独立 run.result，attribution='task'。
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ActionProposal, MemberConfig, Task, TaskStatus, TeamEvent, TeamEventType } from './team-domain.ts'
import type { TeamService } from './team.ts'
import { ApprovalError, ApprovalService } from './approval.ts'

/** 桥接感知到的最小 agent 形状（注入主会话用；团队委派需要完整 Agent）。 */
export interface BridgeAgent {
  session: {
    events: Array<{ type: string; data: Record<string, unknown> }>
  }
  followup(message: unknown): void
}

export type BridgeEventType =
  | 'reply'
  | 'session-ended'
  | 'epoch'
  | 'proactive'
  | 'team/snapshot'
  | TeamEventType

/**
 * 推送给宠物的事件。`id` 是发起请求的 requestId，宠物按它归属气泡。
 */
export interface BridgeEvent {
  seq: number
  epoch: string
  type: BridgeEventType
  id?: string
  ok?: boolean
  reply?: string
  error?: string
  /** task：来自子代理运行结果；interval：来自显式轮次区间，非因果归属。 */
  attribution?: 'task' | 'interval'
  assistantId?: string
  displayName?: string
  skinId?: string
  taskId?: string
  status?: TaskStatus | string
  artifacts?: readonly string[]
  blockers?: readonly string[]
  needsApproval?: readonly string[]
  payload?: unknown
  /** proactive：气泡文案（design.md §2.7 的固定文案，不是模型生成的）。 */
  message?: string
}

interface PendingRequest {
  requestId: string
  text: string
  resolve: (reply: { ok: boolean; reply?: string; error?: string }) => void
  /** 注入消息时的会话事件数，界定本请求的取回复区间起点。 */
  eventCountAtInject: number
  timer: NodeJS.Timeout
}

interface QueuedRequest {
  requestId: string
  text: string
}

interface EventWaiter {
  seq: number
  res: (events: BridgeEvent[]) => void
  timer: NodeJS.Timeout
}

export interface SessionBridgeOptions {
  /** DSH_HOME（bridge.json 与宠物目录推断用）。 */
  dshHome: string
  /** 桌面宠物工程目录；为空则不自动拉起。 */
  petDir?: string
  logger?: { info(message: string): void; warn?(message: string): void }
}

const REPLY_TIMEOUT_MS = 300_000
const LONG_POLL_TIMEOUT_MS = 25_000
const TEAM_POLL_MS = 400
const EVENT_RETENTION = 512
/** 排队上限；超出直接拒绝，不让宠物把消息堆进一个永远不会被读的空洞。 */
const MAX_PENDING_REQUESTS = 32

/** 事件载荷里的列表字段一律收窄成字符串数组，模型产出的脏元素不进宠物界面。 */
function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

function extractText(events: BridgeAgent['session']['events'], fromIndex: number): string | null {
  for (let i = events.length - 1; i >= fromIndex; i -= 1) {
    const event = events[i]
    if (event.type !== 'assistant/message') continue
    const message = event.data?.message as { content?: Array<{ type: string; text?: string }> } | undefined
    const text = (message?.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return null
}

export class SessionBridge {
  private readonly options: SessionBridgeOptions
  private server: http.Server | null = null
  private port = 0
  private token = ''
  private infoPath = ''
  private approvalPath = ''
  private agent: BridgeAgent | null = null
  private teamAgent: Agent | null = null
  private team: TeamService | null = null
  private approvals: ApprovalService | null = null
  /** 主动提醒的反馈回调：状态机在装配侧，桥接只负责把用户的点选转交过去。 */
  private proactiveFeedback: ((kind: 'accept' | 'decline' | 'disable' | 'enable') => void) | null = null
  /**
   * 宠物上报的桌面状态，主动提醒评估的输入（§2.7：会议/演示/免打扰不提醒）。
   * 桥接断开或重启后回到默认（可见、不专注）—— 宁可多看一眼，不可该提醒时漏掉。
   */
  private petState: { focus: boolean; visible: boolean } = { focus: false, visible: true }
  private teamCursor = 0
  private teamTimer: NodeJS.Timeout | null = null
  private events: BridgeEvent[] = []
  private seq = 0
  private waiters: EventWaiter[] = []
  private pending: PendingRequest | null = null
  private readonly queue: QueuedRequest[] = []
  private readonly inflightTasks = new Map<string, Promise<void>>()
  private closed = false
  readonly epoch = randomUUID()

  constructor(options: SessionBridgeOptions) {
    this.options = options
    const dir = path.join(options.dshHome, 'personal-assistant')
    this.infoPath = path.join(dir, 'bridge.json')
    this.approvalPath = path.join(dir, 'bridge-approval.json')
  }

  get bound(): boolean {
    return this.agent !== null
  }

  get teamEnabled(): boolean {
    return this.team !== null
  }

  /** 绑定主会话并确保 HTTP 服务已启动；重复召唤只更新 agent 引用。 */
  async bind(agent: BridgeAgent): Promise<{ port: number; epoch: string }> {
    if (this.closed) throw new Error('bridge already disposed')
    this.agent = agent
    if (!this.server) await this.start()
    return { port: this.port, epoch: this.epoch }
  }

  /** 团队委派需要完整 Agent 作为父身份；由团队工具在执行上下文里注入。 */
  bindTeamAgent(agent: Agent): void {
    this.teamAgent = agent
  }

  /** 接上团队服务与审批服务，开始转发任务状态事件。 */
  attachTeam(team: TeamService, approvals: ApprovalService): void {
    this.team = team
    this.approvals = approvals
    this.teamCursor = 0
    this.drainTeamEvents()
    if (this.teamTimer === null) {
      this.teamTimer = setInterval(() => this.drainTeamEvents(), TEAM_POLL_MS)
      this.teamTimer.unref()
    }
    this.push({ type: 'team/snapshot', payload: this.teamSnapshot() })
  }

  /**
   * 摘下团队服务：停轮询、清引用、推空快照，宠物界面随之退回单助理形态。
   * 服务的释放（dispose / 关库）由调用方负责——桥接不知道团队任务的清理顺序。
   */
  detachTeam(): void {
    if (this.teamTimer) {
      clearInterval(this.teamTimer)
      this.teamTimer = null
    }
    this.team = null
    this.approvals = null
    this.teamCursor = 0
    this.push({ type: 'team/snapshot', payload: this.teamSnapshot() })
  }

  private teamSnapshot(): {
    members: MemberConfig[]
    tasks: Task[]
    running: number
    proposals: ActionProposal[]
  } {
    if (!this.team) return { members: [], tasks: [], running: 0, proposals: [] }
    return {
      members: this.team.roster(),
      tasks: this.team.listTasks().slice(0, 50),
      running: this.team.runningCount(),
      // 事件流按 since 游标增量重放：桌面壳在 proposal/created 之后才启动或重连，就再也收不到
      // 那条事件。审批必须能被用户看见，所以快照自带当前还等得到决定的提案 —— 重连即重新看到
      // 全部待办，而不是依赖谁都没保证过的事件不丢。
      proposals: this.approvals?.pendingProposals() ?? [],
    }
  }

  /** 把团队发件箱的新事件转成桥接事件；reply/done 顺带结算对应请求。 */
  private drainTeamEvents(): void {
    const team = this.team
    if (!team || this.closed) return
    let batch: TeamEvent[]
    try {
      batch = team.eventsSince(this.teamCursor, 200)
    } catch (error) {
      this.options.logger?.warn?.(`team event drain failed: ${String(error)}`)
      return
    }
    for (const event of batch) {
      this.teamCursor = event.seq
      const payload = (event.payload ?? {}) as Record<string, unknown>
      if (event.type === 'reply/done') {
        const requestId = typeof payload.requestId === 'string' ? payload.requestId : null
        const text = typeof payload.text === 'string' ? payload.text : ''
        if (requestId) this.settleByTask(requestId, text, payload)
      }
      this.push({
        type: event.type,
        id: typeof payload.requestId === 'string' ? payload.requestId : undefined,
        taskId: event.taskId ?? undefined,
        assistantId: event.assistantId ?? undefined,
        displayName: typeof payload.displayName === 'string' ? payload.displayName : undefined,
        skinId: typeof payload.skinId === 'string' ? payload.skinId : undefined,
        status: typeof payload.status === 'string' ? payload.status : undefined,
        payload: event.payload,
      })
    }
  }

  private settleByTask(requestId: string, text: string, payload: Record<string, unknown>): void {
    const queuedIndex = this.queue.findIndex((item) => item.requestId === requestId)
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1)
    const inflight = this.inflightTasks.get(requestId)
    if (inflight) void inflight.then(() => this.inflightTasks.delete(requestId))

    const pending = this.pending
    if (pending && pending.requestId === requestId) {
      clearTimeout(pending.timer)
      this.pending = null
      pending.resolve({ ok: true, reply: text })
      this.pump()
    }

    this.push({
      type: 'reply',
      id: requestId,
      ok: true,
      reply: text,
      attribution: 'task',
      assistantId: typeof payload.assistantId === 'string' ? payload.assistantId : undefined,
      displayName: typeof payload.displayName === 'string' ? payload.displayName : undefined,
      skinId: typeof payload.skinId === 'string' ? payload.skinId : undefined,
      taskId: typeof payload.taskId === 'string' ? payload.taskId : undefined,
      status: typeof payload.status === 'string' ? payload.status : undefined,
      artifacts: stringList(payload.artifacts),
      blockers: stringList(payload.blockers),
      needsApproval: stringList(payload.needsApproval),
    })
  }

  /** 拉起桌面宠物（配置了 petDir 时）；返回 false 表示未配置或启动失败。 */
  launchPet(): boolean {
    const petDir = this.options.petDir
    if (!petDir) return false
    try {
      const child = spawn('cmd', ['/c', 'pnpm', 'start'], {
        cwd: petDir,
        windowsHide: true,
        stdio: 'ignore',
        detached: false,
      })
      child.on('error', (error) => {
        this.options.logger?.info(`launch pet failed: ${String(error)}`)
      })
      return true
    } catch {
      return false
    }
  }

  /** 会话销毁：通知宠物退场并解除绑定；运行时代次不变，重绑后旧请求仍按原区间结算。 */
  onAgentDisposed(agent: unknown): void {
    if (this.agent === null || agent !== this.agent) return
    this.agent = null
    this.teamAgent = null
    this.failPending('主会话已结束')
    this.push({ type: 'session-ended' })
  }

  /**
   * agent 空闲：结算当前在飞请求的区间回复，再放下一条进队请求。
   * 区间内可能包含用户在其他入口触发的轮次，因此标记 attribution='interval'。
   */
  onAgentIdle(agent: unknown): void {
    if (this.agent === null || agent !== this.agent || this.pending === null) return
    const pending = this.pending
    const events = this.agent.session.events
    if (events.length <= pending.eventCountAtInject) return
    const reply = extractText(events, pending.eventCountAtInject)
    if (reply === null) return
    this.pending = null
    clearTimeout(pending.timer)
    pending.resolve({ ok: true, reply })
    this.push({ type: 'reply', id: pending.requestId, ok: true, reply, attribution: 'interval' })
    this.pump()
  }

  /** 宠物消息入口：串行排队，前一条结算后才注入下一条，不再踢掉未完成的请求。 */
  enqueueChat(requestId: string, text: string, assistantId?: string): void {
    if (this.closed) {
      this.push({ type: 'reply', id: requestId, ok: false, error: '助理已停止' })
      return
    }
    const member = assistantId ? this.team?.resolveByName(assistantId) ?? this.team?.member(assistantId) : null
    if (assistantId && !member) {
      this.push({ type: 'reply', id: requestId, ok: false, error: `没有叫「${assistantId}」的成员，也不会替你换人` })
      return
    }
    if (member && this.team && this.teamAgent) {
      const running = this.runTeamTask(requestId, text, member)
      this.inflightTasks.set(requestId, running)
      return
    }
    if (this.queue.length >= MAX_PENDING_REQUESTS) {
      this.push({
        type: 'reply',
        id: requestId,
        ok: false,
        error: `助理正忙（前面还有 ${this.queue.length} 条在排队），这条没有受理，请稍后再发`,
      })
      return
    }
    this.queue.push({ requestId, text })
    this.pump()
  }

  /** 点名成员：建任务 → 子代理执行 → 用 run.result 归属回复。 */
  private runTeamTask(requestId: string, text: string, member: MemberConfig): Promise<void> {
    const team = this.team
    const parent = this.teamAgent
    if (!team || !parent) return Promise.resolve()
    const task = team.submitTask({
      goal: text,
      ownerId: member.assistantId,
      toolScope: member.toolPolicy.mode,
      originRequestId: requestId,
      originChannel: 'desktop-pet',
    })
    this.push({
      type: 'task/created',
      id: requestId,
      taskId: task.taskId,
      assistantId: member.assistantId,
      displayName: member.displayName,
      skinId: member.skinId,
      status: task.status,
      payload: { goal: task.goal },
    })
    const signal = new AbortController().signal
    return team
      .runTask(task.taskId, parent, signal)
      .then(() => undefined)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.push({ type: 'reply', id: requestId, ok: false, error: `${member.displayName}执行失败：${message}`, attribution: 'task' })
      })
  }

  private failPending(error: string): void {
    const pending = this.pending
    if (pending) {
      this.pending = null
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, error })
      this.push({ type: 'reply', id: pending.requestId, ok: false, error })
    }
    for (const item of this.queue.splice(0)) {
      this.push({ type: 'reply', id: item.requestId, ok: false, error })
    }
  }

  /** 队列里还有请求且当前无在飞请求时，注入下一条。 */
  private pump(): void {
    if (this.pending !== null || this.closed) return
    const next = this.queue.shift()
    if (!next) return
    void this.handleChat(next.requestId, next.text).catch(() => undefined)
  }

  /** 插件卸载：通知宠物退场、停团队轮询、关闭服务、清理发现文件。 */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (this.teamTimer) {
      clearInterval(this.teamTimer)
      this.teamTimer = null
    }
    if (this.agent !== null) {
      this.agent = null
      this.push({ type: 'session-ended' })
    }
    this.failPending('助理已停止')
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.res([])
    }
    this.waiters = []
    for (const file of [this.infoPath, this.approvalPath]) {
      try {
        rmSync(file, { force: true })
      } catch {
        // 发现文件可能不存在或属于另一个实例，清理失败不影响退出
      }
    }
    if (this.server) {
      const server = this.server
      this.server = null
      server.close(() => undefined)
    }
  }

  private async start(): Promise<void> {
    this.token = randomUUID()
    const server = http.createServer((request, response) => {
      void this.handle(request, response)
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('bridge server failed to listen')
    this.port = address.port

    mkdirSync(path.dirname(this.infoPath), { recursive: true })
    writeFileSync(
      this.infoPath,
      `${JSON.stringify({
        port: this.port,
        token: this.token,
        pid: process.pid,
        epoch: this.epoch,
        startedAt: Date.now(),
      })}\n`,
      'utf8',
    )
    this.options.logger?.info(`session bridge listening on 127.0.0.1:${this.port}`)
  }

  /** 审批凭据单独落盘，只有桌面壳主进程读它；渲染层拿不到。 */
  writeApprovalCredential(approvals: ApprovalService): void {
    mkdirSync(path.dirname(this.approvalPath), { recursive: true })
    writeFileSync(
      this.approvalPath,
      `${JSON.stringify({
        approvalToken: approvals.approvalCapabilityToken,
        epoch: this.epoch,
        port: this.port,
      })}\n`,
      'utf8',
    )
  }

  private authorized(url: URL): boolean {
    return url.searchParams.get('token') === this.token
  }

  private respond(response: http.ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) {
      response.end()
      return
    }
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }

  private async readBody(request: http.IncomingMessage, limitBytes = 65_536): Promise<string> {
    let raw = ''
    request.setEncoding('utf8')
    for await (const chunk of request) {
      raw += chunk as string
      if (raw.length > limitBytes) throw new Error('request body too large')
    }
    return raw
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.port}`)
    // 审批只认独立凭据：桌面壳只读 bridge-approval.json，拿不到聊天令牌，
    // 所以这条路由必须在聊天令牌校验之前处理，两种凭据互不通用。
    if (request.method === 'POST' && url.pathname === '/approval') {
      this.handleApproval(request, response).catch(() => this.respond(response, 500, { error: 'approval failed' }))
      return
    }
    if (!this.authorized(url)) {
      this.respond(response, 401, { error: 'unauthorized' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      this.respond(response, 200, { ok: true, bound: this.bound, epoch: this.epoch, team: this.teamEnabled })
      return
    }
    if (request.method === 'GET' && url.pathname === '/team') {
      this.respond(response, 200, { epoch: this.epoch, team: this.teamEnabled, ...this.teamSnapshot() })
      return
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0
      const ready = this.events.filter((event) => event.seq > since)
      if (ready.length > 0) {
        this.respond(response, 200, { events: ready, epoch: this.epoch })
        return
      }
      const events = await new Promise<BridgeEvent[]>(resolve => {
        const waiter: EventWaiter = {
          seq: since,
          res: resolve,
          timer: setTimeout(() => {
            this.waiters = this.waiters.filter((item) => item !== waiter)
            resolve([])
          }, LONG_POLL_TIMEOUT_MS),
        }
        this.waiters.push(waiter)
      })
      this.respond(response, 200, { events, epoch: this.epoch })
      return
    }
    if (request.method === 'POST' && url.pathname === '/chat') {
      try {
        const body = JSON.parse(await this.readBody(request)) as {
          requestId?: string
          id?: string
          text?: string
          assistantId?: string
          epoch?: string
        }
        if (typeof body.epoch === 'string' && body.epoch !== this.epoch) {
          this.respond(response, 409, { error: 'stale epoch', epoch: this.epoch })
          return
        }
        const requestId =
          typeof body.requestId === 'string' && body.requestId
            ? body.requestId
            : typeof body.id === 'string' && body.id
              ? body.id
              : randomUUID()
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) {
          this.respond(response, 400, { error: 'empty text' })
          return
        }
        if (this.queue.length >= MAX_PENDING_REQUESTS) {
          this.respond(response, 429, { error: 'too many pending requests' })
          return
        }
        this.enqueueChat(requestId, text, typeof body.assistantId === 'string' ? body.assistantId : undefined)
        this.respond(response, 200, { accepted: true, requestId, epoch: this.epoch })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'malformed body'
        this.respond(response, 400, { error: message })
      }
      return
    }
    if (request.method === 'POST' && (url.pathname === '/proactive/accept' || url.pathname === '/proactive/decline'
      || url.pathname === '/proactive/disable' || url.pathname === '/proactive/enable')) {
      const kind = url.pathname.split('/').pop() as 'accept' | 'decline' | 'disable' | 'enable'
      this.handleProactiveFeedback(request, response, kind)
      return
    }
    if (request.method === 'POST' && url.pathname === '/pet-state') {
      try {
        const body = JSON.parse(await this.readBody(request)) as { focus?: unknown; visible?: unknown }
        if (typeof body.focus === 'boolean') this.petState.focus = body.focus
        if (typeof body.visible === 'boolean') this.petState.visible = body.visible
        this.respond(response, 200, { ok: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'malformed body'
        this.respond(response, 400, { error: message })
      }
      return
    }
    this.respond(response, 404, { error: 'not found' })
  }

  /**
   * 主动提醒的用户反馈（design.md §2.7）。只认聊天令牌：这些端点改变的是提醒节奏，
   * 不触发任何副作用，与 /chat 同级；审批才需要独立凭据。
   */
  private handleProactiveFeedback(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    kind: 'accept' | 'decline' | 'disable' | 'enable',
  ): void {
    void this.readBody(request)
      .then(() => {
        this.proactiveFeedback?.(kind)
        this.respond(response, 200, { ok: true })
      })
      .catch(() => this.respond(response, 400, { error: 'malformed body' }))
  }

  /** 审批只认独立凭据；聊天令牌不能签发批准，模型工具也调不到这里。 */
  private async handleApproval(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const approvals = this.approvals
    if (!approvals) {
      this.respond(response, 404, { error: 'team mode is not enabled' })
      return
    }
    const presented = request.headers['x-dsh-approval-token']
    if (!approvals.verifyCapabilityToken(typeof presented === 'string' ? presented : undefined)) {
      this.respond(response, 403, { error: 'approval credential rejected' })
      return
    }
    try {
      const body = JSON.parse(await this.readBody(request)) as {
        proposalId?: string
        decision?: 'approve' | 'reject'
        epoch?: string
        windowId?: number
      }
      approvals.assertEpoch(typeof body.epoch === 'string' ? body.epoch : '')
      const proposalId = typeof body.proposalId === 'string' ? body.proposalId : ''
      if (!proposalId) {
        this.respond(response, 400, { error: 'proposalId required' })
        return
      }
      if (body.decision === 'approve') {
        const approval = approvals.issue(proposalId, { channel: 'desktop-shell', windowId: body.windowId }, true)
        this.respond(response, 200, { ok: true, approvalId: approval.approvalId, expiresAt: approval.expiresAt })
        return
      }
      approvals.reject(proposalId, { channel: 'desktop-shell', windowId: body.windowId }, true)
      this.respond(response, 200, { ok: true, decision: 'rejected' })
    } catch (error) {
      if (error instanceof ApprovalError) {
        this.respond(response, 409, { error: error.code, message: error.message })
        return
      }
      this.respond(response, 400, { error: error instanceof Error ? error.message : 'malformed body' })
    }
  }

  private async handleChat(requestId: string, text: string): Promise<void> {
    const agent = this.agent
    if (!agent) {
      this.push({ type: 'reply', id: requestId, ok: false, error: '主会话不可用：请先在 dsh 里开启个人助理并召唤宠物' })
      this.pump()
      return
    }
    let resolveReply: (reply: { ok: boolean; reply?: string; error?: string }) => void = () => undefined
    const replyPromise = new Promise<{ ok: boolean; reply?: string; error?: string }>((resolve) => {
      resolveReply = resolve
    })
    const timer = setTimeout(() => {
      if (this.pending?.requestId === requestId) {
        this.pending = null
        resolveReply({ ok: false, error: '助理响应超时（5 分钟）' })
        this.push({ type: 'reply', id: requestId, ok: false, error: '助理响应超时（5 分钟）' })
        this.pump()
      }
    }, REPLY_TIMEOUT_MS)
    const pending: PendingRequest = {
      requestId,
      text,
      resolve: resolveReply,
      eventCountAtInject: agent.session.events.length,
      timer,
    }
    this.pending = pending
    try {
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text }],
          // 宠物面板输入的就是用户本人的话。plugin 来源会被 dsh web 折叠成
          // 「上下文注入」一行，用户在网页上看不到自己说了什么。
          source: { kind: 'user' },
        }),
      )
    } catch (error) {
      clearTimeout(pending.timer)
      if (this.pending === pending) this.pending = null
      pending.resolve({ ok: false, error: '消息注入失败' })
      const message = error instanceof Error ? error.message : String(error)
      this.push({ type: 'reply', id: requestId, ok: false, error: `消息注入失败：${message}` })
      this.pump()
      return
    }
    await replyPromise
  }

  /** 装配侧注入反馈接收器：宠物点「好 / 不用 / 关闭 / 再开」时被调用。 */
  onProactiveFeedback(callback: (kind: 'accept' | 'decline' | 'disable' | 'enable') => void): void {
    this.proactiveFeedback = callback
  }

  /** 最新一次宠物上报的桌面状态（专注 / 可见）。 */
  getPetState(): { focus: boolean; visible: boolean } {
    return { ...this.petState }
  }

  /**
   * 推一条主动提醒气泡。文案来自 proactive.ts 的固定常量，不是模型生成的 ——
   * §2.7 的"不回应就不读取更多资料"靠这一点成立：气泡里没有可被填充的资料位。
   */
  pushProactive(message: string, suggestDisable: boolean): void {
    this.push({ type: 'proactive', message, payload: { suggestDisable } })
  }

  private push(event: Omit<BridgeEvent, 'seq' | 'epoch'>): void {
    this.seq += 1
    const full: BridgeEvent = { ...event, seq: this.seq, epoch: this.epoch }
    this.events.push(full)
    if (this.events.length > EVENT_RETENTION) this.events.splice(0, this.events.length - EVENT_RETENTION)
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.res(this.events.filter((item) => item.seq > waiter.seq))
    }
  }
}

/** 默认 DSH_HOME 推断（与宠物端保持一致）。 */
export function defaultDshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
