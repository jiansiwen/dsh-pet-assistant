/**
 * 目标锁：假时钟过期、PID 复用拒绝、进程重启/路径变化失效、非 Windows unsupported。
 * IO 用替身注入 —— 这里测的是锁的判定逻辑，不拉起 PowerShell。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ok, fail, type WindowIdentity } from '../src/main/desktop-actions.ts'
import {
  createTargetLock, TARGET_LOCK_TTL_MS, winActionsTargetLockIO,
  type ProcessIdentityProbe, type TargetLockIdentity,
} from '../src/main/target-lock.ts'

const IDENTITY: TargetLockIdentity = {
  hwnd: '68352', pid: 21452, processStartedAt: '134365870439557783',
  processPath: 'D:\\WPS Office\\office6\\wps.exe', displayId: '65537',
}

function fakeIO(over: { foreground?: TargetLockIdentity | null; process?: ProcessIdentityProbe | null; throwOn?: 'foreground' | 'process' } = {}) {
  const calls = { foreground: 0, process: [] as number[] }
  return {
    calls,
    io: {
      async foregroundIdentity() {
        calls.foreground += 1
        if (over.throwOn === 'foreground') throw new Error('辅助进程不可用')
        return over.foreground === undefined ? IDENTITY : over.foreground
      },
      async processIdentity(pid: number) {
        calls.process.push(pid)
        if (over.throwOn === 'process') throw new Error('辅助进程不可用')
        return over.process === undefined
          ? { alive: true, processStartedAt: IDENTITY.processStartedAt, processPath: IDENTITY.processPath }
          : over.process
      },
    },
  }
}

test('捕获只取身份：TTL 15 秒，字段齐全，不读正文', async () => {
  const f = fakeIO()
  const lock = createTargetLock(f.io, { platform: 'win32', lockId: () => 'lock-1' })
  const captured = await lock.captureTargetLock(1_000)
  assert.ok(captured)
  assert.equal(captured.lockId, 'lock-1')
  assert.equal(captured.capturedAt, 1_000)
  assert.equal(captured.expiresAt, 1_000 + TARGET_LOCK_TTL_MS)
  assert.equal(captured.expiresAt - captured.capturedAt, 15_000)
  assert.equal(captured.hwnd, IDENTITY.hwnd)
  assert.equal(captured.pid, IDENTITY.pid)
  assert.equal(captured.processStartedAt, IDENTITY.processStartedAt)
  assert.equal(captured.displayId, IDENTITY.displayId)
  assert.equal('title' in captured, false, '锁不保存标题，更不保存正文')
  assert.equal(f.calls.foreground, 1)
})

test('假时钟：TTL 内核验通过，到期即失效', async () => {
  const f = fakeIO()
  const lock = createTargetLock(f.io, { platform: 'win32', lockId: () => 'lock-1' })
  const captured = await lock.captureTargetLock(1_000)
  assert.ok(captured)
  assert.deepEqual(f.calls.process, [], '捕获时不查进程')
  const alive = await lock.resolveTargetLock('lock-1', 1_000 + TARGET_LOCK_TTL_MS - 1)
  assert.ok(alive, '到期前一拍仍有效')
  assert.deepEqual(f.calls.process, [IDENTITY.pid])
  const expired = await lock.resolveTargetLock('lock-1', 1_000 + TARGET_LOCK_TTL_MS)
  assert.equal(expired, null, '到达 expiresAt 即失效')
  assert.equal(await lock.resolveTargetLock('lock-1', 2_000), null, '过期锁已删除')
})

test('PID 复用：同一 pid 但启动时间不同 → 拒绝并删锁', async () => {
  const f = fakeIO({ process: { alive: true, processStartedAt: '999999999999999999', processPath: IDENTITY.processPath } })
  const lock = createTargetLock(f.io, { platform: 'win32', lockId: () => 'lock-1' })
  await lock.captureTargetLock(1_000)
  assert.equal(await lock.resolveTargetLock('lock-1', 2_000), null, 'pid 被新进程复用，不是同一代')
  assert.equal(await lock.resolveTargetLock('lock-1', 2_000), null, '失效后锁已删除')
})

test('进程退出、路径变化、查询异常都失效', async () => {
  const gone = fakeIO({ process: null })
  const lockGone = createTargetLock(gone.io, { platform: 'win32' })
  const captured = await lockGone.captureTargetLock(1_000)
  assert.ok(captured)
  assert.equal(await lockGone.resolveTargetLock(captured.lockId, 2_000), null, '进程已退出')

  const moved = fakeIO({ process: { alive: true, processStartedAt: IDENTITY.processStartedAt, processPath: 'C:\\Other\\wps.exe' } })
  const lockMoved = createTargetLock(moved.io, { platform: 'win32' })
  const captured2 = await lockMoved.captureTargetLock(1_000)
  assert.ok(captured2)
  assert.equal(await lockMoved.resolveTargetLock(captured2.lockId, 2_000), null, '进程路径变化')

  const broken = fakeIO({ throwOn: 'process' })
  const lockBroken = createTargetLock(broken.io, { platform: 'win32' })
  const captured3 = await lockBroken.captureTargetLock(1_000)
  assert.ok(captured3)
  assert.equal(await lockBroken.resolveTargetLock(captured3.lockId, 2_000), null, '核验异常宁可失效')
})

test('非 Windows 平台 unsupported：捕获与解析都返回 null', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const f = fakeIO()
    const lock = createTargetLock(f.io, { platform })
    assert.equal(await lock.captureTargetLock(1_000), null)
    assert.equal(await lock.resolveTargetLock('lock-1', 2_000), null)
    assert.equal(f.calls.foreground, 0, '不支持的平台不发起任何读取')
  }
})

test('内存态：invalidateAll 全失效；无效身份与读取异常不产生锁', async () => {
  const f = fakeIO()
  const lock = createTargetLock(f.io, { platform: 'win32', lockId: () => 'lock-1' })
  await lock.captureTargetLock(1_000)
  lock.invalidateAll()
  assert.equal(await lock.resolveTargetLock('lock-1', 2_000), null, '代次变化一键清空')

  const badIdentity = fakeIO({ foreground: { ...IDENTITY, processStartedAt: '' } })
  const lockBad = createTargetLock(badIdentity.io, { platform: 'win32' })
  assert.equal(await lockBad.captureTargetLock(1_000), null, '缺进程启动时间不能锁')

  const noForeground = fakeIO({ foreground: null })
  const lockNone = createTargetLock(noForeground.io, { platform: 'win32' })
  assert.equal(await lockNone.captureTargetLock(1_000), null)

  const throwing = fakeIO({ throwOn: 'foreground' })
  const lockThrow = createTargetLock(throwing.io, { platform: 'win32' })
  assert.equal(await lockThrow.captureTargetLock(1_000), null)
})

test('win-actions 适配器：身份字段齐全才映射，缺字段返回 null', async () => {
  const identity: WindowIdentity & { displayId: string } = {
    platform: 'win32', pid: IDENTITY.pid, windowId: IDENTITY.hwnd, title: '某文档 - WPS Office',
    processPath: IDENTITY.processPath, processStartedAt: IDENTITY.processStartedAt, displayId: IDENTITY.displayId,
  }
  const io = winActionsTargetLockIO({
    readForegroundIdentity: async () => ok(identity, { action: 'verify', platform: 'win32' }),
    readProcessIdentity: async () => ok({ alive: true, processStartedAt: IDENTITY.processStartedAt, processPath: IDENTITY.processPath }, { action: 'verify', platform: 'win32' }),
  })
  assert.deepEqual(await io.foregroundIdentity(), IDENTITY, '标题不进锁')
  assert.deepEqual(await io.processIdentity(IDENTITY.pid), { alive: true, processStartedAt: IDENTITY.processStartedAt, processPath: IDENTITY.processPath })

  const missing = winActionsTargetLockIO({
    readForegroundIdentity: async () => ok({ ...identity, processStartedAt: undefined }, { action: 'verify', platform: 'win32' }),
    readProcessIdentity: async () => ok({ alive: false }, { action: 'verify', platform: 'win32' }),
  })
  assert.equal(await missing.foregroundIdentity(), null, '拿不到启动时间宁可缺锁')
  assert.equal(await missing.processIdentity(IDENTITY.pid), null, '进程已退出')

  const failed = winActionsTargetLockIO({
    readForegroundIdentity: async () => fail('unsupported', '没有前台窗口', { action: 'verify', platform: 'win32' }),
    readProcessIdentity: async () => fail('failed', '辅助进程不可用', { action: 'verify', platform: 'win32' }),
  })
  assert.equal(await failed.foregroundIdentity(), null)
  assert.equal(await failed.processIdentity(IDENTITY.pid), null)
})