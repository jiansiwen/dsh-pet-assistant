/**
 * Windows 前台窗口采样器：作为插件的**托管子进程**启动（不再 `cmd /c start` 分离），
 * 样本以 JSONL 追加写入 <sampleDir>/<yyyy-MM-dd>.jsonl，自身 PID 写入 <sampleDir>/sampler.pid。
 *
 * 生命周期约定：采样器跟随插件存活。插件卸载（web 服务停止 / profile 卸载）时由
 * ActivityTracker.dispose() 主动 kill，不再遗留孤儿进程。
 * PID 文件仅用于诊断与陈旧进程排查，不作为存活判据（以子进程句柄为准）。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, fstatSync, openSync, readSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface Sample {
  /** epoch 毫秒。 */
  ts: number
  idle?: boolean
  excluded?: boolean
  pid?: number
  proc?: string
  title?: string
  /**
   * 距上次键鼠输入的毫秒数（GetLastInputInfo，纯数值无隐私）。
   * 旧采样器或该次调用失败时缺省；主动提醒（proactive.ts）只认这个字段，
   * 缺了就宁可不提醒 —— 拿不到真实空闲指标就不猜。
   */
  idleMs?: number
}

function pidFilePath(sampleDir: string): string {
  return path.join(sampleDir, 'sampler.pid')
}

/** 读取采样脚本自行写入的 PID 文件（仅诊断用，不作存活判据）。 */
export function readPidFile(sampleDir: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(pidFilePath(sampleDir), 'utf8').trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** 一个受插件托管的采样进程句柄。 */
export interface SamplerProcess {
  /** 子进程 pid。 */
  readonly pid: number
  /** 子进程是否仍在运行。 */
  readonly alive: boolean
  /** 终止采样进程（含进程树）；已退出时静默返回。 */
  kill(): void
}

/** 启动采样进程时可配置的分级授权。 */
export interface SamplerOptions {
  /**
   * 是否采集前台窗口标题。关闭时采样脚本压根不调用 GetWindowText，
   * 因此未授权的标题不会先落进 JSONL 再被过滤——分级授权必须落在采集侧。
   */
  readonly captureTitles: boolean
  readonly excludedProcesses?: readonly string[]
  readonly excludedTitleKeywords?: readonly string[]
}

/**
 * 启动托管采样进程。
 *
 * 与旧实现的差异：不再通过 `cmd /c start` 分离、不再 `unref()`，
 * 因此子进程属于插件进程树，插件卸载时可被确定性回收。
 * 采样脚本仍会把自己的 PID 写入 sampler.pid 供诊断使用。
 */
export function launchSampler(
  scriptPath: string,
  sampleDir: string,
  intervalMs: number,
  options: SamplerOptions,
): SamplerProcess {
  try {
    unlinkSync(pidFilePath(sampleDir))
  } catch {
    // 首次启动无旧文件
  }
  const child = spawn(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    {
      stdio: 'ignore',
      windowsHide: true,
      // 非 detached、不 unref：子进程生命周期绑定在插件进程上。
      env: {
        ...process.env,
        DSH_SAMPLE_DIR: sampleDir,
        DSH_SAMPLE_INTERVAL_MS: String(intervalMs),
        DSH_SAMPLE_TITLES: options.captureTitles ? '1' : '0',
        DSH_SAMPLE_EXCLUDED_PROCESSES: JSON.stringify(options.excludedProcesses ?? []),
        DSH_SAMPLE_EXCLUDED_TITLES: JSON.stringify(options.excludedTitleKeywords ?? []),
      },
    },
  )
  if (child.pid === undefined) {
    throw new Error('sampler process failed to start (no pid)')
  }
  return wrapSamplerChild(child)
}

/** 把子进程包装成可查询、可终止的采样句柄。 */
function wrapSamplerChild(child: ChildProcess): SamplerProcess {
  const pid = child.pid as number
  let killed = false
  return {
    pid,
    get alive(): boolean {
      return !killed && child.exitCode === null && child.signalCode === null
    },
    kill(): void {
      if (killed) return
      killed = true
      if (child.exitCode !== null || child.signalCode !== null) return
      // Windows 上 `taskkill /T` 才能带走整棵进程树（PowerShell 会再拉起识别器子进程）；
      // POSIX 上直接给子进程发信号即可 —— 那里没有 taskkill，硬调只会 spawn 失败一次。
      if (process.platform === 'win32') {
        try {
          const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          })
          if (result.status === 0) return
        } catch {
          // taskkill 不可用（非 Windows 或 PATH 里没有）时走下面的兜底
        }
      }
      try {
        child.kill()
      } catch {
        // 进程可能已退出
      }
    },
  }
}

/** 终止采样进程（含子树）；进程已不存在时静默返回。 */
export function killSampler(pid: number): void {
  if (process.platform !== 'win32') {
    // 没有进程句柄时（插件重载后只剩 pid）只能按 pid 发信号。
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 进程可能已退出
    }
    return
  }
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } catch {
    // 进程可能已退出
  }
}

/** 判断 pid 对应的进程是否存活。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 读取并解析一天的采样日志；文件不存在返回空数组。 */
export function readSamples(filePath: string): Sample[] {
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  const samples: Sample[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const sample = JSON.parse(trimmed) as Sample
      if (typeof sample.ts === 'number') samples.push(sample)
    } catch {
      // 损坏行跳过
    }
  }
  return samples
}

/** 采样原文的严格命名。同目录下的 sampler.pid 之类不匹配，因此不会被保留期清理误删。 */
const SAMPLE_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/**
 * 删除某一天采样原文里落在 [startMs, endMs) 的样本，返回删除条数。
 * 调用方必须先停掉采样进程：边重写边追加会丢新样本或留下半行。
 */
export function pruneSampleRange(filePath: string, startMs: number, endMs: number): number {
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return 0
  }
  const kept: string[] = []
  let removed = 0
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let ts: unknown
    try {
      ts = (JSON.parse(trimmed) as Sample).ts
    } catch {
      kept.push(trimmed)
      continue
    }
    if (typeof ts === 'number' && ts >= startMs && ts < endMs) removed += 1
    else kept.push(trimmed)
  }
  if (removed === 0) return 0
  writeFileSync(filePath, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8')
  return removed
}

/** 只读文件尾部这么多字节来找最新一条采样；一天的 JSONL 有上万行，全读只为一拍太浪费。 */
const TAIL_BYTES = 8192

/**
 * 读取最新一条采样。文件不存在、全空、或尾部全是损坏行时返回 null。
 *
 * 尾部窗口的第一行可能是被截断的半行（窗口没有覆盖整个文件时），从第二条开始找；
 * 窗口覆盖整个文件时第一条就是完整的。
 */
export function readLastSample(filePath: string): Sample | null {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return null
  }
  try {
    const size = fstatSync(fd).size
    if (size === 0) return null
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    const firstUsable = length < size ? 1 : 0
    for (let i = lines.length - 1; i >= firstUsable; i -= 1) {
      const trimmed = lines[i].trim()
      if (!trimmed) continue
      try {
        const sample = JSON.parse(trimmed) as Sample
        if (typeof sample.ts === 'number') return sample
      } catch {
        // 损坏行跳过，继续往前找
      }
    }
    return null
  } finally {
    closeSync(fd)
  }
}

/** 某天采样原文的路径。 */
export function sampleFileOf(sampleDir: string, date: string): string {
  return path.join(sampleDir, `${date}.jsonl`)
}

/** 有采样原文的日期列表，升序；目录不存在返回空数组。 */
export function listSampleDates(sampleDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(sampleDir)
  } catch {
    return []
  }
  return names
    .map(name => SAMPLE_FILE.exec(name)?.[1])
    .filter((date): date is string => typeof date === 'string')
    .sort()
}

/**
 * 删除保留期之外的采样原文，返回真被删掉的日期。
 *
 * 保留期必须真的删文件：原始活动里最敏感的就是窗口标题，只删库里的派生观察、
 * 把 JSONL 留在磁盘上，那"保留 7 天"就是一句空话。
 * keepFromDate 当天及之后一律保留；单个文件删失败（被采样进程占着）不影响其余文件。
 */
export function pruneSampleFiles(sampleDir: string, keepFromDate: string): string[] {
  const deleted: string[] = []
  for (const date of listSampleDates(sampleDir)) {
    if (date >= keepFromDate) continue
    try {
      unlinkSync(sampleFileOf(sampleDir, date))
      deleted.push(date)
    } catch {
      // 文件可能刚被采样进程重建，或者已经被用户手动删掉；下次清理会再试。
    }
  }
  return deleted
}
