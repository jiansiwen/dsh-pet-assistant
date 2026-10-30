/**
 * 审批签发与消费。
 *
 * 批准只能由可信交互主体签发：桌面壳主进程持有独立于聊天令牌的审批凭据，渲染层与模型工具
 * 都拿不到。执行点在消费批准时重新校验摘要、期限与范围，工具直接调用执行器也必须过这一关。
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  SETTLED_OPERATION_STATES, TERMINAL_TASK_STATUSES,
  type ActionProposal, type Approval, type GateBinding, type OperationRecord, type OperationState, type ProposalState, type TeamStore,
} from './team-domain.ts'

/**
 * 由插件自己的可信执行器完成的动作（不是宿主工具）：应用改动提案、运行验证命令、写入 unknown 人工复核结论。
 * 它们的批准只能经 consumeTrusted 消费；门禁路径（consume / authorizeCall）一律拒绝这些名字，反之亦然。
 */
export const TRUSTED_ACTION_TOOLS = ['apply_change', 'run_verification', 'review_unknown', 'manage_companion_task'] as const
export type TrustedActionTool = (typeof TRUSTED_ACTION_TOOLS)[number]

export function isTrustedActionTool(tool: string): tool is TrustedActionTool {
  return (TRUSTED_ACTION_TOOLS as readonly string[]).includes(tool)
}

/** 可信执行器动作的提案输入：参数是执行器自己重算得出的绑定对象，审阅全文给桌面审批卡展示。 */
export interface TrustedProposalInput {
  readonly taskId: string
  readonly assistantId: string
  readonly summary: string
  readonly tool: TrustedActionTool
  readonly target: string
  /** 绑定对象：执行前由执行器从库里重算，摘要不符即拒绝。 */
  readonly params: unknown
  /** 提案修订（改动提案在任务内的版本号）；与任务行的修订无关。 */
  readonly inputRevision: number
  readonly risk: ActionProposal['risk']
  /** 审阅全文（JSON 文本）与展示用修订。 */
  readonly review: { readonly content: string; readonly revision: number }
}

/** 执行器消费时声明的期望：与提案逐项比对。 */
export interface TrustedExpectation {
  readonly tool: TrustedActionTool
  readonly taskId: string
  readonly target: string
  readonly params: unknown
  readonly inputRevision: number
  /** 任务有未核实副作用时是否拒绝（复核 unknown 本身不拒）。 */
  readonly blockOnUncertain: boolean
  /** 写进账本的运行 id，可选。 */
  readonly runId?: string
}

export type TrustedDecision = 'approved' | 'rejected'
export type TrustedDecisionHandler = (proposal: ActionProposal, decision: TrustedDecision) => void

/** 谁在签发这条批准。channel 由桥接层根据凭据与来源判定，不由请求体自报。 */
export interface ApprovalSubject {
  readonly channel: 'desktop-shell' | 'local-ui'
  /** 桌面壳审批窗口的 webContents id；主进程绑定，不信任 payload 里的窗口声明。 */
  readonly windowId?: number
}

export interface ApprovalOptions {
  /** 批准有效期；运行时重启或计划变更都会让它失效。 */
  readonly ttlMs: number
  /** 运行时代次；代次变化后旧批准一律拒绝。 */
  readonly runtimeEpoch: string
}

export type ApprovalErrorCode =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'DIGEST_MISMATCH'
  | 'ALREADY_CONSUMED'
  | 'EPOCH_MISMATCH'
  | 'UNTRUSTED_SUBJECT'

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode

  constructor(code: ApprovalErrorCode, message: string) {
    super(message)
    this.name = 'ApprovalError'
    this.code = code
  }
}

/** 工具、成员、任务、目标、参数与输入修订共同绑定批准；写类目标还绑定提案时的文件内容版本。 */
export function planDigestOf(proposal: Pick<ActionProposal, 'tool' | 'assistantId' | 'target' | 'paramsDigest' | 'inputRevision' | 'taskId'> & { baseHash?: string | null }): string {
  const fields: unknown[] = [proposal.taskId, proposal.assistantId, proposal.tool, proposal.target, proposal.paramsDigest, proposal.inputRevision]
  // 只在绑定了内容版本时追加：没有版本的提案摘要与旧版保持一致。
  if (typeof proposal.baseHash === 'string') fields.push(proposal.baseHash)
  return digestOf(fields)
}

/**
 * 键序稳定的 JSON 序列化。
 *
 * 摘要要比对的是「同一个计划」，而不是「同一段字节」：模型两次产出语义相同的参数时
 * 键序完全可能不同，直接用 JSON.stringify 会让合法操作被误判成计划已变更。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value ?? null))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(source).sort()) sorted[key] = sortDeep(source[key])
    return sorted
  }
  return value
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export interface ProposalInput {
  readonly taskId: string
  readonly assistantId: string
  readonly summary: string
  /** 将来要调用的宿主工具名；执行点门禁按它匹配批准。 */
  readonly tool: string
  readonly target: string
  readonly params: unknown
  readonly inputRevision: number
  readonly risk: ActionProposal['risk']
  /** 写类目标提案时的内容版本（sha256 / absent）；执行点重读不符就拒绝。 */
  readonly baseHash?: string | null
}

/** 门禁递进来的一次真实工具调用身份。 */
export interface GateCall {
  readonly taskId: string
  readonly assistantId: string
  readonly tool: string
  /** 作用目标；写类工具由门禁规范化成真实路径后再递进来。 */
  readonly target: string
  readonly params: unknown
  readonly inputRevision: number
  /** 执行它的运行；只用于账本追溯，不参与批准匹配。 */
  readonly runId?: string
  /** 写类目标此刻的内容版本（门禁在调用点现读）；与批准绑定的版本不符就不放行。 */
  readonly baseHash?: string | null
}

/** 放行时带上就地建好的操作记录 id；拒绝时带上模型能照着纠正的原因。 */
export type GateOutcome = { readonly ok: true; readonly operationId: string } | { readonly ok: false; readonly reason: string }

/** 在调用点等待用户决定的结局。aborted 表示调用方（任务取消、超时）先放弃了。 */
export type ApprovalWaitOutcome = 'approved' | 'rejected' | 'expired' | 'aborted'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shortHash(hash: string | null | undefined): string {
  if (typeof hash !== 'string') return '未知'
  return hash === 'absent' ? '不存在' : hash.slice(0, 12)
}

/** 门禁匹配用的绑定字段。 */
function bindingOf(call: GateCall): GateBinding {
  return {
    assistantId: call.assistantId, inputRevision: call.inputRevision, paramsDigest: digestOf(call.params),
    ...(call.baseHash !== undefined ? { baseHash: call.baseHash } : {}),
  }
}

export class ApprovalService {
  private readonly approvalToken: string
  private readonly store: TeamStore
  private readonly options: ApprovalOptions
  /**
   * proposalId → 正停在调用点等它决定的执行；签发、驳回、过期时按结果唤醒。
   * 只活在本进程内存里：进程一重启，等待的调用本身也不在了，对账流程负责把提案作废。
   */
  private readonly waiters = new Map<string, Set<(state: ProposalState) => void>>()
  /** 可信执行器动作的决定回调：批准签发 / 驳回提交之后才调用，不在请求路径上同步执行。 */
  private readonly trustedHandlers = new Map<TrustedActionTool, TrustedDecisionHandler>()

  // 显式字段而不是参数属性：Node 的 strip-only TypeScript 不改写语法，参数属性会让本文件
  // 无法被 node --test 直接导入 —— 审批是安全核心，恰恰最需要能进单测。
  constructor(store: TeamStore, options: ApprovalOptions) {
    this.store = store
    this.options = options
    this.approvalToken = randomUUID()
  }

  /** 审批凭据，只交给桌面壳主进程；与普通聊天令牌分离，不进入模型上下文。 */
  get approvalCapabilityToken(): string {
    return this.approvalToken
  }

  /** 常量时间比较，避免令牌被逐字符探测。 */
  verifyCapabilityToken(presented: string | undefined): boolean {
    if (typeof presented !== 'string' || presented.length === 0) return false
    const a = Buffer.from(presented)
    const b = Buffer.from(this.approvalToken)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** 专家提交副作用计划；提交本身不产生任何外部效果。 */
  propose(input: ProposalInput, ttlMs = this.options.ttlMs): ActionProposal {
    // 可信执行器动作的提案必须带执行器重算的绑定与审阅全文，只能走 proposeTrusted。
    if (isTrustedActionTool(input.tool)) {
      throw new ApprovalError('DIGEST_MISMATCH', `${input.tool} 只能由可信执行器提交，不接受普通提案`)
    }
    const now = Date.now()
    const proposal: ActionProposal = {
      proposalId: randomUUID(),
      taskId: input.taskId,
      assistantId: input.assistantId,
      summary: input.summary,
      tool: input.tool,
      target: input.target,
      paramsDigest: digestOf(input.params),
      inputRevision: input.inputRevision,
      risk: input.risk,
      state: 'pending',
      createdAt: now,
      expiresAt: now + ttlMs,
      baseHash: input.baseHash ?? null,
    }
    this.store.transaction(() => {
      this.store.insertProposal(proposal)
      this.store.appendEvent(
        'proposal/created',
        {
          proposalId: proposal.proposalId,
          summary: proposal.summary,
          tool: proposal.tool,
          target: proposal.target,
          risk: proposal.risk,
          expiresAt: proposal.expiresAt,
        },
        { taskId: proposal.taskId, assistantId: proposal.assistantId },
      )
    })
    return proposal
  }

  /**
   * 可信执行器动作的提案：参数是执行器重算的绑定对象（改动提案的修订、根目录与每个文件的基线/新哈希，
   * 验证命令的 cwd/程序/参数数组/超时……），审阅全文进审批卡。提交本身不产生任何外部效果。
   * 可以在调用方的事务里调用（与业务行同生同灭）；不唤醒任何等待者。
   */
  proposeTrusted(input: TrustedProposalInput, ttlMs = this.options.ttlMs): ActionProposal {
    if (!isTrustedActionTool(input.tool)) throw new ApprovalError('DIGEST_MISMATCH', `${input.tool} 不是可信执行器动作`)
    const now = Date.now()
    const proposal: ActionProposal = {
      proposalId: randomUUID(),
      taskId: input.taskId,
      assistantId: input.assistantId,
      summary: input.summary,
      tool: input.tool,
      target: input.target,
      paramsDigest: digestOf(input.params),
      inputRevision: input.inputRevision,
      risk: input.risk,
      state: 'pending',
      createdAt: now,
      expiresAt: now + ttlMs,
      baseHash: null,
      content: input.review.content,
      digest: digestOf(input.params),
      revision: input.review.revision,
    }
    this.store.transaction(() => {
      this.store.insertProposal(proposal)
      this.store.appendEvent(
        'proposal/created',
        {
          proposalId: proposal.proposalId, summary: proposal.summary, tool: proposal.tool, target: proposal.target,
          risk: proposal.risk, expiresAt: proposal.expiresAt, revision: proposal.revision, digest: proposal.digest,
        },
        { taskId: proposal.taskId, assistantId: proposal.assistantId },
      )
    })
    return proposal
  }

  /**
   * 登记某类可信执行器动作的决定回调（同一类只认最后一次登记）。批准签发、驳回落库之后在下一拍调用，
   * 不阻塞审批请求本身；返回撤销函数，只撤自己登记的那一个。
   */
  onTrustedDecision(tool: TrustedActionTool, handler: TrustedDecisionHandler): () => void {
    this.trustedHandlers.set(tool, handler)
    return () => {
      if (this.trustedHandlers.get(tool) === handler) this.trustedHandlers.delete(tool)
    }
  }

  private dispatchTrusted(proposal: ActionProposal, decision: TrustedDecision): void {
    if (!isTrustedActionTool(proposal.tool)) return
    const handler = this.trustedHandlers.get(proposal.tool)
    if (!handler) return
    const tool = proposal.tool
    setImmediate(() => {
      if (this.trustedHandlers.get(tool) !== handler) return
      try {
        const fresh = this.store.getProposal(proposal.proposalId) ?? proposal
        handler(fresh, decision)
      } catch {
        // 回调自己负责记账与日志；这里只保证一个回调出错不影响审批请求与别的回调。
      }
    })
  }

  /**
   * 从持久提案签发一条批准。签发动作只能由可信主体触发；调用方必须先验证凭据与来源，
   * 这里再拒绝一次不可信主体，保证直接调用执行器也拿不到批准。
   */
  issue(proposalId: string, subject: ApprovalSubject, trusted: boolean): Approval {
    if (!trusted) throw new ApprovalError('UNTRUSTED_SUBJECT', 'approval must be issued by a trusted interaction subject')
    const proposal = this.store.getProposal(proposalId)
    if (!proposal) throw new ApprovalError('NOT_FOUND', `proposal ${proposalId} does not exist`)
    const now = Date.now()
    if (proposal.state !== 'pending') {
      throw new ApprovalError('ALREADY_CONSUMED', `proposal ${proposalId} is ${proposal.state}`)
    }
    if (proposal.expiresAt <= now) {
      this.store.setProposalState(proposalId, 'expired')
      this.notify(proposalId, 'expired')
      throw new ApprovalError('EXPIRED', `proposal ${proposalId} expired at ${proposal.expiresAt}`)
    }
    const approval: Approval = {
      approvalId: randomUUID(),
      proposalId,
      planDigest: planDigestOf(proposal),
      // 使用已有持久字段绑定代次；旧版非 JSON 范围一律失效，无需改业务库结构。
      scope: canonicalJson({ target: proposal.target, channel: subject.channel, runtimeEpoch: this.options.runtimeEpoch }),
      issuedAt: now,
      expiresAt: Math.min(proposal.expiresAt, now + this.options.ttlMs),
      consumedAt: null,
    }
    this.store.transaction(() => {
      this.store.insertApproval(approval)
      this.store.setProposalState(proposalId, 'approved')
      this.store.appendEvent(
        'proposal/decided',
        { proposalId, decision: 'approved', approvalId: approval.approvalId, expiresAt: approval.expiresAt },
        { taskId: proposal.taskId, assistantId: proposal.assistantId },
      )
    })
    // 提交之后再唤醒：停在调用点的执行醒来时，批准一定已经落库可消费。
    this.notify(proposalId, 'approved')
    // 可信执行器动作：批准签发之后才交给执行器，执行器再逐项核验、单次消费。
    this.dispatchTrusted(proposal, 'approved')
    return approval
  }

  reject(proposalId: string, subject: ApprovalSubject, trusted: boolean): void {
    if (!trusted) throw new ApprovalError('UNTRUSTED_SUBJECT', 'rejection must come from a trusted interaction subject')
    const proposal = this.store.getProposal(proposalId)
    if (!proposal) throw new ApprovalError('NOT_FOUND', `proposal ${proposalId} does not exist`)
    this.store.transaction(() => {
      this.store.setProposalState(proposalId, 'rejected')
      this.store.appendEvent(
        'proposal/decided',
        { proposalId, decision: 'rejected', channel: subject.channel },
        { taskId: proposal.taskId, assistantId: proposal.assistantId },
      )
    })
    this.notify(proposalId, 'rejected')
    this.dispatchTrusted(proposal, 'rejected')
  }

  /** 查询单个提案，用于把审批状态回报给用户与模型。 */
  proposal(proposalId: string): ActionProposal | null {
    return this.store.getProposal(proposalId)
  }

  /** 某任务下的全部提案（含已决），按创建时间倒序。 */
  proposalsForTask(taskId: string): ActionProposal[] {
    return this.store.listProposals().filter((item) => item.taskId === taskId)
  }

  /** 已登记的副作用操作，用于回答"到底改了什么"。 */
  operations(taskId?: string): OperationRecord[] {
    return this.store.listOperations(taskId)
  }

  /**
   * 消费批准并预登记副作用操作，两者同事务。重放、过期、摘要不符都拒绝，
   * 调用方拿到的是「可以执行这一次」的凭据，不是长期权限。
   */
  consume(approvalId: string, kind: string, taskId: string, call?: GateCall): OperationRecord {
    return this.store.transaction(() => {
      const now = Date.now()
      const existing = this.store.getApproval(approvalId)
      if (!existing) throw new ApprovalError('NOT_FOUND', `批准 ${approvalId} 不存在`)
      let scope: { runtimeEpoch?: string; target?: string } | null = null
      try { scope = JSON.parse(existing.scope) } catch { /* 旧版批准没有代次，拒绝消费。 */ }
      this.assertEpoch(scope?.runtimeEpoch ?? '')
      if (existing.consumedAt !== null) throw new ApprovalError('ALREADY_CONSUMED', '批准已经消费')
      if (existing.expiresAt <= now) throw new ApprovalError('EXPIRED', '批准已过期')
      const proposal = this.store.getProposal(existing.proposalId)
      if (!proposal || proposal.state !== 'approved') throw new ApprovalError('NOT_FOUND', '没有有效的已批准提案')
      if (proposal.expiresAt <= now) throw new ApprovalError('EXPIRED', '提案已过期')
      // 可信执行器动作的批准只能由执行器经 consumeTrusted 消费，门禁路径一律不认。
      if (isTrustedActionTool(proposal.tool) || isTrustedActionTool(kind)) {
        throw new ApprovalError('DIGEST_MISMATCH', `${proposal.tool} 的批准只能由可信执行器消费`)
      }
      if (!call || !Object.hasOwn(call, 'params') || kind !== call.tool || taskId !== call.taskId ||
          scope?.target !== call.target || existing.planDigest !== planDigestOf(proposal) ||
          proposal.taskId !== call.taskId || proposal.assistantId !== call.assistantId ||
          proposal.tool !== call.tool || proposal.target !== call.target ||
          proposal.inputRevision !== call.inputRevision || proposal.paramsDigest !== digestOf(call.params)) {
        throw new ApprovalError('DIGEST_MISMATCH', '实际调用的任务、成员、工具、目标、完整参数或输入版本与批准不符')
      }
      // 内容版本：批准的是「把这一版文件改成这样」；用户在批准后改过文件，旧批准不能套到新内容上。
      if (typeof proposal.baseHash === 'string' && call.baseHash !== proposal.baseHash) {
        throw new ApprovalError('DIGEST_MISMATCH',
          `目标文件内容在批准后已变化（批准时 ${shortHash(proposal.baseHash)}，现在 ${shortHash(call.baseHash)}），未执行；需要按新内容重新发起`)
      }
      const task = this.store.getTask(call.taskId)
      const member = this.store.getMember(call.assistantId)
      if (!task || task.revision !== call.inputRevision || task.ownerId !== call.assistantId ||
          task.status !== 'running' || task.toolScope !== 'side-effect' ||
          !member?.enabled || member.toolPolicy.mode !== 'side-effect' || member.toolPolicy.denyTools.includes(kind)) {
        throw new ApprovalError('DIGEST_MISMATCH', '任务版本、执行状态或成员权限已变化，必须重新复核')
      }
      if (this.operations(taskId).some(item => ['planned', 'running', 'unknown'].includes(item.state))) {
        throw new ApprovalError('ALREADY_CONSUMED', '存在尚未核实的副作用，禁止盲重发')
      }
      const operation: OperationRecord = {
        operationId: randomUUID(), taskId, approvalId, kind, state: 'planned',
        resultDigest: null, startedAt: now, endedAt: null,
        // 账本只记摘要：成员与目标来自可信绑定，参数只存摘要。
        assistantId: call.assistantId, target: call.target, paramsDigest: proposal.paramsDigest,
        runId: call.runId ?? null, executedAt: null, resultDetail: null,
      }
      if (!this.store.consumeApproval(approvalId, planDigestOf(proposal), now)) {
        throw new ApprovalError('ALREADY_CONSUMED', '批准已不可消费')
      }
      this.store.insertOperation(operation)
      this.store.appendEvent('operation/updated',
        { operationId: operation.operationId, state: operation.state, kind, proposalId: proposal.proposalId, target: call.target },
        { taskId, assistantId: call.assistantId })
      return operation
    })
  }

  /**
   * 凭提案消费它已签发的批准。批准 id 刻意不暴露给模型上下文：模型只知道自己提了什么，
   * 能不能执行取决于是否有可信主体签发过批准，以及摘要、期限与单次消费校验。
   */
  consumeByProposal(proposalId: string, kind: string, call?: GateCall): OperationRecord {
    const proposal = this.store.getProposal(proposalId)
    if (!proposal) throw new ApprovalError('NOT_FOUND', `proposal ${proposalId} does not exist`)
    if (proposal.state !== 'approved') {
      throw new ApprovalError('NOT_FOUND', `proposal ${proposalId} is ${proposal.state}, no approval to consume`)
    }
    const approval = this.store.approvalForProposal(proposalId)
    if (!approval) throw new ApprovalError('NOT_FOUND', `proposal ${proposalId} has no issued approval`)
    return this.consume(approval.approvalId, kind, proposal.taskId, call)
  }

  /**
   * 执行点门禁入口：这次工具调用有没有一条可用的批准。
   *
   * 守卫是同步的、只能返回拒绝理由字符串，所以这里不抛异常，而是把失败原因写成
   * 模型能照着自我纠正的一句话（该用哪个工具提案、tool 与 target 该填什么）。
   * 命中时单次消费批准并就地建 planned 操作记录 —— 「批准一次、执行一次」。
   */
  authorizeCall(call: GateCall): GateOutcome {
    const binding = bindingOf(call)
    const { baseHash: _version, ...loose } = binding
    // 先找真正可消费的那条；找不到再取最近一条已批准的，只为给出准确的拒绝原因（已消费 / 已过期 / 文件已变）。
    const proposal = this.store.findUsableGateProposal(call.taskId, call.tool, call.target, binding, Date.now())
      ?? this.store.findGateProposal(call.taskId, call.tool, call.target, loose)
    if (!proposal) {
      return {
        ok: false,
        reason:
          `没有匹配这次调用的批准。先用 desktop_team_propose_action 提案` +
          `（tool="${call.tool}"、target="${call.target}"），等用户在桌面审批卡上批准后重试。`,
      }
    }
    if (proposal.expiresAt <= Date.now()) {
      this.store.setProposalState(proposal.proposalId, 'expired')
      this.notify(proposal.proposalId, 'expired')
      return { ok: false, reason: `提案 ${proposal.proposalId} 的批准窗口已过期，需要重新提案。` }
    }
    try {
      const operation = this.consumeByProposal(proposal.proposalId, call.tool, call)
      return { ok: true, operationId: operation.operationId }
    } catch (error) {
      const code = error instanceof ApprovalError ? error.code : 'NOT_FOUND'
      return { ok: false, reason: `批准不可用（${code}）：${messageOf(error)}。同一条批准只能执行一次，需要再执行就重新提案。` }
    }
  }

  /** 这次调用此刻有没有一条能消费的批准；只读查询，不消费。绑定了别的文件版本的批准不算。 */
  hasUsableApproval(call: GateCall): boolean {
    return this.store.findUsableGateProposal(call.taskId, call.tool, call.target, bindingOf(call), Date.now()) !== null
  }

  /** 调用绑定的任务是否仍在运行、版本与成员未变；不在了就不该再替它发审批卡。 */
  callIsLive(call: GateCall): boolean {
    const task = this.store.getTask(call.taskId)
    return !!task && task.status === 'running' && task.revision === call.inputRevision && task.ownerId === call.assistantId
  }

  /**
   * 执行点门禁替一次真实调用提交审批卡。摘要与风险由门禁按真实工具名、规范化目标生成，
   * 不采纳模型自报的说明；同一调用还有未过期的待决提案时复用它，不重复刷卡。
   * 提交本身不产生任何外部效果，也不代表批准。
   */
  requestApproval(call: GateCall, summary: string, risk: ActionProposal['risk']): ActionProposal {
    const pending = this.store.findPendingGateProposal(call.taskId, call.tool, call.target, bindingOf(call), Date.now())
    if (pending) return pending
    return this.propose({
      taskId: call.taskId, assistantId: call.assistantId, summary, tool: call.tool, target: call.target,
      params: call.params, inputRevision: call.inputRevision, risk, baseHash: call.baseHash ?? null,
    })
  }

  /**
   * 在调用点等待可信主体对提案的决定：签发、驳回、到期或调用方放弃（signal）之一先到为准。
   * 等待不消费批准；放行与否仍由执行点守卫逐项核验后单次消费。
   * abandonOnAbort=false：调用方放弃等待不作废审批卡（可信执行器动作批准后由执行器执行，与有没有人在等无关）。
   */
  waitForDecision(proposalId: string, signal: AbortSignal, options: { abandonOnAbort?: boolean } = {}): Promise<ApprovalWaitOutcome> {
    const abandonOnAbort = options.abandonOnAbort ?? true
    const decided = this.decisionOf(proposalId)
    if (decided !== undefined) return Promise.resolve(decided)
    if (signal.aborted) {
      if (abandonOnAbort) this.abandon(proposalId)
      return Promise.resolve('aborted')
    }
    const expiresAt = this.store.getProposal(proposalId)?.expiresAt ?? Date.now()
    return new Promise(resolve => {
      const waiting = this.waiters.get(proposalId) ?? new Set<(state: ProposalState) => void>()
      this.waiters.set(proposalId, waiting)
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (outcome: ApprovalWaitOutcome) => {
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        waiting.delete(wake)
        if (waiting.size === 0 && this.waiters.get(proposalId) === waiting) this.waiters.delete(proposalId)
        resolve(outcome)
      }
      const wake = (state: ProposalState) => finish(state === 'pending' ? 'expired' : state)
      const onAbort = () => {
        finish('aborted')
        if (abandonOnAbort) this.abandon(proposalId)
      }
      waiting.add(wake)
      signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        const state = this.decisionOf(proposalId)
        if (state !== undefined) return finish(state)
        this.expireProposal(proposalId, '审批窗口到期')
        finish('expired')
      }, Math.max(1, expiresAt - Date.now() + 1))
      timer.unref?.()
    })
  }

  /**
   * 作废某任务（可限定输入修订）仍在等待的提案：运行结束或中断后它们再也不可能被消费，
   * 留在审批窗口里只会让用户批一个注定 409 的东西。返回作废条数。
   */
  expirePending(taskId: string, inputRevision: number | undefined, reason: string): number {
    const expired = this.store.transaction(() => {
      const rows = this.store.expirePendingProposals(taskId, inputRevision)
      for (const proposal of rows) {
        this.store.appendEvent('proposal/decided', { proposalId: proposal.proposalId, decision: 'expired', reason },
          { taskId: proposal.taskId, assistantId: proposal.assistantId })
      }
      return rows
    })
    for (const proposal of expired) this.notify(proposal.proposalId, 'expired')
    return expired.length
  }

  invalidateTasks(taskIds: readonly string[], reason: string): number {
    const ids = new Set(taskIds)
    if (ids.size === 0) return 0
    const expired = this.store.transaction(() => {
      const rows = this.store.listProposals().filter(proposal => {
        if (!ids.has(proposal.taskId)) return false
        if (proposal.state === 'pending') return true
        if (proposal.state !== 'approved') return false
        return this.store.approvalForProposal(proposal.proposalId)?.consumedAt === null
      })
      for (const proposal of rows) {
        this.store.setProposalState(proposal.proposalId, 'expired')
        this.store.appendEvent('proposal/decided', { proposalId: proposal.proposalId, decision: 'expired', reason },
          { taskId: proposal.taskId, assistantId: proposal.assistantId })
      }
      return rows
    })
    for (const proposal of expired) this.notify(proposal.proposalId, 'expired')
    return expired.length
  }

  /**
   * 工具体即将开始：planned → running 并记下执行开始时间。返回 false 表示这条操作已不在待执行
   * （例如任务已停止、已被对账成 unknown），调用方必须拒绝执行。
   */
  markRunning(operationId: string): boolean {
    return this.store.transaction(() => {
      if (!this.store.markOperationRunning(operationId, Date.now())) return false
      const operation = this.store.getOperation(operationId)!
      this.store.appendEvent('operation/updated',
        { operationId, state: 'running', kind: operation.kind, target: operation.target ?? null },
        { taskId: operation.taskId, assistantId: operation.assistantId ?? null })
      return true
    })
  }

  /** 单条可信账目。 */
  operation(operationId: string): OperationRecord | null {
    return this.store.getOperation(operationId)
  }

  /** 已有结论的提案；仍在等待且未到期时返回 undefined。到期的顺手作废。 */
  private decisionOf(proposalId: string): ApprovalWaitOutcome | undefined {
    const proposal = this.store.getProposal(proposalId)
    if (!proposal) return 'expired'
    if (proposal.state !== 'pending') return proposal.state
    if (proposal.expiresAt <= Date.now()) {
      this.expireProposal(proposalId, '审批窗口到期')
      return 'expired'
    }
    return undefined
  }

  /** 最后一个等待者放弃了：这张卡已经没有调用会去消费，作废掉免得用户白批。 */
  private abandon(proposalId: string): void {
    if (this.waiters.has(proposalId)) return
    this.expireProposal(proposalId, '等待批准的调用已取消')
  }

  private expireProposal(proposalId: string, reason: string): void {
    const proposal = this.store.getProposal(proposalId)
    if (!proposal || proposal.state !== 'pending') return
    this.store.transaction(() => {
      this.store.setProposalState(proposalId, 'expired')
      this.store.appendEvent('proposal/decided', { proposalId, decision: 'expired', reason },
        { taskId: proposal.taskId, assistantId: proposal.assistantId })
    })
    this.notify(proposalId, 'expired')
  }

  private notify(proposalId: string, state: ProposalState): void {
    const waiting = this.waiters.get(proposalId)
    if (!waiting) return
    this.waiters.delete(proposalId)
    for (const wake of [...waiting]) wake(state)
  }

  /**
   * 凭提案结算它名下已经发生的那次执行。
   *
   * 门禁在真实调用点就消费过批准了，所以这里不能再走 consumeByProposal（那会撞
   * ALREADY_CONSUMED）。路径是提案 → 批准 → 操作记录；查不到操作记录说明门禁从未
   * 放行过这次副作用，那就如实说没有，不能凭空造一条账。
   */
  settleByProposal(proposalId: string, state: OperationState, resultDigest: string | null): OperationRecord {
    const proposal = this.store.getProposal(proposalId)
    if (!proposal) throw new ApprovalError('NOT_FOUND', `proposal ${proposalId} does not exist`)
    const approval = this.store.approvalForProposal(proposalId)
    if (!approval) throw new ApprovalError('NOT_FOUND', `proposal ${proposalId} 从未签发过批准`)
    const operation = this.store.operationForApproval(approval.approvalId)
    if (!operation) {
      throw new ApprovalError('NOT_FOUND', `proposal ${proposalId} 的批准尚未被任何真实调用消费，没有可结算的执行记录`)
    }
    this.settle(operation.operationId, state, resultDigest)
    return { ...operation, state, resultDigest }
  }

  /** 只读返回真实调用记录，模型工具不能用自报结果修改该记录。 */
  operationByProposal(proposalId: string): OperationRecord | null {
    const approval = this.store.approvalForProposal(proposalId)
    return approval ? this.store.operationForApproval(approval.approvalId) : null
  }

  /**
   * 仅供可信执行器或人工核查流程调用；不能直接暴露为模型结账能力。
   * detail 是结果的简短说明（错误码、中断原因），不传就保留原说明。
   */
  settle(operationId: string, state: OperationState, resultDigest: string | null, detail?: string | null): void {
    this.store.transaction(() => {
      const operation = this.store.getOperation(operationId)
      if (!operation) throw new ApprovalError('NOT_FOUND', `操作 ${operationId} 不存在`)
      if (SETTLED_OPERATION_STATES.includes(operation.state)) {
        if (operation.state === state && operation.resultDigest === resultDigest) return
        throw new ApprovalError('ALREADY_CONSUMED', '已结算的操作不能被迟到结果覆盖')
      }
      this.store.setOperationState(operationId, state, resultDigest, detail)
      this.store.appendEvent(
        'operation/updated',
        { operationId, state, kind: operation.kind, target: operation.target ?? null },
        { taskId: operation.taskId, assistantId: operation.assistantId ?? null },
      )
    })
  }

  /** 运行时代次变化后所有旧批准失效。 */
  assertEpoch(presented: string): void {
    if (presented !== this.options.runtimeEpoch) {
      throw new ApprovalError('EPOCH_MISMATCH', `approval epoch ${presented} does not match runtime ${this.options.runtimeEpoch}`)
    }
  }

  /**
   * 可信执行器消费一条批准并就地预登记操作（planned），两者同事务。
   *
   * 执行器从库里重算绑定对象交进来，这里逐项比对：工具、任务、目标、绑定摘要、提案修订都必须与提案一致，
   * 批准必须属于当前代次、未消费、未过期，提案必须仍是已批准。批准只能消费一次：重放、过期、
   * 参数（改动内容）被改、代次变化一律拒绝，且不留任何执行痕迹。
   */
  consumeTrusted(proposalId: string, expected: TrustedExpectation): OperationRecord {
    return this.store.transaction(() => {
      const now = Date.now()
      const proposal = this.store.getProposal(proposalId)
      if (!proposal) throw new ApprovalError('NOT_FOUND', `提案 ${proposalId} 不存在`)
      if (!isTrustedActionTool(proposal.tool) || proposal.tool !== expected.tool) {
        throw new ApprovalError('DIGEST_MISMATCH', `提案 ${proposalId} 不是 ${expected.tool} 的可信执行器提案`)
      }
      if (proposal.state !== 'approved') throw new ApprovalError('NOT_FOUND', `提案 ${proposalId} 当前是 ${proposal.state}，没有可消费的批准`)
      const approval = this.store.approvalForProposal(proposalId)
      if (!approval) throw new ApprovalError('NOT_FOUND', `提案 ${proposalId} 没有签发过批准`)
      let scope: { runtimeEpoch?: string; target?: string } | null = null
      try { scope = JSON.parse(approval.scope) } catch { /* 旧版批准没有代次，拒绝消费。 */ }
      this.assertEpoch(scope?.runtimeEpoch ?? '')
      if (approval.consumedAt !== null) throw new ApprovalError('ALREADY_CONSUMED', '这条批准已经执行过一次，不能重放')
      if (approval.expiresAt <= now) throw new ApprovalError('EXPIRED', '批准已过期，未执行')
      if (proposal.expiresAt <= now) throw new ApprovalError('EXPIRED', '提案已过期，未执行')
      if (approval.planDigest !== planDigestOf(proposal) || scope?.target !== expected.target ||
          proposal.taskId !== expected.taskId || proposal.target !== expected.target ||
          proposal.inputRevision !== expected.inputRevision || proposal.paramsDigest !== digestOf(expected.params)) {
        throw new ApprovalError('DIGEST_MISMATCH', '执行前重算的内容、目标或修订与批准时不符，未执行')
      }
      const task = this.store.getTask(proposal.taskId)
      if (!task) throw new ApprovalError('NOT_FOUND', `任务 ${proposal.taskId} 不存在`)
      if (expected.blockOnUncertain) {
        if (TERMINAL_TASK_STATUSES.includes(task.status) || task.status === 'unknown') {
          throw new ApprovalError('DIGEST_MISMATCH', `任务已是 ${task.status}，不再执行新的副作用`)
        }
        if (this.store.listOperations(task.taskId).some(item => ['planned', 'running', 'unknown'].includes(item.state))) {
          throw new ApprovalError('ALREADY_CONSUMED', '任务里有尚未核实的副作用，先人工复核，禁止继续执行')
        }
      }
      const operation: OperationRecord = {
        operationId: randomUUID(), taskId: proposal.taskId, approvalId: approval.approvalId, kind: proposal.tool, state: 'planned',
        resultDigest: null, startedAt: now, endedAt: null,
        assistantId: proposal.assistantId, target: proposal.target, paramsDigest: proposal.paramsDigest,
        runId: expected.runId ?? null, executedAt: null, resultDetail: null,
      }
      if (!this.store.consumeApproval(approval.approvalId, approval.planDigest, now)) {
        throw new ApprovalError('ALREADY_CONSUMED', '批准已不可消费')
      }
      this.store.insertOperation(operation)
      this.store.appendEvent('operation/updated',
        { operationId: operation.operationId, state: operation.state, kind: operation.kind, proposalId, target: operation.target },
        { taskId: operation.taskId, assistantId: operation.assistantId })
      return operation
    })
  }

  /** 主动作废一张仍在等待的提案（被新修订取代、任务取消等）；已决定的不受影响。 */
  expire(proposalId: string, reason: string): boolean {
    const proposal = this.store.getProposal(proposalId)
    if (!proposal || proposal.state !== 'pending') return false
    this.expireProposal(proposalId, reason)
    return true
  }

  /**
   * 还等得到用户决定的提案。
   *
   * 光按 `state='pending'` 过滤不够：过期提案的 state 要等到有人真的去签发或消费它时才会被
   * 纠正成 expired，所以那种行会一直挂在 pending 里。把它报出去的后果是模型对用户说「有 N 件
   * 事等你批准」、桌面渲染出一张点了就返回 409 EXPIRED 的卡。
   *
   * 这里只过滤、不改状态：让一个查询路径产生写副作用，并发下的账目就很难推理了，纠正过期
   * 状态仍然是 issue / authorizeCall 的职责。
   */
  pendingProposals(now = Date.now()): ActionProposal[] {
    return this.store.listProposals('pending').filter((proposal) => proposal.expiresAt > now)
  }
}
