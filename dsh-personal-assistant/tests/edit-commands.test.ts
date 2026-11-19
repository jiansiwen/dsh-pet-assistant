import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localOffsetIso, parseMeetingEdit, parseTaskEdit } from '../src/edit-commands.ts'

test('待办改删解析：四种 kind 与值域', () => {
  assert.deepEqual(parseTaskEdit('/assistant-task-set title t-1 新 标题'), { kind: 'title', taskId: 't-1', value: '新 标题' })
  assert.deepEqual(parseTaskEdit('/assistant-task-set cancel t-1'), { kind: 'cancel', taskId: 't-1' })
  assert.deepEqual(parseTaskEdit('/assistant-task-set interval t-1 600'), { kind: 'interval', taskId: 't-1', seconds: 600 })
  assert.deepEqual(parseTaskEdit('/assistant-task-set deadline t-1 2026-11-17T15:00:00+08:00'),
    { kind: 'deadline', taskId: 't-1', value: '2026-11-17T15:00:00+08:00' })
})

test('epoch 毫秒转成带本地偏移的 ISO（改期接口只认带偏移）', () => {
  const ms = Date.parse('2026-11-17T15:00:00+08:00')
  const iso = localOffsetIso(ms)
  assert.match(iso, /[+-]\d{2}:\d{2}$/u, '必须带时区偏移')
  assert.equal(Date.parse(iso), ms, '转换不能改变时刻')
  const parsed = parseTaskEdit(`/assistant-task-set deadline t-1 ${ms}`)
  assert.equal(parsed?.kind, 'deadline')
  assert.equal(parsed && parsed.kind === 'deadline' ? parsed.value : '', iso)
})

test('非法形状一律 null：缺 id / 空标题 / 间隔越界 / 裸 datetime-local', () => {
  for (const bad of [
    '/assistant-task-set',
    '/assistant-task-set title',
    '/assistant-task-set title t-1 ',
    '/assistant-task-set interval t-1 59',
    '/assistant-task-set interval t-1 604801',
    '/assistant-task-set deadline t-1 2026-11-17T15:00',
    '/assistant-task-set wat t-1 x',
  ]) assert.equal(parseTaskEdit(bad), null, bad)
})

test('会议改删解析：rename 带名字、delete 不带；非法拒绝', () => {
  assert.deepEqual(parseMeetingEdit('/assistant-meeting-set rename m-1 新 名字'), { kind: 'rename', meetingId: 'm-1', name: '新 名字' })
  assert.deepEqual(parseMeetingEdit('/assistant-meeting-set delete m-1'), { kind: 'delete', meetingId: 'm-1' })
  for (const bad of ['/assistant-meeting-set', '/assistant-meeting-set rename m-1', '/assistant-meeting-set delete', '/assistant-meeting-set wat m-1 x']) {
    assert.equal(parseMeetingEdit(bad), null, bad)
  }
})
