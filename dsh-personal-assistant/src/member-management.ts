import { z } from 'zod'
import type { MemberDirectory } from './member-directory.ts'
import type { MemberRuntime } from './member-runtime.ts'
import { documentSessionScope } from './member-runtime.ts'
import { MEMBER_CAPABILITIES, MEMBER_PERMISSION_MODES, MEMBER_REPORT_MODES, MEMBER_SPEECH_BY, type MemberDraft, type MemberSnapshot } from './member-contract.ts'
import type { MemberMemory } from './member-memory.ts'
import { reminderScheduleSchema, type CompanionHttpResult, type ReminderSchedule } from './companion-contract.ts'
import type { MemberScheduleRecord } from './team-domain.ts'

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const limit = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
/** 子助理绑定（桥上白名单形状；https/回环等深度校验在 member-directory.normalizeBinding）。 */
const binding = z.union([
  z.object({ kind: z.literal('platform'), endpoint: z.string().trim().min(1).max(2048),
    model: z.string().trim().min(1).max(256), secretId: z.string().max(100).default('') }).strict(),
  z.object({ kind: z.literal('local-cli'), command: z.string().trim().min(1).max(2048),
    args: z.array(z.string().min(1).max(1024)).max(32).default([]) }).strict(),
])
const draft = z.object({
  displayName: z.string().trim().min(1).max(80), description: z.string().trim().max(2000),
  personality: z.string().max(2000).default(''), permissionMode: z.enum(MEMBER_PERMISSION_MODES).default('ask'),
  reportMode: z.enum(MEMBER_REPORT_MODES).default('chief'),
  speechBy: z.enum(MEMBER_SPEECH_BY).default('self'),
  /** 音色标识：服务商 voice id 或内置音色名；留空用总助理默认音色。 */
  voiceProfile: z.string().trim().max(200).default(''),
  voiceDesign: z.string().trim().max(2000).default(''),
  persona: z.string().max(8000),
  skinId: z.string().min(1).max(100), enabled: z.boolean(), provider: z.string().trim().max(128), model: z.string().trim().max(256),
  maxTokens: z.number().int().min(1).max(32768), capabilities: z.array(z.enum(MEMBER_CAPABILITIES)).max(MEMBER_CAPABILITIES.length),
  allowedTools: z.array(z.string().min(1).max(100)).max(100), dailyTokenLimit: limit, totalTokenLimit: limit,
  thresholdPercent: z.number().min(1).max(100), timezone: z.string().min(1).max(100),
  kind: z.enum(['expert', 'platform', 'local-cli']).default('expert'),
  binding: binding.nullish(),
  /** 平台密钥只在桥上一程（编辑器→插件），随即入加密存储，绝不回显、不入快照。 */
  apiKey: z.string().min(1).max(4096).optional(),
}).strict()
const reset = z.enum(['daily', 'total', 'both'])
const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']), expectedQuotaRevision: revision,
  change: z.object({ dailyTokenLimit: limit.optional(), totalTokenLimit: limit.optional(), reset: reset.optional() }).strict().optional() }).strict()
const assistSchema = z.object({ request: z.string().trim().min(1).max(4000), current: draft.optional(),
  model: z.object({ provider: z.string().trim().max(128), model: z.string().trim().max(256) }).optional() }).strict()
const noticeAcknowledgement = z.object({ attemptId: z.string().uuid(), expectedState: z.enum(['failed', 'unknown']) }).strict()
const sendAcknowledgement = z.object({ expectedState: z.enum(['partial', 'unknown']) }).strict()
const channelAcknowledgement = z.object({ expectedRevision: revision }).strict()
/** 文档讲解会话：预读（静默喂文档）。docKey 用文档路径，插件侧结合工作区算范围摘要。 */
const docPreloadSchema = z.object({ assistantId: z.string().trim().min(1).max(100),
  docKey: z.string().trim().min(1).max(2048), text: z.string().trim().min(1).max(60_000) }).strict()

/** 成员定时任务视图：计划本体 + 成员名（界面展示用）。 */
export type MemberScheduleView = MemberScheduleRecord & { assistantName: string }
const scheduleRecipient = z.string().trim().max(200).nullish()
const scheduleCreate = z.object({ action: z.literal('create'), assistantId: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(120), prompt: z.string().trim().min(1).max(8000), spec: reminderScheduleSchema,
  channel: z.enum(['desktop', 'wecom']).default('desktop'), recipientId: scheduleRecipient, enabled: z.boolean().default(true) }).strict()
const scheduleUpdate = z.object({ action: z.literal('update'), scheduleId: z.string().trim().min(1).max(100),
  expectedGeneration: revision, title: z.string().trim().min(1).max(120).optional(), prompt: z.string().trim().min(1).max(8000).optional(),
  spec: reminderScheduleSchema.optional(), channel: z.enum(['desktop', 'wecom']).optional(), recipientId: scheduleRecipient,
  enabled: z.boolean().optional() }).strict()
const scheduleDelete = z.object({ action: z.literal('delete'), scheduleId: z.string().trim().min(1).max(100) }).strict()
const scheduleEditSchema = z.discriminatedUnion('action', [scheduleCreate, scheduleUpdate, scheduleDelete])
const scheduleRunSchema = z.object({ scheduleId: z.string().trim().min(1).max(100) }).strict()
export type MemberScheduleEditInput = z.infer<typeof scheduleEditSchema>

export class MemberManagement {
  private readonly options: {
    directory: MemberDirectory; runtime: MemberRuntime; memories: MemberMemory
    enabled(): boolean; setMode(enabled: boolean): Promise<void>
    defaultModel(): { provider: string; model: string } | null
    changed(): void
    /** 成员/文档会话的工作区解析器；文档 scope 进键用，与成员会话同一口径。 */
    cwd?: () => string | undefined
    activeTasks?(id: string): number
    mailNoticeAttention?(): NonNullable<MemberSnapshot['mailNoticeAttention']>
    acknowledgeMailNotice?(analysisId: string, attemptId: string, expectedState: 'failed' | 'unknown'): boolean
    mailSendAttention?(): NonNullable<MemberSnapshot['mailSendAttention']>
    acknowledgeMailSend?(intentId: string, expectedState: 'partial' | 'unknown'): boolean
    channelInboundAttention?(): NonNullable<MemberSnapshot['channelInboundAttention']>
    acknowledgeChannelInbound?(id: string, expectedRevision: number): boolean
/**
     * 总助理的全局记忆 + 各自的"可共享"标记。
     *
     * 只暴露**已确认的全局记忆**：候选、项目范围、冲突态不进这个列表，
     * 因为界面上的开关一旦出现，用户就会以为"点了就能共享"，而它们本来就不该共享。
     */
    sharedMemories?(): NonNullable<MemberSnapshot['sharedMemories']>
    /** 切换某条记忆的可共享状态；不可共享时返回 null，由上层如实回一句。 */
    toggleShared?(memoryId: string, shared: boolean): { shared: boolean } | null
    /** 词库列表（设置页展示用）。 */
    glossary?(): Array<{ term: string; expansion: string; createdAt: number }>
    /** 增删术语；返回最新列表。 */
    glossaryEdit?(input: { term: string; expansion?: string; remove?: boolean }): Array<{ term: string; expansion: string; createdAt: number }>
    /** 最近产出过的文件指针（含已消失的，界面上要如实标出来）。 */
    artifacts?(): Array<{ path: string; label: string; kind: string; state: 'ok' | 'missing'; createdAt: number }>
    /** 技能列表（每个助理最新一版）；界面用来展示与操作。origin 标明人工/自动形成来源。 */
    skills?(): Array<{ id: string; assistantId: string; assistantName: string; name: string; body: string; version: number; status: string; createdAt: number; origin: string }>
    /** 技能操作：增/改/删/晋升/回滚/退役。返回最新列表。 */
    skillEdit?(input:
      | { action: 'promote' | 'rollback' | 'retire'; id: string; version?: number }
      | { action: 'create'; assistantId: string; name: string; body: string }
      | { action: 'edit'; id: string; body: string }
      | { action: 'delete'; id: string }
    ): Array<{ id: string; assistantId: string; assistantName: string; name: string; body: string; version: number; status: string; createdAt: number; origin: string }>
    /** 攒够可信成功、但还没成形的"同类工作"；只提示，不自动写正文。 */
    skillPending?(): Array<{ assistantId: string; assistantName: string; shape: string; count: number }>
    /** 有样本但都还没核实的"同类工作"：界面据此请本人确认。 */
    skillUnverified?(): Array<{ assistantId: string; assistantName: string; shape: string; count: number }>
    /** 本人确认后把该类的未核实样本转正；返回转正后的已核实条数。 */
    skillVerify?(assistantId: string, shape: string): number
    /** 记错的样本整类撤回。 */
    skillRetract?(assistantId: string, shape: string): number
    /**
     * 工作时间线：某段时间里解释过的工作事项。
     *
     * 只回 work_items（"我干了什么"），不回原始采样（"前台是什么窗口"）：
     * 原始片段是**线索**，没有解释过就不该当成事实摆在时间线上。
     */
    timeline?(from: number, to: number): Array<{ id: string; start: number; end: number; action: string; outcome: string; project: string | null; status: string }>
    /** 成员定时任务列表（到点自主跑成员真干活再推送）。 */
    schedules?(): MemberScheduleView[]
    /** 增/改/删定时任务；返回最新列表。nextRunAt 由装配侧按 spec 计算。 */
    scheduleEdit?(input: MemberScheduleEditInput): MemberScheduleView[]
    /** 立即跑一次（手动触发/测试）；返回执行结局与文本。 */
    scheduleRunNow?(scheduleId: string): Promise<{ state: string; text: string }>
    assistant?: {
      draft(input: { request: string; current?: MemberDraft }): Promise<{ draft: MemberDraft; notes: string }>
      studio?(input: { request: string }): Promise<{ name: string; prompt: string; actions: string[]; notes: string }>
      /** 按性格生成音色描述（交给语音合成模型做 voicedesign）。 */
      voice?(input: { name?: string; personality: string; model?: { provider: string; model: string } }): Promise<{ description: string; style: string }>
      /** 交接台词：总助把活交给某成员时四方各说一句（按各自性格生成）。 */
      handover?(input: { chiefName: string; chiefPersona: string; memberName: string; memberPersona: string; task: string }): Promise<Record<'chiefToUser' | 'chiefToMember' | 'memberToChief' | 'memberToUser' | 'memberFarewell', string>>
    }
    /** 子助理密钥存储（AI 智能体接入）：apiKey 在桥上换 secretId 后即销毁；删除成员时尽力清理密钥条目。 */
    secrets?: { save(input: { id?: string; apiKey: string }): { id: string }; remove?(id: string): void }
  }
  constructor(options: MemberManagement['options']) { this.options = options }
  snapshot(): MemberSnapshot {
    const { directory, runtime } = this.options
    let mailNoticeAttention: MemberSnapshot['mailNoticeAttention']
    let mailNoticeAttentionError = false
    let mailSendAttention: MemberSnapshot['mailSendAttention']
    let mailSendAttentionError = false
    let channelInboundAttention: MemberSnapshot['channelInboundAttention']
    let channelInboundAttentionError = false
    if (this.options.mailNoticeAttention) {
      try { mailNoticeAttention = this.options.mailNoticeAttention() }
      catch { mailNoticeAttentionError = true }
    }
    if (this.options.mailSendAttention) {
      try { mailSendAttention = this.options.mailSendAttention() }
      catch { mailSendAttentionError = true }
    }
    if (this.options.channelInboundAttention) {
      try { channelInboundAttention = this.options.channelInboundAttention() }
      catch { channelInboundAttentionError = true }
    }
    let sharedMemories: MemberSnapshot['sharedMemories']
    let sharedMemoriesError = false
    if (this.options.sharedMemories) {
      try { sharedMemories = this.options.sharedMemories() }
      catch { sharedMemoriesError = true }
    }
    return { enabled: this.options.enabled(), members: directory.list().map(profile => ({ profile, quota: directory.quota(profile.assistantId), busy: runtime.busy(profile.assistantId) })),
      requests: directory.requests(), defaultModel: this.options.defaultModel(),
      ...(mailNoticeAttention ? { mailNoticeAttention } : {}), ...(mailNoticeAttentionError ? { mailNoticeAttentionError } : {}),
      ...(mailSendAttention ? { mailSendAttention } : {}), ...(mailSendAttentionError ? { mailSendAttentionError } : {}),
      ...(channelInboundAttention ? { channelInboundAttention } : {}), ...(channelInboundAttentionError ? { channelInboundAttentionError } : {}),
      ...(sharedMemories ? { sharedMemories } : {}), ...(sharedMemoriesError ? { sharedMemoriesError } : {}) }
  }
  private idle(id: string): void {
    if (!this.options.directory.get(id)) throw new Error('智能体不存在')
    if (this.options.runtime.busy(id)) throw new Error('该智能体正在工作，请任务结束后修改')
  }
  /** 密钥只在桥上一程：apiKey 随即入加密存储换成 secretId，此后草稿与快照只携带标识。 */
  private settle(input: z.infer<typeof draft>): MemberDraft {
    const { apiKey, binding: bound, ...rest } = input
    if (apiKey !== undefined && input.kind !== 'platform') throw new Error('只有平台子助理需要配置 API 密钥')
    if (input.kind === 'expert') return { ...rest, binding: null }
    if (!bound) throw new Error('子助理必须配置外部绑定（平台端点或本地工具命令）')
    if (bound.kind === 'platform' && apiKey !== undefined) {
      if (!this.options.secrets) throw new Error('子助理密钥存储未装配，无法保存 API 密钥')
      bound.secretId = this.options.secrets.save({ id: bound.secretId !== '' ? bound.secretId : undefined, apiKey }).id
    }
    return { ...rest, binding: bound }
  }
  async request(method: string, pathname: string, raw: unknown): Promise<CompanionHttpResult> {
    const { directory, memories } = this.options
    try {
      if (method === 'GET' && pathname === '/companion/v1/members') return { status: 200, body: this.snapshot() }
      if (method === 'GET' && pathname === '/companion/v1/member-schedules') {
        return { status: 200, body: { schedules: this.options.schedules ? this.options.schedules() : [] } }
      }
      if (method === 'POST' && pathname === '/companion/v1/member-schedules') {
        if (!this.options.scheduleEdit) throw new Error('成员定时任务功能未装配')
        return { status: 200, body: { schedules: this.options.scheduleEdit(scheduleEditSchema.parse(raw)) } }
      }
      if (method === 'POST' && pathname === '/companion/v1/member-schedules/run') {
        if (!this.options.scheduleRunNow) throw new Error('成员定时任务功能未装配')
        const input = scheduleRunSchema.parse(raw)
        return { status: 200, body: await this.options.scheduleRunNow(input.scheduleId) }
      }
      if (method === 'POST' && pathname === '/companion/v1/members/doc-preload') {
        const input = docPreloadSchema.parse(raw)
        try {
          // 静默预读：走成员独立文档会话，不进团队任务、不推可见气泡；回复内容桌面丢弃。
          // scope 含工作区：同工作区同文档重开复用同一条会话，培训不丢。
          // 加超时：模型卡住时预读不能永久占着会话写句柄，否则后续打开/追问全被
          // "already owned by an active write handle" 挡住。
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(new Error('文档预读超时')), 120_000)
          try {
            await this.options.runtime.chat(input.assistantId, input.text, controller.signal, undefined, 'desktop', undefined, documentSessionScope(input.docKey, this.options.cwd?.()))
          } finally { clearTimeout(timer) }
          return { status: 200, body: { ok: true } }
        } catch (error) {
          return { status: 200, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
        }
      }
      // 文档关闭不再清会话绑定：scope 由 (成员, 工作区, 文档) 决定，重开复用，培训保留。
      if (method === 'POST' && pathname === '/companion/v1/members/assist') {
        if (!this.options.assistant) return { status: 503, body: { code: 'ASSIST_UNAVAILABLE', message: '成员配置助手尚未启用' } }
        const input = assistSchema.parse(raw)
        try {
          const output = await this.options.assistant.draft({ request: input.request, current: input.current as MemberDraft | undefined, ...(input.model ? { model: input.model } : {}) })
          return { status: 200, body: { draft: draft.parse(output.draft), notes: output.notes.slice(0, 2000) } }
        } catch (error) {
          return { status: 503, body: { code: 'ASSIST_UNAVAILABLE', message: error instanceof Error ? error.message : '成员配置助手暂时不可用' } }
        }
      }
      if (method === 'POST' && pathname === '/companion/v1/members/handover') {
        if (!this.options.assistant?.handover) return { status: 503, body: { code: 'ASSIST_UNAVAILABLE', message: '交接助手尚未启用' } }
        const input = z.object({
          chiefName: z.string().trim().max(80).default(''),
          chiefPersona: z.string().trim().max(4000).default(''),
          memberName: z.string().trim().max(80).default(''),
          memberPersona: z.string().trim().max(4000).default(''),
          task: z.string().trim().min(1).max(500),
        }).strict().parse(raw)
        try {
          return { status: 200, body: { lines: await this.options.assistant.handover(input) } }
        } catch (error) {
          return { status: 503, body: { code: 'ASSIST_UNAVAILABLE', message: error instanceof Error ? error.message : '交接助手暂时不可用' } }
        }
      }
      if (method === 'POST' && pathname === '/companion/v1/members/voice-design') {
        if (!this.options.assistant?.voice) return { status: 503, body: { code: 'ASSIST_UNAVAILABLE', message: '音色助手尚未启用' } }
        const input = z.object({
          name: z.string().trim().max(80).optional(),
          personality: z.string().trim().min(1).max(4000),
          model: z.object({ provider: z.string().trim().max(128), model: z.string().trim().max(256) }).optional(),
        }).strict().parse(raw)
        try {
          return { status: 200, body: await this.options.assistant.voice(input) }
        } catch (error) {
          return { status: 503, body: { code: 'ASSIST_UNAVAILABLE', message: error instanceof Error ? error.message : '音色助手暂时不可用' } }
        }
      }
      if (method === 'POST' && pathname === '/companion/v1/members/studio-assist') {
        if (!this.options.assistant?.studio) return { status: 503, body: { code: 'ASSIST_UNAVAILABLE', message: '形象配置助手尚未启用' } }
        const input = assistSchema.parse(raw)
        try {
          return { status: 200, body: await this.options.assistant.studio({ request: input.request }) }
        } catch (error) {
          return { status: 503, body: { code: 'ASSIST_UNAVAILABLE', message: error instanceof Error ? error.message : '形象配置助手暂时不可用' } }
        }
      }
      const notice = /^\/companion\/v1\/members\/mail-notices\/([a-f0-9-]{36})\/acknowledge$/iu.exec(pathname)
      if (method === 'POST' && notice) {
        const input = noticeAcknowledgement.parse(raw)
        if (!this.options.acknowledgeMailNotice?.(notice[1], input.attemptId, input.expectedState)) {
          throw new Error('邮件通知状态或账户已变化，请刷新后核对')
        }
        this.options.changed()
        return { status: 200, body: this.snapshot() }
      }
      const send = /^\/companion\/v1\/members\/mail-sends\/([a-f0-9-]{36})\/acknowledge$/iu.exec(pathname)
      if (method === 'POST' && send) {
        const input = sendAcknowledgement.parse(raw)
        if (!this.options.acknowledgeMailSend?.(send[1], input.expectedState)) {
          throw new Error('邮件发送状态或账户已变化，请刷新后核对')
        }
        this.options.changed()
        return { status: 200, body: this.snapshot() }
      }
      const channel = /^\/companion\/v1\/members\/channel-inbound\/([a-f0-9-]{36})\/acknowledge$/iu.exec(pathname)
      if (method === 'POST' && channel) {
        const input = channelAcknowledgement.parse(raw)
        if (!this.options.acknowledgeChannelInbound?.(channel[1], input.expectedRevision)) {
          throw new Error('渠道消息正在处理或状态已变化，请刷新后核对')
        }
        this.options.changed()
        return { status: 200, body: this.snapshot() }
      }
      const memory = /^\/companion\/v1\/members\/([A-Za-z0-9_-]+)\/memories(?:\/([A-Za-z0-9_-]+)\/(update|confirm|delete-preview|delete))?$/.exec(pathname)
      if (memory) {
        if (method === 'GET' && !memory[2]) return { status: 200, body: { records: memories.list(memory[1]) } }
        if (method !== 'POST') throw new Error('不支持的请求方式')
        this.idle(memory[1])
        const result = memories.request(memory[1], memory[3] ?? 'create', raw, memory[2])
        this.options.changed()
        return { status: 200, body: result }
      }
      /*
       * 记忆共享开关。
       *
       * 放在这里而不是新开一套接口：界面（成员管理页）已经通过 `/companion/v1/members`
       * 拿快照、用同一个 `changed()` 通知刷新，复用它就不用再往 preload 里加通道。
       * 语义仍是"总助理 → 子助理的只读投影"，不是把记忆复制给某个成员。
       */
      /*
       * 专属词库：查看、新增、删除。
       *
       * 只有三种操作，没有"编辑解释"——改一个小词的解释等于换了个词的意思，
       * 让用户删了重加更清楚，也避免"改完之后旧解释还在别处被引用"。
       */
      /*
       * 最近产物列表。
       *
       * 含 state='missing' 的条目：界面上要如实显示"这个文件已经不在了"，
       * 而不是悄悄从列表里消失 —— 用户看到过的东西突然不见，比看到"已不存在"更让人困惑。
       */
      /*
       * 工作时间线。
       *
       * 区间参数走查询串，缺省"今天"。区间最多 366 天（与工具一致），
       * 超了如实拒绝而不是悄悄截断 —— 截断会让用户以为那段时间什么都没干。
       */
      if (pathname.startsWith('/companion/v1/timeline')) {
        if (!this.options.timeline) return { status: 503, body: { code: 'TIMELINE_UNAVAILABLE', message: '时间线尚未启用' } }
        const query = pathname.includes('?') ? new URLSearchParams(pathname.slice(pathname.indexOf('?') + 1)) : new URLSearchParams()
        const rawFrom = query.get('from'), rawTo = query.get('to')
        const now = Date.now()
        const from = rawFrom === null ? new Date(now).setHours(0, 0, 0, 0) : Number(rawFrom)
        const to = rawTo === null ? now + 1 : Number(rawTo)
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
          return { status: 400, body: { code: 'INVALID_INPUT', message: '时间区间无效' } }
        }
        if (to - from > 366 * 24 * 3600_000) {
          return { status: 400, body: { code: 'INVALID_INPUT', message: '一次最多查 366 天，请缩小区间' } }
        }
        return { status: 200, body: { items: this.options.timeline(from, to), from, to } }
      }
      if (pathname === '/companion/v1/skills') {
        if (!this.options.skills) return { status: 503, body: { code: 'SKILLS_UNAVAILABLE', message: '技能库尚未启用' } }
        if (method === 'GET') return { status: 200, body: { skills: this.options.skills(), pending: this.options.skillPending?.() ?? [], unverified: this.options.skillUnverified?.() ?? [] } }
        if (!this.options.skillEdit) return { status: 503, body: { code: 'SKILLS_UNAVAILABLE', message: '技能库尚未启用' } }
        /*
         * 证据的两个动作单独走：它们作用在"还没形成技能"的样本上，没有技能编号可用。
         * 本人确认是**唯一**能把自报样本转正的路径 —— 四态回执那条路在受管执行器里，
         * 成员任务目前拿不到，见交付清单。
         */
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).action === 'verify') {
          const input = z.object({ action: z.literal('verify'), assistantId: z.string().trim().min(1).max(200), shape: z.string().trim().min(1).max(120) }).strict().parse(raw)
          if (!this.options.skillVerify) return { status: 503, body: { code: 'SKILLS_UNAVAILABLE', message: '技能库尚未启用' } }
          const verified = this.options.skillVerify(input.assistantId, input.shape)
          return { status: 200, body: { verified, skills: this.options.skills(), pending: this.options.skillPending?.() ?? [], unverified: this.options.skillUnverified?.() ?? [] } }
        }
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).action === 'retract') {
          const input = z.object({ action: z.literal('retract'), assistantId: z.string().trim().min(1).max(200), shape: z.string().trim().min(1).max(120) }).strict().parse(raw)
          if (!this.options.skillRetract) return { status: 503, body: { code: 'SKILLS_UNAVAILABLE', message: '技能库尚未启用' } }
          const removed = this.options.skillRetract(input.assistantId, input.shape)
          return { status: 200, body: { removed, skills: this.options.skills(), pending: this.options.skillPending?.() ?? [], unverified: this.options.skillUnverified?.() ?? [] } }
        }
        const input = z.discriminatedUnion('action', [
          z.object({ action: z.enum(['promote', 'rollback', 'retire']), id: z.string().trim().min(1).max(400), version: z.number().int().min(1).optional() }).strict(),
          z.object({ action: z.literal('create'), assistantId: z.string().trim().min(1).max(200), name: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(20_000) }).strict(),
          z.object({ action: z.literal('edit'), id: z.string().trim().min(1).max(400), body: z.string().trim().min(1).max(20_000) }).strict(),
          z.object({ action: z.literal('delete'), id: z.string().trim().min(1).max(400) }).strict(),
        ]).parse(raw)
        if (input.action === 'rollback' && input.version === undefined) {
          return { status: 400, body: { code: 'INVALID_INPUT', message: '回滚需要指定要回到哪一版' } }
        }
        return { status: 200, body: { skills: this.options.skillEdit(input) } }
      }
      if (pathname === '/companion/v1/artifacts') {
        if (!this.options.artifacts) return { status: 503, body: { code: 'ARTIFACTS_UNAVAILABLE', message: '产物索引尚未启用' } }
        return { status: 200, body: { artifacts: this.options.artifacts() } }
      }
      if (pathname === '/companion/v1/glossary') {
        if (!this.options.glossary) return { status: 503, body: { code: 'GLOSSARY_UNAVAILABLE', message: '词库尚未启用' } }
        if (method === 'GET') return { status: 200, body: { terms: this.options.glossary() } }
        if (!this.options.glossaryEdit) return { status: 503, body: { code: 'GLOSSARY_UNAVAILABLE', message: '词库尚未启用' } }
        const input = z.object({
          term: z.string().trim().min(1).max(120),
          expansion: z.string().trim().max(2000).optional(),
          remove: z.boolean().optional(),
        }).strict().parse(raw)
        if (input.remove !== true && (input.expansion ?? '').trim() === '') {
          return { status: 400, body: { code: 'INVALID_INPUT', message: '新增术语必须写清楚它指的是什么' } }
        }
        const terms = this.options.glossaryEdit(input)
        this.options.changed()
        return { status: 200, body: { terms } }
      }
      if (pathname === '/companion/v1/memories/shared') {
        if (method !== 'POST') return { status: 200, body: { records: this.options.sharedMemories?.() ?? [] } }
        if (!this.options.toggleShared) return { status: 503, body: { code: 'SHARING_UNAVAILABLE', message: '记忆共享尚未启用' } }
        const input = z.object({ memoryId: z.string().trim().min(1).max(200), shared: z.boolean() }).strict().parse(raw)
        const result = this.options.toggleShared(input.memoryId, input.shared)
        if (result === null) {
          return { status: 409, body: { code: 'NOT_SHAREABLE', message: '只有已确认的全局记忆可以共享给子助理' } }
        }
        this.options.changed()
        return { status: 200, body: { shared: result.shared, records: this.options.sharedMemories?.() ?? [] } }
      }
      if (method !== 'POST') return { status: 404, body: { code: 'NOT_FOUND', message: '成员接口不存在' } }
      if (pathname === '/companion/v1/members') directory.create(this.settle(draft.parse(raw)))
      else if (pathname === '/companion/v1/members/mode') {
        const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(raw)
        if (this.options.runtime.busy()) throw new Error('还有成员正在工作，不能切换团队模式')
        await this.options.setMode(enabled)
      } else {
        const update = /^\/companion\/v1\/members\/([A-Za-z0-9_-]+)\/(update|reset-quota)$/.exec(pathname)
        const remove = /^\/companion\/v1\/members\/([A-Za-z0-9_-]+)\/delete$/.exec(pathname)
        const decision = /^\/companion\/v1\/members\/requests\/([A-Za-z0-9_-]+)\/decide$/.exec(pathname)
        if (remove) {
          const id = remove[1]
          this.idle(id)
          const input = z.object({ expectedRevision: revision, purgeMemory: z.boolean().optional() }).strict().parse(raw)
          const profile = directory.get(id)
          if (!profile) throw new Error('智能体不存在')
          if (profile.revision !== input.expectedRevision) throw new Error('成员修订冲突，请刷新后重试')
          if (directory.hasInFlight(id)) throw new Error('成员仍有进行中的请求，结算前不能删除')
          const active = this.options.activeTasks?.(id) ?? 0
          if (active > 0) throw new Error(`还有 ${active} 个未结束的团队任务，请先处理完再删除`)
          if (input.purgeMemory) {
            try { memories.purge(id) } catch {
              throw new Error('独立记忆未能清除，成员未删除；请稍后重试，未完成的操作不会自动重发')
            }
          }
          try { directory.delete(id, input.expectedRevision) } catch (error) {
            if (input.purgeMemory) throw new Error('独立记忆已清除，但成员未能删除；请刷新后重试删除')
            throw error
          }
          // 密钥条目尽力清理：失败不阻塞删除（孤儿条目占上限但不影响正确性）。
          const bound = profile.binding
          if (this.options.secrets?.remove && bound && bound.kind === 'platform' && bound.secretId !== '') {
            try { this.options.secrets.remove(bound.secretId) } catch { /* 密钥条目清理失败不影响成员删除 */ }
          }
        } else if (update) {
          const id = update[1]
          this.idle(id)
          if (update[2] === 'update') {
            const { expectedRevision, ...input } = draft.extend({ expectedRevision: revision }).strict().parse(raw)
            directory.update(id, expectedRevision, this.settle(input))
          } else {
            const input = z.object({ expectedQuotaRevision: revision, scope: reset }).strict().parse(raw)
            directory.resetQuota(id, input.expectedQuotaRevision, input.scope)
          }
        } else if (decision) {
          const request = directory.requests().find(item => item.requestId === decision[1])
          if (!request) throw new Error('额度申请不存在或已处理')
          this.idle(request.assistantId)
          const input = decisionSchema.parse(raw)
          directory.decideRequest(decision[1], input.decision, input.expectedQuotaRevision, input.change)
        } else return { status: 404, body: { code: 'NOT_FOUND', message: '成员接口不存在' } }
      }
      this.options.changed()
      return { status: 200, body: this.snapshot() }
    } catch (error) {
      if (error instanceof z.ZodError) return { status: 422, body: { code: 'INVALID_INPUT', message: '配置字段无效，请核对名称、模型、额度、权限和时区' } }
      return { status: 409, body: { code: 'MEMBER_CONFLICT', message: error instanceof Error ? error.message : '成员操作未完成，请刷新核对' } }
    }
  }
}
