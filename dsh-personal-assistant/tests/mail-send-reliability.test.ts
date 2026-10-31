import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { AssistantApprovalService, type AssistantSubmission } from '../src/assistant-approval.ts'
import { ApprovalService } from '../src/approval.ts'
import { mailSendAccountKey, mailSendDigest, normalizeDraft, readMailConfig, registerMailTools, type MailDraft } from '../src/mail.ts'
import { MemberManagement } from '../src/member-management.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'
import { TeamStore } from '../src/team-domain.ts'

function fixture(t: TestContext) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-mail-send-'))
  mkdirSync(path.join(home, 'personal-assistant'), { recursive: true })
  writeFileSync(path.join(home, 'personal-assistant', 'mail.json'), JSON.stringify({
    host: 'smtp.example.com', port: 465, secure: true, user: 'sender@example.com', from: 'sender@example.com',
  }))
  const dbPath = path.join(home, 'team.sqlite')
  let store = new TeamStore(dbPath)
  let epoch = 'epoch-1'
  let approval = new AssistantApprovalService({ epoch, ttlMs: 60_000 })
  let secretFails = false
  let sender = async (draft: MailDraft) => ({ messageId: '测试邮件编号', accepted: draft.to, rejected: [] as string[] })
  const sent: MailDraft[] = []
  let definition: { execute(args: unknown): Promise<string> }
  const mount = () => {
    const host = { tools: { register(value: unknown) { definition = value as typeof definition; return () => {} } } }
    registerMailTools(host as never, { home, store, epoch, bridge: { submitAssistant: (submission: AssistantSubmission) => approval.submit(submission) } as never,
      log: () => {}, readSecret: async () => { if (secretFails) throw new Error('模拟凭据不可用'); return 'fake-secret' },
      send: async (_config, _secret, draft) => { sent.push(draft); return sender(draft) } })
  }
  mount()
  t.after(() => { try { store.close() } catch { /* 已关闭 */ }; rmSync(home, { recursive: true, force: true }) })
  const request = async (draft: { to: string; subject: string; text: string }) => JSON.parse(await definition.execute(draft)) as {
    ok: boolean; pending?: boolean; proposalId?: string; intentId?: string; error?: string; message?: string
  }
  const decide = (proposalId: string, decision: 'approve' | 'reject' = 'approve') =>
    approval.decide(proposalId, decision, epoch, approval.approvalCapabilityToken)
  const restart = () => {
    store.close()
    store = new TeamStore(dbPath)
    epoch = 'epoch-2'
    approval = new AssistantApprovalService({ epoch, ttlMs: 60_000 })
    mount()
  }
  return { home, sent, request, decide, restart, get store() { return store },
    setSender: (value: typeof sender) => { sender = value }, setSecretFails: (value: boolean) => { secretFails = value },
    acknowledgeApproval: (id: string) => approval.acknowledgeUnknown('mail', id),
    approvalRunning: (id: string) => approval.isIntentRunning('mail', id), pending: () => approval.pendingProposals() }
}

const draft = { to: 'a@example.com, b@example.com', subject: '隔离会议纪要', text: '仅用于测试的正文' }

test('SMTP 结果未知跨重启保留，同一邮件不能盲目重复发送', async t => {
  const f = fixture(t)
  f.setSender(async () => { throw new Error('模拟服务器接受后连接断开') })
  const submitted = await f.request(draft)
  assert.equal(submitted.pending, true)
  assert.ok(submitted.proposalId && submitted.intentId)
  const outcome = await f.decide(submitted.proposalId)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.state, 'unknown')
  assert.equal(f.sent.length, 1)
  assert.equal(f.store.getMailSendIntent(submitted.intentId)?.state, 'unknown')
  f.restart()
  const repeated = await f.request(draft)
  assert.equal(repeated.ok, false)
  assert.match(repeated.error ?? '', /核查|未知/u)
  const reordered = await f.request({ ...draft, to: 'b@EXAMPLE.com, a@EXAMPLE.COM' })
  assert.equal(reordered.ok, false, '收件人顺序和域名大小写变化不能绕过未核查状态')
  assert.equal(f.sent.length, 1, '未确认前不能再次调用发送器')
})

test('会议纪要发送结果未核查时，普通邮件另拟正文或主题也必须在审批中提示重复风险', async t => {
  const f = fixture(t)
  const config = readMailConfig(f.home)!
  const normalized = normalizeDraft(draft)
  const accountKey = mailSendAccountKey(config)
  assert.equal(f.store.beginMailSend({ intentId: 'meeting-unknown', accountKey, digest: mailSendDigest(config, normalized),
    subject: normalized.subject, recipients: normalized.to, epoch: 'epoch-1' }, Date.now()), true)
  f.store.insertMeetingMailFollowup({ intentId: 'meeting-unknown', artifactId: 'artifact', meetingId: 'meeting', revision: 1,
    recipientRef: 'wecom:single:主人', channelAccountKey: 'a'.repeat(64), repeatEverySeconds: 60, approvalId: 'approved', createdAt: Date.now() })
  assert.equal(f.store.finishMailSend('meeting-unknown', 'epoch-1', 'unknown', {}, Date.now()), true)
  f.restart()
  const pending = await f.request({ ...draft, subject: '新主题' })
  assert.equal(pending.pending, true)
  assert.match(f.pending()[0]?.content ?? '', /会议.*未核查.*可能重复/u)
  assert.equal(f.sent.length, 0)
})

test('发送中崩溃重启后按未知处理，不重复投递或伪造回执', async t => {
  const f = fixture(t)
  const submitted = await f.request(draft)
  assert.ok(submitted.intentId)
  const config = readMailConfig(f.home)!
  const normalized = normalizeDraft(draft)
  assert.equal(f.store.beginMailSend({ intentId: submitted.intentId, accountKey: mailSendAccountKey(config),
    digest: mailSendDigest(config, normalized), subject: normalized.subject, recipients: normalized.to, epoch: 'epoch-1' }, Date.now()), true)
  f.restart()
  const saved = f.store.getMailSendIntent(submitted.intentId)
  assert.equal(saved?.state, 'unknown')
  assert.equal(saved?.acceptedAt, null)
  assert.equal((await f.request(draft)).ok, false)
  assert.equal(f.sent.length, 0, '模拟崩溃前后都没有实际调用发送器')
})

test('本人核对后才能重新提交，同内容的新审批明确提示可能重复', async t => {
  const f = fixture(t)
  f.setSender(async () => { throw new Error('模拟结果不明') })
  const submitted = await f.request(draft)
  assert.ok(submitted.proposalId && submitted.intentId)
  assert.equal((await f.decide(submitted.proposalId)).state, 'unknown')
  const saved = f.store.getMailSendIntent(submitted.intentId)!
  assert.equal(f.store.acknowledgeMailSend(submitted.intentId, '其他账户', 'unknown', Date.now()), false)
  assert.equal(f.store.acknowledgeMailSend(submitted.intentId, saved.accountKey, 'partial', Date.now()), false)
  assert.equal(f.store.acknowledgeMailSend(submitted.intentId, saved.accountKey, 'unknown', Date.now()), true)
  assert.equal(f.acknowledgeApproval('其他意图'), false)
  assert.equal(f.acknowledgeApproval(submitted.intentId), true)
  const again = await f.request(draft)
  assert.equal(again.pending, true)
  assert.match(f.pending()[0]?.content ?? '', /再次发送可能重复/u)
  assert.equal(f.sent.length, 1, '重新提交只生成审批，不得直接发送')
})

test('本人核对后迟到的旧发送回执不能覆盖核对结果', async t => {
  const f = fixture(t)
  const submitted = await f.request(draft)
  assert.ok(submitted.intentId)
  const config = readMailConfig(f.home)!
  const normalized = normalizeDraft(draft)
  const accountKey = mailSendAccountKey(config)
  assert.equal(f.store.beginMailSend({ intentId: submitted.intentId, accountKey, digest: mailSendDigest(config, normalized),
    subject: normalized.subject, recipients: normalized.to, epoch: 'epoch-1' }, Date.now()), true)
  f.restart()
  assert.equal(f.store.acknowledgeMailSend(submitted.intentId, accountKey, 'unknown', Date.now()), true)
  assert.equal(f.store.finishMailSend(submitted.intentId, 'epoch-1', 'accepted', {
    messageId: '迟到回执', accepted: normalized.to, rejected: [],
  }, Date.now()), false)
  const saved = f.store.getMailSendIntent(submitted.intentId)
  assert.equal(saved?.state, 'acknowledged')
  assert.equal(saved?.acceptedAt, null)
})

test('本进程仍在发送时不能提前核对未知状态并放行新发送', async t => {
  const f = fixture(t)
  let resolve!: (value: { messageId: string; accepted: string[]; rejected: string[] }) => void
  f.setSender(() => new Promise(done => { resolve = done }))
  const submitted = await f.request(draft)
  assert.ok(submitted.proposalId && submitted.intentId)
  const deciding = f.decide(submitted.proposalId)
  await new Promise<void>(done => setImmediate(done))
  assert.equal(f.sent.length, 1)
  f.store.recoverMailSends('epoch-1', Date.now() + 1, Date.now())
  assert.equal(f.store.getMailSendIntent(submitted.intentId)?.state, 'unknown')
  assert.equal(f.approvalRunning(submitted.intentId), true)
  const saved = f.store.getMailSendIntent(submitted.intentId)!
  const service = new MemberManagement({ directory: f.store.directory, runtime: { busy: () => false } as never, memories: {} as never,
    enabled: () => false, setMode: async () => {}, defaultModel: () => null, changed: () => {},
    acknowledgeMailSend: (id, state) => !f.approvalRunning(id) && f.store.acknowledgeMailSend(id, saved.accountKey, state, Date.now()) })
  assert.equal((await service.request('POST', `/companion/v1/members/mail-sends/${submitted.intentId}/acknowledge`, { expectedState: 'unknown' })).status, 409)
  assert.equal((await f.request(draft)).ok, false)
  resolve({ messageId: '测试编号', accepted: ['a@example.com', 'b@example.com'], rejected: [] })
  assert.equal((await deciding).ok, true)
  assert.equal(f.store.getMailSendIntent(submitted.intentId)?.state, 'accepted')
})

test('发送结果只能由本人核对，核对不伪造送达也不立即重发', async t => {
  const f = fixture(t)
  f.setSender(async () => { throw new Error('模拟结果不明') })
  const submitted = await f.request(draft)
  assert.ok(submitted.proposalId && submitted.intentId)
  assert.equal((await f.decide(submitted.proposalId)).state, 'unknown')
  const saved = f.store.getMailSendIntent(submitted.intentId)!
  const service = new MemberManagement({ directory: f.store.directory, runtime: { busy: () => false } as never, memories: {} as never,
    enabled: () => false, setMode: async () => {}, defaultModel: () => null, changed: () => {},
    mailSendAttention: () => f.store.mailSendAttention(saved.accountKey).map(item => ({
      intentId: item.intentId, subject: item.subject, recipients: item.recipients,
      state: item.state as 'sending' | 'partial' | 'unknown', accepted: item.accepted, rejected: item.rejected, messageId: item.messageId,
    })),
    acknowledgeMailSend: (id, state) => {
      const ok = f.store.acknowledgeMailSend(id, saved.accountKey, state, Date.now())
      if (ok) f.acknowledgeApproval(id)
      return ok
    } })
  const approvals = new ApprovalService(f.store, { ttlMs: 60_000, runtimeEpoch: 'management' })
  const runtime = new CompanionTaskRuntime(f.store, approvals, { epoch: 'management' })
  runtime.attachMemberManagement(service)
  try {
    const root = '/companion/v1/members'
    assert.equal((await runtime.request('GET', root, null, 'client')).status, 403)
    const snapshot = await runtime.request('GET', root, null, 'owner')
    assert.equal((snapshot.body as { mailSendAttention: Array<{ intentId: string }> }).mailSendAttention[0].intentId, submitted.intentId)
    const path = `${root}/mail-sends/${submitted.intentId}/acknowledge`
    assert.equal((await runtime.request('POST', path, { expectedState: 'unknown' }, 'client')).status, 403)
    assert.equal((await runtime.request('POST', path, { expectedState: 'partial' }, 'owner')).status, 409)
    assert.equal((await runtime.request('POST', path, { expectedState: 'unknown' }, 'owner')).status, 200)
    const reviewed = f.store.getMailSendIntent(submitted.intentId)!
    assert.equal(reviewed.state, 'acknowledged')
    assert.equal(reviewed.resolutionOf, 'unknown')
    assert.equal(reviewed.acceptedAt, null, '核对不代表服务已接受')
    assert.equal(f.sent.length, 1)
    const again = await f.request(draft)
    assert.equal(again.pending, true)
    assert.match(f.pending()[0]?.content ?? '', /再次发送可能重复/u)
    assert.equal(f.sent.length, 1, '重新提交只生成审批')
  } finally { await runtime.dispose() }
})

test('部分收件人被接受时保存明细，不冒充全部发送成功', async t => {
  const f = fixture(t)
  f.setSender(async () => ({ messageId: '测试编号', accepted: ['a@example.com'], rejected: ['b@example.com'] }))
  const submitted = await f.request(draft)
  assert.ok(submitted.proposalId && submitted.intentId)
  const outcome = await f.decide(submitted.proposalId)
  assert.equal(outcome.ok, false)
  const saved = f.store.getMailSendIntent(submitted.intentId)
  assert.equal(saved?.state, 'partial')
  assert.deepEqual(saved?.accepted, ['a@example.com'])
  assert.deepEqual(saved?.rejected, ['b@example.com'])
  assert.equal((await f.request(draft)).ok, false)
  assert.equal(f.sent.length, 1)
})

test('服务明确接受后保存回执与时间，重复批准不能再次发送', async t => {
  const f = fixture(t)
  const submitted = await f.request(draft)
  assert.ok(submitted.proposalId && submitted.intentId)
  const outcome = await f.decide(submitted.proposalId)
  assert.equal(outcome.ok, true)
  assert.equal(f.sent.length, 1)
  assert.equal((await f.decide(submitted.proposalId)).ok, false)
  f.restart()
  const saved = f.store.getMailSendIntent(submitted.intentId)
  assert.equal(saved?.state, 'accepted')
  assert.deepEqual(saved?.accepted, ['a@example.com', 'b@example.com'])
  assert.ok(typeof saved?.acceptedAt === 'number' && saved.acceptedAt > 0)
  assert.equal(saved?.messageId, '测试邮件编号')
  assert.equal(f.sent.length, 1)
  for (const file of ['team.sqlite', 'team.sqlite-wal']) {
    const target = path.join(f.home, file)
    if (!existsSync(target)) continue
    const bytes = readFileSync(target)
    assert.equal(bytes.includes(Buffer.from(draft.text)), false, '发送正文不持久写入账本')
    assert.equal(bytes.includes(Buffer.from('fake-secret')), false, '口令不写入账本')
  }
})

test('收件地址本地部分大小写不一致时不能冒充全部接受', async t => {
  const f = fixture(t)
  f.setSender(async () => ({ messageId: '测试编号', accepted: ['a@example.com'], rejected: [] }))
  const submitted = await f.request({ to: 'A@example.com', subject: '隔离测试', text: '正文' })
  assert.ok(submitted.proposalId && submitted.intentId)
  const outcome = await f.decide(submitted.proposalId)
  assert.equal(outcome.ok, false)
  assert.equal(f.store.getMailSendIntent(submitted.intentId)?.state, 'partial')
})

test('服务回执缺少收件人列表时保留未知，不能冒充发送成功', async t => {
  const f = fixture(t)
  f.setSender(async () => ({ messageId: '测试编号', accepted: null, rejected: [] }) as never)
  const submitted = await f.request(draft)
  assert.ok(submitted.proposalId && submitted.intentId)
  assert.equal((await f.decide(submitted.proposalId)).state, 'unknown')
  assert.equal(f.store.getMailSendIntent(submitted.intentId)?.state, 'unknown')
  assert.equal((await f.request(draft)).ok, false)
})

test('凭据读取失败时不创建发送中记录，也不调用 SMTP', async t => {
  const f = fixture(t)
  f.setSecretFails(true)
  const submitted = await f.request(draft)
  assert.ok(submitted.proposalId && submitted.intentId)
  const outcome = await f.decide(submitted.proposalId)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.state, 'failed', '凭据阶段未触发外部效果，不应永久卡在未知')
  assert.equal(f.sent.length, 0)
  assert.equal(f.store.getMailSendIntent(submitted.intentId), null)
  f.setSecretFails(false)
  assert.equal((await f.request(draft)).pending, true, '修好凭据后应允许重新申请本人审批')
})

test('发送账本写入失败时不触发 SMTP，恢复后可重新审批', async t => {
  const f = fixture(t)
  const original = f.store.beginMailSend.bind(f.store)
  f.store.beginMailSend = () => { throw new Error('模拟磁盘不可用') }
  const submitted = await f.request(draft)
  assert.ok(submitted.proposalId && submitted.intentId)
  const result = await f.decide(submitted.proposalId)
  assert.equal(result.state, 'failed')
  assert.equal(f.sent.length, 0)
  assert.equal(f.store.getMailSendIntent(submitted.intentId), null)
  f.store.beginMailSend = original
  assert.equal((await f.request(draft)).pending, true)
})
