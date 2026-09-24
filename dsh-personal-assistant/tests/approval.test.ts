import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { ApprovalError, ApprovalService, digestOf, planDigestOf, type GateCall } from '../src/approval.ts'
import { TeamStore, type Task } from '../src/team-domain.ts'

function fixture(t: TestContext) {
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  store.upsertMember({ assistantId: 'chief', roleId: 'tangseng', displayName: '总助理', skinId: 'test', persona: '',
    voiceProfile: '', enabled: true, revision: 1, toolPolicy: { mode: 'side-effect', denyTools: [] } })
  const task: Task = { taskId: 'task-1', teamId: 'test', ownerId: 'chief', goal: '测试', inputEvidence: [], acceptance: [],
    toolScope: 'side-effect', budgetTokens: 0, deadlineAt: null, dependsOn: [], status: 'running', revision: 1,
    artifacts: [], originRequestId: null, originChannel: null, createdAt: 1, updatedAt: 1 }
  store.insertTask(task)
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'epoch-1' })
  const call: GateCall = { taskId: task.taskId, assistantId: 'chief', tool: 'write', target: 'test.txt',
    params: { file_path: 'test.txt', content: '测试内容', options: { a: 1, b: 2 } }, inputRevision: 1 }
  const propose = () => approvals.propose({ ...call, summary: '写入测试内容', risk: 'medium' })
  const issue = () => { const proposal = propose(); return { proposal, approval: approvals.issue(proposal.proposalId, { channel: 'desktop-shell' }, true) } }
  return { store, approvals, task, call, propose, issue }
}

const code = (expected: string) => (error: unknown) => error instanceof ApprovalError && error.code === expected

test('凭据和可信主体签发校验', t => {
  const { approvals, propose } = fixture(t)
  assert.equal(approvals.verifyCapabilityToken(approvals.approvalCapabilityToken), true)
  assert.equal(approvals.verifyCapabilityToken(undefined), false)
  assert.equal(approvals.verifyCapabilityToken('x'.repeat(36)), false)
  assert.throws(() => approvals.issue(propose().proposalId, { channel: 'desktop-shell' }, false), code('UNTRUSTED_SUBJECT'))
})

test('真实完整参数匹配、键序无关、单次消费并原子登记', t => {
  const { approvals, call, issue, store } = fixture(t)
  assert.equal(approvals.authorizeCall(call).ok, false)
  const { proposal, approval } = issue()
  assert.equal(approval.planDigest, planDigestOf(proposal))
  assert.equal(JSON.parse(approval.scope).runtimeEpoch, 'epoch-1')
  const reordered = { ...call, params: { options: { b: 2, a: 1 }, content: '测试内容', file_path: 'test.txt' } }
  assert.equal(approvals.authorizeCall(reordered).ok, true)
  assert.equal(approvals.authorizeCall(call).ok, false)
  assert.equal(approvals.operations(call.taskId).length, 1)
  assert.equal(store.eventsSince(0).filter(event => event.type === 'operation/updated').length, 1)
})

test('同目标的内容、成员、版本、工具和任务错配均不消费批准', t => {
  const { approvals, call, issue, store } = fixture(t)
  const { approval, proposal } = issue()
  const mutations: Partial<GateCall>[] = [
    { params: { file_path: 'test.txt', content: '替换成恶意内容' } }, { assistantId: 'other' },
    { inputRevision: 2 }, { tool: 'edit' }, { taskId: 'other-task' }, { target: 'other.txt' },
  ]
  for (const change of mutations) {
    const changed = { ...call, ...change }
    assert.equal(approvals.authorizeCall(changed).ok, false)
    assert.throws(() => approvals.consume(approval.approvalId, changed.tool, changed.taskId, changed), code('DIGEST_MISMATCH'))
  }
  assert.throws(() => approvals.consumeByProposal(proposal.proposalId, 'write'), code('DIGEST_MISMATCH'))
  assert.equal(store.getApproval(approval.approvalId)?.consumedAt, null)
  assert.equal(approvals.authorizeCall(call).ok, true)
})

test('任务修订、状态、权限变化使已批准计划失效', t => {
  const { approvals, call, issue, store, task } = fixture(t)
  const { approval } = issue()
  store.updateTask(task.taskId, task.revision, { status: 'cancelled' })
  assert.throws(() => approvals.consume(approval.approvalId, call.tool, call.taskId, call), code('DIGEST_MISMATCH'))
  assert.equal(approvals.operations().length, 0)
})

test('旧代次和旧版无代次批准在真实消费路径上拒绝', t => {
  const { approvals, store, call, issue } = fixture(t)
  const { proposal, approval } = issue()
  const restarted = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'epoch-2' })
  assert.throws(() => restarted.consumeByProposal(proposal.proposalId, call.tool, call), code('EPOCH_MISMATCH'))
  assert.equal(restarted.authorizeCall(call).ok, false)
  store.insertApproval({ ...approval, approvalId: 'old-format', scope: 'test.txt|desktop-shell' })
  assert.throws(() => approvals.consume('old-format', call.tool, call.taskId, call), code('EPOCH_MISMATCH'))
  assert.equal(approvals.operations().length, 0)
})

test('过期和已驳回提案不可消费，过期待批不展示', t => {
  const { approvals, call, propose } = fixture(t)
  const expired = approvals.propose({ ...call, summary: '已过期', risk: 'low' }, -1)
  assert.throws(() => approvals.issue(expired.proposalId, { channel: 'local-ui' }, true), code('EXPIRED'))
  assert.equal(approvals.pendingProposals().length, 0)
  const rejected = propose()
  approvals.reject(rejected.proposalId, { channel: 'local-ui' }, true)
  assert.throws(() => approvals.consumeByProposal(rejected.proposalId, call.tool, call), code('NOT_FOUND'))
})

test('计划摘要包含工具及成员，特殊 JSON 键不丢失', t => {
  const { propose } = fixture(t)
  const proposal = propose()
  assert.notEqual(planDigestOf(proposal), planDigestOf({ ...proposal, tool: 'bash' }))
  assert.notEqual(planDigestOf(proposal), planDigestOf({ ...proposal, assistantId: 'other' }))
  assert.notEqual(digestOf(JSON.parse('{"__proto__":{"content":"x"}}')), digestOf({}))
})

test('未知操作阻止新批准盲重发，终态不可被迟到结果覆盖', t => {
  const { approvals, call, issue } = fixture(t)
  const first = issue()
  const operation = approvals.consumeByProposal(first.proposal.proposalId, call.tool, call)
  approvals.settle(operation.operationId, 'unknown', '待核查')
  const next = issue()
  assert.throws(() => approvals.consumeByProposal(next.proposal.proposalId, call.tool, call), code('ALREADY_CONSUMED'))
  approvals.settle(operation.operationId, 'succeeded', '可信核查')
  assert.throws(() => approvals.settle(operation.operationId, 'failed', '迟到模型报告'), code('ALREADY_CONSUMED'))
  assert.throws(() => approvals.settle('missing', 'succeeded', null), code('NOT_FOUND'))
})

test('操作插入失败时批准消费一并回滚', t => {
  const { approvals, call, issue, store } = fixture(t)
  const { approval } = issue()
  store.insertOperation = () => { throw new Error('模拟存储失败') }
  assert.throws(() => approvals.consume(approval.approvalId, call.tool, call.taskId, call), /模拟存储失败/)
  assert.equal(store.getApproval(approval.approvalId)?.consumedAt, null)
})
