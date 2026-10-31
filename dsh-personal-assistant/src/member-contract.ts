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
  /** 已登记、尚未结算的模型请求预留；与已用量一起参与阈值和停线判断。 */
  dailyReserved: number
  totalReserved: number
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
export interface ChannelInboundAttention {
  id: string
  channel: string
  accountTag: string
  msgid: string
  chatId: string
  chatType: 'single' | 'group'
  senderId: string
  state: 'pending' | 'processing' | 'replying' | 'completed' | 'unknown' | 'reviewed'
  processing: 'not-started' | 'running' | 'done' | 'unknown'
  reply: 'not-sent' | 'sending' | 'accepted' | 'unknown'
  conflict: boolean
  busy: boolean
  revision: number
  receivedAt: number
}
export interface MemberSnapshot {
  enabled: boolean
  members: MemberView[]
  requests: MemberQuotaRequest[]
  defaultModel: { provider: string; model: string } | null
  mailNoticeAttention?: Array<{ analysisId: string; memberId: string; attemptId: string; state: 'failed' | 'unknown'; preview: string }>
  mailNoticeAttentionError?: boolean
  mailSendAttention?: Array<{ intentId: string; subject: string; recipients: string[]; state: 'sending' | 'partial' | 'unknown';
    accepted: string[]; rejected: string[]; messageId: string | null }>
  mailSendAttentionError?: boolean
  channelInboundAttention?: ChannelInboundAttention[]
  channelInboundAttentionError?: boolean
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
