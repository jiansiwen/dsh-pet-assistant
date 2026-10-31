import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { ChannelManager, type ChannelAdapter, type ChannelSettings, type InboundChannelMessage } from '../src/channels.ts'
import { TeamStore } from '../src/team-domain.ts'

type Ev = { type: string; data?: Record<string, unknown> }

function fakeAgent(events: Ev[], reply: string) {
  let turn = 0
  return {
    status: 'idle',
    session: { events },
    followup(message: unknown) {
      const msg = message as { id: string; content: unknown; source: unknown }
      turn += 1
      events.push({ type: 'turn/start', data: { turn } })
      events.push({ type: 'user/message', data: { id: msg.id, role: 'user', content: msg.content, source: msg.source } })
      events.push({ type: 'assistant/message', data: { turn, step: 1, message: { id: `a-${turn}`, content: [{ type: 'text', text: reply }] } } })
      events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
      ;(this as { status: string }).status = 'idle'
    },
  }
}

function fixture(t: TestContext, initial: ChannelSettings = { allowedUserIds: ['u1'], deliverHere: [] }) {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  let settings = { ...initial }
  const sent: Array<{ chatId: string; text: string }> = []
  const adapter: ChannelAdapter = {
    name: 'wecom',
    async start() {},
    async stop() {},
    async sendTo(chatId, text) { sent.push({ chatId, text }) },
  }
  const agents: ReturnType<typeof fakeAgent>[] = []
  const manager = new ChannelManager({
    store,
    host: {
      async create() {
        const agent = fakeAgent([], '好的，我记下了。')
        agents.push(agent)
        return { agent: agent as never, dispose: async () => { (agent as { status: string }).status = 'closed' } }
      },
      async waitForIdle() {},
    },
    settingsFile: 'unused',
    readSettings: () => settings,
    writeSettings: next => { settings = next },
    log: () => undefined,
    now: () => Date.parse('2026-10-28T00:00:00Z'),
  })
  manager.register(adapter)
  t.after(() => manager.stop())
  return { manager, store, sent, settings: () => settings, agents }
}

function inbound(partial: Partial<InboundChannelMessage> & { text: string }): { message: InboundChannelMessage; replies: string[] } {
  const replies: string[] = []
  return {
    replies,
    message: {
      channel: 'wecom', msgid: partial.msgid ?? `m-${Math.random()}`, chatId: partial.chatId ?? 'u1',
      chatType: partial.chatType ?? 'single', senderId: partial.senderId ?? 'u1', text: partial.text,
      reply: async text => { replies.push(text) },
    },
  }
}

test('允许的用户消息进入同一个会话并回复；同一 msgid 只处理一次', async t => {
  const f = fixture(t)
  const first = inbound({ msgid: 'm1', text: '今天有什么安排' })
  await f.manager.handle(first.message)
  assert.deepEqual(first.replies, ['好的，我记下了。'])
  assert.equal(f.agents.length, 1)
  const duplicate = inbound({ msgid: 'm1', text: '今天有什么安排' })
  await f.manager.handle(duplicate.message)
  assert.equal(duplicate.replies.length, 0, '厂商 msgid 重投不重复进模型')
})

test('陌生人单聊先要求绑定，配对码正确后写入允许列表', async t => {
  const f = fixture(t, { allowedUserIds: [], deliverHere: [], pairingCode: '123456' })
  const stranger = inbound({ senderId: 'u9', chatId: 'u9', text: '你好' })
  await f.manager.handle(stranger.message)
  assert.match(stranger.replies[0]!, /还没有绑定/)
  const paired = inbound({ senderId: 'u9', chatId: 'u9', text: '123456', msgid: 'm9' })
  await f.manager.handle(paired.message)
  assert.match(paired.replies[0]!, /配对成功/)
  assert.deepEqual(f.settings().allowedUserIds, ['u9'])
})

test('群里的陌生人消息不回复、不进模型', async t => {
  const f = fixture(t)
  const group = inbound({ senderId: 'u9', chatId: 'g1', chatType: 'group', text: '@小潘 你好' })
  await f.manager.handle(group.message)
  assert.equal(group.replies.length, 0)
  assert.equal(f.agents.length, 0)
})

test('绑定提醒会话后才允许主动送达，其他会话拒绝', async t => {
  const f = fixture(t)
  const bind = inbound({ text: '绑定提醒', msgid: 'bind-1' })
  await f.manager.handle(bind.message)
  assert.match(bind.replies[0]!, /以后的提醒/)
  assert.equal(await f.manager.deliver('wecom:single:u1', '该看邮件了'), true)
  assert.deepEqual(f.sent, [{ chatId: 'u1', text: '该看邮件了' }])
  assert.equal(await f.manager.deliver('wecom:single:u2', '不该发'), false)
})

test('单聊本人绑定撤销后，即使旧提醒会话残留也不再发送', async t => {
  const f = fixture(t, { allowedUserIds: ['u1'], deliverHere: ['wecom:single:u1'] })
  assert.equal(f.manager.canDeliver('wecom:single:u1'), true)
  f.settings().allowedUserIds.length = 0
  assert.equal(f.manager.canDeliver('wecom:single:u1'), false)
  assert.equal(await f.manager.deliver('wecom:single:u1', '不能发送'), false)
  assert.deepEqual(f.sent, [])
})

test('重连只替换渠道连接，保留配对及会话，停用后不投递', async t => {
  const f = fixture(t, { allowedUserIds: ['u1'], deliverHere: ['wecom:single:u1'] })
  await f.manager.handle(inbound({ text: '你好' }).message)
  let starts = 0, stops = 0
  const sent: string[] = []
  await f.manager.replaceAdapter('wecom', { name: 'wecom', start: async () => { starts++ }, stop: async () => { stops++ }, sendTo: async (_id, text) => { sent.push(text) } })
  assert.equal(starts, 1)
  await f.manager.handle(inbound({ text: '还在吗' }).message)
  assert.equal(f.agents.length, 1)
  assert.equal(await f.manager.deliver('wecom:single:u1', '新连接投递'), true)
  assert.deepEqual(sent, ['新连接投递'])
  const snapshot = f.manager.settingsSnapshot()
  snapshot.allowedUserIds.length = 0
  assert.deepEqual(f.manager.settingsSnapshot().allowedUserIds, ['u1'])
  await f.manager.replaceAdapter('wecom', null)
  assert.equal(stops, 1)
  assert.equal(f.manager.canDeliver('wecom:single:u1'), false)
  assert.equal(await f.manager.deliver('wecom:single:u1', '不投递'), false)
})

test('绑定成员优先接收已配对消息，陌生人不能触发成员路由', async t => {
  const store = new TeamStore(':memory:')
  const received: string[] = []
  const manager = new ChannelManager({ store, settingsFile: 'unused', readSettings: () => ({ allowedUserIds: ['u1'], deliverHere: [] }), writeSettings: () => {}, log: () => {},
    host: { create: async () => { throw new Error('不应创建旧渠道专用智能体') }, waitForIdle: async () => {} },
    route: async (text, key) => { received.push(key); assert.match(text, /用户消息/); return '成员已收到' },
  })
  t.after(async () => { await manager.stop(); store.close() })
  const stranger = inbound({ text: '外人', senderId: 'unknown' })
  await manager.handle(stranger.message)
  assert.equal(received.length, 0)
  const owner = inbound({ text: '安排任务' })
  await manager.handle(owner.message)
  assert.deepEqual(received, ['wecom:single:u1'])
  assert.deepEqual(owner.replies, ['成员已收到'])
})
