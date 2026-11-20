import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AssistantApprovalService, BeforeEffectError } from '../src/assistant-approval.ts'
import { registerComputerTools } from '../src/computer.ts'

const target = { windowId: '123', pid: 1234, processPath: 'C:\\Apps\\editor.exe', processStartedAt: '1000',
  className: 'EditorWindow', title: '当前文件', left: 10, top: 20, width: 800, height: 600 }
const control = { runtimeId: [1, 2, 3], name: '正文', type: 'Edit', className: 'Editor', left: 30, top: 40, width: 300, height: 200, isPassword: false }

function fixture() {
  const approvals = new AssistantApprovalService({ epoch: 'test-epoch', ttlMs: 120_000 })
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  const calls: Array<Record<string, any>> = []
  let actionError: Error | null = null
  let mutate: ((result: Record<string, unknown>) => void) | null = null
  let binding: string | null = 'binding-1'
  let executorApply: ((actionId: string) => Promise<Record<string, unknown>>) | null = null
  const run = async (_script: string, payload: Record<string, unknown>) => {
    calls.push(structuredClone(payload))
    if (payload.action === 'snapshot') return { ok: true, target }
    if (payload.action === 'look') return { ok: true, target, tree: ['Edit 正文'], truncated: false }
    if (payload.action === 'probe') return { ok: true, target, control }
    if (actionError) throw actionError
    const result: Record<string, unknown> = { ok: true, target, before: control, after: control, verified: false }
    mutate?.(result)
    return result
  }
  const bridge = {
    submitAssistant: (submission: any) => approvals.submit(submission),
    invalidateAssistantApprovals: (subject: string) => approvals.invalidateAll(subject),
    desktopBinding: (agent: { id?: string }) => agent?.id === 'desktop-session' ? binding : null,
    currentDesktopBinding: () => binding,
  }
  const dispose = registerComputerTools({ tools: { register(def: any) { tools.set(def.name, def); return () => tools.delete(def.name) } } }, {
    scriptDir: 'C:\\fixture', shotDir: 'C:\\fixture', approvalMode: () => 'auto', bridge: bridge as never, log: () => {}, run,
    attachComputerExecutor: fn => { executorApply = fn },
  })
  const signal = new AbortController()
  const exec = { agent: { id: 'desktop-session' }, signal: signal.signal }
  const call = async (name: string, args: unknown) => JSON.parse(await tools.get(`personal_assistant_computer_${name}`)!.execute(args, exec))
  const approve = (id: string) => approvals.decide(id, 'approve', 'test-epoch', approvals.approvalCapabilityToken)
  const authorizedAction = async () => {
    const pending = await call('look', {})
    await approve(pending.proposalId)
    await call('look', { targetId: pending.targetId })
    const proposed = await call('click', { targetId: pending.targetId, x: 80, y: 80 })
    await approve(proposed.proposalId)
    return String(proposed.actionId)
  }
  return {
    calls, dispose, authorizedAction, approve,
    apply: (id: string) => executorApply!(id),
    rebind: () => { binding = 'binding-2' },
    offline: () => { binding = null },
    failAction: (error: Error) => { actionError = error },
    mutateResult: (fn: (result: Record<string, unknown>) => void) => { mutate = fn },
  }
}

test('执行器消费已批准动作：issued/verified:false，且一次性消费不重放', async () => {
  const f = fixture()
  try {
    const actionId = await f.authorizedAction()
    const before = f.calls.length
    const result = await f.apply(actionId)
    assert.equal(result.ok, true)
    assert.equal(result.state, 'issued')
    assert.equal(result.verified, false)
    assert.equal(f.calls.length, before + 1, '消费只发送一次输入')
    const again = await f.apply(actionId)
    assert.equal(again.state, 'failed-before-effect', '已消费许可不能重放')
    assert.equal(f.calls.length, before + 1)
  } finally { f.dispose() }
})

test('未批准/不存在/绑定变化/离线都拒绝且不发送输入', async () => {
  const f = fixture()
  try {
    const unknown = await f.apply('nope')
    assert.equal(unknown.state, 'failed-before-effect')
    const actionId = await f.authorizedAction()
    const before = f.calls.length
    f.rebind()
    assert.equal((await f.apply(actionId)).state, 'failed-before-effect', '桌面重绑后旧许可失效')
    assert.equal(f.calls.length, before)
    const second = await f.authorizedAction()
    const beforeOffline = f.calls.length
    f.offline()
    assert.equal((await f.apply(second)).state, 'failed-before-effect', '绑定离线不执行')
    assert.equal(f.calls.length, beforeOffline)
  } finally { f.dispose() }
})

test('执行前证实无效果记 failed-before-effect；异常与目标变化记 unknown 不重试', async () => {
  const f = fixture()
  try {
    const a = await f.authorizedAction()
    f.failAction(new BeforeEffectError('目标已切换，未操作'))
    assert.equal((await f.apply(a)).state, 'failed-before-effect')
    const b = await f.authorizedAction()
    f.failAction(new Error('辅助进程失联'))
    assert.equal((await f.apply(b)).state, 'unknown')
    const c = await f.authorizedAction()
    f.failAction(null as unknown as Error)
    f.mutateResult(result => { result.target = { ...target, title: '别的窗口' } })
    assert.equal((await f.apply(c)).state, 'unknown', '目标变化不能当成功')
  } finally { f.dispose() }
})