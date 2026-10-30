import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import nodemailer from 'nodemailer'
import type { SessionBridge } from './bridge.ts'

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

export function mailDir(home: string): string {
  return path.join(home, 'personal-assistant')
}

export function readMailConfig(home: string): MailConfig | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(mailDir(home), MAIL_FILE), 'utf8')) as Partial<MailConfig>
    if (typeof raw.host !== 'string' || !raw.host || typeof raw.user !== 'string' || !EMAIL.test(raw.user)) return null
    if (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) return null
    return {
      host: raw.host,
      port: raw.port,
      secure: raw.secure !== false,
      user: raw.user,
      from: typeof raw.from === 'string' && EMAIL.test(raw.from) ? raw.from : raw.user,
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

export function normalizeDraft(input: { to?: unknown; subject?: unknown; text?: unknown }): MailDraft {
  const recipients = (Array.isArray(input.to) ? input.to : typeof input.to === 'string' ? input.to.split(/[,;，；]/) : [])
    .map(value => String(value).trim()).filter(Boolean)
  if (recipients.length === 0) throw new Error('收件人不能为空')
  if (recipients.length > 20) throw new Error('一次最多发送给 20 个收件人')
  for (const address of recipients) if (!EMAIL.test(address)) throw new Error(`收件人格式不正确：${address.slice(0, 80)}`)
  const subject = String(input.subject ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (!subject || subject.length > MAX_SUBJECT) throw new Error(`主题不能为空且不超过 ${MAX_SUBJECT} 字`)
  const text = String(input.text ?? '').trim()
  if (!text || text.length > MAX_BODY) throw new Error(`正文不能为空且不超过 ${MAX_BODY} 字`)
  return { to: recipients, subject, text }
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

export function registerMailTools(host: MailToolHost, deps: { home: string; bridge: SessionBridge; log(message: string): void }): () => void {
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
      const snapshot = { from: config.from, host: config.host, ...draft }
      try {
        const proposal = deps.bridge.submitAssistant({
          subject: 'mail',
          tool: 'personal_assistant_send_mail',
          summary: `向 ${draft.to.join('、')} 发送邮件「${draft.subject}」；需要本人在审批窗口核对完整正文`,
          target: `邮箱 ${config.from} → ${draft.to.join('、')}`,
          risk: 'high',
          snapshot,
          validate: () => JSON.stringify(readMailConfig(deps.home)) === JSON.stringify(config),
          execute: async () => {
            const secret = await decryptSecret(deps.home)
            const sent = await sendMail(config, secret, draft)
            deps.log(`mail：已提交到 ${config.host}（messageId=${sent.messageId}）`)
            return sent
          },
        })
        return JSON.stringify({ ok: true, pending: true, proposalId: proposal.proposalId,
          message: '已在桌面审批窗口生成待确认邮件；批准后才会发送。批准前不要声称已发送。' })
      } catch (error) {
        return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
}
