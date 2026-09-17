/**
 * 形象素材加载：优先读取本地 assets/pets/<skin>[-<act>].png（AI 透明底图），
 * 自动用"从边缘漫水填充"去除纯色/渐变背景（保留角色内部白色），失败则回退 null（渲染层回退 SVG）。
 *
 * 素材按皮肤在模块级共享缓存，见 loadSkinImages / loadSkinFrames。
 */
import { useEffect, useState } from 'react'

function removeBackground(img: HTMLImageElement): string | null {
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (!w || !h) return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0)
  const image = ctx.getImageData(0, 0, w, h)
  const d = image.data

  const idx = (x: number, y: number) => (y * w + x) * 4
  const colorAt = (i: number) => [d[i], d[i + 1], d[i + 2]] as const

  // 若四角已有透明，认为本身是透明图，直接返回
  const corners = [idx(0, 0), idx(w - 1, 0), idx(0, h - 1), idx(w - 1, h - 1)]
  if (corners.every(i => d[i + 3] === 0)) return canvas.toDataURL()

  const [br, bg, bb] = colorAt(corners[0])
  const tol = 60
  const match = (i: number) => {
    const dr = d[i] - br
    const dg = d[i + 1] - bg
    const db = d[i + 2] - bb
    return dr * dr + dg * dg + db * db < tol * tol * 3
  }

  const visited = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const p = y * w + x
    if (visited[p]) return
    visited[p] = 1
    const i = p * 4
    if (d[i + 3] !== 0 && match(i)) stack.push(p)
  }
  for (let x = 0; x < w; x++) {
    push(x, 0)
    push(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    push(0, y)
    push(w - 1, y)
  }
  while (stack.length) {
    const p = stack.pop()!
    const i = p * 4
    d[i + 3] = 0
    const x = p % w
    const y = (p / w) | 0
    push(x + 1, y)
    push(x - 1, y)
    push(x, y + 1)
    push(x, y - 1)
  }
  ctx.putImageData(image, 0, 0)
  return canvas.toDataURL()
}

function loadOne(file: string): Promise<string | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      try {
        resolve(removeBackground(img))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = `../assets/pets/${file}`
  })
}

/** 仅探测可加载性并返回原 URL（用于已抠好的序列帧，避免重复画布处理）。 */
function loadOneRaw(url: string): Promise<string | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => resolve(url)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

export const SKIN_IMAGE_KEYS = ['idle', 'walk', 'sit', 'read', 'play', 'lie', 'write'] as const
export type SkinImageKey = (typeof SKIN_IMAGE_KEYS)[number]
export type SkinImages = Partial<Record<SkinImageKey, string>>

const fileFor = (skin: string, key: SkinImageKey) => (key === 'idle' ? `${skin}.png` : `${skin}-${key}.png`)

/** 可能有绿幕视频序列帧的动作（含拖拽专用的 grab）。 */
const FRAME_ACTIONS = ['idle', 'walk', 'read', 'play', 'lie', 'write', 'jump', 'wave', 'sleep', 'grab'] as const
const FRAME_MAX = 64

const frameUrl = (skin: string, action: string, n: number) =>
  `../assets/pets/frames/${skin}/${action}/f${String(n).padStart(3, '0')}.png`

export type SkinFrames = Partial<Record<string, string[]>>

const imagesCache = new Map<string, Promise<SkinImages>>()
const framesCache = new Map<string, Promise<SkinFrames>>()

/**
 * 共享素材缓存：按皮肤缓存 **Promise**，不是缓存结果。
 *
 * 占位期唐僧、沙僧、白龙马的 skinId 都是 panda，而多角色舞台是一起挂载的。只缓存结果的
 * 话三个 effect 会在同一轮里同时 miss，照样读三遍盘、跑三遍漫水填充抠图；缓存 Promise
 * 才能让后两个直接挂到第一个的在途请求上。
 *
 * 序列帧探测的代价是每皮肤最多 10×64=640 次图片加载，panda 三份就是 1920 次。
 */
export function loadSkinImages(skin: string): Promise<SkinImages> {
  const cached = imagesCache.get(skin)
  if (cached) return cached
  const task = Promise.all(
    SKIN_IMAGE_KEYS.map((key) => loadOne(fileFor(skin, key)).then((src) => [key, src] as const)),
  ).then((entries) => {
    const map: SkinImages = {}
    for (const [key, src] of entries) if (src) map[key] = src
    return map
  })
  imagesCache.set(skin, task)
  // 失败的皮肤不能把 rejected promise 永久钉在缓存里，否则它再也加载不出来。
  void task.catch(() => imagesCache.delete(skin))
  return task
}

export function loadSkinFrames(skin: string): Promise<SkinFrames> {
  const cached = framesCache.get(skin)
  if (cached) return cached

  const probe = async (action: string): Promise<[string, string[]] | null> => {
    const first = await loadOneRaw(frameUrl(skin, action, 1))
    if (!first) return null
    const rest = await Promise.all(
      Array.from({ length: FRAME_MAX - 1 }, (_, i) => loadOneRaw(frameUrl(skin, action, i + 2))),
    )
    const list = [first]
    for (const src of rest) {
      if (!src) break
      list.push(src)
    }
    return [action, list]
  }

  const task = Promise.all(FRAME_ACTIONS.map(probe)).then((entries) => {
    const map: SkinFrames = {}
    for (const entry of entries) if (entry) map[entry[0]] = entry[1]
    return map
  })
  framesCache.set(skin, task)
  void task.catch(() => framesCache.delete(skin))
  return task
}

/** 缓存条目数。舞台测试用它断言"N 个同皮肤角色只加载一份素材"。 */
export function petAssetCacheStats(): { images: number; frames: number } {
  return { images: imagesCache.size, frames: framesCache.size }
}

export function clearPetAssetCache(): void {
  imagesCache.clear()
  framesCache.clear()
}

/** 加载某皮肤的全套素材（主形象 + 行走 + 居家活动），缺少的键不出现在结果里。 */
export function usePetSkinImages(skin: string): SkinImages {
  const [imgs, setImgs] = useState<SkinImages>({})

  useEffect(() => {
    let cancelled = false
    setImgs({})
    void loadSkinImages(skin).then((result) => {
      if (!cancelled) setImgs(result)
    })
    return () => {
      cancelled = true
    }
  }, [skin])

  return imgs
}

/**
 * 探测加载某皮肤的序列帧素材（video-frames.mjs 的产物）。
 * 先探 f001，存在才继续探其余编号；结果按连续前缀截断，保证播放器不跳帧。
 */
export function usePetFrames(skin: string): SkinFrames {
  const [frames, setFrames] = useState<SkinFrames>({})

  useEffect(() => {
    let cancelled = false
    setFrames({})
    void loadSkinFrames(skin).then((result) => {
      if (!cancelled) setFrames(result)
    })
    return () => {
      cancelled = true
    }
  }, [skin])

  return frames
}

/** 兼容旧用法：只加载主形象。走同一份缓存，不额外读盘。 */
export function usePetImage(skin: string): string | null {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSrc(null)
    void loadSkinImages(skin).then((result) => {
      if (!cancelled) setSrc(result.idle ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [skin])

  return src
}
