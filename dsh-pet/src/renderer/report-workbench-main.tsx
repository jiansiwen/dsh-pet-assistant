/**
 * 日报工作台页面（M3-04 / M3-05）。
 *
 * 这一页能做的事被刻意收窄：
 * - 只读插件给的视图：版本、条目、工作事项与证据、资料、历史与删除回执——事实由插件算，页面不自己推断；
 * - 改写、删除、补充一条都提交给插件，各自产生一个新版本；先预览，再保存；
 * - "请求发布第 N 版"把正在看的修订号、摘要、保存路径原样交出去，结果只是打开专用审批窗口；
 * - 删除按类别逐项查看影响（将删除 / 将失效 / 仍保留 / 无法控制）后再请求确认，没有"全部清空"。
 * 页面里没有任何批准按钮。所有文字按纯文本渲染（React 默认转义），模型写的内容不会被当成标记执行。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReportWorkbenchApi, WorkbenchReply } from '../preload/report-workbench.js'
import './report-workbench.css'

declare global {
  interface Window {
    readonly reportWorkbench: ReportWorkbenchApi
  }
}

const api = window.reportWorkbench

interface Line { index: number; kind: 'heading' | 'entry' | 'text' | 'blank'; text: string; section: string | null; pending: boolean; ordinal: number | null; workItemIds: string[] }
interface Source { kind: string; ref: string; label: string; detail: string; evidenceLabel: string; available: boolean; object?: string | null }
interface Item {
  id: string; time: string; project: string | null; action: string; outcome: string; summary: string; discussionTopic: string | null
  status: string; statusLabel: string; sources: Source[]; inclusion: { state: string; reason: string; lines: number[] }
}
interface Material {
  id: string; kind: string; kindLabel: string; origin: string; sourceLabel: string; object: string | null; coverage: string
  digest: string | null; lines: number; modelVisible: boolean; legacy: boolean; preview: string; usedBy: Array<{ id: string; status: string }>; createdAt: number
}
interface Impact {
  category: string; label: string; scope: Record<string, unknown>; willDelete: string[]; willInvalidate: string[]
  retained: string[]; uncontrolled: string[]; blocked: string | null; needsTrustedApproval: boolean; digest: string
}
interface Receipt { id: string; category: string; createdAt: number; receipt: { label: string; deleted: string[]; invalidated: string[]; retained: string[]; uncontrolled: string[]; failures: string[] } }
interface View {
  date: string; reportId: string; targetPath: string; rules: string
  capture: { active: boolean; capturing: boolean } | null
  current: { revision: number; digest: string; state: string; content: string; createdAt: number; revokedReason: string | null; change: string | null } | null
  lines: Line[]; stats: { entries: number; pendingEntries: number }
  workItems: Item[]; evidenceRemoved: { count: number }
  materials: Material[]
  memories: { items: Array<{ id: string; kind: string; scope: string; topic: string; text: string; status: string }>; hiddenProjectMemories: number }
  history: Array<{ revision: number; state: string; createdAt: number; digest: string; revokedReason: string | null; change: string | null; targetPath: string | null }>
  pendingApproval: { proposalId: string; revision: number; expiresAt: number; target: string } | null
  lastPublish: { revision: number; at: number | null; ok?: boolean; confirmed?: boolean; savedPath?: string; modeExited?: boolean; message?: string; error?: string } | null
  exports: Array<{ revision: number; path: string; exists: boolean; matchesRevision: boolean; deletedAt: number | null }>
  receipts: Receipt[]
}

const STATE_LABEL: Record<string, string> = {
  draft: '草稿', pending_confirmation: '待批', approved: '已批准', publishing: '发布中', archived: '已发布', revoked: '已撤销',
}
const ORIGIN_LABEL: Record<string, string> = { conversation: '会话里粘贴', desktop_selection: '桌面导入', authorized_project: '授权项目' }
const INCLUSION_LABEL: Record<string, string> = { included: '已纳入', warning: '需标注', excluded: '未纳入', not_linked: '未关联' }

function time(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function countdown(ms: number): string {
  if (ms <= 0) return '已过期'
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

type Tab = 'draft' | 'items' | 'materials' | 'history'
type Notice = { tone: 'info' | 'ok' | 'warn' | 'error'; text: string } | null

interface DeletionDraft { category: string; title: string; params: Record<string, unknown>; reason: string; impact: Impact | null; busy: boolean; result: string | null }

function ImpactList({ title, tone, items }: { title: string; tone: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <section className={`impact impact-${tone}`}>
      <h4>{title}</h4>
      <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </section>
  )
}

function App() {
  const [view, setView] = useState<View | null>(null)
  const [date, setDate] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('draft')
  const [notice, setNotice] = useState<Notice>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [editing, setEditing] = useState<{ line: number; text: string; preview: string | null } | null>(null)
  const [adding, setAdding] = useState<{ afterLine: number; text: string; preview: string | null } | null>(null)
  const [deletion, setDeletion] = useState<DeletionDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [importMeta, setImportMeta] = useState({ kind: 'chat_excerpt', objectLabel: '', from: '', to: '' })
  const [range, setRange] = useState({ from: '', to: '', reason: '' })
  /** 正在改写的那条记忆：id → 编辑中的正文与分类。null 表示没有在改。 */
  const [memoryEdit, setMemoryEdit] = useState<{ id: string; text: string; topic: string; original: string } | null>(null)
  const knownReceipt = useRef<string | null>(null)

  const load = useCallback(async (wanted?: string | null) => {
    const reply = await api.load(wanted ?? undefined)
    if (!reply.ok || !reply.data) {
      setLoadError(reply.error ?? '读取工作台失败')
      return
    }
    setLoadError(null)
    const next = reply.data as unknown as View
    // 刚收到的删除回执里有失败项：显著提示（例如导出文件被占用没删掉）。
    const latest = next.receipts[0]
    if (latest && knownReceipt.current !== null && latest.id !== knownReceipt.current && latest.receipt.failures.length > 0) {
      setNotice({ tone: 'error', text: `${latest.receipt.label}没有全部完成：${latest.receipt.failures.join('；')}` })
    } else if (latest && knownReceipt.current !== null && latest.id !== knownReceipt.current) {
      setNotice({ tone: 'ok', text: `${latest.receipt.label}已完成，回执见"历史与删除"` })
    }
    knownReceipt.current = latest?.id ?? ''
    setView(next)
    setDate(next.date)
  }, [])

  useEffect(() => {
    void load(null)
    api.onChanged(() => { void load(null) })
    const onFocus = () => { void load(null) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  // 有待批（发布或删除）时轮询：审批窗口那边的结果要尽快在这里如实显示。
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  useEffect(() => {
    if (!waiting && !view?.pendingApproval) return
    const id = window.setInterval(() => { void load(date) }, 2500)
    const stop = window.setTimeout(() => setWaiting(false), 180_000)
    return () => { window.clearInterval(id); window.clearTimeout(stop) }
  }, [waiting, view?.pendingApproval, load, date])

  const reply = useCallback(async (promise: Promise<WorkbenchReply>, success?: string): Promise<WorkbenchReply> => {
    setBusy(true)
    try {
      const result = await promise
      if (!result.ok) {
        const stale = result.code === 'stale_base' || result.code === 'stale_revision' || result.code === 'text_mismatch' || result.code === 'preview_stale'
        setNotice({ tone: result.code === 'unbound' ? 'warn' : 'error', text: `${result.error ?? '操作没有完成'}${stale ? '（已刷新为最新内容，请重新核对）' : ''}` })
        if (stale) await load(date)
      } else if (success) {
        setNotice({ tone: 'ok', text: success })
      }
      return result
    } finally {
      setBusy(false)
    }
  }, [load, date])

  const current = view?.current ?? null
  const base = useMemo(() => ({ date: view?.date ?? '', baseRevision: current?.revision ?? 0, baseDigest: current?.digest ?? '' }), [view?.date, current?.revision, current?.digest])
  const editable = !!view && (!current || (current.state !== 'revoked' && current.state !== 'publishing'))

  const saveEdit = async (op: Parameters<ReportWorkbenchApi['edit']>[0]['op'], dryRun: boolean, workItemId?: string) => {
    const result = await reply(api.edit({ ...base, op, dryRun, ...(workItemId ? { workItemId } : {}) }), dryRun ? undefined : '已保存为新版本')
    if (result.ok && !dryRun) {
      setEditing(null)
      setAdding(null)
      await load(view?.date)
    }
    return result
  }

  const requestPublish = async () => {
    if (!view || !current) return
    // 修订号、摘要、保存路径原样交给主进程；主进程只会打开专用审批窗口。
    const result = await reply(api.requestPublish({ date: view.date, revision: current.revision, digest: current.digest, targetPath: view.targetPath }))
    if (!result.ok) return
    setWaiting(true)
    setNotice(result.approvalWindow?.ok === false
      ? { tone: 'warn', text: `待批已提交，但审批窗口没能打开：${result.approvalWindow.error ?? '未知原因'}；可以从宠物的待办里打开` }
      : { tone: 'info', text: `已为第 ${current.revision} 版打开专用审批窗口：请在那里核对全文、版本与保存位置后批准。这里不会自己发布。` })
    await load(view.date)
  }

  const openDeletion = (category: string, title: string, params: Record<string, unknown>) => {
    setDeletion({ category, title, params, reason: '', impact: null, busy: false, result: null })
  }

  const previewDeletion = async () => {
    if (!deletion) return
    setDeletion({ ...deletion, busy: true })
    const params = { ...deletion.params, ...(deletion.reason.trim() ? { reason: deletion.reason.trim() } : {}) }
    const result = await api.deletionPreview({ category: deletion.category, params })
    setDeletion(prev => prev && { ...prev, busy: false, impact: result.ok ? result.data?.impact as Impact : null, result: result.ok ? null : result.error ?? '查看影响失败' })
  }

  const confirmDeletion = async () => {
    if (!deletion?.impact) return
    const params = { ...deletion.params, ...(deletion.reason.trim() ? { reason: deletion.reason.trim() } : {}) }
    setDeletion({ ...deletion, busy: true })
    const result = await api.requestDeletion({ category: deletion.category, params, previewDigest: deletion.impact.digest })
    if (!result.ok) {
      const impact = (result.data?.impact as Impact | undefined) ?? null
      setDeletion(prev => prev && { ...prev, busy: false, impact: impact ?? prev.impact, result: result.error ?? '请求没有完成' })
      return
    }
    if (result.data?.kind === 'approval') {
      setWaiting(true)
      setNotice(result.approvalWindow?.ok === false
        ? { tone: 'warn', text: `删除待批已提交，但审批窗口没能打开：${result.approvalWindow.error ?? '未知原因'}` }
        : { tone: 'info', text: `已打开专用审批窗口：请在那里核对"${deletion.title}"的影响范围后确认；确认前什么都没有删除。` })
    } else {
      setNotice({ tone: 'ok', text: String(result.data?.message ?? '已完成') })
    }
    setDeletion(null)
    await load(view?.date)
  }

  const importFile = async () => {
    const toMs = (value: string) => (value ? new Date(value).getTime() : undefined)
    const result = await reply(api.importMaterial({
      kind: importMeta.kind as 'chat_excerpt' | 'import_text' | 'note',
      ...(importMeta.objectLabel.trim() ? { objectLabel: importMeta.objectLabel.trim() } : {}),
      ...(importMeta.from ? { coveredFrom: toMs(importMeta.from) } : {}),
      ...(importMeta.to ? { coveredTo: toMs(importMeta.to) } : {}),
      ...(view ? { date: view.date } : {}),
    }))
    if (result.ok) {
      setNotice({ tone: result.data?.duplicate ? 'warn' : 'ok', text: String(result.data?.message ?? '已导入') })
      await load(view?.date)
    }
  }

  const requestShare = async (material: Material) => {
    const result = await reply(api.requestShare(material.id))
    if (result.ok) {
      setWaiting(true)
      setNotice({ tone: 'info', text: '已打开专用审批窗口：请在那里核对将发送给模型的全文后决定；批准前正文不会发送。' })
    }
  }

  /**
   * 改写一条长期记忆。
   *
   * 页面只说"这一条改成什么"：编号、新旧正文都由插件从库里读出来核对。
   * 手动模式下结果是"已提交待批"，此时什么都没改——提示语必须照实说，不能让人以为已生效。
   */
  const saveMemoryEdit = async () => {
    if (!memoryEdit) return
    const text = memoryEdit.text.trim()
    if (!text) { setNotice({ tone: 'warn', text: '改写后的内容不能为空；要撤销这条记忆请用"删除…"' }); return }
    const result = await reply(api.editMemory({
      memoryId: memoryEdit.id, text,
      ...(memoryEdit.topic.trim() ? { topic: memoryEdit.topic.trim() } : {}),
    }))
    if (!result.ok) return
    setMemoryEdit(null)
    setWaiting(result.data?.pending === true)
    setNotice(result.data?.mode === 'auto'
      ? { tone: 'ok', text: String(result.data?.message ?? '已直接改写') }
      : result.approvalWindow?.ok === false
        ? { tone: 'warn', text: `改写待批已提交，但审批窗口没能打开：${result.approvalWindow.error ?? '未知原因'}；可以从宠物的待办里打开` }
        : { tone: 'info', text: '已提交可信审批：请在那里核对新旧全文后批准；批准前这条记忆没有改动。' })
    await load(view?.date)
  }

  if (!view) {
    return <div className="wb-empty">{loadError ? `读不到工作台：${loadError}` : '正在读取日报工作台…'}</div>
  }

  const entries = view.lines.filter(line => line.kind === 'entry')
  const itemById = new Map(view.workItems.map(item => [item.id, item]))
  const pendingLeft = view.pendingApproval ? view.pendingApproval.expiresAt - now : null

  return (
    <div className="wb">
      <header className="wb-head">
        <div className="wb-title">
          <h1>日报工作台</h1>
          <input aria-label="日期" type="date" value={date ?? view.date} onChange={event => { if (event.target.value) void load(event.target.value) }} />
          <button className="wb-btn quiet" onClick={() => void load(view.date)} disabled={busy}>刷新</button>
        </div>
        <div className="wb-meta" aria-label="版本信息">
          {current
            ? <>
                <span className={`chip state-${current.state}`}>第 {current.revision} 版 · {STATE_LABEL[current.state] ?? current.state}</span>
                <span className="chip mono" title={current.digest}>摘要 {current.digest.slice(0, 12)}</span>
              </>
            : <span className="chip">还没有草稿</span>}
          <span className="chip mono" title={view.targetPath}>保存到 {view.targetPath}</span>
          {view.capture && <span className={`chip ${view.capture.active ? 'live' : ''}`}>{view.capture.active ? '活动记录：开启' : '活动记录：已停止'}</span>}
        </div>
      </header>

      {loadError && <p className="wb-notice tone-error" role="alert">刷新失败：{loadError}</p>}
      {notice && <p className={`wb-notice tone-${notice.tone}`} role="status">{notice.text}<button className="wb-x" aria-label="关闭提示" onClick={() => setNotice(null)}>×</button></p>}
      {view.pendingApproval && (
        <p className="wb-notice tone-warn">
          第 {view.pendingApproval.revision} 版正在专用审批窗口等你批准（剩余 {countdown(pendingLeft ?? 0)}）。改动草稿会让这条待批作废。
        </p>
      )}
      {view.lastPublish && (
        <p className={`wb-notice ${view.lastPublish.confirmed ? 'tone-ok' : 'tone-error'}`}>
          {view.lastPublish.confirmed
            ? `第 ${view.lastPublish.revision} 版已保存到 ${view.lastPublish.savedPath}（${time(view.lastPublish.at)}）。${view.lastPublish.message ?? ''}`
            : `第 ${view.lastPublish.revision} 版发布没有完成（${time(view.lastPublish.at)}）：${view.lastPublish.error ?? '原因未知'}`}
        </p>
      )}

      <nav className="wb-tabs" role="tablist">
        {([['draft', `草稿（${view.stats.entries} 条）`], ['items', `工作事项（${view.workItems.length}）`], ['materials', `资料（${view.materials.length}）`], ['history', '历史与删除']] as Array<[Tab, string]>)
          .map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={`wb-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>
          ))}
      </nav>

      {tab === 'draft' && (
        <div className="wb-draft">
          <section className="wb-lines" aria-label="草稿条目">
            {current?.change && <p className="wb-hint">这一版：{current.change}</p>}
            {current?.state === 'revoked' && <p className="wb-notice tone-warn">这一版已撤销（{current.revokedReason ?? '无原因'}），不能在它上面修改；请让助理重新生成草稿。</p>}
            {view.lines.filter(line => line.kind !== 'blank').map(line => {
              if (line.kind === 'heading') return <h3 key={line.index} className="wb-section">{line.text}</h3>
              if (line.kind === 'text') return <p key={line.index} className="wb-text">{line.text}</p>
              const isEditing = editing?.line === line.index
              return (
                <div key={line.index} className={`wb-entry ${line.pending ? 'pending' : ''}`}>
                  <div className="wb-entry-main">
                    <span className="wb-ordinal">{line.ordinal}</span>
                    {isEditing
                      ? <textarea aria-label="改写这一条" value={editing.text} onChange={event => setEditing({ ...editing, text: event.target.value, preview: null })} rows={2} />
                      : <span className="wb-entry-text">{line.text}</span>}
                  </div>
                  {line.workItemIds.length > 0 && (
                    <div className="wb-links">依据：{line.workItemIds.map(id => <span key={id} className="chip small">{itemById.get(id)?.summary ?? id}</span>)}</div>
                  )}
                  {isEditing && editing.preview !== null && <p className="wb-preview-line">保存后这一条将是：<b>{editing.preview}</b></p>}
                  <div className="wb-actions">
                    {isEditing ? (
                      <>
                        <button className="wb-btn" disabled={busy} onClick={async () => {
                          const result = await saveEdit({ type: 'rewrite', line: line.index, expectedText: line.text, text: editing.text }, true)
                          if (result.ok) setEditing(prev => prev && { ...prev, preview: String(result.data?.after ?? '') })
                        }}>预览</button>
                        <button className="wb-btn primary" disabled={busy || editing.preview === null} onClick={() => void saveEdit({ type: 'rewrite', line: line.index, expectedText: line.text, text: editing.text }, false)}>保存为新版本</button>
                        <button className="wb-btn quiet" onClick={() => setEditing(null)}>取消</button>
                      </>
                    ) : (
                      <>
                        <button className="wb-btn" disabled={!editable || busy} onClick={() => { setAdding(null); setEditing({ line: line.index, text: line.text, preview: null }) }}>改写</button>
                        <button className="wb-btn" disabled={!editable || busy || !current} onClick={() => current && openDeletion('draft_entry', `删除第 ${line.ordinal} 条`, { date: view.date, revision: current.revision, digest: current.digest, line: line.index, expectedText: line.text })}>删除…</button>
                        <button className="wb-btn quiet" disabled={!editable || busy} onClick={() => { setEditing(null); setAdding({ afterLine: line.index, text: '', preview: null }) }}>在下方补充</button>
                      </>
                    )}
                  </div>
                  {adding?.afterLine === line.index && <AddBox adding={adding} setAdding={setAdding} busy={busy} save={saveEdit} />}
                </div>
              )
            })}
            {entries.length === 0 && <p className="wb-hint">还没有条目。可以让助理"总结今天工作"，或在下面直接补充。</p>}
            {adding?.afterLine === -1
              ? <AddBox adding={adding} setAdding={setAdding} busy={busy} save={saveEdit} />
              : <button className="wb-btn quiet wb-add-end" disabled={!editable || busy} onClick={() => { setEditing(null); setAdding({ afterLine: -1, text: '', preview: null }) }}>＋ 在文末补充一条</button>}
            <p className="wb-rules">{view.rules}</p>
          </section>

          <aside className="wb-publish" aria-label="发布预览">
            <h2>将要写入文件的全文</h2>
            <p className="wb-hint">与批准后写入 <span className="mono">{view.targetPath}</span> 的内容逐字一致。</p>
            <pre className="wb-pre" aria-label="全文预览">{current?.content ?? '（还没有草稿）'}</pre>
            <button className="wb-btn primary wide" disabled={!current || busy || current.state === 'archived' || current.state === 'revoked' || current.state === 'publishing'}
              onClick={() => void requestPublish()}>
              {current ? `请求发布第 ${current.revision} 版` : '请求发布'}
            </button>
            <p className="wb-hint">只会打开专用审批窗口；批准、写文件与停止活动记录都在那边完成，结果会回到这里。</p>
          </aside>
        </div>
      )}

      {tab === 'items' && (
        <section className="wb-items" aria-label="工作事项">
          <p className="wb-rules">{view.rules}</p>
          {view.workItems.length === 0 && <p className="wb-hint">今天还没有登记工作事项。</p>}
          {view.workItems.map(item => (
            <article key={item.id} className={`wb-item status-${item.status}`}>
              <header>
                <span className={`chip status-${item.status}`}>{item.statusLabel}</span>
                <span className={`chip inclusion-${item.inclusion.state}`}>{INCLUSION_LABEL[item.inclusion.state] ?? item.inclusion.state}</span>
                <span className="wb-item-time">{item.time}</span>
              </header>
              <h3>{item.summary}</h3>
              <dl>
                {item.project && <><dt>项目</dt><dd className="mono">{item.project}</dd></>}
                {item.action && <><dt>动作</dt><dd>{item.action}</dd></>}
                <dt>成果</dt><dd>{item.outcome || '（没有可证实的成果）'}</dd>
                {item.discussionTopic && <><dt>讨论主题</dt><dd>{item.discussionTopic}</dd></>}
                <dt>纳入情况</dt><dd>{item.inclusion.reason}</dd>
              </dl>
              <ul className="wb-sources">
                {item.sources.map(source => (
                  <li key={`${source.kind}:${source.ref}`} className={source.available ? '' : 'gone'}>
                    <b>{source.label}</b> · {source.evidenceLabel}{source.object ? ` · 对象：${source.object}` : ''}
                    <span className="wb-source-detail">{source.detail}</span>
                  </li>
                ))}
              </ul>
              {item.inclusion.state !== 'included' && item.inclusion.state !== 'warning' && (
                <button className="wb-btn" disabled={!editable || busy} onClick={() => void saveEdit({ type: 'add', afterLine: -1, text: '' }, false, item.id)}>加入草稿</button>
              )}
            </article>
          ))}
          {view.evidenceRemoved.count > 0 && <p className="wb-hint">另有 {view.evidenceRemoved.count} 条事项的证据已被删除：不再写入日报，内容也不再显示。</p>}
        </section>
      )}

      {tab === 'materials' && (
        <section className="wb-materials" aria-label="资料">
          <div className="wb-import">
            <h2>导入文件</h2>
            <p className="wb-hint">由系统文件框选择一个文本文件（如聊天导出）。正文只登记在本机，默认不发送给模型；需要时再单独请求允许。</p>
            <div className="wb-form">
              <label>种类
                <select value={importMeta.kind} onChange={event => setImportMeta({ ...importMeta, kind: event.target.value })}>
                  <option value="chat_excerpt">聊天片段</option>
                  <option value="import_text">导入文本</option>
                  <option value="note">随手记</option>
                </select>
              </label>
              <label>对象<input value={importMeta.objectLabel} placeholder="聊天对象或群名（可不填）" onChange={event => setImportMeta({ ...importMeta, objectLabel: event.target.value })} /></label>
              <label>覆盖开始<input type="datetime-local" value={importMeta.from} onChange={event => setImportMeta({ ...importMeta, from: event.target.value })} /></label>
              <label>覆盖结束<input type="datetime-local" value={importMeta.to} onChange={event => setImportMeta({ ...importMeta, to: event.target.value })} /></label>
              <button className="wb-btn primary" disabled={busy} onClick={() => void importFile()}>选择文件导入…</button>
            </div>
          </div>
          {view.materials.length === 0 && <p className="wb-hint">这一天没有登记资料。</p>}
          {view.materials.map(material => (
            <article key={material.id} className="wb-material">
              <header>
                <span className="chip">{material.kindLabel}</span>
                <span className="chip">{ORIGIN_LABEL[material.origin] ?? material.origin}</span>
                <span className={`chip ${material.modelVisible ? 'warn' : 'live'}`}>{material.modelVisible ? '正文可发送给模型' : '正文只在本机'}</span>
                {material.object && <span className="chip">对象：{material.object}</span>}
                <span className="wb-item-time">{time(material.createdAt)}</span>
              </header>
              <p className="wb-coverage">{material.coverage}</p>
              {material.digest && <p className="wb-hint mono">内容摘要 {material.digest.slice(0, 16)}（重复导入按它识别）</p>}
              {material.usedBy.length > 0 && <p className="wb-hint">被 {material.usedBy.length} 条工作事项引用</p>}
              <details>
                <summary>查看正文（{material.lines} 行）</summary>
                <pre className="wb-pre small">{material.preview}</pre>
              </details>
              <div className="wb-actions">
                {!material.modelVisible && !material.legacy && <button className="wb-btn" disabled={busy} onClick={() => void requestShare(material)}>允许发送给模型…</button>}
                <button className="wb-btn" disabled={busy} onClick={() => openDeletion('material', `删除资料「${material.kindLabel}${material.object ? ` · ${material.object}` : ''}」`, { materialId: material.id, date: view.date })}>删除…</button>
              </div>
            </article>
          ))}
        </section>
      )}

      {tab === 'history' && (
        <section className="wb-history" aria-label="历史与删除">
          <p className="wb-hint">没有"全部清空"：每类删除都要单独查看影响范围，再请求确认。除草稿条目外，确认都在专用审批窗口完成。</p>
          <h2>版本历史</h2>
          <table className="wb-table">
            <thead><tr><th>版本</th><th>状态</th><th>时间</th><th>怎么来的</th><th>备注</th><th /></tr></thead>
            <tbody>
              {view.history.map(record => (
                <tr key={record.revision}>
                  <td>第 {record.revision} 版</td>
                  <td><span className={`chip state-${record.state}`}>{STATE_LABEL[record.state] ?? record.state}</span></td>
                  <td>{time(record.createdAt)}</td>
                  <td>{record.change ?? '—'}</td>
                  <td>{record.revokedReason ?? ''}</td>
                  <td>{record.state !== 'revoked' && record.state !== 'publishing' && (
                    <button className="wb-btn quiet" disabled={busy} onClick={() => openDeletion('report_version', `撤销第 ${record.revision} 版`, { date: view.date, revision: record.revision })}>撤销此版…</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>已导出的文件</h2>
          {view.exports.length === 0 && <p className="wb-hint">还没有导出过文件。</p>}
          {view.exports.map(item => (
            <div key={`${item.revision}:${item.path}`} className="wb-export">
              <span className="mono">{item.path}</span>
              <span className="chip">第 {item.revision} 版</span>
              <span className={`chip ${item.exists ? (item.matchesRevision ? 'live' : 'warn') : ''}`}>{item.exists ? (item.matchesRevision ? '文件在，内容与该版一致' : '文件在，但内容已被改过') : item.deletedAt ? `已于 ${time(item.deletedAt)} 删除` : '文件不在'}</span>
              {item.exists && <button className="wb-btn quiet" disabled={busy} onClick={() => openDeletion('exported_file', `删除第 ${item.revision} 版的导出文件`, { date: view.date, revision: item.revision })}>删除导出文件…</button>}
            </div>
          ))}

          <h2>删除一段时间的活动记录</h2>
          <div className="wb-form">
            <label>开始<input type="time" value={range.from} onChange={event => setRange({ ...range, from: event.target.value })} /></label>
            <label>结束<input type="time" value={range.to} onChange={event => setRange({ ...range, to: event.target.value })} /></label>
            <button className="wb-btn" disabled={busy || !range.from || !range.to} onClick={() => {
              const from = new Date(`${view.date}T${range.from}:00`).getTime()
              const to = new Date(`${view.date}T${range.to}:00`).getTime()
              openDeletion('activity_range', `删除 ${view.date} ${range.from}–${range.to} 的活动记录`, { from, to })
            }}>查看影响…</button>
          </div>

          <h2>长期记忆</h2>
          <p className="wb-hint">改写是就地改这一条：编号不变、版本号 +1，引用它的待批与事项不会断。手动的批准在专用审批窗口完成，这里改不了生效时间。</p>
          {view.memories.items.length === 0 && <p className="wb-hint">没有可管理的记忆。</p>}
          {view.memories.items.map(memory => (
            <div key={memory.id} className="wb-memory">
              <span className="chip">{memory.scope}</span>
              <span className="chip">{memory.status === 'confirmed' ? '已确认' : memory.status === 'candidate' ? '候选' : memory.status}</span>
              {memoryEdit?.id === memory.id ? (
                <div className="wb-memory-edit">
                  {memory.topic && <label>分类<input value={memoryEdit.topic} onChange={event => setMemoryEdit({ ...memoryEdit, topic: event.target.value })} /></label>}
                  <textarea rows={3} value={memoryEdit.text} onChange={event => setMemoryEdit({ ...memoryEdit, text: event.target.value })} />
                  <div className="wb-actions">
                    <button className="wb-btn primary" disabled={busy || memoryEdit.text.trim() === memoryEdit.original.trim()} onClick={() => void saveMemoryEdit()}>提交改写</button>
                    <button className="wb-btn quiet" disabled={busy} onClick={() => setMemoryEdit(null)}>取消</button>
                  </div>
                </div>
              ) : (
                <>
                  <span>{memory.topic ? `「${memory.topic}」` : ''}{memory.text}</span>
                  <button className="wb-btn quiet" disabled={busy} onClick={() => setMemoryEdit({ id: memory.id, text: memory.text, topic: memory.topic, original: memory.text })}>改写…</button>
                  <button className="wb-btn quiet" disabled={busy} onClick={() => openDeletion('memory', `删除记忆「${memory.text.slice(0, 20)}」`, { memoryId: memory.id })}>删除…</button>
                </>
              )}
            </div>
          ))}
          {view.memories.hiddenProjectMemories > 0 && <p className="wb-hint">另有 {view.memories.hiddenProjectMemories} 条项目记忆所属的帮助授权已失效，暂不显示。</p>}

          <h2>删除回执</h2>
          {view.receipts.length === 0 && <p className="wb-hint">还没有删除记录。</p>}
          {view.receipts.map(item => (
            <details key={item.id} className={`wb-receipt ${item.receipt.failures.length > 0 ? 'failed' : ''}`} open={item.receipt.failures.length > 0}>
              <summary>{time(item.createdAt)} · {item.receipt.label}{item.receipt.failures.length > 0 ? ' · 有失败项' : ''}</summary>
              <ImpactList title="已删除" tone="delete" items={item.receipt.deleted} />
              <ImpactList title="已失效" tone="invalidate" items={item.receipt.invalidated} />
              <ImpactList title="仍保留" tone="retain" items={item.receipt.retained} />
              <ImpactList title="无法控制" tone="uncontrolled" items={item.receipt.uncontrolled} />
              <ImpactList title="失败" tone="failure" items={item.receipt.failures} />
            </details>
          ))}
        </section>
      )}

      {deletion && (
        <div className="wb-modal" role="dialog" aria-modal="true" aria-label={deletion.title}>
          <div className="wb-dialog">
            <h2>{deletion.title}</h2>
            <label className="wb-reason">原因（可不填）
              <input value={deletion.reason} onChange={event => setDeletion({ ...deletion, reason: event.target.value, impact: null, result: null })} />
            </label>
            {!deletion.impact && <button className="wb-btn" disabled={deletion.busy} onClick={() => void previewDeletion()}>查看影响</button>}
            {deletion.impact && (
              <>
                {deletion.impact.blocked && <p className="wb-notice tone-error">现在不能执行：{deletion.impact.blocked}</p>}
                <ImpactList title="将删除" tone="delete" items={deletion.impact.willDelete} />
                <ImpactList title="将失效" tone="invalidate" items={deletion.impact.willInvalidate} />
                <ImpactList title="仍保留" tone="retain" items={deletion.impact.retained} />
                <ImpactList title="无法控制" tone="uncontrolled" items={deletion.impact.uncontrolled} />
                <p className="wb-hint">{deletion.impact.needsTrustedApproval ? '确认将在专用审批窗口完成；在那里批准之前，什么都不会删除。' : '这只会生成一个新版本，旧版本仍留在历史里。'}</p>
              </>
            )}
            {deletion.result && <p className="wb-notice tone-error">{deletion.result}</p>}
            <div className="wb-actions end">
              <button className="wb-btn quiet" onClick={() => setDeletion(null)}>取消</button>
              <button className="wb-btn danger" disabled={!deletion.impact || !!deletion.impact.blocked || deletion.busy} onClick={() => void confirmDeletion()}>
                {deletion.impact?.needsTrustedApproval === false ? '确认删除这一条' : '请求可信确认'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function AddBox({ adding, setAdding, busy, save }: {
  adding: { afterLine: number; text: string; preview: string | null }
  setAdding: (value: { afterLine: number; text: string; preview: string | null } | null) => void
  busy: boolean
  save: (op: { type: 'add'; afterLine: number; text: string }, dryRun: boolean) => Promise<WorkbenchReply>
}) {
  return (
    <div className="wb-addbox">
      <textarea aria-label="补充一条" rows={2} value={adding.text} placeholder="补充的内容（一行一条）" onChange={event => setAdding({ ...adding, text: event.target.value, preview: null })} />
      {adding.preview !== null && <pre className="wb-pre small" aria-label="补充后全文">{adding.preview}</pre>}
      <div className="wb-actions">
        <button className="wb-btn" disabled={busy || !adding.text.trim()} onClick={async () => {
          const result = await save({ type: 'add', afterLine: adding.afterLine, text: adding.text }, true)
          if (result.ok) setAdding({ ...adding, preview: String(result.data?.preview ?? '') })
        }}>预览</button>
        <button className="wb-btn primary" disabled={busy || adding.preview === null} onClick={() => void save({ type: 'add', afterLine: adding.afterLine, text: adding.text }, false)}>保存为新版本</button>
        <button className="wb-btn quiet" onClick={() => setAdding(null)}>取消</button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
