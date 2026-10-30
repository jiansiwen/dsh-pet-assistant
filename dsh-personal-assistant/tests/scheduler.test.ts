import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstScheduleAt, nextDailyAt, nextScheduleAt } from '../src/scheduler.ts'

const iso = (at: number | null) => at === null ? null : new Date(at).toISOString()

test('每日计划使用真实时区，夏令时缺失时间顺延到首个有效分钟', () => {
  assert.equal(iso(nextDailyAt(Date.parse('2026-03-08T00:00:00Z'), 'America/New_York', '02:30')), '2026-03-08T07:00:00.000Z')
  assert.equal(iso(nextDailyAt(Date.parse('2026-03-08T07:00:00Z'), 'America/New_York', '02:30')), '2026-03-09T06:30:00.000Z')
})

test('夏令时重复时间每天只选第一次，不因回拨再排第二次', () => {
  assert.equal(iso(nextDailyAt(Date.parse('2026-11-01T00:00:00Z'), 'America/New_York', '01:30')), '2026-11-01T05:30:00.000Z')
  assert.equal(iso(nextDailyAt(Date.parse('2026-11-01T05:45:00Z'), 'America/New_York', '01:30')), '2026-11-02T06:30:00.000Z')
})

test('半小时夏令时缺口与非整点时区由 Intl 解析', () => {
  assert.equal(iso(nextDailyAt(Date.parse('2026-10-03T12:00:00Z'), 'Australia/Lord_Howe', '02:15')), '2026-10-03T15:30:00.000Z')
  assert.equal(iso(nextDailyAt(Date.parse('2026-10-27T00:00:00Z'), 'Asia/Kathmandu', '09:00')), '2026-10-27T03:15:00.000Z')
})

test('固定间隔保持锚点，睡眠错过多轮只返回下一个未来时间', () => {
  const spec = { kind: 'interval', timezone: 'Asia/Shanghai', runAt: '2026-10-27T00:00:00Z', everySeconds: 300 } as const
  assert.equal(iso(firstScheduleAt(spec, Date.parse('2026-10-28T00:00:00Z'))), '2026-10-27T00:00:00.000Z')
  assert.equal(iso(nextScheduleAt(spec, Date.parse('2026-10-27T12:02:00Z'))), '2026-10-27T12:05:00.000Z')
  assert.equal(nextScheduleAt({ kind: 'once', timezone: 'UTC', runAt: spec.runAt }, 0), null)
})
