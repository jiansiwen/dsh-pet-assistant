/**
 * 团队业务数据层：稳定成员身份、任务状态、审批与操作记账、展示事件发件箱。
 *
 * 单写入者：只有宿主内的团队服务写这个库，桌面壳通过受控接口读取投影。
 * 库存的是团队自身业务状态与子会话引用，不复制 dsh 的会话日志。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

/** 业务库 schema 版本，单调递增；不兼容变更必须新增迁移步骤而不是原地改表。 */
export const TEAM_SCHEMA_VERSION = 3

export const ROLE_IDS = ['tangseng', 'wukong', 'bajie', 'shaseng', 'bailongma'] as const
export type RoleId = (typeof ROLE_IDS)[number]

/**
 * 成员可执行的工具范围。`read-only` 只允许分析类工具；`side-effect` 允许产生外部副作用，
 * 但每次副作用仍要经审批与执行点校验。`denyTools` 在执行点生效，不是提示词约束。
 */
export interface ToolPolicy {
  readonly mode: 'read-only' | 'side-effect'
  readonly denyTools: readonly string[]
}

/** 一个助理的稳定身份。换形象不换 assistantId，换职责必须提升 revision。 */
export interface MemberConfig {
  readonly assistantId: string
  readonly roleId: RoleId
  readonly displayName: string
  readonly skinId: string
  /** 人设只描述表达方式，不携带可执行脚本，也不能覆盖安全规则。 */
  readonly persona: string
  readonly voiceProfile: string
  readonly toolPolicy: ToolPolicy
  readonly enabled: boolean
  readonly revision: number
}

export const TASK_STATUSES = [
  'created',
  'queued',
  'running',
  'awaiting-approval',
  'awaiting-user',
  'review',
  'done',
  'failed',
  'cancelled',
  'unknown',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** 终态：不再接受新的执行步骤，只接受复核或重新开任务。 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'cancelled']

export interface Task {
  readonly taskId: string
  readonly teamId: string
  readonly ownerId: string
  readonly goal: string
  readonly inputEvidence: readonly string[]
  readonly acceptance: readonly string[]
  readonly toolScope: ToolPolicy['mode']
  readonly budgetTokens: number
  readonly deadlineAt: number | null
  readonly dependsOn: readonly string[]
  readonly status: TaskStatus
  readonly revision: number
  readonly artifacts: readonly string[]
  /** 发起这次任务的桥接请求；回复按它归属，不靠空闲状态猜测。 */
  readonly originRequestId: string | null
  readonly originChannel: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export const RUN_STATES = ['running', 'succeeded', 'failed', 'cancelled', 'unknown'] as const
export type RunState = (typeof RUN_STATES)[number]

/** 一次任务运行尝试。投递成功不等于任务完成，完成由产物验收决定。 */
export interface TaskRun {
  readonly runId: string
  readonly taskId: string
  readonly assistantId: string
  readonly childSessionId: string | null
  readonly messageId: string | null
  readonly state: RunState
  readonly stopReason: string | null
  readonly outputDigest: string | null
  readonly startedAt: number
  readonly endedAt: number | null
}

export const PROPOSAL_STATES = ['pending', 'approved', 'rejected', 'expired'] as const
export type ProposalState = (typeof PROPOSAL_STATES)[number]

/** 专家提交的副作用计划。批准绑定摘要，执行点重新校验身份、期限与范围。 */
export interface ActionProposal {
  readonly proposalId: string
  readonly taskId: string
  readonly assistantId: string
  readonly summary: string
  /** 将来要调用的宿主工具名，如 write / bash；执行点门禁按它匹配批准。 */
  readonly tool: string
  readonly target: string
  readonly paramsDigest: string
  readonly inputRevision: number
  readonly risk: 'low' | 'medium' | 'high'
  readonly state: ProposalState
  readonly createdAt: number
  readonly expiresAt: number
}

/** 一条批准记录，只能被消费一次。 */
export interface Approval {
  readonly approvalId: string
  readonly proposalId: string
  readonly planDigest: string
  readonly scope: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly consumedAt: number | null
}

export const OPERATION_STATES = ['planned', 'running', 'succeeded', 'failed', 'unknown'] as const
export type OperationState = (typeof OPERATION_STATES)[number]

/** 副作用操作记账。超时进入 unknown，必须先核查真实外部状态，禁止盲重试。 */
export interface OperationRecord {
  readonly operationId: string
  readonly taskId: string
  readonly approvalId: string | null
  readonly kind: string
  readonly state: OperationState
  readonly resultDigest: string | null
  readonly startedAt: number
  readonly endedAt: number | null
}

export const TEAM_EVENT_TYPES = [
  'team/member-updated',
  'task/created',
  'task/updated',
  'task/artifact',
  'run/started',
  'run/ended',
  'proposal/created',
  'proposal/decided',
  'operation/updated',
  'reply/delta',
  'reply/done',
] as const
export type TeamEventType = (typeof TEAM_EVENT_TYPES)[number]

/** 发件箱事件。数据提交后生成，界面只是投影；桥接按 seq 游标增量重放。 */
export interface TeamEvent {
  readonly seq: number
  readonly type: TeamEventType
  readonly taskId: string | null
  readonly assistantId: string | null
  readonly payload: unknown
  readonly createdAt: number
}

interface Row {
  [key: string]: string | number | bigint | null
}

function text(value: string | null | undefined): string | null {
  return value === undefined || value === null ? null : value
}

function num(value: number | null | undefined): number | null {
  return value === undefined || value === null ? null : value
}

function bool(value: boolean): number {
  return value ? 1 : 0
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null)
}

/** action_proposals 行 → ActionProposal。getProposal / listProposals / findGateProposal 共用一份映射。 */
function rowToProposal(row: Row): ActionProposal {
  return {
    proposalId: String(row.proposal_id),
    taskId: String(row.task_id),
    assistantId: String(row.assistant_id),
    summary: String(row.summary),
    tool: String(row.tool ?? ''),
    target: String(row.target),
    paramsDigest: String(row.params_digest),
    inputRevision: Number(row.input_revision),
    risk: String(row.risk) as ActionProposal['risk'],
    state: String(row.state) as ProposalState,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  }
}

/** operations 行 → OperationRecord。 */
function rowToOperation(row: Row): OperationRecord {
  return {
    operationId: String(row.operation_id),
    taskId: String(row.task_id),
    approvalId: text(row.approval_id as string | null),
    kind: String(row.kind),
    state: String(row.state) as OperationState,
    resultDigest: text(row.result_digest as string | null),
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
  }
}

function parseList(raw: string | null): string[] {
  if (!raw) return []
  const parsed: unknown = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
}

/** 团队业务库。所有写操作都在这里，读取用只读投影方法。 */
export class TeamStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  /** 从库内建表；已存在的库按 user_version 逐步升级，失败即抛出，不启动采集与自动执行。 */
  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as Row | undefined
    const current = Number(row?.user_version ?? 0)
    if (current > TEAM_SCHEMA_VERSION) {
      throw new Error(`team store schema ${current} is newer than supported ${TEAM_SCHEMA_VERSION}`)
    }
    if (current === TEAM_SCHEMA_VERSION) return

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assistants (
        assistant_id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        skin_id TEXT NOT NULL,
        persona TEXT NOT NULL,
        voice_profile TEXT NOT NULL,
        tool_policy TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        revision INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        input_evidence TEXT NOT NULL,
        acceptance TEXT NOT NULL,
        tool_scope TEXT NOT NULL,
        budget_tokens INTEGER NOT NULL,
        deadline_at INTEGER,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        artifacts TEXT NOT NULL,
        origin_request_id TEXT,
        origin_channel TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id TEXT NOT NULL,
        depends_on TEXT NOT NULL,
        PRIMARY KEY (task_id, depends_on)
      );

      CREATE TABLE IF NOT EXISTS task_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        assistant_id TEXT NOT NULL,
        child_session_id TEXT,
        message_id TEXT,
        state TEXT NOT NULL,
        stop_reason TEXT,
        output_digest TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS action_proposals (
        proposal_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        assistant_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        tool TEXT NOT NULL DEFAULT '',
        target TEXT NOT NULL,
        params_digest TEXT NOT NULL,
        input_revision INTEGER NOT NULL,
        risk TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        scope TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        approval_id TEXT,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        result_digest TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS events_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        task_id TEXT,
        assistant_id TEXT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs (task_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_state ON action_proposals (state, expires_at);
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `)

    // v2 的库里 action_proposals 已经存在，上面那句 CREATE TABLE IF NOT EXISTS 对它是空操作，
    // 所以 tool 列必须显式补。按列名判断而不是按 user_version 判断，这段在 v3 形状的库上重跑也安全。
    const proposalColumns = this.db.prepare('PRAGMA table_info(action_proposals)').all() as Row[]
    if (!proposalColumns.some((column) => String(column.name) === 'tool')) {
      this.db.exec(`ALTER TABLE action_proposals ADD COLUMN tool TEXT NOT NULL DEFAULT ''`)
    }
    // 门禁的热路径：每次副作用工具调用前都要按这四列找一条可消费的批准。
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_proposals_gate ON action_proposals (task_id, tool, target, state)`,
    )

    this.db.exec(`PRAGMA user_version = ${TEAM_SCHEMA_VERSION}`)
    this.db
      .prepare('INSERT OR IGNORE INTO migrations (version, applied_at) VALUES (?, ?)')
      .run(TEAM_SCHEMA_VERSION, Date.now())
  }

  /** 在一个事务里执行写入；发件箱事件与业务变更同事务提交。 */
  transaction<T>(body: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = body()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  upsertMember(member: MemberConfig): void {
    this.db
      .prepare(
        `INSERT INTO assistants (assistant_id, role_id, display_name, skin_id, persona, voice_profile, tool_policy, enabled, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(assistant_id) DO UPDATE SET
           role_id = excluded.role_id,
           display_name = excluded.display_name,
           skin_id = excluded.skin_id,
           persona = excluded.persona,
           voice_profile = excluded.voice_profile,
           tool_policy = excluded.tool_policy,
           enabled = excluded.enabled,
           revision = excluded.revision`,
      )
      .run(
        member.assistantId,
        member.roleId,
        member.displayName,
        member.skinId,
        member.persona,
        member.voiceProfile,
        json(member.toolPolicy),
        bool(member.enabled),
        member.revision,
      )
  }

  listMembers(): MemberConfig[] {
    const rows = this.db.prepare('SELECT * FROM assistants ORDER BY revision DESC, assistant_id').all() as Row[]
    return rows.map((row) => this.toMember(row))
  }

  getMember(assistantId: string): MemberConfig | null {
    const row = this.db.prepare('SELECT * FROM assistants WHERE assistant_id = ?').get(assistantId) as
      | Row
      | undefined
    return row ? this.toMember(row) : null
  }

  private toMember(row: Row): MemberConfig {
    const policy = JSON.parse(String(row.tool_policy)) as Partial<ToolPolicy>
    return {
      assistantId: String(row.assistant_id),
      roleId: String(row.role_id) as RoleId,
      displayName: String(row.display_name),
      skinId: String(row.skin_id),
      persona: String(row.persona),
      voiceProfile: String(row.voice_profile),
      toolPolicy: {
        mode: policy.mode === 'side-effect' ? 'side-effect' : 'read-only',
        denyTools: Array.isArray(policy.denyTools) ? policy.denyTools.filter((t) => typeof t === 'string') : [],
      },
      enabled: Number(row.enabled) === 1,
      revision: Number(row.revision),
    }
  }

  insertTask(task: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, team_id, owner_id, goal, input_evidence, acceptance, tool_scope, budget_tokens,
                            deadline_at, status, revision, artifacts, origin_request_id, origin_channel,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.taskId,
        task.teamId,
        task.ownerId,
        task.goal,
        json(task.inputEvidence),
        json(task.acceptance),
        task.toolScope,
        task.budgetTokens,
        num(task.deadlineAt),
        task.status,
        task.revision,
        json(task.artifacts),
        text(task.originRequestId),
        text(task.originChannel),
        task.createdAt,
        task.updatedAt,
      )
    for (const dep of task.dependsOn) {
      this.db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on) VALUES (?, ?)').run(task.taskId, dep)
    }
  }

  getTask(taskId: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as Row | undefined
    return row ? this.toTask(row) : null
  }

  listTasks(filter?: { status?: TaskStatus; teamId?: string }): Task[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (filter?.status) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    if (filter?.teamId) {
      clauses.push('team_id = ?')
      params.push(filter.teamId)
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM tasks${where} ORDER BY created_at DESC`).all(...params) as Row[]
    return rows.map((row) => this.toTask(row))
  }

  private toTask(row: Row): Task {
    const deps = this.db
      .prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ? ORDER BY depends_on')
      .all(String(row.task_id)) as Row[]
    return {
      taskId: String(row.task_id),
      teamId: String(row.team_id),
      ownerId: String(row.owner_id),
      goal: String(row.goal),
      inputEvidence: parseList(text(row.input_evidence as string | null)),
      acceptance: parseList(text(row.acceptance as string | null)),
      toolScope: row.tool_scope === 'side-effect' ? 'side-effect' : 'read-only',
      budgetTokens: Number(row.budget_tokens),
      deadlineAt: row.deadline_at === null ? null : Number(row.deadline_at),
      dependsOn: deps.map((dep) => String(dep.depends_on)),
      status: String(row.status) as TaskStatus,
      revision: Number(row.revision),
      artifacts: parseList(text(row.artifacts as string | null)),
      originRequestId: text(row.origin_request_id as string | null),
      originChannel: text(row.origin_channel as string | null),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  /**
   * 以修订号比较更新任务，防止两个执行者重复领取或互相覆盖。
   * @returns 更新后的任务；期望修订不匹配时返回 null，调用方必须重新读取而不是强行覆盖。
   */
  updateTask(
    taskId: string,
    expectedRevision: number,
    patch: Partial<Pick<Task, 'status' | 'ownerId' | 'artifacts' | 'budgetTokens' | 'deadlineAt'>>,
  ): Task | null {
    const current = this.getTask(taskId)
    if (!current || current.revision !== expectedRevision) return null
    const next: Task = {
      ...current,
      status: patch.status ?? current.status,
      ownerId: patch.ownerId ?? current.ownerId,
      artifacts: patch.artifacts ?? current.artifacts,
      budgetTokens: patch.budgetTokens ?? current.budgetTokens,
      deadlineAt: patch.deadlineAt === undefined ? current.deadlineAt : patch.deadlineAt,
      revision: current.revision + 1,
      updatedAt: Date.now(),
    }
    const result = this.db
      .prepare(
        `UPDATE tasks SET owner_id = ?, status = ?, revision = ?, artifacts = ?, budget_tokens = ?, deadline_at = ?, updated_at = ?
         WHERE task_id = ? AND revision = ?`,
      )
      .run(
        next.ownerId,
        next.status,
        next.revision,
        json(next.artifacts),
        next.budgetTokens,
        num(next.deadlineAt),
        next.updatedAt,
        taskId,
        expectedRevision,
      )
    return Number(result.changes) === 1 ? this.getTask(taskId) : null
  }

  /** 依赖环检查：写入前拒绝任何会形成环的依赖边。 */
  wouldCreateCycle(taskId: string, dependsOn: string): boolean {
    if (taskId === dependsOn) return true
    const seen = new Set<string>()
    const stack = [dependsOn]
    while (stack.length > 0) {
      const current = stack.pop() as string
      if (current === taskId) return true
      if (seen.has(current)) continue
      seen.add(current)
      const rows = this.db
        .prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ?')
        .all(current) as Row[]
      for (const row of rows) stack.push(String(row.depends_on))
    }
    return false
  }

  insertRun(run: TaskRun): void {
    this.db
      .prepare(
        `INSERT INTO task_runs (run_id, task_id, assistant_id, child_session_id, message_id, state, stop_reason,
                               output_digest, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.runId,
        run.taskId,
        run.assistantId,
        text(run.childSessionId),
        text(run.messageId),
        run.state,
        text(run.stopReason),
        text(run.outputDigest),
        run.startedAt,
        num(run.endedAt),
      )
  }

  /** 委派被宿主接受后回填子会话 id，让这条运行记录能追溯到具体子会话。 */
  attachChildSession(runId: string, childSessionId: string): void {
    this.db.prepare('UPDATE task_runs SET child_session_id = ? WHERE run_id = ?').run(childSessionId, runId)
  }

  /** 首次结算后不可被迟到的结果覆盖。 */
  finishRun(runId: string, state: RunState, stopReason: string | null, outputDigest: string | null): boolean {
    const result = this.db
      .prepare("UPDATE task_runs SET state = ?, stop_reason = ?, output_digest = ?, ended_at = ? WHERE run_id = ? AND state = 'running'")
      .run(state, text(stopReason), text(outputDigest), Date.now(), runId)
    return Number(result.changes) === 1
  }

  listRuns(taskId: string): TaskRun[] {
    const rows = this.db
      .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at')
      .all(taskId) as Row[]
    return rows.map((row) => ({
      runId: String(row.run_id),
      taskId: String(row.task_id),
      assistantId: String(row.assistant_id),
      childSessionId: text(row.child_session_id as string | null),
      messageId: text(row.message_id as string | null),
      state: String(row.state) as RunState,
      stopReason: text(row.stop_reason as string | null),
      outputDigest: text(row.output_digest as string | null),
      startedAt: Number(row.started_at),
      endedAt: row.ended_at === null ? null : Number(row.ended_at),
    }))
  }

  insertProposal(proposal: ActionProposal): void {
    this.db
      .prepare(
        `INSERT INTO action_proposals (proposal_id, task_id, assistant_id, summary, tool, target, params_digest,
                                       input_revision, risk, state, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.proposalId,
        proposal.taskId,
        proposal.assistantId,
        proposal.summary,
        proposal.tool,
        proposal.target,
        proposal.paramsDigest,
        proposal.inputRevision,
        proposal.risk,
        proposal.state,
        proposal.createdAt,
        proposal.expiresAt,
      )
  }

  getProposal(proposalId: string): ActionProposal | null {
    const row = this.db.prepare('SELECT * FROM action_proposals WHERE proposal_id = ?').get(proposalId) as
      | Row
      | undefined
    return row ? rowToProposal(row) : null
  }

  /**
   * 门禁查找：同一任务下、同一工具、同一作用目标、已获批准的提案，最新的一条。
   * 走 idx_proposals_gate；这是每次副作用工具调用前的热路径。
   */
  findGateProposal(taskId: string, tool: string, target: string,
    binding?: Pick<ActionProposal, 'assistantId' | 'inputRevision' | 'paramsDigest'>,
  ): ActionProposal | null {
    const row = this.db
      .prepare(
        `SELECT * FROM action_proposals
          WHERE task_id = ? AND tool = ? AND target = ? AND state = 'approved'
          ${binding ? 'AND assistant_id = ? AND input_revision = ? AND params_digest = ?' : ''}
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId, tool, target, ...(binding ? [binding.assistantId, binding.inputRevision, binding.paramsDigest] : [])) as Row | undefined
    return row ? rowToProposal(row) : null
  }

  listProposals(state?: ProposalState): ActionProposal[] {
    const rows = (
      state
        ? this.db.prepare('SELECT * FROM action_proposals WHERE state = ? ORDER BY created_at DESC').all(state)
        : this.db.prepare('SELECT * FROM action_proposals ORDER BY created_at DESC').all()
    ) as Row[]
    return rows.map(rowToProposal)
  }

  setProposalState(proposalId: string, state: ProposalState): void {
    this.db.prepare('UPDATE action_proposals SET state = ? WHERE proposal_id = ?').run(state, proposalId)
  }

  insertApproval(approval: Approval): void {
    this.db
      .prepare(
        `INSERT INTO approvals (approval_id, proposal_id, plan_digest, scope, issued_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.approvalId,
        approval.proposalId,
        approval.planDigest,
        approval.scope,
        approval.issuedAt,
        approval.expiresAt,
        num(approval.consumedAt),
      )
  }

  getApproval(approvalId: string): Approval | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(approvalId) as Row | undefined
    if (!row) return null
    return {
      approvalId: String(row.approval_id),
      proposalId: String(row.proposal_id),
      planDigest: String(row.plan_digest),
      scope: String(row.scope),
      issuedAt: Number(row.issued_at),
      expiresAt: Number(row.expires_at),
      consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
    }
  }

  /** 按提案反查已签发的批准（最近一条）。调用方凭 proposalId 消费，无需持有 approvalId。 */
  approvalForProposal(proposalId: string): Approval | null {
    const row = this.db
      .prepare('SELECT * FROM approvals WHERE proposal_id = ? ORDER BY issued_at DESC LIMIT 1')
      .get(proposalId) as Row | undefined
    if (!row) return null
    return {
      approvalId: String(row.approval_id),
      proposalId: String(row.proposal_id),
      planDigest: String(row.plan_digest),
      scope: String(row.scope),
      issuedAt: Number(row.issued_at),
      expiresAt: Number(row.expires_at),
      consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
    }
  }

  /** 条件更新：只有未消费且未过期的批准能被消费一次，重放直接失败。 */
  consumeApproval(approvalId: string, planDigest: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE approvals SET consumed_at = ?
         WHERE approval_id = ? AND consumed_at IS NULL AND expires_at > ? AND plan_digest = ?`,
      )
      .run(now, approvalId, now, planDigest)
    return Number(result.changes) === 1
  }

  insertOperation(operation: OperationRecord): void {
    this.db
      .prepare(
        `INSERT INTO operations (operation_id, task_id, approval_id, kind, state, result_digest, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operation.operationId,
        operation.taskId,
        text(operation.approvalId),
        operation.kind,
        operation.state,
        text(operation.resultDigest),
        operation.startedAt,
        num(operation.endedAt),
      )
  }

  setOperationState(operationId: string, state: OperationState, resultDigest: string | null): void {
    this.db
      .prepare('UPDATE operations SET state = ?, result_digest = ?, ended_at = ? WHERE operation_id = ?')
      .run(state, text(resultDigest), Date.now(), operationId)
  }

  getOperation(operationId: string): OperationRecord | null {
    const row = this.db.prepare('SELECT * FROM operations WHERE operation_id = ?').get(operationId) as Row | undefined
    return row ? rowToOperation(row) : null
  }

  /**
   * 凭批准反查它名下的操作记录。
   *
   * 门禁在真实工具调用点消费批准时就地建了 planned 记录，模型事后凭 proposalId 结账，
   * 走的就是这条路径，不需要它自己记住 operationId。
   */
  operationForApproval(approvalId: string): OperationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM operations WHERE approval_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(approvalId) as Row | undefined
    return row ? rowToOperation(row) : null
  }

  /** 已登记的副作用操作，按开始时间倒序；不传 taskId 则返回全部。 */
  listOperations(taskId?: string): OperationRecord[] {
    const rows = (
      taskId
        ? this.db.prepare('SELECT * FROM operations WHERE task_id = ? ORDER BY started_at DESC').all(taskId)
        : this.db.prepare('SELECT * FROM operations ORDER BY started_at DESC').all()
    ) as Row[]
    return rows.map(rowToOperation)
  }

  /** 提交一条展示事件，返回单调序号；必须与业务变更同事务调用。 */
  appendEvent(
    type: TeamEventType,
    payload: unknown,
    refs?: { taskId?: string | null; assistantId?: string | null },
  ): number {
    const result = this.db
      .prepare(
        'INSERT INTO events_outbox (type, task_id, assistant_id, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(type, text(refs?.taskId ?? null), text(refs?.assistantId ?? null), json(payload), Date.now())
    return Number(result.lastInsertRowid)
  }

  /** 按游标增量读取事件；调用方超出保留窗口时需要重新取快照。 */
  eventsSince(seq: number, limit = 200): TeamEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events_outbox WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(seq, limit) as Row[]
    return rows.map((row) => ({
      seq: Number(row.seq),
      type: String(row.type) as TeamEventType,
      taskId: text(row.task_id as string | null),
      assistantId: text(row.assistant_id as string | null),
      payload: JSON.parse(String(row.payload)),
      createdAt: Number(row.created_at),
    }))
  }

  /** 只清理本应用拥有的过期事件，保留窗口按毫秒配置。 */
  pruneEvents(retentionMs: number): number {
    const cutoff = Date.now() - retentionMs
    const result = this.db.prepare('DELETE FROM events_outbox WHERE created_at < ?').run(cutoff)
    return Number(result.changes)
  }

  close(): void {
    this.db.close()
  }
}
