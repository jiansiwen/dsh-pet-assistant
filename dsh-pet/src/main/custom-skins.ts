/**
 * 自定义皮肤登记：生成流水线产出的皮肤真源。
 * 设置文件与渲染层都只认这里登记过的 id，避免手改 settings 指向不存在的素材。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface CustomSkinRecord {
  id: string
  name: string
  createdAt: number
  actions: string[]
  sourceJobId: string
  license: 'generated'
}

interface RegistryFile {
  skins: CustomSkinRecord[]
}

export function customAssetsRoot(userDataDir: string): string {
  return path.join(userDataDir, 'custom-assets')
}

export function registryPath(userDataDir: string): string {
  return path.join(customAssetsRoot(userDataDir), 'custom-skins.json')
}

export function listCustomSkins(userDataDir: string): CustomSkinRecord[] {
  try {
    const raw = JSON.parse(readFileSync(registryPath(userDataDir), 'utf8')) as RegistryFile
    return Array.isArray(raw.skins) ? raw.skins.filter(isRecord) : []
  } catch {
    return []
  }
}

function isRecord(value: unknown): value is CustomSkinRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as CustomSkinRecord
  return typeof r.id === 'string' && /^[a-z0-9-]{1,64}$/.test(r.id)
    && typeof r.name === 'string' && Array.isArray(r.actions)
}

export function isCustomSkin(userDataDir: string, id: string): boolean {
  return listCustomSkins(userDataDir).some(skin => skin.id === id)
}

export function registerCustomSkin(userDataDir: string, record: CustomSkinRecord): void {
  if (!isRecord(record)) throw new Error('皮肤登记字段不合法')
  const skins = listCustomSkins(userDataDir).filter(skin => skin.id !== record.id)
  skins.push(record)
  writeRegistry(userDataDir, skins)
}

export function removeCustomSkin(userDataDir: string, id: string): void {
  const skins = listCustomSkins(userDataDir).filter(skin => skin.id !== id)
  writeRegistry(userDataDir, skins)
  const petDir = path.join(customAssetsRoot(userDataDir), 'pets')
  rmSync(path.join(petDir, `${id}.png`), { force: true })
  rmSync(path.join(petDir, 'webm', id), { recursive: true, force: true })
}

function writeRegistry(userDataDir: string, skins: CustomSkinRecord[]): void {
  mkdirSync(customAssetsRoot(userDataDir), { recursive: true })
  writeFileSync(registryPath(userDataDir), JSON.stringify({ skins }, null, 2), 'utf8')
}

/**
 * pet-asset 协议的路径解析：只允许落在给定根内。
 * 解码后仍含穿越段、绝对路径或盘符的一律拒绝——素材 URL 来自渲染层，属于不可信输入。
 */
export function resolveAssetPath(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('..') || path.isAbsolute(decoded) || /^[a-zA-Z]:/.test(decoded)) return null
  const target = path.resolve(root, decoded)
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return target
}