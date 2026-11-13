/**
 * 私有配置文件写入：临时文件 + fsync + rename，权限 0o600。
 *
 * 凭据类文件不能有"写了一半"的中间态：进程崩在中间时，读者只会看到旧文件或新文件，
 * 不会看到半截 JSON。临时文件带随机后缀、`wx` 独占创建，避免并发写互相踩。
 */
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 只有当前用户可读写（`0o600`）。Windows 上 mode 基本被忽略，但语义写清楚不吃亏。 */
export const PRIVATE_MODE = 0o600

export function writePrivateFile(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: PRIVATE_MODE, flag: 'wx' })
    const fd = openSync(temporary, 'r+')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, file)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* 临时文件可能根本没建出来 */ }
    throw error
  }
}
