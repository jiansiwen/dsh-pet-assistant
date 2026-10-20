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
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** electron 包的 CommonJS 入口在普通 Node 里导出可执行文件路径（在 Electron 主进程里才导出 API）。 */
const electron = require('electron')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, ['.'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env,
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
