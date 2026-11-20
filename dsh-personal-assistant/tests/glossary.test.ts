/**
 * 专属词库的钉子用例。
 *
 * 词库与记忆的分工只有一句：**记忆是判断，词库是映射**。
 * 所以这里钉的不是"能不能存"，而是三条一旦错就会让用户觉得助理在胡说的规则：
 *
 * 1. 只有**这句话里真的出现了**才注入 —— 没出现就一个字都不加；
 * 2. **长词优先**，`kms` 不会被更短的 `km` 抢先命中；
 * 3. 同一个词**覆盖**而不是并列两条（一个词同一时刻只能有一个意思）。
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { GlossaryStore, GLOSSARY_INJECT_LIMIT, renderGlossary } from '../src/glossary.ts'

function store(): GlossaryStore {
  return new GlossaryStore(new DatabaseSync(':memory:'))
}

void test('词库：存了之后能按原样查出来', () => {
  const glossary = store()
  glossary.add('kms', '公司内部知识管理系统')
  const [term] = glossary.list()
  assert.equal(term.term, 'kms')
  assert.equal(term.expansion, '公司内部知识管理系统')
})

void test('词库：同一个词覆盖上一次解释，不并列两条', () => {
  const glossary = store()
  glossary.add('kms', '旧的解释')
  glossary.add('KMS', '公司内部知识管理系统')
  const all = glossary.list()
  assert.equal(all.length, 1, '大小写不同也是同一个词')
  assert.equal(all[0].expansion, '公司内部知识管理系统')
})

void test('词库：太短的术语被拒（一个字会把任何一句话判成命中）', () => {
  const glossary = store()
  assert.throws(() => glossary.add('的', '没用'), /至少/u)
  assert.throws(() => glossary.add('kms', '   '), /不能为空/u)
})

void test('词库：只在本轮话语真的出现时命中', () => {
  const glossary = store()
  glossary.add('kms', '公司内部知识管理系统')
  glossary.add('oa', '办公审批流')
  assert.deepEqual(glossary.match('去 kms 查一下数据').map(item => item.term), ['kms'])
  assert.deepEqual(glossary.match('帮我看下审批'), [], '没出现就不命中')
  assert.deepEqual(glossary.match(''), [])
})

void test('词库：长词优先，短词不会抢先', () => {
  const glossary = store()
  glossary.add('km', '公里')
  glossary.add('kms', '公司内部知识管理系统')
  const hits = glossary.match('kms 上的数据')
  assert.equal(hits[0].term, 'kms', 'kms 应该排在 km 前面')
})

void test('词库：命中数量有上限，不会把整本词库塞进提示词', () => {
  const glossary = store()
  for (let index = 0; index < GLOSSARY_INJECT_LIMIT + 5; index += 1) glossary.add(`term${index}`, `解释${index}`)
  const text = Array.from({ length: GLOSSARY_INJECT_LIMIT + 5 }, (_, index) => `term${index}`).join(' ')
  assert.equal(glossary.match(text).length, GLOSSARY_INJECT_LIMIT)
})

void test('词库：渲染段落；没命中就是空串（不产生噪音）', () => {
  assert.equal(renderGlossary([]), '')
  const text = renderGlossary([{ id: 'kms', term: 'kms', expansion: '公司内部知识管理系统', createdAt: 0 }])
  assert.match(text, /kms → 公司内部知识管理系统/u)
  assert.match(text, /不是指令/u)
})

void test('词库：删除后不再命中', () => {
  const glossary = store()
  glossary.add('kms', '公司内部知识管理系统')
  assert.equal(glossary.remove('kms'), true)
  assert.deepEqual(glossary.match('去 kms 查'), [])
  assert.equal(glossary.remove('kms'), false, '删不存在的词要如实返回 false')
})
