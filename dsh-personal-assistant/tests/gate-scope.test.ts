/**
 * 写类目标的范围收紧（M2-02）：规范化后再比对，符号链接越界、相似前缀、路径穿越一律拒绝，
 * 批准绑定的必须是执行时真正会写到的位置。用真实临时目录与目录联接（junction，无需管理员权限）验证。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ApprovalService } from '../src/approval.ts'
import { canonicalPath, canonicalRoot, installApprovalGate, isWithinRoot, scopedGateDecision } from '../src/gate.ts'
import { TeamStore } from '../src/team-domain.ts'

const require = createRequire(import.meta.url)
const hostRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'))
const { default: SystemPrompt } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-system-prompt')).href)
const { createScope } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-scope')).href)

/** base/a 是授权工作区；base/ab 是相似前缀的兄弟目录；base/outside 在工作区外。 */
function layout(t: TestContext) {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'dsh-scope-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'a')
  const sibling = path.join(base, 'ab')
  const outside = path.join(base, 'outside')
  for (const dir of [root, sibling, outside, path.join(root, 'real'), path.join(root, 'other')]) mkdirSync(dir)
  writeFileSync(path.join(root, 'file.txt'), '普通文件')
  symlinkSync(outside, path.join(root, 'escape'), 'junction')
  symlinkSync(path.join(root, 'real'), path.join(root, 'inner'), 'junction')
  const gone = path.join(base, 'gone')
  mkdirSync(gone)
  symlinkSync(gone, path.join(root, 'dangling'), 'junction')
  rmSync(gone, { recursive: true })
  return { base, root, sibling, outside }
}

const write = (file_path: string) => ({ file_path, content: '内容' })

test('相似前缀与路径穿越：按路径段而不是字符串前缀判断', t => {
  const { base, root, sibling } = layout(t)
  assert.equal(path.join(base, 'ab').startsWith(root), true, '前提：字符串前缀判断会误放行')
  assert.equal(isWithinRoot(root, path.join(sibling, 'x.txt')), false)
  assert.equal(isWithinRoot(root, root), false, '根目录本身不能当文件写')
  assert.equal(isWithinRoot(root, path.join(root, '..foo')), true, '以两个点开头的文件名仍在根内')
  const scope = { workspaceRoot: root }
  assert.equal(scopedGateDecision('write', write(path.join(sibling, 'x.txt')), root, scope).kind, 'unbound')
  const traversal = `${root}${path.sep}..${path.sep}ab${path.sep}x.txt`
  assert.equal(scopedGateDecision('write', write(traversal), root, scope).kind, 'unbound')
  assert.equal(scopedGateDecision('edit', { file_path: `..${path.sep}ab${path.sep}x.txt` }, root, scope).kind, 'unbound')
  assert.equal(scopedGateDecision('write', write(root), root, scope).kind, 'unbound')
})

test('符号链接越界：联接点指到工作区外、悬空链接、穿过普通文件都拒绝；指回工作区内按真实位置绑定', t => {
  const { root, outside } = layout(t)
  const scope = { workspaceRoot: root }
  for (const target of [path.join(root, 'escape', 'x.txt'), path.join('escape', 'x.txt'), path.join(root, 'dangling', 'x.txt'), path.join(root, 'file.txt', 'x')]) {
    const decision = scopedGateDecision('write', write(target), root, scope)
    assert.equal(decision.kind, 'unbound', target)
  }
  assert.throws(() => canonicalPath(path.join(root, 'dangling', 'x.txt'), root), /悬空链接/)
  assert.equal(canonicalPath(path.join(root, 'escape', 'x.txt'), root), path.join(outside, 'x.txt'))
  const inner = scopedGateDecision('write', write(path.join('inner', 'x.txt')), root, scope)
  assert.deepEqual(inner, { kind: 'gated', target: path.join(root, 'real', 'x.txt') })
  const created = scopedGateDecision('write', write(path.join(root, 'sub', 'new', 'x.txt')), root, scope)
  assert.deepEqual(created, { kind: 'gated', target: path.join(root, 'sub', 'new', 'x.txt') }, '尚不存在的中间目录原样拼回')
  assert.deepEqual(scopedGateDecision('write', write('relative.txt'), root, scope), { kind: 'gated', target: path.join(root, 'relative.txt') })
})

test('规范化口径与工具细节：大小写、str_replace_editor 绝对路径、只读查看、授权根校验', { skip: process.platform !== 'win32' && '大小写不敏感只在 Windows 上成立' }, t => {
  const { root, outside } = layout(t)
  const scope = { workspaceRoot: root }
  assert.deepEqual(scopedGateDecision('write', write(path.join(root.toUpperCase(), 'X.txt')), root, scope),
    { kind: 'gated', target: path.join(root, 'X.txt') }, '已存在部分恢复真实大小写，批准与执行按同一口径比对')
  assert.equal(scopedGateDecision('str_replace_editor', { command: 'create', path: 'rel.txt' }, root, scope).kind, 'unbound')
  assert.deepEqual(scopedGateDecision('str_replace_editor', { command: 'create', path: path.join(root, 'x.txt') }, root, scope),
    { kind: 'gated', target: path.join(root, 'x.txt') })
  assert.equal(scopedGateDecision('str_replace_editor', { command: 'view', path: path.join(outside, 'x.txt') }, root, scope).kind, 'open')
  assert.equal(scopedGateDecision('write', write(path.join(root, 'x.txt')), root, { workspaceRoot: root, allow: ['read'] }).kind, 'unbound')
  assert.equal(scopedGateDecision('write', write(path.join(root, 'x.txt')), root, { workspaceRoot: root, denied: ['write'] }).kind, 'unbound')
  assert.equal(canonicalRoot(undefined), undefined)
  assert.equal(canonicalRoot('relative'), undefined)
  assert.equal(canonicalRoot(path.join(root, 'file.txt')), undefined)
  assert.equal(canonicalRoot(root.toUpperCase()), root)
})

async function gateHost(t: TestContext, root: string) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const key = { id: 'child' } as Agent
  let scope!: { ctx: Context; dispose(): Promise<void> }
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt'] }))
  Object.assign(key, { ctx: scope.ctx, session: { header: { id: 'child', cwd: root }, events: [] } })
  Object.defineProperty(scope.ctx, 'agent', { value: key, configurable: true })
  t.after(() => scope.dispose())
  const calls: string[] = []
  const tool: ToolDefinition = {
    name: 'write', description: '无副作用测试替身', parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: '测试成功' }] },
    async execute(args) { calls.push(String((args as { file_path: string }).file_path)); return '测试成功' },
  }
  ctx.tools.register(tool)
  const store = new TeamStore(':memory:')
  t.after(() => store.close())
  store.upsertMember({ assistantId: 'chief', roleId: 'tangseng', displayName: '总助理', skinId: 'test', persona: '',
    voiceProfile: '', enabled: true, revision: 1, toolPolicy: { mode: 'side-effect', denyTools: [] } })
  store.insertTask({ taskId: 'task', teamId: 'test', ownerId: 'chief', goal: '测试', inputEvidence: [], acceptance: [],
    toolScope: 'side-effect', budgetTokens: 0, deadlineAt: null, dependsOn: [], status: 'running', revision: 1,
    artifacts: [], originRequestId: null, originChannel: null, createdAt: 1, updatedAt: 1 })
  const approvals = new ApprovalService(store, { ttlMs: 60_000, runtimeEpoch: 'test' })
  installApprovalGate(key, { taskId: 'task', assistantId: 'chief', inputRevision: 1, approvals, label: 'run', workspaceRoot: root })
  const run = (args: unknown) => ctx.tools.execute({ callId: 'call' as never, name: 'write', arguments: args, agent: key, signal: new AbortController().signal })
  return { approvals, calls, run }
}

test('批准绑定真实目标：批准后把目录换成联接点（工作区内或外）都对不上批准，恢复原状才执行一次', async t => {
  const { root, outside } = layout(t)
  const h = await gateHost(t, root)
  const params = write(path.join('real', 'x.txt'))
  const approved = h.approvals.requestApproval({ taskId: 'task', assistantId: 'chief', inputRevision: 1, tool: 'write',
    target: path.join(root, 'real', 'x.txt'), params }, '测试：批准写 real/x.txt', 'medium')
  h.approvals.issue(approved.proposalId, { channel: 'desktop-shell' }, true)

  renameSync(path.join(root, 'real'), path.join(root, 'real-old'))
  symlinkSync(path.join(root, 'other'), path.join(root, 'real'), 'junction')
  const redirected = await h.run(params)
  assert.equal(redirected.isError, true, '换成指向工作区内另一目录的联接点，真实目标变了就不是批准的那个')
  unlinkSync(path.join(root, 'real'))
  symlinkSync(outside, path.join(root, 'real'), 'junction')
  const escaped = await h.run(params)
  assert.equal(escaped.isError, true)
  assert.match(JSON.stringify(escaped.content), /不在授权工作区/)
  assert.deepEqual(h.calls, [])
  assert.equal(h.approvals.operations().length, 0, '对不上的调用没有消费批准')

  unlinkSync(path.join(root, 'real'))
  renameSync(path.join(root, 'real-old'), path.join(root, 'real'))
  assert.equal((await h.run(params)).isError, false)
  assert.equal((await h.run(params)).isError, true, '同一条批准只执行一次')
  assert.deepEqual(h.calls, [path.join('real', 'x.txt')])
  assert.equal(h.approvals.operations()[0]?.target, path.join(root, 'real', 'x.txt'))
})
