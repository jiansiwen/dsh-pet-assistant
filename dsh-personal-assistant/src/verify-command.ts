/**
 * 验证命令的可信执行（M2-06）：程序 + 参数数组，绝不经过 shell。
 *
 * - 程序：解析成绝对路径后再绑定进批准。裸名只在 PATH 的绝对目录里找，不找工作目录 ——
 *   Windows 的进程创建会先搜当前目录，项目里放一个同名 node.exe 就能顶替真程序；
 *   shell、脚本宿主与 Windows 的 .cmd/.bat 一律拒绝：它们会把参数数组重新拼成一条命令行字符串解释。
 * - 环境：只传基础变量（PATH、TEMP、用户目录等），凭据类变量一律不传 —— 测试代码是项目里的代码，
 *   不该顺手拿到宿主进程里的 API key。
 * - 超时：到点结束整棵进程树（Windows 用系统目录里的 taskkill /T，POSIX 用进程组），
 *   结束不了就如实报「未能确认退出」，由账本记 unknown。
 * - 输出：stdout / stderr 各保留开头与结尾，中间省略并标注字节数。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

/** shell、脚本宿主与提权/转发器：它们本身就是「执行任意命令字符串」，不能当验证程序。 */
export const REFUSED_PROGRAMS: readonly string[] = [
  'cmd', 'powershell', 'powershell_ise', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'ash',
  'wsl', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32', 'env', 'xargs', 'busybox', 'osascript',
  'sudo', 'doas', 'runas', 'start', 'nohup', 'script', 'su',
]

/** 允许传给验证命令的环境变量（大小写不敏感）。 */
const ENV_ALLOW = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'COMPUTERNAME', 'USERNAME', 'USER', 'LOGNAME',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
])

/** 即便在允许名单里，名字像凭据的也不传。 */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE|AUTH|COOKIE|SESSION)/i

export const ENV_POLICY_TEXT = '只传基础环境变量（PATH、TEMP、用户目录、语言区域等）；令牌、密钥、密码类变量一律不传'

export function buildVerificationEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue
    if (!ENV_ALLOW.has(name.toUpperCase()) || SECRET_NAME.test(name)) continue
    env[name] = value
  }
  return env
}

export type ResolvedProgram = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string }

function stemOf(file: string): string {
  return path.basename(file).toLowerCase().replace(/\.(exe|com|bat|cmd)$/, '')
}

function isRunnableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (platform !== 'win32') accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const WINDOWS_RUNNABLE = ['.exe', '.com']

/**
 * 把验证命令的程序解析成绝对真实路径。
 * @param program - 模型给的程序：裸名（node）、相对路径（相对 cwd）或绝对路径。
 * @param cwd - 命令的工作目录（已规范化、位于授权项目内）。
 * @param envPath - 用来查裸名的 PATH。
 */
export function resolveProgram(program: string, cwd: string, envPath: string | undefined, platform: NodeJS.Platform = process.platform): ResolvedProgram {
  if (typeof program !== 'string' || program.trim() === '' || program.length > 1024 || /[\0\r\n]/.test(program)) {
    return { ok: false, error: '程序必须是一行非空路径或程序名' }
  }
  if (REFUSED_PROGRAMS.includes(stemOf(program))) {
    return { ok: false, error: `${program} 是 shell 或命令转发器，会把参数重新解释成命令字符串；验证命令只接受直接可执行的程序（如 node、python、go）` }
  }
  const windows = platform === 'win32'
  const extension = path.extname(program).toLowerCase()
  if (windows && extension !== '' && !WINDOWS_RUNNABLE.includes(extension)) {
    return {
      ok: false,
      error: `Windows 上 ${extension} 需要经 cmd.exe 解析参数，等于把参数数组重新拼成 shell 字符串，不支持；`
        + '请直接运行可执行文件，例如 node node_modules/<包>/bin/<入口>.js',
    }
  }
  const candidates = (base: string): string[] => (windows && extension === '' ? WINDOWS_RUNNABLE.map(ext => base + ext) : [base])
  const hasSeparator = program.includes('/') || program.includes('\\') || path.isAbsolute(program)
  let found: string | undefined
  if (hasSeparator) {
    found = candidates(path.resolve(cwd, program)).find(file => isRunnableFile(file, platform))
    if (!found) return { ok: false, error: `找不到可执行文件 ${program}（相对路径按工作目录 ${cwd} 解析）` }
  } else {
    // 只查 PATH 里的绝对目录：空项与相对项等价于当前目录，会让项目里的同名程序顶替真程序。
    const dirs = (envPath ?? '').split(path.delimiter).filter(dir => dir.length > 0 && path.isAbsolute(dir))
    for (const dir of dirs) {
      found = candidates(path.join(dir, program)).find(file => isRunnableFile(file, platform))
      if (found) break
    }
    if (!found) return { ok: false, error: `在 PATH 里找不到 ${program}（不搜索工作目录）；可以改写成程序的绝对路径` }
  }
  let real: string
  try {
    real = realpathSync.native(found)
  } catch (error) {
    return { ok: false, error: `无法确认 ${found} 的真实位置：${error instanceof Error ? error.message : String(error)}` }
  }
  if (REFUSED_PROGRAMS.includes(stemOf(real))) return { ok: false, error: `${program} 实际指向 ${real}，那是 shell 或命令转发器，不支持` }
  if (windows && !WINDOWS_RUNNABLE.includes(path.extname(real).toLowerCase())) return { ok: false, error: `${program} 实际指向 ${real}，不是 .exe/.com，不支持` }
  return { ok: true, path: real }
}

/** 输出缓冲：保留开头与结尾，记总字节数。 */
class OutputTail {
  private head = Buffer.alloc(0)
  private tail: Buffer[] = []
  private tailBytes = 0
  total = 0
  private readonly headLimit: number
  private readonly tailLimit: number

  constructor(headLimit: number, tailLimit: number) {
    this.headLimit = headLimit
    this.tailLimit = tailLimit
  }

  push(chunk: Buffer): void {
    this.total += chunk.length
    let rest = chunk
    if (this.head.length < this.headLimit) {
      const take = Math.min(this.headLimit - this.head.length, rest.length)
      this.head = Buffer.concat([this.head, rest.subarray(0, take)])
      rest = rest.subarray(take)
    }
    if (rest.length === 0) return
    this.tail.push(rest)
    this.tailBytes += rest.length
    while (this.tail.length > 1 && this.tailBytes - this.tail[0]!.length >= this.tailLimit) {
      this.tailBytes -= this.tail.shift()!.length
    }
  }

  text(): { text: string; truncated: boolean } {
    const tail = Buffer.concat(this.tail)
    const keptTail = tail.length > this.tailLimit ? tail.subarray(tail.length - this.tailLimit) : tail
    const omitted = this.total - this.head.length - keptTail.length
    const decode = (bytes: Buffer) => stripAnsi(bytes.toString('utf8'))
    if (omitted <= 0) return { text: decode(Buffer.concat([this.head, keptTail])), truncated: false }
    return { text: `${decode(this.head)}\n…（中间省略 ${omitted} 字节）…\n${decode(keptTail)}`, truncated: true }
  }
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

export interface CommandSpec {
  readonly program: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly env: Record<string, string>
}

export type CommandOutcome = 'exited' | 'timed-out' | 'spawn-error' | 'cancelled' | 'unconfirmed'

export interface CommandResult {
  readonly outcome: CommandOutcome
  readonly exitCode: number | null
  readonly signal: string | null
  readonly durationMs: number
  readonly stdout: string
  readonly stderr: string
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly error: string | null
}

/** 输出各保留开头 4KB、结尾 12KB：测试失败的摘要通常在最后。 */
const OUTPUT_HEAD = 4 * 1024
const OUTPUT_TAIL = 12 * 1024
/** 请求结束进程树之后，最多再等这么久确认它真的退出。 */
const KILL_GRACE_MS = 5_000

function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    // 用系统目录里的 taskkill：PATH 里的同名程序不能顶替它。
    const taskkill = path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    try {
      spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: KILL_GRACE_MS, stdio: 'ignore' })
    } catch { /* 下面按是否收到 close 判断是否真的结束。 */ }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* 已经退出。 */ }
  }
}

/**
 * 运行一次验证命令。只在 'close' 之后返回（输出已全部收完）；超时或取消时结束整棵进程树，
 * 宽限期内没收到退出就返回 unconfirmed —— 调用方必须把它记成结果不明。
 */
export function runCommand(spec: CommandSpec, signal?: AbortSignal): Promise<CommandResult> {
  const started = Date.now()
  const stdout = new OutputTail(OUTPUT_HEAD, OUTPUT_TAIL)
  const stderr = new OutputTail(OUTPUT_HEAD, OUTPUT_TAIL)
  return new Promise(resolve => {
    let settled = false
    let reason: 'timed-out' | 'cancelled' | null = null
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (outcome: CommandOutcome, exitCode: number | null, sig: string | null, error: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      signal?.removeEventListener('abort', onAbort)
      const out = stdout.text()
      const err = stderr.text()
      resolve({
        outcome, exitCode, signal: sig, durationMs: Date.now() - started,
        stdout: out.text, stderr: err.text, stdoutBytes: stdout.total, stderrBytes: stderr.total,
        stdoutTruncated: out.truncated, stderrTruncated: err.truncated, error,
      })
    }
    let child: ChildProcess
    try {
      child = spawn(spec.program, [...spec.args], {
        cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX 上放进独立进程组，超时能连同子孙一起结束。
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolve({
        outcome: 'spawn-error', exitCode: null, signal: null, durationMs: 0, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
        stdoutTruncated: false, stderrTruncated: false, error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const stop = (why: 'timed-out' | 'cancelled') => {
      if (settled || reason !== null) return
      reason = why
      killTree(child)
      graceTimer = setTimeout(() => finish('unconfirmed', null, null, '已请求结束进程树，但宽限期内没有确认进程退出'), KILL_GRACE_MS)
    }
    const timer = setTimeout(() => stop('timed-out'), Math.max(1, spec.timeoutMs))
    const onAbort = () => stop('cancelled')
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', error => {
      // spawn 失败（ENOENT/EACCES）时不会有 close 之外的进程；已经在跑之后的 error 交给 close 处理。
      if (child.pid === undefined) finish('spawn-error', null, null, error.message)
    })
    child.once('close', (code, sig) => {
      if (reason === 'timed-out') finish('timed-out', code, sig, null)
      else if (reason === 'cancelled') finish('cancelled', code, sig, null)
      else finish('exited', code, sig, null)
    })
  })
}
