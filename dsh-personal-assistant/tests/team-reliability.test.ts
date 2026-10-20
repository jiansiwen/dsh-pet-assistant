import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRun, SubagentStartRequest, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { ToolGuard } from '@deepseek-ai/dsh-tools'
import { ApprovalService } from '../src/approval.ts'
import { Config } from '../src/config.ts'
import { TeamStore } from '../src/team-domain.ts'
import { TeamService, type TeamOptions } from '../src/team.ts'

const report = { summary: '分析结果', artifacts: ['未经独立核实的来源'], blockers: [], needsApproval: [] }
const completed: SubagentResult = { stopReason: 'completed', output: [], structured: report }
const signal = () => new AbortController().signal
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(t: TestContext, options: Partial<TeamOptions> = {}) {
  const store = new TeamStore(':memory:')
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'test' })
  const startupGuards: ToolGuard[] = []
  const childGuards: ToolGuard[] = []
  const requests: SubagentStartRequest[] = []
  const parent = { id: 'parent' } as Agent
  const child = { id: 'child' } as Agent
  const childCtx = { agent: child, tools: { guard: (guard: ToolGuard) => { childGuards.push(guard); return () => undefined } } }
  Object.assign(child, { ctx: childCtx })
  let disposed = 0
  const run: SubagentRun = { id: child.id, localAgent: child, result: Promise.resolve(completed), async dispose() { disposed += 1 } }
  let start: (request: SubagentStartRequest) => Promise<SubagentRun> = async () => run
  const host = {
    tools: {
      get: (name: string, scope: unknown) => scope === parent && ['read', 'grep', 'personal_assistant_set_team_mode', 'desktop_team_assign', 'bash'].includes(name),
      guard: (guard: ToolGuard) => { startupGuards.push(guard); return () => { startupGuards.splice(startupGuards.indexOf(guard), 1) } },
    },
    subagents: { start: async (_provider: string, request: SubagentStartRequest) => { requests.push(request); return start(request) } },
  }
  const team = new TeamService(host as never, store, {
    teamId: 'test', provider: 'spawn', maxConcurrentInference: 1, maxConcurrentSideEffect: 1,
    taskTimeoutMs: 10_000, defaultBudgetTokens: 0, seats: [], denyExpertTools: [], approvals,
    logger: { info() {}, warn() {}, error() {} }, ...options,
  })
  team.ensureRoster()
  t.after(async () => { await team.dispose(); store.close() })
  return { team, store, approvals, parent, child, run, requests, startupGuards, childGuards,
    setStart: (fn: typeof start) => { start = fn }, disposed: () => disposed }
}

test('总助理的只读任务使用父作用域允许集合，不继承插件写工具和再委派', async t => {
  const f = fixture(t)
  const task = f.team.submitTask({ goal: '只读分析', ownerId: 'member-tangseng', toolScope: 'read-only' })
  const outcome = await f.team.runTask(task.taskId, f.parent, signal())
  assert.deepEqual(f.requests[0]?.toolFilter, { allow: ['read', 'grep'] })
  assert.equal(outcome?.task.status, 'review')
  assert.equal(f.startupGuards.length, 0)
  assert.equal(f.disposed(), 1)
  for (const name of ['write', 'bash', 'desktop_team_assign', 'personal_assistant_remember', 'run_code', 'future_tool']) {
    assert.ok(f.childGuards[0]!({ agent: f.child, name, signal: signal() } as never), name)
  }
  assert.equal(f.childGuards[0]!({ agent: f.child, name: 'read', signal: signal() } as never), undefined)
})

test('启动窗口守卫只拦目标子代理，不干扰普通主会话或其他子代理', async t => {
  const f = fixture(t)
  f.setStart(async request => {
    const execution = (name: string, label: string, parentSession: string) => ({ name, agent: { session: {
      header: { parentSession }, events: [{ type: 'subagent/descriptor', data: { label } }],
    } } })
    const guard = f.startupGuards[0]!
    assert.ok(guard(execution('personal_assistant_write', request.label!, 'parent') as never))
    assert.ok(guard(execution('run_code', request.label!, 'parent') as never))
    assert.equal(guard(execution('write', 'other-task', 'parent') as never), undefined)
    assert.equal(guard(execution('write', request.label!, 'unrelated') as never), undefined)
    assert.equal(guard({ name: 'write', agent: f.parent } as never), undefined)
    return f.run
  })
  await f.team.runTask(f.team.submitTask({ goal: '检查启动窗口' }).taskId, f.parent, signal())
})

for (const [title, structured, status] of [
  ['阻碍', { ...report, blockers: ['缺少证据'] }, 'review'],
  ['待批', { ...report, needsApproval: ['需要写文件'] }, 'awaiting-approval'],
  ['同时有阻碍与待批', { ...report, blockers: ['未完成'], needsApproval: ['写文件'] }, 'awaiting-approval'],
  ['只有非空产物', report, 'review'],
  ['空报告', { ...report, summary: '' }, 'review'],
  ['无效列表', { ...report, blockers: '被错误丢弃的阻碍' }, 'review'],
] as const) {
  test(`验收：${title}不能假报完成，也不能被调度器自动重跑`, async t => {
    const f = fixture(t)
    f.setStart(async () => ({ ...f.run, result: Promise.resolve({ ...completed, structured }) }))
    const task = f.team.submitTask({ goal: '验收', acceptance: ['必须核验'] })
    assert.equal((await f.team.runTask(task.taskId, f.parent, signal()))?.task.status, status)
    await f.team.runReady(f.parent, signal())
    await f.team.runTask(task.taskId, f.parent, signal())
    assert.equal(f.requests.length, 1)
  })
}

test('非零累计预算、副作用及未核实 provider 明确拒绝启动', async t => {
  const f = fixture(t)
  for (const input of [{ goal: '预算', budgetTokens: 100 }, { goal: '副作用', toolScope: 'side-effect' as const }]) {
    const outcome = await f.team.runTask(f.team.submitTask(input).taskId, f.parent, signal())
    assert.equal(outcome?.task.status, 'review')
    assert.match(outcome!.stopReason, /unsupported/)
    const reply = f.store.eventsSince(0).filter(event => event.type === 'reply/done').at(-1)!
    assert.equal((reply.payload as { diagnostic: string }).diagnostic, outcome?.diagnostic)
  }
  assert.equal(f.requests.length, 0)
  assert.throws(() => f.team.submitTask({ goal: '无效预算', budgetTokens: NaN }), /预算/)
  assert.throws(() => f.team.submitTask({ goal: '无效截止', deadlineAt: Infinity }), /截止/)
  const other = fixture(t, { provider: 'fork' })
  assert.equal((await other.team.runTask(other.team.submitTask({ goal: '未核实提供者' }).taskId, other.parent, signal()))?.stopReason, 'provider-unsupported')
  assert.equal(other.requests.length, 0)
})

test('启动中即计入并发额度，同任务不能重复领取', async t => {
  const f = fixture(t)
  const start = deferred<SubagentRun>()
  f.setStart(() => start.promise)
  const task = f.team.submitTask({ goal: '任务一' })
  const pending = f.team.runTask(task.taskId, f.parent, signal())
  assert.equal(f.team.runningCount(), 1)
  assert.equal((await f.team.runTask(task.taskId, f.parent, signal()))?.task.status, 'running')
  const next = f.team.submitTask({ goal: '任务二' })
  assert.equal((await f.team.runTask(next.taskId, f.parent, signal()))?.task.status, 'queued')
  assert.equal(f.requests.length, 1)
  start.resolve(f.run)
  await pending
  assert.equal(f.team.runningCount(), 0)
})

test('运行超时结清任务、运行及未知操作，迟到成功不覆盖', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, { taskTimeoutMs: 20 })
  const result = deferred<SubagentResult>()
  f.setStart(async () => ({ ...f.run, result: result.promise }))
  const task = f.team.submitTask({ goal: '等待超时' })
  const pending = f.team.runTask(task.taskId, f.parent, signal())
  f.store.insertOperation({ operationId: 'interrupted-op', taskId: task.taskId, approvalId: null, kind: 'write',
    state: 'planned', resultDigest: null, startedAt: 1, endedAt: null })
  t.mock.timers.tick(21)
  const outcome = await pending
  assert.equal(outcome?.stopReason, 'timeout')
  assert.equal(outcome?.task.status, 'failed')
  assert.equal(f.team.listRuns(task.taskId)[0]?.state, 'failed')
  assert.equal(f.store.getOperation('interrupted-op')?.state, 'unknown')
  assert.equal(f.requests[0]?.signal.aborted, true)
  result.resolve(completed)
  await Promise.resolve()
  assert.equal(f.team.getTask(task.taskId)?.status, 'failed')
  assert.equal(f.store.eventsSince(0).filter(event => event.type === 'run/ended').length, 1)
})

test('已取消信号和已过期截止时间在启动前拒绝', async t => {
  const f = fixture(t)
  const controller = new AbortController()
  controller.abort()
  const cancelled = await f.team.runTask(f.team.submitTask({ goal: '先取消' }).taskId, f.parent, controller.signal)
  const overdue = await f.team.runTask(f.team.submitTask({ goal: '已过期', deadlineAt: Date.now() - 1 }).taskId, f.parent, signal())
  assert.equal(cancelled?.task.status, 'cancelled')
  assert.equal(overdue?.stopReason, 'deadline-exceeded')
  assert.equal(f.requests.length, 0)
})

test('运行中截止时间与启动阶段超时都会向提供者取消', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const f = fixture(t)
  f.setStart(request => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })))
  const task = f.team.submitTask({ goal: '启动阶段截止', deadlineAt: 1050 })
  const pending = f.team.runTask(task.taskId, f.parent, signal())
  t.mock.timers.tick(51)
  const outcome = await pending
  assert.equal(outcome?.stopReason, 'deadline-exceeded')
  assert.equal(f.team.listRuns(task.taskId)[0]?.state, 'failed')
  assert.equal(f.team.runningCount(), 0)
})

test('启动失败和结果基础设施异常都结算运行', async t => {
  for (const phase of ['start', 'result']) {
    const f = fixture(t)
    f.setStart(async () => {
      if (phase === 'start') throw new Error('模拟启动故障')
      return { ...f.run, result: Promise.reject(new Error('模拟基础设施故障')) }
    })
    const task = f.team.submitTask({ goal: '失败检查' })
    const outcome = await f.team.runTask(task.taskId, f.parent, signal())
    assert.equal(outcome?.task.status, 'failed')
    assert.equal(f.team.listRuns(task.taskId)[0]?.state, 'failed')
    assert.equal(f.team.runningCount(), 0)
  }
})

test('取消与正常完成竞争时仅有一条取消终态，退出等待启动阶段收尾', async t => {
  const f = fixture(t)
  const start = deferred<SubagentRun>()
  f.setStart(() => start.promise)
  const task = f.team.submitTask({ goal: '取消竞争' })
  const pending = f.team.runTask(task.taskId, f.parent, signal())
  let stopped = false
  const shutdown = f.team.dispose().then(() => { stopped = true })
  await Promise.resolve()
  assert.equal(stopped, false)
  start.resolve(f.run)
  await shutdown
  assert.equal((await pending)?.task.status, 'cancelled')
  assert.equal(f.team.listRuns(task.taskId)[0]?.state, 'cancelled')
  assert.equal(f.store.eventsSince(0).filter(event => event.type === 'run/ended').length, 1)
  assert.equal(f.disposed(), 1)
})

test('恢复只对账，不重发中断任务或未知副作用，且重复恢复幂等', async t => {
  const f = fixture(t)
  const task = f.team.submitTask({ goal: '重启恢复', toolScope: 'side-effect' })
  f.store.updateTask(task.taskId, task.revision, { status: 'running' })
  f.store.insertRun({ runId: 'old-run', taskId: task.taskId, assistantId: task.ownerId, childSessionId: 'old-child',
    messageId: null, state: 'running', stopReason: null, outputDigest: null, startedAt: 1, endedAt: null })
  f.store.insertOperation({ operationId: 'old-op', taskId: task.taskId, approvalId: null, kind: 'write', state: 'running', resultDigest: null, startedAt: 1, endedAt: null })
  f.team.recoverInterruptedTasks()
  const events = f.store.eventsSince(0).length
  f.team.recoverInterruptedTasks()
  assert.equal(f.store.eventsSince(0).length, events)
  assert.equal(f.team.getTask(task.taskId)?.status, 'unknown')
  assert.equal(f.team.listRuns(task.taskId)[0]?.state, 'unknown')
  assert.equal(f.store.getOperation('old-op')?.state, 'unknown')
  await f.team.runReady(f.parent, signal())
  await f.team.runTask(task.taskId, f.parent, signal())
  assert.equal(f.requests.length, 0)
})

test('成员只读权限不能被任务扩大，额外禁令也进入允许集合过滤', async t => {
  const f = fixture(t, { denyExpertTools: ['grep'] })
  const task = f.team.submitTask({ goal: '范围交集', ownerId: 'member-wukong', toolScope: 'side-effect' })
  assert.equal((await f.team.runTask(task.taskId, f.parent, signal()))?.task.status, 'review')
  assert.deepEqual(f.requests[0]?.toolFilter, { allow: ['read'] })
})

test('提供者主动返回 aborted 映射为取消而不是失败', async t => {
  const f = fixture(t)
  f.setStart(async () => ({ ...f.run, result: Promise.resolve({ output: [], stopReason: 'aborted' }) }))
  const task = f.team.submitTask({ goal: '宿主取消' })
  assert.equal((await f.team.runTask(task.taskId, f.parent, signal()))?.task.status, 'cancelled')
  assert.equal(f.team.listRuns(task.taskId)[0]?.state, 'cancelled')
})

test('任务版本在运行期间变化时报告不覆盖，也不遗留 running', async t => {
  const f = fixture(t)
  const result = deferred<SubagentResult>()
  f.setStart(async () => ({ ...f.run, result: result.promise }))
  const task = f.team.submitTask({ goal: '版本竞争' })
  const pending = f.team.runTask(task.taskId, f.parent, signal())
  const running = f.team.getTask(task.taskId)!
  f.store.updateTask(task.taskId, running.revision, { deadlineAt: Date.now() + 5000 })
  result.resolve(completed)
  assert.equal((await pending)?.task.status, 'unknown')
  assert.equal(f.team.listRuns(task.taskId)[0]?.state, 'unknown')
})

test('释放失败保留门禁和额度并记 unknown，退出仅重试释放', async t => {
  const f = fixture(t)
  let attempts = 0
  f.setStart(async () => ({ ...f.run, async dispose() { attempts += 1; if (attempts === 1) throw new Error('释放未完成') } }))
  const task = f.team.submitTask({ goal: '释放失败' })
  assert.equal((await f.team.runTask(task.taskId, f.parent, signal()))?.task.status, 'unknown')
  assert.equal(f.team.runningCount(), 1)
  assert.equal(f.startupGuards.length, 1)
  await f.team.dispose()
  assert.equal(f.team.runningCount(), 0)
  assert.equal(f.startupGuards.length, 0)
  assert.equal(f.requests.length, 1)
})

test('默认配置不设累计预算：未指定预算的任务直接启动；显式非零预算如实拒启，原因写明宿主没有累计硬上限', async t => {
  const defaults = Config({} as never)
  assert.equal(defaults.defaultBudgetTokens, 0, '用户 2026-10-17 选择不设累计预算')
  // 仍然生效的只有单次输出上限（宿主沿用父会话）、墙钟超时与并发上限。
  assert.equal(defaults.taskTimeoutMs, 600_000)
  assert.equal(defaults.maxConcurrentInference, 2)
  assert.equal(defaults.maxConcurrentSideEffect, 1)
  const f = fixture(t, { defaultBudgetTokens: defaults.defaultBudgetTokens })
  const started = await f.team.runTask(f.team.submitTask({ goal: '默认预算' }).taskId, f.parent, signal())
  assert.equal(f.requests.length, 1)
  assert.equal(started?.task.budgetTokens, 0)
  assert.equal(started?.task.status, 'review')
  assert.equal(f.requests[0]?.agentOptions, undefined, '不覆盖子代理的单次输出上限，沿用父会话')
  const refused = await f.team.runTask(f.team.submitTask({ goal: '显式预算', budgetTokens: 5000 }).taskId, f.parent, signal())
  assert.equal(refused?.task.status, 'review')
  assert.equal(refused?.stopReason, 'budget-unsupported')
  assert.match(refused?.diagnostic ?? '', /宿主没有累计硬上限/)
  assert.equal(f.requests.length, 1, '非零预算的任务没有启动')
})

test('只读子代理能用宿主自身层的 structured_output 交回报告，restrict 名单里不出现子代理本地工具', async t => {
  const f = fixture(t)
  f.setStart(async request => {
    const execution = (name: string) => ({ name, agent: { session: {
      header: { parentSession: 'parent' }, events: [{ type: 'subagent/descriptor', data: { label: request.label } }],
    } } })
    assert.equal(f.startupGuards[0]!(execution('structured_output') as never), undefined)
    return f.run
  })
  await f.team.runTask(f.team.submitTask({ goal: '交回结构化结论' }).taskId, f.parent, signal())
  assert.equal(f.childGuards[0]!({ agent: f.child, name: 'structured_output', signal: signal() } as never), undefined)
  for (const name of ['report', 'structured_output']) assert.equal(f.requests[0]?.toolFilter?.allow?.includes(name), false, name)
})
