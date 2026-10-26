/**
 * 启动 Electron 桌面宠物。
 *
 * 直接 `electron .` 在从 DSH 桌面端（Electron 宿主）拉起的子进程树里会坏掉：
 * 宿主给自己的 CLI 子进程注入了 ELECTRON_RUN_AS_NODE=1，命令沿进程树继承，
 * Electron 于是以 Node 模式加载主进程，首屏就 `does not provide an export named 'BrowserWindow'`
 * 然后静默退出（桌面上表现为"召唤了但宠物一闪就没"）。
 *
 * 这里显式删掉该变量，再把 Electron 二进制路径交给 spawn，
 * 保证无论从哪里拉起桌宠，它都是真正的 GUI 进程。
 *
 * 召唤场景没有终端，stdio: inherit 等于把所有错误扔掉。这里的 stdout/stderr 一律落到
 * <DSH_HOME>/dsh-pet/launch.log：Win11 上闪退时，日志是唯一能说明原因的线索。
 */
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

/** electron 包的 CommonJS 入口在普通 Node 里导出可执行文件路径（在 Electron 主进程里才导出 API）。 */
const electron = require('electron')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const logDir = path.join(env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-pet')
let log = null
try {
  mkdirSync(logDir, { recursive: true })
  log = createWriteStream(path.join(logDir, 'launch.log'), { flags: 'a' })
  log.write(`\n===== ${new Date().toISOString()} launch ${electron} =====\n`)
} catch {
  // 写不了日志不影响启动本身。
}

const logLine = (text) => {
  try { log?.write(`${text}\n`) } catch { /* ignore */ }
}

const child = spawn(electron, ['.'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env,
})

child.stdout?.on('data', chunk => logLine(String(chunk).replace(/\n$/, '')))
child.stderr?.on('data', chunk => logLine(String(chunk).replace(/\n$/, '')))
child.on('error', (error) => {
  logLine(`[dsh-pet] spawn error: ${error instanceof Error ? error.message : String(error)}`)
})

child.on('exit', (code, signal) => {
  logLine(`[dsh-pet] exit code=${code} signal=${signal}`)
  try { log?.end() } catch { /* ignore */ }
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
