/**
 * 阅读视图页面：用 pdf.js 把主进程交来的 PDF 字节真实画到 canvas 上。
 *
 * 这一页能做的事被刻意收得很窄：
 * - 字节、页许可、字体资源都只能凭主进程签发的令牌向主进程要，页面里没有任何路径；
 * - 每显示一页之前都先要一次页许可（主进程会重查授权根与指纹）。许可被拒就把已加载的文档
 *   整个丢掉——内存里那份 PDF 不能成为绕过授权的缓存；
 * - pdf.js 在本页线程内运行（`globalThis.pdfjsWorker`），不起 worker 脚本、不拉远端资源、
 *   不执行文档脚本、不画可点击的注释层；
 * - 页面自己不决定讲到哪：翻页只在收到主进程的 goto 时发生，用户手动翻页会如实回报"已脱离"。
 * - 高亮只画在与主进程解析结果逐字一致的文字层片段上；对不上就退回页级，并写明原因。
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

interface Shown {
  readonly page: number
  readonly numPages: number
  /** 视图拼出的文字层与主进程解析结果是否一致；null = 本页无文字层。 */
  readonly textMatch: boolean | null
  readonly highlight: 'none' | 'page' | 'text'
  readonly rects: readonly Rect[]
  readonly anchor: DocAnchor | null
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
  const [shown, setShown] = useState<Shown | null>(null)
  const [pageInput, setPageInput] = useState('')
  const [loading, setLoading] = useState(true)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  /** 过渡期间承接"上一页"的位图，滚动结束后移除；任何异常路径都会被立刻收起。 */
  const outgoingRef = useRef<HTMLDivElement | null>(null)
  const outgoingCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const sheetRef = useRef<HTMLDivElement | null>(null)
  /** 进行中的翻页过渡；`finish` 可以被打断（连续推进时先收掉上一次）。 */
  const transition = useRef<{ height: number; end: () => void } | null>(null)
  const pdfRef = useRef<PDFDocumentProxy | null>(null)
  const descriptorRef = useRef<DocViewDescriptor | null>(null)
  /** 每次渲染请求的序号：后来的请求作废先前未完成的，避免页面闪回旧页。 */
  const renderSeq = useRef(0)
  /** 正占用主画布的渲染任务：新页进来先取消旧的，否则 pdf.js 报同画布并发 render。 */
  const renderTaskRef = useRef<{ cancel(): void } | null>(null)
  const loadSeq = useRef(0)

  const drop = useCallback((problem: DocViewProblem) => {
    renderSeq.current += 1
    renderTaskRef.current?.cancel()
    renderTaskRef.current = null
    const pdf = pdfRef.current
    pdfRef.current = null
    void pdf?.loadingTask.destroy()
    const canvas = canvasRef.current
    if (canvas) { canvas.width = 0; canvas.height = 0 }
    setShown(null)
    setFailure(problem)
  }, [])

  /**
   * 收掉翻页过渡：把接住旧画面的那一层藏起来，并把滚动位置补回去。
   *
   * 补偿是必须的：旧页在 DOM 里占着高度，移除后它下面那一页会整体上移；把 `scrollTop`
   * 减去同样的高度，视觉上新页停在原处，用户看不到跳动。
   * 幂等：没有进行中的过渡时什么都不做，所以连续推进可以先无条件调它。
   */
  const finishTransition = useCallback((): void => {
    const current = transition.current
    if (current === null) return
    // 收尾（摘听、隐藏旧页、补偿滚动）都在 `end` 里；它自带 `done` 闸，重复调用无副作用。
    // 这里**不能**再补偿一次 —— 补两次会把页面往上顶掉整整一页。
    current.end()
  }, [])

  /**
   * 开始一次翻页过渡：先把**当前画布**拷进旧页层，主画布随即被新页覆盖。
   *
   * 为什么用位图拷贝而不是再渲染一遍旧页：逐页许可是按页向主进程申请的，为了动画多取一次
   * 许可就把安全时序搅进来了 —— 拷贝只是像素搬运，不碰许可、不碰 `renderSeq`。
   * 返回 null 表示这次不做动画（离屏、尺寸为 0、不支持平滑滚动），调用方直接瞬切。
   */
  const beginTransition = useCallback((): { height: number } | null => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    const outgoing = outgoingRef.current
    const copy = outgoingCanvasRef.current
    if (stage === null || canvas === null || outgoing === null || copy === null) return null
    const height = canvas.offsetHeight
    if (height <= 0 || typeof stage.scrollTo !== 'function') return null
    const context = copy.getContext('2d')
    if (context === null) return null
    try {
      copy.width = canvas.width
      copy.height = canvas.height
      copy.style.width = canvas.style.width
      copy.style.height = canvas.style.height
      context.clearRect(0, 0, copy.width, copy.height)
      context.drawImage(canvas, 0, 0)
      outgoing.style.display = 'block'
      outgoing.removeAttribute('aria-hidden')
      return { height }
    } catch {
      // 任何一步失败都退化成瞬切：不留"两页同时存在"的中间态。
      outgoing.style.display = 'none'
      return null
    }
  }, [])

  /** 新页已经画好：平滑滚到它，滚完再收掉旧页。`scrollend` 不触发时用 520ms 兜底。 */
  const scrollToNewPage = useCallback((height: number, focus: (() => number | null) | null = null): void => {
    const stage = stageRef.current
    const sheet = sheetRef.current
    if (stage === null || sheet === null) { finishTransition(); return }
    const offset = sheet.getBoundingClientRect().top - stage.getBoundingClientRect().top + stage.scrollTop
    let done = false
    const end = (): void => {
      if (done) return
      done = true
      stage.removeEventListener('scrollend', end)
      window.clearTimeout(timer)
      // 由 `finishTransition` 负责收尾；这里只摘听，避免重复补偿。
      transition.current = null
      const outgoing = outgoingRef.current
      if (outgoing !== null) {
        outgoing.style.display = 'none'
        outgoing.setAttribute('aria-hidden', 'true')
      }
      stage.scrollTop = Math.max(0, stage.scrollTop - height)
      // 旧页移除、补偿之后才算居中目标：过渡期间旧页还占着布局，现在算会偏一整页。
      const target = focus ? focus() : null
      if (target !== null) {
        try { stage.scrollTo({ top: target, behavior: 'smooth' }) } catch { /* 保持原位 */ }
      }
    }
    const timer = window.setTimeout(end, 520)
    stage.addEventListener('scrollend', end, { once: true })
    transition.current = { height, end }
    try { stage.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' }) }
    catch { end() }
  }, [finishTransition])

  /** 高亮段居中目标（滚动无关量）；没有高亮返回 null。整块居中，不是只居中首行。 */
  const highlightTarget = useCallback((rects: readonly Rect[]): number | null => {
    const stage = stageRef.current
    const sheet = sheetRef.current
    if (!stage || !sheet || rects.length === 0) return null
    const sheetTop = sheet.getBoundingClientRect().top - stage.getBoundingClientRect().top + stage.scrollTop
    const top = rects[0].top
    const last = rects[rects.length - 1]
    const blockHeight = Math.max(last.top + last.height - top, rects[0].height)
    return Math.max(0, sheetTop + top - Math.max(0, (stage.clientHeight - blockHeight) / 2))
  }, [])

  /** 把高亮段滚到屏幕中间：讲解位置与屏幕必须始终对齐，不能停在页顶。 */
  const centerHighlight = useCallback((rects: readonly Rect[]): void => {
    const stage = stageRef.current
    const target = highlightTarget(rects)
    if (!stage || target === null) return
    try { stage.scrollTo({ top: target, behavior: 'smooth' }) } catch { /* 保持原位 */ }
  }, [highlightTarget])

  const showPage = useCallback(async (page: number, target: { anchor: DocAnchor; highlight: boolean } | null) => {
    // 连续推进：先把上一次过渡收干净（它会补偿滚动位置），再开始这一次。
    finishTransition()
    const seq = ++renderSeq.current
    const desc = descriptorRef.current
    const pdf = pdfRef.current
    if (!desc?.token || !pdf) return
    // 先拿许可再画：主进程每次都重查授权与指纹，被拒就整份丢掉。
    const grant = await api.page(desc.token, desc.fingerprint, page)
    if (seq !== renderSeq.current) return
    if (!grant.ok) { drop(grant.problem); return }
    const pdfPage = await pdf.getPage(page)
    // 旧画面在这里被拷走：主画布马上要被新页覆盖，而用户还没看到滚动的过程。
    const outgoing = beginTransition()
    try {
      const stage = stageRef.current
      const canvas = canvasRef.current
      if (!stage || !canvas || seq !== renderSeq.current) return
      const base = pdfPage.getViewport({ scale: 1 })
      const scale = Math.max(0.3, Math.min(3, (stage.clientWidth - 40) / base.width))
      const viewport = pdfPage.getViewport({ scale })
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * ratio)
      canvas.height = Math.floor(viewport.height * ratio)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建画布')
      // 连续推进时上一帧可能还在画：先取消旧任务，pdf.js 才允许同一画布接新 render。
      renderTaskRef.current?.cancel()
      const renderTask = pdfPage.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      })
      renderTaskRef.current = renderTask
      try {
        await renderTask.promise
      } catch (renderError) {
        // 被新页取消不算失败：静默退出，报错会把阅读视图整个停掉。
        if (renderError instanceof Error && renderError.name === 'RenderingCancelledException') return
        throw renderError
      }
      if (seq !== renderSeq.current) return

      // 文字层：与解析线程同一套拼接规则，摘要一致才承认偏移可用。
      const content = await pdfPage.getTextContent({ includeMarkedContent: false })
      const runs = content.items.filter((item): item is PdfTextRun & typeof item => 'str' in item) as unknown as PdfTextRun[]
      const joined = joinTextRuns(runs)
      const textMatch = grant.textDigest === null ? null : textDigest(joined.text) === grant.textDigest

      let highlight: Shown['highlight'] = 'none'
      let rects: Rect[] = []
      const anchor = target && target.anchor.page === page ? target.anchor : null
      if (anchor && target?.highlight) {
        highlight = 'page'
        if (anchor.precision === 'text' && textMatch === true && anchor.textStart !== undefined && anchor.textEnd !== undefined) {
          const start = anchor.textStart
          const end = anchor.textEnd
          rects = runs.flatMap((run, index) => {
            const span = joined.spans[index]
            if (!span || span.end <= start || span.start >= end) return []
            const tx = Util.transform(viewport.transform, run.transform as number[])
            const height = Math.hypot(tx[2], tx[3])
            return [{ left: tx[4], top: tx[5] - height, width: run.width * viewport.scale, height }]
          })
          if (rects.length > 0) highlight = 'text'
        }
      }
      setShown({ page, numPages: pdf.numPages, textMatch, highlight, rects, anchor })
      setPageInput(String(page))
      setFailure(null)
      api.report(desc.token, { kind: 'rendered', page, numPages: pdf.numPages, textMatch })

      if (outgoing !== null) {
        // 翻页：平滑滚到新页，滚完收旧页，再把高亮段送到屏幕中间。
        scrollToNewPage(outgoing.height, () => highlightTarget(rects))
      } else if (rects.length > 0 && stage !== null) {
        // 同页内下一段 / 首次加载：高亮段居中，讲解位置和屏幕始终对齐。
        centerHighlight(rects)
      }
      // 翻页补偿/平滑滚动可能把居中 scroll 顶掉：落定后两次复居中兜底。
      if (rects.length > 0) {
        window.setTimeout(() => centerHighlight(rects), 700)
        window.setTimeout(() => centerHighlight(rects), 1200)
      }
    } catch (error) {
      // 出错的这一帧绝不能留下"旧页还在上面"的中间态：立刻收掉，退回当前页。
      finishTransition()
      if (seq !== renderSeq.current) return
      const message = error instanceof Error ? error.message : String(error)
      api.report(desc.token, { kind: 'error', message: `第 ${page} 页渲染失败：${message}` })
      setFailure({ code: 'invalid', message: `第 ${page} 页渲染失败：${message}` })
    } finally {
      pdfPage.cleanup()
    }
  }, [beginTransition, centerHighlight, drop, finishTransition, highlightTarget, scrollToNewPage, shown?.page])

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoading(true)
    renderSeq.current += 1
    renderTaskRef.current?.cancel()
    renderTaskRef.current = null
    const old = pdfRef.current
    pdfRef.current = null
    void old?.loadingTask.destroy()
    setShown(null)
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
      setLoading(false)
      const goto = desc.lastGoto
      await showPage(goto?.anchor.page ?? desc.startPage, goto)
    } catch (error) {
      setLoading(false)
      if (error instanceof PasswordException) drop({ code: 'password', message: 'PDF 受密码保护，不会尝试解锁' })
      else if (error instanceof InvalidPDFException) drop({ code: 'invalid', message: 'PDF 已损坏或不是有效的 PDF' })
      else drop({ code: 'invalid', message: `PDF 无法加载：${error instanceof Error ? error.message : String(error)}` })
      api.report(desc.token, { kind: 'error', message: 'PDF 在阅读视图中无法加载' })
    }
  }, [drop, showPage])

  /** 用户自己翻页：先如实回报（主进程据此判定"已脱离"），再按许可显示。 */
  const flip = useCallback((page: number) => {
    const desc = descriptorRef.current
    const pdf = pdfRef.current
    if (!desc?.token || !pdf || !Number.isInteger(page) || page < 1 || page > pdf.numPages) return
    if (page === shown?.page) return
    api.report(desc.token, { kind: 'page', page })
    void showPage(page, null)
  }, [shown, showPage])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!shown || (event.target as HTMLElement | null)?.tagName === 'INPUT') return
      if (event.key === 'ArrowRight' || event.key === 'PageDown') flip(shown.page + 1)
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') flip(shown.page - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flip, shown])

  // 订阅只装一次：load/showPage 的标识会随翻页变化，若把它们放进依赖，
  // 每次翻页都会重跑 effect → 整份文档重新加载 → 永远"正在加载"，还会并发渲染撞画布。
  const loadRef = useRef(load)
  loadRef.current = load
  const showPageRef = useRef(showPage)
  showPageRef.current = showPage
  useEffect(() => {
    const offSession = api.onSessionChanged(() => { void loadRef.current() })
    const offCommand = api.onCommand((command: DocViewCommand) => {
      if (command.type === 'status') setStatus(command.status)
      else if (command.type === 'goto') void showPageRef.current(command.anchor.page, { anchor: command.anchor, highlight: command.highlight })
      // 令牌作废：已加载的文档整份丢掉，显示主进程给出的具体原因（文件变化 / 授权撤销）。
      else if (command.type === 'invalidated') drop({ ...command.problem, message: `${command.problem.message}；已丢弃页面数据` })
    })
    void loadRef.current()
    return () => { offSession(); offCommand() }
  }, [drop])

  const token = descriptor?.token ?? null
  const detached = status?.mode === 'detached'
  const scanned = descriptor !== null && descriptor.problem === null && !descriptor.textLayer

  return (
    <div className="dv-root">
      <header className="dv-bar">
        <div className="dv-title" title={descriptor?.name ?? ''}>{descriptor?.name ?? '阅读视图'}</div>
        <div className="dv-nav">
          <button type="button" disabled={!shown || shown.page <= 1} onClick={() => shown && flip(shown.page - 1)} aria-label="上一页">‹</button>
          <input
            className="dv-page-input"
            value={pageInput}
            inputMode="numeric"
            aria-label="跳到物理页"
            onChange={event => setPageInput(event.target.value.replace(/\D/g, ''))}
            onKeyDown={event => { if (event.key === 'Enter') flip(Number(pageInput)) }}
          />
          <span className="dv-page-total" data-testid="page-label">
            {shown ? `第 ${shown.page} / ${shown.numPages} 页（物理页）` : '—'}
          </span>
          <button type="button" disabled={!shown || shown.page >= shown.numPages} onClick={() => shown && flip(shown.page + 1)} aria-label="下一页">›</button>
        </div>
      </header>

      <div className="dv-meta">
        <span title={descriptor?.fingerprint ?? ''}>指纹 {descriptor ? shortFingerprint(descriptor.fingerprint) : '—'}</span>
        <span data-testid="anchor-label">讲解位置：{describeAnchor(status?.narration ?? null)}</span>
        {shown?.textMatch === false && <span className="dv-warn">本页文字层与解析结果不一致，只按页定位</span>}
        {shown && shown.highlight === 'text' && <span className="dv-note">高亮为文字层片段，非逐字</span>}
      </div>

      {status && <div className={`dv-status dv-status-${status.mode}`} data-testid="status-label">{describeStatus(status)}</div>}
      {scanned && <div className="dv-status dv-status-scanned">扫描件 / 无文字层：仅按页显示与定位，未做 OCR，不提取正文</div>}

      {detached && token && shown && (
        <div className="dv-detached" role="alert">
          <span>你翻到了第 {shown.page} 页，页面不再自动跟随讲解。</span>
          <button type="button" onClick={() => api.report(token, { kind: 'return' })}>回到讲解位置</button>
          <button type="button" onClick={() => api.report(token, { kind: 'from-here', page: shown.page })}>从此处讲</button>
        </div>
      )}

      {failure && <div className="dv-failure" role="alert" data-testid="failure" data-code={failure.code}>{failure.message}</div>}
      {loading && !failure && <div className="dv-loading">正在加载…</div>}

      <div className="dv-stage" ref={stageRef}>
        {/* 两页上下排：上面那层只在翻页过渡的几百毫秒里存在，装的是上一页的位图。 */}
        <div className="dv-pages">
          <div className="dv-sheet dv-sheet-outgoing" ref={outgoingRef} aria-hidden="true" style={{ display: 'none' }}>
            <canvas ref={outgoingCanvasRef} />
          </div>
        <div
          ref={sheetRef}
          className={`dv-sheet${shown?.highlight === 'page' ? ' dv-sheet-current' : ''}`}
          data-testid="sheet"
          data-rendered-page={shown?.page ?? ''}
          data-text-match={shown?.textMatch === null || shown === null ? '' : shown.textMatch ? '1' : '0'}
          data-highlight={shown?.highlight ?? 'none'}
          style={{ display: shown ? 'block' : 'none' }}
        >
          <canvas ref={canvasRef} />
          {shown?.rects.map((rect, index) => (
            <div
              key={index}
              className="dv-mark"
              style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
            />
          ))}
        </div>
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
