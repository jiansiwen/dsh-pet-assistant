/**
 * 自回声过滤：把"助理自己刚说过的话"从语音识别结果里剔掉。
 *
 * 为什么需要它：唤醒应答是外放的，而紧接着就要开麦克风听用户说话。两者一重叠，
 * 麦克风就会录到助理自己的声音 —— 现场症状是对话里凭空多出一句「我在这。」
 * （助理说的是「我在这儿，你说。」，识别后变成这样）。
 *
 * 两道防线一起用：
 * 1. 时间上先等应答播完再开麦（在 App 的唤醒处理里）；
 * 2. 内容上把最近说过的话记下来，识别结果与之高度相似就丢弃。
 *
 * 只做"高度相似"而不是"包含"：用户可能接着说"我在这，帮我看看这个"，
 * 那种情况必须放行 —— 宁可偶尔漏掉一句回声，也不能吞掉用户真正说的话。
 */

/** 最近说过的话保留多久。太短挡不住慢一点的识别，太长会误伤用户重复我们的话。 */
export const SELF_SPEECH_TTL_MS = 12_000

interface RecentSpeech {
  readonly text: string
  readonly at: number
}

const recent: RecentSpeech[] = []

function normalize(text: string): string {
  return text.replace(/[\s，。！？、,.!?;；:："'“”‘’（）()《》【】\-—…]/gu, '').toLowerCase()
}

/** 记一句"助理刚说过的话"。调用方在把文本交给 TTS 时记一次即可。 */
export function rememberSelfSpeech(text: string, now = Date.now()): void {
  const clean = normalize(text)
  if (clean.length === 0) return
  recent.push({ text: clean, at: now })
  // 只留最近几条：再多也没有意义，识别结果只可能对上刚说的那一句。
  while (recent.length > 8) recent.shift()
}

function sameOrNearly(a: string, b: string): boolean {
  if (a === b) return true
  // 长度差太多直接判不同：避免"我在这"命中"我在这儿你说"以外的无关内容。
  if (Math.abs(a.length - b.length) > Math.max(3, Math.min(a.length, b.length) * 0.6)) return false
  // 一个是另一个的前缀（识别常截断尾部）也算同一句。
  if (a.startsWith(b) || b.startsWith(a)) return true
  // 编辑距离不超过较短者长度的 40%：容忍识别错字（在这 / 在这儿）。
  const distance = levenshtein(a, b)
  const limit = Math.max(1, Math.floor(Math.min(a.length, b.length) * 0.4))
  return distance <= limit
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[b.length]
}

/**
 * 这段识别结果是不是助理自己刚说过的话（应当丢弃）。
 *
 * 判断完就把匹配到的那条移除：同一句回声只该被挡一次，否则用户重复一次会被一直吞掉。
 */
export function isSelfSpeech(text: string, now = Date.now()): boolean {
  const clean = normalize(text)
  if (clean.length === 0) return false
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const entry = recent[index]
    if (now - entry.at > SELF_SPEECH_TTL_MS) continue
    if (!sameOrNearly(clean, entry.text)) continue
    recent.splice(index, 1)
    return true
  }
  return false
}

/** 测试用：清空记录。 */
export function resetSelfSpeech(): void {
  recent.length = 0
}
