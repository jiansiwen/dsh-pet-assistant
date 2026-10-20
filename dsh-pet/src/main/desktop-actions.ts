/**
 * 桌面应用与窗口动作的**唯一契约**（Windows / macOS 共用）。
 *
 * 这里只有类型、错误码、身份比较与结果构造 —— 不 spawn、不 import electron，`node --test` 能直接导入。
 * 平台实现分别在 `win-actions.ts`（UI Automation 辅助脚本）与 `mac-actions.ts`（osascript/JXA），
 * WPS 的定位、打开与页码同步在 `wps-control.ts`。
 *
 * 三条贯穿全部实现的规则：
 *
 * 1. **证据优先**。每个结果都带 `evidence`：执行前后的窗口身份、读回的页码、实际用了什么手段。
 *    "命令退出码为 0" 不等于 "目标达成" —— 跳页成功的唯一判据是读回的页码等于目标页。
 * 2. **身份先于动作**。任何会改变目标应用状态的动作，执行前后都核对窗口身份（pid、窗口句柄、
 *    进程路径、进程启动时间、标题含文档名）。对不上就拒绝，不"尽量做"。
 * 3. **如实降级**。接口不可靠时返回 `unsupported` 并建议改用阅读视图（`fallback: 'reading-view'`），
 *    不静默换成别的方式再报告成功。
 */

/** 实现了这份契约的平台。Linux 没有实现，调用方用 `platform.ts` 的能力开关挡住。 */
export type DesktopPlatform = 'win32' | 'darwin'

/**
 * 错误码。前七个是任务要求必须区分的；其余是实现中确实会遇到、且调用方处理方式不同的情形。
 *
 * - `not-installed`：目标应用没装，或登记的可执行文件不存在。
 * - `window-not-found`：找不到目标窗口（还没打开完 / 已关闭 / 应用已退出，见 `detail`）。
 * - `identity-changed`：窗口还在，但已不是当初那个（换了文档标签、pid 复用、进程路径不符）。
 * - `focus-stolen`：前台不是目标窗口（用户切走了 / 键盘焦点在输入框里），动作未执行或已中止。
 * - `dialog-blocking`：目标应用有模态弹窗挡着。
 * - `unsupported`：这个平台 / 应用版本没有可靠的实现；通常带 `fallback: 'reading-view'`。
 * - `timeout`：辅助进程超时，已被结束。
 * - `permission-denied`：系统权限不足；macOS 上 `permission` 细分为三种。
 * - `not-authorized`：调用方没有传入读取授权（读可见文字）。
 * - `ambiguous-window`：同名文档不止一个，无法确定是哪一个，拒绝操作。
 * - `invalid-argument`：参数不合法（相对路径、页码越界等）。
 * - `failed`：动作做了但读回不符合预期，或辅助进程异常。
 */
export type ActionErrorCode =
  | 'not-installed'
  | 'window-not-found'
  | 'identity-changed'
  | 'focus-stolen'
  | 'dialog-blocking'
  | 'unsupported'
  | 'timeout'
  | 'permission-denied'
  | 'not-authorized'
  | 'ambiguous-window'
  | 'invalid-argument'
  | 'failed'

export const ACTION_ERROR_CODES: readonly ActionErrorCode[] = [
  'not-installed', 'window-not-found', 'identity-changed', 'focus-stolen', 'dialog-blocking',
  'unsupported', 'timeout', 'permission-denied', 'not-authorized', 'ambiguous-window',
  'invalid-argument', 'failed',
]

/** macOS 的三种隐私权限。缺哪项只禁用依赖它的能力。 */
export type MacPermission = 'accessibility' | 'automation' | 'screen-recording'

/** 动作名，用于证据与日志。 */
export type ActionName =
  | 'locate' | 'openWith' | 'findWindow' | 'focus' | 'readVisibleText'
  | 'readForegroundText' | 'readPage' | 'gotoPage' | 'scroll' | 'verify'

/**
 * 目标窗口身份。拿到后原样回传给后续动作，实现据此核对"还是不是那个窗口"。
 *
 * - `windowId`：Windows 上是顶层窗口句柄（十进制字符串）；macOS 上是 `ax:<窗口序号>`（AX 没有稳定 ID，
 *   所以 macOS 的核对更依赖 `documentPath` / 标题）。
 * - `processStartedAt`：进程创建时间。pid 会被复用，加上启动时间才能确定是同一个进程。
 * - `component`：文档实际所在的组件进程（WPS 12 的 PDF 在独立的 wpspdf.exe 里，再嵌进主窗口）。
 */
export interface WindowIdentity {
  platform: DesktopPlatform
  pid: number
  windowId: string
  title: string
  processPath: string
  processStartedAt?: string
  className?: string
  documentName?: string
  documentPath?: string
  component?: { pid: number; windowId?: string; processPath: string }
}

/** 查找窗口的条件。进程条件必须给：只有进程对得上，才会去读这个窗口的标题。 */
export interface WindowQuery {
  /** 允许的可执行文件路径（Windows 大小写不敏感比较）。 */
  processPaths?: readonly string[]
  /** 允许的安装目录：进程路径在这个目录下即可（WPS 的组件进程分散在同一目录）。 */
  processDir?: string
  /** macOS：按 bundle id 定位进程。 */
  bundleId?: string
  /** 窗口标题必须包含的文字，通常是文档文件名。 */
  titleIncludes?: string
  /** 进一步限定 pid。 */
  pid?: number
}

/** 读可见文字的授权。只有调用方显式传入 `authorized: true` 才会执行。 */
export interface TextReadGrant {
  authorized: true
  /** 授权来由，进证据，便于事后审计。 */
  reason: string
  maxChars?: number
}

/** 语义定位的配置档：不同应用的页码控件、导航方式不同。目前只验证了 WPS PDF。 */
export type SemanticProfile = 'wps-pdf'

export interface PagePosition {
  page: number
  total: number
}

export interface ScrollRequest {
  direction: 'up' | 'down'
  /** line：一小步；page：一屏。 */
  unit: 'line' | 'page'
  /** 次数，实现会夹到 1..10。 */
  count: number
}

export interface ScrollOutcome extends PagePosition {
  moved: boolean
  atBoundary: boolean
  scrollValueBefore?: number
  scrollValueAfter?: number
}

export interface VisibleText {
  text: string
  truncated: boolean
}

export interface OpenOutcome {
  launched: true
  pid?: number
  /** openWith 只代表"已交给目标应用"，不代表文档已经打开 —— 要靠 findWindow 核验。 */
  verified: false
}

/** 前台窗口快照。刻意不含前台窗口标题：前台可能是用户的任何东西。 */
export interface ForegroundSnapshot {
  isTarget: boolean
  pid?: number
  /** 前台属于调用方自己（例如宠物窗口），可以把焦点交还目标窗口。 */
  isOwner?: boolean
  /** 前台是目标应用自己的弹窗。 */
  isDialogOfTarget?: boolean
}

export interface ActionEvidence {
  action: ActionName
  platform: DesktopPlatform | 'linux'
  /** 实际用的手段，例如 `uia-read`、`key:Right×3`、`osascript-ax`。 */
  method?: string
  before?: WindowIdentity
  after?: WindowIdentity
  foregroundBefore?: ForegroundSnapshot
  foregroundAfter?: ForegroundSnapshot
  pageBefore?: PagePosition
  /** 读回结果。跳页 / 滚动 / 读页都以它为准。 */
  readBack?: PagePosition & { scrollValue?: number; raw?: string }
  /** 逐步记录（每次按键后读回的页码等）。 */
  steps?: readonly string[]
  /** 实际执行的命令（openWith）。参数数组原样记录。 */
  command?: { command: string; args: readonly string[] }
  grantReason?: string
  elapsedMs?: number
}

export interface ActionError {
  code: ActionErrorCode
  message: string
  /** 更细的原因，例如 `app-closed` / `document-switched` / `focus-in-edit` / `no-movement`。 */
  detail?: string
  permission?: MacPermission
  /** 给用户看的引导文字（权限怎么开、该怎么做）。 */
  guidance?: string
  /** 建议的替代方案。 */
  fallback?: 'reading-view'
}

export type ActionResult<T> =
  | { ok: true; value: T; evidence: ActionEvidence }
  | { ok: false; error: ActionError; evidence: ActionEvidence }

export interface FocusOptions {
  /**
   * 调用方自己的进程（例如宠物 Electron 主进程）。前台属于它们时，允许把焦点交回目标窗口；
   * 前台是其他应用时一律不抢，返回 `focus-stolen`。
   */
  ownerPids?: readonly number[]
  /** 按哪个语义配置档核验文档（例如 WPS PDF 要求文档视图确实是这份文件）。 */
  profile?: SemanticProfile
}

/** 两平台共同实现的动作集合。 */
export interface DesktopActions {
  readonly platform: DesktopPlatform
  openWith(app: AppLaunchTarget, file: string): Promise<ActionResult<OpenOutcome>>
  findWindow(query: WindowQuery, options?: { profile?: SemanticProfile; documentName?: string }): Promise<ActionResult<WindowIdentity>>
  focus(identity: WindowIdentity, options?: FocusOptions): Promise<ActionResult<WindowIdentity>>
  readVisibleText(identity: WindowIdentity, grant: TextReadGrant, profile?: SemanticProfile): Promise<ActionResult<VisibleText>>
  /** 只读。`options.ownerPids` 只用于在证据里标注前台是不是调用方自己。 */
  readPage(identity: WindowIdentity, profile: SemanticProfile, options?: FocusOptions): Promise<ActionResult<PagePosition>>
  gotoPage(identity: WindowIdentity, page: number, profile: SemanticProfile, options?: FocusOptions): Promise<ActionResult<PagePosition>>
  scroll(identity: WindowIdentity, request: ScrollRequest, profile: SemanticProfile, options?: FocusOptions): Promise<ActionResult<ScrollOutcome>>
  /** 释放常驻辅助进程。 */
  dispose(): void
}

/**
 * 用哪个应用打开。`executable` 在 Windows 上是 exe 的绝对路径，在 macOS 上是 .app 的路径；
 * `args` 是放在文件路径之前的固定开关（例如 WPS 的 `/prometheus /pdf`），不含任何不可信内容。
 */
export interface AppLaunchTarget {
  executable: string
  args?: readonly string[]
  bundleId?: string
}

// ===== 结果构造 =====

export function ok<T>(value: T, evidence: ActionEvidence): ActionResult<T> {
  return { ok: true, value, evidence }
}

export function fail<T = never>(
  code: ActionErrorCode,
  message: string,
  evidence: ActionEvidence,
  extra: Omit<ActionError, 'code' | 'message'> = {},
): ActionResult<T> {
  return { ok: false, error: { code, message, ...extra }, evidence }
}

export function isActionErrorCode(value: unknown): value is ActionErrorCode {
  return typeof value === 'string' && (ACTION_ERROR_CODES as readonly string[]).includes(value)
}

// ===== 身份核对 =====

function samePath(a: string, b: string, platform: DesktopPlatform): boolean {
  // Windows 文件系统大小写不敏感；macOS 默认的 APFS 也不敏感，但路径来自同一来源，按原样比更严格。
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 两个身份是否指向同一个窗口里的同一份文档。
 *
 * 标题不要求完全相等（WPS 会在标题上加"已修改"之类的标记），但必须仍含文档名。
 * 返回不一致的字段名，空数组表示一致 —— 便于把"哪里变了"写进证据。
 */
export function identityMismatches(expected: WindowIdentity, actual: WindowIdentity): string[] {
  const out: string[] = []
  if (expected.platform !== actual.platform) out.push('platform')
  if (expected.pid !== actual.pid) out.push('pid')
  if (expected.windowId !== actual.windowId) out.push('windowId')
  if (!samePath(expected.processPath, actual.processPath, expected.platform)) out.push('processPath')
  if (expected.processStartedAt !== undefined && actual.processStartedAt !== undefined
    && expected.processStartedAt !== actual.processStartedAt) out.push('processStartedAt')
  if (expected.documentName !== undefined && !titleHasDocument(actual.title, expected.documentName, expected.platform)) out.push('title')
  if (expected.documentPath !== undefined && actual.documentPath !== undefined
    && !samePath(expected.documentPath, actual.documentPath, expected.platform)) out.push('documentPath')
  return out
}

export function sameIdentity(expected: WindowIdentity, actual: WindowIdentity): boolean {
  return identityMismatches(expected, actual).length === 0
}

/** 标题是否含文档名。Windows 不区分大小写（WPS 标题与文件系统一致）。 */
export function titleHasDocument(title: string, documentName: string, platform: DesktopPlatform): boolean {
  if (documentName === '') return false
  return platform === 'win32'
    ? title.toLowerCase().includes(documentName.toLowerCase())
    : title.includes(documentName)
}

/** 进程路径是否在某个安装目录下（含子目录）。用于"组件进程属于这份 WPS 安装"。 */
export function pathIsUnder(file: string, dir: string, platform: DesktopPlatform): boolean {
  const sep = platform === 'win32' ? '\\' : '/'
  const norm = (value: string) => {
    let v = platform === 'win32' ? value.replace(/\//g, '\\').toLowerCase() : value
    while (v.length > 1 && v.endsWith(sep)) v = v.slice(0, -1)
    return v
  }
  const f = norm(file)
  const d = norm(dir)
  return d !== '' && f.startsWith(d + sep)
}

// ===== 讲解同步要用的归类 =====

/** 讲解为什么该暂停。由主进程转成界面提示。 */
export type PauseReason =
  | 'focus-lost' | 'dialog' | 'closed' | 'document-switched' | 'unsupported'
  | 'permission' | 'ambiguous' | 'error'

/**
 * 把动作失败归成讲解层面的暂停原因。任何失败都意味着"此刻不能认为 WPS 与讲解同步"。
 */
export function pauseReasonOf(error: ActionError): PauseReason {
  switch (error.code) {
    case 'focus-stolen': return 'focus-lost'
    case 'dialog-blocking': return 'dialog'
    case 'window-not-found': return 'closed'
    case 'identity-changed': return 'document-switched'
    case 'unsupported': return 'unsupported'
    case 'not-installed': return 'unsupported'
    case 'permission-denied': return 'permission'
    case 'ambiguous-window': return 'ambiguous'
    default: return 'error'
  }
}

/** 页码是否合法（1..total 的整数）。 */
export function validPage(page: number, total?: number): boolean {
  return Number.isInteger(page) && page >= 1 && (total === undefined || page <= total)
}

/**
 * 解析 "3/12"、"3 / 12"、"第 3 页 / 共 12 页" 这类页码文字。解析不了返回 null（不猜）。
 */
export function parsePageLabel(raw: string): PagePosition | null {
  const text = raw.replace(/\s+/g, '')
  const m = /^(?:第)?(\d{1,6})(?:页)?\/(?:共)?(\d{1,6})(?:页)?$/.exec(text)
  if (!m) return null
  const page = Number(m[1])
  const total = Number(m[2])
  if (total < 1 || page < 1 || page > total) return null
  return { page, total }
}
