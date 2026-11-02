/** 全部使用合成 1×1 图片、模型替身和模拟审批，不读取真实屏幕或联网。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AssistantApprovalService } from '../src/assistant-approval.ts'
import { registerComputerTools } from '../src/computer.ts'
import { cardView, confirmDialogSpec } from '../../dsh-pet/src/main/approval-policy.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6t2wAAAAASUVORK5CYII='
const target = { windowId: '123', pid: 1234, processPath: 'C:\\Apps\\editor.exe', processStartedAt: '1000',
  className: 'EditorWindow', title: '当前文件', left: 0, top: 0, width: 1, height: 1 }
const screen = { left: 0, top: 0, width: 1, height: 1,
  displays: [{ name: '\\\\.\\DISPLAY1', left: 0, top: 0, width: 1, height: 1, primary: true }] }

function fixture(platform = 'win32') {
  const approvals = new AssistantApprovalService({ epoch: 'epoch', ttlMs: 120_000 })
  const definitions = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  const calls: Array<Record<string, any>> = [], saved: any[] = [], requests: any[] = [], prepared: any[] = []
  let modalities = ['text', 'image'], failure = false, image = png
  let returnedScreen = screen, returnedTarget = target
  let useServiceProxies = false
  let capture: (() => Promise<void>) | undefined, save: (() => Promise<void>) | undefined
  const routeListeners = new Set<() => void>()
  const attachments = { imageLimits: { maxImageBytes: 1_000_000, maxImagesPerMessage: 1, maxMessageImageBytes: 1_000_000, maxImagePixels: 1000, maxImageDimension: 1000, mediaTypes: ['image/png'] },
    saveImage: async (value: any) => { saved.push({ ...value, data: Buffer.from(value.data) }); await save?.(); return { attachmentId: 'synthetic-id', mediaType: 'image/png', bytes: value.data.length, width: 1, height: 1 } } }
  const llm = { prepareCall: async (config: any) => {
    prepared.push(config)
    return { config, inputModalities: modalities, stream: async function* (request: any) {
      requests.push(request)
      if (failure) { yield { type: 'finish', reason: { kind: 'error' } }; return }
      yield { type: 'text-delta', index: 0, text: '屏幕中可见一个编辑器；函数位置无法确定。' }
      yield { type: 'usage', usage: { inputTokens: 25, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  } }
  const agent = { id: 'desktop', session: { id: 'desktop', header: { id: 'desktop', version: 4, isSeeded: false } },
    options: { provider: 'mock-provider', model: 'vision-model' },
    ctx: { get: (name: string) => {
      const service = name === 'attachments' ? attachments : name === 'llm' ? llm : undefined
      return service && useServiceProxies ? new Proxy(service, { get: (object, key) =>
        key === Symbol.for('cordis.original') ? object : Reflect.get(object, key) }) : service
    },
      on: (name: string, handler: () => void) => { assert.equal(name, 'llm/adapters-updated'); routeListeners.add(handler); return () => routeListeners.delete(handler) } } }
  const bridge = { desktopBinding: (value: unknown) => value === agent ? 'binding' : null,
    submitAssistant: (submission: any) => approvals.submit(submission), invalidateAssistantApprovals: (subject: string) => approvals.invalidateAll(subject) }
  const run = async (_script: string, payload: Record<string, unknown>) => {
    calls.push(structuredClone(payload))
    if (payload.action === 'snapshot') return { ok: true, target, screen }
    await capture?.()
    return { ok: true, target: returnedTarget, screen: returnedScreen, pngBase64: image }
  }
  const dispose = registerComputerTools({ tools: { register: (value: any) => { definitions.set(value.name, value); return () => definitions.delete(value.name) } } },
    { bridge: bridge as never, scriptDir: 'C:\\fake', shotDir: 'C:\\fake', approvalMode: () => 'auto', log: () => {}, run, platform })
  const controller = new AbortController()
  const exec = { agent, signal: controller.signal }
  const look = async (args: unknown) => JSON.parse(await definitions.get('personal_assistant_computer_look')!.execute(args, exec))
  const approve = (id: string) => approvals.decide(id, 'approve', 'epoch', approvals.approvalCapabilityToken)
  return { calls, saved, requests, prepared, approvals, agent, controller, look, approve, dispose,
    setModalities: (value: string[]) => { modalities = value }, setFailure: () => { failure = true }, setImage: (value: string) => { image = value },
    setScreen: (value: typeof screen) => { returnedScreen = value }, setTarget: (value: typeof target) => { returnedTarget = value },
    setCapture: (fn: () => Promise<void>) => { capture = fn }, setSave: (fn: () => Promise<void>) => { save = fn },
    updateRoute: () => { for (const listener of routeListeners) listener() }, listeners: () => routeListeners.size,
    useServiceProxies: () => { useServiceProxies = true } }
}

test('截图与图像模型请求必须逐次经本人批准，绑定屏幕范围、问题和模型', async () => {
  const f = fixture()
  try {
    const pending = await f.look({ screenshot: true, question: '请说明当前屏幕显示什么' })
    assert.equal(pending.pending, true)
    assert.equal(f.calls.length, 1, '批准前只读取窗口和屏幕几何信息，不截图')
    assert.equal(f.saved.length, 0)
    assert.equal(f.requests.length, 0)
    assert.equal(f.prepared.length, 0, '批准前不查询模型服务，也不发送图片或问题')
    const proposal = f.approvals.pendingProposals()[0]
    assert.match(proposal.content, /全部屏幕|整个屏幕/)
    assert.match(proposal.content, /mock-provider/)
    assert.match(proposal.content, /vision-model/)
    assert.match(proposal.content, /附件|保存/)
    assert.match(proposal.content, /额外|费用/)
    assert.match(proposal.content, /其他窗口|敏感/)
    assert.match(proposal.content, /不.*自动.*删除|无法.*自动.*删除/)
    assert.match(proposal.content, /请说明当前屏幕显示什么/)
    const card = cardView(proposal, null, Date.now())
    assert.equal(card.canDecide, true)
    assert.equal(card.needsNativeConfirm, true)
    const confirmation = confirmDialogSpec(card, null, Date.now())
    assert.match(confirmation.message, /批准本身不会|尚未截屏/)
    for (const word of ['全部屏幕', 'mock-provider', 'vision-model', '请说明当前屏幕显示什么', '本地附件', '额外费用']) {
      assert.ok(confirmation.detail.includes(word), `专用审批和原生确认缺少：${word}`)
    }
    assert.equal((await f.approve(pending.proposalId)).ok, true)
    assert.equal(f.calls.length, 1, '批准只授予许可，不立即截图')
    const result = await f.look({ targetId: pending.targetId })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.match(result.analysis, /无法确定/)
    assert.equal(result.verified, false)
    assert.deepEqual(result.usage, { inputTokens: 25, outputTokens: 10 })
    assert.equal(f.calls[1].screenshot, true)
    assert.deepEqual(f.calls[1].screen, screen)
    assert.equal(f.saved.length, 1)
    assert.equal(f.requests.length, 1)
    assert.equal(f.prepared.length, 1)
    assert.equal(f.requests[0].provider, 'mock-provider')
    assert.equal(f.requests[0].model, 'vision-model')
    assert.equal(f.requests[0].messages[0].content[1].type, 'image')
    assert.match(f.requests[0].system, /不可信|不能.*指令/)
    assert.deepEqual(f.requests[0].tools, [])
    assert.match(result.notice, /不可信|不能.*指令/)
    assert.doesNotMatch(JSON.stringify(result), /iVBOR/)
    assert.equal((await f.look({ targetId: pending.targetId })).ok, false, '一次授权只能使用一次')
    assert.equal(f.listeners(), 0, '单次分析结束后撤销模型变更监听')
  } finally { f.dispose() }
})

test('宿主每次返回新的服务代理时仍可核验同一个服务', async () => {
  const f = fixture()
  try {
    f.useServiceProxies()
    const pending = await f.look({ screenshot: true, question: '画面里有什么' })
    assert.equal(pending.pending, true)
    assert.equal((await f.approve(pending.proposalId)).ok, true)
    assert.equal((await f.look({ targetId: pending.targetId })).ok, true)
    assert.equal(f.requests.length, 1)
  } finally { f.dispose() }
})

test('独立图像请求遵守主会话较小的单次输出上限，变更后不截屏', async () => {
  const f = fixture()
  try {
    ;(f.agent.options as { maxTokens?: number }).maxTokens = 128
    const pending = await f.look({ screenshot: true, question: '画面里有什么' })
    assert.match(f.approvals.pendingProposals()[0].content, /128/)
    await f.approve(pending.proposalId)
    const result = await f.look({ targetId: pending.targetId })
    assert.equal(result.ok, true)
    assert.equal(f.requests[0].maxTokens, 128)
    const next = await f.look({ screenshot: true, question: '再看一次' })
    await f.approve(next.proposalId)
    ;(f.agent.options as { maxTokens?: number }).maxTokens = 256
    const count = f.calls.length
    assert.equal((await f.look({ targetId: next.targetId })).ok, false)
    assert.equal(f.calls.length, count)
  } finally { f.dispose() }
})

test('截图授权不能顺带读取控件或变更问题；并发领取也只能发送一次', async () => {
  const f = fixture()
  let release!: () => void, started!: () => void
  const blocking = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  f.setCapture(async () => { started(); await blocking })
  try {
    assert.equal((await f.look({ screenshot: true, question: '画面里有什么', maxDepth: 3 })).ok, false)
    const pending = await f.look({ screenshot: true, question: '画面里有什么' })
    await f.approve(pending.proposalId)
    assert.equal((await f.look({ targetId: pending.targetId, question: '偷偷换问题' })).ok, false)
    const first = f.look({ targetId: pending.targetId })
    await entered
    assert.equal((await f.look({ targetId: pending.targetId })).ok, false)
    release()
    assert.equal((await first).ok, true)
    assert.equal(f.requests.length, 1)
    assert.equal(f.calls[1].maxDepth, undefined)
  } finally { release(); f.dispose() }
})

test('已准备的模型调用配置在截屏途中被篡改时，不保存也不发送', async () => {
  const f = fixture()
  let release!: () => void, started!: () => void
  const blocking = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  f.setCapture(async () => { started(); await blocking })
  try {
    const pending = await f.look({ screenshot: true, question: '画面里有什么' })
    await f.approve(pending.proposalId)
    const reading = f.look({ targetId: pending.targetId })
    await entered
    f.prepared[0].model = '未经同意的模型'
    release()
    const result = await reading
    assert.equal(result.ok, false)
    assert.equal(f.saved.length, 0)
    assert.equal(f.requests.length, 0)
  } finally { release(); f.dispose() }
})

test('模型不支持图片或审批后切换模型时，不截屏、不保存、不发送', async () => {
  const unsupported = fixture()
  try {
    unsupported.setModalities(['text'])
    const pending = await unsupported.look({ screenshot: true, question: '这是什么' })
    assert.equal((await unsupported.approve(pending.proposalId)).ok, true)
    const result = await unsupported.look({ targetId: pending.targetId })
    assert.equal(result.ok, false)
    assert.match(result.error, /图像|图片/)
    assert.equal(unsupported.calls.length, 1, '只获取布局，不截屏')
    assert.equal(unsupported.saved.length, 0)
    assert.equal(unsupported.requests.length, 0)
  } finally { unsupported.dispose() }
  const changed = fixture()
  try {
    const pending = await changed.look({ screenshot: true, question: '这是什么' })
    await changed.approve(pending.proposalId)
    changed.agent.options.model = 'other-model'
    assert.equal((await changed.look({ targetId: pending.targetId })).ok, false)
    assert.equal(changed.calls.length, 1)
    assert.equal(changed.saved.length, 0)
  } finally { changed.dispose() }
  const replaced = fixture()
  try {
    const pending = await replaced.look({ screenshot: true, question: '这是什么' })
    await replaced.approve(pending.proposalId)
    replaced.updateRoute()
    assert.equal((await replaced.look({ targetId: pending.targetId })).ok, false)
    assert.equal(replaced.calls.length, 1, '服务商注册变化后不截屏')
    assert.equal(replaced.requests.length, 0)
  } finally { replaced.dispose() }
})

test('图像无效不外发；模型失败后如实提示可能已发送且不自动重试', async () => {
  const invalid = fixture()
  try {
    invalid.setImage('不是图片')
    const pending = await invalid.look({ screenshot: true, question: '这是什么' })
    await invalid.approve(pending.proposalId)
    assert.equal((await invalid.look({ targetId: pending.targetId })).ok, false)
    assert.equal(invalid.saved.length, 0)
    assert.equal(invalid.requests.length, 0)
  } finally { invalid.dispose() }
  const failed = fixture()
  try {
    failed.setFailure()
    const pending = await failed.look({ screenshot: true, question: '这是什么' })
    await failed.approve(pending.proposalId)
    const result = await failed.look({ targetId: pending.targetId })
    assert.equal(result.ok, false)
    assert.match(result.error, /可能已发送|已发送|结果未知/)
    assert.equal(failed.requests.length, 1)
    assert.equal((await failed.look({ targetId: pending.targetId })).ok, false)
    assert.equal(failed.requests.length, 1)
  } finally { failed.dispose() }
})

test('窗口或显示器布局变化时丢弃截图，不保存或发送', async () => {
  for (const change of ['screen', 'window'] as const) {
    const f = fixture()
    try {
      const pending = await f.look({ screenshot: true, question: '这是什么' })
      await f.approve(pending.proposalId)
      if (change === 'screen') f.setScreen({ ...screen, displays: [{ ...screen.displays[0], name: '\\\\.\\DISPLAY2' }] })
      else f.setTarget({ ...target, title: '已经切换的页面' })
      const result = await f.look({ targetId: pending.targetId })
      assert.equal(result.ok, false)
      assert.equal(f.saved.length, 0)
      assert.equal(f.requests.length, 0)
    } finally { f.dispose() }
  }
})

test('成员、渠道和子代理不能借截图调用绕开软额度', async () => {
  for (const identity of ['member-123', 'member-channel-123', 'channel-abc-123']) {
    const f = fixture()
    try {
      f.agent.id = identity
      f.agent.session.id = identity
      f.agent.session.header.id = identity
      const result = await f.look({ screenshot: true, question: '这是什么' })
      assert.equal(result.ok, false)
      assert.equal(f.calls.length, 0)
      assert.equal(f.prepared.length, 0)
      assert.equal(f.requests.length, 0)
    } finally { f.dispose() }
  }
  const child = fixture()
  try {
    ;(child.agent.session.header as { parentSession?: string }).parentSession = 'parent'
    assert.equal((await child.look({ screenshot: true, question: '这是什么' })).ok, false)
    assert.equal(child.calls.length, 0)
  } finally { child.dispose() }
})

test('不支持的平台如实拒绝，不读取屏幕或请求模型', async () => {
  const f = fixture('darwin')
  try {
    const result = await f.look({ screenshot: true, question: '看一下' })
    assert.equal(result.ok, false)
    assert.match(result.error, /Windows/)
    assert.equal(f.calls.length, 0)
    assert.equal(f.prepared.length, 0)
  } finally { f.dispose() }
})

test('截图或附件保存期间取消，绝不发送模型；已用许可不能重放', async () => {
  for (const stage of ['capture', 'save'] as const) {
    const f = fixture()
    let release!: () => void, started!: () => void
    const blocking = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    const wait = async () => { started(); await blocking }
    if (stage === 'capture') f.setCapture(wait)
    else f.setSave(wait)
    try {
      const pending = await f.look({ screenshot: true, question: '这是什么' })
      await f.approve(pending.proposalId)
      const reading = f.look({ targetId: pending.targetId })
      await entered
      f.controller.abort('用户取消')
      release()
      const result = await reading
      assert.equal(result.ok, false)
      assert.equal(f.requests.length, 0)
      assert.equal(f.saved.length, stage === 'save' ? 1 : 0)
      if (stage === 'save') assert.match(result.error, /本机附件|已保存/)
      assert.equal((await f.look({ targetId: pending.targetId })).ok, false)
      assert.equal(f.requests.length, 0)
    } finally { release(); f.dispose() }
  }
})
