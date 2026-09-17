/**
 * 旧数据适配器与清理的行为契约。
 *
 * 适配器这边要钉住的是"迁移看到的是真数据、读不出来时不抛"；清理这边要钉住的是一件
 * 一旦做错就不可逆的事——days 表绝对不能删，用户粘贴进来的聊天导出正文没有被复制进新库。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createLegacySource, purgeLegacyData, type LegacyTables, type PurgeableLegacyTable } from '../src/legacy.ts'
import { sampleFileOf } from '../src/sampler.ts'
import type { ActivitySpan, DayRecord, Preference, ReportMeta } from '../src/domain.ts'

const NOW = 1_757_000_000_000

/** 一张内存旧表。记录被删过的 key，用来断言"哪张表被动过"。 */
class FakeTable<V> implements PurgeableLegacyTable<V> {
  readonly deleted: string[] = []
  private readonly rows = new Map<string, V>()

  constructor(rows: Iterable<readonly [string, V]>) {
    for (const [key, value] of rows) this.rows.set(key, value)
  }

  entries(): Iterable<readonly [string, V]> {
    return this.rows.entries()
  }

  async delete(key: string): Promise<boolean> {
    this.deleted.push(key)
    return this.rows.delete(key)
  }

  get size(): number {
    return this.rows.size
  }
}

function day(date: string, over: Partial<DayRecord> = {}): DayRecord {
  return { date, events: [], notes: [], interpretedUpto: 0, ...over }
}

let dir: string
let preferences: FakeTable<Preference>
let days: FakeTable<DayRecord>
let reports: FakeTable<ReportMeta>
let tables: LegacyTables

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dsh-legacy-'))
  preferences = new FakeTable<Preference>([
    ['pref-2', { id: 'pref-2', text: '日报按工作类别组织', createdAt: NOW - 43_200_000 }],
    ['pref-1', { id: 'pref-1', text: '日报不要包含午休浏览网页的时间', createdAt: NOW - 86_400_000 }],
  ])
  // 存储域不保证 entries 的顺序，这里刻意乱序，验证适配器自己排
  days = new FakeTable<DayRecord>([
    ['2026-09-05', day('2026-09-05')],
    ['2026-09-03', day('2026-09-03')],
    ['2026-09-04', day('2026-09-04', {
      notes: [{ id: 'note-1', content: '粘贴的聊天记录全文', source: 'wechat_export', createdAt: NOW }],
    })],
  ])
  reports = new FakeTable<ReportMeta>([
    ['2026-09-05', { date: '2026-09-05' }],
    ['2026-09-03', { date: '2026-09-03', filePath: path.join(dir, '2026-09-03.md'), confirmedAt: NOW - 172_800_000 }],
    ['2026-09-04', { date: '2026-09-04', draft: '# 还没定稿的草稿' }],
  ])
  tables = { preferences, days, reports }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('适配器：迁移看到的旧数据', () => {
  const spans: ActivitySpan[] = [
    { start: NOW - 7_200_000, end: NOW - 3_600_000, app: 'Code', category: 'dev', title: 'legacy.ts' },
  ]

  test('三张表都按日期升序吐出来，不依赖存储域的遍历顺序', () => {
    const source = createLegacySource({ tables, sampleDir: dir, buildSpans: () => spans })
    assert.deepEqual(source.days().map(item => item.date), ['2026-09-03', '2026-09-04', '2026-09-05'])
    assert.deepEqual(source.reports().map(item => item.date), ['2026-09-03', '2026-09-04', '2026-09-05'])
  })

  test('偏好原样带出 id / 正文 / 时间，迁移才能保留旧 id 与来源', () => {
    const source = createLegacySource({ tables, sampleDir: dir, buildSpans: () => spans })
    // 适配器不给偏好排序（迁移按 createdAt 定优先级），这里排序后比较，别把遍历顺序当契约
    const sorted = [...source.preferences()].sort((a, b) => (a.id < b.id ? -1 : 1))
    assert.deepEqual(sorted, [
      { id: 'pref-1', text: '日报不要包含午休浏览网页的时间', createdAt: NOW - 86_400_000 },
      { id: 'pref-2', text: '日报按工作类别组织', createdAt: NOW - 43_200_000 },
    ])
  })

  test('日报的草稿与归档路径分开带出，缺的字段不补成空串', () => {
    const source = createLegacySource({ tables, sampleDir: dir, buildSpans: () => spans })
    const byDate = new Map(source.reports().map(item => [item.date, item]))
    assert.equal(byDate.get('2026-09-04')?.draft, '# 还没定稿的草稿')
    assert.equal(byDate.get('2026-09-04')?.filePath, undefined)
    assert.equal(byDate.get('2026-09-03')?.draft, undefined)
    assert.equal(byDate.get('2026-09-05')?.confirmedAt, undefined)
  })

  test('读不出归档正文时返回 null 而不是抛错，由迁移那边点名报告', () => {
    const source = createLegacySource({ tables, sampleDir: dir, buildSpans: () => spans })
    const existing = path.join(dir, '2026-09-03.md')
    writeFileSync(existing, '# 旧日报\n')
    assert.equal(source.readReportFile(existing), '# 旧日报\n')
    assert.equal(source.readReportFile(path.join(dir, '被用户挪走了.md')), null)
  })

  test('采样日期与路径来自真实目录，两边拼装口径一致', () => {
    writeFileSync(sampleFileOf(dir, '2026-09-04'), '{}\n')
    writeFileSync(path.join(dir, 'sampler.pid'), '4242')
    const source = createLegacySource({ tables, sampleDir: dir, buildSpans: () => spans })
    assert.deepEqual(source.sampleDates(), ['2026-09-04'])
    assert.equal(source.sampleFileOf('2026-09-04'), sampleFileOf(dir, '2026-09-04'))
  })

  test('片段聚合走注入的函数：适配器自己不碰分类器', () => {
    const asked: string[] = []
    const source = createLegacySource({
      tables,
      sampleDir: dir,
      buildSpans(date: string) {
        asked.push(date)
        return spans
      },
    })
    assert.deepEqual(source.spans('2026-09-04'), spans)
    assert.deepEqual(asked, ['2026-09-04'])
  })

  test('迁移对旧数据只读：三张表一行都没被删', () => {
    const source = createLegacySource({ tables, sampleDir: dir, buildSpans: () => spans })
    source.preferences()
    source.days()
    source.reports()
    source.sampleDates()
    assert.deepEqual(preferences.deleted, [])
    assert.deepEqual(days.deleted, [])
    assert.deepEqual(reports.deleted, [])
  })
})

describe('清理：只删已经完整搬进新库的东西', () => {
  test('days 表一行都不删——笔记正文没被复制进新库，删了就是永久丢失', async () => {
    const outcome = await purgeLegacyData(tables)
    assert.deepEqual(days.deleted, [])
    assert.equal(days.size, 3)
    assert.deepEqual(outcome.purged.map(item => item.table), ['preferences', 'reports'])
  })

  test('偏好与日报记录删干净，行数如实报', async () => {
    const outcome = await purgeLegacyData(tables)
    assert.deepEqual(outcome.purged, [
      { table: 'preferences', rows: 2 },
      { table: 'reports', rows: 3 },
    ])
    assert.equal(preferences.size, 0)
    assert.equal(reports.size, 0)
  })

  test('"仍保留"三类齐全，并写明天数与归档份数，不笼统说一句"部分保留"', async () => {
    const outcome = await purgeLegacyData(tables)
    const reasons = new Map(outcome.retained.map(item => [item.table, item.reason]))
    assert.deepEqual([...reasons.keys()], ['days', 'report files', 'sample files'])
    assert.match(reasons.get('days') ?? '', /3 天/)
    // 只有真有 filePath 的那份算归档原文件，草稿不算
    assert.match(reasons.get('report files') ?? '', /1 份/)
    assert.match(reasons.get('sample files') ?? '', /采样原文保留/)
  })

  test('空库上跑也不出错，报出 0 行', async () => {
    const empty: LegacyTables = {
      preferences: new FakeTable<Preference>([]),
      days: new FakeTable<DayRecord>([]),
      reports: new FakeTable<ReportMeta>([]),
    }
    const outcome = await purgeLegacyData(empty)
    assert.deepEqual(outcome.purged, [
      { table: 'preferences', rows: 0 },
      { table: 'reports', rows: 0 },
    ])
    assert.match(outcome.retained[0]!.reason, /0 天/)
  })

  test('重复跑不会重复报行数：第二次已经没有可删的了', async () => {
    await purgeLegacyData(tables)
    const second = await purgeLegacyData(tables)
    assert.deepEqual(second.purged, [
      { table: 'preferences', rows: 0 },
      { table: 'reports', rows: 0 },
    ])
  })
})
