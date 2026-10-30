export type AssistantSettingsSection = 'wecom' | 'reminders' | 'agent' | 'wecom/reconnect'
export type AssistantSettingsPage = Exclude<AssistantSettingsSection, 'wecom/reconnect'>

/** 与配置服务的写入上限保持一致，界面与 IPC 共用。 */
export const ASSISTANT_SETTINGS_LIMITS = {
  botId: 200, secret: 4096, name: 80, persona: 8000, provider: 128, model: 256,
  maxTokens: 32768, tokenBudget: 10_000_000,
} as const

export interface AssistantAgentSettings {
  name: string
  persona: string
  provider: string
  model: string
  maxTokens: number
  tokenBudget: number
}

/** 仅公开配置投影；密钥只写入，绝不回传。 */
export interface AssistantSettingsSnapshot {
  revision: number
  wecom: {
    enabled: boolean
    botId: string
    secretConfigured: boolean
    connected: boolean
    allowedUserIds: string[]
    deliverHere: string[]
  }
  reminder: { repeatEverySeconds: number }
  agent: AssistantAgentSettings
  defaultModel: { provider: string; model: string } | null
}

export interface AssistantSettingsResult {
  ok: boolean
  state?: AssistantSettingsSnapshot
  error?: string
  message?: string
}

export interface AssistantSettingsInputs {
  wecom: { expectedRevision: number; enabled: boolean; botId: string; secret?: string }
  reminders: { expectedRevision: number; repeatEverySeconds: number }
  agent: AssistantAgentSettings & { expectedRevision: number }
  'wecom/reconnect': { expectedRevision: number }
}

/** 分钟可带小数，但转换后必须是整秒；容忍二进制浮点尾差。 */
export function reminderMinutesToSeconds(value: string): number | null {
  if (!value.trim()) return null
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 10080) return null
  const seconds = minutes * 60
  const rounded = Math.round(seconds)
  return Math.abs(seconds - rounded) <= 1e-8 ? rounded : null
}
