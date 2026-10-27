/**
 * 固定话术的语音缓存：同一句、同一音色只合成一次。
 *
 * 为什么值得做：唤醒应答是**每次**唤醒都要播的一句。它虽然短，但每句都要走一次云端
 * 合成往返（几百毫秒到几秒）——用户喊完名字后那段空白就是它。这些句子是固定的，
 * 合成结果自然也是固定的，没有理由每次都重新花钱、重新等。
 *
 * 缓存键是 `音色 + 文本` 的指纹：换音色后旧音频对不上，自然失效、重新合成，
 * 不需要额外的失效逻辑；旧的也不删，因为用户往往会在两个音色之间来回切。
 *
 * 落盘位置是 userData 下的 `tts-cache/`，不受版本升级影响（不像临时目录会被清）。
 * 只存合成的音频文件，不存任何文本之外的信息，也不进仓库。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'

/** 每条缓存一个文件；超过这个总大小就按最久未访问的删，避免无限长大。 */
const MAX_CACHE_BYTES = 64 * 1024 * 1024

export interface TtsCacheKey {
  /** 当前合成服务的标识（模型 + 音色）。换服务或换音色都会改变它。 */
  readonly voiceKey: string
  readonly text: string
}

/**
 * 音色指纹。把模型与音色拼起来，任一变化都算换音色。
 *
 * `provider`/`endpoint` 也一并纳入：同一个音色名在不同服务上声音并不相同。
 */
export function voiceFingerprint(parts: {
  readonly model?: string
  readonly voice?: string
  readonly provider?: string
  readonly endpoint?: string
}): string {
  return createHash('sha256').update(JSON.stringify([
    parts.provider ?? '',
    parts.endpoint ?? '',
    parts.model ?? '',
    parts.voice ?? '',
  ])).digest('hex').slice(0, 16)
}

function digestOf(key: TtsCacheKey): string {
  return createHash('sha256').update(`${key.voiceKey}\u0000${key.text}`, 'utf8').digest('hex')
}

export class TtsCache {
  private readonly dir: string
  private ready = false

  constructor(rootDir: string) {
    this.dir = path.join(rootDir, 'tts-cache')
  }

  private ensureDir(): void {
    if (this.ready) return
    mkdirSync(this.dir, { recursive: true })
    this.ready = true
  }

  /**
   * 只判断有没有，不读内容。
   *
   * 唤醒时要在一组固定话术里挑"已经有音频"的那几句，逐条 readFileSync 会把几十 KB
   * 读进主线程再丢掉；这里只做一次存在性检查。
   */
  has(key: TtsCacheKey): boolean {
    try {
      return existsSync(path.join(this.dir, `${digestOf(key)}.bin`))
    } catch {
      return false
    }
  }

  /** 命中就返回音频字节；没有（或读不出来）返回 null，调用方照常去合成。 */
  get(key: TtsCacheKey): Buffer | null {
    const file = path.join(this.dir, `${digestOf(key)}.bin`)
    try {
      if (!existsSync(file)) return null
      const buffer = readFileSync(file)
      if (buffer.length === 0) return null
      return buffer
    } catch {
      return null
    }
  }

  /** 写入缓存。失败不抛：缓存是加速手段，写不进去不能影响这次播放。 */
  put(key: TtsCacheKey, audio: Buffer): void {
    try {
      this.ensureDir()
      this.prune()
      writeFileSync(path.join(this.dir, `${digestOf(key)}.bin`), audio)
    } catch {
      // 磁盘满 / 权限不足：静默放弃缓存，下一次照常重新合成。
    }
  }

  /** 缓存总量超限时按最久未写入的删到阈值以下。 */
  private prune(): void {
    try {
      const files = readdirSync(this.dir)
        .filter(name => name.endsWith('.bin'))
        .map(name => {
          const file = path.join(this.dir, name)
          try { return { file, size: statSync(file).size, at: statSync(file).mtimeMs } } catch { return null }
        })
        .filter((item): item is { file: string; size: number; at: number } => item !== null)
        .sort((a, b) => a.at - b.at)
      let total = files.reduce((sum, item) => sum + item.size, 0)
      for (const item of files) {
        if (total <= MAX_CACHE_BYTES) break
        try { unlinkSync(item.file); total -= item.size } catch { /* 被占用就下次再删 */ }
      }
    } catch {
      // 目录不存在或不可读：这次不淘汰。
    }
  }
}
