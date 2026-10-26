/**
 * 客户端插件：左侧导航「个人助理」+ 面板开关。
 *
 * 所有动作都经宿主命令（/summon-pet、/assistant-on/off）执行，与服务端工具
 * 共用同一条绑定与记录链路；面板只负责入口，不另建一套通信。
 */
import { useState } from 'react'

const PANEL_ID = 'personal-assistant'

interface ClientContext {
  slots: {
    inject(name: string, callback: () => () => void): unknown
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  uiSession?: { current?: { getSnapshot(): { key?: string } | undefined } }
  remote?: {
    commands?: {
      execute(sessionId: string, line: string, attachments?: unknown[]): Promise<{
        ok: boolean
        value?: { result?: { kind?: string; text?: string } }
        error?: { message?: string }
      }>
    }
  }
}

/**
 * cordis 服务依赖（服务名，不是包名）：
 * slots 提供插槽，uiSession 提供当前会话，remote.commands 执行宿主命令。
 * 包级加载顺序由 package.json 的 dsh.client.inject 负责。
 */
export const inject = ['slots', 'uiSession', 'remote', 'remote.commands']

function AssistantGlyph({ size = 18, active = false }: { size?: number; active?: boolean }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={active ? 2 : 1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M8.2 8.4V6.2a1.8 1.8 0 0 1 3.6 0v2.2M12.2 8.4V6.2a1.8 1.8 0 0 1 3.6 0v2.2" />
      <path d="M4.6 12.6c0-2.4 1.6-4.2 3.6-4.2h7.6c2 0 3.6 1.8 3.6 4.2 0 3.6-3.3 6-7.4 6s-7.4-2.4-7.4-6Z" />
      <circle cx="9.3" cy="12.2" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="12.2" r="0.9" fill="currentColor" stroke="none" />
      <path d="M10.6 15.4c.9.6 1.9.6 2.8 0" />
    </svg>
  )
}

const primaryButton = {
  border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 600,
  cursor: 'pointer', background: '#4a7dff', color: '#fff',
} as const

const secondaryButton = {
  border: '1px solid rgba(128,128,140,.35)', borderRadius: 8, padding: '9px 16px',
  fontSize: 13, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: 'inherit',
} as const

const dockButton = {
  border: '1px solid rgba(128,128,140,.32)', borderRadius: 999, padding: '3px 10px',
  fontSize: 12, lineHeight: '18px', cursor: 'pointer', background: 'transparent', color: 'inherit',
  whiteSpace: 'nowrap',
} as const

/** 会话头部右侧的「绑定会话」：只把当前会话接到桌宠，不负责启动它。 */
function BindSessionButton({ ctx }: { ctx: ClientContext }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [hint, setHint] = useState('')

  const bind = async (): Promise<void> => {
    setState('busy')
    setHint('')
    const id = (() => {
      try {
        return ctx.uiSession?.current?.getSnapshot()?.key
      } catch {
        return undefined
      }
    })()
    if (!id) {
      setState('error')
      setHint('先在左侧打开一个会话')
      return
    }
    try {
      const response = await ctx.remote?.commands?.execute(id, '/bind-pet', [])
      if (!response) {
        setState('error')
        setHint('命令通道还没就绪')
        return
      }
      if (!response.ok) {
        setState('error')
        setHint(response.error?.message ?? '绑定失败')
        return
      }
      const result = response.value?.result
      if (result?.kind === 'error') {
        setState('error')
        setHint(result.text ?? '绑定失败')
        return
      }
      setState('done')
      setHint(result?.text ?? '已绑定到当前会话')
    } catch (error) {
      setState('error')
      setHint(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <button
      type="button"
      disabled={state === 'busy'}
      title={hint || '把桌面宠物绑定到当前会话'}
      onClick={() => void bind()}
      style={dockButton}
    >
      {state === 'busy' ? '绑定中…' : state === 'done' ? '已绑定' : state === 'error' ? '绑定失败' : '绑定会话'}
    </button>
  )
}

function AssistantPanel({ ctx }: { ctx: ClientContext }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const sessionId = (): string | undefined => {
    try {
      return ctx.uiSession?.current?.getSnapshot()?.key
    } catch {
      return undefined
    }
  }

  const execute = async (line: string): Promise<{ ok: boolean; text: string }> => {
    const id = sessionId()
    if (!id) return { ok: false, text: '先在左侧打开或新建一个会话，再点这里' }
    try {
      const response = await ctx.remote?.commands?.execute(id, line, [])
      if (!response) return { ok: false, text: '命令通道还没就绪，稍后再试' }
      if (!response.ok) return { ok: false, text: response.error?.message ?? '命令没能执行' }
      const result = response.value?.result
      return { ok: result?.kind !== 'error', text: result?.text ?? '已执行' }
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) }
    }
  }

  const act = async (line: string): Promise<void> => {
    setBusy(true)
    try {
      const result = await execute(line)
      setMessage(result.text)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 620, margin: '56px auto', padding: '0 28px', color: 'inherit' }}>
      <h2 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 6px' }}>个人助理</h2>
      <p style={{ fontSize: 13, opacity: 0.65, margin: '0 0 28px', lineHeight: 1.6 }}>
        召唤桌面宠物，或开启当天的电脑活动记录。
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <button type="button" disabled={busy} onClick={() => void act('/summon-pet')} style={primaryButton}>
          召唤宠物
        </button>
        <button type="button" disabled={busy} onClick={() => void act('/assistant-on')} style={secondaryButton}>
          开启个人助理
        </button>
      </div>
      <div style={{ marginTop: 18, fontSize: 12, opacity: 0.6, minHeight: 18 }}>{message}</div>
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: '个人助理',
  }, AssistantGlyph))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, () => <AssistantPanel ctx={ctx} />))

  // 会话头部右侧的绑定入口：比输入框 dock 更靠近会话标题，且不占输入区空间。
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'bind-session',
    order: 20,
  }, () => <BindSessionButton ctx={ctx} />))
}
