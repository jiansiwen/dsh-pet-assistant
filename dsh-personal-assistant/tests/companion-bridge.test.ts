import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ApprovalService } from '../src/approval.ts'
import { SessionBridge } from '../src/bridge.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'
import { TeamStore } from '../src/team-domain.ts'

function credential(file: string): Record<string, string | number> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string | number>
}

test('普通任务接口与执行器凭据互不通用，聊天令牌不能替本人确认', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-companion-bridge-'))
  const store = new TeamStore(':memory:')
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'epoch-1' })
  const runtime = new CompanionTaskRuntime(store, approvals, { epoch: 'epoch-1' })
  const bridge = new SessionBridge({ dshHome: home })
  bridge.attachCompanion(runtime, approvals)
  runtime.start()
  t.after(async () => {
    await runtime.dispose()
    await bridge.dispose()
    store.close()
    rmSync(home, { recursive: true, force: true })
  })

  const listening = await bridge.listen()
  const chat = credential(path.join(home, 'personal-assistant', 'bridge.json'))
  const owner = credential(path.join(home, 'personal-assistant', 'bridge-approval.json'))
  assert.ok(chat.token && owner.companionOwnerToken && owner.companionExecutorToken)
  assert.notEqual(chat.token, owner.companionOwnerToken)
  assert.notEqual(owner.companionOwnerToken, owner.companionExecutorToken)
  const base = `http://127.0.0.1:${listening.port}`

  const input = { kind: 'agent', executionMode: 'manual', description: '把纪要发给测试邮箱' }
  const clientInput = await fetch(`${base}/companion/v1/inputs?token=${encodeURIComponent(String(chat.token))}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  })
  assert.equal(clientInput.status, 201, '模型/聊天侧只能登记受校验输入，不产生副作用')

  const ownerInput = await fetch(`${base}/companion/v1/inputs`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-companion-token': String(owner.companionOwnerToken) },
    body: JSON.stringify(input),
  })
  assert.equal(ownerInput.status, 201)
  const inputRef = ((await ownerInput.json()) as { inputRef: string }).inputRef

  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  const create = await fetch(`${base}/companion/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-companion-token': String(owner.companionOwnerToken) },
    body: JSON.stringify({ protocolVersion: 1, commandId: 'cmd-bridge-1', expiresAt, payload: { kind: 'agent', title: '发纪要', inputRef, dependsOn: [] } }),
  })
  assert.ok(create.status >= 200 && create.status < 300, String(create.status))
  const created = await create.json() as { task: { taskId: string; status: string } }
  assert.equal(created.task.status, 'awaiting-user')

  const list = await fetch(`${base}/companion/v1/tasks?token=${encodeURIComponent(String(chat.token))}`)
  assert.equal(list.status, 200)
  const tasks = (await list.json()) as { tasks: Array<{ taskId: string }> }
  assert.ok(tasks.tasks.some(task => task.taskId === created.task.taskId))

  const clientExecutor = await fetch(`${base}/executor/v1/reminders?token=${encodeURIComponent(String(chat.token))}`)
  assert.equal(clientExecutor.status, 403, '聊天令牌不能当执行器凭据')
  const executorList = await fetch(`${base}/executor/v1/reminders`, {
    headers: { 'x-dsh-companion-token': String(owner.companionExecutorToken) },
  })
  assert.equal(executorList.status, 200)

  const clientOwner = await fetch(`${base}/companion/v1/tasks/${created.task.taskId}/complete?token=${encodeURIComponent(String(chat.token))}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, commandId: 'cmd-bridge-complete', taskId: created.task.taskId, expectedRevision: 2, expiresAt, payload: {} }),
  })
  assert.equal(clientOwner.status, 202, '聊天侧只能提交待本机确认的提案')
  const unchanged = await (await fetch(`${base}/companion/v1/tasks/${created.task.taskId}?token=${encodeURIComponent(String(chat.token))}`)).json() as
    { task: { status: string }; proposalId: string | null }
  assert.equal(unchanged.task.status, 'awaiting-user', '未获本机批准前不能标记完成')
  assert.ok(unchanged.proposalId, '审批卡已生成')

  const respondByChat = await fetch(`${base}/companion/v1/reminders/cycle-x/respond?token=${encodeURIComponent(String(chat.token))}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, commandId: 'cmd-bridge-ack', taskId: created.task.taskId, expectedRevision: 2, expiresAt,
      payload: { cycleId: 'cycle-x', expectedCycleRevision: 1, action: 'ack', snoozedUntil: null } }),
  })
  assert.equal(respondByChat.status, 403, '聊天侧不能替本人回应提醒')
})
