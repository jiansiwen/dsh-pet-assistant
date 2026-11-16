/**
 * 子助理分派服务：总助理工具 `personal_assistant_dispatch_subassistant` 的执行体。
 *
 * 链路（设计 4.5）：深度检查 → 账本先行（dispatch_id 幂等）→ Registry 会话分派 →
 * 回执落账 → 结构化返回。返回值始终携带结果文本——无论汇报模式如何，
 * 总助理总会收到一份汇总（汇报分发归单元 6 的 subassistant-report 事件）。
 *
 * 防环第 2 层在这里：同一成员同一任务摘要（taskDigest）越权回退后再分派 depth+1，
 * 超过 maxDispatchDepth 记账 refused 并如实拒绝。改写任务文本=新摘要=新深度链
 * ——真重分析的表述理应不同。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { MemberDirectory } from './member-directory.ts'
import type { SubAssistantRegistry } from './sub-assistant-registry.ts'

export type SubAssistantDispatchStatus = 'completed' | 'escalated' | 'failed' | 'refused'

export interface SubAssistantDispatchResult {
  runId: string | null
  assistantId: string
  displayName: string
  status: SubAssistantDispatchStatus
  text: string
  depth: number
  elapsedMs: number
}

export interface SubAssistantDispatchLedger {
  getSubAssistantRunByDispatchId(dispatchId: string): { runId: string; status: string; resultKind: string | null; resultText: string | null; depth: number } | null
  beginSubAssistantRun(input: { runId: string; assistantId: string; dispatchId: string; taskDigest: string; depth: number }, at: number): { runId: string; status: string } | null
  finishSubAssistantRun(runId: string, status: 'completed' | 'escalated' | 'failed' | 'refused', resultKind: string, resultText: string, at: number): boolean
  latestEscalatedSubAssistantRun(assistantId: string, taskDigest: string): { depth: number } | null
}

export interface SubAssistantSelfReport {
  assistantId: string
  displayName: string
  skinId: string
  voiceProfile: string
  text: string
  runId: string
  reportMode: 'self'
}

export interface SubAssistantDispatchOptions {
  directory: Pick<MemberDirectory, 'get'>
  registry: SubAssistantRegistry
  ledger: SubAssistantDispatchLedger
  maxDispatchDepth: number
  timeoutMs: number
  now?: () => number
  /** 汇报分发（§4.6 ★①）：仅 completed 且成员 reportMode=self 时触发；chief 模式结果只经工具返回值进总助理上下文。 */
  onSelfReport?: (report: SubAssistantSelfReport) => void
}

export function subAssistantTaskDigest(task: string): string {
  return createHash('sha256').update(task).digest('hex')
}

export class SubAssistantDispatch {
  private readonly options: SubAssistantDispatchOptions

  constructor(options: SubAssistantDispatchOptions) {
    if (!Number.isSafeInteger(options.maxDispatchDepth) || options.maxDispatchDepth < 0
      || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('子助理分派参数无效（深度下限 0，超时须为正整数毫秒）')
    }
    this.options = options
  }

  /** 一次分派往返。dispatchId 即工具调用幂等键（exec.rootCallId），重放命中已有 run 直接返回。 */
  async dispatch(assistantId: string, task: string, dispatchId: string): Promise<SubAssistantDispatchResult> {
    const startedAt = this.now()
    const member = this.options.directory.get(assistantId)
    if (!member || !member.enabled) {
      return { runId: null, assistantId, displayName: assistantId, status: 'failed',
        text: `成员不存在或未启用：${assistantId}`, depth: 0, elapsedMs: this.now() - startedAt }
    }
    if (member.kind === 'expert' || member.binding === null) {
      return this.refuse(member.assistantId, member.displayName, dispatchId, task, 0,
        '普通成员（专家）不经子助理通道，请用现有成员对话或团队任务工具', startedAt)
    }
    // 幂等：同一次工具调用重放返回既有 run
    const existing = this.options.ledger.getSubAssistantRunByDispatchId(dispatchId)
    if (existing) {
      return { runId: existing.runId, assistantId: member.assistantId, displayName: member.displayName,
        status: existing.status as SubAssistantDispatchStatus,
        text: existing.resultText ?? existing.status,
        depth: existing.depth, elapsedMs: this.now() - startedAt }
    }
    // 防环第 2 层：同成员同任务摘要的越权回退链深度递增，超限拒绝
    const taskDigest = subAssistantTaskDigest(task)
    const prior = this.options.ledger.latestEscalatedSubAssistantRun(member.assistantId, taskDigest)
    const depth = prior ? prior.depth + 1 : 0
    if (depth > this.options.maxDispatchDepth) {
      return this.refuse(member.assistantId, member.displayName, dispatchId, task, depth,
        `任务已越权回退 ${this.options.maxDispatchDepth} 次仍未找到可承接的子助理（当前深度 ${depth}）。请重新分析任务与成员能力的匹配，或由你直接完成。`, startedAt)
    }
    const run = this.options.ledger.beginSubAssistantRun({ runId: randomUUID(), assistantId: member.assistantId,
      dispatchId, taskDigest, depth }, startedAt)
    if (!run || run.runId === '') {
      return { runId: null, assistantId: member.assistantId, displayName: member.displayName, status: 'failed',
        text: '分派账本写入失败', depth, elapsedMs: this.now() - startedAt }
    }
    const receipt = await this.options.registry.send(member, task, this.options.timeoutMs)
    const finishedAt = this.now()
    if (receipt.kind === 'reply') {
      this.options.ledger.finishSubAssistantRun(run.runId, 'completed', 'reply', receipt.text, finishedAt)
      // 回执驱动：账本终态先行，再推汇报事件（self 模式桌宠以其形象+音色播报）。
      if (member.reportMode === 'self') {
        this.options.onSelfReport?.({ assistantId: member.assistantId, displayName: member.displayName,
          skinId: member.skinId, voiceProfile: member.voiceProfile, text: receipt.text,
          runId: run.runId, reportMode: 'self' })
      }
      return { runId: run.runId, assistantId: member.assistantId, displayName: member.displayName,
        status: 'completed', text: receipt.text, depth, elapsedMs: finishedAt - startedAt }
    }
    if (receipt.kind === 'out-of-scope') {
      this.options.ledger.finishSubAssistantRun(run.runId, 'escalated', 'out-of-scope', receipt.reason, finishedAt)
      return { runId: run.runId, assistantId: member.assistantId, displayName: member.displayName,
        status: 'escalated', text: receipt.reason, depth, elapsedMs: finishedAt - startedAt }
    }
    const text = receipt.kind === 'timeout' ? '子助理超时未回执' : receipt.text
    this.options.ledger.finishSubAssistantRun(run.runId, 'failed', receipt.kind, text, finishedAt)
    return { runId: run.runId, assistantId: member.assistantId, displayName: member.displayName,
      status: 'failed', text, depth, elapsedMs: finishedAt - startedAt }
  }

  private refuse(assistantId: string, displayName: string, dispatchId: string, task: string, depth: number, reason: string, startedAt: number): SubAssistantDispatchResult {
    // 账本先行：拒绝也要如实入账（dispatch_id 唯一，重放命中既有 refused 行）
    const existing = this.options.ledger.getSubAssistantRunByDispatchId(dispatchId)
    const runId = existing?.runId ?? this.options.ledger.beginSubAssistantRun({ runId: randomUUID(), assistantId,
      dispatchId, taskDigest: subAssistantTaskDigest(task), depth }, startedAt)?.runId ?? null
    if (runId) this.options.ledger.finishSubAssistantRun(runId, 'refused', 'refused', reason, this.now())
    return { runId, assistantId, displayName, status: 'refused', text: reason, depth, elapsedMs: this.now() - startedAt }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}
