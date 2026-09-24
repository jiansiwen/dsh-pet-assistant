/**
 * 常驻唤醒词监听：拉起 wake.ps1（Windows System.Speech 离线识别）持续听"小潘小潘"。
 * 词本身在 `wake-grammar.ps1` 里构造 —— 那份构造器同时被离线探针复用，改词只需改一处。
 * 进程意外退出时延迟自动重启；每次识别到唤醒词调用 onWake 回调。
 *
 * 起停由麦克风仲裁器（`audio.ts`）说了算，这个模块只管把进程跑起来。初始化失败会经 onLost
 * 报上去 —— 设备空出来了、而且短时间内不会自己好，这件事只有上层能决定怎么处置。
 *
 * **只在 Windows 上有实现**（`platform.ts` 的 `supportsWakeWord`）：System.Speech 的离线
 * 识别器是 Windows 专有的。别的系统上由调用方（`index.ts` 的 `applyAudio`）直接拦住，
 * 根本不会调到这里 —— 那里拦是因为在这里报"失败"会造成同步重入。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RESTART_DELAY_MS = 3000

let child: ChildProcess | null = null
let stopping = false
let restartTimer: NodeJS.Timeout | null = null

function start(onWake: (text: string) => void, onLost: (reason: string) => void): void {
  if (stopping) return
  const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wake.ps1')
  child = spawn(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  )
  const stdout = child.stdout
  if (stdout) {
    stdout.setEncoding('utf8')
    let buffer = ''
    stdout.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line.trim()) as { wake?: boolean; text?: string; ok?: boolean; error?: string }
          if (parsed.wake === true) {
            onWake(parsed.text ?? '')
          } else if (parsed.ok === false) {
            // 初始化失败（无麦克风/无中文语音包）：不重启，避免反复拉起进程
            stopping = true
            onLost(parsed.error ?? '语音识别初始化失败')
          }
        } catch {
          // 非 JSON 行跳过
        }
      }
    })
  }
  child.on('exit', () => {
    child = null
    if (!stopping) {
      restartTimer = setTimeout(() => start(onWake, onLost), RESTART_DELAY_MS)
    }
  })
  child.on('error', () => {
    // 拉起失败：交给 exit 事件决定是否重启
  })
}

export function startWakeListener(onWake: (text: string) => void, onLost: (reason: string) => void): void {
  stopping = false
  start(onWake, onLost)
}

export function stopWakeListener(): void {
  stopping = true
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (child) {
    try {
      child.kill()
    } catch {
      // 已退出
    }
    child = null
  }
}
