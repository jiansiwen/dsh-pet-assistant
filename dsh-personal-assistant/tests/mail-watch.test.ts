import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
// 必须与生产代码一样走 import 的 dist/esm 入口；require('imapflow') 是另一份 CJS 原型。
import { ImapFlow, type FetchQueryObject, type MessageStructureObject } from 'imapflow'
import { MailWatcher, MAIL_WATCH_LIMITS, mailWatchAccountKey, mailWatchScopeId, readMailImapConfig, readUnreadMail,
  type MailWatcherOptions } from '../src/mail-watch.ts'
import { MemberRuntime } from '../src/member-runtime.ts'
import { TeamStore } from '../src/team-domain.ts'

function home(t: TestContext, patch: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mail-watch-'))
  mkdirSync(path.join(dir, 'personal-assistant'), { recursive: true })
  writeFileSync(path.join(dir, 'personal-assistant', 'mail.json'), JSON.stringify({
    host: 'smtp.exmail.qq.com', port: 465, secure: true, user: 'me@example.com', from: 'me@example.com', ...patch,
  }), 'utf8')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

interface FakeMessage { seen: boolean; body: Buffer; structure?: MessageStructureObject }
function fakeInbox(t: TestContext, count: number) {
  const server = {
    uidValidity: 7, uidNext: count + 1,
    messages: new Map<number, FakeMessage>(),
    searches: [] as { from: number; to: number; unreadOnly: boolean }[],
    fetches: [] as { uid: number; query: FetchQueryObject }[],
    failUids: new Set<number>(), failPageFrom: 0, badPage: false, badBody: false,
    afterSearch: null as (() => void) | null,
    afterFetch: null as (() => void) | null,
    connections: 0, releases: 0, logouts: 0,
  }
  for (let uid = 1; uid <= count; uid++) server.messages.set(uid, { seen: false, body: Buffer.from(`正文${uid}`) })
  t.mock.method(ImapFlow.prototype, 'connect', async function(this: ImapFlow) {
    server.connections++
    this.mailbox = { path: 'INBOX', uidValidity: BigInt(server.uidValidity), uidNext: server.uidNext, exists: server.messages.size } as never
  })
  t.mock.method(ImapFlow.prototype, 'getMailboxLock', async (folder, options) => {
    assert.equal(folder, 'INBOX'); assert.equal(options.readOnly, true)
    return { release: () => { server.releases++ } }
  })
  t.mock.method(ImapFlow.prototype, 'logout', async () => { server.logouts++ })
  t.mock.method(ImapFlow.prototype, 'status', async (folder, query) => {
    assert.equal(folder, 'INBOX'); assert.equal(query.uidValidity, true)
    return { uidValidity: BigInt(server.uidValidity) }
  })
  t.mock.method(ImapFlow.prototype, 'search', async (query, options) => {
    assert.equal(options.uid, true)
    assert.match(query.uid, /^\d+:\d+$/)
    const [from, to] = query.uid.split(':').map(Number)
    assert.ok(to >= from && to - from < MAIL_WATCH_LIMITS.uidPageSize)
    server.searches.push({ from, to, unreadOnly: query.seen === false })
    if (server.failPageFrom === from) throw new Error('模拟页响应失败')
    if (server.badPage) return false
    const result = [...server.messages].filter(([uid, mail]) => uid >= from && uid <= to && (query.seen !== false || !mail.seen)).map(([uid]) => uid)
    server.afterSearch?.()
    return result
  })
  t.mock.method(ImapFlow.prototype, 'fetchOne', async (uid, query, options) => {
    assert.equal(options.uid, true)
    assert.equal(typeof uid, 'number')
    assert.equal(query.source, undefined, '不能拉取含附件的完整邮件')
    server.fetches.push({ uid, query })
    if (server.failUids.has(uid)) throw new Error('模拟正文抓取失败')
    const mail = server.messages.get(uid)
    if (!mail) return false
    if (query.bodyStructure) return { uid, seq: uid,
      envelope: { subject: `主题${uid}`, from: [{ name: '发件人', address: 'sender@example.com' }], date: new Date('2026-10-30T00:00:00Z') },
      bodyStructure: mail.structure ?? { part: '1', type: 'text/plain', encoding: '8bit', parameters: { charset: 'utf-8' }, size: mail.body.length } }
    assert.equal(query.bodyParts.length, 1)
    const part = query.bodyParts[0]
    assert.ok(part.key === '1' || part.key === 'TEXT', '仅下载正文，不下载附件片段')
    assert.equal(part.start, 0)
    assert.equal(part.maxLength, MAIL_WATCH_LIMITS.bodyBytes)
    server.afterFetch?.()
    return { uid, seq: uid, bodyParts: new Map(server.badBody ? [] : [[part.key, mail.body.subarray(0, part.maxLength)]]) }
  })
  return server
}

function fixture(t: TestContext, count = 6) {
  let store: TeamStore
  // Windows 必须先释放 SQLite 文件句柄，再执行 home 注册的目录清理。
  t.after(() => store?.close())
  const dir = home(t)
  const dbPath = path.join(dir, 'personal-assistant', 'team.sqlite')
  store = new TeamStore(dbPath)
  const server = fakeInbox(t, count)
  const prompts: string[] = []
  const notices: string[] = []
  const logs: string[] = []
  let clock = 1_000_000
  const base = (): MailWatcherOptions => ({ home: dir, store, enabled: () => true,
    member: () => ({ id: 'member-mail', name: '邮件助理' }), readSecret: async () => 'fake-secret',
    analyze: async (_id, prompt) => { prompts.push(prompt); return '需要核对后处理。' },
    notify: async text => { notices.push(text); return true }, log: text => { logs.push(text) }, now: () => ++clock })
  return { dir, dbPath, server, prompts, notices, logs,
    get store() { return store },
    scopeId: () => mailWatchScopeId(mailWatchAccountKey(readMailImapConfig(dir)!), String(server.uidValidity)),
    watcher: (patch: Partial<MailWatcherOptions> = {}) => new MailWatcher({ ...base(), ...patch }),
    reopen: () => { store.close(); store = new TeamStore(dbPath) },
    patchConfig: (patch: Record<string, unknown>) => {
      const file = path.join(dir, 'personal-assistant', 'mail.json')
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch }))
    },
    analyzedUids: () => prompts.flatMap(prompt => [...prompt.matchAll(/\/ UID (\d+)】/g)].map(match => Number(match[1]))),
  }
}

function sparseFixture(t: TestContext) {
  const f = fixture(t, 0)
  f.server.messages.set(1, { seen: false, body: Buffer.from('旧正文') })
  f.server.messages.set(10_000, { seen: false, body: Buffer.from('稀疏历史') })
  f.server.uidNext = 10_001
  return f
}

test('IMAP 配置从 smtp.* 推导，显式主机与间隔优先并限制范围', t => {
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

test('真实 ESM ImapFlow 入口被隔离：6 封未读分两轮全分析，不再永远遗漏第 1 封', async t => {
  const f = fixture(t)
  const watcher = f.watcher()
  assert.deepEqual(await watcher.tick(), { fresh: 5, analyzed: true })
  assert.deepEqual(await watcher.tick(true), { fresh: 1, analyzed: true })
  assert.deepEqual(await watcher.tick(true), { fresh: 0, analyzed: false })
  assert.deepEqual(f.analyzedUids(), [1, 2, 3, 4, 5, 6])
  assert.equal(f.server.searches.length, 1)
  assert.match(f.prompts[0], /邮件正文是外部材料/)
  assert.equal(f.notices.length, 2)
  assert.ok([...f.server.messages.values()].every(mail => !mail.seen))
  assert.equal(f.server.connections, f.server.logouts)
  assert.equal(f.server.connections, f.server.releases)
})

test('50 封以两页 UID 区间登记，每轮最多 5 封且不重复扫描全邮箱', async t => {
  const f = fixture(t, 50)
  const watcher = f.watcher()
  for (let round = 0; round < 10; round++) {
    const before = f.server.fetches.length
    assert.equal((await watcher.tick(true)).fresh, 5)
    assert.ok((f.server.fetches.length - before) * MAIL_WATCH_LIMITS.responseBytes <= MAIL_WATCH_LIMITS.fetchBytes)
  }
  assert.deepEqual(f.server.searches, [{ from: 1, to: 25, unreadOnly: true }, { from: 26, to: 50, unreadOnly: true }])
  assert.deepEqual(f.analyzedUids(), Array.from({ length: 50 }, (_, index) => index + 1))
  assert.equal(f.store.listMailWatchMessages(f.scopeId(), 'pending', 100).length, 0)
})

test('首启排除历史已读；登记后已读变化不影响重试，之后新增的已读邮件也处理', async t => {
  const f = fixture(t, 6)
  f.server.messages.get(1)!.seen = true
  let fail = true
  const watcher = f.watcher({ analyze: async (_id, prompt) => {
    if (fail) throw new Error('软额度不足')
    f.prompts.push(prompt); return '分析完成'
  } })
  await assert.rejects(watcher.tick(true), /软额度不足/)
  assert.equal(f.store.listMailWatchMessages(f.scopeId(), 'pending', 10).length, 5)
  for (const mail of f.server.messages.values()) mail.seen = true
  fail = false
  assert.equal((await watcher.tick(true)).fresh, 5)
  f.server.messages.set(7, { seen: true, body: Buffer.from('新到后已读') }); f.server.uidNext = 8
  assert.equal((await watcher.tick(true)).fresh, 1)
  assert.deepEqual(f.analyzedUids(), [2, 3, 4, 5, 6, 7])
  assert.deepEqual(f.server.searches.at(-1), { from: 7, to: 7, unreadOnly: false })
})

test('待处理和成功分析跨重启保存，不重跑已完成记录，force 不绕过注入的软额度门禁', async t => {
  const f = fixture(t, 2)
  let blocked = true
  let physicalRequests = 0
  const analyze = async () => {
    if (blocked) throw new Error('额度账本停线：请求结果未知')
    physicalRequests++; return '已恢复的结果'
  }
  await assert.rejects(f.watcher({ analyze }).tick(true), /请求结果未知/)
  f.reopen()
  await assert.rejects(f.watcher({ analyze }).tick(true), /请求结果未知/)
  assert.equal(physicalRequests, 0)
  assert.equal(f.store.listMailWatchMessages(f.scopeId(), 'pending').length, 2)
  blocked = false
  await f.watcher({ analyze }).tick(true)
  f.reopen()
  await f.watcher({ analyze }).tick(true)
  assert.equal(physicalRequests, 1)
  assert.equal(f.store.listMailWatchMessages(f.scopeId(), 'analyzed').length, 2)
  assert.equal(f.notices.length, 1)
})

test('超过 500 封仍永久去重，重启不遗忘早期 UID', async t => {
  const f = fixture(t, 505)
  const watcher = f.watcher()
  for (let i = 0; i < 101; i++) await watcher.tick(true)
  assert.equal(new Set(f.analyzedUids()).size, 505)
  assert.equal(f.analyzedUids().length, 505)
  f.reopen()
  assert.deepEqual(await f.watcher().tick(true), { fresh: 0, analyzed: false })
  assert.equal(f.store.listMailWatchMessages(f.scopeId(), 'analyzed', 600).length, 505)
})

test('P1-04 稀疏历史和待分析积压时，新信在下一次健康轮询进入分析', async t => {
  const f = fixture(t, 0)
  for (let uid = 1; uid <= 50; uid++) f.server.messages.set(uid, { seen: false, body: Buffer.from(`旧正文${uid}`) })
  f.server.messages.set(10_000, { seen: false, body: Buffer.from('稀疏历史') })
  f.server.uidNext = 10_001
  let now = 1_000_000
  const watcher = f.watcher({ now: () => now })
  assert.deepEqual(await watcher.tick(), { fresh: 5, analyzed: true })
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scannedUid, 50)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scanUpperUid, 10_000)
  assert.equal(f.store.listMailWatchMessages(f.scopeId(), 'pending', 100).length, 45)

  f.server.messages.set(10_001, { seen: true, body: Buffer.from('新信到达后已读') })
  f.server.uidNext = 10_002
  assert.equal((await watcher.tick()).skipped, 'interval')
  now += 600_001
  const searches = f.server.searches.length
  const fetches = f.server.fetches.length
  const before = f.analyzedUids().length
  assert.equal((await watcher.tick()).analyzed, true)
  const analyzed = f.analyzedUids().slice(before)
  assert.ok(analyzed.includes(10_001), '新信不仅登记，还要交给模拟分析器')
  assert.ok(analyzed.some(uid => uid >= 6 && uid <= 50), '旧待办仍有分析机会')
  assert.ok(analyzed.length <= MAIL_WATCH_LIMITS.maxMessages)
  assert.ok(f.server.searches.length - searches <= MAIL_WATCH_LIMITS.maxPages)
  assert.ok((f.server.fetches.length - fetches) * MAIL_WATCH_LIMITS.responseBytes <= MAIL_WATCH_LIMITS.fetchBytes)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scanUpperUid, 10_000)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scannedUid, 75, '尾部登记不能越过未查历史')
  assert.ok(f.store.listMailWatchMessages(f.scopeId(), 'analyzed', 100).some(item => item.uid === 10_001))
  assert.equal(f.server.messages.get(10_001)?.seen, true)
})

test('P1-04 持续新信与旧待办公平分析，坏信轮换且恢复后仍可处理', async t => {
  const f = fixture(t, 50)
  f.server.failUids.add(1)
  const watcher = f.watcher()
  await watcher.tick(true)
  assert.deepEqual(f.analyzedUids(), [2, 3, 4, 5])

  for (let uid = 51; uid <= 56; uid++) {
    f.server.messages.set(uid, { seen: true, body: Buffer.from(`新正文${uid}`) })
    f.server.uidNext = uid + 1
    const before = f.analyzedUids().length
    const searches = f.server.searches.length
    const fetches = f.server.fetches.length
    await watcher.tick(true)
    const analyzed = f.analyzedUids().slice(before)
    assert.ok(analyzed.includes(uid), `新信 ${uid} 应在健康轮询中进入分析`)
    assert.ok(analyzed.some(old => old > 1 && old <= 50), '旧待办不能被持续新信挤掉')
    assert.ok(analyzed.length <= MAIL_WATCH_LIMITS.maxMessages)
    assert.ok(f.server.searches.length - searches <= MAIL_WATCH_LIMITS.maxPages)
    assert.ok((f.server.fetches.length - fetches) * MAIL_WATCH_LIMITS.responseBytes <= MAIL_WATCH_LIMITS.fetchBytes)
  }
  assert.ok(f.store.listMailWatchMessages(f.scopeId(), 'pending', 100).some(item => item.uid === 1))
  f.server.failUids.delete(1)
  for (let round = 0; round < 20 && !f.analyzedUids().includes(1); round++) await watcher.tick(true)
  assert.ok(f.analyzedUids().includes(1), '坏信恢复后仍能轮到')
  assert.equal(new Set(f.analyzedUids()).size, f.analyzedUids().length)
})

test('尾页之外的新增缺口仍由固定上界顺序补齐，重查不会重复消费', async t => {
  const f = fixture(t, 0)
  f.server.messages.set(1, { seen: false, body: Buffer.from('历史未读') })
  f.server.messages.set(61, { seen: true, body: Buffer.from('历史已读') })
  f.server.messages.set(70, { seen: false, body: Buffer.from('历史末尾未读') })
  f.server.uidNext = 71
  const watcher = f.watcher()
  await watcher.tick(true)
  f.server.messages.set(100, { seen: true, body: Buffer.from('新范围中的缺口') })
  f.server.messages.set(200, { seen: true, body: Buffer.from('新近尾页') })
  f.server.uidNext = 201

  await watcher.tick(true)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scanUpperUid, 70)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scannedUid, 70)
  assert.ok(f.analyzedUids().includes(200))
  assert.ok(!f.analyzedUids().includes(100))
  await watcher.tick(true)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scanUpperUid, 200)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scannedUid, 95)
  assert.ok(!f.analyzedUids().includes(100))
  await watcher.tick(true)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scannedUid, 120)
  assert.ok(f.analyzedUids().includes(100), '新近尾页之间未查询的区间仍被顺序扫描')
  assert.ok(f.analyzedUids().includes(70))
  assert.ok(!f.analyzedUids().includes(61), '首启历史已读不因尾页而扩大授权')
  assert.equal(f.analyzedUids().filter(uid => uid === 200).length, 1)
  f.reopen()
  await f.watcher().tick(true)
  assert.equal(f.analyzedUids().filter(uid => uid === 200).length, 1)
})

test('尾页坏信不阻塞后续新信与旧待办，恢复后仍会轮到', async t => {
  const f = fixture(t, 50)
  const watcher = f.watcher()
  await watcher.tick(true)
  f.server.messages.set(51, { seen: true, body: Buffer.from('普通新信') })
  f.server.messages.set(52, { seen: true, body: Buffer.from('暂时损坏') })
  f.server.uidNext = 53
  f.server.failUids.add(52)
  const before = f.analyzedUids().length
  await watcher.tick(true)
  assert.ok(f.analyzedUids().slice(before).some(uid => uid >= 6 && uid <= 50))
  assert.ok(f.store.listMailWatchMessages(f.scopeId(), 'pending', 100).some(item => item.uid === 52 && item.attempts === 1))

  f.server.messages.set(53, { seen: true, body: Buffer.from('后续健康新信') })
  f.server.uidNext = 54
  const next = f.analyzedUids().length
  await watcher.tick(true)
  assert.ok(f.analyzedUids().slice(next).includes(53))
  assert.ok(f.analyzedUids().slice(next).some(uid => uid >= 6 && uid <= 50))
  f.server.failUids.delete(52)
  for (let round = 0; round < 20 && !f.analyzedUids().includes(52); round++) await watcher.tick(true)
  assert.ok(f.analyzedUids().includes(52))
  assert.equal(new Set(f.analyzedUids()).size, f.analyzedUids().length)
})

test('空邮箱首启无查询，之后已读新信仍按新增 UID 处理', async t => {
  const f = fixture(t, 0)
  const watcher = f.watcher()
  assert.deepEqual(await watcher.tick(true), { fresh: 0, analyzed: false })
  assert.equal(f.server.searches.length, 0)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.bootstrapUpperUid, 0)
  f.server.messages.set(1, { seen: true, body: Buffer.from('空邮箱的新信') })
  f.server.uidNext = 2
  assert.deepEqual(await watcher.tick(true), { fresh: 1, analyzed: true })
  assert.deepEqual(f.server.searches, [{ from: 1, to: 1, unreadOnly: false }])
  assert.deepEqual(f.analyzedUids(), [1])
})

test('尾页失败不登记，历史页失败不跳过；恢复重启后已登记新信只分析一次', async t => {
  const f = sparseFixture(t)
  await f.watcher().tick(true)
  const scopeId = f.scopeId()
  f.server.messages.set(10_001, { seen: true, body: Buffer.from('新信') })
  f.server.uidNext = 10_002

  f.server.failPageFrom = 10_001
  await assert.rejects(f.watcher().tick(true), /页响应失败/)
  assert.equal(f.store.getMailWatchScope(scopeId)?.scannedUid, 50)
  assert.equal(f.store.getMailWatchScope(scopeId)?.scanUpperUid, 10_000)
  assert.equal(f.store.listMailWatchMessages(scopeId, 'pending', 100).length, 0)
  assert.ok(!f.analyzedUids().includes(10_001))

  f.server.failPageFrom = 51
  await assert.rejects(f.watcher().tick(true), /页响应失败/)
  assert.equal(f.store.getMailWatchScope(scopeId)?.scannedUid, 50)
  assert.equal(f.store.getMailWatchScope(scopeId)?.scanUpperUid, 10_000)
  assert.deepEqual(f.store.listMailWatchMessages(scopeId, 'pending', 100).map(item => item.uid), [10_001])
  assert.ok(!f.analyzedUids().includes(10_001))

  f.reopen()
  f.server.failPageFrom = 0
  await f.watcher().tick(true)
  assert.equal(f.store.getMailWatchScope(scopeId)?.scannedUid, 75)
  assert.equal(f.analyzedUids().filter(uid => uid === 10_001).length, 1)
  f.reopen()
  await f.watcher().tick(true)
  assert.equal(f.analyzedUids().filter(uid => uid === 10_001).length, 1)
})

test('新近页登记中途事务失败整页回滚，重启恢复不丢信', async t => {
  const f = sparseFixture(t)
  await f.watcher().tick(true)
  const scopeId = f.scopeId()
  for (const uid of [10_001, 10_002]) f.server.messages.set(uid, { seen: true, body: Buffer.from(`新信${uid}`) })
  f.server.uidNext = 10_003
  const trigger = new DatabaseSync(f.dbPath)
  try {
    trigger.exec(`CREATE TRIGGER mail_tail_abort BEFORE INSERT ON mail_watch_messages WHEN NEW.uid = 10002
      BEGIN SELECT RAISE(ABORT, '模拟尾页写入失败'); END`)
  } finally { trigger.close() }

  await assert.rejects(f.watcher().tick(true), /模拟尾页写入失败/)
  assert.equal(f.store.getMailWatchScope(scopeId)?.scannedUid, 50)
  assert.equal(f.store.getMailWatchScope(scopeId)?.scanUpperUid, 10_000)
  assert.equal(f.store.listMailWatchMessages(scopeId, 'pending', 100).length, 0)
  assert.deepEqual(f.analyzedUids(), [1])

  const reset = new DatabaseSync(f.dbPath)
  try { reset.exec('DROP TRIGGER mail_tail_abort') } finally { reset.close() }
  f.reopen()
  await f.watcher().tick(true)
  assert.equal(f.store.getMailWatchScope(scopeId)?.scannedUid, 75)
  assert.deepEqual(f.analyzedUids().slice(1).sort((a, b) => a - b), [10_001, 10_002])
  f.reopen()
  await f.watcher().tick(true)
  assert.equal(new Set(f.analyzedUids()).size, f.analyzedUids().length)
})

test('新近查询中远端代次变化时拒绝旧代次登记，下一代次独立初始化', async t => {
  const f = sparseFixture(t)
  await f.watcher().tick(true)
  const oldScope = f.scopeId()
  f.server.messages.set(10_001, { seen: true, body: Buffer.from('新信') })
  f.server.uidNext = 10_002
  f.server.afterSearch = () => {
    if (f.server.searches.at(-1)?.from === 10_001) f.server.uidValidity = 8
  }
  await assert.rejects(f.watcher().tick(true), /UIDVALIDITY 已变化/)
  assert.equal(f.store.getMailWatchScope(oldScope)?.scannedUid, 50)
  assert.equal(f.store.getMailWatchScope(oldScope)?.scanUpperUid, 10_000)
  assert.equal(f.store.listMailWatchMessages(oldScope, 'pending', 100).length, 0)
  assert.deepEqual(f.store.listMailWatchMessages(oldScope, 'analyzed', 100).map(item => item.uid), [1])

  f.server.afterSearch = null
  f.server.messages.clear()
  f.server.messages.set(1, { seen: false, body: Buffer.from('新代次的同 UID') })
  f.server.uidNext = 2
  await f.watcher().tick(true)
  assert.notEqual(f.scopeId(), oldScope)
  assert.deepEqual(f.store.listMailWatchMessages(f.scopeId(), 'analyzed', 100).map(item => item.uid), [1])
  assert.deepEqual(f.store.listMailWatchMessages(oldScope, 'analyzed', 100).map(item => item.uid), [1])
  assert.equal(f.prompts.length, 2)
})

test('新近查询的游标快照过期时拒绝迟到页，恢复时重新查询', async t => {
  const f = sparseFixture(t)
  await f.watcher().tick(true)
  const scopeId = f.scopeId()
  f.server.messages.set(10_001, { seen: true, body: Buffer.from('新信') })
  f.server.uidNext = 10_002
  f.server.afterSearch = () => {
    if (f.server.searches.at(-1)?.from === 10_001) f.store.beginMailWatchScan(scopeId, 10_001, 2_000_000)
  }
  await assert.rejects(f.watcher().tick(true), /游标已变化/)
  assert.equal(f.store.getMailWatchScope(scopeId)?.scannedUid, 50)
  assert.equal(f.store.getMailWatchScope(scopeId)?.scanUpperUid, 10_000)
  assert.equal(f.store.listMailWatchMessages(scopeId, 'pending', 100).length, 0)
  f.server.afterSearch = null
  f.reopen()
  await f.watcher().tick(true)
  assert.equal(f.analyzedUids().filter(uid => uid === 10_001).length, 1)
})

test('新近查询中切换账户，迟到结果只进入原连接所属账户', async t => {
  const f = sparseFixture(t)
  await f.watcher().tick(true)
  const oldScope = f.scopeId()
  f.server.messages.set(10_001, { seen: true, body: Buffer.from('原账户新信') })
  f.server.uidNext = 10_002
  f.server.afterSearch = () => {
    if (f.server.searches.at(-1)?.from === 10_001) f.patchConfig({ user: 'other@example.com' })
  }
  await f.watcher().tick(true)
  f.server.afterSearch = null
  const otherScope = f.scopeId()
  assert.notEqual(otherScope, oldScope)
  assert.equal(f.store.getMailWatchScope(otherScope), null)
  assert.deepEqual(f.store.listMailWatchMessages(oldScope, 'analyzed', 100).map(item => item.uid), [1, 10_001])

  await f.watcher().tick(true)
  assert.deepEqual(f.store.listMailWatchMessages(otherScope, 'analyzed', 100).map(item => item.uid), [1])
  assert.ok(!f.store.listMailWatchMessages(otherScope, 'pending', 100).some(item => item.uid === 10_001))
  assert.deepEqual(f.store.listMailWatchMessages(oldScope, 'analyzed', 100).map(item => item.uid), [1, 10_001])
})

test('新近登记后邮件消失须精确确认，不占用发现页预算或伪造分析', async t => {
  const f = sparseFixture(t)
  await f.watcher().tick(true)
  const scopeId = f.scopeId()
  f.server.messages.set(10_001, { seen: true, body: Buffer.from('随后删除') })
  f.server.uidNext = 10_002
  f.server.afterSearch = () => {
    if (f.server.searches.at(-1)?.from === 10_001) f.server.messages.delete(10_001)
  }
  const before = f.server.searches.length
  assert.deepEqual(await f.watcher().tick(true), { fresh: 0, analyzed: false })
  assert.deepEqual(f.server.searches.slice(before), [
    { from: 10_001, to: 10_001, unreadOnly: false },
    { from: 51, to: 75, unreadOnly: true },
    { from: 10_001, to: 10_001, unreadOnly: false },
  ])
  const missing = f.store.listMailWatchMessages(scopeId, 'missing')[0]
  assert.equal(missing.uid, 10_001)
  assert.match(missing.detail!, /精确 UID 查询成功为空/)
  assert.equal(f.store.getMailWatchScope(scopeId)?.scannedUid, 75)
  assert.deepEqual(f.analyzedUids(), [1])
})

test('新近页查询后团队关闭不调用分析，恢复后继续处理已登记 UID', async t => {
  const f = sparseFixture(t)
  let enabled = true
  const watcher = f.watcher({ enabled: () => enabled })
  await watcher.tick(true)
  const scopeId = f.scopeId()
  f.server.messages.set(10_001, { seen: true, body: Buffer.from('新信') })
  f.server.uidNext = 10_002
  f.server.afterSearch = () => {
    if (f.server.searches.at(-1)?.from === 10_001) enabled = false
  }
  assert.deepEqual(await watcher.tick(true), { fresh: 0, analyzed: false })
  assert.equal(f.store.getMailWatchScope(scopeId)?.scannedUid, 50)
  assert.deepEqual(f.store.listMailWatchMessages(scopeId, 'pending').map(item => item.uid), [10_001])
  assert.deepEqual(f.analyzedUids(), [1])
  assert.equal((await watcher.tick(true)).skipped, 'team-disabled')
  enabled = true
  f.server.afterSearch = null
  await watcher.tick(true)
  assert.equal(f.analyzedUids().filter(uid => uid === 10_001).length, 1)
})

test('尾页新信不能绕过软额度停线，额度恢复后保留的 UID 才进入分析', async t => {
  const f = sparseFixture(t)
  let blocked = true
  let physicalRequests = 0
  const analyze: MailWatcherOptions['analyze'] = async (_id, prompt) => {
    if (blocked) throw new Error('额度账本停线')
    physicalRequests++
    f.prompts.push(prompt)
    return '额度恢复后的模拟结果'
  }
  await assert.rejects(f.watcher({ analyze }).tick(true), /额度账本停线/)
  f.server.messages.set(10_001, { seen: true, body: Buffer.from('新信') })
  f.server.uidNext = 10_002
  await assert.rejects(f.watcher({ analyze }).tick(true), /额度账本停线/)
  assert.equal(physicalRequests, 0)
  assert.deepEqual(f.store.listMailWatchMessages(f.scopeId(), 'pending', 100).map(item => item.uid).sort((a, b) => a - b), [1, 10_001])
  f.reopen()
  await assert.rejects(f.watcher({ analyze }).tick(true), /额度账本停线/)
  assert.equal(physicalRequests, 0)
  blocked = false
  await f.watcher({ analyze }).tick(true)
  assert.equal(physicalRequests, 1)
  assert.ok(f.analyzedUids().includes(10_001))
})

test('值守接真实成员额度门禁：单次超额如实入账，新信不能触发下一次请求', async t => {
  const f = sparseFixture(t)
  const directory = f.store.directory
  const member = directory.create({ displayName: '邮件额度成员', description: '分析邮件', persona: '', skinId: 'panda', enabled: true,
    provider: '', model: '', maxTokens: 40, capabilities: ['mail'], allowedTools: [], dailyTokenLimit: 100,
    totalTokenLimit: 200, thresholdPercent: 80, timezone: 'Asia/Shanghai' })
  directory.beginUsage(member.assistantId, '模拟单次用量')
  directory.finishUsage('模拟单次用量', 105)
  assert.equal(directory.quota(member.assistantId).dailyUsed, 105, '软额度不裁剪已发生的单次用量')
  assert.equal(directory.quota(member.assistantId).blocked, true)
  const forbiddenHost = new Proxy({}, { get: () => { throw new Error('测试禁止访问宿主代理') } })
  const runtime = new MemberRuntime({ ctx: forbiddenHost as never, directory, defaultModel: () => null, enabled: () => true,
    memories: { injectable: () => '', propose: () => null } })
  t.after(() => runtime.dispose())
  const watcher = f.watcher({ member: () => ({ id: member.assistantId, name: member.displayName }),
    analyze: (id, prompt) => runtime.chat(id, prompt, undefined, undefined, 'mail') })
  await assert.rejects(watcher.tick(true), /额度/)
  f.server.messages.set(10_001, { seen: true, body: Buffer.from('额度停线后的新信') })
  f.server.uidNext = 10_002
  await assert.rejects(watcher.tick(true), /额度/)
  assert.deepEqual(f.store.listMailWatchMessages(f.scopeId(), 'pending', 100).map(item => item.uid).sort((a, b) => a - b), [1, 10_001])
  assert.equal(directory.quota(member.assistantId).totalUsed, 105)
  assert.equal(f.prompts.length, 0)
})

test('稀疏 UID 和空区间推进；第二页失败只保留第一页面的持久水位', async t => {
  const f = fixture(t, 100)
  for (const uid of [...f.server.messages.keys()]) if (uid !== 1 && uid !== 80) f.server.messages.delete(uid)
  f.server.failPageFrom = 26
  await assert.rejects(f.watcher().tick(true), /页响应失败/)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scannedUid, 25)
  assert.deepEqual(f.store.listMailWatchMessages(f.scopeId(), 'pending').map(item => item.uid), [1])
  f.reopen(); f.server.failPageFrom = 0
  await f.watcher().tick(true)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scannedUid, 75)
  await f.watcher().tick(true)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scannedUid, 100)
  assert.deepEqual(f.analyzedUids(), [1, 80])
})

test('本轮分页开始后到达的新信不能改写本轮固定上界，下轮健康查询可分析', async t => {
  const f = fixture(t, 70)
  const watcher = f.watcher()
  let arrived = false
  f.server.afterSearch = () => {
    if (arrived) return
    arrived = true
    f.server.messages.set(71, { seen: true, body: Buffer.from('分页期间到达') })
    f.server.uidNext = 72
  }
  await watcher.tick(true)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.bootstrapUpperUid, 70)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scanUpperUid, 70)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scannedUid, 50)
  assert.deepEqual(f.server.searches, [{ from: 1, to: 25, unreadOnly: true }, { from: 26, to: 50, unreadOnly: true }])
  assert.ok(!f.analyzedUids().includes(71))

  f.server.afterSearch = null
  await watcher.tick(true)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scanUpperUid, 70)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scannedUid, 70)
  assert.equal(f.analyzedUids().filter(uid => uid === 71).length, 1)
})

test('分页中的新到邮件不扩大本轮上界，提前分析后顺序重扫不重复消费', async t => {
  const f = fixture(t, 70)
  const watcher = f.watcher()
  await watcher.tick(true)
  f.server.messages.set(71, { seen: true, body: Buffer.from('新邮件') }); f.server.uidNext = 72
  await watcher.tick(true)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scanUpperUid, 70)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scannedUid, 70)
  assert.deepEqual(f.server.searches.slice(-2), [{ from: 71, to: 71, unreadOnly: false }, { from: 51, to: 70, unreadOnly: true }])
  assert.equal(f.analyzedUids().filter(uid => uid === 71).length, 1)
  await watcher.tick(true)
  assert.deepEqual(f.server.searches.at(-1), { from: 71, to: 71, unreadOnly: false })
  assert.equal(f.analyzedUids().filter(uid => uid === 71).length, 1)
})

test('抓取失败或 MIME 结构解析失败保留 UID；坏邮件不饿死后续邮件', async t => {
  const f = fixture(t, 6)
  f.server.failUids.add(1)
  f.server.messages.get(2)!.structure = { type: 'multipart/mixed', childNodes: Array.from({ length: 201 }, () => ({ type: 'text/plain' })) }
  const watcher = f.watcher()
  await watcher.tick(true)
  assert.deepEqual(f.analyzedUids(), [3, 4, 5])
  assert.deepEqual(f.store.listMailWatchMessages(f.scopeId(), 'pending').map(item => item.uid), [6, 1, 2])
  await watcher.tick(true)
  assert.ok(f.analyzedUids().includes(6))
  f.server.failUids.clear(); delete f.server.messages.get(2)!.structure
  for (const mail of f.server.messages.values()) mail.seen = true
  await watcher.tick(true)
  assert.deepEqual(f.analyzedUids().slice(-2), [1, 2])
})

test('正文部分响应缺失不是已消失，不丢弃待处理项', async t => {
  const f = fixture(t, 1)
  f.server.badBody = true
  assert.deepEqual(await f.watcher().tick(true), { fresh: 0, analyzed: false })
  assert.equal(f.store.listMailWatchMessages(f.scopeId(), 'pending').length, 1)
  f.server.badBody = false
  assert.equal((await f.watcher().tick(true)).analyzed, true)
})

test('查询响应失败不能被当作空页推进', async t => {
  const f = fixture(t, 6)
  f.server.badPage = true
  await assert.rejects(f.watcher().tick(true), /查询未完整成功/)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scannedUid, 0)
  assert.equal(f.store.listMailWatchMessages(f.scopeId(), 'pending').length, 0)
  f.server.badPage = false
  await f.watcher().tick(true)
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scannedUid, 6)
})

test('扫描途中远端 UIDVALIDITY 变化拒绝旧页提交，下轮新代次从未读重新开始', async t => {
  const f = fixture(t, 1)
  const oldScope = f.scopeId()
  f.server.afterSearch = () => { f.server.uidValidity = 8 }
  await assert.rejects(f.watcher().tick(true), /UIDVALIDITY 已变化/)
  assert.equal(f.store.getMailWatchScope(oldScope)?.scannedUid, 0)
  assert.equal(f.store.listMailWatchMessages(oldScope, 'pending').length, 0)
  f.server.afterSearch = null
  await f.watcher().tick(true)
  assert.equal(f.store.listMailWatchMessages(f.scopeId(), 'analyzed').length, 1)
})

test('正文抓取途中代次变化，不使用新代次正文完成旧 UID 的分析', async t => {
  const f = fixture(t, 1)
  const oldScope = f.scopeId()
  f.server.afterFetch = () => { f.server.uidValidity = 9 }
  await assert.rejects(f.watcher().tick(true), /UIDVALIDITY 已变化/)
  assert.equal(f.prompts.length, 0)
  assert.equal(f.store.listMailWatchMessages(oldScope, 'pending').length, 1)
})

test('账户、主机及端口隔离，密码和发件显示字段不参与身份；UIDVALIDITY 切换不撞 UID', async t => {
  const f = fixture(t, 1)
  const original = readMailImapConfig(f.dir)!
  const key = mailWatchAccountKey(original)
  assert.equal(mailWatchAccountKey({ ...original, from: '另一个显示地址', imapHost: original.imapHost.toUpperCase() }), key)
  assert.notEqual(mailWatchAccountKey({ ...original, imapPort: 143 }), key)
  assert.notEqual(mailWatchAccountKey({ ...original, imapHost: 'other.example.com' }), key)
  await f.watcher().tick(true)
  const oldScope = f.scopeId()
  f.patchConfig({ user: 'other@example.com' })
  await f.watcher().tick(true)
  assert.notEqual(f.scopeId(), oldScope)
  f.patchConfig({ user: original.user })
  assert.equal((await f.watcher().tick(true)).fresh, 0)
  f.server.uidValidity++
  assert.equal((await f.watcher().tick(true)).fresh, 1)
  assert.equal(f.prompts.length, 3)
  assert.equal(f.store.listMailWatchMessages(oldScope, 'analyzed').length, 1)
})

test('通知回调仅入队而没有接收确认时不能标记已送达', async t => {
  const f = fixture(t, 1)
  let queued = 0
  await f.watcher({ notify: () => { queued++ } }).tick(true)
  assert.equal(queued, 1)
  assert.equal(f.store.pendingMailWatchNotifications(f.scopeId()).length, 1)
})

test('没有可信桌面回执时分析结果保持待投递，重启不重新调用模型', async t => {
  const f = fixture(t, 2)
  await f.watcher({ notify: undefined }).tick(true)
  assert.equal(f.store.pendingMailWatchNotifications(f.scopeId()).length, 1)
  assert.equal(f.prompts.length, 1)
  f.reopen()
  await f.watcher({ notify: undefined }).tick(true)
  assert.equal(f.store.pendingMailWatchNotifications(f.scopeId()).length, 1)
  assert.equal(f.prompts.length, 1)
})

test('异步通知失败已保存结果，重启只补通知、不重新调用模型', async t => {
  const f = fixture(t, 2)
  await assert.rejects(f.watcher({ notify: async () => { throw new Error('通知通道暂不可用') } }).tick(true), /通知通道/)
  const pending = f.store.pendingMailWatchNotifications(f.scopeId())
  assert.equal(pending.length, 1)
  assert.equal(pending[0].result, '需要核对后处理。')
  assert.equal(f.store.listMailWatchMessages(f.scopeId(), 'analyzed').length, 2)
  const fetched = f.server.fetches.length
  f.reopen()
  await f.watcher().tick(true)
  assert.equal(f.prompts.length, 1)
  assert.equal(f.server.fetches.length, fetched)
  assert.equal(f.notices.length, 1)
  assert.equal(f.store.pendingMailWatchNotifications(f.scopeId()).length, 0)
})

test('超长正文有明确截断标记，文本附件不下载，来源摘要和截断状态落库', async t => {
  const f = fixture(t, 1)
  const mail = f.server.messages.get(1)!
  mail.body = Buffer.from('很长的正文'.repeat(30_000))
  mail.structure = { type: 'multipart/mixed', childNodes: [
    { part: '1', type: 'text/plain', size: mail.body.length, parameters: { charset: 'utf-8' } },
    { part: '2', type: 'text/plain', size: 1_000_000, disposition: 'attachment', dispositionParameters: { filename: '秘密.txt' } },
  ] }
  await f.watcher().tick(true)
  assert.match(f.prompts[0], /正文已截断/)
  assert.match(f.prompts[0], /附件未读取/)
  assert.ok(f.prompts[0].length < 6_000)
  const stored = f.store.listMailWatchMessages(f.scopeId(), 'analyzed')[0]
  assert.equal(stored.truncated, true)
  assert.match(stored.sourceDigest!, /^[a-f0-9]{64}$/)
  assert.equal(f.server.fetches.length, 2)
})

test('登记后被删除的 UID 留下消失证据，不伪造分析完成', async t => {
  const f = fixture(t, 2)
  f.server.afterSearch = () => { f.server.messages.delete(1) }
  await f.watcher().tick(true)
  const missing = f.store.listMailWatchMessages(f.scopeId(), 'missing')[0]
  assert.equal(missing.uid, 1)
  assert.match(missing.detail!, /精确 UID 查询成功为空/)
  assert.deepEqual(f.analyzedUids(), [2])
})

test('手动读取仍返回最近 N 封未读，不受后台完成状态影响', async t => {
  const f = fixture(t, 50)
  f.server.messages.get(50)!.seen = true
  await f.watcher().tick(true)
  const result = await readUnreadMail(readMailImapConfig(f.dir)!, 'fake-secret', { limit: 3 })
  assert.deepEqual(result.messages.map(mail => mail.uid), [49, 48, 47])
  assert.equal(result.uidValidity, '7')
  assert.deepEqual(f.server.searches.at(-1), { from: 26, to: 50, unreadOnly: true })
  assert.equal(f.store.getMailWatchScope(f.scopeId())?.scannedUid, 50)
})

test('旧状态无账户归属时保守重分析当前未读，不默默把 seen 或缺口当完成', async t => {
  const f = fixture(t)
  const file = path.join(f.dir, 'personal-assistant', 'mail-watch.json')
  const old = JSON.stringify({ uidValidity: '7', seen: [2, 3, 4, 5, 6], lastRun: 99_999_999 })
  writeFileSync(file, old)
  const watcher = f.watcher()
  await watcher.tick(); await watcher.tick(true)
  assert.deepEqual(f.analyzedUids(), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(f.store.getMailWatchScope(f.scopeId())?.legacy?.seen, [2, 3, 4, 5, 6])
  assert.match(f.logs.join('\n'), /缺少匹配的账户/)
  assert.match(f.logs.join('\n'), /已读缺口无法安全自动回补/)
  assert.equal(readFileSync(file, 'utf8'), old)
  f.reopen(); await f.watcher().tick(true)
  assert.equal(f.logs.filter(line => line.includes('邮件值守迁移')).length, 1)
})

test('有可验证归属的旧状态仅迁移明确 UID，最大 seen 之前的缺口仍分析', async t => {
  const f = fixture(t)
  writeFileSync(path.join(f.dir, 'personal-assistant', 'mail-watch.json'), JSON.stringify({
    uidValidity: '7', accountKey: mailWatchAccountKey(readMailImapConfig(f.dir)!), folder: 'INBOX', seen: [2, 3, 4, 5, 6],
  }))
  await f.watcher().tick(true)
  assert.deepEqual(f.analyzedUids(), [1])
  assert.equal(f.store.listMailWatchMessages(f.scopeId(), 'legacy-completed', 10).length, 5)
  assert.match(f.logs.join('\n'), /缺口仍按未读逐页扫描/)
})

test('旧状态的账户或代次不匹配、损坏 JSON 都不导入完成标记', async t => {
  const f = fixture(t, 1)
  const file = path.join(f.dir, 'personal-assistant', 'mail-watch.json')
  writeFileSync(file, JSON.stringify({ uidValidity: '7', accountKey: '别的账户', folder: 'INBOX', seen: [1] }))
  await f.watcher().tick(true)
  assert.equal(f.store.listMailWatchMessages(f.scopeId(), 'legacy-completed').length, 0)
  f.server.uidValidity = 8
  writeFileSync(file, '{损坏的 JSON')
  await f.watcher().tick(true)
  assert.equal(f.store.listMailWatchMessages(f.scopeId(), 'analyzed').length, 1)
  assert.match(f.logs.join('\n'), /无法安全读取/)
})

test('空回复保留待处理，团队关闭、没有成员、配置关闭或间隔内均跳过', async t => {
  const f = fixture(t, 1)
  assert.deepEqual(await f.watcher({ analyze: async () => '  ' }).tick(true), { fresh: 1, analyzed: false })
  assert.equal(f.store.listMailWatchMessages(f.scopeId(), 'pending').length, 1)
  assert.equal((await f.watcher().tick()).skipped, 'interval')
  assert.equal((await f.watcher({ enabled: () => false }).tick(true)).skipped, 'team-disabled')
  assert.equal((await f.watcher({ member: () => null }).tick(true)).skipped, 'no-member')
  f.patchConfig({ watchEnabled: false })
  assert.equal((await f.watcher().tick(true)).skipped, 'not-configured')
  assert.equal(f.server.connections, 1)
})
