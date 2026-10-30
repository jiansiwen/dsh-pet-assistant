import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { TeamStore } from '../src/team-domain.ts'
import { MemoryStore } from '../src/memory.ts'
import { MemberMemory } from '../src/member-memory.ts'
import { MemberManagement } from '../src/member-management.ts'
import { MemberAssistant, normalizeMemberProposal, parseProposalJson } from '../src/member-assistant.ts'
import { hostAgentRegistry, hostLlm } from '../src/host-agents.ts'
import type { MemberDraft } from '../src/member-contract.ts'
import type { MemberRuntime } from '../src/member-runtime.ts'

const base: MemberDraft = { displayName: '新成员', description: '', personality: '', permissionMode: 'ask', persona: '', skinId: 'panda',
  enabled: true, provider: '', model: '', maxTokens: 2048, capabilities: [], allowedTools: [], dailyTokenLimit: 0, totalTokenLimit: 0,
  thresholdPercent: 80, timezone: 'Asia/Shanghai' }

test('宿主未注入 agents/llm 时经 ctx.get 现取，取不到也不破坏插件装载', () => {
  const registry = { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } }
  assert.equal(hostAgentRegistry({ get: (name: string) => name === 'agents' ? registry : undefined } as never), registry)
  assert.equal(hostAgentRegistry({ get: () => { throw new Error('cannot get property "agents" without inject') }, agents: registry } as never), registry)
  assert.equal(hostAgentRegistry({ get: () => undefined } as never), undefined)
  const llm = { stream: async function* () { /* empty */ } }
  assert.equal(hostLlm({ get: (name: string) => name === 'llm' ? llm : undefined } as never), llm)
  assert.equal(hostLlm({ get: () => undefined } as never), undefined)
})

test('配置助手直接走宿主 LLM 流，不建会话、不带工具', async () => {
  const calls: Array<Record<string, unknown>> = []
  const llm = {
    stream: async function* (options: Record<string, unknown>) {
      calls.push(options)
      yield { type: 'text-delta', index: 0, text: '```json\n{"displayName":"日报助理","description":"整理日报","capabilities":["activity"]}\n```' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const assistant = new MemberAssistant({ ctx: { get: (name: string) => name === 'llm' ? llm : undefined } as never,
    defaultModel: () => ({ provider: '服务商甲', model: '模型甲' }) })
  const result = await assistant.draft({ request: '帮我做一个日报助理' })
  assert.equal(result.draft.displayName, '日报助理')
  assert.deepEqual(result.draft.capabilities, ['activity'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.provider, '服务商甲')
  assert.equal(calls[0]!.model, '模型甲')
  assert.equal(calls[0]!.tools, undefined)
  assert.match((calls[0]!.system as string), /成员配置助手/)
})

test('模型回复允许代码围栏，只取 JSON 对象', () => {
  assert.deepEqual(parseProposalJson('```json\n{"displayName":"日报助理"}\n```'), { displayName: '日报助理' })
  assert.deepEqual(parseProposalJson('说明在前 {"a":1} 说明在后'), { a: 1 })
  assert.equal(parseProposalJson('没有对象'), null)
  assert.equal(parseProposalJson('[1,2]'), null)
})

test('草稿只收窄可编辑字段：权限三档、能力白名单，模型/额度/时区沿用基准', () => {
  const { draft, notes } = normalizeMemberProposal({
    displayName: ' 日报助理 ', description: '整理每天的活动', personality: '简洁', persona: '只依据证据',
    permissionMode: 'root', capabilities: ['activity', 'shell', 'activity'], skinId: 'unknown-skin',
    provider: '伪造服务商', model: '伪造模型', timezone: 'Mars/Base', maxTokens: 99999,
    dailyTokenLimit: -1, totalTokenLimit: 12000, thresholdPercent: 0, allowedTools: ['bash'], notes: '已按你的描述填写',
  }, base)
  assert.equal(draft.displayName, '日报助理')
  assert.equal(draft.description, '整理每天的活动')
  assert.equal(draft.permissionMode, 'ask')
  assert.deepEqual(draft.capabilities, ['activity'])
  assert.equal(draft.skinId, 'panda')
  assert.equal(draft.provider, '')
  assert.equal(draft.model, '')
  assert.equal(draft.timezone, 'Asia/Shanghai')
  assert.equal(draft.maxTokens, 2048)
  assert.equal(draft.dailyTokenLimit, 0)
  assert.equal(draft.totalTokenLimit, 0)
  assert.equal(draft.thresholdPercent, 80)
  assert.deepEqual(draft.allowedTools, [])
  assert.equal(notes, '已按你的描述填写')
})

test('空的 AI 回复也有可读说明，修改时保留未提到的基准字段', () => {
  const existing: MemberDraft = { ...base, displayName: '资料助理', description: '整理资料', personality: '直接', persona: '按证据', capabilities: ['mail'] }
  const { draft, notes } = normalizeMemberProposal({ description: '整理合同' }, existing)
  assert.equal(draft.displayName, '资料助理')
  assert.equal(draft.description, '整理合同')
  assert.equal(draft.personality, '直接')
  assert.deepEqual(draft.capabilities, ['mail'])
  assert.match(notes, /填好草稿.*核对/s)
})

test('配置助手接口只返回草稿，不创建成员，失败不泄露内部错误', async t => {
  const store = new TeamStore(':memory:')
  const db = new DatabaseSync(':memory:')
  const memory = new MemberMemory({ store: new MemoryStore(db), ownerId: 'owner', exists: id => !!store.directory.get(id), invalidate: id => store.directory.setSession(id, null) })
  let calls = 0
  let fail = false
  const service = new MemberManagement({ directory: store.directory, runtime: { busy: () => false } as unknown as MemberRuntime, memories: memory,
    enabled: () => false, setMode: async () => {}, defaultModel: () => null, changed: () => {},
    assistant: { draft: async input => {
      calls++
      assert.equal(input.request, '帮我做一个每天整理日报的助理')
      assert.equal(input.current?.displayName, '日报助理')
      if (fail) throw new Error('模型服务返回了内部地址与凭据')
      return { draft: { ...input.current!, description: '整理每天的活动', capabilities: ['activity'] }, notes: '已设为每次询问' }
    } } })
  t.after(() => { store.close(); db.close() })
  const current: MemberDraft = { ...base, displayName: '日报助理' }
  const result = await service.request('POST', '/companion/v1/members/assist', { request: '帮我做一个每天整理日报的助理', current })
  assert.equal(result.status, 200)
  assert.deepEqual((result.body as { draft: MemberDraft }).draft.capabilities, ['activity'])
  assert.equal((result.body as { notes: string }).notes, '已设为每次询问')
  assert.equal(store.directory.list().length, 0)
  assert.equal((await service.request('POST', '/companion/v1/members/assist', { request: '日报', current, secret: 'x' })).status, 422)
  fail = true
  const failed = await service.request('POST', '/companion/v1/members/assist', { request: '日报' })
  assert.equal(failed.status, 503)
  assert.ok(!JSON.stringify(failed.body).includes('内部地址'))
  assert.equal(calls, 2)
})
