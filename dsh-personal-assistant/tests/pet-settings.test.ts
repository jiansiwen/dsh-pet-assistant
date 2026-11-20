import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PET_SET_USAGE, describePetSetting, parsePetSetting } from '../src/pet-settings.ts'

test('宠物设置命令：四种 kind 的合法形状', () => {
  assert.deepEqual(parsePetSetting('/assistant-pet-set skin member-tangseng nezha'),
    { kind: 'skin', assistantId: 'member-tangseng', value: 'nezha' })
  assert.deepEqual(parsePetSetting('/assistant-pet-set actions member-wukong walk,jump'),
    { kind: 'actions', assistantId: 'member-wukong', value: 'walk,jump' })
  assert.deepEqual(parsePetSetting('/assistant-pet-set actions member-wukong none'),
    { kind: 'actions', assistantId: 'member-wukong', value: 'none' })
  assert.deepEqual(parsePetSetting('/assistant-pet-set stage hide'), { kind: 'stage', value: 'hide' })
  assert.deepEqual(parsePetSetting('/assistant-pet-set stage 显示'), { kind: 'stage', value: 'show' })
  assert.deepEqual(parsePetSetting('/assistant-pet-set step member-bailongma up'),
    { kind: 'step', assistantId: 'member-bailongma', value: 'up' })
  assert.deepEqual(parsePetSetting('/assistant-pet-set step member-bailongma 退下'),
    { kind: 'step', assistantId: 'member-bailongma', value: 'down' })
})

test('宠物设置命令：缺参、怪字符、坏值一律拒绝', () => {
  assert.equal(parsePetSetting(undefined), null)
  assert.equal(parsePetSetting(''), null)
  assert.equal(parsePetSetting('/assistant-pet-set'), null)
  assert.equal(parsePetSetting('/assistant-pet-set skin'), null)
  assert.equal(parsePetSetting('/assistant-pet-set skin 角色 nezha'), null, '角色 id 只认 ASCII')
  assert.equal(parsePetSetting('/assistant-pet-set skin member-tangseng 哪吒'), null, '皮肤 id 只认 ASCII')
  assert.equal(parsePetSetting('/assistant-pet-set actions member-wukong walk,,jump'), null)
  assert.equal(parsePetSetting('/assistant-pet-set actions member-wukong walk;rm'), null)
  assert.equal(parsePetSetting('/assistant-pet-set stage maybe'), null)
  assert.equal(parsePetSetting('/assistant-pet-set step member-wukong sideways'), null)
  assert.equal(parsePetSetting('/assistant-pet-set 乱来'), null)
})

test('宠物设置回执：说清改成了什么', () => {
  assert.match(describePetSetting({ kind: 'stage', value: 'show' }), /已显示/)
  assert.match(describePetSetting({ kind: 'stage', value: 'hide' }), /已隐藏/)
  assert.match(describePetSetting({ kind: 'skin', assistantId: 'member-tangseng', value: 'nezha' }), /nezha/)
  assert.match(describePetSetting({ kind: 'actions', assistantId: 'a', value: 'none' }), /清空/)
  assert.match(describePetSetting({ kind: 'actions', assistantId: 'a', value: 'walk' }), /已更新/)
  assert.match(describePetSetting({ kind: 'step', assistantId: 'a', value: 'up' }), /上台/)
  assert.match(describePetSetting({ kind: 'step', assistantId: 'a', value: 'down' }), /退下/)
  assert.match(PET_SET_USAGE, /skin.*actions.*stage.*step/)
})
