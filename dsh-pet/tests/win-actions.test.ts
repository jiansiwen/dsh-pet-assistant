/**
 * Windows 动作层：线协议、第二道核对（身份变化 / 焦点被抢 / 读回不符一律拒绝）、常驻进程管理。
 * 辅助脚本用替身代替 —— 这里测的是"脚本说什么，TS 层信什么、不信什么"。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { describe, test } from 'node:test'
import type { WindowIdentity } from '../src/main/desktop-actions.ts'
import {
  createHelperProcess,
  createWinActions,
  decodeHelperLine,
  encodeHelperRequest,
  HelperTimeoutError,
  type HelperRequest,
  type HelperResponse,
  type HelperTransport,
} from '../src/main/win-actions.ts'

const WPS = 'D:\\WPS Office\\12.1.0.28505\\office6\\wps.exe'
const DOC = 'dshprobe 合成 讲解 测试.pdf'
const ID: WindowIdentity = {
  platform: 'win32', pid: 21452, windowId: '68352', title: `${DOC} - WPS Office`,
  processPath: WPS, processStartedAt: '134365870439557783', documentName: DOC,
}
const fgTarget = { isTarget: true, pid: 21452, isOwner: false, isDialogOfTarget: false }

function fakeTransport(reply: (req: HelperRequest) => HelperResponse | Error) {
  const seen: HelperRequest[] = []
  const transport: HelperTransport = {
    async request(req) {
      seen.push(req)
      const r = reply(req)
      if (r instanceof Error) throw r
      return r
    },
    dispose() {},
  }
  return { transport, seen }
}

const actionsWith = (reply: (req: HelperRequest) => HelperResponse | Error) => {
  const f = fakeTransport(reply)
  return { actions: createWinActions({ scriptDir: 'C:\\x', transport: f.transport }), seen: f.seen }
}

describe('win-actions：线协议', () => {
  test('请求编码成一行 base64，中文/空格/引号不出现在明文里', () => {
    const line = encodeHelperRequest({ op: 'find', query: { titleIncludes: '合成 讲解 "x".pdf' } })
    assert.match(line, /^[A-Za-z0-9+/=]+$/)
    assert.equal(line.includes('合成'), false)
    const back = JSON.parse(Buffer.from(line, 'base64').toString('utf8'))
    assert.equal(back.query.titleIncludes, '合成 讲解 "x".pdf')
  })

  test('响应只认 DSH: 前缀的 base64 JSON 对象', () => {
    const good = 'DSH:' + Buffer.from(JSON.stringify({ ok: true, title: '合成 讲解.pdf' }), 'utf8').toString('base64')
    assert.deepEqual(decodeHelperLine(`${good}\r`), { ok: true, title: '合成 讲解.pdf' })
    assert.equal(decodeHelperLine('Windows PowerShell'), null)
    assert.equal(decodeHelperLine('DSH:!!!'), null)
    assert.equal(decodeHelperLine('DSH:' + Buffer.from('[1,2]').toString('base64')), null)
  })
})

describe('win-actions：参数作为数据传递', () => {
  test('目标身份与页码原样作为请求字段交给辅助脚本', async () => {
    const { actions, seen } = actionsWith(() => ({ ok: true, page: 3, total: 15, before: ID, after: ID, foregroundAfter: fgTarget }))
    const r = await actions.gotoPage(ID, 3, 'wps-pdf')
    assert.equal(r.ok, true)
    assert.equal(seen[0].op, 'goto-page')
    assert.deepEqual(seen[0].identity, ID)
    assert.equal(seen[0].page, 3)
  })

  test('查找窗口必须限定进程，否则不发请求', async () => {
    const { actions, seen } = actionsWith(() => ({ ok: true }))
    const r = await actions.findWindow({ titleIncludes: DOC })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.code, 'invalid-argument')
    assert.equal(seen.length, 0)
  })

  test('辅助脚本返回的窗口不属于要求的安装目录 → 不采信', async () => {
    const foreign = { ...ID, processPath: 'C:\\Other\\wps.exe' }
    const { actions } = actionsWith(() => ({ ok: true, identity: foreign }))
    const r = await actions.findWindow({ processDir: 'D:\\WPS Office\\12.1.0.28505\\office6', titleIncludes: DOC }, { documentName: DOC })
    assert.equal(r.ok, false)
  })

  test('辅助脚本返回的窗口在安装目录下 → 得到身份', async () => {
    const { actions } = actionsWith(() => ({ ok: true, identity: { ...ID, component: { pid: 46652, windowId: '9576178', processPath: 'D:\\WPS Office\\12.1.0.28505\\office6\\wpspdf.exe' } } }))
    const r = await actions.findWindow({ processDir: 'D:\\WPS Office\\12.1.0.28505\\office6', titleIncludes: DOC }, { documentName: DOC, profile: 'wps-pdf' })
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.value.documentName, DOC)
      assert.equal(r.value.component?.pid, 46652)
    }
  })
})

describe('win-actions：身份变化时拒绝', () => {
  test('脚本说成功，但执行前身份 pid 不同 → identity-changed', async () => {
    const { actions } = actionsWith(() => ({ ok: true, page: 3, total: 15, before: { ...ID, pid: 999 }, after: ID, foregroundAfter: fgTarget }))
    const r = await actions.gotoPage(ID, 3, 'wps-pdf')
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.error.code, 'identity-changed')
      assert.match(r.error.detail ?? '', /pid/)
    }
  })

  test('脚本说成功，但执行后标题已不含文档名 → identity-changed', async () => {
    const { actions } = actionsWith(() => ({ ok: true, page: 3, total: 15, before: ID, after: { ...ID, title: '别的.pdf - WPS Office' }, foregroundAfter: fgTarget }))
    const r = await actions.readPage(ID, 'wps-pdf')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.code, 'identity-changed')
  })

  test('pid 复用（启动时间不同）→ identity-changed', async () => {
    const { actions } = actionsWith(() => ({ ok: true, page: 1, total: 15, before: { ...ID, processStartedAt: '1' } }))
    const r = await actions.readPage(ID, 'wps-pdf')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.code, 'identity-changed')
  })

  test('脚本自己发现文档已切换 → 原样转达', async () => {
    const { actions } = actionsWith(() => ({ ok: false, code: 'identity-changed', message: '目标窗口当前显示的已不是这份文档', detail: 'document-switched' }))
    const r = await actions.scroll(ID, { direction: 'down', unit: 'line', count: 1 }, 'wps-pdf')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.detail, 'document-switched')
  })
})

describe('win-actions：焦点被抢时拒绝', () => {
  test('脚本说成功，但动作后前台不是目标 → focus-stolen', async () => {
    const { actions } = actionsWith(() => ({ ok: true, page: 3, total: 15, before: ID, after: ID, foregroundAfter: { isTarget: false, pid: 1 } }))
    const r = await actions.gotoPage(ID, 3, 'wps-pdf')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.code, 'focus-stolen')
  })

  test('动作后前台是目标应用的弹窗 → dialog-blocking', async () => {
    const { actions } = actionsWith(() => ({ ok: true, page: 3, total: 15, before: ID, after: ID, foregroundAfter: { isTarget: false, pid: 21452, isDialogOfTarget: true } }))
    const r = await actions.gotoPage(ID, 3, 'wps-pdf')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.code, 'dialog-blocking')
  })

  test('脚本没有回传动作后的前台状态 → 不当成功', async () => {
    const { actions } = actionsWith(() => ({ ok: true, page: 3, total: 15, before: ID, after: ID }))
    const r = await actions.gotoPage(ID, 3, 'wps-pdf')
    assert.equal(r.ok, false)
  })

  test('脚本报告前台是其他应用 → focus-stolen 原样转达', async () => {
    const { actions } = actionsWith(() => ({ ok: false, code: 'focus-stolen', message: '前台是其他应用，未操作', detail: 'foreground-other', foregroundBefore: { isTarget: false, pid: 7 } }))
    const r = await actions.gotoPage(ID, 3, 'wps-pdf', { ownerPids: [1234] })
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.error.code, 'focus-stolen')
      assert.equal(r.evidence.foregroundBefore?.isTarget, false)
    }
  })

  test('ownerPids 作为数据传给脚本', async () => {
    const { actions, seen } = actionsWith(() => ({ ok: true, page: 3, total: 15, before: ID, after: ID, foregroundAfter: fgTarget }))
    await actions.gotoPage(ID, 3, 'wps-pdf', { ownerPids: [1234, 5678] })
    assert.deepEqual(seen[0].ownerPids, [1234, 5678])
  })
})

describe('win-actions：命令成功 ≠ 目标达成', () => {
  test('跳页读回的页码不是目标页 → failed / readback-mismatch', async () => {
    const { actions } = actionsWith(() => ({ ok: true, page: 4, total: 15, before: ID, after: ID, foregroundAfter: fgTarget }))
    const r = await actions.gotoPage(ID, 5, 'wps-pdf')
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.error.code, 'failed')
      assert.equal(r.error.detail, 'readback-mismatch')
      assert.equal(r.evidence.readBack?.page, 4, '证据里保留读回的页码')
    }
  })

  test('成功时证据包含前后身份、读回页码与步骤', async () => {
    const { actions } = actionsWith(() => ({ ok: true, page: 5, total: 15, raw: '5/15', before: ID, after: ID, foregroundBefore: fgTarget, foregroundAfter: fgTarget, pageBefore: { page: 1, total: 15 }, steps: ['Rightx4->5/15'], method: 'key-nav x4' }))
    const r = await actions.gotoPage(ID, 5, 'wps-pdf')
    assert.equal(r.ok, true)
    assert.deepEqual(r.evidence.before, ID)
    assert.deepEqual(r.evidence.after, ID)
    assert.deepEqual(r.evidence.pageBefore, { page: 1, total: 15 })
    assert.deepEqual(r.evidence.readBack, { page: 5, total: 15, raw: '5/15' })
    assert.deepEqual(r.evidence.steps, ['Rightx4->5/15'])
  })

  test('回应缺字段（没有页码）→ failed', async () => {
    const { actions } = actionsWith(() => ({ ok: true, before: ID, after: ID, foregroundAfter: fgTarget }))
    const r = await actions.readPage(ID, 'wps-pdf')
    assert.equal(r.ok, false)
  })

  test('滚动没动 → 脚本报告 no-movement，原样转达', async () => {
    const { actions } = actionsWith(() => ({ ok: false, code: 'failed', message: '按键后页码与滚动位置都没有变化', detail: 'no-movement' }))
    const r = await actions.scroll(ID, { direction: 'down', unit: 'page', count: 1 }, 'wps-pdf')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.detail, 'no-movement')
  })

  test('非法页码不发请求', async () => {
    const { actions, seen } = actionsWith(() => ({ ok: true }))
    for (const p of [0, -1, 2.5, Number.NaN]) {
      const r = await actions.gotoPage(ID, p, 'wps-pdf')
      assert.equal(r.ok, false)
    }
    assert.equal(seen.length, 0)
  })
})

describe('win-actions：错误码透传与降级', () => {
  test('unsupported 一律附带阅读视图建议', async () => {
    const { actions } = actionsWith(() => ({ ok: false, code: 'unsupported', message: '这个 WPS 版本没有暴露可读的页码控件', detail: 'page-label-missing' }))
    const r = await actions.readPage(ID, 'wps-pdf')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.fallback, 'reading-view')
  })

  test('弹窗 / 关闭 / 同名 都保留细分原因', async () => {
    for (const [code, detail] of [['dialog-blocking', 'main-disabled'], ['window-not-found', 'app-closed'], ['ambiguous-window', 'same-name-tabs']] as const) {
      const { actions } = actionsWith(() => ({ ok: false, code, message: 'x', detail }))
      const r = await actions.readPage(ID, 'wps-pdf')
      assert.equal(r.ok, false)
      if (!r.ok) {
        assert.equal(r.error.code, code)
        assert.equal(r.error.detail, detail)
      }
    }
  })

  test('认不出的错误码当成 failed', async () => {
    const { actions } = actionsWith(() => ({ ok: false, code: 'weird', message: 'x' }))
    const r = await actions.readPage(ID, 'wps-pdf')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.code, 'failed')
  })

  test('辅助进程超时 → timeout', async () => {
    const { actions } = actionsWith(() => new HelperTimeoutError())
    const r = await actions.readPage(ID, 'wps-pdf')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.code, 'timeout')
  })
})

describe('win-actions：读可见文字要授权', () => {
  test('没有授权不发请求', async () => {
    const { actions, seen } = actionsWith(() => ({ ok: true, text: 'x' }))
    const r = await actions.readVisibleText(ID, { authorized: false } as never)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.code, 'not-authorized')
    assert.equal(seen.length, 0)
  })

  test('有授权时把理由写进证据', async () => {
    const { actions, seen } = actionsWith(() => ({ ok: true, text: '正文', truncated: false, before: ID }))
    const r = await actions.readVisibleText(ID, { authorized: true, reason: '用户要求朗读当前页', maxChars: 500 })
    assert.equal(r.ok, true)
    assert.equal(r.evidence.grantReason, '用户要求朗读当前页')
    assert.equal(seen[0].authorized, true)
    assert.equal(seen[0].maxChars, 500)
  })
})

// ===== 辅助脚本的静态约束 =====

describe('win-uia.ps1：静态约束', () => {
  const script = readFileSync(new URL('../src/main/win-uia.ps1', import.meta.url))
  const text = script.toString('utf8')

  test('带 UTF-8 BOM（Windows PowerShell 5.1 才能正确读中文字符串）', () => {
    assert.deepEqual([...script.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  })

  test('只允许导航键：没有 SendKeys / 字符输入 / Unicode 键入', () => {
    assert.match(text, /NavKeys = \{ 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28 \}/)
    assert.match(text, /only navigation keys are allowed/)
    for (const banned of ['SendKeys', 'keybd_event', 'KEYEVENTF_UNICODE', 'SetValue(', 'WM_CHAR']) {
      assert.equal(text.includes(banned), false, banned)
    }
  })

  test('请求只从 stdin 读，不接受命令行参数', () => {
    assert.equal(/^\s*param\s*\(/m.test(text), false)
    assert.match(text, /\[Console\]::In/)
  })

  test('构建会把脚本拷进 dist/main', () => {
    const build = readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8')
    assert.match(build, /src\/main\/win-uia\.ps1'\), path\.join\(root, 'dist\/main\/win-uia\.ps1'\)/)
  })
})

// ===== 常驻进程 =====

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill() { this.killed = true; this.emit('exit', null); return true }
}

function reply(child: FakeChild, payload: Record<string, unknown>) {
  child.stdout.write('Windows PowerShell banner\n')
  child.stdout.write('DSH:' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64') + '\n')
}

describe('win-actions：常驻辅助进程', () => {
  test('按 id 对应响应；请求串行；懒启动只启动一次', async () => {
    const children: FakeChild[] = []
    const t = createHelperProcess({ command: 'powershell', args: [] }, {
      spawn: () => { const c = new FakeChild(); children.push(c); return c as never },
      startupGraceMs: 0, idleMs: 60_000,
    })
    const lines: string[] = []
    const p1 = t.request({ op: 'ping' }, 1000)
    const p2 = t.request({ op: 'read-page' }, 1000)
    await new Promise(r => setImmediate(r))
    assert.equal(children.length, 1)
    const first = JSON.parse(Buffer.from(children[0].stdin.read()?.toString().trim() ?? '', 'base64').toString('utf8'))
    children[0].stdin.on('data', (d: Buffer) => lines.push(d.toString()))
    assert.equal(first.op, 'ping')
    reply(children[0], { id: 999, ok: true })
    reply(children[0], { id: first.id, ok: true, which: 1 })
    assert.deepEqual(await p1, { id: first.id, ok: true, which: 1 })
    await new Promise(r => setImmediate(r))
    const second = JSON.parse(Buffer.from(lines.join('').trim(), 'base64').toString('utf8'))
    assert.equal(second.op, 'read-page', '第二个请求在第一个完成后才发出')
    reply(children[0], { id: second.id, ok: true, which: 2 })
    assert.equal((await p2).which, 2)
    t.dispose()
  })

  test('超时结束子进程并报 HelperTimeoutError，下次请求重新启动', async () => {
    const children: FakeChild[] = []
    const t = createHelperProcess({ command: 'powershell', args: [] }, {
      spawn: () => { const c = new FakeChild(); children.push(c); return c as never },
      startupGraceMs: 0, idleMs: 60_000,
    })
    // 预算 = timeoutMs + 3000 的宽限；这里用很小的 timeoutMs，依赖宽限也会超时。
    const started = Date.now()
    await assert.rejects(t.request({ op: 'goto-page' }, -2_990), HelperTimeoutError)
    assert.ok(Date.now() - started < 2_000)
    assert.equal(children[0].killed, true)
    const again = t.request({ op: 'ping' }, 1000)
    await new Promise(r => setImmediate(r))
    assert.equal(children.length, 2)
    const req = JSON.parse(Buffer.from(children[1].stdin.read()?.toString().trim() ?? '', 'base64').toString('utf8'))
    reply(children[1], { id: req.id, ok: true })
    assert.equal((await again).ok, true)
    t.dispose()
  })

  test('子进程意外退出时，挂起的请求立即失败', async () => {
    let child: FakeChild | undefined
    const t = createHelperProcess({ command: 'powershell', args: [] }, { spawn: () => (child = new FakeChild()) as never, startupGraceMs: 0 })
    const p = t.request({ op: 'ping' }, 5000)
    await new Promise(r => setImmediate(r))
    child!.emit('exit', 1)
    await assert.rejects(p, /退出/)
    t.dispose()
  })
})

describe('win-actions：读前台窗口（记录当前窗口作证据）', () => {
  test('发起的是 read-foreground-text，带上自己的 pid 防止读到宠物自己', async () => {
    const { actions, seen } = actionsWith(req => req.op === 'read-foreground-text'
      ? { ok: true, before: ID, text: '客户 金额 37', truncated: false, method: 'uia-textpattern' }
      : { ok: false, code: 'invalid-argument', message: '不该发 ' + req.op })
    const result = await actions.readForegroundText({ authorized: true, reason: '用户主动记录', maxChars: 500 })
    assert.equal(result.ok, true)
    const request = seen.at(-1)!
    assert.equal(request.op, 'read-foreground-text')
    assert.equal(request.ownerPid, process.pid, '把自己的 pid 传下去，前台是本进程时脚本会拒绝')
    assert.equal(request.maxChars, 500)
    if (result.ok) {
      assert.equal(result.value.text, '客户 金额 37')
      assert.equal(result.value.identity.pid, 21452, '身份以脚本回传的为准，界面要显示给用户确认')
    }
  })

  test('没有授权就不发请求', async () => {
    const { actions, seen } = actionsWith(() => ({ ok: false, code: 'not-authorized', message: 'x' }))
    const result = await actions.readForegroundText({ authorized: false, reason: 'x' } as never)
    assert.equal(result.ok, false)
    assert.equal(seen.length, 0, '未授权时一个请求都不该发出去')
  })

  test('窗口不暴露文字时如实回报 unsupported，不编造正文', async () => {
    const { actions } = actionsWith(() => ({ ok: false, code: 'unsupported', message: '这个窗口没有通过 UI Automation 暴露正文文字', detail: 'no-text-pattern' }))
    const result = await actions.readForegroundText({ authorized: true, reason: '用户主动记录' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error.message, /UI Automation/)
      assert.equal(result.error.code, 'unsupported')
    }
  })
})
