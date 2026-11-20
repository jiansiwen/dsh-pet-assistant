/**
 * 增量「影子缓冲」：权威条目到达之前的临时尾巴。
 *
 * 它**不是消息列表**，一秒都不要这么想。真正的列表是会话快照里的 `entries`（`mergeEntries`
 * 按 seq 合并），那里是唯一的权威。这里只负责一件事：桥接的 `delta` 先到、会话快照后到的
 * 那几百毫秒里，别让屏幕空着。权威条目一到，`commitAuthoritative` 就把对应的影子轮次删掉，
 * 正文立刻由权威条目接管。**同一个字绝不同时出现两份** —— 一旦出现两份，用户会以为助手
 * 把话说重了，而真正的 bug 在渲染层，很难往这里想。
 *
 * 分层理由与 `stage-layout.ts` 一致：这些判据（乱序 seq、epoch 切换、缺 id、超长）都是能在
 * 真实流里出现的边界，靠开壳等不到。纯函数才钉得住。
 *
 * 四道闸，都是"宁可少显示，不可显示错"：
 *
 * 1. **seq 单调门**。`seq <= lastSeq` 的增量丢弃。长轮询会重放、两路事件会交错，重放的增量
 *    如果照收，正文里就会重复一段。
 * 2. **epoch 闸**。epoch 一变（桥接重启 / 会话重开），旧 pending 全部作废：那些尾巴属于
 *    另一个会话，留着只会被拼到新会话的正文里。
 * 3. **不猜归属**。`payload.id` 缺失时按"epoch + kind + 起始 seq"造一个稳定的键，绝不挂到
 *    此刻恰好在等待的宠物请求上 —— 挂错比的是一整段正文被记到别人的账上。
 * 4. **溢出降级**。超上限就停止追加并置 `overflowed`，交给界面说一句"内容较长，正在整理"。
 *    绝不截断后假装完整，也绝不自己续写。
 */

import type { SessionEntry } from '../session-types.js'
import type { BridgeEventPayload } from './types.js'

export interface LiveTurn {
  turnKey: string
  epoch?: string
  lastSeq: number
  text: string
  think: string
  tools: Array<{ name: string; arg: string }>
  firstCharAt?: number
  committed: boolean
  overflowed: boolean
  /**
   * 已追加的片段数，用来执行 `maxChunks`。
   *
   * 契约里给的 `LiveTurn` 没有这个字段，但"超 maxChunks 就停"这条判据没有计数器就无法执行
   * （`tools` 只能数到工具，数不到正文片段），所以在实现里补一个内部计数。它不参与渲染。
   */
  chunks: number
}

export interface DeltaState {
  pending: Record<string, LiveTurn>
  epoch?: string
}

/**
 * 64KB 正文：远超一屏能读的量，超过它继续拼只会让消息列表滚成一堵墙。
 * 200 个片段：正常一轮回复的文本 + 思考增量在几十条量级，200 条之后基本只剩工具事件。
 */
export const DELTA_LIMITS: { maxChars: number; maxChunks: number } = { maxChars: 64 * 1024, maxChunks: 200 }

const ANON_PREFIX = 'anon:'

export function createDeltaState(): DeltaState {
  return { pending: {} }
}

function newTurn(turnKey: string, epoch: string | undefined): LiveTurn {
  const turn: LiveTurn = {
    turnKey,
    lastSeq: 0,
    text: '',
    think: '',
    tools: [],
    committed: false,
    overflowed: false,
    chunks: 0,
  }
  if (epoch !== undefined) turn.epoch = epoch
  return turn
}

/** 无 id 轮次的键：`epoch + kind + 起始 seq`。只有建轮那一刻算一次，之后一直沿用同一个键。 */
function anonKey(epoch: string | undefined, kind: string, seq: number | undefined): string {
  return `${ANON_PREFIX}${epoch ?? '-'}:${kind}:${seq ?? 0}`
}

/** 当前的无 id 轮次：取 `lastSeq` 最大的那个。同一次会话里无 id 的流本来就只有一条。 */
function currentAnonKey(state: DeltaState): string | null {
  let best: string | null = null
  let bestSeq = -1
  for (const [key, turn] of Object.entries(state.pending)) {
    if (!key.startsWith(ANON_PREFIX)) continue
    if (turn.committed) continue
    if (turn.lastSeq >= bestSeq) {
      bestSeq = turn.lastSeq
      best = key
    }
  }
  return best
}

function resolveTurnKey(state: DeltaState, payload: BridgeEventPayload, kind: string): string {
  if (payload.id !== undefined && payload.id !== '') return `id:${payload.id}`
  // `kind === 'user'` 是轮次边界，必须新起一轮，不能接在上一轮的尾部。
  if (kind !== 'user') {
    const current = currentAnonKey(state)
    if (current !== null) return current
  }
  return anonKey(state.epoch, kind, payload.seq)
}

/**
 * 喂一条桥接事件。
 *
 * 非 `delta` 事件原样返回（引用相等）：这条路径只处理增量，别的事件归各自的 reducer，
 * 在这里顺手做点什么是"耦合"的开始。
 */
export function reduceDelta(
  state: DeltaState,
  payload: BridgeEventPayload,
  now: number = Date.now(),
): { state: DeltaState; changed: boolean } {
  if (payload.type !== 'delta') return { state, changed: false }

  // epoch 变了：旧尾巴全部作废，再按新事件建。这也是唯一会丢弃"看起来还剩半截"的地方，
  // 因为那半截确实已经不属于任何会话了。
  const epochChanged = payload.epoch !== undefined && payload.epoch !== state.epoch
  const base: DeltaState = epochChanged ? { pending: {}, epoch: payload.epoch } : state

  const kind = payload.kind ?? 'text'
  const key = resolveTurnKey(base, payload, kind)
  const existing = base.pending[key]
  const seq = payload.seq

  // seq 单调门：重放与乱序都在这里丢掉。`base` 而不是 `state`，是因为 epoch 切换时
  // 旧轮次已经被清掉，用旧 seq 去比没有意义。
  if (existing !== undefined && seq !== undefined && seq <= existing.lastSeq) {
    return { state: base, changed: epochChanged }
  }

  const turn = existing !== undefined ? { ...existing } : newTurn(key, payload.epoch ?? base.epoch)
  let changed = existing === undefined || epochChanged
  if (seq !== undefined && seq > turn.lastSeq) {
    turn.lastSeq = seq
    changed = true
  }

  const chunk = payload.text ?? ''
  if (kind === 'user') {
    // 轮次边界：只用来切 turnKey。用户气泡已经由权威条目渲染，这里再写一份就是第二份正文。
  } else if (turn.overflowed) {
    // 已降级，只推进 lastSeq（上面做过），不再追加一个字。
  } else if (chunk.length === 0 && kind !== 'tool') {
    // 空片段不占预算：它们在这条流里很常见，白吃掉 200 个名额就会让真正的内容无位可放。
  } else {
    const size = turn.text.length + turn.think.length
    if (turn.chunks + 1 > DELTA_LIMITS.maxChunks || size + chunk.length > DELTA_LIMITS.maxChars) {
      turn.overflowed = true
      changed = true
    } else {
      turn.chunks += 1
      if (kind === 'think') {
        turn.think += chunk
      } else if (kind === 'tool') {
        // 工具条目的参数放在 `arg`，个别桥接版本把它塞在 `text` 里，两个都认。
        turn.tools.push({ name: payload.name ?? '', arg: payload.arg ?? chunk })
      } else {
        turn.text += chunk
        // 首字时刻是"用户开口到看见第一反应"的计分起点，只在第一次记。
        if (turn.firstCharAt === undefined && chunk.length > 0) turn.firstCharAt = now
      }
      changed = true
    }
  }

  if (!changed) return { state, changed: false }
  return { state: { ...base, pending: { ...base.pending, [key]: turn } }, changed: true }
}

/** 键里带得出序号就算出来，用于跟权威条目的 `turn` 对上；算不出返回 null。 */
function turnNumberIn(key: string): number | null {
  const parts = key.split(':')
  const tail = parts[parts.length - 1]
  if (!/^\d+$/.test(tail)) return null
  return Number(tail)
}

/**
 * 权威条目到了：对应的影子轮次使命结束。
 *
 * **提交判据**（为什么只用这两条）：
 *
 * 桥接两边编号不通 —— 增量带的是请求 id 或干脆没有 id，会话条目带的是 `turn` 序号，
 * 中间没有可证的换算。猜一个映射比不猜更糟（会把这一轮的尾巴错挂到别的轮上）。所以只认：
 *
 * 1. `entries` 里出现了**不带 `turn`** 的非流式条目：契约写明"缺省视为当前轮"，当前轮的
 *    影子该让位了；
 * 2. 条目带的 `turn` 序号与某个 pending 键里能读出的序号相同（两边共用一套编号时才会命中）。
 *
 * 两条都不命中时**宁可留着影子**：影子是幂等的，多显示一次的代价远小于把权威内容藏起来。
 *
 * `entry.streaming === true` 的条目不算权威：它还会变，此刻提交等于把尾巴删了又长回来。
 *
 * 返回的 `committedKeys` 是给调用方记账用的（埋点/一致性核对）。标 `committed` 的语义在
 * 类型里保留，但真正生效的是**从 pending 移除** —— 移除之后同一轮不会再被提交第二次。
 */
export function commitAuthoritative(
  state: DeltaState,
  entries: readonly SessionEntry[],
): { state: DeltaState; committedKeys: string[] } {
  const claimed = new Set<number>()
  let currentTurnClaimed = false
  for (const entry of entries) {
    if (entry.streaming === true) continue
    if (typeof entry.turn === 'number') claimed.add(entry.turn)
    else currentTurnClaimed = true
  }
  if (!currentTurnClaimed && claimed.size === 0) return { state, committedKeys: [] }

  const pending: Record<string, LiveTurn> = {}
  const committedKeys: string[] = []
  for (const [key, turn] of Object.entries(state.pending)) {
    if (turn.committed) continue
    const number = turnNumberIn(key)
    const hit = currentTurnClaimed || (number !== null && claimed.has(number))
    if (!hit) {
      pending[key] = turn
      continue
    }
    committedKeys.push(key)
  }
  if (committedKeys.length === 0) return { state, committedKeys }
  return { state: { ...state, pending }, committedKeys }
}

/**
 * 当前该显示的那条尾巴。
 *
 * 三道过滤各有理由：已提交的让位给权威条目；溢出的一律不显示（显示半截比显示"正在整理"更糟）；
 * 多轮并发时取 `lastSeq` 最大的那条，因为那才是用户此刻在等的那一轮。
 */
export function pickLiveTurn(state: DeltaState): LiveTurn | null {
  let best: LiveTurn | null = null
  for (const turn of Object.values(state.pending)) {
    if (turn.committed || turn.overflowed) continue
    if (best === null || turn.lastSeq > best.lastSeq) best = turn
  }
  return best
}
