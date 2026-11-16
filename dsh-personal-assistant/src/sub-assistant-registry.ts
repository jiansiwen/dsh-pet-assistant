/**
 * 子助理会话注册表：每个子助理一个会话，统一 LRU 与空闲淘汰。
 *
 * - platform：会话 = PlatformAgent（无状态）+ 消息历史（system 由人设+协议约定拼接）；
 *   只有成功回执才入历史——失败（timeout/error）当次不存在，便于重试。
 * - local-cli：会话 = 常驻 CliAgent 子进程，上下文由工具自身维护，本层不拼接历史。
 *
 * 会话失效三条路（设计 4.4）：
 * 1. 空闲超时（idleTtlMs，默认 480s）周期回收；
 * 2. 超过上限（maxSessions，默认 8）LRU 淘汰最旧；
 * 3. 绑定变化（kind/binding 任一不同）即刻弃会话——旧会话对不上新绑定，不可信。
 */
import type { LocalCliBinding, MemberProfile, PlatformBinding } from './member-contract.ts'
import { CliAgent } from './cli-agent.ts'
import { PlatformAgent } from './platform-agent.ts'
import { SUB_ASSISTANT_PROTOCOL_PROMPT, type SubAssistantMessage, type SubAssistantReceipt } from './sub-assistant-protocol.ts'

export interface SubAssistantRegistryOptions {
  readonly idleTtlMs: number
  readonly maxSessions: number
  readonly resolveKey: (secretId: string) => string
  /** 测试可注入时钟；缺省用 Date.now。 */
  readonly now?: () => number
}

interface SubAssistantSession {
  readonly kind: 'platform' | 'local-cli'
  readonly bindingKey: string
  readonly agent: PlatformAgent | CliAgent
  /** platform 消息历史（不含 system）；失败回执不入史。 */
  messages: SubAssistantMessage[]
  lastUsedAt: number
}

export class SubAssistantRegistry {
  private readonly sessions = new Map<string, SubAssistantSession>()
  private readonly options: SubAssistantRegistryOptions

  constructor(options: SubAssistantRegistryOptions) {
    if (!Number.isSafeInteger(options.idleTtlMs) || options.idleTtlMs < 60_000
      || !Number.isSafeInteger(options.maxSessions) || options.maxSessions < 1) {
      throw new Error('子助理会话参数无效（空闲时长下限 60s，会话数下限 1）')
    }
    this.options = options
  }

  sessionCount(): number {
    return this.sessions.size
  }

  /** 一次子助理任务往返：自动建立/刷新会话，绑定变化即弃旧会话。 */
  async send(member: MemberProfile, task: string, timeoutMs: number): Promise<SubAssistantReceipt> {
    if (member.kind === 'expert' || member.binding === null) {
      return { kind: 'error', text: '普通成员不经子助理通道分派' }
    }
    const bindingKey = JSON.stringify([member.kind, member.binding])
    const existing = this.sessions.get(member.assistantId)
    if (existing && (existing.kind !== member.kind || existing.bindingKey !== bindingKey)) {
      this.drop(member.assistantId)
    }
    const now = this.now()
    let session = this.sessions.get(member.assistantId)
    if (!session) {
      const agent = member.kind === 'platform'
        ? new PlatformAgent(member.binding as PlatformBinding, this.options.resolveKey)
        : new CliAgent(member.binding as LocalCliBinding)
      session = { kind: member.kind, bindingKey, agent, messages: [], lastUsedAt: now }
      this.sessions.set(member.assistantId, session)
      this.evictOverLimit()
    } else {
      // LRU 触碰：重排到最新
      this.sessions.delete(member.assistantId)
      this.sessions.set(member.assistantId, session)
    }
    session.lastUsedAt = now
    if (session.kind === 'platform' && member.kind === 'platform') {
      const system: SubAssistantMessage = { role: 'system', content: `${member.persona}\n\n${SUB_ASSISTANT_PROTOCOL_PROMPT}` }
      const user: SubAssistantMessage = { role: 'user', content: task }
      const receipt = await (session.agent as PlatformAgent).send([system, ...session.messages, user], timeoutMs)
      if (receipt.kind === 'reply' || receipt.kind === 'out-of-scope') {
        // 成功回执才入史：assistant 内容用回执正文，失败回执当次不存在。
        session.messages.push(user,
          { role: 'assistant', content: receipt.kind === 'reply' ? receipt.text : `{"kind":"out-of-scope","reason":${JSON.stringify(receipt.reason)}}` })
      }
      return receipt
    }
    return (session.agent as CliAgent).send(task, timeoutMs)
  }

  /** 空闲回收：淘汰 lastUsedAt 距今超过 idleTtlMs 的会话；返回淘汰数。装配层周期调用。 */
  sweepIdle(at?: number): number {
    const now = at ?? this.now()
    let evicted = 0
    for (const [assistantId, session] of this.sessions) {
      if (now - session.lastUsedAt > this.options.idleTtlMs) {
        this.drop(assistantId)
        evicted++
      }
    }
    return evicted
  }

  /** 全量回收（插件停用/配置变更时）。 */
  dispose(): void {
    for (const assistantId of [...this.sessions.keys()]) this.drop(assistantId)
  }

  private evictOverLimit(): void {
    while (this.sessions.size > this.options.maxSessions) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) return
      this.drop(oldest)
    }
  }

  private drop(assistantId: string): void {
    const session = this.sessions.get(assistantId)
    if (!session) return
    this.sessions.delete(assistantId)
    if (session.agent instanceof CliAgent) session.agent.dispose()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}
