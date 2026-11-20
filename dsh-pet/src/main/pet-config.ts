/**
 * 宠物外观配置的纯函数层：把设置、成员目录与自定义皮肤登记合成一份可读视图，
 * 并校验一次修改。主进程只负责取数、落盘与广播，规则留在这里给单测穷举。
 *
 * 为什么要单独一层：这些规则以前只长在右键菜单的回调里（`setCharacterSkin` /
 * `setCharacterRandomAction`），而 DSH 工作台也要改同样的东西。两边各写一份的结果
 * 是"从工作台换形象会保留上一套皮肤的动作勾选"这类难查的漂移。
 */
import { DEFAULT_RANDOM_ACTIONS, RANDOM_CANDIDATES, ROSTER, type CharacterManifest } from '../renderer/character-manifest.ts'
import type { CustomSkinRecord } from './custom-skins.ts'
import type { PetSettings } from './settings.ts'

/** 内置皮肤。与右键菜单「换个形象」的清单同一份真源。 */
export const PET_SKIN_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'panda', label: '国宝熊猫' },
  { id: 'girl-glasses', label: '眼镜女生（Q版）' },
  { id: 'boy-glasses', label: '眼镜男生（Q版）' },
]

/** 动作的中文名。右键菜单与工作台共用；查不到就显示 id（自定义动作可能不在表里）。 */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  walk: '走路', jump: '蹦跳', wave: '挥手', read: '看书', play: '玩耍', write: '敲电脑',
  'laptop-in': '开电脑', 'laptop-out': '收电脑站起', think: '思考', sleep: '睡觉',
  turnaround: '转身', breathe: '呼吸待机', swagger: '插兜swagger走', 'swagger-stop': '走路收步',
  'declare-fate': '我命由我不由天', 'recite-poem': '念诗', transform: '变身',
  'look-around': '左瞧右看',
}

/** 成员目录里与外观有关的最小投影（来自插件 /companion/v1/members）。 */
export interface PetMemberProfile {
  readonly assistantId: string
  readonly displayName: string
  readonly roleId: string
  readonly skinId: string
  readonly enabled: boolean
}

export interface PetConfigActionView {
  readonly id: string
  readonly label: string
}

export interface PetConfigSkinView {
  readonly id: string
  readonly label: string
  /** 勾选候选：内置生活动作 + 该皮肤的登记动作（与右键菜单一致）。 */
  readonly actions: readonly PetConfigActionView[]
}

export interface PetConfigCharacterView {
  readonly assistantId: string
  readonly displayName: string
  readonly roleId: string
  /** 当前生效的形象（设置里存过的优先）。 */
  readonly skin: string
  /** 随机动作勾选；没存过时是默认集合。 */
  readonly randomActions: readonly string[]
  readonly steppedDown: boolean
  /** 总助理常驻舞台，不能退下。 */
  readonly chief: boolean
}

export interface PetConfigView {
  readonly stageVisible: boolean
  readonly characters: readonly PetConfigCharacterView[]
  readonly skins: readonly PetConfigSkinView[]
}

function isChief(member: { assistantId: string; roleId: string }): boolean {
  return member.roleId === 'tangseng' || member.assistantId === 'member-tangseng'
}

/** 某个皮肤下可勾选的动作：内置候选 + 该自定义皮肤登记的动作（去重保序）。 */
export function candidateActions(skin: string, customSkins: readonly CustomSkinRecord[]): string[] {
  const extra = customSkins.find(item => item.id === skin)?.actions ?? []
  return [...new Set([...RANDOM_CANDIDATES, ...extra])]
}

function knownSkinIds(customSkins: readonly CustomSkinRecord[]): Set<string> {
  return new Set([...PET_SKIN_OPTIONS.map(option => option.id), ...customSkins.map(skin => skin.id)])
}

/**
 * 把成员目录、设置和皮肤登记合成一份视图。
 *
 * `members` 可能为空（桥接暂时读不到）：这时退回仓库内置的五个角色编制，
 * 保证工作台仍能显示与改设置，而不是整块变成"读不到"。名字以插件目录为准，
 * 目录没有的才用编制里的占位名。
 */
export function buildPetConfigView(input: {
  stageVisible: boolean
  members: readonly PetMemberProfile[]
  settings: Pick<PetSettings, 'characters' | 'stepDownMembers'>
  customSkins: readonly CustomSkinRecord[]
  roster?: readonly CharacterManifest[]
}): PetConfigView {
  const customSkins = input.customSkins
  const skins: PetConfigSkinView[] = [
    ...PET_SKIN_OPTIONS.map(option => ({
      id: option.id,
      label: option.label,
      actions: candidateActions(option.id, customSkins).map(id => ({ id, label: ACTION_LABELS[id] ?? id })),
    })),
    ...customSkins.map(skin => ({
      id: skin.id,
      label: skin.name,
      actions: candidateActions(skin.id, customSkins).map(id => ({ id, label: ACTION_LABELS[id] ?? id })),
    })),
  ]
  const allowedSkins = knownSkinIds(customSkins)
  const stored = input.settings.characters ?? {}
  const stepDown = input.settings.stepDownMembers ?? []

  const roster = input.roster ?? ROSTER
  const byId = new Map<string, { assistantId: string; displayName: string; roleId: string; skinId: string }>()
  // 先铺编制，再用目录覆盖名字与形象默认值：目录是运行时的权威，编制只补缺失的。
  for (const character of roster) {
    byId.set(character.assistantId, {
      assistantId: character.assistantId,
      displayName: character.displayName,
      roleId: character.roleId,
      skinId: character.skin,
    })
  }
  for (const member of input.members) {
    const previous = byId.get(member.assistantId)
    byId.set(member.assistantId, {
      assistantId: member.assistantId,
      displayName: member.displayName.trim() !== '' ? member.displayName : previous?.displayName ?? member.assistantId,
      roleId: member.roleId || previous?.roleId || '',
      skinId: member.skinId || previous?.skinId || 'panda',
    })
  }
  // 设置里出现、编制与目录都没有的 id（例如已卸载的成员）：仍列出来，名字退回 id，
  // 否则用户改过的形象会"消失"，没有任何地方能改回来。
  for (const assistantId of Object.keys(stored)) {
    if (byId.has(assistantId)) continue
    byId.set(assistantId, { assistantId, displayName: assistantId, roleId: '', skinId: 'panda' })
  }

  const characters = [...byId.values()]
    .map(character => {
      const saved = stored[character.assistantId]
      const skin = saved?.skin !== undefined && allowedSkins.has(saved.skin)
        ? saved.skin
        : allowedSkins.has(character.skinId) ? character.skinId : 'panda'
      const candidates = new Set(candidateActions(skin, customSkins))
      const savedActions = saved?.randomActions
      const randomActions = savedActions === undefined
        ? [...DEFAULT_RANDOM_ACTIONS]
        : savedActions.filter(action => candidates.has(action))
      return {
        assistantId: character.assistantId,
        displayName: character.displayName,
        roleId: character.roleId,
        skin,
        randomActions,
        steppedDown: !isChief(character) && stepDown.includes(character.assistantId),
        chief: isChief(character),
      }
    })
    // 总助理排最前，其余保持编制/目录顺序。
    .sort((a, b) => Number(b.chief) - Number(a.chief))

  return { stageVisible: input.stageVisible, characters, skins }
}

export interface PetConfigChange {
  readonly kind: 'skin' | 'actions' | 'stage' | 'step'
  readonly assistantId?: string
  readonly value?: string
}

export type PetConfigChangeResult =
  | {
    readonly ok: true
    readonly characters?: Record<string, { skin: string; randomActions?: string[] }>
    readonly stepDownMembers?: string[]
    readonly stageVisible?: boolean
    readonly note: string
  }
  | { readonly ok: false; readonly error: string }

/**
 * 校验并算出一次修改要落盘的内容。**不读不写**，只返回补丁。
 *
 * 皮肤与动作的合法性以**当前设置 + 皮肤登记**为准：动作必须属于当前皮肤的可勾选集合，
 * 换皮肤时随机集合随之重置（与右键菜单同一条规则，避免沿用上一套皮肤的动作）。
 */
export function applyPetConfigChange(
  change: PetConfigChange,
  input: {
    characters: Readonly<Record<string, { skin: string; randomActions?: string[] }>> | undefined
    customSkins: readonly CustomSkinRecord[]
    knownCharacters: readonly string[]
    stepDownMembers: readonly string[]
    stageVisible: boolean
    /**
     * 视图里每个角色当前生效的形象（设置里没存过时来自成员目录）。
     *
     * 只改随机动作时**必须**沿用它：`characters[id]` 本来可能不存在，若在这里回退成
     * 'panda'，一次勾选就会把成员自己的形象（如眼镜男生）覆盖成熊猫 —— 用户只点了动作，
     * 外观却被悄悄改了。
     */
    effectiveSkins?: Readonly<Record<string, string>>
  },
): PetConfigChangeResult {
  const characters = { ...(input.characters ?? {}) }
  if (change.kind === 'stage') {
    if (change.value !== 'show' && change.value !== 'hide') return { ok: false, error: '显示设置只能是 show 或 hide' }
    return {
      ok: true,
      stageVisible: change.value === 'show',
      note: change.value === 'show' ? '已显示桌面角色' : '已隐藏桌面角色（截图 / 录屏时不再出现）',
    }
  }
  const assistantId = change.assistantId ?? ''
  if (assistantId === '' || !input.knownCharacters.includes(assistantId)) return { ok: false, error: '不认识这个角色' }
  const current = characters[assistantId]
  // 存过的形象必须是仍登记过的；已删除的自定义皮肤退回成员目录里的形象。
  const storedSkin = current?.skin
  const skin = storedSkin !== undefined && knownSkinIds(input.customSkins).has(storedSkin)
    ? storedSkin
    : input.effectiveSkins?.[assistantId] ?? 'panda'
  if (change.kind === 'skin') {
    const next = change.value ?? ''
    if (!knownSkinIds(input.customSkins).has(next)) return { ok: false, error: '没有这个形象' }
    const customActions = input.customSkins.find(item => item.id === next)?.actions ?? []
    const randomActions = customActions.length > 0 ? [...customActions] : [...DEFAULT_RANDOM_ACTIONS]
    characters[assistantId] = { ...current, skin: next, randomActions }
    return { ok: true, characters, note: '已换好形象' }
  }
  if (change.kind === 'actions') {
    const raw = change.value ?? ''
    const none = raw === 'none' || raw === '无' || raw === ''
    const picked = none ? [] : raw.split(',').filter(item => item !== '')
    const allowed = new Set(candidateActions(skin, input.customSkins))
    if (picked.some(action => !allowed.has(action))) return { ok: false, error: '这个动作不属于当前形象' }
    characters[assistantId] = { ...current, skin, randomActions: [...new Set(picked)] }
    return { ok: true, characters, note: picked.length === 0 ? '已清空随机动作' : '已更新随机动作' }
  }
  if (change.kind === 'step') {
    if (isChief({ assistantId, roleId: '' })) return { ok: false, error: '总助理常驻舞台，不能退下' }
    const next = new Set(input.stepDownMembers)
    if (change.value === 'down') next.add(assistantId)
    else if (change.value === 'up') next.delete(assistantId)
    else return { ok: false, error: '上台设置只能是 up 或 down' }
    return { ok: true, stepDownMembers: [...next], note: change.value === 'up' ? '已请上台' : '已退下' }
  }
  return { ok: false, error: '不支持的修改' }
}
