/**
 * 帮助任务的可信执行（M2-06）：只读授权项目 → 改动提案（哈希绑定）→ 可信批准 → 可信执行器应用 → 验证命令 → 账本。
 * 每个用例都写成「如果判错会发生什么」：多写一个文件、套错一版内容、把失败的测试说成修好了。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { ApprovalError, ApprovalService, digestOf } from '../src/approval.ts'
import { changeBinding, HelpTaskError } from '../src/help-task.ts'
import { TeamStore } from '../src/team-domain.ts'
import { TeamService } from '../src/team.ts'
import { desktop, hashOf, helpHost, quiet } from './support/help-host.ts'

const FIXED = 'function add(a, b) {\n  return a + b\n}\nmodule.exports = { add }\n'
const ORIGINAL = 'function add(a, b) {\n  return a - b\n}\nmodule.exports = { add }\n'

function code(expected: string) {
  return (error: unknown) => error instanceof HelpTaskError && error.code === expected
}

test('只读已授权项目：越界、相似前缀、版本库元数据、链接逃逸、撤销授权一律拒绝；文件返回全文哈希', t => {
  const h = helpHost(t)
  assert.throws(() => h.team.help.openTask({ projectDir: h.root, goal: '未授权' }), code('NOT_AUTHORIZED'))
  const { task, context } = h.open()
  const read = h.team.help.read({ taskId: task.taskId, path: 'src/calc.js' })
  assert.equal(read.kind, 'file')
  assert.equal((read as { hash: string }).hash, hashOf(ORIGINAL))
  assert.equal((read as { content: string }).content, ORIGINAL)
  const listing = h.team.help.read({ taskId: task.taskId }) as { kind: string; entries: Array<{ name: string }> }
  assert.equal(listing.kind, 'directory')
  assert.deepEqual(listing.entries.map(entry => entry.name).sort(), ['src', 'test'])
  for (const outside of ['../repo-other/secret.txt', path.join(h.sibling, 'secret.txt')]) {
    assert.throws(() => h.team.help.read({ taskId: task.taskId, path: outside }), code('OUT_OF_SCOPE'), outside)
  }
  mkdirSync(path.join(h.root, '.git'))
  writeFileSync(path.join(h.root, '.git', 'config'), '[core]')
  assert.throws(() => h.team.help.read({ taskId: task.taskId, path: '.git/config' }), code('OUT_OF_SCOPE'))
  let linked = false
  try {
    symlinkSync(h.sibling, path.join(h.root, 'escape'), 'junction')
    linked = true
  } catch { /* 当前环境不允许建链接时跳过这一项。 */ }
  if (linked) {
    assert.throws(() => h.team.help.read({ taskId: task.taskId, path: 'escape/secret.txt' }), code('OUT_OF_SCOPE'), '链接按真实位置判断')
  }
  assert.equal(h.helpContexts.remove(context.id), true)
  assert.throws(() => h.team.help.read({ taskId: task.taskId, path: 'src/calc.js' }), code('NOT_AUTHORIZED'), '撤销后立即拒绝')
})

test('提案不写文件；批准绑定修订、基线哈希与目标路径；批准后由可信执行器原子应用，前后哈希进账本', async t => {
  const h = helpHost(t)
  const { task } = h.open()
  const base = (h.team.help.read({ taskId: task.taskId, path: 'src/calc.js' }) as { hash: string }).hash
  const proposed = h.team.help.proposeChange({ taskId: task.taskId, summary: '加法写成了减法', files: [{ path: 'src/calc.js', baseHash: base, content: FIXED }] })
  assert.equal(proposed.revision, 1)
  assert.equal(readFileSync(h.calc, 'utf8'), ORIGINAL, '提交提案不写文件')
  assert.equal(h.store.getTask(task.taskId)?.status, 'awaiting-approval')
  const card = h.approvals.pendingProposals().find(item => item.proposalId === proposed.proposalId)!
  assert.equal(card.tool, 'apply_change')
  assert.equal(card.target, h.root)
  assert.equal(card.revision, 1)
  const review = JSON.parse(card.content!) as { files: Array<{ path: string; baseHash: string; added: number; removed: number; diff: string }> }
  assert.deepEqual(review.files.map(file => [file.path, file.baseHash, file.added, file.removed]), [['src/calc.js', base, 1, 1]])
  assert.match(review.files[0]!.diff, /-  return a - b\n\+  return a \+ b/)
  const change = h.store.changeSetByProposal(proposed.proposalId)!
  assert.equal(card.paramsDigest, digestOf(changeBinding(change)), '批准绑定的是修订 + 根目录 + 每个文件的（路径, 基线, 新哈希）')
  assert.equal(change.files[0]!.path, h.calc)

  h.approve(proposed.proposalId)
  const waited = await h.wait(proposed.proposalId)
  assert.equal(waited.decision, 'executed')
  assert.equal(waited.outcome?.state, 'applied')
  assert.equal(readFileSync(h.calc, 'utf8'), FIXED)
  assert.deepEqual(readdirSync(path.join(h.root, 'src')), ['calc.js'], '没有残留的临时文件')
  const [operation] = h.approvals.operations(task.taskId)
  assert.equal(operation?.kind, 'apply_change')
  assert.equal(operation?.state, 'succeeded')
  assert.equal(operation?.target, h.root)
  assert.equal(operation?.paramsDigest, card.paramsDigest)
  assert.ok(operation?.executedAt && operation.endedAt)
  assert.deepEqual((operation?.evidence as { files: unknown[] }).files, [{ path: 'src/calc.js', beforeHash: base, afterHash: hashOf(FIXED) }])
  assert.equal(h.store.getChangeSet(change.changeId)?.state, 'applied')
  assert.equal(h.store.getChangeSet(change.changeId)?.files[0]?.afterHash, hashOf(FIXED))
  const verdict = h.team.help.verdict(task.taskId)
  assert.equal(verdict.state, 'applied-unverified')
  assert.equal(verdict.mayClaimFixed, false, '已应用不等于验证通过')
  assert.equal(h.store.getTask(task.taskId)?.status, 'review')
})

test('驳回：零改动，内容清除，任务回到等用户', async t => {
  const h = helpHost(t)
  const { task } = h.open()
  const proposed = h.team.help.proposeChange({ taskId: task.taskId, summary: '改一下', files: [{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: FIXED }] })
  h.reject(proposed.proposalId)
  const waited = await h.wait(proposed.proposalId)
  assert.equal(waited.decision, 'rejected')
  assert.equal(readFileSync(h.calc, 'utf8'), ORIGINAL)
  assert.equal(h.approvals.operations(task.taskId).length, 0, '驳回不留执行账')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(h.store.getChangeSet(proposed.changeId)?.state, 'rejected')
  assert.equal(h.store.changeContents(proposed.changeId).get(0), null, '驳回后不再保存新内容')
  assert.equal(h.store.getTask(task.taskId)?.status, 'awaiting-user')
})

test('驳回之后紧接着提下一版：被驳回的那版如实记 rejected，不被记成「被取代」', t => {
  const h = helpHost(t)
  const { task } = h.open()
  const first = h.team.help.proposeChange({ taskId: task.taskId, summary: '第一版', files: [{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: FIXED }] })
  h.reject(first.proposalId)
  // 决定回调在下一拍才跑；这里同步提下一版，模拟模型收到驳回后立刻改方案。
  const second = h.team.help.proposeChange({ taskId: task.taskId, summary: '第二版', files: [{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: `${FIXED}// v2\n` }] })
  assert.deepEqual(second.supersededRevisions, [])
  assert.equal(h.store.getChangeSet(first.changeId)?.state, 'rejected')
  assert.equal(readFileSync(h.calc, 'utf8'), ORIGINAL)
})

test('批准后、应用前用户改了文件：冲突暂停，一个文件都不写', async t => {
  const h = helpHost(t, { manual: true })
  const { task } = h.open()
  writeFileSync(path.join(h.root, 'src', 'other.js'), 'exports.x = 1\n')
  const proposed = h.team.help.proposeChange({ taskId: task.taskId, summary: '两处改动', files: [
    { path: 'src/other.js', baseHash: hashOf('exports.x = 1\n'), content: 'exports.x = 2\n' },
    { path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: FIXED },
  ] })
  h.approve(proposed.proposalId)
  await h.queued()
  const userEdit = `${ORIGINAL}// 用户刚刚加的注释\n`
  writeFileSync(h.calc, userEdit)
  await h.runQueued()
  const waited = await h.wait(proposed.proposalId)
  assert.equal(waited.outcome?.state, 'conflict')
  assert.match(waited.outcome?.detail ?? '', /冲突暂停.*未写入任何文件/)
  assert.equal(readFileSync(h.calc, 'utf8'), userEdit, '用户的修改原样保留')
  assert.equal(readFileSync(path.join(h.root, 'src', 'other.js'), 'utf8'), 'exports.x = 1\n', '另一个文件的基线没变也不能先写')
  assert.deepEqual(readdirSync(path.join(h.root, 'src')).sort(), ['calc.js', 'other.js'])
  const [operation] = h.approvals.operations(task.taskId)
  assert.equal(operation?.state, 'failed')
  assert.equal((operation?.evidence as { outcome: string }).outcome, 'conflict')
  assert.equal(h.team.help.verdict(task.taskId).state, 'conflict')
  assert.equal(h.store.getTask(task.taskId)?.status, 'awaiting-user', '冲突后等用户与助理重新读取、提交新一版')
  // 批准只能用一次：冲突那次已经消费，旧卡不能再执行。
  const replay = await h.team.help.execute(proposed.proposalId)
  assert.notEqual(replay.state, 'applied')
  assert.equal(readFileSync(h.calc, 'utf8'), userEdit)
})

test('批准后改参数被拒：新修订取代未执行的旧批准；库里的绑定被改则摘要不符，零写入且不消费批准', async t => {
  const h = helpHost(t, { manual: true, fileDb: true })
  const { task } = h.open()
  const first = h.team.help.proposeChange({ taskId: task.taskId, summary: '第一版', files: [{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: FIXED }] })
  h.approve(first.proposalId)
  await h.queued()
  const second = h.team.help.proposeChange({ taskId: task.taskId, summary: '第二版', files: [{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: `${FIXED}// v2\n` }] })
  assert.equal(second.revision, 2)
  assert.deepEqual(second.supersededRevisions, [1])
  await h.runQueued()
  assert.equal((await h.wait(first.proposalId)).outcome?.state, 'superseded')
  assert.equal(readFileSync(h.calc, 'utf8'), ORIGINAL)

  h.approve(second.proposalId)
  await h.queued()
  // 模拟批准之后有人改了库里绑定的新哈希（等价于「批准后换内容」）。
  const raw = new DatabaseSync(h.teamDbPath)
  raw.prepare('UPDATE change_files SET new_hash = ? WHERE change_id = ?').run('f'.repeat(64), second.changeId)
  raw.close()
  await h.runQueued()
  const outcome = (await h.wait(second.proposalId)).outcome
  assert.equal(outcome?.state, 'failed')
  assert.match(outcome?.detail ?? '', /DIGEST_MISMATCH/)
  assert.equal(readFileSync(h.calc, 'utf8'), ORIGINAL)
  assert.equal(h.approvals.operations(task.taskId).length, 0, '摘要不符时批准不被消费，也不留执行账')
  assert.equal(h.store.approvalForProposal(second.proposalId)?.consumedAt, null)
})

test('批准过期被拒；重放被拒；同一张卡不能批两次', async t => {
  const h = helpHost(t, { manual: true, ttlMs: 120 })
  const { task } = h.open()
  const proposed = h.team.help.proposeChange({ taskId: task.taskId, summary: '会过期', files: [{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: FIXED }] })
  h.approve(proposed.proposalId)
  await h.queued()
  await new Promise(resolve => setTimeout(resolve, 200))
  await h.runQueued()
  const expired = (await h.wait(proposed.proposalId)).outcome
  assert.equal(expired?.state, 'expired')
  assert.equal(readFileSync(h.calc, 'utf8'), ORIGINAL)
  assert.throws(() => h.approve(proposed.proposalId), (error: unknown) => error instanceof ApprovalError && error.code === 'ALREADY_CONSUMED')

  const g = helpHost(t)
  const opened = g.open()
  const applied = g.team.help.proposeChange({ taskId: opened.task.taskId, summary: '正常应用', files: [{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: FIXED }] })
  g.approve(applied.proposalId)
  assert.equal((await g.wait(applied.proposalId)).outcome?.state, 'applied')
  writeFileSync(g.calc, ORIGINAL)
  const replay = await g.team.help.execute(applied.proposalId)
  assert.equal(replay.state, 'applied', '已应用的改动不会再执行一次')
  assert.equal(readFileSync(g.calc, 'utf8'), ORIGINAL, '重放没有再写')
  assert.throws(() => g.approvals.consumeTrusted(applied.proposalId, {
    tool: 'apply_change', taskId: opened.task.taskId, target: g.root, params: changeBinding(g.store.getChangeSet(applied.changeId)!),
    inputRevision: 1, blockOnUncertain: true,
  }), (error: unknown) => error instanceof ApprovalError && error.code === 'ALREADY_CONSUMED')
  assert.equal(g.approvals.operations(opened.task.taskId).length, 1)
})

test('原子写：改名中途失败就回滚，账本记 failed，项目一个字节都不变', async t => {
  const h = helpHost(t, { commitHooks: { beforeRename: (_target, index) => { if (index === 1) throw Object.assign(new Error('被占用'), { code: 'EBUSY' }) } } })
  const { task } = h.open()
  writeFileSync(path.join(h.root, 'src', 'other.js'), 'exports.x = 1\n')
  const proposed = h.team.help.proposeChange({ taskId: task.taskId, summary: '两处改动', files: [
    { path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: FIXED },
    { path: 'src/other.js', baseHash: hashOf('exports.x = 1\n'), content: 'exports.x = 2\n' },
  ] })
  h.approve(proposed.proposalId)
  const outcome = (await h.wait(proposed.proposalId)).outcome
  assert.equal(outcome?.state, 'failed')
  assert.match(outcome?.detail ?? '', /恢复成基线/)
  assert.equal(readFileSync(h.calc, 'utf8'), ORIGINAL)
  assert.equal(readFileSync(path.join(h.root, 'src', 'other.js'), 'utf8'), 'exports.x = 1\n')
  assert.deepEqual(readdirSync(path.join(h.root, 'src')).sort(), ['calc.js', 'other.js'])
  assert.equal(h.approvals.operations(task.taskId)[0]?.state, 'failed')
})

test('提案校验：基线不符、补丁对不上、越界、新建文件写错基线都在提案时拒绝，不发审批卡', t => {
  const h = helpHost(t)
  const { task } = h.open()
  const propose = (files: Array<{ path: string; baseHash: string; content?: string; diff?: string }>) =>
    h.team.help.proposeChange({ taskId: task.taskId, summary: '校验', files })
  assert.throws(() => propose([{ path: 'src/calc.js', baseHash: 'a'.repeat(64), content: FIXED }]), code('BASE_CHANGED'))
  assert.throws(() => propose([{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), diff: '@@ -1,1 +1,1 @@\n-不存在的行\n+x\n' }]), code('PATCH_FAILED'))
  assert.throws(() => propose([{ path: '../repo-other/secret.txt', baseHash: hashOf('不在授权范围内'), content: 'x' }]), code('OUT_OF_SCOPE'))
  assert.throws(() => propose([{ path: 'src/new.js', baseHash: hashOf(''), content: 'x' }]), code('BASE_CHANGED'))
  assert.throws(() => propose([{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL) }]), code('BAD_INPUT'), 'content 与 diff 必须二选一')
  assert.throws(() => propose([{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: ORIGINAL }]), code('BAD_INPUT'), '没有改动')
  assert.equal(h.approvals.pendingProposals().length, 0)
  const ok = propose([{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), diff: '@@ -2,1 +2,1 @@\n-  return a - b\n+  return a + b\n' },
    { path: 'src/new.js', baseHash: 'absent', content: 'exports.y = 1\n' }])
  assert.deepEqual(ok.files.map(file => [file.path, file.action]), [['src/calc.js', 'modify'], ['src/new.js', 'create']])
})

test('验证命令：参数必须是数组、cwd 不能越界、shell 与 .cmd 拒绝；程序解析成绝对路径且不搜工作目录', t => {
  const h = helpHost(t)
  const { task } = h.open()
  const propose = (input: Partial<{ cwd: string; program: string; args: unknown; timeoutSeconds: number; expectedEffects: string }>) =>
    h.team.help.proposeVerification({ taskId: task.taskId, program: process.execPath, args: ['--version'], timeoutSeconds: 10,
      expectedEffects: '只打印版本', ...input } as never)
  assert.throws(() => propose({ args: 'node --test' }), code('BAD_INPUT'), '不接受拼好的命令字符串')
  assert.throws(() => propose({ args: ['ok', 1] }), code('BAD_INPUT'))
  assert.throws(() => propose({ cwd: '..' }), code('OUT_OF_SCOPE'))
  assert.throws(() => propose({ cwd: h.sibling }), code('OUT_OF_SCOPE'))
  for (const shell of ['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'C:\\Windows\\System32\\cmd.exe']) {
    assert.throws(() => propose({ program: shell }), code('BAD_PROGRAM'), shell)
  }
  if (process.platform === 'win32') assert.throws(() => propose({ program: 'run-tests.cmd' }), code('BAD_PROGRAM'))
  assert.throws(() => propose({ timeoutSeconds: 0 }), code('BAD_INPUT'))
  assert.throws(() => propose({ expectedEffects: ' ' }), code('BAD_INPUT'))
  // 工作目录里放一个同名程序：裸名解析只查 PATH 的绝对目录，不会被它顶替。
  const fake = path.join(h.root, process.platform === 'win32' ? 'node.exe' : 'node')
  writeFileSync(fake, 'not really node')
  const env = { PATH: path.dirname(process.execPath) }
  const bare = new TeamService({} as never, h.store, {
    teamId: 'test', provider: 'spawn', seats: [], maxConcurrentInference: 1, maxConcurrentSideEffect: 1, taskTimeoutMs: 1000,
    defaultBudgetTokens: 0, denyExpertTools: [], approvals: h.approvals, logger: quiet, helpScopes: h.helpContexts, helpExecution: { env },
  })
  t.after(() => bare.dispose())
  const resolved = bare.help.proposeVerification({ taskId: task.taskId, program: 'node', args: ['--version'], timeoutSeconds: 10, expectedEffects: '只打印版本' })
  assert.notEqual(resolved.program, fake)
  assert.equal(path.dirname(resolved.program).toLowerCase(), path.dirname(process.execPath).toLowerCase())
  assert.equal(path.isAbsolute(resolved.program), true)
})

test('验证命令：批准后运行一次，真实退出码如实入账；失败不能说修复完成，通过才算验证通过', async t => {
  const h = helpHost(t)
  const { task } = h.open()
  const change = h.team.help.proposeChange({ taskId: task.taskId, summary: '修复', files: [{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: FIXED }] })
  h.approve(change.proposalId)
  assert.equal((await h.wait(change.proposalId)).outcome?.state, 'applied')

  const failing = h.team.help.proposeVerification({ taskId: task.taskId, program: process.execPath,
    args: ['-e', 'console.error("1 个测试失败"); process.exit(3)'], timeoutSeconds: 30, expectedEffects: '只运行测试' })
  assert.equal(failing.afterChange?.revision, 1)
  assert.equal(h.store.getTask(task.taskId)?.status, 'awaiting-approval')
  const card = h.approvals.pendingProposals().find(item => item.proposalId === failing.proposalId)!
  assert.equal(card.risk, 'high')
  const document = JSON.parse(card.content!) as { program: string; args: string[]; cwd: string; timeoutMs: number; expectedEffects: string }
  assert.deepEqual(document.args, ['-e', 'console.error("1 个测试失败"); process.exit(3)'])
  assert.equal(document.cwd, h.root)
  h.approve(failing.proposalId)
  const failed = await h.wait(failing.proposalId)
  assert.equal(failed.outcome?.state, 'failed')
  const failedOp = h.approvals.operations(task.taskId).find(item => item.kind === 'run_verification')!
  assert.equal(failedOp.state, 'failed')
  assert.match(failedOp.resultDetail ?? '', /退出码 3，验证未通过/)
  const evidence = failedOp.evidence as { exitCode: number; stderr: string; verdict: string; fileResults: { appliedFiles: Array<{ unchanged: boolean }> } }
  assert.equal(evidence.exitCode, 3)
  assert.match(evidence.stderr, /1 个测试失败/)
  assert.equal(evidence.fileResults.appliedFiles[0]?.unchanged, true)
  const failedVerdict = h.team.help.verdict(task.taskId)
  assert.equal(failedVerdict.state, 'verification-failed')
  assert.equal(failedVerdict.mayClaimFixed, false)
  assert.match(failedVerdict.text, /不能说修复完成/)
  assert.equal(h.store.getTask(task.taskId)?.status, 'review')

  const passing = h.team.help.proposeVerification({ taskId: task.taskId, program: process.execPath,
    args: ['-e', 'console.log("all ok")'], timeoutSeconds: 30, expectedEffects: '只运行测试' })
  h.approve(passing.proposalId)
  assert.equal((await h.wait(passing.proposalId)).outcome?.state, 'passed')
  const verdict = h.team.help.verdict(task.taskId)
  assert.equal(verdict.state, 'verified')
  assert.equal(verdict.mayClaimFixed, true)
  assert.equal(verdict.exitCode, 0)
  const done = h.store.getTask(task.taskId)!
  assert.equal(done.status, 'done', '可信验证器（真实退出码 0）通过后才完成')
  assert.ok(done.artifacts.some(item => /退出码 0/.test(item)))
  const passedOp = h.approvals.operations(task.taskId).find(item => item.kind === 'run_verification' && item.state === 'succeeded')!
  assert.match((passedOp.evidence as { stdout: string }).stdout, /all ok/)
  assert.throws(() => h.team.help.proposeChange({ taskId: task.taskId, summary: '完成后还想改', files: [{ path: 'src/calc.js', baseHash: hashOf(FIXED), content: ORIGINAL }] }),
    code('TASK_CLOSED'))
})

test('验证命令超时：结束进程树并记 timed-out，不能说修复完成', async t => {
  const h = helpHost(t)
  const { task } = h.open()
  const change = h.team.help.proposeChange({ taskId: task.taskId, summary: '修复', files: [{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: FIXED }] })
  h.approve(change.proposalId)
  await h.wait(change.proposalId)
  const slow = h.team.help.proposeVerification({ taskId: task.taskId, program: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'], timeoutSeconds: 1, expectedEffects: '只运行测试' })
  h.approve(slow.proposalId)
  const outcome = (await h.wait(slow.proposalId, 15_000)).outcome
  assert.equal(outcome?.state, 'timed-out')
  const operation = h.approvals.operations(task.taskId).find(item => item.kind === 'run_verification')!
  assert.equal(operation.state, 'failed')
  assert.equal((operation.evidence as { timedOut: boolean }).timedOut, true)
  assert.equal(h.team.help.verdict(task.taskId).mayClaimFixed, false)
})

test('unknown 人工复核：模型提交不改账本；不可信主体签不了；只有可信批准写入结论；账目变了就拒绝', async t => {
  const h = helpHost(t)
  const task = h.team.submitTask({ goal: '门禁执行过的副作用', toolScope: 'side-effect' })
  /** 走一遍真实的门禁消费路径，造一条结果不明的操作。 */
  const unknownOp = (command: string) => {
    let current = h.store.getTask(task.taskId)!
    if (current.status !== 'running') current = h.store.updateTask(task.taskId, current.revision, { status: 'running' })!
    const call = { taskId: task.taskId, assistantId: current.ownerId, inputRevision: current.revision, tool: 'bash', target: command, params: { command } }
    const proposal = h.approvals.propose({ ...call, summary: '测试', risk: 'high' })
    h.approvals.issue(proposal.proposalId, desktop, true)
    const operation = h.approvals.consumeByProposal(proposal.proposalId, 'bash', call)
    h.approvals.settle(operation.operationId, 'unknown', null, '进程中断，结果不明')
    return operation
  }
  const first = unknownOp('deploy --prod')
  const running = h.store.getTask(task.taskId)!
  h.store.updateTask(task.taskId, running.revision, { status: 'unknown' })

  const requested = h.team.help.proposeReview({ operationId: first.operationId, resolution: 'verified-succeeded', note: '我在服务器上确认已部署' })
  assert.equal(h.store.getOperation(first.operationId)?.state, 'unknown', '提交复核申请不改账本')
  const card = h.approvals.pendingProposals().find(item => item.proposalId === requested.proposalId)!
  assert.equal(card.tool, 'review_unknown')
  assert.equal((JSON.parse(card.content!) as { resolutionLabel: string }).resolutionLabel, '已核实成功')
  assert.throws(() => h.approvals.issue(requested.proposalId, desktop, false), (error: unknown) => error instanceof ApprovalError && error.code === 'UNTRUSTED_SUBJECT')
  assert.throws(() => h.approvals.consumeTrusted(requested.proposalId, { tool: 'review_unknown', taskId: task.taskId, target: `operation:${first.operationId}`,
    params: {}, inputRevision: 1, blockOnUncertain: false }), ApprovalError, '没批准就消费不了')
  assert.throws(() => h.approvals.propose({ taskId: task.taskId, assistantId: task.ownerId, inputRevision: 1, tool: 'review_unknown',
    target: `operation:${first.operationId}`, params: { resolution: 'verified-succeeded' }, summary: '模型冒充', risk: 'low' }), ApprovalError,
  '普通提案入口不能造执行器动作')
  h.approve(requested.proposalId)
  assert.equal((await h.wait(requested.proposalId)).outcome?.state, 'applied')
  const reviewed = h.store.getOperation(first.operationId)!
  assert.equal(reviewed.state, 'succeeded')
  assert.equal(reviewed.review?.resolution, 'verified-succeeded')
  assert.equal(reviewed.review?.note, '我在服务器上确认已部署')
  assert.match(reviewed.resultDetail ?? '', /人工复核：已核实成功.*原说明：进程中断/)
  assert.ok(h.approvals.operations(task.taskId).some(item => item.kind === 'review_unknown' && item.state === 'succeeded'), '复核动作本身也进账本')
  assert.equal(h.store.getTask(task.taskId)?.status, 'review', 'unknown 都复核完回到等复核，不自动判完成')

  // 申请之后账目变了（例如迟到的真实结果先到）：复核不能覆盖它。
  const second = unknownOp('migrate --db')
  const stale = h.team.help.proposeReview({ operationId: second.operationId, resolution: 'verified-succeeded' })
  h.approvals.settle(second.operationId, 'failed', null, '迟到的真实结果：失败')
  h.approve(stale.proposalId)
  assert.equal((await h.wait(stale.proposalId)).outcome?.state, 'refused')
  assert.equal(h.store.getOperation(second.operationId)?.state, 'failed', '真实结果没有被复核结论覆盖')

  const third = unknownOp('rotate --keys')
  const abandon = h.team.help.proposeReview({ operationId: third.operationId, resolution: 'abandoned', note: '查不到日志' })
  h.approve(abandon.proposalId)
  await h.wait(abandon.proposalId)
  assert.equal(h.store.getOperation(third.operationId)?.state, 'abandoned')
  assert.throws(() => h.team.help.proposeReview({ operationId: third.operationId, resolution: 'verified-succeeded' }), code('BAD_INPUT'),
    '放弃之后不能再被改成成功')
})

test('重启对账：应用中途中断的改动与操作记 unknown，任务进 unknown，不自动重做', async t => {
  const h = helpHost(t, { manual: true, fileDb: true })
  const { task } = h.open()
  const crashed = h.team.help.proposeChange({ taskId: task.taskId, summary: '应用到一半进程没了', files: [{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: FIXED }] })
  h.approve(crashed.proposalId)
  await h.queued()
  // 白盒模拟「批准已消费、进入应用、结果没落库」：与执行器前半段完全相同的调用。
  const change = h.store.changeSetByProposal(crashed.proposalId)!
  const operation = h.approvals.consumeTrusted(crashed.proposalId, { tool: 'apply_change', taskId: task.taskId, target: h.root,
    params: changeBinding(change), inputRevision: change.revision, blockOnUncertain: true })
  h.store.setChangeState(change.changeId, 'applying', { operationId: operation.operationId, from: ['approved'] })
  h.approvals.markRunning(operation.operationId)
  await h.close()

  // 同一个库重新打开：新的存储、新的代次、新的服务 = 一次重启。用完立即关闭，临时目录才删得掉。
  const store = new TeamStore(h.teamDbPath)
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'after-restart' })
  const team = new TeamService({} as never, store, { teamId: 'test', provider: 'spawn', seats: [], maxConcurrentInference: 1,
    maxConcurrentSideEffect: 1, taskTimeoutMs: 1000, defaultBudgetTokens: 0, denyExpertTools: [], approvals, logger: quiet })
  try {
    team.recoverInterruptedTasks()
    assert.equal(store.getOperation(operation.operationId)?.state, 'unknown')
    assert.equal(store.getChangeSet(change.changeId)?.state, 'unknown')
    assert.equal(store.getTask(task.taskId)?.status, 'unknown')
    assert.equal(team.help.verdict(task.taskId).state, 'unknown')
    assert.equal(readFileSync(h.calc, 'utf8'), ORIGINAL)
  } finally {
    await team.dispose()
    store.close()
  }
})

test('关闭后重启对账：未执行的改动及批准记 expired，新实例不能消费旧批准', async t => {
  const h = helpHost(t, { manual: true, fileDb: true })
  const { task } = h.open()
  const pending = h.team.help.proposeChange({ taskId: task.taskId, summary: '批准后进程重启', files: [{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: FIXED }] })
  h.approve(pending.proposalId)
  await h.queued()
  await h.close()
  const store = new TeamStore(h.teamDbPath)
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'after-restart' })
  const team = new TeamService({} as never, store, { teamId: 'test', provider: 'spawn', seats: [], maxConcurrentInference: 1,
    maxConcurrentSideEffect: 1, taskTimeoutMs: 1000, defaultBudgetTokens: 0, denyExpertTools: [], approvals, logger: quiet })
  try {
    team.recoverInterruptedTasks()
    assert.equal(store.getChangeSet(pending.changeId)?.state, 'expired')
    const change = store.getChangeSet(pending.changeId)!
    assert.equal(approvals.proposal(pending.proposalId)?.state, 'expired')
    assert.throws(() => approvals.consumeTrusted(pending.proposalId, { tool: 'apply_change', taskId: task.taskId, target: change.root,
      params: changeBinding(change), inputRevision: 1, blockOnUncertain: true }),
    (error: unknown) => error instanceof ApprovalError && error.code === 'NOT_FOUND')
    assert.equal(readFileSync(h.calc, 'utf8'), ORIGINAL)
  } finally {
    await team.dispose()
    store.close()
  }
})

test('团队卸载时作废待批卡，对账记 expired，不留悬空的已批准改动', async t => {
  const h = helpHost(t)
  const { task } = h.open()
  const proposed = h.team.help.proposeChange({ taskId: task.taskId, summary: '卸载中途批准', files: [{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: FIXED }] })
  await h.team.dispose()
  assert.equal(h.approvals.proposal(proposed.proposalId)?.state, 'expired')
  assert.throws(() => h.approve(proposed.proposalId), (error: unknown) => error instanceof ApprovalError && error.code === 'ALREADY_CONSUMED')
  assert.equal(h.store.getChangeSet(proposed.changeId)?.state, 'pending', '执行器已经停止，记录由对账同步')
  const remounted = new TeamService({} as never, h.store, { teamId: 'test', provider: 'spawn', seats: [], maxConcurrentInference: 1,
    maxConcurrentSideEffect: 1, taskTimeoutMs: 1000, defaultBudgetTokens: 0, denyExpertTools: [], approvals: h.approvals, logger: quiet,
    helpScopes: h.helpContexts })
  try {
    remounted.recoverInterruptedTasks()
    assert.equal(h.store.getChangeSet(proposed.changeId)?.state, 'expired')
    assert.equal(readFileSync(h.calc, 'utf8'), ORIGINAL)
    assert.equal(h.approvals.operations(task.taskId).length, 0)
  } finally {
    await remounted.dispose()
  }
})

test('帮助执行调度晚于关库到达时，不读库、不进入执行器也不写文件', async t => {
  const h = helpHost(t, { manual: true })
  const { task } = h.open()
  const proposed = h.team.help.proposeChange({ taskId: task.taskId, summary: '晚到执行', files: [{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: FIXED }] })
  h.approve(proposed.proposalId)
  await h.queued()
  const execute = t.mock.method(h.team.help, 'execute')
  await h.close()
  const read = t.mock.method(h.store, 'getProposal', () => { throw new Error('关闭后不允许读库') })
  assert.doesNotThrow(() => h.queue.shift()!())
  assert.equal(execute.mock.callCount(), 0)
  const outcome = await h.team.help.execute(proposed.proposalId)
  assert.equal(outcome.state, 'refused')
  assert.equal(read.mock.callCount(), 0)
  assert.equal(readFileSync(h.calc, 'utf8'), ORIGINAL)
})

test('帮助执行已进入串行队列但尚未开始时，释放立即拒绝真正执行且重复释放共用 Promise', async t => {
  const h = helpHost(t, { manual: true })
  const { task } = h.open()
  const proposed = h.team.help.proposeChange({ taskId: task.taskId, summary: '串行队列停止', files: [{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: FIXED }] })
  h.approve(proposed.proposalId)
  await h.queued()
  const executing = h.team.help.execute(proposed.proposalId)
  const first = h.team.help.dispose()
  assert.equal(h.team.help.dispose(), first)
  await first
  assert.equal((await executing).state, 'refused')
  assert.equal(h.store.listOperations(task.taskId).length, 0)
  assert.equal(readFileSync(h.calc, 'utf8'), ORIGINAL)
  assert.throws(() => h.team.help.openTask({ projectDir: h.root, goal: '已经停止' }), code('STOPPED'))
})

test('帮助服务不读取、执行、取消或恢复普通任务，即使任务属于同一团队和成员且带帮助记录', async t => {
  const h = helpHost(t, { manual: true })
  const { task } = h.open()
  const proposed = h.team.help.proposeChange({ taskId: task.taskId, summary: '运行域隔离', files: [{ path: 'src/calc.js', baseHash: hashOf(ORIGINAL), content: FIXED }] })
  h.store.saveCompanionMeta({ taskId: task.taskId, runtimeScope: 'companion', principalId: 'owner', deviceId: 'device',
    parentTaskId: null, kind: 'agent', inputRef: 'input', blocker: null })
  const before = h.store.getTask(task.taskId)
  assert.equal(h.team.help.helpTask(task.taskId), null)
  assert.equal(h.team.help.status(task.taskId), null)
  assert.throws(() => h.team.help.read({ taskId: task.taskId, path: 'src/calc.js' }), code('NOT_FOUND'))
  assert.throws(() => h.team.help.verdict(task.taskId), code('NOT_FOUND'))
  assert.throws(() => h.team.help.proposeChange({ taskId: task.taskId, summary: '不能改', files: [] }), code('NOT_FOUND'))
  h.approve(proposed.proposalId)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.queue.length, 0)
  assert.equal((await h.team.help.execute(proposed.proposalId)).state, 'refused')
  await assert.rejects(h.wait(proposed.proposalId), code('NOT_FOUND'))
  await h.team.help.cancel(task.taskId)
  h.team.help.recover(task.taskId)
  await h.team.dispose()
  assert.equal(h.approvals.proposal(proposed.proposalId)?.state, 'approved')
  assert.equal(h.store.getChangeSet(proposed.changeId)?.state, 'pending')
  assert.deepEqual(h.store.getTask(task.taskId), before)
  assert.equal(h.store.listOperations(task.taskId).length, 0)
  assert.equal(readFileSync(h.calc, 'utf8'), ORIGINAL)
})
