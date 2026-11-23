import { randomUUID } from 'node:crypto'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
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
  private readonly provisional = new Set<string>()
  private readonly removed = new Set<string>()
  private turn: number | undefined

  private put(entry: SessionEntry, provisional = false): void {
    if (provisional) this.provisional.add(entry.id)
    else this.provisional.delete(entry.id)
    this.removed.delete(entry.id)
    const previous = this.entries.get(entry.id)
    const next: SessionEntry = { ...entry, seq: previous?.seq ?? entry.seq, ...(provisional ? { provisional: true } : {}) }
    if (JSON.stringify(previous) === JSON.stringify(next)) return
    this.entries.set(next.id, next)
    this.changed.set(next.id, next)
  }

  private remove(id: string): void {
    this.provisional.delete(id)
    if (!this.entries.delete(id)) return
    this.changed.delete(id)
    this.removed.add(id)
  }

  discardLive(): void { for (const id of this.provisional) this.remove(id) }

  chunk(turn: number, step: number, seq: number, chunk: RecordValue, provisional = false): void {
    const kind = chunk.type === 'text-delta' ? 'text' : chunk.type === 'reasoning-delta' ? 'think' : null
    const part = text(chunk.text)
    if (kind && part) {
      const id = `assistant:${turn}:${step}:${kind}`
      this.put({ id, seq, turn, role: 'assistant', kind, text: (this.entries.get(id)?.text ?? '') + part, streaming: true }, provisional)
    } else if (provisional && chunk.type === 'tool-call-delta' && text(chunk.id)) {
      const id = `tool:${turn}:${text(chunk.id)}`
      const old = this.entries.get(id)
      this.put({ id, seq, turn, role: 'assistant', kind: 'tool', name: text(chunk.name) || old?.name,
        text: (old?.text ?? '') + text(chunk.argumentsDelta), status: 'preparing', streaming: true }, true)
    }
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
      this.chunk(turn, step, seq, chunk)
      if (chunk.type === 'finish') this.finish(turn, prefix)
    } else if (event.type === 'assistant/message' && turn !== undefined && step !== undefined) {
      const blocks = list(record(d.message).content).map(record)
      for (const kind of ['think', 'text'] as const) {
        const body = blocks.filter(block => block.type === (kind === 'text' ? 'text' : 'reasoning')).map(block => text(block.text)).join('')
        const id = `${prefix}:${kind}`
        if (body) this.put({ id, seq, turn, role: 'assistant', kind, text: body, streaming: false,
          ...(d.interrupted ? { status: 'interrupted' } : {}) })
        else this.remove(id)
      }
      for (const block of blocks) {
        const callId = text(block.id)
        if (block.type !== 'tool-call' || !callId) continue
        this.put({ id: `tool:${turn}:${callId}`, seq, turn, role: 'assistant', kind: 'tool', name: text(block.name),
          text: text(block.arguments), status: 'pending', streaming: true })
      }
    } else if (event.type === 'tool/call') {
      this.put({ id: `tool:${turn}:${text(d.callId) || seq}`, seq, turn, role: 'assistant', kind: 'tool',
        name: text(d.name), text: text(d.arguments), status: 'running', streaming: true })
    } else if (event.type === 'tool/result') {
      const message = record(d.message)
      const applyResult = (result: RecordValue) => {
        const callId = text(result.toolCallId)
        if (!callId) return
        const id = `tool:${turn}:${callId}`
        const previous = this.entries.get(id)
        this.put({ id, seq, turn, role: 'assistant', kind: 'tool', text: previous?.text ?? '', name: previous?.name,
          result: visible(result.content), status: result.isError || d.error ? 'error' : 'completed', streaming: false })
      }
      // 新宿主是独立的 tool 消息；旧宿主把回执放在 tool-result 块中。
      if (text(message.toolCallId)) applyResult(message)
      else for (const block of list(message.content).map(record)) {
        if (block.type === 'tool-result') applyResult(block)
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
        if (this.provisional.has(entry.id)) this.remove(entry.id)
        else this.put({ ...entry, streaming: false, ...(status ? { status: entry.kind === 'tool' && status === 'completed' ? 'no-result' : status } : {}) })
      }
    }
  }

  drainRemoved(): string[] {
    const removed = [...this.removed]
    this.removed.clear()
    return removed
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
  resolveCallConfig?: (selection: ModelChoice) => Promise<unknown>
}
type ModelChoice = Pick<SessionModel, 'provider' | 'model' | 'reasoningEffort'>
interface SessionControllerLike {
  selectModel?: (request: ModelChoice & { sessionId: string }) => Promise<unknown>
}
interface AgentModelLike { current?: () => ModelChoice | undefined; select?: (selection: ModelChoice) => void }

const MODEL_CACHE_MS = 5_000
const PAGE_MESSAGES = 50
const stale = (): SessionResult => ({ ok: false, error: '会话绑定已变化，旧请求结果已丢弃；不会自动重发' })

/**
 * 只适配已安装宿主的服务；最小测试 agent 没有服务时不伪造原生能力或运行态。
 *
 * 历史读会话日志，进行中的内容读宿主独立流。模型使用原生会话控制器，
 * 没有控制器的宿主可走 Agent 自己的持久模型选择，但仍需校验目录与路由。
 */
export class SessionMirror {
  readonly bindingId = randomUUID()
  readonly projection = new SessionProjection()
  private active = true
  private cursor = 0
  private status: SessionSnapshot['status'] = 'disconnected'
  private title = ''
  /** 仅为还没有 Agent.model.current() 的控制器兼容快照。 */
  private modelSelected: SessionModel | null = null
  private models: SessionModel[] = []
  private modelError: string | undefined
  private modelsAt = -Infinity
  private modelsPending: Promise<void> | null = null
  private stream: { id: string; turn: number; step: number; seq: number; index: number } | null = null
  private streamRevision = -1
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
  private nativeModel(): AgentModelLike | undefined { return (this.agent as { model?: AgentModelLike } | null)?.model }

  /** 片段不入宿主日志；等下一拍发布，同一步正式消息仍以宿主日志为准。 */
  observeStream(frame: AssistantStreamFrame, seq: number): void {
    if (frame.type === 'start') {
      if (frame.revision <= this.streamRevision) return
      this.streamRevision = frame.revision
      this.projection.discardLive()
      this.stream = { id: frame.attemptId, turn: frame.turn, step: frame.step, seq, index: -1 }
      return
    }
    const stream = this.stream
    if (!stream || stream.id !== frame.attemptId) return
    if (frame.type === 'end') {
      // Bridge 已扫描先于终止帧提交的正式日志。余下的条目是失败重试或没有提交的预览。
      this.projection.discardLive()
      this.stream = null
    } else if (frame.index > stream.index) {
      stream.index = frame.index
      this.projection.chunk(stream.turn, stream.step, stream.seq, record(frame.chunk), true)
    }
  }

  observe(event: MirrorEvent, index: number): void {
    if (event.type === 'assistant/chunk' && this.stream && event.data.turn === this.stream.turn && event.data.step === this.stream.step) return
    this.projection.apply(event, index)
    if (event.type === 'session/title') this.title = text(event.data.title)
    if (event.type === 'request/header') {
      this.modelsAt = -Infinity
      // 宿主已经带着新选择发出请求：以宿主写回的值/目录为准，不再用本地临时覆盖。
      this.modelSelected = null
    }
  }

  private canSelectNativeModel(): boolean {
    const model = this.nativeModel()
    const llm = this.service<LlmLike>('llm')
    return typeof model?.current === 'function' && typeof model.select === 'function'
      && typeof llm?.listModels === 'function' && typeof llm.resolveCallConfig === 'function'
  }

  private currentModel(): SessionModel | null {
    const header = (this.agent as { session?: { requestHeader?: () => { config?: RecordValue } | undefined } } | null)
      ?.session?.requestHeader?.()?.config
    const options = (this.agent as { options?: RecordValue } | null)?.options
    return this.asModel(this.nativeModel()?.current?.()) ?? this.modelSelected ?? this.asModel(header) ?? this.asModel(options)
  }

  private metadata(): Omit<SessionSnapshot, 'entries'> {
    const presets = this.service<Presets>('permissionPresets')
    const commands = this.service<Commands>('commands')
    const projected = record(this.agent && this.service<Projections>('sessionProjections')?.snapshot(this.agent.session).values.permissions)
    const permissions = projected.options ? list(projected.options).map(record).map(option => ({ value: text(option.value), label: text(option.name) }))
      : (presets?.names ?? []).map(value => { const option = presets!.optionOf(value); return { value: option.value, label: option.name } })
    const events = this.sessionEvents()
    const permission = text(projected.currentValue) || (this.agent && presets?.current(events ?? [])) || null
    const available = this.active && this.sessionId() !== null
    const agent = this.agent as { followup?: unknown; cancel?: unknown } | null
    const controller = this.service<SessionControllerLike>('sessionController')
    return {
      sessionId: this.sessionId(), bindingId: this.bindingId, cursor: this.cursor, title: this.title,
      status: this.active ? this.status : 'disconnected', hasMore: this.hasMore, beforeSeq: this.beforeSeq,
      model: this.currentModel(), models: this.models, permissions, permission,
      capabilities: {
        prompt: available && typeof agent?.followup === 'function',
        cancel: available && typeof agent?.cancel === 'function',
        history: available,
        models: available && (typeof controller?.selectModel === 'function' || this.canSelectNativeModel()),
        permissions: available && !!presets && !!commands?.find(this.agent!, 'permission'),
      },
      ...(this.modelError ? { error: this.modelError } : {}),
    }
  }

  flush(): void {
    if (!this.active) return
    const entries = this.projection.drain()
    const removedEntryIds = this.projection.drainRemoved()
    const metadata = this.metadata()
    const key = JSON.stringify({ ...metadata, cursor: 0 })
    if (entries.length || removedEntryIds.length || key !== this.metadataKey || this.first) {
      this.metadataKey = key
      this.cursor += 1
      // 换绑只宣告重新基线，不把整份旧日志塞进 ring；客户端收到 reset 后读取最近完整页。
      this.publish({ ...metadata, cursor: this.cursor, entries: this.first ? [] : entries,
        ...(this.first ? { reset: true } : removedEntryIds.length ? { removedEntryIds } : {}) })
      this.first = false
    }
    void this.refreshModels()
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
    const llm = this.service<LlmLike>('llm')
    this.modelsPending = (async () => {
      if (llm?.listProviders && llm.listModels) {
        const groups = await Promise.all(llm.listProviders().map(async provider => {
          try { return { id: provider.id, models: await llm.listModels!(provider.id), failed: false } }
          catch { return { id: provider.id, models: [], failed: true } }
        }))
        if (!this.active) return
        this.models = groups.flatMap(group => group.models.map(model => ({
          provider: group.id, model: text(model.id), label: text(model.name) || text(model.id),
        })))
        this.modelError = groups.some(group => group.failed) ? '部分模型目录读取失败，请检查宿主配置' : undefined
      } else {
        this.modelError = undefined
      }
    })().catch(() => {
      if (this.active) this.modelError = '模型目录读取失败，请检查宿主配置'
    }).finally(() => { this.modelsPending = null; if (this.active) this.flush() })
    return this.modelsPending
  }

  async snapshot(beforeSeq: number | undefined, bindingId: string | undefined, refresh: () => void): Promise<SessionResult> {
    if (!this.active || (bindingId !== undefined && bindingId !== this.bindingId)) return stale()
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0 || !bindingId)) {
      return { ok: false, error: '历史分页必须提供有效 beforeSeq 和 bindingId' }
    }
    try {
      const history = this.metadata().capabilities.history
      if (!history && beforeSeq !== undefined) return { ok: false, error: '宿主历史分页不可用' }
      await this.refreshModels()
      if (!this.active) return stale()
      refresh()
      // ponytail: 复用已有完整投影分页；超大会话需要宿主提供真正的分段历史接口。
      const all = this.projection.values().filter(entry => beforeSeq === undefined || entry.seq < beforeSeq)
      let start = history ? Math.max(0, all.length - PAGE_MESSAGES) : 0
      // 同一事件可能投影出思考和正文；不能把相同序号拆到两页而漏掉其中一条。
      while (start > 0 && all[start - 1].seq === all[start].seq) start--
      const entries = all.slice(start)
      const low = entries[0]?.seq
      const hasMore = start > 0
      if (beforeSeq === undefined) {
        this.hasMore = hasMore
        this.beforeSeq = low
        this.flush()
      }
      return { ok: true, state: { ...this.metadata(), entries, hasMore, beforeSeq: low } }
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
          ;(this.agent as unknown as { cancel: (cause: unknown, options: { keepInbox: boolean }) => void })
            .cancel({ kind: 'user' }, { keepInbox: true })
          break
        }
        case 'model': {
          const controller = this.service<SessionControllerLike>('sessionController')
          if (!capabilities.models) throw new Error('当前 DSH 宿主未提供会话模型切换接口，请在 DSH 的会话里切换')
          if (typeof value.provider !== 'string' || typeof value.model !== 'string'
            || !value.provider.trim() || !value.model.trim()
            || value.provider.length > 128 || value.model.length > 256) throw new Error('模型参数无效')
          const sessionId = this.sessionId()
          if (sessionId === null) throw new Error('会话还未就绪，不能切换模型')
          const reasoningEffort = typeof value.reasoningEffort === 'string' && value.reasoningEffort.length <= 64
            ? value.reasoningEffort : undefined
          const selection = { provider: value.provider.trim(), model: value.model.trim(),
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
          if (typeof controller?.selectModel === 'function') {
            const result = await controller.selectModel({ sessionId, ...selection })
            this.modelSelected = this.asModel(record(result).selected) ?? this.asModel(selection)
          } else {
            const llm = this.service<LlmLike>('llm')!
            try {
              if (!(await llm.listModels!(selection.provider)).some(model => model.id === selection.model)) throw new Error('目录无该模型')
              await llm.resolveCallConfig!(selection)
            } catch { throw new Error('所选模型目前不可用，请在 DSH 核对模型配置') }
            if (!this.active) return stale()
            this.nativeModel()!.select!(selection)
          }
          break
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
