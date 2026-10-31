import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { ApprovalService } from '../src/approval.ts'
import { SessionBridge } from '../src/bridge.ts'
import { MemberManagement } from '../src/member-management.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'
import { TeamStore, TEAM_SCHEMA_VERSION } from '../src/team-domain.ts'
import { BridgeClient } from '../../dsh-pet/src/main/harness.ts'

function fixture(t: TestContext) {
  const store = new TeamStore(':memory:')
  let now = 1_000_000
  let account: string | null = 'account-a'
  let member: string | null = 'mail-member'
  let epoch = 'epoch-1'
  const makeRuntime = () => {
    const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: epoch })
    const runtime = new CompanionTaskRuntime(store, approvals, { epoch, now: () => now,
      activeMailAccount: () => account && member ? { accountKey: account, memberId: member } : null })
    runtime.start()
    return runtime
  }
  let runtime = makeRuntime()
  const runtimes = [runtime]
  t.after(async () => {
    for (const instance of runtimes) await instance.dispose()
    store.close()
  })
  const addAnalysis = (scopeId: string, accountKey: string, uidValidity: string, result = `测试邮件分析-${scopeId}`) => {
    const scope = store.ensureMailWatchScope({ scopeId, accountKey, folder: 'INBOX', uidValidity,
      bootstrapUpperUid: 1, legacy: null }, now)
    store.commitMailWatchPage(scope, 1, [1])
    return store.completeMailWatchAnalysis(scopeId, 'mail-member', [{ uid: 1, sourceDigest: 'digest', truncated: false }], result, now)
  }
  const restart = (nextEpoch: string) => {
    runtime.stopAccepting()
    epoch = nextEpoch
    runtime = makeRuntime()
    runtimes.push(runtime)
  }
  return { store, addAnalysis, restart, get runtime() { return runtime },
    setAccount: (value: string | null) => { account = value }, setMember: (value: string | null) => { member = value },
    advance: (ms: number) => { now += ms } }
}

type Notices = {
  deliveries: Array<{ analysisId: string; memberId: string; text: string }>
  attention: Array<{ analysisId: string; state: string }>
}
const noticePath = '/executor/v1/mail-notices'

test('桌宠离线时分析保留待投递，只有可信执行器领取并回执后才完成', async t => {
  const f = fixture(t)
  const first = f.addAnalysis('scope-a1', 'account-a', '1')
  const second = f.addAnalysis('scope-a2', 'account-a', '2')
  f.addAnalysis('scope-b', 'account-b', '1')
  assert.equal((await f.runtime.request('GET', noticePath, null, 'client')).status, 403)
  f.restart('epoch-2')
  const before = await f.runtime.request('GET', noticePath, null, 'executor')
  assert.equal(before.status, 200)
  const items = (before.body as Notices).deliveries
  assert.deepEqual(items.map(item => item.analysisId).sort(), [first.analysisId, second.analysisId].sort())
  assert.equal(f.store.pendingMailWatchNotifications('scope-a1').length, 1, '只查询不能记为已通知')

  const claimPath = `${noticePath}/${first.analysisId}/claim`
  assert.equal((await f.runtime.request('POST', claimPath, { executorEpoch: 'epoch-1' }, 'executor')).status, 409)
  const claimed = await f.runtime.request('POST', claimPath, { executorEpoch: 'epoch-2' }, 'executor')
  assert.equal(claimed.status, 200)
  const attemptId = (claimed.body as { attemptId: string }).attemptId
  assert.equal((await f.runtime.request('POST', claimPath, { executorEpoch: 'epoch-2' }, 'executor')).status, 409)
  const receiptPath = `${noticePath}/${first.analysisId}/receipt`
  const receipt = { executorEpoch: 'epoch-2', attemptId, state: 'succeeded', evidenceRefs: [`notification:${first.analysisId}:${attemptId}`] }
  assert.equal((await f.runtime.request('POST', receiptPath, receipt, 'executor')).status, 200)
  assert.equal((await f.runtime.request('POST', receiptPath, receipt, 'executor')).status, 200, '相同回执幂等')
  assert.equal(f.store.pendingMailWatchNotifications('scope-a1').length, 0)
  f.restart('epoch-3')
  const after = await f.runtime.request('GET', noticePath, null, 'executor')
  assert.deepEqual((after.body as Notices).deliveries.map(item => item.analysisId), [second.analysisId])
})

test('领取后崩溃结果未知，重启后保留核查提示且不盲目重复投递', async t => {
  const f = fixture(t)
  const analysis = f.addAnalysis('scope-a', 'account-a', '1')
  const claim = await f.runtime.request('POST', `${noticePath}/${analysis.analysisId}/claim`, { executorEpoch: 'epoch-1' }, 'executor')
  assert.equal(claim.status, 200)
  const attemptId = (claim.body as { attemptId: string }).attemptId
  f.restart('epoch-2')
  const result = await f.runtime.request('GET', noticePath, null, 'executor')
  assert.equal(result.status, 200)
  const view = result.body as Notices
  assert.deepEqual(view.deliveries, [])
  assert.ok(view.attention.some(item => item.analysisId === analysis.analysisId && item.state === 'unknown'))
  assert.equal(f.store.mailNoticeAttention('account-a', null)[0].preview, '测试邮件分析-scope-a')
  assert.deepEqual(f.store.mailNoticeAttention('account-b', null), [], '核查视图不能混入其他账户')
  assert.equal((await f.runtime.request('POST', `${noticePath}/${analysis.analysisId}/claim`, { executorEpoch: 'epoch-2' }, 'executor')).status, 409)
  assert.equal((await f.runtime.request('POST', `${noticePath}/${analysis.analysisId}/receipt`, {
    executorEpoch: 'epoch-1', attemptId, state: 'succeeded', evidenceRefs: [`notification:${analysis.analysisId}:${attemptId}`],
  }, 'executor')).status, 409, '旧代次回执不能覆盖重启后的未知状态')
})

test('切换账户或关闭值守后不泄露待通知内容，已领取的真实回执仍可结算', async t => {
  const f = fixture(t)
  const a = f.addAnalysis('scope-a', 'account-a', '1')
  const b = f.addAnalysis('scope-b', 'account-b', '1')
  f.setMember(null)
  assert.deepEqual((await f.runtime.request('GET', noticePath, null, 'executor')).body, { deliveries: [], attention: [] })
  assert.equal((await f.runtime.request('POST', `${noticePath}/${a.analysisId}/claim`, { executorEpoch: 'epoch-1' }, 'executor')).status, 409)
  f.setMember('other-member')
  assert.deepEqual((await f.runtime.request('GET', noticePath, null, 'executor')).body, { deliveries: [], attention: [] })
  assert.equal((await f.runtime.request('POST', `${noticePath}/${a.analysisId}/claim`, { executorEpoch: 'epoch-1' }, 'executor')).status, 409,
    '不能把旧成员的分析投递给另一成员')
  f.setMember('mail-member')
  f.setAccount('account-b')
  assert.equal((await f.runtime.request('POST', `${noticePath}/${a.analysisId}/claim`, { executorEpoch: 'epoch-1' }, 'executor')).status, 409,
    '已切换账户后不能领取旧账户的内容')
  f.setAccount('account-a')
  const claimed = await f.runtime.request('POST', `${noticePath}/${a.analysisId}/claim`, { executorEpoch: 'epoch-1' }, 'executor')
  assert.equal(claimed.status, 200)
  const attemptId = (claimed.body as { attemptId: string }).attemptId
  f.setAccount('account-b')
  const current = await f.runtime.request('GET', noticePath, null, 'executor')
  assert.deepEqual((current.body as Notices).deliveries.map(item => item.analysisId), [b.analysisId])
  assert.equal((await f.runtime.request('POST', `${noticePath}/${a.analysisId}/receipt`, {
    executorEpoch: 'epoch-1', attemptId, state: 'succeeded', evidenceRefs: [`notification:${a.analysisId}:${attemptId}`],
  }, 'executor')).status, 200)
  f.setAccount(null)
  assert.deepEqual((await f.runtime.request('GET', noticePath, null, 'executor')).body, { deliveries: [], attention: [] })
  assert.equal((await f.runtime.request('POST', `${noticePath}/${b.analysisId}/claim`, { executorEpoch: 'epoch-1' }, 'executor')).status, 409)
})

test('长摘要只展示有截断标记的安全文本，原分析仍保留', async t => {
  const f = fixture(t)
  const original = `开始\u0001${'摘要'.repeat(500)}`
  const analysis = f.addAnalysis('scope-a', 'account-a', '1', original)
  const view = (await f.runtime.request('GET', noticePath, null, 'executor')).body as Notices
  assert.equal(view.deliveries[0].analysisId, analysis.analysisId)
  assert.equal(view.deliveries[0].text.length, 700)
  assert.ok(view.deliveries[0].text.endsWith('…'))
  assert.equal(view.deliveries[0].text.includes('\u0001'), false)
  assert.equal(f.store.pendingMailWatchNotifications('scope-a')[0].result, original)
})

test('领取超时或显示失败不会被当成送达，也不会自动重复显示', async t => {
  const f = fixture(t)
  const timeout = f.addAnalysis('scope-timeout', 'account-a', '1')
  const failed = f.addAnalysis('scope-failed', 'account-a', '2')
  const attempts = new Map<string, string>()
  for (const analysis of [timeout, failed]) {
    const claimed = await f.runtime.request('POST', `${noticePath}/${analysis.analysisId}/claim`, { executorEpoch: 'epoch-1' }, 'executor')
    assert.equal(claimed.status, 200)
    attempts.set(analysis.analysisId, (claimed.body as { attemptId: string }).attemptId)
  }
  assert.equal((await f.runtime.request('POST', `${noticePath}/${failed.analysisId}/receipt`, {
    executorEpoch: 'epoch-1', attemptId: attempts.get(failed.analysisId), state: 'failed-before-effect', evidenceRefs: [],
  }, 'executor')).status, 200)
  f.advance(60_001)
  const result = await f.runtime.request('GET', noticePath, null, 'executor')
  const view = result.body as Notices
  assert.deepEqual(view.deliveries, [])
  assert.ok(view.attention.some(item => item.analysisId === timeout.analysisId && item.state === 'unknown'))
  assert.ok(view.attention.some(item => item.analysisId === failed.analysisId && item.state === 'failed'))
  assert.equal(f.store.pendingMailWatchNotifications('scope-timeout').length, 1, '未知不能被标记为成功')
  assert.equal(f.store.pendingMailWatchNotifications('scope-failed').length, 1, '失败不能被标记为成功')
  f.advance(240_000)
  const retry = (await f.runtime.request('GET', noticePath, null, 'executor')).body as Notices
  assert.deepEqual(retry.deliveries.map(item => item.analysisId), [failed.analysisId], '明确未显示的通知可延后重试')
  assert.ok(retry.attention.some(item => item.analysisId === timeout.analysisId && item.state === 'unknown'), '未知结果不能自动重发')
})

test('已知失败重试时，旧尝试的迟到回执不能结算新尝试', async t => {
  const f = fixture(t)
  const analysis = f.addAnalysis('scope-a', 'account-a', '1')
  const claimPath = `${noticePath}/${analysis.analysisId}/claim`
  const receiptPath = `${noticePath}/${analysis.analysisId}/receipt`
  const first = await f.runtime.request('POST', claimPath, { executorEpoch: 'epoch-1' }, 'executor')
  const firstAttempt = (first.body as { attemptId?: string }).attemptId
  assert.ok(firstAttempt, '每次领取必须有独立的尝试编号')
  assert.equal((await f.runtime.request('POST', receiptPath, {
    executorEpoch: 'epoch-1', attemptId: firstAttempt, state: 'failed-before-effect', evidenceRefs: [],
  }, 'executor')).status, 200)
  f.advance(300_001)
  await f.runtime.request('GET', noticePath, null, 'executor')
  const second = await f.runtime.request('POST', claimPath, { executorEpoch: 'epoch-1' }, 'executor')
  const secondAttempt = (second.body as { attemptId?: string }).attemptId
  assert.ok(secondAttempt)
  assert.notEqual(secondAttempt, firstAttempt)
  assert.equal((await f.runtime.request('POST', receiptPath, {
    executorEpoch: 'epoch-1', attemptId: firstAttempt, state: 'failed-before-effect', evidenceRefs: [],
  }, 'executor')).status, 409, '旧回执不能影响新领取')
  assert.equal((await f.runtime.request('POST', receiptPath, {
    executorEpoch: 'epoch-1', attemptId: secondAttempt, state: 'succeeded',
    evidenceRefs: [`notification:${analysis.analysisId}:${secondAttempt}`],
  }, 'executor')).status, 200)
  assert.equal(f.store.pendingMailWatchNotifications('scope-a').length, 0)
})

test('本人核对未知通知后可以停止提示，但不能伪造送达或重发', async t => {
  const f = fixture(t)
  const analysis = f.addAnalysis('scope-a', 'account-a', '1')
  const claim = await f.runtime.request('POST', `${noticePath}/${analysis.analysisId}/claim`, { executorEpoch: 'epoch-1' }, 'executor')
  const attemptId = (claim.body as { attemptId: string }).attemptId
  f.restart('epoch-2')
  const service = new MemberManagement({ directory: f.store.directory, runtime: { busy: () => false } as never, memories: {} as never,
    enabled: () => false, setMode: async () => {}, defaultModel: () => null, changed: () => {},
    mailNoticeAttention: () => f.store.mailNoticeAttention('account-a', null),
    acknowledgeMailNotice: (id, attempt, state) => f.store.acknowledgeMailNotice(id, 'account-a', attempt, state, 2_000_000) })
  f.runtime.attachMemberManagement(service)
  const path = `/companion/v1/members/mail-notices/${analysis.analysisId}/acknowledge`
  const body = { attemptId, expectedState: 'unknown' }
  assert.equal((await f.runtime.request('POST', path, body, 'client')).status, 403)
  assert.equal(f.store.acknowledgeMailNotice(analysis.analysisId, 'account-b', attemptId, 'unknown', 2_000_000), false,
    '其他账户不能核对这条通知')
  assert.equal((await f.runtime.request('POST', path, { ...body, attemptId: '00000000-0000-4000-8000-000000000000' }, 'owner')).status, 409)
  assert.equal((await f.runtime.request('POST', path, body, 'owner')).status, 200)
  assert.equal(f.store.pendingMailWatchNotifications('scope-a').length, 1, '本人核对不等于系统已送达')
  assert.equal(f.store.pendingMailWatchNotifications('scope-a', 5, true).length, 0, '已核对项不能被旧通知回调重发')
  const view = (await f.runtime.request('GET', noticePath, null, 'executor')).body as Notices
  assert.deepEqual(view.deliveries, [])
  assert.deepEqual(view.attention, [])
  f.restart('epoch-3')
  assert.deepEqual((await f.runtime.request('GET', noticePath, null, 'executor')).body, { deliveries: [], attention: [] })
})

test('本人已核对后，重复的旧未知回执不能改变核对状态', async t => {
  const f = fixture(t)
  const analysis = f.addAnalysis('scope-a', 'account-a', '1')
  const claim = await f.runtime.request('POST', `${noticePath}/${analysis.analysisId}/claim`, { executorEpoch: 'epoch-1' }, 'executor')
  const attemptId = (claim.body as { attemptId: string }).attemptId
  const receipt = { executorEpoch: 'epoch-1', attemptId, state: 'unknown', evidenceRefs: [] }
  assert.equal((await f.runtime.request('POST', `${noticePath}/${analysis.analysisId}/receipt`, receipt, 'executor')).status, 200)
  assert.equal(f.store.acknowledgeMailNotice(analysis.analysisId, 'account-a', attemptId, 'unknown', 2_000_000), true)
  assert.equal((await f.runtime.request('POST', `${noticePath}/${analysis.analysisId}/receipt`, receipt, 'executor')).status, 409)
  assert.equal(f.store.pendingMailWatchNotifications('scope-a').length, 1)
  assert.deepEqual((await f.runtime.request('GET', noticePath, null, 'executor')).body, { deliveries: [], attention: [] })
})

test('关闭并重新打开 SQLite 后，待投递和未知核对状态仍保持真实', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mail-notice-reopen-'))
  let store = new TeamStore(path.join(dir, 'team.sqlite'))
  t.after(() => { try { store.close() } catch { /* 已关闭 */ }; rmSync(dir, { recursive: true, force: true }) })
  const add = (scopeId: string, validity: string) => {
    const scope = store.ensureMailWatchScope({ scopeId, accountKey: 'account-a', folder: 'INBOX',
      uidValidity: validity, bootstrapUpperUid: 1, legacy: null }, 1)
    store.commitMailWatchPage(scope, 1, [1])
    return store.completeMailWatchAnalysis(scopeId, 'mail-member', [{ uid: 1, sourceDigest: 'digest', truncated: false }], '隔离摘要', 2)
  }
  const pending = add('scope-pending', '1')
  const sending = add('scope-sending', '2')
  const attempt = store.claimMailNotice(sending.analysisId, 'account-a', 'mail-member', 'epoch-1', 3)
  assert.ok(attempt)
  store.close()
  store = new TeamStore(path.join(dir, 'team.sqlite'))
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'epoch-2' })
  const runtime = new CompanionTaskRuntime(store, approvals, { epoch: 'epoch-2', now: () => 4,
    activeMailAccount: () => ({ accountKey: 'account-a', memberId: 'mail-member' }) })
  runtime.start()
  try {
    const view = (await runtime.request('GET', noticePath, null, 'executor')).body as Notices
    assert.deepEqual(view.deliveries.map(item => item.analysisId), [pending.analysisId])
    assert.ok(view.attention.some(item => item.analysisId === sending.analysisId && item.state === 'unknown'))
    assert.equal(store.acknowledgeMailNotice(sending.analysisId, 'account-a', attempt, 'unknown', 5), true)
  } finally { await runtime.dispose() }
  store.close()
  store = new TeamStore(path.join(dir, 'team.sqlite'))
  assert.deepEqual(store.pendingMailNotices('account-a', 'mail-member').map(item => item.analysisId), [pending.analysisId])
  assert.deepEqual(store.mailNoticeAttention('account-a', null), [])
  assert.equal(store.pendingMailWatchNotifications('scope-sending').length, 1, '本人核对不会伪造送达')
})

test('从 v11 升级到当前版本时保留邮件通知的在途状态和尝试编号', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mail-notice-v11-'))
  const dbPath = path.join(dir, 'team.sqlite')
  let store = new TeamStore(dbPath)
  t.after(() => { try { store.close() } catch { /* 已关闭 */ }; rmSync(dir, { recursive: true, force: true }) })
  const scope = store.ensureMailWatchScope({ scopeId: 'scope-a', accountKey: 'account-a', folder: 'INBOX',
    uidValidity: '1', bootstrapUpperUid: 1, legacy: null }, 1)
  store.commitMailWatchPage(scope, 1, [1])
  const analysis = store.completeMailWatchAnalysis(scope.scopeId, 'mail-member',
    [{ uid: 1, sourceDigest: 'digest', truncated: false }], '隔离摘要', 2)
  const attempt = store.claimMailNotice(analysis.analysisId, 'account-a', 'mail-member', 'epoch-1', 3)
  assert.ok(attempt)
  store.close()
  const old = new DatabaseSync(dbPath)
  try { old.exec(`DROP TABLE channel_inbound; DROP TABLE mail_send_intents; DELETE FROM migrations WHERE version = ${TEAM_SCHEMA_VERSION}; PRAGMA user_version = 11`) }
  finally { old.close() }
  store = new TeamStore(dbPath)
  store.recoverMailNotices('epoch-2', 0, 4)
  const issue = store.mailNoticeAttention('account-a', null)[0]
  assert.equal(issue.analysisId, analysis.analysisId)
  assert.equal(issue.attemptId, attempt)
  assert.equal(issue.state, 'unknown')
  assert.deepEqual(store.pendingMailNotices('account-a', 'mail-member'), [])
})

test('邮件通知 HTTP 接口只接受桌面执行器凭据及带证据的回执', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-mail-notice-bridge-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const store = new TeamStore(':memory:')
  const bridge = new SessionBridge({ dshHome: home })
  const desktop = new BridgeClient()
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: bridge.epoch })
  const runtime = new CompanionTaskRuntime(store, approvals, { epoch: bridge.epoch,
    activeMailAccount: () => ({ accountKey: 'account-a', memberId: 'mail-member' }) })
  bridge.attachCompanion(runtime, approvals)
  runtime.start()
  try {
    const scope = store.ensureMailWatchScope({ scopeId: 'scope-a', accountKey: 'account-a', folder: 'INBOX',
      uidValidity: '1', bootstrapUpperUid: 1, legacy: null }, 1)
    store.commitMailWatchPage(scope, 1, [1])
    const analysis = store.completeMailWatchAnalysis(scope.scopeId, 'mail-member',
      [{ uid: 1, sourceDigest: 'digest', truncated: false }], '隔离摘要', 2)
    const listening = await bridge.listen()
    const chat = JSON.parse(readFileSync(path.join(home, 'personal-assistant', 'bridge.json'), 'utf8')) as { token: string }
    const credentials = JSON.parse(readFileSync(path.join(home, 'personal-assistant', 'bridge-approval.json'), 'utf8')) as {
      companionOwnerToken: string; companionExecutorToken: string
    }
    const base = `http://127.0.0.1:${listening.port}${noticePath}`
    assert.equal((await fetch(`${base}?token=${encodeURIComponent(chat.token)}`)).status, 403)
    assert.equal((await fetch(base, { headers: { 'x-dsh-companion-token': credentials.companionOwnerToken } })).status, 403)
    const headers = { 'content-type': 'application/json', 'x-dsh-companion-token': credentials.companionExecutorToken }
    const listed = await fetch(base, { headers })
    assert.equal(listed.status, 200)
    assert.deepEqual(((await listed.json()) as Notices).deliveries.map(item => item.analysisId), [analysis.analysisId])
    const post = (action: 'claim' | 'receipt', body: unknown) => fetch(`${base}/${analysis.analysisId}/${action}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    })
    const claimed = await post('claim', { executorEpoch: bridge.epoch })
    assert.equal(claimed.status, 200)
    const attemptId = ((await claimed.json()) as { attemptId: string }).attemptId
    assert.equal((await post('receipt', { executorEpoch: bridge.epoch, attemptId, state: 'succeeded', evidenceRefs: [] })).status, 422)
    assert.equal(store.pendingMailWatchNotifications(scope.scopeId).length, 1)
    assert.equal((await post('receipt', { executorEpoch: bridge.epoch, attemptId, state: 'succeeded',
      evidenceRefs: [`notification:${analysis.analysisId}:${attemptId}`] })).status, 200)
    assert.equal(store.pendingMailWatchNotifications(scope.scopeId).length, 0)

    const anotherScope = store.ensureMailWatchScope({ scopeId: 'scope-a2', accountKey: 'account-a', folder: 'INBOX',
      uidValidity: '2', bootstrapUpperUid: 1, legacy: null }, 3)
    store.commitMailWatchPage(anotherScope, 1, [1])
    const another = store.completeMailWatchAnalysis(anotherScope.scopeId, 'mail-member',
      [{ uid: 1, sourceDigest: 'digest-2', truncated: false }], '跨桥接摘要', 4)
    ;(desktop as unknown as { info: { port: number; token: string; epoch: string } }).info = {
      port: listening.port, token: chat.token, epoch: bridge.epoch,
    }
    const view = await desktop.desktopMailNotices()
    assert.deepEqual(view?.deliveries.map(item => item.analysisId), [another.analysisId])
    assert.equal(view?.deliveries[0].text, '跨桥接摘要')
    const desktopAttempt = await desktop.claimDesktopMailNotice(another.analysisId)
    assert.ok(desktopAttempt)
    assert.equal(await desktop.receiptDesktopMailNotice(another.analysisId, desktopAttempt, 'succeeded'), true)
    assert.equal(store.pendingMailWatchNotifications(anotherScope.scopeId).length, 0)

    const unknownScope = store.ensureMailWatchScope({ scopeId: 'scope-a3', accountKey: 'account-a', folder: 'INBOX',
      uidValidity: '3', bootstrapUpperUid: 1, legacy: null }, 5)
    store.commitMailWatchPage(unknownScope, 1, [1])
    const unknown = store.completeMailWatchAnalysis(unknownScope.scopeId, 'mail-member',
      [{ uid: 1, sourceDigest: 'digest-3', truncated: false }], '待本人核对', 6)
    const unknownAttempt = await desktop.claimDesktopMailNotice(unknown.analysisId)
    assert.ok(unknownAttempt)
    assert.equal(await desktop.receiptDesktopMailNotice(unknown.analysisId, unknownAttempt, 'unknown'), true)
    const members = new MemberManagement({ directory: store.directory, runtime: { busy: () => false } as never, memories: {} as never,
      enabled: () => false, setMode: async () => {}, defaultModel: () => null, changed: () => {},
      mailNoticeAttention: () => store.mailNoticeAttention('account-a', null),
      acknowledgeMailNotice: (id, attempt, state) => store.acknowledgeMailNotice(id, 'account-a', attempt, state, Date.now()) })
    runtime.attachMemberManagement(members)
    const ack = `http://127.0.0.1:${listening.port}/companion/v1/members/mail-notices/${unknown.analysisId}/acknowledge`
    const ackBody = JSON.stringify({ attemptId: unknownAttempt, expectedState: 'unknown' })
    assert.equal((await fetch(`${ack}?token=${encodeURIComponent(chat.token)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: ackBody,
    })).status, 403, '聊天令牌不能替本人核对')
    assert.equal((await fetch(ack, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-dsh-companion-token': credentials.companionExecutorToken }, body: ackBody })).status, 401)
    assert.equal((await fetch(ack, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-dsh-companion-token': credentials.companionOwnerToken }, body: ackBody })).status, 200)
    assert.deepEqual((await desktop.desktopMailNotices())?.attention, [])
    assert.equal(store.pendingMailWatchNotifications(unknownScope.scopeId).length, 1, '本人核对不伪造送达')
  } finally {
    desktop.dispose()
    await runtime.dispose()
    await bridge.dispose()
    store.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
