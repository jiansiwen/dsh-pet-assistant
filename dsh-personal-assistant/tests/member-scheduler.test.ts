import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { MemberScheduler, type MemberSchedulerDeliverInput } from '../src/member-scheduler.ts'
import { TeamStore, type MemberScheduleRecord } from '../src/team-domain.ts'
import { nextScheduleAt } from '../src/scheduler.ts'

function store(t: TestContext): TeamStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-member-scheduler-'))
  const db = new TeamStore(path.join(dir, 'team.sqlite'))
  t.after(() => { try { db.close() } catch { /* 已关闭 */ } rmSync(dir, { recursive: true, force: true }) })
  return db
}

const NOW = Date.parse('2026-11-19T08:00:00+08:00')

function schedule(overrides: Partial<MemberScheduleRecord> = {}): MemberScheduleRecord {
  return {
    scheduleId: 'sch-1', assistantId: 'member-a', title: '抓热门', prompt: '抓取 GitHub 今日热门并整理清单',
    spec: { kind: 'daily', timezone: 'Asia/Shanghai', localTime: '09:00' },
    channel: 'wecom', recipientId: 'wecom:single:me', enabled: true,
    nextRunAt: NOW - 1000, generation: 1, createdAt: NOW - 100_000,
    lastRunAt: null, lastStatus: null, lastText: null, ...overrides,
  }
}

function harness(t: TestContext, options: { enabled?: boolean; run?: (id: string, prompt: string) => Promise<string>; deliver?: (input: MemberSchedulerDeliverInput) => Promise<boolean> } = {}) {
  const db = store(t)
  const delivered: MemberSchedulerDeliverInput[] = []
  const ran: Array<{ id: string; prompt: string }> = []
  const scheduler = new MemberScheduler({
    store: db,
    enabled: () => options.enabled ?? true,
    run: async (id, prompt) => { ran.push({ id, prompt }); return options.run ? await options.run(id, prompt) : '今日热门：repo-a / repo-b' },
    deliver: async input => { delivered.push(input); return options.deliver ? await options.deliver(input) : true },
    log: () => {},
    now: () => NOW,
  })
  return { db, scheduler, delivered, ran }
}

const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)) }

test('到期 daily 计划：跑成员→投递→推进 nextRunAt→记成功账', async (t) => {
  const { db, scheduler, delivered, ran } = harness(t)
  db.saveMemberSchedule(schedule())
  const { fired } = scheduler.tick()
  assert.equal(fired, 1)
  await settle()
  assert.deepEqual(ran, [{ id: 'member-a', prompt: '抓取 GitHub 今日热门并整理清单' }])
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].channel, 'wecom')
  assert.equal(delivered[0].recipientId, 'wecom:single:me')
  assert.match(delivered[0].text, /repo-a/)
  const after = db.getMemberSchedule('sch-1')!
  assert.equal(after.lastStatus, 'succeeded')
  assert.equal(after.nextRunAt, nextScheduleAt({ kind: 'daily', timezone: 'Asia/Shanghai', localTime: '09:00' }, NOW))
  assert.ok(after.nextRunAt! > NOW)
  assert.equal(after.generation, 2)
  const runs = db.listMemberScheduleRuns('sch-1')
  assert.equal(runs.length, 1)
  assert.equal(runs[0].state, 'succeeded')
})

test('once 计划跑完即停用、nextRunAt 置空', async (t) => {
  const { db, scheduler } = harness(t)
  db.saveMemberSchedule(schedule({ spec: { kind: 'once', timezone: 'Asia/Shanghai', runAt: '2026-11-19T08:00:00+08:00' } }))
  scheduler.tick()
  await settle()
  const after = db.getMemberSchedule('sch-1')!
  assert.equal(after.enabled, false)
  assert.equal(after.nextRunAt, null)
  assert.equal(after.lastStatus, 'succeeded')
})

test('未到期 / 停用 / 团队未开：都不触发', (t) => {
  const a = harness(t)
  a.db.saveMemberSchedule(schedule({ nextRunAt: NOW + 60_000 }))
  assert.equal(a.scheduler.tick().fired, 0)
  const b = harness(t)
  b.db.saveMemberSchedule(schedule({ enabled: false }))
  assert.equal(b.scheduler.tick().fired, 0)
  const c = harness(t, { enabled: false })
  c.db.saveMemberSchedule(schedule())
  assert.equal(c.scheduler.tick().fired, 0)
})

test('成员运行抛错：记失败账，不投递', async (t) => {
  const { db, scheduler, delivered } = harness(t, { run: async () => { throw new Error('成员正在处理其他请求') } })
  db.saveMemberSchedule(schedule())
  scheduler.tick()
  await settle()
  assert.equal(delivered.length, 0)
  const after = db.getMemberSchedule('sch-1')!
  assert.equal(after.lastStatus, 'failed')
  assert.match(after.lastText!, /成员正在处理其他请求/)
  assert.equal(db.listMemberScheduleRuns('sch-1')[0].state, 'failed')
})

test('投递失败（渠道不可达）：记失败、文本带投递失败标注', async (t) => {
  const { db, scheduler } = harness(t, { deliver: async () => false })
  db.saveMemberSchedule(schedule())
  scheduler.tick()
  await settle()
  const after = db.getMemberSchedule('sch-1')!
  assert.equal(after.lastStatus, 'failed')
  assert.match(after.lastText!, /投递失败/)
})

test('空回复：记失败，不投递', async (t) => {
  const { db, scheduler, delivered } = harness(t, { run: async () => '   ' })
  db.saveMemberSchedule(schedule())
  scheduler.tick()
  await settle()
  assert.equal(delivered.length, 0)
  assert.equal(db.getMemberSchedule('sch-1')!.lastStatus, 'failed')
})

test('runNow：立即跑一次，不改 nextRunAt', async (t) => {
  const { db, scheduler, delivered } = harness(t)
  db.saveMemberSchedule(schedule({ nextRunAt: NOW + 3_600_000 }))
  const result = await scheduler.runNow('sch-1')
  assert.equal(result.state, 'succeeded')
  assert.equal(delivered.length, 1)
  assert.equal(db.getMemberSchedule('sch-1')!.nextRunAt, NOW + 3_600_000)
})

test('runNow：不存在 / 停用 / 团队未开 → skipped', async (t) => {
  const { db, scheduler } = harness(t)
  assert.equal((await scheduler.runNow('nope')).state, 'skipped')
  db.saveMemberSchedule(schedule({ enabled: false }))
  assert.equal((await scheduler.runNow('sch-1')).state, 'skipped')
  const off = harness(t, { enabled: false })
  off.db.saveMemberSchedule(schedule())
  assert.equal((await off.scheduler.runNow('sch-1')).state, 'skipped')
})

test('同一拍不会重复触发同一条（认领即推进）', async (t) => {
  const { db, scheduler, ran } = harness(t)
  db.saveMemberSchedule(schedule())
  scheduler.tick()
  scheduler.tick()
  await settle()
  assert.equal(ran.length, 1)
})