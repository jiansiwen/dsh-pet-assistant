/**
 * 边缘吸附与停靠态的纯逻辑测试。
 *
 * 这类"差几像素"的规则在界面上几乎无法验收：吸附到哪一侧、圆点显示哪个状态，都只有
 * 一个正确答案，错了也不会崩 —— 只会让人觉得"它不听话"。所以逐条钉死。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DOCK_INSET,
  DOCK_SIZE,
  DOCK_THRESHOLD,
  DOCK_TONES,
  dockEdge,
  dockPosition,
  dockStatusTone,
  isDockClick,
} from '../src/renderer/pet-dock.ts'

const workArea = { left: 0, top: 0, width: 1920, height: 1040 }
const pet = (left: number, top: number) => ({ left, top, width: 150, height: 150 })

describe('吸附判定：距边 ≤8px', () => {
  it('四边各一条：贴到边上算吸附', () => {
    assert.equal(dockEdge(pet(0, 400), workArea), 'left')
    assert.equal(dockEdge(pet(1920 - 150, 400), workArea), 'right')
    assert.equal(dockEdge(pet(800, 0), workArea), 'top')
    assert.equal(dockEdge(pet(800, 1040 - 150), workArea), 'bottom')
  })

  /**
   * 阈值从 24 收到 8：24px 在 1920 宽屏上只有 1.2%，拖动时手一抖就进去了，
   * 用户收到的不是"收起了"而是"我的宠物不见了"（真机报障）。8px 要求"明确贴边"。
   */
  it('刚好 8px 吸附，9px 不吸附', () => {
    assert.equal(DOCK_THRESHOLD, 8)
    assert.equal(dockEdge(pet(8, 400), workArea), 'left')
    assert.equal(dockEdge(pet(9, 400), workArea), null)
  })

  it('9px 也不再吸附：手抖一下不会把宠物收走', () => {
    for (const offset of [9, 12, 20, 24]) {
      assert.equal(dockEdge(pet(offset, 400), workArea), null, `${offset}px 不该吸附`)
    }
  })

  it('远离所有边 → 不吸附', () => {
    assert.equal(dockEdge(pet(800, 400), workArea), null)
  })

  it('角落同时满足两边时取更近的那条', () => {
    // 距左 10px、距上 3px → 上边更近
    assert.equal(dockEdge(pet(10, 3), workArea), 'top')
    // 距左 3px、距上 10px → 左边更近
    assert.equal(dockEdge(pet(3, 10), workArea), 'left')
  })

  it('工作区有偏移（任务栏/副屏）时按偏移后的边界算', () => {
    const shifted = { left: 100, top: 50, width: 800, height: 600 }
    assert.equal(dockEdge(pet(100, 300), shifted), 'left')
    assert.equal(dockEdge(pet(900 - 150, 300), shifted), 'right')
    assert.equal(dockEdge(pet(400, 0), shifted), 'top')     // 在工作区上方 → 距离为负，按 0 处理即吸附
    assert.equal(dockEdge(pet(400, 50), shifted), 'top')
  })
})

describe('停靠位置：内边距 8px、另一边取中心', () => {
  it('左边：贴左 8px，垂直居中于原位置', () => {
    const position = dockPosition('left', pet(0, 400), workArea)
    assert.equal(position.left, DOCK_INSET)
    assert.equal(position.top, 400 + 150 / 2 - DOCK_SIZE / 2)
  })

  it('右边：贴右 8px', () => {
    const position = dockPosition('right', pet(1770, 400), workArea)
    assert.equal(position.left, 1920 - DOCK_INSET - DOCK_SIZE)
    assert.equal(position.top, 475 - 24)
  })

  it('上边：贴上 8px，水平居中于原位置', () => {
    const position = dockPosition('top', pet(800, 0), workArea)
    assert.equal(position.top, DOCK_INSET)
    assert.equal(position.left, 800 + 75 - 24)
  })

  it('下边：贴下 8px', () => {
    const position = dockPosition('bottom', pet(800, 890), workArea)
    assert.equal(position.top, 1040 - DOCK_INSET - DOCK_SIZE)
  })

  it('原位置在工作区外时夹回可见范围（拔掉副屏后的常见情形）', () => {
    const position = dockPosition('left', pet(-500, -300), workArea)
    assert.ok(position.left >= DOCK_INSET)
    assert.ok(position.top >= DOCK_INSET)
  })
})

describe('状态点优先级：错误 > 录音 > 待批 > 空闲', () => {
  it('全组合', () => {
    assert.equal(dockStatusTone({}), 'idle')
    assert.equal(dockStatusTone({ pendingApproval: true }), 'pending')
    assert.equal(dockStatusTone({ recording: true }), 'recording')
    assert.equal(dockStatusTone({ error: true }), 'error')
    // 同时成立时按优先级取最高的那个
    assert.equal(dockStatusTone({ recording: true, pendingApproval: true }), 'recording')
    assert.equal(dockStatusTone({ error: true, recording: true }), 'error')
    assert.equal(dockStatusTone({ error: true, recording: true, pendingApproval: true }), 'error')
  })

  it('四种状态点的颜色与呼吸：只有录音在呼吸', () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(DOCK_TONES).map(([tone, value]) => [tone, [value.color, value.breathing]])),
      {
        error: ['#dc2626', false],
        recording: ['#ef4444', true],
        pending: ['#f59e0b', false],
        idle: ['#c9ccd3', false],
      },
    )
  })
})

describe('单击与拖拽的区分', () => {
  it('位移 ≤4px 算单击，>4px 算拖拽', () => {
    assert.equal(isDockClick(0, 0), true)
    assert.equal(isDockClick(3, 2), true)
    assert.equal(isDockClick(4, 0), true)
    assert.equal(isDockClick(0, 5), false)
    assert.equal(isDockClick(10, 10), false)
    assert.equal(isDockClick(20, 0), false)
  })

  /**
   * 触摸类指针在调用处放宽到 10px：手指点击的落点漂移普遍 5–10px，
   * 用 4px 会"点了没反应"，而这个按钮唯一的作用就是单击。
   * 这里钉的是"传入更大容差时判定确实跟着放宽"，避免调用处白改。
   */
  it('容差可传入：触摸放宽到 10px 后，5px 位移算点击', () => {
    assert.equal(isDockClick(0, 5, 10), true)
    assert.equal(isDockClick(5, 5, 10), true)
    assert.equal(isDockClick(0, 11, 10), false)
  })
})
