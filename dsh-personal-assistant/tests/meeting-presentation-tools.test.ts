import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerMeetingPresentationTools } from '../src/meeting-presentation-tools.ts'

test('旧会议讲解状态与结束入口保留供已有任务收尾，不再注册强绑定的开始工具', async () => {
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  const calls: Array<{ command: string; payload: unknown; options: { signal?: AbortSignal } }> = []
  const dispose = registerMeetingPresentationTools({ tools: { register: (value: any) => { tools.set(value.name, value); return () => tools.delete(value.name) } } },
    { request: async (command, payload, options) => {
      calls.push({ command, payload, options: options ?? {} })
      return command === 'meeting.presentation.finish' ? { id: 'p1', state: 'awaiting-review' } : { id: 'p1', state: 'presenting' }
    } })
  try {
    const signal = new AbortController().signal
    assert.equal(tools.has('personal_assistant_start_meeting_presentation'), false)
    const status = JSON.parse(await tools.get('personal_assistant_meeting_presentation_status')!.execute({ presentationId: 'p1' }, { signal }))
    assert.equal(status.result.state, 'presenting')
    assert.equal(calls[0]!.command, 'meeting.presentation.status')
    const finish = JSON.parse(await tools.get('personal_assistant_finish_meeting_presentation')!.execute({ presentationId: 'p1' }, { signal }))
    assert.equal(finish.result.state, 'awaiting-review')
    assert.equal(calls[1]!.command, 'meeting.presentation.finish')
    assert.equal(calls.length, 2)
  } finally { dispose() }
})

test('录音和文档讲解是两个独立工具，组合时分别调用，不夹带对方参数', async () => {
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  const calls: Array<{ command: string; payload: Record<string, unknown> }> = []
  const agent = {}
  const dispose = registerMeetingPresentationTools({ tools: { register: (value: any) => { tools.set(value.name, value); return () => {} } } },
    { binding: subject => subject === agent ? '绑定甲' : null, request: async (command, payload) => {
      calls.push({ command, payload })
      return command === 'document.presentation.start' ? { state: 'waiting-to-present' } : { state: 'recording' }
    } })
  try {
    const exec = { agent, signal: new AbortController().signal }
    const record = tools.get('personal_assistant_meeting_recording')!
    const present = tools.get('personal_assistant_document_presentation')!
    assert.ok(record && present)
    assert.equal((await record.execute({ action: 'start', name: '评审会', sources: 'mic', retentionDays: 10 }, exec)).includes('recording'), true)
    assert.deepEqual(calls[0], { command: 'meeting.recording.start', payload: { bindingId: '绑定甲', name: '评审会', sources: 'mic', retentionDays: 10 } })
    const result = JSON.parse(await present.execute({ action: 'start', documentName: '方案.md' }, exec))
    assert.equal(result.ok, true)
    assert.equal(result.result.state, 'waiting-to-present', '等待不等于已经讲完')
    assert.deepEqual(calls[1], { command: 'document.presentation.start', payload: { bindingId: '绑定甲', documentName: '方案.md' } })
    await record.execute({ action: 'stop', meetingId: '会议甲' }, exec)
    await present.execute({ action: 'stop' }, exec)
    assert.deepEqual(calls.slice(2), [
      { command: 'meeting.recording.stop', payload: { bindingId: '绑定甲', meetingId: '会议甲' } },
      { command: 'document.presentation.control', payload: { bindingId: '绑定甲', action: 'stop' } },
    ])
  } finally { dispose() }
})

test('独立工具拒绝非当前桌面、过期请求和非法参数，不向桌面派发命令', async () => {
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  let requests = 0
  const agent = {}, signal = new AbortController()
  const dispose = registerMeetingPresentationTools({ tools: { register: (value: any) => { tools.set(value.name, value); return () => {} } } },
    { binding: subject => subject === agent ? '绑定甲' : null, request: async () => { requests++; return {} } })
  try {
    const record = tools.get('personal_assistant_meeting_recording')!
    const present = tools.get('personal_assistant_document_presentation')!
    for (const [tool, args, exec] of [
      [record, { action: 'start' }, { agent: {}, signal: signal.signal }],
      [record, { action: 'start', sources: 'remote' }, { agent, signal: signal.signal }],
      [record, { action: 'start', retentionDays: 0 }, { agent, signal: signal.signal }],
      [present, { action: 'start', documentName: '甲', documentPath: '乙' }, { agent, signal: signal.signal }],
      [present, { action: 'stop', documentName: '甲' }, { agent, signal: signal.signal }],
      [present, { action: 'start', documentName: '甲' }, { agent }],
    ] as const) {
      const outcome = await tool.execute(args, exec).then(value => ({ value }), error => ({ error }))
      if ('error' in outcome) assert.equal((outcome.error as { code?: string }).code, 'INVALID_ARGS')
      else assert.equal(JSON.parse(outcome.value).ok, false)
    }
    signal.abort()
    assert.equal(JSON.parse(await record.execute({ action: 'start' }, { agent, signal: signal.signal })).ok, false)
    assert.equal(requests, 0)
  } finally { dispose() }
})

test('独立工具在桌面断开或会话换绑时如实返回失败，不编造成功', async () => {
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  const agent = {}
  let binding = '绑定甲'
  const dispose = registerMeetingPresentationTools({ tools: { register: (value: any) => { tools.set(value.name, value); return () => {} } } },
    { binding: subject => subject === agent ? binding : null, request: async () => { binding = '绑定乙'; return { state: 'ready' } } })
  try {
    const result = JSON.parse(await tools.get('personal_assistant_document_presentation')!.execute(
      { action: 'start', documentName: '方案.md' }, { agent, signal: new AbortController().signal }))
    assert.equal(result.ok, false)
    assert.match(result.error, /会话.*变化|换绑/u)
  } finally { dispose() }
})
