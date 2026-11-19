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
 * 讲解中直接提问的"像话"判据：去掉空白、标点与符号后至少三个字。
 *
 * 讲解里不要求先说"停一下"（主进程返回 direct），但回声、咳嗽、键盘声，以及
 * **被截断的口令尾巴**（例如"停一下"只识别出"一下"）经常只有一两个字；
 * 这类结果既不该停讲解，也不该变成一条用户消息送给模型。
 */
export const plausibleDirectQuestion = (text: string): boolean =>
  text.replace(/[\s\p{P}\p{S}]/gu, '').length >= 3

/**
 * 口令式打断：只有明确说了「停一下 / 等等 / 等一下 / 打断一下」这类词才打断朗读。
 *
 * 为什么需要它：外放时麦克风会收到助理自己的声音（回声消除之后仍可能残留），若把任何声音
 * 都当插话，朗读会不停被自己的回声打断——用户看到的就是"说一半自己停了"。口令是用户
 * 最小、可验证的意图。
 *
 * 返回去掉口令后的剩余内容：用户可能一口气说「停一下，这一段是什么意思」。
 */
const INTERRUPT_PREFIX = /^(?:请?停一下|先停(?:一下)?|停一停|停停|停下来|暂停一下|暂停|稍等(?:一下)?|等等|等一等|等一下|等会(?:儿)?|打断一下|打断|别说了|先别说|安静一下)[，,。.！!？?、\s]*/u
const INTERRUPT_EXACT = /^(?:停|安静|别吵)[嘛啊呀吧。！!，,\s]*$/u
/**
 * 口令前的客套/口头语：`稍微等一下`、`请你停一下`、`麻烦先停一下` 都是同一个意思。
 * 只在"后面紧跟口令"时剥掉（最多剥一次），真提问里出现"停一下"不会被劫持。
 */
const INTERRUPT_FILLER = /^(?:(?:嗯+|额+|那个|就是|麻烦|请您?|我说|我想|我要|你|我(?:们)?|先|稍微|要不|帮我|能不能|可以)[，,。.！!？?、\s]*)+/u

export interface InterruptPhrase {
  readonly matched: boolean
  /** 去掉口令后的剩余内容（可能为空：只说了一句"停一下"，那就停下再听）。 */
  readonly rest: string
}

function matchInterrupt(trimmed: string): InterruptPhrase | null {
  if (INTERRUPT_EXACT.test(trimmed)) return { matched: true, rest: '' }
  const match = INTERRUPT_PREFIX.exec(trimmed)
  if (match === null) return null
  return { matched: true, rest: trimmed.slice(match[0].length).trim() }
}

export function parseInterruptPhrase(text: string): InterruptPhrase {
  const trimmed = text.trim()
  const direct = matchInterrupt(trimmed)
  if (direct !== null) return direct
  const stripped = trimmed.replace(INTERRUPT_FILLER, '')
  if (stripped !== trimmed) {
    const polite = matchInterrupt(stripped)
    if (polite !== null) return polite
  }
  return { matched: false, rest: trimmed }
}

/**
 * 休息口令：「休息一下 / 休息一会儿」。进入无限期休息（不听提问），只认整句"继续"恢复。
 *
 * 必须带"一下/一会儿/片刻"这类时长词：光一个"休息"在讨论里太常见（"我们休息讨论一下"），
 * 带上时长词才是明确的"停下来歇着"指令，与提问暂停（停一下）分开。
 */
const REST_PREFIX = /^(?:请|麻烦|大家|我们|你们|先)?休息(?:一下|一会儿|一会(?:儿)?|片刻)[，,。.！!？?、\s]*/u

/** 讲解插话可以直接提问；单独的停止口令需要接着听问题；休息口令进入无限期休息。 */
export function planInterruptInput(text: string, direct: boolean):
  { action: 'ignore' | 'direct' | 'listen' | 'rest' } | { action: 'send'; text: string } {
  const trimmed = text.trim()
  if (REST_PREFIX.test(trimmed) || REST_PREFIX.test(trimmed.replace(INTERRUPT_FILLER, ''))) return { action: 'rest' }
  const phrase = parseInterruptPhrase(text)
  if (!phrase.matched) return { action: direct ? 'direct' : 'ignore' }
  return phrase.rest ? { action: 'send', text: phrase.rest } : { action: 'listen' }
}

const normForEcho = (text: string): string => text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()

/**
 * 这句口令是不是"念稿回声"：外放时麦克风把助理正在念的正文录了回来。
 *
 * 文档里恰好有"停一下"，念到那里时麦克风识别出"停一下"，会被当成真口令误停。
 * 判据：识别出的口令核心**落在当前正在念的段落里** → 是念稿回声，忽略。用户真喊口令时
 * 念的段落里没有这几个字 → 照常打断。代价：用户喊的口令恰好与当前念的字一样会被吞，按快捷键即可。
 */
export function isNarrationEcho(text: string, narration: string): boolean {
  const narr = normForEcho(narration)
  if (narr.length === 0) return false
  const trimmed = text.trim()
  const direct = matchInterrupt(trimmed)
  const stripped = trimmed.replace(INTERRUPT_FILLER, '')
  const phrase = direct ?? (stripped !== trimmed ? matchInterrupt(stripped) : null)
  if (phrase === null) return false
  const source = direct !== null ? trimmed : stripped
  const core = normForEcho(source.slice(0, source.length - phrase.rest.length))
  return core.length > 0 && narr.includes(core)
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
