import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import * as contract from '../src/member-types.ts'
import type { MemberSnapshot, MemberResult, MemoryRecord } from '../src/member-types.ts'

// 只在内存转译 JSX 驱动组件事件，不执行项目构建，不生成文件，不启动浏览器。
const source = readFileSync(new URL('../src/renderer/MemberManagement.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
const require = createRequire(import.meta.url)
type Element = ReactElement<Record<string, unknown>>
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('')
  if (isValidElement<Record<string, unknown>>(node)) return text(node.props.children as ReactNode)
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}
function snapshot(): MemberSnapshot {
  return { enabled: false, defaultModel: { provider: '主服务商', model: '主模型' }, members: [{ profile: { assistantId: '成员甲', displayName: '研究员甲', personality: '', permissionMode: 'ask', description: '通用研究', persona: '按证据回答',
    roleId: 'wukong', skinId: 'wukong', voiceProfile: '', toolPolicy: { mode: 'read-only', denyTools: [] }, enabled: true, revision: 3, sessionId: '独立会话甲', provider: '', model: '',
    maxTokens: 2048, capabilities: [], allowedTools: [], dailyTokenLimit: 1000, totalTokenLimit: 5000, thresholdPercent: 80, timezone: 'Asia/Shanghai' },
    quota: { day: '2026-10-28', dailyUsed: 900, totalUsed: 4000, dailyReserved: 60, totalReserved: 60, dailyTokenLimit: 1000, totalTokenLimit: 5000, thresholdPercent: 80, unknown: false, blocked: false, revision: 9 }, busy: false }],
    requests: [{ requestId: '申请甲', assistantId: '成员甲', reason: '达到阈值', state: 'pending', createdAt: 1, quotaRevision: 9 }] }
}
const memory: MemoryRecord = { id: '记忆甲', kind: 'user_preference', scope: { kind: 'role', id: '成员甲' }, topic: '口径', text: '只写事实', sourceRefs: ['来源甲'], status: 'candidate', sensitivity: 'normal', createdBy: '成员甲', confirmedBy: null, revision: 4, createdAt: 1, updatedAt: 1, expiresAt: null, importBatch: null }
function mount(feedOnly = false) {
  const stores = new Map<string, unknown[]>()
  const cleanups = new Map<string, () => void>()
  let current = 'root', cursor = 0
  let effects: Array<() => void> = []
  let tree: ReactNode
  let state = snapshot()
  let readResult: MemberResult = { ok: true, state }
  let feedError = ''
  let reads = 0, refreshes = 0
  const writes: Array<{ action: string; input: Record<string, unknown> }> = []
  const toasts: string[] = []
  const opened: Array<string | null> = []
  let reply: (action: string) => Promise<MemberResult> = async action => action === 'memory-delete-preview'
    ? { ok: true, data: { previewId: '预览甲', impact: { affected: ['独立会话甲'] } } } : { ok: true }
  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const slots = stores.get(current)!, index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial
      return [slots[index], (value: T | ((previous: T) => T)) => { slots[index] = typeof value === 'function' ? (value as (previous: T) => T)(slots[index] as T) : value }]
    },
    useCallback<T>(value: T, deps: unknown[]) {
      const slots = stores.get(current)!, index = cursor++
      const old = slots[index] as { value: T; deps: unknown[] } | undefined
      if (!old || deps.some((dep, i) => dep !== old.deps[i])) slots[index] = { value, deps }
      return (slots[index] as { value: T }).value
    },
    useRef<T>(value: T) { return hooks.useCallback({ current: value }, []) },
    useEffect(callback: () => void | (() => void), deps: unknown[]) {
      const key = `${current}:${cursor}`, marker = {}
      if (hooks.useCallback(marker, deps) === marker) effects.push(() => {
        cleanups.get(key)?.()
        const cleanup = callback()
        if (cleanup) cleanups.set(key, cleanup)
      })
    },
  }
  type Feed = { state: MemberSnapshot | null; error: string; loading: boolean; refresh(): Promise<void> }
  const module = { exports: {} as { default: (props: { feed: Feed }) => ReactNode; useMemberFeed(show: (text: string) => void): Feed } }
  new Function('require', 'module', 'exports', compiled)((name: string) => name === 'react' ? hooks : name === '../member-types.ts' ? contract : require(name), module, module.exports)
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { petApi: {
    membersState: async () => { reads++; return readResult },
    memberMemories: async () => ({ ok: true, data: { records: [memory] } }),
    memberCommand: async (action: string, input: Record<string, unknown>) => { writes.push({ action, input: structuredClone(input) }); return reply(action) },
    memberAssist: async () => ({ ok: true, data: { draft: { displayName: 'AI 草稿', description: '', personality: '', permissionMode: 'ask', persona: '', skinId: 'panda', enabled: true, provider: '', model: '', maxTokens: 2048, capabilities: [], allowedTools: [], dailyTokenLimit: 0, totalTokenLimit: 0, thresholdPercent: 80, timezone: 'Asia/Shanghai' }, notes: '已填好' } }),
    openMemberEditor: async (id: string | null) => { opened.push(id); return { ok: true } },
  } } })
  let feed: Feed
  const toast = (value: string) => toasts.push(value)
  const refresh = async () => { refreshes++ }
  function context<T>(key: string, fn: () => T): T {
    current = key; cursor = 0
    if (!stores.has(key)) stores.set(key, [])
    return fn()
  }
  function expand(node: ReactNode, path: string): ReactNode {
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${isValidElement(child) && child.key !== null ? child.key : index}`))
    if (!isValidElement<Record<string, unknown>>(node)) return node
    if (typeof node.type === 'function') return expand(context(`${path}:${node.type.name}`, () => (node.type as (props: unknown) => ReactNode)(node.props)), `${path}/body`)
    return { ...node, props: { ...node.props, children: expand(node.props.children as ReactNode, `${path}/children`) } } as ReactElement
  }
  function render() {
    if (feedOnly) { feed = context('feed', () => module.exports.useMemberFeed(toast)); tree = null }
    else tree = expand(context('root', () => module.exports.default({ feed: { state, error: feedError, loading: false, refresh } })), 'root')
    const pending = effects; effects = []; pending.forEach(effect => effect())
  }
  render()
  return {
    writes, toasts, opened,
    get text() { return text(tree) }, get reads() { return reads }, get refreshes() { return refreshes }, get feed() { return feed },
    set state(value: MemberSnapshot) { state = value; render() }, set error(value: string) { feedError = value; render() },
    set reply(value: typeof reply) { reply = value }, set readResult(value: MemberResult) { readResult = value },
    async flush() { await new Promise<void>(resolve => setImmediate(resolve)); render() },
    field(label: string) {
      const parent = elements(tree).find(node => node.type === 'label' && text(node).includes(label))
      assert.ok(parent, `字段缺失：${label}`)
      const field = elements(parent).find(node => ['input', 'textarea', 'select'].includes(node.type as string))
      assert.ok(field); return field
    },
    change(label: string, value: string | boolean) { const field = this.field(label); (field.props.onChange as (event: unknown) => void)({ target: { value, checked: value } }); render() },
    button(label: string) { const button = elements(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(button, `按钮缺失：${label}`); return button },
    click(label: string) { (this.button(label).props.onClick as () => void)(); render() },
    submit(title: string) { const form = elements(tree).find(node => node.type === 'form' && text(node).includes(title)); assert.ok(form, `表单缺失：${title}`); (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} }); render() },
    dispose() { cleanups.forEach(cleanup => cleanup()); if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window') },
  }
}

test('阶段团队页只负责打开独立编辑窗口，列表与记忆仍在面板内', async () => {
  const view = mount()
  try {
    assert.match(view.text, /团队已关闭.*不运行子代理/s)
    assert.match(view.text, /主服务商.*主模型.*独立会话甲/s)
    // 软限额口径：预留计入进度，单次请求仍可能超额。
    assert.match(view.text, /日用量：900 \+ 60 预留 \/ 1,000/s)
    assert.match(view.text, /软限额：按已用量加在途预留停线，单次请求仍可能超出上限；不是计费硬封顶/s)
    assert.match(view.text, /独立窗口中打开.*一句话/s)
    view.click('添加自定义成员')
    view.click('编辑成员')
    assert.deepEqual(view.opened, [null, '成员甲'])
    assert.equal(view.writes.length, 0)
    view.click('独立记忆'); await view.flush()
    assert.match(view.text, /口径.*候选/s)
  } finally { view.dispose() }
})

test('邮件通知结果未知时，团队页持续显示待核查提示并可提交本人核对', async () => {
  const view = mount()
  try {
    const next = snapshot() as MemberSnapshot & { mailNoticeAttention: Array<{ analysisId: string; memberId: string; attemptId: string; state: 'unknown'; preview: string }> }
    next.mailNoticeAttention = [{ analysisId: '00000000-0000-4000-8000-000000000001', memberId: '成员甲',
      attemptId: '00000000-0000-4000-8000-000000000002', state: 'unknown', preview: '隔离邮件摘要' }]
    view.state = next
    assert.match(view.text, /待核查邮件通知/u)
    assert.match(view.text, /研究员甲.*结果未知.*隔离邮件摘要/su)
    assert.match(view.text, /不会自动重发/u)
    view.click('已核对，不再提示…')
    await view.flush()
    assert.deepEqual(view.writes[0], { action: 'ack-mail-notice', input: { analysisId: next.mailNoticeAttention[0].analysisId,
      attemptId: next.mailNoticeAttention[0].attemptId, expectedState: 'unknown' } })
  } finally { view.dispose() }
})

test('邮件发送结果未知时显示收件人和核查入口，不能冒充已送达', async () => {
  const view = mount()
  try {
    const next = snapshot() as MemberSnapshot & { mailSendAttention: Array<{ intentId: string; subject: string; recipients: string[];
      state: 'unknown'; accepted: string[]; rejected: string[]; messageId: string | null }> }
    next.mailSendAttention = [{ intentId: '00000000-0000-4000-8000-000000000003', subject: '隔离会议纪要',
      recipients: ['a@example.com'], state: 'unknown', accepted: [], rejected: [], messageId: null }]
    view.state = next
    assert.match(view.text, /待核查邮件发送/u)
    assert.match(view.text, /隔离会议纪要.*a@example\.com.*结果未知/su)
    assert.match(view.text, /不能自动重发/u)
    view.click('核对发送结果…')
    await view.flush()
    assert.deepEqual(view.writes[0], { action: 'ack-mail-send', input: { intentId: next.mailSendAttention[0].intentId, expectedState: 'unknown' } })
  } finally { view.dispose() }
})
test('邮件发送状态读取异常时团队页保留成员列表并提示', () => {
  const view = mount()
  try {
    const next = snapshot() as MemberSnapshot & { mailSendAttentionError: boolean }
    next.mailSendAttentionError = true
    view.state = next
    assert.match(view.text, /邮件发送状态暂时无法读取/u)
    assert.match(view.text, /研究员甲/u)
  } finally { view.dispose() }
})

test('企业微信消息结果未知时显示定位信息和本人核查入口，不泄露正文', async () => {
  const view = mount()
  try {
    const next = snapshot() as MemberSnapshot & { channelInboundAttention: Array<{
      id: string; channel: string; accountTag: string; msgid: string; chatId: string; chatType: 'single'; senderId: string;
      state: 'unknown'; processing: 'unknown'; reply: 'unknown'; conflict: boolean; busy: boolean; revision: number; receivedAt: number
    }> }
    next.channelInboundAttention = [{ id: '00000000-0000-4000-8000-000000000004', channel: 'wecom', accountTag: '0123456789ab',
      msgid: '隔离消息', chatId: '测试会话', chatType: 'single', senderId: '主人', state: 'unknown', processing: 'unknown',
      reply: 'unknown', conflict: false, busy: false, revision: 3, receivedAt: 1_800_000_000_000 }]
    view.state = next
    assert.match(view.text, /待核查.*企业微信/u)
    assert.match(view.text, /主人.*测试会话/su)
    assert.match(view.text, /不会自动重发/u)
    assert.match(view.text, /不保存消息正文/u)
    view.click('核查渠道消息…')
    await view.flush()
    assert.deepEqual(view.writes[0], { action: 'ack-channel-inbound',
      input: { id: next.channelInboundAttention[0].id, expectedRevision: 3 } })
  } finally { view.dispose() }
})

test('删除成员按当前配置版本提交，忙碌时按钮禁用', async () => {
  const view = mount()
  try {
    view.click('删除成员…')
    await view.flush()
    assert.deepEqual(view.writes[0], { action: 'delete', input: { id: '成员甲', expectedRevision: 3 } })
    assert.match(view.text, /操作已完成/)
    const next = snapshot(); next.members[0]!.busy = true; view.state = next
    assert.equal(view.button('删除成员…').props.disabled, true)
  } finally { view.dispose() }
})
test('申请不会自动批准，必须明确加额或重置；列表刷新保留申请草稿', async () => {
  const view = mount()
  try {
    view.submit('额度申请')
    assert.equal(view.writes.length, 0)
    assert.match(view.text, /批准前请明确/)
    view.change('新日上限', '2000')
    const next = snapshot(); next.members[0]!.quota.revision = 10; view.state = next
    assert.equal(view.field('新日上限').props.value, '2000')
    view.submit('额度申请')
    await view.flush()
    assert.deepEqual(view.writes[0], { action: 'decide-request', input: { requestId: '申请甲', expectedQuotaRevision: 10, decision: 'approve', change: { dailyTokenLimit: 2000 } } })
    view.click('拒绝申请')
    await view.flush()
    assert.deepEqual(view.writes[1]!.input, { requestId: '申请甲', expectedQuotaRevision: 10, decision: 'reject' })
  } finally { view.dispose() }
})
test('独立记忆展示来源与版本，先预览影响才能删除，命令不携带范围或身份', async () => {
  const view = mount()
  try {
    view.click('独立记忆'); await view.flush()
    assert.match(view.text, /口径.*候选.*版本 4.*独立范围 role.*来源甲/s)
    assert.match(view.text, /历史无法追回/)
    view.click('预览删除影响'); await view.flush()
    assert.equal(view.writes[0]!.action, 'memory-delete-preview')
    assert.equal(view.writes.length, 1)
    assert.match(view.text, /将删除.*独立会话甲/s)
    view.click('已查看影响，原生确认删除…'); await view.flush()
    assert.deepEqual(view.writes[1], { action: 'memory-delete', input: { id: '成员甲', memoryId: '记忆甲', expectedRevision: 4, previewId: '预览甲' } })
    view.click('修改记忆'); view.change('正文', '修订正文'); view.submit('修改记忆'); await view.flush()
    assert.deepEqual(view.writes[2], { action: 'memory-update', input: { id: '成员甲', memoryId: '记忆甲', expectedRevision: 4, text: '修订正文', topic: '口径' } })
    view.click('本人新增记忆…'); view.change('主题', '新主题'); view.change('正文', '新正文'); view.submit('本人确认新增记忆'); await view.flush()
    assert.deepEqual(view.writes[3]!.input, { id: '成员甲', kind: 'user_preference', topic: '新主题', text: '新正文' })
  } finally { view.dispose() }
})
test('全局10秒轻量读取按观察到的申请标识去重，失败不清空已知状态', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const view = mount(true)
  try {
    await view.flush()
    assert.equal(view.reads, 1); assert.equal(view.toasts.length, 1)
    t.mock.timers.tick(10000); await view.flush()
    assert.equal(view.reads, 2); assert.equal(view.toasts.length, 1)
    const next = snapshot(); next.requests.push({ ...next.requests[0]!, requestId: '申请乙' })
    view.readResult = { ok: true, state: next }
    t.mock.timers.tick(10000); await view.flush()
    assert.equal(view.toasts.length, 2)
    view.readResult = { ok: false, error: { code: 'unavailable', message: '服务不可用' } }
    t.mock.timers.tick(10000); await view.flush()
    assert.equal(view.feed.state?.requests.length, 2)
    assert.equal(view.feed.error, '服务不可用')
  } finally { view.dispose(); t.mock.timers.reset() }
})

test('额度申请和渠道异常同时出现时合并提醒，避免互相覆盖', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const view = mount(true)
  try {
    await view.flush()
    const next = snapshot() as MemberSnapshot & { channelInboundAttention: Array<{
      id: string; channel: string; accountTag: string; msgid: string; chatId: string; chatType: 'single'; senderId: string;
      state: 'unknown'; processing: 'unknown'; reply: 'unknown'; conflict: boolean; busy: boolean; revision: number; receivedAt: number
    }> }
    next.requests.push({ ...next.requests[0]!, requestId: '申请乙' })
    next.channelInboundAttention = [{ id: '00000000-0000-4000-8000-000000000004', channel: 'wecom', accountTag: '0123456789ab',
      msgid: '隔离消息', chatId: '测试会话', chatType: 'single', senderId: '主人', state: 'unknown', processing: 'unknown',
      reply: 'unknown', conflict: false, busy: false, revision: 3, receivedAt: 1_800_000_000_000 }]
    view.readResult = { ok: true, state: next }
    t.mock.timers.tick(10000); await view.flush()
    assert.equal(view.toasts.length, 2, '两类新事项应组成同一条提醒')
    assert.match(view.toasts[1], /额度.*渠道/su)
    t.mock.timers.tick(10000); await view.flush()
    assert.equal(view.toasts.length, 2, '同一事项不会反复提示')
  } finally { view.dispose(); t.mock.timers.reset() }
})
test('接线保留任务审批底座，移除独立标签，主动提示有可点击命中盒', () => {
  const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('../src/renderer/PetSettingsPanel.tsx', import.meta.url), 'utf8')
  const settings = readFileSync(new URL('../src/renderer/AssistantSettings.tsx', import.meta.url), 'utf8')
  assert.ok(app.indexOf('<MemberManagement') < app.indexOf('<TeamPanel'))
  assert.match(app, /onOpenApproval=\{openApproval\}/)
  assert.match(app, /registerCharacterHitbox\('__member_quota__'/)
  assert.match(app, /打开团队/)
  assert.doesNotMatch(panel, /\['agent',/)
  assert.doesNotMatch(settings, /setAgent|tokenBudget|企业微信独立智能体/)
})
