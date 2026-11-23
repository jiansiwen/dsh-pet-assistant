/**
 * 平台子助理适配层：OpenAI 兼容 chat/completions 客户端。
 *
 * 纪律与桌宠 voice-api.ts 的请求函数同源：
 * - 端点只认 https 或本机回环（录入侧已校验，这里补路径后缀）；
 * - 密钥只进 Authorization 头，不进 URL、不进日志；
 * - redirect: 'error'，不跟随重定向（防密钥头被带去别处）；
 * - 超时/认证失败/网络错误如实分类为回执，绝不伪装成功。
 */
import type { PlatformBinding } from './member-contract.ts'
import { tryProtocolReceipt, type SubAssistantMessage, type SubAssistantReceipt } from './sub-assistant-protocol.ts'

const MB = 1024 * 1024

/** 端点路径补全：不以 /chat/completions 结尾时补上（与 voice-api endpointOf 的后缀纪律一致）。 */
export function completionsUrl(endpoint: string): string {
  const url = new URL(endpoint)
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions'
  return url.href
}

export class PlatformAgent {
  private readonly binding: PlatformBinding
  private readonly resolveKey: (secretId: string) => string

  /** resolveKey 由装配层注入（单元 5 接 SubAssistantSecrets.resolve）；测试可注入假解析器。 */
  constructor(binding: PlatformBinding, resolveKey: (secretId: string) => string) {
    this.binding = binding
    this.resolveKey = resolveKey
  }

  /** 一次平台调用。messages 由会话层（Registry）维护历史；本方法无状态、可重入。 */
  async send(messages: ReadonlyArray<SubAssistantMessage>, timeoutMs: number): Promise<SubAssistantReceipt> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return { kind: 'error', text: '平台调用超时参数无效' }
    const key = this.binding.secretId === '' ? '' : this.resolveKey(this.binding.secretId)
    if (this.binding.secretId !== '' && key === '') {
      return { kind: 'error', text: '平台密钥未配置或不可用，请先在成员设置中录入密钥' }
    }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    try {
      const headers = new Headers({ 'content-type': 'application/json' })
      if (key) headers.set('Authorization', `Bearer ${key}`)
      // 平台靠 X-Agent-Id / 请求体 agentId 指定智能体（二者任一即可，双发最稳）；旧存档可能缺字段，按空串兜底。
      const agentId = this.binding.agentId ?? ''
      const model = this.binding.model ?? ''
      if (agentId !== '') headers.set('X-Agent-Id', agentId)
      const payload: Record<string, unknown> = { messages, stream: false }
      if (model !== '') payload.model = model
      if (agentId !== '') payload.agentId = agentId
      const response = await fetch(completionsUrl(this.binding.endpoint), {
        method: 'POST',
        headers,
        redirect: 'error',
        signal: controller.signal,
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        return { kind: 'error', text: response.status === 401 || response.status === 403
          ? '平台密钥认证失败，请检查密钥及权限'
          : `平台请求失败（HTTP ${response.status}），请稍后重试` }
      }
      const body = await boundedBody(response, MB)
      const text = body.toString('utf8')
      // 部分平台（如公司 agentChat）忽略 stream:false 恒返 SSE；按 content-type 分流解析。
      const content = (response.headers.get('content-type') ?? '').includes('text/event-stream')
        ? sseContent(text)
        : nonStreamContent(text)
      if (content === null) return { kind: 'error', text: '平台响应不是有效 JSON' }
      if (typeof content !== 'string' || content.length === 0) return { kind: 'error', text: '平台响应缺少回复内容' }
      return tryProtocolReceipt(content)
    } catch {
      if (timedOut) return { kind: 'timeout' }
      return { kind: 'error', text: '平台请求失败，请检查端点配置或网络' }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 非流式 OpenAI 回包：choices[0].message.content；坏 JSON 返回 null 由调用方如实报错。 */
function nonStreamContent(text: string): unknown {
  try {
    const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> }
    return parsed.choices?.[0]?.message?.content
  } catch { return null }
}

/** SSE 回包：逐行累加 data: 块里的 delta.content（兼容 message.content），忽略注释与 [DONE]。 */
function sseContent(text: string): string {
  let acc = ''
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }> }
      const piece = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content
      if (typeof piece === 'string') acc += piece
    } catch { /* 单块坏 JSON 不毁整条回复 */ }
  }
  return acc
}

async function boundedBody(response: Response, maximum: number): Promise<Buffer> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new Error('too large')
  if (!response.body) throw new Error('empty body')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) throw new Error('too large')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, size)
  } finally { reader.releaseLock() }
}
