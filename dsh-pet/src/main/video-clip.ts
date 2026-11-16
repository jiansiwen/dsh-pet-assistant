/**
 * 从本地视频片段裁一个动作。
 *
 * 这条链路的定位：**素材来源多一种**，不是新引擎。
 * 已有的「登记为动作 → 缺动作回退 idle → 失败如实报」全部复用，
 * 这里只负责"把一个视频片段变成一段透明 WebM"。
 *
 * 三条刻意的限制：
 *
 * 1. **不替用户猜时间轴**。起止必须显式给，且限制在 0.2–10 秒：
 *    桌面宠物的一个动作就是一两秒，太长的片段播起来像视频不像动作。
 * 2. **抠不干净就如实失败**，不硬塞一段"半透明鬼影"进去。
 *    `backgroundkey` 靠静态背景估计，镜头一动就会把背景一起留着或把角色抠掉，
 *    这时给出的错误必须让用户知道下一步该怎么做（换镜头不动的片段 / 用绿幕素材）。
 * 3. **不下载、不搜索**。只吃本地已有文件；搜索与下载是另一件事，且授权/质量都不受控。
 */
import { existsSync } from 'node:fs'

/** 与 asset-pipeline 同一形状，便于注入假实现做单测。 */
export type SpawnLike = (command: string, args: readonly string[]) => Promise<{ code: number; stderr: string }>

export const MIN_CLIP_SECONDS = 0.2
export const MAX_CLIP_SECONDS = 10

export type MatteMode = 'background' | 'chroma' | 'none'

export interface ClipPlan {
  /** 起始秒。 */
  from: number
  /** 结束秒（不含）。 */
  to: number
  matte: MatteMode
  /** chroma 模式的键控色，`0xRRGGBB` 或 `#RRGGBB`。 */
  keyColor?: string
  /** 输出正方形边长，默认 320（桌面宠物角色尺寸量级）。 */
  size?: number
}

export interface ClipResult {
  ok: boolean
  /** 失败时给人看的原因。 */
  error?: string
  /** 失败时"下一步可以怎么办"。 */
  hint?: string
}

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function normalizeColor(raw: string | undefined): string {
  const value = (raw ?? '0x00FF00').trim()
  return value.startsWith('#') ? `0x${value.slice(1)}` : value
}

/**
 * 校验并归一计划；不合法返回可读原因。
 *
 * 抽成纯函数是为了能被单测钉住：这些边界（太短、太长、倒序、非数字）
 * 一旦放过，ffmpeg 要么产出空文件，要么卡住不返回。
 */
export function validatePlan(plan: ClipPlan): { ok: true; plan: Required<Omit<ClipPlan, 'keyColor'>> & { keyColor: string } } | { ok: false; error: string } {
  const from = seconds(plan.from)
  const to = seconds(plan.to)
  if (from === null || to === null) return { ok: false, error: '起止时间必须是数字秒' }
  if (to <= from) return { ok: false, error: '结束时间必须晚于开始时间' }
  const length = to - from
  if (length < MIN_CLIP_SECONDS) return { ok: false, error: `片段太短：至少 ${MIN_CLIP_SECONDS} 秒` }
  if (length > MAX_CLIP_SECONDS) return { ok: false, error: `片段太长：最多 ${MAX_CLIP_SECONDS} 秒（一个动作只需要一两秒）` }
  if (plan.matte !== 'background' && plan.matte !== 'chroma' && plan.matte !== 'none') return { ok: false, error: '抠像方式无效' }
  const size = plan.size ?? 320
  if (!Number.isSafeInteger(size) || size < 64 || size > 1024) return { ok: false, error: '输出尺寸必须是 64–1024 的整数' }
  return { ok: true, plan: { from, to, matte: plan.matte, size, keyColor: normalizeColor(plan.keyColor) } }
}

/**
 * 组装 ffmpeg 参数。
 *
 * 顺序有讲究：**先裁、再抠、最后缩放补边**。
 * 反过来的话，`backgroundkey` 会在缩放后的画面上估计背景，边缘插值把纯净的背景色
 * 混进前景，抠像质量明显变差。
 */
export function planClipArgs(input: string, output: string, plan: ClipPlan): string[] {
  const checked = validatePlan(plan)
  if (!checked.ok) throw new Error(checked.error)
  const value = checked.plan
  const duration = value.to - value.from
  const filters: string[] = []
  if (value.matte === 'background') {
    // threshold 是"场景变化"判据：调高更保守（镜头一动就整体判为不可抠），
    // similarity 是"和背景多像才算背景"。两者都取默认附近的值，不做"看起来很聪明"的调参。
    filters.push('backgroundkey=threshold=0.08:similarity=0.10')
  } else if (value.matte === 'chroma') {
    filters.push(`chromakey=${value.keyColor}:0.30:0.10`)
  }
  // 等比缩到方形内并补透明边：不拉伸，避免脸被压扁。
  filters.push(`scale=${value.size}:${value.size}:force_original_aspect_ratio=decrease`,
    `pad=${value.size}:${value.size}:(ow-iw)/2:(oh-ih)/2:color=black@0`)
  filters.push('fps=24')
  return [
    '-y',
    // -ss 放在 -i 前是快速定位（关键帧），对一两秒的片段足够准，也避免长视频整段解码。
    '-ss', value.from.toFixed(3),
    '-t', duration.toFixed(3),
    '-i', input,
    '-vf', filters.join(','),
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-an',
    output,
  ]
}

/**
 * 执行裁剪。**不抛异常**，而是返回可读结果：这条链路上的失败都是"素材不行"，
 * 不是程序错误，应该让人看见原因并换一段素材，而不是看到一个红叉。
 */
export async function extractClip(deps: {
  ffmpeg: string | null
  spawn: SpawnLike
}, input: string, output: string, plan: ClipPlan): Promise<ClipResult> {
  if (!deps.ffmpeg) {
    return { ok: false, error: '这台机器上没有可用的 ffmpeg', hint: '在形象工作室的模型接入页配置 ffmpeg 路径后重试' }
  }
  if (!existsSync(input)) return { ok: false, error: '找不到这个视频文件', hint: '重新选一次文件；路径可能已经变了' }
  let args: string[]
  try { args = planClipArgs(input, output, plan) }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }

  const result = await deps.spawn(deps.ffmpeg, args)
  if (result.code !== 0 || !existsSync(output)) {
    const stderr = result.stderr.slice(-400)
    // 把最常见的三种失败翻译成人话，原文附在后面方便排查。
    const hint = /Invalid data found|moov atom not found/i.test(stderr)
      ? '这个文件不像视频，或者已经损坏；换一个文件试试'
      : /No such file or directory/i.test(stderr)
        ? '路径里有读不到的部分；把文件放到本地磁盘再试'
        : '如果抠出来是黑的或只剩一半，多半是镜头在动：backgroundkey 只适合固定机位；也可以改用绿幕素材走 chroma 模式'
    return { ok: false, error: `转码失败（退出码 ${result.code}）：${stderr}`, hint }
  }
  return { ok: true }
}
