/**
 * Windows 实现：`desktop-actions.ts` 契约 → `win-uia.ps1`（UI Automation + 少量 Win32）。
 *
 * 辅助脚本是**常驻进程**：PowerShell 冷启动加编译 Win32 声明要 5～8 秒，每次翻页都重开一个
 * 根本跟不上讲解。这里懒启动一个、串行发请求、空闲一段时间后自己退出；超时就结束它，下次重开。
 *
 * 这一层还做第二道核对（辅助脚本已做过第一道）：
 * - 辅助脚本说"成功"，但回传的执行前后身份与调用方给的对不上 → `identity-changed`；
 * - 动作后前台已不是目标窗口 → `focus-stolen`；
 * - 跳页后读回的页码不等于目标页 → `failed`。
 * 也就是说，命令执行成功从来不被直接当成目标达成。
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  fail,
  identityMismatches,
  isActionErrorCode,
  ok,
  pathIsUnder,
  validPage,
  type ActionError,
  type ActionEvidence,
  type ActionName,
  type ActionResult,
  type AppLaunchTarget,
  type DesktopActions,
  type FocusOptions,
  type ForegroundSnapshot,
  type OpenOutcome,
  type PagePosition,
  type ScrollOutcome,
  type ScrollRequest,
  type SemanticProfile,
  type TextReadGrant,
  type VisibleText,
  type WindowIdentity,
  type WindowQuery,
} from './desktop-actions.ts'
import { openWithSpecifiedApp, type OpenWithAppDeps } from './doc-fs.ts'
import { winUiaHelperSpec, type CommandSpec } from './platform.ts'

// ===== 线协议 =====

export type HelperRequest = { op: string } & Record<string, unknown>
export type HelperResponse = Record<string, unknown>

/** 一条请求编码成一行：base64(UTF-8 JSON)。中文、空格、引号都在 base64 里，命令行与管道编码无关。 */
export function encodeHelperRequest(request: HelperRequest): string {
  return Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
}

/** 解一行响应。不是 `DSH:` 开头或解不开就返回 null（PowerShell 偶尔会往 stdout 打别的东西）。 */
export function decodeHelperLine(line: string): HelperResponse | null {
  const text = line.trim()
  if (!text.startsWith('DSH:')) return null
  try {
    const value: unknown = JSON.parse(Buffer.from(text.slice(4), 'base64').toString('utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as HelperResponse : null
  } catch {
    return null
  }
}

export class HelperTimeoutError extends Error {
  constructor() { super('辅助进程超时') }
}

export interface HelperTransport {
  request(request: HelperRequest, timeoutMs: number): Promise<HelperResponse>
  dispose(): void
}

type SpawnHelper = (spec: CommandSpec) => ChildProcessWithoutNullStreams

const defaultSpawnHelper: SpawnHelper = spec =>
  nodeSpawn(spec.command, [...spec.args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })

export interface HelperProcessOptions {
  spawn?: SpawnHelper
  /** 冷启动额外宽限（加载 UIA 与编译 Win32 声明）。 */
  startupGraceMs?: number
  /** 空闲多久后结束常驻进程。 */
  idleMs?: number
}

/**
 * 常驻辅助进程。请求严格串行：UIA 与按键都作用在同一个目标窗口上，并发只会互相打架。
 */
export function createHelperProcess(spec: CommandSpec, options: HelperProcessOptions = {}): HelperTransport {
  const spawnHelper = options.spawn ?? defaultSpawnHelper
  const startupGraceMs = options.startupGraceMs ?? 15_000
  const idleMs = options.idleMs ?? 120_000
  let child: ChildProcessWithoutNullStreams | null = null
  let fresh = false
  let buffer = ''
  let nextId = 1
  let chain: Promise<unknown> = Promise.resolve()
  let idleTimer: NodeJS.Timeout | null = null
  let pending: { id: number; resolve: (r: HelperResponse) => void; reject: (e: Error) => void } | null = null

  const kill = () => {
    if (child !== null) {
      try { child.kill() } catch { /* 已退出 */ }
      child = null
    }
    buffer = ''
  }

  const ensure = (): ChildProcessWithoutNullStreams => {
    if (child !== null) return child
    const proc = spawnHelper(spec)
    fresh = true
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const response = decodeHelperLine(line)
        if (response === null || pending === null) continue
        if (response.id !== pending.id) continue
        const p = pending
        pending = null
        p.resolve(response)
      }
    })
    proc.stderr.on('data', () => { /* 诊断输出不进协议 */ })
    const onGone = (error?: Error) => {
      if (child === proc) child = null
      if (pending !== null) {
        const p = pending
        pending = null
        p.reject(error ?? new Error('辅助进程已退出'))
      }
    }
    proc.on('error', onGone)
    proc.on('exit', () => onGone())
    child = proc
    return proc
  }

  const run = (request: HelperRequest, timeoutMs: number): Promise<HelperResponse> => new Promise((resolve, reject) => {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
    let proc: ChildProcessWithoutNullStreams
    try { proc = ensure() } catch (error) { reject(error as Error); return }
    const id = nextId++
    const budget = timeoutMs + (fresh ? startupGraceMs : 0) + 3_000
    fresh = false
    const timer = setTimeout(() => {
      if (pending?.id !== id) return
      pending = null
      kill()
      reject(new HelperTimeoutError())
    }, budget)
    pending = {
      id,
      resolve: r => { clearTimeout(timer); resolve(r) },
      reject: e => { clearTimeout(timer); reject(e) },
    }
    proc.stdin.write(`${encodeHelperRequest({ ...request, id, timeoutMs })}\n`)
  })

  return {
    request(request, timeoutMs) {
      const next = chain.then(() => run(request, timeoutMs))
      chain = next.catch(() => undefined).then(() => {
        if (idleTimer !== null) clearTimeout(idleTimer)
        idleTimer = setTimeout(kill, idleMs)
        idleTimer.unref?.()
      })
      return next
    },
    dispose() {
      if (idleTimer !== null) clearTimeout(idleTimer)
      kill()
    },
  }
}

// ===== 响应解析（不信任辅助脚本的输出形状）=====

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 严格解析身份：缺任何一个必需字段都当作没有。 */
export function parseWinIdentity(value: unknown): WindowIdentity | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const pid = asNumber(v.pid)
  const windowId = asString(v.windowId)
  const title = asString(v.title)
  const processPath = asString(v.processPath)
  if (pid === undefined || windowId === undefined || title === undefined || processPath === undefined) return undefined
  if (!/^\d+$/.test(windowId)) return undefined
  const identity: WindowIdentity = { platform: 'win32', pid, windowId, title, processPath }
  const started = asString(v.processStartedAt)
  if (started) identity.processStartedAt = started
  const cls = asString(v.className)
  if (cls) identity.className = cls
  const doc = asString(v.documentName)
  if (doc) identity.documentName = doc
  const comp = v.component as Record<string, unknown> | undefined
  if (comp && typeof comp === 'object') {
    const cpid = asNumber(comp.pid)
    const cpath = asString(comp.processPath)
    if (cpid !== undefined && cpath !== undefined) identity.component = { pid: cpid, processPath: cpath, windowId: asString(comp.windowId) }
  }
  return identity
}

function parseForeground(value: unknown): ForegroundSnapshot | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (typeof v.isTarget !== 'boolean') return undefined
  const snap: ForegroundSnapshot = { isTarget: v.isTarget }
  const pid = asNumber(v.pid)
  if (pid !== undefined) snap.pid = pid
  if (typeof v.isOwner === 'boolean') snap.isOwner = v.isOwner
  if (typeof v.isDialogOfTarget === 'boolean') snap.isDialogOfTarget = v.isDialogOfTarget
  return snap
}

function parsePosition(v: Record<string, unknown>): PagePosition | undefined {
  const page = asNumber(v.page)
  const total = asNumber(v.total)
  if (page === undefined || total === undefined || !validPage(page, total)) return undefined
  return { page, total }
}

export function evidenceFromHelper(action: ActionName, resp: HelperResponse): ActionEvidence {
  const evidence: ActionEvidence = { action, platform: 'win32' }
  const method = asString(resp.method)
  if (method) evidence.method = method
  const before = parseWinIdentity(resp.before) ?? parseWinIdentity(resp.identity)
  if (before) evidence.before = before
  const after = parseWinIdentity(resp.after)
  if (after) evidence.after = after
  const fb = parseForeground(resp.foregroundBefore)
  if (fb) evidence.foregroundBefore = fb
  const fa = parseForeground(resp.foregroundAfter)
  if (fa) evidence.foregroundAfter = fa
  const pb = resp.pageBefore && typeof resp.pageBefore === 'object' ? parsePosition(resp.pageBefore as Record<string, unknown>) : undefined
  if (pb) evidence.pageBefore = pb
  const pos = parsePosition(resp)
  if (pos) {
    evidence.readBack = { ...pos }
    const sv = asNumber(resp.scrollValue)
    if (sv !== undefined) evidence.readBack.scrollValue = sv
    const raw = asString(resp.raw)
    if (raw !== undefined) evidence.readBack.raw = raw
  }
  if (Array.isArray(resp.steps)) evidence.steps = resp.steps.filter((s): s is string => typeof s === 'string')
  const ms = asNumber(resp.elapsedMs)
  if (ms !== undefined) evidence.elapsedMs = ms
  return evidence
}

function helperError(resp: HelperResponse): ActionError {
  const code = isActionErrorCode(resp.code) ? resp.code : 'failed'
  const error: ActionError = { code, message: asString(resp.message) ?? '辅助脚本未说明原因' }
  const detail = asString(resp.detail)
  if (detail) error.detail = detail
  if (code === 'unsupported') error.fallback = 'reading-view'
  return error
}

/**
 * 辅助脚本说成功之后的第二道核对。返回 null 表示通过。
 * `requireForegroundAfter`：会改变目标状态的动作（翻页、滚动、聚焦）要求动作后前台仍是目标。
 */
export function crossCheck(
  expected: WindowIdentity | undefined,
  evidence: ActionEvidence,
  requireForegroundAfter: boolean,
): ActionError | null {
  if (expected !== undefined) {
    for (const [label, seen] of [['执行前', evidence.before], ['执行后', evidence.after]] as const) {
      if (seen === undefined) continue
      const diff = identityMismatches(expected, seen)
      if (diff.length > 0) return { code: 'identity-changed', message: `${label}的窗口身份与目标不一致`, detail: diff.join(',') }
    }
  }
  if (requireForegroundAfter) {
    if (evidence.foregroundAfter === undefined) return { code: 'failed', message: '辅助脚本没有回传动作后的前台状态' }
    if (!evidence.foregroundAfter.isTarget) {
      return evidence.foregroundAfter.isDialogOfTarget
        ? { code: 'dialog-blocking', message: '动作后目标应用弹出了窗口', detail: 'dialog-after' }
        : { code: 'focus-stolen', message: '动作后前台已不是目标窗口', detail: 'foreground-lost-after' }
    }
  }
  return null
}

// ===== 动作实现 =====

export interface WinActionsOptions {
  /** win-uia.ps1 所在目录（打包后是 dist/main）。 */
  scriptDir: string
  transport?: HelperTransport
  openDeps?: OpenWithAppDeps
  /** 单个请求的时间上限。 */
  timeoutMs?: number
}

/** WPS 注册表登记的原始结果，交给 wps-control 解析。 */
export interface RegistryCandidate {
  source: 'app-paths' | 'kingsoft-common' | 'uninstall'
  key: string
  name: string
  value: string
  version?: string
  installLocation?: string
}

export interface WinDesktopActions extends DesktopActions {
  readonly platform: 'win32'
  /** 读 WPS 的安装登记（App Paths / Kingsoft InstallRoot / 卸载项）。 */
  readWpsRegistry(): Promise<ActionResult<RegistryCandidate[]>>
  /** 只核对身份与弹窗，不动作。讲解同步用它判断"现在还能不能继续"。 */
  verify(identity: WindowIdentity, profile?: SemanticProfile, options?: FocusOptions): Promise<ActionResult<WindowIdentity & { position?: PagePosition }>>
  /**
   * 读**前台窗口**的可见文字。给"把当前窗口记为工作证据"用。
   *
   * 与 `readVisibleText` 的区别只在目标怎么来：那个要先有 identity（通常是讲解时打开的那份文档），
   * 这个由脚本自己取前台窗口、现算身份。**读法完全一样**（同一个 `Op-ReadText`），
   * 所以"窗口已关""身份变了""没有 TextPattern"这些判定两条路一致。
   *
   * 只有 Windows 有：macOS 侧还没实现（见 `supportsForegroundText`），调用方要按平台拦。
   */
  readForegroundText(grant: TextReadGrant): Promise<ActionResult<{ text: string; truncated: boolean; identity: WindowIdentity }>>
}

export function createWinActions(options: WinActionsOptions): WinDesktopActions {
  const timeoutMs = options.timeoutMs ?? 10_000
  let transport = options.transport ?? null
  const getTransport = (): HelperTransport => {
    if (transport !== null) return transport
    const spec = winUiaHelperSpec('win32', options.scriptDir)
    if (spec === null) throw new Error('unreachable')
    transport = createHelperProcess(spec)
    return transport
  }

  async function call(action: ActionName, request: HelperRequest, budget = timeoutMs): Promise<{ resp: HelperResponse } | { result: ActionResult<never> }> {
    try {
      return { resp: await getTransport().request(request, budget) }
    } catch (error) {
      const evidence: ActionEvidence = { action, platform: 'win32' }
      if (error instanceof HelperTimeoutError) return { result: fail('timeout', '辅助进程超时，已结束', evidence) }
      return { result: fail('failed', `辅助进程不可用：${error instanceof Error ? error.message : String(error)}`, evidence) }
    }
  }

  function finish<T>(
    action: ActionName,
    resp: HelperResponse,
    expected: WindowIdentity | undefined,
    requireForegroundAfter: boolean,
    build: (resp: HelperResponse, evidence: ActionEvidence) => T | undefined,
  ): ActionResult<T> {
    const evidence = evidenceFromHelper(action, resp)
    if (resp.ok !== true) return { ok: false, error: helperError(resp), evidence }
    const problem = crossCheck(expected, evidence, requireForegroundAfter)
    if (problem !== null) return { ok: false, error: problem, evidence }
    const value = build(resp, evidence)
    if (value === undefined) return fail('failed', '辅助脚本的回应缺少必要字段', evidence)
    return ok(value, evidence)
  }

  const ownerPids = (o?: FocusOptions) => [...(o?.ownerPids ?? [])]

  return {
    platform: 'win32',

    async openWith(app: AppLaunchTarget, file: string): Promise<ActionResult<OpenOutcome>> {
      return openWithSpecifiedApp(file, app, { ...options.openDeps, platform: 'win32' })
    },

    async readWpsRegistry() {
      const r = await call('locate', { op: 'locate-wps' })
      if ('result' in r) return r.result
      return finish('locate', r.resp, undefined, false, resp => {
        if (!Array.isArray(resp.candidates)) return undefined
        return resp.candidates.flatMap((c): RegistryCandidate[] => {
          if (c === null || typeof c !== 'object') return []
          const v = c as Record<string, unknown>
          const source = v.source
          if (source !== 'app-paths' && source !== 'kingsoft-common' && source !== 'uninstall') return []
          const value = asString(v.value)
          if (!value) return []
          return [{
            source, key: asString(v.key) ?? '', name: asString(v.name) ?? '', value,
            version: asString(v.version) || undefined, installLocation: asString(v.installLocation) || undefined,
          }]
        })
      })
    },

    async findWindow(query: WindowQuery, opts = {}) {
      if (!query.processDir && !(query.processPaths && query.processPaths.length > 0)) {
        return fail('invalid-argument', '查找窗口必须限定进程（路径或安装目录）', { action: 'findWindow', platform: 'win32' })
      }
      const r = await call('findWindow', {
        op: 'find',
        query: { processPaths: query.processPaths ?? [], processDir: query.processDir ?? '', titleIncludes: query.titleIncludes ?? '', pid: query.pid },
        documentName: opts.documentName,
        profile: opts.profile,
      })
      if ('result' in r) return r.result
      return finish('findWindow', r.resp, undefined, false, (resp, evidence) => {
        const identity = parseWinIdentity(resp.identity)
        if (identity === undefined) return undefined
        // 进程条件在这一层再核一次：辅助脚本返回的窗口必须真的属于要求的进程。
        const inPaths = (query.processPaths ?? []).some(p => p.toLowerCase() === identity.processPath.toLowerCase())
        const inDir = query.processDir ? pathIsUnder(identity.processPath, query.processDir, 'win32') : false
        if (!inPaths && !inDir) return undefined
        evidence.after = identity
        return identity
      })
    },

    async verify(identity, profile, opts) {
      const r = await call('verify', { op: 'verify', identity, profile, ownerPids: ownerPids(opts) })
      if ('result' in r) return r.result
      return finish('verify', r.resp, identity, false, (resp, evidence) => {
        const now = evidence.after ?? evidence.before
        if (now === undefined) return undefined
        const position = parsePosition(resp)
        return position ? { ...now, position } : { ...now }
      })
    },

    async focus(identity, opts) {
      const r = await call('focus', { op: 'focus', identity, profile: opts?.profile, ownerPids: ownerPids(opts) })
      if ('result' in r) return r.result
      return finish('focus', r.resp, identity, true, (_resp, evidence) => evidence.after)
    },

    async readVisibleText(identity, grant: TextReadGrant, profile) {
      const evidence: ActionEvidence = { action: 'readVisibleText', platform: 'win32', grantReason: grant?.reason }
      if (grant?.authorized !== true) return fail('not-authorized', '读取可见文字需要调用方显式授权', evidence)
      const r = await call('readVisibleText', { op: 'read-text', identity, profile, authorized: true, maxChars: grant.maxChars ?? 20_000 })
      if ('result' in r) return r.result
      const result = finish<VisibleText>('readVisibleText', r.resp, identity, false, resp => {
        const text = asString(resp.text)
        return text === undefined ? undefined : { text, truncated: resp.truncated === true }
      })
      result.evidence.grantReason = grant.reason
      return result
    },

    async readForegroundText(grant) {
      const evidence: ActionEvidence = { action: 'readVisibleText', platform: 'win32', grantReason: grant?.reason }
      if (grant?.authorized !== true) return fail('not-authorized', '读取可见文字需要调用方显式授权', evidence)
      // 把自己这个进程的 pid 传下去：前台是宠物自己的窗口时脚本会直接拒绝 ——
      // 否则用户点一下按钮，记下的可能就是气泡里的私事。
      const r = await call('readForegroundText', {
        op: 'read-foreground-text',
        authorized: true,
        maxChars: grant.maxChars ?? 20_000,
        ownerPid: process.pid,
      })
      if ('result' in r) return r.result
      // 目标是脚本现取的，调用方事先不知道是哪个窗口，所以 expected 传 undefined：
      // 身份以脚本回传的 `before` 为准，再由界面把它显示给用户确认。
      const result = finish<{ text: string; truncated: boolean; identity: WindowIdentity }>('readForegroundText', r.resp, undefined, false, resp => {
        const text = asString(resp.text)
        const identity = parseWinIdentity(resp.before)
        if (text === undefined || identity === undefined) return undefined
        return { text, truncated: resp.truncated === true, identity }
      })
      result.evidence.grantReason = grant.reason
      return result
    },

    async readPage(identity, profile, opts) {      const r = await call('readPage', { op: 'read-page', identity, profile, ownerPids: ownerPids(opts) })
      if ('result' in r) return r.result
      return finish('readPage', r.resp, identity, false, resp => parsePosition(resp))
    },

    async gotoPage(identity, page, profile, opts) {
      if (!validPage(page)) return fail('invalid-argument', '页码必须是正整数', { action: 'gotoPage', platform: 'win32' })
      // 每页最多约 10 次按键 × 若干轮，按页数放宽时间上限，但不超过 45 秒。
      const r = await call('gotoPage', { op: 'goto-page', identity, profile, page, ownerPids: ownerPids(opts) }, Math.min(45_000, timeoutMs + 4_000))
      if ('result' in r) return r.result
      const result = finish('gotoPage', r.resp, identity, true, resp => parsePosition(resp))
      // 第三道：读回页码必须等于目标页。
      if (result.ok && result.value.page !== page) {
        return fail('failed', `读回第 ${result.value.page} 页，不是目标第 ${page} 页`, result.evidence, { detail: 'readback-mismatch' })
      }
      return result
    },

    async scroll(identity, request: ScrollRequest, profile, opts) {
      const r = await call('scroll', { op: 'scroll', identity, profile, direction: request.direction, unit: request.unit, count: request.count, ownerPids: ownerPids(opts) })
      if ('result' in r) return r.result
      return finish<ScrollOutcome>('scroll', r.resp, identity, true, resp => {
        const pos = parsePosition(resp)
        if (pos === undefined || typeof resp.moved !== 'boolean') return undefined
        return {
          ...pos,
          moved: resp.moved,
          atBoundary: resp.atBoundary === true,
          scrollValueBefore: asNumber(resp.scrollValueBefore),
          scrollValueAfter: asNumber(resp.scrollValueAfter),
        }
      })
    },

    dispose() {
      transport?.dispose()
      transport = null
    },
  }
}
