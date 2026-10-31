import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { TeamStore, TEAM_SCHEMA_VERSION } from '../src/team-domain.ts'

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mail-store-'))
  const dbPath = path.join(dir, 'team.sqlite')
  let store = new TeamStore(dbPath)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, dbPath, get store() { return store },
    reopen: (before?: () => void) => { store.close(); before?.(); store = new TeamStore(dbPath) } }
}
function init(store: TeamStore, upper = 50) {
  return store.ensureMailWatchScope({ scopeId: 'scope-1', accountKey: 'account-1', folder: 'INBOX', uidValidity: '7',
    bootstrapUpperUid: upper, legacy: null }, 1)
}

test('邮件表升级复用唯一 TeamStore 库，v9 数据保留且重复打开幂等', t => {
  const f = fixture(t)
  f.store.insertOperation({ operationId: 'old-op', taskId: 'old-task', approvalId: null, kind: 'write',
    state: 'succeeded', resultDigest: 'old-digest', startedAt: 1, endedAt: 2 })
  f.reopen(() => {
    const old = new DatabaseSync(f.dbPath)
    old.exec(`DROP TABLE channel_inbound; DROP TABLE mail_watch_messages; DROP TABLE mail_watch_analyses; DROP TABLE mail_watch_scopes;
      DELETE FROM migrations WHERE version = ${TEAM_SCHEMA_VERSION}; PRAGMA user_version = 9;`)
    old.close()
  })
  assert.equal(f.store.getOperation('old-op')?.resultDigest, 'old-digest')
  init(f.store)
  f.reopen()
  assert.equal(f.store.getMailWatchScope('scope-1')?.scannedUid, 0)
  assert.equal(f.store.getOperation('old-op')?.state, 'succeeded')
  const raw = new DatabaseSync(f.dbPath, { readOnly: true })
  try {
    assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, TEAM_SCHEMA_VERSION)
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM migrations WHERE version = ?').get(TEAM_SCHEMA_VERSION)!.n, 1)
  } finally { raw.close() }
  assert.deepEqual(readdirSync(f.dir).filter(file => !file.endsWith('-wal') && !file.endsWith('-shm')), ['team.sqlite'])
})

test('登记 UID 与水位原子提交；事务中断后两者一起回滚，重放无丢失', t => {
  const f = fixture(t)
  const scope = init(f.store)
  assert.throws(() => f.store.transaction(() => {
    f.store.commitMailWatchPage(scope, 25, [1, 6, 25])
    throw new Error('模拟提交前崩溃')
  }), /模拟提交前崩溃/)
  assert.equal(f.store.getMailWatchScope(scope.scopeId)?.scannedUid, 0)
  assert.equal(f.store.listMailWatchMessages(scope.scopeId, 'pending').length, 0)
  f.reopen()
  const committed = f.store.commitMailWatchPage(f.store.getMailWatchScope(scope.scopeId)!, 25, [1, 6, 25])
  assert.equal(committed.scannedUid, 25)
  assert.deepEqual(f.store.listMailWatchMessages(scope.scopeId, 'pending').map(item => item.uid), [1, 6, 25])
  assert.throws(() => f.store.commitMailWatchPage(scope, 25, [1, 6, 25]), /游标已变化/)
})

test('迟到页面或超范围 UID 不能写入，更不能提前移动水位', t => {
  const f = fixture(t)
  const scope = init(f.store)
  f.store.beginMailWatchScan(scope.scopeId, 100, 2)
  assert.throws(() => f.store.commitMailWatchPage(scope, 25, [1]), /游标已变化/)
  const current = f.store.getMailWatchScope(scope.scopeId)!
  assert.throws(() => f.store.commitMailWatchPage(current, 25, [26]), /页面范围无效/)
  assert.throws(() => f.store.commitMailWatchPage(current, 26, [-1]), /页面范围无效/)
  assert.equal(f.store.getMailWatchScope(scope.scopeId)?.scannedUid, 0)
  assert.equal(f.store.getMailWatchScope(scope.scopeId)?.scanUpperUid, 50)
})

test('新近登记事务回滚、重放和旧版 v10 重启均保留原游标与消费状态', t => {
  const f = fixture(t)
  const scope = f.store.commitMailWatchPage(init(f.store, 10_000), 25, [1, 2])
  assert.throws(() => f.store.transaction(() => {
    f.store.registerMailWatchTailPage(scope, 10_001, 10_002, [10_001, 10_002])
    throw new Error('模拟尾页提交前崩溃')
  }), /模拟尾页提交前崩溃/)
  assert.deepEqual(f.store.getMailWatchScope(scope.scopeId), scope)
  assert.deepEqual(f.store.listMailWatchMessages(scope.scopeId, 'pending', 10).map(item => item.uid), [1, 2])

  const tail = f.store.registerMailWatchTailPage(scope, 10_001, 10_002, [10_001, 10_002])
  assert.equal(tail.scannedUid, 25)
  assert.equal(tail.scanUpperUid, 10_000)
  assert.throws(() => f.store.commitMailWatchPage(scope, 50, [30]), /游标已变化/)
  assert.throws(() => f.store.registerMailWatchTailPage(scope, 10_001, 10_002, [10_001]), /游标已变化/)
  assert.throws(() => f.store.registerMailWatchTailPage(tail, 10_000, 10_001, [10_001]), /页面范围无效/)
  assert.throws(() => f.store.registerMailWatchTailPage(tail, 10_001, 10_002, [10_003]), /页面范围无效/)
  assert.throws(() => f.store.registerMailWatchTailPage(tail, 10_001, 10_002, [10_001, 10_001]), /页面范围无效/)

  f.store.completeMailWatchAnalysis(scope.scopeId, 'member', [{ uid: 10_001, sourceDigest: 'digest', truncated: false }], '已分析', 3)
  f.store.noteMailWatchMessage(scope.scopeId, 10_002, '已消失', true)
  f.store.registerMailWatchTailPage(tail, 10_001, 10_002, [10_001, 10_002])
  f.reopen(() => {
    const old = new DatabaseSync(f.dbPath)
    try {
      old.exec(`DROP TABLE channel_inbound; DROP TABLE mail_send_intents; DROP TABLE mail_notice_deliveries; DELETE FROM migrations WHERE version = ${TEAM_SCHEMA_VERSION}; PRAGMA user_version = 10`)
    } finally { old.close() }
  })
  assert.equal(TEAM_SCHEMA_VERSION, 14)
  const raw = new DatabaseSync(f.dbPath, { readOnly: true })
  try { assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 14) } finally { raw.close() }
  assert.equal(f.store.getMailWatchScope(scope.scopeId)?.scannedUid, 25)
  assert.deepEqual(f.store.listMailWatchMessages(scope.scopeId, 'analyzed').map(item => item.uid), [10_001])
  assert.deepEqual(f.store.listMailWatchMessages(scope.scopeId, 'missing').map(item => item.uid), [10_002])
  assert.equal(f.store.pendingMailWatchNotifications(scope.scopeId)[0].result, '已分析')

  const other = f.store.ensureMailWatchScope({ scopeId: 'scope-2', accountKey: 'account-2', folder: 'INBOX',
    uidValidity: '7', bootstrapUpperUid: 10_000, legacy: null }, 4)
  f.store.registerMailWatchTailPage(other, 10_001, 10_001, [10_001])
  assert.deepEqual(f.store.listMailWatchMessages(other.scopeId, 'pending').map(item => item.uid), [10_001])
  assert.deepEqual(f.store.listMailWatchMessages(scope.scopeId, 'pending').map(item => item.uid), [1, 2])
})

test('成功消费与分析结果/待通知同事务；中途失败不留下半份成功或通知', t => {
  const f = fixture(t)
  const scope = f.store.commitMailWatchPage(init(f.store), 25, [1, 2])
  assert.throws(() => f.store.completeMailWatchAnalysis(scope.scopeId, 'member', [
    { uid: 1, sourceDigest: 'digest-1', truncated: false }, { uid: 3, sourceDigest: 'digest-3', truncated: true },
  ], '结果', 3), /消费状态已变化/)
  assert.equal(f.store.pendingMailWatchNotifications(scope.scopeId).length, 0)
  assert.equal(f.store.listMailWatchMessages(scope.scopeId, 'pending').length, 2)
  const result = f.store.completeMailWatchAnalysis(scope.scopeId, 'member', [
    { uid: 1, sourceDigest: 'digest-1', truncated: false }, { uid: 2, sourceDigest: 'digest-2', truncated: true },
  ], '完整分析结果', 3)
  f.reopen()
  assert.equal(f.store.pendingMailWatchNotifications(scope.scopeId)[0].result, '完整分析结果')
  assert.equal(f.store.listMailWatchMessages(scope.scopeId, 'analyzed')[1].truncated, true)
  f.store.markMailWatchNotified(result.analysisId, 4)
  f.reopen()
  assert.equal(f.store.pendingMailWatchNotifications(scope.scopeId).length, 0)
  assert.equal(f.store.listMailWatchMessages(scope.scopeId, 'analyzed').length, 2)
})

test('迁移已归属的 seen 不推进游标，重复初始化不覆盖持久状态', t => {
  const f = fixture(t)
  const input = { scopeId: 'scope-1', accountKey: 'account-1', folder: 'INBOX', uidValidity: '7', bootstrapUpperUid: 50,
    legacy: { uidValidity: '7', seen: [2, 50], accountKey: 'account-1', folder: 'INBOX', note: '仅导入明确消费记录' } }
  const scope = f.store.ensureMailWatchScope(input, 1)
  assert.equal(scope.scannedUid, 0)
  f.store.commitMailWatchPage(scope, 25, [1, 2])
  assert.deepEqual(f.store.listMailWatchMessages(scope.scopeId, 'pending').map(item => item.uid), [1])
  assert.deepEqual(f.store.listMailWatchMessages(scope.scopeId, 'legacy-completed').map(item => item.uid), [2, 50])
  f.reopen()
  const again = f.store.ensureMailWatchScope({ ...input, bootstrapUpperUid: 1 }, 100)
  assert.equal(again.scannedUid, 25)
  assert.equal(again.bootstrapUpperUid, 50)
  assert.equal(again.legacy?.seen.length, 2)
})
