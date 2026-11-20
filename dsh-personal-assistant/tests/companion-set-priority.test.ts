/**
 * 改优先级：走既有可信审批通道（`manage_companion_task`），四条护栏。
 *
 * 这条命令的写操作只经 `consumeTrusted` 一条路：没有获批的提案就落不了库。
 * 测试要证明的正是这一点 —— 不是"能改"，而是"**没批准就改不了**"。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'

import { ApprovalService } from '../src/approval.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'
import { TeamStore } from '../src/team-domain.ts'
import { formatTodoList } from '../src/workbench-lists.ts'

function fixture(t: TestContext) {
  const store = new TeamStore(':memory:')
  let now = Date.parse('2026-10-28T10:00:00Z')
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'test' })
  const runtime = new CompanionTaskRuntime(store, approvals, { epoch: 'test', now: () => now })
  t.after(async () => { await runtime.dispose(); store.close() })
  const command = (payload: unknown) => ({ protocolVersion: 1 as const, commandId: randomUUID(),
    expiresAt: new Date(now + 60_000).toISOString(), payload })

  /** 建一条人工待办（agent/manual）——优先级最常改的就是它。 */
  const createManual = async (title: string) => {
    const registered = await runtime.request('POST', '/companion/v1/inputs', {
      kind: 'agent', executionMode: 'manual', description: title,
    }, 'owner')
    assert.equal(registered.status, 201)
    const inputRef = (registered.body as { inputRef: string }).inputRef
    const created = await runtime.request('POST', '/companion/v1/tasks',
      command({ kind: 'agent', title, inputRef, dependsOn: [] }), 'owner')
    assert.equal(created.status, 202)
    return (created.body as { task: { taskId: string } }).task.taskId
  }

  const setPriority = (taskId: string, priority: unknown, subject: 'owner' | 'client' = 'owner') => {
    const task = store.getTask(taskId)!
    return runtime.request('POST', `/companion/v1/tasks/${taskId}/set-priority`,
      { ...command({ priority }), taskId, expectedRevision: task.revision }, subject)
  }
  return { store, runtime, createManual, setPriority, now: () => now }
}

test('批准后能改：revision + 1，状态不变', async (t) => {
  const f = fixture(t)
  const id = await f.createManual('改讲解链路')
  const before = f.store.getTask(id)!
  assert.equal(before.priority, 'normal')

  const result = await f.setPriority(id, 'high')
  assert.equal(result.status, 202)

  const after = f.store.getTask(id)!
  assert.equal(after.priority, 'high')
  assert.equal(after.revision, before.revision + 1, 'revision 必须 +1')
  // 改优先级不该让任务跳状态：进行中的任务不能被"标成高优先级"打回队列。
  assert.equal(after.status, before.status, '状态必须不变')
  // updatedAt 由 runtime 的 now() 决定（夹具里是固定时钟），不额外断言大小 ——
  // 那会让"时间没往前走"也变成红，和这条护栏无关。
  assert.equal(after.updatedAt, f.now())
})

test('未批准拒绝：走聊天侧提交但没批，库里一个字段都不变', async (t) => {
  const f = fixture(t)
  const id = await f.createManual('未批准的改动')
  const before = f.store.getTask(id)!

  // client 侧只能提交待批提案；没有获批就执行不了。
  const submitted = await f.setPriority(id, 'high', 'client')
  assert.equal(submitted.status, 202, '提交本身可以成功（变成待批提案）')

  const after = f.store.getTask(id)!
  assert.equal(after.priority, before.priority, '没有可信审批，优先级不得改变')
  assert.equal(after.revision, before.revision, 'revision 也不得变化')
})

test('非法值拒绝：urgent / 空串 / 大写 HIGH 都不接受', async (t) => {
  const f = fixture(t)
  const id = await f.createManual('非法优先级')
  const before = f.store.getTask(id)!
  for (const bad of ['urgent', '', 'HIGH', null, 3]) {
    const result = await f.setPriority(id, bad)
    assert.equal(result.status, 422, `${JSON.stringify(bad)} 应被拒`)
  }
  const after = f.store.getTask(id)!
  assert.equal(after.priority, before.priority)
  assert.equal(after.revision, before.revision)
})

test('改完列表顺序真的变了：high 上浮到最前', async (t) => {
  const f = fixture(t)
  const low = await f.createManual('写周报')
  const middle = await f.createManual('回滚方案')
  // 先让后建的那条更新更晚，确保排序不是碰巧。
  assert.equal((await f.setPriority(low, 'low')).status, 202)
  assert.equal((await f.setPriority(middle, 'normal')).status, 202)

  const rows = () => f.store.listTasks({ runtimeScope: 'companion' }).map(task => ({
    goal: task.goal, status: task.status, deadlineAt: task.deadlineAt,
    priority: task.priority, source: task.source, updatedAt: task.updatedAt,
  }))
  const before = formatTodoList(rows()).split('\n').map(line => line.split(' | ')[0])
  assert.deepEqual(before.slice(0, 2), ['回滚方案', '写周报'], '先按正常顺序')

  assert.equal((await f.setPriority(low, 'high')).status, 202)
  const after = formatTodoList(rows()).split('\n').map(line => line.split(' | ')[0])
  assert.equal(after[0], '写周报', '改成 high 之后必须排到最前')
  assert.notDeepEqual(after, before, '顺序确实变了，不只是列变了')
})
