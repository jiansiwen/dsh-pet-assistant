import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionCommand, SessionSnapshot } from '../session-types.js'
import { mergeEntries, mergeSession } from './session-view.js'

export function useSession() {
  const [session, setSession] = useState<SessionSnapshot | null>(null)
  const current = useRef(session)
  current.current = session
  const [error, setError] = useState('')
  const [loadingOlder, setLoadingOlder] = useState(false)
  const olderLock = useRef(false)
  const generation = useRef(0)
  const eventVersion = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++generation.current
    const version = eventVersion.current
    const result = await window.petApi.getSession()
    if (request !== generation.current) return
    if (!result.ok || !result.state) {
      setError(result.error ?? '还未连接原生会话，请在 dsh 中召唤宠物')
      return
    }
    const state = result.state
    setSession(previous => {
      if (version !== eventVersion.current && previous && previous.bindingId !== state.bindingId) return previous
      if (previous?.bindingId === state.bindingId && (previous.cursor > state.cursor ||
          (version !== eventVersion.current && previous.cursor === state.cursor))) {
        return { ...previous, entries: mergeEntries(state.entries, previous.entries) }
      }
      return state
    })
    setError('')
  }, [])

  useEffect(() => {
    const stopUpdates = window.petApi.onSessionUpdate(update => {
      eventVersion.current += 1
      setSession(previous => mergeSession(previous, update))
      setError(update.error ?? '')
    })
    const stopConnection = window.petApi.onSessionConnection(status => {
      if (status === 'connected') void refresh().catch(reason => setError(String(reason)))
      else if (status === 'disconnected') {
        generation.current += 1
        setSession(previous => previous ? { ...previous, status: 'disconnected' } : previous)
        setError('会话连接已断开，重新连接后将同步进度')
      }
    })
    void refresh().catch(reason => setError(String(reason)))
    return () => { generation.current += 1; stopUpdates(); stopConnection() }
  }, [refresh])

  const command = useCallback(async (request: SessionCommand) => {
    setError('')
    try {
      const result = await window.petApi.sessionCommand(request)
      if (current.current?.bindingId !== request.bindingId) return { ok: false, error: '绑定的会话已改变' }
      if (!result.ok) setError(result.error ?? '操作没有完成')
      if (result.state) setSession(previous => mergeSession(previous, result.state!))
      return result
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      return { ok: false, error: message }
    }
  }, [])

  const loadOlder = useCallback(async () => {
    const state = current.current
    if (!state?.hasMore || state.beforeSeq == null || olderLock.current) return
    olderLock.current = true
    setLoadingOlder(true)
    try {
      const result = await window.petApi.getSession(state.beforeSeq, state.bindingId)
      if (current.current?.bindingId !== state.bindingId) return
      if (!result.ok || !result.state) { setError(result.error ?? '历史记录加载失败'); return }
      const page = result.state
      setSession(previous => previous?.bindingId === page.bindingId ? {
        ...previous,
        entries: mergeEntries(page.entries, previous.entries),
        hasMore: page.hasMore,
        beforeSeq: page.beforeSeq,
      } : previous)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { olderLock.current = false; setLoadingOlder(false) }
  }, [])

  return { session, error, command, refresh, loadOlder, loadingOlder }
}
