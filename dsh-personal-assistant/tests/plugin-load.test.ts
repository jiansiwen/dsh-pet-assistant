/**
 * M1-01 装配层：用真实 cordis 与真实 AgentRegistry（dsh-agent）加载插件入口。
 *
 * 只有宿主服务（tools / systemPrompt / storageDomain）与智能体工厂是替身：工厂照真实 agent-loop 的做法
 * 经 registry.enter/announce 发布会话，并把生命周期挂在调用方 fiber 上（ownerCtx.effect），
 * 不启动模型、不拉采样器、不碰真实 ~/.dsh。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { Config, type Config as ConfigType } from '../src/config.ts'
import * as plugin from '../src/index.ts'

type Tool = { execute(args: unknown, exec?: unknown): Promise<string> }

/** 切到独立的 DSH_HOME；收尾时先跑 cleanup（卸插件、关库），再删目录、还原环境。 */
function isolatedHome(t: TestContext, cleanup: () => Promise<void> = async () => {}): string {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-plugin-load-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    await cleanup()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

function fakeDomain() {
  let global: Record<string, unknown> = { active: false, startedAt: 0 }
  const tables = new Map<string, Map<string, unknown>>()
  return {
    global: { get: () => global, set: async (value: Record<string, unknown>) => { global = value } },
    table(name: string) {
      const rows = tables.get(name) ?? new Map<string, unknown>()
      tables.set(name, rows)
      return {
        get: (key: string) => rows.get(key),
        entries: () => new Map(rows).entries(),
        put: async (key: string, value: unknown) => { rows.set(key, value) },
        delete: async (key: string) => rows.delete(key),
        get size() { return rows.size },
      }
    },
    async close() {},
  }
}

function hostServices() {
  const tools = new Map<string, Tool>()
  return {
    tools,
    tool(name: string): Tool {
      const tool = tools.get(name)
      assert.ok(tool, `工具没注册：${name}`)
      return tool
    },
    services: {
      tools: { register(definition: Tool & { name: string }) { tools.set(definition.name, definition); return () => { tools.delete(definition.name) } } },
      systemPrompt: { section: () => () => {}, variable: () => () => {} },
      storageDomain: { async open() { return fakeDomain() } },
    },
  }
}

const quietConfig = (overrides: Partial<ConfigType> = {}): ConfigType =>
  Config({ captureActivity: false, proactiveEnabled: false, migrateLegacy: false, petDir: '', ...overrides } as never)

function bridgeClient(home: string) {
  const infoPath = path.join(home, 'personal-assistant', 'bridge.json')
  const info = () => JSON.parse(readFileSync(infoPath, 'utf8')) as { port: number; token: string; epoch: string }
  const call = async (method: string, pathname: string) => {
    const { port, token } = info()
    const response = await fetch(`http://127.0.0.1:${port}${pathname}?token=${token}`, {
      method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}),
    })
    return { status: response.status, body: await response.json() as any }
  }
  return { infoPath, info, health: () => call('GET', '/health'), start: () => call('POST', '/session/start') }
}

async function until(probe: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (probe()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`等待超时：${label}`)
}

/** 照真实 agent-loop 的发布方式造会话：registry.enter + announce，生命周期挂在调用方 fiber 上。 */
function fakeAgentLoop() {
  const log = { created: [] as string[], resumed: [] as string[], disposed: [] as string[], owners: [] as string[], cancelled: [] as string[] }
  let registry!: AgentRegistry
  const publish = (ownerCtx: Context, id: string) => {
    const agent = { id, status: 'idle', session: { id, events: [] }, followup() {}, cancel() { log.cancelled.push(id) } }
    const detach = registry.enter(agent as never, undefined)
    registry.announce(agent as never)
    let disposing: Promise<void> | undefined
    const dispose = () => disposing ??= (async () => {
      log.disposed.push(id)
      detach()
    })()
    ownerCtx.effect(() => () => dispose(), `fake.lifecycle(${id})`)
    log.owners.push(ownerCtx.fiber.name)
    return { agent, dispose }
  }
  return {
    log,
    install(ctx: Context) {
      registry = ctx.agents
      ctx.agents.setFactory({
        async createAgent(ownerCtx: Context, options: { sessionId: string }) {
          log.created.push(options.sessionId)
          return publish(ownerCtx, options.sessionId)
        },
        async resume(_ownerCtx: Context, options: { resumeSessionId: string }) {
          log.resumed.push(options.resumeSessionId)
          throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
        },
      } as never)
    },
  }
}

const pluginShape = { name: plugin.name, inject: plugin.inject, apply: plugin.apply }

test('inject 只声明必需服务、不含 agents（cordis 4 的 inject 每一项都是必需依赖，见下一条的对照组）', () => {
  assert.deepEqual(plugin.inject, ['tools', 'storageDomain', 'systemPrompt'])
})

test('真实 cordis：没有 agents 也加载并监听；agents 后装可现取；自建会话归本插件并在卸载时释放，网页会话不碰', async t => {
  const root = new Context()
  const home = isolatedHome(t, () => root.fiber.dispose())
  const host = hostServices()
  await root.plugin((ctx: Context) => {
    ctx.provide('tools', host.services.tools)
    ctx.provide('systemPrompt', host.services.systemPrompt)
    ctx.provide('storageDomain', host.services.storageDomain)
  })
  let controlApplied = 0
  const control = root.plugin({ name: 'control-needs-agents', inject: [...plugin.inject, 'agents'], apply: () => { controlApplied += 1 } })

  const fiber = root.plugin(pluginShape, quietConfig())
  await fiber
  const bridge = bridgeClient(home)
  assert.ok(existsSync(bridge.infoPath), '加载即写出发现文件，不等召唤')
  const health = (await bridge.health()).body
  assert.deepEqual([health.ok, health.bound], [true, false])
  assert.equal(controlApplied, 0, '对照组：inject 写了 agents 的插件在没有 agents 的宿主里根本不加载')
  const missing = await bridge.start()
  assert.equal(missing.status, 503)
  assert.equal(missing.body.code, 'agents-unavailable')

  await root.plugin(AgentRegistry)
  const loop = fakeAgentLoop()
  await root.plugin({ name: 'fake-agent-loop', inject: ['agents'], apply: (ctx: Context) => loop.install(ctx) })
  await until(() => controlApplied === 1, '对照组在 agents 出现后才加载')
  await control.dispose()

  // 网页会话：由另一个插件（网页宿主的替身）创建并持有。
  let web!: Context
  const webFiber = root.plugin({ name: 'fake-web', inject: ['agents'], apply: (ctx: Context) => { web = ctx } })
  await webFiber
  const web1 = await web.agents.create({ sessionId: 'web-1' as never })
  const web2 = await web.agents.create({ sessionId: 'web-2' as never })
  const summon = host.tool('personal_assistant_summon_pet')
  assert.equal(JSON.parse(await summon.execute({}, { agent: web1.agent })).petLaunched, false)
  const existing = await bridge.start()
  assert.deepEqual([existing.body.outcome, existing.body.owned, existing.body.sessionId], ['existing', false, 'web-1'])

  // 网页换到 web-2 后它被自己的持有者关掉：宿主发 agent/disposed，桥接如实回到未绑定。
  await summon.execute({}, { agent: web2.agent })
  await web2.dispose()
  assert.equal((await bridge.health()).body.bound, false)

  const created = await bridge.start()
  assert.equal(created.status, 200)
  assert.deepEqual([created.body.outcome, created.body.owned], ['created', true])
  assert.deepEqual(loop.log.owners, ['fake-web', 'fake-web', 'personal-assistant'], '自建会话的生命周期挂在本插件 fiber 上')
  assert.equal((await bridge.health()).body.bound, true)
  assert.equal((await bridge.start()).body.outcome, 'existing')
  assert.equal(loop.log.created.length, 3, '重复开始不再新建')

  await fiber.dispose()
  assert.deepEqual(loop.log.disposed, ['web-2', created.body.sessionId], '卸载只释放自建会话，且只释放一次')
  assert.ok(web.agents.get('web-1' as never), '网页会话仍在线')
  assert.deepEqual(loop.log.cancelled, [], '从不 cancel 网页会话')
  assert.equal(existsSync(bridge.infoPath), false, '卸载删掉自己写的发现文件')

  // 重新加载：按 user_flags 里的记录尝试恢复；恢复失败就新建，并如实带回原因。
  const reloaded = root.plugin(pluginShape, quietConfig())
  await reloaded
  const second = await bridge.start()
  assert.equal(second.body.outcome, 'created')
  assert.deepEqual(loop.log.resumed, [created.body.sessionId])
  assert.match(second.body.resumeError, /session persistence is not configured/)
  assert.notEqual(second.body.sessionId, created.body.sessionId)
  await reloaded.dispose()
  assert.ok(loop.log.disposed.includes(second.body.sessionId))
  assert.equal(loop.log.disposed.includes('web-1'), false)
  await webFiber.dispose()
})

test('假宿主连 ctx.get 都没有：插件照常加载、监听，开始会话如实回 agents-unavailable', async t => {
  const disposers: Array<() => unknown> = []
  const home = isolatedHome(t, async () => { while (disposers.length) await disposers.pop()!() })
  const host = hostServices()
  const ctx = {
    ...host.services,
    effect(execute: () => () => unknown) { disposers.push(execute()) },
    on() {},
  }
  await plugin.apply(ctx as never, quietConfig())
  const bridge = bridgeClient(home)
  assert.equal((await bridge.health()).body.bound, false)
  const result = await bridge.start()
  assert.deepEqual([result.status, result.body.code], [503, 'agents-unavailable'])
})

test('平台闸门：macOS 不再被拦（开启助理只待可信批准），Linux 如实拒绝；都不拉起采样器', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  const previousHome = process.env.DSH_HOME
  for (const [platform, expectation] of [['darwin', 'pending'], ['linux', 'refused']] as const) {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-plugin-platform-'))
    const disposers: Array<() => unknown> = []
    process.env.DSH_HOME = home
    Object.defineProperty(process, 'platform', { ...original, value: platform })
    try {
      const host = hostServices()
      await plugin.apply({ ...host.services, effect(execute: () => () => unknown) { disposers.push(execute()) }, on() {} } as never,
        quietConfig({ captureActivity: true }))
      const started = JSON.parse(await host.tool('personal_assistant_start').execute({}))
      if (expectation === 'pending') {
        assert.equal(started.pending, true, 'macOS 有采样实现：先走可信采集范围审批')
      } else {
        assert.equal(started.status, 'refused')
        assert.match(started.message, /Windows 与 macOS/)
        assert.match(started.message, /linux/)
      }
      assert.equal(existsSync(path.join(home, 'personal-assistant', 'samples', 'sampler.pid')), false, '不拉起采样器')
    } finally {
      Object.defineProperty(process, 'platform', original)
      while (disposers.length) await disposers.pop()!()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
  }
})
