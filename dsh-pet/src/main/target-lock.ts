/**
 * 唤醒前目标锁（4.6 切片1）。
 *
 * 唤醒/快捷键/点击引发焦点切换**之前**保存前台窗口身份，TTL 15 秒；执行动作前
 * 用 resolveTargetLock 复核"还是同一代进程"（PID + 启动时间组合，pid 会被复用）。
 * 缺锁、过期、进程重启/换代一律返回 null —— 调用方转 awaiting-user 重选，
 * 不猜"刚才那个"。
 *
 * 纪律：
 * - 只取窗口/进程身份，不读正文、不读控件文本；
 * - 锁是内存态：宠物进程重启或 invalidateAll() 后全部失效，不落盘、不跨代次；
 * - 非 Windows 平台没有实现，capture/resolve 都返回 null（unsupported），不静默降级。
 *
 * IO 经注入提供（生产接 win-actions 的 readForegroundIdentity / readProcessIdentity，
 * 见 winActionsTargetLockIO），本模块不 spawn、不 import electron，node --test 可直接导入。
 */
import { randomUUID } from 'node:crypto'
import { platformOf, type SupportedPlatform } from './platform.ts'
import type { WinDesktopActions } from './win-actions.ts'

export const TARGET_LOCK_TTL_MS = 15_000

/** 前台窗口身份：不含标题与正文，只用于核对"还是不是那个进程/窗口"。 */
export interface TargetLockIdentity {
  hwnd: string
  pid: number
  processStartedAt: string
  processPath: string
  displayId: string
}

export interface TargetLock extends TargetLockIdentity {
  lockId: string
  capturedAt: number
  expiresAt: number
}

/** 指定 PID 的当前身份；进程已退出时调用方返回 null。 */
export interface ProcessIdentityProbe {
  alive: boolean
  processStartedAt: string
  processPath: string
}

export interface TargetLockIO {
  /** 只读前台窗口身份，不读正文/控件文本；取不到返回 null。 */
  foregroundIdentity(): Promise<TargetLockIdentity | null>
  /** 查询该 PID 现在的启动时间与路径；进程不存在返回 null。 */
  processIdentity(pid: number): Promise<ProcessIdentityProbe | null>
}

export interface TargetLockHandle {
  /** 焦点切换前捕获；非 Windows、取不到有效身份都返回 null。 */
  captureTargetLock(now: number): Promise<TargetLock | null>
  /** 校验 TTL 与进程代次；任何一项失效返回 null 并删除锁。 */
  resolveTargetLock(lockId: string, now: number): Promise<TargetLock | null>
  /** 代次变化/退出时清空全部锁（内存态，重启自然全失效）。 */
  invalidateAll(): void
}

function validIdentity(value: TargetLockIdentity | null): value is TargetLockIdentity {
  return !!value && typeof value.hwnd === 'string' && /^[1-9]\d{0,19}$/.test(value.hwnd)
    && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.processStartedAt === 'string' && /^\d{1,24}$/.test(value.processStartedAt)
    && typeof value.processPath === 'string' && value.processPath.length > 0
    && typeof value.displayId === 'string' && value.displayId.length > 0
}

export function createTargetLock(io: TargetLockIO, options: {
  platform?: SupportedPlatform
  lockId?: () => string
} = {}): TargetLockHandle {
  const platform = options.platform ?? platformOf()
  const nextId = options.lockId ?? randomUUID
  const locks = new Map<string, TargetLock>()
  const prune = (now: number): void => {
    for (const [id, lock] of locks) if (lock.expiresAt <= now) locks.delete(id)
  }
  return {
    async captureTargetLock(now) {
      if (platform !== 'win32') return null
      prune(now)
      let identity: TargetLockIdentity | null = null
      try { identity = await io.foregroundIdentity() } catch { return null }
      if (!validIdentity(identity)) return null
      const lock: TargetLock = { ...identity, lockId: nextId(), capturedAt: now, expiresAt: now + TARGET_LOCK_TTL_MS }
      locks.set(lock.lockId, lock)
      return lock
    },
    async resolveTargetLock(lockId, now) {
      if (platform !== 'win32') return null
      const lock = locks.get(lockId)
      if (!lock) return null
      if (now >= lock.expiresAt) { locks.delete(lockId); return null }
      let current: ProcessIdentityProbe | null = null
      try { current = await io.processIdentity(lock.pid) } catch { locks.delete(lockId); return null }
      // PID + 启动时间组合才是进程代次：pid 复用、进程重启、路径变化都失效。
      if (!current || current.alive !== true || current.processStartedAt !== lock.processStartedAt
        || current.processPath.toLowerCase() !== lock.processPath.toLowerCase()) {
        locks.delete(lockId)
        return null
      }
      return lock
    },
    invalidateAll() { locks.clear() },
  }
}

/**
 * 生产装配适配器：把 win-actions 的两个只读身份接口接成目标锁 IO。
 * 身份字段缺失（如拿不到进程启动时间）时返回 null，宁可缺锁也不猜。
 */
export function winActionsTargetLockIO(actions: Pick<WinDesktopActions, 'readForegroundIdentity' | 'readProcessIdentity'>): TargetLockIO {
  return {
    async foregroundIdentity() {
      const result = await actions.readForegroundIdentity()
      if (!result.ok) return null
      const identity = result.value
      if (!identity.processStartedAt || !identity.displayId) return null
      return { hwnd: identity.windowId, pid: identity.pid, processStartedAt: identity.processStartedAt,
        processPath: identity.processPath, displayId: identity.displayId }
    },
    async processIdentity(pid) {
      const result = await actions.readProcessIdentity(pid)
      if (!result.ok || !result.value.alive || !result.value.processStartedAt || !result.value.processPath) return null
      return { alive: true, processStartedAt: result.value.processStartedAt, processPath: result.value.processPath }
    },
  }
}