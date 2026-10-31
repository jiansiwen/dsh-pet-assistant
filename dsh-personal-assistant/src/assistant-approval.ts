/** 助理敏感操作：模型只提交固定快照，可信凭据一次消费执行。 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'

export interface AssistantProposal {
  kind: 'assistant'
  proposalId: string
  revision: 1
  digest: string
  content: string
  target: string
  epoch: string
  expiresAt: number
  state: 'pending'
  summary: string
  tool: string
  risk: 'medium' | 'high'
}

export interface AssistantSubmission {
  subject: string
  tool: string
  summary: string
  target: string
  risk: 'medium' | 'high'
  snapshot: unknown
  validate(): boolean
  execute(): unknown | Promise<unknown>
}

/** 可信执行器在任何外部效果发生前明确失败，可重新提交并重新审批。 */
export class BeforeEffectError extends Error {}

type Entry = {
  proposal: AssistantProposal
  submission: AssistantSubmission
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown'
  result?: unknown
}

function matchesIntent(entry: Entry, subject: string, intentId: string): boolean {
  const snapshot = entry.submission.snapshot
  return entry.submission.subject === subject && snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
    && (snapshot as { intentId?: unknown }).intentId === intentId
}

export function snapshotDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class AssistantApprovalService {
  private readonly token = randomUUID()
  private readonly entries = new Map<string, Entry>()
  private readonly epoch: string
  private readonly ttlMs: number
  private readonly now: () => number
  constructor(options: { epoch: string; ttlMs: number; now?: () => number }) {
    this.epoch = options.epoch
    this.ttlMs = options.ttlMs
    this.now = options.now ?? Date.now
  }

  /** 只供本地装配；不得进入模型输出或审批快照。 */
  get approvalCapabilityToken(): string { return this.token }
  verifyCapabilityToken(token?: string): boolean {
    if (!token) return false
    const a = Buffer.from(token), b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  invalidateAll(subject?: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.state === 'pending' && (!subject || entry.submission.subject === subject)) this.entries.delete(id)
    }
  }

  /** 仅供可信核对入口释放对应的未知操作，不代表外部效果已成功或失败。 */
  acknowledgeUnknown(subject: string, intentId: string): boolean {
    for (const [id, entry] of this.entries) {
      if (entry.state === 'unknown' && matchesIntent(entry, subject, intentId)) {
        this.entries.delete(id)
        return true
      }
    }
    return false
  }

  isIntentRunning(subject: string, intentId: string): boolean {
    return [...this.entries.values()].some(entry => entry.state === 'running' && matchesIntent(entry, subject, intentId))
  }

  pendingProposals(): AssistantProposal[] {
    const result: AssistantProposal[] = []
    for (const [id, entry] of this.entries) {
      if (entry.state !== 'pending') continue
      let valid = entry.proposal.expiresAt > this.now()
      try { valid = valid && entry.submission.validate() } catch { valid = false }
      if (!valid) this.entries.delete(id)
      else result.push({ ...entry.proposal })
    }
    return result
  }

  submit(submission: AssistantSubmission): AssistantProposal {
    this.pendingProposals()
    this.invalidateAll(submission.subject)
    // 在途与结果不明的操作不自动重发，即使模型再次提交相同主题。
    if ([...this.entries.values()].some(e => e.submission.subject === submission.subject && (e.state === 'running' || e.state === 'unknown'))) {
      throw new Error('该操作正在执行或结果不明，必须人工核查，不可重试')
    }
    // 总容量包含执行中和结果不明项，不因换绑丢弃这些状态。
    for (const [id, entry] of this.entries) if (entry.state === 'succeeded' || entry.state === 'failed') this.entries.delete(id)
    if (this.entries.size >= 64) throw new Error('待批或待核查操作已达上限')
    const content = `${submission.summary}\n\n操作：${submission.tool}\n目标：${submission.target}\n风险：${submission.risk}\n完整固定范围：\n${JSON.stringify(submission.snapshot, null, 2)}\n\n仅批准本次固定范围；拒绝不执行。批准后失败可能已有部分效果，结果不明时不可自动重试。`
    const proposal: AssistantProposal = {
      kind: 'assistant', proposalId: randomUUID(), revision: 1,
      digest: snapshotDigest({ tool: submission.tool, target: submission.target, content }), content,
      target: submission.target, epoch: this.epoch, expiresAt: this.now() + this.ttlMs,
      state: 'pending', summary: submission.summary, tool: submission.tool, risk: submission.risk,
    }
    this.entries.set(proposal.proposalId, { proposal, submission: { ...submission }, state: 'pending' })
    return { ...proposal }
  }

  async decide(id: string, decision: 'approve' | 'reject', epoch: string, token?: string): Promise<Record<string, unknown> & { ok: boolean }> {
    if (!this.verifyCapabilityToken(token)) return { ok: false, error: '助理审批凭据无效' }
    if (epoch !== this.epoch) return { ok: false, error: '审批代次已失效' }
    const entry = this.entries.get(id)
    if (!entry || entry.state !== 'pending') return { ok: false, error: '提案不可批准或已消费，不可重试' }
    if (decision !== 'approve' && decision !== 'reject') return { ok: false, error: '必须明确批准或拒绝' }
    if (decision === 'reject') {
      this.entries.delete(id)
      return { ok: true, decision: 'rejected' }
    }
    let valid = entry.proposal.expiresAt > this.now()
    try { valid = valid && entry.submission.validate() } catch { valid = false }
    if (!valid) {
      this.entries.delete(id)
      return { ok: false, error: '提案过期或范围已变化，请重新提交' }
    }
    entry.state = 'running' // 必须在任何 await 之前消费，换绑也不能删除在途状态。
    try {
      entry.result = await entry.submission.execute()
      entry.state = 'succeeded'
      return { ok: true, confirmed: true, state: entry.state, result: entry.result }
    } catch (error) {
      if (error instanceof BeforeEffectError) {
        entry.state = 'failed'
        entry.result = error.message
        return { ok: false, state: 'failed', retryable: true, error: entry.result }
      }
      entry.state = 'unknown'
      entry.result = error instanceof Error ? error.message : String(error)
      return { ok: false, state: 'unknown', retryable: false, error: entry.result }
    }
  }
}
