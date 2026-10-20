/**
 * 平台差异的单一真源：**同一件事在不同系统上该怎么做**。
 *
 * 这里只放"事实"——命令怎么拼、能力有没有。副作用（spawn、写盘、建窗）留在各自模块里。
 * 这么分有两个理由：
 *
 * 1. **可测**。"macOS 上到底该 spawn 什么"是最容易写错、又最难在 Windows 机器上发现的一类错误。
 *    写成纯函数后，`node --test` 能在一台机器上把三种系统的拼法全跑一遍。
 * 2. **单一真源**。以前 `powershell` 这个字符串散在七个文件里，加一个平台就要满地找。
 *    现在只有这里知道"Windows 的音频播放器是 PowerShell 脚本"。
 *
 * 每个入口都允许注入平台，默认取 `process.platform` —— 测试靠它在一台机器上跑遍三系统。
 */

/** 我们实际支持/考虑过的三种系统。其余（freebsd 等）按 POSIX 处理。 */
export type SupportedPlatform = 'win32' | 'darwin' | 'linux'

/**
 * 归一化平台名。
 *
 * 不认识的平台一律归到 `linux`：它们都是 POSIX，命令行工具那一套大致通用。
 * 这比"多一个 unknown 分支到处判空"实际 —— 反正最后都要落到"有没有实现"上。
 */
export function platformOf(value: string = process.platform): SupportedPlatform {
  if (value === 'win32') return 'win32'
  if (value === 'darwin') return 'darwin'
  return 'linux'
}

/**
 * 一条要 spawn 的命令。
 *
 * `command` 是**可执行文件名**，`args` 是参数数组。刻意不拼成一个字符串：
 * 拼字符串就要处理引号与转义，而文档路径、朗读文本里什么都可能有（含中文、空格、引号）。
 * 传数组给 `spawn` 时操作系统直接收 argv，没有 shell 参与，注入面为零。
 */
export interface CommandSpec {
  command: string
  args: readonly string[]
}

/**
 * Windows 上所有音频操作共用的 PowerShell 前缀。
 *
 * 它是**命令的一部分**，不是调用方的约定 —— 所以拼在这里，而不是散在 worker 里。
 */
const POWERSHELL_PREFIX: readonly string[] = [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
]

// ===== 音频播放 =====

/**
 * 播放一个已落盘的音频文件（mp3 / wav），**阻塞到播完**再退出。
 *
 * 返回 `null` 表示这个平台上没有实现 —— 调用方必须如实报"放不了"，不能静默当成功。
 * 静默成功的代价是用户以为在读、其实一个字都没出声。
 */
export function playAudioSpec(
  platform: SupportedPlatform,
  scriptDir: string,
  file: string,
): CommandSpec | null {
  if (platform === 'win32') {
    // play.ps1 走 winmm 的 MCI：mp3 用 mpegvideo 类型、wav 用 waveaudio，脚本自己按扩展名分。
    return {
      command: 'powershell',
      args: [...POWERSHELL_PREFIX, '-File', joinPath(scriptDir, 'play.ps1'), '-Path', file],
    }
  }
  if (platform === 'darwin') {
    // afplay 是 macOS 自带的，支持 mp3/wav/aiff/m4a。没有等价的"文件类型"参数要传。
    return { command: 'afplay', args: [file] }
  }
  return null
}

/**
 * 离线合成并播放（默认合成器不可达时的回退路径）。
 *
 * 参数里带 `outPath` 是为了对齐 Windows 的形状：`speak-once.ps1` 先把合成结果写成 wav
 * 再交给 play.ps1 播。macOS 的 `say` 能直接出声，不需要中间文件 —— 那个路径就空着不用，
 * 调用方对它的清理是幂等的（删不存在的文件是 no-op）。
 */
export function speakOfflineSpec(
  platform: SupportedPlatform,
  scriptDir: string,
  text: string,
  outPath: string,
): CommandSpec | null {
  if (platform === 'win32') {
    return {
      command: 'powershell',
      args: [
        ...POWERSHELL_PREFIX, '-File', joinPath(scriptDir, 'speak-once.ps1'),
        '-B64', Buffer.from(text, 'utf8').toString('base64'),
        '-OutPath', outPath,
      ],
    }
  }
  if (platform === 'darwin') {
    // say 的文本走 argv 而不是 stdin：macOS 的 argv 上限约 1MB，一句话远远够。
    // 传数组给 spawn，文本里的引号/换行/中文都不会被当成 shell 语法。
    return { command: 'say', args: [text] }
  }
  return null
}

// ===== 录音（听写回退）=====

/**
 * 录一段固定时长的单声道 wav。**只在渲染层的 Web Audio 拿不到麦克风时**才走这条路。
 *
 * Windows 用 MCI（record.ps1）；macOS 没有等价的系统命令，需要 ffmpeg/sox 之类的
 * 外部工具 —— 没装就返回 null，由调用方如实报"这次录音用不了，请检查麦克风权限"。
 * 刻意不去猜某个第三方工具的路径：猜错了会 spawn 失败，而失败原因会被用户读成"麦克风坏了"。
 */
export function recordAudioSpec(
  platform: SupportedPlatform,
  scriptDir: string,
  outPath: string,
  maxMs: number,
): CommandSpec | null {
  if (platform === 'win32') {
    return {
      command: 'powershell',
      args: [
        ...POWERSHELL_PREFIX, '-File', joinPath(scriptDir, 'record.ps1'),
        '-OutPath', outPath, '-MaxMs', String(maxMs),
      ],
    }
  }
  return null
}

// ===== 密钥保护 =====

/**
 * 这个平台有没有"把密钥绑到当前用户"的系统能力。
 *
 * Windows 有 DPAPI；macOS/Linux 用 Electron 的 safeStorage（macOS 落 Keychain）。
 * 后者需要 electron 模块，所以实现由调用方注入 —— 这个文件不许 import electron，
 * 否则 `node --test` 就导不进来了。
 */
export function hasSystemKeyProtection(platform: SupportedPlatform): boolean {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux'
}

// ===== 鼠标全局监听 =====

/**
 * 全局鼠标按下监听（用于"点面板外面自动收起"）。
 *
 * Windows 靠一个常驻 PowerShell 进程挂钩子。macOS 需要辅助功能（Accessibility）授权，
 * 而一个 PowerShell 脚本拿不到它 —— 所以这里返回 false，由调用方**静默降级**：
 * 面板照常能开，只是"点外面收起"这一步要靠点角色本身或 Esc。
 *
 * 注意降级不能报错弹窗：这个能力缺了不影响任何主流程，弹一句"鼠标监听仅支持 Windows"
 * 只会让用户以为宠物坏了。这是从 macOS 评估里改掉的一处 —— 原来的实现会往界面推错误。
 */
export function supportsGlobalPointerWatch(platform: SupportedPlatform): boolean {
  return platform === 'win32'
}

// ===== 唤醒词 =====

/**
 * 常驻唤醒词监听（喊"小潘同学"把角色叫回来）。
 *
 * Windows 走 `System.Speech` 的离线识别器 + 一份自定义 grammar，纯本地、零依赖。
 * macOS 没有对应的系统能力：要么引第三方语音框架，要么自己拿流式模型做常驻识别，
 * 两者都超出"改一处命令拼法"的量级 —— 所以这里返回 false。
 *
 * 返回 false 时调用方要**粘住不可用状态**（`audio.ts` 的 `wakeUnavailable`），
 * 不能每三秒重试一次刷日志。
 */
export function supportsWakeWord(platform: SupportedPlatform): boolean {
  return platform === 'win32'
}

/**
 * 系统音频（会议里"对方的声音"）能不能采。
 *
 * 三处判断，每一处都对应一类真实情况：
 *
 * - **Linux 没有实现**：PulseAudio 的监听源要用户自己配 `.monitor` 设备，没有统一做法。
 * - **macOS 需要「屏幕与系统录音」权限**：系统音频属于屏幕采集的一部分，与麦克风是**两个**开关。
 *   用户拒绝了就只能录本机麦克风，反复重试没有意义 —— 所以返回 `available: false` 并把
 *   "去哪个设置页"写进 reason，让界面能直接告诉用户该改哪里。
 * - **macOS 13 以下拿不到回环声**：那里 `audio: 'loopback'` 不生效，只能在拿到流之后
 *   发现没有音轨时再如实上报（这一层判断不了，所以这里仍返回可用）。
 *
 * `screenAccess` 传 `systemPreferences.getMediaAccessStatus('screen')` 的值；非 macOS 忽略。
 */
export function loopbackCapability(
  platform: SupportedPlatform,
  screenAccess: string,
): { available: true; reason: string | null } | { available: false; reason: string } {
  if (platform === 'linux') {
    return { available: false, reason: 'Linux 上还没有系统音频采集实现，这场会议只录本机麦克风' }
  }
  if (platform === 'darwin') {
    if (screenAccess === 'denied') {
      return {
        available: false,
        reason: '缺少「屏幕与系统录音」权限：在 系统设置 → 隐私与安全性 → 屏幕与系统录音 里允许本应用，然后重启宠物。本次只录本机麦克风',
      }
    }
    if (screenAccess === 'restricted') {
      return { available: false, reason: '系统策略限制了屏幕与系统录音权限，无法采集对方的声音；本次只录本机麦克风' }
    }
    if (screenAccess === 'not-determined') {
      return { available: true, reason: '第一次采集时系统会询问「屏幕与系统录音」权限' }
    }
  }
  return { available: true, reason: null }
}

/**
 * 唤醒引擎（M1-02）。
 *
 * - `system`：Windows System.Speech + 自定义 grammar，自己开设备，独立 PowerShell 进程。Windows 默认。
 * - `kws`：sherpa-onnx KeywordSpotter（进程内 worker 线程），吃渲染层共享采集的 16k PCM。
 *   macOS 唯一的本地方案；Windows 上作为可选项（统一体验、本地可测）。
 *
 * Linux 上不列任何引擎：共享采集与模型本身跨平台，但没在 Linux 上验证过，不对外宣称可用。
 */
export type WakeEngine = 'system' | 'kws'

export function wakeEngines(platform: SupportedPlatform): readonly WakeEngine[] {
  if (platform === 'win32') return ['system', 'kws']
  if (platform === 'darwin') return ['kws']
  return []
}

export function defaultWakeEngine(platform: SupportedPlatform): WakeEngine | null {
  return wakeEngines(platform)[0] ?? null
}

/**
 * 唤醒开关的缺省值。Windows 保持既有行为（开机即听）；macOS 缺省关：开着就是持续采集，
 * 菜单栏会一直亮着麦克风占用图标，必须用户自己打开。
 */
export function defaultWakeEnabled(platform: SupportedPlatform): boolean {
  return platform === 'win32'
}

/**
 * KWS 唤醒是否在真机真实环境下验证过。目前只有合成音频的离线检测数据，
 * 安静 / 办公 / 电视声三种真实环境与 Mac 真机都还没测 —— 界面据此标"实验性"。
 */
export function kwsWakeDeviceVerified(_platform: SupportedPlatform): boolean {
  return false
}

// ===== 开机自启 =====

/** `app.setLoginItemSettings` 的参数。null = 这个平台上 Electron 不支持登录项。 */
export interface LoginItemSpec {
  openAtLogin: boolean
  path?: string
  args?: string[]
}

/**
 * 登录项参数。未打包（开发态）时 execPath 是 electron 本体，必须把应用目录作为参数带上，
 * 否则开机启动的是一个空的 Electron。
 */
export function loginItemSpec(
  platform: SupportedPlatform,
  open: boolean,
  runtime: { isPackaged: boolean; execPath: string; appPath: string },
): LoginItemSpec | null {
  if (platform !== 'win32' && platform !== 'darwin') return null
  if (runtime.isPackaged) return { openAtLogin: open }
  return { openAtLogin: open, path: runtime.execPath, args: [runtime.appPath] }
}

// ===== 活动采集（插件侧同款判断）=====

/**
 * 前台窗口活动采集。Windows 走 PowerShell + Win32 API（`sampler.ps1`）。
 * macOS 需要 Accessibility 授权 + 另一套 API，未实现。
 */
export function supportsActivitySampling(platform: SupportedPlatform): boolean {
  return platform === 'win32'
}

// ===== 桌面应用与窗口动作（desktop-actions.ts 契约）=====

/**
 * 有没有"打开指定应用、识别并核验窗口、语义翻页"这一套实现。
 *
 * Windows 走 UI Automation 辅助脚本（win-uia.ps1）；macOS 走 osascript/JXA（mac-actions.ts）。
 * Linux 没有实现。注意"有实现"不等于"在真机上验证过"，后者看 `desktopActionsDeviceVerified`。
 */
export function supportsDesktopActions(platform: SupportedPlatform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/**
 * 是否已在真机上验证过。macOS 的实现只做过命令规格与解析测试，**未在 Mac 真机验证** ——
 * 调用方据此在界面上标注"实验性"，不能把 macOS 当成已可用。
 */
export function desktopActionsDeviceVerified(platform: SupportedPlatform): boolean {
  return platform === 'win32'
}

/** WPS 指定打开 + 页码同步。macOS 同上：有实现、未真机验证。 */
export function supportsWpsControl(platform: SupportedPlatform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/**
 * Windows 的 UI Automation 辅助脚本：常驻进程，stdin/stdout 按行收发 base64 JSON。
 *
 * 参数里**没有任何请求内容** —— 目标窗口身份、文档名都走 stdin，命令行上只有脚本路径。
 */
export function winUiaHelperSpec(platform: SupportedPlatform, scriptDir: string): CommandSpec | null {
  if (platform !== 'win32') return null
  return {
    command: 'powershell',
    args: [...POWERSHELL_PREFIX, '-File', joinPath(scriptDir, 'win-uia.ps1')],
  }
}

/** 用指定应用打开文件时，应用一侧的描述。`args` 是放在文件路径之前的固定开关。 */
export interface AppLaunchSpecInput {
  executable: string
  args?: readonly string[]
  bundleId?: string
}

/**
 * 用指定应用打开文件的命令。
 *
 * - Windows：直接执行应用的 exe，文件路径作为**最后一个独立参数**。要求绝对路径（盘符或 UNC），
 *   这样路径不可能以 `/` 或 `-` 开头被应用当成开关。
 * - macOS：`/usr/bin/open -b <bundle id> <文件>`，没有 bundle id 时用 `-a <.app 路径>`。
 *   要求以 `/` 开头的绝对路径，同样不会被 `open` 当成选项。
 *
 * 不合法时返回 null —— 调用方报 invalid-argument，不尝试"修正"路径。
 */
export function openWithSpec(platform: SupportedPlatform, app: AppLaunchSpecInput, file: string): CommandSpec | null {
  if (platform === 'win32') {
    if (!isWindowsAbsolute(file) || !isWindowsAbsolute(app.executable)) return null
    return { command: app.executable, args: [...(app.args ?? []), file] }
  }
  if (platform === 'darwin') {
    if (!file.startsWith('/')) return null
    if (app.bundleId !== undefined && /^[A-Za-z0-9.-]+$/.test(app.bundleId)) {
      return { command: '/usr/bin/open', args: ['-b', app.bundleId, file] }
    }
    if (!app.executable.startsWith('/')) return null
    return { command: '/usr/bin/open', args: ['-a', app.executable, file] }
  }
  return null
}

/**
 * macOS 的 JXA 调用。脚本正文是代码里的常量；**所有可变内容只走最后一个参数（JSON）**，
 * 不拼进脚本文本。前面那个固定的 `dsh-args` 让 osascript 的选项解析在它这里停下，
 * 即使 JSON 以奇怪的字符开头也不会被当成 osascript 自己的选项。
 */
export function osascriptJxaSpec(platform: SupportedPlatform, script: string, payloadJson: string): CommandSpec | null {
  if (platform !== 'darwin') return null
  return {
    command: '/usr/bin/osascript',
    args: ['-l', 'JavaScript', '-e', script, 'dsh-args', payloadJson],
  }
}

function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:\\/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
}

// ===== 内部 =====

/**
 * 拼路径。
 *
 * 刻意不用 `node:path.join`：这个模块要能在浏览器/纯函数语境下被导入，
 * 而 `node:path` 的平台分隔符取决于**运行**平台，不是**目标**平台 ——
 * 在 Windows 上测 darwin 的拼法时，`path.join` 会给出反斜杠，测试就假失败了。
 * 这里的规则很简单：Windows 用反斜杠，其余用斜杠。
 */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.endsWith(sep) || dir.endsWith('/') || dir.endsWith('\\')
    ? `${dir}${name}`
    : `${dir}${sep}${name}`
}

