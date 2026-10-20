/** 本地 PDF 解析的线程边界；主线程不加载 PDF.js，也不向解析线程传文件路径。 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { MAX_DOC_BYTES, MAX_DOC_CHARS } from './document.ts'
import { toUnpackedPath } from './runtime-launch.ts'

export const MAX_PDF_PAGES = 500
export const MAX_PDF_PAGE_CHARS = 100_000
export const PDF_TIMEOUT_MS = 15_000

const REASONS = {
  'no-text': 'PDF 未提取到文字，可能为空白、扫描件或内容损坏；未启动 OCR，需另行明确授权',
  password: 'PDF 受密码保护，请先在本地解锁；不会尝试破解密码',
  invalid: 'PDF 已损坏或不是有效的 PDF，无法提取文字',
  'page-limit': 'PDF 页数超过解析上限',
  'char-limit': 'PDF 提取文字超过字数上限，未返回不完整提纲',
  'byte-limit': 'PDF 超过 8MB 解析上限',
  cancelled: 'PDF 解析已取消',
  timeout: 'PDF 解析超时，解析线程已终止',
  'worker-failed': 'PDF 解析线程异常，无法完成本地解析',
} as const

export type PdfErrorCode = keyof typeof REASONS
export interface PdfFailure {
  readonly kind: 'pdf-error'
  readonly code: PdfErrorCode
  readonly reason: string
  readonly pageNumber?: number
  readonly limit?: number
}

export interface PdfPage {
  /** 从 1 开始的物理页，绝不使用印刷页码或压缩空白页。 */
  readonly pageNumber: number
  readonly text: string
  readonly heading: string | null
}

export type PdfParseResult = { readonly kind: 'pdf-pages'; readonly pages: readonly PdfPage[] } | PdfFailure

/** 调用方可缩紧限额，但不能提高硬上限。取消/超时返回前会等待线程真正退出。 */
export interface PdfParseOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly maxPages?: number
  readonly maxChars?: number
  readonly maxPageChars?: number
}
export type PdfParser = (data: Uint8Array, options?: PdfParseOptions) => Promise<PdfParseResult>
export interface PdfLimits {
  readonly maxPages: number
  readonly maxChars: number
  readonly maxPageChars: number
}

export function pdfFailure(code: PdfErrorCode, detail: { pageNumber?: number; limit?: number } = {}): PdfFailure {
  return { kind: 'pdf-error', code, reason: REASONS[code], ...detail }
}

function bound(value: number | undefined, ceiling: number): number {
  return value === undefined || !Number.isFinite(value) ? ceiling : Math.max(1, Math.min(ceiling, Math.floor(value)))
}

/** 验证线程消息，不把异常或半份提纲当作成功结果。 */
function validResult(value: unknown, limits: PdfLimits): value is PdfParseResult {
  if (value === null || typeof value !== 'object') return false
  const result = value as Partial<PdfParseResult>
  if (result.kind === 'pdf-error') {
    return typeof result.code === 'string' && Object.hasOwn(REASONS, result.code)
      && typeof result.reason === 'string'
  }
  if (result.kind !== 'pdf-pages' || !Array.isArray(result.pages)
    || result.pages.length === 0 || result.pages.length > limits.maxPages) return false
  let count = 0
  return result.pages.every((page: PdfPage, index: number) => {
    if (!page || page.pageNumber !== index + 1 || typeof page.text !== 'string'
      || !(page.heading === null || typeof page.heading === 'string')) return false
    count += page.text.length
    return page.text.length <= limits.maxPageChars && count <= limits.maxChars
      && (page.heading === null || page.heading.length <= 120)
  })
}

/** 仅接受授权后读取的二进制快照，不接收 URL、密码、脚本或外部资源地址。 */
export async function parsePdf(data: Uint8Array, options: PdfParseOptions = {}): Promise<PdfParseResult> {
  if (options.signal?.aborted) return pdfFailure('cancelled')
  if (data.byteLength > MAX_DOC_BYTES) return pdfFailure('byte-limit', { limit: MAX_DOC_BYTES })
  const limits: PdfLimits = {
    maxPages: bound(options.maxPages, MAX_PDF_PAGES),
    maxChars: bound(options.maxChars, MAX_DOC_CHARS),
    maxPageChars: bound(options.maxPageChars, MAX_PDF_PAGE_CHARS),
  }
  // 独立数组避免转移 Buffer 池或使调用方的原始快照失效。
  const bytes = new Uint8Array(data)
  let worker: Worker
  try {
    // worker 线程从真实路径启动：打包后它在 app.asar.unpacked（见 asarUnpack 的第 ② 项）。
    // 开发态 `.ts` 分支保持原样 —— 那时跑的是 node --test 的 TypeScript 直通，没有 asar。
    const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './doc-pdf-worker.ts' : './doc-pdf-worker.js', import.meta.url)
    worker = new Worker(import.meta.url.endsWith('.ts') ? workerUrl : toUnpackedPath(fileURLToPath(workerUrl)), {
      workerData: { bytes, limits },
      transferList: [bytes.buffer],
      execArgv: [],
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    })
  } catch {
    return pdfFailure('worker-failed')
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: PdfParseResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
      // 不是 Promise.race：即使 PDF.js 同步死循环，terminate 也会停止执行并回收线程。
      void worker.terminate().then(() => {
        worker.removeAllListeners()
        resolve(result)
      }, () => {
        worker.removeAllListeners()
        resolve(pdfFailure('worker-failed'))
      })
    }
    const cancel = (): void => finish(pdfFailure('cancelled'))
    const timer = setTimeout(() => finish(pdfFailure('timeout')), bound(options.timeoutMs, PDF_TIMEOUT_MS))
    worker.once('message', (value: unknown) => finish(validResult(value, limits) ? value : pdfFailure('worker-failed')))
    worker.once('error', () => finish(pdfFailure('worker-failed')))
    worker.once('exit', () => finish(pdfFailure('worker-failed')))
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) cancel()
  })
}
