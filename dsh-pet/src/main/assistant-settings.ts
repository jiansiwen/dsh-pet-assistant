import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'
import { ASSISTANT_SETTINGS_LIMITS as LIMITS, type AssistantAgentSettings, type AssistantSettingsInputs, type AssistantSettingsResult, type AssistantSettingsSection, type AssistantSettingsSnapshot } from '../assistant-settings-types.ts'

export const ASSISTANT_SETTINGS_CHANNELS = { state: 'assistant-settings-state', save: 'assistant-settings-save' } as const
interface Options {
  getStageWindow(): BrowserWindow | null
  pagePath: string
  request(method: string, pathname: string, body: unknown, subject: 'owner'): Promise<{ status: number; body: unknown }>
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置数据无效')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('配置文字无效')
  return value
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('配置数值无效')
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('配置开关无效')
  return value
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('配置列表无效')
  return value.map(text)
}
function agent(value: unknown): AssistantAgentSettings {
  const input = record(value)
  return {
    name: text(input.name), persona: text(input.persona), provider: text(input.provider), model: text(input.model),
    maxTokens: integer(input.maxTokens, 1), tokenBudget: integer(input.tokenBudget),
  }
}

/** 从服务回包逐字段投影，忽略额外字段，尤其不能回传密钥或凭据。 */
export function projectAssistantSettings(value: unknown): AssistantSettingsSnapshot {
  const input = record(value)
  const wecom = record(input.wecom)
  const reminder = record(input.reminder)
  const defaultModel = input.defaultModel === null ? null : record(input.defaultModel)
  return {
    revision: integer(input.revision),
    wecom: {
      enabled: boolean(wecom.enabled), botId: text(wecom.botId), secretConfigured: boolean(wecom.secretConfigured),
      connected: boolean(wecom.connected), allowedUserIds: strings(wecom.allowedUserIds), deliverHere: strings(wecom.deliverHere),
    },
    reminder: { repeatEverySeconds: integer(reminder.repeatEverySeconds, 1) },
    agent: agent(input.agent),
    defaultModel: defaultModel === null ? null : { provider: text(defaultModel.provider), model: text(defaultModel.model) },
  }
}

function parseInput(section: AssistantSettingsSection, value: unknown): AssistantSettingsInputs[AssistantSettingsSection] {
  const input = record(value)
  const fields: Record<AssistantSettingsSection, readonly string[]> = {
    wecom: ['expectedRevision', 'enabled', 'botId', 'secret'],
    reminders: ['expectedRevision', 'repeatEverySeconds'],
    agent: ['expectedRevision', 'name', 'persona', 'provider', 'model', 'maxTokens', 'tokenBudget'],
    'wecom/reconnect': ['expectedRevision'],
  }
  if (Object.keys(input).some(key => !fields[section].includes(key))) throw new Error('不支持这个配置字段')
  const expectedRevision = integer(input.expectedRevision)
  switch (section) {
    case 'wecom': {
      const secret = input.secret === undefined ? '' : text(input.secret)
      const botId = text(input.botId).trim()
      const enabled = boolean(input.enabled)
      if (botId.length > LIMITS.botId || secret.length > LIMITS.secret || ((enabled || secret.trim()) && !botId)) throw new Error('机器人配置无效')
      return { expectedRevision, enabled, botId, ...(secret.trim() ? { secret } : {}) }
    }
    case 'reminders': {
      const repeatEverySeconds = integer(input.repeatEverySeconds, 60)
      if (repeatEverySeconds > 604800) throw new Error('提醒间隔超过范围')
      return { expectedRevision, repeatEverySeconds }
    }
    case 'agent': {
      const next = agent(input)
      if (!next.name.trim() || !!next.provider.trim() !== !!next.model.trim()
        || next.maxTokens > LIMITS.maxTokens || next.tokenBudget > LIMITS.tokenBudget
        || (['name', 'persona', 'provider', 'model'] as const).some(key => next[key].length > LIMITS[key])) throw new Error('智能体配置无效')
      return { expectedRevision, ...next }
    }
    case 'wecom/reconnect': return { expectedRevision }
  }
}

const failure = (error: string, message: string): AssistantSettingsResult => ({ ok: false, error, message })

/** 仅当前舞台的真实本地入口可以读写；请求路径和凭据身份完全由主进程固定。 */
export function registerAssistantSettings(options: Options): () => void {
  const pageURL = pathToFileURL(options.pagePath).href
  let saving = false
  let disposed = false
  const allowed = (event: IpcMainInvokeEvent): boolean => {
    try {
      const win = options.getStageWindow()
      return !disposed && !!win && !win.isDestroyed() && event.sender === win.webContents
        && event.senderFrame !== null && event.senderFrame === win.webContents.mainFrame
        && event.senderFrame === event.sender.mainFrame
        && event.senderFrame.url === pageURL && win.webContents.getURL() === pageURL
    } catch { return false }
  }
  const denied = () => failure('denied', '请求不是来自当前舞台的本地入口，未执行。')
  const call = async (event: IpcMainInvokeEvent, section?: AssistantSettingsSection, input?: unknown): Promise<AssistantSettingsResult> => {
    let result: { status: number; body: unknown }
    try {
      result = await options.request(section ? 'POST' : 'GET', `/companion/v1/settings${section ? `/${section}` : ''}`, input, 'owner')
    } catch {
      return failure('unavailable', section ? '连接中断，保存结果未知；请刷新核对，不会自动重发。' : '读取失败，请确认助理已连接后刷新。')
    }
    // 等待期间主窗口可能被替换或导航，不把配置交给新的页面。
    if (!allowed(event)) return denied()
    if (result.status === 409) return failure('conflict', '配置已被其他操作更新，请刷新后重新核对并保存。')
    if (result.status === 400 || result.status === 422) return failure('invalid_input', '保存未完成，请核对输入范围；更换机器人编号时需要同时填写新密钥。')
    if (result.status < 200 || result.status >= 300) {
      return failure('unavailable', section ? '保存未确认，请刷新核对配置与连接状态；不会自动重发。' : '读取失败，请确认配置服务和本机凭据可用后刷新。')
    }
    try {
      const body = record(result.body)
      if (body.ok === false) return failure('rejected', '操作未完成，请刷新配置后重试。')
      return { ok: true, state: projectAssistantSettings(body),
        ...((section === 'wecom' || section === 'wecom/reconnect') && body.message === '设置已保存，但企业微信重连失败，请检查连接状态后重试。'
          ? { message: '设置已保存，但渠道重连未完成；请稍后重新连接并刷新状态。' } : {}) }
    } catch {
      return failure('invalid_response', '配置回执不完整，请刷新核对；不会自动重发。')
    }
  }
  ipcMain.handle(ASSISTANT_SETTINGS_CHANNELS.state, async event => allowed(event) ? call(event) : denied())
  ipcMain.handle(ASSISTANT_SETTINGS_CHANNELS.save, async (event, section: unknown, input: unknown): Promise<AssistantSettingsResult> => {
    if (!allowed(event)) return denied()
    if (section !== 'wecom' && section !== 'reminders' && section !== 'agent' && section !== 'wecom/reconnect') {
      return failure('invalid_section', '不支持这个配置分类，未执行。')
    }
    if (saving) return failure('busy', '配置正在提交，请勿重复操作。')
    let parsed: AssistantSettingsInputs[AssistantSettingsSection]
    try { parsed = parseInput(section, input) } catch {
      // 不返回异常内容，避免输入、密钥或服务响应被拼入错误。
      return failure('invalid_input', '配置格式或数值无效，请核对输入后重试。')
    }
    saving = true
    try { return await call(event, section, parsed) } finally { saving = false }
  })
  return () => {
    disposed = true
    for (const channel of Object.values(ASSISTANT_SETTINGS_CHANNELS)) ipcMain.removeHandler(channel)
  }
}
