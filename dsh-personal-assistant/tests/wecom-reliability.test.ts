import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { ChannelManager, type InboundChannelMessage } from '../src/channels.ts'
import { TeamStore } from '../src/team-domain.ts'

const clients: FakeClient[] = []
class FakeClient {
  readonly listeners = new Map<string, (...args: any[]) => void>()
  isConnected = true
  streamCalls: string[] = []
  streamRequestIds: unknown[] = []
  activeCalls: string[] = []
  failStream = false
  constructor(_options: unknown) { clients.push(this) }
  on(event: string, callback: (...args: any[]) => void) { this.listeners.set(event, callback); return this }
  connect() { this.listeners.get('authenticated')?.(); return this }
  disconnect() { this.isConnected = false }
  emit(event: string, frame: unknown) { this.listeners.get(event)?.(frame) }
  async replyStream(frame: unknown, _id: string, text: string) {
    this.streamCalls.push(text)
    this.streamRequestIds.push((frame as { headers?: { req_id?: unknown } }).headers?.req_id)
    if (this.failStream) throw new Error('模拟服务已收到后连接中断')
    return { errcode: 0 }
  }
  async sendMessage(_chatId: string, body: { markdown: { content: string } }) { this.activeCalls.push(body.markdown.content) }
  async replyWelcome() {}
}
mock.module('@wecom/aibot-node-sdk', { defaultExport: { WSClient: FakeClient }, namedExports: { generateReqId: () => 'test-stream' } })
const { createWeComAdapter } = await import('../src/wecom.ts')

test('企业微信流式回执未知时不转主动发送，停止后明确没有发送', async () => {
  let received: InboundChannelMessage | null = null
  const adapter = createWeComAdapter({ botId: '测试机器人', secret: 'fake-secret', log: () => {},
    onMessage: async message => { received = message } })
  await adapter.start()
  const client = clients.at(-1)!
  client.emit('message.text', { headers: { req_id: 'req-1' }, body: {
    msgid: 'msg-1', chattype: 'single', from: { userid: '主人' }, text: { content: '隔离测试' },
  } })
  assert.ok(received)
  const inbound = received as InboundChannelMessage & { accountId?: string }
  client.failStream = true
  await assert.rejects(inbound.reply('隔离回复'), error => (error as { outcome?: string }).outcome === 'unknown')
  assert.equal(inbound.accountId, '测试机器人', '消息必须绑定实际机器人')
  assert.deepEqual(client.streamCalls, ['隔离回复'])
  assert.deepEqual(client.activeCalls, [], '流式回复结果未知时不能另发主动消息')
  await adapter.stop()
  await assert.rejects(inbound.reply('不可发送'), error => (error as { outcome?: string }).outcome === 'not-sent')
  assert.deepEqual(client.activeCalls, [])
})

test('缺少原始回复请求标识时不盲目发送', async () => {
  let received: InboundChannelMessage | null = null
  const adapter = createWeComAdapter({ botId: '测试机器人', secret: 'fake-secret', log: () => {},
    onMessage: async message => { received = message } })
  await adapter.start()
  const client = clients.at(-1)!
  client.emit('message.text', { body: { msgid: 'msg-2', chattype: 'single', from: { userid: '主人' }, text: { content: '测试' } } })
  assert.ok(received)
  await assert.rejects((received as InboundChannelMessage).reply('不可发送'), error => (error as { outcome?: string }).outcome === 'not-sent')
  assert.deepEqual(client.streamCalls, [])
  assert.deepEqual(client.activeCalls, [])
  await adapter.stop()
})

test('连接停止后的迟到事件不能再次进入渠道', async () => {
  let count = 0
  const adapter = createWeComAdapter({ botId: '测试机器人', secret: 'fake-secret', log: () => {},
    onMessage: async () => { count++ } })
  await adapter.start()
  const client = clients.at(-1)!
  await adapter.stop()
  client.emit('message.text', { headers: { req_id: 'late' }, body: {
    msgid: 'late-1', chattype: 'single', from: { userid: '主人' }, text: { content: '不应处理' },
  } })
  assert.equal(count, 0)
})

test('排队期间原始事件被修改不会改变回复所绑定的请求标识', async () => {
  let received: InboundChannelMessage | null = null
  const adapter = createWeComAdapter({ botId: '测试机器人', secret: 'fake-secret', log: () => {},
    onMessage: async message => { received = message } })
  await adapter.start()
  const client = clients.at(-1)!
  const frame = { headers: { req_id: '原始请求' }, body: {
    msgid: 'frozen-reply', chattype: 'single', from: { userid: '主人' }, text: { content: '隔离测试' },
  } }
  client.emit('message.text', frame)
  assert.ok(received)
  frame.headers.req_id = '其他请求'
  await (received as InboundChannelMessage).reply('隔离回复')
  assert.deepEqual(client.streamRequestIds, ['原始请求'])
  await adapter.stop()
})

test('重启同一适配器后旧连接事件和回复不能借新连接继续发送', async () => {
  const received: InboundChannelMessage[] = []
  const adapter = createWeComAdapter({ botId: '测试机器人', secret: 'fake-secret', log: () => {},
    onMessage: async message => { received.push(message) } })
  await adapter.start()
  const old = clients.at(-1)!
  const frame = (msgid: string) => ({ headers: { req_id: `req-${msgid}` }, body: {
    msgid, chattype: 'single', from: { userid: '主人' }, text: { content: '隔离测试' },
  } })
  old.emit('message.text', frame('old'))
  assert.equal(received.length, 1)
  await adapter.stop()
  await adapter.start()
  const current = clients.at(-1)!
  assert.notEqual(current, old)
  old.emit('disconnected', {})
  assert.equal(adapter.connected(), true, '旧连接迟到断开不能改变新连接状态')
  old.emit('message.text', frame('late'))
  current.emit('message.text', frame('new'))
  assert.equal(received.length, 2, '只接收新连接消息')
  await assert.rejects(received[0].reply('旧回复'), error => (error as { outcome?: string }).outcome === 'not-sent')
  assert.deepEqual(current.streamCalls, [], '旧请求不能转到新连接')
  await adapter.stop()
})

test('真实渠道处理接假企微 SDK：回复结果未知后不重放也不主动发送', async () => {
  const store = new TeamStore(':memory:')
  let processed = 0
  const manager = new ChannelManager({ store, epoch: 'test-epoch', settingsFile: 'unused', log: () => {},
    readSettings: () => ({ allowedUserIds: ['主人'], deliverHere: [] }), writeSettings: () => {},
    host: { create: async () => { throw new Error('不应创建旧会话') }, waitForIdle: async () => {} },
    route: async () => { processed++; return '已处理' } })
  let finish!: () => void
  let done = new Promise<void>(resolve => { finish = resolve })
  const adapter = createWeComAdapter({ botId: '测试机器人', secret: 'fake-secret', log: () => {},
    onMessage: async message => { try { await manager.handle(message) } finally { finish() } } })
  try {
    await adapter.start()
    const client = clients.at(-1)!
    client.failStream = true
    const frame = { headers: { req_id: 'req-1' }, body: {
      msgid: 'same-message', chattype: 'single', from: { userid: '主人' }, text: { content: '隔离委托' },
    } }
    client.emit('message.text', frame)
    await done
    assert.equal(processed, 1)
    assert.deepEqual(client.streamCalls, ['已处理'])
    assert.deepEqual(client.activeCalls, [])
    const issue = manager.inboundAttention()[0]
    assert.equal(issue.state, 'unknown')
    assert.equal(issue.reply, 'unknown')
    done = new Promise<void>(resolve => { finish = resolve })
    client.emit('message.text', frame)
    await done
    assert.equal(processed, 1)
    assert.equal(client.streamCalls.length, 1)
    assert.deepEqual(client.activeCalls, [])
  } finally { await adapter.stop(); await manager.stop(); store.close() }
})
