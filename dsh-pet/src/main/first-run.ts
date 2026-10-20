/**
 * 首次启动的环境检查（M5-06）：把"现在缺什么、缺了会怎样、下一步做什么、数据去哪里"算成给用户看的清单。
 *
 * 纯函数：输入是调用方已经查到的事实 —— 平台、模型检查结果（model-resources.ts）、权限状态、
 * 运行时定位结果（runtime-launch.ts 的 planRuntimeLaunch）；输出是检查项、下一步与数据去向。
 * 这里不读文件、不弹权限框、不下载、不执行命令：每一个会改动系统设置或用户配置的动作
 * （下载模型、请求麦克风、安装插件）都只作为"下一步"列出，由界面在用户确认后去做。
 *
 * "不无限等待"落在两处：模型还在检查时带截止时间，过了截止时间就如实报"检查超时，可重试"；
 * 模型没装时直接给出下载入口，而不是让听写一直等一个不存在的模型。
 */
import type { MacPermission } from './desktop-actions.ts'
import type { ModelCheck, ModelId } from './model-resources.ts'
import type { SupportedPlatform } from './platform.ts'
import { bundledCliCommandLine, type LaunchFailure, type RuntimePlan } from './runtime-launch.ts'

/** Electron `systemPreferences.getMediaAccessStatus('microphone')` 的取值。 */
export type MediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

/** macOS 隐私权限的探测结果（mac-actions 的 checkPermissions）。 */
export type PrivacyState = 'granted' | 'denied' | 'unknown'

/** 模型检查最多等多久就判"超时"。 */
export const MODEL_CHECK_DEADLINE_MS = 60_000

export interface FirstRunInput {
  readonly platform: SupportedPlatform
  readonly packaged: boolean
  /** 模型检查结果；null = 还在检查。 */
  readonly models: readonly ModelCheck[] | null
  /** 开始检查模型的时刻；与 now 一起判定是否超时。 */
  readonly modelCheckStartedAt?: number
  readonly now?: number
  readonly permissions: {
    readonly microphone: MediaAccessStatus
    /** 仅 macOS 有意义；缺项按 unknown。 */
    readonly mac?: Partial<Record<MacPermission, PrivacyState>>
  }
  readonly runtime: {
    readonly profile: string
    /** planRuntimeLaunch 的结果；null = 还没核对。 */
    readonly plan: RuntimePlan | LaunchFailure | null
    /** 随包 CLI 的位置（resolveCli）与壳自身的可执行文件：安装版里写插件安装命令要用。 */
    readonly cliPath?: string | null
    readonly execPath?: string | null
  }
  /** 用户在设置里选用了自配的语音识别 / 朗读服务。 */
  readonly voiceApi?: { readonly asr: boolean; readonly tts: boolean }
}

/**
 * - ready：可用；
 * - action：要用户处理，对应功能才可用（不影响桌面壳启动）；
 * - optional：可选能力缺失，不影响主流程；
 * - blocked：安装包或环境本身的问题，在本机处理不了，需要换安装包；
 * - checking：还在检查（有截止时间）；
 * - unknown：读不到状态，第一次用到时由系统决定。
 */
export type FirstRunStatus = 'ready' | 'action' | 'optional' | 'blocked' | 'checking' | 'unknown'

export type SettingsTarget = 'microphone' | MacPermission

export type FirstRunStep =
  | { readonly kind: 'confirm-download'; readonly label: string; readonly modelIds: readonly ModelId[] }
  | { readonly kind: 'request-permission'; readonly label: string; readonly permission: 'microphone' }
  | { readonly kind: 'open-settings'; readonly label: string; readonly target: SettingsTarget; readonly uri: string | null }
  | { readonly kind: 'run-command'; readonly label: string; readonly command: string; readonly effect: string }
  | { readonly kind: 'reinstall'; readonly label: string }
  | { readonly kind: 'retry-check'; readonly label: string }

export interface FirstRunItem {
  readonly id: string
  readonly group: 'runtime' | 'model' | 'permission'
  readonly title: string
  readonly status: FirstRunStatus
  /** 现在的情况。 */
  readonly detail: string
  /** 缺了它影响什么；就绪时为 null。 */
  readonly impact: string | null
  readonly step: FirstRunStep | null
}

export interface DataFlow {
  readonly id: 'local-speech' | 'edge-tts' | 'model-chat' | 'voice-api'
  readonly title: string
  readonly where: 'local' | 'cloud'
  /** 数据去向。 */
  readonly destination: string
  /** 哪些数据。 */
  readonly data: string
  /** 现在是否在用（自配语音服务取决于设置）。 */
  readonly active: boolean
  /** 怎么控制或关掉。 */
  readonly control: string
}

export interface FirstRunReport {
  readonly items: readonly FirstRunItem[]
  /** 去重后的下一步：先 blocked、再 action、最后 optional；模型下载合并成一次确认。 */
  readonly nextSteps: readonly FirstRunStep[]
  readonly dataFlows: readonly DataFlow[]
  readonly summary: {
    /** 没有 blocked / action / checking 项。可选项缺失不影响就绪。 */
    readonly ready: boolean
    readonly needsAction: number
    readonly checking: number
    readonly headline: string
  }
}

// ===== 系统设置入口 =====

const SETTINGS_URI: Readonly<Record<'win32' | 'darwin', Partial<Record<SettingsTarget, string>>>> = {
  win32: { microphone: 'ms-settings:privacy-microphone' },
  darwin: {
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  },
}

/**
 * 系统设置页的 URI。导出给主进程的 "打开设置" 处理器用 ——
 * 让渲染层自己拼 URI 再交给 `openExternal`，等于把"打开任意地址"的能力给了页面。
 */
export function settingsUri(platform: SupportedPlatform, target: SettingsTarget): string | null {
  if (platform !== 'win32' && platform !== 'darwin') return null
  return SETTINGS_URI[platform][target] ?? null
}

// ===== 运行时 =====

function pluginCommand(input: FirstRunInput): string {
  const { profile, cliPath, execPath } = input.runtime
  const args = ['plugin', '--profile', profile, 'add', '<插件包路径>']
  if (input.packaged && cliPath && execPath) return bundledCliCommandLine(input.platform, execPath, cliPath, args)
  return `dsh ${args.join(' ')}`
}

function runtimeItem(input: FirstRunInput): FirstRunItem {
  const { plan, profile } = input.runtime
  const base = { id: 'runtime', group: 'runtime' as const, title: '团队运行时（dsh 与个人助理插件）' }
  const impact = '桌面角色照常显示；对话、日报与团队协作要等运行时就绪后才能用'
  if (plan === null) {
    return { ...base, status: 'checking', detail: '正在核对随包的 dsh 命令行、profile 与插件', impact: null, step: null }
  }
  if (plan.ok) {
    return {
      ...base,
      status: 'ready',
      detail: `已找到 dsh ${plan.dshVersion} 与插件 ${plan.pluginVersion}（profile「${plan.profile}」）`,
      impact: null,
      step: null,
    }
  }
  const pluginEffect = `会在 profile「${profile}」里安装插件并改动它的依赖与图层列表（~/.dsh/profiles/${profile}）；`
    + 'profile 不存在时会先新建；需要本机已安装 pnpm。桌面壳不会替你执行'
  switch (plan.stage) {
    case 'locate-cli':
      return input.packaged
        ? { ...base, status: 'blocked', detail: plan.message, impact, step: { kind: 'reinstall', label: '重新安装完整的安装包' } }
        : {
            ...base, status: 'action', detail: plan.message, impact,
            step: { kind: 'run-command', label: '在 dsh-pet 目录安装依赖', command: 'pnpm install', effect: '只改动 dsh-pet 目录下的 node_modules' },
          }
    case 'locate-profile':
      // profile 名本身不合法时没有命令可给：换一个 profile 即可。
      if (/不合法/.test(plan.message)) {
        return { ...base, status: 'action', detail: plan.message, impact, step: { kind: 'retry-check', label: '在托盘「启动助理团队」里换一个 profile 后重新检查' } }
      }
      return {
        ...base, status: 'action', detail: plan.message, impact,
        step: { kind: 'run-command', label: '新建 profile 并安装个人助理插件（确认后在终端执行）', command: pluginCommand(input), effect: pluginEffect },
      }
    case 'locate-plugin':
      return {
        ...base, status: 'action', detail: plan.message, impact,
        step: { kind: 'run-command', label: '安装个人助理插件（确认后在终端执行）', command: pluginCommand(input), effect: pluginEffect },
      }
    case 'locate-overlay':
      return {
        ...base, status: 'action', detail: plan.message, impact,
        step: { kind: 'run-command', label: '用新版插件包重新安装插件（确认后在终端执行）', command: pluginCommand(input), effect: pluginEffect },
      }
    default:
      return { ...base, status: 'action', detail: plan.message, impact, step: { kind: 'retry-check', label: '重新检查' } }
  }
}

// ===== 模型 =====

function modelImpact(check: ModelCheck, platform: SupportedPlatform): string {
  if (check.id === 'diarization-segmentation' || check.id === 'diarization-embedding') {
    return '会议照常录音和转写，但不会自动分出说话人（纪要里标"未自动分人"）'
  }
  if (check.id === 'streaming') {
    return platform === 'darwin'
      ? '听写不能边说边出字；SenseVoice 也没装时，Mac 上听写不可用'
      : '听写不能边说边出字；SenseVoice 也没装时，退回系统自带识别（准确率较低）'
  }
  return platform === 'darwin'
    ? '会议转写与整句识别不可用；流式模型也没装时，Mac 上听写不可用'
    : '会议转写与整句识别不可用；流式模型也没装时，听写退回系统自带识别（准确率较低）'
}

function modelItems(input: FirstRunInput): FirstRunItem[] {
  if (input.models === null) {
    const started = input.modelCheckStartedAt
    const now = input.now ?? Date.now()
    if (started !== undefined && now - started > MODEL_CHECK_DEADLINE_MS) {
      return [{
        id: 'models',
        group: 'model',
        title: '本地语音模型',
        status: 'blocked',
        detail: `模型检查超过 ${MODEL_CHECK_DEADLINE_MS / 1000} 秒没有结果（磁盘可能很慢或文件被占用），已停止等待`,
        impact: '语音功能的状态未知；文字对话不受影响',
        step: { kind: 'retry-check', label: '重新检查模型' },
      }]
    }
    return [{ id: 'models', group: 'model', title: '本地语音模型', status: 'checking', detail: '正在核对模型文件的大小与 sha256', impact: null, step: null }]
  }
  return input.models.map((check): FirstRunItem => {
    const base = { id: `model:${check.id}`, group: 'model' as const, title: check.title }
    if (check.state === 'complete') return { ...base, status: 'ready', detail: check.message, impact: null, step: null }
    const step: FirstRunStep = {
      kind: 'confirm-download',
      label: check.state === 'corrupt' ? '确认后重新下载并替换不符的文件' : '查看来源、大小与许可证，确认后下载',
      modelIds: [check.id],
    }
    // 损坏的文件可能让识别器加载失败，哪怕是可选模型也要处理。
    const status: FirstRunStatus = check.state === 'corrupt' || !check.optional ? 'action' : 'optional'
    return { ...base, status, detail: check.message, impact: modelImpact(check, input.platform), step }
  })
}

// ===== 权限 =====

function microphoneItem(input: FirstRunInput): FirstRunItem {
  const base = { id: 'permission:microphone', group: 'permission' as const, title: '麦克风' }
  const impact = '语音唤醒、听写与会议录音不可用；文字对话不受影响'
  const status = input.permissions.microphone
  if (status === 'granted') return { ...base, status: 'ready', detail: '已允许本应用使用麦克风', impact: null, step: null }
  if (status === 'not-determined') {
    return {
      ...base, status: 'action', detail: '还没有询问过麦克风权限', impact,
      step: { kind: 'request-permission', label: '让系统弹出麦克风授权询问', permission: 'microphone' },
    }
  }
  if (status === 'denied' || status === 'restricted') {
    const where = input.platform === 'darwin' ? '系统设置 → 隐私与安全性 → 麦克风' : '设置 → 隐私和安全性 → 麦克风'
    return {
      ...base, status: 'action',
      detail: status === 'restricted' ? '麦克风被系统策略限制（可能由管理员设定）' : '麦克风权限被拒绝；系统不会再次弹出询问',
      impact,
      step: { kind: 'open-settings', label: `打开「${where}」，允许本应用`, target: 'microphone', uri: settingsUri(input.platform, 'microphone') },
    }
  }
  return { ...base, status: 'unknown', detail: '读不到麦克风授权状态；第一次使用语音时由系统询问或给出结果', impact, step: null }
}

const MAC_PERMISSION_TEXT: Readonly<Record<MacPermission, { title: string; pane: string; impact: string }>> = {
  accessibility: {
    title: '辅助功能（macOS）',
    pane: '系统设置 → 隐私与安全性 → 辅助功能',
    impact: 'WPS 讲解时无法识别窗口、读取页码与翻页；其他功能不受影响',
  },
  automation: {
    title: '自动化：System Events（macOS）',
    pane: '系统设置 → 隐私与安全性 → 自动化',
    impact: 'WPS 讲解时无法识别窗口与翻页；其他功能不受影响',
  },
  'screen-recording': {
    title: '屏幕与系统录音（macOS）',
    pane: '系统设置 → 隐私与安全性 → 屏幕与系统录音',
    impact: '只影响缺辅助功能时的只读窗口识别；不影响翻页',
  },
}

function macPermissionItems(input: FirstRunInput): FirstRunItem[] {
  if (input.platform !== 'darwin') return []
  return (['accessibility', 'automation', 'screen-recording'] as const).map((permission): FirstRunItem => {
    const text = MAC_PERMISSION_TEXT[permission]
    const base = { id: `permission:${permission}`, group: 'permission' as const, title: text.title }
    const state = input.permissions.mac?.[permission] ?? 'unknown'
    if (state === 'granted') return { ...base, status: 'ready', detail: '已允许', impact: null, step: null }
    if (state === 'denied') {
      return {
        ...base, status: 'optional', detail: '未允许（只在用 WPS 讲解时需要）', impact: text.impact,
        step: { kind: 'open-settings', label: `需要时打开「${text.pane}」，允许本应用`, target: permission, uri: settingsUri('darwin', permission) },
      }
    }
    return { ...base, status: 'unknown', detail: '尚未检查；第一次用 WPS 讲解时再确认', impact: text.impact, step: null }
  })
}

// ===== 数据去向 =====

function dataFlows(input: FirstRunInput): DataFlow[] {
  const voiceAsr = input.voiceApi?.asr === true
  const voiceTts = input.voiceApi?.tts === true
  return [
    {
      id: 'local-speech',
      title: '语音识别、唤醒与会议录音（本地）',
      where: 'local',
      destination: '本机：模型在 userData/local-asr，会议录音存在本机',
      data: '麦克风音频。听写、边说边出字、唤醒词、会议转写与分人都在本机解码；Windows 未装模型时退回的系统识别同样在本机',
      // 唤醒与会议转写始终在本机；只有听写会因自配识别服务而改道。
      active: true,
      control: voiceAsr
        ? '你选用了自配语音识别服务：听写录音改发给那个服务（见"自配语音服务"），唤醒词与会议转写仍在本机'
        : '不装模型或关掉语音功能即不做本地识别；音频不会上传',
    },
    {
      id: 'edge-tts',
      title: '朗读（联网合成）',
      where: 'cloud',
      destination: '微软 Edge 朗读服务（speech.platform.bing.com）',
      data: '要朗读的文字（助理回复、文档讲解片段）；不发送录音',
      // 选用自配朗读服务后不再走 edge-tts，失败也不会偷偷切回（tts-edge-worker 的约定）。
      active: !voiceTts,
      control: '断网或服务不可达时，Windows 用系统语音、macOS 用 say 在本机合成；选用自配朗读服务后不再发往这里',
    },
    {
      id: 'model-chat',
      title: '对话与生成（模型服务商）',
      where: 'cloud',
      destination: `dsh 运行时所用 profile「${input.runtime.profile}」配置的模型服务商`,
      data: '你输入或说出的文字（语音先在本机转成文字）、你让助理讲解的文档片段、你授权生成纪要的会议转写、插件生成日报时用到的活动记录',
      active: true,
      control: '只在团队运行时连上后发生；服务商与密钥由 dsh 的 profile 管理，桌面壳不保存模型密钥',
    },
    {
      id: 'voice-api',
      title: '自配语音服务（可选）',
      where: 'cloud',
      destination: '你在设置里填写的服务地址',
      data: voiceAsr && voiceTts
        ? '听写录音与要朗读的文字'
        : voiceAsr ? '听写录音' : voiceTts ? '要朗读的文字' : '未选用时不发送任何内容',
      active: voiceAsr || voiceTts,
      control: '只有在设置里填写并选用后才生效；密钥用系统密钥库加密保存，界面拿不到密钥本体',
    },
  ]
}

// ===== 汇总 =====

const STATUS_ORDER: Readonly<Record<FirstRunStatus, number>> = {
  blocked: 0, action: 1, checking: 2, optional: 3, unknown: 4, ready: 5,
}

function collectSteps(items: readonly FirstRunItem[]): FirstRunStep[] {
  const ordered = [...items]
    .filter(item => item.step !== null && (item.status === 'blocked' || item.status === 'action' || item.status === 'optional'))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
  const steps: FirstRunStep[] = []
  let download: { modelIds: ModelId[]; at: number } | null = null
  for (const item of ordered) {
    const step = item.step!
    if (step.kind === 'confirm-download') {
      if (download === null) {
        download = { modelIds: [], at: steps.length }
        steps.push(step)
      }
      download.modelIds.push(...step.modelIds.filter(id => !download!.modelIds.includes(id)))
      continue
    }
    if (steps.some(existing => JSON.stringify(existing) === JSON.stringify(step))) continue
    steps.push(step)
  }
  if (download !== null) {
    steps[download.at] = {
      kind: 'confirm-download',
      label: download.modelIds.length > 1
        ? `查看 ${download.modelIds.length} 个模型的来源、大小与许可证，逐项确认后下载`
        : (steps[download.at] as { label: string }).label,
      modelIds: download.modelIds,
    }
  }
  return steps
}

export function buildFirstRunReport(input: FirstRunInput): FirstRunReport {
  const items: FirstRunItem[] = [
    runtimeItem(input),
    ...modelItems(input),
    microphoneItem(input),
    ...macPermissionItems(input),
  ]
  const needs = items.filter(item => item.status === 'blocked' || item.status === 'action')
  const checking = items.filter(item => item.status === 'checking').length
  const headline = needs.length > 0
    ? `还有 ${needs.length} 项需要处理：${needs.map(item => item.title).join('、')}`
    : checking > 0 ? '正在检查环境…' : '环境就绪'
  return {
    items,
    nextSteps: collectSteps(items),
    dataFlows: dataFlows(input),
    summary: { ready: needs.length === 0 && checking === 0, needsAction: needs.length, checking, headline },
  }
}
