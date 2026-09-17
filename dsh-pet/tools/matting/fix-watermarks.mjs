/**
 * 一次性水印修复（保守版）：
 * A) 半透明白灰描边（背景上）→ 透明
 * B) 不透明中灰且被黑毛完全包围（烙印水印）→ 还原黑
 * 不做邻域透明判定、不动边缘像素，避免啃坏角色轮廓。
 * 用法：node fix-watermarks.mjs
 */
import sharp from 'sharp'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const pets = f => path.resolve(dir, '../../assets/pets', f)

const JOBS = [
  { file: 'panda-sit.png', box: [0, 30, 300, 215], ebox: [0, 30, 250, 215], wbox: [262, 85, 300, 155] },
  { file: 'girl-glasses-sit.png', box: [120, 0, 330, 135], ebox: null, wbox: null },
  { file: 'panda-walk.png', box: [130, 0, 330, 160], ebox: [130, 0, 260, 160], wbox: [130, 0, 260, 80] },
]

for (const job of JOBS) {
  const file = pets(job.file)
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const W = info.width
  const H = info.height
  const [x0, y0, x1, y1] = job.box
  const at = (x, y) => {
    const o = (y * W + x) * 4
    return { a: data[o + 3], lum: (data[o] + data[o + 1] + data[o + 2]) / 3 }
  }
  const inE = (x, y) => Boolean(job.ebox) && x >= job.ebox[0] && y >= job.ebox[1] && x < job.ebox[2] && y < job.ebox[3]
  let a = 0
  let b = 0
  let d = 0
  for (let y = y0; y < Math.min(y1, H); y++) {
    for (let x = x0; x < Math.min(x1, W); x++) {
      const o = (y * W + x) * 4
      const al = data[o + 3]
      if (al === 0) continue
      const r = data[o]
      const g = data[o + 1]
      const bl = data[o + 2]
      const mx = Math.max(r, g, bl)
      const mn = Math.min(r, g, bl)
      const lum = (r + g + bl) / 3
      const darkSurrounded = () => {
        for (const [dx, dy] of [[-2, -2], [0, -2], [2, -2], [-2, 0], [2, 0], [-2, 2], [0, 2], [2, 2]]) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) return false
          const n = at(nx, ny)
          if (n.a < 200 || n.lum >= 120) return false
        }
        return true
      }
      const ds = darkSurrounded()
      if (al < 250 && mx - mn < 40 && (lum > 70 || (inE(x, y) && lum > 40))) {
        if (ds) {
          // 黑毛上的半透明白边：压黑保留 alpha，避免穿孔
          data[o] = 25
          data[o + 1] = 25
          data[o + 2] = 28
          d++
        } else {
          data[o + 3] = 0
          a++
        }
      } else if (al >= 250 && mx - mn < 35 && lum >= 20 && lum <= 210 && ds) {
        data[o] = 25
        data[o + 1] = 25
        data[o + 2] = 28
        b++
      } else if (al >= 250 && mx - mn < 30 && lum > 210 && ds) {
        // 烙在黑毛上的白色水印 → 还原黑
        data[o] = 25
        data[o + 1] = 25
        data[o + 2] = 28
        d++
      }
    }
  }
  // 迭代剥层：逐圈吃掉烙在黑毛上的亮白水印字
  for (let iter = 0; iter < 20; iter++) {
    let changed = 0
    for (let y = y0; y < Math.min(y1, H); y++) {
      for (let x = x0; x < Math.min(x1, W); x++) {
        const o = (y * W + x) * 4
        const al = data[o + 3]
        if (al < 250) continue
        const r = data[o]
        const g = data[o + 1]
        const bl = data[o + 2]
        const mx = Math.max(r, g, bl)
        const mn = Math.min(r, g, bl)
        const lum = (r + g + bl) / 3
        if (!(mx - mn < 60 && lum > 90)) continue
        let darkN = 0
        let transN = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
              transN++
              continue
            }
            const no = (ny * W + nx) * 4
            if (data[no + 3] < 50) transN++
            else if (data[no + 3] > 200 && (data[no] + data[no + 1] + data[no + 2]) / 3 < 120) darkN++
          }
        }
        if (transN >= 5) {
          data[o + 3] = 0
          changed++
        } else if (lum <= 210 ? darkN >= 3 : darkN >= 7) {
          data[o] = 25
          data[o + 1] = 25
          data[o + 2] = 28
          changed++
        }
      }
    }
    d += changed
    if (changed === 0) break
  }
  // wbox 小区域内激进规则：骑在黑毛/背景交界的水印残块
  if (job.wbox) {
    const [wx0, wy0, wx1, wy1] = job.wbox
    for (let y = wy0; y < Math.min(wy1, H); y++) {
      for (let x = wx0; x < Math.min(wx1, W); x++) {
        const o = (y * W + x) * 4
        const al = data[o + 3]
        if (al < 250) continue
        const r = data[o]
        const g = data[o + 1]
        const bl = data[o + 2]
        if (Math.max(r, g, bl) - Math.min(r, g, bl) >= 40) continue
        const lum = (r + g + bl) / 3
        if (lum <= 150) continue
        let darkN = 0
        let transN = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
              transN++
              continue
            }
            const no = (ny * W + nx) * 4
            if (data[no + 3] < 50) transN++
            else if (data[no + 3] > 200 && (data[no] + data[no + 1] + data[no + 2]) / 3 < 120) darkN++
          }
        }
        if (darkN >= 4) {
          data[o] = 25
          data[o + 1] = 25
          data[o + 2] = 28
          d++
        } else if (transN >= 4) {
          data[o + 3] = 0
          a++
        }
      }
    }
    // 补洞：透明点左右 8px 内都是黑毛 → 填黑（修复早前误删的耳部竖洞）
    for (let y = wy0; y < Math.min(wy1, H); y++) {
      for (let x = wx0; x < Math.min(wx1, W); x++) {
        const o = (y * W + x) * 4
        if (data[o + 3] >= 50) continue
        const darkSide = dir => {
          for (let k = 1; k <= 8; k++) {
            const nx = x + dir * k
            if (nx < 0 || nx >= W) return false
            const no = (y * W + nx) * 4
            if (data[no + 3] > 200 && (data[no] + data[no + 1] + data[no + 2]) / 3 < 120) return true
            if (data[no + 3] > 200) return false
          }
          return false
        }
        if (darkSide(-1) && darkSide(1)) {
          data[o] = 25
          data[o + 1] = 25
          data[o + 2] = 28
          data[o + 3] = 255
          d++
        }
      }
    }
  }
  await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toFile(file)
  console.log(job.file, '透明化', a, '还原黑(中灰)', b, '还原黑(亮白)', d)
}
console.log('完成。')