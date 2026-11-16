/**
 * 邮件分析 → 结构化建议。
 *
 * 为什么必须有这一层：邮箱值守现在只会吐**一段文字**（`mail-watch.ts` 把模型回复原样存进
 * `completeMailWatchAnalysis`）。文字没法变成待批提案，也就没法"授权后直接执行"——
 * 用户只能自己复制粘贴。把产出改成结构化建议，后面的规则与常驻授权才有落点。
 *
 * 三条纪律：
 *
 * 1. **解析失败不丢分析**：模型没按格式回，就整段当摘要保存。宁可少一条建议，
 *    不能因为格式不对把"这封邮件需要你处理"这个结论一起丢掉。
 * 2. **单条非法只丢那一条**，不整批作废：九条建议里有一条字段写错，其余八条仍然有用。
 * 3. **kind 与 risk 是白名单**：它们是下游"要不要自动执行、走哪种审批"的依据，
 *    必须代码认得出的值。模型发明一个新 kind，我们既不会执行也不该假装认识。
 */

export const SUGGESTION_KINDS = ['draft-sql', 'open-ticket', 'reply-mail', 'manual-step', 'none'] as const
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number]

export const SUGGESTION_RISKS = ['low', 'medium', 'high'] as const
export type SuggestionRisk = (typeof SUGGESTION_RISKS)[number]

export interface MailSuggestion {
  /** 邮件在 IMAP 里的 uid；模型可以不填，后续由调用方补齐。 */
  uid: number | null
  kind: SuggestionKind
  /** 一句话说明这封邮件要做什么。 */
  title: string
  /** 具体内容：SQL 草稿、回复正文、操作步骤。 */
  payload: string
  risk: SuggestionRisk
  /** 为什么这么判断：给本人核对时看的依据。 */
  rationale: string
}

export interface ParsedAnalysis {
  /** 桌面摘要（≤400 字），没有建议时也要有这一段。 */
  summary: string
  suggestions: MailSuggestion[]
  /** 是否成功按结构化格式解析；false 时 suggestions 必为空、summary 是原文。 */
  structured: boolean
}

const MAX_SUMMARY = 400
const MAX_TITLE = 200
const MAX_PAYLOAD = 8000
const MAX_RATIONALE = 600
/** 一轮最多认几条建议：再多就不是"逐封给建议"，是模型在编。 */
export const MAX_SUGGESTIONS = 12

const clip = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

const oneOf = <T extends readonly string[]>(list: T, value: unknown): T[number] | null =>
  typeof value === 'string' && (list as readonly string[]).includes(value) ? value as T[number] : null

function uid(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/** 从回复里取出 JSON 对象：优先围栏代码块，其次整段，最后尝试首个 `{` 到末个 `}`。 */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/giu
  let last: string | null = null
  for (const match of text.matchAll(fenced)) last = match[1]
  const candidates = [last, text, (() => {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    return start >= 0 && end > start ? text.slice(start, end + 1) : null
  })()]
  for (const candidate of candidates) {
    if (candidate === null || candidate.trim() === '') continue
    try { return JSON.parse(candidate) } catch { /* 试下一种 */ }
  }
  return null
}

/**
 * 把一条原始建议归一；不合法返回 null（只丢这一条）。
 *
 * `none` 是允许的：它表示"这封邮件我看了，不需要你处理"，比让模型硬凑一个动作诚实。
 */
export function normalizeSuggestion(raw: unknown): MailSuggestion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  const kind = oneOf(SUGGESTION_KINDS, input.kind)
  if (kind === null) return null
  const risk = oneOf(SUGGESTION_RISKS, input.risk) ?? 'medium'
  const title = clip(input.title, MAX_TITLE)
  if (title === '') return null
  const payload = clip(input.payload, MAX_PAYLOAD)
  // none / manual-step 可以没有 payload（"不用处理"和"你手动看一下"本来就没有草稿）；
  // 其余三种必须有实质内容，否则批下去也没东西可执行。
  if (payload === '' && kind !== 'none' && kind !== 'manual-step') return null
  return { uid: uid(input.uid), kind, title, payload, risk, rationale: clip(input.rationale, MAX_RATIONALE) }
}

/**
 * 解析值守成员的一次分析回复。
 *
 * 兼容三种形态（都见过）：
 * - 规范 JSON（可能包在 ```json 里）；
 * - 带前后说明的 JSON；
 * - 完全不合格式的纯文字 —— 整段当摘要。
 */
export function parseMailAnalysis(reply: string): ParsedAnalysis {
  const text = typeof reply === 'string' ? reply : ''
  const fallback: ParsedAnalysis = { summary: text.trim().slice(0, MAX_SUMMARY), suggestions: [], structured: false }
  if (text.trim() === '') return fallback

  const parsed = extractJson(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback
  const record = parsed as Record<string, unknown>
  const rawList = Array.isArray(record.suggestions) ? record.suggestions : []
  const suggestions: MailSuggestion[] = []
  for (const item of rawList) {
    if (suggestions.length >= MAX_SUGGESTIONS) break
    const normalized = normalizeSuggestion(item)
    if (normalized !== null) suggestions.push(normalized)
  }
  const summary = clip(record.summary, MAX_SUMMARY)
  // 有 JSON 但既没摘要也没可用建议：等于没解析成功，退回原文更安全。
  if (summary === '' && suggestions.length === 0) return fallback
  return { summary: summary === '' ? '（没有摘要，只有结构化建议）' : summary, suggestions, structured: true }
}
