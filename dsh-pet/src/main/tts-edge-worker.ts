/**
 * TTS worker：edge-tts 合成 + 本地播放 + 断网回退，stdin/stdout 协议与旧 tts.ps1 完全一致。
 *
 * Narrator（tts.ts）不需要知道合成器换掉了：它照旧一次派一句（speak/stop/exit），
 * 这里照旧回报 started/finished/cancelled。协议不变的原因是播放与打断的次序约束
 * 全部由 Narrator 那边的状态机把守，两边失步的代价是丢句子。
 *
 * 链路：文本 → edge-tts（微软神经语音，免费无需密钥）→ mp3 → play.ps1（MCI 阻塞播放）。
 * 合成失败（断网 / 服务不可达）→ speak-once.ps1（System.Speech 本地合成并播放），
 * 那一刻音色退回机械声，但话不会被吞掉 —— 断网时朗读依然可用。
 *
 * 由 main bundle spawn，ELECTRON_RUN_AS_NODE=1 时 electron.exe 就是纯 node。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DEFAULT_TTS_VOICE, synthesizeSpeech } from './edge-tts.ts'
import { synthesizeApi } from './voice-api.ts'
import { playAudioSpec, platformOf, speakOfflineSpec, type CommandSpec, type SupportedPlatform } from './platform.ts'
import type { ResolvedVoiceApi } from '../voice-api-types.ts'

export type WorkerEvent =
  | { readonly ready: true; readonly voice: string }
  | { readonly started: { readonly id: string } }
  | { readonly finished: { readonly id: string; readonly text?: string; readonly audio?: string } }
  | { readonly cancelled: { readonly id: string } }
  | { readonly ok: false; readonly error: string }

interface SpeakDeps {
  /** 合成一句 → mp3 字节。抛错视为合成失败，走回退。 */
  synthesize(text: string, signal: AbortSignal, api?: ResolvedVoiceApi): Promise<Buffer>
  /** 播放 mp3，播完回调 completed=true；被 stop 杀掉回调 completed=false。 */
  play(mp3: Buffer, onDone: (completed: boolean) => void): void
  /** 离线回退：本地合成并播放，回调语义同 play。 */
  fallback(text: string, onDone: (completed: boolean) => void): void
  /** 掐掉正在出声的子进程。 */
  stopAudio(): void
  emit(event: WorkerEvent): void
  /**
   * 只合成模式（"外放插话"实验开关，M1-05）：合成好的音频交出去由渲染层播放，这里不播。
   * 给出它时：派发时不报 started（渲染层实际开始时由主进程报），交出音频即结算这一句；
   * 离线回退仍在本地播放并照常报 started / finished。缺省（undefined）就是原有的本地播放路径。
   */
  handoff?(id: string, audio: Buffer): void
}

/** 合成进程交给渲染层的那一句音频。 */
export type SynthOnlyWorkerEvent = WorkerEvent | { readonly audio: { readonly id: string; readonly b64: string; readonly mime: string } }

/** 音频字节 → MIME。渲染层 decodeAudioData 不需要它，只给日志和诊断看。 */
export function sniffAudioMime(audio: Buffer): string {
  if (audio.length >= 4 && audio.toString('ascii', 0, 4) === 'RIFF') return 'audio/wav'
  if (audio.length >= 4 && audio.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg'
  if (audio.length >= 3 && audio.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg'
  if (audio.length >= 2 && audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  return 'application/octet-stream'
}

/** 生产合成选择：保留会话的配置与取消信号，自定义失败不改用其他服务。 */
export async function synthesizeForWorker(text: string, signal: AbortSignal, api?: ResolvedVoiceApi): Promise<Buffer> {
  signal.throwIfAborted()
  if (api) return synthesizeApi(api, text, signal)
  return synthesizeSpeech({ text, voice: DEFAULT_TTS_VOICE, rate: '+0%', pitch: '+0Hz', signal })
}

/** 合成 → 播放的原子单位。一次只有一个；busy 由这里把守。 */
class SpeakSession {
  private settled = false
  private phase: 'synth' | 'audio' = 'synth'
  private readonly id: string
  private readonly text: string
  private readonly deps: SpeakDeps
  private readonly onSettled: () => void
  private readonly controller = new AbortController()
  private readonly api: ResolvedVoiceApi | undefined
  /** 预合成好的音频：有它就不用再等一次合成往返，直接播。 */
  private readonly cached: Buffer | undefined
  /** 这次实际要播的音频（缓存命中或合成结果），播完时回传给主进程写缓存。 */
  private lastAudio: Buffer | undefined
  /**
   * 播完是否把音频回传给主进程写缓存。
   *
   * 只有固定话术（唤醒应答）需要：那是每次唤醒都会重复的一句，缓存下来几乎零延迟。
   * 回答正文每次都不同，回传只会白白把音频搬一遍，所以默认不带 —— 这也让原有的事件形状不变。
   */
  private readonly echoAudio: boolean

  constructor(id: string, text: string, deps: SpeakDeps, onSettled: () => void, api?: ResolvedVoiceApi, cached?: Buffer, echoAudio = false) {
    this.id = id
    this.text = text
    this.deps = deps
    this.onSettled = onSettled
    this.api = api
    this.cached = cached
    this.echoAudio = echoAudio
  }

  async start(): Promise<void> {
    if (this.settled) return
    let mp3: Buffer | undefined = this.cached
    if (mp3 === undefined) {
      try {
        mp3 = await this.deps.synthesize(this.text, this.controller.signal, this.api)
      } catch {
        if (this.settled) return
        if (this.api) {
          this.settled = true
          this.onSettled()
          this.deps.emit({ ok: false, error: '自定义语音 API 合成失败，请检查配置或服务状态；未切换到其他服务' })
          return
        }
        // 仅默认方案允许离线回退，自定义服务失败不能偷偷切换音色或发送到另一服务。
      }
    }
    // 合成不能强制中止，但取消必须立即确认；迟到的成功和失败都不得再启动音频。
    if (this.settled) return
    if (this.deps.handoff && mp3 !== undefined) {
      // 只合成：交出音频即结算，实际开始 / 播完 / 停下由渲染层回执、主进程转报。
      this.settled = true
      this.lastAudio = mp3
      this.onSettled()
      this.deps.handoff(this.id, mp3)
      return
    }
    // 只合成模式下派发时没报过 started：离线回退要在本地真正开始播之前补上。
    if (this.deps.handoff) this.deps.emit({ started: { id: this.id } })
    this.phase = 'audio'
    this.lastAudio = mp3
    try {
      const onDone = (completed: boolean): void => this.finish(completed)
      if (mp3 === undefined) this.deps.fallback(this.text, onDone)
      else this.deps.play(mp3, onDone)
    } catch {
      this.finish(false, true)
    }
  }

  stop(): void {
    // 在途的 HTTP 合成也要掐掉：自定义服务慢的时候，用户按下停止后不该还在等它。
    this.controller.abort()
    this.finish(false, true)
  }

  private finish(completed: boolean, stopAudio = false): void {
    if (this.settled) return
    this.settled = true
    try {
      // 先锁住旧回调并停旧音频，再释放会话、通知上游，避免通知中派出的新句被误杀。
      if (stopAudio && this.phase === 'audio') this.deps.stopAudio()
    } finally {
      this.onSettled()
      // 播完时把音频、文本一起带回去：主进程据此把"固定话术"写进缓存，下次直接复用。
      // 半句（cancelled）不带 —— 没完整播过的句子不该被缓存成完整音频。
      // 只有固定话术（echoAudio）才带，别把回答正文的音频也搬一遍。
      this.deps.emit(completed
        ? {
            finished: this.echoAudio && this.lastAudio !== undefined
              ? { id: this.id, text: this.text, audio: this.lastAudio.toString('base64') }
              : { id: this.id },
          }
        : { cancelled: { id: this.id } })
    }
  }
}

/** 预合成好的一句：id → 音频字节。 */
interface PrefetchedAudio {
  readonly id: string
  readonly audio: Buffer
}

export class TtsEdgeEngine {
  private session: SpeakSession | null = null
  private readonly deps: SpeakDeps
  /**
   * 预合成缓存：一句在播的同时，后台把下一句合成好。
   *
   * 没有它，每句之间都要等一次合成往返（网络服务几百毫秒到几秒），用户听到的就是
   * "每个句号后面空一大段"。有它之后，下一句音频通常已经在手边，接缝只剩播放启动时间。
   * 只缓存一句：再多就是拿内存换用不上的东西，而且用户一打断就得全丢。
   */
  private prefetched: PrefetchedAudio | null = null
  private prefetching: { id: string; controller: AbortController } | null = null
  /** 下一句的文本与配置：由主进程在派发当前句时一并捎来。 */
  private next: { id: string; text: string; api?: ResolvedVoiceApi } | null = null
  /**
   * 哪些句子是"固定话术"、值得缓存。
   *
   * 由主进程在拉起 worker 时用环境变量给出（与 `FIXED_PHRASES` 同一份清单）：
   * 这里不 import 主进程模块，worker 保持只依赖合成与播放这两条边界。
   */
  private readonly cacheTexts: Set<string> | null

  constructor(deps: SpeakDeps, cacheTexts?: ReadonlySet<string>) {
    this.deps = deps
    this.cacheTexts = cacheTexts === undefined ? null : new Set(cacheTexts)
  }

  speak(id: string, text: string, api?: ResolvedVoiceApi, next?: { id: string; text: string; api?: ResolvedVoiceApi }, injected?: Buffer): void {
    if (this.session !== null) {
      this.deps.emit({ ok: false, error: 'busy' })
      return
    }
    // 下一次派发前先认一认：这个 id 是不是已经预合成好了。
    const cached = injected ?? (this.prefetched?.id === id ? this.prefetched.audio : undefined)
    if (this.prefetched !== null && this.prefetched.id !== id) this.prefetched = null
    this.next = next ?? null
    const session = new SpeakSession(id, text, this.deps, () => {
      if (this.session === session) this.session = null
    }, api, cached, this.cacheTexts?.has(text) === true)
    this.session = session
    if (!this.deps.handoff) this.deps.emit({ started: { id } })
    void session.start().then(() => this.prefetchNext())
  }

  stop(): void {
    // 打断语义：用户不想再听，预取中的和已合成好的下一句都作废 —— 留着会把旧内容播到新一轮。
    // 要注意的是正常播放路径不会调 stop（主进程在 finished 之后直接派下一句），
    // 所以这里的清理只影响"被打断"这一条路，不会让预合成白做。
    if (this.prefetching !== null) {
      this.prefetching.controller.abort()
      this.prefetching = null
    }
    this.prefetched = null
    this.next = null
    this.session?.stop()
  }

  get busy(): boolean {
    return this.session !== null
  }

  /** 后台把"下一句"合成好放进缓存。失败就算了：真派到时再合成一次，不因为预取失败而报错。 */
  private prefetchNext(): void {
    const next = this.next
    if (next === null || this.prefetching !== null || this.prefetched?.id === next.id) return
    const controller = new AbortController()
    this.prefetching = { id: next.id, controller }
    void this.deps.synthesize(next.text, controller.signal, next.api).then(audio => {
      if (this.prefetching?.id !== next.id) return
      this.prefetching = null
      this.prefetched = { id: next.id, audio }
    }).catch(() => {
      if (this.prefetching?.id === next.id) this.prefetching = null
    })
  }
}

/**
 * 两种音频共用子进程收尾；注入启动器以便无声验证真实的进程管理逻辑。
 *
 * 注入的是**完整命令**（可执行文件名 + 参数）而不是光秃秃的参数数组：平台之间的差异
 * 恰恰就在"用哪个可执行文件"上 —— Windows 是 `powershell -File play.ps1 -Path x`，
 * macOS 是 `afplay x`。只注入参数的话，macOS 那条分支根本表达不出来。
 *
 * 返回 `null` 表示该平台上这个能力不存在（Linux 没有实现）。调用方据此如实报错，
 * 而不是 spawn 一个必然失败的命令 —— 后者会把"这个平台没实现"说成"播放出错了"。
 */
export function createAudioPlayer(
  dir: string,
  tmpRoot: string,
  spawnHidden: (spec: CommandSpec) => ChildProcess,
  platform: SupportedPlatform = platformOf(),
): Pick<SpeakDeps, 'play' | 'fallback' | 'stopAudio'> {
  let seq = 0
  let audio: { child: ChildProcess; stopped: boolean } | null = null
  const removeFile = (file: string): void => {
    try { rmSync(file, { force: true }) } catch { /* 文件仍被占用时留待退出清理 */ }
  }
  const startAudio = (spec: CommandSpec | null, file: string, onDone: (completed: boolean) => void): void => {
    if (spec === null) {
      // 能力缺失不是"播放失败"：如实说清楚，并把这次会话按取消结算，
      // 否则 worker 会一直挂在 busy 上，后续句子全被当成"合成器正忙"丢掉。
      removeFile(file)
      throw new Error(unsupportedAudioMessage(platform))
    }
    let child: ChildProcess
    try {
      child = spawnHidden(spec)
    } catch (error) {
      removeFile(file)
      throw error
    }
    const current = { child, stopped: false }
    audio = current
    let settled = false
    const finish = (completed: boolean): void => {
      // 旧进程的迟到事件只能清理它自己的文件，不能清掉新进程的引用。
      if (audio === current) audio = null
      removeFile(file)
      if (settled) return
      settled = true
      onDone(completed && !current.stopped)
    }
    child.once('close', (code) => finish(code === 0))
    child.once('error', () => finish(false))
  }

  return {
    play: (audioBytes, onDone) => {
      // 自定义 TTS（MiMo 等）可能返回 wav：扩展名按真实格式挑，MCI / afplay 才认。
      const mime = sniffAudioMime(audioBytes)
      const ext = mime === 'audio/wav' ? '.wav' : mime === 'audio/ogg' ? '.ogg' : '.mp3'
      const file = path.join(tmpRoot, `seg-${++seq}${ext}`)
      try {
        writeFileSync(file, audioBytes)
      } catch (error) {
        removeFile(file)
        throw error
      }
      startAudio(playAudioSpec(platform, dir, file), file, onDone)
    },
    fallback: (text, onDone) => {
      const wav = path.join(tmpRoot, `seg-${++seq}.wav`)
      startAudio(speakOfflineSpec(platform, dir, text, wav), wav, onDone)
    },
    stopAudio: () => {
      const current = audio
      audio = null
      if (current) {
        // 先标记取消；kill 期间或之后到达的零退出码不能把打断算作播完。
        current.stopped = true
        try { current.child.kill() } catch { /* 已退出 */ }
      }
    },
  }
}

/** 能力缺失时给用户看的那句话。分开成函数是为了让测试能钉住措辞。 */
export function unsupportedAudioMessage(platform: SupportedPlatform): string {
  if (platform === 'darwin') return '这台 Mac 上没找到播放声音的办法，朗读暂时不可用'
  return '当前系统上还没有实现声音播放，朗读暂时不可用'
}

function main(): void {
  const emit = (event: SynthOnlyWorkerEvent): void => {
    process.stdout.write(JSON.stringify(event) + '\n')
  }
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'dsh-tts-'))
  // 命令怎么拼由 platform.ts 说了算，这里只负责把 spawn 的通用选项补齐。
  const spawnHidden = (spec: CommandSpec): ChildProcess =>
    spawn(spec.command, [...spec.args], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    })
  // 只合成模式由主进程在拉起时用环境变量指定（"外放插话"实验开关）；缺省走原有本地播放。
  const synthOnly = process.env.DSH_TTS_SYNTH_ONLY === '1'
  // 固定话术清单：只有这些句子播完才回传音频、供主进程落盘复用。
  // 用 JSON 数组传（环境变量不能含空字节，所以不能用分隔符串起来）。
  const cacheTexts = ((): string[] => {
    const raw = process.env.DSH_TTS_CACHE_TEXTS ?? ''
    if (raw.length === 0) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.filter((text): text is string => typeof text === 'string' && text.length > 0)
        : []
    } catch {
      return []
    }
  })()
  const engine = new TtsEdgeEngine({
    synthesize: synthesizeForWorker,
    ...createAudioPlayer(dir, tmpRoot, spawnHidden, platformOf()),
    emit,
    ...(synthOnly ? { handoff: (id: string, audio: Buffer) => emit({ audio: { id, b64: audio.toString('base64'), mime: sniffAudioMime(audio) } }) } : {}),
  }, cacheTexts.length > 0 ? new Set(cacheTexts) : undefined)
  process.once('exit', () => {
    engine.stop()
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 子进程尚未释放文件 */ }
  })

  emit({ ready: true, voice: DEFAULT_TTS_VOICE })

  let closing = false
  const handle = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let message: {
      speak?: {
        id?: string
        b64?: string
        api?: unknown
        next?: { id?: string; b64?: string; api?: unknown }
      }
      stop?: unknown
      exit?: unknown
    }
    try {
      message = JSON.parse(trimmed)
    } catch {
      return
    }
    if (message.exit !== undefined) {
      closing = true
      engine.stop()
      process.exit(0)
    }
    if (message.stop !== undefined) {
      engine.stop()
      return
    }
    if (message.speak && typeof message.speak.id === 'string' && typeof message.speak.b64 === 'string') {
      const text = Buffer.from(message.speak.b64, 'base64').toString('utf8')
      const api = message.speak.api as ResolvedVoiceApi | undefined
      // 主进程命中固定话术缓存时直接把音频带下来：跳过这次合成。
      const cached = typeof (message.speak as { audio?: unknown }).audio === 'string'
        ? Buffer.from((message.speak as { audio: string }).audio, 'base64')
        : undefined
      const rawNext = message.speak.next
      const next = rawNext && typeof rawNext.id === 'string' && typeof rawNext.b64 === 'string'
        ? {
            id: rawNext.id,
            text: Buffer.from(rawNext.b64, 'base64').toString('utf8'),
            api: rawNext.api as ResolvedVoiceApi | undefined,
          }
        : undefined
      engine.speak(message.speak.id, text, api, next, cached)
    }
  }

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    if (closing) return
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) handle(line)
  })
  process.stdin.on('end', () => {
    engine.stop()
    process.exit(0)
  })
}

// 直接执行源码或打包产物才启动协议循环；测试导入不得打开 stdin 或创建临时目录。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
