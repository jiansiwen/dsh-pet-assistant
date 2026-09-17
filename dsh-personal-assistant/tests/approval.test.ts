/**
 * ApprovalService 的单测（真 TeamStore + 临时目录库）。
 *
 * 这条链路原先只有 smoke 覆盖，进不了单测的原因是本文件用了构造函数参数属性 ——
 * 已改成显式字段。审批是安全核心，这里的每一条都对应一次"本不该发生的副作用"：
 * 不可信主体签发、过期批准、重放、无批准调用、代次错位。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { ApprovalError, ApprovalService, planDigestOf } from '../src/approval.ts'
import { TeamStore } from '../src/team-domain.ts'

function service(ttlMs = 60_000): { approvals: ApprovalService; store: TeamStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'approval-test-'))
  const store = new TeamStore(path.join(dir, 'team.sqlite'))
  return {
    approvals: new ApprovalService(store, { ttlMs, runtimeEpoch: 'epoch-1' }),
    store,
    dir,
  }
}

function input(taskId = 'task-1') {
  return {
    taskId,
    assistantId: 'member-wukong',
    summary: '写一份修改计划到仓库',
    tool: 'write',
    target: 'repo/README.md',
    params: { content: 'hello' },
    inputRevision: 1,
    risk: 'medium' as const,
  }
}

test('凭据校验：正确 token 通过，错的和缺的都不过（常量时间比较）', () => {
  const { approvals, store, dir } = service()
  try {
    assert.equal(approvals.verifyCapabilityToken(approvals.approvalCapabilityToken), true)
    assert.equal(approvals.verifyCapabilityToken('x'.repeat(36)), false)
    assert.equal(approvals.verifyCapabilityToken(undefined), false)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('提案 → 签发 → 消费 → 重放被拒：批准一次、执行一次', () => {
  const { approvals, store, dir } = service()
  try {
    const proposal = approvals.propose(input())
    assert.equal(proposal.state, 'pending')

    const subject = { channel: 'desktop-shell' as const, windowId: 7 }
    assert.throws(() => approvals.issue(proposal.proposalId, subject, false), (error: unknown) =>
      error instanceof ApprovalError && error.code === 'UNTRUSTED_SUBJECT',
      '不可信主体不得签发')

    const approval = approvals.issue(proposal.proposalId, subject, true)
    assert.equal(approval.planDigest, planDigestOf(proposal))
    assert.equal(approval.scope, 'repo/README.md|desktop-shell')

    const operation = approvals.consumeByProposal(proposal.proposalId, 'write')
    assert.equal(operation.state, 'planned')

    assert.throws(() => approvals.consumeByProposal(proposal.proposalId, 'write'), (error: unknown) =>
      error instanceof ApprovalError && error.code === 'ALREADY_CONSUMED',
      '同一条批准只能执行一次')
    assert.equal(approvals.operations('task-1').length, 1, '操作账目只有一条')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('过期提案签发被拒并标记 expired；pendingProposals 不把过期提案报给用户', () => {
  const { approvals, store, dir } = service()
  try {
    const proposal = approvals.propose(input(), 1) // 1ms TTL
    const subject = { channel: 'desktop-shell' as const }
    assert.throws(() => approvals.issue(proposal.proposalId, subject, true), (error: unknown) =>
      error instanceof ApprovalError && error.code === 'EXPIRED')
    assert.equal(store.getProposal(proposal.proposalId)?.state, 'expired')
    assert.equal(approvals.pendingProposals().length, 0, '过期提案不算待办')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('驳回后的提案没有批准可消费', () => {
  const { approvals, store, dir } = service()
  try {
    const proposal = approvals.propose(input())
    approvals.reject(proposal.proposalId, { channel: 'desktop-shell' as const }, true)
    assert.throws(() => approvals.consumeByProposal(proposal.proposalId, 'write'), (error: unknown) =>
      error instanceof ApprovalError && error.code === 'NOT_FOUND')
    assert.equal(approvals.operations('task-1').length, 0, '被拒绝的提案不留下任何副作用账目')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('运行时代次变化：旧代次 presented 直接 EPOCH_MISMATCH', () => {
  const { approvals, store, dir } = service()
  try {
    approvals.assertEpoch('epoch-1')
    assert.throws(() => approvals.assertEpoch('epoch-of-a-dead-process'), (error: unknown) =>
      error instanceof ApprovalError && error.code === 'EPOCH_MISMATCH')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('执行点门禁：没提案给纠正话术，批准过才放行，且放行即消费', () => {
  const { approvals, store, dir } = service()
  try {
    const call = { taskId: 'task-1', assistantId: 'member-wukong', tool: 'write', target: 'repo/README.md' }

    const blocked = approvals.authorizeCall(call)
    assert.equal(blocked.ok, false)
    if (!blocked.ok) assert.match(blocked.reason, /propose_action/, '拒绝话术要教模型走提案')

    const proposal = approvals.propose(input())
    approvals.issue(proposal.proposalId, { channel: 'desktop-shell' as const }, true)

    const allowed = approvals.authorizeCall(call)
    assert.equal(allowed.ok, true)
    if (allowed.ok) assert.ok(allowed.operationId)

    const replay = approvals.authorizeCall(call)
    assert.equal(replay.ok, false, '同一批准不消费第二次')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
