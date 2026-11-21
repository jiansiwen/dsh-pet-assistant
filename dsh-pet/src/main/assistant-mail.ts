import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'

/**
 * 邮件页的本地桥：邮箱配置读写 + 值守分析列表（只读）。
 *
 * 三个通道都走 `/companion/v1/*` 的 owner 凭据，渲染层拿不到令牌；
 * 发送方校验与 assistant-settings 同源 —— 只有当前舞台的本地页面能读写。
 * 授权码只写不读：保存时上桥，回包只有 hasPassword。
 */
export const ASSISTANT_MAIL_CHANNELS = {
  state: 'assistant-mail-state',
  save: 'assistant-mail-save',
  analyses: 'assistant-mail-analyses',
} as const

export interface AssistantMailView {
  address: string
  smtpHost: string
  smtpPort: number
  imapHost: string
  imapPort: number
  hasPassword: boolean
  watchEnabled: boolean
  watchIntervalSeconds: number
}

export interface MailSuggestionRow {
  uid: number | null
  kind: string
  title: string
  payload: string
  risk: string
  rationale: string
}

export interface MailAnalysisRow {
  analysisId: string
  memberId: string
  uids: number[]
  result: string
  suggestions: MailSuggestionRow[]
  createdAt: number
  notifiedAt: number | null
  silent?: boolean
}

export type AssistantMailResult =
  | { ok: true; mail: AssistantMailView | null; message?: string }
  | { ok: false; error: string; message: string }

export type AssistantMailAnalysesResult =
  | { ok: true; analyses: MailAnalysisRow[] }
  | { ok: false; error: string; message: string }

type MailFailure = { ok: false; error: string; message: string }

export interface AssistantMailInput {
  address: string
  smtpHost: string
  smtpPort: number
  imapHost: string
  imapPort: number
  /** 空/缺省 = 沿用已保存的授权码。 */
  password?: string
}

interface Options {
  getStageWindow(): BrowserWindow | null
  pagePath: string
  request(method: string, pathname: string, body: unknown, subject: 'owner'): Promise<{ status: number; body: unknown }>
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('数据形状无效')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('字段形状无效')
  return value
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('数值无效')
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('开关形状无效')
  return value
}

/** 从回包逐字段投影；不认识的字段一律不交给渲染层。 */
export function projectMailView(value: unknown): AssistantMailView | null {
  if (value === null || value === undefined) return null
  const input = record(value)
  return {
    address: text(input.address),
    smtpHost: text(input.smtpHost),
    smtpPort: integer(input.smtpPort),
    imapHost: text(input.imapHost),
    imapPort: integer(input.imapPort),
    hasPassword: boolean(input.hasPassword),
    watchEnabled: boolean(input.watchEnabled),
    watchIntervalSeconds: integer(input.watchIntervalSeconds, 1),
  }
}

export function projectAnalyses(value: unknown): MailAnalysisRow[] {
  const input = record(value)
  const rows = Array.isArray(input.analyses) ? input.analyses : []
  return rows.map(item => {
    const row = record(item)
    const suggestions = Array.isArray(row.suggestions) ? row.suggestions : []
    return {
      analysisId: text(row.analysisId),
      memberId: text(row.memberId),
      uids: Array.isArray(row.uids) ? row.uids.map(uid => integer(uid, 1)) : [],
      result: text(row.result),
      createdAt: integer(row.createdAt),
      notifiedAt: row.notifiedAt === null || row.notifiedAt === undefined ? null : integer(row.notifiedAt),
      ...(row.silent === true ? { silent: true } : {}),
      suggestions: suggestions.map(entry => {
        const suggestion = record(entry)
        return {
          uid: suggestion.uid === null || suggestion.uid === undefined ? null : integer(suggestion.uid, 1),
          kind: text(suggestion.kind),
          title: text(suggestion.title),
          payload: text(suggestion.payload),
          risk: text(suggestion.risk),
          rationale: text(suggestion.rationale),
        }
      }),
    }
  }).filter(row => row.analysisId !== '')
}

/** 服务端 4xx 的 message 是领域文案（"邮箱地址格式不对…"），可以直接给用户看。 */
function serverMessage(body: unknown): string {
  try {
    const payload = record(body)
    return typeof payload.message === 'string' && payload.message !== '' ? payload.message : ''
  } catch { return '' }
}

export function registerAssistantMail(options: Options): () => void {
  const pageURL = pathToFileURL(options.pagePath).href
  let disposed = false
  let saving = false
  const allowed = (event: IpcMainInvokeEvent): boolean => {
    try {
      const win = options.getStageWindow()
      return !disposed && !!win && !win.isDestroyed() && event.sender === win.webContents
        && event.senderFrame !== null && event.senderFrame === win.webContents.mainFrame
        && event.senderFrame === event.sender.mainFrame
        && event.senderFrame.url === pageURL && win.webContents.getURL() === pageURL
    } catch { return false }
  }
  const denied = (): MailFailure =>
    ({ ok: false, error: 'denied', message: '请求不是来自当前舞台的本地入口，未执行。' })

  /** 读写共用的结果翻译：连接失败、端口不对、服务离线，各自说清楚。 */
  const translate = (result: { status: number; body: unknown }, writing: boolean): MailFailure | null => {
    if (result.status >= 200 && result.status < 300) return null
    if (result.status === 409) return { ok: false, error: 'busy', message: '配置正在提交，请稍后刷新重试。' }
    if (result.status === 400 || result.status === 422) {
      return { ok: false, error: 'invalid_input', message: serverMessage(result.body) || '配置未通过校验，请核对输入。' }
    }
    return { ok: false, error: 'unavailable', message: writing
      ? '保存未确认，请刷新核对配置；不会自动重发。' : '邮件配置暂时读不到，请确认助理已连接后刷新。' }
  }

  ipcMain.handle(ASSISTANT_MAIL_CHANNELS.state, async (event): Promise<AssistantMailResult> => {
    if (!allowed(event)) return denied()
    let result: { status: number; body: unknown }
    try { result = await options.request('GET', '/companion/v1/settings/mail', undefined, 'owner') }
    catch { return { ok: false, error: 'unavailable', message: '连接中断，邮件配置暂时读不到；请确认助理已连接后刷新。' } }
    if (!allowed(event)) return denied()
    const failed = translate(result, false)
    if (failed) return failed
    try {
      const payload = record(result.body)
      if (payload.ok === false) return { ok: false, error: 'rejected', message: '读取未完成，请刷新后重试。' }
      return { ok: true, mail: projectMailView(payload.mail) }
    } catch { return { ok: false, error: 'invalid_response', message: '配置回执不完整，请刷新核对。' } }
  })

  ipcMain.handle(ASSISTANT_MAIL_CHANNELS.save, async (event, input: unknown): Promise<AssistantMailResult> => {
    if (!allowed(event)) return denied()
    if (saving) return { ok: false, error: 'busy', message: '配置正在提交，请勿重复操作。' }
    let body: AssistantMailInput
    try {
      const raw = record(input)
      body = {
        address: text(raw.address).trim(),
        smtpHost: text(raw.smtpHost).trim(),
        smtpPort: integer(raw.smtpPort, 1),
        imapHost: text(raw.imapHost).trim(),
        imapPort: integer(raw.imapPort, 1),
        ...(raw.password === undefined ? {} : { password: text(raw.password) }),
      }
      if (body.address.length > 320 || body.smtpHost.length > 255 || body.imapHost.length > 255
        || body.smtpPort > 65_535 || body.imapPort > 65_535 || (body.password ?? '').length > 4096) {
        return { ok: false, error: 'invalid_input', message: '配置格式或数值无效，请核对输入后重试。' }
      }
    } catch { return { ok: false, error: 'invalid_input', message: '配置格式或数值无效，请核对输入后重试。' } }
    saving = true
    try {
      let result: { status: number; body: unknown }
      try { result = await options.request('POST', '/companion/v1/settings/mail', body, 'owner') }
      catch { return { ok: false, error: 'unavailable', message: '连接中断，保存结果未知；请刷新核对，不会自动重发。' } }
      if (!allowed(event)) return denied()
      const failed = translate(result, true)
      if (failed) return failed
      try {
        const payload = record(result.body)
        if (payload.ok === false) return { ok: false, error: 'rejected', message: '保存未完成，请刷新核对后重试。' }
        return { ok: true, mail: projectMailView(payload.mail), message: '邮箱配置已保存。' }
      } catch { return { ok: false, error: 'invalid_response', message: '保存回执不完整，请刷新核对。' } }
    } finally { saving = false }
  })

  ipcMain.handle(ASSISTANT_MAIL_CHANNELS.analyses, async (event, limit?: unknown): Promise<AssistantMailAnalysesResult> => {
    if (!allowed(event)) return denied()
    const count = typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50 ? limit : 20
    let result: { status: number; body: unknown }
    try { result = await options.request('GET', `/companion/v1/mail/analyses?limit=${count}`, undefined, 'owner') }
    catch { return { ok: false, error: 'unavailable', message: '连接中断，值守结果暂时读不到；请确认助理已连接后刷新。' } }
    if (!allowed(event)) return denied()
    const failed = translate(result, false)
    if (failed) return failed
    try {
      const payload = record(result.body)
      return { ok: true, analyses: projectAnalyses(payload) }
    } catch { return { ok: false, error: 'invalid_response', message: '值守回执不完整，请刷新核对。' } }
  })

  return () => {
    disposed = true
    for (const channel of Object.values(ASSISTANT_MAIL_CHANNELS)) ipcMain.removeHandler(channel)
  }
}
