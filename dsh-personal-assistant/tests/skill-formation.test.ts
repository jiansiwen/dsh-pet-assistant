import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { SkillFormation } from '../src/skill-formation.ts'
import { SkillStore } from '../src/skills.ts'

function harness(overrides: { autoForm?: boolean; autoActivate?: boolean; scopeChanged?: boolean; synth?: (() => Promise<{ body: string; scopeChanged: boolean } | null>) } = {}) {
  const db = new DatabaseSync(':memory:')
  const skills = new SkillStore(db)
  let calls = 0
  const formation = new SkillFormation({
    skills,
    autoForm: () => overrides.autoForm ?? true,
    autoActivate: () => overrides.autoActivate ?? true,
    samples: () => [1, 2, 3].map(updatedAt => ({ goal: '写周报', acceptance: '本人确认', artifacts: '[]', updatedAt })),
    synthesize: async () => { calls++; return overrides.synth ? overrides.synth() : { body: '步骤一…步骤二…', scopeChanged: overrides.scopeChanged ?? false } },
    threshold: 3,
  })
  return { db, skills, formation, calls: () => calls }
}

test('本人确认样本攒够 3 次自动形成并默认生效', async () => {
  const h = harness()
  h.formation.record('member-a', '写周报', true)
  h.formation.record('member-a', '写周报', true)
  assert.equal(h.calls(), 0, '两次还不够')
  h.formation.record('member-a', '写周报', true)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(h.calls(), 1)
  const list = h.skills.list('member-a')
  assert.equal(list.length, 1)
  assert.equal(list[0].status, 'active')
  assert.equal(list[0].origin, 'auto-verified')
  assert.equal(list[0].name, '写周报')
  h.db.close()
})

test('扩权（scopeChanged）一律停候选，不自动生效', async () => {
  const h = harness({ scopeChanged: true })
  for (let i = 0; i < 3; i++) h.formation.record('member-a', '读新目录', true)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(h.skills.list('member-a')[0].status, 'candidate')
  h.db.close()
})

test('autoActivate=false 时生成后停候选', async () => {
  const h = harness({ autoActivate: false })
  for (let i = 0; i < 3; i++) h.formation.record('member-a', '写周报', true)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(h.skills.list('member-a')[0].status, 'candidate')
  h.db.close()
})

test('autoForm=false 不触发总结', async () => {
  const h = harness({ autoForm: false })
  for (let i = 0; i < 4; i++) h.formation.record('member-a', '写周报', true)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(h.calls(), 0)
  assert.equal(h.skills.list('member-a').length, 0)
  h.db.close()
})

test('已有同名技能不重复形成', async () => {
  const h = harness()
  h.skills.save('member-a', { name: '写周报', body: '旧' }, 'active')
  for (let i = 0; i < 3; i++) h.formation.record('member-a', '写周报', true)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(h.calls(), 0)
  h.db.close()
})

test('成员自报样本只供核查，不能形成技能', async () => {
  const h = harness()
  for (let i = 0; i < 3; i++) h.formation.record('member-b', '整理纪要', false)
  await new Promise(r => setTimeout(r, 20))
  const list = h.skills.list('member-b')
  assert.equal(list.length, 0)
  assert.equal(h.skills.unverifiedCount('member-b', '整理纪要'), 3)
  h.db.close()
})

test('同一个回执只算一次；删除技能清除旧样本，后续不会据同一批证据直接恢复', async () => {
  const h = harness()
  function record(ref: string) {
    h.formation.record('member-a', '写周报', true, { ref,
      sample: { goal: '写周报', acceptance: '本人验收', artifacts: '周报摘要', updatedAt: 1 } })
  }
  record('run-a'); record('run-a'); record('run-b')
  assert.equal(h.calls(), 0)
  assert.equal(h.skills.verifiedSamples('member-a', '写周报').length, 2)
  record('run-c')
  await Promise.resolve()
  const formed = h.skills.list('member-a')[0]!
  assert.equal(formed.status, 'active')
  assert.equal(h.skills.remove(formed.id), 1)
  record('run-d')
  assert.deepEqual(h.skills.list('member-a'), [])
  assert.equal(h.skills.evidenceCount('member-a', '写周报'), 1)
  h.db.close()
})

test('模型没产出正文时不落库', async () => {
  const h = harness({ synth: async () => null })
  for (let i = 0; i < 3; i++) h.formation.record('member-a', '写周报', true)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(h.skills.list('member-a').length, 0)
  h.db.close()
})
