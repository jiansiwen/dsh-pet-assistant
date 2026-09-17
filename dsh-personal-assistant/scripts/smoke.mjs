/**
 * 冒烟验证运行器：把 scripts/smoke.ts 打成临时 bundle 后执行。
 *
 * 为什么不用 node 直接跑 .ts：源码里的服务类用了 TS 参数属性（constructor(private readonly …)），
 * node 的类型擦除不支持这类需要真正改写语法的特性。
 *
 * bundle 落在包内的 node_modules/.dsh-smoke 而不是系统临时目录：桥接源码在运行时
 * 真的要 import `@deepseek-ai/dsh-llm`（不是纯类型），而 external 出来的裸标识符是按
 * **产物文件所在位置**向上找 node_modules 的，放在临时目录里会直接 ERR_MODULE_NOT_FOUND。
 * 每次用带时间戳的新文件名，避免撞上本机实时防护对「覆盖已存在文件」的拦截；结束即删。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = path.join(root, 'node_modules', '.dsh-smoke')
const outfile = path.join(outDir, `smoke-${Date.now().toString(36)}.mjs`)
mkdirSync(outDir, { recursive: true })

try {
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules', '.pnpm', 'esbuild@0.27.7', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      'scripts/smoke.ts', '--bundle', '--format=esm', '--platform=node', '--target=node22',
      `--outfile=${outfile}`,
      '--external:@deepseek-ai/*', '--external:zod', '--external:node:*',
    ],
    { stdio: 'inherit', cwd: root },
  )
  const { run } = await import(pathToFileURL(outfile).href)
  await run()
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
