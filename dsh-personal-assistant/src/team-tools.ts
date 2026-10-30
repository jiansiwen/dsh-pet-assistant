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
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalService } from './approval.ts'
import { ApprovalError } from './approval.ts'
import { PATH_TARGET_TOOLS, canonicalPath, canonicalRoot, fileVersion, gateDecision, isWithinRoot } from './gate.ts'
import { HelpTaskError } from './help-task.ts'
import type { SessionBridge } from './bridge.ts'
import type { TaskOutcome, TeamService } from './team.ts'
import { REVIEW_RESOLUTIONS, type OperationRecord } from './team-domain.ts'

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

/** 帮助任务工具的统一失败回执：带上可编程判断的错误码。 */
function failure(error: unknown): string {
  return json({ ok: false, error: errorMessage(error), ...(error instanceof HelpTaskError ? { code: error.code } : {}) })
}

function tail(text: unknown, max: number): string | null {
  return typeof text === 'string' ? (text.length <= max ? text : `…${text.slice(-max)}`) : null
}

/** 验收证据的紧凑投影：退出码、结论、文件结果与输出结尾；完整输出留在账本里。 */
function evidenceView(evidence: unknown): unknown {
  if (typeof evidence !== 'object' || evidence === null) return null
  const record = evidence as Record<string, unknown>
  if (record.kind === 'run_verification') {
    return {
      kind: record.kind, outcome: record.outcome ?? null, verdict: record.verdict ?? null, exitCode: record.exitCode ?? null,
      signal: record.signal ?? null, timedOut: record.timedOut ?? false, durationMs: record.durationMs ?? null,
      stdoutTail: tail(record.stdout, 800), stderrTail: tail(record.stderr, 800),
      stdoutTruncated: record.stdoutTruncated ?? false, stderrTruncated: record.stderrTruncated ?? false,
      fileResults: record.fileResults ?? null,
    }
  }
  return evidence
}

/** 可信账目的对外投影：只给摘要与时间，不含参数或结果正文。 */
function operationView(item: OperationRecord) {
  return {
    operationId: item.operationId,
    taskId: item.taskId,
    kind: item.kind,
    target: item.target ?? null,
    state: item.state,
    startedAt: item.startedAt,
    executedAt: item.executedAt ?? null,
    endedAt: item.endedAt,
    resultDetail: item.resultDetail ?? null,
    evidence: evidenceView(item.evidence),
    review: item.review ?? null,
  }
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
    description: '开启桌面专家助理团：把当前会话登记为总助理的宿主会话，写入团队成员编制，并让桌面宠物可以显示多角色舞台与任务面板。用户说"开启团队模式"、"叫上专家"、"启动助理团"时调用。',
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
    description: '根据当前成员目录的职责与能力自动选择合适成员，派发任务并等待真实结果，再向用户汇总；不要让用户手工选人。member 使用目录中的 assistantId 或准确名称。不存在、停用或额度不足时如实报告，不静默换人。工具权限与日/总额度只读持久配置，派发不能修改。',
    parameters: {
      member: { type: 'string', required: true, description: '根据目录职责自动选择的成员 assistantId 或准确名称，不是固定角色' },
      goal: { type: 'string', required: true, description: '任务目标，一句话说清要解决什么' },
      evidence: { type: 'array', items: { type: 'string' }, description: '交给成员的已知材料（文件路径、报错原文、用户原话等）' },
      acceptance: { type: 'array', items: { type: 'string' }, description: '验收条件；当前自由文本产物需独立复核，模型自报不能标记任务完成' },
      dependsOn: { type: 'array', items: { type: 'string' }, description: '前置任务 id；前置未完成时本任务留在排队状态' },
    },
    output: textOutput,
    async execute(
      args: { member: string; goal: string; evidence?: string[]; acceptance?: string[]; dependsOn?: string[]; budgetTokens?: number },
      exec: unknown,
    ) {
      const context = exec as ExecContext
      if (!context.agent) return json({ ok: false, error: '当前执行上下文没有可绑定的会话 agent，无法委派子代理' })
      if (args.budgetTokens !== undefined && args.budgetTokens !== 0) return json({ ok: false, error: '委派工具不能设置或扩大额度，请由本人在团队设置中确认；旧预算参数非零时拒绝' })
      const member = team.resolveByName(args.member)
      if (!member) {
        return json({
          ok: false,
          error: `没有可接单的成员叫「${args.member}」`,
          enabled: team.enabledMembers().map(item => item.displayName),
          note: '名字不存在或席位未启用时不会替换成别人；按最新目录核对，不要求用户手工选人或擅自开启成员',
        })
      }
      const task = team.submitTask({
        goal: args.goal,
        inputEvidence: args.evidence ?? [],
        acceptance: args.acceptance ?? [],
        ownerId: member.assistantId,
        toolScope: 'read-only',
        dependsOn: args.dependsOn ?? [],
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
          description: member.description ?? member.persona,
          capabilities: member.capabilities ?? [],
          allowedTools: member.allowedTools ?? [],
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
        operations: approvals.operations(args.taskId).slice(0, 20).map(operationView),
        // 帮助任务：episode / 授权范围 / 每版改动 / 每次验证 / 由账本推出的结论（mayClaimFixed 只看真实退出码）。
        ...(args.taskId && team.help.helpTask(args.taskId) ? { help: team.help.status(args.taskId) } : {}),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_team_cancel',
    description: '取消一个任务：停掉它正在运行的子代理并把状态置为 cancelled。返回结构化回执 state（not-executed 未执行 / cancelling 取消中 / terminated 已终止 / partially-executed 已部分执行 / unknown 结果未知）与终止证据；已经发生的外部副作用不会被撤回，返回里会列出，必须如实告知用户，不得把「取消中」说成已停止。',
    parameters: {
      taskId: { type: 'string', required: true, description: '要取消的任务 id' },
    },
    output: textOutput,
    async execute(args: { taskId: string }) {
      // 回执只认真实终止证据（运行结束记录 + 子代理释放完成）；等不到就如实报「取消中」。
      const receipt = await team.cancelWithReceipt(args.taskId)
      if (!receipt) return json({ ok: false, error: `任务 ${args.taskId} 不存在` })
      const task = team.getTask(args.taskId)
      return json({
        ok: true,
        taskId: args.taskId,
        status: task?.status ?? receipt.evidence.taskStatus ?? null,
        state: receipt.state,
        evidence: receipt.evidence,
        message: receipt.message,
        operationsAlreadyPerformed: approvals.operations(args.taskId).map(item => ({ kind: item.kind, target: item.target ?? null, state: item.state })),
        note: '取消只停止后续工作，已执行的副作用不会自动回滚；结果不明的副作用不会自动重发',
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
    async execute(args: { taskId: string; summary: string; tool: string; target: string; params?: unknown; risk: 'low' | 'medium' | 'high'; assistantId?: string }, exec: unknown) {
      const task = team.getTask(args.taskId)
      if (!task) return json({ ok: false, error: `任务 ${args.taskId} 不存在` })
      const assistantId = args.assistantId ?? task.ownerId
      if (assistantId !== task.ownerId || !team.member(assistantId)?.enabled) return json({ ok: false, error: '提案成员与任务成员不符或已停用' })
      if (['done', 'failed', 'cancelled', 'unknown'].includes(task.status)) return json({ ok: false, error: '任务已终止或结果不明，需先复核' })
      const decision = gateDecision(args.tool, args.params)
      if (decision.kind !== 'gated' || decision.target !== args.target) return json({ ok: false, error: '工具不支持审批或完整参数中的目标与提案不符' })
      // 写类目标按执行器同一口径规范化成真实路径：批准绑定的必须是执行时真正会写到的位置。
      let target = args.target
      let baseHash: string | null = null
      const cwd = (exec as ExecContext | undefined)?.agent?.session?.header?.cwd
      const root = canonicalRoot(cwd)
      if (PATH_TARGET_TOOLS.includes(args.tool) && root !== undefined && cwd !== undefined) {
        if (args.tool === 'str_replace_editor' && !path.isAbsolute(args.target)) return json({ ok: false, error: 'str_replace_editor 的 path 必须是绝对路径' })
        try {
          target = canonicalPath(args.target, cwd)
        } catch (error) {
          return json({ ok: false, error: `无法确认目标的实际位置：${errorMessage(error)}` })
        }
        if (!isWithinRoot(root, target)) {
          return json({ ok: false, error: `目标实际位置 ${target} 不在会话工作区 ${root} 内（符号链接与相似前缀按真实路径判断），执行器会拒绝` })
        }
        // 同时绑定目标此刻的内容版本：用户在批准后改了这个文件，这条批准就不能再用。
        baseHash = fileVersion(target)
      }
      const proposal = approvals.propose({
        taskId: task.taskId,
        assistantId,
        summary: args.summary,
        tool: args.tool,
        target,
        params: args.params ?? null,
        inputRevision: task.revision,
        risk: args.risk,
        baseHash,
      })
      return json({
        ok: true,
        proposalId: proposal.proposalId,
        state: proposal.state,
        target: proposal.target,
        baseHash,
        expiresAt: proposal.expiresAt,
        note: '等待可信审批决定。提交提案本身不执行副作用；获批也不代表已执行——只有该任务运行中的可信执行器以完全相同的参数调用时才会消费这一次批准，'
          + '执行结果以执行账本为准。不能在普通主会话直接调用工具代替。'
          + (baseHash !== null ? '批准还绑定了目标文件此刻的内容版本，文件在批准后被改动就需要重新提案。' : ''),
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
        return json({ ok: true, ...operationView(operation),
          note: '返回可信账目，忽略模型自报状态和摘要；结果不明时须人工核查，禁止盲重试' })
      } catch (error) {
        return json({ ok: false, error: errorMessage(error), note: '查不到执行记录说明门禁从未放行过这次副作用；不要凭空报成功。' })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_team_review_unknown',
    description:
      '为执行账本里一条结果不明（unknown）的操作申请人工复核。先请用户核对真实外部状态，再按用户的结论提交：'
      + 'verified-succeeded（已核实成功）/ verified-failed（已核实失败）/ abandoned（放弃核查）。'
      + '调用本身不改账本，只在桌面审批窗口生成一张复核卡；用户批准后结论才写进账本。模型自报的结论无效，不要对用户说已核实。',
    parameters: {
      operationId: { type: 'string', required: true, description: '执行账本里状态为 unknown 的 operationId（desktop_team_status 可查）' },
      resolution: { type: 'string', enum: [...REVIEW_RESOLUTIONS], required: true, description: '用户给出的结论' },
      note: { type: 'string', description: '用户核对的依据，原样写进复核卡与账本（不超过 500 字）' },
    },
    output: textOutput,
    async execute(args: { operationId: string; resolution: string; note?: string }) {
      try {
        return json(team.help.proposeReview(args))
      } catch (error) {
        return failure(error)
      }
    },
  }))

  // 帮助任务（M2-06）：只有装配了帮助授权来源才注册 —— 没有授权边界就不该有读取与改动入口。
  if (team.help.available) {
    ctx.tools.register(defineTool({
      name: 'desktop_team_open_help_task',
      description:
        '在用户已经经桌面审批窗口授权的帮助范围上开一个帮助任务（记在总助理名下，账本里可追溯）。之后的读取、改动提案、验证命令都挂在这个任务上。'
        + '没有有效授权（未授权、已撤销、实际路径已改指）会直接拒绝。',
      parameters: {
        projectDir: { type: 'string', required: true, description: '已授权帮助范围的项目目录（绝对路径，与授权记录一致）' },
        goal: { type: 'string', required: true, description: '这次帮助要做什么，一句话' },
        episodeId: { type: 'string', description: '从主动提醒进入时，personal_assistant_help_candidates 给出的 episodeId，用来把这次帮助串进账本' },
        helpContextId: { type: 'string', description: '可选：指定哪一条授权记录（同一目录既有目录级又有文件级授权时）' },
      },
      output: textOutput,
      async execute(args: { projectDir: string; goal: string; episodeId?: string; helpContextId?: string }) {
        try {
          const { task, link } = team.help.openTask(args)
          return json({ ok: true, taskId: task.taskId, status: task.status, projectRoot: link.projectRoot, currentFile: link.currentFile,
            episodeId: link.episodeId, helpContextId: link.helpContextId,
            note: '只能读取这个范围；改动用 desktop_team_propose_change，验证用 desktop_team_propose_verification，每一步都要用户单独批准。' })
        } catch (error) {
          return failure(error)
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'desktop_team_read_file',
      description:
        '只读帮助任务授权范围内的一个文件或目录（路径按真实位置判断，越界、授权撤销、二进制文件都会拒绝）。'
        + '文件返回全文内容哈希 hash —— 提交改动提案时它就是该文件的 baseHash；目录返回条目清单。',
      parameters: {
        taskId: { type: 'string', required: true, description: '帮助任务 id' },
        path: { type: 'string', description: '相对授权根目录或绝对路径；缺省读授权范围本身' },
        startLine: { type: 'integer', description: '从第几行开始（1 起），缺省 1' },
        maxLines: { type: 'integer', description: '最多返回多少行，缺省 2000，上限 4000' },
      },
      output: textOutput,
      async execute(args: { taskId: string; path?: string; startLine?: number; maxLines?: number }) {
        try {
          return json(team.help.read(args))
        } catch (error) {
          return failure(error)
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'desktop_team_propose_change',
      description:
        '为帮助任务提交一版改动提案（不写任何文件）。每个文件给出：path、读取时拿到的 baseHash（新建文件写 absent），'
        + '以及 content（整文件替换内容）或 diff（该文件的统一 diff）二选一。插件重算差异后推到桌面审批卡；'
        + '用户批准后由可信执行器应用：应用前重读哈希，文件在此期间被改过就冲突暂停、一个文件都不写；写入用临时文件加改名，前后哈希进账本。'
        + '同一任务的新提案会取代还没执行的旧提案。不要用 write/edit/bash 直接改用户的项目。',
      parameters: {
        taskId: { type: 'string', required: true, description: '帮助任务 id' },
        summary: { type: 'string', required: true, description: '一句话说明这版改动要解决什么（会显示在审批卡上）' },
        files: {
          type: 'array',
          required: true,
          description: '要改的文件，最多 20 个',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true, description: '相对授权根目录或绝对路径' },
              baseHash: { type: 'string', required: true, description: 'desktop_team_read_file 返回的 hash；新建文件写 absent' },
              content: { type: 'string', description: '整文件替换内容（与 diff 二选一）' },
              diff: { type: 'string', description: '针对这一个文件的统一 diff（@@ 段，上下文必须与读取到的内容逐字一致；与 content 二选一）' },
            },
          },
        },
      },
      output: textOutput,
      async execute(args: { taskId: string; summary: string; files: Array<{ path: string; baseHash: string; content?: string; diff?: string }> }) {
        try {
          return json(team.help.proposeChange(args))
        } catch (error) {
          return failure(error)
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'desktop_team_propose_verification',
      description:
        '为帮助任务提交一条验证命令（不运行）：程序 + 参数数组（不经 shell，不要把命令拼成一个字符串），cwd 必须在授权范围内，'
        + '必须给超时与预期副作用说明。程序会解析成绝对路径（不搜索工作目录）；shell、脚本宿主与 Windows 的 .cmd/.bat 不支持，'
        + '例如 npm 脚本请改成 node node_modules/<包>/bin/<入口>.js。批准后由可信执行器运行一次，真实退出码与截断输出写进账本。',
      parameters: {
        taskId: { type: 'string', required: true, description: '帮助任务 id' },
        program: { type: 'string', required: true, description: '程序名（如 node、python）或可执行文件路径' },
        args: { type: 'array', items: { type: 'string' }, required: true, description: '参数数组，每个参数单独一项' },
        cwd: { type: 'string', description: '工作目录（相对授权根目录或绝对路径），缺省为授权根目录' },
        timeoutSeconds: { type: 'integer', required: true, description: '超时秒数（1-1800），到点结束整个进程树' },
        expectedEffects: { type: 'string', required: true, description: '预期副作用说明，例如「只运行测试，不修改源文件」' },
      },
      output: textOutput,
      async execute(args: { taskId: string; program: string; args: string[]; cwd?: string; timeoutSeconds: number; expectedEffects: string }) {
        try {
          return json(team.help.proposeVerification(args))
        } catch (error) {
          return failure(error)
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'desktop_team_wait',
      description:
        '等待用户对改动 / 验证 / 复核审批卡的决定；批准后再等可信执行器跑完，返回账本结果与 verdict。'
        + '超时只表示还没等到，不会作废审批卡。只有 verdict.mayClaimFixed 为 true 才能说修复完成。',
      parameters: {
        proposalId: { type: 'string', required: true, description: 'propose 工具返回的 proposalId' },
        timeoutSeconds: { type: 'integer', description: '最多等多少秒，缺省 120，上限 600' },
      },
      output: textOutput,
      async execute(args: { proposalId: string; timeoutSeconds?: number }, exec: unknown) {
        const seconds = Math.min(600, Math.max(1, Math.floor(args.timeoutSeconds ?? 120)))
        try {
          return json({ ok: true, ...await team.help.wait(args.proposalId, (exec as ExecContext | undefined)?.signal ?? new AbortController().signal, seconds * 1000) })
        } catch (error) {
          return failure(error)
        }
      },
    }))
  }

  ctx.systemPrompt.section({
    name: 'desktop-team',
    order: 160,
    text: [
      '## 桌面专家助理团',
      '',
      '本环境装有 desktop_team_* 工具。你（当前会话）就是总助理：理解用户目标，根据当前目录中成员的职责与能力自动委派，再汇总结论。成员列表可变化，不是固定角色。',
      '',
      '成员编制（只有 enabled 的席位能接单）：',
      '{{desktop_team_roster}}',
      '',
      '协作规则：',
      '- 用户说"开启团队模式"、"叫上专家"：调用 desktop_team_start。',
      '- 请求与已启用成员职责匹配时，自动选择其 assistantId 调用 desktop_team_assign，不要让用户手工挑选，也不要只口头说已分派。把必要材料写进 evidence、可核验要求写进 acceptance；不转发总助理全局偏好或其他成员记忆。拿到真实 summary/artifacts/blockers 后再汇总，并保留证据与阻碍。',
      '- 使用目录中的准确身份。成员不存在、停用、忙碌或额度不足时如实解释；不静默换人，不替用户启用成员。',
      '- 成员只拥有目录配置的能力与三档权限；企业微信能力仅表示绑定路由，会议/文档工具只接受桌面本人指令，邮件发送与普通任务仍走各自原有审批。不得在普通主会话改用其他工具绕过成员拒绝；命令、权限配置、全局记忆和再委派不向成员开放。',
      '- 模型与单次输出上限、日额度、总额度都由本人配置。工具不能设置预算，不能自行增额、重置或批准申请。额度按真实用量累计，达到阈值生成待批申请，触线或用量未知后停止请求；首请求输入无法预知，不能承诺计费硬上限。无可信成果核验器的任务保留 review，不能把 artifacts 非空当成完成。',
      '- 被门禁拒绝时按拒绝理由改正提案，不要换个工具、换个路径或拆成小步绕过去 —— 那只会让用户看到一堆被拦下的尝试。',
      '- 提案不等于授权。不要把"已提交提案"说成"已获批准"，不要把未核验的推断写进 artifacts。',
      '- 用户问团队进度或待批准事项：调用 desktop_team_status。',
      '- 用户要求停止某项工作：调用 desktop_team_cancel，并如实说明已发生的副作用不会被撤回。',
      '- 执行账本里结果不明（unknown）的操作：先请用户核对真实情况，再按用户的结论调用 desktop_team_review_unknown（已核实成功 / 已核实失败 / 放弃）。只有用户在桌面审批窗口批准后结论才写进账本，不要自己宣布结果。',
      ...(team.help.available
        ? [
            '',
            '帮助任务（用户已经在桌面审批窗口确认了读取范围之后）：',
            '- 用 desktop_team_open_help_task 在该范围上开任务（从主动提醒进来的带上 episodeId）；读文件只用 desktop_team_read_file，它只读授权范围内的内容并给出内容哈希。',
            '- 改代码只能用 desktop_team_propose_change 提交改动提案（文件 + 统一 diff 或整文件内容 + 读取时的 baseHash），不要用 write/edit/bash 直接改用户的项目。用户在审批窗口核对差异并批准后由可信执行器应用；返回冲突暂停时说明文件已被改过、没有写入，重新读取后再提交新一版。',
            '- 验证用 desktop_team_propose_verification（程序 + 参数数组 + 授权范围内的 cwd + 超时 + 预期副作用说明），批准后只运行一次。',
            '- 用 desktop_team_wait 等决定与执行结果。只有 verdict.mayClaimFixed 为 true（验证命令真实退出码为 0）才能说「修好了」或「验证通过」；已应用未验证、验证失败、冲突暂停、结果不明都要照实说。',
            '- 用户同意一起看，只代表愿意开始；读取范围、每一处改动、每一条命令都要各自经桌面审批，不能拿前一次同意顶替。用户只是一段时间没有输入，不要说成用户遇到了困难。',
          ]
        : []),
    ].join('\n'),
  })

  const CAPABILITY_LABELS: Record<string, string> = { wecom: '企业微信接收', mail: '邮件收发与分析', meeting: '会议记录', document: '文档讲解', activity: '活动/日报', reminders: '提醒' }
  ctx.systemPrompt.variable('desktop_team_roster', () => {
    const members = team.roster()
    // 空值会被宿主当成装配错误直接炸（真机实测过），空态必须给字符串。
    if (members.length === 0) return '（还没有成员。需要时引导用户到宠物设置的团队管理中添加，不要虚构成员。）'
    return members
      .map(member => `- ${member.displayName}（${member.assistantId}）：${member.enabled ? '已启用' : '未启用'}；职责：${member.description || member.persona}；能力：${member.capabilities?.map(capability => CAPABILITY_LABELS[capability] ?? capability).join('、') || '无外部能力'}；只读工具：${member.allowedTools?.join('、') || '无额外工具'}${member.roleId === 'tangseng' ? '；当前总助理，不向自身委派' : ''}`)
      .join('\n')
  })
  return dispose
}
