import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { TeamStore } from '../src/team-domain.ts'
import { MemberManagement } from '../src/member-management.ts'
import { MemoryStore } from '../src/memory.ts'
import { MemberMemory } from '../src/member-memory.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'
import { ApprovalService } from '../src/approval.ts'
import type { MemberRuntime } from '../src/member-runtime.ts'
const draft = { displayName: '测试专员', description: '分析用户给出的文本', persona: '简短准确', skinId: 'panda', enabled: true,
  provider: '', model: '', maxTokens: 1024, capabilities: [], allowedTools: [], dailyTokenLimit: 5000, totalTokenLimit: 20000, thresholdPercent: 80, timezone: 'Asia/Shanghai' }

test('成员设置关闭团队时仍可管理；记忆及权限只接受可信所有者', async t => {
  const store = new TeamStore(':memory:')
  const db = new DatabaseSync(':memory:')
  const memory = new MemberMemory({ store: new MemoryStore(db), ownerId: 'owner', exists: id => !!store.directory.get(id), invalidate: id => store.directory.setSession(id, null) })
  let enabled = false, busy = false
  const service = new MemberManagement({ directory: store.directory, runtime: { busy: () => busy } as unknown as MemberRuntime, memories: memory,
    enabled: () => enabled, setMode: async value => { enabled = value }, defaultModel: () => null, changed: () => {} })
  const runtime = new CompanionTaskRuntime(store, new ApprovalService(store, { ttlMs: 60000, runtimeEpoch: 'test' }), { epoch: 'test' })
  runtime.attachMemberManagement(service)
  t.after(async () => { await runtime.dispose(); store.close(); db.close() })
  for (const subject of ['client', 'executor'] as const) {
    assert.equal((await runtime.request('GET', '/companion/v1/members', null, subject)).status, 403)
    assert.equal((await runtime.request('POST', '/companion/v1/members', draft, subject)).status, 403)
  }
  const created = await runtime.request('POST', '/companion/v1/members', draft, 'owner')
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const id = store.directory.list()[0].assistantId
  assert.equal(enabled, false)
  assert.equal((await service.request('POST', `/companion/v1/members/${id}/memories`, { kind: 'user_preference', topic: '表达', text: '结论先行' })).status, 200)
  assert.equal((await service.request('GET', `/companion/v1/members/${id}/memories`, null)).status, 200)
  busy = true
  assert.equal((await service.request('POST', `/companion/v1/members/${id}/update`, { ...draft, expectedRevision: 1 })).status, 409)
  assert.equal((await service.request('POST', '/companion/v1/members/mode', { enabled: true })).status, 409)
  busy = false
  assert.equal((await service.request('POST', '/companion/v1/members/mode', { enabled: true })).status, 200)
  assert.equal(enabled, true)
  assert.equal((await service.request('POST', '/companion/v1/members', { ...draft, displayName: '不合法权限', allowedTools: ['bash'] })).status, 409)
})

test('删除成员拒绝忙碌与未结束任务，成功后从目录消失', async t => {
  const store = new TeamStore(':memory:')
  const db = new DatabaseSync(':memory:')
  const memory = new MemberMemory({ store: new MemoryStore(db), ownerId: 'owner', exists: id => !!store.directory.get(id), invalidate: id => store.directory.setSession(id, null) })
  let busy = false, active = 0
  const service = new MemberManagement({ directory: store.directory, runtime: { busy: () => busy } as unknown as MemberRuntime, memories: memory,
    enabled: () => false, setMode: async () => {}, defaultModel: () => null, changed: () => {}, activeTasks: () => active })
  t.after(() => { store.close(); db.close() })
  assert.equal((await service.request('POST', '/companion/v1/members', draft)).status, 200)
  const id = store.directory.list()[0]!.assistantId
  const expectedRevision = store.directory.get(id)!.revision
  busy = true
  assert.equal((await service.request('POST', `/companion/v1/members/${id}/delete`, { expectedRevision })).status, 409)
  busy = false
  active = 1
  assert.equal((await service.request('POST', `/companion/v1/members/${id}/delete`, { expectedRevision })).status, 409)
  active = 0
  assert.equal((await service.request('POST', `/companion/v1/members/${id}/memories`, { kind: 'user_preference', topic: '删除测试', text: '随成员清除' })).status, 200)
  assert.equal((await service.request('POST', `/companion/v1/members/${id}/delete`, { expectedRevision, extra: 'x' })).status, 422)
  assert.equal((await service.request('POST', `/companion/v1/members/${id}/delete`, { expectedRevision, purgeMemory: true })).status, 200)
  assert.equal(store.directory.get(id), null)
  assert.equal(store.directory.list().length, 0)
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM memories WHERE scope_kind = ? AND scope_id = ?').get('role', id) as { n: number }).n), 0)
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM deletion_ledger').get() as { n: number }).n), 1)
  assert.equal((await service.request('POST', `/companion/v1/members/${id}/delete`, { expectedRevision })).status, 409)
})
