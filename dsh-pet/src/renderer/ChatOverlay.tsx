import { memo, useEffect, useRef, useState } from 'react'
import type { SessionCommand, SessionEntry, SessionSnapshot } from '../session-types.js'
import type { TeamStageHandle } from './TeamStage.js'
import { PET_WIDTH } from './pet-metrics.js'
import { registerPanelHitbox } from './stage-layout.js'
import { overlayPosition } from './session-view.js'

interface Props {
  session: SessionSnapshot | null
  error: string
  stageRef: React.MutableRefObject<TeamStageHandle | null>
  inputRef: React.MutableRefObject<HTMLTextAreaElement | null>
  input: string
  setInput(value: string): void
  onSend(): void
  onClose(): void
  onCommand(command: SessionCommand): Promise<{ ok: boolean }>
  onListen(): void
  listening: boolean
  sending: boolean
  speaking: boolean
  onStopSpeech(): void
  loadingOlder: boolean
  loadOlder(): Promise<void>
}

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
  const status = session?.status === 'disconnected' ? '连接已断开' : session?.status === 'waiting' ? '等待处理'
    : running ? '正在回复' : session?.sessionId ? '会话已同步' : '尚未连接'
  const models = session?.models ?? []
  const currentModel = session?.model
  const modelKey = (model: { provider: string; model: string }) => JSON.stringify([model.provider, model.model])
  const choices = currentModel && !models.some(model => modelKey(model) === modelKey(currentModel)) ? [currentModel, ...models] : models

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
        {session?.hasMore && <button type="button" className="hud-history" onClick={() => void older()} disabled={props.loadingOlder}>
          {props.loadingOlder ? '正在加载…' : '查看更早的消息'}
        </button>}
        {!session?.entries.length && <div className="hud-empty">
          <span>和宠物聊聊</span>
          <p>{session?.sessionId ? '这里与原生 dsh 共享同一段会话。' : '在 dsh 会话中召唤宠物，即可在这里继续对话。'}</p>
        </div>}
        {session?.entries.map(entry => <Entry key={entry.id} entry={entry} />)}
      </div>
      {showLatest && <button className="hud-latest" onClick={() => {
        followBottom.current = true
        if (list.current) list.current.scrollTop = list.current.scrollHeight
        setShowLatest(false)
      }}>回到最新消息 ↓</button>}
      {error && <div className="hud-error" role="alert">{error}</div>}
      {props.speaking && <div className="hud-speech">正在朗读 <button onClick={props.onStopSpeech}>停止朗读</button></div>}
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
            disabled={!session?.capabilities.cancel || changing} onClick={() => {
              if (session) void choose({ kind: 'cancel', bindingId: session.bindingId })
            }}>■</button>}
          {(!running || input.trim()) && <button type="button" className="hud-send" aria-label={running ? '加入消息队列' : '发送消息'}
            disabled={props.sending || !input.trim() || !session?.capabilities.prompt} onClick={onSend}>↑</button>}
        </div>
      </div>
      <span className="hud-anchor" aria-hidden />
    </section>
  )
}
