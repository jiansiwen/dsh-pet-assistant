/**
 * edge-tts 协议客户端：原生 WebSocket 直连微软 Edge 朗读服务，免费、无需密钥。
 *
 * 协议对齐开源 edge-tts：Sec-MS-GEC 令牌由本地算法生成
 * （SHA256(Windows 文件时间取整 + TrustedClientToken)，5 分钟窗口），不请求令牌端点。
 * 实现参考 dsh-voice（MIT，https://github.com/STARDUSTLC666/dsh-voice）。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const WS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'
const SEC_MS_GEC_VERSION = '1-143.0.3650.75'
const WIN_EPOCH_SECONDS = 11644473600

const WSS_HEADERS: Record<string, string> = {
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-WebSocket-Version': '13',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
}

export interface TtsOptions {
  readonly text: string
  readonly voice: string
  readonly rate: string
  readonly pitch: string
  readonly signal?: AbortSignal
}

/** 可注入依赖：测试用假 WebSocket，不出网也能测协议装配。 */
export interface TtsDeps {
  readonly webSocketFactory?: WebSocketFactory
  readonly nowSeconds?: () => number
}

/** 最小的 WebSocket 面。 */
export interface WebSocketLike {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'open' | 'close' | 'error', listener: (event?: unknown) => void): void
  send(data: string): void
  close(): void
}

export type WebSocketFactory = (url: string, options: { headers: Record<string, string> }) => WebSocketLike

/** 默认中文女声（晓晓）。面板设置以后可以换，先给一个大多数人都满意的。 */
export const DEFAULT_TTS_VOICE = 'zh-CN-XiaoxiaoNeural'

/** 本地生成 Sec-MS-GEC 令牌（对齐 edge-tts DRM 算法）。 */
export function generateSecMsGec(nowSeconds: number = Date.now() / 1000): string {
  let ticks = Math.floor(nowSeconds) + WIN_EPOCH_SECONDS
  ticks -= ticks % 300
  const windowsTicks = ticks * 10000000
  return createHash('sha256').update(String(windowsTicks) + TRUSTED_CLIENT_TOKEN, 'ascii').digest('hex').toUpperCase()
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function buildSsml(options: TtsOptions): string {
  const lang = /^[a-z]{2,3}(-[A-Z]{2})?/.exec(options.voice)?.[0] ?? 'zh-CN'
  return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + lang
    + "'><voice name='" + options.voice + "'><prosody pitch='" + options.pitch + "' rate='" + options.rate
    + "' volume='+0%'>" + escapeXml(options.text) + '</prosody></voice></speak>'
}

function protocolHeader(path: string, extra: Record<string, string>): string {
  const lines = ['X-Timestamp:' + new Date().toISOString()]
  for (const [key, value] of Object.entries(extra)) lines.push(key + ':' + value)
  lines.push('Path:' + path)
  return lines.join('\r\n') + '\r\n\r\n'
}

/** 合成一句，返回 MP3 字节。 */
export async function synthesizeSpeech(options: TtsOptions, deps: TtsDeps = {}, timeoutMs = 30000): Promise<Buffer> {
  options.signal?.throwIfAborted()
  if (options.text.trim() === '') throw new Error('要合成的文本为空')
  if (options.text.length > 5000) throw new Error('文本超过单次合成上限')

  const factory = deps.webSocketFactory ?? ((url, headerOptions) => new WebSocket(url, { headers: headerOptions.headers }) as unknown as WebSocketLike)
  const token = generateSecMsGec(deps.nowSeconds?.() ?? Date.now() / 1000)
  const url = WS_BASE + '?TrustedClientToken=' + TRUSTED_CLIENT_TOKEN
    + '&ConnectionId=' + randomUUID().replace(/-/g, '')
    + '&Sec-MS-GEC=' + token
    + '&Sec-MS-GEC-Version=' + SEC_MS_GEC_VERSION
  const socket = factory(url, {
    headers: { ...WSS_HEADERS, MUID: randomBytes(16).toString('hex').toUpperCase() },
  })

  const chunks: Buffer[] = []
  let settled = false
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => finish(new Error('语音合成超时，请检查网络')), timeoutMs)
    const abort = (): void => finish(new Error('语音合成已取消'))
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      try { socket.close() } catch { /* 已关 */ }
      if (error) reject(error)
      else resolvePromise()
    }

    socket.addEventListener('open', () => {
      if (settled) return
      const config = protocolHeader('speech.config', { 'Content-Type': 'application/json; charset=utf-8' })
        + JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: OUTPUT_FORMAT,
              },
            },
          },
        })
      const ssml = protocolHeader('ssml', { 'Content-Type': 'application/ssml+xml', 'X-RequestId': randomUUID() })
        + buildSsml(options)
      try {
        socket.send(config)
        socket.send(ssml)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })

    socket.addEventListener('message', (event) => {
      if (settled) return
      const data = event.data
      if (typeof data === 'string') {
        if (data.includes('Path:turn.end')) {
          finish(chunks.length === 0 ? new Error('服务端结束合成但未返回音频') : undefined)
        }
        return
      }
      // 二进制帧：2 字节大端头长 + 头文本 + 音频数据
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      if (buffer.length > 2) {
        const headerLength = buffer.readUInt16BE(0)
        if (buffer.length > 2 + headerLength) chunks.push(buffer.subarray(2 + headerLength))
      }
    })

    socket.addEventListener('error', () => finish(new Error('edge-tts 连接失败（网络不可达或被拦截）')))
    socket.addEventListener('close', () => finish(new Error('edge-tts 连接在合成完成前关闭')))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
  })

  const audio = Buffer.concat(chunks)
  if (audio.length === 0) throw new Error('合成结果为空')
  return audio
}
