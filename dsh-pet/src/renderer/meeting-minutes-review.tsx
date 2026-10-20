/**
 * 会议纪要审阅（M4-06）：本地模板版 / 模型草稿、数据去向授权、逐条来源、待确认与已剔除、
 * 改稿、确认与导出定稿。
 *
 * - 「用模型生成纪要」只在这里发起；主进程先弹原生对话框说明发送哪些文字、发给谁，同意才发。
 *   这里不能替用户同意，也没有任何"自动生成"。
 * - 每条显示来源（段号、时间、说话人），点击定位回转写里的原片段。
 * - 下面的 <pre> 就是导出正文：确认带上它的 digest，导出拿回的是同一份。
 */
import { useCallback, useState } from 'react'
import type { MeetingMinutesResult, MinutesItem } from './types.js'

function mmss(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '--:--'
  const total = Math.floor(ms / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

const KIND_TITLE: Record<MinutesItem['kind'], string> = { summary: '摘要', decision: '决议', action: '待办' }

export interface MeetingMinutesReviewProps {
  readonly api: Window['petApi']
  readonly meetingId: string
  readonly result: MeetingMinutesResult | null
  /** 当前转写版本（与纪要基于的版本对照）。 */
  readonly revision: number
  /** 点来源：定位并高亮转写里的那一段。 */
  readonly onLocate: (idx: number) => void
  /** 纪要/授权有变化后重新拉取。 */
  readonly onChanged: () => Promise<void>
  readonly onNotice: (message: string) => void
}

interface EditDraft {
  readonly itemId: string
  readonly text: string
  readonly owner: string
  readonly due: string
}

export default function MeetingMinutesReview({ api, meetingId, result, revision, onLocate, onChanged, onNotice }: MeetingMinutesReviewProps) {
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<EditDraft | null>(null)

  const run = useCallback(async <T extends { ok: boolean; error?: string }>(action: () => Promise<T>, okMessage: string | ((value: T) => string)) => {
    setBusy(true)
    try {
      let outcome: T | null = null
      try {
        outcome = await action()
      } catch {
        outcome = null
      }
      if (outcome === null) onNotice('主进程没有响应')
      else if (!outcome.ok) onNotice(outcome.error ?? '操作失败')
      else onNotice(typeof okMessage === 'string' ? okMessage : okMessage(outcome))
      await onChanged()
    } finally {
      setBusy(false)
    }
  }, [onChanged, onNotice])

  const minutes = result?.minutes ?? null
  const egress = result?.egress ?? null
  const model = result?.model ?? { available: false, generating: false }
  const structured = minutes?.kind === 'model' ? minutes.structured : null
  const stale = minutes !== null && (minutes.stale || (structured !== null && structured.basedOnRevision !== revision))
  const kept = structured?.items.filter(item => item.status === 'kept') ?? []
  const rejected = structured?.items.filter(item => item.status === 'rejected') ?? []
  const generating = busy || model.generating

  const generate = (): void => {
    void run(
      () => api.meetingMinutesGenerate(meetingId),
      outcome => outcome.ok
        ? `模型纪要已生成：保留 ${outcome.kept} 条${outcome.rejected > 0 ? `，${outcome.rejected} 条无来源/无法核对已剔除` : ''}。请逐条核对后再确认。`
        : '',
    )
  }

  const copyFinal = async (): Promise<void> => {
    const exported = await api.meetingMinutesExport(meetingId).catch(() => ({ ok: false, error: '主进程没有响应' } as const))
    if (!exported.ok || exported.content === undefined) {
      onNotice(exported.error ?? '无法导出')
      return
    }
    try {
      await navigator.clipboard.writeText(exported.content)
      onNotice('已复制定稿（与确认时预览的正文一致）')
    } catch {
      onNotice('复制失败：可以在上面的正文里手动选择复制')
    }
  }

  /**
   * 把这份已确认的纪要交给个人助理，成为日报可引用的证据。
   *
   * 主进程会先弹原生对话框（正文预览 + 去向），用户取消就什么也不发 ——
   * 所以这里的成功/取消提示按结果如实说，不预设"点了就成功"。
   */
  const intake = async (): Promise<void> => {
    const result = await api.evidenceIntakeMinutes(meetingId)
      .catch(() => ({ ok: false as const, error: '主进程没有响应' }))
    if (!result.ok) {
      onNotice(result.error)
      return
    }
    onNotice(result.duplicate
      ? '这份纪要之前已经交给过助理，这次没有重复收进来'
      : `已交给助理，成为日报证据${result.warning ? `（${result.warning}）` : ''}`)
  }

  const saveEdit = (): void => {    const draft = editing
    if (draft === null) return
    const item = structured?.items.find(entry => entry.id === draft.itemId)
    setEditing(null)
    void run(
      () => api.meetingMinutesEditItem(meetingId, draft.itemId, {
        text: draft.text,
        ...(item?.kind === 'action' ? { owner: draft.owner.trim() === '' ? null : draft.owner, due: draft.due.trim() === '' ? null : draft.due } : {}),
      }),
      '已修改；纪要内容变了，需要重新确认',
    )
  }

  const renderItem = (item: MinutesItem) => {
    const isEditing = editing?.itemId === item.id
    return (
      <li key={item.id} className={'meeting-mitem' + (item.status === 'rejected' ? ' rejected' : '')}>
        <div className="meeting-mitem-text">
          {item.text === '' ? '（空）' : item.text}
          {item.edited === true ? <em className="meeting-uncertain">已人工修改</em> : null}
        </div>
        {item.kind === 'action' && item.status === 'kept' && (
          <div className="meeting-mitem-fields">
            负责人：{item.owner === null ? <em className="meeting-pending">待确认</em> : `${item.owner}${item.ownerOrigin === 'user' ? '（人工填写）' : ''}`}
            {'　'}期限：{item.due === null ? <em className="meeting-pending">待确认</em> : `${item.due}${item.dueOrigin === 'user' ? '（人工填写）' : ''}`}
          </div>
        )}
        <div className="meeting-mitem-sources">
          {item.sources.length === 0 ? (
            <em className="meeting-pending">无来源</em>
          ) : (
            item.sources.map(ref => (
              <button key={ref.idx} type="button" className="meeting-source-btn" title="定位到原片段" onClick={() => onLocate(ref.idx)}>
                段{ref.idx + 1} {mmss(ref.startMs)}–{mmss(ref.endMs)} {ref.label}{ref.uncertain ? '（未确认）' : ''}
              </button>
            ))
          )}
        </div>
        {item.status === 'rejected' && <p className="meeting-error">已剔除，不进入定稿：{item.reasons.join('；')}</p>}
        {item.warnings.map(warning => <p key={warning} className="meeting-hint">{warning}</p>)}
        {item.status === 'kept' && !stale && !isEditing && (
          <button
            type="button"
            className="meeting-btn"
            disabled={generating}
            onClick={() => setEditing({ itemId: item.id, text: item.text, owner: item.owner ?? '', due: item.due ?? '' })}
          >
            修改
          </button>
        )}
        {isEditing && editing !== null && (
          <div className="meeting-mitem-edit">
            <textarea value={editing.text} maxLength={400} onChange={event => setEditing({ ...editing, text: event.target.value })} />
            {item.kind === 'action' && (
              <>
                <input type="text" placeholder="负责人（留空 = 待确认）" value={editing.owner} maxLength={400} onChange={event => setEditing({ ...editing, owner: event.target.value })} />
                <input type="text" placeholder="期限（留空 = 待确认）" value={editing.due} maxLength={400} onChange={event => setEditing({ ...editing, due: event.target.value })} />
              </>
            )}
            <button type="button" className="meeting-btn" disabled={editing.text.trim() === ''} onClick={saveEdit}>保存</button>
            <button type="button" className="meeting-btn" onClick={() => setEditing(null)}>取消</button>
          </div>
        )}
      </li>
    )
  }

  return (
    <section className="meeting-section">
      <h3 className="meeting-title">
        会议纪要
        {minutes !== null && (
          <span className="meeting-revision">
            {minutes.kind === 'model'
              ? `模型草稿 · 基于转写 revision ${structured?.basedOnRevision ?? minutes.revision}`
              : '本地模板版 · 未经模型'}
          </span>
        )}
      </h3>

      <div className="meeting-egress">
        {egress?.active != null ? (
          <>
            <span>
              已授权把本场会议的文字发给模型（{new Date(egress.active.at).toLocaleString()}
              {egress.active.revision !== null ? `，转写 revision ${egress.active.revision}` : ''}）
            </span>
            <button type="button" className="meeting-btn" disabled={busy} onClick={() => void run(() => api.meetingMinutesRevokeEgress(meetingId), '已撤销授权：之后再生成需要重新同意（已发送的内容无法从服务商处收回）')}>
              撤销授权
            </button>
            <details className="meeting-egress-detail">
              <summary>当时同意的内容</summary>
              <pre className="meeting-minutes">{egress.active.summary}</pre>
            </details>
          </>
        ) : (
          <span>未授权：本场会议的文字没有发给任何模型。</span>
        )}
        {egress?.undecryptable === true && <span className="meeting-error">授权记录不可解密，按未授权处理。</span>}
      </div>

      <div className="meeting-edit-row">
        <button type="button" className="meeting-btn" disabled={!model.available || generating} onClick={generate}>
          {generating ? '生成中…' : '用模型生成纪要'}
        </button>
        {minutes?.kind === 'model' && (
          <button type="button" className="meeting-btn" disabled={generating} onClick={() => void run(() => api.meetingMinutesUseLocal(meetingId), '已改回本地模板版（未经模型）')}>
            改回本地模板版
          </button>
        )}
      </div>
      <p className="meeting-hint">
        {model.available
          ? '点击后会先弹出系统对话框，写明将发送本场会议的哪些文字、发给谁；你同意后才发送，拒绝则什么都不发。'
          : '模型不可用：保留本地模板版纪要（未经模型）。'}
      </p>

      {minutes === null ? (
        <p className="meeting-hint">纪要还没有生成（转写完成后自动生成本地模板版草稿）。</p>
      ) : (
        <>
          {stale && <p className="meeting-error">转写在纪要生成后被修订，这份纪要的来源已失效，请重新生成。</p>}
          {structured !== null && !stale && (
            <>
              {(['summary', 'decision', 'action'] as const).map(kind => {
                const list = kept.filter(item => item.kind === kind)
                return (
                  <div key={kind} className="meeting-mgroup">
                    <h4 className="meeting-subtitle">{KIND_TITLE[kind]}</h4>
                    {list.length === 0 ? <p className="meeting-hint">（没有可核对的{KIND_TITLE[kind]}）</p> : <ul className="meeting-mitems">{list.map(renderItem)}</ul>}
                  </div>
                )
              })}
              {rejected.length > 0 && (
                <details className="meeting-mgroup">
                  <summary className="meeting-error">已剔除 {rejected.length} 条（无来源或无法核对，不进入定稿）</summary>
                  <ul className="meeting-mitems">{rejected.map(renderItem)}</ul>
                </details>
              )}
            </>
          )}

          <p className="meeting-hint">以下是将导出的纪要正文，确认的就是这一份：</p>
          <pre className="meeting-minutes">{minutes.content}</pre>
          <p className="meeting-minutes-meta">
            {minutes.state === 'confirmed'
              ? `已确认（${new Date(minutes.confirmedAt ?? Date.now()).toLocaleString()}），digest ${minutes.digest.slice(0, 12)}…`
              : `草稿 · revision ${minutes.revision} · digest ${minutes.digest.slice(0, 12)}…`}
          </p>
          {minutes.state !== 'confirmed' && !stale && (
            <button
              type="button"
              className="meeting-btn primary"
              disabled={generating || minutes.undecryptable === true}
              onClick={() => void run(() => api.meetingMinutesConfirm(meetingId, minutes.digest), '纪要已确认')}
            >
              我核对过了，确认这份纪要
            </button>
          )}
          {minutes.state === 'confirmed' && !stale && (
            <>
              <button type="button" className="meeting-btn" onClick={() => void copyFinal()}>
                复制定稿
              </button>
              <button type="button" className="meeting-btn primary" disabled={generating} onClick={() => void intake()}>
                转为日报证据
              </button>
            </>
          )}
        </>
      )}
    </section>
  )
}
