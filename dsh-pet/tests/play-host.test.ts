/**
 * 常驻播放进程的协议与失败回退。
 *
 * 这条进程专治唤醒后的那两秒空白：每次新起 PowerShell 要 2.5 秒，常驻后只剩 MCI 命令。
 * 这里用替身把 spawn 截住，验证"预热 → 发路径 → 收 ok/err → 进程死了允许重来"，
 * 以及不能用时必须明确返回 null，让调用方回退到一次性脚本（不能静默当成播放成功）。
 */
import assert from 'node:assert/strict'
import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { test } from 'node:test'
import { PlayHost } from '../src/main/play-host.ts'

class FakeStdin extends Writable {
  readonly written: string[] = []

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.written.push(chunk.toString('utf8'))
    callback()
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin()
  readonly stdout = new PassThrough()
  killed = false

  kill(): boolean {
    this.killed = true
    return true
  }
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

function hostWith(child: FakeChild, options: { startTimeoutMs?: number } = {}): PlayHost {
  return new PlayHost({
    scriptDir: 'C:\\app\\dist\\main',
    platform: 'win32',
    startTimeoutMs: options.startTimeoutMs,
    spawnImpl: (() => child) as unknown as typeof spawn,
  })
}

test('非 Windows：不启动，播放请求明确返回 null（调用方回退）', async () => {
  const host = new PlayHost({ scriptDir: '/app/dist/main', platform: 'darwin' })
  assert.equal(await host.start(), false)
  assert.equal(host.play('/tmp/a.mp3'), null)
})

test('预热前播放返回 null，不会把请求排进一个还没 ready 的进程', () => {
  const host = hostWith(new FakeChild())
  assert.equal(host.play('C:\\tmp\\a.mp3'), null)
})

test('ready 之后发路径，ok 回执解析成播放成功', async () => {
  const child = new FakeChild()
  const host = hostWith(child)
  const started = host.start()
  child.stdout.write('ready\n')
  assert.equal(await started, true)
  assert.equal(host.isReady(), true)

  const played = host.play('C:\\tmp\\带 空格\\a.wav')
  assert.ok(played)
  await flush()
  const [id, payload] = (child.stdin.written[0] ?? '').trim().split(' ')
  assert.equal(id, '1')
  // 路径走 base64：中文、空格都不会把一行拆坏。
  assert.equal(Buffer.from(payload ?? '', 'base64').toString('utf8'), 'C:\\tmp\\带 空格\\a.wav')

  child.stdout.write('ok 1\n')
  assert.equal(await played, true)
})

test('err 回执算播放失败，不冒充成功', async () => {
  const child = new FakeChild()
  const host = hostWith(child)
  const started = host.start()
  child.stdout.write('ready\n')
  await started

  const played = host.play('C:\\tmp\\a.mp3')
  assert.ok(played)
  await flush()
  child.stdout.write('err 1\n')
  assert.equal(await played, false)
})

test('进程中途退出：排队的播放立即失败，且允许重新预热', async () => {
  const first = new FakeChild()
  const second = new FakeChild()
  const children = [first, second]
  let spawned = 0
  const host = new PlayHost({
    scriptDir: 'C:\\app\\dist\\main',
    platform: 'win32',
    spawnImpl: (() => children[spawned++]) as unknown as typeof spawn,
  })
  const started = host.start()
  first.stdout.write('ready\n')
  await started

  const played = host.play('C:\\tmp\\a.mp3')
  assert.ok(played)
  await flush()
  first.emit('exit', 1)
  assert.equal(await played, false)
  assert.equal(host.isReady(), false)
  assert.equal(second.killed, false)

  const restarted = host.start()
  second.stdout.write('ready\n')
  assert.equal(await restarted, true)
  assert.equal(host.isReady(), true)
})

test('waitReady：预热窗口内等到 ready 返回 true，唤醒不必回退到慢路径', async () => {
  const child = new FakeChild()
  const host = hostWith(child)
  const started = host.start()
  const waiting = host.waitReady(1_000)
  child.stdout.write('ready\n')
  assert.equal(await waiting, true)
  assert.equal(await started, true)
})

test('waitReady：窗口内没等到就返回 false，调用方照常回退', async () => {
  const child = new FakeChild()
  const host = hostWith(child)
  void host.start()
  assert.equal(await host.waitReady(20), false)
  assert.equal(host.isReady(), false)
})

test('waitReady：没有启动中的进程时立即返回 false，不再反复 spawn', async () => {
  const host = hostWith(new FakeChild())
  assert.equal(await host.waitReady(1_000), false)
})

test('预热超时：启动返回 false 并杀掉卡住的进程', async () => {
  const child = new FakeChild()
  const host = hostWith(child, { startTimeoutMs: 20 })
  assert.equal(await host.start(), false)
  assert.equal(child.killed, true)
  assert.equal(host.isReady(), false)
})

test('stop：先请它自己退出，再强杀兜底', async () => {
  const child = new FakeChild()
  const host = hostWith(child)
  const started = host.start()
  child.stdout.write('ready\n')
  await started

  host.stop()
  assert.ok(child.stdin.written.includes('quit\n'), '正常路径让常驻进程自己结束')
  assert.equal(child.killed, true)
  assert.equal(host.isReady(), false)
  // 收尾之后不再接受新请求（下一次 start 也不会真的发生，进程已经 disposed）。
  assert.equal(host.play('C:\\tmp\\a.mp3'), null)
})
