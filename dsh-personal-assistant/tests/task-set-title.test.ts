/**
 * 改标题（set-title）：与改优先级同一条可信审批通道，四条护栏。
 *
 * 标题是列表第一列，改它不该动状态/日程/提醒周期；没获批就一个字都不能落库。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'

import { ApprovalService } from '../src/approval.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'
import { TeamStore } from '../src/team-domain.ts'

function fixture(t: TestContext) {
  const store = new TeamStore(':memory:')
  const now = Date.parse('2026-11-17T10:00:00Z')
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'test' })
  const runtime = new CompanionTaskRuntime(store, approvals, { epoch: 'test', now: () => now })
  t.after(async () => { await runtime.dispose(); store.close() })
  const command = (payload: unknown) => ({ protocolVersion: 1 as const, commandId: randomUUID(),
    expiresAt: new Date(now + 60_000).toISOString(), payload })

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

  const setTitle = (taskId: string, title: unknown, subject: 'owner' | 'client' = 'owner') => {
    const task = store.getTask(taskId)!
    return runtime.request('POST', `/companion/v1/tasks/${taskId}/set-title`,
      { ...command({ title }), taskId, expectedRevision: task.revision }, subject)
  }
  return { store, runtime, createManual, setTitle }
}

test('批准后能改标题：goal 更新、revision +1、状态不变', async (t) => {
  const f = fixture(t)
  const id = await f.createManual('旧标题')
  const before = f.store.getTask(id)!
  const result = await f.setTitle(id, '新标题')
  assert.equal(result.status, 202)
  const after = f.store.getTask(id)!
  assert.equal(after.goal, '新标题')
  assert.equal(after.revision, before.revision + 1)
  assert.equal(after.status, before.status, '改名字不该让任务跳状态')
})

test('未批准拒绝：client 提交只成提案，库里标题不变', async (t) => {
  const f = fixture(t)
  const id = await f.createManual('未批准')
  const before = f.store.getTask(id)!
  const submitted = await f.setTitle(id, '想改但没批', 'client')
  assert.equal(submitted.status, 202)
  const after = f.store.getTask(id)!
  assert.equal(after.goal, before.goal)
  assert.equal(after.revision, before.revision)
})

test('非法标题拒绝：空串 / 纯空白 / 超长都不接受', async (t) => {
  const f = fixture(t)
  const id = await f.createManual('非法标题')
  const before = f.store.getTask(id)!
  for (const bad of ['', '   ', 'x'.repeat(201), null, 3]) {
    const result = await f.setTitle(id, bad)
    assert.equal(result.status, 422, `${JSON.stringify(bad)} 应被拒`)
  }
  const after = f.store.getTask(id)!
  assert.equal(after.goal, before.goal)
  assert.equal(after.revision, before.revision)
})

test('标题去首尾空白后落库', async (t) => {
  const f = fixture(t)
  const id = await f.createManual('带空白')
  assert.equal((await f.setTitle(id, '  整理后的标题  ')).status, 202)
  assert.equal(f.store.getTask(id)!.goal, '整理后的标题')
})
