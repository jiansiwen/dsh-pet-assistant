/** 全部使用模拟会议和回执，不读取真实会议库、不启动桌宠。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createMeetingTodoHandler, importMeetingTodo } from '../src/main/meeting-todo.ts'
import { renderStructuredSections } from '../src/main/meeting-minutes.ts'

const meetingId = 'meeting-1', revision = 2
const tag = createHash('sha256').update(meetingId).digest('hex').slice(0, 6)
const item = { id: 'action-1', kind: 'action', text: '检查测试结果', status: 'kept', owner: '张三', due: '周五',
  ownerOrigin: 'stated', dueOrigin: 'stated', startMs: 1000, endMs: 2000, speakers: ['张三'], speakersUncertain: false,
  sources: [{ id: `M${tag}-R${revision}-S1`, idx: 1 }] }
const structured = { version: 1, generator: 'model', basedOnRevision: revision, items: [item] }
const content = `已确认的会议纪要\n${renderStructuredSections(structured as any).join('\n')}\n## 时间线`
const digest = createHash('sha256').update(content).digest('hex')
function fixture() {
  let version = { name: '项目晨会', view: { ok: true, revision, minutes: { revision, content, digest, state: 'confirmed',
    confirmedAt: 1_800_000_000_000, kind: 'model', structured, stale: false } } }
  let allow = true, calls = 0, current = true
  let post: (value: any) => Promise<any> = async () => ({ status: 201, body: { duplicate: false, task: { taskId: 'task-1', status: 'awaiting-user' } } })
  const deps = { read: () => version as any, confirm: async () => allow, current: () => current,
    post: async (value: any) => { calls++; return post(value) } }
  return { deps, get calls() { return calls }, cancel: () => { allow = false }, stale: () => { version = { ...version, view: { ...version.view, minutes: { ...version.view.minutes, digest: 'b'.repeat(64) } } } },
    disconnect: () => { current = false }, setPost: (fn: typeof post) => { post = fn } }
}
const request = { meetingId, itemId: 'action-1', revision, digest }

test('只交接当前确认版、所选且有来源的行动项，并在原生确认后重新核验', async () => {
  const f = fixture()
  let sent: any
  f.setPost(async value => { sent = value; return { status: 201, body: { duplicate: false, task: { taskId: 'task-1', status: 'awaiting-user' } } } })
  const result = await importMeetingTodo(request, f.deps)
  assert.equal(result.ok, true)
  assert.equal(f.calls, 1)
  assert.equal(sent.meetingId, meetingId)
  assert.equal(sent.itemId, 'action-1')
  assert.equal(sent.digest, digest)
  assert.deepEqual(sent.sourceRefs, [item.sources[0].id])
  assert.equal(sent.text, item.text)
})

test('取消、会议信息变化或来源窗口失效，均不发送任务请求', async () => {
  const cancelled = fixture(); cancelled.cancel()
  assert.equal((await importMeetingTodo(request, cancelled.deps)).ok, false)
  assert.equal(cancelled.calls, 0)
  const changed = fixture()
  changed.deps.confirm = async () => { changed.stale(); return true }
  assert.equal((await importMeetingTodo(request, changed.deps)).ok, false)
  assert.equal(changed.calls, 0)
  const lost = fixture()
  lost.deps.confirm = async () => { lost.disconnect(); return true }
  assert.equal((await importMeetingTodo(request, lost.deps)).ok, false)
  assert.equal(lost.calls, 0)
  const absent = fixture()
  assert.equal((await importMeetingTodo({ ...request, itemId: 'action-9' }, absent.deps)).ok, false)
  assert.equal(absent.calls, 0)
})

test('断线结果未知时不重发；提交后纪要变化需如实提示版本', async () => {
  const unknown = fixture()
  unknown.setPost(async () => ({ status: 0, body: { message: '连接中断' } }))
  const uncertain = await importMeetingTodo(request, unknown.deps)
  assert.equal(uncertain.ok, false)
  assert.match(uncertain.error ?? '', /未知|核对/)
  assert.equal(unknown.calls, 1)
  const changed = fixture()
  changed.setPost(async () => { changed.stale(); return { status: 201, body: { duplicate: false, task: { taskId: 'task-1', status: 'awaiting-user' } } } })
  const result = await importMeetingTodo(request, changed.deps)
  assert.equal(result.ok, true)
  assert.equal(result.sourceChanged, true)
  assert.match(result.message ?? '', /原版本|核对/)
})

test('主进程入口只认登记页面的当前绑定，忽略渲染层伪造的条目正文', async () => {
  const f = fixture()
  let binding = 'binding-1', sent: any
  f.setPost(async value => { sent = value; return { status: 201, body: { duplicate: false, task: { taskId: 'task-1', status: 'awaiting-user' } } } })
  const handler = createMeetingTodoHandler({ ...f.deps, binding: (event: { allowed: boolean }) => event.allowed ? binding : null })
  assert.equal((await handler({ allowed: false }, request)).ok, false)
  assert.equal(f.calls, 0)
  assert.equal((await handler({ allowed: true }, { ...request, text: '伪造正文', owner: '伪造负责人' })).ok, true)
  assert.equal(sent.text, item.text)
  assert.equal(sent.owner, item.owner)
  const during = fixture()
  const changedHandler = createMeetingTodoHandler({ ...during.deps, binding: () => binding,
    confirm: async () => { binding = 'binding-2'; return true } })
  assert.equal((await changedHandler({ allowed: true }, request)).ok, false)
  assert.equal(during.calls, 0)
})
