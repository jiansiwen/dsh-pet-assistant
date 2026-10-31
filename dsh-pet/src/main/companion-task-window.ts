import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sameLocalPage } from './approval-policy.ts'
import {
  CONTROL_LABELS, RESPONSE_LABELS, TASK_LABELS, controlsFor, deviceTimezone, displayTime, identifier, isoTime,
  parseCycle, parseInput, parseTask, record, scheduleDescription, text, integer,
  type CompanionDetail, type CompanionInput, type CompanionReply, type ReminderAction, type TaskControl,
} from '../companion-types.ts'

export const COMPANION_TASK_CHANNELS = {
  list: 'companion-tasks:list', detail: 'companion-tasks:detail', reminders: 'companion-tasks:reminders',
  defaults: 'companion-tasks:defaults', setInterval: 'companion-tasks:set-interval',
  create: 'companion-tasks:create', control: 'companion-tasks:control', respond: 'companion-tasks:respond',
  requestReview: 'companion-tasks:request-review',
} as const
export const COMPANION_TASK_CHANGED = 'companion-tasks:changed'
export const COMPANION_TASK_PARTITION = 'dsh-companion-tasks'
export interface CompanionConfirm { title: string; message: string; detail: string; confirmLabel: string }
export interface CompanionTasksOptions {
  request(method: string, pathname: string, body: unknown, subject: 'client' | 'owner'): Promise<{ status: number; body: unknown }>
  openApproval(proposalId: string): Promise<{ ok: boolean; error?: string }>
  pagePath?: string
  preloadPath?: string
  /** 仅供主进程测试注入，不能由页面设置。 */
  confirm?(parent: BrowserWindow, spec: CompanionConfirm): Promise<boolean>
}
export interface CompanionTasksHandle {
  open(): void; refresh(): void; dispose(): void; readonly window: BrowserWindow | null
}
class CallFailure extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 0) {
    super(message)
    this.code = code
    this.status = status
  }
}
const failure = (code: string, error: string, status = 0): CompanionReply<never> => ({ ok: false, code, error, status, data: null })
const success = <T>(data: T, status = 200): CompanionReply<T> => ({ ok: true, status, data })
const root = '/companion/v1'
const taskPath = (id: string) => `${root}/tasks/${encodeURIComponent(id)}`
const cyclesPath = (id: string) => `${root}/reminders?taskId=${encodeURIComponent(id)}`
const here = path.dirname(fileURLToPath(import.meta.url))

async function nativeConfirm(parent: BrowserWindow, spec: CompanionConfirm): Promise<boolean> {
  const result = await dialog.showMessageBox(parent, {
    type: 'question', title: spec.title, message: spec.message, detail: spec.detail,
    buttons: ['取消', spec.confirmLabel], defaultId: 0, cancelId: 0, noLink: true,
  })
  return result.response === 1
}
function describeInput(input: CompanionInput): string {
  return input.kind === 'agent' ? `内容：\n${input.description}\n方式：手工待办，不自动执行；不设置提醒时间`
    : `提醒内容：\n${input.message}\n计划：${scheduleDescription(input.schedule)}\n未回应时每 ${input.repeatEverySeconds} 秒催办\n关联业务任务：${input.relatedBusinessTaskId ?? '无'}\n渠道：${input.channel === 'wecom' ? '企业微信' : '桌面提醒'}\n${input.channel === 'wecom' ? '' : '电脑关机时不触发；'}“知道了”不等于业务完成。`
}
function localPage(actual: string, expected: string): boolean {
  try { return new URL(actual).host === new URL(expected).host && sameLocalPage(actual, expected) } catch { return false }
}
function detailProjection(body: Record<string, unknown>): CompanionDetail {
  const task = parseTask(body.task)
  const raw = body.input == null ? null : record(body.input)
  const supported = raw && (raw.kind === 'reminder' || (raw.kind === 'agent' && raw.executionMode === 'manual'))
  return { task, input: supported ? parseInput(raw) : null, proposalId: body.proposalId == null ? null : identifier(body.proposalId) }
}

export function registerCompanionTasks(options: CompanionTasksOptions): CompanionTasksHandle {
  const pagePath = options.pagePath ?? path.join(here, '../renderer/companion-tasks.html')
  const pageURL = pathToFileURL(pagePath).href
  const preload = options.preloadPath ?? path.join(here, '../preload/companion-tasks.cjs')
  const confirm = options.confirm ?? nativeConfirm
  let win: BrowserWindow | null = null
  let disposed = false
  let mutating = false
  const allowed = (event: IpcMainInvokeEvent): boolean => !!win && !disposed && !win.isDestroyed()
    && event.sender.id === win.webContents.id && event.senderFrame !== null
    && event.senderFrame === win.webContents.mainFrame && event.senderFrame === event.sender.mainFrame
    && localPage(event.senderFrame.url, pageURL) && localPage(win.webContents.getURL(), pageURL)
  const assertAllowed = (event: IpcMainInvokeEvent) => {
    if (!allowed(event)) throw new CallFailure('denied', '请求不是来自当前任务窗口的原始主页面，未执行')
  }
  const refresh = () => { if (win && !win.isDestroyed() && !disposed) win.webContents.send(COMPANION_TASK_CHANGED) }
  const call = async (method: string, pathname: string, body: unknown, subject: 'client' | 'owner') => {
    let result: { status: number; body: unknown }
    try { result = await options.request(method, pathname, body, subject) } catch {
      throw new CallFailure(subject === 'owner' ? 'unknown' : 'unavailable', subject === 'owner'
        ? '连接中断，操作结果未知；请刷新核对，不会自动重发' : '任务服务不可用，请确认桌面助理已连接后重试')
    }
    if (result.status < 200 || result.status >= 300) {
      const unavailable = [401, 403, 404, 501, 502, 503, 504].includes(result.status)
      throw new CallFailure(unavailable ? 'unavailable' : result.status === 409 ? 'conflict' : 'error',
        unavailable ? '接口未接通、无权限或目标已不可用，请刷新后重试'
          : result.status === 409 ? '任务或提醒版本已变化，请刷新后重新核对' : '服务拒绝了操作，请核对输入后重试', result.status)
    }
    try { return { status: result.status, body: record(result.body) } } catch {
      throw new CallFailure(subject === 'owner' ? 'unknown' : 'invalid_response', '服务返回的数据不完整，请刷新核对；不会自动重发', result.status)
    }
  }
  const freshDetail = async (id: string) => {
    const result = await call('GET', taskPath(id), undefined, 'client')
    const detail = detailProjection(result.body)
    if (detail.task.taskId !== id) throw new CallFailure('invalid_response', '服务返回了其他任务，未执行')
    return detail
  }
  const freshCycles = async (id: string) => {
    const result = await call('GET', cyclesPath(id), undefined, 'client')
    if (!Array.isArray(result.body.cycles)) throw new CallFailure('unavailable', '提醒回应接口尚未提供周期列表')
    const cycles = result.body.cycles.map(parseCycle)
    if (cycles.some(cycle => cycle.taskId !== id)) throw new CallFailure('invalid_response', '提醒所属任务不一致，未执行')
    return cycles
  }
  const approveLocally = async (event: IpcMainInvokeEvent, label: string, detail: string) => {
    assertAllowed(event)
    const expiresAt = new Date(Date.now() + 120_000).toISOString()
    const accepted = await confirm(win!, {
      title: '确认任务操作', message: `是否${label}？`, confirmLabel: `确认${label}`,
      detail: `操作：${label}\n生效时间：确认后立即提交\n${detail}\n本次确认有效至：${displayTime(expiresAt)}（${deviceTimezone()}）`,
    })
    if (accepted !== true) throw new CallFailure('cancelled', '已取消，没有提交操作')
    assertAllowed(event)
    if (Date.now() >= Date.parse(expiresAt)) throw new CallFailure('expired', '确认已过期，请重新核对')
    return { protocolVersion: 1, commandId: randomUUID(), expiresAt }
  }
  const openReview = async (event: IpcMainInvokeEvent, proposalId: string) => {
    assertAllowed(event)
    try {
      const result = await options.openApproval(proposalId)
      return result.ok ? { ok: true } : { ok: false, error: '专用审批窗口未能打开，请稍后重试' }
    } catch { return { ok: false, error: '专用审批窗口未能打开，请稍后重试' } }
  }
  const mutationResult = async (event: IpcMainInvokeEvent, result: Awaited<ReturnType<typeof call>>, needsTask: boolean) => {
    try {
      const proposalId = result.body.proposalId == null ? null : identifier(result.body.proposalId)
      const task = result.body.task == null ? undefined : parseTask(result.body.task)
      if (!proposalId && needsTask && !task) throw new Error('缺少任务')
      const awaitingApproval = !!proposalId && result.body.requiresApproval !== false
      const reply = success({ ...(task ? { task } : {}), ...(awaitingApproval ? { awaitingApproval: true } : {}) }, result.status)
      if (awaitingApproval) return { ...reply, approvalWindow: await openReview(event, proposalId!) }
      return reply
    } catch (error) {
      if (error instanceof CallFailure) throw error
      throw new CallFailure('unknown', '操作已提交，但回执不完整；请刷新核对，不会自动重发', result.status)
    } finally { refresh() }
  }
  const register = (channel: string, write: boolean, handler: (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>) => {
    ipcMain.handle(channel, async (event, raw: unknown) => {
      if (!allowed(event)) return failure('denied', '请求不是来自当前任务窗口，未执行')
      if (write && mutating) return failure('busy', '已有操作正在确认或提交，请勿重复点击')
      if (write) mutating = true
      try { return await handler(event, raw) } catch (error) {
        return error instanceof CallFailure ? failure(error.code, error.message, error.status)
          : failure('bad_request', error instanceof Error ? error.message : '数据无效，未执行')
      } finally { if (write) mutating = false }
    })
  }
  register(COMPANION_TASK_CHANNELS.list, false, async () => {
    const result = await call('GET', `${root}/tasks`, undefined, 'client')
    if (!Array.isArray(result.body.tasks)) throw new CallFailure('invalid_response', '服务没有返回任务列表，不能视为空列表')
    const rawAttention = result.body.meetingMailAttention
    if (rawAttention !== undefined && (!Array.isArray(rawAttention) || rawAttention.length > 20)) throw new CallFailure('invalid_response', '会议邮件提醒状态不完整，请刷新核查')
    const meetingMailAttention = (rawAttention ?? []).map((raw: unknown) => {
      const item = record(raw)
      return { intentId: identifier(item.intentId), acceptedAt: isoTime(item.acceptedAt) }
    })
    return success({ tasks: result.body.tasks.map(parseTask), meetingMailAttention }, result.status)
  })
  register(COMPANION_TASK_CHANNELS.defaults, false, async () => {
    const result = await call('GET', `${root}/reminder-defaults`, undefined, 'client')
    return success({ repeatEverySeconds: integer(result.body.repeatEverySeconds, 60, 604_800, '默认催办间隔') })
  })
  register(COMPANION_TASK_CHANNELS.setInterval, true, async (event, raw) => {
    const input = record(raw)
    const id = identifier(input.taskId)
    const seconds = integer(input.repeatEverySeconds, 60, 604_800, '催办间隔（秒）')
    const detail = await freshDetail(id)
    if (detail.task.parentTaskId || detail.input?.kind !== 'reminder' || !controlsFor(detail.task, detail.input).length) {
      throw new CallFailure('unavailable', '请在尚未结束的提醒主任务中修改间隔')
    }
    const command = await approveLocally(event, '修改催办间隔', `目标：${detail.task.title}\n任务版本：${detail.task.revision}\n原间隔：${detail.input.repeatEverySeconds} 秒\n新间隔：${seconds} 秒\n只修改这条计划及当前未回应周期，不更改首次时间、延后时间和暂停状态。`)
    return mutationResult(event, await call('POST', `${taskPath(id)}/set-interval`, {
      ...command, taskId: id, expectedRevision: detail.task.revision, payload: { repeatEverySeconds: seconds },
    }, 'owner'), true)
  })
  register(COMPANION_TASK_CHANNELS.detail, false, async (_event, raw) => success(await freshDetail(identifier(raw))))
  register(COMPANION_TASK_CHANNELS.reminders, false, async (_event, raw) => success({ cycles: await freshCycles(identifier(raw)) }))
  register(COMPANION_TASK_CHANNELS.create, true, async (event, raw) => {
    const v = record(raw)
    const title = text(v.title, 500, '标题')
    const input = parseInput(v.input, true)
    let related = ''
    if (input.kind === 'reminder' && input.relatedBusinessTaskId) {
      const detail = await freshDetail(input.relatedBusinessTaskId)
      if (detail.task.kind === 'reminder') throw new CallFailure('bad_request', '请选择业务任务，不要关联另一个提醒')
      related = `\n关联任务标题：${detail.task.title}（第 ${detail.task.revision} 版）`
    }
    const command = await approveLocally(event, input.kind === 'agent' ? '创建手工待办' : '创建桌面提醒', `标题：${title}\n${describeInput(input)}${related}`)
    parseInput(input, true)
    const stored = await call('POST', `${root}/inputs`, input, 'owner')
    const inputRef = identifier(stored.body.inputRef)
    assertAllowed(event)
    if (Date.now() >= Date.parse(command.expiresAt)) throw new CallFailure('expired', '输入已登记，但确认已过期，任务未提交；请重新创建')
    parseInput(input, true)
    return mutationResult(event, await call('POST', `${root}/tasks`, {
      ...command, payload: { kind: input.kind, title, inputRef, dependsOn: [] },
    }, 'owner'), true)
  })
  register(COMPANION_TASK_CHANNELS.control, true, async (event, raw) => {
    const v = record(raw)
    const id = identifier(v.taskId)
    if (!Object.hasOwn(CONTROL_LABELS, String(v.action))) throw new CallFailure('bad_request', '不支持这个任务操作')
    const action = v.action as TaskControl
    const detail = await freshDetail(id)
    if (!controlsFor(detail.task, detail.input).includes(action)) throw new CallFailure('unavailable', '当前状态或任务详情不支持这个操作；未知结果及待批准任务不能在此改变')
    const command = await approveLocally(event, CONTROL_LABELS[action], `目标：${detail.task.title}\n任务编号：${id}\n版本：${detail.task.revision}\n当前状态：${TASK_LABELS[detail.task.status] ?? '未知'}\n${describeInput(detail.input!)}`)
    return mutationResult(event, await call('POST', `${taskPath(id)}/${action}`, {
      ...command, taskId: id, expectedRevision: detail.task.revision, payload: {},
    }, 'owner'), true)
  })
  register(COMPANION_TASK_CHANNELS.respond, true, async (event, raw) => {
    const v = record(raw)
    const id = identifier(v.taskId)
    const cycleId = identifier(v.cycleId)
    if (!Object.hasOwn(RESPONSE_LABELS, String(v.action))) throw new CallFailure('bad_request', '不支持这个提醒回应')
    const action = v.action as ReminderAction
    const snoozedUntil = action === 'snooze' ? isoTime(v.snoozedUntil, true) : null
    if (action !== 'snooze' && v.snoozedUntil != null) throw new CallFailure('bad_request', '知道了或取消提醒不能携带延后时间')
    const detail = await freshDetail(id)
    const cycle = (await freshCycles(id)).find(item => item.cycleId === cycleId)
    if (!cycle || cycle.taskRevision === null || cycle.taskRevision !== detail.task.revision) throw new CallFailure('conflict', '提醒与当前任务版本不一致或版本缺失，请刷新后重试')
    if (detail.task.kind !== 'reminder' || !detail.input || detail.input.kind !== 'reminder'
      || !['awaiting-response', 'snoozed'].includes(cycle.state)
      || !['created', 'queued', 'running', 'awaiting-user'].includes(detail.task.status)) throw new CallFailure('unavailable', '当前提醒状态或内容不支持回应，请刷新核对')
    const command = await approveLocally(event, RESPONSE_LABELS[action], `目标：${detail.task.title}\n任务编号：${id}；版本：${detail.task.revision}\n本轮：${cycle.title}\n周期编号：${cycleId}；版本：${cycle.revision}\n${describeInput(detail.input)}\n${snoozedUntil ? `延后至：${displayTime(snoozedUntil)}（${deviceTimezone()}；${snoozedUntil}）` : '只回应本轮提醒，不标记关联业务完成。'}`)
    if (snoozedUntil) isoTime(snoozedUntil, true)
    return mutationResult(event, await call('POST', `${root}/reminders/${encodeURIComponent(cycleId)}/respond`, {
      ...command, taskId: id, expectedRevision: detail.task.revision,
      payload: { cycleId, expectedCycleRevision: cycle.revision, action, snoozedUntil },
    }, 'owner'), false)
  })
  register(COMPANION_TASK_CHANNELS.requestReview, true, async (event, raw) => {
    const detail = await freshDetail(identifier(raw))
    if (detail.task.status !== 'awaiting-approval' || !detail.proposalId) throw new CallFailure('unavailable', '服务未提供当前待批提案，请在桌面助理待办中核对')
    return { ...success(null), approvalWindow: await openReview(event, detail.proposalId) }
  })

  return {
    get window() { return win }, refresh,
    open() {
      if (disposed) return
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show(); win.focus(); refresh(); return
      }
      const created = new BrowserWindow({
        title: '小潘 · 任务与提醒', width: 1140, height: 820, minWidth: 720, minHeight: 540, show: false, autoHideMenuBar: true,
        webPreferences: {
          preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
          allowRunningInsecureContent: false, experimentalFeatures: false, spellcheck: false,
          partition: `${COMPANION_TASK_PARTITION}-${randomUUID()}`,
        },
      })
      win = created
      created.setMenuBarVisibility(false)
      const session = created.webContents.session
      session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      session.setPermissionCheckHandler(() => false)
      session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|devtools):/i.test(details.url) }))
      created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      created.webContents.on('will-navigate', event => event.preventDefault())
      created.webContents.on('will-frame-navigate', event => event.preventDefault())
      created.webContents.on('will-redirect', event => event.preventDefault())
      created.webContents.on('will-attach-webview', event => event.preventDefault())
      created.once('ready-to-show', () => { if (win === created && !created.isDestroyed()) created.show() })
      created.on('closed', () => { if (win === created) win = null })
      void created.loadFile(pagePath).catch(() => { if (win === created) win = null; if (!created.isDestroyed()) created.close() })
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const channel of Object.values(COMPANION_TASK_CHANNELS)) ipcMain.removeHandler(channel)
      const current = win
      win = null
      if (current && !current.isDestroyed()) current.close()
    },
  }
}
