/**
 * 编制席位的测试：谁上台由配置说了算，其余字段一次重启不许动。
 *
 * 用 `node --test` 跑。`TeamService` 的构造只要 ctx / store / options 三样，
 * 而 `ensureRoster` 只碰 store 的三个方法，所以拿一个记录写入的假 store 就能把它整条跑通 ——
 * 不必起 cordis，也不必落一个真的 SQLite 文件。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { ROSTER, TeamService, resolveSeats } from '../src/team.ts'
import type { MemberConfig } from '../src/team-domain.ts'

const ALL_FIVE = ['tangseng', 'wukong', 'bajie', 'shaseng', 'bailongma']
const DEFAULT_THREE = ['member-tangseng', 'member-wukong', 'member-bajie']

const FIVE_IDS = ROSTER.map((seed) => seed.assistantId)

/** 记录每一次写入的假库。`rows` 是"升级前就存在的库"，用来复现老用户的状态。 */
function fakeStore(rows: MemberConfig[] = []) {
  const table = new Map(rows.map((row) => [row.assistantId, row]))
  const writes: MemberConfig[] = []
  const store = {
    getMember: (assistantId: string) => table.get(assistantId) ?? null,
    listMembers: () => [...table.values()],
    upsertMember: (member: MemberConfig) => {
      writes.push(member)
      table.set(member.assistantId, member)
    },
  }
  return { store, writes, table }
}

function fakeLogger() {
  const warnings: string[] = []
  return { logger: { info() {}, warn: (message: string) => warnings.push(message), error() {} }, warnings }
}

function makeTeam(rows: MemberConfig[] = [], seats: readonly string[] = []) {
  const { store, writes, table } = fakeStore(rows)
  const { logger, warnings } = fakeLogger()
  const team = new TeamService({} as never, store as never, {
    teamId: 'test-team',
    provider: 'spawn',
    maxConcurrentInference: 2,
    maxConcurrentSideEffect: 1,
    taskTimeoutMs: 60_000,
    defaultBudgetTokens: 1000,
    seats,
    denyExpertTools: [],
    approvals: {} as never,
    logger,
  })
  return { team, writes, table, warnings }
}

/** 一条库里的既有成员，用来模拟"用户已经改过配置"的老库。 */
function stored(assistantId: string, patch: Partial<MemberConfig> = {}): MemberConfig {
  const seed = ROSTER.find((item) => item.assistantId === assistantId)
  assert.ok(seed, `测试自己写错了：编制里没有 ${assistantId}`)
  return {
    assistantId: seed.assistantId,
    roleId: seed.roleId,
    displayName: seed.displayName,
    skinId: seed.skinId,
    persona: seed.persona,
    voiceProfile: seed.voiceProfile,
    toolPolicy: { mode: seed.mode, denyTools: [] },
    enabled: seed.enabled,
    revision: 1,
    ...patch,
  }
}

describe('resolveSeats：配置里的名单 → 谁上台', () => {
  test('名单留空就用编制自带的默认：三人上台，两个席位空着', () => {
    const { enabled, unknown } = resolveSeats(ROSTER, [])
    assert.deepEqual([...enabled].sort(), [...DEFAULT_THREE].sort())
    assert.deepEqual(unknown, [])
  })

  test('五人名单（roleId 写法）把两个未启用席位也放上台', () => {
    const { enabled } = resolveSeats(ROSTER, ALL_FIVE)
    assert.deepEqual([...enabled].sort(), [...FIVE_IDS].sort())
  })

  test('assistantId 写法同样认：配置是人手写的，不该逼人记 member- 前缀', () => {
    const { enabled } = resolveSeats(ROSTER, ['member-shaseng', 'member-bailongma'])
    assert.deepEqual([...enabled].sort(), ['member-bailongma', 'member-shaseng'])
  })

  test('认不出的名字进 unknown，不影响名单里其他人', () => {
    const { enabled, unknown } = resolveSeats(ROSTER, ['tangseng', 'wukonng', 'bajie'])
    assert.deepEqual(unknown, ['wukonng'])
    assert.deepEqual([...enabled].sort(), ['member-bajie', 'member-tangseng'])
  })

  test('空白项与重复项被忽略：配置里多一个逗号或多写一遍不该出错', () => {
    const { enabled, unknown } = resolveSeats(ROSTER, ['  ', 'tangseng', 'tangseng', ' member-wukong '])
    assert.deepEqual([...enabled].sort(), ['member-tangseng', 'member-wukong'])
    assert.deepEqual(unknown, [])
  })

  test('名单只写一个人时，其余四个都不上台 —— 名单是权威，不是"额外加上"', () => {
    const { enabled } = resolveSeats(ROSTER, ['bajie'])
    assert.deepEqual([...enabled], ['member-bajie'])
  })
})

describe('ensureRoster：新库按配置建，老库只对齐 enabled', () => {
  test('全新库里默认只启用三人', () => {
    const { team, writes } = makeTeam()
    const members = team.ensureRoster()
    assert.equal(writes.length, 5, '五个席位都要建，未启用的也建 —— 身份稳定，只是不上台')
    assert.deepEqual(
      members.filter((member) => member.enabled).map((member) => member.assistantId).sort(),
      [...DEFAULT_THREE].sort(),
    )
  })

  test('配了五人名单，新库里五个人都上台', () => {
    const { team } = makeTeam([], ALL_FIVE)
    assert.equal(team.ensureRoster().filter((member) => member.enabled).length, 5)
  })

  test('老库改配置就能加人：只重写要改的那两个，其余一个字节都不碰', () => {
    // 升级前的库：五个人都在，但只有三个 enabled（种子默认写进去的）。
    const rows = FIVE_IDS.map((id) => stored(id))
    const { team, writes } = makeTeam(rows, ALL_FIVE)
    team.ensureRoster()
    assert.deepEqual(writes.map((member) => member.assistantId).sort(), ['member-bailongma', 'member-shaseng'])
    assert.equal(writes.every((member) => member.enabled), true)
  })

  test('用户改过的人设、形象与 revision 不会因为一次重启被种子值冲掉', () => {
    const rows = [
      stored('member-wukong', { persona: '用户自己写的人设', skinId: 'panda', revision: 7 }),
      ...['member-tangseng', 'member-bajie', 'member-shaseng', 'member-bailongma'].map((id) => stored(id)),
    ]
    const { team, writes, table } = makeTeam(rows, ALL_FIVE)
    team.ensureRoster()
    assert.equal(writes.some((member) => member.assistantId === 'member-wukong'), false, '它本来就 enabled，不该被重写')
    const wukong = table.get('member-wukong')
    assert.equal(wukong?.persona, '用户自己写的人设')
    assert.equal(wukong?.skinId, 'panda')
    assert.equal(wukong?.revision, 7, '启用/停用不是换职责，不该提升 revision')
  })

  test('名单里去掉一个人，他就从桌面上下来', () => {
    const rows = FIVE_IDS.map((id) => stored(id, { enabled: true }))
    const { team, table } = makeTeam(rows, ['tangseng', 'wukong'])
    team.ensureRoster()
    assert.equal(table.get('member-bajie')?.enabled, false)
    assert.equal(table.get('member-tangseng')?.enabled, true)
  })

  test('名单里认不出的名字会留一条 warn，而不是悄悄少一个人', () => {
    const { team, warnings } = makeTeam([], ['tangseng', 'wukonng'])
    team.ensureRoster()
    assert.equal(warnings.some((text) => text.includes('wukonng')), true)
  })

  test('名单里没有总助理时警告一声：没人拆任务与转交审批', () => {
    const { team, warnings } = makeTeam([], ['wukong', 'bajie'])
    team.ensureRoster()
    assert.equal(warnings.some((text) => text.includes('总助理')), true)
  })

  test('默认配置下总助理在台上，不该有那条警告', () => {
    const { team, warnings } = makeTeam()
    team.ensureRoster()
    assert.equal(warnings.some((text) => text.includes('总助理')), false)
  })
})
