/**
 * 副作用执行器测试共用的宿主替身（不是测试文件本身，node --test 不会单独运行它）。
 *
 * 只顶替「子代理怎么跑」：start() 返回一个进程内 localAgent（真实 dsh-scope 作用域），子代理的工具
 * 调用由测试直接走真实 ToolRuntime 的 ctx.tools.execute —— pre-execute、守卫、tools/execute、
 * tools/result 全是宿主自己的管线，门禁与账本行为不靠假对象自证。工具体只记录调用，不碰真实文件与进程。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivationSpec, SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ApprovalService } from '../../src/approval.ts'
import { Config } from '../../src/config.ts'
import { TeamStore } from '../../src/team-domain.ts'
import { TeamService, type TeamOptions } from '../../src/team.ts'

const require = createRequire(import.meta.url)
const hostRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'))
const { default: SystemPrompt } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-system-prompt')).href)
const { createScope } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-scope')).href)

export const quiet = { info() {}, warn() {}, error() {} }
export const report = { summary: '已按批准执行', artifacts: [], blockers: [], needsApproval: [] }
export const completed: SubagentResult = { stopReason: 'completed', output: [], structured: report }

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function waitFor<T>(probe: () => T | null | undefined | false, label: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

export interface ScopedAgent {
  readonly agent: Agent
  readonly ctx: Context
  readonly events: Array<{ type: string; data: Record<string, unknown> }>
}

export interface HostOptions {
  readonly ttlMs?: number
  /** 父会话没有工作目录：写类工具没有授权根。 */
  readonly noWorkspace?: boolean
  readonly team?: Partial<TeamOptions>
  /** 覆盖默认注册的工具（名字 → 参数字段）。 */
  readonly tools?: Readonly<Record<string, readonly string[]>>
  /** 用文件库而不是内存库，便于模拟进程重启后重新打开。 */
  readonly dbPath?: string
  /** 在门禁之前挂一层永不放行的 tools/execute 包装：批准已消费、工具体永远进不去（模拟执行前中断）。 */
  readonly stallBeforeDispatch?: boolean
}

export async function sideEffectHost(t: TestContext, options: HostOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  if (options.stallBeforeDispatch) ctx.on('tools/execute', () => new Promise<never>(() => undefined))
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'dsh-side-effect-')))
  const workspace = path.join(dir, 'ws')
  mkdirSync(workspace)

  const scoped = async (id: string, cwd: string | undefined, parentSession?: string, parentScope?: Agent): Promise<ScopedAgent> => {
    const agent = { id } as Agent
    let scope!: { ctx: Context; dispose(): Promise<void> }
    await ctx.plugin(Object.assign((inner: Context) => {
      scope = createScope(inner, agent, parentScope === undefined ? undefined : { parent: parentScope })
    }, { inject: ['tools', 'systemPrompt'] }))
    const events: ScopedAgent['events'] = []
    Object.assign(agent, { ctx: scope.ctx, session: { header: { id, parentSession, cwd }, events, snapshotEvents: () => events } })
    Object.defineProperty(scope.ctx, 'agent', { value: agent, configurable: true })
    t.after(() => scope.dispose())
    return { agent, ctx: scope.ctx, events }
  }

  const cwd = options.noWorkspace ? undefined : workspace
  const parent = { id: 'parent-session', session: { header: { id: 'parent-session', cwd }, events: [] } } as unknown as Agent
  const child = await scoped('child-session', cwd, 'parent-session')

  const bodies: string[] = []
  const hang = new Map<string, Promise<void>>()
  const failing = new Set<string>()
  const register = (name: string, fields: readonly string[]) => {
    const tool: ToolDefinition = {
      name,
      description: '无副作用测试替身：只记录调用，不碰真实文件与进程',
      parameters: { type: 'object', properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])) },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: '测试成功' }] },
      async execute() {
        bodies.push(name)
        await hang.get(name)
        if (failing.has(name)) throw new Error('可能已部分完成')
        return '测试成功'
      },
    }
    ctx.tools.register(tool)
  }
  const tools = options.tools ?? {
    read: ['file_path'], grep: ['pattern'], write: ['file_path', 'content'], edit: ['file_path', 'old_string', 'new_string'],
    bash: ['command'], todo_write: ['todos'], subagent: ['prompt'],
  }
  for (const [name, fields] of Object.entries(tools)) register(name, fields)

  const store = new TeamStore(options.dbPath ?? ':memory:')
  const approvals = new ApprovalService(store, { ttlMs: options.ttlMs ?? 60_000, runtimeEpoch: 'test' })
  const requests: SubagentStartRequest[] = []
  const result = deferred<SubagentResult>()
  let onStart: (request: SubagentStartRequest) => Promise<void> | void = () => undefined
  let disposeImpl: () => Promise<void> = async () => undefined
  let disposed = 0
  const start = async (_provider: string, request: SubagentStartRequest): Promise<SubagentRun> => {
    requests.push(request)
    // 宿主在子代理首个回合里写下持久描述符；定向门禁靠它认出这次委派。
    child.events.push({ type: 'subagent/descriptor', data: { label: request.label } })
    await onStart(request)
    return { id: child.agent.id, localAgent: child.agent, result: result.promise, dispose: async () => { disposed += 1; await disposeImpl() } }
  }
  const teamHost = {
    tools: ctx.tools,
    agents: { get: (id: string) => id === child.agent.id ? child.agent : undefined },
    subagents: {
      start,
      startActivation: async (input: SubagentActivationSpec) => {
        const run = await start(input.provider, { ...input.request, label: input.label, signal: input.signal })
        return { id: child.agent.id, childId: child.agent.id, messageId: `message-${requests.length}`,
          result: run.result, dispose: run.dispose }
      },
    },
  }
  const teamOptions: TeamOptions = {
    teamId: 'test', provider: 'spawn', maxConcurrentInference: 2, maxConcurrentSideEffect: 1, taskTimeoutMs: 10_000,
    // 默认配置：用户选择不设累计预算。
    defaultBudgetTokens: Config({} as never).defaultBudgetTokens,
    seats: [], denyExpertTools: [], approvals, logger: quiet, ...options.team,
  }
  const team = new TeamService(teamHost as never, store, teamOptions)
  team.ensureRoster()
  t.after(async () => {
    result.resolve(completed)
    await team.dispose().catch(() => undefined)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  let callSeq = 0
  const exec = (name: string, args: unknown, agent: Agent = child.agent, signal = new AbortController().signal) =>
    ctx.tools.execute({ callId: `call-${++callSeq}` as never, name, arguments: args, agent, signal })

  /** 提交一项总助理的副作用任务并跑到「子代理已启动、精确门禁已就位」。 */
  const startSideEffect = async (goal = '按批准写文件') => {
    const task = team.submitTask({ goal, ownerId: 'member-tangseng', toolScope: 'side-effect' })
    const pending = team.runTask(task.taskId, parent, new AbortController().signal)
    await waitFor(() => store.listRuns(task.taskId)[0]?.childSessionId, '子代理启动且精确门禁装好')
    return { task: store.getTask(task.taskId)!, pending }
  }
  const pendingCard = (except: readonly string[] = []) =>
    waitFor(() => approvals.pendingProposals().find(item => !except.includes(item.proposalId)), '审批卡出现')

  return {
    ctx, team, store, approvals, parent, child, workspace, dir, bodies, requests, exec, scoped, startSideEffect, pendingCard,
    teamOptions,
    hang: (name: string, gate: Promise<void>) => { hang.set(name, gate) },
    fail: (name: string) => { failing.add(name) },
    finish: (value: SubagentResult = completed) => result.resolve(value),
    setOnStart: (fn: typeof onStart) => { onStart = fn },
    setDispose: (fn: typeof disposeImpl) => { disposeImpl = fn },
    disposed: () => disposed,
  }
}

export type SideEffectHost = Awaited<ReturnType<typeof sideEffectHost>>
