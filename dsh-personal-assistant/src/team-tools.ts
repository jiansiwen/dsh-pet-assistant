/**
 * 桌面专家助理团的工具注册与提示词编排。
 *
 * 与 personal_assistant_* 分开注册：团队能力可以被 profile 单独开关，出问题时也能
 * 只回退这一块，不动已跑通的活动记录与日报链路。
 *
 * 关键约束（对应设计 §2.11、§10.2）：
 * - 点名解析失败就拒绝，不静默换人；
 * - 专家只读，副作用一律先提案、经可信主体签发批准后才能消费执行；
 * - 批准 id 不进入模型上下文，模型只持有自己提交的 proposalId。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalService } from './approval.ts'
import { ApprovalError } from './approval.ts'
import { gateDecision } from './gate.ts'
import type { SessionBridge } from './bridge.ts'
import type { TaskOutcome, TeamService } from './team.ts'

interface TeamHost {
  tools: { register(definition: unknown): () => void }
  systemPrompt: {
    section(section: { name: string; order: number; text: string }): () => void
    variable(name: string, provider: () => string | undefined): () => void
  }
}

export interface TeamToolOptions {
  team: TeamService
  approvals: ApprovalService
  bridge: SessionBridge
}

/** 工具执行上下文里我们真正用到的字段；agent 是委派所必需的父身份。 */
interface ExecContext {
  agent?: Agent
  signal?: AbortSignal
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function outcomeView(outcome: TaskOutcome) {
  return {
    taskId: outcome.task.taskId,
    status: outcome.task.status,
    stopReason: outcome.stopReason,
    diagnostic: outcome.diagnostic,
    summary: outcome.report?.summary ?? null,
    artifacts: outcome.report?.artifacts ?? [],
    blockers: outcome.report?.blockers ?? [],
    needsApproval: outcome.report?.needsApproval ?? [],
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApprovalError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

export function registerTeamTools(host: TeamHost, options: TeamToolOptions): () => void {
  const disposers: Array<() => void> = []
  const dispose = () => {
    while (disposers.length) {
      disposers[disposers.length - 1]()
      disposers.pop()
    }
  }
  const own = (register: () => () => void): (() => void) => {
    try {
      const release = register()
      disposers.push(release)
      return release
    } catch (error) {
      dispose()
      throw error
    }
  }
  const ctx: TeamHost = {
    tools: { register: definition => own(() => host.tools.register(definition)) },
    systemPrompt: {
      section: section => own(() => host.systemPrompt.section(section)),
      variable: (name, provider) => own(() => host.systemPrompt.variable(name, provider)),
    },
  }
  const { team, approvals, bridge } = options
  const textOutput = {
    schema: { type: 'string' } as const,
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  }

  ctx.tools.register(defineTool({
    name: 'desktop_team_start',
    description: '开启桌面专家助理团：把当前会话登记为总助理（唐僧）的宿主会话，写入团队成员编制，并让桌面宠物可以显示多角色舞台与任务面板。用户说"开启团队模式"、"叫上专家"、"启动助理团"时调用。',
    parameters: {},
    output: textOutput,
    async execute(_args: unknown, exec: unknown) {
      const agent = (exec as ExecContext).agent
      if (!agent) return json({ ok: false, error: '当前执行上下文没有可绑定的会话 agent，无法开启团队模式' })
      const members = team.ensureRoster()
      const { port, epoch } = await bridge.bind(agent as never)
      bridge.bindTeamAgent(agent)
      bridge.attachTeam(team, approvals)
      bridge.writeApprovalCredential(approvals)
      return json({
        ok: true,
        bridgePort: port,
        epoch,
        enabled: members.filter(member => member.enabled).map(member => ({
          assistantId: member.assistantId,
          name: member.displayName,
          mode: member.toolPolicy.mode,
        })),
        disabled: members.filter(member => !member.enabled).map(member => member.displayName),
        message: '团队模式已开启。派发任务用 desktop_team_assign；未启用的席位不会播放假工作。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_team_assign',
    description: '把一项任务派给指定成员并等待其真实运行结果。member 用点名（唐僧/孙悟空/悟空/猪八戒/八戒等）；名字不存在或席位未启用会直接报错，不会替你换人。专家默认只读，需要外部副作用时它们会在 needsApproval 里提出，由你用 desktop_team_propose_action 走用户审批。',
    parameters: {
      member: { type: 'string', required: true, description: '承接成员的点名，如"孙悟空"' },
      goal: { type: 'string', required: true, description: '任务目标，一句话说清要解决什么' },
      evidence: { type: 'array', items: { type: 'string' }, description: '交给成员的已知材料（文件路径、报错原文、用户原话等）' },
      acceptance: { type: 'array', items: { type: 'string' }, description: '验收条件；当前自由文本产物需独立复核，模型自报不能标记任务完成' },
      dependsOn: { type: 'array', items: { type: 'string' }, description: '前置任务 id；前置未完成时本任务留在排队状态' },
      budgetTokens: { type: 'integer', description: '累计 token 预算。当前宿主不支持硬约束：非零预算会拒绝启动；0 明确表示不设累计预算' },
    },
    output: textOutput,
    async execute(
      args: { member: string; goal: string; evidence?: string[]; acceptance?: string[]; dependsOn?: string[]; budgetTokens?: number },
      exec: unknown,
    ) {
      const context = exec as ExecContext
      if (!context.agent) return json({ ok: false, error: '当前执行上下文没有可绑定的会话 agent，无法委派子代理' })
      const member = team.resolveByName(args.member)
      if (!member) {
        return json({
          ok: false,
          error: `没有可接单的成员叫「${args.member}」`,
          enabled: team.enabledMembers().map(item => item.displayName),
          note: '名字不存在或席位未启用时不会替换成别人；请确认点名或先开启该席位',
        })
      }
      const task = team.submitTask({
        goal: args.goal,
        inputEvidence: args.evidence ?? [],
        acceptance: args.acceptance ?? [],
        ownerId: member.assistantId,
        toolScope: 'read-only',
        dependsOn: args.dependsOn ?? [],
        budgetTokens: args.budgetTokens,
        originChannel: 'dsh-session',
      })
      const signal = context.signal ?? new AbortController().signal
      try {
        const outcome = await team.runTask(task.taskId, context.agent, signal)
        if (!outcome) return json({ ok: false, taskId: task.taskId, error: '任务未能进入执行（可能已被并发占用或状态已变更）' })
        return json({ ok: true, member: member.displayName, ...outcomeView(outcome) })
      } catch (error) {
        return json({ ok: false, taskId: task.taskId, member: member.displayName, error: errorMessage(error) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_team_status',
    description: '查询团队当前状态：成员编制与权限模式、任务概览、正在运行的委派数、待用户批准的提案、已执行的副作用操作。回答"团队在干什么"、"有哪些待批准"时调用。',
    parameters: {
      taskId: { type: 'string', description: '只看某个任务时传入其 id' },
    },
    output: textOutput,
    async execute(args: { taskId?: string }) {
      const tasks = args.taskId ? team.listTasks().filter(task => task.taskId === args.taskId) : team.listTasks().slice(0, 20)
      return json({
        teamEnabled: bridge.teamEnabled,
        running: team.runningCount(),
        members: team.roster().map(member => ({
          assistantId: member.assistantId,
          name: member.displayName,
          role: member.roleId,
          skin: member.skinId,
          mode: member.toolPolicy.mode,
          enabled: member.enabled,
        })),
        tasks: tasks.map(task => ({
          taskId: task.taskId,
          goal: task.goal,
          owner: task.ownerId,
          status: task.status,
          revision: task.revision,
          artifacts: task.artifacts,
          dependsOn: task.dependsOn,
        })),
        pendingApprovals: approvals.pendingProposals().map(item => ({
          proposalId: item.proposalId,
          taskId: item.taskId,
          assistantId: item.assistantId,
          summary: item.summary,
          tool: item.tool,
          target: item.target,
          risk: item.risk,
          expiresAt: item.expiresAt,
        })),
        operations: approvals.operations(args.taskId).slice(0, 20).map(item => ({
          operationId: item.operationId,
          taskId: item.taskId,
          kind: item.kind,
          state: item.state,
        })),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_team_cancel',
    description: '取消一个任务：停掉它正在运行的子代理并把状态置为 cancelled。已经发生的外部副作用不会被撤回，返回里会列出，必须如实告知用户。',
    parameters: {
      taskId: { type: 'string', required: true, description: '要取消的任务 id' },
    },
    output: textOutput,
    async execute(args: { taskId: string }) {
      const task = await team.cancelTask(args.taskId)
      if (!task) return json({ ok: false, error: `任务 ${args.taskId} 不存在` })
      return json({
        ok: true,
        taskId: task.taskId,
        status: task.status,
        operationsAlreadyPerformed: approvals.operations(task.taskId).map(item => ({ kind: item.kind, state: item.state })),
        note: '取消只停止后续工作，已执行的副作用不会自动回滚',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_team_propose_action',
    description:
      '为一个需要用户批准的副作用提交提案（写文件、删数据、发消息、改配置、执行命令等）。提案会推送到桌面宠物的审批卡；只有用户在可信交互面上点批准后才签发批准。提交提案本身不产生任何外部效果，也不代表已获授权。' +
      '批准只可交给已绑定任务身份、输入版本及完整参数的可信执行器；不要在普通主会话中直接执行来替代团队审批。',
    parameters: {
      taskId: { type: 'string', required: true, description: '关联任务 id' },
      summary: { type: 'string', required: true, description: '给用户看的一句话说明：要做什么、影响什么' },
      tool: {
        type: 'string',
        required: true,
        description:
          '实际宿主工具名：write / edit / bash / pwsh / str_replace_editor / job_kill。技能、再委派和未知工具不支持。',
      },
      target: {
        type: 'string',
        required: true,
        description:
          '作用目标必须与完整参数中的对应字段相同：write/edit 用 file_path，str_replace_editor 用 path，bash/pwsh 用整条 command，job_kill 用 job_id。',
      },
      params: { type: 'object', additionalProperties: true, required: true, description: '将要调用工具的完整参数对象，包含目标字段；键序无关，任何值变动都使批准失效' },
      risk: { type: 'string', enum: ['low', 'medium', 'high'], required: true, description: '风险等级；high 会要求用户在独立审批窗口确认' },
      assistantId: { type: 'string', description: '必须与任务所属成员一致；缺省使用任务成员' },
    },
    output: textOutput,
    async execute(args: { taskId: string; summary: string; tool: string; target: string; params?: unknown; risk: 'low' | 'medium' | 'high'; assistantId?: string }) {
      const task = team.getTask(args.taskId)
      if (!task) return json({ ok: false, error: `任务 ${args.taskId} 不存在` })
      const assistantId = args.assistantId ?? task.ownerId
      if (assistantId !== task.ownerId || !team.member(assistantId)?.enabled) return json({ ok: false, error: '提案成员与任务成员不符或已停用' })
      if (['done', 'failed', 'cancelled', 'unknown'].includes(task.status)) return json({ ok: false, error: '任务已终止或结果不明，需先复核' })
      const decision = gateDecision(args.tool, args.params)
      if (decision.kind !== 'gated' || decision.target !== args.target) return json({ ok: false, error: '工具不支持审批或完整参数中的目标与提案不符' })
      const proposal = approvals.propose({
        taskId: task.taskId,
        assistantId,
        summary: args.summary,
        tool: args.tool,
        target: args.target,
        params: args.params ?? null,
        inputRevision: task.revision,
        risk: args.risk,
      })
      return json({
        ok: true,
        proposalId: proposal.proposalId,
        state: proposal.state,
        expiresAt: proposal.expiresAt,
        note: '等待可信审批决定。当前只读团队不执行副作用；获批也不代表已执行。需任务专用可信执行器绑定最新版本后消费，不能在普通主会话直接调用工具代替。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_team_finish_operation',
    description:
      '查询一次副作用的可信执行记录。保留旧工具名，但不再接受模型自报成功来结账；真实工具结果或可信人工复核才可修改账目。',
    parameters: {
      proposalId: { type: 'string', required: true, description: '已批准且已执行的提案 id' },
      state: { type: 'string', enum: ['succeeded', 'failed', 'unknown'], description: '旧参数，仅兼容接收，不会修改可信状态' },
      operationId: { type: 'string', description: '可选执行记录 id，必须与提案对应' },
      resultDigest: { type: 'string', description: '旧参数，不会写入可信账目' },
    },
    output: textOutput,
    async execute(args: { proposalId: string; state?: 'succeeded' | 'failed' | 'unknown'; operationId?: string; resultDigest?: string }) {
      try {
        const operation = approvals.operationByProposal(args.proposalId)
        if (!operation || (args.operationId && args.operationId !== operation.operationId)) {
          return json({ ok: false, error: '提案没有匹配的真实执行记录' })
        }
        return json({ ok: true, operationId: operation.operationId, kind: operation.kind, state: operation.state,
          note: '返回可信账目，忽略模型自报状态和摘要；结果不明时须人工核查，禁止盲重试' })
      } catch (error) {
        return json({ ok: false, error: errorMessage(error), note: '查不到执行记录说明门禁从未放行过这次副作用；不要凭空报成功。' })
      }
    },
  }))

  ctx.systemPrompt.section({
    name: 'desktop-team',
    order: 160,
    text: [
      '## 桌面专家助理团',
      '',
      '本环境装有 desktop_team_* 工具。你（当前会话）就是总助理唐僧：负责理解用户目标、拆分任务、点名委派、转交审批、汇总结论。',
      '',
      '成员编制（只有 enabled 的席位能接单）：',
      '{{desktop_team_roster}}',
      '',
      '协作规则：',
      '- 用户说"开启团队模式"、"叫上专家"：调用 desktop_team_start。',
      '- 需要专业分析时调用 desktop_team_assign 点名委派，把已知材料写进 evidence、把可核验要求写进 acceptance。返回的 summary/artifacts/blockers 是子代理的真实运行结果，直接引用，不要改写成自己的判断。',
      '- 点名必须精确：名字不存在或席位未启用时工具会报错，此时如实告诉用户，不要自动换成别的成员。',
      '- 专家席位是只读的：write / edit / bash / pwsh / str_replace_editor / skill / job_kill 这些工具根本不在它们手里，也别指望它们替你动手。',
      '- 当前团队只运行只读 spawn 委派。副作用可提交提案，但需要独立可信执行器接入；批准不是执行结果，不得在普通主会话直接调用工具冒充已走团队门禁。desktop_team_finish_operation 只查询可信结果，不接受模型自报结账。',
      '- 非零累计 token 预算当前无法硬约束，任务会拒绝启动；不得擅自改成 0 绕过预算。无可信成果核验器的任务保留 review，不能把 artifacts 非空当成完成。',
      '- 被门禁拒绝时按拒绝理由改正提案，不要换个工具、换个路径或拆成小步绕过去 —— 那只会让用户看到一堆被拦下的尝试。',
      '- 提案不等于授权。不要把"已提交提案"说成"已获批准"，不要把未核验的推断写进 artifacts。',
      '- 用户问团队进度或待批准事项：调用 desktop_team_status。',
      '- 用户要求停止某项工作：调用 desktop_team_cancel，并如实说明已发生的副作用不会被撤回。',
    ].join('\n'),
  })

  ctx.systemPrompt.variable('desktop_team_roster', () => {
    const members = team.roster()
    if (members.length === 0) return undefined
    return members
      .map(member => `- ${member.displayName}（${member.assistantId}）：${member.toolPolicy.mode}，${member.enabled ? '已启用' : '未启用'}`)
      .join('\n')
  })
  return dispose
}
