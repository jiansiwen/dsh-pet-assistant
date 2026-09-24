/**
 * 桥接因果结算（P1.3）的行为契约。
 *
 * 要钉住的核心事实：回复归属只能来自「本条消息进入的那个轮次」的因果折叠，
 * 绝不能拿整机 idle 后最后一条 assistant 文本猜。覆盖 completed / mixed / uncertain /
 * interrupted / 未 entered / turn 未结束保持 pending / 超时 remove true/false / 重复 idle 不重复结算。
 *
 * 分两层：
 *  - settleFromEvents 是纯函数，直接喂事件日志断言判定，不碰 HTTP 与定时器；
 *  - SessionBridge 集成用假 agent（followup 同步 push turn 生命周期事件）驱动 onAgentIdle 与超时路径。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  SessionBridge,
  settleFromEvents,
  type BridgeAgent,
  type BridgeEvent,
} from '../src/bridge.ts'

/** 会话日志事件的最小形状：桥接只读 { type, data }，用数组下标表达先后顺序。 */
type Ev = { type: string; data: Record<string, unknown> }

const turnStart = (turn: number): Ev => ({ type: 'turn/start', data: { turn } })
const turnEnd = (turn: number, kind: string): Ev => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const userMsg = (id: string, sourceKind = 'user'): Ev => ({
  type: 'user/message',
  data: { id, role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: sourceKind } },
})
/** 没有 source 字段的 user/message，用来验证「来源缺失判 uncertain」。 */
const userMsgNoSource = (id: string): Ev => ({
  type: 'user/message',
  data: { id, role: 'user', content: [{ type: 'text', text: 'hi' }] },
})
const assistantMsg = (turn: number, step: number, text: string, id = `a-${turn}-${step}`): Ev => ({
  type: 'assistant/message',
  data: {
    turn,
    step,
    message: { id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
  },
})
const assistantEmpty = (turn: number, step: number): Ev => ({
  type: 'assistant/message',
  data: { turn, step, message: { id: `a-${turn}-${step}`, role: 'assistant', content: [], source: { kind: 'model' } } },
})

describe('settleFromEvents：因果折叠的纯逻辑', () => {
  test('completed 轮次结算为最大 step 的文本，保留 turn/step/输出 id', () => {
    const events: Ev[] = [
      turnStart(1),
      userMsg('m1'),
      assistantMsg(1, 1, '让我查一下'), // 中间步，不该被当成最终回复
      assistantMsg(1, 2, '答案是 42'), // 最大 step 才是最终回复
      turnEnd(1, 'completed'),
    ]
    const outcome = settleFromEvents(events, { messageId: 'm1' })
    assert.equal(outcome.kind, 'settled')
    if (outcome.kind === 'settled') {
      assert.equal(outcome.reply, '答案是 42')
      assert.equal(outcome.turn, 1)
      assert.equal(outcome.step, 2)
      assert.equal(outcome.assistantId, 'a-1-2')
    }
  })

  test('同一最大 step 内多条 assistant/message 文本拼接', () => {
    const events: Ev[] = [
      turnStart(1),
      userMsg('m1'),
      assistantMsg(1, 1, '第一段'),
      assistantMsg(1, 1, '第二段', 'a-second'),
      turnEnd(1, 'completed'),
    ]
    const outcome = settleFromEvents(events, { messageId: 'm1' })
    assert.equal(outcome.kind, 'settled')
    if (outcome.kind === 'settled') {
      assert.equal(outcome.reply, '第一段\n第二段')
      assert.equal(outcome.step, 1)
    }
  })

  test('结算自己的轮次，即使后面还有别人的完整轮次（不倒找最后一条）', () => {
    const events: Ev[] = [
      turnStart(1),
      userMsg('m1'),
      assistantMsg(1, 1, '回给你的'),
      turnEnd(1, 'completed'),
      turnStart(2),
      userMsg('m2'),
      assistantMsg(2, 1, '回给别人的'),
      turnEnd(2, 'completed'),
    ]
    const outcome = settleFromEvents(events, { messageId: 'm1' })
    assert.equal(outcome.kind, 'settled')
    if (outcome.kind === 'settled') {
      assert.equal(outcome.reply, '回给你的')
      assert.equal(outcome.turn, 1)
    }
  })

  test('同轮混入其他 user 来源消息 → failed 且 attribution=mixed', () => {
    const events: Ev[] = [
      turnStart(1),
      userMsg('m1'),
      userMsg('other-human', 'user'),
      assistantMsg(1, 1, '回答'),
      turnEnd(1, 'completed'),
    ]
    const outcome = settleFromEvents(events, { messageId: 'm1' })
    assert.equal(outcome.kind, 'failed')
    if (outcome.kind === 'failed') {
      assert.equal(outcome.attribution, 'mixed')
      assert.match(outcome.error, /混入|分开/)
    }
  })

  test('mixed 在 turn/end 出现前就能判定（不猜、不空等）', () => {
    const events: Ev[] = [turnStart(1), userMsg('m1'), userMsg('other-human', 'user'), assistantMsg(1, 1, '回答')]
    const outcome = settleFromEvents(events, { messageId: 'm1' })
    assert.equal(outcome.kind, 'failed')
    if (outcome.kind === 'failed') assert.equal(outcome.attribution, 'mixed')
  })

  test('来源未知的其他消息 → uncertain（failed，但不标记 mixed）', () => {
    const events: Ev[] = [
      turnStart(1),
      userMsg('m1'),
      userMsg('x', 'mystery-producer'),
      assistantMsg(1, 1, '回答'),
      turnEnd(1, 'completed'),
    ]
    const outcome = settleFromEvents(events, { messageId: 'm1' })
    assert.equal(outcome.kind, 'failed')
    if (outcome.kind === 'failed') {
      assert.notEqual(outcome.attribution, 'mixed')
      assert.match(outcome.error, /来源不明|分开/)
    }
  })

  test('来源缺失 → uncertain', () => {
    const events: Ev[] = [turnStart(1), userMsg('m1'), userMsgNoSource('x'), assistantMsg(1, 1, '回答'), turnEnd(1, 'completed')]
    const outcome = settleFromEvents(events, { messageId: 'm1' })
    assert.equal(outcome.kind, 'failed')
    if (outcome.kind === 'failed') assert.notEqual(outcome.attribution, 'mixed')
  })

  test('plugin/model/tool 来源是可证明的非用户输入，不算混入', () => {
    for (const kind of ['plugin', 'model', 'tool']) {
      const events: Ev[] = [
        turnStart(1),
        userMsg('m1'),
        userMsg(`ctx-${kind}`, kind),
        assistantMsg(1, 1, '回答'),
        turnEnd(1, 'completed'),
      ]
      const outcome = settleFromEvents(events, { messageId: 'm1' })
      assert.equal(outcome.kind, 'settled', `source.kind=${kind} 不该判 mixed`)
      if (outcome.kind === 'settled') assert.equal(outcome.reply, '回答')
    }
  })

  test('消息没进入模型（无匹配 user/message）→ failed 且不重试', () => {
    const events: Ev[] = [turnStart(1), userMsg('someone-else'), assistantMsg(1, 1, '回答'), turnEnd(1, 'completed')]
    const outcome = settleFromEvents(events, { messageId: 'm1' })
    assert.equal(outcome.kind, 'failed')
    if (outcome.kind === 'failed') {
      assert.equal(outcome.attribution, undefined)
      assert.match(outcome.error, /没有进入模型|重试/)
    }
  })

  test('turn 未结束 → pending，等下一次 idle', () => {
    const events: Ev[] = [turnStart(1), userMsg('m1'), assistantMsg(1, 1, '还在想')]
    const outcome = settleFromEvents(events, { messageId: 'm1' })
    assert.equal(outcome.kind, 'pending')
  })

  test('非 completed 的 reason 一律 failed，即使有文本也不报成功', () => {
    for (const kind of ['interrupted', 'error', 'max-tokens', 'aborted', 'blocked']) {
      const events: Ev[] = [turnStart(1), userMsg('m1'), assistantMsg(1, 1, '有文本也不算'), turnEnd(1, kind)]
      const outcome = settleFromEvents(events, { messageId: 'm1' })
      assert.equal(outcome.kind, 'failed', `reason=${kind} 应失败`)
      if (outcome.kind === 'failed') {
        assert.equal(outcome.attribution, undefined)
        assert.ok(outcome.error.includes(kind), `失败信息应点名 ${kind}：${outcome.error}`)
      }
    }
  })

  test('completed 但没有可见文本 → failed，不拿空内容冒充回复', () => {
    const events: Ev[] = [turnStart(1), userMsg('m1'), assistantEmpty(1, 1), turnEnd(1, 'completed')]
    const outcome = settleFromEvents(events, { messageId: 'm1' })
    assert.equal(outcome.kind, 'failed')
  })

  test('entered 但找不到 turn/start → failed，不猜轮次', () => {
    const events: Ev[] = [userMsg('m1'), assistantMsg(1, 1, '回答'), turnEnd(1, 'completed')]
    const outcome = settleFromEvents(events, { messageId: 'm1' })
    assert.equal(outcome.kind, 'failed')
  })
})

/** 假 agent 的行为脚本：决定 followup 往日志里 push 什么样的轮次生命周期。 */
type Script = 'completed' | 'mixed' | 'interrupted' | 'not-entered' | 'pending' | 'queued'

interface FakeAgent extends BridgeAgent {
  session: { events: Ev[] }
  inbox: { remove(messageId: string): boolean }
  /** 记录每次超时撤回尝试的 messageId，用来断言「超时会且只会 remove 一次」。 */
  removed: string[]
}

/**
 * 造一个假 agent：followup 按脚本同步 push turn/start、user/message（data 含真实 id）、
 * assistant/message、turn/end，正好覆盖因果折叠要看的事件。inbox.remove 按 removeReturns 应答。
 */
function makeFakeAgent(script: Script, opts: { reply?: string; removeReturns?: boolean; chunks?: Array<{ type: string; text: string }> } = {}): FakeAgent {
  const events: Ev[] = []
  const removed: string[] = []
  let turnCounter = 0
  const reply = opts.reply ?? '这是因果回复'
  const agent: FakeAgent = {
    session: { events },
    removed,
    inbox: {
      remove(messageId: string): boolean {
        removed.push(messageId)
        return opts.removeReturns ?? false
      },
    },
    followup(message: unknown) {
      const msg = message as { id: string; content: unknown; source: unknown }
      if (script === 'queued') return // 消息卡在收件箱、从未进入模型
      const turn = ++turnCounter
      events.push(turnStart(turn))
      if (script === 'not-entered') {
        events.push(userMsg('not-ours')) // 本条消息的 id 从不出现
      } else {
        events.push({ type: 'user/message', data: { id: msg.id, role: 'user', content: msg.content, source: msg.source } })
      }
      if (script === 'mixed') events.push(userMsg('other-human', 'user'))
      // 原始 chunk 与 assistant/message 一样落在会话日志里，桥接靠它做流式显示。
      for (const chunk of opts.chunks ?? []) {
        events.push({ type: 'assistant/chunk', data: { turn, step: 1, chunk } })
      }
      events.push(assistantMsg(turn, 1, reply, `a-${turn}`))
      if (script === 'interrupted') events.push(turnEnd(turn, 'interrupted'))
      else if (script !== 'pending') events.push(turnEnd(turn, 'completed'))
      // pending：不 push turn/end，轮次一直开着
    },
  }
  return agent
}

describe('SessionBridge 集成：onAgentIdle 与超时路径', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dsh-bridge-causal-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** 绑好桥接、发一条消息、按需触发一次 idle，返回捕获到的 reply 事件。 */
  async function arrange(
    script: Script,
    opts: { reply?: string; removeReturns?: boolean; replyTimeoutMs?: number; idle?: boolean; chunks?: Array<{ type: string; text: string }> } = {},
  ): Promise<{ bridge: SessionBridge; agent: FakeAgent; replies: BridgeEvent[]; deltas: BridgeEvent[] }> {
    const replies: BridgeEvent[] = []
    const deltas: BridgeEvent[] = []
    const bridge = new SessionBridge({
      dshHome: dir,
      onEvent: (event) => {
        if (event.type === 'reply') replies.push(event)
        if (event.type === 'delta') deltas.push(event)
      },
      replyTimeoutMs: opts.replyTimeoutMs,
    })
    const agent = makeFakeAgent(script, { reply: opts.reply, removeReturns: opts.removeReturns, chunks: opts.chunks })
    await bridge.bind(agent)
    bridge.enqueueChat('req-1', '今天做了什么')
    if (opts.idle !== false) bridge.onAgentIdle(agent)
    return { bridge, agent, replies, deltas }
  }

  /** 等够一个扫描间隔（120ms），让流式推送真的跑过一拍。 */
  const streamTick = () => new Promise((resolve) => setTimeout(resolve, 260))

  test('会话流水：输入、正文、思考按发生顺序推，结算后立刻停', async () => {
    const { bridge, agent, replies, deltas } = await arrange('completed', {
      idle: false,
      reply: '你好，今天写了因果结算',
      chunks: [
        { type: 'text-delta', text: '你好，' },
        { type: 'reasoning-delta', text: '（先想想从哪查起）' },
        { type: 'text-delta', text: '今天写了因果结算' },
      ],
    })
    await streamTick()
    // 宠物要和 DSH 会话完全绑定：两边的输入、思考过程、正文都按发生顺序同步过来。
    assert.deepEqual(
      deltas.map((event) => `${event.kind}:${event.text}`),
      ['user:今天做了什么', 'text:你好，', 'think:（先想想从哪查起）', 'text:今天写了因果结算'],
      '输入 / 正文 / 思考 按发生顺序推，思考不混进正文',
    )
    assert.equal(deltas.every((event) => event.id === 'req-1'), true, '增量按请求 id 归属')

    bridge.onAgentIdle(agent)
    assert.equal(replies.length, 1)
    assert.equal(replies[0].reply, '你好，今天写了因果结算', '最终正文仍以因果折叠为准')
    const settled = deltas.length
    await streamTick()
    assert.equal(deltas.length, settled, '结算后不得再推增量')
    bridge.dispose()
  })

  test('同一轮混入其他用户输入：流水照常同步，但回复判 mixed 不冒充', async () => {
    const { bridge, agent, deltas, replies } = await arrange('mixed', {
      idle: false,
      chunks: [{ type: 'text-delta', text: '这句是谁的还不一定' }],
    })
    await streamTick()
    // 镜像语义：会话里出过的正文照样同步（它是会话的真实产物，宠物就该看见）。
    assert.deepEqual(
      deltas.filter((event) => (event.kind ?? 'text') === 'text').map((event) => event.text),
      ['这句是谁的还不一定'],
      '会话里出过的正文照样同步',
    )
    // 但归属不能猜：混入别的真人输入时如实报 mixed，绝不冒充成本请求的回答。
    bridge.onAgentIdle(agent)
    assert.equal(replies.length, 1)
    assert.equal(replies[0].ok, false, '不把这段冒充成因果回复')
    assert.equal(replies[0].attribution, 'mixed')
    bridge.dispose()
  })

  test('completed 轮次结算为 causal，带 turn/step/输出 id', async () => {
    const { bridge, replies } = await arrange('completed', { reply: '今天写了因果结算' })
    assert.equal(replies.length, 1)
    assert.equal(replies[0].ok, true)
    assert.equal(replies[0].reply, '今天写了因果结算')
    assert.equal(replies[0].attribution, 'causal')
    assert.equal(replies[0].id, 'req-1')
    assert.equal(replies[0].turn, 1)
    assert.equal(replies[0].step, 1)
    assert.equal(replies[0].assistantId, 'a-1')
    bridge.dispose()
  })

  test('重复 idle 不重复结算', async () => {
    const { bridge, agent, replies } = await arrange('completed')
    assert.equal(replies.length, 1)
    bridge.onAgentIdle(agent)
    bridge.onAgentIdle(agent)
    assert.equal(replies.length, 1, '同一请求只应结算一次')
    bridge.dispose()
  })

  test('mixed 轮次经 onAgentIdle 失败并标记 mixed', async () => {
    const { bridge, replies } = await arrange('mixed')
    assert.equal(replies.length, 1)
    assert.equal(replies[0].ok, false)
    assert.equal(replies[0].attribution, 'mixed')
    assert.match(replies[0].error ?? '', /混入|分开/)
    bridge.dispose()
  })

  test('interrupted 轮次失败，不报成功', async () => {
    const { bridge, replies } = await arrange('interrupted')
    assert.equal(replies.length, 1)
    assert.equal(replies[0].ok, false)
    assert.match(replies[0].error ?? '', /interrupted|中断/)
    bridge.dispose()
  })

  test('未 entered：idle 时消息没进入模型 → 失败不重试', async () => {
    const { bridge, replies } = await arrange('not-entered')
    assert.equal(replies.length, 1)
    assert.equal(replies[0].ok, false)
    assert.match(replies[0].error ?? '', /没有进入模型/)
    bridge.dispose()
  })

  test('turn 未结束：idle 保持 pending，不结算', async () => {
    const { bridge, replies } = await arrange('pending')
    assert.equal(replies.length, 0, '轮次没结束时不得结算')
    bridge.dispose()
  })

  test('turn 未结束保持 pending，下一次 idle（轮次补完）才结算', async () => {
    const { bridge, agent, replies } = await arrange('pending', { reply: '稍后给出的答案' })
    assert.equal(replies.length, 0)
    agent.session.events.push(turnEnd(1, 'completed')) // 轮次这时才真正结束
    bridge.onAgentIdle(agent)
    assert.equal(replies.length, 1)
    assert.equal(replies[0].ok, true)
    assert.equal(replies[0].reply, '稍后给出的答案')
    assert.equal(replies[0].attribution, 'causal')
    bridge.dispose()
  })

  test('超时且 inbox.remove=true → 报 cancelled，且只 remove 一次', async () => {
    const { bridge, agent, replies } = await arrange('queued', { removeReturns: true, replyTimeoutMs: 20, idle: false })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(replies.length, 1)
    assert.equal(replies[0].ok, false)
    assert.match(replies[0].error ?? '', /撤回|cancelled/)
    assert.deepEqual(agent.removed.length, 1, '超时应尝试 inbox.remove 恰好一次')
    bridge.dispose()
  })

  test('超时且 inbox.remove=false → 报 timeout，声明后台可能仍运行、不自动重发、不取消共享 agent', async () => {
    const { bridge, agent, replies } = await arrange('pending', { removeReturns: false, replyTimeoutMs: 20, idle: false })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(replies.length, 1)
    assert.equal(replies[0].ok, false)
    assert.match(replies[0].error ?? '', /后台|不自动重发|不会取消/)
    assert.deepEqual(agent.removed.length, 1)
    bridge.dispose()
  })

  test('超时后即便轮次补完也不再结算（pending 已清空）', async () => {
    const { bridge, agent, replies } = await arrange('pending', { removeReturns: false, replyTimeoutMs: 20, idle: false })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(replies.length, 1, '超时已失败一次')
    agent.session.events.push(turnEnd(1, 'completed'))
    bridge.onAgentIdle(agent)
    assert.equal(replies.length, 1, '超时之后不得再对同一请求结算')
    bridge.dispose()
  })
})
