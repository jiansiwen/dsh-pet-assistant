/**
 * 日报工作台窗口（M3-04 / M3-05）。窗口与全部 IPC 都在本模块内注册，主进程只需调用一次
 * {@link registerReportWorkbench}，再把返回的 open() 接到托盘或菜单上。
 *
 * 显示与批准分开，这是本模块的第一条规矩：
 * - 这个窗口渲染的是模型写的日报、事项与资料文字，所以它**不是**批准方：专用 preload 里没有任何
 *   "批准/决定"接口，本模块也不注册任何能签发批准的通道；
 * - "请求发布"只把用户正在看的那一版的修订号、摘要与保存路径**原样**交给插件核对；插件生成日报待批后，
 *   由主进程打开**现有的**专用审批窗口（ApprovalWindow.request），批准只在那里签发；
 * - 删除同理：插件生成助理待批，主进程打开同一个专用审批窗口；草稿条目删除是生成新版本的修订，不需要审批；
 * - 导入文件由主进程弹系统文件框、在主进程读取，渲染层说不出任何路径。
 *
 * 每个 IPC 都先核发信者：必须是本模块登记的那个窗口的主框架，且页面正是算出来的那个本地文件。
 * 窗口禁止导航与新窗口，使用独立的内存分区并取消一切网络请求——页面的数据全部经 IPC 从主进程来。
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sameLocalPage } from './approval-policy.ts'
import { ReportWorkbenchClient, type WorkbenchCallResult, type WorkbenchClientLike } from './report-workbench-client.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 渲染层能调用的全部通道。没有一条能批准或决定任何事。 */
export const REPORT_WORKBENCH_CHANNELS = {
  load: 'report-workbench:load',
  edit: 'report-workbench:edit',
  requestPublish: 'report-workbench:request-publish',
  deletionPreview: 'report-workbench:deletion-preview',
  requestDeletion: 'report-workbench:request-deletion',
  importMaterial: 'report-workbench:import-material',
  requestShare: 'report-workbench:request-share',
  editMemory: 'report-workbench:edit-memory',
} as const

/** 主进程推给工作台的"该刷新了"。 */
export const REPORT_WORKBENCH_CHANGED = 'report-workbench:changed'

/** 工作台窗口的内存分区：不落盘，不与舞台共用权限与网络设置。 */
export const REPORT_WORKBENCH_PARTITION = 'dsh-report-workbench'

/** 与插件资料上限一致：超过就请用户分段导入。 */
export const MAX_IMPORT_BYTES = 512 * 1024

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DIGEST = /^[a-f0-9]{64}$/
const MAX_TEXT = 2000

export type PickedFile = { name: string; content: string; bytes: number } | { error: string }

export interface ReportWorkbenchOptions {
  /** 现有专用审批窗口的打开入口（ApprovalWindow.request）。工作台只能请求打开它，自己不批准。 */
  openApproval(proposalId: string): Promise<{ ok: boolean; error?: string }>
  client?: WorkbenchClientLike
  /** 主进程的文件选择。缺省弹系统文件框；测试与隔离验证可以替换。 */
  pickFile?(parent: BrowserWindow | null): Promise<PickedFile | null>
  /** 缺省为打包产物 dist/renderer/report-workbench.html 与 dist/preload/report-workbench.cjs。 */
  pagePath?: string
  preloadPath?: string
  width?: number
  height?: number
}

export interface ReportWorkbenchHandle {
  /** 打开（或带到前台）工作台；date 缺省为今天。 */
  open(date?: string): void
  /** 通知工作台重新读取（桥接重连、待批被决定之后）。 */
  refresh(): void
  close(): void
  dispose(): void
  readonly window: BrowserWindow | null
}

interface SenderLike {
  readonly sender: { readonly id: number; readonly mainFrame: unknown }
  readonly senderFrame: { readonly url: string } | null
}

/** 发信者核验：只认登记过的 webContents 的主框架，且页面地址正是算出来的那个本地文件。 */
export function workbenchSenderAllowed(event: SenderLike, registeredId: number | null, expectedUrl: string): boolean {
  return registeredId !== null
    && event.sender.id === registeredId
    && event.senderFrame !== null
    && event.senderFrame === event.sender.mainFrame
    && sameLocalPage(event.senderFrame.url, expectedUrl)
}

export function localToday(now = Date.now()): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── 入参清洗：只放行已知字段与类型，其余一律丢掉 ───────────────────────────────

function plain(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function int(value: unknown, min: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min ? value : null
}

function str(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

export function sanitizeEdit(raw: unknown): Record<string, unknown> | null {
  const input = plain(raw)
  const op = plain(input?.op)
  if (!input || !op || typeof input.date !== 'string' || !DATE.test(input.date)) return null
  const baseRevision = int(input.baseRevision, 0)
  const baseDigest = str(input.baseDigest, 128)
  if (baseRevision === null || baseDigest === null) return null
  let cleanOp: Record<string, unknown>
  if (op.type === 'rewrite' || op.type === 'delete') {
    const line = int(op.line, 0)
    const expectedText = str(op.expectedText)
    if (line === null || expectedText === null) return null
    cleanOp = { type: op.type, line, expectedText }
    if (op.type === 'rewrite') {
      const text = str(op.text)
      if (text === null) return null
      cleanOp.text = text
    }
  } else if (op.type === 'add') {
    const afterLine = int(op.afterLine, -1)
    const text = op.text === undefined ? '' : str(op.text)
    if (afterLine === null || text === null) return null
    cleanOp = { type: 'add', afterLine, text }
  } else {
    return null
  }
  const workItemId = input.workItemId === undefined || input.workItemId === null ? undefined : str(input.workItemId, 200)
  if (workItemId === null) return null
  return {
    date: input.date, baseRevision, baseDigest, op: cleanOp,
    ...(workItemId ? { workItemId } : {}),
    ...(input.dryRun === true ? { dryRun: true } : {}),
  }
}

/** 请求发布：修订号、摘要、保存路径必须齐全，且原样转交——不在这里改写或补全任何一项。 */
export function sanitizePublish(raw: unknown): { date: string; revision: number; digest: string; targetPath: string } | null {
  const input = plain(raw)
  if (!input || typeof input.date !== 'string' || !DATE.test(input.date)) return null
  const revision = int(input.revision, 1)
  const digest = typeof input.digest === 'string' && DIGEST.test(input.digest) ? input.digest : null
  const targetPath = str(input.targetPath, 4096)
  if (revision === null || digest === null || !targetPath) return null
  return { date: input.date, revision, digest, targetPath }
}

/** 删除参数只收简单值：字符串、有限数字、布尔与 null。 */
export function sanitizeDeletion(raw: unknown, withDigest: boolean): { category: string; params: Record<string, unknown>; previewDigest?: string } | null {
  const input = plain(raw)
  const params = plain(input?.params ?? {})
  const category = str(input?.category, 40)
  if (!input || !params || !category) return null
  const entries = Object.entries(params)
  if (entries.length > 12) return null
  const clean: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    if (key.length > 40) return null
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= MAX_TEXT)) clean[key] = value
    else return null
  }
  if (!withDigest) return { category, params: clean }
  const previewDigest = str(input.previewDigest, 128)
  if (!previewDigest) return null
  return { category, params: clean, previewDigest }
}

/** 导入文件时渲染层只能给"这是什么"（种类、对象、时间），给不了路径与正文。 */
export function sanitizeImportMeta(raw: unknown): Record<string, unknown> | null {
  const input = plain(raw) ?? {}
  const kind = input.kind ?? 'chat_excerpt'
  if (kind !== 'chat_excerpt' && kind !== 'import_text' && kind !== 'note') return null
  const meta: Record<string, unknown> = { kind }
  const objectLabel = input.objectLabel === undefined || input.objectLabel === '' ? undefined : str(input.objectLabel, 200)
  if (objectLabel === null) return null
  if (objectLabel) meta.objectLabel = objectLabel
  for (const key of ['coveredFrom', 'coveredTo'] as const) {
    const value = input[key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    meta[key] = value
  }
  if (input.date !== undefined) {
    if (typeof input.date !== 'string' || !DATE.test(input.date)) return null
    meta.date = input.date
  }
  return meta
}

/**
 * 改写记忆的请求体：只收编号、正文与可选分类，多余字段一律丢掉。
 * 页面说不出记忆的作用范围（全局/项目）、也说不出旧正文——那些由插件按编号读出来核对。
 */
export function sanitizeMemoryEdit(raw: unknown): { memoryId: string; text: string; topic?: string } | null {
  const input = plain(raw)
  if (!input) return null
  const memoryId = str(input.memoryId, 200)
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (!memoryId || !text || text.length > MAX_TEXT) return null
  if (input.topic === undefined) return { memoryId, text }
  const topic = str(input.topic, 120)
  return topic === null ? null : { memoryId, text, topic: topic.trim() }
}

function decodeText(bytes: Buffer): string | null {
  try {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2))
    if (bytes.includes(0)) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

/** 读取用户在系统文件框里选中的那一个文件：只收文本，超限与二进制如实拒绝。 */
export async function readPickedFile(file: string): Promise<PickedFile> {
  try {
    const info = await stat(file)
    if (!info.isFile()) return { error: '选中的不是文件' }
    if (info.size > MAX_IMPORT_BYTES) return { error: `文件超过 ${MAX_IMPORT_BYTES / 1024}KB，请分段导入` }
    const content = decodeText(await readFile(file))
    if (content === null) return { error: '这不是可识别的文本文件（UTF-8 或带 BOM 的 UTF-16），没有导入' }
    return { name: path.basename(file), content, bytes: info.size }
  } catch (error) {
    return { error: `读不了这个文件：${error instanceof Error ? error.message : String(error)}` }
  }
}

async function defaultPickFile(parent: BrowserWindow | null): Promise<PickedFile | null> {
  const options: Electron.OpenDialogOptions = {
    title: '选择要导入的聊天导出或文本文件',
    properties: ['openFile'],
    filters: [{ name: '文本文件', extensions: ['txt', 'md', 'csv', 'json', 'log', 'html', 'htm'] }],
  }
  const result = parent && !parent.isDestroyed() ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length !== 1) return null
  return readPickedFile(result.filePaths[0])
}

function rejected(error: string): WorkbenchCallResult {
  return { ok: false, status: 0, code: 'bad_request', error, data: null }
}

const lockedSessions = new WeakSet<object>()

/** 分区一律离线：只放行本地页面与内存数据，取消任何网络请求，拒绝一切权限请求。 */
function lockDown(win: BrowserWindow): void {
  const ses = win.webContents.session
  if (lockedSessions.has(ses)) return
  lockedSessions.add(ses)
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^(file|data|devtools):/i.test(details.url) })
  })
}

/**
 * 装配工作台：注册 IPC，返回打开/刷新/释放入口。主进程调用一次即可，例如
 * `const workbench = registerReportWorkbench({ openApproval: id => approvals.request(id) })`。
 */
export function registerReportWorkbench(options: ReportWorkbenchOptions): ReportWorkbenchHandle {
  const client = options.client ?? new ReportWorkbenchClient()
  const pagePath = options.pagePath ?? path.join(here, '../renderer/report-workbench.html')
  const pageUrl = pathToFileURL(pagePath).href
  const preloadPath = options.preloadPath ?? path.join(here, '../preload/report-workbench.cjs')
  const pickFile = options.pickFile ?? defaultPickFile
  let win: BrowserWindow | null = null
  let registeredId: number | null = null
  let requestedDate: string | null = null
  let disposed = false

  const allowed = (event: SenderLike): boolean => workbenchSenderAllowed(event, registeredId, pageUrl)
  /** 打开专用审批窗口。打不开也如实说：待批已经在插件里了，可以从待办里再打开。 */
  const openApproval = async (proposalId: string) => {
    try {
      return await options.openApproval(proposalId)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const denied = rejected('这个请求不是来自日报工作台窗口，不予处理')

  ipcMain.handle(REPORT_WORKBENCH_CHANNELS.load, async (event, date: unknown) => {
    if (!allowed(event)) return denied
    const wanted = typeof date === 'string' && DATE.test(date) ? date : requestedDate ?? localToday()
    return client.report(wanted)
  })

  ipcMain.handle(REPORT_WORKBENCH_CHANNELS.edit, async (event, raw: unknown) => {
    if (!allowed(event)) return denied
    const body = sanitizeEdit(raw)
    return body ? client.edit(body) : rejected('修改请求不完整：缺少日期、基准版本或修改内容')
  })

  ipcMain.handle(REPORT_WORKBENCH_CHANNELS.requestPublish, async (event, raw: unknown) => {
    if (!allowed(event)) return denied
    const body = sanitizePublish(raw)
    if (!body) return rejected('请求发布必须带上你看到的版本号、内容摘要与保存路径')
    // 修订号、摘要与路径原样转交插件核对；这里不批准、不写文件。
    const result = await client.publishRequest(body)
    if (!result.ok || typeof result.data?.proposalId !== 'string') return result
    const opened = await openApproval(result.data.proposalId)
    return { ...result, approvalWindow: opened }
  })

  ipcMain.handle(REPORT_WORKBENCH_CHANNELS.deletionPreview, async (event, raw: unknown) => {
    if (!allowed(event)) return denied
    const body = sanitizeDeletion(raw, false)
    return body ? client.deletionPreview(body) : rejected('删除预览请求不完整')
  })

  ipcMain.handle(REPORT_WORKBENCH_CHANNELS.requestDeletion, async (event, raw: unknown) => {
    if (!allowed(event)) return denied
    const body = sanitizeDeletion(raw, true)
    if (!body) return rejected('删除请求必须带上你看过的影响范围摘要')
    const result = await client.deletionRequest(body as { category: string; params: Record<string, unknown>; previewDigest: string })
    if (!result.ok || result.data?.kind !== 'approval' || typeof result.data.proposalId !== 'string') return result
    return { ...result, approvalWindow: await openApproval(result.data.proposalId) }
  })

  ipcMain.handle(REPORT_WORKBENCH_CHANNELS.importMaterial, async (event, raw: unknown) => {
    if (!allowed(event)) return denied
    const meta = sanitizeImportMeta(raw)
    if (!meta) return rejected('导入信息不完整：种类只能是聊天片段、导入文本或随手记')
    const picked = await pickFile(win)
    if (picked === null) return { ok: false, status: 0, code: 'cancelled', error: '没有选择文件', data: null }
    if ('error' in picked) return rejected(picked.error)
    return client.importMaterial({ ...meta, content: picked.content, fileName: picked.name })
  })

  ipcMain.handle(REPORT_WORKBENCH_CHANNELS.requestShare, async (event, materialId: unknown) => {
    if (!allowed(event)) return denied
    const id = str(materialId, 200)
    if (!id) return rejected('没有指定资料')
    const result = await client.shareRequest({ materialId: id })
    if (!result.ok || typeof result.data?.proposalId !== 'string') return result
    return { ...result, approvalWindow: await openApproval(result.data.proposalId) }
  })

  ipcMain.handle(REPORT_WORKBENCH_CHANNELS.editMemory, async (event, raw: unknown) => {
    if (!allowed(event)) return denied
    const body = sanitizeMemoryEdit(raw)
    if (!body) return rejected('改写记忆必须带上记忆编号与非空正文')
    // 与请求发布同一条路：插件生成待批提案，这里只打开专用审批窗口，不直接写库。
    const result = await client.editMemory(body)
    if (!result.ok || typeof result.data?.proposalId !== 'string') return result
    return { ...result, approvalWindow: await openApproval(result.data.proposalId) }
  })

  const create = (): void => {
    const created = new BrowserWindow({
      width: options.width ?? 1180,
      height: options.height ?? 860,
      title: '日报工作台',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        spellcheck: false,
        partition: REPORT_WORKBENCH_PARTITION,
      },
    })
    win = created
    // webContents.id 创建时即确定；导航被禁止、地址另有核对，提前登记不会放进别的页面。
    registeredId = created.webContents.id
    created.setMenuBarVisibility(false)
    lockDown(created)
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    created.webContents.on('will-navigate', event => event.preventDefault())
    created.webContents.on('will-frame-navigate', event => event.preventDefault())
    created.webContents.on('will-redirect', event => event.preventDefault())
    created.on('closed', () => {
      if (win !== created) return
      win = null
      registeredId = null
    })
    created.once('ready-to-show', () => created.show())
    void created.loadFile(pagePath).catch(error => {
      console.log('[dsh-pet] 日报工作台页面加载失败:', error instanceof Error ? error.message : String(error))
      if (win === created) {
        win = null
        registeredId = null
      }
      if (!created.isDestroyed()) created.close()
    })
  }

  return {
    get window() { return win },
    open(date?: string) {
      if (disposed) return
      requestedDate = typeof date === 'string' && DATE.test(date) ? date : null
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        win.webContents.send(REPORT_WORKBENCH_CHANGED)
        return
      }
      create()
    },
    refresh() {
      if (win && !win.isDestroyed() && registeredId !== null) win.webContents.send(REPORT_WORKBENCH_CHANGED)
    },
    close() {
      const current = win
      win = null
      registeredId = null
      if (current && !current.isDestroyed()) current.close()
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const channel of Object.values(REPORT_WORKBENCH_CHANNELS)) ipcMain.removeHandler(channel)
      const current = win
      win = null
      registeredId = null
      if (current && !current.isDestroyed()) current.close()
    },
  }
}
