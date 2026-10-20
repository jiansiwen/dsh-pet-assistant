import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BridgeClient, type ChatReply } from '../src/main/harness.ts'

function clientFixture() {
  const client = new BridgeClient()
  const state = client as unknown as {
    info: { port: number; token: string; epoch: string }
    pending: Map<string, { resolve: (reply: ChatReply) => void; onDelta?: (text: string) => void }>
  }
  state.info = { port: 12345, token: 'test-only', epoch: 'test-epoch' }
  return { client, state }
}

test('采集状态仅信任当前代次完整布尔字段，不将探活成功当采集成功', async t => {
  const { client, state } = clientFixture()
  let body: unknown = { ok: true, epoch: 'test-epoch' }
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body)))
  assert.equal(await client.getActivityState(), null)
  body = { epoch: 'test-epoch', activity: { active: true, capturing: false, titles: true } }
  assert.deepEqual(await client.getActivityState(), { active: true, capturing: false, titles: true })
  body = { epoch: '旧代次', activity: { active: true, capturing: true, titles: true } }
  assert.equal(await client.getActivityState(), null)
  body = { epoch: 'test-epoch', activity: { active: 'true', capturing: true, titles: true } }
  assert.equal(await client.getActivityState(), null)
  state.info = { ...state.info, epoch: '新代次' }
  assert.equal(await client.getActivityState(), null)
  client.dispose()
})

test('采集状态请求失败返回未知，不保留旧的已采集结论', async t => {
  const { client } = clientFixture()
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('连接中断') })
  assert.equal(await client.getActivityState(), null)
  client.dispose()
})

test('开始前取消不发送请求', async t => {
  const { client, state } = clientFixture()
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('不应发请求') })
  const controller = new AbortController()
  controller.abort()
  const result = await client.chat('测试', undefined, controller.signal)
  assert.equal(result.ok, false)
  assert.equal(request.mock.callCount(), 0)
  assert.equal(state.pending.size, 0)
})

test('HTTP提交阶段取消解除等待，不声称后台任务已撤回', async t => {
  const { client, state } = clientFixture()
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    started()
    return await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  })
  const controller = new AbortController()
  const reply = client.chat('测试', undefined, controller.signal)
  await ready
  controller.abort()
  const result = await reply
  assert.match(result.error ?? '', /后台任务是否停止仍需核对/)
  assert.equal(state.pending.size, 0)
})

test('提交后等待事件期间取消清理挂起项，迟到回复无法再完成旧请求', async t => {
  const { client, state } = clientFixture()
  t.mock.method(globalThis, 'fetch', async () => new Response('{"accepted":true}'))
  const controller = new AbortController()
  const reply = client.chat('测试', undefined, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  const id = [...state.pending.keys()][0]
  assert.ok(id)
  controller.abort()
  assert.equal((await reply).ok, false)
  assert.equal(state.pending.has(id), false)
})

test('成功回复清理挂起项，之后的取消不会影响已返回结果', async t => {
  const { client, state } = clientFixture()
  t.mock.method(globalThis, 'fetch', async () => new Response('{"accepted":true}'))
  const controller = new AbortController()
  const reply = client.chat('测试', undefined, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  const entry = [...state.pending.values()][0]
  entry.resolve({ ok: true, reply: '完成' })
  assert.deepEqual(await reply, { ok: true, reply: '完成' })
  assert.equal(state.pending.size, 0)
  controller.abort()
  assert.equal(state.pending.size, 0)
})

// ===== M1-06：定向取消与停止回执 =====

type Call = { url: string; body: Record<string, unknown> }
function recordFetch(t: import('node:test').TestContext, answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call = { url: String(input), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} }
    calls.push(call)
    return answer(call)
  })
  return calls
}
const receiptBody = (state: string, kind: string, message: string) =>
  new Response(JSON.stringify({ ok: true, state, evidence: { kind, at: 1 }, message }))

test('静音式的本地停止等待不向后台发取消，请求仍记为未结算，之后可按 id 定向取消', async t => {
  const { client } = clientFixture()
  const calls = recordFetch(t, call => call.url.includes('/chat/cancel')
    ? receiptBody('not-executed', 'queue-withdrawn', '已撤回：未执行')
    : new Response('{"accepted":true}'))
  const controller = new AbortController()
  const reply = client.chat('测试', undefined, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  assert.match((await reply).error ?? '', /后台任务是否停止仍需核对/)
  assert.equal(calls.filter(call => call.url.includes('/chat/cancel')).length, 0, '本地停止等待不等于取消后台')
  assert.equal(client.hasOutstandingChats, true)
  const chatId = calls[0].body.id
  const receipts = await client.cancelOutstandingChats()
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].state, 'not-executed')
  const cancel = calls.find(call => call.url.includes('/chat/cancel'))!
  assert.equal(cancel.body.id, chatId, '按宠物发起的请求 id 定向取消')
  assert.equal(client.hasOutstandingChats, false)
  assert.equal(calls.filter(call => call.url.includes('/chat?')).length, 1, '取消不会重发原请求')
  client.dispose()
})

test('等待中定向取消：本地等待以插件回执解除，回执如实为结果未知，迟到回复不再完成它', async t => {
  const { client, state } = clientFixture()
  recordFetch(t, call => call.url.includes('/chat/cancel')
    ? receiptBody('unknown', 'shared-session', '已停止本地等待，后台是否停止未知')
    : new Response('{"accepted":true}'))
  const reply = client.chat('测试')
  await new Promise(resolve => setImmediate(resolve))
  const id = [...state.pending.keys()][0]
  const receipt = await client.cancelChat(id)
  assert.equal(receipt.state, 'unknown')
  const result = await reply
  assert.equal(result.ok, false)
  assert.equal(result.cancel?.state, 'unknown')
  assert.match(result.error ?? '', /后台是否停止未知/)
  assert.equal(state.pending.has(id), false)
  client.dispose()
})

test('取消中回执保留记账以便再查；没受理的请求不进记账', async t => {
  const { client } = clientFixture()
  let chatStatus = 200
  recordFetch(t, call => call.url.includes('/chat/cancel')
    ? receiptBody('cancelling', 'abort-signalled', '已发出中止信号')
    : new Response(JSON.stringify(chatStatus === 200 ? { accepted: true } : { error: 'busy' }), { status: chatStatus }))
  const controller = new AbortController()
  const reply = client.chat('团队任务', 'member-wukong', controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await reply
  assert.equal((await client.cancelOutstandingChats())[0].state, 'cancelling')
  assert.equal(client.hasOutstandingChats, true, '取消中还要能再查一次')
  const fresh = clientFixture()
  chatStatus = 429
  assert.equal((await fresh.client.chat('被拒')).ok, false)
  assert.equal(fresh.client.hasOutstandingChats, false)
  client.dispose()
  fresh.client.dispose()
})

test('取消没有送达或未绑定：如实报结果未知，不自动重发', async t => {
  const { client } = clientFixture()
  let mode: 'throw' | 'unbound' = 'throw'
  const calls = recordFetch(t, () => {
    if (mode === 'throw') throw new Error('连接中断')
    return new Response(JSON.stringify({ ok: false, code: 'unbound', error: '还没有连上 dsh 会话' }), { status: 503 })
  })
  const lost = await client.cancelChat('pet-1')
  assert.equal(lost.state, 'unknown')
  assert.equal(lost.evidence.kind, 'transport-error')
  assert.match(lost.message, /不会自动重发/)
  mode = 'unbound'
  const unbound = await client.cancelTeamTask('task-1')
  assert.equal(unbound.state, 'unknown')
  assert.equal(unbound.evidence.kind, 'unbound')
  assert.equal(calls.length, 2, '每次取消只发一次，不重试')
  assert.match(calls[1].url, /\/team\/cancel/)
  assert.equal(calls[1].body.taskId, 'task-1')
  client.dispose()
})

test('暂停后续步骤走 /team/pause，带回插件说明', async t => {
  const { client } = clientFixture()
  const calls = recordFetch(t, () => new Response(JSON.stringify({ ok: true, paused: true, message: '已暂停团队后续步骤' })))
  const result = await client.pauseTeam(true)
  assert.deepEqual(result, { ok: true, paused: true, message: '已暂停团队后续步骤' })
  assert.deepEqual(calls[0].body, { paused: true })
  client.dispose()
})

test('停止命令的参数校验：scope 白名单，taskId / requestId 必须是非空短字符串', async () => {
  const { isSessionCommand } = await import('../src/main/overlay-state.ts')
  assert.equal(isSessionCommand({ kind: 'cancel', bindingId: 'b' }), true)
  assert.equal(isSessionCommand({ kind: 'cancel', bindingId: 'b', scope: 'pause' }), true)
  assert.equal(isSessionCommand({ kind: 'cancel', bindingId: 'b', taskId: 't-1' }), true)
  assert.equal(isSessionCommand({ kind: 'cancel', bindingId: 'b', scope: 'everything' }), false)
  assert.equal(isSessionCommand({ kind: 'cancel', bindingId: 'b', taskId: '' }), false)
  assert.equal(isSessionCommand({ kind: 'cancel', bindingId: 'b', requestId: 'x'.repeat(300) }), false)
})
