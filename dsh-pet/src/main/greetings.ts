/**
 * 唤醒应答话术：不再是一句固定的"我在呢！找我什么事？"。
 *
 * 同一句话听一百次会变成噪音，而唤醒应答恰恰是用户最常听到的一句话。这里给一组
 * 语气不同、长度相近的说法，每次随机挑一句——短，是因为它只是"我听见了"的信号，
 * 真正要听的内容在后面的回答里。
 *
 * 全部是纯文本常量：能被测试逐条钉住（不出现怪字符、不超长），也让"合成哪些句子"
 * 这件事有一个唯一来源 —— 预合成缓存正是按这份清单工作的。
 */

/** 唤醒应答。短、明确、不像机器人报幕。 */
export const WAKE_GREETINGS: readonly string[] = [
  '我在呢，说吧。',
  '来啦，你说。',
  '嗯，我听着呢。',
  '在的，什么事？',
  '我在这儿，你说。',
  '好的，你说吧。',
  '听着呢，请讲。',
  '在呢，需要我做什么？',
  '嗯哼，我在。',
  '这就来，你说。',
]

/** 用户只说口令、还没说内容时（例如打断后只说了"停一下"）。 */
export const INTERRUPT_ACKS: readonly string[] = [
  '好的，停下了，你说。',
  '停下了，我在听。',
  '好，不说了，你讲。',
  '停了，你说吧。',
]

/** 一条应答最长多少字。超过它说明这不该是"应答"，而是回答正文。 */
export const MAX_GREETING_CHARS = 20

/**
 * 又只喊了一句名字时的本地应答（不进会话、不调模型）。
 *
 * 与渲染层那份清单保持一致：这里负责把它们一起预热进缓存，
 * 否则这几句每句都要当场联网合成，用户听到的就是"有时候要等好几秒"。
 */
export const LOCAL_ACKS: readonly string[] = [
  '我在，你说。',
  '嗯，我听着。',
  '你说吧，我在听。',
  '来了，什么事？',
]

/** 从一份清单里挑一句；可以传入随机源，测试里就能固定结果。 */
export function pickPhrase(list: readonly string[], random: () => number = Math.random): string {
  if (list.length === 0) return ''
  const index = Math.floor(random() * list.length)
  return list[Math.min(Math.max(index, 0), list.length - 1)]
}

/**
 * 需要预合成的全部固定话术（去重）。
 *
 * 缓存按音色分组：换音色时旧音频对不上，必须重新合成——这正是调用方要拿它当键的原因。
 */
export function fixedPhrases(): string[] {
  return [...new Set([...WAKE_GREETINGS, ...INTERRUPT_ACKS, ...LOCAL_ACKS])]
}
