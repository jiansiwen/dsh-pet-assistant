/**
 * 成员网页抓取的安全与清洗逻辑（纯函数 + 可注入 fetch 的执行器）。
 *
 * 背景：DSH 核心会话工具（read/web_fetch/bash）只由核心会话工厂装配；插件 agents.create 建的
 * 成员会话拿不到，唯一继承途径是 spawn 自核心创建的总助理会话。定时自主运行没有这样的父会话，
 * 故给获准成员注册一个最小只读抓取能力作桥（仅只读、防 SSRF），不替代宿主工具。
 *
 * 边界：只允许 https 公开网页；本机/回环/链路本地/私有网段/`.local`/`.internal` 一律拒绝。
 * 限时限量；HTML 粗转文本，JSON/纯文本原样返回。
 */

/** 是否禁止抓取的主机（本机/内网/链路本地/特殊域）。 */
export function isBlockedWebHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '[::1]' || host === '0.0.0.0'
    || host.endsWith('.local') || host.endsWith('.internal')
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
}

export const WEB_FETCH_DEFAULT_CHARS = 12_000
export const WEB_FETCH_MAX_CHARS = 60_000
const WEB_FETCH_MAX_BYTES = 512 * 1024

/** 规整返回字符上限：缺省 12000，硬上限 60000。 */
export function clampMaxChars(value: unknown): number {
  return typeof value === 'number' && value > 0 ? Math.min(Math.floor(value), WEB_FETCH_MAX_CHARS) : WEB_FETCH_DEFAULT_CHARS
}

/** HTML 粗转文本：去脚本/样式/标签、解几个常见实体、压缩空白。非 HTML 原样返回。 */
export function htmlToText(raw: string, contentType: string): string {
  if (!contentType.includes('html') && !/^\s*</.test(raw)) return raw
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
}

export interface WebFetchResult { ok: boolean; status?: number; url?: string; text?: string; error?: string }
export type FetchLike = (url: string, init: { signal: AbortSignal; redirect: 'follow'; headers: Record<string, string> }) => Promise<{ status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>

/**
 * 抓取一个公开 https 网页。校验 → 限时 fetch → 限量读 body → 清洗 → 截断。
 * 任何失败都返回 { ok:false, error }，不抛错（成员工具据此如实回报，不编造内容）。
 */
export async function safeWebFetch(rawUrl: unknown, maxChars: unknown, signal: AbortSignal, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = 25_000): Promise<WebFetchResult> {
  const raw = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  let parsed: URL
  try { parsed = new URL(raw) } catch { return { ok: false, error: 'URL 无效' } }
  if (parsed.protocol !== 'https:') return { ok: false, error: '只允许 https 公开网页' }
  if (isBlockedWebHost(parsed.hostname)) return { ok: false, error: '不允许抓取本机/内网地址' }
  const limit = clampMaxChars(maxChars)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(raw, { signal: AbortSignal.any([controller.signal, signal]), redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; DSHAssistant/1.0)', accept: 'text/html,application/json;q=0.9,*/*;q=0.8' } })
    const bytes = Buffer.from(await res.arrayBuffer()).subarray(0, WEB_FETCH_MAX_BYTES)
    const text = htmlToText(bytes.toString('utf8'), res.headers.get('content-type') ?? '')
    return { ok: true, status: res.status, url: raw, text: text.trim().slice(0, limit) }
  } catch (error) {
    return { ok: false, error: `抓取失败：${error instanceof Error ? error.message : String(error)}` }
  } finally { clearTimeout(timer) }
}