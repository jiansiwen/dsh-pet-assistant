import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { initialInteraction, interactionProtected, nextFrame, oneShot, reduceInteraction, type InteractionState } from '../src/renderer/pet-interaction.ts'

const complete = (s: InteractionState, now = 0) => reduceInteraction(s, { type: 'complete', phase: s.phase, version: s.version }, now)
const tick = (s: InteractionState, now: number, working = false, sleepMinutes = 20) =>
  reduceInteraction(s, { type: 'tick', working, idleMinutes: 2, sleepMinutes }, now)
const start = (id = 1) => reduceInteraction(initialInteraction(0), { type: 'start', id }, 0)

test('短回复提前到达：开电脑完整播放，再写一轮、合电脑、待机', () => {
  let s = start()
  s = reduceInteraction(s, { type: 'reply', id: 1 }, 10)
  assert.equal(s.phase, 'laptop-in')
  assert.equal(tick(s, 120_000).phase, 'laptop-in')
  s = complete(s, 3500)
  assert.equal(s.phase, 'write')
  s = complete(s, 5100)
  assert.equal(s.phase, 'laptop-out')
  s = complete(s, 7400)
  assert.equal(s.phase, 'idle')
  assert.equal(s.round, null)
})

test('等待 AI 时思考，回复后的写字持续到实际播报结束', () => {
  let s = complete(start(), 3500)
  assert.equal(s.phase, 'think')
  s = reduceInteraction(s, { type: 'speech', id: 1, speaking: true }, 4000)
  assert.equal(s.phase, 'think')
  s = reduceInteraction(s, { type: 'reply', id: 1 }, 4010)
  assert.equal(s.phase, 'write')
  assert.equal(complete(s, 6000), s)
  s = reduceInteraction(s, { type: 'speech', id: 1, speaking: false }, 6100)
  assert.equal(complete(s, 7200).phase, 'laptop-out')
})

test('播报在开电脑结束前已完成，仍保留一轮写字', () => {
  let s = start()
  s = reduceInteraction(s, { type: 'reply', id: 1 }, 100)
  s = reduceInteraction(s, { type: 'speech', id: 1, speaking: true }, 100)
  s = reduceInteraction(s, { type: 'speech', id: 1, speaking: false }, 200)
  assert.equal(complete(s).phase, 'write')
  assert.equal(complete(complete(s)).phase, 'laptop-out')
})

test('开电脑或思考阶段出错均能合电脑返回待机', () => {
  for (const initial of [start(), complete(start())]) {
    let s = reduceInteraction(initial, { type: 'stop', id: 1 }, 100)
    if (s.phase === 'laptop-in') s = complete(s)
    assert.equal(s.phase, 'laptop-out')
    assert.equal(complete(s).phase, 'idle')
  }
})

test('拖起后保护动作，松手完整摔坐后回待机，旧完成事件无效', () => {
  let s = reduceInteraction(initialInteraction(0), { type: 'grab' }, 0)
  assert.equal(s.phase, 'drag')
  s = reduceInteraction(s, { type: 'release', moved: true }, 100)
  assert.equal(s.phase, 'drop')
  assert.equal(interactionProtected(s), true)
  assert.equal(tick(s, 500), s)
  const old = s
  s = complete(s, 4000)
  assert.equal(s.phase, 'idle')
  assert.equal(reduceInteraction(s, { type: 'complete', phase: old.phase, version: old.version }, 4010), s)
})

test('会话被拖拽打断后从开电脑恢复，期间到达的回复不会丢失', () => {
  let s = reduceInteraction(start(), { type: 'grab' }, 100)
  s = reduceInteraction(s, { type: 'reply', id: 1 }, 200)
  s = reduceInteraction(s, { type: 'release', moved: true }, 300)
  assert.equal(s.phase, 'drop')
  s = complete(s, 4200)
  assert.equal(s.phase, 'laptop-in')
  assert.equal(complete(s).phase, 'write')
})

test('默认两分钟无互动躺下，长睡不被随机调度或任务投影抢占', () => {
  let s = initialInteraction(0)
  assert.equal(tick(s, 119_999), s)
  s = tick(s, 120_000)
  assert.equal(s.phase, 'sleep-in')
  s = complete(s, 121_800)
  assert.equal(s.phase, 'sleep-loop')
  for (let now = 122_000; now < 1_321_000; now += 3000) {
    assert.equal(interactionProtected(s), true)
    assert.equal(tick(s, now, true), s)
  }
  // 睡够了自己醒：起身演完才回待机，不是躺姿瞬间站起来。
  s = tick(s, 1_321_799)
  assert.equal(s.phase, 'sleep-loop')
  s = tick(s, 1_321_800)
  assert.equal(s.phase, 'sleep-out')
  s = complete(s, 1_324_300)
  assert.equal(s.phase, 'idle')
  assert.equal(tick(s, 1_444_299), s)
  assert.equal(tick(s, 1_444_300).phase, 'sleep-in')
})

test('鼠标或语音唤醒重置清醒期，拖拽和新对话也能直接唤醒', () => {
  const asleep = complete(tick(initialInteraction(0), 120_000), 121_800)
  assert.equal(asleep.phase, 'sleep-loop')
  const standing = reduceInteraction(asleep, { type: 'wake' }, 130_000)
  assert.equal(standing.phase, 'sleep-out')
  const awake = complete(standing, 132_500)
  assert.equal(awake.phase, 'idle')
  assert.equal(tick(awake, 252_499), awake)
  assert.equal(tick(awake, 252_500).phase, 'sleep-in')
  assert.equal(reduceInteraction(asleep, { type: 'grab' }, 130_000).phase, 'drag')
  assert.equal(reduceInteraction(asleep, { type: 'start', id: 2 }, 130_000).phase, 'laptop-in')
  assert.equal(tick(asleep, 185_000, false, 1).phase, 'sleep-out')
})

test('正在工作不入睡，会话中的唤醒不截断电脑动作', () => {
  const working = tick(initialInteraction(0), 200_000, true)
  assert.equal(working.phase, 'idle')
  assert.equal(tick(working, 319_999), working)
  assert.equal(reduceInteraction(start(), { type: 'wake' }, 100).phase, 'laptop-in')
})

test('收电脑期间收到新问题先完整收尾，再开电脑；旧回复不能污染新轮', () => {
  let s = reduceInteraction(complete(start()), { type: 'stop', id: 1 }, 4000)
  const old = s
  s = reduceInteraction(s, { type: 'start', id: 2 }, 4100)
  assert.equal(s.phase, 'laptop-out')
  assert.equal(s.version, old.version)
  assert.equal(reduceInteraction(s, { type: 'reply', id: 1 }, 4200), s)
  assert.equal(reduceInteraction(s, { type: 'speech', id: 1, speaking: false }, 4200), s)
  s = complete(s, 6300)
  assert.equal(s.phase, 'laptop-in')
  assert.equal(reduceInteraction(s, { type: 'complete', phase: old.phase, version: old.version }, 6400), s)
  assert.equal(complete(s).phase, 'think')
})

test('已经坐着时新问题不重播坐下，开电脑途中不重置帧位置', () => {
  for (const initial of [start(), complete(start())]) {
    const s = reduceInteraction(initial, { type: 'start', id: 2 }, 100)
    assert.equal(s.phase, initial.phase)
    assert.equal(s.version, initial.version)
  }
  const writing = reduceInteraction(complete(start()), { type: 'reply', id: 1 }, 100)
  assert.equal(reduceInteraction(writing, { type: 'start', id: 2 }, 200).phase, 'think')
})

test('收电脑期间新回复提前到达不丢失，新轮结束不会重复开电脑', () => {
  let s = reduceInteraction(complete(start()), { type: 'stop', id: 1 }, 100)
  s = reduceInteraction(s, { type: 'start', id: 2 }, 200)
  s = reduceInteraction(s, { type: 'reply', id: 2 }, 300)
  assert.equal(s.phase, 'laptop-out')
  s = complete(s)
  assert.equal(s.phase, 'laptop-in')
  s = complete(s)
  assert.equal(s.phase, 'write')
  s = complete(s)
  assert.equal(s.phase, 'laptop-out')
  assert.equal(complete(s).phase, 'idle')
})

test('出字即敲键盘：第一片增量到达就进入写，整段回复到齐才停', () => {
  let s = complete(start(), 3500)
  assert.equal(s.phase, 'think')
  s = reduceInteraction(s, { type: 'delta', id: 1 }, 3600)
  assert.equal(s.phase, 'write', '第一片增量就该开始敲键盘，不必等整段回复')
  assert.equal(complete(s, 5200), s, '还在出字：写完一轮也不收电脑')
  s = reduceInteraction(s, { type: 'reply', id: 1 }, 5300)
  assert.equal(s.phase, 'write')
  assert.equal(complete(s, 7000).phase, 'laptop-out', '整段到齐且写完一轮才收电脑')
})

test('开电脑途中就来增量：不重播坐下，播完直接开始写', () => {
  let s = reduceInteraction(start(), { type: 'delta', id: 1 }, 100)
  assert.equal(s.phase, 'laptop-in')
  assert.equal(complete(s, 3600).phase, 'write')
})

test('旧一轮的增量与回复都不能污染新一轮', () => {
  let s = reduceInteraction(complete(start()), { type: 'stop', id: 1 }, 100)
  s = reduceInteraction(s, { type: 'start', id: 2 }, 200)
  assert.equal(s.phase, 'laptop-out')
  assert.equal(reduceInteraction(s, { type: 'delta', id: 1 }, 300), s, '旧增量无效')
  assert.equal(reduceInteraction(s, { type: 'reply', id: 1 }, 300), s, '旧回复无效')
  s = complete(s, 2500)
  assert.equal(s.phase, 'laptop-in')
  const opened = reduceInteraction(s, { type: 'delta', id: 2 }, 2600)
  assert.equal(opened.version, s.version, '开电脑途中不重置帧位置')
  assert.equal(complete(opened, 6000).phase, 'write', '新一轮已经出过字，开完电脑直接写')
})

test('一次动作按真实帧数播满，末帧不回绕；循环素材正常循环', () => {
  for (const [action, count] of [['drop', 39], ['laptop-in', 35], ['laptop-out', 23], ['sleep-in', 18], ['sleep-out', 25]] as const) {
    let index = 0
    for (let frame = 1; frame <= count; frame++) {
      const next = nextFrame(index, count, oneShot(action))
      assert.equal(next.complete, frame === count)
      index = next.index
    }
    assert.equal(index, count - 1)
  }
  for (const [action, count] of [['sleep', 23], ['sleep-loop', 22], ['think', 60], ['grab', 18]] as const) {
    assert.equal(nextFrame(count - 1, count, oneShot(action)).index, 0)
  }
})

test('真实设置持久化：默认值、上下限、非法类型和数值归一化', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pet-sleep-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  t.mock.module('electron', { namedExports: { app: { getPath: () => dir } } })
  t.mock.module(new URL('../src/main/document.ts', import.meta.url).href, { namedExports: { MAX_RECENT_DIRS: 20 } })
  t.mock.module(new URL('../src/main/runtime-launch.ts', import.meta.url).href, { namedExports: { isSafeProfileName: () => true } })
  const { loadSettings, saveSettings } = await import('../src/main/settings.ts')
  assert.equal(loadSettings().idleSleepMinutes, 2)
  assert.equal(loadSettings().sleepMinutes, 20)
  assert.equal(saveSettings({ sleepMinutes: 1 }).sleepMinutes, 1)
  assert.equal(saveSettings({ sleepMinutes: 120 }).sleepMinutes, 120)
  for (const value of [0, 121, -1, 1.5, NaN, Infinity, '20', null]) {
    const saved = saveSettings({ idleSleepMinutes: value as number, sleepMinutes: value as number })
    assert.equal(saved.idleSleepMinutes, 2)
    assert.equal(saved.sleepMinutes, 20)
  }
})
