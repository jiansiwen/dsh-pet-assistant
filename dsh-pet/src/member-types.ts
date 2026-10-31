/** 宿主 member-contract.ts / memory.ts 的本地镜像，不跨包加载运行时代码。 */
export const MEMBER_CAPABILITIES = ['wecom', 'mail', 'meeting', 'document', 'activity', 'reminders'] as const
export type MemberCapability = typeof MEMBER_CAPABILITIES[number]
export const MEMBER_PERMISSION_MODES = ['ask', 'auto', 'full'] as const
export type MemberPermissionMode = typeof MEMBER_PERMISSION_MODES[number]
export const MEMBER_PERMISSION_LABELS: Record<MemberPermissionMode, { title: string; hint: string }> = {
  ask: { title: '每次询问', hint: '读取直接做；改文件、执行命令等操作每次弹窗征求你同意。' },
  auto: { title: '自动审批', hint: '操作不再逐次询问，由成员自己判断执行；邮件发送等高风险动作仍单独确认。' },
  full: { title: '完全访问', hint: '不再逐次询问，按宿主权限执行；仍不能修改成员权限或额度。' },
}
export const MEMBER_CAPABILITY_LABELS: Record<MemberCapability, string> = {
  wecom: '企业微信接收', mail: '邮件收发与分析', meeting: '会议记录', document: '文档讲解',
  activity: '读取已授权活动 / 日报', reminders: '创建提醒',
}
/** 仅普通观测工具，镜像宿主 gate.ts；不包含子代理控制、脚本和写入工具。 */
export const MEMBER_READ_TOOLS = ['read', 'read_image', 'glob', 'grep', 'web_fetch', 'web_search'] as const
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
export interface MemberProfile extends MemberDraft {
  assistantId: string
  roleId: 'tangseng' | 'wukong' | 'bajie' | 'shaseng' | 'bailongma' | 'custom'
  voiceProfile: string
  toolPolicy: { mode: 'read-only' | 'side-effect'; denyTools: readonly string[] }
  revision: number
  sessionId: string | null
}
export interface MemberQuotaView {
  day: string
  dailyUsed: number
  totalUsed: number
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
export interface MemberView { profile: MemberProfile; quota: MemberQuotaView; busy: boolean }
export interface ChannelInboundAttention {
  id: string; channel: string; accountTag: string; msgid: string; chatId: string; chatType: 'single' | 'group'; senderId: string
  state: 'pending' | 'processing' | 'replying' | 'completed' | 'unknown' | 'reviewed'
  processing: 'not-started' | 'running' | 'done' | 'unknown'
  reply: 'not-sent' | 'sending' | 'accepted' | 'unknown'
  conflict: boolean; busy: boolean; revision: number; receivedAt: number
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
export const MEMORY_KINDS = ['user_preference', 'project_fact', 'task_breakpoint', 'team_experience', 'role_expression', 'ephemeral_chat'] as const
export type MemoryKind = typeof MEMORY_KINDS[number]
export interface MemoryRecord {
  id: string
  kind: MemoryKind
  scope: { kind: 'global' | 'project' | 'team' | 'role' | 'session'; id: string }
  topic: string
  text: string
  sourceRefs: string[]
  status: 'candidate' | 'confirmed' | 'conflicting' | 'expired'
  sensitivity: 'normal' | 'sensitive'
  createdBy: string
  confirmedBy: string | null
  revision: number
  createdAt: number
  updatedAt: number
  expiresAt: number | null
  importBatch: string | null
}
export type QuotaResetScope = 'daily' | 'total' | 'both'
export interface QuotaChange { dailyTokenLimit?: number; totalTokenLimit?: number; reset?: QuotaResetScope }
export interface MemberCommandInputs {
  create: MemberDraft
  update: MemberDraft & { id: string; expectedRevision: number }
  mode: { enabled: boolean }
  delete: { id: string; expectedRevision: number }
  'reset-quota': { id: string; expectedQuotaRevision: number; scope: QuotaResetScope }
  'decide-request': { requestId: string; decision: 'approve' | 'reject'; expectedQuotaRevision: number; change?: QuotaChange }
  'ack-mail-notice': { analysisId: string; attemptId: string; expectedState: 'failed' | 'unknown' }
  'ack-mail-send': { intentId: string; expectedState: 'partial' | 'unknown' }
  'ack-channel-inbound': { id: string; expectedRevision: number }
  'memory-create': { id: string; kind: MemoryKind; topic: string; text: string }
  'memory-update': { id: string; memoryId: string; expectedRevision: number; text: string; topic: string }
  'memory-confirm': { id: string; memoryId: string; expectedRevision: number }
  'memory-delete-preview': { id: string; memoryId: string; expectedRevision: number }
  'memory-delete': { id: string; memoryId: string; expectedRevision: number; previewId: string }
}
export type MemberAction = keyof MemberCommandInputs
export interface MemoryDeletePreview { previewId: string; impact: unknown }
export interface MemberAssistDraft { draft: MemberDraft; notes: string }
export interface MemberEditorContext { memberId: string | null }
export type MemberData = { records: MemoryRecord[] } | MemoryDeletePreview | MemberAssistDraft
export type MemberResult<T = MemberData> = { ok: true; state?: MemberSnapshot; data?: T } | { ok: false; error: { code: string; message: string } }
export interface MemberApi {
  membersState(): Promise<MemberResult>
  memberMemories(id: string): Promise<MemberResult<{ records: MemoryRecord[] }>>
  memberCommand<A extends MemberAction>(action: A, input: MemberCommandInputs[A]): Promise<MemberResult>
}
