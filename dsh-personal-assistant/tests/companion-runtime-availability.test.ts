import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { ApprovalService } from '../src/approval.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'
import { TeamStore } from '../src/team-domain.ts'

const START = Date.parse('2026-10-27T10:00:00Z')

function fixture(t: TestContext, canRetryBusy: () => boolean = () => true) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: START })
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-lock-'))
  const file = path.join(dir, 'team.sqlite')
  const store = new TeamStore(file)
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'test-epoch' })
  const logs: string[] = []
  const runtime = new CompanionTaskRuntime(store, approvals, { epoch: 'test-epoch', log: message => logs.push(message), canRetryBusy })
  runtime.attachSettings({ getReminderInterval: () => 60, request: async () => ({ status: 200, body: { revision: 1 } }) })
  runtime.start()
  const other = new DatabaseSync(file)
  let locked = false
  t.after(async () => {
    if (locked) other.exec('ROLLBACK')
    other.close()
    await runtime.dispose()
    store.close()
    rmSync(dir, { recursive: true, force: true })
    t.mock.timers.reset()
  })
  return {
    store, runtime, other, logs,
    lock() { other.exec('BEGIN IMMEDIATE'); locked = true },
    unlock() { other.exec('ROLLBACK'); locked = false },
    tick(ms = 1000) { t.mock.timers.tick(ms) },
  }
}

async function createReminder(runtime: CompanionTaskRuntime) {
  const input = await runtime.request('POST', '/companion/v1/inputs', {
    kind: 'reminder', message: '隔离测试提醒', schedule: { kind: 'once', timezone: 'UTC', runAt: new Date(START + 2000).toISOString() },
    repeatEverySeconds: 60, relatedBusinessTaskId: null, channel: 'desktop',
  }, 'owner')
  assert.equal(input.status, 201)
  const created = await runtime.request('POST', '/companion/v1/tasks', {
    protocolVersion: 1, commandId: 'test-create', expiresAt: new Date(START + 60_000).toISOString(),
    payload: { kind: 'reminder', title: '隔离测试', inputRef: (input.body as { inputRef: string }).inputRef, dependsOn: [] },
  }, 'owner')
  assert.ok(created.status >= 200 && created.status < 300)
}

test('另一个 SQLite 连接短暂占写锁时不永久停线，解锁后只产生一次提醒', async t => {
  const f = fixture(t)
  await createReminder(f.runtime)
  f.lock()
  f.tick()
  f.tick()
  assert.equal(f.logs.filter(message => message.includes('繁忙')).length, 1, '持续占锁只记录一次，不能刷屏')
  assert.equal((await f.runtime.request('GET', '/companion/v1/settings', null, 'owner')).status, 200)
  assert.equal((await f.runtime.request('GET', '/executor/v1/reminders', null, 'executor')).status, 200)
  assert.equal(f.store.listReminderDeliveries().length, 0)
  f.unlock()
  f.tick()
  assert.ok(f.logs.some(message => message.includes('恢复')))
  const deliveries = (await f.runtime.request('GET', '/executor/v1/reminders', null, 'executor')).body as { deliveries: Array<{ deliveryId: string }> }
  assert.equal(deliveries.deliveries.length, 1)
  f.tick(5000)
  assert.equal(f.store.listReminderDeliveries().length, 1, '反复调度不能重复生成同一轮投递')
  const claimed = await f.runtime.request('POST', `/executor/v1/reminders/${deliveries.deliveries[0]!.deliveryId}/claim`, { executorEpoch: 'test-epoch' }, 'executor')
  assert.equal(claimed.status, 200)
  assert.equal((await f.runtime.request('POST', `/executor/v1/reminders/${deliveries.deliveries[0]!.deliveryId}/claim`, { executorEpoch: 'test-epoch' }, 'executor')).status, 409)
  assert.equal((await f.runtime.request('POST', `/executor/v1/reminders/${deliveries.deliveries[0]!.deliveryId}/receipt`, {
    executorEpoch: 'test-epoch', state: 'succeeded', evidenceRefs: ['synthetic:notification'],
  }, 'executor')).status, 200)
  f.tick(5000)
  assert.equal(f.store.listReminderDeliveries().length, 1, '成功回执后不能自动重发')
})

test('已回滚的写锁错误才能重试，事务中已做的改动不能留下', async t => {
  const f = fixture(t)
  f.lock()
  let busy: unknown
  try { f.store.pruneCompanionContexts(0) } catch (error) { busy = error }
  f.unlock()
  assert.equal((busy as { code: string; errcode: number }).code, 'ERR_SQLITE_ERROR')
  assert.equal((busy as { errcode: number }).errcode, 5)
  f.store.saveCompanionContext({ contextId: 'synthetic-context', principalId: f.runtime.principalId, deviceId: f.runtime.deviceId,
    url: 'https://example.invalid/', title: '', selection: '', text: '', truncated: false,
    capturedAt: START - 200_000_000, expiresAt: START - 100_000_000, usedAt: null })
  const original = f.store.pruneCompanionContexts.bind(f.store)
  let inject = true
  f.store.pruneCompanionContexts = cutoff => {
    const result = original(cutoff)
    if (inject) { inject = false; throw busy }
    return result
  }
  f.tick()
  assert.equal(f.store.listCompanionContexts().length, 1, '失败事务必须回滚，不能留下部分清理结果')
  assert.equal((await f.runtime.request('GET', '/companion/v1/settings', null, 'owner')).status, 200)
  f.tick()
  assert.equal(f.store.listCompanionContexts().length, 0, '下一拍仅在完整事务成功后提交')
})

test('已进入业务调度后的锁错误也必须停线，不能重放可能已通知的内存事件', async t => {
  const f = fixture(t)
  f.lock()
  let busy: unknown
  try { f.store.pruneCompanionContexts(0) } catch (error) { busy = error }
  f.unlock()
  f.store.pendingMeetingMailFollowups = () => { throw busy }
  f.tick()
  assert.equal((await f.runtime.request('GET', '/executor/v1/reminders', null, 'executor')).status, 503)
})

test('回滚本身失败时即使错误码是写锁也必须停线', async t => {
  const f = fixture(t)
  f.lock()
  let busy: unknown
  try { f.store.pruneCompanionContexts(0) } catch (error) { busy = error }
  f.unlock()
  const db = (f.store as unknown as { db: DatabaseSync }).db
  const exec = db.exec.bind(db)
  db.exec = (sql: string) => {
    if (sql === 'ROLLBACK') throw busy
    return exec(sql)
  }
  f.store.pruneCompanionContexts = () => { throw busy }
  try {
    f.tick()
    assert.equal((await f.runtime.request('GET', '/companion/v1/settings', null, 'owner')).status, 503)
  } finally {
    db.exec = exec
    exec('ROLLBACK')
  }
  f.tick(3000)
  assert.equal((await f.runtime.request('GET', '/executor/v1/reminders', null, 'executor')).status, 503)
})

test('在前置游标读取遇到扩展写锁错误时重试，主动停线后不再恢复', async t => {
  const f = fixture(t)
  const original = f.store.companionEventCursor.bind(f.store)
  let inject = true
  f.store.companionEventCursor = principalId => {
    if (inject) { inject = false; throw Object.assign(new Error('不能记录的内部信息'), { code: 'ERR_SQLITE_ERROR', errcode: 517 }) }
    return original(principalId)
  }
  f.tick()
  assert.equal((await f.runtime.request('GET', '/companion/v1/settings', null, 'owner')).status, 200)
  assert.ok(f.logs.some(message => message.includes('517')))
  assert.ok(f.logs.every(message => !message.includes('不能记录的内部信息')))
  f.runtime.stopAccepting()
  f.tick(3000)
  assert.equal((await f.runtime.request('GET', '/companion/v1/settings', null, 'owner')).status, 503)
})

test('已不是当前桥接的运行时遇到锁时停线，不参与自动重试', async t => {
  const f = fixture(t, () => false)
  f.lock()
  f.tick()
  assert.equal((await f.runtime.request('GET', '/companion/v1/settings', null, 'owner')).status, 503)
  f.unlock()
  f.tick(3000)
  assert.equal((await f.runtime.request('GET', '/executor/v1/reminders', null, 'executor')).status, 503)
})

test('等待锁释放时桥接归属改变，不得继续执行旧运行时', async t => {
  let owner = true
  const f = fixture(t, () => owner)
  f.lock()
  f.tick()
  assert.equal((await f.runtime.request('GET', '/companion/v1/settings', null, 'owner')).status, 200)
  owner = false
  f.unlock()
  f.tick()
  assert.equal((await f.runtime.request('GET', '/companion/v1/settings', null, 'owner')).status, 503)
})

test('未知调度异常仍然停线，不能靠重试掩盖数据问题', async t => {
  const f = fixture(t)
  const original = f.store.pendingMeetingMailFollowups.bind(f.store)
  f.store.pendingMeetingMailFollowups = () => { throw new Error('隔离测试中的未知异常') }
  f.tick()
  assert.equal((await f.runtime.request('GET', '/companion/v1/settings', null, 'owner')).status, 503)
  assert.ok(f.logs.some(message => message.includes('停止') && message.includes('Error')))
  assert.ok(f.logs.every(message => !message.includes('隔离测试中的未知异常')), '不能把异常中可能含有的用户内容写入日志')
  f.store.pendingMeetingMailFollowups = original
  f.tick(3000)
  assert.equal((await f.runtime.request('GET', '/executor/v1/reminders', null, 'executor')).status, 503)
})
