/** 助理审批生产接线：真实工具、HTTP、数据库；不启动真实采集或模型。 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { AssistantApprovalService, snapshotDigest, type AssistantSubmission } from '../src/assistant-approval.ts'
import { SessionBridge } from '../src/bridge.ts'
import { MemoryStore } from '../src/memory.ts'
import { ReportStore } from '../src/report.ts'
import { ObservationStore } from '../src/observation.ts'
import { HelpContextStore, normalizeHelpScope } from '../src/help-context.ts'
import { openAssistantStore } from '../src/store.ts'
import { registerAssistantTools } from '../src/tools.ts'
import { ActivityTracker } from '../src/tracker.ts'
import { Classifier } from '../src/classifier.ts'

const scratch = path.resolve(import.meta.dirname, '../../generated-videos/moved-from-assets/petsBak/dsh-personal-assistant')
const submission = (execute: AssistantSubmission['execute'] = () => null): AssistantSubmission => ({
  subject: '测试', tool: '测试工具', summary: '测试说明', target: '本地测试', risk: 'high',
  snapshot: { text: '完整内容' }, validate: () => true, execute,
})

test('固定协议、独立凭据、拒绝、过期、代次、重放与同主题失效', async () => {
  let now = 1000, effects = 0
  const service = new AssistantApprovalService({ epoch: '本代', ttlMs: 50, now: () => now })
  const propose = () => service.submit(submission(() => { effects++ }))
  const decide = (id: string, decision: 'approve' | 'reject' = 'approve') => service.decide(id, decision, '本代', service.approvalCapabilityToken)
  const first = propose()
  assert.equal(first.kind, 'assistant')
  assert.equal(first.revision, 1)
  assert.match(first.digest, /^[a-f0-9]{64}$/)
  assert.match(first.content, /完整内容/)
  assert.equal(JSON.stringify(first).includes(service.approvalCapabilityToken), false)
  assert.equal((await service.decide(first.proposalId, 'approve', '本代', '聊天令牌')).ok, false)
  assert.equal((await service.decide(first.proposalId, 'approve', '旧代', service.approvalCapabilityToken)).ok, false)
  const second = propose()
  assert.equal((await decide(first.proposalId)).ok, false)
  assert.deepEqual(await decide(second.proposalId, 'reject'), { ok: true, decision: 'rejected' })
  assert.equal(effects, 0)
  const expired = propose()
  now = expired.expiresAt
  assert.equal((await decide(expired.proposalId)).ok, false)
  const valid = propose()
  assert.equal((await decide(valid.proposalId)).ok, true)
  assert.equal((await decide(valid.proposalId)).ok, false)
  assert.equal(effects, 1)
  const restarted = new AssistantApprovalService({ epoch: '新代', ttlMs: 50 })
  assert.deepEqual(restarted.pendingProposals(), [])
  assert.equal((await restarted.decide(valid.proposalId, 'approve', '新代', restarted.approvalCapabilityToken)).ok, false)
})

test('批准前重验，消费先于等待，换绑式清理保留执行中与结果不明状态', async () => {
  const service = new AssistantApprovalService({ epoch: '代次', ttlMs: 1000 })
  let current = 1, effects = 0
  const old = service.submit({ ...submission(() => effects++), validate: () => current === 1 })
  current++
  assert.deepEqual(service.pendingProposals(), [])
  const decide = (id: string) => service.decide(id, 'approve', '代次', service.approvalCapabilityToken)
  assert.equal((await decide(old.proposalId)).ok, false)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const pending = service.submit(submission(async () => { effects++; await gate; throw new Error('部分效果，待核查') }))
  const operation = decide(pending.proposalId)
  assert.equal(effects, 1)
  service.invalidateAll()
  assert.equal((await decide(pending.proposalId)).ok, false)
  assert.throws(() => service.submit(submission()), /正在执行或结果不明/)
  release()
  const result = await operation
  assert.equal(result.state, 'unknown')
  assert.equal(result.retryable, false)
  service.invalidateAll()
  assert.throws(() => service.submit(submission()), /正在执行或结果不明/)
})

test('待批有容量上限且过期释放容量', () => {
  let now = 0
  const service = new AssistantApprovalService({ epoch: '代次', ttlMs: 1, now: () => now })
  for (let i = 0; i < 64; i++) service.submit({ ...submission(), subject: String(i) })
  assert.throws(() => service.submit({ ...submission(), subject: '超额' }), /上限/)
  now++
  assert.equal(service.pendingProposals().length, 0)
  assert.equal(service.submit(submission()).state, 'pending')
})

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(scratch, 'assistant-test-'))
  const db = openAssistantStore(path.join(dir, 'assistant.sqlite'))
  const memories = new MemoryStore(db), reports = new ReportStore(db), observations = new ObservationStore(db)
  const helpContexts = new HelpContextStore(db)
  const bridge = new SessionBridge({ dshHome: dir })
  const approvals = new AssistantApprovalService({ epoch: bridge.epoch, ttlMs: 60_000 })
  bridge.attachAssistantApprovals(approvals)
  const state = { starts: 0, stops: 0, samples: 0, autoEvents: 0, titles: false, scopeDigest: '', activityRevision: 0 }
  const scope = (titles = state.titles) => ({ captureWindowTitles: titles, exclusions: ['密码管理器'] })
  const tracker = {
    active: true, capturing: false,
    start: async () => { state.starts++ },
    stop: async () => { state.stops++ },
    setCaptureTitles: async (value: boolean) => { state.titles = value },
    modeDescription: () => '测试',
    getDay: (date: string) => ({ date, events: [], notes: [], spans: [], interpretedUpto: state.activityRevision }),
    deletionSnapshot: (dates: readonly string[], from: number, to: number) => ({ dates, from, to, revision: state.activityRevision }),
    deleteSampleRange: () => { state.samples++; return 1 },
    pruneAutoEvents: async () => { state.autoEvents++; return 1 },
  }
  const tools = new Map<string, { execute(args: unknown): Promise<string> }>()
  registerAssistantTools({
    tools: { register(def: any) { tools.set(def.name, def); return () => {} } },
    systemPrompt: { section: () => () => {}, variable: () => () => {} },
  }, tracker as unknown as ActivityTracker, {
    reportDir: dir, bridge, memories, reports, observations, helpContexts,
    captureScope: { acked: () => state.scopeDigest === snapshotDigest(scope()), ack: value => { state.scopeDigest = snapshotDigest(value) }, describe: scope },
    captureBlockedReason: () => null, maxInjectedMemories: 10, legacyCopiesRetained: false,
    enableTeamMode: () => ({ toolsRegistered: true }), disableTeamMode: async () => ({ ok: true }),
  })
  const call = async (name: string, args: unknown = {}) => JSON.parse(await tools.get(`personal_assistant_${name}`)!.execute(args))
  const decide = (id: string, decision: 'approve' | 'reject' = 'approve') => approvals.decide(id, decision, bridge.epoch, approvals.approvalCapabilityToken)
  t.after(() => { bridge.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, db, bridge, approvals, memories, reports, observations, helpContexts, state, call, decide }
}

test('健康端点只向已鉴权请求投影当前采集状态，不暴露原文', async t => {
  const dir = mkdtempSync(path.join(scratch, 'activity-health-'))
  const activity = { active: true, capturing: false, titles: false }
  const bridge = new SessionBridge({ dshHome: dir, activityState: () => ({ ...activity }) })
  t.after(() => { bridge.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const { port } = await bridge.bind({ id: 'health-test', session: { events: [] }, followup() {} } as never)
  const { token } = JSON.parse(readFileSync(path.join(dir, 'personal-assistant/bridge.json'), 'utf8'))
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 401)
  const health = async () => await (await fetch(`http://127.0.0.1:${port}/health?token=${token}`)).json() as { activity: unknown }
  assert.deepEqual((await health()).activity, activity)
  activity.capturing = true
  assert.deepEqual((await health()).activity, { active: true, capturing: true, titles: false })
})

test('真实工具与HTTP：模型自批和聊天凭据无效，凭据不入快照，可信批准后才写偏好', async t => {
  const f = fixture(t)
  const agent = { id: '测试会话', session: { events: [] }, followup: async () => {} }
  const { port } = await f.bridge.bind(agent as never)
  const chat = JSON.parse(readFileSync(path.join(f.dir, 'personal-assistant/bridge.json'), 'utf8'))
  const credential = JSON.parse(readFileSync(path.join(f.dir, 'personal-assistant/bridge-approval.json'), 'utf8'))
  assert.equal(credential.assistantApprovalToken, f.approvals.approvalCapabilityToken)
  assert.notEqual(chat.token, credential.assistantApprovalToken)
  assert.equal(chat.assistantApprovalToken, undefined)
  const pending = await f.call('remember_preference', { text: '回复使用中文', topic: '语言' })
  assert.equal(pending.pending, true)
  assert.equal(pending.remembered, undefined)
  assert.equal(f.memories.list({}, Date.now()).length, 0)
  assert.equal((await f.approvals.decide(pending.proposalId, 'approve', f.bridge.epoch)).ok, false)
  const post = (token: string, proposalId = pending.proposalId) => fetch(`http://127.0.0.1:${port}/assistant-approval`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-approval-token': token },
    body: JSON.stringify({ proposalId, epoch: f.bridge.epoch, decision: 'approve' }),
  })
  assert.equal((await post(chat.token)).status, 403)
  const snapshot = await (await fetch(`http://127.0.0.1:${port}/team?token=${chat.token}`)).json() as any
  assert.equal(snapshot.proposals[0].kind, 'assistant')
  assert.equal(JSON.stringify(snapshot).includes(credential.assistantApprovalToken), false)
  assert.equal((await post(credential.assistantApprovalToken)).status, 200)
  const memory = f.memories.list({}, Date.now())[0]!
  assert.equal(memory.status, 'confirmed')
  assert.equal(memory.text, '回复使用中文')
  assert.equal((await post(credential.assistantApprovalToken)).status, 409)
  const old = await f.call('forget_preference', { id: memory.id })
  await f.bridge.bind({ id: '另一会话', session: { events: [] }, followup: async () => {} } as never)
  assert.equal((await post(credential.assistantApprovalToken, old.proposalId)).status, 409)
  assert.equal(f.memories.list({}, Date.now()).length, 1)
})

test('替换规则版本变化使待批失效；确认、删除只能由可信闭包执行', async t => {
  const f = fixture(t)
  const first = await f.call('remember_preference', { text: '用中文', topic: '语言' })
  await f.decide(first.proposalId)
  const memory = f.memories.list({}, Date.now())[0]!
  const replace = await f.call('remember_preference', { text: '用英文', topic: '语言', replaceIds: [memory.id] })
  f.memories.confirm(memory.id, { id: '测试用户', isUser: true }, Date.now(), { [memory.id]: memory.revision })
  // 显式修改相关修订，模拟另一可信入口更新。
  f.db.prepare('UPDATE memories SET revision = revision + 1 WHERE memory_id = ?').run(memory.id)
  assert.equal((await f.decide(replace.proposalId)).ok, false)
  assert.equal(f.memories.list({}, Date.now()).length, 1)
  const forget = await f.call('forget_preference', { id: memory.id })
  assert.equal(forget.pending, true)
  await f.decide(forget.proposalId, 'reject')
  assert.ok(f.memories.get(memory.id, Date.now()))
  const confirm = await f.call('resolve_preference', { id: memory.id })
  assert.equal(confirm.pending, true)
  assert.equal((await f.decide(confirm.proposalId)).ok, true)
  const approvedForget = await f.call('forget_preference', { id: memory.id })
  assert.equal((await f.decide(approvedForget.proposalId)).ok, true)
  assert.equal(f.memories.get(memory.id, Date.now()), null)
})

test('记忆操作业务拒绝不能被审批包装为执行成功', async t => {
  const f = fixture(t)
  const invalid = await f.call('remember_preference', { text: ' ', topic: '语言' })
  assert.equal(invalid.pending, true)
  const result = await f.decide(invalid.proposalId)
  assert.equal(result.ok, false)
  assert.notEqual(result.state, 'succeeded')
  const missing = await f.call('forget_preference', { id: '不存在的记忆' })
  assert.equal((await f.decide(missing.proposalId)).ok, false)
})

test('首次开始直接产生待批；模型确认不授权，停止与关闭标题撤销待扩权', async t => {
  const f = fixture(t)
  const start = await f.call('start')
  assert.equal(start.pending, true)
  assert.equal(f.state.starts, 0)
  const ack = await f.call('ack_capture_scope')
  assert.equal(ack.pending, true)
  assert.equal(f.state.scopeDigest, '')
  assert.equal((await f.decide(start.proposalId)).ok, false)
  await f.call('stop')
  assert.equal((await f.decide(ack.proposalId)).ok, false)
  const approvedStart = await f.call('start')
  assert.equal((await f.decide(approvedStart.proposalId)).ok, true)
  assert.equal(f.state.starts, 1)
  const titles = await f.call('set_capture_titles', { enabled: true })
  assert.equal(titles.pending, true)
  assert.equal(f.state.titles, false)
  await f.call('set_capture_titles', { enabled: false })
  assert.equal((await f.decide(titles.proposalId)).ok, false)
  const approvedTitles = await f.call('set_capture_titles', { enabled: true })
  assert.equal((await f.decide(approvedTitles.proposalId)).ok, true)
  assert.equal(f.state.titles, true)
})

test('旧boolean或未注入可信摘要时不恢复采样、不启动子进程', async () => {
  const state = { active: true, startedAt: 1, captureTitles: true, capture_scope_ack: true }
  let writes = 0
  const tracker = new ActivityTracker({ global: { get: () => state, set: async () => { writes++ } } } as never,
    new Classifier([]), '不存在的采样脚本', '不存在的采样目录', {
      sampleIntervalMs: 1000, minSpanMs: 1000, captureTitles: true, captureBlockedReason: () => null,
    })
  await tracker.ensureSamplerAlive()
  assert.equal(tracker.capturing, false)
  assert.equal(writes, 0)
  await assert.rejects(tracker.start(), /可信摘要确认/)
  await assert.rejects(tracker.setCaptureTitles(true), /可信摘要确认/)
})

test('删除前置失败不删除原文；重查范围拒绝变化；成功顺序为停采集、日报、来源、观察及原文', async t => {
  const f = fixture(t)
  const args = { startMs: new Date(2026, 8, 18).getTime(), endMs: new Date(2026, 8, 19).getTime() }
  f.reports.saveDraft('daily:2026-09-18', '待撤销日报', Date.now())
  const first = await f.call('delete_activity', args)
  assert.equal(first.pending, true)
  assert.equal(f.state.stops, 0)
  assert.equal(f.state.samples, 0)
  const original = f.reports.invalidateActivityDates.bind(f.reports)
  f.reports.invalidateActivityDates = () => { throw new Error('发布结果不明，禁止删除') }
  const failed = await f.decide(first.proposalId)
  assert.equal(failed.state, 'unknown')
  assert.equal(f.state.stops, 1)
  assert.equal(f.state.samples, 0)
  assert.equal(f.state.autoEvents, 0)
  assert.equal(f.reports.current('daily:2026-09-18')?.state, 'draft')
  f.reports.invalidateActivityDates = original
  assert.equal((await f.call('delete_activity', args)).pending, false)
})

test('活动范围变更拒绝旧删除；可信批准先撤销日报再删除采样', async t => {
  const f = fixture(t)
  const args = { startMs: new Date(2026, 8, 18).getTime(), endMs: new Date(2026, 8, 19).getTime() }
  f.reports.saveDraft('daily:2026-09-18', '待撤销日报', Date.now())
  const old = await f.call('delete_activity', args)
  f.state.activityRevision++
  assert.equal((await f.decide(old.proposalId)).ok, false)
  assert.equal(f.state.samples, 0)
  const pending = await f.call('delete_activity', args)
  const invalidate = f.reports.invalidateActivityDates.bind(f.reports)
  f.reports.invalidateActivityDates = (...args) => {
    assert.equal(f.state.stops, 1)
    assert.equal(f.state.samples, 0)
    return invalidate(...args)
  }
  assert.equal((await f.decide(pending.proposalId)).ok, true)
  assert.equal(f.reports.current('daily:2026-09-18')?.state, 'revoked')
  assert.equal(f.state.samples, 1)
})

test('帮助授权与撤销接线，实际路径改指和文件越界不能批准', async t => {
  const f = fixture(t)
  const project = path.join(f.dir, 'project'), outside = path.join(f.dir, 'outside')
  mkdirSync(project); mkdirSync(outside)
  writeFileSync(path.join(outside, 'secret.txt'), '测试数据')
  const pending = await f.call('help_context', { projectDir: project })
  assert.equal(pending.pending, true)
  assert.equal(f.helpContexts.list().length, 0)
  await f.call('forget_help_context', { id: '不存在' })
  assert.equal((await f.decide(pending.proposalId)).ok, false)
  const valid = await f.call('help_context', { projectDir: project })
  assert.equal((await f.decide(valid.proposalId)).ok, true)
  assert.equal((await f.call('read_project_evidence', { projectDir: project })).ok, true)
  assert.throws(() => normalizeHelpScope(project, path.join(outside, 'secret.txt')), /实际路径/)
  const link = path.join(f.dir, 'link')
  symlinkSync(project, link, 'junction')
  const linked = await f.call('help_context', { projectDir: link })
  unlinkSync(link)
  symlinkSync(outside, link, 'junction')
  assert.equal((await f.decide(linked.proposalId)).ok, false)
  assert.equal(f.helpContexts.isAuthorized(link), false)
})
