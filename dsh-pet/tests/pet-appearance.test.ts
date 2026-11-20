/**
 * 宠物「大小 / 透明度」的纯逻辑测试。
 *
 * 这两项看起来只是两个内联样式，但三处最容易错的地方都看不见：
 * 手改设置文件后的归一化、缩放的锚点、以及透明度**不该**作用于哪些元素。
 * 屏幕上看不出来（1.2 倍的脚离地 15px，人会以为是自己眼花了），所以逐条钉在这里。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_PET_OPACITY,
  DEFAULT_PET_SCALE,
  PET_OPACITIES,
  PET_SCALES,
  PET_TRANSFORM_ORIGIN,
  characterTransform,
  normalizePetOpacity,
  normalizePetScale,
  scaledBox,
  surfaceOpacity,
} from '../src/renderer/pet-appearance.ts'

describe('档位与默认值', () => {
  it('大小三档、透明度三档，默认都是原大/不透明', () => {
    assert.deepEqual([...PET_SCALES], [0.8, 1, 1.2])
    assert.deepEqual([...PET_OPACITIES], [0.6, 0.8, 1])
    assert.equal(DEFAULT_PET_SCALE, 1)
    assert.equal(DEFAULT_PET_OPACITY, 1)
  })

  it('合法档位原样保留', () => {
    for (const scale of PET_SCALES) assert.equal(normalizePetScale(scale), scale)
    for (const opacity of PET_OPACITIES) assert.equal(normalizePetOpacity(opacity), opacity)
  })

  it('非法值一律回落默认：手改的 1.5、0.2、字符串、null、NaN', () => {
    for (const value of [1.5, 0.2, 0, -1, '1.5', '0.8', null, undefined, Number.NaN, {}]) {
      assert.equal(normalizePetScale(value), DEFAULT_PET_SCALE, `petScale=${String(value)}`)
      assert.equal(normalizePetOpacity(value), DEFAULT_PET_OPACITY, `petOpacity=${String(value)}`)
    }
  })
})

describe('缩放锚点', () => {
  it('transform 只做 scale，不带位移；origin 是底部中心', () => {
    assert.equal(PET_TRANSFORM_ORIGIN, '50% 100%')
    assert.equal(characterTransform(1.2), 'scale(1.2)')
    assert.equal(characterTransform(0.8), 'scale(0.8)')
    // 非法值进来也不能拼出 scale(1.5) 这种把角色撑大的字符串
    assert.equal(characterTransform(1.5), 'scale(1)')
  })

  it('1.2 倍：底边不动、上边界上涨 20% 高度、左右各外扩 10%', () => {
    const box = { left: 100, top: 400, width: 150, height: 150 }
    const scaled = scaledBox(box, 1.2)
    // 底边 = top + height，必须与缩放前一致 —— 这条决定了"脚不离地"
    assert.equal(scaled.top + scaled.height, box.top + box.height)
    assert.equal(scaled.height, 180)
    assert.equal(scaled.width, 180)
    assert.equal(scaled.top, 550 - 180)
    assert.equal(scaled.left, 100 - 15)
  })

  it('0.8 倍同样以底边为锚：变小是"蹲下"，不是"飘起来"', () => {
    const box = { left: 100, top: 400, width: 150, height: 150 }
    const scaled = scaledBox(box, 0.8)
    assert.equal(scaled.top + scaled.height, box.top + box.height)
    assert.equal(scaled.height, 120)
    assert.equal(scaled.left, 100 + 15)
  })
})

describe('透明度只作用于角色图', () => {
  it('角色吃透明度，工具栏与气泡一律 1', () => {
    assert.equal(surfaceOpacity('character', 0.6), 0.6)
    assert.equal(surfaceOpacity('character', 0.8), 0.8)
    assert.equal(surfaceOpacity('toolbar', 0.6), 1)
    assert.equal(surfaceOpacity('bubble', 0.6), 1)
  })

  it('非法透明度对角色也回落 1（宁可不变淡，也不让人找不到宠物）', () => {
    assert.equal(surfaceOpacity('character', 0.2), 1)
    assert.equal(surfaceOpacity('character', '0.3' as unknown as number), 1)
  })
})
