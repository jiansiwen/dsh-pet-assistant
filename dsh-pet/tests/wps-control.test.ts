/**
 * WPS 控制：定位（注册表结果替身）、打开流程、同步状态归类、平台分派。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fail, ok, type ActionResult, type PagePosition, type WindowIdentity } from '../src/main/desktop-actions.ts'
import { openWithSpecifiedApp } from '../src/main/doc-fs.ts'
import type { RegistryCandidate, WinDesktopActions } from '../src/main/win-actions.ts'
import {
  createWpsController,
  resolveWpsInstallMac,
  resolveWpsInstallWin,
  semanticProfileFor,
  WPS_MAC_BUNDLE_IDS,
  wpsLaunchArgs,
  type WpsSession,
} from '../src/main/wps-control.ts'

const ROOT = 'D:\\WPS Office\\12.1.0.28505'
const EXE = `${ROOT}\\office6\\wps.exe`
const DIR = `${ROOT}\\office6`
const FILE = 'D:\\资料 文件夹\\dshprobe 合成 讲解 测试.pdf'
const DOC = 'dshprobe 合成 讲解 测试.pdf'
const ID: WindowIdentity = { platform: 'win32', pid: 21452, windowId: '68352', title: `${DOC} - WPS Office`, processPath: EXE, processStartedAt: '1', documentName: DOC }

// 本机注册表的真实形态（App Paths 三项都指向 wps.exe + InstallRoot + 卸载项）。
const REAL: RegistryCandidate[] = [
  { source: 'app-paths', key: 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\wps.exe', name: 'wps.exe', value: EXE },
  { source: 'app-paths', key: 'HKCU:\\...\\wpp.exe', name: 'wpp.exe', value: EXE },
  { source: 'app-paths', key: 'HKCU:\\...\\et.exe', name: 'et.exe', value: EXE },
  { source: 'kingsoft-common', key: 'HKCU:\\SOFTWARE\\Kingsoft\\Office\\6.0\\Common', name: 'InstallRoot', value: ROOT },
  { source: 'uninstall', key: 'HKEY_CURRENT_USER\\...\\Kingsoft Office', name: 'DisplayIcon', value: 'D:\\WPS Office\\ksolaunch.exe', version: '12.1.0.28505' },
]

describe('wps-control：Windows 定位（注册表替身）', () => {
  test('本机形态：取 App Paths 的 wps.exe，安装目录是 office6，版本从路径读出', () => {
    const install = resolveWpsInstallWin(REAL, f => f === EXE)
    assert.ok(install)
    assert.equal(install.executable, EXE)
    assert.equal(install.installDir, DIR)
    assert.equal(install.version, '12.1.0.28505')
    assert.match(install.source, /^app-paths:/)
  })

  test('App Paths 登记的文件不存在 → 退到 InstallRoot', () => {
    const regs: RegistryCandidate[] = [
      { source: 'app-paths', key: 'k', name: 'wps.exe', value: 'C:\\Old\\office6\\wps.exe' },
      { source: 'kingsoft-common', key: 'k2', name: 'InstallRoot', value: ROOT },
    ]
    const install = resolveWpsInstallWin(regs, f => f === EXE)
    assert.equal(install?.executable, EXE)
    assert.match(install?.source ?? '', /^install-root:/)
  })

  test('只有卸载项：DisplayIcon 目录 + 版本号拼出 wps.exe', () => {
    const regs = REAL.filter(r => r.source === 'uninstall')
    const install = resolveWpsInstallWin(regs, f => f === EXE)
    assert.equal(install?.executable, EXE)
    assert.equal(install?.version, '12.1.0.28505')
  })

  test('登记指向的不是 wps.exe（例如被改成别的程序）→ 不采信', () => {
    const regs: RegistryCandidate[] = [{ source: 'app-paths', key: 'k', name: 'wps.exe', value: 'C:\\evil\\cmd.exe' }]
    assert.equal(resolveWpsInstallWin(regs, () => true), null)
  })

  test('带引号与相对路径的登记值', () => {
    assert.equal(resolveWpsInstallWin([{ source: 'app-paths', key: 'k', name: 'wps.exe', value: `"${EXE}"` }], f => f === EXE)?.executable, EXE)
    assert.equal(resolveWpsInstallWin([{ source: 'app-paths', key: 'k', name: 'wps.exe', value: 'wps.exe' }], () => true), null)
  })

  test('什么都没有 → null（调用方报 not-installed）', () => {
    assert.equal(resolveWpsInstallWin([], () => true), null)
    assert.equal(resolveWpsInstallWin(REAL, () => false), null)
  })
})

describe('wps-control：macOS 定位（替身）', () => {
  test('按 bundle id 优先', () => {
    const install = resolveWpsInstallMac([
      { path: '/Applications/Other.app', via: 'name', bundleId: 'com.kingsoft.other', name: 'WPS Office' },
      { path: '/Applications/wpsoffice.app', via: 'bundle-id', bundleId: WPS_MAC_BUNDLE_IDS[0] },
    ])
    assert.equal(install?.executable, '/Applications/wpsoffice.app')
    assert.equal(install?.bundleId, 'com.kingsoft.wpsoffice.mac')
  })

  test('按名字找到但 bundle id 不是金山的 → 不认', () => {
    assert.equal(resolveWpsInstallMac([{ path: '/Applications/wpsoffice.app', via: 'name', bundleId: 'com.fake.app', name: 'wpsoffice' }]), null)
    assert.equal(resolveWpsInstallMac([{ path: '/Applications/wpsoffice.app', via: 'name', bundleId: 'com.kingsoft.wpsoffice.mac', name: 'wpsoffice' }])?.source, 'app-name:wpsoffice')
  })
})

describe('wps-control：打开参数', () => {
  test('PDF 用 WPS 自己登记的 /prometheus /pdf；其他类型不加开关；macOS 不加', () => {
    assert.deepEqual(wpsLaunchArgs('win32', FILE), ['/prometheus', '/pdf'])
    assert.deepEqual(wpsLaunchArgs('win32', 'D:\\a.docx'), [])
    assert.deepEqual(wpsLaunchArgs('darwin', '/a.pdf'), [])
    assert.equal(semanticProfileFor(FILE), 'wps-pdf')
    assert.equal(semanticProfileFor('D:\\a.docx'), null)
  })
})

// ===== 控制器流程（Windows 动作替身）=====

type Partial2<T> = { [K in keyof T]?: T[K] }

function fakeWin(over: Partial2<WinDesktopActions> & { finds?: ActionResult<WindowIdentity>[] } = {}) {
  const calls: string[] = []
  const finds = over.finds ?? [ok(ID, { action: 'findWindow', platform: 'win32' })]
  const evidence = (action: 'readPage' | 'gotoPage') => ({ action, platform: 'win32' as const, foregroundBefore: { isTarget: true }, foregroundAfter: { isTarget: true } })
  const win: WinDesktopActions = {
    platform: 'win32',
    readWpsRegistry: async () => { calls.push('registry'); return ok(REAL, { action: 'locate', platform: 'win32' }) },
    openWith: async (app, file) => { calls.push(`open ${app.executable} ${[...(app.args ?? []), file].join('|')}`); return ok({ launched: true, pid: 1, verified: false } as const, { action: 'openWith', platform: 'win32', command: { command: app.executable, args: [...(app.args ?? []), file] } }) },
    findWindow: async () => { calls.push('find'); return finds.length > 1 ? finds.shift()! : finds[0] },
    verify: async () => fail('unsupported', 'x', { action: 'verify', platform: 'win32' }),
    focus: async () => ok(ID, { action: 'focus', platform: 'win32' }),
    readVisibleText: async () => fail('unsupported', 'x', { action: 'readVisibleText', platform: 'win32' }),
    // 读前台窗口只给"记录当前窗口"用，WPS 控制器不碰它。
    readForegroundText: async () => fail('unsupported', 'x', { action: 'readForegroundText', platform: 'win32' }),
    readPage: async () => { calls.push('readPage'); return ok<PagePosition>({ page: 1, total: 15 }, evidence('readPage')) },
    gotoPage: async (_id, page) => { calls.push(`goto ${page}`); return ok<PagePosition>({ page, total: 15 }, evidence('gotoPage')) },
    scroll: async () => fail('unsupported', 'x', { action: 'scroll', platform: 'win32' }),
    dispose: () => { calls.push('dispose') },
    ...over,
  }
  return { win, calls }
}

const controller = (win: WinDesktopActions, ownerPids: number[] = []) =>
  createWpsController({ platform: 'win32', scriptDir: 'C:\\x', win, exists: f => f === EXE, sleep: async () => {}, ownerPids })

describe('wps-control：打开流程', () => {
  test('定位 → 指定 WPS 打开（参数数组）→ 核验窗口 → 首次读页', async () => {
    const { win, calls } = fakeWin()
    const r = await controller(win).open(FILE)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.deepEqual(calls, ['registry', `open ${EXE} /prometheus|/pdf|${FILE}`, 'find', 'readPage'])
    assert.equal(r.value.documentName, DOC)
    assert.equal(r.value.profile, 'wps-pdf')
    assert.deepEqual(r.value.position, { page: 1, total: 15 })
    assert.deepEqual(r.evidence.readBack, { page: 1, total: 15 })
    assert.deepEqual(r.evidence.command?.args, ['/prometheus', '/pdf', FILE])
  })

  test('WPS 还在加载时继续等，窗口出现后成功', async () => {
    const notYet = fail<WindowIdentity>('window-not-found', '没有', { action: 'findWindow', platform: 'win32' }, { detail: 'document-not-loaded' })
    const { win, calls } = fakeWin({ finds: [notYet, notYet, ok(ID, { action: 'findWindow', platform: 'win32' })] })
    const r = await controller(win).open(FILE)
    assert.equal(r.ok, true)
    assert.equal(calls.filter(c => c === 'find').length, 3)
  })

  test('同名文档 → 立即停止，不猜是哪一个', async () => {
    const amb = fail<WindowIdentity>('ambiguous-window', '同名', { action: 'findWindow', platform: 'win32' }, { detail: 'same-name-tabs' })
    const { win, calls } = fakeWin({ finds: [amb] })
    const r = await controller(win).open(FILE)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.code, 'ambiguous-window')
    assert.equal(calls.filter(c => c === 'find').length, 1)
  })

  test('始终找不到窗口 → window-not-found（不把"已启动"当成打开成功）', async () => {
    const notYet = fail<WindowIdentity>('window-not-found', '没有', { action: 'findWindow', platform: 'win32' })
    const { win } = fakeWin({ finds: [notYet] })
    let t = 0
    const c = createWpsController({ platform: 'win32', scriptDir: 'C:\\x', win, exists: f => f === EXE, sleep: async () => {}, now: () => (t += 5_000) })
    const r = await c.open(FILE, { waitMs: 20_000 })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.code, 'window-not-found')
  })

  test('没装 WPS → not-installed，不会退回系统默认关联', async () => {
    const { win, calls } = fakeWin()
    const c = createWpsController({ platform: 'win32', scriptDir: 'C:\\x', win, exists: () => false, sleep: async () => {} })
    const r = await c.open(FILE)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.code, 'not-installed')
    assert.equal(calls.some(x => x.startsWith('open')), false)
  })

  test('相对路径 → invalid-argument', async () => {
    const { win } = fakeWin()
    const r = await controller(win).open('dshprobe.pdf')
    assert.equal(r.ok, false)
  })
})

const session: WpsSession = {
  platform: 'win32', install: { platform: 'win32', executable: EXE, installDir: DIR, source: 'x' },
  file: FILE, documentName: DOC, identity: ID, profile: 'wps-pdf',
}

describe('wps-control：同步状态（讲解该不该暂停）', () => {
  test('前台是 WPS → in-sync', async () => {
    const { win } = fakeWin()
    const s = await controller(win).status(session)
    assert.equal(s.state, 'in-sync')
  })

  test('前台是其他应用 → paused / focus-lost', async () => {
    const { win } = fakeWin({ readPage: async () => ok({ page: 2, total: 15 }, { action: 'readPage', platform: 'win32', foregroundBefore: { isTarget: false, pid: 7, isOwner: false } }) })
    const s = await controller(win).status(session)
    assert.equal(s.state, 'paused')
    if (s.state === 'paused') assert.equal(s.reason, 'focus-lost')
  })

  test('前台是宠物自己（ownerPids）→ 仍算同步', async () => {
    const { win } = fakeWin({ readPage: async () => ok({ page: 2, total: 15 }, { action: 'readPage', platform: 'win32', foregroundBefore: { isTarget: false, pid: 77, isOwner: true } }) })
    const s = await controller(win, [77]).status(session)
    assert.equal(s.state, 'in-sync')
  })

  test('WPS 弹窗在前台 → paused / dialog', async () => {
    const { win } = fakeWin({ readPage: async () => ok({ page: 2, total: 15 }, { action: 'readPage', platform: 'win32', foregroundBefore: { isTarget: false, pid: 21452, isDialogOfTarget: true } }) })
    const s = await controller(win).status(session)
    assert.equal(s.state === 'paused' && s.reason, 'dialog')
  })

  test('WPS 已关闭 → paused / closed；文档被切走 → document-switched', async () => {
    for (const [code, reason] of [['window-not-found', 'closed'], ['identity-changed', 'document-switched'], ['dialog-blocking', 'dialog']] as const) {
      const { win } = fakeWin({ readPage: async () => fail(code, 'x', { action: 'readPage', platform: 'win32' }) })
      const s = await controller(win).status(session)
      assert.equal(s.state === 'paused' && s.reason, reason, code)
    }
  })

  test('syncTo：跳页成功 → in-sync 带读回页码；失败 → paused', async () => {
    const { win, calls } = fakeWin()
    const s = await controller(win).syncTo(session, 7)
    assert.equal(s.state, 'in-sync')
    if (s.state === 'in-sync') assert.deepEqual(s.position, { page: 7, total: 15 })
    assert.ok(calls.includes('goto 7'))
    const { win: w2 } = fakeWin({ gotoPage: async () => fail('focus-stolen', 'x', { action: 'gotoPage', platform: 'win32' }) })
    const s2 = await controller(w2).syncTo(session, 7)
    assert.equal(s2.state === 'paused' && s2.reason, 'focus-lost')
  })

  test('非 PDF 会话：页码操作如实 unsupported 并建议阅读视图，不发任何动作', async () => {
    const { win, calls } = fakeWin()
    const c = controller(win)
    const docx = { ...session, profile: null }
    const r = await c.gotoPage(docx, 2)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.fallback, 'reading-view')
    const s = await c.status(docx)
    assert.equal(s.state === 'paused' && s.reason, 'unsupported')
    assert.equal(calls.some(x => x.startsWith('goto') || x === 'readPage'), false)
  })
})

describe('wps-control：平台分派', () => {
  test('Linux：全部 unsupported，带阅读视图建议', async () => {
    const c = createWpsController({ platform: 'linux', scriptDir: '/x' })
    assert.equal(c.platform, 'linux')
    const r = await c.open('/tmp/a.pdf')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.fallback, 'reading-view')
    assert.equal((await c.status(session)).state, 'paused')
  })

  test('macOS 控制器标注为未在真机验证', () => {
    const c = createWpsController({ platform: 'darwin', scriptDir: '/x' })
    assert.equal(c.unverifiedOnDevice, true)
    assert.equal(createWpsController({ platform: 'win32', scriptDir: 'C:\\x', win: fakeWin().win }).unverifiedOnDevice, false)
  })
})

describe('doc-fs：用指定应用打开', () => {
  const statFile = async (p: string) => (p === EXE || p === FILE ? { isFile: () => true } : null)

  test('参数数组交给启动器，中文/空格路径是一个独立参数', async () => {
    const launched: { command: string; args: readonly string[] }[] = []
    const r = await openWithSpecifiedApp(FILE, { executable: EXE, args: ['/prometheus', '/pdf'] }, {
      platform: 'win32', statFile, launcher: async (command, args) => { launched.push({ command, args }); return { pid: 9 } },
    })
    assert.equal(r.ok, true)
    if (r.ok) assert.deepEqual(r.value, { launched: true, pid: 9, verified: false })
    assert.deepEqual(launched, [{ command: EXE, args: ['/prometheus', '/pdf', FILE] }])
  })

  test('白名单外的扩展名（可执行 / 宏文档）不打开', async () => {
    for (const bad of ['D:\\x\\a.exe', 'D:\\x\\a.docm', 'D:\\x\\a.ps1']) {
      const r = await openWithSpecifiedApp(bad, { executable: EXE }, { platform: 'win32', statFile: async () => ({ isFile: () => true }), launcher: async () => { throw new Error('不应启动') } })
      assert.equal(r.ok, false, bad)
      if (!r.ok) assert.equal(r.error.code, 'invalid-argument')
    }
  })

  test('应用不存在 → not-installed；启动 ENOENT → not-installed', async () => {
    const r1 = await openWithSpecifiedApp(FILE, { executable: 'D:\\none\\wps.exe' }, { platform: 'win32', statFile, launcher: async () => ({}) })
    assert.equal(!r1.ok && r1.error.code, 'not-installed')
    const r2 = await openWithSpecifiedApp(FILE, { executable: EXE }, {
      platform: 'win32', statFile, launcher: async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) },
    })
    assert.equal(!r2.ok && r2.error.code, 'not-installed')
  })

  test('文件不存在 → invalid-argument；Linux → unsupported', async () => {
    const r1 = await openWithSpecifiedApp('D:\\x\\missing.pdf', { executable: EXE }, { platform: 'win32', statFile, launcher: async () => ({}) })
    assert.equal(!r1.ok && r1.error.code, 'invalid-argument')
    const r2 = await openWithSpecifiedApp('/tmp/a.pdf', { executable: '/usr/bin/wps' }, { platform: 'linux', statFile, launcher: async () => ({}) })
    assert.equal(!r2.ok && r2.error.code, 'unsupported')
  })
})
