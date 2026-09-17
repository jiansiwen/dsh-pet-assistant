/**
 * 执行点门禁：把「已获人类批准」变成副作用工具调用的前置条件。
 *
 * 光靠系统提示词让模型「先提案再动手」是拦不住任何东西的 —— 模型可以直接调 write。
 * 这里用宿主的单调拒绝守卫（`ToolRuntime.guard`）在真实调用点强制校验。
 *
 * 守卫注册在**子代理自己的 agent-scoped ctx** 上，不是全局 ctx。宿主里 `guard()` 把守卫
 * 追加进 `this.ctx` 对应的那一层，而 `guardReason(exec)` 先查全局层、再按
 * `chainLayers(exec.agent)` 遍历**发起这次调用的那个 agent** 的 scope 链。所以注册在子代理
 * ctx 上的守卫只会作用于它自己（agent ctx 的贡献还会在 agent 销毁时自动回卷），用户的主
 * 会话不在那条链上，我们也不需要手动按 execution.agent 过滤。
 *
 * 拒绝**不抛异常**：宿主把守卫返回的字符串包成 `Error: <理由>` 的 isError 工具结果交回
 * 模型，任务继续跑。也就是说这里的每一句拒绝文案都会原样进入模型上下文 —— 这就是它要写成
 * 教学式（点名该用哪个工具提案、tool 与 target 该填什么）而不是一句干巴巴「未授权」的原因：
 * 模型照着改就能走通，读不懂就只能反复撞墙或者换个姿势绕过审批。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalService } from './approval.ts'

/**
 * 委派工具名候选；只有运行时确实存在的名字才会进入 deny 列表。
 *
 * 前六个是对着 0.1.1-rc.2 安装产物核实过的真实工具名：`subagent`（spawn）、
 * `subagent_fork`（同一插件换了 toolName 的 fork 变体）、`workflow` 与 `ralph`
 * （两者内部同样以 subagentProvider 起子代理）、以及给别的 agent 递话/打断的两个控制工具。
 * 后三个是其他 harness 的常见叫法，本运行时不存在，会被存在性过滤丢掉。
 *
 * 刻意不禁用 `report`（dsh-tool-subagent-report）：专家要靠它把结构化结论交回父会话，
 * 禁掉就等于让专家哑巴。它本身不产生新的委派。
 */
export const DELEGATION_TOOL_CANDIDATES = [
  'subagent',
  'subagent_fork',
  'workflow',
  'ralph',
  'send_message',
  'interrupt_agent',
  'task',
  'agent',
  'delegate',
]

/**
 * 副作用工具名候选 —— 只读席位的默认禁令，名字逐个对着 0.1.1-rc.2 安装产物核实过
 * （`dsh-base/cordis.patch.yml` 实际挂载的那些 dsh-tool-* 包）。
 *
 * `bash` / `pwsh` 是最大的洞：一条 shell 就等于完整写权限，光禁 write 毫无意义。
 * `skill` 同理 —— 技能内部想干什么就干什么。文件类三个工具名是 `write` / `edit` /
 * `str_replace_editor`，**不是** `write_file`（后者在本运行时不存在，禁了也是空转）。
 *
 * 留给只读席位的是纯观测面：read / read_image / glob / grep / job_list / job_output /
 * get_goal / web_fetch / web_search / report。
 */
export const SIDE_EFFECT_TOOL_CANDIDATES = [
  'bash',
  'pwsh',
  'write',
  'edit',
  'str_replace_editor',
  'skill',
  'job_kill',
  'todo_write',
  'create_goal',
  'update_goal',
]

/** 只读席位的默认禁令 = 委派面 + 副作用面。 */
export const READ_ONLY_DENY_CANDIDATES = [...DELEGATION_TOOL_CANDIDATES, ...SIDE_EFFECT_TOOL_CANDIDATES]

/**
 * 需要人类批准的工具 → 承载「作用目标」的参数字段。
 *
 * 门禁绑定的是**人实际审阅过的那个目标**（哪个文件、哪条命令），而不是整个参数对象的
 * 摘要：让模型在提案里逐字复述将要写入的整个文件内容既烧 token 又极易对不上，一旦
 * 键序或空白有半点差别摘要就失配，结果是合法操作被反复拒绝。
 *
 * `todo_write` / `create_goal` / `update_goal` 刻意不在表里 —— 它们改的是 harness 内部
 * 的待办与目标状态，不碰用户磁盘也不对外发东西，要批准只会把总助理卡死在自己的记账上。
 */
const GATED_TARGET_FIELDS: Readonly<Record<string, string>> = {
  bash: 'command',
  pwsh: 'command',
  write: 'file_path',
  edit: 'file_path',
  str_replace_editor: 'path',
  skill: 'name',
  job_kill: 'job_id',
}

export type GateDecision =
  /** 不在门禁范围内，直接放行。 */
  | { readonly kind: 'open' }
  /** 在门禁范围内，且已确定作用目标，需要一条匹配的批准。 */
  | { readonly kind: 'gated'; readonly target: string }
  /** 在门禁范围内但目标无法确定 —— 必须拒绝，不能因为看不懂参数就放行。 */
  | { readonly kind: 'unbound'; readonly reason: string }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/**
 * 判定一次工具调用受不受门禁管，以及它的作用目标是什么。
 *
 * `str_replace_editor` 的 `view` 子命令是纯读的，放行；`create` / `str_replace` /
 * `insert` 才要批准。
 */
export function gateDecision(tool: string, args: unknown): GateDecision {
  const field = GATED_TARGET_FIELDS[tool]
  if (field === undefined) return { kind: 'open' }

  const record = asRecord(args)
  if (!record) return { kind: 'unbound', reason: `${tool} 的参数不是对象，无法确定作用目标` }
  if (tool === 'str_replace_editor' && record.command === 'view') return { kind: 'open' }

  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    return { kind: 'unbound', reason: `${tool} 缺少字符串参数 ${field}，无法确定作用目标` }
  }
  return { kind: 'gated', target: value }
}

export interface GateOptions {
  readonly taskId: string
  readonly assistantId: string
  readonly approvals: ApprovalService
  readonly label: string
}

/**
 * 在一个子代理的 agent-scoped ctx 上装门禁。
 *
 * @returns 宿主的 guard disposer；agent 销毁时贡献本身也会自动回卷，这个 disposer
 *          只是给「任务提前取消但 agent 还活着」的场合用。
 */
export function installApprovalGate(ctx: Context, options: GateOptions): () => void {
  return ctx.tools.guard((execution) => {
    const decision = gateDecision(execution.name, execution.arguments)
    if (decision.kind === 'open') return undefined
    if (decision.kind === 'unbound') {
      return `已拦截 ${execution.name}：${decision.reason}。补齐参数后重试，不要换一条绕过审批的路。`
    }
    const outcome = options.approvals.authorizeCall({
      taskId: options.taskId,
      assistantId: options.assistantId,
      tool: execution.name,
      target: decision.target,
    })
    if (outcome.ok) return undefined
    return `已拦截 ${execution.name}：${outcome.reason}`
  })
}
