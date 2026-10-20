/**
 * 桌面宠物（dsh-pet）目录的解析。
 *
 * 这个模块要解决的是「分享给别人后怎么用」：插件不能写死作者本机路径，
 * 也不能让用户必须先读文档才会用。解析顺序（第一个存在的目录胜出）：
 *
 * 1. 显式配置 `config.petDir`（每台机器自己的设置，最高优先级）；
 * 2. 环境变量 `DSH_PET_DIR`（脚本 / 容器场景）；
 * 3. 插件包目录同级的 `dsh-pet` —— 从同一仓库克隆的人天然满足：
 *    插件目录 `.../dsh-personal-assistant` 与 `.../dsh-pet` 是兄弟目录。
 *
 * 返回来源信息，界面可以如实说明「为什么没自动拉起」，而不是让用户对着
 * 一句「未配置」发呆。
 */
import path from 'node:path'

export type PetDirSource = 'config' | 'env' | 'sibling'

export interface PetDirResolution {
  /** 可用的桌面宠物目录；null = 没找到。 */
  readonly dir: string | null
  /** dir 的来源；dir 为 null 时给出配置/环境变量写了但不存在的那一个（没有则为 null）。 */
  readonly source: PetDirSource | null
  /** 配置或环境变量指定了路径、但目录不存在时，原样带回供提示。 */
  readonly missing?: string
}

export interface PetDirInput {
  readonly configured?: string
  readonly env?: string
  /** 插件包根目录（dist 的上一级）。 */
  readonly pluginDir: string
  /** 目录是否存在。测试可注入替身。 */
  readonly exists: (dir: string) => boolean
}

export function resolvePetDir(input: PetDirInput): PetDirResolution {
  const configured = input.configured?.trim()
  if (configured) {
    return input.exists(configured)
      ? { dir: configured, source: 'config' }
      : { dir: null, source: 'config', missing: configured }
  }
  const fromEnv = input.env?.trim()
  if (fromEnv) {
    return input.exists(fromEnv)
      ? { dir: fromEnv, source: 'env' }
      : { dir: null, source: 'env', missing: fromEnv }
  }
  const sibling = path.resolve(input.pluginDir, '..', 'dsh-pet')
  if (input.exists(sibling)) return { dir: sibling, source: 'sibling' }
  return { dir: null, source: null }
}
