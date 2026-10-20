/**
 * 日报版本化与发布作业。
 *
 * 旧实现（tools.ts 的 personal_assistant_save_report）是"模型说用户确认了 → writeFile 覆盖
 * `${date}.md`"。三个问题：
 *
 * 1. 覆盖写没有版本，改错了找不回来；
 * 2. "用户已确认"是模型自己在参数里断言的，没有任何东西把那次确认钉在具体内容上——
 *    模型完全可以在用户点头之后又改两句话再写盘；
 * 3. writeFile 中途崩掉会留下半个文件，而库里已经记了 filePath，看起来像发布成功了。
 *
 * 这里按 design.md §2.5 的状态机重做：草稿 → 待确认 → 已批准 → 发布中 → 已归档，
 * 另有已撤销。确认绑定 reportId + revision + 内容摘要 + 目标路径四样，摘要对不上就拒绝；
 * 发布走版本化临时文件 → 校验摘要 → 原子更名，作业状态入库，崩溃后按同一个作业核对
 * 已经落盘的文件，不重复发布。
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { inTransaction, sha256, text, type Row } from './store.ts'
import type { MemoryActor } from './memory.ts'
import type { WorkItem } from './work-items.ts'

/** 日报写作的证据口径；工具返回与系统提示词共用同一句，避免两处说法漂移。 */
export const REPORT_EVIDENCE_RULES = '日报成果只能来自 direct 或 user_confirmed 事项；inferred 事项只能写进"待确认"部分并逐条标注"（待确认）"，不得写成已完成成果；evidence_removed 事项不得写入日报任何部分。'

/**
 * 按日报口径给工作事项分组。evidence_removed 只给编号与条数，不回传概括正文——
 * 依据已被用户删除的结论，不该再进入模型上下文被写回日报。
 */
export function partitionWorkItemsForReport(items: readonly WorkItem[]): {
  outcomes: WorkItem[]
  pendingConfirmation: WorkItem[]
  evidenceRemoved: { count: number; ids: string[] }
} {
  const removed = items.filter(item => item.status === 'evidence_removed')
  return {
    outcomes: items.filter(item => item.status === 'direct' || item.status === 'user_confirmed'),
    pendingConfirmation: items.filter(item => item.status === 'inferred'),
    evidenceRemoved: { count: removed.length, ids: removed.map(item => item.id) },
  }
}

export const REPORT_STATES = [
  'draft',
  'pending_confirmation',
  'approved',
  'publishing',
  'archived',
  'revoked',
] as const
export type ReportState = (typeof REPORT_STATES)[number]

export const PUBLISH_JOB_STATES = ['running', 'succeeded', 'failed', 'unknown'] as const
export type PublishJobState = (typeof PUBLISH_JOB_STATES)[number]

export interface ReportRevision {
  reportId: string
  revision: number
  content: string
  digest: string
  state: ReportState
  createdAt: number
  approvedBy: string | null
  approvedAt: number | null
  targetPath: string | null
  revokedReason: string | null
}

export interface PublishJob {
  operationId: string
  reportId: string
  revision: number
  targetPath: string
  digest: string
  state: PublishJobState
  startedAt: number
  endedAt: number | null
}

/** reportId = 主体 + 日期。同一天可以有多份（日报、周报补记），互不覆盖。 */
export function makeReportId(subject: string, date: string): string {
  const clean = subject.trim() || 'daily'
  return `${clean}:${date}`
}

/** 临时产物名带 revision：并发发布两次不同版本时不会互相踩，崩溃后也认得出是谁留下的。 */
export function tempPathFor(targetPath: string, revision: number): string {
  return `${targetPath}.r${revision}.tmp`
}

export type ApprovalRejection =
  | 'not_found'
  | 'stale_revision'
  | 'digest_mismatch'
  | 'wrong_state'
  | 'not_user'

export const APPROVAL_REJECTION_MESSAGES: Record<ApprovalRejection, string> = {
  not_found: '找不到这份日报',
  stale_revision: '这个版本已经不是最新内容了，用户看到的那份和库里对不上，需要重新展示再确认',
  digest_mismatch: '内容摘要对不上：确认之后正文被改过，这次确认作废',
  wrong_state: '当前状态不允许这个操作',
  not_user: '只有用户本人能确认日报定稿，模型转述的"用户已同意"不算确认',
}

/**
 * 自动发布的签发者标识。
 *
 * 与可信窗口的 `desktop-shell` 分开记：库里一眼能分辨"用户逐条确认过的"和
 * "用户打开自动保存后系统直接发的"，事后核查不会被混为一谈。
 */
export const AUTO_PUBLISH_ACTOR = 'auto-publish'

export class ReportStore {
  private readonly db: DatabaseSync

  // 同 MemoryStore：不用参数属性，否则 node --test 导不进来。
  constructor(db: DatabaseSync) {
    this.db = db
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        report_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        digest TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        approved_by TEXT,
        approved_at INTEGER,
        target_path TEXT,
        revoked_reason TEXT,
        PRIMARY KEY (report_id, revision)
      );

      CREATE TABLE IF NOT EXISTS publish_jobs (
        operation_id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        target_path TEXT NOT NULL,
        digest TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_reports_state ON reports (report_id, state);
      CREATE INDEX IF NOT EXISTS idx_publish_jobs_state ON publish_jobs (state, started_at);

      -- 每个版本是怎么来的：助理整篇重写，还是用户在工作台逐条改写/删除/补充。
      CREATE TABLE IF NOT EXISTS report_edits (
        report_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        base_revision INTEGER,
        actor TEXT NOT NULL,
        op TEXT NOT NULL,
        line_index INTEGER,
        before_text TEXT,
        after_text TEXT,
        work_item_ids TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (report_id, revision)
      );

      -- 条目（行）与工作事项的关联，按版本保存；工作台据此说明每条事项是否纳入、为什么。
      CREATE TABLE IF NOT EXISTS report_entry_links (
        report_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        line_index INTEGER NOT NULL,
        work_item_ids TEXT NOT NULL,
        PRIMARY KEY (report_id, revision, line_index)
      );

      -- 已导出文件的删除账本：删除导出文件和撤销版本是两回事，各记各的。
      CREATE TABLE IF NOT EXISTS report_export_deletions (
        report_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        path TEXT NOT NULL,
        digest TEXT NOT NULL,
        reason TEXT NOT NULL,
        deleted_at INTEGER NOT NULL,
        PRIMARY KEY (report_id, revision, path)
      );

      -- 删除回执：每次经可信确认执行的删除都留一份四类结果，工作台历史里可以回看。
      CREATE TABLE IF NOT EXISTS deletion_receipts (
        receipt_id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
  }

  /**
   * 存一版草稿 = 新增一个 revision。
   *
   * 内容一变，之前那次批准就自动作废：旧 revision 直接落 revoked 并写明原因。
   * 这不是清理，是审计——回头查"为什么用户确认过的东西没发出去"，答案在库里。
   */
  saveDraft(reportId: string, content: string, now: number): ReportRevision {
    return inTransaction(this.db, () => {
      const latest = this.current(reportId)
      // 文件发布是异步的：从作业登记到收尾期间锁住改稿，避免旧版 rename 覆盖新版。
      if (this.db.prepare("SELECT 1 FROM publish_jobs WHERE report_id = ? AND state = 'running'").get(reportId)) {
        throw new Error('日报正在发布或等待恢复核对，暂时不能修改；不会自动重发')
      }
      const revision = (latest?.revision ?? 0) + 1
      if (latest && latest.state !== 'revoked' && latest.state !== 'archived') {
        this.markRevoked(reportId, latest.revision, '内容已更新，旧版本的确认随之作废')
      }
      this.db
        .prepare(
          `INSERT INTO reports (report_id, revision, content, digest, state, created_at)
           VALUES (?, ?, ?, ?, 'draft', ?)`,
        )
        .run(reportId, revision, content, sha256(content), now)
      const inserted = this.revision(reportId, revision)
      if (!inserted) throw new Error(`report ${reportId} r${revision} vanished inside its own transaction`)
      return inserted
    })
  }

  /** 相同内容重复保存不新增版本：模型有时会连着调两次，凭空多一版会让"最新"变得没意义。 */
  saveDraftIfChanged(reportId: string, content: string, now: number): ReportRevision {
    const latest = this.current(reportId)
    if (latest && latest.digest === sha256(content) && latest.state !== 'revoked') return latest
    return this.saveDraft(reportId, content, now)
  }

  /**
   * 迁移专用：把一份磁盘上已经存在的旧定稿登记成归档版本。
   *
   * 不建发布作业、不写文件、不碰原文件——design.md §9.3 明确"已归档报告原文件不改"。
   * 这里只是让旧日报在新库里有个身份，好在界面上列出来、算进保留期、被删除覆盖到。
   * 同一个 reportId 已经有版本就返回 false，重复迁移不会插第二遍。
   */
  importArchived(
    reportId: string,
    content: string,
    targetPath: string,
    approvedAt: number,
  ): boolean {
    if (this.current(reportId)) return false
    return inTransaction(this.db, () => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO reports
             (report_id, revision, content, digest, state, created_at, approved_by, approved_at, target_path)
           VALUES (?, 1, ?, ?, 'archived', ?, 'migration', ?, ?)`,
        )
        .run(reportId, content, sha256(content), approvedAt, approvedAt, targetPath)
      return Number(result.changes) > 0
    })
  }

  current(reportId: string): ReportRevision | null {
    const row = this.db
      .prepare('SELECT * FROM reports WHERE report_id = ? ORDER BY revision DESC LIMIT 1')
      .get(reportId) as Row | undefined
    return row ? rowToRevision(row) : null
  }

  revision(reportId: string, revision: number): ReportRevision | null {
    const row = this.db
      .prepare('SELECT * FROM reports WHERE report_id = ? AND revision = ?')
      .get(reportId, revision) as Row | undefined
    return row ? rowToRevision(row) : null
  }

  history(reportId: string): ReportRevision[] {
    const rows = this.db
      .prepare('SELECT * FROM reports WHERE report_id = ? ORDER BY revision DESC')
      .all(reportId) as Row[]
    return rows.map(rowToRevision)
  }

  /** 草稿 → 待确认。只有当前版本能提交，旧版本提交上去等于让用户确认一份过时内容。 */
  submitForConfirmation(reportId: string, revision: number): ReportRevision | null {
    return inTransaction(this.db, () => {
      const record = this.revision(reportId, revision)
      if (!record || record.state !== 'draft') return null
      if (this.current(reportId)?.revision !== revision) return null
      this.db
        .prepare(`UPDATE reports SET state = 'pending_confirmation' WHERE report_id = ? AND revision = ?`)
        .run(reportId, revision)
      const updated = this.revision(reportId, revision)
      if (!updated) throw new Error(`report ${reportId} r${revision} vanished inside its own transaction`)
      return updated
    })
  }

  /**
   * 用户确认定稿。四样东西必须同时对上：reportId、revision、内容摘要、目标路径。
   *
   * 摘要是这里的关键。确认这个动作发生在"用户看着某段文字点头"的那一刻，
   * 摘要就是把那一刻的文字钉住的钉子；写盘前再比一次，改过就拒绝。
   */
  approve(
    reportId: string,
    revision: number,
    expectedDigest: string,
    targetPath: string,
    actor: MemoryActor,
    now: number,
  ): { ok: true; record: ReportRevision } | { ok: false; rejection: ApprovalRejection } {
    if (!actor.isUser) return { ok: false, rejection: 'not_user' }
    return inTransaction(this.db, () => {
      const record = this.revision(reportId, revision)
      if (!record) return { ok: false as const, rejection: 'not_found' as const }
      if (this.current(reportId)?.revision !== revision) {
        return { ok: false as const, rejection: 'stale_revision' as const }
      }
      if (record.digest !== expectedDigest) return { ok: false as const, rejection: 'digest_mismatch' as const }
      if (record.state !== 'pending_confirmation' && record.state !== 'draft') {
        return { ok: false as const, rejection: 'wrong_state' as const }
      }
      this.db
        .prepare(
          `UPDATE reports SET state = 'approved', approved_by = ?, approved_at = ?, target_path = ?
           WHERE report_id = ? AND revision = ?`,
        )
        .run(actor.id, now, targetPath, reportId, revision)
      const approved = this.revision(reportId, revision)
      if (!approved) throw new Error(`report ${reportId} r${revision} vanished inside its own transaction`)
      return { ok: true as const, record: approved }
    })
  }

  /**
   * 活动删除前调用：没有逐条证据关联，按 daily:日期保守撤销全部未发布版本。
   * 只使版本失效，不逐条删除正文，也不修改归档或已导出文件。
   * 全部日期先预检，再在同一事务内更新；调用方应在删除来源前完成此调用。
   */
  public invalidateActivityDates(dates: readonly string[], reason: string): ReportRevision[] {
    return this.invalidateDates(dates, reason)
  }

  /** 任意来源（活动、导入资料）被删时的保守撤销；口径同 {@link invalidateActivityDates}。 */
  public invalidateDates(dates: readonly string[], reason: string): ReportRevision[] {
    return inTransaction(this.db, () => {
      const blocked = this.invalidationBlocker(dates)
      if (blocked) throw new Error(blocked)
      const revoked: ReportRevision[] = []
      for (const record of this.unpublishedFor(dates)) {
        this.markRevoked(record.reportId, record.revision, reason)
        revoked.push(this.revision(record.reportId, record.revision)!)
      }
      return revoked
    })
  }

  /** 这些日期的日报正在发布或发布结果未知时，返回不能删除来源的原因。 */
  invalidationBlocker(dates: readonly string[]): string | null {
    for (const reportId of [...new Set(dates)].map(date => makeReportId('daily', date))) {
      if (this.db.prepare(`SELECT 1 FROM publish_jobs
        WHERE report_id = ? AND state IN ('running', 'unknown')`).get(reportId)) {
        return '日报正在发布或发布结果未知，暂时不能删除来源；请先核对发布结果'
      }
    }
    return null
  }

  /** 这些日期里会被保守撤销的未发布版本（草稿、待批、已批未发）。预览与执行共用。 */
  unpublishedFor(dates: readonly string[]): ReportRevision[] {
    return [...new Set(dates)].map(date => makeReportId('daily', date))
      .flatMap(reportId => this.history(reportId))
      .filter(record => record.state === 'draft' || record.state === 'pending_confirmation' || record.state === 'approved')
  }

  markRevoked(reportId: string, revision: number, reason: string): void {
    this.db
      .prepare(`UPDATE reports SET state = 'revoked', revoked_reason = ? WHERE report_id = ? AND revision = ?`)
      .run(reason, reportId, revision)
  }

  /**
   * 发布前记账。作业行先落库再动文件——反过来做的话，写文件成功但记账失败会留下
   * 一个库里完全不知道的产物，恢复时无从判断它是不是完整的。
   */
  beginPublish(operationId: string, record: ReportRevision, now: number): PublishJob | null {
    if (record.state !== 'approved') return null
    return inTransaction(this.db, () => {
      // 不信调用方缓存的 approved：重复点击、旧版本与目标占用都在真实执行点拦住。
      const current = this.current(record.reportId)
      if (!current || current.revision !== record.revision || current.state !== 'approved'
        || !current.targetPath || current.targetPath !== record.targetPath
        || current.digest !== record.digest || sha256(current.content) !== record.digest) return null
      if (this.job(operationId)) return null
      if (this.db.prepare("SELECT 1 FROM publish_jobs WHERE target_path = ? AND state = 'running'").get(current.targetPath)) return null
      this.db
        .prepare(
          `INSERT INTO publish_jobs
             (operation_id, report_id, revision, target_path, digest, state, started_at)
           VALUES (?, ?, ?, ?, ?, 'running', ?)`,
        )
        .run(operationId, record.reportId, record.revision, current.targetPath, record.digest, now)
      this.db
        .prepare(`UPDATE reports SET state = 'publishing' WHERE report_id = ? AND revision = ?`)
        .run(record.reportId, record.revision)
      return this.job(operationId)
    })
  }

  job(operationId: string): PublishJob | null {
    const row = this.db
      .prepare('SELECT * FROM publish_jobs WHERE operation_id = ?')
      .get(operationId) as Row | undefined
    return row ? rowToJob(row) : null
  }

  /** 未收尾的作业。启动时拿来逐个核对，判断该续做、该认账还是该报未知。 */
  openJobs(): PublishJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM publish_jobs WHERE state IN ('running') ORDER BY started_at`)
      .all() as Row[]
    return rows.map(rowToJob)
  }

  finishJob(operationId: string, state: PublishJobState, now: number): void {
    this.db
      .prepare('UPDATE publish_jobs SET state = ?, ended_at = ? WHERE operation_id = ?')
      .run(state, now, operationId)
  }

  setReportState(reportId: string, revision: number, state: ReportState): void {
    this.db
      .prepare('UPDATE reports SET state = ? WHERE report_id = ? AND revision = ?')
      .run(state, reportId, revision)
  }

  /**
   * 自动发布前把当前版本落成"已批准"，签发者由调用方给出。
   *
   * 与 {@link approve} 的分工：那边只接受可信窗口（desktop-shell）签发的用户确认；
   * 这边服务的是用户在设置里自己打开的"日报直接保存"开关，签发者记作 auto-publish，
   * 所以两者的审计痕迹在库里能分开看，不会被混成"用户逐条确认过"。
   */
  signForAutoPublish(
    reportId: string,
    revision: number,
    expectedDigest: string,
    targetPath: string,
    now: number,
  ): { ok: true; record: ReportRevision } | { ok: false; rejection: ApprovalRejection } {
    return inTransaction(this.db, () => {
      const record = this.revision(reportId, revision)
      if (!record) return { ok: false as const, rejection: 'not_found' as const }
      if (this.current(reportId)?.revision !== revision) return { ok: false as const, rejection: 'stale_revision' as const }
      if (record.digest !== expectedDigest) return { ok: false as const, rejection: 'digest_mismatch' as const }
      if (record.state !== 'pending_confirmation' && record.state !== 'draft') {
        return { ok: false as const, rejection: 'wrong_state' as const }
      }
      this.db
        .prepare(
          `UPDATE reports SET state = 'approved', approved_by = ?, approved_at = ?, target_path = ?
           WHERE report_id = ? AND revision = ?`,
        )
        .run(AUTO_PUBLISH_ACTOR, now, targetPath, reportId, revision)
      const approved = this.revision(reportId, revision)
      if (!approved) throw new Error(`report ${reportId} r${revision} vanished inside its own transaction`)
      return { ok: true as const, record: approved }
    })
  }

  // -------------------------------------------------------------------------
  // 逐条修订（M3-04）
  // -------------------------------------------------------------------------

  /**
   * 在工作台里改一条：基于用户正在看的那一版（版本号 + 摘要）应用一次改写/删除/补充，产生新版本。
   *
   * 基准版本对不上就拒绝，不做"自动合并"：用户看着第 2 版点的删除，库里已经是助理刚写的第 3 版，
   * 按行号删下去删的就不是用户看到的那条了。已撤销的版本不能当基准——撤销通常是因为证据被删，
   * 在它上面接着改等于把失效的内容带回来。dryRun 只算预览，库里一行不动。
   */
  saveEdit(input: {
    reportId: string
    baseRevision: number
    baseDigest: string
    op: ReportEditOp
    /** 新增条目关联的工作事项（"从事项加入草稿"）。 */
    workItemIds?: readonly string[]
    /** 还没有任何草稿时，补充的第一条用这个标题起头。 */
    emptyTitle?: string
    now: number
    dryRun?: boolean
  }): ReportEditOutcome {
    return inTransaction(this.db, () => {
      const current = this.current(input.reportId)
      const conflict = (code: 'stale_base' | 'revoked_base' | 'locked', message: string): ReportEditOutcome => ({
        ok: false, code, message,
        current: current ? { revision: current.revision, digest: current.digest, state: current.state } : null,
      })
      if ((current?.revision ?? 0) !== input.baseRevision || (current && current.digest !== input.baseDigest)) {
        return conflict('stale_base', current
          ? `你看到的是第 ${input.baseRevision} 版，草稿已经是第 ${current.revision} 版了（可能刚被助理或另一个窗口改过）；请刷新后再改，这次没有保存`
          : '草稿已不存在，请刷新')
      }
      if (current?.state === 'revoked') {
        return conflict('revoked_base', `第 ${current.revision} 版已撤销（${current.revokedReason ?? '无原因'}），不能在它上面继续修改；请让助理重新生成草稿`)
      }
      if (this.db.prepare("SELECT 1 FROM publish_jobs WHERE report_id = ? AND state = 'running'").get(input.reportId)) {
        return conflict('locked', '日报正在发布或等待恢复核对，暂时不能修改；不会自动重发')
      }
      const base = current?.content ?? (input.op.type === 'add' ? `# ${input.emptyTitle ?? '工作日报'}\n\n` : null)
      if (base === null) return { ok: false, code: 'bad_line', message: '还没有草稿，只能补充条目', current: null }
      const applied = applyReportEdit(base, input.op)
      if (!applied.ok) return { ok: false, code: applied.code, message: applied.message, current: current ? { revision: current.revision, digest: current.digest, state: current.state } : null }
      if (current && applied.content === current.content) {
        return { ok: false, code: 'no_change', message: '改动前后内容相同，没有产生新版本', current: { revision: current.revision, digest: current.digest, state: current.state } }
      }
      const previousLinks = current ? this.links(input.reportId, current.revision) : new Map<number, string[]>()
      const added = input.op.type === 'add' && input.workItemIds && input.workItemIds.length > 0 ? [...new Set(input.workItemIds)] : null
      const links = shiftLinks(previousLinks, input.op, applied.line, added)
      if (input.dryRun) {
        return { ok: true, saved: false, preview: applied.content, digest: sha256(applied.content), line: applied.line, before: applied.before, after: applied.after, record: null, links }
      }
      const record = this.saveDraft(input.reportId, applied.content, input.now)
      this.setLinks(input.reportId, record.revision, links)
      this.recordEdit({
        reportId: input.reportId, revision: record.revision, baseRevision: current?.revision ?? null, actor: 'workbench',
        op: input.op.type, line: applied.line, before: applied.before, after: applied.after,
        // 删除与改写记下原条目关联的事项：之后工作台才能说清"这条事项是你在第几版删掉的"。
        workItemIds: added ?? previousLinks.get(applied.line) ?? [], now: input.now,
      })
      return { ok: true, saved: true, preview: applied.content, digest: record.digest, line: applied.line, before: applied.before, after: applied.after, record, links }
    })
  }

  recordEdit(edit: {
    reportId: string; revision: number; baseRevision: number | null; actor: 'workbench' | 'assistant'
    op: 'replace' | ReportEditOp['type']; line: number | null; before: string | null; after: string | null
    workItemIds: readonly string[]; now: number
  }): void {
    this.db.prepare(`INSERT OR REPLACE INTO report_edits (report_id, revision, base_revision, actor, op, line_index, before_text,
        after_text, work_item_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(edit.reportId, edit.revision, edit.baseRevision, edit.actor, edit.op, edit.line, edit.before, edit.after,
        JSON.stringify([...edit.workItemIds]), edit.now)
  }

  edits(reportId: string): ReportEdit[] {
    return (this.db.prepare('SELECT * FROM report_edits WHERE report_id = ? ORDER BY revision').all(reportId) as Row[]).map(row => ({
      revision: Number(row.revision),
      baseRevision: row.base_revision === null || row.base_revision === undefined ? null : Number(row.base_revision),
      actor: String(row.actor) as ReportEdit['actor'],
      op: String(row.op) as ReportEdit['op'],
      line: row.line_index === null || row.line_index === undefined ? null : Number(row.line_index),
      before: text(row.before_text),
      after: text(row.after_text),
      workItemIds: parseIds(text(row.work_item_ids)),
      createdAt: Number(row.created_at),
    }))
  }

  /** 某一版里每一行关联的事项（行号 → 事项编号）。 */
  links(reportId: string, revision: number): Map<number, string[]> {
    const rows = this.db.prepare('SELECT * FROM report_entry_links WHERE report_id = ? AND revision = ? ORDER BY line_index')
      .all(reportId, revision) as Row[]
    return new Map(rows.map(row => [Number(row.line_index), parseIds(text(row.work_item_ids))]))
  }

  setLinks(reportId: string, revision: number, links: ReadonlyMap<number, readonly string[]>): void {
    inTransaction(this.db, () => {
      this.db.prepare('DELETE FROM report_entry_links WHERE report_id = ? AND revision = ?').run(reportId, revision)
      const insert = this.db.prepare('INSERT INTO report_entry_links (report_id, revision, line_index, work_item_ids) VALUES (?, ?, ?, ?)')
      for (const [line, ids] of links) if (ids.length > 0) insert.run(reportId, revision, line, JSON.stringify([...new Set(ids)]))
    })
  }

  /** 这份日报发布成功过的内容摘要。目标文件内容属于其中之一，才算"本插件写过的文件"，可以覆盖。 */
  publishedDigests(reportId: string): string[] {
    const rows = this.db.prepare(`SELECT digest FROM publish_jobs WHERE report_id = ? AND state = 'succeeded'
      UNION SELECT digest FROM reports WHERE report_id = ? AND state = 'archived'`).all(reportId, reportId) as Row[]
    return rows.map(row => String(row.digest))
  }

  jobsFor(reportId: string): PublishJob[] {
    return (this.db.prepare('SELECT * FROM publish_jobs WHERE report_id = ? ORDER BY started_at').all(reportId) as Row[]).map(rowToJob)
  }

  recordExportDeletion(reportId: string, revision: number, filePath: string, digest: string, reason: string, now: number): void {
    this.db.prepare(`INSERT OR REPLACE INTO report_export_deletions (report_id, revision, path, digest, reason, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(reportId, revision, filePath, digest, reason, now)
  }

  exportDeletions(reportId: string): Array<{ revision: number; path: string; digest: string; reason: string; deletedAt: number }> {
    return (this.db.prepare('SELECT * FROM report_export_deletions WHERE report_id = ? ORDER BY deleted_at').all(reportId) as Row[])
      .map(row => ({ revision: Number(row.revision), path: String(row.path), digest: String(row.digest), reason: String(row.reason), deletedAt: Number(row.deleted_at) }))
  }

  recordDeletionReceipt(category: string, scope: unknown, receipt: unknown, now: number): string {
    deletionCounter += 1
    const id = `receipt-${now.toString(36)}-${deletionCounter.toString(36)}`
    this.db.prepare('INSERT INTO deletion_receipts (receipt_id, category, scope_json, receipt_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, category, JSON.stringify(scope ?? null), JSON.stringify(receipt ?? null), now)
    return id
  }

  deletionReceipts(limit = 50): Array<{ id: string; category: string; scope: unknown; receipt: unknown; createdAt: number }> {
    return (this.db.prepare('SELECT * FROM deletion_receipts ORDER BY created_at DESC, receipt_id DESC LIMIT ?').all(limit) as Row[])
      .map(row => ({
        id: String(row.receipt_id), category: String(row.category),
        scope: JSON.parse(String(row.scope_json)), receipt: JSON.parse(String(row.receipt_json)), createdAt: Number(row.created_at),
      }))
  }
}

let deletionCounter = 0

function parseIds(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export interface ReportEdit {
  revision: number
  baseRevision: number | null
  actor: 'workbench' | 'assistant'
  op: 'replace' | 'rewrite' | 'delete' | 'add'
  line: number | null
  before: string | null
  after: string | null
  workItemIds: string[]
  createdAt: number
}

export type ReportEditOutcome =
  | {
      ok: true
      saved: boolean
      preview: string
      digest: string
      line: number
      before: string | null
      after: string | null
      record: ReportRevision | null
      links: Map<number, string[]>
    }
  | {
      ok: false
      code: 'stale_base' | 'revoked_base' | 'locked' | 'no_change' | ReportEditRejection
      message: string
      current: { revision: number; digest: string; state: ReportState } | null
    }

// ---------------------------------------------------------------------------
// 条目：日报正文按行解析；列表项就是"一条"
// ---------------------------------------------------------------------------

export interface ReportLine {
  index: number
  kind: 'heading' | 'entry' | 'text' | 'blank'
  raw: string
  /** 条目正文（去掉列表符号）；标题为标题文字；其余为原文。 */
  text: string
  /** 所属小节（最近的标题）；没有为 null。 */
  section: string | null
  /** 是否带"（待确认）"标注。 */
  pending: boolean
}

const ENTRY_LINE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const HEADING_LINE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const PENDING_MARK = /[（(]待确认[）)]/
/** 单条上限：一条日报写成一篇文章，就不是"一条"了。 */
export const MAX_ENTRY_CHARS = 500

export function isPendingEntry(textValue: string): boolean {
  return PENDING_MARK.test(textValue)
}

export function parseReportLines(content: string): ReportLine[] {
  let section: string | null = null
  return content.replace(/\r\n?/g, '\n').split('\n').map((raw, index) => {
    const heading = HEADING_LINE.exec(raw)
    if (heading) {
      section = heading[1].trim()
      return { index, kind: 'heading' as const, raw, text: section, section, pending: false }
    }
    const entry = ENTRY_LINE.exec(raw)
    if (entry) return { index, kind: 'entry' as const, raw, text: entry[3].trim(), section, pending: isPendingEntry(entry[3]) }
    if (raw.trim() === '') return { index, kind: 'blank' as const, raw, text: '', section, pending: false }
    return { index, kind: 'text' as const, raw, text: raw.trim(), section, pending: false }
  })
}

export type ReportEditOp =
  | { type: 'rewrite'; line: number; expectedText: string; text: string }
  | { type: 'delete'; line: number; expectedText: string }
  /** afterLine = -1 表示接在文末。 */
  | { type: 'add'; afterLine: number; text: string }

export type ReportEditRejection = 'bad_line' | 'text_mismatch' | 'empty_text' | 'multiline' | 'too_long'

/** 纯函数：把一次逐条修改应用到正文上。行号与预期原文都要对上，防止改到别的条目。 */
export function applyReportEdit(content: string, op: ReportEditOp):
  | { ok: true; content: string; line: number; before: string | null; after: string | null }
  | { ok: false; code: ReportEditRejection; message: string } {
  const normalized = content.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const parsed = parseReportLines(normalized)
  const checkText = (value: unknown): string | { code: ReportEditRejection; message: string } => {
    const next = typeof value === 'string' ? value.trim() : ''
    if (!next) return { code: 'empty_text', message: '条目内容不能为空；要去掉这条请用删除' }
    if (/[\r\n]/.test(next)) return { code: 'multiline', message: '一条只能是一行；多件事请分成多条补充' }
    if (next.length > MAX_ENTRY_CHARS) return { code: 'too_long', message: `一条不能超过 ${MAX_ENTRY_CHARS} 个字` }
    return next
  }
  if (op.type === 'add') {
    const value = checkText(op.text)
    if (typeof value !== 'string') return { ok: false, ...value }
    const requested = Number(op.afterLine)
    if (!Number.isInteger(requested) || requested < -1 || requested >= lines.length) return { ok: false, code: 'bad_line', message: '补充位置不存在，请刷新后再试' }
    // 接在文末时插到末尾空行之前，保持文件以换行结尾；指着末尾那个空行也按文末处理。
    const trailingBlank = lines.length > 0 && lines[lines.length - 1] === ''
    const after = trailingBlank && requested === lines.length - 1 ? -1 : requested
    const position = after === -1 ? (trailingBlank ? lines.length - 1 : lines.length) : after + 1
    const anchor = after === -1 ? [...parsed].reverse().find(line => line.kind === 'entry') : parsed[after]
    const indent = anchor?.kind === 'entry' ? (ENTRY_LINE.exec(anchor.raw)?.[1] ?? '') : ''
    const raw = `${indent}- ${value}`
    lines.splice(position, 0, raw)
    return { ok: true, content: lines.join('\n'), line: position, before: null, after: value }
  }
  const index = Number(op.line)
  const target = Number.isInteger(index) ? parsed[index] : undefined
  if (!target || target.kind !== 'entry') return { ok: false, code: 'bad_line', message: '这一行不是日报条目，或已不存在；请刷新后再试' }
  if (typeof op.expectedText !== 'string' || target.text !== op.expectedText.trim()) {
    return { ok: false, code: 'text_mismatch', message: '这一条的内容和你看到的不一致，可能已被修改；请刷新后再试' }
  }
  if (op.type === 'delete') {
    lines.splice(index, 1)
    return { ok: true, content: lines.join('\n'), line: index, before: target.text, after: null }
  }
  const value = checkText(op.text)
  if (typeof value !== 'string') return { ok: false, ...value }
  const match = ENTRY_LINE.exec(target.raw)!
  lines[index] = `${match[1]}${match[2]} ${value}`
  return { ok: true, content: lines.join('\n'), line: index, before: target.text, after: value }
}

/** 一次修改之后，行号随插入/删除平移，原有关联跟着条目走。改写保留关联：改的是同一件事的说法。 */
function shiftLinks(links: ReadonlyMap<number, readonly string[]>, op: ReportEditOp, line: number, added: string[] | null): Map<number, string[]> {
  const next = new Map<number, string[]>()
  for (const [index, ids] of links) {
    if (op.type === 'delete') {
      if (index === line) continue
      next.set(index > line ? index - 1 : index, [...ids])
    } else if (op.type === 'add') {
      next.set(index >= line ? index + 1 : index, [...ids])
    } else {
      next.set(index, [...ids])
    }
  }
  if (op.type === 'add' && added) next.set(line, added)
  return next
}

/** 把助理整篇保存时声明的"条目 → 事项"对应到行号。条目文字必须与正文中的某一条完全一致。 */
export function linkEntries(content: string, entries: ReadonlyArray<{ text: string; workItemIds: readonly string[] }>):
  { ok: true; links: Map<number, string[]> } | { ok: false; message: string } {
  const parsed = parseReportLines(content).filter(line => line.kind === 'entry')
  const links = new Map<number, string[]>()
  for (const entry of entries) {
    const wanted = typeof entry.text === 'string' ? entry.text.trim().replace(/^([-*+]|\d+[.)])\s+/, '') : ''
    const found = parsed.find(line => line.text === wanted && !links.has(line.index))
    if (!found) return { ok: false, message: `草稿里找不到这一条：「${wanted.slice(0, 40)}」；entries 的 text 必须与正文中的某个列表条目逐字一致` }
    const ids = [...new Set((Array.isArray(entry.workItemIds) ? entry.workItemIds : []).map(String).filter(Boolean))]
    if (ids.length === 0) return { ok: false, message: `条目「${wanted.slice(0, 40)}」没有给出关联的工作事项编号` }
    links.set(found.index, ids)
  }
  return { ok: true, links }
}

function rowToRevision(row: Row): ReportRevision {
  return {
    reportId: String(row.report_id),
    revision: Number(row.revision),
    content: String(row.content),
    digest: String(row.digest),
    state: String(row.state) as ReportState,
    createdAt: Number(row.created_at),
    approvedBy: text(row.approved_by),
    approvedAt: row.approved_at === null || row.approved_at === undefined ? null : Number(row.approved_at),
    targetPath: text(row.target_path),
    revokedReason: text(row.revoked_reason),
  }
}

function rowToJob(row: Row): PublishJob {
  return {
    operationId: String(row.operation_id),
    reportId: String(row.report_id),
    revision: Number(row.revision),
    targetPath: String(row.target_path),
    digest: String(row.digest),
    state: String(row.state) as PublishJobState,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
  }
}

// ---------------------------------------------------------------------------
// 落盘：临时产物 → 校验摘要 → 原子更名
// ---------------------------------------------------------------------------

export type PublishOutcome =
  | { ok: true; path: string; digest: string; unchanged?: boolean }
  | { ok: false; reason: 'write_failed' | 'digest_mismatch' | 'rename_failed' | 'target_conflict'; message: string }

/**
 * 目标文件已存在时怎么办。缺省（不传）保持旧行为：直接覆盖。
 *
 * 可信发布总会传：目标里已经是这一版就不重写（重复批准不重复导出）；是本日报发布过的某一版
 * 才允许覆盖（改稿后再发布）；别的内容——用户手改过、或者是不相干的文件——一律不覆盖，如实报冲突。
 */
export interface PublishGuard {
  knownDigests: readonly string[]
}

async function existingDigest(targetPath: string): Promise<{ kind: 'missing' } | { kind: 'file'; digest: string } | { kind: 'error'; code: string; message: string }> {
  try {
    return { kind: 'file', digest: sha256(await readFile(targetPath, 'utf8')) }
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code ?? '')
    // 父路径不是目录时目标自然不存在；真正的磁盘错误留给后面的写入如实报出来。
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
    return { kind: 'error', code, message: describe(error) }
  }
}

function conflictMessage(targetPath: string): string {
  return `目标文件 ${targetPath} 已存在，内容不是这份日报发布过的任何一版（可能被手动改过，或是别的文件），没有覆盖它。请先移走或改名该文件，再重新提交并批准`
}

/**
 * 把一版内容发布到目标路径。
 *
 * 先写带 revision 的临时文件，读回来重算摘要，对得上才 rename。
 * 读回来重算这一步不是多余：writeFile 返回成功只代表数据交给了系统，
 * 磁盘满、杀毒软件截断、路径被别的进程占着，都可能让落盘的内容和内存里的不一致。
 * 摘要对不上就绝不更名——宁可留一个临时文件让人来查，也不覆盖掉用户上一份日报。
 */
export async function publishRevisionFile(
  targetPath: string,
  content: string,
  expectedDigest: string,
  revision: number,
  guard?: PublishGuard,
): Promise<PublishOutcome> {
  if (guard) {
    const before = await existingDigest(targetPath)
    if (before.kind === 'error') {
      // 目标位置被一个目录占着是冲突；读不了（权限、占用）是磁盘错误。两种都不写。
      return before.code === 'EISDIR'
        ? { ok: false, reason: 'target_conflict', message: `目标路径 ${targetPath} 被一个文件夹占着，没有写入` }
        : { ok: false, reason: 'write_failed', message: `目标文件无法读取核对（${before.message}），没有写入` }
    }
    if (before.kind === 'file') {
      if (before.digest === expectedDigest) return { ok: true, path: targetPath, digest: expectedDigest, unchanged: true }
      if (!guard.knownDigests.includes(before.digest)) return { ok: false, reason: 'target_conflict', message: conflictMessage(targetPath) }
    }
  }
  const tempPath = tempPathFor(targetPath, revision)
  try {
    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(tempPath, content, 'utf8')
  } catch (error) {
    return { ok: false, reason: 'write_failed', message: describe(error) }
  }

  let written: string
  try {
    written = await readFile(tempPath, 'utf8')
  } catch (error) {
    return { ok: false, reason: 'write_failed', message: `临时文件写完就读不回来：${describe(error)}` }
  }
  const actual = sha256(written)
  if (actual !== expectedDigest) {
    return {
      ok: false,
      reason: 'digest_mismatch',
      message: `落盘内容和确认时的摘要不一致（期望 ${expectedDigest.slice(0, 12)}，实际 ${actual.slice(0, 12)}），已保留临时文件 ${tempPath}，未覆盖目标`,
    }
  }

  if (guard) {
    // 写临时文件这段时间里目标可能被别人写了：更名前再核一次，缩小覆盖他人文件的窗口。
    const again = await existingDigest(targetPath)
    if (again.kind !== 'missing' && !(again.kind === 'file' && (again.digest === expectedDigest || guard.knownDigests.includes(again.digest)))) {
      await rm(tempPath, { force: true }).catch(() => undefined)
      return { ok: false, reason: 'target_conflict', message: conflictMessage(targetPath) }
    }
  }

  try {
    await rename(tempPath, targetPath)
  } catch (error) {
    return { ok: false, reason: 'rename_failed', message: describe(error) }
  }
  return { ok: true, path: targetPath, digest: actual }
}

/** 恢复时核对目标文件：内容对得上就当这次发布其实成功了，不重复发一遍。 */
export async function reconcilePublishedFile(
  targetPath: string,
  expectedDigest: string,
): Promise<'matches' | 'missing' | 'differs'> {
  try {
    await stat(targetPath)
  } catch {
    return 'missing'
  }
  try {
    const content = await readFile(targetPath, 'utf8')
    return sha256(content) === expectedDigest ? 'matches' : 'differs'
  } catch {
    return 'missing'
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
