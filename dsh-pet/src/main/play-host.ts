/**
 * 常驻音频播放进程（Windows）。
 *
 * 唤醒应答必须"喊了就响"：实测每唤醒一次都新起 PowerShell 跑 play.ps1，播放 0.4 秒的音频
 * 总耗时 2.5 秒（首次约 5 秒），其中 2 秒以上是 PowerShell 冷启动与 Add-Type 编译。
 * 这里让一个 PowerShell 常驻，启动预热时编译一次，之后只经 stdin 发"播哪条"，
 * 播完在 stdout 回报。播放本身的启动延迟降到约 0.2 秒。
 *
 * 可用性优先：脚本缺失、策略拦截或进程中途死掉时，`play()` 返回 null，调用方回退到
 * 一次性 spawn 的 play.ps1 —— 功能不受影响，只是那一次慢。
 *
 * 协议见 play-host.ps1 顶部注释（ASCII 行，路径走 base64）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { createInterface, type Interface } from 'node:readline'

export interface PlayHostOptions {
  /** play-host.ps1 所在目录（打包态是 app.asar.unpacked 里的真实目录）。 */
  readonly scriptDir: string
  /** 默认取 process.platform；只有 win32 会启动。 */
  readonly platform?: string
  /** 从 spawn 到收到 ready 的上限。PowerShell 冷启动约 2 秒，给足余量。 */
  readonly startTimeoutMs?: number
  /** 测试注入用；默认 node:child_process 的 spawn。 */
  readonly spawnImpl?: typeof spawn
}

/** 播放一句的上限：问候语只有两三秒，卡住必须能自动回来。 */
const DEFAULT_PLAY_TIMEOUT_MS = 60_000

export class PlayHost {
  private readonly scriptDir: string
  private readonly platform: string
  private readonly startTimeoutMs: number
  private readonly spawnImpl: typeof spawn
  private child: ChildProcess | null = null
  private lines: Interface | null = null
  private ready = false
  private starting: Promise<boolean> | null = null
  private waiters = new Map<number, (ok: boolean) => void>()
  private nextId = 1
  private disposed = false

  constructor(options: PlayHostOptions) {
    this.scriptDir = options.scriptDir
    this.platform = options.platform ?? process.platform
    this.startTimeoutMs = options.startTimeoutMs ?? 8_000
    this.spawnImpl = options.spawnImpl ?? spawn
  }

  /** 是否已经预热完成、能直接接播放请求。 */
  isReady(): boolean {
    return this.ready
  }

  /**
   * 等预热完成，最多 `ms` 毫秒。
   *
   * 启动后头几秒里用户就可能喊第一声：这时常驻进程还在编译，立刻回退到一次性脚本
   * 反而更慢。这里给它一个短暂窗口；窗口内没等到就返回 false，调用方照常回退。
   */
  waitReady(ms: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true)
    const starting = this.starting
    if (starting === null) return Promise.resolve(false)
    return new Promise<boolean>(resolve => {
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ok)
      }
      const timer = setTimeout(() => finish(false), ms)
      timer.unref?.()
      void starting.then(finish, () => finish(false))
    })
  }

  /** 预热：起进程并等它编译完。重复调用共享同一次启动。 */
  start(): Promise<boolean> {
    if (this.ready) return Promise.resolve(true)
    if (this.disposed || this.platform !== 'win32') return Promise.resolve(false)
    if (this.starting !== null) return this.starting
    const promise = this.launch()
    this.starting = promise
    void promise.finally(() => {
      if (this.starting === promise) this.starting = null
    })
    return promise
  }

  /**
   * 请求播放一个文件。
   *
   * 返回 null 表示"这条路现在用不了"（没预热好、平台不支持、进程已死），
   * 调用方应当回退到一次性脚本，而不是当作播放失败。
   */
  play(file: string, timeoutMs = DEFAULT_PLAY_TIMEOUT_MS): Promise<boolean> | null {
    const stdin = this.child?.stdin
    if (!this.ready || stdin === null || stdin === undefined || stdin.destroyed) return null
    const id = this.nextId++
    const payload = Buffer.from(file, 'utf8').toString('base64')
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        // 播放卡死时进程状态不可信：直接关掉，下一次唤醒重新预热。
        this.kill()
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      this.waiters.set(id, ok => {
        clearTimeout(timer)
        resolve(ok)
      })
      try {
        stdin.write(`${id} ${payload}\n`)
      } catch {
        this.waiters.delete(id)
        clearTimeout(timer)
        this.kill()
        resolve(false)
      }
    })
  }

  /** 退出时收尾：让进程自己退出，随即强杀兜底。 */
  stop(): void {
    this.disposed = true
    const child = this.child
    try { child?.stdin?.write('quit\n') } catch { /* 已经关了 */ }
    try { child?.kill() } catch { /* 已经退出 */ }
    this.detach()
  }

  private launch(): Promise<boolean> {
    let child: ChildProcess
    try {
      child = this.spawnImpl('powershell', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(this.scriptDir, 'play-host.ps1'),
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      return Promise.resolve(false)
    }
    this.child = child
    const stdout = child.stdout
    if (stdout === null) {
      this.detach()
      return Promise.resolve(false)
    }
    const lines = createInterface({ input: stdout })
    this.lines = lines

    return new Promise<boolean>(resolve => {
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ok)
      }
      const timer = setTimeout(() => {
        finish(false)
        // 预热超时：别让一个卡在启动阶段的进程占着，下一次请求可以重来。
        this.kill()
      }, this.startTimeoutMs)
      timer.unref?.()

      lines.on('line', line => {
        if (line.trim() === 'ready') {
          this.ready = true
          finish(true)
          return
        }
        this.onLine(line)
      })
      // 进程退出：所有排队中的请求都算失败，下一次 start() 会重新起。
      child.once('exit', () => {
        this.detach()
        finish(false)
      })
      child.once('error', () => {
        this.detach()
        finish(false)
      })
    })
  }

  private onLine(line: string): void {
    const [status, idText] = line.trim().split(/\s+/)
    const id = Number(idText)
    if (!Number.isInteger(id)) return
    const waiter = this.waiters.get(id)
    if (waiter === undefined) return
    this.waiters.delete(id)
    waiter(status === 'ok')
  }

  /** 清掉进程与所有等待者，但不改 disposed —— 崩溃后还允许重新预热。 */
  private detach(): void {
    this.lines?.close()
    this.lines = null
    this.child = null
    this.ready = false
    const waiters = [...this.waiters.values()]
    this.waiters.clear()
    for (const waiter of waiters) waiter(false)
  }

  private kill(): void {
    const child = this.child
    this.detach()
    try { child?.kill() } catch { /* 已经退出 */ }
  }
}
