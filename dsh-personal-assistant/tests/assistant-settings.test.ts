import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test, type TestContext } from 'node:test'
import { AssistantSettings, type AssistantSettingsOptions } from '../src/assistant-settings.ts'

const root = '/companion/v1/settings'
const oldCipher = Buffer.from('旧模拟密文，不是真实凭据').toString('base64')
const newCipher = Buffer.from('新模拟密文，不是真实凭据').toString('base64')
const secret = '仅测试-绝不能回显-密钥-123'
const defaultAgent = { name: '小潘', persona: '', provider: '', model: '', maxTokens: 4096, tokenBudget: 0 }

function fixture(t: TestContext, configured = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-assistant-settings-'))
  const dir = path.join(home, 'personal-assistant')
  const state = { reconnects: 0, encryptions: 0, connected: false,
    model: null as { provider: string; model: string } | null,
    channels: { allowedUserIds: ['测试用户'], deliverHere: ['测试会话'] } }
  if (configured) {
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'wecom.json'), JSON.stringify({ enabled: true, botId: 'bot-old' }))
    fs.writeFileSync(path.join(dir, 'wecom.secret'), `${oldCipher}\n`)
  }
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const options: AssistantSettingsOptions = {
    home, defaultModel: () => state.model, connected: () => state.connected, channelSettings: () => state.channels,
    reconnect: async () => { state.reconnects++ },
    encrypt: async () => { state.encryptions++; return newCipher },
  }
  const service = new AssistantSettings(options)
  const post = (endpoint: string, body: unknown) => service.request('POST', `${root}/${endpoint}`, body)
  const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8')
  return { home, dir, state, options, service, post, read, restart: () => new AssistantSettings(options) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function errorCode(result: { status: number; body: unknown }, status: number, code?: string) {
  assert.equal(result.status, status)
  const body = result.body as { code: string; message: string }
  assert.deepEqual(Object.keys(body).sort(), ['code', 'message'])
  if (code) assert.equal(body.code, code)
  assert.equal(typeof body.message, 'string')
  assert.equal(JSON.stringify(result).includes(secret), false)
}

function files(dir: string): Record<string, string> {
  if (!fs.existsSync(dir)) return {}
  return Object.fromEntries(fs.readdirSync(dir).map(name => [name, fs.readFileSync(path.join(dir, name), 'hex')]))
}

function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform })
  return run().finally(() => Object.defineProperty(process, 'platform', descriptor))
}

test('不存在文件使用约定默认值，读取不创建文件，快照与运行时状态均为副本', async t => {
  const f = fixture(t)
  assert.deepEqual(f.service.snapshot(), {
    revision: 0, wecom: { enabled: false, botId: '', secretConfigured: false, connected: false,
      allowedUserIds: ['测试用户'], deliverHere: ['测试会话'] },
    reminder: { repeatEverySeconds: 300 }, agent: defaultAgent, defaultModel: null,
  })
  assert.deepEqual(await f.service.request('GET', root, undefined), { status: 200, body: f.service.snapshot() })
  assert.equal(fs.existsSync(f.dir), false)
  f.state.model = { provider: '供应商', model: '默认模型' }
  f.state.connected = true
  const view = f.service.snapshot()
  view.agent.name = '被修改'
  view.reminder.repeatEverySeconds = 99
  view.wecom.allowedUserIds.push('伪造用户')
  view.defaultModel!.model = '被修改'
  f.service.getAgent().name = '另一个修改'
  assert.deepEqual(f.service.getAgent(), defaultAgent)
  assert.equal(f.service.getReminderInterval(), 300)
  assert.equal(f.service.snapshot().defaultModel?.model, '默认模型')
  assert.deepEqual(f.service.snapshot().wecom.allowedUserIds, ['测试用户'])
  assert.equal(f.service.snapshot().wecom.connected, true)
})

test('首次关闭允许空凭据；开启必须有完整机器人凭据，校验失败前不写磁盘', async t => {
  const f = fixture(t)
  for (const body of [
    { enabled: true, botId: '' }, { enabled: true, botId: 'bot' },
    { enabled: true, botId: '', secret }, { enabled: false, botId: '', secret },
  ]) errorCode(await f.post('wecom', { expectedRevision: 0, ...body }), 422, 'CREDENTIALS_REQUIRED')
  assert.equal(fs.existsSync(f.dir), false)
  assert.equal(f.state.encryptions, 0)
  const saved = await f.post('wecom', { expectedRevision: 0, enabled: false, botId: '' })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body, f.service.snapshot())
  assert.equal(f.service.snapshot().revision, 1)
  assert.equal(f.service.snapshot().wecom.secretConfigured, false)
  assert.equal(fs.existsSync(path.join(f.dir, 'wecom.secret')), false)
  assert.equal(f.state.reconnects, 1)
})

test('新凭据只保存模拟密文，不进入响应、非凭据文件或日志，兼容原配置格式', async t => {
  const f = fixture(t)
  const logs = [t.mock.method(console, 'log', () => {}), t.mock.method(console, 'warn', () => {}), t.mock.method(console, 'error', () => {})]
  let received = ''
  f.options.encrypt = async value => { received = value; return newCipher }
  const saved = await f.post('wecom', { expectedRevision: 0, enabled: true, botId: ' bot-new ', secret })
  assert.equal(saved.status, 200)
  assert.equal(received, secret)
  assert.deepEqual(saved.body, f.service.snapshot())
  assert.deepEqual(JSON.parse(f.read('wecom.json')), { enabled: true, botId: 'bot-new' })
  assert.equal(f.read('wecom.secret'), `${newCipher}\n`)
  for (const name of ['wecom.json', 'assistant-settings.json', 'wecom.secret']) assert.equal(f.read(name).includes(secret), false)
  assert.equal(f.read('assistant-settings.json').includes('secret'), false)
  assert.equal(JSON.stringify(saved).includes(secret), false)
  assert.equal(JSON.stringify(saved).includes(newCipher), false)
  assert.deepEqual(f.restart().snapshot(), f.service.snapshot())
  assert.deepEqual(fs.readdirSync(f.dir).sort(), ['assistant-settings.json', 'wecom.json', 'wecom.secret'])
  for (const log of logs) assert.equal(log.mock.callCount(), 0)
})

test('省略或留空密钥都保留旧密文；禁用再启用不加密、不读取旧密钥内容', async t => {
  const f = fixture(t, true)
  const originalRead = fs.readFileSync
  const read = t.mock.method(fs, 'readFileSync', ((...args: Parameters<typeof fs.readFileSync>) => {
    assert.equal(String(args[0]).endsWith('wecom.secret'), false, '服务不得读取密文内容')
    return Reflect.apply(originalRead, fs, args)
  }) as typeof fs.readFileSync)
  syncBuiltinESMExports()
  try {
    const loaded = f.restart()
    assert.equal(loaded.snapshot().wecom.secretConfigured, true)
    for (const [index, credentials] of [{}, { secret: '' }, {}].entries()) {
      const result = await f.post('wecom', { expectedRevision: index, enabled: index !== 1, botId: 'bot-old', ...credentials })
      assert.equal(result.status, 200)
    }
  } finally { read.mock.restore(); syncBuiltinESMExports() }
  assert.equal(f.read('wecom.secret'), `${oldCipher}\n`)
  assert.equal(f.state.encryptions, 0)
  assert.equal(f.state.reconnects, 3)
  assert.equal(f.service.snapshot().wecom.enabled, true)
})

test('已配置密钥时更换或清空机器人标识必须同时提交新密钥', async t => {
  const f = fixture(t, true)
  const before = files(f.dir)
  for (const enabled of [true, false]) for (const botId of ['bot-new', '']) for (const credentials of [{}, { secret: '' }]) {
    errorCode(await f.post('wecom', { expectedRevision: 0, enabled, botId, ...credentials }), 422, 'SECRET_REQUIRED')
    assert.deepEqual(files(f.dir), before)
  }
  const saved = await f.post('wecom', { expectedRevision: 0, enabled: true, botId: 'bot-new', secret })
  assert.equal(saved.status, 200)
  assert.equal(f.read('wecom.secret'), `${newCipher}\n`)
  assert.equal(f.service.snapshot().wecom.botId, 'bot-new')
})

test('所有设置共享持久化版本；提醒与独立代理设置不重连、不改渠道文件', async t => {
  const f = fixture(t, true)
  const oldConfig = f.read('wecom.json'), oldSecret = f.read('wecom.secret')
  assert.equal((await f.post('reminders', { expectedRevision: 0, repeatEverySeconds: 120 })).status, 200)
  errorCode(await f.post('agent', { expectedRevision: 0, ...defaultAgent }), 409, 'STALE_REVISION')
  const agent = { name: '独立助理', persona: '仅处理企业微信消息', provider: '供应商', model: '模型', maxTokens: 32768, tokenBudget: 10_000_000 }
  const saved = await f.post('agent', { expectedRevision: 1, ...agent })
  assert.equal(saved.status, 200)
  assert.deepEqual(f.service.getAgent(), agent)
  assert.equal(f.service.getReminderInterval(), 120)
  assert.equal(f.state.reconnects, 0)
  assert.equal(f.read('wecom.json'), oldConfig)
  assert.equal(f.read('wecom.secret'), oldSecret)
  const restarted = f.restart()
  assert.deepEqual(restarted.snapshot(), f.service.snapshot())
  errorCode(await restarted.request('POST', `${root}/reminders`, { expectedRevision: 1, repeatEverySeconds: 300 }), 409)
  assert.equal((await f.post('agent', { expectedRevision: 2, ...defaultAgent, maxTokens: 1, tokenBudget: 1 })).status, 200)
  for (const repeatEverySeconds of [60, 604800]) {
    assert.equal((await f.post('reminders', { expectedRevision: f.service.snapshot().revision, repeatEverySeconds })).status, 200)
  }
})

test('加密和重连等待期间全局忙锁拒绝其他写请求；读取只看到已提交快照', async t => {
  const f = fixture(t, true)
  const encryption = deferred<string>(), connection = deferred<void>(), started = deferred<void>()
  f.options.encrypt = () => encryption.promise
  f.options.reconnect = async () => { started.resolve(); await connection.promise }
  const saving = f.post('wecom', { expectedRevision: 0, enabled: true, botId: 'bot-new', secret })
  assert.equal(f.service.snapshot().revision, 0)
  assert.equal(f.read('wecom.secret'), `${oldCipher}\n`)
  errorCode(await f.post('reminders', { expectedRevision: 0, repeatEverySeconds: 60 }), 409, 'SETTINGS_BUSY')
  errorCode(await f.post('wecom/reconnect', { expectedRevision: 0 }), 409, 'SETTINGS_BUSY')
  encryption.resolve(newCipher)
  await started.promise
  assert.equal(f.service.snapshot().revision, 1)
  assert.equal(f.service.snapshot().wecom.botId, 'bot-new')
  errorCode(await f.post('agent', { expectedRevision: 1, ...defaultAgent }), 409, 'SETTINGS_BUSY')
  assert.equal((await f.service.request('GET', root, null)).status, 200)
  connection.resolve()
  assert.equal((await saving).status, 200)
  errorCode(await f.post('reminders', { expectedRevision: 0, repeatEverySeconds: 60 }), 409, 'STALE_REVISION')
  assert.equal((await f.post('reminders', { expectedRevision: 1, repeatEverySeconds: 60 })).status, 200)
})

test('同时提交相同版本最多一个成功，不会排队覆盖较新设置', async t => {
  const f = fixture(t)
  const results = await Promise.all([60, 120, 180].map(repeatEverySeconds => f.post('reminders', { expectedRevision: 0, repeatEverySeconds })))
  assert.deepEqual(results.map(result => result.status), [200, 409, 409])
  assert.equal(f.service.getReminderInterval(), 60)
  assert.equal(f.service.snapshot().revision, 1)
})

test('保存后重连失败仍返回已保存快照和固定提示；连接状态实时查询且错误不回显', async t => {
  const f = fixture(t, true)
  f.options.reconnect = async () => { throw new Error(secret) }
  const result = await f.post('wecom', { expectedRevision: 0, enabled: true, botId: 'bot-new', secret })
  assert.equal(result.status, 200)
  const body = result.body as ReturnType<AssistantSettings['snapshot']> & { message: string }
  assert.match(body.message, /已保存.*重连失败/)
  assert.equal(body.revision, 1)
  assert.equal(body.wecom.connected, false)
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(f.restart().snapshot().wecom.botId, 'bot-new')
  f.state.connected = true
  const get = await f.service.request('GET', root, undefined)
  assert.equal((get.body as ReturnType<AssistantSettings['snapshot']>).wecom.connected, true)
  const reconnect = await f.post('wecom/reconnect', { expectedRevision: 1 })
  assert.equal(reconnect.status, 200)
  assert.equal(f.service.snapshot().revision, 2)
  assert.equal(f.restart().snapshot().revision, 2)
  errorCode(await f.post('wecom/reconnect', { expectedRevision: 1 }), 409)
})

test('独立重连接口只推进全局版本，等待回调完成，不重写凭据', async t => {
  const f = fixture(t, true)
  const before = { config: f.read('wecom.json'), secret: f.read('wecom.secret') }
  const result = await f.post('wecom/reconnect', { expectedRevision: 0 })
  assert.deepEqual(result, { status: 200, body: f.service.snapshot() })
  assert.equal(f.state.reconnects, 1)
  assert.equal(f.state.encryptions, 0)
  assert.deepEqual({ config: f.read('wecom.json'), secret: f.read('wecom.secret') }, before)
})

test('所有端点严格拒绝未知字段、错误类型、越界数值、非配对模型以及超长字符串', async t => {
  const f = fixture(t)
  const invalidRequests: Array<[string, unknown]> = [
    ['wecom', null], ['wecom', []], ['wecom', '错误正文'],
    ['wecom', { expectedRevision: 0, enabled: 'true', botId: 'bot' }],
    ['wecom', { expectedRevision: 0, enabled: true, botId: 3, secret }],
    ['wecom', { expectedRevision: 0, enabled: false, botId: '', secret: null }],
    ['wecom', { expectedRevision: 0, enabled: false, botId: '', secret: 'x'.repeat(4097) }],
    ['wecom', { expectedRevision: 0, enabled: false, botId: 'x'.repeat(201) }],
    ['wecom', { expectedRevision: 0, enabled: false, botId: '', allowedUserIds: [] }],
    ['wecom/reconnect', { expectedRevision: 0, secret }],
    ['agent', { expectedRevision: 0, ...defaultAgent, provider: '只有供应商' }],
    ['agent', { expectedRevision: 0, ...defaultAgent, model: '只有模型' }],
    ['agent', { expectedRevision: 0, ...defaultAgent, provider: ' ', model: '模型' }],
    ['agent', { expectedRevision: 0, ...defaultAgent, name: ' ' }],
    ['agent', { expectedRevision: 0, ...defaultAgent, name: 'x'.repeat(81) }],
    ['agent', { expectedRevision: 0, ...defaultAgent, persona: 'x'.repeat(8001) }],
    ['agent', { expectedRevision: 0, ...defaultAgent, provider: 'x'.repeat(129), model: '模型' }],
    ['agent', { expectedRevision: 0, ...defaultAgent, provider: '供应商', model: 'x'.repeat(257) }],
    ['agent', { expectedRevision: 0, ...defaultAgent, secret }],
    ['agent', { expectedRevision: 0, name: '缺少其他字段' }],
    ['reminders', { expectedRevision: 0, repeatEverySeconds: 60, extra: secret }],
  ]
  for (const expectedRevision of [undefined, null, '0', -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    invalidRequests.push(['wecom/reconnect', { expectedRevision }])
  }
  for (const repeatEverySeconds of [undefined, null, '60', 59, 604801, 60.5, NaN, Infinity]) {
    invalidRequests.push(['reminders', { expectedRevision: 0, repeatEverySeconds }])
  }
  for (const maxTokens of [0, 32769, 1.5, '4096', NaN]) invalidRequests.push(['agent', { expectedRevision: 0, ...defaultAgent, maxTokens }])
  for (const tokenBudget of [-1, 0.5, 10_000_001, '0', Infinity]) invalidRequests.push(['agent', { expectedRevision: 0, ...defaultAgent, tokenBudget }])
  for (const [endpoint, body] of invalidRequests) errorCode(await f.post(endpoint, body), 400, 'INVALID_INPUT')
  for (const [method, pathname, body] of [
    ['DELETE', root, undefined], ['POST', root, {}], ['GET', `${root}/agent`, undefined],
    ['GET', root, { secret }], ['GET', `${root}?extra=1`, undefined], ['POST', `${root}/unknown`, {}],
  ] as const) errorCode(await f.service.request(method, pathname, body), 400, 'INVALID_INPUT')
  assert.equal(fs.existsSync(f.dir), false)
  assert.equal(f.state.encryptions, 0)
  assert.equal(f.state.reconnects, 0)
})

test('加密拒绝、抛错、无效密文或明文回传均不破坏旧配置且释放忙锁', async t => {
  const f = fixture(t, true)
  const before = files(f.dir)
  const encryptors = [async () => { throw new Error(secret) }, async () => '', async () => '不是密文', async () => secret]
  for (const encrypt of encryptors) {
    f.options.encrypt = encrypt
    errorCode(await f.post('wecom', { expectedRevision: 0, enabled: true, botId: 'bot-new', secret }), 503, 'ENCRYPTION_FAILED')
    assert.deepEqual(files(f.dir), before)
    assert.equal(f.service.snapshot().revision, 0)
  }
  f.options.encrypt = async () => newCipher
  assert.equal((await f.post('wecom', { expectedRevision: 0, enabled: true, botId: 'bot-new', secret })).status, 200)
})

test('已有损坏配置、空文件、未知字段和不完整凭据均禁止静默覆盖', async t => {
  for (const [name, contents] of [
    ['assistant-settings.json', '{损坏'], ['assistant-settings.json', ''],
    ['assistant-settings.json', JSON.stringify({ revision: 0, reminder: { repeatEverySeconds: 1 }, agent: defaultAgent })],
    ['assistant-settings.json', JSON.stringify({ revision: 0, reminder: { repeatEverySeconds: 300 }, agent: defaultAgent, secret })],
    ['wecom.json', '{损坏'], ['wecom.json', JSON.stringify({ enabled: 'true', botId: 'bot-old' })],
    ['wecom.secret', ''],
  ]) {
    const f = fixture(t, true)
    fs.writeFileSync(path.join(f.dir, name), contents)
    const before = files(f.dir), service = f.restart()
    errorCode(await service.request('GET', root, undefined), 503, 'SETTINGS_UNAVAILABLE')
    errorCode(await service.request('POST', `${root}/wecom`, { expectedRevision: 0, enabled: false, botId: 'bot-new', secret }), 503)
    assert.throws(() => service.getAgent(), /设置文件/)
    assert.deepEqual(files(f.dir), before)
  }
  const f = fixture(t, true)
  fs.unlinkSync(path.join(f.dir, 'wecom.secret'))
  errorCode(await f.restart().request('GET', root, undefined), 503)
})

test('加载后配置损坏或被其他设置实例更新，提交前重验防止覆盖', async t => {
  const f = fixture(t)
  const other = f.restart()
  assert.equal((await other.request('POST', `${root}/reminders`, { expectedRevision: 0, repeatEverySeconds: 120 })).status, 200)
  errorCode(await f.post('agent', { expectedRevision: 0, ...defaultAgent }), 409, 'STALE_REVISION')
  assert.equal(f.service.getReminderInterval(), 120)
  fs.writeFileSync(path.join(f.dir, 'assistant-settings.json'), `损坏-${secret}`)
  errorCode(await f.post('agent', { expectedRevision: 1, ...defaultAgent }), 503)
  assert.equal(f.read('assistant-settings.json'), `损坏-${secret}`)
})

test('加密等待期间其他实例已提交时拒绝旧提交，不覆盖较新设置', async t => {
  const f = fixture(t, true)
  const encryption = deferred<string>()
  f.options.encrypt = () => encryption.promise
  const pending = f.post('wecom', { expectedRevision: 0, enabled: true, botId: 'bot-new', secret })
  const other = f.restart()
  assert.equal((await other.request('POST', `${root}/reminders`, { expectedRevision: 0, repeatEverySeconds: 600 })).status, 200)
  encryption.resolve(newCipher)
  errorCode(await pending, 409, 'STALE_REVISION')
  assert.equal(f.service.getReminderInterval(), 600)
  assert.equal(f.read('wecom.secret'), `${oldCipher}\n`)
})

test('每个凭据提交阶段故障均回滚原始文件；切换密文时渠道配置始终关闭', async t => {
  for (const failAt of ['secret.next', 'settings.next', 'wecom.next', 'committed.json']) {
    const f = fixture(t, true)
    assert.equal((await f.post('reminders', { expectedRevision: 0, repeatEverySeconds: 120 })).status, 200)
    const before = files(f.dir), originalRename = fs.renameSync
    let failed = false
    const rename = t.mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
      if (String(source).endsWith('secret.next')) assert.equal(JSON.parse(f.read('wecom.json')).enabled, false)
      if (!failed && (String(source).endsWith(failAt) || String(target).endsWith(failAt))) {
        failed = true
        throw new Error(secret)
      }
      return originalRename(source, target)
    })
    syncBuiltinESMExports()
    try {
      errorCode(await f.post('wecom', { expectedRevision: 1, enabled: true, botId: 'bot-new', secret }), 503, 'SAVE_FAILED')
    } finally { rename.mock.restore(); syncBuiltinESMExports() }
    assert.equal(failed, true)
    assert.deepEqual(files(f.dir), before)
    assert.equal(f.service.snapshot().revision, 1)
    assert.equal(f.state.reconnects, 0)
    assert.deepEqual(f.restart().snapshot(), f.service.snapshot())
  }
})

test('首次配置中途失败删除未提交凭据，不遗留新旧组合', async t => {
  const f = fixture(t)
  const originalRename = fs.renameSync
  const rename = t.mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
    if (String(source).endsWith('wecom.next')) throw new Error(secret)
    return originalRename(source, target)
  })
  syncBuiltinESMExports()
  try {
    errorCode(await f.post('wecom', { expectedRevision: 0, enabled: true, botId: 'bot-new', secret }), 503)
  } finally { rename.mock.restore(); syncBuiltinESMExports() }
  assert.deepEqual(files(f.dir), {})
  assert.equal(f.restart().snapshot().wecom.secretConfigured, false)
})

test('提交和即时回滚均中断时拒绝后续请求，重启依据暂存备份恢复完整旧配置', async t => {
  const f = fixture(t, true)
  const before = files(f.dir), originalRename = fs.renameSync
  let interrupted = false
  const rename = t.mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
    if (String(source).endsWith('wecom.next')) { interrupted = true; throw new Error(secret) }
    if (interrupted) throw new Error(secret)
    return originalRename(source, target)
  })
  syncBuiltinESMExports()
  try {
    errorCode(await f.post('wecom', { expectedRevision: 0, enabled: true, botId: 'bot-new', secret }), 503)
    errorCode(await f.service.request('GET', root, undefined), 503)
    assert.equal(JSON.parse(f.read('wecom.json')).enabled, false)
    assert.equal(fs.existsSync(path.join(f.dir, '.assistant-settings-transaction', 'ready.json')), true)
  } finally { rename.mock.restore(); syncBuiltinESMExports() }
  const restarted = f.restart()
  assert.equal(restarted.snapshot().wecom.botId, 'bot-old')
  assert.equal(restarted.snapshot().revision, 0)
  assert.deepEqual(files(f.dir), before)
})

test('已提交事务清理失败仍返回成功，重启只清理暂存而不回滚成功配置', async t => {
  const f = fixture(t, true)
  const originalRemove = fs.rmSync
  const remove = t.mock.method(fs, 'rmSync', (file: fs.PathLike, options?: fs.RmOptions) => {
    if (String(file).endsWith('.assistant-settings-transaction')) throw new Error(secret)
    return originalRemove(file, options)
  })
  syncBuiltinESMExports()
  try {
    assert.equal((await f.post('wecom', { expectedRevision: 0, enabled: true, botId: 'bot-new', secret })).status, 200)
  } finally { remove.mock.restore(); syncBuiltinESMExports() }
  assert.deepEqual(f.restart().snapshot(), f.service.snapshot())
  assert.equal(f.read('wecom.secret'), `${newCipher}\n`)
  assert.equal(fs.existsSync(path.join(f.dir, '.assistant-settings-transaction')), false)
})

test('非 Windows 默认拒绝凭据变更，不启动加密进程；普通设置和原凭据保留不受影响', async t => {
  const f = fixture(t, true)
  delete f.options.encrypt
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('不应启动进程') })
  syncBuiltinESMExports()
  try {
    await withPlatform('linux', async () => {
      errorCode(await f.post('wecom', { expectedRevision: 0, enabled: true, botId: 'bot-new', secret }), 503, 'CREDENTIALS_UNSUPPORTED')
      assert.equal(f.read('wecom.secret'), `${oldCipher}\n`)
      assert.equal((await f.post('wecom', { expectedRevision: 0, enabled: false, botId: 'bot-old', secret: '' })).status, 200)
      assert.equal((await f.post('reminders', { expectedRevision: 1, repeatEverySeconds: 120 })).status, 200)
    })
    assert.equal(spawn.mock.callCount(), 0)
  } finally { spawn.mock.restore(); syncBuiltinESMExports() }
})

test('Windows 加密使用固定 PowerShell 命令，秘密只走标准输入且错误不回显', async t => {
  const f = fixture(t)
  delete f.options.encrypt
  const commands: unknown[][] = [], inputs: string[] = []
  let shouldFail = false
  const spawn = t.mock.method(childProcess, 'spawn', ((...args: unknown[]) => {
    commands.push(args)
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
    let input = ''
    child.stdin.on('data', chunk => { input += String(chunk) })
    child.stdin.on('finish', () => {
      inputs.push(input)
      if (shouldFail) child.stderr.write(secret)
      else child.stdout.write(newCipher)
      child.stdout.end(); child.stderr.end()
      child.emit('close', shouldFail ? 1 : 0)
    })
    return child
  }) as unknown as typeof childProcess.spawn)
  syncBuiltinESMExports()
  try {
    await withPlatform('win32', async () => {
      assert.equal((await f.post('wecom', { expectedRevision: 0, enabled: true, botId: 'bot-new', secret })).status, 200)
      const before = files(f.dir)
      shouldFail = true
      errorCode(await f.post('wecom', { expectedRevision: 1, enabled: true, botId: 'bot-new', secret }), 503, 'ENCRYPTION_FAILED')
      assert.deepEqual(files(f.dir), before)
    })
    assert.deepEqual(inputs, [secret, secret])
    assert.deepEqual(commands[0], commands[1])
    assert.equal(commands[0]![0], 'powershell.exe')
    assert.equal(JSON.stringify(commands).includes(secret), false)
    assert.match(JSON.stringify(commands), /ReadToEnd/)
    assert.match(JSON.stringify(commands), /CurrentUser/)
  } finally { spawn.mock.restore(); syncBuiltinESMExports() }
})
