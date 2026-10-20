/**
 * 主动提醒打通到真实帮助任务（M3-07）。
 *
 * 每条都是「打扰用户」或「越权读取」的闸门：拒绝与不回应时一个字节都不读；专注、会议、已在一起看时不打扰；
 * 关闭写进插件现有的 user_flags，重启后仍然关闭；接受之后先给候选、再经可信审批确认读取范围，
 * 之后每一处改动、每一条命令都要单独批准，并能沿 episode → 授权 → 帮助任务 → 账本追溯。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { ApprovalService } from '../src/approval.ts'
import { AssistantApprovalService } from '../src/assistant-approval.ts'
import { HelpContextStore, HelpEpisodeStore, PROACTIVE_ACCEPT_GUIDANCE, helpCandidates, registerHelpEpisodeTools } from '../src/help-context.ts'
import {
  ProactiveHelpFlow, REMIND_MESSAGE, SUGGEST_DISABLE_MESSAGE, type FlagStore, type ProactiveConfig, type ProactiveInput,
} from '../src/proactive.ts'
import { getUserFlag, openAssistantStore, setUserFlag } from '../src/store.ts'
import { TeamStore } from '../src/team-domain.ts'
import { TeamService } from '../src/team.ts'

const config: ProactiveConfig = { enabled: true, idleMs: 480_000, cooldownMs: 3_600_000 }
const HOUR = 3_600_000
const desktop = { channel: 'desktop-shell' } as const
const quiet = { info() {}, warn() {}, error() {} }

function input(now: number, overrides: Partial<ProactiveInput> = {}): ProactiveInput {
  return {
    now, idleMs: 600_000, focusMode: false, stageVisible: true, captureActive: true, sampleAt: now, sampleIntervalMs: 5000,
    developmentApp: true, taskRunning: false, ...overrides,
  }
}

function harness(t: TestContext) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'dsh-proactive-help-')))
  const root = path.join(dir, 'repo')
  mkdirSync(path.join(root, 'src'), { recursive: true })
  mkdirSync(path.join(root, 'test'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'calc.js'), 'function add(a, b) {\n  return a - b\n}\nmodule.exports = { add }\n')
  writeFileSync(path.join(root, 'test', 'calc.test.js'),
    "const test = require('node:test')\nconst assert = require('node:assert')\nconst { add } = require('../src/calc.js')\n"
    + "test('add', () => assert.strictEqual(add(2, 3), 5))\n")
  const dbPath = path.join(dir, 'assistant.sqlite')
  const handles: Array<{ close(): void }> = []
  const openDb = () => {
    const db = openAssistantStore(dbPath)
    handles.push(db)
    const flags: FlagStore = { get: key => getUserFlag(db, key), set: (key, value) => setUserFlag(db, key, value) }
    return { db, flags, episodes: new HelpEpisodeStore(db), helpContexts: new HelpContextStore(db) }
  }
  t.after(() => {
    for (const handle of handles) { try { handle.close() } catch { /* 已关闭 */ } }
    rmSync(dir, { recursive: true, force: true })
  })
  let factsCalls = 0
  const makeFlow = (opened: ReturnType<typeof openDb>) => new ProactiveHelpFlow({
    flags: opened.flags, config, episodes: opened.episodes,
    facts: () => {
      factsCalls += 1
      return { sessionCwd: root, foreground: { process: 'Code', title: 'calc.js - repo - Visual Studio Code' }, authorized: opened.helpContexts.list() }
    },
  })
  return { dir, root, openDb, makeFlow, factsCalls: () => factsCalls }
}

test('提醒是中性的固定文案；同一空闲段只提醒一次；冷却跨空闲段生效；提醒本身不生成候选', t => {
  const h = harness(t)
  const opened = h.openDb()
  const flow = h.makeFlow(opened)
  const t0 = 10 * HOUR
  const first = flow.evaluate(input(t0))
  assert.deepEqual(first, { kind: 'remind', message: REMIND_MESSAGE })
  assert.equal(opened.episodes.list()[0]?.state, 'offered')
  assert.deepEqual(flow.evaluate(input(t0 + 60_000)), { kind: 'none', reason: 'already-reminded-in-period' })
  flow.evaluate(input(t0 + 120_000, { idleMs: 1000 }))
  assert.deepEqual(flow.evaluate(input(t0 + 20 * 60_000)), { kind: 'none', reason: 'cooldown' }, '新的空闲段也要等冷却')
  assert.equal(h.factsCalls(), 0, '只是提醒，什么都不读')
})

test('拒绝或不回应：不生成候选、不读取任何东西；同一空闲段不再打扰', t => {
  const h = harness(t)
  const opened = h.openDb()
  const flow = h.makeFlow(opened)
  const t0 = 10 * HOUR
  assert.equal(flow.evaluate(input(t0)).kind, 'remind')
  flow.feedback('decline', t0 + 1000)
  const declined = opened.episodes.list()[0]!
  assert.equal(declined.state, 'declined')
  assert.deepEqual(declined.candidates, [])
  assert.deepEqual(flow.evaluate(input(t0 + 5 * 60_000)), { kind: 'none', reason: 'already-reminded-in-period' })

  // 不回应：气泡挂着没人理。下一次提醒（冷却之后的新空闲段）把它判成过期，同样什么都不读。
  flow.evaluate(input(t0 + HOUR, { idleMs: 1000 }))
  assert.equal(flow.evaluate(input(t0 + 2 * HOUR)).kind, 'remind')
  flow.evaluate(input(t0 + 2 * HOUR + 1000, { idleMs: 1000 }))
  assert.equal(flow.evaluate(input(t0 + 4 * HOUR)).kind, 'remind')
  const [latest, ignored] = opened.episodes.list()
  assert.equal(latest?.state, 'offered')
  assert.equal(ignored?.state, 'expired', '没人回应的提醒过期，不追问')
  assert.equal(h.factsCalls(), 0, '拒绝与不回应两条路上一次都没有生成候选')
  assert.equal(opened.helpContexts.list().length, 0)
})

test('专注、会议期间抑制且不消耗冷却；已经在一起看时不再提醒', t => {
  const h = harness(t)
  const opened = h.openDb()
  const flow = h.makeFlow(opened)
  const t0 = 10 * HOUR
  assert.deepEqual(flow.evaluate(input(t0, { focusMode: true })), { kind: 'none', reason: 'focus-mode' })
  assert.deepEqual(flow.evaluate(input(t0, { meetingActive: true })), { kind: 'none', reason: 'meeting' })
  assert.equal(flow.state.lastNotifiedAt, null, '抑制不算打扰过')
  assert.equal(flow.evaluate(input(t0 + 1000)).kind, 'remind', '会议结束后照常提醒')
  flow.feedback('accept', t0 + 2000)
  flow.evaluate(input(t0 + 3000, { idleMs: 1000 }))
  assert.deepEqual(flow.evaluate(input(t0 + 2 * HOUR - 60_000)), { kind: 'none', reason: 'help-in-progress' })
})

test('关闭写进插件现有的 user_flags：重启后仍然关闭；冷却与连续拒绝也跨重启', t => {
  const h = harness(t)
  const first = h.openDb()
  const flow = h.makeFlow(first)
  const t0 = 10 * HOUR
  assert.equal(flow.evaluate(input(t0)).kind, 'remind')
  first.db.close()
  // 重启：同一个库、新的状态机。刚提醒过的用户不该因为重启马上又被打扰。
  const second = h.openDb()
  const restarted = h.makeFlow(second)
  assert.equal(restarted.state.lastNotifiedAt, t0)
  assert.deepEqual(restarted.evaluate(input(t0 + 20 * 60_000)), { kind: 'none', reason: 'cooldown' })
  restarted.feedback('disable', t0 + 21 * 60_000)
  assert.equal(getUserFlag(second.db, 'proactive_disabled'), 'true')
  second.db.close()
  const third = h.openDb()
  const again = h.makeFlow(third)
  assert.equal(again.state.disabled, true)
  assert.deepEqual(again.evaluate(input(t0 + 5 * HOUR)), { kind: 'none', reason: 'disabled' })
  again.feedback('enable', t0 + 6 * HOUR)
  assert.equal(again.evaluate(input(t0 + 6 * HOUR + 1000)).kind, 'remind', '用户重新打开后恢复')
  assert.equal(h.factsCalls(), 0)
})

test('接受后先给候选，再经可信审批确认读取范围；之后的改动、执行、验证接入同一帮助任务，账本可追溯；一次「好」不授权任何副作用', async t => {
  const h = harness(t)
  const opened = h.openDb()
  const flow = h.makeFlow(opened)
  const t0 = Date.now()
  assert.equal(flow.evaluate(input(t0)).kind, 'remind')
  flow.feedback('accept', t0 + 1000)
  assert.equal(h.factsCalls(), 1, '只有接受时才生成候选')
  const episode = opened.episodes.list()[0]!
  assert.equal(episode.state, 'accepted')
  assert.deepEqual(episode.candidates.map(item => item.kind), ['session-project', 'window'])
  assert.equal(episode.candidates[0]!.projectDir, h.root)
  assert.equal(episode.candidates[1]!.projectDir, null, '窗口候选不猜目录')

  // 桌面审批服务（与真实装配相同：bridge.submitAssistant → AssistantApprovalService）。
  const assistantApprovals = new AssistantApprovalService({ epoch: 'epoch-1', ttlMs: 60_000 })
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  const release = registerHelpEpisodeTools({
    tools: { register: (tool: unknown) => { const row = tool as { name: string; execute(args: unknown, exec: unknown): Promise<string> }; tools.set(row.name, row); return () => tools.delete(row.name) } },
    systemPrompt: { section: () => () => undefined },
  }, { episodes: opened.episodes, helpContexts: opened.helpContexts, submit: submission => assistantApprovals.submit(submission) })
  t.after(release)
  const call = async (name: string, args: unknown) => JSON.parse(await tools.get(name)!.execute(args, {}))
  const listed = await call('personal_assistant_help_candidates', {})
  assert.equal(listed.ok, true)
  assert.equal(listed.episodeId, episode.id)
  const chosen = await call('personal_assistant_help_choose', { episodeId: episode.id, candidateId: 'c1', note: '加法结果不对' })
  assert.equal(chosen.pending, true)
  assert.equal(opened.helpContexts.list().length, 0, '选定候选不等于授权')
  assert.equal(opened.episodes.get(episode.id)?.state, 'scope-pending')
  assert.equal((await call('personal_assistant_help_choose', { episodeId: episode.id, candidateId: 'c2' })).pending, false, '窗口候选要用户说出目录')

  // 团队账本与帮助任务服务（与装配相同：helpScopes = HelpContextStore，episodes = HelpEpisodeStore）。
  const store = new TeamStore(':memory:')
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'epoch-1' })
  const team = new TeamService({} as never, store, { teamId: 'test', provider: 'spawn', seats: [], maxConcurrentInference: 1,
    maxConcurrentSideEffect: 1, taskTimeoutMs: 1000, defaultBudgetTokens: 0, denyExpertTools: [], approvals, logger: quiet,
    helpScopes: opened.helpContexts, episodes: opened.episodes })
  team.ensureRoster()
  t.after(async () => { await team.dispose(); store.close() })
  assert.throws(() => team.help.openTask({ projectDir: h.root, goal: '读取范围还没批准', episodeId: episode.id }), /没有有效的帮助授权/)

  const decided = await assistantApprovals.decide(chosen.proposalId, 'approve', 'epoch-1', assistantApprovals.approvalCapabilityToken)
  assert.equal(decided.ok, true)
  const [context] = opened.helpContexts.list()
  assert.equal(context?.episodeId, episode.id)
  assert.equal(opened.episodes.get(episode.id)?.state, 'scoped')
  assert.equal(opened.episodes.get(episode.id)?.helpContextId, context?.id)

  const { task, link } = team.help.openTask({ projectDir: h.root, goal: '修复加法', episodeId: episode.id, helpContextId: context!.id })
  assert.equal(link.episodeId, episode.id)
  assert.equal(opened.episodes.get(episode.id)?.taskId, task.taskId)

  // 同意一起看 + 读取范围获批，都不等于同意改动：改动卡仍待批，文件不动；读取范围的批准凭据也批不了改动卡。
  const read = team.help.read({ taskId: task.taskId, path: 'src/calc.js' }) as { hash: string }
  const proposed = team.help.proposeChange({ taskId: task.taskId, summary: '加法写成了减法',
    files: [{ path: 'src/calc.js', baseHash: read.hash, diff: '@@ -2,1 +2,1 @@\n-  return a - b\n+  return a + b\n' }] })
  const calc = path.join(h.root, 'src', 'calc.js')
  assert.match(readFileSync(calc, 'utf8'), /a - b/)
  assert.equal((await assistantApprovals.decide(proposed.proposalId, 'approve', 'epoch-1', assistantApprovals.approvalCapabilityToken)).ok, false)
  assert.equal(approvals.verifyCapabilityToken(assistantApprovals.approvalCapabilityToken), false, '两套审批凭据互不通用')
  assert.match(readFileSync(calc, 'utf8'), /a - b/)

  approvals.issue(proposed.proposalId, desktop, true)
  assert.equal((await team.help.wait(proposed.proposalId, new AbortController().signal, 10_000)).outcome?.state, 'applied')
  assert.match(readFileSync(calc, 'utf8'), /a \+ b/)
  const verification = team.help.proposeVerification({ taskId: task.taskId, program: process.execPath, args: ['--test', 'test/calc.test.js'],
    timeoutSeconds: 60, expectedEffects: '只运行单元测试，不修改源文件' })
  assert.equal(approvals.operations(task.taskId).filter(item => item.kind === 'run_verification').length, 0, '验证命令同样要单独批准')
  approvals.issue(verification.proposalId, desktop, true)
  const ran = await team.help.wait(verification.proposalId, new AbortController().signal, 60_000)
  assert.equal(ran.outcome?.state, 'passed')

  // 追溯：episode → 授权 → 帮助任务 → 账本（每一步的目标、输入摘要、开始、结果与验收证据）。
  assert.equal(store.getHelpTask(task.taskId)?.episodeId, episode.id)
  assert.equal(store.getHelpTask(task.taskId)?.helpContextId, context!.id)
  const operations = approvals.operations(task.taskId)
  assert.deepEqual(operations.map(item => [item.kind, item.state]).sort(), [['apply_change', 'succeeded'], ['run_verification', 'succeeded']])
  for (const operation of operations) {
    assert.ok(operation.target && operation.paramsDigest && operation.startedAt && operation.executedAt && operation.resultDetail && operation.evidence)
  }
  assert.equal((operations.find(item => item.kind === 'run_verification')!.evidence as { exitCode: number }).exitCode, 0)
  assert.equal(team.help.verdict(task.taskId).mayClaimFixed, true)
  assert.equal(store.getTask(task.taskId)?.status, 'done')
})

test('措辞中性：提醒、建议关闭、接受引导与候选都不把一段时间没有输入说成遇到困难', () => {
  const candidates = helpCandidates({ sessionCwd: path.resolve('/repo'), foreground: { process: 'Code', title: 'a.ts - repo' },
    authorized: [{ id: 'help-1', projectDir: path.resolve('/old'), currentFile: null, note: null, createdAt: 1, episodeId: null }] })
  assert.deepEqual(candidates.map(item => item.kind), ['session-project', 'authorized', 'window'])
  const texts = [REMIND_MESSAGE, SUGGEST_DISABLE_MESSAGE, PROACTIVE_ACCEPT_GUIDANCE, ...candidates.map(item => item.label)]
  for (const text of texts) {
    assert.doesNotMatch(text, /困难|卡住|卡壳|遇到(了)?问题|出(了)?问题|不会|需要帮助|stuck|struggl/i, text)
  }
  assert.match(PROACTIVE_ACCEPT_GUIDANCE, /确认之前，不要读取任何项目内容/)
})
