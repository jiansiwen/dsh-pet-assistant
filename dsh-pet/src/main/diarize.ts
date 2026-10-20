/**
 * 会议的说话人分离（会后精修）与分轨时间轴的计算。
 *
 * 分两半：
 * 1. **纯函数**（不碰原生模块，测试直接调）：按音轨把块铺成连续时间轴（缺口补静音并记录）、
 *    静音压缩与时间映射、把分离结果映射成带音源前缀的说话人段、助理播报区间的标记与裁剪、
 *    长段切分。
 * 2. **运行分离**：sherpa-onnx 的 OfflineSpeakerDiarization（pyannote segmentation-3.0 +
 *    3D-Speaker eres2net 嵌入）。`process()` 是同步原生调用——实测 i7-7700HQ 上 48 秒音频要
 *    算约 11 秒（窗口步长 0.25），放主线程会把整个界面卡死，所以在 Worker 里跑；Worker
 *    起不来时才退到主线程，且只处理短音频。送进模型前先把长静音压掉（两路分轨后，一条轨里
 *    对方说话的那些时间都是静音），算完再把时间映射回原时间轴。
 *
 * 隐私边界：模型与音频都只在本机。只输出"哪段时间是第几号人"，不提取、不保存声纹嵌入；
 * 编号只在这一场会议的这一条音轨内有效——不建跨会议的声纹库。
 */
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { OfflineSpeakerDiarizationConfig } from 'sherpa-onnx-node'
import type { MeetingTrack } from './meeting-store.ts'
import { toUnpackedPath } from './runtime-launch.ts'

/** 时间轴采样率（与渲染层推块、SenseVoice 输入一致）。 */
export const TIMELINE_RATE = 16000
const FRAMES_PER_MS = TIMELINE_RATE / 1000

// ===== 说话人 id 与标签 =====

/** 助理播报段的 speaker id。它不是参会者，纪要时间线里不算真人发言。 */
export const ASSISTANT_SPEAKER = 'assistant'
export const ASSISTANT_LABEL = '桌面助理播报（不算真人发言）'

function trackPrefix(track: MeetingTrack): string {
  return track === 'mic' ? 'mic' : 'loop'
}

/** 音源的中文名：本机麦克风 / 对方（系统回环声）。 */
export function trackDisplayName(track: MeetingTrack): string {
  return track === 'mic' ? '本机麦克风' : '对方'
}

/** 自动分人的 speaker id：mic-s1、loop-s2……编号只在本场会议、本条音轨内有效。 */
export function trackSpeakerId(track: MeetingTrack, n: number): string {
  return `${trackPrefix(track)}-s${n}`
}

/** 自动分人的默认显示名：「本机麦克风·发言人1」「对方·发言人2」。 */
export function trackSpeakerLabel(track: MeetingTrack, n: number): string {
  return `${trackDisplayName(track)}·发言人${n}`
}

/** 没能自动分人时整条音轨归一组的显示名：如实写"未分人"，不暗示只有一个人。 */
export function trackFallbackLabel(track: MeetingTrack): string {
  return `${trackDisplayName(track)}·未分人`
}

// ===== 按音轨铺时间轴 =====

export interface TimelineInputChunk {
  /** 全会议的存储序号（chunk-<seq>.enc）。 */
  readonly seq: number
  readonly track: MeetingTrack
  /** 块起点，相对会议开始的毫秒数。 */
  readonly startMs: number
  /** 16k Int16LE PCM；null = 坏块（解不开），只用来在时间轴上标缺口。 */
  readonly pcm: Buffer | null
  /** 16k 帧数。正常块以 PCM 长度为准；坏块来自元数据，未知时为 0。 */
  readonly frames: number
}

export interface TimelinePlacement {
  readonly seq: number
  readonly startMs: number
  readonly endMs: number
}

export interface TimelineGap {
  readonly startMs: number
  readonly endMs: number
  /** gap = 两块之间没有录音（断流）；corrupted = 这段的录音块解不开。 */
  readonly reason: 'gap' | 'corrupted'
}

export interface TrackTimeline {
  readonly track: MeetingTrack
  /**
   * 从会议 0ms 起的 16k Int16 时间轴。缺口与第一块之前的空白都是 0（静音）——只为让
   * 分人模型看到正确的时间位置；缺口如实记在 gaps 里，静音处不会产生任何转写段。
   */
  readonly samples: Int16Array
  readonly placements: readonly TimelinePlacement[]
  readonly gaps: readonly TimelineGap[]
  /** 时间戳倒退（与上一块重叠超出容差）而被顺接的块数。 */
  readonly adjusted: number
  /** 实际录到的时长（ms），不含缺口与坏块。 */
  readonly recordedMs: number
}

/**
 * 把一条音轨的块按起点铺到连续时间轴上。
 *
 * - 起点与上一块终点相差在容差内（采集端时间戳抖动）：直接顺接，不插零碎静音；
 * - 晚出容差：中间补静音并记一条 gap（断流）；
 * - 早于上一块终点超出容差（时间戳倒退）：顺接到上一块之后，绝不覆盖已铺的录音；
 * - 坏块：占住它声明的时长、记 corrupted 缺口，那段是静音。
 *
 * 只处理 track 匹配的块：两条音轨各铺各的，绝不交错拼到一条里。
 */
export function buildTrackTimeline(
  track: MeetingTrack,
  chunks: readonly TimelineInputChunk[],
  opts: { toleranceMs?: number } = {},
): TrackTimeline {
  const tolerance = Math.round((opts.toleranceMs ?? 120) * FRAMES_PER_MS)
  const sorted = chunks
    .filter(chunk => chunk.track === track)
    .slice()
    .sort((a, b) => a.startMs - b.startMs || a.seq - b.seq)
  const pieces: Array<{ pos: number; pcm: Buffer }> = []
  const placements: TimelinePlacement[] = []
  const gaps: TimelineGap[] = []
  let adjusted = 0
  let cursor = 0
  let recordedFrames = 0
  let first = true
  for (const chunk of sorted) {
    const want = Math.max(0, Math.round(chunk.startMs * FRAMES_PER_MS))
    const frames = chunk.pcm !== null ? Math.floor(chunk.pcm.length / 2) : Math.max(0, Math.floor(chunk.frames))
    let pos: number
    if (first) {
      // 第一块之前是采集还没开始（取设备要几百毫秒），不算断流。
      pos = want
      first = false
    } else {
      const delta = want - cursor
      if (Math.abs(delta) <= tolerance) {
        pos = cursor
      } else if (delta > 0) {
        pos = want
        gaps.push({ startMs: cursor / FRAMES_PER_MS, endMs: want / FRAMES_PER_MS, reason: 'gap' })
      } else {
        pos = cursor
        adjusted++
      }
    }
    if (chunk.pcm === null) {
      if (frames > 0) gaps.push({ startMs: pos / FRAMES_PER_MS, endMs: (pos + frames) / FRAMES_PER_MS, reason: 'corrupted' })
    } else if (frames > 0) {
      pieces.push({ pos, pcm: chunk.pcm })
      placements.push({ seq: chunk.seq, startMs: pos / FRAMES_PER_MS, endMs: (pos + frames) / FRAMES_PER_MS })
      recordedFrames += frames
    }
    cursor = pos + frames
  }
  const samples = new Int16Array(cursor)
  for (const piece of pieces) {
    const count = Math.floor(piece.pcm.length / 2)
    if (piece.pcm.byteOffset % 2 === 0) {
      samples.set(new Int16Array(piece.pcm.buffer, piece.pcm.byteOffset, count), piece.pos)
    } else {
      for (let i = 0; i < count; i++) samples[piece.pos + i] = piece.pcm.readInt16LE(i * 2)
    }
  }
  return { track, samples, placements, gaps, adjusted, recordedMs: recordedFrames / FRAMES_PER_MS }
}

/** 从时间轴上切一段 16k Int16LE PCM（拷贝）。越界部分截掉。 */
export function sliceTimeline(timeline: Pick<TrackTimeline, 'samples'>, startMs: number, endMs: number): Buffer {
  const total = timeline.samples.length
  const from = Math.min(total, Math.max(0, Math.round(startMs * FRAMES_PER_MS)))
  const to = Math.min(total, Math.max(from, Math.round(endMs * FRAMES_PER_MS)))
  const view = timeline.samples.subarray(from, to)
  return Buffer.from(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
}

// ===== 静音压缩（送分人模型前）与时间映射 =====

export interface CompressedPiece {
  /** 原时间轴上的起点（样本）。 */
  readonly srcStart: number
  /** 压缩后时间轴上的起点（样本）。 */
  readonly dstStart: number
  readonly length: number
}

export interface CompressedAudio {
  readonly samples: Float32Array
  readonly pieces: readonly CompressedPiece[]
  /** 压缩后的时长（ms）——真正送进模型的音频长度。 */
  readonly keptMs: number
}

/**
 * 100ms 帧的"有声"判定（不扩展）。阈值取非零帧第 10 百分位（底噪）的 3 倍，夹在
 * [100, 1500]（Int16 刻度）之间；全零的帧（缺口补的静音）一定算静音。
 */
function loudFrames(samples: Int16Array, frameLen: number): Uint8Array {
  const frameCount = Math.ceil(samples.length / frameLen)
  const rms = new Float64Array(frameCount)
  for (let f = 0; f < frameCount; f++) {
    const from = f * frameLen
    const to = Math.min(samples.length, from + frameLen)
    let sum = 0
    for (let i = from; i < to; i++) sum += samples[i] * samples[i]
    rms[f] = to > from ? Math.sqrt(sum / (to - from)) : 0
  }
  const nonZero = Array.from(rms).filter(value => value > 0).sort((a, b) => a - b)
  const floor = nonZero.length > 0 ? nonZero[Math.floor(nonZero.length * 0.1)] : 0
  const threshold = Math.min(1500, Math.max(100, floor * 3))
  const loud = new Uint8Array(frameCount)
  for (let f = 0; f < frameCount; f++) loud[f] = rms[f] > threshold ? 1 : 0
  return loud
}

/**
 * 把连续 ≥ minSilenceMs 的静音压到首尾各 keepMs，其余原样保留。有声判定见 loudFrames；
 * 有声帧前后各多留 300ms，词间停顿不会被切。
 */
export function compressSilence(
  samples: Int16Array,
  opts: { frameMs?: number; minSilenceMs?: number; keepMs?: number } = {},
): CompressedAudio {
  const frameLen = Math.round((opts.frameMs ?? 100) * FRAMES_PER_MS)
  const minSilenceFrames = Math.ceil((opts.minSilenceMs ?? 1000) / (opts.frameMs ?? 100))
  const keep = Math.round((opts.keepMs ?? 150) * FRAMES_PER_MS)
  const loud = loudFrames(samples, frameLen)
  const frameCount = loud.length
  const voiced = new Uint8Array(frameCount)
  const pad = 3
  for (let f = 0; f < frameCount; f++) {
    if (loud[f] !== 1) continue
    for (let k = Math.max(0, f - pad); k <= Math.min(frameCount - 1, f + pad); k++) voiced[k] = 1
  }
  // 保留区间（样本）：有声段原样；长静音只留首尾各 keep。
  const keepRanges: Array<[number, number]> = []
  let f = 0
  while (f < frameCount) {
    const start = f
    const isVoiced = voiced[f] === 1
    while (f < frameCount && (voiced[f] === 1) === isVoiced) f++
    const from = start * frameLen
    const to = Math.min(samples.length, f * frameLen)
    if (isVoiced || f - start < minSilenceFrames) {
      keepRanges.push([from, to])
    } else {
      keepRanges.push([from, Math.min(to, from + keep)])
      keepRanges.push([Math.max(from + keep, to - keep), to])
    }
  }
  // 合并相邻区间，生成映射片段。
  const pieces: CompressedPiece[] = []
  let dst = 0
  for (const [from, to] of keepRanges) {
    if (to <= from) continue
    const last = pieces[pieces.length - 1]
    if (last !== undefined && last.srcStart + last.length === from) {
      pieces[pieces.length - 1] = { ...last, length: last.length + (to - from) }
    } else {
      pieces.push({ srcStart: from, dstStart: dst, length: to - from })
    }
    dst += to - from
  }
  const out = new Float32Array(dst)
  for (const piece of pieces) {
    for (let i = 0; i < piece.length; i++) out[piece.dstStart + i] = samples[piece.srcStart + i] / 32768
  }
  return { samples: out, pieces, keptMs: dst / FRAMES_PER_MS }
}

/** 一段分离结果（原时间轴，毫秒）。speaker 是模型的聚类编号，本次运行内有效。 */
export interface DiarizedTurn {
  readonly startMs: number
  readonly endMs: number
  readonly speaker: number
}

/**
 * 压缩时间轴上的分离结果（秒）映射回原时间轴（毫秒）。一段跨过被压掉的静音时，在
 * 拼接点拆开——原时间轴上那里确实隔着一段静音。短于 minPieceMs 的碎片丢掉。
 */
export function mapCompressedToOriginal(
  segments: ReadonlyArray<{ start: number; end: number; speaker: number }>,
  pieces: readonly CompressedPiece[],
  opts: { minPieceMs?: number } = {},
): DiarizedTurn[] {
  const minPiece = (opts.minPieceMs ?? 200) * FRAMES_PER_MS
  const turns: DiarizedTurn[] = []
  for (const segment of segments) {
    const from = segment.start * TIMELINE_RATE
    const to = segment.end * TIMELINE_RATE
    if (!(to > from)) continue
    for (const piece of pieces) {
      const lo = Math.max(from, piece.dstStart)
      const hi = Math.min(to, piece.dstStart + piece.length)
      if (hi - lo < minPiece) continue
      turns.push({
        startMs: (piece.srcStart + (lo - piece.dstStart)) / FRAMES_PER_MS,
        endMs: (piece.srcStart + (hi - piece.dstStart)) / FRAMES_PER_MS,
        speaker: segment.speaker,
      })
    }
  }
  return turns.sort((a, b) => a.startMs - b.startMs)
}

// ===== 分离结果 → 要转写的段 =====

/** 计划转写的一段。kind=assistant 表示与助理播报高度重叠，不算真人发言。 */
export interface PlannedSpan {
  readonly track: MeetingTrack
  readonly speaker: string
  readonly label: string
  readonly startMs: number
  readonly endMs: number
  readonly kind: 'speech' | 'assistant'
  /** 逐块兜底时这段正好是整块 seq（可复用录音中的临时转写）；被裁剪/切分过的段没有它。 */
  readonly chunkSeq?: number
}

type Range = readonly [number, number]

function subtractRanges(range: Range, cuts: readonly Range[]): Array<[number, number]> {
  let parts: Array<[number, number]> = [[range[0], range[1]]]
  for (const [cutFrom, cutTo] of cuts) {
    const next: Array<[number, number]> = []
    for (const [from, to] of parts) {
      if (cutTo <= from || cutFrom >= to) {
        next.push([from, to])
        continue
      }
      if (cutFrom > from) next.push([from, cutFrom])
      if (cutTo < to) next.push([cutTo, to])
    }
    parts = next
  }
  return parts
}

function overlapMs(range: Range, others: readonly Range[]): number {
  let total = 0
  for (const [from, to] of others) total += Math.max(0, Math.min(range[1], to) - Math.max(range[0], from))
  return total
}

/** 区间排序并合并重叠部分。 */
function mergeRanges(ranges: readonly Range[]): Array<[number, number]> {
  const sorted = ranges.filter(([from, to]) => to > from).slice().sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  for (const [from, to] of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to)
    else out.push([from, to])
  }
  return out
}

/**
 * 把一条音轨的分离结果变成要转写的说话人段：
 * 1. 按首次出现的先后重新编号（模型的聚类编号本身没有顺序含义），加音源前缀；
 * 2. 裁掉缺口与坏块区间——那里没有录音，不可能有人说话；
 * 3. 同轨重叠发言：被前一段完全盖住的段丢弃，部分重叠的从前一段结尾接着算——
 *    同一段音频只转写一次，不出重复文本（代价：重叠处只归给先开口的人）；
 * 4. 同一人前后两段间隔不超过 mergeGapMs 就并成一段，减少碎片；
 * 5. 短于 minSpanMs 的丢掉。
 */
export function spansFromTurns(
  track: MeetingTrack,
  turns: readonly DiarizedTurn[],
  timeline: Pick<TrackTimeline, 'gaps' | 'samples'>,
  opts: { minSpanMs?: number; mergeGapMs?: number } = {},
): { spans: PlannedSpan[]; speakers: number; overlapsResolved: number } {
  const minSpan = opts.minSpanMs ?? 300
  const mergeGap = opts.mergeGapMs ?? 800
  const totalMs = timeline.samples.length / FRAMES_PER_MS
  const gapRanges: Range[] = timeline.gaps.map(gap => [gap.startMs, gap.endMs])
  const order = new Map<number, number>()
  const pieces: Array<{ n: number; from: number; to: number }> = []
  for (const turn of turns.slice().sort((a, b) => a.startMs - b.startMs)) {
    const from = Math.max(0, turn.startMs)
    const to = Math.min(totalMs, turn.endMs)
    if (!(to > from)) continue
    if (!order.has(turn.speaker)) order.set(turn.speaker, order.size + 1)
    const n = order.get(turn.speaker) ?? 1
    for (const [a, b] of subtractRanges([from, to], gapRanges)) pieces.push({ n, from: a, to: b })
  }
  pieces.sort((a, b) => a.from - b.from || b.to - a.to)
  const kept: Array<{ n: number; from: number; to: number }> = []
  let overlapsResolved = 0
  for (const piece of pieces) {
    const last = kept[kept.length - 1]
    let from = piece.from
    if (last !== undefined && from < last.to) {
      overlapsResolved++
      if (piece.to <= last.to) continue
      from = last.to
    }
    if (piece.to - from <= 0) continue
    if (last !== undefined && last.n === piece.n && from - last.to <= mergeGap) {
      last.to = Math.max(last.to, piece.to)
      continue
    }
    kept.push({ n: piece.n, from, to: piece.to })
  }
  const spans = kept
    .filter(piece => piece.to - piece.from >= minSpan)
    .map(piece => ({
      track,
      speaker: trackSpeakerId(track, piece.n),
      label: trackSpeakerLabel(track, piece.n),
      startMs: Math.round(piece.from),
      endMs: Math.round(piece.to),
      kind: 'speech' as const,
    }))
  return { spans, speakers: new Set(spans.map(span => span.speaker)).size, overlapsResolved }
}

/** 没能自动分人时的兜底：一块一段，整条音轨归一组，标"未分人"。 */
export function fallbackSpans(track: MeetingTrack, timeline: Pick<TrackTimeline, 'placements'>): PlannedSpan[] {
  return timeline.placements.map(placement => ({
    track,
    speaker: trackSpeakerId(track, 1),
    label: trackFallbackLabel(track),
    startMs: Math.round(placement.startMs),
    endMs: Math.round(placement.endMs),
    kind: 'speech' as const,
    chunkSeq: placement.seq,
  }))
}

/** 分人模型漏掉的片段归入的组 id：这条音轨的"未分人"（不与 mic-s1 这类编号混淆）。 */
export function trackUnknownSpeakerId(track: MeetingTrack): string {
  return `${trackPrefix(track)}-unk`
}

/**
 * 分人模型漏掉的有声片段：能量判定为有声、却没被任何说话人段覆盖、且够长的区间，归到这条
 * 音轨的"未分人"组单独转写——宁可多一段未分人的话，也不能让漏检悄悄吞掉会议内容。
 * 转写出来是空的（只是噪声）由调用方丢掉。
 */
export function uncoveredVoicedSpans(
  track: MeetingTrack,
  timeline: Pick<TrackTimeline, 'samples'>,
  covered: readonly PlannedSpan[],
  opts: { minMs?: number; minVoicedRatio?: number; bridgeMs?: number } = {},
): PlannedSpan[] {
  const minMs = opts.minMs ?? 2000
  const minRatio = opts.minVoicedRatio ?? 0.6
  const bridge = Math.round((opts.bridgeMs ?? 300) / 100)
  const loud = loudFrames(timeline.samples, 100 * FRAMES_PER_MS)
  // 有声帧连成区间（容忍 bridgeMs 以内的停顿）。
  const voicedRanges: Array<[number, number]> = []
  let f = 0
  while (f < loud.length) {
    if (loud[f] !== 1) {
      f++
      continue
    }
    const start = f
    let end = f + 1
    let quiet = 0
    for (let k = f + 1; k < loud.length; k++) {
      if (loud[k] === 1) {
        end = k + 1
        quiet = 0
      } else if (++quiet > bridge) {
        break
      }
    }
    voicedRanges.push([start * 100, end * 100])
    f = end
  }
  const cover: Range[] = covered.filter(span => span.track === track).map(span => [span.startMs, span.endMs])
  const out: PlannedSpan[] = []
  for (const range of voicedRanges) {
    for (const [from, to] of subtractRanges(range, cover)) {
      if (to - from < minMs) continue
      const a = Math.floor(from / 100)
      const b = Math.ceil(to / 100)
      let loudCount = 0
      for (let k = a; k < b; k++) loudCount += loud[k] ?? 0
      if (loudCount / Math.max(1, b - a) < minRatio) continue
      out.push({
        track,
        speaker: trackUnknownSpeakerId(track),
        label: trackFallbackLabel(track),
        startMs: Math.round(from),
        endMs: Math.round(to),
        kind: 'speech',
      })
    }
  }
  return out
}

/**
 * 助理播报区间落到转写上：TTS 的声音会被 loopback（以及外放时的麦克风）录进去，
 * 不能让它冒充参会者说过的话。
 *
 * 播报区间先各向外扩 padMs（播放缓冲与采集时间戳的误差）。与它重叠占比 ≥ overlapRatio 的
 * 段整段标为助理播报；部分重叠的把重叠处裁掉，剩下 ≥ minKeepMs 的部分仍归原说话人。
 */
export function applyAssistantSpeech(
  spans: readonly PlannedSpan[],
  assistant: ReadonlyArray<{ startMs: number; endMs: number }>,
  opts: { overlapRatio?: number; padMs?: number; minKeepMs?: number } = {},
): { spans: PlannedSpan[]; marked: number; trimmed: number } {
  const ratio = opts.overlapRatio ?? 0.6
  const pad = opts.padMs ?? 200
  const minKeep = opts.minKeepMs ?? 400
  const zones = mergeRanges(assistant.map(span => [span.startMs - pad, span.endMs + pad] as const))
  if (zones.length === 0) return { spans: spans.slice(), marked: 0, trimmed: 0 }
  const out: PlannedSpan[] = []
  let marked = 0
  let trimmed = 0
  for (const span of spans) {
    const duration = span.endMs - span.startMs
    const overlap = overlapMs([span.startMs, span.endMs], zones)
    if (overlap <= 0 || duration <= 0) {
      out.push(span)
    } else if (overlap / duration >= ratio) {
      marked++
      out.push({ ...span, speaker: ASSISTANT_SPEAKER, label: ASSISTANT_LABEL, kind: 'assistant' })
    } else {
      trimmed++
      for (const [from, to] of subtractRanges([span.startMs, span.endMs], zones)) {
        if (to - from < minKeep) continue
        const { chunkSeq: _whole, ...rest } = span
        out.push({ ...rest, startMs: Math.round(from), endMs: Math.round(to) })
      }
    }
  }
  return { spans: out, marked, trimmed }
}

/**
 * 长段切成不超过 maxMs 的几段再转写（SenseVoice 吃太长的音频既慢又容易漏字）。
 * 切点在目标位置前 searchMs 内找 100ms 帧能量最低处，尽量不切在字中间。
 */
export function splitLongSpans(
  spans: readonly PlannedSpan[],
  timelineOf: (track: MeetingTrack) => Pick<TrackTimeline, 'samples'> | undefined,
  opts: { maxMs?: number; searchMs?: number } = {},
): PlannedSpan[] {
  const maxMs = opts.maxMs ?? 20000
  const searchMs = opts.searchMs ?? 1500
  const out: PlannedSpan[] = []
  for (const span of spans) {
    if (span.endMs - span.startMs <= maxMs) {
      out.push(span)
      continue
    }
    const samples = timelineOf(span.track)?.samples
    const { chunkSeq: _whole, ...rest } = span
    let from = span.startMs
    while (span.endMs - from > maxMs) {
      let cut = from + maxMs
      if (samples !== undefined) {
        let best = cut
        let bestEnergy = Number.POSITIVE_INFINITY
        for (let t = cut - searchMs; t <= cut - 100; t += 50) {
          const a = Math.max(0, Math.round(t * FRAMES_PER_MS))
          const b = Math.min(samples.length, a + 100 * FRAMES_PER_MS)
          let sum = 0
          for (let i = a; i < b; i++) sum += samples[i] * samples[i]
          if (sum < bestEnergy) {
            bestEnergy = sum
            best = t + 50
          }
        }
        cut = best
      }
      out.push({ ...rest, startMs: Math.round(from), endMs: Math.round(cut) })
      from = cut
    }
    out.push({ ...rest, startMs: Math.round(from), endMs: span.endMs })
  }
  return out
}

// ===== 模型 =====

export interface DiarizationModelPaths {
  readonly segmentation: string
  readonly embedding: string
}

/** 分人模型的安装位置（scripts/setup-local-asr.ps1 的落点）。 */
export function diarizationModelPaths(userDataDir: string): DiarizationModelPaths {
  const dir = path.join(userDataDir, 'local-asr', 'diarization')
  return { segmentation: path.join(dir, 'segmentation.onnx'), embedding: path.join(dir, 'embedding.onnx') }
}

/** 模型是否装齐。缺文件或文件明显被截断时如实返回原因（调用方据此写"未自动分人"）。 */
export function diarizationModelStatus(userDataDir: string): { ok: true; paths: DiarizationModelPaths } | { ok: false; message: string } {
  const paths = diarizationModelPaths(userDataDir)
  for (const [file, minBytes] of [[paths.segmentation, 1_000_000], [paths.embedding, 1_000_000]] as const) {
    if (!existsSync(file)) return { ok: false, message: '分人模型未安装' }
    try {
      if (statSync(file).size < minBytes) return { ok: false, message: '分人模型文件不完整（可能下载中断）' }
    } catch {
      return { ok: false, message: '分人模型文件读不了' }
    }
  }
  return { ok: true, paths }
}

export type DiarizeResult =
  | {
      readonly ok: true
      /** 原时间轴上的分离结果；空数组 = 模型认为这条音轨没有可分的语音。 */
      readonly turns: readonly DiarizedTurn[]
      readonly speakers: number
      /** 实际送进模型的音频时长（静音压缩后，ms）。 */
      readonly processedMs: number
      readonly elapsedMs: number
      /** 在哪里跑的：worker = 后台线程；inline = Worker 起不来时退到主线程。 */
      readonly runner: 'worker' | 'inline' | 'none'
    }
  | { readonly ok: false; readonly reason: 'model-missing' | 'failed' | 'timeout'; readonly message: string }

/** 分离一条音轨的时间轴（16k Int16，从会议 0ms 起）。recorder 依赖注入它，测试换成替身。 */
export type DiarizeFn = (samples: Int16Array, userDataDir: string) => Promise<DiarizeResult>

export interface DiarizeOptions {
  /** 聚类阈值：越大分出的人越少。默认 0.5（实测两种系统音色能分开）。 */
  readonly threshold?: number
  /** 分析窗步长比例。默认 0.25：比上游默认 0.1 快约 2.5 倍，实测分段结果一致。 */
  readonly windowShiftRatio?: number
  readonly numThreads?: number
  /** 超时（ms）。默认 2 分钟 + 1.5 倍音频时长。 */
  readonly timeoutMs?: number
  /** Worker 起不来时，主线程最多处理多长的音频（ms）；更长就直接报失败，不冻住界面。 */
  readonly inlineLimitMs?: number
  /** 仅实测脚本用：跳过 Worker，直接在主线程跑。 */
  readonly forceInline?: boolean
}

function diarizationConfig(paths: DiarizationModelPaths, opts: DiarizeOptions): OfflineSpeakerDiarizationConfig {
  const threads = opts.numThreads ?? Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)))
  return {
    segmentation: { pyannote: { model: paths.segmentation, windowShiftRatio: opts.windowShiftRatio ?? 0.25 }, numThreads: threads },
    embedding: { model: paths.embedding, numThreads: threads },
    clustering: { numClusters: -1, threshold: opts.threshold ?? 0.5 },
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  }
}

type RawSegments = Array<{ start: number; end: number; speaker: number }>
type RunOutcome = { ok: true; segments: RawSegments } | { ok: false; stage: 'spawn' | 'load' | 'process' | 'timeout'; error: string }

/**
 * Worker 源码（eval 模式，CommonJS）。原生模块按主模块的位置解析——打包后是 dist/main，
 * 开发/测试时是 src/main，都能找到同一个 node_modules/sherpa-onnx-node。
 */
const WORKER_SOURCE = `
'use strict'
const { parentPort, workerData } = require('node:worker_threads')
let sherpa = null
let loadError = null
try {
  sherpa = require('node:module').createRequire(workerData.base)('sherpa-onnx-node')
} catch (error) {
  loadError = error
}
parentPort.once('message', (msg) => {
  if (sherpa === null) {
    parentPort.postMessage({ ok: false, stage: 'load', error: String((loadError && loadError.message) || loadError) })
    return
  }
  try {
    const sd = new sherpa.OfflineSpeakerDiarization(msg.config)
    if (sd.sampleRate !== 16000) throw new Error('分人模型采样率不是 16k：' + sd.sampleRate)
    const segments = sd.process(msg.samples)
    parentPort.postMessage({ ok: true, segments: segments.map((s) => ({ start: Number(s.start), end: Number(s.end), speaker: Number(s.speaker) })) })
  } catch (error) {
    parentPort.postMessage({ ok: false, stage: 'process', error: String((error && error.message) || error) })
  }
})
`

/**
 * worker 里用它做 `createRequire` 的解析基点去 require `sherpa-onnx-node`。
 * 打包后必须指向 app.asar.unpacked 里的真实文件，理由同 `kws.ts` 的同名常量。
 */
const MODULE_BASE = toUnpackedPath(fileURLToPath(import.meta.url))

function runInWorker(samples: Float32Array, config: OfflineSpeakerDiarizationConfig, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { base: MODULE_BASE } })
    } catch (error) {
      resolve({ ok: false, stage: 'spawn', error: error instanceof Error ? error.message : String(error) })
      return
    }
    let settled = false
    const done = (outcome: RunOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate().catch(() => undefined)
      resolve(outcome)
    }
    const timer = setTimeout(() => done({ ok: false, stage: 'timeout', error: `分人超过 ${Math.round(timeoutMs / 1000)} 秒没有完成` }), timeoutMs)
    timer.unref?.()
    worker.once('message', (message: { ok: boolean; segments?: RawSegments; stage?: 'load' | 'process'; error?: string }) => {
      done(message.ok && Array.isArray(message.segments)
        ? { ok: true, segments: message.segments }
        : { ok: false, stage: message.stage ?? 'process', error: message.error ?? '分人失败' })
    })
    worker.once('error', error => done({ ok: false, stage: 'load', error: error.message }))
    worker.once('exit', code => done({ ok: false, stage: 'load', error: `分人线程意外退出（${code}）` }))
    // 转移所有权而不是拷贝：几十 MB 的音频没必要复制一份。
    worker.postMessage({ config, samples }, [samples.buffer as ArrayBuffer])
  })
}

async function runInline(samples: Float32Array, config: OfflineSpeakerDiarizationConfig): Promise<RunOutcome> {
  try {
    const sherpa = (await import('sherpa-onnx-node')).default
    const sd = new sherpa.OfflineSpeakerDiarization(config)
    if (sd.sampleRate !== TIMELINE_RATE) return { ok: false, stage: 'load', error: `分人模型采样率不是 16k：${sd.sampleRate}` }
    const segments = sd.process(samples)
    return { ok: true, segments: segments.map(s => ({ start: Number(s.start), end: Number(s.end), speaker: Number(s.speaker) })) }
  } catch (error) {
    return { ok: false, stage: 'process', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 默认的分离实现：查模型 → 压静音 → Worker 里跑 sherpa → 时间映射回原时间轴。
 * 任何一步不成都返回 ok:false 并带原因，调用方据此退回逐块转写并写明"未自动分人"。
 */
export async function diarizeTimelineSamples(samples: Int16Array, userDataDir: string, opts: DiarizeOptions = {}): Promise<DiarizeResult> {
  const status = diarizationModelStatus(userDataDir)
  if (!status.ok) return { ok: false, reason: 'model-missing', message: status.message }
  const startedAt = Date.now()
  const compressed = compressSilence(samples)
  if (compressed.keptMs < 1500) {
    return { ok: true, turns: [], speakers: 0, processedMs: compressed.keptMs, elapsedMs: Date.now() - startedAt, runner: 'none' }
  }
  const config = diarizationConfig(status.paths, opts)
  const timeoutMs = opts.timeoutMs ?? 120_000 + compressed.keptMs * 1.5
  const inlineLimit = opts.inlineLimitMs ?? 10 * 60_000
  let runner: 'worker' | 'inline' = opts.forceInline === true ? 'inline' : 'worker'
  let outcome = runner === 'inline' ? await runInline(compressed.samples, config) : await runInWorker(compressed.samples, config, timeoutMs)
  if (!outcome.ok && runner === 'worker' && (outcome.stage === 'spawn' || outcome.stage === 'load')) {
    // Worker 里加载不了原生模块（打包环境差异等）：短音频退到主线程，长音频宁可不分也不冻住界面。
    if (compressed.keptMs > inlineLimit) {
      return { ok: false, reason: 'failed', message: `分人线程起不来（${outcome.error}），音频太长不在主线程跑` }
    }
    runner = 'inline'
    outcome = await runInline(compressSilence(samples).samples, config)
  }
  if (!outcome.ok) {
    return outcome.stage === 'timeout'
      ? { ok: false, reason: 'timeout', message: outcome.error }
      : { ok: false, reason: 'failed', message: `分人失败：${outcome.error}` }
  }
  const turns = mapCompressedToOriginal(outcome.segments, compressed.pieces)
  return {
    ok: true,
    turns,
    speakers: new Set(turns.map(turn => turn.speaker)).size,
    processedMs: compressed.keptMs,
    elapsedMs: Date.now() - startedAt,
    runner,
  }
}
