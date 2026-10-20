/**
 * M4-02 分轨与统一时间轴的测试：渲染层分轨切块（TrackChunker）、主进程按音轨落盘与校验、
 * 同轨断流、缺失音轨不伪造静音、停录冲刷两路最后一块、按音轨铺时间轴。
 *
 * 全部用合成 PCM（常数样本值区分音轨/说话人），不开麦克风、不跑真模型。
 * 跑法：`npm test`。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { buildTrackTimeline, sliceTimeline } from '../src/main/diarize.ts'
import { resampleTo16k } from '../src/renderer/dictation.ts'
import { TrackChunker, type TrackChunk } from '../src/renderer/meeting-capture.ts'
import {
  CONSENT_BOTH,
  CONSENT_MIC,
  START,
  constPcm,
  meta,
  pushTrack,
  setupRecorder,
} from './meeting-fixtures.ts'

function started(h: ReturnType<typeof setupRecorder>, consent = CONSENT_BOTH): string {
  const result = h.recorder.startMeeting(consent)
  if (!result.ok) throw new Error(result.error)
  return result.meetingId
}

describe('渲染层分轨切块（TrackChunker）', () => {
  test('两路交错到达的回调各自缓冲、各自编号：块里只有自己那一路的样本，起点按样本计数推进', () => {
    const rate = 48000
    const buffer = 4096
    const mic = new TrackChunker({ track: 'mic', sampleRate: rate, chunkMs: 1000, resample: resampleTo16k })
    const loop = new TrackChunker({ track: 'loopback', sampleRate: rate, chunkMs: 1000, resample: resampleTo16k })
    const micFrame = new Float32Array(buffer).fill(0.25)
    const loopFrame = new Float32Array(buffer).fill(-0.5)
    const out: Record<'mic' | 'loopback', TrackChunk[]> = { mic: [], loopback: [] }
    // 同一个 AudioContext 下两个 ScriptProcessor 的回调交替到达；回环晚开 300ms。
    for (let i = 0; i < 30; i++) {
      const offset = (i * buffer / rate) * 1000
      out.mic.push(...mic.push(micFrame, 120 + offset))
      out.loopback.push(...loop.push(loopFrame, 420 + offset))
    }
    out.mic.push(mic.flush() as TrackChunk)
    out.loopback.push(loop.flush() as TrackChunk)
    assert.equal(mic.flush(), null, '冲刷后缓冲为空')

    // 12 次回调（49152 帧 = 1024ms）凑满一块；30 次 = 两整块 + 冲刷出的最后一块（6 次回调）。
    for (const [track, first, sign] of [['mic', 120, 0.25], ['loopback', 420, -0.5]] as const) {
      const chunks = out[track]
      assert.deepEqual(chunks.map(chunk => chunk.meta.seq), [0, 1, 2], `${track} 轨内序号单调递增`)
      assert.ok(chunks.every(chunk => chunk.meta.track === track))
      assert.deepEqual(chunks.map(chunk => chunk.meta.startMs), [first, first + 1024, first + 2048], `${track} 起点按样本计数推进`)
      assert.deepEqual(chunks.map(chunk => chunk.meta.frames), [16384, 16384, 8192], '帧数是重采样到 16k 之后的')
      assert.ok(chunks.every(chunk => chunk.meta.sampleRate === rate), '带原始采样率')
      for (const chunk of chunks) {
        assert.equal(chunk.pcm16k.length, chunk.meta.frames)
        assert.ok(chunk.pcm16k.every(sample => Math.abs(sample - sign) < 1e-6), `${track} 的块里混进了另一路的样本`)
      }
    }
  })

  test('回调时刻跳变（丢回调/设备暂停）：先交出残块，再从新时刻起算，不补静音；小抖动不重锚', () => {
    const identity = (samples: Float32Array): Float32Array => samples
    const chunker = new TrackChunker({ track: 'mic', sampleRate: 16000, chunkMs: 4000, resample: identity })
    const frame = new Float32Array(1600).fill(0.1)
    assert.deepEqual(chunker.push(frame, 0), [])
    assert.deepEqual(chunker.push(frame, 100), [])
    const jumped = chunker.push(frame, 2200)
    assert.equal(jumped.length, 1)
    assert.deepEqual(jumped[0].meta, { track: 'mic', seq: 0, startMs: 0, sampleRate: 16000, frames: 3200 })
    assert.equal(chunker.discontinuities, 1)
    // 2200 起算的这块再来一帧，时刻抖了 120ms（< 300ms）：照样按样本计数接着走。
    chunker.push(frame, 2300 + 120)
    const last = chunker.flush()
    assert.deepEqual(last?.meta, { track: 'mic', seq: 1, startMs: 2200, sampleRate: 16000, frames: 3200 })
    assert.equal(chunker.discontinuities, 1)
  })
})

describe('主进程按音轨落盘（沿用加密块格式，sidecar 记 track）', () => {
  test('两路分别存储：表与 sidecar 记音轨/轨内序号/起点/帧数/原始采样率，读出来各是各的', () => {
    const h = setupRecorder()
    const id = started(h)
    assert.equal(pushTrack(h, id, 'mic', 0, 0, constPcm(4000, 3000)).ok, true)
    assert.equal(pushTrack(h, id, 'loopback', 0, 300, constPcm(4000, 9000)).ok, true)
    assert.equal(pushTrack(h, id, 'mic', 1, 4000, constPcm(4000, 3000)).ok, true)
    assert.equal(pushTrack(h, id, 'loopback', 1, 4300, constPcm(4000, 9000)).ok, true)

    const chunks = h.store.listChunks(id)
    assert.deepEqual(chunks.map(chunk => [chunk.track, chunk.trackSeq, chunk.startMs, chunk.frames]), [
      ['mic', 0, 0, 64000],
      ['loopback', 0, 300, 64000],
      ['mic', 1, 4000, 64000],
      ['loopback', 1, 4300, 64000],
    ])
    for (const chunk of chunks) {
      assert.equal(chunk.sidecar?.track, chunk.track, 'sidecar 里记了 track')
      assert.equal(chunk.sidecar?.trackSeq, chunk.trackSeq)
      assert.equal(chunk.sidecar?.startMs, chunk.startMs)
      assert.equal(chunk.sidecar?.frames, 64000)
      assert.equal(chunk.sidecar?.sourceSampleRate, 48000)
    }

    // 块本体仍是 nonce|密文|tag：落盘文件里找不到明文 PCM 的字节模式。
    const plain = constPcm(100, 3000)
    for (const file of readdirSync(h.store.meetingDir(id))) {
      assert.ok(!readFileSync(path.join(h.store.meetingDir(id), file)).includes(plain), `${file} 里出现了明文 PCM`)
    }

    const read = h.store.readAllChunks(id)
    const valuesOf = (track: string): Set<number> => {
      const values = new Set<number>()
      for (const chunk of read.chunks.filter(entry => entry.track === track)) {
        for (let i = 0; i < chunk.pcm.length; i += 2) values.add(chunk.pcm.readInt16LE(i))
      }
      return values
    }
    assert.deepEqual([...valuesOf('mic')], [3000], '麦克风轨里只有麦克风的样本')
    assert.deepEqual([...valuesOf('loopback')], [9000], '回环轨里只有回环的样本')
    h.store.close()
  })

  test('边界校验：序号重复/倒退、帧数对不上、未选回环却送回环、音轨或采样率非法，一律拒收', () => {
    const h = setupRecorder()
    const id = started(h, CONSENT_MIC)
    const pcm = constPcm(1000, 3000)
    const b64 = pcm.toString('base64')
    assert.equal(pushTrack(h, id, 'mic', 0, 0, pcm).ok, true)
    const dup = pushTrack(h, id, 'mic', 0, 1000, pcm)
    assert.equal(dup.ok, false)
    if (!dup.ok) assert.match(dup.error, /重复或倒退/)
    assert.equal(pushTrack(h, id, 'mic', 5, 1000, pcm).ok, true, '跳号（中间块没送上来）允许，时间轴上会是缺口')
    assert.equal(pushTrack(h, id, 'mic', 3, 2000, pcm).ok, false, '倒退拒收')
    const loop = pushTrack(h, id, 'loopback', 0, 0, pcm)
    assert.equal(loop.ok, false)
    if (!loop.ok) assert.match(loop.error, /没有选择录系统回环声/)
    assert.equal(h.recorder.pushChunk(id, b64, { ...meta('mic', 9, 2000, pcm), frames: 1 }).ok, false, '帧数与字节数对不上')
    assert.equal(h.recorder.pushChunk(id, b64, { ...meta('mic', 9, 2000, pcm), track: 'speaker' }).ok, false)
    assert.equal(h.recorder.pushChunk(id, b64, { ...meta('mic', 9, 2000, pcm), sampleRate: 0 }).ok, false)
    assert.equal(h.recorder.pushChunk(id, b64, 'not-an-object').ok, false)
    assert.equal(h.store.listChunks(id).length, 2)
    h.store.close()
  })

  test('起点明显超前于接收时间（时钟错乱）：按接收时间修正，不把录音放到未来', () => {
    const h = setupRecorder()
    const id = started(h, CONSENT_MIC)
    h.clock.set(START + 5000)
    const pcm = constPcm(4000, 3000)
    assert.equal(h.recorder.pushChunk(id, pcm.toString('base64'), meta('mic', 0, 60_000, pcm)).ok, true)
    assert.equal(h.store.listChunks(id)[0].startMs, 1000, '修正为接收时刻 - 块时长')
    h.store.close()
  })

  test('断流按同一音轨计算：缺口记在本轨上一块的 sidecar，另一路照常衔接不受影响', () => {
    const h = setupRecorder()
    const id = started(h)
    pushTrack(h, id, 'mic', 0, 0, constPcm(4000, 3000))
    pushTrack(h, id, 'loopback', 0, 0, constPcm(4000, 9000))
    pushTrack(h, id, 'loopback', 1, 4000, constPcm(4000, 9000))
    pushTrack(h, id, 'mic', 1, 9000, constPcm(4000, 3000))
    const chunks = h.store.listChunks(id)
    const micFirst = chunks.find(chunk => chunk.track === 'mic' && chunk.trackSeq === 0)
    const loopFirst = chunks.find(chunk => chunk.track === 'loopback' && chunk.trackSeq === 0)
    assert.equal(micFirst?.sidecar?.gapAfterMs, 5000, '麦克风 4000→9000 断了 5 秒')
    assert.equal(loopFirst?.sidecar?.gapAfterMs, null, '回环连续，交错到达的麦克风块不算它的断流')
    h.store.close()
  })
})

describe('缺失音轨与停录冲刷', () => {
  test('拿不到回环：如实标缺失，不伪造静音块；之后送来的回环块也拒收；转写与纪要只来自麦克风', async () => {
    const h = setupRecorder()
    const id = started(h)
    h.recorder.reportTrackMissing(id, 'loopback')
    assert.deepEqual(h.recorder.getState().missingTracks, ['loopback'])
    assert.equal(pushTrack(h, id, 'mic', 0, 0, constPcm(4000, 3000)).ok, true)
    const late = pushTrack(h, id, 'loopback', 0, 0, constPcm(4000, 9000))
    assert.equal(late.ok, false, '已报缺失的音轨不再收块')
    h.recorder.requestStop(id)
    await h.recorder.flushDone(id)
    await h.recorder.whenSettled()

    assert.ok(h.store.listChunks(id).every(chunk => chunk.track === 'mic'), '库里没有任何回环块（没有伪造的静音）')
    assert.equal(h.diarized.length, 1, '只对真有录音的麦克风轨跑分人，没给缺失的回环造样本')
    const segments = h.store.getSegments(id)
    assert.ok(segments.length > 0 && segments.every(segment => segment.track === 'mic'))
    const minutes = h.store.getMinutes(id)
    assert.ok(minutes?.content.includes('音轨缺失'))
    assert.ok(minutes?.content.includes('loopback'))
    h.store.close()
  })

  test('停止是两段式：停止中仍收两路最后一块，冲刷完才结算，最后几秒进了时间轴', async () => {
    const h = setupRecorder()
    const id = started(h)
    pushTrack(h, id, 'mic', 0, 0, constPcm(4000, 3000))
    pushTrack(h, id, 'loopback', 0, 0, constPcm(4000, 9000))
    assert.equal(h.recorder.requestStop(id).ok, true)
    assert.equal(h.recorder.getState().stopping, true)
    assert.equal(h.store.getMeeting(id)?.state, 'recording', '冲刷完之前不结算')
    assert.equal(pushTrack(h, id, 'mic', 1, 4000, constPcm(1500, 3000)).ok, true)
    assert.equal(pushTrack(h, id, 'loopback', 1, 4000, constPcm(900, 9000)).ok, true)
    await h.recorder.flushDone(id)
    await h.recorder.whenSettled()

    const chunks = h.store.listChunks(id)
    assert.equal(chunks.length, 4, '两路最后一块都没丢')
    const segments = h.store.getSegments(id)
    const micEnd = Math.max(...segments.filter(segment => segment.track === 'mic').map(segment => segment.endMs ?? 0))
    const loopEnd = Math.max(...segments.filter(segment => segment.track === 'loopback').map(segment => segment.endMs ?? 0))
    assert.equal(micEnd, 5500)
    assert.equal(loopEnd, 4900)
    assert.equal(h.store.getMeeting(id)?.state, 'transcribed')
    h.store.close()
  })

  test('录音中状态带每条音轨的收块进度', () => {
    const h = setupRecorder()
    const id = started(h)
    pushTrack(h, id, 'mic', 0, 0, constPcm(4000, 3000))
    pushTrack(h, id, 'mic', 1, 4000, constPcm(4000, 3000))
    pushTrack(h, id, 'loopback', 0, 200, constPcm(4000, 9000))
    assert.deepEqual(h.recorder.getState().tracks, [
      { track: 'mic', chunks: 2, recordedMs: 8000, lastEndMs: 8000 },
      { track: 'loopback', chunks: 1, recordedMs: 4000, lastEndMs: 4200 },
    ])
    h.store.close()
  })
})

describe('按音轨铺时间轴（buildTrackTimeline）', () => {
  test('缺口补静音并记录、抖动顺接、时间戳倒退顺接不覆盖、坏块占位记 corrupted、另一轨不混入', () => {
    const timeline = buildTrackTimeline('mic', [
      { seq: 0, track: 'mic', startMs: 500, pcm: constPcm(1000, 100), frames: 16000 },
      { seq: 2, track: 'mic', startMs: 1550, pcm: constPcm(1000, 200), frames: 16000 },
      { seq: 4, track: 'mic', startMs: 5000, pcm: constPcm(1000, 300), frames: 16000 },
      { seq: 5, track: 'mic', startMs: 5500, pcm: constPcm(500, 400), frames: 8000 },
      { seq: 6, track: 'mic', startMs: 6500, pcm: null, frames: 8000 },
      { seq: 1, track: 'loopback', startMs: 0, pcm: constPcm(1000, 999), frames: 16000 },
    ])
    assert.equal(timeline.samples.length, 7000 * 16)
    const at = (ms: number): number => timeline.samples[ms * 16]
    assert.equal(at(100), 0, '第一块之前是采集还没开始：静音，但不算断流')
    assert.equal(at(600), 100)
    assert.equal(at(1600), 200, '50ms 抖动直接顺接')
    assert.equal(at(3000), 0, '断流处是静音')
    assert.equal(at(5100), 300)
    assert.equal(at(6100), 400, '倒退 500ms 的块顺接到上一块之后')
    assert.equal(at(6700), 0, '坏块那段是静音')
    assert.ok(!timeline.samples.includes(999), '回环轨的样本不能进麦克风时间轴')
    assert.deepEqual(timeline.gaps, [
      { startMs: 2500, endMs: 5000, reason: 'gap' },
      { startMs: 6500, endMs: 7000, reason: 'corrupted' },
    ])
    assert.equal(timeline.adjusted, 1)
    assert.deepEqual(timeline.placements, [
      { seq: 0, startMs: 500, endMs: 1500 },
      { seq: 2, startMs: 1500, endMs: 2500 },
      { seq: 4, startMs: 5000, endMs: 6000 },
      { seq: 5, startMs: 6000, endMs: 6500 },
    ])
    assert.equal(timeline.recordedMs, 3500)

    const slice = sliceTimeline(timeline, 1400, 1600)
    assert.equal(slice.length, 200 * 16 * 2)
    assert.equal(slice.readInt16LE(0), 100)
    assert.equal(slice.readInt16LE(slice.length - 2), 200)
  })
})
