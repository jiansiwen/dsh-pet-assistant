/**
 * WPS 指定打开与讲解同步：定位安装 → 用 WPS 打开 → 核验窗口与文档身份 → 读页 / 跳页 / 滚动。
 *
 * 按平台分派到 `win-actions.ts` 或 `mac-actions.ts`，两边共用 `desktop-actions.ts` 的契约。
 *
 * 几条不能退让的规则：
 * - **不依赖默认 PDF 关联**。Windows 按 App Paths 与安装登记找 wps.exe，macOS 按 bundle id 与应用名。
 * - **身份核验**：窗口所属进程必须在这份 WPS 的安装目录下，窗口标题必须含目标文件名；
 *   PDF 还要求文档视图本身就是这份文件。
 * - **不静默降级**。页码读不到、按键无效时返回 `unsupported` 并建议阅读视图，
 *   不会改用别的办法（例如系统默认关联、模拟点击坐标）然后报告"WPS 成功"。
 * - **失焦 / 弹窗 / WPS 关闭** 都给出明确的暂停原因（`status` / `syncTo`），由主进程暂停讲解。
 *
 * macOS 部分**未在 Mac 真机验证**，见 petsBak/dsh-pet/mac-verification-actions-wps.md。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  fail,
  ok,
  pauseReasonOf,
  validPage,
  type ActionError,
  type ActionEvidence,
  type ActionResult,
  type DesktopActions,
  type DesktopPlatform,
  type FocusOptions,
  type ForegroundSnapshot,
  type PagePosition,
  type PauseReason,
  type ScrollOutcome,
  type ScrollRequest,
  type SemanticProfile,
  type WindowIdentity,
  type WindowQuery,
} from './desktop-actions.ts'
import { createMacActions, type MacAppCandidate, type MacDesktopActions } from './mac-actions.ts'
import { platformOf, supportsWpsControl } from './platform.ts'
import { createWinActions, type RegistryCandidate, type WinDesktopActions } from './win-actions.ts'

/**
 * WPS Mac 的 bundle id。`com.kingsoft.wpsoffice.mac` 已由金山官方帮助页的沙盒容器路径
 * （~/Library/Containers/com.kingsoft.wpsoffice.mac）核实，国内版与国际版相同；
 * 第二个是保守的候选，未核实，只在第一个找不到时才试。
 */
export const WPS_MAC_BUNDLE_IDS: readonly string[] = ['com.kingsoft.wpsoffice.mac', 'com.kingsoft.wpsoffice.mac.global']
/** 应用名候选（/Applications/wpsoffice.app 等）。按名字找到后还要核对 bundle id 前缀。 */
export const WPS_MAC_APP_NAMES: readonly string[] = ['wpsoffice', 'WPS Office']

export interface WpsInstall {
  platform: DesktopPlatform
  /** Windows：wps.exe 绝对路径；macOS：.app 路径。 */
  executable: string
  /** 进程路径必须落在这个目录下才算"属于这份 WPS 安装"。 */
  installDir: string
  source: string
  version?: string
  bundleId?: string
}

// ===== 定位（纯函数，可用注册表结果替身测试）=====

const WIN_VERSION_RE = /\\(\d+\.\d+\.\d+\.\d+)\\/

/**
 * 从注册表登记里选出 wps.exe。顺序：App Paths（wps → wpp → et，它们在 WPS 12 都指向 wps.exe）→
 * Kingsoft InstallRoot → 卸载项（DisplayIcon 所在目录 + 版本号）。每个候选都要求文件真的存在。
 */
export function resolveWpsInstallWin(
  candidates: readonly RegistryCandidate[],
  exists: (file: string) => boolean,
): WpsInstall | null {
  const tried = new Set<string>()
  const pick = (exe: string, source: string, version?: string): WpsInstall | null => {
    const file = path.win32.normalize(exe.trim().replace(/^"+|"+$/g, ''))
    if (!/^[A-Za-z]:\\|^\\\\/.test(file)) return null
    if (path.win32.basename(file).toLowerCase() !== 'wps.exe') return null
    const key = file.toLowerCase()
    if (tried.has(key)) return null
    tried.add(key)
    if (!exists(file)) return null
    return {
      platform: 'win32',
      executable: file,
      installDir: path.win32.dirname(file),
      source,
      version: version ?? WIN_VERSION_RE.exec(file)?.[1],
    }
  }
  const order = ['wps.exe', 'wpp.exe', 'et.exe']
  for (const name of order) {
    for (const c of candidates) {
      if (c.source !== 'app-paths' || c.name.toLowerCase() !== name) continue
      const hit = pick(c.value, `app-paths:${c.key}`)
      if (hit) return hit
    }
  }
  for (const c of candidates) {
    if (c.source !== 'kingsoft-common') continue
    const hit = pick(path.win32.join(c.value, 'office6', 'wps.exe'), `install-root:${c.key}`)
    if (hit) return hit
  }
  for (const c of candidates) {
    if (c.source !== 'uninstall') continue
    const roots = [c.installLocation, c.value ? path.win32.dirname(c.value) : undefined].filter((v): v is string => !!v)
    for (const root of roots) {
      if (c.version) {
        const hit = pick(path.win32.join(root, c.version, 'office6', 'wps.exe'), `uninstall:${c.key}`, c.version)
        if (hit) return hit
      }
      const flat = pick(path.win32.join(root, 'office6', 'wps.exe'), `uninstall:${c.key}`, c.version)
      if (flat) return flat
    }
  }
  return null
}

/** macOS：先按 bundle id；按名字找到的必须 bundle id 以 com.kingsoft. 开头才认。 */
export function resolveWpsInstallMac(candidates: readonly MacAppCandidate[]): WpsInstall | null {
  for (const id of WPS_MAC_BUNDLE_IDS) {
    const hit = candidates.find(c => c.via === 'bundle-id' && c.bundleId === id && c.path.startsWith('/'))
    if (hit) return { platform: 'darwin', executable: hit.path, installDir: hit.path, source: `bundle-id:${id}`, bundleId: hit.bundleId, version: hit.version }
  }
  for (const c of candidates) {
    if (c.via !== 'name' || !c.path.startsWith('/') || !c.bundleId?.startsWith('com.kingsoft.')) continue
    return { platform: 'darwin', executable: c.path, installDir: c.path, source: `app-name:${c.name ?? ''}`, bundleId: c.bundleId, version: c.version }
  }
  return null
}

/**
 * WPS 打开某个文件时放在文件路径之前的开关。PDF 用 WPS 自己登记的 `/prometheus /pdf`
 * （与 KWPS.PDF.9 的 open 命令一致，本机注册表已核对），其余类型交给 wps.exe 自己分派。
 */
export function wpsLaunchArgs(platform: DesktopPlatform, file: string): readonly string[] {
  if (platform === 'win32' && path.win32.extname(file).toLowerCase() === '.pdf') return ['/prometheus', '/pdf']
  return []
}

/** 哪些文件有语义定位（页码读写）。只有 PDF 经过真机验证。 */
export function semanticProfileFor(file: string): SemanticProfile | null {
  return /\.pdf$/i.test(file) ? 'wps-pdf' : null
}

// ===== 会话与同步状态 =====

export interface WpsSession {
  platform: DesktopPlatform
  install: WpsInstall
  file: string
  documentName: string
  identity: WindowIdentity
  /** null 表示这种文件只能打开、不能同步页码。 */
  profile: SemanticProfile | null
  /** 打开后首次读回的页码；读不到时为 undefined（此时同步不可用）。 */
  position?: PagePosition
}

export type WpsSyncStatus =
  | { state: 'in-sync'; position: PagePosition; foreground?: ForegroundSnapshot; evidence: ActionEvidence }
  | { state: 'paused'; reason: PauseReason; error: ActionError; evidence: ActionEvidence }

export interface WpsController {
  readonly platform: DesktopPlatform | 'linux'
  /** 是否只做过命令规格测试、未在真机验证（macOS 为 true）。界面据此标注"实验性"。 */
  readonly unverifiedOnDevice: boolean
  locate(): Promise<ActionResult<WpsInstall>>
  open(file: string, options?: { waitMs?: number }): Promise<ActionResult<WpsSession>>
  focus(session: WpsSession): Promise<ActionResult<WindowIdentity>>
  readPage(session: WpsSession): Promise<ActionResult<PagePosition>>
  gotoPage(session: WpsSession, page: number): Promise<ActionResult<PagePosition>>
  scroll(session: WpsSession, request: ScrollRequest): Promise<ActionResult<ScrollOutcome>>
  /** 不动作，只看"现在能不能继续同步讲解"。 */
  status(session: WpsSession): Promise<WpsSyncStatus>
  /** 讲解推进到第 N 页时调用：跳页并给出同步状态。失败时 state 为 paused。 */
  /**
   * 跳到第 page 页。`expectText` 是这一段的原文：给了就拿跳页后读回的文字做一次比对，
   * 对不上不返回 in-sync（见 `matchesPageText`）。
   */
  syncTo(session: WpsSession, page: number, expectText?: string): Promise<WpsSyncStatus>
  dispose(): void
}

export interface WpsControllerOptions {
  platform?: string
  /** 辅助脚本所在目录（win-uia.ps1），打包后是 dist/main。 */
  scriptDir: string
  /** 调用方自己的进程（宠物主进程 pid）。前台属于它们时允许把焦点交回 WPS。 */
  ownerPids?: readonly number[]
  /** 测试注入。 */
  win?: WinDesktopActions
  mac?: MacDesktopActions
  exists?: (file: string) => boolean
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// 可用性探测缓存
//
// 探测要拉起辅助进程（首次约 8 秒），所以结果必须缓存，否则每次讲解都要等一次启动。
// 但**成功和失败不能共用一个有效期**：
// 用户的典型顺序是"先开桌宠、再开 WPS"。桌宠启动那一刻探测失败，如果把"不可用"也缓存
// 10 分钟，用户打开 WPS 之后这十分钟里每次讲解都会报"没在注册表里找到可用的 WPS" ——
// 真机上就是这么撞的。所以失败只做一个几秒的抖动窗口（防同一秒内连续拉起辅助进程），
// 过期立刻重探；成功才长期缓存。
// ---------------------------------------------------------------------------

/** 探测成功后的复用时长：10 分钟。 */
export const WPS_PROBE_TTL_MS = 10 * 60_000
/** 探测失败后的复用时长：只防抖，不做结论。 */
export const WPS_PROBE_FAIL_TTL_MS = 3_000

export interface WpsProbeCache {
  readonly at: number
  readonly available: boolean
  /** 这次结论是"探测失败/抛异常"兜出来的，还是真的问到了。两者过期策略不同。 */
  readonly failed: boolean
}

/**
 * 读缓存：有效就返回结论，失效返回 `null`（调用方去重探）。
 *
 * 纯函数（时间由调用方给），因为"失败只缓存 3 秒"这条规则没法在真机上稳定复现。
 */
export function cachedWpsProbe(cache: WpsProbeCache | null, now: number): boolean | null {
  if (cache === null) return null
  const ttl = cache.failed ? WPS_PROBE_FAIL_TTL_MS : WPS_PROBE_TTL_MS
  return now - cache.at < ttl ? cache.available : null
}

/**
 * 记一次探测结果。`located` 为 `null` 表示探测本身抛了异常（等同于失败，但同样只缓存 3 秒）。
 *
 * 失败时**不保留旧的可用结论**：上次成功说明那时装了 WPS，这次问不到说明现在有问题
 * （被卸载、辅助进程挂了），保守报"暂不可用"并让调用方 3 秒后重探，比抱着旧的成功
 * 结论去拉起一个不存在的进程要好。
 */
export function nextWpsProbe(located: { ok: boolean } | null, now: number): WpsProbeCache {
  const available = located?.ok === true
  return { at: now, available, failed: !available }
}


/** 打开后轮询找窗口时，哪些失败值得继续等（WPS 还在加载 / 标签还没切过来）。 */
const RETRY_WHILE_OPENING = new Set(['window-not-found', 'identity-changed'])

/** 比对时只看"非空白字符"：PDF 提起的文字会带换行、右边界断行，空格位置完全不可信。 */
const squeeze = (text: string): string => text.replace(/\s+/gu, '')

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 这一段拿去做比对的"针"。太短（<8 个非空白字符）就不比 —— 三个字能命中任何一页。 */
function needleOf(expectText: string | undefined): string | null {
  if (expectText === undefined) return null
  const squeezed = squeeze(expectText)
  return squeezed.length >= 8 ? squeezed : null
}

/**
 * 读回的文字里有没有这一段原文。
 *
 * 规则（按 lead 的要求）：先取该段前 20 个非空白字符，找不到再放宽到 12 个。
 *
 * **口径要说清**：`pageText` 在 WPS 12.x 上是 Ctrl+A 抓的整份文档，不是当前页。所以"命中"
 * 只能证明"这份文档里有这一段"，**不能**证明"现在停在第 N 页"；页码本身由 Ctrl+G 的绝对
 * 跳转保证。"未命中"则是硬证据：这份文档里根本没有这段原文（拿错文件/换了文件），必须停。
 */
export function matchesPageText(pageText: string, expectText: string): boolean {
  const hay = squeeze(pageText)
  const needle = squeeze(expectText)
  if (hay === '' || needle === '') return false
  for (const length of [20, 12]) {
    const probe = needle.slice(0, length)
    if (probe.length >= 8 && hay.includes(probe)) return true
  }
  return false
}

export function createWpsController(options: WpsControllerOptions): WpsController {
  const platform = platformOf(options.platform ?? process.platform)
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const exists = options.exists ?? existsSync
  const focusOpts = (profile?: SemanticProfile | null): FocusOptions => ({ ownerPids: options.ownerPids ?? [], profile: profile ?? undefined })

  if (!supportsWpsControl(platform) || (platform !== 'win32' && platform !== 'darwin')) {
    return unsupportedController(platform)
  }

  let win = options.win ?? null
  let mac = options.mac ?? null
  const actions = (): DesktopActions => {
    if (platform === 'win32') return (win ??= createWinActions({ scriptDir: options.scriptDir }))
    return (mac ??= createMacActions({}))
  }

  async function locate(): Promise<ActionResult<WpsInstall>> {
    const base: ActionEvidence = { action: 'locate', platform }
    if (platform === 'win32') {
      const a = actions() as WinDesktopActions
      // 注册表可能指向另一个已安装版本，而单实例 WPS 会把新进程交接给正在运行的版本。
      // 优先按"正在运行的进程"认安装目录，启动与窗口身份才一致；没在运行再查注册表。
      const running = await a.runningWpsPaths()
      if (running.ok) {
        const order = ['wps.exe', 'wpp.exe', 'et.exe', 'wpspdf.exe']
        const sorted = [...running.value].sort((x, y) =>
          order.indexOf(path.win32.basename(x).toLowerCase()) - order.indexOf(path.win32.basename(y).toLowerCase()))
        for (const raw of sorted) {
          const file = path.win32.normalize(raw.trim().replace(/^"+|"+$/g, ''))
          if (!order.includes(path.win32.basename(file).toLowerCase()) || !exists(file)) continue
          const install: WpsInstall = {
            platform: 'win32', executable: file, installDir: path.win32.dirname(file),
            source: 'running-process', version: WIN_VERSION_RE.exec(file)?.[1],
          }
          return ok(install, { ...base, method: install.source })
        }
      }
      const reg = await a.readWpsRegistry()
      if (!reg.ok) return reg
      const install = resolveWpsInstallWin(reg.value, exists)
      if (install === null) return fail('not-installed', '没有在注册表登记里找到可用的 WPS（wps.exe）', base)
      return ok(install, { ...base, method: install.source })
    }
    const a = actions() as MacDesktopActions
    const found = await a.locateApps(WPS_MAC_BUNDLE_IDS, WPS_MAC_APP_NAMES)
    if (!found.ok) return found
    const install = resolveWpsInstallMac(found.value)
    if (install === null) return fail('not-installed', '没有找到 WPS Office for Mac', base)
    return ok(install, { ...base, method: install.source })
  }

  function queryFor(install: WpsInstall, documentName: string): WindowQuery {
    return platform === 'win32'
      ? { processDir: install.installDir, titleIncludes: documentName }
      : { bundleId: install.bundleId, processDir: install.installDir, titleIncludes: documentName }
  }

  function needProfile<T>(session: WpsSession, action: ActionEvidence['action']): ActionResult<T> | null {
    if (session.profile !== null) return null
    return fail('unsupported', '这种文件在 WPS 里没有可靠的页码控制，请改用阅读视图', { action, platform }, { fallback: 'reading-view' })
  }

  async function status(session: WpsSession): Promise<WpsSyncStatus> {
    const guard = needProfile<PagePosition>(session, 'verify')
    if (guard && !guard.ok) return { state: 'paused', reason: 'unsupported', error: guard.error, evidence: guard.evidence }
    const r = await actions().readPage(session.identity, session.profile!, focusOpts(session.profile))
    if (!r.ok) return { state: 'paused', reason: pauseReasonOf(r.error), error: r.error, evidence: r.evidence }
    const fg = r.evidence.foregroundBefore
    if (fg && !fg.isTarget) {
      if (fg.isDialogOfTarget) {
        const error: ActionError = { code: 'dialog-blocking', message: 'WPS 有弹窗在前台', detail: 'foreground-dialog' }
        return { state: 'paused', reason: 'dialog', error, evidence: r.evidence }
      }
      if (!fg.isOwner) {
        const error: ActionError = { code: 'focus-stolen', message: '前台已切到其他应用', detail: 'foreground-other' }
        return { state: 'paused', reason: 'focus-lost', error, evidence: r.evidence }
      }
    }
    return { state: 'in-sync', position: r.value, foreground: fg, evidence: r.evidence }
  }

  async function gotoPage(session: WpsSession, page: number): Promise<ActionResult<PagePosition>> {
    const guard = needProfile<PagePosition>(session, 'gotoPage')
    if (guard) return guard
    if (!validPage(page)) return fail('invalid-argument', '页码必须是正整数', { action: 'gotoPage', platform })
    return actions().gotoPage(session.identity, page, session.profile!, focusOpts(session.profile))
  }

  return {
    platform,
    unverifiedOnDevice: platform === 'darwin',
    locate,

    async open(file, opts = {}) {
      const base: ActionEvidence = { action: 'openWith', platform }
      const p = platform === 'win32' ? path.win32 : path.posix
      if (!p.isAbsolute(file)) return fail('invalid-argument', '文件路径必须是绝对路径', base)
      const target = p.normalize(file)
      const located = await locate()
      if (!located.ok) return located
      const install = located.value
      const documentName = p.basename(target)
      const profile = semanticProfileFor(target)
      const opened = await actions().openWith(
        { executable: install.executable, args: wpsLaunchArgs(platform, target), bundleId: install.bundleId },
        target,
      )
      if (!opened.ok) return opened
      const steps: string[] = [`launched pid=${opened.value.pid ?? '?'}`]
      const deadline = now() + (opts.waitMs ?? 25_000)
      let identity: WindowIdentity | undefined
      let last: ActionResult<WindowIdentity> | undefined
      while (now() < deadline) {
        await sleep(700)
        const found = await actions().findWindow(queryFor(install, documentName), { profile: profile ?? undefined, documentName })
        if (found.ok) { identity = found.value; break }
        last = found
        steps.push(`find:${found.error.code}${found.error.detail ? `/${found.error.detail}` : ''}`)
        if (!RETRY_WHILE_OPENING.has(found.error.code)) {
          return { ok: false, error: found.error, evidence: { ...found.evidence, command: opened.evidence.command, steps } }
        }
      }
      if (identity === undefined) {
        const evidence: ActionEvidence = { ...base, command: opened.evidence.command, steps }
        return fail('window-not-found', '已交给 WPS 打开，但在等待时间内没有出现这份文档的窗口', evidence,
          { detail: last && !last.ok ? last.error.detail : undefined })
      }
      const session: WpsSession = { platform, install, file: target, documentName, identity, profile }
      const evidence: ActionEvidence = { ...base, command: opened.evidence.command, after: identity, steps }
      if (profile !== null) {
        const page = await actions().readPage(identity, profile, focusOpts(profile))
        if (page.ok) {
          session.position = page.value
          evidence.readBack = { ...page.value }
        } else {
          steps.push(`read-page:${page.error.code}`)
        }
      }
      return ok(session, evidence)
    },

    async focus(session) {
      return actions().focus(session.identity, focusOpts(session.profile))
    },

    async readPage(session) {
      return needProfile<PagePosition>(session, 'readPage') ?? actions().readPage(session.identity, session.profile!, focusOpts(session.profile))
    },

    async gotoPage(session, page) {
      return gotoPage(session, page)
    },

    async scroll(session, request) {
      return needProfile<ScrollOutcome>(session, 'scroll') ?? actions().scroll(session.identity, request, session.profile!, focusOpts(session.profile))
    },

    status,

    async syncTo(session, page, expectText) {
      const r = await gotoPage(session, page)
      if (!r.ok) return { state: 'paused', reason: pauseReasonOf(r.error), error: r.error, evidence: r.evidence }
      const readBack = r.value.pageText
      const needle = needleOf(expectText)
      if (needle !== null && readBack !== undefined) {
        const hit = matchesPageText(readBack, expectText ?? '')
        // 每次跳页都留一行证据：目标页、读回文本前 40 字、是否匹配。
        console.log(`[dsh-pet] WPS 跳页 page=${page} 读回「${clip(readBack, 40)}」${hit ? '命中' : '未命中'}本段原文`)
        if (!hit) {
          const error: ActionError = {
            code: 'unsupported',
            detail: 'page-mismatch',
            message: `WPS 没跳到第 ${page} 页（读回的内容里找不到这一段原文）`,
            guidance: '把 WPS 切到前台、确认显示的是这份文档；讲解可以从这一段重新开始',
          }
          return { state: 'paused', reason: 'error', error, evidence: r.evidence }
        }
        return { state: 'in-sync', position: r.value, foreground: r.evidence.foregroundAfter, evidence: r.evidence }
      }
      if (needle !== null && readBack === undefined) {
        console.log(`[dsh-pet] WPS 跳页 page=${page}：读回文本不可用，无原文可比（绝对跳转已由 Ctrl+G 完成）`)
      }
      return { state: 'in-sync', position: r.value, foreground: r.evidence.foregroundAfter, evidence: r.evidence }
    },

    dispose() {
      win?.dispose()
      mac?.dispose()
    },
  }
}

function unsupportedController(platform: DesktopPlatform | 'linux'): WpsController {
  const evidence = (action: ActionEvidence['action']): ActionEvidence => ({ action, platform })
  const no = <T>(action: ActionEvidence['action']): Promise<ActionResult<T>> =>
    Promise.resolve(fail<T>('unsupported', '这个平台没有实现 WPS 控制，请改用阅读视图', evidence(action), { fallback: 'reading-view' }))
  const paused = async (): Promise<WpsSyncStatus> => ({
    state: 'paused', reason: 'unsupported',
    error: { code: 'unsupported', message: '这个平台没有实现 WPS 控制', fallback: 'reading-view' },
    evidence: evidence('verify'),
  })
  return {
    platform,
    unverifiedOnDevice: true,
    locate: () => no('locate'),
    open: () => no('openWith'),
    focus: () => no('focus'),
    readPage: () => no('readPage'),
    gotoPage: () => no('gotoPage'),
    scroll: () => no('scroll'),
    status: paused,
    syncTo: paused,
    dispose() { /* 无资源 */ },
  }
}
