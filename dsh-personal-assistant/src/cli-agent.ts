/**
 * 本地 CLI 子助理适配层：每个子助理会话一个常驻子进程，stdin/stdout JSONL 对话。
 *
 * 上下文由子进程自身维护（交互式 CLI 工具的原生会话），本层只透传任务、不拼接历史。
 * 纪律：
 * - spawn 一律 shell:false、参数数组化——绑定里登记的命令就是白名单，无 shell 注入面；
 * - 子进程监听器只挂一次（ensureChild），send 只负责配对与超时；
 * - stdout 逐行解析：必须是本任务 id 的协议回执，非法行如实报协议错误（不猜语义）；
 * - 超时 kill（SIGTERM→SIGKILL），会话随进程终止，下次 send 重新拉起；
 * - 进程退出/启动失败/管道断裂（EPIPE）如实入回执，绝不伪装成功。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { LocalCliBinding } from './member-contract.ts'
import type { SubAssistantReceipt } from './sub-assistant-protocol.ts'

const MAX_BUFFER = 1024 * 1024 * 4
const KILL_GRACE_MS = 3_000

export class CliAgent {
  private readonly binding: LocalCliBinding
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private stderrTail = ''
  private pending: {
    id: string
    resolve: (receipt: SubAssistantReceipt) => void
    timer: NodeJS.Timeout
  } | null = null

  constructor(binding: LocalCliBinding) {
    this.binding = binding
  }

  /** 一次任务往返。同一会话串行：上一任务未结束前拒绝新任务。 */
  send(task: string, timeoutMs: number): Promise<SubAssistantReceipt> {
    if (this.pending) return Promise.resolve({ kind: 'error', text: '上一任务尚未结束，同一会话串行执行' })
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.resolve({ kind: 'error', text: 'CLI 调用超时参数无效' })
    return new Promise(resolve => {
      const id = randomUUID()
      let child: ChildProcessWithoutNullStreams
      try {
        child = this.ensureChild()
      } catch (error) {
        resolve({ kind: 'error', text: `工具命令无法启动：${(error as NodeJS.ErrnoException).message}` })
        return
      }
      const timer = setTimeout(() => {
        this.settle({ kind: 'timeout' })
        // 会话已不可信：终止进程，下次 send 重新拉起
        this.kill()
      }, timeoutMs)
      this.pending = { id, resolve, timer }
      try {
        child.stdin.write(`${JSON.stringify({ id, task })}\n`)
      } catch (error) {
        this.settle({ kind: 'error', text: `任务写入失败：${(error as Error).message}` })
      }
    })
  }

  /** 会话终止：SIGTERM 宽限后 SIGKILL。幂等，可安全重复调用。 */
  dispose(): void {
    this.settle({ kind: 'error', text: '会话已回收' })
    this.kill()
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    this.buffer = ''
    this.stderrTail = ''
    // shell:false + 参数数组：绑定登记的命令即白名单；录入侧已校验可打印字符。
    const child = spawn(this.binding.command, [...this.binding.args], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { if (this.child === child) this.onStdout(chunk) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (this.child === child) this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2_000)
    })
    child.on('error', error => {
      if (this.child !== child) return
      this.child = null
      const code = (error as NodeJS.ErrnoException).code
      this.settle(code === 'ENOENT'
        ? { kind: 'error', text: `工具命令无法启动：${error.message}` }
        : { kind: 'error', text: `工具进程异常：${error.message}` })
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      if (this.pending) {
        this.settle({ kind: 'error', text: `工具进程提前退出（code=${String(code)} signal=${String(signal)}）：${this.stderrTail.trim() || '无 stderr 输出'}` })
      }
    })
    child.stdin.on('error', error => {
      if (this.child !== child) return
      this.settle({ kind: 'error', text: `任务写入失败：${error.message}` })
    })
    return child
  }

  private onStdout(chunk: string): void {
    if (this.buffer.length > MAX_BUFFER) {
      this.settle({ kind: 'error', text: '工具输出超过大小限制' })
      this.kill()
      return
    }
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim() !== '') {
        this.handleLine(line)
        if (!this.pending) return
      }
      newline = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    if (!this.pending) return
    const { id } = this.pending
    try {
      const value = JSON.parse(line) as { id?: unknown; kind?: unknown; text?: unknown; reason?: unknown }
      // CLI 回执协议：{id, kind, text|reason} 恰好三键；多余字段不认（不猜语义）。
      if (value && typeof value === 'object' && value.id === id) {
        if (value.kind === 'reply' && typeof value.text === 'string' && Object.keys(value).length === 3) {
          this.settle({ kind: 'reply', text: value.text })
          return
        }
        if (value.kind === 'out-of-scope' && typeof value.reason === 'string' && Object.keys(value).length === 3) {
          this.settle({ kind: 'out-of-scope', reason: value.reason })
          return
        }
      }
    } catch { /* 落到协议错误：不猜语义 */ }
    this.settle({ kind: 'error', text: `工具输出不符合协议：${line.slice(0, 200)}` })
  }

  private settle(receipt: SubAssistantReceipt): void {
    if (!this.pending) return
    clearTimeout(this.pending.timer)
    const { resolve } = this.pending
    this.pending = null
    resolve(receipt)
  }

  private kill(): void {
    const child = this.child
    if (this.child !== null) this.child = null
    if (!child || child.exitCode !== null) return
    child.kill('SIGTERM')
    const killer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, KILL_GRACE_MS)
    killer.unref?.()
    child.once('exit', () => clearTimeout(killer))
  }
}
