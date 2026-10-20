import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { BridgeAgent } from './bridge.ts'
import type { SessionCommand, SessionEntry, SessionModel, SessionResult, SessionSnapshot, SessionUpdate } from '../../dsh-pet/src/session-types.ts'

export type { SessionCommand, SessionResult, SessionUpdate } from '../../dsh-pet/src/session-types.ts'

/** 原始日志序号只用于条目与分页；cursor 是包含运行状态变化的绑定内版本。 */
export interface MirrorEvent {
  type: string
  data: Record<string, unknown>
  seq?: number
  surfaceOp?: { op: string } | 'append'
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' ? value as RecordValue : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
function visible(content: unknown): string {
  return list(content).map(block => {
    const item = record(block)
    return item.type === 'text' ? text(item.text) : ''
  }).join('')
}

/** 读会话事件日志：0.2.x 起 Session.events 数组改名 snapshotEvents()，旧宿主替身仍可能只有 events。 */
function eventsOf(agent: BridgeAgent): readonly MirrorEvent[] {
  const session = agent.session as unknown as {
    snapshotEvents?: () => readonly MirrorEvent[]
    events?: readonly MirrorEvent[]
  }
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return session.events ?? []
}

/** 按轮次、步序及工具身份 upsert，完成消息覆盖 chunk，而非追加第二份文本。 */
export class SessionProjection {
  readonly entries = new Map<string, SessionEntry>()
  private changed = new Map<string, SessionEntry>()
  private turn: number | undefined

  private put(entry: SessionEntry): void {
    const previous = this.entries.get(entry.id)
    const next = { ...entry, seq: previous?.seq ?? entry.seq }
    if (JSON.stringify(previous) === JSON.stringify(next)) return
    this.entries.set(next.id, next)
    this.changed.set(next.id, next)
  }

  apply(event: MirrorEvent, fallbackSeq: number): void {
    const d = event.data
    const seq = event.seq ?? fallbackSeq
    const turn = number(d.turn) ?? this.turn
    const step = number(d.step)
    const prefix = `assistant:${turn}:${step}`
    if (event.type === 'turn/start') this.turn = number(d.turn)
    // 压缩后的模型专用替换不是第二条用户可见消息。
    if (typeof event.surfaceOp === 'object' && event.surfaceOp?.op === 'replace') return
    if (event.type === 'user/message') {
      // 只把真人输入铺成对话气泡：运行时上下文/时间块等注入消息在网页端是折叠的，
      // 宠物里也不该把它们当作用户说过的话铺出来。
      const sourceKind = text(record(d.source).kind)
      if (sourceKind !== '' && sourceKind !== 'user') return
      this.put({ id: `user:${text(d.id) || seq}`, seq, turn, role: 'user', kind: 'text', text: visible(d.content), streaming: false })
    } else if (event.type === 'assistant/chunk' && turn !== undefined && step !== undefined) {
      const chunk = record(d.chunk)
      const kind = chunk.type === 'text-delta' ? 'text' : chunk.type === 'reasoning-delta' ? 'think' : null
      if (kind && typeof chunk.text === 'string') {
        const id = `${prefix}:${kind}`
        this.put({ id, seq, turn, role: 'assistant', kind, text: (this.entries.get(id)?.text ?? '') + chunk.text, streaming: true })
      }
      if (chunk.type === 'finish') this.finish(turn, prefix)
    } else if (event.type === 'assistant/message' && turn !== undefined && step !== undefined) {
      const blocks = list(record(d.message).content).map(record)
      const kinds = new Set<'text' | 'think'>()
      for (const block of blocks) {
        if (block.type === 'text') kinds.add('text')
        if (block.type === 'reasoning') kinds.add('think')
      }
      kinds.add('text'); kinds.add('think')
      for (const kind of kinds) {
        const body = blocks.filter(block => block.type === (kind === 'text' ? 'text' : 'reasoning')).map(block => text(block.text)).join('')
        const id = `${prefix}:${kind}`
        if (body || this.entries.has(id)) this.put({ id, seq, turn, role: 'assistant', kind, text: body, streaming: false,
          ...(d.interrupted ? { status: 'interrupted' } : {}) })
      }
    } else if (event.type === 'tool/call') {
      this.put({ id: `tool:${turn}:${text(d.callId) || seq}`, seq, turn, role: 'assistant', kind: 'tool',
        name: text(d.name), text: text(d.arguments), status: 'running', streaming: true })
    } else if (event.type === 'tool/result') {
      for (const block of list(record(d.message).content).map(record)) {
        if (block.type !== 'tool-result') continue
        const id = `tool:${turn}:${text(block.toolCallId)}`
        const previous = this.entries.get(id)
        this.put({ id, seq, turn, role: 'assistant', kind: 'tool', text: previous?.text ?? '', name: previous?.name,
          result: visible(block.content), status: block.isError || d.error ? 'error' : 'completed', streaming: false })
      }
    } else if (event.type === 'turn/end') {
      this.finish(turn, undefined, text(record(d.reason).kind))
      this.turn = undefined
    } else if (event.type === 'command/done' && typeof d.text === 'string') {
      this.put({ id: `command:${text(d.commandId) || seq}`, seq, role: 'system', kind: 'text', text: d.text, status: text(d.kind), streaming: false })
    }
  }

  private finish(turn: number | undefined, prefix?: string, status?: string): void {
    for (const entry of this.entries.values()) {
      if (entry.turn === turn && entry.streaming && (!prefix || entry.id.startsWith(`${prefix}:`))) {
        this.put({ ...entry, streaming: false, ...(status ? { status } : {}) })
      }
    }
  }

  drain(): SessionEntry[] {
    const changed = [...this.changed.values()]
    this.changed.clear()
    return changed
  }

  values(): SessionEntry[] {
    return [...this.entries.values()].sort((a, b) => a.seq - b.seq)
  }
}

interface Presets {
  names: readonly string[]
  optionOf(value: string): { value: string; name: string }
  current(events: readonly MirrorEvent[]): string
}
interface Commands {
  find(agent: BridgeAgent, name: string): unknown
  execute(agent: BridgeAgent, line: string, images: never[], signal: AbortSignal): Promise<{
    result: { kind: 'success' | 'error'; text?: string }
  } | undefined>
}
interface Projections { snapshot(session: BridgeAgent['session']): { values: RecordValue } }
interface LlmLike {
  listProviders?: () => readonly { id: string; name?: string }[]
  listModels?: (provider: string) => Promise<readonly { provider?: string; id?: string; name?: string }[]>
}

const MODEL_CACHE_MS = 5_000
const PAGE_MESSAGES = 50
const stale = (): SessionResult => ({ ok: false, error: '会话绑定已变化，旧请求结果已丢弃；不会自动重发' })

/**
 * 只适配已安装宿主的服务；最小测试 agent 没有服务时不伪造原生能力或运行态。
 *
 * 0.2.x 起宿主不再给插件提供 `apiProxy` 会话 RPC：历史分页直接读会话事件日志，
 * 输入与停止直接走 live agent 的 followup / cancel，模型目录走 `ctx.llm`。
 */
export class SessionMirror {
  readonly bindingId = randomUUID()
  readonly projection = new SessionProjection()
  private active = true
  private cursor = 0
  private status: SessionSnapshot['status'] = 'disconnected'
  private title = ''
  private model: SessionModel | null = null
  private models: SessionModel[] = []
  private modelError: string | undefined
  private modelsAt = -Infinity
  private modelRevision = 0
  private modelsPending: Promise<void> | null = null
  private metadataKey = ''
  private first = true
  private hasMore = false
  private beforeSeq: number | undefined
  private readonly agent: BridgeAgent | null
  private readonly publish: (update: SessionUpdate) => void

  constructor(agent: BridgeAgent | null, publish: (update: SessionUpdate) => void) {
    this.agent = agent
    this.publish = publish
    this.setStatus(agent?.status)
  }

  close(): void { this.active = false }
  isActive(): boolean { return this.active }
  setStatus(status: unknown): void {
    this.status = status === 'idle' || status === 'running' || status === 'waiting' ? status : 'disconnected'
  }

  private service<T>(name: string): T | undefined { return this.agent?.ctx?.get(name) as T | undefined }
  private sessionId(): string | null { return this.agent?.session.id ?? this.agent?.id ?? null }
  private sessionEvents(): readonly MirrorEvent[] | undefined { return this.agent ? eventsOf(this.agent) : undefined }

  observe(event: MirrorEvent, index: number): void {
    this.projection.apply(event, index)
    if (event.type === 'session/title') this.title = text(event.data.title)
    if (event.type === 'request/header') this.modelsAt = -Infinity
  }

  private metadata(): Omit<SessionSnapshot, 'entries'> {
    const presets = this.service<Presets>('permissionPresets')
    const commands = this.service<Commands>('commands')
    const llm = this.service<LlmLike>('llm')
    const projected = record(this.agent && this.service<Projections>('sessionProjections')?.snapshot(this.agent.session).values.permissions)
    const permissions = projected.options ? list(projected.options).map(record).map(option => ({ value: text(option.value), label: text(option.name) }))
      : (presets?.names ?? []).map(value => { const option = presets!.optionOf(value); return { value: option.value, label: option.name } })
    const events = this.sessionEvents()
    const permission = text(projected.currentValue) || (this.agent && presets?.current(events ?? [])) || null
    const available = this.active && this.sessionId() !== null
    const agent = this.agent as { followup?: unknown; cancel?: unknown } | null
    return {
      sessionId: this.sessionId(), bindingId: this.bindingId, cursor: this.cursor, title: this.title,
      status: this.active ? this.status : 'disconnected', hasMore: this.hasMore, beforeSeq: this.beforeSeq,
      model: this.model, models: this.models, permissions, permission,
      capabilities: {
        prompt: available && typeof agent?.followup === 'function',
        cancel: available && typeof agent?.cancel === 'function',
        history: available,
        models: available && !!llm,
        permissions: available && !!presets && !!commands?.find(this.agent!, 'permission'),
      },
      ...(this.modelError ? { error: this.modelError } : {}),
    }
  }

  flush(): void {
    if (!this.active) return
    const entries = this.projection.drain()
    const metadata = this.metadata()
    const key = JSON.stringify({ ...metadata, cursor: 0 })
    if (entries.length || key !== this.metadataKey || this.first) {
      this.metadataKey = key
      this.cursor += 1
      // 换绑只宣告重新基线，不把整份旧日志塞进 ring；客户端收到 reset 后读取最近完整页。
      this.publish({ ...metadata, cursor: this.cursor, entries: this.first ? [] : entries, ...(this.first ? { reset: true } : {}) })
      this.first = false
    }
    void this.refreshModels()
  }

  /** 会话历史分页：0.2.x 没有 apiProxy，宿主把会话事件日志直接交给插件。 */
  private historyPage(beforeSeq: number | undefined): { events: Array<{ event: MirrorEvent }>; hasMore: boolean } {
    const all = this.sessionEvents() ?? []
    const withSeq = all.filter((event): event is MirrorEvent & { seq: number } => typeof event.seq === 'number')
    const older = beforeSeq === undefined ? withSeq : withSeq.filter(event => event.seq < beforeSeq)
    const page = older.slice(-PAGE_MESSAGES)
    return { events: page.map(event => ({ event })), hasMore: older.length > PAGE_MESSAGES }
  }

  private asModel(value: unknown): SessionModel | null {
    const model = record(value)
    if (!text(model.provider) || !text(model.model)) return null
    return { provider: text(model.provider), model: text(model.model),
      label: this.models.find(item => item.provider === model.provider && item.model === model.model)?.label ?? text(model.model),
      ...(typeof model.reasoningEffort === 'string' ? { reasoningEffort: model.reasoningEffort } : {}) }
  }

  private refreshModels(): Promise<void> {
    if (this.modelsPending) return this.modelsPending
    if (!this.active || !this.sessionId() || Date.now() - this.modelsAt < MODEL_CACHE_MS) return Promise.resolve()
    this.modelsAt = Date.now()
    const revision = this.modelRevision
    const llm = this.service<LlmLike>('llm')
    this.modelsPending = (async () => {
      if (llm?.listProviders && llm.listModels) {
        const groups = await Promise.all(llm.listProviders().map(async provider => ({
          id: provider.id,
          models: await llm.listModels!(provider.id).catch(() => []),
        })))
        if (!this.active || revision !== this.modelRevision) return
        this.models = groups.flatMap(group => group.models.map(model => ({
          provider: group.id, model: text(model.id), label: text(model.name) || text(model.id),
        })))
      }
      // 当前模型取自 live agent 的 options；列不出目录也要如实显示它。
      const options = (this.agent as { options?: RecordValue } | null)?.options
      if (options && typeof options.provider === 'string' && typeof options.model === 'string') {
        this.model = this.asModel(options)
      }
      this.modelError = undefined
    })().catch(error => {
      if (this.active && revision === this.modelRevision) this.modelError = String(error instanceof Error ? error.message : error)
    }).finally(() => { this.modelsPending = null; if (this.active) this.flush() })
    return this.modelsPending
  }

  async snapshot(beforeSeq: number | undefined, bindingId: string | undefined, refresh: () => void): Promise<SessionResult> {
    if (!this.active || (bindingId !== undefined && bindingId !== this.bindingId)) return stale()
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0 || !bindingId)) {
      return { ok: false, error: '历史分页必须提供有效 beforeSeq 和 bindingId' }
    }
    try {
      let page: { events: Array<{ event: MirrorEvent }>; hasMore: boolean } | undefined
      if (this.metadata().capabilities.history) page = this.historyPage(beforeSeq)
      else if (beforeSeq !== undefined) return { ok: false, error: '宿主历史分页不可用' }
      await this.refreshModels()
      if (!this.active) return stale()
      refresh()
      const raw = list(page?.events).map(item => record(record(item).event))
      const seqs = raw.map(item => number(item.seq)).filter((seq): seq is number => seq !== undefined)
      const low = seqs.length ? seqs.reduce((a, b) => Math.min(a, b)) : undefined
      const high = seqs.length ? seqs.reduce((a, b) => Math.max(a, b)) : -1
      let entries = this.projection.values()
      if (page) entries = entries.filter(entry => (low !== undefined && entry.seq >= low && (beforeSeq === undefined || entry.seq <= high))
        || (beforeSeq === undefined && entry.seq > high))
      if (beforeSeq === undefined) {
        this.hasMore = page?.hasMore === true
        this.beforeSeq = low
        this.flush()
      }
      return { ok: true, state: { ...this.metadata(), entries, hasMore: page?.hasMore === true, beforeSeq: low } }
    } catch (error) {
      return this.active ? { ok: false, error: error instanceof Error ? error.message : String(error) } : stale()
    }
  }

  private async slash(line: string): Promise<void> {
    const commands = this.service<Commands>('commands')
    if (!commands || !this.agent) throw new Error('宿主原生命令服务不可用，未将斜杠命令发送给模型')
    const execution = await commands.execute(this.agent, line, [], AbortSignal.timeout(30_000))
    if (!execution) throw new Error('宿主不认识该斜杠命令')
    if (execution.result.kind !== 'success') throw new Error(execution.result.text || '宿主命令失败')
  }

  async command(input: unknown, refresh: () => void): Promise<SessionResult> {
    const value = record(input)
    if (!this.active || value.bindingId !== this.bindingId) return stale()
    try {
      const capabilities = this.metadata().capabilities
      switch (value.kind) {
        case 'prompt': {
          if (!capabilities.prompt) throw new Error('宿主原生输入不可用')
          if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 60_000) throw new Error('输入不能为空或超过长度限制')
          // SessionResult 没有语音关联身份字段；禁止接收后让调用方猜最后一条输出。
          if (value.spoken === true) throw new Error('原生会话暂不提供语音归属，请使用已有 chat 语音通道')
          if (value.spoken !== undefined && typeof value.spoken !== 'boolean') throw new Error('spoken 必须是布尔值')
          const body = value.text.trim()
          if (body.startsWith('/')) await this.slash(body)
          else (this.agent as { followup: (message: unknown) => void } | null)!.followup(createUserMessage({
            content: [{ type: 'text', text: value.text }],
            // 宠物面板输入的就是用户本人的话，不能伪装成插件注入的上下文。
            source: { kind: 'user' },
          }))
          break
        }
        case 'cancel': {
          if (!capabilities.cancel) throw new Error('宿主停止能力不可用')
          ;(this.agent as unknown as { cancel: (cause: unknown) => void }).cancel({ kind: 'user' })
          break
        }
        case 'model': {
          // 0.2.x 宿主没有面向插件的运行时模型切换接口：如实拒绝，让用户去应用设置里换。
          throw new Error('当前宿主不支持从宠物侧切换模型，请在应用的模型设置里切换')
        }
        case 'permission': {
          if (!capabilities.permissions) throw new Error('宿主权限切换不可用')
          const presets = this.service<Presets>('permissionPresets')!
          if (typeof value.value !== 'string' || !presets.names.includes(value.value)) throw new Error('未知的权限选项')
          await this.slash(`/permission ${value.value}`)
          break
        }
        default: throw new Error('未知的会话命令')
      }
      if (!this.active) return stale()
      refresh()
      this.flush()
      return { ok: true }
    } catch (error) {
      return this.active ? { ok: false, error: error instanceof Error ? error.message : String(error) } : stale()
    }
  }
}
