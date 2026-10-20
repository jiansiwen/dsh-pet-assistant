/**
 * 群体场景状态机的测试。
 *
 * 这里钉住的是计划 §2.12 的三条硬要求，而不是"动画好不好看"：
 *
 * - **工作中的角色绝不占娱乐座位**，任务一来座位在同一次步进里就放掉；
 * - **人数不足就散场重开，不强迫凑数**；
 * - **场景有预算也有冷却**，不会没完没了地占着一个常驻窗口的 CPU。
 *
 * 外加 §2.7 的一条：会议 / 屏幕共享时**禁用群体娱乐**。渲染层是用"给空编制"来表达这件事的
 * （见 TeamStage 的 sceneCast），所以它落在这里就是"人数不足"的极端情形 —— 零个人空闲。
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  BEAT_MS,
  COOLDOWN_MS,
  DEFAULT_DEPTH,
  depthToZIndex,
  freeCast,
  idleScene,
  INTERRUPTED_COOLDOWN_MS,
  isSceneOnStage,
  MIN_HEADCOUNT,
  PHASE_MS,
  sceneAction,
  sceneBeat,
  sceneFacing,
  sceneForHeadcount,
  sceneProp,
  sceneRole,
  sceneSeats,
  stepScene,
  type SceneCandidate,
  type SceneState,
} from '../src/renderer/group-scene.ts'
import { PET_WIDTH, STAGE_MARGIN } from '../src/renderer/pet-metrics.ts'

/** 编制顺序。座位号跟着它走，所以断言里可以按名字认座位。 */
const ROSTER = ['总助理', '助理1', '助理2', '助理3', '助理4'] as const

/** 造一批候选人。`busy` 里点名的角色算正在干活，不进场景。 */
function cast(count: number, busy: readonly string[] = []): SceneCandidate[] {
  return ROSTER.slice(0, count).map(name => ({ assistantId: name, working: busy.includes(name) }))
}

/** 步进到某个阶段为止，最多走 maxSteps 步。返回最后的状态。 */
function advanceTo(
  state: SceneState,
  members: readonly SceneCandidate[],
  phase: string,
  startAt: number,
): { state: SceneState; now: number } {
  let current = state
  let now = startAt
  for (let step = 0; step < 400; step += 1) {
    if (current.phase === phase && current.kind !== 'none') return { state: current, now }
    now += 100
    current = stepScene(current, members, now)
  }
  assert.fail(`走了 40 秒还没到 ${phase} 阶段，实际停在 ${current.kind}/${current.phase}`)
}

/** 一路步进到循环阶段。 */
function looping(members: readonly SceneCandidate[], startAt = 0): { state: SceneState; now: number } {
  return advanceTo(idleScene(startAt), members, 'loop', startAt)
}

describe('人数决定开哪种场景', () => {
  test('五个空闲开黑、四个空闲麻将、两三个闲聊、一个都不开', () => {
    assert.equal(sceneForHeadcount(5), 'gaming')
    assert.equal(sceneForHeadcount(4), 'mahjong')
    assert.equal(sceneForHeadcount(3), 'chat')
    assert.equal(sceneForHeadcount(2), 'chat')
    assert.equal(sceneForHeadcount(1), 'none')
    assert.equal(sceneForHeadcount(0), 'none')
  })

  test('五个人齐时优先开黑：麻将只坐四个，开麻将就会剩一个站在桌边没座位', () => {
    assert.equal(sceneForHeadcount(MIN_HEADCOUNT.gaming), 'gaming')
    assert.ok(MIN_HEADCOUNT.gaming > MIN_HEADCOUNT.mahjong)
  })

  test('编制超过五人时也只开黑：场景不承诺容纳第六个，多出来的继续过自己的日子', () => {
    assert.equal(sceneForHeadcount(7), 'gaming')
  })

  test('工作中的成员不算空闲，也不被拉来凑数', () => {
    // 五个人里三个在干活 —— 只剩两个，凑不出麻将，改成闲聊
    assert.deepEqual(freeCast(cast(5, ['总助理', '助理2', '助理4'])), ['助理1', '助理3'])
    assert.equal(sceneForHeadcount(freeCast(cast(5, ['总助理', '助理2', '助理4'])).length), 'chat')
  })

  test('全员在干活时一个场景都不开：桌面上站着五个假装打牌的角色比空着更误导', () => {
    assert.deepEqual(freeCast(cast(5, [...ROSTER])), [])
    assert.equal(sceneForHeadcount(0), 'none')
  })

  test('人数不足时切换成闲聊：麻将散了，歇一小会儿，三个人重开一场', () => {
    const { state, now } = looping(cast(4))
    assert.equal(state.kind, 'mahjong')
    let current = stepScene(state, cast(4, ['助理3']), now + 1)
    assert.equal(current.phase, 'exit', '撑不住就散场，不在演到一半时换场景种类')
    // 走完退场
    let at = now + 1
    while (current.kind !== 'none') {
      at += 500
      current = stepScene(current, cast(4, ['助理3']), at)
    }
    assert.equal(current.kind, 'none')
    // 冷却没过不开场；过了就按现在的三个人重开成闲聊
    assert.equal(stepScene(current, cast(4, ['助理3']), current.cooldownUntil - 1), current)
    const reopened = stepScene(current, cast(4, ['助理3']), current.cooldownUntil)
    assert.equal(reopened.kind, 'chat', '三个人凑不出麻将，改成闲聊 —— 这就是"切换"')
    assert.equal(reopened.phase, 'invite')
  })

  test('散场到重开之间的间隔是短冷却，不是自然收场那条长冷却', () => {
    const { state, now } = looping(cast(4))
    const exiting = stepScene(state, cast(4, ['助理3']), now + 1)
    assert.equal(exiting.cooldownUntil - (now + 1), PHASE_MS.exit + INTERRUPTED_COOLDOWN_MS)
    assert.ok(exiting.cooldownUntil - (now + 1) < PHASE_MS.exit + COOLDOWN_MS)
  })
})

describe('场景推进：邀请 → 占位 → 入场 → 循环 → 退场', () => {
  test('一开始没有场景，也不需要冷却，第一次步进就能开邀请', () => {
    const initial = idleScene(0)
    assert.equal(initial.kind, 'none')
    assert.equal(isSceneOnStage(initial), false)
    const next = stepScene(initial, cast(4), 0)
    assert.equal(next.kind, 'mahjong')
    assert.equal(next.phase, 'invite')
  })

  test('邀请阶段先不占位：提议要有一个看得见的瞬间，座位是下一步才排的', () => {
    const invite = stepScene(idleScene(0), cast(4), 0)
    assert.deepEqual(invite.seated, [])
    assert.equal(isSceneOnStage(invite), false)
  })

  test('提议者是编制里第一个空闲的角色，不是随便挑的', () => {
    // 总助理在干活，所以提议的是助理1 —— 按编制顺序，不是按数组下标补位
    const invite = stepScene(idleScene(0), cast(4, ['总助理']), 0)
    assert.equal(invite.proposer, '助理1')
    assert.equal(invite.kind, 'chat')
  })

  test('阶段按时长推进，没到点就一动不动', () => {
    const members = cast(4)
    const invite = stepScene(idleScene(0), members, 0)
    assert.equal(stepScene(invite, members, PHASE_MS.invite - 1), invite, '差一毫秒也不该推进')
    const reserve = stepScene(invite, members, PHASE_MS.invite)
    assert.equal(reserve.phase, 'reserve')
    assert.equal(reserve.kind, 'mahjong', '推进阶段不该顺手换场景')
  })

  test('占位时把全部空闲成员按编制顺序排进座位表', () => {
    const members = cast(5)
    const { state } = advanceTo(idleScene(0), members, 'reserve', 0)
    assert.deepEqual(state.seated, [...ROSTER])
    assert.equal(state.kind, 'gaming')
    assert.equal(isSceneOnStage(state), true)
  })

  test('一场自然演完的全周期：五个阶段依次走完，最后回到没有场景', () => {
    const members = cast(4)
    let now = 0
    let state = idleScene(now)
    const seen: string[] = []
    let settled = false
    for (let step = 0; step < 2000 && !settled; step += 1) {
      const next = stepScene(state, members, now)
      if (next.kind === 'none' && state.kind !== 'none') settled = true
      else if (next.kind !== 'none' && seen[seen.length - 1] !== next.phase) seen.push(next.phase)
      state = next
      now += 50
    }
    assert.ok(settled, '走了 100 秒还没散场')
    assert.deepEqual(seen, ['invite', 'reserve', 'enter', 'loop', 'exit'])
    assert.equal(state.kind, 'none')
    assert.deepEqual(state.seated, [])
  })

  test('收场后进入冷却，冷却期内人再多也不开场', () => {
    const members = cast(5)
    const { state: loopState, now: loopStart } = looping(members)
    let now = loopStart
    let state = loopState
    while (state.kind !== 'none') {
      now += PHASE_MS.loop / 4
      state = stepScene(state, members, now)
    }
    const closedAt = now
    assert.ok(state.cooldownUntil > closedAt, '收场就该写好冷却时刻')
    assert.equal(stepScene(state, members, state.cooldownUntil - 1), state, '冷却没过就该原样返回')
    assert.equal(stepScene(state, members, state.cooldownUntil).kind, 'gaming', '冷却一过就该能重开')
  })

  test('自然收场的冷却比被打断的长得多：散场休息一阵，被打断则尽快换个场景接上', () => {
    assert.ok(COOLDOWN_MS > INTERRUPTED_COOLDOWN_MS * 3)
  })

  test('循环有预算，演满就收场 —— 不会让一个常驻窗口没完没了地演戏', () => {
    assert.ok(PHASE_MS.loop < COOLDOWN_MS, '演戏的时间必须少于休息时间，否则桌面一直在演')
    const members = cast(4)
    const { state, now } = looping(members)
    assert.equal(stepScene(state, members, now + PHASE_MS.loop - 1).phase, 'loop')
    assert.equal(stepScene(state, members, now + PHASE_MS.loop).phase, 'exit')
  })
})

describe('中断：任务一来，座位在同一次步进里就放掉', () => {
  test('循环中有人接到任务，立刻从座位表消失，不等退场动画演完', () => {
    const { state, now } = looping(cast(4))
    assert.deepEqual(state.seated, ['总助理', '助理1', '助理2', '助理3'])
    // 助理3接了任务。这一步就得把它放掉 —— 动画延迟不能阻塞真实任务启动
    const next = stepScene(state, cast(4, ['助理3']), now + 1)
    assert.ok(!next.seated.includes('助理3'), '接了任务的角色必须在同一次步进里离开座位')
    assert.equal(next.phase, 'exit', '剩下三个撑不起麻将，这一场就地散掉')
    assert.equal(next.kind, 'mahjong', '散场途中还是这一场，别在中途换个种类穿帮')
  })

  test('五个人开黑时走掉一个：散场，短冷却之后剩下四个重开一局麻将', () => {
    const { state, now } = looping(cast(5))
    assert.equal(state.kind, 'gaming')
    let current = stepScene(state, cast(5, ['助理4']), now + 1)
    // 四个人本来够开麻将，但那是"重开一场"，不是"接着演"：占位之后不原地换场景种类。
    assert.equal(current.phase, 'exit')
    assert.deepEqual(current.seated, ['总助理', '助理1', '助理2', '助理3'])
    let at = now + 1
    while (current.kind !== 'none') {
      at += 500
      current = stepScene(current, cast(5, ['助理4']), at)
    }
    assert.equal(stepScene(current, cast(5, ['助理4']), current.cooldownUntil).kind, 'mahjong')
  })

  test('降到只剩一个人时散场，用的是短冷却', () => {
    const { state, now } = looping(cast(4))
    const next = stepScene(state, cast(4, ['助理1', '助理2', '助理3']), now + 1)
    assert.equal(next.phase, 'exit')
    assert.deepEqual(next.seated, ['总助理'])
    assert.equal(next.cooldownUntil, now + 1 + PHASE_MS.exit + INTERRUPTED_COOLDOWN_MS)
  })

  test('空编制（专注模式）时正在演的一场就地散掉，走退场而不是凭空消失', () => {
    const { state, now } = looping(cast(5))
    assert.equal(state.kind, 'gaming')
    const next = stepScene(state, cast(0), now + 1)
    assert.equal(next.phase, 'exit', '五个人还在桌上，得让他们站起来走掉')
    assert.deepEqual(next.seated, [])
    assert.equal(next.cooldownUntil, now + 1 + PHASE_MS.exit + INTERRUPTED_COOLDOWN_MS)
  })

  test('专注模式关掉后不立刻重开：退场走完、短冷却过完才谈得上新一场', () => {
    const { state, now } = looping(cast(5))
    const exiting = stepScene(state, cast(0), now + 1)
    // 会议结束了，五个人都空着。但退场动画还在演，此刻开场就是桌上凭空长出一张牌桌。
    const back = stepScene(exiting, cast(5), now + 2)
    assert.equal(back.phase, 'exit')
    const settled = stepScene(back, cast(5), now + 1 + PHASE_MS.exit + 1)
    assert.equal(settled.kind, 'none', '短冷却没过完，一个人都空闲也不该开场')
    const later = stepScene(settled, cast(5), now + 1 + PHASE_MS.exit + INTERRUPTED_COOLDOWN_MS + 1)
    assert.equal(later.phase, 'invite', '冷却过了就该重新张罗一场')
  })

  test('退场途中人数回升不复活这一场：让它走完，下一场自然带上回来的人', () => {
    const { state, now } = looping(cast(4))
    const exiting = stepScene(state, cast(4, ['总助理', '助理1', '助理2']), now + 1)
    assert.equal(exiting.phase, 'exit')
    const revived = stepScene(exiting, cast(4), now + 2)
    assert.equal(revived.phase, 'exit', '人回来了也不该把退场动画倒放')
    assert.deepEqual(revived.seated, ['助理3'])
  })

  test('邀请途中人不够了：直接散伙进冷却，不演退场 —— 那时还没人占位', () => {
    const invite = stepScene(idleScene(0), cast(4), 0)
    assert.equal(invite.phase, 'invite')
    const next = stepScene(invite, cast(4, ['总助理', '助理1', '助理2']), 100)
    assert.equal(next.kind, 'none')
    assert.equal(next.phase, 'exit')
    assert.deepEqual(next.seated, [])
    assert.equal(next.cooldownUntil, 100 + INTERRUPTED_COOLDOWN_MS)
  })

  test('邀请途中只降不升：多出来一个人不会把闲聊升级成麻将', () => {
    // 三个空闲 → 邀请闲聊；此时第四个空闲了
    const invite = stepScene(idleScene(0), cast(3), 0)
    assert.equal(invite.kind, 'chat')
    const upgraded = stepScene(invite, cast(4), 100)
    assert.equal(upgraded.kind, 'chat', '人数在阈值附近抖动时场景不该一直翻烙饼')
  })

  test('邀请途中丢人：还没人起身，所以重选一个更小的桌面场景，而不是散伙去散步', () => {
    const invite = stepScene(idleScene(0), cast(5), 0)
    assert.equal(invite.kind, 'gaming')
    const next = stepScene(invite, cast(5, ['助理4']), 100)
    assert.equal(next.kind, 'mahjong', '四个人正好一桌，没必要因为开不成黑就散伙')
    assert.equal(next.phase, 'invite', '还在邀请阶段，没占位就不需要退场')
    assert.equal(next.proposer, '总助理')
    assert.deepEqual(next.seated, [])
  })

  test('邀请途中丢到只剩两三个：重选成闲聊', () => {
    const invite = stepScene(idleScene(0), cast(5), 0)
    const next = stepScene(invite, cast(5, ['助理2', '助理3', '助理4']), 100)
    assert.equal(next.kind, 'chat')
    assert.equal(next.phase, 'invite')
  })

  test('成员从编制里消失（被停用）与接到任务同样立刻让出座位', () => {
    const { state, now } = looping(cast(4))
    const shrunk = cast(4).filter(member => member.assistantId !== '助理2')
    const next = stepScene(state, shrunk, now + 1)
    assert.ok(!next.seated.includes('助理2'), '不在编制里的角色不该继续占着座位')
  })
})

describe('不在场景中途加人', () => {
  test('场景进行中多出一个空闲成员，也不把它塞进座位', () => {
    const { state, now } = looping(cast(4))
    assert.deepEqual(state.seated, ['总助理', '助理1', '助理2', '助理3'])
    // 助理4本来在干活，现在干完了。这一场已经坐满了，它等下一场
    const next = stepScene(state, cast(5), now + 1)
    assert.deepEqual(next.seated, ['总助理', '助理1', '助理2', '助理3'], '中途加人等于打断它刚在演的动作')
    assert.equal(next, state, '什么都没变就该返回原对象')
  })

  test('这一场散了之后，回来的成员会被下一场带上', () => {
    const members = cast(4)
    const { state, now } = looping(members)
    let current = state
    let now2 = now
    // 助理4加入编制但这一场不加人；等这一场自然收场
    while (current.kind !== 'none') {
      now2 += PHASE_MS.loop / 4
      current = stepScene(current, cast(5), now2)
    }
    const reopened = stepScene(current, cast(5), current.cooldownUntil)
    assert.equal(reopened.kind, 'gaming')
    const seated = advanceTo(reopened, cast(5), 'reserve', reopened.phaseSince).state
    assert.deepEqual(seated.seated, [...ROSTER], '下一场就该带上刚才没座位的那个')
  })
})

describe('幂等与引用相等：渲染层靠这两条省掉重渲染', () => {
  test('同一个时刻重复步进不会把阶段连着推两级', () => {
    const members = cast(4)
    const invite = stepScene(idleScene(0), members, 0)
    const once = stepScene(invite, members, PHASE_MS.invite)
    const twice = stepScene(once, members, PHASE_MS.invite)
    assert.equal(once.phase, 'reserve')
    assert.equal(twice.phase, 'reserve', '刚推进过的阶段经过时间为 0，不该再推一级')
    assert.equal(twice, once)
  })

  test('什么都没变时返回原对象，不是每步都换一个新引用', () => {
    const members = cast(4)
    const { state, now } = looping(members)
    assert.equal(stepScene(state, members, now + 1), state)
    assert.equal(stepScene(state, members, now + BEAT_MS), state)
  })

  test('冷却期内没有场景可开时原样返回，不做无谓的对象分配', () => {
    const { state, now } = looping(cast(4))
    let current = state
    let at = now
    while (current.kind !== 'none') {
      at += PHASE_MS.loop / 4
      current = stepScene(current, cast(4), at)
    }
    assert.equal(stepScene(current, cast(4), at + 1), current)
  })
})

describe('座位几何', () => {
  const WIDE = { width: 1920, height: 1080 }
  const NARROW = { width: 1024, height: 768 }

  test('座位数等于就座人数', () => {
    const { state } = looping(cast(4))
    assert.equal(sceneSeats(state, WIDE.width, WIDE.height).length, 4)
    const five = looping(cast(5)).state
    assert.equal(sceneSeats(five, WIDE.width, WIDE.height).length, 5)
  })

  test('麻将是两排：前两个座位抬高一层，画在桌子后面；后两个在桌子前面', () => {
    const { state } = looping(cast(4))
    const seats = sceneSeats(state, WIDE.width, WIDE.height)
    assert.deepEqual(seats.map(seat => seat.depth), [0, 0, DEFAULT_DEPTH, DEFAULT_DEPTH])
    assert.ok(seats[0].y < seats[2].y, '远排必须在近排上方（屏幕上更高＝更远）')
    assert.equal(seats[0].y, seats[1].y, '同一排要在同一条线上')
    assert.equal(seats[2].y, seats[3].y)
  })

  test('桌子夹在远排与近排之间：遮挡关系是"围着一张桌子"的唯一视觉依据', () => {
    const { state } = looping(cast(4))
    const seats = sceneSeats(state, WIDE.width, WIDE.height)
    const prop = sceneProp(state, seats, WIDE.width, WIDE.height)
    assert.ok(prop, '麻将必须有桌子')
    assert.equal(prop.shape, 'table')
    assert.ok(prop.depth > seats[0].depth, '桌子要盖住远排的下半身')
    assert.ok(prop.depth < seats[2].depth, '近排要挡在桌子前面')
    // 桌子顶边落在远排身体范围内，才看得出它坐在桌子对面
    assert.ok(prop.y > seats[0].y, '桌子顶边低于远排头顶')
    assert.ok(prop.y < seats[0].y + PET_WIDTH, '桌子顶边高于远排脚底')
  })

  test('开黑是一排五个，长桌画在所有人前面', () => {
    const { state } = looping(cast(5))
    const seats = sceneSeats(state, WIDE.width, WIDE.height)
    assert.deepEqual(seats.map(seat => seat.depth), [0, 0, 0, 0, 0])
    const prop = sceneProp(state, seats, WIDE.width, WIDE.height)
    assert.equal(prop?.shape, 'desk')
    assert.ok(prop.depth > seats[0].depth)
    assert.ok(prop.width > seats[4].x - seats[0].x, '长桌要横跨整排人')
  })

  test('闲聊没有道具：两个人面对面坐着不需要桌子', () => {
    const { state } = looping(cast(2))
    assert.equal(state.kind, 'chat')
    const seats = sceneSeats(state, WIDE.width, WIDE.height)
    assert.equal(sceneProp(state, seats, WIDE.width, WIDE.height), null)
  })

  test('邀请阶段没有座位也没有道具：还没人起身，桌上不该凭空长出一张桌子', () => {
    const invite = stepScene(idleScene(0), cast(4), 0)
    assert.equal(invite.phase, 'invite')
    assert.deepEqual(sceneSeats(invite, WIDE.width, WIDE.height), [])
    assert.equal(sceneProp(invite, [], WIDE.width, WIDE.height), null)
    assert.equal(isSceneOnStage(invite), false)
  })

  test('所有座位都在可见区内，不出现负坐标', () => {
    for (const count of [2, 3, 4, 5]) {
      const { state } = looping(cast(count))
      for (const seat of sceneSeats(state, WIDE.width, WIDE.height)) {
        assert.ok(seat.x >= STAGE_MARGIN, `x=${seat.x} 越出左边距`)
        assert.ok(seat.x + PET_WIDTH <= WIDE.width - STAGE_MARGIN, `x=${seat.x} 越出右边界`)
        assert.ok(seat.y >= STAGE_MARGIN, `y=${seat.y} 越出上边距`)
        assert.ok(seat.y + PET_WIDTH <= WIDE.height - STAGE_MARGIN, `y=${seat.y} 越出下边界`)
      }
    }
  })

  test('窄屏压缩间距而不是把最后几个压到右边界叠成一摞', () => {
    const { state } = looping(cast(5))
    const seats = sceneSeats(state, NARROW.width, NARROW.height)
    const xs = seats.map(seat => seat.x)
    assert.deepEqual(xs, [...xs].sort((a, b) => a - b), '座位要从左到右排开')
    assert.ok(new Set(xs).size === xs.length, '两个座位落在同一个 x 就是叠成一摞了')
    assert.ok(xs[xs.length - 1] + PET_WIDTH <= NARROW.width - STAGE_MARGIN)
  })

  test('屏幕比一排座位还窄时等分铺满，接受重叠但不让任何人掉出屏幕', () => {
    const { state } = looping(cast(5))
    const tiny = 320
    const seats = sceneSeats(state, tiny, 480)
    for (const seat of seats) {
      assert.ok(seat.x >= STAGE_MARGIN)
      assert.ok(seat.x <= tiny - PET_WIDTH - STAGE_MARGIN, `x=${seat.x} 掉出 ${tiny}px 的屏幕了`)
    }
  })

  test('屏幕比一个角色还窄时不返回负坐标', () => {
    const { state } = looping(cast(2))
    for (const seat of sceneSeats(state, 80, 400)) {
      assert.ok(seat.x >= STAGE_MARGIN, `x=${seat.x} 是负的`)
    }
  })

  test('屏幕太矮时桌子不越出下边界', () => {
    const { state } = looping(cast(4))
    const short = 240
    const seats = sceneSeats(state, 1280, short)
    const prop = sceneProp(state, seats, 1280, short)
    assert.ok(prop)
    assert.ok(prop.y >= STAGE_MARGIN, `桌子顶边 y=${prop.y} 越出上边界`)
    assert.ok(prop.y + prop.height <= short, `桌子底边 ${prop.y + prop.height} 越出 ${short}px 的屏幕`)
  })

  test('桌子横向也在屏幕内，不会有一半画到屏幕外', () => {
    const { state } = looping(cast(5))
    const prop = sceneProp(state, sceneSeats(state, 900, 700), 900, 700)
    assert.ok(prop)
    assert.ok(prop.x >= STAGE_MARGIN)
    assert.ok(prop.x + prop.width <= 900 - STAGE_MARGIN, `桌子右边缘 ${prop.x + prop.width} 超出 900`)
  })
})

describe('表演节拍：轮到谁、谁反应', () => {
  test('不在循环阶段就没有节拍', () => {
    const members = cast(4)
    const invite = stepScene(idleScene(0), members, 0)
    assert.equal(sceneBeat(invite, 0), -1)
    const { state } = advanceTo(invite, members, 'reserve', 0)
    assert.equal(sceneBeat(state, state.phaseSince), -1, '占了位但还没进循环，不该开始出牌')
  })

  test('循环阶段轮流：每一拍换一个座位，转完一圈回到开头', () => {
    const { state, now } = looping(cast(4))
    const turns = [0, 1, 2, 3, 4, 5].map(step => sceneBeat(state, now + step * BEAT_MS))
    assert.deepEqual(turns, [0, 1, 2, 3, 0, 1])
  })

  test('麻将里轮到谁谁出牌，其余人坐着', () => {
    const { state, now } = looping(cast(4))
    const at = now + BEAT_MS // 第 1 拍，轮到 1 号位
    assert.equal(sceneAction(state, 1, at), 'play')
    assert.equal(sceneAction(state, 0, at), 'sit')
    assert.equal(sceneAction(state, 2, at), 'sit')
  })

  test('麻将的反应由出牌者的下家做，不是自己 —— 反应总在别人出牌之后', () => {
    const { state, now } = looping(cast(4))
    // 第 3 拍是反应拍（absolute % 4 === 3），轮到 3 号出牌，反应的是它下家
    const at = now + 3 * BEAT_MS
    assert.equal(sceneBeat(state, at), 3)
    assert.equal(sceneAction(state, 3, at), 'play')
    const reactors = [0, 1, 2, 3].filter(index => sceneAction(state, index, at) === 'happy')
    assert.equal(reactors.length, 1, '一次只该有一个角色有反应')
    assert.notEqual(reactors[0], 3, '出牌的人不该自己给自己叫好')
  })

  test('反应的人按轮次错开，不是永远同一个座位在叫好', () => {
    const { state, now } = looping(cast(4))
    const reactors = [0, 1, 2, 3].map(round => {
      const at = now + (round * 4 + 3) * BEAT_MS
      return [0, 1, 2, 3].find(index => sceneAction(state, index, at) === 'happy')
    })
    assert.ok(new Set(reactors).size > 1, `四轮反应全是 ${reactors[0]} 号位，太死板：${reactors.join(',')}`)
  })

  test('开黑是同时进行的：所有人一起打，定期一起庆祝', () => {
    const { state, now } = looping(cast(5))
    const playing = [0, 1, 2, 3, 4].map(index => sceneAction(state, index, now))
    assert.deepEqual(playing, ['play', 'play', 'play', 'play', 'play'], '开黑不该轮流')
    const cheerAt = now + 14 * BEAT_MS
    assert.deepEqual([0, 1, 2, 3, 4].map(index => sceneAction(state, index, cheerAt)), ['happy', 'happy', 'happy', 'happy', 'happy'])
  })

  test('开黑的庆祝只是偶尔：大部分时间在打，不能一半时间都在举手', () => {
    const { state, now } = looping(cast(5))
    let cheers = 0
    for (let beat = 0; beat < 16; beat += 1) {
      if (sceneAction(state, 0, now + beat * BEAT_MS) === 'happy') cheers += 1
    }
    assert.ok(cheers < 16 / 2, `十六拍里庆祝了 ${cheers} 拍，那不是打游戏是开联欢会`)
    assert.ok(cheers > 0, '一次都不庆祝就看不出开黑的样子')
  })

  test('闲聊两人动作错开：一个说的时候另一个听着，不同时做同一个动作', () => {
    const { state, now } = looping(cast(2))
    for (const beat of [0, 1, 2, 3]) {
      const at = now + beat * BEAT_MS
      const a = sceneAction(state, 0, at)
      const b = sceneAction(state, 1, at)
      assert.notEqual(a, b, `第 ${beat} 拍两个人都是 ${a}，看上去像复制粘贴`)
    }
  })

  test('入场与退场都在走路，占位与邀请阶段场景不干预动作', () => {
    const members = cast(4)
    const { state: entering } = advanceTo(idleScene(0), members, 'enter', 0)
    assert.equal(sceneAction(entering, 0, entering.phaseSince), 'walk')
    const { state: reserved } = advanceTo(idleScene(0), members, 'reserve', 0)
    assert.equal(sceneAction(reserved, 0, reserved.phaseSince), null, '还没起身，交给行为引擎')
    const exiting = stepScene(entering, cast(4, ['总助理', '助理1', '助理2']), entering.phaseSince + 1)
    assert.equal(exiting.phase, 'exit')
    assert.equal(sceneAction(exiting, 0, exiting.phaseSince), 'walk')
  })

  test('没有场景时不指挥任何动作，也不指挥没有座位的场景', () => {
    assert.equal(sceneAction(idleScene(0), 0, 0), null)
    const invite = stepScene(idleScene(0), cast(4), 0)
    assert.equal(sceneAction(invite, 0, 0), null, '邀请阶段还没座位，提议者的动作由 sceneRole 给')
  })

  test('只用三套皮肤都有的动作：缺素材时 resolveAction 会降级，角色不会消失', () => {
    const allowed = new Set(['idle', 'walk', 'sit', 'play', 'happy'])
    for (const count of [2, 3, 4, 5]) {
      const { state, now } = looping(cast(count))
      for (let beat = 0; beat < 20; beat += 1) {
        for (let index = 0; index < count; index += 1) {
          const action = sceneAction(state, index, now + beat * BEAT_MS)
          assert.ok(action === null || allowed.has(action), `冒出了没预料到的动作 ${action}`)
        }
      }
    }
  })
})

describe('朝向：围坐与面对面才像那么回事', () => {
  const WIDE = { width: 1920, height: 1080 }

  function facingOf(count: number, busy: readonly string[] = []): readonly (1 | -1 | null)[] {
    const { state } = looping(cast(count, busy))
    const seats = sceneSeats(state, WIDE.width, WIDE.height)
    return state.seated.map((_, index) => sceneFacing(state, index, seats))
  }

  test('闲聊两人面对面：都朝右就是一起赶路，不是聊天', () => {
    assert.deepEqual(facingOf(2), [1, -1])
  })

  test('闲聊三人：两侧朝中心，正中间那个朝观众', () => {
    assert.deepEqual(facingOf(3), [1, null, -1])
  })

  test('麻将四席都看向桌子中心 —— 远近两排各自朝里，不是左右两半各朝一边', () => {
    // 按下标猜"正中间是第几个"对四人麻将会算出 [1,1,-1,-1]：座位 1、2 距中位都是 0.5，
    // 谁都不算正中，于是同排两人同向。两个都朝右就是一起赶路，围桌的样子全没了。
    assert.deepEqual(facingOf(4), [1, -1, 1, -1])
  })

  test('开黑五人一排：正中朝观众，两侧朝里', () => {
    assert.deepEqual(facingOf(5), [1, 1, null, -1, -1])
  })

  test('邀请阶段还没有座位表，谈不上传向', () => {
    const invite = stepScene(idleScene(0), cast(4), 0)
    assert.equal(sceneFacing(invite, 0, sceneSeats(invite, WIDE.width, WIDE.height)), null)
  })

  test('没有场景、没有座位表、只剩一个人时都不管朝向', () => {
    assert.equal(sceneFacing(idleScene(0), 0, []), null)
    const one: SceneState = { ...idleScene(0), kind: 'chat', phase: 'loop', seated: ['总助理'] }
    assert.equal(sceneFacing(one, 0, sceneSeats(one, WIDE.width, WIDE.height)), null)
    assert.equal(sceneFacing(one, 3, []), null, '座位号越界不该崩，也不该瞎给一个朝向')
  })
})

describe('角色投影：场景怎么临时接管一个角色', () => {
  const WIDE = { width: 1920, height: 1080 }
  /** 角色自己的徘徊锚点。退场时它要回这儿，所以断言里得有个和座位明显不同的值。 */
  const HOME = { x: 120, y: 900 }

  function roleOf(state: SceneState, id: string, now: number, home = HOME) {
    return sceneRole(state, sceneSeats(state, WIDE.width, WIDE.height), id, home, now)
  }

  test('不在场景里的角色什么都不被接管：走位、动作、朝向全归行为引擎', () => {
    const { state, now } = looping(cast(4))
    const role = roleOf(state, '助理4', now)
    assert.equal(role.destination, null)
    assert.equal(role.action, null)
    assert.equal(role.facing, null)
    assert.equal(role.bound, false, '没被场景拴住，随机调度不该让路')
    assert.equal(role.depth, DEFAULT_DEPTH)
  })

  test('邀请阶段只有提议者被接管，其余人继续过自己的日子', () => {
    const invite = stepScene(idleScene(0), cast(4), 0)
    const proposer = roleOf(invite, '总助理', 0)
    assert.equal(proposer.proposing, true)
    assert.equal(proposer.bound, true)
    assert.equal(proposer.action, 'happy', '提议得有个看得见的动作，不然谁也不知道要开局了')
    assert.equal(proposer.destination, null, '还没占位，谁都不用挪窝')

    const other = roleOf(invite, '助理1', 0)
    assert.equal(other.proposing, false)
    assert.equal(other.bound, false)
    assert.equal(other.action, null)
  })

  test('提议用 happy 不用 wave：wave 只有 panda 有序列帧，另两套皮肤会降级成静态 idle', () => {
    // happy 也没有专属素材，但容器类名用的是降级前的动作，pet-anim.css 里
    // `.action-happy .pet-flip` 那条 pa-hop 照样生效 —— 三套皮肤都看得见"跳一下"。
    const invite = stepScene(idleScene(0), cast(4), 0)
    assert.equal(roleOf(invite, '总助理', 0).action, 'happy')
  })

  test('占位阶段还不起步，让"被点到名"有一个静止的瞬间', () => {
    const members = cast(4)
    const { state } = advanceTo(idleScene(0), members, 'reserve', 0)
    const role = roleOf(state, '总助理', state.phaseSince)
    assert.equal(role.bound, true, '座位已经占了，随机调度这时候就得让路')
    assert.equal(role.destination, null, '占了位就该先愣一下，起步是入场阶段的事')
  })

  test('入场时被领着去座位：远排比近排高，所以走位必须能指定 y', () => {
    const members = cast(4)
    const { state } = advanceTo(idleScene(0), members, 'enter', 0)
    const seats = sceneSeats(state, WIDE.width, WIDE.height)
    assert.ok(seats[0].y < seats[2].y, '远排不抬高的话看不出纵深，四个人就是一排贴纸')
    assert.deepEqual(roleOf(state, '总助理', state.phaseSince).destination, { x: seats[0].x, y: seats[0].y })
    assert.deepEqual(roleOf(state, '助理2', state.phaseSince).destination, { x: seats[2].x, y: seats[2].y })
  })

  test('退场的目的地是自己的家，不是座位：那 2.2 秒里座位已经不代表人在哪儿了', () => {
    const { state, now } = looping(cast(4))
    const exiting = stepScene(state, cast(4, ['助理3']), now + 1)
    assert.equal(exiting.phase, 'exit')
    const role = roleOf(exiting, '总助理', now + 1)
    assert.deepEqual(role.destination, HOME, '退场是走回自己的位置，不是继续坐在桌子边')
    assert.equal(role.facing, null, '朝着家的方向走，别再盯着已经收掉的桌子')
    assert.equal(role.depth, DEFAULT_DEPTH, '桌子已经收了，没必要还分层')
  })

  test('被场景拴住的角色都标出来了：行为引擎不让路的话两三秒后就把打牌改成睡觉', () => {
    const { state, now } = looping(cast(4))
    for (const id of state.seated) assert.equal(roleOf(state, id, now).bound, true, `${id} 在座位上却没被拴住`)
  })

  test('depth 翻成 z-index 后，不在场景里的角色还是 .pet-stage 原本那一层', () => {
    assert.equal(depthToZIndex(DEFAULT_DEPTH), 5, '加一层场景不该改动现有角色的层级')
    assert.ok(depthToZIndex(0) < depthToZIndex(1), '桌子要盖住远排的下半身')
    assert.ok(depthToZIndex(1) < depthToZIndex(2), '近排要挡在桌子前面')
  })

  test('退场时道具先收：人一个个走掉、桌子还摆在原地，看着像场景坏了', () => {
    const { state, now } = looping(cast(4))
    assert.ok(sceneProp(state, sceneSeats(state, WIDE.width, WIDE.height), WIDE.width, WIDE.height))
    const exiting = stepScene(state, cast(4, ['助理3']), now + 1)
    assert.equal(exiting.phase, 'exit')
    const seats = sceneSeats(exiting, WIDE.width, WIDE.height)
    assert.equal(sceneProp(exiting, seats, WIDE.width, WIDE.height), null)
  })

  test('开黑的桌子比麻将桌矮、也更靠下：它还要在桌面上沿托五块显示器，太高就盖住脸了', () => {
    const four = looping(cast(4))
    const table = sceneProp(four.state, sceneSeats(four.state, WIDE.width, WIDE.height), WIDE.width, WIDE.height)
    const five = looping(cast(5))
    const seats = sceneSeats(five.state, WIDE.width, WIDE.height)
    const desk = sceneProp(five.state, seats, WIDE.width, WIDE.height)
    assert.ok(table && desk)
    assert.equal(table.shape, 'table')
    assert.equal(desk.shape, 'desk')
    assert.ok(desk.height < table.height, `开黑桌高 ${desk.height} 没比麻将桌 ${table.height} 矮`)
    assert.ok(desk.y > table.y, `开黑桌顶边 ${desk.y} 没比麻将桌 ${table.y} 低`)

    // 显示器高 24px、压在桌面上沿里 4px（pet-anim.css 的 .scene-prop-desk::before）。
    // 这两个数字改了就同步改这里 —— 显示器盖住脸的话，用户认不出是谁在开黑。
    const screenTop = desk.y - 24 + 4
    const offset = screenTop - seats[0].y
    assert.ok(offset > PET_WIDTH * 0.25, `显示器顶边只比头顶低 ${offset}px，会盖住脸`)
    assert.ok(offset < PET_WIDTH * 0.6, `显示器顶边比头顶低了 ${offset}px，压到腿上去了`)
  })
})
