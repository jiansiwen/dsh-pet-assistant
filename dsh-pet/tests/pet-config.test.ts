import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACTION_LABELS, applyPetConfigChange, buildPetConfigView, candidateActions, PET_SKIN_OPTIONS,
} from '../src/main/pet-config.ts'
import type { CustomSkinRecord } from '../src/main/custom-skins.ts'

const CUSTOM: CustomSkinRecord = {
  id: 'nezha', name: '哪吒', createdAt: 1,
  actions: ['recite-poem', 'transform', 'declare-fate'],
  sourceJobId: 'job-1', license: 'generated',
}

test('配置视图：成员目录优先，缺省时退回内置编制', () => {
  const withMembers = buildPetConfigView({
    stageVisible: true,
    members: [
      { assistantId: 'member-tangseng', displayName: '总助理', roleId: 'tangseng', skinId: 'panda', enabled: true },
      { assistantId: 'member-wukong', displayName: '助理1', roleId: 'wukong', skinId: 'boy-glasses', enabled: true },
    ],
    settings: { characters: {}, stepDownMembers: [] },
    customSkins: [CUSTOM],
  })
  assert.deepEqual(withMembers.characters.slice(0, 2).map(item => item.displayName), ['总助理', '助理1'], '总助理排最前，目录名字覆盖编制')
  assert.equal(withMembers.characters.length, 5, '编制里的其余角色仍列出，方便提前配置')
  assert.equal(withMembers.characters[0].chief, true)
  assert.equal(withMembers.characters[1].chief, false)
  assert.equal(withMembers.characters[1].skin, 'boy-glasses', '没有存过时用目录里的形象')

  const fallback = buildPetConfigView({
    stageVisible: false,
    members: [],
    settings: { characters: {}, stepDownMembers: [] },
    customSkins: [],
  })
  assert.equal(fallback.characters.length, 5, '读不到目录时仍显示五个编制角色')
  assert.equal(fallback.characters[0].assistantId, 'member-tangseng')
  assert.equal(fallback.stageVisible, false)
})

test('配置视图：存过的形象与动作优先；不认识的形象退回目录/默认', () => {
  const view = buildPetConfigView({
    stageVisible: true,
    members: [
      { assistantId: 'member-tangseng', displayName: '总助理', roleId: 'tangseng', skinId: 'panda', enabled: true },
      { assistantId: 'member-wukong', displayName: '助理1', roleId: 'wukong', skinId: 'boy-glasses', enabled: true },
    ],
    settings: {
      characters: {
        'member-tangseng': { skin: 'nezha', randomActions: ['recite-poem', 'mystery'] },
        'member-wukong': { skin: 'deleted-skin', randomActions: ['walk'] },
      },
      stepDownMembers: ['member-wukong'],
    },
    customSkins: [CUSTOM],
  })
  const chief = view.characters.find(item => item.assistantId === 'member-tangseng')!
  assert.equal(chief.skin, 'nezha')
  assert.deepEqual(chief.randomActions, ['recite-poem'], '当前形象没有的动作被过滤掉')
  const wukong = view.characters.find(item => item.assistantId === 'member-wukong')!
  assert.equal(wukong.skin, 'boy-glasses', '已删除的自定义皮肤退回目录里的形象')
  assert.equal(wukong.steppedDown, true)
  assert.equal(chief.steppedDown, false, '总助理不能显示为已退下')

  assert.deepEqual(view.skins.map(item => item.id), [...PET_SKIN_OPTIONS.map(item => item.id), 'nezha'])
  const nezha = view.skins.find(item => item.id === 'nezha')!
  assert.ok(nezha.actions.some(item => item.id === 'recite-poem'))
  assert.equal(nezha.actions.find(item => item.id === 'recite-poem')?.label, '念诗')
})

test('候选动作：内置生活动作 + 该皮肤登记的动作，去重保序', () => {
  assert.deepEqual(candidateActions('panda', []), ['walk', 'jump', 'wave', 'read', 'play', 'write'])
  assert.deepEqual(candidateActions('nezha', [CUSTOM]), ['walk', 'jump', 'wave', 'read', 'play', 'write', 'recite-poem', 'transform', 'declare-fate'])
  assert.equal(ACTION_LABELS['recite-poem'], '念诗')
})

test('改形象：必须是已登记皮肤；换皮后随机集合按该皮肤重置', () => {
  const base = {
    characters: { 'member-tangseng': { skin: 'panda', randomActions: ['walk', 'jump'] } },
    customSkins: [CUSTOM],
    knownCharacters: ['member-tangseng', 'member-wukong'],
    stepDownMembers: [],
    stageVisible: true,
  }
  const changed = applyPetConfigChange({ kind: 'skin', assistantId: 'member-tangseng', value: 'nezha' }, base)
  assert.equal(changed.ok, true)
  assert.equal(changed.ok && changed.characters?.['member-tangseng'].skin, 'nezha')
  assert.deepEqual(changed.ok && changed.characters?.['member-tangseng'].randomActions, ['recite-poem', 'transform', 'declare-fate'])

  const builtin = applyPetConfigChange({ kind: 'skin', assistantId: 'member-tangseng', value: 'girl-glasses' }, base)
  assert.deepEqual(builtin.ok && builtin.characters?.['member-tangseng'].randomActions, ['walk', 'jump', 'wave', 'read', 'play'])

  assert.deepEqual(applyPetConfigChange({ kind: 'skin', assistantId: 'member-tangseng', value: 'nope' }, base),
    { ok: false, error: '没有这个形象' })
  assert.deepEqual(applyPetConfigChange({ kind: 'skin', assistantId: 'stranger', value: 'panda' }, base),
    { ok: false, error: '不认识这个角色' })
})

test('改随机动作：必须属于当前形象；none 表示清空', () => {
  const base = {
    characters: { 'member-tangseng': { skin: 'nezha', randomActions: ['recite-poem'] } },
    customSkins: [CUSTOM],
    knownCharacters: ['member-tangseng'],
    stepDownMembers: [],
    stageVisible: true,
  }
  const picked = applyPetConfigChange({ kind: 'actions', assistantId: 'member-tangseng', value: 'walk,recite-poem' }, base)
  assert.deepEqual(picked.ok && picked.characters?.['member-tangseng'].randomActions, ['walk', 'recite-poem'])
  const cleared = applyPetConfigChange({ kind: 'actions', assistantId: 'member-tangseng', value: 'none' }, base)
  assert.deepEqual(cleared.ok && cleared.characters?.['member-tangseng'].randomActions, [])
  const invalid = applyPetConfigChange({ kind: 'actions', assistantId: 'member-tangseng', value: 'dance' }, base)
  assert.deepEqual(invalid, { ok: false, error: '这个动作不属于当前形象' })
})

test('改随机动作不会覆盖成员目录里的形象', () => {
  const result = applyPetConfigChange(
    { kind: 'actions', assistantId: 'member-wukong', value: 'walk' },
    {
      characters: {},
      customSkins: [],
      knownCharacters: ['member-wukong'],
      stepDownMembers: [],
      stageVisible: true,
      effectiveSkins: { 'member-wukong': 'boy-glasses' },
    },
  )
  assert.equal(result.ok && result.characters?.['member-wukong'].skin, 'boy-glasses', '用户只点动作，外观不能被悄悄改成熊猫')
  assert.deepEqual(result.ok && result.characters?.['member-wukong'].randomActions, ['walk'])
})

test('显示与上台：stage 只认 show/hide；总助理不能退下；上台退下可往返', () => {
  const base = {
    characters: {},
    customSkins: [],
    knownCharacters: ['member-tangseng', 'member-wukong', 'member-bailongma'],
    stepDownMembers: ['member-bailongma'],
    stageVisible: true,
  }
  const hidden = applyPetConfigChange({ kind: 'stage', value: 'hide' }, base)
  assert.equal(hidden.ok && hidden.stageVisible, false)
  assert.equal(applyPetConfigChange({ kind: 'stage', value: 'wat' }, base).ok, false)

  const down = applyPetConfigChange({ kind: 'step', assistantId: 'member-wukong', value: 'down' }, base)
  assert.deepEqual(down.ok && down.stepDownMembers, ['member-bailongma', 'member-wukong'])
  const up = applyPetConfigChange({ kind: 'step', assistantId: 'member-bailongma', value: 'up' }, base)
  assert.deepEqual(up.ok && up.stepDownMembers, [])
  assert.equal(applyPetConfigChange({ kind: 'step', assistantId: 'member-tangseng', value: 'down' }, base).ok, false)
  assert.equal(applyPetConfigChange({ kind: 'step', assistantId: 'stranger', value: 'up' }, base).ok, false)
})
