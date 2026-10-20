/**
 * 副作用任务的可信执行（M2-03）：在真实 ToolRuntime 执行链上验证两道审批门禁与执行账本。
 * 宿主替身见 tests/support/side-effect-host.ts。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { digestOf } from '../src/approval.ts'
import { Config } from '../src/config.ts'
import { completed, deferred, report, sideEffectHost, waitFor } from './support/side-effect-host.ts'

const desktop = { channel: 'desktop-shell' } as const

test('默认配置不设累计预算：副作用任务真实启动，工具面只含观测与已核实的门禁工具', async t => {
  assert.equal(Config({} as never).defaultBudgetTokens, 0)
  const f = await sideEffectHost(t)
  const { task, pending } = await f.startSideEffect()
  assert.equal(task.status, 'running')
  const request = f.requests[0]!
  assert.deepEqual(request.toolFilter, { allow: ['read', 'grep', 'bash', 'write', 'edit'] })
  for (const name of ['todo_write', 'subagent', 'report', 'structured_output']) assert.equal(request.toolFilter!.allow!.includes(name), false, name)
  const prompt = (request.prompt[0] as { text: string }).text
  assert.match(prompt, /副作用任务/)
  assert.ok(prompt.includes(f.workspace), '提示词说明写类工具的授权工作区')
  f.finish()
  assert.equal((await pending)?.task.status, 'review')
  assert.equal(f.disposed(), 1)
})

test('门禁先于 start() 返回生效：启动窗口内副作用一律拦截，允许集合外与再委派拒绝，也不发审批卡', async t => {
  const f = await sideEffectHost(t)
  const seen: Record<string, boolean> = {}
  f.setOnStart(async () => {
    seen.write = (await f.exec('write', { file_path: path.join(f.workspace, 'a.txt'), content: '启动窗口' })).isError
    seen.bash = (await f.exec('bash', { command: 'echo hi' })).isError
    seen.read = (await f.exec('read', { file_path: path.join(f.workspace, 'a.txt') })).isError
    seen.todo = (await f.exec('todo_write', { todos: '[]' })).isError
    seen.subagent = (await f.exec('subagent', { prompt: '再派一个' })).isError
  })
  const { pending } = await f.startSideEffect()
  assert.deepEqual(seen, { write: true, bash: true, read: false, todo: true, subagent: true })
  assert.deepEqual(f.bodies, ['read'])
  assert.equal(f.approvals.pendingProposals().length, 0, '启动窗口里不替任何调用发审批卡')
  assert.equal(f.approvals.operations().length, 0)
  f.finish()
  await pending
})

test('未批准时拦截：审批卡被驳回则不执行、不留执行账；无人决定到期同样不执行', async t => {
  const f = await sideEffectHost(t, { ttlMs: 80 })
  const { task, pending } = await f.startSideEffect()
  const target = path.join(f.workspace, 'a.txt')
  const call = f.exec('write', { file_path: target, content: '未批准' })
  const card = await f.pendingCard()
  assert.equal(card.target, target)
  assert.equal(card.tool, 'write')
  assert.equal(card.risk, 'medium')
  assert.match(card.summary, /总助理请求写入/)
  assert.equal(f.bodies.length, 0, '等待批准期间工具体不能开始')
  f.approvals.reject(card.proposalId, desktop, true)
  const rejected = await call
  assert.equal(rejected.isError, true)
  assert.match(JSON.stringify(rejected.content), /驳回/)
  const expired = await f.exec('bash', { command: 'echo 不该执行' })
  assert.equal(expired.isError, true)
  assert.match(JSON.stringify(expired.content), /到期/)
  assert.equal(f.bodies.length, 0)
  assert.equal(f.approvals.operations(task.taskId).length, 0)
  f.finish()
  await pending
})

test('批准后只执行一次：账本记下目标、参数摘要与开始时间；同参数重放要重新批准，旧批准不能再用', async t => {
  const f = await sideEffectHost(t)
  const { task, pending } = await f.startSideEffect()
  const target = path.join(f.workspace, 'docs', 'note.txt')
  const params = { file_path: target, content: '批准的内容' }
  const call = f.exec('write', params)
  const card = await f.pendingCard()
  f.approvals.issue(card.proposalId, desktop, true)
  assert.equal((await call).isError, false)
  assert.deepEqual(f.bodies, ['write'])
  const [operation] = f.approvals.operations(task.taskId)
  assert.equal(operation?.state, 'succeeded')
  assert.equal(operation?.target, target)
  assert.equal(operation?.paramsDigest, digestOf(params))
  assert.equal(operation?.assistantId, 'member-tangseng')
  assert.equal(operation?.runId, f.store.listRuns(task.taskId)[0]?.runId)
  assert.ok(operation?.executedAt && operation.endedAt && operation.executedAt >= operation.startedAt)
  assert.equal(operation?.resultDetail, 'ok')

  const replay = f.exec('write', params)
  const again = await f.pendingCard()
  assert.notEqual(again.proposalId, card.proposalId, '旧批准已消费，同参数重放只能重新发卡')
  f.approvals.reject(again.proposalId, desktop, true)
  assert.equal((await replay).isError, true)
  assert.deepEqual(f.bodies, ['write'])
  const direct = f.approvals.authorizeCall({ taskId: task.taskId, assistantId: task.ownerId, inputRevision: task.revision, tool: 'write', target, params })
  assert.equal(direct.ok, false, '绕过等待直接消费，旧批准同样不能重放')

  f.finish()
  const outcome = await pending
  assert.equal(outcome?.task.status, 'review', '工具成功不等于验收通过')
  const done = f.store.eventsSince(0).filter(event => event.type === 'reply/done').at(-1)!.payload as { text: string; operations: unknown[] }
  assert.match(done.text, /^执行账本：成功 1 项/)
  assert.equal(done.operations.length, 1)
})

test('改参数被拒：批准只对完全相同的参数生效，换内容要另批', async t => {
  const f = await sideEffectHost(t)
  const { task, pending } = await f.startSideEffect()
  const target = path.join(f.workspace, 'a.txt')
  const approvedParams = { file_path: target, content: '批准的内容' }
  const approvedCall = { taskId: task.taskId, assistantId: task.ownerId, inputRevision: task.revision, tool: 'write', target, params: approvedParams }
  const approved = f.approvals.requestApproval(approvedCall, '测试：事先批准的写入', 'medium')
  f.approvals.issue(approved.proposalId, desktop, true)

  const tampered = f.exec('write', { ...approvedParams, content: '被替换的内容' })
  const card = await f.pendingCard()
  assert.notEqual(card.proposalId, approved.proposalId, '改过的参数不能借用原批准')
  f.approvals.reject(card.proposalId, desktop, true)
  assert.equal((await tampered).isError, true)
  assert.deepEqual(f.bodies, [])
  assert.equal(f.approvals.hasUsableApproval(approvedCall), true, '原批准没有被改参的调用消费掉')

  assert.equal((await f.exec('write', approvedParams)).isError, false)
  assert.deepEqual(f.bodies, ['write'])
  f.finish()
  await pending
})

test('批准过期被拒：过期批准不放行，重新发卡也到期后不执行', async t => {
  const f = await sideEffectHost(t, { ttlMs: 60 })
  const { task, pending } = await f.startSideEffect()
  const target = path.join(f.workspace, 'a.txt')
  const params = { file_path: target, content: '过期' }
  const proposal = f.approvals.requestApproval({ taskId: task.taskId, assistantId: task.ownerId, inputRevision: task.revision,
    tool: 'write', target, params }, '测试：会过期的批准', 'medium')
  f.approvals.issue(proposal.proposalId, desktop, true)
  await new Promise(resolve => setTimeout(resolve, 120))
  const outcome = await f.exec('write', params)
  assert.equal(outcome.isError, true)
  assert.match(JSON.stringify(outcome.content), /到期/)
  assert.deepEqual(f.bodies, [])
  assert.equal(f.approvals.operations(task.taskId).length, 0)
  f.finish()
  await pending
})

test('跨代理继承被拒：孙代理与冒用标签的会话拿同一组参数也消费不到这次批准', async t => {
  const f = await sideEffectHost(t)
  const { task, pending } = await f.startSideEffect()
  const target = path.join(f.workspace, 'a.txt')
  const params = { file_path: target, content: '只给子代理' }
  const call = { taskId: task.taskId, assistantId: task.ownerId, inputRevision: task.revision, tool: 'write', target, params }
  const proposal = f.approvals.requestApproval(call, '测试：只批给这次委派', 'medium')
  f.approvals.issue(proposal.proposalId, desktop, true)

  // 子代理名下的孙代理：作用域挂在子代理之下，继承它的守卫层。
  const grandchild = await f.scoped('grandchild-session', f.workspace, f.child.agent.id, f.child.agent)
  const inherited = await f.exec('write', params, grandchild.agent)
  assert.equal(inherited.isError, true)
  assert.match(JSON.stringify(inherited.content), /继承/)
  // 冒用运行标签的其他会话：父会话不对，定向门禁不认；精确门禁不在它的作用域链上，批准与它无关。
  const stranger = await f.scoped('stranger-session', f.workspace, 'someone-else')
  stranger.events.push({ type: 'subagent/descriptor', data: { label: f.requests[0]!.label } })
  await f.exec('write', params, stranger.agent)
  assert.equal(f.approvals.hasUsableApproval(call), true, '其他代理都没能消费这条批准')
  assert.equal(f.approvals.operations(task.taskId).length, 0)

  assert.equal((await f.exec('write', params)).isError, false, '只有精确子代理能执行这一次')
  assert.equal(f.approvals.operations(task.taskId)[0]?.state, 'succeeded')
  f.finish()
  await pending
})

test('工具体报错记 unknown：任务进 unknown，不再领取，模型 summary 也改不成成功', async t => {
  const f = await sideEffectHost(t)
  f.fail('bash')
  const { task, pending } = await f.startSideEffect()
  const call = f.exec('bash', { command: 'deploy --prod' })
  const card = await f.pendingCard()
  assert.equal(card.risk, 'high', '命令类按高风险走独立确认')
  f.approvals.issue(card.proposalId, desktop, true)
  assert.equal((await call).isError, true)
  assert.equal(f.approvals.operations(task.taskId)[0]?.state, 'unknown')
  f.finish({ ...completed, structured: { ...report, summary: '模型声称部署成功' } })
  const outcome = await pending
  assert.equal(outcome?.task.status, 'unknown')
  assert.match(outcome?.diagnostic ?? '', /结果不明/)
  await f.team.runReady(f.parent, new AbortController().signal)
  await f.team.runTask(task.taskId, f.parent, new AbortController().signal)
  assert.equal(f.requests.length, 1, '结果不明的任务不会被自动重新领取')
  assert.deepEqual(f.bodies, ['bash'])
})

test('副作用并发上限：启动中的副作用任务占住额度，第二个排队', async t => {
  const f = await sideEffectHost(t)
  const gate = deferred<void>()
  f.setOnStart(() => gate.promise)
  const first = f.team.submitTask({ goal: '第一个副作用', ownerId: 'member-tangseng', toolScope: 'side-effect' })
  const pending = f.team.runTask(first.taskId, f.parent, new AbortController().signal)
  const second = f.team.submitTask({ goal: '第二个副作用', ownerId: 'member-tangseng', toolScope: 'side-effect' })
  const queued = await f.team.runTask(second.taskId, f.parent, new AbortController().signal)
  assert.equal(queued?.task.status, 'queued')
  assert.match(queued?.diagnostic ?? '', /副作用执行额度已满/)
  assert.equal(f.requests.length, 1)
  gate.resolve()
  f.finish()
  await pending
})

test('没有工作区时写类工具不放行；宿主工具参数不带门禁字段时副作用任务如实拒启', async t => {
  const f = await sideEffectHost(t, { noWorkspace: true })
  const { pending } = await f.startSideEffect()
  assert.deepEqual(f.requests[0]!.toolFilter, { allow: ['read', 'grep', 'bash'] })
  assert.equal((await f.exec('write', { file_path: 'a.txt', content: 'x' })).isError, true)
  f.finish()
  await pending

  const g = await sideEffectHost(t, { tools: { read: ['file_path'], write: ['path', 'content'] } })
  const task = g.team.submitTask({ goal: '字段对不上', ownerId: 'member-tangseng', toolScope: 'side-effect' })
  const outcome = await g.team.runTask(task.taskId, g.parent, new AbortController().signal)
  assert.equal(outcome?.stopReason, 'side-effect-unsupported')
  assert.equal(outcome?.task.status, 'review')
  assert.equal(g.requests.length, 0)
})

test('取消正在等批准的任务：等待中的调用拒绝且不执行，审批卡随之作废', async t => {
  const f = await sideEffectHost(t)
  const { task, pending } = await f.startSideEffect()
  const call = f.exec('write', { file_path: path.join(f.workspace, 'a.txt'), content: '取消前' })
  const card = await f.pendingCard()
  await f.team.cancelTask(task.taskId)
  const denied = await call
  assert.equal(denied.isError, true)
  assert.equal(f.approvals.proposal(card.proposalId)?.state, 'expired')
  assert.equal(f.bodies.length, 0)
  f.finish()
  assert.equal((await pending)?.task.status, 'cancelled')
})

test('释放失败：门禁与额度先于子代理静止不释放，任务与未结算操作保持 unknown，退出只重试释放', async t => {
  const f = await sideEffectHost(t)
  let attempts = 0
  f.setDispose(async () => { attempts += 1; if (attempts === 1) throw new Error('释放未完成') })
  const body = deferred<void>()
  f.hang('bash', body.promise)
  const { task, pending } = await f.startSideEffect()
  const call = f.exec('bash', { command: 'long-running' })
  const card = await f.pendingCard()
  f.approvals.issue(card.proposalId, desktop, true)
  await waitFor(() => f.approvals.operations(task.taskId)[0]?.state === 'running', '工具体开始执行')
  f.finish()
  const outcome = await pending
  assert.equal(outcome?.task.status, 'unknown')
  assert.equal(f.approvals.operations(task.taskId)[0]?.state, 'unknown')
  assert.equal(f.team.runningCount(), 1, '额度没有先于静止释放')
  assert.equal((await f.exec('todo_write', { todos: '[]' })).isError, true, '门禁仍在，允许集合照样生效')
  const late = await f.exec('write', { file_path: path.join(f.workspace, 'late.txt'), content: '任务已停止' })
  assert.equal(late.isError, true)
  assert.match(JSON.stringify(late.content), /不在运行中/)
  assert.equal(f.approvals.pendingProposals().length, 0, '离开运行中的任务不再发审批卡')
  body.resolve()
  await call
  assert.equal(f.store.getTask(task.taskId)?.status, 'unknown', '迟到的工具结果只更新账目，不改任务结论')
  await f.team.dispose()
  assert.equal(attempts, 2)
  assert.equal(f.team.runningCount(), 0)
  assert.equal(f.requests.length, 1, '退出只重试释放，不重发任务')
  assert.equal((await f.exec('todo_write', { todos: '[]' })).isError, false, '静止后门禁才释放')
})
