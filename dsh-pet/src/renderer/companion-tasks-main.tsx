import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  BLOCKER_LABELS, CONTROL_LABELS, CYCLE_LABELS, TASK_LABELS, controlsFor, deviceTimezone, displayTime,
  localDateTimeToISO, parseInput, scheduleDescription, text,
  type CompanionCreate, type CompanionDetail, type CompanionInput, type CompanionMutation, type CompanionReply,
  type CompanionTasksApi, type CompanionTaskView, type MeetingMailAttention, type ReminderCycleView,
} from '../companion-types.ts'
import './report-workbench.css'
import './companion-tasks.css'

declare global { interface Window { readonly companionTasks?: CompanionTasksApi } }
const api = window.companionTasks
const timezone = deviceTimezone()
const offline = <T,>(): CompanionReply<T> => ({ ok: false, status: 0, data: null, code: 'unavailable', error: '任务服务未连接，请从桌面助理重新打开窗口' })
const groups = [
  { id: 'attention', title: '待你处理', hint: '等待处理或暂时受阻' },
  { id: 'active', title: '进行中', hint: '已登记、排队或执行中' },
  { id: 'review', title: '需核对', hint: '等待批准、复核或结果未知' },
  { id: 'closed', title: '已结束', hint: '完成、失败或取消，以状态为准' },
] as const
function groupOf(task: CompanionTaskView): string {
  if (['done', 'failed', 'cancelled'].includes(task.status)) return 'closed'
  if (['awaiting-approval', 'review', 'unknown'].includes(task.status) || !Object.hasOwn(TASK_LABELS, task.status)) return 'review'
  if (task.blocker || task.status === 'awaiting-user') return 'attention'
  return 'active'
}
function useTaskData(taskId: string | null) {
  const [list, setList] = useState<CompanionReply<{ tasks: CompanionTaskView[]; meetingMailAttention?: MeetingMailAttention[] }> | null>(null)
  const [detail, setDetail] = useState<CompanionReply<CompanionDetail> | null>(null)
  const [cycles, setCycles] = useState<CompanionReply<{ cycles: ReminderCycleView[] }> | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const inFlight = useRef(false)
  const refreshRef = useRef<() => void>(() => {})
  useEffect(() => {
    let active = true
    setDetail(null); setCycles(null)
    const load = async () => {
      if (inFlight.current || !active) return
      inFlight.current = true
      setRefreshing(true)
      try {
        const next = api ? await api.list() : offline<{ tasks: CompanionTaskView[] }>()
        if (!active) return
        setList(next)
        if (taskId && api) {
          const current = await api.detail(taskId)
          if (!active) return
          setDetail(current)
          if (current.ok && current.data?.task.kind === 'reminder') {
            const reminders = await api.reminders(taskId)
            if (active) setCycles(reminders)
          } else setCycles(null)
        }
      } catch {
        if (active) { setList(offline()); setDetail(offline()); setCycles(offline()) }
      } finally {
        inFlight.current = false
        if (active) setRefreshing(false)
      }
    }
    refreshRef.current = () => { void load() }
    void load()
    const timer = window.setInterval(() => { void load() }, 4000)
    const unsubscribe = api?.onChanged(() => { void load() })
    const focus = () => { void load() }
    window.addEventListener('focus', focus)
    return () => { active = false; window.clearInterval(timer); unsubscribe?.(); window.removeEventListener('focus', focus) }
  }, [taskId])
  return { list, detail, cycles, refreshing, refresh: () => refreshRef.current() }
}
function ReplyError({ reply }: { reply: CompanionReply<unknown> }) {
  const title = reply.code === 'unavailable' ? '暂不可用' : reply.code === 'unknown' ? '结果未知' : '读取失败'
  return <p className="wb-notice tone-error" role="alert">{title}：{reply.error ?? '请稍后刷新重试'}</p>
}
function App() {
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const locked = useRef(false)
  const life = useRef(0)
  const data = useTaskData(selected)
  useEffect(() => { life.current += 1; return () => { life.current += 1 } }, [])
  const run = async (action: () => Promise<CompanionReply<CompanionMutation | null>>) => {
    if (locked.current) return false
    locked.current = true
    setBusy(true); setNotice(null)
    const generation = life.current
    try {
      const reply = await action()
      if (generation !== life.current) return false
      setNotice({ error: !reply.ok && reply.code !== 'cancelled', text: !reply.ok ? reply.error ?? '操作未完成'
        : reply.approvalWindow?.ok === false ? '操作等待批准，但专用审批窗口未能打开，请从桌面助理待办中重试'
          : reply.data?.awaitingApproval || reply.approvalWindow ? '等待你在专用审批窗口核对；此窗口不能批准，尚未视为完成'
            : reply.data?.task ? `服务返回：${TASK_LABELS[reply.data.task.status] ?? '未知状态'}；请以刷新后的任务为准`
              : '服务已接收回应；请以刷新后的提醒状态为准' })
      data.refresh()
      return reply.ok
    } catch {
      if (generation === life.current) setNotice({ error: true, text: '连接中断，操作结果未知；请刷新核对，不会自动重发' })
      return false
    } finally {
      locked.current = false
      if (generation === life.current) setBusy(false)
    }
  }
  const tasks = data.list?.ok ? data.list.data?.tasks ?? [] : []
  const meetingMailAttention = data.list?.ok ? data.list.data?.meetingMailAttention ?? [] : []
  const detail = data.detail?.ok && data.detail.data?.task.taskId === selected ? data.detail.data : null
  const select = (id: string) => { setSelected(id); setCreating(false) }
  return <main className="wb ct">
    <header className="wb-head">
      <div className="wb-title"><h1>小潘 · 任务与提醒</h1><span className="ct-spacer" />
        <button className="wb-btn" disabled={data.refreshing} onClick={data.refresh}>{data.refreshing ? '正在刷新…' : '刷新状态'}</button>
        <button className="wb-btn primary" disabled={busy || !api} onClick={() => { setCreating(true); setSelected(null) }}>新建任务或提醒</button>
      </div>
      <p className="wb-hint">查看交给小潘的任务，安排桌面提醒与催办。设备时区：<span className="mono">{timezone}</span></p>
    </header>
    <p className="wb-rules">电脑关机时不触发提醒。“知道了”只回应提醒，不等于关联业务已完成。</p>
    {meetingMailAttention.length > 0 && <section className="wb-notice tone-warn" role="alert" aria-label="会议邮件提醒待核查">
      <strong>会议邮件已被服务接受，但提醒尚未登记（{meetingMailAttention.length}{meetingMailAttention.length >= 20 ? '，仅显示前20条' : ''}）</strong>
      <p>请检查助理运行状态并刷新；不要重发邮件。服务接受不代表收件或已读。</p>
      <ul>{meetingMailAttention.map(item => <li key={item.intentId}>邮件编号 {item.intentId}；接受时间 {displayTime(item.acceptedAt)}</li>)}</ul>
    </section>}
    {notice && <p className={`wb-notice ${notice.error ? 'tone-error' : 'tone-info'}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    {busy && <p className="wb-hint" role="status">正在读取最新详情、等待系统确认或提交操作，请勿重复点击。</p>}
    <div className="ct-layout">
      <section className="ct-list" aria-label="按真实状态分组的任务" aria-busy={data.refreshing}>
        {!data.list ? <p className="wb-empty" role="status">正在读取任务状态…</p>
          : !data.list.ok ? <ReplyError reply={data.list} />
            : tasks.length === 0 ? <div className="wb-empty"><h2>还没有任务</h2><p>新建一条手工待办，或设置一个桌面提醒。</p></div>
              : groups.map(group => {
                const items = tasks.filter(task => groupOf(task) === group.id)
                return <section key={group.id} className={`ct-group ct-${group.id}`} aria-labelledby={`group-${group.id}`}>
                  <header className="ct-group-head"><h2 id={`group-${group.id}`}>{group.title} <span className="mono">{items.length}</span></h2><span className="wb-hint">{group.hint}</span></header>
                  {items.length === 0 ? <p className="ct-group-empty">暂无</p> : items.map(task => <button type="button" key={task.taskId} className={`ct-task ${selected === task.taskId ? 'selected' : ''}`} aria-pressed={selected === task.taskId} onClick={() => select(task.taskId)}>
                    <span className="ct-task-heading"><strong>{task.title}</strong><span className={`chip ${task.status === 'awaiting-approval' || task.status === 'unknown' ? 'warn' : ''}`}>{TASK_LABELS[task.status] ?? `未知状态（${task.status}）`}</span></span>
                    <span className="ct-task-meta">{task.kind === 'reminder' ? '提醒' : task.kind === 'agent' ? '任务' : `其他任务（${task.kind}）`} · 第 {task.revision} 版 · {displayTime(task.updatedAt)}</span>
                    {task.blocker && <span className="ct-blocker">受阻：{BLOCKER_LABELS[task.blocker] ?? task.blocker}</span>}
                  </button>)}
                </section>
              })}
      </section>
      <aside className="ct-pane" aria-label={creating ? '新建任务或提醒' : '任务详情'}>
        {creating ? <CreateForm tasks={tasks} busy={busy} submit={draft => run(() => api!.create(draft))} />
          : !selected ? <div className="ct-placeholder"><h2>选择任务，查看详情</h2><p className="wb-hint">创建、暂停、恢复、取消和回应提醒都需要系统确认。</p></div>
            : !data.detail ? <p role="status">正在读取最新详情…</p>
              : !data.detail.ok ? <ReplyError reply={data.detail} />
                : detail && <>
                  <h2 className="ct-pane-title">{detail.task.title}</h2>
                  <dl className="ct-detail"><dt>状态</dt><dd>{TASK_LABELS[detail.task.status] ?? `未知状态（${detail.task.status}）`}</dd><dt>任务编号</dt><dd className="mono">{detail.task.taskId}</dd><dt>设备</dt><dd className="mono">{detail.task.deviceId}</dd><dt>版本</dt><dd>{detail.task.revision}</dd></dl>
                  {detail.input?.kind === 'agent' && <><p className="ct-content">{detail.input.description}</p><p className="wb-hint">手工待办，不会自动执行。</p></>}
                  {detail.input?.kind === 'reminder' && <><p className="ct-content">{detail.input.message}</p><p>{scheduleDescription(detail.input.schedule)}</p><p className="wb-hint">{detail.input.channel === 'wecom' ? '企业微信' : '桌面'}提醒；未回应时每 {detail.input.repeatEverySeconds / 60} 分钟催办；关联业务任务：{detail.input.relatedBusinessTaskId ?? '无'}。</p>
                    {!detail.task.parentTaskId && controlsFor(detail.task, detail.input).length > 0 && <IntervalForm key={`${detail.task.taskId}:${detail.input.repeatEverySeconds}`} seconds={detail.input.repeatEverySeconds} busy={busy}
                      submit={repeatEverySeconds => run(() => api!.setInterval({ taskId: detail.task.taskId, repeatEverySeconds }))} />}
                    {detail.task.parentTaskId && <button className="wb-btn" onClick={() => select(detail.task.parentTaskId!)}>查看原提醒计划与催办设置</button>}
                  </>}
                  {!detail.input && <p className="wb-notice tone-warn">服务未提供可操作的手工待办或桌面提醒内容，目前仅显示状态。</p>}
                  {detail.task.status === 'awaiting-approval' && <div className="wb-notice tone-warn"><p>等待批准，尚未执行。请在专用审批窗口核对。</p>{detail.proposalId ? <button className="wb-btn" disabled={busy} onClick={() => void run(() => api!.requestReview(detail.task.taskId))}>打开专用审批窗口</button> : <p>服务未提供提案编号，请从桌面助理待办中打开。</p>}</div>}
                  {(detail.task.status === 'unknown' || !Object.hasOwn(TASK_LABELS, detail.task.status)) && <p className="wb-notice tone-warn">结果未知，不代表成功或失败。请核对实际结果，此处不会自动重试或强行完成。</p>}
                  <div className="wb-actions">{controlsFor(detail.task, detail.input).map(action => <button className={`wb-btn ${action === 'cancel' ? 'quiet' : ''}`} key={action} disabled={busy} onClick={() => void run(() => api!.control({ taskId: detail.task.taskId, action }))}>{CONTROL_LABELS[action]}…</button>)}</div>
                  {detail.task.kind === 'reminder' && <section className="ct-cycles" aria-label="提醒回应"><h2>本轮提醒与回应</h2>
                    {!data.cycles ? <p role="status">正在读取提醒周期…</p> : !data.cycles.ok ? <ReplyError reply={data.cycles} />
                      : data.cycles.data?.cycles.length === 0 ? <p className="wb-hint">服务尚未返回提醒周期；不代表已经投递。</p>
                        : data.cycles.data?.cycles.map(cycle => <Cycle key={cycle.cycleId} cycle={cycle} task={detail.task} disabled={busy || !detail.input || !['created', 'queued', 'running', 'awaiting-user'].includes(detail.task.status)} respond={(action, until) => run(() => api!.respond({ taskId: detail.task.taskId, cycleId: cycle.cycleId, action, snoozedUntil: until }))} />)}
                  </section>}
                </>}
      </aside>
    </div>
  </main>
}
function IntervalForm({ seconds, busy, submit }: { seconds: number; busy: boolean; submit(seconds: number): Promise<boolean> }) {
  const [minutes, setMinutes] = useState(String(seconds / 60))
  return <form className="ct-form" onSubmit={event => { event.preventDefault(); void submit(Number(minutes) * 60) }}>
    <label>本条提醒的催办间隔（分钟）<input aria-label="本条催办间隔（分钟）" type="number" min="1" max="10080" step="any" required value={minutes} disabled={busy} onChange={event => setMinutes(event.target.value)} /></label>
    <button className="wb-btn" disabled={busy || !Number.isSafeInteger(Number(minutes) * 60) || Number(minutes) < 1 || Number(minutes) > 10080}>修改本条间隔…</button>
    <p className="wb-hint">不改变首次提醒时间，也不会恢复已暂停的计划。</p>
  </form>
}
function CreateForm({ tasks, busy, submit }: { tasks: CompanionTaskView[]; busy: boolean; submit(draft: CompanionCreate): Promise<boolean> }) {
  const [kind, setKind] = useState<'agent' | 'reminder'>('agent')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [schedule, setSchedule] = useState<'once' | 'interval' | 'daily'>('once')
  const [when, setWhen] = useState('')
  const [daily, setDaily] = useState('')
  const [interval, setInterval] = useState('3600')
  const [repeat, setRepeat] = useState('')
  const [defaultError, setDefaultError] = useState('')
  useEffect(() => {
    let active = true
    void (api ? api.defaults() : Promise.resolve(offline<{ repeatEverySeconds: number }>())).then(reply => {
      if (!active) return
      if (reply.ok && reply.data) setRepeat(previous => previous || String(reply.data!.repeatEverySeconds / 60))
      else setDefaultError(reply.error ?? '默认催办间隔读取失败，请手动填写')
    }).catch(() => { if (active) setDefaultError('默认催办间隔读取失败，请手动填写') })
    return () => { active = false }
  }, [])
  const [related, setRelated] = useState('')
  const [error, setError] = useState('')
  const errorRef = useRef<HTMLParagraphElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => { titleRef.current?.focus() }, [])
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])
  return <form className="ct-form" noValidate onSubmit={event => {
    event.preventDefault()
    if (busy) return
    setError('')
    try {
      const input: CompanionInput = kind === 'agent' ? { kind, executionMode: 'manual', description: content }
        : { kind, message: content, channel: 'desktop', relatedBusinessTaskId: related || null, repeatEverySeconds: Number(repeat) * 60,
          schedule: schedule === 'daily' ? { kind: 'daily', timezone, localTime: daily }
            : schedule === 'once' ? { kind: 'once', timezone, runAt: localDateTimeToISO(when) }
              : { kind: 'interval', timezone, runAt: localDateTimeToISO(when), everySeconds: Number(interval) } }
      const draft = { title: text(title, 500, '标题'), input: parseInput(input, true) }
      void submit(draft)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '请核对输入') }
  }}>
    <h2 className="ct-pane-title">新建任务或提醒</h2>
    <fieldset disabled={busy} aria-describedby={error ? 'create-error' : 'create-help'}>
      <label>类型<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="agent">手工待办</option><option value="reminder">桌面提醒</option></select></label>
      <label>标题<input ref={titleRef} required maxLength={500} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>{kind === 'agent' ? '任务内容' : '提醒内容'}<textarea required rows={4} maxLength={kind === 'agent' ? 8000 : 2000} value={content} onChange={event => setContent(event.target.value)} /></label>
      {kind === 'reminder' && <>
        <label>提醒计划<select value={schedule} onChange={event => setSchedule(event.target.value as typeof schedule)}><option value="once">只提醒一次</option><option value="interval">按固定间隔提醒</option><option value="daily">每天固定时刻</option></select></label>
        {schedule === 'daily' ? <label>每天提醒时刻（{timezone}）<input type="time" required value={daily} onChange={event => setDaily(event.target.value)} /></label>
          : <label>{schedule === 'once' ? '提醒时间' : '首次提醒时间'}（{timezone}）<input type="datetime-local" required value={when} onChange={event => setWhen(event.target.value)} /></label>}
        {schedule === 'interval' && <label>触发间隔（秒，60–31536000）<input type="number" min="60" max="31536000" step="1" required value={interval} onChange={event => setInterval(event.target.value)} /></label>}
        <label>未回应时催办间隔（分钟，1–10080）<input type="number" min="1" max="10080" step="any" required value={repeat} onChange={event => setRepeat(event.target.value)} /></label>
        {defaultError && <p className="wb-notice tone-error" role="alert">{defaultError}</p>}
        <p className="wb-hint">默认值来自宠物设置；修改这里只影响这条提醒。</p>
        <label>关联业务任务（可不选）<select value={related} onChange={event => setRelated(event.target.value)}><option value="">不关联</option>{tasks.filter(task => task.kind !== 'reminder').map(task => <option key={task.taskId} value={task.taskId}>{task.title} · {TASK_LABELS[task.status] ?? '未知状态'}</option>)}</select></label>
      </>}
    </fieldset>
    <p id="create-help" className="wb-hint">{kind === 'agent' ? '手工待办只登记内容，不会自动替你执行。' : '设备本地时间会转换为带时区的时间；每天提醒从下一个该时刻开始。'}提交后请在系统确认框核对完整内容。</p>
    {error && <p id="create-error" ref={errorRef} tabIndex={-1} className="wb-notice tone-error" role="alert">{error}</p>}
    <button className="wb-btn primary wide" disabled={busy || !api} type="submit">{busy ? '等待确认或提交…' : kind === 'agent' ? '创建手工待办…' : '创建桌面提醒…'}</button>
  </form>
}
function Cycle({ cycle, task, disabled, respond }: {
  cycle: ReminderCycleView; task: CompanionTaskView; disabled: boolean
  respond(action: 'ack' | 'snooze' | 'cancel', until: string | null): Promise<boolean>
}) {
  const [until, setUntil] = useState('')
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const revisionMissing = cycle.taskRevision === null || cycle.taskRevision !== task.revision
  const actionable = ['awaiting-response', 'snoozed'].includes(cycle.state)
  return <article className="ct-cycle"><h3>{cycle.title}</h3><span className="chip">{CYCLE_LABELS[cycle.state] ?? `未知状态（${cycle.state}）`}</span>
    <p className="wb-hint">下一次催办：{cycle.nextNagAt ? displayTime(cycle.nextNagAt) : '服务未提供'}；提醒版本：{cycle.revision}</p>
    {revisionMissing && <p className="wb-notice tone-warn">任务版本缺失或不一致，暂不能回应，请刷新。</p>}
    {actionable && <><div className="wb-actions"><button className="wb-btn" disabled={disabled || revisionMissing} onClick={() => void respond('ack', null)}>知道了…</button><button className="wb-btn quiet" disabled={disabled || revisionMissing} onClick={() => void respond('cancel', null)}>取消本轮提醒…</button></div>
      <form className="ct-form ct-snooze" noValidate onSubmit={event => { event.preventDefault(); if (disabled || revisionMissing) return; try { const iso = localDateTimeToISO(until); setError(''); void respond('snooze', iso) } catch (cause) { setError(cause instanceof Error ? cause.message : '请选择未来时间'); inputRef.current?.focus() } }}>
        <label>延后至（{timezone}）<input ref={inputRef} type="datetime-local" required value={until} aria-invalid={!!error} aria-describedby={error ? `error-${cycle.cycleId}` : undefined} disabled={disabled || revisionMissing} onChange={event => { setUntil(event.target.value); setError('') }} /></label>
        {error && <p className="ct-field-error" id={`error-${cycle.cycleId}`} role="alert">{error}</p>}
        <button className="wb-btn" disabled={disabled || revisionMissing} type="submit">延后提醒…</button>
      </form></>}
  </article>
}
createRoot(document.getElementById('root')!).render(<App />)
