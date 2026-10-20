/** 帮助上下文授权：未授权不读、越界拒绝、撤销生效；证据只读且有上限。 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { HelpContextStore, readProjectEvidence } from '../src/help-context.ts'
import { registerAssistantTools } from '../src/tools.ts'
import { AssistantApprovalService } from '../src/assistant-approval.ts'
import { SessionBridge } from '../src/bridge.ts'

interface ToolDef { name: string; execute(args: unknown): Promise<string> }

function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-help-'))
  const db = new DatabaseSync(path.join(dir, 'assistant.sqlite'))
  const helpContexts = new HelpContextStore(db)
  const bridge = new SessionBridge({ dshHome: dir })
  const approvals = new AssistantApprovalService({ epoch: bridge.epoch, ttlMs: 60_000 })
  bridge.attachAssistantApprovals(approvals)
  const tools = new Map<string, ToolDef>()
  const ctx = {
    tools: { register: (def: ToolDef) => tools.set(def.name, def) },
    systemPrompt: { section: () => undefined, variable: () => undefined },
  }
  const boom = (): never => { throw new Error('不应调用') }
  registerAssistantTools(ctx as never, { getDay: boom } as never, {
    reportDir: dir,
    bridge,
    memories: { put: boom, list: boom, delete: boom, injectable: boom, listProject: () => [] } as never,
    reports: { current: boom, saveDraftIfChanged: boom, submitForConfirmation: boom, approve: boom, history: boom } as never,
    maxInjectedMemories: 10,
    captureBlockedReason: () => null,
    legacyCopiesRetained: false,
    helpContexts,
    enableTeamMode: boom,
    disableTeamMode: boom,
  })
  const call = async (name: string, args: unknown = {}): Promise<Record<string, unknown>> =>
    JSON.parse(await tools.get(name)!.execute(args)) as Record<string, unknown>
  const approve = async (pending: Record<string, unknown>) => {
    assert.equal(pending.pending, true)
    assert.equal(pending.recorded, undefined)
    const result = await approvals.decide(String(pending.proposalId), 'approve', bridge.epoch, approvals.approvalCapabilityToken)
    assert.equal(result.ok, true)
    return result.result as { id: string; currentFile: string }
  }
  return { dir, db, helpContexts, tools, call, approve, cleanup: () => { bridge.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('帮助范围必须绝对路径，文件必须落在授权目录内', async () => {
  const h = harness()
  try {
    assert.equal((await h.call('personal_assistant_help_context', { projectDir: 'relative/dir' })).pending, false)
    const outside = mkdtempSync(path.join(tmpdir(), 'dsh-help-out-'))
    const bad = await h.call('personal_assistant_help_context', {
      projectDir: h.dir, currentFile: path.join(outside, 'a.ts'),
    })
    assert.equal(bad.pending, false)
    rmSync(outside, { recursive: true, force: true })
    writeFileSync(path.join(h.dir, 'a.ts'), '测试文件')
    const pending = await h.call('personal_assistant_help_context', {
      projectDir: h.dir, currentFile: path.join(h.dir, 'a.ts'), note: '构建失败',
    })
    assert.equal(h.helpContexts.list().length, 0)
    const ok = await h.approve(pending)
    assert.equal(h.helpContexts.list().length, 1)
    assert.equal(ok.currentFile, path.join(h.dir, 'a.ts'))
    const evidence = await h.call('personal_assistant_read_project_evidence', { projectDir: h.dir })
    assert.deepEqual(evidence.entries, ['a.ts'])
    assert.deepEqual(evidence.recentCommits, [])
  } finally { h.cleanup() }
})

test('未授权目录读不到证据；授权后只读返回顶层条目', async () => {
  const h = harness()
  try {
    writeFileSync(path.join(h.dir, 'note.txt'), 'x')
    const denied = await h.call('personal_assistant_read_project_evidence', { projectDir: h.dir })
    assert.equal(denied.ok, false)
    const added = await h.call('personal_assistant_help_context', { projectDir: h.dir })
    assert.equal(h.helpContexts.list().length, 0)
    await h.approve(added)
    assert.equal(h.helpContexts.list().length, 1)
    const evidence = await h.call('personal_assistant_read_project_evidence', { projectDir: h.dir })
    assert.equal(evidence.ok, true)
    assert.equal(evidence.readOnly, true)
    assert.equal(evidence.git, false)
    assert.ok((evidence.entries as string[]).includes('note.txt'))
  } finally { h.cleanup() }
})

test('撤销授权后证据读取立即拒绝', async () => {
  const h = harness()
  try {
    const added = await h.approve(await h.call('personal_assistant_help_context', { projectDir: h.dir }))
    const listed = await h.call('personal_assistant_list_help_contexts')
    assert.equal((listed.contexts as unknown[]).length, 1)
    const removed = await h.call('personal_assistant_forget_help_context', { id: String(added.id) })
    assert.equal(removed.removed, true)
    const denied = await h.call('personal_assistant_read_project_evidence', { projectDir: h.dir })
    assert.equal(denied.ok, false)
  } finally { h.cleanup() }
})

test('Git 项目返回只读状态与差异统计', async () => {
  const h = harness()
  try {
    writeFileSync(path.join(h.dir, 'work.txt'), 'hello\n')
    try {
      execFileSync('git', ['init', '-q'], { cwd: h.dir, windowsHide: true })
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.'], { cwd: h.dir, windowsHide: true })
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: h.dir, windowsHide: true })
    } catch {
      return
    }
    writeFileSync(path.join(h.dir, 'work.txt'), 'hello\nworld\n')
    await h.call('personal_assistant_help_context', { projectDir: h.dir })
    const evidence = await readProjectEvidence(h.dir)
    assert.equal(evidence.git, true)
    assert.ok(evidence.changedFiles.some(line => line.includes('work.txt')))
    assert.ok(evidence.diffStat.some(line => line.includes('work.txt')))
    assert.equal(evidence.recentCommits.length, 1)
  } finally { h.cleanup() }
})
