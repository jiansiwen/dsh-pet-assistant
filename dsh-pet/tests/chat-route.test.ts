/**
 * 一句话交给谁（chat-route.ts）的行为契约。
 *
 * 真机事故（2026-11-26）：成员讲解被打断后一直暂停着，用户对总助理说的「结束会议并整理成会议纪要」
 * 全被送进了讲解成员的会话。这里钉住：讲解停了就回总助理；动作指令永远回总助理；显式点名优先。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { chiefActionCount, isChiefInstruction, routeChat, type PresenterState } from '../src/main/chat-route.ts'

const member = 'member-bailongma'
const playing: PresenterState = { assistantId: member, spoken: true, stopped: false }
const paused: PresenterState = { assistantId: member, spoken: true, stopped: true }

function route(text: string, presenter: PresenterState | null, askWindow = false, explicitAssistantId?: string) {
  return routeChat({ text, presenter, askWindow, compound: false, ...(explicitAssistantId ? { explicitAssistantId } : {}) })
}

describe('动作指令识别', () => {
  for (const text of ['结束会议并整理成会议纪要', '结束会议，并整理成会议纪要', '帮我生成一份会议纪要，然后这次演讲可以结束了', '停止录音', '帮我开个会', '提醒我三点开会',
    '帮我建一个十分钟后的提醒', '把纪要发给张三', '打开浏览器', '生成会议摘要']) {
    test(`是给总助理的指令：「${text}」`, () => assert.equal(isChiefInstruction(text), true))
  }
  for (const text of ['这段是什么意思？', '提醒功能是怎么实现的？', '邮件值守是什么原理？', '语音唤醒怎么工作？', '这里支持导出吗？',
    '这里为什么讲到发送邮件和设置提醒？', '这个目录为什么只读？', '测试会议转写', '下一页讲什么']) {
    test(`是在问文档：「${text}」`, () => assert.equal(isChiefInstruction(text), false))
  }
  test('复合委托计数与原规则一致：停会+纪要算两件', () => {
    assert.equal(chiefActionCount('结束会议并整理成会议纪要'), 2)
  })
})

describe('路由', () => {
  test('讲解暂停（不在追问窗口）后，文档提问也回到总助理', () => {
    assert.deepEqual(route('这段是什么意思？', paused), { to: 'chief' })
    assert.deepEqual(route('顺便问一句别的', paused), { to: 'chief' })
  })
  test('讲解暂停时的会议指令回到总助理（现场事故）', () => {
    assert.deepEqual(route('结束会议并整理成会议纪要', paused), { to: 'chief' })
  })
  test('讲解正在播：文档提问交给讲解人，并按追问附原文', () => {
    assert.deepEqual(route('这段是什么意思？', playing), { to: 'presenter', assistantId: member, ask: true })
    assert.deepEqual(route('测试会议转写', playing), { to: 'presenter', assistantId: member, ask: false })
  })
  test('讲解正在播：动作指令仍交给总助理', () => {
    for (const text of ['结束会议并整理成会议纪要', '提醒我三点开会', '打开浏览器']) assert.deepEqual(route(text, playing), { to: 'chief' })
  })
  test('插话后的追问窗口里：文档提问（含问提醒/邮件/导出功能实现）交给讲解人，动作指令仍交给总助理', () => {
    assert.deepEqual(route('这个目录为什么只读？', paused, true), { to: 'presenter', assistantId: member, ask: true })
    assert.deepEqual(route('提醒功能是怎么实现的？', paused, true), { to: 'presenter', assistantId: member, ask: true })
    assert.deepEqual(route('邮件值守是什么原理？', paused, true), { to: 'presenter', assistantId: member, ask: true })
    assert.deepEqual(route('结束会议，并整理成会议纪要', paused, true), { to: 'chief' })
    assert.deepEqual(route('帮我生成一份会议纪要，然后这次演讲可以结束了', paused, true), { to: 'chief' })
  })
  test('显式点名的成员永远优先', () => {
    assert.deepEqual(route('结束会议并整理成会议纪要', paused, false, 'member-x'), { to: 'explicit', assistantId: 'member-x' })
    assert.deepEqual(route('这段是什么意思？', playing, false, 'member-x'), { to: 'explicit', assistantId: 'member-x' })
  })
  test('复合委托整句交给总助理', () => {
    assert.deepEqual(routeChat({ text: '这段讲什么', presenter: playing, askWindow: true, compound: true }), { to: 'chief' })
  })
  test('没有讲解链：总助理', () => assert.deepEqual(route('这段是什么意思？', null), { to: 'chief' }))
  test('打字提纲（不出声）的成员讲解不算在播：回到总助理', () => {
    assert.deepEqual(route('这段是什么意思？', { assistantId: member, spoken: false, stopped: false }), { to: 'chief' })
  })
  test('总助理自己讲的文档：提问照旧附原文问总助理，其余回总助理', () => {
    assert.deepEqual(route('这段是什么意思？', { spoken: false, stopped: false }), { to: 'presenter', ask: true })
    assert.deepEqual(route('好的', { spoken: true, stopped: true }), { to: 'chief' })
  })
})
