import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DesktopCommands, type DesktopCommandEvent } from '../src/desktop-commands.ts'

function fixture() {
  const events: DesktopCommandEvent[] = []
  const commands = new DesktopCommands(event => events.push(event))
  return { events, commands }
}
function idOf(event: DesktopCommandEvent): string { return event.payload.id }

test('桌面命令只接受同一 id 的一次回执，成功后忽略重复结果', async () => {
  const { events, commands } = fixture()
  const pending = commands.request('meeting.start', { name: '周会' }, { timeoutMs: 5_000 })
  assert.equal(events.length, 1)
  assert.equal(events[0]!.type, 'desktop/command')
  assert.equal(idOf(events[0]!), events[0]!.payload.id)
  assert.equal(commands.resolve({ id: events[0]!.payload.id, ok: true, result: { meetingId: 'm-1' } }), true)
  assert.deepEqual(await pending, { meetingId: 'm-1' })
  assert.equal(commands.resolve({ id: events[0]!.payload.id, ok: true, result: { meetingId: '重复' } }), false)
  commands.dispose()
})

test('失败回执带原因，伪造 id、缺字段与过期入口不结算', async () => {
  const { events, commands } = fixture()
  const pending = commands.request('meeting.stop', {}, { timeoutMs: 5_000 })
  assert.equal(commands.resolve({ id: '伪造', ok: true }), false)
  assert.equal(commands.resolve({ id: idOf(events[0]!), ok: 'yes' }), false)
  assert.equal(commands.resolve({ id: idOf(events[0]!), ok: false, error: '会议还在录' }), true)
  await assert.rejects(pending, /会议还在录/)
  commands.dispose()
})

test('取消与释放都拒绝等待方，不会把迟到结果交给下一次请求', async () => {
  const { events, commands } = fixture()
  const controller = new AbortController()
  const aborted = commands.request('meeting.status', {}, { timeoutMs: 5_000, signal: controller.signal })
  controller.abort()
  await assert.rejects(aborted, /已取消/)
  assert.equal(commands.resolve({ id: idOf(events[0]!), ok: true, result: {} }), false)

  const pending = commands.request('meeting.status', {}, { timeoutMs: 5_000 })
  commands.dispose()
  await assert.rejects(pending, /已停止/)
})
