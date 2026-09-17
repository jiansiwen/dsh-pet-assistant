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
    external: ['electron', '@deepseek-ai/*', 'sherpa-onnx-node', 'sherpa-onnx-win-x64'],
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
]

function copyStatic() {
  cpSync(path.join(root, 'src/renderer/index.html'), path.join(root, 'dist/renderer/index.html'))
  cpSync(path.join(root, 'src/renderer/approval.html'), path.join(root, 'dist/renderer/approval.html'))
  cpSync(path.join(root, 'src/renderer/styles.css'), path.join(root, 'dist/renderer/styles.css'))
  cpSync(path.join(root, 'assets'), path.join(root, 'dist/assets'), { recursive: true })
  cpSync(path.join(root, 'src/main/wake.ps1'), path.join(root, 'dist/main/wake.ps1'))
  cpSync(path.join(root, 'src/main/record.ps1'), path.join(root, 'dist/main/record.ps1'))
  cpSync(path.join(root, 'src/main/play.ps1'), path.join(root, 'dist/main/play.ps1'))
  cpSync(path.join(root, 'src/main/speak-once.ps1'), path.join(root, 'dist/main/speak-once.ps1'))
  cpSync(path.join(root, 'src/main/asr-wave.ps1'), path.join(root, 'dist/main/asr-wave.ps1'))
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
