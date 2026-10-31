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

test('桌面动作开始前只能领取一次，编号、命令、参数和期限必须与仍在等待的请求一致', async () => {
  const { events, commands } = fixture()
  const pending = commands.request('meeting.start', { name: '原会议' }, { timeoutMs: 5_000 })
  const event = events[0]!
  assert.equal(event.type, 'desktop/command')
  if (event.type !== 'desktop/command') throw new Error('事件类型不对')
  assert.equal(commands.claim({ ...event.payload, payload: { name: '替换会议' } }), false)
  assert.equal(commands.claim({ ...event.payload, command: 'meeting.stop' }), false)
  assert.equal(commands.claim({ ...event.payload, expiresAt: event.payload.expiresAt + 1 }), false)
  assert.equal(commands.claim(event.payload), true)
  assert.equal(commands.claim(event.payload), false, '重连重放不能再次领取')
  assert.equal(commands.resolve({ id: event.payload.id, ok: true, result: '完成' }), true)
  assert.equal(await pending, '完成')
  assert.equal(commands.claim(event.payload), false)
  commands.dispose()
})

test('取消与释放都拒绝等待方，不会把迟到结果交给下一次请求', async () => {
  const { events, commands } = fixture()
  const controller = new AbortController()
  const aborted = commands.request('meeting.status', {}, { timeoutMs: 5_000, signal: controller.signal })
  controller.abort()
  await assert.rejects(aborted, /已取消/)
  assert.deepEqual(events[1], { type: 'desktop/cancel', payload: { id: idOf(events[0]!) } }, '取消必须通知桌面阻止尚未开始的动作')
  assert.equal(commands.resolve({ id: idOf(events[0]!), ok: true, result: {} }), false)

  const pending = commands.request('meeting.status', {}, { timeoutMs: 5_000 })
  commands.dispose()
  await assert.rejects(pending, /已停止/)
  assert.deepEqual(events.at(-1), { type: 'desktop/cancel', payload: { id: idOf(events[2]!) } }, '释放时也通知桌面取消在途命令')
})
