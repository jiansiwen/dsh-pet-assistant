import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssistantMailView, MailAnalysisRow } from '../main/assistant-mail.js'

/**
 * 邮件页：邮箱配置 + 值守结果。
 *
 * 三块内容按"先看结果、再改配置"排：
 * 1. 值守分析列表 —— 用户来这一页通常是想知道"有没有要我处理的邮件"；
 * 2. 邮箱配置 —— 没有配置时才需要动手，放在下面；
 * 3. 口径说明 —— "服务接受≠已读"、发信走审批，这些不能藏在别处。
 *
 * 授权码只写不读：输入框永远为空，回包只有 hasPassword；留空保存 = 沿用已存授权码。
 */
interface FormState {
  address: string
  smtpHost: string
  smtpPort: string
  imapHost: string
  imapPort: string
  password: string
}

const EMPTY_FORM: FormState = { address: '', smtpHost: '', smtpPort: '465', imapHost: '', imapPort: '993', password: '' }

const SUGGESTION_KIND_LABELS: Record<string, string> = {
  'draft-sql': 'SQL 草稿', 'open-ticket': '建工单', 'reply-mail': '回复邮件', 'manual-step': '人工处理', none: '无需处理',
}
const RISK_LABELS: Record<string, string> = { low: '低风险', medium: '中风险', high: '高风险' }

function timeLabel(value: number): string {
  try { return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
  catch { return String(value) }
}

export default function MailSettings() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  /** undefined = 还没读到；null = 已读到且确认"未配置"。 */
  const [view, setView] = useState<AssistantMailView | null | undefined>(undefined)
  const [analyses, setAnalyses] = useState<readonly MailAnalysisRow[]>([])
  const [analysesLoaded, setAnalysesLoaded] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const load = useCallback(async () => {
    setPending(true)
    setError('')
    try {
      const [config, list] = await Promise.all([window.petApi.assistantMailState(), window.petApi.assistantMailAnalyses(20)])
      if (!mounted.current) return
      if (!config.ok) { setError(config.message); return }
      setView(config.mail)
      setForm(config.mail === null ? EMPTY_FORM : {
        address: config.mail.address, smtpHost: config.mail.smtpHost, smtpPort: String(config.mail.smtpPort),
        imapHost: config.mail.imapHost, imapPort: String(config.mail.imapPort), password: '',
      })
      setNotice('')
      if (!list.ok) setError(list.message)
      else { setAnalyses(list.analyses); setAnalysesLoaded(true) }
    } catch {
      if (mounted.current) setError('读取失败，请重试。')
    } finally {
      if (mounted.current) setPending(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const save = async (): Promise<void> => {
    if (pending) return
    setPending(true)
    setError('')
    setNotice('')
    try {
      const result = await window.petApi.assistantMailSave({
        address: form.address.trim(),
        smtpHost: form.smtpHost.trim(),
        smtpPort: Number(form.smtpPort),
        imapHost: form.imapHost.trim(),
        imapPort: Number(form.imapPort),
        ...(form.password === '' ? {} : { password: form.password }),
      })
      if (!mounted.current) return
      if (!result.ok) { setError(result.message); return }
      setView(result.mail)
      setForm(previous => ({ ...previous, password: '' }))
      setNotice(result.message ?? '邮箱配置已保存。')
      const list = await window.petApi.assistantMailAnalyses(20)
      if (mounted.current && list.ok) { setAnalyses(list.analyses); setAnalysesLoaded(true) }
    } catch {
      if (mounted.current) setError('保存失败，请重试。')
    } finally {
      if (mounted.current) setPending(false)
    }
  }

  const field = (key: keyof FormState) => ({
    value: form[key],
    disabled: pending,
    onChange: (event: { target: { value: string } }) => setForm(previous => ({ ...previous, [key]: event.target.value })),
  })

  const watchLabel = view === null || view === undefined
    ? '未知'
    : view.watchEnabled ? `值守中（每 ${Math.round(view.watchIntervalSeconds / 60)} 分钟查看未读）` : '值守未开启'

  return (
    <div className="management-general" aria-busy={pending}>
      <section className="management-section" aria-label="值守结果">
        <h3>值守结果</h3>
        <div className="management-quick">
          <button type="button" className="management-button" disabled={pending} onClick={() => void load()}>刷新</button>
        </div>
        <p className="management-hint" role="status">
          {view === undefined ? '正在读取配置…' : `${watchLabel}${view === null ? '' : ` · 邮箱 ${view.address}`}`}
        </p>
        {error && <p className="assistant-settings-error" role="alert">{error}</p>}
        {notice && <p className="management-hint" role="status">{notice}</p>}
        {!analysesLoaded && !error && <p className="management-hint">正在读取值守结果…</p>}
        {analysesLoaded && analyses.length === 0 && <p className="management-hint">
          还没有值守分析。配置好邮箱并启用团队后，值守会按间隔读取未读邮件，给出摘要与处理建议；
          这里出现的只是建议，不会自动执行任何动作。
        </p>}
        {analyses.length > 0 && <ul className="assistant-settings-list">
          {analyses.map(row => <li key={row.analysisId}>
            <details>
              <summary>
                {timeLabel(row.createdAt)} · {row.memberId} · {row.uids.length} 封邮件
                {row.suggestions.length > 0 ? ` · ${row.suggestions.length} 条建议` : ''}
                 {row.silent ? ' · 按成员规则不提醒' : row.notifiedAt === null ? ' · 尚未通知' : ''}
              </summary>
              <p className="management-hint">{row.result.slice(0, 4000)}</p>
              {row.suggestions.length > 0 && <ul className="assistant-settings-list">
                {row.suggestions.map((suggestion, index) => <li key={`${row.analysisId}-${index}`}>
                  <strong>{SUGGESTION_KIND_LABELS[suggestion.kind] ?? suggestion.kind} · {suggestion.title}</strong>
                  {' '}（{RISK_LABELS[suggestion.risk] ?? suggestion.risk}{suggestion.uid === null ? '' : ` · 邮件 UID ${suggestion.uid}`}）
                  <p className="management-hint">{suggestion.rationale}</p>
                  {suggestion.payload !== '' && <details>
                    <summary>查看建议内容</summary>
                    <pre className="management-hint">{suggestion.payload.slice(0, 20_000)}</pre>
                  </details>}
                </li>)}
              </ul>}
            </details>
          </li>)}
        </ul>}
        <p className="management-hint">
          值守结果只是建议：任何回信、建单、改数据都要你另行确认后才会执行。
          目前建议还不能一键转成待办，需要的话请把内容交给总助理登记。
        </p>
      </section>

      <section className="management-section" aria-label="邮箱配置">
        <h3>邮箱配置</h3>
        <p className="management-hint">
          审批发信、会议纪要外发与值守读取都用这一套邮箱。SMTP 用于发信，IMAP 用于查看未读；端口 465 走隐式 TLS，其余按 STARTTLS。
        </p>
        <form onSubmit={event => { event.preventDefault(); void save() }}>
          <fieldset className="assistant-settings-fields" disabled={pending}>
            <legend className="assistant-settings-legend">邮箱</legend>
            <label className="assistant-settings-field">邮箱地址
              <input type="email" autoComplete="off" maxLength={320} required placeholder="name@example.com" {...field('address')} />
            </label>
            <label className="assistant-settings-field">SMTP 主机（发信）
              <input type="text" autoComplete="off" maxLength={255} required placeholder="smtp.example.com" {...field('smtpHost')} />
            </label>
            <label className="assistant-settings-field">SMTP 端口
              <input type="number" min={1} max={65535} required {...field('smtpPort')} />
            </label>
            <label className="assistant-settings-field">IMAP 主机（收信/值守）
              <input type="text" autoComplete="off" maxLength={255} required placeholder="imap.example.com" {...field('imapHost')} />
            </label>
            <label className="assistant-settings-field">IMAP 端口
              <input type="number" min={1} max={65535} required {...field('imapPort')} />
            </label>
            <label className="assistant-settings-field">授权码
              <input type="password" autoComplete="new-password" spellCheck={false} maxLength={4096}
                placeholder={view !== null && view !== undefined && view.hasPassword ? '已配置，留空保持不变' : '尚未配置，需要填写授权码'}
                {...field('password')} />
            </label>
            <p className="management-hint">
              授权码只写不读：保存后本页与日志都不会回显。多数邮箱需要在服务商后台开启 IMAP/SMTP 并生成"授权码/应用专用密码"。
            </p>
            <button className="management-button" type="submit" disabled={pending}>{pending ? '正在保存…' : '保存邮箱配置'}</button>
          </fieldset>
        </form>
      </section>

      <section className="management-section" aria-label="收发口径">
        <h3>收发口径</h3>
        <ul className="assistant-settings-list">
          <li><strong>服务接受 ≠ 对方已读</strong>：发送成功只代表邮件服务接受了这封信；对方是否阅读、是否退信，这里看不到，也不会猜。</li>
          <li><strong>发信走审批</strong>：要发邮件，在上面的对话里对助理说清收件人、主题和正文。提交后会在桌面审批窗口展示完整内容，只有你批准后才真正发送。</li>
          <li><strong>值守不自动动手</strong>：值守只读取未读邮件并给摘要和建议；回复、建单、改数据都不会自动执行。</li>
          <li><strong>失败不重发</strong>：发送结果未知或部分接受时会先停在待核查，不会自动重试，避免重复发信。</li>
        </ul>
      </section>
    </div>
  )
}
