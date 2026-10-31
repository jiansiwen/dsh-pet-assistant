import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import nodemailer from 'nodemailer'
import { BeforeEffectError } from './assistant-approval.ts'
import type { SessionBridge } from './bridge.ts'
import type { TeamStore } from './team-domain.ts'

export interface MailConfig {
  host: string
  port: number
  secure: boolean
  user: string
  from: string
}

const MAIL_FILE = 'mail.json'
const SECRET_FILE = 'mail.secret'
const MAX_SUBJECT = 200
const MAX_BODY = 50_000
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/
const UNSAFE_HEADER = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u
const validEmail = (value: string): boolean => value.length <= 320 && EMAIL.test(value) && !UNSAFE_HEADER.test(value)

export function mailDir(home: string): string {
  return path.join(home, 'personal-assistant')
}

export function readMailConfig(home: string): MailConfig | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(mailDir(home), MAIL_FILE), 'utf8')) as Partial<MailConfig>
    if (typeof raw.host !== 'string' || !raw.host || typeof raw.user !== 'string' || !validEmail(raw.user)) return null
    if (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) return null
    return {
      host: raw.host,
      port: raw.port,
      secure: raw.secure !== false,
      user: raw.user,
      from: typeof raw.from === 'string' && validEmail(raw.from) ? raw.from : raw.user,
    }
  } catch {
    return null
  }
}

/** 解一个当前 Windows 用户 DPAPI 加密的密文文件；明文只留在本进程内存。 */
export function decryptDpapiFile(file: string): Promise<string> {
  if (!existsSync(file)) return Promise.reject(new Error('加密凭据文件不存在'))
  const cipher = readFileSync(file, 'utf8').trim()
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd());' +
      ' $p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,"CurrentUser");' +
      ' [Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))'], { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.stderr.on('data', chunk => { err += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0 && out.length > 0) resolve(out)
      else reject(new Error(`凭据解密失败${err.trim() ? `：${err.trim().slice(0, 200)}` : ''}`))
    })
    child.stdin.end(cipher)
  })
}

export function decryptSecret(home: string): Promise<string> {
  const file = path.join(mailDir(home), SECRET_FILE)
  if (!existsSync(file)) return Promise.reject(new Error('邮箱口令还没有配置，先运行 scripts/setup-mail.mjs'))
  return decryptDpapiFile(file)
}

export interface MailDraft {
  to: string[]
  subject: string
  text: string
}

/** 账户和草稿只保存摘要，不把邮箱口令或正文写入发送账本。 */
export function mailSendAccountKey(config: MailConfig): string {
  return createHash('sha256').update(JSON.stringify([config.host.trim().toLowerCase(), config.port, config.secure, comparableMailbox(config.user)])).digest('hex')
}
export function mailSendDigest(config: MailConfig, draft: MailDraft): string {
  return createHash('sha256').update(JSON.stringify([mailSendAccountKey(config), comparableMailbox(config.from), draft.to.map(comparableMailbox).sort(), draft.subject, draft.text])).digest('hex')
}
function comparableMailbox(address: string): string {
  const at = address.lastIndexOf('@')
  return at < 0 ? address : `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`
}

export function normalizeDraft(input: { to?: unknown; subject?: unknown; text?: unknown }): MailDraft {
  const recipients = (Array.isArray(input.to) ? input.to : typeof input.to === 'string' ? input.to.split(/[,;，；]/) : [])
    .map(value => String(value).trim()).filter(Boolean)
  if (recipients.length === 0) throw new Error('收件人不能为空')
  if (recipients.length > 20) throw new Error('一次最多发送给 20 个收件人')
  for (const address of recipients) if (!validEmail(address)) throw new Error(`收件人格式不正确：${address.slice(0, 80)}`)
  const subject = String(input.subject ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (!subject || subject.length > MAX_SUBJECT || UNSAFE_HEADER.test(subject)) throw new Error(`主题不能为空、不含控制字符且不超过 ${MAX_SUBJECT} 字`)
  const text = String(input.text ?? '').trim()
  if (!text || text.length > MAX_BODY) throw new Error(`正文不能为空且不超过 ${MAX_BODY} 字`)
  return { to: recipients, subject, text }
}

/** 纪要正文必须逐字取自文件；只校验边界，不裁掉末尾换行。 */
export function normalizeMeetingDraft(input: { to?: unknown; subject?: unknown; text?: unknown }): MailDraft {
  const headers = normalizeDraft({ to: input.to, subject: input.subject, text: '待核验的纪要' })
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > MAX_BODY) {
    throw new Error(`纪要正文不能为空且不超过 ${MAX_BODY} 字`)
  }
  return { ...headers, text: input.text }
}

export async function sendMail(config: MailConfig, secret: string, draft: MailDraft): Promise<{ messageId: string; accepted: string[]; rejected: string[] }> {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: secret },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  })
  try {
    const info = await transport.sendMail({ from: config.from, to: draft.to.join(', '), subject: draft.subject, text: draft.text })
    return { messageId: String(info.messageId ?? ''), accepted: (info.accepted ?? []).map(String), rejected: (info.rejected ?? []).map(String) }
  } finally {
    transport.close()
  }
}

interface MailToolHost {
  tools: { register(definition: unknown): () => void }
}

export interface MailToolDeps {
  home: string
  bridge: SessionBridge
  store: TeamStore
  epoch: string
  log(message: string): void
  readSecret?(): Promise<string>
  send?: typeof sendMail
  now?: () => number
}

export interface MailSendExtension {
  tool: string
  summary: string
  snapshot: Record<string, unknown>
  validate?(): boolean
  beforeSend?(): Promise<void>
  prepare?(intentId: string, proposalId: string, at: number): void
  accepted?(intentId: string, acceptedAt: number): unknown
}

/** 复用同一审批和发送账本；可选扩展只能在批准后、SMTP 之前复核和登记。 */
export async function proposeMail(deps: MailToolDeps, config: MailConfig, draft: MailDraft, extension?: MailSendExtension): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now
  const accountKey = mailSendAccountKey(config)
  const digest = mailSendDigest(config, draft)
  deps.store.recoverMailSends(deps.epoch, now() - 120_000, now())
  if (deps.store.unresolvedMailSend(accountKey, digest)) {
    return { ok: false, error: '相同邮件上次发送结果未知或部分接受，请先在团队页核查，不自动重发。' }
  }
  const intentId = randomUUID()
  const warning = deps.store.reviewedMailSend(accountKey, digest)
    ? '相同内容曾有结果未知或部分接受的发送；再次发送可能重复，必须由本人重新核对。' : undefined
  const meetingAttention = !extension && deps.store.hasMeetingMailAttention(accountKey)
  const meetingReviewed = !extension && deps.store.hasMeetingMailAttention(accountKey, true)
  const meetingWarning = meetingAttention ? '该账户的会议纪要发送存在未核查结果；若本邮件涉及同一内容，可能重复，请先核查。'
    : meetingReviewed ? '该账户有经核查的未知或部分会议邮件；若本邮件涉及同一内容，可能重复，请重新核对。' : undefined
  const scopeValid = (): boolean => (extension?.validate?.() ?? true) && (!!extension
    || (deps.store.hasMeetingMailAttention(accountKey) === meetingAttention && deps.store.hasMeetingMailAttention(accountKey, true) === meetingReviewed))
  const snapshot = { ...extension?.snapshot, from: config.from, host: config.host, ...draft, intentId,
    ledgerNotice: '本机保存收件人、主题和发送回执，不持久保存正文。', ...(warning ? { warning } : {}),
    ...(meetingWarning ? { meetingWarning } : {}) }
  try {
    let proposalId = ''
    const proposal = deps.bridge.submitAssistant({
      subject: 'mail',
      tool: extension?.tool ?? 'personal_assistant_send_mail',
      summary: extension?.summary ?? `向 ${draft.to.join('、')} 发送邮件「${draft.subject}」；需要本人在审批窗口核对完整正文`,
      target: `邮箱 ${config.from} → ${draft.to.join('、')}`,
      risk: 'high',
      snapshot,
      validate: () => JSON.stringify(readMailConfig(deps.home)) === JSON.stringify(config)
        && deps.store.unresolvedMailSend(accountKey, digest) === null && scopeValid(),
      execute: async () => {
        let secret: string
        try { secret = await (deps.readSecret?.() ?? decryptSecret(deps.home)) }
        catch { throw new BeforeEffectError('邮箱凭据不可用，未发送；请修复配置后重新审批') }
        if (JSON.stringify(readMailConfig(deps.home)) !== JSON.stringify(config)) throw new BeforeEffectError('邮箱配置已变化，未发送')
        if (extension?.beforeSend) {
          try { await extension.beforeSend() }
          catch (error) { throw new BeforeEffectError(`会议产物核验失败，未发送：${error instanceof Error ? error.message : String(error)}`) }
        }
        let valid = false
        try { valid = JSON.stringify(readMailConfig(deps.home)) === JSON.stringify(config) && scopeValid() } catch { /* 按无效范围拒绝 */ }
        if (!valid) {
          throw new BeforeEffectError('邮箱或提醒范围已变化，未发送，请重新审批')
        }
        let started: boolean
        try {
          started = deps.store.transaction(() => {
            const at = now()
            if (!scopeValid()) throw new Error('邮件关联状态已变化')
            const begun = deps.store.beginMailSend({ intentId, accountKey, digest, subject: draft.subject, recipients: draft.to, epoch: deps.epoch }, at)
            if (begun) extension?.prepare?.(intentId, proposalId, at)
            return begun
          })
        } catch { throw new BeforeEffectError('发送账本或后续提醒登记不可用，未发送；请检查本地数据后重试') }
        if (!started) throw new BeforeEffectError('相同邮件有未核查的发送结果，未再次发送')
        let sent: Awaited<ReturnType<typeof sendMail>>
        try { sent = await (deps.send ?? sendMail)(config, secret, draft) }
        catch {
          try { deps.store.finishMailSend(intentId, deps.epoch, 'unknown', {}, now()) } catch { /* 保留发送中，重启后按未知处理 */ }
          throw new Error('邮件发送结果未知，请先核对发件箱，不要自动重发')
        }
        if (!sent || !Array.isArray(sent.accepted) || !Array.isArray(sent.rejected)) {
          deps.store.finishMailSend(intentId, deps.epoch, 'unknown', {}, now())
          throw new Error('邮件服务回执格式不完整，请先核查，不要自动重发')
        }
        const expected = new Set(draft.to.map(comparableMailbox))
        const tooMany = sent.accepted.length > 20 || sent.rejected.length > 20
        const accepted = sent.accepted.slice(0, 20).map(address => String(address).slice(0, 320))
        const rejected = sent.rejected.slice(0, 20).map(address => String(address).slice(0, 320))
        const acceptedSet = new Set(accepted.map(comparableMailbox))
        const complete = !tooMany && rejected.length === 0 && acceptedSet.size === expected.size && [...expected].every(address => acceptedSet.has(address))
        const state = complete ? 'accepted' : accepted.length > 0 ? 'partial' : 'unknown'
        const acceptedAt = now()
        const messageId = String(sent.messageId ?? '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ').slice(0, 300)
        if (!deps.store.finishMailSend(intentId, deps.epoch, state, { messageId, accepted, rejected }, acceptedAt)) {
          throw new Error('邮件发送后的状态已变化，请人工核查，不要自动重发')
        }
        if (state !== 'accepted') throw new Error(state === 'partial' ? '邮件仅被部分收件人接受，请核查后处理，不要整封重发' : '没有完整的服务接受回执，请先核查，不要自动重发')
        deps.log(`mail：已提交到 ${config.host}（messageId=${messageId}）`)
        let followup: unknown
        if (extension?.accepted) {
          try { followup = extension.accepted(intentId, acceptedAt) }
          catch { followup = { state: 'pending', message: '邮件已获服务接受，但提醒尚未登记；请在任务页核查。' } }
        }
        return { messageId, accepted, rejected, intentId, acceptedAt, ...(followup === undefined ? {} : { followup }) }
      },
    })
    proposalId = proposal.proposalId
    return { ok: true, pending: true, proposalId, intentId,
      message: '已在桌面审批窗口生成待确认邮件；批准后才会发送。批准前不要声称已发送。' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerMailTools(host: MailToolHost, deps: MailToolDeps): () => void {
  const now = deps.now ?? Date.now
  deps.store.recoverMailSends(deps.epoch, now() - 120_000, now())
  const output = { schema: { type: 'string' } as const, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
  return host.tools.register(defineTool({
    name: 'personal_assistant_send_mail',
    description: '用用户配置的邮箱发送一封纯文本邮件。提交后会在桌面专用审批窗口展示完整收件人、主题和正文，只有本人批准后才真正发送；批准前不得声称已发送。不能发送附件，不能密送。',
    parameters: {
      to: { type: 'string', required: true, description: '收件人邮箱；多个用逗号分隔，最多20个' },
      subject: { type: 'string', required: true, description: '邮件主题' },
      text: { type: 'string', required: true, description: '纯文本正文' },
    },
    output,
    async execute(args: { to: string; subject: string; text: string }) {
      const config = readMailConfig(deps.home)
      if (!config) return JSON.stringify({ ok: false, error: '邮箱还没有配置，请先在本机完成邮箱设置' })
      let draft: MailDraft
      try { draft = normalizeDraft(args) } catch (error) {
        return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return JSON.stringify(await proposeMail(deps, config, draft))
    },
  }))
}
