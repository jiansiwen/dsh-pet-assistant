/**
 * 快速应答（"快嘴"旁路）：可配置的 OpenAI 兼容短应答生成器。
 *
 * 用户说完话后与主会话双轨并行：主脑跑长任务时，这里先用一句人设化的短应答
 * （"好嘞，我这就去办~"）让用户知道它在听。产出只交给本地 TTS 与宠物气泡，
 * 从不经过 bridge.chat —— 天然不进 DSH 会话、记忆与纪要。
 *
 * 接什么模型完全由用户配置（DeepSeek / 豆包 / 千问 / 自建端点都行），产品不绑厂商。
 * 密钥不进配置文件：单独加密落盘，与媒体 provider 同一套系统密钥库方案。
 * 任何失败（未启用 / 超时 / 网络 / 空回复）都静默返回 null，主轨不受影响。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getDataKey, type DpapiDeps } from './dpapi.ts'

export interface FastReplyConfig {
  enabled: boolean
  baseUrl: string
  model: string
  timeoutMs: number
  maxChars: number
}

export interface FastReplySnapshot extends FastReplyConfig {
  secretConfigured: boolean
}

export interface FastReplyInput {
  enabled?: boolean
  baseUrl?: string
  model?: string
  timeoutMs?: number
  maxChars?: number
  /** 只写不读：非空写入，空串清除，缺省保持原值。 */
  apiKey?: string
}

export interface FastReplyDeps {
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
  /** 测试注入主密钥；缺省走系统密钥存储。 */
  key?: (userDataDir: string) => Buffer | null
  dpapi?: DpapiDeps
  /** 总助理的名字与性格（带缓存由调用方实现）；取不到就用默认人设。 */
  context?: () => Promise<{ name: string; persona: string }>
  log?: (message: string) => void
}

const DEFAULTS: FastReplyConfig = { enabled: false, baseUrl: '', model: '', timeoutMs: 2500, maxChars: 40 }
const SECRET_REF = 'default'

function invalid(message: string): Error {
  return new Error(message)
}

/** 把模型输出收拢成一句能直接念的短应答：去引号、压换行、按句末标点截断、限长。 */
export function clampAck(raw: string, maxChars: number): string {
  let text = raw.replace(/\s+/g, ' ').trim()
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  if (text.length === 0) return ''
  const enders = ['。', '！', '？', '!', '?', '…']
  let cut = -1
  for (const ender of enders) {
    const at = text.indexOf(ender)
    if (at >= 0 && (cut < 0 || at < cut)) cut = at
  }
  if (cut >= 0 && cut + 1 <= maxChars) text = text.slice(0, cut + 1)
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`
  return text
}

export function ackSystemPrompt(name: string, persona: string, maxChars: number): string {
  const character = persona.trim() !== '' ? persona.trim() : '友好、干练、说话自然口语化'
  return [
    `你是桌面助理「${name.trim() || '小潘'}」的即时应答层。用户刚说完一句话，主脑正在处理正式回答。`,
    `你的唯一任务：立刻给出一句"我收到了、我正在办/正在想"的过渡语，让用户知道你在听。`,
    `性格设定：${character}`,
    `规则：`,
    `1. 只输出一句话，不超过${maxChars}个字，口语化，措辞符合性格，每次自然变化。`,
    `2. **只表达"你正在处理"这件事本身**：例如"我想一下"、"我整理一下"、"这就去看"、"收到，稍等"。`,
    `3. **绝对不要回答问题本身**。你不知道答案，正式回答在主脑那边；抢答会和主脑的结论冲突。`,
    `4. **绝对不要陈述你的状态、进度或事实**。禁止"我在闲着"、"我没在干别的"、"我刚看完"这类句子 ——`,
    `   你不知道自己此刻在干什么，说了就会和随后主脑的回答自相矛盾。`,
    `5. 禁止编造事实或细节；不要复述用户原话，不要提"作为AI"，不要解释你的机制，不要承诺具体结果。`,
    `只输出那句话本身，不带任何前后缀。`,
  ].join('\n')
}

export class FastReplyService {
  private readonly dir: string
  private readonly fetchImpl: NonNullable<FastReplyDeps['fetch']>
  private readonly key: (userDataDir: string) => Buffer | null
  private readonly context: () => Promise<{ name: string; persona: string }>
  private readonly log: (message: string) => void
  private secret: string

  constructor(userDataDir: string, deps: FastReplyDeps = {}) {
    this.dir = path.join(userDataDir, 'fast-reply')
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit))
    this.key = deps.key ?? ((dir) => {
      const result = getDataKey(dir, deps.dpapi ?? {})
      return result.status === 'ok' ? result.key : null
    })
    this.context = deps.context ?? (async () => ({ name: '', persona: '' }))
    this.log = deps.log ?? (() => {})
    this.secret = this.readSecret()
  }

  private configPath(): string {
    return path.join(this.dir, 'config.json')
  }

  private secretPath(): string {
    return path.join(this.dir, 'secret')
  }

  load(): FastReplyConfig {
    try {
      const raw = JSON.parse(readFileSync(this.configPath(), 'utf8')) as Partial<FastReplyConfig>
      return {
        enabled: raw.enabled === true,
        baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
        model: typeof raw.model === 'string' ? raw.model : '',
        timeoutMs: typeof raw.timeoutMs === 'number' && Number.isSafeInteger(raw.timeoutMs) ? raw.timeoutMs : DEFAULTS.timeoutMs,
        maxChars: typeof raw.maxChars === 'number' && Number.isSafeInteger(raw.maxChars) ? raw.maxChars : DEFAULTS.maxChars,
      }
    } catch {
      return { ...DEFAULTS }
    }
  }

  snapshot(): FastReplySnapshot {
    return { ...this.load(), secretConfigured: this.secret !== '' }
  }

  /** 校验并保存。开启必须已配好端点与模型；密钥只写不读。 */
  save(input: FastReplyInput): FastReplySnapshot {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('配置数据无效')
    const current = this.load()
    const next: FastReplyConfig = { ...current }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw invalid('开关无效')
      next.enabled = input.enabled
    }
    if (input.baseUrl !== undefined) {
      if (typeof input.baseUrl !== 'string') throw invalid('接口地址无效')
      const url = input.baseUrl.trim()
      if (url.length > 500 || (url !== '' && !/^https?:\/\/[^\s]+$/u.test(url))) throw invalid('接口地址必须是 http(s) 地址')
      next.baseUrl = url.replace(/\/+$/u, '')
    }
    if (input.model !== undefined) {
      if (typeof input.model !== 'string' || input.model.trim().length > 200) throw invalid('模型名称无效')
      next.model = input.model.trim()
    }
    if (input.timeoutMs !== undefined) {
      if (typeof input.timeoutMs !== 'number' || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 500 || input.timeoutMs > 10_000) {
        throw invalid('超时需在 500–10000 毫秒之间')
      }
      next.timeoutMs = input.timeoutMs
    }
    if (input.maxChars !== undefined) {
      if (typeof input.maxChars !== 'number' || !Number.isSafeInteger(input.maxChars) || input.maxChars < 10 || input.maxChars > 100) {
        throw invalid('应答长度需在 10–100 字之间')
      }
      next.maxChars = input.maxChars
    }
    if (next.enabled && (next.baseUrl === '' || next.model === '')) throw invalid('开启前请先填写接口地址和模型名称')
    if (input.apiKey !== undefined) {
      if (typeof input.apiKey !== 'string' || input.apiKey.length > 500) throw invalid('密钥无效')
      if (input.apiKey.trim() === '') this.removeSecret()
      else this.putSecret(input.apiKey.trim())
    }
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.configPath(), JSON.stringify(next, null, 2), 'utf8')
    return this.snapshot()
  }

  private putSecret(apiKey: string): void {
    const key = this.key(path.dirname(this.dir))
    if (!key) throw invalid('系统密钥存储不可用，无法保存密钥；请检查平台密钥服务')
    this.secret = apiKey
    this.writeSecret(key)
  }

  private removeSecret(): void {
    this.secret = ''
    const key = this.key(path.dirname(this.dir))
    if (!key || !existsSync(this.secretPath())) return
    this.writeSecret(key)
  }

  private writeSecret(key: Buffer): void {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([cipher.update(JSON.stringify({ [SECRET_REF]: this.secret }), 'utf8'), cipher.final()])
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.secretPath(), JSON.stringify({
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
    }), 'utf8')
  }

  private readSecret(): string {
    try {
      const raw = JSON.parse(readFileSync(this.secretPath(), 'utf8')) as { iv: string; tag: string; data: string }
      const key = this.key(path.dirname(this.dir))
      if (!key) return ''
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(raw.tag, 'base64'))
      const plain = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()])
      const parsed = JSON.parse(plain.toString('utf8')) as Record<string, string>
      return typeof parsed[SECRET_REF] === 'string' ? parsed[SECRET_REF] : ''
    } catch {
      return ''
    }
  }

  /**
   * 生成一句短应答。未启用 / 缺配置 / 超时 / 出错 / 空回复一律返回 null ——
   * 快嘴是锦上添花，任何情况下都不能挡住或拖慢主轨。
   */
  async generate(userText: string, signal: AbortSignal): Promise<string | null> {
    const config = this.load()
    if (!config.enabled || config.baseUrl === '' || config.model === '') return null
    return this.requestAck(config, userText, signal)
  }

  /** 设置页"测试连接"：不要求已开启，用固定样例走一遍真实请求。 */
  async test(): Promise<{ ok: boolean; sample?: string; error?: string }> {
    const config = this.load()
    if (config.baseUrl === '' || config.model === '') return { ok: false, error: '请先填写接口地址和模型名称' }
    const controller = new AbortController()
    try {
      const sample = await this.requestAck(config, '帮我把今天的会议记录整理一下', controller.signal)
      if (sample === null) return { ok: false, error: '服务没有返回可用内容，请核对地址、模型与密钥' }
      return { ok: true, sample }
    } catch (error) {
      return { ok: false, error: error instanceof Error && error.name === 'AbortError' ? '请求超时，请检查网络或调大超时' : '连接失败，请核对接口地址与密钥' }
    } finally {
      controller.abort()
    }
  }

  private async requestAck(config: FastReplyConfig, userText: string, signal: AbortSignal): Promise<string | null> {
    let name = ''
    let persona = ''
    try {
      const context = await this.context()
      name = context.name
      persona = context.persona
    } catch {
      // 人设取不到就用默认性格，不挡快嘴。
    }
    if (signal.aborted) return null
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.secret !== '') headers.authorization = `Bearer ${this.secret}`
    const url = /\/chat\/completions$/u.test(config.baseUrl) ? config.baseUrl : `${config.baseUrl}/chat/completions`
    const timeout = AbortSignal.timeout(config.timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    let response: { ok: boolean; status: number; json(): Promise<unknown> }
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: ackSystemPrompt(name, persona, config.maxChars) },
            { role: 'user', content: userText },
          ],
          temperature: 0.9,
          max_tokens: 120,
          stream: false,
        }),
        signal: combined,
      })
    } catch (error) {
      if (!signal.aborted) this.log(`快速应答请求失败：${error instanceof Error && error.name === 'AbortError' ? '超时' : '网络错误'}`)
      return null
    }
    if (!response.ok) {
      this.log(`快速应答服务返回 ${response.status}`)
      return null
    }
    try {
      const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
      const content = body.choices?.[0]?.message?.content
      if (typeof content !== 'string') return null
      const ack = clampAck(content, config.maxChars)
      return ack === '' ? null : ack
    } catch {
      return null
    }
  }
}