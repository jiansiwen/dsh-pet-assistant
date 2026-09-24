/**
 * 平台差异的回归：在一台机器上把三种系统的命令拼法全跑一遍。
 *
 * 这个测试的价值在于**它能在 Windows 上验证 macOS 的行为**。跨平台改造最容易出的错是
 * "在开发机上一切正常、到了目标系统才发现命令名不对"，而那种错只有真机才能暴露 ——
 * 除非把拼法写成纯函数（`platform.ts` 就是这么做的），于是这里能提前钉住。
 *
 * 每个用例都断言**完整的命令形状**（可执行文件名 + 全部参数），不只断言"包含某个子串"：
 * 少了 `-Path`、多了个 `-File`，用户看到的都是"没声音"，而"没声音"不会告诉你哪里错了。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  playAudioSpec,
  platformOf,
  recordAudioSpec,
  speakOfflineSpec,
  supportsActivitySampling,
  supportsGlobalPointerWatch,
  supportsWakeWord,
} from '../src/main/platform.ts'

const DIR = '/app/dist/main'

describe('platform：平台归一化', () => {
  test('认识的三个平台各自成立', () => {
    assert.equal(platformOf('win32'), 'win32')
    assert.equal(platformOf('darwin'), 'darwin')
    assert.equal(platformOf('linux'), 'linux')
  })

  test('不认识的平台归到 linux（都是 POSIX）', () => {
    // 归到 linux 而不是新造一个 unknown：这些系统上「有没有实现」才是唯一要紧的问题，
    // 多一个分支到处判空只会让调用方写出一堆无意义的 if。
    assert.equal(platformOf('freebsd'), 'linux')
    assert.equal(platformOf('sunos'), 'linux')
    assert.equal(platformOf(''), 'linux')
  })
})

describe('platform：音频播放', () => {
  test('Windows 走 PowerShell 脚本，路径与参数完整', () => {
    const spec = playAudioSpec('win32', DIR, '/tmp/seg-1.mp3')
    assert.ok(spec)
    assert.equal(spec.command, 'powershell')
    assert.deepEqual(spec.args, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', `${DIR}/play.ps1`, '-Path', '/tmp/seg-1.mp3',
    ])
  })

  test('macOS 走系统自带的 afplay，不经过任何脚本', () => {
    const spec = playAudioSpec('darwin', DIR, '/tmp/seg-1.mp3')
    assert.ok(spec)
    assert.equal(spec.command, 'afplay')
    // afplay 只吃文件路径，没有类型参数 —— 它自己按扩展名识别格式。
    assert.deepEqual(spec.args, ['/tmp/seg-1.mp3'])
  })

  test('Linux 没有实现，如实返回 null', () => {
    assert.equal(playAudioSpec('linux', DIR, '/tmp/seg-1.mp3'), null)
  })
})

describe('platform：离线合成回退', () => {
  const TEXT = '断网时这句话也要念出来。'

  test('Windows 走 speak-once.ps1，文本经 base64 传（避免命令行编码问题）', () => {
    const spec = speakOfflineSpec('win32', DIR, TEXT, '/tmp/seg-1.wav')
    assert.ok(spec)
    assert.equal(spec.command, 'powershell')
    assert.deepEqual(spec.args, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', `${DIR}/speak-once.ps1`,
      '-B64', Buffer.from(TEXT, 'utf8').toString('base64'),
      '-OutPath', '/tmp/seg-1.wav',
    ])
  })

  test('Windows 的 base64 不含明文，命令行里读不到要说的话', () => {
    const spec = speakOfflineSpec('win32', DIR, TEXT, '/tmp/x.wav')
    assert.ok(spec)
    assert.equal(spec.args.some(arg => arg.includes(TEXT)), false, '明文不得出现在命令行')
  })

  test('macOS 走 say，文本原样作为参数（不经 shell，无注入面）', () => {
    const spec = speakOfflineSpec('darwin', DIR, TEXT, '/tmp/seg-1.wav')
    assert.ok(spec)
    assert.equal(spec.command, 'say')
    assert.deepEqual(spec.args, [TEXT])
  })

  test('macOS 上引号与换行不会被当成语法（参数是数组不是字符串）', () => {
    // 这条是"用数组而不是拼字符串"的直接理由：拼字符串时下面这段会被 shell 拆开，
    // 或者让 say 把引号念出来。
    const nasty = '他说："停一下"；然后\n换了一行。'
    const spec = speakOfflineSpec('darwin', DIR, nasty, '/tmp/x.wav')
    assert.ok(spec)
    assert.deepEqual(spec.args, [nasty], '整段文本必须作为一个完整参数传递')
  })

  test('Linux 没有实现', () => {
    assert.equal(speakOfflineSpec('linux', DIR, TEXT, '/tmp/x.wav'), null)
  })
})

describe('platform：录音回退', () => {
  test('Windows 走 record.ps1，时长以字符串传参', () => {
    const spec = recordAudioSpec('win32', DIR, '/tmp/d.wav', 12000)
    assert.ok(spec)
    assert.deepEqual(spec.args, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', `${DIR}/record.ps1`, '-OutPath', '/tmp/d.wav', '-MaxMs', '12000',
    ])
  })

  test('macOS 没有等价的系统命令，如实返回 null', () => {
    // 刻意不猜 ffmpeg/sox 的路径：猜错了会 spawn 失败，而失败原因会被用户读成"麦克风坏了"。
    assert.equal(recordAudioSpec('darwin', DIR, '/tmp/d.wav', 12000), null)
  })

  test('Linux 没有实现', () => {
    assert.equal(recordAudioSpec('linux', DIR, '/tmp/d.wav', 12000), null)
  })
})

describe('platform：能力开关', () => {
  test('全局鼠标监听只有 Windows 有', () => {
    assert.equal(supportsGlobalPointerWatch('win32'), true)
    assert.equal(supportsGlobalPointerWatch('darwin'), false)
    assert.equal(supportsGlobalPointerWatch('linux'), false)
  })

  test('唤醒词只有 Windows 有', () => {
    assert.equal(supportsWakeWord('win32'), true)
    assert.equal(supportsWakeWord('darwin'), false)
    assert.equal(supportsWakeWord('linux'), false)
  })

  test('活动采集只有 Windows 有', () => {
    assert.equal(supportsActivitySampling('win32'), true)
    assert.equal(supportsActivitySampling('darwin'), false)
    assert.equal(supportsActivitySampling('linux'), false)
  })
})

describe('platform：路径拼接不依赖运行平台', () => {
  test('Windows 目录用反斜杠，POSIX 目录用斜杠', () => {
    // 这里刻意不用 node:path.join：它的分隔符取决于**运行**平台，在 Windows 上
    // 测 darwin 的拼法会给出反斜杠，测试就假失败了。
    const win = playAudioSpec('win32', 'C:\\app\\dist\\main', 'C:\\tmp\\a.mp3')
    assert.ok(win)
    assert.ok(win.args.includes('C:\\app\\dist\\main\\play.ps1'), `实际：${win.args.join(' ')}`)

    const mac = playAudioSpec('darwin', '/app/dist/main', '/tmp/a.mp3')
    assert.ok(mac)
    assert.deepEqual(mac.args, ['/tmp/a.mp3'])
  })

  test('目录末尾已有分隔符时不重复加', () => {
    const spec = playAudioSpec('win32', '/app/dist/main/', '/tmp/a.mp3')
    assert.ok(spec)
    assert.ok(spec.args.includes('/app/dist/main/play.ps1'), `实际：${spec.args.join(' ')}`)
  })
})
