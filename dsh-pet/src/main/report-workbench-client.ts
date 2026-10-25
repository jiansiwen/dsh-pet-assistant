/**
 * 日报工作台的桥接调用（M3-04 / M3-05）。
 *
 * 只用聊天令牌（bridge.json）：工作台能做的只是读视图、提交逐条修订、请求发布与请求删除，
 * 这些在插件侧都只会生成待批提案。审批凭据（bridge-approval.json）这里一次都不读——
 * 批准只能从主进程的专用审批窗口签发（approval-window.ts）。
 *
 * 每次调用都重新读 bridge.json：运行时重启后端口与令牌会变，缓存旧值只会得到一串 401。
 * 失败统一翻成可展示的中文原因，并保留插件给的 code（unbound / stale_revision / preview_stale…），
 * 界面据此决定是提示刷新还是提示先连上会话。
 */
import { readBridgeInfo, type BridgeInfo } from './harness.ts'

export interface WorkbenchCallResult<T = Record<string, unknown>> {
  ok: boolean
  status: number
  /** 插件给的错误代码，或本端的 no_runtime / unreachable / unauthorized / bad_response。 */
  code?: string
  error?: string
  data: T | null
}

export interface WorkbenchClientOptions {
  readInfo?: () => BridgeInfo | null
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

/** 工作台用到的全部桥接调用。路由与请求体形状与插件 workbench.ts 一一对应。 */
export interface WorkbenchClientLike {
  report(date: string): Promise<WorkbenchCallResult>
  edit(body: Record<string, unknown>): Promise<WorkbenchCallResult>
  publishRequest(body: { date: string; revision: number; digest: string; targetPath: string }): Promise<WorkbenchCallResult>
  deletionPreview(body: { category: string; params: Record<string, unknown> }): Promise<WorkbenchCallResult>
  deletionRequest(body: { category: string; params: Record<string, unknown>; previewDigest: string }): Promise<WorkbenchCallResult>
  importMaterial(body: Record<string, unknown>): Promise<WorkbenchCallResult>
  shareRequest(body: { materialId: string }): Promise<WorkbenchCallResult>
  /** 改写一条长期记忆：插件那边只生成待批提案，不直接落库。 */
  editMemory(body: { memoryId: string; text: string; topic?: string }): Promise<WorkbenchCallResult>
}

export class ReportWorkbenchClient implements WorkbenchClientLike {
  private readonly readInfo: () => BridgeInfo | null
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: WorkbenchClientOptions = {}) {
    this.readInfo = options.readInfo ?? readBridgeInfo
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  report(date: string) {
    return this.call('GET', `/workbench/report?date=${encodeURIComponent(date)}`)
  }

  edit(body: Record<string, unknown>) {
    return this.call('POST', '/workbench/report/edit', body)
  }

  publishRequest(body: { date: string; revision: number; digest: string; targetPath: string }) {
    return this.call('POST', '/workbench/report/publish-request', body)
  }

  deletionPreview(body: { category: string; params: Record<string, unknown> }) {
    return this.call('POST', '/workbench/deletion/preview', body)
  }

  deletionRequest(body: { category: string; params: Record<string, unknown>; previewDigest: string }) {
    return this.call('POST', '/workbench/deletion/request', body)
  }

  importMaterial(body: Record<string, unknown>) {
    return this.call('POST', '/workbench/materials/import', body)
  }

  shareRequest(body: { materialId: string }) {
    return this.call('POST', '/workbench/materials/share-request', body)
  }

  editMemory(body: { memoryId: string; text: string; topic?: string }) {
    return this.call('POST', '/workbench/memories/edit', body)
  }

  private async call(method: 'GET' | 'POST', route: string, body?: unknown): Promise<WorkbenchCallResult> {
    const info = this.readInfo()
    if (!info) {
      return { ok: false, status: 0, code: 'no_runtime', error: '没有找到助理运行时：请先启动 dsh 并加载个人助理插件', data: null }
    }
    const separator = route.includes('?') ? '&' : '?'
    let response: Response
    try {
      response = await this.fetchImpl(`http://127.0.0.1:${info.port}${route}${separator}token=${encodeURIComponent(info.token)}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      return {
        ok: false, status: 0, code: 'unreachable', data: null,
        error: `连不上助理运行时：${error instanceof Error ? error.message : String(error)}；写操作结果不明时请刷新核对，不会自动重发`,
      }
    }
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = await response.json() as Record<string, unknown>
    } catch {
      parsed = null
    }
    if (response.status === 401) {
      return { ok: false, status: 401, code: 'unauthorized', error: '桥接令牌已失效（助理运行时可能已重启），请稍后刷新', data: parsed }
    }
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, status: response.status, code: 'bad_response', error: `助理返回了无法识别的内容（HTTP ${response.status}）`, data: null }
    }
    if (!response.ok || parsed.ok !== true) {
      const message = typeof parsed.error === 'string' ? parsed.error : typeof parsed.message === 'string' ? parsed.message : `请求失败（HTTP ${response.status}）`
      return { ok: false, status: response.status, code: typeof parsed.code === 'string' ? parsed.code : undefined, error: message, data: parsed }
    }
    return { ok: true, status: response.status, data: parsed }
  }
}
