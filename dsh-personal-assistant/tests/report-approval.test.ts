/** 日报审批回归：真实 SQLite、真实发布文件；采集器与模型均不启动。 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { ApprovalError } from '../src/approval.ts'
import { SessionBridge } from '../src/bridge.ts'
import type { MemoryStore } from '../src/memory.ts'
import { publishRevisionFile, ReportStore } from '../src/report.ts'
import { ReportApprovalService } from '../src/report-approval.ts'
import { openAssistantStore, sha256 } from '../src/store.ts'
import { localDateOf } from '../src/time.ts'
import { registerAssistantTools } from '../src/tools.ts'
import type { ActivityTracker } from '../src/tracker.ts'

const REPORT_ID = 'daily:2026-09-18'
const CONTENT = '# 工作日报\n\n- 完成可信审批回归测试。\n'
type Options = ConstructorParameters<typeof ReportApprovalService>[2]

function fixture(t: TestContext, overrides: Partial<Options> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-report-approval-'))
  const db = openAssistantStore(path.join(dir, 'assistant.sqlite'))
  const reports = new ReportStore(db)
  const bridge = new SessionBridge({ dshHome: dir })
  const state = { now: 1_800_000_000_000, active: true, stops: 0, publishes: 0 }
  const options: Options = {
    epoch: bridge.epoch,
    reportDir: path.join(dir, 'reports'),
    ttlMs: 60_000,
    now: () => state.now,
    active: () => state.active,
    ...overrides,
    async stop() {
      state.stops += 1
      if (overrides.stop) await overrides.stop()
      else state.active = false
    },
    async publish(...args) {
      state.publishes += 1
      return (overrides.publish ?? publishRevisionFile)(...args)
    },
  }
  const service = new ReportApprovalService(db, reports, options)
  bridge.attachReportApprovals(service)
  t.after(() => {
    bridge.dispose()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  reports.saveDraft(REPORT_ID, CONTENT, state.now)
  const approvalRow = (id: string) => db.prepare('SELECT * FROM report_approvals WHERE proposal_id = ?').get(id)!
  const decide = (id: string, decision: 'approve' | 'reject' = 'approve') =>
    service.decide(id, decision, options.epoch, service.approvalCapabilityToken)
  const assertNoPublish = () => {
    assert.equal(state.publishes, 0)
    assert.equal(state.stops, 0)
    assert.equal(state.active, true)
    assert.equal(existsSync(options.reportDir), false)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM publish_jobs').get()!.n, 0)
  }
  return { dir, db, reports, bridge, service, state, options, approvalRow, decide, assertNoPublish }
}

const codeIs = (code: string) => (error: unknown): boolean => error instanceof ApprovalError && error.code === code

test('提交只产生绑定全文、版本、摘要、目标和有效期的待批；重复提交幂等', t => {
  const f = fixture(t)
  const proposal = f.service.submit(REPORT_ID)
  assert.equal(proposal.kind, 'report')
  assert.equal(proposal.reportId, REPORT_ID)
  assert.equal(proposal.revision, 1)
  assert.equal(proposal.content, CONTENT)
  assert.equal(proposal.digest, sha256(CONTENT))
  assert.equal(proposal.target, path.join(f.options.reportDir, '2026-09-18.md'))
  assert.equal(proposal.expiresAt, f.state.now + f.options.ttlMs)
  assert.equal(proposal.epoch, f.options.epoch)
  assert.equal(f.reports.current(REPORT_ID)?.state, 'pending_confirmation')
  assert.deepEqual(f.service.submit(REPORT_ID), proposal)
  assert.deepEqual(f.service.pendingProposals(), [proposal])
  assert.equal(JSON.stringify(proposal).includes(f.service.approvalCapabilityToken), false)
  f.assertNoPublish()
})

test('缺失、错误及等长错误凭据均不能批准，也不能消费待批', async t => {
  const f = fixture(t)
  const proposal = f.service.submit(REPORT_ID)
  const token = f.service.approvalCapabilityToken
  assert.equal(f.service.verifyCapabilityToken(token), true)
  for (const bad of [undefined, '', '错误凭据', `${token[0] === '0' ? '1' : '0'}${token.slice(1)}`]) {
    assert.equal(f.service.verifyCapabilityToken(bad), false)
    await assert.rejects(f.service.decide(proposal.proposalId, 'approve', f.options.epoch, bad), codeIs('UNTRUSTED_SUBJECT'))
  }
  assert.equal(f.approvalRow(proposal.proposalId).state, 'pending')
  assert.equal(f.approvalRow(proposal.proposalId).consumed_at, null)
  f.assertNoPublish()
})

test('请求旧代次与重启前的持久化待批均失效；新代次须重新提交', async t => {
  const f = fixture(t)
  const old = f.service.submit(REPORT_ID)
  await assert.rejects(f.service.decide(old.proposalId, 'approve', '旧代次', f.service.approvalCapabilityToken), codeIs('EPOCH_MISMATCH'))
  const restarted = new ReportApprovalService(f.db, f.reports, { ...f.options, epoch: '新代次' })
  assert.notEqual(restarted.approvalCapabilityToken, f.service.approvalCapabilityToken)
  assert.deepEqual(restarted.pendingProposals(), [])
  await assert.rejects(restarted.decide(old.proposalId, 'approve', '新代次', restarted.approvalCapabilityToken), codeIs('EPOCH_MISMATCH'))
  const fresh = restarted.submit(REPORT_ID)
  assert.notEqual(fresh.proposalId, old.proposalId)
  assert.equal(fresh.epoch, '新代次')
  assert.equal(f.approvalRow(old.proposalId).state, 'superseded')
  f.assertNoPublish()
})

test('修改草稿使旧版本不可批准或拒绝；消费校验失败完整回滚', async t => {
  const f = fixture(t)
  const old = f.service.submit(REPORT_ID)
  const next = f.reports.saveDraft(REPORT_ID, `${CONTENT}\n- 补充修改。`, f.state.now + 1)
  assert.equal(next.revision, 2)
  assert.deepEqual(f.service.pendingProposals(), [])
  for (const decision of ['approve', 'reject'] as const) {
    await assert.rejects(f.decide(old.proposalId, decision), codeIs('DIGEST_MISMATCH'))
    assert.equal(f.approvalRow(old.proposalId).state, 'pending')
    assert.equal(f.approvalRow(old.proposalId).consumed_at, null)
    assert.equal(f.reports.current(REPORT_ID)?.state, 'draft')
  }
  const fresh = f.service.submit(REPORT_ID)
  assert.equal(fresh.revision, 2)
  assert.notEqual(fresh.digest, old.digest)
  assert.equal(f.approvalRow(old.proposalId).state, 'superseded')
  await assert.rejects(f.decide(old.proposalId), codeIs('ALREADY_CONSUMED'))
  f.assertNoPublish()
})

for (const column of ['content', 'digest', 'target_path'] as const) {
  test(`审批重新核对数据库 ${column}，篡改后不发布且不残留消费记录`, async t => {
    const f = fixture(t)
    const proposal = f.service.submit(REPORT_ID)
    f.db.prepare(`UPDATE reports SET ${column} = ? WHERE report_id = ?`).run('被篡改的值', REPORT_ID)
    assert.deepEqual(f.service.pendingProposals(), [])
    await assert.rejects(f.decide(proposal.proposalId), codeIs('DIGEST_MISMATCH'))
    assert.equal(f.approvalRow(proposal.proposalId).state, 'pending')
    assert.equal(f.approvalRow(proposal.proposalId).consumed_at, null)
    assert.equal(f.reports.current(REPORT_ID)?.state, 'pending_confirmation')
    f.assertNoPublish()
  })
}

test('到期边界立即拒绝并从快照消失；重新提交换一次性待批', async t => {
  const f = fixture(t)
  const old = f.service.submit(REPORT_ID)
  f.state.now = old.expiresAt - 1
  assert.equal(f.service.pendingProposals().length, 1)
  f.state.now = old.expiresAt
  assert.deepEqual(f.service.pendingProposals(), [])
  await assert.rejects(f.decide(old.proposalId), codeIs('EXPIRED'))
  assert.equal(f.approvalRow(old.proposalId).consumed_at, null)
  const fresh = f.service.submit(REPORT_ID)
  assert.notEqual(fresh.proposalId, old.proposalId)
  assert.equal(fresh.revision, old.revision)
  assert.equal(fresh.expiresAt, f.state.now + f.options.ttlMs)
  f.assertNoPublish()
})

test('拒绝退回草稿，不发布、不停采集；旧批准重放拒绝，新提交仍需审批', async t => {
  const f = fixture(t)
  const proposal = f.service.submit(REPORT_ID)
  assert.deepEqual(await f.decide(proposal.proposalId, 'reject'), { ok: true, decision: 'rejected' })
  assert.equal(f.reports.current(REPORT_ID)?.state, 'draft')
  assert.equal(f.approvalRow(proposal.proposalId).state, 'rejected')
  assert.equal(f.approvalRow(proposal.proposalId).consumed_at, f.state.now)
  assert.deepEqual(f.service.pendingProposals(), [])
  await assert.rejects(f.decide(proposal.proposalId), codeIs('ALREADY_CONSUMED'))
  const fresh = f.service.submit(REPORT_ID)
  assert.notEqual(fresh.proposalId, proposal.proposalId)
  assert.equal(fresh.revision, 1)
  f.assertNoPublish()
})

test('并发批准只发布一次；文件发布期间另一服务也不能改稿或再提交', async t => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = fixture(t, { publish: async (...args) => { await gate; return publishRevisionFile(...args) } })
  const proposal = f.service.submit(REPORT_ID)
  const pending = f.decide(proposal.proposalId)
  try {
    assert.equal(f.state.publishes, 1)
    assert.equal(f.state.stops, 0)
    assert.equal(f.reports.current(REPORT_ID)?.state, 'publishing')
    assert.equal(f.reports.job(`publish-${proposal.proposalId}`)?.state, 'running')
    assert.deepEqual(f.service.pendingProposals(), [])
    const peerReports = new ReportStore(f.db)
    const peer = new ReportApprovalService(f.db, peerReports, f.options)
    await assert.rejects(peer.decide(proposal.proposalId, 'approve', f.options.epoch, peer.approvalCapabilityToken), codeIs('ALREADY_CONSUMED'))
    assert.throws(() => peerReports.saveDraft(REPORT_ID, '并发改稿', f.state.now), /正在发布|恢复核对/)
    assert.throws(() => peerReports.saveDraftIfChanged(REPORT_ID, '另一份改稿', f.state.now), /正在发布|恢复核对/)
    assert.throws(() => peer.submit(REPORT_ID), /不能提交/)
    assert.equal(f.reports.history(REPORT_ID).length, 1)
  } finally {
    release()
    await pending
  }
  const result = await pending
  assert.equal(result.confirmed, true)
  assert.equal(result.modeExited, true)
  assert.equal(readFileSync(proposal.target, 'utf8'), CONTENT)
  assert.equal(f.state.publishes, 1)
  assert.equal(f.state.stops, 1)
  await assert.rejects(f.decide(proposal.proposalId), codeIs('ALREADY_CONSUMED'))
  assert.equal(f.reports.saveDraft(REPORT_ID, '发布完成后允许改稿', f.state.now).revision, 2)
})

test('真实文件写入失败退回草稿，修复后必须重新审批，不能重放旧批准', async t => {
  const f = fixture(t)
  writeFileSync(f.options.reportDir, '用文件占住报告目录，制造真实写入失败')
  const first = f.service.submit(REPORT_ID)
  const failed = await f.decide(first.proposalId)
  assert.equal(failed.ok, false)
  assert.equal(failed.confirmed, false)
  assert.match(failed.error ?? '', /重新提交.*批准/)
  assert.equal(f.reports.current(REPORT_ID)?.state, 'draft')
  assert.equal(f.reports.job(`publish-${first.proposalId}`)?.state, 'failed')
  assert.equal(f.approvalRow(first.proposalId).state, 'consumed')
  assert.deepEqual(JSON.parse(String(f.approvalRow(first.proposalId).result_json)), failed)
  assert.equal(f.state.stops, 0)
  assert.equal(f.state.active, true)
  rmSync(f.options.reportDir)
  await assert.rejects(f.decide(first.proposalId), codeIs('ALREADY_CONSUMED'))
  const retry = f.service.submit(REPORT_ID)
  assert.notEqual(retry.proposalId, first.proposalId)
  assert.equal(retry.revision, first.revision)
  assert.equal(f.state.publishes, 1, '重新提交也不能自动发布')
  const succeeded = await f.decide(retry.proposalId)
  assert.equal(succeeded.confirmed, true)
  assert.equal(succeeded.modeExited, true)
  assert.equal(readFileSync(retry.target, 'utf8'), CONTENT)
  assert.equal(f.reports.current(REPORT_ID)?.state, 'archived')
  assert.equal(f.reports.job(`publish-${retry.proposalId}`)?.state, 'succeeded')
  assert.equal(f.state.publishes, 2)
  assert.equal(f.state.stops, 1)
})

test('未知发布异常保留运行作业及编辑锁，绝不恢复批准或自动重发', async t => {
  const f = fixture(t, { publish: async () => { throw new Error('模拟发布结果不明') } })
  const proposal = f.service.submit(REPORT_ID)
  const result = await f.decide(proposal.proposalId)
  assert.equal(result.confirmed, false)
  assert.match(result.error ?? '', /待核对.*不会自动重发/)
  assert.equal(f.reports.current(REPORT_ID)?.state, 'publishing')
  assert.equal(f.reports.openJobs().length, 1)
  assert.equal(f.approvalRow(proposal.proposalId).state, 'consumed')
  assert.throws(() => f.reports.saveDraft(REPORT_ID, '不能覆盖结果不明的发布', f.state.now), /恢复核对/)
  assert.throws(() => f.service.submit(REPORT_ID), /不能提交/)
  await assert.rejects(f.decide(proposal.proposalId), codeIs('ALREADY_CONSUMED'))
  assert.equal(f.state.stops, 0)
  assert.equal(f.state.active, true)
  assert.equal(f.state.publishes, 1)
})

for (const stopMode of ['正常停止', '停止抛错', '停止后仍活动'] as const) {
  test(`发布成功与停止状态分开报告：${stopMode}`, async t => {
    const f = fixture(t, stopMode === '正常停止' ? {} : {
      stop: async () => { if (stopMode === '停止抛错') throw new Error('模拟停止失败') },
    })
    const proposal = f.service.submit(REPORT_ID)
    const result = await f.decide(proposal.proposalId)
    assert.equal(result.ok, true)
    assert.equal(result.confirmed, true)
    assert.equal(result.modeExited, stopMode === '正常停止')
    assert.equal(result.savedPath, proposal.target)
    assert.equal(result.digest, sha256(CONTENT))
    assert.equal(result.revision, 1)
    assert.equal(readFileSync(proposal.target, 'utf8'), CONTENT)
    assert.deepEqual(readdirSync(f.options.reportDir), ['2026-09-18.md'])
    assert.equal(f.reports.current(REPORT_ID)?.state, 'archived')
    assert.equal(f.reports.job(`publish-${proposal.proposalId}`)?.state, 'succeeded')
    assert.deepEqual(JSON.parse(String(f.approvalRow(proposal.proposalId).result_json)), result)
    if (stopMode !== '正常停止') assert.match(result.message ?? '', /手动停止/)
    if (stopMode === '停止抛错') assert.match(result.message ?? '', /模拟停止失败/)
    await assert.rejects(f.decide(proposal.proposalId), codeIs('ALREADY_CONSUMED'))
    assert.throws(() => f.service.submit(REPORT_ID), /不能提交/)
    assert.equal(f.state.stops, 1)
    assert.equal(f.state.publishes, 1)
  })
}

test('非团队工具与真实 HTTP：confirm 只读，独立凭据审批，重连快照能看日报全文', async t => {
  const f = fixture(t)
  const tools = new Map<string, { execute(args: unknown): Promise<string> }>()
  registerAssistantTools({
    tools: { register(definition) {
      const tool = definition as { name: string; execute(args: unknown): Promise<string> }
      tools.set(tool.name, tool)
      return () => undefined
    } },
    systemPrompt: { section: () => () => undefined, variable: () => () => undefined },
  }, { get active() { return f.state.active }, stop: async () => assert.fail('模型工具不得停止采集') } as unknown as ActivityTracker, {
    reportDir: f.options.reportDir,
    bridge: f.bridge,
    reports: f.reports,
    memories: {} as MemoryStore,
    maxInjectedMemories: 0,
    captureBlockedReason: () => '测试不允许采集',
    legacyCopiesRetained: false,
    enableTeamMode: () => { throw new Error('测试不允许启动团队或模型') },
    disableTeamMode: async () => ({ ok: true }),
  })
  const call = async (name: string, args: unknown = {}) => JSON.parse(await tools.get(`personal_assistant_${name}`)!.execute(args))
  const saved = await call('save_draft', { content: CONTENT })
  const before = await call('confirm_report', { revision: saved.revision, digest: saved.digest })
  assert.equal(before.reason, 'trusted_approval_required')
  assert.equal(before.confirmed, false)
  assert.equal(f.reports.current(saved.reportId)?.state, 'draft')
  assert.deepEqual(f.service.pendingProposals(), [])
  const submitted = await call('submit_report')
  assert.equal(submitted.submitted, true)
  for (const args of [saved, { revision: 999, digest: '模型编造的摘要' }]) {
    const confirmed = await call('confirm_report', { revision: args.revision, digest: args.digest })
    assert.equal(confirmed.confirmed, false)
    assert.equal(confirmed.reason, 'trusted_approval_required')
    assert.equal(confirmed.proposalId, submitted.proposalId)
  }
  f.assertNoPublish()

  const bound = await f.bridge.bind({ session: { events: [] }, followup: () => assert.fail('不得调用模型') })
  const infoText = readFileSync(path.join(f.dir, 'personal-assistant', 'bridge.json'), 'utf8')
  const info = JSON.parse(infoText)
  const credential = JSON.parse(readFileSync(path.join(f.dir, 'personal-assistant', 'bridge-approval.json'), 'utf8'))
  assert.equal(credential.reportApprovalToken, f.service.approvalCapabilityToken)
  assert.equal(credential.approvalToken, undefined, '不依赖团队审批凭据')
  assert.equal(credential.token, undefined)
  assert.notEqual(credential.reportApprovalToken, info.token)
  assert.equal(infoText.includes(credential.reportApprovalToken), false)
  assert.equal(credential.port, bound.port)
  assert.equal(credential.epoch, f.bridge.epoch)
  const request = async (pathname: string, body?: unknown, approvalToken?: string) => {
    const response = await fetch(`http://127.0.0.1:${bound.port}${pathname}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { connection: 'close', 'content-type': 'application/json', ...(approvalToken ? { 'x-dsh-approval-token': approvalToken } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    return { status: response.status, body: await response.json() as any }
  }
  const snapshotPath = `/team?token=${info.token}`
  const snapshot = await request(snapshotPath)
  assert.equal(snapshot.status, 200)
  assert.equal(snapshot.body.team, false)
  assert.deepEqual(snapshot.body.members, [])
  assert.deepEqual(snapshot.body.tasks, [])
  assert.equal(snapshot.body.proposals.length, 1)
  const card = snapshot.body.proposals[0]
  assert.equal(card.kind, 'report')
  assert.equal(card.content, CONTENT)
  assert.equal(card.digest, saved.digest)
  assert.equal(card.target, path.join(f.options.reportDir, `${localDateOf(Date.now())}.md`))
  assert.equal(JSON.stringify(snapshot.body).includes(credential.reportApprovalToken), false)
  assert.deepEqual((await request(snapshotPath)).body, snapshot.body, '错过事件仍能靠快照恢复待批')
  const events = (await request(`/events?since=0&token=${info.token}`)).body.events
  assert.ok(events.some((event: any) => event.type === 'team/snapshot' && event.payload.proposals.some((item: any) => item.proposalId === submitted.proposalId)))
  assert.equal(JSON.stringify(events).includes(credential.reportApprovalToken), false)
  assert.equal((await request(`/health?token=${credential.reportApprovalToken}`)).status, 401)

  const body = { proposalId: submitted.proposalId, decision: 'approve', epoch: credential.epoch }
  assert.equal((await request('/report-approval', body)).status, 403)
  assert.equal((await request(`/report-approval?token=${info.token}`, body)).status, 403)
  assert.equal((await request('/report-approval', body, info.token)).status, 403)
  const stale = await request('/report-approval', { ...body, epoch: '旧代次' }, credential.reportApprovalToken)
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error, 'EPOCH_MISMATCH')
  assert.equal((await request('/report-approval', { ...body, decision: '随意决定' }, credential.reportApprovalToken)).status, 400)
  f.assertNoPublish()
  const unwanted = path.join(f.dir, '不允许的目标.md')
  const approved = await request('/report-approval', {
    ...body, content: '不得采用客户端正文', target: unwanted, revision: 999, digest: '伪造摘要',
  }, credential.reportApprovalToken)
  assert.equal(approved.status, 200)
  assert.equal(approved.body.confirmed, true)
  assert.equal(approved.body.modeExited, true)
  assert.equal(readFileSync(card.target, 'utf8'), CONTENT)
  assert.equal(existsSync(unwanted), false)
  assert.equal(f.reports.current(saved.reportId)?.state, 'archived')
  assert.deepEqual((await request(snapshotPath)).body.proposals, [])
  const replay = await request('/report-approval', body, credential.reportApprovalToken)
  assert.equal(replay.status, 409)
  assert.equal(replay.body.error, 'ALREADY_CONSUMED')
  assert.equal((await call('confirm_report', { revision: saved.revision, digest: saved.digest })).confirmed, false)
  assert.equal(f.state.publishes, 1)
  assert.equal(f.state.stops, 1)
})
