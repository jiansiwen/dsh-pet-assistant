/**
 * 渲染层事实 → 九态事件：把界面上**已经有的**布尔量翻译成 `presence-view.ts` 认识的事件。
 *
 * 为什么单独一层、为什么是纯函数：
 *
 * 1. **渲染层拿不到"事件"，只拿得到"当前是什么样"**。主进程没有 presence 流，也不该为此新增
 *    通道；能用的只有 `session.entries` 里 streaming 条目、`speech.speaking`、`listening`、
 *    `session.status`、团队任务表这些快照。所以要有一处把「前后两帧快照的差」翻译成事件。
 * 2. **可测**。哪些变化该说话、哪些变化**不该**说话（比如 `busy` 从真变假不等于成功），
 *    是这个模块全部的价值所在；把它们放进 hook 里就只能靠开壳看，放进纯函数就能逐条钉住。
 *
 * 一条贯穿全文件的原则：**只表达事实，不猜结论**。
 * - `busy` 由真变假只说明"提交动作结束了"，不说明"这一轮成功了" —— 成功只有回执能说。
 * - `errorText` 被清空只说明"错误提示没了"，不说明"恢复了" —— 那要等下一条事实。
 * - `speaking` 停下也不等于这一轮结束：还得会话空闲、且不在提交中（见末尾的 `turn-settled`）。
 */

import type { PresenceEvent, PresenceEventKind } from './presence-view.js'

export interface PresenceFacts {
  /** 有一次提交在途（`send` 从点击到回执之间）。 */
  busy: boolean
  /** `'running' | 'waiting' | 'idle' | 'disconnected' | ''`。 */
  sessionStatus: string
  /** 正在出声（朗读/播报）。 */
  speaking: boolean
  /** 听写中。 */
  listening: boolean
  /** 会话条目里存在 `streaming: true` 的正文条目。 */
  hasStreamingText: boolean
  /** 会话条目里存在 `streaming: true` 的思考条目。 */
  hasStreamingThink: boolean
  /** 会话条目里存在 `streaming: true` 的工具调用条目。 */
  hasStreamingTool: boolean
  /** 团队快照里有任务在跑。 */
  taskRunning: boolean
  /** 有界连续对话进行中。 */
  continuous: boolean
  /** 用户闭了麦。 */
  muted: boolean
  /** 非空即有一条要如实报出来的错误。 */
  errorText: string
}

/** 空基线：挂载时用它当"上一帧"，于是"打开界面时它已经在干活"也能一次翻译出来。 */
export const EMPTY_FACTS: PresenceFacts = {
  busy: false,
  sessionStatus: '',
  speaking: false,
  listening: false,
  hasStreamingText: false,
  hasStreamingThink: false,
  hasStreamingTool: false,
  taskRunning: false,
  continuous: false,
  muted: false,
  errorText: '',
}

const RUNNING = new Set(['running', 'waiting'])

/**
 * 会改九态的事件。`speech-end` 不在此列 —— 它只记"说完了"，落不落格由 `turn-settled` 决定。
 */
const STATE_BEARING: ReadonlySet<PresenceEventKind> = new Set<PresenceEventKind>([
  'dictation-start', 'dictation-end', 'asr-delta', 'asr-final',
  'turn-start', 'delta-text', 'delta-think', 'delta-tool',
  'speech-start', 'turn-settled', 'task-running',
  'receipt-succeeded', 'receipt-partial', 'receipt-unknown', 'receipt-failed',
  'mute-on', 'mute-off', 'session-idle', 'session-lost',
])

/**
 * 这批事件里**最后一个要改状态**的那一个。宿主的驻留门挡下事件时，重试只重放它。
 *
 * 为什么不是重放整批：`turn-start` 是**一次性事实**（"这一轮开始了"），它把状态设为"思考中"
 * （优先级 50）。整批重放时它会先把已经走到"回答中"的状态（45）推回"思考中"，随后的正文事件
 * 又被新的驻留门挡下 —— 越重试越退，永远收敛不了。只重放最后那个意图，既不会倒退，
 * 又一定在驻留期满后落地。
 */
export function intentOf(events: readonly PresenceEvent[]): PresenceEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (STATE_BEARING.has(events[index].kind)) return events[index]
  }
  return null
}

/**
 * 前后两帧事实 → 事件序列。空数组表示"这一帧什么都不用说"，调用方据此完全跳过重渲染。
 *
 * **顺序是契约的一部分**：失败排最前 —— 同一帧里"出错了"和"状态变了"同时发生时，用户需要
 * 先看到错，界面也才不会把失败埋在一个看起来还在跑的状态后面。收束事件排最后，让它盖住同帧
 * 里先发生的那些细节。
 */
export function factsToEvents(prev: PresenceFacts, next: PresenceFacts, now: number): PresenceEvent[] {
  const events: PresenceEvent[] = []
  const push = (kind: PresenceEventKind): void => { events.push({ kind, at: now }) }

  // 1. 失败优先。错误文本换了一条也算新错误（不同的错需要重新被看见）。
  //
  // 这条**故意不按文案过滤**：`errorText` 里既有运行期故障（语音合成起不来），也有操作失败
  // （"消息未提交，请重试"）。两类都落 `failed` 是有意的 —— 不管哪一种，宠物确实没办成这件事，
  // 摆一次困惑表情比装作没事更诚实，况且 2.5s 后自动回落，不会长期误报。
  // 不做前缀匹配（例如排除"消息未提交"开头）是因为文案是产物、不是契约：改一句措辞，
  // 过滤规则就静默失效，而失效的表现恰恰是"失败不再被显示"，没人会发现。
  if (next.errorText !== '' && next.errorText !== prev.errorText) push('receipt-failed')
  else if (next.errorText === '' && prev.errorText !== '') push('session-idle')

  // 2. 会话面：断线 → 丢会话；回到空闲 → 收束；刚进入运行 → 新一轮开始。
  if (next.sessionStatus === 'disconnected' && prev.sessionStatus !== 'disconnected') push('session-lost')
  else if (next.sessionStatus === 'idle' && prev.sessionStatus !== 'idle') push('session-idle')
  else if (RUNNING.has(next.sessionStatus) && !RUNNING.has(prev.sessionStatus)) push('turn-start')

  // 3. 听写：松手之后到出文字之前是"识别中"。
  if (next.listening !== prev.listening) push(next.listening ? 'dictation-start' : 'dictation-end')

  // 4. 播报：开始念即"回答中"，念完只记一笔（收不收束看最后一条）。
  if (next.speaking !== prev.speaking) push(next.speaking ? 'speech-start' : 'speech-end')

  // 5. 流式条目：只认"从无到有"。条目是累积的，布尔量在整个轮次里一直是真，不会反复触发。
  if (!prev.hasStreamingThink && next.hasStreamingThink) push('delta-think')
  if (!prev.hasStreamingText && next.hasStreamingText) push('delta-text')
  if (!prev.hasStreamingTool && next.hasStreamingTool) push('delta-tool')

  // 6. 团队任务在跑。任务结束不推任何"完成"，那要等回执/快照自己说。
  if (!prev.taskRunning && next.taskRunning) push('task-running')

  // 7. 连续对话是会话级闩锁，只有它自己的起停能翻。
  if (next.continuous !== prev.continuous) push(next.continuous ? 'continuous-start' : 'continuous-stop')

  // 8. 静音是开关，不是状态。
  if (next.muted !== prev.muted) push(next.muted ? 'mute-on' : 'mute-off')

  // 9. 收束：三个条件缺一不可 —— 刚念完、没有提交在途、会话已经空闲。
  //    `busy` 还真的话说明这一轮的提交还没落地，此刻收束会让界面先说"完事了"再闪回"在跑"。
  if (prev.speaking && !next.speaking && !next.busy && next.sessionStatus === 'idle') push('turn-settled')

  return events
}
