/**
 * 悬停快捷工具栏的时序测试。
 *
 * 这套时序的失败模式全是"差一拍"：从宠物挪向工具栏时必然先离开宠物，若那一刻就收起，
 * 工具栏会在指针底下消失，用户永远点不到按钮。这类手感靠开壳看不出来（人也按不准 400ms），
 * 只能逐条钉住。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  HOVER_CLOSE_MS,
  HOVER_OPEN_MS,
  hoverActions,
  initialHover,
  reduceHover,
  type HoverEventKind,
  type HoverState,
} from '../src/renderer/hover-toolbar.ts'

function run(kinds: Array<[HoverEventKind, number]>, enabled = true, from: HoverState = initialHover(enabled)): HoverState {
  return kinds.reduce((state, [kind, at]) => reduceHover(state, { kind, at }), from)
}

describe('展开：400ms', () => {
  it('停在宠物上满 400ms 才展开，差 1ms 不展开', () => {
    const entered = run([['enter-pet', 0]])
    assert.equal(entered.open, false, '刚移上去不能立刻弹出来，那是误触')
    assert.equal(reduceHover(entered, { kind: 'tick', at: HOVER_OPEN_MS - 1 }).open, false)
    assert.equal(reduceHover(entered, { kind: 'tick', at: HOVER_OPEN_MS }).open, true)
  })

  it('未到 400ms 就离开：不展开，之后也不会因为残留计时弹出来', () => {
    const left = run([['enter-pet', 0], ['leave-pet', 200]])
    assert.equal(left.petSince, null)
    assert.equal(reduceHover(left, { kind: 'tick', at: 5000 }).open, false)
  })

  it('连续 enter 不重复计时：第二次进入不会把起点推后', () => {
    // 鼠标在元素内部移动会反复触发 mouseover；若每次都重置起点，工具栏永远弹不出来。
    const state = run([['enter-pet', 0], ['enter-pet', 200], ['enter-pet', 350]])
    assert.equal(state.petSince, 0, '起点必须还是第一次进入的时刻')
    assert.equal(reduceHover(state, { kind: 'tick', at: HOVER_OPEN_MS }).open, true)
  })

  it('展开中再 enter 不重置：收起计时不会被无谓地续命', () => {
    const open = run([['enter-pet', 0], ['tick', 400], ['leave-pet', 500]])
    const reentered = reduceHover(open, { kind: 'enter-pet', at: 550 })
    assert.equal(reentered.open, true)
    assert.equal(reentered.leftPetAt, null, '回到宠物身上应当取消收起计时')
    assert.equal(reduceHover(reentered, { kind: 'tick', at: 1200 }).open, true, '指针在宠物上就不收起')
  })

  it('反复进出：展开计时以最后一次进入为准，不抖动', () => {
    const state = run([['enter-pet', 0], ['leave-pet', 100], ['enter-pet', 300], ['tick', 600]])
    assert.equal(state.open, false, '第二次进入只过了 300ms')
    assert.equal(reduceHover(state, { kind: 'tick', at: 700 }).open, true)
  })
})

describe('保持：挪进工具栏不收起', () => {
  it('展开后离开宠物 → 进入工具栏 → 一直保持', () => {
    const open = run([['enter-pet', 0], ['tick', 400]])
    assert.equal(open.open, true)
    const moving = run([['leave-pet', 450], ['enter-bar', 500]], true, open)
    assert.equal(moving.open, true)
    assert.equal(reduceHover(moving, { kind: 'tick', at: 9000 }).open, true, '指针在工具栏上就不该收起')
  })

  it('离开宠物后 599ms 内进入工具栏仍然保持', () => {
    const open = run([['enter-pet', 0], ['tick', 400], ['leave-pet', 500]])
    const late = reduceHover(open, { kind: 'tick', at: 500 + HOVER_CLOSE_MS - 1 })
    assert.equal(late.open, true)
    assert.equal(reduceHover(late, { kind: 'enter-bar', at: 500 + HOVER_CLOSE_MS }).open, true)
  })
})

describe('收起：600ms', () => {
  it('离开宠物满 600ms 收起', () => {
    const open = run([['enter-pet', 0], ['tick', 400], ['leave-pet', 500]])
    assert.equal(reduceHover(open, { kind: 'tick', at: 500 + HOVER_CLOSE_MS - 1 }).open, true)
    assert.equal(reduceHover(open, { kind: 'tick', at: 500 + HOVER_CLOSE_MS }).open, false)
  })

  it('离开工具栏满 600ms 收起，且收起后状态清干净（不会残留旧的展开计时）', () => {
    const open = run([['enter-pet', 0], ['tick', 400]])
    const leaving = run([['leave-pet', 410], ['enter-bar', 420], ['leave-bar', 800]], true, open)
    const closed = reduceHover(leaving, { kind: 'tick', at: 800 + HOVER_CLOSE_MS })
    assert.equal(closed.open, false)
    assert.equal(closed.petSince, null)
    assert.equal(closed.leftPetAt, null)
    assert.equal(closed.leftBarAt, null)
  })
})

describe('开关关掉时永不展开', () => {
  it('enabled=false：停在宠物上多久都不展开', () => {
    const state = run([['enter-pet', 0], ['tick', 10_000], ['tick', 20_000]], false)
    assert.equal(state.open, false)
  })

  it('开着的时候被关掉：下一次事件立即收起', () => {
    const open = run([['enter-pet', 0], ['tick', 400]])
    assert.equal(open.open, true)
    const disabled = reduceHover({ ...open, enabled: false }, { kind: 'tick', at: 500 })
    assert.equal(disabled.open, false)
  })
})

describe('五个按钮', () => {
  it('顺序固定：对话 → 会议 → 待办 → 日报 → 设置', () => {
    assert.deepEqual(hoverActions(false).map(action => action.id), ['chat', 'meeting', 'todo', 'report', 'settings'])
    assert.deepEqual(hoverActions(false).map(action => action.label), ['对话', '会议录音', '待办', '日报', '设置'])
  })

  it('录音中会议按钮改文案，别的按钮不受影响', () => {
    const recording = hoverActions(true)
    assert.equal(recording[1].label, '停止录音')
    assert.equal(recording[1].ariaLabel, '停止会议录音')
    assert.deepEqual(recording.filter((_, index) => index !== 1), hoverActions(false).filter((_, index) => index !== 1))
  })

  it('每个按钮都有无障碍标签', () => {
    for (const action of hoverActions(false)) assert.ok(action.ariaLabel.length > 0, action.id)
  })
})
