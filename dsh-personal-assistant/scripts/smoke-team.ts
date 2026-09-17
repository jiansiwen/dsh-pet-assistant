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
import { ApprovalError, ApprovalService } from '../src/approval.ts'
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

/** 装到假子代理 agent-scoped ctx 上的守卫；测试直接调用它来验证门禁行为。 */
const installedGuards: Array<{ agentId: string; guard: (execution: any) => string | undefined }> = []
let guardDisposals = 0

function fakeChildAgent(agentId: string) {
  return {
    id: agentId,
    ctx: {
      tools: {
        guard(guard: (execution: any) => string | undefined) {
          installedGuards.push({ agentId, guard })
          return () => {
            guardDisposals += 1
          }
        },
      },
    },
  }
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
  },
}

const options: Omit<TeamOptions, 'approvals'> = {
  teamId: 'smoke-team',
  provider: 'spawn',
  maxConcurrentInference: 2,
  maxConcurrentSideEffect: 1,
  taskTimeoutMs: 60_000,
  defaultBudgetTokens: 1000,
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
  const parentAgent = { session: { id: 'parent-smoke' } } as never

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

  check('未知承接人与不存在的依赖都被拒绝', () => {
    assert.throws(() => team.submitTask({ goal: 'x', ownerId: 'member-nezha' }), /unknown assistant/)
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
  const proposalTask = team.submitTask({ goal: '需要副作用的任务', ownerId: 'member-tangseng' })

  let proposalId = ''
  check('提交提案不产生外部效果，只落一条待决记录', () => {
    const proposal = approvals.propose({
      taskId: proposalTask.taskId,
      assistantId: 'member-wukong',
      summary: '把结论写进 report.md',
      tool: 'write',
      target: 'D:/tmp/report.md',
      params: { mode: 'append' },
      inputRevision: proposalTask.revision,
      risk: 'medium',
    })
    proposalId = proposal.proposalId
    assert.equal(proposal.state, 'pending')
    assert.equal(approvals.pendingProposals().length, 1)
    assert.equal(approvals.operations(proposalTask.taskId).length, 0)
    assert.equal(store.approvalForProposal(proposalId), null)
  })

  check('未签发批准时不能执行', () => {
    assert.equal(approvalCode(thrownBy(() => approvals.consumeByProposal(proposalId, 'write-file'))), 'NOT_FOUND')
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

  let operationId = ''
  check('凭提案消费批准，批准 id 不必进入模型上下文', () => {
    const operation = approvals.consumeByProposal(proposalId, 'write-file')
    operationId = operation.operationId
    assert.equal(operation.state, 'planned')
    assert.equal(operation.taskId, proposalTask.taskId)
    assert.equal(operation.kind, 'write-file')
  })

  check('同一条批准只能消费一次（防重放）', () => {
    assert.equal(approvalCode(thrownBy(() => approvals.consumeByProposal(proposalId, 'write-file'))), 'ALREADY_CONSUMED')
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
        taskId: proposalTask.taskId,
        assistantId: 'member-tangseng',
        summary: '过期的提案',
        tool: 'write',
        target: 'D:/tmp/stale.md',
        params: null,
        inputRevision: 1,
        risk: 'low',
      },
      -1,
    )
    assert.equal(approvalCode(thrownBy(() => approvals.issue(stale.proposalId, { channel: 'desktop-shell' }, true))), 'EXPIRED')
    assert.equal(store.getProposal(stale.proposalId)?.state, 'expired')
  })

  check('用户拒绝后不能执行', () => {
    const rejected = approvals.propose({
      taskId: proposalTask.taskId,
      assistantId: 'member-tangseng',
      summary: '会被拒绝的提案',
      tool: 'write',
      target: 'D:/tmp/nope.md',
      params: null,
      inputRevision: 1,
      risk: 'high',
    })
    approvals.reject(rejected.proposalId, { channel: 'desktop-shell' }, true)
    assert.equal(store.getProposal(rejected.proposalId)?.state, 'rejected')
    assert.equal(approvalCode(thrownBy(() => approvals.consumeByProposal(rejected.proposalId, 'write-file'))), 'NOT_FOUND')
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
  await checkAsync('只读专家：委派带人设、结构化 schema，deny 名单只含真实存在的工具', async () => {
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
    const outcome = await team.runTask(task.taskId, parentAgent, signal)
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'done')
    assert.deepEqual(outcome.task.artifacts, ['src/a.ts:12 未判空', 'src/b.ts:40 未判空'])
    assert.equal(outcome.report?.summary, '找到两处空指针风险')
    assert.equal(outcome.stopReason, 'completed')

    const delegation = delegations.at(-1)!
    assert.equal(delegation.provider, 'spawn')
    const request = delegation.request
    assert.match(request.persona, /孙悟空/)
    assert.ok(request.outputSchema.required.includes('summary'))
    assert.equal(request.parent, parentAgent)
    assert.equal(request.signal, signal)
    const deny = request.toolFilter.deny as string[]
    for (const name of ['subagent', 'subagent_fork', 'workflow', 'ralph']) {
      assert.ok(deny.includes(name), `${name} 能起子代理，必须被禁掉，否则专家可以再开孙级会话`)
    }
    assert.ok(deny.includes('send_message'))
    assert.ok(deny.includes('interrupt_agent'))
    for (const name of ['bash', 'pwsh', 'write', 'edit', 'str_replace_editor', 'skill', 'job_kill', 'todo_write', 'create_goal', 'update_goal']) {
      assert.ok(deny.includes(name), `${name} 有副作用，「只读」席位必须默认禁掉`)
    }
    for (const name of ['read', 'glob', 'grep', 'job_list', 'get_goal']) {
      assert.equal(deny.includes(name), false, `${name} 是纯观测工具，禁掉专家就什么都查不了`)
    }
    assert.equal(deny.includes('report'), false, '禁掉 report 等于让专家交不回结论')
    assert.ok(deny.includes('web_fetch'), 'denyExpertTools 里点名的真实工具要生效')
    assert.equal(deny.includes('write_file'), false, '本运行时的写文件工具叫 write，write_file 是猜名，进了 deny 会被宿主拒绝')
    for (const name of ['task', 'agent', 'delegate', 'nonexistent_tool_xyz']) {
      assert.equal(deny.includes(name), false, `${name} 在运行时不存在，进了 deny 会被宿主大声拒绝`)
    }
    assert.match(request.prompt[0].text, /排查空指针/)
    assert.match(request.prompt[0].text, /用户报错原文/)
    assert.match(request.prompt[0].text, /只读/)
    assert.match(request.label, /孙悟空/)
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
    assert.equal(payload.status, 'done')
    assert.deepEqual(payload.needsApproval, ['需要写入修复补丁'])
    assert.equal(events.filter((event) => event.type === 'task/artifact' && event.taskId === wukongTaskId).length, 2)
  })

  await checkAsync('跑完但拿不出验收产物 → 复核，不伪装成功', async () => {
    nextResult = {
      output: [{ type: 'text', text: '我看过了' }],
      structured: { summary: '我看过了', artifacts: [], blockers: ['拿不到日志'], needsApproval: [] },
      stopReason: 'completed',
    }
    const task = team.submitTask({ goal: '需要证据的任务', acceptance: ['必须给出证据'], ownerId: 'member-wukong' })
    const outcome = await team.runTask(task.taskId, parentAgent, signal)
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'review')
    assert.equal(outcome.report?.summary, '我看过了')
    assert.deepEqual(outcome.report?.blockers, ['拿不到日志'])
  })

  await checkAsync('没有验收条件时，跑完即算完成', async () => {
    nextResult = {
      output: [],
      structured: { summary: '无需产物', artifacts: [], blockers: [], needsApproval: [] },
      stopReason: 'completed',
    }
    const task = team.submitTask({ goal: '没有验收条件', ownerId: 'member-wukong' })
    const outcome = await team.runTask(task.taskId, parentAgent, signal)
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'done')
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

  await checkAsync('总助理是副作用席位：不加只读工具禁用，但装执行点门禁', async () => {
    installedGuards.length = 0
    nextResult = {
      output: [],
      structured: { summary: '已汇总', artifacts: ['汇总结果'], blockers: [], needsApproval: ['需要写 D:/tmp/out.md'] },
      stopReason: 'completed',
    }
    const task = team.submitTask({ goal: '汇总专家结论', ownerId: 'member-tangseng' })
    const outcome = await team.runTask(task.taskId, parentAgent, signal)
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'done')
    assert.equal(outcome.task.toolScope, 'side-effect')
    assert.equal(delegations.at(-1)!.request.toolFilter, undefined)
    assert.equal(installedGuards.length, 1, '副作用席位必须在子代理自己的 agent ctx 上装一个守卫')

    const guard = installedGuards[0].guard
    // 观测面与团队自有工具照常放行，否则总助理连读文件、交结论都做不了
    assert.equal(guard({ name: 'read', arguments: { file_path: 'D:/tmp/out.md' } }), undefined)
    assert.equal(guard({ name: 'grep', arguments: { pattern: '空指针' } }), undefined)
    assert.equal(guard({ name: 'report', arguments: {} }), undefined)
    assert.equal(guard({ name: 'desktop_team_propose_action', arguments: {} }), undefined)

    const writeCall = { name: 'write', arguments: { file_path: 'D:/tmp/out.md', content: '结论' } }
    const blocked = guard(writeCall)
    assert.ok(typeof blocked === 'string', '没有批准时必须拒绝，光靠提示词拦不住模型')
    assert.match(blocked, /desktop_team_propose_action/, '拒绝理由要告诉模型去提案')
    assert.match(blocked, /tool="write"/, '拒绝理由要点名该填的工具名，否则模型猜不对')
    assert.match(blocked, /D:\/tmp\/out\.md/, '拒绝理由要给出该填的 target')
    assert.equal(approvals.operations(task.taskId).length, 0, '被拦下的调用不得留下副作用账目')

    // 看不懂参数就放行是最坏的失败方向
    const missing = guard({ name: 'write', arguments: { content: '没有路径' } })
    assert.ok(typeof missing === 'string', '缺 file_path 时必须拒绝')
    assert.match(missing, /file_path/)
    assert.ok(typeof guard({ name: 'write', arguments: 'not-an-object' }) === 'string', '参数不是对象也要拒绝')

    // str_replace_editor 的 view 是纯读的，不该要批准；改文件的三个子命令要
    assert.equal(guard({ name: 'str_replace_editor', arguments: { command: 'view', path: 'D:/tmp/out.md' } }), undefined)
    assert.ok(
      typeof guard({ name: 'str_replace_editor', arguments: { command: 'str_replace', path: 'D:/tmp/out.md' } }) === 'string',
      'str_replace 会改磁盘，必须获批',
    )

    const proposal = approvals.propose({
      taskId: task.taskId,
      assistantId: 'member-tangseng',
      summary: '把结论落盘',
      tool: 'write',
      target: 'D:/tmp/out.md',
      params: null,
      inputRevision: task.revision,
      risk: 'low',
    })
    approvals.issue(proposal.proposalId, { channel: 'desktop-shell', windowId: 3 }, true)

    assert.equal(guard(writeCall), undefined, '获批后同一次调用要放行')
    const operations = approvals.operations(task.taskId)
    assert.equal(operations.length, 1, '门禁放行时就地建一条 planned 记录')
    assert.equal(operations[0].state, 'planned')
    assert.equal(operations[0].kind, 'write', 'kind 用真实工具名，不用模型自报的分类')

    const replay = guard(writeCall)
    assert.ok(typeof replay === 'string', '同一条批准只能执行一次')
    assert.match(replay, /ALREADY_CONSUMED/)
    assert.equal(approvals.operations(task.taskId).length, 1, '重放不得再建记录')

    assert.ok(
      typeof guard({ name: 'write', arguments: { file_path: 'D:/tmp/other.md', content: 'x' } }) === 'string',
      '批准绑定作用目标，换个文件就得重新提案',
    )

    const settled = approvals.settleByProposal(proposal.proposalId, 'succeeded', 'digest-gate')
    assert.equal(settled.state, 'succeeded')
    assert.equal(approvals.operations(task.taskId)[0].state, 'succeeded', '结账要落在门禁建的那条记录上')
  })

  await checkAsync('只读席位不装门禁：它的工具面已经被 deny 名单削掉了', async () => {
    installedGuards.length = 0
    nextResult = { output: [], structured: { summary: '查完了', artifacts: [], blockers: [], needsApproval: [] }, stopReason: 'completed' }
    const task = team.submitTask({ goal: '排查空指针', ownerId: 'member-wukong' })
    await team.runTask(task.taskId, parentAgent, signal)
    assert.equal(installedGuards.length, 0, '只读席位手里没有可放的副作用，装门禁只会白拦')
  })

  await checkAsync('远程 provider 装不上门禁时失败关闭，不让不受约束的副作用代理跑起来', async () => {
    const restore = startImpl
    const disposedBefore = disposed
    startImpl = remoteStart
    const task = team.submitTask({ goal: '需要副作用但门禁装不上', ownerId: 'member-tangseng' })
    const outcome = await team.runTask(task.taskId, parentAgent, signal)
    startImpl = restore
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'failed')
    assert.equal(outcome.stopReason, 'start-rejected')
    assert.match(outcome.diagnostic ?? '', /门禁/)
    assert.match(outcome.diagnostic ?? '', /localAgent/)
    assert.equal(disposed > disposedBefore, true, '装不上门禁要把已经起来的 run 释放掉，不能留个孤儿代理')
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
    assert.ok(logs.some((line) => line.startsWith('error ')))
  })

  await checkAsync('取消任务：非终态置 cancelled，不存在的任务返回 null', async () => {
    const queued = team.submitTask({ goal: '待取消', ownerId: 'member-wukong' })
    const cancelled = await team.cancelTask(queued.taskId)
    assert.ok(cancelled)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(await team.cancelTask('no-such-task'), null)
    assert.equal(approvals.operations(proposalTask.taskId).length, 1, '取消不影响已登记副作用的账目')
  })

  await checkAsync('终态任务再次执行直接返回，不重复委派', async () => {
    const before = delegations.length
    const outcome = await team.runTask(wukongTaskId, parentAgent, signal)
    assert.ok(outcome)
    assert.equal(outcome.task.status, 'done')
    assert.equal(outcome.report, null)
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
