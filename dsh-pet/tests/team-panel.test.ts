/**
 * 团队面板投影的测试。
 *
 * 这里钉的是"用户看到的顺序和措辞"。这类逻辑最容易出的问题不是崩溃，而是 quietly 错：
 * 需要用户动手的那条任务排到了列表末尾、做完但没交产物的任务显示成绿色的"已完成"、
 * 计数和列表对不上。三种都不报错，用户只会觉得"这面板不太靠谱"，然后不再看它。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  approvalBanner,
  artifactNote,
  deadlineNote,
  memberRow,
  sortProposals,
  sortTasks,
  taskStatusOf,
  taskTone,
  teamPanelView,
  TASK_STATUS_LABEL,
} from '../src/renderer/team-panel.ts'
import type { TeamProposalSnapshot, TeamSnapshot, TeamTaskSnapshot } from '../src/renderer/types.ts'

/** 2026-03-05 12:00 本地时间。用固定时刻，"今天到期"这条分支才不会随跑测试的日期变。 */
const NOW = new Date(2026, 2, 5, 12, 0, 0).getTime()
const HOUR = 3_600_000

function task(patch: Partial<TeamTaskSnapshot> = {}): TeamTaskSnapshot {
  return { taskId: 't-1', goal: '把日报整理出来', status: 'running', ...patch }
}

function proposal(patch: Partial<TeamProposalSnapshot> = {}): TeamProposalSnapshot {
  return { proposalId: 'p-1', tool: 'write_file', state: 'pending', ...patch }
}

const names = (assistantId: string): string | null =>
  ({ 'tang-seng': '总助理', 'sun-wukong': '助理1' })[assistantId] ?? null

describe('TASK_STATUS_LABEL：十个状态一个都不能漏', () => {
  it('插件侧的每个状态都有中文措辞，且互不相同', () => {
    const statuses = [
      'created',
      'queued',
      'running',
      'awaiting-approval',
      'awaiting-user',
      'review',
      'done',
      'failed',
      'cancelled',
      'unknown',
    ] as const
    const labels = statuses.map(status => TASK_STATUS_LABEL[status])
    for (const [index, status] of statuses.entries()) {
      assert.ok(labels[index], `${status} 没有措辞`)
    }
    assert.equal(new Set(labels).size, statuses.length, '有两个状态的措辞撞车了，界面上分不出它们')
  })

  it('需要用户动手的两条，措辞里就有"你"', () => {
    // 这两条的区别不是"进度不同"，而是"没人动它就永远停在这儿"，措辞得把这点说出来。
    assert.ok(TASK_STATUS_LABEL['awaiting-approval'].includes('你'))
    assert.ok(TASK_STATUS_LABEL['awaiting-user'].includes('你'))
  })
})

describe('taskStatusOf：认不出的状态归 unknown', () => {
  it('十个已知状态原样返回', () => {
    for (const status of ['created', 'running', 'done'] as const) {
      assert.equal(taskStatusOf({ status }), status)
    }
  })

  it('缺失、null、认不出的字符串都归 unknown，不归排队中', () => {
    // 归成"排队中"的话用户会以为它还在正常推进，于是一直等一条根本不存在进度的任务。
    for (const status of [undefined, null, '', 'RUNNING', 'in-progress', 'paused']) {
      assert.equal(taskStatusOf({ status }), 'unknown', `status=${JSON.stringify(status)} 应当归为 unknown`)
    }
  })
})

describe('taskTone：waiting 与 active 必须分开', () => {
  it('等用户的三种归 waiting', () => {
    assert.equal(taskTone('awaiting-approval'), 'waiting')
    assert.equal(taskTone('awaiting-user'), 'waiting')
    assert.equal(taskTone('review'), 'waiting')
  })

  it('推进中的三种归 active', () => {
    assert.equal(taskTone('running'), 'active')
    assert.equal(taskTone('queued'), 'active')
    assert.equal(taskTone('created'), 'active')
  })

  it('done / failed / cancelled / unknown 各归各的语气，不混在一起', () => {
    assert.equal(taskTone('done'), 'ok')
    assert.equal(taskTone('failed'), 'bad')
    assert.equal(taskTone('cancelled'), 'idle')
    assert.equal(taskTone('unknown'), 'idle')
  })
})

describe('sortTasks：需要用户动手的排最前', () => {
  it('等你点头排第一，哪怕它更新时间最旧', () => {
    // 提案有有效期，过期就得让助理重新提请一遍——那是实打实的返工，所以它优先。
    const sorted = sortTasks([
      task({ taskId: 'a', status: 'running', updatedAt: NOW }),
      task({ taskId: 'b', status: 'awaiting-approval', updatedAt: NOW - 10 * HOUR }),
      task({ taskId: 'c', status: 'done', updatedAt: NOW }),
    ])
    assert.deepEqual(sorted.map(item => item.taskId), ['b', 'a', 'c'])
  })

  it('等你回话在等你点头之后、在进行中之前', () => {
    const sorted = sortTasks([
      task({ taskId: 'a', status: 'running' }),
      task({ taskId: 'b', status: 'awaiting-user' }),
      task({ taskId: 'c', status: 'awaiting-approval' }),
      task({ taskId: 'd', status: 'review' }),
    ])
    assert.deepEqual(sorted.map(item => item.taskId), ['c', 'b', 'd', 'a'])
  })

  it('已经结束的排在后面，失败比结果未知靠前', () => {
    const sorted = sortTasks([
      task({ taskId: 'a', status: 'cancelled' }),
      task({ taskId: 'b', status: 'done' }),
      task({ taskId: 'c', status: 'unknown' }),
      task({ taskId: 'd', status: 'failed' }),
    ])
    assert.deepEqual(sorted.map(item => item.taskId), ['d', 'c', 'b', 'a'])
  })

  it('同状态按更新时间倒序：刚动过的在前', () => {
    const sorted = sortTasks([
      task({ taskId: 'a', status: 'running', updatedAt: NOW - 2 * HOUR }),
      task({ taskId: 'b', status: 'running', updatedAt: NOW }),
      task({ taskId: 'c', status: 'running', updatedAt: NOW - HOUR }),
    ])
    assert.deepEqual(sorted.map(item => item.taskId), ['b', 'c', 'a'])
  })

  it('两个时间都没有时按 taskId 排，顺序每次都一样', () => {
    // 没有稳定的兜底键，同一批任务每次刷新顺序都可能变，用户刚看清的那条会跑掉。
    const sorted = sortTasks([
      task({ taskId: 'z', status: 'running' }),
      task({ taskId: 'm', status: 'running' }),
      task({ taskId: 'a', status: 'running' }),
    ])
    assert.deepEqual(sorted.map(item => item.taskId), ['a', 'm', 'z'])
  })

  it('updatedAt 缺失时退回 createdAt', () => {
    const sorted = sortTasks([
      task({ taskId: 'a', status: 'running', createdAt: NOW - 5 * HOUR }),
      task({ taskId: 'b', status: 'running', createdAt: NOW }),
    ])
    assert.deepEqual(sorted.map(item => item.taskId), ['b', 'a'])
  })

  it('不改原数组', () => {
    const original = [task({ taskId: 'a', status: 'done' }), task({ taskId: 'b', status: 'running' })]
    const snapshot = [...original]
    sortTasks(original)
    assert.deepEqual(original, snapshot, '排序不该动调用方那个数组')
  })
})

describe('artifactNote：说做完了但没交产物，不能显示成已完成', () => {
  it('done 且产物为空时给出提示', () => {
    // 设计文档：只有产物验证通过才算完成，角色发一句"做完了"不构成成功。
    const note = artifactNote({ status: 'done', artifacts: [] })
    assert.ok(note && note.includes('没交出产物'))
  })

  it('artifacts 字段整个缺失也算没产物', () => {
    assert.ok(artifactNote({ status: 'done' }))
  })

  it('done 且有产物时不提示', () => {
    assert.equal(artifactNote({ status: 'done', artifacts: ['report.md'] }), null)
  })

  it('还没做完的状态不提示：没做完哪来的产物', () => {
    for (const status of ['running', 'queued', 'awaiting-approval', 'failed', 'unknown'] as const) {
      assert.equal(artifactNote({ status, artifacts: [] }), null, `${status} 不该提示没产物`)
    }
  })
})

describe('deadlineNote：只提示已经逾期和今天到期', () => {
  it('逾期给一句明确的', () => {
    assert.equal(deadlineNote(task({ deadlineAt: NOW - HOUR }), NOW), '已经过了截止时间')
    assert.equal(deadlineNote(task({ deadlineAt: NOW }), NOW), '已经过了截止时间')
  })

  it('今天之内到期给提醒', () => {
    const todayEvening = new Date(2026, 2, 5, 20, 0, 0).getTime()
    assert.equal(deadlineNote(task({ deadlineAt: todayEvening }), NOW), '今天到期')
  })

  it('明天及更远不提示：面板高度有限，每行都该是现在就要知道的事', () => {
    assert.equal(deadlineNote(task({ deadlineAt: NOW + 26 * HOUR }), NOW), null)
    assert.equal(deadlineNote(task({ deadlineAt: NOW + 30 * 24 * HOUR }), NOW), null)
  })

  it('没有截止时间不提示', () => {
    assert.equal(deadlineNote(task({ deadlineAt: null }), NOW), null)
    assert.equal(deadlineNote(task({}), NOW), null)
  })

  it('已完成与已取消不再提示逾期：那只是重复一个已经发生过的坏消息', () => {
    assert.equal(deadlineNote(task({ status: 'done', deadlineAt: NOW - HOUR }), NOW), null)
    assert.equal(deadlineNote(task({ status: 'cancelled', deadlineAt: NOW - HOUR }), NOW), null)
  })

  it('认不出的状态仍然会提示逾期：说不清到哪一步了，不等于不用管截止时间', () => {
    assert.equal(deadlineNote(task({ status: 'paused', deadlineAt: NOW - HOUR }), NOW), '已经过了截止时间')
  })
})

describe('memberRow：能不能改用户的文件，必须写出来', () => {
  const sunWukong = { assistantId: 'sun-wukong', displayName: '助理1', roleId: 'expert', toolScope: 'side-effect' }

  it('只读成员标成只读', () => {
    const row = memberRow({ ...sunWukong, toolScope: 'read-only' }, [], [])
    assert.equal(row.scopeLabel, '只读')
    assert.equal(row.canWriteFiles, false)
  })

  it('有副作用的成员标成会改动你的文件', () => {
    const row = memberRow(sunWukong, [], [])
    assert.equal(row.scopeLabel, '会改动你的文件')
    assert.equal(row.canWriteFiles, true)
  })

  it('toolScope 缺失或认不出时按"能改"归：把不认识的能力说成无害，用户就会在不该放心的地方放心', () => {
    for (const toolScope of [undefined, null, '', 'READ-ONLY', 'whatever']) {
      const row = memberRow({ ...sunWukong, toolScope }, [], [])
      assert.equal(row.canWriteFiles, true, `toolScope=${JSON.stringify(toolScope)} 应当按能改处理`)
    }
  })

  it('显示名缺失时退回 assistantId，不留空', () => {
    const row = memberRow({ assistantId: 'bai-long-ma', displayName: null }, [], [])
    assert.equal(row.displayName, 'bai-long-ma')
  })

  it('只数这个成员自己手头没结束的任务', () => {
    const tasks = [
      task({ taskId: 'a', ownerId: 'sun-wukong', status: 'running' }),
      task({ taskId: 'b', ownerId: 'sun-wukong', status: 'awaiting-approval' }),
      task({ taskId: 'c', ownerId: 'sun-wukong', status: 'done' }),
      task({ taskId: 'd', ownerId: 'tang-seng', status: 'running' }),
      task({ taskId: 'e', ownerId: null, status: 'running' }),
    ]
    // done 不算在内：已经结束的任务不该让名牌上的负载一直挂着下不去。
    assert.equal(memberRow(sunWukong, tasks, []).activeTasks, 2)
  })

  it('failed / cancelled / unknown 也不计入在手任务', () => {
    const tasks = [
      task({ taskId: 'a', ownerId: 'sun-wukong', status: 'failed' }),
      task({ taskId: 'b', ownerId: 'sun-wukong', status: 'cancelled' }),
      task({ taskId: 'c', ownerId: 'sun-wukong', status: 'unknown' }),
    ]
    assert.equal(memberRow(sunWukong, tasks, []).activeTasks, 0)
  })

  it('只数待批的提案，已决定的不算', () => {
    const proposals = [
      proposal({ proposalId: 'a', assistantId: 'sun-wukong' }),
      proposal({ proposalId: 'b', assistantId: 'sun-wukong', state: 'approved' }),
      proposal({ proposalId: 'c', assistantId: 'sun-wukong', state: 'expired' }),
      proposal({ proposalId: 'd', assistantId: 'tang-seng' }),
    ]
    assert.equal(memberRow(sunWukong, [], proposals).pendingApprovals, 1)
  })

  it('state 缺失按 pending 算', () => {
    // 装置默认不带 assistantId，这里必须点名归到助理1名下，否则测的是"数不到别人"而不是这一条。
    assert.equal(
      memberRow(sunWukong, [], [proposal({ assistantId: 'sun-wukong', state: undefined })]).pendingApprovals,
      1,
    )
  })

  it('enabled 缺失按启用算，显式 false 才算停用', () => {
    assert.equal(memberRow(sunWukong, [], []).enabled, true)
    assert.equal(memberRow({ ...sunWukong, enabled: undefined }, [], []).enabled, true)
    assert.equal(memberRow({ ...sunWukong, enabled: false }, [], []).enabled, false)
  })
})

describe('sortProposals：先到期的在前', () => {
  it('按截止时间升序，没有截止时间的排最后', () => {
    // 没有期限的那条不会自己消失，而快到期的再不看就没了。
    const sorted = sortProposals([
      proposal({ proposalId: 'a' }),
      proposal({ proposalId: 'b', expiresAt: NOW + 3 * HOUR }),
      proposal({ proposalId: 'c', expiresAt: NOW + HOUR }),
    ])
    assert.deepEqual(sorted.map(item => item.proposalId), ['c', 'b', 'a'])
  })

  it('同一时刻到期时按 id 排，顺序稳定', () => {
    const sorted = sortProposals([
      proposal({ proposalId: 'z', expiresAt: NOW }),
      proposal({ proposalId: 'a', expiresAt: NOW }),
    ])
    assert.deepEqual(sorted.map(item => item.proposalId), ['a', 'z'])
  })

  it('不改原数组', () => {
    const original = [proposal({ proposalId: 'a', expiresAt: NOW + HOUR }), proposal({ proposalId: 'b' })]
    const snapshot = [...original]
    sortProposals(original)
    assert.deepEqual(original, snapshot)
  })
})

describe('approvalBanner：对话页上那条紧凑提示', () => {
  it('没有待批提案时返回 null，不显示一个 0', () => {
    assert.equal(approvalBanner([]), null)
    assert.equal(approvalBanner([proposal({ state: 'approved' }), proposal({ state: 'expired' })]), null)
  })

  it('一条时说清是哪个操作', () => {
    const banner = approvalBanner([proposal({ proposalId: 'only', tool: 'delete_file' })])
    assert.equal(banner?.count, 1)
    assert.ok(banner?.headline.includes('delete_file'))
    assert.ok(banner?.headline.includes('等你点头'))
    assert.equal(banner?.proposalId, 'only')
  })

  it('多条时带上数量，headline 说的是最紧的那条', () => {
    const banner = approvalBanner([
      proposal({ proposalId: 'a', tool: 'write_file', expiresAt: NOW + 3 * HOUR }),
      proposal({ proposalId: 'b', tool: 'delete_file', expiresAt: NOW + HOUR }),
    ])
    assert.equal(banner?.count, 2)
    // 最紧的是先到期那条，不是数组里第一条。
    assert.ok(banner?.headline.includes('delete_file'))
    assert.ok(banner?.headline.includes('2'))
    assert.equal(banner?.proposalId, 'b')
  })

  it('按钮点的就是文字说的那条', () => {
    // 提示写着 delete_file 而按钮打开的是 write_file 的话，用户会以为自己放行了全部。
    // 没有截止时间的排最后，所以这里最紧的是那条带期限的。
    const banner = approvalBanner([
      proposal({ proposalId: 'no-deadline', tool: 'write_file', expiresAt: undefined }),
      proposal({ proposalId: 'soon', tool: 'delete_file', expiresAt: NOW + 60_000 }),
    ])
    assert.ok(banner?.headline.includes('delete_file'))
    assert.equal(banner?.proposalId, 'soon')
  })

  it('工具名缺失时说"未知操作"，不留空引号', () => {
    const banner = approvalBanner([proposal({ tool: null })])
    assert.ok(banner?.headline.includes('未知操作'))
    assert.ok(!banner?.headline.includes('「」'))
  })
})

describe('teamPanelView：整份快照的投影', () => {
  it('快照为 null 时给空面板，而不是抛异常', () => {
    const view = teamPanelView(null, names, NOW)
    assert.equal(view.teamEnabled, false)
    assert.deepEqual(view.members, [])
    assert.deepEqual(view.tasks, [])
    assert.deepEqual(view.proposals, [])
    assert.equal(view.runningCount, 0)
  })

  it('团队模式没开时 teamEnabled 是 false', () => {
    // 这一条要让界面能退回单角色，而不是显示一个空的团队面板装作连上了。
    assert.equal(teamPanelView({ team: false, members: [] }, names, NOW).teamEnabled, false)
    assert.equal(teamPanelView({ members: [] }, names, NOW).teamEnabled, false)
    assert.equal(teamPanelView({ team: true, members: [] }, names, NOW).teamEnabled, true)
  })

  it('runningCount 按任务列表数，不采用桥接给的 running 字段', () => {
    // 桥接那个数和 tasks 可能来自不同时刻。面板说"3 个进行中"而列表只有 2 条，
    // 用户会去找那条不存在的任务。
    const snapshot: TeamSnapshot = {
      team: true,
      running: 9,
      tasks: [task({ taskId: 'a', status: 'running' }), task({ taskId: 'b', status: 'running' }), task({ taskId: 'c', status: 'done' })],
    }
    assert.equal(teamPanelView(snapshot, names, NOW).runningCount, 2)
  })

  it('负责人换成显示名，查不到就退回 assistantId', () => {
    const snapshot: TeamSnapshot = {
      team: true,
      tasks: [
        task({ taskId: 'a', ownerId: 'sun-wukong' }),
        task({ taskId: 'b', ownerId: 'sha-seng' }),
        task({ taskId: 'c', ownerId: null }),
      ],
    }
    const view = teamPanelView(snapshot, names, NOW)
    assert.equal(view.tasks.find(item => item.taskId === 'a')?.owner, '助理1')
    assert.equal(view.tasks.find(item => item.taskId === 'b')?.owner, 'sha-seng')
    assert.equal(view.tasks.find(item => item.taskId === 'c')?.owner, null)
  })

  it('目标缺失或全是空白时给一句占位，不留空行', () => {
    const snapshot: TeamSnapshot = {
      team: true,
      tasks: [task({ taskId: 'a', goal: null }), task({ taskId: 'b', goal: '   ' })],
    }
    const view = teamPanelView(snapshot, names, NOW)
    for (const row of view.tasks) {
      assert.equal(row.goal, '（没有写目标）')
    }
  })

  it('产物提示优先于截止提示：两条同时成立时只显示更要紧的那条', () => {
    const snapshot: TeamSnapshot = {
      team: true,
      tasks: [task({ taskId: 'a', status: 'done', artifacts: [], deadlineAt: NOW - HOUR })],
    }
    const note = teamPanelView(snapshot, names, NOW).tasks[0].note
    assert.ok(note?.includes('没交出产物'), `应当优先说没产物，实际是：${note}`)
  })

  it('只保留待批的提案，已经决定过的不进面板', () => {
    const snapshot: TeamSnapshot = {
      team: true,
      proposals: [
        proposal({ proposalId: 'a' }),
        proposal({ proposalId: 'b', state: 'rejected' }),
        proposal({ proposalId: 'c', state: undefined }),
      ],
    }
    const view = teamPanelView(snapshot, names, NOW)
    assert.deepEqual(view.proposals.map(item => item.proposalId), ['a', 'c'])
  })

  it('成员行里带上各自的在手任务数与待批数', () => {
    const snapshot: TeamSnapshot = {
      team: true,
      members: [
        { assistantId: 'tang-seng', displayName: '总助理', toolScope: 'read-only' },
        { assistantId: 'sun-wukong', displayName: '助理1', toolScope: 'side-effect' },
      ],
      tasks: [task({ taskId: 'a', ownerId: 'sun-wukong', status: 'running' })],
      proposals: [proposal({ proposalId: 'p', assistantId: 'sun-wukong' })],
    }
    const view = teamPanelView(snapshot, names, NOW)
    const tang = view.members.find(item => item.assistantId === 'tang-seng')
    const sun = view.members.find(item => item.assistantId === 'sun-wukong')
    assert.equal(tang?.activeTasks, 0)
    assert.equal(tang?.pendingApprovals, 0)
    assert.equal(sun?.activeTasks, 1)
    assert.equal(sun?.pendingApprovals, 1)
  })
})
