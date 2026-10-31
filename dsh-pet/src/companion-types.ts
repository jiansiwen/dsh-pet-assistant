export type ReminderSchedule =
  | { kind: 'once'; timezone: string; runAt: string }
  | { kind: 'interval'; timezone: string; runAt: string; everySeconds: number }
  | { kind: 'daily'; timezone: string; localTime: string }

export type CompanionInput =
  | { kind: 'agent'; executionMode: 'manual'; description: string }
  | { kind: 'reminder'; message: string; schedule: ReminderSchedule; repeatEverySeconds: number; relatedBusinessTaskId: string | null; channel: 'desktop' | 'wecom'; recipientId?: string }
export interface CompanionTaskView {
  taskId: string; parentTaskId: string | null; kind: string; title: string; status: string
  blocker: string | null; revision: number; deviceId: string; artifactIds: string[]; updatedAt: string
}
export interface ReminderCycleView {
  cycleId: string; taskId: string; taskRevision: number | null; revision: number
  state: string; nextNagAt: string | null; title: string
}
export interface CompanionDetail { task: CompanionTaskView; input: CompanionInput | null; proposalId: string | null }
export interface CompanionReply<T> {
  ok: boolean; status: number; data: T | null; code?: string; error?: string
  approvalWindow?: { ok: boolean; error?: string }
}
export type TaskControl = 'pause' | 'resume' | 'cancel' | 'complete'
export type ReminderAction = 'ack' | 'snooze' | 'cancel'
export interface CompanionCreate { title: string; input: CompanionInput }
export interface CompanionResponse { taskId: string; cycleId: string; action: ReminderAction; snoozedUntil: string | null }
export interface CompanionMutation { task?: CompanionTaskView; awaitingApproval?: boolean }
export interface DesktopReminderDelivery {
  deliveryId: string
  occurrenceId: string
  operationId: string
  taskId: string
  taskRevision: number
  cycleId: string
  cycleRevision: number
  title: string
  message: string
  executorEpoch: string
}
export interface DesktopMailNotice {
  analysisId: string
  memberId: string
  text: string
}
export interface DesktopMailNoticeAttention {
  analysisId: string
  memberId: string
  state: 'failed' | 'unknown'
}
export interface MeetingMailAttention {
  intentId: string
  acceptedAt: string
}
export interface CompanionTasksApi {
  list(): Promise<CompanionReply<{ tasks: CompanionTaskView[]; meetingMailAttention?: MeetingMailAttention[] }>>
  defaults(): Promise<CompanionReply<{ repeatEverySeconds: number }>>
  setInterval(draft: { taskId: string; repeatEverySeconds: number }): Promise<CompanionReply<CompanionMutation>>
  detail(taskId: string): Promise<CompanionReply<CompanionDetail>>
  reminders(taskId: string): Promise<CompanionReply<{ cycles: ReminderCycleView[] }>>
  create(draft: CompanionCreate): Promise<CompanionReply<CompanionMutation>>
  control(draft: { taskId: string; action: TaskControl }): Promise<CompanionReply<CompanionMutation>>
  respond(draft: CompanionResponse): Promise<CompanionReply<CompanionMutation>>
  requestReview(taskId: string): Promise<CompanionReply<null>>
  onChanged(callback: () => void): () => void
}

export const TASK_LABELS: Record<string, string> = {
  created: '已创建', queued: '排队中', running: '进行中', 'awaiting-approval': '等待批准',
  'awaiting-user': '等待处理', review: '待复核', done: '已完成', failed: '失败', cancelled: '已取消', unknown: '结果未知',
}
export const CYCLE_LABELS: Record<string, string> = {
  scheduled: '尚未到时', 'awaiting-response': '等待回应', acknowledged: '已知道',
  snoozed: '已延后', cancelled: '本轮已取消', unknown: '投递结果未知',
}
export const CONTROL_LABELS: Record<TaskControl, string> = { pause: '暂停', resume: '恢复', cancel: '取消任务', complete: '标记业务完成' }
export const RESPONSE_LABELS: Record<ReminderAction, string> = { ack: '知道了', snooze: '延后提醒', cancel: '取消本轮提醒' }
export const BLOCKER_LABELS: Record<string, string> = {
  'device-offline': '设备离线', budget: '预算不足', credentials: '凭据不可用', permission: '缺少权限',
  'input-changed': '输入已变化', 'manual-pause': '手动暂停',
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('数据格式不完整，请刷新后重试')
  return value as Record<string, unknown>
}
export function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error(`${label}不能为空或超过 ${max} 字，且不能包含控制字符`)
  }
  return value.trim()
}
export function identifier(value: unknown): string {
  const id = text(value, 200, '编号')
  if (id === '.' || id === '..' || /[\\/?#\s]/u.test(id)) throw new Error('编号格式无效')
  return id
}
export function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}须为 ${min} 至 ${max} 的整数`)
  return value
}
export function isoTime(value: unknown, future = false): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('时间必须包含明确时区')
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || (future && ms <= Date.now())) throw new Error('请选择未来的有效时间')
  return new Date(ms).toISOString()
}
export function deviceTimezone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone }
export function localDateTimeToISO(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('请选择完整日期和时间')
  const d = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  const roundTrip = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (!Number.isFinite(d.getTime()) || roundTrip !== value) throw new Error('该本地时间不存在，请重新选择')
  return isoTime(d.toISOString(), true)
}
export function displayTime(value: string | null, timezone = deviceTimezone()): string {
  if (!value) return '未提供时间'
  return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value))
}
export function parseInput(raw: unknown, future = false): CompanionInput {
  const value = record(raw)
  if (value.kind === 'agent' && value.executionMode === 'manual') return { kind: 'agent', executionMode: 'manual', description: text(value.description, 8000, '任务内容') }
  if (value.kind !== 'reminder' || (value.channel !== 'desktop' && value.channel !== 'wecom')) throw new Error('这里只支持手工待办和提醒')
  const s = record(value.schedule)
  const timezone = text(s.timezone, 100, '时区')
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }) } catch { throw new Error('时区无效') }
  let schedule: ReminderSchedule
  if (s.kind === 'daily') {
    if (typeof s.localTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.localTime)) throw new Error('请选择每天提醒的时刻')
    schedule = { kind: 'daily', timezone, localTime: s.localTime }
  } else if (s.kind === 'once' || s.kind === 'interval') {
    const runAt = isoTime(s.runAt, future)
    schedule = s.kind === 'once' ? { kind: 'once', timezone, runAt }
      : { kind: 'interval', timezone, runAt, everySeconds: integer(s.everySeconds, 60, 31_536_000, '触发间隔（秒）') }
  } else throw new Error('请选择一次、间隔或每天提醒')
  return {
    kind: 'reminder', message: text(value.message, 2000, '提醒内容'), schedule,
    repeatEverySeconds: integer(value.repeatEverySeconds, 60, 604_800, '未回应时催办间隔（秒）'),
    relatedBusinessTaskId: value.relatedBusinessTaskId === null ? null : identifier(value.relatedBusinessTaskId),
    channel: value.channel === 'wecom' ? 'wecom' : 'desktop',
    ...(value.channel === 'wecom' && value.recipientId ? { recipientId: identifier(value.recipientId) } : {}),
  }
}
export function parseTask(raw: unknown): CompanionTaskView {
  const v = record(raw)
  if (!Array.isArray(v.artifactIds)) throw new Error('任务成果列表缺失')
  return {
    taskId: identifier(v.taskId), parentTaskId: v.parentTaskId === null ? null : identifier(v.parentTaskId),
    kind: text(v.kind, 60, '任务种类'), title: text(v.title, 500, '标题'), status: text(v.status, 60, '任务状态'),
    blocker: v.blocker === null ? null : text(v.blocker, 100, '阻塞原因'), revision: integer(v.revision, 1, Number.MAX_SAFE_INTEGER, '任务版本'),
    deviceId: identifier(v.deviceId), artifactIds: v.artifactIds.map(identifier), updatedAt: isoTime(v.updatedAt),
  }
}
export function parseCycle(raw: unknown): ReminderCycleView {
  const v = record(raw)
  return {
    cycleId: identifier(v.cycleId), taskId: identifier(v.taskId),
    taskRevision: v.taskRevision == null ? null : integer(v.taskRevision, 1, Number.MAX_SAFE_INTEGER, '提醒所属任务版本'),
    revision: integer(v.revision, 1, Number.MAX_SAFE_INTEGER, '提醒版本'), state: text(v.state, 60, '提醒状态'),
    nextNagAt: v.nextNagAt === null ? null : isoTime(typeof v.nextNagAt === 'number'
      ? new Date(integer(v.nextNagAt, 0, 8_640_000_000_000_000, '提醒时间')).toISOString() : v.nextNagAt), title: text(v.title, 500, '提醒标题'),
  }
}
export function scheduleDescription(schedule: ReminderSchedule): string {
  if (schedule.kind === 'daily') return `每天 ${schedule.localTime}（${schedule.timezone}）；从下一个该时刻开始`
  return `${displayTime(schedule.runAt, schedule.timezone)}（${schedule.timezone}；${schedule.runAt}）${schedule.kind === 'interval' ? `，之后每 ${schedule.everySeconds} 秒触发` : '，仅一次'}`
}
export function controlsFor(task: CompanionTaskView, input: CompanionInput | null): TaskControl[] {
  if (!input || task.kind !== input.kind || !['created', 'queued', 'running', 'awaiting-user'].includes(task.status)) return []
  const controls: TaskControl[] = task.blocker === 'manual-pause' ? ['resume', 'cancel'] : ['pause', 'cancel']
  if (input.kind === 'agent') controls.push('complete')
  return controls
}
