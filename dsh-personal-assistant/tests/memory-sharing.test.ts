/**
 * 记忆共享投影的钉子用例。
 *
 * 语义只有一条：**共享是投影，不是复制。**
 * 总助理标记一条全局记忆为「可共享」之后，子助理下一轮能看到它；
 * 取消共享、改判冲突、删除、到期，子助理下一轮立刻看不到。
 * 如果实现成"复制进子助理的库"，上面四种情况全都删不掉，就是删不掉的记忆。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { MemoryStore } from '../src/memory.ts'
import { MemberMemory } from '../src/member-memory.ts'
import { TeamStore } from '../src/team-domain.ts'

function store(t: TestContext): { memories: MemoryStore; member: MemberMemory; memberId: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-memory-sharing-'))
  const team = new TeamStore(path.join(dir, 'team.sqlite'))
  t.after(() => { team.close(); rmSync(dir, { recursive: true, force: true }) })
  const memories = new MemoryStore(team.db)
  const created = team.directory.create({
    displayName: '文档助理', description: '', personality: '', persona: '', skinId: 'panda', enabled: true,
    provider: '', model: '', maxTokens: 16384, capabilities: [], allowedTools: [],
    dailyTokenLimit: 0, totalTokenLimit: 0, thresholdPercent: 80, timezone: 'Asia/Shanghai',
  } as never)
  const member = new MemberMemory({
    store: memories, ownerId: 'owner',
    exists: id => team.directory.get(id) !== null,
    invalidate: id => team.directory.setSession(id, null),
  })
  return { memories, member, memberId: created.assistantId }
}

/** 写一条已确认的全局记忆（模拟总助理记下的老板偏好）。 */
function confirmGlobal(memories: MemoryStore, text: string): string {
  const put = memories.put({
    kind: 'user_preference', topic: '汇报口径', text,
    scopeKind: 'global', scopeId: '', sourceRefs: [], actor: { id: 'owner', isUser: true },
  }, Date.now())
  assert.ok(put.ok, '前置条件：记忆写入应成功')
  const confirmed = memories.confirm(put.record.id, { id: 'owner', isUser: true }, Date.now(), { [put.record.id]: put.record.revision })
  assert.ok(confirmed, '前置条件：记忆确认应成功')
  return put.record.id
}

void test('共享：默认不共享，标记后才进子助理的投影', (t) => {
  const { memories, member } = store(t)
  const id = confirmGlobal(memories, '汇报要简单明了，不要长篇大论')

  assert.equal(memories.isShared(id), false, '刚写下的记忆默认不共享')
  assert.equal(memories.sharedGlobals().length, 0)
  assert.match(member.shared(), /没有共享/u, '没共享时要明说没有，不能给空串')

  assert.deepEqual(memories.setShared(id, true), { shared: true })
  const projection = member.shared()
  assert.match(projection, /汇报要简单明了/u)
  assert.match(projection, /只读/u, '要明确告诉子助理这是只读的')
  assert.match(projection, /不是授权/u)
})

void test('共享：取消之后子助理立刻看不见（投影不是复制）', (t) => {
  const { memories, member } = store(t)
  const id = confirmGlobal(memories, '喜欢在上午十点开会')
  memories.setShared(id, true)
  assert.match(member.shared(), /上午十点/u)

  memories.setShared(id, false)
  assert.doesNotMatch(member.shared(), /上午十点/u, '取消共享后不能再出现在投影里')
})

void test('共享：记忆删除后投影跟着空（不留下副本）', (t) => {
  const { memories, member } = store(t)
  const id = confirmGlobal(memories, '文档要双栏排版')
  memories.setShared(id, true)
  assert.match(member.shared(), /双栏/u)

  memories.delete(id, '本人删除', Date.now())
  assert.doesNotMatch(member.shared(), /双栏/u, '记忆删了投影必须跟着空')
})

void test('共享：候选记忆与非全局记忆都不能共享', (t) => {
  const { memories, member, memberId } = store(t)
  // 候选（由模型/成员提出，本人尚未确认）：isUser=false 落成候选
  const draft = memories.put({ kind: 'user_preference', topic: '临时', text: '这条还没确认', scopeKind: 'global', scopeId: '', sourceRefs: [], actor: { id: 'member-x', isUser: false } }, Date.now())
  assert.ok(draft.ok)
  assert.equal(memories.get(draft.record.id, Date.now())?.status, 'candidate', '前置条件：这条应是候选')
  assert.equal(memories.setShared(draft.record.id, true), null, '候选不能共享')
  assert.match(member.shared(), /没有共享/u)

  // 角色范围（子助理自己的记忆）不能共享
  const rolePut = memories.put({ kind: 'user_preference', topic: '自己的', text: '子助理自己的偏好', scopeKind: 'role', scopeId: memberId, sourceRefs: [], actor: { id: 'owner', isUser: true } }, Date.now())
  assert.ok(rolePut.ok)
  memories.confirm(rolePut.record.id, { id: 'owner', isUser: true }, Date.now(), { [rolePut.record.id]: rolePut.record.revision })
  assert.equal(memories.setShared(rolePut.record.id, true), null, '只有全局记忆能共享')
})

void test('共享：子助理自己的记忆与共享记忆是两段，来源分开标注', (t) => {
  const { memories, member, memberId } = store(t)
  const sharedId = confirmGlobal(memories, '老板喜欢先看结论')
  memories.setShared(sharedId, true)

  const own = memories.put({ kind: 'user_preference', topic: '字体', text: '正文用等线', scopeKind: 'role', scopeId: memberId, sourceRefs: [], actor: { id: memberId, isUser: false } }, Date.now())
  assert.ok(own.ok)
  memories.confirm(own.record.id, { id: 'owner', isUser: true }, Date.now(), { [own.record.id]: own.record.revision })

  const ownText = member.injectable(memberId)
  const sharedText = member.shared()
  assert.match(ownText, /等线/u)
  assert.doesNotMatch(ownText, /先看结论/u, '自己的记忆段里不该混进总助理的')
  assert.match(sharedText, /先看结论/u)
  assert.doesNotMatch(sharedText, /等线/u, '共享段里不该混进子助理自己的')
})
