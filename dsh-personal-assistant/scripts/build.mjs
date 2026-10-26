/**
 * 插件构建脚本。
 *
 * 本机 QQ 电脑管家（QQPCRTP.exe）的实时防护会拦截 Go 程序（esbuild.exe）对**已存在文件**的
 * 覆盖写（首次新建不受影响），因此产物文件名带毫秒时间戳，写完后更新 package.json 的 main。
 *
 * ⚠️ **旧产物一律改名，绝不删除**（用户明确要求：任何文件都不许删）。
 *
 * 这条约束的来由：早期版本在这里调 `unlinkSync` 清理旧产物，实测会真删掉 dist 里的历史构建
 * ——2026-09-23 那次就删掉了 `index-0922190248.js` 与 `index-0922190302.js`，只能从回收站捞回来。
 * 而"哪个产物是好的"这件事**事后才知道**：某次构建引入的问题，往往要靠回退到上一个产物来定位。
 *
 * 做法：改名为 `<原名>.stale`。`.stale` 不匹配下面那个 `index-*.js` 的判据，
 * 所以下次构建不会再动它们，也不会被任何加载逻辑当成可用产物（`main` 只指向一个明确路径）。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
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
// 客户端入口也要能按包名解析；exports 与 main 必须指向同一个产物。
pkg.exports = {
  '.': `./dist/${outfile}`,
  './client': './dist/client.js',
  './package.json': './package.json',
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
console.log(`[dsh-personal-assistant] built dist/${outfile}, main updated`)

// 客户端插件：DSH 客户端加载器要求 window.__ModuleLoader__.load({ id, factory }) 包装，
// 而不是普通 ESM；React 与宿主包由模块表提供，其余全部打进产物。
{
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [path.join(root, 'src/client/index.tsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/*'],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  })
  const body = result.outputFiles[0].text
  const wrapped = [
    'window.__ModuleLoader__.load({',
    `  id: ${JSON.stringify(pkg.name)},`,
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    body,
    '    return module.exports;',
    '  },',
    '});',
    '',
  ].join('\n')
  writeFileSync(path.join(dist, 'client.js'), wrapped, 'utf8')
  console.log('[dsh-personal-assistant] built dist/client.js')
}

// 旧产物改名归档（保留 main 现指向的文件与本次构建产物）。
// 用 rename 而不是 unlink：见文件头那条约束的来由。
if (existsSync(dist)) {
  const keep = new Set([`dist/${outfile}`, previous].filter(Boolean))
  for (const name of readdirSync(dist)) {
    if (!name.startsWith('index-') || !name.endsWith('.js')) continue
    if (keep.has(`dist/${name}`)) continue
    try {
      renameSync(path.join(dist, name), path.join(dist, `${name}.stale`))
      console.log(`[dsh-personal-assistant] archived old artifact ${name} -> ${name}.stale`)
    } catch {
      // 被占用/权限拒绝：跳过，不影响本次构建
    }
  }
}
