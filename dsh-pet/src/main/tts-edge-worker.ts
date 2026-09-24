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
  | { readonly finished: { readonly id: string } }
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

  constructor(id: string, text: string, deps: SpeakDeps, onSettled: () => void, api?: ResolvedVoiceApi) {
    this.id = id
    this.text = text
    this.deps = deps
    this.onSettled = onSettled
    this.api = api
  }

  async start(): Promise<void> {
    if (this.settled) return
    let mp3: Buffer | undefined
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
    // 合成不能强制中止，但取消必须立即确认；迟到的成功和失败都不得再启动音频。
    if (this.settled) return
    this.phase = 'audio'
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
      this.deps.emit(completed ? { finished: { id: this.id } } : { cancelled: { id: this.id } })
    }
  }
}

export class TtsEdgeEngine {
  private session: SpeakSession | null = null
  private readonly deps: SpeakDeps

  constructor(deps: SpeakDeps) {
    this.deps = deps
  }

  speak(id: string, text: string, api?: ResolvedVoiceApi): void {
    if (this.session !== null) {
      this.deps.emit({ ok: false, error: 'busy' })
      return
    }
    const session = new SpeakSession(id, text, this.deps, () => {
      if (this.session === session) this.session = null
    }, api)
    this.session = session
    this.deps.emit({ started: { id } })
    void session.start()
  }

  stop(): void {
    this.session?.stop()
  }

  get busy(): boolean {
    return this.session !== null
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
    play: (mp3, onDone) => {
      const file = path.join(tmpRoot, `seg-${++seq}.mp3`)
      try {
        writeFileSync(file, mp3)
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
  const emit = (event: WorkerEvent): void => {
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
  const engine = new TtsEdgeEngine({
    synthesize: synthesizeForWorker,
    ...createAudioPlayer(dir, tmpRoot, spawnHidden, platformOf()),
    emit,
  })
  process.once('exit', () => {
    engine.stop()
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 子进程尚未释放文件 */ }
  })

  emit({ ready: true, voice: DEFAULT_TTS_VOICE })

  let closing = false
  const handle = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let message: { speak?: { id?: string; b64?: string; api?: unknown }; stop?: unknown; exit?: unknown }
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
      engine.speak(message.speak.id, text, message.speak.api as ResolvedVoiceApi | undefined)
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
