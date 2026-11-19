import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSkillCommand, skillRequestBody } from '../src/skill-commands.ts'

test('技能命令解析：增删改查与证据动作', () => {
  assert.deepEqual(parseSkillCommand('/assistant-skill-set create member-a 写周报 步骤一 步骤二'),
    { kind: 'create', assistantId: 'member-a', name: '写周报', body: '步骤一 步骤二' })
  assert.deepEqual(parseSkillCommand('/assistant-skill-set edit member-a:写周报 新正文'),
    { kind: 'edit', id: 'member-a:写周报', body: '新正文' })
  assert.deepEqual(parseSkillCommand('/assistant-skill-set delete member-a:写周报'), { kind: 'delete', id: 'member-a:写周报' })
  assert.deepEqual(parseSkillCommand('/assistant-skill-set rollback member-a:写周报 2'), { kind: 'rollback', id: 'member-a:写周报', version: 2 })
  assert.deepEqual(parseSkillCommand('/assistant-skill-set verify member-a 写周报'), { kind: 'verify', assistantId: 'member-a', shape: '写周报' })
})

test('非法形状拒绝', () => {
  for (const bad of ['/assistant-skill-set', '/assistant-skill-set create', '/assistant-skill-set create member-a', '/assistant-skill-set edit id', '/assistant-skill-set rollback id 0', '/assistant-skill-set wat id']) {
    assert.equal(parseSkillCommand(bad), null, bad)
  }
})

test('请求体映射', () => {
  assert.deepEqual(skillRequestBody({ kind: 'create', assistantId: 'a', name: 'n', body: 'b' }), { action: 'create', assistantId: 'a', name: 'n', body: 'b' })
  assert.deepEqual(skillRequestBody({ kind: 'promote', id: 'x' }), { action: 'promote', id: 'x' })
  assert.deepEqual(skillRequestBody({ kind: 'rollback', id: 'x' }), { action: 'rollback', id: 'x' })
})
