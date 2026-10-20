/**
 * "外放插话"开关打开时的 TTS 传输（M1-05）：合成进程只合成，音频交给渲染层用 WebAudio 播。
 *
 * 对 Narrator 来说协议**一字不变**（TtsTransport：写 speak / stop / exit，收 ready / started /
 * finished / cancelled / error）。差别只在谁在出声：
 *
 *   Narrator ──speak──▶ 合成进程（DSH_TTS_SYNTH_ONLY）──audio{id,b64}──▶ 这里 ──tts-play──▶ 渲染层
 *   Narrator ◀─started/finished/cancelled── 这里 ◀──回执（实际开始/播完/停下）── 渲染层
 *
 * - started 在渲染层**真的开始出声**时才报（不是派发时），阅读视图据此翻页更准。
 * - stop：还在合成就交给合成进程（它报 cancelled）；已经交给渲染层就让渲染层停，等它的
 *   cancelled 回执。渲染层迟迟不回（窗口重载、失步）有超时兜底，不让 Narrator 一直等。
 * - 渲染层因插话已经自己止声：它会等主进程的 stop 到了再回 cancelled —— Narrator 只认
 *   "我要求停"之后的 cancelled，提前到达的会被当成播放故障。
 * - 合成失败走离线回退（System.Speech）时，合成进程照旧自己播并报 started/finished，这里原样转发；
 *   那一句没有回声消除参考，插话检测可能误触发 —— 这是已知限制，写在报告里。
 *
 * `createSwitchingTransport` 让开关能在两次讲话之间切换：下一句派发时发现模式变了，
 * 就关掉旧传输、开新传输，等新的 ready 再把这句交过去。
 *
 * 只 import 类型：这个文件要能被替身化的 tts 模块共存（隔离验证脚本会把 tts.ts 整个替换掉）。
 */
import type { TtsTransport, TtsWorkerEvent } from './tts.ts'

/** 合成进程在"只合成"模式下多出来的一种事件。 */
export type SynthOnlyEvent = TtsWorkerEvent | { readonly audio: { readonly id: string; readonly b64: string; readonly mime?: string } }

export interface RendererPlaybackPort {
  /** 交给渲染层播。返回 false = 没有渲染层可交（窗口没了）。 */
  play(id: string, b64: string): boolean
  stop(id: string): void
}

export interface RendererReceipt {
  readonly id: string
  readonly kind: 'started' | 'finished' | 'cancelled' | 'error'
  readonly durationMs?: number
  readonly error?: string
}

export interface RendererPlaybackOptions {
  /** 交给渲染层后多久没报 started 就判失败。 */
  readonly startTimeoutMs?: number
  /** started 之后超过时长多久还没 finished 就判失败。 */
  readonly finishGraceMs?: number
  /** 要求停之后多久没回 cancelled 就自己补。 */
  readonly stopTimeoutMs?: number
  readonly setTimeout?: (fn: () => void, ms: number) => unknown
  readonly clearTimeout?: (handle: unknown) => void
  readonly log?: (message: string) => void
}

type Phase = 'synth' | 'render' | 'stopping'

interface Current {
  readonly id: string
  phase: Phase
  timer: unknown
}

/** 一个打开的渲染层播放传输。receipt 由主进程的 IPC 回执喂进来。 */
export class RendererPlayback {
  private readonly spawnSynth: (deliver: (event: SynthOnlyEvent) => void) => TtsTransport
  private readonly port: RendererPlaybackPort
  private readonly startTimeoutMs: number
  private readonly finishGraceMs: number
  private readonly stopTimeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly log: (message: string) => void
  private active: { deliver: (event: TtsWorkerEvent) => void; current: Current | null; closed: boolean } | null = null

  constructor(spawnSynth: (deliver: (event: SynthOnlyEvent) => void) => TtsTransport, port: RendererPlaybackPort, options: RendererPlaybackOptions = {}) {
    this.spawnSynth = spawnSynth
    this.port = port
    this.startTimeoutMs = options.startTimeoutMs ?? 8000
    this.finishGraceMs = options.finishGraceMs ?? 4000
    this.stopTimeoutMs = options.stopTimeoutMs ?? 1500
    this.setTimer = options.setTimeout ?? ((fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer })
    this.clearTimer = options.clearTimeout ?? (handle => clearTimeout(handle as NodeJS.Timeout))
    this.log = options.log ?? (() => undefined)
  }

  open = (deliver: (event: TtsWorkerEvent) => void): TtsTransport => {
    const state = { deliver, current: null as Current | null, closed: false }
    this.active = state
    const settle = (event: TtsWorkerEvent): void => {
      const current = state.current
      if (current) this.clearTimer(current.timer)
      state.current = null
      if (!state.closed) deliver(event)
    }
    const inner = this.spawnSynth((event) => {
      if (state.closed) return
      if ('audio' in event) {
        const current = state.current
        if (current === null || current.id !== event.audio.id) return
        if (current.phase === 'stopping') {
          // 合成完成前就被要求停了，而合成进程已经交出了音频：不播，按取消结算。
          settle({ cancelled: { id: current.id } })
          return
        }
        current.phase = 'render'
        if (!this.port.play(current.id, event.audio.b64)) {
          settle({ ok: false, error: '渲染层播放不可用（窗口不在）' })
          return
        }
        current.timer = this.setTimer(() => {
          if (state.current === current) {
            this.log(`渲染层播放 ${current.id} 超时没有开始`)
            this.port.stop(current.id)
            settle({ ok: false, error: '渲染层播放没有开始' })
          }
        }, this.startTimeoutMs)
        return
      }
      if ('finished' in event || 'cancelled' in event) {
        // 只合成模式下这两种只来自合成阶段的取消或离线回退的本地播放：原样结算。
        settle(event)
        return
      }
      if ('ok' in event && event.ok === false && event.error !== 'busy') {
        settle(event)
        return
      }
      deliver(event)
    })
    return {
      write: (line: string): void => {
        if (state.closed) return
        let message: { speak?: { id?: unknown }; stop?: unknown }
        try { message = JSON.parse(line) } catch { inner.write(line); return }
        if (message.speak && typeof message.speak.id === 'string') {
          state.current = { id: message.speak.id, phase: 'synth', timer: null }
          inner.write(line)
          return
        }
        if (message.stop !== undefined) {
          const current = state.current
          if (current === null) { inner.write(line); return }
          if (current.phase === 'synth') {
            current.phase = 'stopping'
            inner.write(line)
            return
          }
          if (current.phase === 'render') {
            current.phase = 'stopping'
            this.clearTimer(current.timer)
            this.port.stop(current.id)
            current.timer = this.setTimer(() => {
              if (state.current === current) {
                this.log(`渲染层停止 ${current.id} 没有回执，按已取消结算`)
                settle({ cancelled: { id: current.id } })
              }
            }, this.stopTimeoutMs)
          }
          return
        }
        inner.write(line)
      },
      close: (): void => {
        if (state.closed) return
        state.closed = true
        const current = state.current
        if (current) {
          this.clearTimer(current.timer)
          if (current.phase !== 'synth') this.port.stop(current.id)
        }
        state.current = null
        if (this.active === state) this.active = null
        inner.close()
      },
    }
  }

  /** 渲染层回执。只结算当前这一句，迟到 / 对不上号的一律丢掉。 */
  receipt(receipt: RendererReceipt): void {
    const state = this.active
    if (state === null || state.closed) return
    const current = state.current
    if (current === null || current.id !== receipt.id) return
    if (receipt.kind === 'started') {
      if (current.phase !== 'render') return
      this.clearTimer(current.timer)
      const duration = typeof receipt.durationMs === 'number' && Number.isFinite(receipt.durationMs) ? receipt.durationMs : 60_000
      current.timer = this.setTimer(() => {
        if (state.current === current) {
          this.log(`渲染层播放 ${current.id} 超时没有结束`)
          this.port.stop(current.id)
          state.current = null
          state.deliver({ ok: false, error: '渲染层播放没有正常结束' })
        }
      }, duration + this.finishGraceMs)
      state.deliver({ started: { id: current.id } })
      return
    }
    const finish = (event: TtsWorkerEvent): void => {
      this.clearTimer(current.timer)
      state.current = null
      state.deliver(event)
    }
    if (receipt.kind === 'finished') {
      // 停止请求已经发出、但这句其实先播完了：如实报 finished（Narrator 会按它的规则处理）。
      finish({ finished: { id: current.id } })
      return
    }
    if (receipt.kind === 'cancelled') {
      // 只有"要求停"之后的取消才转给 Narrator；渲染层自己停的（插话）等 stop 到了再报。
      if (current.phase !== 'stopping') return
      finish({ cancelled: { id: current.id } })
      return
    }
    finish({ ok: false, error: receipt.error ?? '渲染层播放失败' })
  }
}

/**
 * 两种传输之间可切换的外壳。只在"这一句派发之前、上一句已结算"时切换，正在播的不受影响。
 */
export function createSwitchingTransport<M extends string>(
  select: () => M,
  openers: Record<M, (deliver: (event: TtsWorkerEvent) => void) => TtsTransport>,
): (deliver: (event: TtsWorkerEvent) => void) => TtsTransport {
  return (deliver) => {
    let mode = select()
    let generation = 0
    let ready = false
    let queued: string | null = null
    let closed = false
    const open = (): TtsTransport => {
      const mine = ++generation
      ready = false
      return openers[mode]((event) => {
        if (closed || mine !== generation) return
        if ('ready' in event) {
          const first = !ready
          ready = true
          // 切换后新传输的 ready 不再报给 Narrator（它只在打开时等一次），改为放行排着的那一句。
          if (queued !== null) {
            const line = queued
            queued = null
            // 推迟一拍：ready 可能在 open() 返回之前同步到达，那时 inner 还指着旧传输。
            queueMicrotask(() => { if (!closed && mine === generation) inner.write(line) })
            return
          }
          if (first && mine === 1) deliver(event)
          return
        }
        deliver(event)
      })
    }
    let inner = open()
    return {
      write(line: string): void {
        if (closed) return
        let speakId: string | null = null
        try {
          const message = JSON.parse(line) as { speak?: { id?: unknown } }
          if (message.speak && typeof message.speak.id === 'string') speakId = message.speak.id
        } catch { /* 原样转发 */ }
        if (speakId !== null) {
          const wanted = select()
          if (wanted !== mode) {
            mode = wanted
            const old = inner
            queued = line
            inner = open()
            old.close()
            return
          }
          if (!ready) { queued = line; return }
        }
        inner.write(line)
      },
      close(): void {
        if (closed) return
        closed = true
        inner.close()
      },
    }
  }
}
