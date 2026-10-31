import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ApprovalService } from '../src/approval.ts'
import { TeamStore } from '../src/team-domain.ts'
import { gateDecision, installApprovalGate, installReadOnlyGate, installDelegationReadOnlyGate } from '../src/gate.ts'

// 使用宿主现有传递依赖，不安装依赖，也不加载模型或真实文件执行器。
const require = createRequire(import.meta.url)
const hostRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'))
const { default: SystemPrompt } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-system-prompt')).href)
const { createScope } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-scope')).href)

async function host(t: TestContext) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const key = { id: 'child' } as Agent
  let scope!: { ctx: Context; dispose(): Promise<void> }
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt'] }))
  Object.assign(key, { ctx: scope.ctx })
  Object.defineProperty(scope.ctx, 'agent', { value: key, configurable: true })
  t.after(() => scope.dispose())
  const calls: string[] = []
  const register = (name: string, local = false, failure = false) => {
    const tool: ToolDefinition = {
      name, description: '无副作用测试替身', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: '测试成功' }] },
      async execute() { calls.push(name); if (failure) throw new Error('可能部分完成'); return '测试成功' },
    }
    ;(local ? scope.ctx : ctx).tools.register(tool)
  }
  const run = (name: string, args: unknown = {}, agent: Agent | undefined = key) => ctx.tools.execute({
    callId: 'test-call' as never, name, arguments: args, agent, signal: new AbortController().signal,
  })
  return { ctx, scope, key, calls, register, run }
}

function approvals(t: TestContext) {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  store.upsertMember({ assistantId: 'chief', roleId: 'tangseng', displayName: '总助理', skinId: 'test', persona: '',
    voiceProfile: '', enabled: true, revision: 1, toolPolicy: { mode: 'side-effect', denyTools: [] } })
  store.insertTask({ taskId: 'task', teamId: 'test', ownerId: 'chief', goal: '测试', inputEvidence: [], acceptance: [],
    toolScope: 'side-effect', budgetTokens: 0, deadlineAt: null, dependsOn: [], status: 'running', revision: 1,
    artifacts: [], originRequestId: null, originChannel: null, createdAt: 1, updatedAt: 1 })
  return new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'test' })
}

test('未知工具、控制能力、再委派和混合副作用技能默认拒绝', () => {
  for (const name of ['future', 'personal_assistant_write', 'desktop_team_assign', 'todo_write', 'skill', '__proto__']) {
    assert.equal(gateDecision(name, {}).kind, 'unbound')
  }
  assert.equal(gateDecision('write', {}).kind, 'unbound')
  assert.equal(gateDecision('write', { file_path: 'a' }).kind, 'gated')
  assert.equal(gateDecision('str_replace_editor', { command: 'view', path: 'a' }).kind, 'open')
})

test('真实宿主执行链：只读集合拦继承及自身层副作用，不影响主会话', async t => {
  const h = await host(t)
  for (const name of ['read', 'write', 'personal_assistant_remember', 'desktop_team_assign']) h.register(name)
  h.register('local_write', true)
  h.register('report', true)
  installReadOnlyGate(h.key)
  const parent = { id: 'parent' } as Agent
  for (const name of ['write', 'personal_assistant_remember', 'desktop_team_assign', 'local_write']) {
    assert.equal((await h.run(name)).isError, true)
  }
  assert.equal((await h.run('read')).isError, false)
  assert.equal((await h.run('report')).isError, false)
  assert.equal((await h.run('write', {}, parent)).isError, false)
  assert.deepEqual(h.calls, ['read', 'report', 'write'])
  assert.throws(() => installReadOnlyGate({} as Agent), /agent.ctx/)
  assert.throws(() => installReadOnlyGate(h.ctx as never), '全局上下文不能冒充精确代理')
})

test('真实宿主启动前守卫：随机持久标签精确匹配，释放不影响普通会话', async t => {
  const h = await host(t)
  h.register('write')
  const events = [{ type: 'subagent/descriptor', data: { label: 'run-1' } }]
  Object.assign(h.key, { session: { header: { parentSession: 'parent' }, events, snapshotEvents: () => events } })
  const release = installDelegationReadOnlyGate(h.ctx, 'parent', 'run-1', [])
  const blocked = await h.run('write')
  assert.equal(blocked.isError, true)
  assert.match(JSON.stringify(blocked.content), /只读委派禁止/u, '必须由定向门禁拒绝，不能靠替身异常误判')
  assert.equal((await h.run('write', {}, { id: 'parent' } as Agent)).isError, false)
  release()
  assert.equal((await h.run('write')).isError, false)
})

test('真实宿主审批门禁：完整参数、成员和版本绑定，真实结果自动结账且只执行一次', async t => {
  const h = await host(t)
  const service = approvals(t)
  h.register('write')
  const params = { file_path: 'virtual.txt', content: '原批准内容' }
  const proposal = service.propose({ taskId: 'task', assistantId: 'chief', tool: 'write', target: 'virtual.txt',
    params, inputRevision: 1, summary: '测试提案', risk: 'low' })
  service.issue(proposal.proposalId, { channel: 'local-ui' }, true)
  const release = installApprovalGate(h.key, { taskId: 'task', assistantId: 'chief', inputRevision: 1, approvals: service, label: '测试' })
  assert.equal((await h.run('write', { ...params, content: '被替换' })).isError, true)
  assert.equal((await h.run('write', params)).isError, false)
  assert.equal(service.operations()[0]?.state, 'succeeded')
  assert.equal((await h.run('write', params)).isError, true)
  assert.deepEqual(h.calls, ['write'])
  release()
  assert.equal((await h.run('write', params)).isError, false)
})

test('工具失败不冒充无副作用，未知账目阻止盲重试', async t => {
  const h = await host(t)
  const service = approvals(t)
  h.register('write', false, true)
  const params = { file_path: 'virtual.txt', content: '测试' }
  const proposal = service.propose({ taskId: 'task', assistantId: 'chief', tool: 'write', target: 'virtual.txt', params,
    inputRevision: 1, summary: '测试提案', risk: 'low' })
  service.issue(proposal.proposalId, { channel: 'local-ui' }, true)
  installApprovalGate(h.key, { taskId: 'task', assistantId: 'chief', inputRevision: 1, approvals: service, label: '测试' })
  assert.equal((await h.run('write', params)).isError, true)
  assert.equal(service.operations()[0]?.state, 'unknown')
  assert.equal((await h.run('write', params)).isError, true)
  assert.equal(h.calls.length, 1)
})
