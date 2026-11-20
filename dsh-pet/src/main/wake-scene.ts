/**
 * 唤醒的"场景判定"：同一个唤醒词，在什么场合该应、在什么场合该装没听见。
 *
 * 两件事都只跟场景有关、跟模型无关，所以抽成纯函数放在这里：
 * 1. **声纹没过要不要放行** —— 讲解是公开场合，听众提问不该被声纹挡住（硬要求）；
 *    而播报回答是私密场合，旁人/电视说话不能把正在念的回答打断。
 * 2. **播报中要不要响应唤醒** —— 用户可配置（`wakeDuringSpeech`），默认不响应。
 *
 * 为什么不在 `onWakeWord` 里判声纹：声纹过滤发生在 KWS 层（那里才有 score），
 * 命中与否是 KWS 给的结论，`onWakeWord` 拿不到分数，也就没法在那一层补救。
 */

/**
 * 讲解会话的形状（只取判定要用的两个字段，方便单测直接构造）。
 *
 * **注意 `stopped` 不参与判定**：`pauseDocTalk()` 只置 `stopped = true`、不清引用，
 * 而每次插话都会 pause、反问那 5 秒里也一直是 paused。所以"讲解中"必须按
 * 「会话还在（docTalk 非空）且是出声讲解」来判，不能看 stopped ——
 * 否则「A 提问 → 暂停 → 回答 → 等 5 秒 → B 也想问」这条链上 B 会被声纹挡在门外。
 */
export interface DocTalkLike {
  readonly spoken: boolean
  readonly stopped: boolean
}

/**
 * 现在是不是"讲给听众听"的场合。
 *
 * - `docTalk === null`（没在讲 / 已经 stopDocTalk 掉）→ 否；
 * - `spoken === false`（只是文字提纲、不出声）→ 否：那不是公开讲解，保持原有声纹规则；
 * - 其余（含被插话暂停的那几秒）→ 是。
 */
export function isPresenting(talk: DocTalkLike | null): boolean {
  if (talk === null) return false
  return talk.spoken
}

export interface VoiceprintScene {
  /**
   * 讲解会话还在（出声讲解，**暂停中也算**）：这是"讲给听众听、随时可被打断提问"的场合。
   * 刻意不看 `stopped` —— 每次插话都会 pause，而听众连续提问恰恰发生在暂停期间；
   * 看 stopped 会把第二个提问的人挡在声纹外面（见 isPresenting 的注释与用例）。
   */
  readonly presenting: boolean
}

/**
 * 声纹未通过时是否仍然放行。
 *
 * - 讲解中：**放行**。文档讲解天然是公开的 —— 听众喊一句"这里为什么这么设计"正是产品要的；
 *   用声纹把人挡在门外，等于把讲解变成单人朗读。
 * - 其他场景（回答播报、待机）：**不放行**。旁人的说话、电视里的人声都不该把它叫起来。
 */
export function shouldPassWithoutVoiceprint(scene: VoiceprintScene): boolean {
  return scene.presenting
}

export interface WakeGateScene {
  readonly presenting: boolean
  /** 用户设置：播报中也响应唤醒（默认 false）。 */
  readonly wakeDuringSpeech: boolean
  /** 此刻是否有语音在播（讲解或回答）。 */
  readonly speaking: boolean
}

/**
 * 播报中要不要忽略这次唤醒。
 *
 * - 讲解中永不忽略：讲解期间被打断是常态，也是产品要的。
 * - 用户打开 `wakeDuringSpeech` 后永不忽略：他明确表示"我说话你就应"。
 * - 其余情况（默认配置）：正在播报就忽略 —— 用户没在等它，别人（或电视）说话不该把
 *   正在念的回答打断。
 */
export function shouldIgnoreWakeDuringSpeech(scene: WakeGateScene): boolean {
  if (scene.presenting) return false
  if (scene.wakeDuringSpeech) return false
  return scene.speaking
}
