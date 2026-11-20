/**
 * 阅读视图页面：用 pdf.js 把主进程交来的 PDF 字节真实画到 canvas 上。
 *
 * 这一页能做的事被刻意收得很窄：
 * - 字节、页许可、字体资源都只能凭主进程签发的令牌向主进程要，页面里没有任何路径；
 * - 每显示一页之前都先要一次页许可（主进程会重查授权根与指纹）。许可被拒就把已加载的文档
 *   整个丢掉——内存里那份 PDF 不能成为绕过授权的缓存；
 * - pdf.js 在本页线程内运行（`globalThis.pdfjsWorker`），不起 worker 脚本、不拉远端资源、
 *   不执行文档脚本、不画可点击的注释层；
 * - 页面自己不决定讲到哪：位置只由主进程的 goto 决定；用户滚动只是浏览，不会"脱离"。
 * - 高亮只画在与主进程解析结果逐字一致的文字层片段上；对不上就退回页级，并写明原因。
 *
 * 显示方式是连续滚动（像 WPS 的 PDF 阅读）：所有页按顺序纵向排开，滚动就能看到全文；
 * 讲解跟随只在"这一段快到底 / 换了页"时往下带一屏，绝不对着每一句来回滚。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
// 用 legacy 构建：现代构建依赖 Uint8Array.prototype.toHex 等较新的内建，Electron 37（Chromium 138）尚未提供。
// 与解析线程（doc-pdf-worker.ts）同一构建、同一版本，文字层拼接结果也因此一致。
import { getDocument, InvalidPDFException, PasswordException, Util, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
// @ts-expect-error pdf.js 未给 worker 入口提供类型声明；这里只取其 WorkerMessageHandler 在本线程运行。
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import {
  describeAnchor,
  describeStatus,
  joinTextRuns,
  textDigest,
  type DocAnchor,
  type DocViewDescriptor,
  type DocViewProblem,
  type PdfTextRun,
  type PresenterStatus,
} from '../main/doc-presenter.js'
import type { DocViewApi, DocViewCommand } from '../preload/doc-view.js'
import { followScrollTop } from './doc-view-follow.js'
import './doc-view.css'

declare global {
  interface Window {
    readonly docView: DocViewApi
  }
}

// 本线程内运行 pdf.js 的解析端：不需要 worker 脚本地址，也就没有任何脚本加载请求。
;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker

const api = window.docView

interface Rect { left: number; top: number; width: number; height: number }

interface PageSize {
  readonly page: number
  readonly width: number
  readonly height: number
}

interface TextLayer {
  readonly runs: readonly PdfTextRun[]
  readonly joined: ReturnType<typeof joinTextRuns>
  readonly viewport: { readonly scale: number; readonly transform: readonly number[] }
  readonly textMatch: boolean | null
}

interface AnchorView {
  readonly page: number
  readonly highlight: 'none' | 'page' | 'text'
  readonly textMatch: boolean | null
  readonly rects: readonly Rect[]
}

function shortFingerprint(fingerprint: string): string {
  const [size, hash] = fingerprint.split(':')
  return hash ? `${size}:${hash.slice(0, 12)}…` : fingerprint
}

/** pdf.js 的二进制资源出口：只经令牌向主进程要随包 CMap 与标准字体，不发任何请求。 */
function binaryFactory(token: string) {
  return class IpcBinaryDataFactory {
    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      const data = await api.resource(token, kind, filename)
      if (data === null) throw new Error(`本地资源不可用：${kind}/${filename}`)
      return data
    }
  }
}

function App() {
  const [descriptor, setDescriptor] = useState<DocViewDescriptor | null>(null)
  const [failure, setFailure] = useState<DocViewProblem | null>(null)
  const [status, setStatus] = useState<PresenterStatus | null>(null)
  const [anchorView, setAnchorView] = useState<AnchorView | null>(null)
  const [sizes, setSizes] = useState<readonly PageSize[]>([])
  const [renderedPages, setRenderedPages] = useState<ReadonlySet<number>>(new Set())
  const [displayPage, setDisplayPage] = useState(1)
  const [pageInput, setPageInput] = useState('')
  const [loading, setLoading] = useState(true)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const sheetRefs = useRef(new Map<number, HTMLDivElement>())
  const canvasRefs = useRef(new Map<number, HTMLCanvasElement>())
  const renderedRef = useRef(new Set<number>())
  const inflightRef = useRef(new Map<number, Promise<void>>())
  const renderTasksRef = useRef(new Set<{ cancel(): void }>())
  const layersRef = useRef(new Map<number, TextLayer>())
  const sizesRef = useRef<readonly PageSize[]>([])
  const pdfRef = useRef<PDFDocumentProxy | null>(null)
  const descriptorRef = useRef<DocViewDescriptor | null>(null)
  const loadSeq = useRef(0)
  /** 上一次跟随滚动的页；换页时即使块在可视区也要把新页带上来。 */
  const lastFollowPage = useRef<number | null>(null)
  const displayPageRef = useRef(1)
  const scrollRaf = useRef(0)
  const pendingStart = useRef<{ anchor: DocAnchor; highlight: boolean } | null>(null)

  const setDisplay = useCallback((page: number) => {
    displayPageRef.current = page
    setDisplayPage(page)
    if ((document.activeElement as HTMLElement | null)?.tagName !== 'INPUT') setPageInput(String(page))
  }, [])

  const drop = useCallback((problem: DocViewProblem) => {
    loadSeq.current += 1
    for (const task of renderTasksRef.current) task.cancel()
    renderTasksRef.current.clear()
    inflightRef.current.clear()
    renderedRef.current.clear()
    layersRef.current.clear()
    sizesRef.current = []
    pdfRef.current?.loadingTask.destroy()
    pdfRef.current = null
    descriptorRef.current = null
    for (const canvas of canvasRefs.current.values()) { canvas.width = 0; canvas.height = 0 }
    pendingStart.current = null
    setSizes([])
    setRenderedPages(new Set())
    setAnchorView(null)
    setFailure(problem)
  }, [])

  /** 文字层片段高亮：只在摘要一致时画，且按整段文字项画（不暗示逐字）。 */
  const rectsOf = useCallback((anchor: DocAnchor, layer: TextLayer): Rect[] => {
    if (anchor.precision !== 'text' || anchor.textStart === undefined || anchor.textEnd === undefined || layer.textMatch !== true) return []
    const start = anchor.textStart
    const end = anchor.textEnd
    return layer.runs.flatMap((run, index) => {
      const span = layer.joined.spans[index]
      if (!span || span.end <= start || span.start >= end) return []
      const tx = Util.transform(layer.viewport.transform as number[], run.transform as number[])
      const height = Math.hypot(tx[2], tx[3])
      return [{ left: tx[4], top: tx[5] - height, width: run.width * layer.viewport.scale, height }]
    })
  }, [])

  /** 画一页：先拿许可、再画、再核对文字层摘要。同一页并发只画一次。 */
  const renderPage = useCallback(async (page: number): Promise<void> => {
    const desc = descriptorRef.current
    const pdf = pdfRef.current
    if (!desc?.token || !pdf || page < 1 || page > pdf.numPages || renderedRef.current.has(page)) return
    const running = inflightRef.current.get(page)
    if (running) return running
    const job = (async () => {
      const grant = await api.page(desc.token!, desc.fingerprint, page)
      if (descriptorRef.current !== desc || pdfRef.current !== pdf) return
      if (!grant.ok) { drop(grant.problem); return }
      const pdfPage = await pdf.getPage(page)
      try {
        const canvas = canvasRefs.current.get(page)
        const stage = stageRef.current
        if (!canvas || !stage || descriptorRef.current !== desc) return
        const base = pdfPage.getViewport({ scale: 1 })
        const scale = Math.max(0.3, Math.min(3, (stage.clientWidth - 44) / base.width))
        const viewport = pdfPage.getViewport({ scale })
        const ratio = window.devicePixelRatio || 1
        canvas.width = Math.floor(viewport.width * ratio)
        canvas.height = Math.floor(viewport.height * ratio)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        const context = canvas.getContext('2d')
        if (!context) throw new Error('无法创建画布')
        const renderTask = pdfPage.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        })
        renderTasksRef.current.add(renderTask)
        try {
          await renderTask.promise
        } catch (renderError) {
          // 被新页取消不算失败：静默退出，报错会把阅读视图整个停掉。
          if (renderError instanceof Error && renderError.name === 'RenderingCancelledException') return
          throw renderError
        } finally {
          renderTasksRef.current.delete(renderTask)
        }
        if (descriptorRef.current !== desc) return
        const content = await pdfPage.getTextContent({ includeMarkedContent: false })
        const runs = content.items.filter((item): item is PdfTextRun & typeof item => 'str' in item) as unknown as PdfTextRun[]
        const joined = joinTextRuns(runs)
        const textMatch = grant.textDigest === null ? null : textDigest(joined.text) === grant.textDigest
        layersRef.current.set(page, { runs, joined, viewport, textMatch })
        renderedRef.current.add(page)
        setRenderedPages(new Set(renderedRef.current))
        api.report(desc.token!, { kind: 'rendered', page, numPages: pdf.numPages, textMatch })
      } catch (error) {
        if (descriptorRef.current !== desc) return
        const message = error instanceof Error ? error.message : String(error)
        api.report(desc.token!, { kind: 'error', message: `第 ${page} 页渲染失败：${message}` })
        setFailure({ code: 'invalid', message: `第 ${page} 页渲染失败：${message}` })
      } finally {
        pdfPage.cleanup()
      }
    })()
    inflightRef.current.set(page, job)
    try { await job } finally { inflightRef.current.delete(page) }
  }, [drop])

  /** 只在这段快到底 / 已经滚出顶部 / 换页时滚一次；其余情况一页都不动。 */
  const scrollToBlock = useCallback((page: number, rects: readonly Rect[]): void => {
    const stage = stageRef.current
    const sheet = sheetRefs.current.get(page)
    if (!stage || !sheet) return
    const stageTop = stage.getBoundingClientRect().top
    const pageTop = sheet.getBoundingClientRect().top - stageTop + stage.scrollTop
    const blockTop = pageTop + (rects[0]?.top ?? 0)
    const last = rects[rects.length - 1]
    const blockHeight = last === undefined ? Math.min(sheet.offsetHeight, stage.clientHeight) : last.top + last.height - rects[0]!.top
    const pageChanged = lastFollowPage.current !== page
    const target = followScrollTop({
      blockTop, blockHeight, pageTop,
      viewTop: stage.scrollTop,
      viewportHeight: stage.clientHeight,
      pageChanged,
      pageLevel: rects.length === 0,
    })
    lastFollowPage.current = page
    if (target === null) return
    try { stage.scrollTo({ top: target, behavior: 'smooth' }) } catch { stage.scrollTop = target }
  }, [])

  const goToAnchor = useCallback(async (anchor: DocAnchor, highlight: boolean): Promise<void> => {
    const desc = descriptorRef.current
    if (!desc?.token) return
    // 布局还没排好（大文档正在量页）：先记下目标，排好版后由 effect 统一定位。
    if (!sheetRefs.current.has(anchor.page)) {
      pendingStart.current = { anchor, highlight }
      return
    }
    await renderPage(anchor.page)
    if (descriptorRef.current !== desc) return
    const layer = layersRef.current.get(anchor.page) ?? null
    const rects = highlight && layer ? rectsOf(anchor, layer) : []
    const mode: AnchorView['highlight'] = !highlight ? 'none' : rects.length > 0 ? 'text' : 'page'
    setAnchorView({ page: anchor.page, highlight: mode, textMatch: layer?.textMatch ?? null, rects })
    setDisplay(anchor.page)
    scrollToBlock(anchor.page, rects)
  }, [rectsOf, renderPage, scrollToBlock, setDisplay])

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoading(true)
    setFailure(null)
    setAnchorView(null)
    for (const task of renderTasksRef.current) task.cancel()
    renderTasksRef.current.clear()
    inflightRef.current.clear()
    renderedRef.current.clear()
    layersRef.current.clear()
    sizesRef.current = []
    setSizes([])
    setRenderedPages(new Set())
    const old = pdfRef.current
    pdfRef.current = null
    void old?.loadingTask.destroy()
    const desc = await api.session()
    if (seq !== loadSeq.current) return
    descriptorRef.current = desc
    setDescriptor(desc)
    setStatus(desc?.lastStatus ?? null)
    if (desc === null) { setLoading(false); setFailure(null); return }
    if (desc.problem) { setLoading(false); setFailure(desc.problem); return }
    if (!desc.token) { setLoading(false); setFailure({ code: 'invalid-token', message: '阅读会话已失效' }); return }
    /*
      读文档字节加超时：IPC 不回、主进程卡住时以前会永远停在"正在加载…"，
      用户既看不到内容也不知道出了什么事。现在超时就明确报错。
    */
    const bytes = await Promise.race([
      api.bytes(desc.token, desc.fingerprint),
      new Promise<{ ok: false; problem: DocViewProblem }>(resolve => setTimeout(
        () => resolve({ ok: false, problem: { code: 'timeout', message: '文档内容读取超时（20 秒没响应）' } }),
        20_000,
      )),
    ])
    if (seq !== loadSeq.current) return
    if (!bytes.ok) { setLoading(false); drop(bytes.problem); return }
    try {
      const task = getDocument({
        data: bytes.bytes,
        BinaryDataFactory: binaryFactory(desc.token),
        useWorkerFetch: false,
        useSystemFonts: false,
        useWasm: false,
        enableXfa: false,
        disableRange: true,
        disableStream: true,
        disableAutoFetch: true,
        verbosity: 0,
      })
      const pdf = await (async () => {
        // 解析阶段也要有超时：getDocument 卡死时不能让用户对着"正在加载"干等。
        const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('PDF 解析超时（20 秒）')), 20_000))
        try {
          return await Promise.race([task.promise, deadline])
        } catch (error) {
          void task.destroy()
          throw error
        }
      })()
      if (seq !== loadSeq.current) { void task.destroy(); return }
      pdfRef.current = pdf
      /*
        先把每页的尺寸量出来再排座位：连续滚动下如果页高是猜的，渲染完成时会整页跳动。
        量尺寸只读页面元数据，不显示任何内容，也不需要页许可。
      */
      const width = Math.max(320, (stageRef.current?.clientWidth ?? 900) - 44)
      const pageSizes: PageSize[] = []
      for (let page = 1; page <= pdf.numPages; page++) {
        const pdfPage = await pdf.getPage(page)
        try {
          const base = pdfPage.getViewport({ scale: 1 })
          const scale = Math.max(0.3, Math.min(3, width / base.width))
          pageSizes.push({ page, width: Math.floor(base.width * scale), height: Math.floor(base.height * scale) })
        } finally { pdfPage.cleanup() }
        if (seq !== loadSeq.current) return
      }
      sizesRef.current = pageSizes
      setSizes(pageSizes)
      setLoading(false)
      const goto = desc.lastGoto
      // 量页期间可能已经有新的 goto 进来：保留它，别用开讲起点覆盖用户的当前位置。
      if (pendingStart.current === null) {
        pendingStart.current = {
          anchor: goto?.anchor ?? { sectionIndex: 0, page: desc.startPage, precision: 'page', fallback: 'section' },
          highlight: goto?.highlight ?? false,
        }
      }
    } catch (error) {
      setLoading(false)
      if (error instanceof PasswordException) drop({ code: 'password', message: 'PDF 受密码保护，不会尝试解锁' })
      else if (error instanceof InvalidPDFException) drop({ code: 'invalid', message: 'PDF 已损坏或不是有效的 PDF' })
      else drop({ code: 'invalid', message: `PDF 无法加载：${error instanceof Error ? error.message : String(error)}` })
      api.report(desc.token, { kind: 'error', message: 'PDF 在阅读视图中无法加载' })
    }
  }, [drop])

  // 布局排好后再定位起点：此时 sheet 元素已经存在，量出来的位置才准。
  useEffect(() => {
    if (sizes.length === 0) return
    const start = pendingStart.current
    if (start === null) return
    pendingStart.current = null
    void (async () => {
      await goToAnchor(start.anchor, start.highlight)
      // 起点页的下一屏预渲染，滚动时不会先看到空白。
      void renderPage(start.anchor.page + 1)
    })()
  }, [sizes, goToAnchor, renderPage])

  /** 滚动只更新页码与预渲染相邻页；不向主进程报告"用户翻页"，自动跟随继续有效。 */
  const onScroll = useCallback(() => {
    if (scrollRaf.current) return
    scrollRaf.current = window.requestAnimationFrame(() => {
      scrollRaf.current = 0
      const stage = stageRef.current
      if (!stage || sizesRef.current.length === 0) return
      const stageTop = stage.getBoundingClientRect().top
      const mid = stage.scrollTop + stage.clientHeight / 2
      let page = 1
      for (const size of sizesRef.current) {
        const element = sheetRefs.current.get(size.page)
        if (!element) continue
        if (element.getBoundingClientRect().top - stageTop + stage.scrollTop <= mid) page = size.page
      }
      if (page !== displayPageRef.current) setDisplay(page)
      for (const next of [page - 1, page, page + 1]) void renderPage(next)
    })
  }, [renderPage, setDisplay])

  /** 显式跳页（按钮 / 键盘 / 输入）：这是"我要离开讲解位置"，按原协议如实上报。 */
  const flip = useCallback((page: number) => {
    const desc = descriptorRef.current
    const total = sizesRef.current.length
    if (!desc?.token || !Number.isInteger(page) || page < 1 || page > total) return
    if (page === displayPageRef.current) return
    api.report(desc.token, { kind: 'page', page })
    setDisplay(page)
    void (async () => {
      await renderPage(page)
      const stage = stageRef.current
      const sheet = sheetRefs.current.get(page)
      if (!stage || !sheet) return
      const top = sheet.getBoundingClientRect().top - stage.getBoundingClientRect().top + stage.scrollTop - 12
      try { stage.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }) } catch { stage.scrollTop = Math.max(0, top) }
    })()
  }, [renderPage, setDisplay])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (sizesRef.current.length === 0 || (event.target as HTMLElement | null)?.tagName === 'INPUT') return
      if (event.key === 'ArrowRight' || event.key === 'PageDown') flip(displayPageRef.current + 1)
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') flip(displayPageRef.current - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flip])

  // 订阅只装一次：load/goToAnchor 的标识会变化，若放进依赖会整份文档重载。
  const loadRef = useRef(load)
  loadRef.current = load
  const goToRef = useRef(goToAnchor)
  goToRef.current = goToAnchor
  useEffect(() => {
    const offSession = api.onSessionChanged(() => { void loadRef.current() })
    const offCommand = api.onCommand((command: DocViewCommand) => {
      if (command.type === 'status') setStatus(command.status)
      else if (command.type === 'goto') void goToRef.current(command.anchor, command.highlight)
      // 令牌作废：已加载的文档整份丢掉，显示主进程给出的具体原因（文件变化 / 授权撤销）。
      else if (command.type === 'invalidated') drop({ ...command.problem, message: `${command.problem.message}；已丢弃页面数据` })
    })
    void loadRef.current()
    return () => { offSession(); offCommand() }
  }, [drop])

  const token = descriptor?.token ?? null
  const detached = status?.mode === 'detached'
  const scanned = descriptor !== null && descriptor.problem === null && !descriptor.textLayer
  const total = sizes.length

  return (
    <div className="dv-root">
      <header className="dv-bar">
        <div className="dv-title" title={descriptor?.name ?? ''}>{descriptor?.name ?? '阅读视图'}</div>
        <div className="dv-nav">
          <button type="button" disabled={total === 0 || displayPage <= 1} onClick={() => flip(displayPage - 1)} aria-label="上一页">‹</button>
          <input
            className="dv-page-input"
            value={pageInput}
            inputMode="numeric"
            aria-label="跳到物理页"
            onChange={event => setPageInput(event.target.value.replace(/\D/g, ''))}
            onKeyDown={event => { if (event.key === 'Enter') flip(Number(pageInput)) }}
          />
          <span className="dv-page-total" data-testid="page-label">
            {total === 0 ? '—' : `第 ${displayPage} / ${total} 页（物理页）· 连续滚动`}
          </span>
          <button type="button" disabled={total === 0 || displayPage >= total} onClick={() => flip(displayPage + 1)} aria-label="下一页">›</button>
        </div>
      </header>

      <div className="dv-meta">
        <span title={descriptor?.fingerprint ?? ''}>指纹 {descriptor ? shortFingerprint(descriptor.fingerprint) : '—'}</span>
        <span data-testid="anchor-label">讲解位置：{describeAnchor(status?.narration ?? null)}</span>
        {anchorView?.highlight === 'text' && <span className="dv-note">高亮为文字层片段，非逐字</span>}
        {anchorView?.textMatch === false && <span className="dv-warn">本页文字层与解析结果不一致，只按页定位</span>}
      </div>

      {status && <div className={`dv-status dv-status-${status.mode}`} data-testid="status-label">{describeStatus(status)}</div>}
      {scanned && <div className="dv-status dv-status-scanned">扫描件 / 无文字层：仅按页显示与定位，未做 OCR，不提取正文</div>}

      {detached && token && (
        <div className="dv-detached" role="alert">
          <span>你翻到了第 {displayPage} 页，页面不再自动跟随讲解。</span>
          <button type="button" onClick={() => api.report(token, { kind: 'return' })}>回到讲解位置</button>
          <button type="button" onClick={() => api.report(token, { kind: 'from-here', page: displayPage })}>从此处讲</button>
        </div>
      )}

      {failure && <div className="dv-failure" role="alert" data-testid="failure" data-code={failure.code}>{failure.message}</div>}
      {loading && !failure && <div className="dv-loading">正在加载…</div>}

      <div className="dv-stage" ref={stageRef} onScroll={onScroll}>
        <div className="dv-pages">
          {sizes.map(size => {
            const current = anchorView?.page === size.page
            return (
              <div
                key={size.page}
                ref={element => { if (element) sheetRefs.current.set(size.page, element); else sheetRefs.current.delete(size.page) }}
                className={`dv-sheet${current && anchorView?.highlight === 'page' ? ' dv-sheet-current' : ''}`}
                data-testid="sheet"
                data-rendered-page={size.page}
                data-text-match={current && anchorView?.textMatch !== null ? (anchorView.textMatch ? '1' : '0') : ''}
                data-highlight={current ? anchorView?.highlight ?? 'none' : 'none'}
                style={{ width: size.width, height: size.height }}
              >
                <canvas ref={element => { if (element) canvasRefs.current.set(size.page, element); else canvasRefs.current.delete(size.page) }} />
                {!renderedPages.has(size.page) && <div className="dv-sheet-placeholder">第 {size.page} 页</div>}
                {current && anchorView?.rects.map((rect, index) => (
                  <div
                    key={index}
                    className="dv-mark"
                    style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)