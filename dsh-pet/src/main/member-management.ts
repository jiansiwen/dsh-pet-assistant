import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'
import {
  MEMBER_CAPABILITIES, MEMBER_READ_TOOLS, MEMORY_KINDS,
  type MemberDraft, type MemberProfile, type MemberSnapshot, type MemoryRecord,
  type MemberResult, type MemberAction, type MemoryDeletePreview,
} from '../member-types.ts'

export const MEMBER_CHANNELS = { state: 'members-state', memories: 'member-memories', command: 'member-command', assist: 'member-assist' } as const
const ROOT = '/companion/v1/members'
interface Options {
  getStageWindow(): BrowserWindow | null
  pagePath: string
  request(method: string, pathname: string, body: unknown, subject: 'owner'): Promise<{ status: number; body: unknown }>
  /** 额外放行的窗口（成员编辑窗口）；必须自行核对 sender、主框架与固定本地地址。 */
  allowWindow?(event: IpcMainInvokeEvent): boolean
  /** 原生确认的父窗口；缺省用舞台。编辑窗口发起的保存要显示在编辑窗口上。 */
  parentOf?(event: IpcMainInvokeEvent): BrowserWindow | null
  /** 写入成功后通知界面刷新；失败不影响已经落库的结果。 */
  changed?(): void
}
type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_input')
  return value as RecordValue
}
function text(value: unknown, max = 16000): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error('invalid_input')
  return value
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('invalid_input')
  return value
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('invalid_input')
  return value
}
function list<T>(value: unknown, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('invalid_input')
  return value.map(parse)
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error('invalid_input')
  return value as T
}
function keys(value: RecordValue, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('invalid_input')
}
function identifier(value: unknown): string {
  const id = text(value, 256)
  if (!id.trim() || id === '.' || id === '..' || /[/\\%?#\r\n]/u.test(id)) throw new Error('invalid_input')
  return id
}
function uuid(value: unknown): string {
  const id = identifier(value)
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(id)) throw new Error('invalid_input')
  return id
}
export function memberPathIdentifier(value: unknown): string {
  return encodeURIComponent(identifier(value)).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}
const draftKeys = ['displayName', 'description', 'personality', 'permissionMode', 'persona', 'skinId', 'enabled', 'provider', 'model', 'maxTokens', 'capabilities', 'allowedTools', 'dailyTokenLimit', 'totalTokenLimit', 'thresholdPercent', 'timezone']
function draft(value: RecordValue, writing = false): MemberDraft {
  const next: MemberDraft = {
    displayName: text(value.displayName, 80), description: text(value.description, 2000), personality: text(value.personality, 2000),
    permissionMode: choice(value.permissionMode, ['ask', 'auto', 'full']), persona: text(value.persona, 8000),
    skinId: text(value.skinId, 128), enabled: bool(value.enabled), provider: text(value.provider, 128), model: text(value.model, 256),
    maxTokens: integer(value.maxTokens, 1, 32768), capabilities: list(value.capabilities, item => choice(item, MEMBER_CAPABILITIES)),
    allowedTools: list(value.allowedTools, item => text(item, 128)), dailyTokenLimit: integer(value.dailyTokenLimit),
    totalTokenLimit: integer(value.totalTokenLimit), thresholdPercent: integer(value.thresholdPercent, 1, 100), timezone: text(value.timezone, 128),
  }
  if (writing) {
    if (!next.displayName.trim() || !!next.provider.trim() !== !!next.model.trim() || next.allowedTools.length > 0) throw new Error('invalid_input')
    new Intl.DateTimeFormat('zh-CN', { timeZone: next.timezone }).format()
  }
  return next
}
/** 所有已知回包逐字段投影，绝不将服务凭据或附带调试字段交给渲染器。 */
export function projectMemberState(value: unknown): MemberSnapshot {
  const source = record(value)
  const defaultModel = source.defaultModel === null ? null : record(source.defaultModel)
  let mailNoticeAttention: MemberSnapshot['mailNoticeAttention']
  let mailNoticeAttentionError: boolean | undefined
  let mailSendAttention: MemberSnapshot['mailSendAttention']
  let mailSendAttentionError: boolean | undefined
  let channelInboundAttention: MemberSnapshot['channelInboundAttention']
  let channelInboundAttentionError: boolean | undefined
  if (source.mailNoticeAttentionError !== undefined) {
    mailNoticeAttentionError = typeof source.mailNoticeAttentionError === 'boolean' ? source.mailNoticeAttentionError : true
  }
  if (source.mailNoticeAttention !== undefined) {
    try {
      mailNoticeAttention = list(source.mailNoticeAttention, item => {
        const issue = record(item)
        return { analysisId: uuid(issue.analysisId), memberId: identifier(issue.memberId), attemptId: uuid(issue.attemptId),
          state: choice(issue.state, ['failed', 'unknown'] as const), preview: text(issue.preview, 200) }
      })
      if (mailNoticeAttention.length > 20) throw new Error('invalid_response')
    } catch { mailNoticeAttention = undefined; mailNoticeAttentionError = true }
  }
  if (source.mailSendAttentionError !== undefined) {
    mailSendAttentionError = typeof source.mailSendAttentionError === 'boolean' ? source.mailSendAttentionError : true
  }
  if (source.mailSendAttention !== undefined) {
    try {
      mailSendAttention = list(source.mailSendAttention, item => {
        const send = record(item)
        const recipients = list(send.recipients, value => text(value, 320))
        const accepted = list(send.accepted, value => text(value, 320))
        const rejected = list(send.rejected, value => text(value, 320))
        if (recipients.length > 20 || accepted.length > 20 || rejected.length > 20) throw new Error('invalid_response')
        return { intentId: uuid(send.intentId), subject: text(send.subject, 200), recipients,
          state: choice(send.state, ['sending', 'partial', 'unknown'] as const), accepted, rejected,
          messageId: send.messageId === null ? null : text(send.messageId, 300) }
      })
      if (mailSendAttention.length > 20) throw new Error('invalid_response')
    } catch { mailSendAttention = undefined; mailSendAttentionError = true }
  }
  if (source.channelInboundAttentionError !== undefined) {
    channelInboundAttentionError = typeof source.channelInboundAttentionError === 'boolean' ? source.channelInboundAttentionError : true
  }
  if (source.channelInboundAttention !== undefined) {
    try {
      channelInboundAttention = list(source.channelInboundAttention, item => {
        const channel = record(item)
        const accountTag = text(channel.accountTag, 12)
        if (!/^[a-f0-9]{12}$/iu.test(accountTag)) throw new Error('invalid_response')
        return { id: uuid(channel.id), channel: text(channel.channel, 200), accountTag, msgid: text(channel.msgid, 200),
          chatId: text(channel.chatId, 200), chatType: choice(channel.chatType, ['single', 'group'] as const), senderId: text(channel.senderId, 200),
          state: choice(channel.state, ['pending', 'processing', 'replying', 'completed', 'unknown', 'reviewed'] as const),
          processing: choice(channel.processing, ['not-started', 'running', 'done', 'unknown'] as const),
          reply: choice(channel.reply, ['not-sent', 'sending', 'accepted', 'unknown'] as const),
          conflict: bool(channel.conflict), busy: bool(channel.busy), revision: integer(channel.revision, 1), receivedAt: integer(channel.receivedAt) }
      })
      if (channelInboundAttention.length > 20) throw new Error('invalid_response')
    } catch { channelInboundAttention = undefined; channelInboundAttentionError = true }
  }
  return {
    enabled: bool(source.enabled), defaultModel: defaultModel && { provider: text(defaultModel.provider), model: text(defaultModel.model) },
    members: list(source.members, item => {
      const view = record(item), p = record(view.profile), q = record(view.quota), policy = record(p.toolPolicy)
      const profile: MemberProfile = {
        ...draft(p), assistantId: identifier(p.assistantId), roleId: choice(p.roleId, ['tangseng', 'wukong', 'bajie', 'shaseng', 'bailongma', 'custom']),
        voiceProfile: text(p.voiceProfile), toolPolicy: { mode: choice(policy.mode, ['read-only', 'side-effect']), denyTools: list(policy.denyTools, item => text(item)) },
        revision: integer(p.revision), sessionId: p.sessionId === null ? null : text(p.sessionId),
      }
      return { profile, busy: bool(view.busy), quota: {
        day: text(q.day), dailyUsed: integer(q.dailyUsed), totalUsed: integer(q.totalUsed),
        // 旧宿主回包没有预留字段时按 0 展示，界面仍能打开。
        dailyReserved: q.dailyReserved === undefined ? 0 : integer(q.dailyReserved),
        totalReserved: q.totalReserved === undefined ? 0 : integer(q.totalReserved),
        dailyTokenLimit: integer(q.dailyTokenLimit),
        totalTokenLimit: integer(q.totalTokenLimit), thresholdPercent: integer(q.thresholdPercent, 1, 100), unknown: bool(q.unknown), blocked: bool(q.blocked), revision: integer(q.revision),
      } }
    }),
    requests: list(source.requests, item => {
      const r = record(item)
      return { requestId: identifier(r.requestId), assistantId: identifier(r.assistantId), reason: text(r.reason),
        state: choice(r.state, ['pending', 'approved', 'rejected']), createdAt: integer(r.createdAt), quotaRevision: integer(r.quotaRevision) }
    }),
    ...(mailNoticeAttention ? { mailNoticeAttention } : {}),
    ...(mailNoticeAttentionError === undefined ? {} : { mailNoticeAttentionError }),
    ...(mailSendAttention ? { mailSendAttention } : {}),
    ...(mailSendAttentionError === undefined ? {} : { mailSendAttentionError }),
    ...(channelInboundAttention ? { channelInboundAttention } : {}),
    ...(channelInboundAttentionError === undefined ? {} : { channelInboundAttentionError }),
  }
}
export function projectMemberAssist(value: unknown): { draft: MemberDraft; notes: string } {
  const source = record(value)
  return { draft: draft(record(source.draft), true), notes: text(source.notes, 2000) }
}
export function projectMemberMemories(value: unknown): { records: MemoryRecord[] } {
  return { records: list(record(value).records, item => {
    const m = record(item), scope = record(m.scope)
    return { id: identifier(m.id), kind: choice(m.kind, MEMORY_KINDS), scope: { kind: choice(scope.kind, ['global', 'project', 'team', 'role', 'session']), id: text(scope.id) },
      topic: text(m.topic), text: text(m.text), sourceRefs: list(m.sourceRefs, item => text(item)), status: choice(m.status, ['candidate', 'confirmed', 'conflicting', 'expired']),
      sensitivity: choice(m.sensitivity, ['normal', 'sensitive']), createdBy: text(m.createdBy), confirmedBy: m.confirmedBy === null ? null : text(m.confirmedBy),
      revision: integer(m.revision), createdAt: integer(m.createdAt), updatedAt: integer(m.updatedAt),
      expiresAt: m.expiresAt === null ? null : integer(m.expiresAt), importBatch: m.importBatch === null ? null : text(m.importBatch) }
  }) }
}
/** 删除影响尚无固定结构，递归过滤凭据字段；不裁掉普通影响明细。 */
function publicImpact(value: unknown, depth = 0): unknown {
  if (depth > 20) throw new Error('invalid_response')
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return text(value, 100000)
  if (Array.isArray(value)) return value.map(item => publicImpact(item, depth + 1))
  return Object.fromEntries(Object.entries(record(value))
    .filter(([key]) => !/secret|password|credential|authorization|cookie|api.?key|access.?token|refresh.?token|owner.?token|bearer/i.test(key))
    .map(([key, item]) => [key, publicImpact(item, depth + 1)]))
}
interface Parsed { action: MemberAction; path: string; body: RecordValue; id?: string; memoryId?: string; requestId?: string; analysisId?: string; intentId?: string; channelId?: string }
function parseCommand(action: unknown, raw: unknown): Parsed {
  const a = choice(action, ['create', 'update', 'mode', 'delete', 'reset-quota', 'decide-request', 'ack-mail-notice', 'ack-mail-send', 'ack-channel-inbound', 'memory-create', 'memory-update', 'memory-confirm', 'memory-delete-preview', 'memory-delete'] as const)
  const input = record(raw)
  if (a === 'ack-channel-inbound') {
    keys(input, ['id', 'expectedRevision'])
    const channelId = uuid(input.id)
    return { action: a, channelId, path: `${ROOT}/channel-inbound/${channelId}/acknowledge`,
      body: { expectedRevision: integer(input.expectedRevision, 1) } }
  }
  if (a === 'ack-mail-send') {
    keys(input, ['intentId', 'expectedState'])
    const intentId = uuid(input.intentId)
    return { action: a, intentId, path: `${ROOT}/mail-sends/${intentId}/acknowledge`,
      body: { expectedState: choice(input.expectedState, ['partial', 'unknown'] as const) } }
  }
  if (a === 'ack-mail-notice') {
    keys(input, ['analysisId', 'attemptId', 'expectedState'])
    const analysisId = uuid(input.analysisId)
    return { action: a, analysisId, path: `${ROOT}/mail-notices/${analysisId}/acknowledge`,
      body: { attemptId: uuid(input.attemptId), expectedState: choice(input.expectedState, ['failed', 'unknown'] as const) } }
  }
  if (a === 'create' || a === 'update') {
    keys(input, [...draftKeys, ...(a === 'update' ? ['id', 'expectedRevision'] : [])])
    const data = draft(input, true)
    if (a === 'create') return { action: a, path: ROOT, body: { ...data } }
    const id = identifier(input.id)
    return { action: a, id, path: `${ROOT}/${memberPathIdentifier(id)}/update`, body: { expectedRevision: integer(input.expectedRevision), ...data } }
  }
  if (a === 'mode') { keys(input, ['enabled']); return { action: a, path: `${ROOT}/mode`, body: { enabled: bool(input.enabled) } } }
  if (a === 'decide-request') {
    keys(input, ['requestId', 'decision', 'expectedQuotaRevision', 'change'])
    const requestId = identifier(input.requestId), decision = choice(input.decision, ['approve', 'reject'])
    const body: RecordValue = { decision, expectedQuotaRevision: integer(input.expectedQuotaRevision) }
    if (decision === 'approve') {
      const change = record(input.change)
      keys(change, ['dailyTokenLimit', 'totalTokenLimit', 'reset'])
      if (!Object.keys(change).length) throw new Error('invalid_input')
      body.change = {
        ...(change.dailyTokenLimit !== undefined ? { dailyTokenLimit: integer(change.dailyTokenLimit) } : {}),
        ...(change.totalTokenLimit !== undefined ? { totalTokenLimit: integer(change.totalTokenLimit) } : {}),
        ...(change.reset !== undefined ? { reset: choice(change.reset, ['daily', 'total', 'both']) } : {}),
      }
    } else if (input.change !== undefined) throw new Error('invalid_input')
    return { action: a, requestId, path: `${ROOT}/requests/${memberPathIdentifier(requestId)}/decide`, body }
  }
  const id = identifier(input.id), base = `${ROOT}/${memberPathIdentifier(id)}`
  if (a === 'delete') {
    keys(input, ['id', 'expectedRevision'])
    return { action: a, id, path: `${base}/delete`, body: { expectedRevision: integer(input.expectedRevision, 1) } }
  }
  if (a === 'reset-quota') {
    keys(input, ['id', 'expectedQuotaRevision', 'scope'])
    return { action: a, id, path: `${base}/reset-quota`, body: { expectedQuotaRevision: integer(input.expectedQuotaRevision), scope: choice(input.scope, ['daily', 'total', 'both']) } }
  }
  if (a === 'memory-create') {
    keys(input, ['id', 'kind', 'topic', 'text'])
    if (!text(input.text).trim()) throw new Error('invalid_input')
    return { action: a, id, path: `${base}/memories`, body: { kind: choice(input.kind, MEMORY_KINDS), topic: text(input.topic, 500), text: text(input.text) } }
  }
  const memoryId = identifier(input.memoryId)
  keys(input, ['id', 'memoryId', 'expectedRevision', ...(a === 'memory-update' ? ['text', 'topic'] : a === 'memory-delete' ? ['previewId'] : [])])
  const body: RecordValue = { expectedRevision: integer(input.expectedRevision) }
  if (a === 'memory-update') {
    body.text = text(input.text); body.topic = text(input.topic, 500)
    if (!(body.text as string).trim()) throw new Error('invalid_input')
  }
  if (a === 'memory-delete') body.previewId = identifier(input.previewId)
  return { action: a, id, memoryId, path: `${base}/memories/${memberPathIdentifier(memoryId)}/${a.slice(7)}`, body }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
const messages: Record<string, string> = {
  denied: '请求不是来自当前舞台或成员编辑窗口的原始本地主页面，未执行。', invalid_input: '输入字段、精确工具名或数值无效，请核对后重试。',
  conflict: '版本已变化，请刷新后核对；草稿保留，不会自动重发。', busy: '成员正忙或已有确认正在处理，请稍后刷新。',
  cancelled: '已取消，未执行修改。', unavailable: '连接或回执异常，结果可能未知；请刷新核对，不会自动重发。',
  invalid_response: '服务回包不完整，请刷新核对，不会自动重发。', preview_required: '请重新预览删除影响，再确认删除。',
  assist_failed: '这次没有生成可用配置，请换一种说法再试，或直接在下面填写。',
}
function parseAssist(raw: unknown): { request: string; current?: MemberDraft } {
  const input = record(raw)
  keys(input, ['request', 'current'])
  const request = text(input.request, 4000).trim()
  if (!request) throw new Error('invalid_input')
  return { request, ...(input.current === undefined ? {} : { current: draft(record(input.current)) }) }
}
function failure(code: string): MemberResult { return { ok: false, error: { code, message: messages[code] ?? messages.unavailable! } } }
/** 删除被业务规则挡住时保留宿主的中文原因，不把内部错误或凭据带出来。 */
class MemberConflict extends Error {}

export function registerMemberManagement(options: Options): () => void {
  const pageURL = pathToFileURL(options.pagePath).href
  let disposed = false, saving = false
  const previews = new Map<string, { sender: IpcMainInvokeEvent['sender']; frame: IpcMainInvokeEvent['senderFrame']; id: string; memoryId: string; revision: number; data: MemoryDeletePreview; expires: number }>()
  const allowed = (event: IpcMainInvokeEvent): boolean => {
    if (disposed) return false
    try {
      const win = options.getStageWindow()
      const stage = !!win && !win.isDestroyed() && event.sender === win.webContents
        && event.senderFrame !== null && event.senderFrame === event.sender.mainFrame && event.senderFrame === win.webContents.mainFrame
        && event.senderFrame.url === pageURL && win.webContents.getURL() === pageURL
      return stage || options.allowWindow?.(event) === true
    } catch { return false }
  }
  async function request(event: IpcMainInvokeEvent, method: string, path: string, body?: unknown,
    flags: { keepConflictMessage?: boolean } = {}): Promise<unknown> {
    if (!allowed(event)) throw new Error('denied')
    let response: { status: number; body: unknown }
    try { response = await options.request(method, path, body, 'owner') } catch { throw new Error('unavailable') }
    if (!allowed(event)) throw new Error('denied')
    if (response.status === 409) {
      if (flags.keepConflictMessage) {
        try {
          const message = record(response.body).message
          throw new MemberConflict(typeof message === 'string' && message.length <= 500 ? message : messages.conflict!)
        } catch (error) {
          if (error instanceof MemberConflict) throw error
          throw new Error('conflict')
        }
      }
      throw new Error('conflict')
    }
    if (response.status === 503 && path.endsWith('/assist')) throw new Error('assist_failed')
    if (response.status < 200 || response.status >= 300) throw new Error(response.status === 400 || response.status === 422 ? 'invalid_input' : 'unavailable')
    const result = record(response.body)
    if (typeof result.code === 'string' && typeof result.message === 'string') throw new Error('unavailable')
    return result
  }
  const guarded = async (event: IpcMainInvokeEvent, work: () => Promise<MemberResult>): Promise<MemberResult> => {
    if (!allowed(event)) return failure('denied')
    try { return await work() } catch (error) {
      if (error instanceof MemberConflict) return { ok: false, error: { code: 'conflict', message: error.message } }
      return failure(error instanceof Error && Object.hasOwn(messages, error.message) ? error.message : 'invalid_response')
    }
  }
  ipcMain.handle(MEMBER_CHANNELS.state, event => guarded(event, async () => ({ ok: true, state: projectMemberState(await request(event, 'GET', ROOT)) })))
  ipcMain.handle(MEMBER_CHANNELS.memories, (event, id: unknown) => guarded(event, async () => ({ ok: true,
    data: projectMemberMemories(await request(event, 'GET', `${ROOT}/${memberPathIdentifier(id)}/memories`)) })))
  ipcMain.handle(MEMBER_CHANNELS.assist, (event, raw: unknown) => guarded(event, async () => {
    let input: { request: string; current?: MemberDraft }
    try { input = parseAssist(raw) } catch { return failure('invalid_input') }
    return { ok: true, data: projectMemberAssist(await request(event, 'POST', `${ROOT}/assist`, input)) }
  }))
  ipcMain.handle(MEMBER_CHANNELS.command, (event, action: unknown, raw: unknown) => guarded(event, async () => {
    if (saving) return failure('busy')
    let command: Parsed
    try { command = freeze(parseCommand(action, raw)) } catch { return failure('invalid_input') }
    saving = true
    try {
      const state = projectMemberState(await request(event, 'GET', ROOT))
      const quotaRequest = command.requestId ? state.requests.find(item => item.requestId === command.requestId) : undefined
      const mailNotice = command.analysisId ? state.mailNoticeAttention?.find(item => item.analysisId === command.analysisId) : undefined
      if (command.analysisId && (!mailNotice || mailNotice.attemptId !== command.body.attemptId || mailNotice.state !== command.body.expectedState)) return failure('conflict')
      const mailSend = command.intentId ? state.mailSendAttention?.find(item => item.intentId === command.intentId) : undefined
      if (command.intentId && (!mailSend || mailSend.state !== command.body.expectedState)) return failure('conflict')
      const channelIssue = command.channelId ? state.channelInboundAttention?.find(item => item.id === command.channelId) : undefined
      if (command.channelId && (!channelIssue || channelIssue.busy || channelIssue.revision !== command.body.expectedRevision)) return failure('conflict')
      const id = command.id ?? quotaRequest?.assistantId
      const member = id ? state.members.find(item => item.profile.assistantId === id) : undefined
      if ((id && !member) || (command.requestId && (!quotaRequest || quotaRequest.state !== 'pending'))) return failure('conflict')
      if (member?.busy && ['update', 'delete', 'reset-quota', 'decide-request'].includes(command.action)) return failure('busy')
      if (command.action === 'update' && command.body.expectedRevision !== member?.profile.revision) return failure('conflict')
      if ('expectedQuotaRevision' in command.body && command.body.expectedQuotaRevision !== member?.quota.revision) return failure('conflict')
      if (command.action === 'decide-request' && command.body.decision === 'approve') {
        const change = record(command.body.change), quota = member!.quota
        const raises = (key: 'dailyTokenLimit' | 'totalTokenLimit') => change[key] !== undefined && quota[key] !== 0 && (change[key] === 0 || Number(change[key]) > quota[key])
        if ((['dailyTokenLimit', 'totalTokenLimit'] as const).some(key => change[key] !== undefined && !raises(key))
          || (!change.reset && !raises('dailyTokenLimit') && !raises('totalTokenLimit'))) return failure('invalid_input')
      }
      let memory: MemoryRecord | undefined
      if (command.memoryId) {
        const memories = projectMemberMemories(await request(event, 'GET', `${ROOT}/${memberPathIdentifier(id)}/memories`))
        memory = memories.records.find(item => item.id === command.memoryId)
        if (!memory || memory.revision !== command.body.expectedRevision) return failure('conflict')
      }
      if (command.action === 'memory-delete-preview') {
        const result = record(await request(event, 'POST', command.path, command.body))
        const data = { previewId: identifier(result.previewId), impact: publicImpact(result.impact) }
        for (const [key, value] of previews) if (value.expires < Date.now()) previews.delete(key)
        if (previews.size >= 50) previews.clear()
        previews.set(data.previewId, { sender: event.sender, frame: event.senderFrame, id: id!, memoryId: command.memoryId!, revision: memory!.revision, data, expires: Date.now() + 300000 })
        return { ok: true, data }
      }
      let deletion = command.action === 'delete'
        ? '\n将删除成员配置、额度账户、用量与额度申请记录。历史会话和任务记录保留作为审计；独立记忆默认保留，勾选下方选项则一并清除。\n'
        : ''
      if (command.action === 'memory-delete') {
        const preview = previews.get(String(command.body.previewId))
        if (!preview || preview.sender !== event.sender || preview.frame !== event.senderFrame || preview.id !== id
          || preview.memoryId !== command.memoryId || preview.revision !== command.body.expectedRevision || preview.expires < Date.now()) return failure('preview_required')
        deletion = `\n删除影响：\n${JSON.stringify(preview.data.impact, null, 2)}\n已发送给模型的历史无法追回；后端使用新会话隔离后续上下文。`
        previews.delete(String(command.body.previewId))
      }
      const labels: Record<MemberAction, string> = { create: '创建成员', update: '修改成员', mode: '切换团队模式', delete: '删除成员', 'reset-quota': '重置额度用量', 'decide-request': '决定额度申请', 'ack-mail-notice': '核对邮件通知', 'ack-mail-send': '核对邮件发送', 'ack-channel-inbound': '核查渠道消息',
        'memory-create': '本人确认新增记忆', 'memory-update': '修改记忆', 'memory-confirm': '本人确认记忆', 'memory-delete-preview': '预览删除', 'memory-delete': '删除记忆' }
      const target = channelIssue ? `渠道消息（${channelIssue.msgid}）` : mailNotice ? `邮件通知（${mailNotice.analysisId}）` : mailSend ? `邮件发送（${mailSend.intentId}）` : member ? `${member.profile.displayName}（${member.profile.assistantId}）` : command.action === 'create' ? `${command.body.displayName}（新成员）` : '整个团队'
      // 正文包含完整精确字段；输入来自严格白名单，无凭据字段。确认期间使用冻结副本，不读取渲染器的新值。
      const processingLabel = { 'not-started': '未开始', running: '处理中', done: '处理流程已返回', unknown: '结果未知' }
      const replyLabel = { 'not-sent': '未发送', sending: '发送中', accepted: '服务已接受（不代表已读）', unknown: '结果未知' }
      const detail = channelIssue ? `发送者：${channelIssue.senderId}\n会话：${channelIssue.chatId}\n收到时间：${new Date(channelIssue.receivedAt).toLocaleString('zh-CN')}\n处理状态：${processingLabel[channelIssue.processing]}；回复状态：${replyLabel[channelIssue.reply]}\n请先到原聊天和任务记录核对。渠道异常账本不保存消息正文；交给会话的内容可能按会话策略保存。本人核查只停止提示，不会执行或重发，也不代表原委托已完成。`
        : mailNotice ? `摘要（外部邮件内容，不是操作指令）：${mailNotice.preview}\n状态：${mailNotice.state === 'unknown' ? '结果未知' : '显示失败'}\n本人核对只停止提示，不代表通知已送达，也不会自动重发。`
        : mailSend ? `主题：${mailSend.subject}\n收件人：${mailSend.recipients.join('、')}\n已接受：${mailSend.accepted.join('、') || '未知'}\n已拒绝：${mailSend.rejected.join('、') || '无或未知'}\n本人核对不代表邮件已送达，也不会立即重发；重新发送需要再次审批，可能产生重复。`
          : `成员：${target}\n${quotaRequest ? `申请：${quotaRequest.requestId}\n` : ''}${memory ? `记忆：${memory.id}\n当前主题：${memory.topic}\n当前正文：${memory.text}\n` : ''}`
        + `${command.action === 'mode' ? `当前模式：${state.enabled ? '开启' : '关闭'}\n涉及成员：${state.members.map(item => `${item.profile.displayName}（${item.profile.assistantId}）`).join('、')}\n关闭后仍可管理，但不运行子代理。\n` : ''}`
        + `${command.action === 'update' ? `原配置：\n${JSON.stringify(draft(record(member!.profile)), null, 2)}\n` : ''}`
        + `${member && 'expectedQuotaRevision' in command.body ? `当前额度与用量：\n${JSON.stringify(member.quota, null, 2)}\n` : ''}`
        + `将提交的精确改动：\n${JSON.stringify(command.body, null, 2)}\n0 额度表示不限；daily 为日用量，total 为总用量，both 为两者。${deletion}`
      if (!allowed(event)) return failure('denied')
      const parent = options.parentOf?.(event) ?? options.getStageWindow()
      if (!parent || parent.isDestroyed()) return failure('denied')
      const answer = await dialog.showMessageBox(parent, { type: 'warning', title: labels[command.action], message: `${labels[command.action]}：${target}`, detail,
        buttons: ['取消', '确认执行'], defaultId: 0, cancelId: 0, noLink: true,
        ...(command.action === 'delete' ? { checkboxLabel: '同时清除这个成员的独立记忆（不可恢复）', checkboxChecked: false } : {}) })
      if (!allowed(event)) return failure('denied')
      if (answer.response !== 1) return failure('cancelled')
      // 确认后重新读取忙碌和 CAS，不能在原生框停留期间悄悄修改新版本。
      const latest = projectMemberState(await request(event, 'GET', ROOT))
      const latestNotice = command.analysisId ? latest.mailNoticeAttention?.find(item => item.analysisId === command.analysisId) : undefined
      if (command.analysisId && (!latestNotice || latestNotice.attemptId !== command.body.attemptId || latestNotice.state !== command.body.expectedState)) return failure('conflict')
      const latestSend = command.intentId ? latest.mailSendAttention?.find(item => item.intentId === command.intentId) : undefined
      if (command.intentId && (!latestSend || latestSend.state !== command.body.expectedState)) return failure('conflict')
      const latestChannel = command.channelId ? latest.channelInboundAttention?.find(item => item.id === command.channelId) : undefined
      if (command.channelId && (!latestChannel || latestChannel.busy || latestChannel.revision !== command.body.expectedRevision)) return failure('conflict')
      const current = id ? latest.members.find(item => item.profile.assistantId === id) : undefined
      if (command.action === 'mode' && latest.enabled !== state.enabled) return failure('conflict')
      if (member && (!current || current.profile.revision !== member.profile.revision)) return failure('conflict')
      if (current?.busy && ['update', 'delete', 'reset-quota', 'decide-request'].includes(command.action)) return failure('busy')
      if ('expectedQuotaRevision' in command.body && current?.quota.revision !== command.body.expectedQuotaRevision) return failure('conflict')
      const body = command.action === 'delete' && answer.checkboxChecked === true
        ? { ...command.body, purgeMemory: true }
        : command.body
      await request(event, 'POST', command.path, body, { keepConflictMessage: command.action === 'delete' })
      try { options.changed?.() } catch { /* 已经落库，刷新失败不影响结果 */ }
      return { ok: true }
    } finally { saving = false }
  }))
  return () => { disposed = true; previews.clear(); Object.values(MEMBER_CHANNELS).forEach(channel => ipcMain.removeHandler(channel)) }
}
