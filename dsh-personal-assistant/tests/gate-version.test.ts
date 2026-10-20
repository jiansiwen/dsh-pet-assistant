/**
 * 门禁路径的文件内容版本绑定（M2-06 遗留项）：写类调用的审批卡记下目标当时的内容版本，
 * 用户在批准前后改了文件，旧批准就不能套到新内容上 —— 工具体一次都不进。
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileVersion } from '../src/gate.ts'
import { hashOf } from './support/help-host.ts'
import { sideEffectHost } from './support/side-effect-host.ts'

const desktop = { channel: 'desktop-shell' } as const

test('写类审批卡绑定目标的内容版本：批准后文件被改，旧批准不放行，重新按新版本发卡', async t => {
  const f = await sideEffectHost(t)
  const { task, pending } = await f.startSideEffect()
  const target = path.join(f.workspace, 'notes.md')
  writeFileSync(target, 'v1\n')
  const params = { file_path: target, content: '助理写的内容\n' }
  const call = f.exec('write', params)
  const card = await f.pendingCard()
  assert.equal(card.baseHash, hashOf('v1\n'), '审批卡记下了目标此刻的版本')
  // 用户在批准之前改了文件；随后批准的是「把 v1 改成这样」。
  writeFileSync(target, 'v2：用户自己改的\n')
  f.approvals.issue(card.proposalId, desktop, true)
  const denied = await call
  assert.equal(denied.isError, true)
  assert.match(JSON.stringify(denied.content), /批准后已变化/)
  assert.deepEqual(f.bodies, [], '工具体一次都没进')
  assert.equal(readFileSync(target, 'utf8'), 'v2：用户自己改的\n')
  assert.equal(f.approvals.operations(task.taskId).length, 0)

  // 按新版本重新发起：新卡绑定新版本，批准后照常执行一次。
  const retry = f.exec('write', params)
  const fresh = await f.pendingCard([card.proposalId])
  assert.equal(fresh.baseHash, fileVersion(target))
  f.approvals.issue(fresh.proposalId, desktop, true)
  assert.equal((await retry).isError, false)
  assert.deepEqual(f.bodies, ['write'])
  f.finish()
  await pending
})

test('命令类调用不绑定文件版本，批准后照常执行一次', async t => {
  const f = await sideEffectHost(t)
  const { pending } = await f.startSideEffect()
  const call = f.exec('bash', { command: 'echo hi' })
  const card = await f.pendingCard()
  assert.equal(card.baseHash, null)
  f.approvals.issue(card.proposalId, desktop, true)
  assert.equal((await call).isError, false)
  f.finish()
  await pending
})
