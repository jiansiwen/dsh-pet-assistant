/**
 * M3-04 日报工作台与逐条修订确认：真实库、真实桥接 HTTP、真实日报可信审批与真实落盘。
 * 覆盖：每次改写/删除/补充都是新版本；基准版本不符如实冲突；条目与事项关联及纳入/排除原因；
 * 请求发布只接受用户看到的版本与路径；旧批准发布新稿被拒；重复批准不重复导出；
 * 磁盘错误与文件冲突如实反馈；发布后按现有规则停止采集并回报实际结果；工作台没有批准能力。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { makeReportId } from '../src/report.ts'
import { workbenchFixture, type Runtime } from './support/workbench-fixture.ts'

const DRAFT = '# 工作日报\n\n## 成果\n- 修改退款校验\n- 回复张三\n\n## 待确认\n- 整理文档（待确认）\n'

async function draftAndView(rt: Runtime, date: string, content = DRAFT, entries?: unknown) {
  const saved = await rt.call('save_draft', entries ? { content, entries } : { content })
  assert.equal(saved.savedDraft, true, JSON.stringify(saved))
  return rt.view(date)
}

const lineOf = (view: any, text: string) => {
  const line = view.lines.find((item: { text: string; kind: string }) => item.kind === 'entry' && item.text === text)
  assert.ok(line, `草稿里找不到「${text}」`)
  return line
}

test('逐条改写、删除、补充各产生新版本；预览不落库；基准版本不符如实冲突；版本历史说清每一版怎么来的', async t => {
  const f = workbenchFixture(t)
  await f.rt.bind()
  const reportId = makeReportId('daily', f.line.date)
  let view = await draftAndView(f.rt, f.line.date)
  assert.equal(view.current.revision, 1)
  assert.equal(view.stats.entries, 3)
  assert.equal(view.stats.pendingEntries, 1)
  assert.equal(view.targetPath, path.resolve(f.rt.reportDir, `${f.line.date}.md`))

  const reply = lineOf(view, '回复张三')
  const preview = await f.rt.edit(view, { type: 'rewrite', line: reply.index, expectedText: '回复张三', text: '回复张三关于上线时间' }, { dryRun: true })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.saved, false)
  assert.match(preview.body.preview, /- 回复张三关于上线时间/)
  assert.equal(f.rt.reports.history(reportId).length, 1, '预览不产生版本')

  const r2 = await f.rt.edit(view, { type: 'rewrite', line: reply.index, expectedText: '回复张三', text: '回复张三关于上线时间' })
  assert.equal(r2.body.revision, 2)
  assert.equal(r2.body.preview, preview.body.preview, '保存结果与预览一致')
  assert.equal(f.rt.reports.current(reportId)!.content, r2.body.preview)

  const stale = await f.rt.edit(view, { type: 'delete', line: lineOf(view, '修改退款校验').index, expectedText: '修改退款校验' })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'stale_base')
  assert.equal(stale.body.current.revision, 2)
  assert.match(stale.body.error, /你看到的是第 1 版/)
  assert.equal(f.rt.reports.history(reportId).length, 2, '旧基准上的修改不保存')

  view = await f.rt.view(f.line.date)
  const mismatch = await f.rt.edit(view, { type: 'delete', line: lineOf(view, '修改退款校验').index, expectedText: '别的内容' })
  assert.equal(mismatch.status, 409)
  assert.equal(mismatch.body.code, 'text_mismatch')
  const r3 = await f.rt.edit(view, { type: 'delete', line: lineOf(view, '修改退款校验').index, expectedText: '修改退款校验' })
  assert.equal(r3.body.revision, 3)
  view = await f.rt.view(f.line.date)
  const r4 = await f.rt.edit(view, { type: 'add', afterLine: lineOf(view, '回复张三关于上线时间').index, text: '补充：联调支付回调' })
  assert.equal(r4.body.revision, 4)
  view = await f.rt.view(f.line.date)
  assert.deepEqual(view.lines.filter((line: { kind: string }) => line.kind === 'entry').map((line: { text: string }) => line.text),
    ['回复张三关于上线时间', '补充：联调支付回调', '整理文档（待确认）'])
  assert.equal((await f.rt.edit(view, { type: 'add', afterLine: -1, text: '一\n二' })).body.code, 'multiline')
  assert.equal((await f.rt.edit(view, { type: 'rewrite', line: lineOf(view, '整理文档（待确认）').index, expectedText: '整理文档（待确认）', text: '整理文档（待确认）' })).body.code, 'no_change')

  assert.deepEqual(f.rt.reports.edits(reportId).map(edit => [edit.revision, edit.actor, edit.op]),
    [[1, 'assistant', 'replace'], [2, 'workbench', 'rewrite'], [3, 'workbench', 'delete'], [4, 'workbench', 'add']])
  assert.match(view.history.find((item: { revision: number }) => item.revision === 3).change, /你删除了一条：「修改退款校验」/)
  assert.equal(view.current.change, '你补充了一条：「补充：联调支付回调」')
  for (const revision of [1, 2, 3]) assert.equal(f.rt.reports.revision(reportId, revision)!.state, 'revoked', '旧版本留在历史里，确认随之作废')
})

test('条目关联工作事项：纳入/排除及原因如实显示；推断事项须标注待确认；证据已删除的事项不能写入', async t => {
  const f = workbenchFixture(t)
  await f.rt.bind()
  const day = await f.rt.call('today', { detail: 'full' })
  const [code, chat] = day.allSpans
  const proof = await f.rt.call('import_records', { content: 'npm test\n# pass 12\n# fail 0', source: 'test_output_paste' })
  const committed = await f.rt.call('commit_events', { events: [
    { start: code.start, end: code.end, summary: '修改退款校验', outcome: '单测通过', status: 'direct', sources: [{ kind: 'import_material', ref: proof.noteId }, { kind: 'activity_observation', ref: code.observationId }] },
    { start: chat.start, end: chat.end, summary: '使用微信', status: 'inferred', sources: [{ kind: 'activity_observation', ref: chat.observationId }] },
  ] })
  assert.equal(committed.committed, 2)
  const [directId, inferredId] = committed.items.map((item: { id: string }) => item.id)

  const unmarked = await f.rt.call('save_draft', { content: '# 日报\n\n- 修改退款校验，单测通过\n- 使用微信\n', entries: [
    { text: '修改退款校验，单测通过', workItemIds: [directId] }, { text: '使用微信', workItemIds: [inferredId] },
  ] })
  assert.equal(unmarked.savedDraft, false)
  assert.match(unmarked.message, /必须标注"（待确认）"/)
  const missing = await f.rt.call('save_draft', { content: '# 日报\n\n- 修改退款校验\n', entries: [{ text: '不存在的条目', workItemIds: [directId] }] })
  assert.equal(missing.savedDraft, false)
  assert.match(missing.message, /找不到这一条/)
  assert.equal(f.rt.reports.current(makeReportId('daily', f.line.date)), null, '关联不成立时整份草稿不保存')

  let view = await draftAndView(f.rt, f.line.date, '# 日报\n\n- 修改退款校验，单测通过\n- 使用微信（待确认）\n', [
    { text: '修改退款校验，单测通过', workItemIds: [directId] }, { text: '- 使用微信（待确认）', workItemIds: [inferredId] },
  ])
  const inclusion = (id: string) => view.workItems.find((item: { id: string }) => item.id === id).inclusion
  assert.deepEqual([inclusion(directId).state, inclusion(directId).reason], ['included', '已写入第 1 条'])
  assert.deepEqual([inclusion(inferredId).state, inclusion(inferredId).reason], ['included', '以"待确认"写入第 2 条'])
  assert.equal(view.workItems.find((item: { id: string }) => item.id === directId).statusLabel, '直接证据')

  // 在工作台删掉写着直接证据事项的那一条：事项本身还在，只是"你在第 2 版删除了相关条目"。
  const r2 = await f.rt.edit(view, { type: 'delete', line: lineOf(view, '修改退款校验，单测通过').index, expectedText: '修改退款校验，单测通过' })
  assert.equal(r2.body.revision, 2)
  view = await f.rt.view(f.line.date)
  assert.deepEqual([inclusion(directId).state, inclusion(directId).reason], ['excluded', '你在第 2 版删除了相关条目'])
  assert.equal(inclusion(inferredId).lines[0], lineOf(view, '使用微信（待确认）').index, '删除上一行后，关联随条目平移')
  assert.equal(f.rt.workItems.get(directId)!.status, 'direct', '改日报不动事项')

  // 从事项补回：推断事项自动带"（待确认）"，关联一起记下。
  const readd = await f.rt.edit(view, { type: 'add', afterLine: -1, text: '' }, { workItemId: directId })
  assert.equal(readd.body.after, '修改退款校验')
  view = await f.rt.view(f.line.date)
  assert.equal(inclusion(directId).state, 'included')
  const inferredAgain = await f.rt.edit(view, { type: 'add', afterLine: -1, text: '用微信回复' }, { workItemId: inferredId })
  assert.equal(inferredAgain.body.after, '用微信回复（待确认）')

  // 证据被删：不能再写入，也不展示它的概括。
  f.rt.workItems.removeSources('activity_observation', [chat.observationId], '测试删除来源', Date.now())
  assert.equal(f.rt.workItems.get(inferredId)!.status, 'evidence_removed')
  view = await f.rt.view(f.line.date)
  const blocked = await f.rt.edit(view, { type: 'add', afterLine: -1, text: '' }, { workItemId: inferredId })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.code, 'evidence_removed')
  assert.equal(view.evidenceRemoved.count, 1)
  assert.equal(view.workItems.some((item: { id: string }) => item.id === inferredId), false)
  assert.equal(JSON.stringify(view.evidenceRemoved).includes('使用微信'), false)
  const relinked = await f.rt.call('save_draft', { content: '# 日报\n\n- 用微信（待确认）\n', entries: [{ text: '用微信（待确认）', workItemIds: [inferredId] }] })
  assert.equal(relinked.savedDraft, false)
  assert.match(relinked.message, /证据已被用户删除/)
})

test('请求发布只接受用户看到的版本与路径；旧批准发布新稿被拒；重复批准不重复导出；磁盘文件与最后预览一致', async t => {
  const f = workbenchFixture(t)
  await f.rt.bind()
  const reportId = makeReportId('daily', f.line.date)
  let view = await draftAndView(f.rt, f.line.date)
  // 连续改三次。
  await f.rt.edit(view, { type: 'rewrite', line: lineOf(view, '回复张三').index, expectedText: '回复张三', text: '回复张三：周五上线' })
  view = await f.rt.view(f.line.date)
  await f.rt.edit(view, { type: 'delete', line: lineOf(view, '整理文档（待确认）').index, expectedText: '整理文档（待确认）' })
  view = await f.rt.view(f.line.date)
  const older = view
  await f.rt.edit(view, { type: 'add', afterLine: lineOf(view, '回复张三：周五上线').index, text: '联调支付回调' })
  view = await f.rt.view(f.line.date)
  assert.equal(view.current.revision, 4)
  const publish = (from: any, overrides: Record<string, unknown> = {}) => f.rt.http('POST', '/workbench/report/publish-request', {
    date: from.date, revision: from.current.revision, digest: from.current.digest, targetPath: from.targetPath, ...overrides,
  })

  const stale = await publish(older)
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'stale_revision')
  const wrongTarget = await publish(view, { targetPath: path.join(f.dir, '别处.md') })
  assert.equal(wrongTarget.status, 409)
  assert.equal(wrongTarget.body.code, 'target_mismatch')
  assert.equal(f.rt.reportApprovals.pendingProposals().length, 0, '不一致的请求不生成待批')

  const first = await publish(view)
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.revision, 4, '修订号原样回传')
  assert.equal(first.body.target, view.targetPath)
  const card = f.rt.reportApprovals.pendingProposals()[0]!
  assert.equal(card.proposalId, first.body.proposalId)
  assert.match(card.summary, /共 3 条/)
  assert.match(card.summary, /本版由你在工作台补充了第 3 条/)
  assert.deepEqual((await publish(view)).body.proposalId, first.body.proposalId, '重复请求返回同一条待批')
  assert.equal(view.capture?.active, true)

  // 审批窗口打开后用户又改了一次：旧批准不能发布新稿。
  await f.rt.edit(view, { type: 'rewrite', line: lineOf(view, '联调支付回调').index, expectedText: '联调支付回调', text: '联调支付回调（已自测）' })
  const credential = f.rt.approvalCredential()
  const approve = (proposalId: string) => f.rt.http('POST', '/report-approval', { proposalId, decision: 'approve', epoch: credential.epoch }, { token: null, approvalToken: credential.reportApprovalToken })
  const oldApproval = await approve(first.body.proposalId)
  assert.equal(oldApproval.status, 409)
  assert.equal(oldApproval.body.error, 'DIGEST_MISMATCH')
  assert.equal(existsSync(view.targetPath), false)
  assert.equal(f.rt.counters.publishes, 0)

  const last = await f.rt.view(f.line.date)
  assert.equal(last.current.revision, 5)
  const second = await publish(last)
  assert.equal(second.status, 200)
  assert.equal((await f.rt.http('POST', '/report-approval', { proposalId: second.body.proposalId, decision: 'approve', epoch: credential.epoch }, { token: null, approvalToken: f.rt.token })).status, 403, '聊天令牌不能批准')
  const approved = await approve(second.body.proposalId)
  assert.equal(approved.status, 200, JSON.stringify(approved.body))
  assert.equal(approved.body.confirmed, true)
  assert.equal(approved.body.revision, 5)
  assert.equal(approved.body.modeExited, true)
  assert.equal(readFileSync(last.targetPath, 'utf8'), last.current.content, '磁盘文件与最后预览一致')
  assert.equal(f.tracker.stops, 1, '保存成功后按现有规则停止采集')

  const replay = await approve(second.body.proposalId)
  assert.equal(replay.status, 409)
  assert.equal(replay.body.error, 'ALREADY_CONSUMED')
  const again = await publish(last)
  assert.equal(again.status, 409)
  assert.equal(again.body.code, 'already_published')
  assert.equal(f.rt.counters.publishes, 1, '重复批准、重复请求都不重复导出')

  const after = await f.rt.view(f.line.date)
  assert.equal(after.current.state, 'archived')
  assert.equal(after.lastPublish.savedPath, last.targetPath)
  assert.equal(after.lastPublish.modeExited, true)
  assert.match(after.lastPublish.message, /活动记录已停止/)
  assert.deepEqual(after.exports.map((item: { revision: number; exists: boolean; matchesRevision: boolean }) => [item.revision, item.exists, item.matchesRevision]), [[5, true, true]])
  assert.equal(f.rt.reports.current(reportId)!.state, 'archived')
})

test('磁盘错误与文件冲突如实反馈并退回草稿；修复后须重新批准；目标已是这一版时不重复写入', async t => {
  const f = workbenchFixture(t)
  await f.rt.bind()
  const credential = () => f.rt.approvalCredential()
  const requestAndApprove = async () => {
    const view = await f.rt.view(f.line.date)
    const requested = await f.rt.http('POST', '/workbench/report/publish-request', {
      date: view.date, revision: view.current.revision, digest: view.current.digest, targetPath: view.targetPath,
    })
    assert.equal(requested.status, 200, JSON.stringify(requested.body))
    const decided = await f.rt.http('POST', '/report-approval', { proposalId: requested.body.proposalId, decision: 'approve', epoch: credential().epoch },
      { token: null, approvalToken: credential().reportApprovalToken })
    return { view, decided }
  }
  let view = await draftAndView(f.rt, f.line.date)
  const target = view.targetPath

  // 文件冲突：目标位置已有别的内容（例如用户手改过），不覆盖。
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, '用户自己写的日报，不能被覆盖')
  const conflict = await requestAndApprove()
  assert.equal(conflict.decided.body.confirmed, false)
  assert.match(conflict.decided.body.error, /不是这份日报发布过的任何一版/)
  assert.equal(readFileSync(target, 'utf8'), '用户自己写的日报，不能被覆盖')
  view = await f.rt.view(f.line.date)
  assert.equal(view.current.state, 'draft', '失败退回草稿')
  assert.match(view.lastPublish.error, /不是这份日报发布过的任何一版/)
  assert.equal(f.tracker.stops, 0, '没保存就不停止采集')

  // 磁盘错误：目标目录被一个文件占着，写不进去。
  rmSync(path.dirname(target), { recursive: true, force: true })
  writeFileSync(path.dirname(target), '占位文件')
  const disk = await requestAndApprove()
  assert.equal(disk.decided.body.confirmed, false)
  assert.match(disk.decided.body.error, /未完成发布，修复后须重新提交并由用户批准/)
  view = await f.rt.view(f.line.date)
  assert.equal(view.lastPublish.confirmed, false)
  assert.equal(view.current.state, 'draft')

  rmSync(path.dirname(target), { force: true })
  const fixed = await requestAndApprove()
  assert.equal(fixed.decided.body.confirmed, true, JSON.stringify(fixed.decided.body))
  assert.equal(readFileSync(target, 'utf8'), fixed.view.current.content)
  const firstContent = fixed.view.current.content

  // 改稿后再发布：目标里是本日报发布过的那一版，可以覆盖。
  view = await f.rt.view(f.line.date)
  await f.rt.edit(view, { type: 'rewrite', line: lineOf(view, '回复张三').index, expectedText: '回复张三', text: '回复张三：已确认' })
  const overwrite = await requestAndApprove()
  assert.equal(overwrite.decided.body.confirmed, true)
  assert.equal(readFileSync(target, 'utf8'), overwrite.view.current.content)

  // 再改回原样：目标文件内容与要发布的这一版不同（是上一版），正常覆盖；
  // 之后把文件手动还原成待发布的同一内容，再批准时不重复写入。
  view = await f.rt.view(f.line.date)
  await f.rt.edit(view, { type: 'rewrite', line: lineOf(view, '回复张三：已确认').index, expectedText: '回复张三：已确认', text: '回复张三' })
  writeFileSync(target, firstContent)
  const before = statSync(target).mtimeMs
  const unchanged = await requestAndApprove()
  assert.equal(unchanged.view.current.content, firstContent)
  assert.equal(unchanged.decided.body.confirmed, true)
  assert.match(unchanged.decided.body.message, /没有重复写入/)
  assert.equal(statSync(target).mtimeMs, before, '内容已经一致时不重写文件')
})

test('工作台复用聊天令牌：审批令牌不能当聊天令牌；未绑定时可看不可改；没有批准、也没有"全部清空"入口', async t => {
  const f = workbenchFixture(t)
  await f.rt.listen()
  await f.rt.call('save_draft', { content: DRAFT })
  assert.equal((await f.rt.http('GET', `/workbench/report?date=${f.line.date}`, undefined, { token: null })).status, 401)
  const unboundView = await f.rt.http('GET', `/workbench/report?date=${f.line.date}`)
  assert.equal(unboundView.status, 200, '未绑定时照常可以查看')
  const unboundEdit = await f.rt.edit(unboundView.body, { type: 'add', afterLine: -1, text: '未绑定时补充' })
  assert.equal(unboundEdit.status, 503)
  assert.equal(unboundEdit.body.code, 'unbound')
  const unboundDelete = await f.rt.http('POST', '/workbench/deletion/request', { category: 'memory', params: { memoryId: 'x' } })
  assert.equal(unboundDelete.status, 503)

  await f.rt.bind()
  const credential = f.rt.approvalCredential()
  assert.equal((await f.rt.http('GET', `/workbench/report?date=${f.line.date}`, undefined, { token: credential.reportApprovalToken })).status, 401, '审批凭据不是聊天令牌')
  for (const route of ['/workbench/report/approve', '/workbench/approval', '/workbench/report/publish']) {
    assert.equal((await f.rt.http('POST', route, { proposalId: 'x', decision: 'approve' })).status, 404, `${route} 不存在`)
  }
  const clearAll = await f.rt.http('POST', '/workbench/deletion/preview', { category: 'all', params: {} })
  assert.equal(clearAll.status, 400)
  assert.match(clearAll.body.error, /不提供"全部清空"/)
  const badDate = await f.rt.http('GET', '/workbench/report?date=2026-13')
  assert.equal(badDate.status, 400)
  const view = await f.rt.view(f.line.date)
  assert.deepEqual(view.deletionCategories, ['draft_entry', 'report_version', 'activity_range', 'material', 'memory', 'exported_file'])
})
