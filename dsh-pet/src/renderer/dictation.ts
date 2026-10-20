/**
 * 听写录音（渲染层）：订阅共享采集（`audio-capture.ts`），静音检测自动停，编码成 wav 给主进程。
 *
 * 录音放渲染层而不是 PowerShell 的原因：浏览器拿得到真实电平，能"说完即停"；MCI 录音
 * 只能录满固定窗口，用户说完还得干等。麦克风仲裁（停唤醒监听）仍由主进程在 asr-begin
 * 时完成，并经 audio-grants 把"听写"授权下发给共享采集；这里拿到的设备是受控的唯一来源。
 *
 * VAD 参数刻意保守：宁可多录一点（识别前主进程还会裁静音），不可把话头切掉。
 */
import { sharedCapture, type AudioCaptureService, type CaptureFrame, type CaptureReceipt, type CaptureSubscription } from './audio-capture.ts'

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

/** 噪声基线的采样时长：前 0.7 秒（带自动增益的流底噪要几百毫秒才稳定）。按时长而不是帧数，帧大小变了也不漂。 */
export const BASELINE_MS = 700

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
 * 插话交接：插话检测（`barge-in.ts`）检出用户开口后，把检出点之前的预滚动音频和交接期间的
 * 实时帧一起交给听写，用户的话头不丢。`baselineRms` 是检测器在播放期间量到的残余底噪 ——
 * 交接来的音频一开头就是人声，不能再拿开头 0.7 秒当噪声基线。
 */
export interface DictationHandover {
  readonly frames: readonly CaptureFrame[]
  readonly baselineRms: number
  /** 检测器检出时用的阈值：交接后的"说完了"判定沿用它（不低于按基线算的听写阈值）。 */
  readonly threshold?: number
}

/**
 * 录一段听写。返回 wav；完全没录到内容返回 wav=null。
 * 任何失败都以 error 收场，**绝不挂起**——调用方靠这一点保证麦克风图标一定会灭。
 *
 * 交互：点按钮**立即开始录**（开口与否不决定能不能录，只决定说完要不要自动停）；
 * 说完静音 END_SILENCE_MS 自动停；**再点一下红点手动停**（已录内容照常转写）；
 * 20 秒上限兜底。就算声音判定完全失灵，点两下也能完成一次听写。
 *
 * 设备来自共享采集服务（`audio-capture.ts`）：这里只是"听写"这个消费者，订阅需要主进程在
 * asr-begin 时下发的授权；录到的音频只在内存里，编码成 wav 交给主进程识别后即丢弃。
 */
export interface RecordOptions {
  /** 测试注入；缺省用渲染层单例。 */
  capture?: AudioCaptureService
  /**
   * 流式喂数回调：每帧音频重采样到 16kHz 后调用（含开头的基线段——流式识别器
   * 自己消化静音）。给出它，听写期间模型就能边收边出字。
   */
  onChunk?: (pcm16k: Float32Array) => void
  /** 插话交接：在订阅建立之后调用，取走检测器手里的帧（含预滚动）。 */
  takeHandover?: () => DictationHandover | null
  /**
   * 第一次判到"有人在说话"时回调一次。
   *
   * 连续对话拿它来撤掉"多久没开口就关麦"的计时：静默窗量的是用户开口前的等待，
   * 一开口就该交给这句本身说完 —— 否则用户说到一半会被静默超时掐掉。
   */
  onSpeechStart?: () => void
  /** 等授权到达的上限。 */
  grantTimeoutMs?: number
  /** 测试注入的墙钟（兜底超时用）。 */
  now?: () => number
}

export async function recordDictation(options: RecordOptions = {}): Promise<DictationResult> {
  const capture = options.capture ?? sharedCapture()
  const now = options.now ?? (() => Date.now())
  if (!await capture.waitForGrant('dictation', options.grantTimeoutMs ?? 1500)) {
    console.error('[dictation] capture grant missing')
    return { wav: null, error: '麦克风没有授权给听写，请再试一次' }
  }

  const samples: Float32Array[] = []
  let totalFrames = 0
  let sampleRate = 0
  /** 点按钮即开始录：开口与否不再决定"能不能录"，只决定"说完要不要自动停"。 */
  let hasSpoken = false
  let silenceMs = 0
  let elapsedMs = 0
  let finished = false
  let endedBy: CaptureReceipt | null = null
  const baselineSamples: number[] = []
  let baselineMs = 0
  let threshold = 0
  /** 交接帧的最后一个序号：订阅自己收到的实时帧里 ≤ 它的是重复，跳过。 */
  let handoverSeq = -1
  let takenOver = false
  const live: CaptureFrame[] = []

  const process = (frame: CaptureFrame): void => {
    if (finished) return
    if (sampleRate === 0) sampleRate = frame.sampleRate
    if (frame.sampleRate !== sampleRate) {
      // 设备中途换了采样率（切了设备）：已录的照常交出去，后面的不混进同一个 wav。
      finished = true
      return
    }
    const chunk = frame.samples
    elapsedMs += frame.durationMs
    // 流式喂数在一切判定之前：识别器要的是完整时间轴，静音也照喂。
    options.onChunk?.(resampleTo16k(chunk, sampleRate))
    const rms = frame.rms
    // 前 0.7 秒量噪声基线（带自动增益的流底噪要几百毫秒才稳定），阈值供静音判定用。
    // 判定失灵的代价只是"不会自动停"（点一下红点手动停兜底），绝不会再卡住录音。
    if (threshold === 0 && baselineMs < BASELINE_MS) {
      baselineSamples.push(rms)
      baselineMs += frame.durationMs
      if (baselineMs >= BASELINE_MS) threshold = speechThreshold(noiseBaseline(baselineSamples))
    }
    samples.push(chunk)
    totalFrames += chunk.length
    if (rms >= threshold && threshold > 0 && !hasSpoken) {
      hasSpoken = true
      options.onSpeechStart?.()
    }
    if (hasSpoken) {
      if (rms < threshold) {
        silenceMs += frame.durationMs
        if (silenceMs >= END_SILENCE_MS) finished = true
      } else {
        silenceMs = 0
      }
    }
    if (elapsedMs >= MAX_DURATION_MS) finished = true
  }

  let subscription: CaptureSubscription
  try {
    subscription = await capture.subscribe({
      kind: 'dictation',
      onFrame: (frame) => {
        if (!takenOver && options.takeHandover) {
          // 交接还没取走时先攒着，取走后按序号去重再处理。
          live.push(frame)
          return
        }
        if (frame.seq <= handoverSeq) return
        process(frame)
      },
      onEnd: (receipt) => {
        if (receipt.reason !== 'unsubscribed') {
          endedBy = receipt
          finished = true
        }
      },
    })
  } catch (error) {
    // 失败文本进 console：这条链路的故障在界面上只有一句 toast，没有日志就永远查不了。
    console.error('[dictation] capture subscribe failed:', error)
    return { wav: null, error: error instanceof Error ? error.message : String(error) }
  }

  if (options.takeHandover) {
    const handover = options.takeHandover()
    takenOver = true
    if (handover !== null && handover.frames.length > 0) {
      // 交接来的开头就是人声：直接用检测器量到的播放期残余做基线，并认定已经开口。
      threshold = Math.max(speechThreshold(Math.max(handover.baselineRms, 0)), handover.threshold ?? 0)
      hasSpoken = true
      for (const frame of handover.frames) {
        process(frame)
        handoverSeq = Math.max(handoverSeq, frame.seq)
      }
    }
    for (const frame of live.splice(0)) if (frame.seq > handoverSeq) process(frame)
  }

  // 点一下红点 = 手动停止：立即收尾，已录到的话照样送转写。同一时刻至多一场录音。
  activeStop = () => {
    finished = true
  }

  try {
    return await new Promise<DictationResult>((resolve) => {
      const startedAt = now()
      const check = (): void => {
        // 音频回调可能整体不来（设备挂起等）。兜底判据不看回调，只看墙钟：
        // 超过硬上限强制收——交互上点两下总能完成一次听写，不存在永久卡住的路径。
        if (!finished && now() - startedAt >= MAX_DURATION_MS + 3000) finished = true
        if (!finished) {
          setTimeout(check, 50)
          return
        }
        subscription.close()
        activeStop = null
        if (totalFrames === 0) {
          const ended = endedBy as CaptureReceipt | null
          resolve({ wav: null, error: ended !== null ? describeEnd(ended) : undefined })
          return
        }
        const merged = new Float32Array(totalFrames)
        let offset = 0
        for (const chunk of samples) {
          merged.set(chunk, offset)
          offset += chunk.length
        }
        resolve({ wav: encodeWav(merged, sampleRate) })
      }
      setTimeout(check, 50)
    })
  } catch (error) {
    console.error('[dictation] recording loop failed:', error)
    subscription.close()
    activeStop = null
    return { wav: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 订阅被外部结束时给用户看的话。 */
function describeEnd(receipt: CaptureReceipt): string {
  switch (receipt.reason) {
    case 'track-ended': return '麦克风中途断开了（权限被撤销或设备被拔出）'
    case 'device-changed': return receipt.detail ?? '麦克风设备切换后没能重新打开'
    case 'resumed': return receipt.detail ?? '休眠恢复后麦克风没能重新打开'
    case 'revoked': return '麦克风授权已收回'
    case 'consumer-error': return '听写处理出错，请再试一次'
    default: return receipt.detail ?? '录音中断了'
  }
}
