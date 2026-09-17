/**
 * 插件构建脚本。
 *
 * 本机 QQ 电脑管家（QQPCRTP.exe）的实时防护会拦截 Go 程序（esbuild.exe）对**已存在文件**的
 * 覆盖写（首次新建不受影响），因此产物文件名带毫秒时间戳，写完后更新 package.json 的 main。
 * dist 下会累积旧产物，可用 `npm run clean` 清理（保留 main 指向的最新一个）。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dist = path.join(root, 'dist')

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(4, 14)
const outfile = `index-${stamp}.js`

execFileSync(
  process.execPath,
  [
    path.join(root, 'node_modules', '.pnpm', 'esbuild@0.27.7', 'node_modules', 'esbuild', 'bin', 'esbuild'),
    'src/index.ts', '--bundle', '--format=esm', '--platform=node', '--target=node22',
    `--outfile=dist/${outfile}`,
    '--external:@deepseek-ai/*', '--external:zod', '--external:node:*',
  ],
  { stdio: 'inherit', cwd: root },
)

const pkgPath = path.join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const previous = typeof pkg.main === 'string' ? pkg.main : ''
pkg.main = `dist/${outfile}`
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
console.log(`[dsh-personal-assistant] built dist/${outfile}, main updated`)

// 清理旧产物（保留 main 现指向的文件与本次构建产物）
if (existsSync(dist)) {
  const keep = new Set([`dist/${outfile}`, previous].filter(Boolean))
  for (const name of readdirSync(dist)) {
    if (!name.startsWith('index-') || !name.endsWith('.js')) continue
    if (keep.has(`dist/${name}`)) continue
    try {
      unlinkSync(path.join(dist, name))
      console.log(`[dsh-personal-assistant] cleaned old artifact ${name}`)
    } catch {
      // 被占用/权限拒绝：跳过，不影响本次构建
    }
  }
}
