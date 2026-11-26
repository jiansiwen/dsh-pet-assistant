import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { TeamStore } from '../src/team-domain.ts'
import { MemberManagement } from '../src/member-management.ts'
import { isShareableMemory, MemoryStore } from '../src/memory.ts'
import { MemberMemory } from '../src/member-memory.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'
import { ApprovalService } from '../src/approval.ts'
import type { MemberRuntime } from '../src/member-runtime.ts'
const draft = { displayName: '测试专员', description: '分析用户给出的文本', persona: '简短准确', skinId: 'panda', enabled: true,
  provider: '', model: '', maxTokens: 1024, capabilities: [], allowedTools: [], dailyTokenLimit: 5000, totalTokenLimit: 20000, thresholdPercent: 80, timezone: 'Asia/Shanghai' }

test('待核查邮件通知进入成员快照；通知查询失败不阻塞成员管理', t => {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  const issue = { analysisId: '00000000-0000-4000-8000-000000000001', memberId: 'member',
    attemptId: '00000000-0000-4000-8000-000000000002', state: 'unknown' as const, preview: '隔离摘要' }
  let broken = false
  const service = new MemberManagement({ directory: store.directory, runtime: { busy: () => false } as unknown as MemberRuntime,
    memories: {} as never, enabled: () => false, setMode: async () => {}, defaultModel: () => null, changed: () => {},
    mailNoticeAttention: () => { if (broken) throw new Error('模拟通知库异常'); return [issue] } })
  assert.deepEqual(service.snapshot().mailNoticeAttention, [issue])
  broken = true
  const degraded = service.snapshot()
  assert.equal(degraded.mailNoticeAttentionError, true)
  assert.deepEqual(degraded.members, [], '通知侧失败不能挡住成员列表')
})

test('待核查邮件发送进入成员快照；发送账本查询失败不阻塞成员管理', t => {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  const issue = { intentId: '00000000-0000-4000-8000-000000000003', subject: '隔离纪要', recipients: ['a@example.com'],
    state: 'unknown' as const, accepted: [], rejected: [], messageId: null }
  let broken = false
  const service = new MemberManagement({ directory: store.directory, runtime: { busy: () => false } as unknown as MemberRuntime,
    memories: {} as never, enabled: () => false, setMode: async () => {}, defaultModel: () => null, changed: () => {},
    mailSendAttention: () => { if (broken) throw new Error('模拟发送账本异常'); return [issue] } })
  assert.deepEqual(service.snapshot().mailSendAttention, [issue])
  broken = true
  const degraded = service.snapshot()
  assert.equal(degraded.mailSendAttentionError, true)
  assert.deepEqual(degraded.members, [])
})

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

test('一键切换只更新角色字段，保留主会话、渠道会话、职责、权限和额度', async t => {
  const store = new TeamStore(':memory:')
  const service = new MemberManagement({ directory: store.directory,
    runtime: { busy: () => true } as unknown as MemberRuntime, memories: {} as never,
    enabled: () => true, setMode: async () => {}, defaultModel: () => null, changed: () => {} })
  const runtime = new CompanionTaskRuntime(store, new ApprovalService(store, { ttlMs: 60000, runtimeEpoch: 'test' }), { epoch: 'test' })
  runtime.attachMemberManagement(service)
  t.after(async () => { await runtime.dispose(); store.close() })
  const created = await runtime.request('POST', '/companion/v1/members', {
    ...draft, permissionMode: 'auto', capabilities: ['activity'], personality: '稳重简洁',
  }, 'owner')
  const id = (created.body as { createdAssistantId: string }).createdAssistantId
  assert.ok(id, '新成员回执应给出精确目标，不按名字猜')
  store.directory.setSession(id, '原主会话')
  store.directory.setChannelSession(id, 'c'.repeat(64), '原渠道会话')
  const previous = store.directory.get(id)!
  const quota = store.directory.quota(id)
  const endpoint = `/companion/v1/members/${id}/role-style`
  const role = { personality: '活泼，先打招呼', skinId: 'custom-role-qa', voiceProfile: '茉莉', voiceDesign: '' }
  const input = { ...role, expectedRevision: previous.revision }
  assert.equal((await runtime.request('POST', endpoint, input, 'client')).status, 403)
  assert.equal((await runtime.request('POST', endpoint, { ...input, permissionMode: 'full' }, 'owner')).status, 422)
  assert.equal((await runtime.request('POST', endpoint, { ...input, expectedRevision: 800 }, 'owner')).status, 409)
  assert.equal((await runtime.request('POST', endpoint, { ...input, skinId: '../shape' }, 'owner')).status, 422)
  assert.deepEqual(store.directory.get(id), previous)
  assert.equal((await runtime.request('POST', endpoint, input, 'owner')).status, 200)
  assert.deepEqual(store.directory.get(id), { ...previous, ...role, revision: previous.revision + 1 })
  assert.deepEqual(store.directory.quota(id), quota)
  assert.equal(store.directory.getChannelSession(id, 'c'.repeat(64)), '原渠道会话')
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

test('记忆范围只接受桌面所有者按当前版本切换，切回私密后不再进入成员投影', async t => {
  const store = new TeamStore(':memory:')
  const memories = new MemoryStore(store.db)
  const actor = { id: 'owner', isUser: true }
  const saved = memories.put({ kind: 'team_experience', scopeKind: 'global', topic: '周报', text: '先列结论', visibility: 'private', actor }, Date.now())
  assert.ok(saved.ok)
  const { id, revision } = saved.record
  const memberMemories = new MemberMemory({ store: memories, ownerId: 'owner', exists: () => false, invalidate: () => assert.fail('切换范围不应更换会话') })
  const service = new MemberManagement({ directory: store.directory, runtime: { busy: () => false } as unknown as MemberRuntime, memories: memberMemories,
    enabled: () => true, setMode: async () => {}, defaultModel: () => null, changed: () => {},
    sharedMemories: () => memories.list({}, Date.now()).filter(isShareableMemory)
      .map(record => ({ id: record.id, topic: record.topic, text: record.text, revision: record.revision, shared: memories.isShared(record.id) })),
    toggleShared: (memoryId, shared, expectedRevision) => memories.setShared(memoryId, shared, Date.now(), expectedRevision),
  })
  const runtime = new CompanionTaskRuntime(store, new ApprovalService(store, { ttlMs: 60000, runtimeEpoch: 'test' }), { epoch: 'test' })
  runtime.attachMemberManagement(service)
  t.after(async () => { await runtime.dispose(); store.close() })
  const route = '/companion/v1/memories/shared'
  const input = { memoryId: id, shared: true, expectedRevision: revision }
  assert.equal((await runtime.request('GET', route, null, 'client')).status, 403)
  assert.equal((await runtime.request('POST', route, input, 'executor')).status, 403)
  assert.equal((await runtime.request('POST', route, { memoryId: id, shared: true }, 'owner')).status, 422)
  assert.doesNotMatch(memberMemories.shared(), /先列结论/u)

  assert.equal((await runtime.request('POST', route, input, 'owner')).status, 200)
  assert.match(memberMemories.shared(), /先列结论/u)
  assert.equal((await runtime.request('POST', route, { ...input, shared: false }, 'owner')).status, 409)
  assert.equal((await runtime.request('POST', route, { ...input, shared: false, expectedRevision: revision + 1 }, 'owner')).status, 200)
  assert.doesNotMatch(memberMemories.shared(), /先列结论/u)
  assert.equal(memories.get(id, Date.now())?.text, '先列结论')
  assert.equal(memories.get(id, Date.now())?.revision, revision + 2)
})

test('平台签名凭据：app_secret 只入加密存储，换应用 ID 必须重填', async t => {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  const saved: Array<{ id?: string; apiKey: string }> = []
  const removed: string[] = []
  const service = new MemberManagement({ directory: store.directory, runtime: { busy: () => false, listWorkspaces: () => [] } as unknown as MemberRuntime,
    memories: {} as never, enabled: () => true, setMode: async () => {}, defaultModel: () => null, changed: () => {},
    secrets: { save: input => { saved.push(input); return { id: input.id ?? `s-${saved.length}` } }, remove: id => { removed.push(id) } } })
  const platform = { ...draft, displayName: '考拉', capabilities: ['platform'], kind: 'platform',
    binding: { kind: 'platform', endpoint: 'https://aiagent.example.com/api/agentChat/v1', model: '', agentId: '1360', secretId: '', appId: '10001', appSecretId: '' } }
  const created = await service.request('POST', '/companion/v1/members', { ...platform, appSecret: 'only-in-vault' })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const id = (created.body as { createdAssistantId: string }).createdAssistantId
  const profile = store.directory.get(id)!
  assert.equal(profile.binding?.kind, 'platform')
  assert.equal(profile.binding?.appId, '10001')
  assert.equal(profile.binding?.appSecretId, 's-1')
  assert.deepEqual(saved, [{ id: undefined, apiKey: 'only-in-vault' }])
  assert.doesNotMatch(JSON.stringify(created.body), /only-in-vault/)
  // 留空沿用：不传 appSecret 不改密钥条目
  const kept = await service.request('POST', `/companion/v1/members/${id}/update`, { ...platform, binding: { ...platform.binding, appSecretId: 's-1' }, expectedRevision: profile.revision })
  assert.equal(kept.status, 200, JSON.stringify(kept.body))
  assert.equal(store.directory.get(id)?.binding?.appSecretId, 's-1')
  assert.equal(saved.length, 1)
  // 换应用 ID 却没给新密钥：当场拒绝，不用旧密钥静默签错
  const revision = store.directory.get(id)!.revision
  const mismatch = await service.request('POST', `/companion/v1/members/${id}/update`, { ...platform, binding: { ...platform.binding, appId: '20002', appSecretId: 's-1' }, expectedRevision: revision })
  assert.equal(mismatch.status, 409)
  assert.match(String((mismatch.body as { message: string }).message), /应用 ID 已变更/u)
  // 只给密钥不给应用 ID：录入层拒绝
  const noApp = await service.request('POST', '/companion/v1/members', { ...platform, displayName: '缺应用', binding: { ...platform.binding, appId: '' }, appSecret: 'x' })
  assert.equal(noApp.status, 409)
  assert.match(String((noApp.body as { message: string }).message), /应用 ID/u)
  // 删除成员时两条密钥条目都尽力清理
  await service.request('POST', `/companion/v1/members/${id}/delete`, { expectedRevision: store.directory.get(id)!.revision })
  assert.deepEqual(removed.sort(), ['s-1'])
})

test('本机专家的平台凭据：只留标识、换应用必须重填、四项全空不存', async t => {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  const saved: Array<{ id?: string; apiKey: string }> = []
  const service = new MemberManagement({ directory: store.directory, runtime: { busy: () => false, listWorkspaces: () => [] } as unknown as MemberRuntime,
    memories: {} as never, enabled: () => true, setMode: async () => {}, defaultModel: () => null, changed: () => {},
    secrets: { save: input => { saved.push(input); return { id: input.id ?? `s-${saved.length}` } } } })
  const expert = { ...draft, displayName: '考拉本机', capabilities: ['platform'], kind: 'expert',
    platformAuth: { appId: '10001', appSecretId: '', signEndpoint: 'https://sign.example.invalid/realtime', signUserId: '210' },
    appSecret: 'expert-secret' }
  const created = await service.request('POST', '/companion/v1/members', expert)
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const id = (created.body as { createdAssistantId: string }).createdAssistantId
  const profile = store.directory.get(id)!
  assert.equal(profile.kind, 'expert')
  assert.equal(profile.binding, null)
  assert.equal(profile.platformAuth?.appId, '10001')
  assert.equal(profile.platformAuth?.appSecretId, 's-1')
  assert.equal(profile.platformAuth?.signUserId, '210')
  assert.doesNotMatch(JSON.stringify(created.body), /expert-secret/u)
  const kept = await service.request('POST', `/companion/v1/members/${id}/update`, { ...expert, appSecret: undefined,
    platformAuth: { ...expert.platformAuth, appSecretId: 's-1' }, expectedRevision: profile.revision })
  assert.equal(kept.status, 200, JSON.stringify(kept.body))
  assert.equal(store.directory.get(id)?.platformAuth?.appSecretId, 's-1')
  assert.equal(saved.length, 1)
  const revision = store.directory.get(id)!.revision
  const mismatch = await service.request('POST', `/companion/v1/members/${id}/update`, { ...expert, appSecret: undefined,
    platformAuth: { ...expert.platformAuth, appId: '20002', appSecretId: 's-1' }, expectedRevision: revision })
  assert.equal(mismatch.status, 409)
  assert.match(String((mismatch.body as { message: string }).message), /应用 ID 已变更/u)
  const noCapability = await service.request('POST', '/companion/v1/members', { ...expert, displayName: '未勾平台',
    capabilities: [], platformAuth: { ...expert.platformAuth, appSecretId: '' }, appSecret: undefined })
  assert.equal(noCapability.status, 409)
  assert.match(String((noCapability.body as { message: string }).message), /勾选/u)
})
