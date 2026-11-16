/**
 * 宠物本地设置：形象、窗口位置、多角色座位。
 * 说明：不再保存 API 密钥与模型——宠物的对话全部走主会话桥接，凭据与模型由 dsh 统一管理。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { MAX_RECENT_DIRS, type PresentationMode } from './document.ts'
import { isCustomSkin } from './custom-skins.ts'
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
  /** 本人请求的会议录音与文档讲解是否跳过逐次原生确认。 */
  meetingDocumentAutoApprove?: boolean
  /**
   * 每条音轨的发言人数，0 = 自动。分人模型停录后按这个数聚类。
   *
   * 不能用一个"全场人数"套两条轨：线上会议常常是本机 1 人、对方多人，
   * 给麦克风轨固定 4 人会把一个人硬拆成四个。
   */
  meetingSpeakerCounts?: { mic: number; loopback: number }
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
  characters?: Record<string, { skin: string; randomActions?: string[] }>
  /** 用户手动"让TA退下"的成员 assistantId 列表；持久化，召唤/重启不自动复活，直到手动请回。 */
  stepDownMembers?: string[]
  /** 每个成员的音色（键是 assistantId）：克隆样本 > 设计描述 > 预置音色；成员编辑窗写入。 */
  memberVoices?: Record<string, { voiceId?: string; design?: string; style?: string; sampleFile?: string; sampleMime?: string; profileId?: string }>
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
  /** 会话框固定挂在头顶；auto = 按屏幕剩余空间自动选上/下/左/右。 */
  chatDock?: 'top' | 'auto'
  /** 会话框尺寸（CSS 像素），由右下角拖拽调整后保存。 */
  chatSize?: { width: number; height: number }
  /**
   * 文档讲解形态。
   *
   * - `source`（默认）：按原文念稿 —— 逐段念正文，解释与补充只在用户提问时产生。
   * - `ai`：每段先让模型写【原文+解释+补充】再念。
   *
   * 默认 source 的理由：用户要的讲解形态就是"跟真人开会一样照着稿子讲" —— 念原文最快、
   * 不跑题、不烧模型调用；AI 讲解每段都要等模型回话，更慢也更费，留作主动选择的增强模式。
   *
   * **不要与演示隐私模式的 `presentationMode` 混淆**：那个是布尔、挂在 companion 状态快照上
   * （`companion-host.ts`，渲染层据此隐藏历史与预览）；这里是讲解形态、挂在 settings 上，
   * 两个同样叫"presentation"的东西完全不同义，所以这一侧刻意叫 `docSpeechMode`。
   */
  docSpeechMode?: PresentationMode
  /**
   * 总助理自己的音色设计描述（按性格生成，可手改）。
   *
   * 音色属于"这个人怎么说"，不属于"接哪家语音服务"——所以存在这里，
   * 合成时由说话人带进 narrator.speak 的 voiceDesign，覆盖服务配置里那份。
   */
  agentVoiceDesign?: string
  /** 总助理用的克隆音色 ID；填了它就用克隆声音，优先于设计描述。 */
  agentVoiceId?: string
  /** 总助理的音色复刻样本（base64，不含 data: 前缀）；有它就用 voiceclone 模型。 */
  /** 语气/情绪/方言/角色扮演的自然语言指令。 */
  agentVoiceStyle?: string
  agentVoiceSample?: string
  agentVoiceSampleMime?: string
  /** 样本落盘路径：大样本不走内部管道，改走文件。 */
  /**
   * 讲解交给成员时是否先演一段交接（总助交棒 → 成员接棒）。
   *
   * 默认关闭：它会往播报序列里插入两句台词，属于听感改动，
   * 由用户自己打开，而不是默认替所有人改掉。
   */
  memberHandover?: boolean
  /**
   * 相邻短句是否并成一段再合成。
   *
   * 打开后"好。""嗯。"这种两三个字的句子不再各发一次请求，句间卡顿会明显减少；
   * 代价是打断粒度变粗（以合并组为单位）。默认关闭，由用户自己开。
   */
  mergeShortSentences?: boolean
  agentVoiceSampleFile?: string
  /**
   * 角色大小：0.8 / 1 / 1.2 三档，默认 1。
   *
   * 只存档位不存任意数值：缩放和命中盒、悬停工具栏的定位是同一件事，允许连续值等于允许
   * 出现一个"点不中自己"的尺寸。归一化在 `normalize()` 里做，脏数据一律退回默认。
   */
  petScale?: number
  /** 角色透明度：0.6 / 0.8 / 1 三档，默认 1。下限 0.6 —— 再低用户会找不到宠物。 */
  petOpacity?: number
  /** 拖到屏幕边缘时是否吸附并收起成停靠态。默认开。 */
  petDock?: boolean
  /**
   * 上次停靠在哪个边；null = 没停靠。
   *
   * 只存"边"不存坐标：停靠位置由那条边 + 原位置算出来（`dockPosition`），存坐标等于把
   * 同一份事实记两处，屏幕一变就打架。原位置仍在 `positions` 里，取消停靠据此回到原处。
   */
  dockedAt?: 'left' | 'right' | 'top' | 'bottom' | null
}

const DEFAULTS: PetSettings = {
  pet: 'panda',
  layoutVersion: LAYOUT_VERSION,
  runtimeProfile: 'web',
  trayResident: false,
  chatDock: 'top',
  // 讲解默认按原文念稿：真人会议优先，AI 逐段讲解要等模型、更慢也更费。
  docSpeechMode: 'source',
  // 默认原大、不透明：任何"一装上就变了样子"的默认值都会让用户以为是 bug。
  petScale: 1,
  petOpacity: 1,
  petDock: true,
  dockedAt: null,
}

let cache: PetSettings | null = null
/**
 * 缓存对应文件的修改时间。
 *
 * 以前 loadSettings 一缓存就是永远 —— 外部（另一个窗口、运维脚本、备份还原）
 * 改了 pet-settings.json，进程里还是老值，一保存又把老值写回去，等于把别人的修改吃掉。
 */
let cacheMtimeMs = 0

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'pet-settings.json')
}

function normalize(raw: Partial<PetSettings>): PetSettings {
  const merged: PetSettings = { ...DEFAULTS, ...raw }
  if (!VALID_PETS.includes(merged.pet)) merged.pet = DEFAULTS.pet
  // 音色描述：只接受字符串，超长截到 2000（与成员那边同一口径）。
  merged.agentVoiceDesign = typeof merged.agentVoiceDesign === 'string' ? merged.agentVoiceDesign.slice(0, 2000) : ''
  merged.agentVoiceId = typeof merged.agentVoiceId === 'string' ? merged.agentVoiceId.slice(0, 200) : ''
  /*
    复刻样本：只留 base64，上限 4MB 字符串（约 3MB 音频）。
    超了就丢掉 —— 存进设置会把整份配置撑爆，读写都会变慢。
  */
  merged.agentVoiceStyle = typeof merged.agentVoiceStyle === 'string' ? merged.agentVoiceStyle.slice(0, 500) : ''
  merged.agentVoiceSample = typeof merged.agentVoiceSample === 'string' ? merged.agentVoiceSample.slice(0, 4 * 1024 * 1024) : ''
  merged.agentVoiceSampleMime = typeof merged.agentVoiceSampleMime === 'string' ? merged.agentVoiceSampleMime.slice(0, 100) : ''
  merged.memberHandover = merged.memberHandover !== false
  merged.mergeShortSentences = merged.mergeShortSentences === true
  merged.agentVoiceSampleFile = typeof merged.agentVoiceSampleFile === 'string' ? merged.agentVoiceSampleFile.slice(0, 500) : ''

  // profile 名会拼进 $DSH_HOME/profiles/<name>，而设置文件是用户可以直接改的。
  // 越界的值退回默认，别让一个手改的 "../../" 变成读任意目录。
  if (typeof merged.runtimeProfile !== 'string' || !isSafeProfileName(merged.runtimeProfile)) {
    merged.runtimeProfile = DEFAULTS.runtimeProfile
  }
  if (typeof merged.trayResident !== 'boolean') merged.trayResident = false
  merged.voiceConversation = merged.voiceConversation === true
  merged.continuousVoice = merged.continuousVoice === true
  merged.readReplies = merged.readReplies === true
  merged.meetingDocumentAutoApprove = typeof raw.meetingDocumentAutoApprove === 'boolean' ? raw.meetingDocumentAutoApprove : true
  const speakerCounts = (merged.meetingSpeakerCounts ?? {}) as { mic?: unknown; loopback?: unknown }
  const validCount = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value)
    && value >= 0 && value <= 6 ? value : 0)
  merged.meetingSpeakerCounts = { mic: validCount(speakerCounts.mic), loopback: validCount(speakerCounts.loopback) }
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
  // 或编制默认，而不是变成一只探测不到素材的空白角色。自定义皮肤以登记簿为准。
  const characters: Record<string, { skin: string; randomActions?: string[] }> = {}
  for (const [key, value] of Object.entries(merged.characters ?? {})) {
    if (key && value && (VALID_PETS.includes(value.skin as PetId) || isCustomSkin(app.getPath('userData'), value.skin))) {
      const randomActions = Array.isArray((value as { randomActions?: unknown }).randomActions)
        ? [...new Set(((value as { randomActions?: unknown[] }).randomActions ?? []).filter((a): a is string => typeof a === 'string' && a !== ''))].slice(0, 16)
        : undefined
      characters[key] = { skin: value.skin, ...(randomActions ? { randomActions } : {}) }
    }
  }
  merged.characters = characters

  // 手动退下名单：只留非空字符串、去重、限量，防止手改设置塞进任意内容。
  merged.stepDownMembers = [...new Set((Array.isArray(merged.stepDownMembers) ? merged.stepDownMembers : [])
    .filter((id): id is string => typeof id === 'string' && id.trim() !== ''))].slice(0, 32)

  // 成员音色逐字段限长：设置文件用户可直接改，样本路径与描述都不能无限长。
  const memberVoices: Record<string, { voiceId?: string; design?: string; style?: string; sampleFile?: string; sampleMime?: string; profileId?: string }> = {}
  for (const [key, value] of Object.entries(merged.memberVoices ?? {})) {
    if (!key || !value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    const str = (x: unknown, max: number): string => (typeof x === 'string' ? x.slice(0, max) : '')
    memberVoices[key] = {
      voiceId: str(v.voiceId, 200), design: str(v.design, 2000), style: str(v.style, 500),
      sampleFile: str(v.sampleFile, 500), sampleMime: str(v.sampleMime, 100), profileId: str(v.profileId, 64),
    }
  }
  merged.memberVoices = memberVoices

  // 目录逐个校验：设置文件是用户可以直接改的，相对路径会随进程的工作目录漂移 ——
  // 那意味着同一份设置在双击启动和命令行启动下授权了不同的目录，这种事不能靠猜。
  const roots = sanitizeDirs(merged.docRoots)
  merged.docRoots = roots ?? defaultDocRoots()
  merged.docRecentDirs = (sanitizeDirs(merged.docRecentDirs) ?? []).slice(0, MAX_RECENT_DIRS)

  merged.layoutVersion = LAYOUT_VERSION
  // 会话框停靠与尺寸：设置文件可手改，越界的值退回安全范围，别让面板一开就整块跑到屏幕外。
  if (merged.chatDock !== 'auto') merged.chatDock = 'top'
  // 讲解形态同理：设置文件是用户可以手改的，认不出的值一律退回 source（照稿念，最保守），
  // 而不是留一个 undefined 让调用方各自猜默认值。
  if (merged.docSpeechMode !== 'ai' && merged.docSpeechMode !== 'source') merged.docSpeechMode = 'source'
  // 档位制：不在枚举里的一律退回默认（用户手改过、旧版本、或将来缩减档位）。
  if (merged.petScale !== 0.8 && merged.petScale !== 1 && merged.petScale !== 1.2) merged.petScale = 1
  if (merged.petOpacity !== 0.6 && merged.petOpacity !== 0.8 && merged.petOpacity !== 1) merged.petOpacity = 1
  merged.petDock = merged.petDock !== false
  // 非法边名一律当没停靠：宁可恢复到原位，也别把角色放到算不出来的地方。
  if (merged.dockedAt !== 'left' && merged.dockedAt !== 'right' && merged.dockedAt !== 'top' && merged.dockedAt !== 'bottom') {
    merged.dockedAt = null
  }
  const chatSize = merged.chatSize
  if (!chatSize || !Number.isFinite(chatSize.width) || !Number.isFinite(chatSize.height)) {
    merged.chatSize = undefined
  } else {
    merged.chatSize = {
      width: Math.min(2000, Math.max(280, Math.round(chatSize.width))),
      height: Math.min(2000, Math.max(200, Math.round(chatSize.height))),
    }
  }
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
  try {
    if (existsSync(settingsPath())) {
      const mtime = statSync(settingsPath()).mtimeMs
      /* 文件被别人改过就重新读一次；否则直接用缓存。 */
      if (cache !== null && mtime === cacheMtimeMs) return cache
      cache = normalize(JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<PetSettings>)
      cacheMtimeMs = mtime
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
  try { cacheMtimeMs = statSync(settingsPath()).mtimeMs } catch { cacheMtimeMs = 0 }
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
