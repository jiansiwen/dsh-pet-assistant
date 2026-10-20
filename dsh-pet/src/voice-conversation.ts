import type { VoiceTurn, VoiceTurnCompletion } from './session-types.ts'

export const CONTINUOUS_VOICE_LIMIT_MS = 5 * 60_000
export const CONTINUOUS_VOICE_MAX_ROUNDS = 10
/**
 * 回复播完后继续听多久。
 *
 * 用户的口径是"AI 回复完成之后持续监听"：一句话说完常常要想想下一句，
 * 一停就关麦克风会让人每次都得重新喊名字。10 秒够把话接上，又不会
 * 在用户已经走开时一直开着麦克风。静默到达这个时长即结束整场连续对话。
 */
export const CONTINUOUS_IDLE_TIMEOUT_MS = 10_000
export type VoicePhase = 'stopped' | 'waiting' | 'recording' | 'generating' | 'playing'
export const isVoiceStop = (text: string): boolean => /^(先这样|结束对话|停止对话)[。！!，,\s]*$/u.test(text.trim())

/**
 * 口令式打断：只有明确说了「停一下 / 等等 / 等一下 / 打断一下」这类词才打断朗读。
 *
 * 为什么需要它：外放时麦克风会收到助理自己的声音（回声消除之后仍可能残留），若把任何声音
 * 都当插话，朗读会不停被自己的回声打断——用户看到的就是"说一半自己停了"。口令是用户
 * 最小、可验证的意图。
 *
 * 返回去掉口令后的剩余内容：用户可能一口气说「停一下，这一段是什么意思」。
 */
const INTERRUPT_PREFIX = /^(?:请?停一下|停一停|停停|停下来|暂停一下|暂停|等等|等一等|等一下|打断一下|打断|别说了|先别说|安静一下)[，,。.！!？?、\s]*/u
const INTERRUPT_EXACT = /^(?:停|安静|别吵)[嘛啊呀吧。！!，,\s]*$/u

export interface InterruptPhrase {
  readonly matched: boolean
  /** 去掉口令后的剩余内容（可能为空：只说了一句"停一下"，那就停下再听）。 */
  readonly rest: string
}

export function parseInterruptPhrase(text: string): InterruptPhrase {
  const trimmed = text.trim()
  if (INTERRUPT_EXACT.test(trimmed)) return { matched: true, rest: '' }
  const match = INTERRUPT_PREFIX.exec(trimmed)
  if (match === null) return { matched: false, rest: trimmed }
  return { matched: true, rest: trimmed.slice(match[0].length).trim() }
}

/** 只管理本地语音生命周期；不拥有模型或共享会话的取消权。 */
export class VoiceConversation {
  phase: VoicePhase = 'stopped'
  generation = 0
  bindingId = ''
  rounds = 0
  deadline = 0
  /** 连续静默到这一刻就结束整场对话；0 = 还没开始计时。 */
  idleDeadline = 0
  private turn: VoiceTurn | null = null
  private resultOk = false
  private played = false

  get active(): boolean { return this.phase !== 'stopped' }

  start(bindingId: string, voiceConversation: boolean, continuousVoice: boolean, now = Date.now()): boolean {
    if (this.active || !bindingId || !voiceConversation || !continuousVoice) return false
    this.generation++
    this.bindingId = bindingId
    this.rounds = 0
    this.deadline = now + CONTINUOUS_VOICE_LIMIT_MS
    this.phase = 'waiting'
    this.awaiting(now)
    return true
  }

  /**
   * 重新开始等用户开口：静默窗从这一刻起算。
   *
   * 开麦前调用（回复播完续听、外放插话接管）。放在这里而不是写在 `start()` 里，
   * 是因为麦克风真正打开的时刻可能比状态推进晚几百毫秒，静默窗必须按"开始听"计。
   */
  awaiting(now = Date.now()): void {
    if (!this.active) return
    this.idleDeadline = now + CONTINUOUS_IDLE_TIMEOUT_MS
  }

  valid(generation: number, bindingId: string, now = Date.now()): boolean {
    if (!this.active || this.generation !== generation || this.bindingId !== bindingId) return false
    if (now >= this.deadline) return false
    // 静默窗只在"等用户开口"时成立：生成与播放期间用户本来就不出声，拿它判有效
    // 会让稍长一点的回答播完当场就不算数（现场现象：说一句语音输入就关掉了）。
    return this.phase !== 'waiting' || now < this.idleDeadline
  }

  record(generation: number, bindingId: string, now = Date.now()): boolean {
    if (!this.valid(generation, bindingId, now) || this.phase !== 'waiting') return false
    this.phase = 'recording'
    return true
  }

  submit(now = Date.now()): VoiceTurn | null {
    if (!this.valid(this.generation, this.bindingId, now) || this.phase !== 'recording') return null
    this.rounds++
    this.turn = { bindingId: this.bindingId, generation: this.generation, roundId: `${this.generation}:${this.rounds}` }
    this.resultOk = false
    this.played = false
    this.phase = 'generating'
    return this.turn
  }

  private matches(turn: VoiceTurn, now: number): boolean {
    return this.valid(turn.generation, turn.bindingId, now) && this.turn?.roundId === turn.roundId
  }

  result(turn: VoiceTurn, ok: boolean, now = Date.now()): boolean {
    if (!this.matches(turn, now)) return false
    if (!ok) { this.stop(); return false }
    this.resultOk = true
    this.phase = 'playing'
    return this.advance(now)
  }

  complete(event: VoiceTurnCompletion, now = Date.now()): boolean {
    if (!this.matches(event, now)) return false
    if (event.outcome !== 'played') { this.stop(); return false }
    this.played = true
    return this.advance(now)
  }

  /**
   * 朗读结束（界面从"正在出声"变成"不出声"）。
   *
   * 与 {@link complete} 等价，但驱动源是播放状态而不是回执：回执可能迟到或丢失，
   * 而用户听到的"它说完了"就是这一刻。两处都调用是幂等的 —— 先到的那次推进，
   * 后到的那次因为 turn 已清空而什么都不做。
   */
  finishPlaying(now = Date.now()): boolean {
    if (this.phase !== 'playing') return false
    this.played = true
    return this.advance(now)
  }

  private advance(now: number): boolean {
    if (!this.resultOk || !this.played) return false
    this.turn = null
    if (this.rounds >= CONTINUOUS_VOICE_MAX_ROUNDS || now >= this.deadline) { this.stop(); return false }
    // 静默计时从"回复说完"这一刻重新起算：用户接着问就继续，静默满 10 秒才收摊。
    this.awaiting(now)
    this.phase = 'waiting'
    return true
  }

  stop(): void {
    // 必须先失效代号，调用方之后才停麦克风和播报。
    this.generation++
    this.phase = 'stopped'
    this.turn = null
    this.idleDeadline = 0
  }

  /**
   * 外放插话（M1-05）：用户在回答生成 / 播放期间开口了。本轮作废（之后到达的 result / complete
   * 因为对不上 roundId 一律被忽略），直接回到"等着听"，让调用方马上按续听开麦 —— 插话本身就是下一轮。
   * 代号不变：这仍是同一场连续对话，上限与墙钟截止照旧。只在 generating / playing 时成立。
   */
  interruptForBargeIn(now = Date.now()): boolean {
    if (!this.valid(this.generation, this.bindingId, now)) return false
    if (this.phase !== 'generating' && this.phase !== 'playing') return false
    this.turn = null
    this.phase = 'waiting'
    return true
  }
}
