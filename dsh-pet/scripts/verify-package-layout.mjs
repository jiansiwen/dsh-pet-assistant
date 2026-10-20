/**
 * 打包产物的目录核对（M5-06）：electron-builder 出包之后，确认 asar 与 app.asar.unpacked 里该有的都在。
 *
 * 用法（在 dsh-pet 目录）：
 *   node scripts/verify-package-layout.mjs release/win-unpacked
 *   node scripts/verify-package-layout.mjs "release/mac-arm64/dsh 桌面助理团.app"
 *
 * 只读：解析 app.asar 的文件头（不解包），检查 app.asar.unpacked 里的真实文件，
 * 并用 runtime-launch.ts 的同一个 resolveCli 确认随包 dsh CLI 能被找到。不启动应用、不联网、
 * 不读用户数据。任何一项不过，退出码为 1。
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { resolveCli } from '../src/main/runtime-launch.ts'

const target = process.argv[2]
if (!target) {
  console.error('用法：node scripts/verify-package-layout.mjs <打包输出的应用目录，如 release/win-unpacked 或 .app>')
  process.exit(2)
}

const appRoot = path.resolve(target)
const isMacBundle = appRoot.endsWith('.app')
const resources = isMacBundle ? path.join(appRoot, 'Contents', 'Resources') : path.join(appRoot, 'resources')
const asarFile = path.join(resources, 'app.asar')
const unpackedDir = path.join(resources, 'app.asar.unpacked')

const results = []
function check(ok, label, detail = '') {
  results.push({ ok, label, detail })
}

/** asar 文件头：[4 字节 pickle 长度][4 字节头长度] + 头 pickle：[4 字节负载长度][4 字节 JSON 长度][JSON]。 */
function readAsarHeader(file) {
  const fd = openSync(file, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    readSync(fd, sizeBuf, 0, 8, 0)
    const headerSize = sizeBuf.readUInt32LE(4)
    const headerBuf = Buffer.alloc(headerSize)
    readSync(fd, headerBuf, 0, headerSize, 8)
    const jsonSize = headerBuf.readUInt32LE(4)
    return JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonSize))
  } finally {
    closeSync(fd)
  }
}

function entryOf(header, relative) {
  let node = header
  for (const part of relative.split('/')) {
    node = node?.files?.[part]
    if (!node) return null
  }
  return node
}

function* walk(node, prefix = '') {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const relative = prefix ? `${prefix}/${name}` : name
    if (child.files) yield* walk(child, relative)
    else yield [relative, child]
  }
}

const realFile = (relative) => {
  const file = path.join(unpackedDir, ...relative.split('/'))
  return existsSync(file) && statSync(file).isFile()
}

check(existsSync(resources), `resources 目录存在：${resources}`)
check(existsSync(asarFile), 'app.asar 存在（本应用的 dist 打进了归档）')
check(existsSync(unpackedDir), 'app.asar.unpacked 存在（外部读者要读的文件已解包）')

let header = null
if (existsSync(asarFile)) {
  try {
    header = readAsarHeader(asarFile)
  } catch (error) {
    check(false, 'app.asar 文件头可解析', String(error?.message ?? error))
  }
}

if (header) {
  for (const relative of ['package.json', 'dist/main/index.js', 'dist/renderer/index.html', 'dist/renderer/main.js', 'dist/preload/index.cjs', 'dist/assets/pointer-watch.ps1']) {
    check(entryOf(header, relative) !== null, `asar 里有 ${relative}`)
  }
  const ps1 = [...walk(header)].filter(([relative]) => relative.endsWith('.ps1'))
  check(ps1.length >= 8, `asar 里登记了 ${ps1.length} 个 .ps1（期望至少 8 个：dist/main 7 个 + pointer-watch）`)
  for (const [relative, entry] of ps1) {
    check(entry.unpacked === true && realFile(relative), `${relative} 已解包为真实文件（PowerShell 才读得到）`)
  }
  for (const relative of ['dist/main/doc-pdf-worker.js', 'dist/main/tts-edge-worker.js']) {
    check(entryOf(header, relative)?.unpacked === true && realFile(relative), `${relative} 已解包（worker / 子进程入口）`)
  }
  const leftovers = [...walk(header)].filter(([relative]) => relative.endsWith('.map') || relative.endsWith('.stale'))
  check(leftovers.length === 0, '包里没有 .map 与 .stale 旧帧', leftovers.slice(0, 5).map(([relative]) => relative).join(', '))

  const pkgEntry = entryOf(header, 'package.json')
  if (pkgEntry && !pkgEntry.unpacked && typeof pkgEntry.offset === 'string') {
    // 文件内容紧跟在头之后：起点 = 8 + 头长度 + offset。
    const fd = openSync(asarFile, 'r')
    try {
      const sizeBuf = Buffer.alloc(8)
      readSync(fd, sizeBuf, 0, 8, 0)
      const base = 8 + sizeBuf.readUInt32LE(4)
      const body = Buffer.alloc(pkgEntry.size)
      readSync(fd, body, 0, pkgEntry.size, base + Number(pkgEntry.offset))
      const pkg = JSON.parse(body.toString('utf8'))
      check(pkg.name === 'dsh-pet' && !('productName' in pkg), '打包后的 package.json：name 为 dsh-pet、没有 productName（userData 仍是 dsh-pet）', `name=${pkg.name} productName=${pkg.productName ?? '无'}`)
      check(pkg.main === 'dist/main/index.js', 'package.json 的 main 指向 dist/main/index.js', `main=${pkg.main}`)
    } finally {
      closeSync(fd)
    }
  }
}

// 原生模块：sherpa-onnx-node 本体 + 至少一个平台子包（.node 与同目录动态库）。
check(realFile('node_modules/sherpa-onnx-node/package.json'), 'sherpa-onnx-node 已解包')
const modulesDir = path.join(unpackedDir, 'node_modules')
const platformPackages = existsSync(modulesDir)
  ? readdirSync(modulesDir).filter(name => /^sherpa-onnx-(win|darwin|linux)-/.test(name))
  : []
check(platformPackages.length > 0, `找到 sherpa-onnx 平台子包：${platformPackages.join('、') || '无'}`)
for (const name of platformPackages) {
  const dir = path.join(modulesDir, name)
  const libs = readdirSync(dir).filter(file => /\.(dll|dylib|so)(\.|$)/.test(file))
  check(existsSync(path.join(dir, 'sherpa-onnx.node')) && libs.length > 0, `${name}：sherpa-onnx.node 与 ${libs.length} 个动态库在同一目录`)
}

// PDF.js：解析 worker 按文件读取的资源。
for (const relative of ['node_modules/pdfjs-dist/package.json', 'node_modules/pdfjs-dist/legacy/build/pdf.mjs', 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs']) {
  check(realFile(relative), `${relative} 已解包`)
}
for (const dir of ['cmaps', 'standard_fonts']) {
  const full = path.join(modulesDir, 'pdfjs-dist', dir)
  const count = existsSync(full) ? readdirSync(full).length : 0
  check(count > 0, `pdfjs-dist/${dir} 已解包（${count} 个文件）`)
}

// 随包 dsh CLI：用与运行时完全相同的查找函数，从真实目录里找。
const cli = existsSync(unpackedDir) ? resolveCli(unpackedDir) : null
check(cli !== null, `随包 dsh CLI 可在 app.asar.unpacked 里找到${cli ? `（${cli.version}，${cli.cliPath}）` : ''}`)

// 旧配置把素材整份拷进 resources/assets；现在不该再有这份重复拷贝。
check(!existsSync(path.join(resources, 'assets')), 'resources/assets 不存在（素材只在 asar 的 dist/assets 里一份）')

let failed = 0
for (const result of results) {
  if (!result.ok) failed += 1
  console.log(`${result.ok ? '✓' : '✗'} ${result.label}${result.detail ? `  —  ${result.detail}` : ''}`)
}
console.log(failed === 0 ? `\n全部 ${results.length} 项通过` : `\n${failed} / ${results.length} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
