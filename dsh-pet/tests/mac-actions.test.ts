/**
 * macOS 动作层：只做命令规格与解析测试（在 Windows 上跑）。**不代表 Mac 可用** ——
 * 真机验证步骤见 petsBak/dsh-pet/mac-verification-actions-wps.md。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { WindowIdentity } from '../src/main/desktop-actions.ts'
import {
  classifyMacFailure,
  createMacActions,
  MAC_CAPABILITY_NEEDS,
  MAC_JXA_SCRIPT,
  MAC_PERMISSION_GUIDANCE,
  macCapabilities,
  parseMacOutput,
  type MacRunner,
} from '../src/main/mac-actions.ts'
import type { CommandSpec } from '../src/main/platform.ts'

const APP = '/Applications/wpsoffice.app'
const DOC = '合成 讲解 测试.pdf'
const ID: WindowIdentity = { platform: 'darwin', pid: 4242, windowId: `ax-title:${DOC}`, title: DOC, processPath: APP, processStartedAt: '1760000000.5', documentName: DOC }
const fgTarget = { isTarget: true, pid: 4242, isOwner: false, isDialogOfTarget: false }

function runnerReturning(out: Record<string, unknown> | string, extra: Partial<{ code: number; stderr: string; timedOut: boolean }> = {}) {
  const calls: { spec: CommandSpec; timeoutMs: number }[] = []
  const run: MacRunner = async (spec, timeoutMs) => {
    calls.push({ spec, timeoutMs })
    return { code: extra.code ?? 0, stdout: typeof out === 'string' ? out : `${JSON.stringify(out)}\n`, stderr: extra.stderr ?? '', timedOut: extra.timedOut ?? false }
  }
  return { run, calls }
}

describe('mac-actions：三种权限分开', () => {
  test('缺辅助功能：读页/翻页/滚动/读文字/识别窗口不可用；打开与激活不受影响；只读标题识别仍可用', () => {
    const caps = macCapabilities({ accessibility: 'denied', automation: 'granted', 'screen-recording': 'granted' })
    for (const c of ['readPage', 'gotoPage', 'scroll', 'readVisibleText', 'findWindow', 'raiseWindow'] as const) {
      assert.equal(caps[c].available, false, c)
      assert.deepEqual(caps[c].missing, ['accessibility'])
    }
    assert.equal(caps.openWith.available, true)
    assert.equal(caps.activateApp.available, true)
    assert.equal(caps.findWindowTitlesOnly.available, true)
  })

  test('缺自动化：同样禁用界面脚本，但缺的项标为 automation', () => {
    const caps = macCapabilities({ accessibility: 'granted', automation: 'denied', 'screen-recording': 'denied' })
    assert.deepEqual(caps.gotoPage.missing, ['automation'])
    assert.deepEqual(caps.findWindowTitlesOnly.missing, ['screen-recording'])
  })

  test('只缺屏幕录制：控制能力全部可用，只有只读标题识别不可用', () => {
    const caps = macCapabilities({ accessibility: 'granted', automation: 'granted', 'screen-recording': 'denied' })
    assert.equal(caps.gotoPage.available, true)
    assert.equal(caps.readPage.available, true)
    assert.equal(caps.findWindowTitlesOnly.available, false)
  })

  test('unknown 不当成 denied（先试，失败再归类）', () => {
    const caps = macCapabilities({ accessibility: 'unknown', automation: 'unknown', 'screen-recording': 'unknown' })
    assert.ok(Object.values(caps).every(c => c.available))
  })

  test('每种权限都有引导文字；每项能力的依赖都在三种权限之内', () => {
    for (const p of ['accessibility', 'automation', 'screen-recording'] as const) assert.ok(MAC_PERMISSION_GUIDANCE[p].includes('系统设置'))
    for (const needs of Object.values(MAC_CAPABILITY_NEEDS)) for (const n of needs) assert.ok(n in MAC_PERMISSION_GUIDANCE)
  })

  test('osascript 失败输出归类', () => {
    assert.equal(classifyMacFailure('execution error: Not authorized to send Apple events to System Events. (-1743)'), 'automation')
    assert.equal(classifyMacFailure('osascript is not allowed assistive access. (-1719)'), 'accessibility')
    assert.equal(classifyMacFailure('error -25211'), 'accessibility')
    assert.equal(classifyMacFailure('screen recording permission'), 'screen-recording')
    assert.equal(classifyMacFailure('syntax error'), null)
  })
})

describe('mac-actions：命令规格', () => {
  test('脚本是常量：不含插值占位符，可变内容只在最后一个 JSON 参数里', async () => {
    assert.equal(MAC_JXA_SCRIPT.includes('${'), false)
    const { run, calls } = runnerReturning({ ok: true, page: 2, total: 9, before: ID, after: ID })
    const actions = createMacActions({ run })
    await actions.readPage(ID, 'wps-pdf')
    const { spec } = calls[0]
    assert.equal(spec.command, '/usr/bin/osascript')
    assert.deepEqual(spec.args.slice(0, 5), ['-l', 'JavaScript', '-e', MAC_JXA_SCRIPT, 'dsh-args'])
    assert.equal(spec.args.length, 6)
    const payload = JSON.parse(spec.args[5])
    assert.equal(payload.op, 'read-page')
    assert.equal(payload.identity.documentName, DOC, '中文与空格文件名原样作为数据')
    assert.equal(spec.args[3].includes(DOC), false)
  })

  test('脚本只允许导航键，没有任何输入文字的调用', () => {
    assert.match(MAC_JXA_SCRIPT, /only navigation keys are allowed/)
    assert.equal(/\.keystroke\(/.test(MAC_JXA_SCRIPT), false, '不得使用 keystroke 输入文字')
  })

  test('openWith 走 /usr/bin/open -b <bundle id>，文件路径独立参数', async () => {
    const launched: { command: string; args: readonly string[] }[] = []
    const actions = createMacActions({
      openDeps: { launcher: async (command, args) => { launched.push({ command, args }); return { pid: 1 } }, statFile: async () => ({ isFile: () => true }) },
    })
    const r = await actions.openWith({ executable: APP, bundleId: 'com.kingsoft.wpsoffice.mac' }, `/Users/me/${DOC}`)
    assert.equal(r.ok, true)
    assert.deepEqual(launched[0], { command: '/usr/bin/open', args: ['-b', 'com.kingsoft.wpsoffice.mac', `/Users/me/${DOC}`] })
  })

  test('查找窗口必须给 bundle id', async () => {
    const { run, calls } = runnerReturning({ ok: true })
    const r = await createMacActions({ run }).findWindow({ titleIncludes: DOC })
    assert.equal(r.ok, false)
    assert.equal(calls.length, 0)
  })
})

describe('mac-actions：解析与核对', () => {
  test('取最后一行 JSON', () => {
    assert.deepEqual(parseMacOutput('warning\n{"ok":true}\n'), { ok: true })
    assert.equal(parseMacOutput(''), null)
    assert.equal(parseMacOutput('not json'), null)
  })

  test('脚本报权限不足 → permission-denied 并带细分与引导', async () => {
    for (const permission of ['accessibility', 'automation'] as const) {
      const { run } = runnerReturning({ ok: false, code: 'permission-denied', permission, message: 'x' })
      const r = await createMacActions({ run }).readPage(ID, 'wps-pdf')
      assert.equal(r.ok, false)
      if (!r.ok) {
        assert.equal(r.error.code, 'permission-denied')
        assert.equal(r.error.permission, permission)
        assert.equal(r.error.guidance, MAC_PERMISSION_GUIDANCE[permission])
      }
    }
  })

  test('osascript 本身因权限失败（没有 JSON）→ 从 stderr 归类', async () => {
    const { run } = runnerReturning('', { code: 1, stderr: 'Not authorized to send Apple events to System Events. (-1743)' })
    const r = await createMacActions({ run }).gotoPage(ID, 2, 'wps-pdf')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.permission, 'automation')
  })

  test('超时 → timeout', async () => {
    const { run } = runnerReturning('', { timedOut: true })
    const r = await createMacActions({ run }).readPage(ID, 'wps-pdf')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.code, 'timeout')
  })

  test('身份变化（启动时间不同）→ identity-changed', async () => {
    const { run } = runnerReturning({ ok: true, page: 2, total: 9, before: { ...ID, processStartedAt: '1' } })
    const r = await createMacActions({ run }).readPage(ID, 'wps-pdf')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.code, 'identity-changed')
  })

  test('跳页后前台不是目标 → focus-stolen；读回不符 → failed', async () => {
    const lost = runnerReturning({ ok: true, page: 2, total: 9, before: ID, after: ID, foregroundAfter: { isTarget: false, pid: 1 } })
    const r1 = await createMacActions({ run: lost.run }).gotoPage(ID, 2, 'wps-pdf')
    assert.equal(r1.ok, false)
    if (!r1.ok) assert.equal(r1.error.code, 'focus-stolen')
    const off = runnerReturning({ ok: true, page: 3, total: 9, before: ID, after: ID, foregroundAfter: fgTarget })
    const r2 = await createMacActions({ run: off.run }).gotoPage(ID, 2, 'wps-pdf')
    assert.equal(r2.ok, false)
    if (!r2.ok) assert.equal(r2.error.detail, 'readback-mismatch')
  })

  test('权限探测结果规范化', async () => {
    const { run } = runnerReturning({ ok: true, accessibility: 'granted', automation: 'denied', screenRecording: 'weird' })
    const r = await createMacActions({ run }).checkPermissions()
    assert.equal(r.ok, true)
    if (r.ok) assert.deepEqual(r.value, { accessibility: 'granted', automation: 'denied', 'screen-recording': 'unknown' })
  })

  test('定位结果只收绝对路径与已知来源', async () => {
    const { run } = runnerReturning({ ok: true, candidates: [
      { path: APP, via: 'bundle-id', bundleId: 'com.kingsoft.wpsoffice.mac', version: '7.0' },
      { path: 'relative.app', via: 'name' },
      { path: '/x.app', via: 'spotlight' },
    ] })
    const r = await createMacActions({ run }).locateApps(['com.kingsoft.wpsoffice.mac'], ['wpsoffice'])
    assert.equal(r.ok, true)
    if (r.ok) assert.deepEqual(r.value.map(c => c.path), [APP])
  })
})
