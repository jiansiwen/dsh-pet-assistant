/**
 * 召回地基（FTS5 + 中文 bigram）用例。
 *
 * 全部用 mkdtemp 建**临时文件库**，不碰用户真实库：召回测试要反复删表、直删真源行，
 * 在正式库上做同样的事等于替用户执行删除。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, afterEach, beforeEach, test } from 'node:test'
import { MemoryStore, type MemoryActor, type MemoryRecord } from '../src/memory.ts'
import {
  BIGRAM_TOKEN_LIMIT,
  RECALL_EMPTY_INJECTION,
  bigramSegment,
  dropRecallSchema,
  ensureRecallSchema,
  recallMemories,
  reconcileRecallIndex,
} from '../src/recall-index.ts'
import { ASSISTANT_SCHEMA_VERSION, getUserFlag, openAssistantStore } from '../src/store.ts'

const USER: MemoryActor = { id: '测试用户', isUser: true }
const EXPERT: MemoryActor = { id: '测试专家', isUser: false }
const NOW = 1_757_000_000_000
const GLOBAL_SCOPES = [{ kind: 'global', id: '' }]
const SCHEMA_OBJECTS = ['recall_proj', 'recall_fts', 'recall_proj_ai', 'recall_proj_ad', 'recall_proj_au']

const dirs: string[] = []
let db: DatabaseSync
let memories: MemoryStore

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-recall-'))
  dirs.push(dir)
  db = openAssistantStore(path.join(dir, 'assistant.db'))
  memories = new MemoryStore(db)
})

afterEach(() => {
  db.close()
})

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function remember(
  text: string,
  input: {
    actor?: MemoryActor
    kind?: string
    scopeKind?: string
    scopeId?: string
    topic?: string
  } = {},
): MemoryRecord {
  const result = memories.put(
    {
      kind: input.kind ?? 'user_preference',
      scopeKind: input.scopeKind ?? 'global',
      scopeId: input.scopeId ?? null,
      topic: input.topic ?? '',
      text,
      actor: input.actor ?? USER,
    },
    NOW,
  )
  assert.ok(result.ok)
  return result.record
}

function schemaObjects(): string[] {
  const rows = db.prepare('SELECT name FROM sqlite_master WHERE name IN (?, ?, ?, ?, ?)').all(
    ...SCHEMA_OBJECTS,
  ) as Array<Record<string, unknown>>
  return rows.map(row => String(row.name)).sort()
}

function pragmaUserVersion(): number {
  const row = db.prepare('PRAGMA user_version').get() as unknown as { user_version?: number } | undefined
  return Number(row?.user_version ?? 0)
}

function filteredSum(filtered: {
  candidate: number
  conflicting: number
  expired: number
  outOfScope: number
  tombstoned: number
}): number {
  return filtered.candidate + filtered.conflicting + filtered.expired + filtered.outOfScope + filtered.tombstoned
}

// ---------------------------------------------------------------------------
// 1. bigram
// ---------------------------------------------------------------------------

test('bigram：CJK 二元组 + 非 CJK 整词 + 保序去重 + token 截断', () => {
  // 判据里的查询词全是二字词，这个映射是最核心的一条。
  assert.equal(bigramSegment('WPS文档中项目'), 'wps 文档 档中 中项 项目')
  assert.equal(bigramSegment('项'), '项')
  assert.equal(bigramSegment('WPS Office'), 'wps office')
  assert.equal(bigramSegment(''), '')
  assert.equal(bigramSegment('   '), '')
  // 全角标点与全角竖线当切分点，不能拼出跨标点的假词
  assert.equal(bigramSegment('日报｜周报，结论'), '日报 周报 结论')
  // 保序去重：只保留首次出现
  assert.equal(bigramSegment('项目项目'), '项目 目项')

  const uniqueChars = Array.from({ length: 2500 }, (_, index) => String.fromCharCode(0x4e00 + index)).join('')
  const truncated = bigramSegment(uniqueChars)
  assert.equal(truncated.split(' ').length, BIGRAM_TOKEN_LIMIT)
  // 截断发生在尾部，前面顺序不变
  assert.ok(truncated.startsWith(`${String.fromCharCode(0x4e00)}${String.fromCharCode(0x4e01)} `))
})

// ---------------------------------------------------------------------------
// 2. schema 幂等
// ---------------------------------------------------------------------------

test('ensureRecallSchema 连跑两次幂等，user_version 仍是 2', () => {
  ensureRecallSchema(db)
  ensureRecallSchema(db)
  assert.equal(pragmaUserVersion(), 2)
  assert.equal(pragmaUserVersion(), ASSISTANT_SCHEMA_VERSION)
  assert.equal(getUserFlag(db, 'recall:index_version'), '1')
  assert.deepEqual(schemaObjects(), [...SCHEMA_OBJECTS].sort())
})

// ---------------------------------------------------------------------------
// 3. 命中且正文来自真源
// ---------------------------------------------------------------------------

test('召回命中：二字词能命中，text 取自 memories.body 而不是 bigram 串', () => {
  ensureRecallSchema(db)
  const body = '项目复盘结论：本期只做召回地基，不做向量库。'
  const first = remember(body)
  remember('日报口径：每天 18:00 生成，节假日不生成。')
  // 主题进索引：正文没提"项目"，也该被"项目"这个查询词命中
  const byTopic = remember('结论一：先接线再召回。', { topic: '项目' })
  assert.deepEqual(reconcileRecallIndex(db, NOW), { added: 3, removed: 0 })

  const bundle = recallMemories(db, {
    now: NOW,
    queryTerms: ['项目'],
    maxItems: 5,
    scopes: GLOBAL_SCOPES,
  })

  const hit = bundle.matched.find(item => item.sourceId === first.id)
  assert.ok(hit)
  assert.equal(hit.text, body)
  assert.equal(hit.sourceKind, 'memory')
  assert.equal(hit.channel, 'fts-index')
  assert.equal(hit.sourceRef.digest.length, 64)
  assert.equal(hit.sourceRef.sourceRevision, first.revision)
  assert.equal(hit.scopeKind, 'global')
  assert.equal(hit.scopeId, '')
  assert.ok(hit.reasons.some(reason => reason.kind === 'fts_term'))
  // 正文里绝不能出现切分痕迹
  assert.ok(!hit.text.includes(' 档中'))
  assert.ok(bundle.matched.some(item => item.sourceId === byTopic.id))
  assert.equal(bundle.totalMatched, bundle.matched.length)
  assert.equal(bundle.trace.rawMatchCount, 2)
  assert.equal(bundle.empty, false)
  assert.equal(bundle.emptyReason, null)
  assert.ok(bundle.injection.includes(body))
  assert.equal(bundle.aliveChecks, bundle.matched.length + filteredSum(bundle.filtered))
})

// ---------------------------------------------------------------------------
// 4. 删除后不召回
// ---------------------------------------------------------------------------

test('删除记忆并重新对账后，matched 与 injected 中该 id 各 0 次', () => {
  ensureRecallSchema(db)
  const keep = remember('项目周报：每周五归档。')
  const gone = remember('项目会议纪要：本轮结论是延后。')
  reconcileRecallIndex(db, NOW)
  const before = recallMemories(db, { now: NOW, queryTerms: ['项目'], maxItems: 5, scopes: GLOBAL_SCOPES })
  assert.equal(before.matched.filter(item => item.sourceId === gone.id).length, 1)

  const outcome = memories.delete(gone.id, '用户要求忘记', NOW + 1)
  assert.equal(outcome.deleted.length, 1)
  reconcileRecallIndex(db, NOW + 1)

  const afterwards = recallMemories(db, {
    now: NOW + 1,
    queryTerms: ['项目'],
    maxItems: 5,
    scopes: GLOBAL_SCOPES,
  })
  assert.equal(afterwards.matched.filter(item => item.sourceId === gone.id).length, 0)
  assert.equal(afterwards.injected.filter(item => item.sourceId === gone.id).length, 0)
  assert.ok(afterwards.matched.some(item => item.sourceId === keep.id))
})

// ---------------------------------------------------------------------------
// 5. E-14：孤儿投影必须靠查询期回连剔除
// ---------------------------------------------------------------------------

test('E-14 孤儿投影：禁用 reconcile 直接删真源，仍被查询期存活校验剔除并计数', () => {
  ensureRecallSchema(db)
  const orphan = remember('项目结论：先做地基再谈编排。')
  reconcileRecallIndex(db, NOW)
  // 模拟"对账没跑过"的最坏情况：绕过 reconcile 也绕过删除账本，直接抹掉真源行
  db.prepare('DELETE FROM memories WHERE memory_id = ?').run(orphan.id)

  const bundle = recallMemories(db, { now: NOW, queryTerms: ['项目'], maxItems: 5, scopes: GLOBAL_SCOPES })
  assert.ok(bundle.aliveChecks >= 1)
  assert.ok(bundle.deadHitsFiltered >= 1)
  assert.ok(bundle.filtered.tombstoned >= 1)
  assert.equal(bundle.matched.filter(item => item.sourceId === orphan.id).length, 0)
  assert.equal(bundle.injected.filter(item => item.sourceId === orphan.id).length, 0)
  assert.equal(bundle.empty, true)
  assert.equal(bundle.emptyReason, 'all-filtered')
  // 计数闭合：候选必须能被 matched + Σfiltered 完整解释，不许有静默丢弃
  assert.equal(bundle.aliveChecks, bundle.matched.length + filteredSum(bundle.filtered))
})

// ---------------------------------------------------------------------------
// 6. 候选 / 冲突 / 越权
// ---------------------------------------------------------------------------

test('候选、冲突、越权范围都不进 matched/injected，且各自计数', () => {
  ensureRecallSchema(db)
  const candidate = remember('项目候选结论：可能需要双周复盘。', { actor: EXPERT })
  assert.equal(candidate.status, 'candidate')
  const conflicting = remember('项目冲突结论：日报改成每两天一份。')
  db.prepare(`UPDATE memories SET status = 'conflicting', revision = revision + 1 WHERE memory_id = ?`)
    .run(conflicting.id)
  remember('项目越权结论：别的项目里的偏好。', { scopeKind: 'project', scopeId: 'proj-other' })
  reconcileRecallIndex(db, NOW)

  const bundle = recallMemories(db, {
    now: NOW,
    queryTerms: ['项目'],
    maxItems: 5,
    scopes: [{ kind: 'global', id: '' }, { kind: 'project', id: 'proj-this' }],
  })
  assert.equal(bundle.matched.length, 0)
  assert.equal(bundle.injected.length, 0)
  assert.ok(bundle.filtered.candidate >= 1)
  assert.ok(bundle.filtered.conflicting >= 1)
  assert.ok(bundle.filtered.outOfScope >= 1)
  assert.equal(bundle.empty, true)
  assert.equal(bundle.emptyReason, 'all-filtered')
  assert.equal(bundle.aliveChecks, bundle.matched.length + filteredSum(bundle.filtered))
})

// ---------------------------------------------------------------------------
// 7. truncated
// ---------------------------------------------------------------------------

test('truncated 由本层按 rawMatchCount > matchLimit 置位，matched 只剩上界内候选', () => {
  ensureRecallSchema(db)
  remember('项目一：召回地基。')
  remember('项目二：索引对账。')
  reconcileRecallIndex(db, NOW)

  const bundle = recallMemories(db, {
    now: NOW,
    queryTerms: ['项目'],
    maxItems: 1,
    matchLimit: 1,
    scopes: GLOBAL_SCOPES,
  })
  assert.equal(bundle.trace.rawMatchCount, 2)
  assert.equal(bundle.matchLimit, 1)
  assert.equal(bundle.truncated, true)
  assert.equal(bundle.matched.length, 1)
  assert.equal(bundle.totalMatched, 1)
  assert.equal(bundle.injected.length, 1)
  assert.equal(bundle.empty, false)
})

// ---------------------------------------------------------------------------
// 8. 空态
// ---------------------------------------------------------------------------

test('空态：库里有记忆表但没有记忆时，injection 是非空字符串', () => {
  ensureRecallSchema(db)
  const bundle = recallMemories(db, { now: NOW, queryTerms: ['项目'], maxItems: 5, scopes: GLOBAL_SCOPES })
  assert.equal(typeof bundle.injection, 'string')
  assert.ok(bundle.injection.length > 0)
  assert.ok(bundle.injection.includes('未找到相关记忆'))
  assert.equal(bundle.injection, RECALL_EMPTY_INJECTION)
  assert.equal(bundle.empty, true)
  assert.equal(bundle.emptyReason, 'no-match')
  assert.equal(bundle.matched.length, 0)
  assert.equal(bundle.aliveChecks, 0)
  assert.equal(bundle.deadHitsFiltered, 0)
  assert.equal(bundle.degraded, false)
})

// ---------------------------------------------------------------------------
// 9. 回滚
// ---------------------------------------------------------------------------

test('dropRecallSchema 后两表三触发器都不存在，索引代次标记被清且真源未动', () => {
  ensureRecallSchema(db)
  remember('项目：随便一条。')
  reconcileRecallIndex(db, NOW)
  dropRecallSchema(db)

  assert.deepEqual(schemaObjects(), [])
  assert.equal(getUserFlag(db, 'recall:index_version'), null)
  // 真源一行未动：回滚后旧插件照常启动
  assert.equal(memories.count(), 1)
  // 表没了也不能抛异常，只降级
  const bundle = recallMemories(db, { now: NOW, queryTerms: ['项目'], maxItems: 5, scopes: GLOBAL_SCOPES })
  assert.equal(bundle.degraded, true)
  assert.equal(bundle.emptyReason, 'degraded')
  assert.equal(bundle.injection, RECALL_EMPTY_INJECTION)
})

// ---------------------------------------------------------------------------
// 10. 索引缺失的降级
// ---------------------------------------------------------------------------

test('索引未建立时降级：不抛异常、返回空态串并标 degraded', () => {
  const bundle = recallMemories(db, { now: NOW, queryTerms: ['项目'], maxItems: 5, scopes: GLOBAL_SCOPES })
  assert.equal(bundle.degraded, true)
  assert.equal(bundle.trace.degraded, true)
  assert.equal(bundle.emptyReason, 'degraded')
  assert.equal(bundle.injection, RECALL_EMPTY_INJECTION)
  assert.ok(bundle.degradeReason !== null && bundle.degradeReason.length > 0)
})
