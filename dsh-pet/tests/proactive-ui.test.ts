import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PROACTIVE_ACCEPT_MESSAGE, proactiveButtons } from '../src/renderer/proactive-ui.ts'

test('普通候选：好 / 不用 —— 「好」回执 accept', () => {
  assert.deepEqual(proactiveButtons(false), [
    { kind: 'accept', label: '好' },
    { kind: 'decline', label: '不用' },
  ])
})

test('连续拒绝后的候选：主按钮换成「关掉提醒」，不再有「好」', () => {
  // 这一刻气泡问的是"要不要干脆关掉"，再放一个「好」按钮就是两个问句叠在一起，
  // 用户按哪个都像在回答另一个问题。
  const buttons = proactiveButtons(true)
  assert.deepEqual(buttons, [
    { kind: 'disable', label: '关掉提醒' },
    { kind: 'decline', label: '先不用' },
  ])
  assert.ok(!buttons.some(button => button.kind === 'accept'), '建议关闭的气泡上不该出现「好」')
})

test('点「好」替用户发出的那句话是固定文案：进帮助流程的是它，模型从这里接手', () => {
  assert.equal(typeof PROACTIVE_ACCEPT_MESSAGE, 'string')
  assert.ok(PROACTIVE_ACCEPT_MESSAGE.length > 0)
})
