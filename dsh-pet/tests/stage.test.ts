/**
 * 舞台纯逻辑层的测试：状态投影、群体排布、鼠标穿透、多屏夹取、皮肤降级、名牌对比度。
 *
 * 用 `node --test` 跑，不引第三方框架 —— 被测对象全是不认识 React 的纯函数，
 * Node 自带的断言与类型剥离就够了。这也是那些函数被拆进 `stage-layout.ts` 的原因：
 * `.tsx` 里的逻辑 Node 剥离不了。
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import {
  FALLBACK_SKIN,
  KNOWN_SKINS,
  knownCharacters,
  manifestFor,
  manifestForLegacySkin,
  markForeground,
  resolveAction,
  resolveSkin,
} from '../src/renderer/character-manifest.ts'
import { PET_WIDTH, STAGE_MARGIN, WANDER_RADIUS } from '../src/renderer/pet-metrics.ts'
import {
  actionForStatus,
  characterHitbox,
  clampToViewport,
  clearStageHitboxes,
  hitTest,
  isWorking,
  needsAttention,
  PANEL_HITBOX_KEY,
  proactiveHitboxExtra,
  PROACTIVE_BUBBLE_BOTTOM,
  projectTaskStatuses,
  registerCharacterHitbox,
  registerPanelHitbox,
  seatPositions,
  stageHitboxes,
  unregisterCharacterHitbox,
} from '../src/renderer/stage-layout.ts'
import type { TeamTaskSnapshot } from '../src/renderer/types.js'

/** 造一条任务。除 taskId 外全部可选，因为桥接给的就是这样的 JSON。 */
function task(over: Partial<TeamTaskSnapshot>): TeamTaskSnapshot {
  return { taskId: 'task', ...over }
}

describe('projectTaskStatuses：任务列表投影成每个角色的当前状态', () => {
  test('会阻塞用户的状态压过在跑的，哪怕在跑的那件更新', () => {
    const result = projectTaskStatuses([
      task({ taskId: 'a', ownerId: 'member-wukong', status: 'running', updatedAt: 900 }),
      task({ taskId: 'b', ownerId: 'member-wukong', status: 'awaiting-approval', updatedAt: 100 }),
    ])
    assert.equal(result['member-wukong'], 'awaiting-approval')
  })

  test('已取消压不过任何在办状态：被取消的任务不该让角色看起来还在忙', () => {
    const result = projectTaskStatuses([
      task({ taskId: 'c', ownerId: 'm', status: 'cancelled', updatedAt: 999 }),
      task({ taskId: 'r', ownerId: 'm', status: 'review', updatedAt: 1 }),
    ])
    assert.equal(result.m, 'review')
  })

  test('同优先级取最近更新的，与列表顺序无关', () => {
    const older = task({ taskId: 'old', ownerId: 'm', status: 'created', updatedAt: 100 })
    const newer = task({ taskId: 'new', ownerId: 'm', status: 'queued', updatedAt: 900 })
    assert.equal(projectTaskStatuses([older, newer]).m, 'queued')
    assert.equal(projectTaskStatuses([newer, older]).m, 'queued')
  })

  test('缺 ownerId 或 status 的任务跳过：半截数据不该把角色标成 unknown', () => {
    assert.deepEqual(projectTaskStatuses([task({ status: 'running' }), task({ ownerId: 'm' })]), {})
  })

  test('没有任务的成员不出现在结果里 —— 缺席即空闲', () => {
    const result = projectTaskStatuses([task({ taskId: '1', ownerId: 'a', status: 'running' })])
    assert.deepEqual(Object.keys(result), ['a'])
  })

  test('桥接没连上（undefined）与空列表都返回空对象，界面退回全员空闲', () => {
    assert.deepEqual(projectTaskStatuses(undefined), {})
    assert.deepEqual(projectTaskStatuses([]), {})
  })
})

describe('状态到动作与角标的映射', () => {
  test('在跑的写字、复核的看书、等人的招手、完成的高兴', () => {
    assert.equal(actionForStatus('running'), 'write')
    assert.equal(actionForStatus('review'), 'read')
    assert.equal(actionForStatus('awaiting-approval'), 'wave')
    assert.equal(actionForStatus('awaiting-user'), 'wave')
    assert.equal(actionForStatus('done'), 'happy')
  })

  test('认不出的状态不猜动作，交给行为引擎按生活态自己挑', () => {
    for (const status of ['created', 'queued', 'failed', 'cancelled', 'unknown', undefined] as const) {
      assert.equal(actionForStatus(status), null, String(status))
    }
  })

  test('只有终局状态才让角色松下来', () => {
    assert.equal(isWorking('done'), false)
    assert.equal(isWorking('failed'), false)
    assert.equal(isWorking('cancelled'), false)
    assert.equal(isWorking(undefined), false)
    for (const status of [
      'created',
      'queued',
      'running',
      'awaiting-approval',
      'awaiting-user',
      'review',
      'unknown',
    ] as const) {
      assert.equal(isWorking(status), true, status)
    }
  })

  test('待批准与待用户是唯一需要角标的两种', () => {
    assert.equal(needsAttention('awaiting-approval'), true)
    assert.equal(needsAttention('awaiting-user'), true)
    assert.equal(needsAttention('running'), false)
    assert.equal(needsAttention('done'), false)
    assert.equal(needsAttention(undefined), false)
  })
})

describe('seatPositions：沿屏幕底部排开一群角色', () => {
  test('没有角色就没有座位', () => {
    assert.deepEqual(seatPositions(0, 1920, 1080), [])
    assert.deepEqual(seatPositions(-1, 1920, 1080), [])
  })

  test('都站在底部同一条线上', () => {
    for (const seat of seatPositions(5, 1920, 1080)) assert.equal(seat.y, 1080 - PET_WIDTH - STAGE_MARGIN)
  })

  test('宽屏五个角色两两静态不重叠', () => {
    const seats = seatPositions(5, 1920, 1080)
    assert.equal(seats.length, 5)
    for (let index = 1; index < seats.length; index += 1) {
      const gap = seats[index].x - seats[index - 1].x
      assert.ok(gap >= PET_WIDTH, `第 ${index - 1}、${index} 个座位只差 ${gap}px，叠上了`)
    }
  })

  test('整组左右居中：座位记的是 sprite 左上角，漏算自身宽度会整体右偏半个身位', () => {
    for (const count of [1, 2, 3, 5]) {
      const seats = seatPositions(count, 1920, 1080)
      const leftGap = seats[0].x - 8
      const rightGap = 1920 - 8 - (seats[count - 1].x + PET_WIDTH)
      assert.ok(Math.abs(leftGap - rightGap) <= 1, `${count} 个角色：左留白 ${leftGap}，右留白 ${rightGap}`)
    }
  })

  test('窄屏铺满可用区间而不是把最后几个压到右边界叠成一摞', () => {
    const seats = seatPositions(5, 800, 600)
    assert.equal(seats[0].x, 8)
    assert.equal(seats[4].x, 800 - PET_WIDTH - 8)
    for (let index = 1; index < seats.length; index += 1) {
      assert.ok(seats[index].x > seats[index - 1].x, `第 ${index - 1}、${index} 个座位挤到了同一点`)
    }
    // 800px 放五个 150px 的角色，sprite 之间还该留得出缝隙。
    assert.ok(seats[1].x - seats[0].x >= PET_WIDTH, '窄屏下角色仍应互不遮挡')
  })

  test('屏幕比一个角色还窄时全部退到左边界，不出现负坐标', () => {
    for (const seat of seatPositions(3, 60, 400)) {
      assert.equal(seat.x, 8)
      assert.ok(seat.y >= 8)
    }
  })
})

describe('命中盒与鼠标穿透', () => {
  afterEach(() => clearStageHitboxes())

  test('头顶挂着提醒气泡时命中盒扩到气泡顶：点按钮不该穿透到桌面', () => {
    const bubbleHeight = 100
    const box = characterHitbox(400, 700, proactiveHitboxExtra(bubbleHeight))
    const bubbleBottomY = 700 - (PROACTIVE_BUBBLE_BOTTOM - PET_WIDTH)
    registerCharacterHitbox('member-tangseng', box)
    assert.equal(hitTest(400 + PET_WIDTH / 2, bubbleBottomY), true, '气泡底缘要可点')
    assert.equal(hitTest(400 + PET_WIDTH / 2, bubbleBottomY - bubbleHeight), true, '气泡顶缘要可点')
    assert.equal(hitTest(400 + PET_WIDTH / 2, bubbleBottomY - bubbleHeight - 20), false, '气泡之上仍应穿透')
  })

  test('气泡高度为 0 时不额外外扩：默认上扩量已覆盖气泡定位起点', () => {
    assert.equal(proactiveHitboxExtra(0), 0)
    assert.deepEqual(characterHitbox(400, 700, 0), characterHitbox(400, 700))
  })

  test('盒子外一个像素就穿透', () => {
    const box = characterHitbox(400, 700)
    registerCharacterHitbox('m', box)
    assert.equal(hitTest(box.x1 - 1, 750), false)
    assert.equal(hitTest(box.x2 + 1, 750), false)
    assert.equal(hitTest(450, box.y1 - 1), false)
    assert.equal(hitTest(450, box.y2 + 1), false)
  })

  test('空表时任何位置都穿透：桌面上没角色就该点点都落到桌面', () => {
    assert.equal(hitTest(400, 700), false)
  })

  test('角色卸载时摘掉自己的盒子，否则留一块永远点不到的区域挡着穿透', () => {
    registerCharacterHitbox('m', characterHitbox(400, 700))
    assert.equal(hitTest(420, 720), true)
    unregisterCharacterHitbox('m')
    assert.equal(hitTest(420, 720), false)
  })

  test('角色走动时盒子跟着挪：鼠标没动、角色走进来也要能点中', () => {
    registerCharacterHitbox('m', characterHitbox(400, 700))
    assert.equal(hitTest(700, 720), false)
    registerCharacterHitbox('m', characterHitbox(680, 700))
    assert.equal(hitTest(700, 720), true)
  })

  test('面板收起时传 null 摘掉盒子', () => {
    registerPanelHitbox({ x1: 10, y1: 10, x2: 200, y2: 300 })
    assert.equal(hitTest(100, 100), true)
    registerPanelHitbox(null)
    assert.equal(hitTest(100, 100), false)
    assert.equal(stageHitboxes().has(PANEL_HITBOX_KEY), false)
  })

  test('角色与面板共用一张表，穿透判断只有一个入口', () => {
    registerCharacterHitbox('m', characterHitbox(400, 700))
    registerPanelHitbox({ x1: 10, y1: 10, x2: 200, y2: 300 })
    assert.equal(stageHitboxes().size, 2)
    assert.equal(hitTest(420, 720), true)
    assert.equal(hitTest(100, 100), true)
    assert.equal(hitTest(1000, 20), false)
  })

  test('清空后不再命中：测试之间不能互相污染', () => {
    registerCharacterHitbox('m', characterHitbox(400, 700))
    clearStageHitboxes()
    assert.equal(hitTest(420, 720), false)
    assert.equal(stageHitboxes().size, 0)
  })
})

describe('clampToViewport：把存下来的座位夹回当前可见区', () => {
  test('在另一块更宽的屏上存下的坐标会夹回当前屏', () => {
    assert.deepEqual(clampToViewport({ x: 3000, y: 500 }, 1920, 1080), { x: 1920 - PET_WIDTH - 8, y: 500 })
  })

  test('负坐标夹到左上边界', () => {
    assert.deepEqual(clampToViewport({ x: -400, y: -900 }, 1920, 1080), { x: 8, y: 8 })
  })

  test('换到更矮的屏（或 DPI 放大）后贴底的角色不会掉出可见区', () => {
    assert.equal(clampToViewport({ x: 900, y: 1400 }, 1920, 800).y, 800 - PET_WIDTH - 8)
  })

  test('小数坐标取整：亚像素位置会让 sprite 发虚', () => {
    assert.deepEqual(clampToViewport({ x: 100.4, y: 200.6 }, 1920, 1080), { x: 100, y: 201 })
  })

  test('窗口比一个角色还窄时不返回负边界', () => {
    assert.deepEqual(clampToViewport({ x: 500, y: 500 }, 60, 40), { x: 8, y: 8 })
  })

  test('座位排布的结果本来就都在可见区内，夹取是恒等的', () => {
    for (const seat of seatPositions(5, 1280, 720)) {
      assert.deepEqual(clampToViewport(seat, 1280, 720), seat)
    }
  })
})

describe('徘徊半径与座位间距的关系', () => {
  test('够宽的屏上连徘徊圈都不相交，角色走动时也不会互相穿过', () => {
    const seats = seatPositions(5, 1920, 1080)
    assert.ok(seats[1].x - seats[0].x >= PET_WIDTH + 2 * WANDER_RADIUS)
  })

  test('窄屏只保证静态不重叠，接受走动时擦肩而过 —— 这是注释里写明的取舍', () => {
    const seats = seatPositions(5, 1280, 720)
    const gap = seats[1].x - seats[0].x
    assert.ok(gap >= PET_WIDTH, '静态必须不重叠')
    assert.ok(gap < PET_WIDTH + 2 * WANDER_RADIUS, '若这条不再成立，注释里的取舍就该重写')
  })
})

describe('皮肤与形象降级', () => {
  test('不认识的皮肤落到 panda，不去探测必然 404 的素材', () => {
    assert.equal(resolveSkin('dragon'), FALLBACK_SKIN)
    assert.equal(resolveSkin(''), FALLBACK_SKIN)
    assert.equal(resolveSkin(null), FALLBACK_SKIN)
    assert.equal(resolveSkin(undefined), FALLBACK_SKIN)
    for (const skin of KNOWN_SKINS) assert.equal(resolveSkin(skin), skin)
  })

  test('三套旧皮肤各自映射回本来就用它的角色：升级不该换脾气', () => {
    assert.equal(manifestForLegacySkin('panda').assistantId, 'member-tangseng')
    assert.equal(manifestForLegacySkin('boy-glasses').assistantId, 'member-wukong')
    assert.equal(manifestForLegacySkin('girl-glasses').assistantId, 'member-bajie')
    assert.equal(manifestForLegacySkin('不存在的皮肤').assistantId, 'member-tangseng')
  })

  test('编制内成员以插件发来的皮肤为准，但仍过一遍降级', () => {
    assert.equal(manifestFor({ assistantId: 'member-wukong' }).skin, 'boy-glasses')
    assert.equal(manifestFor({ assistantId: 'member-wukong', skinId: 'girl-glasses' }).skin, 'girl-glasses')
    assert.equal(manifestFor({ assistantId: 'member-wukong', skinId: 'dragon' }).skin, FALLBACK_SKIN)
  })

  test('编制内成员的色标与名字不因插件传来的皮肤而改变', () => {
    const base = manifestFor({ assistantId: 'member-bajie' })
    const reskinned = manifestFor({ assistantId: 'member-bajie', skinId: 'panda' })
    assert.equal(reskinned.markColor, base.markColor)
    assert.equal(reskinned.displayName, base.displayName)
    assert.equal(reskinned.skin, 'panda')
  })

  test('编制外成员也能上台：合成清单永不返回 undefined', () => {
    const stranger = manifestFor({
      assistantId: 'member-xiaolongnv',
      displayName: '小龙女',
      roleId: 'xiaolongnv',
      skinId: 'dragon',
    })
    assert.equal(stranger.displayName, '小龙女')
    assert.equal(stranger.roleId, 'xiaolongnv')
    assert.ok(KNOWN_SKINS.includes(stranger.skin))
    assert.match(stranger.markColor, /^#[0-9A-Fa-f]{6}$/)
    assert.ok(stranger.lines.idle.length > 0)
    assert.ok(stranger.lines.poke.length > 0)
  })

  test('备用色标不与现有五人撞色：插件加第六个角色时不该出现两块一样的名牌', () => {
    const taken = new Set(knownCharacters().map((item) => item.markColor.toUpperCase()))
    for (let index = 0; index < 60; index += 1) {
      const stranger = manifestFor({
        assistantId: `member-extra-${index}`,
        displayName: `角色${index}`,
        roleId: `extra${index}`,
      })
      assert.ok(!taken.has(stranger.markColor.toUpperCase()), `${stranger.assistantId} 撞上 ${stranger.markColor}`)
    }
  })

  test('名字缺失时依次退到 roleId、assistantId，最后才是「新成员」', () => {
    assert.equal(manifestFor({ assistantId: 'a', roleId: 'r' }).displayName, 'r')
    assert.equal(manifestFor({ assistantId: 'a' }).displayName, 'a')
    assert.equal(manifestFor({}).displayName, '新成员')
  })

  test('五个编制内角色的 assistantId 与插件 ensureRoster 写库的值一致', () => {
    assert.deepEqual(
      knownCharacters().map((item) => item.assistantId),
      ['member-tangseng', 'member-wukong', 'member-bajie', 'member-shaseng', 'member-bailongma'],
    )
  })

  test('占位期三只熊猫靠色标区分，两两色相必须拉得开', () => {
    const pandas = knownCharacters().filter((item) => item.skin === 'panda')
    assert.ok(pandas.length >= 2, '占位期应当有多个角色共用 panda 皮肤，否则色标不是必需的')
    const hues = pandas.map((item) => hueOf(item.markColor))
    for (let i = 0; i < hues.length; i += 1) {
      for (let j = i + 1; j < hues.length; j += 1) {
        assert.ok(hueGap(hues[i], hues[j]) >= 60, `${pandas[i].displayName} 与 ${pandas[j].displayName} 色相只差 ${hueGap(hues[i], hues[j]).toFixed(0)}°`)
      }
    }
  })
})

describe('本机换形象：三级优先与「换形象不换身份」', () => {
  test('用户在本机挑的形象压过插件下发的 skinId', () => {
    // 他在这台机器上看着五个角色点的，比远端配置里那个默认值更贴近他此刻的意思。
    assert.equal(
      manifestFor({ assistantId: 'member-wukong', skinId: 'girl-glasses' }, { 'member-wukong': { skin: 'panda' } }).skin,
      'panda',
    )
  })

  test('本机没挑过的角色仍按插件下发走，和没传 overrides 时一模一样', () => {
    const overrides = { 'member-bajie': { skin: 'panda' } }
    assert.equal(manifestFor({ assistantId: 'member-wukong' }, overrides).skin, 'boy-glasses')
    assert.equal(manifestFor({ assistantId: 'member-wukong' }, {}).skin, 'boy-glasses')
    assert.deepEqual(manifestFor({ assistantId: 'member-wukong' }, overrides), manifestFor({ assistantId: 'member-wukong' }))
  })

  test('本机的值是垃圾字符串时回落到插件下发的合法值，而不是被兜底成 panda', () => {
    // 设置文件用户可以直接手改。写错一个字母就该把远端那份合法配置一起冲掉的话，
    // 排查起来会指向错误的方向 —— 他会以为是插件改了他的团队。
    assert.equal(
      manifestFor({ assistantId: 'member-wukong', skinId: 'girl-glasses' }, { 'member-wukong': { skin: 'dragon' } }).skin,
      'girl-glasses',
    )
    assert.equal(manifestFor({ assistantId: 'member-wukong' }, { 'member-wukong': {} }).skin, 'boy-glasses')
  })

  test('编制外成员也能被本机换形象', () => {
    const stranger = manifestFor(
      { assistantId: 'member-xiaolongnv', displayName: '小龙女', roleId: 'xiaolongnv', skinId: 'dragon' },
      { 'member-xiaolongnv': { skin: 'girl-glasses' } },
    )
    assert.equal(stranger.skin, 'girl-glasses')
    assert.equal(stranger.displayName, '小龙女')
  })

  test('换了形象，名字、色标、roleId 与台词一律不变（design.md §2.2）', () => {
    const base = manifestFor({ assistantId: 'member-wukong' })
    const reskinned = manifestFor({ assistantId: 'member-wukong' }, { 'member-wukong': { skin: 'girl-glasses' } })
    assert.notEqual(reskinned.skin, base.skin, '这条测试的前提是形象真的换了')
    assert.equal(reskinned.skin, 'girl-glasses')
    assert.equal(reskinned.displayName, base.displayName)
    assert.equal(reskinned.roleId, base.roleId)
    assert.equal(reskinned.markColor, base.markColor, '色标是用来在几只熊猫里认人的，跟着身份走')
    assert.deepEqual(reskinned.lines, base.lines, '换个样子不该换说话方式')
  })

  test('五个角色各自挑形象互不串味', () => {
    const overrides: Record<string, { skin: string }> = {
      'member-tangseng': { skin: 'girl-glasses' },
      'member-wukong': { skin: 'girl-glasses' },
      'member-bajie': { skin: 'boy-glasses' },
      'member-shaseng': { skin: 'girl-glasses' },
      'member-bailongma': { skin: 'boy-glasses' },
    }
    const ids = Object.keys(overrides)
    const seen = new Set(ids.map((id) => manifestFor({ assistantId: id }, overrides).markColor))
    assert.equal(seen.size, ids.length, '形象可以撞，色标不能撞 —— 撞了就分不出谁是谁')
    for (const id of ids) {
      assert.equal(manifestFor({ assistantId: id }, overrides).skin, overrides[id].skin)
    }
  })
})

describe('resolveAction：素材缺动作时的降级', () => {
  test('素材里有这个动作就照用', () => {
    assert.equal(resolveAction('write', new Set(['idle', 'write'])), 'write')
  })

  test('缺动作时退到 idle', () => {
    assert.equal(resolveAction('write', new Set(['idle', 'read'])), 'idle')
  })

  test('连 idle 都没有就用手里任意一个，别让角色从舞台上消失', () => {
    assert.equal(resolveAction('write', new Set(['sit'])), 'sit')
  })

  test('一个动作都没有时返回 null，交给 PetSprite 落内联 SVG', () => {
    assert.equal(resolveAction('write', new Set()), null)
    assert.equal(resolveAction(null, new Set()), null)
  })

  test('没有指定动作时也走同一套降级', () => {
    assert.equal(resolveAction(undefined, new Set(['idle'])), 'idle')
    assert.equal(resolveAction('', new Set(['read'])), 'read')
  })
})

/**
 * WCAG 相对亮度与对比度。
 *
 * 这里独立实现一份，不复用 `character-manifest.ts` 里的同名计算 —— 用被测代码证明自己
 * 等于什么都没测。公式来自 WCAG 2.1，是外部事实。
 */
function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16)
  const channel = (shift: number): number => {
    const raw = ((value >> shift) & 255) / 255
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function hueOf(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16)
  const r = ((value >> 16) & 255) / 255
  const g = ((value >> 8) & 255) / 255
  const b = (value & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return 0
  const hue =
    max === r ? 60 * (((g - b) / delta) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4)
  return (hue + 360) % 360
}

function hueGap(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360
  return delta > 180 ? 360 - delta : delta
}

describe('名牌可读性：色标是底色，文字色由它算出来', () => {
  test('五个编制内角色的名牌文字对比都过 WCAG AA（≥4.5:1）', () => {
    for (const character of knownCharacters()) {
      const ratio = contrastRatio(markForeground(character.markColor), character.markColor)
      assert.ok(ratio >= 4.5, `${character.displayName} ${character.markColor} 只有 ${ratio.toFixed(2)}:1`)
    }
  })

  test('亮底色挑黑字、暗底色挑白字', () => {
    assert.equal(markForeground('#FFFFFF'), '#0A0A0C')
    assert.equal(markForeground('#0A0A0C'), '#FFFFFF')
  })

  test('编制外成员的备用色标同样读得清', () => {
    for (const color of ['#0369A1', '#A16207', '#BE185D', '#4338CA', '#166534']) {
      const ratio = contrastRatio(markForeground(color), color)
      assert.ok(ratio >= 4.5, `${color} 只有 ${ratio.toFixed(2)}:1`)
    }
  })
})
