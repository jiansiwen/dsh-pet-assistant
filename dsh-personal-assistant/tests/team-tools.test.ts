import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { ApprovalService } from '../src/approval.ts'
import { TeamStore } from '../src/team-domain.ts'
import { TeamService } from '../src/team.ts'
import { registerTeamTools } from '../src/team-tools.ts'

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
  assert.equal(f.tools.size, 6)
  assert.equal(f.prompts.size, 2)
  f.dispose()
  f.dispose()
  assert.equal(f.tools.size, 0)
  assert.equal(f.prompts.size, 0)
  const release = registerTeamTools(f.host, { team: f.team, approvals: f.approvals, bridge: {} as never })
  assert.equal(f.tools.size, 6)
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
