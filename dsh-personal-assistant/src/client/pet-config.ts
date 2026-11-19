/**
 * 工作台「宠物」tab 的数据契约：解析桌宠配置回包、拼修改命令、解析开关状态。
 *
 * 为什么单独一个纯模块：回包是 JSON，字段可能来自旧版桌宠（缺 stageVisible、缺 actions），
 * 这层负责把"缺"与"坏"分成两种事实 —— 缺字段用默认值补齐，整份读不出来才说"读不到"。
 * 组件里直接 `JSON.parse` 会让边界错误变成白屏，而且没法用单测钉住形状。
 */

export type AssistantInjectionState = 'on' | 'off' | 'unknown'
export type AssistantCaptureState = 'recording' | 'pending' | 'blocked' | 'off' | 'unknown'

export interface AssistantStateView {
  injection: AssistantInjectionState
  capture: AssistantCaptureState
  blocked: string | null
}

export interface PetActionView {
  id: string
  label: string
}

export interface PetSkinView {
  id: string
  label: string
  actions: PetActionView[]
}

export interface PetCharacterView {
  assistantId: string
  displayName: string
  roleId: string
  skin: string
  randomActions: string[]
  steppedDown: boolean
  chief: boolean
}

/** 三种事实分开：读到了 / 没连桌宠 / 回包坏了。后两种都不能画成一张空表。 */
export interface PetConfigSnapshot {
  unavailable: boolean
  message: string | null
  stageVisible: boolean
  characters: PetCharacterView[]
  skins: PetSkinView[]
}

export const PET_CONFIG_UNAVAILABLE: PetConfigSnapshot = {
  unavailable: true,
  message: null,
  stageVisible: true,
  characters: [],
  skins: [],
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function parseActions(value: unknown): PetActionView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const action = record(item)
    if (!action || typeof action.id !== 'string' || action.id === '') return []
    return [{ id: action.id, label: typeof action.label === 'string' && action.label !== '' ? action.label : action.id }]
  })
}

function parseSkins(value: unknown): PetSkinView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const skin = record(item)
    if (!skin || typeof skin.id !== 'string' || skin.id === '') return []
    return [{
      id: skin.id,
      label: typeof skin.label === 'string' && skin.label !== '' ? skin.label : skin.id,
      actions: parseActions(skin.actions),
    }]
  })
}

function parseCharacters(value: unknown): PetCharacterView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const character = record(item)
    if (!character || typeof character.assistantId !== 'string' || character.assistantId === '') return []
    return [{
      assistantId: character.assistantId,
      displayName: typeof character.displayName === 'string' && character.displayName !== ''
        ? character.displayName
        : character.assistantId,
      roleId: typeof character.roleId === 'string' ? character.roleId : '',
      skin: typeof character.skin === 'string' && character.skin !== '' ? character.skin : 'panda',
      randomActions: stringArray(character.randomActions),
      steppedDown: character.steppedDown === true,
      chief: character.chief === true,
    }]
  })
}

/**
 * 解析 `/assistant-pet-config` 的 JSON 回包。
 *
 * - `ok !== true` 或 `unavailable === true`：桌宠没在运行 / 没回包 —— 保留服务端那句话；
 * - JSON 坏了或完全没有角色与皮肤：当成"读不到"，不画空表；
 * - 局部缺字段：按默认值补齐（旧桌宠不返回 stageVisible 时按"显示中"处理）。
 */
export function parsePetConfig(text: string): PetConfigSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ...PET_CONFIG_UNAVAILABLE, message: '暂时读不到宠物配置' }
  }
  const body = record(parsed)
  if (!body) return { ...PET_CONFIG_UNAVAILABLE, message: '暂时读不到宠物配置' }
  if (body.unavailable === true || body.ok === false) {
    return {
      ...PET_CONFIG_UNAVAILABLE,
      message: typeof body.message === 'string' && body.message !== '' ? body.message : '暂时读不到宠物配置',
    }
  }
  const characters = parseCharacters(body.characters)
  const skins = parseSkins(body.skins)
  if (characters.length === 0 || skins.length === 0) {
    return { ...PET_CONFIG_UNAVAILABLE, message: '宠物配置回包不完整，请刷新重试' }
  }
  return {
    unavailable: false,
    message: null,
    stageVisible: body.stageVisible !== false,
    characters,
    skins,
  }
}

/**
 * 解析 `/assistant-state`。
 *
 * 读不到（命令没回来 / JSON 坏了）时两项都返回 unknown —— 界面据此显示"未知"，
 * 绝不把未知说成"关着"（那会让用户以为助理已经关了）。
 */
export function parseAssistantState(text: string): AssistantStateView {
  try {
    const body = record(JSON.parse(text))
    if (!body) return { injection: 'unknown', capture: 'unknown', blocked: null }
    const injection = body.injection === 'on' || body.injection === 'off' ? body.injection : 'unknown'
    const capture = body.capture === 'recording' || body.capture === 'pending' || body.capture === 'blocked' || body.capture === 'off'
      ? body.capture
      : 'unknown'
    return {
      injection,
      capture,
      blocked: typeof body.blocked === 'string' && body.blocked !== '' ? body.blocked : null,
    }
  } catch {
    return { injection: 'unknown', capture: 'unknown', blocked: null }
  }
}

/** 动作勾选 → 命令参数。空集合用 `none`：命令行里一个空字段会被拆没。 */
export function actionsValue(actions: readonly string[]): string {
  return actions.length === 0 ? 'none' : [...new Set(actions)].join(',')
}

export function petSetCommand(
  change:
    | { kind: 'skin'; assistantId: string; value: string }
    | { kind: 'actions'; assistantId: string; value: readonly string[] }
    | { kind: 'stage'; value: boolean }
    | { kind: 'step'; assistantId: string; value: 'up' | 'down' },
): string {
  if (change.kind === 'stage') return `/assistant-pet-set stage ${change.value ? 'show' : 'hide'}`
  if (change.kind === 'actions') return `/assistant-pet-set actions ${change.assistantId} ${actionsValue(change.value)}`
  return `/assistant-pet-set ${change.kind} ${change.assistantId} ${change.value}`
}
