import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import AiBot, { generateReqId } from '@wecom/aibot-node-sdk'
import type { ChannelAdapter, InboundChannelMessage } from './channels.ts'

export interface WeComConfig {
  enabled: boolean
  botId: string
}

export function readWeComConfig(home: string): WeComConfig | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(home, 'personal-assistant', 'wecom.json'), 'utf8')) as Partial<WeComConfig>
    if (raw.enabled !== true || typeof raw.botId !== 'string' || !raw.botId.trim()) return null
    return { enabled: true, botId: raw.botId.trim() }
  } catch {
    return null
  }
}

export function weComSecretFile(home: string): string {
  return path.join(home, 'personal-assistant', 'wecom.secret')
}

type FrameLike = { body?: Record<string, unknown> }

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function textOf(body: Record<string, unknown>): string {
  const text = objectOf(body.text)?.content
  if (typeof text === 'string') return text
  const voice = objectOf(body.voice)?.content
  if (typeof voice === 'string') return voice
  const mixed = objectOf(body.mixed)
  const items = Array.isArray(mixed?.msg_item) ? mixed.msg_item : []
  const pieces: string[] = []
  for (const item of items) {
    const entry = objectOf(item)
    const content = objectOf(entry?.text)?.content
    if (typeof content === 'string') pieces.push(content)
  }
  return pieces.join('\n')
}

export interface WeComAdapterOptions {
  botId: string
  secret: string
  onMessage(message: InboundChannelMessage): Promise<void>
  log(message: string): void
}

export function createWeComAdapter(options: WeComAdapterOptions): ChannelAdapter & { connected(): boolean } {
  let client: InstanceType<typeof AiBot.WSClient> | null = null
  let authenticated = false
  const frames = new WeakMap<object, FrameLike>()

  const replyTo = async (frame: FrameLike, chatId: string, text: string): Promise<void> => {
    if (client && typeof frame === 'object' && frame !== null) {
      try {
        await client.replyStream(frame as never, generateReqId('stream'), text, true)
        return
      } catch (error) {
        options.log(`[wecom] 流式回复失败，改用主动发送：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await sendTo(chatId, text)
  }

  const sendTo = async (chatId: string, text: string): Promise<void> => {
    if (!client) throw new Error('企业微信机器人未连接')
    await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: text } } as never)
  }

  const dispatch = (frame: FrameLike): void => {
    const body = objectOf(frame.body)
    if (!body) return
    const msgid = typeof body.msgid === 'string' ? body.msgid : ''
    const chatType = body.chattype === 'group' ? 'group' : body.chattype === 'single' ? 'single' : null
    const senderId = typeof objectOf(body.from)?.userid === 'string' ? String(objectOf(body.from)!.userid) : ''
    const chatId = chatType === 'group' ? (typeof body.chatid === 'string' ? body.chatid : '') : senderId
    const text = textOf(body).trim()
    if (!msgid || !chatType || !senderId || !chatId || !text) return
    frames.set(frame as object, frame)
    void options.onMessage({
      channel: 'wecom', msgid, chatId, chatType, senderId, text,
      reply: message => replyTo(frame, chatId, message),
    }).catch(error => {
      options.log(`[wecom] 处理消息失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  return {
    name: 'wecom',
    connected: () => authenticated && client?.isConnected === true,
    async start() {
      if (client) return
      client = new AiBot.WSClient({
        botId: options.botId,
        secret: options.secret,
        maxReconnectAttempts: -1,
        maxAuthFailureAttempts: 5,
        logger: { debug: () => undefined, info: message => options.log(`[wecom] ${message}`),
          warn: message => options.log(`[wecom] ${message}`), error: message => options.log(`[wecom] ${message}`) },
      })
      client.on('authenticated', () => { authenticated = true })
      client.on('disconnected', () => { authenticated = false })
      client.on('reconnecting', () => { authenticated = false })
      client.on('message.text', (frame: FrameLike) => dispatch(frame))
      client.on('message.voice', (frame: FrameLike) => dispatch(frame))
      client.on('message.mixed', (frame: FrameLike) => dispatch(frame))
      client.on('event.enter_chat', (frame: FrameLike) => {
        const body = objectOf(frame.body)
        const chatType = body?.chattype === 'group' ? 'group' : 'single'
        const chatId = chatType === 'group' ? String(body?.chatid ?? '') : String(objectOf(body?.from)?.userid ?? '')
        if (!chatId || !client) return
        void client.replyWelcome(frame as never, { msgtype: 'text', text: { content: '你好，我是小潘。可以直接给我发消息。' } } as never)
          .catch(() => undefined)
      })
      client.on('error', (error: unknown) => options.log(`[wecom] 连接错误：${error instanceof Error ? error.message : String(error)}`))
      client.connect()
    },
    async stop() {
      const current = client
      client = null
      authenticated = false
      current?.disconnect()
    },
    sendTo,
  }
}

export function weComFiles(home: string): { config: string; secret: string } {
  return {
    config: path.join(home, 'personal-assistant', 'wecom.json'),
    secret: weComSecretFile(home),
  }
}

export function weComConfigured(home: string): boolean {
  const files = weComFiles(home)
  return existsSync(files.config) && existsSync(files.secret)
}
