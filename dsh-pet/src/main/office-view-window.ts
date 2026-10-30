/**
 * docx / pptx 的逐页阅读与演示窗口。
 *
 * 与 PDF 阅读视图分开：这里只做本地 Office 渲染，不解释、不朗读、不写文件。
 * 页面字节仍由主进程经令牌交付；渲染层拿不到路径，每次换页都可让主进程重查授权与指纹。
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const OFFICE_VIEW_CHANNELS = { session: 'office-view-session', bytes: 'office-view-bytes',
  image: 'office-view-image', check: 'office-view-check', close: 'office-view-close',
  fullscreen: 'office-view-fullscreen', fullscreenChanged: 'office-view-fullscreen-changed',
  command: 'office-view-command' } as const
export const OFFICE_VIEW_PARTITION = 'dsh-office-view'
export type OfficeFormat = 'docx' | 'pptx'

export interface OfficeSection {
  readonly index: number
  readonly heading: string | null
  readonly text: string
  readonly pageNumber: number | null
}
export interface OfficeStart { readonly index: number; readonly pageNumber: number | null }
export interface OfficeDoc {
  readonly path: string
  readonly name: string
  readonly fingerprint: string
  readonly format: OfficeFormat
  readonly pageCount: number | null
  readonly sections?: readonly OfficeSection[]
  /** images = PowerPoint 导出的逐页图片；library = 本地库渲染。 */
  readonly mode?: 'library' | 'images'
  readonly images?: readonly Uint8Array[]
}
export interface OfficeSession {
  readonly token: string
  readonly name: string
  readonly fingerprint: string
  readonly format: OfficeFormat
  readonly pageCount: number | null
  readonly mode: 'library' | 'images'
  readonly sections: readonly OfficeSection[]
  readonly initialSection: OfficeStart | null
}
interface Options {
  readonly pagePath?: string
  readonly preloadPath?: string
  open(target: string): Promise<{ ok: true; doc: OfficeDoc } | { ok: false; error: string }>
  read(doc: OfficeDoc): Promise<Uint8Array>
  check(doc: OfficeDoc): Promise<{ ok: true } | { ok: false; error: string }>
}

export class OfficeViewWindow {
  private readonly options: Options
  private readonly pagePath: string
  private readonly pageUrl: string
  private readonly preloadPath: string
  private win: BrowserWindow | null = null
  private doc: OfficeDoc | null = null
  private session: OfficeSession | null = null
  private initialSection: OfficeStart | null = null
  private locked = false

  constructor(options: Options) {
    this.options = options
    this.pagePath = options.pagePath ?? path.join(here, '../renderer/office-view.html')
    this.pageUrl = pathToFileURL(this.pagePath).href
    this.preloadPath = options.preloadPath ?? path.join(here, '../preload/office-view.cjs')
  }

  async show(target: string, start: OfficeStart | null = null): Promise<{ ok: boolean; error?: string }> {
    const opened = await this.options.open(target)
    if (!opened.ok) return opened
    this.doc = opened.doc
    this.initialSection = start
    this.session = { token: randomBytes(24).toString('hex'), name: opened.doc.name, fingerprint: opened.doc.fingerprint,
      format: opened.doc.format, mode: opened.doc.mode ?? 'library', sections: opened.doc.sections ?? [],
      initialSection: start, pageCount: opened.doc.images?.length ?? opened.doc.pageCount }
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('office-view-session-changed')
      this.win.show(); this.win.focus()
      return { ok: true }
    }
    this.create()
    return { ok: true }
  }

  /** 讲解链同步翻页；只发段落/页码，不重新授权，视图会在换页时自行 check。 */
  gotoSection(index: number, pageNumber: number | null): void {
    if (!Number.isInteger(index) || index < 0) return
    this.initialSection = { index, pageNumber }
    const win = this.win
    if (win && !win.isDestroyed()) win.webContents.send(OFFICE_VIEW_CHANNELS.command, { type: 'goto-section', sectionIndex: index, pageNumber })
  }

  isOpen(): boolean { return !!this.win && !this.win.isDestroyed() }
  isShowing(path: string, fingerprint: string): boolean {
    return this.isOpen() && !!this.doc && this.doc.path === path && this.doc.fingerprint === fingerprint
  }

  close(): void {
    const win = this.win
    this.win = null
    this.doc = null
    this.session = null
    this.initialSection = null
    if (win && !win.isDestroyed()) win.close()
  }

  allowed(event: IpcMainInvokeEvent): boolean {
    try {
      const win = this.win
      return !!win && !win.isDestroyed() && event.sender === win.webContents
        && event.senderFrame !== null && event.senderFrame === event.sender.mainFrame && event.senderFrame === win.webContents.mainFrame
        && event.senderFrame.url === this.pageUrl && win.webContents.getURL() === this.pageUrl
    } catch { return false }
  }

  registerIpc(): () => void {
    ipcMain.handle(OFFICE_VIEW_CHANNELS.session, (event): OfficeSession | null => this.allowed(event) ? this.session : null)
    ipcMain.handle(OFFICE_VIEW_CHANNELS.bytes, async (event, token: unknown, fingerprint: unknown): Promise<Uint8Array> => {
      if (!this.allowed(event) || !this.doc || !this.session || token !== this.session.token || fingerprint !== this.session.fingerprint) {
        throw new Error('阅读会话已失效，请重新打开')
      }
      return await this.options.read(this.doc)
    })
    ipcMain.handle(OFFICE_VIEW_CHANNELS.image, async (event, token: unknown, fingerprint: unknown, index: unknown): Promise<Uint8Array> => {
      if (!this.allowed(event) || !this.doc || !this.session || token !== this.session.token || fingerprint !== this.session.fingerprint) {
        throw new Error('阅读会话已失效，请重新打开')
      }
      const images = this.doc.images ?? []
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= images.length) throw new Error('页码不存在')
      return images[index as number]!
    })
    ipcMain.handle(OFFICE_VIEW_CHANNELS.check, async (event, token: unknown, fingerprint: unknown) => {
      if (!this.allowed(event) || !this.doc || !this.session || token !== this.session.token || fingerprint !== this.session.fingerprint) {
        return { ok: false, error: '阅读会话已失效，请重新打开' }
      }
      return await this.options.check(this.doc)
    })
    ipcMain.handle(OFFICE_VIEW_CHANNELS.close, (event) => {
      if (!this.allowed(event)) return { ok: false }
      this.close()
      return { ok: true }
    })
    ipcMain.handle(OFFICE_VIEW_CHANNELS.fullscreen, (event, on: unknown) => {
      if (!this.allowed(event) || typeof on !== 'boolean') return { ok: false }
      const win = this.win
      if (!win || win.isDestroyed()) return { ok: false }
      win.setFullScreen(on)
      return { ok: true }
    })
    return () => {
      Object.values(OFFICE_VIEW_CHANNELS)
        .filter(channel => channel !== OFFICE_VIEW_CHANNELS.command && channel !== OFFICE_VIEW_CHANNELS.fullscreenChanged)
        .forEach(channel => ipcMain.removeHandler(channel))
    }
  }

  private create(): void {
    const win = new BrowserWindow({
      width: 1200, height: 800, minWidth: 720, minHeight: 520, fullscreenable: true,
      title: this.session?.name ?? '逐页阅读', show: false, autoHideMenuBar: true, backgroundColor: '#14161a',
      webPreferences: { preload: this.preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false,
        webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false, spellcheck: false,
        partition: OFFICE_VIEW_PARTITION },
    })
    this.win = win
    win.setMenuBarVisibility(false)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.webContents.on('will-frame-navigate', event => event.preventDefault())
    win.webContents.on('will-redirect', event => event.preventDefault())
    if (!this.locked) {
      this.locked = true
      const ses = win.webContents.session
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      ses.setPermissionCheckHandler(() => false)
      ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|blob|devtools):/i.test(details.url) }))
    }
    win.once('ready-to-show', () => { win.show(); win.focus() })
    win.on('enter-full-screen', () => { if (!win.isDestroyed()) win.webContents.send(OFFICE_VIEW_CHANNELS.fullscreenChanged, true) })
    win.on('leave-full-screen', () => { if (!win.isDestroyed()) win.webContents.send(OFFICE_VIEW_CHANNELS.fullscreenChanged, false) })
    win.on('closed', () => {
      if (this.win !== win) return
      this.win = null; this.doc = null; this.session = null
    })
    void win.loadFile(this.pagePath).catch(error => {
      console.log('[dsh-pet] Office 阅读窗口加载失败:', error instanceof Error ? error.message : String(error))
      if (this.win === win) { this.win = null; this.doc = null; this.session = null }
    })
  }
}
