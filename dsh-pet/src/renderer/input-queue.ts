/**
 * 忙时的输入队列：用户说的话不能因为"助手正在忙"就消失。
 *
 * 现在这条路上最伤人的行为是**直接丢弃**：用户打字/说完一句，界面没反应，一会儿后助手把上
 * 一句的答复吐出来 —— 用户完全不知道自己的第二句没进去，只记得"我说过它没理我"。
 * 这一层就是来把"丢"改成"排队，排不上就明确告知"。
 *
 * 为什么是纯函数：队列的每一条判据（空、超长、满、过期、失效项）都会在真实使用里出现，
 * 而这些判据全靠开壳是试不出来的（要凑齐"第 4 条恰好超限"这种场面）。写成不认 React 的
 * 纯函数，`node --test` 才能把每种拒绝都钉住。组件只负责把结果画出来。
 *
 * 三条不可动摇的约定：
 *
 * - **绝不静默丢弃**。任何一条进不了队，都返回带原因的 `ok:false`，调用方据此提示并把原文
 *   回填输入框。丢一条比提示一句严重得多。
 * - **过期条目由时间清，不由条数清**。压在队里 60 秒的话已经和当前上下文无关了，发出去只会
 *   让助手答非所问；所以 TTL 先于取队首执行。
 * - **全部函数不抛异常**。队列在用户输入路径上，抛一个异常就是一次白屏。
 */

export interface QueuedInput {
  id: string
  text: string
  enqueuedAt: number
  source: 'typed' | 'voice' | 'interrupt'
  bindingId?: string
}

export interface QueueLimits {
  maxItems: number
  ttlMs: number
  maxChars: number
}

/**
 * 3 条：再说更多的话，等排到时用户已经忘了自己说过什么，逐条取消比重说一遍更烦。
 * 60 秒：超过这个时间，上下文基本换了，硬发出去只会答非所问。
 * 4000 字：超过它就不是"补一句话"，而是长文 —— 那该等空闲后单独说，别挤在队列里。
 */
export const DEFAULT_QUEUE_LIMITS: QueueLimits = { maxItems: 3, ttlMs: 60_000, maxChars: 4000 }

export type EnqueueOutcome =
  | { ok: true; queue: QueuedInput[] }
  | { ok: false; reason: 'empty' | 'full' | 'too-long'; queue: QueuedInput[] }

/**
 * 入队。
 *
 * 存的是 `trim` 之后的正本：队列的目的是"把这句话原样补发出去"，前后的空白与换行只是输入框
 * 的手感，带着它们进队会让"这条是不是空"在下一环节再判一次。
 *
 * 三种拒绝共用一条出口：**都返回原因**，不返回 `null`、不抛异常、不改传入的数组。
 * `queue` 字段始终是"当前该显示在队列面板里的东西"，调用方不需要知道失败时该不该还原。
 */
export function enqueue(
  queue: readonly QueuedInput[],
  input: QueuedInput,
  limits: QueueLimits = DEFAULT_QUEUE_LIMITS,
): EnqueueOutcome {
  const text = input.text.trim()
  if (text.length === 0) return { ok: false, reason: 'empty', queue: [...queue] }
  if (text.length > limits.maxChars) return { ok: false, reason: 'too-long', queue: [...queue] }
  if (queue.length >= limits.maxItems) return { ok: false, reason: 'full', queue: [...queue] }
  return { ok: true, queue: [...queue, { ...input, text }] }
}

/**
 * 摘掉过期条目。
 *
 * 判据用 `>=` 而不是 `>`：正好压满 TTL 的那条也算过期 —— 边界上多留一条没有好处，
 * 只有一个"它到底还在不在"的问题要解释。
 *
 * `dropped` 单独返回，是因为调用方要用它说一句"有 1 条太旧了没发出去"。过期不能无声无息。
 */
export function dropExpired(
  queue: readonly QueuedInput[],
  now: number,
  limits: QueueLimits = DEFAULT_QUEUE_LIMITS,
): { queue: QueuedInput[]; dropped: QueuedInput[] } {
  const kept: QueuedInput[] = []
  const dropped: QueuedInput[] = []
  for (const item of queue) {
    if (now - item.enqueuedAt >= limits.ttlMs) dropped.push(item)
    else kept.push(item)
  }
  return { queue: kept, dropped }
}

/**
 * 取队首。
 *
 * 先过期、再取，顺序不能反：否则队首那条 61 秒前的话会被发出去。
 *
 * `isValid` 是给调用方接"这条所指的会话/绑定已经不存在了"这类判断的。失效项**带进 dropped**，
 * 然后继续取下一条 —— 一条失效就整队停下，等于把后面几条能说的话一起废掉。
 */
export function takeNext(
  queue: readonly QueuedInput[],
  now: number,
  limits: QueueLimits,
  isValid?: (item: QueuedInput) => boolean,
): { next: QueuedInput | null; queue: QueuedInput[]; dropped: QueuedInput[] } {
  const fresh = dropExpired(queue, now, limits)
  const dropped = fresh.dropped
  for (let index = 0; index < fresh.queue.length; index += 1) {
    const head = fresh.queue[index]
    if (isValid === undefined || isValid(head)) {
      return { next: head, queue: fresh.queue.slice(index + 1), dropped }
    }
    dropped.push(head)
  }
  return { next: null, queue: [], dropped }
}

/** 用户手动取消队列里的某一条。找不到就是原样一份，不报错 —— 取消本来就可能点重复。 */
export function removeById(queue: readonly QueuedInput[], id: string): QueuedInput[] {
  return queue.filter(item => item.id !== id)
}

/**
 * 「停止生成」时清空队列，并把还没说的话按原顺序拼回去（换行分隔）。
 *
 * 为什么是拼回而不是逐条弹提示：停止是用户想"从头再来一次"的动作，此刻他最需要的是把自己
 * 说过的话拿回手里，而不是在 N 个提示里点 N 次确定。`interrupt` 来源的条目也在里面 ——
 * 那是用户说过的话，不该因为他按了停止就蒸发。
 */
export function drainForStop(queue: readonly QueuedInput[]): { queue: QueuedInput[]; restoredText: string } {
  return { queue: [], restoredText: queue.map(item => item.text).join('\n') }
}
