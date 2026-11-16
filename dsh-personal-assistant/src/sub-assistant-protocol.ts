/**
 * 子助理统一回执协议：适配层（platform-agent / cli-agent）与分派层共用的出参形状。
 *
 * - `reply` / `out-of-scope` 来自子助理本体（外部平台或本地 CLI 工具按协议约定输出）；
 * - `timeout` / `error` 只由适配层产生，如实分类、绝不伪装成功。
 *
 * 协议约定（随 system 消息注入子助理；见设计 4.5.3）：
 * 子助理只处理分派给它且在其能力与权限内的任务；需要本地文件操作、执行命令、
 * 访问本系统其他成员/工具时，返回 out-of-scope 并说明缺什么能力。
 */
import { randomUUID } from 'node:crypto'

export type SubAssistantReceipt =
  | { readonly kind: 'reply'; readonly text: string }
  | { readonly kind: 'out-of-scope'; readonly reason: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'error'; readonly text: string }

export type SubAssistantMessage = { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }

/** 注入子助理 system 消息的协议约定片段；由分派层拼在人设之后。 */
export const SUB_ASSISTANT_PROTOCOL_PROMPT = [
  '你是被分派任务的子助理。请只处理分派给你、且在你的平台能力与权限范围内的任务。',
  '任务需要本地文件操作、执行命令、访问本系统的其他成员或工具时，不要尝试完成，只返回一行 JSON：',
  '{"kind":"out-of-scope","reason":"<具体缺少什么能力或权限>"}',
  '正常完成时返回一行 JSON：{"kind":"reply","text":"<结果>"}',
  '除这一行 JSON 外不要输出任何其他内容。',
].join('\n')

/**
 * 把子助理原始回复解析为回执：整体是协议 JSON 就结构化；否则整段按普通回复处理
 * （模型没遵守协议时保底可用，不因格式丢弃结果）。
 */
export function tryProtocolReceipt(text: string): SubAssistantReceipt {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const value = JSON.parse(trimmed) as { kind?: unknown; text?: unknown; reason?: unknown }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (value.kind === 'reply' && typeof value.text === 'string' && Object.keys(value).length === 2) {
          return { kind: 'reply', text: value.text }
        }
        if (value.kind === 'out-of-scope' && typeof value.reason === 'string' && Object.keys(value).length === 2) {
          return { kind: 'out-of-scope', reason: value.reason }
        }
      }
    } catch { /* 不是协议 JSON：按普通回复处理 */ }
  }
  return { kind: 'reply', text }
}

/** 一次子助理分派调用的标识：适配层请求/回执配对与幂等去重共用。 */
export function newDispatchId(): string {
  return randomUUID()
}
