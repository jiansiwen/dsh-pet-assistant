/**
 * 外放插话检测（M1-05，本地路线，默认关闭的实验开关）+ 渲染层音频接线。
 *
 * 检测器（`BargeInDetector`）是纯逻辑：输入是共享采集里**已过 Chromium 回声消除**的帧电平，
 * 输出"用户开口了"。规则：
 * - **自适应阈值**：以播放期间的残余（回声消除没减干净的助理声音 + 房间底噪）为基线 ——
 *   取最近一段非语音帧电平的中位数，阈值 = 基线 × ratio，并设绝对下限与上限。
 * - **播放起始收敛期**：每句开始播的前 convergeMs 只学基线、不判定（回声消除在新的一句开头要重新跟上）。
 * - **最短语音时长**：连续高于阈值（允许 maxDipMs 的短暂低谷）满 minSpeechMs 才算开口；
 *   咳嗽、敲桌子、电视里的一个字不该打断。
 * - **起点回溯**：报出的起点是这段语音第一帧的时刻；交接给听写时再往前多留 prerollMs（≥300ms）。
 *
 * 会话（`BargeInSession`）把检测器接到共享采集与渲染层播放器上：检出即调用播放器的 `stopLocal`
 * 立即止声（不等主进程往返），并把预滚动 + 交接期间的实时帧攒给紧接着的听写（`takeHandover`）。
 *
 * 埋点：每次检出记录"语音开始→检出"与"检出→实际静音"（静音以播放器输出端探针确认无声的时刻
 * 加 Chromium 报的输出延迟为准，不是代码回调时刻）。只记时间，不记音频。
 */
import {
  CaptureError, sharedCapture, type AudioCaptureService, type CaptureFrame, type CaptureReceipt, type CaptureSubscription,
} from './audio-capture.ts'
import { pcm16Base64, resampleTo16k, type DictationHandover } from './dictation.ts'
import { RendererPlayer, type LocalStopRecord, type PlaybackReceiptPayload } from './playback.ts'

export interface BargeInConfig {
  readonly convergeMs: number
  readonly minSpeechMs: number
  readonly ratio: number
  readonly floorRms: number
  /** 阈值上限：再吵的环境也不让阈值高过正常人声。 */
  readonly ceilingRms: number
  readonly maxDipMs: number
  /** 一段候选语音结束后多久内的帧不进基线（语音拖尾）。 */
  readonly hangoverMs: number
  readonly prerollMs: number
  readonly baselineWindowMs: number
  readonly baselinePercentile: number
  /** 一句播完后多久内的尾音不判定（扬声器余响 / 回声消除尾巴）。 */
  readonly tailMs: number
}

export const DEFAULT_BARGE_IN: BargeInConfig = {
  convergeMs: 300,
  minSpeechMs: 200,
  ratio: 3,
  floorRms: 0.008,
  ceilingRms: 0.15,
  maxDipMs: 200,
  hangoverMs: 300,
  prerollMs: 400,
  baselineWindowMs: 2000,
  baselinePercentile: 0.5,
  tailMs: 200,
}

export interface BargeInDecision {
  readonly onsetAtMs: number
  readonly detectedAtMs: number
  readonly baselineRms: number
  readonly threshold: number
}

export interface PlaybackClock {
  /** 当前这一句开始播的时刻；没在播是 null。 */
  readonly playingSince: number | null
  /** 上一句结束（播完或被停）的时刻；还没播过是 null。 */
  readonly lastEndedAt: number | null
}

/**
 * 基线只从"不像语音"的帧里学：收敛期全收（那段只有残余与底噪），之后只收低于阈值、且不在候选语音段
 * 及其拖尾里的帧；基线取中位数而不是高分位 —— 高分位会被语音的弱音节一点点抬上去
 *（自动增益把人声放到 0.2–0.4，字间低谷又落回阈值下方），阈值跟着人声一路涨，最后什么都检不出。
 * 这是隔离验证里实测出来的失败模式，见 verify-m1-bargein 的电平轨迹。
 */
export class BargeInDetector {
  private readonly config: BargeInConfig
  private history: Array<{ atMs: number; rms: number }> = []
  private runStart: number | null = null
  private voicedMs = 0
  private dipMs = 0
  private quietUntil = -Infinity

  constructor(config: Partial<BargeInConfig> = {}) {
    this.config = { ...DEFAULT_BARGE_IN, ...config }
  }

  get settings(): BargeInConfig {
    return this.config
  }

  baseline(): number {
    if (this.history.length === 0) return 0
    const sorted = this.history.map(item => item.rms).sort((a, b) => a - b)
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * this.config.baselinePercentile))
    return sorted[index]
  }

  threshold(): number {
    return Math.min(this.config.ceilingRms, Math.max(this.config.floorRms, this.baseline() * this.config.ratio))
  }

  reset(): void {
    this.history = []
    this.clearRun()
    this.quietUntil = -Infinity
  }

  /** 喂一帧。判定时刻是这帧结束的时刻。 */
  push(frame: { atMs: number; durationMs: number; rms: number }, clock: PlaybackClock): BargeInDecision | null {
    const endMs = frame.atMs + frame.durationMs
    const armed = clock.playingSince !== null
      ? endMs - clock.playingSince >= this.config.convergeMs
      : clock.lastEndedAt !== null && endMs - clock.lastEndedAt >= this.config.tailMs
    const threshold = this.threshold()
    const loud = frame.rms >= threshold
    if (!armed) {
      // 收敛期 / 尾音期：只学基线（用中位数，偶尔混进一点人声也抬不动它）。跨过边界的候选段作废。
      this.learn(frame)
      this.clearRun()
      return null
    }
    if (loud) {
      if (this.runStart === null) this.runStart = frame.atMs
      this.voicedMs += frame.durationMs
      this.dipMs = 0
      if (this.voicedMs >= this.config.minSpeechMs) {
        const decision: BargeInDecision = { onsetAtMs: this.runStart, detectedAtMs: endMs, baselineRms: this.baseline(), threshold }
        this.clearRun()
        this.quietUntil = endMs + this.config.hangoverMs
        return decision
      }
      return null
    }
    if (this.runStart !== null) {
      this.dipMs += frame.durationMs
      if (this.dipMs <= this.config.maxDipMs) return null
      // 不够长的一段：作废，且它和紧随其后的拖尾都不进基线。
      this.clearRun()
      this.quietUntil = endMs + this.config.hangoverMs
      return null
    }
    if (frame.atMs >= this.quietUntil) this.learn(frame)
    return null
  }

  private learn(frame: { atMs: number; rms: number }): void {
    this.history.push({ atMs: frame.atMs, rms: frame.rms })
    const cutoff = frame.atMs - this.config.baselineWindowMs
    while (this.history.length > 1 && this.history[0].atMs < cutoff) this.history.shift()
  }

  private clearRun(): void {
    this.runStart = null
    this.voicedMs = 0
    this.dipMs = 0
  }
}

/** 一次插话的埋点。时间都在 performance.now 时间轴上。 */
export interface BargeInMetrics {
  readonly onsetAtMs: number
  readonly detectedAtMs: number
  readonly stopCalledAtMs: number | null
  readonly graphSilentAtMs: number | null
  readonly outputLatencyMs: number | null
  /** 语音开始 → 检出。 */
  readonly onsetToDetectMs: number
  /** 检出 → 实际静音（图内无声 + 输出延迟）；没在播（句间空档）时为 null。 */
  readonly detectToSilenceMs: number | null
  readonly baselineRms: number
  readonly threshold: number
  readonly playing: boolean
}

export interface BargeInSessionOptions {
  readonly capture: AudioCaptureService
  readonly player: RendererPlayer
  readonly now: () => number
  readonly config?: Partial<BargeInConfig>
  /** 检出：调用方开始听写（交接）并通知主进程停播。 */
  readonly onDetected: (detection: { decision: BargeInDecision; stop: LocalStopRecord | null; playingSince: number | null }) => void
  /** 静音确认后的完整埋点。 */
  readonly onMetrics?: (metrics: BargeInMetrics) => void
  /** 采集意外结束（不是自己退订）。 */
  readonly onLost?: (reason: string) => void
  readonly setTimeout: (fn: () => void, ms: number) => unknown
}

/** 插话监听期间每帧的电平与阈值（诊断用，有界，不含音频）。 */
export const traceFrames: Array<{ atMs: number; rms: number; thr: number; playing: boolean }> = []

/** 检出后等听写接手的上限；超时就把攒的帧丢掉、退订。 */
export const HANDOVER_TIMEOUT_MS = 4000
/** 交接缓冲上限（毫秒音频）。 */
export const HANDOVER_MAX_MS = 5000

export class BargeInSession {
  private readonly options: BargeInSessionOptions
  private readonly detector: BargeInDetector
  private subscription: CaptureSubscription | null = null
  private stopped = false
  private handover: { frames: CaptureFrame[]; ms: number; baselineRms: number; threshold: number } | null = null
  private lastEndedAt: number | null = null
  private offPlayback: (() => void) | null = null
  private closed = false
  private readonly closedListeners: Array<() => void> = []

  constructor(options: BargeInSessionOptions) {
    this.options = options
    this.detector = new BargeInDetector(options.config)
  }

  get pendingHandover(): boolean {
    return this.handover !== null
  }

  async start(): Promise<void> {
    this.offPlayback = this.options.player.onPlayback(event => {
      if (event.type === 'ended') this.lastEndedAt = event.atMs
    })
    try {
      this.subscription = await this.options.capture.subscribe({
        kind: 'barge-in',
        preroll: true,
        onFrame: frame => this.onFrame(frame),
        onEnd: receipt => this.onEnd(receipt),
      })
    } catch (error) {
      this.offPlayback?.()
      this.offPlayback = null
      throw error
    }
    if (this.stopped) this.close()
  }

  /** 授权撤回 / 播放结束：没有待交接的就立即退订；有就等听写取走（或超时）。 */
  stop(): void {
    this.stopped = true
    if (this.handover === null) this.close()
  }

  takeHandover(): DictationHandover | null {
    const handover = this.handover
    this.handover = null
    this.close()
    if (handover === null) return null
    return { frames: handover.frames, baselineRms: handover.baselineRms, threshold: handover.threshold }
  }

  /** 订阅真正退掉之后回调（交接完成 / 超时 / 直接停）。 */
  whenClosed(listener: () => void): void {
    if (this.closed) listener()
    else this.closedListeners.push(listener)
  }

  private close(): void {
    this.offPlayback?.()
    this.offPlayback = null
    const subscription = this.subscription
    this.subscription = null
    subscription?.close()
    if (this.closed) return
    this.closed = true
    for (const listener of this.closedListeners.splice(0)) {
      try { listener() } catch { /* 忽略 */ }
    }
  }

  private onEnd(receipt: CaptureReceipt): void {
    if (receipt.reason === 'unsubscribed' || receipt.reason === 'revoked' || receipt.reason === 'stopped') return
    this.options.onLost?.(receipt.detail ?? receipt.reason)
  }

  private onFrame(frame: CaptureFrame): void {
    const handover = this.handover
    if (handover !== null) {
      if (handover.ms < HANDOVER_MAX_MS) {
        handover.frames.push(frame)
        handover.ms += frame.durationMs
      }
      return
    }
    if (this.stopped) return
    const player = this.options.player
    const decision = this.detector.push(frame, { playingSince: player.playingSince, lastEndedAt: this.lastEndedAt })
    // 诊断轨迹（只有电平与阈值，没有音频）：有界，给隔离验证与调参用。
    traceFrames.push({ atMs: Math.round(frame.atMs), rms: +frame.rms.toFixed(4), thr: +this.detector.threshold().toFixed(4), playing: player.playingSince !== null })
    if (traceFrames.length > 3000) traceFrames.shift()
    if (decision === null) return
    const playing = player.playing
    const playingSince = player.playingSince
    // 口令式打断：检出人声先不止声，等识别出明确口令（停一下/等等/等一下…）再停。
    // 否则外放时助理自己的回声、环境闲聊都会把朗读打断——用户看到的就是"说一半自己停了"。
    // 这里不做本地止声（stop 恒为 null）；命中口令后由主进程停朗读，走正常的停止回执。
    // 预滚动：检出起点之前再多留 prerollMs，用户开口的头一个字在这里面。
    const since = decision.onsetAtMs - this.detector.settings.prerollMs
    const frames = this.options.capture.preroll(since)
    this.handover = { frames, ms: frames.reduce((sum, item) => sum + item.durationMs, 0), baselineRms: decision.baselineRms, threshold: decision.threshold }
    this.options.setTimeout(() => {
      if (this.handover !== null) {
        this.handover = null
        this.close()
      }
    }, HANDOVER_TIMEOUT_MS)
    this.options.onDetected({ decision, stop: null, playingSince })
    // 静音时刻由"口令命中后主进程停朗读"那条链路记录；这里只报检出指标。
    this.options.onMetrics?.({
      onsetAtMs: decision.onsetAtMs, detectedAtMs: decision.detectedAtMs, baselineRms: decision.baselineRms,
      threshold: decision.threshold, onsetToDetectMs: decision.detectedAtMs - decision.onsetAtMs, playing,
      stopCalledAtMs: null, graphSilentAtMs: null, outputLatencyMs: null, detectToSilenceMs: null,
    })
  }
}

// ── 渲染层接线：授权、KWS 喂数、插话会话、渲染层播放 ──────────────────

export interface AudioGrantsPayload {
  readonly dictation: boolean
  readonly bargeIn: boolean
  readonly kws: boolean
  readonly meetingId: string | null
  /** 共享采集下次开设备时是否开自动增益（外放插话开着时为 false）。 */
  readonly autoGainControl?: boolean
}

/** preload 暴露的那几条音频通道（见 preload/index.ts）。 */
export interface AudioBridgeApi {
  onAudioGrants(callback: (grants: AudioGrantsPayload) => void): () => void
  audioSync(): Promise<AudioGrantsPayload>
  kwsFeed(chunkBase64: string): void
  audioConsumerLost(kind: 'kws' | 'barge-in', reason: string): void
  onCaptureResume(callback: () => void): () => void
  onTtsPlay(callback: (payload: { id: string; b64: string }) => void): () => void
  onTtsStop(callback: (payload: { id: string }) => void): () => void
  ttsPlaybackReceipt(receipt: PlaybackReceiptPayload): void
  bargeInDetected(payload: { onsetAtMs: number; detectedAtMs: number; playing: boolean }): void
  bargeInMetrics(metrics: BargeInMetrics): void
}

export interface AudioBridgeHandlers {
  /** 插话检出：开始听写，`takeHandover` 交出预滚动帧。 */
  onBargeIn(takeHandover: () => DictationHandover | null): void
}

/** KWS 每次送多少（毫秒）。太碎是 IPC 开销，太大是唤醒延迟。 */
const KWS_SEND_MS = 100

export interface AudioBridge {
  readonly player: RendererPlayer
  readonly capture: AudioCaptureService
  readonly metrics: BargeInMetrics[]
  dispose(): void
}

export function installAudioBridge(api: AudioBridgeApi, handlers: AudioBridgeHandlers, capture: AudioCaptureService = sharedCapture()): AudioBridge {
  const now = (): number => performance.now()
  const player = new RendererPlayer({
    createContext: () => new AudioContext() as unknown as import('./playback.ts').PlaybackContextLike,
    now,
    send: receipt => api.ttsPlaybackReceipt(receipt),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  })
  const metrics: BargeInMetrics[] = []
  /** 诊断：每次检出时采集会话的首帧时刻（隔离验证据此换算假设备文件里的真实开口时刻）。 */
  const detections: Array<{ onsetAtMs: number; detectedAtMs: number; firstFrameAtMs: number | null; session: number; playingSince: number | null }> = []
  let kws: CaptureSubscription | null = null
  let kwsStarting = false
  let kwsWanted = false
  let session: BargeInSession | null = null
  let disposed = false

  const startKws = async (): Promise<void> => {
    if (kws !== null || kwsStarting) return
    kwsStarting = true
    let buffer: Float32Array[] = []
    let bufferedMs = 0
    try {
      const subscription = await capture.subscribe({
        kind: 'kws',
        onFrame: (frame) => {
          buffer.push(resampleTo16k(frame.samples, frame.sampleRate))
          bufferedMs += frame.durationMs
          if (bufferedMs < KWS_SEND_MS) return
          const total = buffer.reduce((sum, part) => sum + part.length, 0)
          const merged = new Float32Array(total)
          let offset = 0
          for (const part of buffer) { merged.set(part, offset); offset += part.length }
          buffer = []
          bufferedMs = 0
          api.kwsFeed(pcm16Base64(merged))
        },
        onEnd: (receipt) => {
          if (kws?.id === receipt.id) kws = null
          if (receipt.reason === 'unsubscribed' || receipt.reason === 'revoked' || receipt.reason === 'stopped') return
          api.audioConsumerLost('kws', receipt.detail ?? describeLost(receipt.reason))
        },
      })
      if (!kwsWanted || disposed) subscription.close()
      else kws = subscription
    } catch (error) {
      // 授权在打开期间被撤回不算故障；其余（拒绝权限 / 没设备）如实报上去，主进程粘住"不可用"。
      if (!(error instanceof CaptureError && error.code === 'not-authorized')) {
        api.audioConsumerLost('kws', error instanceof Error ? error.message : String(error))
      }
    } finally {
      kwsStarting = false
    }
  }

  const startBargeIn = (): void => {
    if (session !== null && !session.pendingHandover) return
    const current = new BargeInSession({
      capture, player, now,
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      onDetected: ({ decision, playingSince }) => {
        const snapshot = capture.snapshot()
        detections.push({ onsetAtMs: decision.onsetAtMs, detectedAtMs: decision.detectedAtMs, firstFrameAtMs: snapshot.firstFrameAtMs, session: snapshot.session, playingSince })
        if (detections.length > 50) detections.shift()
        api.bargeInDetected({ onsetAtMs: decision.onsetAtMs, detectedAtMs: decision.detectedAtMs, playing: true })
        handlers.onBargeIn(() => current.takeHandover())
      },
      onMetrics: (item) => {
        metrics.push(item)
        if (metrics.length > 50) metrics.shift()
        api.bargeInMetrics(item)
      },
      onLost: reason => api.audioConsumerLost('barge-in', reason),
    })
    session = current
    void current.start().catch((error) => {
      if (session === current) session = null
      if (!(error instanceof CaptureError && error.code === 'not-authorized')) {
        api.audioConsumerLost('barge-in', error instanceof Error ? error.message : String(error))
      }
    })
  }

  let lastGrants: AudioGrantsPayload = { dictation: false, bargeIn: false, kws: false, meetingId: null }
  const apply = (grants: AudioGrantsPayload): void => {
    if (disposed) return
    lastGrants = grants
    // 插话 → 听写交接的那几毫秒：主进程已把设备判给听写，但检测器手里的预滚动帧还没被取走。
    // 这时先不撤插话订阅（否则交接前后会漏掉一帧），等交接完成再按主进程的授权全集落实。
    const handingOver = session !== null && session.pendingHandover && !grants.bargeIn
    capture.setGrants(handingOver ? { ...grants, bargeIn: true } : grants)
    kwsWanted = grants.kws
    if (grants.kws) void startKws()
    else if (kws !== null) { kws.close(); kws = null }
    if (grants.bargeIn) startBargeIn()
    else if (session !== null) {
      const ending = session
      session = null
      if (handingOver) ending.whenClosed(() => { if (!disposed) capture.setGrants(lastGrants) })
      ending.stop()
    }
  }

  const offs = [
    api.onAudioGrants(apply),
    api.onCaptureResume(() => capture.handleResume()),
    api.onTtsPlay(({ id, b64 }) => void player.play(id, b64)),
    api.onTtsStop(({ id }) => player.handleStopRequest(id)),
  ]
  // 页面重载（渲染进程自愈）之后主动对一次账：主进程那边的授权还在，这里的订阅已经没了。
  void api.audioSync().then(apply).catch(() => undefined)

  ;(window as unknown as { __dshAudioDebug?: unknown }).__dshAudioDebug = {
    capture: () => capture.snapshot(),
    metrics: () => [...metrics],
    detections: () => [...detections],
    trace: () => [...traceFrames],
    playing: () => player.playing,
  }

  return {
    player, capture, metrics,
    dispose(): void {
      disposed = true
      for (const off of offs) off()
      kws?.close()
      kws = null
      session?.stop()
      session = null
    },
  }
}

function describeLost(reason: string): string {
  switch (reason) {
    case 'track-ended': return '麦克风中途断开（权限被撤销或设备被拔出）'
    case 'device-changed': return '麦克风设备切换后没能重新打开'
    case 'resumed': return '休眠恢复后麦克风没能重新打开'
    case 'consumer-error': return '唤醒处理出错'
    default: return '麦克风采集中断'
  }
}

/**
 * 只剩下唤醒词本身（插话时自己念了唤醒词）：只当打断，不当成要发出去的话。
 *
 * 唤醒词是「小潘同学」。同音容错保留：识别器常把"潘"听成盼/攀/盘/胖、"同学"听成同/桐，
 * 所以按音节放宽，但仍然要求**只叫名字、没有别的话**。
 */
export function isWakePhraseOnly(text: string): boolean {
  // 允许音节之间夹标点（"小潘，同学。"）：识别结果常带逗号，不能因此当成一句话发出去。
  // "小"也放宽到晓/肖：System.Speech 对同音姓名的容错本来就这么宽。
  return /^[\s,，。.!！?？、]*[小晓肖][潘盼攀盘胖][\s,，。.!！?？、]*同学?[\s,，。.!！?？、]*$/u.test(text.trim())
}
