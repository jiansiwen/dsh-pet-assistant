/**
 * 唤醒词的名字规则。
 *
 * 只允许 2–5 个汉字：KWS 模型按拼音声母/韵母建模，英文、数字、标点都没有对应 token；
 * 太短在中文句子里到处都是，太长用户喊着费劲。改名的真正校验在 `kws.ts`：要拿
 * 拆分后的 token 去对模型自己的 tokens.txt，模型不认识的读音只能换名。
 */
export const DEFAULT_WAKE_NAME = '小潘同学'

const WAKE_NAME_PATTERN = /^[\u4e00-\u9fff]{2,5}$/u

export function normalizeWakeName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_WAKE_NAME
  const name = value.trim()
  return WAKE_NAME_PATTERN.test(name) ? name : DEFAULT_WAKE_NAME
}

/** 给设置页用：为什么这个名字不能保存。合法返回 null。 */
export function wakeNameProblem(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name === '') return '唤醒词不能为空'
  if (!WAKE_NAME_PATTERN.test(name)) return '唤醒词只能是 2–5 个汉字（模型按拼音识别，不支持字母、数字和标点）'
  return null
}
