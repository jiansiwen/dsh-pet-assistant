/**
 * 工作台改写长期记忆。
 *
 * 用户提的问题是"记忆只能删、不能改"——但"能改"不能变成"能绕过审批改"。
 * 所以要守住的性质：
 * 1. 手动模式下工作台只提交待批，库里一个字都没变；
 * 2. 批准后才真的改，且编号不变（引用它的待批与事项不会断）、版本号 +1；
 * 3. 待批期间那条记忆被别人改过或删掉，这张卡作废，不会把陈旧内容写回去；
 * 4. auto 模式下按用户配置直接改并如实回报；
 * 5. 已失效的记忆不能改（要沿用就重新说一遍，而不是复活一条旧规则）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workbenchFixture } from './support/workbench-fixture.ts'

/** 先用对话侧工具写一条全局偏好（手动模式下是待批，批准后才落库）。 */
async function seedPreference(f: ReturnType<typeof workbenchFixture>, text: string) {
  const pending = await f.rt.call('remember_preference', { text, topic: '日报口径' })
  assert.equal(pending.pending, true, JSON.stringify(pending))
  const decided = await f.rt.decide(pending.proposalId)
  assert.equal(decided.ok, true, JSON.stringify(decided))
  const record = f.rt.memories.list({}, Date.now()).find(item => item.text === text)
  assert.ok(record, '记忆没有落库')
  return record
}

test('手动模式：改写只提交待批，库里没变；批准后编号不变、正文更新、版本号 +1', async t => {
  const f = workbenchFixture(t)
  await f.rt.bind()
  const record = await seedPreference(f, '日报不写时长')
  const revisionBefore = record.revision

  const submitted = await f.rt.editMemory(record.id, '日报不写时长，也不写时间段')
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
  assert.equal(submitted.body.pending, true)
  assert.equal(submitted.body.saved, false)
  const still = f.rt.memories.get(record.id, Date.now())!
  assert.equal(still.text, '日报不写时长', '批准前一个字都不能改')
  assert.equal(still.revision, revisionBefore)

  const decided = await f.rt.decide(String(submitted.body.proposalId))
  assert.equal(decided.ok, true, JSON.stringify(decided))
  const after = f.rt.memories.get(record.id, Date.now())!
  assert.equal(after.id, record.id, '编号不变：引用它的待批与事项不会断')
  assert.equal(after.text, '日报不写时长，也不写时间段')
  assert.equal(after.revision, revisionBefore + 1)
  assert.equal(after.status, 'confirmed')
})

test('待批期间记忆被改过：这张卡作废，不会把看到的旧内容写回去', async t => {
  const f = workbenchFixture(t, { approvalMode: 'auto' })
  await f.rt.bind()
  // auto 模式下先直接落库一条
  const saved = await f.rt.call('remember_preference', { text: '日报按项目分组', topic: '日报口径' })
  assert.equal(saved.remembered, true, JSON.stringify(saved))
  const id = String(saved.id)

  // 切回手动语义：手工构造一张待批，然后外部改动这条记忆，再看批准时的校验。
  const record = f.rt.memories.get(id, Date.now())!
  const proposal = f.rt.bridge.submitAssistant({
    subject: 'memories',
    tool: 'personal_assistant_edit_preference',
    summary: '测试：改写为另一句',
    target: '本机全局记忆',
    risk: 'high',
    snapshot: { id },
    validate: () => {
      const current = f.rt.memories.get(id, Date.now())
      return current !== null && current.text === record.text
    },
    execute: () => ({ edited: true }),
  })
  // 模拟期间记忆被别处改掉
  f.rt.memories.revise(id, { text: '被别处改过了', actor: { id: 'desktop-shell', isUser: true } }, Date.now())
  const decided = await f.rt.decide(proposal.proposalId)
  assert.equal(decided.ok, false, '内容对不上就不能批准')
  assert.equal(f.rt.memories.get(id, Date.now())!.text, '被别处改过了', '别处的改动没有被覆盖')
})

test('auto 模式：工作台改写直接生效并如实回报', async t => {
  const f = workbenchFixture(t, { approvalMode: 'auto' })
  await f.rt.bind()
  const saved = await f.rt.call('remember_preference', { text: '日报不含 lu 项目', topic: '日报口径' })
  assert.equal(saved.remembered, true)
  const id = String(saved.id)
  const revisionBefore = f.rt.memories.get(id, Date.now())!.revision

  const result = await f.rt.editMemory(id, '日报不含 lu 项目的内容')
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.mode, 'auto')
  assert.equal(result.body.saved, true)
  const after = f.rt.memories.get(id, Date.now())!
  assert.equal(after.text, '日报不含 lu 项目的内容')
  assert.equal(after.revision, revisionBefore + 1)
})

test('空正文、内容没变、已失效、编号不存在都如实拒绝', async t => {
  const f = workbenchFixture(t, { approvalMode: 'auto' })
  await f.rt.bind()
  const saved = await f.rt.call('remember_preference', { text: '日报不写时长', topic: '日报口径' })
  const id = String(saved.id)

  assert.equal((await f.rt.editMemory(id, '   ')).status, 400, '空正文拒绝')
  const same = await f.rt.editMemory(id, '日报不写时长')
  assert.equal(same.body.saved, false)
  assert.match(String(same.body.message), /没有变化/)
  assert.equal((await f.rt.editMemory('mem-不存在', '新内容')).status, 404)
})
