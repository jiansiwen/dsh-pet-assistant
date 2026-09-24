/** 日报可信审批：独立于团队，模型只能提交；可信通道消费一次批准后立即发布。 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ApprovalError } from './approval.ts'
import { ReportStore, publishRevisionFile, type PublishOutcome } from './report.ts'
import { inTransaction, sha256, type Row } from './store.ts'

export interface ReportProposal {
  kind: 'report'
  proposalId: string
  reportId: string
  revision: number
  digest: string
  content: string
  target: string
  epoch: string
  expiresAt: number
  state: 'pending'
  summary: string
  tool: 'publish_report'
  risk: 'medium'
}

export interface ReportDecisionResult {
  ok: boolean
  confirmed?: boolean
  decision?: 'rejected'
  savedPath?: string
  revision?: number
  digest?: string
  modeExited?: boolean
  error?: string
  message?: string
}

interface Options {
  epoch: string
  reportDir: string
  ttlMs: number
  stop(): Promise<void>
  active(): boolean
  now?: () => number
  publish?: typeof publishRevisionFile
}

export class ReportApprovalService {
  private readonly db: DatabaseSync
  private readonly reports: ReportStore
  private readonly options: Options
  private readonly token = randomUUID()

  constructor(db: DatabaseSync, reports: ReportStore, options: Options) {
    this.db = db
    this.reports = reports
    this.options = options
    db.exec(`CREATE TABLE IF NOT EXISTS report_approvals (
      proposal_id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      digest TEXT NOT NULL,
      target_path TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      epoch TEXT NOT NULL,
      state TEXT NOT NULL,
      consumed_at INTEGER,
      result_json TEXT
    )`)
  }

  /** 仅装配与主进程凭据文件使用，不注册成模型工具，不进入快照。文件不是操作系统沙箱。 */
  get approvalCapabilityToken(): string { return this.token }

  verifyCapabilityToken(presented: string | undefined): boolean {
    if (!presented) return false
    const a = Buffer.from(presented)
    const b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private now(): number { return this.options.now?.() ?? Date.now() }

  private targetFor(reportId: string): string {
    const date = /^daily:(\d{4}-\d{2}-\d{2})$/.exec(reportId)?.[1]
    if (!date) throw new Error('只接受日期明确的日报，不接受模型指定发布路径')
    return path.resolve(this.options.reportDir, `${date}.md`)
  }

  submit(reportId: string): ReportProposal {
    return inTransaction(this.db, () => {
      const record = this.reports.current(reportId)
      if (!record) throw new Error('还没有日报草稿，请先保存草稿')
      const pending = this.pendingProposals().find(item => item.reportId === reportId)
      if (pending) return pending
      if (record.state === 'draft') this.reports.submitForConfirmation(reportId, record.revision)
      else if (record.state !== 'pending_confirmation') throw new Error(`日报状态 ${record.state} 不能提交，请先读取草稿；发布结果不明时不得重发`)
      const target = this.targetFor(reportId)
      const proposalId = `report-${randomUUID()}`
      const expiresAt = this.now() + this.options.ttlMs
      this.db.prepare("UPDATE report_approvals SET state = 'superseded' WHERE report_id = ? AND state = 'pending'").run(reportId)
      // 提交时就绑定目标，批准不能换成请求体指定的另一个文件。
      this.db.prepare('UPDATE reports SET target_path = ? WHERE report_id = ? AND revision = ?').run(target, reportId, record.revision)
      this.db.prepare(`INSERT INTO report_approvals
        (proposal_id, report_id, revision, digest, target_path, expires_at, epoch, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(proposalId, reportId, record.revision, record.digest, target, expiresAt, this.options.epoch)
      return this.project(this.row(proposalId)!)!
    })
  }

  private row(proposalId: string): Row | undefined {
    return this.db.prepare('SELECT * FROM report_approvals WHERE proposal_id = ?').get(proposalId) as Row | undefined
  }

  /** 快照只展示仍可审批的当前版本；全文来自已绑定摘要的数据库版本，不接受舞台回传。 */
  private project(row: Row): ReportProposal | null {
    const record = this.reports.current(String(row.report_id))
    if (!record || record.revision !== Number(row.revision) || record.state !== 'pending_confirmation'
      || record.digest !== row.digest || sha256(record.content) !== row.digest
      || record.targetPath !== row.target_path || row.target_path !== this.targetFor(record.reportId)) return null
    return {
      kind: 'report', proposalId: String(row.proposal_id), reportId: record.reportId,
      revision: record.revision, digest: record.digest, content: record.content,
      target: String(row.target_path), epoch: String(row.epoch), expiresAt: Number(row.expires_at),
      state: 'pending', summary: `日报第 ${record.revision} 版；批准后写入目标文件并停止活动记录`,
      tool: 'publish_report', risk: 'medium',
    }
  }

  pendingProposals(now = this.now()): ReportProposal[] {
    const rows = this.db.prepare("SELECT * FROM report_approvals WHERE state = 'pending' AND epoch = ? AND expires_at > ?")
      .all(this.options.epoch, now) as Row[]
    return rows.map(row => this.project(row)).filter((item): item is ReportProposal => item !== null)
  }

  async decide(proposalId: string, decision: 'approve' | 'reject', epoch: string, token: string | undefined): Promise<ReportDecisionResult> {
    if (!this.verifyCapabilityToken(token)) throw new ApprovalError('UNTRUSTED_SUBJECT', '日报审批凭据无效')
    if (epoch !== this.options.epoch) throw new ApprovalError('EPOCH_MISMATCH', '日报审批所属运行时已变化，请重新提交')
    if (decision !== 'approve' && decision !== 'reject') throw new Error('未知的审批决定')
    const operationId = `publish-${proposalId}`
    const record = inTransaction(this.db, () => {
      const row = this.row(proposalId)
      if (!row) throw new ApprovalError('NOT_FOUND', '找不到这条日报待批记录')
      if (row.epoch !== epoch) throw new ApprovalError('EPOCH_MISMATCH', '旧运行时的日报审批已失效，请重新提交')
      if (row.state !== 'pending' || row.consumed_at !== null) throw new ApprovalError('ALREADY_CONSUMED', '这条日报审批已经使用，不能重放')
      const now = this.now()
      if (Number(row.expires_at) <= now) throw new ApprovalError('EXPIRED', '日报审批已过期，请重新提交')
      // 消费、重新校验当前版本/正文/目标、发布登记同事务，任何一项失败都不放行。
      this.db.prepare("UPDATE report_approvals SET state = ?, consumed_at = ? WHERE proposal_id = ? AND state = 'pending'")
        .run(decision === 'approve' ? 'consumed' : 'rejected', now, proposalId)
      const proposal = this.project(row)
      if (!proposal) throw new ApprovalError('DIGEST_MISMATCH', '日报版本、正文摘要或目标已改变，请重新展示并提交')
      if (decision === 'reject') {
        this.reports.setReportState(proposal.reportId, proposal.revision, 'draft')
        return null
      }
      const approved = this.reports.approve(proposal.reportId, proposal.revision, proposal.digest, proposal.target,
        { id: 'desktop-shell', isUser: true }, now)
      if (!approved.ok) throw new Error('日报当前状态不允许批准')
      if (!this.reports.beginPublish(operationId, approved.record, now)) throw new Error('日报发布登记失败，未写文件')
      return approved.record
    })
    if (!record) return { ok: true, decision: 'rejected' }

    let outcome: PublishOutcome
    try {
      outcome = await (this.options.publish ?? publishRevisionFile)(record.targetPath!, record.content, record.digest, record.revision)
    } catch (error) {
      // 未知异常不恢复批准、不重发；保留 running 作业和编辑锁，启动恢复只核对文件。
      return { ok: false, confirmed: false, error: `发布结果待核对，不会自动重发：${String(error)}` }
    }
    let result: ReportDecisionResult
    if (!outcome.ok) {
      inTransaction(this.db, () => {
        this.reports.finishJob(operationId, 'failed', this.now())
        this.reports.setReportState(record.reportId, record.revision, 'draft')
      })
      result = { ok: false, confirmed: false, error: `${outcome.message}；未完成发布，修复后须重新提交并由用户批准` }
    } else {
      inTransaction(this.db, () => {
        this.reports.finishJob(operationId, 'succeeded', this.now())
        this.reports.setReportState(record.reportId, record.revision, 'archived')
      })
      let stopError: string | undefined
      try { await this.options.stop() } catch (error) { stopError = String(error) }
      const modeExited = !this.options.active() && !stopError
      result = {
        ok: true, confirmed: true, savedPath: outcome.path, revision: record.revision, digest: outcome.digest, modeExited,
        message: modeExited ? '日报已保存，活动记录已停止' : `日报已保存，但停止活动记录未确认成功；请手动停止${stopError ? `：${stopError}` : ''}`,
      }
    }
    this.db.prepare('UPDATE report_approvals SET result_json = ? WHERE proposal_id = ?').run(JSON.stringify(result), proposalId)
    return result
  }
}
