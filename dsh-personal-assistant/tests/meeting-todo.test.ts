/** 隔离数据库，不读取真实会议库，不调用外部渠道。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { ApprovalService } from '../src/approval.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'
import { TeamStore } from '../src/team-domain.ts'
import { createMeetingTodoHandler } from '../../dsh-pet/src/main/meeting-todo.ts'
import { renderStructuredSections } from '../../dsh-pet/src/main/meeting-minutes.ts'

function fixture(t: TestContext) {
  const store = new TeamStore(':memory:')
  let now = Date.parse('2026-10-27T10:00:00Z')
  const approvals = new ApprovalService(store, { ttlMs: 120_000, runtimeEpoch: 'test', now: () => now })
  const runtime = new CompanionTaskRuntime(store, approvals, { epoch: 'test', now: () => now })
  t.after(async () => { await runtime.dispose(); store.close() })
  const meetingId = 'meeting-1', revision = 2
  const tag = createHash('sha256').update(meetingId).digest('hex').slice(0, 6)
  const input = { meetingId, itemId: 'action-1', meetingName: '项目晨会', revision, digest: 'a'.repeat(64),
    confirmedAt: now, text: '检查测试结果', owner: '张三', due: '周五', sourceRefs: [`M${tag}-R${revision}-S1`] }
  const post = (body: unknown, subject: 'client' | 'owner' = 'owner') => runtime.request('POST', '/companion/v1/meeting-actions/import', body, subject)
  const command = (id: string, payload: unknown) => ({ protocolVersion: 1, commandId: id, expiresAt: new Date(now + 60_000).toISOString(), payload })
  return { store, runtime, input, post, command, now: () => now, advance: (ms: number) => { now += ms }, tick: () => (runtime as any).tick() }
}

test('仅本机确认的行动项进入人工待办；重复导入、完成或取消后均不复活', async t => {
  const f = fixture(t)
  assert.equal((await f.post(f.input, 'client')).status, 403)
  const first = await f.post(f.input)
  assert.equal(first.status, 201, JSON.stringify(first.body))
  const body = first.body as { task: { taskId: string; revision: number; status: string }; duplicate: boolean }
  assert.equal(body.duplicate, false)
  assert.equal(body.task.status, 'awaiting-user')
  assert.equal(f.store.listRuns(body.task.taskId).length, 0)
  const detail = await f.runtime.request('GET', `/companion/v1/tasks/${body.task.taskId}`, null, 'client')
  assert.match(JSON.stringify(detail.body), /项目晨会|检查测试结果/)
  assert.match(JSON.stringify(detail.body), /纪要摘要|会议版本/)
  assert.match(JSON.stringify(detail.body), new RegExp(f.input.sourceRefs[0]))
  const replay = await f.post(f.input)
  assert.equal((replay.body as any).duplicate, true)
  assert.equal((replay.body as any).task.taskId, body.task.taskId)
  const done = await f.runtime.request('POST', `/companion/v1/tasks/${body.task.taskId}/complete`, {
    ...f.command('done', {}), taskId: body.task.taskId, expectedRevision: body.task.revision,
  }, 'owner')
  assert.ok(done.status < 300)
  const again = await f.post(f.input)
  assert.equal((again.body as any).task.taskId, body.task.taskId)
  assert.equal((again.body as any).task.status, 'done')
  assert.equal(f.store.listTasks({ runtimeScope: 'companion' }).length, 1)
  const changed = await f.post({ ...f.input, digest: 'b'.repeat(64), text: '后来修改的其他事项' })
  assert.equal(changed.status, 409)
  assert.equal(f.store.listTasks({ runtimeScope: 'companion' }).length, 1)
})

test('行动项来源缺失、版本或摘要无效时拒绝；登记失败整次回滚', async t => {
  const f = fixture(t)
  for (const invalid of [{ ...f.input, sourceRefs: [] }, { ...f.input, revision: 3 },
    { ...f.input, digest: 'bad' }, { ...f.input, text: '  ' }]) assert.equal((await f.post(invalid)).status, 422)
  const save = f.store.saveMeetingTodoSource.bind(f.store)
  f.store.saveMeetingTodoSource = () => { throw new Error('模拟登记失败') }
  assert.equal((await f.post(f.input)).status, 500)
  assert.equal(f.store.listTasks({ runtimeScope: 'companion' }).length, 0)
  f.store.saveMeetingTodoSource = save
  assert.equal((await f.post(f.input)).status, 201)
})

test('回应提醒不代表会议业务完成；本人完成待办后停止关联催办', async t => {
  const f = fixture(t)
  const created = await f.post(f.input)
  const task = (created.body as any).task
  const prepared = await f.runtime.request('POST', '/companion/v1/inputs', { kind: 'reminder', message: '检查待办',
    schedule: { kind: 'once', timezone: 'UTC', runAt: new Date(f.now() + 1000).toISOString() },
    repeatEverySeconds: 60, relatedBusinessTaskId: task.taskId, channel: 'desktop' }, 'owner')
  const plan = await f.runtime.request('POST', '/companion/v1/tasks', f.command('create-reminder', {
    kind: 'reminder', title: '会议待办提醒', inputRef: (prepared.body as any).inputRef, dependsOn: [],
  }), 'owner')
  assert.ok(plan.status < 300)
  f.advance(2000); f.tick()
  const deliveries = (await f.runtime.request('GET', '/executor/v1/reminders', null, 'executor')).body as { deliveries: any[] }
  assert.equal(deliveries.deliveries.length, 1)
  const delivery = deliveries.deliveries[0]
  await f.runtime.request('POST', `/executor/v1/reminders/${delivery.deliveryId}/claim`, { executorEpoch: 'test' }, 'executor')
  await f.runtime.request('POST', `/executor/v1/reminders/${delivery.deliveryId}/receipt`, { executorEpoch: 'test', state: 'succeeded', evidenceRefs: ['notification:test'] }, 'executor')
  const cycle = f.store.getReminderCycle(delivery.cycleId)!
  const child = f.store.getTask(cycle.childTaskId)!
  const acknowledged = await f.runtime.request('POST', `/companion/v1/reminders/${cycle.cycleId}/respond`, {
    ...f.command('ack', { cycleId: cycle.cycleId, expectedCycleRevision: cycle.revision, action: 'ack', snoozedUntil: null }),
    taskId: child.taskId, expectedRevision: child.revision,
  }, 'owner')
  assert.ok(acknowledged.status < 300)
  assert.equal(f.store.getTask(task.taskId)?.status, 'awaiting-user')
  const done = await f.runtime.request('POST', `/companion/v1/tasks/${task.taskId}/complete`, {
    ...f.command('done', {}), taskId: task.taskId, expectedRevision: task.revision,
  }, 'owner')
  assert.ok(done.status < 300)
  f.advance(120_000); f.tick()
  assert.equal(((await f.runtime.request('GET', '/executor/v1/reminders', null, 'executor')).body as { deliveries: unknown[] }).deliveries.length, 0)
})

test('运行时重启后来源账本仍关联原任务，不重复导入', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'meeting-todo-restart-'))
  const file = path.join(dir, 'team.sqlite'), now = 1_800_000_000_000
  let store = new TeamStore(file)
  let runtime = new CompanionTaskRuntime(store, new ApprovalService(store, { ttlMs: 120_000, runtimeEpoch: 'one', now: () => now }), { epoch: 'one', now: () => now })
  t.after(async () => { await runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const meetingId = 'restart-meeting', tag = createHash('sha256').update(meetingId).digest('hex').slice(0, 6)
  const input = { meetingId, itemId: 'action-1', meetingName: '持久化测试', revision: 1, digest: 'c'.repeat(64),
    confirmedAt: now, text: '确认发布结果', owner: null, due: null, sourceRefs: [`M${tag}-R1-S0`] }
  const first = await runtime.request('POST', '/companion/v1/meeting-actions/import', input, 'owner')
  const taskId = (first.body as any).task.taskId
  await runtime.dispose(); store.close()
  store = new TeamStore(file)
  runtime = new CompanionTaskRuntime(store, new ApprovalService(store, { ttlMs: 120_000, runtimeEpoch: 'two', now: () => now }), { epoch: 'two', now: () => now })
  const replay = await runtime.request('POST', '/companion/v1/meeting-actions/import', input, 'owner')
  assert.equal(replay.status, 200)
  assert.equal((replay.body as any).duplicate, true)
  assert.equal((replay.body as any).task.taskId, taskId)
  assert.equal(store.listTasks({ runtimeScope: 'companion' }).length, 1)
})

test('桌面确认与任务运行时跨模块交接同一版本，不能重复创建', async t => {
  const f = fixture(t), meetingId = 'cross-module', revision = 2
  const tag = createHash('sha256').update(meetingId).digest('hex').slice(0, 6)
  const item = { id: 'action-1', kind: 'action', text: '核查构建结果', status: 'kept', owner: null, due: null,
    ownerOrigin: null, dueOrigin: null, startMs: 1000, endMs: 2000, speakers: ['发言人'], speakersUncertain: false,
    sources: [{ id: `M${tag}-R${revision}-S1`, idx: 1 }] }
  const structured = { version: 1, generator: 'model', basedOnRevision: revision, items: [item] }
  const content = `确认纪要\n${renderStructuredSections(structured as any).join('\n')}\n## 时间线`
  const digest = createHash('sha256').update(content).digest('hex')
  let valid = true
  const handler = createMeetingTodoHandler({
    binding: () => 'binding-1',
    read: () => ({ name: '跨模块会议', view: { ok: true, revision, minutes: { revision, content, digest, state: 'confirmed',
      confirmedAt: f.now(), kind: 'model', structured, stale: !valid }, egress: { active: null, history: [] }, model: { available: false, generating: false } } as any }),
    confirm: async () => true,
    post: value => f.runtime.request('POST', '/companion/v1/meeting-actions/import', value, 'owner'),
  })
  const request = { meetingId, itemId: item.id, revision, digest }
  const first = await handler({}, request), second = await handler({}, request)
  assert.equal(first.ok, true)
  assert.equal(second.duplicate, true)
  assert.equal(second.taskId, first.taskId)
  valid = false
  assert.equal((await handler({}, request)).ok, false)
  assert.equal(f.store.listTasks({ runtimeScope: 'companion' }).length, 1)
})
