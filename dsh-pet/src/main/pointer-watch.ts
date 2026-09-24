import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { platform } from 'node:os'
import { platformOf, supportsGlobalPointerWatch } from './platform.ts'

/** 原始屏幕坐标；时间为按下发生时的 Unix 毫秒，不是管道消费时间。 */
export interface PointerPress {
  x: number
  y: number
  time: number
  button: 'left' | 'right' | 'middle'
  pid: number
}

interface Command { id: number; enabled: boolean }
interface Helper {
  child: ChildProcessWithoutNullStreams
  ready: boolean
  acknowledged: number
  pending: Command | null
  stopping: boolean
  failed: boolean
  retry: boolean
  buffer: Buffer
  stderr: string
  timer?: ReturnType<typeof setTimeout>
  onOwnerExit: () => void
}

const MAX_LINE = 4096
const MAX_STDERR = 8192
const START_TIMEOUT = 15000
const COMMAND_TIMEOUT = 5000
const STOP_TIMEOUT = 1000

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

function isPress(value: Record<string, unknown>): value is Record<string, unknown> & PointerPress {
  return Object.keys(value).length === 5 &&
    integer(value.x, -2147483648, 2147483647) && integer(value.y, -2147483648, 2147483647) &&
    integer(value.time, 0, Number.MAX_SAFE_INTEGER) && integer(value.pid, 0, 4294967295) &&
    (value.button === 'left' || value.button === 'right' || value.button === 'middle')
}

/**
 * 只提供鼠标按下事件，不判断舞台内外，也不转换 DPI。
 * 首次启用才启动 helper；禁用后保持空闲。失败后再次 setEnabled(true) 可重试，
 * 但必须等旧进程关闭才会启动新进程。dispose 不可逆，仅回收本实例的子进程。
 */
export class PointerWatcher {
  private readonly scriptPath: string
  private readonly onPress: (event: PointerPress) => void
  private readonly onError: (message: string) => void
  private helper: Helper | null = null
  private enabled = false
  private disposed = false
  private revision = 0

  constructor(scriptPath: string, onPress: (event: PointerPress) => void, onError: (message: string) => void) {
    this.scriptPath = scriptPath
    this.onPress = onPress
    this.onError = onError
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return
    if (this.enabled !== enabled) {
      this.enabled = enabled
      this.revision = this.revision % 2147483647 + 1
    }
    const helper = this.helper
    if (!helper) {
      if (enabled) this.start()
    } else if (helper.stopping) {
      helper.retry = enabled
    } else {
      this.sendState(helper)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.enabled = false
    if (this.helper) this.stop(this.helper)
  }

  private report(message: string): void {
    try { this.onError(message) } catch { /* 消费者的错误回调不能中断子进程清理。 */ }
  }

  private start(): void {
    if (!supportsGlobalPointerWatch(platformOf(platform()))) {
      // 走到这里说明调用方漏了平台守卫。仍然如实报出来而不是静默 —— 静默会让
      // "点外面收起面板"这个功能莫名其妙地不工作，而日志里一个字都没有。
      this.report('全局鼠标监听需要 Windows；当前系统上「点面板外面收起」不可用，请点角色或按 Esc。')
      return
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', this.scriptPath], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.report(`无法启动鼠标监听辅助进程：${String(error)}`)
      return
    }
    const helper: Helper = {
      child, ready: false, acknowledged: 0, pending: null, stopping: false, failed: false, retry: false,
      buffer: Buffer.alloc(0), stderr: '',
      onOwnerExit: () => {
        try { child.kill() } catch { /* 只处理自己持有的进程；进程可能已经退出。 */ }
      },
    }
    this.helper = helper
    process.once('exit', helper.onOwnerExit)
    child.stdout.on('data', (chunk: Buffer) => this.read(helper, chunk))
    child.stdout.on('error', error => this.fail(helper, `鼠标监听输出管道失败：${error.message}`))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (helper.stopping) return
      const remaining = MAX_STDERR - helper.stderr.length
      helper.stderr += chunk.slice(0, remaining)
      if (chunk.length > remaining) this.fail(helper, '鼠标监听错误输出超过限制。')
    })
    child.stderr.on('error', error => this.fail(helper, `鼠标监听错误管道失败：${error.message}`))
    child.stdin.on('error', error => this.fail(helper, `鼠标监听控制管道失败：${error.message}`))
    child.on('error', error => this.fail(helper, `鼠标监听辅助进程失败：${error.message}`))
    child.once('close', (code, signal) => {
      this.clearTimer(helper)
      process.removeListener('exit', helper.onOwnerExit)
      helper.buffer = Buffer.alloc(0)
      if (this.helper !== helper) return
      this.helper = null
      if (!helper.stopping) {
        const advice = helper.ready ? '' : ' 请检查脚本路径及 PowerShell 执行策略；本模块不会绕过或修改策略。'
        this.report(`鼠标监听辅助进程退出（${code ?? signal ?? '未知'}）。${advice}${helper.stderr.trim() ? ` ${helper.stderr.trim()}` : ''}`)
      }
      // 不自动循环重启；只履行故障清理期间明确请求的重试。
      if (helper.retry && this.enabled && !this.disposed && !this.helper) this.start()
    })
    this.arm(helper, START_TIMEOUT, '鼠标监听辅助进程启动超时。')
  }

  private clearTimer(helper: Helper): void {
    if (helper.timer) clearTimeout(helper.timer)
    helper.timer = undefined
  }

  private arm(helper: Helper, delay: number, message: string): void {
    this.clearTimer(helper)
    helper.timer = setTimeout(() => this.fail(helper, message), delay)
    helper.timer.unref()
  }

  private fail(helper: Helper, message: string): void {
    if (this.helper !== helper || helper.stopping || helper.failed) return
    helper.failed = true
    this.stop(helper)
    this.report(message)
  }

  private stop(helper: Helper): void {
    if (helper.stopping) return
    helper.stopping = true
    helper.pending = null
    helper.buffer = Buffer.alloc(0)
    this.clearTimer(helper)
    // 正常退出先卸钩；编译挂起或管道阻塞时，超时只终止这个 ChildProcess。
    helper.timer = setTimeout(() => {
      try { helper.child.kill() } catch { /* 进程已退出时由 close 完成收尾。 */ }
    }, STOP_TIMEOUT)
    helper.timer.unref()
    try { helper.child.stdin.end('exit\n') } catch { /* 超时回收仍会执行。 */ }
  }

  private sendState(helper: Helper): void {
    if (!helper.ready || helper.stopping || helper.pending || helper.acknowledged === this.revision) return
    const command = { id: this.revision, enabled: this.enabled }
    helper.pending = command
    this.arm(helper, COMMAND_TIMEOUT, '鼠标监听启停确认超时。')
    try {
      helper.child.stdin.write(`${command.enabled ? 'enable' : 'disable'} ${command.id}\n`, error => {
        if (error) this.fail(helper, `鼠标监听控制写入失败：${error.message}`)
      })
    } catch (error) {
      this.fail(helper, `鼠标监听控制写入失败：${String(error)}`)
    }
  }

  private read(helper: Helper, chunk: Buffer): void {
    if (this.helper !== helper || helper.stopping) return
    let offset = 0
    while (offset < chunk.length && !helper.stopping && this.helper === helper) {
      const newline = chunk.indexOf(10, offset)
      const end = newline === -1 ? chunk.length : newline
      if (helper.buffer.length + end - offset > MAX_LINE) {
        this.fail(helper, '鼠标监听输出行超过限制。')
        return
      }
      const line = Buffer.concat([helper.buffer, chunk.subarray(offset, end)])
      offset = end + 1
      if (newline === -1) {
        helper.buffer = line
        return
      }
      helper.buffer = Buffer.alloc(0)
      this.receive(helper, line.toString('utf8').trim())
    }
  }

  private receive(helper: Helper, line: string): void {
    if (!line) return
    let value: unknown
    try { value = JSON.parse(line) } catch {
      this.fail(helper, '鼠标监听输出不是有效 JSON。')
      return
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.fail(helper, '鼠标监听输出字段无效。')
      return
    }
    const message = value as Record<string, unknown>
    if (message.ready === true && Object.keys(message).length === 3 &&
        typeof message.enabled === 'boolean' && integer(message.id, 0, 2147483647)) {
      if (!helper.ready) {
        if (message.id !== 0 || message.enabled) {
          this.fail(helper, '鼠标监听初始化确认无效。')
          return
        }
        helper.ready = true
      } else {
        if (!helper.pending || message.id !== helper.pending.id || message.enabled !== helper.pending.enabled) {
          this.fail(helper, '鼠标监听启停确认不匹配。')
          return
        }
        helper.acknowledged = message.id
        helper.pending = null
      }
      this.clearTimer(helper)
      this.sendState(helper)
      return
    }
    if (!isPress(message)) {
      this.fail(helper, '鼠标监听事件字段无效。')
      return
    }
    // 确认与事件由同一输出线程排序；切换前已在管道内的事件不会越过新确认。
    if (!this.enabled || !helper.ready || helper.pending || helper.acknowledged !== this.revision) return
    const { x, y, time, button, pid } = message
    try { this.onPress({ x, y, time, button, pid }) } catch (error) {
      this.report(`鼠标按下回调失败：${String(error)}`)
    }
  }
}
