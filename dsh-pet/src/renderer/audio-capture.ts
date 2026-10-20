/**
 * 共享音频采集（M1-03）：渲染层**只打开一次**麦克风，作为"现在采到了什么"的统一事实来源。
 *
 * 为什么要收拢：听写、插话检测、KWS 唤醒、会议麦克风轨以前各自 getUserMedia，各开一个
 * AudioContext。两路同时开时谁拿到真声音、谁拿到静音全看驱动心情；任何一路忘了 stop 就是一个
 * 锁住的麦克风（系统托盘的麦克风图标一直亮着）。现在：
 *
 * - **设备一次打开**：第一个消费者订阅时打开，最后一个退订后短暂停留（LINGER_MS）再关 ——
 *   插话检测把设备交给听写时不必关了再开（开设备要几百毫秒，用户的话头就丢在这段里）。
 * - **按授权订阅**：谁能订阅由主进程的仲裁器（`main/audio.ts`）说了算，经 `audio-grants`
 *   下发。授权撤回即强制退订。会议轨还要求令牌等于主进程正在录的那场会议 id。
 * - **帧带事实**：轨内序号、设备采样率、单调时间戳（performance.now 时间轴）、缺口标记
 *   （回调时刻与样本计数推算偏离、设备重开、休眠恢复），以及每个订阅结束时的取消回执。
 * - **有界内存**：只有声明需要预滚动的订阅（插话检测）在时，才保留最近 ≤ PREROLL_MAX_MS 的环形缓冲；
 *   不需要时立即清空。这里不写任何文件 —— 渲染层也写不了；录音落盘只有会议一条路，
 *   且主进程对每一块都核对正在录的会议 id。
 * - **生命周期**：重复开始/停止、轨道 ended（权限撤销 / 拔设备）、devicechange（设备切换）、
 *   休眠恢复（主进程转发 powerMonitor 的 resume）、消费者回调抛错，都会释放或重建资源，不锁麦克风。
 *
 * 依赖全部可注入（getUserMedia / AudioContext / 时钟 / 定时器），测试用假 MediaStream 跑完整生命周期。
 */

export type CaptureConsumerKind = 'dictation' | 'barge-in' | 'kws' | 'meeting'

export interface CaptureFrame {
  /** 本服务内单调递增的帧序号（跨设备重开也连续）。 */
  readonly seq: number
  /** 第几次打开设备。重开（设备切换 / 休眠恢复）后加一。 */
  readonly session: number
  readonly sampleRate: number
  /** 设备采样率下的单声道样本（已过浏览器的回声消除 / 降噪 / 自动增益）。 */
  readonly samples: Float32Array
  /** 第一个样本的时刻（performance.now 时间轴，毫秒）。 */
  readonly atMs: number
  readonly durationMs: number
  /** 这一帧之前有缺口：中间那段是真没采到，不是静音。 */
  readonly gapBefore: boolean
  /** 线性 RMS，给各个检测器用，免得每个消费者各算一遍。 */
  readonly rms: number
}

export type CaptureEndReason =
  | 'unsubscribed' | 'revoked' | 'track-ended' | 'device-changed' | 'resumed'
  | 'consumer-error' | 'stopped' | 'open-failed'

/** 订阅结束的回执：消费者据此知道"到哪一帧为止是我收到的、为什么停"。 */
export interface CaptureReceipt {
  readonly id: number
  readonly kind: CaptureConsumerKind
  readonly reason: CaptureEndReason
  readonly frames: number
  readonly lastSeq: number | null
  readonly endedAtMs: number
  readonly detail?: string
}

export interface CaptureSubscription {
  readonly id: number
  readonly kind: CaptureConsumerKind
  /** 主动退订。幂等：第二次返回同一张回执。 */
  close(): CaptureReceipt
  readonly ended: Promise<CaptureReceipt>
}

export interface SubscribeRequest {
  readonly kind: CaptureConsumerKind
  /** 会议轨的令牌（会议 id）。其他消费者不需要。 */
  readonly token?: string
  readonly onFrame: (frame: CaptureFrame) => void
  readonly onEnd?: (receipt: CaptureReceipt) => void
  /** 需要预滚动缓冲（插话检测：检出点之前的话头要交给听写）。 */
  readonly preroll?: boolean
}

export class CaptureError extends Error {
  readonly code: 'not-authorized' | 'unavailable' | 'denied' | 'not-found' | 'failed'
  constructor(code: CaptureError['code'], message: string) {
    super(message)
    this.code = code
  }
}

// ── 可注入依赖（与 Web Audio 的最小交集）────────────────────────────────

export interface TrackLike {
  stop(): void
  addEventListener(type: 'ended', listener: () => void): void
  removeEventListener?(type: 'ended', listener: () => void): void
  getSettings?(): { deviceId?: string; groupId?: string }
  readonly readyState?: string
}

export interface StreamLike {
  getTracks(): TrackLike[]
  getAudioTracks?(): TrackLike[]
}

export interface ProcessorLike {
  connect(node: unknown): void
  disconnect(): void
  onaudioprocess: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null
}

export interface ContextLike {
  readonly sampleRate: number
  readonly state?: string
  readonly destination: unknown
  createMediaStreamSource(stream: StreamLike): { connect(node: unknown): void; disconnect?(): void }
  createScriptProcessor(bufferSize: number, inputs: number, outputs: number): ProcessorLike
  resume?(): Promise<void>
  close(): Promise<void>
}

export interface DeviceInfoLike {
  readonly kind: string
  readonly deviceId: string
  readonly groupId?: string
}

export interface CaptureDeps {
  getUserMedia(constraints: { audio: Record<string, unknown> }): Promise<StreamLike>
  createContext(): ContextLike
  now(): number
  enumerateDevices?(): Promise<DeviceInfoLike[]>
  onDeviceChange?(listener: () => void): () => void
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface CaptureOptions {
  /** 最后一个消费者退订后设备保留多久（毫秒）。 */
  readonly lingerMs?: number
  /** ScriptProcessor 的缓冲帧数。2048@48k ≈ 43ms：插话检测要的响应速度，听写 / 唤醒也够用。 */
  readonly frameSize?: number
  /** 预滚动缓冲上限（毫秒）。 */
  readonly prerollMaxMs?: number
  /** 回调时刻与样本计数推算偏离多少算缺口。 */
  readonly gapToleranceMs?: number
}

export const LINGER_MS = 300
export const FRAME_SIZE = 2048
export const PREROLL_MAX_MS = 2000
export const GAP_TOLERANCE_MS = 250

/** 与旧听写 / 会议一致的约束：回声消除、降噪、自动增益全开。不指定采样率（见 dictation.ts 的说明）。 */
export const CAPTURE_CONSTRAINTS = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } as const

export function frameRms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

export function describeMediaError(error: unknown): CaptureError {
  if (error instanceof CaptureError) return error
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (/NotAllowedError|Permission|SecurityError/i.test(message)) return new CaptureError('denied', '麦克风权限被拒绝，请在系统设置里允许')
  if (/NotFoundError|DevicesNotFound|OverconstrainedError/i.test(message)) return new CaptureError('not-found', '没有找到可用的麦克风')
  if (/NotReadableError|TrackStartError/i.test(message)) return new CaptureError('failed', '麦克风被其他程序占用或无法读取')
  return new CaptureError('failed', '无法访问麦克风：' + message)
}

interface Sub {
  readonly id: number
  readonly kind: CaptureConsumerKind
  readonly onFrame: (frame: CaptureFrame) => void
  readonly onEnd?: (receipt: CaptureReceipt) => void
  readonly preroll: boolean
  frames: number
  lastSeq: number | null
  receipt: CaptureReceipt | null
  resolve: (receipt: CaptureReceipt) => void
}

interface Device {
  readonly session: number
  readonly stream: StreamLike
  readonly context: ContextLike
  readonly processor: ProcessorLike
  readonly mute: ProcessorLike
  readonly source: { connect(node: unknown): void; disconnect?(): void }
  readonly trackListeners: Array<{ track: TrackLike; listener: () => void }>
  readonly deviceId: string | null
  readonly groupId: string | null
  readonly openedAtMs: number
  /** 这次打开后第一帧的时刻（诊断：隔离验证用它把假设备的文件位置换算到采集时间轴）。 */
  firstFrameAtMs: number | null
  /** 时间轴锚点：第一帧的时刻 + 之后的样本数。 */
  anchorMs: number | null
  samplesSinceAnchor: number
  pendingGap: boolean
}

export interface CaptureSnapshot {
  readonly open: boolean
  readonly opening: boolean
  readonly session: number
  readonly sampleRate: number | null
  readonly openedAtMs: number | null
  readonly firstFrameAtMs: number | null
  readonly consumers: CaptureConsumerKind[]
  readonly grants: CaptureConsumerKind[]
  readonly framesTotal: number
  readonly gaps: number
  readonly prerollFrames: number
  readonly opens: number
  readonly closes: number
  readonly lastEnd: CaptureReceipt | null
}

export class AudioCaptureService {
  private readonly deps: CaptureDeps
  private readonly lingerMs: number
  private readonly frameSize: number
  private readonly prerollMaxMs: number
  private readonly gapToleranceMs: number

  private readonly grants = new Map<CaptureConsumerKind, string | true>()
  private readonly grantWaiters = new Set<() => void>()
  private readonly subs = new Map<number, Sub>()
  private nextId = 1
  private nextSeq = 0
  private session = 0
  private device: Device | null = null
  private opening: Promise<Device> | null = null
  /** 打开期间被要求关掉（全部退订 / 授权撤回）：打开完成后立刻释放。 */
  private openCancelled = false
  private lingerTimer: unknown = null
  private ring: CaptureFrame[] = []
  private ringMs = 0
  private framesTotal = 0
  private gaps = 0
  private opens = 0
  private closes = 0
  private lastEnd: CaptureReceipt | null = null
  private offDeviceChange: (() => void) | null = null
  private restarting = false
  /**
   * 自动增益。缺省开（与旧听写 / 会议一致）。"外放插话"实验开关打开时主进程下发关：隔离验证实测，
   * 开着自动增益时回声消除剩下的低电平残余会被放大到和人声同一量级，能量检测分不开（见报告）。
   * 只在下次打开设备时生效 —— 改约束要重开设备，不能在别人正录着时打断。
   */
  private autoGainControl = true

  constructor(deps: CaptureDeps, options: CaptureOptions = {}) {
    this.deps = deps
    this.lingerMs = options.lingerMs ?? LINGER_MS
    this.frameSize = options.frameSize ?? FRAME_SIZE
    this.prerollMaxMs = options.prerollMaxMs ?? PREROLL_MAX_MS
    this.gapToleranceMs = options.gapToleranceMs ?? GAP_TOLERANCE_MS
  }

  // ── 授权 ──────────────────────────────────────────────────────────────

  /**
   * 主进程下发的授权全集（不是增量）：不在里面的一律撤回，已有订阅随之结束（回执 reason=revoked）。
   */
  setGrants(next: { dictation?: boolean; bargeIn?: boolean; kws?: boolean; meetingId?: string | null; autoGainControl?: boolean }): void {
    if (typeof next.autoGainControl === 'boolean') this.autoGainControl = next.autoGainControl
    const wanted = new Map<CaptureConsumerKind, string | true>()
    if (next.dictation) wanted.set('dictation', true)
    if (next.bargeIn) wanted.set('barge-in', true)
    if (next.kws) wanted.set('kws', true)
    if (typeof next.meetingId === 'string' && next.meetingId !== '') wanted.set('meeting', next.meetingId)
    for (const [kind, token] of [...this.grants]) {
      if (wanted.get(kind) !== token) {
        this.grants.delete(kind)
        for (const sub of [...this.subs.values()]) if (sub.kind === kind) this.end(sub, 'revoked')
      }
    }
    for (const [kind, token] of wanted) this.grants.set(kind, token)
    for (const wake of [...this.grantWaiters]) wake()
    this.maybeRelease()
  }

  isGranted(kind: CaptureConsumerKind, token?: string): boolean {
    const grant = this.grants.get(kind)
    if (grant === undefined) return false
    return grant === true || grant === token
  }

  /** 等授权到达（主进程的授权消息与 invoke 回包谁先到不保证）。超时返回 false。 */
  waitForGrant(kind: CaptureConsumerKind, timeoutMs: number, token?: string): Promise<boolean> {
    if (this.isGranted(kind, token)) return Promise.resolve(true)
    return new Promise((resolve) => {
      const check = (): void => {
        if (!this.isGranted(kind, token)) return
        this.grantWaiters.delete(check)
        this.deps.clearTimeout(timer)
        resolve(true)
      }
      const timer = this.deps.setTimeout(() => {
        this.grantWaiters.delete(check)
        resolve(this.isGranted(kind, token))
      }, timeoutMs)
      this.grantWaiters.add(check)
    })
  }

  // ── 订阅 ──────────────────────────────────────────────────────────────

  async subscribe(request: SubscribeRequest): Promise<CaptureSubscription> {
    if (!this.isGranted(request.kind, request.token)) {
      throw new CaptureError('not-authorized', request.kind === 'meeting' ? '没有正在录制的会议授权，不能采集会议音轨' : '麦克风当前没有授权给这项功能')
    }
    let resolve!: (receipt: CaptureReceipt) => void
    const ended = new Promise<CaptureReceipt>(r => { resolve = r })
    const sub: Sub = {
      id: this.nextId++, kind: request.kind, onFrame: request.onFrame, onEnd: request.onEnd,
      preroll: request.preroll === true, frames: 0, lastSeq: null, receipt: null, resolve,
    }
    this.subs.set(sub.id, sub)
    this.cancelLinger()
    try {
      await this.ensureOpen()
    } catch (error) {
      const failure = describeMediaError(error)
      this.end(sub, 'open-failed', failure.message)
      throw failure
    }
    // 打开期间被撤回 / 退订了：不把一个已经结束的订阅交出去当成活的。
    if (sub.receipt !== null) throw new CaptureError('not-authorized', '麦克风授权在打开设备期间被撤回')
    return {
      id: sub.id,
      kind: sub.kind,
      close: () => this.end(sub, 'unsubscribed'),
      ended,
    }
  }

  /** 预滚动缓冲里 atMs ≥ sinceMs 的帧（拷贝出去的是引用，帧对象本身不可变）。 */
  preroll(sinceMs: number): CaptureFrame[] {
    return this.ring.filter(frame => frame.atMs + frame.durationMs > sinceMs)
  }

  /** 休眠恢复：设备句柄多半已经失效，开着就重开一次（帧上标缺口）。 */
  handleResume(): void {
    if (this.device !== null) void this.restart('resumed')
  }

  /** 全部停掉（退出 / 页面卸载）。 */
  stopAll(): void {
    for (const sub of [...this.subs.values()]) this.end(sub, 'stopped')
    this.cancelLinger()
    this.teardown()
  }

  snapshot(): CaptureSnapshot {
    return {
      open: this.device !== null,
      opening: this.opening !== null,
      session: this.session,
      sampleRate: this.device?.context.sampleRate ?? null,
      openedAtMs: this.device?.openedAtMs ?? null,
      firstFrameAtMs: this.device?.firstFrameAtMs ?? null,
      consumers: [...this.subs.values()].map(sub => sub.kind),
      grants: [...this.grants.keys()],
      framesTotal: this.framesTotal,
      gaps: this.gaps,
      prerollFrames: this.ring.length,
      opens: this.opens,
      closes: this.closes,
      lastEnd: this.lastEnd,
    }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private end(sub: Sub, reason: CaptureEndReason, detail?: string): CaptureReceipt {
    if (sub.receipt !== null) return sub.receipt
    const receipt: CaptureReceipt = {
      id: sub.id, kind: sub.kind, reason, frames: sub.frames, lastSeq: sub.lastSeq, endedAtMs: this.deps.now(),
      ...(detail === undefined ? {} : { detail }),
    }
    sub.receipt = receipt
    this.subs.delete(sub.id)
    this.lastEnd = receipt
    try { sub.onEnd?.(receipt) } catch { /* 回执回调出错不影响释放 */ }
    sub.resolve(receipt)
    if (![...this.subs.values()].some(other => other.preroll)) this.clearRing()
    this.maybeRelease()
    return receipt
  }

  private maybeRelease(): void {
    if (this.subs.size > 0) return
    if (this.opening !== null) {
      this.openCancelled = true
      return
    }
    if (this.device === null || this.lingerTimer !== null) return
    this.lingerTimer = this.deps.setTimeout(() => {
      this.lingerTimer = null
      if (this.subs.size === 0) this.teardown()
    }, this.lingerMs)
  }

  private cancelLinger(): void {
    if (this.lingerTimer === null) return
    this.deps.clearTimeout(this.lingerTimer)
    this.lingerTimer = null
  }

  private ensureOpen(): Promise<Device> {
    if (this.device !== null) return Promise.resolve(this.device)
    if (this.opening !== null) return this.opening
    this.openCancelled = false
    const opening = this.openDevice().then((device) => {
      this.opening = null
      if (this.openCancelled || this.subs.size === 0) {
        this.openCancelled = false
        this.device = device
        this.teardown()
        return device
      }
      this.device = device
      return device
    }, (error) => {
      this.opening = null
      this.openCancelled = false
      throw error
    })
    this.opening = opening
    return opening
  }

  private async openDevice(): Promise<Device> {
    const stream = await this.deps.getUserMedia({ audio: { ...CAPTURE_CONSTRAINTS, autoGainControl: this.autoGainControl } })
    let context: ContextLike
    try {
      context = this.deps.createContext()
      if (context.state === 'suspended') await context.resume?.().catch(() => undefined)
    } catch (error) {
      for (const track of stream.getTracks()) { try { track.stop() } catch { /* 已停 */ } }
      throw error
    }
    let source: Device['source']
    let processor: ProcessorLike
    let mute: ProcessorLike
    try {
      source = context.createMediaStreamSource(stream)
      processor = context.createScriptProcessor(this.frameSize, 1, 1)
      mute = context.createScriptProcessor(256, 1, 1)
    } catch (error) {
      for (const track of stream.getTracks()) { try { track.stop() } catch { /* 已停 */ } }
      void context.close().catch(() => undefined)
      throw error
    }
    this.session++
    this.opens++
    const audioTracks = stream.getAudioTracks?.() ?? stream.getTracks()
    const settings = audioTracks[0]?.getSettings?.() ?? {}
    const device: Device = {
      session: this.session, stream, context, processor, mute, source, trackListeners: [],
      deviceId: settings.deviceId ?? null, groupId: settings.groupId ?? null, openedAtMs: this.deps.now(),
      firstFrameAtMs: null, anchorMs: null, samplesSinceAnchor: 0, pendingGap: this.session > 1,
    }
    processor.onaudioprocess = (event) => this.onAudio(device, event.inputBuffer.getChannelData(0))
    source.connect(processor)
    // ScriptProcessor 要接到 destination 才会跑；直连会把麦克风外放，挂一个什么都不输出的节点。
    mute.onaudioprocess = () => undefined
    processor.connect(mute)
    mute.connect(context.destination)
    for (const track of stream.getTracks()) {
      const listener = (): void => this.onTrackEnded(device)
      track.addEventListener('ended', listener)
      device.trackListeners.push({ track, listener })
    }
    if (this.offDeviceChange === null && this.deps.onDeviceChange) {
      this.offDeviceChange = this.deps.onDeviceChange(() => void this.onDeviceChange())
    }
    return device
  }

  private onAudio(device: Device, data: Float32Array): void {
    if (this.device !== device || data.length === 0) return
    const rate = device.context.sampleRate
    const durationMs = (data.length / rate) * 1000
    // 回调是在这批样本采完之后来的：第一帧时刻 ≈ 现在 − 本批时长。
    const observedStart = this.deps.now() - durationMs
    let gapBefore = device.pendingGap
    device.pendingGap = false
    if (device.anchorMs === null) {
      device.anchorMs = observedStart
      device.samplesSinceAnchor = 0
      device.firstFrameAtMs = observedStart
    } else {
      const expected = device.anchorMs + (device.samplesSinceAnchor / rate) * 1000
      if (Math.abs(observedStart - expected) > this.gapToleranceMs) {
        // 主线程卡顿丢了回调、设备暂停、休眠：从现在重新起算，中间是缺口。
        device.anchorMs = observedStart
        device.samplesSinceAnchor = 0
        gapBefore = true
      }
    }
    if (gapBefore) this.gaps++
    const atMs = device.anchorMs + (device.samplesSinceAnchor / rate) * 1000
    device.samplesSinceAnchor += data.length
    const samples = new Float32Array(data)
    const frame: CaptureFrame = {
      seq: this.nextSeq++, session: device.session, sampleRate: rate, samples, atMs, durationMs, gapBefore, rms: frameRms(samples),
    }
    this.framesTotal++
    if ([...this.subs.values()].some(sub => sub.preroll)) this.pushRing(frame)
    for (const sub of [...this.subs.values()]) {
      if (sub.receipt !== null) continue
      sub.frames++
      sub.lastSeq = frame.seq
      try {
        sub.onFrame(frame)
      } catch (error) {
        // 一个消费者出错只结束它自己；最后一个也走了的话设备照常释放。
        console.warn(`[audio-capture] ${sub.kind} 消费者出错，已退订：`, error)
        this.end(sub, 'consumer-error', error instanceof Error ? error.message : String(error))
      }
    }
  }

  private pushRing(frame: CaptureFrame): void {
    this.ring.push(frame)
    this.ringMs += frame.durationMs
    while (this.ring.length > 1 && this.ringMs - this.ring[0].durationMs >= this.prerollMaxMs) {
      this.ringMs -= this.ring.shift()!.durationMs
    }
  }

  private clearRing(): void {
    this.ring = []
    this.ringMs = 0
  }

  private onTrackEnded(device: Device): void {
    if (this.device !== device) return
    // 权限撤销 / 拔掉设备 / 系统把设备收走：所有订阅如实结束，设备立即释放（不等 linger）。
    for (const sub of [...this.subs.values()]) this.end(sub, 'track-ended')
    this.cancelLinger()
    this.teardown()
  }

  private async onDeviceChange(): Promise<void> {
    const device = this.device
    if (device === null || !this.deps.enumerateDevices) return
    let devices: DeviceInfoLike[]
    try {
      devices = (await this.deps.enumerateDevices()).filter(item => item.kind === 'audioinput')
    } catch {
      return
    }
    if (this.device !== device) return
    const stillThere = device.deviceId === null
      ? devices.length > 0
      : devices.some(item => item.deviceId === device.deviceId && (device.groupId === null || item.groupId === undefined || item.groupId === device.groupId))
    if (!stillThere) await this.restart('device-changed')
  }

  /** 重开设备，订阅保留；重开失败才结束全部订阅。 */
  private async restart(reason: 'device-changed' | 'resumed'): Promise<void> {
    if (this.restarting) return
    this.restarting = true
    try {
      this.teardownDeviceOnly()
      if (this.subs.size === 0) return
      try {
        await this.ensureOpen()
      } catch (error) {
        const failure = describeMediaError(error)
        for (const sub of [...this.subs.values()]) this.end(sub, reason, failure.message)
      }
    } finally {
      this.restarting = false
    }
  }

  private teardownDeviceOnly(): void {
    const device = this.device
    this.device = null
    if (device === null) return
    this.closes++
    device.processor.onaudioprocess = null
    try { device.processor.disconnect() } catch { /* 已断开 */ }
    try { device.mute.disconnect() } catch { /* 已断开 */ }
    try { device.source.disconnect?.() } catch { /* 已断开 */ }
    for (const { track, listener } of device.trackListeners) {
      try { track.removeEventListener?.('ended', listener) } catch { /* 忽略 */ }
      try { track.stop() } catch { /* 已停 */ }
    }
    void device.context.close().catch(() => undefined)
    this.clearRing()
  }

  private teardown(): void {
    this.teardownDeviceOnly()
    this.offDeviceChange?.()
    this.offDeviceChange = null
  }
}

// ── 浏览器里的单例 ──────────────────────────────────────────────────────

let shared: AudioCaptureService | null = null

export function browserCaptureDeps(): CaptureDeps {
  return {
    getUserMedia: (constraints) => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        return Promise.reject(new CaptureError('unavailable', '当前页面拿不到麦克风接口'))
      }
      return navigator.mediaDevices.getUserMedia(constraints as MediaStreamConstraints) as unknown as Promise<StreamLike>
    },
    createContext: () => new AudioContext() as unknown as ContextLike,
    now: () => performance.now(),
    enumerateDevices: () => navigator.mediaDevices.enumerateDevices() as unknown as Promise<DeviceInfoLike[]>,
    onDeviceChange: (listener) => {
      navigator.mediaDevices?.addEventListener?.('devicechange', listener)
      return () => navigator.mediaDevices?.removeEventListener?.('devicechange', listener)
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  }
}

export function sharedCapture(): AudioCaptureService {
  if (shared === null) shared = new AudioCaptureService(browserCaptureDeps())
  return shared
}

/** 帧时间（performance.now 时间轴）→ 墙钟毫秒。会议时间轴用它对齐主进程的开始时刻。 */
export function frameWallMs(frame: Pick<CaptureFrame, 'atMs'>): number {
  return performance.timeOrigin + frame.atMs
}
