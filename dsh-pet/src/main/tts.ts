/**
 * 讲解播放器：把 `speech.ts` 的队列规则接到常驻合成 worker（edge-tts，见 `tts-edge-worker.ts`）上。
 *
 * 分成两半是有意的。队列、播放游标、四层打断的规则全在 `speech.ts` 的纯函数里；这里只剩
 * 「什么时候往管道里写一行」这层胶水。胶水也做了传输注入，于是"一次只交给合成器一句"和
 * "打断之后播出记录长什么样"都能用假传输在 `node --test` 里钉住，不用真开扬声器。
 *
 * 计划 §2.8 的三条硬要求在这里的落点：
 * - 合成进程一次只吃一句，所以只有 `pendingDispatch` 给出句子时才写 `speak`；
 * - `stop` 必须能在当前这句播完之前被看见，所以合成进程是长驻的、stdin 一直开着；
 * - 播出记录只认合成进程实际报回来的 finished / cancelled，报不回来的一律算半句。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { toUnpackedPath } from './runtime-launch.ts'

// 这里写 `.ts` 而不是惯用的 `.js`：Node 的类型剥离不会把 `.js` 说明符重写成 `.ts`，
// 而这个文件要被 `node --test` 直接导入（`pet-metrics.ts` 同理）。esbuild 两种都认。
import {
  INITIAL_SPEECH_STATE,
  describeRecords,
  drainSentences,
  nextSpeech,
  pendingDispatch,
  resumeIndex,
  type InterruptLevel,
  type SpeechEvent,
  type SpeechRequest,
  type SpeechState,
  type SpokenRecord,
} from './speech.ts'
import type { ResolvedVoiceApi } from '../voice-api-types.ts'
import { fixedPhrases } from './greetings.ts'
import type { TtsCache } from './tts-cache.ts'

/** 固定话术集合：只对这些句子做缓存，回答正文每次都不同，缓存它没有意义。 */
const FIXED_PHRASES = new Set(fixedPhrases())

/** 合成进程报回来的事件，一行一个 JSON。协议见 `tts-edge-worker.ts` 头部。 */
export type TtsWorkerEvent =
  | { readonly ready: true; readonly voice?: string }
  | { readonly started: { readonly id: string } }
  | { readonly finished: { readonly id: string; readonly text?: string; readonly audio?: string } }
  | { readonly cancelled: { readonly id: string } }
  | { readonly ok: false; readonly error: string }

/** 一条通往合成进程的管道。测试里换成假的，就能不出声地跑完整条链路。 */
export interface TtsTransport {
  /** 写一行命令。实现方负责补换行。 */
  write(line: string): void
  /** 请它自己退出。之后不会再有事件。 */
  close(): void
}

export interface NarratorHooks {
  /** 第三层打断：取消还在流式生成的回答。那个流在哪儿只有上层知道。 */
  onCancelGeneration?: () => void
  /** 第四层打断：申请取消实际任务。上层负责弹确认，这里只管提出来一次。 */
  onRequestTaskCancel?: () => void
  /** 出声状态变了。界面据此显示"正在讲解"和停止按钮。 */
  onSpeaking?: (speaking: boolean) => void
  onSpoken?: (record: SpokenRecord) => void
  /** 挑中的合成音色。只有英文音色时用户需要能看见这件事，否则他只会觉得"读得怪"。 */
  onVoice?: (voice: string) => void
  /** 合成进程起不来或中途没了。 */
  onError?: (reason: string) => void
}

/**
 * 播放驱动器。
 *
 * 一台机器上只该有一个：两个驱动就是两个合成进程同时出声。
 */
export class Narrator {
  private readonly open: (deliver: (event: TtsWorkerEvent) => void) => TtsTransport
  private readonly hooks: NarratorHooks
  private readonly ttsApi: () => ResolvedVoiceApi | null
  private readonly cache: TtsCache | null
  /** 本次派发用的音色指纹（缓存键的一半）；由 cachedAudio 顺带记下。 */
  private cachedVoiceKey: string | null = null
  private state: SpeechState = INITIAL_SPEECH_STATE
  /** 当前这一轮播出的句子。跨轮的完整记录在 reducer 的 `state.spoken` 里。 */
  private roundSpoken: SpokenRecord[] = []
  private transport: TtsTransport | null = null
  private ready = false
  /**
   * 已经叫停，正在等合成进程把"停了"报回来。
   *
   * 等的这段时间里不能派下一句：worker 要在上一句结算后才能接下一句，
   * 在那之前塞新句子进去，它会报 busy，而报 busy 的这句就没人再派第二次 —— 直接丢了。
   * 管道是先进先出的，所以 stop → cancelled → speak 这个顺序由这里守住就够了。
   */
  private awaitingStop = false
  private speaking = false
  private disposed = false
  /** 流式朗读的攒句缓冲，按 utteranceId 分开：一轮回答一个。 */
  private feeds = new Map<string, { buffer: string; nextIndex: number }>()

  constructor(open: (deliver: (event: TtsWorkerEvent) => void) => TtsTransport, hooks: NarratorHooks = {}, options: {
    /** 当前选中的自定义 TTS 服务；null 走默认合成。派发时才取，用户中途换服务不用重启播放器。 */
    ttsApi?: () => ResolvedVoiceApi | null
    /** 固定话术的音频缓存；null = 不缓存（默认 edge-tts 路径）。 */
    cache?: TtsCache | null
  } = {}) {
    this.open = open
    this.hooks = hooks
    this.ttsApi = options.ttsApi ?? (() => null)
    this.cache = options.cache ?? null
  }

  /** 排一段要念的内容。整段回答或整份文档的一次讲话请求就是一个 request。 */
  speak(request: SpeechRequest): void {
    if (this.disposed) return
    this.apply({ type: 'enqueue', request })
    this.pump()
  }

  /**
   * 流式喂入一段还在长的文本：攒到完整句子就立刻排进去，剩下的留在缓冲里等下一段。
   *
   * 这是"边收边合成"的入口：第一个句子一凑齐就开始念，用户不用等整段回答算完。
   * 半句不派给合成器 —— 切在词中间念出来是断的。
   */
  feed(utteranceId: string, chunk: string): void {
    if (this.disposed || chunk.length === 0) return
    const entry = this.feeds.get(utteranceId) ?? { buffer: '', nextIndex: 0 }
    const { sentences, rest } = drainSentences(entry.buffer + chunk)
    entry.buffer = rest
    for (const sentence of sentences) {
      this.speak({ utteranceId, text: sentence, indexBase: entry.nextIndex })
      entry.nextIndex += 1
    }
    this.feeds.set(utteranceId, entry)
  }

  /**
   * 流结束：把缓冲里最后没标点的一截也念完。
   *
   * 没喂过任何增量时这里什么都不做 —— 调用方要据此退回"整段一次朗读"，别让一段回答
   * 既没被喂过、又不再整段送出去，那就变成哑巴了。
   */
  feedEnd(utteranceId: string): void {
    const entry = this.feeds.get(utteranceId)
    if (entry === undefined) return
    this.feeds.delete(utteranceId)
    const tail = entry.buffer.trim()
    if (tail.length > 0) this.speak({ utteranceId, text: tail, indexBase: entry.nextIndex })
  }

  /** 这一轮不念了（被打断/出错）：把缓冲丢掉，之后迟到的增量不会再开口。 */
  dropFeed(utteranceId: string): void {
    this.feeds.delete(utteranceId)
  }

  generationStarted(): void {
    this.apply({ type: 'generation-started' })
  }

  generationEnded(): void {
    this.apply({ type: 'generation-ended' })
  }

  /**
   * 打断。
   *
   * 层级含义见 `speech.ts`。要提醒的是第一层：它只掐掉当前这一句，队列还在，所以掐完下一句
   * 会接着播 —— 那是"跳过这句"，不是"别说了"。用户界面上的"停止讲解"必须走第二层。
   */
  interrupt(level: InterruptLevel): void {
    if (this.disposed) return
    this.apply({ type: 'interrupt', level })
    this.pump()
  }

  /**
   * 开始新的一轮讲话。
   *
   * 播出记录在 reducer 里是跨轮累积的（文档续讲要靠它接着往下走），而"被打断时该告诉模型
   * 什么"只关当前这一轮，所以这里单独截一份。
   */
  beginRound(): void {
    this.roundSpoken = []
  }

  /**
   * 这一轮被打断时，用户实际听到了什么；一句都没播出去就是 null。
   *
   * 返回 null 而不是占位文案是有意的：调用方要能分清"没播出任何内容"和"播出了这些"，
   * 前者根本不该往模型的消息里塞东西。
   */
  interruptedContext(): string | null {
    if (this.roundSpoken.length === 0) return null
    return describeRecords(this.roundSpoken)
  }

  /** 续讲从这份文档的第几句接着走。 */
  resumeFrom(utteranceId: string): number {
    return resumeIndex(this.state, utteranceId)
  }

  /** 现在是不是正在出声（含队列里还没播的）。 */
  isSpeaking(): boolean {
    return this.speaking
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.feeds.clear()
    this.transport?.close()
    this.transport = null
    this.ready = false
    this.awaitingStop = false
    this.setSpeaking(false)
  }

  private apply(event: SpeechEvent): void {
    const turn = nextSpeech(this.state, event)
    // spoken 只增不减，按旧长度切出来的正好是这次新增的记录。必须在覆盖 this.state 之前算。
    const records = turn.state.spoken.slice(this.state.spoken.length)
    this.roundSpoken.push(...records)
    this.state = turn.state
    for (const record of records) this.hooks.onSpoken?.(record)
    for (const effect of turn.effects) {
      if (effect === 'stop-audio') {
        this.awaitingStop = true
        this.transport?.write('{"stop":{}}')
      } else if (effect === 'cancel-generation') {
        this.hooks.onCancelGeneration?.()
      } else if (effect === 'request-task-cancel') {
        this.hooks.onRequestTaskCancel?.()
      }
    }
    this.setSpeaking(this.state.playing !== null || this.state.queue.length > 0)
  }

  private setSpeaking(value: boolean): void {
    if (this.speaking === value) return
    this.speaking = value
    this.hooks.onSpeaking?.(value)
  }

  /** 把队列里的下一句交给合成进程。合成进程没就绪就先等着，就绪事件会再叫一次。 */
  private pump(): void {
    if (this.disposed || this.awaitingStop) return
    const segment = pendingDispatch(this.state)
    if (segment === null) return
    if (this.transport === null) {
      this.transport = this.open((event) => this.onWorkerEvent(event))
      return
    }
    if (!this.ready) return
    const id = `${segment.utteranceId}#${segment.index}`
    // 配置读不出来就停在这里报错：悄悄退回默认服务等于把用户挑的服务换掉。
    let api: ResolvedVoiceApi | null = null
    try {
      api = this.ttsApi()
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
      return
    }
    // 配置随这句传进 worker：用户中途换服务，下一句就走新的；密钥只走 stdin，不上命令行。
    // 同时捎上"下一句"：worker 会在当前句播放期间预合成它，把句号后的静默压到最小。
    const next = this.state.queue[1]
    const nextId = next === undefined ? null : `${next.utteranceId}#${next.index}`
    const cached = this.cachedAudio(segment.text, api)
    this.transport.write(JSON.stringify({
      speak: {
        id,
        b64: Buffer.from(segment.text, 'utf8').toString('base64'),
        ...(api === null ? {} : { api }),
        // 命中缓存就把现成音频直接交给 worker，省掉这一整次合成往返。
        ...(cached === null ? {} : { audio: cached.toString('base64') }),
        ...(next === undefined ? {} : {
          next: {
            id: nextId,
            b64: Buffer.from(next.text, 'utf8').toString('base64'),
            ...(api === null ? {} : { api }),
            ...(this.cachedAudio(next.text, api) === null ? {} : { audio: (this.cachedAudio(next.text, api) as Buffer).toString('base64') }),
          },
        }),
      },
    }))
    this.apply({ type: 'dispatched' })
  }

  /** 查固定话术缓存。只在启用缓存且有自定义语音服务时生效（默认 edge-tts 不缓存，它本身很快）。 */
  private cachedAudio(text: string, api: ResolvedVoiceApi | null): Buffer | null {
    if (this.cache === null || api === null) return null
    if (!FIXED_PHRASES.has(text)) return null
    const voiceKey = `${api.provider}|${api.endpoint}|${api.model}|${api.voice}`
    this.cachedVoiceKey = voiceKey
    return this.cache.get({ voiceKey, text })
  }

  private onWorkerEvent(event: TtsWorkerEvent): void {
    if (this.disposed) return
    if ('ready' in event) {
      this.ready = true
      if (event.voice) this.hooks.onVoice?.(event.voice)
      this.pump()
      return
    }
    if ('finished' in event) {
      // awaitingStop 期间收到 finished，说明这句在 stop 生效之前就念完了。reducer 那边已经按
      // 打断记过半句，这里 apply('spoken') 因为 playing 为空而什么都不做 —— 少报一句只会让
      // 续讲重念一遍，多报一句用户就真的漏听了内容，宁可少报。
      this.awaitingStop = false
      // 固定话术第一次合成好之后写进缓存：下次唤醒/应答直接复用，不再走一次网络往返。
      const finished = event.finished
      if (finished.audio && finished.text && this.cache !== null && this.cachedVoiceKey !== null
        && FIXED_PHRASES.has(finished.text)) {
        try {
          this.cache.put({ voiceKey: this.cachedVoiceKey, text: finished.text }, Buffer.from(finished.audio, 'base64'))
        } catch {
          // 写缓存失败不影响播放。
        }
      }
      this.apply({ type: 'spoken' })
      this.pump()
      return
    }
    if ('cancelled' in event) {
      if (!this.awaitingStop) {
        this.fail('语音播放未正常完成，请检查音频设备后重试')
        return
      }
      this.awaitingStop = false
      this.apply({ type: 'cut' })
      this.pump()
      return
    }
    if ('started' in event) return
    if (event.error === 'busy') {
      // 一次一句是由 pump 把住的，走到这里说明两边失步了。当前这句照常播完，不丢队列。
      this.hooks.onError?.('合成进程正忙，驱动器与它失步了')
      return
    }
    this.fail(event.error)
  }

  /**
   * 合成进程起不来或中途没了。
   *
   * 正在播的那一句报不回来了，只能算半句 —— 说它播完了就是替用户编造一段他没听过的话。
   * 队列一并丢掉：进程都没了，接着往下派只会一次一次地失败。
   */
  private fail(reason: string): void {
    this.ready = false
    const transport = this.transport
    this.transport = null
    transport?.close()
    // 先报错再打断：下面的 apply 会触发 onSpeaking(false)，而逐段讲解的链条正是在那个回调里
    // 推进下一段的。顺序反了就是每失败一次先白打一次模型，然后才被 onError 停住。
    this.hooks.onError?.(reason)
    this.apply({ type: 'interrupt', level: 'drop-queue' })
    // 必须放在 apply 之后：进程没了，apply 照样会因为 playing 非空而产出一次 stop-audio 并把
    // 标志置起来，可已经没有人会再报 cancelled 回来了 —— 留着它，下一次讲话就永久扣在这儿。
    this.awaitingStop = false
  }
}

/**
 * 拉起 edge-tts 合成 worker。
 *
 * electron.exe 带 ELECTRON_RUN_AS_NODE 就是纯 node，worker 以它跑而不是再找系统 node：
 * 壳不假设用户机器上有独立安装的 Node。
 */
export function spawnTtsEdgeWorker(deliver: (event: TtsWorkerEvent) => void, options: {
  /**
   * 只合成、不播放（"外放插话"实验开关，见 `tts-renderer-transport.ts`）：合成好的音频以
   * `{ audio: { id, b64, mime } }` 事件交回来，由渲染层播放。缺省 false 即原有路径，行为不变。
   */
  synthOnly?: boolean
} = {}): TtsTransport {
  // 打包后主进程在 app.asar 里，而这个路径要交给以 ELECTRON_RUN_AS_NODE 起的子进程 ——
  // 那种子进程没有 asar 补丁，拿到 asar 内的路径只会报找不到文件。走解包目录的真实路径。
  const workerPath = toUnpackedPath(path.join(path.dirname(fileURLToPath(import.meta.url)), 'tts-edge-worker.js'))
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  // 只认这里的显式选择：外部环境里残留的同名变量不能把默认路径悄悄变成"只合成不出声"。
  if (options.synthOnly === true) env.DSH_TTS_SYNTH_ONLY = '1'
  else delete env.DSH_TTS_SYNTH_ONLY
  // 固定话术清单（JSON 数组）：worker 只对这些句子回传音频供缓存。
  //
  // 为什么不用 NUL 分隔：Windows 的环境变量**不允许包含空字节**，spawn 会直接抛
  // `The property 'options.env[...]' must be a string without null bytes`，
  // 于是整个合成进程起不来，用户看到的是屏幕底部一条报错。
  env.DSH_TTS_CACHE_TEXTS = JSON.stringify(fixedPhrases())
  const child: ChildProcess = spawn(process.execPath, [workerPath], {
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  })

  let closed = false
  child.stdin?.on('error', () => {})

  const stdout = child.stdout
  if (stdout) {
    stdout.setEncoding('utf8')
    let buffer = ''
    stdout.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          deliver(JSON.parse(trimmed) as TtsWorkerEvent)
        } catch {
          // 非 JSON 行跳过：worker 不该往 stdout 写别的，但真写了也不能把壳带崩。
        }
      }
    })
  }

  child.on('exit', () => {
    if (closed) return
    deliver({ ok: false, error: 'worker-exited' })
  })

  return {
    write(line: string): void {
      child.stdin?.write(line + '\n')
    },
    close(): void {
      closed = true
      child.stdin?.write('{"exit":{}}\n')
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // 已经退出
        }
      }, 1500)
      timer.unref()
    },
  }
}
