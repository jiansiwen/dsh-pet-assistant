import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Config } from '../src/config.ts'
import { MemoryStore } from '../src/memory.ts'
import { ObservationStore } from '../src/observation.ts'
import { ReportStore } from '../src/report.ts'
import { applyRetention, scheduleRetention, startRetention } from '../src/retention.ts'
import { openAssistantStore } from '../src/store.ts'
import { planWorkItem, WorkItemStore } from '../src/work-items.ts'

test('到期清理传播观察来源，并只删除测试目录中的过期采样文件', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'retention-running-'))
  const db = openAssistantStore(path.join(dir, 'assistant.sqlite'))
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const sampleDir = path.join(dir, 'samples')
  mkdirSync(sampleDir)
  const old = path.join(sampleDir, '2026-10-25.jsonl'), recent = path.join(sampleDir, '2026-10-31.jsonl')
  writeFileSync(old, '旧采样'); writeFileSync(recent, '新采样')
  const observations = new ObservationStore(db), memories = new MemoryStore(db), reports = new ReportStore(db), workItems = new WorkItemStore(db)
  const start = new Date('2026-10-25T10:00:00').getTime(), now = new Date('2026-10-31T12:00:00').getTime()
  observations.put({ id: 'expired-observation', source: 'activity_span', scopeKind: 'global', scopeId: '', startAt: start, endAt: start + 1000,
    timezone: 'Asia/Shanghai', summary: '过期采样', payloadRef: old, sensitivity: 'normal', legacyId: null, importBatch: null })
  const derived = memories.put({ kind: 'project_fact', scopeKind: 'global', text: '仅由旧采样派生', sourceRefs: ['expired-observation'], actor: { id: 'user', isUser: true } }, now)
  assert.ok(derived.ok)
  const planned = planWorkItem({ start, end: start + 1000, summary: '推断事项', status: 'inferred', sources: [{ kind: 'activity_observation', ref: 'expired-observation' }] },
    () => ({ evidenceType: 'window_title', projectDir: null, readAt: null, digest: null, summary: '过期采样' }))
  assert.ok(planned.ok)
  const [item] = workItems.commit([planned.item], now)
  const result = applyRetention({ db, sampleDir, observations, memories, reports, workItems, retentionDays: 2, now })
  assert.equal(result.prunedSampleDays, 1)
  assert.equal(result.prunedSpans, 1)
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(recent), true)
  assert.equal(observations.get('expired-observation'), null)
  assert.equal(memories.get(derived.record.id, now), null)
  assert.equal(workItems.get(item.id)?.status, 'evidence_removed')
  assert.equal(observations.overlapsDeleted(start, start + 1000), true, '还原的旧采样不能重新出现')
  assert.equal(observations.put({ id: 'restored-old', source: 'activity_span', scopeKind: 'global', scopeId: '', startAt: start, endAt: start + 1000,
    timezone: 'Asia/Shanghai', summary: '还原的旧采样', payloadRef: old, sensitivity: 'normal', legacyId: null, importBatch: null }), false)
  assert.equal(observations.get('restored-old'), null)
  writeFileSync(old, '从备份还原的旧采样')
  const extended = applyRetention({ db, sampleDir, observations, memories, reports, workItems, retentionDays: 30, now })
  assert.equal(extended.prunedSampleDays, 1, '延长保留期不能让已清理过的采样文件复活')
  assert.equal(existsSync(old), false)
})

test('记忆来源到期后，其派生结论不能继续作为已确认事实', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'memory-expiry-source-'))
  const db = openAssistantStore(path.join(dir, 'assistant.sqlite'))
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const memories = new MemoryStore(db), now = 1_800_000_000_000
  const source = memories.put({ kind: 'project_fact', scopeKind: 'global', text: '有期限的来源', expiresAt: now + 1000,
    actor: { id: 'owner', isUser: true } }, now)
  assert.ok(source.ok)
  const derived = memories.put({ kind: 'project_fact', scopeKind: 'global', text: '来源派生的结论', sourceRefs: [source.record.id, '其他来源'],
    actor: { id: 'owner', isUser: true } }, now)
  assert.ok(derived.ok)
  memories.applyRetention(now + 1001)
  assert.equal(memories.get(source.record.id, now + 1001)?.status, 'expired')
  assert.equal(memories.get(derived.record.id, now + 1001)?.status, 'candidate')
  assert.deepEqual(memories.get(derived.record.id, now + 1001)?.sourceRefs, ['其他来源'])
})

test('日报来源正在发布时保留原始采样与观察，等下次重试', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'retention-blocked-'))
  const db = openAssistantStore(path.join(dir, 'assistant.sqlite'))
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const sampleDir = path.join(dir, 'samples'); mkdirSync(sampleDir)
  const old = path.join(sampleDir, '2026-10-25.jsonl'); writeFileSync(old, '不应删除')
  const observations = new ObservationStore(db), memories = new MemoryStore(db), reports = new ReportStore(db), workItems = new WorkItemStore(db)
  const start = new Date('2026-10-25T10:00:00').getTime(), now = new Date('2026-10-31T12:00:00').getTime()
  observations.put({ id: 'old', source: 'activity_span', scopeKind: 'global', scopeId: '', startAt: start, endAt: start + 1000,
    timezone: 'Asia/Shanghai', summary: '原始观察', payloadRef: old, sensitivity: 'normal', legacyId: null, importBatch: null })
  reports.saveDraft('daily:2026-10-25', '尚在发布的草稿', now)
  db.prepare("UPDATE reports SET state = 'publishing' WHERE report_id = ?").run('daily:2026-10-25')
  assert.throws(() => applyRetention({ db, sampleDir, observations, memories, reports, workItems, retentionDays: 2, now }), /正在发布/)
  assert.equal(existsSync(old), true)
  assert.ok(observations.get('old'))
  assert.equal(observations.overlapsDeleted(start, start + 1000), false)
})

test('持续运行按周期清理；失败可重试，卸载后不再调用', () => {
  let tick: (() => void) | null = null, cleared = false, calls = 0, errors = 0
  const dispose = scheduleRetention(() => { calls++; if (calls === 1) throw new Error('模拟失败') }, () => { errors++ }, {
    setInterval: callback => { tick = callback; return 42 },
    clearInterval: id => { assert.equal(id, 42); cleared = true },
  })
  assert.equal(calls, 0, '初次清理由启动流程单独负责')
  ;(tick as unknown as () => void)()
  ;(tick as unknown as () => void)()
  assert.equal(calls, 2)
  assert.equal(errors, 1)
  dispose()
  assert.equal(cleared, true)
  ;(tick as unknown as () => void)()
  assert.equal(calls, 2, '卸载后的迟到定时回调不得继续清理')
})

test('未明确授权时启动和运行期间都不自动清理活动，明确启用只作用于隔离测试数据', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'retention-consent-'))
  const db = openAssistantStore(path.join(dir, 'assistant.sqlite'))
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const sampleDir = path.join(dir, 'samples'); mkdirSync(sampleDir)
  const old = path.join(sampleDir, '2026-10-25.jsonl'); writeFileSync(old, '隔离样例')
  const observations = new ObservationStore(db), memories = new MemoryStore(db), reports = new ReportStore(db), workItems = new WorkItemStore(db)
  const start = new Date('2026-10-25T10:00:00').getTime(), now = new Date('2026-10-31T12:00:00').getTime()
  observations.put({ id: 'keep-before-approval', source: 'activity_span', scopeKind: 'global', scopeId: '', startAt: start, endAt: start + 1000,
    timezone: 'Asia/Shanghai', summary: '隔离活动', payloadRef: old, sensitivity: 'normal', legacyId: null, importBatch: null })
  let scheduled = 0, calls = 0, tick: (() => void) | null = null
  const run = () => { calls++; applyRetention({ db, sampleDir, observations, memories, reports, workItems, retentionDays: 2, now }) }
  const hooks = { setInterval: (callback: () => void) => { scheduled++; tick = callback; return 42 }, clearInterval: () => {} }
  const defaults = Config({} as never)
  assert.equal(defaults.retentionAutoDelete, false)
  const stop = startRetention(defaults.retentionAutoDelete === true, run, () => {}, hooks)
  assert.equal(calls, 0)
  assert.equal(scheduled, 0)
  assert.ok(observations.get('keep-before-approval'))
  assert.equal(existsSync(old), true)
  assert.equal(observations.retentionBoundary(), null)
  stop()
  const enabled = Config({ retentionAutoDelete: true } as never)
  const stopEnabled = startRetention(enabled.retentionAutoDelete === true, run, () => {}, hooks)
  assert.equal(calls, 1, '明确启用后才执行首轮')
  assert.equal(scheduled, 1)
  assert.equal(observations.get('keep-before-approval'), null)
  assert.equal(existsSync(old), false)
  ;(tick as unknown as () => void)()
  assert.equal(calls, 2)
  stopEnabled()
})
