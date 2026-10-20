/**
 * 会话桥接客户端：宠物通过本地 HTTP 长轮询与发起召唤的 dsh 主会话通信。
 *
 * 不再 spawn `dsh --profile headless` —— 宠物没有独立 API key、没有独立会话：
 * 普通输入经 sessionCommand 走宿主原生 queue；chat 保留语音因果回复与团队委派。
 * 历史、模型、凭据复用主会话，session/update 不构成可自动朗读的回复归属。
 * 连接参数来自插件写入的 <DSH_HOME>/personal-assistant/bridge.json。
 *
 * 两条凭据互不通用，这是刻意的：
 * - bridge.json 的 `token` 能发消息、读快照，但**签不出批准**；
 * - bridge-approval.json 的审批令牌只由主进程读取，不经 IPC 或模型工具提供。
 * 这不是操作系统沙箱：任意本地文件读取者仍可能获得它，不能据此宣称防住任意本地攻击。
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  ApprovalDecision,
  BridgeEventPayload,
  DecideApprovalResult,
  TeamSnapshot,
} from '../renderer/types.js'
import type { HealthBody } from './runtime-launch.ts'
import type { CancelReceipt, SessionCommand, SessionResult, SessionSnapshot, SessionUpdate } from '../session-types.ts'
import type { EvidenceIntakeOutcome, EvidenceIntakeRequest } from '../evidence-types.ts'

export interface BridgeInfo {
  port: number
  token: string
  /**
   * 会话代次。可选是因为改造前的 bridge.json 里没有这个字段 ——
   * 用户机器上可能正跑着旧构建，缺了它也得能用，只是失去代次隔离。
   */
  epoch?: string
  /**
   * 写这份文件的运行时进程号与它的启动时刻。
   *
   * 桌面壳用它们判定所有权：退出时只终止自己启动的运行时。光有 pid 不够 —— pid 会被系统回收，
   * 一个无关进程正好占了这个号，杀掉它就是杀掉用户的东西；配上运行时自己写下的 startedAt，
   * 才能区分"我启动的"与"本来就在跑的"。
   */
  pid?: number
  startedAt?: number
}

/** 审批专用凭据。只有主进程读它，不经 IPC 暴露给渲染层。 */
interface ApprovalCredential {
  approvalToken?: string
  reportApprovalToken?: string
  assistantApprovalToken?: string
  epoch?: string
  port?: number
}

export type BridgeStatus = 'connecting' | 'connected' | 'disconnected'

export interface ChatReply {
  ok: boolean
  reply?: string
  error?: string
  /** 这条请求被定向取消时的插件回执；本地停止等待（静音）不会带它。 */
  cancel?: CancelReceipt
}

/** outcome 取自插件：existing（已在线，未抢占）/ reattached / resumed / created。 */
export type SessionStartResult =
  | { ok: true; outcome: string; owned: boolean; resumeError?: string }
  | { ok: false; error: string; code?: string }

export interface BridgeCallbacks {
  onStatus: (status: BridgeStatus) => void
  onSessionEnded: () => void
  /**
   * 每一条桥接事件都会经这里转发。
   * 事件流是**增量**：长轮询断了、桌面壳重启了，中间的事件就永久错过。所以界面不能只靠它 ——
   * 挂载时先 getTeam() 拉一次快照兜底，之后再用事件推进。快照里自带当前全部待批提案，
   * 正是为了让"重连即重新看到待办"，而不是依赖谁都没保证过的事件不丢。
   */
  onEvent: (event: BridgeEventPayload) => void
  /**
   * 会话流水：正文 / 思考过程 / 工具调用 / 用户输入，**按发生顺序**推来。
   *
   * 与 {@link BridgeCallbacks.onEvent} 不同，它不按 requestId 路由 —— 网页侧发起的轮次
   * 没有 requestId，而宠物的对话框要和 DSH 会话完全绑定，那边的一切都得同步过来。
   */
  onChatDelta?: (item: BridgeEventPayload) => void
  /**
   * 主动提醒气泡（design.md §2.7）。固定文案、建议关闭与否都由插件侧决定，
   * 这里只负责送到界面。文案不是模型生成的，界面上也就没有可被注入的资料位。
   */
  onProactive?: (payload: { message: string; suggestDisable: boolean }) => void
}

function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function bridgeInfoPath(): string {
  return path.join(dshHome(), 'personal-assistant', 'bridge.json')
}

function approvalCredentialPath(): string {
  return path.join(dshHome(), 'personal-assistant', 'bridge-approval.json')
}

/** 读取桥接信息；宠物未被召唤（无 bridge.json）时返回 null。 */
export function readBridgeInfo(): BridgeInfo | null {
  try {
    const raw = JSON.parse(readFileSync(bridgeInfoPath(), 'utf8')) as Partial<BridgeInfo>
    if (typeof raw.port === 'number' && raw.port > 0 && typeof raw.token === 'string' && raw.token.length > 0) {
      return {
        port: raw.port,
        token: raw.token,
        epoch: typeof raw.epoch === 'string' && raw.epoch ? raw.epoch : undefined,
        pid: typeof raw.pid === 'number' && raw.pid > 0 ? raw.pid : undefined,
        startedAt: typeof raw.startedAt === 'number' && raw.startedAt > 0 ? raw.startedAt : undefined,
      }
    }
  } catch {
    // 未召唤或文件损坏
  }
  return null
}

/** 读取审批凭据；日报不依赖团队开关，文件缺失时不降级使用聊天令牌。 */
export function readApprovalCredential(): ApprovalCredential | null {
  try {
    const raw = JSON.parse(readFileSync(approvalCredentialPath(), 'utf8')) as Partial<ApprovalCredential>
    const approvalToken = typeof raw.approvalToken === 'string' && raw.approvalToken ? raw.approvalToken : undefined
    const reportApprovalToken = typeof raw.reportApprovalToken === 'string' && raw.reportApprovalToken ? raw.reportApprovalToken : undefined
    const assistantApprovalToken = typeof raw.assistantApprovalToken === 'string' && raw.assistantApprovalToken ? raw.assistantApprovalToken : undefined
    if (approvalToken || reportApprovalToken || assistantApprovalToken) {
      return {
        approvalToken, reportApprovalToken, assistantApprovalToken,
        epoch: typeof raw.epoch === 'string' && raw.epoch ? raw.epoch : undefined,
        port: typeof raw.port === 'number' && raw.port > 0 ? raw.port : undefined,
      }
    }
  } catch {
    // 文件未写入或不可读：保持未授权。
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 快照与审批都是短请求，不能让界面挂在一次卡死的连接上。 */
const SNAPSHOT_TIMEOUT_MS = 4_000
/**
 * 证据收件的超时。比快照宽得多：正文可能有几百 KB，插件那边要算哈希并写库。
 * 4 秒会把一次正常的收件判成失败，用户重试一次就产生两条重复证据。
 */
const INTAKE_TIMEOUT_MS = 30_000
const APPROVAL_TIMEOUT_MS = 10_000
/** 新建会话要等宿主建 agent，比读快照慢得多；恢复失败再新建也在这一次请求里。 */
const SESSION_START_TIMEOUT_MS = 30_000
/** 长轮询服务端 25s 超时返回，客户端要留足余量，否则会先于服务端断开。 */
const LONG_POLL_TIMEOUT_MS = 30_000
/** 定向取消要等插件取证（团队任务最多等 5s 的运行结束与释放），客户端留足余量。 */
const CANCEL_TIMEOUT_MS = 8_000
/** 宠物发起、后台尚未结算的请求记账上限。 */
const OUTSTANDING_LIMIT = 64

/** 本地拿不到插件回执时的如实口径：后台状态未知，不重发。 */
function unknownReceipt(kind: string, message: string, extra: Record<string, unknown> = {}): CancelReceipt {
  return { state: 'unknown', evidence: { kind, at: Date.now(), ...extra }, message }
}

const CANCEL_STATES = ['not-executed', 'cancelling', 'terminated', 'partially-executed', 'unknown']

/**
 * 读一次 `/health`，返回响应体；连不上或响应不是 JSON 时返回 null。
 *
 * 做成模块级函数而不是实例方法：桌面壳在**还没有连接**的时候就要用它判断
 * "是不是已经有活着的运行时该去附着"，那时 BridgeClient 连 info 都没有。
 * 返回值里 epoch 与 team 是契约核对的证据 —— 只返回一个布尔值等于把证据扔了。
 */
export async function probeHealth(info: BridgeInfo): Promise<HealthBody | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health?token=${info.token}`, {
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    })
    if (!response.ok) return null
    return await response.json() as HealthBody
  } catch {
    return null
  }
}

export class BridgeClient {
  private info: BridgeInfo | null = null
  private seq = 0
  private stopped = false
  private pending = new Map<string, { resolve: (reply: ChatReply) => void; onDelta?: (text: string) => void }>()
  /**
   * 宠物经 /chat 发起、后台还没推回 reply 的请求。与 pending 分开：静音或本地停止等待只解除 pending，
   * 后台可能仍在跑，「停止生成」靠这份记账才能按请求 id 定向取消它们。
   */
  private readonly outstanding = new Map<string, { assistantId?: string; startedAt: number }>()
  private callbacks: BridgeCallbacks | null = null
  private sessionBinding: string | null = null
  private sessionCursor = -1
  private sessionGeneration = 0
  private sessionNeedsBaseline = false
  private readonly retiredBindings = new Set<string>()
  private readonly lifetime = new AbortController()

  /**
   * 建立连接：先轮询等待桥接出现（宠物可能比召唤先启动），
   * 连上后启动事件长轮询。永不抛错，状态变化经 onStatus 上报。
   */
  async connect(callbacks: BridgeCallbacks): Promise<void> {
    this.callbacks = callbacks
    while (!this.stopped) {
      const info = readBridgeInfo()
      if (info && await this.healthy(info)) {
        this.info = info
        this.seq = 0
        callbacks.onStatus('connected')
        // 会话基线先于日志回放；团队快照仍独立获取。
        void this.pushSnapshot()
        await this.pushSessionSnapshot()
        if (!this.stopped && this.info === info) void this.pollLoop()
        return
      }
      callbacks.onStatus('connecting')
      await sleep(2000)
    }
  }

  /**
   * 发送一条消息并等待主会话的回复（回复经事件流异步回传）。
   * 传 assistantId 即点名某个成员；名字对不上时服务端会明确报错，不会替你换人。
   *
   * `onDelta` 收到的是**显示用**增量文本：最终回复仍以返回值为准。宿主不吐增量时它一次都不会被调用，
   * 调用方要能接受整段回复一次到达。
   *
   * `signal` 只停止本地等待（静音、换话题、暂停讲解都走它），**不向后台发取消**：后台可能仍在跑。
   * 要停掉后台运行用 {@link cancelChat}（按请求 id 定向取消），回执如实区分未执行 / 取消中 / 已终止 / 未知。
   */
  async chat(text: string, assistantId?: string, signal?: AbortSignal, onDelta?: (text: string) => void, bindingId?: string): Promise<ChatReply> {
    const info = this.info
    if (!info) return { ok: false, error: '未连接到助理运行时：请先从托盘启动团队，或在 dsh 里说"召唤宠物"' }
    const interrupted = (): ChatReply => ({ ok: false, error: signal?.aborted
      ? '已停止等待回复；后台任务是否停止仍需核对，不会自动重发'
      : '助理响应超时，请先核对后台任务状态，不会自动重发' })
    if (signal?.aborted) return interrupted()
    const controller = new AbortController()
    const abortSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const id = `pet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const replyPromise = new Promise<ChatReply>(resolve => this.pending.set(id, { resolve, onDelta }))
    const onAbort = (): void => { this.pending.get(id)?.resolve(interrupted()) }
    abortSignal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), 320_000)
    this.outstanding.set(id, { assistantId, startedAt: Date.now() })
    while (this.outstanding.size > OUTSTANDING_LIMIT) this.outstanding.delete(this.outstanding.keys().next().value as string)
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/chat?token=${info.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: abortSignal,
        body: JSON.stringify({ id, text, assistantId, epoch: info.epoch, bindingId }),
      })
      if (!response.ok) {
        // 明确没受理：后台没有这条请求，不必再取消。
        this.outstanding.delete(id)
        const body = await response.json().catch(() => ({})) as { error?: string }
        if (body.error === 'stale binding') return { ok: false, error: '语音消息的会话绑定已变化，未发送到新会话' }
        if (response.status === 409) {
          this.resetForNewEpoch()
          return { ok: false, error: '助理会话已重启，这条消息没有送达，请重发一次' }
        }
        return { ok: false, error: body.error ?? `桥接返回 ${response.status}` }
      }
      return await replyPromise
    } catch (error) {
      if (abortSignal.aborted) return interrupted()
      return { ok: false, error: `桥接请求失败：${error instanceof Error ? error.message : String(error)}` }
    } finally {
      clearTimeout(timer)
      abortSignal.removeEventListener('abort', onAbort)
      this.pending.delete(id)
    }
  }

  /** 是否还有宠物发起、后台尚未结算的请求（「停止生成」据此选择定向取消还是原生 cancel）。 */
  get hasOutstandingChats(): boolean {
    return this.outstanding.size > 0
  }

  /**
   * 按请求 id 定向取消（POST /chat/cancel）。回执描述后台那次运行的真实状态：
   * 队列里撤回为未执行；已交给共享主会话只停止等待、后台是否停止未知；团队委派带运行结束 / 释放证据。
   * 同时解除这条请求的本地等待，迟到的回复不会再完成它。连不上或没有回执时如实报未知，不重发。
   */
  async cancelChat(id: string): Promise<CancelReceipt> {
    const receipt = await this.postCancel('/chat/cancel', { id }, { requestId: id })
    // 取消中还要能再查一次；其余状态后台已不再归这条请求结算，或无从再取消。
    if (receipt.state !== 'cancelling') this.outstanding.delete(id)
    const entry = this.pending.get(id)
    if (entry) {
      this.pending.delete(id)
      entry.resolve({ ok: false, error: receipt.message, cancel: receipt })
    }
    return receipt
  }

  /** 定向取消全部宠物发起、尚未结算的请求；不碰共享会话里别人的轮次。 */
  async cancelOutstandingChats(): Promise<CancelReceipt[]> {
    return Promise.all([...this.outstanding.keys()].map(id => this.cancelChat(id)))
  }

  /** 按团队任务 id 定向取消插件持有的子代理（POST /team/cancel）。 */
  cancelTeamTask(taskId: string): Promise<CancelReceipt> {
    return this.postCancel('/team/cancel', { taskId }, { taskId })
  }

  /** 暂停 / 恢复团队后续步骤（POST /team/pause）：只挡新的领取，不中止在跑的运行。 */
  async pauseTeam(paused: boolean): Promise<{ ok: boolean; paused: boolean; message: string }> {
    const info = this.info
    if (!info || this.stopped) return { ok: false, paused: false, message: '未连接到助理运行时，没有暂停团队后续步骤' }
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/team/pause?token=${encodeURIComponent(info.token)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused }),
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS)]),
      })
      const body = await response.json().catch(() => ({})) as { ok?: unknown; paused?: unknown; message?: unknown; error?: unknown }
      const message = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `暂停请求返回 ${response.status}`
      return { ok: response.ok && body.ok === true, paused: body.paused === true, message }
    } catch (error) {
      return { ok: false, paused: false, message: `暂停请求没有送达，团队后续步骤状态未变或未知：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private async postCancel(route: string, body: Record<string, string>, target: Record<string, string>): Promise<CancelReceipt> {
    const info = this.info
    if (!info || this.stopped) {
      return unknownReceipt('not-connected', '未连接到助理运行时，取消没有送达；后台状态未知，不会自动重发', target)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}${route}?token=${encodeURIComponent(info.token)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(CANCEL_TIMEOUT_MS)]),
      })
      const parsed = await response.json().catch(() => ({})) as Partial<CancelReceipt> & { error?: unknown; code?: unknown }
      if (typeof parsed.state === 'string' && CANCEL_STATES.includes(parsed.state) && typeof parsed.message === 'string'
        && parsed.evidence && typeof parsed.evidence === 'object' && typeof parsed.evidence.kind === 'string') {
        return { state: parsed.state, evidence: parsed.evidence, message: parsed.message }
      }
      const reason = typeof parsed.message === 'string' ? parsed.message : typeof parsed.error === 'string' ? parsed.error : `取消请求返回 ${response.status}`
      return unknownReceipt(parsed.code === 'unbound' ? 'unbound' : 'no-receipt', `${reason}；后台状态未知，不会自动重发`, target)
    } catch (error) {
      return unknownReceipt('transport-error',
        `取消请求没有得到回执（${error instanceof Error ? error.message : String(error)}）；后台状态未知，不会自动重发`, target)
    }
  }

  /** 最近完整页或绑定内旧页。旧页仅供追加历史，不能替换当前状态。 */
  async getSession(beforeSeq?: number, bindingId?: string): Promise<SessionResult> {
    const info = this.info
    const generation = this.sessionGeneration
    if (!info || this.stopped) return { ok: false, error: '未连接到 dsh 会话' }
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0 || !bindingId)) {
      return { ok: false, error: '历史分页必须提供 beforeSeq 和 bindingId' }
    }
    try {
      const query = new URLSearchParams({ token: info.token })
      if (beforeSeq !== undefined) query.set('beforeSeq', String(beforeSeq))
      if (bindingId !== undefined) query.set('bindingId', bindingId)
      const response = await fetch(`http://127.0.0.1:${info.port}/session?${query}`, {
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS)]),
      })
      const result = await response.json() as SessionResult
      if (this.stopped || this.info !== info || generation !== this.sessionGeneration) return this.staleSession()
      if (!response.ok || !result.ok) return { ok: false, error: result.error ?? `会话读取失败（${response.status}）` }
      const state = result.state
      if (!state || typeof state.bindingId !== 'string' || !Number.isSafeInteger(state.cursor) || !Array.isArray(state.entries)) {
        return { ok: false, error: '桥接未返回有效会话快照' }
      }
      if ((bindingId !== undefined && state.bindingId !== bindingId) || this.retiredBindings.has(state.bindingId)) return this.staleSession()
      if (beforeSeq === undefined) {
        if (state.bindingId === this.sessionBinding && state.cursor < this.sessionCursor) return this.staleSession()
        this.acceptSession(state)
      } else if (this.sessionBinding && state.bindingId !== this.sessionBinding) return this.staleSession()
      return result
    } catch (error) {
      return { ok: false, error: `会话读取失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 普通输入走原生 queue；语音仍使用 chat 的因果终稿，不能朗读无归属的 session/update。 */
  async sessionCommand(command: SessionCommand): Promise<SessionResult> {
    const info = this.info
    const generation = this.sessionGeneration
    if (!info || this.stopped) return { ok: false, error: '未连接到 dsh 会话' }
    if (this.sessionBinding && command.bindingId !== this.sessionBinding) return this.staleSession()
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/session?token=${encodeURIComponent(info.token)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MS)]),
      })
      const result = await response.json() as SessionResult
      if (this.stopped || this.info !== info || generation !== this.sessionGeneration) return this.staleSession()
      if (!response.ok || !result.ok) return { ok: false, error: result.error ?? `会话操作失败（${response.status}）` }
      if (result.state) {
        if (result.state.bindingId !== command.bindingId) return this.staleSession()
        // 操作已成功，但它携带的旧状态不能覆盖更新的增量。
        if (result.state.cursor < this.sessionCursor) return { ok: true }
        this.acceptSession(result.state)
      }
      return result
    } catch (error) {
      return { ok: false, error: `会话操作结果待核对，不会自动重发：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private staleSession(): SessionResult { return { ok: false, error: '会话绑定或快照已变化，旧结果已丢弃' } }

  /** 桥接是否在线（插件已加载即可在线，不代表已绑定会话）。 */
  get connected(): boolean { return this.info !== null && !this.stopped }

  /**
   * 请插件开启或恢复助理会话（POST /session/start）。
   *
   * 已绑定且在线时插件回 existing，不抢网页会话；成功后重拉一次基线，界面以新绑定为准。
   */
  async startSession(): Promise<SessionStartResult> {
    const info = this.info
    if (!info || this.stopped) return { ok: false, error: '还没连上助理运行时，无法开启会话' }
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/session/start?token=${encodeURIComponent(info.token)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(SESSION_START_TIMEOUT_MS)]),
      })
      const body = await response.json().catch(() => ({})) as {
        ok?: boolean; outcome?: string; owned?: boolean; resumeError?: string; error?: string; code?: string
      }
      if (this.stopped || this.info !== info) return { ok: false, error: '桥接已变化，请重试' }
      if (!response.ok || body.ok !== true || typeof body.outcome !== 'string') {
        return { ok: false, error: body.error ?? `开启会话失败（${response.status}）`, code: body.code }
      }
      if (!await this.pushSessionSnapshot()) return { ok: false, error: '会话已开启，但没有取到会话快照，请点“重新同步会话”' }
      return { ok: true, outcome: body.outcome, owned: body.owned === true, resumeError: body.resumeError }
    } catch (error) {
      return { ok: false, error: `开启会话失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private acceptSession(state: SessionSnapshot): void {
    if (state.bindingId !== this.sessionBinding) {
      if (this.sessionBinding) this.retiredBindings.add(this.sessionBinding)
      this.sessionBinding = state.bindingId
      this.sessionGeneration += 1
    }
    this.sessionCursor = state.cursor
  }

  private async pushSessionSnapshot(): Promise<boolean> {
    const result = await this.getSession()
    if (!result.ok || !result.state || this.stopped) return false
    this.callbacks?.onEvent({ type: 'session/update', epoch: this.info?.epoch, payload: { ...result.state, reset: true } })
    this.sessionNeedsBaseline = false
    return true
  }

  async getActivityState(): Promise<{ active: boolean; capturing: boolean; titles: boolean } | null> {
    const info = this.info
    if (!info) return null
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/health?token=${encodeURIComponent(info.token)}`, {
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS)]),
      })
      if (!response.ok || this.info !== info || this.stopped) return null
      const body = await response.json() as { epoch?: string; activity?: { active?: unknown; capturing?: unknown; titles?: unknown } }
      if (this.info !== info || body.epoch !== info.epoch) return null
      const state = body.activity
      return state && typeof state.active === 'boolean' && typeof state.capturing === 'boolean' && typeof state.titles === 'boolean'
        ? { active: state.active, capturing: state.capturing, titles: state.titles } : null
    } catch { return null }
  }

  /** 拉一次团队快照。未连接、未开启团队模式或请求失败都返回 null，界面自己降级。 */
  async getTeam(): Promise<TeamSnapshot | null> {
    const info = this.info
    if (!info) return null
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/team?token=${info.token}`, {
        signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
      })
      if (!response.ok) return null
      const snapshot = await response.json() as TeamSnapshot
      // 团队模式没开时 team=false、members 为空，如实交给界面判断。
      return snapshot
    } catch {
      return null
    }
  }

  /**
   * 回执主动提醒的用户选择（design.md §2.7：不用则本次抑制，反复拒绝建议关闭）。
   * 只认聊天令牌 —— 这些端点不触发任何副作用，与聊天同级。
   * 失败时静默：气泡是锦上添花，点选没送达最多让插件多等一个冷却周期。
   */
  async respondProactive(kind: 'accept' | 'decline' | 'disable' | 'enable'): Promise<void> {
    const info = this.info
    if (!info) return
    try {
      await fetch(`http://127.0.0.1:${info.port}/proactive/${kind}?token=${info.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
      })
    } catch {
      // 静默：见上
    }
  }

  /** 上报桌面状态（专注 / 可见），插件侧的提醒评估靠它实现"会议与免打扰不提醒"。 */
  async reportPetState(state: { focus: boolean; visible: boolean; meeting: boolean }): Promise<void> {
    const info = this.info
    if (!info) return
    try {
      await fetch(`http://127.0.0.1:${info.port}/pet-state?token=${info.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(state),
        signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
      })
    } catch {
      // 静默：状态上报失败只影响一拍评估
    }
  }

  /**
   * 把一份外部证据交给插件（会议纪要 / 窗口文本）。
   *
   * **不能静默失败**：调用方要据此告诉用户"收进去了没有"。所以这里返回结构化结果，
   * 而且把插件给的具体原因（空正文、超上限、类型不符）原样带出来 —— 用户看到的应该是
   * "窗口里没有读到文字"，而不是一句"操作失败"。
   */
  async postEvidenceIntake(request: EvidenceIntakeRequest): Promise<EvidenceIntakeOutcome> {
    const info = this.info
    if (!info) return { ok: false, error: '还没连上个人助理，这份证据没有收进去：请先在 dsh 里召唤宠物或从托盘启动助理团队' }
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/evidence/intake?token=${info.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(INTAKE_TIMEOUT_MS),
      })
      const body = await response.json().catch(() => null) as
        | { ok?: boolean; materialId?: string; duplicate?: boolean; warning?: string | null; error?: string }
        | null
      if (body?.ok === true && typeof body.materialId === 'string') {
        return {
          ok: true,
          materialId: body.materialId,
          duplicate: body.duplicate === true,
          warning: typeof body.warning === 'string' ? body.warning : null,
        }
      }
      // 服务端给了原因就用它的；没给就说 HTTP 码，别编一个像样的理由。
      return { ok: false, error: body?.error ?? `收件失败（HTTP ${response.status}）` }
    } catch (error) {
      return { ok: false, error: `收件请求没能送达个人助理：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * 批准或驳回一个提案。
   *
   * 走独立凭据（bridge-approval.json）；日报分路由使用日报令牌，团队保留原令牌。
   * kind 和 expectedEpoch 来自主进程保存的卡片，不由舞台决定；缺凭据直接拒绝。
   */
  async decideApproval(
    proposalId: string,
    decision: ApprovalDecision,
    windowId?: number,
    kind: 'team' | 'report' | 'assistant' = 'team',
    expectedEpoch?: string,
  ): Promise<DecideApprovalResult> {
    const info = this.info
    if (!info) return { ok: false, error: '未连接到 dsh 会话' }
    const credential = readApprovalCredential()
    const token = kind === 'assistant' ? credential?.assistantApprovalToken
      : kind === 'report' ? credential?.reportApprovalToken : credential?.approvalToken
    if (!token) return { ok: false, error: '没有这类操作的审批凭据，请重新连接助理' }
    if (!credential?.epoch || credential.epoch !== info.epoch
      || (kind === 'assistant' && credential.port !== info.port)
      || (expectedEpoch !== undefined && expectedEpoch !== info.epoch)) {
      return { ok: false, error: '审批所属会话已变化，请重新查看待办' }
    }
    const route = kind === 'assistant' ? '/assistant-approval' : kind === 'report' ? '/report-approval' : '/approval'
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}${route}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dsh-approval-token': token,
        },
        signal: AbortSignal.timeout(APPROVAL_TIMEOUT_MS),
        body: JSON.stringify({
          proposalId,
          decision,
          epoch: credential.epoch ?? info.epoch,
          windowId,
        }),
      })
      const body = await response.json().catch(() => ({})) as Partial<DecideApprovalResult>
      if (response.ok && body.ok === true) {
        return {
          ok: true, approvalId: body.approvalId, decision: body.decision,
          confirmed: body.confirmed, savedPath: body.savedPath, revision: body.revision,
          digest: body.digest, modeExited: body.modeExited, message: body.message,
        }
      }
      // 审批的 409 几乎都是业务态：提案不存在、已被消费、已过期。这些要原样告诉用户，
      // 不该拆连接。只有 EPOCH_MISMATCH 说明会话真的换代了，才需要重新发现桥接。
      if (response.status === 409 && body.error === 'EPOCH_MISMATCH') {
        this.resetForNewEpoch()
        return { ok: false, error: '助理会话已重启，这个批准请求已失效，请重新查看待办' }
      }
      return {
        ok: false,
        error: body.message ?? body.error ?? `审批被拒绝（${response.status}）`,
      }
    } catch (error) {
      return { ok: false, error: `审批请求失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  dispose(): void {
    this.stopped = true
    this.sessionGeneration += 1
    this.lifetime.abort()
    for (const entry of this.pending.values()) {
      entry.resolve({ ok: false, error: '宠物正在退出' })
    }
    this.pending.clear()
  }

  private async healthy(info: BridgeInfo): Promise<boolean> {
    const health = await probeHealth(info)
    return health?.ok === true
  }

  /** 连上就推一次快照，包成 team/snapshot 事件走同一条转发路径，界面只需要认事件。 */
  private async pushSnapshot(): Promise<void> {
    const snapshot = await this.getTeam()
    if (!snapshot) return
    this.callbacks?.onEvent({ type: 'team/snapshot', payload: snapshot })
  }

  /**
   * 代次失效：清掉连接信息与事件游标，让 connect() 的轮询重新发现桥接。
   * 不重连的话后续请求会一直打在旧代上，用户看到的是一片永远不更新的界面。
   */
  private resetForNewEpoch(): void {
    this.info = null
    this.seq = 0
    this.sessionGeneration += 1
    // 新代次的运行时不认识旧请求 id，留着只会让「停止生成」去取消不存在的东西。
    this.outstanding.clear()
    for (const entry of this.pending.values()) {
      entry.resolve({ ok: false, error: '助理会话已重启，这条消息没有送达' })
    }
    this.pending.clear()
    this.callbacks?.onStatus('connecting')
    void this.reconnect()
  }

  private async reconnect(): Promise<void> {
    while (!this.stopped && !this.info) {
      const info = readBridgeInfo()
      if (info && await this.healthy(info)) {
        this.info = info
        this.seq = 0
        this.callbacks?.onStatus('connected')
        void this.pushSnapshot()
        await this.pushSessionSnapshot()
        if (!this.stopped && this.info === info) void this.pollLoop()
        return
      }
      await sleep(2000)
    }
  }

  /** 事件长轮询：reply 分发给等待中的 chat()；桥接消失即视为会话结束 → 退场。 */
  private async pollLoop(): Promise<void> {
    while (!this.stopped && this.info) {
      const info = this.info
      let body: { events?: BridgeEventPayload[]; epoch?: string; reset?: boolean }
      try {
        const response = await fetch(
          `http://127.0.0.1:${info.port}/events?token=${info.token}&since=${this.seq}`,
          { signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(LONG_POLL_TIMEOUT_MS + 5_000)]) },
        )
        if (!response.ok) throw new Error(`events ${response.status}`)
        body = await response.json() as typeof body
      } catch {
        if (this.stopped || this.info !== info) return
        // 网络失败不等于原生会话已结束；恢复后重新拉基线，不重发输入。
        this.info = null
        this.sessionGeneration += 1
        this.callbacks?.onStatus('disconnected')
        for (const entry of this.pending.values()) entry.resolve({ ok: false, error: '连接中断，后台任务结果待核对，不会自动重发' })
        this.pending.clear()
        void this.reconnect()
        return
      }
      if (this.stopped || this.info !== info) return
      // 代次不符 = 桥接换了会话。旧游标对新代毫无意义，丢掉重来。
      if (typeof body.epoch === 'string' && info.epoch && body.epoch !== info.epoch) {
        this.resetForNewEpoch()
        return
      }
      // ring 中可能还留着旧绑定的 reset：不相信其载荷，始终向当前服务取基线。
      if (body.reset || (body.events ?? []).some(event => {
        const update = event.payload as SessionUpdate | undefined
        return event.type === 'session/update' && update && ((update.reset && update.cursor > this.sessionCursor) || update.bindingId !== this.sessionBinding)
      })) {
        this.sessionNeedsBaseline = true
        // 发现换绑或缺口即使旧读失效，不等新快照到达才隔离在途请求。
        this.sessionGeneration += 1
      }
      if (this.sessionNeedsBaseline) {
        await this.pushSessionSnapshot()
        if (this.stopped || this.info !== info) return
      }
      if (body.reset && !body.events?.length) this.seq = 0
      for (const event of body.events ?? []) {
        if (typeof event.seq === 'number' && event.seq > this.seq) this.seq = event.seq
        if (event.type === 'session/update') {
          const update = event.payload as SessionUpdate | undefined
          if (this.sessionNeedsBaseline || !update || update.bindingId !== this.sessionBinding || update.reset || update.cursor <= this.sessionCursor) continue
          this.sessionCursor = update.cursor
          this.callbacks?.onEvent(event)
          continue
        }
        if (event.type === 'reply' && typeof event.id === 'string') {
          // 后台已为这条请求推过结论（含取消回执）：不再需要定向取消。
          this.outstanding.delete(event.id)
          this.pending.get(event.id)?.resolve({
            ok: event.ok ?? false,
            reply: event.reply,
            error: event.error,
          })
          this.pending.delete(event.id)
        } else if (event.type === 'delta' && typeof event.text === 'string') {
          // 会话流水广播给界面：网页侧的轮次没有 requestId，不能按 id 路由，
          // 而宠物要和 DSH 会话完全绑定 —— 那边的输入、思考、工具调用、正文都得按顺序显示。
          this.callbacks?.onChatDelta?.(event)
          // 正文按请求归属喂语音：只有宠物自己发起的那轮才有 pending。
          if (typeof event.id === 'string' && (event.kind ?? 'text') === 'text') {
            this.pending.get(event.id)?.onDelta?.(event.text)
          }
        } else if (event.type === 'session-ended') {
          // 会话结束不等于桥接消失：插件仍在线（未绑定），之后网页召唤或桌面开启的新会话都从这条事件流到达，
          // 所以继续轮询；未绑定的空快照随同一批事件到达，不必再伪报"连接断开"。
          this.callbacks?.onSessionEnded()
          continue
        } else if (event.type === 'proactive') {
          const message = typeof event.message === 'string' ? event.message : ''
          const payload = (event.payload ?? {}) as { suggestDisable?: unknown }
          if (message) {
            this.callbacks?.onProactive?.({ message, suggestDisable: payload.suggestDisable === true })
          }
          continue
        }
        // 团队事件（含 reply）一律转发给界面：事件流是唯一能让界面跟上任务进度的通道。
        this.callbacks?.onEvent(event)
      }
    }
  }
}
