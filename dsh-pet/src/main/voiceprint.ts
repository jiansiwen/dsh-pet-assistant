/**
 * 本人的声纹注册与验证。
 *
 * 只做"这是不是主人"这一件事，不建跨会议发言人库：
 * - 文件只存 embedding（不存原始录音），AES-256-GCM 加密，密钥沿用会议库的机器绑定密钥；
 * - 注册建议录 3 次唤醒词，至少成功 2 次才保存；
 * - 验证只输出一个余弦相似度，阈值由设置页决定。
 *
 * 隐私边界：embedding、录音、相似度都不上传；删除声纹就是删掉这个文件。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getDataKey, type DpapiResult } from './dpapi.ts'
import { diarizationModelPaths } from './diarize.ts'

const VOICEPRINT_VERSION = 1
const AAD = Buffer.from('voiceprint:v1')
/** 注册音频最短 0.4 秒、最长 8 秒；更短提取不出稳定声纹，更长多半混进了别的话。 */
const MIN_SAMPLES = 16000 * 0.4
const MAX_SAMPLES = 16000 * 8

export interface VoiceprintRecord {
  readonly version: 1
  /** 注册时的唤醒词，只用于界面显示。 */
  readonly name: string
  /** 每次注册录音提取的一条 embedding。 */
  readonly embeddings: readonly (readonly number[])[]
  /** 注册时用的 embedding 模型文件名；换模型后旧声纹不能继续比。 */
  readonly model?: string
  readonly createdAt: number
}

export interface VoiceprintStatus {
  readonly registered: boolean
  readonly count: number
  readonly createdAt: number | null
  /** 文件存在但解不开、格式不对时的原因；没有声纹时为 null。 */
  readonly problem: string | null
}

export function voiceprintPath(userDataDir: string): string {
  return path.join(userDataDir, 'voiceprint.json.enc')
}

type KeyResult = Pick<DpapiResult, 'status'> & { readonly key?: Buffer; readonly message?: string }

function keyOf(userDataDir: string, loadKey: () => KeyResult): Buffer {
  const result = loadKey()
  if (result.status !== 'ok' || result.key === undefined) {
    throw new Error(result.status === 'unsupported'
      ? '当前系统没有可用的本地密钥，无法保存声纹'
      : result.message ?? '声纹密钥不可用')
  }
  return result.key
}

function seal(key: Buffer, value: VoiceprintRecord): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return JSON.stringify({
    version: VOICEPRINT_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  })
}

function open(key: Buffer, raw: string): VoiceprintRecord {
  const envelope = JSON.parse(raw) as { version?: unknown; iv?: unknown; tag?: unknown; data?: unknown }
  if (envelope.version !== VOICEPRINT_VERSION || typeof envelope.iv !== 'string'
    || typeof envelope.tag !== 'string' || typeof envelope.data !== 'string') {
    throw new Error('声纹文件格式不对')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAAD(AAD)
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8')
  const record = JSON.parse(plain) as Partial<VoiceprintRecord>
  if (record.version !== VOICEPRINT_VERSION || typeof record.name !== 'string' || !Array.isArray(record.embeddings)
    || record.embeddings.length === 0) {
    throw new Error('声纹内容不完整')
  }
  const embeddings = record.embeddings.map(item => asVector(item))
  const first = embeddings[0]
  if (first === null || first === undefined || embeddings.some(item => item === null || item.length !== first.length)) {
    throw new Error('声纹内容不完整')
  }
  return {
    version: 1,
    name: record.name,
    embeddings: embeddings as number[][],
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
  }
}

function asVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const vector: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null
    vector.push(item)
  }
  return vector
}

/**
 * 读取并解密声纹。`loadKey` 默认用会议库的机器绑定密钥，测试可注入假密钥。
 * 文件不存在返回 null；损坏抛错，调用方据此把状态标成 problem 而不是"未注册"。
 */
export function loadVoiceprint(userDataDir: string, loadKey: () => KeyResult = () => getDataKey(userDataDir)): VoiceprintRecord | null {
  const file = voiceprintPath(userDataDir)
  if (!existsSync(file)) return null
  return open(keyOf(userDataDir, loadKey), readFileSync(file, 'utf8'))
}

export function saveVoiceprint(userDataDir: string, record: VoiceprintRecord, loadKey: () => KeyResult = () => getDataKey(userDataDir)): void {
  writeFileSync(voiceprintPath(userDataDir), seal(keyOf(userDataDir, loadKey), record), 'utf8')
}

export function clearVoiceprint(userDataDir: string): boolean {
  const file = voiceprintPath(userDataDir)
  if (!existsSync(file)) return false
  unlinkSync(file)
  return true
}

export function voiceprintStatus(userDataDir: string, loadKey?: () => KeyResult): VoiceprintStatus {
  try {
    const record = loadVoiceprint(userDataDir, loadKey)
    return record === null
      ? { registered: false, count: 0, createdAt: null, problem: null }
      : { registered: true, count: record.embeddings.length, createdAt: record.createdAt, problem: null }
  } catch (error) {
    return { registered: false, count: 0, createdAt: null,
      problem: `声纹文件读不出来：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 余弦相似度；任一向量为零向量时返回 0。 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}

/** 注册了多次就取最高分：某一次录音状态差不应该把本人挡在门外。 */
export function bestVoiceprintScore(embeddings: readonly (readonly number[])[], candidate: readonly number[]): number {
  let best = -1
  for (const embedding of embeddings) best = Math.max(best, cosineSimilarity(embedding, candidate))
  return best
}

/**
 * 从 WAV 里取 16k 单声道 Float32。
 *
 * 只接受 44 字节头或带扩展 fmt 的 PCM WAV；注册音频由渲染层的 `encodeWav` 生成，
 * 格式固定。遇到非 16k / 非 16bit / 多声道就拒绝，不做隐式重采样 —— 声纹对采样率很敏感。
 */
export function wavToSamples(wav: Buffer): Float32Array {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE'
    || wav.toString('ascii', 12, 16) !== 'fmt ') return new Float32Array(0)
  if (wav.readUInt16LE(20) !== 1) return new Float32Array(0)
  const channels = wav.readUInt16LE(22)
  const sampleRate = wav.readUInt32LE(24)
  const bitsPerSample = wav.readUInt16LE(34)
  if (channels !== 1 || sampleRate !== 16000 || bitsPerSample !== 16) return new Float32Array(0)
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') {
      const end = Math.min(wav.length, offset + 8 + size)
      const samples = new Float32Array(Math.floor((end - offset - 8) / 2))
      for (let i = 0; i < samples.length; i++) samples[i] = wav.readInt16LE(offset + 8 + i * 2) / 32768
      return samples
    }
    offset += 8 + size + (size % 2)
  }
  return new Float32Array(0)
}

/** 单段注册音频的长度限制；返回 null 表示合格。 */
export function voiceprintSampleProblem(samples: Float32Array): string | null {
  if (samples.length < MIN_SAMPLES) return '这段录音太短，请完整说一遍唤醒词'
  if (samples.length > MAX_SAMPLES) return '这段录音太长，请只说要唤醒词，说完停一下'
  return null
}

/** 默认的 embedding 模型：与会议分人共用同一份本地模型。 */
export function voiceprintModelPath(userDataDir: string): string {
  return diarizationModelPaths(userDataDir).embedding
}

/**
 * 声纹记录的模型标识：文件名 + 字节数。
 *
 * 落点文件名固定是 `embedding.onnx`，只记文件名分不出 ERes2Net base 和 V2；
 * 两者维度不一定相同，换了模型还拿旧声纹比对会静默全部拒绝。字节数足以区分。
 */
export function voiceprintModelTag(modelPath: string): string | null {
  try {
    return `${path.basename(modelPath)}:${statSync(modelPath).size}`
  } catch {
    return null
  }
}

export type EmbeddingExtractor = (samples: Float32Array, modelPath: string) => Promise<number[]>

/**
 * 用 sherpa 的 SpeakerEmbeddingExtractor 提取声纹。原生调用是同步的；
 * 注册是低频操作，放在 IPC handler 里同步跑一次可以接受。
 */
export const extractEmbedding: EmbeddingExtractor = async (samples, modelPath) => {
  const sherpa = (await import('sherpa-onnx-node')).default as unknown as {
    SpeakerEmbeddingExtractor: new (config: { model: string; numThreads?: number; provider?: string; debug?: number }) => {
      createStream(): { acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void }
      isReady(stream: unknown): boolean
      compute(stream: unknown): Float32Array
    }
  }
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 2, provider: 'cpu', debug: 0 })
  const stream = extractor.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  stream.inputFinished()
  if (!extractor.isReady(stream)) throw new Error('没有检测到有效的人声，请靠近麦克风重录')
  return Array.from(extractor.compute(stream))
}

export type VoiceprintEnrollResult =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly error: string }

/** 注册：逐段提取，至少 2 段成功才保存；失败原因保留下来给界面。 */
export async function enrollVoiceprint(input: {
  userDataDir: string
  name: string
  wavs: readonly Buffer[]
  modelPath?: string
  extract?: EmbeddingExtractor
  loadKey?: () => KeyResult
  now?: () => number
}): Promise<VoiceprintEnrollResult> {
  if (input.wavs.length < 2) return { ok: false, error: '至少需要 2 段注册录音' }
  const extract = input.extract ?? extractEmbedding
  const modelPath = input.modelPath ?? voiceprintModelPath(input.userDataDir)
  const embeddings: number[][] = []
  const problems: string[] = []
  for (const wav of input.wavs.slice(0, 5)) {
    const samples = wavToSamples(wav)
    const problem = voiceprintSampleProblem(samples)
    if (problem !== null) { problems.push(problem); continue }
    try {
      const embedding = await extract(samples, modelPath)
      if (asVector(embedding) === null) throw new Error('模型没有返回有效声纹')
      embeddings.push(embedding)
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (embeddings.length < 2) {
    return { ok: false, error: `注册失败：${problems[0] ?? '有效录音不足 2 段'}` }
  }
  const model = voiceprintModelTag(modelPath)
  saveVoiceprint(input.userDataDir, {
    version: 1,
    name: input.name,
    embeddings,
    ...(model === null ? {} : { model }),
    createdAt: (input.now ?? Date.now)(),
  }, input.loadKey)
  return { ok: true, count: embeddings.length }
}
