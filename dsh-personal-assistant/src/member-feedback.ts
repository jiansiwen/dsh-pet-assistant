/** 成员汇报的企微回执：只关联实际会话，不保存外部消息正文。 */
import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

const REF = /汇报编号[：:\s]*([a-f0-9]{12})(?![a-f0-9])/giu
const EXPLICIT = /^\/(接续|新接续)\s+([a-f0-9]{12})(?:\s+([\s\S]+))?$/iu
const FEEDBACK = /^(?:这类|这种|刚才|这封|这次|这项|这个)|^(?:以后|今后|下次)(?:不用|不要|别|继续|改)/u
const NEW_TASK = /^(?:新任务[：:\s]|(?:这次|接下来|今天)?[，,\s]*(?:请)?帮我|创建(?:待办|提醒)|设置(?:任务|提醒))/u
export const MUTE_MAIL = /^(?:(?:这类|这种)(?:的)?(?:邮件)?(?:以后|今后|下次)?|(?:以后|今后|下次)(?:这类|这种)(?:的)?(?:邮件)?)(?:不用|不要|不必|别)(?:再)?(?:提醒(?:我)?|关注)[。！!\s]*$/u
const DAY = 86_400_000

export function mailTopicKey(from: string, subject: string): string | null {
  const sender = from.normalize('NFKC').trim().toLowerCase()
  const topic = subject.normalize('NFKC').replace(/^(?:(?:re|fw|fwd|回复|转发)\s*[:：]\s*)+/iu, '').trim().toLowerCase()
  return sender && topic ? createHash('sha256').update(JSON.stringify([sender, topic])).digest('hex') : null
}

export interface ReportOrigin {
  runId: string
  assistantId: string
  sessionId: string
  mailTopic?: string | null
  mailLabel?: string | null
}

export type FeedbackMatch = { kind: 'new' } | { kind: 'clarify'; message: string }
  | { kind: 'reply'; ref: string; report: ReportOrigin; text: string; fresh: boolean }
type Row = { ref: string; run_id: string; assistant_id: string; session_id: string; mail_topic: string | null; mail_label: string | null }

export class MemberFeedback {
  private readonly db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_report_links (
        ref TEXT PRIMARY KEY, account_key TEXT NOT NULL, chat_key TEXT NOT NULL,
        run_id TEXT NOT NULL, assistant_id TEXT NOT NULL, session_id TEXT NOT NULL,
        mail_topic TEXT, mail_label TEXT, created_at INTEGER NOT NULL,
        state TEXT NOT NULL, replied_at INTEGER,
        UNIQUE(account_key, chat_key, run_id)
      );
      CREATE INDEX IF NOT EXISTS member_report_chat ON member_report_links(account_key, chat_key, created_at);
      CREATE TABLE IF NOT EXISTS member_mail_mutes (
        assistant_id TEXT NOT NULL, topic TEXT NOT NULL, memory_id TEXT NOT NULL, memory_revision INTEGER NOT NULL,
        PRIMARY KEY(assistant_id, topic)
      );
    `)
  }

  async send(account: string, chat: string, report: ReportOrigin, text: string, send: (text: string) => Promise<boolean>, now = Date.now()): Promise<boolean> {
    if (!chat.startsWith('wecom:single:')) return false
    this.db.prepare('DELETE FROM member_report_links WHERE created_at < ?').run(now - 30 * DAY)
    const ref = randomBytes(6).toString('hex')
    const row = this.db.prepare(`INSERT OR IGNORE INTO member_report_links(ref, account_key, chat_key, run_id, assistant_id,
      session_id, mail_topic, mail_label, created_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending')`)
      .run(ref, account, chat, report.runId, report.assistantId, report.sessionId, report.mailTopic ?? null, report.mailLabel ?? null, now)
    if (Number(row.changes) !== 1) return false
    let result: 'accepted' | 'not-sent' | 'unknown' = 'unknown'
    try { result = await send(`${text}\n\n汇报编号：${ref}\n可引用本条回复，或发送「/接续 ${ref} 你的回复」。`) ? 'accepted' : 'not-sent' }
    finally { this.db.prepare('UPDATE member_report_links SET state = ? WHERE ref = ?').run(result, ref) }
    return result === 'accepted'
  }

  resolve(account: string, chat: string, text: string, quote?: string, now = Date.now()): FeedbackMatch {
    const value = text.trim()
    const explicit = EXPLICIT.exec(value)
    const ref = (explicit?.[2] ?? Array.from((quote ?? '').matchAll(REF)).at(-1)?.[1])?.toLowerCase()
    const command = /^\/(?:新)?接续/u.test(value)
    if (!ref && !command && (NEW_TASK.test(value) || !FEEDBACK.test(value))) return { kind: 'new' }
    if (!chat.startsWith('wecom:single:')) return { kind: 'clarify', message: '请在原已配对私聊中引用汇报后再回复。' }
    const body = explicit ? explicit[3]?.trim() : value
    if (!body) return { kind: 'clarify', message: '请在汇报编号后写下你的回复。' }
    const rows = ref ? [this.db.prepare(`SELECT * FROM member_report_links WHERE ref = ? AND account_key = ? AND chat_key = ?
      AND created_at >= ? AND state IN ('accepted', 'sending', 'unknown')`).get(ref, account, chat, now - 30 * DAY)].filter(Boolean)
      : command || quote ? []
      : this.db.prepare(`SELECT * FROM member_report_links WHERE account_key = ? AND chat_key = ? AND created_at >= ?
        AND state = 'accepted' AND replied_at IS NULL ORDER BY created_at DESC LIMIT 2`).all(account, chat, now - DAY)
    if (rows.length !== 1) return { kind: 'clarify', message: rows.length > 1
      ? '最近有多份未回应的汇报，请引用你指的那份，或用「/接续 汇报编号 回复」。'
      : '没能确认你指哪份汇报。请在原私聊引用汇报，或用「/接续 汇报编号 回复」。' }
    const row = rows[0] as unknown as Row
    return { kind: 'reply', ref: row.ref, text: body, fresh: explicit?.[1] === '新接续', report: { runId: row.run_id, assistantId: row.assistant_id,
      sessionId: row.session_id, mailTopic: row.mail_topic, mailLabel: row.mail_label } }
  }

  replied(ref: string, now = Date.now()): void {
    this.db.prepare('UPDATE member_report_links SET replied_at = ? WHERE ref = ?').run(now, ref)
  }

  mute(assistantId: string, topic: string, memoryId: string, revision: number): void {
    this.db.prepare(`INSERT INTO member_mail_mutes(assistant_id, topic, memory_id, memory_revision) VALUES (?, ?, ?, ?)
      ON CONFLICT(assistant_id, topic) DO UPDATE SET memory_id = excluded.memory_id, memory_revision = excluded.memory_revision`).run(assistantId, topic, memoryId, revision)
  }

  muteState(assistantId: string, topic: string): { id: string; revision: number } | null {
    const row = this.db.prepare('SELECT memory_id, memory_revision FROM member_mail_mutes WHERE assistant_id = ? AND topic = ?').get(assistantId, topic)
    return row ? { id: String(row.memory_id), revision: Number(row.memory_revision) } : null
  }
}
