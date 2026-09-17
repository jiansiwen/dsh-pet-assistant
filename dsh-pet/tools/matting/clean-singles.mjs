/**
 * 单帧素材清理：连通域过滤删除水印残字/噪点碎块（面积<2000），保留角色主体。
 * 用法：node clean-singles.mjs [文件...]（不带参数=处理 assets/pets/ 下全部单帧 png）
 */
import sharp from 'sharp'
import path from 'node:path'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const petsDir = path.resolve(dir, '../../assets/pets')
const ALPHA_CUT = 6
const MIN_AREA = 2000

async function clean(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
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
      if (x > 0 && comp[p - 1] === -1 && data[(p - 1) * 4 + 3] > ALPHA_CUT) {
        comp[p - 1] = id
        stack.push(p - 1)
      }
      if (x < width - 1 && comp[p + 1] === -1 && data[(p + 1) * 4 + 3] > ALPHA_CUT) {
        comp[p + 1] = id
        stack.push(p + 1)
      }
      if (y > 0 && comp[p - width] === -1 && data[(p - width) * 4 + 3] > ALPHA_CUT) {
        comp[p - width] = id
        stack.push(p - width)
      }
      if (y < height - 1 && comp[p + width] === -1 && data[(p + width) * 4 + 3] > ALPHA_CUT) {
        comp[p + width] = id
        stack.push(p + width)
      }
    }
  }
  let removed = 0
  for (let p = 0; p < width * height; p++) {
    const id = comp[p]
    if (id !== -1 && sizes[id] < MIN_AREA) {
      data[p * 4 + 3] = 0
      removed++
    }
  }
  if (removed > 0) {
    await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(file)
  }
  console.log(path.basename(file), '组件数', sizes.length, '清除像素', removed)
}

const only = process.argv.slice(2)
const files = only.length
  ? only.map(f => path.join(petsDir, f))
  : readdirSync(petsDir).filter(f => f.endsWith('.png')).map(f => path.join(petsDir, f))

for (const f of files) await clean(f)
console.log('完成。记得在 dsh-pet 目录 pnpm build 拷贝到 dist。')
