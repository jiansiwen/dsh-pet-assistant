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

// 这里写 `.ts` 而不是惯用的 `.js`：Node 的类型剥离不会把 `.js` 说明符重写成 `.ts`，
// 而这个文件要被 `node --test` 直接导入（`pet-metrics.ts` 同理）。esbuild 两种都认。
import {
  INITIAL_SPEECH_STATE,
  describeRecords,
  nextSpeech,
  pendingDispatch,
  resumeIndex,
  type InterruptLevel,
  type SpeechEvent,
  type SpeechRequest,
  type SpeechState,
  type SpokenRecord,
} from './speech.ts'

/** 合成进程报回来的事件，一行一个 JSON。协议见 `tts-edge-worker.ts` 头部。 */
export type TtsWorkerEvent =
  | { readonly ready: true; readonly voice?: string }
  | { readonly started: { readonly id: string } }
  | { readonly finished: { readonly id: string } }
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

  constructor(open: (deliver: (event: TtsWorkerEvent) => void) => TtsTransport, hooks: NarratorHooks = {}) {
    this.open = open
    this.hooks = hooks
  }

  /** 排一段要念的内容。整段回答或整份文档的一次讲话请求就是一个 request。 */
  speak(request: SpeechRequest): void {
    if (this.disposed) return
    this.apply({ type: 'enqueue', request })
    this.pump()
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
    this.transport?.close()
    this.transport = null
    this.ready = false
    this.awaitingStop = false
    this.setSpeaking(false)
  }

  private apply(event: SpeechEvent): void {
    const turn = nextSpeech(this.state, event)
    // spoken 只增不减，按旧长度切出来的正好是这次新增的记录。必须在覆盖 this.state 之前算。
    this.roundSpoken.push(...turn.state.spoken.slice(this.state.spoken.length))
    this.state = turn.state
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
    this.transport.write(JSON.stringify({ speak: { id, b64: Buffer.from(segment.text, 'utf8').toString('base64') } }))
    this.apply({ type: 'dispatched' })
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
      this.apply({ type: 'spoken' })
      this.pump()
      return
    }
    if ('cancelled' in event) {
      // 只有我们写过 stop 才会收到这条，所以队列该不该继续由那次打断的层级决定：
      // 第二层以上队列已经空了，第一层则接着播下一句。
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
    this.transport = null
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
export function spawnTtsEdgeWorker(deliver: (event: TtsWorkerEvent) => void): TtsTransport {
  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tts-edge-worker.js')
  const child: ChildProcess = spawn(process.execPath, [workerPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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
