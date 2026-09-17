/**
 * 视频 → 透明序列帧管线（绿幕/白底自动识别）。
 * 用法：node video-frames.mjs [action ...]
 *   不带参数：处理 candidates/videos/ 下全部 <skin>-<action>.mp4
 *   带参数：只处理指定动作，如 node video-frames.mjs walk write
 * 绿幕帧走色键抠绿；白底帧走 AI 抠像（@imgly/background-removal-node，能分清白毛与白底）。
 * 流程：ffmpeg 抽帧 → 逐帧背景判定 → 抠像 → 全局包围盒对齐裁切 → 512 底部对齐输出。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'
import { removeBackground } from '@imgly/background-removal-node'

const dir = path.dirname(fileURLToPath(import.meta.url))
const videoDir = path.join(dir, 'candidates', 'videos')
const framesRoot = path.resolve(dir, '../../assets/pets/frames')
const tmpRoot = path.join(dir, '.frames-tmp')

const FPS = 10 // 抽帧帧率（播放 8fps 做 0.8 倍轻柔慢放）
const MAX_FRAMES = 64 // 每动作最多保留帧数（10fps×6s 上限）
const CELL = 512 // 输出单元尺寸
const KEY_THRESHOLD = 42 // g - max(r,b) 超过该值判为背景
const SOFT_RANGE = 26 // 阈值附近的软过渡宽度
const ALPHA_CUT = 6 // 包围盒判定的最小不透明度

if (!ffmpegPath) throw new Error('ffmpeg-static 未提供可执行文件，请检查安装')

function extractFrames(video, outDir) {
  mkdirSync(outDir, { recursive: true })
  const args = ['-hide_banner', '-loglevel', 'error', '-i', video, '-vf', `fps=${FPS}`, path.join(outDir, 'raw-%04d.png')]
  const r = spawnSync(ffmpegPath, args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffmpeg 抽帧失败：${video}\n${r.stderr}`)
  const files = readdirSync(outDir).filter(f => f.startsWith('raw-')).sort()
  if (!files.length) throw new Error(`视频没有抽出任何帧：${video}`)
  return files.map(f => path.join(outDir, f))
}

/** 按等间隔把帧列表压缩到最多 max 张（首尾保留）。 */
function sample(list, max) {
  if (list.length <= max) return list
  const step = (list.length - 1) / (max - 1)
  const picked = []
  for (let i = 0; i < max; i++) picked.push(list[Math.round(i * step)])
  return picked
}

/** 色键抠绿 + 去绿溢（就地修改 data）。 */
function keyGreen(data, width, height) {
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    const r = data[o]
    const g = data[o + 1]
    const b = data[o + 2]
    const dominance = g - Math.max(r, b)
    let alpha = 255
    if (dominance >= KEY_THRESHOLD) {
      alpha = 0
    } else if (dominance > KEY_THRESHOLD - SOFT_RANGE) {
      alpha = Math.round(255 * (1 - (dominance - (KEY_THRESHOLD - SOFT_RANGE)) / SOFT_RANGE))
    }
    if (alpha === 0) {
      data[o + 3] = 0
    } else {
      // 去绿溢只作用于半透明边缘像素，保留不透明绿色道具（竹子）的原色
      if (alpha < 255 && g > r && g > b) data[o + 1] = Math.round((g + Math.max(r, b)) / 2)
      data[o + 3] = Math.min(data[o + 3], alpha)
    }
  }
}

/** 绿幕帧：从四边漫水清除与边界连通的偏绿雾状残留（白毛不偏绿，不会被误删）。 */
function removeBorderGreenHaze(data, width, height) {
  const pass = o => data[o + 3] === 0 || (data[o + 1] - Math.max(data[o], data[o + 2]) > 6 && (data[o] + data[o + 1] + data[o + 2]) / 3 > 100)
  const visited = new Uint8Array(width * height)
  const stack = []
  const seed = (x, y) => {
    const p = y * width + x
    if (!visited[p]) {
      visited[p] = 1
      stack.push(p)
    }
  }
  for (let x = 0; x < width; x++) {
    seed(x, 0)
    seed(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    seed(0, y)
    seed(width - 1, y)
  }
  while (stack.length) {
    const p = stack.pop()
    const o = p * 4
    if (!pass(o)) continue
    data[o + 3] = 0
    const x = p % width
    const y = (p / width) | 0
    if (x > 0 && !visited[p - 1]) {
      visited[p - 1] = 1
      stack.push(p - 1)
    }
    if (x < width - 1 && !visited[p + 1]) {
      visited[p + 1] = 1
      stack.push(p + 1)
    }
    if (y > 0 && !visited[p - width]) {
      visited[p - width] = 1
      stack.push(p - width)
    }
    if (y < height - 1 && !visited[p + width]) {
      visited[p + width] = 1
      stack.push(p + width)
    }
  }
}

/** AI 抠像帧：清除角色边缘半透明偏绿光晕（不透明绿色道具保留）。 */
function removeGreenHalo(data, width, height) {
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    const a = data[o + 3]
    if (a === 0 || a >= 252) continue
    if (data[o + 1] - Math.max(data[o], data[o + 2]) > 6) data[o + 3] = 0
  }
}

/** 连通域过滤：删除面积小于 minArea 的碎块（水印残字/噪点），保留角色与道具。 */
function dropSmallComponents(data, width, height, minArea = 2000) {
  const comp = new Int32Array(width * height).fill(-1)
  const sizes = []
  const stack = []
  for (let s = 0; s < width * height; s++) {
    if (comp[s] !== -1 || data[s * 4 + 3] <= ALPHA_CUT) continue
    const id = sizes.length
    sizes.push(0)
    stack.push(s)
    comp[s] = id
    while (stack.length) {
      const p = stack.pop()
      sizes[id]++
      const x = p % width
      const y = (p / width) | 0
      const nb = [p - 1, p + 1, p - width, p + width]
      const ok = [x > 0, x < width - 1, y > 0, y < height - 1]
      for (let k = 0; k < 4; k++) {
        const q = nb[k]
        if (!ok[k] || comp[q] !== -1 || data[q * 4 + 3] <= ALPHA_CUT) continue
        comp[q] = id
        stack.push(q)
      }
    }
  }
  for (let p = 0; p < width * height; p++) {
    const id = comp[p]
    if (id !== -1 && sizes[id] < minArea) data[p * 4 + 3] = 0
  }
}

/** 豆包视频右下角有"豆包AI生成"水印：该区域偏绿像素直接清零（角色是黑白/棕色，不受影响）。 */
function clearWatermark(data, width, height) {
  const x0 = Math.floor(width * 0.7)
  const y0 = Math.floor(height * 0.84)
  for (let y = y0; y < height; y++) {
    const row = y * width
    for (let x = x0; x < width; x++) {
      const o = (row + x) * 4
      if (data[o + 3] === 0) continue
      if (data[o + 1] - Math.max(data[o], data[o + 2]) > 4) data[o + 3] = 0
    }
  }
}

/** 逐帧背景判定 + 抠像：角点偏绿 → 色键；否则（白底等）→ AI 抠像。 */
async function framePixels(file) {
  const probe = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const w = probe.info.width
  const h = probe.info.height
  const o = (8 * w + 8) * 4
  const greenish = probe.data[o + 1] - Math.max(probe.data[o], probe.data[o + 2]) > 10

  if (greenish) {
    keyGreen(probe.data, w, h)
    removeBorderGreenHaze(probe.data, w, h)
    dropSmallComponents(probe.data, w, h)
    clearWatermark(probe.data, w, h)
    return { data: probe.data, width: w, height: h }
  }

  const buf = readFileSync(file)
  const matted = await removeBackground(new Blob([buf], { type: 'image/png' }), { output: { format: 'image/png' } })
  const m = await sharp(Buffer.from(await matted.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  removeGreenHalo(m.data, m.info.width, m.info.height)
  dropSmallComponents(m.data, m.info.width, m.info.height)
  clearWatermark(m.data, m.info.width, m.info.height)
  return { data: m.data, width: m.info.width, height: m.info.height }
}

/** 计算一帧的内容包围盒。 */
function bounds(img) {
  const { data, width, height } = img
  let top = height
  let bottom = -1
  let left = width
  let right = -1
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      if (data[(row + x) * 4 + 3] > ALPHA_CUT) {
        if (y < top) top = y
        if (y > bottom) bottom = y
        if (x < left) left = x
        if (x > right) right = x
      }
    }
  }
  if (bottom < 0) return null
  return { top, bottom, left, right }
}

async function processAction(video) {
  const base = path.basename(video, path.extname(video)) // e.g. panda-walk
  const dash = base.indexOf('-')
  const skin = dash < 0 ? 'panda' : base.slice(0, dash)
  const action = dash < 0 ? base : base.slice(dash + 1)
  const outDir = path.join(framesRoot, skin, action)
  const tmpDir = path.join(tmpRoot, base)
  rmSync(tmpDir, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })

  console.log(`[${base}] 抽帧…`)
  const rawFrames = sample(extractFrames(video, tmpDir), MAX_FRAMES)

  console.log(`[${base}] 抠像 ${rawFrames.length} 帧（绿幕色键 / 白底AI）…`)
  const keyed = []
  for (const f of rawFrames) keyed.push(await framePixels(f))

  // 全局包围盒：所有帧共用同一裁切区域，避免帧间跳动
  let gTop = Infinity
  let gBottom = -1
  let gLeft = Infinity
  let gRight = -1
  for (const img of keyed) {
    const b = bounds(img)
    if (!b) continue
    gTop = Math.min(gTop, b.top)
    gBottom = Math.max(gBottom, b.bottom)
    gLeft = Math.min(gLeft, b.left)
    gRight = Math.max(gRight, b.right)
  }
  if (gBottom < 0) throw new Error(`[${base}] 所有帧都是空的，抠不出内容`)

  const cw = gRight - gLeft + 1
  const ch = gBottom - gTop + 1
  mkdirSync(outDir, { recursive: true })
  for (let i = 0; i < keyed.length; i++) {
    const img = keyed[i]
    // 512 单元，底部对齐（脚踩地面线）
    const scale = Math.min(CELL / cw, CELL / ch)
    const dw = Math.max(1, Math.round(cw * scale))
    const dh = Math.max(1, Math.round(ch * scale))
    const cropped = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
      .extract({ left: gLeft, top: gTop, width: cw, height: ch })
      .resize(dw, dh)
      .png()
      .toBuffer()
    const canvas = await sharp({
      create: { width: CELL, height: CELL, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: cropped, left: Math.round((CELL - dw) / 2), top: CELL - dh }])
      .png()
      .toBuffer()
    const name = `f${String(i + 1).padStart(3, '0')}.png`
    await sharp(canvas).png().toFile(path.join(outDir, name))
  }
  rmSync(tmpDir, { recursive: true, force: true })
  console.log(`[${base}] 完成：${keyed.length} 帧 → ${path.relative(process.cwd(), outDir)}`)
}

const only = process.argv.slice(2)
const videos = readdirSync(videoDir).filter(f => /\.mp4$/i.test(f))
const targets = videos.filter(v => {
  if (!only.length) return true
  const base = path.basename(v, path.extname(v))
  const dash = base.indexOf('-')
  const action = dash < 0 ? base : base.slice(dash + 1)
  return only.includes(action)
})

if (!targets.length) {
  console.log(only.length ? `videos/ 里没找到指定动作的视频：${only.join(', ')}` : 'videos/ 目录为空，先把豆包生成的视频放进来。')
  process.exit(0)
}

for (const v of targets) await processAction(path.join(videoDir, v))
rmSync(tmpRoot, { recursive: true, force: true })
console.log('全部完成。')
