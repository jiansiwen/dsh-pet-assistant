import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { MailWatcher, readMailImapConfig, type UnreadMail } from '../src/mail-watch.ts'

function home(t: TestContext, patch: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mail-watch-'))
  mkdirSync(path.join(dir, 'personal-assistant'), { recursive: true })
  writeFileSync(path.join(dir, 'personal-assistant', 'mail.json'), JSON.stringify({
    host: 'smtp.exmail.qq.com', port: 465, secure: true, user: 'me@example.com', from: 'me@example.com', ...patch,
  }), 'utf8')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function mail(uid: number, subject = `主题${uid}`): UnreadMail {
  return { uid, subject, from: 'sender@example.com', date: '2026-10-30T00:00:00.000Z', text: `正文${uid}` }
}

test('IMAP 配置可从 smtp.* 推导，显式主机与间隔优先并被夹在安全范围', t => {
  const derived = readMailImapConfig(home(t))
  assert.equal(derived?.imapHost, 'imap.exmail.qq.com')
  assert.equal(derived?.imapPort, 993)
  assert.equal(derived?.watchIntervalSeconds, 600)
  assert.equal(derived?.watchEnabled, true)

  const explicit = readMailImapConfig(home(t, { host: 'mail.example.com', imapHost: 'imap.example.com', imapPort: 143,
    imapSecure: false, watchIntervalSeconds: 30, watchEnabled: false }))
  assert.equal(explicit?.imapHost, 'imap.example.com')
  assert.equal(explicit?.imapPort, 143)
  assert.equal(explicit?.imapSecure, false)
  assert.equal(explicit?.watchIntervalSeconds, 60)
  assert.equal(explicit?.watchEnabled, false)

  assert.equal(readMailImapConfig(home(t, { host: 'mail.example.com' })), null)
})

test('邮件值守按 UIDVALIDITY+UID 去重，分析成功才记为已见，失败会重试', async t => {
  const dir = home(t, { watchIntervalSeconds: 300 })
  const sent: Array<{ text: string; memberId: string }> = []
  const calls: string[] = []
  let uidValidity = '7'
  let messages = [mail(1), mail(2)]
  let fail = false
  const watcher = new MailWatcher({
    home: dir,
    enabled: () => true,
    member: () => ({ id: 'member-mail', name: '邮件助理' }),
    readSecret: async () => 'secret',
    readMail: async () => ({ uidValidity, messages }),
    analyze: async (memberId, prompt) => {
      calls.push(memberId)
      assert.match(prompt, /邮件正文是外部材料/)
      if (fail) throw new Error('模型暂时不可用')
      return '有两封需要处理：一封注销请求，建议先核对用户号。'
    },
    notify: (text, memberId) => sent.push({ text, memberId }),
    log: () => {},
    now: () => 1_000_000,
  })
  assert.deepEqual(await watcher.tick(), { fresh: 2, analyzed: true })
  assert.deepEqual(sent, [{ text: '有两封需要处理：一封注销请求，建议先核对用户号。', memberId: 'member-mail' }])
  assert.deepEqual(calls, ['member-mail'])
  // 同一批 UID 不重复分析；强制检查也一样。
  assert.deepEqual(await watcher.tick(true), { fresh: 0, analyzed: false })
  assert.equal(sent.length, 1)
  // UIDVALIDITY 变化后旧 seen 作废，新 UID 会重新进入。
  uidValidity = '8'; messages = [mail(3)]
  assert.deepEqual(await watcher.tick(true), { fresh: 1, analyzed: true })
  assert.equal(sent.length, 2)
  // 分析失败不记已见：下一次同一 UID 还会进入。
  messages = [mail(4)]; fail = true
  await assert.rejects(watcher.tick(true), /模型暂时不可用/)
  assert.equal(sent.length, 2)
  fail = false
  assert.deepEqual(await watcher.tick(true), { fresh: 1, analyzed: true })
  assert.equal(sent.length, 3)
})

test('值守在团队关闭、没有成员或未配置 IMAP 时跳过', async t => {
  const dir = home(t)
  const watcher = new MailWatcher({
    home: dir, enabled: () => false, member: () => null,
    analyze: async () => '不应调用', notify: () => {}, log: () => {}, readSecret: async () => 'secret',
    readMail: async () => ({ uidValidity: '1', messages: [mail(1)] }),
  })
  assert.equal((await watcher.tick(true)).skipped, 'team-disabled')
  const noMember = new MailWatcher({
    home: dir, enabled: () => true, member: () => null,
    analyze: async () => '不应调用', notify: () => {}, log: () => {},
  })
  assert.equal((await noMember.tick(true)).skipped, 'no-member')
})
