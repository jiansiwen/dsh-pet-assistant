import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  actionsValue, parseAssistantState, parsePetConfig, petSetCommand,
} from '../src/client/pet-config.ts'

const VIEW = {
  stageVisible: false,
  characters: [{
    assistantId: 'member-tangseng', displayName: '总助理', roleId: 'tangseng',
    skin: 'nezha', randomActions: ['recite-poem'], steppedDown: false, chief: true,
  }],
  skins: [{
    id: 'panda', label: '国宝熊猫',
    actions: [{ id: 'walk', label: '走路' }, { id: 'jump', label: '蹦跳' }],
  }],
}

test('宠物配置回包：完整 JSON 原样解析', () => {
  const parsed = parsePetConfig(JSON.stringify({ ok: true, ...VIEW }))
  assert.equal(parsed.unavailable, false)
  assert.equal(parsed.stageVisible, false)
  assert.deepEqual(parsed.characters, VIEW.characters)
  assert.deepEqual(parsed.skins, VIEW.skins)
})

test('宠物配置回包：桌宠没跑 / JSON 坏了 / 缺实体都归"读不到"，但保留服务端那句话', () => {
  const offline = parsePetConfig(JSON.stringify({ ok: false, unavailable: true, message: '桌面宠物没在运行，先召唤它' }))
  assert.equal(offline.unavailable, true)
  assert.match(offline.message ?? '', /没在运行/)

  const broken = parsePetConfig('不是 JSON')
  assert.equal(broken.unavailable, true)
  assert.match(broken.message ?? '', /暂时读不到/)

  const incomplete = parsePetConfig(JSON.stringify({ ok: true, stageVisible: true, characters: [], skins: [] }))
  assert.equal(incomplete.unavailable, true, '空表不能当成"真的没有角色"画出来')
})

test('宠物配置回包：局部缺字段按默认补齐，不整份作废', () => {
  const parsed = parsePetConfig(JSON.stringify({
    ok: true,
    characters: [{ assistantId: 'member-wukong' }],
    skins: [{ id: 'panda' }],
  }))
  assert.equal(parsed.unavailable, false)
  assert.equal(parsed.stageVisible, true)
  assert.deepEqual(parsed.characters[0].displayName, 'member-wukong')
  assert.deepEqual(parsed.characters[0].skin, 'panda')
  assert.deepEqual(parsed.characters[0].randomActions, [])
  assert.deepEqual(parsed.skins[0].actions, [])
  assert.equal(parsed.skins[0].label, 'panda', '缺 label 时退回 id，显示空字符串更难查')
})

test('开关状态：读不到保持 unknown，不冒充"关闭"', () => {
  assert.deepEqual(parseAssistantState('坏的'), { injection: 'unknown', capture: 'unknown', blocked: null })
  assert.deepEqual(parseAssistantState(JSON.stringify({ injection: 'on', capture: 'recording' })),
    { injection: 'on', capture: 'recording', blocked: null })
  assert.deepEqual(parseAssistantState(JSON.stringify({ injection: 'off', capture: 'blocked', blocked: '平台不支持' })),
    { injection: 'off', capture: 'blocked', blocked: '平台不支持' })
  assert.deepEqual(parseAssistantState(JSON.stringify({ injection: 'wat' })),
    { injection: 'unknown', capture: 'unknown', blocked: null })
})

test('修改命令：四种 kind 的拼法；空动作集合用 none', () => {
  assert.equal(petSetCommand({ kind: 'skin', assistantId: 'member-tangseng', value: 'nezha' }),
    '/assistant-pet-set skin member-tangseng nezha')
  assert.equal(petSetCommand({ kind: 'actions', assistantId: 'a', value: ['walk', 'jump'] }),
    '/assistant-pet-set actions a walk,jump')
  assert.equal(petSetCommand({ kind: 'actions', assistantId: 'a', value: [] }),
    '/assistant-pet-set actions a none')
  assert.equal(petSetCommand({ kind: 'stage', value: true }), '/assistant-pet-set stage show')
  assert.equal(petSetCommand({ kind: 'stage', value: false }), '/assistant-pet-set stage hide')
  assert.equal(petSetCommand({ kind: 'step', assistantId: 'a', value: 'down' }), '/assistant-pet-set step a down')
  assert.equal(actionsValue(['walk', 'walk', 'jump']), 'walk,jump', '去重保序，重复勾选不会发两遍')
})
