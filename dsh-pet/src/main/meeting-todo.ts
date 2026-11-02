/** 已确认会议行动项交接：固定版本、本人确认、复验后交给现有任务运行时。 */
import { createHash } from 'node:crypto'
import { renderStructuredSections } from './meeting-minutes.ts'
import type { MeetingMinutesView } from './meeting-recorder.ts'

export interface MeetingTodoRequest { meetingId: string; itemId: string; revision: number; digest: string }
export interface MeetingTodoSnapshot extends MeetingTodoRequest {
  meetingName: string
  confirmedAt: number
  text: string
  owner: string | null
  due: string | null
  sourceRefs: string[]
}
export interface MeetingTodoResult {
  ok: boolean
  error?: string
  message?: string
  taskId?: string
  duplicate?: boolean
  sourceChanged?: boolean
}
export interface MeetingTodoDeps {
  read(meetingId: string): { name: string | null; view: MeetingMinutesView | { ok: false; error: string } }
  confirm(snapshot: MeetingTodoSnapshot): Promise<boolean>
  current(): boolean
  post(snapshot: MeetingTodoSnapshot): Promise<{ status: number; body: unknown }>
}

function snapshot(request: MeetingTodoRequest, deps: MeetingTodoDeps): MeetingTodoSnapshot | null {
  if (!request || typeof request.meetingId !== 'string' || !request.meetingId || request.meetingId.length > 200
    || typeof request.itemId !== 'string' || !/^action-\d{1,3}$/.test(request.itemId)
    || !Number.isSafeInteger(request.revision) || request.revision < 1 || !/^[a-f0-9]{64}$/.test(request.digest)) return null
  const { name, view } = deps.read(request.meetingId)
  if (!name?.trim() || name.length > 80 || !view.ok) return null
  const minutes = view.minutes, structured = minutes?.structured
  if (!minutes || minutes.undecryptable || minutes.state !== 'confirmed' || minutes.stale || minutes.kind !== 'model'
    || minutes.digest !== request.digest || minutes.revision !== request.revision || view.revision !== request.revision
    || !Number.isSafeInteger(minutes.confirmedAt) || (minutes.confirmedAt ?? 0) <= 0
    || createHash('sha256').update(minutes.content, 'utf8').digest('hex') !== request.digest
    || !structured || structured.version !== 1 || structured.generator !== 'model' || structured.basedOnRevision !== request.revision) return null
  // 数据库里的结构化内容也必须对应用户确认过的纪要正文，而不仅是借用相同的转写版本号。
  try { if (!minutes.content.includes(renderStructuredSections(structured).join('\n'))) return null } catch { return null }
  const items = structured.items.filter(item => item.id === request.itemId && item.kind === 'action' && item.status === 'kept')
  if (items.length !== 1) return null
  const item = items[0]
  if (!item.text.trim() || item.text.length > 400 || !Array.isArray(item.sources) || !item.sources.length || item.sources.length > 40
    || (item.owner !== null && (typeof item.owner !== 'string' || item.owner.length > 400))
    || (item.due !== null && (typeof item.due !== 'string' || item.due.length > 400))) return null
  const tag = createHash('sha256').update(request.meetingId, 'utf8').digest('hex').slice(0, 6)
  const prefix = `M${tag}-R${request.revision}-S`
  const sourceRefs = item.sources.map(source => source.id)
  if (new Set(sourceRefs).size !== sourceRefs.length || sourceRefs.some(ref => typeof ref !== 'string'
    || !ref.startsWith(prefix) || !/^\d{1,8}$/.test(ref.slice(prefix.length)))) return null
  return { meetingId: request.meetingId, itemId: request.itemId, revision: request.revision, digest: request.digest,
    meetingName: name.trim(), confirmedAt: minutes.confirmedAt!, text: item.text.trim(),
    owner: item.owner, due: item.due, sourceRefs }
}

export async function importMeetingTodo(request: MeetingTodoRequest, deps: MeetingTodoDeps): Promise<MeetingTodoResult> {
  let before: MeetingTodoSnapshot | null
  try { before = snapshot(request, deps) } catch { before = null }
  if (!before) return { ok: false, error: '会议纪要尚未确认、版本已变化或行动项来源不可核验；请重新核对。' }
  if (!deps.current()) return { ok: false, error: '会议页面已变化，未提交待办。' }
  let confirmed = false
  try { confirmed = await deps.confirm(before) } catch { return { ok: false, error: '未能打开确认窗口，未提交待办。' } }
  if (!confirmed) return { ok: false, error: '已取消，未提交待办。' }
  let after: MeetingTodoSnapshot | null
  try { after = snapshot(request, deps) } catch { after = null }
  if (!deps.current() || !after || JSON.stringify(after) !== JSON.stringify(before)) {
    return { ok: false, error: '确认期间会议页面或纪要已变化，未提交待办；请重新核对。' }
  }
  let response: { status: number; body: unknown }
  try { response = await deps.post(before) } catch { return { ok: false, error: '连接中断，任务登记结果未知；请先到任务页核对，不自动重发。' } }
  if (response.status === 0 || response.status >= 500) return { ok: false, error: '任务登记结果未知；请先到任务页核对，不自动重发。' }
  if (response.status !== 200 && response.status !== 201) {
    const body = response.body as { message?: unknown; error?: unknown } | null
    return { ok: false, error: typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : '任务登记未获接受，请核对后重试。' }
  }
  const body = response.body as { duplicate?: unknown; sourceChanged?: unknown; task?: { taskId?: unknown; status?: unknown } } | null
  if (typeof body?.duplicate !== 'boolean' || typeof body.task?.taskId !== 'string' || !body.task.taskId
    || typeof body.task.status !== 'string') return { ok: false, error: '任务回执不完整，结果未知；请先到任务页核对，不自动重发。' }
  let latest: MeetingTodoSnapshot | null
  try { latest = snapshot(request, deps) } catch { latest = null }
  const sourceChanged = body.sourceChanged === true || !latest || JSON.stringify(latest) !== JSON.stringify(before)
  return { ok: true, taskId: body.task.taskId, duplicate: body.duplicate, sourceChanged,
    message: sourceChanged ? '待办按你确认的原版本登记；纪要随后已变化或无法复验，请到任务页核对。'
      : body.duplicate ? '该行动项已经登记过，保留原任务，没有重复创建。'
        : '已登记为人工待办；不会自动执行或设置提醒。' }
}

/** 渲染层只能指定会议、条目及看到的版本；正文、来源和确认都由主进程提供。 */
export function createMeetingTodoHandler<E>(deps: Omit<MeetingTodoDeps, 'current'> & { binding(event: E): string | null }) {
  return async (event: E, request: unknown): Promise<MeetingTodoResult> => {
    const binding = deps.binding(event)
    if (!binding || !request || typeof request !== 'object' || Array.isArray(request)) return { ok: false, error: '会议页面或请求来源无效，未提交待办。' }
    return importMeetingTodo(request as MeetingTodoRequest, { ...deps, current: () => deps.binding(event) === binding })
  }
}
