/** 团队执行点权限：明确允许只读集合，未知工具与再委派默认拒绝。 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { digestOf, type ApprovalService, type ApprovalWaitOutcome, type GateCall } from './approval.ts'

export const DELEGATION_TOOL_CANDIDATES = [
  'subagent', 'subagent_fork', 'workflow', 'ralph', 'send_message', 'interrupt_agent',
  'task', 'agent', 'delegate', 'desktop_team_assign', 'desktop_team_start',
]
export const SIDE_EFFECT_TOOL_CANDIDATES = [
  'bash', 'pwsh', 'write', 'edit', 'str_replace_editor', 'skill', 'job_kill',
  'todo_write', 'create_goal', 'update_goal',
]
export const READ_ONLY_DENY_CANDIDATES = [...DELEGATION_TOOL_CANDIDATES, ...SIDE_EFFECT_TOOL_CANDIDATES]

/**
 * 已核实的观测工具，外加宿主在子代理自身层注册的回报工具：
 * `report`（可续接子代理）与 `structured_output`（带 outputSchema 的一次性子代理交回结构化结果，
 * 0.1.1-rc.2 安装产物 dsh-subagent-in-process-driver 核实）。拦掉后者，子代理永远交不回报告。
 */
export const READ_ONLY_ALLOW_TOOLS: readonly string[] = [
  'read', 'read_image', 'glob', 'grep', 'job_list', 'job_output', 'get_goal', 'web_fetch', 'web_search',
  'report', 'structured_output',
]

/** 子代理自身层注册的工具：父作用域里看不到，也不能写进 restrict 名单。 */
export const CHILD_LOCAL_TOOLS: readonly string[] = ['report', 'structured_output']

/**
 * 需要逐次审批的副作用工具，以及批准绑定的目标字段（照 rc.2 各工具的参数定义核实）。
 * 只有这些名字能进副作用任务的允许集合；技能、再委派、计划类工具与未知能力一律不支持。
 */
export const GATED_TARGET_FIELDS: Readonly<Record<string, string>> = {
  bash: 'command', pwsh: 'command', write: 'file_path', edit: 'file_path',
  str_replace_editor: 'path', job_kill: 'job_id',
}

/** 目标是文件路径的门禁工具：比对前必须规范化成真实路径，并且只能落在授权工作区内。 */
export const PATH_TARGET_TOOLS: readonly string[] = ['write', 'edit', 'str_replace_editor']

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

/**
 * 按宿主真实定义核实门禁工具：父作用域看得到，且参数 schema 声明了批准要绑定的字符串目标字段。
 * 宿主改了字段名时这里直接把工具剔掉 —— 宁可少一个能力，也不让门禁按错的字段绑定目标。
 * @param lookup - 父代理视角的 `ctx.tools.get`。
 * @param denied - 配置与成员额外禁用的名字。
 * @returns 可以放进副作用允许集合的门禁工具名。
 */
export function verifiedGatedTools(lookup: (name: string) => unknown, denied: readonly string[]): string[] {
  return Object.keys(GATED_TARGET_FIELDS).filter(name => !denied.includes(name) && declaresStringField(lookup(name), GATED_TARGET_FIELDS[name]!))
}

function declaresStringField(definition: unknown, field: string): boolean {
  if (typeof definition !== 'object' || definition === null) return false
  const parameters = (definition as { parameters?: unknown }).parameters
  if (typeof parameters !== 'object' || parameters === null) return false
  const properties = (parameters as { properties?: unknown }).properties
  if (typeof properties !== 'object' || properties === null || !Object.hasOwn(properties, field)) return false
  return (properties as Record<string, { type?: unknown } | undefined>)[field]?.type === 'string'
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? String((error as { code?: unknown }).code ?? '') : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把路径解析成真实写入位置：先按 base 词法解析，再对已存在的最长前缀逐级解开符号链接/联接点，
 * 不存在的尾段原样拼回（与宿主 fs-local 计算目标身份的方式一致）。
 * 悬空链接、穿过普通文件的路径直接拒绝 —— 它们的真实落点无法在执行前确认。
 * @param raw - 模型给的路径（绝对或相对）。
 * @param base - 相对路径的基准目录（调用代理的会话工作目录）。
 * @returns 规范化后的绝对路径。
 */
export function canonicalPath(raw: string, base: string): string {
  const absolute = path.resolve(base, raw)
  const tail: string[] = []
  let cursor = absolute
  for (;;) {
    let real: string | undefined
    try {
      real = realpathSync.native(cursor)
    } catch (error) {
      const code = errorCode(error)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      let linked = false
      try {
        lstatSync(cursor)
        linked = true
      } catch { /* 这一段确实不存在，继续往上找。 */ }
      if (linked) throw new Error(`${cursor} 是悬空链接或无法解析的路径段，无法确认实际写入位置`)
      const parent = path.dirname(cursor)
      if (parent === cursor) throw new Error(`${absolute} 找不到任何已存在的上级目录`)
      tail.unshift(path.basename(cursor))
      cursor = parent
      continue
    }
    if (tail.length === 0) return real
    if (!statSync(real).isDirectory()) throw new Error(`${absolute} 的上级 ${real} 不是目录`)
    return path.join(real, ...tail)
  }
}

/** 授权根本身的真实路径；不是可用目录就返回 undefined，调用方据此关掉写类工具。 */
export function canonicalRoot(dir: string | undefined): string | undefined {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return undefined
  try {
    const real = realpathSync.native(dir)
    return statSync(real).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

/**
 * target 是否严格位于 root 之内。按路径段比较而不是字符串前缀：D:/ab 不在 D:/a 里，
 * 根目录本身也不算（写类工具不能把根目录当文件写）。Windows 下不区分大小写。
 */
export function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** target 是 root 本身或位于其内（目录类目标用，例如验证命令的工作目录）。 */
export function isRootOrWithin(root: string, target: string): boolean {
  return path.relative(root, target) === '' || isWithinRoot(root, target)
}

/** 文件不存在时的内容版本。 */
export const ABSENT_VERSION = 'absent'

/** 超过这个大小的文件不在同步守卫里整读哈希，退回 大小+修改时间 的弱版本。 */
const VERSION_HASH_LIMIT = 64 * 1024 * 1024

/**
 * 写类目标此刻的内容版本：不存在 → `absent`；普通文件 → 内容 sha256；目录、链接等 → 带前缀的非哈希值。
 * 目标先经 canonicalPath 解析成真实路径；此后它若被换成符号链接，版本随之变成 `symlink`，与批准时不符。
 */
export function fileVersion(target: string): string {
  let stat
  try {
    stat = lstatSync(target)
  } catch (error) {
    const code = errorCode(error)
    return code === 'ENOENT' || code === 'ENOTDIR' ? ABSENT_VERSION : `unreadable:${code || 'ERROR'}`
  }
  if (stat.isSymbolicLink()) return 'symlink'
  if (!stat.isFile()) return 'not-a-file'
  if (stat.size > VERSION_HASH_LIMIT) return `size:${stat.size}:mtime:${Math.trunc(stat.mtimeMs)}`
  try {
    return createHash('sha256').update(readFileSync(target)).digest('hex')
  } catch (error) {
    return `unreadable:${errorCode(error) || 'ERROR'}`
  }
}

/** 门禁的作用范围：允许集合、额外禁令与写类工具的授权工作区。 */
export interface GateScope {
  /** 允许集合（观测工具 + 已核实的门禁工具）；给出时集合外的工具一律拒绝。 */
  readonly allow?: readonly string[]
  /** 配置与成员额外禁用的工具名，优先于允许集合。 */
  readonly denied?: readonly string[]
  /**
   * 写类工具的授权工作区（已规范化的真实路径）。给出时 write / edit / str_replace_editor 的目标
   * 先解析成真实路径再比对，越出工作区（含符号链接越界、相似前缀）一律拒绝；批准绑定的就是这条
   * 真实路径。团队副作用任务总会给出；不给时退回原始目标绑定，仅兼容直接装门禁的旧调用。
   */
  readonly workspaceRoot?: string
}

/** 调用代理的会话工作目录：宿主文件工具按它解析相对路径。 */
function sessionCwdOf(agent: Agent | undefined): string | undefined {
  const cwd = (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** 在 gateDecision 之上叠加允许集合、禁令与写类目标的规范化/工作区约束。 */
export function scopedGateDecision(tool: string, args: unknown, cwd: string | undefined, scope: GateScope): GateDecision {
  if (scope.denied?.includes(tool)) return { kind: 'unbound', reason: '该工具已被配置禁用' }
  if (scope.allow !== undefined && !scope.allow.includes(tool)) {
    return { kind: 'unbound', reason: '工具不在团队允许集合内，禁止副作用扩权或再委派' }
  }
  const decision = gateDecision(tool, args)
  if (decision.kind !== 'gated' || scope.workspaceRoot === undefined || !PATH_TARGET_TOOLS.includes(tool)) return decision
  if (tool === 'str_replace_editor' && !path.isAbsolute(decision.target)) {
    return { kind: 'unbound', reason: 'str_replace_editor 的 path 必须是绝对路径' }
  }
  let target: string
  try {
    target = canonicalPath(decision.target, cwd ?? scope.workspaceRoot)
  } catch (error) {
    return { kind: 'unbound', reason: `无法确认 ${decision.target} 的实际位置：${messageOf(error)}` }
  }
  if (!isWithinRoot(scope.workspaceRoot, target)) {
    return {
      kind: 'unbound',
      reason: `目标实际位置 ${target} 不在授权工作区 ${scope.workspaceRoot} 内（符号链接与相似前缀都按真实路径判断）`,
    }
  }
  return { kind: 'gated', target }
}

/** 必须使用精确子代理上下文，误传全局上下文时拒绝注册。 */
export function installReadOnlyGate(agent: Agent, denied: readonly string[] = []): () => void {
  const ctx = agent.ctx
  if (!ctx) throw new Error('只读门禁必须安装到精确的 agent.ctx')
  return ctx.tools.guard(execution => {
    if (execution.agent !== agent) return '团队权限不允许继承给其他代理'
    if (execution.signal.aborted) return '任务已经取消'
    return READ_ONLY_ALLOW_TOOLS.includes(execution.name) && !denied.includes(execution.name)
      ? undefined : `已拦截 ${execution.name}：本次任务只读，禁止副作用和再委派`
  })
}

/** 宿主持久描述符里的随机运行标签 + 父会话都对上，才算这次委派的子代理。 */
function matchesDelegation(execution: Readonly<ToolExecution>, parentId: string, label: string): boolean {
  const session = execution.agent?.session
  if (!session || session.header.parentSession !== parentId) return false
  const descriptor = session.snapshotEvents().find(event => event.type === 'subagent/descriptor')
  return !!descriptor && descriptor.type === 'subagent/descriptor' && (descriptor.data as { label?: unknown }).label === label
}

/**
 * 启动前的定向守卫：只匹配宿主持久描述符里的随机运行标签及父会话。
 * 普通主会话、其他子代理不匹配；覆盖 start() 返回前的调用与保留的 run_code 传输。
 */
export function installDelegationReadOnlyGate(ctx: Context, parentId: string, label: string, denied: readonly string[]): () => void {
  return ctx.tools.guard(execution => {
    if (!matchesDelegation(execution, parentId, label)) return undefined
    return READ_ONLY_ALLOW_TOOLS.includes(execution.name) && !denied.includes(execution.name)
      ? undefined : `已拦截 ${execution.name}：团队只读委派禁止副作用和再委派`
  })
}

export interface DelegationApprovalScope extends GateScope {
  /** 精确 agent.ctx 上的审批门禁装好之后返回那个子代理；之前返回 undefined。 */
  readonly bound: () => Agent | undefined
}

/**
 * 副作用委派的启动前定向审批门禁，匹配方式与只读版相同（随机运行标签 + 父会话），
 * 覆盖 start() 返回前已经发出的调用：
 * - 允许集合外的工具、再委派与 run_code 传输一律拒绝；
 * - 门禁工具在精确 agent.ctx 的审批门禁装好之前一律拦截 —— 此时还没有绑定到这个子代理的
 *   批准消费点，任何批准都不能在这里生效；装好之后只认那个精确子代理，交给它逐次核验并单次消费。
 */
export function installDelegationApprovalGate(ctx: Context, parentId: string, label: string, scope: DelegationApprovalScope): () => void {
  return ctx.tools.guard(execution => {
    if (!matchesDelegation(execution, parentId, label)) return undefined
    if (execution.signal.aborted) return '任务已经取消'
    const decision = scopedGateDecision(execution.name, execution.arguments, sessionCwdOf(execution.agent), scope)
    if (decision.kind === 'open') return undefined
    if (decision.kind === 'unbound') return `已拦截 ${execution.name}：${decision.reason}`
    const bound = scope.bound()
    if (bound === undefined) return `已拦截 ${execution.name}：执行点审批门禁尚未装好，启动完成前不放行任何副作用`
    return execution.agent === bound ? undefined : `已拦截 ${execution.name}：批准不能继承给其他代理`
  })
}

export interface GateOptions extends GateScope {
  readonly taskId: string
  readonly assistantId: string
  readonly inputRevision: number
  readonly approvals: ApprovalService
  readonly label: string
  /** 写进账本的运行 id；缺省用 label。 */
  readonly runId?: string
  /**
   * 没有可用批准时，门禁替这次真实调用生成审批卡并停在调用点等待可信决定
   * （批准 / 驳回 / 到期 / signal 取消）。不给就直接拒绝，等批准事先存在。
   */
  readonly hold?: { readonly signal: AbortSignal; readonly requester: string }
}

const WAIT_OUTCOME_TEXT: Readonly<Record<Exclude<ApprovalWaitOutcome, 'approved'>, string>> = {
  rejected: '用户在审批窗口驳回了这次调用，未执行',
  expired: '审批窗口到期仍未获批，未执行；需要执行就重新发起这次调用',
  aborted: '任务已取消或超时，等待中的调用未执行',
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 审批卡上的一句话：按真实工具与规范化目标生成，不复制正文，不采纳模型自报的说明。 */
function describeCall(requester: string, tool: string, target: string, args: unknown): string {
  const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
  const size = (value: unknown) => (typeof value === 'string' ? value.length : 0)
  switch (tool) {
    case 'write':
      return `${requester}请求写入 ${target}（整文件 ${size(record.content)} 个字符）`
    case 'edit':
      return `${requester}请求修改 ${target}（替换 ${size(record.old_string)} → ${size(record.new_string)} 个字符${record.replace_all === true ? '，全部替换' : ''}）`
    case 'str_replace_editor':
      return `${requester}请求以 ${String(record.command)} 方式改动 ${target}`
    case 'bash':
    case 'pwsh': {
      const workdir = typeof record.workdir === 'string' ? `，工作目录 ${record.workdir}` : ''
      const background = record.run_in_background === true ? '，后台运行' : ''
      return `${requester}请求执行 ${tool} 命令：${clip(target, 200)}${workdir}${background}`
    }
    case 'job_kill':
      return `${requester}请求终止后台任务 ${target}`
    default:
      return `${requester}请求调用 ${tool}：${clip(target, 200)}`
  }
}

/** 命令类可以做任何事，按高风险走独立确认；文件改动与终止任务按中风险。 */
function riskOf(tool: string): 'medium' | 'high' {
  return tool === 'bash' || tool === 'pwsh' ? 'high' : 'medium'
}

/** 账本里的结果说明：成功只记 ok，失败记错误码与截断后的信息，不复制工具输出正文。 */
function resultDetail(result: Readonly<ToolExecutionResult>, dispatched: boolean): string {
  if (!dispatched) return '未进入工具体（被后续门禁拦截或执行前取消），未执行'
  if (!result.isError) return 'ok'
  return clip(`${result.error.info?.code ?? 'ERROR'}: ${result.error.message}`, 200)
}

/**
 * 在任务专用 agent.ctx 安装；宿主须在首次工具调用前完成装配。
 * 身份与版本由可信调度器绑定，不接受模型自报；参数由宿主 execution 提供。
 * 写类目标（有授权工作区时）还绑定文件内容版本：发卡时记下目标当时的版本，执行点重读不符就拒绝。
 * 账本只按真实工具生命周期推进：守卫单次消费批准（planned）→ tools/execute 即将进入工具体（running）
 * → tools/result 结算（成功 succeeded；进了工具体又报错 unknown；没进工具体 failed）。
 */
export function installApprovalGate(agent: Agent, options: GateOptions): () => void {
  const ctx = agent.ctx
  if (!ctx) throw new Error('审批门禁必须安装到精确的 agent.ctx')
  const calls = new Map<ToolExecutionToken, string>()
  const decide = (execution: Readonly<ToolExecution>) =>
    scopedGateDecision(execution.name, execution.arguments, sessionCwdOf(execution.agent), options)
  const versioned = (tool: string) => options.workspaceRoot !== undefined && PATH_TARGET_TOOLS.includes(tool)
  const callOf = (execution: Readonly<ToolExecution>, target: string): GateCall => ({
    taskId: options.taskId, assistantId: options.assistantId, inputRevision: options.inputRevision,
    tool: execution.name, target, params: execution.arguments, runId: options.runId ?? options.label,
    // 现读：等待批准期间用户若改了文件，这里读到的就是新版本，与卡片上绑定的旧版本不符。
    ...(versioned(execution.name) ? { baseHash: fileVersion(target) } : {}),
  })
  const disposers: Array<() => unknown> = []
  const release = () => {
    while (disposers.length > 0) disposers.pop()!()
    calls.clear()
  }
  try {
    const hold = options.hold
    if (hold !== undefined) {
      // 等待放在 pre-execute：守卫是同步的，等不了用户；放行与否仍由下面的守卫逐项核验后单次消费。
      disposers.push(ctx.on('tools/pre-execute', async (execution, next) => {
        const decision = await next()
        if (decision.kind !== 'allow' || execution.agent !== agent || execution.signal.aborted) return decision
        const gated = decide(execution)
        if (gated.kind !== 'gated') return decision
        const call = callOf(execution, gated.target)
        if (options.approvals.hasUsableApproval(call)) return decision
        if (!options.approvals.callIsLive(call)) {
          return { kind: 'deny', reason: `已拦截 ${execution.name}：任务已不在运行中，不再发起审批` }
        }
        const proposal = options.approvals.requestApproval(call,
          describeCall(hold.requester, execution.name, gated.target, execution.arguments), riskOf(execution.name))
        const outcome = await options.approvals.waitForDecision(proposal.proposalId, AbortSignal.any([execution.signal, hold.signal]))
        if (outcome === 'approved') return decision
        return { kind: 'deny', reason: `已拦截 ${execution.name}：${WAIT_OUTCOME_TEXT[outcome]}` }
      }))
    }
    disposers.push(ctx.tools.guard(execution => {
      if (execution.agent !== agent) return '批准不能继承给其他代理'
      if (execution.signal.aborted) return '任务已经取消'
      const decision = decide(execution)
      if (decision.kind === 'open') return undefined
      if (decision.kind === 'unbound') return `已拦截 ${execution.name}：${decision.reason}`
      // 同一次执行可能被多层守卫看到；已为这次执行消费过批准就不再消费第二条。
      if (calls.has(execution.token)) return undefined
      const outcome = options.approvals.authorizeCall(callOf(execution, decision.target))
      if (!outcome.ok) return `已拦截 ${execution.name}：${outcome.reason}`
      calls.set(execution.token, outcome.operationId)
      return undefined
    }))
    disposers.push(ctx.on('tools/execute', async (execution, next) => {
      const operationId = calls.get(execution.token)
      // 先把「开始执行」落库再进工具体；落不了库（任务已停止被对账、库坏了）就不执行。
      if (operationId !== undefined && !options.approvals.markRunning(operationId)) {
        throw new Error(`已拦截 ${execution.name}：执行账本已不在待执行状态（任务可能已停止），拒绝执行`)
      }
      return next()
    }))
    disposers.push(ctx.on('tools/result', (execution, result) => {
      const operationId = calls.get(execution.token)
      if (!operationId) return
      calls.delete(execution.token)
      const dispatched = options.approvals.operation(operationId)?.executedAt != null
      // 进了工具体又报错，可能已部分产生副作用，不能据此声称没有执行或允许盲重试。
      const state = !dispatched ? 'failed' : result.isError ? 'unknown' : 'succeeded'
      options.approvals.settle(operationId, state, digestOf(result), resultDetail(result, dispatched))
    }))
  } catch (error) {
    release()
    throw error
  }
  return release
}
