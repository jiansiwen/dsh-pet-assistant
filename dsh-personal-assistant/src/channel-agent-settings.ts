import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AssistantAgentSettings } from './assistant-settings.ts'

/** 必须传入 agents.create 的 setup 收到的原始 agentCtx，而不是全局上下文。 */
export type ChannelAgentContext = Pick<Context, 'on' | 'systemPrompt'>

type Attempt = { revision: number; usage?: TokenUsage; settled: boolean }
type Turn = {
  number: number
  settings?: Readonly<AssistantAgentSettings>
  error?: Error
  used: number
  unknown: boolean
  pending?: true | Attempt
  attempts: Map<string, Attempt>
}

/** SDK 的输入、缓存读、缓存写、输出互不重叠；推理用量不能再次叠加到输出。 */
function tokens(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined
  const parts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0]
  if (parts.some(value => !Number.isSafeInteger(value) || value < 0)) return undefined
  const sum = parts.reduce((total, value) => total + value, 0)
  if (!Number.isSafeInteger(sum)) return undefined
  if (usage.totalTokens === undefined) return sum
  return Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= sum ? usage.totalTokens : undefined
}

/**
 * 仅组合渠道 agent 的局部钩子；调用方负责在 agents.create.setup 内调用。
 * turn/start 先于首步组装，故在此快照，避免首步系统提示词读到上一轮设置。
 * SDK 的 usage 分片是整次请求的快照，finish 才结算；缺失终止分片也禁止续跑。
 * 预算是事后累计与续跑门禁，不是输入加输出的硬上限；从不调用 agent.cancel。
 */
export function configureChannelAgent(
  ctx: ChannelAgentContext,
  settings: () => AssistantAgentSettings,
  defaultModel: () => { provider: string; model: string } | null,
): void {
  if (!ctx.systemPrompt?.section || !ctx.systemPrompt?.variable) {
    throw new Error('宿主缺少系统提示词注册通道，无法应用渠道智能体设置')
  }
  let owner: Agent | undefined
  let turn: Turn | undefined
  const owns = (agent: Agent | undefined): boolean => agent?.ctx === ctx

  // 创建公告发生在 setup 之后、首轮之前。显式比较上下文，排除子作用域事件。
  ctx.on('agent/created', ({ agent }) => {
    if (owns(agent)) owner = agent
    return undefined
  })
  ctx.on('session/event', (session, event) => {
    if (session !== owner?.session) return
    if (event.type === 'turn/end') {
      if (turn?.number === event.data.turn) turn = undefined
      return
    }
    if (event.type !== 'turn/start' || turn?.number === event.data.turn) return
    const current: Turn = { number: event.data.turn, used: 0, unknown: false, attempts: new Map() }
    turn = current
    try {
      const snapshot = { ...settings() }
      if (!snapshot.provider || !snapshot.model) {
        const fallback = defaultModel()
        if (!fallback?.provider || !fallback.model) throw new Error('默认模型不可用，请配置渠道智能体的提供方和模型')
        snapshot.provider ||= fallback.provider
        snapshot.model ||= fallback.model
      }
      current.settings = Object.freeze(snapshot)
    } catch (error) {
      // 通知型钩子的异常会被宿主吞入诊断；保留失败，交给有返回值的组装/请求钩子展示。
      current.error = error instanceof Error ? error : new Error('无法读取渠道智能体设置')
    }
  })

  function snapshot(): Readonly<AssistantAgentSettings> {
    if (turn?.error) throw turn.error
    if (!turn?.settings) throw new Error('渠道智能体尚未建立本轮设置快照')
    return turn.settings
  }
  ctx.systemPrompt.variable('channel_assistant_name', ({ agent }) => owns(agent) && turn ? snapshot().name : '')
  ctx.systemPrompt.variable('channel_assistant_persona', ({ agent }) => owns(agent) && turn ? snapshot().persona : '')
  ctx.systemPrompt.section({
    name: 'personal-assistant:channel-agent',
    order: 160,
    text: ({ agent }) => owns(agent) && turn
      ? '## 本渠道智能体\n名称：{{channel_assistant_name}}\n职责：{{channel_assistant_persona}}'
      : '',
  })

  function currentTurn(number: number): Turn {
    snapshot()
    if (!turn || turn.number !== number) throw new Error('渠道智能体请求与当前轮次不一致')
    return turn
  }
  function blocked(current: Turn): string | undefined {
    const budget = current.settings!.tokenBudget
    if (budget === 0) return undefined
    if (current.unknown || current.pending) return '本轮模型用量未知，已禁止继续请求；请开始新一轮'
    if (current.used >= budget) return '本轮智能体 Token 预算已用完，已禁止继续请求；请开始新一轮'
    return undefined
  }

  ctx.on('agent/pre-step', async ({ agent, turn: number }, next) => {
    if (!owns(agent)) return next()
    const current = currentTurn(number)
    if (blocked(current)) return { kind: 'reject' }
    return next()
  }, { prepend: true })

  ctx.on('agent/request', async ({ agent, turn: number }, next) => {
    if (!owns(agent)) return next()
    const current = currentTurn(number)
    const check = (): void => {
      if (turn !== current) throw new Error('渠道智能体轮次已结束，拒绝旧请求')
      const reason = blocked(current)
      if (reason) throw new Error(reason)
    }
    check()
    const config = await next()
    check()
    const selected = current.settings!
    const remaining = selected.tokenBudget === 0 ? selected.maxTokens : selected.tokenBudget - current.used
    current.pending = true
    return { ...config, provider: selected.provider, model: selected.model, maxTokens: Math.min(selected.maxTokens, remaining) }
  }, { prepend: true })

  // 错误重试不经过 pre-step；既在这里拒绝恢复，也在每次 request 中再次检查。
  ctx.on('agent/request-error', async ({ agent, turn: number }, next) => {
    if (!owns(agent)) return next()
    const reason = blocked(currentTurn(number))
    if (reason) throw new Error(reason)
    return next()
  }, { prepend: true })

  function settle(current: Turn, attempt: Attempt, finished: boolean): void {
    if (attempt.settled) return
    attempt.settled = true
    const count = tokens(attempt.usage)
    if (count !== undefined) current.used += count
    if (!finished || count === undefined || !Number.isSafeInteger(current.used)) current.unknown = true
    if (current.pending === attempt) current.pending = undefined
  }

  function stream(current: Turn, frame: AssistantStreamFrame): void {
    if (frame.type === 'start') {
      if (frame.turn !== current.number || current.attempts.has(frame.attemptId)) return
      const attempt: Attempt = { revision: frame.revision, settled: false }
      current.attempts.set(frame.attemptId, attempt)
      if (current.pending !== true) current.unknown = true
      current.pending = attempt
      return
    }
    const attempt = current.attempts.get(frame.attemptId)
    if (!attempt || attempt.revision !== frame.revision || attempt.settled) return
    if (frame.type === 'end') {
      settle(current, attempt, false)
    } else if (frame.chunk.type === 'usage') {
      // 同一 attempt 可能报告多次累计快照，取最后一份，不逐个相加。
      attempt.usage = { ...frame.chunk.usage }
    } else if (frame.chunk.type === 'finish') {
      settle(current, attempt, true)
    }
  }
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (owns(agent) && turn) stream(turn, frame)
  })
  // 异常只标记本轮，不清零；新轮的 turn/start 才建立新的计量状态。
  ctx.on('agent/error', ({ agent, turn: number }) => {
    if (owns(agent) && turn?.number === number && turn.pending) turn.unknown = true
  })
}
