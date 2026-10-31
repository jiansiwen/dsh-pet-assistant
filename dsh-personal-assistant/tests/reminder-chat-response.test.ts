import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { ApprovalService } from '../src/approval.ts'
import { ChannelManager, parseReminderChatReply, type ChannelAdapter } from '../src/channels.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'
import { TeamStore } from '../src/team-domain.ts'

const CHAT = 'wecom:single:u1'

function fixture(t: TestContext) {
  const store = new TeamStore(':memory:')
  let now = Date.parse('2026-10-27T10:00:00Z')
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'epoch-1' })
  const runtime = new CompanionTaskRuntime(store, approvals, {
    epoch: 'epoch-1', now: () => now,
    acceptsRecipient: (channel, recipient) => channel === 'wecom' && recipient === CHAT,
  })
  t.after(async () => { await runtime.dispose(); store.close() })
  const envelope = (id: string, payload: unknown) => ({
    protocolVersion: 1 as const, commandId: id, expiresAt: new Date(now + 60_000).toISOString(), payload,
  })
  return { store, runtime, envelope, advance: (ms: number) => { now += ms }, now: () => now }
}

async function createWecomReminder(f: ReturnType<typeof fixture>, title: string, commandId: string): Promise<string> {
  const prepared = await f.runtime.request('POST', '/companion/v1/inputs', {
    kind: 'reminder', message: title, schedule: { kind: 'once', timezone: 'UTC', runAt: '2026-10-27T10:00:02Z' },
    repeatEverySeconds: 60, relatedBusinessTaskId: null, channel: 'wecom', recipientId: CHAT,
  }, 'owner')
  assert.equal(prepared.status, 201)
  const created = await f.runtime.request('POST', '/companion/v1/tasks', f.envelope(commandId, {
    kind: 'reminder', title, inputRef: (prepared.body as { inputRef: string }).inputRef, dependsOn: [],
  }), 'owner')
  assert.ok(created.status >= 200 && created.status < 300, JSON.stringify(created.body))
  return (created.body as { task: { taskId: string } }).task.taskId
}

function tick(f: ReturnType<typeof fixture>): void {
  ;(f.runtime as unknown as { tick(): void }).tick()
}

test('已绑定会话回复“知道了”只结束对应提醒周期，别的会话不能代答', async t => {
  const f = fixture(t)
  const taskId = await createWecomReminder(f, '该开会了', 'cmd-ack')
  f.advance(3_000)
  tick(f)

  assert.equal(f.runtime.respondChannelReminder('wecom:single:u2', { action: 'ack' }).handled, false,
    '未绑定会话没有待回应提醒，不能确认')
  const result = f.runtime.respondChannelReminder(CHAT, { action: 'ack' })
  assert.equal(result.handled, true)
  assert.match(result.message, /已确认「该开会了」/)
  assert.match(result.message, /不等于业务事项完成/)

  const cycle = f.store.listReminderCycles()[0]!
  assert.equal(cycle.state, 'acknowledged')
  assert.equal(f.store.getTask(cycle.childTaskId)?.status, 'done')
  assert.notEqual(taskId, '')

  f.advance(600_000)
  tick(f)
  assert.equal(f.runtime.listChannelDeliveries('wecom').length, 0, '确认后不再催办')
  assert.equal(f.runtime.respondChannelReminder(CHAT, { action: 'ack' }).handled, false, '同一提醒不能被确认两次')
})

test('多条提醒同时等待时先澄清，按序号只处理指定的一条', async t => {
  const f = fixture(t)
  await createWecomReminder(f, '喝水', 'cmd-many-a')
  await createWecomReminder(f, '交周报', 'cmd-many-b')
  f.advance(3_000)
  tick(f)

  const ask = f.runtime.respondChannelReminder(CHAT, { action: 'ack' })
  assert.equal(ask.handled, true)
  assert.match(ask.message, /2 条提醒/)
  assert.match(ask.message, /第1条/)
  assert.equal(f.store.listReminderCycles().filter(cycle => cycle.state === 'acknowledged').length, 0,
    '没有指明是哪一条时不批量确认')

  const second = f.runtime.respondChannelReminder(CHAT, { action: 'cancel', index: 2 })
  assert.match(second.message, /已取消/)
  assert.equal(f.store.listReminderCycles().filter(cycle => cycle.state === 'cancelled').length, 1)
  assert.equal(f.store.listReminderCycles().filter(cycle => cycle.state === 'awaiting-response').length, 1)
})

test('延后按明确分钟重排，到期前不再催办', async t => {
  const f = fixture(t)
  await createWecomReminder(f, '看邮件', 'cmd-snooze')
  f.advance(3_000)
  tick(f)

  const result = f.runtime.respondChannelReminder(CHAT, { action: 'snooze', minutes: 5 })
  assert.equal(result.handled, true)
  assert.match(result.message, /约 5 分钟后再提醒/)
  const cycle = f.store.listReminderCycles()[0]!
  assert.equal(cycle.state, 'snoozed')
  assert.equal(cycle.nextNagAt, f.now() + 5 * 60_000)
  assert.equal(f.runtime.listChannelDeliveries('wecom').length, 0)

  f.advance(4 * 60_000)
  tick(f)
  assert.equal(f.runtime.listChannelDeliveries('wecom').length, 0, '延后未到点不催办')
  f.advance(2 * 60_000)
  tick(f)
  assert.equal(f.runtime.listChannelDeliveries('wecom').length, 1, '延后到点后继续提醒')
})

test('桌面提醒不会被聊天回应误确认', async t => {
  const f = fixture(t)
  const prepared = await f.runtime.request('POST', '/companion/v1/inputs', {
    kind: 'reminder', message: '桌面提醒', schedule: { kind: 'once', timezone: 'UTC', runAt: '2026-10-27T10:00:02Z' },
    repeatEverySeconds: 60, relatedBusinessTaskId: null, channel: 'desktop',
  }, 'owner')
  const created = await f.runtime.request('POST', '/companion/v1/tasks', f.envelope('cmd-desktop', {
    kind: 'reminder', title: '桌面提醒', inputRef: (prepared.body as { inputRef: string }).inputRef, dependsOn: [],
  }), 'owner')
  assert.ok(created.status >= 200 && created.status < 300)
  f.advance(3_000)
  tick(f)

  assert.equal(f.store.listReminderCycles()[0]!.state, 'awaiting-response')
  assert.equal(f.runtime.respondChannelReminder(CHAT, { action: 'ack' }).handled, false)
  assert.equal(f.store.listReminderCycles()[0]!.state, 'awaiting-response')
})

test('只把整句提醒回应当回答，带别的内容交回正常对话', () => {
  assert.deepEqual(parseReminderChatReply('知道了'), { action: 'ack' })
  assert.deepEqual(parseReminderChatReply('收到。'), { action: 'ack' })
  assert.deepEqual(parseReminderChatReply('好'), { action: 'ack' })
  assert.deepEqual(parseReminderChatReply('延后10分钟'), { action: 'snooze', minutes: 10 })
  assert.deepEqual(parseReminderChatReply('半小时后提醒我'), { action: 'snooze', minutes: 30 })
  assert.deepEqual(parseReminderChatReply('10分钟后再提醒我'), { action: 'snooze', minutes: 10 })
  assert.deepEqual(parseReminderChatReply('稍后'), { action: 'snooze', minutes: 10 })
  assert.deepEqual(parseReminderChatReply('取消第2条'), { action: 'cancel', index: 2 })
  assert.deepEqual(parseReminderChatReply('确认第1条'), { action: 'ack', index: 1 })
  assert.deepEqual(parseReminderChatReply('延后第1条 15分钟'), { action: 'snooze', minutes: 15, index: 1 })
  assert.equal(parseReminderChatReply('好的，帮我看下邮件'), null)
  assert.equal(parseReminderChatReply('稍等我看一下'), null)
  assert.equal(parseReminderChatReply('今天有什么安排'), null)
  assert.deepEqual(parseReminderChatReply('取消'), { action: 'cancel' })
})

test('渠道消息经统一任务账本结束提醒，不进入模型', async t => {
  const f = fixture(t)
  await createWecomReminder(f, '交周报', 'cmd-channel')
  f.advance(3_000)
  tick(f)

  const sent: string[] = []
  const routed: string[] = []
  const adapter: ChannelAdapter = {
    name: 'wecom', async start() {}, async stop() {}, async sendTo(_chatId, text) { sent.push(text) },
  }
  const manager = new ChannelManager({
    store: f.store,
    host: { async create() { throw new Error('回应提醒不应创建模型会话') }, async waitForIdle() {} },
    settingsFile: 'unused',
    readSettings: () => ({ allowedUserIds: ['u1'], deliverHere: [CHAT] }),
    writeSettings: () => {},
    log: () => {},
    now: f.now,
    route: async text => { routed.push(text); return '正常路由回复' },
    replyReminder: (chatKey, reply) => f.runtime.respondChannelReminder(chatKey, reply),
  })
  manager.register(adapter)
  t.after(async () => { await manager.stop() })

  const replies: string[] = []
  await manager.handle({
    channel: 'wecom', msgid: 'msg-ack', chatId: 'u1', chatType: 'single', senderId: 'u1', text: '知道了',
    reply: async text => { replies.push(text) },
  })
  assert.equal(replies.length, 1)
  assert.match(replies[0]!, /已确认「交周报」/)
  assert.equal(f.store.listReminderCycles()[0]!.state, 'acknowledged')
  assert.deepEqual(sent, [])

  const normal: string[] = []
  await manager.handle({
    channel: 'wecom', msgid: 'msg-normal', chatId: 'u1', chatType: 'single', senderId: 'u1', text: '帮我看下今天的安排',
    reply: async text => { normal.push(text) },
  })
  assert.deepEqual(normal, ['正常路由回复'], '普通消息走原有路由，不被提醒回应拦截')
  assert.equal(routed.length, 1)
})
