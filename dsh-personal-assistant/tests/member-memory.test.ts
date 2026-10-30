import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, type MemoryRecord } from '../src/memory.ts'
import { MemberMemory } from '../src/member-memory.ts'
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:')
  const store = new MemoryStore(db)
  const rotated: string[] = []
  const service = new MemberMemory({ store, ownerId: 'owner', exists: id => ['a', 'b'].includes(id), invalidate: id => { rotated.push(id) } })
  t.after(() => db.close())
  return { db, store, service, rotated }
}
test('成员记忆按稳定身份隔离，模型只能提候选，确认后才注入', t => {
  const { service, store } = fixture(t)
  store.put({ kind: 'user_preference', scopeKind: 'global', topic: '私密', text: '不应注入子成员的全局资料', actor: { id: 'owner', isUser: true } }, Date.now())
  const candidate = service.propose('a', { kind: 'user_preference', topic: '语言', text: '使用中文', sourceRefs: ['session:test'] }) as { id: string; revision: number }
  assert.equal(service.list('a')[0].status, 'candidate')
  assert.equal(service.list('b').length, 0)
  assert.doesNotMatch(service.injectable('a'), /使用中文|全局资料/)
  assert.throws(() => service.request('b', 'confirm', { expectedRevision: candidate.revision }, candidate.id), /不属于/)
  service.request('a', 'confirm', { expectedRevision: candidate.revision }, candidate.id)
  assert.match(service.injectable('a'), /使用中文/)
  assert.doesNotMatch(service.injectable('b'), /使用中文/)
})
test('改写保留记忆编号，旧版本拒绝，删除预览之后版本变动需重审', t => {
  const { service, rotated } = fixture(t)
  const { record } = service.request('a', 'create', { kind: 'task_breakpoint', topic: '工作', text: '完成第一步' }) as { record: MemoryRecord }
  const preview = service.request('a', 'delete-preview', { expectedRevision: record.revision }, record.id) as { previewId: string }
  const result = service.request('a', 'update', { expectedRevision: record.revision, text: '完成第二步', topic: '工作' }, record.id) as { record: MemoryRecord }
  assert.equal(result.record.id, record.id)
  assert.equal(result.record.revision, record.revision + 1)
  assert.throws(() => service.request('a', 'update', { expectedRevision: record.revision, text: '覆盖' }, record.id), /版本/)
  assert.throws(() => service.request('a', 'delete', { expectedRevision: result.record.revision, previewId: preview.previewId }, record.id), /预览/)
  const fresh = service.request('a', 'delete-preview', { expectedRevision: result.record.revision }, record.id) as { previewId: string }
  service.request('a', 'delete', { expectedRevision: result.record.revision, previewId: fresh.previewId }, record.id)
  assert.equal(service.list('a').length, 0)
  assert.throws(() => service.propose('a', { kind: 'task_breakpoint', topic: '工作', text: '完成第二步' }), /删除/)
  assert.equal(rotated.length, 3)
})
test('按成员清除全部独立记忆，其他成员保留，删除账本阻止恢复', t => {
  const { service, store, rotated } = fixture(t)
  const first = service.request('a', 'create', { kind: 'user_preference', topic: '表达', text: '结论先行' }) as { record: MemoryRecord }
  service.request('a', 'create', { kind: 'task_breakpoint', topic: '进度', text: '第二步' })
  service.request('b', 'create', { kind: 'user_preference', topic: '称呼', text: '叫小王' })
  assert.equal(service.list('a').length, 2)
  assert.deepEqual(service.purge('a'), { memories: 2, weakened: 0, restored: 0 })
  assert.equal(service.list('a').length, 0)
  assert.equal(service.list('b').length, 1)
  assert.equal(store.ledgerSize(), 2)
  assert.ok(rotated.includes('a'))
  assert.equal(store.filterRestored([{ ...first.record, id: '恢复副本' }]).blocked.length, 1)
})

test('拒绝凭据、伪造所有者与任意作用域字段', t => {
  const { service } = fixture(t)
  assert.throws(() => service.request('a', 'create', { kind: 'user_preference', topic: '秘密', text: 'password=not-a-real-secret' }), /敏感/)
  assert.throws(() => service.request('a', 'create', { kind: 'user_preference', topic: '跨成员', text: '内容', actor: { isUser: true }, scopeId: 'b' }))
  assert.throws(() => service.list('no-such-member'), /不存在/)
})
