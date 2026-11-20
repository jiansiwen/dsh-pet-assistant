import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { ApprovalService } from '../src/approval.ts'
import { getManagedExecutor, managedKinds, registerManagedExecutor, resetManagedExecutors } from '../src/managed-executor.ts'
import { resetSemanticValidators } from '../src/semantic-validators.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'
import { TeamStore } from '../src/team-domain.ts'

/** 与 companion-runtime.test.ts 同一夹具模式：内存库 + 假时钟 + 可重启代次。 */
function fixture(t: TestContext, epoch = 'epoch-1') {
  const store = new TeamStore(':memory:')
  let now = Date.parse('2026-11-07T10:00:00Z')
  let approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: epoch })
  let runtime = new CompanionTaskRuntime(store, approvals, { epoch, now: () => now })
  const runtimes = [runtime]
  t.after(async () => {
    for (const instance of runtimes) await instance.dispose()
    store.close()
    resetManagedExecutors()
    resetSemanticValidators()
  })
  const command = (id: string, payload: unknown) => ({
    protocolVersion: 1 as const, commandId: id,
    expiresAt: new Date(now + 60_000).toISOString(), payload,
  })
  const restart = (nextEpoch: string) => {
    runtime.stopAccepting()
    approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: nextEpoch })
    runtime = new CompanionTaskRuntime(store, approvals, { epoch: nextEpoch, now: () => now })
    runtimes.push(runtime)
    runtime.start()
  }
  return { store, get runtime() { return runtime }, command, restart, now: () => now }
}

const desktopInput = {
  kind: 'desktop-action', capability: 'desktop.readback', targetGrantRef: 'grant-1',
  successCheck: { page: 3 }, readPage: true, profile: 'wps-pdf',
}

function registerDesktopExecutor(validate: (input: unknown) => void = () => {}) {
  registerManagedExecutor('desktop-action', { capabilities: ['desktop.readback', 'desktop.action'], validate })
}

async function createDesktopTask(f: ReturnType<typeof fixture>, input: Record<string, unknown> = desktopInput, commandId = 'cmd-create-1') {
  const prepared = await f.runtime.request('POST', '/companion/v1/inputs', input, 'owner')
  assert.equal(prepared.status, 201, JSON.stringify(prepared.body))
  const inputRef = (prepared.body as { inputRef: string }).inputRef
  const created = await f.runtime.request('POST', '/companion/v1/tasks', f.command(commandId, {
    kind: 'desktop-action', title: '读回目标页码', inputRef, dependsOn: [],
  }), 'owner')
  return { created, inputRef }
}

const commandsOf = (body: unknown): Array<Record<string, unknown>> =>
  ((body as { commands?: Array<Record<string, unknown>> }).commands ?? [])

test('注册表登记后 desktop-action 可创建，并按执行器通道产生一条 ExecutionCommand', async t => {
  const f = fixture(t)
  registerDesktopExecutor()
  assert.deepEqual(managedKinds(), ['desktop-action'])
  assert.ok(getManagedExecutor('desktop-action'))
  assert.equal(getManagedExecutor('mail-send'), null)

  const { created } = await createDesktopTask(f)
  assert.ok(created.status >= 200 && created.status < 300, JSON.stringify(created.body))
  const task = (created.body as { task: { taskId: string; status: string; kind: string } }).task
  assert.equal(task.kind, 'desktop-action')
  assert.equal(task.status, 'queued')

  const listed = await f.runtime.request('GET', '/executor/v1/commands', null, 'executor')
  assert.equal(listed.status, 200)
  const commands = commandsOf(listed.body)
  assert.equal(commands.length, 1, '创建后只产生一条待领取命令，不新建第二调度器')
  const command = commands[0]!
  for (const field of ['commandId', 'operationId', 'taskId', 'taskRevision', 'executorEpoch', 'kind', 'inputRef', 'inputDigest', 'grantRef', 'expiresAt']) {
    assert.ok(command[field] !== undefined, `ExecutionCommand 缺少契约字段 ${field}`)
  }
  assert.equal(command.taskId, task.taskId)
  assert.equal(command.executorEpoch, 'epoch-1')
  assert.deepEqual(command.capabilities, ['desktop.readback', 'desktop.action'])
  assert.deepEqual(command.input, desktopInput)

  const forbidden = await f.runtime.request('GET', '/executor/v1/commands', null, 'client')
  assert.equal(forbidden.status, 403, '聊天令牌不能领取执行器命令')
})

test('未注册 kind 仍 KIND_UNSUPPORTED；内置 agent/reminder 不受影响', async t => {
  const f = fixture(t)
  registerDesktopExecutor()
  const refused = await f.runtime.request('POST', '/companion/v1/tasks', f.command('cmd-x', {
    kind: 'document-translate', title: '翻译', inputRef: 'missing', dependsOn: [],
  }), 'owner')
  assert.equal(refused.status, 422)
  assert.equal((refused.body as { code: string }).code, 'KIND_UNSUPPORTED')

  const input = await f.runtime.request('POST', '/companion/v1/inputs', { kind: 'agent', executionMode: 'manual', description: '人工待办' }, 'owner')
  const inputRef = (input.body as { inputRef: string }).inputRef
  const agent = await f.runtime.request('POST', '/companion/v1/tasks', f.command('cmd-agent', {
    kind: 'agent', title: '待办', inputRef, dependsOn: [],
  }), 'owner')
  assert.ok(agent.status >= 200 && agent.status < 300, JSON.stringify(agent.body))
  assert.equal((agent.body as { task: { status: string } }).task.status, 'awaiting-user')
  assert.equal(commandsOf((await f.runtime.request('GET', '/executor/v1/commands', null, 'executor')).body).length, 0, '人工待办不产生执行命令')

  resetManagedExecutors()
  const afterReset = await f.runtime.request('POST', '/companion/v1/tasks', f.command('cmd-y', {
    kind: 'desktop-action', title: '读回', inputRef: 'missing', dependsOn: [],
  }), 'owner')
  assert.equal((afterReset.body as { code: string }).code, 'KIND_UNSUPPORTED', '注销后回到硬编码白名单')
})

test('同一 commandId 幂等：不重复创建任务与命令；改载荷则冲突', async t => {
  const f = fixture(t)
  registerDesktopExecutor()
  const { created, inputRef } = await createDesktopTask(f)
  const again = await f.runtime.request('POST', '/companion/v1/tasks', f.command('cmd-create-1', {
    kind: 'desktop-action', title: '读回目标页码', inputRef, dependsOn: [],
  }), 'owner')
  assert.equal(again.status, created.status)
  assert.deepEqual(again.body, created.body, '相同命令返回原回执')
  assert.equal(commandsOf((await f.runtime.request('GET', '/executor/v1/commands', null, 'executor')).body).length, 1, '命令不重复产生')

  const conflict = await f.runtime.request('POST', '/companion/v1/tasks', f.command('cmd-create-1', {
    kind: 'desktop-action', title: '换了标题', inputRef, dependsOn: [],
  }), 'owner')
  assert.equal(conflict.status, 409)
  assert.equal((conflict.body as { code: string }).code, 'IDEMPOTENCY_CONFLICT')
})

test('执行器校验器拒绝的输入不能登记也不能创建', async t => {
  const f = fixture(t)
  registerDesktopExecutor(input => {
    const value = input as { capability?: unknown }
    if (value.capability !== 'desktop.readback' && value.capability !== 'desktop.action') throw new Error('能力必须是 desktop.readback 或 desktop.action')
  })
  const bad = await f.runtime.request('POST', '/companion/v1/inputs', { kind: 'desktop-action', capability: 'shell.exec' }, 'owner')
  assert.equal(bad.status, 422)
  assert.equal((bad.body as { code: string }).code, 'INVALID_INPUT')
})

test('领取一次性：代次核验、重复领取拒绝、回执四态映射与语义复核', async t => {
  const f = fixture(t)
  registerDesktopExecutor()
  const { created } = await createDesktopTask(f)
  const taskId = (created.body as { task: { taskId: string } }).task.taskId
  const command = commandsOf((await f.runtime.request('GET', '/executor/v1/commands', null, 'executor')).body)[0]!
  const commandId = String(command.commandId)

  const staleEpoch = await f.runtime.request('POST', `/executor/v1/commands/${commandId}/claim`, { executorEpoch: 'old-epoch' }, 'executor')
  assert.equal(staleEpoch.status, 409)
  assert.equal((staleEpoch.body as { code: string }).code, 'EPOCH_MISMATCH')

  const claimed = await f.runtime.request('POST', `/executor/v1/commands/${commandId}/claim`, { executorEpoch: 'epoch-1' }, 'executor')
  assert.equal(claimed.status, 200)
  const twice = await f.runtime.request('POST', `/executor/v1/commands/${commandId}/claim`, { executorEpoch: 'epoch-1' }, 'executor')
  assert.equal(twice.status, 409, '同一命令不能再次领取执行')
  assert.equal((twice.body as { code: string }).code, 'ALREADY_CLAIMED')
  const detail = await f.runtime.request('GET', `/companion/v1/tasks/${taskId}`, null, 'client')
  assert.equal((detail.body as { task: { status: string } }).task.status, 'running')

  // succeeded 但证据不符 → 最多 review，不能 done
  const mismatch = await f.runtime.request('POST', `/executor/v1/commands/${commandId}/receipt`, {
    executorEpoch: 'epoch-1', state: 'succeeded', evidenceRefs: ['uia-readback:x'], validatorKind: 'ui-readback',
    evidence: { successCheck: { page: 3 }, readBack: { page: 4, total: 12 } },
  }, 'executor')
  assert.equal(mismatch.status, 200)
  assert.equal((mismatch.body as { state: string }).state, 'review')
  const reviewed = await f.runtime.request('GET', `/companion/v1/tasks/${taskId}`, null, 'client')
  assert.equal((reviewed.body as { task: { status: string } }).task.status, 'review')
  const replay = await f.runtime.request('POST', `/executor/v1/commands/${commandId}/receipt`, {
    executorEpoch: 'epoch-1', state: 'succeeded', evidenceRefs: ['uia-readback:x'], validatorKind: 'ui-readback',
    evidence: { successCheck: { page: 3 }, readBack: { page: 3, total: 12 } },
  }, 'executor')
  assert.equal(replay.status, 409, '已有回执不能被另一份回执覆盖')
})

test('读回匹配的成功回执经语义验证到 done；相同回执重复提交幂等', async t => {
  const f = fixture(t)
  registerDesktopExecutor()
  await createDesktopTask(f)
  const command = commandsOf((await f.runtime.request('GET', '/executor/v1/commands', null, 'executor')).body)[0]!
  const commandId = String(command.commandId)
  await f.runtime.request('POST', `/executor/v1/commands/${commandId}/claim`, { executorEpoch: 'epoch-1' }, 'executor')
  const receipt = {
    executorEpoch: 'epoch-1', state: 'succeeded', evidenceRefs: ['uia-readback:cmd-1'], validatorKind: 'ui-readback',
    evidence: { successCheck: { page: 3 }, readBack: { page: 3, total: 12 } },
  }
  const done = await f.runtime.request('POST', `/executor/v1/commands/${commandId}/receipt`, receipt, 'executor')
  assert.equal(done.status, 200)
  assert.equal((done.body as { state: string }).state, 'done')
  const again = await f.runtime.request('POST', `/executor/v1/commands/${commandId}/receipt`, receipt, 'executor')
  assert.equal(again.status, 200, '同一回执摘要重复提交返回原结果')
  assert.equal((again.body as { state: string }).state, 'settled')
  const noEvidence = await f.runtime.request('POST', `/executor/v1/commands/${commandId}/receipt`, {
    executorEpoch: 'epoch-1', state: 'succeeded', evidenceRefs: [],
  }, 'executor')
  assert.equal(noEvidence.status, 409, '已结算命令不再接受新回执')
})

test('partial/unknown/failed-before-effect 分别进入复核、未知与失败，且不自动重发', async t => {
  const f = fixture(t)
  registerDesktopExecutor()
  const cases: Array<{ state: 'partial' | 'unknown' | 'failed-before-effect'; expected: string }> = [
    { state: 'partial', expected: 'review' },
    { state: 'unknown', expected: 'unknown' },
    { state: 'failed-before-effect', expected: 'failed' },
  ]
  for (const [index, item] of cases.entries()) {
    await createDesktopTask(f, desktopInput, `cmd-state-${index}`)
    const commands = commandsOf((await f.runtime.request('GET', '/executor/v1/commands', null, 'executor')).body)
    const command = commands[0]!
    const commandId = String(command.commandId)
    await f.runtime.request('POST', `/executor/v1/commands/${commandId}/claim`, { executorEpoch: 'epoch-1' }, 'executor')
    const result = await f.runtime.request('POST', `/executor/v1/commands/${commandId}/receipt`, {
      executorEpoch: 'epoch-1', state: item.state, evidenceRefs: item.state === 'partial' ? ['action:act-1'] : [],
    }, 'executor')
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal((result.body as { state: string }).state, item.expected)
    const remaining = commandsOf((await f.runtime.request('GET', '/executor/v1/commands', null, 'executor')).body)
    assert.ok(!remaining.some(entry => entry.commandId === commandId), '回执后命令不再可领取，不自动重试')
  }
})

test('运行时重启：内存命令全失效，遗留受管任务对账为 unknown', async t => {
  const f = fixture(t)
  registerDesktopExecutor()
  const { created } = await createDesktopTask(f)
  const taskId = (created.body as { task: { taskId: string } }).task.taskId
  const command = commandsOf((await f.runtime.request('GET', '/executor/v1/commands', null, 'executor')).body)[0]!
  await f.runtime.request('POST', `/executor/v1/commands/${String(command.commandId)}/claim`, { executorEpoch: 'epoch-1' }, 'executor')

  f.restart('epoch-2')
  const detail = await f.runtime.request('GET', `/companion/v1/tasks/${taskId}`, null, 'client')
  assert.equal((detail.body as { task: { status: string } }).task.status, 'unknown', '重启后无法证明是否已执行，禁止自动重发')
  const listed = await f.runtime.request('GET', '/executor/v1/commands', null, 'executor')
  assert.equal(commandsOf(listed.body).length, 0, '旧代次命令不复活')
  const stale = await f.runtime.request('POST', `/executor/v1/commands/${String(command.commandId)}/receipt`, {
    executorEpoch: 'epoch-1', state: 'succeeded', evidenceRefs: ['x'],
  }, 'executor')
  assert.equal(stale.status, 404, '旧命令已随代次消失')
})