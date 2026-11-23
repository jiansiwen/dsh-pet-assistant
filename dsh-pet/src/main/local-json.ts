import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 同目录改名：写失败时保留原配置，不先截空正式文件。 */
export function writeLocalJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temp, file)
  } finally { rmSync(temp, { force: true }) }
}
