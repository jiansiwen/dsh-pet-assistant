import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerMeetingPresentationTools } from '../src/meeting-presentation-tools.ts'

test('会议讲解工具只交接固定参数并等待桌面就绪回执，不把就绪说成讲完', async () => {
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  const calls: Array<{ command: string; payload: unknown; options: { signal?: AbortSignal } }> = []
  const dispose = registerMeetingPresentationTools({ tools: { register: (value: any) => { tools.set(value.name, value); return () => tools.delete(value.name) } } },
    { request: async (command, payload, options) => {
      calls.push({ command, payload, options: options ?? {} })
      return command === 'meeting.presentation.start' ? { presentationId: 'p1', state: 'waiting-to-present' }
        : command === 'meeting.presentation.finish' ? { id: 'p1', state: 'awaiting-review' } : { id: 'p1', state: 'presenting' }
    } })
  try {
    const signal = new AbortController().signal
    const start = tools.get('personal_assistant_start_meeting_presentation')!
    const result = JSON.parse(await start.execute({ name: '评审会', documentName: '方案.md', retentionDays: 30 }, { signal }))
    assert.equal(result.ok, true)
    assert.equal(result.result.state, 'waiting-to-present')
    assert.deepEqual(calls[0]!.payload, { name: '评审会', documentName: '方案.md', retentionDays: 30 })
    assert.equal(calls[0]!.command, 'meeting.presentation.start')
    assert.equal(calls[0]!.options.signal, signal)
    const status = JSON.parse(await tools.get('personal_assistant_meeting_presentation_status')!.execute({ presentationId: 'p1' }, { signal }))
    assert.equal(status.result.state, 'presenting')
    assert.equal(calls[1]!.command, 'meeting.presentation.status')
    const finish = JSON.parse(await tools.get('personal_assistant_finish_meeting_presentation')!.execute({ presentationId: 'p1' }, { signal }))
    assert.equal(finish.result.state, 'awaiting-review')
    assert.equal(calls[2]!.command, 'meeting.presentation.finish')
    assert.equal((JSON.parse(await start.execute({ name: '评审会' }, { signal }))).ok, false)
    assert.equal(calls.length, 3)
  } finally { dispose() }
})

test('桌面断开或取消只能如实返回错误，不编造开始回执', async () => {
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  const dispose = registerMeetingPresentationTools({ tools: { register: (value: any) => { tools.set(value.name, value); return () => {} } } },
    { request: async () => { throw new Error('桌面操作已取消') } })
  try {
    const result = JSON.parse(await tools.get('personal_assistant_start_meeting_presentation')!.execute({ name: '评审会', documentName: '方案.md' }, {}))
    assert.equal(result.ok, false)
    assert.match(result.error, /取消/u)
  } finally { dispose() }
})
