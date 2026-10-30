import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { AssistantSettingsResult, AssistantSettingsSnapshot } from '../src/assistant-settings-types.ts'
import { reminderMinutesToSeconds } from '../src/assistant-settings-types.ts'

const handlers = new Map<string, (...args: unknown[]) => Promise<AssistantSettingsResult>>()
let exposed: Record<string, (...args: unknown[]) => unknown> = {}
const invokes: unknown[][] = []
mock.module('electron', { namedExports: {
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<AssistantSettingsResult>) => handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name),
  },
  contextBridge: { exposeInMainWorld: (_name: string, api: typeof exposed) => { exposed = api } },
  ipcRenderer: { invoke: async (...args: unknown[]) => { invokes.push(args); return { ok: true } } },
} })
const { registerAssistantSettings, ASSISTANT_SETTINGS_CHANNELS } = await import('../src/main/assistant-settings.ts')
await import('../src/preload/index.ts')

const pagePath = 'D:/java/openCode2026/dsh-github/dsh-pet/dist/renderer/index.html'
const pageURL = pathToFileURL(pagePath).href
function snapshot(): AssistantSettingsSnapshot {
  return {
    revision: 7,
    wecom: { enabled: true, botId: 'bot-1', secretConfigured: true, connected: false, allowedUserIds: ['user-1'], deliverHere: ['chat-1'] },
    reminder: { repeatEverySeconds: 300 },
    agent: { name: '小潘', persona: '协助工作', provider: '', model: '', maxTokens: 2048, tokenBudget: 0 },
    defaultModel: { provider: 'host-provider', model: 'host-model' },
  }
}
function stage() {
  let url = pageURL
  const mainFrame = { url }
  return {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    webContents: { mainFrame, getURL: () => url },
    navigate(next: string) { url = next; mainFrame.url = next },
    contentsURL(next: string) { url = next },
  }
}
let win: ReturnType<typeof stage> | null
let requests: Array<{ method: string; pathname: string; body: unknown; subject: string }>
let response: { status: number; body: unknown }
let request: () => Promise<typeof response>
function mount() {
  return registerAssistantSettings({
    getStageWindow: () => win as never,
    pagePath,
    request: async (method, pathname, body, subject) => {
      requests.push({ method, pathname, body, subject })
      return request()
    },
  })
}
function event() { return { sender: win!.webContents, senderFrame: win!.webContents.mainFrame } }
function read(sender: unknown = event()) { return handlers.get(ASSISTANT_SETTINGS_CHANNELS.state)!(sender) }
function save(section: unknown, input: unknown, sender: unknown = event()) {
  return handlers.get(ASSISTANT_SETTINGS_CHANNELS.save)!(sender, section, input)
}
beforeEach(() => {
  handlers.clear()
  invokes.length = 0
  win = stage()
  requests = []
  response = { status: 200, body: snapshot() }
  request = async () => response
})

test('预加载只暴露固定配置方法及已有任务窗口入口', async () => {
  await exposed.assistantSettingsState!('https://invalid.example', '伪造凭据')
  await exposed.assistantSettingsSave!('reminders', { expectedRevision: 7, repeatEverySeconds: 60 })
  await exposed.openCompanionTasks!()
  assert.deepEqual(invokes, [
    ['assistant-settings-state'],
    ['assistant-settings-save', 'reminders', { expectedRevision: 7, repeatEverySeconds: 60 }],
    ['companion-tasks-open'],
  ])
  assert.equal(exposed.companionRequest, undefined)
})

test('读取固定路径走本机凭据，只返回无密钥的契约字段', async () => {
  mount()
  const state = snapshot()
  response.body = { ...state, ownerToken: '不可外传', wecom: { ...state.wecom, secret: '不可外传' }, message: '不可外传' }
  assert.deepEqual(await read(), { ok: true, state })
  assert.deepEqual(requests, [{ method: 'GET', pathname: '/companion/v1/settings', body: undefined, subject: 'owner' }])
})

test('四种写操作只访问对应固定路径并保留版本号', async () => {
  mount()
  const inputs = {
    wecom: { expectedRevision: 7, enabled: true, botId: 'bot-1', secret: '测试密钥' },
    reminders: { expectedRevision: 7, repeatEverySeconds: 60 },
    agent: { expectedRevision: 7, ...snapshot().agent },
    'wecom/reconnect': { expectedRevision: 7 },
  }
  for (const [section, input] of Object.entries(inputs)) {
    assert.equal((await save(section, input)).ok, true)
    assert.deepEqual(requests.at(-1), { method: 'POST', pathname: `/companion/v1/settings/${section}`, body: input, subject: 'owner' })
  }
})

test('密钥留空时省略，不把空字符串当清除密钥', async () => {
  mount()
  for (const secret of [undefined, '', '   ']) {
    assert.equal((await save('wecom', { expectedRevision: 7, enabled: false, botId: 'bot-1', secret })).ok, true)
    assert.deepEqual(requests.at(-1)?.body, { expectedRevision: 7, enabled: false, botId: 'bot-1' })
  }
})

test('非法分类、字段、版本和数值在请求前拒绝', async () => {
  mount()
  for (const section of ['https://invalid.example', '../agent', 'wecom/reconnect/extra', '__proto__', '', null, {}]) {
    assert.equal((await save(section, { expectedRevision: 7 })).error, 'invalid_section')
  }
  for (const [section, input] of [
    ['wecom', { expectedRevision: 7, enabled: true, botId: 'bot', allowedUserIds: ['越权'] }],
    ['wecom', { expectedRevision: 7, enabled: true, botId: 'bot', secret: {} }],
    ['wecom/reconnect', { expectedRevision: -1 }],
    ['wecom/reconnect', { expectedRevision: '7' }],
    ['wecom/reconnect', { expectedRevision: 1.1 }],
    ['reminders', { expectedRevision: 7, repeatEverySeconds: 59 }],
    ['reminders', { expectedRevision: 7, repeatEverySeconds: 604801 }],
    ['reminders', { expectedRevision: 7, repeatEverySeconds: 60.1 }],
    ['agent', { expectedRevision: 7, ...snapshot().agent, maxTokens: 0 }],
    ['agent', { expectedRevision: 7, ...snapshot().agent, tokenBudget: -1 }],
    ['agent', { expectedRevision: 7, ...snapshot().agent, tokenBudget: Infinity }],
    ['agent', { expectedRevision: 7, ...snapshot().agent, maxTokens: 32769 }],
    ['agent', { expectedRevision: 7, ...snapshot().agent, tokenBudget: 10_000_001 }],
    ['agent', { expectedRevision: 7, ...snapshot().agent, provider: '仅填服务商' }],
    ['agent', { expectedRevision: 7, ...snapshot().agent, name: ' ' }],
    ['agent', { expectedRevision: 7, ...snapshot().agent, persona: '长'.repeat(8001) }],
    ['wecom', { expectedRevision: 7, enabled: true, botId: 'bot', secret: '长'.repeat(4097) }],
    ['agent', null],
  ]) assert.equal((await save(section, input)).error, 'invalid_input')
  assert.equal(requests.length, 0)
})

test('拒绝其他窗口、子 frame、导航后的主 frame 和窗口缺失', async () => {
  mount()
  const other = stage()
  const original = event()
  for (const sender of [
    { sender: other.webContents, senderFrame: other.webContents.mainFrame },
    { ...original, senderFrame: { url: pageURL } },
    { ...original, senderFrame: null },
  ]) {
    assert.equal((await read(sender)).error, 'denied')
    assert.equal((await save('wecom/reconnect', { expectedRevision: 7 }, sender)).error, 'denied')
  }
  for (const url of ['https://invalid.example/index.html', 'about:blank', pageURL.replace('/index.html', '/other.html'), `${pageURL}?source=other`, `${pageURL}#other`, pageURL.replace('file:///', 'file://remote/')]) {
    win!.navigate(url)
    assert.equal((await read()).error, 'denied')
    assert.equal((await save('wecom/reconnect', { expectedRevision: 7 })).error, 'denied')
  }
  win!.navigate(pageURL)
  win!.contentsURL('https://invalid.example')
  assert.equal((await read()).error, 'denied')
  win!.navigate(pageURL)
  win!.destroyed = true
  assert.equal((await read()).error, 'denied')
  win = null
  assert.equal((await read(original)).error, 'denied')
  assert.equal(requests.length, 0)
})

test('请求等待时页面导航或窗口被替换，不向旧调用方返回配置', async () => {
  mount()
  let resolve!: (value: typeof response) => void
  request = () => new Promise(done => { resolve = done })
  const pending = read()
  win = stage()
  resolve(response)
  assert.equal((await pending).error, 'denied')
  const next = read()
  win.navigate('https://invalid.example')
  resolve(response)
  assert.equal((await next).error, 'denied')
})

test('版本冲突、网络异常、服务错误和坏回包均不回显输入或异常', async () => {
  mount()
  const secret = '不应出现的测试密钥'
  for (const status of [0, 400, 401, 403, 404, 409, 500, 503]) {
    response = { status, body: { error: secret, message: secret, input: { secret } } }
    const result = await save('wecom', { expectedRevision: 7, enabled: true, botId: 'bot', secret })
    assert.equal(result.ok, false)
    assert.ok(!JSON.stringify(result).includes(secret))
    if (status === 409) { assert.equal(result.error, 'conflict'); assert.match(result.message!, /刷新/) }
  }
  request = async () => { throw new Error(secret) }
  assert.ok(!JSON.stringify(await save('wecom/reconnect', { expectedRevision: 7 })).includes(secret))
  request = async () => ({ status: 200, body: { ...snapshot(), agent: { secret } } })
  assert.equal((await read()).error, 'invalid_response')
  request = async () => ({ status: 200, body: { ok: false, message: secret, state: snapshot() } })
  assert.ok(!JSON.stringify(await read()).includes(secret))
})

test('保存期间拒绝重复写入，完成后释放；注销后删除两条通道', async () => {
  const dispose = mount()
  let resolve!: (value: typeof response) => void
  request = () => new Promise(done => { resolve = done })
  const first = save('wecom/reconnect', { expectedRevision: 7 })
  assert.equal((await save('reminders', { expectedRevision: 7, repeatEverySeconds: 60 })).error, 'busy')
  assert.equal(requests.length, 1)
  resolve(response)
  assert.equal((await first).ok, true)
  request = async () => response
  assert.equal((await save('reminders', { expectedRevision: 7, repeatEverySeconds: 60 })).ok, true)
  const stale = handlers.get(ASSISTANT_SETTINGS_CHANNELS.state)!
  dispose()
  assert.equal(handlers.size, 0)
  assert.equal((await stale(event())).error, 'denied')
})

test('分钟边界及小数换算只接受整数秒', () => {
  for (const [input, expected] of [['1', 60], ['10080', 604800], ['1.5', 90], ['1.1', 66], ['2.05', 123]] as const) {
    assert.equal(reminderMinutesToSeconds(input), expected)
  }
  for (const input of ['', ' ', '0', '-1', '0.99', '10080.1', '1.001', '不是数字', 'Infinity', 'NaN']) {
    assert.equal(reminderMinutesToSeconds(input), null)
  }
})
