/**
 * personal_assistant_set_team_mode 工具的单测（假 host + 假桥接）。
 *
 * 团队模式开关的分支逻辑都在工具层：幂等、参数校验、关闭被拒时的转述。
 * 真正的挂载/卸载在 index.ts 的 mountTeam 里，依赖宿主上下文，由真机验证。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { registerAssistantTools } from '../src/tools.ts'
import type { SessionBridge } from '../src/bridge.ts'
import type { ActivityTracker } from '../src/tracker.ts'
import type { MemoryStore } from '../src/memory.ts'
import type { ReportStore } from '../src/report.ts'
import type { ToolOptions } from '../src/tools.ts'

interface RegisteredTool {
  name: string
  execute(args: unknown): Promise<string>
}

function makeHost() {
  const tools: RegisteredTool[] = []
  const host = {
    tools: {
      register(definition: unknown): () => void {
        tools.push(definition as RegisteredTool)
        return () => undefined
      },
    },
    systemPrompt: {
      section: () => () => undefined,
      variable: () => () => undefined,
    },
  }
  return { host, tools }
}

function teamModeTool(tools: RegisteredTool[]): RegisteredTool {
  const tool = tools.find(item => item.name === 'personal_assistant_set_team_mode')
  assert.ok(tool, 'personal_assistant_set_team_mode 必须被注册')
  return tool
}

function makeOptions(bridge: { teamEnabled: boolean }, overrides?: Partial<ToolOptions>): ToolOptions {
  return {
    reportDir: '',
    bridge: bridge as unknown as SessionBridge,
    memories: {} as unknown as MemoryStore,
    reports: {} as unknown as ReportStore,
    maxInjectedMemories: 40,
    captureBlockedReason: () => null,
    legacyCopiesRetained: false,
    enableTeamMode: () => ({ toolsRegistered: true }),
    disableTeamMode: async () => ({ ok: true }),
    ...overrides,
  }
}

function parse(result: string): Record<string, unknown> {
  return JSON.parse(result) as Record<string, unknown>
}

test('团队模式：关→开走挂载，返回 toolsRegistered', async () => {
  const { host, tools } = makeHost()
  let enabled = 0
  registerAssistantTools(host as never, {} as unknown as ActivityTracker, makeOptions(
    { teamEnabled: false },
    { enableTeamMode: () => { enabled += 1; return { toolsRegistered: true } } },
  ))
  const result = parse(await teamModeTool(tools).execute({ enabled: true }))
  assert.equal(enabled, 1)
  assert.equal(result.ok, true)
  assert.equal(result.teamMode, true)
  assert.equal(result.toolsRegistered, true)
})

test('团队模式：已开再开是幂等消息，不再挂载', async () => {
  const { host, tools } = makeHost()
  let enabled = 0
  registerAssistantTools(host as never, {} as unknown as ActivityTracker, makeOptions(
    { teamEnabled: true },
    { enableTeamMode: () => { enabled += 1; return { toolsRegistered: true } } },
  ))
  const result = parse(await teamModeTool(tools).execute({ enabled: true }))
  assert.equal(enabled, 0)
  assert.equal(result.ok, true)
  assert.equal(result.teamMode, true)
})

test('团队模式：开→关走卸载', async () => {
  const { host, tools } = makeHost()
  let disabled = 0
  registerAssistantTools(host as never, {} as unknown as ActivityTracker, makeOptions(
    { teamEnabled: true },
    { disableTeamMode: async () => { disabled += 1; return { ok: true } } },
  ))
  const result = parse(await teamModeTool(tools).execute({ enabled: false }))
  assert.equal(disabled, 1)
  assert.equal(result.ok, true)
  assert.equal(result.teamMode, false)
})

test('团队模式：有任务执行中时关闭被拒，error 原样返回', async () => {
  const { host, tools } = makeHost()
  registerAssistantTools(host as never, {} as unknown as ActivityTracker, makeOptions(
    { teamEnabled: true },
    { disableTeamMode: async () => ({ ok: false, error: '还有 1 个团队任务在执行，等它们结束再关闭团队模式' }) },
  ))
  const result = parse(await teamModeTool(tools).execute({ enabled: false }))
  assert.equal(result.ok, false)
  assert.match(String(result.error), /还有 1 个团队任务在执行/)
})

test('团队模式：已是关闭状态时再关是幂等消息，不再卸载', async () => {
  const { host, tools } = makeHost()
  let disabled = 0
  registerAssistantTools(host as never, {} as unknown as ActivityTracker, makeOptions(
    { teamEnabled: false },
    { disableTeamMode: async () => { disabled += 1; return { ok: true } } },
  ))
  const result = parse(await teamModeTool(tools).execute({ enabled: false }))
  assert.equal(disabled, 0)
  assert.equal(result.ok, true)
  assert.equal(result.teamMode, false)
})

test('团队模式：缺参数与类型错误由 defineTool 的 schema 校验拒绝', async () => {
  const { host, tools } = makeHost()
  let toggled = 0
  registerAssistantTools(host as never, {} as unknown as ActivityTracker, makeOptions(
    { teamEnabled: false },
    {
      enableTeamMode: () => { toggled += 1; return { toolsRegistered: true } },
      disableTeamMode: async () => { toggled += 1; return { ok: true } },
    },
  ))
  const tool = teamModeTool(tools)
  await assert.rejects(tool.execute({}), /enabled/)
  await assert.rejects(tool.execute({ enabled: 'yes' }), /enabled/)
  assert.equal(toggled, 0)
})
