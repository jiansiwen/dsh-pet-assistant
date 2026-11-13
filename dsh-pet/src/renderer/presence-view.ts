/**
 * 「九态」的纯函数状态机：宠物此刻是什么状态，以及凭什么变成这个状态。
 *
 * 为什么单独一层：
 *
 * 1. **可测**。验收判据里有一条是"界面显示的九态与后台真实状态一致"。这类判据靠开壳用眼睛
 *    看是钉不住的 —— 只有把"哪条事件把状态推到哪一格、什么时候不允许推"写成不认 React 的
 *    纯函数，`node --test` 才能逐条断言。`.tsx` 里的逻辑 Node 的类型剥离跑不动。
 * 2. **事实与节奏分开**。事件是事实（听写开始了、回执失败了），驻留时长是节奏（别让状态闪
 *    得看不清）。两者混在几百行组件里时，改一个 400ms 要在里面翻半天。
 *
 * 三条贯穿全文件的约定，改动前先读完：
 *
 * - **优先级只决定"能不能立刻换"，不决定"该不该显示"**。高优先即时抢占 —— 失败与成功必须
 *    马上被看见，晚一秒用户就开始猜了；低优先要等当前态驻留满 —— 刚亮 200ms 的"回答中"被
 *    "思考中"盖掉，用户看到的是闪烁，不是信息。
 * - **`muted` 不是独占态**。静音是用户按下的一个开关，不是"正在进行的一件事"。把活跃态盖成
 *    muted，用户会以为助手停了 —— 实际后台还在跑，这一条踩过。
 * - **`active` 是会话级闩锁，与九态正交**。九态讲"此刻在干什么"，`active` 讲"这一场还在不在"。
 *    连续对话里一轮说完（`turn-settled`）不能松闩锁，否则下一轮会被当成新会话重新开场。
 */

export type PresenceState =
  | 'idle'
  | 'listening'
  | 'recognizing'
  | 'thinking'
  | 'answering'
  | 'working'
  | 'succeeded'
  | 'failed'
  | 'muted'

export type PresenceEventKind =
  | 'dictation-start'
  | 'dictation-end'
  | 'asr-delta'
  | 'asr-final'
  | 'turn-start'
  | 'delta-text'
  | 'delta-think'
  | 'delta-tool'
  | 'speech-start'
  | 'speech-end'
  | 'turn-settled'
  | 'task-running'
  | 'receipt-succeeded'
  | 'receipt-partial'
  | 'receipt-unknown'
  | 'receipt-failed'
  | 'mute-on'
  | 'mute-off'
  | 'continuous-start'
  | 'continuous-stop'
  | 'session-idle'
  | 'session-lost'

/** 回执结论。`partial` / `unknown` 是两种"没拿到确定答案"，界面上不能画成成功。 */
export type PresenceReceipt = 'succeeded' | 'partial' | 'unknown' | 'failed'

export interface PresenceEvent {
  kind: PresenceEventKind
  at: number
  note?: string
}

export interface PresenceSnapshot {
  state: PresenceState
  active: boolean
  muted: boolean
  source: PresenceEventKind | 'initial'
  since: number
  receipt?: PresenceReceipt
  note?: string
  /**
   * 是否还有播报在响。`turn-settled` 要靠它判断"这轮是不是真说完了"：
   * 文字已经到齐、语音还在念的时候熄成 idle，用户会看到一只不动的宠物在说话。
   * 缺失一律按"还在说"处理（见 `reducePresence` 的 turn-settled 分支）—— 宁可多等一拍。
   */
  speechActive?: boolean
}

/**
 * 数字大的赢。
 *
 * `failed` 压在 `succeeded` 之上：一次失败比一次成功更需要立刻解释，尤其在两者同一拍到达时
 * （取消回执同时带"部分执行"和"失败"很常见）。
 * `muted` 排在活跃态之下但在 `idle` 之上：它是"待命但闭了嘴"，比纯待命多一层信息。
 */
export const PRESENCE_PRIORITY: Record<PresenceState, number> = {
  failed: 90,
  succeeded: 80,
  listening: 60,
  recognizing: 55,
  thinking: 50,
  answering: 45,
  working: 40,
  muted: 20,
  idle: 0,
}

/**
 * 每个状态的最小驻留时长（毫秒）。只对"被更低优先的事件接管"生效，高优先抢占不看它。
 *
 * 终端态（成败）给得最久：那是用户唯一需要读一眼的结果，2 秒内被"思考中"盖掉等于没显示。
 * 听写/识别给得短：说话的人自己知道自己在说话，界面只需要跟上，不需要额外停留。
 */
export const PRESENCE_DWELL_MS: Record<PresenceState, number> = {
  failed: 2500,
  succeeded: 2000,
  listening: 400,
  recognizing: 300,
  thinking: 400,
  answering: 400,
  working: 500,
  muted: 0,
  idle: 0,
}

/** 回执只能给到"部分完成／结果未知"时的原文。措辞留在这里，界面不自己编。 */
export const PARTIAL_RECEIPT_NOTE = '部分完成／结果未知，未自动重发'

const TERMINAL: ReadonlySet<PresenceState> = new Set<PresenceState>(['succeeded', 'failed'])

export function initialPresence(now: number): PresenceSnapshot {
  return { state: 'idle', active: false, muted: false, source: 'initial', since: now, speechActive: false }
}

/** 一次状态迁移里"顺便要改的旁路字段"。`null` 表示显式清掉，`undefined` 表示这次不动它。 */
interface PresencePatch {
  state?: PresenceState
  active?: boolean
  muted?: boolean
  speechActive?: boolean
  receipt?: PresenceReceipt | null
  note?: string | null
}

/**
 * 能不能由 `desired` 接管：高优先即时抢占，低优先要等当前态驻留满。
 * 同级不同态在这九态里不存在（优先级两两不同），所以同级的唯一情况就是状态没变，
 * 那条路径在 `advance` 里已经先被 `desired !== prev.state` 挡掉了。
 */
function canTakeOver(prev: PresenceSnapshot, desired: PresenceState, at: number): boolean {
  if (PRESENCE_PRIORITY[desired] > PRESENCE_PRIORITY[prev.state]) return true
  return at - prev.since >= PRESENCE_DWELL_MS[prev.state]
}

/**
 * 状态迁移的唯一出口。
 *
 * 顺序是刻意的：**旁路字段先落，状态再排队**。`active` / `muted` / `receipt` / `note` 都是
 * 事实，事实到了就该记下；而 `state` 是给用户看的一格画面，它要过优先级与驻留两道门。
 * 被门挡住时 `state` 与 `since` 一律不动 —— 否则"驻留"会变成"每次事件重算"，
 * 连续来十个小事件等于把驻留清零十次，屏幕上的状态就永远切不动了。
 */
function advance(prev: PresenceSnapshot, at: number, source: PresenceEventKind, patch: PresencePatch): PresenceSnapshot {
  const desired = patch.state ?? prev.state
  const takeOver = desired !== prev.state && canTakeOver(prev, desired, at)
  const state = takeOver ? desired : prev.state

  // 新一轮开始时，上一轮的结果（receipt / note）必须让位，否则界面会拿旧结论解释新动作。
  // 终端态自己不清：它就是这一轮的结果，要留着让用户读。
  const outcomeCleared = takeOver && !TERMINAL.has(state)

  const nextActive = patch.active ?? prev.active
  const nextMuted = patch.muted ?? prev.muted
  const nextSpeech = patch.speechActive ?? prev.speechActive ?? false
  const nextReceipt = patch.receipt === undefined
    ? (outcomeCleared ? undefined : prev.receipt)
    : patch.receipt === null ? undefined : patch.receipt
  const nextNote = patch.note === undefined
    ? (outcomeCleared ? undefined : prev.note)
    : patch.note === null ? undefined : patch.note

  if (
    !takeOver
    && nextActive === prev.active
    && nextMuted === prev.muted
    && nextSpeech === (prev.speechActive ?? false)
    && nextReceipt === prev.receipt
    && nextNote === prev.note
  ) {
    // 什么都没变就返回原对象：调用方可以靠引用相等跳过重渲染，不必自己逐字段比。
    return prev
  }

  const next: PresenceSnapshot = {
    state,
    active: nextActive,
    muted: nextMuted,
    source: takeOver ? source : prev.source,
    since: takeOver ? at : prev.since,
    speechActive: nextSpeech,
  }
  if (nextReceipt !== undefined) next.receipt = nextReceipt
  if (nextNote !== undefined) next.note = nextNote
  return next
}

/**
 * 喂一条事件，得到下一份快照。纯函数，不改 `prev`。
 *
 * 不认识的 `kind` 一律原样返回（引用相等）：识别不出的事件不该把界面推进到某个猜出来的状态，
 * 那比停在上一格更糟 —— 停着至少还是真的。
 */
export function reducePresence(prev: PresenceSnapshot, event: PresenceEvent, now: number = event.at): PresenceSnapshot {
  const at = now
  switch (event.kind) {
    case 'dictation-start':
      return advance(prev, at, event.kind, { state: 'listening', speechActive: false })
    case 'dictation-end':
      // 松手之后到出文字之前是"识别中"：这段时间用户没有任何反馈可看，最需要一格明确的状态。
      return advance(prev, at, event.kind, { state: 'recognizing' })
    case 'asr-delta':
      return advance(prev, at, event.kind, { state: 'recognizing' })
    case 'asr-final':
      // 文字已定、回复未至：这一格是"在想"，不是"在说"。
      return advance(prev, at, event.kind, { state: 'thinking' })
    case 'turn-start':
      // 新的一轮：闩锁拉上；上一轮若还在播报，那声音已经过期了（被打断或已说完），重新计。
      return advance(prev, at, event.kind, { state: 'thinking', active: true, speechActive: false })
    case 'delta-think':
      return advance(prev, at, event.kind, { state: 'thinking' })
    case 'delta-text':
      return advance(prev, at, event.kind, { state: 'answering' })
    case 'delta-tool':
      return advance(prev, at, event.kind, { state: 'working' })
    case 'speech-start':
      return advance(prev, at, event.kind, { state: 'answering', speechActive: true })
    case 'speech-end':
      // 只记"说完了"，不动状态：话说完不等于这一轮结束（工具还在跑、回执还没到）。
      return advance(prev, at, event.kind, { speechActive: false })
    case 'turn-settled': {
      // 两个条件缺一不可：得是从"回答中"收下来（思考中/干活中被一轮结束带走是错的，
      // 那两格的事还没完），且语音真的停了（还在念就熄灯，用户会以为声音是幻觉）。
      // `speechActive` 缺失按"还在说"算 —— 不知道就别收。
      if (prev.state !== 'answering' || prev.speechActive !== false) return prev
      return advance(prev, at, event.kind, { state: prev.muted ? 'muted' : 'idle' })
    }
    case 'task-running':
      return advance(prev, at, event.kind, { state: 'working' })
    case 'receipt-succeeded':
      return advance(prev, at, event.kind, { state: 'succeeded', receipt: 'succeeded', note: null })
    case 'receipt-failed':
      return advance(prev, at, event.kind, { state: 'failed', receipt: 'failed', note: null })
    case 'receipt-partial':
    case 'receipt-unknown':
      // 没有确定结论就不许画成成功，也不许熄成待命 —— 熄灯等于告诉用户"这事完了、没你的事了"，
      // 而它可能只做了一半。留在"干活中"（或被驻留门挡在当前格），并把话说清楚。
      return advance(prev, at, event.kind, {
        state: 'working',
        receipt: event.kind === 'receipt-partial' ? 'partial' : 'unknown',
        // 回执自己带更具体的话时以它为准（比如"已在第一步后终止"），否则用统一措辞。
        note: event.note ?? PARTIAL_RECEIPT_NOTE,
      })
    case 'mute-on':
      // 只置标记；只有本来就在待命时才把画面落到 muted。活跃态一律不覆盖。
      return advance(prev, at, event.kind, { state: prev.state === 'idle' ? 'muted' : prev.state, muted: true })
    case 'mute-off':
      return advance(prev, at, event.kind, { state: prev.state === 'muted' ? 'idle' : prev.state, muted: false })
    case 'continuous-start':
      return advance(prev, at, event.kind, { active: true })
    case 'continuous-stop':
      return advance(prev, at, event.kind, { active: false })
    case 'session-idle':
      // 会话面说"空闲了"，这是比轮次面更强的一次收束：否则丢一个 turn-settled 就会永远
      // 挂在"回答中"，而"与真实状态一致"正是要靠这个状态机保证的判据。
      // 但语音还在响时不动状态（同 turn-settled 的理由），只松闩锁。
      return advance(prev, at, event.kind, {
        active: false,
        state: prev.speechActive === true ? prev.state : (prev.muted ? 'muted' : 'idle'),
      })
    case 'session-lost':
      // 断线不是空闲，也不是失败：不知道后台在干什么的时候，猜一个终端态等于替它下结论。
      // 只松闩锁，状态留在原地等下一次会话更新来收。
      return advance(prev, at, event.kind, { active: false })
    default:
      // 认不出的事件：原样返回。停在上一格至少还是真的，猜一格就是界面在撒谎。
      return prev
  }
}
