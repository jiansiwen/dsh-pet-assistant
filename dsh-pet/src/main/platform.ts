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
 * 常驻唤醒词监听（喊"小潘小潘"把角色叫回来）。
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

// ===== 活动采集（插件侧同款判断）=====

/**
 * 前台窗口活动采集。Windows 走 PowerShell + Win32 API（`sampler.ps1`）。
 * macOS 需要 Accessibility 授权 + 另一套 API，未实现。
 */
export function supportsActivitySampling(platform: SupportedPlatform): boolean {
  return platform === 'win32'
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
