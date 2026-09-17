/**
 * 旧数据迁移的行为契约。
 *
 * 重点是四件"迁移最容易骗人"的事：重复跑会不会插出两份、崩在中间能不能接着跑、
 * 失败的时候有没有老实说 complete=false（调用方靠它决定要不要启动采集）、
 * 以及有没有偷偷去改旧数据。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, renderMemorySection } from '../src/memory.ts'
import { ObservationStore } from '../src/observation.ts'
import { ReportStore, makeReportId } from '../src/report.ts'
import { ASSISTANT_SCHEMA_VERSION } from '../src/store.ts'
import {
  MigrationStore,
  legacyEventId,
  legacyMemoryId,
  legacySpanId,
  runMigration,
  type LegacySource,
  type MigrationDeps,
} from '../src/migrate.ts'
import type { ActivitySpan, Note, SemanticEvent } from '../src/domain.ts'

const NOW = 1_757_000_000_000

function event(over: Partial<SemanticEvent> = {}): SemanticEvent {
  return {
    id: 'evt-1',
    start: NOW - 7_200_000,
    end: NOW - 3_600_000,
    summary: '与张三讨论了需求评审文档',
    evidence: ['WeChat.exe｜张三'],
    source: 'auto',
    confidence: 'medium',
    createdAt: NOW,
    ...over,
  }
}

function note(over: Partial<Note> = {}): Note {
  return { id: 'note-1', content: '粘贴的聊天记录全文', source: 'wechat_export', createdAt: NOW, ...over }
}

function span(over: Partial<ActivitySpan> = {}): ActivitySpan {
  return { start: NOW - 7_200_000, end: NOW - 6_000_000, app: 'Code.exe', category: 'dev', title: 'migrate.ts', ...over }
}

interface Fixture {
  source: LegacySource
  /** 打开后 readReportFile 抛错，用来制造"崩在第三批"。 */
  failOnReportFile: boolean
  /** 记录迁移过程中对旧数据发起过的每一次调用，用来证明它只读。 */
  calls: string[]
}

function fixture(over: Partial<Fixture> = {}): Fixture {
  const calls: string[] = over.calls ?? []
  const state: Fixture = {
    calls,
    failOnReportFile: over.failOnReportFile ?? false,
    source: {
      preferences() {
        calls.push('preferences')
        return [
          { id: 'pref-1', text: '日报不要包含午休浏览网页的时间', createdAt: NOW - 86_400_000 },
          { id: 'pref-2', text: '日报按工作类别组织', createdAt: NOW - 43_200_000 },
          { id: 'pref-3', text: '   ', createdAt: NOW },
        ]
      },
      days() {
        calls.push('days')
        return [
          { date: '2026-09-04', events: [event()], notes: [note()] },
          { date: '2026-09-05', events: [event({ id: 'evt-2', summary: '写迁移代码' })], notes: [] },
        ]
      },
      reports() {
        calls.push('reports')
        return [
          { date: '2026-09-03', filePath: 'C:/reports/2026-09-03.md', confirmedAt: NOW - 172_800_000 },
          { date: '2026-09-04', draft: '# 还没定稿的草稿' },
          { date: '2026-09-05' },
        ]
      },
      readReportFile(filePath: string) {
        calls.push(`readReportFile:${filePath}`)
        if (state.failOnReportFile) throw new Error('文件被别的进程占着')
        return filePath.endsWith('2026-09-03.md') ? '# 旧日报\n\n已归档' : null
      },
      spans(date: string) {
        calls.push(`spans:${date}`)
        return date === '2026-09-04' ? [span()] : []
      },
      sampleDates() {
        calls.push('sampleDates')
        return ['2026-09-03', '2026-09-04', '2026-09-05']
      },
      sampleFileOf(date: string) {
        return `C:/Users/me/.dsh/personal-assistant/samples/${date}.jsonl`
      },
    },
  }
  return over.source ? { ...state, source: over.source } : state
}

let db: DatabaseSync
let deps: Omit<MigrationDeps, 'source' | 'runId'>

function makeDeps(source: LegacySource): MigrationDeps {
  return { ...deps, source, runId: 'migration-test-run' }
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  deps = {
    db,
    memories: new MemoryStore(db),
    observations: new ObservationStore(db),
    reports: new ReportStore(db),
    migrations: new MigrationStore(db),
    targetVersion: ASSISTANT_SCHEMA_VERSION,
    now: () => NOW,
  }
})

afterEach(() => {
  db.close()
})

describe('旧偏好导入：保留旧 id、时间和来源，不凭空补证据', () => {
  test('落旧全局范围，标上导入批次，正文与时间原样保留', () => {
    const fx = fixture()
    const report = runMigration(makeDeps(fx.source), { fromDate: null, toDate: null, timezone: 'Asia/Shanghai' })
    const batch = report.batches.find(item => item.id === 'legacy-preferences')
    assert.equal(batch?.state, 'succeeded')
    assert.equal(batch?.imported, 2, '空白正文那条不该进来')

    const imported = deps.memories.get(legacyMemoryId('pref-1'), NOW)
    assert.ok(imported)
    assert.equal(imported.text, '日报不要包含午休浏览网页的时间')
    assert.equal(imported.createdAt, NOW - 86_400_000, '旧时间要保留，不能用迁移时刻覆盖')
    assert.deepEqual(imported.scope, { kind: 'global', id: '' })
    assert.equal(imported.importBatch, 'migration-test-run')
    assert.equal(imported.createdBy, 'migration')
    assert.deepEqual(imported.sourceRefs, [], '旧系统没有证据，不能替它编一条')
    assert.equal(imported.topic, '', '旧系统没有 topic 维度，不能替它挑一个')
  })

  test('导入的偏好仍然生效，但提示词里标明是导入的', () => {
    const fx = fixture()
    runMigration(makeDeps(fx.source), { fromDate: null, toDate: null, timezone: 'Asia/Shanghai' })
    const injectable = deps.memories.injectable({}, NOW)
    assert.equal(injectable.length, 2, '旧偏好是用户当时明确说过的，不能升级后全忘')
    const rendered = renderMemorySection(injectable, {})
    assert.match(rendered ?? '', /（导入）/)
  })

  test('没有 topic 的旧偏好之间不互相判冲突', () => {
    const fx = fixture()
    runMigration(makeDeps(fx.source), { fromDate: null, toDate: null, timezone: 'Asia/Shanghai' })
    // 两条旧偏好正文完全不同，但 topic 都是空。空 topic 意味着"不知道说的是哪件事"，
    // 这种前提下判冲突就是凭空补证据，会把整批旧偏好一起打成不生效。
    for (const record of deps.memories.injectable({}, NOW)) {
      assert.equal(record.status, 'confirmed')
    }
  })
})

describe('旧记录导入：事项与笔记变成观察，采样片段按天导', () => {
  test('事项保留旧 id 与时间，来源位置可追溯', () => {
    const fx = fixture()
    runMigration(makeDeps(fx.source), { fromDate: null, toDate: null, timezone: 'Asia/Shanghai' })
    const rows = deps.observations.listInRange(0, NOW + 1)
    const imported = rows.find(row => row.id === legacyEventId('evt-1'))
    assert.ok(imported)
    assert.equal(imported.legacyId, 'evt-1')
    assert.equal(imported.summary, '与张三讨论了需求评审文档')
    assert.equal(imported.payloadRef, 'personal_assistant.days[2026-09-04]')
    assert.equal(imported.timezone, 'Asia/Shanghai')
  })

  test('笔记正文不复制进库，只留来源标记', () => {
    const fx = fixture()
    runMigration(makeDeps(fx.source), { fromDate: null, toDate: null, timezone: 'Asia/Shanghai' })
    const rows = deps.observations.listInRange(0, NOW + 1)
    const imported = rows.find(row => row.legacyId === 'note-1')
    assert.ok(imported)
    assert.equal(imported.summary, 'wechat_export')
    assert.ok(!imported.summary.includes('聊天记录'), '粘贴的正文可能很私密，不该复制进新库')
  })

  test('toDate 之前的当天不导采样片段：文件还在长，片段没定型', () => {
    const fx = fixture()
    runMigration(makeDeps(fx.source), { fromDate: null, toDate: '2026-09-05', timezone: 'Asia/Shanghai' })
    assert.ok(!fx.calls.includes('spans:2026-09-05'), '当天的片段随时会重新合并，导进来 id 会对不上')
    assert.ok(fx.calls.includes('spans:2026-09-04'))
    const rows = deps.observations.listInRange(0, NOW + 1).filter(row => row.source === 'activity_span')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, legacySpanId('2026-09-04', span()))
    assert.match(rows[0].payloadRef ?? '', /2026-09-04\.jsonl$/)
  })

  test('fromDate 之后才开始导', () => {
    const fx = fixture()
    runMigration(makeDeps(fx.source), { fromDate: '2026-09-05', toDate: null, timezone: 'Asia/Shanghai' })
    const rows = deps.observations.listInRange(0, NOW + 1).filter(row => row.source === 'legacy_day_event')
    assert.deepEqual(rows.map(row => row.legacyId), ['evt-2'])
  })
})

describe('旧日报导入：原文件不改，读不出来要点名', () => {
  test('已定稿的登记成归档版本，路径指向原文件', () => {
    const fx = fixture()
    runMigration(makeDeps(fx.source), { fromDate: null, toDate: null, timezone: 'Asia/Shanghai' })
    const archived = deps.reports.current(makeReportId('daily', '2026-09-03'))
    assert.equal(archived?.state, 'archived')
    assert.equal(archived?.targetPath, 'C:/reports/2026-09-03.md')
    assert.equal(archived?.approvedAt, NOW - 172_800_000)
    assert.equal(archived?.content, '# 旧日报\n\n已归档')
    // 只读过，没有任何写旧文件的调用
    assert.deepEqual(fx.calls.filter(call => call.startsWith('readReportFile')), ['readReportFile:C:/reports/2026-09-03.md'])
  })

  test('只有草稿的登记成草稿，什么都没写的跳过', () => {
    const fx = fixture()
    runMigration(makeDeps(fx.source), { fromDate: null, toDate: null, timezone: 'Asia/Shanghai' })
    assert.equal(deps.reports.current(makeReportId('daily', '2026-09-04'))?.state, 'draft')
    assert.equal(deps.reports.current(makeReportId('daily', '2026-09-05')), null)
  })

  test('定稿文件读不出来时明细要点名是哪几天，不能只报一个跳过数', () => {
    const fx = fixture()
    fx.source = {
      ...fx.source,
      readReportFile() {
        return null
      },
    }
    const report = runMigration(makeDeps(fx.source), { fromDate: null, toDate: null, timezone: 'Asia/Shanghai' })
    const batch = report.batches.find(item => item.id === 'legacy-reports')
    assert.equal(batch?.state, 'succeeded')
    assert.match(batch?.message ?? '', /2026-09-03/)
    assert.match(batch?.message ?? '', /需要人工确认/)
  })
})

describe('幂等与断点恢复', () => {
  test('重复跑同样的内容，一条都不多', () => {
    const fx = fixture()
    const options = { fromDate: null, toDate: null, timezone: 'Asia/Shanghai' }
    const first = runMigration(makeDeps(fx.source), options)
    assert.equal(first.complete, true)
    const memoriesAfterFirst = deps.memories.count()
    const observationsAfterFirst = deps.observations.count()

    const second = runMigration(makeDeps(fx.source), options)
    assert.deepEqual(second.batches.map(batch => batch.state), ['skipped', 'skipped', 'skipped', 'skipped'])
    assert.equal(deps.memories.count(), memoriesAfterFirst)
    assert.equal(deps.observations.count(), observationsAfterFirst)
  })

  test('批次摘要跳过之后，行级幂等也挡得住：强行重跑不产生重复', () => {
    const fx = fixture()
    const options = { fromDate: null, toDate: null, timezone: 'Asia/Shanghai' }
    runMigration(makeDeps(fx.source), options)
    const before = deps.memories.count()

    // 换个 runId 会让批次摘要变化？不会——runId 不进摘要。这里直接把批次记录清掉，
    // 模拟"账本丢了但数据还在"的极端情况，验证行级幂等单独也成立。
    db.exec(`DELETE FROM migrations`)
    const rerun = runMigration(makeDeps(fx.source), options)
    assert.equal(rerun.complete, true)
    assert.equal(deps.memories.count(), before, '旧 id 派生出稳定新 id，主键冲突即幂等')
    assert.ok(
      rerun.batches.every(batch => batch.message.includes('已存在') || batch.imported === 0),
      '重跑要如实说这些是已存在的，不能报成"新导入"',
    )
  })

  test('崩在第三批：前两批已落盘，重跑时跳过它们、只补剩下的', () => {
    const fx = fixture()
    fx.failOnReportFile = true
    const options = { fromDate: null, toDate: null, timezone: 'Asia/Shanghai' }

    const broken = runMigration(makeDeps(fx.source), options)
    assert.equal(broken.complete, false, '没跑完就必须说没跑完，调用方靠这个决定不启动采集')
    assert.deepEqual(broken.batches.map(batch => batch.state), ['succeeded', 'succeeded', 'failed', 'succeeded'])
    assert.match(broken.failures[0], /legacy-reports/)
    const memoriesAfterCrash = deps.memories.count()
    const observationsAfterCrash = deps.observations.count()
    assert.ok(memoriesAfterCrash > 0, '前两批的数据必须已经落盘，否则谈不上断点')

    fx.failOnReportFile = false
    const recovered = runMigration(makeDeps(fx.source), options)
    assert.equal(recovered.complete, true)
    assert.deepEqual(recovered.batches.map(batch => batch.state), ['skipped', 'skipped', 'succeeded', 'skipped'])
    assert.equal(deps.memories.count(), memoriesAfterCrash)
    assert.equal(deps.observations.count(), observationsAfterCrash)
    assert.ok(deps.reports.current(makeReportId('daily', '2026-09-03')))
  })

  test('失败的那批不留半条数据', () => {
    const fx = fixture()
    fx.failOnReportFile = true
    runMigration(makeDeps(fx.source), { fromDate: null, toDate: null, timezone: 'Asia/Shanghai' })
    assert.equal(deps.reports.current(makeReportId('daily', '2026-09-03')), null, '事务回滚，不能留下半份归档')
    assert.equal(deps.reports.current(makeReportId('daily', '2026-09-04')), null, '同批后面的草稿也一起回滚')
  })

  test('旧数据整个读不出来时，报失败而不是静默当成"没有旧数据"', () => {
    const fx = fixture()
    fx.source = {
      ...fx.source,
      preferences() {
        throw new Error('存储域打不开')
      },
    }
    const report = runMigration(makeDeps(fx.source), { fromDate: null, toDate: null, timezone: 'Asia/Shanghai' })
    assert.equal(report.complete, false)
    const batch = report.batches.find(item => item.id === 'legacy-preferences')
    assert.equal(batch?.state, 'failed')
    assert.match(batch?.message ?? '', /读旧数据失败/)
    // 其余批次不受牵连，能导的照样导
    assert.equal(report.batches.filter(item => item.state === 'succeeded').length, 3)
  })

  test('迁移账本留下每一批的状态，回头能查', () => {
    const fx = fixture()
    runMigration(makeDeps(fx.source), { fromDate: null, toDate: null, timezone: 'Asia/Shanghai' })
    const history = deps.migrations.history()
    assert.deepEqual(history.map(item => item.batchId), [
      'legacy-preferences',
      'legacy-days',
      'legacy-reports',
      'legacy-spans',
    ])
    assert.ok(history.every(item => item.state === 'succeeded'))
    assert.ok(history.every(item => item.imported >= 0))
  })
})

describe('迁移只读旧数据', () => {
  test('LegacySource 接口里没有任何写方法可被调用', () => {
    const fx = fixture()
    runMigration(makeDeps(fx.source), { fromDate: null, toDate: null, timezone: 'Asia/Shanghai' })
    // 这条断言看起来是废话，但它是设计约束：接口只暴露读方法，
    // 所以"迁移会不会改坏旧数据"这个问题在类型层面就不存在。
    const methodNames = Object.keys(fx.source)
    assert.deepEqual(methodNames.sort(), [
      'days',
      'preferences',
      'readReportFile',
      'reports',
      'sampleDates',
      'sampleFileOf',
      'spans',
    ])
    assert.ok(!methodNames.some(name => /^(save|put|write|delete|remove|update)/.test(name)))
  })
})
