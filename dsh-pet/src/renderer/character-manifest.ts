/**
 * 角色形象与动作清单：把插件发来的成员配置翻译成桌面能安全渲染的东西。
 *
 * 这里只做三件翻译，别的数据（enabled / toolPolicy / revision）留给面板直接读快照：
 *
 * 1. **皮肤降级**。插件的 `skinId` 是自由字符串，而桌面只有三套 PNG 素材。直接把它塞给
 *    `usePetSkinImages` 会去探测 `assets/pets/<任意字符串>.png`，全部 404，角色变成空白。
 *    所以任何不认识的皮肤都落到 `panda`。
 *
 * 2. **身份色标**。占位期总助理、助理3、助理4的 skinId 都是 panda —— 三个角色渲染出三只
 *    一模一样的熊猫，光看形象分不出谁是谁。色标是这阶段的唯一区分手段。
 *    色相不是随手挑的：三个 panda 角色两两相距 89°/97°/174°，且都避开了任务状态用的
 *    语义色（红=失败、绿=完成、琥珀=待批准、蓝=进行中）和三套皮肤主色。总助理原本用金色，
 *    但金色与"待批准"的琥珀只差 5° 色相，审批卡和名牌会互相污染，所以换成了深青碧。
 *
 * 3. **动作降级**。素材是按皮肤逐动作抽帧的，缺哪个动作无法预知（当前只有 panda 有
 *    frames 目录）。缺动作时用站立/通用动作顶上，绝不让某个角色因为一张图加载失败就
 *    从舞台上消失。
 *
 * 名牌同时显示角色中文名 —— 色相只能加速辨识，不能当唯一载体（色觉障碍用户分不出
 * 293° 与 333°）。文字才是身份的权威来源。
 */

import type { PetSkin } from './PetSprite.js'

/** 桌面真实拥有的皮肤素材。三套静态图齐全，frames 目前只有 panda 有。 */
export const KNOWN_SKINS: readonly PetSkin[] = ['panda', 'girl-glasses', 'boy-glasses']

/** 皮肤素材缺失时的兜底形象：静态图三套齐全，panda 还额外有序列帧。 */
export const FALLBACK_SKIN: PetSkin = 'panda'

export interface CharacterLines {
  /** 无所事事时的自言自语。 */
  readonly idle: readonly string[]
  /** 助理正在记录/团队正在跑任务时。 */
  readonly work: readonly string[]
  /** 被用户戳了一下。 */
  readonly poke: readonly string[]
  /** 刚出现在桌面上。 */
  readonly greet: readonly string[]
  /** 切到看书/躺平/玩耍这类生活动作时。 */
  readonly activity: readonly string[]
}

export interface CharacterManifest {
  readonly assistantId: string
  readonly displayName: string
  readonly roleId: string
  /** 校验降级之后的皮肤，一定是 KNOWN_SKINS 里的值。 */
  readonly skin: PetSkin
  /** 身份色标。名牌底色。 */
  readonly markColor: string
  readonly lines: CharacterLines
}

/**
 * 五个角色的编制与色标。assistantId 与插件 `ensureRoster()` 写库的值一一对应。
 *
 * 台词按各自的性格写：总助理稳重简洁（不用一堆话替代结论）、助理1干脆机敏、
 * 助理2幽默生活化、助理3细致踏实、助理4简洁及时。
 * 助理2那几组沿用改造前单宠物的原词 —— 它本来就是那个皮肤的性格，换了编制不该换脾气。
 */
const ROSTER: readonly CharacterManifest[] = [
  {
    assistantId: 'member-tangseng',
    displayName: '总助理',
    roleId: 'tangseng',
    skin: 'panda',
    markColor: '#0F766E',
    lines: {
      idle: ['有事随时说', '我在', '先把手上的事做完'],
      work: ['我盯着进度', '已经安排下去了', '有结果我告诉你'],
      poke: ['嗯？', '怎么了', '我在听'],
      greet: ['你好', '来了'],
      activity: ['我整理一下今天的记录', '稍等，我看一眼进度'],
    },
  },
  {
    assistantId: 'member-wukong',
    displayName: '助理1',
    roleId: 'wukong',
    skin: 'boy-glasses',
    markColor: '#C026D3',
    lines: {
      idle: ['有活儿吱一声', '我先扫一眼', '这有什么难的'],
      work: ['查到了，看结论', '我去翻一遍', '马上给你答案'],
      poke: ['别闹，正忙着', '哈，手挺快', '有事说事'],
      greet: ['来了来了', '俺老孙在此'],
      activity: ['我再去核实一遍', '这处有点可疑，我看看'],
    },
  },
  {
    assistantId: 'member-bajie',
    displayName: '助理2',
    roleId: 'bajie',
    skin: 'girl-glasses',
    markColor: '#DB2777',
    lines: {
      idle: ['歇会儿呗', '该喝水了', '别太拼啦'],
      work: ['我这就去～', '交给我吧', '干完这票就吃饭'],
      poke: ['哎呀，别戳我～', '嘿嘿，你好呀！', '戳我干嘛，陪你上班呢'],
      greet: ['嗨～', '你好呀！', '看到我了吗？'],
      activity: ['我看会儿书～', '躺平休息一会儿', '等我吃完这口'],
    },
  },
  {
    assistantId: 'member-shaseng',
    displayName: '助理3',
    roleId: 'shaseng',
    skin: 'panda',
    markColor: '#4D7C0F',
    lines: {
      idle: ['我在这儿', '有需要叫我', '先把细节过一遍'],
      work: ['我逐条核对', '记下来了', '这里我再确认一次'],
      poke: ['嗯，我在', '怎么了', '别急，我看着呢'],
      greet: ['你好', '来了'],
      activity: ['我把记录整理清楚', '再检查一遍有没有漏'],
    },
  },
  {
    assistantId: 'member-bailongma',
    displayName: '助理4',
    roleId: 'bailongma',
    skin: 'panda',
    markColor: '#7E22CE',
    lines: {
      idle: ['随时可以出发', '我在待命'],
      work: ['这就去', '马上回来', '已出发'],
      poke: ['嗯？', '有事？'],
      greet: ['你好'],
      activity: ['我候着', '先走一趟'],
    },
  },
]

const BY_ASSISTANT_ID = new Map(ROSTER.map((item) => [item.assistantId, item]))

/**
 * 编制外成员的备用色标。插件以后加第六个角色时桌面不该崩，也不该和现有五人撞色。
 * 这几个色相落在 ROSTER 与语义色都没占的区间里。
 */
const SPARE_MARK_COLORS = ['#0369A1', '#A16207', '#BE185D', '#4338CA', '#166534'] as const

export function knownCharacters(): readonly CharacterManifest[] {
  return ROSTER
}

/**
 * 只在认识的皮肤里挑：不认识就返回 null，让调用方继续往下找。
 * 与 `resolveSkin` 的区别是它不兜底 —— 兜底是"没有别的信息了"才该做的事。
 */
function knownSkin(skinId: string | null | undefined): PetSkin | null {
  return skinId && (KNOWN_SKINS as readonly string[]).includes(skinId) ? (skinId as PetSkin) : null
}

/**
 * 插件发来的皮肤字符串 → 桌面真有的皮肤。
 * 不认识的一律落 FALLBACK_SKIN，因为去探测不存在的素材只会得到一屏 404。
 */
export function resolveSkin(skinId: string | null | undefined): PetSkin {
  return knownSkin(skinId) ?? FALLBACK_SKIN
}

const relativeLuminance = (hex: string): number => {
  const value = Number.parseInt(hex.slice(1), 16)
  const channel = (shift: number): number => {
    const raw = ((value >> shift) & 255) / 255
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
}

/**
 * 名牌底色上的文字该用白还是黑。
 *
 * 色标本身要够鲜艳才认得出角色，所以不能强制它都落在某个明度区间；那就反过来挑前景色。
 * 五个角色的色标配白字都在 4.6:1 以上，但这个函数仍然动态算 —— 编制外成员拿到备用色时
 * 也得保证名牌上的名字读得清。
 */
export function markForeground(markColor: string): string {
  const luminance = relativeLuminance(markColor)
  return luminance > 0.4 ? '#0A0A0C' : '#FFFFFF'
}

function hashOf(text: string): number {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  return hash
}

/**
 * 用户在本机为角色挑的形象，键是 assistantId。真源是 `settings.ts` 的 `characters`。
 *
 * 只放 `skin`：人设、语音、模型与工具权限都是**职责**，归插件侧的团队配置管（design.md §2.2），
 * 桌面壳不碰它们 —— 换个皮肤不该顺带改掉谁能写文件。
 */
export type SkinOverrides = Readonly<Record<string, { readonly skin?: string } | undefined>>

/**
 * 编制外的成员也要能上台：给一个降级皮肤、一个不撞色的备用色标、一套中性台词。
 * 插件加角色不该要求桌面同步发版，否则新角色在桌面上直接消失。
 */
function synthesize(assistantId: string, displayName: string, roleId: string, skinId: string | undefined): CharacterManifest {
  const markColor = SPARE_MARK_COLORS[hashOf(assistantId || roleId || displayName) % SPARE_MARK_COLORS.length]
  return {
    assistantId,
    displayName: displayName || roleId || assistantId || '新成员',
    roleId,
    skin: resolveSkin(skinId),
    markColor,
    lines: {
      idle: ['我在这儿', '有需要叫我'],
      work: ['我这就去办', '有结果告诉你'],
      poke: ['嗯？', '怎么了'],
      greet: ['你好'],
      activity: ['我先看看', '稍等'],
    },
  }
}

/**
 * 成员配置 → 形象清单。找不到编制内角色时合成一个，永不返回 undefined ——
 * 舞台上少一个角色比多一个陌生角色更难排查。
 *
 * 形象有三个来源，按这个顺序取第一个认识的：
 *
 * 1. **用户在本机挑的**（`overrides`）。他在这台机器上看着五个角色点的，最贴近他的意图；
 * 2. **插件下发的 `skinId`**。那是团队配置里的默认值，换台机器也跟着走；
 * 3. **编制默认**。
 *
 * 本机选择压过插件下发，是因为两者都能改而用户只看得到桌面这一个：他在插件配置里改了皮肤、
 * 又在桌面上改了一次，桌面上那次才是他最后的意思。反过来会让右键菜单看着能用、其实被远端覆盖。
 *
 * 覆盖的只有 `skin` 一个字段。名字、roleId、色标、台词全部跟着 assistantId 走 —— 这是
 * design.md §2.2 的"换形象不换身份和记忆"：总助理换成眼镜女生的样子，说话还是总助理的说话，
 * 记忆与任务归属一点不动。
 */
export function manifestFor(
  member: {
    assistantId?: string | null
    displayName?: string | null
    roleId?: string | null
    skinId?: string | null
  },
  overrides?: SkinOverrides,
): CharacterManifest {
  const assistantId = member.assistantId ?? ''
  // 本机的值只认认识的皮肤：设置文件用户可以直接改，写错了不该连插件那份合法值一起冲掉。
  const local = knownSkin(overrides?.[assistantId]?.skin)
  const known = BY_ASSISTANT_ID.get(assistantId)
  if (known) {
    const skin = local ?? resolveSkin(member.skinId ?? known.skin)
    return skin === known.skin ? known : { ...known, skin }
  }
  const stranger = synthesize(assistantId, member.displayName ?? '', member.roleId ?? '', member.skinId ?? undefined)
  return local && local !== stranger.skin ? { ...stranger, skin: local } : stranger
}

/**
 * 改造前"单宠物 + 选皮肤"的老设置映射到编制内角色。
 *
 * 三套皮肤各自对应一个本来就用它的角色，所以老用户升级后宠物的脾气不变 ——
 * 选了 girl-glasses 的人一直养的是那个会说"哎呀，别戳我～"的助理2，不该因为多了个团队
 * 编制就换成一套中性台词。settings.ts 迁移旧 pet-settings.json 时也走这条映射。
 */
const LEGACY_SKIN_ROLE: Record<PetSkin, string> = {
  'panda': 'member-tangseng',
  'boy-glasses': 'member-wukong',
  'girl-glasses': 'member-bajie',
}

export function manifestForLegacySkin(skinId: string | null | undefined): CharacterManifest {
  const skin = resolveSkin(skinId)
  return BY_ASSISTANT_ID.get(LEGACY_SKIN_ROLE[skin]) ?? ROSTER[0]
}

/**
 * 动作降级：素材里没有这个动作时，退到能确定存在的动作。
 *
 * `have` 是这套皮肤实际加载成功的动作集合。终点是 'idle'（三套皮肤的静态图都齐全）；
 * 连 idle 都没有时返回 null，交给 PetSprite 落到内联 SVG —— 那条链路本来就在。
 */
export function resolveAction(want: string | null | undefined, have: ReadonlySet<string>): string | null {
  if (want && have.has(want)) return want
  if (have.has('idle')) return 'idle'
  return have.size > 0 ? [...have][0] : null
}
