import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionCommand, SessionSnapshot } from '../session-types.js'
import { mergeEntries, mergeSession } from './session-view.js'

export function useSession() {
  const [session, setSession] = useState<SessionSnapshot | null>(null)
  const current = useRef(session)
  current.current = session
  // 事件回调先于 React 重渲染；异步操作须立即看到最新绑定。
  const binding = useRef<string | null>(null)
  const [error, setError] = useState('')
  const [loadingOlder, setLoadingOlder] = useState(false)
  const olderLock = useRef(false)
  const generation = useRef(0)
  const eventVersion = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++generation.current
    const version = eventVersion.current
    let result: Awaited<ReturnType<typeof window.petApi.getSession>>
    try { result = await window.petApi.getSession() }
    catch (reason) {
      if (request === generation.current && version === eventVersion.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
      return
    }
    if (request !== generation.current) return
    if (!result.ok || !result.state) {
      if (version === eventVersion.current) setError(result.error ?? '助理会话尚未开启：发一条消息或说“开启个人助理模式”即可开启')
      return
    }
    const state = result.state
    if (version === eventVersion.current) binding.current = state.bindingId
    setSession(previous => {
      if (version !== eventVersion.current && previous && previous.bindingId !== state.bindingId) return previous
      if (previous?.bindingId === state.bindingId && (previous.cursor > state.cursor ||
          (version !== eventVersion.current && previous.cursor === state.cursor))) {
        return { ...previous, entries: mergeEntries(state.entries, previous.entries) }
      }
      return state
    })
    if (version === eventVersion.current) setError(state.error ?? '')
  }, [])

  useEffect(() => {
    const stopUpdates = window.petApi.onSessionUpdate(update => {
      eventVersion.current += 1
      binding.current = update.bindingId
      setSession(previous => mergeSession(previous, update))
      setError(update.error ?? '')
    })
    const stopConnection = window.petApi.onSessionConnection(status => {
      if (status === 'connected') void refresh().catch(reason => setError(String(reason)))
      else if (status === 'disconnected') {
        generation.current += 1
        binding.current = null
        setSession(previous => previous ? { ...previous, status: 'disconnected' } : previous)
        setError('会话连接已断开，重新连接后将同步进度')
      }
    })
    void refresh().catch(reason => setError(String(reason)))
    return () => { generation.current += 1; stopUpdates(); stopConnection() }
  }, [refresh])

  const command = useCallback(async (request: SessionCommand) => {
    if (binding.current !== request.bindingId) return { ok: false, error: '绑定的会话已改变' }
    if (current.current?.bindingId === binding.current) setError(current.current.error ?? '')
    try {
      const result = await window.petApi.sessionCommand(request)
      if (binding.current !== request.bindingId) return { ok: false, error: '绑定的会话已改变' }
      if (!result.ok) setError(result.error ?? '操作没有完成')
      if (result.state && result.state.bindingId !== request.bindingId) return { ok: false, error: '会话回包绑定不匹配' }
      if (result.state) setSession(previous => !previous || previous.bindingId === request.bindingId ? mergeSession(previous, result.state!) : previous)
      return result
    } catch (reason) {
      if (binding.current !== request.bindingId) return { ok: false, error: '绑定的会话已改变' }
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      return { ok: false, error: message }
    }
  }, [])

  /** 主进程刚开启或恢复了会话：同步写入新绑定，紧接着的命令才不会被当成"绑定已改变"。 */
  const adopt = useCallback((state: SessionSnapshot) => {
    eventVersion.current += 1
    binding.current = state.bindingId
    current.current = state
    setSession(previous => mergeSession(previous, state))
    setError(state.error ?? '')
  }, [])

  const loadOlder = useCallback(async () => {
    const state = current.current
    if (!state?.hasMore || state.beforeSeq == null || olderLock.current || binding.current !== state.bindingId) return
    olderLock.current = true
    setLoadingOlder(true)
    const version = eventVersion.current
    try {
      const result = await window.petApi.getSession(state.beforeSeq, state.bindingId)
      if (binding.current !== state.bindingId) return
      if (!result.ok || !result.state) {
        if (version === eventVersion.current) setError(result.error ?? '历史记录加载失败')
        return
      }
      const page = result.state
      setSession(previous => previous?.bindingId === page.bindingId ? {
        ...previous,
        entries: mergeEntries(page.entries, previous.entries),
        hasMore: page.hasMore,
        beforeSeq: page.beforeSeq,
      } : previous)
    } catch (reason) {
      if (version === eventVersion.current && binding.current === state.bindingId) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally { olderLock.current = false; setLoadingOlder(false) }
  }, [])

  return { session, error, command, refresh, loadOlder, loadingOlder, adopt }
}
