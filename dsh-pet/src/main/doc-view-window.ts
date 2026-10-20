/**
 * PDF 阅读视图窗口与讲解展示控制器（M5-01 / M5-02）。
 *
 * 分三层，各管一件事：
 * - `DocViewGrants`：一次会话令牌。签发时绑定 realPath + fingerprint，每次取数都重走
 *   `DocumentLibrary.snapshot`（重新 realpath、重判授权根、重读有界快照、现算指纹），不走任何缓存；
 * - `PdfViewWindow`：`DocViewTarget` 的阅读视图实现。专用 preload、sandbox、独立的内存分区，
 *   分区内只放行 file:/data:/blob:，一切网络请求直接取消；页面地址算出来而不是观察出来；
 * - `createDocViewController`：把播放回执、主进程指令与视图目标接到 `doc-presenter.ts` 的纯状态机上。
 *
 * 字节只有一个来源：主进程。渲染层手里只有令牌，它不能传路径；令牌只认登记过的那个窗口、
 * 那个固定页面的主框架。授权撤销或文件变化时令牌立即作废，渲染层已加载的 PDF 也要丢弃——
 * 每显示一页之前都必须先拿到一次成功的取数许可，缓存因此绕不过授权。
 */
import { BrowserWindow, ipcMain } from 'electron'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { splitIntoSegments } from './speech.ts'
import { isPdfName, MAX_DOC_BYTES, type DocumentLibrary, type OpenResult, type SnapshotResult } from './document.ts'
import {
  buildDocPlan,
  docUtteranceId,
  INITIAL_PRESENTER,
  nextPresenter,
  type DocAnchor,
  type DocPlan,
  type DocViewBytes,
  type DocViewDescriptor,
  type DocViewGrant,
  type DocViewProblem,
  type DocViewProblemCode,
  type DocViewReport,
  type DocViewTarget,
  type DocViewTargetSession,
  type DocViewUserAction,
  type HostEvent,
  type PlaybackReceipt,
  type PresenterEvent,
  type PresenterState,
  type PresenterStatus,
  type StopReason,
} from './doc-presenter.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

export const DOC_VIEW_CHANNELS = {
  session: 'doc-view-session',
  bytes: 'doc-view-bytes',
  page: 'doc-view-page',
  resource: 'doc-view-resource',
  report: 'doc-view-report',
  sessionChanged: 'doc-view-session-changed',
  command: 'doc-view-command',
} as const

/** 阅读视图窗口用的内存分区：不落盘、不与舞台共用权限与网络拦截。 */
export const DOC_VIEW_PARTITION = 'dsh-doc-view'

// ── 问题措辞 ──────────────────────────────────────────────────────────────

function megabytes(size: number): string {
  return (size / (1024 * 1024)).toFixed(1)
}

export function problem(code: DocViewProblemCode, detail?: string): DocViewProblem {
  const messages: Record<DocViewProblemCode, string> = {
    'not-pdf': '阅读视图只支持 PDF',
    denied: '文件不在授权目录内（或授权已撤销），不提供页面数据',
    missing: '文件已不在原来的位置',
    changed: '文件内容已变化，旧的讲解位置已失效；请重新解析后再讲',
    'too-big': `文件超过 ${megabytes(MAX_DOC_BYTES)}MB 解析上限，不加载页面`,
    unreadable: '文件读不出来',
    password: 'PDF 受密码保护，不会尝试解锁',
    invalid: 'PDF 已损坏或不是有效的 PDF',
    'page-limit': 'PDF 页数超过上限，不加载',
    'char-limit': 'PDF 文字量超过上限，不加载',
    'byte-limit': `PDF 超过 ${megabytes(MAX_DOC_BYTES)}MB 上限，不加载`,
    timeout: 'PDF 解析超时',
    cancelled: 'PDF 解析已取消',
    'worker-failed': 'PDF 解析线程异常',
    'invalid-token': '阅读会话已失效，请重新打开阅读视图',
    'fingerprint-mismatch': '视图持有的文件指纹与本次会话不一致，拒绝提供页面数据',
    'view-failed': '阅读视图打不开',
  }
  return { code, message: detail ? `${messages[code]}（${detail}）` : messages[code] }
}

function problemOfSnapshot(result: Exclude<SnapshotResult, { kind: 'snapshot' }>): DocViewProblem {
  switch (result.kind) {
    case 'denied': return problem('denied')
    case 'missing': return problem('missing')
    case 'too-big': return problem('too-big', `${megabytes(result.size)}MB`)
    case 'changed': return problem('changed')
    case 'unreadable': return problem('unreadable', result.reason)
  }
}

// ── 令牌 ────────────────────────────────────────────────────────────────

interface GrantSession {
  readonly token: string
  readonly realPath: string
  readonly fingerprint: string
  readonly plan: DocPlan
  /** 渲染层回报的实际页数（扫描件只能这样得知）；只用于越界判断与展示，不参与授权。 */
  reportedPages: number | null
}

export type GrantCheck =
  | { readonly ok: true; readonly session: GrantSession; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly problem: DocViewProblem }

/**
 * 一次会话令牌。同一时刻只有一张有效令牌：新会话签发即作废旧的。
 *
 * 渲染层每次取数都要带令牌与它看到的指纹；两者任何一个与登记的不一致都拒。
 * 指纹回传不是"由渲染层声明指纹"——判定用的是现读快照现算的指纹，回传只是让
 * "视图显示的是旧版本"这种陈旧状态在取数前就失败。
 */
export class DocViewGrants {
  private current: GrantSession | null = null
  private readonly library: Pick<DocumentLibrary, 'snapshot'>

  constructor(library: Pick<DocumentLibrary, 'snapshot'>) {
    this.library = library
  }

  issue(realPath: string, fingerprint: string, plan: DocPlan): string {
    const token = randomBytes(24).toString('hex')
    this.current = { token, realPath, fingerprint, plan, reportedPages: null }
    return token
  }

  revoke(): void {
    this.current = null
  }

  session(token: unknown): GrantSession | null {
    return typeof token === 'string' && token.length > 0 && this.current?.token === token ? this.current : null
  }

  /** 令牌 + 指纹 + 授权 + 现读快照，全部通过才放行。失败原因如实回报。 */
  async check(token: unknown, claimedFingerprint: unknown): Promise<GrantCheck> {
    const session = this.session(token)
    if (session === null) return { ok: false, problem: problem('invalid-token') }
    // 回传指纹被篡改或已陈旧：拒绝，但这不是"文件变了"的证据，不据此停止讲解。
    if (claimedFingerprint !== session.fingerprint) return { ok: false, problem: problem('fingerprint-mismatch') }
    const result = await this.library.snapshot(session.realPath, session.fingerprint)
    // 等快照的这段时间里会话可能已被替换或撤销：结果不能交给新会话，也不能交给已作废的旧令牌。
    if (this.current !== session) return { ok: false, problem: problem('invalid-token') }
    if (result.kind !== 'snapshot') return { ok: false, problem: problemOfSnapshot(result) }
    return { ok: true, session, bytes: result.bytes }
  }

  async page(token: unknown, claimedFingerprint: unknown, page: unknown): Promise<DocViewGrant> {
    const check = await this.check(token, claimedFingerprint)
    if (!check.ok) return check
    const { plan } = check.session
    const pageCount = plan.pageCount ?? check.session.reportedPages
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || (pageCount !== null && page > pageCount)) {
      return { ok: false, problem: { code: 'invalid', message: `页码 ${String(page)} 不存在` } }
    }
    const section = plan.sections.find(item => item.page === page)
    return {
      ok: true,
      page,
      pageCount,
      textDigest: section?.textDigest ?? null,
      paragraphs: section?.paragraphs ?? [],
    }
  }
}

// ── pdf.js 本地资源 ──────────────────────────────────────────────────────

let pdfjsRoot: string | null = null
function pdfjsResourceRoot(): string {
  pdfjsRoot ??= path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')))
  return pdfjsRoot
}

/** 只读随包 CMap 与标准字体；文件名白名单，拒绝路径、URL 与其他种类。 */
export async function readPdfResource(kind: unknown, filename: unknown): Promise<Uint8Array | null> {
  const directory = kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'standard_fonts' : null
  if (directory === null || typeof filename !== 'string') return null
  const extension = kind === 'cMapUrl' ? /\.bcmap$/ : /\.(pfb|ttf)$/
  if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(filename) || !extension.test(filename)) return null
  try {
    return new Uint8Array(await readFile(path.join(pdfjsResourceRoot(), directory, filename)))
  } catch {
    return null
  }
}

// ── 阅读视图窗口（DocViewTarget 的实现） ───────────────────────────────────

export interface PdfViewWindowOptions {
  /** 缺省为打包产物 dist/renderer/doc-view.html 与 dist/preload/doc-view.cjs。隔离验证时可替换。 */
  readonly pagePath?: string
  readonly preloadPath?: string
  readonly width?: number
  readonly height?: number
}

interface SenderLike {
  readonly sender: { readonly id: number; readonly mainFrame: unknown }
  readonly senderFrame: { readonly url: string } | null
}

/** 发信者核验：只认登记过的 webContents、主框架、且地址正是算出来的那个固定页面。 */
export function senderAllowed(event: SenderLike, registeredId: number | null, expectedUrl: string): boolean {
  return registeredId !== null
    && event.sender.id === registeredId
    && event.senderFrame !== null
    && event.senderFrame === event.sender.mainFrame
    && event.senderFrame.url === expectedUrl
}

function validReport(value: unknown): DocViewReport | null {
  if (value === null || typeof value !== 'object') return null
  const report = value as Record<string, unknown>
  const page = (key: string): boolean => typeof report[key] === 'number' && Number.isInteger(report[key]) && (report[key] as number) >= 1
  switch (report.kind) {
    case 'page': return page('page') ? { kind: 'page', page: report.page as number } : null
    case 'return': return { kind: 'return' }
    case 'from-here': return page('page') ? { kind: 'from-here', page: report.page as number } : null
    case 'rendered':
      return page('page') && page('numPages') && (report.textMatch === null || typeof report.textMatch === 'boolean')
        ? { kind: 'rendered', page: report.page as number, numPages: report.numPages as number, textMatch: report.textMatch as boolean | null }
        : null
    case 'error': return typeof report.message === 'string' ? { kind: 'error', message: report.message.slice(0, 200) } : null
    default: return null
  }
}

export class PdfViewWindow implements DocViewTarget {
  readonly kind = 'pdf-view'
  private win: BrowserWindow | null = null
  private registeredId: number | null = null
  private session: DocViewTargetSession | null = null
  private token: string | null = null
  private lastGoto: DocViewDescriptor['lastGoto'] = null
  private lastStatus: PresenterStatus | null = null
  private renderedPage: number | null = null
  private disposed = false
  private ipcRegistered = false
  private readonly listeners = new Set<(action: DocViewUserAction) => void>()
  private readonly grants: DocViewGrants
  private readonly pagePath: string
  private readonly pageUrl: string
  private readonly preloadPath: string
  private readonly width: number
  private readonly height: number

  constructor(library: Pick<DocumentLibrary, 'snapshot'>, options: PdfViewWindowOptions = {}) {
    this.grants = new DocViewGrants(library)
    // 期望地址是算出来的，不是加载后观察到的：观察值会随导航一起变，比对就永远通过。
    this.pagePath = options.pagePath ?? path.join(here, '../renderer/doc-view.html')
    this.pageUrl = pathToFileURL(this.pagePath).href
    this.preloadPath = options.preloadPath ?? path.join(here, '../preload/doc-view.cjs')
    this.width = options.width ?? 820
    this.height = options.height ?? 980
  }

  show(session: DocViewTargetSession): void {
    if (this.disposed) return
    this.session = session
    this.lastGoto = null
    this.lastStatus = null
    this.renderedPage = null
    // 新会话签发即作废旧令牌：旧页面里还在飞的取数请求会因 invalid-token 被拒。
    this.grants.revoke()
    this.token = session.problem === null && session.plan !== null
      ? this.grants.issue(session.realPath, session.fingerprint, session.plan)
      : null
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(DOC_VIEW_CHANNELS.sessionChanged)
      if (!this.win.isVisible()) this.win.showInactive()
      return
    }
    this.createWindow()
  }

  goto(anchor: DocAnchor, options: { readonly highlight: boolean }): void {
    this.lastGoto = { anchor, highlight: options.highlight }
    this.send({ type: 'goto', anchor, highlight: options.highlight })
  }

  status(status: PresenterStatus): void {
    this.lastStatus = status
    this.send({ type: 'status', status })
  }

  currentPage(): number | null {
    return this.renderedPage
  }

  invalidate(reason: 'changed' | 'unauthorized'): void {
    this.grants.revoke()
    this.token = null
    this.send({ type: 'invalidated', problem: problem(reason === 'changed' ? 'changed' : 'denied') })
  }

  onUserAction(listener: (action: DocViewUserAction) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  close(): void {
    this.grants.revoke()
    this.token = null
    this.session = null
    const win = this.win
    this.win = null
    this.registeredId = null
    this.renderedPage = null
    // 先解除登记再关：closed 回调看到 this.win 已不是它，就不回报 closed——
    // 主进程自己关的窗口不是用户动作，不需要再征求一次意见。
    if (win && !win.isDestroyed()) win.close()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.close()
    this.listeners.clear()
    if (this.ipcRegistered) {
      ipcMain.removeHandler(DOC_VIEW_CHANNELS.session)
      ipcMain.removeHandler(DOC_VIEW_CHANNELS.bytes)
      ipcMain.removeHandler(DOC_VIEW_CHANNELS.page)
      ipcMain.removeHandler(DOC_VIEW_CHANNELS.resource)
      ipcMain.removeAllListeners(DOC_VIEW_CHANNELS.report)
      this.ipcRegistered = false
    }
  }

  /** 全部 IPC 在本模块注册。每个 handler 先核发信者，再核令牌，最后才碰磁盘。 */
  registerIpc(): void {
    if (this.ipcRegistered) return
    this.ipcRegistered = true
    ipcMain.handle(DOC_VIEW_CHANNELS.session, (event): DocViewDescriptor | null => {
      if (!this.allowed(event)) return null
      return this.descriptor()
    })
    ipcMain.handle(DOC_VIEW_CHANNELS.bytes, async (event, token: unknown, fingerprint: unknown): Promise<DocViewBytes> => {
      if (!this.allowed(event)) return { ok: false, problem: problem('invalid-token') }
      const check = await this.grants.check(token, fingerprint)
      if (!check.ok) {
        this.onDenied(check.problem)
        return check
      }
      return { ok: true, bytes: check.bytes }
    })
    ipcMain.handle(DOC_VIEW_CHANNELS.page, async (event, token: unknown, fingerprint: unknown, page: unknown): Promise<DocViewGrant> => {
      if (!this.allowed(event)) return { ok: false, problem: problem('invalid-token') }
      const grant = await this.grants.page(token, fingerprint, page)
      if (!grant.ok) this.onDenied(grant.problem)
      return grant
    })
    ipcMain.handle(DOC_VIEW_CHANNELS.resource, async (event, token: unknown, kind: unknown, filename: unknown) => {
      if (!this.allowed(event) || this.grants.session(token) === null) return null
      return readPdfResource(kind, filename)
    })
    ipcMain.on(DOC_VIEW_CHANNELS.report, (event, token: unknown, raw: unknown) => {
      if (!this.allowed(event)) return
      const session = this.grants.session(token)
      const report = validReport(raw)
      if (session === null || report === null) return
      if (report.kind === 'rendered') {
        this.renderedPage = report.page
        session.reportedPages = report.numPages
        if (session.plan.pageCount !== null && session.plan.pageCount !== report.numPages) {
          this.emit({ kind: 'error', message: `视图页数 ${report.numPages} 与解析页数 ${session.plan.pageCount} 不一致` })
        }
        return
      }
      if (report.kind === 'error') { this.emit({ kind: 'error', message: report.message }); return }
      this.emit(report)
    })
  }

  private descriptor(): DocViewDescriptor | null {
    const session = this.session
    if (session === null) return null
    const plan = session.plan
    return {
      token: this.token,
      name: session.name,
      fingerprint: session.fingerprint,
      textLayer: plan?.textLayer ?? false,
      pageCount: plan?.pageCount ?? null,
      startPage: plan?.sections[plan.startSection]?.page ?? 1,
      problem: session.problem,
      lastGoto: this.lastGoto,
      lastStatus: this.lastStatus,
    }
  }

  private onDenied(found: DocViewProblem): void {
    if (found.code === 'changed' || found.code === 'missing') this.emit({ kind: 'denied', reason: 'changed' })
    else if (found.code === 'denied') this.emit({ kind: 'denied', reason: 'unauthorized' })
  }

  private emit(action: DocViewUserAction): void {
    for (const listener of [...this.listeners]) {
      try { listener(action) } catch (error) {
        console.log('[dsh-pet] 阅读视图回调出错:', error instanceof Error ? error.message : String(error))
      }
    }
  }

  private allowed(event: SenderLike): boolean {
    return senderAllowed(event, this.registeredId, this.pageUrl)
  }

  private send(command: unknown): void {
    const win = this.win
    if (!win || win.isDestroyed() || this.registeredId === null) return
    win.webContents.send(DOC_VIEW_CHANNELS.command, command)
  }

  private createWindow(): void {
    const win = new BrowserWindow({
      width: this.width,
      height: this.height,
      title: '阅读视图',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        spellcheck: false,
        // 内存分区：权限与网络拦截只作用于这个窗口，不波及舞台（舞台要用麦克风）。
        partition: DOC_VIEW_PARTITION,
      },
    })
    this.win = win
    // webContents.id 在创建时即确定；导航被禁止、地址另有核对，提前登记不会放进别的页面。
    this.registeredId = win.webContents.id
    win.setMenuBarVisibility(false)
    lockDownSession(win)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.webContents.on('will-frame-navigate', event => event.preventDefault())
    win.webContents.on('will-redirect', event => event.preventDefault())
    win.on('closed', () => {
      if (this.win !== win) return
      this.win = null
      this.registeredId = null
      this.renderedPage = null
      this.grants.revoke()
      this.token = null
      this.session = null
      if (!this.disposed) this.emit({ kind: 'closed' })
    })
    win.once('ready-to-show', () => {
      win.webContents.send(DOC_VIEW_CHANNELS.sessionChanged)
      win.show()
    })
    void win.loadFile(this.pagePath).catch(error => {
      console.log('[dsh-pet] 阅读视图页面加载失败:', error instanceof Error ? error.message : String(error))
      this.emit({ kind: 'error', message: '阅读视图页面加载失败' })
      this.close()
    })
  }
}

const lockedSessions = new WeakSet<object>()

/** 分区一律离线：只放行本地页面与内存数据，任何 http/https/ws 请求都直接取消；所有权限请求拒绝。 */
function lockDownSession(win: BrowserWindow): void {
  const ses = win.webContents.session
  if (lockedSessions.has(ses)) return
  lockedSessions.add(ses)
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = /^(file|data|blob|devtools):/i.test(details.url)
    if (!allowed) console.log('[dsh-pet] 阅读视图拦截了网络请求:', details.url.slice(0, 120))
    callback({ cancel: !allowed })
  })
}

// ── 控制器（主进程集成入口） ──────────────────────────────────────────────

/** 交给主进程的事件：状态机的 HostEvent，加上用户在"已脱离"提示里点了哪一个。 */
export type DocViewHostEvent =
  | HostEvent
  | { readonly type: 'choice'; readonly choice: 'return' }
  | { readonly type: 'choice'; readonly choice: 'from-here'; readonly page: number; readonly section: number | null }

export interface DocViewControllerDeps {
  /** 授权检查与读字节：open 只用于取解析状态（扫描/加密/损坏），取数一律走不缓存的 snapshot。 */
  readonly library: Pick<DocumentLibrary, 'open' | 'snapshot'>
  /** 播放回执订阅。主进程用 `createPlaybackTap().subscribe` 注入。 */
  readonly subscribePlayback: (listener: (receipt: PlaybackReceipt) => void) => () => void
  /** 用户动作与停止事件回调；后续怎么办由主进程决定。 */
  readonly onHostEvent: (event: DocViewHostEvent) => void
  /** 视图目标。缺省为 PDF 阅读视图窗口；WPS 适配器从这里换进来。 */
  readonly target?: DocViewTarget
  readonly windowOptions?: PdfViewWindowOptions
}

export interface PresentInput {
  /** DocTalk.path（open 之后的真实路径）。 */
  readonly path: string
  /** DocTalk.fingerprint。给了就必须与现读的一致，否则不开（讲的和看的必须是同一个版本）。 */
  readonly fingerprint?: string
  /** DocTalk.sessionId：与 docUtteranceId 同源，回执据此认领。 */
  readonly sessionId: string
  readonly startSection?: number
}

export type PresentResult =
  | { readonly ok: true; readonly textLayer: boolean; readonly pageCount: number | null }
  | { readonly ok: false; readonly problem: DocViewProblem }

export interface DocViewController {
  /** 打开/切换阅读视图到这份文档，并装上讲解计划。异常文件也会显示状态，返回 ok:false。 */
  present(input: PresentInput): Promise<PresentResult>
  /** 某段讲解文本已生成（尚未播放）。只用于细化锚点，绝不翻页。给了 sessionId 就必须与当前计划一致。 */
  explanation(section: number, text: string, sessionId?: string): void
  pause(): void
  resume(): void
  /** 主进程叫停（用户停止、讲完、换文档）。视图保留，供自由浏览。 */
  stop(reason?: StopReason): void
  /** 主进程决定"回到讲解位置"。 */
  reattach(): void
  /** 主进程发现文件变化（例如 resumeDocTalk 里指纹对不上）。 */
  fileChanged(): void
  /** 主进程确知授权已撤销。 */
  revoked(): void
  /** 立即重查一次当前文档的授权与指纹（例如撤销授权目录之后）；变了就停止并回报。 */
  recheck(): Promise<void>
  close(): void
  dispose(): void
  registerIpc(): void
  readonly state: PresenterState
  readonly target: DocViewTarget
}

function problemOfOpen(result: Exclude<OpenResult, { kind: 'opened' }>): DocViewProblem {
  switch (result.kind) {
    case 'denied': return problem('denied')
    case 'missing': return problem('missing')
    case 'too-big': return problem('too-big', `${megabytes(result.size)}MB`)
    case 'unreadable': return result.code === 'cancelled' ? problem('cancelled') : problem('unreadable', result.reason)
  }
}

export function createDocViewController(deps: DocViewControllerDeps): DocViewController {
  const target = deps.target ?? new PdfViewWindow(deps.library, deps.windowOptions)
  let state: PresenterState = INITIAL_PRESENTER
  let doc: { realPath: string; fingerprint: string } | null = null
  let verifying = false
  let verifiedSection: number | null = null
  let generation = 0
  let disposed = false

  const dispatch = (event: PresenterEvent): void => {
    const before = state
    const turn = nextPresenter(state, event)
    state = turn.state
    for (const command of turn.view) {
      if (command.type === 'goto') target.goto(command.anchor, { highlight: command.highlight })
      else target.status(command.status)
    }
    if (state.mode === 'stopped' && before.mode !== 'stopped'
      && (state.stopReason === 'file-changed' || state.stopReason === 'unauthorized')) {
      target.invalidate(state.stopReason === 'file-changed' ? 'changed' : 'unauthorized')
    }
    for (const host of turn.host) deps.onHostEvent(host)
    // 新的一段真的开始播了：顺手核一次文件，变了就停，不让旧锚点继续往下推。
    const section = state.position?.section ?? null
    if (event.type === 'receipt' && turn.dropped === undefined && state.positionStatus === 'playing'
      && section !== null && section !== verifiedSection) {
      verifiedSection = section
      void verify()
    }
  }

  const verify = async (): Promise<void> => {
    if (verifying || doc === null) return
    verifying = true
    const mine = generation
    const current = doc
    try {
      const result = await deps.library.snapshot(current.realPath, current.fingerprint)
      if (mine !== generation || disposed) return
      if (result.kind === 'changed' || result.kind === 'missing') dispatch({ type: 'file-changed' })
      else if (result.kind === 'denied') dispatch({ type: 'unauthorized' })
    } finally {
      verifying = false
    }
  }

  const unsubscribe = deps.subscribePlayback(receipt => {
    if (!disposed) dispatch({ type: 'receipt', receipt })
  })

  const offAction = target.onUserAction(action => {
    if (disposed) return
    switch (action.kind) {
      case 'page': dispatch({ type: 'user-page', page: action.page }); break
      case 'return': deps.onHostEvent({ type: 'choice', choice: 'return' }); break
      case 'from-here': {
        const plan = state.plan
        const section = plan?.sections.find(item => item.page === action.page && item.text !== '')?.index ?? null
        deps.onHostEvent({ type: 'choice', choice: 'from-here', page: action.page, section })
        break
      }
      case 'closed': dispatch({ type: 'view-closed' }); break
      case 'denied': dispatch({ type: action.reason === 'changed' ? 'file-changed' : 'unauthorized' }); break
      case 'error': dispatch({ type: 'view-error' }); break
    }
  })

  const showProblem = async (realPath: string, name: string, fingerprint: string, found: DocViewProblem): Promise<PresentResult> => {
    if (state.mode !== 'idle' && state.mode !== 'stopped') dispatch({ type: 'stop', reason: 'replaced' })
    doc = null
    try {
      await target.show({ realPath, name, fingerprint, plan: null, problem: found })
    } catch {
      // 视图打不开不影响如实报告原因。
    }
    return { ok: false, problem: found }
  }

  return {
    get state() { return state },
    target,

    async present(input) {
      generation += 1
      const mine = generation
      const name = path.basename(input.path)
      if (!isPdfName(name)) return { ok: false, problem: problem('not-pdf') }
      const opened = await deps.library.open(input.path)
      if (mine !== generation || disposed) return { ok: false, problem: problem('cancelled') }
      if (opened.kind !== 'opened') return showProblem(input.path, name, '', problemOfOpen(opened))
      const found = opened.doc
      if (input.fingerprint !== undefined && found.fingerprint !== input.fingerprint) {
        return showProblem(found.path, found.name, found.fingerprint, problem('changed'))
      }
      let outline = null
      if (found.parsed.kind === 'outline') outline = found.parsed.outline
      else if (found.parsed.kind === 'pdf-error' && found.parsed.code !== 'no-text') {
        return showProblem(found.path, found.name, found.fingerprint, { code: found.parsed.code, message: found.parsed.reason })
      } else if (found.parsed.kind !== 'pdf-error') {
        return showProblem(found.path, found.name, found.fingerprint, problem('invalid'))
      }
      // no-text：扫描件或全空白，只按页看，如实标注；不做 OCR、不编造正文。
      const built = buildDocPlan({ sessionId: input.sessionId, fingerprint: found.fingerprint, outline, startSection: input.startSection })
      if (built.kind !== 'plan') return showProblem(found.path, found.name, found.fingerprint, problem('not-pdf', built.reason))
      if (state.mode !== 'idle' && state.mode !== 'stopped') dispatch({ type: 'stop', reason: 'replaced' })
      doc = { realPath: found.path, fingerprint: found.fingerprint }
      verifiedSection = null
      try {
        await target.show({ realPath: found.path, name: found.name, fingerprint: found.fingerprint, plan: built.plan, problem: null })
      } catch (error) {
        // 视图本身起不来（窗口创建失败等）：讲解可以照常进行，只是没有阅读视图；由调用方决定是否提示。
        doc = null
        return { ok: false, problem: problem('view-failed', error instanceof Error ? error.message : String(error)) }
      }
      if (mine !== generation || disposed) return { ok: false, problem: problem('cancelled') }
      dispatch({ type: 'plan', plan: built.plan })
      return { ok: true, textLayer: built.plan.textLayer, pageCount: built.plan.pageCount }
    },

    explanation(section, text, sessionId) {
      const plan = state.plan
      if (plan === null || (sessionId !== undefined && sessionId !== plan.sessionId)) return
      const utteranceId = docUtteranceId(plan.sessionId, plan.fingerprint, section)
      dispatch({ type: 'explanation', section, segments: splitIntoSegments({ utteranceId, text }).map(segment => segment.text) })
    },
    pause() { dispatch({ type: 'pause' }) },
    resume() { dispatch({ type: 'resume' }) },
    stop(reason = 'user') { dispatch({ type: 'stop', reason }) },
    reattach() { dispatch({ type: 'reattach' }) },
    fileChanged() { dispatch({ type: 'file-changed' }) },
    revoked() { dispatch({ type: 'unauthorized' }) },
    async recheck() {
      // 有一次核对在途时等它结束再核：撤销动作发生在它读快照之后的话，那次核对看不到。
      while (verifying) await new Promise(resolve => setTimeout(resolve, 10))
      await verify()
    },
    close() {
      generation += 1
      dispatch({ type: 'stop', reason: 'user' })
      doc = null
      target.close()
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      unsubscribe()
      offAction()
      target.dispose()
    },
    registerIpc() {
      const window = target as Partial<PdfViewWindow>
      if (typeof window.registerIpc === 'function') window.registerIpc.call(target)
    },
  }
}
