import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { ApprovalService } from '../src/approval.ts'
import { TeamStore } from '../src/team-domain.ts'
import { TeamService } from '../src/team.ts'
import { registerTeamTools } from '../src/team-tools.ts'
import { helpHost } from './support/help-host.ts'

function fixture(t: TestContext) {
  const store = new TeamStore(':memory:')
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'test' })
  const team = new TeamService({} as never, store, { teamId: 'test', provider: 'spawn', seats: [],
    maxConcurrentInference: 1, maxConcurrentSideEffect: 1, taskTimeoutMs: 1000, defaultBudgetTokens: 0,
    denyExpertTools: [], approvals, logger: { info() {}, warn() {}, error() {} } })
  team.ensureRoster()
  t.after(async () => { await team.dispose(); store.close() })
  const tools = new Map<string, { name: string; execute(args: unknown, exec: unknown): Promise<string> }>()
  const prompts = new Set<string>()
  const host = { tools: { register(tool: unknown) { const row = tool as { name: string; execute(args: unknown, exec: unknown): Promise<string> }; tools.set(row.name, row); return () => { tools.delete(row.name) } } },
    systemPrompt: {
      section: ({ name }: { name: string }) => { prompts.add(name); return () => { prompts.delete(name) } },
      variable: (name: string) => { prompts.add(name); return () => { prompts.delete(name) } },
    } }
  const dispose = registerTeamTools(host, { team, approvals, bridge: {} as never })
  const execute = async (name: string, args: unknown) => JSON.parse(await tools.get(name)!.execute(args, {}))
  return { team, store, approvals, execute, dispose, tools, prompts, host }
}

test('关闭团队会撤销工具和提示词，再次开启不会留下旧注册', t => {
  const f = fixture(t)
  // 6 个团队工具 + unknown 人工复核入口；没装配帮助授权时不注册帮助任务的读取 / 改动 / 验证工具。
  assert.equal(f.tools.size, 7)
  assert.ok(f.tools.has('desktop_team_review_unknown'))
  assert.equal(f.tools.has('desktop_team_propose_change'), false)
  assert.equal(f.prompts.size, 2)
  f.dispose()
  f.dispose()
  assert.equal(f.tools.size, 0)
  assert.equal(f.prompts.size, 0)
  const release = registerTeamTools(f.host, { team: f.team, approvals: f.approvals, bridge: {} as never })
  assert.equal(f.tools.size, 7)
  release()
  assert.equal(f.tools.size, 0)
})

test('部分注册失败时撤销此前已注册的工具', t => {
  const f = fixture(t)
  f.dispose()
  assert.throws(() => registerTeamTools({
    ...f.host,
    systemPrompt: { ...f.host.systemPrompt, section() { throw new Error('模拟注册失败') } },
  }, { team: f.team, approvals: f.approvals, bridge: {} as never }), /模拟注册失败/)
  assert.equal(f.tools.size, 0)
  assert.equal(f.prompts.size, 0)
})

test('提案参数必须完整、目标一致，不能冒领其他成员身份', async t => {
  const f = fixture(t)
  const task = f.team.submitTask({ goal: '测试', ownerId: 'member-wukong' })
  const input = { taskId: task.taskId, summary: '计划', tool: 'write', target: 'virtual.txt', risk: 'low' }
  await assert.rejects(f.execute('desktop_team_propose_action', input), /params/)
  assert.equal((await f.execute('desktop_team_propose_action', { ...input, params: { file_path: 'other.txt' } })).ok, false)
  assert.equal((await f.execute('desktop_team_propose_action', { ...input, assistantId: 'member-tangseng', params: { file_path: 'virtual.txt' } })).ok, false)
  const result = await f.execute('desktop_team_propose_action', { ...input, params: { file_path: 'virtual.txt', content: '测试' } })
  assert.equal(result.ok, true)
  assert.equal(f.approvals.proposal(result.proposalId)?.assistantId, task.ownerId)
  assert.match(result.note, /不执行副作用/)
})

test('模型不能用结账工具把未知操作改成成功，也不能串用操作 id', async t => {
  const f = fixture(t)
  const original = f.team.submitTask({ goal: '可信执行器任务', toolScope: 'side-effect' })
  const task = f.store.updateTask(original.taskId, original.revision, { status: 'running' })!
  const call = { taskId: task.taskId, assistantId: task.ownerId, inputRevision: task.revision,
    tool: 'write', target: 'virtual.txt', params: { file_path: 'virtual.txt', content: '测试' } }
  const proposal = f.approvals.propose({ ...call, summary: '测试', risk: 'low' })
  f.approvals.issue(proposal.proposalId, { channel: 'local-ui' }, true)
  const operation = f.approvals.consumeByProposal(proposal.proposalId, call.tool, call)
  f.approvals.settle(operation.operationId, 'unknown', '需要核查')
  const result = await f.execute('desktop_team_finish_operation', { proposalId: proposal.proposalId, state: 'succeeded', resultDigest: '模型自报' })
  assert.equal(result.state, 'unknown')
  assert.equal(f.store.getOperation(operation.operationId)?.resultDigest, '需要核查')
  assert.equal((await f.execute('desktop_team_finish_operation', { proposalId: proposal.proposalId, operationId: 'other-operation' })).ok, false)
})

test('提案的写类目标按会话工作区规范化成真实路径，越出工作区（含相似前缀）直接拒绝', async t => {
  const f = fixture(t)
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'dsh-propose-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'ws')
  mkdirSync(root)
  mkdirSync(path.join(base, 'ws-other'))
  const task = f.team.submitTask({ goal: '提案规范化', ownerId: 'member-tangseng', toolScope: 'side-effect' })
  const exec = { agent: { session: { header: { cwd: root } } } }
  const propose = async (target: string) => JSON.parse(await f.tools.get('desktop_team_propose_action')!.execute(
    { taskId: task.taskId, summary: '写入', tool: 'write', target, risk: 'low', params: { file_path: target, content: '内容' } }, exec))
  const inside = await propose('docs/a.md')
  assert.equal(inside.ok, true)
  assert.equal(inside.target, path.join(root, 'docs', 'a.md'))
  assert.equal(f.approvals.proposal(inside.proposalId)?.target, path.join(root, 'docs', 'a.md'), '批准绑定执行时真正会写到的位置')
  const sibling = await propose(path.join(base, 'ws-other', 'a.md'))
  assert.equal(sibling.ok, false)
  assert.match(sibling.error, /不在会话工作区/)
  assert.equal(f.approvals.pendingProposals().length, 1)
})

test('装配帮助授权后注册帮助任务工具：模型经工具只能读授权范围、提交提案，写文件与结论都轮不到它', async t => {
  const h = helpHost(t)
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  const host = {
    tools: { register(tool: unknown) { const row = tool as { name: string; execute(args: unknown, exec: unknown): Promise<string> }; tools.set(row.name, row); return () => { tools.delete(row.name) } } },
    systemPrompt: { section: () => () => undefined, variable: () => () => undefined },
  }
  registerTeamTools(host, { team: h.team, approvals: h.approvals, bridge: {} as never })
  for (const name of ['desktop_team_open_help_task', 'desktop_team_read_file', 'desktop_team_propose_change',
    'desktop_team_propose_verification', 'desktop_team_wait', 'desktop_team_review_unknown']) assert.ok(tools.has(name), name)
  for (const name of ['write', 'edit', 'bash']) assert.equal(tools.has(name), false, '插件不提供直接写文件或执行命令的工具')
  const call = async (name: string, args: unknown) => JSON.parse(await tools.get(name)!.execute(args, {}))

  assert.equal((await call('desktop_team_open_help_task', { projectDir: h.root, goal: '未授权' })).code, 'NOT_AUTHORIZED')
  const context = h.authorize()
  const opened = await call('desktop_team_open_help_task', { projectDir: h.root, goal: '修复加法', helpContextId: context.id })
  assert.equal(opened.ok, true)
  assert.equal(opened.status, 'awaiting-user')
  const read = await call('desktop_team_read_file', { taskId: opened.taskId, path: 'src/calc.js' })
  assert.equal(read.ok, true)
  assert.equal((await call('desktop_team_read_file', { taskId: opened.taskId, path: '../repo-other/secret.txt' })).code, 'OUT_OF_SCOPE')
  const before = readFileSync(h.calc, 'utf8')
  const proposed = await call('desktop_team_propose_change', { taskId: opened.taskId, summary: '加法写成了减法',
    files: [{ path: 'src/calc.js', baseHash: read.hash, diff: '@@ -2,1 +2,1 @@\n-  return a - b\n+  return a + b\n' }] })
  assert.equal(proposed.ok, true)
  assert.equal(readFileSync(h.calc, 'utf8'), before, '提案不写文件')
  const waited = await call('desktop_team_wait', { proposalId: proposed.proposalId, timeoutSeconds: 1 })
  assert.equal(waited.decision, 'still-pending')
  assert.equal(h.approvals.proposal(proposed.proposalId)?.state, 'pending', '等待超时不作废审批卡')
  const status = await call('desktop_team_status', { taskId: opened.taskId })
  assert.equal(status.help.verdict.mayClaimFixed, false)
  assert.equal(status.help.changes[0].state, 'pending')
  assert.equal(status.help.episodeId, null)
})
