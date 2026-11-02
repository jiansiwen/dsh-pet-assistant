/** 保守整理只去掉相邻重复行，不猜测语义；所有数据使用隔离库。 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { MemoryStore } from '../src/memory.ts'
import { openAssistantStore } from '../src/store.ts'
import { workbenchFixture } from './support/workbench-fixture.ts'

const actor = { id: 'desktop-shell', isUser: true }
test('整理预览保留否定、期限和来源；批准后可撤回同一版本', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'memory-tidy-'))
  const db = openAssistantStore(path.join(dir, 'assistant.sqlite'))
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const memories = new MemoryStore(db), now = 1_800_000_000_000
  const original = '不要发送客户信息\n不要发送客户信息\n周五之前完成'
  const stored = memories.put({ kind: 'user_preference', scopeKind: 'global', text: original,
    sourceRefs: ['source-a', 'source-b'], expiresAt: now + 60_000, actor }, now)
  assert.ok(stored.ok)
  const preview = memories.previewTidy(stored.record.id, now)!
  assert.equal(preview.after, '不要发送客户信息\n周五之前完成')
  assert.deepEqual(preview.sourceRefs, ['source-a', 'source-b'])
  assert.equal(preview.expiresAt, now + 60_000)
  assert.equal(memories.applyTidy(preview, { id: 'model', isUser: false }, now), null)
  const applied = memories.applyTidy(preview, actor, now)!
  assert.equal(memories.get(stored.record.id, now)?.text, preview.after)
  assert.equal(memories.get(stored.record.id, now)?.expiresAt, now + 60_000)
  assert.deepEqual(memories.get(stored.record.id, now)?.sourceRefs, preview.sourceRefs)
  const undo = memories.previewTidyUndo(applied.tidyId, now)!
  assert.equal(undo.after, original)
  const restored = memories.undoTidy(applied.tidyId, undo.revision, actor, now)!
  assert.equal(restored.text, original)
  assert.equal(restored.revision, stored.record.revision + 2)
  assert.equal(memories.previewTidyUndo(applied.tidyId, now), null)
})

test('后续修改、过期或删除会阻止撤回；删除同时清理整理历史中的旧正文', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'memory-tidy-stale-'))
  const db = openAssistantStore(path.join(dir, 'assistant.sqlite'))
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const memories = new MemoryStore(db), now = 1_800_000_000_000
  const make = (text: string, expiresAt?: number) => {
    const result = memories.put({ kind: 'user_preference', scopeKind: 'global', text, expiresAt, actor }, now)
    assert.ok(result.ok)
    return result.record
  }
  const changed = make('原文\n原文')
  const applied = memories.applyTidy(memories.previewTidy(changed.id, now)!, actor, now)!
  const edit = memories.revise(changed.id, { text: '本人后续修改', expectedRevision: applied.appliedRevision, actor }, now + 1)
  assert.ok(edit)
  assert.equal(memories.previewTidyUndo(applied.tidyId, now + 2), null)
  assert.equal(memories.undoTidy(applied.tidyId, applied.appliedRevision, actor, now + 2), null)
  assert.equal(memories.get(changed.id, now + 2)?.text, '本人后续修改')
  assert.equal((db.prepare('SELECT before_text FROM memory_tidy_history WHERE tidy_id = ?').get(applied.tidyId) as { before_text: string }).before_text, '',
    '不可撤回后不保留多余的旧正文副本')
  const expiring = make('期限内\n期限内', now + 10)
  const limited = memories.applyTidy(memories.previewTidy(expiring.id, now)!, actor, now)!
  assert.equal(memories.previewTidyUndo(limited.tidyId, now + 11), null)
  const deleted = make('删除我\n删除我')
  const gone = memories.applyTidy(memories.previewTidy(deleted.id, now)!, actor, now)!
  memories.delete(deleted.id, '本人删除', now + 2)
  assert.equal(memories.previewTidyUndo(gone.tidyId, now + 3), null)
  assert.equal(memories.tidyHistory(deleted.id).length, 0)
  assert.equal(memories.get(deleted.id, now + 3), null)
})

test('对话工具只提交含前后内容的可信审批，批准前不写；撤回也需批准', async t => {
  const f = workbenchFixture(t)
  await f.rt.bind()
  const pending = await f.rt.call('remember_preference', { text: '不发客户信息\n不发客户信息', topic: '口径' })
  assert.equal((await f.rt.decide(pending.proposalId)).ok, true)
  const record = f.rt.memories.list({}, Date.now()).find(item => item.topic === '口径')!
  const proposed = await f.rt.call('tidy_memory', { id: record.id })
  assert.equal(proposed.pending, true)
  assert.equal(proposed.preview.before, record.text)
  assert.equal(proposed.preview.after, '不发客户信息')
  assert.equal(f.rt.memories.get(record.id, Date.now())?.text, record.text)
  const approved = await f.rt.decide(proposed.proposalId)
  assert.equal(approved.ok, true)
  const tidyId = (approved.result as { tidyId: string }).tidyId
  const listing = await f.rt.call('list_memory_tidy')
  assert.equal(listing.history[0].tidyId, tidyId)
  const undo = await f.rt.call('undo_memory_tidy', { tidyId })
  assert.equal(undo.pending, true)
  assert.equal((await f.rt.decide(undo.proposalId)).ok, true)
  assert.equal(f.rt.memories.get(record.id, Date.now())?.text, record.text)
})

test('撤回待批期间人工修改会作废，不覆盖新内容', async t => {
  const f = workbenchFixture(t)
  await f.rt.bind()
  const pending = await f.rt.call('remember_preference', { text: '不分享原文\n不分享原文', topic: '分享' })
  await f.rt.decide(pending.proposalId)
  const record = f.rt.memories.list({}, Date.now()).find(item => item.topic === '分享')!
  const tidy = await f.rt.call('tidy_memory', { id: record.id })
  const applied = await f.rt.decide(tidy.proposalId)
  const tidyId = (applied.result as { tidyId: string }).tidyId
  const undo = await f.rt.call('undo_memory_tidy', { tidyId })
  const current = f.rt.memories.get(record.id, Date.now())!
  assert.ok(f.rt.memories.revise(record.id, { text: '本人改成的新规则', expectedRevision: current.revision, actor }, Date.now()))
  assert.equal((await f.rt.decide(undo.proposalId)).ok, false)
  assert.equal(f.rt.memories.get(record.id, Date.now())?.text, '本人改成的新规则')
})

test('整理记录可跨重启撤回，删除记忆时相关历史一并删除', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'memory-tidy-restart-')), file = path.join(dir, 'assistant.sqlite'), now = 1_800_000_000_000
  let db = openAssistantStore(file), memories = new MemoryStore(db)
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const result = memories.put({ kind: 'user_preference', scopeKind: 'global', text: '不发送\n不发送', actor }, now)
  assert.ok(result.ok)
  const applied = memories.applyTidy(memories.previewTidy(result.record.id, now)!, actor, now)!
  db.close()
  db = openAssistantStore(file); memories = new MemoryStore(db)
  assert.ok(memories.previewTidyUndo(applied.tidyId, now + 1))
  assert.ok(memories.undoTidy(applied.tidyId, applied.appliedRevision, actor, now + 1))
  memories.delete(result.record.id, '本人删除', now + 2)
  assert.equal(memories.tidyHistory(result.record.id).length, 0)
  assert.equal(memories.previewTidyUndo(applied.tidyId, now + 3), null)
})

test('主助理整理工具不能读取或修改成员独立记忆', async t => {
  const f = workbenchFixture(t)
  await f.rt.bind()
  const record = f.rt.memories.put({ kind: 'user_preference', scopeKind: 'role', scopeId: 'private-member',
    text: '成员私有规则\n成员私有规则', actor }, Date.now())
  assert.ok(record.ok)
  const denied = await f.rt.call('tidy_memory', { id: record.record.id })
  assert.equal(denied.pending, false)
  assert.doesNotMatch(JSON.stringify(denied), /成员私有规则/)
  const history = f.rt.memories.applyTidy(f.rt.memories.previewTidy(record.record.id, Date.now())!, actor, Date.now())!
  const list = await f.rt.call('list_memory_tidy')
  assert.equal(list.history.some((entry: { tidyId: string }) => entry.tidyId === history.tidyId), false)
  const undo = await f.rt.call('undo_memory_tidy', { tidyId: history.tidyId })
  assert.equal(undo.pending, false)
  assert.doesNotMatch(JSON.stringify(undo), /成员私有规则/)
})
