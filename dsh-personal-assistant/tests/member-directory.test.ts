import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { MemberDirectory, type MemberDraft } from '../src/member-directory.ts'
import { TeamStore, TEAM_SCHEMA_VERSION, type MemberConfig } from '../src/team-domain.ts'

function draft(patch: Partial<MemberDraft> = {}): MemberDraft {
  return { displayName: '资料助理', description: '整理资料', persona: '据实回答', skinId: 'panda', enabled: true,
    provider: '测试提供方', model: '测试模型', maxTokens: 60, capabilities: [], allowedTools: [],
    dailyTokenLimit: 100, totalTokenLimit: 300, thresholdPercent: 80, timezone: 'Asia/Shanghai', ...patch }
}
function memory(t: TestContext): TeamStore {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  return store
}
function file(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-member-directory-'))
  const dbPath = path.join(dir, 'team.sqlite')
  const opened: { close(): void }[] = []
  t.after(() => {
    for (const connection of opened.reverse()) connection.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dbPath, open: () => { const store = new TeamStore(dbPath); opened.push(store); return store },
    raw: () => { const db = new DatabaseSync(dbPath); opened.push(db); return db } }
}
const beforeMidnight = Date.parse('2026-10-28T15:59:00Z')
const afterMidnight = Date.parse('2026-10-28T16:01:00Z')
function seed(id = 'member-wukong'): MemberConfig {
  return { assistantId: id, roleId: id === 'member-tangseng' ? 'tangseng' : 'wukong', displayName: id === 'member-tangseng' ? '总助理' : '原助理',
    skinId: 'boy-glasses', persona: '原人设', voiceProfile: '原声音', toolPolicy: { mode: 'read-only', denyTools: ['write'] }, enabled: true, revision: 7 }
}
function spend(directory: MemberDirectory, id: string, requestId: string, tokens: number, now = beforeMidnight): void {
  directory.beginUsage(id, requestId, now)
  directory.finishUsage(requestId, tokens, now)
}

test('成员身份唯一真源，默认扩展不授予工具，总助理不进入目录', t => {
  const store = memory(t)
  store.upsertMember(seed())
  store.upsertMember(seed('member-tangseng'))
  const member = store.directory.list()[0]!
  assert.equal(store.directory.list().length, 1)
  assert.equal(store.directory.get('member-tangseng'), null)
  assert.equal(store.directory.get('不存在'), null)
  assert.equal(member.assistantId, 'member-wukong')
  assert.equal(member.revision, 7)
  assert.equal(member.voiceProfile, '原声音')
  assert.deepEqual(member.allowedTools, [])
  assert.deepEqual(member.capabilities, [])
  assert.equal(member.thresholdPercent, 80)
  assert.equal(member.sessionId, null)
  store.upsertMember({ ...seed(), displayName: '修改基础身份', revision: 8 })
  assert.equal(store.directory.get(member.assistantId)!.displayName, '修改基础身份')
  assert.equal(store.directory.get(member.assistantId)!.revision, 8)
  assert.throws(() => store.directory.create(draft({ displayName: '总助理' })), /名称已存在/)
  assert.throws(() => store.directory.setSession('member-tangseng', '禁止'), /总助理/)
})

test('通用成员新增、基础字段和扩展配置一同修订，陈旧 CAS 不覆盖数据', t => {
  const store = memory(t)
  const dir = store.directory
  const first = dir.create(draft({ skinId: '', thresholdPercent: undefined as never }))
  assert.match(first.assistantId, /^member-[0-9a-f-]{36}$/)
  assert.equal(first.roleId, 'custom')
  assert.equal(first.skinId, 'panda')
  assert.equal(first.thresholdPercent, 80)
  assert.equal(first.toolPolicy.mode, 'read-only')
  assert.equal(store.getMember(first.assistantId)!.displayName, first.displayName)
  const next = dir.update(first.assistantId, 1, draft({ displayName: '分析助理', provider: '另一个提供方', model: '另一个模型', persona: '新职责' }))
  assert.equal(next.assistantId, first.assistantId)
  assert.equal(next.revision, 2)
  assert.equal(store.getMember(first.assistantId)!.revision, 2)
  assert.throws(() => dir.update(first.assistantId, 1, draft()), /修订冲突/)
  assert.equal(dir.get(first.assistantId)!.model, '另一个模型')
  assert.throws(() => dir.create(draft({ displayName: ' 分析助理 ' })), /名称已存在/)
  const second = dir.create(draft({ displayName: '第二位' }))
  assert.throws(() => dir.update(second.assistantId, 1, draft({ displayName: '分析助理' })), /名称已存在/)
  assert.equal(dir.get(second.assistantId)!.revision, 1)
})

test('扩展 JSON 不复制基础字段，会话独立且权限变动强制换会话', t => {
  const fixture = file(t)
  const store = fixture.open()
  const dir = store.directory
  const a = dir.create(draft())
  const b = dir.create(draft({ displayName: '另一个成员' }))
  dir.setSession(a.assistantId, '会话甲')
  dir.setSession(b.assistantId, '会话乙')
  assert.equal(dir.get(a.assistantId)!.revision, 1)
  assert.throws(() => dir.setSession(b.assistantId, '会话甲'), /独立会话/)
  let next = dir.update(a.assistantId, 1, draft({ description: '新的职责说明', provider: '新提供方' }))
  assert.equal(next.sessionId, '会话甲', '普通修改不代替调用方决定会话轮换')
  next = dir.update(a.assistantId, next.revision, draft({ capabilities: ['mail'] }))
  assert.equal(next.sessionId, null)
  dir.setSession(a.assistantId, '新会话')
  next = dir.update(a.assistantId, next.revision, draft({ capabilities: ['mail'], allowedTools: ['read'] }))
  assert.equal(next.sessionId, null)
  assert.equal(dir.get(b.assistantId)!.sessionId, '会话乙')
  const raw = fixture.raw()
  const row = raw.prepare('SELECT data FROM assistant_profiles WHERE assistant_id = ?').get(a.assistantId)!
  const extra = JSON.parse(String(row.data))
  for (const key of ['assistantId', 'displayName', 'roleId', 'persona', 'skinId', 'revision', 'enabled', 'voiceProfile', 'toolPolicy']) {
    assert.equal(Object.hasOwn(extra, key), false, `基础字段 ${key} 不应复制到扩展表`)
  }
})

test('启用企业微信能力的成员至多一位，停用不影响其他独立成员', t => {
  const dir = memory(t).directory
  const first = dir.create(draft({ capabilities: ['wecom'] }))
  assert.throws(() => dir.create(draft({ displayName: '重复路由', capabilities: ['wecom'] })), /最多只能启用一位/)
  const second = dir.create(draft({ displayName: '后备成员', capabilities: ['wecom'], enabled: false }))
  assert.throws(() => dir.update(second.assistantId, 1, draft({ displayName: '后备成员', capabilities: ['wecom'] })), /最多只能启用一位/)
  assert.throws(() => dir.checkAvailable(second.assistantId), /停用/)
  assert.throws(() => dir.beginUsage(second.assistantId, '停用请求'), /停用/)
  assert.equal(dir.quota(second.assistantId).blocked, true)
  dir.update(first.assistantId, 1, draft({ capabilities: ['wecom'], enabled: false }))
  dir.update(second.assistantId, 1, draft({ displayName: '后备成员', capabilities: ['wecom'] }))
  assert.doesNotThrow(() => dir.checkAvailable(second.assistantId))
})

test('输入严格校验，工具仅取真实安全只读白名单，不可借任意工具绕过能力', t => {
  const dir = memory(t).directory
  for (const tool of ['bash', 'pwsh', 'skill', 'write', 'task', 'delegate', 'subagent', 'job_output', 'job_list', 'get_goal', 'report', 'structured_output', 'mail_send', '*', 'Read']) {
    assert.throws(() => dir.create(draft({ allowedTools: [tool] })), /白名单/, tool)
  }
  const invalid: Partial<MemberDraft>[] = [
    { displayName: '  ' }, { description: '长'.repeat(4001) }, { skinId: '../任意文件' }, { enabled: 1 as never },
    { maxTokens: 0 }, { maxTokens: 32769 }, { maxTokens: 1.1 }, { dailyTokenLimit: -1 }, { totalTokenLimit: Infinity },
    { dailyTokenLimit: NaN }, { totalTokenLimit: Number.MAX_SAFE_INTEGER + 1 }, { thresholdPercent: 0 }, { thresholdPercent: 101 },
    { timezone: '无效/时区' }, { capabilities: ['任意能力'] as never }, { allowedTools: null as never },
  ]
  for (const patch of invalid) assert.throws(() => dir.create(draft(patch)), Error)
  const member = dir.create(draft({ allowedTools: ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch'], dailyTokenLimit: 0, totalTokenLimit: 0 }))
  assert.equal(member.allowedTools.length, 6)
  assert.throws(() => dir.update(member.assistantId, NaN, draft()), /安全整数/)
  assert.throws(() => dir.quota(member.assistantId, Infinity), /安全整数/)
})

test('按成员时区自然日与请求起始日归账，总额度跨日、跨成员隔离', t => {
  const dir = memory(t).directory
  const shanghai = dir.create(draft())
  const newYork = dir.create(draft({ displayName: '纽约成员', timezone: 'America/New_York' }))
  assert.equal(dir.quota(shanghai.assistantId, beforeMidnight).day, '2026-10-28')
  assert.equal(dir.quota(shanghai.assistantId, afterMidnight).day, '2026-10-29')
  assert.equal(dir.quota(newYork.assistantId, afterMidnight).day, '2026-10-28')
  dir.beginUsage(shanghai.assistantId, '跨日请求', beforeMidnight)
  dir.finishUsage('跨日请求', 90, afterMidnight)
  assert.equal(dir.quota(shanghai.assistantId, beforeMidnight).dailyUsed, 90)
  assert.equal(dir.quota(shanghai.assistantId, afterMidnight).dailyUsed, 0)
  assert.equal(dir.quota(shanghai.assistantId, afterMidnight).totalUsed, 90)
  assert.equal(dir.quota(newYork.assistantId, afterMidnight).totalUsed, 0)
  assert.equal(dir.requests().filter(item => item.assistantId === shanghai.assistantId).length, 1)
  spend(dir, shanghai.assistantId, '第二天请求', 70, afterMidnight)
  assert.equal(dir.quota(shanghai.assistantId, afterMidnight).totalUsed, 160)
  assert.equal(dir.quota(shanghai.assistantId, afterMidnight).dailyUsed, 70)
  assert.equal(dir.quota(newYork.assistantId, Date.parse('2026-11-01T05:30:00Z')).day, '2026-11-01')
  assert.equal(dir.quota(newYork.assistantId, Date.parse('2026-11-01T06:30:00Z')).day, '2026-11-01', '夏令时回拨仍是同一自然日')
})

test('并发请求保守预留剩余输出额度，结算前不可穿透或通过重置释放预留', t => {
  const dir = memory(t).directory
  const member = dir.create(draft())
  assert.deepEqual(dir.beginUsage(member.assistantId, '并发甲', beforeMidnight), { maxTokens: 60 })
  assert.deepEqual(dir.beginUsage(member.assistantId, '并发乙', beforeMidnight), { maxTokens: 40 })
  assert.equal(dir.hasInFlight(member.assistantId), true)
  assert.equal(dir.quota(member.assistantId, beforeMidnight).dailyUsed, 0, '预留不是实际用量')
  assert.throws(() => dir.beginUsage(member.assistantId, '并发丙', beforeMidnight), /预留/)
  assert.throws(() => dir.checkAvailable(member.assistantId, beforeMidnight), /预留/)
  assert.throws(() => dir.resetQuota(member.assistantId, 1, 'both', beforeMidnight), /进行中/)
  dir.finishUsage('并发甲', 20, beforeMidnight)
  assert.deepEqual(dir.beginUsage(member.assistantId, '并发丙', beforeMidnight), { maxTokens: 40 })
  dir.finishUsage('并发乙', 40, beforeMidnight)
  dir.finishUsage('并发丙', 40, beforeMidnight)
  assert.equal(dir.hasInFlight(member.assistantId), false)
  assert.equal(dir.quota(member.assistantId, beforeMidnight).dailyUsed, 100)
  assert.equal(dir.requests().length, 1)
})

test('总预算预留跨日约束，新日不能逃逸上一日仍在途的请求', t => {
  const dir = memory(t).directory
  const member = dir.create(draft({ dailyTokenLimit: 0, totalTokenLimit: 90 }))
  assert.equal(dir.beginUsage(member.assistantId, '昨天在途', beforeMidnight).maxTokens, 60)
  assert.equal(dir.beginUsage(member.assistantId, '今天在途', afterMidnight).maxTokens, 30)
  assert.throws(() => dir.beginUsage(member.assistantId, '今天第三次', afterMidnight), /预留/)
  dir.finishUsage('昨天在途', 60, afterMidnight)
  dir.finishUsage('今天在途', 35, afterMidnight)
  const quota = dir.quota(member.assistantId, afterMidnight)
  assert.equal(quota.dailyUsed, 35)
  assert.equal(quota.totalUsed, 95, '实际输入加输出可越额，不能裁剪真实账目')
  assert.equal(quota.blocked, true)
})

test('结算幂等、冲突拒绝，请求编号全局唯一，未知用量绝不按零放行', t => {
  const dir = memory(t).directory
  const a = dir.create(draft({ dailyTokenLimit: 0, totalTokenLimit: 0 }))
  const b = dir.create(draft({ displayName: '第二成员' }))
  spend(dir, a.assistantId, '全局编号', 120)
  dir.finishUsage('全局编号', 120, afterMidnight)
  assert.equal(dir.quota(a.assistantId, beforeMidnight).totalUsed, 120)
  assert.throws(() => dir.finishUsage('全局编号', 121), /冲突/)
  assert.throws(() => dir.finishUsage('全局编号', null), /冲突/)
  assert.throws(() => dir.beginUsage(a.assistantId, '全局编号'), /重复/)
  assert.throws(() => dir.beginUsage(b.assistantId, '全局编号'), /跨成员/)
  dir.beginUsage(a.assistantId, '无回执', beforeMidnight)
  for (const count of [0, -1, NaN, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => dir.finishUsage('无回执', count), /安全整数/)
  assert.equal(dir.hasInFlight(a.assistantId), true)
  dir.finishUsage('无回执', null, beforeMidnight)
  dir.finishUsage('无回执', null, afterMidnight)
  assert.throws(() => dir.finishUsage('无回执', 100), /冲突/)
  assert.throws(() => dir.checkAvailable(a.assistantId, afterMidnight), /未知/)
  assert.throws(() => dir.beginUsage(a.assistantId, '未知之后', afterMidnight), /未知/)
  assert.equal(dir.quota(a.assistantId, afterMidnight).unknown, true)
  assert.doesNotThrow(() => dir.checkAvailable(b.assistantId, afterMidnight))
  assert.throws(() => dir.finishUsage('未登记', 2), /不存在/)
})

test('文件 SQLite 重启将 pending 转未知，修改模型、停启与跨日均不清账', t => {
  const fixture = file(t)
  const first = new TeamStore(fixture.dbPath)
  const member = first.directory.create(draft({ dailyTokenLimit: 0, totalTokenLimit: 0 }))
  first.directory.setSession(member.assistantId, '持久会话')
  first.directory.beginUsage(member.assistantId, '进程中断请求', beforeMidnight)
  first.close()
  const restarted = fixture.open()
  const dir = restarted.directory
  assert.equal(dir.get(member.assistantId)!.sessionId, '持久会话')
  assert.equal(dir.hasInFlight(member.assistantId), false)
  assert.equal(dir.requests().filter(item => item.state === 'pending').length, 1, '恢复时立即持久化人工核查申请')
  assert.equal(dir.quota(member.assistantId, afterMidnight).unknown, true)
  assert.throws(() => dir.beginUsage(member.assistantId, '进程中断请求', afterMidnight), /重复/)
  assert.throws(() => dir.beginUsage(member.assistantId, '重启续跑', afterMidnight), /未知/)
  dir.update(member.assistantId, 1, draft({ dailyTokenLimit: 0, totalTokenLimit: 0, model: '新模型', enabled: false }))
  dir.update(member.assistantId, 2, draft({ dailyTokenLimit: 0, totalTokenLimit: 0, model: '新模型' }))
  assert.throws(() => dir.checkAvailable(member.assistantId, afterMidnight), /未知/)
  assert.equal(fixture.raw().prepare('SELECT state FROM member_usage WHERE request_id = ?').get('进程中断请求')!.state, 'unknown')
})

test('重置日额度与总额度独立、CAS 防重复，原始用量和重置基线永久保留', t => {
  const fixture = file(t)
  const dir = fixture.open().directory
  const member = dir.create(draft())
  spend(dir, member.assistantId, '原用量', 90)
  dir.resetQuota(member.assistantId, 1, 'daily', beforeMidnight)
  assert.equal(dir.quota(member.assistantId, beforeMidnight).dailyUsed, 0)
  assert.equal(dir.quota(member.assistantId, beforeMidnight).totalUsed, 90)
  assert.throws(() => dir.resetQuota(member.assistantId, 1, 'daily', beforeMidnight), /修订冲突/)
  spend(dir, member.assistantId, '重置后用量', 20)
  dir.resetQuota(member.assistantId, 2, 'total', beforeMidnight)
  let quota = dir.quota(member.assistantId, beforeMidnight)
  assert.equal(quota.dailyUsed, 20)
  assert.equal(quota.totalUsed, 0)
  assert.equal(quota.revision, 3)
  assert.equal(dir.get(member.assistantId)!.revision, 1, '仅重置不改成员配置修订')
  dir.resetQuota(member.assistantId, 3, 'both', beforeMidnight)
  quota = dir.quota(member.assistantId, beforeMidnight)
  assert.equal(quota.dailyUsed, 0)
  assert.equal(quota.totalUsed, 0)
  assert.equal(quota.revision, 4)
  const raw = fixture.raw()
  assert.deepEqual(raw.prepare('SELECT tokens FROM member_usage ORDER BY seq').all().map(row => row.tokens), [90, 20])
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM member_quota_resets').get()!.n, 3)
  assert.throws(() => dir.beginUsage(member.assistantId, '原用量', beforeMidnight), /重复/)
  const reopened = fixture.open().directory
  assert.equal(reopened.quota(member.assistantId, beforeMidnight).dailyUsed, 0)
  assert.equal(reopened.quota(member.assistantId, beforeMidnight).revision, 4)
})

test('未知只能 both 明确解除，未知审计不删，迟到结果不能复活旧账', t => {
  const fixture = file(t)
  const dir = fixture.open().directory
  const member = dir.create(draft())
  dir.beginUsage(member.assistantId, '未知请求', beforeMidnight)
  dir.finishUsage('未知请求', null, beforeMidnight)
  assert.throws(() => dir.resetQuota(member.assistantId, 1, 'daily', beforeMidnight), /只能同时/)
  assert.throws(() => dir.resetQuota(member.assistantId, 1, 'total', beforeMidnight), /只能同时/)
  dir.resetQuota(member.assistantId, 1, 'both', beforeMidnight)
  assert.equal(dir.quota(member.assistantId, beforeMidnight).unknown, false)
  assert.throws(() => dir.finishUsage('未知请求', 10, beforeMidnight), /冲突/)
  assert.equal(fixture.raw().prepare('SELECT state, tokens FROM member_usage').get()!.state, 'unknown')
  spend(dir, member.assistantId, '明确重置后', 20)
  assert.equal(dir.quota(member.assistantId, beforeMidnight).dailyUsed, 20)
  assert.doesNotThrow(() => dir.checkAvailable(member.assistantId, beforeMidnight))
})

test('阈值申请持久去重，拒绝后不轰炸；下一天可再申请，成员改名不刷新额度修订', t => {
  const fixture = file(t)
  const dir = fixture.open().directory
  const member = dir.create(draft({ totalTokenLimit: 100 }))
  assert.throws(() => dir.requestQuota(member.assistantId, '太早', beforeMidnight), /尚未达到/)
  spend(dir, member.assistantId, '到阈值', 80)
  const request = dir.requests()[0]!
  assert.equal(request.state, 'pending')
  assert.equal(dir.requestQuota(member.assistantId, '再次申请', beforeMidnight).requestId, request.requestId)
  assert.throws(() => dir.decideRequest(request.requestId, 'approve', 1), /空操作/)
  assert.throws(() => dir.decideRequest(request.requestId, 'approve', 1, { dailyTokenLimit: 100 }), /空操作/)
  assert.throws(() => dir.decideRequest(request.requestId, 'approve', 2, { dailyTokenLimit: 200 }), /修订冲突/)
  dir.decideRequest(request.requestId, 'reject', 1)
  assert.equal(dir.requestQuota(member.assistantId, '拒绝后再申请', beforeMidnight).state, 'rejected')
  dir.update(member.assistantId, 1, draft({ displayName: '改名成员', totalTokenLimit: 100 }))
  assert.equal(dir.quota(member.assistantId, beforeMidnight).revision, 1)
  assert.equal(dir.requests().length, 1)
  const anotherDay = dir.requestQuota(member.assistantId, '次日仍接近总额度', afterMidnight)
  assert.notEqual(anotherDay.requestId, request.requestId)
  assert.equal(anotherDay.state, 'pending')
  assert.equal(fixture.open().directory.requests().length, 2)
})

test('明确加额经双修订校验，配置修订增长但实际用量不清除，也不重跑任务', t => {
  const dir = memory(t).directory
  const member = dir.create(draft({ totalTokenLimit: 100 }))
  spend(dir, member.assistantId, '加额前请求', 100)
  const request = dir.requests()[0]!
  assert.throws(() => dir.decideRequest(request.requestId, 'approve', 1, { dailyTokenLimit: 50 }), /不能减少/)
  dir.decideRequest(request.requestId, 'approve', 1, { dailyTokenLimit: 200, totalTokenLimit: 0 })
  assert.equal(dir.requests().find(item => item.requestId === request.requestId)!.state, 'approved')
  assert.equal(dir.get(member.assistantId)!.revision, 2)
  const quota = dir.quota(member.assistantId, beforeMidnight)
  assert.equal(quota.revision, 2)
  assert.equal(quota.dailyUsed, 100)
  assert.equal(quota.totalUsed, 100)
  assert.equal(quota.blocked, false)
  assert.equal(dir.hasInFlight(member.assistantId), false)
  assert.throws(() => dir.update(member.assistantId, 1, draft()), /修订冲突/)
  assert.throws(() => dir.decideRequest(request.requestId, 'approve', 2, { dailyTokenLimit: 300 }), /已处理/)
  spend(dir, member.assistantId, '人工再次开始', 70)
  assert.equal(dir.requests().filter(item => item.state === 'pending').length, 1)
  assert.equal(dir.requests().find(item => item.state === 'pending')!.quotaRevision, 2)
})

test('批准重置未知只接受 both；单纯加额不能清除未知', t => {
  const dir = memory(t).directory
  const member = dir.create(draft())
  const now = Date.now()
  dir.beginUsage(member.assistantId, '需要人工复核', now)
  dir.finishUsage('需要人工复核', null, now)
  let request = dir.requests()[0]!
  assert.throws(() => dir.decideRequest(request.requestId, 'approve', 1, { reset: 'daily' }), /只能同时/)
  dir.decideRequest(request.requestId, 'approve', 1, { dailyTokenLimit: 200 })
  assert.equal(dir.quota(member.assistantId, now).unknown, true)
  request = dir.requests().find(item => item.state === 'pending')!
  dir.decideRequest(request.requestId, 'approve', 2, { reset: 'both' })
  assert.equal(dir.quota(member.assistantId, now).unknown, false)
  assert.equal(dir.quota(member.assistantId, now).revision, 3)
  assert.equal(dir.hasInFlight(member.assistantId), false)
})

test('阈值边界一至百分百，零不限，安全整数累计不溢出、不裁剪超预算回执', t => {
  const dir = memory(t).directory
  const a = dir.create(draft({ thresholdPercent: 1 }))
  spend(dir, a.assistantId, '百分之一', 1)
  assert.equal(dir.requests().length, 1)
  const b = dir.create(draft({ displayName: '百分百成员', thresholdPercent: 100 }))
  spend(dir, b.assistantId, '不到百分百', 99)
  assert.equal(dir.requests().filter(item => item.assistantId === b.assistantId).length, 0)
  spend(dir, b.assistantId, '百分百', 1)
  assert.equal(dir.requests().filter(item => item.assistantId === b.assistantId).length, 1)
  const unlimited = dir.create(draft({ displayName: '无限额成员', dailyTokenLimit: 0, totalTokenLimit: 0 }))
  spend(dir, unlimited.assistantId, '大用量一', Number.MAX_SAFE_INTEGER)
  spend(dir, unlimited.assistantId, '大用量二', 1)
  assert.equal(dir.quota(unlimited.assistantId, beforeMidnight).totalUsed, Number.MAX_SAFE_INTEGER)
  assert.equal(dir.quota(unlimited.assistantId, beforeMidnight).blocked, false)
  assert.equal(dir.requests().filter(item => item.assistantId === unlimited.assistantId).length, 0)
  dir.resetQuota(unlimited.assistantId, 1, 'both', beforeMidnight)
  spend(dir, unlimited.assistantId, '重置大用量后', 3)
  assert.equal(dir.quota(unlimited.assistantId, beforeMidnight).totalUsed, 3)
})

test('嵌套团队事务回滚同时撤销成员、用量、申请与基线，不开启嵌套 SQLite 事务', t => {
  const store = memory(t)
  const dir = store.directory
  assert.throws(() => store.transaction(() => { dir.create(draft()); throw new Error('外层回滚') }), /外层回滚/)
  assert.equal(dir.list().length, 0)
  const member = dir.create(draft())
  assert.throws(() => store.transaction(() => {
    spend(dir, member.assistantId, '回滚用量', 90)
    dir.resetQuota(member.assistantId, 1, 'both', beforeMidnight)
    dir.update(member.assistantId, 1, draft({ displayName: '回滚名称' }))
    throw new Error('外层回滚')
  }), /外层回滚/)
  assert.equal(dir.get(member.assistantId)!.revision, 1)
  assert.equal(dir.quota(member.assistantId, beforeMidnight).totalUsed, 0)
  assert.equal(dir.quota(member.assistantId, beforeMidnight).revision, 1)
  assert.equal(dir.requests().length, 0)
  assert.doesNotThrow(() => dir.beginUsage(member.assistantId, '回滚用量', beforeMidnight))
})

test('迁移 v8 到 v9 保留身份，当前版本再次打开不重跑迁移或覆盖扩展', t => {
  const fixture = file(t)
  const raw = fixture.raw()
  raw.exec(`CREATE TABLE assistants (
    assistant_id TEXT PRIMARY KEY, role_id TEXT NOT NULL, display_name TEXT NOT NULL, skin_id TEXT NOT NULL,
    persona TEXT NOT NULL, voice_profile TEXT NOT NULL, tool_policy TEXT NOT NULL, enabled INTEGER NOT NULL, revision INTEGER NOT NULL
  ); PRAGMA user_version = 8;`)
  const old = seed()
  raw.prepare('INSERT INTO assistants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(old.assistantId, old.roleId, old.displayName,
    old.skinId, old.persona, old.voiceProfile, JSON.stringify(old.toolPolicy), 1, old.revision)
  const store = fixture.open()
  assert.equal(TEAM_SCHEMA_VERSION, 9)
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 9)
  assert.deepEqual(store.getMember(old.assistantId), old)
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM assistant_profiles').get()!.n, 1)
  store.directory.update(old.assistantId, 7, draft({ displayName: old.displayName, allowedTools: ['read'] }))
  store.directory.setSession(old.assistantId, '迁移会话')
  raw.exec(`CREATE TRIGGER forbid_profile_migration BEFORE INSERT ON assistant_profiles
    BEGIN SELECT RAISE(ABORT, '当前版本不应再补默认值'); END;
    CREATE TRIGGER forbid_repeat_migration BEFORE INSERT ON migrations
    BEGIN SELECT RAISE(ABORT, '当前版本不应再登记迁移'); END;`)
  const version = raw.prepare('PRAGMA schema_version').get()!.schema_version
  const migration = raw.prepare('SELECT applied_at FROM migrations WHERE version = 9').get()!.applied_at
  const again = fixture.open()
  assert.equal(again.directory.get(old.assistantId)!.sessionId, '迁移会话')
  assert.deepEqual(again.directory.get(old.assistantId)!.allowedTools, ['read'])
  assert.equal(raw.prepare('PRAGMA schema_version').get()!.schema_version, version)
  assert.equal(raw.prepare('SELECT applied_at FROM migrations WHERE version = 9').get()!.applied_at, migration)
  assert.throws(() => again.directory.update(old.assistantId, 7, draft()), /修订冲突/)
})

test('两个真实 SQLite 连接共享预留与 CAS 状态，不依赖目录内存缓存', t => {
  const fixture = file(t)
  const first = fixture.open().directory
  const second = fixture.open().directory
  const member = first.create(draft())
  assert.equal(second.get(member.assistantId)!.displayName, member.displayName)
  first.update(member.assistantId, 1, draft({ model: '已修改模型' }))
  assert.throws(() => second.update(member.assistantId, 1, draft()), /修订冲突/)
  assert.equal(first.beginUsage(member.assistantId, '连接甲', beforeMidnight).maxTokens, 60)
  assert.equal(second.beginUsage(member.assistantId, '连接乙', beforeMidnight).maxTokens, 40)
  assert.throws(() => first.beginUsage(member.assistantId, '连接丙', beforeMidnight), /预留/)
  second.finishUsage('连接甲', 60, beforeMidnight)
  first.finishUsage('连接乙', 40, beforeMidnight)
  assert.equal(second.quota(member.assistantId, beforeMidnight).dailyUsed, 100)
  first.resetQuota(member.assistantId, 1, 'both', beforeMidnight)
  assert.throws(() => second.resetQuota(member.assistantId, 1, 'both', beforeMidnight), /修订冲突/)
  assert.equal(second.quota(member.assistantId, beforeMidnight).totalUsed, 0)
})

test('请求在途更换时区不移动已经登记的归账日，起始日阈值仍能生成申请', t => {
  const dir = memory(t).directory
  const member = dir.create(draft({ totalTokenLimit: 0 }))
  dir.beginUsage(member.assistantId, '更换时区请求', afterMidnight)
  dir.update(member.assistantId, 1, draft({ totalTokenLimit: 0, timezone: 'America/New_York' }))
  dir.finishUsage('更换时区请求', 90, afterMidnight)
  assert.equal(dir.quota(member.assistantId, afterMidnight).dailyUsed, 0, '纽约此刻仍是前一天，不转移原始用量')
  assert.equal(dir.quota(member.assistantId, afterMidnight).totalUsed, 90)
  assert.equal(dir.requests().length, 1, '原归账日达到阈值自动持久化')
  assert.equal(dir.requests()[0]!.quotaRevision, 2)
  const nextLocalDay = Date.parse('2026-10-29T12:00:00Z')
  assert.equal(dir.quota(member.assistantId, nextLocalDay).dailyUsed, 90)
})

test('仅批准日重置保留总用量，旧申请退役，不自动开始新请求', t => {
  const dir = memory(t).directory
  const member = dir.create(draft())
  const now = Date.now()
  spend(dir, member.assistantId, '当前日到阈值', 90, now)
  const request = dir.requests()[0]!
  dir.decideRequest(request.requestId, 'approve', 1, { reset: 'daily' })
  assert.equal(dir.quota(member.assistantId, now).dailyUsed, 0)
  assert.equal(dir.quota(member.assistantId, now).totalUsed, 90)
  assert.equal(dir.quota(member.assistantId, now).revision, 2)
  assert.equal(dir.get(member.assistantId)!.revision, 1)
  assert.equal(dir.requests()[0]!.state, 'approved')
  assert.equal(dir.hasInFlight(member.assistantId), false)
  assert.throws(() => dir.resetQuota(member.assistantId, 2, '无效' as never, now), /重置范围/)
})

test('删除成员清理配置与额度账本，进行中请求先拒绝，任务历史保留', t => {
  const f = file(t)
  const store = f.open()
  const member = store.directory.create(draft())
  const id = member.assistantId
  assert.throws(() => store.directory.delete(id, member.revision + 1), /修订冲突/)
  store.directory.beginUsage(id, '删除前未结算')
  assert.throws(() => store.directory.delete(id, member.revision), /进行中/)
  store.directory.finishUsage('删除前未结算', 5)
  store.insertTask({ taskId: 'task-delete-check', teamId: '团队', ownerId: id, goal: '保留历史', inputEvidence: [], acceptance: [],
    toolScope: 'read-only', budgetTokens: 0, deadlineAt: null, dependsOn: [], status: 'queued', revision: 1, artifacts: [],
    originRequestId: null, originChannel: null, createdAt: 1, updatedAt: 1 })
  assert.equal(store.activeTaskCount(id), 1)
  store.directory.delete(id, member.revision)
  assert.equal(store.directory.get(id), null)
  assert.equal(store.directory.list().length, 0)
  const db = f.raw()
  for (const table of ['assistant_profiles', 'member_quota_accounts', 'member_usage', 'member_quota_requests', 'member_quota_resets']) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE assistant_id = ?`).get(id) as { n: number }
    assert.equal(Number(row.n), 0, `${table} 未清理`)
  }
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM assistants WHERE assistant_id = ?').get(id) as { n: number }).n), 0)
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ?').get(id) as { n: number }).n), 1)
  assert.throws(() => store.directory.delete(id, member.revision), /不存在/)
  store.upsertMember(seed('member-tangseng'))
  assert.throws(() => store.directory.delete('member-tangseng', 7), /总助理/)
})

test('配置变更达到阈值立即申请，额度变更使旧申请失效，拒绝不携带加额副作用', t => {
  const dir = memory(t).directory
  const member = dir.create(draft({ totalTokenLimit: 1000 }))
  const now = Date.now()
  spend(dir, member.assistantId, '调整阈值前', 70, now)
  assert.equal(dir.requests().length, 0)
  dir.update(member.assistantId, 1, draft({ thresholdPercent: 50, totalTokenLimit: 1000 }))
  const first = dir.requests()[0]!
  assert.equal(first.quotaRevision, 2)
  assert.throws(() => dir.decideRequest(first.requestId, 'reject', 2, { totalTokenLimit: 2000 }), /不能同时修改/)
  assert.equal(dir.requests()[0]!.state, 'pending')
  dir.update(member.assistantId, 2, draft({ dailyTokenLimit: 1000, thresholdPercent: 50, totalTokenLimit: 1000 }))
  assert.equal(dir.requests()[0]!.state, 'rejected')
  assert.throws(() => dir.decideRequest(first.requestId, 'approve', 3, { totalTokenLimit: 2000 }), /已处理/)
  assert.equal(dir.get(member.assistantId)!.totalTokenLimit, 1000)
})
