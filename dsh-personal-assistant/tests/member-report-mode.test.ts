/**
 * 汇报方式（reportMode）的钉子用例。
 *
 * 这是"谁开口"的配置：`chief` = 成员干完交给总助理汇总（默认），
 * `self` = 该成员自己直接对本人汇报一次，总助理不再重复念。
 *
 * 钉四件事：
 * 1. **老数据默认 chief** —— 加这个字段之前建的成员，读出来必须是 chief，不能是 undefined
 *    （undefined 会让下游判断悄悄走到 false 分支）；
 * 2. self 能存能读，重启还在（存在 assistant_profiles 的 JSON 扩展里，不是新列）；
 * 3. 非法值被拒，且拒的时候不留半截数据；
 * 4. 改汇报方式**不算权限变更** —— 不该清掉成员会话，那会让成员忘记自己做到哪一步。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import type { MemberDraft } from '../src/member-directory.ts'
import { TeamStore } from '../src/team-domain.ts'

function draft(patch: Record<string, unknown> = {}): MemberDraft {
  return {
    displayName: '演讲助理', description: '负责对老板讲解文档', persona: '讲话利落，先给结论', skinId: 'panda', enabled: true,
    provider: '', model: '', maxTokens: 16384, capabilities: ['document'], allowedTools: [],
    dailyTokenLimit: 0, totalTokenLimit: 0, thresholdPercent: 80, timezone: 'Asia/Shanghai',
    ...patch,
  } as MemberDraft
}

/** 每次 open 都记下来，测试结束时统一关；重复关是空操作，不要因为关两次把用例判红。 */
function workspace(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-report-mode-'))
  const dbPath = path.join(dir, 'team.sqlite')
  const opened: TeamStore[] = []
  t.after(() => {
    for (const store of opened.reverse()) { try { store.close() } catch { /* 已经关过了 */ } }
    rmSync(dir, { recursive: true, force: true })
  })
  return (): TeamStore => { const store = new TeamStore(dbPath); opened.push(store); return store }
}

void test('汇报方式：不填时默认由总助理汇报', (t) => {
  const store = workspace(t)()
  const member = store.directory.create(draft())
  assert.equal(member.reportMode, 'chief')
})

void test('汇报方式：self 能存能读，重启后还在', (t) => {
  const open = workspace(t)
  const first = open()
  const member = first.directory.create(draft({ reportMode: 'self' }))
  assert.equal(member.reportMode, 'self')
  first.close()

  const again = open().directory.get(member.assistantId)
  assert.ok(again, '重启后成员应该还在')
  assert.equal(again.reportMode, 'self', '汇报方式没存住，或者读回来丢了')
})

void test('汇报方式：非法值被拒，且不留下半截数据', (t) => {
  const store = workspace(t)()
  assert.throws(() => store.directory.create(draft({ reportMode: 'everyone' })), /汇报方式/)
  assert.equal(store.directory.list().filter(member => member.displayName === '演讲助理').length, 0,
    '被拒的创建不能留下成员')
})

void test('汇报方式：改它不算权限变更，成员会话留着', (t) => {
  const store = workspace(t)()
  const created = store.directory.create(draft({ reportMode: 'chief' }))
  // 先给成员挂一个会话号：只有"权限变了"才会被清掉（member-directory.ts 的 permissionsChanged）。
  store.directory.setSession(created.assistantId, 'session-keep')
  const current = store.directory.get(created.assistantId)
  assert.ok(current)
  assert.equal(current.sessionId, 'session-keep', '前置条件：会话号已挂上')

  const updated = store.directory.update(created.assistantId, current.revision, draft({ reportMode: 'self' }))
  assert.equal(updated.reportMode, 'self')
  assert.equal(updated.revision, current.revision + 1, '正常走一次修改，不退化成原地改')
  assert.equal(updated.sessionId, 'session-keep',
    '只改汇报方式不该重置成员会话 —— 那会让成员忘记自己做到哪一步')
})
