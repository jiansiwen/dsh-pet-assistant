/**
 * 可配置媒体 provider：图像 / 视频 / 音色克隆三类适配器。
 * 用户接自己的模型 = 填 baseUrl + 协议类型 + 字段路径，产品代码不绑任何厂商。
 * 密钥不进配置文件：单独加密落盘，配置里只留 apiKeyRef。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getDataKey, type DpapiDeps } from './dpapi.ts'

export interface ProviderAuth {
  headerName?: string
  scheme?: string
  apiKeyRef?: string
}

export interface ImageProviderConfig {
  id: string
  name: string
  type: 'openai-images' | 'http-json'
  baseUrl: string
  model: string
  auth?: ProviderAuth
  size?: string
  submitPath?: string
  bodyTemplate?: Record<string, unknown>
  resultUrlPath?: string
  resultB64Path?: string
}

export interface VideoProviderConfig {
  id: string
  name: string
  type: 'async-task' | 'sync-url'
  baseUrl: string
  model: string
  auth?: ProviderAuth
  /** 提交/轮询都要带的静态请求头，如百炼的 X-DashScope-Async: enable */
  extraHeaders?: Record<string, string>
  submitPath?: string
  bodyTemplate?: Record<string, unknown>
  taskIdPath?: string
  pollPath?: string
  statusPath?: string
  succeededValues?: string[]
  failedValues?: string[]
  videoUrlPath?: string
  pollIntervalMs?: number
  timeoutMs?: number
}

export interface CloneProviderConfig {
  id: string
  name: string
  type: 'http-json'
  baseUrl: string
  auth?: ProviderAuth
  submitPath?: string
  bodyTemplate?: Record<string, unknown>
  voiceIdPath?: string
  /** 克隆出的 voiceId 由这个 openai 兼容 TTS 端点发声 */
  ttsEndpoint: string
  ttsModel: string
  ttsApiKeyRef?: string
}

export interface MediaProvidersConfig {
  image: ImageProviderConfig[]
  video: VideoProviderConfig[]
  clone: CloneProviderConfig[]
  ffmpegPath?: string
  /** 视频抠像底色（colorkey），默认绿幕 */
  keyColor?: string
}

const EMPTY: MediaProvidersConfig = { image: [], video: [], clone: [] }

export class MediaError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

/** 点路径 + 数组下标取值：data[0].b64_json */
export function getPath(value: unknown, pointer: string): unknown {
  let current: unknown = value
  for (const part of pointer.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (!part) continue
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** 模板替换：整串等于 {{key}} 时注入原始类型（数组/对象），否则做字符串替换。 */
export function renderTemplate(template: unknown, vars: Record<string, unknown>): unknown {
  if (typeof template === 'string') {
    const whole = /^\{\{(\w+)\}\}$/.exec(template)
    if (whole) return vars[whole[1]]
    return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => String(vars[key] ?? ''))
  }
  if (Array.isArray(template)) return template.map(item => renderTemplate(item, vars))
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(template)) out[key] = renderTemplate(value, vars)
    return out
  }
  return template
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>

export interface ProviderStoreDeps {
  fetch?: FetchLike
  /** 测试注入主密钥；缺省走系统密钥存储 */
  key?: (userDataDir: string) => Buffer | null
  dpapi?: DpapiDeps
}

const DEFAULT_TIMEOUT = 60_000

export class MediaProviderStore {
  private readonly dir: string
  private readonly fetch: FetchLike
  private readonly key: (userDataDir: string) => Buffer | null
  private secrets: Record<string, string> = {}

  constructor(userDataDir: string, deps: ProviderStoreDeps = {}) {
    this.dir = path.join(userDataDir, 'asset-studio')
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit))
    this.key = deps.key ?? ((dir) => {
      const result = getDataKey(dir, deps.dpapi ?? {})
      return result.status === 'ok' ? result.key : null
    })
    this.secrets = this.readSecrets()
  }

  private configPath(): string {
    return path.join(this.dir, 'providers.json')
  }

  private secretPath(): string {
    return path.join(this.dir, 'providers.secret')
  }

  load(): MediaProvidersConfig {
    try {
      const raw = JSON.parse(readFileSync(this.configPath(), 'utf8')) as MediaProvidersConfig
      return {
        image: Array.isArray(raw.image) ? raw.image : [],
        video: Array.isArray(raw.video) ? raw.video : [],
        clone: Array.isArray(raw.clone) ? raw.clone : [],
        ffmpegPath: typeof raw.ffmpegPath === 'string' ? raw.ffmpegPath : undefined,
        keyColor: typeof raw.keyColor === 'string' ? raw.keyColor : undefined,
      }
    } catch {
      return { ...EMPTY }
    }
  }

  save(config: MediaProvidersConfig): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.configPath(), JSON.stringify(config, null, 2), 'utf8')
  }

  hasSecret(ref: string): boolean {
    return typeof this.secrets[ref] === 'string'
  }

  /** 写入密钥：系统密钥不可用时拒绝，不明文落盘。 */
  putSecret(ref: string, apiKey: string): void {
    const key = this.key(path.dirname(this.dir))
    if (!key) throw new MediaError('系统密钥存储不可用，无法保存密钥；请检查平台密钥服务', 'SECRET_UNAVAILABLE')
    this.secrets[ref] = apiKey
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(this.secrets), 'utf8'), cipher.final()])
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.secretPath(), JSON.stringify({
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
    }), 'utf8')
  }

  removeSecret(ref: string): void {
    if (!(ref in this.secrets)) return
    delete this.secrets[ref]
    const key = this.key(path.dirname(this.dir))
    if (!key || !existsSync(this.secretPath())) return
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(this.secrets), 'utf8'), cipher.final()])
    writeFileSync(this.secretPath(), JSON.stringify({
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
    }), 'utf8')
  }

  private readSecrets(): Record<string, string> {
    try {
      const raw = JSON.parse(readFileSync(this.secretPath(), 'utf8')) as { iv: string; tag: string; data: string }
      const key = this.key(path.dirname(this.dir))
      if (!key) return {}
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(raw.tag, 'base64'))
      const plain = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()])
      const parsed = JSON.parse(plain.toString('utf8')) as Record<string, string>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  secretOf(ref: string | undefined): string {
    if (!ref) return ''
    return this.secrets[ref] ?? ''
  }

  private headers(auth: ProviderAuth | undefined, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...extra }
    const secret = this.secretOf(auth?.apiKeyRef)
    if (secret) headers[auth?.headerName ?? 'authorization'] = `${auth?.scheme ?? 'Bearer '}${secret}`.trimEnd()
    return headers
  }

  async requestJson(baseUrl: string, auth: ProviderAuth | undefined, submitPath: string | undefined, body: unknown, timeoutMs = DEFAULT_TIMEOUT, extra?: Record<string, string>): Promise<unknown> {
    const url = joinUrl(baseUrl, submitPath)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetch(url, {
        method: 'POST', headers: this.headers(auth, extra), body: JSON.stringify(body), signal: controller.signal,
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new MediaError(`provider 返回 HTTP ${response.status}`, 'PROVIDER_HTTP')
      }
      return payload
    } catch (error) {
      if (error instanceof MediaError) throw error
      if (controller.signal.aborted) throw new MediaError('provider 请求超时', 'PROVIDER_TIMEOUT')
      throw new MediaError(`provider 连接失败：${error instanceof Error ? error.message : String(error)}`, 'PROVIDER_NETWORK')
    } finally {
      clearTimeout(timer)
    }
  }

  /** GET 查询（异步任务轮询等）：不带请求体。 */
  async getJson(baseUrl: string, auth: ProviderAuth | undefined, getPathname: string | undefined, timeoutMs = DEFAULT_TIMEOUT, extra?: Record<string, string>): Promise<unknown> {
    const url = joinUrl(baseUrl, getPathname)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetch(url, { method: 'GET', headers: this.headers(auth, extra), signal: controller.signal })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new MediaError(`provider 返回 HTTP ${response.status}`, 'PROVIDER_HTTP')
      return payload
    } catch (error) {
      if (error instanceof MediaError) throw error
      if (controller.signal.aborted) throw new MediaError('provider 请求超时', 'PROVIDER_TIMEOUT')
      throw new MediaError(`provider 连接失败：${error instanceof Error ? error.message : String(error)}`, 'PROVIDER_NETWORK')
    } finally {
      clearTimeout(timer)
    }
  }

  /** 连通性检查：只 GET 基址，不触发生成计费。 */
  async ping(baseUrl: string, auth: ProviderAuth | undefined): Promise<{ ok: boolean; status: number }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await this.fetch(baseUrl, { method: 'GET', headers: this.headers(auth), signal: controller.signal })
      return { ok: response.ok, status: response.status }
    } catch {
      return { ok: false, status: 0 }
    } finally {
      clearTimeout(timer)
    }
  }

  async download(url: string, dest: string, write: (data: Buffer) => void, maxBytes = 200 * 1024 * 1024): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    try {
      const response = await this.fetch(url, { method: 'GET', headers: {}, signal: controller.signal })
      if (!response.ok) throw new MediaError(`素材下载 HTTP ${response.status}`, 'DOWNLOAD_HTTP')
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.byteLength > maxBytes) throw new MediaError('素材超过大小上限', 'DOWNLOAD_TOO_LARGE')
      write(buffer)
    } finally {
      clearTimeout(timer)
    }
  }
}

export function joinUrl(baseUrl: string, submitPath: string | undefined): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (!submitPath) return base
  return `${base}/${submitPath.replace(/^\/+/, '')}`
}

export interface ImageResult {
  url?: string
  b64?: string
}

export async function generateImage(store: MediaProviderStore, provider: ImageProviderConfig, prompt: string): Promise<ImageResult> {
  if (provider.type === 'openai-images') {
    const payload = await store.requestJson(provider.baseUrl, provider.auth, '/v1/images/generations', {
      model: provider.model, prompt, n: 1, size: provider.size ?? '1024x1024', response_format: 'b64_json',
    })
    const b64 = getPath(payload, 'data[0].b64_json')
    const url = getPath(payload, 'data[0].url')
    if (typeof b64 === 'string') return { b64 }
    if (typeof url === 'string') return { url }
    throw new MediaError('图像响应缺少 b64_json/url', 'PROVIDER_SHAPE')
  }
  const body = renderTemplate(provider.bodyTemplate ?? { prompt: '{{prompt}}', model: '{{model}}' }, { prompt, model: provider.model })
  const payload = await store.requestJson(provider.baseUrl, provider.auth, provider.submitPath, body)
  const url = getPath(payload, provider.resultUrlPath ?? 'data[0].url')
  const b64 = getPath(payload, provider.resultB64Path ?? 'data[0].b64_json')
  if (typeof b64 === 'string') return { b64 }
  if (typeof url === 'string') return { url }
  throw new MediaError('图像响应缺少配置的结果字段', 'PROVIDER_SHAPE')
}

export interface VideoSubmission {
  taskId?: string
  url?: string
}

export async function submitVideo(store: MediaProviderStore, provider: VideoProviderConfig, vars: { prompt: string; imageUrl: string }): Promise<VideoSubmission> {
  const body = renderTemplate(provider.bodyTemplate ?? { prompt: '{{prompt}}', image_url: '{{image_url}}', model: '{{model}}' }, {
    ...vars, image_url: vars.imageUrl, model: provider.model,
  })
  const payload = await store.requestJson(provider.baseUrl, provider.auth, provider.submitPath, body, DEFAULT_TIMEOUT, provider.extraHeaders)
  if (provider.type === 'sync-url') {
    const url = getPath(payload, provider.videoUrlPath ?? 'data[0].url')
    if (typeof url !== 'string') throw new MediaError('视频响应缺少配置的结果字段', 'PROVIDER_SHAPE')
    return { url }
  }
  const taskId = getPath(payload, provider.taskIdPath ?? 'output.task_id')
  if (taskId === undefined || taskId === null) throw new MediaError('视频响应缺少任务 ID', 'PROVIDER_SHAPE')
  return { taskId: String(taskId) }
}

export interface VideoPoll {
  state: 'pending' | 'succeeded' | 'failed'
  url?: string
}

export async function pollVideo(store: MediaProviderStore, provider: VideoProviderConfig, taskId: string): Promise<VideoPoll> {
  const pollPath = (provider.pollPath ?? '/v1/tasks/{{task_id}}').replace('{{task_id}}', encodeURIComponent(taskId))
  // 异步开关头（如 X-DashScope-Async）只属于提交请求；带上它查询会被百炼拒 403。
  const payload = await store.getJson(provider.baseUrl, provider.auth, pollPath)
  const status = String(getPath(payload, provider.statusPath ?? 'output.task_status') ?? '')
  const succeeded = provider.succeededValues ?? ['succeeded', 'SUCCEEDED', 'completed', 'COMPLETED', 'success']
  const failed = provider.failedValues ?? ['failed', 'FAILED', 'error', 'ERROR', 'canceled', 'CANCELED']
  if (succeeded.includes(status)) {
    const url = getPath(payload, provider.videoUrlPath ?? 'output.video_url')
    if (typeof url !== 'string') throw new MediaError('任务成功但缺少视频地址', 'PROVIDER_SHAPE')
    return { state: 'succeeded', url }
  }
  if (failed.includes(status)) return { state: 'failed' }
  return { state: 'pending' }
}

export async function cloneVoice(store: MediaProviderStore, provider: CloneProviderConfig, samples: { base64: string; name: string }[]): Promise<string> {
  const body = renderTemplate(provider.bodyTemplate ?? { samples: '{{samples}}' }, { samples })
  const payload = await store.requestJson(provider.baseUrl, provider.auth, provider.submitPath, body, 180_000)
  const voiceId = getPath(payload, provider.voiceIdPath ?? 'voice_id')
  if (typeof voiceId !== 'string' || voiceId === '') throw new MediaError('克隆响应缺少 voice_id', 'PROVIDER_SHAPE')
  return voiceId
}