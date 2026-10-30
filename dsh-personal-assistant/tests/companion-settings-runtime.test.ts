import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { ApprovalService } from '../src/approval.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'
import { TeamStore } from '../src/team-domain.ts'

function fixture(t: TestContext) {
  const store = new TeamStore(':memory:')
  let now = Date.parse('2026-10-28T10:00:00Z')
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'test' })
  const runtime = new CompanionTaskRuntime(store, approvals, { epoch: 'test', now: () => now })
  t.after(async () => { await runtime.dispose(); store.close() })
  let interval = 420
  let calls = 0
  runtime.attachSettings({ getReminderInterval: () => interval, request: async () => { calls++; return { status: 200, body: {} } } })
  const command = (payload: unknown) => ({ protocolVersion: 1, commandId: randomUUID(), expiresAt: new Date(now + 60_000).toISOString(), payload })
  const create = async (seconds?: number) => {
    const registered = await runtime.request('POST', '/companion/v1/inputs', { kind: 'reminder', message: '测试', channel: 'desktop',
      schedule: { kind: 'once', timezone: 'UTC', runAt: new Date(now + 2000).toISOString() },
      ...(seconds === undefined ? {} : { repeatEverySeconds: seconds }) }, 'owner')
    assert.equal(registered.status, 201)
    const inputRef = (registered.body as { inputRef: string }).inputRef
    const created = await runtime.request('POST', '/companion/v1/tasks', command({ kind: 'reminder', title: '配置测试', inputRef, dependsOn: [] }), 'owner')
    assert.equal(created.status, 202)
    return (created.body as { task: { taskId: string } }).task.taskId
  }
  const tick = (ms: number) => { now += ms; (runtime as unknown as { tick(): void }).tick() }
  const change = (taskId: string, seconds: number, revision = store.getTask(taskId)!.revision) => runtime.request('POST', `/companion/v1/tasks/${taskId}/set-interval`,
    { ...command({ repeatEverySeconds: seconds }), taskId, expectedRevision: revision }, 'owner')
  const inputOf = (id: string) => store.getCompanionInput(store.getCompanionMeta(id)!.inputRef)!.input
  return { store, runtime, create, tick, change, inputOf, command, now: () => now, setDefault: (seconds: number) => { interval = seconds }, calls: () => calls }
}

test('配置接口仅所有者可用，默认间隔可读且创建时实时读取', async t => {
  const f = fixture(t)
  for (const subject of ['client', 'executor'] as const) {
    assert.equal((await f.runtime.request('GET', '/companion/v1/settings', null, subject)).status, 403)
    assert.equal((await f.runtime.request('POST', '/companion/v1/settings/wecom', {}, subject)).status, 403)
  }
  assert.equal(f.calls(), 0)
  assert.equal((await f.runtime.request('GET', '/companion/v1/settings', null, 'owner')).status, 200)
  assert.equal(f.calls(), 1)
  assert.deepEqual((await f.runtime.request('GET', '/companion/v1/reminder-defaults', null, 'client')).body, { repeatEverySeconds: 420 })
  const old = await f.create()
  f.setDefault(900)
  const next = await f.create()
  const explicit = await f.create(120)
  assert.equal((f.inputOf(old) as { repeatEverySeconds: number }).repeatEverySeconds, 420)
  assert.equal((f.inputOf(next) as { repeatEverySeconds: number }).repeatEverySeconds, 900)
  assert.equal((f.inputOf(explicit) as { repeatEverySeconds: number }).repeatEverySeconds, 120)
})

test('单条修改保留首次调度，拒绝旧修订、越权及非法值', async t => {
  const f = fixture(t)
  const id = await f.create()
  const firstAt = f.store.listCompanionSchedules()[0]!.nextRunAt
  const revision = f.store.getTask(id)!.revision
  assert.equal((await f.change(id, 59)).status, 422)
  assert.equal((await f.runtime.request('POST', `/companion/v1/tasks/${id}/set-interval`, {
    ...f.command({ repeatEverySeconds: 60 }), taskId: id, expectedRevision: revision,
  }, 'client')).status, 403)
  assert.equal((await f.change(id, 60)).status, 202)
  assert.equal(f.store.listCompanionSchedules()[0]!.nextRunAt, firstAt)
  assert.equal((await f.change(id, 120, revision)).status, 409)
  assert.equal((f.inputOf(id) as { repeatEverySeconds: number }).repeatEverySeconds, 60)
  f.tick(3000)
  assert.equal(f.runtime.listChannelDeliveries('desktop').length, 1)
})

test('当前周期按新间隔催办，不复用旧待发送投递，不在发送中修改', async t => {
  const f = fixture(t)
  const id = await f.create(300)
  f.tick(3000)
  const old = f.runtime.listChannelDeliveries('desktop')[0]!
  f.runtime.claimChannelDelivery(old.deliveryId)
  assert.equal((await f.change(id, 60)).status, 409)
  f.runtime.receiptChannelDelivery(old.deliveryId, 'succeeded', ['测试回执'])
  assert.equal((await f.change(id, 60)).status, 202)
  const cycle = f.store.listReminderCycles()[0]!
  assert.equal(cycle.repeatIntervalMs, 60000)
  assert.equal(cycle.nextNagAt, f.now() + 60000)
  assert.equal((f.inputOf(cycle.childTaskId) as { repeatEverySeconds: number }).repeatEverySeconds, 60)
  f.tick(59000)
  assert.equal(f.runtime.listChannelDeliveries('desktop').length, 0)
  f.tick(1000)
  const pending = f.runtime.listChannelDeliveries('desktop')[0]!
  assert.ok(pending)
  assert.equal((await f.change(id, 120)).status, 202)
  assert.equal(f.store.getReminderDelivery(pending.deliveryId)!.state, 'cancelled')
  assert.equal(f.runtime.listChannelDeliveries('desktop').length, 0)
  f.tick(120000)
  assert.equal(f.runtime.listChannelDeliveries('desktop').length, 1)
})

test('修改间隔不恢复已暂停计划，也不缩短本人延后时间', async t => {
  const f = fixture(t)
  const id = await f.create()
  f.tick(3000)
  const delivery = f.runtime.listChannelDeliveries('desktop')[0]!
  f.runtime.claimChannelDelivery(delivery.deliveryId)
  f.runtime.receiptChannelDelivery(delivery.deliveryId, 'succeeded', [])
  const cycle = f.store.listReminderCycles()[0]!
  const until = f.now() + 3600000
  const response = await f.runtime.request('POST', `/companion/v1/reminders/${cycle.cycleId}/respond`, {
    ...f.command({ cycleId: cycle.cycleId, expectedCycleRevision: cycle.revision, action: 'snooze', snoozedUntil: new Date(until).toISOString() }),
    taskId: cycle.childTaskId, expectedRevision: f.store.getTask(cycle.childTaskId)!.revision,
  }, 'owner')
  assert.equal(response.status, 202)
  assert.equal((await f.change(id, 60)).status, 202)
  assert.equal(f.store.getReminderCycle(cycle.cycleId)!.nextNagAt, until)
  const paused = await f.runtime.request('POST', `/companion/v1/tasks/${id}/pause`, {
    ...f.command({}), taskId: id, expectedRevision: f.store.getTask(id)!.revision,
  }, 'owner')
  assert.equal(paused.status, 202)
  assert.equal((await f.change(id, 120)).status, 202)
  assert.equal(f.store.getCompanionMeta(id)!.blocker, 'manual-pause')
  assert.equal(f.store.listCompanionSchedules()[0]!.enabled, false)
  f.tick(3600001)
  assert.equal(f.runtime.listChannelDeliveries('desktop').length, 0)
})
