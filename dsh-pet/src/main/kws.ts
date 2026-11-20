/**
 * 本地唤醒词检出（M1-02）：sherpa-onnx KeywordSpotter，吃渲染层共享采集送上来的 16k PCM。
 *
 * - macOS 上唯一的本地唤醒方案；Windows 上是可选项（默认仍是 System.Speech，见 `wake.ts`）。
 * - 解码跑在 worker 线程里：实测这个 3.3M 模型解码约占实时的 10%，放在主进程线程上
 *   等于每 100ms 卡一次 IPC 与窗口事件。线程随进程退出，**不产生任何子进程**，退出无残留。
 * - 模型缺失 / 加载失败 / 线程意外退出都经 onLost 报一次，不自动重试（仲裁器粘住
 *   `wakeUnavailable`，恢复入口是托盘"重新监听唤醒词"或设置页）。
 *
 * 唤醒词"小潘同学"按模型的建模单元（拼音声母 + 带调韵母）写成 keywords 文件，
 * 文件内容由这里的常量生成 —— 唤醒词只有这一处定义。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { pinyin } from 'pinyin-pro'
import type { KeywordSpotterConfig } from 'sherpa-onnx-node'
import { toUnpackedPath } from './runtime-launch.ts'
import { DEFAULT_WAKE_NAME } from './wake-name.ts'

/** 兼容旧调用：默认唤醒词。System.Speech 仍只认这个词；KWS 可以改名。 */
export const WAKE_KEYWORD = DEFAULT_WAKE_NAME

/**
 * keywords 文件的行：`<token 序列> [:boost] [#threshold] @<显示文本>`。
 * token 必须全部出现在模型的 tokens.txt 里（`missingKeywordTokens` 校验），否则 sherpa 会直接拒载。
 *
 * 这个模型的建模单元是**声母与韵母分开**的：没有 `tóng` 这种整体音节，要用 `t` + `óng` 拼。
 * 潘 = p + ān（阴平），同 = t + óng，学 = x + ué。只放一种读法：多放近音（盼 pàn / 盘 pán）
 * 会把"小盘子"一类日常说法也收进来。
 */
export const KWS_KEYWORD_LINES: readonly string[] = ['x iǎo p ān t óng x ué @小潘同学']

/**
 * 模型 tokens.txt 里的声母顺序：zh/ch/sh 必须排在 z/c/s 前面，
 * 否则 "zhāng" 会被拆成 z + hāng。
 */
const PINYIN_INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
  'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'] as const

/** 把中文唤醒词拆成模型要求的「声母 + 带调韵母」token。 */
export function wakeKeywordTokens(name: string): string[] {
  const syllables = pinyin(name, { toneType: 'symbol', type: 'array', multiple: false })
  const tokens: string[] = []
  for (const syllable of syllables) {
    const initial = PINYIN_INITIALS.find(item => syllable.startsWith(item))
    if (initial !== undefined && syllable.length > initial.length) {
      tokens.push(initial, syllable.slice(initial.length))
    } else {
      // 零声母（安 ān、儿 ér 等）：模型若没有这个 token，missingKeywordTokens 会如实报出来。
      tokens.push(syllable)
    }
  }
  return tokens
}

/** keywords 文件的一行：token 序列 + 显示文本。 */
export function wakeKeywordLines(name: string = DEFAULT_WAKE_NAME): readonly string[] {
  return [`${wakeKeywordTokens(name).join(' ')} @${name}`]
}

/** 检出阈值与加分。按 `petsBak/dsh-pet/m1-kws-bench` 的离线数据选定；改动要重跑那份数据。 */
export const KWS_THRESHOLD = 0.2
export const KWS_SCORE = 1.5

/** 同一次检出之后多久内不再报（同一句话可能被解码成两次命中）。 */
export const KWS_COOLDOWN_MS = 2000

export interface KwsModelPaths {
  readonly dir: string
  readonly encoder: string
  readonly decoder: string
  readonly joiner: string
  readonly tokens: string
  readonly keywords: string
}

export function kwsModelPaths(userDataDir: string): KwsModelPaths {
  const dir = path.join(userDataDir, 'local-asr', 'kws')
  return {
    dir,
    encoder: path.join(dir, 'encoder.int8.onnx'),
    decoder: path.join(dir, 'decoder.onnx'),
    joiner: path.join(dir, 'joiner.int8.onnx'),
    tokens: path.join(dir, 'tokens.txt'),
    keywords: path.join(dir, 'keywords-dsh.txt'),
  }
}

/** keywords 行里用到、但模型 tokens.txt 里没有的 token。 */
export function missingKeywordTokens(tokensText: string, lines: readonly string[] = KWS_KEYWORD_LINES): string[] {
  const known = new Set(tokensText.split(/\r?\n/).map(line => line.trim().split(/\s+/)[0]).filter(Boolean))
  const missing: string[] = []
  for (const line of lines) {
    const body = line.split('@')[0]
    for (const token of body.trim().split(/\s+/)) {
      if (token === '' || token.startsWith(':') || token.startsWith('#')) continue
      if (!known.has(token) && !missing.includes(token)) missing.push(token)
    }
  }
  return missing
}

/** 模型不可用的原因；可用返回 null。给用户看的话，不是错误码。 */
export function kwsModelProblem(userDataDir: string, name: string = DEFAULT_WAKE_NAME): string | null {
  const paths = kwsModelPaths(userDataDir)
  const absent = [paths.encoder, paths.decoder, paths.joiner, paths.tokens].filter(file => !existsSync(file))
  if (absent.length > 0) {
    return `本地唤醒模型没装（缺 ${absent.map(file => path.basename(file)).join('、')}）：运行 scripts/setup-local-asr 安装后在设置里重试`
  }
  try {
    const missing = missingKeywordTokens(readFileSync(paths.tokens, 'utf8'), wakeKeywordLines(name))
    if (missing.length > 0) {
      return `唤醒词「${name}」里有模型不支持的读音（${missing.join(' ')}），请换一个名字；模型本身不用重装`
    }
  } catch (error) {
    return `读不了唤醒模型：${error instanceof Error ? error.message : String(error)}`
  }
  return null
}

export function kwsSpotterConfig(paths: KwsModelPaths): KeywordSpotterConfig {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
      tokens: paths.tokens,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: KWS_SCORE,
    keywordsThreshold: KWS_THRESHOLD,
    keywordsFile: paths.keywords,
  }
}

/** 写 keywords 文件（内容由唤醒词生成；没变就不写）。这是配置，不是音频。 */
export function ensureKeywordsFile(paths: KwsModelPaths, name: string = DEFAULT_WAKE_NAME): void {
  const content = wakeKeywordLines(name).join('\n') + '\n'
  try {
    if (existsSync(paths.keywords) && readFileSync(paths.keywords, 'utf8') === content) return
  } catch { /* 读不了就重写 */ }
  writeFileSync(paths.keywords, content, 'utf8')
}

/**
 * Worker 源码（eval，CommonJS）。原生模块按主模块位置解析（与 diarize.ts 同一做法）：
 * 打包后是 dist/main，开发/测试时是 src/main，都能找到同一个 node_modules/sherpa-onnx-node。
 */
const WORKER_SOURCE = `
'use strict'
const { parentPort, workerData } = require('node:worker_threads')
let spotter = null
let stream = null
let extractor = null
let voiceprintError = null
let lastHit = -Infinity
let fedSamples = 0
const RING = 16000 * 3
const ring = new Float32Array(RING)
let ringLen = 0

function push(samples) {
  if (samples.length >= RING) {
    ring.set(samples.subarray(samples.length - RING))
    ringLen = RING
    return
  }
  const overflow = ringLen + samples.length - RING
  if (overflow > 0) {
    ring.copyWithin(0, overflow, ringLen)
    ringLen -= overflow
  }
  ring.set(samples, ringLen)
  ringLen += samples.length
}

function similarity(candidate, reference) {
  if (candidate.length !== reference.length || candidate.length === 0) return -1
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < candidate.length; i++) {
    dot += candidate[i] * reference[i]
    normA += candidate[i] * candidate[i]
    normB += reference[i] * reference[i]
  }
  return normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : -1
}

function verify(samples) {
  if (extractor === null) return -1
  const input = extractor.createStream()
  input.acceptWaveform({ sampleRate: 16000, samples })
  input.inputFinished()
  if (!extractor.isReady(input)) return -1
  const embedding = extractor.compute(input)
  let best = -1
  for (const reference of workerData.voiceprint.embeddings) {
    best = Math.max(best, similarity(embedding, reference))
  }
  return best
}

try {
  const sherpa = require('node:module').createRequire(workerData.base)('sherpa-onnx-node')
  const started = Date.now()
  spotter = new sherpa.KeywordSpotter(workerData.config)
  stream = spotter.createStream()
  if (workerData.voiceprint) {
    try {
      // 2 线程：实测 1.2–2.0 秒唤醒片段比单线程快约 30%，唤醒只在命中时跑一次。
      extractor = new sherpa.SpeakerEmbeddingExtractor({
        model: workerData.voiceprint.model, numThreads: 2, provider: 'cpu', debug: 0,
      })
    } catch (error) {
      voiceprintError = String((error && error.message) || error)
    }
  }
  parentPort.postMessage({ type: 'ready', loadMs: Date.now() - started, voiceprint: extractor !== null, voiceprintError })
} catch (error) {
  parentPort.postMessage({ type: 'error', stage: 'load', error: String((error && error.message) || error) })
}
parentPort.on('message', (msg) => {
  if (msg && msg.type === 'shutdown') { parentPort.close(); return }
  if (spotter === null || !msg || msg.type !== 'pcm') return
  try {
    push(msg.samples)
    stream.acceptWaveform({ sampleRate: 16000, samples: msg.samples })
    fedSamples += msg.samples.length
    while (spotter.isReady(stream)) {
      spotter.decode(stream)
      const result = spotter.getResult(stream)
      if (result && result.keyword) {
        spotter.reset(stream)
        const atMs = (fedSamples / 16000) * 1000
        if (atMs - lastHit >= workerData.cooldownMs) {
          lastHit = atMs
          if (!workerData.voiceprint) {
            parentPort.postMessage({ type: 'wake', keyword: result.keyword, atMs })
            continue
          }
          if (extractor === null) {
            parentPort.postMessage({ type: 'rejected', keyword: result.keyword, score: -1,
              reason: voiceprintError || '声纹模型加载失败' })
            continue
          }
          // 2.2 秒足够覆盖约 1 秒唤醒词 + KWS 的解码延迟；再长只是多算静音。
          const take = Math.min(ringLen, 16000 * 2.2)
          const score = verify(ring.slice(ringLen - take, ringLen))
          if (score >= workerData.voiceprint.threshold) {
            parentPort.postMessage({ type: 'wake', keyword: result.keyword, atMs, score })
          } else {
            parentPort.postMessage({ type: 'rejected', keyword: result.keyword, score })
          }
        }
      }
    }
  } catch (error) {
    parentPort.postMessage({ type: 'error', stage: 'decode', error: String((error && error.message) || error) })
  }
})
`

/**
 * worker 里用它做 `createRequire` 的解析基点，去 require `sherpa-onnx-node`。
 *
 * 打包后必须指向 app.asar.unpacked 里的真实文件：打包配置把 node_modules 整体解包到
 * `app.asar.unpacked/node_modules`，从 asar 内的路径往上找是找不到原生模块的。
 */
const MODULE_BASE = toUnpackedPath(fileURLToPath(import.meta.url))

/** worker 的最小面：测试里用假的。 */
export interface KwsWorkerLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void
  on(event: 'message', listener: (message: KwsWorkerMessage) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number> | void
}

export type KwsWorkerMessage =
  | { type: 'ready'; loadMs: number; voiceprint?: boolean; voiceprintError?: string | null }
  | { type: 'wake'; keyword: string; atMs: number; score?: number }
  | { type: 'rejected'; keyword: string; score: number; reason?: string }
  | { type: 'error'; stage: string; error: string }

export interface KwsSession {
  /** 喂一块 16k PCM。模型还在加载时先攒着（最多 2 秒，再多丢最旧的）。 */
  feed(pcm16k: Float32Array): void
  stop(): void
  readonly running: boolean
}

export interface KwsOptions {
  readonly userDataDir: string
  /** 用户自定义的唤醒词；省略用默认「小潘同学」。 */
  readonly keywordName?: string
  /**
   * 声纹验证。给出后，命中关键词还要和注册声纹比对；不通过只报 onRejected，不唤醒。
   * 模型与会议分人共用同一份本地 embedding 模型。
   */
  readonly voiceprint?: { readonly model: string; readonly embeddings: readonly (readonly number[])[]; readonly threshold: number }
  readonly onWake: (keyword: string) => void
  /** 关键词命中但声纹不通过。score 为 -1 表示没提取出有效声纹。 */
  readonly onRejected?: (score: number, reason?: string) => void
  /** 只报一次。之后会话自己停掉，不重试。 */
  readonly onLost: (reason: string) => void
  readonly onReady?: (loadMs: number) => void
  /** 测试注入。 */
  readonly createWorker?: (config: KeywordSpotterConfig) => KwsWorkerLike
}

const PENDING_LIMIT = 16000 * 2

export function startKws(options: KwsOptions): KwsSession {
  const paths = kwsModelPaths(options.userDataDir)
  let running = true
  let ready = false
  let pending: Float32Array[] = []
  let pendingSamples = 0
  let worker: KwsWorkerLike | null = null

  const lose = (reason: string): void => {
    if (!running) return
    stop()
    options.onLost(reason)
  }
  const stop = (): void => {
    if (!running) return
    running = false
    pending = []
    pendingSamples = 0
    const current = worker
    worker = null
    // 优雅退出：terminate 会强杀正在原生解码的线程，sherpa-onnx 在这种时机可能直接崩进程。
    // 先通知 worker 自己关（等当前这块解码完），3 秒还没退才兜底 terminate。
    if (current) {
      try { current.postMessage({ type: 'shutdown' }) } catch { /* 已退出 */ }
      const fallback = setTimeout(() => { try { void current.terminate() } catch { /* 已退出 */ } }, 3000)
      fallback.unref?.()
      current.on('exit', () => clearTimeout(fallback))
    }
  }

  try {
    ensureKeywordsFile(paths, options.keywordName ?? DEFAULT_WAKE_NAME)
    const config = kwsSpotterConfig(paths)
    worker = options.createWorker
      ? options.createWorker(config)
      : new Worker(WORKER_SOURCE, { eval: true, workerData: { base: MODULE_BASE, config, cooldownMs: KWS_COOLDOWN_MS,
        voiceprint: options.voiceprint ?? null } }) as unknown as KwsWorkerLike
  } catch (error) {
    // 同步失败也走回调：调用方（index.ts）在 start-wake 分派之前已经同步检查过模型文件，
    // 走到这里是罕见的写盘/建线程失败，延后一拍报，避免在 applyAudio 里同步重入。
    running = true
    queueMicrotask(() => lose(`本地唤醒启动失败：${error instanceof Error ? error.message : String(error)}`))
    return { feed: () => undefined, stop, get running() { return running } }
  }

  worker.on('message', (message: KwsWorkerMessage) => {
    if (!running) return
    if (message.type === 'ready') {
      // 开了声纹但模型加载不起来：宁可报不可用，也不能悄悄退回"谁喊都应"。
      if (message.voiceprintError) { lose(`声纹模型加载失败：${message.voiceprintError}`); return }
      ready = true
      options.onReady?.(message.loadMs)
      const queued = pending
      pending = []
      pendingSamples = 0
      for (const chunk of queued) worker?.postMessage({ type: 'pcm', samples: chunk }, [chunk.buffer as ArrayBuffer])
    } else if (message.type === 'wake') {
      options.onWake(message.keyword)
    } else if (message.type === 'rejected') {
      options.onRejected?.(message.score, message.reason)
    } else if (message.type === 'error') {
      lose(message.stage === 'load' ? `本地唤醒模型加载失败：${message.error}` : `本地唤醒解码失败：${message.error}`)
    }
  })
  worker.on('error', error => lose(`本地唤醒线程出错：${error.message}`))
  worker.on('exit', code => lose(`本地唤醒线程意外退出（${code}）`))

  return {
    feed(pcm16k: Float32Array): void {
      if (!running || worker === null || pcm16k.length === 0) return
      const copy = new Float32Array(pcm16k)
      if (!ready) {
        pending.push(copy)
        pendingSamples += copy.length
        while (pendingSamples > PENDING_LIMIT && pending.length > 1) pendingSamples -= pending.shift()!.length
        return
      }
      worker.postMessage({ type: 'pcm', samples: copy }, [copy.buffer as ArrayBuffer])
    },
    stop,
    get running() { return running },
  }
}
