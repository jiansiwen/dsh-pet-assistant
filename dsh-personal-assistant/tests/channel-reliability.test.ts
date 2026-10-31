import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { ChannelManager, ChannelReplyError, type ChannelSettings, type InboundChannelMessage } from '../src/channels.ts'
import { TeamStore, TEAM_SCHEMA_VERSION } from '../src/team-domain.ts'
import { ApprovalService } from '../src/approval.ts'
import { SessionBridge } from '../src/bridge.ts'
import { MemberManagement } from '../src/member-management.ts'
import { registerCompanionTools } from '../src/task-tools.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'

type Message = InboundChannelMessage & { accountId?: string }
function message(msgid: string, text: string, options: Partial<Message> = {}) {
  const replies: string[] = []
  const value: Message = { channel: 'wecom', accountId: '测试机器人', msgid, chatId: '主人', chatType: 'single', senderId: '主人', text,
    reply: async reply => { replies.push(reply) }, ...options }
  return { value, replies }
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-channel-reliability-'))
  const dbPath = path.join(dir, 'team.sqlite')
  let store = new TeamStore(dbPath)
  let now = 1_800_000_000_000
  let settings: ChannelSettings = { allowedUserIds: ['主人'], deliverHere: [] }
  let binding = true
  const managers: ChannelManager[] = []
  const manager = (route: (text: string, key: string) => Promise<string | null>, epoch: string) => {
    const result = new ChannelManager({ store, epoch, host: { create: async () => { throw new Error('测试不应创建会话') }, waitForIdle: async () => {} },
      settingsFile: 'unused', readSettings: () => settings, writeSettings: value => { settings = value },
      acceptsMessage: () => binding, route, log: () => {}, now: () => now })
    managers.push(result)
    return result
  }
  t.after(async () => {
    await Promise.all(managers.map(value => value.stop()))
    try { store.close() } catch { /* 已关闭 */ }
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, dbPath, manager, get store() { return store },
    restart: (before?: () => void) => { store.close(); before?.(); store = new TeamStore(dbPath) },
    setSettings: (value: ChannelSettings) => { settings = value }, setBinding: (value: boolean) => { binding = value },
    advance: (ms: number) => { now += ms }, now: () => now }
}

test('排队时停止后保留未开始委托；重启收到相同重投时只处理一次', async t => {
  const f = fixture(t)
  const routed: string[] = []
  let release!: () => void
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  const firstManager = f.manager(async text => {
    if (text.includes('第一条')) { routed.push('第一条'); started(); await wait }
    else routed.push('第二条')
    return '已接收'
  }, 'epoch-1')
  const first = message('queue-1', '第一条')
  const second = message('queue-2', '第二条')
  const running = firstManager.handle(first.value)
  await entered
  const queued = firstManager.handle(second.value)
  await firstManager.stop()
  release()
  await Promise.all([running, queued])
  assert.deepEqual(routed, ['第一条'], '停止后不得继续处理排队消息')
  assert.equal(second.replies.length, 0)
  f.restart()
  const recovered = f.manager(async text => { routed.push(text.includes('第二条') ? '第二条' : '其他'); return '已接收' }, 'epoch-2')
  const waiting = f.store.channelInboundAttention().find(item => item.msgid === 'queue-2')
  assert.equal(waiting?.state, 'pending', '未开始的委托必须可见，不能被旧去重静默吞掉')
  const retry = message('queue-2', '第二条')
  await Promise.all([recovered.handle(retry.value), recovered.handle(message('queue-2', '第二条').value)])
  assert.deepEqual(routed, ['第一条', '第二条'])
  assert.deepEqual(retry.replies, ['已接收'])
  assert.equal(f.store.channelInboundAttention().some(item => item.msgid === 'queue-2'), false)
})

test('回复结果未知时不尝试第二次回复，也不在重投时重复执行', async t => {
  const f = fixture(t)
  let calls = 0, replies = 0
  const manager = f.manager(async () => { calls++; return '已处理' }, 'epoch-1')
  const inbound = message('reply-unknown', '安排一件事', { reply: async () => { replies++; throw new Error('模拟已发送后连接中断') } })
  await manager.handle(inbound.value)
  assert.equal(calls, 1)
  assert.equal(replies, 1, '不能在流式回复结果未知后发送兜底消息')
  const issue = f.store.channelInboundAttention().find(item => item.msgid === inbound.value.msgid)
  assert.equal(issue?.state, 'unknown')
  assert.equal(issue?.processing, 'done')
  assert.equal(issue?.reply, 'unknown')
  f.restart()
  const after = f.manager(async () => { calls++; return '不应重放' }, 'epoch-2')
  await after.handle(message('reply-unknown', '安排一件事').value)
  assert.equal(calls, 1)
  assert.equal(f.store.channelInboundAttention().find(item => item.msgid === 'reply-unknown')?.state, 'unknown')
})

test('重启时执行中和回复中的记录变为未知，不自动重放', async t => {
  const f = fixture(t)
  const makeRecord = (value: Message) => {
    const accountKey = createHash('sha256').update(JSON.stringify([value.channel, value.accountId ?? ''])).digest('hex')
    const digest = createHash('sha256').update(JSON.stringify([value.channel, accountKey, value.chatType, value.chatId,
      value.senderId.trim()])).update('\0').update(value.text).digest('hex')
    const registered = f.store.registerChannelInbound({ channel: value.channel, accountKey, msgid: value.msgid, chatId: value.chatId,
      chatType: value.chatType, senderId: value.senderId, digest }, f.now())
    assert.ok(registered.id)
    assert.equal(f.store.startChannelInbound(registered.id, 'epoch-1', f.now()), true)
    return registered.id
  }
  const processing = message('crash-processing', '执行中断')
  const replying = message('crash-replying', '回复中断')
  const first = makeRecord(processing.value)
  const second = makeRecord(replying.value)
  assert.equal(f.store.beginChannelReply(second, 'epoch-1', 'done', f.now()), true)
  f.restart()
  let calls = 0
  const manager = f.manager(async () => { calls++; return '不应重复' }, 'epoch-2')
  const a = f.store.getChannelInbound(first)!
  const b = f.store.getChannelInbound(second)!
  assert.deepEqual([a.state, a.processing, a.reply], ['unknown', 'unknown', 'not-sent'])
  assert.deepEqual([b.state, b.processing, b.reply], ['unknown', 'done', 'unknown'])
  await manager.handle(processing.value)
  await manager.handle(replying.value)
  assert.equal(calls, 0)
  assert.equal(f.store.finishChannelReply(second, 'epoch-1', 'accepted', f.now()), false, '旧代次迟到回执不能覆盖未知状态')
})

test('明确未发出的回复与结果未知分别记账，均不自动重发', async t => {
  const f = fixture(t)
  const manager = f.manager(async () => '回复', 'epoch-1')
  let replies = 0
  const inbound = message('not-sent', '测试', { reply: async () => { replies++; throw new ChannelReplyError('not-sent', '未发送') } })
  await manager.handle(inbound.value)
  const issue = f.store.channelInboundAttention().find(item => item.msgid === 'not-sent')
  assert.equal(issue?.state, 'unknown')
  assert.equal(issue?.processing, 'done')
  assert.equal(issue?.reply, 'not-sent')
  await manager.handle(inbound.value)
  assert.equal(replies, 1)
})

test('执行后持久化回复阶段失败时，运行期也能看到未知状态', async t => {
  const f = fixture(t)
  let calls = 0
  const manager = f.manager(async () => { calls++; return '结果' }, 'epoch-1')
  const original = f.store.beginChannelReply.bind(f.store)
  f.store.beginChannelReply = () => { throw new Error('模拟写入失败') }
  const inbound = message('write-failure', '测试持久化失败')
  await assert.rejects(manager.handle(inbound.value), /模拟写入失败/u)
  f.store.beginChannelReply = original
  assert.equal(inbound.replies.length, 0, '账本未就绪不能发送')
  const issue = manager.inboundAttention().find(item => item.msgid === 'write-failure')
  assert.equal(issue?.state, 'unknown')
  assert.equal(issue?.processing, 'unknown')
  await manager.handle(message('write-failure', '测试持久化失败').value)
  assert.equal(calls, 1)
})

test('执行抛错可能已有副作用，最多回一次提示并保留结果未知', async t => {
  const f = fixture(t)
  let effects = 0
  const manager = f.manager(async () => { effects++; throw new Error('模拟执行途中断开') }, 'epoch-1')
  const input = message('effect-unknown', '创建任务')
  await manager.handle(input.value)
  assert.equal(effects, 1)
  assert.equal(input.replies.length, 1)
  assert.match(input.replies[0], /核查|核对/u)
  const issue = f.store.channelInboundAttention().find(item => item.msgid === input.value.msgid)
  assert.equal(issue?.state, 'unknown')
  assert.equal(issue?.processing, 'unknown')
  assert.equal(issue?.reply, 'accepted', '提示被服务接受不代表原委托成功')
  await manager.handle(message('effect-unknown', '创建任务').value)
  assert.equal(effects, 1)
})

test('处理前再次核验白名单与机器人绑定，撤销后不继续执行', async t => {
  const f = fixture(t)
  let release!: () => void, entered!: () => void
  const blocker = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const executed: string[] = []
  const manager = f.manager(async text => {
    if (text.includes('阻塞')) { entered(); await blocker; executed.push('阻塞') }
    else executed.push('撤销后消息')
    return '完成'
  }, 'epoch-1')
  const first = manager.handle(message('auth-1', '阻塞').value)
  await ready
  const second = manager.handle(message('auth-2', '撤销后消息').value)
  f.setSettings({ allowedUserIds: [], deliverHere: [] })
  f.setBinding(false)
  release()
  await Promise.all([first, second])
  assert.deepEqual(executed, ['阻塞'])
  assert.equal(f.store.channelInboundAttention().find(item => item.msgid === 'auth-2')?.state, 'pending')
  await manager.handle(message('auth-2', '撤销后消息').value)
  assert.deepEqual(executed, ['阻塞'])
})

test('排队后原始对象被修改也只能执行登记时的消息', async t => {
  const f = fixture(t)
  let release!: () => void, entered!: () => void
  const blocker = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const routed: string[] = []
  const manager = f.manager(async text => {
    if (text.includes('阻塞')) { entered(); await blocker }
    else routed.push(text)
    return '完成'
  }, 'epoch-1')
  const first = manager.handle(message('frozen-1', '阻塞').value)
  await ready
  const queued = message('frozen-2', '原始委托')
  const second = manager.handle(queued.value)
  queued.value.text = '修改后的委托'
  queued.value.senderId = '伪造用户'
  release()
  await Promise.all([first, second])
  assert.equal(routed.length, 1)
  assert.match(routed[0], /原始委托/u)
  assert.doesNotMatch(routed[0], /修改后的委托|伪造用户/u)
})

test('同机器人同消息编号但内容或身份不同时标记冲突，不再执行', async t => {
  const f = fixture(t)
  f.setSettings({ allowedUserIds: ['主人', '另一位已绑定用户'], deliverHere: [] })
  let calls = 0
  const manager = f.manager(async () => { calls++; return '已处理' }, 'epoch-1')
  await manager.handle(message('same-id', '原始内容').value)
  await manager.handle(message('same-id', '篡改内容').value)
  await manager.handle(message('same-id', '原始内容', { senderId: '另一位已绑定用户' }).value)
  assert.equal(calls, 1)
  const issue = f.store.channelInboundAttention().find(item => item.msgid === 'same-id')
  assert.equal(issue?.conflict, true)
  assert.equal(issue?.state, 'completed', '冲突不能伪造原消息处理失败')
})

test('群聊同一消息编号被不同已绑定成员复用时标记身份冲突', async t => {
  const f = fixture(t)
  f.setSettings({ allowedUserIds: ['主人', '另一位已绑定用户'], deliverHere: [] })
  let calls = 0
  const manager = f.manager(async () => { calls++; return '已处理' }, 'epoch-1')
  await manager.handle(message('group-id', '相同内容', { chatType: 'group', chatId: '测试群' }).value)
  await manager.handle(message('group-id', '相同内容', { chatType: 'group', chatId: '测试群', senderId: '另一位已绑定用户' }).value)
  assert.equal(calls, 1)
  const issue = f.store.channelInboundAttention().find(item => item.msgid === 'group-id')
  assert.equal(issue?.conflict, true)
  assert.equal(issue?.senderId, '主人', '不能把原消息归给另一个发送者')
})

test('企业微信单聊会话必须匹配发送者，群中未绑定用户不能触发委托或回复', async t => {
  const f = fixture(t)
  let calls = 0
  const manager = f.manager(async () => { calls++; return '不应处理' }, 'epoch-1')
  const wrongChat = message('wrong-single', '测试', { chatId: '另一个用户' })
  const stranger = message('group-stranger', '群里委托', { chatType: 'group', chatId: '测试群', senderId: '陌生人' })
  await manager.handle(wrongChat.value)
  await manager.handle(stranger.value)
  assert.equal(calls, 0)
  assert.deepEqual(wrongChat.replies, [])
  assert.deepEqual(stranger.replies, [])
  assert.deepEqual(f.store.channelInboundAttention(), [])
})

test('不同机器人使用相同消息编号时分别去重，兜底会话不复用', async t => {
  const f = fixture(t)
  const handles: string[] = []
  const manager = new ChannelManager({ store: f.store, epoch: 'epoch-1', settingsFile: 'unused', log: () => {},
    readSettings: () => ({ allowedUserIds: ['主人'], deliverHere: [] }), writeSettings: () => {},
    host: { async create(key) {
      handles.push(key)
      const events: Array<{ type: string; data?: Record<string, unknown> }> = []
      return { agent: { status: 'idle', session: { events }, followup(value: any) {
        events.push({ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { id: value.id } },
          { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '完成' }] } } },
          { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      } } as never, dispose: async () => {} }
    }, waitForIdle: async () => {} }, now: f.now })
  t.after(() => manager.stop())
  await manager.handle(message('shared-id', '甲机器人', { accountId: '机器人甲' }).value)
  await manager.handle(message('shared-id', '乙机器人', { accountId: '机器人乙' }).value)
  assert.equal(handles.length, 2)
  assert.deepEqual(handles, ['wecom:single:主人', 'wecom:single:主人'], '分别创建会话，但必须保留提醒工具识别的渠道标识')
  const definitions = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  const registered: any[] = []
  const runtime = { parseInput: (input: unknown) => input, request: async (_method: string, pathname: string, input: unknown) => {
    if (pathname === '/companion/v1/inputs') { registered.push(input); return { status: 201, body: { inputRef: '测试输入' } } }
    return { status: 201, body: {} }
  } }
  const dispose = registerCompanionTools({ tools: { register: (value: any) => { definitions.set(value.name, value); return () => {} } } }, runtime as never)
  try {
    const sessionId = `channel-${Buffer.from(handles[0], 'utf8').toString('hex')}-00000000-0000-4000-8000-000000000001`
    await definitions.get('companion_create_reminder')!.execute({ title: '隔离提醒', message: '测试', timezone: 'Asia/Shanghai',
      repeatKind: 'once', delayMinutes: 2, channel: 'desktop' }, { agent: { session: { header: { id: sessionId } } } })
    assert.equal(registered[0].channel, 'wecom')
    assert.equal(registered[0].recipientId, 'wecom:single:主人', '提醒工具仍能自动绑定原企业微信会话')
  } finally { dispose() }
})

test('成员路由收到的会话范围按机器人与单聊隔离，同一范围稳定且不暴露原始标识', async t => {
  const f = fixture(t)
  const scopes: string[] = []
  const manager = new ChannelManager({ store: f.store, epoch: 'scoped-route', settingsFile: 'unused', log: () => {},
    readSettings: () => ({ allowedUserIds: ['主人', '另一人'], deliverHere: [] }), writeSettings: () => {},
    host: { create: async () => { throw new Error('不应使用兜底会话') }, waitForIdle: async () => {} },
    route: async (_text, _key, scope) => { scopes.push(scope); return '完成' }, now: f.now })
  t.after(() => manager.stop())
  await manager.handle(message('scope-1', '第一条', { accountId: '机器人甲' }).value)
  await manager.handle(message('scope-2', '第二条', { accountId: '机器人甲' }).value)
  await manager.handle(message('scope-3', '第三条', { accountId: '机器人乙' }).value)
  await manager.handle(message('scope-4', '第四条', { accountId: '机器人甲', chatId: '另一人', senderId: '另一人' }).value)
  assert.equal(scopes.length, 4)
  assert.match(scopes[0]!, /^[a-f0-9]{64}$/u)
  assert.equal(scopes[0], scopes[1])
  assert.notEqual(scopes[0], scopes[2])
  assert.notEqual(scopes[0], scopes[3])
})

test('未绑定消息与配对码不保存正文，配对消息重投不会进入模型', async t => {
  const f = fixture(t)
  f.setSettings({ allowedUserIds: [], deliverHere: [], pairingCode: 'pair-code-319876' })
  let calls = 0
  const manager = f.manager(async () => { calls++; return '不应处理' }, 'epoch-1')
  const paired = message('pair-1', 'pair-code-319876')
  await manager.handle(paired.value)
  assert.match(paired.replies[0], /配对成功/u)
  await manager.handle(message('pair-1', 'pair-code-319876').value)
  assert.equal(calls, 0)
  const stranger = message('stranger-1', '陌生人秘密正文', { senderId: '陌生人', chatId: '陌生人' })
  await manager.handle(stranger.value)
  for (const file of ['team.sqlite', 'team.sqlite-wal']) {
    const target = path.join(f.dir, file)
    if (!existsSync(target)) continue
    const bytes = readFileSync(target)
    assert.equal(bytes.includes(Buffer.from('pair-code-319876')), false)
    assert.equal(bytes.includes(Buffer.from('陌生人秘密正文')), false)
  }
})

test('过长消息只答复分段提示，不进入模型或伪装成已执行', async t => {
  const f = fixture(t)
  let calls = 0
  const manager = f.manager(async () => { calls++; return '不应执行' }, 'epoch-1')
  const inbound = message('long-1', '过'.repeat(20_001))
  await manager.handle(inbound.value)
  assert.equal(calls, 0)
  assert.match(inbound.replies[0], /尚未处理.*分段/u)
})

test('旧版去重标记升级后仍保守防重，旧结果不能推断为已完成', async t => {
  const f = fixture(t)
  assert.equal(f.store.claimChannelMessage('wecom', 'legacy-id', f.now()), true)
  assert.equal(f.store.beginMailSend({ intentId: 'old-mail', accountKey: 'old-account', digest: 'old-digest',
    subject: '旧邮件', recipients: ['a@example.com'], epoch: 'old-epoch' }, f.now()), true)
  f.restart(() => {
    const old = new DatabaseSync(f.dbPath)
    try { old.exec(`DROP TABLE channel_inbound; DELETE FROM migrations WHERE version = ${TEAM_SCHEMA_VERSION}; PRAGMA user_version = 12`) }
    finally { old.close() }
  })
  let calls = 0
  const manager = f.manager(async () => { calls++; return '不应重复' }, 'epoch-2')
  await manager.handle(message('legacy-id', '旧消息正文不可知').value)
  assert.equal(calls, 0)
  assert.equal(f.store.channelInboundAttention().length, 0, '旧记录没有足够证据恢复或编造状态')
  assert.equal(TEAM_SCHEMA_VERSION, 14)
  assert.equal(f.store.getMailSendIntent('old-mail')?.state, 'sending', '渠道升级不得修改邮件账本')
  f.advance(31 * 24 * 60 * 60_000)
  await manager.handle(message('new-message', '新消息').value)
  await manager.handle(message('legacy-id', '旧消息正文不可知').value)
  assert.equal(calls, 1, '没有执行证据的旧去重标记不能因清理而变成可重放')
})

test('渠道迁移失败时事务回滚，旧版本和已有账本不受损', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-channel-migration-'))
  const file = path.join(dir, 'team.sqlite')
  let store: TeamStore | null = new TeamStore(file)
  t.after(() => { try { store?.close() } catch { /* 已关闭 */ }; rmSync(dir, { recursive: true, force: true }) })
  assert.equal(store.claimChannelMessage('wecom', 'old-id', 1), true)
  assert.equal(store.beginMailSend({ intentId: 'mail-id', accountKey: 'account', digest: 'digest',
    subject: '测试', recipients: ['a@example.com'], epoch: 'epoch-1' }, 1), true)
  store.close()
  store = null
  const old = new DatabaseSync(file)
  try {
    old.exec(`DROP TABLE channel_inbound; DELETE FROM migrations WHERE version = ${TEAM_SCHEMA_VERSION}; PRAGMA user_version = 12;
      CREATE TRIGGER fail_channel_migration BEFORE INSERT ON migrations WHEN NEW.version = ${TEAM_SCHEMA_VERSION}
      BEGIN SELECT RAISE(ABORT, '模拟渠道迁移失败'); END;`)
  } finally { old.close() }
  assert.throws(() => new TeamStore(file), /模拟渠道迁移失败/u)
  const verify = new DatabaseSync(file)
  try {
    assert.equal(verify.prepare('PRAGMA user_version').get()!.user_version, 12)
    assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_inbound'").get(), undefined)
    assert.ok(verify.prepare("SELECT 1 FROM channel_messages WHERE channel = 'wecom' AND msgid = 'old-id'").get())
    assert.ok(verify.prepare("SELECT 1 FROM mail_send_intents WHERE intent_id = 'mail-id'").get())
    verify.exec('DROP TRIGGER fail_channel_migration')
  } finally { verify.close() }
  store = new TeamStore(file)
  assert.equal(store.getMailSendIntent('mail-id')?.state, 'sending')
  assert.equal(store.claimChannelMessage('wecom', 'old-id', 2), false)
})

test('本人核查通过可信入口和版本检查，不自动执行或重发原消息', async t => {
  const f = fixture(t)
  let calls = 0
  const manager = f.manager(async () => { calls++; throw new Error('结果不明') }, 'epoch-1')
  const input = message('owner-check', '安排一件事')
  await manager.handle(input.value)
  const issue = f.store.channelInboundAttention()[0]!
  const service = new MemberManagement({ directory: f.store.directory, runtime: { busy: () => false } as never, memories: {} as never,
    enabled: () => false, setMode: async () => {}, defaultModel: () => null, changed: () => {},
    channelInboundAttention: () => manager.inboundAttention(),
    acknowledgeChannelInbound: (id, revision) => !manager.isInboundBusy(id) && f.store.acknowledgeChannelInbound(id, revision, f.now()) })
  const approvals = new ApprovalService(f.store, { ttlMs: 60_000, runtimeEpoch: 'management' })
  const runtime = new CompanionTaskRuntime(f.store, approvals, { epoch: 'management' })
  runtime.attachMemberManagement(service)
  runtime.start()
  try {
    const root = '/companion/v1/members'
    const route = `${root}/channel-inbound/${issue.id}/acknowledge`
    assert.equal((await runtime.request('GET', root, null, 'client')).status, 403)
    assert.equal((await runtime.request('POST', route, { expectedRevision: issue.revision }, 'client')).status, 403)
    assert.equal((await runtime.request('POST', route, { expectedRevision: issue.revision - 1 }, 'owner')).status, 409)
    assert.equal((await runtime.request('POST', route, { expectedRevision: issue.revision }, 'owner')).status, 200)
    assert.equal(f.store.getChannelInbound(issue.id)?.state, 'reviewed')
    assert.equal(f.store.getChannelInbound(issue.id)?.processing, 'unknown', '本人核对不能伪造任务成功')
    assert.deepEqual(f.store.channelInboundAttention(), [])
    await manager.handle(message('owner-check', '安排一件事').value)
    assert.equal(calls, 1)
  } finally { await runtime.dispose() }
})

test('真实本机 HTTP 只允许本人读取和核查渠道异常，回包不包含正文或指纹', async t => {
  const f = fixture(t)
  let calls = 0
  const manager = f.manager(async () => { calls++; throw new Error('结果未知') }, 'epoch-1')
  await manager.handle(message('http-1', '绝不能出现在核查回包的正文').value)
  const service = new MemberManagement({ directory: f.store.directory, runtime: { busy: () => false } as never, memories: {} as never,
    enabled: () => false, setMode: async () => {}, defaultModel: () => null, changed: () => {},
    channelInboundAttention: () => manager.inboundAttention(),
    acknowledgeChannelInbound: (id, revision) => !manager.isInboundBusy(id) && f.store.acknowledgeChannelInbound(id, revision, f.now()) })
  const bridge = new SessionBridge({ dshHome: f.dir })
  const approvals = new ApprovalService(f.store, { ttlMs: 60_000, runtimeEpoch: bridge.epoch })
  const runtime = new CompanionTaskRuntime(f.store, approvals, { epoch: bridge.epoch })
  runtime.attachMemberManagement(service)
  bridge.attachCompanion(runtime, approvals)
  runtime.start()
  try {
    const listening = await bridge.listen()
    const chat = JSON.parse(readFileSync(path.join(f.dir, 'personal-assistant', 'bridge.json'), 'utf8')) as { token: string }
    const credential = JSON.parse(readFileSync(path.join(f.dir, 'personal-assistant', 'bridge-approval.json'), 'utf8')) as {
      companionOwnerToken: string; companionExecutorToken: string
    }
    const root = `http://127.0.0.1:${listening.port}/companion/v1/members`
    assert.equal((await fetch(`${root}?token=${encodeURIComponent(chat.token)}`)).status, 403)
    assert.equal((await fetch(root, { headers: { 'x-dsh-companion-token': credential.companionExecutorToken } })).status, 401)
    const headers = { 'content-type': 'application/json', 'x-dsh-companion-token': credential.companionOwnerToken }
    const response = await fetch(root, { headers })
    assert.equal(response.status, 200)
    const raw = await response.text()
    assert.doesNotMatch(raw, /绝不能出现在核查回包的正文|digest/u)
    const issue = (JSON.parse(raw) as { channelInboundAttention: Array<{ id: string; revision: number }> }).channelInboundAttention[0]
    const target = `${root}/channel-inbound/${issue.id}/acknowledge`
    const body = JSON.stringify({ expectedRevision: issue.revision })
    assert.equal((await fetch(`${target}?token=${encodeURIComponent(chat.token)}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body })).status, 403)
    assert.equal((await fetch(target, { method: 'POST', headers, body })).status, 200)
    await manager.handle(message('http-1', '绝不能出现在核查回包的正文').value)
    assert.equal(calls, 1)
  } finally {
    await runtime.dispose()
    await bridge.dispose()
  }
})

test('排队消息仍在运行时不能被本人核查操作抢先关闭', async t => {
  const f = fixture(t)
  let release!: () => void, entered!: () => void
  const blocker = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const manager = f.manager(async text => {
    if (text.includes('第一条')) { entered(); await blocker }
    return '完成'
  }, 'epoch-1')
  const first = manager.handle(message('busy-1', '第一条').value)
  await ready
  const second = manager.handle(message('busy-2', '第二条').value)
  const issue = manager.inboundAttention().find(item => item.msgid === 'busy-2')!
  assert.equal(issue.busy, true)
  const service = new MemberManagement({ directory: f.store.directory, runtime: { busy: () => false } as never, memories: {} as never,
    enabled: () => false, setMode: async () => {}, defaultModel: () => null, changed: () => {},
    channelInboundAttention: () => manager.inboundAttention(),
    acknowledgeChannelInbound: (id, revision) => !manager.isInboundBusy(id) && f.store.acknowledgeChannelInbound(id, revision, f.now()) })
  const route = `/companion/v1/members/channel-inbound/${issue.id}/acknowledge`
  assert.equal((await service.request('POST', route, { expectedRevision: issue.revision })).status, 409)
  release()
  await Promise.all([first, second])
  assert.equal((await service.request('POST', route, { expectedRevision: issue.revision })).status, 409, '旧版本不能覆盖已处理状态')
})

test('未核查的未知状态不会被过期清理，直到本人处理', async t => {
  const f = fixture(t)
  const manager = f.manager(async () => '回复', 'epoch-1')
  await manager.handle(message('unknown-retention', '待核查', { reply: async () => { throw new Error('结果未知') } }).value)
  f.advance(90 * 24 * 60 * 60_000)
  await manager.handle(message('trigger-retention', '触发清理').value)
  const issue = f.store.channelInboundAttention().find(item => item.msgid === 'unknown-retention')
  assert.equal(issue?.state, 'unknown')
  assert.equal(issue?.senderId, '主人')
  assert.equal(issue?.reply, 'unknown')
})

test('入站账本不保存消息或回复正文；终态过期后只保留防重墓碑', async t => {
  const f = fixture(t)
  const privateText = '仅测试的私人消息正文-123456'
  const privateReply = '仅测试的私人回复正文-654321'
  let calls = 0
  const manager = f.manager(async () => { calls++; return privateReply }, 'epoch-1')
  await manager.handle(message('privacy-1', privateText).value)
  f.advance(31 * 24 * 60 * 60_000)
  manager.pruneExpired()
  const raw = new DatabaseSync(f.dbPath, { readOnly: true })
  try {
    const row = raw.prepare("SELECT state, sender_id, chat_id, digest FROM channel_inbound WHERE msgid = 'privacy-1'").get()
    assert.deepEqual({ ...row }, { state: 'tombstone', sender_id: null, chat_id: null, digest: null }, '无需新消息也能清除过期定位信息')
  } finally { raw.close() }
  const before = calls
  await manager.handle(message('privacy-1', privateText).value)
  assert.equal(calls, before, '过期清理不能让旧消息重新执行')
  const expired = f.store.channelInboundAttention().find(item => item.msgid === 'privacy-1')
  assert.equal(expired?.conflict, true, '指纹过期后无法比对，应保守提示核查')
  for (const file of ['team.sqlite', 'team.sqlite-wal']) {
    const target = path.join(f.dir, file)
    if (!existsSync(target)) continue
    const bytes = readFileSync(target)
    assert.equal(bytes.includes(Buffer.from(privateText)), false)
    assert.equal(bytes.includes(Buffer.from(privateReply)), false)
  }
})
