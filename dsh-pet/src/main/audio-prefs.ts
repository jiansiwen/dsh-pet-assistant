/**
 * 常驻与语音的四个独立开关（M1-02）里归桌面壳管的三个，加上"外放插话"实验开关（M1-05）。
 *
 * 为什么不放进 `settings.ts`：那份设置文件里是形象、座位、文档授权这类"界面偏好"，而这里每一项
 * 都直接决定麦克风开不开、开机写不写启动项 —— 授权性质的开关单独成文件，读写规则也单独钉住：
 * - 唤醒：缺省按平台（Windows 开、macOS 关），见 `platform.ts` 的 `defaultWakeEnabled`。
 * - 唤醒引擎：只接受这个平台列出的引擎，其余退回平台缺省。
 * - 开机自启：缺省关。关着时**绝不写启动项**；只在用户把它从关切到开时写，从开切到关时移除。
 * - 外放插话：缺省关。实验开关，打开后 TTS 改由渲染层播放（让 Chromium 回声消除拿到参考信号）。
 *
 * 托盘常驻沿用 `settings.ts` 的 `trayResident`（companion-host 的托盘菜单已经在读写它），
 * 活动记录归插件的可信审批管 —— 这两项这里都不存。
 *
 * 不 import electron：要能被 node --test 直接导入。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { defaultWakeEnabled, defaultWakeEngine, wakeEngines, type SupportedPlatform, type WakeEngine } from './platform.ts'
import { DEFAULT_WAKE_NAME, normalizeWakeName } from './wake-name.ts'

export interface AudioPrefs {
  readonly wakeEnabled: boolean
  /** null = 这个平台没有可用引擎。 */
  readonly wakeEngine: WakeEngine | null
  /** 用户给助理起的唤醒词；默认「小潘同学」。 */
  readonly wakeName: string
  /**
   * 只认已注册的声纹；默认关（关闭时谁喊都应，保持旧行为）。
   *
   * 与 {@link wakeDuringSpeech} 是两件事，别混：
   * - `wakeVoiceprint` 在**声纹层**过滤（只有主人的声音能通过）；
   * - `wakeDuringSpeech` 在**逻辑层**过滤（播报中要不要响应唤醒）。
   * 而且声纹在讲解中一律放行（见 `wake-scene.ts`）：讲解是公开场合。
   */
  readonly wakeVoiceprint: boolean
  /**
   * 播报（回答/讲解）中是否也响应唤醒；默认 **false** = 播报中安静。
   *
   * 关着更接近真人助理：它正在说话时你插话，它不会每次都"我在呢"地打断自己。
   * 讲解中例外 —— 那时候被打断是常态，不受这个开关影响。
   */
  readonly wakeDuringSpeech: boolean
  /** 声纹相似度阈值；0.5–0.9，默认 0.65。 */
  readonly wakeVoiceprintThreshold: number
  readonly launchAtLogin: boolean
  readonly bargeIn: boolean
}

export type AudioPrefsPatch = Partial<Pick<AudioPrefs, 'wakeEnabled' | 'wakeVoiceprint' | 'wakeVoiceprintThreshold' | 'wakeDuringSpeech' | 'launchAtLogin' | 'bargeIn'>> & {
  wakeEngine?: WakeEngine
  wakeName?: string
}

export function normalizeAudioPrefs(raw: unknown, platform: SupportedPlatform): AudioPrefs {
  const record = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const engines = wakeEngines(platform)
  const engine = typeof record.wakeEngine === 'string' && (engines as readonly string[]).includes(record.wakeEngine)
    ? record.wakeEngine as WakeEngine : defaultWakeEngine(platform)
  return {
    // 没有任何引擎的平台上，开关存了 true 也没有意义：如实是 false。
    wakeEnabled: engine === null ? false : typeof record.wakeEnabled === 'boolean' ? record.wakeEnabled : defaultWakeEnabled(platform),
    wakeEngine: engine,
    wakeName: normalizeWakeName(record.wakeName),
    wakeVoiceprint: record.wakeVoiceprint === true,
    // 默认 false：播报中不响应唤醒（安静优先）。只有明确的 true 才打开。
    wakeDuringSpeech: record.wakeDuringSpeech === true,
    wakeVoiceprintThreshold: typeof record.wakeVoiceprintThreshold === 'number'
      && Number.isFinite(record.wakeVoiceprintThreshold)
      && record.wakeVoiceprintThreshold >= 0.5 && record.wakeVoiceprintThreshold <= 0.9
      ? record.wakeVoiceprintThreshold : 0.65,
    launchAtLogin: record.launchAtLogin === true,
    bargeIn: record.bargeIn === true,
  }
}

/** 只认识这几个键、只收布尔 / 平台列出的引擎；其余一律丢掉。 */
export function sanitizePatch(raw: unknown, platform: SupportedPlatform): AudioPrefsPatch {
  if (raw === null || typeof raw !== 'object') return {}
  const record = raw as Record<string, unknown>
  const patch: { -readonly [K in keyof AudioPrefsPatch]: AudioPrefsPatch[K] } = {}
  for (const key of ['wakeEnabled', 'launchAtLogin', 'bargeIn'] as const) {
    if (typeof record[key] === 'boolean') patch[key] = record[key] as boolean
  }
  if (typeof record.wakeEngine === 'string' && (wakeEngines(platform) as readonly string[]).includes(record.wakeEngine)) {
    patch.wakeEngine = record.wakeEngine as WakeEngine
  }
  if (typeof record.wakeName === 'string') patch.wakeName = record.wakeName
  if (typeof record.wakeVoiceprint === 'boolean') patch.wakeVoiceprint = record.wakeVoiceprint
  if (typeof record.wakeDuringSpeech === 'boolean') patch.wakeDuringSpeech = record.wakeDuringSpeech
  if (typeof record.wakeVoiceprintThreshold === 'number' && Number.isFinite(record.wakeVoiceprintThreshold)) {
    patch.wakeVoiceprintThreshold = record.wakeVoiceprintThreshold
  }
  return patch
}

/**
 * 开机自启要不要动系统登录项，以及怎么动。
 *
 * 'none' 是最重要的分支：启动时、以及开关没变时都不碰登录项 —— "关闭时不写启动项"的验收
 * 要求的不只是"写 false"，而是压根不调用。只有用户亲手把它从关切到开（'enable'）或从开切到关
 * （'disable'，把之前写的移除）时才调用一次。
 */
export function loginItemAction(previous: boolean, next: boolean): 'none' | 'enable' | 'disable' {
  if (previous === next) return 'none'
  return next ? 'enable' : 'disable'
}

export class AudioPrefsStore {
  private readonly file: string
  private readonly platform: SupportedPlatform
  private cache: AudioPrefs | null = null

  constructor(file: string, platform: SupportedPlatform) {
    this.file = file
    this.platform = platform
  }

  get(): AudioPrefs {
    if (this.cache) return this.cache
    let raw: unknown = {}
    try {
      if (existsSync(this.file)) raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      // 损坏的文件按缺省值处理：缺省值全是"不开麦、不写启动项"的保守取值（Windows 唤醒除外，那是既有行为）。
    }
    this.cache = normalizeAudioPrefs(raw, this.platform)
    return this.cache
  }

  /** 合并保存，返回新旧两份：调用方据此决定要不要起停监听、动登录项。 */
  update(rawPatch: unknown): { previous: AudioPrefs; next: AudioPrefs } {
    const previous = this.get()
    const next = normalizeAudioPrefs({ ...previous, ...sanitizePatch(rawPatch, this.platform) }, this.platform)
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(next, null, 2), 'utf8')
    this.cache = next
    return { previous, next }
  }
}
