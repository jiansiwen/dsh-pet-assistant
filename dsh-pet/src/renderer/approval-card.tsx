/**
 * 专用审批窗口里的那一张卡片。
 *
 * 这个页面与舞台面板的区别不在长相，在**它能做什么**：它是唯一能签发批准的地方。
 * 所以这里的取舍与舞台相反——舞台追求轻快，这里追求"用户在看清之后才点得下去"：
 * - 默认焦点落在「驳回」上，回车不会批准；
 * - 需要再过原生确认框的操作，卡片上先说明白，不让第二个弹框变成惊吓；
 * - 不能决定时把原因写在按钮旁边，而不是只把按钮灰掉；
 * - 范围（工具、目标、摘要）与有效期（倒计时）都摊开显示，这是设计文档点名要求的两项。
 *
 * 页面上没有任何角色形象、皮肤或动画资源：加载角色包就等于把舞台那套不可信内容的渲染
 * 能力搬进签发口，前面拆开的两件事又粘回去了。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { formatCountdown, type ApprovalCardView } from '../main/approval-policy.js'
import type { ApprovalCardApi } from '../preload/approval.js'
import type { ApprovalDecision, DecideApprovalResult } from './types.js'
import './approval-card.css'

declare global {
  interface Window {
    approvalCard: ApprovalCardApi
  }
}

export default function ApprovalCardPage() {
  const [view, setView] = useState<ApprovalCardView | null>(null)
  /** 第一次 read 回来了没有。没回来之前不渲染"提案不存在"——那只是一次还没落地的加载。 */
  const [loaded, setLoaded] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [pending, setPending] = useState<ApprovalDecision | null>(null)
  const [failure, setFailure] = useState<{ message: string; detail?: string } | null>(null)
  const rejectRef = useRef<HTMLButtonElement | null>(null)

  const load = useCallback(async () => {
    let next: ApprovalCardView | null = null
    try {
      next = await window.approvalCard.read()
    } catch (error) {
      setFailure({
        message: '读不到这张卡片的内容',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    setView(next)
    setNow(Date.now())
    setLoaded(true)
  }, [])

  useEffect(() => {
    void load()
    // 主进程换成下一条提案时会推这个事件；页面自己不轮询，轮询等于每秒问一次"还是我吗"。
    window.approvalCard.onChanged(() => {
      setFailure(null)
      void load()
    })
  }, [load])

  // 倒计时只在"有期限且还能决定"时跳：批不了的卡片上数字继续走只是噪音。
  useEffect(() => {
    if (!view || view.expiresAt === null || !view.canDecide) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [view])

  // 本地到点后重新读一次：能不能批由主进程判，界面只是去要一个新的结论。
  useEffect(() => {
    if (!view || view.expiresAt === null || view.expired) return
    if (now < view.expiresAt) return
    void load()
  }, [view, now, load])

  // Esc 是逃生口：用户不想批也不想读，得有一条不点按钮就能离开的路。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.approvalCard.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 焦点落在驳回上。这是刻意的：高风险操作的默认按键不该是"批准"。
  // 但只在用户还没开始用键盘时抢——已经 Tab 到别处的人被拽回来，只会再点错一次。
  useEffect(() => {
    if (!loaded || !view) return
    const active = document.activeElement
    if (active === null || active === document.body) rejectRef.current?.focus()
  }, [loaded, view])

  const decide = useCallback(
    async (decision: ApprovalDecision) => {
      if (!view || pending) return
      setPending(decision)
      setFailure(null)
      let result: DecideApprovalResult
      try {
        result = await window.approvalCard.decide(view.proposalId, decision)
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      setPending(null)
      if (!result.ok) {
        // 成功后窗口由主进程处理（换下一条或直接关掉），界面这边不用演一段"成功了"。
        setFailure({ message: result.error ?? '这次决定没有生效' })
        void load()
      }
    },
    [view, pending, load],
  )

  if (loaded && !view) {
    return (
      <div className="card-empty">
        <p className="card-empty-title">现在没有待批的操作</p>
        <p className="card-empty-hint">这条提案可能已经被处理，或者已经过期了。</p>
        <button className="card-btn" onClick={() => window.approvalCard.close()}>
          关掉
        </button>
      </div>
    )
  }

  if (!view) {
    return <div className="card-empty card-empty-loading">正在读取这条提案…</div>
  }

  const left = view.expiresAt === null ? null : view.expiresAt - now

  return (
    <div className={`card risk-${view.risk}`}>
      <header className="card-head">
        <h1 className="card-title">有个操作等你点头</h1>
        <span className={`card-risk risk-${view.risk}`}>{view.riskLabel}</span>
      </header>

      <dl className="card-scope">
        <div className="card-row">
          <dt>要做什么</dt>
          <dd className="card-tool">{view.tool}</dd>
        </div>
        {view.target && (
          <div className="card-row">
            <dt>作用在</dt>
            <dd className="card-target" title={view.target}>
              {view.target}
            </dd>
          </div>
        )}
        {view.summary && (
          <div className="card-row">
            <dt>说明</dt>
            <dd className="card-summary">{view.summary}</dd>
          </div>
        )}
        {view.requester && (
          <div className="card-row">
            <dt>谁提请的</dt>
            <dd>{view.requester}</dd>
          </div>
        )}
        <div className="card-row">
          <dt>有效期</dt>
          <dd className={left !== null && left <= 0 ? 'card-countdown expired' : 'card-countdown'}>
            {left === null ? '不限时' : formatCountdown(left)}
          </dd>
        </div>
      </dl>

      {view.needsNativeConfirm && view.canDecide && (
        <p className="card-note">
          这个操作不可撤销或会对外产生影响，点「批准」之后系统还会再弹一个确认框，要你点第二次。
        </p>
      )}

      {failure && (
        <p className="card-failure" role="alert">
          {failure.message}
          {failure.detail && <span className="card-failure-detail">{failure.detail}</span>}
        </p>
      )}

      {view.blockedReason && (
        <p className="card-blocked" role="status">
          {view.blockedReason}
        </p>
      )}

      <footer className="card-actions">
        {/* 「稍后再说」排在最左边并与两个决定拉开距离：它不是一个决定，是一次推迟，
            夹在驳回和批准中间的话，用户会把它当成驳回点掉。 */}
        <button className="card-btn quiet" disabled={pending !== null} onClick={() => window.approvalCard.close()}>
          稍后再说
        </button>
        <button
          ref={rejectRef}
          className="card-btn"
          disabled={!view.canDecide || pending !== null}
          onClick={() => void decide('reject')}
        >
          {pending === 'reject' ? '正在驳回…' : '驳回'}
        </button>
        <button
          className="card-btn primary"
          disabled={!view.canDecide || pending !== null}
          onClick={() => void decide('approve')}
        >
          {pending === 'approve' ? '正在批准…' : '批准'}
        </button>
      </footer>
    </div>
  )
}
