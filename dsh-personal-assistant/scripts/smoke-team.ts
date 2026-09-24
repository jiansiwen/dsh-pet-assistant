/**
 * 团队存储、审批链路与任务状态机的冒烟验证。
 *
 * 这三块的正确性只会在运行时暴露：SQL 语法、node:sqlite 的参数类型约束、修订号乐观并发、
 * 批准的单次消费。宿主用假的 ctx.subagents 顶替，以便断言委派请求里真的带上了角色人设、
 * 结构化输出 schema 与「只禁用运行时存在的工具」这份名单。
 *
 * 跑法：npm run smoke
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ApprovalError, ApprovalService, type GateCall } from '../src/approval.ts'
import { TeamService, type TeamOptions } from '../src/team.ts'
import { TEAM_SCHEMA_VERSION, TeamStore } from '../src/team-domain.ts'

interface Delegation {
  provider: string
  request: Record<string, any>
}

interface FakeResult {
  output: Array<{ type: string; text?: string }>
  structured?: unknown
  diagnostic?: string
  stopReason: string
}

/**
 * 假装宿主里存在的工具，名字逐个取自 0.1.1-rc.2 的安装产物
 * （`dsh-base/cordis.patch.yml` 实际挂载的 dsh-tool-* 包），不是猜的。
 *
 * 这张表要足够全，才能真的检验「按存在性过滤 deny 名单」：真名进 deny，
 * 猜名（write_file / task / agent / delegate / nonexistent_tool_xyz）必须被丢掉，
 * 否则宿主会大声拒绝整个委派请求。
 */
const existingTools = new Set([
  // 观测面（只读席位要留着）
  'read',
  'read_image',
  'glob',
  'grep',
  'job_list',
  'job_output',
  'get_goal',
  'web_fetch',
  'web_search',
  'report',
  // 副作用面（只读席位默认要禁）
  'bash',
  'pwsh',
  'write',
  'edit',
  'str_replace_editor',
  'skill',
  'job_kill',
  'todo_write',
  'create_goal',
  'update_goal',
  // 委派面（只读席位默认要禁）
  'subagent',
  'subagent_fork',
  'workflow',
  'ralph',
  'send_message',
  'interrupt_agent',
  // 本插件自己的工具
  'personal_assistant_start',
])
const delegations: Delegation[] = []
const logs: string[] = []
let disposed = 0
let nextResult: FakeResult = { output: [], stopReason: 'completed' }

/** 装到假 ctx 上的守卫；测试直接调用它来验证门禁行为。agentId 区分宿主层与子代理层。 */
const installedGuards: Array<{ agentId: string; guard: (execution: any) => string | undefined; agent?: unknown }> = []
let guardDisposals = 0

function fakeChildAgent(agentId: string) {
  const ctx: any = {
    tools: {
      guard(guard: (execution: any) => string | undefined) {
        installedGuards.push({ agentId, guard, agent: ctx.agent })
        return () => {
          guardDisposals += 1
        }
      },
    },
  }
  // installReadOnlyGate 要求「精确的 agent.ctx」：ctx.agent.ctx 必须指回 ctx 本身。
  ctx.agent = { id: agentId, ctx }
  return { id: agentId, ctx }
}

/** 假子代理运行；`localAgent` 可空正是远程 provider 的真实形状，门禁装不上就得失败关闭。 */
interface FakeRun {
  readonly id: string
  readonly localAgent: ReturnType<typeof fakeChildAgent> | undefined
  readonly result: Promise<FakeResult>
  dispose(): Promise<void>
}

async function defaultStart(provider: string, request: Record<string, any>): Promise<FakeRun> {
  delegations.push({ provider, request })
  return {
    id: 'child-session-smoke',
    localAgent: fakeChildAgent(`agent-${delegations.length}`),
    result: Promise.resolve(nextResult),
    async dispose() {
      disposed += 1
    },
  }
}

/** 远程 provider 的样子：拿不到 agent ctx，门禁就装不上，生产代码必须失败关闭。 */
async function remoteStart(provider: string, request: Record<string, any>): Promise<FakeRun> {
  delegations.push({ provider, request })
  return {
    id: 'child-session-remote',
    localAgent: undefined,
    result: Promise.resolve(nextResult),
    async dispose() {
      disposed += 1
    },
  }
}

let startImpl: (provider: string, request: Record<string, any>) => Promise<FakeRun> = defaultStart

const fakeCtx = {
  subagents: {
    start: (provider: string, request: Record<string, any>) => startImpl(provider, request),
  },
  tools: {
    get: (name: string) => (existingTools.has(name) ? {} : undefined),
    // 宿主层 tools.guard：installDelegationReadOnlyGate 装在总助理会话的 ctx 上，
    // 覆盖 start() 返回前的调用窗口。
    guard(guard: (execution: any) => string | undefined) {
      installedGuards.push({ agentId: 'host', guard })
      return () => {
        guardDisposals += 1
      }
    },
  },
}

const options: Omit<TeamOptions, 'approvals'> = {
  teamId: 'smoke-team',
  provider: 'spawn',
  maxConcurrentInference: 2,
  maxConcurrentSideEffect: 1,
  taskTimeoutMs: 60_000,
  // 当前宿主无法硬约束累计 token 预算：非零预算的任务会在启动前被拒（budget-unsupported）。
  // 套件默认 0（= 不设累计预算），委派链路才真的跑得起来；非零预算的拒绝单独断言。
  defaultBudgetTokens: 0,
  seats: [],
  denyExpertTools: ['web_fetch', 'nonexistent_tool_xyz'],
  logger: {
    info: (message) => logs.push(`info ${message}`),
    warn: (message) => logs.push(`warn ${message}`),
    error: (message) => logs.push(`error ${message}`),
  },
}

let passed = 0
let activeStore: TeamStore | null = null

function check(label: string, body: () => void): void {
  body()
  passed += 1
  console.log(`  ok   ${label}`)
}

async function checkAsync(label: string, body: () => Promise<void>): Promise<void> {
  await body()
  passed += 1
  console.log(`  ok   ${label}`)
}

/** 取出抛出的异常本体；没有抛错就算失败。assert.throws 不返回异常，不能拿来当捕获用。 */
function thrownBy(body: () => unknown): unknown {
  try {
    body()
  } catch (error) {
    return error
  }
  return new Error('expected the call to throw, but it returned normally')
}

function approvalCode(error: unknown): string {
  if (!(error instanceof ApprovalError)) return `NOT_AN_APPROVAL_ERROR: ${String(error)}`
  return error.code
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-team-smoke-'))
const dbPath = path.join(dir, 'team.sqlite')

async function main(): Promise<void> {
  const store = new TeamStore(dbPath)
  activeStore = store
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'epoch-smoke' })
  const team = new TeamService(fakeCtx as never, store, { ...options, approvals })
  const signal = new AbortController().signal
  // id 是启动期定向守卫的匹配键（session.header.parentSession === String(parentAgent.id)）。
  const parentAgent = { id: 'parent-agent-smoke', session: { id: 'parent-smoke' } } as never

  console.log('== 存储层')
  check('建库落盘 schema 版本，重复打开可用', () => {
    const probe = new TeamStore(dbPath)
    assert.deepEqual(probe.listMembers(), [])
    probe.close()
    const db = new DatabaseSync(dbPath)
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    db.close()
    assert.equal(row.user_version, TEAM_SCHEMA_VERSION)
  })

  check('v2 老库升 v3：补 tool 列不丢老数据，重复打开也安全', () => {
    const legacyPath = path.join(dir, 'legacy-team.sqlite')
    const legacy = new TeamStore(legacyPath)
    const legacyApprovals = new ApprovalService(legacy, { ttlMs: 60_000, runtimeEpoch: 'epoch-legacy' })
    const legacyTeam = new TeamService(fakeCtx as never, legacy, { ...options, approvals: legacyApprovals })
    legacyTeam.ensureRoster()
    const task = legacyTeam.submitTask({ goal: '老库里已经在跑的任务', ownerId: 'member-wukong' })
    const legacyProposal = legacyApprovals.propose({
      taskId: task.taskId,
      assistantId: 'member-wukong',
      summary: '老库里已经批准的提案',
      tool: 'write',
      target: 'D:/tmp/legacy.md',
      params: null,
      inputRevision: task.revision,
      risk: 'low',
    })
    legacyApprovals.issue(legacyProposal.proposalId, { channel: 'desktop-shell', windowId: 1 }, true)
    legacy.close()

    // 退回 v2 的形状。先删索引再删列：SQLite 不允许删掉仍被索引引用的列。
    const raw = new DatabaseSync(legacyPath)
    raw.exec(`DROP INDEX IF EXISTS idx_proposals_gate`)
    raw.exec(`ALTER TABLE action_proposals DROP COLUMN tool`)
    raw.exec(`PRAGMA user_version = 2`)
    raw.close()

    const before = new DatabaseSync(legacyPath, { readOnly: true })
    assert.equal((before.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2)
    const beforeColumns = before.prepare('PRAGMA table_info(action_proposals)').all() as Array<{ name: string }>
    assert.equal(
      beforeColumns.some((column) => column.name === 'tool'),
      false,
      '前置条件没造出来的话，这个测试就只是在验证全新建库',
    )
    before.close()

    // CREATE TABLE IF NOT EXISTS 对已存在的 v2 表是空操作，所以 tool 列只能靠显式 ALTER 补上。
    const migrated = new TeamStore(legacyPath)
    const migratedApprovals = new ApprovalService(migrated, { ttlMs: 60_000, runtimeEpoch: 'epoch-migrated' })

    const survived = migrated.getProposal(legacyProposal.proposalId)
    assert.ok(survived, '迁移不得丢掉老提案')
    assert.equal(survived.summary, '老库里已经批准的提案')
    assert.equal(survived.state, 'approved', '批准状态要在迁移后依然有效')
    assert.equal(survived.target, 'D:/tmp/legacy.md')
    assert.equal(survived.tool, '', 'v2 的老行没有工具名，按 DEFAULT 补空串，不要替用户编一个出来')
    assert.equal(migrated.listTasks().length, 1)
    assert.equal(migrated.listMembers().length, 5)

    // 补上来的列必须真能参与门禁查找，否则只是表结构好看了而已。
    const freshTask = migrated.listTasks()[0]
    const fresh = migratedApprovals.propose({
      taskId: freshTask.taskId,
      assistantId: 'member-wukong',
      summary: '迁移后新提的提案',
      tool: 'write',
      target: 'D:/tmp/fresh.md',
      params: null,
      inputRevision: freshTask.revision,
      risk: 'low',
    })
    assert.equal(migrated.findGateProposal(fresh.taskId, 'write', 'D:/tmp/fresh.md'), null, '没批准之前门禁不该放行')
    migratedApprovals.issue(fresh.proposalId, { channel: 'desktop-shell', windowId: 2 }, true)
    const hit = migrated.findGateProposal(fresh.taskId, 'write', 'D:/tmp/fresh.md')
    assert.ok(hit, '迁移补出来的 tool 列要能被门禁查到')
    assert.equal(hit.proposalId, fresh.proposalId)
    assert.equal(hit.tool, 'write')
    assert.equal(migrated.findGateProposal(fresh.taskId, 'write', 'D:/tmp/other.md'), null, '换个作用目标就查不到')
    assert.equal(migrated.listProposals().length, 2, '老提案与新提案都还在')
    migrated.close()

    const after = new DatabaseSync(legacyPath, { readOnly: true })
    assert.equal(
      (after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      TEAM_SCHEMA_VERSION,
    )
    const gateIndex = after
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_proposals_gate'`)
      .all() as Array<{ name: string }>
    assert.equal(gateIndex.length, 1, '门禁热路径的索引要在迁移里建起来')
    after.close()

    // 按列名判断的 ALTER 在已经是 v3 形状的库上重跑必须安全。
    const reopened = new TeamStore(legacyPath)
    assert.equal(reopened.listProposals().length, 2)
    assert.equal(reopened.getProposal(legacyProposal.proposalId)?.tool, '')
    reopened.close()
  })

  check('成员编制读写保留 JSON 与布尔字段', () => {
    const members = team.ensureRoster()
    assert.equal(members.length, 5)
    assert.equal(members.filter((member) => member.enabled).length, 3)
    const wukong = store.getMember('member-wukong')
    assert.ok(wukong)
    assert.equal(wukong.toolPolicy.mode, 'read-only')
    assert.equal(wukong.skinId, 'boy-glasses')
    assert.deepEqual(wukong.toolPolicy.denyTools, [])
  })

  check('ensureRoster 只补缺失，不覆盖用户改过的配置', () => {
    store.upsertMember({ ...store.getMember('member-bajie')!, displayName: '用户改过的名字', revision: 2 })
    team.ensureRoster()
    assert.equal(store.getMember('member-bajie')?.displayName, '用户改过的名字')
    store.upsertMember({ ...store.getMember('member-bajie')!, displayName: '猪八戒', revision: 3 })
  })

  check('点名解析：别名可用，未启用席位与未知名字都返回 null', () => {
    assert.equal(team.resolveByName('悟空')?.assistantId, 'member-wukong')
    assert.equal(team.resolveByName('WuKong')?.assistantId, 'member-wukong')
    assert.equal(team.resolveByName('总助理')?.assistantId, 'member-tangseng')
    assert.equal(team.resolveByName('沙僧'), null, '未启用席位不能接单')
    assert.equal(team.resolveByName('哪吒'), null, '未知名字不换人')
  })

  check('任务读写保留列表与 null 字段', () => {
    const task = team.submitTask({
      goal: '存储层往返',
      inputEvidence: ['证据一', '证据二'],
      acceptance: ['要有产物'],
      ownerId: 'member-wukong',
      budgetTokens: 42,
      originRequestId: 'req-roundtrip',
      originChannel: 'dsh-session',
    })
    const read = store.getTask(task.taskId)!
    assert.deepEqual(read.inputEvidence, ['证据一', '证据二'])
    assert.deepEqual(read.acceptance, ['要有产物'])
    assert.deepEqual(read.artifacts, [])
    assert.equal(read.deadlineAt, null)
    assert.equal(read.budgetTokens, 42)
    assert.equal(read.originRequestId, 'req-roundtrip')
    assert.equal(read.status, 'created')
    assert.equal(read.toolScope, 'read-only')
  })

  check('未知承接人、未启用席位与不存在的依赖都被拒绝', () => {
    assert.throws(() => team.submitTask({ goal: 'x', ownerId: 'member-nezha' }), /成员不存在或未启用：member-nezha/)
    assert.throws(
      () => team.submitTask({ goal: 'x', ownerId: 'member-shaseng' }),
      /成员不存在或未启用：member-shaseng/,
      '存在但未启用的席位同样不能接单，不静默换人',
    )
    assert.throws(() => team.submitTask({ goal: 'x', dependsOn: ['no-such-task'] }), /does not exist/)
    const a = team.submitTask({ goal: 'a', ownerId: 'member-wukong' })
    const b = team.submitTask({ goal: 'b', ownerId: 'member-wukong', dependsOn: [a.taskId] })
    assert.deepEqual(store.getTask(b.taskId)!.dependsOn, [a.taskId])
  })

  check('修订号乐观并发：过期修订更新失败', () => {
    const task = team.submitTask({ goal: '并发校验', ownerId: 'member-wukong' })
    assert.equal(store.updateTask(task.taskId, task.revision + 99, { status: 'running' }), null)
    const updated = store.updateTask(task.taskId, task.revision, { status: 'running' })
    assert.ok(updated)
    assert.equal(updated.status, 'running')
    assert.equal(updated.revision, task.revision + 1)
  })

  check('事件发件箱按游标增量读取', () => {
    const before = store.eventsSince(0, 500).length
    const seq = store.appendEvent('team/member-updated', { note: 'smoke' }, { taskId: null })
    assert.ok(seq > 0)
    const tail = store.eventsSince(before, 500)
    assert.equal(tail.length, 1)
    assert.equal(tail[0].type, 'team/member-updated')
    assert.deepEqual(tail[0].payload as Record<string, unknown>, { note: 'smoke' })
  })

  console.log('\n== 审批链路')
  // consume 只认「运行中的副作用任务」：任务先按 side-effect 范围提交并置成 running，
  // 提案与门禁调用（GateCall）都绑定这个修订号，任何一项对不上都消费不掉。
  const proposalTask = team.submitTask({ goal: '需要副作用的任务', ownerId: 'member-tangseng', toolScope: 'side-effect' })
  assert.ok(store.updateTask(proposalTask.taskId, proposalTask.revision, { status: 'running' }))
  const runningTask = store.getTask(proposalTask.taskId)!
  const gateCall: GateCall = {
    taskId: runningTask.taskId,
    assistantId: 'member-tangseng',
    tool: 'write',
    target: 'D:/tmp/report.md',
    params: { mode: 'append' },
    inputRevision: runningTask.revision,
  }

  let proposalId = ''
  check('提交提案不产生外部效果，只落一条待决记录', () => {
    const proposal = approvals.propose({
      taskId: gateCall.taskId,
      assistantId: gateCall.assistantId,
      summary: '把结论写进 report.md',
      tool: gateCall.tool,
      target: gateCall.target,
      params: gateCall.params,
      inputRevision: gateCall.inputRevision,
      risk: 'medium',
    })
    proposalId = proposal.proposalId
    assert.equal(proposal.state, 'pending')
    assert.equal(approvals.pendingProposals().length, 1)
    assert.equal(approvals.operations(proposalTask.taskId).length, 0)
    assert.equal(store.approvalForProposal(proposalId), null)
  })

  check('未签发批准时不能执行', () => {
    assert.equal(approvalCode(thrownBy(() => approvals.consumeByProposal(proposalId, 'write', gateCall))), 'NOT_FOUND')
  })

  check('不可信主体签发批准被拒，提案保持待决', () => {
    assert.equal(approvalCode(thrownBy(() => approvals.issue(proposalId, { channel: 'local-ui' }, false))), 'UNTRUSTED_SUBJECT')
    assert.equal(store.getProposal(proposalId)?.state, 'pending')
  })

  check('可信主体签发批准，计划摘要被固定下来', () => {
    const approval = approvals.issue(proposalId, { channel: 'desktop-shell', windowId: 7 }, true)
    assert.equal(store.getProposal(proposalId)?.state, 'approved')
    assert.equal(approval.planDigest.length, 64)
    assert.ok(approval.scope.includes('desktop-shell'))
    assert.ok(approval.expiresAt > Date.now())
    assert.equal(store.approvalForProposal(proposalId)?.approvalId, approval.approvalId)
  })

  check('计划摘要不符时消费失败（防篡改）', () => {
    const approval = store.approvalForProposal(proposalId)!
    assert.equal(store.consumeApproval(approval.approvalId, 'a'.repeat(64), Date.now()), false)
    assert.equal(store.getApproval(approval.approvalId)!.consumedAt, null)
  })

  check('GateCall 与提案逐项绑定：参数、目标、成员、工具或输入版本变了都消费不掉', () => {
    const mutations: GateCall[] = [
      { ...gateCall, params: { mode: 'overwrite' } },
      { ...gateCall, target: 'D:/tmp/other.md' },
      { ...gateCall, inputRevision: gateCall.inputRevision + 1 },
      { ...gateCall, assistantId: 'member-wukong' },
      { ...gateCall, tool: 'edit' },
    ]
    for (const changed of mutations) {
      assert.equal(
        approvalCode(thrownBy(() => approvals.consumeByProposal(proposalId, changed.tool, changed))),
        'DIGEST_MISMATCH',
        `${JSON.stringify(changed)} 与批准的计划不符，必须拒绝`,
      )
    }
    assert.equal(
      store.getApproval(store.approvalForProposal(proposalId)!.approvalId)!.consumedAt,
      null,
      '失败的消费不得把批准用掉',
    )
    assert.equal(approvals.operations(proposalTask.taskId).length, 0, '被拒的调用不得留下副作用账目')
  })

  let operationId = ''
  check('凭提案消费批准，批准 id 不必进入模型上下文', () => {
    const operation = approvals.consumeByProposal(proposalId, 'write', gateCall)
    operationId = operation.operationId
    assert.equal(operation.state, 'planned')
    assert.equal(operation.taskId, proposalTask.taskId)
    assert.equal(operation.kind, 'write', 'kind 用真实工具名，不用模型自报的分类')
  })

  check('同一条批准只能消费一次（防重放）', () => {
    assert.equal(approvalCode(thrownBy(() => approvals.consumeByProposal(proposalId, 'write', gateCall))), 'ALREADY_CONSUMED')
    assert.equal(approvals.operations(proposalTask.taskId).length, 1)
  })

  check('副作用结账写入结果摘要', () => {
    approvals.settle(operationId, 'succeeded', 'digest-smoke')
    const operation = store.getOperation(operationId)!
    assert.equal(operation.state, 'succeeded')
    assert.equal(operation.resultDigest, 'digest-smoke')
    assert.ok(operation.endedAt !== null)
  })

  check('运行时代次不符时旧批准一律失效', () => {
    approvals.assertEpoch('epoch-smoke')
    assert.equal(approvalCode(thrownBy(() => approvals.assertEpoch('epoch-stale'))), 'EPOCH_MISMATCH')
  })

  check('过期提案不能签发批准，并被标记为 expired', () => {
    const stale = approvals.propose(
      {
        taskId: gateCall.taskId,
        assistantId: gateCall.assistantId,
        summary: '过期的提案',
        tool: 'write',
        target: 'D:/tmp/stale.md',
        params: null,
        inputRevision: gateCall.inputRevision,
        risk: 'low',
      },
      -1,
    )
    assert.equal(approvalCode(thrownBy(() => approvals.issue(stale.proposalId, { channel: 'desktop-shell' }, true))), 'EXPIRED')
    assert.equal(store.getProposal(stale.proposalId)?.state, 'expired')
  })

  check('用户拒绝后不能执行', () => {
    const rejected = approvals.propose({
      taskId: gateCall.taskId,
      assistantId: gateCall.assistantId,
      summary: '会被拒绝的提案',
      tool: 'write',
      target: 'D:/tmp/nope.md',
      params: null,
      inputRevision: gateCall.inputRevision,
      risk: 'high',
    })
    approvals.reject(rejected.proposalId, { channel: 'desktop-shell' }, true)
    assert.equal(store.getProposal(rejected.proposalId)?.state, 'rejected')
    assert.equal(approvalCode(thrownBy(() => approvals.consumeByProposal(rejected.proposalId, 'write', gateCall))), 'NOT_FOUND')
    assert.equal(approvalCode(thrownBy(() => approvals.reject(rejected.proposalId, { channel: 'local-ui' }, false))), 'UNTRUSTED_SUBJECT')
  })

  console.log('\n== 任务状态机与委派')
  await checkAsync('依赖未完成时任务排队，不产生委派', async () => {
    const blocking = team.submitTask({ goal: '前置任务', ownerId: 'member-wukong' })
    const dependent = team.submitTask({ goal: '后置任务', ownerId: 'member-wukong', dependsOn: [blocking.taskId] })
    const before = delegations.length
    const outcome = await team.runTask(dependent.taskId, parentAgent, signal)
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'queued')
    assert.equal(outcome.stopReason, 'queued')
    assert.equal(delegations.length, before, '排队时不得委派子代理')
  })

  let wukongTaskId = ''
  await checkAsync('只读专家：委派带人设与结构化 schema，工具面按已核实的 allow 名单收敛', async () => {
    installedGuards.length = 0
    nextResult = {
      output: [{ type: 'text', text: '兜底文本' }],
      structured: {
        summary: '找到两处空指针风险',
        artifacts: ['src/a.ts:12 未判空', 'src/b.ts:40 未判空'],
        blockers: [],
        needsApproval: ['需要写入修复补丁'],
      },
      stopReason: 'completed',
    }
    const task = team.submitTask({
      goal: '排查空指针',
      inputEvidence: ['用户报错原文'],
      acceptance: ['给出可核验的文件与行号'],
      ownerId: 'member-wukong',
      originRequestId: 'req-wukong',
      originChannel: 'desktop-pet',
    })
    wukongTaskId = task.taskId
    const runController = new AbortController()
    const outcome = await team.runTask(task.taskId, parentAgent, runController.signal)
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'awaiting-approval', '有 needsApproval 的任务停在待批，不伪装完成')
    assert.deepEqual(outcome.task.artifacts, ['src/a.ts:12 未判空', 'src/b.ts:40 未判空'])
    assert.equal(outcome.report?.summary, '找到两处空指针风险')
    assert.equal(outcome.stopReason, 'completed')

    const delegation = delegations.at(-1)!
    assert.equal(delegation.provider, 'spawn')
    const request = delegation.request
    assert.match(request.persona, /孙悟空/)
    assert.ok(request.outputSchema.required.includes('summary'))
    assert.equal(request.parent, parentAgent)
    // 委派拿到的是「调用方信号 + 运行自身控制器」的合成信号（AbortSignal.any）：
    // 取消父信号必须传导到子代理，超时/取消也走同一条通道。
    assert.ok(request.signal instanceof AbortSignal)
    assert.equal(request.signal.aborted, false, '任务运行期间委派信号未中止')
    runController.abort('aborted')
    assert.equal(request.signal.aborted, true, '父信号取消要传导进委派，否则取消穿不透到子代理')
    const run = store.listRuns(task.taskId)[0]
    assert.equal(request.label, run.runId, 'label 就是运行 id，启动期定向守卫靠它匹配持久描述符')

    // 工具面是白名单：只有已核实的观测工具进得来，report 留在子代理自身层。
    const allow = request.toolFilter.allow as string[]
    assert.deepEqual(
      allow,
      ['read', 'read_image', 'glob', 'grep', 'job_list', 'job_output', 'get_goal', 'web_search'],
      'allow 名单 = 已核实观测集合 - report - denyExpertTools；多一个都是扩权',
    )
    for (const name of ['bash', 'pwsh', 'write', 'edit', 'str_replace_editor', 'skill', 'job_kill', 'todo_write', 'create_goal', 'update_goal', 'subagent', 'subagent_fork', 'workflow', 'ralph', 'send_message', 'interrupt_agent', 'web_fetch', 'report', 'task', 'agent', 'delegate', 'nonexistent_tool_xyz', 'personal_assistant_start']) {
      assert.equal(allow.includes(name), false, `${name} 绝不能进 allow 名单`)
    }
    assert.match(request.prompt[0].text, /排查空指针/)
    assert.match(request.prompt[0].text, /用户报错原文/)
    assert.match(request.prompt[0].text, /只读/)

    // 双重门禁：宿主 ctx 上的启动期定向守卫 + 子代理自身 ctx 的只读门禁。
    assert.equal(installedGuards.length, 2, '每次委派要装宿主层与子代理层各一道守卫')
    const notAborted = new AbortController().signal
    const child = installedGuards.find(entry => entry.agentId !== 'host')!
    assert.equal(child.guard({ name: 'read', arguments: {}, agent: child.agent, signal: notAborted }), undefined)
    assert.equal(child.guard({ name: 'report', arguments: {}, agent: child.agent, signal: notAborted }), undefined, 'report 是专家交回结论的通道，不能拦')
    assert.match(
      String(child.guard({ name: 'write', arguments: { file_path: 'x' }, agent: child.agent, signal: notAborted })),
      /已拦截 write/,
      '副作用工具在子代理层被拦',
    )
    assert.match(
      String(child.guard({ name: 'web_fetch', arguments: {}, agent: child.agent, signal: notAborted })),
      /已拦截 web_fetch/,
      'denyExpertTools 点名的工具即使可观测也要拦',
    )
    assert.match(
      String(child.guard({ name: 'read', arguments: {}, agent: { id: 'intruder' }, signal: notAborted })),
      /不允许继承给其他代理/,
      '别的代理不能借用这道门禁',
    )
    assert.equal(
      child.guard({ name: 'read', arguments: {}, agent: child.agent, signal: AbortSignal.abort('aborted') }),
      '任务已经取消',
    )

    // 启动期定向守卫只匹配「本父会话 + 本运行标签」的持久描述符，别的会话一律放行给宿主自己的门禁。
    const host = installedGuards.find(entry => entry.agentId === 'host')!
    const childSession = {
      header: { parentSession: 'parent-agent-smoke' },
      events: [{ type: 'subagent/descriptor', data: { label: run.runId } }],
    }
    const unrelatedSession = { header: { parentSession: 'other-session' }, events: [] }
    assert.equal(host.guard({ name: 'write', arguments: {}, agent: { session: unrelatedSession }, signal: notAborted }), undefined, '不匹配的会话不归这道门禁管')
    assert.equal(host.guard({ name: 'read', arguments: {}, agent: { session: childSession }, signal: notAborted }), undefined)
    assert.match(
      String(host.guard({ name: 'write', arguments: {}, agent: { session: childSession }, signal: notAborted })),
      /已拦截 write/,
      'start() 返回前的调用窗口也要挡住副作用',
    )
  })

  check('每次委派只留一条运行记录，且回填子会话 id', () => {
    const runs = store.listRuns(wukongTaskId)
    assert.equal(runs.length, 1, '不得留下永远 running 的悬挂运行记录')
    assert.equal(runs[0].state, 'succeeded')
    assert.equal(runs[0].childSessionId, 'child-session-smoke')
    assert.equal(runs[0].stopReason, 'completed')
    assert.ok(runs[0].endedAt !== null)
    assert.equal(runs[0].outputDigest, 'artifacts:2')
  })

  check('任务结果按发起请求归属，写进 reply/done 事件', () => {
    const events = store.eventsSince(0, 500)
    const done = events.filter((event) => event.type === 'reply/done' && event.taskId === wukongTaskId)
    assert.equal(done.length, 1)
    const payload = done[0].payload as Record<string, any>
    assert.equal(payload.requestId, 'req-wukong')
    assert.equal(payload.assistantId, 'member-wukong')
    assert.equal(payload.displayName, '孙悟空')
    assert.equal(payload.skinId, 'boy-glasses')
    assert.equal(payload.status, 'awaiting-approval')
    assert.deepEqual(payload.needsApproval, ['需要写入修复补丁'])
    assert.equal(events.filter((event) => event.type === 'task/artifact' && event.taskId === wukongTaskId).length, 2)
  })

  await checkAsync('跑完但存在阻碍 → 复核，不伪装成功', async () => {
    nextResult = {
      output: [{ type: 'text', text: '我看过了' }],
      structured: { summary: '我看过了', artifacts: [], blockers: ['拿不到日志'], needsApproval: [] },
      stopReason: 'completed',
    }
    const task = team.submitTask({ goal: '需要证据的任务', acceptance: ['必须给出证据'], ownerId: 'member-wukong' })
    const outcome = await team.runTask(task.taskId, parentAgent, signal)
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'review')
    assert.match(outcome.diagnostic ?? '', /存在阻碍/)
    assert.equal(outcome.report?.summary, '我看过了')
    assert.deepEqual(outcome.report?.blockers, ['拿不到日志'])
  })

  await checkAsync('跑完也不自动算完成：自由文本产物没有可信核验器，一律进复核', async () => {
    nextResult = {
      output: [],
      structured: { summary: '无需产物', artifacts: [], blockers: [], needsApproval: [] },
      stopReason: 'completed',
    }
    const task = team.submitTask({ goal: '没有验收条件', ownerId: 'member-wukong' })
    const outcome = await team.runTask(task.taskId, parentAgent, signal)
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'review')
    assert.match(outcome.diagnostic ?? '', /尚未独立核验/)
  })

  await checkAsync('子代理失败 → 任务失败，并保留诊断', async () => {
    nextResult = { output: [], stopReason: 'error', diagnostic: 'model transport failure' }
    const task = team.submitTask({ goal: '会失败的任务', ownerId: 'member-wukong' })
    const outcome = await team.runTask(task.taskId, parentAgent, signal)
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'failed')
    assert.equal(outcome.diagnostic, 'model transport failure')
    assert.equal(outcome.report, null)
    const runs = store.listRuns(task.taskId)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].state, 'failed')
  })

  await checkAsync('没有结构化报告时用输出文本兜底，仍不算验收通过', async () => {
    nextResult = { output: [{ type: 'text', text: '纯文本结论' }], stopReason: 'completed' }
    const task = team.submitTask({ goal: '无结构化输出', acceptance: ['要产物'], ownerId: 'member-wukong' })
    const outcome = await team.runTask(task.taskId, parentAgent, signal)
    assert.ok(outcome)
    assert.equal(outcome.report, null)
    assert.equal(outcome.task.status, 'review')
    const done = store.eventsSince(0, 500).filter((event) => event.type === 'reply/done' && event.taskId === task.taskId)
    assert.equal((done[0].payload as Record<string, any>).text, '纯文本结论')
  })

  await checkAsync('副作用委派在启动前被拒：当前宿主没有启动前审批门禁，不硬跑', async () => {
    const before = delegations.length
    const task = team.submitTask({ goal: '要动磁盘的任务', ownerId: 'member-tangseng', toolScope: 'side-effect' })
    const outcome = await team.runTask(task.taskId, parentAgent, signal)
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'review')
    assert.equal(outcome.stopReason, 'side-effect-unsupported')
    assert.match(outcome.diagnostic ?? '', /副作用委派尚未接入启动前审批门禁/)
    assert.equal(delegations.length, before, '被拒的任务不得委派子代理')
    assert.equal(store.listRuns(task.taskId).length, 0, '没启动就不该留下运行记录')
  })

  await checkAsync('非零累计预算在启动前被拒：宿主无法硬约束预算，不假装能守住', async () => {
    const before = delegations.length
    const task = team.submitTask({ goal: '带预算的任务', ownerId: 'member-wukong', budgetTokens: 500 })
    const outcome = await team.runTask(task.taskId, parentAgent, signal)
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'review')
    assert.equal(outcome.stopReason, 'budget-unsupported')
    assert.equal(delegations.length, before, '被拒的任务不得委派子代理')
  })

  await checkAsync('未核实的 provider 在启动前被拒：只读隔离目前只核实过 spawn', async () => {
    const before = delegations.length
    const forkTeam = new TeamService(fakeCtx as never, store, { ...options, provider: 'fork', approvals })
    const task = forkTeam.submitTask({ goal: '换个 provider 跑', ownerId: 'member-wukong' })
    const outcome = await forkTeam.runTask(task.taskId, parentAgent, signal)
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'review')
    assert.equal(outcome.stopReason, 'provider-unsupported')
    assert.equal(delegations.length, before, '被拒的任务不得委派子代理')
  })

  check('崩溃遗留的 running 任务与运行记录被恢复流程对账成 unknown，不重发', () => {
    const crashed = team.submitTask({ goal: '上个进程崩在运行中的任务', ownerId: 'member-wukong' })
    assert.ok(store.updateTask(crashed.taskId, crashed.revision, { status: 'running' }))
    store.insertRun({
      runId: 'run-crashed', taskId: crashed.taskId, assistantId: 'member-wukong',
      childSessionId: null, messageId: null, state: 'running', stopReason: null,
      outputDigest: null, startedAt: Date.now(), endedAt: null,
    })
    // 同一个库、新的服务实例 = 一次重启；启动装配（mountTeam）会调用 recoverInterruptedTasks。
    const restarted = new TeamService(fakeCtx as never, store, { ...options, approvals })
    restarted.recoverInterruptedTasks()
    assert.equal(store.getTask(crashed.taskId)!.status, 'unknown', '恢复只对账，不重发、不伪装完成')
    const runs = store.listRuns(crashed.taskId)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].state, 'unknown')
    assert.equal(runs[0].stopReason, 'runtime-interrupted')
    const ended = store
      .eventsSince(0, 5000)
      .filter((event) => event.type === 'run/ended' && event.taskId === crashed.taskId)
    assert.equal(ended.length, 1, '对账要留下可追溯的事件，供桥接与桌面壳投影')
  })

  await checkAsync('远程 provider 拿不到进程内 agent ctx 时失败关闭，不让不受约束的代理跑起来', async () => {
    const restore = startImpl
    const disposedBefore = disposed
    startImpl = remoteStart
    const task = team.submitTask({ goal: '被派到远程运行的任务', ownerId: 'member-wukong' })
    const outcome = await team.runTask(task.taskId, parentAgent, signal)
    startImpl = restore
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'failed')
    assert.equal(outcome.stopReason, 'infrastructure-error')
    assert.match(outcome.diagnostic ?? '', /进程内 spawn/)
    assert.match(outcome.diagnostic ?? '', /不能接受远程运行/)
    assert.equal(disposed > disposedBefore, true, '跑不起来的 run 也要释放掉，不能留个孤儿代理')
  })

  await checkAsync('宿主拒绝委派时任务置失败，并记下原因', async () => {
    const restore = startImpl
    startImpl = async () => {
      throw new Error('tool filter names unknown tool')
    }
    const task = team.submitTask({ goal: '会被宿主拒绝', ownerId: 'member-wukong' })
    const outcome = await team.runTask(task.taskId, parentAgent, signal)
    startImpl = restore
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'failed')
    assert.equal(outcome.stopReason, 'start-rejected')
    assert.match(outcome.diagnostic ?? '', /unknown tool/)
    assert.equal(store.listRuns(task.taskId)[0].state, 'failed')
    const ended = store
      .eventsSince(0, 5000)
      .filter((event) => event.type === 'run/ended' && event.taskId === task.taskId)
    assert.match(String((ended.at(-1)!.payload as Record<string, any>).diagnostic), /unknown tool/, '失败原因要落进事件账目')
  })

  await checkAsync('取消任务：非终态置 cancelled，不存在的任务返回 null', async () => {
    const queued = team.submitTask({ goal: '待取消', ownerId: 'member-wukong' })
    const cancelled = await team.cancelTask(queued.taskId)
    assert.ok(cancelled)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(await team.cancelTask('no-such-task'), null)
    assert.equal(approvals.operations(proposalTask.taskId).length, 1, '取消不影响已登记副作用的账目')
  })

  await checkAsync('非新建/排队状态的任务再次执行直接返回，不重复委派', async () => {
    const before = delegations.length
    const outcome = await team.runTask(wukongTaskId, parentAgent, signal)
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'awaiting-approval')
    assert.equal(outcome.stopReason, 'awaiting-approval')
    assert.equal(outcome.report, null)
    assert.match(outcome.diagnostic ?? '', /只领取新建或排队任务/, '待批任务不能被重新领取，避免重发已发生的副作用')
    assert.equal(delegations.length, before)
  })

  await checkAsync('runReady 跳过在跑与终态任务，只推进可执行的', async () => {
    const before = delegations.length
    nextResult = {
      output: [],
      structured: { summary: '批量推进', artifacts: ['一条产物'], blockers: [], needsApproval: [] },
      stopReason: 'completed',
    }
    team.submitTask({ goal: '批量任务一', ownerId: 'member-wukong' })
    const outcomes = await team.runReady(parentAgent, signal)
    assert.ok(outcomes.length >= 1)
    assert.ok(delegations.length > before)
    assert.ok(outcomes.every((outcome) => outcome.task.status !== 'running'))
  })

  check('每次委派结束后都释放了子代理', () => {
    assert.equal(disposed, delegations.length, `disposed ${disposed} != delegations ${delegations.length}`)
    assert.equal(team.runningCount(), 0)
  })

  await checkAsync('dispose 幂等，不抛错', async () => {
    await team.dispose()
    await team.dispose()
  })

  store.close()
  activeStore = null
  console.log(`\n全部通过：${passed} 项`)
}

/** 运行器入口：关库与临时目录清理必须发生在失败路径上，否则 Windows 会挡住目录删除。 */
export async function run(): Promise<void> {
  try {
    await main()
  } catch (error) {
    console.error('\n冒烟验证失败：', error)
    if (logs.length > 0) console.error('日志：\n' + logs.join('\n'))
    process.exitCode = 1
  } finally {
    try {
      activeStore?.close()
    } catch {
      // 已经关过了
    }
    activeStore = null
    rmSync(dir, { recursive: true, force: true })
  }
}
