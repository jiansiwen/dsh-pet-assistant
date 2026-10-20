/**
 * 预合成（prefetch）的行为契约：句号后的静默由它压掉。
 *
 * 现场问题是"每个句号后面空一大段"：原来上一句播完才开始合成下一句，网络合成的一次往返
 * 就落在两句之间的空档里。预合成让下一句的音频在当前句播放期间就准备好。
 *
 * 注意区分两条路：正常播完走 finished（缓存保留、下一句直接用），打断走 stop（缓存作废）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TtsEdgeEngine, type WorkerEvent } from '../src/main/tts-edge-worker.ts'
import type { ResolvedVoiceApi } from '../src/voice-api-types.ts'

type Deps = ConstructorParameters<typeof TtsEdgeEngine>[0]

function makeEngine() {
  const events: WorkerEvent[] = []
  const synthesized: string[] = []
  const plays: Array<(completed: boolean) => void> = []
  const deps: Deps = {
    synthesize: async (text) => {
      synthesized.push(text)
      return Buffer.from(`音频:${text}`)
    },
    play: (_audio, done) => { plays.push(done) },
    fallback: () => undefined,
    stopAudio: () => undefined,
    emit: event => { events.push(event) },
  }
  return { engine: new TtsEdgeEngine(deps), events, plays, synthesized }
}

const api: ResolvedVoiceApi = {
  id: '00000000-0000-4000-8000-000000000000', kind: 'tts', name: 'mimo', endpoint: 'https://example.com/v1/chat/completions',
  model: 'mimo-v2.5-tts', voice: '冰糖', apiKey: 'k', provider: 'mimo',
}

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

test('派发当前句时捎带下一句，播放期间就把下一句合成好', async () => {
  const { engine, synthesized } = makeEngine()
  engine.speak('u#0', '第一句。', api, { id: 'u#1', text: '第二句。', api })
  await tick()
  // 当前句先合成、下一句随后预取。
  assert.deepEqual(synthesized, ['第一句。', '第二句。'])
})

test('正常播完后下一句直接用预取结果，不再重复请求合成', async () => {
  const { engine, synthesized, plays } = makeEngine()
  engine.speak('u#0', '第一句。', api, { id: 'u#1', text: '第二句。', api })
  await tick()
  assert.equal(plays.length, 1)
  // 第一句播完：走 finished（不是 stop）。
  plays[0](true)
  engine.speak('u#1', '第二句。', api)
  await tick()
  assert.deepEqual(synthesized.filter(text => text === '第二句。'), ['第二句。'])
  assert.equal(plays.length, 2)
})

test('打断（stop）会作废预取缓存，旧内容不会播到下一轮', async () => {
  const { engine, synthesized } = makeEngine()
  engine.speak('u#0', '第一句。', api, { id: 'u#1', text: '第二句。', api })
  await tick()
  engine.stop()
  engine.speak('u#1', '第二句。', api)
  await tick()
  assert.deepEqual(synthesized.filter(text => text === '第二句。'), ['第二句。', '第二句。'])
})

test('没有下一句时不预取，也不报错', async () => {
  const { engine, synthesized, events } = makeEngine()
  engine.speak('u#0', '只有一句。', api)
  await tick()
  assert.deepEqual(synthesized, ['只有一句。'])
  assert.equal(events.some(event => 'error' in event), false)
})

test('预取失败不影响当前句，派发时再合成一次', async () => {
  const events: WorkerEvent[] = []
  const synthesized: string[] = []
  const plays: Array<(completed: boolean) => void> = []
  let prefetchFailed = false
  const engine = new TtsEdgeEngine({
    synthesize: async (text) => {
      synthesized.push(text)
      // 第二句第一次（预取）失败，第二次（真正派发）成功。
      if (text === '第二句。' && !prefetchFailed) {
        prefetchFailed = true
        throw new Error('预取失败')
      }
      return Buffer.from('音频')
    },
    play: (_audio, done) => { plays.push(done) },
    fallback: () => undefined,
    stopAudio: () => undefined,
    emit: event => { events.push(event) },
  })
  engine.speak('u#0', '第一句。', api, { id: 'u#1', text: '第二句。', api })
  await tick()
  // 第一句正常播完，才能派第二句（否则是 busy）。
  plays[0](true)
  await tick()
  engine.speak('u#1', '第二句。', api)
  await tick()
  assert.deepEqual(synthesized, ['第一句。', '第二句。', '第二句。'])
  assert.equal(events.some(event => 'error' in event), false)
})
