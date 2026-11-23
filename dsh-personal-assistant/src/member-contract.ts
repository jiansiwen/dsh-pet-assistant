import type { MemberConfig } from './team-domain.ts'

/**
 * 底座能力清单：每一项都是"一组工具 + 一条安全边界"。
 *
 * 子助理不是固定角色，而是**这份清单的任意子集**：
 * 给它 mail 它就能读邮箱，给它 computer 它就能看屏幕、点按钮，两个都给就能"读邮件然后去改系统"。
 *
 * `computer` 之所以单列一项而不是默认开放：它触碰的是本人正在用的这台机器，
 * 误操作代价比读邮件大得多。默认不给，谁需要谁开。
 */
export const MEMBER_CAPABILITIES = ['wecom', 'mail', 'meeting', 'document', 'activity', 'reminders', 'computer', 'platform'] as const
export type MemberCapability = typeof MEMBER_CAPABILITIES[number]
/** 与宿主工具层三态一致：每次询问（ask）/ 自动审批（allow）/ 完全访问（无限制）。 */
export const MEMBER_PERMISSION_MODES = ['ask', 'auto', 'full'] as const
export type MemberPermissionMode = typeof MEMBER_PERMISSION_MODES[number]
/**
 * 汇报方式。
 *
 * - `chief`（默认）：成员干完把结果交给总助理，由**总助理**对本人汇报；
 * - `self`：成员自己直接对本人汇报一次，总助理只留一份摘要、**不再重复念一遍**。
 *
 * 两种模式都要求成员在自己的会话里留完整记录、总助理那里落一份摘要 ——
 * **落两份是事实，念一遍是规则**。演讲、讲解这类要"人亲自开口"的活必须配 self：
 * 让总助理转述别人的演讲，形象和声音都对不上。
 */
export const MEMBER_REPORT_MODES = ['chief', 'self'] as const
export type MemberReportMode = typeof MEMBER_REPORT_MODES[number]

/** 成员的话由谁朗读：self=它自己用自己音色，chief=总助理代读（只出文字）。 */
export const MEMBER_SPEECH_BY = ['self', 'chief'] as const
export type MemberSpeechBy = typeof MEMBER_SPEECH_BY[number]

/** 成员类型：expert=现有 spawn 子代理；platform=外部平台智能体（OpenAI 兼容）；local-cli=本地 AI CLI 工具。 */
export const MEMBER_KINDS = ['expert', 'platform', 'local-cli'] as const
export type MemberKind = typeof MEMBER_KINDS[number]
/** 子助理汇报模式与成员汇报方式是同一组值：别名保留，两条链路各用各的名字不再分叉。 */
export const SUB_ASSISTANT_REPORT_MODES = MEMBER_REPORT_MODES
export type SubAssistantReportMode = MemberReportMode
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
  reportMode: MemberReportMode
  /** 语音朗读归属：自己读 / 总助理代读。 */
  speechBy: MemberSpeechBy
  /** 音色设计描述：存在扩展 JSON 里（不占表列），空表示跟随总助理。 */
  voiceDesign: string
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
  scheduleWorkspaceId?: string | null
  kind: MemberKind
  binding: SubAssistantBinding | null
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
export interface MemberSharedMemory {
  id: string
  topic: string
  text: string
  revision: number
  /** 当前是否已开放给所有子助理（只读投影）。 */
  shared: boolean
}
export interface MemberSnapshot {
  workspaces?: Array<{ id: string; title: string; path: string }>
  enabled: boolean
  members: MemberView[]
  requests: MemberQuotaRequest[]
  defaultModel: { provider: string; model: string } | null
  /** 总助理的全局已确认记忆 + 是否共享给子助理；界面据此渲染开关。 */
  sharedMemories?: MemberSharedMemory[]
  sharedMemoriesError?: boolean
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
  reportMode: MemberReportMode
  /** 语音朗读归属：自己读 / 总助理代读。 */
  speechBy: MemberSpeechBy
  persona: string
  /**
   * 这个成员说话用的音色标识（服务商侧的 voice id，或内置音色名）。
   *
   * 留空 = 用总助理的默认音色。它存在 `assistants.voice_profile` 列上，
   * 但改版前只有种子写过、编辑器改不了 —— 用户等于根本配不了。这一版把它接进草稿。
   */
  voiceProfile: string
  /**
   * 音色设计描述：按这位助理的性格生成的一段声音描述，可手改。
   *
   * 空字符串表示**跟随总助理**的音色。注意：目前播放链路只播主会话回复，
   * 成员自己开口的通道还没接上，所以这个字段现在属于"先存下来"，
   * 等交接编排把"成员说话"接上之后才真正决定听到的声音。
   */
  voiceDesign: string
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
  /** 仅本机成员：定时与邮件值守使用的宿主工作区，不由模型提供路径。 */
  scheduleWorkspaceId?: string | null
  /** 子助理两字段；缺省=expert/无绑定（normalize 补默认，旧调用方零改动）。 */
  kind?: MemberKind
  binding?: SubAssistantBinding | null
}
