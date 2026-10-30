import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { normalizeDraft, readMailConfig, registerMailTools } from '../src/mail.ts'

test('收件人、主题与正文在提交前被严格校验', () => {
  assert.deepEqual(normalizeDraft({ to: 'a@example.com, b@example.com', subject: '周报', text: '正文' }).to,
    ['a@example.com', 'b@example.com'])
  assert.throws(() => normalizeDraft({ to: '', subject: 'x', text: 'y' }), /收件人/)
  assert.throws(() => normalizeDraft({ to: 'not-a-mail', subject: 'x', text: 'y' }), /格式/)
  assert.equal(normalizeDraft({ to: 'a@example.com', subject: 'x\r\nBcc: evil@example.com', text: 'y' }).subject,
    'x Bcc: evil@example.com', '标题里的换行被折成空格，不能注入额外邮件头')
  assert.throws(() => normalizeDraft({ to: 'a@example.com', subject: 'x', text: ' ' }), /正文/)
})

function fixture(t: TestContext) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-mail-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(path.join(home, 'personal-assistant'), { recursive: true })
  writeFileSync(path.join(home, 'personal-assistant', 'mail.json'), JSON.stringify({
    host: 'smtp.example.com', port: 465, secure: true, user: 'sender@example.com', from: 'sender@example.com',
  }))
  const submissions: Array<Record<string, unknown>> = []
  const bridge = {
    submitAssistant(submission: Record<string, unknown>) {
      submissions.push(submission)
      return { proposalId: 'proposal-1' }
    },
  }
  let definition: { execute(args: unknown): Promise<string> } | null = null
  const host = { tools: { register(value: unknown) { definition = value as typeof definition; return () => undefined } } }
  registerMailTools(host as never, { home, bridge: bridge as never, log: () => undefined })
  return { home, submissions, definition: definition! }
}

test('邮件只提交待本机批准的固定快照，不包含口令', async t => {
  const f = fixture(t)
  assert.deepEqual(readMailConfig(f.home), {
    host: 'smtp.example.com', port: 465, secure: true, user: 'sender@example.com', from: 'sender@example.com',
  })
  const result = JSON.parse(await f.definition.execute({ to: 'owner@example.com', subject: '纪要', text: '完整正文' })) as
    { ok: boolean; pending: boolean; proposalId: string }
  assert.equal(result.ok, true)
  assert.equal(result.pending, true)
  assert.equal(result.proposalId, 'proposal-1')
  const submission = f.submissions[0]!
  assert.equal(submission.subject, 'mail')
  assert.equal(submission.risk, 'high')
  assert.match(String(submission.summary), /审批窗口/)
  const snapshot = JSON.stringify(submission.snapshot)
  assert.match(snapshot, /owner@example\.com/)
  assert.doesNotMatch(snapshot, /password|口令|secret/i)
  assert.equal((submission.validate as () => boolean)(), true)
})

test('未配置邮箱时明确拒绝，不产生待批卡', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-mail-empty-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  let definition: { execute(args: unknown): Promise<string> } | null = null
  const host = { tools: { register(value: unknown) { definition = value as typeof definition; return () => undefined } } }
  registerMailTools(host as never, { home, bridge: { submitAssistant: () => ({ proposalId: 'x' }) } as never, log: () => undefined })
  const result = JSON.parse(await definition!.execute({ to: 'a@example.com', subject: 'x', text: 'y' })) as { ok: boolean; error: string }
  assert.equal(result.ok, false)
  assert.match(result.error, /邮箱还没有配置/)
})
