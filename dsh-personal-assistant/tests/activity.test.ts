/**
 * 原始活动这一层的行为契约：怎么把采样聚合成片段、怎么算"哪一天"、保留期到底删了什么。
 *
 * 这三件事必须钉住，是因为它们各有两个消费方，而两方口径一旦分叉，用户看到的就是数据丢失：
 * 聚合被跟踪器（回答"我今天干了啥"）和迁移（把旧采样搬进观察库）共用；
 * 日期归属被采样文件名和观察行的时间戳共用；
 * 保留期同时裁磁盘上的 JSONL 和库里的派生观察。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Classifier } from '../src/classifier.ts'
import { ObservationStore } from '../src/observation.ts'
import { listSampleDates, pruneSampleFiles, sampleFileOf, type Sample } from '../src/sampler.ts'
import { buildSpansFrom } from '../src/spans.ts'
import { localDateOf, retentionStartDate, startOfLocalDate } from '../src/time.ts'

const T0 = 1_757_000_000_000

function sample(ts: number, over: Partial<Sample> = {}): Sample {
  return { ts, proc: 'chrome', title: '示例页面 - Google Chrome', ...over }
}

describe('聚合口径：跟踪器与迁移共用同一套片段算法', () => {
  const classifier = new Classifier([])
  const build = (samples: Sample[], minSpanMs = 10_000) => buildSpansFrom(samples, classifier, minSpanMs)

  test('连续且进程/分类/提取后标题都相同的采样合并成一段，起止取首尾', () => {
    const spans = build([sample(T0), sample(T0 + 15_000), sample(T0 + 30_000)])
    assert.deepEqual(spans, [
      { start: T0, end: T0 + 30_000, app: 'chrome', category: 'browser', title: '示例页面' },
    ])
  })

  test('标题变了就断开：同一个浏览器里换了页面是两件事', () => {
    const spans = build([
      sample(T0, { title: '需求文档 - 语雀 - Google Chrome' }),
      sample(T0 + 15_000, { title: '需求文档 - 语雀 - Google Chrome' }),
      sample(T0 + 30_000, { title: '会议纪要 - Word - Google Chrome' }),
      sample(T0 + 45_000, { title: '会议纪要 - Word - Google Chrome' }),
    ])
    assert.deepEqual(spans.map(span => span.title), ['需求文档 - 语雀', '会议纪要 - Word'])
    assert.deepEqual(spans.map(span => span.start), [T0, T0 + 30_000])
  })

  test('分类变了也断开：浏览网页时切到 AI 网页工具，不该被算成同一段浏览', () => {
    const spans = build([
      sample(T0),
      sample(T0 + 15_000),
      sample(T0 + 30_000, { title: 'DeepSeek - Google Chrome' }),
      sample(T0 + 45_000, { title: 'DeepSeek - Google Chrome' }),
    ])
    assert.deepEqual(spans.map(span => span.category), ['browser', 'ai'])
  })

  test('短于 minSpanMs 的段当噪声丢掉；孤零零一个采样必然被丢', () => {
    const spans = build([
      sample(T0),
      sample(T0 + 15_000),
      // 一次前台切换抓不到停留时间，start 等于 end，长度 0，谈不上"在做什么"
      sample(T0 + 30_000, { proc: 'notepad', title: '草稿 - 记事本' }),
      sample(T0 + 45_000, { title: '另一个页面 - Google Chrome' }),
      sample(T0 + 60_000, { title: '另一个页面 - Google Chrome' }),
    ])
    assert.deepEqual(spans.map(span => span.title), ['示例页面', '另一个页面'])
  })

  test('minSpanMs 是硬门槛：正好达标留下，差一毫秒丢掉', () => {
    const samples = [sample(T0), sample(T0 + 15_000)]
    assert.equal(build(samples, 15_000).length, 1)
    assert.equal(build(samples, 15_001).length, 0)
  })

  test('idle 样本自成一段，不把前后的窗口活动粘在一起', () => {
    const spans = build([
      sample(T0),
      sample(T0 + 15_000),
      sample(T0 + 30_000, { idle: true, proc: undefined, title: undefined }),
      sample(T0 + 45_000, { idle: true, proc: undefined, title: undefined }),
      // 回来后接着看同一个页面：标题相同，所以只有 idle 真把序列断开，才不会合并成一段 75 秒
      sample(T0 + 60_000),
      sample(T0 + 75_000),
    ])
    assert.deepEqual(spans.map(span => span.category), ['browser', 'idle', 'browser'])
    assert.deepEqual(spans[1], { start: T0 + 30_000, end: T0 + 45_000, app: '', category: 'idle', title: '' })
    assert.deepEqual(spans.map(span => span.title), ['示例页面', '', '示例页面'])
    assert.deepEqual(spans.map(span => span.end - span.start), [15_000, 15_000, 15_000])
  })

  test('空采样返回空片段，不返回一段从 0 开始的假活动', () => {
    assert.deepEqual(build([]), [])
  })
})

describe('日期口径：文件名上的日期与库里的时间戳是同一条线', () => {
  test('localDateOf 与 startOfLocalDate 互相对得上', () => {
    const date = localDateOf(T0)
    const midnight = startOfLocalDate(date)
    assert.ok(midnight <= T0, '当天零点不该晚于当天的时刻')
    assert.ok(T0 - midnight < 86_400_000, '当天零点与当天的时刻差不到一天')
    assert.equal(localDateOf(midnight), date)
  })

  test('保留期起点当天算保留，回退 0 天就是今天', () => {
    assert.equal(retentionStartDate(T0, 0), localDateOf(T0))
    const keepFrom = retentionStartDate(T0, 7)
    assert.equal(localDateOf(startOfLocalDate(keepFrom)), keepFrom)
    // 保留 7 天意味着今天往前数第 7 天仍在保留期内，被裁掉的是第 8 天及更早
    assert.ok(startOfLocalDate(keepFrom) <= T0 - 6 * 86_400_000)
  })

  test('非法日期串给出 NaN，而不是一个看起来正常的 0', () => {
    assert.ok(Number.isNaN(startOfLocalDate('不是日期')))
  })
})

describe('保留期：磁盘上的采样原文与库里的观察按同一条线裁', () => {
  let dir: string
  let db: DatabaseSync
  let observations: ObservationStore

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dsh-activity-'))
    db = new DatabaseSync(':memory:')
    observations = new ObservationStore(db)
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** 在目录里放一天的采样原文，并在库里放一条落在同一天 01:00 的观察。 */
  function seedDay(date: string): void {
    writeFileSync(sampleFileOf(dir, date), `${JSON.stringify(sample(startOfLocalDate(date) + 3_600_000))}\n`)
    assert.equal(observations.put({
      id: `span-${date}`,
      source: 'activity_span',
      scopeKind: 'global',
      scopeId: '',
      startAt: startOfLocalDate(date) + 3_600_000,
      endAt: startOfLocalDate(date) + 7_200_000,
      timezone: 'local',
      summary: `chrome｜browser｜${date}`,
      payloadRef: sampleFileOf(dir, date),
      sensitivity: 'normal',
      legacyId: null,
      importBatch: null,
    }), true)
  }

  test('保留期起点之前的两天：文件和观察一起消失；当天及之后：一起留下', () => {
    const keepFrom = retentionStartDate(T0, 7)
    const days = [-9, -8, -7, -6].map(offset => localDateOf(T0 + offset * 86_400_000))
    for (const date of days) seedDay(date)

    const prunedFiles = pruneSampleFiles(dir, keepFrom)
    const prunedSpans = observations.deleteRange('activity_span', startOfLocalDate(keepFrom))

    const expired = days.filter(date => date < keepFrom)
    const kept = days.filter(date => date >= keepFrom)
    assert.equal(expired.length, 2, '保留 7 天时，第 9、第 8 天前该被裁掉')
    assert.deepEqual(prunedFiles.sort(), expired.sort())
    assert.equal(prunedSpans, expired.length)

    const remainingFiles = listSampleDates(dir)
    assert.deepEqual(remainingFiles.sort(), kept.sort())
    const remainingSpans = observations.listInRange(0, T0 + 1).map(row => row.payloadRef)
    assert.deepEqual(remainingSpans.sort(), kept.map(date => sampleFileOf(dir, date)).sort())
  })

  test('只裁 activity_span：用户笔记和旧语义事项是确认过的成果，保留期不该悄悄抹掉', () => {
    const keepFrom = retentionStartDate(T0, 7)
    const old = localDateOf(T0 - 30 * 86_400_000)
    for (const source of ['activity_span', 'legacy_day_event', 'user_note'] as const) {
      observations.put({
        id: `${source}-${old}`,
        source,
        scopeKind: 'global',
        scopeId: '',
        startAt: startOfLocalDate(old),
        endAt: startOfLocalDate(old) + 60_000,
        timezone: 'local',
        summary: source,
        payloadRef: null,
        sensitivity: 'normal',
        legacyId: null,
        importBatch: null,
      })
    }
    const pruned = observations.deleteRange('activity_span', startOfLocalDate(keepFrom))
    assert.equal(pruned, 1)
    const survivors = observations.listInRange(0, T0 + 1).map(row => row.source)
    assert.deepEqual(survivors.sort(), ['legacy_day_event', 'user_note'])
  })
})

describe('采样目录布局：清理只认采样原文，不误伤同目录的别的文件', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dsh-samples-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('目录不存在时返回空列表，不抛错', () => {
    assert.deepEqual(listSampleDates(path.join(dir, '还不存在的子目录')), [])
    assert.deepEqual(pruneSampleFiles(path.join(dir, '还不存在的子目录'), '2026-01-01'), [])
  })

  test('只认 YYYY-MM-DD.jsonl；sampler.pid 与残缺命名都不算采样原文', () => {
    writeFileSync(path.join(dir, '2026-09-01.jsonl'), '')
    writeFileSync(path.join(dir, '2026-09-02.jsonl'), '')
    writeFileSync(path.join(dir, 'sampler.pid'), '4242')
    writeFileSync(path.join(dir, '2026-09-03.jsonl.tmp'), '')
    writeFileSync(path.join(dir, '2026-9-4.jsonl'), '')
    writeFileSync(path.join(dir, 'notes.txt'), '')
    assert.deepEqual(listSampleDates(dir), ['2026-09-01', '2026-09-02'])
  })

  test('清理删掉超期原文，PID 文件与当天原文都还在', () => {
    writeFileSync(sampleFileOf(dir, '2026-09-01'), '{}\n')
    writeFileSync(sampleFileOf(dir, '2026-09-08'), '{}\n')
    writeFileSync(path.join(dir, 'sampler.pid'), '4242')

    const deleted = pruneSampleFiles(dir, '2026-09-08')

    assert.deepEqual(deleted, ['2026-09-01'])
    assert.deepEqual(readdirSync(dir).sort(), ['2026-09-08.jsonl', 'sampler.pid'])
  })

  test('某个原文删不掉（被采样进程占着）不影响其余文件，也不谎报成已删', () => {
    // 用一个同名目录模拟"删不动"：unlinkSync 对目录必然抛错
    const stuck = sampleFileOf(dir, '2026-09-01')
    mkdirSync(stuck)
    writeFileSync(path.join(stuck, '占位'), '')
    writeFileSync(sampleFileOf(dir, '2026-09-02'), '{}\n')

    const deleted = pruneSampleFiles(dir, '2026-09-08')

    assert.deepEqual(deleted, ['2026-09-02'], '删不掉的那个不算已删，下次清理会再试')
    assert.ok(readdirSync(dir).includes('2026-09-01.jsonl'), '删不动的东西原样留着')
  })
})
