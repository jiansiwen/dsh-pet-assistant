/**
 * 自定义皮肤登记（渲染层侧）：主进程事件注入 id 与动作清单，素材加载与皮肤解析共用。
 * 零依赖独立模块：node 测试直接加载 usePetImage/character-manifest 时不会连带解析不到 .js 别名。
 */
const CUSTOM_SKINS = new Map<string, readonly string[]>()

export interface CustomSkinEntry { readonly id: string; readonly actions?: readonly string[] }

export function registerCustomSkins(skins: readonly (CustomSkinEntry | string)[]): void {
  CUSTOM_SKINS.clear()
  for (const entry of skins) {
    if (typeof entry === 'string') CUSTOM_SKINS.set(entry, [])
    else CUSTOM_SKINS.set(entry.id, entry.actions ?? [])
  }
}

export function isCustomSkinId(id: string): boolean {
  return CUSTOM_SKINS.has(id)
}

/** 该自定义皮肤产出的动作清单（含用户自定义动作），供素材探测扩展固定动作表。 */
export function customActionsFor(id: string): readonly string[] {
  return CUSTOM_SKINS.get(id) ?? []
}