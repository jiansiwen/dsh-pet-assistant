/**
 * 语音识别。两条路：
 *
 * 1. **流式（首选）**：sherpa-onnx 流式 Zipformer 中英模型（`local-asr/streaming`），
 *    边喂音频边出部分文本——「说一个字出一个字」靠它。识别器每次听写时创建，
 *    听写期间由渲染层逐帧送 PCM（base64 Int16）。
 * 2. **整句（回退）**：本地 SenseVoice（`local-asr/model`）说完整句再转；流式模型没装时用。
 *
 * **两条路都在进程内解码**（`sherpa-onnx-node` 的 Node API），**不 spawn 任何外部程序**。
 * 这一点是跨平台的关键：旧实现调 `sherpa-onnx-offline.exe`，而 Windows 的 `.exe` 在 macOS
 * 上根本不存在 —— 于是"识别"这件事在 Mac 上被一个文件名挡死了，尽管模型本身是跨平台的。
 * 换成 Node API 后，同一个模型目录在三个系统上都能用。
 *
 * 录音在渲染层完成（getUserMedia + 静音检测），PCM 经 base64 过 contextBridge 送上来。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import sherpa, { type OfflineRecognizerInstance } from 'sherpa-onnx-node'
import { toUnpackedPath } from './runtime-launch.ts'

export interface AsrResult {
  ok: boolean
  text?: string
  error?: string
}

const ERROR_MESSAGES: Record<string, string> = {
  'init-failed': '无法初始化语音识别：本地模型可能没装好，或麦克风不可用',
  'timeout-empty': '没有听到说话内容',
  'recognize-failed': '语音识别失败',
}

function mapError(code: string | undefined, fallback: string): string {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code]
  return fallback
}

/** 本地模型安装根目录（`scripts/setup-local-asr.ps1` 或 macOS 版脚本的落点）。 */
export function localAsrDir(userDataDir: string): string {
  return path.join(userDataDir, 'local-asr')
}

/**
 * 整句 SenseVoice 模型是否可用。
 *
 * 只看**模型文件**，不看可执行文件：解码走进程内 API，不需要任何 `.exe`。
 * 这是从 macOS 评估里改掉的一处 —— 旧判据要求 `bin/sherpa-onnx-offline.exe` 存在，
 * 于是 Mac 上哪怕模型齐了也永远判"不可用"，一路掉到 Windows 专有的兜底引擎。
 */
export function localAsrAvailable(userDataDir: string): boolean {
  const dir = path.join(localAsrDir(userDataDir), 'model')
  return (
    existsSync(path.join(dir, 'model.int8.onnx'))
    && existsSync(path.join(dir, 'tokens.txt'))
  )
}

/** 流式模型目录与可用性。 */
export function streamingAvailable(userDataDir: string): boolean {
  const dir = path.join(localAsrDir(userDataDir), 'streaming')
  return (
    existsSync(path.join(dir, 'tokens.txt'))
    && existsSync(path.join(dir, 'encoder.int8.onnx'))
    && existsSync(path.join(dir, 'decoder.int8.onnx'))
    && existsSync(path.join(dir, 'joiner.int8.onnx'))
  )
}

/** 一场流式听写：feed 逐块喂 PCM（16kHz Float32），返回当前累积文本；finalize 收尾取全文。 */
export interface StreamingSession {
  feed(pcm16k: Float32Array): string
  finalize(): string
}

/** 创建一场流式识别。模型加载约 1–2 秒，调用方（asr-begin）在录音开始前完成它。 */
export function createStreamingSession(userDataDir: string): StreamingSession {
  const dir = path.join(localAsrDir(userDataDir), 'streaming')
  const recognizer = new sherpa.OnlineRecognizer({
    modelConfig: {
      transducer: {
        encoder: path.join(dir, 'encoder.int8.onnx'),
        decoder: path.join(dir, 'decoder.int8.onnx'),
        joiner: path.join(dir, 'joiner.int8.onnx'),
      },
      tokens: path.join(dir, 'tokens.txt'),
      numThreads: 2,
    },
    decodingMethod: 'greedy_search',
  })
  const stream = recognizer.createStream()
  return {
    feed(pcm16k: Float32Array): string {
      stream.acceptWaveform({ sampleRate: 16000, samples: pcm16k })
      while (recognizer.isReady(stream)) recognizer.decode(stream)
      return recognizer.getResult(stream).text
    },
    finalize(): string {
      stream.inputFinished()
      while (recognizer.isReady(stream)) recognizer.decode(stream)
      return recognizer.getResult(stream).text
    },
  }
}

/** base64（Int16LE PCM）→ Float32（-1..1）。听写帧过 contextBridge 的形态。 */
export function pcm16Base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  const out = new Float32Array(Math.floor(buf.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768
  return out
}

/**
 * 裁掉 wav 头尾的静音（16bit/8bit mono），8bit 顺带转 16bit。
 *
 * 录音从按键那一刻开始，前后的环境噪声和沉默对识别器是噪声；按 100ms 帧算 RMS，
 * 头部第一次有声前、尾部最后一次有声后的内容都裁掉，中间完全不动。
 * 全是静音时返回空 Buffer，调用方据此保留原样交给识别器报"没听到"。
 *
 * 16bit mono 原样裁剪；8bit mono（MCI 录音的驱动默认格式）裁剪时同步转成 16bit——
 * 回退录音拿不到 16bit（bytespersample 参数被驱动拒绝），识别端只保证吃标准 16bit。
 * 其他位深/多声道不裁不转，交给识别器自己处理。
 */
export function trimSilence(
  wav: Buffer,
  options: { threshold?: number; frameMs?: number; padMs?: number } = {},
): Buffer {
  const threshold = options.threshold ?? 300
  const frameMs = options.frameMs ?? 100
  const padMs = options.padMs ?? 150

  const parsed = wavChunk(wav)
  if (parsed === null) return wav
  const data = parsed.data
  if (parsed.channels !== 1 || (parsed.bitsPerSample !== 16 && parsed.bitsPerSample !== 8)) return wav

  // 8bit 无符号（0-255，中心 128）在读出时转成 16bit 有符号刻度，输出也是 16bit。
  const to16 = (offset: number): number =>
    parsed.bitsPerSample === 16 ? data.readInt16LE(offset) : (data.readUInt8(offset) - 128) << 8
  const bytesPerSample = parsed.bitsPerSample / 8
  const frameBytes = Math.max(bytesPerSample, Math.floor((parsed.sampleRate * frameMs) / 1000 / bytesPerSample) * bytesPerSample)
  const frames = Math.floor(data.length / frameBytes)
  if (frames === 0) return wav

  const loud: boolean[] = []
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let offset = 0; offset < frameBytes; offset += bytesPerSample) {
      const sample = to16(i * frameBytes + offset)
      sum += sample * sample
    }
    const rms = Math.sqrt(sum / (frameBytes / bytesPerSample))
    loud.push(rms > threshold)
  }

  let first = loud.indexOf(true)
  let last = loud.lastIndexOf(true)
  if (first < 0) return Buffer.alloc(0)
  const padFrames = Math.max(1, Math.round((padMs / frameMs)))
  first = Math.max(0, first - padFrames)
  last = Math.min(frames - 1, last + padFrames)

  const startSample = first * (frameBytes / bytesPerSample)
  const endSample = Math.min(data.length / bytesPerSample, (last + 1) * (frameBytes / bytesPerSample))
  if (parsed.bitsPerSample === 16) {
    return wavCopyWithChunk(wav, data.subarray(startSample * 2, endSample * 2))
  }
  // 8bit → 16bit：重写 fmt 段的三个相关字段，data 段逐样本放大。
  const out16 = Buffer.alloc((endSample - startSample) * 2)
  for (let i = startSample; i < endSample; i++) out16.writeInt16LE(to16(i), (i - startSample) * 2)
  const header = Buffer.from(wav.subarray(0, 44))
  header.writeUInt16LE(16, 34)
  header.writeUInt16LE(2, 32)
  header.writeUInt32LE(parsed.sampleRate * 2, 28)
  header.writeUInt32LE(out16.length, 40)
  header.writeUInt32LE(44 - 8 + out16.length, 4)
  return Buffer.concat([header, out16])
}

/** data 块内容与格式。解析不动或不是 PCM 返回 null（交给识别器自己抱怨）。 */
function wavChunk(wav: Buffer): { data: Buffer; sampleRate: number; bitsPerSample: number; channels: number } | null {
  if (wav.length < 44) return null
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null
  if (wav.toString('ascii', 12, 16) !== 'fmt ') return null
  if (wav.readUInt16LE(20) !== 1) return null // 只认 PCM
  const sampleRate = wav.readUInt32LE(24)
  const bitsPerSample = wav.readUInt16LE(34)
  const channels = wav.readUInt16LE(22)
  let offset = 36
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') return { data: wav.subarray(offset + 8, Math.min(wav.length, offset + 8 + size)), sampleRate, bitsPerSample, channels }
    offset += 8 + size + (size % 2)
  }
  return null
}

function wavCopyWithChunk(wav: Buffer, pcm: Buffer): Buffer {
  const dataOffset = wav.indexOf('data', 12, 'ascii')
  if (dataOffset < 0) return wav
  const header = Buffer.from(wav.subarray(0, dataOffset + 8))
  header.writeUInt32LE(pcm.length, dataOffset + 4)
  header.writeUInt32LE(header.length - 8 + pcm.length, 4)
  return Buffer.concat([header, pcm])
}

function spawnText(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let stdout = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
    }, timeoutMs)
    timer.unref()
    child.on('error', () => resolve({ code: -1, stdout }))
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout })
    })
  })
}

/** SenseVoice 的输出可能带时间戳标记，清掉它们并去空白。 */
export function cleanSenseVoiceText(raw: string): string | null {
  // 时间戳标记形如 "| 1|" 或 "|1.00|"：成对竖线夹着空白与数字，替换成一个空格。
  const text = raw.replace(/\|[\s\d.]*\|/g, ' ').replace(/\|/g, ' ').trim()
  return text.length > 0 ? text : null
}

/**
 * 把 16bit PCM 重采样到 16kHz。
 *
 * SenseVoice 只吃 16kHz，而渲染层刻意**不指定**录音采样率（指定了与部分麦克风流组合时
 * `onaudioprocess` 可能永远不来，见 `dictation.ts` 的注释），拿到的往往是 44.1k/48k。
 * 用 sherpa 自带的线性重采样器，不自己写插值 —— 采样率换算写错只会让识别变差，
 * 不会报错，是最难发现的一类 bug。
 */
function resampleTo16k(samples: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === 16000) return samples
  const resampler = new sherpa.LinearResampler(sampleRate, 16000)
  return resampler.flush(samples)
}

/**
 * 进程内 SenseVoice 解码。
 *
 * 旧实现 spawn `sherpa-onnx-offline.exe` 并把 stdout 当 JSON 解析 —— 那条路在 macOS 上
 * 直接断掉（没有 `.exe`）。改成 Node API 后不再有任何外部进程，也不需要解析 stdout：
 * 结果对象直接就有 `text`。
 *
 * 引擎只在第一次调用时创建并缓存：模型加载约 1–2 秒，而听写是高频操作。
 * 缓存放在模块级而不是实例级 —— 转写链路是"一次一段"，没有自然的实例边界。
 */
let senseVoiceEngine: { recognizer: OfflineRecognizerInstance; dir: string } | null = null

function senseVoiceRecognizer(userDataDir: string): OfflineRecognizerInstance {
  const modelDir = path.join(localAsrDir(userDataDir), 'model')
  if (senseVoiceEngine !== null && senseVoiceEngine.dir === modelDir) return senseVoiceEngine.recognizer
  const recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      senseVoice: {
        model: path.join(modelDir, 'model.int8.onnx'),
        language: 'auto',
        useInverseTextNormalization: 1,
      },
      tokens: path.join(modelDir, 'tokens.txt'),
      numThreads: 2,
    },
    decodingMethod: 'greedy_search',
  })
  senseVoiceEngine = { recognizer, dir: modelDir }
  return recognizer
}

/** 测试之间清掉缓存：引擎持有原生句柄，跨测试复用会让"模型没装"这类用例假通过。 */
export function resetSenseVoiceEngine(): void {
  senseVoiceEngine = null
}

function transcribeWithSenseVoice(wav: Buffer, userDataDir: string): AsrResult {
  const parsed = wavChunk(wav)
  if (parsed === null) return { ok: false, error: '录音格式无法识别' }
  if (parsed.bitsPerSample !== 16) return { ok: false, error: '录音位深不是 16bit，无法识别' }
  // wav 的 data 段是 16bit LE；转成 Float32（-1..1）再喂识别器。
  const sampleCount = Math.floor(parsed.data.length / 2)
  const samples = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) samples[i] = parsed.data.readInt16LE(i * 2) / 32768

  let recognizer: OfflineRecognizerInstance
  try {
    recognizer = senseVoiceRecognizer(userDataDir)
  } catch (error) {
    return { ok: false, error: `本地识别模型加载失败：${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples: resampleTo16k(samples, parsed.sampleRate) })
    recognizer.decode(stream)
    const result = recognizer.getResult(stream)
    const text = typeof result.text === 'string' ? cleanSenseVoiceText(result.text) : null
    if (text === null) return { ok: false, error: ERROR_MESSAGES['timeout-empty'] }
    return { ok: true, text }
  } catch (error) {
    return { ok: false, error: `本地语音识别失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Windows 旧引擎兜底（`System.Speech`）。
 *
 * 只在**没装本地模型**时才走到这里，而且只在 Windows 上可用 —— 它是最后一道网，
 * 不是主路径。macOS 上没装模型就直接报"识别模型没装"，不假装有兜底。
 */
async function transcribeWithLegacyEngine(wavPath: string): Promise<AsrResult> {
  // PowerShell 读不了 asar：打包后必须走 app.asar.unpacked 里的真实文件（见 asarUnpack）。
  const scriptPath = toUnpackedPath(path.join(path.dirname(fileURLToPath(import.meta.url)), 'asr-wave.ps1'))
  const { code, stdout } = await spawnText(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Path', wavPath],
    60000,
  )
  if (code !== 0 && stdout.trim() === '') return { ok: false, error: '语音识别进程异常退出' }
  const lines = stdout.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i].trim()) as AsrResult
      if (typeof parsed.ok === 'boolean') {
        if (!parsed.ok) return { ok: false, error: mapError(parsed.error, '语音识别失败') }
        return parsed
      }
    } catch {
      // 非 JSON 行跳过
    }
  }
  return { ok: false, error: '语音识别无输出' }
}

/** Windows 旧引擎能否用。非 Windows 上没有它 —— 兜底那条路必须如实关闭。 */
export function legacyEngineAvailable(platform: string = process.platform): boolean {
  return platform === 'win32'
}

/**
 * 转写一段渲染层录好的 wav。识别期间不占麦克风：录音已结束，唤醒监听可以照常收音。
 */
export async function transcribeWav(wav: ArrayBuffer, userDataDir: string): Promise<AsrResult> {
  const buffer = Buffer.from(wav)
  const trimmed = trimSilence(buffer)
  const effective = trimmed.length > 0 ? trimmed : buffer
  // 本地模型那条路全程在内存里，不落临时文件 —— 少一次写盘、少一处清理。
  if (localAsrAvailable(userDataDir)) return transcribeWithSenseVoice(effective, userDataDir)
  // 没装模型时：Windows 还有系统自带的旧引擎，别的系统上就只能如实说没装。
  if (!legacyEngineAvailable()) {
    return { ok: false, error: '本机还没装语音识别模型，听写用不了（装好模型后即可离线识别）' }
  }
  const tmp = mkdtempSync(path.join(tmpdir(), 'dsh-asr-'))
  const wavPath = path.join(tmp, 'dictation.wav')
  try {
    writeFileSync(wavPath, effective)
    return await transcribeWithLegacyEngine(wavPath)
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 临时目录 */ }
  }
}
