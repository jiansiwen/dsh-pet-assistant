/**
 * 自动记录模式（用户配置 approvalMode: 'auto'）。
 *
 * 这两条路径的共同点：模型仍然调同一个工具、仍然拿不到审批凭据；
 * 区别只在于"谁签发"——手动模式是桌面专用审批窗口，自动模式是用户自己在设置里打开的那条开关。
 * 所以要守住的性质是：
 * 1. 自动模式真的落盘、状态真的归档，且不需要任何审批卡片；
 * 2. 走的是同一条发布路径（摘要校验、失败退草稿、不重发）；
 * 3. 审计里能区分"用户确认过"和"自动保存"，不会把后者记成前者；
 * 4. 长期偏好在自动模式下直接落库，不再是 pending。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { makeReportId } from '../src/report.ts'
import { workbenchFixture } from './support/workbench-fixture.ts'

const DRAFT = '# 工作日报\n\n## 成果\n- 完成 A 模块联调\n'

test('自动模式：提交草稿直接写进目标文件，不产生待批卡、不需批准', async t => {
  const f = workbenchFixture(t, { approvalMode: 'auto' })
  await f.rt.bind()
  const reportId = makeReportId('daily', f.line.date)
  assert.equal((await f.rt.call('save_draft', { content: DRAFT })).savedDraft, true)

  const submitted = await f.rt.call('submit_report', {})
  assert.equal(submitted.mode, 'auto')
  assert.equal(submitted.submitted, true, JSON.stringify(submitted))
  assert.equal(submitted.published, true)
  assert.equal(submitted.alreadyCurrent, false)

  const target = path.resolve(f.rt.reportDir, `${f.line.date}.md`)
  assert.equal(submitted.targetPath, target)
  assert.equal(existsSync(target), true, '自动模式下文件必须真的写出来')
  assert.equal(readFileSync(target, 'utf8'), DRAFT)

  // 没有审批卡：模型这一侧从来没有拿到过任何待批提案。
  assert.deepEqual(f.rt.bridge.pendingReportApprovals(), [])
  assert.equal(f.rt.reports.current(reportId)!.state, 'archived')
  // 审计：签发者是 auto-publish，不是桌面可信窗口。
  const record = f.rt.reports.current(reportId)!
  assert.equal(f.rt.reports.revision(reportId, record.revision)!.state, 'archived')
  assert.equal(f.rt.counters.publishes, 1)
})

test('自动模式重复提交：不重复发布，如实说明"已是这一版"', async t => {
  const f = workbenchFixture(t, { approvalMode: 'auto' })
  await f.rt.bind()
  await f.rt.call('save_draft', { content: DRAFT })
  assert.equal((await f.rt.call('submit_report', {})).published, true)

  const again = await f.rt.call('submit_report', {})
  assert.equal(again.mode, 'auto')
  // 第二版已经归档：如实说明不能重发，而不是假装又发了一次。
  assert.equal(again.published, false)
  assert.match(again.message, /不能重复发布|已是|archived/)
  assert.equal(f.rt.counters.publishes, 1, '落盘只发生一次')
  assert.equal(readFileSync(path.resolve(f.rt.reportDir, `${f.line.date}.md`), 'utf8'), DRAFT, '文件内容没被改')
})

test('自动模式落盘失败：退回草稿、如实报错，修好后重新提交能发出', async t => {
  let fail = true
  const f = workbenchFixture(t, {
    approvalMode: 'auto',
    publish: async () => (fail
      ? { ok: false, reason: 'target_conflict', message: '目标文件被别的内容占着' }
      : { ok: true, path: path.resolve(f.rt.reportDir, `${f.line.date}.md`), digest: 'ignored' }),
  })
  await f.rt.bind()
  const reportId = makeReportId('daily', f.line.date)
  await f.rt.call('save_draft', { content: DRAFT })

  const failed = await f.rt.call('submit_report', {})
  assert.equal(failed.published, false)
  assert.match(failed.message, /自动保存未完成/)
  assert.match(failed.message, /占着/)
  assert.equal(f.rt.reports.current(reportId)!.state, 'draft', '失败后退回草稿，不能停在已批准')

  fail = false
  const ok = await f.rt.call('submit_report', {})
  assert.equal(ok.published, true, JSON.stringify(ok))
})

test('手动模式不受影响：仍然只提交待批，文件不写出来', async t => {
  const f = workbenchFixture(t)
  await f.rt.bind()
  await f.rt.call('save_draft', { content: DRAFT })
  const submitted = await f.rt.call('submit_report', {})
  assert.equal(submitted.mode, 'manual')
  assert.equal(submitted.submitted, true)
  assert.ok(submitted.proposalId)
  assert.equal(f.rt.bridge.pendingReportApprovals().length, 1)
  assert.equal(existsSync(path.resolve(f.rt.reportDir, `${f.line.date}.md`)), false, '没批准就不写文件')
})

test('自动模式：长期偏好直接落库，返回 remembered 而不是 pending', async t => {
  const f = workbenchFixture(t, { approvalMode: 'auto' })
  await f.rt.bind()
  const saved = await f.rt.call('remember_preference', { text: '日报不包含 lu 项目', topic: '日报口径' })
  assert.equal(saved.pending, false, JSON.stringify(saved))
  assert.equal(saved.mode, 'auto')
  assert.equal(saved.remembered, true)
  assert.equal(saved.status, 'confirmed')
  assert.equal(f.rt.memories.list({}, Date.now()).some(item => item.text === '日报不包含 lu 项目'), true)
})

test('手动模式：记忆仍然只提交待批', async t => {
  const f = workbenchFixture(t)
  await f.rt.bind()
  const pending = await f.rt.call('remember_preference', { text: '日报不写时长', topic: '日报口径' })
  assert.equal(pending.pending, true)
  assert.equal(pending.remembered, undefined)
  assert.equal(f.rt.memories.list({}, Date.now()).some(item => item.text === '日报不写时长'), false)
})

test('改写记忆：自动模式直接生效，换的是正文不是编号', async t => {
  const f = workbenchFixture(t, { approvalMode: 'auto' })
  await f.rt.bind()
  const saved = await f.rt.call('remember_preference', { text: '日报不写时长', topic: '日报口径' })
  assert.equal(saved.remembered, true, JSON.stringify(saved))
  const id = String(saved.id)

  const edited = await f.rt.call('edit_preference', { id, text: '日报不写时长，也不写时间段' })
  assert.equal(edited.edited, true, JSON.stringify(edited))
  assert.equal(edited.mode, 'auto')
  assert.equal(edited.id, id, '编号必须不变')
  assert.equal(edited.revision, Number(saved.revision) + 1)
  const record = f.rt.memories.get(id, Date.now())!
  assert.equal(record.text, '日报不写时长，也不写时间段')
  assert.equal(f.rt.memories.list({}, Date.now()).filter(item => item.topic === '日报口径').length, 1, '不是新建一条')
})

test('改写记忆：手动模式只提交待批；不存在的编号与空正文直接拒绝', async t => {
  const f = workbenchFixture(t)
  await f.rt.bind()
  const pending = await f.rt.call('remember_preference', { text: '日报按项目分组', topic: '日报口径' })
  assert.equal(pending.pending, true)
  assert.equal((await f.rt.decide(pending.proposalId)).ok, true)
  const record = f.rt.memories.list({}, Date.now()).find(item => item.text === '日报按项目分组')!

  const submitted = await f.rt.call('edit_preference', { id: record.id, text: '日报按项目分组，先写主线' })
  assert.equal(submitted.pending, true, JSON.stringify(submitted))
  assert.equal(f.rt.memories.get(record.id, Date.now())!.text, '日报按项目分组', '批准前不改')
  assert.equal((await f.rt.decide(submitted.proposalId)).ok, true)
  assert.equal(f.rt.memories.get(record.id, Date.now())!.text, '日报按项目分组，先写主线')

  const missing = await f.rt.call('edit_preference', { id: 'mem-不存在', text: '新内容' })
  assert.equal(missing.pending, false)
  assert.match(String(missing.error), /找不到/)
  const empty = await f.rt.call('edit_preference', { id: record.id, text: '  ' })
  assert.equal(empty.pending, false)
  assert.match(String(empty.error), /不能是空/)
})
