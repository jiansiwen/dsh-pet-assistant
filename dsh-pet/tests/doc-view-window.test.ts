/** 阅读视图：令牌、授权、指纹、异常文件状态与控制器接线（真实磁盘 + 真实 PDF.js 解析 + 假 electron）。 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mock, test, type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import { createDocFileSystem } from '../src/main/doc-fs.ts'
import { DocumentLibrary, MAX_DOC_BYTES, fingerprintBytes, type DocFileSystem } from '../src/main/document.ts'
import { pdfFailure } from '../src/main/doc-pdf.ts'
import {
  createPlaybackTap,
  docUtteranceId,
  textDigest,
  type DocAnchor,
  type DocViewDescriptor,
  type DocViewTarget,
  type DocViewTargetSession,
  type DocViewUserAction,
  type PresenterStatus,
} from '../src/main/doc-presenter.ts'
import { syntheticPdf } from './pdf-fixtures.ts'

// ── 假 electron：只实现阅读视图窗口用得到的那一小块 ──────────────────────────

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const listeners = new Map<string, (...args: unknown[]) => void>()
const windows: FakeWindow[] = []
let nextId = 100

class FakeWindow {
  readonly options: Record<string, unknown>
  readonly events = new Map<string, Array<() => void>>()
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  readonly blocked: string[] = []
  destroyed = false
  visible = false
  readonly webContents: Record<string, unknown>
  constructor(options: Record<string, unknown>) {
    this.options = options
    const id = nextId++
    const mainFrame = { url: '' }
    const self = this
    this.webContents = {
      id,
      mainFrame,
      send: (channel: string, payload: unknown) => self.sent.push({ channel, payload }),
      setWindowOpenHandler() {},
      on() {},
      session: {
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        webRequest: {
          onBeforeRequest(listener: (details: { url: string }, callback: (result: { cancel: boolean }) => void) => void) {
            for (const url of ['https://example.com/a.js', 'ws://127.0.0.1/x', 'file:///D:/x/doc-view.js', 'data:,x']) {
              listener({ url }, (result) => { if (result.cancel) self.blocked.push(url) })
            }
          },
        },
      },
    }
    windows.push(this)
  }
  setMenuBarVisibility() {}
  on(event: string, callback: () => void) { this.events.set(event, [...(this.events.get(event) ?? []), callback]) }
  once(event: string, callback: () => void) { this.on(event, callback) }
  async loadFile(file: string) { (this.webContents.mainFrame as { url: string }).url = pathToFileURL(file).href }
  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible }
  show() { this.visible = true }
  showInactive() { this.visible = true }
  close() {
    if (this.destroyed) return
    this.destroyed = true
    for (const callback of this.events.get('closed') ?? []) callback()
  }
  /** 渲染层从这个窗口发出的一次调用。frame 可被替换来模拟子框架或别的页面。 */
  event(frame?: { url: string }) {
    const mainFrame = this.webContents.mainFrame as { url: string }
    return { sender: { id: this.webContents.id as number, mainFrame }, senderFrame: frame ?? mainFrame }
  }
}

mock.module('electron', {
  namedExports: {
    BrowserWindow: FakeWindow,
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        assert.ok(!handlers.has(channel), `重复注册 ${channel}`)
        handlers.set(channel, handler)
      },
      on: (channel: string, handler: (...args: unknown[]) => void) => listeners.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
      removeAllListeners: (channel: string) => listeners.delete(channel),
    },
  },
})

const view = await import('../src/main/doc-view-window.ts')
const { createDocViewController, DocViewGrants, PdfViewWindow, readPdfResource, senderAllowed, DOC_VIEW_CHANNELS } = view

const PAGES = ['Page one heading\nPage one body text', 'Page two quoted sentence for anchors', 'Page three closing']

async function fixture(t: TestContext) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-docview-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'docs')
  const outside = path.join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  const file = path.join(root, '合成讲解.pdf')
  await writeFile(file, syntheticPdf(PAGES))
  let roots = [root]
  const fs = createDocFileSystem()
  const library = new DocumentLibrary(fs, () => roots)
  return { base, root, outside, file, fs, library, setRoots: (next: string[]) => { roots = next } }
}

/** 记录型视图目标：验证控制器只按状态机指令驱动目标。 */
class RecordingTarget implements DocViewTarget {
  readonly kind = 'recording'
  readonly calls: string[] = []
  readonly gotos: Array<{ anchor: DocAnchor; highlight: boolean }> = []
  readonly statuses: PresenterStatus[] = []
  readonly sessions: DocViewTargetSession[] = []
  private readonly listeners = new Set<(action: DocViewUserAction) => void>()
  show(session: DocViewTargetSession) { this.sessions.push(session); this.calls.push('show') }
  goto(anchor: DocAnchor, options: { highlight: boolean }) { this.gotos.push({ anchor, highlight: options.highlight }); this.calls.push(`goto:${anchor.page}`) }
  status(status: PresenterStatus) { this.statuses.push(status) }
  currentPage() { return this.gotos.at(-1)?.anchor.page ?? null }
  invalidate(reason: 'changed' | 'unauthorized') { this.calls.push(`invalidate:${reason}`) }
  onUserAction(listener: (action: DocViewUserAction) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  close() { this.calls.push('close') }
  dispose() { this.calls.push('dispose') }
  act(action: DocViewUserAction) { for (const listener of this.listeners) listener(action) }
}

const until = async (check: () => boolean, label: string) => {
  for (let index = 0; index < 200 && !check(); index++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(check(), label)
}

test('发信者核验：只认登记的窗口、主框架与算出来的页面地址', () => {
  const frame = { url: 'file:///D:/app/doc-view.html' }
  const event = { sender: { id: 7, mainFrame: frame }, senderFrame: frame }
  assert.equal(senderAllowed(event, 7, frame.url), true)
  assert.equal(senderAllowed(event, null, frame.url), false, '未登记')
  assert.equal(senderAllowed(event, 8, frame.url), false, '别的窗口')
  assert.equal(senderAllowed({ ...event, senderFrame: { url: frame.url } }, 7, frame.url), false, '子框架')
  assert.equal(senderAllowed(event, 7, 'file:///D:/app/other.html'), false, '被导航到别处')
})

test('随包资源只读白名单内的 CMap 与标准字体', async () => {
  assert.ok((await readPdfResource('cMapUrl', '78-H.bcmap'))?.byteLength)
  assert.ok((await readPdfResource('standardFontDataUrl', 'FoxitFixed.pfb'))?.byteLength)
  for (const [kind, filename] of [['cMapUrl', '../package.json'], ['cMapUrl', '78-H.json'], ['wasmUrl', 'openjpeg.wasm'],
    ['standardFontDataUrl', 'https://x/y.ttf'], ['cMapUrl', 'C:\\Windows\\win.ini']]) {
    assert.equal(await readPdfResource(kind, filename), null, `${kind}/${filename}`)
  }
})

test('令牌：绑定 realPath + 指纹；每次取数重查授权与指纹；新会话作废旧令牌；缓存不绕过授权', async (t) => {
  const { file, library, setRoots, root } = await fixture(t)
  const opened = await library.open(file)
  assert.ok(opened.kind === 'opened' && opened.doc.parsed.kind === 'outline')
  const { buildDocPlan } = await import('../src/main/doc-presenter.ts')
  const built = buildDocPlan({ sessionId: 's', fingerprint: opened.doc.fingerprint, outline: opened.doc.parsed.outline })
  assert.ok(built.kind === 'plan')
  const grants = new DocViewGrants(library)
  const token = grants.issue(opened.doc.path, opened.doc.fingerprint, built.plan)
  assert.match(token, /^[0-9a-f]{48}$/)

  const ok = await grants.check(token, opened.doc.fingerprint)
  assert.ok(ok.ok)
  assert.equal(fingerprintBytes(ok.bytes), opened.doc.fingerprint)
  const page = await grants.page(token, opened.doc.fingerprint, 2)
  assert.ok(page.ok)
  assert.equal(page.textDigest, textDigest(PAGES[1]))
  assert.equal(page.pageCount, 3)

  assert.equal((await grants.check('forged', opened.doc.fingerprint)).ok, false)
  assert.equal((await grants.check(file, opened.doc.fingerprint)).ok, false, '路径不能当令牌')
  const tampered = await grants.check(token, opened.doc.fingerprint.replace(/.$/, c => (c === '0' ? '1' : '0')))
  assert.ok(!tampered.ok && tampered.problem.code === 'fingerprint-mismatch')
  const outOfRange = await grants.page(token, opened.doc.fingerprint, 4)
  assert.ok(!outOfRange.ok)

  // 授权撤销：缓存里的解析结果还在，但取数立即被拒。
  setRoots([])
  const revoked = await grants.check(token, opened.doc.fingerprint)
  assert.ok(!revoked.ok && revoked.problem.code === 'denied')
  setRoots([root])

  // 文件被改：令牌仍是那张，但现读快照的指纹对不上。
  await writeFile(file, syntheticPdf(['Changed content']))
  const changed = await grants.page(token, opened.doc.fingerprint, 1)
  assert.ok(!changed.ok && changed.problem.code === 'changed')

  // 新会话签发即作废旧令牌。
  const second = grants.issue(opened.doc.path, opened.doc.fingerprint, built.plan)
  assert.notEqual(second, token)
  assert.ok(!(await grants.check(token, opened.doc.fingerprint)).ok)
  grants.revoke()
  assert.ok(!(await grants.check(second, opened.doc.fingerprint)).ok)
})

test('快照在读取期间会话被替换：结果不交给任何一方', async () => {
  let release: () => void = () => {}
  const library = {
    snapshot: () => new Promise<never>((resolve) => {
      release = () => resolve({ kind: 'snapshot', path: 'p', bytes: new Uint8Array([1]), fingerprint: 'f' } as never)
    }),
  }
  const grants = new DocViewGrants(library)
  const plan = { sessionId: 's', fingerprint: 'f', pageCount: 1, textLayer: true, sections: [], startSection: 0 }
  const token = grants.issue('p', 'f', plan)
  const pending = grants.check(token, 'f')
  grants.issue('p', 'f', plan)
  release()
  const result = await pending
  assert.ok(!result.ok && result.problem.code === 'invalid-token')
})

test('异常文件：扫描件可看但只按页；加密、损坏、超大、超页数与越权给出明确状态且不签发令牌', async (t) => {
  const { root, outside, library, fs } = await fixture(t)
  const write = async (name: string, data: Uint8Array, dir = root) => {
    const target = path.join(dir, name)
    await writeFile(target, data)
    return target
  }
  const target = new RecordingTarget()
  const controller = createDocViewController({ library, subscribePlayback: () => () => {}, onHostEvent: () => {}, target })

  const scanned = await controller.present({ path: await write('扫描.pdf', syntheticPdf([''], { imageOnly: true })), sessionId: 's' })
  assert.deepEqual(scanned, { ok: true, textLayer: false, pageCount: null })
  assert.equal(target.sessions.at(-1)?.problem, null)
  assert.equal(target.sessions.at(-1)?.plan?.textLayer, false)
  assert.equal(target.sessions.at(-1)?.plan?.sections.length, 0, '扫描件不编造正文段落')

  const cases: Array<[string, Uint8Array, string]> = [
    ['加密.pdf', syntheticPdf(['Secret'], { encrypted: true }), 'password'],
    ['损坏.pdf', new Uint8Array(Buffer.from('%PDF-1.7\nthis is not really a pdf')), 'invalid'],
    ['超大.pdf', new Uint8Array(MAX_DOC_BYTES + 1), 'too-big'],
  ]
  for (const [name, data, code] of cases) {
    const result = await controller.present({ path: await write(name, data), sessionId: 's' })
    assert.ok(!result.ok, name)
    assert.equal(result.problem.code, code, `${name}: ${result.problem.message}`)
    assert.equal(target.sessions.at(-1)?.problem?.code, code, '窗口也显示同一状态')
    assert.equal(target.sessions.at(-1)?.plan, null)
  }
  const outsider = await controller.present({ path: await write('越权.pdf', syntheticPdf(['x']), outside), sessionId: 's' })
  assert.ok(!outsider.ok && outsider.problem.code === 'denied')
  assert.ok(!(await controller.present({ path: path.join(root, 'a.md'), sessionId: 's' })).ok)

  // 超页数 / 超字数：用注入的解析结果钉住措辞（真实 501 页解析见 doc-pdf.test.ts）。
  for (const code of ['page-limit', 'char-limit'] as const) {
    const limited = new DocumentLibrary(fs as DocFileSystem, () => [root], async () => pdfFailure(code, { limit: 1 }))
    const other = createDocViewController({ library: limited, subscribePlayback: () => () => {}, onHostEvent: () => {}, target: new RecordingTarget() })
    const result = await other.present({ path: await write(`${code}.pdf`, syntheticPdf(['y'])), sessionId: 's' })
    assert.ok(!result.ok && result.problem.code === code)
    assert.match(result.problem.message, /上限/)
  }
})

test('控制器：只按播放回执推进；新段开始时复核文件，变化即停止并作废数据访问', async (t) => {
  const { file, library } = await fixture(t)
  const tap = createPlaybackTap<unknown>()
  let deliver: (event: unknown) => void = () => {}
  tap.wrap((sink: (event: unknown) => void) => { deliver = sink })(() => {})
  const host: unknown[] = []
  const target = new RecordingTarget()
  const controller = createDocViewController({ library, subscribePlayback: tap.subscribe, onHostEvent: event => host.push(event), target })
  const opened = await library.open(file)
  assert.ok(opened.kind === 'opened')
  const fp = opened.doc.fingerprint
  assert.deepEqual(await controller.present({ path: file, fingerprint: fp, sessionId: 'talk', startSection: 0 }), { ok: true, textLayer: true, pageCount: 3 })
  assert.deepEqual(target.calls, ['show', 'goto:1'])
  assert.equal(target.gotos[0].highlight, false)

  // 模型很快地把三段都讲完了：不翻页。
  for (let index = 0; index < 3; index++) controller.explanation(index, `【原文】${PAGES[index].split('\n').at(-1)}。`)
  assert.deepEqual(target.calls, ['show', 'goto:1'])

  const id = (section: number, segment: number) => `${docUtteranceId('talk', fp, section)}#${segment}`
  deliver({ started: { id: id(0, 0) } })
  assert.deepEqual(target.calls.slice(2), ['goto:1'])
  assert.equal(target.gotos.at(-1)?.anchor.precision, 'text')
  deliver({ finished: { id: id(0, 0) } })
  deliver({ started: { id: id(0, 0) } })  // 重复
  deliver({ started: { id: `${docUtteranceId('old', fp, 2)}#0` } })  // 别的会话
  assert.deepEqual(target.calls.slice(2), ['goto:1'])

  // 第二段真的开始播之前，文件被改了：复核发现变化，停止并作废数据访问。
  await writeFile(file, syntheticPdf(['Edited']))
  deliver({ started: { id: id(1, 0) } })
  assert.deepEqual(target.calls.slice(3), ['goto:2'])
  await until(() => host.length > 0, '应回报停止')
  assert.deepEqual(host, [{ type: 'stopped', reason: 'file-changed', needsConfirm: false }])
  assert.ok(target.calls.includes('invalidate:changed'))
  assert.equal(controller.state.mode, 'stopped')
  deliver({ started: { id: id(2, 0) } })
  assert.ok(!target.calls.includes('goto:3'), '停止后不再推进')
})

test('控制器：手动翻页脱离、两个选项交给主进程；关窗要求确认；主进程自己关窗不回声', async (t) => {
  const { file, library } = await fixture(t)
  const host: Array<Record<string, unknown>> = []
  const target = new RecordingTarget()
  const controller = createDocViewController({ library, subscribePlayback: () => () => {}, onHostEvent: event => host.push(event as never), target })
  assert.ok((await controller.present({ path: file, sessionId: 'talk' })).ok)

  target.act({ kind: 'page', page: 3 })
  assert.equal(host[0].type, 'detached')
  assert.equal(host[0].fromHereSection, 2)
  target.act({ kind: 'from-here', page: 3 })
  assert.deepEqual(host[1], { type: 'choice', choice: 'from-here', page: 3, section: 2 })
  target.act({ kind: 'return' })
  assert.deepEqual(host[2], { type: 'choice', choice: 'return' })
  controller.reattach()
  assert.equal(target.calls.at(-1), 'goto:1')
  assert.equal(controller.state.mode, 'following')

  target.act({ kind: 'closed' })
  assert.deepEqual(host[3], { type: 'stopped', reason: 'view-closed', needsConfirm: true })

  assert.ok((await controller.present({ path: file, sessionId: 'talk2' })).ok)
  const before = host.length
  controller.close()
  target.act({ kind: 'closed' })
  assert.equal(host.length, before, '主进程叫停后关窗不再征求意见')
  controller.dispose()
  assert.equal(target.calls.at(-1), 'dispose')
})

test('阅读视图窗口：IPC 只认登记窗口；凭令牌取字节；篡改指纹被拒；文件变更与撤销授权停止推进', async (t) => {
  const { file, library, outside, root, setRoots } = await fixture(t)
  const pagePath = path.join(root, '..', 'doc-view.html')
  const host: Array<Record<string, unknown>> = []
  const controller = createDocViewController({
    library,
    subscribePlayback: () => () => {},
    onHostEvent: event => host.push(event as never),
    windowOptions: { pagePath, preloadPath: path.join(root, '..', 'doc-view.cjs') },
  })
  controller.registerIpc()
  t.after(() => controller.dispose())
  assert.ok(controller.target instanceof PdfViewWindow)
  assert.ok((await controller.present({ path: file, sessionId: 'talk' })).ok)
  const win = windows.at(-1)!
  await new Promise(resolve => setImmediate(resolve))
  const prefs = win.options.webPreferences as Record<string, unknown>
  assert.equal(prefs.sandbox, true)
  assert.equal(prefs.contextIsolation, true)
  assert.equal(prefs.nodeIntegration, false)
  assert.equal(prefs.partition, view.DOC_VIEW_PARTITION)
  assert.deepEqual(win.blocked, ['https://example.com/a.js', 'ws://127.0.0.1/x'], '分区内网络请求一律取消')

  const invoke = (channel: string, event: unknown, ...args: unknown[]) => handlers.get(channel)!(event, ...args) as Promise<never>
  const descriptor = await invoke(DOC_VIEW_CHANNELS.session, win.event()) as DocViewDescriptor
  assert.ok(descriptor.token)
  assert.equal(descriptor.pageCount, 3)
  assert.equal(descriptor.lastGoto?.anchor.page, 1)
  assert.equal(JSON.stringify(descriptor).includes(file.replace(/\\/g, '\\\\')), false, '描述里不含路径')

  // 别的页面 / 别的窗口一律拿不到。
  const foreign = { sender: { id: 1, mainFrame: {} }, senderFrame: { url: pathToFileURL(pagePath).href } }
  assert.equal(await invoke(DOC_VIEW_CHANNELS.session, foreign), null)
  assert.equal(await invoke(DOC_VIEW_CHANNELS.session, win.event({ url: 'file:///evil.html' })), null)
  const foreignBytes = await invoke(DOC_VIEW_CHANNELS.bytes, foreign, descriptor.token, descriptor.fingerprint) as { ok: boolean }
  assert.equal(foreignBytes.ok, false)

  const bytes = await invoke(DOC_VIEW_CHANNELS.bytes, win.event(), descriptor.token, descriptor.fingerprint) as { ok: true; bytes: Uint8Array }
  assert.ok(bytes.ok)
  assert.equal(fingerprintBytes(bytes.bytes), descriptor.fingerprint)
  const byPath = await invoke(DOC_VIEW_CHANNELS.bytes, win.event(), path.join(outside, 'x.pdf'), descriptor.fingerprint) as { ok: false; problem: { code: string } }
  assert.equal(byPath.problem.code, 'invalid-token', '渲染层传路径无效')
  const tampered = await invoke(DOC_VIEW_CHANNELS.page, win.event(), descriptor.token, `${descriptor.fingerprint}0`, 1) as { ok: false; problem: { code: string } }
  assert.equal(tampered.problem.code, 'fingerprint-mismatch')
  assert.equal(host.length, 0, '篡改指纹只拒绝，不当成文件变化')
  assert.equal(await invoke(DOC_VIEW_CHANNELS.resource, win.event(), 'bad', 'cMapUrl', '78-H.bcmap'), null)
  assert.ok(await invoke(DOC_VIEW_CHANNELS.resource, win.event(), descriptor.token, 'cMapUrl', '78-H.bcmap'))

  // 渲染层回报：渲染了第 2 页；用户手动翻到第 3 页 → 脱离。
  const report = listeners.get(DOC_VIEW_CHANNELS.report)!
  report(win.event(), descriptor.token, { kind: 'rendered', page: 2, numPages: 3, textMatch: true })
  assert.equal(controller.target.currentPage(), 2)
  report(win.event(), 'forged', { kind: 'page', page: 3 })
  report(win.event(), descriptor.token, { kind: 'page', page: 'x' })
  assert.equal(host.length, 0, '伪造令牌或畸形回报被忽略')
  report(win.event(), descriptor.token, { kind: 'page', page: 3 })
  assert.equal(host[0].type, 'detached')

  // 撤销授权：取页被拒 → 停止并作废令牌。
  setRoots([])
  const denied = await invoke(DOC_VIEW_CHANNELS.page, win.event(), descriptor.token, descriptor.fingerprint, 1) as { ok: false; problem: { code: string } }
  assert.equal(denied.problem.code, 'denied')
  assert.deepEqual(host.at(-1), { type: 'stopped', reason: 'unauthorized', needsConfirm: false })
  assert.ok(win.sent.some(item => item.channel === DOC_VIEW_CHANNELS.command
    && (item.payload as { type: string }).type === 'invalidated'
    && (item.payload as { problem: { code: string } }).problem.code === 'denied'))
  setRoots([root])
  const after = await invoke(DOC_VIEW_CHANNELS.bytes, win.event(), descriptor.token, descriptor.fingerprint) as { ok: false; problem: { code: string } }
  assert.equal(after.problem.code, 'invalid-token', '作废后的令牌不能再取字节')

  // 重新开一次：文件被改 → 取数报 changed → 停止。
  assert.ok((await controller.present({ path: file, sessionId: 'talk-2' })).ok)
  const fresh = await invoke(DOC_VIEW_CHANNELS.session, win.event()) as DocViewDescriptor
  await writeFile(file, syntheticPdf(['Edited after open']))
  const changed = await invoke(DOC_VIEW_CHANNELS.page, win.event(), fresh.token, fresh.fingerprint, 1) as { ok: false; problem: { code: string } }
  assert.equal(changed.problem.code, 'changed')
  assert.deepEqual(host.at(-1), { type: 'stopped', reason: 'file-changed', needsConfirm: false })

  // 用户关窗：令牌作废，回报 view-closed 并要求确认。
  assert.ok((await controller.present({ path: file, sessionId: 'talk-3' })).ok)
  const last = await invoke(DOC_VIEW_CHANNELS.session, win.event()) as DocViewDescriptor
  win.close()
  assert.deepEqual(host.at(-1), { type: 'stopped', reason: 'view-closed', needsConfirm: true })
  const closed = await invoke(DOC_VIEW_CHANNELS.bytes, win.event(), last.token, last.fingerprint) as { ok: false }
  assert.equal(closed.ok, false)
})

test('控制器：撤销授权后 recheck 立即停止；视图起不来时讲解不受影响并如实报告；旧会话的讲解文本被忽略', async (t) => {
  const { file, library, setRoots, root } = await fixture(t)
  const host: unknown[] = []
  const target = new RecordingTarget()
  const controller = createDocViewController({ library, subscribePlayback: () => () => {}, onHostEvent: event => host.push(event), target })
  assert.ok((await controller.present({ path: file, sessionId: 'talk' })).ok)
  controller.explanation(0, '【原文】Page one body text', 'other-session')
  assert.equal(controller.state.segments.size, 0)
  controller.explanation(0, '【原文】Page one body text', 'talk')
  assert.equal(controller.state.segments.size, 1)
  setRoots([])
  await controller.recheck()
  assert.deepEqual(host, [{ type: 'stopped', reason: 'unauthorized', needsConfirm: false }])
  assert.ok(target.calls.includes('invalidate:unauthorized'))
  setRoots([root])

  const broken = new RecordingTarget()
  broken.show = () => { throw new Error('窗口创建失败') }
  const other = createDocViewController({ library, subscribePlayback: () => () => {}, onHostEvent: () => {}, target: broken })
  const result = await other.present({ path: file, sessionId: 'talk' })
  assert.ok(!result.ok && result.problem.code === 'view-failed')
  assert.equal(other.state.mode, 'idle')
})
