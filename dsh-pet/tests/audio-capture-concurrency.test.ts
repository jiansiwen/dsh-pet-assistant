/**
 * 三路并发（会议 + 讲解插话 + 唤醒）共用**同一次设备打开**。
 *
 * 这是"录音笔 + 随时唤醒 + 中途提问"能同时成立的硬前提：
 * 设备一旦重开，会议轨就会被判缺口 —— 也就是用户看到的"录音不完整"弹窗。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { AudioCaptureService, type CaptureDeps, type CaptureFrame, type ContextLike } from '../src/renderer/audio-capture.ts'

class FakeTrack {
  stopped = false
  readyState = 'live'
  private listeners: Array<() => void> = []
  readonly deviceId = 'default'
  readonly groupId = 'g1'
  stop(): void { this.stopped = true; this.readyState = 'ended' }
  addEventListener(_type: 'ended', listener: () => void): void { this.listeners.push(listener) }
  removeEventListener(_type: 'ended', _listener: () => void): void { this.listeners = [] }
  getSettings() { return { deviceId: this.deviceId, groupId: this.groupId } }
}

class FakeProcessor {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null = null
  connect(): void {}
  disconnect(): void {}
}

class FakeContext implements ContextLike {
  closed = false
  readonly destination = {}
  readonly processors: FakeProcessor[] = []
  readonly sampleRate = 48000
  createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  createScriptProcessor(): FakeProcessor { const p = new FakeProcessor(); this.processors.push(p); return p }
  async close(): Promise<void> { this.closed = true }
}

void describe('三路并发：一次设备打开，互不打断', () => {
  void test('会议 + 插话 + 唤醒同订，设备只开一次；切换持有者后会议照收', async () => {
    const tracks: FakeTrack[] = []
    const contexts: FakeContext[] = []
    const clock = { now: 1000 }
    const frameSize = 480
    const deps: CaptureDeps = {
      getUserMedia: async () => {
        const track = new FakeTrack()
        tracks.push(track)
        return { getTracks: () => [track], getAudioTracks: () => [track] } as never
      },
      createContext: () => { const c = new FakeContext(); contexts.push(c); return c },
      now: () => clock.now,
      enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'default', groupId: 'g1' }],
      onDeviceChange: () => () => {},
      setTimeout: (fn: () => void) => { void fn; return 1 as never },
      clearTimeout: () => {},
    }
    const capture = new AudioCaptureService(deps, { frameSize, lingerMs: 300, prerollMaxMs: 500 })
    const pump = (): void => {
      const context = contexts.at(-1)
      if (!context || context.closed) return
      const processor = context.processors[0]
      const samples = new Float32Array(frameSize).fill(0.01)
      clock.now += (frameSize / context.sampleRate) * 1000
      processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } })
    }
    capture.setGrants({ dictation: true, bargeIn: true, kws: true, meetingId: 'meeting-1' })

    const meeting: CaptureFrame[] = []
    const meetingSub = await capture.subscribe({ kind: 'meeting', token: 'meeting-1', onFrame: f => meeting.push(f) })
    const barge = await capture.subscribe({ kind: 'barge-in', onFrame: () => {} })
    const kws = await capture.subscribe({ kind: 'kws', onFrame: () => {} })
    assert.equal(tracks.length, 1, '三路并发只该打开一次设备')

    pump(); pump()
    const before = meeting.length
    /* 用户按下听写：插话让路，但设备不重开，会议轨继续收帧。 */
    barge.close()
    capture.setGrants({ meetingId: 'meeting-1', dictation: true })
    const dict = await capture.subscribe({ kind: 'dictation', onFrame: () => {} })
    pump()
    assert.equal(tracks.length, 1, '切换持有者不该重开设备')
    assert.ok(meeting.length > before, '会议轨在听写期间必须继续收帧')

    dict.close()
    kws.close()
    pump()
    meetingSub.close()
    assert.equal(tracks.filter(track => !track.stopped).length > 1, false, '不能留下多条并行采集')
  })
})

void describe('播放期标记：宠物自己的朗读不该被当成你在说话', () => {
  void test('setAssistantSpeaking 之后，帧带上标记；关掉后恢复', async () => {
    const tracks: FakeTrack[] = []
    const contexts: FakeContext[] = []
    const clock = { now: 1000 }
    const frameSize = 480
    const deps: CaptureDeps = {
      getUserMedia: async () => {
        const track = new FakeTrack()
        tracks.push(track)
        return { getTracks: () => [track], getAudioTracks: () => [track] } as never
      },
      createContext: () => { const c = new FakeContext(); contexts.push(c); return c },
      now: () => clock.now,
      enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'default', groupId: 'g1' }],
      onDeviceChange: () => () => {},
      setTimeout: (fn: () => void) => { void fn; return 1 as never },
      clearTimeout: () => {},
    }
    const capture = new AudioCaptureService(deps, { frameSize, lingerMs: 300, prerollMaxMs: 500 })
    capture.setGrants({ dictation: true })
    const frames: CaptureFrame[] = []
    await capture.subscribe({ kind: 'dictation', onFrame: f => frames.push(f) })
    const pump = (): void => {
      const context = contexts.at(-1)
      if (!context || context.closed) return
      const samples = new Float32Array(frameSize).fill(0.01)
      clock.now += (frameSize / context.sampleRate) * 1000
      context.processors[0]?.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } })
    }
    pump()
    capture.setAssistantSpeaking(true)
    pump()
    capture.setAssistantSpeaking(false)
    pump()
    assert.deepEqual(frames.map(f => f.assistantSpeaking), [false, true, false])
  })
})
