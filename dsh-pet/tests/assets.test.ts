/**
 * 共享素材缓存的测试：多角色同皮肤时只加载一份素材。
 *
 * 这是"资源限制"那条测试契约的落点。占位期唐僧、沙僧、白龙马的 skinId 都是 panda，
 * 三个角色一起挂载；序列帧探测每皮肤最多 FRAME_ACTIONS×FRAME_MAX 次图片加载，
 * 不去重就是三倍。
 *
 * Node 里没有 DOM，所以这里用一个假的 `Image`：只记录请求、按谓词触发 onload/onerror。
 * 不引 happy-dom/jsdom —— 被测的是缓存去重，不是图片解码。
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import {
  clearPetAssetCache,
  FRAME_ACTIONS,
  FRAME_MAX,
  loadSkinFrames,
  loadSkinImages,
  petAssetCacheStats,
} from '../src/renderer/usePetImage.ts'

const ACTION_COUNT = FRAME_ACTIONS.length

let requests: string[] = []
/** 这个 URL 该不该加载成功。默认全成功，个别测试改成只放行前几帧。 */
let shouldLoad: (url: string) => boolean = () => true
/** 构造 Image 时抛错，用来模拟渲染进程 GPU 合成崩溃那种连对象都建不出来的情况。 */
let imageConstructor: () => void = () => {}

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private url = ''

  constructor() {
    imageConstructor()
  }

  get src(): string {
    return this.url
  }

  set src(value: string) {
    this.url = value
    requests.push(value)
    // 真 Image 是异步解码完才回调；用微任务模拟，否则缓存的并发去重测不出来。
    queueMicrotask(() => {
      if (shouldLoad(value)) this.onload?.()
      else this.onerror?.()
    })
  }
}

/** 序列帧的编号：f001.png → 1。 */
function frameNumberOf(url: string): number {
  return Number(/f(\d+)\.png$/.exec(url)?.[1] ?? 0)
}

const globals = globalThis as { Image?: unknown }
const originalImage = globals.Image

beforeEach(() => {
  requests = []
  shouldLoad = () => true
  imageConstructor = () => {}
  globals.Image = FakeImage
})

afterEach(() => {
  globals.Image = originalImage
  clearPetAssetCache()
})

describe('loadSkinFrames：序列帧探测的去重', () => {
  test('三个同皮肤角色并发挂载只探一遍帧', async () => {
    const [first, second, third] = await Promise.all([
      loadSkinFrames('panda'),
      loadSkinFrames('panda'),
      loadSkinFrames('panda'),
    ])
    assert.equal(requests.length, ACTION_COUNT * FRAME_MAX, '不去重的话这里会是三倍')
    assert.equal(petAssetCacheStats().frames, 1)
    // 缓存的是 Promise 而不是结果，所以三个角色拿到的是同一个对象。
    assert.equal(first, second)
    assert.equal(second, third)
  })

  test('先后挂载也走缓存，不会再探一遍', async () => {
    await loadSkinFrames('panda')
    const probed = requests.length
    await loadSkinFrames('panda')
    assert.equal(requests.length, probed)
  })

  test('不同皮肤各自一条缓存，互不顶掉', async () => {
    await Promise.all([loadSkinFrames('panda'), loadSkinFrames('boy-glasses')])
    assert.equal(petAssetCacheStats().frames, 2)
    assert.equal(requests.length, 2 * ACTION_COUNT * FRAME_MAX)
  })

  test('首帧就没有的皮肤返回空表，并且只探动作数次而不是整轮帧数', async () => {
    shouldLoad = () => false
    const frames = await loadSkinFrames('girl-glasses')
    assert.deepEqual(frames, {})
    assert.equal(requests.length, ACTION_COUNT)
  })

  test('帧数不足上限时在第一个缺口处截断，不把 null 混进帧列表', async () => {
    shouldLoad = (url) => frameNumberOf(url) >= 1 && frameNumberOf(url) <= 3
    const frames = await loadSkinFrames('panda')
    const actions = Object.keys(frames)
    assert.equal(actions.length, ACTION_COUNT)
    for (const action of actions) assert.deepEqual(frames[action]?.length, 3)
    // 探测是 FRAME_MAX 帧一次性并发发出、回来后再截断的，所以请求数不随实际帧数减少。
    assert.equal(requests.length, ACTION_COUNT * FRAME_MAX)
  })
})

describe('loadSkinImages：静态图的去重与失败恢复', () => {
  test('三个同皮肤角色并发挂载只加载一份静态图', async () => {
    const [first, second, third] = await Promise.all([
      loadSkinImages('panda'),
      loadSkinImages('panda'),
      loadSkinImages('panda'),
    ])
    assert.equal(petAssetCacheStats().images, 1)
    assert.equal(first, second)
    assert.equal(second, third)
  })

  test('加载抛错时不把 rejected promise 永久钉在缓存里', async () => {
    imageConstructor = () => {
      throw new Error('渲染进程的 GPU 合成崩了')
    }
    await assert.rejects(() => loadSkinImages('panda'))
    assert.equal(petAssetCacheStats().images, 0, '失败后必须摘掉缓存，否则这个皮肤再也加载不出来')

    imageConstructor = () => {}
    await loadSkinImages('panda')
    assert.equal(petAssetCacheStats().images, 1)
  })

  test('抠图不可用时退化成空表，角色仍有位置、不会崩', async () => {
    // FakeImage 没有 naturalWidth，removeBackground 会直接返回 null；
    // 真实渲染层拿到空表后由 PetSprite 落到内联 SVG。
    const images = await loadSkinImages('panda')
    assert.deepEqual(images, {})
  })
})
