/**
 * 会议分轨/分人测试的共用夹具：假密钥的 store + recorder、合成 PCM、分离与转写替身。
 *
 * 合成音频用"常数样本值"编码说话人（例如 A=3000、B=6000、对方 C=9000、静音=0）：
 * 分离替身按样本值认人，转写替身按样本值出字——于是能精确验证"转写拿到的那段 PCM 来自
 * 哪条音轨、哪个时间、哪个人"，不依赖真实模型。不开麦克风、不读真实会议数据。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { INITIAL_AUDIO_STATE, nextAudio, type AudioEvent, type AudioState, type AudioTransition } from '../src/main/audio.ts'
import type { DiarizeFn, DiarizeResult } from '../src/main/diarize.ts'
import { MeetingRecorder, type MeetingAsrResult, type MeetingChunkMeta } from '../src/main/meeting-recorder.ts'
import { MeetingStore, type MeetingConsentInput, type MeetingTrack } from '../src/main/meeting-store.ts'

export const FAKE_KEY = Buffer.alloc(32, 11)
export const START = 1_700_000_000_000

export const CONSENT_MIC: MeetingConsentInput = {
  name: '分轨测试会',
  sources: 'mic',
  consentText: '我知晓本场会议将被录音并加密保存在本机',
  consented: true,
  retentionDays: 30,
}

export const CONSENT_BOTH: MeetingConsentInput = { ...CONSENT_MIC, name: '线上评审会', sources: 'mic+loopback' }

const roots: string[] = []
process.on('exit', () => {
  for (const dir of roots) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录 */ }
  }
})

export function tempDir(prefix = 'dsh-meeting-m4-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

export type TranscribeFn = (wav: ArrayBuffer, userDataDir: string) => Promise<MeetingAsrResult>

export interface Harness {
  readonly dir: string
  readonly recorder: MeetingRecorder
  readonly store: MeetingStore
  readonly clock: { now(): number; advance(ms: number): void; set(ms: number): void }
  readonly events: Array<{ channel: string; payload: unknown }>
  readonly audioState: () => AudioState
  /** 每次转写调用拿到的 PCM（解析自 wav）。 */
  readonly transcribed: Int16Array[]
  /** 每次分离调用拿到的样本。 */
  readonly diarized: Int16Array[]
}

export function setupRecorder(opts: {
  transcribe?: TranscribeFn
  diarize?: DiarizeFn
  liveCaptions?: boolean
  flushTimeoutMs?: number
  dir?: string
} = {}): Harness {
  const dir = opts.dir ?? tempDir()
  let current = START
  const clock = {
    now: () => current,
    advance: (ms: number) => { current += ms },
    set: (ms: number) => { current = ms },
  }
  const store = new MeetingStore(dir, { keyProvider: () => ({ status: 'ok' as const, key: FAKE_KEY }), now: clock.now })
  let audioState = nextAudio(INITIAL_AUDIO_STATE, { type: 'boot' }).state
  const events: Array<{ channel: string; payload: unknown }> = []
  const transcribed: Int16Array[] = []
  const diarized: Int16Array[] = []
  const transcribe = opts.transcribe ?? transcribeByValue(DEFAULT_WORDS)
  const diarize = opts.diarize ?? diarizeByValue(DEFAULT_SPEAKERS)
  const recorder = new MeetingRecorder({
    store,
    userDataDir: dir,
    audio: (event: AudioEvent): AudioTransition => {
      const turn = nextAudio(audioState, event)
      audioState = turn.state
      return turn
    },
    notifyRenderer: (channel, payload) => events.push({ channel, payload }),
    transcribe: async (wav, userDataDir) => {
      transcribed.push(wavSamples(wav))
      return transcribe(wav, userDataDir)
    },
    diarize: async (samples, userDataDir) => {
      diarized.push(samples.slice())
      return diarize(samples, userDataDir)
    },
    ...(opts.liveCaptions !== undefined ? { liveCaptions: opts.liveCaptions } : {}),
    now: clock.now,
    ...(opts.flushTimeoutMs !== undefined ? { flushTimeoutMs: opts.flushTimeoutMs } : {}),
  })
  return { dir, recorder, store, clock, events, audioState: () => audioState, transcribed, diarized }
}

// ===== 合成 PCM =====

/** ms 毫秒的 16k Int16LE 常数 PCM。 */
export function constPcm(ms: number, value: number): Buffer {
  const frames = Math.round(ms * 16)
  const out = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) out.writeInt16LE(value, i * 2)
  return out
}

/** 按 [时长ms, 样本值] 依次拼一段 PCM。 */
export function pattern(parts: ReadonlyArray<readonly [number, number]>): Buffer {
  return Buffer.concat(parts.map(([ms, value]) => constPcm(ms, value)))
}

/** 把一段长 PCM 切成每块 chunkMs 的块（最后一块可短）。 */
export function splitPcm(pcm: Buffer, chunkMs = 4000): Buffer[] {
  const size = chunkMs * 16 * 2
  const out: Buffer[] = []
  for (let offset = 0; offset < pcm.length; offset += size) out.push(pcm.subarray(offset, Math.min(pcm.length, offset + size)))
  return out
}

export function meta(track: MeetingTrack, seq: number, startMs: number, pcm: Buffer, sampleRate = 48000): MeetingChunkMeta {
  return { track, seq, startMs, sampleRate, frames: pcm.length / 2 }
}

/** 模拟渲染层推一块分轨 PCM。时钟先走到这块结束之后（真实场景里块录完才送得上来）。 */
export function pushTrack(h: Harness, meetingId: string, track: MeetingTrack, seq: number, startMs: number, pcm: Buffer): ReturnType<MeetingRecorder['pushChunk']> {
  const endAt = START + startMs + pcm.length / 32 + 50
  if (h.clock.now() < endAt) h.clock.set(endAt)
  return h.recorder.pushChunk(meetingId, pcm.toString('base64'), meta(track, seq, startMs, pcm))
}

/** 把一整条音轨按 4 秒切块推上去（轨内序号从 0 递增）。 */
export function pushWholeTrack(h: Harness, meetingId: string, track: MeetingTrack, pcm: Buffer, offsetMs = 0): void {
  splitPcm(pcm).forEach((chunk, seq) => {
    const pushed = pushTrack(h, meetingId, track, seq, offsetMs + seq * 4000, chunk)
    if (!pushed.ok) throw new Error(`推块失败：${pushed.error}`)
  })
}

export function wavSamples(wav: ArrayBuffer): Int16Array {
  const buffer = Buffer.from(wav)
  const count = Math.floor((buffer.length - 44) / 2)
  const out = new Int16Array(count)
  for (let i = 0; i < count; i++) out[i] = buffer.readInt16LE(44 + i * 2)
  return out
}

/** 一段 PCM 里出现过的非零样本值，按首次出现顺序（每个值至少占 50ms 才算）。 */
export function valuesIn(samples: Int16Array): number[] {
  const counts = new Map<number, number>()
  const order: number[] = []
  for (const value of samples) {
    if (value === 0) continue
    if (!counts.has(value)) order.push(value)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return order.filter(value => (counts.get(value) ?? 0) >= 800)
}

// ===== 替身 =====

/** 默认词表：样本值 → 转写文字。 */
export const DEFAULT_WORDS: Record<number, string> = { 3000: '甲说话', 6000: '乙说话', 9000: '对方丙说话', 12000: '对方丁说话' }
/** 默认分离映射：样本值 → 模型聚类编号（刻意不按出现顺序，验证重编号）。 */
export const DEFAULT_SPEAKERS: Record<number, number> = { 3000: 7, 6000: 2, 9000: 4, 12000: 0 }

/** 转写替身：按 PCM 里的样本值出字；全是静音按 asr.ts 的口径报"没有听到说话内容"。 */
export function transcribeByValue(words: Record<number, string>, opts: { failValues?: Set<number> } = {}): TranscribeFn {
  return async (wav) => {
    const values = valuesIn(wavSamples(wav))
    if (values.length === 0) return { ok: false, error: '没有听到说话内容' }
    if (values.some(value => opts.failValues?.has(value) === true)) return { ok: false, error: '识别器起不来' }
    return { ok: true, text: values.map(value => words[value] ?? `未知${value}`).join('') }
  }
}

/** 分离替身：按 100ms 帧的样本值认人，连续同人的帧并成一段（秒级时间换成毫秒）。 */
export function diarizeByValue(speakers: Record<number, number>): DiarizeFn {
  return async (samples): Promise<DiarizeResult> => {
    const frame = 1600
    const turns: Array<{ startMs: number; endMs: number; speaker: number }> = []
    for (let f = 0; f * frame < samples.length; f++) {
      const value = samples[f * frame + Math.floor(frame / 2)] ?? 0
      const speaker = speakers[value]
      if (speaker === undefined) continue
      const startMs = f * 100
      const last = turns[turns.length - 1]
      if (last !== undefined && last.speaker === speaker && last.endMs === startMs) last.endMs = startMs + 100
      else turns.push({ startMs, endMs: startMs + 100, speaker })
    }
    return { ok: true, turns, speakers: new Set(turns.map(turn => turn.speaker)).size, processedMs: samples.length / 16, elapsedMs: 0, runner: 'none' }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
