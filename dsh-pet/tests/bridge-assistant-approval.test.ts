import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BridgeClient } from '../src/main/harness.ts'

test('助理审批凭据隔离、专属路由与代次校验', async t => {
  const base = tmpdir()
  mkdirSync(base, { recursive: true })
  const home = mkdtempSync(path.join(base, 'verify-assistant-approval-credentials-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  mkdirSync(path.join(home, 'personal-assistant'))
  const credential = path.join(home, 'personal-assistant/bridge-approval.json')
  const put = (value: Record<string, unknown>) => writeFileSync(credential, JSON.stringify({ port: 12345, ...value }))
  const client = new BridgeClient()
  ;(client as unknown as { info: unknown }).info = { port: 12345, token: '虚构聊天令牌', epoch: '本代次' }
  const calls: { url: string; init?: RequestInit }[] = []
  let responseBody: unknown = { ok: true }
  const timeouts: number[] = []
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return originalTimeout(ms) })
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(responseBody))
  })
  const decide = (epoch = '本代次') => client.decideApproval('虚构提案', 'approve', 42, 'assistant', epoch)
  await t.test('缺凭据及聊天、团队、日报令牌均不能替代助理凭据，零请求', async () => {
    assert.equal((await decide()).ok, false)
    for (const tokens of [{ token: '聊天' }, { approvalToken: '团队' }, { reportApprovalToken: '日报' }, { approvalToken: '团队', reportApprovalToken: '日报', token: '聊天' }]) {
      put({ ...tokens, epoch: '本代次' })
      assert.equal((await decide()).ok, false)
    }
    assert.equal(calls.length, 0)
  })
  await t.test('凭据代次及卡片代次不符均拒绝，零请求', async () => {
    put({ assistantApprovalToken: 'assistant-test-token', epoch: '旧代次' })
    assert.equal((await decide()).ok, false)
    put({ assistantApprovalToken: 'assistant-test-token', epoch: '本代次' })
    assert.equal((await decide('旧卡片')).ok, false)
    put({ assistantApprovalToken: 'assistant-test-token' })
    assert.equal((await decide()).ok, false)
    assert.equal(calls.length, 0)
  })
  await t.test('凭据端口不符不能发往其他运行时', async () => {
    put({ assistantApprovalToken: 'assistant-test-token', epoch: '本代次', port: 12346 })
    assert.equal((await decide()).ok, false)
    assert.equal(calls.length, 0)
  })
  await t.test('正确凭据只走助理专属路由且不发送正文', async () => {
    put({ assistantApprovalToken: 'assistant-test-token', reportApprovalToken: '日报', approvalToken: '团队', epoch: '本代次' })
    assert.equal((await decide()).ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://127.0.0.1:12345/assistant-approval')
    assert.equal(calls[0].init?.method, 'POST')
    assert.equal(new Headers(calls[0].init?.headers).get('x-dsh-approval-token'), 'assistant-test-token')
    const body = JSON.parse(String(calls[0].init?.body))
    assert.equal(body.proposalId, '虚构提案')
    assert.equal(body.decision, 'approve')
    assert.equal(body.epoch, '本代次')
    assert.equal('content' in body, false)
    assert.equal('target' in body, false)
  })
  await t.test('会议邮件服务接受后保留提醒状态；等待发信不被十秒超时截断', async () => {
    responseBody = { ok: true, confirmed: true, result: { intentId: 'mail-1', acceptedAt: 1_800_000_000_000,
      followup: { state: 'pending', message: '提醒暂未登记' } } }
    const result = await decide()
    assert.deepEqual(result.meetingMail, { state: 'pending', intentId: 'mail-1', acceptedAt: 1_800_000_000_000 })
    assert.ok((timeouts.at(-1) ?? 0) >= 120_000)
    responseBody = { ok: true, confirmed: true, result: { intentId: 'mail-1', acceptedAt: 1_800_000_000_000,
      followup: { state: 'scheduled', taskId: 'task-1', runAt: '2027-01-15T08:02:00.000Z' } } }
    assert.equal((await decide()).meetingMail?.state, 'scheduled')
    responseBody = { ok: true, confirmed: true, result: { intentId: 'mail-1', acceptedAt: 1_800_000_000_000,
      followup: { state: 'scheduled', taskId: 'task-1', runAt: '2027-01-15T08:03:00.000Z' } } }
    assert.equal((await decide()).meetingMail, undefined, '提醒锚点不一致不能冒充已登记')
  })
})
