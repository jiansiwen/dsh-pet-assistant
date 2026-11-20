/**
 * 逐字呈现的 React 接线：把 `chat-delta.ts` 的纯逻辑接到界面上。
 *
 * **定位（先说清楚，免得被当成主路径改）**：本模块是**兜底 / 切换接口**，不是逐字的主通道。
 * 正常路径的逐字由 `session/update` 的 `streaming: true` 条目提供（插件侧 `session-mirror`
 * 每 120ms 把累积正文推一次），所以下面第 3 条闸门在正常路径下会让影子**不画** —— 这是
 * 刻意的：同一句话不许出现两份。只有"增量到了、条目还没追上"的那 ≤120ms 由影子顶班；
 * 将来若换成更细粒度的通道（比如宿主改为只在轮次落定时推条目），把这条闸门去掉即可接管，
 * 纯逻辑（`chat-delta.ts`）不用动。
 *
 * 这一层只回答一个问题：**什么时候允许重渲染**。判据只有一条 —— 临时尾的可见内容变了。
 * 宿主可能每几十毫秒推一个片段，每片都 `setState` 会把整个会话框重渲染几十次/秒，而其中
 * 绝大多数帧在视觉上是同一行字。所以热路径（`reduceDelta`）只写 ref；只有「文本长度 /
 * 思考长度 / 工具条数 / 是否溢出 / 有没有尾巴 / 是否还在等」变化时才发布一次。
 *
 * 三件事必须同时成立，否则用户会看到"先逐字、后又整段重刷"：
 *
 * 1. **影子只活在 `pending` 里**。权威条目一到（`commitAuthoritative` 判定的那一帧）它就
 *    从 `pending` 消失，`publish` 随即把 `live` 置 null —— 界面只剩权威那一份。
 * 2. **提交后记下迟到水位**。权威条目到齐之后，同一条流上可能再来一个 `seq` 更大的增量
 *    （条目是先到的、句子还在长）。按 `chat-delta` 的契约那会重建影子，于是同一句话会
 *    并排出现两份。水位把这类增量挡在 `reduceDelta` 之前 —— 这就是切片 1 报告里那条
 *    "残余风险"的堵法。
 * 3. **屏幕上有流式正文条目时，影子一律不画**（`publish` 里的 `covered`）。条目自己在逐字，
 *    再画一条尾巴就是同一句话两份，而且每 120ms 闪一次。少显示是安全的，显示两份是事故。
 *
 * 还一条硬约束：影子**不进 `session.entries`、不进 `mirror`、不调 `sessionCommand`**。它只是
 * 渲染，不是数据；一旦写进会话，权威条目到达时就会出现第二条同样的消息。
 *
 * 最后一条：宿主一次增量都不吐时，这里必须完全安静（`live` 恒为 null、不产生任何空白气泡），
 * 界面与接这条流之前一模一样。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { SessionEntry } from '../session-types.js'
import {
  commitAuthoritative,
  createDeltaState,
  pickLiveTurn,
  reduceDelta,
  type DeltaState,
} from './chat-delta.ts'
import type { BridgeEventPayload } from './types.js'

/** 交给界面的临时尾。字段与 `LiveTurn` 一致，但**不含** `committed` / `chunks` 这类内部记账。 */
export interface ChatDeltaLive {
  turnKey: string
  text: string
  think: string
  tools: Array<{ name: string; arg: string }>
  overflowed: boolean
  firstCharAt?: number
}

export interface ChatDeltaView {
  /** 当前唯一的临时尾；权威条目到达后立刻变 null。 */
  live: ChatDeltaLive | null
  /** 是否还有未提交的轮次（界面可据此显示"正在思考"占位）。 */
  active: boolean
}

/** 初值必须是同一个对象：每次渲染都造新对象会让下游 memo 全部失效。 */
const EMPTY_VIEW: ChatDeltaView = { live: null, active: false }

/** 已定稿轮次键的上限。24 条足够覆盖"同一会话里还在收尾的几轮"，不留给长会话无界增长的机会。 */
const SEALED_KEY_LIMIT = 24

function sealKey(sealed: Set<string>, key: string): void {
  sealed.add(key)
  while (sealed.size > SEALED_KEY_LIMIT) {
    const oldest = sealed.values().next().value
    if (oldest === undefined) return
    sealed.delete(oldest)
  }
}

/**
 * 这一拍被改的是哪一轮：`reduceDelta` 每次只换掉一个 `LiveTurn` 对象，所以"引用变了"就是它。
 * 返回 null 表示两边的键集合完全一样却没认出来（理论上不会发生），此时按"不是已定稿轮次"处理。
 */
function changedTurnKey(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string | null {
  for (const [key, turn] of Object.entries(after)) {
    if (before[key] !== turn) return key
  }
  return null
}

export function useChatDelta(entries: readonly SessionEntry[] | undefined): ChatDeltaView {
  const [view, setView] = useState<ChatDeltaView>(EMPTY_VIEW)
  const state = useRef<DeltaState>(createDeltaState())
  /** 最新的会话条目。`publish` 是稳定回调（依赖为空），需要靠 ref 读到这一帧的 entries。 */
  const entriesRef = useRef<readonly SessionEntry[] | undefined>(entries)
  entriesRef.current = entries
  /**
   * 迟到水位：被权威条目提交过的轮次记住它的最大 `seq`。同一 epoch 内 `seq <= 水位` 的增量
   * 一律不进影子。`epoch` 一起记：换了 epoch 就是另一条流，旧水位不该拦新流。
   */
  const sealed = useRef<{ epoch?: string; lastSeq: number }>({ lastSeq: 0 })
  /**
   * 已提交轮次的键。**水位只挡 `seq <= 水位`**（重放与乱序），挡不住"提交之后又来一个更大的
   * seq"—— 那在宿主侧是"条目先定稿、句子还在长"的少见顺序，可一旦发生，影子会与刚渲染的
   * 权威条目并排出现，也就是用户眼里"这句话说了两遍"。所以再记一份"已定稿的轮次键"，
   * 这些键永不再长出影子。上限 24 条并淘汰最早的，避免长会话里无界增长。
   */
  const sealedKeys = useRef<Set<string>>(new Set())
  /** 上次发布的内容键。用"长度"而不是全文比较：影子是只追加的，长度变了内容一定变了。 */
  const published = useRef('')

  const publish = useCallback(() => {
    const turn = pickLiveTurn(state.current)
    /**
     * 屏幕上是否已经有这一轮的正文在长。
     *
     * 插件侧的会话镜像每 `FEED_TICK_MS`（120ms）就按 chunk 累积出一条
     * `streaming: true` 的 assistant 正文条目推过来 —— 也就是说"逐字"这件事在条目通道里
     * 已经发生了。这时再画影子，用户看到的就是同一句话并排两份；而且每 120ms 一次
     * "影子出现 → 条目追上 → 影子消失"就是一次闪烁。
     *
     * 所以：**流式条目在，影子就不画**。影子只在"条目还没到"的那一小段里顶班，
     * 一旦有权威或流式条目兜着就自动退场 —— 少显示是安全的，显示两份是事故。
     */
    const covered = (entriesRef.current ?? []).some(item =>
      item.streaming === true && item.role === 'assistant' && item.kind === 'text' && item.text.length > 0)
    let live: ChatDeltaLive | null = null
    // 三者全空就不显示：一个空的 is-streaming 气泡比什么都没有更像故障。
    if (!covered && turn !== null && (turn.text.length > 0 || turn.think.length > 0 || turn.tools.length > 0)) {
      live = {
        turnKey: turn.turnKey,
        text: turn.text,
        think: turn.think,
        tools: turn.tools,
        overflowed: turn.overflowed,
      }
      if (turn.firstCharAt !== undefined) live.firstCharAt = turn.firstCharAt
    }
    const active = Object.keys(state.current.pending).length > 0
    const key = live === null
      ? `none|${active ? 1 : 0}`
      : `${live.turnKey}|${live.text.length}|${live.think.length}|${live.tools.length}|${live.overflowed ? 1 : 0}|${active ? 1 : 0}`
    if (key === published.current) return
    published.current = key
    setView({ live, active })
  }, [])

  // 订阅会话流水。`off?.()`：preload 若还是旧版（返回 void）也不会在卸载时炸。
  useEffect(() => {
    const handle = (payload: BridgeEventPayload): void => {
      // 非 delta 事件这条路不管：`reduceDelta` 也会原样返回，这里提前挡住是为了别让它们
      // 参与下面的水位判断（那些事件带不带 seq 都跟会话正文的顺序无关）。
      if (payload.type !== 'delta') return
      const epochChanged = payload.epoch !== undefined
        && state.current.epoch !== undefined
        && payload.epoch !== state.current.epoch
      if (epochChanged) sealed.current = { epoch: payload.epoch, lastSeq: 0 }
      // 迟到水位：权威条目已经把这一轮提交过了，同轮的迟到增量不再重建影子。
      if (payload.seq !== undefined
        && payload.epoch === sealed.current.epoch
        && payload.seq <= sealed.current.lastSeq) return
      const result = reduceDelta(state.current, payload)
      if (!result.changed) return
      // 找出这一拍被改的是哪一轮（`reduceDelta` 只换掉一个对象，引用变了的那个就是目标），
      // 已定稿的轮次不许再长影子。用"目标轮次"而不是 `pickLiveTurn`：多轮并发时后者挑的是
      // lastSeq 最大的那个，可能把一条正常增量的判定带偏。
      const target = changedTurnKey(state.current.pending, result.state.pending)
      if (target !== null && sealedKeys.current.has(target)) return
      state.current = result.state
      publish()
    }
    const off: (() => void) | void = window.petApi.onChatDelta(handle)
    return () => { off?.() }
  }, [publish])

  // 权威条目到达：提交对应轮次，并把它们的水位记下来（堵住后面那批迟到增量）。
  useEffect(() => {
    const before = state.current
    const { state: next, committedKeys } = commitAuthoritative(before, entries ?? [])
    if (committedKeys.length === 0) {
      if (next !== before) state.current = next
      publish()
      return
    }
    let maxSeq = 0
    for (const key of committedKeys) {
      const turn = before.pending[key]
      if (turn !== undefined && turn.lastSeq > maxSeq) maxSeq = turn.lastSeq
      sealKey(sealedKeys.current, key)
    }
    if (maxSeq > 0) sealed.current = { epoch: next.epoch, lastSeq: maxSeq }
    state.current = next
    publish()
  }, [entries, publish])

  return view
}
