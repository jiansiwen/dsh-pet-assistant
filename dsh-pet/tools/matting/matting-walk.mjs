import { removeBackground } from '@imgly/background-removal-node'
import sharp from 'sharp'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const cand = (f) => path.join(dir, 'candidates', f)
const out = (f) => path.resolve(dir, '../../assets/pets', f)

const src = process.argv[2]
const dst = process.argv[3]
const frames = 4
const CELL = 512

const buf = readFileSync(cand(src))
const blob = new Blob([buf], { type: 'image/png' })
const matted = await removeBackground(blob, { output: { format: 'image/png' } })
const mattedRaw = Buffer.from(await matted.arrayBuffer())

// 清除左上角水印残留
const wm = await sharp(mattedRaw).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const ww = Math.floor(wm.info.width * 0.09)
const wh = Math.floor(wm.info.height * 0.3)
for (let y = 0; y < wh; y++) {
  for (let x = 0; x < ww; x++) {
    wm.data[(y * wm.info.width + x) * 4 + 3] = 0
  }
}
const raw = await sharp(wm.data, { raw: { width: wm.info.width, height: wm.info.height, channels: 4 } }).png().toBuffer()

const meta = await sharp(raw).metadata()
const W = meta.width, H = meta.height
const colW = Math.floor(W / frames)

const cells = []
for (let i = 0; i < frames; i++) {
  const left = i * colW
  const cellBuf = await sharp(raw).extract({ left, top: 0, width: colW, height: H }).toBuffer()
  // 垂直方向贴合内容
  const c = await sharp(cellBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let top = H, bottom = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < colW; x++) {
    if (c.data[(y * colW + x) * 4 + 3] > 8) { if (y < top) top = y; if (y > bottom) bottom = y }
  }
  if (bottom < 0) { top = 0; bottom = H - 1 }
  const ch = bottom - top + 1
  const cell = await sharp(cellBuf)
    .extract({ left: 0, top, width: colW, height: ch })
    .resize(CELL, CELL, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer()
  cells.push(cell)
}

const order = [0, 1, 2, 3, 2, 1]
const seq = order.map(i => cells[i])

const strip = await sharp({ create: { width: CELL * seq.length, height: CELL, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite(seq.map((b, i) => ({ input: b, left: i * CELL, top: 0 })))
  .png()
  .toBuffer()

writeFileSync(out(dst), strip)
console.log('OK', dst, `${CELL * seq.length}x${CELL}`, strip.length)
