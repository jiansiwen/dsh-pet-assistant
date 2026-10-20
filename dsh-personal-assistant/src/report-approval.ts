/** 日报可信审批：独立于团队，模型只能提交；可信通道消费一次批准后立即发布。 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ApprovalError } from './approval.ts'
import { ReportStore, parseReportLines, publishRevisionFile, type PublishOutcome } from './report.ts'
import { inTransaction, sha256, tableExists, type Row } from './store.ts'

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

/**
 * 用户选择"自动发布"时的发布结果。
 *
 * 它不是审批：没有提案、没有凭据、没有用户签发的批准。走的是同一条发布记账与落盘路径
 * （临时文件 + 读回校验 + 更名覆盖守卫），只是签发这一步由**用户自己开启的开关**代替。
 */
export interface ReportAutoPublishResult {
  ok: boolean
  savedPath?: string
  revision?: number
  digest?: string
  target?: string
  existing?: boolean
  error?: string
}

/** 用户在设置里选择"日报直接保存"。缺省是手动批准。 */
export type ApprovalMode = 'manual' | 'auto'

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

export interface ReportDecisionRecord {
  proposalId: string
  revision: number
  /** pending / consumed / rejected / superseded */
  state: string
  expiresAt: number
  consumedAt: number | null
  result: ReportDecisionResult | null
}

/**
 * 读审批记录。审批表由 ReportApprovalService 建出；表还不存在（服务没装配过）时返回空，
 * 工作台据此如实显示"没有发布记录"，而不是报错。
 */
export function reportDecisions(db: DatabaseSync, reportId: string): ReportDecisionRecord[] {
  if (!tableExists(db, 'report_approvals')) return []
  const rows = db.prepare('SELECT * FROM report_approvals WHERE report_id = ? ORDER BY revision, expires_at').all(reportId) as Row[]
  return rows.map(row => {
    let result: ReportDecisionResult | null = null
    try { result = row.result_json ? JSON.parse(String(row.result_json)) as ReportDecisionResult : null } catch { result = null }
    return {
      proposalId: String(row.proposal_id), revision: Number(row.revision), state: String(row.state),
      expiresAt: Number(row.expires_at), consumedAt: row.consumed_at === null || row.consumed_at === undefined ? null : Number(row.consumed_at), result,
    }
  })
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
      state: 'pending', summary: `日报第 ${record.revision} 版（${this.entrySummary(record.reportId, record.revision, record.content)}）；批准后写入目标文件并停止活动记录`,
      tool: 'publish_report', risk: 'medium',
    }
  }

  /** 审批卡片上的条目摘要：共几条、几条待确认、这一版是谁怎么改出来的。全部由库里的版本算，不采信渲染层。 */
  private entrySummary(reportId: string, revision: number, content: string): string {
    const lines = parseReportLines(content)
    const entries = lines.filter(line => line.kind === 'entry')
    const pending = entries.filter(line => line.pending).length
    const parts = [`共 ${entries.length} 条${pending > 0 ? `，其中待确认 ${pending} 条` : ''}`]
    const edit = this.reports.edits(reportId).find(item => item.revision === revision)
    if (edit?.actor === 'assistant') parts.push('本版由助理整篇撰写')
    else if (edit && edit.line !== null) {
      const ordinal = lines.filter(line => line.kind === 'entry' && line.index < edit.line!).length + 1
      const verb = edit.op === 'rewrite' ? '改写了' : edit.op === 'delete' ? '删除了' : '补充了'
      parts.push(`本版由你在工作台${verb}第 ${ordinal} 条`)
    }
    return parts.join('；')
  }

  /** 这份日报历次审批的去向与结果（发布路径、是否停止采集、失败原因），工作台历史用。 */
  decisions(reportId: string): ReportDecisionRecord[] {
    return reportDecisions(this.db, reportId)
  }

  pendingProposals(now = this.now()): ReportProposal[] {
    const rows = this.db.prepare("SELECT * FROM report_approvals WHERE state = 'pending' AND epoch = ? AND expires_at > ?")
      .all(this.options.epoch, now) as Row[]
    return rows.map(row => this.project(row)).filter((item): item is ReportProposal => item !== null)
  }

  /**
   * 用户在设置里选择了"日报直接保存"时使用：不经审批卡片，直接把当前草稿发布到目标文件。
   *
   * 与 {@link decide} 的关系是"同一段发布代码、不同的签发来源"：
   * - 记账、校验、临时文件、读回比摘要、更名覆盖守卫全部复用，不另写一条简化路径；
   * - 唯一的差别是 `approve` 的签发者换成本方法的调用方，由**用户自己开启的开关**背书。
   *
   * 不做的事：不创建审批提案、不消费任何凭据、不写 approved_by（它只记录可信窗口签发的批准）。
   * 因此工作台上看到的仍是"没有审批记录"，与事实一致。
   */
  async autoPublish(reportId: string): Promise<ReportAutoPublishResult> {
    const record = this.reports.current(reportId)
    if (!record) return { ok: false, error: '还没有日报草稿，请先保存草稿' }
    const target = this.targetFor(reportId)
    const now = this.now()

    // 这一版已经成功发布过（例如重复调用）：按"已是这一版"返回，不重复发一遍。
    const previous = this.decisions(reportId)
      .filter(item => item.revision === record.revision && item.state === 'consumed')
      .reverse()
      .find(item => item.result?.ok === true && item.result.digest === record.digest)
    if (previous?.result?.savedPath) {
      return {
        ok: true, existing: true, savedPath: previous.result.savedPath,
        revision: record.revision, digest: record.digest, target,
      }
    }
    if (record.state === 'archived' || record.state === 'publishing') {
      return { ok: false, error: `日报第 ${record.revision} 版当前是 ${record.state}，不能重复发布；如需改动请先保存新草稿` }
    }
    if (record.state === 'revoked') {
      return { ok: false, error: `日报第 ${record.revision} 版已撤销（${record.revokedReason ?? '无原因'}），不能发布；请重新生成草稿` }
    }
    if (this.db.prepare("SELECT 1 FROM publish_jobs WHERE report_id = ? AND state = 'running'").get(reportId)) {
      return { ok: false, error: '日报正在发布或等待恢复核对，不能重复发布' }
    }

    // 发布前把版本推进到待确认：draft 与 pending_confirmation 都接受，后面的登记点会再核一次状态。
    const prepared = record.state === 'draft'
      ? (this.reports.submitForConfirmation(reportId, record.revision) ?? record)
      : record
    const approved = inTransaction(this.db, () => {
      // 目标路径与版本必须与发布登记点一致；签发者记作 auto（不是 desktop-shell，也不是模型）。
      const signed = this.reports.approve(reportId, prepared.revision, prepared.digest, target,
        { id: 'auto-publish', isUser: true }, now)
      if (!signed.ok) throw new Error(`日报当前状态不允许发布：${signed.rejection}`)
      const operationId = `auto-publish-${reportId}-r${prepared.revision}-${randomUUID()}`
      if (!this.reports.beginPublish(operationId, signed.record, now)) throw new Error('日报发布登记失败，未写文件')
      return { operationId, record: signed.record }
    })

    let outcome: PublishOutcome
    try {
      const guard = { knownDigests: this.reports.publishedDigests(approved.record.reportId) }
      outcome = await (this.options.publish ?? publishRevisionFile)(
        approved.record.targetPath!, approved.record.content, approved.record.digest, approved.record.revision, guard)
    } catch (error) {
      // 未知异常：保持"结果待核对"，不自动重发，下次调用会看到 running 作业并拒绝。
      return { ok: false, error: `发布结果待核对，不会自动重发：${String(error)}`, target }
    }
    if (!outcome.ok) {
      inTransaction(this.db, () => {
        this.reports.finishJob(approved.operationId, 'failed', this.now())
        this.reports.setReportState(reportId, approved.record.revision, 'draft')
      })
      return { ok: false, error: `${outcome.message}；未完成发布`, target }
    }
    inTransaction(this.db, () => {
      this.reports.finishJob(approved.operationId, 'succeeded', this.now())
      this.reports.setReportState(reportId, approved.record.revision, 'archived')
    })
    return {
      ok: true, savedPath: outcome.path, revision: approved.record.revision,
      digest: outcome.digest, target, existing: outcome.unchanged,
    }
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
      // 目标已存在时只覆盖本日报发布过的内容；已是这一版就不重写，别的内容如实报冲突。
      const guard = { knownDigests: this.reports.publishedDigests(record.reportId) }
      outcome = await (this.options.publish ?? publishRevisionFile)(record.targetPath!, record.content, record.digest, record.revision, guard)
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
      const written = outcome.unchanged ? '目标文件已经是这一版的内容，没有重复写入' : '日报已保存'
      result = {
        ok: true, confirmed: true, savedPath: outcome.path, revision: record.revision, digest: outcome.digest, modeExited,
        message: modeExited ? `${written}，活动记录已停止` : `${written}，但停止活动记录未确认成功；请手动停止${stopError ? `：${stopError}` : ''}`,
      }
    }
    this.db.prepare('UPDATE report_approvals SET result_json = ? WHERE proposal_id = ?').run(JSON.stringify(result), proposalId)
    return result
  }
}
