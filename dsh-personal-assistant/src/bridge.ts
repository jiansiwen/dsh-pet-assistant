/**
 * 会话桥接：桌面宠物 ↔ dsh 主会话 ↔ 团队任务。
 *
 * 传输层：node:http 长轮询（零外部依赖）。宠物从 bridge.json 读取端口与 token 后接入：
 *   - POST /chat                 宠物发消息；点名成员时走子代理任务，否则注入主会话
 *   - GET  /events?since=N       长轮询事件流（reply / 团队状态 / session-ended）
 *   - GET/POST /session          原生会话完整消息页／绑定内命令，复用聊天鉴权
 *   - GET  /team                 成员、任务与当前待批准提案的快照
 *   - POST /approval             审批决定，需要独立于聊天令牌的审批凭据
 *   - GET  /health               探活
 *
 * 回复归属：注入主会话的请求按「因果折叠」取回复，不再用整机 idle + 最后一条 assistant 文本猜。
 * handleChat 先用 createUserMessage 造出带稳定 id 的 UserMessage 并记住这个 id，再 followup 注入；
 * onAgentIdle 时在 agent.session.events 里按 id 定位本消息进入的那个轮次（entered），只有该轮次的
 * turn/end 出现、reason.kind==='completed'、且轮次内没有混入其他用户输入（source.kind==='user'）才结算，
 * 标记 attribution='causal'，文本取该轮次内最大 step 的 assistant/message，并保留 turn/step/输出消息 id。
 * 轮次未结束就保持 pending 等下一次 idle；非 completed、混入其他用户输入、来源不明、消息没进入模型都如实
 * 失败，绝不拿别人的轮次或半截输出冒充回复。超时先 inbox.remove(messageId)：撤回成功报 cancelled，已被
 * 领取（remove=false）则报 timeout 且声明后台可能仍在运行、不自动重发，也不 cancel 整个共享 agent。
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
import type { ReportApprovalService, ReportProposal } from './report-approval.ts'
import { SessionMirror, type MirrorEvent, type SessionResult } from './session-mirror.ts'

/** 桥接感知到的最小 agent 形状（注入主会话用；团队委派需要完整 Agent）。 */
export interface BridgeAgent {
  id?: string
  status?: string
  ctx?: { get(name: string): unknown }
  session: {
    id?: string
    events: MirrorEvent[]
  }
  followup(message: unknown): void
  /**
   * 可选收件箱句柄：仅在超时撤回时用。`remove(messageId)` 返回 true 表示这条消息还在等待、
   * 撤回成功（报 cancelled）；返回 false 表示已被领取或已在执行——此时绝不能 cancel 整个共享
   * agent（会误伤网页端正在跑的轮次），只能如实报 timeout。宿主未提供 inbox 时按 false 处理。
   */
  inbox?: {
    remove(messageId: string): boolean
  }
}

export type BridgeEventType =
  | 'reply'
  /** 流式增量：本轮 assistant 的 text-delta 片段，只用于边聊边显示，最终文本仍以 reply 为准。 */
  | 'delta'
  | 'session-ended'
  | 'epoch'
  | 'proactive'
  | 'team/snapshot'
  | 'session/update'
  | TeamEventType

/**
 * 推送给宠物的事件。`id` 是发起请求的 requestId，宠物按它归属气泡。
 */
export interface BridgeEvent {
  seq: number
  epoch: string
  type: BridgeEventType
  id?: string
  /**
   * `delta` 的形态：`text` 正文、`think` 思考过程、`tool` 工具调用、`user` 输入。
   * 缺省按 `text` 处理（早期只出正文时没有这个字段）。
   */
  kind?: 'text' | 'think' | 'tool' | 'user'
  /** `kind === 'tool'` 时的工具名（如 `Read` / `Grep`）。 */
  name?: string
  /** `kind === 'tool'` 时的参数摘要（如 `dsh-pet/README.md`）。 */
  arg?: string
  ok?: boolean
  reply?: string
  /** delta：本次增量的文本片段（显示用，不构成回复）。 */
  text?: string
  error?: string
  /**
   * task：来自子代理运行结果；causal：来自本消息所属轮次的因果折叠（唯一成功的注入归属）；
   * mixed：共享会话里这一轮混入了其他用户输入，拒绝猜测。不再有 interval 猜测归属。
   */
  attribution?: 'task' | 'causal' | 'mixed'
  assistantId?: string
  /** causal 结算保留的轮次与步序，宿主可据此核对归属；输出消息 id 见 assistantId。 */
  turn?: number
  step?: number
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
  /** 注入的 UserMessage 的稳定 id；因果折叠按它在 session.events 里定位本消息所属轮次，超时按它撤回。 */
  messageId: string
  resolve: (reply: { ok: boolean; reply?: string; error?: string }) => void
  timer: NodeJS.Timeout
  /** 流式显示状态：只影响气泡出字，不参与回复归属。 */
  stream: {
    turn: number | null
    /** 已扫到的事件下标；定位到轮次前不前进，免得漏掉进入模型那条。 */
    cursor: number
    stopped: boolean
    timer: NodeJS.Timeout | null
  }
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
  /** 注入回复的超时；缺省 {@link REPLY_TIMEOUT_MS}。测试可注入更短值以驱动超时路径。 */
  replyTimeoutMs?: number
  /**
   * 可选事件观察器：每 push 一条桥接事件就同步回调一次。测试与宿主观测用，
   * 与 HTTP 长轮询事件流并行、互不影响。
   */
  onEvent?: (event: BridgeEvent) => void
}

const REPLY_TIMEOUT_MS = 300_000
const LONG_POLL_TIMEOUT_MS = 25_000
const TEAM_POLL_MS = 400
/** 流式增量扫描间隔。再密没有意义：人眼在这个尺度上已经读不出差别，只是白烧定时器。 */
/**
 * 会话流水的采样拍。定成 120ms 与旧的正文扫描一致：用户看不出「一段推 1 次」与
 * 「一段推 100 次」的差别，但能把上千次事件收敛成几十次。
 */
const FEED_TICK_MS = 120

/**
 * 从 `user/message` 的 content 里抽出可见文本（只取 text 块，附件/图片不算）。
 * 用户输入要同步进宠物对话框，就得先变成一行文字。
 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    const item = block as { type?: unknown; text?: unknown } | null
    if (item && (item.type === 'text' || item.type === 'message') && typeof item.text === 'string') {
      out += item.text
    }
  }
  return out.trim()
}

/**
 * 工具调用的参数摘要：DSH 界面显示的是 `Read · dsh-pet/README.md` 这种「名字 · 第一个参数」，
 * 不是整段 JSON。这里取第一个字符串型参数，长了截断。
 */
function firstArgument(args: unknown): string {
  if (typeof args === 'string') return truncateArg(args)
  if (!args || typeof args !== 'object') return ''
  for (const value of Object.values(args as Record<string, unknown>)) {
    if (typeof value === 'string') return truncateArg(value)
  }
  return ''
}

function truncateArg(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}
const EVENT_RETENTION = 512
/** 排队上限；超出直接拒绝，不让宠物把消息堆进一个永远不会被读的空洞。 */
const MAX_PENDING_REQUESTS = 32

/** 事件载荷里的列表字段一律收窄成字符串数组，模型产出的脏元素不进宠物界面。 */
function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

/** 一条 assistant/message 的可见文本：拼接其 message.content 里的非空 text 块。 */
function messageText(message: unknown): string {
  const content = (message as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? []
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
    .map((block) => block.text as string)
    .join('\n')
    .trim()
}

/** 事件 data 里的数字字段收窄成有限数；缺失或非法一律 NaN，比较时永不命中。 */
function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
}

/** {@link settleFromEvents} 的定位输入：只需要本条消息的稳定 id。 */
export interface CausalPending {
  messageId: string
}

/**
 * {@link settleFromEvents} 的判定：
 * - `pending`：轮次还没结束，保持等待下一次 idle；
 * - `settled`：本消息所属轮次正常完成且不混入其他用户输入，reply 即因果回复；
 * - `failed`：如实失败（未进入模型 / 非 completed / mixed / 来源不明），绝不猜。
 */
export type CausalOutcome =
  | { kind: 'pending' }
  | { kind: 'settled'; reply: string; turn: number; step: number; assistantId?: string }
  | { kind: 'failed'; error: string; attribution?: 'mixed' }

const MIXED_ERROR =
  '共享会话里这一轮混入了其他用户输入，无法分辨哪句是回给你的；请把网页与宠物分开成不同会话，我不会猜'
const UNCERTAIN_ERROR =
  '共享会话里这一轮混入了来源不明的输入，无法确认是不是别的用户插进来的；请把网页与宠物分开成不同会话，我不会猜'

/** turn/end 的 reason.kind 非 completed 时，按具体原因如实描述失败，不含糊成「超时」。 */
function reasonFailure(kind: unknown): string {
  switch (kind) {
    case 'aborted':
      return '这一轮被中断（aborted），没有正常完成；半截输出不当成回复'
    case 'blocked':
      return '这一轮被拦截（blocked），没有产出回复'
    case 'error':
      return '这一轮出错（error），没有正常完成，不当成回复'
    case 'max-tokens':
      return '这一轮达到输出上限（max-tokens），回复可能不完整，不当成正常回复'
    case 'interrupted':
      return '这一轮被标记为中断（interrupted，通常是崩溃后重载关闭的轮次），不当成正常回复'
    default:
      return `这一轮没有正常完成（reason=${String(kind)}），不当成回复`
  }
}

/**
 * 本消息在会话事件日志里的落点，以及它所属的轮次。
 *
 * - `located`：进了模型并且能定位到轮次；
 * - `not-entered`：已经 idle 却没进入模型（被 pre-step 拒绝 / 取消 / 丢弃）；
 * - `no-turn`：进了模型但找不到它属于哪一轮 —— 这种情况不能猜，宁可如实失败。
 *
 * 结算（{@link settleFromEvents}）与流式推送共用这一套判定：两处各写一份，早晚会出现
 * "流式按另一个轮次推文本"，而那种错位在界面上看不出来 —— 用户只会觉得宠物莫名开始打字。
 */
export type TurnLocation =
  | { kind: 'located'; enteredIndex: number; turnStartIndex: number; turn: number }
  | { kind: 'not-entered' }
  | { kind: 'no-turn' }

/**
 * 按消息 id 定位它的轮次。
 *
 * 结算与流式推送共用这一套判定：两处各写一份，早晚会出现"流式按另一个轮次推文本"，
 * 而那种错位在界面上看不出来 —— 用户只会觉得宠物莫名其妙开始打字。
 */
export function locateTurn(events: BridgeAgent['session']['events'], messageId: string): TurnLocation {
  let enteredIndex = -1
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]
    if (event.type === 'user/message' && (event.data as { id?: unknown }).id === messageId) {
      enteredIndex = i
      break
    }
  }
  if (enteredIndex < 0) return { kind: 'not-entered' }
  // 轮次 = entered 之前最近的一条 turn/start（turn/start 在领取输入前打开）。
  for (let i = enteredIndex; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type !== 'turn/start') continue
    const turn = asNumber((event.data as { turn?: unknown }).turn)
    if (!Number.isFinite(turn)) break
    return { kind: 'located', enteredIndex, turnStartIndex: i, turn }
  }
  return { kind: 'no-turn' }
}

export function settleFromEvents(
  events: BridgeAgent['session']['events'],
  pending: CausalPending,
): CausalOutcome {
  const messageId = pending.messageId

  // 1) 定位本消息进入会话日志的位置与所属轮次（与流式推送共用同一套判定）。
  const located = locateTurn(events, messageId)
  if (located.kind === 'not-entered') {
    // 已经 idle 却没进入模型：被 pre-step 拒绝、被取消或被丢弃，没有可归属的轮次；不重试。
    return { kind: 'failed', error: '这条消息没有进入模型（可能已被拦截、取消或丢弃），不会自动重试；请重新发送' }
  }
  if (located.kind === 'no-turn') {
    return { kind: 'failed', error: '无法确定这条消息所属的轮次，不能猜测回复' }
  }
  const { turnStartIndex, turn } = located

  // 3) 该轮次的 turn/end（可能还没出现）。轮次窗口 = (turn/start, turn/end]；未结束则到日志末尾。
  let turnEndIndex = -1
  let reason: unknown = null
  for (let i = turnStartIndex + 1; i < events.length; i += 1) {
    const event = events[i]
    if (event.type === 'turn/end' && asNumber((event.data as { turn?: unknown }).turn) === turn) {
      turnEndIndex = i
      reason = (event.data as { reason?: unknown }).reason
      break
    }
  }
  const windowEnd = turnEndIndex >= 0 ? turnEndIndex : events.length

  // 4) 收集本轮次内的 user/message，判定是否混入了其他用户输入。
  //    只有 source.kind==='user' 是真人输入；plugin/model/tool 是可证明的非用户产物（注入上下文、
  //    模型与工具消息），跳过；缺失或未知来源无法自证清白，判 uncertain。mixed/uncertain 都不猜。
  for (let i = turnStartIndex + 1; i < windowEnd; i += 1) {
    const event = events[i]
    if (event.type !== 'user/message') continue
    const data = event.data as { id?: unknown; source?: { kind?: unknown } }
    if (data.id === messageId) continue
    const sourceKind = data.source?.kind
    if (sourceKind === 'user') return { kind: 'failed', attribution: 'mixed', error: MIXED_ERROR }
    if (sourceKind === 'plugin' || sourceKind === 'model' || sourceKind === 'tool') continue
    return { kind: 'failed', error: UNCERTAIN_ERROR }
  }

  // 5) 轮次没结束：保持 pending，等下一次 idle 再折叠。
  if (turnEndIndex < 0) return { kind: 'pending' }

  // 6) 轮次结束但非 completed：如实失败，即使有文本也不报成功。
  const reasonKind = (reason as { kind?: unknown } | null)?.kind
  if (reasonKind !== 'completed') return { kind: 'failed', error: reasonFailure(reasonKind) }

  // 7) completed 且干净：文本 = 本轮次内最大 step 的 assistant/message 文本拼接，保留 turn/step/输出 id。
  let maxStep = Number.NaN
  const stepTexts = new Map<number, string[]>()
  const stepIds = new Map<number, string[]>()
  for (let i = turnStartIndex + 1; i < turnEndIndex; i += 1) {
    const event = events[i]
    if (event.type !== 'assistant/message') continue
    const data = event.data as { turn?: unknown; step?: unknown; message?: { id?: unknown } }
    if (asNumber(data.turn) !== turn) continue
    const step = asNumber(data.step)
    if (!Number.isFinite(step)) continue
    if (!Number.isFinite(maxStep) || step > maxStep) maxStep = step
    const texts = stepTexts.get(step) ?? []
    texts.push(messageText(data.message))
    stepTexts.set(step, texts)
    if (typeof data.message?.id === 'string') {
      const ids = stepIds.get(step) ?? []
      ids.push(data.message.id)
      stepIds.set(step, ids)
    }
  }

  const reply = (stepTexts.get(maxStep) ?? []).filter((text) => text.length > 0).join('\n').trim()
  if (reply.length === 0) {
    return { kind: 'failed', error: '这一轮正常结束，但没有产出可见文本，我不拿空内容冒充回复' }
  }
  const assistantId = (stepIds.get(maxStep) ?? []).find((id) => typeof id === 'string')
  return { kind: 'settled', reply, turn, step: maxStep, assistantId }
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
  private reportApprovals: ReportApprovalService | null = null
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
  private mirror = new SessionMirror(null, payload => this.push({ type: 'session/update', payload }))

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

  /** 重复召唤同一 agent 保留绑定；换绑先停止旧扫描，隔离在途回执。 */
  async bind(agent: BridgeAgent): Promise<{ port: number; epoch: string }> {
    if (this.closed) throw new Error('bridge already disposed')
    if (agent !== this.agent) {
      this.stopFeed()
      this.mirror.close()
      this.failPending('主会话绑定已变化，旧请求不再结算')
      this.teamAgent = null
      this.agent = agent
      this.mirror = new SessionMirror(agent, payload => this.push({ type: 'session/update', payload }))
    }
    if (!this.server) await this.start()
    if (this.agent === agent && !this.closed) {
      this.scanFeed(agent)
      this.startFeed(agent)
    }
    return { port: this.port, epoch: this.epoch }
  }

  getSession(beforeSeq?: number, bindingId?: string): Promise<SessionResult> {
    const mirror = this.mirror
    return mirror.snapshot(beforeSeq, bindingId, () => { if (this.agent && mirror === this.mirror) this.scanFeed(this.agent) })
  }

  sessionCommand(command: unknown): Promise<SessionResult> {
    const mirror = this.mirror
    return mirror.command(command, () => { if (this.agent && mirror === this.mirror) this.scanFeed(this.agent) })
  }

  /** 全状态来自宿主事件，HTTP 受理或 cancel 回执不能代替运行状态。 */
  onAgentStatus(agent: unknown, status: unknown): void {
    if (!this.agent || agent !== this.agent) return
    this.mirror.setStatus(status)
    this.scanFeed(this.agent)
    if (status === 'idle') this.onAgentIdle(agent)
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
    if (this.server) this.writeApprovalCredential()
    this.notifyApprovalSnapshot()
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
    if (this.server) this.writeApprovalCredential()
    this.notifyApprovalSnapshot()
  }

  attachReportApprovals(service: ReportApprovalService): void {
    this.reportApprovals = service
    if (this.server) this.writeApprovalCredential()
    this.notifyApprovalSnapshot()
  }

  /** 模型可提交待办，不能签发批准；没有可信通道时绝不退回模型自批。 */
  submitReport(reportId: string): ReportProposal {
    if (!this.reportApprovals) throw new Error('日报可信审批未装配，不能发布')
    const proposal = this.reportApprovals.submit(reportId)
    this.notifyApprovalSnapshot()
    return proposal
  }

  pendingReportApprovals(): ReportProposal[] {
    return this.reportApprovals?.pendingProposals() ?? []
  }

  notifyApprovalSnapshot(): void {
    this.push({ type: 'team/snapshot', payload: { epoch: this.epoch, team: this.teamEnabled, ...this.teamSnapshot() } })
  }

  private teamSnapshot(): {
    members: MemberConfig[]
    tasks: Task[]
    running: number
    proposals: (ActionProposal | ReportProposal)[]
  } {
    return {
      members: this.team?.roster() ?? [],
      tasks: this.team?.listTasks().slice(0, 50) ?? [],
      running: this.team?.runningCount() ?? 0,
      // 团队关闭仍保留日报待办，重连快照不依赖事件是否曾被壳接收。
      proposals: [...(this.approvals?.pendingProposals() ?? []), ...this.pendingReportApprovals()],
    }
  }

  /** 把团队发件箱的新事件转成桥接事件；reply/delta 转成 delta 供气泡出字，reply/done 顺带结算对应请求。 */
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
      // 团队委派的出字增量：换成宠物那条已经跑通的 delta 事件，
      // 终端链路（长轮询 → onDelta → chat-delta → 气泡）一处都不用改。
      // 没有这一步，点名成员时只会等 reply/done 才一次性弹出整段。
      if (event.type === 'reply/delta') {
        const requestId = typeof payload.requestId === 'string' ? payload.requestId : null
        const text = typeof payload.text === 'string' ? payload.text : ''
        if (requestId !== null && text.length > 0) this.push({ type: 'delta', id: requestId, text })
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

  /**
   * 拉起桌面宠物（配置了 petDir 时）；返回 false 表示未配置或启动失败。
   *
   * `cmd /c` 是 Windows 专有的：macOS/Linux 上没有 `cmd`，spawn 会以 ENOENT 失败，
   * 而失败被吞成一句日志，用户看到的是"召唤了但宠物不出现"。所以这里按平台挑：
   * POSIX 上直接跑 `pnpm`（它是个 shell 脚本，可执行位由安装时设好）。
   */
  launchPet(): boolean {
    const petDir = this.options.petDir
    if (!petDir) return false
    try {
      const child = process.platform === 'win32'
        ? spawn('cmd', ['/c', 'pnpm', 'start'], {
            cwd: petDir,
            windowsHide: true,
            stdio: 'ignore',
            detached: false,
          })
        : spawn('pnpm', ['start'], {
            cwd: petDir,
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
    this.stopFeed()
    this.mirror.close()
    this.mirror = new SessionMirror(null, payload => this.push({ type: 'session/update', payload }))
    this.mirror.flush()
    this.failPending('主会话已结束')
    this.push({ type: 'session-ended' })
  }

  /**
   * agent 空闲：对当前在飞请求做因果折叠，再放下一条进队请求。
   * 只有本消息所属轮次 turn/end 的 reason.kind==='completed' 且不混入其他用户输入才结算（attribution='causal'）；
   * 轮次未结束保持 pending 等下一次 idle；其余如实失败，绝不拿最后一条 assistant 文本冒充本请求的回复。
   */
  onAgentIdle(agent: unknown): void {
    if (this.agent === null || agent !== this.agent) return
    this.mirror.setStatus('idle')
    this.scanFeed(this.agent)
    if (this.pending === null) return
    const pending = this.pending
    const outcome = settleFromEvents(this.agent.session.events, pending)
    if (outcome.kind === 'pending') return
    this.pending = null
    clearTimeout(pending.timer)
    if (outcome.kind === 'settled') {
      pending.resolve({ ok: true, reply: outcome.reply })
      this.push({
        type: 'reply',
        id: pending.requestId,
        ok: true,
        reply: outcome.reply,
        attribution: 'causal',
        assistantId: outcome.assistantId,
        turn: outcome.turn,
        step: outcome.step,
      })
    } else {
      pending.resolve({ ok: false, error: outcome.error })
      this.push({
        type: 'reply',
        id: pending.requestId,
        ok: false,
        error: outcome.error,
        attribution: outcome.attribution,
      })
    }
    this.pump()
  }

  /** 会话流水的游标：`session.events` 是只增日志，按下标走是安全的。 */
  private feedCursor = 0
  private feedTimer: NodeJS.Timeout | null = null

  /**
   * 会话流水：把 `session.events` 里所有「用户看得见」的活动**按发生顺序**推给宠物。
   *
   * 宠物的对话框要和 DSH 会话完全绑定 —— 网页那边出的思考、工具调用、正文，
   * 以及**两边**的输入，都要同步过来。所以这里跟的是**整个会话**，不是某一条请求：
   *
   * - `user`  —— `user/message`（网页或宠物输入都算）
   * - `think` —— `reasoning-delta`（模型的思考过程）
   * - `tool`  —— `tool/call`（工具名 + 参数摘要）
   * - `text`  —— `text-delta`（可见正文）
   *
   * 与被它替换掉的旧实现的差别：旧的只在「宠物发消息」期间推 `text`，而且只推本轮，
   * 于是网页侧的输入、思考、工具调用全都不见，宠物里只剩一段孤零零的正文。
   *
   * 连续的思考片段合并成一条再发：逐 token 推思考只会把气泡刷成一面墙。
   * 最终正文仍由 {@link settleFromEvents} 折叠给出，宠物收到 reply 后只做收尾标记。
   */
  private scanFeed(agent: BridgeAgent): void {
    if (agent !== this.agent || this.closed) return
    // 旧语音链仍按因果轮次标记；不能把网页轮次挂到恰好在等待的宠物请求。
    const pending = this.pending
    const location = pending ? locateTurn(agent.session.events, pending.messageId) : null
    const attributable = pending && settleFromEvents(agent.session.events, pending).kind !== 'failed'
    const ownedTurn = attributable && location?.kind === 'located' ? location.turn : undefined
    let eventId: string | undefined
    let think = ''
    const emit = (item: { text: string; kind: 'text' | 'think' | 'tool' | 'user'; name?: string; arg?: string }): void => {
      this.push({ type: 'delta', id: eventId, ...item })
    }
    const flushThink = (): void => {
      if (think.length === 0) return
      emit({ text: think, kind: 'think' })
      think = ''
    }
    let events: ReadonlyArray<MirrorEvent>
    try {
      events = agent.session?.events ?? []
    } catch {
      // 读会话失败不该打断请求：本拍跳过，下一拍再试。
      return
    }
    for (let i = this.feedCursor; i < events.length; i += 1) {
      const event = events[i]
      const data = event.data ?? {}
      this.mirror.observe(event, i)
      const nextId = pending && ((event.type === 'user/message' && data.id === pending.messageId)
        || (ownedTurn !== undefined && data.turn === ownedTurn)) ? pending.requestId : undefined
      if (nextId !== eventId) flushThink()
      eventId = nextId
      if (event.type === 'user/message') {
        flushThink()
        const text = contentText(data.content)
        if (text.length > 0) emit({ text, kind: 'user' })
        continue
      }
      if (event.type === 'tool/call') {
        flushThink()
        emit({
          text: '',
          kind: 'tool',
          name: typeof data.name === 'string' ? data.name : '',
          arg: firstArgument(data.arguments),
        })
        continue
      }
      if (event.type === 'assistant/chunk') {
        const chunk = data.chunk as { type?: unknown; text?: unknown } | undefined
        const text = chunk?.text
        if (typeof text !== 'string' || text.length === 0) continue
        if (chunk?.type === 'reasoning-delta') {
          think += text
          continue
        }
        if (chunk?.type === 'text-delta') {
          flushThink()
          emit({ text, kind: 'text' })
          continue
        }
        // block-start/end、usage、finish 不是给人看的，跳过
      }
    }
    flushThink()
    this.feedCursor = events.length
    this.mirror.flush()
  }

  private startFeed(_agent: BridgeAgent): void {
    if (this.feedTimer !== null) return
    const timer = setInterval(() => {
      if (this.closed || !this.agent) return
      try {
        this.scanFeed(this.agent)
      } catch {
        // 读日志失败不打断请求：回复本身仍会照常结算。
      }
    }, FEED_TICK_MS)
    timer.unref?.()
    this.feedTimer = timer
  }

  /**
   * 会话流水是**绑定期全程**的，不跟着某一条请求走：请求结算后网页那边还会继续说，
   * 那些也得同步过来。所以这里只在解绑/销毁时才停。
   */
  private stopFeed(): void {
    if (this.feedTimer !== null) {
      clearInterval(this.feedTimer)
      this.feedTimer = null
    }
    this.feedCursor = 0
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
    this.stopFeed()
    this.mirror.close()
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
    this.writeApprovalCredential()
    this.options.logger?.info(`session bridge listening on 127.0.0.1:${this.port}`)
  }

  /** 凭据不经 IPC 或模型工具暴露；本地文件不是沙箱，不能防任意本地文件读取者。 */
  writeApprovalCredential(approvals: ApprovalService | null = this.approvals): void {
    mkdirSync(path.dirname(this.approvalPath), { recursive: true })
    writeFileSync(
      this.approvalPath,
      `${JSON.stringify({
        approvalToken: approvals?.approvalCapabilityToken,
        reportApprovalToken: this.reportApprovals?.approvalCapabilityToken,
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
    if (request.method === 'POST' && url.pathname === '/report-approval') {
      this.handleReportApproval(request, response).catch(() => this.respond(response, 500, { error: '日报审批结果待核对，请勿重发' }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/approval') {
      this.handleApproval(request, response).catch(() => this.respond(response, 500, { error: 'approval failed' }))
      return
    }
    if (!this.authorized(url)) {
      this.respond(response, 401, url.pathname === '/session' ? { ok: false, error: 'unauthorized' } : { error: 'unauthorized' })
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
    if (url.pathname === '/session' && (request.method === 'GET' || request.method === 'POST')) {
      try {
        const result = request.method === 'POST'
          ? await this.sessionCommand(JSON.parse(await this.readBody(request)))
          : await this.getSession(url.searchParams.has('beforeSeq') ? Number(url.searchParams.get('beforeSeq')) : undefined,
            url.searchParams.get('bindingId') ?? undefined)
        this.respond(response, result.ok ? 200 : 409, result)
      } catch (error) {
        this.respond(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0
      const reset = since < (this.events[0]?.seq ?? 1) - 1 || since > this.seq
      const ready = this.events.filter((event) => event.seq > since)
      if (ready.length > 0 || reset) {
        this.respond(response, 200, { events: ready, epoch: this.epoch, ...(reset ? { reset: true } : {}) })
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
          bindingId?: string
        }
        if (body.bindingId !== undefined && body.bindingId !== this.mirror.bindingId) {
          this.respond(response, 409, { error: 'stale binding' })
          return
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

  private async handleReportApproval(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const service = this.reportApprovals
    if (!service) {
      this.respond(response, 404, { error: '日报可信审批未装配' })
      return
    }
    const header = request.headers['x-dsh-approval-token']
    const token = typeof header === 'string' ? header : undefined
    if (!service.verifyCapabilityToken(token)) {
      this.respond(response, 403, { error: '日报审批凭据无效' })
      return
    }
    try {
      const body = JSON.parse(await this.readBody(request)) as { proposalId?: unknown; decision?: unknown; epoch?: unknown }
      if (typeof body.proposalId !== 'string' || (body.decision !== 'approve' && body.decision !== 'reject')) {
        this.respond(response, 400, { error: '必须指定提案和明确的审批决定' })
        return
      }
      const result = await service.decide(body.proposalId, body.decision, typeof body.epoch === 'string' ? body.epoch : '', token)
      this.push({ type: 'proposal/decided', payload: { proposalId: body.proposalId, kind: 'report', ...result } })
      this.respond(response, result.ok ? 200 : 409, result)
    } catch (error) {
      this.respond(response, error instanceof ApprovalError ? 409 : 400, {
        error: error instanceof ApprovalError ? error.code : 'REPORT_APPROVAL_FAILED',
        message: error instanceof Error ? error.message : '日报审批失败',
      })
    } finally {
      this.notifyApprovalSnapshot()
    }
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
    // 先造消息、留住它的稳定 id：因果折叠按它在 session.events 里定位本消息所属轮次，超时按它撤回。
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      // 宠物面板输入的就是用户本人的话。plugin 来源会被 dsh web 折叠成
      // 「上下文注入」一行，用户在网页上看不到自己说了什么。
      source: { kind: 'user' },
    })
    const messageId = message.id as string
    const timeoutMs = this.options.replyTimeoutMs ?? REPLY_TIMEOUT_MS

    let resolveReply: (reply: { ok: boolean; reply?: string; error?: string }) => void = () => undefined
    const replyPromise = new Promise<{ ok: boolean; reply?: string; error?: string }>((resolve) => {
      resolveReply = resolve
    })
    const timer = setTimeout(() => {
      if (this.pending?.requestId !== requestId) return
      const pending = this.pending
      this.pending = null
      // 先尝试撤回还没被领取的消息；remove=true 才算真的取消成功。
      let removed = false
      try {
        removed = agent.inbox?.remove(messageId) ?? false
      } catch {
        removed = false
      }
      // removed=false：消息已被领取或已在执行。此时不能 cancel 整个共享 agent（会误伤网页端），
      // 只能如实报 timeout，并声明后台可能仍在运行、不自动重发。
      const error = removed
        ? '助理响应超时：已撤回这条还没开始处理的消息（cancelled）'
        : '助理响应超时：消息可能已在后台处理，我不会自动重发，也不会取消整个共享会话'
      pending.resolve({ ok: false, error })
      this.push({ type: 'reply', id: requestId, ok: false, error })
      this.pump()
    }, timeoutMs)
    const pending: PendingRequest = {
      requestId,
      text,
      messageId,
      resolve: resolveReply,
      timer,
      stream: { turn: null, cursor: 0, stopped: false, timer: null },
    }
    this.pending = pending
    try {
      agent.followup(message)
    } catch (error) {
      clearTimeout(pending.timer)
      if (this.pending === pending) this.pending = null
      pending.resolve({ ok: false, error: '消息注入失败' })
      const detail = error instanceof Error ? error.message : String(error)
      this.push({ type: 'reply', id: requestId, ok: false, error: `消息注入失败：${detail}` })
      this.pump()
      return
    }
    this.startFeed(agent)
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
    this.options.onEvent?.(full)
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
