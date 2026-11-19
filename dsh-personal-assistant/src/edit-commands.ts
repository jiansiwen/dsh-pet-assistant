/**
 * 工作台「待办 / 会议」行内改删命令的参数解析。
 *
 * 只解析形状与值域，真正的写仍走可信通道：待办改标题/改期/取消提交待批提案，
 * 间隔与会议改删走桌宠本机确认。这里不猜意图 —— 解析不出就回用法提示。
 */

export const TASK_EDIT_USAGE =
  '用法：/assistant-task-set title|deadline|interval|cancel <任务ID> [新标题| epoch毫秒或ISO时间 | 间隔秒]'

export const MEETING_EDIT_USAGE =
  '用法：/assistant-meeting-set rename|delete <会议ID> [新名称]'

const ID = /^[A-Za-z0-9_-]{1,128}$/u

export type TaskEditRequest =
  | { readonly kind: 'title'; readonly taskId: string; readonly value: string }
  | { readonly kind: 'deadline'; readonly taskId: string; readonly value: string }
  | { readonly kind: 'interval'; readonly taskId: string; readonly seconds: number }
  | { readonly kind: 'cancel'; readonly taskId: string }

export type MeetingEditRequest =
  | { readonly kind: 'rename'; readonly meetingId: string; readonly name: string }
  | { readonly kind: 'delete'; readonly meetingId: string }

function split(rawInput: string | undefined): { head: string[]; rest: string } {
  const raw = (rawInput ?? '').trim()
  const body = raw.startsWith('/') ? raw.slice(raw.indexOf(' ') + 1) : raw
  const trimmed = body.trim()
  if (trimmed === '') return { head: [], rest: '' }
  const parts = trimmed.split(/\s+/u)
  return { head: parts.slice(0, 2), rest: parts.slice(2).join(' ') }
}

/** epoch 毫秒 → 带本地时区偏移的 ISO。改期接口只认带偏移的 ISO，不能给裸的 datetime-local。 */
export function localOffsetIso(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(off / 60)}:${pad(off % 60)}`
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/u

export function parseTaskEdit(rawInput: string | undefined): TaskEditRequest | null {
  const { head, rest } = split(rawInput)
  const [kind, taskId] = head
  if (kind === undefined || taskId === undefined || !ID.test(taskId)) return null
  if (kind === 'cancel') return { kind: 'cancel', taskId }
  if (kind === 'title') {
    const value = rest.trim()
    return value !== '' && value.length <= 200 ? { kind: 'title', taskId, value } : null
  }
  if (kind === 'interval') {
    const seconds = Number(rest.trim())
    return Number.isInteger(seconds) && seconds >= 60 && seconds <= 604_800 ? { kind: 'interval', taskId, seconds } : null
  }
  if (kind === 'deadline') {
    const token = rest.trim()
    if (/^\d{10,16}$/u.test(token)) return { kind: 'deadline', taskId, value: localOffsetIso(Number(token)) }
    return ISO_WITH_OFFSET.test(token) ? { kind: 'deadline', taskId, value: token } : null
  }
  return null
}

export function parseMeetingEdit(rawInput: string | undefined): MeetingEditRequest | null {
  const { head, rest } = split(rawInput)
  const [kind, meetingId] = head
  if (kind === undefined || meetingId === undefined || !ID.test(meetingId)) return null
  if (kind === 'delete') return { kind: 'delete', meetingId }
  if (kind === 'rename') {
    const name = rest.trim()
    return name !== '' && name.length <= 200 ? { kind: 'rename', meetingId, name } : null
  }
  return null
}
