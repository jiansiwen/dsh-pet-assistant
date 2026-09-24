/**
 * 主动帮助的工作上下文授权（计划 P5）。
 *
 * 提醒气泡只问"要不要一起看"，不读任何资料；用户同意后必须先确认范围，
 * 范围落在这张表里才算授权。之后的只读证据读取只认表里的目录，
 * 没授权的目录连 stat 都不做 —— 授权边界在读取侧执行，不靠提示词自觉。
 */
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { inTransaction, type Row } from './store.ts'

export interface HelpContext {
  id: string
  projectDir: string
  currentFile: string | null
  note: string | null
  createdAt: number
}

export interface ProjectEvidence {
  projectDir: string
  git: boolean
  branch: string | null
  changedFiles: string[]
  diffStat: string[]
  recentCommits: string[]
  entries: string[]
  truncated: boolean
}

const MAX_LINES = 40
const MAX_ENTRIES = 50
const GIT_TIMEOUT_MS = 5000

export class HelpContextStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`CREATE TABLE IF NOT EXISTS help_contexts (
      id TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      current_file TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    )`)
  }

  add(id: string, projectDir: string, currentFile: string | null, note: string | null, now: number): HelpContext {
    const record: HelpContext = { id, projectDir, currentFile, note, createdAt: now }
    inTransaction(this.db, () => {
      this.db.prepare('INSERT INTO help_contexts (id, project_dir, current_file, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, projectDir, currentFile, note, now)
    })
    return record
  }

  list(): HelpContext[] {
    return (this.db.prepare('SELECT * FROM help_contexts ORDER BY created_at DESC').all() as Row[]).map(row => ({
      id: String(row.id),
      projectDir: String(row.project_dir),
      currentFile: row.current_file === null ? null : String(row.current_file),
      note: row.note === null ? null : String(row.note),
      createdAt: Number(row.created_at),
    }))
  }

  remove(id: string): boolean {
    const result = this.db.prepare('DELETE FROM help_contexts WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  /** 目录是否已被用户授权为帮助上下文；currentFile 必须落在授权目录内。 */
  isAuthorized(projectDir: string): boolean {
    const wanted = path.resolve(projectDir)
    return this.list().some(item => path.resolve(item.projectDir) === wanted)
  }
}

function git(args: string[], cwd: string): Promise<string[]> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 512 }, (error, stdout) => {
      if (error) resolve([])
      else resolve(stdout.split(/\r?\n/).filter(line => line.trim() !== ''))
    })
  })
}

/**
 * 只读工作证据：Git 状态/差异/最近提交，或非 Git 目录的顶层条目。
 * 不跑任何会写索引或联网的 Git 子命令；超时和失败都返回空列表而不是抛错。
 */
export async function readProjectEvidence(projectDir: string): Promise<ProjectEvidence> {
  const dir = path.resolve(projectDir)
  const inside = await git(['rev-parse', '--is-inside-work-tree'], dir)
  const isGit = inside[0] === 'true'
  const [branch, status, diffStat, log] = isGit
    ? await Promise.all([
        git(['rev-parse', '--abbrev-ref', 'HEAD'], dir),
        git(['status', '--porcelain=v1'], dir),
        git(['diff', '--stat', 'HEAD'], dir),
        git(['log', '--oneline', '-5'], dir),
      ])
    : [[], [], [], []]
  let entries: string[] = []
  try {
    entries = (await readdir(dir)).slice(0, MAX_ENTRIES)
  } catch {
    entries = []
  }
  const truncated = status.length > MAX_LINES || diffStat.length > MAX_LINES || entries.length >= MAX_ENTRIES
  return {
    projectDir: dir,
    git: isGit,
    branch: branch[0] ?? null,
    changedFiles: status.slice(0, MAX_LINES),
    diffStat: diffStat.slice(0, MAX_LINES),
    recentCommits: log.slice(0, 5),
    entries,
    truncated,
  }
}
