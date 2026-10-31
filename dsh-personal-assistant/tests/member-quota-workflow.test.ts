import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TeamStore } from '../src/team-domain.ts'
import type { MemberDraft } from '../src/member-contract.ts'
const draft: MemberDraft = { displayName: '额度验收成员', description: '分析给定文本', persona: '', skinId: 'panda', enabled: true, provider: '', model: '',
  maxTokens: 40, capabilities: [], allowedTools: [], dailyTokenLimit: 100, totalTokenLimit: 200, thresholdPercent: 80, timezone: 'Asia/Shanghai' }

test('达到阈值先申请、额度耗尽阻止下一请求、可信批准重置后才可继续', t => {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  const directory = store.directory
  const member = directory.create(draft)
  const id = member.assistantId
  directory.beginUsage(id, 'first')
  directory.finishUsage('first', 85)
  assert.equal(directory.quota(id).dailyUsed, 85)
  assert.equal(directory.quota(id).blocked, false)
  const request = directory.requests().find(item => item.state === 'pending')!
  assert.ok(request)
  assert.equal(directory.beginUsage(id, 'second').maxTokens, 15)
  directory.finishUsage('second', 20)
  assert.throws(() => directory.beginUsage(id, 'third'), /额度/)
  assert.equal(directory.requests().filter(item => item.state === 'pending').length, 1)
  assert.throws(() => directory.decideRequest(request.requestId, 'approve', request.quotaRevision), /空操作/)
  directory.decideRequest(request.requestId, 'approve', request.quotaRevision, { reset: 'daily' })
  assert.equal(directory.quota(id).dailyUsed, 0)
  assert.equal(directory.quota(id).totalUsed, 105)
  assert.doesNotThrow(() => directory.beginUsage(id, 'fourth'))
  directory.finishUsage('fourth', 100)
  assert.equal(directory.quota(id).blocked, true)
  assert.throws(() => directory.beginUsage(id, 'fifth'), /额度/)
})

test('在途预留也计入阈值，不必等结算才申请', t => {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  const directory = store.directory
  const member = directory.create({ ...draft, dailyTokenLimit: 1000, totalTokenLimit: 0, thresholdPercent: 80, maxTokens: 1000 })
  assert.equal(directory.requests().length, 0)
  assert.equal(directory.beginUsage(member.assistantId, 'reserve-all').maxTokens, 1000)
  const quota = directory.quota(member.assistantId)
  assert.equal(quota.dailyUsed, 0, '还没有结算')
  assert.equal(quota.dailyReserved, 1000)
  assert.equal(directory.requests().filter(item => item.state === 'pending').length, 1, '预留已占满阈值就应先申请')
})

test('半套模型配置拒绝，关闭日限额仍受总限额约束', t => {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  assert.throws(() => store.directory.create({ ...draft, provider: 'only-provider' }), /同时/)
  const member = store.directory.create({ ...draft, dailyTokenLimit: 0, totalTokenLimit: 10 })
  assert.equal(store.directory.beginUsage(member.assistantId, 'bounded').maxTokens, 10)
  store.directory.finishUsage('bounded', 30)
  assert.equal(store.directory.quota(member.assistantId).blocked, true)
})
