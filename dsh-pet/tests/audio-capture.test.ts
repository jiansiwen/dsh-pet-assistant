/**
 * 共享采集服务（M1-03）的生命周期测试：假 MediaStream / 假 AudioContext / 假时钟。
 *
 * 钉住的事实：设备只开一次；按授权订阅、授权撤回即强制退订；帧带序号 / 采样率 / 单调时间 / 缺口；
 * 预滚动缓冲有界且没人要时清空；重复开始停止、轨道 ended（权限撤销）、devicechange、休眠恢复、
 * 消费者抛错，都会释放资源 —— 最后一定没有一条还在跑的轨道（"不锁麦克风"）。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  AudioCaptureService, CaptureError, type CaptureDeps, type CaptureFrame, type ContextLike, type DeviceInfoLike, type ProcessorLike, type StreamLike, type TrackLike,
} from '../src/renderer/audio-capture.ts'

class FakeTrack implements TrackLike {
  stopped = false
  readyState = 'live'
  private listeners: Array<() => void> = []
  readonly deviceId: string
  readonly groupId: string
  constructor(deviceId: string, groupId: string) { this.deviceId = deviceId; this.groupId = groupId }
  stop(): void { this.stopped = true; this.readyState = 'ended' }
  addEventListener(_type: 'ended', listener: () => void): void { this.listeners.push(listener) }
  removeEventListener(_type: 'ended', listener: () => void): void { this.listeners = this.listeners.filter(l => l !== listener) }
  getSettings() { return { deviceId: this.deviceId, groupId: this.groupId } }
  /** 模拟系统收走设备（权限撤销 / 拔出）。 */
  end(): void { this.readyState = 'ended'; for (const l of [...this.listeners]) l() }
}

class FakeProcessor implements ProcessorLike {
  onaudioprocess: ProcessorLike['onaudioprocess'] = null
  connected = false
  connect(): void { this.connected = true }
  disconnect(): void { this.connected = false }
}

class FakeContext implements ContextLike {
  closed = false
  readonly destination = {}
  processors: FakeProcessor[] = []
  readonly sampleRate: number
  constructor(sampleRate: number) { this.sampleRate = sampleRate }
  createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  createScriptProcessor(): FakeProcessor { const p = new FakeProcessor(); this.processors.push(p); return p }
  async close(): Promise<void> { this.closed = true }
}

interface Harness {
  capture: AudioCaptureService
  tracks: FakeTrack[]
  contexts: FakeContext[]
  clock: { now: number }
  devices: DeviceInfoLike[]
  /** 推一块音频（frameSize 个样本，值为 level）。返回推进后的时间。 */
  pump(level?: number, opts?: { skipMs?: number }): void
  fireDeviceChange(): Promise<void>
  flushTimers(): void
  live(): FakeTrack[]
  failNext: { error: unknown } | null
  sampleRate: number
}

function harness(options: { frameSize?: number; lingerMs?: number; prerollMaxMs?: number } = {}): Harness {
  const frameSize = options.frameSize ?? 480
  const tracks: FakeTrack[] = []
  const contexts: FakeContext[] = []
  const clock = { now: 1000 }
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let timerId = 0
  let deviceListener: (() => void) | null = null
  const h: Harness = {
    capture: null as unknown as AudioCaptureService,
    tracks, contexts, clock,
    devices: [{ kind: 'audioinput', deviceId: 'default', groupId: 'g1' }],
    failNext: null,
    sampleRate: 48000,
    pump(level = 0.01, opts = {}) {
      const context = contexts.at(-1)
      if (!context || context.closed) return
      const processor = context.processors[0]
      const samples = new Float32Array(frameSize).fill(level)
      clock.now += (frameSize / context.sampleRate) * 1000 + (opts.skipMs ?? 0)
      processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } })
    },
    async fireDeviceChange() { deviceListener?.(); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)) },
    flushTimers() {
      const due = timers.filter(t => t.at <= clock.now + 1e9).sort((a, b) => a.at - b.at)
      for (const t of due) { timers.splice(timers.indexOf(t), 1); t.fn() }
    },
    live() { return tracks.filter(t => !t.stopped) },
  }
  const deps: CaptureDeps = {
    getUserMedia: async (constraints) => {
      assert.equal(constraints.audio.echoCancellation, true, '回声消除必须开着（插话检测靠它）')
      if (h.failNext) { const { error } = h.failNext; h.failNext = null; throw error }
      const group = h.devices[0]?.groupId ?? 'g1'
      const track = new FakeTrack('default', group)
      tracks.push(track)
      return { getTracks: () => [track], getAudioTracks: () => [track] } as StreamLike
    },
    createContext: () => { const c = new FakeContext(h.sampleRate); contexts.push(c); return c },
    now: () => clock.now,
    enumerateDevices: async () => h.devices,
    onDeviceChange: (listener) => { deviceListener = listener; return () => { deviceListener = null } },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.push({ at: clock.now + ms, fn, id }); return id },
    clearTimeout: (handle) => { const i = timers.findIndex(t => t.id === handle); if (i >= 0) timers.splice(i, 1) },
  }
  h.capture = new AudioCaptureService(deps, { frameSize, lingerMs: options.lingerMs ?? 300, prerollMaxMs: options.prerollMaxMs ?? 200 })
  return h
}

const ALL = { dictation: true, bargeIn: true, kws: true, meetingId: 'meeting-1' }

describe('授权：谁能订阅由主进程仲裁器说了算', () => {
  test('没有授权不能订阅，也不会碰设备', async () => {
    const h = harness()
    await assert.rejects(h.capture.subscribe({ kind: 'dictation', onFrame: () => {} }), (e: unknown) => e instanceof CaptureError && e.code === 'not-authorized')
    assert.equal(h.tracks.length, 0)
  })

  test('会议轨必须带正在录的那场会议 id', async () => {
    const h = harness()
    h.capture.setGrants({ meetingId: 'meeting-1' })
    await assert.rejects(h.capture.subscribe({ kind: 'meeting', token: 'meeting-0', onFrame: () => {} }))
    await assert.rejects(h.capture.subscribe({ kind: 'meeting', onFrame: () => {} }))
    const sub = await h.capture.subscribe({ kind: 'meeting', token: 'meeting-1', onFrame: () => {} })
    sub.close()
  })

  test('授权撤回即强制退订（回执 reason=revoked），设备随后释放', async () => {
    const h = harness()
    h.capture.setGrants({ kws: true })
    const sub = await h.capture.subscribe({ kind: 'kws', onFrame: () => {} })
    h.capture.setGrants({})
    const receipt = await sub.ended
    assert.equal(receipt.reason, 'revoked')
    h.flushTimers()
    assert.equal(h.live().length, 0, '不锁麦克风')
    assert.equal(h.contexts.at(-1)!.closed, true)
  })

  test('waitForGrant：授权晚到也能等到；超时如实返回 false', async () => {
    const h = harness()
    const waiting = h.capture.waitForGrant('dictation', 1000)
    h.capture.setGrants({ dictation: true })
    assert.equal(await waiting, true)
    const late = h.capture.waitForGrant('kws', 1000)
    h.flushTimers()
    assert.equal(await late, false)
  })
})

describe('设备只开一次，帧带完整事实', () => {
  test('多个消费者共享同一个设备；帧序号、采样率、单调时间连续', async () => {
    const h = harness()
    h.capture.setGrants(ALL)
    const a: CaptureFrame[] = []
    const b: CaptureFrame[] = []
    const subA = await h.capture.subscribe({ kind: 'dictation', onFrame: f => a.push(f) })
    const subB = await h.capture.subscribe({ kind: 'kws', onFrame: f => b.push(f) })
    assert.equal(h.tracks.length, 1, '第二个消费者不再开设备')
    for (let i = 0; i < 5; i++) h.pump(0.02)
    assert.equal(a.length, 5)
    assert.deepEqual(a.map(f => f.seq), [0, 1, 2, 3, 4])
    assert.deepEqual(b.map(f => f.seq), a.map(f => f.seq), '两个消费者看到的是同一份事实')
    assert.equal(a[0].sampleRate, 48000)
    for (let i = 1; i < a.length; i++) assert.ok(Math.abs(a[i].atMs - (a[i - 1].atMs + a[i - 1].durationMs)) < 1e-6, '时间轴按样本数连续')
    assert.equal(a.some(f => f.gapBefore), false)
    assert.ok(Math.abs(a[0].rms - 0.02) < 1e-6)
    const receipt = subA.close()
    assert.equal(receipt.reason, 'unsubscribed')
    assert.equal(receipt.frames, 5)
    assert.equal(receipt.lastSeq, 4)
    assert.deepEqual(subA.close(), receipt, '重复退订幂等，同一张回执')
    subB.close()
    h.flushTimers()
    assert.equal(h.live().length, 0)
  })

  test('回调时刻跳变（主线程卡顿 / 休眠）：帧标缺口并重新起算', async () => {
    const h = harness()
    h.capture.setGrants(ALL)
    const frames: CaptureFrame[] = []
    const sub = await h.capture.subscribe({ kind: 'dictation', onFrame: f => frames.push(f) })
    h.pump(); h.pump(); h.pump(0.01, { skipMs: 900 }); h.pump()
    assert.deepEqual(frames.map(f => f.gapBefore), [false, false, true, false])
    assert.equal(h.capture.snapshot().gaps, 1)
    sub.close()
  })

  test('最后一个消费者退订后短暂停留再关；停留期间再订阅复用设备', async () => {
    const h = harness()
    h.capture.setGrants(ALL)
    const first = await h.capture.subscribe({ kind: 'barge-in', onFrame: () => {} })
    first.close()
    assert.equal(h.live().length, 1, '交接窗口内设备还开着')
    const second = await h.capture.subscribe({ kind: 'dictation', onFrame: () => {} })
    assert.equal(h.tracks.length, 1, '没有关了再开')
    second.close()
    h.flushTimers()
    assert.equal(h.live().length, 0)
    assert.equal(h.capture.snapshot().open, false)
  })

  test('重复开始 / 停止 20 次：每次都释放干净，开关次数对得上', async () => {
    const h = harness()
    h.capture.setGrants(ALL)
    for (let i = 0; i < 20; i++) {
      const sub = await h.capture.subscribe({ kind: 'dictation', onFrame: () => {} })
      h.pump()
      sub.close()
      h.flushTimers()
      assert.equal(h.live().length, 0, `第 ${i + 1} 次之后还有轨道没停`)
    }
    const snap = h.capture.snapshot()
    assert.equal(snap.opens, 20)
    assert.equal(snap.closes, 20)
  })

  test('打开设备期间就退订：打开完成后立刻释放，不留一个没人用的麦克风', async () => {
    const h = harness()
    h.capture.setGrants(ALL)
    const pending = h.capture.subscribe({ kind: 'dictation', onFrame: () => {} })
    h.capture.setGrants({})
    await assert.rejects(pending)
    assert.equal(h.live().length, 0)
  })

  test('打开失败（权限被拒）：如实报原因，不留半开的资源', async () => {
    const h = harness()
    h.capture.setGrants(ALL)
    h.failNext = { error: Object.assign(new Error('denied'), { name: 'NotAllowedError' }) }
    await assert.rejects(h.capture.subscribe({ kind: 'kws', onFrame: () => {} }), (e: unknown) => e instanceof CaptureError && e.code === 'denied' && /权限/.test(e.message))
    assert.equal(h.capture.snapshot().open, false)
    // 下一次照常能开。
    const sub = await h.capture.subscribe({ kind: 'kws', onFrame: () => {} })
    assert.equal(h.live().length, 1)
    sub.close()
  })
})

describe('异常生命周期都释放资源', () => {
  test('轨道 ended（权限撤销 / 拔设备）：所有订阅结束并立即释放', async () => {
    const h = harness()
    h.capture.setGrants(ALL)
    const a = await h.capture.subscribe({ kind: 'dictation', onFrame: () => {} })
    const b = await h.capture.subscribe({ kind: 'kws', onFrame: () => {} })
    h.tracks[0].end()
    assert.equal((await a.ended).reason, 'track-ended')
    assert.equal((await b.ended).reason, 'track-ended')
    assert.equal(h.capture.snapshot().open, false, '不等停留期')
    assert.equal(h.contexts[0].closed, true)
  })

  test('设备切换：当前设备不在了就重开，订阅保留、下一帧标缺口', async () => {
    const h = harness()
    h.capture.setGrants(ALL)
    const frames: CaptureFrame[] = []
    const sub = await h.capture.subscribe({ kind: 'dictation', onFrame: f => frames.push(f) })
    h.pump()
    h.devices = [{ kind: 'audioinput', deviceId: 'default', groupId: 'g2' }]
    await h.fireDeviceChange()
    assert.equal(h.tracks.length, 2, '重开了一次')
    assert.equal(h.tracks[0].stopped, true, '旧轨道停掉')
    h.pump()
    assert.equal(frames.at(-1)!.gapBefore, true)
    assert.equal(frames.at(-1)!.session, 2)
    assert.ok(frames.at(-1)!.seq > frames[0].seq, '序号跨重开连续')
    sub.close()
    h.flushTimers()
    assert.equal(h.live().length, 0)
  })

  test('设备切换后重开失败：订阅如实结束（device-changed），资源释放', async () => {
    const h = harness()
    h.capture.setGrants(ALL)
    const sub = await h.capture.subscribe({ kind: 'kws', onFrame: () => {} })
    h.devices = []
    h.failNext = { error: Object.assign(new Error('none'), { name: 'NotFoundError' }) }
    await h.fireDeviceChange()
    const receipt = await sub.ended
    assert.equal(receipt.reason, 'device-changed')
    assert.match(receipt.detail ?? '', /没有找到/)
    h.flushTimers()
    assert.equal(h.live().length, 0)
  })

  test('无关的设备变化（插了个耳机输出）不重开', async () => {
    const h = harness()
    h.capture.setGrants(ALL)
    const sub = await h.capture.subscribe({ kind: 'kws', onFrame: () => {} })
    h.devices = [...h.devices, { kind: 'audiooutput', deviceId: 'hp', groupId: 'g9' }]
    await h.fireDeviceChange()
    assert.equal(h.tracks.length, 1)
    sub.close()
  })

  test('休眠恢复：开着就重开一次，订阅保留', async () => {
    const h = harness()
    h.capture.setGrants(ALL)
    const frames: CaptureFrame[] = []
    const sub = await h.capture.subscribe({ kind: 'kws', onFrame: f => frames.push(f) })
    h.capture.handleResume()
    await new Promise(r => setTimeout(r, 0))
    assert.equal(h.tracks.length, 2)
    h.pump()
    assert.equal(frames[0].gapBefore, true)
    sub.close()
    h.flushTimers()
    assert.equal(h.live().length, 0)
    // 没开着时恢复什么都不做。
    h.capture.handleResume()
    await new Promise(r => setTimeout(r, 0))
    assert.equal(h.tracks.length, 2)
  })

  test('消费者抛错：只结束它自己（consumer-error），别的消费者照常；最后一个也走了就释放', async () => {
    const h = harness()
    h.capture.setGrants(ALL)
    const good: CaptureFrame[] = []
    const bad = await h.capture.subscribe({ kind: 'kws', onFrame: () => { throw new Error('boom') } })
    const ok = await h.capture.subscribe({ kind: 'dictation', onFrame: f => good.push(f) })
    const warn = console.warn
    console.warn = () => {}
    try { h.pump(); h.pump() } finally { console.warn = warn }
    const receipt = await bad.ended
    assert.equal(receipt.reason, 'consumer-error')
    assert.equal(receipt.detail, 'boom')
    assert.equal(good.length, 2)
    ok.close()
    h.flushTimers()
    assert.equal(h.live().length, 0)
  })

  test('stopAll：全部结束（stopped）并释放', async () => {
    const h = harness()
    h.capture.setGrants(ALL)
    const sub = await h.capture.subscribe({ kind: 'meeting', token: 'meeting-1', onFrame: () => {} })
    h.capture.stopAll()
    assert.equal((await sub.ended).reason, 'stopped')
    assert.equal(h.live().length, 0)
  })
})

describe('预滚动缓冲：有界、只在有人需要时保留', () => {
  test('没有声明 preroll 的订阅时不缓冲', async () => {
    const h = harness()
    h.capture.setGrants(ALL)
    const sub = await h.capture.subscribe({ kind: 'dictation', onFrame: () => {} })
    for (let i = 0; i < 10; i++) h.pump()
    assert.equal(h.capture.snapshot().prerollFrames, 0)
    sub.close()
  })

  test('有界（不超过上限时长）；插话订阅一走立即清空', async () => {
    const h = harness({ prerollMaxMs: 200 })
    h.capture.setGrants(ALL)
    const sub = await h.capture.subscribe({ kind: 'barge-in', preroll: true, onFrame: () => {} })
    for (let i = 0; i < 50; i++) h.pump()
    const frames = h.capture.preroll(-Infinity)
    const total = frames.reduce((sum, f) => sum + f.durationMs, 0)
    assert.ok(total <= 200 + frames[0].durationMs, `缓冲 ${total}ms 超过上限`)
    assert.ok(total >= 190)
    const last = frames.at(-1)!
    assert.deepEqual(h.capture.preroll(last.atMs).map(f => f.seq), [last.seq], '按时刻取预滚动')
    sub.close()
    assert.equal(h.capture.snapshot().prerollFrames, 0)
  })
})
