/** M3-01 工作事项与证据关联、M3-06 项目范围记忆：真实工具、真实库与审批服务；不启动采集或模型。 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { AssistantApprovalService } from '../src/assistant-approval.ts'
import { SessionBridge } from '../src/bridge.ts'
import type { ActivitySpan, Note } from '../src/domain.ts'
import { HelpContextStore } from '../src/help-context.ts'
import { MemoryStore } from '../src/memory.ts'
import { ObservationStore } from '../src/observation.ts'
import { REPORT_EVIDENCE_RULES, ReportStore } from '../src/report.ts'
import { openAssistantStore } from '../src/store.ts'
import { localDateOf, startOfLocalDate } from '../src/time.ts'
import { registerAssistantTools } from '../src/tools.ts'
import type { ActivityTracker } from '../src/tracker.ts'
import { planWorkItem, WorkItemStore } from '../src/work-items.ts'

const scratch = tmpdir()
const today = localDateOf(Date.now())
const base = startOfLocalDate(today) + 60_000
const span = (offsetMin: number, minutes: number, app: string, title: string): ActivitySpan =>
  ({ start: base + offsetMin * 60_000, end: base + (offsetMin + minutes) * 60_000, app, category: 'dev', title })

function fixture(t: TestContext) {
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(path.join(scratch, 'work-items-test-'))
  const db = openAssistantStore(path.join(dir, 'assistant.sqlite'))
  const memories = new MemoryStore(db), reports = new ReportStore(db), observations = new ObservationStore(db)
  const helpContexts = new HelpContextStore(db), workItems = new WorkItemStore(db)
  const bridge = new SessionBridge({ dshHome: dir })
  const approvals = new AssistantApprovalService({ epoch: bridge.epoch, ttlMs: 60_000 })
  bridge.attachAssistantApprovals(approvals)
  const day = {
    spans: [span(0, 30, 'Code', 'tools.ts - dsh'), span(30, 20, 'WINWORD', '日报.docx'), span(50, 5, 'Code', '仍在延续')],
    notes: [] as Note[], interpretedUpto: 0,
  }
  const tracker = {
    active: false, capturing: false,
    start: async () => {}, stop: async () => {}, setCaptureTitles: async () => {},
    modeDescription: () => '测试',
    getDay: (date: string) => ({ date, events: [], notes: date === today ? day.notes : [], spans: date === today ? day.spans : [], interpretedUpto: day.interpretedUpto }),
    enqueueDayUpdate: async (date: string, mutate: (value: any) => any) => {
      const next = mutate({ date, events: [], notes: day.notes, interpretedUpto: day.interpretedUpto })
      day.notes = next.notes; day.interpretedUpto = next.interpretedUpto
      return next
    },
    deletionSnapshot: (dates: readonly string[]) => ({ dates }),
    deleteSampleRange: () => 0,
    pruneAutoEvents: async () => 0,
  }
  const tools = new Map<string, { execute(args: unknown): Promise<string> }>()
  const variables = new Map<string, () => string | undefined>()
  const sections: string[] = []
  registerAssistantTools({
    tools: { register(def: any) { tools.set(def.name, def); return () => {} } },
    systemPrompt: { section: s => { sections.push(s.text); return () => {} }, variable: (name, provider) => { variables.set(name, provider); return () => {} } },
  }, tracker as unknown as ActivityTracker, {
    reportDir: dir, bridge, memories, reports, observations, helpContexts, workItems,
    captureBlockedReason: () => null, maxInjectedMemories: 10, legacyCopiesRetained: false,
    enableTeamMode: () => ({ toolsRegistered: true }), disableTeamMode: async () => ({ ok: true }),
  })
  const call = async (name: string, args: unknown = {}) => JSON.parse(await tools.get(`personal_assistant_${name}`)!.execute(args))
  const decide = (id: string) => approvals.decide(id, 'approve', bridge.epoch, approvals.approvalCapabilityToken)
  const authorize = async (projectDir: string) => {
    const pending = await call('help_context', { projectDir })
    assert.equal(pending.pending, true)
    assert.equal((await decide(pending.proposalId)).ok, true)
  }
  const remember = async (args: Record<string, unknown>) => {
    const pending = await call('remember_preference', args)
    assert.equal(pending.pending, true, JSON.stringify(pending))
    const result = await decide(pending.proposalId)
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  t.after(() => { bridge.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, db, bridge, approvals, memories, observations, helpContexts, workItems, day, call, decide, authorize, remember, variables, sections }
}

test('来源引用查不到时整批拒绝，不落库', async t => {
  const f = fixture(t)
  await f.call('today')
  const missing = await f.call('commit_events', { events: [
    { start: base, end: base + 60_000, summary: '写代码', status: 'inferred', sources: [{ kind: 'activity_observation', ref: '不存在的观察' }] },
  ] })
  assert.equal(missing.committed, 0)
  assert.match(missing.error, /无法在本地查到/)
  const noSources = await f.call('commit_events', { events: [{ start: base, end: base, summary: '无来源', status: 'inferred', sources: [] }] })
  assert.equal(noSources.committed, 0)
  const badNote = await f.call('commit_events', { events: [
    { start: base, end: base, summary: '笔记', status: 'inferred', sources: [{ kind: 'user_note', ref: 'note-不存在' }] },
  ] })
  assert.equal(badNote.committed, 0)
  assert.equal(f.workItems.listInRange(0, Number.MAX_SAFE_INTEGER).length, 0)
})

test('仅凭窗口标题或随手记不能声明 direct；导入原文与文件差异可以', async t => {
  const f = fixture(t)
  const day = await f.call('today', { detail: 'full' })
  const [first, second, open] = day.allSpans
  assert.ok(first.observationId && second.observationId)
  assert.equal(open.observationId, null, '仍在延续的最后一段不入观察库')
  assert.equal(day.reportRules, REPORT_EVIDENCE_RULES)
  const titleOnly = { start: first.start, end: first.end, summary: '修改 tools.ts', status: 'direct', sources: [{ kind: 'activity_observation', ref: first.observationId }] }
  const rejected = await f.call('commit_events', { events: [titleOnly] })
  assert.equal(rejected.committed, 0)
  assert.match(rejected.error, /只能声明 inferred/)
  const accepted = await f.call('commit_events', { events: [{ ...titleOnly, status: 'inferred' }] })
  assert.equal(accepted.committed, 1)
  assert.equal(accepted.items[0].status, 'inferred')

  const manual = await f.call('import_records', { content: '记一下：完成了评审' })
  assert.equal(manual.sourceKind, 'user_note')
  const manualDirect = await f.call('commit_events', { events: [{ start: base, end: base, summary: '完成评审', status: 'direct', sources: [{ kind: 'user_note', ref: manual.noteId }] }] })
  assert.equal(manualDirect.committed, 0)
  const imported = await f.call('import_records', { content: 'npm test\n# pass 271\n# fail 0', source: 'test_output_paste' })
  assert.equal(imported.sourceKind, 'import_material')
  const importedDirect = await f.call('commit_events', { events: [{ start: base, end: base, summary: '全量测试通过', outcome: '271 项通过', status: 'direct', sources: [{ kind: 'import_material', ref: imported.noteId }] }] })
  assert.equal(importedDirect.committed, 1)
  assert.equal(importedDirect.items[0].status, 'direct')

  const project = path.join(f.dir, 'project')
  mkdirSync(project)
  await f.authorize(project)
  const read = f.workItems.recordProjectEvidence({ projectDir: project, git: true, branch: 'main', changedFiles: [' M a.ts'], diffStat: [' a.ts | 2 +-'], recentCommits: [], entries: [], truncated: false }, Date.now())
  const diffDirect = await f.call('commit_events', { events: [{ start: base, end: base, summary: '改了 a.ts', status: 'direct', sources: [{ kind: 'project_evidence', ref: read.evidenceId }] }] })
  assert.equal(diffDirect.committed, 1)
  assert.equal(f.workItems.get(diffDirect.items[0].id)!.project, project)
  const source = f.workItems.get(diffDirect.items[0].id)!.sources[0]!
  assert.equal(source.projectDir, project)
  assert.equal(source.readAt, read.readAt)
  assert.equal(source.digest, read.digest)
  const snapshotOnly = f.workItems.recordProjectEvidence({ projectDir: project, git: false, branch: null, changedFiles: [], diffStat: [], recentCommits: [], entries: ['a.ts'], truncated: false }, Date.now())
  assert.equal((await f.call('commit_events', { events: [{ start: base, end: base, summary: '看了目录', status: 'direct', sources: [{ kind: 'project_evidence', ref: snapshotOnly.evidenceId }] }] })).committed, 0)

  const listed = await f.call('today')
  assert.equal(listed.workItems.outcomes.length, 2)
  assert.equal(listed.workItems.pendingConfirmation.length, 1)
  assert.ok(listed.workItems.outcomes[0].sources.length > 0, '日报工具返回事项及其证据')
})

test('模型自报 user_confirmed 无效；只有可信批准后才生效', async t => {
  const f = fixture(t)
  const day = await f.call('today', { detail: 'full' })
  const ref = { kind: 'activity_observation', ref: day.allSpans[0].observationId }
  // 工具参数层先拦一道；即使绕过参数校验，事项校验本身也拒绝 user_confirmed。
  await assert.rejects(f.call('commit_events', { events: [{ start: base, end: base, summary: '自批', status: 'user_confirmed', sources: [ref] }] }), /must be one of/)
  const forged = planWorkItem({ start: base, end: base, summary: '自批', status: 'user_confirmed', sources: [ref] }, () => '不应解析')
  assert.equal(forged.ok, false)
  assert.match(forged.ok ? '' : forged.message, /可信审批/)
  assert.equal(f.workItems.listInRange(0, Number.MAX_SAFE_INTEGER).length, 0)
  assert.equal(planWorkItem({ start: 0, end: 0, summary: 'x', status: 'evidence_removed', sources: [] }, () => '不应解析').ok, false)
  const id = (await f.call('commit_events', { events: [{ start: base, end: base, summary: '推断事项', status: 'inferred', sources: [ref] }] })).items[0].id
  assert.equal(f.workItems.confirm(id, { id: 'model', isUser: false }, Date.now()), null)
  const pending = await f.call('confirm_work_items', { ids: [id] })
  assert.equal(pending.pending, true)
  assert.equal(f.workItems.get(id)!.status, 'inferred')
  assert.equal((await f.approvals.decide(pending.proposalId, 'approve', f.bridge.epoch, '聊天令牌')).ok, false)
  assert.equal(f.workItems.get(id)!.status, 'inferred')
  assert.equal((await f.decide(pending.proposalId)).ok, true)
  assert.equal(f.workItems.get(id)!.status, 'user_confirmed')
  assert.equal(f.workItems.get(id)!.confirmedBy, 'desktop-shell')
})

test('删除观察后事项沿来源传播为 evidence_removed，并如实报告', async t => {
  const f = fixture(t)
  const day = await f.call('today', { detail: 'full' })
  const [first, second] = day.allSpans
  const imported = await f.call('import_records', { content: '评审纪要原文', source: 'feishu_export' })
  const committed = await f.call('commit_events', { events: [
    { start: first.start, end: first.end, summary: '写代码（推断）', status: 'inferred', sources: [{ kind: 'activity_observation', ref: first.observationId }] },
    { start: second.start, end: second.end, summary: '写日报', status: 'inferred', sources: [{ kind: 'activity_observation', ref: second.observationId }] },
    { start: first.start, end: first.end, summary: '评审', status: 'direct', sources: [{ kind: 'activity_observation', ref: first.observationId }, { kind: 'import_material', ref: imported.noteId }] },
  ] })
  assert.equal(committed.committed, 3)
  const [onlyFirst, onlySecond, mixed] = committed.items.map((item: { id: string }) => item.id)
  const pending = await f.call('delete_activity', { startMs: first.start, endMs: first.end })
  assert.equal(pending.pending, true)
  assert.equal(f.workItems.get(onlyFirst)!.status, 'inferred', '批准前不传播')
  const result = await f.decide(pending.proposalId)
  assert.equal(result.ok, true, JSON.stringify(result))
  const reported = (result.result as { workItems: { evidenceRemoved: { id: string }[] } }).workItems
  assert.deepEqual(reported.evidenceRemoved.map(item => item.id), [onlyFirst])
  assert.equal(f.workItems.get(onlyFirst)!.status, 'evidence_removed')
  assert.equal(f.workItems.get(onlyFirst)!.sources.length, 0)
  assert.equal(f.workItems.get(onlySecond)!.status, 'inferred')
  assert.equal(f.workItems.get(mixed)!.status, 'direct', '仍有导入原文支撑的事项保留')
  assert.equal(f.observations.get(first.observationId), null)
  const after = await f.call('today')
  assert.equal(after.workItems.evidenceRemoved.count, 1)
  assert.equal(JSON.stringify(after.workItems).includes('写代码（推断）'), false, '证据已删除的事项不回传概括')
  assert.equal((await f.call('confirm_work_items', { ids: [onlyFirst] })).pending, false)
})

test('项目 A 的规则不进项目 B 的证据，也不进全局提示词；列表标明范围', async t => {
  const f = fixture(t)
  const projectA = path.join(f.dir, 'A'), projectB = path.join(f.dir, 'B')
  mkdirSync(projectA); mkdirSync(projectB)
  await f.authorize(projectA)
  await f.authorize(projectB)
  await f.remember({ text: 'A 项目提交信息用英文', topic: '提交规范', projectDir: projectA })
  await f.remember({ text: '回复使用中文', topic: '语言' })
  const evidenceA = await f.call('read_project_evidence', { projectDir: projectA })
  const evidenceB = await f.call('read_project_evidence', { projectDir: projectB })
  assert.deepEqual(evidenceA.projectRules.map((item: { text: string }) => item.text), ['A 项目提交信息用英文'])
  assert.match(evidenceA.projectRulesText, /本项目/)
  assert.ok(evidenceA.evidenceId)
  assert.deepEqual(evidenceB.projectRules, [])
  assert.equal(JSON.stringify(evidenceB).includes('A 项目提交信息用英文'), false)
  const prompt = f.variables.get('personal_assistant_preferences')!()!
  assert.match(prompt, /回复使用中文/)
  assert.equal(prompt.includes('A 项目提交信息用英文'), false)
  assert.equal(f.variables.get('personal_assistant_memory_conflicts')!(), '')
  assert.ok(f.sections.some(text => text.includes(REPORT_EVIDENCE_RULES)), '提示词规定日报证据口径')
  const listed = await f.call('list_preferences')
  const scopes = Object.fromEntries(listed.memories.map((item: { text: string; scope: string }) => [item.text, item.scope]))
  assert.equal(scopes['回复使用中文'], '全局')
  assert.equal(scopes['A 项目提交信息用英文'], `项目 ${projectA}`)
})

test('项目候选规则确认前不随证据返回；冲突暂停；删除照常', async t => {
  const f = fixture(t)
  const project = path.join(f.dir, 'P')
  mkdirSync(project)
  await f.authorize(project)
  const candidate = f.memories.put({ kind: 'user_preference', scopeKind: 'project', scopeId: project, topic: '测试', text: '先跑单测', actor: { id: 'expert', isUser: false } }, Date.now())
  assert.ok(candidate.ok)
  assert.deepEqual((await f.call('read_project_evidence', { projectDir: project })).projectRules, [])
  const resolve = await f.call('resolve_preference', { id: candidate.record.id })
  assert.equal((await f.decide(resolve.proposalId)).ok, true)
  assert.equal((await f.call('read_project_evidence', { projectDir: project })).projectRules.length, 1)
  f.db.prepare(`UPDATE memories SET status = 'conflicting' WHERE memory_id = ?`).run(candidate.record.id)
  const conflicted = await f.call('read_project_evidence', { projectDir: project })
  assert.deepEqual(conflicted.projectRules, [])
  assert.equal(conflicted.projectRuleConflicts.length, 1)
  const forget = await f.call('forget_preference', { id: candidate.record.id })
  assert.equal((await f.decide(forget.proposalId)).ok, true)
  assert.equal(f.memories.get(candidate.record.id, Date.now()), null)
})

test('授权撤销或链接改指后，项目记忆不可读写，旧待批不能落库', async t => {
  const f = fixture(t)
  const revoked = path.join(f.dir, 'revoked')
  mkdirSync(revoked)
  await f.authorize(revoked)
  await f.remember({ text: '只在 revoked 项目生效', topic: '口径', projectDir: revoked })
  const stale = await f.call('remember_preference', { text: '撤销前提交的规则', topic: '口径2', projectDir: revoked })
  assert.equal(stale.pending, true)
  const contextId = f.helpContexts.list().find(item => item.projectDir === revoked)!.id
  assert.equal((await f.call('forget_help_context', { id: contextId })).removed, true)
  assert.equal((await f.decide(stale.proposalId)).ok, false)
  assert.equal(f.memories.listProject(revoked, Date.now()).length, 1)
  assert.equal((await f.call('remember_preference', { text: '新规则', topic: '口径', projectDir: revoked })).pending, false)
  assert.equal((await f.call('read_project_evidence', { projectDir: revoked })).ok, false)
  const listed = await f.call('list_preferences')
  assert.equal(JSON.stringify(listed.memories).includes('只在 revoked 项目生效'), false)
  assert.equal(listed.hiddenProjectMemories, 1)
  const hiddenId = f.memories.listProject(revoked, Date.now())[0]!.id
  assert.equal((await f.call('resolve_preference', { id: hiddenId })).pending, false)

  const linked = path.join(f.dir, 'linked'), outside = path.join(f.dir, 'outside')
  mkdirSync(linked); mkdirSync(outside)
  await f.authorize(linked)
  await f.remember({ text: '只在 linked 项目生效', topic: '口径', projectDir: linked })
  const read = f.workItems.recordProjectEvidence({ projectDir: linked, git: true, branch: 'main', changedFiles: [' M x'], diffStat: [' x | 1 +'], recentCommits: [], entries: [], truncated: false }, Date.now())
  rmSync(linked, { recursive: true, force: true })
  symlinkSync(outside, linked, 'junction')
  assert.equal(f.helpContexts.authorizedScope(linked), null)
  assert.equal((await f.call('read_project_evidence', { projectDir: linked })).ok, false)
  assert.equal((await f.call('remember_preference', { text: '改指后的规则', topic: '口径', projectDir: linked })).pending, false)
  const afterLink = await f.call('list_preferences')
  assert.equal(JSON.stringify(afterLink.memories).includes('只在 linked 项目生效'), false)
  assert.equal(afterLink.hiddenProjectMemories, 2)
  const commit = await f.call('commit_events', { events: [{ start: base, end: base, summary: '改了 x', status: 'direct', sources: [{ kind: 'project_evidence', ref: read.evidenceId }] }] })
  assert.equal(commit.committed, 0, '授权失效的项目证据不能再被引用')
  assert.match(commit.error, /授权已撤销或实际路径已改指/)
})
