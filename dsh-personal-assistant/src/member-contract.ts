import type { MemberConfig } from './team-domain.ts'

export const MEMBER_CAPABILITIES = ['wecom', 'mail', 'meeting', 'document', 'activity', 'reminders'] as const
export type MemberCapability = typeof MEMBER_CAPABILITIES[number]
/** 与宿主工具层三态一致：每次询问（ask）/ 自动审批（allow）/ 完全访问（无限制）。 */
export const MEMBER_PERMISSION_MODES = ['ask', 'auto', 'full'] as const
export type MemberPermissionMode = typeof MEMBER_PERMISSION_MODES[number]
/** 成员类型：expert=现有 spawn 子代理；platform=外部平台智能体（OpenAI 兼容）；local-cli=本地 AI CLI 工具。 */
export const MEMBER_KINDS = ['expert', 'platform', 'local-cli'] as const
export type MemberKind = typeof MEMBER_KINDS[number]
/** 汇报模式：chief=总助理汇总播报；self=子助理以自己的形象与音色直接播报。
 *  两种模式下分派回执都携带完整结果文本——总助理总会收到一份汇总。仅对 platform/local-cli 子助理生效。 */
export const SUB_ASSISTANT_REPORT_MODES = ['chief', 'self'] as const
export type SubAssistantReportMode = typeof SUB_ASSISTANT_REPORT_MODES[number]
/** 子助理外部绑定元数据；密钥绝不入此结构，单独加密存储（sub-assistant-secrets）。 */
export interface PlatformBinding {
  kind: 'platform'
  /** OpenAI 兼容端点（仅 https 或本机回环）；路径不以 /chat/completions 结尾时由适配层补全。 */
  endpoint: string
  model: string
  /** 平台智能体标识（X-Agent-Id 头 + 请求体 agentId 字段双发）；空串=不指定，此时 model 必填。 */
  agentId: string
  /** 指向加密密钥库中密钥条目的标识；空串=尚未配置密钥（分派时如实拒绝）。 */
  secretId: string
}
export interface LocalCliBinding {
  kind: 'local-cli'
  /** 可执行文件绝对路径或 PATH 上的命令名；spawn 一律 shell:false、参数数组化，启动时再做白名单复核。 */
  command: string
  args: readonly string[]
}
export type SubAssistantBinding = PlatformBinding | LocalCliBinding
/** normalize 之后的完整草稿：子助理三字段已定值，可直接并入 MemberProfile。 */
export type NormalizedMemberDraft = MemberDraft & Required<Pick<MemberDraft, 'kind' | 'binding' | 'reportMode'>>
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
  kind: MemberKind
  binding: SubAssistantBinding | null
  reportMode: SubAssistantReportMode
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
  /** 子助理三字段；缺省=expert/无绑定/总助理汇报（normalize 补默认，旧调用方零改动）。 */
  kind?: MemberKind
  binding?: SubAssistantBinding | null
  reportMode?: SubAssistantReportMode
}
