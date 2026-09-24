/** 仅在可终止的 Node worker 内运行 PDF.js；不加载 viewer、脚本沙箱、OCR 或渲染器。 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parentPort, workerData } from 'node:worker_threads'
import { getDocument, GlobalWorkerOptions, PasswordException } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFPageProxy, TextContent, TextItem } from 'pdfjs-dist/types/src/display/api.js'
import { pdfFailure, type PdfLimits, type PdfPage, type PdfParseResult } from './doc-pdf.ts'

// PDF.js 在 Node 中使用内部回环 worker；整套回环运行于外层可终止线程，而不是 Electron 主线程。
// external 保留原包结构，API 和 worker 必须从同一个安装版本解析。
GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
const resourceRoot = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')))

/** 6.3 的真实资源入口。只读随包 CMap/标准字体，拒绝路径、URL、WASM 与字体外链。 */
class LocalBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const directory = kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'standard_fonts' : null
    const extension = kind === 'cMapUrl' ? /\.bcmap$/ : /\.(pfb|ttf)$/
    if (!directory || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(filename) || !extension.test(filename)) {
      throw new Error('PDF 外部资源读取已禁用')
    }
    return new Uint8Array(await readFile(path.join(resourceRoot, directory, filename)))
  }
}

// data 模式不会建立文档网络流；即使库后续误走 fetch，也只能失败，不能发出请求。
globalThis.fetch = async () => { throw new Error('PDF 解析禁止网络请求') }

async function pageText(page: PDFPageProxy, limits: PdfLimits, previousChars: number): Promise<PdfPage | ReturnType<typeof pdfFailure>> {
  const reader = (page.streamTextContent({ includeMarkedContent: false }) as ReadableStream<TextContent>).getReader()
  const parts: string[] = []
  let length = 0
  let previous: TextItem | undefined
  let lineEnded = false
  let complete = false
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) { complete = true; break }
      for (const item of chunk.value.items) {
        if (!('str' in item)) continue
        if (item.str === '') { lineEnded ||= item.hasEOL; continue }
        let separator = ''
        if (previous) {
          const differentLine = Math.abs(item.transform[5] - previous.transform[5]) > Math.max(1, previous.height / 2)
          const gap = item.transform[4] - (previous.transform[4] + previous.width)
          separator = lineEnded || differentLine ? '\n' : gap > Math.max(1, previous.height * 0.15) ? ' ' : ''
        }
        length += separator.length + item.str.length
        if (length > limits.maxPageChars || previousChars + length > limits.maxChars) {
          return pdfFailure('char-limit', {
            pageNumber: page.pageNumber,
            limit: length > limits.maxPageChars ? limits.maxPageChars : limits.maxChars,
          })
        }
        parts.push(separator, item.str)
        previous = item
        lineEnded = item.hasEOL
      }
    }
    const text = parts.join('').trim()
    const firstLine = text.split('\n', 1)[0].trim()
    // ponytail: 每个物理页一段，首行仅作提纲标签；复杂多栏/标题层级需专门的版面分析。
    return { pageNumber: page.pageNumber, text, heading: firstLine && firstLine.length <= 120 ? firstLine : null }
  } finally {
    if (!complete) {
      // 超限或流异常时停止生产后续文本，loadingTask 的 finally 继续销毁整份文档。
      await reader.cancel().catch(() => { /* 流可能已经因坏 PDF 关闭。 */ })
    }
    reader.releaseLock()
    page.cleanup()
  }
}

async function extract(bytes: Uint8Array, limits: PdfLimits): Promise<PdfParseResult> {
  const task = getDocument({
    data: bytes,
    BinaryDataFactory: LocalBinaryDataFactory,
    useWorkerFetch: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    maxImageSize: 0,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    stopAtErrors: true,
    verbosity: 0,
    // 6.3 已移除 isEvalSupported；不传无效开关，也不导入执行文档 JavaScript 的 sandbox/viewer。
  })
  try {
    const pdf = await task.promise
    if (pdf.numPages > limits.maxPages) return pdfFailure('page-limit', { limit: limits.maxPages })
    const pages: PdfPage[] = []
    let charCount = 0
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pageText(await pdf.getPage(number), limits, charCount)
      if ('kind' in page) return page
      pages.push(page)
      charCount += page.text.length
    }
    return charCount === 0 ? pdfFailure('no-text') : { kind: 'pdf-pages', pages }
  } catch (error) {
    return pdfFailure(error instanceof PasswordException ? 'password' : 'invalid')
  } finally {
    await task.destroy()
  }
}

if (!parentPort) throw new Error('PDF 解析必须在独立线程运行')
const { bytes, limits } = workerData as { bytes: Uint8Array; limits: PdfLimits }
try {
  parentPort.postMessage(await extract(bytes, limits))
} catch {
  parentPort.postMessage(pdfFailure('worker-failed'))
} finally {
  parentPort.close()
}
