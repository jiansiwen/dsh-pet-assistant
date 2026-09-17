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
import { DEFAULT_TTS_VOICE, synthesizeSpeech } from './edge-tts.js'

export type WorkerEvent =
  | { readonly ready: true; readonly voice: string }
  | { readonly started: { readonly id: string } }
  | { readonly finished: { readonly id: string } }
  | { readonly cancelled: { readonly id: string } }
  | { readonly ok: false; readonly error: string }

interface SpeakDeps {
  /** 合成一句 → mp3 字节。抛错视为合成失败，走回退。 */
  synthesize(text: string): Promise<Buffer>
  /** 播放 mp3，播完回调 completed=true；被 stop 杀掉回调 completed=false。 */
  play(mp3: Buffer, onDone: (completed: boolean) => void): void
  /** 离线回退：本地合成并播放，回调语义同 play。 */
  fallback(text: string, onDone: (completed: boolean) => void): void
  /** 掐掉正在出声的子进程。 */
  stopAudio(): void
  emit(event: WorkerEvent): void
}

/** 合成 → 播放的原子单位。一次只有一个；busy 由这里把守。 */
class SpeakSession {
  private settled = false
  private cancelRequested = false
  private phase: 'synth' | 'audio' = 'synth'

  constructor(
    readonly id: string,
    private readonly text: string,
    private readonly deps: SpeakDeps,
  ) {}

  start(): void {
    this.deps.synthesize(this.text).then(
      (mp3) => {
        if (this.settled) return
        this.phase = 'audio'
        if (this.cancelRequested) {
          this.finishCancelled()
          return
        }
        this.deps.play(mp3, (completed) => this.onAudioDone(completed))
      },
      () => {
        if (this.settled) return
        this.phase = 'audio'
        if (this.cancelRequested) {
          this.finishCancelled()
          return
        }
        this.deps.fallback(this.text, (completed) => this.onAudioDone(completed))
      },
    )
  }

  /** 用户打断：合成期记下等合成完再取消；出声期立刻掐。 */
  stop(): void {
    if (this.settled) return
    this.cancelRequested = true
    if (this.phase === 'audio') {
      this.finishCancelled()
      this.deps.stopAudio()
    }
  }

  private onAudioDone(completed: boolean): void {
    if (this.settled) return
    if (this.cancelRequested || !completed) this.finishCancelled()
    else {
      this.settled = true
      this.deps.emit({ finished: { id: this.id } })
    }
  }

  private finishCancelled(): void {
    this.settled = true
    this.deps.emit({ cancelled: { id: this.id } })
  }
}

export class TtsEdgeEngine {
  private session: SpeakSession | null = null

  constructor(private readonly deps: SpeakDeps) {}

  speak(id: string, text: string): void {
    if (this.session !== null) {
      this.deps.emit({ ok: false, error: 'busy' })
      return
    }
    const session = new SpeakSession(id, text, this.deps)
    this.session = session
    this.deps.emit({ started: { id } })
    session.start()
  }

  stop(): void {
    this.session?.stop()
  }

  settle(): void {
    this.session = null
  }

  get busy(): boolean {
    return this.session !== null
  }
}

function main(): void {
  const emit = (event: WorkerEvent): void => {
    process.stdout.write(JSON.stringify(event) + '\n')
  }
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'dsh-tts-'))
  let seq = 0

  const spawnHidden = (args: string[]): ChildProcess =>
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    })

  let audioChild: ChildProcess | null = null

  const engine = new TtsEdgeEngine({
    synthesize: (text) =>
      synthesizeSpeech({ text, voice: DEFAULT_TTS_VOICE, rate: '+0%', pitch: '+0Hz' }),
    play: (mp3, onDone) => {
      seq += 1
      const file = path.join(tmpRoot, `seg-${seq}.mp3`)
      writeFileSync(file, mp3)
      audioChild = spawnHidden(['-File', path.join(dir, 'play.ps1'), '-Path', file])
      audioChild.on('exit', (code) => {
        audioChild = null
        try { rmSync(file, { force: true }) } catch { /* 临时文件，下次清理 */ }
        onDone(code === 0)
      })
      audioChild.on('error', () => {
        audioChild = null
        onDone(false)
      })
    },
    fallback: (text, onDone) => {
      seq += 1
      const wav = path.join(tmpRoot, `seg-${seq}.wav`)
      audioChild = spawnHidden([
        '-File', path.join(dir, 'speak-once.ps1'),
        '-B64', Buffer.from(text, 'utf8').toString('base64'),
        '-OutPath', wav,
      ])
      audioChild.on('exit', (code) => {
        audioChild = null
        try { rmSync(wav, { force: true }) } catch { /* 临时文件 */ }
        onDone(code === 0)
      })
      audioChild.on('error', () => {
        audioChild = null
        onDone(false)
      })
    },
    stopAudio: () => {
      const child = audioChild
      audioChild = null
      if (child) {
        try { child.kill() } catch { /* 已退出 */ }
      }
    },
    emit,
  })

  emit({ ready: true, voice: DEFAULT_TTS_VOICE })

  let closing = false
  const handle = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let message: { speak?: { id?: string; b64?: string }; stop?: unknown; exit?: unknown }
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
      engine.speak(message.speak.id, text)
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

main()
