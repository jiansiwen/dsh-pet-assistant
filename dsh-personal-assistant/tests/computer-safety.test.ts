import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { AssistantApprovalService, BeforeEffectError } from '../src/assistant-approval.ts'
import { parseComputerResponse, registerComputerTools } from '../src/computer.ts'

const target = { windowId: '123', pid: 1234, processPath: 'C:\\Apps\\editor.exe', processStartedAt: '1000',
  className: 'EditorWindow', title: '当前文件', left: 10, top: 20, width: 800, height: 600 }
const control = { runtimeId: [1, 2, 3], name: '正文', type: 'Edit', className: 'Editor', left: 30, top: 40, width: 300, height: 200, isPassword: false }

function fixture() {
  const approvals = new AssistantApprovalService({ epoch: 'test-epoch', ttlMs: 120_000 })
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  const calls: Array<Record<string, any>> = []
  let actionError: Error | null = null
  let binding = 'binding-1'
  const run = async (_script: string, payload: Record<string, unknown>, _signal?: AbortSignal) => {
    calls.push(structuredClone(payload))
    if (payload.action === 'snapshot') return { ok: true, target }
    if (payload.action === 'look') return { ok: true, target, tree: ['Edit 正文'], truncated: false }
    if (payload.action === 'probe') return { ok: true, target, control }
    if (actionError) throw actionError
    return { ok: true, target, before: control, after: control, verified: false }
  }
  const bridge = { submitAssistant: (submission: any) => approvals.submit(submission), invalidateAssistantApprovals: (subject: string) => approvals.invalidateAll(subject),
    desktopBinding: (agent: { id?: string }) => agent?.id === 'desktop-session' ? binding : null }
  const dispose = registerComputerTools({ tools: { register(def: any) { tools.set(def.name, def); return () => tools.delete(def.name) } } },
    { scriptDir: 'C:\\fixture', shotDir: 'C:\\fixture', approvalMode: () => 'auto', bridge: bridge as never, log: () => {}, run })
  const signal = new AbortController()
  const exec = { agent: { id: 'desktop-session' }, signal: signal.signal }
  const call = async (name: string, args: unknown, context: unknown = exec) => JSON.parse(await tools.get(`personal_assistant_computer_${name}`)!.execute(args, context))
  const approve = (id: string) => approvals.decide(id, 'approve', 'test-epoch', approvals.approvalCapabilityToken)
  return { tools, calls, approvals, signal, exec, call, approve, dispose, rebind: () => { binding = 'binding-2' }, failAction: (error: Error) => { actionError = error } }
}

test('观察须先批准固定窗口，不能跨会话领取；自动模式也不能绕过', async () => {
  const f = fixture()
  try {
    const pending = await f.call('look', {})
    assert.equal(pending.pending, true)
    assert.equal(f.calls.length, 1, '批准前只读取窗口身份，不读取控件')
    assert.equal(f.calls[0].action, 'snapshot')
    assert.equal((await f.call('look', { targetId: pending.targetId })).ok, false)
    assert.equal((await f.call('look', { targetId: pending.targetId }, { agent: { id: 'other' }, signal: f.signal.signal })).ok, false)
    assert.equal((await f.approve(pending.proposalId)).ok, true)
    const result = await f.call('look', { targetId: pending.targetId })
    assert.equal(result.ok, true)
    assert.deepEqual(result.controls, ['Edit 正文'])
    assert.deepEqual(f.calls[1].target, target)
    assert.equal((await f.call('look', { targetId: pending.targetId })).ok, false, '单次读取授权不能反复使用')
    assert.equal((await f.call('look', { screenshot: true })).ok, false, '截图必须明确问题并确认图像服务')
    assert.equal((await f.call('look', {}, { agent: { id: 'channel-abc-1' }, signal: f.signal.signal })).ok, false)
    const brokenAgent = Object.defineProperty({ id: 'desktop-session' }, 'session', { get() { throw new Error('宿主上下文不可用') } })
    assert.equal((await f.call('look', {}, { agent: brokenAgent, signal: f.signal.signal })).ok, false)
  } finally { f.dispose() }
})

test('操作审批绑定已观察窗口和控件；变化或取消时不执行', async () => {
  const f = fixture()
  try {
    const pending = await f.call('look', {})
    await f.approve(pending.proposalId)
    await f.call('look', { targetId: pending.targetId })
    const proposed = await f.call('click', { targetId: pending.targetId, x: 80, y: 80 })
    assert.equal(proposed.pending, true)
    assert.equal(f.calls.at(-1)?.action, 'probe')
    assert.deepEqual(f.calls.at(-1)?.target, target)
    const snap = f.approvals.pendingProposals()[0]
    assert.match(snap.content, /EditorWindow/)
    f.failAction(new BeforeEffectError('目标已切换，未操作'))
    const approved = await f.approve(proposed.proposalId)
    assert.equal(approved.ok, true)
    assert.equal(f.calls.at(-1)?.action, 'probe', '批准只授予一次操作许可，不立即发送输入')
    const refused = await f.call('apply', { actionId: proposed.actionId })
    assert.equal(refused.ok, false)
    assert.equal(refused.state, 'failed-before-effect')
    assert.deepEqual(f.calls.at(-1)?.target, target)
    assert.deepEqual(f.calls.at(-1)?.control, control)
    assert.equal((await f.call('apply', { actionId: proposed.actionId })).ok, false, '已消费操作不能重放')
    const before = f.calls.length
    assert.equal((await f.call('click', { targetId: pending.targetId, x: 900, y: 900 })).ok, false)
    assert.equal(f.calls.length, before, '窗口外坐标不探测、不执行')
    f.signal.abort()
    assert.equal((await f.call('type', { targetId: pending.targetId, text: '不应输入' })).ok, false)
  } finally { f.dispose() }
})

test('普通文字保持原样绑定，不交给 SendKeys 解释；结果不能当成业务成功', async () => {
  const f = fixture()
  try {
    const pending = await f.call('look', {})
    await f.approve(pending.proposalId)
    await f.call('look', { targetId: pending.targetId })
    const text = '^+(%{}[]~)你好'
    const proposal = await f.call('type', { targetId: pending.targetId, text })
    assert.equal(proposal.pending, true)
    assert.equal((await f.approve(proposal.proposalId)).ok, true)
    const result = await f.call('apply', { actionId: proposal.actionId })
    assert.equal(result.ok, true)
    assert.equal(result.verified, false)
    assert.equal(f.calls.at(-1)?.text, text)
    const script = readFileSync(new URL('../assets/computer.ps1', import.meta.url), 'utf8')
    assert.doesNotMatch(script, /SendWait\(\$text\)/)
    assert.match(script, /SendUnicode/)
    assert.equal((await f.call('type', { targetId: pending.targetId, text: '一行\n另一行' })).ok, false)
  } finally { f.dispose() }
})

test('模型工具运行正常结束后仍可批准，但执行必须重新使用可取消的会话请求', async () => {
  const f = fixture()
  try {
    const pending = await f.call('look', {})
    f.signal.abort('run_code settled')
    assert.equal((await f.approve(pending.proposalId)).ok, true)
    const fresh = { agent: { id: 'desktop-session' }, signal: new AbortController().signal }
    assert.equal((await f.call('look', { targetId: pending.targetId }, fresh)).ok, true)
    const action = await f.call('key', { targetId: pending.targetId, keys: '^s' }, fresh)
    assert.equal((await f.approve(action.proposalId)).ok, true)
    assert.equal((await f.call('apply', { actionId: action.actionId }, { agent: { id: 'other' }, signal: fresh.signal })).ok, false)
    assert.equal((await f.call('apply', { actionId: action.actionId }, fresh)).verified, false)
  } finally { f.dispose() }
})

test('明确取消撤销尚未执行的目标及操作许可', async () => {
  const f = fixture()
  try {
    const pending = await f.call('look', {})
    await f.approve(pending.proposalId)
    await f.call('look', { targetId: pending.targetId })
    const action = await f.call('click', { targetId: pending.targetId, x: 80, y: 80 })
    await f.approve(action.proposalId)
    assert.equal((await f.call('cancel', { targetId: pending.targetId })).cancelled, true)
    assert.equal((await f.call('apply', { actionId: action.actionId })).ok, false)
    assert.equal(f.calls.filter(item => item.action === 'click').length, 0)
  } finally { f.dispose() }
})

test('明确中断或桌面重新绑定后，旧目标不可继续使用', async () => {
  const f = fixture()
  try {
    const pending = await f.call('look', {})
    f.signal.abort('user cancelled')
    assert.equal((await f.approve(pending.proposalId)).ok, false)
    const fresh = { agent: { id: 'desktop-session' }, signal: new AbortController().signal }
    const next = await f.call('look', {}, fresh)
    assert.equal((await f.approve(next.proposalId)).ok, true)
    f.rebind()
    assert.equal((await f.call('look', { targetId: next.targetId }, fresh)).ok, false)
    assert.equal(f.calls.filter(item => item.action === 'look').length, 0)
  } finally { f.dispose() }
})

test('非零退出、缺少或错误结果不能伪装成成功', () => {
  assert.throws(() => parseComputerResponse('{}', '', 0), /必要字段|无效/)
  assert.throws(() => parseComputerResponse('', '', 0), /解析|无效/)
  assert.throws(() => parseComputerResponse('{"ok":true}', '失败', 1), /失败/)
  assert.throws(() => parseComputerResponse('{"ok":false,"error":"目标不可见","mayHaveExecuted":false}', '', 0), /不可见/)
  assert.deepEqual(parseComputerResponse('{"ok":true,"action":"snapshot"}', '', 0), { ok: true, action: 'snapshot' })
})
