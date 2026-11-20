import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
mock.module('electron', {
  namedExports: {
    ipcMain: {
      handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler),
      removeHandler: (name: string) => handlers.delete(name),
    },
  },
})

const pagePath = 'D:/java/openCode2026/dsh-github/dsh-pet/dist/renderer/index.html'
const pageURL = pathToFileURL(pagePath).href
const frame: { url: string } = { url: pageURL }
const webContents = { mainFrame: frame, getURL: () => pageURL }
const win = { isDestroyed: () => false, webContents }
const stageEvent = { sender: webContents, senderFrame: frame }

const { registerAssistantMail, ASSISTANT_MAIL_CHANNELS } = await import('../src/main/assistant-mail.ts')

const requests: Array<{ method: string; pathname: string; body: unknown }> = []
let responder: () => { status: number; body: unknown } = () => ({ status: 200, body: {} })
const dispose = registerAssistantMail({
  getStageWindow: () => win as never,
  pagePath,
  request: async (method, pathname, body) => {
    requests.push({ method, pathname, body })
    return responder()
  },
})
beforeEach(() => { requests.length = 0 })

const mailView = {
  address: 'me@example.com', smtpHost: 'smtp.example.com', smtpPort: 465,
  imapHost: 'imap.example.com', imapPort: 993, hasPassword: true, watchEnabled: true, watchIntervalSeconds: 600,
}

test('读取配置：成功投影八个字段，未配置回 null', async () => {
  responder = () => ({ status: 200, body: { ok: true, mail: mailView } })
  const result = await handlers.get(ASSISTANT_MAIL_CHANNELS.state)!(stageEvent) as Record<string, unknown>
  assert.equal(result.ok, true)
  assert.deepEqual(result.mail, mailView)
  assert.deepEqual(requests, [{ method: 'GET', pathname: '/companion/v1/settings/mail', body: undefined }])

  responder = () => ({ status: 200, body: { ok: true, mail: null } })
  const empty = await handlers.get(ASSISTANT_MAIL_CHANNELS.state)!(stageEvent) as Record<string, unknown>
  assert.equal(empty.ok, true)
  assert.equal(empty.mail, null)
})

test('保存配置：端口转数字、授权码原样上桥，回包不回显授权码', async () => {
  responder = () => ({ status: 200, body: { ok: true, mail: mailView } })
  const result = await handlers.get(ASSISTANT_MAIL_CHANNELS.save)!(stageEvent, {
    address: 'me@example.com', smtpHost: 'smtp.example.com', smtpPort: 465,
    imapHost: 'imap.example.com', imapPort: 993, password: '授权码-只写不读',
  }) as Record<string, unknown>
  assert.equal(result.ok, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.method, 'POST')
  assert.deepEqual(requests[0]!.body, {
    address: 'me@example.com', smtpHost: 'smtp.example.com', smtpPort: 465,
    imapHost: 'imap.example.com', imapPort: 993, password: '授权码-只写不读',
  })
  assert.equal(JSON.stringify(result).includes('授权码-只写不读'), false)

  // 不带密码：body 里没有 password 键，服务端据此沿用已存授权码。
  await handlers.get(ASSISTANT_MAIL_CHANNELS.save)!(stageEvent, {
    address: 'me@example.com', smtpHost: 'smtp.example.com', smtpPort: 587, imapHost: 'imap.example.com', imapPort: 993,
  })
  assert.equal('password' in (requests[1]!.body as Record<string, unknown>), false)
})

test('保存配置：服务端 422 的具体原因透传给用户，非法输入不发起请求', async () => {
  responder = () => ({ status: 422, body: { code: 'INVALID_INPUT', message: '邮箱地址格式不对，要像 name@example.com' } })
  const rejected = await handlers.get(ASSISTANT_MAIL_CHANNELS.save)!(stageEvent, {
    address: 'not-an-email', smtpHost: 'smtp.example.com', smtpPort: 465, imapHost: 'imap.example.com', imapPort: 993, password: 'x',
  }) as Record<string, unknown>
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error, 'invalid_input')
  assert.match(String(rejected.message), /邮箱地址格式不对/u)

  requests.length = 0
  const wrongPort = await handlers.get(ASSISTANT_MAIL_CHANNELS.save)!(stageEvent, {
    address: 'me@example.com', smtpHost: 'smtp.example.com', smtpPort: 70_000, imapHost: 'imap.example.com', imapPort: 993,
  }) as Record<string, unknown>
  assert.equal(wrongPort.ok, false)
  assert.equal(requests.length, 0, '本地先拒，不把明显非法数据送上桥')
})

test('值守列表：投影摘要与建议，缺省取 20 条', async () => {
  responder = () => ({ status: 200, body: { ok: true, analyses: [{
    analysisId: 'a1', memberId: 'member-mail', uids: [10, 11], result: '有两封待处理', createdAt: 100, notifiedAt: null,
    suggestions: [{ uid: 10, kind: 'reply-mail', title: '回复客户', payload: '正文', risk: 'low', rationale: '客户在等回复' },
      { uid: null, kind: 'manual-step', title: '人工核对', payload: '', risk: 'medium', rationale: '涉及金额' }],
    unknownField: '不该出现',
  }] } })
  const result = await handlers.get(ASSISTANT_MAIL_CHANNELS.analyses)!(stageEvent) as Record<string, unknown>
  assert.equal(result.ok, true)
  const analyses = result.analyses as Array<Record<string, unknown>>
  assert.equal(analyses.length, 1)
  assert.equal(analyses[0]!.analysisId, 'a1')
  assert.equal(analyses[0]!.notifiedAt, null)
  assert.equal((analyses[0]!.suggestions as Array<Record<string, unknown>>).length, 2)
  assert.equal((analyses[0]!.suggestions as Array<Record<string, unknown>>)[0]!.title, '回复客户')
  assert.equal('unknownField' in analyses[0]!, false)
  assert.match(requests[0]!.pathname, /limit=20$/u)
})

test('非舞台来源的请求一律拒绝', async () => {
  responder = () => ({ status: 200, body: { ok: true, mail: null } })
  const denied = await handlers.get(ASSISTANT_MAIL_CHANNELS.state)!({ sender: {}, senderFrame: {} }) as Record<string, unknown>
  assert.equal(denied.ok, false)
  assert.equal(denied.error, 'denied')
  assert.equal(requests.length, 0)
})

test('连接中断如实报未确认，不假装成功', async () => {
  const failing = registerAssistantMail({
    getStageWindow: () => win as never,
    pagePath,
    request: async () => { throw new Error('ECONNREFUSED') },
  })
  const result = await handlers.get(ASSISTANT_MAIL_CHANNELS.save)!(stageEvent, {
    address: 'me@example.com', smtpHost: 'smtp.example.com', smtpPort: 465, imapHost: 'imap.example.com', imapPort: 993, password: 'x',
  }) as Record<string, unknown>
  assert.equal(result.ok, false)
  assert.equal(result.error, 'unavailable')
  assert.match(String(result.message), /不会自动重发/u)
  failing()
})

test('注销后通道被移除', () => {
  dispose()
  assert.equal(handlers.has(ASSISTANT_MAIL_CHANNELS.state), false)
  assert.equal(handlers.has(ASSISTANT_MAIL_CHANNELS.save), false)
  assert.equal(handlers.has(ASSISTANT_MAIL_CHANNELS.analyses), false)
})