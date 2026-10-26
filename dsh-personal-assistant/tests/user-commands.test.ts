import assert from 'node:assert/strict'
import test from 'node:test'
import { registerUserCommands } from '../src/index.ts'

interface Definition {
  name: string
  description: string
  handler: (invocation: { agent?: unknown }) => Promise<{ kind: string; text: string }>
}

interface Overrides {
  bind?: () => Promise<{ port: number }>
  launchPet?: () => boolean
  teamEnabled?: boolean
  capturing?: boolean
  scope?: boolean
  blocked?: string | null
  start?: () => Promise<void>
  stop?: () => Promise<void>
}

function harness(overrides: Overrides = {}) {
  const definitions: Definition[] = []
  const events: string[] = []
  const ctx = {
    get: (name: string) => name === 'commands'
      ? { register: (definition: Definition) => { definitions.push(definition); return () => {} } }
      : undefined,
    effect: (run: () => () => void) => run(),
  }
  const bridge = {
    teamEnabled: overrides.teamEnabled ?? false,
    bind: overrides.bind ?? (async () => { events.push('bind'); return { port: 4567 } }),
    launchPet: overrides.launchPet ?? (() => { events.push('launch'); return true }),
  }
  const tracker = {
    capturing: overrides.capturing ?? false,
    start: overrides.start ?? (async () => { events.push('start') }),
    stop: overrides.stop ?? (async () => { events.push('stop') }),
  }
  registerUserCommands(ctx as never, {
    bridge: bridge as never,
    tracker: tracker as never,
    captureBlockedReason: () => overrides.blocked ?? null,
    captureScopeAuthorized: () => overrides.scope ?? true,
  })
  return { definitions, events, command: (name: string) => definitions.find(item => item.name === name)! }
}

test('宿主没有 commands 服务时静默跳过，不影响插件加载', () => {
  assert.doesNotThrow(() => registerUserCommands({ effect: (run: () => () => void) => run() } as never, {
    bridge: {} as never,
    tracker: {} as never,
    captureBlockedReason: () => null,
    captureScopeAuthorized: () => true,
  }))
})

test('commands 服务晚于插件就绪时，等它出现再注册', () => {
  let ready = false
  let pending: (() => void) | null = null
  const definitions: Definition[] = []
  const service = { register: (definition: Definition) => { definitions.push(definition); return () => {} } }
  const ctx = {
    get: (name: string) => (ready && name === 'commands' ? service : undefined),
    effect: (run: () => () => void) => run(),
    inject: (_deps: string[], callback: (scope: unknown) => void) => { pending = () => callback(ctx) },
  }
  registerUserCommands(ctx as never, {
    bridge: { teamEnabled: false, bind: async () => ({ port: 1 }), launchPet: () => true } as never,
    tracker: { capturing: false } as never,
    captureBlockedReason: () => null,
    captureScopeAuthorized: () => true,
  })
  assert.equal(definitions.length, 0)
  ready = true
  assert.ok(pending)
  pending!()
  assert.deepEqual(definitions.map(item => item.name), ['summon-pet', 'bind-pet', 'assistant-on', 'assistant-off'])
})

test('注册四个命令：召唤、绑定、开启、关闭', () => {
  const { definitions } = harness()
  assert.deepEqual(definitions.map(item => item.name), ['summon-pet', 'bind-pet', 'assistant-on', 'assistant-off'])
  for (const item of definitions) assert.ok(item.description.trim().length > 0)
})

test('召唤命令绑定当前会话并拉起桌宠', async () => {
  const { command, events } = harness()
  const result = await command('summon-pet').handler({ agent: { id: 'agent-1' } })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已召唤/)
  assert.deepEqual(events, ['bind', 'launch'])
})

test('召唤命令失败时如实返回错误，不假装成功', async () => {
  const { command } = harness({ bind: async () => { throw new Error('bind failed') } })
  const result = await command('summon-pet').handler({ agent: { id: 'agent-1' } })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /bind failed/)
})

test('绑定命令只绑定会话，不启动桌宠', async () => {
  const { command, events } = harness()
  const result = await command('bind-pet').handler({ agent: { id: 'agent-1' } })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已绑定/)
  assert.deepEqual(events, ['bind'])
})

test('没有可绑定会话时仍把宠物叫出来，只是暂不绑定', async () => {
  const { command, events } = harness()
  const result = await command('summon-pet').handler({})
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已启动/)
  assert.deepEqual(events, ['launch'])
})

test('开启命令在范围未确认时给出明确指引', async () => {
  const { command, events } = harness({ scope: false })
  const result = await command('assistant-on').handler({})
  assert.equal(result.kind, 'error')
  assert.match(result.text, /采集范围/)
  assert.deepEqual(events, [])
})

test('开启命令在采集被拦住时不启动', async () => {
  const { command, events } = harness({ blocked: '平台不支持' })
  const result = await command('assistant-on').handler({})
  assert.equal(result.kind, 'error')
  assert.match(result.text, /平台不支持/)
  assert.deepEqual(events, [])
})

test('开启与关闭命令直接驱动 tracker', async () => {
  const on = harness()
  assert.equal((await on.command('assistant-on').handler({})).kind, 'success')
  assert.deepEqual(on.events, ['start'])

  const running = harness({ capturing: true })
  assert.match((await running.command('assistant-on').handler({})).text, /已经在运行/)
  assert.deepEqual(running.events, [])

  const off = harness()
  assert.equal((await off.command('assistant-off').handler({})).kind, 'success')
  assert.deepEqual(off.events, ['stop'])
})
