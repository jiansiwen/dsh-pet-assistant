/**
 * M3-05 历史、删除范围和完整删除回执：真实库、真实工具、真实桥接 HTTP 与可信审批；
 * 采集器替身的"采样原文"可以被删除、也可以被"备份还原"。
 * 覆盖六类删除逐类预览与确认、M3 证据失效传播（事项 evidence_removed、相关日报保守撤销）、
 * 预览与实际结果一致、回执四类齐全、重启/备份恢复/旧记录回填不复活、导出文件删除失败可见。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { test } from 'node:test'
import { MigrationStore, runMigration, type LegacySource } from '../src/migrate.ts'
import { makeReportId } from '../src/report.ts'
import { workbenchFixture, type Runtime } from './support/workbench-fixture.ts'

const CHAT = '2026-10-17 10:02 张三：退款校验口径改成按订单金额\n2026-10-17 10:05 我：好的，今天改完'
const USER = { id: '测试用户', isUser: true }
const joined = (lines: string[]) => lines.join('\n')

async function preview(rt: Runtime, category: string, params: Record<string, unknown>) {
  const result = await rt.http('POST', '/workbench/deletion/preview', { category, params })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body.impact
}

async function request(rt: Runtime, category: string, params: Record<string, unknown>, previewDigest: string) {
  return rt.http('POST', '/workbench/deletion/request', { category, params, previewDigest })
}

function legacySource(days: LegacySource['days'], spans: { dates: string[]; of: (date: string) => ReturnType<LegacySource['spans']> } = { dates: [], of: () => [] }): LegacySource {
  return {
    preferences: () => [], days, reports: () => [], readReportFile: () => null,
    spans: spans.of, sampleDates: () => spans.dates, sampleFileOf: date => `samples/${date}.jsonl`,
  }
}

function migrate(rt: Runtime, source: LegacySource) {
  return runMigration({
    db: rt.db, memories: rt.memories, observations: rt.observations, reports: rt.reports, migrations: new MigrationStore(rt.db),
    source, targetVersion: 2, runId: `m3-${Date.now()}`, now: () => Date.now(),
  }, { fromDate: null, toDate: null, timezone: 'local' })
}

test('删除草稿条目只改本次日报：原始记录、资料、事项与记忆都不动；生成新版本并留回执，不需要可信审批', async t => {
  const f = workbenchFixture(t)
  await f.rt.bind()
  const reportId = makeReportId('daily', f.line.date)
  const day = await f.rt.call('today', { detail: 'full' })
  const chat = await f.rt.call('import_records', { content: CHAT, source: 'wechat_export', object: '张三' })
  const committed = await f.rt.call('commit_events', { events: [{ start: day.allSpans[0].start, end: day.allSpans[0].end, summary: '修改退款校验', status: 'direct',
    sources: [{ kind: 'import_material', ref: chat.materialId }, { kind: 'activity_observation', ref: day.allSpans[0].observationId }] }] })
  const itemId = committed.items[0].id
  const memory = f.rt.memories.put({ kind: 'project_fact', scopeKind: 'global', text: '退款按订单金额计算', sourceRefs: [chat.materialId], actor: USER }, Date.now())
  assert.ok(memory.ok)
  await f.rt.call('save_draft', { content: '# 日报\n\n- 修改退款校验\n- 回复张三\n', entries: [{ text: '修改退款校验', workItemIds: [itemId] }] })
  const view = await f.rt.view(f.line.date)
  const facts = () => JSON.stringify({
    observations: f.rt.observations.count(), materials: f.rt.materials.count(), notes: f.tracker.getDay(f.line.date).notes,
    item: f.rt.workItems.get(itemId), memory: f.rt.memories.get(memory.record.id, Date.now()),
  })
  const before = facts()
  const line = view.lines.find((item: { text: string }) => item.text === '修改退款校验')
  const params = { date: f.line.date, revision: 1, digest: view.current.digest, line: line.index, expectedText: '修改退款校验' }
  const impact = await preview(f.rt, 'draft_entry', params)
  assert.equal(impact.needsTrustedApproval, false)
  assert.match(impact.willDelete[0], /第 1 版里的第 1 条「修改退款校验」（删除后生成第 2 版）/)
  assert.match(joined(impact.retained), /原始活动、导入资料、工作事项和长期记忆都不受影响/)
  assert.match(joined(impact.retained), /第 1 版仍保留在历史里/)

  const stale = await request(f.rt, 'draft_entry', params, '刚才没看过影响')
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'preview_stale')
  const done = await request(f.rt, 'draft_entry', params, impact.digest)
  assert.equal(done.status, 200, JSON.stringify(done.body))
  assert.equal(done.body.kind, 'revision')
  assert.equal(done.body.revision, 2)
  assert.equal(facts(), before, '只改本次日报，不删除任何原始记录')
  assert.equal(f.rt.reports.revision(reportId, 1)!.content.includes('修改退款校验'), true, '旧版本原样留在历史里')
  assert.equal(f.rt.assistantApprovals.pendingProposals().length, 0)
  const after = await f.rt.view(f.line.date)
  assert.equal(after.receipts[0].category, 'draft_entry')
  assert.equal(after.workItems[0].inclusion.state, 'excluded')
})

test('删除导入资料：预览与实际传播一致，事项改为证据已删除、派生记忆传播、相关日报保守撤销；重启、备份恢复与旧记录回填都不复活', async t => {
  const f = workbenchFixture(t)
  await f.rt.bind()
  const date = f.line.date
  const reportId = makeReportId('daily', date)
  const day = await f.rt.call('today', { detail: 'full' })
  const [code, chatSpan] = day.allSpans
  const chat = await f.rt.call('import_records', { content: CHAT, source: 'wechat_export', object: '张三' })
  const other = await f.rt.call('import_records', { content: '周会纪要：上线推迟到周五', source: 'meeting_notes_paste' })
  const committed = await f.rt.call('commit_events', { events: [
    { start: chatSpan.start, end: chatSpan.end, summary: '与张三确认退款口径', discussionTopic: '退款口径', status: 'direct', sources: [{ kind: 'import_material', ref: chat.materialId }] },
    { start: code.start, end: code.end, summary: '修改退款校验', status: 'direct', sources: [{ kind: 'import_material', ref: chat.materialId }, { kind: 'activity_observation', ref: code.observationId }] },
    { start: code.start, end: code.end, summary: '确认上线时间', status: 'direct', sources: [{ kind: 'import_material', ref: other.materialId }] },
  ] })
  assert.equal(committed.committed, 3, JSON.stringify(committed))
  const [onlyChat, mixed, unrelated] = committed.items.map((item: { id: string }) => item.id)
  const derived = f.rt.memories.put({ kind: 'project_fact', scopeKind: 'global', topic: '口径', text: '退款按订单金额计算', sourceRefs: [chat.materialId], actor: USER }, Date.now())
  const shared = f.rt.memories.put({ kind: 'project_fact', scopeKind: 'global', topic: '上线', text: '周五上线', sourceRefs: [chat.materialId, other.materialId], actor: USER }, Date.now())
  assert.ok(derived.ok && shared.ok)
  await f.rt.call('save_draft', { content: '# 日报\n\n- 与张三确认退款口径\n', entries: [{ text: '与张三确认退款口径', workItemIds: [onlyChat] }] })
  const original = f.rt.materials.get(chat.materialId)!
  const legacyBefore = structuredClone(f.tracker.days.get(date)!)

  const params = { materialId: chat.materialId }
  const impact = await preview(f.rt, 'material', params)
  assert.equal(impact.needsTrustedApproval, true)
  assert.match(joined(impact.willDelete), /聊天片段 · 张三/)
  assert.match(joined(impact.willDelete), /当天记录里的同一条导入笔记原文/)
  assert.match(joined(impact.willDelete), /由这条笔记生成的事项摘要 1 条/)
  assert.match(joined(impact.willDelete), new RegExp(`派生记忆 .*${derived.ok ? derived.record.id : ''}.*随之删除`))
  assert.match(joined(impact.willInvalidate), new RegExp(`事项 ${onlyChat}.*证据已删除`))
  assert.match(joined(impact.willInvalidate), new RegExp(`事项 ${mixed}.*退回"推断"`))
  assert.match(joined(impact.willInvalidate), new RegExp(`${shared.ok ? shared.record.id : ''}.*退回候选`))
  assert.match(joined(impact.willInvalidate), new RegExp(`${reportId} 第 1 版未发布的日报保守撤销`))
  assert.equal(joined(impact.willInvalidate).includes(unrelated), false, '不相关的事项不在影响里')
  assert.match(joined(impact.uncontrolled), /会话历史里仍有原文/)
  assert.match(joined(impact.retained), /工作事项本身保留/)
  // 预览只是模拟：库里一行没变。
  assert.equal(f.rt.workItems.get(onlyChat)!.status, 'direct')
  assert.ok(f.rt.materials.get(chat.materialId))
  assert.ok(f.rt.memories.get(derived.ok ? derived.record.id : '', Date.now()))
  assert.equal(f.rt.reports.current(reportId)!.state, 'draft')

  const requested = await request(f.rt, 'material', params, impact.digest)
  assert.equal(requested.status, 200, JSON.stringify(requested.body))
  assert.equal(requested.body.kind, 'approval')
  assert.ok(f.rt.materials.get(chat.materialId), '提交待批后尚未删除')
  assert.equal((await f.rt.assistantApprovals.decide(requested.body.proposalId, 'approve', f.rt.bridge.epoch, f.rt.token)).ok, false, '聊天令牌不能批准删除')
  const decided = await f.rt.decide(requested.body.proposalId)
  assert.equal(decided.ok, true, JSON.stringify(decided))

  assert.equal(f.rt.materials.get(chat.materialId), null)
  assert.equal(f.rt.materials.deletedId(chat.materialId), true)
  assert.equal(f.tracker.getDay(date).notes.some(note => note.id === chat.materialId), false)
  assert.equal(f.tracker.getDay(date).events.some(event => event.evidence.includes(`note:${chat.materialId}`)), false)
  assert.equal(f.rt.workItems.get(onlyChat)!.status, 'evidence_removed')
  assert.equal(f.rt.workItems.get(mixed)!.status, 'inferred')
  assert.equal(f.rt.workItems.get(unrelated)!.status, 'direct')
  assert.equal(f.rt.memories.get(derived.ok ? derived.record.id : '', Date.now()), null)
  assert.equal(f.rt.memories.get(shared.ok ? shared.record.id : '', Date.now())!.status, 'candidate')
  assert.equal(f.rt.reports.revision(reportId, 1)!.state, 'revoked')
  const receipt = f.rt.reports.deletionReceipts(1)[0]!
  assert.equal(receipt.category, 'material')
  assert.deepEqual((receipt.receipt as { invalidated: string[] }).invalidated, impact.willInvalidate, '回执与预览出自同一段传播')
  assert.deepEqual((receipt.receipt as { failures: string[] }).failures, [])
  assert.equal(JSON.stringify(await f.rt.call('today')).includes('订单金额'), false)

  // 重启：同一个库、新的运行时。
  const rt2 = await f.restart()
  assert.equal(rt2.materials.get(chat.materialId), null)
  assert.equal(rt2.workItems.get(onlyChat)!.status, 'evidence_removed')
  // 从备份导入资料记录：被墓碑挡住。
  assert.deepEqual(rt2.materials.restore([original]).blocked.map(item => item.id), [chat.materialId])
  // 旧存储域被还原（笔记与它生成的摘要又回到当天记录里）：读取时照样挡住。
  f.tracker.days.set(date, structuredClone(legacyBefore))
  const restoredDay = await rt2.call('today')
  assert.equal(restoredDay.notes.some((note: { id: string }) => note.id === chat.materialId), false)
  assert.equal(JSON.stringify(restoredDay).includes('订单金额'), false)
  const relink = await rt2.call('commit_events', { events: [{ start: code.start, end: code.end, summary: '引用已删资料', status: 'inferred', sources: [{ kind: 'import_material', ref: chat.materialId }] }] })
  assert.equal(relink.committed, 0)
  assert.match(relink.error, /已被用户删除/)
  // 旧记录回填（迁移）也不把它带回观察库。
  const migrated = migrate(rt2, legacySource(() => [{ date, events: legacyBefore.events, notes: legacyBefore.notes }]))
  assert.equal(migrated.complete, true)
  assert.equal(rt2.observations.get(`legacy-note:${chat.materialId}`), null)
  assert.ok(rt2.observations.get(`legacy-note:${other.materialId}`), '没删的笔记照常回填')
  const chatEvent = legacyBefore.events.find(event => event.evidence.includes(`note:${chat.materialId}`))!
  assert.equal(rt2.observations.get(`legacy-event:${chatEvent.id}`), null, '笔记生成的摘要（含正文）同样不回填')
  assert.match(migrated.batches.find(batch => batch.id === 'legacy-days')!.message, /用户已删除不再导入 2 条/)
  // 用户自己重新导入是新的明确意图：允许，但如实提示。
  const again = await rt2.call('import_records', { content: CHAT, source: 'wechat_export' })
  assert.equal(again.imported, true)
  assert.match(again.notice, /以前被用户删除过/)
})

test('删除时间段活动经可信审批：记下删除区间，采样原文被还原、重启或回填后也不复活', async t => {
  const f = workbenchFixture(t)
  await f.rt.bind()
  const date = f.line.date
  const day = await f.rt.call('today', { detail: 'full' })
  const [code, chat] = day.allSpans
  const committed = await f.rt.call('commit_events', { events: [
    { start: code.start, end: code.end, summary: '在 refund.ts 上工作（推断）', status: 'inferred', sources: [{ kind: 'activity_observation', ref: code.observationId }] },
  ] })
  const itemId = committed.items[0].id
  await f.rt.call('save_draft', { content: '# 日报\n\n- 在 refund.ts 上工作（待确认）\n' })
  const params = { from: code.start, to: code.end, reason: '这段不想留' }
  const impact = await preview(f.rt, 'activity_range', params)
  assert.match(joined(impact.willDelete), /观察库中的活动片段 1 条/)
  assert.match(joined(impact.willDelete), /采样原文 1 条样本/)
  assert.match(joined(impact.willInvalidate), new RegExp(`事项 ${itemId}.*证据已删除`))
  assert.match(joined(impact.willInvalidate), /未发布的日报保守撤销/)
  assert.match(joined(impact.retained), /区间以外的活动记录/)
  assert.match(joined(impact.uncontrolled), /已注入模型提示词/)

  const requested = await request(f.rt, 'activity_range', params, impact.digest)
  assert.equal(requested.body.kind, 'approval')
  assert.equal(f.tracker.stops, 0, '批准前不停采集、不删任何东西')
  assert.ok(f.rt.observations.get(code.observationId))
  const decided = await f.rt.decide(requested.body.proposalId)
  assert.equal(decided.ok, true, JSON.stringify(decided))
  assert.equal(f.tracker.stops, 1)
  assert.equal(f.rt.observations.get(code.observationId), null)
  assert.ok(f.rt.observations.get(chat.observationId), '区间外的观察保留')
  assert.equal(f.rt.workItems.get(itemId)!.status, 'evidence_removed')
  assert.deepEqual(f.rt.observations.deletedRanges().map(range => [range.from, range.to]), [[code.start, code.end]])
  assert.equal(f.rt.reports.deletionReceipts(1)[0]!.category, 'activity_range')

  // 采样原文被备份软件还原：读取当天时这段照样被挡住，也不会重新写进观察库。
  f.tracker.spans.set(date, [...f.line.spans])
  const restored = await f.rt.call('today', { detail: 'full' })
  assert.equal(restored.allSpans.some((span: { start: number }) => span.start === code.start), false)
  assert.equal(f.rt.observations.get(code.observationId), null)
  const rt2 = await f.restart()
  const afterRestart = await rt2.call('today', { detail: 'full' })
  assert.equal(afterRestart.allSpans.some((span: { start: number }) => span.start === code.start), false)
  const migrated = migrate(rt2, legacySource(() => [], { dates: [date], of: () => f.line.spans }))
  assert.equal(rt2.observations.get(code.observationId), null, '回填同样不导入删除区间里的片段')
  assert.match(migrated.batches.find(batch => batch.id === 'legacy-spans')!.message, /落在用户已删除时段而不再导入 1 条/)
})

test('删除长期记忆：预览与执行出自同一传播，回执四类齐全，备份恢复被删除账本挡住；模型工具与工作台同一口径', async t => {
  const f = workbenchFixture(t)
  await f.rt.bind()
  const rule = f.rt.memories.put({ kind: 'user_preference', scopeKind: 'global', topic: '日报', text: '日报不写午休', actor: USER }, Date.now())
  assert.ok(rule.ok)
  const derived = f.rt.memories.put({ kind: 'project_fact', scopeKind: 'global', text: '午休不计工时', sourceRefs: [rule.record.id], actor: USER }, Date.now())
  assert.ok(derived.ok)
  const params = { memoryId: rule.record.id }
  const impact = await preview(f.rt, 'memory', params)
  assert.equal(impact.willDelete.length, 2)
  assert.match(joined(impact.willDelete), new RegExp(rule.record.id))
  assert.match(joined(impact.willDelete), new RegExp(derived.record.id))
  assert.match(joined(impact.uncontrolled), /云端模型/)
  const tool = await f.rt.call('forget_preference', { id: rule.record.id })
  assert.equal(tool.pending, true)
  assert.deepEqual(tool.impact.willDelete, impact.willDelete, '模型发起与工作台发起的影响一致')
  const requested = await request(f.rt, 'memory', params, impact.digest)
  assert.equal(requested.body.kind, 'approval')
  const decided = await f.rt.decide(requested.body.proposalId)
  assert.equal(decided.ok, true)
  assert.equal(f.rt.memories.get(rule.record.id, Date.now()), null)
  assert.equal(f.rt.memories.get(derived.record.id, Date.now()), null)
  const receipt = f.rt.reports.deletionReceipts(1)[0]!.receipt as Record<string, string[]>
  assert.equal(receipt.deleted.length, 2)
  for (const key of ['deleted', 'invalidated', 'retained', 'uncontrolled', 'failures']) assert.ok(Array.isArray(receipt[key]), key)
  assert.equal(f.rt.memories.importRecord(rule.record), false, '备份恢复不能复活已删记忆')
  const blocked = await request(f.rt, 'memory', params, impact.digest)
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.code, 'blocked')
})

test('撤销版本与删除导出文件是两件事：撤销只改状态；只删内容一致的导出文件，失败可见，重启不复活', async t => {
  let failUnlink = true
  const f = workbenchFixture(t, {
    unlinkFile: async file => {
      if (failUnlink) throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${file}'`), { code: 'EBUSY' })
      await unlink(file)
    },
  })
  await f.rt.bind()
  const date = f.line.date
  const reportId = makeReportId('daily', date)
  await f.rt.call('save_draft', { content: '# 日报\n\n- 修改退款校验\n' })
  const view = await f.rt.view(date)
  const published = await f.rt.http('POST', '/workbench/report/publish-request', { date, revision: 1, digest: view.current.digest, targetPath: view.targetPath })
  assert.equal((await f.rt.decideReport(published.body.proposalId)).confirmed, true)
  const target = view.targetPath
  const content = readFileSync(target, 'utf8')

  // 文件被手动改过：不删。
  writeFileSync(target, '用户手改过的日报')
  const changed = await preview(f.rt, 'exported_file', { date, revision: 1 })
  assert.match(changed.blocked, /内容已和第 1 版不一致/)
  assert.equal((await request(f.rt, 'exported_file', { date, revision: 1 }, changed.digest)).status, 409)
  writeFileSync(target, content)

  // 撤销版本：只改状态，导出文件还在。
  const revoke = await preview(f.rt, 'report_version', { date, revision: 1 })
  assert.deepEqual(revoke.willDelete, [])
  assert.match(joined(revoke.retained), new RegExp(`已导出的文件 .* 仍在磁盘上`))
  const revoking = await request(f.rt, 'report_version', { date, revision: 1 }, revoke.digest)
  assert.equal((await f.rt.decide(revoking.body.proposalId)).ok, true)
  assert.equal(f.rt.reports.revision(reportId, 1)!.state, 'revoked')
  assert.ok(existsSync(target), '撤销版本不删导出文件')

  // 删除导出文件：第一次被占用，失败如实可见，文件原样还在。
  const exported = await preview(f.rt, 'exported_file', { date, revision: 1 })
  assert.equal(exported.blocked, null)
  assert.match(joined(exported.willDelete), /导出文件 /)
  assert.match(joined(exported.uncontrolled), /网盘/)
  assert.match(joined(exported.retained), /库里第 1 版的正文与状态不变/)
  const first = await request(f.rt, 'exported_file', { date, revision: 1 }, exported.digest)
  const failed = await f.rt.decide(first.body.proposalId) as { ok: boolean; result: { deleted: boolean; failures: string[] } }
  assert.equal(failed.result.deleted, false)
  assert.match(failed.result.failures.join('\n'), /EBUSY/)
  assert.ok(existsSync(target))
  let state = await f.rt.view(date)
  assert.match(joined(state.receipts[0].receipt.failures), /删除失败：EBUSY/)
  assert.deepEqual([state.exports[0].exists, state.exports[0].deletedAt], [true, null])

  failUnlink = false
  const retry = await preview(f.rt, 'exported_file', { date, revision: 1 })
  const second = await request(f.rt, 'exported_file', { date, revision: 1 }, retry.digest)
  assert.equal(second.status, 200, '失败后可以重新提交，不被"结果不明"卡住')
  const succeeded = await f.rt.decide(second.body.proposalId) as { ok: boolean; result: { deleted: boolean } }
  assert.equal(succeeded.result.deleted, true)
  assert.equal(existsSync(target), false)
  state = await f.rt.view(date)
  assert.equal(state.exports[0].exists, false)
  assert.ok(state.exports[0].deletedAt)
  assert.equal(f.rt.reports.revision(reportId, 1)!.content, content, '删导出文件不动库里的正文')

  const rt2 = await f.restart()
  assert.deepEqual(rt2.reports.openJobs(), [], '没有待核对的发布作业，重启恢复不会重写文件')
  assert.equal(existsSync(target), false)
  const reopened = await rt2.view(date)
  assert.ok(reopened.exports[0].deletedAt)
  assert.match((await preview(rt2, 'exported_file', { date, revision: 1 })).blocked, /已不存在/)
})

test('日报发布结果未知时，删除来源被如实挡住；不提供"全部清空"', async t => {
  const f = workbenchFixture(t, { publish: async () => { throw new Error('模拟发布结果不明') } })
  await f.rt.bind()
  const date = f.line.date
  const chat = await f.rt.call('import_records', { content: CHAT, source: 'wechat_export', object: '张三' })
  await f.rt.call('save_draft', { content: '# 日报\n\n- 与张三确认口径\n' })
  const view = await f.rt.view(date)
  const published = await f.rt.http('POST', '/workbench/report/publish-request', { date, revision: 1, digest: view.current.digest, targetPath: view.targetPath })
  const unknown = await f.rt.decideReport(published.body.proposalId)
  assert.match(unknown.error ?? '', /待核对/)
  const impact = await preview(f.rt, 'material', { materialId: chat.materialId })
  assert.match(impact.blocked, /正在发布或发布结果未知/)
  const blocked = await request(f.rt, 'material', { materialId: chat.materialId }, impact.digest)
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.code, 'blocked')
  assert.ok(f.rt.materials.get(chat.materialId))
  for (const category of ['all', 'everything', '']) {
    const response = await f.rt.http('POST', '/workbench/deletion/request', { category, params: {}, previewDigest: 'x' })
    assert.equal(response.status, 400)
  }
})
