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
 *
 * Windows 11 的工作区目录可能带沙箱 ACL（Everyone: Deny DeleteSubdirectoriesAndFiles），
 * Electron 从工作区 node_modules 启动会以 STATUS_BREAKPOINT（-2147483645）崩溃。
 * 所以这里按候选顺序尝试：用户指定 / 上次成功的副本 / 工作区 / DSH 自带运行时 / 复制到用户目录的副本，
 * 崩溃时自动换下一个并记下选择，Win10 的普通环境仍然走工作区版本。
 */
import { spawn } from 'node:child_process'
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

/** electron 包的 CommonJS 入口在普通 Node 里导出可执行文件路径（在 Electron 主进程里才导出 API）。 */
const workspaceElectron = require('electron')
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const stateDir = path.join(dshHome, 'dsh-pet')
const cacheDir = path.join(stateDir, 'electron')
const choicePath = path.join(stateDir, 'electron.json')
const logPath = path.join(stateDir, 'launch.log')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

let log = null
try {
  mkdirSync(stateDir, { recursive: true })
  log = createWriteStream(logPath, { flags: 'a' })
  log.write(`\n===== ${new Date().toISOString()} launch =====\n`)
} catch {
  // 写不了日志不影响启动本身。
}
const logLine = (text) => {
  try { log?.write(`${text}\n`) } catch { /* ignore */ }
}
const finishLog = () => {
  try { log?.end() } catch { /* ignore */ }
}

/** 目录里 Electron 可执行文件的位置（目录指 electron 的 dist 根）。 */
function executableIn(dir) {
  if (process.platform === 'win32') return path.join(dir, 'electron.exe')
  if (process.platform === 'darwin') return path.join(dir, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  return path.join(dir, 'electron')
}

/** 找 DSH 运行时自带的 Electron：它的目录权限正常，不受工作区 ACL 影响。 */
function findRuntimeElectron() {
  const base = path.join(dshHome, 'dsh-runtimes')
  if (!existsSync(base)) return null
  try {
    for (const name of readdirSync(base)) {
      const candidate = executableIn(path.join(base, name, 'dependencies', 'electron'))
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // 读不了就当没有
  }
  return null
}

function readChoice() {
  try {
    const raw = JSON.parse(readFileSync(choicePath, 'utf8'))
    if (raw && typeof raw.exe === 'string' && existsSync(raw.exe)) return raw
  } catch {
    // 没有记录或文件损坏
  }
  return null
}

function writeChoice(candidate) {
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(choicePath, JSON.stringify({ exe: candidate.exe, source: candidate.source }, null, 2))
  } catch {
    // 记不住就下次再判断
  }
}

/** 把工作区的 Electron 复制到用户目录：这里没有沙箱 ACL，Electron 能正常初始化。 */
function prepareCachedElectron() {
  if (process.platform !== 'win32') throw new Error('cache copy is Windows-only')
  const distDir = path.dirname(workspaceElectron)
  mkdirSync(cacheDir, { recursive: true })
  cpSync(distDir, cacheDir, { recursive: true, force: true })
  const exe = executableIn(cacheDir)
  if (!existsSync(exe)) throw new Error(`cached electron missing: ${exe}`)
  return exe
}

const BREAKPOINT_CODES = new Set([-2147483645, 2147483651, 3221225477])
function looksCrashed(code, signal) {
  return signal === 'SIGTRAP' || signal === 'SIGILL' || BREAKPOINT_CODES.has(code)
}

const candidates = []
const add = (exe, source) => {
  if (typeof exe !== 'string' || exe.length === 0 || candidates.some(item => item.exe === exe)) return
  candidates.push({ exe, source })
}
const choice = readChoice()
if (choice) add(choice.exe, `choice:${choice.source}`)
add(process.env.DSH_PET_ELECTRON, 'env')
add(workspaceElectron, 'workspace')
add(findRuntimeElectron(), 'dsh-runtime')
const cached = executableIn(cacheDir)
if (existsSync(cached)) add(cached, 'cache')
else if (process.platform === 'win32') {
  candidates.push({ exe: cached, source: 'cache:copy', prepare: prepareCachedElectron })
}

function start(index) {
  const candidate = candidates[index]
  if (!candidate) {
    logLine('[dsh-pet] no usable electron candidate')
    finishLog()
    process.exit(1)
  }
  let exe = candidate.exe
  if (!existsSync(exe) && candidate.prepare) {
    try {
      logLine(`[dsh-pet] preparing ${candidate.source}`)
      exe = candidate.prepare()
      writeChoice({ exe, source: candidate.source })
    } catch (error) {
      logLine(`[dsh-pet] prepare failed (${candidate.source}): ${error instanceof Error ? error.message : String(error)}`)
      start(index + 1)
      return
    }
  }
  if (!existsSync(exe)) {
    start(index + 1)
    return
  }

  logLine(`[dsh-pet] launch (${candidate.source}) ${exe}`)
  let settled = false
  const child = spawn(exe, ['.'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  child.stdout?.on('data', chunk => logLine(String(chunk).replace(/\n$/, '')))
  child.stderr?.on('data', chunk => logLine(String(chunk).replace(/\n$/, '')))
  child.on('error', (error) => {
    if (settled) return
    settled = true
    logLine(`[dsh-pet] spawn error (${candidate.source}): ${error instanceof Error ? error.message : String(error)}`)
    start(index + 1)
  })
  child.on('exit', (code, signal) => {
    if (settled) return
    settled = true
    logLine(`[dsh-pet] exit (${candidate.source}) code=${code} signal=${signal}`)
    if (looksCrashed(code, signal) && index + 1 < candidates.length) {
      // 崩溃说明这个入口在当前机器上不可用；记下下一个成功的候选，避免每次召唤都重试。
      const next = candidates[index + 1]
      if (!next.prepare) writeChoice(next)
      start(index + 1)
      return
    }
    finishLog()
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
}

start(0)
