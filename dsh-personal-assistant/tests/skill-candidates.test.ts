/** 仅在隔离任务库中识别候选；不安装技能、不调用模型或外部服务。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApprovalService } from '../src/approval.ts'
import { CompanionTaskRuntime } from '../src/task-runtime.ts'
import { registerCompanionTools } from '../src/task-tools.ts'
import { TeamStore } from '../src/team-domain.ts'

test('重复候选只来自本人确认完成且输入一致的工作，不自动试跑或启用', async t => {
  const store = new TeamStore(':memory:')
  const now = 1_800_000_000_000
  const runtime = new CompanionTaskRuntime(store, new ApprovalService(store, { ttlMs: 120_000, runtimeEpoch: 'test', now: () => now }), { epoch: 'test', now: () => now })
  t.after(async () => { await runtime.dispose(); store.close() })
  const command = (id: string, payload: unknown) => ({ protocolVersion: 1, commandId: id, expiresAt: new Date(now + 60_000).toISOString(), payload })
  async function create(index: number, description: string, complete: boolean) {
    const prepared = await runtime.request('POST', '/companion/v1/inputs', { kind: 'agent', executionMode: 'manual', description }, 'owner')
    const result = await runtime.request('POST', '/companion/v1/tasks', command(`create-${index}`, {
      kind: 'agent', title: '整理日报', inputRef: (prepared.body as any).inputRef, dependsOn: [],
    }), 'owner')
    const task = (result.body as any).task
    if (complete) await runtime.request('POST', `/companion/v1/tasks/${task.taskId}/complete`, {
      ...command(`done-${index}`, {}), taskId: task.taskId, expectedRevision: task.revision,
    }, 'owner')
    return task.taskId as string
  }
  const a = await create(1, '只整理已确认的工作事项', true)
  const b = await create(2, '只整理已确认的工作事项', true)
  await create(3, '不要整理已确认的工作事项', true)
  const unconfirmed = await create(4, '只整理已确认的工作事项', false)
  const task = store.getTask(unconfirmed)!
  store.updateTask(task.taskId, task.revision, { status: 'done' })
  const definitions = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  const dispose = registerCompanionTools({ tools: { register: (value: any) => { definitions.set(value.name, value); return () => definitions.delete(value.name) } } },
    runtime, { desktopBinding: agent => (agent as { id?: string })?.id === 'desktop' ? 'binding' : null })
  try {
    const candidateTool = definitions.get('companion_skill_candidates')!
    const exec = { agent: { id: 'desktop' }, signal: new AbortController().signal }
    const operations = store.listOperations().length
    const result = JSON.parse(await candidateTool.execute({}, exec))
    assert.equal(result.ok, true)
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0].count, 2)
    assert.deepEqual(new Set(result.candidates[0].taskIds), new Set([a, b]))
    assert.equal(result.candidates[0].enabled, false)
    assert.match(result.notice, /未试跑|不能启用/)
    assert.equal(store.listOperations().length, operations, '列候选不产生执行或安装操作')
    const denied = JSON.parse(await candidateTool.execute({}, { agent: { id: 'channel-abc' }, signal: exec.signal }))
    assert.equal(denied.ok, false)
  } finally { dispose() }
})
