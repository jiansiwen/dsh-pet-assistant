/**
 * 宠物本地设置：形象、窗口位置、多角色座位。
 * 说明：不再保存 API 密钥与模型——宠物的对话全部走主会话桥接，凭据与模型由 dsh 统一管理。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { MAX_RECENT_DIRS } from './document.ts'
import { isSafeProfileName } from './runtime-launch.ts'

export type PetId = 'panda' | 'girl-glasses' | 'boy-glasses'

const VALID_PETS: readonly PetId[] = ['panda', 'girl-glasses', 'boy-glasses']

/**
 * 布局版本。
 *
 * 1 = 多角色座位（positions 按 assistantId 存）。以后座位算法或角色数量语义变了就往上加，
 * 读取时按版本迁移。没有版本号的话，改一次布局就得猜老文件是哪种形状。
 */
export const LAYOUT_VERSION = 1

export interface PetSettings {
  pet: PetId
  voiceConversation?: boolean
  continuousVoice?: boolean
  /** 朗读回复：打开后，打字发出的消息也把回答念出来（原来只有语音发起的那一轮会念）。 */
  readReplies?: boolean
  /** 分钟，范围 1–120；缺省分别为 2 和 20。 */
  idleSleepMinutes?: number
  sleepMinutes?: number
  /** 旧单宠物时代的位置。升级后由渲染层映射到对应角色的座位，只读不写。 */
  bounds?: { x: number; y: number }
  /** 各角色当前座位，键是 assistantId。 */
  positions?: Record<string, { x: number; y: number }>
  layoutVersion?: number
  /** 启动团队运行时时用哪个 dsh profile。由托盘上"启动助理团队"的子菜单写入。 */
  runtimeProfile?: string
  /** 隐藏角色后是否仍保留托盘壳（唤醒监听 + 启动入口）。默认关，要用户明确勾上。 */
  trayResident?: boolean
  /**
   * 每个角色的形象，键是 assistantId。由右键菜单「换个形象」写入。
   *
   * 只有 `skin`：人设、语音、模型与工具权限都是职责，归插件侧的团队配置管，桌面壳不碰 ——
   * 换个皮肤不该顺带改掉谁能写文件（design.md §2.2「换形象不换身份和记忆」）。
   */
  characters?: Record<string, { skin: PetId }>
  /**
   * 允许查找并讲解文档的目录（design.md §2.10："先在授权目录和用户最近选择范围内查找"）。
   *
   * 没设过时回落到系统的"文档"目录：授权范围是空的等于这个功能一上来就没法用，而默认把
   * 整块磁盘放进来又直接违背"只在授权目录内查找"。用户可以显式存一个空数组把它全部撤掉 ——
   * 所以这里区分"字段缺失"和"字段是空数组"，不能把空数组又填回默认值。
   */
  docRoots?: string[]
  /** 最近用系统关联打开过的文档所在目录，新的在前，最多 `MAX_RECENT_DIRS` 条。 */
  docRecentDirs?: string[]
  /**
   * 下载本地模型时用的镜像前缀（例如 `https://gh-proxy.com/`），空 = 直连上游。
   *
   * 存下来而不是每次问：模型是几百 MB，国内直连 GitHub 常常超时，用户会反复下载失败。
   * 只接受 https 前缀，且落位前仍按清单 sha256 校验（见 `model-resources.ts` 的 `normalizeMirror`）——
   * 镜像只负责转发，不能因为它"看起来是自家的"就跳过校验。
   */
  modelMirror?: string
}

const DEFAULTS: PetSettings = { pet: 'panda', layoutVersion: LAYOUT_VERSION, runtimeProfile: 'web', trayResident: false }

let cache: PetSettings | null = null

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'pet-settings.json')
}

function normalize(raw: Partial<PetSettings>): PetSettings {
  const merged: PetSettings = { ...DEFAULTS, ...raw }
  if (!VALID_PETS.includes(merged.pet)) merged.pet = DEFAULTS.pet

  // profile 名会拼进 $DSH_HOME/profiles/<name>，而设置文件是用户可以直接改的。
  // 越界的值退回默认，别让一个手改的 "../../" 变成读任意目录。
  if (typeof merged.runtimeProfile !== 'string' || !isSafeProfileName(merged.runtimeProfile)) {
    merged.runtimeProfile = DEFAULTS.runtimeProfile
  }
  if (typeof merged.trayResident !== 'boolean') merged.trayResident = false
  merged.voiceConversation = merged.voiceConversation === true
  merged.continuousVoice = merged.continuousVoice === true
  merged.readReplies = merged.readReplies === true
  for (const [key, fallback] of [['idleSleepMinutes', 2], ['sleepMinutes', 20]] as const) {
    const value = merged[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 120) merged[key] = fallback
  }

  // 位置要逐个校验：分辨率变化或手工编辑过设置文件后，坐标可能落在屏幕外，
  // 那样角色会待在看不见的地方，用户只会觉得"宠物不见了"。夹紧交给渲染层做，
  // 这里只丢掉明显不是坐标的东西。
  const positions: Record<string, { x: number; y: number }> = {}
  for (const [key, value] of Object.entries(merged.positions ?? {})) {
    if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) positions[key] = { x: value.x, y: value.y }
  }
  merged.positions = positions

  // 形象同理逐个校验：皮肤名不认识就丢掉那一条。丢掉之后角色回落到插件下发的 skinId
  // 或编制默认，而不是变成一只探测不到素材的空白角色。
  const characters: Record<string, { skin: PetId }> = {}
  for (const [key, value] of Object.entries(merged.characters ?? {})) {
    if (key && value && VALID_PETS.includes(value.skin)) characters[key] = { skin: value.skin }
  }
  merged.characters = characters

  // 目录逐个校验：设置文件是用户可以直接改的，相对路径会随进程的工作目录漂移 ——
  // 那意味着同一份设置在双击启动和命令行启动下授权了不同的目录，这种事不能靠猜。
  const roots = sanitizeDirs(merged.docRoots)
  merged.docRoots = roots ?? defaultDocRoots()
  merged.docRecentDirs = (sanitizeDirs(merged.docRecentDirs) ?? []).slice(0, MAX_RECENT_DIRS)

  merged.layoutVersion = LAYOUT_VERSION
  return merged
}

/**
 * 目录列表校验。返回 null 表示"这个字段根本不存在或类型不对"，跟"存了一个空数组"是两件事：
 * 后者是用户主动把授权撤光了，填回默认值就等于撤销无效。
 */
function sanitizeDirs(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw)) return []
  const dirs: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || !path.isAbsolute(trimmed)) continue
    if (!dirs.some((dir) => dir.toLowerCase() === trimmed.toLowerCase())) dirs.push(trimmed)
  }
  return dirs
}

function defaultDocRoots(): string[] {
  try {
    return [app.getPath('documents')]
  } catch {
    // app 还没就绪之类的情况。宁可授权范围是空的（找不到文档，用户会去加目录），
    // 也不能拿一个猜出来的路径当授权。
    return []
  }
}

export function loadSettings(): PetSettings {
  if (cache) return cache
  try {
    if (existsSync(settingsPath())) {
      cache = normalize(JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<PetSettings>)
      return cache
    }
  } catch {
    // 损坏的设置回退默认值
  }
  cache = normalize({})
  return cache
}

export function saveSettings(patch: Partial<PetSettings>): PetSettings {
  const current = normalize({ ...loadSettings(), ...patch })
  mkdirSync(path.dirname(settingsPath()), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(current, null, 2), 'utf8')
  cache = current
  return current
}

const sameDir = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase()

/**
 * 文档查找的范围：授权目录加上用户最近选过的目录，去重。
 *
 * §2.10 把这两个并列写成查找范围。最近目录是被"打开成功"这件事加进来的，等于用户已经
 * 亲手指过一次那个位置，不需要再走一遍托盘上的授权流程。
 */
export function docSearchRoots(): string[] {
  const settings = loadSettings()
  const roots = [...(settings.docRoots ?? [])]
  for (const dir of settings.docRecentDirs ?? []) {
    if (!roots.some((root) => sameDir(root, dir))) roots.push(dir)
  }
  return roots
}

export function addDocRoot(dir: string): PetSettings {
  const roots = loadSettings().docRoots ?? []
  if (roots.some((root) => sameDir(root, dir))) return loadSettings()
  return saveSettings({ docRoots: [...roots, dir] })
}

export function removeDocRoot(dir: string): PetSettings {
  return saveSettings({ docRoots: (loadSettings().docRoots ?? []).filter((root) => !sameDir(root, dir)) })
}

/** 文档被系统关联打开之后记下它所在的目录，新的排前面，超出上限的丢掉。 */
export function rememberDocDir(dir: string): void {
  const kept = (loadSettings().docRecentDirs ?? []).filter((item) => !sameDir(item, dir))
  saveSettings({ docRecentDirs: [dir, ...kept].slice(0, MAX_RECENT_DIRS) })
}

/**
 * 把自动记下的最近目录忘掉。
 *
 * 最近目录也是查找范围的一部分，而它是"打开成功"这件事自己加进来的，用户没点过头。
 * 不能撤的话，授权范围里就有一块用户管不着的东西 —— 分级授权要求的是每一块都能交回去。
 */
export function forgetDocDir(dir: string): PetSettings {
  return saveSettings({ docRecentDirs: (loadSettings().docRecentDirs ?? []).filter((item) => !sameDir(item, dir)) })
}
