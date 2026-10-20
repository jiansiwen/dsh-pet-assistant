/**
 * 打包路径接线的守卫。
 *
 * 这一组测试检查的是"**调用点有没有真的接上**"，而不是 `toUnpackedPath` 本身算得对不对
 * （那个在 `runtime-launch.test.ts` 里已经覆盖得很细）。
 *
 * 为什么需要它：打包后主进程代码在 `app.asar` 里，而 PowerShell、worker 线程、
 * `ELECTRON_RUN_AS_NODE` 子进程都**没有 asar 文件补丁**。任何一处漏接线，表现都是
 * "开发态完全正常、装上就某个功能失灵"——语音不出声、唤醒起不来、PDF 讲解打不开。
 * 这类问题只有真的打一次包才会暴露，而打包需要用户授权（见 packaging-checklist.md），
 * 所以用静态守卫把"漏接线"提前挡在测试里。
 *
 * 写法上刻意按**文件 + 特征片段**断言，而不是跑一遍模块：模块里的 `import.meta.url`
 * 在测试进程里永远是源码目录，构造不出 asar 场景。守卫的价值在于"改动把接线去掉了就红"。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { toUnpackedPath } from '../src/main/runtime-launch.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main')

function source(file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

/** 把注释与行注释去掉后再比对，避免"只是注释里提到"也当成接线。 */
function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

/**
 * 取"引用了某个文件名的那一行代码"。
 *
 * 按行断言而不是写跨行正则：这些调用点的参数里有嵌套调用（`fileURLToPath(import.meta.url)`），
 * `[^)]*` 那种写法会在第一个右括号处断掉，于是明明接了线也判红。
 */
function lineReferencing(file: string, needle: string): string {
  const hit = code(file)
    .split('\n')
    .find(line => line.includes(needle))
  assert.ok(hit, `${file} 里找不到引用 ${needle} 的代码行`)
  return hit
}

describe('打包路径接线：交给外部读者的路径都要经过解包', () => {
  test('wake.ts：唤醒脚本走解包路径', () => {
    const line = lineReferencing('wake.ts', "'wake.ps1'")
    assert.ok(line.includes('toUnpackedPath'), `wake.ps1 必须套 toUnpackedPath，实际：${line.trim()}`)
  })

  test('asr.ts：旧识别引擎脚本走解包路径', () => {
    const line = lineReferencing('asr.ts', "'asr-wave.ps1'")
    assert.ok(line.includes('toUnpackedPath'), `asr-wave.ps1 必须套 toUnpackedPath，实际：${line.trim()}`)
  })

  test('tts.ts：合成 worker 入口走解包路径', () => {
    const line = lineReferencing('tts.ts', "'tts-edge-worker.js'")
    assert.ok(
      line.includes('toUnpackedPath'),
      `tts-edge-worker.js 以子进程运行，必须从解包目录启动，实际：${line.trim()}`,
    )
  })

  test('doc-pdf.ts：PDF worker 从解包目录启动，开发态仍走 .ts', () => {
    const text = code('doc-pdf.ts')
    assert.match(text, /toUnpackedPath\(fileURLToPath\(workerUrl\)\)/, 'doc-pdf-worker.js 必须走解包路径')
    // 开发态那一条不能被顺手改掉：node --test 直接跑 TypeScript，没有 .js 产物。
    assert.match(text, /endsWith\('\.ts'\) \? workerUrl :/, '开发态的 .ts 分支必须保留')
  })

  test('kws.ts / diarize.ts：createRequire 的基点走解包路径', () => {
    for (const file of ['kws.ts', 'diarize.ts']) {
      const text = code(file)
      assert.match(
        text,
        /const MODULE_BASE = toUnpackedPath\(fileURLToPath\(import\.meta\.url\)\)/,
        `${file} 的 MODULE_BASE 必须指向解包后的真实文件，否则 worker 里 require 不到 sherpa`,
      )
    }
  })

  test('index.ts：脚本目录与鼠标监听脚本都用布局算出的真实目录', () => {
    const text = code('index.ts')
    assert.match(text, /const layout = resolveLayout\(\)/, 'index.ts 必须解析一次布局')
    assert.match(text, /scriptDir: layout\.scriptDir/, 'WPS 控制脚本目录必须是 layout.scriptDir')
    assert.match(text, /recordAudioSpec\(platformOf\(\), layout\.scriptDir,/, '录音回退脚本目录必须是 layout.scriptDir')
    assert.match(
      text,
      /path\.join\(layout\.scriptDir, '\.\.', 'assets', 'pointer-watch\.ps1'\)/,
      'pointer-watch.ps1 由 PowerShell 执行，必须从解包目录取',
    )
    // 旧的 `here` 直传在打包后会指到 asar 里，不能再出现在这三处。
    assert.equal(/scriptDir: here/.test(text), false, 'WPS 脚本目录不能再直接用 here')
    assert.equal(/recordAudioSpec\(platformOf\(\), here,/.test(text), false, '录音脚本目录不能再直接用 here')
    assert.equal(/path\.join\(here, '\.\.\/assets\/pointer-watch\.ps1'\)/.test(text), false, '鼠标监听脚本不能再直接用 here')
  })

  test('companion-host.ts：随包 CLI 从解包后的应用根找，并把 packaged 传下去', () => {
    const text = code('companion-host.ts')
    assert.match(text, /appDir: layout\.realAppDir/, '随包 dsh CLI 必须从 realAppDir 找')
    assert.match(text, /packaged: layout\.packaged/, 'packaged 要传给 planRuntimeLaunch，失败时的下一步才说得对')
    assert.equal(/appDir: path\.resolve\(this\.options\.mainDir, '\.\.\/\.\.'\)/.test(text), false,
      '不能再靠 mainDir 往上两级推应用根')
  })
})

describe('打包路径：开发态行为不变', () => {
  test('源码目录里没有 .asar 段，解包函数原样返回', () => {
    // 这是"接线不影响开发态"的根本保证：所有接线都靠这一个纯函数。
    const devMain = path.join('D:', 'work', 'dsh-pet', 'dist', 'main')
    for (const name of ['wake.ps1', 'asr-wave.ps1', 'tts-edge-worker.js', 'doc-pdf-worker.js', 'win-uia.ps1']) {
      const file = path.join(devMain, name)
      assert.equal(toUnpackedPath(file), file, `${name} 在开发态不该被改写`)
    }
  })

  test('打包态每个脚本都落到 .asar.unpacked 里的同名文件', () => {
    const resources = path.join('C:', 'Users', 'u', 'AppData', 'Local', 'Programs', 'dsh', 'resources')
    const packedMain = path.join(resources, 'app.asar', 'dist', 'main')
    for (const name of ['wake.ps1', 'asr-wave.ps1', 'tts-edge-worker.js', 'doc-pdf-worker.js', 'win-uia.ps1']) {
      assert.equal(
        toUnpackedPath(path.join(packedMain, name)),
        path.join(resources, 'app.asar.unpacked', 'dist', 'main', name),
      )
    }
    // pointer-watch.ps1 在 dist/assets 下，打包配置里单独解包了 dist/assets/*.ps1。
    assert.equal(
      toUnpackedPath(path.join(resources, 'app.asar', 'dist', 'assets', 'pointer-watch.ps1')),
      path.join(resources, 'app.asar.unpacked', 'dist', 'assets', 'pointer-watch.ps1'),
    )
  })
})
