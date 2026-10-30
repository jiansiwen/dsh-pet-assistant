/**
 * 团队业务数据层：稳定成员身份、任务状态、审批与操作记账、展示事件发件箱。
 *
 * 单写入者：只有宿主内的团队服务写这个库，桌面壳通过受控接口读取投影。
 * 库存的是团队自身业务状态与子会话引用，不复制 dsh 的会话日志。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CompanionBlocker, CompanionCommand, CompanionHttpResult, CompanionInput, CompanionTaskKind, DesktopReminderDelivery, ReminderSchedule } from './companion-contract.ts'
import { MemberDirectory, migrateMemberDirectory } from './member-directory.ts'

export interface CompanionTaskMeta {
  taskId: string
  runtimeScope: 'team' | 'companion'
  principalId: string
  deviceId: string
  parentTaskId: string | null
  kind: CompanionTaskKind
  inputRef: string
  blocker: CompanionBlocker
}

export interface CompanionInputRecord {
  inputRef: string
  principalId: string
  input: CompanionInput
  digest: string
  createdAt: number
}

export interface CompanionCommandRecord {
  commandId: string
  principalId: string
  digest: string
  pathname: string
  command: CompanionCommand
  epoch: string
  taskId: string
  proposalId: string
  state: 'pending' | 'applied' | 'rejected'
  result: CompanionHttpResult
}

export interface CompanionScheduleRecord {
  scheduleId: string
  taskId: string
  revision: number
  spec: ReminderSchedule
  nextRunAt: number | null
  enabled: boolean
  schedulerOwner: string
  generation: number
  missedPolicy: 'coalesce'
  grantRef: string
}

export interface ReminderGrantRecord {
  grantRef: string
  taskId: string
  principalId: string
  deviceId: string
  operationId: string
  taskRevision: number
  generation: number
  scopeDigest: string
  enabled: boolean
}

export interface ReminderCycleRecord {
  cycleId: string
  scheduleId: string
  generation: number
  triggerAt: number
  childTaskId: string
  relatedBusinessTaskId: string | null
  state: 'scheduled' | 'awaiting-response' | 'acknowledged' | 'snoozed' | 'cancelled' | 'unknown'
  repeatIntervalMs: number
  nextNagAt: number | null
  snoozedUntil: number | null
  ackActorId: string | null
  ackAt: number | null
  revision: number
  grantRef: string
}

export interface ReminderDeliveryRecord extends DesktopReminderDelivery {
  generation: number
  grantRef: string
  state: 'pending' | 'sending' | 'accepted' | 'failed-before-send' | 'unknown' | 'cancelled' | 'partial'
  attemptCount: number
  submittedAt: number | null
  acceptedAt: number | null
  receiptDigest: string | null
  evidenceRefs: string[]
}

interface CompanionRecords {
  task_meta: CompanionTaskMeta
  companion_inputs: CompanionInputRecord
  task_commands: CompanionCommandRecord
  schedules: CompanionScheduleRecord
  reminder_grants: ReminderGrantRecord
  reminder_cycles: ReminderCycleRecord
  deliveries: ReminderDeliveryRecord
  companion_contexts: CompanionContextRecord
}

export interface CompanionContextRecord {
  contextId: string
  principalId: string
  deviceId: string
  url: string
  title: string
  selection: string
  text: string
  truncated: boolean
  capturedAt: number
  expiresAt: number
  usedAt: number | null
}

/**
 * 业务库 schema 版本，单调递增；不兼容变更必须新增迁移步骤而不是原地改表。
 * v4：操作账本补成员、规范化目标、输入摘要、运行、执行开始时间与结果说明，重启后可直接定位复核。
 * v5：帮助任务（授权项目绑定）、改动提案（基线哈希与修订）、验证命令、unknown 人工复核；
 *     提案补基线哈希与审阅内容，操作账本补验收证据与人工复核结论。
 * v9：通用成员扩展配置、独立用量、额度申请与重置基线账本。
 */
export const TEAM_SCHEMA_VERSION = 9

export const ROLE_IDS = ['tangseng', 'wukong', 'bajie', 'shaseng', 'bailongma', 'custom'] as const
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
  /**
   * 写类目标在提案时的内容版本（sha256 或 `absent`）。给出时执行点会重读目标，版本不符就拒绝：
   * 批准绑定的是「把这一版文件改成这样」，用户在批准后改过文件，旧批准不能套到新内容上。
   */
  readonly baseHash?: string | null
  /** 可信执行器动作（改动 / 验证 / 复核）的审阅全文，桌面审批卡按它展示差异或命令；其余提案没有。 */
  readonly content?: string
  /** 审阅全文对应的绑定摘要（与 paramsDigest 相同），只随带审阅全文的提案给出。 */
  readonly digest?: string
  /** 提案修订：同一任务里第几版改动提案；只随带审阅全文的提案给出。 */
  readonly revision?: number
}

/** 门禁查找批准用的绑定字段；baseHash 是写类目标此刻的内容版本（不传 = 不按版本筛）。 */
export type GateBinding = Pick<ActionProposal, 'assistantId' | 'inputRevision' | 'paramsDigest'> & {
  readonly baseHash?: string | null
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

/**
 * abandoned 只能由可信人工复核产生：用户确认结果仍然无法核实、决定放弃追查。它不再挡住后续动作，
 * 但永远不会被当成成功。
 */
export const OPERATION_STATES = ['planned', 'running', 'succeeded', 'failed', 'unknown', 'abandoned'] as const
export type OperationState = (typeof OPERATION_STATES)[number]

/** 已有结论、不再接受迟到结果的操作状态。 */
export const SETTLED_OPERATION_STATES: readonly OperationState[] = ['succeeded', 'failed', 'abandoned']

/** 结果不明时用户可选的三种人工复核结论。 */
export const REVIEW_RESOLUTIONS = ['verified-succeeded', 'verified-failed', 'abandoned'] as const
export type ReviewResolution = (typeof REVIEW_RESOLUTIONS)[number]

/** 写在被复核操作上的人工结论；只能来自桌面可信批准，模型自报无效。 */
export interface OperationReview {
  readonly reviewId: string
  readonly proposalId: string
  readonly resolution: ReviewResolution
  readonly note: string
  readonly decidedAt: number
  /** 复核前的结果说明，原样保留以便追溯。 */
  readonly previousDetail: string | null
}

/**
 * 副作用操作记账。超时进入 unknown，必须先核查真实外部状态，禁止盲重试。
 *
 * 状态只按真实工具生命周期推进：planned（批准已消费、尚未进入工具体）→ running（即将进入工具体，
 * executedAt 落库）→ succeeded / failed / unknown（来自 tools/result）。进程在任一步中断，重启对账一律
 * 记 unknown 等人工核查，绝不自动重发。账本只存摘要：目标、参数摘要与结果摘要，不复制正文。
 */
export interface OperationRecord {
  readonly operationId: string
  readonly taskId: string
  readonly approvalId: string | null
  readonly kind: string
  readonly state: OperationState
  readonly resultDigest: string | null
  /** 预登记（消费批准）的时间。 */
  readonly startedAt: number
  readonly endedAt: number | null
  /** 执行成员；可信调度器绑定，不取模型自报。旧版行为 null。 */
  readonly assistantId?: string | null
  /** 规范化后的作用目标（写类为解析符号链接后的真实路径）。旧版行为 null。 */
  readonly target?: string | null
  /** 完整参数的摘要，不存参数正文。旧版行为 null。 */
  readonly paramsDigest?: string | null
  /** 执行它的那次运行。 */
  readonly runId?: string | null
  /** 真正进入工具体的时间；null 表示还没开始执行（或无从得知）。 */
  readonly executedAt?: number | null
  /** 结果的简短说明（成功 / 错误码与截断信息 / 中断原因），不含正文。 */
  readonly resultDetail?: string | null
  /**
   * 验收证据（v5）：改动应用记前后哈希；验证命令记真实退出码、截断后的输出与文件结果。
   * 由可信执行器写入，模型拿不到写入口。
   */
  readonly evidence?: unknown
  /** 人工复核结论（v5）；只有可信批准能写。 */
  readonly review?: OperationReview | null
}

/** 帮助任务：把团队账本里的一个任务绑到一次已授权的帮助范围（M2-06 / M3-07）。 */
export interface HelpTaskLink {
  readonly taskId: string
  /** 授权项目目录的真实路径；读取、改动与验证都只认它。 */
  readonly projectRoot: string
  /** 文件级授权时唯一允许的文件（真实路径）；目录级授权为 null。 */
  readonly currentFile: string | null
  /** 助理库 help_contexts.id：跨库引用，只用于追溯。 */
  readonly helpContextId: string | null
  /** 主动帮助 episode id（跨库引用）；用户直接发起的帮助为 null。 */
  readonly episodeId: string | null
  readonly createdAt: number
}

export const CHANGE_STATES = [
  'pending', 'approved', 'applying', 'applied', 'conflict', 'failed', 'unknown',
  'rejected', 'expired', 'superseded', 'abandoned',
] as const
export type ChangeState = (typeof CHANGE_STATES)[number]

/** 改动提案里的一个文件。路径是真实绝对路径；基线 `absent` 表示新建。 */
export interface ChangeFile {
  readonly seq: number
  readonly path: string
  readonly action: 'modify' | 'create'
  readonly baseHash: string
  readonly newHash: string
  readonly added: number
  readonly removed: number
  /** 应用后实测的哈希；未应用为 null。 */
  readonly afterHash: string | null
}

/** 一版改动提案。批准绑定修订、根目录与每个文件的（路径, 基线哈希, 新哈希）。 */
export interface ChangeSet {
  readonly changeId: string
  readonly taskId: string
  readonly revision: number
  readonly proposalId: string | null
  readonly root: string
  readonly summary: string
  readonly digest: string
  readonly state: ChangeState
  readonly operationId: string | null
  readonly detail: string | null
  readonly files: readonly ChangeFile[]
  readonly createdAt: number
  readonly updatedAt: number
}

export const VERIFICATION_STATES = [
  'pending', 'approved', 'running', 'passed', 'failed', 'timed-out', 'error', 'unknown', 'reviewed',
  'rejected', 'expired', 'superseded',
] as const
export type VerificationState = (typeof VERIFICATION_STATES)[number]

/** 一条验证命令：程序与参数数组（不经 shell）、授权项目内的 cwd、超时与预期副作用说明，以及真实结果。 */
export interface VerificationRecord {
  readonly verificationId: string
  readonly taskId: string
  readonly proposalId: string | null
  readonly cwd: string
  /** 解析后的程序绝对路径。 */
  readonly program: string
  readonly args: readonly string[]
  readonly timeoutMs: number
  readonly expectedEffects: string
  readonly digest: string
  /** 这条验证针对的已应用改动；没有改动时为 null。 */
  readonly afterChangeId: string | null
  readonly state: VerificationState
  readonly exitCode: number | null
  readonly signal: string | null
  readonly durationMs: number | null
  readonly stdout: string | null
  readonly stderr: string | null
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly fileResults: unknown
  readonly operationId: string | null
  readonly detail: string | null
  readonly createdAt: number
  readonly startedAt: number | null
  readonly endedAt: number | null
}

export const REVIEW_STATES = ['pending', 'applied', 'refused', 'rejected', 'expired', 'superseded'] as const
export type ReviewState = (typeof REVIEW_STATES)[number]

/** 一条 unknown 人工复核申请；结论绑在提案里，用户在桌面可信批准后才写进账本。 */
export interface OperationReviewRecord {
  readonly reviewId: string
  readonly operationId: string
  readonly taskId: string
  readonly proposalId: string | null
  readonly resolution: ReviewResolution
  readonly note: string
  /** 提案时被复核操作的状态快照摘要；应用时不符就拒绝（账目在此期间变过）。 */
  readonly snapshotDigest: string
  readonly state: ReviewState
  readonly detail: string | null
  readonly createdAt: number
  readonly decidedAt: number | null
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
  'task.changed',
  'task.artifact',
  'approval.requested',
  'approval.resolved',
  'reminder.changed',
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
  const proposal: ActionProposal = {
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
    baseHash: text(row.base_hash as string | null | undefined),
  }
  // 审阅全文只属于可信执行器动作；其余提案不带这三个字段，桌面按原样展示。
  if (typeof row.review_content !== 'string') return proposal
  return {
    ...proposal,
    content: row.review_content,
    digest: String(row.params_digest),
    revision: row.review_revision === null || row.review_revision === undefined ? Number(row.input_revision) : Number(row.review_revision),
  }
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
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
    assistantId: text(row.assistant_id as string | null),
    target: text(row.target as string | null),
    paramsDigest: text(row.params_digest as string | null),
    runId: text(row.run_id as string | null),
    executedAt: row.executed_at === null || row.executed_at === undefined ? null : Number(row.executed_at),
    resultDetail: text(row.result_detail as string | null),
    evidence: parseJson(row.evidence),
    review: (parseJson(row.review) as OperationReview | null) ?? null,
  }
}

function rowToHelpTask(row: Row): HelpTaskLink {
  return {
    taskId: String(row.task_id),
    projectRoot: String(row.project_root),
    currentFile: text(row.current_file as string | null),
    helpContextId: text(row.help_context_id as string | null),
    episodeId: text(row.episode_id as string | null),
    createdAt: Number(row.created_at),
  }
}

function rowToChangeFile(row: Row): ChangeFile {
  return {
    seq: Number(row.seq),
    path: String(row.path),
    action: row.action === 'create' ? 'create' : 'modify',
    baseHash: String(row.base_hash),
    newHash: String(row.new_hash),
    added: Number(row.added),
    removed: Number(row.removed),
    afterHash: text(row.after_hash as string | null),
  }
}

function rowToVerification(row: Row): VerificationRecord {
  const args = parseJson(row.args)
  return {
    verificationId: String(row.verification_id),
    taskId: String(row.task_id),
    proposalId: text(row.proposal_id as string | null),
    cwd: String(row.cwd),
    program: String(row.program),
    args: Array.isArray(args) ? args.filter((item): item is string => typeof item === 'string') : [],
    timeoutMs: Number(row.timeout_ms),
    expectedEffects: String(row.expected_effects),
    digest: String(row.digest),
    afterChangeId: text(row.after_change_id as string | null),
    state: String(row.state) as VerificationState,
    exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    signal: text(row.signal as string | null),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    stdout: text(row.stdout as string | null),
    stderr: text(row.stderr as string | null),
    stdoutTruncated: Number(row.stdout_truncated) === 1,
    stderrTruncated: Number(row.stderr_truncated) === 1,
    fileResults: parseJson(row.file_results),
    operationId: text(row.operation_id as string | null),
    detail: text(row.detail as string | null),
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
  }
}

function rowToReview(row: Row): OperationReviewRecord {
  return {
    reviewId: String(row.review_id),
    operationId: String(row.operation_id),
    taskId: String(row.task_id),
    proposalId: text(row.proposal_id as string | null),
    resolution: String(row.resolution) as ReviewResolution,
    note: String(row.note),
    snapshotDigest: String(row.snapshot_digest),
    state: String(row.state) as ReviewState,
    detail: text(row.detail as string | null),
    createdAt: Number(row.created_at),
    decidedAt: row.decided_at === null || row.decided_at === undefined ? null : Number(row.decided_at),
  }
}

/** 操作账本在 v4 / v5 补的列：老库按列名逐个补，重复打开也安全。 */
const OPERATION_LEDGER_COLUMNS: readonly (readonly [string, string])[] = [
  ['assistant_id', 'TEXT'],
  ['target', 'TEXT'],
  ['params_digest', 'TEXT'],
  ['run_id', 'TEXT'],
  ['executed_at', 'INTEGER'],
  ['result_detail', 'TEXT'],
  ['evidence', 'TEXT'],
  ['review', 'TEXT'],
]

/** 提案在 v5 补的列：写类目标的基线哈希、可信执行器动作的审阅全文与修订。 */
const PROPOSAL_V5_COLUMNS: readonly (readonly [string, string])[] = [
  ['base_hash', 'TEXT'],
  ['review_content', 'TEXT'],
  ['review_revision', 'INTEGER'],
]

function parseList(raw: string | null): string[] {
  if (!raw) return []
  const parsed: unknown = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
}

/** 团队业务库。所有写操作都在这里，读取用只读投影方法。 */
export class TeamStore {
  private readonly db: DatabaseSync
  readonly directory: MemberDirectory
  /** 事务嵌套深度：内层调用跟随外层一起提交或回滚（SQLite 对嵌套 BEGIN 直接报错）。 */
  private transactionDepth = 0

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    try {
      this.transaction(() => this.migrate())
      this.directory = new MemberDirectory(this.db, body => this.transaction(body))
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  /** 从库内建表；已存在的库按 user_version 逐步升级，失败即抛出，不启动采集与自动执行。 */
  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as Row | undefined
    const current = Number(row?.user_version ?? 0)
    if (current > TEAM_SCHEMA_VERSION) {
      throw new Error(`team store schema ${current} is newer than supported ${TEAM_SCHEMA_VERSION}`)
    }
    if (current === TEAM_SCHEMA_VERSION) return
    // v10：首版示例角色名（唐僧/孙悟空…）只是种子占位，未改过的一律换成通用名称。
    if (current > 0 && current < 10) {
      this.db.exec(`UPDATE assistants SET display_name = CASE role_id
        WHEN 'tangseng' THEN '总助理' WHEN 'wukong' THEN '助理1' WHEN 'bajie' THEN '助理2'
        WHEN 'shaseng' THEN '助理3' WHEN 'bailongma' THEN '助理4' ELSE display_name END
        WHERE revision = 1 AND display_name IN ('唐僧','孙悟空','猪八戒','沙僧','白龙马')`)
    }

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
        expires_at INTEGER NOT NULL,
        base_hash TEXT,
        review_content TEXT,
        review_revision INTEGER
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
        ended_at INTEGER,
        assistant_id TEXT,
        target TEXT,
        params_digest TEXT,
        run_id TEXT,
        executed_at INTEGER,
        result_detail TEXT,
        evidence TEXT,
        review TEXT
      );

      CREATE TABLE IF NOT EXISTS help_tasks (
        task_id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        current_file TEXT,
        help_context_id TEXT,
        episode_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS change_sets (
        change_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        proposal_id TEXT,
        root TEXT NOT NULL,
        summary TEXT NOT NULL,
        digest TEXT NOT NULL,
        state TEXT NOT NULL,
        operation_id TEXT,
        detail TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS change_files (
        change_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        path TEXT NOT NULL,
        action TEXT NOT NULL,
        base_hash TEXT NOT NULL,
        new_hash TEXT NOT NULL,
        added INTEGER NOT NULL,
        removed INTEGER NOT NULL,
        new_content TEXT,
        after_hash TEXT,
        PRIMARY KEY (change_id, seq)
      );

      CREATE TABLE IF NOT EXISTS verifications (
        verification_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        proposal_id TEXT,
        cwd TEXT NOT NULL,
        program TEXT NOT NULL,
        args TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        expected_effects TEXT NOT NULL,
        digest TEXT NOT NULL,
        after_change_id TEXT,
        state TEXT NOT NULL,
        exit_code INTEGER,
        signal TEXT,
        duration_ms INTEGER,
        stdout TEXT,
        stderr TEXT,
        stdout_truncated INTEGER NOT NULL DEFAULT 0,
        stderr_truncated INTEGER NOT NULL DEFAULT 0,
        file_results TEXT,
        operation_id TEXT,
        detail TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS operation_reviews (
        review_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        proposal_id TEXT,
        resolution TEXT NOT NULL,
        note TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL,
        decided_at INTEGER
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
    // v4 及更早的库：提案的基线哈希与审阅全文同样按列名补。
    const proposalNames = new Set(proposalColumns.map((column) => String(column.name)))
    for (const [name, type] of PROPOSAL_V5_COLUMNS) {
      if (!proposalNames.has(name)) this.db.exec(`ALTER TABLE action_proposals ADD COLUMN ${name} ${type}`)
    }
    // 门禁的热路径：每次副作用工具调用前都要按这四列找一条可消费的批准。
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_proposals_gate ON action_proposals (task_id, tool, target, state)`,
    )
    // v3 的库里 operations 已经存在，账本新列同样只能显式补；按列名判断，v4 形状的库上重跑也安全。
    const operationColumns = new Set(
      (this.db.prepare('PRAGMA table_info(operations)').all() as Row[]).map((column) => String(column.name)),
    )
    for (const [name, type] of OPERATION_LEDGER_COLUMNS) {
      if (!operationColumns.has(name)) this.db.exec(`ALTER TABLE operations ADD COLUMN ${name} ${type}`)
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_operations_task ON operations (task_id, started_at)`)
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_change_sets_revision ON change_sets (task_id, revision)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_verifications_task ON verifications (task_id, created_at)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_reviews_operation ON operation_reviews (operation_id, created_at)`)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_identity (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        principal_id TEXT NOT NULL UNIQUE,
        device_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS task_meta (
        id TEXT PRIMARY KEY REFERENCES tasks(task_id),
        data TEXT NOT NULL CHECK(json_valid(data)),
        runtime_scope TEXT GENERATED ALWAYS AS (json_extract(data, '$.runtimeScope')) STORED,
        principal_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.principalId')) STORED,
        parent_task_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.parentTaskId')) STORED,
        CHECK(runtime_scope IN ('team', 'companion'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_meta_owner ON task_meta(principal_id, runtime_scope);
      CREATE TABLE IF NOT EXISTS companion_inputs (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL CHECK(json_valid(data))
      );
      CREATE TABLE IF NOT EXISTS task_commands (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL CHECK(json_valid(data)),
        proposal_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.proposalId')) STORED UNIQUE
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL CHECK(json_valid(data)),
        task_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.taskId')) STORED UNIQUE REFERENCES tasks(task_id),
        enabled INTEGER GENERATED ALWAYS AS (json_extract(data, '$.enabled')) STORED,
        next_run_at INTEGER GENERATED ALWAYS AS (json_extract(data, '$.nextRunAt')) STORED
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS reminder_grants (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL CHECK(json_valid(data))
      );
      CREATE TABLE IF NOT EXISTS reminder_cycles (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL CHECK(json_valid(data)),
        schedule_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.scheduleId')) STORED REFERENCES schedules(id),
        generation INTEGER GENERATED ALWAYS AS (json_extract(data, '$.generation')) STORED,
        trigger_at INTEGER GENERATED ALWAYS AS (json_extract(data, '$.triggerAt')) STORED,
        state TEXT GENERATED ALWAYS AS (json_extract(data, '$.state')) STORED,
        next_nag_at INTEGER GENERATED ALWAYS AS (json_extract(data, '$.nextNagAt')) STORED,
        UNIQUE(schedule_id, generation, trigger_at)
      );
      CREATE INDEX IF NOT EXISTS idx_cycles_due ON reminder_cycles(state, next_nag_at);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL CHECK(json_valid(data)),
        cycle_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.cycleId')) STORED REFERENCES reminder_cycles(id),
        occurrence_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.occurrenceId')) STORED,
        channel TEXT GENERATED ALWAYS AS (json_extract(data, '$.channel')) STORED,
        recipient_ref TEXT GENERATED ALWAYS AS (json_extract(data, '$.recipientRef')) STORED,
        state TEXT GENERATED ALWAYS AS (json_extract(data, '$.state')) STORED,
        UNIQUE(occurrence_id, channel, recipient_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_state ON deliveries(state);
      CREATE TABLE IF NOT EXISTS companion_contexts (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL CHECK(json_valid(data)),
        principal_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.principalId')) STORED,
        captured_at INTEGER GENERATED ALWAYS AS (json_extract(data, '$.capturedAt')) STORED,
        expires_at INTEGER GENERATED ALWAYS AS (json_extract(data, '$.expiresAt')) STORED,
        used_at INTEGER GENERATED ALWAYS AS (json_extract(data, '$.usedAt')) STORED
      );
      CREATE INDEX IF NOT EXISTS idx_contexts_owner ON companion_contexts(principal_id, captured_at);
      CREATE TABLE IF NOT EXISTS channel_messages (
        channel TEXT NOT NULL,
        msgid TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (channel, msgid)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        operation_id TEXT NOT NULL REFERENCES operations(operation_id),
        evidence TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
    migrateMemberDirectory(this.db)
    this.db.exec(`PRAGMA user_version = ${TEAM_SCHEMA_VERSION}`)
    this.db
      .prepare('INSERT OR IGNORE INTO migrations (version, applied_at) VALUES (?, ?)')
      .run(TEAM_SCHEMA_VERSION, Date.now())
  }

  /**
   * 在一个事务里执行写入；发件箱事件与业务变更同事务提交。
   * 可以重入：内层调用跟随外层一起提交或回滚（例如改动提案与它的审批卡必须同生同灭）。
   */
  transaction<T>(body: () => T): T {
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1
      try {
        return body()
      } finally {
        this.transactionDepth -= 1
      }
    }
    this.db.exec('BEGIN')
    this.transactionDepth = 1
    try {
      const result = body()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.transactionDepth = 0
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

  /** 未结束的团队任务会继续尝试找成员；删除前必须先处理完。 */
  activeTaskCount(assistantId: string): number {
    const marks = TERMINAL_TASK_STATUSES.map(() => '?').join(', ')
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ? AND status NOT IN (${marks})`)
      .get(assistantId, ...TERMINAL_TASK_STATUSES) as Row | undefined
    return Number(row?.n ?? 0)
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

  getTaskRuntimeScope(taskId: string): 'team' | 'companion' | null {
    const row = this.db.prepare(`SELECT COALESCE(m.runtime_scope, 'team') AS scope
      FROM tasks t LEFT JOIN task_meta m ON m.id = t.task_id WHERE t.task_id = ?`).get(taskId) as Row | undefined
    return row ? row.scope as 'team' | 'companion' : null
  }

  listTasks(filter?: { status?: TaskStatus; teamId?: string; runtimeScope?: 'team' | 'companion' }): Task[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (filter?.runtimeScope) {
      clauses.push(`COALESCE((SELECT runtime_scope FROM task_meta WHERE id = tasks.task_id), 'team') = ?`)
      params.push(filter.runtimeScope)
    }
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
                                       input_revision, risk, state, created_at, expires_at,
                                       base_hash, review_content, review_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        text(proposal.baseHash),
        text(proposal.content),
        num(proposal.revision),
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

  /**
   * 门禁查找可以真正消费的那一条：已批准、批准未消费且未过期、提案也未过期。
   * 同一调用被重新批准过时，旧的已消费批准不能挡住新批准，也不能被当成新批准重放。
   * 给出 baseHash（写类目标当前的内容版本）时，绑定了别的版本的批准不算可用；没绑定版本的旧提案照旧可用。
   */
  findUsableGateProposal(taskId: string, tool: string, target: string,
    binding: GateBinding, now: number,
  ): ActionProposal | null {
    const versioned = binding.baseHash !== undefined && binding.baseHash !== null
    const row = this.db
      .prepare(
        `SELECT p.* FROM action_proposals p JOIN approvals a ON a.proposal_id = p.proposal_id
          WHERE p.task_id = ? AND p.tool = ? AND p.target = ? AND p.state = 'approved'
            AND p.assistant_id = ? AND p.input_revision = ? AND p.params_digest = ?
            AND a.consumed_at IS NULL AND a.expires_at > ? AND p.expires_at > ?
            ${versioned ? 'AND (p.base_hash IS NULL OR p.base_hash = ?)' : ''}
          ORDER BY a.issued_at DESC LIMIT 1`,
      )
      .get(taskId, tool, target, binding.assistantId, binding.inputRevision, binding.paramsDigest, now, now,
        ...(versioned ? [binding.baseHash as string] : [])) as Row | undefined
    return row ? rowToProposal(row) : null
  }

  /** 同一调用还在等用户决定的提案（未过期，且绑定的文件版本相同）；门禁据此复用审批卡，不重复刷卡。 */
  findPendingGateProposal(taskId: string, tool: string, target: string,
    binding: GateBinding, now: number,
  ): ActionProposal | null {
    const row = this.db
      .prepare(
        `SELECT * FROM action_proposals
          WHERE task_id = ? AND tool = ? AND target = ? AND state = 'pending'
            AND assistant_id = ? AND input_revision = ? AND params_digest = ? AND expires_at > ?
            AND base_hash IS ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId, tool, target, binding.assistantId, binding.inputRevision, binding.paramsDigest, now,
        binding.baseHash ?? null) as Row | undefined
    return row ? rowToProposal(row) : null
  }

  /**
   * 把某任务（可限定输入修订）仍在等待的提案改成 expired，返回被改的那些。
   * 不开事务：调用方在自己的事务里连同发件箱事件一起提交。
   */
  expirePendingProposals(taskId: string, inputRevision?: number): ActionProposal[] {
    const rows = (inputRevision === undefined
      ? this.db.prepare(`SELECT * FROM action_proposals WHERE task_id = ? AND state = 'pending'`).all(taskId)
      : this.db.prepare(`SELECT * FROM action_proposals WHERE task_id = ? AND state = 'pending' AND input_revision = ?`)
        .all(taskId, inputRevision)) as Row[]
    const expired = rows.map(rowToProposal)
    for (const proposal of expired) this.setProposalState(proposal.proposalId, 'expired')
    return expired
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
        `INSERT INTO operations (operation_id, task_id, approval_id, kind, state, result_digest, started_at, ended_at,
                                 assistant_id, target, params_digest, run_id, executed_at, result_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        text(operation.assistantId),
        text(operation.target),
        text(operation.paramsDigest),
        text(operation.runId),
        num(operation.executedAt),
        text(operation.resultDetail),
      )
  }

  /** 结算或对账一条操作；detail 不传就保留原说明。 */
  setOperationState(operationId: string, state: OperationState, resultDigest: string | null, detail?: string | null): void {
    if (detail === undefined) {
      this.db
        .prepare('UPDATE operations SET state = ?, result_digest = ?, ended_at = ? WHERE operation_id = ?')
        .run(state, text(resultDigest), Date.now(), operationId)
      return
    }
    this.db
      .prepare('UPDATE operations SET state = ?, result_digest = ?, ended_at = ?, result_detail = ? WHERE operation_id = ?')
      .run(state, text(resultDigest), Date.now(), text(detail), operationId)
  }

  /**
   * planned → running，并记下真正进入工具体的时间。只认 planned：已被对账成 unknown 的操作
   * （例如任务已停止）不能再被标成执行中，调用方据此拒绝执行。
   */
  markOperationRunning(operationId: string, at: number): boolean {
    const result = this.db
      .prepare(`UPDATE operations SET state = 'running', executed_at = ? WHERE operation_id = ? AND state = 'planned'`)
      .run(at, operationId)
    return Number(result.changes) === 1
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

  /** 写入验收证据（可信执行器专用）。 */
  setOperationEvidence(operationId: string, evidence: unknown): void {
    this.db.prepare('UPDATE operations SET evidence = ? WHERE operation_id = ?').run(json(evidence), operationId)
  }

  /**
   * 人工复核：只把仍是 unknown 的操作改成复核结论，同时留下复核记录与原说明。
   * 返回 false 表示操作已不是 unknown（并发复核或迟到结果先到），调用方必须拒绝。
   */
  reviewOperation(operationId: string, state: OperationState, review: OperationReview, detail: string): boolean {
    const result = this.db
      .prepare(`UPDATE operations SET state = ?, review = ?, result_detail = ?, ended_at = COALESCE(ended_at, ?)
                WHERE operation_id = ? AND state = 'unknown'`)
      .run(state, json(review), detail, Date.now(), operationId)
    return Number(result.changes) === 1
  }

  insertHelpTask(link: HelpTaskLink): void {
    this.db
      .prepare(`INSERT INTO help_tasks (task_id, project_root, current_file, help_context_id, episode_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(link.taskId, link.projectRoot, text(link.currentFile), text(link.helpContextId), text(link.episodeId), link.createdAt)
  }

  getHelpTask(taskId: string): HelpTaskLink | null {
    const row = this.db.prepare('SELECT * FROM help_tasks WHERE task_id = ?').get(taskId) as Row | undefined
    return row ? rowToHelpTask(row) : null
  }

  listHelpTasks(): HelpTaskLink[] {
    return (this.db.prepare('SELECT * FROM help_tasks ORDER BY created_at DESC').all() as Row[]).map(rowToHelpTask)
  }

  /** 新建一版改动提案及其文件；新内容只为应用保留，应用或作废后清空。 */
  insertChangeSet(change: ChangeSet, contents: readonly string[]): void {
    this.db
      .prepare(`INSERT INTO change_sets (change_id, task_id, revision, proposal_id, root, summary, digest, state, operation_id,
                                         detail, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(change.changeId, change.taskId, change.revision, text(change.proposalId), change.root, change.summary, change.digest,
        change.state, text(change.operationId), text(change.detail), change.createdAt, change.updatedAt)
    const insert = this.db.prepare(`INSERT INTO change_files (change_id, seq, path, action, base_hash, new_hash, added, removed,
                                                              new_content, after_hash)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    change.files.forEach((file, index) => {
      insert.run(change.changeId, file.seq, file.path, file.action, file.baseHash, file.newHash, file.added, file.removed,
        contents[index] ?? null, text(file.afterHash))
    })
  }

  private changeFiles(changeId: string): ChangeFile[] {
    return (this.db.prepare('SELECT * FROM change_files WHERE change_id = ? ORDER BY seq').all(changeId) as Row[]).map(rowToChangeFile)
  }

  private toChangeSet(row: Row): ChangeSet {
    const changeId = String(row.change_id)
    return {
      changeId,
      taskId: String(row.task_id),
      revision: Number(row.revision),
      proposalId: text(row.proposal_id as string | null),
      root: String(row.root),
      summary: String(row.summary),
      digest: String(row.digest),
      state: String(row.state) as ChangeState,
      operationId: text(row.operation_id as string | null),
      detail: text(row.detail as string | null),
      files: this.changeFiles(changeId),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  getChangeSet(changeId: string): ChangeSet | null {
    const row = this.db.prepare('SELECT * FROM change_sets WHERE change_id = ?').get(changeId) as Row | undefined
    return row ? this.toChangeSet(row) : null
  }

  changeSetByProposal(proposalId: string): ChangeSet | null {
    const row = this.db.prepare('SELECT * FROM change_sets WHERE proposal_id = ?').get(proposalId) as Row | undefined
    return row ? this.toChangeSet(row) : null
  }

  /** 某任务的全部改动提案，修订从新到旧。 */
  listChangeSets(taskId: string): ChangeSet[] {
    return (this.db.prepare('SELECT * FROM change_sets WHERE task_id = ? ORDER BY revision DESC').all(taskId) as Row[])
      .map(row => this.toChangeSet(row))
  }

  latestChangeRevision(taskId: string): number {
    const row = this.db.prepare('SELECT MAX(revision) AS revision FROM change_sets WHERE task_id = ?').get(taskId) as Row | undefined
    return row?.revision === null || row?.revision === undefined ? 0 : Number(row.revision)
  }

  /**
   * 条件更新改动状态：from 给出时只在当前状态属于其中时才改，返回是否改到。
   * 执行器靠它做「只有 approved 能进入 applying」这类单次推进。
   */
  setChangeState(changeId: string, state: ChangeState, patch: { detail?: string | null; operationId?: string | null; from?: readonly ChangeState[] } = {}): boolean {
    const sets = ['state = ?', 'updated_at = ?']
    const values: (string | number | null)[] = [state, Date.now()]
    if (patch.detail !== undefined) { sets.push('detail = ?'); values.push(text(patch.detail)) }
    if (patch.operationId !== undefined) { sets.push('operation_id = ?'); values.push(text(patch.operationId)) }
    let where = 'change_id = ?'
    values.push(changeId)
    if (patch.from && patch.from.length > 0) {
      where += ` AND state IN (${patch.from.map(() => '?').join(', ')})`
      values.push(...patch.from)
    }
    const result = this.db.prepare(`UPDATE change_sets SET ${sets.join(', ')} WHERE ${where}`).run(...values)
    return Number(result.changes) === 1
  }

  setChangeProposal(changeId: string, proposalId: string): void {
    this.db.prepare('UPDATE change_sets SET proposal_id = ?, updated_at = ? WHERE change_id = ?').run(proposalId, Date.now(), changeId)
  }

  /** 应用后实测哈希。 */
  setChangeFileAfter(changeId: string, seq: number, afterHash: string | null): void {
    this.db.prepare('UPDATE change_files SET after_hash = ? WHERE change_id = ? AND seq = ?').run(text(afterHash), changeId, seq)
  }

  /** 应用时取新内容；已清空时返回 null（执行器据此拒绝）。 */
  changeContents(changeId: string): Map<number, string | null> {
    const rows = this.db.prepare('SELECT seq, new_content FROM change_files WHERE change_id = ? ORDER BY seq').all(changeId) as Row[]
    return new Map(rows.map(row => [Number(row.seq), text(row.new_content as string | null)]))
  }

  /** 应用、冲突或作废之后清掉保存的新内容：账本只留哈希。 */
  purgeChangeContents(changeId: string): void {
    this.db.prepare('UPDATE change_files SET new_content = NULL WHERE change_id = ?').run(changeId)
  }

  insertVerification(record: VerificationRecord): void {
    this.db
      .prepare(`INSERT INTO verifications (verification_id, task_id, proposal_id, cwd, program, args, timeout_ms, expected_effects,
                                           digest, after_change_id, state, exit_code, signal, duration_ms, stdout, stderr,
                                           stdout_truncated, stderr_truncated, file_results, operation_id, detail, created_at,
                                           started_at, ended_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.verificationId, record.taskId, text(record.proposalId), record.cwd, record.program, json(record.args),
        record.timeoutMs, record.expectedEffects, record.digest, text(record.afterChangeId), record.state, num(record.exitCode),
        text(record.signal), num(record.durationMs), text(record.stdout), text(record.stderr), bool(record.stdoutTruncated),
        bool(record.stderrTruncated), record.fileResults === null || record.fileResults === undefined ? null : json(record.fileResults),
        text(record.operationId), text(record.detail), record.createdAt, num(record.startedAt), num(record.endedAt))
  }

  getVerification(verificationId: string): VerificationRecord | null {
    const row = this.db.prepare('SELECT * FROM verifications WHERE verification_id = ?').get(verificationId) as Row | undefined
    return row ? rowToVerification(row) : null
  }

  verificationByProposal(proposalId: string): VerificationRecord | null {
    const row = this.db.prepare('SELECT * FROM verifications WHERE proposal_id = ?').get(proposalId) as Row | undefined
    return row ? rowToVerification(row) : null
  }

  /** 某任务的全部验证，从新到旧。 */
  listVerifications(taskId: string): VerificationRecord[] {
    return (this.db.prepare('SELECT * FROM verifications WHERE task_id = ? ORDER BY created_at DESC, rowid DESC').all(taskId) as Row[])
      .map(rowToVerification)
  }

  setVerificationProposal(verificationId: string, proposalId: string): void {
    this.db.prepare('UPDATE verifications SET proposal_id = ? WHERE verification_id = ?').run(proposalId, verificationId)
  }

  /** 条件更新验证状态，语义同 setChangeState。 */
  setVerificationState(verificationId: string, state: VerificationState,
    patch: { detail?: string | null; operationId?: string | null; startedAt?: number; from?: readonly VerificationState[] } = {},
  ): boolean {
    const sets = ['state = ?']
    const values: (string | number | null)[] = [state]
    if (patch.detail !== undefined) { sets.push('detail = ?'); values.push(text(patch.detail)) }
    if (patch.operationId !== undefined) { sets.push('operation_id = ?'); values.push(text(patch.operationId)) }
    if (patch.startedAt !== undefined) { sets.push('started_at = ?'); values.push(patch.startedAt) }
    let where = 'verification_id = ?'
    values.push(verificationId)
    if (patch.from && patch.from.length > 0) {
      where += ` AND state IN (${patch.from.map(() => '?').join(', ')})`
      values.push(...patch.from)
    }
    const result = this.db.prepare(`UPDATE verifications SET ${sets.join(', ')} WHERE ${where}`).run(...values)
    return Number(result.changes) === 1
  }

  /** 记下一次真实运行的结果：退出码、截断输出与文件结果。只认 running。 */
  finishVerification(verificationId: string, state: VerificationState, result: {
    exitCode: number | null; signal: string | null; durationMs: number | null; stdout: string; stderr: string
    stdoutTruncated: boolean; stderrTruncated: boolean; fileResults: unknown; detail: string
  }): boolean {
    const outcome = this.db
      .prepare(`UPDATE verifications SET state = ?, exit_code = ?, signal = ?, duration_ms = ?, stdout = ?, stderr = ?,
                       stdout_truncated = ?, stderr_truncated = ?, file_results = ?, detail = ?, ended_at = ?
                WHERE verification_id = ? AND state = 'running'`)
      .run(state, num(result.exitCode), text(result.signal), num(result.durationMs), result.stdout, result.stderr,
        bool(result.stdoutTruncated), bool(result.stderrTruncated), json(result.fileResults), result.detail, Date.now(), verificationId)
    return Number(outcome.changes) === 1
  }

  insertReview(review: OperationReviewRecord): void {
    this.db
      .prepare(`INSERT INTO operation_reviews (review_id, operation_id, task_id, proposal_id, resolution, note, snapshot_digest,
                                               state, detail, created_at, decided_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(review.reviewId, review.operationId, review.taskId, text(review.proposalId), review.resolution, review.note,
        review.snapshotDigest, review.state, text(review.detail), review.createdAt, num(review.decidedAt))
  }

  getReview(reviewId: string): OperationReviewRecord | null {
    const row = this.db.prepare('SELECT * FROM operation_reviews WHERE review_id = ?').get(reviewId) as Row | undefined
    return row ? rowToReview(row) : null
  }

  reviewByProposal(proposalId: string): OperationReviewRecord | null {
    const row = this.db.prepare('SELECT * FROM operation_reviews WHERE proposal_id = ?').get(proposalId) as Row | undefined
    return row ? rowToReview(row) : null
  }

  listReviews(operationId: string): OperationReviewRecord[] {
    return (this.db.prepare('SELECT * FROM operation_reviews WHERE operation_id = ? ORDER BY created_at DESC').all(operationId) as Row[])
      .map(rowToReview)
  }

  /** 某任务名下的全部复核申请（对账用）。 */
  listReviewsForTask(taskId: string): OperationReviewRecord[] {
    return (this.db.prepare('SELECT * FROM operation_reviews WHERE task_id = ? ORDER BY created_at DESC').all(taskId) as Row[])
      .map(rowToReview)
  }

  setReviewProposal(reviewId: string, proposalId: string): void {
    this.db.prepare('UPDATE operation_reviews SET proposal_id = ? WHERE review_id = ?').run(proposalId, reviewId)
  }

  /** 条件更新复核状态：只从 pending 推进。 */
  setReviewState(reviewId: string, state: ReviewState, detail: string | null, decidedAt: number | null): boolean {
    const result = this.db
      .prepare(`UPDATE operation_reviews SET state = ?, detail = ?, decided_at = ? WHERE review_id = ? AND state = 'pending'`)
      .run(state, text(detail), num(decidedAt), reviewId)
    return Number(result.changes) === 1
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
    const result = this.db.prepare(`DELETE FROM events_outbox WHERE created_at < ?
      AND NOT EXISTS (SELECT 1 FROM task_meta WHERE id = events_outbox.task_id AND runtime_scope = 'companion')`).run(cutoff)
    return Number(result.changes)
  }

  /** 记录一条已处理的渠道消息；重复的厂商 msgid 返回 false。 */
  claimChannelMessage(channel: string, msgid: string, at: number): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO channel_messages(channel, msgid, received_at) VALUES (?, ?, ?)')
      .run(channel, msgid, at).changes) === 1
  }

  pruneChannelMessages(before: number): number {
    return Number(this.db.prepare('DELETE FROM channel_messages WHERE received_at < ?').run(before).changes)
  }

  companionIdentity(): { principalId: string; deviceId: string } {
    this.db.prepare('INSERT OR IGNORE INTO companion_identity VALUES (1, ?, ?)').run(randomUUID(), randomUUID())
    const row = this.db.prepare('SELECT * FROM companion_identity WHERE singleton = 1').get() as Row
    return { principalId: String(row.principal_id), deviceId: String(row.device_id) }
  }

  private companionRecord<K extends keyof CompanionRecords>(table: K, id: string): CompanionRecords[K] | null {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as Row | undefined
    return row ? JSON.parse(String(row.data)) as CompanionRecords[K] : null
  }

  private companionRecords<K extends keyof CompanionRecords>(table: K): CompanionRecords[K][] {
    return (this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as Row[])
      .map(row => JSON.parse(String(row.data)) as CompanionRecords[K])
  }

  private saveCompanionRecord<K extends keyof CompanionRecords>(table: K, id: string, value: CompanionRecords[K]): void {
    this.db.prepare(`INSERT INTO ${table}(id, data) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(id, json(value))
  }

  getCompanionMeta(taskId: string): CompanionTaskMeta | null { return this.companionRecord('task_meta', taskId) }
  saveCompanionMeta(meta: CompanionTaskMeta): void { this.saveCompanionRecord('task_meta', meta.taskId, meta) }
  getCompanionInput(inputRef: string): CompanionInputRecord | null { return this.companionRecord('companion_inputs', inputRef) }
  insertCompanionInput(input: CompanionInputRecord): void {
    this.db.prepare('INSERT INTO companion_inputs(id, data) VALUES (?, ?)').run(input.inputRef, json(input))
  }
  getCompanionCommand(commandId: string): CompanionCommandRecord | null { return this.companionRecord('task_commands', commandId) }
  saveCompanionCommand(command: CompanionCommandRecord): void { this.saveCompanionRecord('task_commands', command.commandId, command) }
  companionCommandForProposal(proposalId: string): CompanionCommandRecord | null {
    const row = this.db.prepare('SELECT data FROM task_commands WHERE proposal_id = ?').get(proposalId) as Row | undefined
    return row ? JSON.parse(String(row.data)) as CompanionCommandRecord : null
  }
  listCompanionCommands(): CompanionCommandRecord[] { return this.companionRecords('task_commands') }
  getCompanionSchedule(scheduleId: string): CompanionScheduleRecord | null { return this.companionRecord('schedules', scheduleId) }
  listCompanionSchedules(): CompanionScheduleRecord[] { return this.companionRecords('schedules') }
  saveCompanionSchedule(schedule: CompanionScheduleRecord): void { this.saveCompanionRecord('schedules', schedule.scheduleId, schedule) }
  getReminderGrant(grantRef: string): ReminderGrantRecord | null { return this.companionRecord('reminder_grants', grantRef) }
  saveReminderGrant(grant: ReminderGrantRecord): void { this.saveCompanionRecord('reminder_grants', grant.grantRef, grant) }
  getReminderCycle(cycleId: string): ReminderCycleRecord | null { return this.companionRecord('reminder_cycles', cycleId) }
  listReminderCycles(): ReminderCycleRecord[] { return this.companionRecords('reminder_cycles') }
  saveReminderCycle(cycle: ReminderCycleRecord): void { this.saveCompanionRecord('reminder_cycles', cycle.cycleId, cycle) }
  getReminderDelivery(deliveryId: string): ReminderDeliveryRecord | null { return this.companionRecord('deliveries', deliveryId) }
  listReminderDeliveries(): ReminderDeliveryRecord[] { return this.companionRecords('deliveries') }
  saveReminderDelivery(delivery: ReminderDeliveryRecord): void { this.saveCompanionRecord('deliveries', delivery.deliveryId, delivery) }
  listCompanionContexts(): CompanionContextRecord[] { return this.companionRecords('companion_contexts') }
  saveCompanionContext(context: CompanionContextRecord): void { this.saveCompanionRecord('companion_contexts', context.contextId, context) }
  pruneCompanionContexts(cutoff: number): number {
    return Number(this.db.prepare('DELETE FROM companion_contexts WHERE expires_at < ?').run(cutoff).changes)
  }

  insertCompanionArtifact(taskId: string, operationId: string, evidence: unknown, at: number): string {
    const artifactId = randomUUID()
    this.db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?)').run(artifactId, taskId, operationId, json(evidence), at)
    return artifactId
  }

  companionEventCursor(principalId: string): number {
    const row = this.db.prepare(`SELECT MAX(e.seq) AS cursor FROM events_outbox e
      JOIN task_meta m ON m.id = e.task_id WHERE m.principal_id = ? AND m.runtime_scope = 'companion'
      AND e.type IN ('task.changed', 'task.artifact', 'approval.requested', 'approval.resolved', 'reminder.changed')`)
      .get(principalId) as Row
    return Number(row.cursor ?? 0)
  }

  companionEventsSince(principalId: string, after: number, limit = 200): TeamEvent[] {
    const rows = this.db.prepare(`SELECT e.* FROM events_outbox e JOIN task_meta m ON m.id = e.task_id
      WHERE e.seq > ? AND m.principal_id = ? AND m.runtime_scope = 'companion'
      AND e.type IN ('task.changed', 'task.artifact', 'approval.requested', 'approval.resolved', 'reminder.changed')
      ORDER BY e.seq LIMIT ?`).all(after, principalId, limit) as Row[]
    return rows.map(row => ({ seq: Number(row.seq), type: row.type as TeamEventType, taskId: String(row.task_id),
      assistantId: null, payload: JSON.parse(String(row.payload)), createdAt: Number(row.created_at) }))
  }

  close(): void {
    this.db.close()
  }
}
