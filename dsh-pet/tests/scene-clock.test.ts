/**
 * 共享场景时钟的测试。
 *
 * 用 Node 自带的 mock timers 拨表，不真的等 16ms —— 否则一个用例就要睡几十毫秒，
 * 而且在 CI 上定时器精度不稳，断言会变成偶发失败。
 */

import assert from 'node:assert/strict'
import { afterEach, describe, mock, test } from 'node:test'

import {
  isClockRunning,
  resetSceneClock,
  subscribeTick,
  TICK_MS,
  tickSubscriberCount,
} from '../src/renderer/scene-clock.ts'

describe('共享场景时钟', () => {
  afterEach(() => {
    resetSceneClock()
    mock.timers.reset()
  })

  test('没有角色时不跑定时器', () => {
    assert.equal(tickSubscriberCount(), 0)
    assert.equal(isClockRunning(), false)
  })

  test('五个角色只起一个时钟，而不是五个 16ms 定时器', () => {
    mock.timers.enable({ apis: ['setInterval'] })
    const fired: number[] = []
    const offs = Array.from({ length: 5 }, (_, index) =>
      subscribeTick(() => {
        fired.push(index)
      }),
    )
    assert.equal(tickSubscriberCount(), 5)
    assert.equal(isClockRunning(), true)
    mock.timers.tick(TICK_MS)
    assert.deepEqual(fired, [0, 1, 2, 3, 4], '一拍应该把五个角色都推进一次')
    for (const off of offs) off()
  })

  test('每一拍所有订阅者都被叫到', () => {
    mock.timers.enable({ apis: ['setInterval'] })
    let a = 0
    let b = 0
    const offA = subscribeTick(() => {
      a += 1
    })
    const offB = subscribeTick(() => {
      b += 1
    })
    mock.timers.tick(TICK_MS * 3)
    assert.equal(a, 3)
    assert.equal(b, 3)
    offA()
    offB()
  })

  test('最后一个退订后时钟停掉：桌面上没角色就不该有定时器在跑', () => {
    mock.timers.enable({ apis: ['setInterval'] })
    const offA = subscribeTick(() => {})
    const offB = subscribeTick(() => {})
    offA()
    assert.equal(isClockRunning(), true, '还有一个角色在台上')
    offB()
    assert.equal(isClockRunning(), false)
    assert.equal(tickSubscriberCount(), 0)
  })

  test('退订是幂等的，重复调用不会把别人的订阅一起摘掉', () => {
    mock.timers.enable({ apis: ['setInterval'] })
    let b = 0
    const offA = subscribeTick(() => {})
    const offB = subscribeTick(() => {
      b += 1
    })
    offA()
    offA()
    mock.timers.tick(TICK_MS)
    assert.equal(b, 1)
    assert.equal(tickSubscriberCount(), 1)
    offB()
  })

  test('在节拍里新挂载的角色不会在同一拍就被推进', () => {
    mock.timers.enable({ apis: ['setInterval'] })
    let late = 0
    let mounted = false
    // 用数组收集退订句柄：闭包里给 let 赋值会被 tsc 的控制流分析收窄成 never。
    const offs: Array<() => void> = []
    offs.push(
      subscribeTick(() => {
        if (mounted) return
        mounted = true
        offs.push(
          subscribeTick(() => {
            late += 1
          }),
        )
      }),
    )
    mock.timers.tick(TICK_MS)
    assert.equal(late, 0, '这一帧才刚出现的角色不该立刻走一步')
    mock.timers.tick(TICK_MS)
    assert.equal(late, 1)
    for (const off of offs) off()
  })

  test('重新挂载后时钟能再次启动', () => {
    mock.timers.enable({ apis: ['setInterval'] })
    const off = subscribeTick(() => {})
    off()
    assert.equal(isClockRunning(), false)
    let fired = 0
    const offAgain = subscribeTick(() => {
      fired += 1
    })
    assert.equal(isClockRunning(), true)
    mock.timers.tick(TICK_MS * 2)
    assert.equal(fired, 2)
    offAgain()
  })
})
