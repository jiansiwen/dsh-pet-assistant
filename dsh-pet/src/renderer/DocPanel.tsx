/**
 * 文档页：授权范围、重名待挑、提纲与讲解进度（design.md §2.10）。
 *
 * 与对话页分开是因为这一页回答的是"我允许它读哪儿、现在讲到第几段"，对话页回答的是
 * "我刚才那句话有没有人接"。讲解出来的正文仍然铺在对话页 —— 那是用户读长文的地方，
 * 这里再开一个滚动区就等于同一段话有两个家，两边还会各自滚到不同的位置。
 *
 * **这一页扩大不了自己的权限。**「添加目录」只是请主进程弹一个原生目录选择框，挑哪个
 * 目录由用户在系统对话框里点，界面上没有任何一条通道能把一个路径字符串塞进授权列表
 * （§2.11：不能伪造 UI 批准）。撤销可以直接传路径 —— 那是把权限交回去，方向是安全的。
 */
import { useCallback, useEffect, useState } from 'react'
import { OFFICE_EXTENSIONS, OUTLINE_EXTENSIONS } from '../main/doc-formats.js'
import { formatDate, formatSize, progressLabel, sectionLabel, shortenDir } from './doc-panel.js'
import type { DocRoots, DocState } from './types.js'
import './doc.css'

/** 主进程投影会带 PDF 物理页码；types.d.ts 的简报类型尚未含该字段时按可选读取。 */
type SectionWithPage = { pageNumber?: number }

interface DocPanelProps {
  readonly state: DocState
  readonly roots: DocRoots
  /** 一次文档操作正在进行（解析、请模型讲一段）。期间按钮一律按住：连点会排出两条讲解链。 */
  readonly busy: boolean
  /** 正在出声。停止按钮只在有声可停的时候才有意义。 */
  readonly speaking: boolean
  readonly onOpen: (path: string) => void
  readonly onRead: (path: string) => void
  readonly onExplain: (path: string, from: number) => void
  readonly onAsk: (index: number, question: string) => void
  readonly onStop: () => void
  readonly onAddRoot: () => void
  readonly onRemoveRoot: (path: string) => void
  readonly onForgetDir: (path: string) => void
}

export default function DocPanel({
  state,
  roots,
  busy,
  speaking,
  onOpen,
  onRead,
  onExplain,
  onAsk,
  onStop,
  onAddRoot,
  onRemoveRoot,
  onForgetDir,
}: DocPanelProps) {
  const outline = state.kind === 'outline' ? state : null
  const [selected, setSelected] = useState(0)
  const [question, setQuestion] = useState('')

  const docPath = outline?.path ?? null
  useEffect(() => {
    // 只在换了一份文档时把选中段落拉回当前进度。讲解推进时 next 一直在动，跟着动会把
    // 用户刚点选的那一段顶掉。
    setSelected(outline === null ? 0 : Math.max(0, Math.min(outline.next, outline.total - 1)))
    setQuestion('')
  }, [docPath])

  const ask = useCallback(() => {
    const text = question.trim()
    if (text === '' || outline === null || busy) return
    onAsk(selected, text)
    setQuestion('')
  }, [busy, onAsk, outline, question, selected])

  return (
    <div className="doc-page" id="panel-page-doc" role="tabpanel" aria-labelledby="panel-tab-doc">
      {state.kind === 'choose' && (
        <section className="doc-section">
          <h3 className="doc-section-title">
            名字撞车了<span className="doc-count">{state.hits.length}</span>
          </h3>
          {/* 说清楚为什么不自己挑：不然用户会觉得这是多余的一步。 */}
          <p className="doc-hint">「{state.name}」对上好几份，我不会替你选第一份就打开。</p>
          <ul className="doc-list">
            {state.hits.map((hit) => (
              <li key={hit.path} className="doc-card">
                <div className="doc-card-main">
                  <span className="doc-name">{hit.name}</span>
                  <span className="doc-path" title={hit.path}>
                    {shortenDir(hit.path, 46)}
                  </span>
                </div>
                <div className="doc-card-side">
                  <span className="doc-meta">
                    {formatSize(hit.size)} · {formatDate(hit.mtimeMs)}
                  </span>
                  <span className="doc-card-actions">
                    <button type="button" className="doc-btn" disabled={busy} onClick={() => onOpen(hit.path)}>
                      打开
                    </button>
                    {OFFICE_EXTENSIONS.some(extension => hit.path.toLowerCase().endsWith(extension)) && (
                      <button type="button" className="doc-btn" disabled={busy} onClick={() => onRead(hit.path)}>逐页阅读</button>
                    )}
                    <button
                      type="button"
                      className="doc-btn primary"
                      disabled={busy}
                      onClick={() => onExplain(hit.path, 0)}
                    >
                      讲解
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {outline !== null && (
        <section className="doc-section">
          <h3 className="doc-section-title">
            <span className="doc-title" title={outline.path}>
              {outline.title}
            </span>
            {speaking && <span className="doc-live">正在讲</span>}
          </h3>
          <p className="doc-hint" role="status">
            {progressLabel(outline.next, outline.total, outline.estMinutes)}
          </p>

          {/*
            提纲是目录，不是正文：一行只有标题和状态，正文在对话页里。
            点一行只是选中它，不会立刻出声 —— 出声要花一次模型调用，误点一下就开口太贵。
          */}
          <ul className="doc-list doc-outline">
            {outline.sections.map((section) => (
              <li key={section.index}>
                <button
                  type="button"
                  className={`doc-row${selected === section.index ? ' selected' : ''}`}
                  aria-pressed={selected === section.index}
                  disabled={busy}
                  onClick={() => setSelected(section.index)}
                >
                  <span className="doc-row-index">{section.index + 1}</span>
                  <span className="doc-row-label">
                    {(section as SectionWithPage).pageNumber !== undefined && (
                      <span className="doc-tag">第 {(section as SectionWithPage).pageNumber} 页</span>
                    )}
                    {sectionLabel(section.heading, section.index)}
                  </span>
                  {/* 状态用文字而不是只用颜色：已讲/含代码都是要读出来的信息。 */}
                  {section.hasCode && <span className="doc-tag">含代码</span>}
                  {section.spoken && <span className="doc-tag done">已讲</span>}
                </button>
              </li>
            ))}
          </ul>

          <div className="doc-actions">
            <button
              type="button"
              className="doc-btn primary"
              disabled={busy}
              onClick={() => onExplain(outline.path, selected)}
            >
              从第 {selected + 1} 段开始讲
            </button>
            <button type="button" className="doc-btn" disabled={busy} onClick={() => onOpen(outline.path)}>
              用系统关联打开
            </button>
            {OFFICE_EXTENSIONS.some(extension => outline.path.toLowerCase().endsWith(extension)) && (
              <button type="button" className="doc-btn" disabled={busy} onClick={() => onRead(outline.path)}>逐页阅读 / 演示</button>
            )}
            {/* 没在出声的时候不摆一个按了也没反应的停止键。 */}
            {speaking && (
              <button type="button" className="doc-btn danger" onClick={onStop}>
                停止讲解
              </button>
            )}
          </div>

          <div className="doc-ask">
            <label className="doc-ask-label" htmlFor="doc-ask-input">
              就第 {selected + 1} 段问一句
            </label>
            <div className="doc-ask-row">
              <input
                id="doc-ask-input"
                className="doc-ask-input"
                type="text"
                value={question}
                placeholder="这一段说的是什么意思？"
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    ask()
                  }
                }}
              />
              <button type="button" className="doc-btn" disabled={busy || question.trim() === ''} onClick={ask}>
                问
              </button>
            </div>
            <p className="doc-ask-hint">回答会带上这一段的原文，答案显示在上方最近结果中。</p>
          </div>
        </section>
      )}

      <section className="doc-section">
        <h3 className="doc-section-title">
          允许查找的目录<span className="doc-count">{roots.roots.length + roots.recent.length}</span>
        </h3>
        {roots.roots.length === 0 && roots.recent.length === 0 ? (
          /* 不给一个空列表：空白分不清"没授权"和"没读到设置"，而前者只需要点一下按钮。 */
          <p className="doc-hint">
            还没有授权目录，说文件名我也找不到。加一个目录，我才会在那儿找文档。
          </p>
        ) : (
          <>
            <ul className="doc-list">
              {roots.roots.map((dir) => (
                <li key={dir} className="doc-dir">
                  <span className="doc-dir-name" title={dir}>
                    {shortenDir(dir)}
                  </span>
                  <span className="doc-tag">你加的</span>
                  <button type="button" className="doc-btn small" onClick={() => onRemoveRoot(dir)}>
                    撤销
                  </button>
                </li>
              ))}
              {roots.recent.map((dir) => (
                <li key={dir} className="doc-dir">
                  <span className="doc-dir-name" title={dir}>
                    {shortenDir(dir)}
                  </span>
                  <span className="doc-tag quiet">打开文档时记下</span>
                  <button type="button" className="doc-btn small" onClick={() => onForgetDir(dir)}>
                    撤销
                  </button>
                </li>
              ))}
            </ul>
            <p className="doc-hint">
              我只在这些目录里按名字找文档，不会全盘搜；目录外的路径一律拒绝。
            </p>
          </>
        )}
        <div className="doc-actions">
          <button type="button" className="doc-btn" onClick={onAddRoot}>
            添加目录…
          </button>
        </div>
      </section>

      <section className="doc-section">
        <h3 className="doc-section-title">讲得了什么</h3>
        {/*
          先把能做的范围说在前面。用户拿一份 PDF 来说"讲讲"，得到一句"读不出结构"会觉得
          东西坏了；提前写明只有 Markdown 和纯文本能讲，他就知道该换一份还是该等着。
        */}
        <p className="doc-hint">
          能逐段讲解：Markdown、纯文本、可提取文字的 PDF、Word .docx、PowerPoint .pptx（{OUTLINE_EXTENSIONS.join(' ')}）。
          docx/pptx 可以逐页阅读，pptx 还支持全屏演示；PPTX 会优先用本机 PowerPoint 只读导出每页画面。
          讲解时会自动翻到对应页/幻灯片；追问打断后页面保留，继续讲解会重新对齐。
          <br />
          只能用系统关联打开、讲不了：旧版 .doc / .ppt、Excel、图片；带宏的文档（.docm .xlsm .pptm）和可执行文件一律不开。
        </p>
      </section>
    </div>
  )
}
