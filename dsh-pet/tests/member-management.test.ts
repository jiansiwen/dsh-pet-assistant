import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { MemberDraft, MemberResult, MemberSnapshot, MemoryRecord } from '../src/member-types.ts'

const handlers = new Map<string, (...args: unknown[]) => Promise<MemberResult>>()
const dialogs: Array<{ message: string; detail: string; defaultId: number; cancelId: number; checkboxLabel?: string; checkboxChecked?: boolean }> = []
let confirm: () => Promise<{ response: number; checkboxChecked?: boolean }> = async () => ({ response: 1 })
let exposed: Record<string, (...args: unknown[]) => unknown> = {}
const invokes: unknown[][] = []
mock.module('electron', { namedExports: {
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<MemberResult>) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) },
  dialog: { showMessageBox: async (_window: unknown, options: typeof dialogs[number]) => { dialogs.push(options); return confirm() } },
  contextBridge: { exposeInMainWorld: (_name: string, api: typeof exposed) => { exposed = api } },
  ipcRenderer: { invoke: async (...args: unknown[]) => { invokes.push(args); return { ok: true } } },
} })
const { registerMemberManagement, MEMBER_CHANNELS, memberPathIdentifier } = await import('../src/main/member-management.ts')
await import('../src/preload/index.ts')
const pagePath = 'D:/java/openCode2026/dsh-github/dsh-pet/dist/renderer/index.html'
const pageURL = pathToFileURL(pagePath).href
const id = "成员 空格!'()"
const memoryId = '记忆 一'
const requestId = '申请 一'
const ROOT = '/companion/v1/members'
const base = `${ROOT}/${memberPathIdentifier(id)}`
const draft: MemberDraft = { displayName: '研究员甲', personality: '', permissionMode: 'ask', description: '通用研究成员', persona: '只根据证据回答', skinId: 'wukong', enabled: true,
  provider: '', model: '', maxTokens: 2048, capabilities: [], allowedTools: [], dailyTokenLimit: 1000, totalTokenLimit: 5000, thresholdPercent: 80, timezone: 'Asia/Shanghai' }
function snapshot(): MemberSnapshot {
  return { enabled: false, defaultModel: { provider: '宿主', model: '默认模型' }, members: [{ profile: { ...draft, assistantId: id, roleId: 'wukong',
    voiceProfile: '', toolPolicy: { mode: 'read-only', denyTools: [] }, revision: 3, sessionId: '独立会话甲' },
    quota: { day: '2026-10-28', dailyUsed: 900, totalUsed: 4000, dailyReserved: 0, totalReserved: 0, dailyTokenLimit: 1000, totalTokenLimit: 5000, thresholdPercent: 80, unknown: false, blocked: false, revision: 9 }, busy: false }],
    requests: [{ requestId, assistantId: id, reason: '日用量达到阈值', state: 'pending', createdAt: 1, quotaRevision: 9 }] }
}
function memory(): MemoryRecord {
  return { id: memoryId, kind: 'user_preference', scope: { kind: 'role', id }, topic: '口径', text: '使用证据', sourceRefs: ['证据一'], status: 'candidate', sensitivity: 'normal',
    createdBy: id, confirmedBy: null, revision: 4, createdAt: 1, updatedAt: 1, expiresAt: null, importBatch: null }
}
function stage() {
  let url = pageURL
  const mainFrame = { url }
  return { destroyed: false, isDestroyed() { return this.destroyed }, webContents: { mainFrame, getURL: () => url },
    navigate(next: string) { url = next; mainFrame.url = next }, contentsURL(next: string) { url = next } }
}
let win: ReturnType<typeof stage> | null
let state: MemberSnapshot
let records: MemoryRecord[]
let requests: Array<{ method: string; path: string; body: unknown; subject: string }>
let respond: (method: string, path: string, body: unknown) => Promise<{ status: number; body: unknown }>
function mount() { return registerMemberManagement({ getStageWindow: () => win as never, pagePath,
  request: async (method, path, body, subject) => { requests.push({ method, path, body, subject }); return respond(method, path, body) } }) }
function event() { return { sender: win!.webContents, senderFrame: win!.webContents.mainFrame } }
function read(sender: unknown = event()) { return handlers.get(MEMBER_CHANNELS.state)!(sender) }
function memories(value: unknown = id, sender: unknown = event()) { return handlers.get(MEMBER_CHANNELS.memories)!(sender, value) }
function command(action: unknown, input: unknown, sender: unknown = event()) { return handlers.get(MEMBER_CHANNELS.command)!(sender, action, input) }
function assist(input: unknown, sender: unknown = event()) { return handlers.get(MEMBER_CHANNELS.assist)!(sender, input) }
function code(result: MemberResult) { return result.ok ? undefined : result.error.code }
const writes = () => requests.filter(item => item.method === 'POST')
const casMemory = () => ({ id, memoryId, expectedRevision: 4 })
beforeEach(() => {
  handlers.clear(); dialogs.length = 0; invokes.length = 0
  win = stage(); state = snapshot(); records = [memory()]; requests = []
  confirm = async () => ({ response: 1 })
  respond = async (method, path) => ({ status: 200, body: method === 'GET' ? path === ROOT ? state : { records }
    : path.endsWith('/delete-preview') ? { previewId: '预览一', impact: { memories: [memoryId], sessions: ['独立会话甲'] } } : { saved: true } })
})

test('预加载仅暴露固定成员方法，不开放任意地址和凭据', async () => {
  await exposed.membersState!('https://invalid.example', '伪造凭据')
  await exposed.memberMemories!(id)
  await exposed.memberCommand!('mode', { enabled: false })
  assert.deepEqual(invokes, [['members-state'], ['member-memories', id], ['member-command', 'mode', { enabled: false }]])
  assert.equal(exposed.companionRequest, undefined)
})
test('直接对象快照逐字段投影，密钥与扩展字段不混入', async () => {
  mount()
  const safe = snapshot()
  respond = async () => ({ status: 200, body: { ...safe, secret: '秘密', ownerToken: '秘密', members: [{ ...safe.members[0], password: '秘密',
    profile: { ...safe.members[0]!.profile, credential: '秘密', toolPolicy: { ...safe.members[0]!.profile.toolPolicy, apiKey: '秘密' } }, quota: { ...safe.members[0]!.quota, secret: '秘密' } }] } })
  assert.deepEqual(await read(), { ok: true, state: safe })
  assert.deepEqual(requests, [{ method: 'GET', path: ROOT, body: undefined, subject: 'owner' }])
})
test('邮件通知核查投影只包含状态与摘要，不暴露扩展字段', async () => {
  mount()
  const safe = snapshot()
  const issue = { analysisId: '00000000-0000-4000-8000-000000000001', memberId: id,
    attemptId: '00000000-0000-4000-8000-000000000002', state: 'unknown', preview: '隔离摘要' }
  respond = async () => ({ status: 200, body: { ...safe, mailNoticeAttention: [{ ...issue, secret: '不能外传' }] } })
  assert.deepEqual(await read(), { ok: true, state: { ...safe, mailNoticeAttention: [issue] } })
})
test('邮件通知核查数据损坏时不阻塞成员列表，并提示刷新核对', async () => {
  mount()
  const safe = snapshot()
  respond = async () => ({ status: 200, body: { ...safe, mailNoticeAttention: [{ analysisId: '损坏' }] } })
  assert.deepEqual(await read(), { ok: true, state: { ...safe, mailNoticeAttentionError: true } })
})
test('邮件发送核查数据损坏时不阻塞成员列表，并提示刷新核对', async () => {
  mount()
  const safe = snapshot()
  respond = async () => ({ status: 200, body: { ...safe, mailSendAttention: [{ intentId: '损坏' }] } })
  assert.deepEqual(await read(), { ok: true, state: { ...safe, mailSendAttentionError: true } })
})
test('本人核对邮件通知须原生确认并绑定当前尝试，不能伪造送达', async () => {
  mount()
  const issue = { analysisId: '00000000-0000-4000-8000-000000000001', memberId: id,
    attemptId: '00000000-0000-4000-8000-000000000002', state: 'unknown' as const, preview: '隔离摘要' }
  state.mailNoticeAttention = [issue]
  const input = { analysisId: issue.analysisId, attemptId: issue.attemptId, expectedState: issue.state }
  confirm = async () => ({ response: 0 })
  assert.equal(code(await command('ack-mail-notice', input)), 'cancelled')
  assert.equal(writes().length, 0)
  confirm = async () => {
    state.mailNoticeAttention = [{ ...issue, attemptId: '00000000-0000-4000-8000-000000000003' }]
    return { response: 1 }
  }
  assert.equal(code(await command('ack-mail-notice', input)), 'conflict')
  assert.equal(writes().length, 0, '确认期间尝试变化不能沿用旧决定')
  state.mailNoticeAttention = [issue]
  confirm = async () => ({ response: 1 })
  assert.equal((await command('ack-mail-notice', input)).ok, true)
  assert.equal(writes().at(-1)?.path, `${ROOT}/mail-notices/${issue.analysisId}/acknowledge`)
  assert.deepEqual(writes().at(-1)?.body, { attemptId: issue.attemptId, expectedState: 'unknown' })
  assert.match(dialogs.at(-1)?.detail ?? '', /不代表.*送达.*不.*重发/su)
})
test('本人核对邮件发送须原生确认，状态变化时旧确认无效', async () => {
  mount()
  const issue = { intentId: '00000000-0000-4000-8000-000000000003', subject: '隔离纪要', recipients: ['a@example.com'],
    state: 'unknown' as const, accepted: [], rejected: [], messageId: null }
  state.mailSendAttention = [issue]
  const input = { intentId: issue.intentId, expectedState: issue.state }
  confirm = async () => ({ response: 0 })
  assert.equal(code(await command('ack-mail-send', input)), 'cancelled')
  assert.equal(writes().length, 0)
  confirm = async () => { state.mailSendAttention = [{ ...issue, state: 'partial' }]; return { response: 1 } }
  assert.equal(code(await command('ack-mail-send', input)), 'conflict')
  assert.equal(writes().length, 0)
  state.mailSendAttention = [issue]
  confirm = async () => ({ response: 1 })
  assert.equal((await command('ack-mail-send', input)).ok, true)
  assert.equal(writes().at(-1)?.path, `${ROOT}/mail-sends/${issue.intentId}/acknowledge`)
  assert.deepEqual(writes().at(-1)?.body, { expectedState: 'unknown' })
  assert.match(dialogs.at(-1)?.detail ?? '', /不代表.*送达.*不会.*重发/su)
})

test('企业微信异常投影只包含定位信息，损坏时不阻塞成员列表', async () => {
  mount()
  const safe = snapshot()
  const issue = { id: '00000000-0000-4000-8000-000000000004', channel: 'wecom', accountTag: '0123456789ab', msgid: '消息甲',
    chatId: '测试会话', chatType: 'single', senderId: '主人', state: 'unknown', processing: 'unknown', reply: 'unknown',
    conflict: false, busy: false, revision: 3, receivedAt: 1_800_000_000_000 }
  respond = async () => ({ status: 200, body: { ...safe, channelInboundAttention: [{ ...issue, text: '不应外传', secret: '密钥' }] } })
  assert.deepEqual(await read(), { ok: true, state: { ...safe, channelInboundAttention: [issue] } })
  respond = async () => ({ status: 200, body: { ...safe, channelInboundAttention: [{ id: '损坏' }] } })
  assert.deepEqual(await read(), { ok: true, state: { ...safe, channelInboundAttentionError: true } })
})

test('渠道异常本人核查须原生确认并重验版本，不执行或重发', async () => {
  mount()
  const issue = { id: '00000000-0000-4000-8000-000000000004', channel: 'wecom', accountTag: '0123456789ab', msgid: '消息甲',
    chatId: '测试会话', chatType: 'single' as const, senderId: '主人', state: 'unknown' as const, processing: 'unknown' as const,
    reply: 'unknown' as const, conflict: false, busy: false, revision: 3, receivedAt: 1_800_000_000_000 }
  ;(state as MemberSnapshot & { channelInboundAttention: typeof issue[] }).channelInboundAttention = [issue]
  const input = { id: issue.id, expectedRevision: issue.revision }
  confirm = async () => ({ response: 0 })
  assert.equal(code(await command('ack-channel-inbound', input)), 'cancelled')
  assert.equal(writes().length, 0)
  confirm = async () => { (state as MemberSnapshot & { channelInboundAttention: typeof issue[] }).channelInboundAttention = [{ ...issue, revision: 4 }]; return { response: 1 } }
  assert.equal(code(await command('ack-channel-inbound', input)), 'conflict')
  assert.equal(writes().length, 0)
  ;(state as MemberSnapshot & { channelInboundAttention: typeof issue[] }).channelInboundAttention = [issue]
  confirm = async () => ({ response: 1 })
  assert.equal((await command('ack-channel-inbound', input)).ok, true)
  assert.equal(writes().at(-1)?.path, `${ROOT}/channel-inbound/${issue.id}/acknowledge`)
  assert.deepEqual(writes().at(-1)?.body, { expectedRevision: 3 })
  assert.match(dialogs.at(-1)?.detail ?? '', /不会.*执行.*重发|不.*执行.*重发/su)
})
test('记忆逐字段镜像，范围只读，标识严格编码', async () => {
  mount()
  respond = async () => ({ status: 200, body: { records: [{ ...memory(), secret: '秘密', scope: { ...memory().scope, actor: '秘密' } }], ownerToken: '秘密' } })
  assert.deepEqual(await memories(), { ok: true, data: { records: [memory()] } })
  assert.equal(requests[0]?.path, `${base}/memories`)
  assert.match(base, /%20.*%21%27%28%29$/)
  for (const value of ['..', '.', '', 'x/y', 'x\\y', '%2e%2e', 'x?y', 'x#y', 'https://invalid.example', 'x\ny', null, {}]) {
    assert.equal(code(await memories(value)), 'invalid_input')
  }
  assert.equal(requests.length, 1)
})
test('拒绝其他窗口、子框架、远程或修改后的 file URL、已销毁舞台', async () => {
  mount()
  const original = event(), other = stage()
  const denied = [ { sender: other.webContents, senderFrame: other.webContents.mainFrame }, { ...original, senderFrame: { url: pageURL } }, { ...original, senderFrame: null } ]
  for (const sender of denied) {
    assert.equal(code(await read(sender)), 'denied')
    assert.equal(code(await memories(id, sender)), 'denied')
    assert.equal(code(await command('mode', { enabled: true }, sender)), 'denied')
  }
  for (const url of ['https://invalid.example', 'about:blank', `${pageURL}?x=1`, `${pageURL}#x`, pageURL.replace('/index.html', '/other.html'), pageURL.replace('file:///', 'file://remote/')]) {
    win!.navigate(url)
    assert.equal(code(await read()), 'denied')
    assert.equal(code(await command('create', draft)), 'denied')
  }
  win!.navigate(pageURL); win!.contentsURL('https://invalid.example')
  assert.equal(code(await read()), 'denied')
  win!.navigate(pageURL); win!.destroyed = true
  assert.equal(code(await read()), 'denied')
  win = null
  assert.equal(code(await read(original)), 'denied')
  assert.equal(requests.length, 0); assert.equal(dialogs.length, 0)
})
test('成员编辑窗口是额外登记的固定来源，地址变化后立即拒绝', async () => {
  const editorURL = pathToFileURL(pagePath.replace('/index.html', '/member-editor.html')).href
  const editor = stage(); editor.navigate(editorURL)
  const dispose = registerMemberManagement({ getStageWindow: () => win as never, pagePath,
    allowWindow: candidate => candidate.sender === editor.webContents && candidate.senderFrame === editor.webContents.mainFrame
      && editor.webContents.mainFrame.url === editorURL,
    request: async (method, path, body, subject) => { requests.push({ method, path, body, subject }); return respond(method, path, body) } })
  try {
    const editorEvent = { sender: editor.webContents, senderFrame: editor.webContents.mainFrame }
    assert.equal((await read(editorEvent)).ok, true)
    assert.equal((await command('create', draft, editorEvent)).ok, true)
    assert.equal(dialogs.length, 1)
    editor.navigate('https://invalid.example')
    assert.equal(code(await read(editorEvent)), 'denied')
  } finally { dispose() }
})
test('AI 草稿只返回候选项，失败给出可读错误且不写配置', async () => {
  mount()
  const previous = respond
  respond = async (method, path, body) => path.endsWith('/assist')
    ? { status: 200, body: { draft, notes: '已填好', secret: '秘密' } }
    : previous(method, path, body)
  const result = await assist({ request: '每天整理日报', current: draft })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal((result.data as { notes: string }).notes, '已填好')
  assert.deepEqual((result.data as { draft: MemberDraft }).draft, draft)
  assert.ok(!JSON.stringify(result).includes('秘密'))
  assert.deepEqual(requests.at(-1), { method: 'POST', path: `${ROOT}/assist`, body: { request: '每天整理日报', current: draft }, subject: 'owner' })
  assert.equal(dialogs.length, 0)
  assert.equal(code(await assist({ request: '日报', secret: '秘密' })), 'invalid_input')
  respond = async (method, path, body) => path.endsWith('/assist')
    ? { status: 503, body: { code: 'ASSIST_UNAVAILABLE', message: '内部地址与凭据' } }
    : previous(method, path, body)
  const failed = await assist({ request: '日报' })
  assert.equal(code(failed), 'assist_failed')
  assert.ok(!JSON.stringify(failed).includes('内部地址'))
})
test('轮询等待期间来源变化，不泄漏状态', async () => {
  mount()
  let resolve!: (value: { status: number; body: unknown }) => void
  respond = () => new Promise(done => { resolve = done })
  const pending = read()
  win = stage()
  resolve({ status: 200, body: state })
  assert.equal(code(await pending), 'denied')
})
test('十一种动作固定路径与 CAS 正文，不发送 scope 或 actor 身份', async () => {
  mount()
  const cases: Array<[string, unknown, string, unknown]> = [
    ['create', draft, ROOT, draft],
    ['update', { id, expectedRevision: 3, ...draft }, `${base}/update`, { expectedRevision: 3, ...draft }],
    ['mode', { enabled: false }, `${ROOT}/mode`, { enabled: false }],
    ['delete', { id, expectedRevision: 3 }, `${base}/delete`, { expectedRevision: 3 }],
    ['reset-quota', { id, expectedQuotaRevision: 9, scope: 'both' }, `${base}/reset-quota`, { expectedQuotaRevision: 9, scope: 'both' }],
    ['decide-request', { requestId, decision: 'approve', expectedQuotaRevision: 9, change: { dailyTokenLimit: 2000, reset: 'total' } }, `${ROOT}/requests/${memberPathIdentifier(requestId)}/decide`, { decision: 'approve', expectedQuotaRevision: 9, change: { dailyTokenLimit: 2000, reset: 'total' } }],
    ['memory-create', { id, kind: 'user_preference', topic: '主题', text: '正文' }, `${base}/memories`, { kind: 'user_preference', topic: '主题', text: '正文' }],
    ['memory-update', { ...casMemory(), topic: '新主题', text: '新正文' }, `${base}/memories/${memberPathIdentifier(memoryId)}/update`, { expectedRevision: 4, topic: '新主题', text: '新正文' }],
    ['memory-confirm', casMemory(), `${base}/memories/${memberPathIdentifier(memoryId)}/confirm`, { expectedRevision: 4 }],
    ['memory-delete-preview', casMemory(), `${base}/memories/${memberPathIdentifier(memoryId)}/delete-preview`, { expectedRevision: 4 }],
    ['memory-delete', { ...casMemory(), previewId: '预览一' }, `${base}/memories/${memberPathIdentifier(memoryId)}/delete`, { expectedRevision: 4, previewId: '预览一' }],
  ]
  for (const [action, input, path, body] of cases) {
    const result = await command(action, input)
    assert.equal(result.ok, true, JSON.stringify({ action, result }))
    assert.deepEqual(writes().at(-1), { method: 'POST', path, body, subject: 'owner' })
  }
  assert.equal(dialogs.length, 10)
  assert.match(dialogs.at(-1)!.detail, /研究员甲.*成员 空格/s)
  assert.match(dialogs.at(-1)!.detail, /删除影响.*独立会话甲.*历史无法追回.*新会话隔离/s)
  assert.ok(dialogs.some(item => item.detail.includes('历史会话和任务记录保留作为审计')))
})
test('用户取消所有写入确认时绝不发送修改', async () => {
  mount(); confirm = async () => ({ response: 0 })
  for (const [action, input] of [ ['create', draft], ['update', { id, expectedRevision: 3, ...draft }], ['mode', { enabled: true }],
    ['delete', { id, expectedRevision: 3 }],
    ['reset-quota', { id, expectedQuotaRevision: 9, scope: 'daily' }], ['decide-request', { requestId, decision: 'approve', expectedQuotaRevision: 9, change: { reset: 'both' } }],
    ['memory-create', { id, kind: 'project_fact', topic: '甲', text: '乙' }], ['memory-update', { ...casMemory(), topic: '甲', text: '乙' }], ['memory-confirm', casMemory()] ]) {
    assert.equal(code(await command(action, input)), 'cancelled')
  }
  assert.equal(writes().length, 0)
  assert.ok(dialogs.every(item => item.defaultId === 0 && item.cancelId === 0))
  await command('memory-delete-preview', casMemory())
  assert.equal(code(await command('memory-delete', { ...casMemory(), previewId: '预览一' })), 'cancelled')
  assert.equal(writes().filter(item => item.path.endsWith('/delete')).length, 0)
})
test('确认时输入已复制并冻结，重复写入被挡，确认内容与最终正文一致', async () => {
  mount()
  let resolve!: (value: { response: number }) => void
  confirm = () => new Promise(done => { resolve = done })
  const input = { id, expectedRevision: 3, ...draft, capabilities: ['mail'], allowedTools: [], model: '模型甲', provider: '服务甲' }
  const pending = command('update', input)
  await new Promise<void>(done => setImmediate(done))
  assert.equal(code(await command('mode', { enabled: true })), 'busy')
  assert.match(dialogs[0]!.detail, /研究员甲.*模型甲.*mail/s)
  assert.match(dialogs[0]!.detail, /"permissionMode": "ask"/)
  input.model = '未经确认的模型'; input.permissionMode = 'full'; input.capabilities.push('activity')
  resolve({ response: 1 }); assert.equal((await pending).ok, true)
  const body = writes()[0]!.body as MemberDraft
  assert.equal(body.model, '模型甲'); assert.deepEqual(body.allowedTools, []); assert.deepEqual(body.capabilities, ['mail'])
  assert.equal(Object.isFrozen(body), true); assert.equal(Object.isFrozen(body.capabilities), true)
})
test('原生确认期间导航、换窗口、销毁或注销后不发送修改', async () => {
  for (const change of [() => win!.navigate('https://invalid.example'), () => { win = stage() }, () => { win!.destroyed = true }]) {
    win = stage(); requests = []
    const dispose = mount()
    confirm = async () => { change(); return { response: 1 } }
    assert.equal(code(await command('create', draft)), 'denied')
    assert.equal(writes().length, 0); dispose()
  }
  win = stage()
  const dispose = mount()
  confirm = async () => { dispose(); return { response: 1 } }
  assert.equal(code(await command('create', draft)), 'denied')
  assert.equal(handlers.size, 0)
})
test('忙碌与旧配置/额度/记忆版本不打开确认框，确认期间变更也拒绝', async () => {
  mount()
  for (const [action, input] of [ ['update', { id, expectedRevision: 2, ...draft }], ['reset-quota', { id, expectedQuotaRevision: 8, scope: 'daily' }], ['memory-confirm', { ...casMemory(), expectedRevision: 3 }] ]) {
    assert.equal(code(await command(action, input)), 'conflict')
  }
  state.members[0]!.busy = true
  assert.equal(code(await command('update', { id, expectedRevision: 3, ...draft })), 'busy')
  assert.equal(code(await command('delete', { id, expectedRevision: 3 })), 'busy')
  assert.equal(code(await command('reset-quota', { id, expectedQuotaRevision: 9, scope: 'total' })), 'busy')
  assert.equal(dialogs.length, 0)
  state.members[0]!.busy = false
  confirm = async () => { state.members[0]!.profile.revision++; return { response: 1 } }
  assert.equal(code(await command('update', { id, expectedRevision: 3, ...draft })), 'conflict')
  assert.equal(writes().length, 0)
})
test('非法字段、权限扩张、伪造身份与空批准在网络前拒绝', async () => {
  mount()
  const cases: Array<[unknown, unknown]> = [ ['https://invalid.example', {}], ['../mode', {}], ['__proto__', {}], ['mode', { enabled: true, url: '外部' }],
    ['create', { ...draft, secret: '秘密' }], ['create', { ...draft, actor: 'owner' }], ['create', { ...draft, allowedTools: ['bash'] }], ['create', { ...draft, allowedTools: ['read\nbash'] }],
    ['create', { ...draft, allowedTools: ['report'] }], ['create', { ...draft, capabilities: ['shell'] }], ['create', { ...draft, model: '模型', provider: '' }],
    ['create', { ...draft, maxTokens: 0 }], ['create', { ...draft, thresholdPercent: 101 }], ['create', { ...draft, timezone: '伪造时区' }], ['create', { ...draft, dailyTokenLimit: Infinity }],
    ['update', { ...draft, id, expectedRevision: '3' }], ['delete', { id, expectedRevision: '3' }], ['delete', { id, expectedRevision: 0 }], ['reset-quota', { id, expectedQuotaRevision: 9, scope: 'global' }],
    ['decide-request', { requestId, expectedQuotaRevision: 9, decision: 'approve' }], ['decide-request', { requestId, expectedQuotaRevision: 9, decision: 'approve', change: {} }],
    ['decide-request', { requestId, expectedQuotaRevision: 9, decision: 'reject', change: { reset: 'both' } }],
    ['memory-create', { id, kind: 'user_preference', topic: '', text: '正文', scope: { kind: 'global', id: '' } }],
    ['memory-confirm', { ...casMemory(), actor: 'owner' }], ['memory-delete', { ...casMemory(), previewId: '../其他' }],
  ]
  for (const [action, input] of cases) assert.equal(code(await command(action, input)), 'invalid_input', JSON.stringify({ action, input }))
  assert.equal(requests.length, 0); assert.equal(dialogs.length, 0)
})
test('删除时勾选清除独立记忆，只给宿主发送 purgeMemory', async () => {
  mount()
  confirm = async () => ({ response: 1, checkboxChecked: true })
  const result = await command('delete', { id, expectedRevision: 3 })
  assert.equal(result.ok, true)
  assert.deepEqual(writes().at(-1), { method: 'POST', path: `${base}/delete`, body: { expectedRevision: 3, purgeMemory: true }, subject: 'owner' })
  assert.match(dialogs.at(-1)!.checkboxLabel ?? '', /独立记忆/)
  assert.match(dialogs.at(-1)!.detail, /勾选下方选项则一并清除/)
})
test('删除被业务规则挡住时保留宿主原因，不回显附带秘密', async () => {
  mount()
  respond = async (method, path) => method === 'POST' && path.endsWith('/delete')
    ? { status: 409, body: { code: 'MEMBER_CONFLICT', message: '还有 1 个未结束的团队任务，请先处理完再删除', secret: '秘密' } }
    : { status: 200, body: state }
  const result = await command('delete', { id, expectedRevision: 3 })
  assert.equal(code(result), 'conflict')
  if (!result.ok) assert.match(result.error.message, /未结束的团队任务/)
  assert.ok(!JSON.stringify(result).includes('秘密'))
})
test('零额度与纯提示词创建被允许，批准必须加额或重置，拒绝不隐含变更', async () => {
  mount()
  assert.equal((await command('create', { ...draft, dailyTokenLimit: 0, totalTokenLimit: 0 })).ok, true)
  assert.equal(code(await command('decide-request', { requestId, expectedQuotaRevision: 9, decision: 'approve', change: { dailyTokenLimit: 1000 } })), 'invalid_input')
  assert.equal((await command('decide-request', { requestId, expectedQuotaRevision: 9, decision: 'approve', change: { dailyTokenLimit: 0 } })).ok, true)
  assert.equal((await command('decide-request', { requestId, expectedQuotaRevision: 9, decision: 'reject' })).ok, true)
  assert.deepEqual(writes().at(-1)?.body, { expectedQuotaRevision: 9, decision: 'reject' })
})
test('删除必须有本窗口本成员本记忆版本的预览，影响去秘密，票据一次使用', async () => {
  mount()
  assert.equal(code(await command('memory-delete', { ...casMemory(), previewId: '伪造' })), 'preview_required')
  const previous = respond
  respond = async (method, path, body) => path.endsWith('/delete-preview') ? { status: 200, body: { previewId: '预览一', impact: { count: 2, nested: { ownerToken: '秘密', password: '秘密', title: '关联内容' } }, secret: '秘密' } } : previous(method, path, body)
  const preview = await command('memory-delete-preview', casMemory())
  assert.equal(preview.ok, true); assert.ok(!JSON.stringify(preview).includes('秘密'))
  assert.equal((await command('memory-delete', { ...casMemory(), previewId: '预览一' })).ok, true)
  assert.ok(!dialogs.at(-1)!.detail.includes('秘密'))
  assert.equal(code(await command('memory-delete', { ...casMemory(), previewId: '预览一' })), 'preview_required')
  await command('memory-delete-preview', casMemory())
  win = stage()
  assert.equal(code(await command('memory-delete', { ...casMemory(), previewId: '预览一' })), 'preview_required')
})
test('后端 CAS envelope 与错误不回显秘密，网络故障不自动重发', async () => {
  mount()
  const previous = respond
  for (const status of [400, 401, 403, 409, 422, 500]) {
    respond = async (method, path, body) => method === 'POST' ? { status, body: { code: '原始错误', message: '秘密', secret: '秘密' } } : previous(method, path, body)
    const result = await command('update', { ...draft, id, expectedRevision: 3 })
    assert.equal(result.ok, false)
    if (status === 409) assert.equal(code(result), 'conflict')
    assert.ok(!JSON.stringify(result).includes('秘密'))
  }
  let postCount = 0
  respond = async (method, path, body) => { if (method === 'POST') { postCount++; throw new Error('秘密') } return previous(method, path, body) }
  assert.equal(code(await command('mode', { enabled: false })), 'unavailable')
  assert.equal(postCount, 1)
  respond = async () => ({ status: 200, body: { ok: true, state } })
  assert.equal((await read()).ok, false, '不误读旧的后端 envelope')
})
