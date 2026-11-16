/**
 * 技能存储的钉子用例。
 *
 * 钉的是产品要求里那三条硬约束，不是表结构：
 *
 * 1. **归属单个助理**：A 的技能绝不进 B 的注入，也绝不进总助理的（总助理没有助理 id）；
 * 2. **版本化 + 可回滚**：回滚是"切成新的一版"，不是把旧版本号改回去；
 * 3. **只有 active 才注入**：候选和退役的技能不该影响任何一次回答。
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { SkillStore } from '../src/skills.ts'

function store(): SkillStore {
  return new SkillStore(new DatabaseSync(':memory:'))
}

void test('技能：写入后成为 active，只有归属者能拿到注入', () => {
  const skills = store()
  skills.save('member-a', { name: '写周报', body: '先列结论，再列数据；表格不超过三列。' }, 'active')
  assert.match(skills.renderFor('member-a'), /先列结论/u)
  assert.equal(skills.renderFor('member-b'), '', '别的助理不该看到这条技能')
})

void test('技能：多次写入产生递增版本，注入只取最高版本', () => {
  const skills = store()
  skills.save('member-a', { name: '写周报', body: '第一版做法' }, 'active')
  skills.save('member-a', { name: '写周报', body: '第二版做法' }, 'active')
  const rendered = skills.renderFor('member-a')
  assert.match(rendered, /第二版做法/u)
  assert.doesNotMatch(rendered, /第一版做法/u, '旧版本不该同时注入')
  assert.equal(skills.history('member-a:写周报').length, 2)
})

void test('技能：候选不注入，晋升后才生效', () => {
  const skills = store()
  skills.save('member-a', { name: '定会议室', body: '优先三楼小会议室，其次二楼。' }, 'candidate')
  assert.equal(skills.renderFor('member-a'), '', '候选不该影响回答')
  skills.save('member-a', { name: '定会议室', body: '优先三楼小会议室，其次二楼。' }, 'active')
  assert.match(skills.renderFor('member-a'), /三楼小会议室/u)
})

void test('技能：回滚是切成新的一版，历史仍可追溯', () => {
  const skills = store()
  skills.save('member-a', { name: '写文档', body: '第一版：双栏' }, 'active')
  skills.save('member-a', { name: '写文档', body: '第二版：单栏（变差了）' }, 'active')
  const rolled = skills.rollback('member-a:写文档', 1)
  assert.equal(rolled.version, 3, '回滚应产生第 3 版，而不是把版本号改回 1')
  assert.equal(rolled.body, '第一版：双栏', '内容回到目标版本')
  assert.equal(skills.history('member-a:写文档').length, 3, '历史一条都不丢')
  assert.match(skills.renderFor('member-a'), /第一版：双栏/u, '回滚后注入的是回滚后的内容')
})

void test('技能：退役后不再注入', () => {
  const skills = store()
  skills.save('member-a', { name: '写周报', body: '老做法' }, 'active')
  skills.save('member-a', { name: '写周报', body: '停用' }, 'retired')
  assert.equal(skills.renderFor('member-a'), '')
})

void test('技能：名称与正文不能为空，必须归属助理', () => {
  const skills = store()
  assert.throws(() => skills.save('', { name: 'x', body: 'y' }, 'active'), /归属/u)
  assert.throws(() => skills.save('member-a', { name: ' ', body: 'y' }, 'active'), /名称/u)
  assert.throws(() => skills.save('member-a', { name: 'x', body: '  ' }, 'active'), /正文/u)
})

void test('技能：list 能看到所有助理的最新版（界面用）', () => {
  const skills = store()
  skills.save('member-a', { name: '写周报', body: 'a' }, 'active')
  skills.save('member-b', { name: '定会议室', body: 'b' }, 'candidate')
  const all = skills.list()
  assert.equal(all.length, 2)
  assert.deepEqual(all.map(item => item.assistantId).sort(), ['member-a', 'member-b'])
  assert.equal(skills.list('member-a').length, 1)
})

void test('技能成形：同类可信成功满三次才提示', () => {
  const skills = store()
  assert.deepEqual(skills.pendingShapes('member-a'), [], '一次都没有时不该提示')
  skills.noteSuccess('member-a', '写周报', true)
  skills.noteSuccess('member-a', '写周报', true)
  assert.deepEqual(skills.pendingShapes('member-a'), [], '两次还不够')
  assert.equal(skills.noteSuccess('member-a', '写周报', true), 3)
  const pending = skills.pendingShapes('member-a')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].shape, '写周报')
  assert.equal(pending[0].count, 3)
})

void test('技能成形：不同类的工作分开计数，不会互相凑数', () => {
  const skills = store()
  skills.noteSuccess('member-a', '写周报', true)
  skills.noteSuccess('member-a', '定会议室', true)
  skills.noteSuccess('member-a', '写文档', true)
  assert.deepEqual(skills.pendingShapes('member-a'), [], '三条不相干的事不能凑成一个技能')
  assert.equal(skills.evidenceCount('member-a', '写周报'), 1)
})

void test('技能成形：已经有同名技能后不再重复提示', () => {
  const skills = store()
  for (let index = 0; index < 3; index += 1) skills.noteSuccess('member-a', '写周报', true)
  assert.equal(skills.pendingShapes('member-a').length, 1)
  skills.save('member-a', { name: '写周报', body: '已成形' }, 'candidate')
  assert.deepEqual(skills.pendingShapes('member-a'), [], '成形之后不该再提示同一件事')
})

void test('技能成形：证据按助理隔离', () => {
  const skills = store()
  for (let index = 0; index < 3; index += 1) skills.noteSuccess('member-a', '写周报', true)
  assert.deepEqual(skills.pendingShapes('member-b'), [], 'A 干的活不能算成 B 的经验')
})

/*
 * 这一组钉的是"自报不算数"。
 *
 * 技能一旦从自报样本长出来，学到的就是"怎么说明自己做完了"。
 * 所以哪怕记了三条未核实样本，也不能提示成形；只有本人在桌面确认过才算。
 */
void test('技能成形：未核实的样本不参与判定', () => {
  const skills = store()
  for (let index = 0; index < 5; index += 1) skills.noteSuccess('member-a', '写周报', false)
  assert.equal(skills.evidenceCount('member-a', '写周报'), 0, '已核实计数应为 0')
  assert.equal(skills.unverifiedCount('member-a', '写周报'), 5, '未核实的有 5 条，要能如实显示')
  assert.deepEqual(skills.pendingShapes('member-a'), [], '五条自报也不能当成经验')
})

void test('技能成形：本人确认之后才开始计数', () => {
  const skills = store()
  for (let index = 0; index < 3; index += 1) skills.noteSuccess('member-a', '定会议室', false)
  assert.deepEqual(skills.pendingShapes('member-a'), [])
  assert.equal(skills.verifyAll('member-a', '定会议室'), 3, '确认后已核实计数应为 3')
  assert.equal(skills.unverifiedCount('member-a', '定会议室'), 0)
  assert.equal(skills.pendingShapes('member-a').length, 1)
})

void test('技能成形：记错的样本可以撤回', () => {
  const skills = store()
  for (let index = 0; index < 3; index += 1) skills.noteSuccess('member-a', '写周报', true)
  assert.equal(skills.retract('member-a', '写周报'), 3)
  assert.equal(skills.evidenceCount('member-a', '写周报'), 0)
  assert.deepEqual(skills.pendingShapes('member-a'), [])
})
