import { randomUUID } from 'node:crypto'

export interface DesktopCommandEvent {
  type: 'desktop/command'
  payload: { id: string; command: string; payload: unknown; expiresAt: number }
}

type Push = (event: DesktopCommandEvent) => void
type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  expiresAt: number
}

/**
 * 宿主 → 桌宠的一次性命令通道。
 *
 * 命令只走本机桥接事件，结果必须带同一 commandId 从 owner 接口回来；
 * 超时、代次切换或插件卸载都会拒绝等待方，绝不把迟到结果交给下一次请求。
 */
export class DesktopCommands {
  private readonly push: Push
  private readonly pending = new Map<string, Pending>()
  private disposed = false

  constructor(push: Push) { this.push = push }

  request(command: string, payload: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('桌面命令通道已停止'))
    if (!command.trim()) return Promise.reject(new Error('桌面命令不能为空'))
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30_000, 1_000), 15 * 60_000)
    const id = randomUUID()
    const expiresAt = Date.now() + timeoutMs
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        const entry = this.pending.get(id)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(id)
      }
      const finish = (error: Error | null, value?: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        options.signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(value)
      }
      const abort = (): void => finish(new Error('桌面操作已取消'))
      if (options.signal?.aborted) { abort(); return }
      options.signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => finish(new Error('桌面操作超时，未收到桌宠回执')), timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve: value => finish(null, value), reject: error => finish(error), timer, expiresAt })
      try { this.push({ type: 'desktop/command', payload: { id, command, payload, expiresAt } }) }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  /** 桌宠回执；只认仍在等待且未过期的同一个 id。 */
  resolve(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    const value = raw as Record<string, unknown>
    if (typeof value.id !== 'string' || typeof value.ok !== 'boolean') return false
    const entry = this.pending.get(value.id)
    if (!entry || entry.expiresAt < Date.now()) return false
    if (value.ok) entry.resolve(value.result)
    else entry.reject(new Error(typeof value.error === 'string' && value.error.trim() ? value.error.slice(0, 500) : '桌面操作失败'))
    return true
  }

  dispose(): void {
    this.disposed = true
    for (const entry of [...this.pending.values()]) entry.reject(new Error('桌面命令通道已停止'))
    this.pending.clear()
  }
}
