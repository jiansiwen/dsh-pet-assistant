/**
 * 宠物外观配置的命令层（斜杠命令 ↔ 桌宠桌面命令）。
 *
 * 工作台「宠物」tab 只通过命令通道与桌宠说话；这里负责解析 `kind 参数...` 并把回执说人话。
 * 真正的合法性裁决在桌宠主进程（它知道当前皮肤有哪些动作、哪些皮肤登记过），
 * 这一层只挡明显不成立的形状 —— 不猜、不替桌宠做白名单。
 */

export const PET_SET_USAGE =
  '用法：/assistant-pet-set skin <角色> <形象>；actions <角色> <动作,…|none>；stage show|hide；step <角色> up|down'

export type PetSettingRequest =
  | { readonly kind: 'skin'; readonly assistantId: string; readonly value: string }
  | { readonly kind: 'actions'; readonly assistantId: string; readonly value: string }
  | { readonly kind: 'stage'; readonly value: 'show' | 'hide' }
  | { readonly kind: 'step'; readonly assistantId: string; readonly value: 'up' | 'down' }

const ID = /^[A-Za-z0-9_-]{1,128}$/u
/** 动作 id 与皮肤 id 同一套字符集；逗号分隔，空串用 none 表示。 */
const ACTION_LIST = /^(?:none|无|[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*)$/u

function tokens(rawInput: string | undefined): string[] {
  const raw = (rawInput ?? '').trim()
  const rest = raw.startsWith('/') ? raw.slice(raw.indexOf(' ') + 1) : raw
  return rest.trim() === '' ? [] : rest.trim().split(/\s+/u)
}

/**
 * 解析 `/assistant-pet-set …`。
 *
 * `show/hide`、`up/down` 也认中文（显示/隐藏、上台/退下）：这两个值用户真会照着按钮文案打；
 * 角色与动作 id 只认 ASCII —— 它们是桌宠内部的稳定标识，中文别名只会让写错无处可查。
 */
export function parsePetSetting(rawInput: string | undefined): PetSettingRequest | null {
  const [kind, first, second] = tokens(rawInput)
  if (kind === undefined) return null
  if (kind === 'stage') {
    const value = (first ?? '').toLowerCase()
    if (value === 'show' || value === '显示') return { kind: 'stage', value: 'show' }
    if (value === 'hide' || value === '隐藏') return { kind: 'stage', value: 'hide' }
    return null
  }
  if (kind !== 'skin' && kind !== 'actions' && kind !== 'step') return null
  const assistantId = first ?? ''
  if (!ID.test(assistantId)) return null
  const value = second ?? ''
  if (kind === 'skin') return ID.test(value) ? { kind, assistantId, value } : null
  if (kind === 'actions') return ACTION_LIST.test(value) ? { kind, assistantId, value } : null
  const step = value.toLowerCase()
  if (step === 'up' || step === '上台') return { kind: 'step', assistantId, value: 'up' }
  if (step === 'down' || step === '退下') return { kind: 'step', assistantId, value: 'down' }
  return null
}

/** 成功回执：说清改成了什么，不重复参数原文（用户可能打的是中文别名）。 */
export function describePetSetting(request: PetSettingRequest): string {
  if (request.kind === 'stage') return request.value === 'show' ? '已显示桌面角色' : '已隐藏桌面角色（截图 / 录屏时不再出现）'
  if (request.kind === 'skin') return `已把 ${request.assistantId} 的形象改为 ${request.value}`
  if (request.kind === 'actions') {
    const none = request.value === 'none' || request.value === '无'
    return none ? `已清空 ${request.assistantId} 的随机动作` : `已更新 ${request.assistantId} 的随机动作`
  }
  return request.value === 'up' ? `已请 ${request.assistantId} 上台` : `已让 ${request.assistantId} 退下`
}
