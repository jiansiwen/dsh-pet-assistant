import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, beforeEach, mock, test } from 'node:test'
import type { CompanionConfirm } from '../src/main/companion-task-window.ts'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const removed: string[] = []
let windowSeq = 0
const opened: FakeBrowserWindow[] = []

class FakeSession {
  setPermissionRequestHandler() {}
  setPermissionCheckHandler() {}
  webRequest = { onBeforeRequest: () => undefined }
}

class FakeWebContents extends EventEmitter {
  readonly id = ++windowSeq
  readonly mainFrame = { url: '' }
  readonly session = new FakeSession()
  private currentUrl = ''
  setWindowOpenHandler() {}
  getURL(): string { return this.currentUrl }
  send(): void {}
  set url(value: string) { this.currentUrl = value; this.mainFrame.url = value }
}

class FakeBrowserWindow extends EventEmitter {
  static readonly all: FakeBrowserWindow[] = []
  readonly webContents = new FakeWebContents()
  readonly options: Record<string, unknown>
  destroyed = false
  visible = false
  constructor(options: Record<string, unknown>) { super(); this.options = options; FakeBrowserWindow.all.push(this) }
  setMenuBarVisibility() {}
  async loadFile(file: string): Promise<void> {
    this.webContents.url = pathToFileURL(file).href
    this.emit('ready-to-show')
  }
  isDestroyed(): boolean { return this.destroyed }
  isMinimized(): boolean { return false }
  show(): void { this.visible = true }
  focus(): void {}
  restore(): void {}
  close(): void { this.destroyed = true; this.emit('closed') }
}

mock.module('electron', {
  namedExports: {
    BrowserWindow: FakeBrowserWindow,
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    ipcMain: {
      handle(channel: string, handler: (...args: unknown[]) => unknown) {
        assert.ok(!handlers.has(channel), `重复注册 ${channel}`)
        handlers.set(channel, handler)
      },
      removeHandler(channel: string) { removed.push(channel); handlers.delete(channel) },
    },
  },
})

const { registerCompanionTasks, COMPANION_TASK_CHANNELS } = await import('../src/main/companion-task-window.ts')

const view = {
  taskId: 'task-1', parentTaskId: null, kind: 'agent', title: '发纪要', status: 'awaiting-user', blocker: null,
  revision: 2, deviceId: 'device-1', artifactIds: [], updatedAt: '2026-10-27T10:00:00.000Z',
}
const input = { kind: 'agent', executionMode: 'manual', description: '把纪要发给测试邮箱' }
const detail = { task: view, input, proposalId: null, cursor: 1 }
const cycle = {
  cycleId: 'cycle-1', taskId: 'task-2', taskRevision: 5, revision: 3, state: 'awaiting-response',
  nextNagAt: '2026-10-27T10:05:00.000Z', title: '看邮件',
}

function call(channel: string, raw?: unknown, sender = FakeBrowserWindow.all.at(-1)?.webContents): Promise<unknown> {
  const handler = handlers.get(channel)
  assert.ok(handler, `未注册 ${channel}`)
  return Promise.resolve(handler({ sender, senderFrame: sender?.mainFrame }, raw))
}

let requests: Array<{ method: string; pathname: string; body: unknown; subject: string }> = []
let decision = true
let reply: (method: string, pathname: string) => { status: number; body: unknown }

beforeEach(() => {
  handlers.clear()
  removed.length = 0
  opened.length = 0
  FakeBrowserWindow.all.length = 0
  requests = []
  decision = true
  reply = (method, pathname) => {
    if (method === 'GET' && pathname === '/companion/v1/tasks') return { status: 200, body: { tasks: [view], cursor: 1 } }
    if (pathname === '/companion/v1/inputs') return { status: 201, body: { inputRef: 'input-1' } }
    if (pathname === '/companion/v1/tasks') return { status: 202, body: detail }
    if (pathname === '/companion/v1/tasks/task-1') return { status: 200, body: detail }
    if (pathname.startsWith('/companion/v1/reminders')) return { status: 200, body: { cycles: [cycle] } }
    if (pathname.includes('/respond')) return { status: 202, body: { task: { ...view, taskId: 'task-2', kind: 'reminder' } } }
    return { status: 404, body: { code: 'NOT_FOUND', message: '未实现' } }
  }
})

function mount(confirm: (parent: unknown, spec: CompanionConfirm) => Promise<boolean> = async () => decision) {
  return registerCompanionTasks({
    request: async (method, pathname, body, subject) => {
      requests.push({ method, pathname, body, subject })
      return reply(method, pathname)
    },
    openApproval: async () => ({ ok: true }),
    confirm: confirm as never,
    pagePath: path.join(process.cwd(), 'dist/renderer/companion-tasks.html'),
    preloadPath: path.join(process.cwd(), 'dist/preload/companion-tasks.cjs'),
  })
}

function open(handle: ReturnType<typeof mount>): FakeBrowserWindow {
  handle.open()
  const win = FakeBrowserWindow.all.at(-1)!
  handle.refresh()
  return win
}

after(() => {
  for (const channel of Object.values(COMPANION_TASK_CHANNELS)) handlers.delete(channel)
})

test('列表只读走聊天令牌，伪造发送方被拒', async () => {
  const handle = mount()
  const win = open(handle)
  const ok = await call(COMPANION_TASK_CHANNELS.list, undefined, win.webContents) as { ok: boolean; data: { tasks: unknown[] } }
  assert.equal(ok.ok, true)
  assert.equal(ok.data.tasks.length, 1)
  assert.equal(requests[0]?.subject, 'client')

  const forged = new FakeWebContents()
  forged.url = win.webContents.getURL()
  const denied = await call(COMPANION_TASK_CHANNELS.list, undefined, forged) as { ok: boolean; code?: string }
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'denied')
  handle.dispose()
  assert.deepEqual(removed.sort(), Object.values(COMPANION_TASK_CHANNELS).sort())
})

test('已接受邮件但提醒未登记时，任务列表保留明确的待核查信息', async () => {
  reply = (method, pathname) => method === 'GET' && pathname === '/companion/v1/tasks'
    ? { status: 200, body: { tasks: [view], cursor: 1, meetingMailAttention: [
        { intentId: 'mail-1', acceptedAt: '2026-10-25T10:00:00.000Z' },
      ] } } : { status: 404, body: {} }
  const handle = mount()
  const win = open(handle)
  const result = await call(COMPANION_TASK_CHANNELS.list, undefined, win.webContents) as {
    ok: boolean; data: { meetingMailAttention: Array<{ intentId: string; acceptedAt: string }> } }
  assert.equal(result.ok, true)
  assert.deepEqual(result.data.meetingMailAttention, [{ intentId: 'mail-1', acceptedAt: '2026-10-25T10:00:00.000Z' }])
  handle.dispose()
})

test('取消原生确认后不登记输入、不创建任务', async () => {
  const handle = mount(async () => false)
  open(handle)
  const result = await call(COMPANION_TASK_CHANNELS.create, {
    title: '发纪要', input: { kind: 'agent', executionMode: 'manual', description: '把纪要发给测试邮箱' },
  }) as { ok: boolean; code?: string }
  assert.equal(result.ok, false)
  assert.equal(result.code, 'cancelled')
  assert.equal(requests.length, 0)
  handle.dispose()
})

test('确认后先登记输入再以所有者身份创建，回执带回任务', async () => {
  let spec: CompanionConfirm | null = null
  const handle = mount(async (_parent, input) => { spec = input; return true })
  const win = open(handle)
  const result = await call(COMPANION_TASK_CHANNELS.create, {
    title: '发纪要', input: { kind: 'agent', executionMode: 'manual', description: '把纪要发给测试邮箱' },
  }, win.webContents) as { ok: boolean; data: { task: { taskId: string } } }
  assert.equal(result.ok, true)
  assert.equal(result.data.task.taskId, 'task-1')
  assert.ok(spec && (spec as CompanionConfirm).detail.includes('不自动执行'))
  assert.deepEqual(requests.map(item => [item.method, item.pathname, item.subject]), [
    ['POST', '/companion/v1/inputs', 'owner'],
    ['POST', '/companion/v1/tasks', 'owner'],
  ])
  const envelope = requests[1]!.body as { commandId: string; expiresAt: string; payload: { title: string; inputRef: string } }
  assert.ok(envelope.commandId && Date.parse(envelope.expiresAt) > Date.now())
  assert.equal(envelope.payload.inputRef, 'input-1')
  handle.dispose()
})

test('提醒版本不一致时拒绝回应，不提交所有者命令', async () => {
  const handle = mount()
  const win = open(handle)
  reply = (method, pathname) => {
    if (pathname === '/companion/v1/tasks/task-2') {
      return { status: 200, body: { task: { ...view, taskId: 'task-2', kind: 'reminder', revision: 9 }, input: {
        kind: 'reminder', message: '看邮件', schedule: { kind: 'once', timezone: 'UTC', runAt: '2026-10-28T10:00:00Z' },
        repeatEverySeconds: 300, relatedBusinessTaskId: null, channel: 'desktop',
      }, proposalId: null } }
    }
    if (pathname.startsWith('/companion/v1/reminders')) return { status: 200, body: { cycles: [cycle] } }
    return { status: 404, body: { code: 'NOT_FOUND', message: '未实现' } }
  }
  const result = await call(COMPANION_TASK_CHANNELS.respond, {
    taskId: 'task-2', cycleId: 'cycle-1', action: 'ack', snoozedUntil: null,
  }, win.webContents) as { ok: boolean; code?: string }
  assert.equal(result.ok, false)
  assert.equal(result.code, 'conflict')
  assert.equal(requests.filter(item => item.subject === 'owner').length, 0)
  handle.dispose()
})

test('回应提醒需原生确认，并使用任务与周期的确切版本', async () => {
  const handle = mount()
  const win = open(handle)
  reply = (method, pathname) => {
    if (pathname === '/companion/v1/tasks/task-2') {
      return { status: 200, body: { task: { ...view, taskId: 'task-2', kind: 'reminder', revision: 5 }, input: {
        kind: 'reminder', message: '看邮件', schedule: { kind: 'once', timezone: 'UTC', runAt: '2026-10-28T10:00:00Z' },
        repeatEverySeconds: 300, relatedBusinessTaskId: null, channel: 'desktop',
      }, proposalId: null } }
    }
    if (pathname.startsWith('/companion/v1/reminders')) return { status: 200, body: { cycles: [cycle] } }
    if (pathname.includes('/respond')) return { status: 202, body: { task: { ...view, taskId: 'task-2', kind: 'reminder', revision: 6 } } }
    return { status: 404, body: { code: 'NOT_FOUND', message: '未实现' } }
  }
  const result = await call(COMPANION_TASK_CHANNELS.respond, {
    taskId: 'task-2', cycleId: 'cycle-1', action: 'snooze', snoozedUntil: new Date(Date.now() + 600_000).toISOString(),
  }, win.webContents) as { ok: boolean }
  assert.equal(result.ok, true)
  const posted = requests.find(item => item.pathname.includes('/respond'))!
  const body = posted.body as { taskId: string; expectedRevision: number; payload: { expectedCycleRevision: number; action: string } }
  assert.equal(body.taskId, 'task-2')
  assert.equal(body.expectedRevision, 5)
  assert.equal(body.payload.expectedCycleRevision, 3)
  assert.equal(body.payload.action, 'snooze')
  handle.dispose()
})

test('读取默认间隔，单条修改绑定确切修订并不重复打开审批', async () => {
  const handle = mount()
  const win = open(handle)
  reply = (_method, pathname) => {
    if (pathname === '/companion/v1/reminder-defaults') return { status: 200, body: { repeatEverySeconds: 420 } }
    if (pathname === '/companion/v1/tasks/task-1') return { status: 200, body: { task: { ...view, kind: 'reminder' }, input: {
      kind: 'reminder', message: '喝水', schedule: { kind: 'daily', timezone: 'UTC', localTime: '10:00' },
      repeatEverySeconds: 300, relatedBusinessTaskId: null, channel: 'wecom', recipientId: 'wecom:single:u1',
    }, proposalId: null } }
    return { status: 202, body: { task: { ...view, kind: 'reminder', revision: 3 }, proposalId: '已消费提案', requiresApproval: false } }
  }
  const defaults = await call(COMPANION_TASK_CHANNELS.defaults, undefined, win.webContents) as { data: { repeatEverySeconds: number } }
  assert.equal(defaults.data.repeatEverySeconds, 420)
  const result = await call(COMPANION_TASK_CHANNELS.setInterval, { taskId: 'task-1', repeatEverySeconds: 120 }, win.webContents) as { ok: boolean; approvalWindow?: unknown }
  assert.equal(result.ok, true)
  assert.equal(result.approvalWindow, undefined)
  const posted = requests.find(item => item.pathname.endsWith('/set-interval'))!
  assert.equal(posted.subject, 'owner')
  assert.deepEqual((posted.body as { payload: unknown }).payload, { repeatEverySeconds: 120 })
  assert.equal((posted.body as { expectedRevision: number }).expectedRevision, 2)
  handle.dispose()
})

test('取消间隔修改不提交，提醒时间接受服务端毫秒时间戳', async () => {
  const { parseCycle } = await import('../src/companion-types.ts')
  assert.equal(parseCycle({ ...cycle, nextNagAt: Date.parse(cycle.nextNagAt) }).nextNagAt, cycle.nextNagAt)
  const handle = mount()
  const win = open(handle)
  reply = () => ({ status: 200, body: { task: { ...view, kind: 'reminder' }, input: {
    kind: 'reminder', message: '喝水', schedule: { kind: 'daily', timezone: 'UTC', localTime: '10:00' },
    repeatEverySeconds: 300, relatedBusinessTaskId: null, channel: 'desktop',
  }, proposalId: null } })
  decision = false
  const result = await call(COMPANION_TASK_CHANNELS.setInterval, { taskId: 'task-1', repeatEverySeconds: 120 }, win.webContents) as { ok: boolean; code: string }
  assert.equal(result.code, 'cancelled')
  assert.equal(requests.some(item => item.subject === 'owner'), false)
  handle.dispose()
})
