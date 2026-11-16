/**
 * 周报主体键的钉子用例。
 *
 * 周报和日报**并存**：`daily:2026-11-14` 与 `weekly:2026-11-10` 是两个不同的 reportId，
 * 文件也分开命名（`2026-11-14.md` / `2026-11-10-周报.md`），所以同一天可以既有日报又有周报。
 *
 * 这里钉的是"同一周只落一份"：周二和周五各让助理写一次周报，必须落到同一个键上，
 * 否则两份都叫"本周周报"，用户没法确认哪份是定稿。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeReportId, weekKeyOf } from '../src/report.ts'

void test('周报键：同一周的任意一天都落到同一个周一', () => {
  // 2026-11-10 是周二 → 该周周一为 2026-11-09
  const tuesday = Date.parse('2026-11-10T10:00:00+08:00')
  const friday = Date.parse('2026-11-13T23:30:00+08:00')
  const sunday = Date.parse('2026-11-15T01:00:00+08:00')
  const monday = Date.parse('2026-11-09T00:10:00+08:00')
  assert.equal(weekKeyOf(tuesday), '2026-11-09')
  assert.equal(weekKeyOf(friday), '2026-11-09')
  assert.equal(weekKeyOf(sunday), '2026-11-09')
  assert.equal(weekKeyOf(monday), '2026-11-09')
})

void test('周报键：跨周就换键（不会把两周合成一份）', () => {
  assert.equal(weekKeyOf(Date.parse('2026-11-16T09:00:00+08:00')), '2026-11-16')
})

void test('周报 id 与日报 id 互不相同，同一天可以并存', () => {
  const daily = makeReportId('daily', '2026-11-13')
  const weekly = makeReportId('weekly', weekKeyOf(Date.parse('2026-11-13T18:00:00+08:00')))
  assert.equal(daily, 'daily:2026-11-13')
  assert.equal(weekly, 'weekly:2026-11-09')
  assert.notEqual(daily, weekly)
})
