/**
 * 通用外部智能助理平台连接器（配置驱动，代码不绑定任何公司/产品）。
 *
 * 协议参考《智能助理聊天接口开发手册》：单地址 HTTP POST，JSON 报文
 * `{service, appid, channel, sid, timestamp, sign, data}`，UTF-8，建议 15s 超时。
 * 不同能力靠 `service` 路由（realtimeChat/getChatList/getAssistantList/upload.file/
 * upload.knowledge/aiagent.long.term.memory…）。公司 specifics（地址/appid/密钥/加签模板/
 * 默认用户与智能体）全部落在配置文件，代码只实现通用报文与加签骨架。
 *
 * 加签：sign 为 32 位大写 MD5。具体拼接顺序由配置 signTemplate 决定（占位符
 * {appid}/{channel}/{sid}/{timestamp}/{bizid}/{secret}），缺省模板
 * `{appid}{timestamp}{sid}{secret}`；若平台规则不同，改配置即可，不改代码。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface PlatformConfig {
  enabled: boolean
  /** 单地址入口（所有 service 共用），如 https://host/api/chat/realtime */
  endpoint: string
  appid: string
  /** WXAPP / PC / APP */
  channel: string
  /** 加签密钥（仅存配置，不入代码/日志） */
  secret: string
  /** 加签拼接模板，占位符见模块注释 */
  signTemplate: string
  /** 默认用户 id（多数接口必填 user_id） */
  userId: string
  /** 默认智能体 id（上传知识库等用） */
  assistId: string
  timeoutMs: number
}

export const PLATFORM_DEFAULT_TEMPLATE = '{appid}{timestamp}{sid}{secret}'

export function platformConfigPath(home: string): string {
  return path.join(home, 'personal-assistant', 'platform-connector.json')
}

export function defaultPlatformConfig(): PlatformConfig {
  return { enabled: false, endpoint: '', appid: '', channel: 'PC', secret: '', signTemplate: PLATFORM_DEFAULT_TEMPLATE, userId: '', assistId: '', timeoutMs: 15_000 }
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

export function buildSign(cfg: PlatformConfig, fields: { sid: string; timestamp: string; bizid?: string }): string {
  const template = cfg.signTemplate || PLATFORM_DEFAULT_TEMPLATE
  const raw = template
    .replace(/\{appid\}/g, cfg.appid)
    .replace(/\{channel\}/g, cfg.channel)
    .replace(/\{sid\}/g, fields.sid)
    .replace(/\{timestamp\}/g, fields.timestamp)
    .replace(/\{bizid\}/g, fields.bizid ?? '')
    .replace(/\{secret\}/g, cfg.secret)
  return md5Upper(raw)
}

export interface PlatformResult { ok: boolean; code?: number; desc?: string; data?: unknown; error?: string }

/** 通用调用：组装公共报文＋加签，POST 单地址，按 service 路由。失败如实返回，不抛错。 */
export async function callPlatform(cfg: PlatformConfig, service: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<PlatformResult> {
  if (!cfg.enabled) return { ok: false, error: '平台对接未启用（配置 enabled=false）' }
  if (!cfg.endpoint || !cfg.appid) return { ok: false, error: '平台对接未配置 endpoint/appid' }
  const sid = randomUUID().replace(/-/g, '').toUpperCase()
  const timestamp = platformTimestamp()
  const envelope = { service, appid: cfg.appid, channel: cfg.channel, sid, timestamp, sign: buildSign(cfg, { sid, timestamp }), data }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, cfg.timeoutMs))
  try {
    const res = await fetch(cfg.endpoint, { method: 'POST', signal: AbortSignal.any([controller.signal, signal ?? controller.signal]),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) })
    const json = await res.json().catch(() => null) as { code?: number; desc?: string; data?: unknown } | null
    if (!json) return { ok: false, error: `平台返回非 JSON（HTTP ${res.status}）` }
    const code = typeof json.code === 'number' ? json.code : undefined
    return { ok: code === 0, code, desc: json.desc, data: json.data }
  } catch (error) {
    return { ok: false, error: `平台请求失败：${error instanceof Error ? error.message : String(error)}` }
  } finally { clearTimeout(timer) }
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
  return callPlatform(cfg, 'openplatform.getAssistantList', { user_id: cfg.userId, page: 1, limit: 20 }, signal)
}

export function platformChatList(cfg: PlatformConfig, opts: { keyword?: string; chatId?: string } = {}, signal?: AbortSignal): Promise<PlatformResult> {
  return callPlatform(cfg, 'openplatform.getChatList', { user_id: cfg.userId, page: 1, limit: 10, ...(opts.keyword ? { keyword: opts.keyword } : {}), ...(opts.chatId ? { chat_id: opts.chatId } : {}) }, signal)
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