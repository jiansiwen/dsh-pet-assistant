import { removeBackground } from '@imgly/background-removal-node'
import sharp from 'sharp'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const cand = (f) => path.join(dir, 'candidates', f)
const out = (f) => path.resolve(dir, '../../assets/pets', f)

// 用法: node matting-acts.mjs <raw.png> <prefix>   依次输出 prefix-sit/read/play/lie/write.png
const src = process.argv[2]
const prefix = process.argv[3]
const names = ['sit', 'read', 'play', 'lie', 'write']
const N = names.length
const CELL = 512

const buf = readFileSync(cand(src))
const blob = new Blob([buf], { type: 'image/png' })
const matted = await removeBackground(blob, { output: { format: 'image/png' } })
const mattedRaw = Buffer.from(await matted.arrayBuffer())

// 清除左上角水印
const wm = await sharp(mattedRaw).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const ww = Math.floor(wm.info.width * 0.09)
const wh = Math.floor(wm.info.height * 0.3)
for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) wm.data[(y * wm.info.width + x) * 4 + 3] = 0
const raw = await sharp(wm.data, { raw: { width: wm.info.width, height: wm.info.height, channels: 4 } }).png().toBuffer()

const meta = await sharp(raw).metadata()
const W = meta.width, H = meta.height

// 列 alpha 投影，找连续有内容的列段
const full = await sharp(raw).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const colAlpha = new Array(W).fill(0)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) colAlpha[x] += full.data[(y * W + x) * 4 + 3]

const segs = []
let start = -1
for (let x = 0; x <= W; x++) {
  const on = x < W && colAlpha[x] > 0
  if (on && start < 0) start = x
  if (!on && start >= 0) { segs.push([start, x]); start = -1 }
}
// 取宽度最大的 N 段，按左到右排序
const use = segs
  .sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))
  .slice(0, N)
  .sort((a, b) => a[0] - b[0])
console.log('segments:', use.map(s => s[1] - s[0]).join(','))

for (let i = 0; i < N; i++) {
  const [a, b] = use[i] || [ (W / N) * i, (W / N) * (i + 1) ]
  const cropW = b - a
  const cellBuf = await sharp(raw).extract({ left: a, top: 0, width: cropW, height: H }).toBuffer()
  const c = await sharp(cellBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let top = H, bottom = -1, lft = cropW, rgt = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < cropW; x++) {
    if (c.data[(y * cropW + x) * 4 + 3] > 8) {
      if (y < top) top = y
      if (y > bottom) bottom = y
      if (x < lft) lft = x
      if (x > rgt) rgt = x
    }
  }
  if (bottom < 0 || rgt < 0) { top = 0; bottom = H - 1; lft = 0; rgt = cropW - 1 }
  const ch = bottom - top + 1
  const cw = rgt - lft + 1
  const cell = await sharp(cellBuf)
    .extract({ left: lft, top, width: cw, height: ch })
    .resize(CELL, CELL, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  const file = `${prefix}-${names[i]}.png`
  writeFileSync(out(file), cell)
  console.log('OK', file)
}
