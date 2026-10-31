import { z } from 'zod'
import type { MemberDirectory } from './member-directory.ts'
import type { MemberRuntime } from './member-runtime.ts'
import { MEMBER_CAPABILITIES, MEMBER_PERMISSION_MODES, type MemberDraft, type MemberSnapshot } from './member-contract.ts'
import type { MemberMemory } from './member-memory.ts'
import type { CompanionHttpResult } from './companion-contract.ts'

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const limit = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const draft = z.object({
  displayName: z.string().trim().min(1).max(80), description: z.string().trim().max(2000),
  personality: z.string().max(2000).default(''), permissionMode: z.enum(MEMBER_PERMISSION_MODES).default('ask'),
  persona: z.string().max(8000),
  skinId: z.string().min(1).max(100), enabled: z.boolean(), provider: z.string().trim().max(128), model: z.string().trim().max(256),
  maxTokens: z.number().int().min(1).max(32768), capabilities: z.array(z.enum(MEMBER_CAPABILITIES)).max(MEMBER_CAPABILITIES.length),
  allowedTools: z.array(z.string().min(1).max(100)).max(100), dailyTokenLimit: limit, totalTokenLimit: limit,
  thresholdPercent: z.number().min(1).max(100), timezone: z.string().min(1).max(100),
}).strict()
const reset = z.enum(['daily', 'total', 'both'])
const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']), expectedQuotaRevision: revision,
  change: z.object({ dailyTokenLimit: limit.optional(), totalTokenLimit: limit.optional(), reset: reset.optional() }).strict().optional() }).strict()
const assistSchema = z.object({ request: z.string().trim().min(1).max(4000), current: draft.optional() }).strict()
const noticeAcknowledgement = z.object({ attemptId: z.string().uuid(), expectedState: z.enum(['failed', 'unknown']) }).strict()
const sendAcknowledgement = z.object({ expectedState: z.enum(['partial', 'unknown']) }).strict()
const channelAcknowledgement = z.object({ expectedRevision: revision }).strict()

export class MemberManagement {
  private readonly options: {
    directory: MemberDirectory; runtime: MemberRuntime; memories: MemberMemory
    enabled(): boolean; setMode(enabled: boolean): Promise<void>
    defaultModel(): { provider: string; model: string } | null
    changed(): void
    activeTasks?(id: string): number
    mailNoticeAttention?(): NonNullable<MemberSnapshot['mailNoticeAttention']>
    acknowledgeMailNotice?(analysisId: string, attemptId: string, expectedState: 'failed' | 'unknown'): boolean
    mailSendAttention?(): NonNullable<MemberSnapshot['mailSendAttention']>
    acknowledgeMailSend?(intentId: string, expectedState: 'partial' | 'unknown'): boolean
    channelInboundAttention?(): NonNullable<MemberSnapshot['channelInboundAttention']>
    acknowledgeChannelInbound?(id: string, expectedRevision: number): boolean
    assistant?: { draft(input: { request: string; current?: MemberDraft }): Promise<{ draft: MemberDraft; notes: string }> }
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
    return { enabled: this.options.enabled(), members: directory.list().map(profile => ({ profile, quota: directory.quota(profile.assistantId), busy: runtime.busy(profile.assistantId) })),
      requests: directory.requests(), defaultModel: this.options.defaultModel(),
      ...(mailNoticeAttention ? { mailNoticeAttention } : {}), ...(mailNoticeAttentionError ? { mailNoticeAttentionError } : {}),
      ...(mailSendAttention ? { mailSendAttention } : {}), ...(mailSendAttentionError ? { mailSendAttentionError } : {}),
      ...(channelInboundAttention ? { channelInboundAttention } : {}), ...(channelInboundAttentionError ? { channelInboundAttentionError } : {}) }
  }
  private idle(id: string): void {
    if (!this.options.directory.get(id)) throw new Error('智能体不存在')
    if (this.options.runtime.busy(id)) throw new Error('该智能体正在工作，请任务结束后修改')
  }
  async request(method: string, pathname: string, raw: unknown): Promise<CompanionHttpResult> {
    const { directory, memories } = this.options
    try {
      if (method === 'GET' && pathname === '/companion/v1/members') return { status: 200, body: this.snapshot() }
      if (method === 'POST' && pathname === '/companion/v1/members/assist') {
        if (!this.options.assistant) return { status: 503, body: { code: 'ASSIST_UNAVAILABLE', message: '成员配置助手尚未启用' } }
        const input = assistSchema.parse(raw)
        try {
          const output = await this.options.assistant.draft({ request: input.request, current: input.current as MemberDraft | undefined })
          return { status: 200, body: { draft: draft.parse(output.draft), notes: output.notes.slice(0, 2000) } }
        } catch (error) {
          return { status: 503, body: { code: 'ASSIST_UNAVAILABLE', message: error instanceof Error ? error.message : '成员配置助手暂时不可用' } }
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
      if (method !== 'POST') return { status: 404, body: { code: 'NOT_FOUND', message: '成员接口不存在' } }
      if (pathname === '/companion/v1/members') directory.create(draft.parse(raw) as MemberDraft)
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
        } else if (update) {
          const id = update[1]
          this.idle(id)
          if (update[2] === 'update') {
            const { expectedRevision, ...input } = draft.extend({ expectedRevision: revision }).strict().parse(raw)
            directory.update(id, expectedRevision, input as MemberDraft)
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
