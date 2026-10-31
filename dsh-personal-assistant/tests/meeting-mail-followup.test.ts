/** 全部使用隔离 SQLite 和模拟时钟；不连接邮件或企业微信。 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { ApprovalService } from '../src/approval.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'
import { TeamStore } from '../src/team-domain.ts'

const BOT = 'a'.repeat(64)
const OTHER_BOT = 'b'.repeat(64)
const RECIPIENT = 'wecom:single:主人'

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-meeting-mail-followup-'))
  const file = path.join(dir, 'team.sqlite')
  let now = 1_800_000_000_000
  let account: string | null = BOT
  let store = new TeamStore(file)
  const makeRuntime = () => {
    const approvals = new ApprovalService(store, { ttlMs: 120_000, runtimeEpoch: 'test-epoch', now: () => now })
    const runtime = new CompanionTaskRuntime(store, approvals, { epoch: 'test-epoch', now: () => now,
      acceptsRecipient: (channel, recipient) => channel === 'wecom' && recipient === RECIPIENT })
    runtime.setChannelAccountKey(() => account)
    return runtime
  }
  let runtime = makeRuntime()
  t.after(async () => { await runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const prepare = (id: string) => {
    assert.equal(store.beginMailSend({ intentId: id, accountKey: 'mail-account', digest: 'mail-digest-' + id,
      subject: '会议纪要', recipients: ['a@example.com'], epoch: 'test-epoch' }, now), true)
    store.insertMeetingMailFollowup({ intentId: id, artifactId: 'artifact-1', meetingId: `meeting-${id}`, revision: 1,
      recipientRef: RECIPIENT, channelAccountKey: BOT, repeatEverySeconds: 60, approvalId: 'approved-snapshot', createdAt: now })
  }
  return { get store() { return store }, get runtime() { return runtime }, prepare, now: () => now,
    advance: (ms: number) => { now += ms }, setAccount: (key: string | null) => { account = key },
    tick: () => (runtime as unknown as { tick(): void }).tick(),
    async restart() { await runtime.dispose(); store.close(); store = new TeamStore(file); runtime = makeRuntime() } }
}

test('仅完整接受后创建一次提醒，以服务接受时间加两分钟为锚，本人回应后停止', async t => {
  const f = fixture(t)
  f.prepare('mail-1')
  assert.equal(f.runtime.ensureMeetingMailReminder('mail-1'), null)
  assert.equal(f.store.listCompanionSchedules().length, 0)
  const acceptedAt = f.now() + 10_000
  f.advance(10_000)
  assert.equal(f.store.finishMailSend('mail-1', 'test-epoch', 'accepted', { accepted: ['a@example.com'], rejected: [] }, acceptedAt), true)
  const taskId = f.runtime.ensureMeetingMailReminder('mail-1')
  assert.ok(taskId)
  assert.equal(f.runtime.ensureMeetingMailReminder('mail-1'), taskId)
  const schedules = f.store.listCompanionSchedules()
  assert.equal(schedules.length, 1)
  assert.equal(schedules[0]!.taskId, taskId)
  assert.equal(schedules[0]!.nextRunAt, acceptedAt + 120_000)
  f.advance(119_999); f.tick()
  assert.equal(f.runtime.listChannelDeliveries('wecom').length, 0)
  f.advance(1); f.tick()
  f.setAccount(OTHER_BOT)
  assert.equal(f.runtime.listChannelDeliveries('wecom').length, 0, '更换机器人不能继承原提醒授权')
  f.setAccount(BOT)
  const [delivery] = f.runtime.listChannelDeliveries('wecom')
  assert.ok(delivery)
  assert.equal(f.runtime.claimChannelDelivery(delivery.deliveryId), true)
  f.runtime.receiptChannelDelivery(delivery.deliveryId, 'succeeded', [`wecom:${delivery.operationId}`])
  assert.equal(f.runtime.respondChannelReminder(RECIPIENT, { action: 'ack' }, OTHER_BOT).handled, false)
  assert.equal(f.runtime.respondChannelReminder(RECIPIENT, { action: 'ack' }, BOT).handled, true)
  f.advance(600_000); f.tick()
  assert.equal(f.runtime.listChannelDeliveries('wecom').length, 0)
})

test('部分或未知回执不能创建提醒，即便部分接受有 acceptedAt', t => {
  const f = fixture(t)
  for (const state of ['partial', 'unknown'] as const) {
    const id = `mail-${state}`
    f.prepare(id)
    assert.equal(f.store.finishMailSend(id, 'test-epoch', state, { accepted: state === 'partial' ? ['a@example.com'] : [], rejected: [] }, f.now()), true)
    assert.equal(f.runtime.ensureMeetingMailReminder(id), null)
    assert.equal(f.store.getMeetingMailFollowup(id)?.taskId, null)
  }
  f.tick()
  assert.equal(f.store.listCompanionSchedules().length, 0)
})

test('接受回执持久化后崩溃，重启可恢复同一提醒而不重新发信', async t => {
  const f = fixture(t)
  f.prepare('mail-restart')
  const acceptedAt = f.now()
  assert.equal(f.store.finishMailSend('mail-restart', 'test-epoch', 'accepted', { accepted: ['a@example.com'] }, acceptedAt), true)
  f.advance(180_000)
  await f.restart()
  f.setAccount(null)
  f.runtime.start()
  const plan = f.store.getMeetingMailFollowup('mail-restart')
  assert.ok(plan?.taskId)
  assert.equal(f.store.listCompanionSchedules()[0]!.spec.kind, 'once')
  assert.equal(Date.parse((f.store.listCompanionSchedules()[0]!.spec as { runAt: string }).runAt), acceptedAt + 120_000)
  assert.equal(f.runtime.listChannelDeliveries('wecom').length, 0)
  f.setAccount(BOT)
  assert.equal(f.runtime.listChannelDeliveries('wecom').length, 1, '离线时错过的时间按原锚点补提醒')
  f.tick()
  assert.equal(f.store.listCompanionSchedules().length, 1)
})

test('登记提醒失败时任务和日程整体回滚，可按同一发送回执安全恢复', t => {
  const f = fixture(t)
  f.prepare('mail-rollback')
  assert.equal(f.store.finishMailSend('mail-rollback', 'test-epoch', 'accepted', { accepted: ['a@example.com'] }, f.now()), true)
  const bind = f.store.bindMeetingMailFollowup.bind(f.store)
  f.store.bindMeetingMailFollowup = () => { throw new Error('模拟登记失败') }
  assert.throws(() => f.runtime.ensureMeetingMailReminder('mail-rollback'), /模拟登记失败/u)
  assert.equal(f.store.getMeetingMailFollowup('mail-rollback')?.taskId, null)
  assert.equal(f.store.listCompanionSchedules().length, 0)
  assert.equal(f.store.listTasks({ runtimeScope: 'companion' }).length, 0)
  f.store.bindMeetingMailFollowup = bind
  assert.ok(f.runtime.ensureMeetingMailReminder('mail-rollback'))
  assert.equal(f.store.listCompanionSchedules().length, 1)
})
