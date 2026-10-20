import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import type { ResolvedVoiceApi, VoiceApiKind, VoiceApiProfile, VoiceApiProvider, VoiceApiState } from '../voice-api-types.ts'

const MB = 1024 * 1024
const MAX_PROFILES = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type Codec = { encrypt(value: string): Buffer; decrypt(value: Buffer): string }
type StoredProfile = Omit<VoiceApiProfile, 'hasKey'> & { encryptedKey: string }
type StoredState = { version: 1; profiles: StoredProfile[]; selected: VoiceApiState['selected'] }

class VoiceApiError extends Error {}
function fail(message: string): never { throw new VoiceApiError(message) }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('语音配置格式无效')
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('语音配置包含未知字段')
}
function kindOf(value: unknown): VoiceApiKind {
  if (value !== 'tts' && value !== 'asr') fail('语音配置种类无效')
  return value
}
function providerOf(value: unknown): VoiceApiProvider {
  if (value === undefined || value === null || value === '') return 'openai'
  if (value !== 'openai' && value !== 'mimo') fail('语音配置提供商无效')
  return value
}
function stringField(value: unknown, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail('语音配置字段无效或过长')
  const result = value.trim()
  if (required && !result) fail('语音配置必填字段不能为空')
  return result
}
function keyField(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[^\x21-\x7e]/.test(value)) fail('语音密钥格式无效或过长')
  return value
}
function idOf(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('语音配置标识无效')
  return value
}
function endpointOf(value: unknown, kind: VoiceApiKind, provider: VoiceApiProvider): string {
  const source = stringField(value, 2048)
  if (/[?#\\\s]/.test(source) || !/^https?:\/\//i.test(source)) fail('语音接口地址无效')
  let url: URL
  try { url = new URL(source) } catch { fail('语音接口地址无效') }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) fail('语音接口仅支持安全地址或本机地址，且不能包含认证信息、查询或片段')
  const suffix = provider === 'mimo' ? '/chat/completions' : kind === 'tts' ? '/audio/speech' : '/audio/transcriptions'
  const pathname = url.pathname.replace(/\/+$/, '')
  const known = /\/audio\/(speech|transcriptions)$|\/chat\/completions$/
  if (known.test(pathname) && !pathname.endsWith(suffix)) fail('语音接口端点与种类不匹配')
  url.pathname = pathname.endsWith(suffix) ? pathname : pathname + suffix
  if (url.href.length > 2048) fail('语音接口地址过长')
  return url.href
}
function profileFields(value: Record<string, unknown>): Omit<StoredProfile, 'id' | 'encryptedKey'> {
  const kind = kindOf(value.kind)
  const provider = providerOf(value.provider)
  return {
    kind,
    name: stringField(value.name, 100),
    endpoint: endpointOf(value.endpoint, kind, provider),
    model: stringField(value.model, 200),
    voice: stringField(value.voice ?? '', 200, kind === 'tts'),
    provider,
  }
}

export class VoiceApiStore {
  private readonly filePath: string
  private readonly codec: Codec
  private state: StoredState = { version: 1, profiles: [], selected: { tts: null, asr: null } }

  constructor(filePath: string, codec: Codec) {
    this.filePath = filePath
    this.codec = codec
    let raw: string
    try {
      if (statSync(filePath).size > MB) fail('语音配置文件过大')
      raw = readFileSync(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      fail('无法读取语音配置文件，请检查文件，原文件未修改')
    }
    try {
      const value = record(JSON.parse(raw))
      fields(value, ['version', 'profiles', 'selected'])
      if (value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > MAX_PROFILES) fail('语音配置文件格式无效')
      const profiles = value.profiles.map(item => {
        const input = record(item)
        fields(input, ['id', 'kind', 'name', 'endpoint', 'model', 'voice', 'encryptedKey', 'provider'])
        const encryptedKey = input.encryptedKey
        if (typeof encryptedKey !== 'string' || encryptedKey.length > 32768 || (encryptedKey !== '' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encryptedKey) || Buffer.from(encryptedKey, 'base64').toString('base64') !== encryptedKey))) fail('语音密钥数据损坏')
        const profile = { ...profileFields(input), id: idOf(input.id), encryptedKey }
        if (encryptedKey && !this.decrypt(profile)) fail('语音密钥数据损坏')
        return profile
      })
      if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) fail('语音配置标识重复')
      const selected = record(value.selected)
      fields(selected, ['tts', 'asr'])
      for (const kind of ['tts', 'asr'] as const) {
        if (selected[kind] !== null && !profiles.some(profile => profile.id === idOf(selected[kind]) && profile.kind === kind)) fail('语音配置选择无效')
        if (selected[kind] === undefined) fail('语音配置选择无效')
      }
      this.state = { version: 1, profiles, selected: { tts: selected.tts as string | null, asr: selected.asr as string | null } }
    } catch { fail('语音配置或密钥损坏，无法加载，原文件未修改') }
  }

  snapshot(): VoiceApiState {
    return {
      profiles: this.state.profiles.map(({ encryptedKey, ...profile }) => ({ ...profile, hasKey: encryptedKey !== '' })),
      selected: { ...this.state.selected },
    }
  }

  save(input: unknown): VoiceApiState {
    const value = record(input)
    fields(value, ['id', 'kind', 'name', 'endpoint', 'model', 'voice', 'apiKey', 'provider'])
    const data = profileFields(value)
    const id = value.id === undefined ? randomUUID() : idOf(value.id)
    const previous = this.state.profiles.find(profile => profile.id === id)
    if (value.id !== undefined && !previous) fail('语音配置不存在')
    if (previous && previous.kind !== data.kind) fail('不能修改语音配置种类')
    if (!previous && this.state.profiles.length >= MAX_PROFILES) fail('语音配置数量已达上限')
    let encryptedKey = previous?.encryptedKey ?? ''
    if (value.apiKey !== undefined) {
      const key = keyField(value.apiKey)
      try {
        const encrypted = key ? this.codec.encrypt(key) : Buffer.alloc(0)
        if (!Buffer.isBuffer(encrypted) || (key && encrypted.length === 0)) fail('语音密钥加密失败')
        encryptedKey = encrypted.toString('base64')
        if (encryptedKey.length > 32768) fail('语音密钥加密失败')
      } catch { fail('语音密钥加密失败，原配置未修改') }
    }
    const profile = { ...data, id, encryptedKey }
    const profiles = previous ? this.state.profiles.map(item => item.id === id ? profile : item) : [...this.state.profiles, profile]
    return this.commit({ ...this.state, profiles })
  }

  remove(id: unknown): VoiceApiState {
    const validId = idOf(id)
    if (!this.state.profiles.some(profile => profile.id === validId)) fail('语音配置不存在')
    const selected = { ...this.state.selected }
    for (const kind of ['tts', 'asr'] as const) if (selected[kind] === validId) selected[kind] = null
    return this.commit({ ...this.state, profiles: this.state.profiles.filter(profile => profile.id !== validId), selected })
  }

  select(kind: unknown, id: unknown): VoiceApiState {
    const validKind = kindOf(kind)
    const validId = id === null ? null : idOf(id)
    if (validId !== null && !this.state.profiles.some(profile => profile.id === validId && profile.kind === validKind)) fail('所选语音配置不存在或种类不匹配')
    return this.commit({ ...this.state, selected: { ...this.state.selected, [validKind]: validId } })
  }

  resolve(kind: VoiceApiKind): ResolvedVoiceApi | null {
    const validKind = kindOf(kind)
    const profile = this.state.profiles.find(item => item.id === this.state.selected[validKind])
    if (!profile) return null
    const { encryptedKey: _encryptedKey, ...data } = profile
    return { ...data, apiKey: this.decrypt(profile) }
  }

  private decrypt(profile: StoredProfile): string {
    try { return profile.encryptedKey ? keyField(this.codec.decrypt(Buffer.from(profile.encryptedKey, 'base64'))) : '' }
    catch { fail('语音密钥无法解密，原配置未修改') }
  }

  private commit(next: StoredState): VoiceApiState {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    let descriptor: number | undefined
    let created = false
    try {
      const content = JSON.stringify(next)
      if (Buffer.byteLength(content) > MB) fail('语音配置文件过大')
      descriptor = openSync(temporary, 'wx', 0o600)
      created = true
      writeFileSync(descriptor, content, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, this.filePath)
    } catch { fail('语音配置保存失败，原配置未修改') }
    finally {
      if (descriptor !== undefined) { try { closeSync(descriptor) } catch { /* 保留原始安全错误 */ } }
      if (created) { try { unlinkSync(temporary) } catch { /* 重命名成功后临时文件已不存在 */ } }
    }
    this.state = next
    return this.snapshot()
  }
}

function cancelled(): Error {
  const error = new Error('语音请求已取消')
  error.name = 'AbortError'
  return error
}

async function request<T>(profile: ResolvedVoiceApi, kind: VoiceApiKind, signal: AbortSignal | undefined, build: () => RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 60_000)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    if (signal?.aborted) throw cancelled()
    if (profile.kind !== kind) fail('语音配置种类不匹配')
    const endpoint = endpointOf(profile.endpoint, kind, profile.provider)
    stringField(profile.model, 200)
    if (kind === 'tts') stringField(profile.voice, 200)
    const key = keyField(profile.apiKey)
    const init = build()
    const headers = new Headers(init.headers)
    if (key) headers.set('Authorization', `Bearer ${key}`)
    const response = await fetch(endpoint, { ...init, method: 'POST', headers, redirect: 'error', signal: controller.signal })
    if (!response.ok) fail(response.status === 401 || response.status === 403 ? '语音服务认证失败，请检查密钥及权限' : '语音服务请求失败，请稍后重试')
    return await consume(response)
  } catch (error) {
    if (signal?.aborted) throw cancelled()
    if (timedOut) fail('语音服务请求超时')
    if (error instanceof VoiceApiError) throw error
    return fail('语音服务请求失败，请检查配置或网络')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    controller.abort()
  }
}

async function boundedBody(response: Response, maximum: number): Promise<Buffer> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) fail('语音服务响应超过大小限制')
  if (!response.body) fail('语音服务返回空响应')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) fail('语音服务响应超过大小限制')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, size)
  } finally { reader.releaseLock() }
}

function isMp3(buffer: Buffer): boolean {
  let offset = 0
  if (buffer.subarray(0, 3).toString('ascii') === 'ID3') {
    if (buffer.length < 10 || buffer[3] < 2 || buffer[3] > 4 || buffer[4] === 255 || buffer.subarray(6, 10).some(byte => byte > 127)) return false
    offset = 10 + ((buffer[6] << 21) | (buffer[7] << 14) | (buffer[8] << 7) | buffer[9])
    if (buffer[3] === 4 && (buffer[5] & 0x10)) offset += 10
  }
  if (buffer.length < offset + 4) return false
  const a = buffer[offset], b = buffer[offset + 1], c = buffer[offset + 2], d = buffer[offset + 3]
  return a === 255 && (b & 0xe0) === 0xe0 && (b & 0x18) !== 0x08 && (b & 6) === 2 && (c >> 4) > 0 && (c >> 4) < 15 && (c & 12) !== 12 && (d & 3) !== 2
}

export async function synthesizeApi(profile: ResolvedVoiceApi, text: string, signal?: AbortSignal): Promise<Buffer> {
  if (profile.provider === 'mimo') return synthesizeMimo(profile, text, signal)
  return request(profile, 'tts', signal, () => {
    if (typeof text !== 'string' || !text.trim() || text.length > 5000) fail('语音合成文本不能为空且不能超过五千字')
    return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: profile.model, input: text, voice: profile.voice, response_format: 'mp3' }) }
  }, async response => {
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (!['audio/mpeg', 'audio/mp3', 'audio/x-mp3', 'application/octet-stream'].includes(mime ?? '')) fail('语音服务返回的音频类型无效')
    const buffer = await boundedBody(response, 20 * MB)
    if (!isMp3(buffer)) fail('语音服务返回的音频数据无效')
    return buffer
  })
}

/** MiMo TTS 的请求体（chat.completions 形态）。纯函数，便于单测。 */
export function buildMimoTtsBody(model: string, voice: string, text: string): Record<string, unknown> {
  const useVoice = typeof voice === 'string' && voice.trim() ? voice.trim() : 'mimo_default'
  return {
    model,
    messages: [
      // 合成文本必须放在 assistant 角色里；user 角色只用于风格指令（这里不用，保持默认播报语气）。
      { role: 'assistant', content: text },
    ],
    audio: { format: 'wav', voice: useVoice },
  }
}

/** MiMo TTS 响应（chat.completion，choices[0].message.audio.data 为 base64 音频）→ 音频字节。 */
export function parseMimoTtsPayload(value: unknown): Buffer {
  const choices = Array.isArray((value as { choices?: unknown } | null)?.choices) ? (value as { choices: unknown[] }).choices : []
  const choice = choices[0] !== null && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : {}
  const message = choice.message !== null && typeof choice.message === 'object' ? choice.message as Record<string, unknown> : {}
  const audio = message.audio !== null && typeof message.audio === 'object' ? message.audio as Record<string, unknown> : {}
  const data = audio.data
  if (typeof data !== 'string' || data.length === 0 || data.length > 40 * MB) fail('语音服务返回的音频数据无效')
  let buffer: Buffer
  try { buffer = Buffer.from(data, 'base64') } catch { fail('语音服务返回的音频数据无效') }
  if (buffer.length === 0) fail('语音服务返回的音频数据无效')
  return buffer
}

/** MiMo TTS：与 OpenAI 的 /audio/speech 不同，走 chat.completions，音频以 base64 放在 JSON 里。 */
async function synthesizeMimo(profile: ResolvedVoiceApi, text: string, signal?: AbortSignal): Promise<Buffer> {
  return request(profile, 'tts', signal, () => {
    if (typeof text !== 'string' || !text.trim() || text.length > 5000) fail('语音合成文本不能为空且不能超过五千字')
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildMimoTtsBody(profile.model, profile.voice, text)),
    }
  }, async response => {
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (mime !== 'application/json') fail('语音服务返回的音频类型无效')
    const body = await boundedBody(response, 20 * MB)
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) } catch { fail('语音服务返回的合成结果格式无效') }
    return parseMimoTtsPayload(parsed)
  })
}

export async function transcribeApi(profile: ResolvedVoiceApi, wav: ArrayBuffer, signal?: AbortSignal, onDelta?: (text: string) => void): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    if (profile.provider === 'mimo') return await transcribeMimo(profile, wav, signal, onDelta)
    return await request(profile, 'asr', signal, () => {
      if (!(wav instanceof ArrayBuffer) || !wav.byteLength || wav.byteLength > 25 * MB) fail('语音识别音频不能为空且不能超过二十五兆字节')
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
      form.append('model', profile.model)
      form.append('response_format', 'json')
      return { body: form }
    }, async response => {
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('语音服务返回的识别结果类型无效')
      const body = await boundedBody(response, MB)
      let result: unknown
      try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) } catch { fail('语音服务返回的识别结果格式无效') }
      if (!result || typeof result !== 'object' || typeof (result as Record<string, unknown>).text !== 'string') fail('语音服务返回的识别结果格式无效')
      return { ok: true, text: (result as { text: string }).text }
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    return { ok: false, error: error instanceof VoiceApiError ? error.message : '语音识别请求失败' }
  }
}

/**
 * mimo ASR：chat.completions + input_audio，SSE 流式返回转写文本。
 *
 * 与 OpenAI Whisper 的 /audio/transcriptions 完全不同——mimo 走对话接口传音频，
 * 响应是 SSE 逐字返回。`onDelta` 每收到一片文本就回调，调用方可实时显示。
 */
async function transcribeMimo(profile: ResolvedVoiceApi, wav: ArrayBuffer, signal?: AbortSignal, onDelta?: (text: string) => void): Promise<{ ok: boolean; text?: string; error?: string }> {
  return request(profile, 'asr', signal, () => {
    if (!(wav instanceof ArrayBuffer) || !wav.byteLength || wav.byteLength > 10 * MB) fail('语音识别音频不能为空且不能超过十兆字节')
    const base64 = Buffer.from(wav).toString('base64')
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: profile.model,
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${base64}` } }] }],
        stream: true,
        asr_options: { language: 'auto' },
      }),
    }
  }, async response => {
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (mime !== 'text/event-stream' && mime !== 'application/json') fail('语音服务返回的识别结果类型无效')
    if (!response.body) fail('语音服务返回空响应')
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let full = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }
            const text = chunk.choices?.[0]?.delta?.content
            if (typeof text === 'string' && text.length > 0) {
              full += text
              onDelta?.(text)
            }
          } catch { /* 非 JSON 行跳过 */ }
        }
      }
    } finally { reader.releaseLock() }
    return { ok: true, text: full }
  })
}
