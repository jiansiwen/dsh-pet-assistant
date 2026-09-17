/**
 * 共享场景时钟：全场一个节拍器，所有角色挂在它上面。
 *
 * 改造前每个角色各持一个 `setInterval(16ms)`。五个角色就是每秒 300 多次独立的定时器唤醒，
 * 而绝大多数唤醒只是判断一下"我现在没在走路"就返回。合成一个之后唤醒次数与角色数无关 ——
 * 这是一个常驻的透明置顶窗口，省下的每一次唤醒都是实打实的 CPU/合成开销。
 *
 * 计划里这一块叫 `useGroupScene.ts`。做成纯模块而不是 hook，一是 group scene 目前只有
 * "时钟"这一个共享关注点，二是 `.ts` 才进得了 `node --test`（hook 文件沾 React，测不了）。
 */

export type TickHandler = () => void

/** 一帧的间隔。60fps 约 16.7ms，取 16 与改造前一致，不改变角色的移动手感。 */
export const TICK_MS = 16

const handlers = new Set<TickHandler>()
let timer: ReturnType<typeof setInterval> | null = null

function fire(): void {
  // 先快照再遍历。Set 的迭代器会把遍历过程中新增的元素也带上，所以某个 handler 里
  // 挂载了新角色时，那个角色会在同一拍就被推进一次 —— 它明明这一帧才刚出现。
  for (const handler of [...handlers]) handler()
}

/**
 * 订阅场景节拍。返回退订函数。
 *
 * 第一个订阅者启动时钟，最后一个退订时停掉 —— 桌面上一个角色都没有时不该有定时器在跑。
 */
export function subscribeTick(handler: TickHandler): () => void {
  handlers.add(handler)
  if (timer === null) timer = setInterval(fire, TICK_MS)
  return () => {
    handlers.delete(handler)
    if (handlers.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** 当前订阅者数。测试用它断言"时钟只有一个"，也用来确认退订干净了。 */
export function tickSubscriberCount(): number {
  return handlers.size
}

/** 时钟是否在跑。没有订阅者却还留着定时器就是泄漏。 */
export function isClockRunning(): boolean {
  return timer !== null
}

/** 测试之间清空订阅与时钟，否则上一个用例留下的定时器会让下一个用例的断言失真。 */
export function resetSceneClock(): void {
  handlers.clear()
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}
