/** 归档撤销：只改状态不删文件；非归档版本拒绝。 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { ReportStore } from '../src/report.ts'
import { registerAssistantTools } from '../src/tools.ts'
import { localDateOf } from '../src/time.ts'

interface ToolDef { name: string; execute(args: unknown): Promise<string> }

test('撤销归档只改状态，非归档版本拒绝', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-revoke-'))
  const db = new DatabaseSync(path.join(dir, 'assistant.sqlite'))
  const reports = new ReportStore(db)
  const tools = new Map<string, ToolDef>()
  const ctx = {
    tools: { register: (def: ToolDef) => tools.set(def.name, def) },
    systemPrompt: { section: () => undefined, variable: () => undefined },
  }
  const boom = (): never => { throw new Error('不应调用') }
  registerAssistantTools(ctx as never, { getDay: boom } as never, {
    reportDir: dir,
    bridge: { teamEnabled: false, submitReport: boom, pendingReportApprovals: () => [], notifyApprovalSnapshot: () => undefined } as never,
    memories: { put: boom, list: boom, delete: boom, injectable: boom } as never,
    reports,
    maxInjectedMemories: 10,
    captureBlockedReason: () => null,
    legacyCopiesRetained: false,
    enableTeamMode: boom,
    disableTeamMode: boom,
  })
  const call = async (name: string, args: unknown = {}): Promise<Record<string, unknown>> =>
    JSON.parse(await tools.get(name)!.execute(args)) as Record<string, unknown>
  try {
    const reportId = `daily:${localDateOf(Date.now())}`
    const draft = reports.saveDraft(reportId, '# 日报\n', 1)
    reports.submitForConfirmation(reportId, draft.revision)
    const approved = reports.approve(reportId, draft.revision, draft.digest, path.join(dir, 'r.md'), { id: 'user', isUser: true }, 2)
    assert.equal(approved.ok, true)
    reports.setReportState(reportId, draft.revision, 'archived')

    const pending = await call('personal_assistant_revoke_report', { revision: draft.revision, reason: '内容有误' })
    assert.equal(pending.revoked, true)
    assert.equal(reports.revision(reportId, draft.revision)?.state, 'revoked')

    const again = await call('personal_assistant_revoke_report', { revision: draft.revision, reason: '重复' })
    assert.equal(again.revoked, false)
    const missing = await call('personal_assistant_revoke_report', { revision: 99, reason: 'x' })
    assert.equal(missing.revoked, false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
