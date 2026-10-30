import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ASSISTANT_SETTINGS_LIMITS as LIMITS, reminderMinutesToSeconds,
  type AssistantSettingsInputs, type AssistantSettingsPage, type AssistantSettingsResult,
  type AssistantSettingsSection, type AssistantSettingsSnapshot,
} from '../assistant-settings-types.ts'

const TITLES: Partial<Record<AssistantSettingsPage, string>> = { wecom: '企业微信渠道', reminders: '新提醒默认间隔' }

export default function AssistantSettings({ section }: { section: AssistantSettingsPage }) {
  const [state, setState] = useState<AssistantSettingsSnapshot | null>(null)
  const [pending, setPending] = useState(true)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [botId, setBotId] = useState('')
  const [secret, setSecret] = useState('')
  const [minutes, setMinutes] = useState('')
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const opening = useRef(false)
  const [openingTasks, setOpeningTasks] = useState(false)

  const apply = useCallback((next: AssistantSettingsSnapshot) => {
    setState(next)
    setEnabled(next.wecom.enabled)
    setBotId(next.wecom.botId)
    setMinutes(String(next.reminder.repeatEverySeconds / 60))
    setNeedsRefresh(false)
  }, [])

  const run = useCallback(async (action: () => Promise<AssistantSettingsResult>, write?: AssistantSettingsSection) => {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError('')
    setNotice('')
    try {
      const result = await action()
      if (!mounted.current) return
      if (!result.ok || !result.state) {
        setNeedsRefresh(true)
        setError(result.error === 'conflict'
          ? '配置版本已变化，请点击“刷新配置”，核对后重新保存。'
          : (result.message || (write ? '保存未确认，请刷新核对；不会自动重发。' : '读取失败，请确认助理已连接后刷新。')))
        return
      }
      apply(result.state)
      // 刷新不清掉尚未提交的密钥；渠道写入成功后立即清空，绝不落入浏览器存储。
      if (write === 'wecom') setSecret('')
      setNotice(result.message || (write === 'reminders' ? '已保存，仅影响以后新建的提醒。'
        : write ? (result.state.wecom.connected ? '配置已确认，企业微信已连接。' : '配置已确认，企业微信尚未连接，请稍后刷新状态。')
        : '已读取最新配置。'))
    } catch {
      if (mounted.current) {
        setNeedsRefresh(true)
        setError(write ? '连接中断，保存结果未知，请刷新核对；不会自动重发。' : '读取失败，请确认助理已连接后刷新。')
      }
    } finally {
      inFlight.current = false
      if (mounted.current) setPending(false)
    }
  }, [apply])

  useEffect(() => {
    mounted.current = true
    void run(() => window.petApi.assistantSettingsState())
    return () => { mounted.current = false }
  }, [run])

  function save(target: AssistantSettingsSection = section) {
    if (!state || pending || inFlight.current || needsRefresh) return
    setNotice('')
    setError('')
    const expectedRevision = state.revision
    let input: AssistantSettingsInputs[AssistantSettingsSection]
    if (target === 'wecom') {
      if (enabled && (!botId.trim() || (!state.wecom.secretConfigured && !secret.trim()))) {
        setError('启用企业微信前，请填写机器人编号和密钥。')
        return
      }
      if (state.wecom.secretConfigured && botId.trim() !== state.wecom.botId && !secret.trim()) {
        setError('更换机器人编号时，请同时填写新密钥。')
        return
      }
      if (botId.length > LIMITS.botId || secret.length > LIMITS.secret || (secret.trim() && !botId.trim())) {
        setError('请核对机器人编号和密钥的长度；密钥必须关联机器人编号。')
        return
      }
      input = { expectedRevision, enabled, botId: botId.trim(), ...(secret.trim() ? { secret } : {}) }
    } else if (target === 'reminders') {
      const repeatEverySeconds = reminderMinutesToSeconds(minutes)
      if (repeatEverySeconds === null) {
        setError('请输入 1 至 10080 分钟，换算后的秒数必须是整数。')
        return
      }
      input = { expectedRevision, repeatEverySeconds }
    } else if (target === 'wecom/reconnect') input = { expectedRevision }
    else return
    void run(() => window.petApi.assistantSettingsSave(target, input), target)
  }

  async function openTasks() {
    if (opening.current) return
    opening.current = true
    setOpeningTasks(true)
    try {
      const result = await window.petApi.openCompanionTasks()
      if (!result.ok && mounted.current) setError('任务与提醒窗口未能打开，请稍后重试。')
    } catch {
      if (mounted.current) setError('任务与提醒窗口未能打开，请稍后重试。')
    } finally {
      opening.current = false
      if (mounted.current) setOpeningTasks(false)
    }
  }

  const reconnectDirty = !!state && (enabled !== state.wecom.enabled || botId.trim() !== state.wecom.botId || !!secret)
  return (
    <div className="management-general assistant-settings" aria-busy={pending}>
      <section className="management-section" aria-label={TITLES[section]}>
        <h3>{TITLES[section]}</h3>
        <div className="management-quick">
          <button type="button" className="management-button" disabled={pending}
            onClick={() => void run(() => window.petApi.assistantSettingsState())}>刷新配置</button>
        </div>
        <p className="management-hint">刷新会重新读取已保存配置，并替换当前页面尚未保存的普通字段。</p>
        {error && <p className="assistant-settings-error" role="alert">{error}</p>}
        <p className="management-hint" role="status">{pending ? '正在处理，请稍候…' : notice}</p>
        {!state && !pending && <p className="management-hint">尚未取得配置，不能编辑。请点击“刷新配置”重试。</p>}
        {state && <form onSubmit={event => { event.preventDefault(); save() }}>
          <fieldset className="assistant-settings-fields" disabled={pending || needsRefresh}>
            <legend className="assistant-settings-legend">{TITLES[section]}配置</legend>
            {section === 'wecom' ? <>
              <label className="management-voice"><input type="checkbox" checked={enabled}
                onChange={event => setEnabled(event.target.checked)} />启用企业微信</label>
              <label className="assistant-settings-field">机器人编号（Bot ID）
                <input type="text" autoComplete="off" maxLength={LIMITS.botId} value={botId} onChange={event => setBotId(event.target.value)} />
              </label>
              <label className="assistant-settings-field">密钥（Secret）
                <input type="password" autoComplete="new-password" spellCheck={false} maxLength={LIMITS.secret} value={secret}
                  placeholder={state.wecom.secretConfigured ? '已配置，留空保留原密钥' : '尚未配置'}
                  onChange={event => setSecret(event.target.value)} aria-describedby="assistant-secret-hint" />
              </label>
              <p id="assistant-secret-hint" className="management-hint">密钥{state.wecom.secretConfigured ? '已配置' : '未配置'}，不会回显；留空保留，保存成功后清空输入框。</p>
              <div className="management-quick">
                <button className="management-button" type="submit">{pending ? '正在保存…' : enabled ? '保存并连接' : '保存配置'}</button>
                <button className="management-button" type="button" disabled={!state.wecom.enabled || !state.wecom.secretConfigured || reconnectDirty}
                  onClick={() => save('wecom/reconnect')}>重新连接</button>
              </div>
              <p className="management-hint">重新连接只使用已保存配置；修改后请先保存。</p>
            </> : section === 'reminders' ? <>
              <label className="assistant-settings-field">未回应时的默认催办间隔（分钟）
                <input type="number" min={1} max={10080} step="any" required value={minutes}
                  onChange={event => setMinutes(event.target.value)} aria-describedby="assistant-reminder-hint" />
              </label>
              <p id="assistant-reminder-hint" className="management-hint">最少 1 分钟，最多 10080 分钟（7 天），换算后的秒数必须是整数。只影响以后新建提醒；旧任务可在“任务与提醒”内单独修改。</p>
              <button className="management-button" type="submit">{pending ? '正在保存…' : '保存提醒配置'}</button>
            </> : null}
          </fieldset>
        </form>}
        {section === 'wecom' && state && <>
          <p className="management-hint" role="status">已保存渠道状态：{needsRefresh ? '待核对，请刷新' : !state.wecom.enabled ? '未启用' : state.wecom.connected ? '已连接' : '未连接'}。点击刷新获取最新连接状态。</p>
          <h4>已配对用户（只读）</h4>
          {state.wecom.allowedUserIds.length ? <ul className="assistant-settings-list">{state.wecom.allowedUserIds.map((id, index) => <li key={`${index}-${id}`}>{id}</li>)}</ul> : <p className="management-hint">暂无已配对用户。</p>}
          <h4>提醒会话（只读）</h4>
          {state.wecom.deliverHere.length ? <ul className="assistant-settings-list">{state.wecom.deliverHere.map((id, index) => <li key={`${index}-${id}`}>{id}</li>)}</ul> : <p className="management-hint">暂无提醒会话。</p>}
          <p className="management-hint">邮件自动收信尚未实现，这里不提供启用选项。</p>
          <p className="management-hint">成员的职责、模型、权限和独立记忆已统一移到“团队 → 团队成员”，可为通用成员绑定企业微信接收能力。</p>
        </>}
        {section === 'reminders' && <button type="button" className="management-button" disabled={openingTasks}
          onClick={() => void openTasks()}>{openingTasks ? '正在打开…' : '打开任务与提醒'}</button>}
      </section>
    </div>
  )
}
