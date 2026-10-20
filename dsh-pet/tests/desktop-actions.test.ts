/**
 * 桌面动作契约：错误码、身份核对、页码解析、暂停原因。两平台共用这一份。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  ACTION_ERROR_CODES,
  fail,
  identityMismatches,
  isActionErrorCode,
  ok,
  parsePageLabel,
  pathIsUnder,
  pauseReasonOf,
  sameIdentity,
  titleHasDocument,
  validPage,
  type WindowIdentity,
} from '../src/main/desktop-actions.ts'

const WPS = 'D:\\WPS Office\\12.1.0.28505\\office6\\wps.exe'
const base: WindowIdentity = {
  platform: 'win32', pid: 21452, windowId: '68352', title: 'dshprobe 合成 讲解 测试.pdf - WPS Office',
  processPath: WPS, processStartedAt: '134365870439557783', documentName: 'dshprobe 合成 讲解 测试.pdf',
}

describe('desktop-actions：错误码', () => {
  test('任务要求区分的错误码都在契约里', () => {
    for (const code of ['not-installed', 'window-not-found', 'identity-changed', 'focus-stolen', 'dialog-blocking', 'unsupported', 'timeout', 'permission-denied']) {
      assert.ok(isActionErrorCode(code), code)
    }
    assert.equal(new Set(ACTION_ERROR_CODES).size, ACTION_ERROR_CODES.length, '错误码不重复')
    assert.equal(isActionErrorCode('success'), false)
    assert.equal(isActionErrorCode(undefined), false)
  })

  test('结果总带证据；失败带错误码与附加信息', () => {
    const evidence = { action: 'gotoPage' as const, platform: 'win32' as const }
    const good = ok({ page: 2, total: 3 }, evidence)
    assert.equal(good.ok, true)
    assert.equal(good.evidence, evidence)
    const bad = fail('unsupported', '不行', evidence, { fallback: 'reading-view' })
    assert.equal(bad.ok, false)
    if (!bad.ok) {
      assert.equal(bad.error.code, 'unsupported')
      assert.equal(bad.error.fallback, 'reading-view')
      assert.equal(bad.evidence, evidence)
    }
  })

  test('每个错误码都能归到一个讲解暂停原因', () => {
    const expected: Record<string, string> = {
      'focus-stolen': 'focus-lost', 'dialog-blocking': 'dialog', 'window-not-found': 'closed',
      'identity-changed': 'document-switched', unsupported: 'unsupported', 'permission-denied': 'permission',
      'ambiguous-window': 'ambiguous', timeout: 'error', failed: 'error',
    }
    for (const [code, reason] of Object.entries(expected)) {
      assert.equal(pauseReasonOf({ code: code as never, message: '' }), reason, code)
    }
  })
})

describe('desktop-actions：身份核对', () => {
  test('完全相同的身份一致', () => {
    assert.deepEqual(identityMismatches(base, { ...base }), [])
    assert.ok(sameIdentity(base, { ...base }))
  })

  test('标题加了修改标记但仍含文档名 → 一致', () => {
    assert.ok(sameIdentity(base, { ...base, title: '* dshprobe 合成 讲解 测试.pdf - WPS Office' }))
  })

  test('pid / 句柄 / 进程路径 / 启动时间 / 标题任何一项变了都能指出来', () => {
    assert.deepEqual(identityMismatches(base, { ...base, pid: 1 }), ['pid'])
    assert.deepEqual(identityMismatches(base, { ...base, windowId: '999' }), ['windowId'])
    assert.deepEqual(identityMismatches(base, { ...base, processPath: 'C:\\evil\\wps.exe' }), ['processPath'])
    assert.deepEqual(identityMismatches(base, { ...base, processStartedAt: '1' }), ['processStartedAt'])
    assert.deepEqual(identityMismatches(base, { ...base, title: '另一份.pdf - WPS Office' }), ['title'])
  })

  test('Windows 进程路径比较不区分大小写，macOS 区分', () => {
    assert.ok(sameIdentity(base, { ...base, processPath: WPS.toUpperCase() }))
    const mac: WindowIdentity = { platform: 'darwin', pid: 5, windowId: 'ax-title:a.pdf', title: 'a.pdf', processPath: '/Applications/wpsoffice.app', documentName: 'a.pdf' }
    assert.deepEqual(identityMismatches(mac, { ...mac, processPath: '/applications/wpsoffice.app' }), ['processPath'])
  })

  test('同名不同路径的文档（macOS 有 AXDocument 时）能区分', () => {
    const mac: WindowIdentity = { platform: 'darwin', pid: 5, windowId: 'ax-doc:/a/x.pdf', title: 'x.pdf', processPath: '/Applications/wpsoffice.app', documentName: 'x.pdf', documentPath: '/a/x.pdf' }
    assert.ok(identityMismatches(mac, { ...mac, windowId: 'ax-doc:/b/x.pdf', documentPath: '/b/x.pdf' }).includes('documentPath'))
  })

  test('标题匹配：空文档名永远不匹配', () => {
    assert.equal(titleHasDocument('任何标题', '', 'win32'), false)
    assert.equal(titleHasDocument('A.PDF - WPS Office', 'a.pdf', 'win32'), true)
    assert.equal(titleHasDocument('A.PDF', 'a.pdf', 'darwin'), false)
  })

  test('安装目录归属：只认目录本身之下，不认前缀相同的兄弟目录', () => {
    const dir = 'D:\\WPS Office\\12.1.0.28505\\office6'
    assert.ok(pathIsUnder('D:\\WPS Office\\12.1.0.28505\\office6\\wpspdf.exe', dir, 'win32'))
    assert.ok(pathIsUnder('d:/wps office/12.1.0.28505/OFFICE6/wps.exe', dir + '\\', 'win32'))
    assert.equal(pathIsUnder('D:\\WPS Office\\12.1.0.28505\\office6-evil\\wps.exe', dir, 'win32'), false)
    assert.equal(pathIsUnder(dir, dir, 'win32'), false)
    assert.ok(pathIsUnder('/Applications/wpsoffice.app/Contents/MacOS/wpsoffice', '/Applications/wpsoffice.app', 'darwin'))
  })
})

describe('desktop-actions：页码', () => {
  test('解析常见页码文字', () => {
    assert.deepEqual(parsePageLabel('3/12'), { page: 3, total: 12 })
    assert.deepEqual(parsePageLabel(' 3 / 12 '), { page: 3, total: 12 })
    assert.deepEqual(parsePageLabel('第3页/共12页'), { page: 3, total: 12 })
  })

  test('解析不了或越界就返回 null，不猜', () => {
    assert.equal(parsePageLabel('94%'), null)
    assert.equal(parsePageLabel('13/12'), null)
    assert.equal(parsePageLabel('0/12'), null)
    assert.equal(parsePageLabel(''), null)
  })

  test('页码合法性', () => {
    assert.ok(validPage(1))
    assert.ok(validPage(12, 12))
    assert.equal(validPage(0), false)
    assert.equal(validPage(2.5), false)
    assert.equal(validPage(13, 12), false)
  })
})
