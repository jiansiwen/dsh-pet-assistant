/** 宿主 member-contract.ts / memory.ts 的本地镜像，不跨包加载运行时代码。 */
export const MEMBER_CAPABILITIES = ['wecom', 'mail', 'meeting', 'document', 'activity', 'reminders', 'computer', 'platform'] as const
export type MemberCapability = typeof MEMBER_CAPABILITIES[number]
export const MEMBER_PERMISSION_MODES = ['ask', 'auto', 'full'] as const
export type MemberPermissionMode = typeof MEMBER_PERMISSION_MODES[number]
export const MEMBER_PERMISSION_LABELS: Record<MemberPermissionMode, { title: string; hint: string }> = {
  ask: { title: '每次询问', hint: '读取直接做；改文件、执行命令等操作每次弹窗征求你同意。' },
  auto: { title: '自动审批', hint: '操作不再逐次询问，由成员自己判断执行；邮件发送等高风险动作仍单独确认。' },
  full: { title: '完全访问', hint: '不再逐次询问，按宿主权限执行；仍不能修改成员权限或额度。' },
}
export const MEMBER_REPORT_MODES = ['chief', 'self'] as const
export type MemberReportMode = typeof MEMBER_REPORT_MODES[number]
/** 成员的话由谁朗读：self=它自己读，chief=总助理代读（只出文字）。 */
export const MEMBER_SPEECH_BY = ['self', 'chief'] as const
export type MemberSpeechBy = typeof MEMBER_SPEECH_BY[number]
export const MEMBER_SPEECH_LABELS: Record<MemberSpeechBy, { title: string; hint: string }> = {
  self: { title: '它自己读', hint: '用这个成员自己的音色开口' },
  chief: { title: '总助理代读', hint: '它只出文字，由总助理的声音念' },
}
export const MEMBER_REPORT_LABELS: Record<MemberReportMode, { title: string; hint: string }> = {
  chief: { title: '由总助理汇报', hint: '成员干完把结果交给总助理，由总助理统一对你说。适合不需要本人出面的活。' },
  self: { title: '由它自己汇报', hint: '成员自己直接对你说一次，总助理只留摘要、不再重复念。演讲、讲解这类要本人在场的活选这个。' },
}
export const MEMBER_CAPABILITY_LABELS: Record<MemberCapability, string> = {
  wecom: '企业微信接收', mail: '邮件收发与分析', meeting: '会议记录', document: '文档讲解',
  activity: '读取已授权活动 / 日报', reminders: '创建提醒',
  /* 底座能力：看屏幕、点、输入。默认关闭——它碰的是本人正在用的这台机器。 */
  computer: '操作电脑与浏览器（每次动作都要你批准）',
  platform: '对接外部智能助理平台（查询/上传知识库，配置驱动）',
}
/** 仅普通观测工具，镜像宿主 gate.ts；不包含子代理控制、脚本和写入工具。 */
export const MEMBER_READ_TOOLS = ['read', 'read_image', 'glob', 'grep', 'web_fetch', 'web_search'] as const
/** 子助理类型（AI 智能体接入）：expert=本机专家子代理；platform=外部平台智能体；local-cli=本地 AI CLI 工具。 */
export const MEMBER_KINDS = ['expert', 'platform', 'local-cli'] as const
export type MemberKind = typeof MEMBER_KINDS[number]
export const MEMBER_KIND_LABELS: Record<MemberKind, { title: string; hint: string }> = {
  expert: { title: '本机专家', hint: '在本机运行的专家子代理，可按权限使用本地工具。' },
  platform: { title: '平台智能体', hint: '接入外部 AI 平台的智能体（OpenAI 兼容 API），需要端点、模型与密钥。' },
  'local-cli': { title: '本地 AI 工具', hint: '常驻本地命令行 AI 工具（如 Claude Code、Qoder），上下文由工具自持。' },
}
export type PlatformBinding = { kind: 'platform'; endpoint: string; model: string; secretId: string }
export type LocalCliBinding = { kind: 'local-cli'; command: string; args: string[] }
export type SubAssistantBinding = PlatformBinding | LocalCliBinding
/** 汇报模式：chief=总助理汇总播报；self=子助理直接以其形象与音色播报（两种模式总助理都收到结果文本）。 */
export const SUB_ASSISTANT_REPORT_MODES = ['chief', 'self'] as const
export type SubAssistantReportMode = typeof SUB_ASSISTANT_REPORT_MODES[number]
export const SUB_ASSISTANT_REPORT_LABELS: Record<SubAssistantReportMode, string> = {
  chief: '总助理汇总播报', self: '子助理直接播报',
}
export interface MemberDraft {
  displayName: string
  description: string
  personality: string
  permissionMode: MemberPermissionMode
  /** 汇报方式：chief=总助理汇总（默认），self=成员自己直接汇报一次。 */
  reportMode: MemberReportMode
  /** 语音朗读归属。 */
  speechBy: MemberSpeechBy
  persona: string
  /** 音色标识（服务商 voice id 或内置音色名）；留空用总助理默认音色。 */
  voiceProfile: string
  /** 音色设计描述（按性格生成，可手改）；空表示跟随总助理。 */
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
  kind?: MemberKind
  binding?: SubAssistantBinding | null
  /** 平台密钥只写不读：仅在保存时经桥送插件加密存储，快照与回显永不携带。 */
  apiKey?: string
}
export interface MemberProfile extends MemberDraft {
  assistantId: string
  roleId: 'tangseng' | 'wukong' | 'bajie' | 'shaseng' | 'bailongma' | 'custom'
  toolPolicy: { mode: 'read-only' | 'side-effect'; denyTools: readonly string[] }
  revision: number
  sessionId: string | null
  kind: MemberKind
  reportMode: SubAssistantReportMode
  binding: SubAssistantBinding | null
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
export interface MemberSharedMemory {
  id: string
  topic: string
  text: string
  revision: number
  /** 是否已开放给所有子助理（只读投影，不是复制）。 */
  shared: boolean
}
export interface MemberSnapshot {
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
  /** purgeMemory=true 表示连它的独立记忆一起删；不传只删成员。 */
  delete: { id: string; expectedRevision: number; purgeMemory?: boolean }
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
  /** 记忆共享：不属于任何成员，所以不带 id。 */
  'share-memory': { memoryId: string; shared: boolean }
}
export type MemberAction = keyof MemberCommandInputs
export interface MemoryDeletePreview { previewId: string; impact: unknown }
export interface MemberAssistDraft { draft: MemberDraft; notes: string }
export interface MemberEditorContext { memberId: string | null; skins?: Array<{ id: string; name: string }> }
export type MemberData = { records: MemoryRecord[] } | MemoryDeletePreview | MemberAssistDraft
export type MemberResult<T = MemberData> = { ok: true; state?: MemberSnapshot; data?: T } | { ok: false; error: { code: string; message: string } }
export interface MemberApi {
  membersState(): Promise<MemberResult>
  memberMemories(id: string): Promise<MemberResult<{ records: MemoryRecord[] }>>
  memberCommand<A extends MemberAction>(action: A, input: MemberCommandInputs[A]): Promise<MemberResult>
}
