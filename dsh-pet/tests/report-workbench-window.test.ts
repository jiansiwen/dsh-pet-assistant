/**
 * 日报工作台窗口（M3-04/M3-05）：IPC 来源校验、"只能请求打开审批窗口、不能批准"、修订号原样传递、
 * 删除只经可信审批、导入文件由主进程选择与读取、客户端只用聊天令牌。假 electron，真实文件与真实 bridge.json。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mock, test, type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import { checkSender } from '../src/main/approval-policy.ts'

// ── 假 electron：主进程窗口/IPC 与 preload 的 contextBridge/ipcRenderer ─────────────────

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const windows: FakeWindow[] = []
const exposed = new Map<string, Record<string, (...args: unknown[]) => unknown>>()
const invoked: Array<{ channel: string; args: unknown[] }> = []
let nextId = 300

class FakeWindow {
  readonly options: Record<string, unknown>
  readonly sent: string[] = []
  readonly events = new Map<string, Array<() => void>>()
  readonly webContentsEvents = new Map<string, (event: { preventDefault(): void }) => void>()
  requestFilter: ((details: { url: string }, callback: (result: { cancel: boolean }) => void) => void) | null = null
  openHandler: (() => { action: string }) | null = null
  destroyed = false
  visible = false
  readonly webContents: Record<string, unknown>
  constructor(options: Record<string, unknown>) {
    this.options = options
    const self = this
    const mainFrame = { url: '' }
    this.webContents = {
      id: nextId++,
      mainFrame,
      send: (channel: string) => self.sent.push(channel),
      setWindowOpenHandler: (handler: () => { action: string }) => { self.openHandler = handler },
      on: (event: string, listener: (event: { preventDefault(): void }) => void) => self.webContentsEvents.set(event, listener),
      session: {
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        webRequest: { onBeforeRequest: (listener: FakeWindow['requestFilter']) => { self.requestFilter = listener } },
      },
    }
    windows.push(this)
  }
  setMenuBarVisibility() {}
  on(event: string, callback: () => void) { this.events.set(event, [...(this.events.get(event) ?? []), callback]) }
  once(event: string, callback: () => void) { this.on(event, callback) }
  async loadFile(file: string) { (this.webContents.mainFrame as { url: string }).url = pathToFileURL(file).href }
  isDestroyed() { return this.destroyed }
  isMinimized() { return false }
  restore() {}
  show() { this.visible = true }
  focus() {}
  close() {
    if (this.destroyed) return
    this.destroyed = true
    for (const callback of this.events.get('closed') ?? []) callback()
  }
  /** 渲染层从这个窗口发出的一次调用；frame 可换成子框架或别的页面。 */
  event(frame?: { url: string }) {
    const mainFrame = this.webContents.mainFrame as { url: string }
    return { sender: { id: this.webContents.id as number, mainFrame }, senderFrame: frame ?? mainFrame }
  }
}

mock.module('electron', {
  namedExports: {
    BrowserWindow: FakeWindow,
    dialog: { showOpenDialog: async () => assert.fail('测试不得弹真实文件框') },
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        assert.ok(!handlers.has(channel), `重复注册 ${channel}`)
        handlers.set(channel, handler)
      },
      removeHandler: (channel: string) => handlers.delete(channel),
    },
    contextBridge: { exposeInMainWorld: (name: string, api: Record<string, (...args: unknown[]) => unknown>) => exposed.set(name, api) },
    ipcRenderer: {
      invoke: async (channel: string, ...args: unknown[]) => { invoked.push({ channel, args }); return { ok: true } },
      on() {},
      removeAllListeners() {},
    },
  },
})

const workbench = await import('../src/main/report-workbench-window.ts')
const { registerReportWorkbench, REPORT_WORKBENCH_CHANNELS, REPORT_WORKBENCH_CHANGED, REPORT_WORKBENCH_PARTITION, readPickedFile, MAX_IMPORT_BYTES } = workbench
const { ReportWorkbenchClient } = await import('../src/main/report-workbench-client.ts')

const DIGEST = 'a'.repeat(64)

function fakeClient() {
  const calls: Array<{ method: string; body: unknown }> = []
  const replies: Record<string, unknown> = {}
  const respond = (method: string) => async (body: unknown) => {
    calls.push({ method, body })
    return (replies[method] as object | undefined) ?? { ok: true, status: 200, data: { ok: true } }
  }
  return {
    calls, replies,
    client: {
      report: respond('report'), edit: respond('edit'), publishRequest: respond('publishRequest'),
      deletionPreview: respond('deletionPreview'), deletionRequest: respond('deletionRequest'),
      importMaterial: respond('importMaterial'), shareRequest: respond('shareRequest'),
    } as never,
  }
}

function setup(t: TestContext, picked: Awaited<ReturnType<NonNullable<Parameters<typeof registerReportWorkbench>[0]['pickFile']>>> = null) {
  const fake = fakeClient()
  const approvals: string[] = []
  const pagePath = path.join(tmpdir(), 'dsh-wb-test', 'report-workbench.html')
  const handle = registerReportWorkbench({
    client: fake.client,
    openApproval: async proposalId => { approvals.push(proposalId); return { ok: true } },
    pickFile: async () => picked,
    pagePath, preloadPath: path.join(path.dirname(pagePath), 'report-workbench.cjs'),
  })
  t.after(() => handle.dispose())
  handle.open('2026-10-17')
  const win = windows.at(-1)!
  const invoke = (channel: string, event: unknown, ...args: unknown[]) => handlers.get(channel)!(event, ...args) as Promise<any>
  return { ...fake, approvals, handle, win, invoke, pagePath }
}

test('IPC 只认登记的工作台窗口：别的窗口、子框架、别的页面一律拒绝，且不发出任何桥接调用', async t => {
  const f = setup(t)
  await new Promise(resolve => setImmediate(resolve))
  const foreign = { sender: { id: 1, mainFrame: {} }, senderFrame: { url: pathToFileURL(f.pagePath).href } }
  const subframe = f.win.event({ url: pathToFileURL(f.pagePath).href })
  const elsewhere = f.win.event({ url: 'file:///D:/evil/report-workbench.html' })
  for (const event of [foreign, subframe, elsewhere]) {
    for (const channel of Object.values(REPORT_WORKBENCH_CHANNELS)) {
      const reply = await f.invoke(channel, event, { date: '2026-10-17', revision: 1, digest: DIGEST, targetPath: 'x' })
      assert.equal(reply.ok, false, `${channel} 不得受理外来调用`)
    }
  }
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.approvals, [])
  const loaded = await f.invoke(REPORT_WORKBENCH_CHANNELS.load, f.win.event())
  assert.equal(loaded.ok, true)
  assert.deepEqual(f.calls, [{ method: 'report', body: '2026-10-17' }], '缺省读取 open() 时指定的日期')
})

test('请求发布：修订号、摘要与路径原样交给插件；只请求打开专用审批窗口，从不批准；插件拒绝时不开窗', async t => {
  const f = setup(t)
  await new Promise(resolve => setImmediate(resolve))
  f.replies.publishRequest = { ok: true, status: 200, data: { ok: true, proposalId: '日报待批-1', revision: 3, digest: DIGEST, target: 'D:/报告/2026-10-17.md' } }
  const payload = { date: '2026-10-17', revision: 3, digest: DIGEST, targetPath: 'D:/报告/2026-10-17.md', content: '渲染层伪造的正文', approve: true }
  const reply = await f.invoke(REPORT_WORKBENCH_CHANNELS.requestPublish, f.win.event(), payload)
  assert.equal(reply.ok, true)
  assert.deepEqual(f.calls, [{ method: 'publishRequest', body: { date: '2026-10-17', revision: 3, digest: DIGEST, targetPath: 'D:/报告/2026-10-17.md' } }],
    '修订号与路径原样转交，正文、批准之类的额外字段一律丢掉')
  assert.deepEqual(f.approvals, ['日报待批-1'], '只打开现有专用审批窗口')
  assert.deepEqual(reply.approvalWindow, { ok: true })

  f.calls.length = 0
  for (const bad of [{ ...payload, digest: '短' }, { ...payload, revision: 2.5 }, { ...payload, targetPath: '' }, { date: '2026/10/17', revision: 3, digest: DIGEST, targetPath: 'x' }]) {
    assert.equal((await f.invoke(REPORT_WORKBENCH_CHANNELS.requestPublish, f.win.event(), bad)).ok, false)
  }
  assert.equal(f.calls.length, 0, '不完整的请求不转交')
  f.replies.publishRequest = { ok: false, status: 409, code: 'stale_revision', error: '你看到的是第 3 版，当前已经是第 4 版', data: null }
  const stale = await f.invoke(REPORT_WORKBENCH_CHANNELS.requestPublish, f.win.event(), payload)
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'stale_revision')
  assert.deepEqual(f.approvals, ['日报待批-1'], '插件拒绝时不开审批窗口')
})

test('没有任何批准通道：主进程注册的通道与 preload 暴露的接口都不含批准；preload 每个接口都落在已登记通道上', async t => {
  const f = setup(t)
  const registered = [...handlers.keys()].filter(channel => channel.startsWith('report-workbench:'))
  assert.deepEqual(registered.sort(), Object.values(REPORT_WORKBENCH_CHANNELS).sort())
  for (const channel of registered) assert.doesNotMatch(channel, /decide|approve|approval-card|grant/i)
  await import('../src/preload/report-workbench.ts')
  const api = exposed.get('reportWorkbench')!
  assert.deepEqual(Object.keys(api).sort(), ['deletionPreview', 'edit', 'importMaterial', 'load', 'onChanged', 'requestDeletion', 'requestPublish', 'requestShare'])
  for (const name of Object.keys(api)) assert.doesNotMatch(name, /decide|approve|grant/i)
  for (const [name, fn] of Object.entries(api)) if (name !== 'onChanged') await fn({})
  assert.deepEqual(invoked.map(item => item.channel).sort(), registered.sort(), 'preload 只调用主进程登记过的工作台通道')
  // 工作台窗口即使拿到审批窗口的通道名，也过不了审批窗口的发信者核验。
  const approvalPage = pathToFileURL(path.join(tmpdir(), 'approval.html')).href
  const event = f.win.event()
  assert.equal(checkSender({
    senderId: event.sender.id, registeredId: 9999, isMainFrame: true, url: approvalPage, expectedUrl: approvalPage,
    claimedProposalId: 'x', registeredProposalId: 'x',
  }).ok, false)
})

test('删除请求：需要可信审批的只打开审批窗口；草稿条目修订不开窗；参数只收简单值且必须带影响摘要', async t => {
  const f = setup(t)
  await new Promise(resolve => setImmediate(resolve))
  f.replies.deletionRequest = { ok: true, status: 200, data: { ok: true, kind: 'approval', proposalId: '删除待批-1' } }
  const request = { category: 'material', params: { materialId: 'mat-1', date: '2026-10-17' }, previewDigest: 'b'.repeat(64) }
  assert.equal((await f.invoke(REPORT_WORKBENCH_CHANNELS.requestDeletion, f.win.event(), request)).ok, true)
  assert.deepEqual(f.approvals, ['删除待批-1'])
  f.replies.deletionRequest = { ok: true, status: 200, data: { ok: true, kind: 'revision', revision: 5 } }
  assert.equal((await f.invoke(REPORT_WORKBENCH_CHANNELS.requestDeletion, f.win.event(), { ...request, category: 'draft_entry' })).ok, true)
  assert.deepEqual(f.approvals, ['删除待批-1'], '草稿条目删除是修订，不打开审批窗口')
  const before = f.calls.length
  assert.equal((await f.invoke(REPORT_WORKBENCH_CHANNELS.requestDeletion, f.win.event(), { ...request, previewDigest: undefined })).ok, false)
  assert.equal((await f.invoke(REPORT_WORKBENCH_CHANNELS.requestDeletion, f.win.event(), { ...request, params: { nested: { evil: true } } })).ok, false)
  assert.equal((await f.invoke(REPORT_WORKBENCH_CHANNELS.deletionPreview, f.win.event(), { category: 'memory', params: { list: [1] } })).ok, false)
  assert.equal(f.calls.length, before, '不合规的删除请求不转交')
  f.replies.shareRequest = { ok: true, status: 200, data: { ok: true, proposalId: '发送待批-1' } }
  assert.equal((await f.invoke(REPORT_WORKBENCH_CHANNELS.requestShare, f.win.event(), 'mat-1')).ok, true)
  assert.deepEqual(f.approvals, ['删除待批-1', '发送待批-1'])
})

test('导入文件由主进程选择与读取：渲染层给的路径与正文无效；二进制、超限拒绝；UTF-16 与 BOM 正确解码', async t => {
  const f = setup(t, { name: '项目群.txt', content: '张三：明天上线', bytes: 21 })
  await new Promise(resolve => setImmediate(resolve))
  const reply = await f.invoke(REPORT_WORKBENCH_CHANNELS.importMaterial, f.win.event(), {
    kind: 'chat_excerpt', objectLabel: '项目群', coveredFrom: 1, path: 'C:/Windows/win.ini', content: '渲染层伪造的正文', fileName: '伪造.txt',
  })
  assert.equal(reply.ok, true)
  assert.deepEqual(f.calls.at(-1), { method: 'importMaterial', body: { kind: 'chat_excerpt', objectLabel: '项目群', coveredFrom: 1, content: '张三：明天上线', fileName: '项目群.txt' } })
  assert.equal((await f.invoke(REPORT_WORKBENCH_CHANNELS.importMaterial, f.win.event(), { kind: 'file_excerpt' })).ok, false, '项目文件不能从这里导入')

  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-wb-file-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const write = (name: string, data: Buffer | string) => { const file = path.join(dir, name); writeFileSync(file, data); return file }
  const binary = await readPickedFile(write('bin.dat', Buffer.from([1, 0, 2])))
  assert.match('error' in binary ? binary.error : '', /不是可识别的文本文件/)
  const big = await readPickedFile(write('big.txt', 'x'.repeat(MAX_IMPORT_BYTES + 1)))
  assert.match('error' in big ? big.error : '', /分段导入/)
  const utf16 = await readPickedFile(write('utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('李四：好的', 'utf16le')])))
  assert.equal('content' in utf16 ? utf16.content : null, '李四：好的')
  const bom = await readPickedFile(write('bom.txt', `\uFEFF王五：收到`))
  assert.equal('content' in bom ? bom.content : null, '王五：收到')
  const folder = await readPickedFile(dir)
  assert.match('error' in folder ? folder.error : '', /不是文件/)
})

test('取消选择文件不发请求', async t => {
  const f = setup(t, null)
  await new Promise(resolve => setImmediate(resolve))
  const reply = await f.invoke(REPORT_WORKBENCH_CHANNELS.importMaterial, f.win.event(), { kind: 'import_text' })
  assert.equal(reply.code, 'cancelled')
  assert.equal(f.calls.length, 0)
})

test('窗口：沙箱、隔离上下文、独立离线分区；禁止导航与新窗口；refresh 推送刷新；dispose 移除全部通道', async t => {
  const f = setup(t)
  const prefs = f.win.options.webPreferences as Record<string, unknown>
  assert.equal(prefs.sandbox, true)
  assert.equal(prefs.contextIsolation, true)
  assert.equal(prefs.nodeIntegration, false)
  assert.equal(prefs.partition, REPORT_WORKBENCH_PARTITION)
  const blocked: string[] = []
  for (const url of ['https://example.com/x.png', 'http://127.0.0.1:9/chat', 'file:///D:/app/report-workbench.js', 'data:,x']) {
    f.win.requestFilter!({ url }, result => { if (result.cancel) blocked.push(url) })
  }
  assert.deepEqual(blocked, ['https://example.com/x.png', 'http://127.0.0.1:9/chat'], '分区内网络请求一律取消，连本机桥接也不能直连')
  assert.equal(f.win.openHandler!().action, 'deny')
  let prevented = 0
  f.win.webContentsEvents.get('will-navigate')!({ preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 1)
  f.handle.refresh()
  assert.equal(f.win.sent.at(-1), REPORT_WORKBENCH_CHANGED)
  f.handle.open()
  assert.equal(windows.at(-1), f.win, '再次打开只是带到前台，不新建窗口')
  f.handle.dispose()
  for (const channel of Object.values(REPORT_WORKBENCH_CHANNELS)) assert.equal(handlers.has(channel), false)
  assert.equal(f.win.destroyed, true)
})

test('客户端只用聊天令牌（bridge.json）且从不读取审批凭据；未绑定如实转达；连不上不重发', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-wb-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  mkdirSync(path.join(home, 'personal-assistant'))
  writeFileSync(path.join(home, 'personal-assistant', 'bridge.json'), JSON.stringify({ port: 45678, token: '聊天令牌-测试', epoch: 'e1' }))
  writeFileSync(path.join(home, 'personal-assistant', 'bridge-approval.json'), JSON.stringify({ reportApprovalToken: '日报审批令牌', assistantApprovalToken: '助理审批令牌', epoch: 'e1', port: 45678 }))
  const seen: Array<{ url: string; init?: RequestInit }> = []
  let respond: () => Response | Promise<Response> = () => new Response(JSON.stringify({ ok: true, proposalId: 'p' }))
  const client = new ReportWorkbenchClient({ fetchImpl: (async (url: string, init?: RequestInit) => { seen.push({ url: String(url), init }); return respond() }) as typeof fetch })
  const ok = await client.publishRequest({ date: '2026-10-17', revision: 2, digest: DIGEST, targetPath: 'D:/r.md' })
  assert.equal(ok.ok, true)
  assert.equal(seen[0].url, `http://127.0.0.1:45678/workbench/report/publish-request?token=${encodeURIComponent('聊天令牌-测试')}`)
  assert.deepEqual(JSON.parse(String(seen[0].init?.body)), { date: '2026-10-17', revision: 2, digest: DIGEST, targetPath: 'D:/r.md' })
  assert.equal(new Headers(seen[0].init?.headers).has('x-dsh-approval-token'), false)
  assert.equal(JSON.stringify(seen).includes('审批令牌'), false, '审批凭据一次都不出现在请求里')

  respond = () => new Response(JSON.stringify({ ok: false, code: 'unbound', error: '还没有连上 dsh 会话' }), { status: 503 })
  const unbound = await client.edit({ date: '2026-10-17' })
  assert.deepEqual([unbound.ok, unbound.code, unbound.error], [false, 'unbound', '还没有连上 dsh 会话'])
  respond = () => new Response('{}', { status: 401 })
  assert.equal((await client.report('2026-10-17')).code, 'unauthorized')
  respond = () => { throw new Error('ECONNREFUSED') }
  const down = await client.deletionRequest({ category: 'memory', params: {}, previewDigest: 'x' })
  assert.equal(down.code, 'unreachable')
  assert.match(down.error ?? '', /不会自动重发/)
  assert.equal(seen.length, 4, '失败不自动重试')
  rmSync(path.join(home, 'personal-assistant', 'bridge.json'))
  assert.equal((await client.report('2026-10-17')).code, 'no_runtime')
})
