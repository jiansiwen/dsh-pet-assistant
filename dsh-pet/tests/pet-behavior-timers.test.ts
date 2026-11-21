import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
import ts from 'typescript'
import { manifestFor, type CharacterLines } from '../src/renderer/character-manifest.ts'
import * as interaction from '../src/renderer/pet-interaction.ts'
import * as metrics from '../src/renderer/pet-metrics.ts'
import type { PetBehavior, PetBehaviorOptions } from '../src/renderer/usePetBehavior.ts'

const source = readFileSync(new URL('../src/renderer/usePetBehavior.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const require = createRequire(import.meta.url)

/** 使用虚拟时钟和最小 Hook 驱动真实行为代码；不启动桌面、摄像头或音频。 */
function mount(t: TestContext, initial: PetBehaviorOptions, random = 0.58) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.parse('2026-10-27T10:00:00Z') })
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousRandom = Math.random
  Math.random = () => random
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    innerWidth: 1920, innerHeight: 1080,
    setTimeout, clearTimeout, setInterval, clearInterval,
  } })
  const slots: unknown[] = []
  const cleanups = new Map<number, () => void>()
  let cursor = 0
  let effects: Array<() => void> = []
  let props = initial
  let behavior: PetBehavior
  const changed = (a: unknown[], b: unknown[]) => a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))
  const hooks = {
    useState<T>(initialValue: T | (() => T)) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue
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
      const index = cursor++
      const previous = slots[index] as { value: T; deps: unknown[] } | undefined
      if (!previous || changed(previous.deps, deps)) slots[index] = { value, deps }
      return (slots[index] as { value: T }).value
    },
    useEffect(callback: () => void | (() => void), deps: unknown[]) {
      const index = cursor++
      const previous = slots[index] as unknown[] | undefined
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
  const module = { exports: {} as { usePetBehavior(options: PetBehaviorOptions): PetBehavior; resetSpeechArbiter(): void } }
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (name === 'react') return hooks
    if (name === './pet-metrics.js') return metrics
    if (name === './pet-interaction.js') return interaction
    if (name === './scene-clock.js') return { subscribeTick: (callback: () => void) => {
      const timer = setInterval(callback, 16)
      return () => clearInterval(timer)
    } }
    return require(name)
  }, module, module.exports)
  module.exports.resetSpeechArbiter()
  function render() {
    cursor = 0
    behavior = module.exports.usePetBehavior(props)
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return behavior
  }
  render()
  t.after(() => {
    cleanups.forEach(cleanup => cleanup())
    Math.random = previousRandom
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    t.mock.timers.reset()
  })
  return {
    get behavior() { return behavior },
    update(next: Partial<PetBehaviorOptions>) { props = { ...props, ...next }; render() },
    seconds(count: number, lines?: () => CharacterLines) {
      for (let i = 0; i < count; i++) {
        t.mock.timers.tick(1000)
        if (lines) props = { ...props, lines: lines() }
        render()
      }
    },
    /** 逐帧驱动（16ms tick + 渲染）：走路这类每帧读 xRef 的逻辑需要真实帧率才能推进。 */
    frames(count: number) {
      for (let i = 0; i < count; i++) {
        t.mock.timers.tick(16)
        render()
      }
    },
    render,
  }
}

test('已知熊猫每秒重渲染时仍会触发随机动作', t => {
  const lines = () => manifestFor({ assistantId: 'member-tangseng' }).lines
  const pet = mount(t, { lines: lines() })
  pet.seconds(5, lines)
  assert.equal(pet.behavior.action, 'jump')
})

test('自定义成员的台词每秒重新生成也不能不断推迟随机动作', t => {
  const lines = () => manifestFor({ assistantId: 'custom-member' }).lines
  const pet = mount(t, { lines: lines() })
  pet.seconds(8, lines)
  assert.equal(pet.behavior.action, 'jump')
})

test('台词变化后随机发言使用最新内容，不重置生活计时', t => {
  const lines = () => ({ ...manifestFor({ assistantId: 'custom-member' }).lines, idle: ['最新台词'] })
  const pet = mount(t, { lines: { ...lines(), idle: ['旧台词'] } }, 0.1)
  pet.seconds(4, lines)
  assert.equal(pet.behavior.bubble, '最新台词')
})

test('swagger 向右走：镜像翻面、位置右移、走到收步', t => {
  const lines = () => manifestFor({ assistantId: 'member-tangseng' }).lines
  const right = mount(t, { lines: lines(), randomActions: ['swagger'], home: { x: 100, y: 900 } }, 0.99)
  for (let i = 0; i < 12 && right.behavior.action !== 'swagger'; i++) right.seconds(1, lines)
  assert.equal(String(right.behavior.action), 'swagger')
  right.frames(60)
  assert.equal(right.behavior.facing, -1, '视频朝左，向右走应镜像')
  assert.ok(right.behavior.x > 100, '向右走位置应右移')
  let sawStopR = false
  for (let i = 0; i < 80; i++) {
    right.frames(5)
    if (right.behavior.action === 'swagger-stop') {
      sawStopR = true
      right.behavior.completeAnimation('swagger-stop', right.behavior.animationVersion)
      right.render()
    }
    if (sawStopR && right.behavior.action === 'idle') break
  }
  assert.ok(sawStopR, '到站应演 swagger-stop 收步再回 idle')
  assert.equal(right.behavior.action, 'idle')
})

test('swagger 向左走：不镜像、位置左移、走到收步', t => {
  const lines = () => manifestFor({ assistantId: 'member-tangseng' }).lines
  const left = mount(t, { lines: lines(), randomActions: ['swagger'], home: { x: 1800, y: 900 } }, 0.3)
  for (let i = 0; i < 12 && left.behavior.action !== 'swagger'; i++) left.seconds(1, lines)
  assert.equal(String(left.behavior.action), 'swagger')
  left.frames(60)
  assert.equal(left.behavior.facing, 1, '向左走不镜像')
  assert.ok(left.behavior.x < 1800, '向左走位置应左移')
  let sawStopL = false
  for (let i = 0; i < 80; i++) {
    left.frames(5)
    if (left.behavior.action === 'swagger-stop') {
      sawStopL = true
      left.behavior.completeAnimation('swagger-stop', left.behavior.animationVersion)
      left.render()
    }
    if (sawStopL && left.behavior.action === 'idle') break
  }
  assert.ok(sawStopL, '到站应演 swagger-stop 收步再回 idle')
  assert.equal(left.behavior.action, 'idle')
})

test('随机走路落点太近时推远，不会刚迈步就收步', t => {
  const lines = () => manifestFor({ assistantId: 'member-tangseng' }).lines
  const pet = mount(t, { lines: lines(), randomActions: ['walk'], home: { x: 960, y: 900 } }, 0.5)
  for (let i = 0; i < 12 && pet.behavior.action !== 'walk'; i++) pet.seconds(1, lines)
  assert.equal(String(pet.behavior.action), 'walk')
  pet.frames(30)
  assert.equal(String(pet.behavior.action), 'walk', '0.5 秒后仍应在走，落点至少 60px')
  assert.ok(Math.abs(pet.behavior.x - 960) > 10, '位置应明显离开起点')
  let sawStop = false
  for (let i = 0; i < 30; i++) {
    pet.frames(6)
    if (pet.behavior.action === 'walk-stop') {
      sawStop = true
      //  harness 没挂 PetSprite：手动模拟精灵播完收步的完成回调。
      pet.behavior.completeAnimation('walk-stop', pet.behavior.animationVersion)
      pet.render()
    }
    if (sawStop && pet.behavior.action === 'idle') break
  }
  assert.ok(sawStop, '走到后应演收步再回 idle，不硬切')
  assert.equal(pet.behavior.action, 'idle')
})

test('走路进行到一半不打盹，走完后才允许入睡', t => {
  const lines = () => manifestFor({ assistantId: 'member-tangseng' }).lines
  const pet = mount(t, { lines: lines(), randomActions: ['walk'], home: { x: 960, y: 900 }, idleSleepMinutes: 0.083 }, 0.5)
  for (let i = 0; i < 12 && pet.behavior.action !== 'walk'; i++) pet.seconds(1, lines)
  assert.equal(String(pet.behavior.action), 'walk')
  pet.frames(30)
  assert.equal(String(pet.behavior.action), 'walk', '空闲阈值已过但走路中不能睡')
  pet.frames(150)
  if (pet.behavior.action === 'walk-stop') {
    pet.behavior.completeAnimation('walk-stop', pet.behavior.animationVersion)
    pet.render()
  }
  pet.frames(60)
  assert.equal(pet.behavior.action, 'sleep-in', '走完收步后才入睡')
})

test('场景占用时随机动作让路，释放后恢复', t => {
  const pet = mount(t, { lines: manifestFor({ assistantId: 'member-tangseng' }).lines, sceneBound: true })
  pet.seconds(6)
  assert.equal(pet.behavior.action, 'idle')
  pet.update({ sceneBound: false })
  pet.seconds(5)
  assert.equal(pet.behavior.action, 'jump')
})

test('任务完成或场景强制的开心动作演完后恢复随机行为', t => {
  const pet = mount(t, { lines: manifestFor({ assistantId: 'member-tangseng' }).lines })
  pet.behavior.force('happy')
  pet.render()
  assert.equal(pet.behavior.action, 'happy')
  pet.seconds(8)
  assert.equal(pet.behavior.action, 'jump', '开心动画结束后不能永远卡在站姿')
})

test('过期的开心动作计时不能覆盖更新的动作，退场冻结仍可强制动作', t => {
  const pet = mount(t, { lines: manifestFor({ assistantId: 'member-tangseng' }).lines })
  pet.behavior.force('happy')
  pet.render()
  pet.seconds(1)
  pet.behavior.force('write')
  pet.render()
  pet.seconds(2)
  assert.equal(pet.behavior.action, 'write')
  pet.behavior.freeze()
  pet.render()
  pet.behavior.force('happy')
  pet.render()
  pet.seconds(6)
  assert.equal(pet.behavior.action, 'happy')
})

test('拖拽保持交互保护，松开落地后恢复随机行为', t => {
  const pet = mount(t, { lines: manifestFor({ assistantId: 'member-tangseng' }).lines })
  pet.behavior.startDrag()
  pet.render()
  pet.behavior.dragMove(300, 300)
  pet.behavior.dragMove(350, 320)
  pet.render()
  assert.equal(pet.behavior.dragging, true)
  assert.equal(pet.behavior.protected, true)
  pet.seconds(8)
  assert.equal(pet.behavior.action, 'idle', '拖拽期间随机动作不能抢占挣扎素材')
  assert.equal(pet.behavior.endDrag(), true)
  pet.render()
  assert.equal(pet.behavior.dragging, false)
  assert.equal(pet.behavior.action, 'drop')
  pet.behavior.completeAnimation('drop', pet.behavior.animationVersion)
  pet.render()
  pet.seconds(5)
  assert.equal(pet.behavior.action, 'jump')
})

test('工作与睡眠保护不会被随机动作覆盖，醒来后恢复', t => {
  const lines = manifestFor({ assistantId: 'member-tangseng' }).lines
  const pet = mount(t, { lines, idleSleepMinutes: 0.05 })
  pet.seconds(3)
  assert.equal(pet.behavior.action, 'sleep-in')
  pet.behavior.completeAnimation('sleep-in', pet.behavior.animationVersion)
  pet.render()
  pet.seconds(5)
  assert.equal(pet.behavior.action, 'sleep-loop')
  pet.behavior.wake()
  pet.render()
  assert.equal(pet.behavior.action, 'sleep-out')
  pet.behavior.completeAnimation('sleep-out', pet.behavior.animationVersion)
  pet.render()
  pet.update({ working: true })
  pet.seconds(5)
  assert.equal(pet.behavior.action, 'write')
})
