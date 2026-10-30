import type { MemberConfig } from './team-domain.ts'

export const MEMBER_CAPABILITIES = ['wecom', 'mail', 'meeting', 'document', 'activity', 'reminders'] as const
export type MemberCapability = typeof MEMBER_CAPABILITIES[number]
/** 与宿主工具层三态一致：每次询问（ask）/ 自动审批（allow）/ 完全访问（无限制）。 */
export const MEMBER_PERMISSION_MODES = ['ask', 'auto', 'full'] as const
export type MemberPermissionMode = typeof MEMBER_PERMISSION_MODES[number]
export interface MemberProfile extends MemberConfig {
  description: string
  personality: string
  permissionMode: MemberPermissionMode
  provider: string
  model: string
  maxTokens: number
  capabilities: MemberCapability[]
  allowedTools: string[]
  dailyTokenLimit: number
  totalTokenLimit: number
  thresholdPercent: number
  timezone: string
  sessionId: string | null
}
export interface MemberQuotaView {
  day: string
  dailyUsed: number
  totalUsed: number
  dailyTokenLimit: number
  totalTokenLimit: number
  thresholdPercent: number
  unknown: boolean
  blocked: boolean
  revision: number
}
export interface MemberQuotaRequest {
  requestId: string
  assistantId: string
  reason: string
  state: 'pending' | 'approved' | 'rejected'
  createdAt: number
  quotaRevision: number
}
export interface MemberView {
  profile: MemberProfile
  quota: MemberQuotaView
  busy: boolean
}
export interface MemberSnapshot {
  enabled: boolean
  members: MemberView[]
  requests: MemberQuotaRequest[]
  defaultModel: { provider: string; model: string } | null
}
export interface MemberDraft {
  displayName: string
  description: string
  personality: string
  permissionMode: MemberPermissionMode
  persona: string
  skinId: string
  enabled: boolean
  provider: string
  model: string
  maxTokens: number
  capabilities: MemberCapability[]
  allowedTools: string[]
  dailyTokenLimit: number
  totalTokenLimit: number
  thresholdPercent: number
  timezone: string
}
