/**
 * 通用外部智能助理平台连接器（配置驱动，代码不绑定任何公司/产品）。
 *
 * 协议参考《智能助理聊天接口开发手册》：单地址 HTTP POST，JSON 报文
 * `{service, appid, channel, sid, timestamp, sign, data}`，UTF-8，建议 15s 超时。
 * 不同能力靠 `service` 路由（realtimeChat/getChatList/getAssistantList/upload.file/
 * upload.knowledge/aiagent.long.term.memory…）。公司 specifics（地址/appid/密钥/加签模板/
 * 默认用户与智能体）全部落在配置文件，代码只实现通用报文与加签骨架。
 *
 * 加签：按手册附带的 Java 示例，字段名升序拼接键和值，JSON 值按键排序后序列化，
 * 追加开放平台签名密钥 app_secret，再做 UTF-8 的大写 MD5。其他协议可显式指定模板。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { canonicalJson } from './approval.ts'

export interface PlatformConfig {
  enabled: boolean
  /** 单地址入口（所有 service 共用），如 https://host/api/chat/realtime */
  endpoint: string
  appid: string
  /** WXAPP / PC / APP */
  channel: string
  /** 开放平台分配的 app_secret，不是成员聊天端点的 Bearer API 密钥。 */
  secret: string
  /** 空串用标准签名；其他协议可用 {appid}/{channel}/{sid}/{timestamp}/{bizid}/{service}/{data}/{secret}。 */
  signTemplate: string
  /** 默认用户 id（多数接口必填 user_id） */
  userId: string
  /** 默认智能体 id（上传知识库等用） */
  assistId: string
  timeoutMs: number
}

const LEGACY_DEFAULT_TEMPLATE = '{appid}{timestamp}{sid}{secret}'

export function platformConfigPath(home: string): string {
  return path.join(home, 'personal-assistant', 'platform-connector.json')
}

export function defaultPlatformConfig(): PlatformConfig {
  return { enabled: false, endpoint: '', appid: '', channel: 'PC', secret: '', signTemplate: '', userId: '', assistId: '', timeoutMs: 15_000 }
}

export function readPlatformConfig(home: string): PlatformConfig {
  try {
    const raw = JSON.parse(readFileSync(platformConfigPath(home), 'utf8')) as Partial<PlatformConfig>
    return { ...defaultPlatformConfig(), ...raw }
  } catch { return defaultPlatformConfig() }
}

export function writePlatformConfig(home: string, patch: Partial<PlatformConfig>): PlatformConfig {
  const next = { ...readPlatformConfig(home), ...patch }
  mkdirSync(path.dirname(platformConfigPath(home)), { recursive: true })
  writeFileSync(platformConfigPath(home), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

export function md5Upper(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex').toUpperCase()
}

/** 请求时间 yyyyMMddHHmmss（本地时区）。 */
export function platformTimestamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

function customTemplate(cfg: PlatformConfig): string {
  return cfg.signTemplate && cfg.signTemplate !== LEGACY_DEFAULT_TEMPLATE ? cfg.signTemplate : ''
}

type SignFields = { sid: string; timestamp: string; service: string; data: string | Record<string, unknown>; bizid?: string }

export function buildSign(cfg: PlatformConfig, fields: SignFields): string {
  const data = typeof fields.data === 'string' ? fields.data : canonicalJson(fields.data)
  const params: Record<string, string> = { ...fields, data, appid: cfg.appid, channel: cfg.channel }
  const template = customTemplate(cfg)
  if (template) {
    const values: Record<string, string> = { bizid: '', ...params, secret: cfg.secret }
    return md5Upper(template.replace(/\{(\w+)\}/g, (match, key: string) => Object.hasOwn(values, key) ? values[key]! : match))
  }
  return md5Upper(Object.keys(params).sort().map(key => key + params[key]).join('') + cfg.secret)
}

export interface PlatformResult { ok: boolean; code?: number; desc?: string; data?: unknown; error?: string }
type PlatformReply = { code?: unknown; desc?: unknown; data?: unknown; success?: unknown; datas?: unknown; count?: unknown; pages?: unknown }

/** 通用调用：组装公共报文＋加签，POST 单地址，按 service 路由。失败如实返回，不抛错。 */
export async function callPlatform(cfg: PlatformConfig, service: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<PlatformResult> {
  if (!cfg.enabled) return { ok: false, error: '平台对接未启用（配置 enabled=false）' }
  if (!cfg.endpoint || !cfg.appid) return { ok: false, error: '平台对接未配置 endpoint/appid' }
  if (typeof cfg.secret !== 'string' || !cfg.secret.trim()) {
    return { ok: false, error: '未发起请求：缺少开放平台签名密钥 app_secret。成员设置中的聊天 API 密钥不用于接口签名。' }
  }
  const sid = randomUUID().replace(/-/g, '').toUpperCase()
  const timestamp = platformTimestamp()
  // 实测生产网关：data 必须是 JSON 字符串，且签名用同一串；传对象会被判签名失败。
  const dataText = JSON.stringify(data)
  const fields = { service, sid, timestamp, data: dataText, ...(customTemplate(cfg) ? {} : { bizid: '' }) }
  const sign = buildSign(cfg, fields)
  const envelope = { ...fields, appid: cfg.appid, channel: cfg.channel, sign }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, cfg.timeoutMs))
  try {
    const res = await fetch(cfg.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, signal ?? controller.signal]),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) })
    const text = await res.text()
    let json: PlatformReply | null = null
    try { json = JSON.parse(text) as PlatformReply } catch { json = null }
    if (!json) {
      // 聊天接口恒返 SSE（即使请求体写 stream:false），逐帧累积正文。
      const sse = sseReply(text)
      if (!sse) return { ok: false, error: `平台返回无效报文（HTTP ${res.status}）` }
      return { ok: res.ok && sse.ok, desc: sse.desc,
        data: { content: sse.content, ...(sse.messageId === undefined ? {} : { messageId: sse.messageId }) } }
    }
    const rawCode = typeof json.code === 'string' && /^-?\d+$/u.test(json.code) ? Number(json.code) : json.code
    const code = typeof rawCode === 'number' && Number.isSafeInteger(rawCode) ? rawCode : undefined
    // 生产网关把结果放在顶层（success/datas/count/pages），测试环境放在 data 里；两种都认。
    const topLevelList = Array.isArray(json.datas)
    let value = topLevelList ? { datas: json.datas, count: json.count, pages: json.pages } : json.data
    if (typeof value === 'string') {
      try { value = JSON.parse(value) } catch { /* 兼容业务数据直接返回文本 */ }
    }
    const detail = value && typeof value === 'object' ? value as { success?: unknown; desc?: unknown } : undefined
    const succeeded = json.success === true || code === 0
    const desc = detail?.success === false ? detail.desc ?? json.desc : json.desc
    return { ok: res.ok && succeeded && detail?.success !== false, code,
      desc: typeof desc === 'string' ? desc.replaceAll(sign, '[签名已隐去]').replaceAll(cfg.secret, '[密钥已隐去]') : undefined,
      data: value, ...(!res.ok ? { error: `平台请求失败（HTTP ${res.status}）` } : {}) }
  } catch (error) {
    return { ok: false, error: `平台请求失败：${error instanceof Error ? error.message : String(error)}` }
  } finally { clearTimeout(timer) }
}

/** SSE 聊天回执：逐帧累积 content，成功与否以 success/finishReason 为准。 */
function sseReply(text: string): { ok: boolean; content: string; messageId?: number; desc?: string } | null {
  const chunks: Array<Record<string, unknown>> = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const value = JSON.parse(payload) as Record<string, unknown>
      if (value && typeof value === 'object' && !Array.isArray(value)) chunks.push(value)
    } catch { /* 半帧等下一块 */ }
  }
  if (chunks.length === 0) return null
  let content = ''
  let ok = true
  let desc: string | undefined
  let messageId: number | undefined
  for (const chunk of chunks) {
    if (typeof chunk.content === 'string') content += chunk.content
    const choice = (chunk.choices as Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }> | undefined)?.[0]
    const piece = choice?.delta?.content ?? choice?.message?.content
    if (typeof piece === 'string') content += piece
    if (chunk.success === false) {
      ok = false
      if (typeof chunk.desc === 'string') desc = chunk.desc
    }
    if (chunk.finishReason === 'error' || chunk.finishReason === 'aborted') ok = false
    if (typeof chunk.message_id === 'number' && Number.isSafeInteger(chunk.message_id)) messageId = chunk.message_id
  }
  return { ok: ok && content.trim() !== '', content, ...(messageId === undefined ? {} : { messageId }),
    ...(desc === undefined ? {} : { desc }) }
}

/** 实时聊天/查询。question 与 pics 至少一个；chat_id 格式 用户ID_智能体ID。 */
export function platformChat(cfg: PlatformConfig, question: string, opts: { chatId?: string; sessionId?: string; assistId?: string } = {}, signal?: AbortSignal): Promise<PlatformResult> {
  const assist = opts.assistId ?? cfg.assistId
  return callPlatform(cfg, 'openplatform.realtimeChat', {
    question, user_id: cfg.userId,
    ...(opts.chatId ? { chat_id: opts.chatId } : assist ? { chat_id: `${cfg.userId}_${assist}` } : {}),
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
  }, signal)
}

export function platformListAssistants(cfg: PlatformConfig, signal?: AbortSignal): Promise<PlatformResult> {
  if (cfg.enabled && (typeof cfg.userId !== 'string' || !cfg.userId.trim())) {
    return Promise.resolve({ ok: false, error: '未发起查询：平台对接未配置用户标识 userId' })
  }
  return callPlatform(cfg, 'openplatform.getAssistantList', { user_id: cfg.userId, page: 1, limit: 20 }, signal)
}

/** 会话列表：用户下有哪些会话及最新时间。 */
export function platformSessionList(cfg: PlatformConfig, opts: { page?: number; limit?: number } = {}, signal?: AbortSignal): Promise<PlatformResult> {
  return callPlatform(cfg, 'openplatform.getSessionList', { user_id: cfg.userId, page: opts.page ?? 1, limit: opts.limit ?? 20 }, signal)
}

export function platformChatList(cfg: PlatformConfig, opts: { keyword?: string; chatId?: string; page?: number; limit?: number } = {}, signal?: AbortSignal): Promise<PlatformResult> {
  return callPlatform(cfg, 'openplatform.getChatList', { user_id: cfg.userId, page: opts.page ?? 1, limit: opts.limit ?? 10, ...(opts.keyword ? { keyword: opts.keyword } : {}), ...(opts.chatId ? { chat_id: opts.chatId } : {}) }, signal)
}

export interface PlatformFile { base64: string; file_ext: string; file_name?: string }

/** 上传知识库：files + user_id(创建者) + assist_id。 */
export function platformUploadKnowledge(cfg: PlatformConfig, files: PlatformFile[], assistId?: string, signal?: AbortSignal): Promise<PlatformResult> {
  return callPlatform(cfg, 'aiagent.upload.knowledge', { files, user_id: cfg.userId, assist_id: assistId ?? cfg.assistId }, signal)
}

/** 上传文件（返回 fileCode，供 realtimeChat extra_params.fileCodes 引用）。 */
export function platformUploadFile(cfg: PlatformConfig, files: PlatformFile[], signal?: AbortSignal): Promise<PlatformResult> {
  return callPlatform(cfg, 'aiagent.upload.file', { files, user_id: cfg.userId }, signal)
}

/** 更新长期记忆（用户基本信息/偏好，Json 字符串）。 */
export function platformUpdateMemory(cfg: PlatformConfig, data: string, signal?: AbortSignal): Promise<PlatformResult> {
  return callPlatform(cfg, 'aiagent.long.term.memory', { user_id: cfg.userId, data }, signal)
}
