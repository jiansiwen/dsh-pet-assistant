import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, test } from 'node:test'
import { MemoryStore, type MemoryActor, type MemoryRecord } from '../src/memory.ts'

const USER: MemoryActor = { id: '测试用户', isUser: true }
const EXPERT: MemoryActor = { id: '测试专家', isUser: false }
const NOW = 1_757_000_000_000
let db: DatabaseSync
let memories: MemoryStore

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  memories = new MemoryStore(db)
})

afterEach(() => db.close())

function put(text: string, actor = USER, sourceRefs: string[] = []): MemoryRecord {
  const result = memories.put({ kind: 'user_preference', scopeKind: 'global', topic: '日报口径', text, actor, sourceRefs }, NOW)
  assert.ok(result.ok)
  return result.record
}

function revisions(...records: MemoryRecord[]): Record<string, number> {
  return Object.fromEntries(records.map(record => [record.id, record.revision]))
}

function snapshot() {
  return {
    memories: db.prepare('SELECT * FROM memories ORDER BY memory_id').all(),
    sources: db.prepare('SELECT * FROM memory_sources ORDER BY source_id, derived_id').all(),
    ledger: db.prepare('SELECT * FROM deletion_ledger ORDER BY dedup_key').all(),
  }
}

test('同版本并发改写请求按同步事务串行执行，仅一次生效且原编号保留', async () => {
  const original = put('原文', USER, ['来源一'])
  const stores = [memories, new MemoryStore(db)]
  const results = await Promise.all(stores.map((store, index) => Promise.resolve().then(() =>
    store.revise(original.id, { text: `改写${index}`, actor: USER, expectedRevision: original.revision }, NOW + 1),
  )))
  const accepted = results.filter(record => record !== null)
  assert.equal(accepted.length, 1)
  assert.equal(results.filter(record => record === null).length, 1)
  assert.deepEqual(accepted[0], {
    ...original, text: accepted[0].text, revision: original.revision + 1, updatedAt: NOW + 1,
  })
  assert.deepEqual(memories.get(original.id, NOW + 1), accepted[0])
  assert.equal(memories.count(), 1)
})

test('同版本并发确认仅一次生效，替换集合去重且每个版本只增加一次', async () => {
  const chosen = put('新规则', EXPERT, ['来源一'])
  const first = put('旧规则一')
  const second = put('旧规则二')
  const untouched = put('兼容规则')
  const expected = revisions(chosen, first, second)
  const stores = [memories, new MemoryStore(db)]
  const results = await Promise.all(stores.map(store => Promise.resolve().then(() =>
    store.confirm(chosen.id, USER, NOW + 1, expected, [first.id, second.id, first.id]),
  )))
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(results.filter(record => record === null).length, 1)
  assert.deepEqual(memories.get(chosen.id, NOW + 1), {
    ...chosen, status: 'confirmed', confirmedBy: USER.id, revision: chosen.revision + 1, updatedAt: NOW + 1,
  })
  for (const record of [first, second]) {
    assert.deepEqual(memories.get(record.id, NOW + 1), {
      ...record, status: 'expired', revision: record.revision + 1, updatedAt: NOW + 1,
    })
  }
  assert.deepEqual(memories.get(untouched.id, NOW + 1), untouched)
})

test('正文和主题改回原样仍不能用旧版本改写或确认', () => {
  const original = put('原文', EXPERT)
  const changed = memories.revise(original.id, {
    text: '中间文本', topic: '其他主题', actor: USER, expectedRevision: original.revision,
  }, NOW + 1)
  assert.ok(changed)
  const restored = memories.revise(original.id, {
    text: original.text, topic: original.topic, actor: USER, expectedRevision: changed.revision,
  }, NOW + 2)
  assert.ok(restored)
  assert.equal(restored.id, original.id)
  assert.equal(restored.revision, original.revision + 2)
  assert.equal(restored.text, original.text)
  assert.equal(restored.topic, original.topic)
  const before = snapshot()
  assert.equal(memories.revise(original.id, { text: '过期审批', actor: USER, expectedRevision: original.revision }, NOW + 3), null)
  assert.equal(memories.confirm(original.id, USER, NOW + 3, revisions(original)), null)
  assert.deepEqual(snapshot(), before)
})

for (const changedIndex of [0, 1, 2]) {
  test(`确认集合第${changedIndex + 1}项版本变化时整次拒绝，不能先更新其他项`, () => {
    const chosen = put('新规则', EXPERT)
    const first = put('旧规则一')
    const second = put('旧规则二')
    const expected = revisions(chosen, first, second)
    const changed = [chosen, first, second][changedIndex]
    assert.ok(memories.revise(changed.id, {
      text: changed.text, actor: USER, expectedRevision: changed.revision,
    }, NOW + 1))
    const before = snapshot()
    db.exec(`CREATE TRIGGER 禁止提前更新 BEFORE UPDATE ON memories
      BEGIN SELECT RAISE(ABORT, '版本检查之前不应写入'); END`)
    assert.equal(memories.confirm(chosen.id, USER, NOW + 2, expected, [first.id, second.id]), null)
    assert.deepEqual(snapshot(), before)
  })
}

test('任一替换目标经历改回原文后，原批准版本仍整次拒绝', () => {
  const chosen = put('新规则', EXPERT)
  const rival = put('旧规则')
  const expected = revisions(chosen, rival)
  const changed = memories.revise(rival.id, { text: '中间文本', actor: USER, expectedRevision: rival.revision }, NOW + 1)
  assert.ok(changed)
  assert.ok(memories.revise(rival.id, { text: rival.text, actor: USER, expectedRevision: changed.revision }, NOW + 2))
  const before = snapshot()
  assert.equal(memories.confirm(chosen.id, USER, NOW + 3, expected, [rival.id]), null)
  assert.deepEqual(snapshot(), before)
})

for (const deletedIndex of [0, 1, 2]) {
  test(`确认集合第${deletedIndex + 1}项已删除时整次拒绝，改写不复活已删除项`, () => {
    const chosen = put('新规则', EXPERT)
    const first = put('旧规则一')
    const second = put('旧规则二')
    const expected = revisions(chosen, first, second)
    const deleted = [chosen, first, second][deletedIndex]
    memories.delete(deleted.id, '用户要求删除', NOW + 1)
    const before = snapshot()
    assert.equal(memories.confirm(chosen.id, USER, NOW + 2, expected, [first.id, second.id]), null)
    assert.equal(memories.revise(deleted.id, { text: '不能复活', actor: USER, expectedRevision: deleted.revision }, NOW + 2), null)
    assert.deepEqual(snapshot(), before)
  })
}

test('非可信写入者不能改写或确认，也不能使替换集合失效', () => {
  const chosen = put('候选', EXPERT)
  const rival = put('旧规则')
  const before = snapshot()
  for (const actor of [EXPERT, { id: '伪造身份', isUser: 'true' } as unknown as MemoryActor]) {
    assert.equal(memories.revise(chosen.id, { text: '自行更改', actor, expectedRevision: chosen.revision }, NOW + 1), null)
    assert.equal(memories.confirm(chosen.id, actor, NOW + 1, revisions(chosen, rival), [rival.id]), null)
  }
  assert.deepEqual(snapshot(), before)
})

test('缺省、非法或继承的版本值以及旧签名都不能绕过校验', () => {
  const chosen = put('候选', EXPERT)
  const rival = put('旧规则')
  const before = snapshot()
  for (const expectedRevision of [undefined, null, '1', NaN, Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(memories.revise(chosen.id, {
      text: '未经校验', actor: USER, expectedRevision: expectedRevision as number,
    }, NOW + 1), null)
    assert.equal(memories.confirm(chosen.id, USER, NOW + 1, {
      [chosen.id]: expectedRevision as number,
    }), null)
  }
  for (const args of [
    [chosen.id, USER, NOW + 1],
    [chosen.id, USER, NOW + 1, [rival.id]],
    [chosen.id, USER, NOW + 1, null],
    [chosen.id, USER, NOW + 1, {}],
    [chosen.id, USER, NOW + 1, Object.create(revisions(chosen))],
    [chosen.id, USER, NOW + 1, revisions(chosen), [rival.id]],
    [chosen.id, USER, NOW + 1, revisions(rival), [rival.id]],
  ]) {
    assert.equal(Reflect.apply(memories.confirm, memories, args), null)
  }
  assert.equal(Reflect.apply(memories.revise, memories, [chosen.id, { text: '旧签名', actor: USER }, NOW + 1]), null)
  assert.deepEqual(snapshot(), before)
})

test('改写保留来源、下游引用和原编号，删除来源仍按原路径传播', () => {
  const source = put('来源')
  const chosen = put('候选', EXPERT, [source.id])
  const leaf = put('下游结论', EXPERT, [chosen.id])
  const revised = memories.revise(chosen.id, {
    text: '  修改后的候选  ', topic: '  Report   Tone ', actor: USER, expectedRevision: chosen.revision,
  }, NOW + 1)
  assert.deepEqual(revised, {
    ...chosen, text: '修改后的候选', topic: 'report tone', confirmedBy: USER.id,
    revision: chosen.revision + 1, updatedAt: NOW + 1,
  })
  assert.deepEqual(memories.get(leaf.id, NOW + 1), leaf)
  const outcome = memories.delete(source.id, '删除支撑来源', NOW + 2)
  assert.deepEqual(outcome.deleted.map(record => record.id), [source.id, chosen.id, leaf.id])
  assert.equal(outcome.ledgerEntries, 3)
  assert.equal(memories.count(), 0)
})

test('来源删除导致版本增加时，旧版改写与确认均拒绝', () => {
  const chosen = put('多来源结论', USER, ['来源一', '来源二'])
  memories.deleteSource('来源一', '用户删除来源', NOW + 1)
  const weakened = memories.get(chosen.id, NOW + 1)
  assert.equal(weakened?.revision, chosen.revision + 1)
  assert.equal(weakened?.status, 'candidate')
  const before = snapshot()
  assert.equal(memories.revise(chosen.id, { text: '旧版编辑', actor: USER, expectedRevision: chosen.revision }, NOW + 2), null)
  assert.equal(memories.confirm(chosen.id, USER, NOW + 2, revisions(chosen)), null)
  assert.deepEqual(snapshot(), before)
})

test('到期记忆和空白改写即使版本匹配也拒绝', () => {
  const chosen = put('原文')
  const expired = memories.put({ kind: 'user_preference', scopeKind: 'global', text: '到期规则', actor: EXPERT, expiresAt: NOW + 1 }, NOW)
  assert.ok(expired.ok)
  const before = snapshot()
  assert.equal(memories.revise(chosen.id, { text: '  ', actor: USER, expectedRevision: chosen.revision }, NOW + 1), null)
  assert.equal(memories.revise(expired.record.id, { text: '不能重启', actor: USER, expectedRevision: expired.record.revision }, NOW + 1), null)
  assert.equal(memories.confirm(expired.record.id, USER, NOW + 1, revisions(expired.record)), null)
  assert.deepEqual(snapshot(), before)
})

test('条件更新未命中返回空结果，不能伪报改写成功', () => {
  const chosen = put('原文')
  const before = snapshot()
  db.exec('CREATE TRIGGER 忽略更新 BEFORE UPDATE ON memories BEGIN SELECT RAISE(IGNORE); END')
  assert.equal(memories.revise(chosen.id, { text: '新文本', actor: USER, expectedRevision: chosen.revision }, NOW + 1), null)
  assert.deepEqual(snapshot(), before)
})

test('确认写入中途失败会回滚已确认目标及已失效的替换项', () => {
  const chosen = put('候选', EXPERT)
  const first = put('旧规则一')
  const second = put('旧规则二')
  const before = snapshot()
  db.exec(`CREATE TRIGGER 拒绝末项更新 BEFORE UPDATE ON memories WHEN OLD.memory_id = '${second.id}'
    BEGIN SELECT RAISE(ABORT, '模拟末项写入失败'); END`)
  assert.throws(() => memories.confirm(chosen.id, USER, NOW + 1, revisions(chosen, first, second), [first.id, second.id]), /模拟末项写入失败/)
  assert.deepEqual(snapshot(), before)
})
