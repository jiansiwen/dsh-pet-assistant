import { useCallback, useEffect, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'
import { init as initPptx } from 'pptx-preview'
import type { OfficeSession } from '../main/office-view-window.ts'
import type { OfficeViewApi } from '../preload/office-view.ts'

declare global {
  interface Window { readonly officeView: OfficeViewApi }
}
const api = window.officeView

interface PptxViewer {
  preview(file: ArrayBuffer): Promise<unknown>
  readonly slideCount: number
  readonly currentIndex: number
  renderSingleSlide(index: number): void
  renderPreSlide(): void
  renderNextSlide(): void
  destroy(): void
}

export default function OfficeViewer() {
  const [session, setSession] = useState<OfficeSession | null>(null)
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const stageRef = useRef<HTMLDivElement | null>(null)
  const docxPages = useRef<HTMLElement[]>([])
  const docxSectionPages = useRef<number[]>([])
  const pptx = useRef<PptxViewer | null>(null)
  const imageUrls = useRef<string[]>([])
  const sessionRef = useRef<OfficeSession | null>(null)
  const pageRef = useRef(1)
  const loadSeq = useRef(0)

  const clearViewer = useCallback(() => {
    const stage = stageRef.current
    if (stage) stage.replaceChildren()
    for (const current of docxPages.current) current.style.display = ''
    docxPages.current = []
    docxSectionPages.current = []
    try { pptx.current?.destroy() } catch { /* 已销毁 */ }
    pptx.current = null
    for (const url of imageUrls.current) URL.revokeObjectURL(url)
    imageUrls.current = []
    setImageUrl('')
    setPageCount(null)
  }, [])

  const fitPptx = useCallback(() => {
    const stage = stageRef.current
    const wrapper = stage?.querySelector<HTMLElement>('.pptx-preview-wrapper')
    if (!stage || !wrapper) return
    const width = wrapper.offsetWidth || 960
    const height = wrapper.offsetHeight || 540
    const scale = Math.max(0.2, Math.min((stage.clientWidth - 48) / width, (stage.clientHeight - 48) / height, 1.6))
    wrapper.style.zoom = String(scale)
  }, [])

  const showDocxPage = useCallback(async (number: number, verify: boolean) => {
    const pages = docxPages.current
    if (pages.length === 0) return
    const current = pages[Math.min(Math.max(number, 1), pages.length) - 1]
    if (!current) return
    if (verify && sessionRef.current) {
      const checked = await api.check(sessionRef.current.token, sessionRef.current.fingerprint).catch(() => ({ ok: false as const, error: '授权检查失败' }))
      if (!checked.ok) { setError(checked.error); return }
    }
    const stage = stageRef.current
    if (!stage) return
    for (const item of pages) { item.style.display = 'none'; item.style.zoom = '1' }
    current.style.display = 'block'
    const rect = current.getBoundingClientRect()
    const scale = Math.max(0.2, Math.min((stage.clientWidth - 48) / Math.max(rect.width, 1),
      (stage.clientHeight - 48) / Math.max(rect.height, 1), 1.6))
    current.style.zoom = String(scale)
    setPage(pages.indexOf(current) + 1)
    pageRef.current = pages.indexOf(current) + 1
  }, [])

  const showPptxPage = useCallback(async (number: number, verify: boolean) => {
    const viewer = pptx.current
    if (!viewer) return
    const count = viewer.slideCount || 1
    const target = Math.min(Math.max(number, 1), count)
    if (verify && sessionRef.current) {
      const checked = await api.check(sessionRef.current.token, sessionRef.current.fingerprint).catch(() => ({ ok: false as const, error: '授权检查失败' }))
      if (!checked.ok) { setError(checked.error); return }
    }
    viewer.renderSingleSlide(target - 1)
    setPage(target)
    pageRef.current = target
    fitPptx()
  }, [fitPptx])

  const showImagePage = useCallback(async (number: number, verify: boolean) => {
    const urls = imageUrls.current
    if (urls.length === 0) return
    const target = Math.min(Math.max(number, 1), urls.length)
    if (verify && sessionRef.current) {
      const checked = await api.check(sessionRef.current.token, sessionRef.current.fingerprint).catch(() => ({ ok: false as const, error: '授权检查失败' }))
      if (!checked.ok) { setError(checked.error); return }
    }
    setImageUrl(urls[target - 1]!)
    setPage(target)
    pageRef.current = target
  }, [])

  const gotoPage = useCallback(async (number: number, verify = true) => {
    const current = sessionRef.current
    if (current?.format === 'pptx' && current.mode === 'images') await showImagePage(number, verify)
    else if (current?.format === 'pptx') await showPptxPage(number, verify)
    else await showDocxPage(number, verify)
  }, [showDocxPage, showImagePage, showPptxPage])

  /** 讲解链传段落号：PPTX 直接对幻灯片，DOCX 用页内文字匹配；匹配不到就按段号近似。 */
  const gotoSection = useCallback(async (sectionIndex: number, pageNumber: number | null) => {
    const current = sessionRef.current
    if (!current) return
    const count = pageCount ?? current.pageCount ?? 1
    const page = current.format === 'pptx'
      ? (pageNumber ?? sectionIndex + 1)
      : (docxSectionPages.current[sectionIndex] ?? Math.min(sectionIndex + 1, count))
    await gotoPage(page, true)
  }, [gotoPage, pageCount])

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoading(true); setError('')
    try {
      const current = await api.session()
      if (seq !== loadSeq.current) return
      if (!current) { setError('阅读会话已失效，请从文档面板重新打开'); return }
      sessionRef.current = current
      setSession(current)
      clearViewer()
      if (current.format === 'pptx' && current.mode === 'images') {
        const count = current.pageCount ?? 0
        if (count < 1) throw new Error('PowerPoint 没有导出任何幻灯片')
        const urls: string[] = []
        for (let index = 0; index < count; index++) {
          const data = await api.image(current.token, current.fingerprint, index)
          if (seq !== loadSeq.current) { urls.forEach(url => URL.revokeObjectURL(url)); return }
          urls.push(URL.createObjectURL(new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], { type: 'image/png' })))
        }
        imageUrls.current = urls
        setPageCount(count)
        const initial = current.initialSection
        const initialPage = Math.min(Math.max(initial ? (initial.pageNumber ?? initial.index + 1) : 1, 1), count)
        setPage(initialPage); pageRef.current = initialPage
        setImageUrl(urls[initialPage - 1]!)
        return
      }
      const bytes = await api.bytes(current.token, current.fingerprint)
      if (seq !== loadSeq.current) return
      const stage = stageRef.current
      if (!stage) return
      if (current.format === 'docx') {
        await renderAsync(bytes, stage, undefined, { breakPages: true, ignoreLastRenderedPageBreak: false,
          inWrapper: true, useBase64URL: true, renderHeaders: true, renderFooters: true, experimental: true } as never)
        if (seq !== loadSeq.current) return
        docxPages.current = [...stage.querySelectorAll<HTMLElement>('section.docx')]
        if (docxPages.current.length === 0) {
          // 少数文档没有显式分页；至少把它当作一页显示出来，不假装有更多页。
          docxPages.current = [stage]
        }
        const normalize = (value: string): string => value.replace(/\s+/gu, '')
        const pageTexts = docxPages.current.map(item => normalize(item.textContent ?? ''))
        docxSectionPages.current = (current.sections ?? []).map(section => {
          const snippet = normalize(section.heading ?? section.text.slice(0, 80)).slice(0, 80)
          const found = snippet ? pageTexts.findIndex(text => text.includes(snippet)) : -1
          return found >= 0 ? found + 1 : Math.min(section.index + 1, docxPages.current.length)
        })
        setPageCount(docxPages.current.length)
        const initial = current.initialSection
        const initialPage = Math.min(Math.max(initial ? (docxSectionPages.current[initial.index] ?? initial.index + 1) : 1, 1), docxPages.current.length)
        await showDocxPage(initialPage, false)
      } else if (current.format === 'pptx') {
        const viewer = initPptx(stage, { width: 960, height: 540, mode: 'slide' }) as unknown as PptxViewer
        pptx.current = viewer
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        await viewer.preview(buffer)
        if (seq !== loadSeq.current) return
        const count = viewer.slideCount
        setPageCount(count)
        const initial = current.initialSection
        const initialPage = Math.min(Math.max(initial ? (initial.pageNumber ?? initial.index + 1) : 1, 1), Math.max(count, 1))
        viewer.renderSingleSlide(initialPage - 1)
        setPage(initialPage); pageRef.current = initialPage
        requestAnimationFrame(fitPptx)
      } else setError('这种格式不支持逐页阅读')
    } catch (cause) {
      if (seq === loadSeq.current) setError(cause instanceof Error ? cause.message : '文档渲染失败')
    } finally { if (seq === loadSeq.current) setLoading(false) }
  }, [clearViewer, fitPptx, showDocxPage])

  useEffect(() => {
    void load()
    api.onSessionChanged(() => { void load() })
    api.onFullscreen(on => {
      setFullscreen(on)
      requestAnimationFrame(() => { fitPptx(); if (sessionRef.current?.format === 'docx') void showDocxPage(pageRef.current, false) })
    })
    const onResize = (): void => { fitPptx(); if (sessionRef.current?.format === 'docx') void showDocxPage(pageRef.current, false) }
    window.addEventListener('resize', onResize)
    return () => {
      loadSeq.current++
      window.removeEventListener('resize', onResize)
      clearViewer()
    }
  }, [clearViewer, fitPptx, load, showDocxPage])

  useEffect(() => api.onCommand(command => {
    if (command.type === 'goto') void gotoPage(command.page)
    else if (command.type === 'goto-section') void gotoSection(command.sectionIndex, command.pageNumber)
  }), [gotoPage, gotoSection])

  const next = useCallback(() => { void gotoPage(pageRef.current + 1) }, [gotoPage])
  const prev = useCallback(() => { void gotoPage(pageRef.current - 1) }, [gotoPage])
  const toggleFullscreen = useCallback(async () => {
    try { await api.setFullscreen(!fullscreen) } catch { /* 窗口不允许全屏，保持原样 */ }
  }, [fullscreen])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') { event.preventDefault(); next() }
      else if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); prev() }
      else if (event.key.toLowerCase() === 'f') void toggleFullscreen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev, toggleFullscreen])

  const close = (): void => { void api.close() }
  const pageLabel = pageCount === null ? '正在排版…' : `第 ${page} / ${pageCount} ${session?.format === 'pptx' ? '张' : '页'}`

  return <main className="office-shell">
    <header className="office-toolbar">
      <strong className="office-title" title={session?.name}>{session?.name ?? '逐页阅读'}</strong>
      <span className="office-page" role="status">{pageLabel}</span>
      <button type="button" className="office-btn" onClick={prev} disabled={loading || page <= 1}>上一页</button>
      <button type="button" className="office-btn" onClick={next} disabled={loading || pageCount === null || page >= pageCount}>下一页</button>
      <button type="button" className="office-btn" onClick={() => void toggleFullscreen()}>{fullscreen ? '退出全屏' : '全屏演示'}</button>
      <button type="button" className="office-btn ghost" onClick={close}>关闭</button>
    </header>
    {loading && <div className="office-state" role="status">正在渲染文档…</div>}
    {error && <div className="office-state office-error" role="alert">{error}<button type="button" className="office-btn" onClick={close}>关闭</button></div>}
    <div className={`office-stage${fullscreen ? ' is-fullscreen' : ''}`} ref={stageRef} aria-label="文档页面">
      {imageUrl && <img className="office-image" src={imageUrl} alt="" draggable={false} />}
    </div>
  </main>
}
