/**
 * 构建脚本：esbuild 分别打包 main / preload / renderer。
 * 用法：node scripts/build.mjs [--watch]
 */
import * as esbuild from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')

mkdirSync(path.join(root, 'dist/renderer'), { recursive: true })
mkdirSync(path.join(root, 'dist/assets'), { recursive: true })

const targets = [
  {
    name: 'main',
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(root, 'dist/main/index.js'),
    platform: 'node',
    format: 'esm',
    // sherpa-onnx 系列是 N-API 原生模块，必须 external（bundle 内联会丢 .node 二进制）。
    // ws 同理必须 external：它是 CJS 包，被 ESM bundle 内联后其内部的动态 require("events")
    // 会在运行时炸掉（Error: Dynamic require of "events" is not supported）。
    external: ['electron', '@deepseek-ai/*', 'sherpa-onnx-node', 'sherpa-onnx-win-x64', 'pdfjs-dist', 'ws'],
  },
  {
    // PDF.js 与其 worker/CMap/标准字体保留在同一外部依赖包内，不拷贝素材或加载远端 CDN。
    name: 'pdf-worker',
    entryPoints: [path.join(root, 'src/main/doc-pdf-worker.ts')],
    outfile: path.join(root, 'dist/main/doc-pdf-worker.js'),
    platform: 'node',
    format: 'esm',
    external: ['pdfjs-dist'],
  },
  {
    // TTS worker 独立进程：以 ELECTRON_RUN_AS_NODE 跑，stdin/stdout 与 Narrator 对话，
    // 内部连 edge-tts 合成、回退 System.Speech、经 play.ps1 播放。不是 electron 模块。
    // ws 保持外部依赖：CJS 包被 ESM bundle 内联时动态 require 会炸。
    name: 'tts-worker',
    entryPoints: [path.join(root, 'src/main/tts-edge-worker.ts')],
    outfile: path.join(root, 'dist/main/tts-edge-worker.js'),
    platform: 'node',
    format: 'esm',
    external: ['electron', '@deepseek-ai/*', 'ws'],
  },
  {
    name: 'preload',
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(root, 'dist/preload/index.cjs'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    // 审批窗口的 preload 单独打包：它只暴露读卡片与提交决定两个接口，
    // 和舞台那个二十来个方法的 petApi 混在一起就失去意义了。
    name: 'approval-preload',
    entryPoints: [path.join(root, 'src/preload/approval.ts')],
    outfile: path.join(root, 'dist/preload/approval.cjs'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    // 阅读视图窗口的 preload：只暴露凭令牌取会话/字节/页许可/随包字体与回报用户动作，没有任何路径接口。
    name: 'doc-view-preload',
    entryPoints: [path.join(root, 'src/preload/doc-view.ts')],
    outfile: path.join(root, 'dist/preload/doc-view.cjs'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    name: 'renderer',
    entryPoints: [path.join(root, 'src/renderer/main.tsx')],
    outfile: path.join(root, 'dist/renderer/main.js'),
    platform: 'browser',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
  },
  {
    // 审批页面单独打包，不与舞台共用产物：这个窗口不加载角色包（形象、皮肤、动画），
    // 共用一个 bundle 就等于把那些资源全搬进批准签发口。
    // esbuild 会顺带产出 dist/renderer/approval.css，正是 approval.html 链接的那个文件名。
    name: 'approval-renderer',
    entryPoints: [path.join(root, 'src/renderer/approval-main.tsx')],
    outfile: path.join(root, 'dist/renderer/approval.js'),
    platform: 'browser',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
  },
  {
    // 阅读视图页面单独打包，pdf.js 及其解析端一并内联、在页面线程内运行：
    // 不拷贝 worker 脚本、不从 CDN 取任何东西，CSP 只需 'self'。产物附带 dist/renderer/doc-view.css。
    name: 'doc-view-renderer',
    entryPoints: [path.join(root, 'src/renderer/doc-view-main.tsx')],
    outfile: path.join(root, 'dist/renderer/doc-view.js'),
    platform: 'browser',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
  },
  {
    // 日报工作台的 preload：只有读视图、逐条修订、请求发布/删除、导入文件与请求发送授权，没有任何批准接口。
    name: 'report-workbench-preload',
    entryPoints: [path.join(root, 'src/preload/report-workbench.ts')],
    outfile: path.join(root, 'dist/preload/report-workbench.cjs'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    // 日报工作台页面单独打包；产物附带 dist/renderer/report-workbench.css，正是 report-workbench.html 链接的文件名。
    name: 'report-workbench-renderer',
    entryPoints: [path.join(root, 'src/renderer/report-workbench-main.tsx')],
    outfile: path.join(root, 'dist/renderer/report-workbench.js'),
    platform: 'browser',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
  },
]

function copyStatic() {
  cpSync(path.join(root, 'src/renderer/index.html'), path.join(root, 'dist/renderer/index.html'))
  cpSync(path.join(root, 'src/renderer/approval.html'), path.join(root, 'dist/renderer/approval.html'))
  cpSync(path.join(root, 'src/renderer/doc-view.html'), path.join(root, 'dist/renderer/doc-view.html'))
  cpSync(path.join(root, 'src/renderer/report-workbench.html'), path.join(root, 'dist/renderer/report-workbench.html'))
  cpSync(path.join(root, 'src/renderer/styles.css'), path.join(root, 'dist/renderer/styles.css'))
  // ⚠️ 这里只做「覆盖拷贝」，**不删除**目标里多余的文件。
  //
  // 但动作素材是按 `frames/<skin>/<action>/fNNN.png` 逐帧探测的（FRAME_MAX = 96，
  // 遇到第一个缺失才停），所以旧素材多出来的尾巴会让引擎多探到几十帧，
  // 播起来变成「先播新版、再播旧版」——同一动作冒出两种形态。
  //
  // 清理由单独的脚本负责（不在这里删除东西）：
  //   python tools/matting/sync-frames.py
  // 它会把 dist 里多余的帧改名为 `*.stale`（引擎探测不到，文件也不丢）。
  cpSync(path.join(root, 'assets'), path.join(root, 'dist/assets'), { recursive: true })
  cpSync(path.join(root, 'src/main/wake.ps1'), path.join(root, 'dist/main/wake.ps1'))
  // 唤醒词的 grammar 构造器：wake.ps1 用点源加载它，不拷过去运行时就会 grammar-failed。
  // 单独成文件是为了让离线探针（_verify/wake-grammar-probe.ps1）用同一份构造器，
  // 否则探针验的是一份可能已经漂移的副本。
  cpSync(path.join(root, 'src/main/wake-grammar.ps1'), path.join(root, 'dist/main/wake-grammar.ps1'))
  cpSync(path.join(root, 'src/main/record.ps1'), path.join(root, 'dist/main/record.ps1'))
  cpSync(path.join(root, 'src/main/play.ps1'), path.join(root, 'dist/main/play.ps1'))
  // 常驻播放进程：唤醒应答走它，省掉每次 2 秒以上的 PowerShell 冷启动。
  cpSync(path.join(root, 'src/main/play-host.ps1'), path.join(root, 'dist/main/play-host.ps1'))
  cpSync(path.join(root, 'src/main/speak-once.ps1'), path.join(root, 'dist/main/speak-once.ps1'))
  cpSync(path.join(root, 'src/main/asr-wave.ps1'), path.join(root, 'dist/main/asr-wave.ps1'))
  // 桌面动作（窗口识别 / WPS 翻页）的 UI Automation 辅助脚本，由 win-actions.ts 常驻启动。
  cpSync(path.join(root, 'src/main/win-uia.ps1'), path.join(root, 'dist/main/win-uia.ps1'))
}

function esbuildOptions(target) {
  const { name: _name, ...rest } = target
  return {
    bundle: true,
    logLevel: 'info',
    sourcemap: false,
    target: rest.platform === 'browser' ? 'chrome120' : 'node22',
    ...rest,
  }
}

if (watch) {
  const contexts = await Promise.all(targets.map(target => esbuild.context(esbuildOptions(target))))
  await Promise.all(contexts.map(context => context.watch()))
  copyStatic()
  console.log('[dsh-pet] watching... 构建产物在 dist/，用 `npx electron .` 启动')
} else {
  for (const target of targets) {
    await esbuild.build(esbuildOptions(target))
  }
  copyStatic()
  console.log('[dsh-pet] build done')
}
