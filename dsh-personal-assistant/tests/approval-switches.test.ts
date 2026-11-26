import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ApprovalSwitches, APPROVAL_SWITCH_KEYS, switchForSubject } from '../src/approval-switches.ts'
import { AssistantApprovalService } from '../src/assistant-approval.ts'
import { SessionBridge } from '../src/bridge.ts'

test('免审批开关：读写持久化、未知键与非布尔值拒绝、主题映射准确', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-switches-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'approval-switches.json')
  const switches = new ApprovalSwitches(file, { reportPublish: true })
  assert.equal(switches.enabled('reportPublish'), true)
  assert.equal(switches.enabled('helpScope'), false)
  assert.throws(() => switches.update({ unknownKey: true }), /未知的开关/)
  assert.throws(() => switches.update({ helpScope: 'yes' }), /只能是开或关/)
  assert.equal(switches.enabled('helpScope'), false, '拒绝后不能部分写入')
  switches.update({ helpScope: true, mailSend: true, computerUse: true })
  const reopened = new ApprovalSwitches(file)
  assert.equal(reopened.enabled('helpScope'), true)
  assert.equal(reopened.enabled('mailSend'), true)
  assert.equal(reopened.enabled('computerUse'), true)
  assert.equal(reopened.enabled('reportPublish'), true)
  assert.equal(switchForSubject('help'), 'helpScope')
  assert.equal(switchForSubject('computer:look:1'), 'computerUse')
  assert.equal(switchForSubject('material-delete:m1'), 'dataDeletion')
  assert.equal(switchForSubject('unlisted'), null)
  assert.ok(APPROVAL_SWITCH_KEYS.length >= 12)
})

test('免审批开关接入 SessionBridge：打开立即签发执行，关闭恢复待批', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-switches-bridge-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bridge = new SessionBridge({ dshHome: dir })
  t.after(() => bridge.dispose())
  const approvals = new AssistantApprovalService({ epoch: bridge.epoch, ttlMs: 60_000 })
  const switches = new ApprovalSwitches(null)
  bridge.attachAssistantApprovals(approvals)
  bridge.attachApprovalSwitches(switches)

  let ran = 0
  const submission = {
    subject: 'help',
    tool: 'personal_assistant_help_context',
    summary: '授权读取目录',
    target: 'D:/demo',
    risk: 'high' as const,
    snapshot: { projectDir: 'D:/demo' },
    validate: () => true,
    execute: () => ({ ok: true, count: ++ran }),
  }

  const manual = await bridge.submitAssistantAuto(submission)
  assert.equal(manual.auto, undefined)
  assert.equal(ran, 0)
  assert.equal(approvals.pendingProposals().length, 1)

  switches.update({ helpScope: true })
  const auto = await bridge.submitAssistantAuto(submission)
  assert.equal(auto.auto?.ok, true)
  assert.equal(ran, 1)
  assert.equal(approvals.pendingProposals().length, 0)

  switches.update({ helpScope: false })
  const again = await bridge.submitAssistantAuto(submission)
  assert.equal(again.auto, undefined)
  assert.equal(ran, 1)
  assert.equal(approvals.pendingProposals().length, 1)
})

test('会议纪要单次模型整理：优先使用子助理模型并剥离多余前言与围栏输出干净 JSON', async () => {
  const { MemberAssistant } = await import('../src/member-assistant.ts')
  const seen: Array<{ provider: string; model: string; system?: string }> = []
  const fakeCtx = {
    get(name: string) {
      if (name !== 'llm') return undefined
      return {
        async *stream(input: { provider: string; model: string; system?: string }) {
          seen.push({ provider: input.provider, model: input.model, system: input.system })
          yield { type: 'text-delta', text: '好的，整理如下：\n```json\n{"summary":[{"text":"确认方案","sources":["s1"]}],"decisions":[],"actions":[]}\n```' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const assistant = new MemberAssistant({
    ctx: fakeCtx as never,
    defaultModel: () => ({ provider: 'default-p', model: 'default-m' }),
  })
  const out = await assistant.summarizeMinutes({
    prompt: '请整理会议纪要',
    model: { provider: 'member-p', model: 'member-m' },
  })
  assert.equal(out.provider, 'member-p')
  assert.equal(out.model, 'member-m')
  assert.deepEqual(JSON.parse(out.reply), { summary: [{ text: '确认方案', sources: ['s1'] }], decisions: [], actions: [] })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].provider, 'member-p')
})
