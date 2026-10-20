/**
 * 助理业务库：连接、共用编解码与摘要。
 *
 * 记忆和日报版本落在同一个 SQLite 文件里，但各建各的表。合库的理由不是省一个文件，
 * 而是删除要跨这两类传播——删掉一条来源记忆，由它支撑的日报版本也得跟着标失效，
 * 分库就要引入跨库事务，那比多一个文件贵得多。
 *
 * 与旧的 `personal_assistant` 存储域并存、互不覆盖：旧域版本 0 不原地升级（design.md §9.3），
 * 这里只作为只读导入源被 migrate.ts 读取。
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** node:sqlite 返回的行形状；列值只可能是这四种。 */
export type Row = Record<string, string | number | bigint | null>

/** 助理业务库 schema 版本。单调递增，只加显式迁移，不靠"改个版本号"糊过去。 */
export const ASSISTANT_SCHEMA_VERSION = 2

/** v2：user_flags —— 用户在运行时做出的、重启后必须仍然成立的意愿（如关闭主动提醒）。 */
const USER_FLAGS_DDL = `
CREATE TABLE IF NOT EXISTS user_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID
`

export function openAssistantStore(dbPath: string): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  const row = db.prepare('PRAGMA user_version').get() as Row | undefined
  const current = Number(row?.user_version ?? 0)
  // 库比程序新说明用户回退了插件版本。这时候写入会把新形状的数据写坏，
  // 而且坏了也看不出来——直接拒绝启动，让报错停在最前面。
  if (current > ASSISTANT_SCHEMA_VERSION) {
    throw new Error(
      `assistant store schema ${current} is newer than supported ${ASSISTANT_SCHEMA_VERSION}`,
    )
  }
  if (current < 2) {
    db.exec(USER_FLAGS_DDL)
    db.exec(`PRAGMA user_version = ${ASSISTANT_SCHEMA_VERSION}`)
  }
  return db
}

/** 读一个用户意愿标记。没有记录返回 null。 */
export function getUserFlag(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM user_flags WHERE key = ?').get(key) as Row | undefined
  return row === undefined ? null : String(row.value)
}

/** 写一个用户意愿标记。INSERT OR REPLACE：标记是"现在的意愿"，没有历史版本可言。 */
export function setUserFlag(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO user_flags (key, value) VALUES (?, ?)').run(key, value)
}

/** 内容摘要。确认、发布作业和删除账本都靠它把"用户点头的那份内容"钉死。 */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? null)
}

export function bool(value: boolean): number {
  return value ? 1 : 0
}

/** SQLite 的 NULL 转成 TS 的 null，顺手把非字符串挡掉。 */
export function text(value: string | number | bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value)
}

export function parseStringList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    // 手改过库或者旧版本写坏了：当成没有来源，比让整个读取崩掉好。
    return []
  }
}

/** 每个连接当前的事务嵌套深度。 */
const transactionDepth = new WeakMap<DatabaseSync, number>()

/**
 * 在事务里执行；抛错即回滚，不留半条写入。
 *
 * 可以重入：内层调用跟随外层一起提交或回滚，不自己再开一个。
 * 这不是为了方便——`put` 要在同一个事务里写新记忆并改判冲突的旧记忆，
 * 而写记忆那段逻辑 `importRecord` 也要用，两边都得能独立成立。
 * SQLite 对嵌套 BEGIN 直接报错，所以深度只能自己记。
 */
export function inTransaction<T>(db: DatabaseSync, body: () => T): T {
  const nesting = transactionDepth.get(db) ?? 0
  transactionDepth.set(db, nesting + 1)
  try {
    if (nesting > 0) return body()
    db.exec('BEGIN')
    try {
      const result = body()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    transactionDepth.set(db, nesting)
  }
}

/**
 * 在一个**必定回滚**的事务里执行：删除影响预览专用。
 *
 * 预览不另写一套"大概会删哪些"的推算——那迟早和真正的传播逻辑对不上，用户看到的影响范围
 * 就成了一份不可信的说明。这里直接跑真实的删除/传播代码，拿到结果后整体回滚，库里一行不变。
 * 体内的 inTransaction 视为嵌套，跟着这次回滚一起作废。已在事务里时改用保存点，
 * 只撤销体内的写入，外层事务照常继续。
 */
export function dryRun<T>(db: DatabaseSync, body: () => T): T {
  const nesting = transactionDepth.get(db) ?? 0
  const savepoint = `dry_run_${nesting}`
  transactionDepth.set(db, nesting + 1)
  db.exec(nesting > 0 ? `SAVEPOINT ${savepoint}` : 'BEGIN')
  try {
    return body()
  } finally {
    if (nesting > 0) {
      db.exec(`ROLLBACK TO ${savepoint}`)
      db.exec(`RELEASE ${savepoint}`)
    } else {
      db.exec('ROLLBACK')
    }
    transactionDepth.set(db, nesting)
  }
}

/** 表是否存在。迁移读删除账本时用：账本表由各自的存储类按需建出，旧库里可能还没有。 */
export function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

/** 本机时间的 YYYY-MM-DD HH:mm；回执与覆盖范围说明共用，避免依赖运行环境的区域格式。 */
export function formatLocalTime(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '未知时间'
  const d = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
