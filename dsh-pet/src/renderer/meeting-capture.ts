/**
 * 会议采音的分轨切块（渲染层纯逻辑，不碰 DOM / Web Audio，可在 Node 下单测）。
 *
 * 麦克风与系统回环声各配一个 TrackChunker：**各自缓冲、各自切块、各自编号**。旧实现把两路的
 * onaudioprocess 推进同一个缓冲，两路音频被交错拼成一条既没有来源、也没有时间轴的流——
 * 转写出来的话分不清是谁那边的，时间也对不上。
 *
 * 时间轴：块起点 = 该轨第一次回调的会议时间 + 已处理样本数 / 采样率。按样本计数推进而不是按
 * 每次回调的时刻，抖动不会累积；但回调时刻与样本计数推算偏离超过 driftToleranceMs（主线程
 * 卡顿丢了回调、设备暂停）时，先把手上的块送走，再从回调时刻重新起算——中间那段是真没录到，
 * 主进程会如实记成缺口，这里不补任何静音。
 */
import type { MeetingChunkMeta, MeetingTrack } from './types.js'

export interface TrackChunk {
  readonly meta: MeetingChunkMeta
  /** 16kHz Float32（-1..1），调用方编码成 Int16 base64 推上去。 */
  readonly pcm16k: Float32Array
}

export interface TrackChunkerOptions {
  readonly track: MeetingTrack
  /** 采集端（AudioContext）采样率。 */
  readonly sampleRate: number
  /** 每块目标时长。默认 4000ms（主进程按块做临时转写，太长字幕就滞后）。 */
  readonly chunkMs?: number
  /** 回调时刻与样本计数推算的允许偏差。默认 300ms。 */
  readonly driftToleranceMs?: number
  /** 重采样到 16k（dictation.ts 的 resampleTo16k）。 */
  readonly resample: (samples: Float32Array, sourceRate: number) => Float32Array
  /**
   * 轨内序号从几开始。共享采集重开设备后采样率可能变了，要换一个切块器接着切同一条音轨：
   * 序号必须接上，主进程的轨内序号校验才不会拒块。
   */
  readonly firstSeq?: number
}

export class TrackChunker {
  readonly track: MeetingTrack
  private readonly sampleRate: number
  private readonly chunkFrames: number
  private readonly driftMs: number
  private readonly resample: (samples: Float32Array, sourceRate: number) => Float32Array
  private pending: Float32Array[] = []
  private pendingFrames = 0
  /** 当前缓冲第一帧的会议时间（ms，浮点，不取整以免误差累积）。null = 还没开始或刚重新起算。 */
  private chunkStartMs: number | null = null
  private nextSeq = 0
  /** 因回调时刻跳变而重新起算的次数（诊断用）。 */
  discontinuities = 0

  constructor(opts: TrackChunkerOptions) {
    if (!(opts.sampleRate > 0)) throw new Error('采样率必须是正数')
    this.track = opts.track
    this.sampleRate = opts.sampleRate
    this.chunkFrames = Math.max(1, Math.floor((opts.sampleRate * (opts.chunkMs ?? 4000)) / 1000))
    this.driftMs = opts.driftToleranceMs ?? 300
    this.resample = opts.resample
    this.nextSeq = opts.firstSeq ?? 0
  }

  /** 下一块的轨内序号（换切块器时接续用）。 */
  get seq(): number {
    return this.nextSeq
  }

  /**
   * 喂一次回调的样本。atMs = 这批样本第一帧的会议时间（相对会议开始的毫秒）。
   * 返回凑满的块：通常 0 或 1 个；回调时刻跳变时先交出跳变前的残块，可能 2 个。
   */
  push(frames: Float32Array, atMs: number): TrackChunk[] {
    const out: TrackChunk[] = []
    if (frames.length === 0) return out
    if (this.chunkStartMs !== null && Number.isFinite(atMs)) {
      const expected = this.chunkStartMs + (this.pendingFrames / this.sampleRate) * 1000
      if (Math.abs(atMs - expected) > this.driftMs) {
        const flushed = this.flush()
        if (flushed !== null) out.push(flushed)
        this.chunkStartMs = null
        this.discontinuities++
      }
    }
    if (this.chunkStartMs === null) this.chunkStartMs = Number.isFinite(atMs) ? Math.max(0, atMs) : 0
    this.pending.push(new Float32Array(frames))
    this.pendingFrames += frames.length
    if (this.pendingFrames >= this.chunkFrames) {
      const chunk = this.flush()
      if (chunk !== null) out.push(chunk)
    }
    return out
  }

  /** 缓冲里剩下的切成一块（停录冲刷、音轨中断时用）。缓冲空返回 null。下一块从这块终点接着算。 */
  flush(): TrackChunk | null {
    if (this.pendingFrames === 0 || this.chunkStartMs === null) return null
    const merged = new Float32Array(this.pendingFrames)
    let offset = 0
    for (const part of this.pending) {
      merged.set(part, offset)
      offset += part.length
    }
    const startMs = this.chunkStartMs
    this.chunkStartMs = startMs + (this.pendingFrames / this.sampleRate) * 1000
    this.pending = []
    this.pendingFrames = 0
    const pcm16k = this.resample(merged, this.sampleRate)
    return {
      meta: { track: this.track, seq: this.nextSeq++, startMs: Math.round(startMs), sampleRate: this.sampleRate, frames: pcm16k.length },
      pcm16k,
    }
  }
}
