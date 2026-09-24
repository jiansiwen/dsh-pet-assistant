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
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { inTransaction, sha256, text, type Row } from './store.ts'
import type { MemoryActor } from './memory.ts'

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
  | { ok: true; path: string; digest: string }
  | { ok: false; reason: 'write_failed' | 'digest_mismatch' | 'rename_failed'; message: string }

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
): Promise<PublishOutcome> {
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
