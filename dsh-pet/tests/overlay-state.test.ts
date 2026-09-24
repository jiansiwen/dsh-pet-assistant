import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSessionCommand, shouldDismissOverlay, validBoxes } from '../src/main/overlay-state.ts'
import { mergeEntries, mergeSession, overlayPosition } from '../src/renderer/session-view.ts'
import type { SessionEntry, SessionSnapshot } from '../src/session-types.js'

const box = { x1: 100, y1: 100, x2: 200, y2: 200 }
const outside = { x: 20, y: 20, time: 101 }
const visible = { open: true, running: false, blocked: false, after: 100, boxes: [box] }

test('运行中点击其他应用不收起；完成后原地下一次点击才收起', () => {
  assert.equal(shouldDismissOverlay({ ...visible, running: true }, outside), false)
  assert.equal(shouldDismissOverlay(visible, { ...outside, time: 99 }), false)
  assert.equal(shouldDismissOverlay(visible, { ...outside, time: 100 }), false)
  assert.equal(shouldDismissOverlay(visible, outside), true)
})
test('内部区域、菜单或管理交互不自动收起；隐藏状态不重复触发', () => {
  assert.equal(shouldDismissOverlay(visible, { x: 150, y: 150, time: 101 }), false)
  assert.equal(shouldDismissOverlay({ ...visible, blocked: true }, outside), false)
  assert.equal(shouldDismissOverlay({ ...visible, open: false }, outside), false)
})
test('头顶框允许负坐标，不改变宠物的位置或翻转到下方', () => {
  assert.deepEqual(overlayPosition(100, 8, 440, 400, 150), { x: -45, y: -400 })
  assert.deepEqual(overlayPosition(500, 700, 440, 400, 150), { x: 355, y: 292 })
})
test('屏幕命中区域与命令只接受有效边界输入', () => {
  assert.equal(validBoxes([box]), true)
  assert.equal(validBoxes([{ ...box, x1: Infinity }]), false)
  assert.equal(validBoxes([{ ...box, x1: 201 }]), false)
  assert.equal(validBoxes(Array(65).fill(box)), false)
  assert.equal(isSessionCommand({ kind: 'prompt', bindingId: 'a', text: '你好' }), true)
  assert.equal(isSessionCommand({ kind: 'permission', bindingId: 'a', value: 'workspace-write' }), true)
  assert.equal(isSessionCommand({ kind: 'permission', bindingId: 'a', value: 'full\n/other' }), false)
  assert.equal(isSessionCommand({ kind: 'prompt', bindingId: '', text: '你好' }), false)
  assert.equal(isSessionCommand({ kind: 'prompt', bindingId: 'a', text: ' ' }), false)
  assert.equal(isSessionCommand({ kind: 'unknown', bindingId: 'a' }), false)
})
const entry = (id: string, seq: number, text: string): SessionEntry => ({ id, seq, text, role: 'assistant', kind: 'text' })
const snapshot = (bindingId: string, cursor: number, entries: SessionEntry[]): SessionSnapshot => ({
  sessionId: bindingId, bindingId, cursor, entries, title: '', status: 'running', hasMore: true, beforeSeq: 10,
  model: null, models: [], permissions: [], permission: null,
  capabilities: { prompt: true, cancel: true, models: false, permissions: false, history: true },
})
test('按消息身份去重并替换流式文本，不追加同一条回声', () => {
  assert.deepEqual(mergeEntries([entry('a', 1, '你')], [entry('a', 1, '你好'), entry('b', 2, '下一条')]),
    [entry('a', 1, '你好'), entry('b', 2, '下一条')])
})
test('增量保留历史页边界，过期游标不覆盖新内容，换绑清空旧历史', () => {
  const first = snapshot('a', 20, [entry('old', 10, '旧消息')])
  const update = snapshot('a', 22, [entry('new', 21, '新消息')])
  update.beforeSeq = 21
  const merged = mergeSession(first, update)
  assert.equal(merged.entries.length, 2)
  assert.equal(merged.beforeSeq, 10)
  assert.equal(mergeSession(merged, first), merged)
  assert.deepEqual(mergeSession(merged, { ...update, reset: true }).entries, update.entries)
  assert.equal(mergeSession(merged, snapshot('b', 1, [])).entries.length, 0)
})
