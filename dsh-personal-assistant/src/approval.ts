/**
 * 审批签发与消费。
 *
 * 批准只能由可信交互主体签发：桌面壳主进程持有独立于聊天令牌的审批凭据，渲染层与模型工具
 * 都拿不到。执行点在消费批准时重新校验摘要、期限与范围，工具直接调用执行器也必须过这一关。
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { ActionProposal, Approval, OperationRecord, OperationState, TeamStore } from './team-domain.ts'

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

/** 副作用计划摘要：操作、目标、参数与输入修订一起参与哈希，改任何一项都会让旧批准失效。 */
export function planDigestOf(proposal: Pick<ActionProposal, 'target' | 'paramsDigest' | 'inputRevision' | 'taskId'>): string {
  return createHash('sha256')
    .update(`${proposal.taskId}\n${proposal.target}\n${proposal.paramsDigest}\n${proposal.inputRevision}`)
    .digest('hex')
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
    const sorted: Record<string, unknown> = {}
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
}

/** 门禁递进来的一次真实工具调用身份。 */
export interface GateCall {
  readonly taskId: string
  readonly assistantId: string
  readonly tool: string
  readonly target: string
}

/** 放行时带上就地建好的操作记录 id；拒绝时带上模型能照着纠正的原因。 */
export type GateOutcome = { readonly ok: true; readonly operationId: string } | { readonly ok: false; readonly reason: string }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ApprovalService {
  private readonly approvalToken: string
  private readonly store: TeamStore
  private readonly options: ApprovalOptions

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
      throw new ApprovalError('EXPIRED', `proposal ${proposalId} expired at ${proposal.expiresAt}`)
    }
    const approval: Approval = {
      approvalId: randomUUID(),
      proposalId,
      planDigest: planDigestOf(proposal),
      scope: `${proposal.target}|${subject.channel}`,
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
  consume(approvalId: string, kind: string, taskId: string): OperationRecord {
    const now = Date.now()
    const existing = this.store.getApproval(approvalId)
    if (!existing) throw new ApprovalError('NOT_FOUND', `approval ${approvalId} does not exist`)
    if (existing.consumedAt !== null) {
      throw new ApprovalError('ALREADY_CONSUMED', `approval ${approvalId} was consumed at ${existing.consumedAt}`)
    }
    if (existing.expiresAt <= now) throw new ApprovalError('EXPIRED', `approval ${approvalId} expired at ${existing.expiresAt}`)

    const operation: OperationRecord = {
      operationId: randomUUID(),
      taskId,
      approvalId,
      kind,
      state: 'planned',
      resultDigest: null,
      startedAt: now,
      endedAt: null,
    }
    const consumed = this.store.transaction(() => {
      const ok = this.store.consumeApproval(approvalId, existing.planDigest, now)
      if (!ok) return false
      this.store.insertOperation(operation)
      return true
    })
    if (!consumed) {
      throw new ApprovalError('ALREADY_CONSUMED', `approval ${approvalId} is no longer consumable`)
    }
    return operation
  }

  /**
   * 凭提案消费它已签发的批准。批准 id 刻意不暴露给模型上下文：模型只知道自己提了什么，
   * 能不能执行取决于是否有可信主体签发过批准，以及摘要、期限与单次消费校验。
   */
  consumeByProposal(proposalId: string, kind: string): OperationRecord {
    const proposal = this.store.getProposal(proposalId)
    if (!proposal) throw new ApprovalError('NOT_FOUND', `proposal ${proposalId} does not exist`)
    if (proposal.state !== 'approved') {
      throw new ApprovalError('NOT_FOUND', `proposal ${proposalId} is ${proposal.state}, no approval to consume`)
    }
    const approval = this.store.approvalForProposal(proposalId)
    if (!approval) throw new ApprovalError('NOT_FOUND', `proposal ${proposalId} has no issued approval`)
    const operation = this.consume(approval.approvalId, kind, proposal.taskId)
    this.store.appendEvent(
      'operation/updated',
      { operationId: operation.operationId, state: operation.state, kind, proposalId },
      { taskId: proposal.taskId, assistantId: proposal.assistantId },
    )
    return operation
  }

  /**
   * 执行点门禁入口：这次工具调用有没有一条可用的批准。
   *
   * 守卫是同步的、只能返回拒绝理由字符串，所以这里不抛异常，而是把失败原因写成
   * 模型能照着自我纠正的一句话（该用哪个工具提案、tool 与 target 该填什么）。
   * 命中时单次消费批准并就地建 planned 操作记录 —— 「批准一次、执行一次」。
   */
  authorizeCall(call: GateCall): GateOutcome {
    const proposal = this.store.findGateProposal(call.taskId, call.tool, call.target)
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
      return { ok: false, reason: `提案 ${proposal.proposalId} 的批准窗口已过期，需要重新提案。` }
    }
    try {
      const operation = this.consumeByProposal(proposal.proposalId, call.tool)
      return { ok: true, operationId: operation.operationId }
    } catch (error) {
      const code = error instanceof ApprovalError ? error.code : 'NOT_FOUND'
      return { ok: false, reason: `批准不可用（${code}）：${messageOf(error)}。同一条批准只能执行一次，需要再执行就重新提案。` }
    }
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

  /** 副作用结束记账。超时或结果不明时写 unknown，由调用方核查真实外部状态后再决定。 */
  settle(operationId: string, state: OperationState, resultDigest: string | null): void {
    this.store.transaction(() => {
      this.store.setOperationState(operationId, state, resultDigest)
      const operation = this.store.getOperation(operationId)
      this.store.appendEvent(
        'operation/updated',
        { operationId, state, kind: operation?.kind ?? null },
        { taskId: operation?.taskId ?? null },
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
