import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import ts from 'typescript'
import * as interaction from '../src/renderer/pet-interaction.ts'

const source = readFileSync(new URL('../src/renderer/PetSprite.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ES2022 } }).outputText + '\nmodule.exports.__VideoSequence = VideoSequence;'
const require = createRequire(import.meta.url)

/** 使用假的媒体元素驱动真实组件的 Hook，不访问屏幕或音频设备。 */
function fixture(t: TestContext) {
  const slots: unknown[] = [], cleanups = new Map<number, () => void>()
  const timers = new Map<number, { callback: () => void; delay: number }>()
  let cursor = 0, timerId = 0, effects: Array<() => void> = []
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout: (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { callback, delay }); return id },
    setInterval: (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { callback, delay }); return id },
    clearTimeout: (id: number) => timers.delete(id), clearInterval: (id: number) => timers.delete(id),
  } })
  const changed = (a: unknown[], b: unknown[]) => a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))
  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial
      return [slots[index], (value: T | ((previous: T) => T)) => {
        slots[index] = typeof value === 'function' ? (value as (previous: T) => T)(slots[index] as T) : value
      }]
    },
    useRef<T>(value: T) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: value }
      return slots[index]
    },
    useCallback<T>(value: T, deps: unknown[]) {
      const index = cursor++, previous = slots[index] as { value: T; deps: unknown[] } | undefined
      if (!previous || changed(previous.deps, deps)) slots[index] = { value, deps }
      return (slots[index] as { value: T }).value
    },
    useEffect(callback: () => void | (() => void), deps: unknown[]) {
      const index = cursor++, previous = slots[index] as unknown[] | undefined
      if (previous && !changed(previous, deps)) return
      slots[index] = deps
      effects.push(() => {
        cleanups.get(index)?.()
        cleanups.delete(index)
        const cleanup = callback()
        if (cleanup) cleanups.set(index, cleanup)
      })
    },
  }
  const module = { exports: {} as {
    default(props: Record<string, unknown>): ReactNode
    __VideoSequence(props: Record<string, unknown>): ReactNode
  } }
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (name === 'react') return hooks
    if (name === './pet-interaction.js') return interaction
    return require(name)
  }, module, module.exports)
  t.after(() => {
    cleanups.forEach(cleanup => cleanup())
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  function render(fn: () => ReactNode, attach?: (node: ReactElement<Record<string, unknown>>) => void) {
    cursor = 0
    const node = fn()
    assert.ok(isValidElement<Record<string, unknown>>(node))
    attach?.(node)
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return node
  }
  return { module: module.exports, render, timers }
}

function videoElement(t: TestContext, play: () => Promise<void>, active = true) {
  const f = fixture(t), failures: string[] = []
  let calls = 0, pauses = 0
  const fake = { currentTime: 0, readyState: 0, paused: true, ended: false, play: () => { calls++; return play() }, pause: () => { pauses++ } }
  let props: Record<string, unknown> = { src: 'grab.webm', loop: true, active, fadeMs: 100, onFailure: () => failures.push('失败') }
  const render = () => f.render(() => f.module.__VideoSequence(props), node => {
    const ref = (node as ReactElement & { ref: { current: unknown } }).ref
    ref.current = fake
  })
  let element = render()
  return { failures, fake, timers: f.timers, get calls() { return calls }, get pauses() { return pauses }, get element() { return element },
    update(next: Record<string, unknown>) { props = { ...props, ...next }; element = render() } }
}

function sprite(t: TestContext, props: Record<string, unknown>) {
  const f = fixture(t)
  let current = props
  const render = () => f.render(() => f.module.default(current))
  let node = render()
  const pose = () => {
    const child = node.props.children
    assert.ok(isValidElement<Record<string, unknown>>(child))
    return child
  }
  return { f, get node() { return node }, pose,
    update(next: Record<string, unknown> = {}) { current = { ...current, ...next }; node = render() },
    fail(src: string) {
      const callback = pose().props.onVideoFailure
      assert.equal(typeof callback, 'function')
      ;(callback as (src: string) => void)(src)
      node = render()
    } }
}

test('当前视频播放被拒绝时报告失败一次，不回显异常内容', async t => {
  const view = videoElement(t, () => Promise.reject(new Error('内部测试信息')))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(view.failures, ['失败'])
  const calls = view.calls
  ;(view.element.props.onCanPlay as () => void)()
  assert.equal(view.calls, calls, '已判定失败的素材不能再次自行发起播放')
})

test('旧视频停用后迟到的播放失败不能污染新动作，也不能自行重新播放', async t => {
  const reject: Array<(error: Error) => void> = []
  const view = videoElement(t, () => new Promise((_resolve, fail) => reject.push(fail)))
  assert.ok(view.calls > 0)
  view.update({ active: false })
  const stoppedCalls = view.calls
  for (const fail of reject) fail(new Error('迟到的播放失败'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(view.failures, [])
  assert.ok(view.pauses > 0)
  ;(view.element.props.onCanPlay as () => void)()
  assert.equal(view.calls, stoppedCalls, '已经淡出的旧视频不能再次播放')
})

test('当前视频解码错误只报告一次，非当前视频错误不影响新动作', t => {
  const view = videoElement(t, async () => {})
  assert.equal(typeof view.element.props.onError, 'function')
  ;(view.element.props.onError as () => void)()
  ;(view.element.props.onError as () => void)()
  assert.deepEqual(view.failures, ['失败'])
  view.update({ active: false })
  ;(view.element.props.onError as () => void)()
  assert.deepEqual(view.failures, ['失败'])
})

test('播放承诺成功但视频始终不动时及时降级，不无限卡在首帧', t => {
  const view = videoElement(t, async () => {})
  const watchdog = [...view.timers.values()].find(item => item.delay === 2500)
  assert.ok(watchdog)
  watchdog.callback()
  assert.deepEqual(view.failures, ['失败'])
})

test('视频已推进或已停用时，不把等待检测误判成失败', t => {
  const view = videoElement(t, async () => {})
  const watchdog = [...view.timers.values()].find(item => item.delay === 2500)
  assert.ok(watchdog)
  view.fake.paused = false
  view.fake.currentTime = 0.5
  ;(view.element.props.onTimeUpdate as () => void)()
  watchdog.callback()
  assert.deepEqual(view.failures, [])
  view.update({ active: false })
  watchdog.callback()
  assert.deepEqual(view.failures, [])
})

test('已加载的旧视频重新成为当前层时重新报告就绪', t => {
  const view = videoElement(t, async () => {})
  let ready = 0
  view.update({ onReady: () => { ready++ }, active: false })
  view.fake.readyState = 4
  view.update({ active: true })
  const timer = [...view.timers.values()].find(item => item.delay === 40)
  assert.ok(timer)
  timer.callback()
  assert.equal(ready, 1)
})

test('挣扎视频不可用时使用静态形象和持续挣扎降级，其他动作视频不被连带禁用', t => {
  const view = sprite(t, { skin: 'panda', images: { idle: 'idle.png' }, frames: {},
    videos: { idle: 'idle.webm', grab: 'grab.webm', jump: 'jump.webm' }, action: 'idle', dragging: true })
  assert.equal((view.pose().props.pose as { kind: string; action: string }).action, 'grab')
  view.fail('grab.webm')
  assert.match(String(view.node.props.className), /pet-grab-fallback/u)
  assert.equal((view.pose().props.pose as { kind: string }).kind, 'img')
  view.update({ dragging: false, action: 'jump' })
  assert.doesNotMatch(String(view.node.props.className), /pet-grab-fallback/u)
  assert.equal((view.pose().props.pose as { kind: string; src: string }).src, 'jump.webm')
})

test('挣扎视频失败时优先使用可用的挣扎帧，不叠加静态降级', t => {
  const view = sprite(t, { skin: 'panda', images: { idle: 'idle.png' }, frames: { grab: ['frame-1', 'frame-2'] },
    videos: { grab: 'grab.webm' }, action: 'idle', dragging: true })
  view.fail('grab.webm')
  assert.equal((view.pose().props.pose as { kind: string }).kind, 'frames')
  assert.doesNotMatch(String(view.node.props.className), /pet-grab-fallback/u)
})

test('只有待机视频且没有挣扎素材时仍有降级动作，不让角色消失', t => {
  const view = sprite(t, { skin: 'panda', images: {}, frames: {}, videos: { idle: 'idle.webm' }, action: 'idle', dragging: true })
  assert.match(String(view.node.props.className), /pet-grab-fallback/u)
  assert.equal((view.pose().props.pose as { kind: string; src: string }).src, 'idle.webm')
})

test('睡眠过渡视频失败后按合理时长完成，不能零间隔刷回调', t => {
  const completed: Array<[string, number]> = []
  const view = sprite(t, { skin: 'panda', images: { idle: 'idle.png' }, frames: {}, videos: { 'sleep-in': 'sleep-in.webm' },
    action: 'sleep-in', animationVersion: 4, onComplete: (action: string, version: number) => completed.push([action, version]) })
  view.fail('sleep-in.webm')
  const timer = [...view.f.timers.values()].find(item => item.delay === 1800)
  assert.ok(timer)
  timer.callback()
  assert.deepEqual(completed, [['sleep-in', 4]])
})
