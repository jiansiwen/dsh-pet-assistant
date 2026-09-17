/**
 * 团队面板的投影：任务排序、状态措辞、成员汇总、待批入口。
 *
 * 与 `runtime-status.ts` 同一套分层理由：桥接推来的是**事实**（状态枚举、时间戳、产物列表），
 * 怎么排、怎么说、哪条要先给用户看，是界面的判断。这些判断写在 JSX 里就没人看得见，
 * 也没法测——而"哪条任务排在最前面"恰恰是最容易被改错又最难在界面上发现的那类逻辑。
 *
 * 有一条判断值得单独说：**"做完了"不等于成功**。
 * 设计文档里写明，只有产物验证通过才算完成，角色发一句"我做完了"不构成成功。
 * 所以状态是 done 而产物列表为空时，这里不给绿色的"已完成"，给一句"没有产物"的提示——
 * 面板是用户判断今天工作有没有真做完的唯一依据，替模型把话圆过去是在帮倒忙。
 */
import type { PetTaskStatus, TeamMemberSnapshot, TeamProposalSnapshot, TeamSnapshot, TeamTaskSnapshot } from './types.js'

/** 状态的措辞。用 Record 穷举：插件加一个状态而这里没跟上，会直接编译不过，不会静默落到 default。 */
export const TASK_STATUS_LABEL: Record<PetTaskStatus, string> = {
  created: '刚建好',
  queued: '排队中',
  running: '进行中',
  'awaiting-approval': '等你点头',
  'awaiting-user': '等你回话',
  review: '等复核',
  done: '已完成',
  failed: '失败了',
  cancelled: '已取消',
  unknown: '结果未知',
}

export type TaskTone = 'idle' | 'active' | 'waiting' | 'ok' | 'bad'

/**
 * 状态归到五种语气。
 *
 * `waiting` 单独一档，因为它和 `active` 的区别是**要不要用户动手**：
 * 进行中的任务用户只能等，等你点头/等你回话的任务用户不做就永远停在那儿。
 * 混成一种颜色的话，最需要人的那条会和一堆正在跑的任务长得一样。
 */
export function taskTone(status: PetTaskStatus): TaskTone {
  switch (status) {
    case 'awaiting-approval':
    case 'awaiting-user':
    case 'review':
      return 'waiting'
    case 'running':
    case 'queued':
    case 'created':
      return 'active'
    case 'done':
      return 'ok'
    case 'failed':
      return 'bad'
    case 'cancelled':
    case 'unknown':
      return 'idle'
  }
}

/**
 * 桥接推来的状态收成已知枚举。
 *
 * 认不出的一律归 `unknown`，不归 `created` 或 `queued`：把不认识的状态显示成"排队中"，
 * 用户会以为它还在正常推进，于是一直等下去。`unknown` 的措辞是"结果未知"，
 * 那是诚实的说法——我们确实不知道它到哪一步了。
 */
export function taskStatusOf(task: Pick<TeamTaskSnapshot, 'status'>): PetTaskStatus {
  const status = task.status
  if (typeof status === 'string' && status in TASK_STATUS_LABEL) return status as PetTaskStatus
  return 'unknown'
}

/**
 * 排序权重：需要用户动手的排最前，已经结束的排最后。
 *
 * 数字越小越靠前。等你点头排第一不是因为风险最高，而是因为**只有它能被用户推进**：
 * 提案有有效期，过期就得让助理重新提请一遍，那是实打实的返工。
 */
const STATUS_ORDER: Record<PetTaskStatus, number> = {
  'awaiting-approval': 0,
  'awaiting-user': 1,
  review: 2,
  running: 3,
  queued: 4,
  created: 5,
  failed: 6,
  unknown: 7,
  done: 8,
  cancelled: 9,
}

/**
 * 任务排序。
 *
 * 同权重按更新时间倒序（刚动过的在前），没有更新时间就按创建时间，两个都没有排最后。
 * 稳定的第三关键字是 taskId：同一批任务每次刷新顺序都一样，
 * 否则列表会在用户眼前跳来跳去，刚看清的那条又跑到别处了。
 */
export function sortTasks(tasks: readonly TeamTaskSnapshot[]): TeamTaskSnapshot[] {
  return [...tasks].sort((left, right) => {
    const byStatus = STATUS_ORDER[taskStatusOf(left)] - STATUS_ORDER[taskStatusOf(right)]
    if (byStatus !== 0) return byStatus
    const leftAt = left.updatedAt ?? left.createdAt ?? 0
    const rightAt = right.updatedAt ?? right.createdAt ?? 0
    if (leftAt !== rightAt) return rightAt - leftAt
    return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0
  })
}

/**
 * "做完了但没有产物"的提示。
 *
 * 只在 done 且产物为空时给。其它状态下没有产物是正常的——还没做完，哪来的产物。
 */
export function artifactNote(task: Pick<TeamTaskSnapshot, 'status' | 'artifacts'>): string | null {
  if (taskStatusOf(task) !== 'done') return null
  const count = task.artifacts?.length ?? 0
  return count === 0 ? '说做完了，但没交出产物' : null
}

/**
 * 截止时间的提示。
 *
 * 只提示两种情况：已经逾期、今天之内到期。更远的截止日期显示出来只是噪音——
 * 面板高度有限，每一行都该是现在就要知道的事。
 */
export function deadlineNote(task: Pick<TeamTaskSnapshot, 'deadlineAt' | 'status'>, now: number): string | null {
  const deadlineAt = task.deadlineAt
  if (typeof deadlineAt !== 'number') return null
  const status = taskStatusOf(task)
  // 已经结束的任务不再提示逾期：那只会重复一个已经发生过的坏消息。
  if (status === 'done' || status === 'cancelled') return null
  if (deadlineAt <= now) return '已经过了截止时间'
  const sameDay = new Date(deadlineAt).toDateString() === new Date(now).toDateString()
  return sameDay ? '今天到期' : null
}

export interface TaskRow {
  taskId: string
  goal: string
  status: PetTaskStatus
  statusLabel: string
  tone: TaskTone
  /** 负责人的显示名；没有就 null，界面上不显示这一行。 */
  owner: string | null
  artifactCount: number
  /** 需要用户留意的一句话（没有产物 / 逾期）。null 表示这一行不用显示。 */
  note: string | null
}

export interface MemberRow {
  assistantId: string
  displayName: string
  roleId: string | null
  /** 这个成员能不能改动用户的文件。名牌上要说清楚，不能只靠一个图标。 */
  scopeLabel: string
  /** 能改文件的是 true，用来加一条文字之外的视觉区分。 */
  canWriteFiles: boolean
  enabled: boolean
  activeTasks: number
  pendingApprovals: number
}

/**
 * 算在"手头有活"里的状态。
 *
 * done / failed / cancelled / unknown 不算：那四种是已经结束或已经说不清的，
 * 把它们计进成员的工作量，名牌上的数字会一直挂着一个下不去的假负载。
 */
const ACTIVE_STATUSES: ReadonlySet<PetTaskStatus> = new Set([
  'created',
  'queued',
  'running',
  'review',
  'awaiting-user',
  'awaiting-approval',
])

/**
 * 成员行。
 *
 * `toolScope` 只区分两档措辞：`read-only` 说"只读"，其它一律说"会改动你的文件"。
 * 认不出的值往"能改"那一档归——和审批风险等级同一个道理，把不认识的能力说成无害，
 * 用户就会在不该放心的地方放心。
 */
export function memberRow(
  member: TeamMemberSnapshot,
  tasks: readonly TeamTaskSnapshot[],
  proposals: readonly TeamProposalSnapshot[],
): MemberRow {
  const activeTasks = tasks.filter(
    task => task.ownerId === member.assistantId && ACTIVE_STATUSES.has(taskStatusOf(task)),
  ).length
  const pendingApprovals = proposals.filter(
    item => item.assistantId === member.assistantId && (item.state ?? 'pending') === 'pending',
  ).length
  const canWriteFiles = member.toolScope !== 'read-only'
  return {
    assistantId: member.assistantId,
    displayName: member.displayName || member.assistantId,
    roleId: member.roleId || null,
    scopeLabel: canWriteFiles ? '会改动你的文件' : '只读',
    canWriteFiles,
    enabled: member.enabled !== false,
    activeTasks,
    pendingApprovals,
  }
}

/**
 * 待批提案的排序：先到期的在前。
 *
 * 没有截止时间的排最后——它不会自己消失，而快到期的那条再不看就没了。
 */
export function sortProposals(proposals: readonly TeamProposalSnapshot[]): TeamProposalSnapshot[] {
  return [...proposals].sort((left, right) => {
    const leftAt = typeof left.expiresAt === 'number' ? left.expiresAt : Number.POSITIVE_INFINITY
    const rightAt = typeof right.expiresAt === 'number' ? right.expiresAt : Number.POSITIVE_INFINITY
    if (leftAt !== rightAt) return leftAt - rightAt
    return left.proposalId < right.proposalId ? -1 : left.proposalId > right.proposalId ? 1 : 0
  })
}

export interface ApprovalBanner {
  count: number
  headline: string
  /** 最紧那条的 id。只有一条时提示上的按钮直接打开它的审批窗口，不必先切到团队页。 */
  proposalId: string
}

/**
 * 对话标签页上那条紧凑的待批提示。
 *
 * 只给数量和最紧的那条工具名，不摊开整张卡：对话页的高度是紧的，而完整列表在团队页里有。
 * 这里的作用是让用户在打字的时候也知道"有东西在等你"，不是让他在这儿做决定。
 *
 * headline 与 proposalId 指的是同一条：提示上写着「delete_file」等你点头，
 * 按钮点的就必须是那一条 delete_file。文字说一件事、按钮做另一件事，
 * 用户会以为自己批准了全部，而实际只放行了一条。
 *
 * 只算 pending 的：已经批过/驳过/过期的还留在快照里的话，计数会一直挂着一个假数字。
 */
export function approvalBanner(proposals: readonly TeamProposalSnapshot[]): ApprovalBanner | null {
  const pending = sortProposals(proposals.filter(item => (item.state ?? 'pending') === 'pending'))
  if (pending.length === 0) return null
  const first = pending[0]
  const tool = first.tool || '未知操作'
  return {
    count: pending.length,
    headline: pending.length === 1 ? `「${tool}」等你点头` : `「${tool}」等 ${pending.length} 个操作等你点头`,
    proposalId: first.proposalId,
  }
}

export interface TeamPanelView {
  teamEnabled: boolean
  members: MemberRow[]
  tasks: TaskRow[]
  proposals: TeamProposalSnapshot[]
  /** 正在推进的任务数。桥接给了就用它，没给就自己数——两个来源不一致时以自己数的为准，见下。 */
  runningCount: number
}

/**
 * 把一份团队快照投影成面板要渲染的全部内容。
 *
 * `now` 由调用方传进来（面板本来就有一个每秒更新的时间状态），不在这里取当前时刻：
 * "逾期"与"今天到期"这两条提示完全取决于 now，函数自己读时钟的话就没法用受控时间测。
 *
 * `runningCount` 不直接采用桥接给的 `running` 字段：那是宿主自己算的一个数，
 * 和 tasks 列表可能来自不同时刻。面板上"3 个进行中"而列表里只有 2 条，用户会去找
 * 那条不存在的任务。所以按 tasks 数一遍，数出来的和列表永远对得上。
 */
export function teamPanelView(
  snapshot: TeamSnapshot | null,
  memberNames: (assistantId: string) => string | null,
  now: number,
): TeamPanelView {
  const members = snapshot?.members ?? []
  const tasks = snapshot?.tasks ?? []
  const proposals = sortProposals((snapshot?.proposals ?? []).filter(item => (item.state ?? 'pending') === 'pending'))
  const runningStatuses = new Set<PetTaskStatus>(['running'])

  return {
    teamEnabled: snapshot?.team === true,
    members: members.map(member => memberRow(member, tasks, proposals)),
    tasks: sortTasks(tasks).map(task => {
      const status = taskStatusOf(task)
      const note = artifactNote(task) ?? deadlineNote(task, now)
      return {
        taskId: task.taskId,
        goal: task.goal?.trim() || '（没有写目标）',
        status,
        statusLabel: TASK_STATUS_LABEL[status],
        tone: taskTone(status),
        owner: task.ownerId ? memberNames(task.ownerId) ?? task.ownerId : null,
        artifactCount: task.artifacts?.length ?? 0,
        note,
      }
    }),
    proposals,
    runningCount: tasks.filter(task => runningStatuses.has(taskStatusOf(task))).length,
  }
}
