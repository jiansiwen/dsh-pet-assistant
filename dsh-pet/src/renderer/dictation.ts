/**
 * 听写录音（渲染层）：getUserMedia 采 16kHz mono，静音检测自动停，编码成 wav 给主进程。
 *
 * 录音放渲染层而不是 PowerShell 的原因：浏览器拿得到真实电平，能"说完即停"；MCI 录音
 * 只能录满固定窗口，用户说完还得干等。麦克风仲裁（停唤醒监听）仍由主进程在 asr-begin
 * 时完成，这里拿到的设备是空闲的。
 *
 * VAD 参数刻意保守：宁可多录一点（识别前主进程还会裁静音），不可把话头切掉。
 */

/**
 * 有声判定阈值：不能是固定值。麦克风流带自动增益，底噪电平因设备差着一个数量级
 * （实测这台机器的背景 RMS 就有 0.013），固定阈值要么吞掉说话、要么被噪声击穿。
 * 开头先量一小段噪声基线，阈值取基线的倍数，再配一个绝对下限兜底极安静的房间。
 */

/** 自适应开口阈值：噪声基线的 2.5 倍，但至少 0.005（极安静房间的保险丝）。 */
export function speechThreshold(baselineRms: number): number {
  return Math.max(baselineRms * 2.5, 0.005)
}

/** 采样噪声基线的帧数（≈0.7 秒），供静音判定的自适应阈值用。 */
export const BASELINE_FRAMES = 10

/** 说完之后的收尾静音：短于它的停顿不当成说完。 */
export const END_SILENCE_MS = 700

/** 单次听写上限，防失控录音。 */
export const MAX_DURATION_MS = 20000

/** 逐帧 RMS（线性幅度），给 VAD 与测试用。 */
export function frameRms(chunk: Float32Array): number {
  let sum = 0
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i]
  return Math.sqrt(sum / Math.max(1, chunk.length))
}

/** 一组帧的噪声基线：取中位数而不是均值——偶发的敲门声不该抬高阈值。 */
export function noiseBaseline(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * 重采样到 16kHz（流式识别器的输入要求）。
 * 降采样前先过一阶低通（截止 ≈7kHz）：48k→16k 直接线性插值会把 8k 以上频段
 * 混叠进语音频段，识别率暴跌——这是流式上线后"只出几个字"的元凶之一。
 */
export function resampleTo16k(samples: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === 16000) return samples
  const filtered = lowPass(samples, sourceRate, 7000)
  const outLength = Math.max(1, Math.floor((filtered.length * 16000) / sourceRate))
  const out = new Float32Array(outLength)
  const step = sourceRate / 16000
  for (let i = 0; i < outLength; i++) {
    const pos = i * step
    const i0 = Math.floor(pos)
    const frac = pos - i0
    const s0 = filtered[i0]
    const s1 = filtered[Math.min(i0 + 1, filtered.length - 1)]
    out[i] = s0 + (s1 - s0) * frac
  }
  return out
}

/** 一阶 IIR 低通：y[n] = y[n-1] + α(x[n] − y[n-1])。每帧重建滤波器状态（帧间独立）。 */
function lowPass(samples: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  const dt = 1 / sampleRate
  const rc = 1 / (2 * Math.PI * cutoffHz)
  const alpha = dt / (dt + rc)
  const out = new Float32Array(samples.length)
  let prev = samples.length > 0 ? samples[0] : 0
  out[0] = prev
  for (let i = 1; i < samples.length; i++) {
    prev += alpha * (samples[i] - prev)
    out[i] = prev
  }
  return out
}

/** Float32（-1..1）→ Int16LE PCM 的 base64。听写帧过 contextBridge 的形态。 */
export function pcm16Base64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  const bytes = new Uint8Array(pcm.buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Float32 采样编码成 16bit PCM mono wav。 */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }
  return buffer
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

export interface DictationResult {
  readonly wav: ArrayBuffer | null
  readonly error?: string
}

interface AudioCtor {
  new (options?: { sampleRate?: number }): AudioContextLike
}

interface AudioContextLike {
  sampleRate: number
  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNodeLike
  createScriptProcessor(bufferSize: number, inputs: number, outputs: number): ScriptProcessorLike
  readonly destination: unknown
  close(): Promise<void>
}

interface MediaStreamAudioSourceNodeLike {
  connect(node: unknown): void
}

interface ScriptProcessorLike {
  connect(node: unknown): void
  disconnect(): void
  onaudioprocess: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null
}

export interface MediaDeps {
  getUserMedia(constraints: { audio: MediaTrackConstraints }): Promise<MediaStream>
  AudioContext: AudioCtor
}

const defaultDeps = (): MediaDeps => ({
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  AudioContext: window.AudioContext as AudioCtor,
})

/** 进行中那场录音的停止钩子；null 表示没有录音在进行。 */
let activeStop: (() => void) | null = null

/** 手动停止当前录音（已录到的话照常送转写）。没有录音在进行时什么都不做。 */
export function stopDictation(): void {
  activeStop?.()
  activeStop = null
}

/**
 * ArrayBuffer → base64。**必须在渲染层调用侧转**：wav 以 ArrayBuffer 为参数调
 * petApi 时，跨 contextBridge 的参数拷贝在进入 preload 函数体之前就发生，
 * ArrayBuffer 在这一步就会抛 Illegal invocation——preload 里再转是来不及的。
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * 录一段听写。返回 wav；完全没录到内容返回 wav=null。
 * 任何失败都以 error 收场，**绝不挂起**——调用方靠这一点保证麦克风图标一定会灭。
 *
 * 交互：点按钮**立即开始录**（开口与否不决定能不能录，只决定说完要不要自动停）；
 * 说完静音 END_SILENCE_MS 自动停；**再点一下红点手动停**（已录内容照常转写）；
 * 20 秒上限兜底。就算声音判定完全失灵，点两下也能完成一次听写。
 */
export interface RecordOptions {
  deps?: MediaDeps
  /**
   * 流式喂数回调：每帧音频重采样到 16kHz 后调用（含开头的基线段——流式识别器
   * 自己消化静音）。给出它，听写期间模型就能边收边出字。
   */
  onChunk?: (pcm16k: Float32Array) => void
}

export async function recordDictation(options: RecordOptions = {}): Promise<DictationResult> {
  const deps = options.deps ?? defaultDeps()
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    console.error('[dictation] mediaDevices unavailable in this page')
    return { wav: null, error: '当前页面拿不到麦克风接口' }
  }

  let stream: MediaStream
  let context: AudioContextLike
  let source: MediaStreamAudioSourceNodeLike
  let processor: ScriptProcessorLike
  let mute: ScriptProcessorLike
  try {
    stream = await deps.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    // 不强制采样率：指定 sampleRate 与部分麦克风流组合时 onaudioprocess 可能永远不来
    //（Chromium 已知问题），用设备默认采样率，编码时如实写进 wav 头即可。
    context = new deps.AudioContext()
    source = context.createMediaStreamSource(stream)
    processor = context.createScriptProcessor(4096, 1, 1)
    mute = context.createScriptProcessor(256, 1, 1)
  } catch (error) {
    // 失败文本进 console：这条链路的故障在界面上只有一句 toast，没有日志就永远查不了。
    console.error('[dictation] media setup failed:', error)
    return { wav: null, error: '无法访问麦克风：' + describeMediaError(error) }
  }

  const samples: Float32Array[] = []
  let totalFrames = 0
  /** 点按钮即开始录：开口与否不再决定"能不能录"，只决定"说完要不要自动停"。 */
  let hasSpoken = false
  let silenceMs = 0
  let elapsedMs = 0
  let finished = false
  const baselineSamples: number[] = []
  let threshold = 0

  processor.onaudioprocess = (event) => {
    if (finished) return
    const chunk = event.inputBuffer.getChannelData(0)
    elapsedMs += (chunk.length / context.sampleRate) * 1000
    // 流式喂数在一切判定之前：识别器要的是完整时间轴，静音也照喂。
    options.onChunk?.(resampleTo16k(chunk, context.sampleRate))
    const rms = frameRms(chunk)
    // 前 0.7 秒量噪声基线（带自动增益的流底噪要几百毫秒才稳定），阈值供静音判定用。
    // 判定失灵的代价只是"不会自动停"（点一下红点手动停兜底），绝不会再卡住录音。
    if (baselineSamples.length < BASELINE_FRAMES) {
      baselineSamples.push(rms)
      if (baselineSamples.length >= BASELINE_FRAMES) threshold = speechThreshold(noiseBaseline(baselineSamples))
    }
    samples.push(new Float32Array(chunk))
    totalFrames += chunk.length
    if (rms >= threshold && threshold > 0) hasSpoken = true
    if (hasSpoken) {
      if (rms < threshold) {
        silenceMs += (chunk.length / context.sampleRate) * 1000
        if (silenceMs >= END_SILENCE_MS) finished = true
      } else {
        silenceMs = 0
      }
    }
    if (elapsedMs >= MAX_DURATION_MS) finished = true
  }

  source.connect(processor)
  // ScriptProcessor 需要 connect 到 destination 才会跑；直连会外放，挂一个静音节点。
  mute.onaudioprocess = () => undefined
  processor.connect(mute)
  mute.connect(context.destination)

  const cleanup = (): void => {
    try { processor.disconnect() } catch { /* 已断开 */ }
    try { mute.disconnect() } catch { /* 已断开 */ }
    for (const track of stream.getTracks()) track.stop()
    void context.close().catch(() => undefined)
  }

  // 点一下红点 = 手动停止：立即收尾，已录到的话照样送转写。同一时刻至多一场录音。
  activeStop = () => {
    finished = true
  }

  try {
    return await new Promise<DictationResult>((resolve) => {
      const startedAt = Date.now()
      const check = (): void => {
        // 音频回调可能整体不来（设备挂起等）。兜底判据不看回调，只看墙钟：
        // 超过硬上限强制收——交互上点两下总能完成一次听写，不存在永久卡住的路径。
        if (!finished && Date.now() - startedAt >= MAX_DURATION_MS + 3000) finished = true
        if (!finished) {
          setTimeout(check, 50)
          return
        }
        cleanup()
        activeStop = null
        if (totalFrames === 0) {
          resolve({ wav: null, error: undefined })
          return
        }
        const merged = new Float32Array(totalFrames)
        let offset = 0
        for (const chunk of samples) {
          merged.set(chunk, offset)
          offset += chunk.length
        }
        resolve({ wav: encodeWav(merged, context.sampleRate) })
      }
      setTimeout(check, 50)
    })
  } catch (error) {
    console.error('[dictation] recording loop failed:', error)
    cleanup()
    return { wav: null, error: describeMediaError(error) }
  }
}

function describeMediaError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (/NotAllowedError|Permission/i.test(message)) return '麦克风权限被拒绝，请在系统设置里允许'
  if (/NotFoundError|DevicesNotFound/i.test(message)) return '没有找到可用的麦克风'
  return message
}
