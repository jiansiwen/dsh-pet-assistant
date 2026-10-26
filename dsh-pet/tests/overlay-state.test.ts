import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSessionCommand, shouldDismissOverlay, validBoxes } from '../src/main/overlay-state.ts'
import { entriesForPresentation, mergeEntries, mergeSession, overlayPosition, presentationCutoffOf } from '../src/renderer/session-view.ts'
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
test('固定头顶：正常位置居中，贴边时夹回可视区而不是画到屏幕外', () => {
  const viewport = { width: 1536, height: 864 }
  const size = { width: 440, height: 400 }
  assert.deepEqual(overlayPosition({ x: 500, y: 700 }, size, 150, viewport, 'top'), { x: 355, y: 292 })
  assert.deepEqual(overlayPosition({ x: 100, y: 8 }, size, 150, viewport, 'top'), { x: 8, y: 8 })
})
test('自适应：上方放不下时换到下方，左右也不够时换到侧面', () => {
  const viewport = { width: 1536, height: 864 }
  const size = { width: 440, height: 400 }
  assert.deepEqual(overlayPosition({ x: 700, y: 8 }, size, 150, viewport, 'auto'), { x: 555, y: 166 })
  assert.deepEqual(overlayPosition({ x: 0, y: 400 }, size, 150, viewport, 'auto'), { x: 158, y: 275 })
})
test('自适应：四个方向都放不下时选溢出最少的并整体夹回视口', () => {
  const positioned = overlayPosition(
    { x: 100, y: 100 },
    { width: 200, height: 200 },
    150,
    { width: 300, height: 300 },
    'auto',
  )
  assert.deepEqual(positioned, { x: 75, y: 8 })
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

// ===== 演示隐私模式（M5-05）：只决定渲染哪些，不删数据 =====

test('演示模式：分界之前的一律不可见，之后新产生的照常显示', () => {
  const before = [entry('a', 1, '私人对话'), entry('b', 2, '更私人的内容')]
  const cutoff = presentationCutoffOf(before)
  assert.equal(cutoff, 2, '分界应是当前最大 seq')

  const { visible, hidden } = entriesForPresentation([...before, entry('c', 3, '演示中的新内容')], cutoff)
  assert.deepEqual(visible.map(item => item.id), ['c'], '只有分界之后的可见')
  assert.equal(hidden, 2, '被藏起来的条数要对得上，界面要显示它')

  // 关掉演示模式（cutoff = null）：同一批数据原样全部回来 —— 证明这里只过滤、没删除。
  const restored = entriesForPresentation([...before, entry('c', 3, '演示中的新内容')], null)
  assert.equal(restored.visible.length, 3)
  assert.equal(restored.hidden, 0)
})

test('演示模式：往上翻历史插入更早的条目时，分界不跟着漂移', () => {
  const cutoff = presentationCutoffOf([entry('b', 5, '开启时的最新一条')])
  // 翻历史把 seq 更小的条目插到数组**前面**：按下标分界会错位，按 seq 不会。
  const afterPaging = [entry('z', 1, '更早的历史'), entry('b', 5, '开启时的最新一条'), entry('c', 6, '新消息')]
  const { visible, hidden } = entriesForPresentation(afterPaging, cutoff)
  assert.deepEqual(visible.map(item => item.id), ['c'], '翻出来的旧历史不能被露出来')
  assert.equal(hidden, 2)
})

test('演示模式：空历史没有可分界的对象，返回 null 表示不隐藏', () => {
  assert.equal(presentationCutoffOf([]), null)
  const { visible, hidden } = entriesForPresentation([entry('a', 1, '第一条')], null)
  assert.equal(visible.length, 1)
  assert.equal(hidden, 0)
})
