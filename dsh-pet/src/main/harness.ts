/**
 * 会话桥接客户端：宠物通过本地 HTTP 长轮询与发起召唤的 dsh 主会话通信。
 *
 * 不再 spawn `dsh --profile headless` —— 宠物没有独立 API key、没有独立会话：
 * 每条消息经插件注入绑定的主会话（agent.followup），历史、模型、凭据全部复用主会话。
 * 连接参数来自插件写入的 <DSH_HOME>/personal-assistant/bridge.json。
 *
 * 两条凭据互不通用，这是刻意的：
 * - bridge.json 的 `token` 能发消息、读快照，但**签不出批准**；
 * - bridge-approval.json 的 `approvalToken` 只能批准/驳回提案，模型侧拿不到它。
 * 所以即使模型读到了 bridge.json（它有 read 工具），也无法自己批准自己的副作用计划。
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
  approvalToken: string
  epoch?: string
  port?: number
}

export type BridgeStatus = 'connecting' | 'connected' | 'disconnected'

export interface ChatReply {
  ok: boolean
  reply?: string
  error?: string
}

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

/** 读取审批凭据；团队模式没开（插件不写这个文件）时返回 null。 */
export function readApprovalCredential(): ApprovalCredential | null {
  try {
    const raw = JSON.parse(readFileSync(approvalCredentialPath(), 'utf8')) as Partial<ApprovalCredential>
    if (typeof raw.approvalToken === 'string' && raw.approvalToken.length > 0) {
      return {
        approvalToken: raw.approvalToken,
        epoch: typeof raw.epoch === 'string' && raw.epoch ? raw.epoch : undefined,
        port: typeof raw.port === 'number' && raw.port > 0 ? raw.port : undefined,
      }
    }
  } catch {
    // 团队模式未开启
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 快照与审批都是短请求，不能让界面挂在一次卡死的连接上。 */
const SNAPSHOT_TIMEOUT_MS = 4_000
const APPROVAL_TIMEOUT_MS = 10_000
/** 长轮询服务端 25s 超时返回，客户端要留足余量，否则会先于服务端断开。 */
const LONG_POLL_TIMEOUT_MS = 30_000

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
  private pending = new Map<string, (reply: ChatReply) => void>()
  private callbacks: BridgeCallbacks | null = null

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
        // 连上就拉一次快照：渲染层可能刚挂载就错过了此前所有事件。
        void this.pushSnapshot()
        void this.pollLoop()
        return
      }
      callbacks.onStatus('connecting')
      await sleep(2000)
    }
  }

  /**
   * 发送一条消息并等待主会话的回复（回复经事件流异步回传）。
   * 传 assistantId 即点名某个成员；名字对不上时服务端会明确报错，不会替你换人。
   */
  async chat(text: string, assistantId?: string): Promise<ChatReply> {
    if (!this.info) {
      return { ok: false, error: '未连接到 dsh 会话：请先在 dsh 里说"召唤宠物"' }
    }
    const id = `pet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const replyPromise = new Promise<ChatReply>(resolve => {
      this.pending.set(id, resolve)
    })
    try {
      const response = await fetch(`http://127.0.0.1:${this.info.port}/chat?token=${this.info.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id,
          text,
          assistantId,
          // 带上代次：会话已经换代了就该被拒，而不是把消息注入到一个陌生的会话里。
          epoch: this.info.epoch,
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}) as { error?: string }) as { error?: string }
        this.pending.delete(id)
        if (response.status === 409) {
          // 代次过期：桥接换代了，重连后让用户重发，别把这条消息静默丢掉。
          this.resetForNewEpoch()
          return { ok: false, error: '助理会话已重启，这条消息没有送达，请重发一次' }
        }
        return { ok: false, error: body.error ?? `桥接返回 ${response.status}` }
      }
    } catch (error) {
      this.pending.delete(id)
      return { ok: false, error: `桥接请求失败：${error instanceof Error ? error.message : String(error)}` }
    }
    const timeout = new Promise<ChatReply>(resolve => {
      setTimeout(() => resolve({ ok: false, error: '助理响应超时（5 分钟），请重试' }), 320_000)
    })
    return Promise.race([replyPromise, timeout]).finally(() => {
      this.pending.delete(id)
    })
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
  async reportPetState(state: { focus: boolean; visible: boolean }): Promise<void> {
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
   * 批准或驳回一个提案。
   *
   * 走的是独立凭据（bridge-approval.json），拿不到它就说明团队模式没开或插件是旧构建，
   * 直接报错而不是拿聊天令牌去试 —— 服务端会 403，而且那种尝试本身就是错的。
   */
  async decideApproval(
    proposalId: string,
    decision: ApprovalDecision,
    windowId?: number,
  ): Promise<DecideApprovalResult> {
    const info = this.info
    if (!info) return { ok: false, error: '未连接到 dsh 会话' }
    const credential = readApprovalCredential()
    if (!credential) {
      return { ok: false, error: '团队模式未开启，没有审批凭据' }
    }
    // 端口以 bridge.json 为准：审批文件里的 port 是同一次绑定写的，但 bridge.json 才是活的那份。
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/approval`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dsh-approval-token': credential.approvalToken,
        },
        signal: AbortSignal.timeout(APPROVAL_TIMEOUT_MS),
        body: JSON.stringify({
          proposalId,
          decision,
          epoch: credential.epoch ?? info.epoch,
          windowId,
        }),
      })
      const body = await response.json().catch(() => ({}) as Record<string, unknown>) as {
        approvalId?: string
        decision?: 'rejected'
        error?: string
        message?: string
      }
      if (response.ok) {
        return { ok: true, approvalId: body.approvalId, decision: body.decision }
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
    for (const resolve of this.pending.values()) {
      resolve({ ok: false, error: '宠物正在退出' })
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
    for (const resolve of this.pending.values()) {
      resolve({ ok: false, error: '助理会话已重启，这条消息没有送达' })
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
        void this.pollLoop()
        return
      }
      await sleep(2000)
    }
  }

  /** 事件长轮询：reply 分发给等待中的 chat()；桥接消失即视为会话结束 → 退场。 */
  private async pollLoop(): Promise<void> {
    while (!this.stopped && this.info) {
      const info = this.info
      let body: { events?: BridgeEventPayload[]; epoch?: string }
      try {
        const response = await fetch(
          `http://127.0.0.1:${info.port}/events?token=${info.token}&since=${this.seq}`,
          { signal: AbortSignal.timeout(LONG_POLL_TIMEOUT_MS + 5_000) },
        )
        if (!response.ok) throw new Error(`events ${response.status}`)
        body = await response.json() as typeof body
      } catch {
        // 服务端关闭 / 会话销毁 / 进程退出：桥接不复存在，宠物随之退场
        this.callbacks?.onStatus('disconnected')
        this.callbacks?.onSessionEnded()
        return
      }
      // 代次不符 = 桥接换了会话。旧游标对新代毫无意义，丢掉重来。
      if (typeof body.epoch === 'string' && info.epoch && body.epoch !== info.epoch) {
        this.resetForNewEpoch()
        return
      }
      for (const event of body.events ?? []) {
        if (typeof event.seq === 'number' && event.seq > this.seq) this.seq = event.seq
        if (event.type === 'reply' && typeof event.id === 'string') {
          this.pending.get(event.id)?.({
            ok: event.ok ?? false,
            reply: event.reply,
            error: event.error,
          })
          this.pending.delete(event.id)
        } else if (event.type === 'session-ended') {
          this.callbacks?.onStatus('disconnected')
          this.callbacks?.onSessionEnded()
          return
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
