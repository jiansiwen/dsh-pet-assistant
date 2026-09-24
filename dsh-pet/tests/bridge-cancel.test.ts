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
