import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionBridge } from '../src/bridge.ts'
import type { BridgeEvent } from '../src/bridge.ts'
import { watchReplyDeltas } from '../src/team.ts'
import type { TeamEvent } from '../src/team-domain.ts'

/**
 * 团队委派的流式出字。
 *
 * 背景（回归目标）：点名成员时走 `runTeamTask`，此前只在结束时发一条 `reply/done`，
 * 宠物气泡只能等它到了才一次性弹出整段；而同一时间 DSH 网页早已打完字。
 * 事件词汇里早就留了 `reply/delta`，却没人发射、也没人转发。
 *
 * 这里钉住两件事：
 *  1. `watchReplyDeltas` 能从**逐步增长**的子代理会话里按时取出可见文本；
 *  2. 桥接把 `reply/delta` 转成宠物已认的 `delta`（终端链路一处不改）。
 */

/** 子代理会话事件的最小形状（与 ChunkEventLike 同构）。 */
type Ev = { type: string; data: Record<string, unknown> }
const chunk = (turn: number, type: string, text: string): Ev =>
  ({ type: 'assistant/chunk', data: { turn, step: 1, chunk: { type, text } } })

describe('watchReplyDeltas：从逐步增长的会话里按时取出可见文本', () => {
  let stops: Array<() => void> = []
  afterEach(() => {
    for (const stop of stops) stop()
    stops = []
  })

  /** 等够一拍（120ms）再加一点余量。 */
  const tick = () => new Promise(resolve => setTimeout(resolve, 180))

  test('只推 text-delta，reasoning-delta 是思考草稿不能进气泡', async () => {
    const log: Ev[] = [
      chunk(1, 'reasoning-delta', '（思考草稿）'),
      chunk(1, 'text-delta', '你好，'),
      chunk(1, 'block-start', ''),
      chunk(1, 'text-delta', '今天'),
    ]
    const got: string[] = []
    stops.push(watchReplyDeltas(() => log, text => got.push(text)))
    await tick()
    assert.deepEqual(got, ['你好，今天'], '思考草稿与块边界都不能出现')
  })

  test('事件是逐步增长的：每一拍只取新增部分，不重复、不丢', async () => {
    const log: Ev[] = []
    const got: string[] = []
    stops.push(watchReplyDeltas(() => log, text => got.push(text)))
    log.push(chunk(1, 'text-delta', '一'))
    await tick()
    log.push(chunk(1, 'text-delta', '二'), chunk(1, 'text-delta', '三'))
    await tick()
    log.push(chunk(1, 'text-delta', '四'))
    await tick()
    assert.deepEqual(got, ['一', '二三', '四'], '按拍批量推进，且不重复已推过的')
  })

  test('按拍批量：一段里十几个 token 只推一次，不为每个 token 写一次发件箱', async () => {
    const log: Ev[] = []
    for (let i = 0; i < 12; i++) log.push(chunk(1, 'text-delta', '字'))
    const got: string[] = []
    stops.push(watchReplyDeltas(() => log, text => got.push(text)))
    await tick()
    assert.equal(got.length, 1, '一次拍内合并成一条')
    assert.equal(got[0], '字'.repeat(12))
  })

  test('stop() 之后不再交付（结算前必须收尾，否则尾巴冒在 reply/done 之后）', async () => {
    const log: Ev[] = [chunk(1, 'text-delta', '前')]
    const got: string[] = []
    const stop = watchReplyDeltas(() => log, text => got.push(text))
    await tick()
    stop()
    log.push(chunk(1, 'text-delta', '后'))
    await tick()
    assert.deepEqual(got, ['前'], '停止后新增的不交付')
  })

  test('读会话抛错时静默停掉，不打断任务本身', async () => {
    const got: string[] = []
    let boom = false
    stops.push(watchReplyDeltas(() => {
      if (boom) throw new Error('会话读不到')
      return [chunk(1, 'text-delta', '有')]
    }, text => got.push(text)))
    await tick()
    boom = true
    await tick()
    assert.deepEqual(got, ['有'], '出错前推过的内容保留，出错后静默停止')
  })
})

describe('桥接把 reply/delta 转成宠物已认的 delta', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dsh-team-stream-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** 只实现 drainTeamEvents 要用到的形状：eventsSince 给批次，其余按需为空。 */
  function fakeTeam(batch: TeamEvent[]) {
    return {
      eventsSince: (since: number, limit: number) => batch.filter(e => e.seq > since).slice(0, limit),
      roster: () => [],
      listTasks: () => [],
      runningCount: () => 0,
    } as never
  }

  function teamEvent(seq: number, type: TeamEvent['type'], payload: Record<string, unknown>): TeamEvent {
    return { seq, type, taskId: null, assistantId: null, payload, createdAt: Date.now() }
  }

  test('reply/delta 推成 delta（id 归属原请求），reply/done 照常结算', async () => {
    const deltas: BridgeEvent[] = []
    const replies: BridgeEvent[] = []
    const bridge = new SessionBridge({
      dshHome: dir,
      onEvent: event => {
        if (event.type === 'delta') deltas.push(event)
        if (event.type === 'reply') replies.push(event)
      },
    })

    // 第二条与第一条都属于 req-1：连续出字后才结算。
    bridge.attachTeam(fakeTeam([
      teamEvent(1, 'reply/delta', { requestId: 'req-1', text: '你好，' }),
      teamEvent(2, 'reply/delta', { requestId: 'req-1', text: '今天写代码' }),
      teamEvent(3, 'reply/delta', { requestId: 'other', text: '别人的，不该串到这一轮' }),
      teamEvent(4, 'reply/delta', { requestId: 'req-1', text: '' }),
      teamEvent(5, 'reply/done', { requestId: 'req-1', text: '你好，今天写代码', status: 'review' }),
    ]), { pendingProposals: () => [] } as never)

    const mine = deltas.filter(e => e.id === 'req-1')
    assert.deepEqual(mine.map(e => e.text), ['你好，', '今天写代码'], '按序推出，空串不推')
    assert.equal(deltas.every(e => e.type === 'delta'), true, '统一是宠物已认的 delta 事件')
    assert.equal(replies.length, 1, 'reply/done 照常结算成一条 reply')
    assert.equal(replies[0].id, 'req-1')
    assert.equal(replies[0].reply, '你好，今天写代码')

    bridge.dispose()
  })

  test('空 requestId 的增量不推：归属不明的文本不能贴进任何气泡', async () => {
    const deltas: BridgeEvent[] = []
    const bridge = new SessionBridge({
      dshHome: dir,
      onEvent: event => { if (event.type === 'delta') deltas.push(event) },
    })
    bridge.attachTeam(fakeTeam([
      teamEvent(1, 'reply/delta', { text: '没有归属的文本' }),
    ]), { pendingProposals: () => [] } as never)
    assert.equal(deltas.length, 0)
    bridge.dispose()
  })
})
