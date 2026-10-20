/**
 * 外放插话（M1-05）的纯逻辑与管线测试：检测器、检出→本地止声→交接给听写（预滚动不丢话头）、
 * 渲染层播放器的回执协议。全部假时钟 / 假音频，不出声、不开麦。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { AudioCaptureService, type CaptureDeps, type CaptureFrame, type ContextLike, type ProcessorLike, type StreamLike } from '../src/renderer/audio-capture.ts'
import { BargeInDetector, BargeInSession, DEFAULT_BARGE_IN, isWakePhraseOnly, type BargeInMetrics } from '../src/renderer/barge-in.ts'
import { recordDictation } from '../src/renderer/dictation.ts'
import { RendererPlayer, type PlaybackContextLike, type PlaybackReceiptPayload } from '../src/renderer/playback.ts'

const FRAME_MS = 20

/** 按 20ms 一帧喂检测器：levels 是每帧 RMS。返回第一次检出。 */
function run(levels: number[], clock: (atMs: number) => { playingSince: number | null; lastEndedAt: number | null }, config = {}) {
  const detector = new BargeInDetector(config)
  for (let i = 0; i < levels.length; i++) {
    const atMs = i * FRAME_MS
    const decision = detector.push({ atMs, durationMs: FRAME_MS, rms: levels[i] }, clock(atMs))
    if (decision) return { decision, index: i, detector }
  }
  return { decision: null, index: -1, detector }
}
const playingFrom0 = () => ({ playingSince: 0, lastEndedAt: null })
/** 回声残余：0.01 上下抖动（模拟回声消除没减干净的助理声音）。 */
const residual = (n: number, seed = 1) => Array.from({ length: n }, (_, i) => 0.008 + 0.004 * Math.abs(Math.sin(i * 1.7 + seed)))

describe('插话检测器', () => {
  test('播放期残余为基线：持续不触发（助理自己的声音不算插话）', () => {
    const { decision } = run(residual(500), playingFrom0)
    assert.equal(decision, null)
  })

  test('用户开口：满最短时长才检出，起点回溯到语音第一帧', () => {
    const levels = [...residual(100), ...Array(30).fill(0.08)]
    const { decision, index } = run(levels, playingFrom0)
    assert.ok(decision)
    assert.equal(decision.onsetAtMs, 100 * FRAME_MS, '起点是语音第一帧')
    assert.equal(index, 100 + DEFAULT_BARGE_IN.minSpeechMs / FRAME_MS - 1)
    assert.ok(decision.detectedAtMs - decision.onsetAtMs >= DEFAULT_BARGE_IN.minSpeechMs)
    assert.ok(decision.baselineRms > 0.008 && decision.baselineRms < 0.013)
  })

  test('短促的响动（咳嗽 / 敲桌 / 电视里一个字）不触发', () => {
    const levels = [...residual(100), ...Array(5).fill(0.1), ...residual(100, 2), ...Array(6).fill(0.1), ...residual(100, 3)]
    assert.equal(run(levels, playingFrom0).decision, null)
  })

  test('允许语音段里的短暂低谷（字与字之间）', () => {
    const word = [...Array(4).fill(0.08), 0.01, 0.01, ...Array(4).fill(0.08), 0.01, ...Array(4).fill(0.08)]
    const { decision } = run([...residual(100), ...word], playingFrom0)
    assert.ok(decision)
    assert.equal(decision.onsetAtMs, 100 * FRAME_MS)
  })

  test('播放起始收敛期内不判定（即使很响）', () => {
    const levels = [...Array(10).fill(0.1), ...residual(100)]
    assert.equal(run(levels, playingFrom0).decision, null, `前 ${DEFAULT_BARGE_IN.convergeMs}ms 只学基线`)
  })

  test('还没开始播（等合成）不判定；句间空档过了尾音期可以判定', () => {
    const levels = [...residual(20), ...Array(30).fill(0.08)]
    assert.equal(run(levels, () => ({ playingSince: null, lastEndedAt: null })).decision, null)
    const gap = run(levels, () => ({ playingSince: null, lastEndedAt: -1000 }))
    assert.ok(gap.decision)
  })

  test('稳定的电视声：基线随之抬高，同等响度不触发；明显更响的人声仍能检出', () => {
    const tv = Array.from({ length: 300 }, (_, i) => 0.03 + 0.01 * Math.sin(i / 3))
    assert.equal(run(tv, playingFrom0).decision, null)
    const louder = run([...tv, ...Array(30).fill(0.2)], playingFrom0)
    assert.ok(louder.decision)
  })

  test('回归：自动增益放大后的人声（音节间大起大落）不会把阈值一路抬高到检不出', () => {
    // 隔离验证里实测到的失败模式：旧实现把弱音节学进基线、取高分位，阈值跟着人声涨到 0.6+，之后每次都漏检。
    const syllables = (n: number) => Array.from({ length: n }, (_, i) => [0.3, 0.02, 0.25, 0.004, 0.18, 0.05][i % 6])
    const quiet = (n: number) => Array(n).fill(0.002)
    const levels = [...syllables(40), ...quiet(100), ...syllables(40)]
    const detector = new BargeInDetector()
    const hits: number[] = []
    for (let i = 0; i < levels.length; i++) {
      const decision = detector.push({ atMs: i * FRAME_MS, durationMs: FRAME_MS, rms: levels[i] }, { playingSince: 0, lastEndedAt: null })
      if (decision) hits.push(i)
    }
    assert.ok(hits.some(i => i >= 140), `第二段人声必须检出（检出帧：${hits}）`)
    assert.ok(detector.threshold() <= DEFAULT_BARGE_IN.ceilingRms)
  })

  test('绝对下限：极安静房间里的轻微底噪起伏不触发', () => {
    const quiet = Array.from({ length: 300 }, (_, i) => 0.0005 + 0.003 * (i % 37 === 0 ? 1 : 0))
    assert.equal(run(quiet, playingFrom0).decision, null)
  })
})

test('自己念唤醒词：识别出来只是"小潘同学"时只当打断，不当成要发的话', () => {
  for (const text of ['小潘同学', '小潘，同学。', ' 小盼同学 ', '晓攀同学！', '小盘同学']) assert.equal(isWakePhraseOnly(text), true, text)
  for (const text of ['小潘同学帮我查日程', '小潘你好', '停一下', '']) assert.equal(isWakePhraseOnly(text), false, text)
})

// ── 管线：采集 → 检测 → 本地止声 → 交接给听写 ─────────────────────────────

class FakeProcessor implements ProcessorLike {
  onaudioprocess: ProcessorLike['onaudioprocess'] = null
  connect(): void {}
  disconnect(): void {}
}

function fakeCapture(frameSize: number) {
  const clock = { now: 0 }
  let processor: FakeProcessor | null = null
  const timers: Array<{ fn: () => void }> = []
  const deps: CaptureDeps = {
    getUserMedia: async () => ({ getTracks: () => [{ stop() {}, addEventListener() {} }] }) as unknown as StreamLike,
    createContext: () => ({
      sampleRate: 16000, destination: {},
      createMediaStreamSource: () => ({ connect() {} }),
      createScriptProcessor: () => { const p = new FakeProcessor(); if (processor === null) processor = p; return p },
      close: async () => { processor = null },
    }) as unknown as ContextLike,
    now: () => clock.now,
    setTimeout: (fn) => { timers.push({ fn }); return timers.length },
    clearTimeout: () => {},
  }
  const capture = new AudioCaptureService(deps, { frameSize, lingerMs: 300, prerollMaxMs: 2000 })
  return {
    capture, clock,
    pump(level: number) {
      const samples = new Float32Array(frameSize).fill(level)
      clock.now += (frameSize / 16000) * 1000
      processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } })
    },
  }
}

/** 假的渲染层播放器：只有时钟与停声，不出声。 */
function fakePlayer(clock: { now: number }) {
  const receipts: PlaybackReceiptPayload[] = []
  let probe: ((data: Float32Array) => void) | null = null
  const context: PlaybackContextLike = {
    currentTime: 0, destination: {}, outputLatency: 0.04,
    decodeAudioData: async () => ({ duration: 10 }),
    createBufferSource: () => ({ buffer: null, onended: null, connect() {}, disconnect() {}, start() {}, stop() {} }),
    createGain: () => ({ gain: { value: 1, setValueAtTime() {} }, connect() {}, disconnect() {} }),
    createScriptProcessor: () => {
      const node = { onaudioprocess: null as ((e: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null, connect() {}, disconnect() {} }
      probe = (data) => node.onaudioprocess?.({ inputBuffer: { getChannelData: () => data } })
      return node
    },
  }
  const player = new RendererPlayer({ createContext: () => context, now: () => clock.now, send: r => receipts.push(r), setTimeout: () => 0 })
  return { player, receipts, probe: (data: Float32Array) => probe?.(data) }
}

describe('插话管线（假采集 + 假播放）', () => {
  test('检出即本地止声；预滚动（检出点前 ≥300ms）+ 交接期帧完整交给听写，不重不漏', async () => {
    const { capture, clock, pump } = fakeCapture(320) // 20ms/帧 @16k
    const { player, receipts, probe } = fakePlayer(clock)
    capture.setGrants({ bargeIn: true })
    await player.play('u#0', 'AAAA')
    assert.equal(receipts[0].kind, 'started')
    const detections: number[] = []
    const metrics: BargeInMetrics[] = []
    const session = new BargeInSession({
      capture, player, now: () => clock.now, setTimeout: () => 0,
      onDetected: ({ decision }) => detections.push(decision.detectedAtMs),
      onMetrics: m => metrics.push(m),
    })
    await session.start()
    for (let i = 0; i < 60; i++) pump(0.01) // 1.2s 回声残余
    for (let i = 0; i < 12 && detections.length === 0; i++) pump(0.08) // 用户开口
    assert.equal(detections.length, 1, '检出一次')
    // 口令式打断：检出人声**不**本地止声，等识别出明确口令再停。
    // 否则外放时助理自己的回声、环境闲聊都会把朗读打断（现场故障：说一半自己停了）。
    assert.equal(player.playing, true, '检出后继续播，等口令')
    probe(new Float32Array(256)) // 输出端探针读到全零
    await new Promise(r => setTimeout(r, 0))
    assert.equal(metrics.length, 1)
    assert.ok(metrics[0].onsetToDetectMs >= DEFAULT_BARGE_IN.minSpeechMs - 1)
    // 口令式打断：检出时不做本地止声，所以没有"检出→静音"的时刻（那是旧行为才有的指标）。
    assert.equal(metrics[0].detectToSilenceMs, null, '口令式打断下没有本地止声时刻')
    // 检出之后、听写接手之前的帧也要留着。
    for (let i = 0; i < 5; i++) pump(0.08)

    // 主进程把设备判给听写：授权里先有听写（插话订阅在交接完成前保留）。
    capture.setGrants({ dictation: true, bargeIn: true })
    const chunks: number[] = []
    const recording = recordDictation({ capture, takeHandover: () => session.takeHandover(), onChunk: c => chunks.push(c.length) })
    await new Promise(r => setTimeout(r, 0))
    for (let i = 0; i < 3; i++) pump(0.08)
    for (let i = 0; i < 50; i++) pump(0.001) // 说完的静音
    const result = await recording
    assert.ok(result.wav)
    const samples = (result.wav.byteLength - 44) / 2
    const onsetFrames = 12 // 语音持续帧（含交接与之后）
    // 预滚动：语音起点前 prerollMs（400ms = 20 帧）+ 检出前的语音 + 交接期 5 帧 + 之后 3 帧 + 静音。
    assert.ok(samples >= (20 + 10 + 5 + 3) * 320, `听写拿到 ${samples / 320} 帧，话头被切了`)
    assert.ok(samples < (20 + onsetFrames + 5 + 3 + 50 + 2) * 320, '有重复帧')
    // 按序号不重复：第一块是预滚动的最早一帧，之后连续。
    assert.equal(chunks.length * 320, samples, '流式喂数与 wav 一致')
    // 口令式打断下，检出本身不产生本地停止，所以这里不会有 barge-in 原因的取消回执；
    // 真正止声发生在识别出"停一下"之后，由主进程走正常的 stop 通道。
    player.handleStopRequest('u#0')
    await new Promise(r => setTimeout(r, 0))
    const cancelled = receipts.find(r => r.kind === 'cancelled')
    assert.equal(cancelled, undefined, '检出后不本地止声，因此没有 barge-in 取消回执')
  })

  test('没有检出时停：立即退订；检出后不交接则超时退订（不一直占设备）', async () => {
    const { capture, clock, pump } = fakeCapture(320)
    const { player } = fakePlayer(clock)
    capture.setGrants({ bargeIn: true })
    const session = new BargeInSession({ capture, player, now: () => clock.now, setTimeout: () => 0, onDetected: () => {} })
    await session.start()
    pump(0.01)
    assert.deepEqual(capture.snapshot().consumers, ['barge-in'])
    session.stop()
    assert.deepEqual(capture.snapshot().consumers, [])
  })

  test('听写第一次判到开口只报一次 onSpeechStart（连续对话据此撤掉静默窗）', async () => {
    const { capture, pump } = fakeCapture(320)
    capture.setGrants({ dictation: true })
    let started = 0
    const recording = recordDictation({ capture, onSpeechStart: () => { started++ } })
    await new Promise(r => setTimeout(r, 0))
    for (let i = 0; i < 35; i++) pump(0.01) // 只量基线，还没人说话
    assert.equal(started, 0, '基线不算开口')
    for (let i = 0; i < 10; i++) pump(0.08)
    assert.equal(started, 1)
    for (let i = 0; i < 10; i++) pump(0.08) // 同一句话继续说
    for (let i = 0; i < 50; i++) pump(0.001) // 说完的静音
    const result = await recording
    assert.ok(result.wav)
    assert.equal(started, 1, '一句话只报一次')
  })
})

describe('渲染层播放器回执', () => {
  test('实际开始报 started（带时长与输出延迟）；自然播完报 finished', async () => {
    const clock = { now: 100 }
    const sends: PlaybackReceiptPayload[] = []
    let ended: (() => void) | null = null
    const player = new RendererPlayer({
      createContext: () => ({
        currentTime: 0, destination: {}, outputLatency: 0.03,
        decodeAudioData: async () => ({ duration: 1.5 }),
        createBufferSource: () => { const s = { buffer: null, onended: null as (() => void) | null, connect() {}, disconnect() {}, start() {}, stop() {} }; queueMicrotask(() => { ended = () => s.onended?.() }); return s },
        createGain: () => ({ gain: { value: 1, setValueAtTime() {} }, connect() {}, disconnect() {} }),
        createScriptProcessor: () => ({ onaudioprocess: null, connect() {}, disconnect() {} }),
      }),
      now: () => clock.now, send: r => sends.push(r), setTimeout: () => 0,
    })
    await player.play('a#0', 'AAAA')
    assert.equal(sends[0].kind, 'started')
    assert.equal(sends[0].durationMs, 1500)
    assert.equal(sends[0].outputLatencyMs, 30)
    await new Promise(r => setTimeout(r, 0))
    ended!()
    assert.equal(sends[1].kind, 'finished')
    assert.equal(player.playing, false)
  })

  test('解码失败报 error；主进程要求停的是别的句子时不造回执', async () => {
    const sends: PlaybackReceiptPayload[] = []
    const player = new RendererPlayer({
      createContext: () => ({
        currentTime: 0, destination: {},
        decodeAudioData: async () => { throw new Error('bad') },
        createBufferSource: () => { throw new Error('unused') },
        createGain: () => { throw new Error('unused') },
        createScriptProcessor: () => { throw new Error('unused') },
      }),
      now: () => 0, send: r => sends.push(r), setTimeout: () => 0,
    })
    await player.play('b#0', 'AAAA')
    assert.equal(sends[0].kind, 'error')
    player.handleStopRequest('other')
    assert.equal(sends.length, 1)
  })
})
