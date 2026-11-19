/**
 * 答完反问之后的"再等一会儿"窗口。
 *
 * 产品要的是像真人开会：讲完一段被追问、答完之后**不要自顾自接着念**，先反问一句
 * "还有其他问题吗"，然后等一小段时间 ——
 * - 这段时间里没人再问，就继续讲；
 * - 有人还在说话（还在提问、还在补充），就继续等；
 * - 用户明确说"继续 / 往下 / 接着"，立刻讲。
 *
 * 判据必须是**识别文本有没有变长**，不能用麦克风能量/VAD：能量阈值分不清"有人在说话"和
 * "空调/键盘/椅子响"，而后者一个字都识别不出来。把声音当说话会让人永远等不到续讲；
 * 反过来只认文本，则杂音天然被过滤掉。
 *
 * 为什么还要 `hardDeadline`：ASR 会持续出字（有人一直在聊别的、或者识别器抖动），
 * 只按"每次都顺延 5 秒"的话讲解会被永久卡住。最长延长到 `maxExtendMs` 就强制收束，
 * 保证"最坏情况下也一定会往下讲"。
 *
 * 本文件是**纯逻辑**：不读时钟、不碰 IO、不起定时器。时间一律由调用方以 `at` 传进来，
 * 所以每条规则都能被确定性地单测（真机上这些分支几乎没法复现）。
 */

export interface FollowupOptions {
  /** 没人说话时等多久就继续讲。 */
  readonly waitMs: number
  /** 从开窗算起，最多延长到这里（含连续说话）。 */
  readonly maxExtendMs: number
}

/** 默认 5 秒等待、最多延长到 30 秒。 */
export const DEFAULT_FOLLOWUP: FollowupOptions = { waitMs: 5_000, maxExtendMs: 30_000 }

export type FollowupEvent =
  /** 反问念完了，开始计时。 */
  | { readonly kind: 'start'; readonly at: number }
  /** ASR 识别文本变长：真的有人在说话（**不是** VAD/能量）。 */
  | { readonly kind: 'speech'; readonly at: number }
  /** 用户明确说"继续/往下/接着"。 */
  | { readonly kind: 'explicit-continue'; readonly at: number }
  /** 轮询：到点没有就收束。 */
  | { readonly kind: 'tick'; readonly at: number }
  /** 讲解被停/被换绑/窗口关闭：任何情况下都不许在 5 秒后自己念。 */
  | { readonly kind: 'cancel' }

export type FollowupAction =
  /** 窗口没开或已关闭，调用方什么都不用做。 */
  | 'idle'
  /** 还在等，调用方保持现状。 */
  | 'waiting'
  /** 该继续讲了（到点、超上限、或用户明确要求）。 */
  | 'continue'

export interface FollowupState {
  readonly active: boolean
  readonly startedAt: number
  /** 当前倒计时截止时刻（有人说话会往后推）。 */
  readonly deadline: number
  /** 最长延长上限，到点强制收束。 */
  readonly hardDeadline: number
  readonly lastSpeechAt: number
}

const IDLE: FollowupState = { active: false, startedAt: 0, deadline: 0, hardDeadline: 0, lastSpeechAt: 0 }

export function initialFollowup(): FollowupState {
  return IDLE
}

/**
 * 吃一个事件，吐出下一个状态与要执行的动作。
 *
 * 状态机的关键性质（都有用例钉住）：
 * 1. `speech` 只会把 `deadline` 往后推，且**永远不超过** `hardDeadline`；
 * 2. `tick` 到 `deadline` 或 `hardDeadline` 任一时刻就收束成 `continue`；
 * 3. 非 active 时 `speech`/`tick`/`explicit-continue` 一律不产生 `continue`
 *    —— 关掉的窗口不会因为迟到的 ASR 又活过来；
 * 4. `cancel` 回到初始态，且不产生动作。
 */
export function reduceFollowup(
  state: FollowupState,
  event: FollowupEvent,
  options: FollowupOptions = DEFAULT_FOLLOWUP,
): { state: FollowupState; action: FollowupAction } {
  switch (event.kind) {
    case 'start':
      return {
        state: {
          active: true,
          startedAt: event.at,
          deadline: event.at + options.waitMs,
          hardDeadline: event.at + options.maxExtendMs,
          lastSpeechAt: event.at,
        },
        action: 'waiting',
      }
    case 'speech': {
      if (!state.active) return { state, action: 'idle' }
      // 已经到上限了就不再推：再推就等于让识别器把讲解无限期按在地上。
      if (event.at >= state.hardDeadline) return { state, action: 'waiting' }
      return {
        state: { ...state, deadline: Math.min(event.at + options.waitMs, state.hardDeadline), lastSpeechAt: event.at },
        action: 'waiting',
      }
    }
    case 'tick': {
      if (!state.active) return { state, action: 'idle' }
      // 两个截止时刻任一到达都收束：deadline 是"没人说话了"，hardDeadline 是"一直在说话"。
      if (event.at >= state.deadline || event.at >= state.hardDeadline) {
        return { state: { ...state, active: false }, action: 'continue' }
      }
      return { state, action: 'waiting' }
    }
    case 'explicit-continue': {
      // 关掉的窗口不认指令：可能是别的语境里说的"继续"，不能凭它去推讲解。
      if (!state.active) return { state, action: 'idle' }
      return { state: { ...state, active: false }, action: 'continue' }
    }
    case 'cancel':
      return { state: IDLE, action: 'idle' }
  }
}

/** 明确要求继续时的最大字数。超过这个长度就是一句话，不是给讲解链的指令。 */
export const EXPLICIT_CONTINUE_MAX_CHARS = 12
const CONTINUE_WORDS = /(继续|往下|接着|下一个|下一段)/u
const QUESTION_MARK = /[？?]/u
/**
 * 疑问词。规格只要求"含问号按提问处理"，这里额外挡一次：短句里带疑问词的同样不是指令
 * （"接着讲是什么意思"没有问号，但它确实在提问）。多挡一层的代价只是让模型多答一句，
 * 少挡一层的代价是把用户的问题吞掉。
 */
const QUESTION_WORDS = /(什么|怎么|为什么|如何|哪|吗|呢|是不是|能不能)/u

/**
 * 这句话是不是"明确要求继续"。
 *
 * 窄匹配的三道闸：去掉尾标点后**整句 ≤ 12 字**、命中继续类词、且没有问号/疑问词。
 * 命中后调用方直接续讲并**不把这句话发给模型** —— 它是给讲解链的指令，
 * 发给模型会多绕一次往返、还会把 5 秒窗口白白耗掉。
 */
export function isExplicitContinue(text: string): boolean {
  if (typeof text !== 'string') return false
  const said = text.trim().replace(/[。！!，,、\s]+$/u, '')
  if (said === '') return false
  if ([...said].length > EXPLICIT_CONTINUE_MAX_CHARS) return false
  if (QUESTION_MARK.test(said) || QUESTION_WORDS.test(said)) return false
  return CONTINUE_WORDS.test(said)
}

/**
 * 休息模式的恢复指令：比 {@link isExplicitContinue} 更严，必须**整句就是"继续"**。
 *
 * 休息时参会人在互相讨论，"我们继续讨论这个问题"里也带"继续"，但那是讨论不是恢复指令。
 * 所以剥掉客套前缀（你/我们/请…）与语气尾缀（吧/啊/了…）后，剩下的必须恰好是
 * "继续/接着/往下 [+ 讲/演讲/说/念/讲解]"本身，多一个字（讨论、这个问题）都不算。
 */
export function isRestResume(text: string): boolean {
  if (!isExplicitContinue(text)) return false
  const said = text.trim().replace(/[。！!，,、\s]+$/u, '')
  const core = said
    .replace(/^(?:请|麻烦|你们|我们|你|我|那就|那|好|行|嗯|哎)+/u, '')
    .replace(/(?:吧|啊|呀|了|喔|哦)+$/u, '')
  return /^(?:继续|接着|往下)(?:讲|演讲|说|念|讲解)?$/u.test(core)
}
