/**
 * 待办的「优先级 / 来源」：契约校验 + 老库迁移。
 *
 * 两件事都很容易"看起来对、实际错"：
 * 1. 契约是 `.strict()`，字段少声明会 parse 失败、多声明会拒收 —— 必须逐条钉；
 * 2. 迁移必须幂等且给老数据落默认值，否则界面上会出现空白格。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'

import { companionTaskViewSchema } from '../src/companion-contract.ts'
import { TeamStore, normalizePriority, normalizeSource } from '../src/team-domain.ts'

const base = {
  taskId: 't1', parentTaskId: null, kind: 'agent', title: '改讲解链路', status: 'queued',
  blocker: null, revision: 1, deviceId: 'd1', artifactIds: [], updatedAt: new Date().toISOString(),
}

describe('companionTaskViewSchema：priority / source', () => {
  test('两个字段齐全时通过', () => {
    const parsed = companionTaskViewSchema.parse({ ...base, priority: 'high', source: 'meeting' })
    assert.equal(parsed.priority, 'high')
    assert.equal(parsed.source, 'meeting')
  })

  test('四种来源、三种优先级都合法', () => {
    for (const source of ['manual', 'meeting', 'enterprise', 'ai'] as const) {
      assert.equal(companionTaskViewSchema.parse({ ...base, priority: 'normal', source }).source, source)
    }
    for (const priority of ['high', 'normal', 'low'] as const) {
      assert.equal(companionTaskViewSchema.parse({ ...base, priority, source: 'manual' }).priority, priority)
    }
  })

  test('非法值被拒', () => {
    assert.throws(() => companionTaskViewSchema.parse({ ...base, priority: 'urgent', source: 'manual' }))
    assert.throws(() => companionTaskViewSchema.parse({ ...base, priority: 'normal', source: 'wechat' }))
  })

  test('缺失字段被 .strict() 拦下（不会悄悄变成 undefined）', () => {
    assert.throws(() => companionTaskViewSchema.parse({ ...base, priority: 'normal' }), '缺 source')
    assert.throws(() => companionTaskViewSchema.parse({ ...base, source: 'manual' }), '缺 priority')
  })

  test('库里的脏值按默认落回，不冒到界面', () => {
    assert.equal(normalizePriority('urgent'), 'normal')
    assert.equal(normalizePriority(null), 'normal')
    assert.equal(normalizeSource('wechat'), 'manual')
    assert.equal(normalizeSource(undefined), 'manual')
  })
})

describe('迁移：老库补列，幂等且给默认值', () => {
  // 必须用**文件**库：`:memory:` 每次连接都是新库，关掉就没了，"重开一次跑迁移"根本测不到。
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-priority-'))
  const dbPath = path.join(dir, 'team.sqlite')
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

  test('老数据（无这两列）读出来是 normal / manual，且迁移跑两次不报错', () => {
    // 建一个"老库"：tasks 表没有 priority/source。
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, owner_id TEXT NOT NULL, goal TEXT NOT NULL,
      input_evidence TEXT NOT NULL, acceptance TEXT NOT NULL, tool_scope TEXT NOT NULL,
      budget_tokens INTEGER NOT NULL, deadline_at INTEGER, status TEXT NOT NULL, revision INTEGER NOT NULL,
      artifacts TEXT NOT NULL, origin_request_id TEXT, origin_channel TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    db.exec(`INSERT INTO tasks VALUES ('old-1','team','owner','老任务','[]','[]','read-only',0,NULL,'queued',1,'[]',NULL,NULL,1,1)`)
    db.close()

    // 第一次打开：迁移补列 + 老行落默认值。
    const store = new TeamStore(dbPath)
    const first = store.getTask('old-1')
    assert.equal(first?.priority, 'normal')
    assert.equal(first?.source, 'manual')
    store.close()

    // 第二次打开：迁移再来一遍，不报错，值不变。
    const again = new TeamStore(dbPath)
    const second = again.getTask('old-1')
    assert.equal(second?.priority, 'normal')
    assert.equal(second?.source, 'manual')
    again.close()
  })

  test('setTaskPriority 只动 priority/updatedAt/revision，不碰状态', () => {
    const store = new TeamStore(dbPath)
    store.insertTask({
      taskId: 'p-1', teamId: 'team', ownerId: 'owner', goal: 'x', inputEvidence: [], acceptance: [],
      toolScope: 'read-only', budgetTokens: 0, deadlineAt: null, dependsOn: [], status: 'queued', revision: 1,
      artifacts: [], originRequestId: null, originChannel: null, createdAt: 1, updatedAt: 1,
    })
    const updated = store.setTaskPriority('p-1', 'high', 99)
    assert.equal(updated?.priority, 'high')
    assert.equal(updated?.status, 'queued', '状态不许被顺手改掉')
    assert.equal(updated?.updatedAt, 99)
    assert.equal(updated?.revision, 2)
    assert.equal(store.setTaskPriority('nope', 'high', 1), null)
    store.close()
  })
})
