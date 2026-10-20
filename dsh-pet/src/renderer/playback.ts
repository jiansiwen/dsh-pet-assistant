/**
 * 渲染层播放（M1-05 "外放插话"实验开关的播放端）。
 *
 * 默认路径里 TTS 由合成进程用 play.ps1 / afplay 播放，**不经过 Chromium** —— 于是 Chromium 的
 * 回声消除拿不到助理自己的声音当参考信号，外放时麦克风里助理的声音和用户插话分不开。开关打开后，
 * 合成进程只合成、把音频字节交回主进程，主进程转给这里用 WebAudio 播：Chromium 的回声消除
 * （Chrome-wide AEC 以本进程的输出为参考）才有机会把回声从采集里减掉。
 *
 * 协议：主进程发 `tts-play {id, b64}` / `tts-stop {id}`；这里在**实际**开始、自然播完、
 * 实际停下时回 `started / finished / cancelled` 回执，主进程据此按原 TtsTransport 协议回报给 Narrator ——
 * 阅读视图"只按实际播放翻页"照常成立。
 *
 * 插话检测要求的"检出后立即止声"在这里：`stopLocal` 同步把增益置零并停掉音源，不等主进程往返；
 * 主进程随后发来的 `tts-stop` 只是补一张取消回执。停声时刻用输出端的探针量：探针在增益之后，
 * 第一次读到全零的那个音频块就是"图里已经没声了"，再加上 Chromium 报的输出延迟估计到达扬声器的时刻。
 */

export type PlaybackReceiptKind = 'started' | 'finished' | 'cancelled' | 'error'

export interface PlaybackReceiptPayload {
  readonly id: string
  readonly kind: PlaybackReceiptKind
  readonly atMs: number
  readonly durationMs?: number
  readonly outputLatencyMs?: number
  readonly error?: string
  /** cancelled：停止是怎么来的（本地插话 / 主进程要求）。 */
  readonly reason?: 'barge-in' | 'request' | 'superseded'
  /** cancelled：调用停止的时刻、探针确认图内无声的时刻（performance.now 时间轴）。 */
  readonly stopCalledAtMs?: number
  readonly graphSilentAtMs?: number
}

export interface LocalStopRecord {
  readonly id: string
  readonly stopCalledAtMs: number
  /** 探针确认之后才有；同步返回时还没有。 */
  readonly silent: Promise<{ graphSilentAtMs: number; outputLatencyMs: number }>
}

interface GainLike { gain: { value: number; setValueAtTime(value: number, at: number): void }; connect(node: unknown): void; disconnect(): void }
interface SourceLike { buffer: unknown; onended: (() => void) | null; connect(node: unknown): void; disconnect(): void; start(when?: number): void; stop(when?: number): void }
interface ProbeLike { onaudioprocess: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null; connect(node: unknown): void; disconnect(): void }

export interface PlaybackContextLike {
  readonly currentTime: number
  readonly destination: unknown
  readonly state?: string
  readonly outputLatency?: number
  readonly baseLatency?: number
  resume?(): Promise<void>
  decodeAudioData(data: ArrayBuffer): Promise<{ duration: number }>
  createBufferSource(): SourceLike
  createGain(): GainLike
  createScriptProcessor(bufferSize: number, inputs: number, outputs: number): ProbeLike
}

export interface PlayerDeps {
  createContext(): PlaybackContextLike
  now(): number
  send(receipt: PlaybackReceiptPayload): void
  setTimeout(fn: () => void, ms: number): unknown
}

interface Current {
  readonly id: string
  source: SourceLike | null
  gain: GainLike | null
  probe: ProbeLike | null
  startedAtMs: number | null
  stop: { record: LocalStopRecord; reason: 'barge-in' | 'request' | 'superseded'; resolveSilent: (v: { graphSilentAtMs: number; outputLatencyMs: number }) => void; acked: boolean; requested: boolean } | null
  ended: boolean
}

/** 本地插话止声后，主进程的 tts-stop 迟迟不来时，多久自己补发取消回执。 */
export const LOCAL_STOP_ACK_MS = 2000

export class RendererPlayer {
  private readonly deps: PlayerDeps
  private context: PlaybackContextLike | null = null
  private current: Current | null = null
  private readonly listeners = new Set<(event: { type: 'started' | 'ended'; id: string; atMs: number }) => void>()

  constructor(deps: PlayerDeps) {
    this.deps = deps
  }

  /** 正在出声的那一句开始的时刻；没在出声是 null。插话检测的"起始收敛期"按它算。 */
  get playingSince(): number | null {
    const current = this.current
    return current !== null && current.stop === null && !current.ended ? current.startedAtMs : null
  }

  get playing(): boolean {
    return this.playingSince !== null
  }

  onPlayback(listener: (event: { type: 'started' | 'ended'; id: string; atMs: number }) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private outputLatencyMs(): number {
    const context = this.context
    if (context === null) return 0
    const seconds = typeof context.outputLatency === 'number' && context.outputLatency > 0 ? context.outputLatency
      : typeof context.baseLatency === 'number' ? context.baseLatency : 0
    return seconds * 1000
  }

  private ctx(): PlaybackContextLike {
    if (this.context === null) this.context = this.deps.createContext()
    return this.context
  }

  async play(id: string, b64: string): Promise<void> {
    // 主进程一次只派一句；真来了新的（失步），旧的按"被顶掉"取消，不能两句叠着放。
    if (this.current !== null && !this.current.ended) this.finishStop(this.current, 'superseded', true)
    const current: Current = { id, source: null, gain: null, probe: null, startedAtMs: null, stop: null, ended: false }
    this.current = current
    let context: PlaybackContextLike
    let duration: number
    let buffer: { duration: number }
    try {
      context = this.ctx()
      if (context.state === 'suspended') await context.resume?.().catch(() => undefined)
      buffer = await context.decodeAudioData(base64ToArrayBuffer(b64))
      duration = buffer.duration
    } catch (error) {
      if (this.current !== current) return
      this.current = null
      this.deps.send({ id, kind: 'error', atMs: this.deps.now(), error: '渲染层解码音频失败：' + (error instanceof Error ? error.message : String(error)) })
      return
    }
    // 解码期间被停了：一个字都没放出来，按取消回执。
    if (this.current !== current || current.stop !== null) {
      if (current.stop !== null && !current.stop.acked) this.ack(current)
      return
    }
    const source = context.createBufferSource()
    const gain = context.createGain()
    const probe = context.createScriptProcessor(256, 1, 1)
    source.buffer = buffer
    source.connect(gain)
    gain.connect(context.destination)
    // 探针：输出端是否已经没声。它自己不输出任何东西（不拷贝输入到输出）。
    gain.connect(probe)
    probe.connect(context.destination)
    probe.onaudioprocess = (event) => this.onProbe(current, event.inputBuffer.getChannelData(0))
    current.source = source
    current.gain = gain
    current.probe = probe
    source.onended = () => {
      if (this.current !== current || current.ended) return
      if (current.stop !== null) return
      current.ended = true
      this.cleanup(current)
      this.current = null
      const atMs = this.deps.now()
      this.emit({ type: 'ended', id, atMs })
      this.deps.send({ id, kind: 'finished', atMs })
    }
    source.start()
    current.startedAtMs = this.deps.now()
    this.emit({ type: 'started', id, atMs: current.startedAtMs })
    this.deps.send({ id, kind: 'started', atMs: current.startedAtMs, durationMs: duration * 1000, outputLatencyMs: this.outputLatencyMs() })
  }

  /**
   * 插话检出：立即止声。同步返回调用时刻；`silent` 在探针确认图内无声后兑现。
   * 主进程的 tts-stop 到达时补发取消回执（Narrator 只认它"要求停"之后的 cancelled）。
   */
  stopLocal(reason: 'barge-in' = 'barge-in'): LocalStopRecord | null {
    const current = this.current
    if (current === null || current.ended || current.stop !== null) return null
    const record = this.beginStop(current, reason)
    // 主进程的停止一直不来（失步）：自己补一张取消回执，别让 Narrator 一直等这一句播完。
    this.deps.setTimeout(() => {
      if (current.stop !== null && !current.stop.acked) this.ack(current)
    }, LOCAL_STOP_ACK_MS)
    return record
  }

  /** 主进程要求停（Narrator 的打断）。 */
  handleStopRequest(id: string): void {
    const current = this.current
    if (current === null || current.id !== id) {
      // 已经播完 / 早被顶掉：主进程那边会收到（或已收到）finished，这里不再造一张回执。
      return
    }
    if (current.stop === null) this.beginStop(current, 'request')
    current.stop!.requested = true
    this.ack(current)
  }

  private beginStop(current: Current, reason: 'barge-in' | 'request' | 'superseded'): LocalStopRecord {
    const stopCalledAtMs = this.deps.now()
    let resolveSilent!: (v: { graphSilentAtMs: number; outputLatencyMs: number }) => void
    const silent = new Promise<{ graphSilentAtMs: number; outputLatencyMs: number }>(r => { resolveSilent = r })
    const record: LocalStopRecord = { id: current.id, stopCalledAtMs, silent }
    current.stop = { record, reason, resolveSilent, acked: false, requested: false }
    const context = this.context
    try { current.gain?.gain.setValueAtTime(0, context?.currentTime ?? 0) } catch { /* 节点已断开 */ }
    if (current.gain) current.gain.gain.value = 0
    try { current.source?.stop() } catch { /* 还没开始或已停 */ }
    // 没开始播（还在解码）就没有探针可等：图里本来就没声。
    if (current.probe === null) resolveSilent({ graphSilentAtMs: stopCalledAtMs, outputLatencyMs: this.outputLatencyMs() })
    // 探针一直不回（上下文被挂起）：兜底 500ms 后按调用时刻结算，不让回执卡住。
    this.deps.setTimeout(() => resolveSilent({ graphSilentAtMs: Number.NaN, outputLatencyMs: this.outputLatencyMs() }), 500)
    this.emit({ type: 'ended', id: current.id, atMs: stopCalledAtMs })
    return record
  }

  private onProbe(current: Current, data: Float32Array): void {
    if (current.stop === null) return
    let peak = 0
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
    if (peak < 1e-4) {
      current.stop.resolveSilent({ graphSilentAtMs: this.deps.now(), outputLatencyMs: this.outputLatencyMs() })
      this.cleanup(current)
    }
  }

  private ack(current: Current): void {
    const stop = current.stop
    if (stop === null || stop.acked) return
    stop.acked = true
    void stop.record.silent.then(({ graphSilentAtMs, outputLatencyMs }) => {
      this.deps.send({
        id: current.id, kind: 'cancelled', atMs: this.deps.now(), reason: stop.reason,
        stopCalledAtMs: stop.record.stopCalledAtMs,
        ...(Number.isFinite(graphSilentAtMs) ? { graphSilentAtMs } : {}),
        outputLatencyMs,
      })
    })
    current.ended = true
    if (this.current === current) this.current = null
  }

  private finishStop(current: Current, reason: 'superseded', ack: boolean): void {
    if (current.stop === null) this.beginStop(current, reason)
    if (ack) this.ack(current)
  }

  private cleanup(current: Current): void {
    if (current.probe) current.probe.onaudioprocess = null
    for (const node of [current.source, current.gain, current.probe]) {
      try { node?.disconnect() } catch { /* 已断开 */ }
    }
  }

  private emit(event: { type: 'started' | 'ended'; id: string; atMs: number }): void {
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* 监听方出错不影响播放 */ }
    }
  }
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}
