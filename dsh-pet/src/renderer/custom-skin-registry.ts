/**
 * 自定义皮肤登记（渲染层侧）：主进程事件注入 id 集合，素材加载与皮肤解析共用。
 * 零依赖独立模块：node 测试直接加载 usePetImage/character-manifest 时不会连带解析不到 .js 别名。
 */
const CUSTOM_SKINS = new Set<string>()

export function registerCustomSkins(ids: readonly string[]): void {
  CUSTOM_SKINS.clear()
  for (const id of ids) CUSTOM_SKINS.add(id)
}

export function isCustomSkinId(id: string): boolean {
  return CUSTOM_SKINS.has(id)
}