/**
 * 成员编辑窗口。
 *
 * 独立的普通窗口，只加载本地固定页面；与舞台共用同一套成员 IPC 校验：
 * 窗口登记后，主进程仍逐次核对 sender、主框架与算出来的固定地址。
 * 页面自身不持有任何令牌或宿主凭据，保存仍由主进程做来源复核、原生确认和 CAS。
 */
import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const MEMBER_EDITOR_CHANNELS = { context: 'member-editor-context', close: 'member-editor-close', changed: 'members-changed' } as const
export const MEMBER_EDITOR_OPEN = 'member-editor-open'
export const MEMBER_EDITOR_PARTITION = 'dsh-member-editor'

export interface MemberEditorContext { memberId: string | null }
export interface MemberEditorOptions {
  readonly pagePath?: string
  readonly preloadPath?: string
}

export class MemberEditorWindow {
  private win: BrowserWindow | null = null
  private context: MemberEditorContext = { memberId: null }
  private readonly pagePath: string
  private readonly pageUrl: string
  private readonly preloadPath: string
  private locked = false

  constructor(options: MemberEditorOptions = {}) {
    this.pagePath = options.pagePath ?? path.join(here, '../renderer/member-editor.html')
    this.pageUrl = pathToFileURL(this.pagePath).href
    this.preloadPath = options.preloadPath ?? path.join(here, '../preload/member-editor.cjs')
  }

  get window(): BrowserWindow | null { return this.win }

  open(context: MemberEditorContext): boolean {
    this.context = { memberId: context.memberId }
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore()
      this.win.show()
      this.win.focus()
      this.win.webContents.send(MEMBER_EDITOR_CHANNELS.context, this.context)
      return true
    }
    this.create()
    return true
  }

  close(): void {
    const win = this.win
    this.win = null
    if (win && !win.isDestroyed()) win.close()
  }

  notifyChanged(): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(MEMBER_EDITOR_CHANNELS.changed)
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
    ipcMain.handle(MEMBER_EDITOR_CHANNELS.context, (event): MemberEditorContext | null => this.allowed(event) ? { ...this.context } : null)
    ipcMain.handle(MEMBER_EDITOR_CHANNELS.close, (event) => {
      if (!this.allowed(event)) return { ok: false }
      this.close()
      return { ok: true }
    })
    return () => {
      ipcMain.removeHandler(MEMBER_EDITOR_CHANNELS.context)
      ipcMain.removeHandler(MEMBER_EDITOR_CHANNELS.close)
    }
  }

  private create(): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea
    const width = Math.min(860, Math.max(560, area.width - 80))
    const height = Math.min(920, Math.max(560, area.height - 80))
    const win = new BrowserWindow({
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width, height, minWidth: 560, minHeight: 560,
      title: '团队成员', show: false, autoHideMenuBar: true, backgroundColor: '#f6f9fb',
      webPreferences: {
        preload: this.preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false,
        webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false, spellcheck: false,
        partition: MEMBER_EDITOR_PARTITION,
      },
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
    win.on('closed', () => { if (this.win === win) this.win = null })
    void win.loadFile(this.pagePath).catch(error => {
      console.log('[dsh-pet] 成员编辑窗口加载失败:', error instanceof Error ? error.message : String(error))
      if (this.win === win) this.win = null
    })
  }
}
