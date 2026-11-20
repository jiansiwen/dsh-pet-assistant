/**
 * 逐字接线的测试：`useChatDelta` 在"没有被权威条目覆盖"之前显示、覆盖之后立刻让位。
 *
 * 为什么要测一个 React hook：这一层最要紧的判据是**同一个字不出现在两处**，而它发生在
 * 「权威条目到达的那一帧」——开壳盯着看是看不出有没有多渲染一帧的。项目里已有先例
 * （`chat-overlay-model.test.ts`）：把源码 `transpileModule` 成 CommonJS，再用桩件顶掉
 * `react` 与本地依赖，就能在 `node --test` 里手动驱动一次渲染与一次事件。
 *
 * 桩件不是玩具：它按 React 的规则给 hook 槽位编号、只在依赖变化时重跑 effect，
 * 所以"提交后迟到增量会不会把影子重建出来"这类判据能被真实地钉住。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, test } from 'node:test'
import ts from 'typescript'

import * as deltaLogic from '../src/renderer/chat-delta.ts'
import type { BridgeEventPayload } from '../src/renderer/types.js'
import type { SessionEntry } from '../src/session-types.js'
import type { ChatDeltaView } from '../src/renderer/useChatDelta.ts'

const source = readFileSync(new URL('../src/renderer/useChatDelta.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

const requireReal = createRequire(import.meta.url)

interface EffectSlot {
  deps?: readonly unknown[]
  run: () => void | (() => void)
  cleanup?: () => void
}

/**
 * 一次"组件生命周期"。
 *
 * hook 槽位按调用顺序编号（与 React 一致），`useState` 的值存在这个实例里，`useCallback`
 * 缓存首个函数（它的依赖恒为空数组），`useEffect` 只在依赖变化时重跑 —— 于是"effect 重挂会
 * 不会重复订阅""提交后迟到增量会不会重建影子"这些都能在用例里被真实驱动。
 */
function mount() {
  const states: unknown[] = []
  const refs: Array<{ current: unknown }> = []
  const memos: unknown[] = []
  const effects: EffectSlot[] = []
  let pending: EffectSlot[] = []
  let dirty = false
  let stateCursor = 0
  let refCursor = 0
  let memoCursor = 0
  let effectCursor = 0
  const handlers: Array<(payload: BridgeEventPayload) => void> = []
  const unsubscribed: number[] = []

  const react = {
    useState(initial: unknown) {
      const index = stateCursor++
      if (!(index in states)) states[index] = initial
      const setter = (value: unknown): void => {
        states[index] = typeof value === 'function' ? (value as (prev: unknown) => unknown)(states[index]) : value
        dirty = true
      }
      return [states[index], setter] as const
    },
    useRef(initial: unknown) {
      const index = refCursor++
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    },
    useCallback(fn: unknown) {
      const index = memoCursor++
      if (!(index in memos)) memos[index] = fn
      return memos[index]
    },
    useEffect(run: () => void | (() => void), deps?: readonly unknown[]) {
      const index = effectCursor++
      const previous = effects[index]
      const changed = previous === undefined || deps === undefined
        || previous.deps === undefined || previous.deps.length !== deps.length
        || deps.some((dep, position) => !Object.is(dep, previous.deps![position]))
      if (!changed) return
      previous?.cleanup?.()
      const slot: EffectSlot = { deps, run }
      effects[index] = slot
      pending.push(slot)
    },
  }

  const fakeWindow = {
    petApi: {
      onChatDelta(callback: (payload: BridgeEventPayload) => void) {
        handlers.push(callback)
        const serial = handlers.length
        return () => { unsubscribed.push(serial) }
      },
    },
  }

  const module = { exports: {} as { useChatDelta: (entries: readonly SessionEntry[] | undefined) => ChatDeltaView } }
  new Function('require', 'module', 'exports', 'window', compiled)((name: string) => {
    if (name === 'react') return react
    if (name === './chat-delta.ts') return deltaLogic
    if (name === './types.js' || name === '../session-types.js') return {}
    return requireReal(name)
  }, module, module.exports, fakeWindow)

  /**
   * 走完一次"渲染 + 副作用 + 因副作用 setState 而重渲染"。
   *
   * effect 里 `setState` 在真实 React 里会再排一帧，所以这里也要循环到不再有 setState 为止；
   * 少了这个循环，就会把"提交后应该已经变 null 的 live"读成提交前的旧值。
   */
  const render = (entries?: readonly SessionEntry[]): ChatDeltaView => {
    let view: ChatDeltaView = { live: null, active: false }
    for (let pass = 0; pass < 5; pass += 1) {
      dirty = false
      stateCursor = 0; refCursor = 0; memoCursor = 0; effectCursor = 0
      view = module.exports.useChatDelta(entries)
      const flushing = pending
      pending = []
      for (const slot of flushing) slot.cleanup = slot.run() ?? undefined
      if (!dirty) break
    }
    return view
  }

  const emit = (payload: BridgeEventPayload): void => {
    for (const handler of handlers) handler(payload)
  }

  return { render, emit, handlers, unsubscribed }
}

function text(seq: number, chunk: string, id = 'req-1'): BridgeEventPayload {
  return { type: 'delta', id, kind: 'text', text: chunk, seq }
}

describe('宿主不吐增量', () => {
  test('一次事件都没有时 live 恒为 null、active 为 false，界面与接这条流之前一致', () => {
    const rig = mount()
    const first = rig.render(undefined)
    assert.deepEqual(first, { live: null, active: false })
    const second = rig.render([])
    assert.deepEqual(second, { live: null, active: false })
    // 只挂了一次监听（effect 没重挂），且还没被退订。
    assert.equal(rig.handlers.length, 1)
    assert.deepEqual(rig.unsubscribed, [])
  })

  test('非 delta 事件不产生任何尾巴', () => {
    const rig = mount()
    rig.render([])
    rig.emit({ type: 'status', text: '无关事件' })
    assert.deepEqual(rig.render([]), { live: null, active: false })
  })
})

describe('逐字尾：权威条目到达前才存在', () => {
  test('正文按片段增长，最终与拼接结果一致', () => {
    const rig = mount()
    rig.render([])
    assert.equal(rig.render([]).live, null)
    rig.emit(text(1, '你'))
    assert.equal(rig.render([]).live?.text, '你')
    rig.emit(text(2, '好'))
    rig.emit(text(3, '呀'))
    const view = rig.render([])
    assert.equal(view.live?.text, '你好呀')
    assert.equal(view.live?.turnKey, 'id:req-1')
    assert.equal(view.active, true)
  })

  test('权威条目一到，live 立刻变 null（同一帧，不留第二份）', () => {
    const rig = mount()
    rig.render([])
    rig.emit(text(1, '你好'))
    rig.emit(text(2, '呀'))
    assert.equal(rig.render([]).live?.text, '你好呀')
    // 这一步模拟"会话更新把权威条目送到"：turn 缺省即当前轮。
    const entries: SessionEntry[] = [{ id: 'e1', seq: 3, role: 'assistant', kind: 'text', text: '你好呀' }]
    assert.equal(rig.render(entries).live, null)
    assert.equal(rig.render(entries).live, null)
  })

  test('提交之后的迟到增量不会把影子重建出来（迟到水位）', () => {
    const rig = mount()
    rig.render([])
    rig.emit(text(1, '你好'))
    rig.emit(text(5, '你好呀'))
    const entries: SessionEntry[] = [{ id: 'e1', seq: 6, role: 'assistant', kind: 'text', text: '你好呀' }]
    assert.equal(rig.render(entries).live, null)
    // 同一条流上又来了更大的 seq：没有水位的话这里会重建一份影子，与权威条目并排。
    rig.emit(text(6, '，还有后半句'))
    assert.equal(rig.render(entries).live, null, '权威条目已经渲染过了，影子不该再出来')
    assert.equal(rig.render(entries).active, false)
  })

  test('换了 epoch 之后新流照常显示（旧水位不拦新会话）', () => {
    const rig = mount()
    rig.render([])
    rig.emit({ type: 'delta', epoch: 'e1', kind: 'text', text: '旧会话', seq: 1 })
    const entries: SessionEntry[] = [{ id: 'e1', seq: 2, role: 'assistant', kind: 'text', text: '旧会话' }]
    assert.equal(rig.render(entries).live, null)
    rig.emit({ type: 'delta', epoch: 'e2', kind: 'text', text: '新会话', seq: 1 })
    assert.equal(rig.render(entries).live?.text, '新会话')
  })

  test('只有思考增量时 live 有内容但正文为空（界面据此显示"思考中…"）', () => {
    const rig = mount()
    rig.render([])
    rig.emit({ type: 'delta', id: 'req-1', kind: 'think', text: '先看目录', seq: 1 })
    const view = rig.render([])
    assert.equal(view.live?.text, '')
    assert.equal(view.live?.think, '先看目录')
  })

  test('屏幕上已经有流式正文条目时不画影子（否则同一句话并排两份）', () => {
    const rig = mount()
    const streaming: SessionEntry[] = [{ id: 'a1', seq: 1, role: 'assistant', kind: 'text', text: '你', streaming: true }]
    assert.deepEqual(rig.render([]).live, null)
    // 先照常长影子
    rig.emit(text(1, '你'))
    assert.equal(rig.render([]).live?.text, '你')
    // 镜像把累积中的条目推过来（streaming:true）：条目自己在逐字，影子必须退场
    assert.equal(rig.render(streaming).live, null)
    // 后续增量继续涌进来也不能让它复活
    rig.emit(text(2, '好'))
    assert.equal(rig.render(streaming).live, null)
  })

  test('只有思考/工具类流式条目时不抑制正文尾巴（它们不占正文那一行）', () => {
    const rig = mount()
    const thinkOnly: SessionEntry[] = [{ id: 'a1', seq: 1, role: 'assistant', kind: 'think', text: '先看目录', streaming: true }]
    rig.render(thinkOnly)
    rig.emit(text(1, '结论是'))
    assert.equal(rig.render(thinkOnly).live?.text, '结论是')
  })

  test('溢出后不再作为活跃尾巴显示（界面另说"内容较长"）', () => {
    const rig = mount()
    rig.render([])
    rig.emit(text(1, 'x'.repeat(deltaLogic.DELTA_LIMITS.maxChars)))
    assert.ok(rig.render([]).live)
    rig.emit(text(2, '再多一个字'))
    assert.equal(rig.render([]).live, null)
  })
})

describe('卸载与重挂', () => {
  test('effect 卸载时退订，重挂不会堆监听', () => {
    const rig = mount()
    rig.render([])
    assert.equal(rig.handlers.length, 1)
    assert.deepEqual(rig.unsubscribed, [])

    // 换一份 entries 不重挂订阅（依赖是 publish，恒定）；只有真正卸载才会退订。
    rig.render([{ id: 'e1', seq: 1, role: 'user', kind: 'text', text: '问一句' }])
    assert.equal(rig.handlers.length, 1, 'entries 变化不该重新订阅')
  })
})
