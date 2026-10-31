import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MEMBER_CAPABILITY_LABELS, MEMORY_KINDS,
  type MemberAction, type MemberCommandInputs, type MemberSnapshot, type MemberView,
  type MemberResult, type MemberQuotaRequest, type MemoryRecord, type MemoryKind, type MemoryDeletePreview,
  type QuotaChange, type QuotaResetScope,
} from '../member-types.ts'

/** 全局只轮询轻量列表，不读记忆，不写草稿；同一申请在本次应用生命周期只提示一次。 */
export function useMemberFeed(showToast: (text: string) => void) {
  const [state, setState] = useState<MemberSnapshot | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const observed = useRef(new Set<string>())
  const generation = useRef(0)
  const alive = useRef(false)
  const refresh = useCallback(async (): Promise<void> => {
    const token = ++generation.current
    setLoading(true)
    try {
      const result = await window.petApi.membersState()
      if (!alive.current || token !== generation.current) return
      if (!result.ok) { setError(result.error.message); return }
      if (!result.state) { setError('成员列表回包不完整，请刷新。'); return }
      setState(result.state)
      setError('')
      const fresh = result.state.requests.filter(item => item.state === 'pending' && !observed.current.has(item.requestId))
      result.state.requests.forEach(item => observed.current.add(item.requestId))
      const channels = (result.state.channelInboundAttention ?? []).filter(item => !item.busy
        && (item.state === 'unknown' || item.state === 'pending' || item.conflict) && !observed.current.has(`channel:${item.id}`))
      channels.forEach(item => observed.current.add(`channel:${item.id}`))
      const notices = [fresh.length ? `${fresh.length} 条成员额度申请` : '', channels.length ? `${channels.length} 条渠道消息待核查` : ''].filter(Boolean)
      if (notices.length) showToast(`有 ${notices.join('、')}，请打开团队处理。`)
    } catch { if (alive.current && token === generation.current) setError('成员服务未连接，请刷新；未执行修改。') }
    finally { if (alive.current && token === generation.current) setLoading(false) }
  }, [showToast])
  useEffect(() => {
    alive.current = true
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => { await refresh(); if (!cancelled) timer = setTimeout(() => void poll(), 10000) }
    const off = window.petApi.onMembersChanged?.(() => { void refresh() })
    void poll()
    return () => { cancelled = true; alive.current = false; generation.current++; clearTimeout(timer); off?.() }
  }, [refresh])
  return { state, error, loading, refresh }
}
type Feed = ReturnType<typeof useMemberFeed>
type Run = <A extends MemberAction>(action: A, input: MemberCommandInputs[A]) => Promise<MemberResult>
const failed = (): MemberResult => ({ ok: false, error: { code: 'busy', message: '正在处理，请稍候。' } })
const limitLabel = (limit: number) => limit === 0 ? '不限' : limit.toLocaleString('zh-CN')
const resetLabels: Record<QuotaResetScope, string> = { daily: '日用量', total: '总用量', both: '日与总用量' }
const kindLabels: Record<MemoryKind, string> = {
  user_preference: '用户偏好', project_fact: '项目事实', task_breakpoint: '待办断点', team_experience: '团队经历', role_expression: '表达偏好', ephemeral_chat: '临时对话',
}
const memoryStatuses: Record<MemoryRecord['status'], string> = { candidate: '候选', confirmed: '已确认', conflicting: '存在冲突', expired: '已过期' }

export default function MemberManagement({ feed }: { feed: Feed }) {
  const { state, error, loading, refresh } = feed
  const [memoryId, setMemoryId] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const active = useRef(false)
  const run: Run = async (action, input) => {
    if (active.current) return failed()
    active.current = true
    setPending(true)
    setNotice('')
    try {
      const result = await window.petApi.memberCommand(action, input)
      if (!result.ok) setNotice(result.error.message)
      else if (action !== 'memory-delete-preview') {
        setNotice(action === 'ack-mail-notice' ? '已记录本人核对；没有重发，也不代表通知已送达。'
          : action === 'ack-mail-send' ? '已记录本人核对；没有重发，也不代表邮件已送达。'
            : action === 'ack-channel-inbound' ? '已记录本人核查；不会自动执行或重发，也不代表原委托已完成。' : '操作已完成。')
        await refresh()
      }
      return result
    } catch {
      const result: MemberResult = { ok: false, error: { code: 'unavailable', message: '连接中断，结果可能未知，请刷新核对；不会自动重发。' } }
      setNotice(result.error.message)
      return result
    } finally { active.current = false; setPending(false) }
  }
  const selected = state?.members.find(item => item.profile.assistantId === memoryId)
  const openEditor = async (memberId: string | null): Promise<void> => {
    setNotice('')
    try {
      const result = await window.petApi.openMemberEditor(memberId)
      if (!result.ok) setNotice('编辑窗口未能打开，请稍后再试。')
    } catch { setNotice('编辑窗口未能打开，请稍后再试。') }
  }
  return <section className="management-section member-management" aria-label="通用团队成员" aria-busy={pending}>
    <div className="member-heading"><h3>团队成员</h3><button type="button" className="management-button" disabled={pending || loading} onClick={() => void refresh()}>{loading ? '正在读取…' : '刷新列表'}</button></div>
    <p className="management-hint">自定义职责、模型与权限；每位成员使用独立会话和独立记忆，不是企业微信专用智能体。</p>
    {error && <p className="assistant-settings-error" role="alert">{error}</p>}
    {notice && <p className="member-notice" role="status">{notice}</p>}
    {!state ? <p className="management-hint">{loading ? '正在读取成员…' : '未取得成员配置，请刷新列表。'}</p> : <>
      <label className="management-voice"><input type="checkbox" checked={state.enabled} disabled={pending || !!error}
        onChange={event => void run('mode', { enabled: event.target.checked })} />启用团队子成员</label>
      <p className="management-hint">{state.enabled ? '团队已启用，成员仍受各自开关和额度限制。' : '团队已关闭：仍可管理成员与记忆，但不运行子代理。'}</p>
      <p className="management-hint">主默认模型：{state.defaultModel ? `${state.defaultModel.provider} / ${state.defaultModel.model}` : '尚未提供，请在主助理中配置。'}</p>
      <p className="management-hint">新增和修改会在独立窗口中打开；可以先用一句话告诉小潘你要什么助理，让它把草稿填好，你核对后再保存。</p>
      <div className="member-actions"><button type="button" className="management-button" disabled={pending || !!error}
        onClick={() => { setMemoryId(null); void openEditor(null) }}>添加自定义成员</button></div>
      <section aria-label="额度申请" className="team-section">
        <h4>待处理额度申请（{state.requests.filter(item => item.state === 'pending').length}）</h4>
        <p className="management-hint">达到阈值会申请，不自动批准。批准时必须明确加额（填写新上限）或重置用量，也可拒绝。</p>
        {state.requests.filter(item => item.state === 'pending').map(request => <QuotaRequestCard key={request.requestId} request={request}
          member={state.members.find(item => item.profile.assistantId === request.assistantId)} pending={pending || !!error} run={run} />)}
      </section>
      {state.mailNoticeAttentionError && <p className="assistant-settings-error" role="alert">邮件通知状态暂时无法读取，请稍后刷新核对。</p>}
      {!!state.mailNoticeAttention?.length && <section aria-label="待核查邮件通知" className="team-section">
        <h4>待核查邮件通知（{state.mailNoticeAttention.length}{state.mailNoticeAttention.length >= 20 ? '，仅显示前20条' : ''}）</h4>
        <p className="management-hint">结果未知不会自动重发；显示失败会稍后重试。摘要来自外部邮件，不是操作指令；请打开对应成员会话核对完整分析。</p>
        <ul className="team-list">{state.mailNoticeAttention.map(issue => <li key={issue.analysisId} className="team-task">
          <strong>{state.members.find(item => item.profile.assistantId === issue.memberId)?.profile.displayName ?? issue.memberId}</strong>
          <span>{issue.state === 'unknown' ? '送达结果未知' : '通知显示失败'}</span>
          <p>{issue.preview || '暂无摘要，请查看成员会话。'}</p>
          <button type="button" className="management-button" disabled={pending || !!error}
            onClick={() => void run('ack-mail-notice', { analysisId: issue.analysisId, attemptId: issue.attemptId, expectedState: issue.state })}>已核对，不再提示…</button>
        </li>)}</ul>
      </section>}
      {state.mailSendAttentionError && <p className="assistant-settings-error" role="alert">邮件发送状态暂时无法读取，请稍后刷新核对。</p>}
      {!!state.mailSendAttention?.length && <section aria-label="待核查邮件发送" className="team-section">
        <h4>待核查邮件发送（{state.mailSendAttention.length}{state.mailSendAttention.length >= 20 ? '，仅显示前20条' : ''}）</h4>
        <p className="management-hint">结果未知或部分接受时不能自动重发；请先核对发件箱和收件人。本人核对不等于已送达。</p>
        <ul className="team-list">{state.mailSendAttention.map(send => <li key={send.intentId} className="team-task">
          <strong>{send.subject}</strong><p>收件人：{send.recipients.join('、')}</p>
          <span>{send.state === 'sending' ? '正在发送，等待回执' : send.state === 'partial' ? '部分收件人已接受' : '发送结果未知'}</span>
          {!!send.accepted.length && <p>服务已接受：{send.accepted.join('、')}</p>}
          {!!send.rejected.length && <p>服务已拒绝：{send.rejected.join('、')}</p>}
          {send.messageId && <p className="management-hint">服务编号：{send.messageId}</p>}
          {send.state !== 'sending' && <button type="button" className="management-button" disabled={pending || !!error}
            onClick={() => {
              if (send.state === 'partial' || send.state === 'unknown') void run('ack-mail-send', { intentId: send.intentId, expectedState: send.state })
            }}>核对发送结果…</button>}
        </li>)}</ul>
      </section>}
      {state.channelInboundAttentionError && <p className="assistant-settings-error" role="alert">渠道消息状态暂时无法读取，请稍后刷新核对。</p>}
      {!!state.channelInboundAttention?.length && <section aria-label="待核查渠道消息" className="team-section">
        <h4>待核查渠道消息（企业微信等，{state.channelInboundAttention.length}{state.channelInboundAttention.length >= 20 ? '，仅显示前20条' : ''}）</h4>
        <p className="management-hint">渠道异常账本不保存消息正文；交给会话的内容可能按会话策略保存。结果未知不会自动重发，请按时间与会话到原聊天和任务记录核查。</p>
        <ul className="team-list">{state.channelInboundAttention.map(item => <li key={item.id} className="team-task">
          <strong>{item.channel === 'wecom' ? '企业微信' : item.channel} · {item.senderId}</strong>
          <p>{item.chatType === 'group' ? '群聊' : '单聊'}：{item.chatId} · {new Date(item.receivedAt).toLocaleString('zh-CN')}</p>
          <p className="management-hint">消息编号：{item.msgid} · 机器人标识摘要：{item.accountTag}</p>
          <p>{item.state === 'pending' ? (item.busy ? '已接收，排队等待处理。' : '尚未开始；原消息重投时可恢复，请先核对。')
            : item.state === 'processing' || item.state === 'replying' ? '正在处理或等待回复回执。'
              : item.state === 'unknown' ? '执行或回复结果未知，请先核查。' : '原消息已有记录，不能据此认定委托完成。'}</p>
          {item.conflict && <p className="team-blocked">同一消息编号的内容或身份不一致，或旧记录已过期无法比对；未执行这次投递。</p>}
          <p className="management-hint">回复：{item.reply === 'accepted' ? '服务已接受，不代表已读' : item.reply === 'not-sent' ? '未发送' : item.reply === 'sending' ? '等待回执' : '结果未知'}</p>
          <button type="button" className="management-button" disabled={pending || !!error || item.busy || item.state === 'processing' || item.state === 'replying'}
            onClick={() => void run('ack-channel-inbound', { id: item.id, expectedRevision: item.revision })}>核查渠道消息…</button>
        </li>)}</ul>
      </section>}
      <ul className="team-list" aria-label="成员列表">
        {state.members.map(member => <li key={member.profile.assistantId} className="team-task member-card">
          <div className="member-heading"><strong>{member.profile.displayName}</strong><span>{member.busy ? '忙碌中' : member.profile.enabled ? '可用' : '已停用'}</span></div>
          <p>{member.profile.description || '未填写描述'}</p>
          <p className="management-hint">已绑定能力：{member.profile.capabilities.map(item => MEMBER_CAPABILITY_LABELS[item]).join('、') || '无（仅提示词）'}</p>
          <p className="management-hint">模型：{member.profile.model ? `${member.profile.provider} / ${member.profile.model}` : '跟随主默认'}</p>
          <Usage label="日用量" used={member.quota.dailyUsed} reserved={member.quota.dailyReserved} limit={member.quota.dailyTokenLimit} />
          <Usage label="总用量" used={member.quota.totalUsed} reserved={member.quota.totalReserved} limit={member.quota.totalTokenLimit} />
          <p className="management-hint">阈值 {member.quota.thresholdPercent}% · 计量日 {member.quota.day} · 额度版本 {member.quota.revision}</p>
          <p className="management-hint">软限额：按已用量加在途预留停线，单次请求仍可能超出上限；不是计费硬封顶。</p>
          {(member.quota.unknown || (member.quota.blocked && member.profile.enabled)) && <p className="team-blocked">{member.quota.unknown ? '用量未知，请核对后处理申请。' : '已到额度停线，需处理申请。'}</p>}
          <p className="member-session">独立会话：{member.profile.sessionId || '尚未创建；首次执行时由宿主创建'}</p>
          <p className="management-hint">成员标识：{member.profile.assistantId} · 配置版本 {member.profile.revision}</p>
          <div className="member-actions">
            <button type="button" className="management-button" disabled={pending || member.busy || !!error} onClick={() => { setMemoryId(null); void openEditor(member.profile.assistantId) }}>编辑成员</button>
            <button type="button" className="management-button" disabled={pending || !!error} onClick={() => setMemoryId(memoryId === member.profile.assistantId ? null : member.profile.assistantId)}>{memoryId === member.profile.assistantId ? '收起记忆' : '独立记忆'}</button>
            <button type="button" className="management-button danger" disabled={pending || member.busy || !!error} onClick={() => {
              if (memoryId === member.profile.assistantId) setMemoryId(null)
              void run('delete', { id: member.profile.assistantId, expectedRevision: member.profile.revision })
            }}>删除成员…</button>
          </div>
          <QuotaReset member={member} pending={pending || !!error} run={run} />
          {member.busy && <p className="management-hint">成员忙碌时不能编辑或重置额度。</p>}
        </li>)}
      </ul>
      {!state.members.length && <p className="management-hint">还没有成员。点“添加自定义成员”，用一句话描述它负责什么即可；只有职责提示词也能创建。</p>}
      {selected && <MemberMemories key={selected.profile.assistantId} member={selected} pending={pending} run={run} />}
    </>}
  </section>
}
function Usage({ label, used, reserved, limit }: { label: string; used: number; reserved: number; limit: number }) {
  const consumed = used + reserved
  return <label className="member-usage"><span>{label}：{used.toLocaleString('zh-CN')}
    {reserved > 0 ? ` + ${reserved.toLocaleString('zh-CN')} 预留` : ''} / {limitLabel(limit)}</span>
    {limit > 0 ? <progress aria-label={label} max={limit} value={Math.min(consumed, limit)} /> : <span className="management-hint">无上限，不显示百分比</span>}</label>
}
function QuotaReset({ member, pending, run }: { member: MemberView; pending: boolean; run: Run }) {
  const [scope, setScope] = useState<QuotaResetScope>('daily')
  return <fieldset className="member-actions member-fieldset" disabled={pending || member.busy}>
    <legend>重置已累计用量（不修改上限）</legend>
    <select aria-label={`${member.profile.displayName}的重置范围`} value={scope} onChange={event => setScope(event.target.value as QuotaResetScope)}>
      {Object.entries(resetLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select>
    <button type="button" className="management-button" onClick={() => void run('reset-quota', { id: member.profile.assistantId, expectedQuotaRevision: member.quota.revision, scope })}>重置用量…</button>
  </fieldset>
}

function QuotaRequestCard({ request, member, pending, run }: { request: MemberQuotaRequest; member?: MemberView; pending: boolean; run: Run }) {
  const [daily, setDaily] = useState(''), [total, setTotal] = useState(''), [reset, setReset] = useState('')
  const [error, setError] = useState('')
  async function decide(decision: 'approve' | 'reject') {
    if (!member || pending || member.busy) return
    const change: QuotaChange = {}
    if (decision === 'approve') {
      for (const [value, key] of [[daily, 'dailyTokenLimit'], [total, 'totalTokenLimit']] as const) {
        if (!value.trim()) continue
        const n = Number(value)
        if (!Number.isSafeInteger(n) || n < 0) { setError('新上限必须是非负整数；0 表示不限。'); return }
        if (member.quota[key] === 0 || (n !== 0 && n <= member.quota[key])) { setError('加额需大于当前上限（或填 0 设为不限），否则请选择重置。'); return }
        change[key] = n
      }
      if (reset) change.reset = reset as QuotaResetScope
      if (!Object.keys(change).length) { setError('批准前请明确填写新上限或选择重置范围。'); return }
    }
    setError('')
    const result = await run('decide-request', { requestId: request.requestId, expectedQuotaRevision: member.quota.revision, decision, ...(decision === 'approve' ? { change } : {}) })
    if (!result.ok) setError(result.error.message)
  }
  return <form className="team-proposal member-request" onSubmit={e => { e.preventDefault(); void decide('approve') }}>
    <strong>{member?.profile.displayName ?? request.assistantId} · 额度申请</strong>
    <p>{request.reason}</p><p className="management-hint">申请 {request.requestId} · {new Date(request.createdAt).toLocaleString('zh-CN')} · 申请时额度版本 {request.quotaRevision}</p>
    {member && <p className="management-hint">当前日上限 {limitLabel(member.quota.dailyTokenLimit)} / 总上限 {limitLabel(member.quota.totalTokenLimit)} · 当前额度版本 {member.quota.revision}</p>}
    {error && <p className="assistant-settings-error" role="alert">{error}</p>}
    <fieldset className="assistant-settings-fields" disabled={pending || !member || member.busy}>
      <legend className="assistant-settings-legend">申请处理方式</legend>
      <div className="member-grid">
        <label className="assistant-settings-field">新日上限（留空不改）<input type="number" min={0} step={1} value={daily} onChange={e => setDaily(e.target.value)} /></label>
        <label className="assistant-settings-field">新总上限（留空不改）<input type="number" min={0} step={1} value={total} onChange={e => setTotal(e.target.value)} /></label>
      </div>
      <label className="assistant-settings-field">重置用量<select value={reset} onChange={e => setReset(e.target.value)}><option value="">不重置</option>{Object.entries(resetLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <div className="member-actions"><button className="management-button" type="submit">核对加额 / 重置并批准…</button><button className="management-button" type="button" onClick={() => void decide('reject')}>拒绝申请</button></div>
    </fieldset>
    {member?.busy && <p className="management-hint">成员忙碌中，暂不能处理额度。</p>}
  </form>
}
function MemberMemories({ member, pending, run }: { member: MemberView; pending: boolean; run: Run }) {
  const id = member.profile.assistantId
  const [records, setRecords] = useState<MemoryRecord[] | null>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<MemoryRecord | 'new' | null>(null)
  const [preview, setPreview] = useState<{ record: MemoryRecord; data: MemoryDeletePreview } | null>(null)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const token = ++generation.current
    setReading(true)
    try {
      const result = await window.petApi.memberMemories(id)
      if (token !== generation.current) return
      if (!result.ok) setError(result.error.message)
      else if (result.data) { setRecords(result.data.records); setError(''); setPreview(null) }
      else setError('记忆回包不完整，请刷新。')
    } catch { if (token === generation.current) setError('记忆读取失败，请刷新。') }
    finally { if (token === generation.current) setReading(false) }
  }, [id])
  useEffect(() => { void refresh(); return () => { generation.current++ } }, [refresh])
  async function command<A extends MemberAction>(action: A, input: MemberCommandInputs[A]) {
    const result = await run(action, input)
    if (!result.ok) setError(result.error.message)
    else { setError(''); if (action !== 'memory-delete-preview') await refresh() }
    return result
  }
  return <section className="member-memories" aria-label={`${member.profile.displayName}的独立记忆`}>
    <h4>{member.profile.displayName} · 独立记忆</h4>
    <p className="management-hint">仅这个成员的记忆。范围由宿主绑定，不能填写其他成员、范围或身份。</p>
    <p className="member-session">当前独立会话：{member.profile.sessionId || '尚未创建'}</p>
    <p className="management-hint">删除前先展示影响，再原生确认。已发送给模型的历史无法追回；后端用新会话隔离后续上下文。</p>
    {error && <p role="alert" className="assistant-settings-error">{error}</p>}
    <div className="member-actions"><button type="button" className="management-button" disabled={pending || reading} onClick={() => void refresh()}>刷新记忆</button>
      <button type="button" className="management-button" disabled={pending || reading || !!editing || records === null} onClick={() => { setEditing('new'); setPreview(null) }}>本人新增记忆…</button></div>
    {editing && <MemoryEditor key={editing === 'new' ? 'new' : `${editing.id}-${editing.revision}`} id={id} initial={editing === 'new' ? null : editing}
      pending={pending || reading} run={command} onClose={() => setEditing(null)} />}
    {reading && <p role="status">正在读取记忆…</p>}
    {records?.length === 0 && <p className="management-hint">这个成员还没有记忆。</p>}
    <ul className="team-list">{records?.map(memory => <li className="team-task member-memory" key={memory.id}>
      <strong>{memory.topic || '未分类'} · {memoryStatuses[memory.status]}</strong>
      <p className="member-memory-text">{memory.text}</p>
      <p className="management-hint">{kindLabels[memory.kind]} · 版本 {memory.revision} · 独立范围 {memory.scope.kind} / {memory.scope.id}</p>
      <p className="management-hint">来源引用：{memory.sourceRefs.join('、') || '无'} · 记忆标识 {memory.id}</p>
      <p className="management-hint">确认者：{memory.confirmedBy ?? '尚未确认'}</p>
      <div className="member-actions">
        <button type="button" className="management-button" disabled={pending || reading || !!editing} onClick={() => { setEditing(memory); setPreview(null) }}>修改记忆</button>
        {memory.status !== 'confirmed' && <button type="button" className="management-button" disabled={pending || reading || !!editing} onClick={() => void command('memory-confirm', { id, memoryId: memory.id, expectedRevision: memory.revision })}>本人确认…</button>}
        <button type="button" className="management-button" disabled={pending || reading || !!editing} onClick={async () => {
          setPreview(null)
          const result = await command('memory-delete-preview', { id, memoryId: memory.id, expectedRevision: memory.revision })
          if (result.ok && result.data && 'previewId' in result.data) setPreview({ record: memory, data: result.data })
        }}>预览删除影响</button>
      </div>
    </li>)}</ul>
    {preview && <div className="member-delete-preview" role="region" aria-label="删除影响预览">
      <strong>将删除：{preview.record.topic || preview.record.id}（版本 {preview.record.revision}）</strong>
      <pre>{JSON.stringify(preview.data.impact, null, 2)}</pre>
      <p>已发送给模型的历史无法追回；后端新会话隔离后续上下文。</p>
      <div className="member-actions"><button type="button" className="management-button" disabled={pending || reading} onClick={async () => {
        const value = preview
        setPreview(null)
        await command('memory-delete', { id, memoryId: value.record.id, expectedRevision: value.record.revision, previewId: value.data.previewId })
      }}>已查看影响，原生确认删除…</button><button type="button" className="management-button" disabled={pending} onClick={() => setPreview(null)}>取消删除</button></div>
    </div>}
  </section>
}
function MemoryEditor({ id, initial, pending, run, onClose }: { id: string; initial: MemoryRecord | null; pending: boolean; run: Run; onClose(): void }) {
  const [kind, setKind] = useState<MemoryKind>(initial?.kind ?? 'user_preference')
  const [topic, setTopic] = useState(initial?.topic ?? '')
  const [text, setText] = useState(initial?.text ?? '')
  const [error, setError] = useState('')
  return <form className="member-editor" onSubmit={async event => {
    event.preventDefault()
    if (pending || !text.trim()) return
    const result = initial ? await run('memory-update', { id, memoryId: initial.id, expectedRevision: initial.revision, text, topic })
      : await run('memory-create', { id, kind, topic, text })
    if (result.ok) onClose()
    else setError(`${result.error.message}${result.error.code === 'conflict' ? '请先复制草稿，取消编辑、刷新后重新打开该记忆核对。' : ''}`)
  }}>
    <h4>{initial ? `修改记忆 · 版本 ${initial.revision}` : '本人确认新增记忆'}</h4>
    {error && <p className="assistant-settings-error" role="alert">{error}</p>}
    <fieldset className="assistant-settings-fields" disabled={pending}>
      <legend className="assistant-settings-legend">记忆内容</legend>
      {!initial && <label className="assistant-settings-field">记忆类型<select value={kind} onChange={e => setKind(e.target.value as MemoryKind)}>{MEMORY_KINDS.map(item => <option key={item} value={item}>{kindLabels[item]}</option>)}</select></label>}
      <label className="assistant-settings-field">主题<input maxLength={500} value={topic} onChange={e => setTopic(e.target.value)} /></label>
      <label className="assistant-settings-field">正文<textarea required rows={5} maxLength={16000} value={text} onChange={e => setText(e.target.value)} /></label>
      <div className="member-actions"><button type="submit" className="management-button" disabled={!text.trim()}>本人核对并保存…</button><button type="button" className="management-button" onClick={onClose}>取消编辑</button></div>
    </fieldset>
  </form>
}
