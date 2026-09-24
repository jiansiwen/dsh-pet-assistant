/** 宠物交互的纯状态机；完成事件带版本，旧动画不能结束新一轮动作。 */
export type InteractionPhase = 'idle' | 'drag' | 'drop' | 'sleep-in' | 'sleep-loop' | 'sleep-out' | 'laptop-in' | 'think' | 'write' | 'laptop-out'
export type ConversationEvent =
  | { type: 'start'; id: number }
  | { type: 'reply'; id: number }
  /** 流式增量到达：宠物据此提前开始敲键盘；文本本身由气泡处理，状态机只需要"在出字"这件事。 */
  | { type: 'delta'; id: number }
  | { type: 'speech'; id: number; speaking: boolean }
  | { type: 'stop'; id: number }
export type InteractionEvent = ConversationEvent
  | { type: 'wake' | 'grab' }
  | { type: 'release'; moved: boolean }
  | { type: 'complete'; phase: string; version: number }
  | { type: 'tick'; working: boolean; idleMinutes: number; sleepMinutes: number }

export interface InteractionState {
  phase: InteractionPhase
  version: number
  lastInteraction: number
  sleepStarted: number
  round: { id: number; result: 'waiting' | 'reply' | 'stopped'; speaking: boolean; streaming: boolean; reopen: boolean } | null
}

export function initialInteraction(now: number): InteractionState {
  return { phase: 'idle', version: 0, lastInteraction: now, sleepStarted: 0, round: null }
}

export function interactionProtected(state: InteractionState): boolean {
  return state.phase !== 'idle' || state.round !== null
}

export function reduceInteraction(state: InteractionState, event: InteractionEvent, now: number): InteractionState {
  const enter = (phase: InteractionPhase, patch: Partial<InteractionState> = {}): InteractionState => ({
    ...state, ...patch, phase, version: state.version + 1,
  })
  const resume = (): InteractionState => state.round && state.round.result !== 'stopped'
    ? enter('laptop-in', { lastInteraction: now })
    : enter('idle', { round: null, lastInteraction: now })
  switch (event.type) {
    case 'start': {
      const round = { id: event.id, result: 'waiting' as const, speaking: false, streaming: false, reopen: state.phase === 'laptop-out' }
      if (['drag', 'drop', 'laptop-in', 'laptop-out', 'think'].includes(state.phase)) {
        return { ...state, round, lastInteraction: now }
      }
      return enter(state.phase === 'write' ? 'think' : 'laptop-in', { round, lastInteraction: now })
    }
    case 'reply':
    case 'delta':
    case 'speech':
    case 'stop': {
      if (!state.round || state.round.id !== event.id || state.round.result === 'stopped') return state
      const round = { ...state.round }
      if (event.type === 'reply') { round.result = 'reply'; round.streaming = false }
      if (event.type === 'delta') round.streaming = true
      if (event.type === 'speech') round.speaking = event.speaking
      if (event.type === 'stop') { round.result = 'stopped'; round.speaking = false; round.streaming = false }
      // 开电脑与摔坐必须演完；提前返回的结果留在 round 中。
      // 出字与整段回复都算"有事可敲"：第一片增量到了就开始打字，不必等整段回来；
      // 但出错/停止是要把电脑收起来，不能接着敲。
      if (state.phase === 'think' && (round.result !== 'waiting' || round.streaming)) {
        return enter(round.result === 'reply' || round.streaming ? 'write' : 'laptop-out', { round })
      }
      if (state.phase === 'write' && round.result === 'stopped') return enter('laptop-out', { round })
      return { ...state, round }
    }
    case 'wake':
      // 睡到一半被叫醒：把起身演完再回待机，不能从躺姿瞬间跳成站立。
      if (state.phase === 'sleep-in' || state.phase === 'sleep-loop') {
        return enter('sleep-out', { lastInteraction: now, sleepStarted: 0 })
      }
      return { ...state, lastInteraction: now }
    case 'grab':
      return enter('drag', { lastInteraction: now })
    case 'release':
      if (state.phase !== 'drag') return state
      return event.moved ? enter('drop', { lastInteraction: now }) : resume()
    case 'complete':
      if (event.version !== state.version || event.phase !== state.phase) return state
      switch (state.phase) {
        case 'drop': return resume()
        case 'sleep-in': return enter('sleep-loop', { sleepStarted: now })
        case 'sleep-out': return enter('idle', { sleepStarted: 0, lastInteraction: now })
        case 'laptop-in':
          return enter(
            state.round?.result === 'stopped' ? 'laptop-out'
              : (state.round?.result === 'reply' || state.round?.streaming) ? 'write' : 'think',
            { round: state.round ? { ...state.round, reopen: false } : null },
          )
        case 'write':
          // 文字回复至少写完一轮；语音还在播报或增量还在出字时接着写。
          return (state.round?.speaking || state.round?.streaming) ? state : enter('laptop-out')
        case 'laptop-out':
          return state.round?.reopen && state.round.result !== 'stopped'
            ? enter('laptop-in', { round: { ...state.round, reopen: false }, lastInteraction: now })
            : enter('idle', { round: null, lastInteraction: now })
        default: return state
      }
    case 'tick':
      if (state.phase === 'sleep-loop') {
        // 睡够了自己醒：同样把起身演完，不是凭空站起来。
        return now - state.sleepStarted >= event.sleepMinutes * 60_000
          ? enter('sleep-out', { sleepStarted: 0 }) : state
      }
      if (interactionProtected(state)) return state
      if (event.working) return { ...state, lastInteraction: now }
      return now - state.lastInteraction >= event.idleMinutes * 60_000 ? enter('sleep-in') : state
  }
}

export function oneShot(action: string | undefined): boolean {
  return action === 'drop' || action === 'sleep-in' || action === 'sleep-out'
    || action === 'laptop-in' || action === 'laptop-out'
    // 走路收步：3 帧演一次就停在站姿，不能回绕（回绕会重复"收步"的动作）
    || action === 'walk-stop'
}

/** 最后一帧停满一个帧周期后才完成，一次动作永远不回绕第一帧。 */
export function nextFrame(index: number, count: number, once: boolean): { index: number; complete: boolean } {
  const complete = index + 1 >= count
  return { index: complete ? (once ? Math.max(0, count - 1) : 0) : index + 1, complete }
}
