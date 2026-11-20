/**
 * 产物指针：记住"助理给你产出过哪些文件"。
 *
 * 为什么单独一张表、而不是并进 `memories`：
 * - 记忆是**结论**（"老板喜欢简单明了"），产物是**指针**（"这份文件在 D:\out\x.docx"）。
 *   混在一张表里，删除传播就没法表达"结论还在，但它依据的那份文件没了"。
 * - 团队库里已经有一张 `artifacts`，那是**任务产物证据**（绑 task_id + operation_id，由执行器写）。
 *   这里的指针是给"我上次给你做的那个东西"用的，生命周期和来源都不同，不复用。
 *
 * 三条纪律：
 * 1. **只存路径与摘要，不存正文**。用户问起来再去读文件，读不到就如实说没了。
 * 2. **文件消失只标 missing，不删行**。删行会让引用它的东西失去指向，而且"我做过但文件没了"
 *    本身就是需要如实告诉用户的事实。
 * 3. **本表是派生索引**，可以整表重建，不承担删除传播的责任 —— 记忆的删除传播仍归 `memories`。
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const ARTIFACT_KINDS = ['report', 'minutes', 'translation', 'export', 'diff', 'other'] as const
export type ArtifactKind = typeof ARTIFACT_KINDS[number]

export interface ArtifactPointer {
  id: string
  kind: ArtifactKind
  /** 规范绝对路径；展示时原样给出，不裁剪成文件名（重名文件太多了）。 */
  path: string
  /** 内容摘要（sha256 前 16 位）；文件被改过就能看出来。 */
  digest: string
  /** 一句话说明这是什么，用来在提示词里省掉再解释一遍。 */
  label: string
  taskId: string | null
  meetingId: string | null
  createdAt: number
  lastSeenAt: number
  state: 'ok' | 'missing'
}

export interface ArtifactInput {
  kind: ArtifactKind
  path: string
  digest: string
  label: string
  taskId?: string | null
  meetingId?: string | null
}

/** 摘要：只取前 16 位十六进制，够区分内容变化，又不至于把提示词撑长。 */
export function digestOf(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

/**
 * 判定"这句话在说某个产物"。
 *
 * 只用**确定性词面匹配**（路径片段 / 文件名主干 / 标签），不做语义近似：
 * 语义近似要么靠 embedding、要么靠模型，两个都会把"我记得"变成"我猜的"。
 *
 * 三条规则，按可信度从高到低：
 * 1. 整条路径出现在话里 → 命中；
 * 2. 文件名（含扩展名）出现在话里 → 命中；
 * 3. 标签里至少有一段（≥2 字）出现在话里 → 命中。
 *
 * 刻意不做"单个汉字"匹配：中文里一个字到处都有，那会把任何一句话都判成命中。
 */
export function artifactMentioned(text: string, pointer: Pick<ArtifactPointer, 'path' | 'label'>): boolean {
  const haystack = text.toLowerCase()
  if (haystack.trim() === '') return false
  const full = pointer.path.toLowerCase()
  if (full !== '' && haystack.includes(full)) return true
  const name = full.split(/[\\/]/).pop() ?? ''
  if (name.length >= 3 && haystack.includes(name)) return true
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name
  if (stem.length >= 3 && haystack.includes(stem)) return true
  return pointer.label
    .split(/[\s、,，·]+/u)
    .map(part => part.trim().toLowerCase())
    .some(part => part.length >= 2 && haystack.includes(part))
}

export class ArtifactStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_pointers (
        artifact_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        digest TEXT NOT NULL,
        label TEXT NOT NULL,
        task_id TEXT,
        meeting_id TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('ok', 'missing'))
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_recent ON artifact_pointers(last_seen_at DESC);
    `)
  }

  /**
   * 记一条指针。**同路径覆盖上一次**：一份文件被反复产出多次时，
   * 记忆里只需要"它现在是什么样"，留一串历史只会让提示词变成活动日志。
   */
  record(input: ArtifactInput, now = Date.now()): ArtifactPointer {
    const path = input.path.trim()
    if (path === '') throw new Error('产物路径不能为空')
    const existing = this.db.prepare('SELECT artifact_id FROM artifact_pointers WHERE path = ?').get(path) as Record<string, unknown> | undefined
    const id = existing === undefined ? `art-${now}-${Math.random().toString(36).slice(2, 8)}` : String(existing.artifact_id)
    this.db.prepare(`
      INSERT INTO artifact_pointers(artifact_id, kind, path, digest, label, task_id, meeting_id, created_at, last_seen_at, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')
      ON CONFLICT(artifact_id) DO UPDATE SET
        kind = excluded.kind, digest = excluded.digest, label = excluded.label,
        task_id = excluded.task_id, meeting_id = excluded.meeting_id, last_seen_at = excluded.last_seen_at, state = 'ok'
    `).run(id, input.kind, path, input.digest, input.label, input.taskId ?? null, input.meetingId ?? null, now, now)
    return this.get(id)!
  }

  get(id: string): ArtifactPointer | null {
    const row = this.db.prepare('SELECT * FROM artifact_pointers WHERE artifact_id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? null : this.map(row)
  }

  /** 最近产出的若干条；`includeMissing=false` 时跳过已知文件已不在的。 */
  recent(limit = 5, includeMissing = false): ArtifactPointer[] {
    const rows = this.db.prepare('SELECT * FROM artifact_pointers ORDER BY last_seen_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(50, limit))) as Array<Record<string, unknown>>
    const items = rows.map(row => this.map(row))
    return includeMissing ? items : items.filter(item => item.state === 'ok')
  }

  /**
   * 文件不在了：只标状态，不删行。
   *
   * 调用方是"读取时发现打不开"的那一刻 —— 不主动轮询磁盘：
   * 一个每分钟扫一遍全盘路径的定时器会让笔记本风扇转起来，而这件事只在被引用时才重要。
   */
  markMissing(id: string, now = Date.now()): void {
    this.db.prepare('UPDATE artifact_pointers SET state = ? WHERE artifact_id = ?').run('missing', id)
    void now
  }

  /** 按一句话找相关产物（命中判定见 {@link artifactMentioned}）。 */
  mentionedIn(text: string, limit = 3): ArtifactPointer[] {
    return this.recent(30, true).filter(item => artifactMentioned(text, item)).slice(0, limit)
  }

  private map(row: Record<string, unknown>): ArtifactPointer {
    return {
      id: String(row.artifact_id ?? ''), kind: String(row.kind ?? 'other') as ArtifactKind,
      path: String(row.path ?? ''), digest: String(row.digest ?? ''), label: String(row.label ?? ''),
      taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
      meetingId: row.meeting_id === null || row.meeting_id === undefined ? null : String(row.meeting_id),
      createdAt: Number(row.created_at ?? 0), lastSeenAt: Number(row.last_seen_at ?? 0),
      state: row.state === 'missing' ? 'missing' : 'ok',
    }
  }
}
