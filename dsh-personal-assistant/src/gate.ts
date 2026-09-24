/** 团队执行点权限：明确允许只读集合，未知工具与再委派默认拒绝。 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { digestOf, type ApprovalService } from './approval.ts'

export const DELEGATION_TOOL_CANDIDATES = [
  'subagent', 'subagent_fork', 'workflow', 'ralph', 'send_message', 'interrupt_agent',
  'task', 'agent', 'delegate', 'desktop_team_assign', 'desktop_team_start',
]
export const SIDE_EFFECT_TOOL_CANDIDATES = [
  'bash', 'pwsh', 'write', 'edit', 'str_replace_editor', 'skill', 'job_kill',
  'todo_write', 'create_goal', 'update_goal',
]
export const READ_ONLY_DENY_CANDIDATES = [...DELEGATION_TOOL_CANDIDATES, ...SIDE_EFFECT_TOOL_CANDIDATES]

/** 已核实的观测工具；report 是宿主在子代理自身层注册的结构化返回工具。 */
export const READ_ONLY_ALLOW_TOOLS: readonly string[] = [
  'read', 'read_image', 'glob', 'grep', 'job_list', 'job_output', 'get_goal', 'web_fetch', 'web_search', 'report',
]

const GATED_TARGET_FIELDS: Readonly<Record<string, string>> = {
  bash: 'command', pwsh: 'command', write: 'file_path', edit: 'file_path',
  str_replace_editor: 'path', job_kill: 'job_id',
}

export type GateDecision =
  | { readonly kind: 'open' }
  | { readonly kind: 'gated'; readonly target: string }
  | { readonly kind: 'unbound'; readonly reason: string }

/** 只放行明确观测工具；技能、控制工具、插件写工具与未知能力不能绕过门禁。 */
export function gateDecision(tool: string, args: unknown): GateDecision {
  if (READ_ONLY_ALLOW_TOOLS.includes(tool)) return { kind: 'open' }
  if (!Object.hasOwn(GATED_TARGET_FIELDS, tool)) return { kind: 'unbound', reason: '工具不在团队允许集合内，禁止副作用扩权或再委派' }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { kind: 'unbound', reason: `${tool} 的参数不是对象` }
  }
  const record = args as Record<string, unknown>
  if (tool === 'str_replace_editor' && record.command === 'view') return { kind: 'open' }
  const field = GATED_TARGET_FIELDS[tool]!
  const target = record[field]
  return typeof target === 'string' && target.length > 0
    ? { kind: 'gated', target }
    : { kind: 'unbound', reason: `${tool} 缺少字符串参数 ${field}` }
}

/** 必须使用精确子代理上下文，误传全局上下文时拒绝注册。 */
export function installReadOnlyGate(ctx: Context, denied: readonly string[] = []): () => void {
  if (!ctx.agent || ctx.agent.ctx !== ctx) throw new Error('只读门禁必须安装到精确的 agent.ctx')
  return ctx.tools.guard(execution => {
    if (execution.agent !== ctx.agent) return '团队权限不允许继承给其他代理'
    if (execution.signal.aborted) return '任务已经取消'
    return READ_ONLY_ALLOW_TOOLS.includes(execution.name) && !denied.includes(execution.name)
      ? undefined : `已拦截 ${execution.name}：本次任务只读，禁止副作用和再委派`
  })
}

/**
 * 启动前的定向守卫：只匹配宿主持久描述符里的随机运行标签及父会话。
 * 普通主会话、其他子代理不匹配；覆盖 start() 返回前的调用与保留的 run_code 传输。
 */
export function installDelegationReadOnlyGate(ctx: Context, parentId: string, label: string, denied: readonly string[]): () => void {
  return ctx.tools.guard(execution => {
    const session = execution.agent?.session
    if (!session || session.header.parentSession !== parentId) return undefined
    const descriptor = session.events.find(event => event.type === 'subagent/descriptor')
    if (!descriptor || descriptor.type !== 'subagent/descriptor' || descriptor.data.label !== label) return undefined
    return READ_ONLY_ALLOW_TOOLS.includes(execution.name) && !denied.includes(execution.name)
      ? undefined : `已拦截 ${execution.name}：团队只读委派禁止副作用和再委派`
  })
}

export interface GateOptions {
  readonly taskId: string
  readonly assistantId: string
  readonly inputRevision: number
  readonly approvals: ApprovalService
  readonly label: string
}

/**
 * 在任务专用 agent.ctx 安装；宿主须在首次工具调用前完成装配。
 * 参数由宿主 execution 提供，身份与版本由可信调度器绑定，不接受模型自报。
 * 通过 tools/result 结算真实调用；没有可观测结果的操作留给恢复流程核查。
 */
export function installApprovalGate(ctx: Context, options: GateOptions): () => void {
  if (!ctx.agent || ctx.agent.ctx !== ctx) throw new Error('审批门禁必须安装到精确的 agent.ctx')
  const calls = new Map<ToolExecutionToken, string>()
  const releaseGuard = ctx.tools.guard(execution => {
    if (execution.agent !== ctx.agent) return '批准不能继承给其他代理'
    if (execution.signal.aborted) return '任务已经取消'
    const decision = gateDecision(execution.name, execution.arguments)
    if (decision.kind === 'open') return undefined
    if (decision.kind === 'unbound') return `已拦截 ${execution.name}：${decision.reason}`
    const outcome = options.approvals.authorizeCall({
      taskId: options.taskId, assistantId: options.assistantId, inputRevision: options.inputRevision,
      tool: execution.name, target: decision.target, params: execution.arguments,
    })
    if (!outcome.ok) return `已拦截 ${execution.name}：${outcome.reason}`
    calls.set(execution.token, outcome.operationId)
    return undefined
  })
  const releaseResult = ctx.on('tools/result', (execution, result) => {
    const operationId = calls.get(execution.token)
    if (!operationId) return
    calls.delete(execution.token)
    // 工具报错可能已部分产生副作用，不能据此声称没有执行或允许盲重试。
    options.approvals.settle(operationId, result.isError ? 'unknown' : 'succeeded', digestOf(result))
  })
  return () => { releaseGuard(); releaseResult(); calls.clear() }
}
