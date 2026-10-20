/**
 * 桌面动作的平台规格：命令形状、参数不拼接（含中文与空格路径）、能力开关。
 * 在 Windows 上验证 macOS 的命令拼法 —— 这只是规格测试，不代表 Mac 可用。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  desktopActionsDeviceVerified,
  openWithSpec,
  osascriptJxaSpec,
  supportsDesktopActions,
  supportsWpsControl,
  winUiaHelperSpec,
} from '../src/main/platform.ts'

const WPS = 'D:\\WPS Office\\12.1.0.28505\\office6\\wps.exe'
const CN_FILE = 'D:\\资料 文件夹\\合成 讲解 测试 "引号".pdf'

describe('platform：桌面动作能力开关', () => {
  test('Windows 与 macOS 有实现，Linux 没有', () => {
    assert.equal(supportsDesktopActions('win32'), true)
    assert.equal(supportsDesktopActions('darwin'), true)
    assert.equal(supportsDesktopActions('linux'), false)
    assert.equal(supportsWpsControl('linux'), false)
  })

  test('只有 Windows 在真机验证过；macOS 不得被当成已验证', () => {
    assert.equal(desktopActionsDeviceVerified('win32'), true)
    assert.equal(desktopActionsDeviceVerified('darwin'), false)
    assert.equal(desktopActionsDeviceVerified('linux'), false)
  })
})

describe('platform：UIA 辅助脚本', () => {
  test('命令行上只有脚本路径，没有请求内容', () => {
    const spec = winUiaHelperSpec('win32', 'C:\\app\\dist\\main')
    assert.ok(spec)
    assert.equal(spec.command, 'powershell')
    assert.deepEqual(spec.args, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', 'C:\\app\\dist\\main\\win-uia.ps1',
    ])
  })

  test('非 Windows 没有这个脚本', () => {
    assert.equal(winUiaHelperSpec('darwin', '/app'), null)
    assert.equal(winUiaHelperSpec('linux', '/app'), null)
  })
})

describe('platform：用指定应用打开', () => {
  test('Windows：exe 直接执行，含中文/空格/引号的路径是最后一个独立参数', () => {
    const spec = openWithSpec('win32', { executable: WPS, args: ['/prometheus', '/pdf'] }, CN_FILE)
    assert.ok(spec)
    assert.equal(spec.command, WPS)
    assert.deepEqual(spec.args, ['/prometheus', '/pdf', CN_FILE])
    assert.equal(spec.args.filter(a => a.includes('合成')).length, 1, '路径不被拆开')
  })

  test('Windows：相对路径、以 / 或 - 开头的"路径"一律拒绝（不会被 WPS 当成开关）', () => {
    for (const bad of ['a.pdf', '/pdf', '-x.pdf', '..\\a.pdf', 'D:a.pdf']) {
      assert.equal(openWithSpec('win32', { executable: WPS }, bad), null, bad)
    }
    assert.equal(openWithSpec('win32', { executable: 'wps.exe' }, CN_FILE), null, '应用也必须是绝对路径')
  })

  test('Windows：UNC 路径可以', () => {
    const spec = openWithSpec('win32', { executable: WPS }, '\\\\nas\\共享 盘\\a.pdf')
    assert.ok(spec)
    assert.deepEqual(spec.args, ['\\\\nas\\共享 盘\\a.pdf'])
  })

  test('macOS：优先按 bundle id，用 /usr/bin/open', () => {
    const file = '/Users/me/合成 讲解.pdf'
    const spec = openWithSpec('darwin', { executable: '/Applications/wpsoffice.app', bundleId: 'com.kingsoft.wpsoffice.mac' }, file)
    assert.deepEqual(spec, { command: '/usr/bin/open', args: ['-b', 'com.kingsoft.wpsoffice.mac', file] })
  })

  test('macOS：没有 bundle id 时按 .app 路径；非法 bundle id 不进命令行', () => {
    const file = '/Users/me/a.pdf'
    assert.deepEqual(openWithSpec('darwin', { executable: '/Applications/wpsoffice.app' }, file),
      { command: '/usr/bin/open', args: ['-a', '/Applications/wpsoffice.app', file] })
    assert.deepEqual(openWithSpec('darwin', { executable: '/Applications/wpsoffice.app', bundleId: 'x; rm -rf ~' }, file),
      { command: '/usr/bin/open', args: ['-a', '/Applications/wpsoffice.app', file] })
    assert.equal(openWithSpec('darwin', { executable: '/Applications/wpsoffice.app' }, '-a.pdf'), null)
  })

  test('Linux 没有实现', () => {
    assert.equal(openWithSpec('linux', { executable: '/usr/bin/wps' }, '/tmp/a.pdf'), null)
  })
})

describe('platform：osascript（JXA）', () => {
  test('脚本是常量，可变内容只走最后一个 JSON 参数', () => {
    const script = 'function run(argv){ return argv[1] }'
    const payload = JSON.stringify({ documentName: '合成 讲解"); do shell script "x' })
    const spec = osascriptJxaSpec('darwin', script, payload)
    assert.ok(spec)
    assert.equal(spec.command, '/usr/bin/osascript')
    assert.deepEqual(spec.args, ['-l', 'JavaScript', '-e', script, 'dsh-args', payload])
    assert.equal(spec.args[3], script, '脚本正文没有被插入任何内容')
  })

  test('非 macOS 返回 null', () => {
    assert.equal(osascriptJxaSpec('win32', 's', '{}'), null)
  })
})
