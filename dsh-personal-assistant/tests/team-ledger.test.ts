/**
 * 操作账本与中断恢复（M2-07）。
 *
 * 进程可能停在副作用的三个位置：批准已消费还没进工具体、工具体执行中、工具体跑完但结果回执没落库。
 * 这里用文件库跑真实执行链到对应位置，再像重启一样在同一个库上新开存储与服务做对账：
 * 账目必须仍可查（目标、参数摘要、开始时间都在），一律记 unknown 等人工核查，绝不自动重发。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { ApprovalError, ApprovalService, digestOf } from '../src/approval.ts'
import { TeamStore } from '../src/team-domain.ts'
import { TeamService } from '../src/team.ts'
import { registerTeamTools } from '../src/team-tools.ts'
import { deferred, quiet, sideEffectHost, waitFor } from './support/side-effect-host.ts'

type Interruption = 'before-dispatch' | 'during-execution' | 'before-receipt'

/**
 * 临时库目录。t.after 按注册顺序执行，Windows 上库连接没关就删不掉目录，
 * 所以删除由调用方在所有连接的关闭钩子之后再登记。
 */
function tempDb(): { dbPath: string; remove: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-ledger-'))
  return { dbPath: path.join(dir, 'team.sqlite'), remove: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 在文件库上跑一项副作用任务，停在指定位置；返回被打断的那次调用与一张仍在等待的审批卡。 */
async function interruptAt(t: TestContext, dbPath: string, point: Interruption) {
  const f = await sideEffectHost(t, { dbPath, stallBeforeDispatch: point === 'before-dispatch' })
  if (point === 'during-execution') f.hang('bash', new Promise(() => undefined))
  const { task } = await f.startSideEffect('会被进程中断打断的副作用')
  const params = { command: 'publish --target prod' }
  void f.exec('bash', params)
  const card = await f.pendingCard()
  if (point === 'before-receipt') {
    // 工具体照常跑完，但结果回执在落库前进程就没了：结算写不进去。
    f.approvals.settle = () => { throw new Error('模拟进程在回执落库前退出') }
  }
  f.approvals.issue(card.proposalId, { channel: 'desktop-shell' }, true)
  const reached = point === 'before-dispatch'
    ? () => f.approvals.operations(task.taskId)[0]?.state === 'planned'
    : point === 'during-execution'
      ? () => f.approvals.operations(task.taskId)[0]?.state === 'running' && f.bodies.length === 1
      : () => f.bodies.length === 1
  await waitFor(reached, `停在 ${point}`)
  if (point === 'before-receipt') await new Promise(resolve => setTimeout(resolve, 20))
  // 再留一张还在等决定的审批卡：重启后它必须作废，不能被批出一个没人消费的批准。
  void f.exec('write', { file_path: path.join(f.workspace, 'pending.txt'), content: '等批准' })
  const waiting = await f.pendingCard()
  return { f, task, params, waiting, bodiesAtCrash: f.bodies.length }
}

/** 同一个库重新打开：新的存储、新的代次、新的服务实例 = 一次重启。 */
function restart(t: TestContext, dbPath: string) {
  const store = new TeamStore(dbPath)
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'after-restart' })
  const requests: unknown[] = []
  const host = {
    tools: { get: () => undefined, guard: () => () => undefined },
    subagents: { start: async (_provider: string, request: unknown) => { requests.push(request); throw new Error('重启后不应再委派') } },
  }
  const team = new TeamService(host as never, store, {
    teamId: 'test', provider: 'spawn', maxConcurrentInference: 2, maxConcurrentSideEffect: 1, taskTimeoutMs: 10_000,
    defaultBudgetTokens: 0, seats: [], denyExpertTools: [], approvals, logger: quiet,
  })
  t.after(async () => { await team.dispose(); store.close() })
  return { store, approvals, team, requests }
}

for (const point of ['before-dispatch', 'during-execution', 'before-receipt'] as const) {
  test(`重启对账（${point}）：账目可查、记 unknown 待人工核查，不自动重发`, async t => {
    const db = tempDb()
    const { f, task, params, waiting, bodiesAtCrash } = await interruptAt(t, db.dbPath, point)
    const crashed = f.approvals.operations(task.taskId)[0]!
    assert.equal(crashed.state, point === 'before-dispatch' ? 'planned' : 'running', '中断时账本停在真实生命周期的位置')

    const after = restart(t, db.dbPath)
    t.after(db.remove)
    after.team.recoverInterruptedTasks()
    const [operation] = after.approvals.operations(task.taskId)
    assert.equal(operation?.operationId, crashed.operationId)
    assert.equal(operation?.state, 'unknown')
    assert.match(operation?.resultDetail ?? '', /进程中断/)
    assert.equal(operation?.kind, 'bash')
    assert.equal(operation?.target, params.command)
    assert.equal(operation?.paramsDigest, digestOf(params))
    assert.equal(operation?.assistantId, 'member-tangseng')
    assert.equal(operation?.startedAt, crashed.startedAt)
    assert.equal(operation?.executedAt == null, point === 'before-dispatch', '进没进工具体照实保留')
    assert.equal(after.store.getTask(task.taskId)?.status, 'unknown')
    assert.equal(after.store.listRuns(task.taskId)[0]?.state, 'unknown')
    assert.equal(after.store.listRuns(task.taskId)[0]?.stopReason, 'runtime-interrupted')
    assert.equal(after.approvals.proposal(waiting.proposalId)?.state, 'expired', '重启后等待中的审批卡作废')
    assert.throws(() => after.approvals.issue(waiting.proposalId, { channel: 'desktop-shell' }, true),
      (error: unknown) => error instanceof ApprovalError && error.code === 'ALREADY_CONSUMED')

    // 不重发：任务不会再被领取，新批准也消费不了。
    await after.team.runReady({ id: 'parent-session' } as never, new AbortController().signal)
    const again = await after.team.runTask(task.taskId, { id: 'parent-session' } as never, new AbortController().signal)
    assert.equal(again?.task.status, 'unknown')
    assert.equal(after.requests.length, 0)
    const call = { taskId: task.taskId, assistantId: 'member-tangseng', inputRevision: task.revision, tool: 'bash', target: params.command, params }
    assert.equal(after.approvals.callIsLive(call), false)
    assert.equal(after.approvals.authorizeCall(call).ok, false)
    assert.equal(f.bodies.length, bodiesAtCrash, '对账期间没有任何工具体被再次调用')

    // 重复对账幂等，账目不变。
    const events = after.store.eventsSince(0, 5000).length
    after.team.recoverInterruptedTasks()
    assert.equal(after.store.eventsSince(0, 5000).length, events)
  })
}

test('模型不能把 unknown 改成成功：结账工具只读可信账目，账本字段照实返回', async t => {
  const db = tempDb()
  const { f, task } = await interruptAt(t, db.dbPath, 'during-execution')
  const after = restart(t, db.dbPath)
  t.after(db.remove)
  after.team.recoverInterruptedTasks()
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  registerTeamTools({
    tools: { register: (tool: unknown) => { const row = tool as { name: string; execute(args: unknown, exec: unknown): Promise<string> }; tools.set(row.name, row); return () => undefined } },
    systemPrompt: { section: () => () => undefined, variable: () => () => undefined },
  }, { team: after.team, approvals: after.approvals, bridge: {} as never })
  const proposalId = after.store.listProposals().find(item => item.state === 'approved')!.proposalId
  const result = JSON.parse(await tools.get('desktop_team_finish_operation')!.execute(
    { proposalId, state: 'succeeded', resultDigest: '模型自报成功' }, {}))
  assert.equal(result.state, 'unknown')
  assert.equal(result.target, 'publish --target prod')
  assert.ok(result.startedAt && result.executedAt)
  assert.equal(after.approvals.operations(task.taskId)[0]?.state, 'unknown')
  const status = JSON.parse(await tools.get('desktop_team_status')!.execute({ taskId: task.taskId }, {}))
  assert.equal(status.operations[0].state, 'unknown')
  assert.match(status.operations[0].resultDetail, /进程中断/)
  assert.equal(f.bodies.length, 1)
})

test('v3 老库升 v4：操作账本补列不丢老账，老行的新字段为空', async t => {
  const { dbPath, remove } = tempDb()
  const legacy = new TeamStore(dbPath)
  legacy.insertOperation({ operationId: 'legacy-op', taskId: 'legacy-task', approvalId: null, kind: 'write', state: 'succeeded',
    resultDigest: 'digest', startedAt: 1, endedAt: 2 })
  legacy.close()
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(dbPath)
  for (const column of ['assistant_id', 'target', 'params_digest', 'run_id', 'executed_at', 'result_detail']) {
    raw.exec(`ALTER TABLE operations DROP COLUMN ${column}`)
  }
  raw.exec('PRAGMA user_version = 3')
  raw.close()
  const upgraded = new TeamStore(dbPath)
  t.after(() => upgraded.close())
  t.after(remove)
  const operation = upgraded.getOperation('legacy-op')
  assert.equal(operation?.state, 'succeeded')
  assert.equal(operation?.resultDigest, 'digest')
  assert.equal(operation?.target, null)
  assert.equal(operation?.executedAt, null)
  upgraded.insertOperation({ operationId: 'new-op', taskId: 'legacy-task', approvalId: null, kind: 'bash', state: 'planned',
    resultDigest: null, startedAt: 3, endedAt: null, target: 'echo hi', paramsDigest: 'p', assistantId: 'a', runId: 'r' })
  assert.equal(upgraded.getOperation('new-op')?.target, 'echo hi')
  assert.equal(upgraded.markOperationRunning('new-op', 4), true)
  assert.equal(upgraded.markOperationRunning('new-op', 5), false, '只有 planned 能进入执行中')
  assert.equal(upgraded.getOperation('new-op')?.executedAt, 4)
})

test('批准签发与驳回唤醒调用点的等待；放弃等待的审批卡随即作废', async t => {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'test' })
  const call = { taskId: 'task', assistantId: 'chief', inputRevision: 1, tool: 'bash', target: 'echo hi', params: { command: 'echo hi' } }
  const first = approvals.requestApproval(call, '测试', 'high')
  assert.equal(approvals.requestApproval(call, '再来一次', 'high').proposalId, first.proposalId, '同一调用复用待决审批卡')
  const approved = approvals.waitForDecision(first.proposalId, new AbortController().signal)
  approvals.issue(first.proposalId, { channel: 'desktop-shell' }, true)
  assert.equal(await approved, 'approved')

  const second = approvals.requestApproval({ ...call, params: { command: 'echo bye' }, target: 'echo bye' }, '测试', 'high')
  const rejected = approvals.waitForDecision(second.proposalId, new AbortController().signal)
  approvals.reject(second.proposalId, { channel: 'desktop-shell' }, true)
  assert.equal(await rejected, 'rejected')

  const third = approvals.requestApproval({ ...call, params: { command: 'echo cancel' }, target: 'echo cancel' }, '测试', 'high')
  const controller = new AbortController()
  const abandoned = approvals.waitForDecision(third.proposalId, controller.signal)
  controller.abort()
  assert.equal(await abandoned, 'aborted')
  assert.equal(approvals.proposal(third.proposalId)?.state, 'expired')

  const short = new ApprovalService(store, { ttlMs: 30, runtimeEpoch: 'test' })
  const fourth = short.requestApproval({ ...call, params: { command: 'echo late' }, target: 'echo late' }, '测试', 'high')
  const keepAlive = deferred<void>()
  const timer = setTimeout(() => keepAlive.resolve(), 200)
  const [expired] = await Promise.all([short.waitForDecision(fourth.proposalId, new AbortController().signal), keepAlive.promise])
  clearTimeout(timer)
  assert.equal(expired, 'expired')
  assert.equal(store.getProposal(fourth.proposalId)?.state, 'expired')
})
