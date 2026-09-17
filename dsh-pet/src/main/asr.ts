/**
 * 语音识别。两条路：
 *
 * 1. **流式（首选）**：sherpa-onnx 流式 Zipformer 中英模型（`local-asr/streaming`），
 *    边喂音频边出部分文本——「说一个字出一个字」靠它。识别器每次听写时创建，
 *    听写期间由渲染层逐帧送 PCM（base64 Int16）。
 * 2. **整句（回退）**：本地 SenseVoice（`local-asr`）说完整句再转；流式模型没装时用。
 *    两条都不可用时最后回退 Windows 旧引擎（asr-wave.ps1）。
 *
 * 录音在渲染层完成（getUserMedia + 静音检测），PCM 经 base64 过 contextBridge 送上来。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import sherpa from 'sherpa-onnx-node'

export interface AsrResult {
  ok: boolean
  text?: string
  error?: string
}

const TIMEOUT_MS = 60000

const ERROR_MESSAGES: Record<string, string> = {
  'init-failed': '无法初始化语音识别：请确认麦克风可用，并在 Windows 设置中安装中文语音包',
  'grammar-failed': '当前语音识别器不支持听写，请安装完整的中文语音功能',
  'timeout-empty': '没有听到说话内容',
  'recognize-failed': '语音识别失败',
}

function mapError(code: string | undefined, fallback: string): string {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code]
  return fallback
}

/** 本地模型安装根目录（setup-local-asr.ps1 的落点）。 */
export function localAsrDir(userDataDir: string): string {
  return path.join(userDataDir, 'local-asr')
}

export function localAsrAvailable(userDataDir: string): boolean {
  const dir = localAsrDir(userDataDir)
  return (
    existsSync(path.join(dir, 'bin', 'sherpa-onnx-offline.exe'))
    && existsSync(path.join(dir, 'model', 'model.int8.onnx'))
    && existsSync(path.join(dir, 'model', 'tokens.txt'))
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

/** SenseVoice 的 stdout：v1.13+ 是一行 JSON（{"text":...}），旧版是 "Text: ..." 行。两种都认。 */
export function parseSenseVoiceText(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as { text?: unknown }
      if (typeof parsed.text === 'string') {
        const text = cleanSenseVoiceText(parsed.text)
        if (text) return text
      }
    } catch {
      // 非 JSON 行，走下面的正则
    }
  }
  const match = /Text:\s*(.+)/.exec(stdout)
  return match ? cleanSenseVoiceText(match[1]) : null
}

function cleanSenseVoiceText(raw: string): string | null {
  // 时间戳标记形如 "| 1|" 或 "|1.00|"：成对竖线夹着空白与数字，替换成一个空格。
  const text = raw.replace(/\|[\s\d.]*\|/g, ' ').replace(/\|/g, ' ').trim()
  return text.length > 0 ? text : null
}

async function transcribeWithSenseVoice(wavPath: string, userDataDir: string): Promise<AsrResult> {
  const dir = localAsrDir(userDataDir)
  const { code, stdout } = await spawnText(
    path.join(dir, 'bin', 'sherpa-onnx-offline.exe'),
    [
      '--tokens=' + path.join(dir, 'model', 'tokens.txt'),
      '--sense-voice-model=' + path.join(dir, 'model', 'model.int8.onnx'),
      wavPath,
    ],
    TIMEOUT_MS,
  )
  if (code !== 0) return { ok: false, error: '本地语音识别失败（SenseVoice 运行异常）' }
  const text = parseSenseVoiceText(stdout)
  if (text === null) return { ok: false, error: ERROR_MESSAGES['timeout-empty'] }
  return { ok: true, text }
}

async function transcribeWithLegacyEngine(wavPath: string): Promise<AsrResult> {
  const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'asr-wave.ps1')
  const { code, stdout } = await spawnText(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Path', wavPath],
    TIMEOUT_MS,
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

/**
 * 转写一段渲染层录好的 wav。识别期间不占麦克风：录音已结束，唤醒监听可以照常收音。
 */
export async function transcribeWav(wav: ArrayBuffer, userDataDir: string): Promise<AsrResult> {
  const buffer = Buffer.from(wav)
  const trimmed = trimSilence(buffer)
  const tmp = mkdtempSync(path.join(tmpdir(), 'dsh-asr-'))
  const wavPath = path.join(tmp, 'dictation.wav')
  try {
    writeFileSync(wavPath, trimmed.length > 0 ? trimmed : buffer)
    if (localAsrAvailable(userDataDir)) return await transcribeWithSenseVoice(wavPath, userDataDir)
    return await transcribeWithLegacyEngine(wavPath)
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 临时目录 */ }
  }
}
