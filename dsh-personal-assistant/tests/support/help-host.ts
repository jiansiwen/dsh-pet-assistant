/**
 * 帮助任务测试共用的宿主（不是测试文件本身）：真实团队库、真实审批服务、真实帮助授权表，
 * 授权项目放在系统临时目录。可以把「批准后执行」改成手动调度，用来制造「批准后、应用前」的窗口。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TestContext } from 'node:test'
import { ApprovalService } from '../../src/approval.ts'
import type { CommitHooks } from '../../src/change-set.ts'
import { HelpContextStore, HelpEpisodeStore } from '../../src/help-context.ts'
import { sha256Hex } from '../../src/change-set.ts'
import { TeamStore } from '../../src/team-domain.ts'
import { TeamService } from '../../src/team.ts'

export const quiet = { info() {}, warn() {}, error() {} }
export const desktop = { channel: 'desktop-shell' } as const

export function hashOf(text: string): string {
  return sha256Hex(Buffer.from(text, 'utf8'))
}

export interface HelpHostOptions {
  readonly ttlMs?: number
  /** 批准后不立即执行，攒在队列里由测试手动放行。 */
  readonly manual?: boolean
  readonly commitHooks?: CommitHooks
  readonly env?: NodeJS.ProcessEnv
  /** 团队库用文件（便于另开连接篡改或模拟重启）。 */
  readonly fileDb?: boolean
}

export function helpHost(t: TestContext, options: HelpHostOptions = {}) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'dsh-help-task-')))
  const root = path.join(dir, 'repo')
  mkdirSync(path.join(root, 'src'), { recursive: true })
  mkdirSync(path.join(root, 'test'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'calc.js'), 'function add(a, b) {\n  return a - b\n}\nmodule.exports = { add }\n')
  const sibling = path.join(dir, 'repo-other')
  mkdirSync(sibling)
  writeFileSync(path.join(sibling, 'secret.txt'), '不在授权范围内')

  const assistantDb = new DatabaseSync(path.join(dir, 'assistant.sqlite'))
  const helpContexts = new HelpContextStore(assistantDb)
  const episodes = new HelpEpisodeStore(assistantDb)
  const teamDbPath = path.join(dir, 'team.sqlite')
  const store = new TeamStore(options.fileDb ? teamDbPath : ':memory:')
  const approvals = new ApprovalService(store, { ttlMs: options.ttlMs ?? 60_000, runtimeEpoch: 'test' })
  const queue: Array<() => void> = []
  const team = new TeamService({} as never, store, {
    teamId: 'test', provider: 'spawn', seats: [], maxConcurrentInference: 1, maxConcurrentSideEffect: 1, taskTimeoutMs: 1000,
    defaultBudgetTokens: 0, denyExpertTools: [], approvals, logger: quiet, helpScopes: helpContexts, episodes,
    helpExecution: {
      ...(options.manual ? { schedule: (run: () => void) => { queue.push(run) } } : {}),
      ...(options.commitHooks ? { commitHooks: options.commitHooks } : {}),
      ...(options.env ? { env: options.env } : {}),
    },
  })
  team.ensureRoster()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await team.dispose().catch(() => undefined)
    store.close()
    assistantDb.close()
  }
  // Windows 上库连接没关就删不掉目录：先关库再删。
  t.after(async () => {
    await close()
    rmSync(dir, { recursive: true, force: true })
  })

  let seq = 0
  /** 直接登记一条有效的帮助授权（等同于用户已在桌面批准了读取范围）。 */
  const authorize = (projectDir = root, currentFile: string | null = null) =>
    helpContexts.add(`help-test-${++seq}`, projectDir, currentFile, null, Date.now())
  const open = (goal = '修复加法') => {
    const context = authorize()
    const { task } = team.help.openTask({ projectDir: root, goal, helpContextId: context.id })
    return { task, context }
  }
  const approve = (proposalId: string) => approvals.issue(proposalId, desktop, true)
  const reject = (proposalId: string) => approvals.reject(proposalId, desktop, true)
  const wait = (proposalId: string, timeoutMs = 10_000) => team.help.wait(proposalId, new AbortController().signal, timeoutMs)
  /** 等审批回调把执行排进队列（回调在批准签发后的下一拍）。 */
  const queued = async () => {
    for (let i = 0; i < 200 && queue.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
    if (queue.length === 0) throw new Error('批准后没有排进执行队列')
  }
  const runQueued = async () => {
    await queued()
    const run = queue.shift()!
    run()
  }
  const calc = path.join(root, 'src', 'calc.js')
  return {
    dir, root, sibling, calc, store, approvals, team, helpContexts, episodes, assistantDb, queue, teamDbPath,
    authorize, open, approve, reject, wait, queued, runQueued, close,
  }
}

export type HelpHost = ReturnType<typeof helpHost>
