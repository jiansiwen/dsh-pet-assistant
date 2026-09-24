import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionBridge } from '../src/bridge.ts'
import type { BridgeEvent } from '../src/bridge.ts'

/**
 * 真实宿主的流式：`session.events` 是**边跑边增长**的。
 *
 * 这个测试专门补 `bridge-causal.test.ts` 覆盖不到的场景 —— 那边的 fake agent 在 `followup()`
 * 里**一次性同步 push 了全部 chunk**，所以第一次扫描就全拿到了，看不出增量路径的毛病。
 * 真实宿主是 `for await (const chunk of stream) session.append('assistant/chunk', ...)`
 * （core/agent-loop/src/agent.ts:366-370），事件是逐步进数组的。
 *
 * 走的是**生产路径**：enqueueChat → pump → handleChat → startStream → scanStream → push(delta)。
 */

type Ev = { type: string; data: Record<string, unknown> }

interface GrowingAgent {
  session: { events: Ev[] }
  inbox: { remove(messageId: string): boolean }
  followup(message: unknown): void
  /** 本条消息的稳定 id（locateTurn 按它定位轮次）。 */
  messageId: string | null
  /** 模拟宿主逐块 append：一次只进一个 token。 */
  emit(text: string): void
  finish(reply: string): void
}

/** 造一个「followup 只登记、chunk 之后慢慢长」的假 agent —— 这才是宿主的真实行为。 */
function makeGrowingAgent(): GrowingAgent {
  const events: Ev[] = []
  let turn = 0
  return {
    session: { events },
    messageId: null,
    inbox: { remove: () => false },
    followup(message: unknown) {
      const msg = message as { id: string; content: unknown; source: unknown }
      turn += 1
      this.messageId = msg.id
      // 只登记本条输入与轮次边界；正文按宿主那样逐块 append。
      events.push({ type: 'turn/start', data: { turn } })
      events.push({ type: 'user/message', data: { id: msg.id, role: 'user', content: msg.content, source: msg.source } })
    },
    emit(text: string) {
      events.push({ type: 'assistant/chunk', data: { turn, step: 1, chunk: { type: 'text-delta', text } } })
    },
    finish(reply: string) {
      events.push({
        type: 'assistant/message',
        data: { turn, step: 1, message: { id: `a-${turn}`, role: 'assistant', content: [{ type: 'text', text: reply }], source: {} } },
      })
      events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    },
  }
}

describe('流式：会话事件逐步增长时也要按时推出增量', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dsh-stream-inc-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** 等一拍扫描（120ms）再加余量。 */
  const tick = () => new Promise(resolve => setTimeout(resolve, 190))

  test('逐块 append 时，每一拍都能拿到新增文本（不是等结算后一次给）', async () => {
    const deltas: BridgeEvent[] = []
    const replies: BridgeEvent[] = []
    const bridge = new SessionBridge({
      dshHome: dir,
      onEvent: event => {
        if (event.type === 'delta') deltas.push(event)
        if (event.type === 'reply') replies.push(event)
      },
    })
    const agent = makeGrowingAgent()
    await bridge.bind(agent)
    bridge.enqueueChat('req-1', '今天做了什么')

    // 宿主逐 token 吐字：每片之后都过一拍，模拟真实节奏
    for (const piece of ['你好，', '今天', '写了', '增量']) {
      agent.emit(piece)
      await tick()
    }

    const texts = deltas.filter(d => (d.kind ?? 'text') === 'text').map(d => d.text)
    assert.ok(texts.length >= 2, `结算前就该有正文增量，实际 ${texts.length} 条：${JSON.stringify(texts)}`)
    assert.deepEqual(texts, ['你好，', '今天', '写了', '增量'], '按序逐片推出，不合并也不重复')
    assert.equal(deltas.every(d => d.id === 'req-1'), true, '增量按请求 id 归属')
    assert.equal(replies.length, 0, '轮次未结束前不能先结算')

    // 结算
    agent.finish('你好，写了增量')
    bridge.onAgentIdle(agent)
    assert.equal(replies.length, 1)
    assert.equal(replies[0].reply, '你好，写了增量', '正文仍以因果折叠为准')

    const settled = deltas.length
    await tick()
    assert.equal(deltas.length, settled, '结算后不得再推增量')

    bridge.dispose()
  })

  test('同一个 tick 内连进多片：按序全推、不重复、不丢', async () => {
    const deltas: BridgeEvent[] = []
    const bridge = new SessionBridge({
      dshHome: dir,
      onEvent: event => { if (event.type === 'delta') deltas.push(event) },
    })
    const agent = makeGrowingAgent()
    await bridge.bind(agent)
    bridge.enqueueChat('req-1', '请简短回答')
    await tick() // 让第一拍跑过，确立游标

    // 一个 tick 里连进 3 片
    agent.emit('甲'); agent.emit('乙'); agent.emit('丙')
    await tick()
    const texts = () => deltas.filter(d => (d.kind ?? 'text') === 'text').map(d => d.text)
    assert.deepEqual(texts(), ['甲', '乙', '丙'], '同拍多片按序全推，不合并也不重复')

    // 下一拍不该把已推过的又推一遍
    agent.emit('丁')
    await tick()
    assert.deepEqual(texts(), ['甲', '乙', '丙', '丁'], '游标只往前走')

    bridge.dispose()
  })

  test('reasoning-delta 单走 think 分支，不混进正文气泡', async () => {
    const deltas: BridgeEvent[] = []
    const bridge = new SessionBridge({
      dshHome: dir,
      onEvent: event => { if (event.type === 'delta') deltas.push(event) },
    })
    const agent = makeGrowingAgent()
    await bridge.bind(agent)
    bridge.enqueueChat('req-1', '继续')
    await tick()

    agent.session.events.push({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: '（先想想从哪查起）' } } })
    agent.emit('正文')
    await tick()
    assert.deepEqual(deltas.filter(d => (d.kind ?? 'text') === 'text').map(d => d.text), ['正文'], '正文单走 text')
    assert.deepEqual(deltas.filter(d => d.kind === 'think').map(d => d.text), ['（先想想从哪查起）'], '思考同步过来，但不混进正文')

    bridge.dispose()
  })

  test('正文还没出之前只推输入，绝不凭空造正文', async () => {
    const deltas: BridgeEvent[] = []
    const bridge = new SessionBridge({
      dshHome: dir,
      onEvent: event => { if (event.type === 'delta') deltas.push(event) },
    })
    const agent = makeGrowingAgent()
    await bridge.bind(agent)
    // followup 只登记 turn/start + user/message，正文一个字都还没产出
    bridge.enqueueChat('req-1', '这句话还没人回')
    await tick()
    await tick()
    assert.deepEqual(deltas.filter(d => d.kind === 'user').map(d => d.text), ['这句话还没人回'], '输入先同步')
    assert.deepEqual(deltas.filter(d => (d.kind ?? 'text') === 'text'), [], '没正文就不该有正文增量')

    bridge.dispose()
  })
})
