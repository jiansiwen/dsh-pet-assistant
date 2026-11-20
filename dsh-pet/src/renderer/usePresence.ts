/**
 * 九态在 React 里的接线：一帧事实进来，一份快照出去。
 *
 * 三条渲染纪律（都是为了不在 120ms 的流式节拍上把整棵树重画）：
 *
 * 1. **快照存在 ref 里，state 只是它的镜子**。热路径每帧至少走一次 `factsToEvents`，
 *    但绝大多数帧的事件数组是空的。
 * 2. **只在快照真的变了才 `setState`**。判据是 `state / active / muted / receipt / note`
 *    这五个**可见**字段里的任意一个变了；`since` 单独变化不算。
 *
 * 还有一件必须在这里解决的事：**驻留门 + 边沿触发 = 会卡住**。
 *
 * `factsToEvents` 只在事实"翻转"的那一帧产生事件（streaming 条目是累积的，布尔量整轮为真），
 * 而 `reducePresence` 要求当前态先驻留满（回答中 400ms、干活中 500ms…）。于是常见的一帧是：
 * 事实从"思考"跳到"回答"，事件发了，却被驻留门挡下 —— 之后再也不会有新事件来重试它，
 * 界面就停在"思考中"直到下一次事实变化。每一轮都会撞上，不是边角情况。
 *
 * 解法是**到期重试**：算出现在想去的格子（忽略节奏），与真实格子不一致就在驻留期满那一刻
 * 把**最后一个要改状态的事件**再喂一次（`intentOf`）。只重放意图而不是整批，是因为
 * `turn-start` 这类一次性事实重放时会把状态推回"思考中"，越重试越退。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { EMPTY_FACTS, factsToEvents, intentOf, type PresenceFacts } from './presence-facts.ts'
import {
  initialPresence,
  PRESENCE_DWELL_MS,
  reducePresence,
  type PresenceEvent,
  type PresenceSnapshot,
} from './presence-view.ts'

/** 快照的哪些字段变了才算"用户看得见的变化"。 */
function visiblyChanged(before: PresenceSnapshot, after: PresenceSnapshot): boolean {
  return before.state !== after.state
    || before.active !== after.active
    || before.muted !== after.muted
    || before.receipt !== after.receipt
    || before.note !== after.note
}

/**
 * 忽略节奏时这个事件想把状态推到哪里。
 *
 * 手段是把 `since` 推到"很久以前"：驻留判断于是恒成立，剩下的只有优先级与事件本身的语义。
 * 得到的格子与真实格子不同，就说明这一下是被驻留门挡下的，值得到期再试一次。
 */
function wantedState(before: PresenceSnapshot, event: PresenceEvent, now: number): PresenceSnapshot['state'] {
  return reducePresence({ ...before, since: Number.NEGATIVE_INFINITY }, event, now).state
}

export function usePresence(facts: PresenceFacts): PresenceSnapshot {
  const snapshot = useRef<PresenceSnapshot>(initialPresence(Date.now()))
  /** 上一帧事实。初值是空基线，于是"打开界面时它已经在干活"也能被翻译成事件。 */
  const previousFacts = useRef<PresenceFacts>(EMPTY_FACTS)
  const [view, setView] = useState<PresenceSnapshot>(snapshot.current)
  /** 这一批事件；被驻留门挡下时，到期后换成"只含最后那个意图"的一份再喂。 */
  const pending = useRef<readonly PresenceEvent[]>([])
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const clearRetry = useCallback((): void => {
    if (retryTimer.current !== undefined) clearTimeout(retryTimer.current)
    retryTimer.current = undefined
  }, [])

  const flush = useCallback((): void => {
    const events = pending.current
    if (events.length === 0) return
    const now = Date.now()
    const before = snapshot.current
    let next = before
    for (const event of events) next = reducePresence(next, event, now)
    snapshot.current = next
    if (next !== before && visiblyChanged(before, next)) setView(next)

    clearRetry()
    const intent = intentOf(events)
    if (intent === null) return
    const wants = wantedState(before, intent, now)
    if (wants === next.state) return
    // 挡下了：下次只重放这一个意图，驻留期满即落地。
    pending.current = [intent]
    const due = next.since + PRESENCE_DWELL_MS[next.state]
    retryTimer.current = setTimeout(() => {
      retryTimer.current = undefined
      flush()
    }, Math.max(16, due - now))
  }, [clearRetry])

  /**
   * 依赖逐个列出而不是整包 `facts`：调用方每帧都会造一个新对象，用对象做依赖等于每帧都跑一遍。
   * 逐项依赖只在**真的有一个事实变了**时才进 effect —— 这是"不因 120ms 刷新而重渲染"的一半
   * （另一半是 `visiblyChanged`）。
   */
  useEffect(() => {
    const now = Date.now()
    const events = factsToEvents(previousFacts.current, facts, now)
    previousFacts.current = facts
    if (events.length === 0) return
    pending.current = events
    flush()
    // `facts` 的每一项已经在下面列全；把 `flush` 的依赖补进来即可，不必再把整包对象列上。
  }, [
    facts.busy,
    facts.sessionStatus,
    facts.speaking,
    facts.listening,
    facts.hasStreamingText,
    facts.hasStreamingThink,
    facts.hasStreamingTool,
    facts.taskRunning,
    facts.continuous,
    facts.muted,
    facts.errorText,
    flush,
  ])

  // 卸载时清掉重试定时器，别让它在组件消失后再去 setState。
  useEffect(() => () => clearRetry(), [clearRetry])

  return view
}
