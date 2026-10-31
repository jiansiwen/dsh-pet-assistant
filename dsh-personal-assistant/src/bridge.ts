/**
 * 会话桥接：桌面宠物 ↔ dsh 主会话 ↔ 团队任务。
 *
 * 传输层：node:http 长轮询（零外部依赖）。宠物从 bridge.json 读取端口与 token 后接入：
 *   - POST /chat                 宠物发消息；点名成员时走子代理任务，否则注入主会话
 *   - POST /chat/cancel          按宠物请求 id 定向取消：队列中撤回（未执行）、已交给共享主会话只停等待
 *                                （后台是否停止未知，绝不取消整个共享 agent）、团队委派按任务定向取消
 *   - POST /team/cancel          按团队任务 id 定向取消插件持有的子代理，回执带运行结束 / 释放证据
 *   - POST /team/pause           暂停 / 恢复团队后续步骤：只挡新的领取，不中止在跑的运行
 *   - GET  /events?since=N       长轮询事件流（reply / 团队状态 / session-ended）
 *   - GET/POST /session          原生会话完整消息页／绑定内命令，复用聊天鉴权
 *   - POST /session/start        从桌面开始会话：已绑定且存活就返回当前绑定，否则经 ctx.agents
 *                                恢复插件上次自建的会话或新建一个，再走与召唤相同的 bind
 *   - GET  /team                 成员、任务与当前待批准提案的快照
 *   - POST /approval             审批决定，需要独立于聊天令牌的审批凭据
 *   - GET/POST /workbench/*      日报工作台：视图、逐条修订、请求发布与请求删除；复用聊天令牌，只生成待批，不能批准
 *   - GET  /health               探活；bound 如实反映是否绑定了会话
 *
 * 生命周期：插件加载即监听（未绑定），不必等网页召唤宠物。未绑定时对话、会话命令与审批一律
 * 503 + code:'unbound' 如实拒绝并给出可展示的原因，绝不伪装成已连接。发现文件 bridge.json 在加载时
 * 只在没有另一个健康运行时占着的情况下才写；召唤（bind）是用户的明确意愿，照旧接管。
 *
 * 会话所有权：只有经 /session/start 由本插件创建或恢复的会话归桥接所有，插件卸载时按所有权释放；
 * 网页里创建、经召唤绑定过来的会话桥接从不 dispose、也不 cancel。
 *
 * 回复归属：注入主会话的请求按「因果折叠」取回复，不再用整机 idle + 最后一条 assistant 文本猜。
 * handleChat 先用 createUserMessage 造出带稳定 id 的 UserMessage 并记住这个 id，再 followup 注入；
 * onAgentIdle 时在 sessionEventsOf(agent) 里按 id 定位本消息进入的那个轮次（entered），只有该轮次的
 * turn/end 出现、reason.kind==='completed'、且轮次内没有混入其他用户输入（source.kind==='user'）才结算，
 * 标记 attribution='causal'，文本取该轮次内最大 step 的 assistant/message，并保留 turn/step/输出消息 id。
 * 轮次未结束就保持 pending 等下一次 idle；非 completed、混入其他用户输入、来源不明、消息没进入模型都如实
 * 失败，绝不拿别人的轮次或半截输出冒充回复。超时先 inbox.remove(messageId)：撤回成功报 cancelled，已被
 * 领取（remove=false）则报 timeout 且声明后台可能仍在运行、不自动重发，也不 cancel 整个共享 agent。
 * 点名专家时改走 `ctx.subagents.start()`，每次委派有独立 run.result，attribution='task'。
 */
import http from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ActionProposal, MemberConfig, Task, TaskStatus, TeamEvent, TeamEventType } from './team-domain.ts'
import type { TeamService, CancelReceipt } from './team.ts'
import { ApprovalError, ApprovalService } from './approval.ts'
import type { ReportApprovalService, ReportAutoPublishResult, ReportProposal } from './report-approval.ts'
import type { AssistantApprovalService, AssistantProposal, AssistantSubmission } from './assistant-approval.ts'
import { SessionMirror, type MirrorEvent, type SessionResult } from './session-mirror.ts'
import type { WorkbenchHandler } from './workbench.ts'
import type { IntakeResult } from './evidence-intake.ts'
import { CompanionError, type CompanionRuntimePort, type CompanionSubject } from './companion-contract.ts'
import { DesktopCommands } from './desktop-commands.ts'

/** 桥接感知到的最小 agent 形状（注入主会话用；团队委派需要完整 Agent）。 */
export interface BridgeAgent {
  id?: string
  status?: string
  ctx?: { get(name: string): unknown }
  session: {
    id?: string
    /** 0.2.x 起 Session.events 数组改名为 snapshotEvents()。 */
    snapshotEvents?(): readonly MirrorEvent[]
    /** 旧宿主与测试替身：直接的日志数组。 */
    events?: MirrorEvent[]
  }
  followup(message: unknown): void
  /**
   * 可选收件箱句柄：仅在超时撤回时用。`remove(messageId)` 返回 true 表示这条消息还在等待、
   * 撤回成功（报 cancelled）；返回 false 表示已被领取或已在执行——此时绝不能 cancel 整个共享
   * agent（会误伤网页端正在跑的轮次），只能如实报 timeout。宿主未提供 inbox 时按 false 处理。
   */
  inbox?: {
    remove(messageId: string): boolean
  }
}

/** 读会话事件日志：优先 snapshotEvents()（0.2.x 起），兼容只有 events 数组的宿主替身。 */
export function sessionEventsOf(agent: BridgeAgent): readonly MirrorEvent[] {
  const session = agent.session
  // 必须经 session 调用保留 this：方法被摘出来单独调用会丢 receiver，class 方法内部
  // 访问私有状态时抛 TypeError（曾导致扫描器静默停摆、宠物面板一条记录都没有）。
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return session.events ?? []
}

/** 宿主 `ctx.agents.create/resume` 返回的句柄：dispose 是所有权凭证，只有创建方能拆掉这个会话。 */
export interface HostAgentHandle {
  agent: BridgeAgent
  dispose(): Promise<void>
}

/** 宿主 `ctx.agents`（AgentRegistry）里桥接用得到的部分。 */
export interface HostAgents {
  create(options: { sessionId: string; meta?: { cwd?: string } }): Promise<HostAgentHandle>
  resume(options: { resumeSessionId: string }): Promise<HostAgentHandle>
  /** 按 id 查在线会话；只用来核实存活，不用来比对身份。 */
  get?(id: string): unknown
}

/**
 * 「从桌面开始会话」需要的宿主能力，由装配侧提供。
 * agents 每次现取：宿主可能根本没有这个服务、晚于本插件装上或中途卸载，拿不到就如实拒绝。
 */
export interface SessionHost {
  agents(): HostAgents | undefined
  /** 插件上次自建会话的 id（持久化在 user_flags）；没有返回 null。 */
  readOwnedSessionId(): string | null
  writeOwnedSessionId(sessionId: string): void
  /** 新建会话的工作目录（绝对路径）。 */
  cwd(): string
}

/**
 * POST /session/start 的结果。
 * - existing：已绑定且会话仍在线，原样返回当前绑定（可能是网页召唤来的，owned=false）；
 * - reattached：插件还握着自建会话且它在线，直接重新绑定；
 * - resumed：经 ctx.agents.resume 恢复了上次自建的会话；
 * - created：新建会话；若之前尝试恢复失败，resumeError 如实给出原因。
 */
export type SessionStartResult =
  | {
      ok: true
      outcome: 'existing' | 'reattached' | 'resumed' | 'created'
      sessionId: string | null
      bindingId: string
      epoch: string
      owned: boolean
      resumeError?: string
    }
  | {
      ok: false
      code: 'agents-unavailable' | 'start-failed' | 'disposed'
      error: string
      resumeError?: string
    }

export type BridgeEventType =
  | 'reply'
  /** 流式增量：本轮 assistant 的 text-delta 片段，只用于边聊边显示，最终文本仍以 reply 为准。 */
  | 'delta'
  | 'session-ended'
  | 'epoch'
  | 'proactive'
  | 'team/snapshot'
  | 'session/update'
  | 'desktop/command'
  | 'desktop/cancel'
  | 'notice'
  | TeamEventType

/**
 * 推送给宠物的事件。`id` 是发起请求的 requestId，宠物按它归属气泡。
 */
export interface BridgeEvent {
  seq: number
  epoch: string
  type: BridgeEventType
  id?: string
  /**
   * `delta` 的形态：`text` 正文、`think` 思考过程、`tool` 工具调用、`user` 输入。
   * 缺省按 `text` 处理（早期只出正文时没有这个字段）。
   */
  kind?: 'text' | 'think' | 'tool' | 'user'
  /** `kind === 'tool'` 时的工具名（如 `Read` / `Grep`）。 */
  name?: string
  /** `kind === 'tool'` 时的参数摘要（如 `dsh-pet/README.md`）。 */
  arg?: string
  ok?: boolean
  reply?: string
  /** delta：本次增量的文本片段（显示用，不构成回复）。 */
  text?: string
  error?: string
  /**
   * task：来自子代理运行结果；causal：来自本消息所属轮次的因果折叠（唯一成功的注入归属）；
   * mixed：共享会话里这一轮混入了其他用户输入，拒绝猜测。不再有 interval 猜测归属。
   */
  attribution?: 'task' | 'causal' | 'mixed'
  assistantId?: string
  /** causal 结算保留的轮次与步序，宿主可据此核对归属；输出消息 id 见 assistantId。 */
  turn?: number
  step?: number
  displayName?: string
  skinId?: string
  taskId?: string
  status?: TaskStatus | string
  artifacts?: readonly string[]
  blockers?: readonly string[]
  needsApproval?: readonly string[]
  payload?: unknown
  /** proactive：气泡文案（design.md §2.7 的固定文案，不是模型生成的）。 */
  message?: string
  /** 定向取消产生的 reply 附带回执，宠物据此如实展示状态，不把失败当成「已停止」。 */
  cancel?: CancelReceipt
}

interface PendingRequest {
  requestId: string
  text: string
  /** 注入的 UserMessage 的稳定 id；因果折叠按它在 session.events 里定位本消息所属轮次，超时按它撤回。 */
  messageId: string
  resolve: (reply: { ok: boolean; reply?: string; error?: string }) => void
  timer: NodeJS.Timeout
  /** 流式显示状态：只影响气泡出字，不参与回复归属。 */
  stream: {
    turn: number | null
    /** 已扫到的事件下标；定位到轮次前不前进，免得漏掉进入模型那条。 */
    cursor: number
    stopped: boolean
    timer: NodeJS.Timeout | null
  }
}

interface QueuedRequest {
  requestId: string
  text: string
}

interface EventWaiter {
  seq: number
  res: (events: BridgeEvent[]) => void
  timer: NodeJS.Timeout
}

/**
 * 日报发布请求的结果。
 *
 * 两种形状不能混：manual 只拿到待办提案（文件还没写），auto 才拿到真实的落盘结果。
 * 模型必须按形状分别措辞，否则会把"提交待批"说成"已保存"。
 */
export type ReportSubmission =
  | { mode: 'manual'; proposal: ReportProposal }
  | { mode: 'auto'; published: ReportAutoPublishResult }

export interface SessionBridgeOptions {
  /** DSH_HOME（bridge.json 与宠物目录推断用）。 */
  dshHome: string
  /** 桌面宠物工程目录；为空则不自动拉起。 */
  petDir?: string
  activityState?: () => { active: boolean; capturing: boolean; titles: boolean }
  logger?: { info(message: string): void; warn?(message: string): void }
  /** 注入回复的超时；缺省 {@link REPLY_TIMEOUT_MS}。测试可注入更短值以驱动超时路径。 */
  replyTimeoutMs?: number
  /**
   * 可选事件观察器：每 push 一条桥接事件就同步回调一次。测试与宿主观测用，
   * 与 HTTP 长轮询事件流并行、互不影响。
   */
  onEvent?: (event: BridgeEvent) => void
  /** 「从桌面开始会话」的宿主能力；缺省时 /session/start 如实回 agents-unavailable。 */
  sessionHost?: SessionHost
  /**
   * 外部证据收件（桌面壳 → 插件）：已确认的会议纪要、用户主动记录的窗口文本。
   *
   * 做成注入而不是直接拿 `MaterialStore`：桥接层不该认识资料库，它只负责
   * "把请求体交给一个函数、把结果回给调用方"。真正的校验与入库在 `evidence-intake.ts`。
   * 缺省时这条路由回 503 —— 说明这个构建没接上证据库，而不是假装收下了。
   */
  evidenceIntake?: (request: unknown) => IntakeResult
}

const REPLY_TIMEOUT_MS = 300_000
const LONG_POLL_TIMEOUT_MS = 25_000
const TEAM_POLL_MS = 400
/** 加载时探测发现文件里另一个运行时的 /health 最多等这么久；超时按「没人在服务」处理。 */
const INCUMBENT_PROBE_MS = 1_000
/** 卸载时等自建会话释放的上限：宿主卡住时不让插件卸载一起挂死，释放在后台继续。 */
const OWNED_RELEASE_WAIT_MS = 10_000

/** 未绑定时拒绝的统一口径：桌面可原样展示，code 供程序分支。 */
const UNBOUND_CODE = 'unbound'
const UNBOUND_CHAT_ERROR = '还没有连上 dsh 会话，这条消息没有发送：请在 dsh 里说「召唤宠物」，或从桌面开始一个新会话'
const UNBOUND_SESSION_ERROR = '还没有连上 dsh 会话，不能执行会话操作：请在 dsh 里说「召唤宠物」，或从桌面开始一个新会话'
const UNBOUND_APPROVAL_ERROR = '还没有连上 dsh 会话，审批暂不受理：请先召唤宠物或从桌面开始会话，再处理这条待办'
const UNBOUND_WORKBENCH_ERROR = '还没有连上 dsh 会话，日报工作台暂时只能查看：修改、请求发布与删除都要在会话连上后进行（审批需要会话承接）'
/** 工作台写操作的请求体上限：桌面导入的聊天导出可能比聊天消息大得多。 */
const WORKBENCH_BODY_LIMIT = 1_048_576
/**
 * 证据收件请求体上限：正文本身限 512KB（`MAX_INTAKE_BYTES`），这里给 JSON 转义、
 * 标题与字段名留一倍余量。超了回 413，让桌面壳如实告诉用户"请分段记录"。
 */
const EVIDENCE_INTAKE_BODY_LIMIT = 1_200_000
const AGENTS_UNAVAILABLE_ERROR =
  '当前 dsh 宿主没有提供会话服务（ctx.agents），不能从桌面开始会话；请在 dsh 里说「召唤宠物」把宠物接到已有会话'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 会话的身份：宿主 Agent 的 id 与 session.id 是同一个值；最小测试替身可能都没有。 */
function sessionIdOf(agent: BridgeAgent): string | null {
  return agent.session?.id ?? agent.id ?? null
}
/** 流式增量扫描间隔。再密没有意义：人眼在这个尺度上已经读不出差别，只是白烧定时器。 */
/**
 * 会话流水的采样拍。定成 120ms 与旧的正文扫描一致：用户看不出「一段推 1 次」与
 * 「一段推 100 次」的差别，但能把上千次事件收敛成几十次。
 */
const FEED_TICK_MS = 120

/**
 * 从 `user/message` 的 content 里抽出可见文本（只取 text 块，附件/图片不算）。
 * 用户输入要同步进宠物对话框，就得先变成一行文字。
 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    const item = block as { type?: unknown; text?: unknown } | null
    if (item && (item.type === 'text' || item.type === 'message') && typeof item.text === 'string') {
      out += item.text
    }
  }
  return out.trim()
}

/**
 * 工具调用的参数摘要：DSH 界面显示的是 `Read · dsh-pet/README.md` 这种「名字 · 第一个参数」，
 * 不是整段 JSON。这里取第一个字符串型参数，长了截断。
 */
function firstArgument(args: unknown): string {
  if (typeof args === 'string') return truncateArg(args)
  if (!args || typeof args !== 'object') return ''
  for (const value of Object.values(args as Record<string, unknown>)) {
    if (typeof value === 'string') return truncateArg(value)
  }
  return ''
}

function truncateArg(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}
const EVENT_RETENTION = 512
/** 取消相关的请求 id 记账上限：只为回执服务，不能无限增长。 */
const CANCEL_LEDGER_LIMIT = 256
const UNBOUND_CANCEL_ERROR = '还没有连上 dsh 会话，取消请求没有受理：请先召唤宠物或从桌面开始会话'
const SHARED_SESSION_CANCEL_MESSAGE = '已停止本地等待，后台是否停止未知：这条消息已交给共享主会话，宿主没有定向取消；'
  + '我不会取消整个会话（以免误伤网页里正在执行的其他请求），也不会自动重发'

/** 有上限的集合写入：超出时丢最早的。 */
function rememberBounded<K>(set: Set<K> | Map<K, unknown>, key: K, value?: unknown): void {
  if (set instanceof Map) set.set(key, value)
  else set.add(key)
  while (set.size > CANCEL_LEDGER_LIMIT) {
    const oldest = set.keys().next().value as K
    set.delete(oldest)
  }
}
/** 排队上限；超出直接拒绝，不让宠物把消息堆进一个永远不会被读的空洞。 */
const MAX_PENDING_REQUESTS = 32

/** 事件载荷里的列表字段一律收窄成字符串数组，模型产出的脏元素不进宠物界面。 */
function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

/** 一条 assistant/message 的可见文本：拼接其 message.content 里的非空 text 块。 */
function messageText(message: unknown): string {
  const content = (message as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? []
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
    .map((block) => block.text as string)
    .join('\n')
    .trim()
}

/** 事件 data 里的数字字段收窄成有限数；缺失或非法一律 NaN，比较时永不命中。 */
function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
}

/** {@link settleFromEvents} 的定位输入：只需要本条消息的稳定 id。 */
export interface CausalPending {
  messageId: string
}

/**
 * {@link settleFromEvents} 的判定：
 * - `pending`：轮次还没结束，保持等待下一次 idle；
 * - `settled`：本消息所属轮次正常完成且不混入其他用户输入，reply 即因果回复；
 * - `failed`：如实失败（未进入模型 / 非 completed / mixed / 来源不明），绝不猜。
 */
export type CausalOutcome =
  | { kind: 'pending' }
  | { kind: 'settled'; reply: string; turn: number; step: number; assistantId?: string }
  | { kind: 'failed'; error: string; attribution?: 'mixed' }

const MIXED_ERROR =
  '共享会话里这一轮混入了其他用户输入，无法分辨哪句是回给你的；请把网页与宠物分开成不同会话，我不会猜'
const UNCERTAIN_ERROR =
  '共享会话里这一轮混入了来源不明的输入，无法确认是不是别的用户插进来的；请把网页与宠物分开成不同会话，我不会猜'

/**
 * 已知的非人类消息来源（`source.kind`）。0.2.x 起运行时上下文与时间块会以自己的来源种类注入
 * （runtime-context / time-context），它们是注入的上下文而不是用户说的话：既不该在宠物里
 * 当作用户气泡铺出来，也不该让回复归属被判成"来源不明"。
 */
const NON_USER_SOURCE_KINDS = new Set(['plugin', 'model', 'tool', 'runtime-context', 'time-context', 'system-prompt'])

/** turn/end 的 reason.kind 非 completed 时，按具体原因如实描述失败，不含糊成「超时」。 */
function reasonFailure(kind: unknown): string {
  switch (kind) {
    case 'aborted':
      return '这一轮被中断（aborted），没有正常完成；半截输出不当成回复'
    case 'blocked':
      return '这一轮被拦截（blocked），没有产出回复'
    case 'error':
      return '这一轮出错（error），没有正常完成，不当成回复'
    case 'max-tokens':
      return '这一轮达到输出上限（max-tokens），回复可能不完整，不当成正常回复'
    case 'interrupted':
      return '这一轮被标记为中断（interrupted，通常是崩溃后重载关闭的轮次），不当成正常回复'
    default:
      return `这一轮没有正常完成（reason=${String(kind)}），不当成回复`
  }
}

/**
 * 本消息在会话事件日志里的落点，以及它所属的轮次。
 *
 * - `located`：进了模型并且能定位到轮次；
 * - `not-entered`：已经 idle 却没进入模型（被 pre-step 拒绝 / 取消 / 丢弃）；
 * - `no-turn`：进了模型但找不到它属于哪一轮 —— 这种情况不能猜，宁可如实失败。
 *
 * 结算（{@link settleFromEvents}）与流式推送共用这一套判定：两处各写一份，早晚会出现
 * "流式按另一个轮次推文本"，而那种错位在界面上看不出来 —— 用户只会觉得宠物莫名开始打字。
 */
export type TurnLocation =
  | { kind: 'located'; enteredIndex: number; turnStartIndex: number; turn: number }
  | { kind: 'not-entered' }
  | { kind: 'no-turn' }

/**
 * 按消息 id 定位它的轮次。
 *
 * 结算与流式推送共用这一套判定：两处各写一份，早晚会出现"流式按另一个轮次推文本"，
 * 而那种错位在界面上看不出来 —— 用户只会觉得宠物莫名其妙开始打字。
 */
export function locateTurn(events: readonly MirrorEvent[], messageId: string): TurnLocation {
  let enteredIndex = -1
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]
    if (event.type === 'user/message' && (event.data as { id?: unknown }).id === messageId) {
      enteredIndex = i
      break
    }
  }
  if (enteredIndex < 0) return { kind: 'not-entered' }
  // 轮次 = entered 之前最近的一条 turn/start（turn/start 在领取输入前打开）。
  for (let i = enteredIndex; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type !== 'turn/start') continue
    const turn = asNumber((event.data as { turn?: unknown }).turn)
    if (!Number.isFinite(turn)) break
    return { kind: 'located', enteredIndex, turnStartIndex: i, turn }
  }
  return { kind: 'no-turn' }
}

export function settleFromEvents(
  events: readonly MirrorEvent[],
  pending: CausalPending,
): CausalOutcome {
  const messageId = pending.messageId

  // 1) 定位本消息进入会话日志的位置与所属轮次（与流式推送共用同一套判定）。
  const located = locateTurn(events, messageId)
  if (located.kind === 'not-entered') {
    // 已经 idle 却没进入模型：被 pre-step 拒绝、被取消或被丢弃，没有可归属的轮次；不重试。
    return { kind: 'failed', error: '这条消息没有进入模型（可能已被拦截、取消或丢弃），不会自动重试；请重新发送' }
  }
  if (located.kind === 'no-turn') {
    return { kind: 'failed', error: '无法确定这条消息所属的轮次，不能猜测回复' }
  }
  const { turnStartIndex, turn } = located

  // 3) 该轮次的 turn/end（可能还没出现）。轮次窗口 = (turn/start, turn/end]；未结束则到日志末尾。
  let turnEndIndex = -1
  let reason: unknown = null
  for (let i = turnStartIndex + 1; i < events.length; i += 1) {
    const event = events[i]
    if (event.type === 'turn/end' && asNumber((event.data as { turn?: unknown }).turn) === turn) {
      turnEndIndex = i
      reason = (event.data as { reason?: unknown }).reason
      break
    }
  }
  const windowEnd = turnEndIndex >= 0 ? turnEndIndex : events.length

  // 4) 收集本轮次内的 user/message，判定是否混入了其他用户输入。
  //    只有 source.kind==='user' 是真人输入；plugin/model/tool 是可证明的非用户产物（注入上下文、
  //    模型与工具消息），跳过；缺失或未知来源无法自证清白，判 uncertain。mixed/uncertain 都不猜。
  for (let i = turnStartIndex + 1; i < windowEnd; i += 1) {
    const event = events[i]
    if (event.type !== 'user/message') continue
    const data = event.data as { id?: unknown; source?: { kind?: unknown } }
    if (data.id === messageId) continue
    const sourceKind = data.source?.kind
    if (sourceKind === 'user') return { kind: 'failed', attribution: 'mixed', error: MIXED_ERROR }
    if (typeof sourceKind === 'string' && NON_USER_SOURCE_KINDS.has(sourceKind)) continue
    return { kind: 'failed', error: UNCERTAIN_ERROR }
  }

  // 5) 轮次没结束：保持 pending，等下一次 idle 再折叠。
  if (turnEndIndex < 0) return { kind: 'pending' }

  // 6) 轮次结束但非 completed：如实失败，即使有文本也不报成功。
  const reasonKind = (reason as { kind?: unknown } | null)?.kind
  if (reasonKind !== 'completed') return { kind: 'failed', error: reasonFailure(reasonKind) }

  // 7) completed 且干净：文本 = 本轮次内最大 step 的 assistant/message 文本拼接，保留 turn/step/输出 id。
  let maxStep = Number.NaN
  const stepTexts = new Map<number, string[]>()
  const stepIds = new Map<number, string[]>()
  for (let i = turnStartIndex + 1; i < turnEndIndex; i += 1) {
    const event = events[i]
    if (event.type !== 'assistant/message') continue
    const data = event.data as { turn?: unknown; step?: unknown; message?: { id?: unknown } }
    if (asNumber(data.turn) !== turn) continue
    const step = asNumber(data.step)
    if (!Number.isFinite(step)) continue
    if (!Number.isFinite(maxStep) || step > maxStep) maxStep = step
    const texts = stepTexts.get(step) ?? []
    texts.push(messageText(data.message))
    stepTexts.set(step, texts)
    if (typeof data.message?.id === 'string') {
      const ids = stepIds.get(step) ?? []
      ids.push(data.message.id)
      stepIds.set(step, ids)
    }
  }

  const reply = (stepTexts.get(maxStep) ?? []).filter((text) => text.length > 0).join('\n').trim()
  if (reply.length === 0) {
    return { kind: 'failed', error: '这一轮正常结束，但没有产出可见文本，我不拿空内容冒充回复' }
  }
  const assistantId = (stepIds.get(maxStep) ?? []).find((id) => typeof id === 'string')
  return { kind: 'settled', reply, turn, step: maxStep, assistantId }
}

/** 会话事件里最后一条结束标记是不是 turn/end（= 这一轮确实结束了）。 */
export function latestTurnEnded(events: readonly MirrorEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type
    if (type === 'turn/end') return true
    // 看到新一轮开启就说明上一轮之后又开始了：不是空闲。
    if (type === 'turn/start') return false
  }
  return false
}

export class SessionBridge {
  private readonly options: SessionBridgeOptions
  private readonly desktopCommands: DesktopCommands
  private server: http.Server | null = null
  private port = 0
  private token = ''
  private infoPath = ''
  private approvalPath = ''
  private agent: BridgeAgent | null = null
  private teamAgent: Agent | null = null
  private team: TeamService | null = null
  private companion: CompanionRuntimePort | null = null
  private chatContextProvider: (() => string | null) | null = null
  private readonly companionOwnerToken = randomUUID()
  private readonly companionExecutorToken = randomUUID()
  private readonly companionRequests = new Set<Promise<void>>()

  /** 解析好的桌面宠物目录；null = 没找到（召唤只绑会话，提示用户手动启动）。 */
  get petDir(): string | null {
    return this.options.petDir ?? null
  }
  private approvals: ApprovalService | null = null
  private reportApprovals: ReportApprovalService | null = null
  /** 日报写入方式：manual=桌面专用审批窗口批准；auto=按用户在配置里的选择直接保存。 */
  private reportApprovalMode: 'manual' | 'auto' = 'manual'
  private assistantApprovals: AssistantApprovalService | null = null
  /** 日报工作台服务（只读视图、逐条修订、请求发布/删除）；没有批准能力。 */
  private workbench: WorkbenchHandler | null = null
  /** 主动提醒的反馈回调：状态机在装配侧，桥接只负责把用户的点选转交过去。 */
  private proactiveFeedback: ((kind: 'accept' | 'decline' | 'disable' | 'enable') => void) | null = null
  /**
   * 宠物上报的桌面状态，主动提醒评估的输入（§2.7：会议/演示/免打扰不提醒）。
   * 桥接断开或重启后回到默认（可见、不专注）—— 宁可多看一眼，不可该提醒时漏掉。
   */
  private petState: { focus: boolean; visible: boolean; meeting: boolean } = { focus: false, visible: true, meeting: false }
  private teamCursor = 0
  private teamTimer: NodeJS.Timeout | null = null
  private events: BridgeEvent[] = []
  private seq = 0
  private waiters: EventWaiter[] = []
  private pending: PendingRequest | null = null
  private readonly queue: QueuedRequest[] = []
  private readonly inflightTasks = new Map<string, Promise<void>>()
  /** 宠物请求 id → 团队任务 id：/chat/cancel 按请求 id 找到插件持有的子代理任务。 */
  private readonly requestTasks = new Map<string, string>()
  /** 已结算（推过 reply）的请求 id，取消时如实报「已结算，结果不变」。有上限。 */
  private readonly settledRequests = new Set<string>()
  /** 被定向取消的请求：迟到的成功结果一律不复活成 ok 回复。有上限。 */
  private readonly cancelledRequests = new Set<string>()
  /** 主会话请求的取消回执：同一请求重复取消返回同一份回执，不再动队列。有上限。 */
  private readonly cancelReceipts = new Map<string, CancelReceipt>()
  private closed = false
  readonly epoch = randomUUID()
  private mirror = new SessionMirror(null, payload => this.push({ type: 'session/update', payload }))
  /** 监听中的启动任务；失败会清空以便召唤时重试。 */
  private listening: Promise<void> | null = null
  private startedAt = 0
  /** 发现文件与审批凭据是否由本实例写出；没写过的文件卸载时一律不碰。 */
  private advertised = false
  /** 经 /session/start 由本插件创建或恢复的会话：桥接唯一有权 dispose 的会话。 */
  private owned: { handle: HostAgentHandle; sessionId: string } | null = null
  /** 在途的 /session/start：并发与重复调用共用一次，不会建出两个会话。 */
  private starting: Promise<SessionStartResult> | null = null
  private disposal: Promise<void> = Promise.resolve()

  constructor(options: SessionBridgeOptions) {
    this.options = options
    const dir = path.join(options.dshHome, 'personal-assistant')
    this.infoPath = path.join(dir, 'bridge.json')
    this.approvalPath = path.join(dir, 'bridge-approval.json')
    this.desktopCommands = new DesktopCommands(event => this.push(event))
  }

  /** 宿主工具驱动桌宠的一次性命令；结果由 /companion/v1/desktop/result 带回。 */
  requestDesktopCommand(command: string, payload: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown> {
    return this.desktopCommands.request(command, payload, options)
  }

  get bound(): boolean {
    return this.agent !== null
  }

  get teamEnabled(): boolean {
    return this.team !== null
  }

  /** 该 agent 是否为经 /session/start 由本插件建出或恢复、仍归桥接所有的会话。 */
  ownsAgent(agent: unknown): boolean {
    return this.owned !== null && this.owned.handle.agent === agent
  }

  /**
   * 插件加载即监听：服务处于未绑定状态，/health 如实报 bound:false，对话与审批一律拒绝。
   *
   * 发现文件只在没有另一个健康运行时占着时才写：用户可能同时开着别的 dsh（网页常驻、一次性 headless），
   * 加载不该从已在服务的运行时手里抢走宠物——被抢的那边退出时还会把文件删掉，两边一起失联。
   * 召唤（bind）是用户明确要宠物到这里来，照旧接管。
   */
  async listen(): Promise<{ port: number; advertised: boolean; incumbentPid?: number }> {
    await this.ensureListening()
    if (!this.advertised && !this.closed) {
      const incumbent = await this.healthyIncumbent()
      if (incumbent === null) this.advertise()
      else {
        this.options.logger?.info(`session bridge listening on 127.0.0.1:${this.port} without taking bridge.json: `
          + `runtime pid ${incumbent.pid ?? '?'} is still serving it (a summon here takes it over)`)
        return { port: this.port, advertised: false, ...(incumbent.pid !== undefined ? { incumbentPid: incumbent.pid } : {}) }
      }
    }
    return { port: this.port, advertised: this.advertised }
  }

  /** 重复召唤同一 agent 保留绑定；换绑先停止旧扫描，隔离在途回执。 */
  async bind(agent: BridgeAgent): Promise<{ port: number; epoch: string }> {
    if (this.closed) throw new Error('bridge already disposed')
    if (agent !== this.agent) {
      this.assistantApprovals?.invalidateAll()
      this.stopFeed()
      this.mirror.close()
      this.failPending('主会话绑定已变化，旧请求不再结算')
      this.agent = agent
      // 桌面点名成员的父代理就是被绑定的主会话；不能等第一次桌面团队工具执行后才设置，
      // 否则从桌面直接点名成员会退回主会话队列。
      this.teamAgent = agent as unknown as Agent
      this.mirror = new SessionMirror(agent, payload => this.push({ type: 'session/update', payload }))
    }
    await this.ensureListening()
    // 绑定方接管发现文件：加载时让给了别的运行时也好、文件被别人覆盖过也好，召唤之后宠物都该找到这里。
    if (!this.closed) this.advertise()
    if (this.agent === agent && !this.closed) {
      this.scanFeed(agent)
      this.startFeed(agent)
    }
    return { port: this.port, epoch: this.epoch }
  }

  /**
   * 从桌面开始会话（POST /session/start）。
   *
   * 已绑定且会话仍在线：原样返回当前绑定，不抢网页召唤来的会话。否则经 ctx.agents 恢复插件上次自建的会话
   * （id 记在 user_flags），恢复失败就新建并如实带回原因，然后走与召唤相同的 bind。
   * 并发或重复调用共用同一次启动，不会建出两个会话。
   */
  async startSession(): Promise<SessionStartResult> {
    if (this.closed) return { ok: false, code: 'disposed', error: '助理已停止，不能开始会话' }
    const current = this.agent
    if (current !== null) {
      if (this.agentAlive(current)) return this.currentBinding('existing')
      // 宿主注册表里已经没有这个会话（漏了 agent/disposed）：按销毁处理，再开始新的。
      this.onAgentDisposed(current)
    }
    if (this.starting === null) {
      this.starting = this.startOwnedSession().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  private async startOwnedSession(): Promise<SessionStartResult> {
    const host = this.options.sessionHost
    let agents: HostAgents | undefined
    try {
      agents = host?.agents()
    } catch (error) {
      return { ok: false, code: 'agents-unavailable', error: `${AGENTS_UNAVAILABLE_ERROR}（读取失败：${describeError(error)}）` }
    }
    if (!host || !agents) return { ok: false, code: 'agents-unavailable', error: AGENTS_UNAVAILABLE_ERROR }

    // 还握着自建会话且它在线（例如网页召唤别的会话后又结束了）：接回它，不再新建，免得攒出一串孤儿会话。
    const kept = this.owned
    if (kept !== null) {
      if (this.agentAlive(kept.handle.agent)) return this.bindOwned(kept.handle.agent, 'reattached')
      this.owned = null
    }

    let handle: HostAgentHandle | null = null
    let outcome: 'resumed' | 'created' = 'created'
    let resumeError: string | undefined
    let previous: string | null = null
    try {
      previous = host.readOwnedSessionId()
    } catch (error) {
      resumeError = `读不到上次自建会话的记录，改为新建：${describeError(error)}`
    }
    if (previous) {
      try {
        handle = await agents.resume({ resumeSessionId: previous })
        outcome = 'resumed'
      } catch (error) {
        resumeError = `恢复上次的桌面会话 ${previous} 失败，已改为新建：${describeError(error)}`
      }
    }
    if (handle === null) {
      const sessionId = `pet-${randomUUID()}`
      try {
        handle = await agents.create({ sessionId, meta: { cwd: host.cwd() } })
      } catch (error) {
        return {
          ok: false, code: 'start-failed', error: `新建会话失败：${describeError(error)}`,
          ...(resumeError ? { resumeError } : {}),
        }
      }
    }
    if (!handle || !handle.agent || typeof handle.dispose !== 'function') {
      return { ok: false, code: 'start-failed', error: '宿主返回的会话句柄不完整，没有绑定', ...(resumeError ? { resumeError } : {}) }
    }
    const sessionId = sessionIdOf(handle.agent) ?? previous ?? ''
    // 自此握有所有权：不管后面绑没绑上，这个会话都只由桥接在卸载时释放。
    if (this.closed) {
      await handle.dispose().catch(error => this.options.logger?.warn?.(`owned session release failed: ${describeError(error)}`))
      return { ok: false, code: 'disposed', error: '助理已停止，刚开始的会话已释放' }
    }
    this.owned = { handle, sessionId }
    if (sessionId && sessionId !== previous) {
      try {
        host.writeOwnedSessionId(sessionId)
      } catch (error) {
        this.options.logger?.warn?.(`owned session id not persisted: ${describeError(error)}`)
      }
    }
    this.options.logger?.info(`desktop session ${outcome}: ${sessionId}`)
    // 等宿主期间网页召唤绑定了别的在线会话：尊重它，不抢；自建会话留着，下次开始时接回或卸载时释放。
    const now = this.agent
    if (now !== null && now !== handle.agent && this.agentAlive(now)) {
      return { ...this.currentBinding('existing'), ...(resumeError ? { resumeError } : {}) }
    }
    return this.bindOwned(handle.agent, outcome, resumeError)
  }

  private async bindOwned(
    agent: BridgeAgent,
    outcome: 'reattached' | 'resumed' | 'created',
    resumeError?: string,
  ): Promise<SessionStartResult> {
    try {
      await this.bind(agent)
    } catch (error) {
      return {
        ok: false, code: this.closed ? 'disposed' : 'start-failed', error: `会话已就绪但没能接到桥接：${describeError(error)}`,
        ...(resumeError ? { resumeError } : {}),
      }
    }
    if (this.agent !== agent) return { ...this.currentBinding('existing'), ...(resumeError ? { resumeError } : {}) }
    return { ...this.currentBinding(outcome), ...(resumeError ? { resumeError } : {}) }
  }

  private currentBinding(outcome: 'existing' | 'reattached' | 'resumed' | 'created'): SessionStartResult {
    const agent = this.agent
    if (agent === null) return { ok: false, code: 'start-failed', error: '会话绑定在启动途中被解除，请重试' }
    return {
      ok: true, outcome, sessionId: sessionIdOf(agent), bindingId: this.mirror.bindingId,
      epoch: this.epoch, owned: this.ownsAgent(agent),
    }
  }

  /**
   * 会话是否仍在线。解除绑定以宿主的 agent/disposed 为准；宿主注册表可查时再按 id 核实一次，
   * 只看在不在、不比对象身份（宿主可能以不同引用交出同一个会话）。核实不了时信事件。
   */
  private agentAlive(agent: BridgeAgent): boolean {
    const id = sessionIdOf(agent)
    let registry: HostAgents | undefined
    try {
      registry = this.options.sessionHost?.agents()
    } catch {
      return true
    }
    if (!id || !registry || typeof registry.get !== 'function') return true
    try {
      return registry.get(id) !== undefined
    } catch {
      return true
    }
  }

  getSession(beforeSeq?: number, bindingId?: string): Promise<SessionResult> {
    const mirror = this.mirror
    return mirror.snapshot(beforeSeq, bindingId, () => { if (this.agent && mirror === this.mirror) this.scanFeed(this.agent) })
  }

  sessionCommand(command: unknown): Promise<SessionResult> {
    const mirror = this.mirror
    return mirror.command(command, () => { if (this.agent && mirror === this.mirror) this.scanFeed(this.agent) })
  }

  /** 全状态来自宿主事件，HTTP 受理或 cancel 回执不能代替运行状态。 */
  onAgentStatus(agent: unknown, status: unknown): void {
    if (!this.agent || agent !== this.agent) return
    this.mirror.setStatus(status)
    this.scanFeed(this.agent)
    if (status === 'idle') this.onAgentIdle(agent)
  }

  /** 团队委派需要完整 Agent 作为父身份；由团队工具在执行上下文里注入。 */
  bindTeamAgent(agent: Agent): void {
    this.teamAgent = agent
  }

  /** 下一次宠物对话前取一次网页上下文；用完即消费，不重复带入后续对话。 */
  setChatContextProvider(provider: () => string | null): void {
    this.chatContextProvider = provider
  }

  attachCompanion(runtime: CompanionRuntimePort, approvals: ApprovalService): () => void {
    if (this.closed) throw new Error('桥接已关闭')
    if (this.companion && this.companion !== runtime) throw new Error('普通任务运行时已挂载')
    if (this.approvals && this.approvals !== approvals) throw new Error('任务必须共用审批服务')
    this.companion = runtime
    this.approvals = approvals
    if (this.advertised) this.writeApprovalCredential()
    this.notifyApprovalSnapshot()
    return () => {
      if (this.companion !== runtime) return
      this.companion = null
      if (!this.team) this.approvals = null
      if (this.advertised && !this.closed) this.writeApprovalCredential()
    }
  }

  /** 接上团队服务与审批服务，开始转发任务状态事件。 */
  attachTeam(team: TeamService, approvals: ApprovalService): void {
    if (this.companion && this.approvals !== approvals) throw new Error('任务必须共用审批服务')
    this.team = team
    this.approvals = approvals
    this.teamCursor = 0
    this.drainTeamEvents()
    if (this.teamTimer === null) {
      this.teamTimer = setInterval(() => this.drainTeamEvents(), TEAM_POLL_MS)
      this.teamTimer.unref()
    }
    if (this.advertised) this.writeApprovalCredential()
    this.notifyApprovalSnapshot()
  }

  /**
   * 摘下团队服务：停轮询、清引用、推空快照，宠物界面随之退回单助理形态。
   * 服务的释放（dispose / 关库）由调用方负责——桥接不知道团队任务的清理顺序。
   */
  detachTeam(): void {
    if (this.teamTimer) {
      clearInterval(this.teamTimer)
      this.teamTimer = null
    }
    this.team = null
    if (!this.companion) this.approvals = null
    this.teamCursor = 0
    if (this.advertised) this.writeApprovalCredential()
    this.notifyApprovalSnapshot()
  }

  attachAssistantApprovals(service: AssistantApprovalService): void {
    this.assistantApprovals = service
    if (this.advertised) this.writeApprovalCredential()
    this.notifyApprovalSnapshot()
  }

  submitAssistant(submission: AssistantSubmission): AssistantProposal {
    if (!this.assistantApprovals) throw new Error('助理可信审批未装配')
    const proposal = this.assistantApprovals.submit(submission)
    this.notifyApprovalSnapshot()
    return proposal
  }

  invalidateAssistantApprovals(subject?: string): void {
    this.assistantApprovals?.invalidateAll(subject)
    this.notifyApprovalSnapshot()
  }

  attachReportApprovals(service: ReportApprovalService, mode: 'manual' | 'auto' = 'manual'): void {
    this.reportApprovals = service
    this.reportApprovalMode = mode
    if (this.advertised) this.writeApprovalCredential()
    this.notifyApprovalSnapshot()
  }

  /**
   * 发布当天日报。
   *
   * 两种模式共用同一个入口，差别只在"谁签发"：
   * - manual：提交待办，等用户在桌面专用审批窗口批准；模型永远拿不到凭据。
   * - auto：用户在配置里打开的开关代为签发，直接写文件（审计里记 auto-publish）。
   *
   * 返回形状刻意分开：pending 结果没有写文件，auto 结果是真的（未）落盘，
   * 模型据此对用户说"已保存"才不会说错。
   */
  async submitReport(reportId: string): Promise<ReportSubmission> {
    if (!this.reportApprovals) throw new Error('日报可信审批未装配，不能发布')
    if (this.reportApprovalMode === 'auto') {
      // 自动模式：用户已在配置里打开这个开关，签发者是它，不是模型——模型仍然只调这一个入口。
      const published = await this.reportApprovals.autoPublish(reportId)
      this.notifyApprovalSnapshot()
      return { mode: 'auto', published }
    }
    const proposal = this.reportApprovals.submit(reportId)
    this.notifyApprovalSnapshot()
    return { mode: 'manual', proposal }
  }

  get reportApprovalModeName(): 'manual' | 'auto' {
    return this.reportApprovalMode
  }

  pendingReportApprovals(): ReportProposal[] {
    return this.reportApprovals?.pendingProposals() ?? []
  }

  notifyApprovalSnapshot(): void {
    this.push({ type: 'team/snapshot', payload: { epoch: this.epoch, team: this.teamEnabled, ...this.teamSnapshot() } })
  }

  private teamSnapshot(): {
    members: MemberConfig[]
    tasks: Task[]
    running: number
    /** 团队「暂停后续步骤」开关：暂停期间不领取新运行，在跑的照常结束。团队没开时不带。 */
    paused?: boolean
    proposals: (ActionProposal | ReportProposal | AssistantProposal)[]
  } {
    return {
      members: this.team?.roster() ?? [],
      tasks: this.team?.listTasks().slice(0, 50) ?? [],
      running: this.team?.runningCount() ?? 0,
      ...(this.team ? { paused: this.team.followupsPaused } : {}),
      // 团队关闭仍保留日报待办，重连快照不依赖事件是否曾被壳接收。
      proposals: [...(this.approvals?.pendingProposals() ?? []), ...this.pendingReportApprovals(), ...(this.assistantApprovals?.pendingProposals() ?? [])],
    }
  }

  /** 把团队发件箱的新事件转成桥接事件；reply/delta 转成 delta 供气泡出字，reply/done 顺带结算对应请求。 */
  private drainTeamEvents(): void {
    const team = this.team
    if (!team || this.closed) return
    let batch: TeamEvent[]
    try {
      batch = team.eventsSince(this.teamCursor, 200)
    } catch (error) {
      this.options.logger?.warn?.(`team event drain failed: ${String(error)}`)
      return
    }
    for (const event of batch) {
      this.teamCursor = event.seq
      const payload = (event.payload ?? {}) as Record<string, unknown>
      if (event.type === 'reply/done') {
        const requestId = typeof payload.requestId === 'string' ? payload.requestId : null
        const text = typeof payload.text === 'string' ? payload.text : ''
        if (requestId) this.settleByTask(requestId, text, payload)
      }
      // 团队委派的出字增量：换成宠物那条已经跑通的 delta 事件，
      // 终端链路（长轮询 → onDelta → chat-delta → 气泡）一处都不用改。
      // 没有这一步，点名成员时只会等 reply/done 才一次性弹出整段。
      if (event.type === 'reply/delta') {
        const requestId = typeof payload.requestId === 'string' ? payload.requestId : null
        const text = typeof payload.text === 'string' ? payload.text : ''
        if (requestId !== null && text.length > 0) this.push({ type: 'delta', id: requestId, text })
      }
      this.push({
        type: event.type,
        id: typeof payload.requestId === 'string' ? payload.requestId : undefined,
        taskId: event.taskId ?? undefined,
        assistantId: event.assistantId ?? undefined,
        displayName: typeof payload.displayName === 'string' ? payload.displayName : undefined,
        skinId: typeof payload.skinId === 'string' ? payload.skinId : undefined,
        status: typeof payload.status === 'string' ? payload.status : undefined,
        payload: event.payload,
      })
    }
  }

  private settleByTask(requestId: string, text: string, payload: Record<string, unknown>): void {
    const queuedIndex = this.queue.findIndex((item) => item.requestId === requestId)
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1)
    const inflight = this.inflightTasks.get(requestId)
    if (inflight) void inflight.then(() => this.inflightTasks.delete(requestId))

    const pending = this.pending
    if (pending && pending.requestId === requestId) {
      clearTimeout(pending.timer)
      this.pending = null
      pending.resolve({ ok: true, reply: text })
      this.pump()
    }

    // 已被定向取消的请求：团队任务随后的 reply/done 只是取消收尾，不能复活成一条成功回复。
    if (this.cancelledRequests.has(requestId)) {
      this.push({
        type: 'reply',
        id: requestId,
        ok: false,
        error: text ? `已取消：${text}` : '已取消，这条请求的结果不再作为回复',
        attribution: 'task',
        taskId: typeof payload.taskId === 'string' ? payload.taskId : undefined,
        status: typeof payload.status === 'string' ? payload.status : undefined,
      })
      return
    }

    this.push({
      type: 'reply',
      id: requestId,
      ok: true,
      reply: text,
      attribution: 'task',
      assistantId: typeof payload.assistantId === 'string' ? payload.assistantId : undefined,
      displayName: typeof payload.displayName === 'string' ? payload.displayName : undefined,
      skinId: typeof payload.skinId === 'string' ? payload.skinId : undefined,
      taskId: typeof payload.taskId === 'string' ? payload.taskId : undefined,
      status: typeof payload.status === 'string' ? payload.status : undefined,
      artifacts: stringList(payload.artifacts),
      blockers: stringList(payload.blockers),
      needsApproval: stringList(payload.needsApproval),
    })
  }

  /**
   * 拉起桌面宠物（配置了 petDir 时）；返回 false 表示未配置或启动失败。
   *
   * `cmd /c` 是 Windows 专有的：macOS/Linux 上没有 `cmd`，spawn 会以 ENOENT 失败，
   * 而失败被吞成一句日志，用户看到的是"召唤了但宠物不出现"。所以这里按平台挑：
   * POSIX 上直接跑 `pnpm`（它是个 shell 脚本，可执行位由安装时设好）。
   *
   * 输出不再丢掉：召唤没有终端，闪退时日志是唯一线索，统一落到 <DSH_HOME>/dsh-pet/launch.log。
   */
  launchPet(): boolean {
    const petDir = this.options.petDir
    if (!petDir) return false
    // 依赖没装时 pnpm start 会在构建阶段直接失败，用户只会看到"一闪就没"。
    if (!existsSync(path.join(petDir, 'node_modules', 'electron'))) {
      this.options.logger?.info(`launch pet skipped: ${petDir} 还没安装依赖，请先在该目录运行 pnpm install`)
      return false
    }
    // DSH 桌面端会给自己的子进程注入 ELECTRON_RUN_AS_NODE=1（它的 CLI 需要以 Node 模式跑）。
    // 这个变量一旦被桌宠启动器继承，Electron 就会以 Node 模式加载主进程，
    // 首屏直接 SyntaxError（electron 模块没有 BrowserWindow 导出）然后静默退出。
    // 桌宠是真正的 GUI 应用，所以启动时把该变量从子进程环境里删掉。
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const logPath = path.join(this.options.dshHome, 'dsh-pet', 'launch.log')
    const appendLog = (text: string): void => {
      try {
        mkdirSync(path.dirname(logPath), { recursive: true })
        appendFileSync(logPath, text)
      } catch {
        // 日志写不了不影响启动。
      }
    }
    appendLog(`\n===== ${new Date().toISOString()} summon =====\n`)
    try {
      const child = process.platform === 'win32'
        ? spawn('cmd', ['/c', 'pnpm', 'start'], {
            cwd: petDir,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            env,
          })
        : spawn('pnpm', ['start'], {
            cwd: petDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            env,
          })
      child.stdout?.on('data', chunk => appendLog(String(chunk)))
      child.stderr?.on('data', chunk => appendLog(String(chunk)))
      child.on('error', (error) => {
        appendLog(`[dsh-personal-assistant] spawn error: ${String(error)}\n`)
      })
      return true
    } catch (error) {
      appendLog(`[dsh-personal-assistant] spawn threw: ${String(error)}\n`)
      return false
    }
  }

  /** 会话销毁：通知宠物退场并解除绑定；运行时代次不变，重绑后旧请求仍按原区间结算。 */
  onAgentDisposed(agent: unknown): void {
    // 宿主已回收自建会话（用户在网页里关掉了它，或宿主自己拆了）：只丢引用，不再 dispose 第二次。
    if (this.owned !== null && this.owned.handle.agent === agent) this.owned = null
    if (this.agent === null || agent !== this.agent) return
    this.invalidateAssistantApprovals()
    this.agent = null
    this.teamAgent = null
    this.stopFeed()
    this.mirror.close()
    this.mirror = new SessionMirror(null, payload => this.push({ type: 'session/update', payload }))
    this.mirror.flush()
    this.failPending('主会话已结束')
    this.push({ type: 'session-ended' })
  }

  /**
   * agent 空闲：对当前在飞请求做因果折叠，再放下一条进队请求。
   * 只有本消息所属轮次 turn/end 的 reason.kind==='completed' 且不混入其他用户输入才结算（attribution='causal'）；
   * 轮次未结束保持 pending 等下一次 idle；其余如实失败，绝不拿最后一条 assistant 文本冒充本请求的回复。
   */
  onAgentIdle(agent: unknown): void {
    if (this.agent === null || agent !== this.agent) return
    this.mirror.setStatus('idle')
    this.scanFeed(this.agent)
    if (this.pending === null) return
    const pending = this.pending
    const outcome = settleFromEvents(sessionEventsOf(this.agent), pending)
    if (outcome.kind === 'pending') return
    this.pending = null
    clearTimeout(pending.timer)
    if (outcome.kind === 'settled') {
      pending.resolve({ ok: true, reply: outcome.reply })
      this.push({
        type: 'reply',
        id: pending.requestId,
        ok: true,
        reply: outcome.reply,
        attribution: 'causal',
        assistantId: outcome.assistantId,
        turn: outcome.turn,
        step: outcome.step,
      })
    } else {
      pending.resolve({ ok: false, error: outcome.error })
      this.push({
        type: 'reply',
        id: pending.requestId,
        ok: false,
        error: outcome.error,
        attribution: outcome.attribution,
      })
    }
    this.pump()
  }

  /** 会话流水的游标：`session.events` 是只增日志，按下标走是安全的。 */
  private feedCursor = 0
  private feedTimer: NodeJS.Timeout | null = null

  /**
   * 会话流水：把 `session.events` 里所有「用户看得见」的活动**按发生顺序**推给宠物。
   *
   * 宠物的对话框要和 DSH 会话完全绑定 —— 网页那边出的思考、工具调用、正文，
   * 以及**两边**的输入，都要同步过来。所以这里跟的是**整个会话**，不是某一条请求：
   *
   * - `user`  —— `user/message`（网页或宠物输入都算）
   * - `think` —— `reasoning-delta`（模型的思考过程）
   * - `tool`  —— `tool/call`（工具名 + 参数摘要）
   * - `text`  —— `text-delta`（可见正文）
   *
   * 与被它替换掉的旧实现的差别：旧的只在「宠物发消息」期间推 `text`，而且只推本轮，
   * 于是网页侧的输入、思考、工具调用全都不见，宠物里只剩一段孤零零的正文。
   *
   * 连续的思考片段合并成一条再发：逐 token 推思考只会把气泡刷成一面墙。
   * 最终正文仍由 {@link settleFromEvents} 折叠给出，宠物收到 reply 后只做收尾标记。
   */
  private scanFeed(agent: BridgeAgent): void {
    if (agent !== this.agent || this.closed) return
    // 旧语音链仍按因果轮次标记；不能把网页轮次挂到恰好在等待的宠物请求。
    const pending = this.pending
    const location = pending ? locateTurn(sessionEventsOf(agent), pending.messageId) : null
    const attributable = pending && settleFromEvents(sessionEventsOf(agent), pending).kind !== 'failed'
    const ownedTurn = attributable && location?.kind === 'located' ? location.turn : undefined
    let eventId: string | undefined
    let think = ''
    const emit = (item: { text: string; kind: 'text' | 'think' | 'tool' | 'user'; name?: string; arg?: string }): void => {
      this.push({ type: 'delta', id: eventId, ...item })
    }
    const flushThink = (): void => {
      if (think.length === 0) return
      emit({ text: think, kind: 'think' })
      think = ''
    }
    let events: ReadonlyArray<MirrorEvent>
    try {
      events = sessionEventsOf(agent)
    } catch {
      // 读会话失败不该打断请求：本拍跳过，下一拍再试。
      return
    }
    for (let i = this.feedCursor; i < events.length; i += 1) {
      const event = events[i]
      const data = event.data ?? {}
      this.mirror.observe(event, i)
      const nextId = pending && ((event.type === 'user/message' && data.id === pending.messageId)
        || (ownedTurn !== undefined && data.turn === ownedTurn)) ? pending.requestId : undefined
      if (nextId !== eventId) flushThink()
      eventId = nextId
      if (event.type === 'user/message') {
        // 只推真人输入：runtime-context / time-context 这类注入消息不进对话气泡。
        const sourceKind = (data.source as { kind?: unknown } | undefined)?.kind
        if (typeof sourceKind === 'string' && sourceKind !== '' && sourceKind !== 'user') continue
        flushThink()
        const text = contentText(data.content)
        if (text.length > 0) emit({ text, kind: 'user' })
        continue
      }
      if (event.type === 'tool/call') {
        flushThink()
        emit({
          text: '',
          kind: 'tool',
          name: typeof data.name === 'string' ? data.name : '',
          arg: firstArgument(data.arguments),
        })
        continue
      }
      if (event.type === 'assistant/chunk') {
        const chunk = data.chunk as { type?: unknown; text?: unknown } | undefined
        const text = chunk?.text
        if (typeof text !== 'string' || text.length === 0) continue
        if (chunk?.type === 'reasoning-delta') {
          think += text
          continue
        }
        if (chunk?.type === 'text-delta') {
          flushThink()
          emit({ text, kind: 'text' })
          continue
        }
        // block-start/end、usage、finish 不是给人看的，跳过
      }
    }
    flushThink()
    this.feedCursor = events.length
    // 状态兜底：宿主的事件是作用域分发的，`agent/status` 未必每次都送到插件这一层；
    // 漏一次，宠物的会话状态就永远停在 running —— 界面上表现为"回复早结束了，
    // 角色还在对着电脑敲"。会话日志里出现 turn/end 就说明这一轮确实结束了，据它纠偏。
    if (latestTurnEnded(events)) this.mirror.setStatus('idle')
    this.mirror.flush()
  }

  private startFeed(_agent: BridgeAgent): void {
    if (this.feedTimer !== null) return
    const timer = setInterval(() => {
      if (this.closed || !this.agent) return
      try {
        this.scanFeed(this.agent)
      } catch {
        // 读日志失败不打断请求：回复本身仍会照常结算。
      }
    }, FEED_TICK_MS)
    timer.unref?.()
    this.feedTimer = timer
  }

  /**
   * 会话流水是**绑定期全程**的，不跟着某一条请求走：请求结算后网页那边还会继续说，
   * 那些也得同步过来。所以这里只在解绑/销毁时才停。
   */
  private stopFeed(): void {
    if (this.feedTimer !== null) {
      clearInterval(this.feedTimer)
      this.feedTimer = null
    }
    this.feedCursor = 0
  }

  /** 宠物消息入口：串行排队，前一条结算后才注入下一条，不再踢掉未完成的请求。 */
  enqueueChat(requestId: string, text: string, assistantId?: string): void {
    if (this.closed) {
      this.push({ type: 'reply', id: requestId, ok: false, error: '助理已停止' })
      return
    }
    const member = assistantId ? this.team?.resolveByName(assistantId) ?? this.team?.member(assistantId) : null
    if (assistantId && !member) {
      this.push({ type: 'reply', id: requestId, ok: false, error: `没有叫「${assistantId}」的成员，也不会替你换人` })
      return
    }
    if (member && this.team && this.teamAgent) {
      const running = this.runTeamTask(requestId, text, member)
      this.inflightTasks.set(requestId, running)
      return
    }
    if (this.queue.length >= MAX_PENDING_REQUESTS) {
      this.push({
        type: 'reply',
        id: requestId,
        ok: false,
        error: `助理正忙（前面还有 ${this.queue.length} 条在排队），这条没有受理，请稍后再发`,
      })
      return
    }
    this.queue.push({ requestId, text })
    this.pump()
  }

  /** 点名成员：建任务 → 子代理执行 → 用 run.result 归属回复。 */
  private runTeamTask(requestId: string, text: string, member: MemberConfig): Promise<void> {
    const team = this.team
    const parent = this.teamAgent
    if (!team || !parent) return Promise.resolve()
    const task = team.submitTask({
      goal: text,
      ownerId: member.assistantId,
      toolScope: member.toolPolicy.mode,
      originRequestId: requestId,
      originChannel: 'desktop-pet',
    })
    rememberBounded(this.requestTasks, requestId, task.taskId)
    this.push({
      type: 'task/created',
      id: requestId,
      taskId: task.taskId,
      assistantId: member.assistantId,
      displayName: member.displayName,
      skinId: member.skinId,
      status: task.status,
      payload: { goal: task.goal },
    })
    const signal = new AbortController().signal
    return team
      .runTask(task.taskId, parent, signal)
      .then(() => undefined)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.push({ type: 'reply', id: requestId, ok: false, error: `${member.displayName}执行失败：${message}`, attribution: 'task' })
      })
  }

  /**
   * 按宠物请求 id 定向取消（POST /chat/cancel）。回执描述那次运行的真实状态，HTTP 返回不代表任务终止：
   * - 还在插件队列里：撤回，回执 not-executed；
   * - 已注入共享主会话：只有确认消息还没进入模型、且宿主收件箱撤回成功才算 not-executed；否则只停止本地
   *   等待并报 unknown（后台是否停止未知）——宿主没有定向取消，绝不取消整个共享 agent，也不自动重发；
   * - 点名成员的团队委派：对插件持有的子代理定向取消，回执带运行结束与释放证据。
   * 被取消请求随后到达的结果一律不复活成成功回复。
   */
  async cancelChat(requestId: string): Promise<{ status: number; receipt: CancelReceipt }> {
    const at = Date.now()
    const queuedIndex = this.queue.findIndex(item => item.requestId === requestId)
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1)
      const receipt: CancelReceipt = {
        state: 'not-executed', evidence: { kind: 'queue-withdrawn', at, requestId },
        message: '已撤回：这条消息还在助理队列里，没有交给 agent，未执行',
      }
      return { status: 200, receipt: this.settleCancelled(requestId, receipt) }
    }

    const pending = this.pending
    if (pending && pending.requestId === requestId) {
      const agent = this.agent
      let location: TurnLocation = { kind: 'not-entered' }
      try {
        if (agent) location = locateTurn(sessionEventsOf(agent), pending.messageId)
      } catch {
        location = { kind: 'no-turn' }
      }
      // 只有确认没进入模型时才尝试撤回；进了模型的消息撤回也收不回已经开始的轮次。
      let removed = false
      if (location.kind === 'not-entered') {
        try {
          removed = agent?.inbox?.remove(pending.messageId) ?? false
        } catch {
          removed = false
        }
      }
      this.pending = null
      clearTimeout(pending.timer)
      // 所在轮次其实已经有 turn/end（只是 idle 还没来）：运行确已结束，按「已终止」如实报，结果不再作为回复。
      let ended = false
      if (agent && location.kind === 'located') {
        try {
          const events = sessionEventsOf(agent)
          for (let i = location.turnStartIndex + 1; i < events.length && !ended; i += 1) {
            const event = events[i]
            ended = event.type === 'turn/end' && asNumber((event.data as { turn?: unknown }).turn) === location.turn
          }
        } catch {
          ended = false
        }
      }
      const receipt: CancelReceipt = removed
        ? {
            state: 'not-executed', evidence: { kind: 'inbox-withdrawn', at, requestId, messageId: pending.messageId },
            message: '已撤回：这条消息还在会话收件箱里、没有被领取，未执行',
          }
        : ended && location.kind === 'located'
          ? {
              state: 'terminated',
              evidence: { kind: 'already-settled', at, requestId, messageId: pending.messageId, detail: `第 ${location.turn} 轮已有 turn/end` },
              message: '这条请求所在的轮次在取消前已经结束；按你的取消，结果不再作为回复',
            }
          : {
            state: 'unknown',
            evidence: {
              kind: 'shared-session', at, requestId, messageId: pending.messageId,
              detail: location.kind === 'located' ? `消息已进入第 ${location.turn} 轮` : '消息已交给会话，宿主没有提供可确认的撤回',
            },
            message: SHARED_SESSION_CANCEL_MESSAGE,
          }
      pending.resolve({ ok: false, error: receipt.message })
      const settled = this.settleCancelled(requestId, receipt)
      // 这条不再占着串行位：后面排队的照常注入；它所在轮次之后的结果也不会再归给它。
      this.pump()
      return { status: 200, receipt: settled }
    }

    const taskId = this.requestTasks.get(requestId)
    if (taskId !== undefined) {
      const result = await this.cancelTeamTask(taskId, requestId)
      return { status: result.status, receipt: { ...result.receipt, evidence: { ...result.receipt.evidence, requestId } } }
    }

    const previous = this.cancelReceipts.get(requestId)
    if (previous) return { status: 200, receipt: previous }
    if (this.settledRequests.has(requestId)) {
      return {
        status: 200,
        receipt: {
          state: 'terminated', evidence: { kind: 'already-settled', at, requestId },
          message: '这条请求在取消前已经结束，结果不因这次取消而改变',
        },
      }
    }
    return {
      status: 404,
      receipt: {
        state: 'unknown', evidence: { kind: 'not-found', at, requestId },
        message: '助理这边找不到这条请求（可能来自之前的运行时），后台状态未知，不会自动重发',
      },
    }
  }

  /**
   * 按团队任务 id 定向取消（POST /team/cancel，或 /chat/cancel 命中团队委派）。
   * 只作用于插件持有的子代理，用它已有的 AbortSignal 与 dispose 收敛，不碰共享主会话。
   */
  async cancelTeamTask(taskId: string, requestId?: string): Promise<{ status: number; receipt: CancelReceipt }> {
    const team = this.team
    const at = Date.now()
    if (!team) {
      return {
        status: 404,
        receipt: {
          state: 'unknown', evidence: { kind: 'not-found', at, taskId, detail: 'team-disabled' },
          message: '团队模式没有开启，找不到可取消的团队任务；后台状态未知',
        },
      }
    }
    const origin = team.getTask(taskId)?.originRequestId ?? requestId
    // 先登记再取消：取消收尾时团队发出的 reply/done 不得复活成成功回复。
    if (origin) rememberBounded(this.cancelledRequests, origin)
    let receipt: CancelReceipt | null
    try {
      receipt = await team.cancelWithReceipt(taskId)
    } catch (error) {
      receipt = {
        state: 'unknown', evidence: { kind: 'cancel-error', at, taskId, detail: describeError(error) },
        message: '取消团队任务时出错，任务是否停止无法确认；不会自动重发',
      }
    }
    this.notifyApprovalSnapshot()
    if (!receipt) {
      return {
        status: 404,
        receipt: { state: 'unknown', evidence: { kind: 'not-found', at, taskId }, message: `找不到团队任务 ${taskId}，后台状态未知` },
      }
    }
    return { status: 200, receipt }
  }

  /** 暂停 / 恢复团队后续步骤（POST /team/pause）。团队没开时如实返回 false。 */
  pauseTeam(paused: boolean): { ok: boolean; paused: boolean; message: string } {
    const team = this.team
    if (!team) return { ok: false, paused: false, message: '团队模式没有开启，没有可暂停的后续步骤' }
    team.setFollowupsPaused(paused)
    this.notifyApprovalSnapshot()
    return {
      ok: true, paused,
      message: paused
        ? '已暂停团队后续步骤：排队任务不会开始，在跑的任务照常结束（要停下它请用取消）'
        : '已恢复团队后续步骤：之后的任务可以开始，暂停期间排队的任务不会自动补跑',
    }
  }

  /** 主会话请求取消后的收尾：记回执、标记已取消、推一条带回执的失败 reply 结束所有等待方。 */
  private settleCancelled(requestId: string, receipt: CancelReceipt): CancelReceipt {
    rememberBounded(this.cancelReceipts, requestId, receipt)
    rememberBounded(this.cancelledRequests, requestId)
    this.push({ type: 'reply', id: requestId, ok: false, error: receipt.message, cancel: receipt })
    return receipt
  }

  private failPending(error: string): void {
    const pending = this.pending
    if (pending) {
      this.pending = null
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, error })
      this.push({ type: 'reply', id: pending.requestId, ok: false, error })
    }
    for (const item of this.queue.splice(0)) {
      this.push({ type: 'reply', id: item.requestId, ok: false, error })
    }
  }

  /** 队列里还有请求且当前无在飞请求时，注入下一条。 */
  private pump(): void {
    if (this.pending !== null || this.closed) return
    const next = this.queue.shift()
    if (!next) return
    void this.handleChat(next.requestId, next.text).catch(() => undefined)
  }

  /**
   * 插件卸载：通知宠物退场、停团队轮询、关闭服务、清理本实例写过的发现文件，并按所有权释放自建会话。
   * 同步部分立即生效；返回的 Promise 在自建会话释放完（或等满上限）后落定，宿主卸载时可以等它。
   * 网页召唤来的会话从不在这里 dispose 或 cancel——它不归桥接所有。
   */
  dispose(): Promise<void> {
    if (this.closed) return this.disposal
    this.closed = true
    this.desktopCommands.dispose()
    this.companion?.stopAccepting()
    this.assistantApprovals?.invalidateAll()
    this.stopFeed()
    this.mirror.close()
    if (this.teamTimer) {
      clearInterval(this.teamTimer)
      this.teamTimer = null
    }
    if (this.agent !== null) {
      this.agent = null
      this.push({ type: 'session-ended' })
    }
    this.failPending('助理已停止')
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.res([])
    }
    this.waiters = []
    // 只删自己写的：另一个运行时可能已经接管了这两份文件，删掉等于把它的宠物连接也一起断了。
    if (this.advertised) {
      for (const file of [this.infoPath, this.approvalPath]) this.removeIfOwn(file)
    }
    if (this.server) {
      const server = this.server
      this.server = null
      server.close(() => undefined)
      // 空闲的 keep-alive 连接不会自己断，不收掉的话服务要再挂几秒才真正关上。
      server.closeIdleConnections?.()
    }
    const owned = this.owned
    this.owned = null
    if (owned === null) return this.disposal
    const release = owned.handle.dispose().catch(error => {
      this.options.logger?.warn?.(`owned session ${owned.sessionId} release failed: ${describeError(error)}`)
    })
    let timer: NodeJS.Timeout | undefined
    const ceiling = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        this.options.logger?.warn?.(`owned session ${owned.sessionId} still releasing after ${OWNED_RELEASE_WAIT_MS}ms; continuing unload`)
        resolve()
      }, OWNED_RELEASE_WAIT_MS)
      timer.unref?.()
    })
    this.disposal = Promise.race([release, ceiling]).finally(() => clearTimeout(timer))
    return this.disposal
  }

  /** 文件内容仍是本实例（同一 epoch）写的才删；读不懂的文件宁可留着。 */
  private removeIfOwn(file: string): void {
    try {
      const written = JSON.parse(readFileSync(file, 'utf8')) as { epoch?: unknown }
      if (written.epoch !== this.epoch) return
      rmSync(file, { force: true })
    } catch {
      // 文件可能不存在、正被另一实例改写或已损坏；清理失败不影响退出
    }
  }

  private ensureListening(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('bridge already disposed'))
    if (this.listening === null) {
      this.listening = this.openServer().catch(error => {
        this.listening = null
        throw error
      })
    }
    return this.listening
  }

  private async openServer(): Promise<void> {
    const token = randomUUID()
    const server = http.createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    // 监听之后的错误（例如句柄耗尽时 accept 失败）只记日志：没有监听器的 error 事件会让宿主进程崩溃。
    server.on('error', error => this.options.logger?.warn?.(`session bridge server error: ${describeError(error)}`))
    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close(() => undefined)
      throw new Error('bridge server failed to listen')
    }
    if (this.closed) {
      server.close(() => undefined)
      throw new Error('bridge already disposed')
    }
    this.token = token
    this.server = server
    this.port = address.port
    this.startedAt = Date.now()
    this.options.logger?.info(`session bridge listening on 127.0.0.1:${this.port}`)
  }

  /** 写发现文件与审批凭据：宠物与桌面壳据此找到本运行时。内容不变时重写也无副作用。 */
  private advertise(): void {
    if (this.closed || !this.server) return
    mkdirSync(path.dirname(this.infoPath), { recursive: true })
    writeFileSync(
      this.infoPath,
      `${JSON.stringify({
        port: this.port,
        token: this.token,
        pid: process.pid,
        epoch: this.epoch,
        startedAt: this.startedAt,
      })}\n`,
      'utf8',
    )
    this.advertised = true
    this.writeApprovalCredential()
  }

  /**
   * 发现文件是否属于另一个仍在应答的桥接（不同 epoch、/health 用它自己的令牌答得上来）。
   * 文件不存在、读不懂、就是自己，或对方不应答，都返回 null——那份文件没人在用，可以接手。
   */
  private async healthyIncumbent(): Promise<{ pid?: number } | null> {
    let info: { port?: unknown; token?: unknown; epoch?: unknown; pid?: unknown }
    try {
      info = JSON.parse(readFileSync(this.infoPath, 'utf8')) as typeof info
    } catch {
      return null
    }
    if (typeof info.port !== 'number' || typeof info.token !== 'string' || info.epoch === this.epoch) return null
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/health?token=${encodeURIComponent(info.token)}`, {
        signal: AbortSignal.timeout(INCUMBENT_PROBE_MS),
      })
      if (!response.ok) return null
      const body = await response.json() as { ok?: unknown; epoch?: unknown }
      if (body.ok !== true || (typeof info.epoch === 'string' && body.epoch !== info.epoch)) return null
      return typeof info.pid === 'number' ? { pid: info.pid } : {}
    } catch {
      return null
    }
  }

  /** 凭据不经 IPC 或模型工具暴露；本地文件不是沙箱，不能防任意本地文件读取者。 */
  writeApprovalCredential(approvals: ApprovalService | null = this.approvals): void {
    mkdirSync(path.dirname(this.approvalPath), { recursive: true })
    writeFileSync(
      this.approvalPath,
      `${JSON.stringify({
        approvalToken: approvals?.approvalCapabilityToken,
        reportApprovalToken: this.reportApprovals?.approvalCapabilityToken,
        assistantApprovalToken: this.assistantApprovals?.approvalCapabilityToken,
        companionOwnerToken: this.companionOwnerToken,
        companionExecutorToken: this.companionExecutorToken,
        epoch: this.epoch,
        port: this.port,
      })}\n`,
      'utf8',
    )
  }

  private authorized(url: URL): boolean {
    return url.searchParams.get('token') === this.token
  }

  private presentedCompanionToken(request: http.IncomingMessage): string | null {
    const header = request.headers['x-dsh-companion-token']
    return typeof header === 'string' ? header : null
  }

  private verifyToken(presented: string | null, expected: string): boolean {
    if (presented === null) return false
    const a = Buffer.from(presented)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private async handleCompanion(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    subject: CompanionSubject,
  ): Promise<void> {
    if (url.pathname === '/companion/v1/desktop/claim') {
      if (request.method !== 'POST') { this.respond(response, 405, { claimed: false }); return }
      if (subject !== 'owner') { this.respond(response, 403, { claimed: false }); return }
      try {
        const claimed = this.desktopCommands.claim(JSON.parse(await this.readBody(request)) as unknown)
        this.respond(response, claimed ? 200 : 409, { claimed })
      } catch { this.respond(response, 400, { claimed: false }) }
      return
    }
    if (url.pathname === '/companion/v1/desktop/result') {
      if (request.method !== 'POST') { this.respond(response, 405, { accepted: false }); return }
      if (subject !== 'owner') { this.respond(response, 403, { ok: false, code: 'FORBIDDEN', message: '桌面命令回执只接受本机所有者凭据' }); return }
      try {
        // 会议纪要可含多字节中文；仍有界且仅接受本机所有者凭据。
        const accepted = this.desktopCommands.resolve(JSON.parse(await this.readBody(request, 512_000)) as unknown)
        this.respond(response, accepted ? 200 : 409, { accepted })
      } catch { this.respond(response, 400, { accepted: false }) }
      return
    }
    const runtime = this.companion
    if (!runtime) {
      this.respond(response, 503, { ok: false, code: 'COMPANION_UNAVAILABLE', message: '普通任务运行时未装配' })
      return
    }
    try {
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      const body = hasBody ? JSON.parse(await this.readBody(request)) as unknown : null
      const result = await runtime.request(request.method ?? 'GET', url.pathname, body, subject, url.searchParams)
      this.respond(response, result.status, result.body)
    } catch (error) {
      if (error instanceof CompanionError) {
        this.respond(response, error.status, { ok: false, code: error.code, message: error.message })
        return
      }
      this.respond(response, 400, { ok: false, error: error instanceof Error ? error.message : '请求格式无效' })
    }
  }

  private async handleExecutor(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const runtime = this.companion
    if (!runtime) {
      this.respond(response, 503, { ok: false, code: 'COMPANION_UNAVAILABLE', message: '普通任务运行时未装配' })
      return
    }
    try {
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      const body = hasBody ? JSON.parse(await this.readBody(request)) as unknown : null
      const result = await runtime.request(request.method ?? 'GET', url.pathname, body, 'executor', url.searchParams)
      this.respond(response, result.status, result.body)
    } catch (error) {
      if (error instanceof CompanionError) {
        this.respond(response, error.status, { ok: false, code: error.code, message: error.message })
        return
      }
      this.respond(response, 400, { ok: false, error: error instanceof Error ? error.message : '请求格式无效' })
    }
  }

  private trackCompanionRequest(work: Promise<void>): void {
    this.companionRequests.add(work)
    void work.finally(() => this.companionRequests.delete(work))
  }

  private respond(response: http.ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) {
      response.end()
      return
    }
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }

  /**
   * 未绑定会话时审批一律不受理（凭据核对之后才判，不向没有凭据的调用方透露绑定状态）。
   * message 是可展示的原因——桌面壳优先展示 message，error 留给程序分支。
   */
  private rejectUnboundApproval(response: http.ServerResponse): boolean {
    if (this.bound) return false
    this.respond(response, 503, { ok: false, error: 'UNBOUND', code: UNBOUND_CODE, message: UNBOUND_APPROVAL_ERROR })
    return true
  }

  private async readBody(request: http.IncomingMessage, limitBytes = 65_536): Promise<string> {
    let raw = ''
    request.setEncoding('utf8')
    for await (const chunk of request) {
      raw += chunk as string
      if (raw.length > limitBytes) throw new Error('request body too large')
    }
    return raw
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.port}`)
    // 审批只认独立凭据：桌面壳只读 bridge-approval.json，拿不到聊天令牌，
    // 所以这条路由必须在聊天令牌校验之前处理，两种凭据互不通用。
    if (request.method === 'POST' && url.pathname === '/assistant-approval') {
      await this.handleAssistantApproval(request, response)
      return
    }
    if (request.method === 'POST' && url.pathname === '/report-approval') {
      this.handleReportApproval(request, response).catch(() => this.respond(response, 500, { error: '日报审批结果待核对，请勿重发' }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/approval') {
      this.handleApproval(request, response).catch(() => this.respond(response, 500, { error: 'approval failed' }))
      return
    }
    // 普通任务与执行器各有独立凭据：聊天令牌只能读/建请求，不能替用户回应或批准。
    if (url.pathname.startsWith('/executor/v1/')) {
      if (!this.verifyToken(this.presentedCompanionToken(request), this.companionExecutorToken)) {
        this.respond(response, 403, { error: 'executor credential rejected' })
        return
      }
      this.trackCompanionRequest(this.handleExecutor(request, response, url))
      return
    }
    if (url.pathname.startsWith('/companion/v1/')) {
      const owner = this.verifyToken(this.presentedCompanionToken(request), this.companionOwnerToken)
      if (!owner && !this.authorized(url)) {
        this.respond(response, 401, { error: 'unauthorized' })
        return
      }
      this.trackCompanionRequest(this.handleCompanion(request, response, url, owner ? 'owner' : 'client'))
      return
    }
    if (!this.authorized(url)) {
      this.respond(response, 401, url.pathname === '/session' ? { ok: false, error: 'unauthorized' } : { error: 'unauthorized' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      // 没有接采集状态时不带 activity 字段（宠物把缺省与 null 当成同一回事）。
      this.respond(response, 200, {
        ok: true, bound: this.bound, epoch: this.epoch, team: this.teamEnabled,
        ...(this.options.activityState ? { activity: this.options.activityState() } : {}),
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/team') {
      this.respond(response, 200, { epoch: this.epoch, team: this.teamEnabled, ...this.teamSnapshot() })
      return
    }
    if (request.method === 'POST' && url.pathname === '/session/start') {
      try {
        await this.readBody(request).catch(() => '')
        const result = await this.startSession()
        this.respond(response, result.ok ? 200 : result.code === 'start-failed' ? 500 : 503, result)
      } catch (error) {
        this.respond(response, 500, { ok: false, code: 'start-failed', error: `开始会话失败：${describeError(error)}` })
      }
      return
    }
    if (url.pathname === '/session' && (request.method === 'GET' || request.method === 'POST')) {
      // 读快照照常（未绑定时它如实是 disconnected、sessionId=null）；会话命令没有会话可发，明确拒绝。
      if (request.method === 'POST' && !this.bound) {
        this.respond(response, 503, { ok: false, code: UNBOUND_CODE, error: UNBOUND_SESSION_ERROR })
        return
      }
      try {
        const result = request.method === 'POST'
          ? await this.sessionCommand(JSON.parse(await this.readBody(request)))
          : await this.getSession(url.searchParams.has('beforeSeq') ? Number(url.searchParams.get('beforeSeq')) : undefined,
            url.searchParams.get('bindingId') ?? undefined)
        this.respond(response, result.ok ? 200 : 409, result)
      } catch (error) {
        this.respond(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0
      const reset = since < (this.events[0]?.seq ?? 1) - 1 || since > this.seq
      const ready = this.events.filter((event) => event.seq > since)
      if (ready.length > 0 || reset) {
        this.respond(response, 200, { events: ready, epoch: this.epoch, ...(reset ? { reset: true } : {}) })
        return
      }
      const events = await new Promise<BridgeEvent[]>(resolve => {
        const waiter: EventWaiter = {
          seq: since,
          res: resolve,
          timer: setTimeout(() => {
            this.waiters = this.waiters.filter((item) => item !== waiter)
            resolve([])
          }, LONG_POLL_TIMEOUT_MS),
        }
        this.waiters.push(waiter)
      })
      this.respond(response, 200, { events, epoch: this.epoch })
      return
    }
    if (request.method === 'POST' && url.pathname === '/chat') {
      // 没有绑定会话时不受理：以前这里先回 accepted 再异步报失败，看上去像发出去了。
      if (!this.bound) {
        this.respond(response, 503, { error: UNBOUND_CHAT_ERROR, code: UNBOUND_CODE })
        return
      }
      try {
        const body = JSON.parse(await this.readBody(request)) as {
          requestId?: string
          id?: string
          text?: string
          assistantId?: string
          epoch?: string
          bindingId?: string
        }
        if (body.bindingId !== undefined && body.bindingId !== this.mirror.bindingId) {
          this.respond(response, 409, { error: 'stale binding' })
          return
        }
        if (typeof body.epoch === 'string' && body.epoch !== this.epoch) {
          this.respond(response, 409, { error: 'stale epoch', epoch: this.epoch })
          return
        }
        const requestId =
          typeof body.requestId === 'string' && body.requestId
            ? body.requestId
            : typeof body.id === 'string' && body.id
              ? body.id
              : randomUUID()
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) {
          this.respond(response, 400, { error: 'empty text' })
          return
        }
        if (this.queue.length >= MAX_PENDING_REQUESTS) {
          this.respond(response, 429, { error: 'too many pending requests' })
          return
        }
        this.enqueueChat(requestId, text, typeof body.assistantId === 'string' ? body.assistantId : undefined)
        this.respond(response, 200, { accepted: true, requestId, epoch: this.epoch })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'malformed body'
        this.respond(response, 400, { error: message })
      }
      return
    }
    if (request.method === 'POST' && (url.pathname === '/proactive/accept' || url.pathname === '/proactive/decline'
      || url.pathname === '/proactive/disable' || url.pathname === '/proactive/enable')) {
      const kind = url.pathname.split('/').pop() as 'accept' | 'decline' | 'disable' | 'enable'
      this.handleProactiveFeedback(request, response, kind)
      return
    }
    if (request.method === 'POST' && url.pathname === '/pet-state') {
      try {
        const body = JSON.parse(await this.readBody(request)) as { focus?: unknown; visible?: unknown; meeting?: unknown }
        if (typeof body.focus === 'boolean') this.petState.focus = body.focus
        if (typeof body.visible === 'boolean') this.petState.visible = body.visible
        if (typeof body.meeting === 'boolean') this.petState.meeting = body.meeting
        this.respond(response, 200, { ok: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'malformed body'
        this.respond(response, 400, { error: message })
      }
      return
    }
    if (request.method === 'POST' && (url.pathname === '/chat/cancel' || url.pathname === '/team/cancel' || url.pathname === '/team/pause')) {
      await this.handleCancelRoute(request, response, url.pathname)
      return
    }
    if (request.method === 'POST' && url.pathname === '/evidence/intake') {
      await this.handleEvidenceIntake(request, response)
      return
    }
    if (url.pathname.startsWith('/workbench/')) {
      await this.handleWorkbench(request, response, url)
      return
    }
    this.respond(response, 404, { error: 'not found' })
  }

  /**
   * 外部证据收件（M3-03 / M4-06 后续），复用聊天令牌（鉴权已在 handle 入口完成）。
   *
   * 这条路由**不判断"该不该收"**：授权在数据产生的那一刻由桌面壳弹原生对话框拿到。
   * 这里只做形状校验与入库，并把"收下了什么"如实回给调用方 —— 200 一定意味着真的入库了，
   * 失败给具体原因（界面原样显示给用户）。
   */
  private async handleEvidenceIntake(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const intake = this.options.evidenceIntake
    if (!intake) {
      this.respond(response, 503, { ok: false, error: '这个构建没有接上证据库，不能收件' })
      return
    }
    let body: unknown
    try {
      // 上限比正文上限略宽：JSON 转义、标题、字段名都要算进去。
      body = JSON.parse(await this.readBody(request, EVIDENCE_INTAKE_BODY_LIMIT))
    } catch (error) {
      const tooLarge = describeError(error).includes('too large')
      this.respond(response, tooLarge ? 413 : 400, {
        ok: false,
        error: tooLarge ? '正文超过上限，请分段记录后再收' : `请求体不是合法 JSON：${describeError(error)}`,
      })
      return
    }
    let result: IntakeResult
    try {
      result = intake(body)
    } catch (error) {
      // 入库失败（库锁、磁盘满）：如实 500，绝不说"收下了"。
      this.respond(response, 500, { ok: false, error: `收件失败：${describeError(error)}` })
      return
    }
    this.respond(response, result.ok ? 200 : 400, result)
  }

  /**
   * 定向取消与暂停（M1-06），复用聊天令牌（鉴权已在 handle 入口完成）。未绑定按现有规则 503 unbound。
   * 返回结构化回执 { ok, state, evidence, message }：state 描述运行的真实状态，HTTP 200 不代表任务已终止。
   */
  private async handleCancelRoute(request: http.IncomingMessage, response: http.ServerResponse, pathname: string): Promise<void> {
    if (!this.bound) {
      this.respond(response, 503, { ok: false, code: UNBOUND_CODE, error: UNBOUND_CANCEL_ERROR, message: UNBOUND_CANCEL_ERROR })
      return
    }
    let body: { id?: unknown; requestId?: unknown; taskId?: unknown; paused?: unknown }
    try {
      body = JSON.parse(await this.readBody(request)) as typeof body
    } catch (error) {
      this.respond(response, 400, { ok: false, error: error instanceof Error ? error.message : 'malformed body' })
      return
    }
    const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
    try {
      if (pathname === '/team/pause') {
        if (typeof body.paused !== 'boolean') {
          this.respond(response, 400, { ok: false, error: 'paused 必须是布尔值' })
          return
        }
        const result = this.pauseTeam(body.paused)
        this.respond(response, result.ok ? 200 : 404, result)
        return
      }
      if (pathname === '/team/cancel') {
        const taskId = text(body.taskId) ?? text(body.id)
        if (!taskId) {
          this.respond(response, 400, { ok: false, error: '必须指定 taskId' })
          return
        }
        const { status, receipt } = await this.cancelTeamTask(taskId)
        this.respond(response, status, { ok: status === 200, ...receipt })
        return
      }
      const requestId = text(body.id) ?? text(body.requestId)
      if (!requestId) {
        this.respond(response, 400, { ok: false, error: '必须指定请求 id' })
        return
      }
      const { status, receipt } = await this.cancelChat(requestId)
      this.respond(response, status, { ok: status === 200, ...receipt })
    } catch (error) {
      this.respond(response, 500, {
        ok: false, state: 'unknown', evidence: { kind: 'cancel-error', at: Date.now(), detail: describeError(error) },
        message: '取消请求处理失败，后台状态未知；不会自动重发',
      })
    }
  }

  /**
   * 日报工作台与历史/删除管理（M3-04/M3-05）。复用聊天令牌：工作台只能读、改草稿（产生新版本）、
   * 请求发布与请求删除——这些都只会生成待批提案，批准仍只认独立审批凭据与专用审批窗口。
   * 读视图在未绑定时照常（与读会话快照同一口径）；写操作没有会话可承接审批，统一 503 unbound。
   */
  private async handleWorkbench(request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
    const service = this.workbench
    if (!service) {
      this.respond(response, 404, { ok: false, code: 'not_wired', error: '日报工作台未装配' })
      return
    }
    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'POST') {
      this.respond(response, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (method === 'POST' && !this.bound) {
      this.respond(response, 503, { ok: false, code: UNBOUND_CODE, error: UNBOUND_WORKBENCH_ERROR, message: UNBOUND_WORKBENCH_ERROR })
      return
    }
    let body: unknown
    if (method === 'POST') {
      try {
        body = JSON.parse(await this.readBody(request, WORKBENCH_BODY_LIMIT))
      } catch (error) {
        this.respond(response, 400, { ok: false, error: error instanceof Error ? error.message : 'malformed body' })
        return
      }
    }
    try {
      const result = await service.handle(method, url.pathname.slice('/workbench'.length), url.searchParams, body)
      this.respond(response, result.status, result.body)
    } catch (error) {
      this.respond(response, 500, { ok: false, error: `工作台处理失败：${describeError(error)}` })
    }
  }

  /** 挂上日报工作台服务（index 装配一次）。 */
  attachWorkbench(handler: WorkbenchHandler): void {
    this.workbench = handler
  }

  /**
   * 主动提醒的用户反馈（design.md §2.7）。只认聊天令牌：这些端点改变的是提醒节奏，
   * 不触发任何副作用，与 /chat 同级；审批才需要独立凭据。
   */
  private handleProactiveFeedback(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    kind: 'accept' | 'decline' | 'disable' | 'enable',
  ): void {
    void this.readBody(request)
      .then(() => {
        this.proactiveFeedback?.(kind)
        this.respond(response, 200, { ok: true })
      })
      .catch(() => this.respond(response, 400, { error: 'malformed body' }))
  }

  private async handleAssistantApproval(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const service = this.assistantApprovals
    if (!service) { this.respond(response, 404, { error: '助理审批未装配' }); return }
    const header = request.headers['x-dsh-approval-token']
    const token = typeof header === 'string' ? header : undefined
    if (!service.verifyCapabilityToken(token)) { this.respond(response, 403, { error: '助理审批凭据无效' }); return }
    if (this.rejectUnboundApproval(response)) return
    try {
      const body = JSON.parse(await this.readBody(request))
      if (typeof body.proposalId !== 'string' || (body.decision !== 'approve' && body.decision !== 'reject')) {
        this.respond(response, 400, { error: '必须指定提案和明确的审批决定' }); return
      }
      const result = await service.decide(body.proposalId, body.decision, body.epoch, token)
      this.push({ type: 'proposal/decided', payload: { proposalId: body.proposalId, kind: 'assistant', ...result } })
      this.respond(response, result.ok ? 200 : 409, result)
    } catch {
      this.respond(response, 400, { ok: false, error: '助理审批失败，请核查状态，不可自动重发' })
    } finally { this.notifyApprovalSnapshot() }
  }

  private async handleReportApproval(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const service = this.reportApprovals
    if (!service) {
      this.respond(response, 404, { error: '日报可信审批未装配' })
      return
    }
    const header = request.headers['x-dsh-approval-token']
    const token = typeof header === 'string' ? header : undefined
    if (!service.verifyCapabilityToken(token)) {
      this.respond(response, 403, { error: '日报审批凭据无效' })
      return
    }
    if (this.rejectUnboundApproval(response)) return
    try {
      const body = JSON.parse(await this.readBody(request)) as { proposalId?: unknown; decision?: unknown; epoch?: unknown }
      if (typeof body.proposalId !== 'string' || (body.decision !== 'approve' && body.decision !== 'reject')) {
        this.respond(response, 400, { error: '必须指定提案和明确的审批决定' })
        return
      }
      const result = await service.decide(body.proposalId, body.decision, typeof body.epoch === 'string' ? body.epoch : '', token)
      this.push({ type: 'proposal/decided', payload: { proposalId: body.proposalId, kind: 'report', ...result } })
      this.respond(response, result.ok ? 200 : 409, result)
    } catch (error) {
      this.respond(response, error instanceof ApprovalError ? 409 : 400, {
        error: error instanceof ApprovalError ? error.code : 'REPORT_APPROVAL_FAILED',
        message: error instanceof Error ? error.message : '日报审批失败',
      })
    } finally {
      this.notifyApprovalSnapshot()
    }
  }

  /** 审批只认独立凭据；聊天令牌不能签发批准，模型工具也调不到这里。 */
  private async handleApproval(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const approvals = this.approvals
    if (!approvals) {
      this.respond(response, 404, { error: 'team mode is not enabled' })
      return
    }
    const presented = request.headers['x-dsh-approval-token']
    if (!approvals.verifyCapabilityToken(typeof presented === 'string' ? presented : undefined)) {
      this.respond(response, 403, { error: 'approval credential rejected' })
      return
    }
    if (this.rejectUnboundApproval(response)) return
    try {
      const body = JSON.parse(await this.readBody(request)) as {
        proposalId?: string
        decision?: 'approve' | 'reject'
        epoch?: string
        windowId?: number
      }
      approvals.assertEpoch(typeof body.epoch === 'string' ? body.epoch : '')
      const proposalId = typeof body.proposalId === 'string' ? body.proposalId : ''
      if (!proposalId) {
        this.respond(response, 400, { error: 'proposalId required' })
        return
      }
      if (body.decision === 'approve') {
        const approval = approvals.issue(proposalId, { channel: 'desktop-shell', windowId: body.windowId }, true)
        this.respond(response, 200, { ok: true, approvalId: approval.approvalId, expiresAt: approval.expiresAt })
        return
      }
      approvals.reject(proposalId, { channel: 'desktop-shell', windowId: body.windowId }, true)
      this.respond(response, 200, { ok: true, decision: 'rejected' })
    } catch (error) {
      if (error instanceof ApprovalError) {
        this.respond(response, 409, { error: error.code, message: error.message })
        return
      }
      this.respond(response, 400, { error: error instanceof Error ? error.message : 'malformed body' })
    }
  }

  private async handleChat(requestId: string, text: string): Promise<void> {
    const agent = this.agent
    if (!agent) {
      this.push({ type: 'reply', id: requestId, ok: false, error: '主会话不可用：请先在 dsh 里开启个人助理并召唤宠物' })
      this.pump()
      return
    }
    // 网页上下文只带入紧接着的这一次对话；内容是材料，不是指令或授权。
    let context: string | null = null
    if (!text.startsWith('/')) {
      try { context = this.chatContextProvider?.() ?? null } catch { context = null }
    }
    // 先造消息、留住它的稳定 id：因果折叠按它在 session.events 里定位本消息所属轮次，超时按它撤回。
    const message = createUserMessage({
      content: [{ type: 'text', text: context ? `${context}\n${text}` : text }],
      // 宠物面板输入的就是用户本人的话。plugin 来源会被 dsh web 折叠成
      // 「上下文注入」一行，用户在网页上看不到自己说了什么。
      source: { kind: 'user' },
    })
    const messageId = message.id as string
    const timeoutMs = this.options.replyTimeoutMs ?? REPLY_TIMEOUT_MS

    let resolveReply: (reply: { ok: boolean; reply?: string; error?: string }) => void = () => undefined
    const replyPromise = new Promise<{ ok: boolean; reply?: string; error?: string }>((resolve) => {
      resolveReply = resolve
    })
    const timer = setTimeout(() => {
      if (this.pending?.requestId !== requestId) return
      const pending = this.pending
      this.pending = null
      // 先尝试撤回还没被领取的消息；remove=true 才算真的取消成功。
      let removed = false
      try {
        removed = agent.inbox?.remove(messageId) ?? false
      } catch {
        removed = false
      }
      // removed=false：消息已被领取或已在执行。此时不能 cancel 整个共享 agent（会误伤网页端），
      // 只能如实报 timeout，并声明后台可能仍在运行、不自动重发。
      const error = removed
        ? '助理响应超时：已撤回这条还没开始处理的消息（cancelled）'
        : '助理响应超时：消息可能已在后台处理，我不会自动重发，也不会取消整个共享会话'
      pending.resolve({ ok: false, error })
      this.push({ type: 'reply', id: requestId, ok: false, error })
      this.pump()
    }, timeoutMs)
    const pending: PendingRequest = {
      requestId,
      text,
      messageId,
      resolve: resolveReply,
      timer,
      stream: { turn: null, cursor: 0, stopped: false, timer: null },
    }
    this.pending = pending
    try {
      agent.followup(message)
    } catch (error) {
      clearTimeout(pending.timer)
      if (this.pending === pending) this.pending = null
      pending.resolve({ ok: false, error: '消息注入失败' })
      const detail = error instanceof Error ? error.message : String(error)
      this.push({ type: 'reply', id: requestId, ok: false, error: `消息注入失败：${detail}` })
      this.pump()
      return
    }
    this.startFeed(agent)
    await replyPromise
  }

  /** 装配侧注入反馈接收器：宠物点「好 / 不用 / 关闭 / 再开」时被调用。 */
  onProactiveFeedback(callback: (kind: 'accept' | 'decline' | 'disable' | 'enable') => void): void {
    this.proactiveFeedback = callback
  }

  /** 最新一次宠物上报的桌面状态（专注 / 可见 / 会议中）。 */
  getPetState(): { focus: boolean; visible: boolean; meeting: boolean } {
    return { ...this.petState }
  }

  /**
   * 当前绑定会话的工作目录，供主动帮助列候选。自建会话取创建时的目录；召唤来的会话尽力读会话元数据，
   * 读不到就返回 null（候选里不列这一项），不拿插件进程自己的目录冒充。
   */
  boundSessionCwd(): string | null {
    if (this.agent === null) return null
    if (this.owned !== null && this.owned.handle.agent === this.agent) return this.options.sessionHost?.cwd() ?? null
    const meta = (this.agent as { session?: { meta?: { cwd?: unknown } } }).session?.meta
    return typeof meta?.cwd === 'string' && path.isAbsolute(meta.cwd) ? meta.cwd : null
  }

  /**
   * 推一条主动提醒气泡。文案来自 proactive.ts 的固定常量，不是模型生成的 ——
   * §2.7 的"不回应就不读取更多资料"靠这一点成立：气泡里没有可被填充的资料位。
   */
  pushProactive(message: string, suggestDisable: boolean): void {
    this.push({ type: 'proactive', message, payload: { suggestDisable } })
  }

  /** 成员值守结果通知；正文由成员模型生成，桌面只显示，不据此执行动作。 */
  pushNotice(kind: 'mail' | 'member', text: string, memberId?: string): void {
    this.push({ type: 'notice', payload: { kind, text: text.slice(0, 2_000), at: Date.now(), ...(memberId ? { memberId } : {}) } })
  }

  private push(event: Omit<BridgeEvent, 'seq' | 'epoch'>): void {
    // 推过 reply 即视为已结算：之后的取消如实报「已结算，结果不变」。
    if (event.type === 'reply' && typeof event.id === 'string') rememberBounded(this.settledRequests, event.id)
    this.seq += 1
    const full: BridgeEvent = { ...event, seq: this.seq, epoch: this.epoch }
    this.events.push(full)
    if (this.events.length > EVENT_RETENTION) this.events.splice(0, this.events.length - EVENT_RETENTION)
    this.options.onEvent?.(full)
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.res(this.events.filter((item) => item.seq > waiter.seq))
    }
  }
}

/** 默认 DSH_HOME 推断（与宠物端保持一致）。 */
export function defaultDshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
