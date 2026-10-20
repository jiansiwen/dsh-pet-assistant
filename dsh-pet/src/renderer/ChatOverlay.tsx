import { memo, useEffect, useRef, useState } from 'react'
import type { CancelReceipt, SessionCommand, SessionEntry, SessionSnapshot } from '../session-types.js'
import type { TeamStageHandle } from './TeamStage.js'
import { PET_WIDTH } from './pet-metrics.js'
import { registerPanelHitbox } from './stage-layout.js'
import { entriesForPresentation, overlayPosition } from './session-view.js'

interface Props {
  session: SessionSnapshot | null
  error: string
  stageRef: React.MutableRefObject<TeamStageHandle | null>
  inputRef: React.MutableRefObject<HTMLTextAreaElement | null>
  input: string
  setInput(value: string): void
  onSend(): void
  onClose(): void
  onCommand(command: SessionCommand): Promise<{ ok: boolean; notice?: string; receipt?: CancelReceipt }>
  onListen(): void
  listening: boolean
  sending: boolean
  speaking: boolean
  onStopSpeech(): void
  /** 唤醒后的有界连续对话是否进行中；只是投影，轮次真值在 App 的状态机里。 */
  continuous?: boolean
  onEndContinuous?(): void
  /** 会话未开启时给出的明确入口；开启本身由主进程按插件 /session/start 完成。 */
  onStartSession?(): void
  loadingOlder: boolean
  loadOlder(): Promise<void>
  /**
   * 演示隐私模式（M5-05）：只显示 `seq` 大于这个值的条目，之前的当作不存在。
   *
   * 用 `seq` 而不是数组下标：往上翻历史会在数组**前面**插入条目，按下标记分界会错位，
   * 把用户以为藏起来的旧消息又露出来。`seq` 单调递增，插入多少条都不影响分界。
   *
   * null = 不隐藏。分界是"开启演示模式那一刻的最大 seq"，不是"当前最大 seq"——
   * 演示期间新产生的消息照常可见，用户正在演示它们。
   */
  readonly hiddenThroughSeq?: number | null
}

/** 停止按钮的语义提示：两种停止分开写清楚，界面不替用户猜它会停掉谁。 */
const STOP_HINT = '停止生成：\n'
  + '· 宠物发起、尚未结束的请求：只定向取消这些请求——还在队列里的撤回（未执行）；已交给共享会话的只停止等待，'
  + '后台是否停止未知，不会停掉网页里正在执行的其他请求，也不会自动重发；点名成员的团队任务会被定向终止。\n'
  + '· 没有宠物请求时（网页或原生队列发起的轮次）：与网页里的停止按钮相同，停止原生会话当前轮次。'

const Entry = memo(function Entry({ entry }: { entry: SessionEntry }) {
  if (entry.kind !== 'text') return (
    <details className={`hud-process hud-process-${entry.kind}`}>
      <summary><span className="hud-process-mark" aria-hidden>{entry.kind === 'think' ? '◇' : '›'}</span>
        <span>{entry.kind === 'think' ? '思考' : entry.name || '工具调用'}</span>
        <span className="hud-process-preview">{entry.text || entry.status}</span>
      </summary>
      <pre>{entry.text}</pre>
      {entry.result && <pre className="hud-tool-result">{entry.result}</pre>}
    </details>
  )
  return <div className={`hud-message hud-message-${entry.role}${entry.streaming ? ' is-streaming' : ''}`}>
    {entry.text}
  </div>
})

export default function ChatOverlay(props: Props) {
  const { session, stageRef, inputRef, input, setInput, onSend, onClose, onCommand, error } = props
  const panel = useRef<HTMLDivElement | null>(null)
  const list = useRef<HTMLDivElement | null>(null)
  const followBottom = useRef(true)
  const [changing, setChanging] = useState(false)
  const [showLatest, setShowLatest] = useState(false)
  /** 最近一次「停止生成」的回执：state 为 null 表示原生 cancel（没有定向回执）。 */
  const [stopNote, setStopNote] = useState<{ state: CancelReceipt['state'] | null; text: string } | null>(null)
  const running = session?.status === 'running' || session?.status === 'waiting'

  useEffect(() => {
    const element = panel.current
    if (!element) return
    const place = () => {
      const anchor = stageRef.current?.anchorPosition()
      if (!anchor) return
      const position = overlayPosition(anchor.x, anchor.y, element.offsetWidth, element.offsetHeight, PET_WIDTH)
      element.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`
      const rect = element.getBoundingClientRect()
      const box = { x1: Math.max(0, rect.left), y1: Math.max(0, rect.top), x2: Math.min(innerWidth, rect.right), y2: Math.min(innerHeight, rect.bottom) }
      registerPanelHitbox(box.x2 > box.x1 && box.y2 > box.y1 ? box : null)
    }
    place()
    const stop = stageRef.current?.subscribeAnchor(place)
    const observer = new ResizeObserver(place)
    observer.observe(element)
    window.addEventListener('resize', place)
    return () => { stop?.(); observer.disconnect(); window.removeEventListener('resize', place); registerPanelHitbox(null) }
  }, [stageRef])

  useEffect(() => {
    const element = list.current
    if (element && followBottom.current) element.scrollTop = element.scrollHeight
  }, [session?.entries])

  const older = async () => {
    const element = list.current
    const height = element?.scrollHeight ?? 0
    const top = element?.scrollTop ?? 0
    followBottom.current = false
    await props.loadOlder()
    requestAnimationFrame(() => {
      if (element) element.scrollTop = top + element.scrollHeight - height
    })
  }
  const choose = async (command: SessionCommand) => {
    setChanging(true)
    try { await onCommand(command) } finally { setChanging(false) }
  }
  /**
   * 停止生成：回执如实显示在会话框里一行。宠物发起的请求由主进程定向取消（排队中撤回为未执行、
   * 已交给共享会话的只停止等待并报结果未知）；没有宠物请求时才是原生 cancel，回执就是原生操作结果。
   */
  const stop = async () => {
    if (!session) return
    setChanging(true)
    setStopNote(null)
    try {
      const result = await onCommand({ kind: 'cancel', bindingId: session.bindingId })
      if (result.receipt || result.notice) setStopNote({ state: result.receipt?.state ?? null, text: result.notice ?? result.receipt!.message })
      else if (result.ok) setStopNote({ state: null, text: '已请求停止原生会话当前轮次；以会话状态为准' })
    } finally { setChanging(false) }
  }
  useEffect(() => {
    if (!stopNote) return
    const timer = window.setTimeout(() => setStopNote(null), 20_000)
    return () => window.clearTimeout(timer)
  }, [stopNote])
  const status = session?.status === 'disconnected' ? '连接已断开' : session?.status === 'waiting' ? '等待处理'
    : running ? '正在回复' : session?.sessionId ? '会话已同步' : '尚未连接'
  const models = session?.models ?? []
  const currentModel = session?.model
  const modelKey = (model: { provider: string; model: string }) => JSON.stringify([model.provider, model.model])
  const choices = currentModel && !models.some(model => modelKey(model) === modelKey(currentModel)) ? [currentModel, ...models] : models
  // 演示隐私模式：分界之前的一律不渲染（数据还在，只是不显示；关掉就原样回来）。
  const { visible: visibleEntries, hidden: hiddenCount } = entriesForPresentation(session?.entries ?? [], props.hiddenThroughSeq ?? null)

  return (
    <section ref={panel} className="chat-hud" data-interactive aria-label="宠物会话">
      <header className="hud-header">
        <span className={`hud-indicator${running ? ' active' : ''}`} aria-hidden />
        <span className="hud-title" title={session?.title}>{session?.title || '原生 dsh 会话'}</span>
        <span className="hud-status" role="status">{status}</span>
        <button type="button" className="hud-icon" onClick={onClose} aria-label="收起会话">×</button>
      </header>
      <div className="hud-messages" ref={list} onScroll={event => {
        const element = event.currentTarget
        followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
        setShowLatest(!followBottom.current)
      }}>
        {/* 演示模式下不给"查看更早的消息"：那等于一个一键揭开历史的入口。 */}
        {session?.hasMore && props.hiddenThroughSeq == null && <button type="button" className="hud-history" onClick={() => void older()} disabled={props.loadingOlder}>
          {props.loadingOlder ? '正在加载…' : '查看更早的消息'}
        </button>}
        {/* 演示模式下明说"藏了几条"，但不给"展开"按钮：演示时不该有一键揭开的入口。 */}
        {hiddenCount > 0 && <div className="hud-history hud-presentation-note" role="status">
          演示隐私模式：已隐藏 {hiddenCount} 条此前的内容
        </div>}
        {!visibleEntries.length && <div className="hud-empty">
          <span>{hiddenCount > 0 ? '历史已隐藏' : '和宠物聊聊'}</span>
          <p>{hiddenCount > 0 ? '关闭演示隐私模式后恢复显示。' : session?.sessionId ? '这里与原生 dsh 共享同一段会话。' : '在 dsh 会话中召唤宠物，即可在这里继续对话。'}</p>
        </div>}
        {visibleEntries.map(entry => <Entry key={entry.id} entry={entry} />)}
      </div>
      {showLatest && <button className="hud-latest" onClick={() => {
        followBottom.current = true
        if (list.current) list.current.scrollTop = list.current.scrollHeight
        setShowLatest(false)
      }}>回到最新消息 ↓</button>}
      {error && <div className="hud-error" role="alert">{error}</div>}
      {stopNote && <div className={`hud-speech hud-cancel-receipt${stopNote.state ? ` cancel-${stopNote.state}` : ''}`} role="status">
        停止结果：{stopNote.text}
      </div>}
      {!session?.capabilities.prompt && props.onStartSession && <div className="hud-speech" role="status">助理会话未开启 <button disabled={props.sending} onClick={props.onStartSession}>开启助理会话</button></div>}
      {props.speaking && <div className="hud-speech">正在朗读 <button onClick={props.onStopSpeech}>停止朗读</button></div>}
      {props.continuous && <div className="hud-speech" role="status">连续对话中，说“先这样”也可结束 <button onClick={props.onEndContinuous}>结束连续对话</button></div>}
      <div className="hud-composer">
        <textarea ref={inputRef} value={input} onChange={event => setInput(event.target.value)} rows={2}
          aria-label="会话输入" placeholder={props.listening ? '正在聆听…' : '输入消息，Enter 发送'}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault()
              onSend()
            }
          }} />
        <div className="hud-toolbar">
          <button type="button" className={`hud-icon${props.listening ? ' recording' : ''}`} onClick={props.onListen}
            disabled={props.sending} aria-label={props.listening ? '结束语音输入' : '语音输入'} title="语音输入">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
              <rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3M9 21h6"/>
            </svg>
          </button>
          <select aria-label="会话权限" title="会话权限" value={session?.permission ?? ''}
            disabled={changing || !session?.capabilities.permissions} onChange={event => {
              if (session) void choose({ kind: 'permission', bindingId: session.bindingId, value: event.target.value })
            }}>
            {!session?.permission && <option value="">权限不可用</option>}
            {session?.permissions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select className="hud-model" aria-label="会话模型" title="与原生 dsh 一致：切换对后续请求生效，并保存为默认模型" value={currentModel ? modelKey(currentModel) : ''}
            disabled={changing || !session?.capabilities.models} onChange={event => {
              const chosen = choices.find(model => modelKey(model) === event.target.value)
              if (chosen && session) void choose({ kind: 'model', bindingId: session.bindingId,
                provider: chosen.provider, model: chosen.model, reasoningEffort: chosen.reasoningEffort })
            }}>
            {!currentModel && <option value="">模型不可用</option>}
            {choices.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.label || model.model}</option>)}
          </select>
          {running && <button type="button" className="hud-send" aria-label="停止生成"
            title={STOP_HINT}
            disabled={!session?.capabilities.cancel || changing} onClick={() => void stop()}>■</button>}
          {(!running || input.trim()) && <button type="button" className="hud-send" aria-label={running ? '加入消息队列' : '发送消息'}
            disabled={props.sending || !input.trim() || !session?.capabilities.prompt} onClick={onSend}>↑</button>}
        </div>
      </div>
      <span className="hud-anchor" aria-hidden />
    </section>
  )
}
