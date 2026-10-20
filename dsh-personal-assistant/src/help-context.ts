/**
 * 主动帮助的工作上下文授权（计划 P5）。
 *
 * 提醒气泡只问"要不要一起看"，不读任何资料；用户同意后必须先确认范围，
 * 范围落在这张表里才算授权。之后的只读证据读取只认表里的目录，
 * 没授权的目录连 stat 都不做 —— 授权边界在读取侧执行，不靠提示词自觉。
 *
 * M3-07：主动提醒被接受后开一条 episode。候选范围只从已经在本机的事实里取（当前会话目录、
 * 已有授权、最近一次采样里的前台窗口），不为了出候选再去读项目；用户选定后读取范围仍要经可信审批，
 * 批准落表时带上 episode id，之后的帮助任务、改动与验证都能顺着 episode → 授权 → 任务 → 账本追溯。
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { snapshotDigest, type AssistantSubmission } from './assistant-approval.ts'
import { inTransaction, type Row } from './store.ts'

export interface HelpContext {
  id: string
  projectDir: string
  currentFile: string | null
  note: string | null
  createdAt: number
  /** 经主动帮助 episode 授权时的 episode id；用户直接给范围时为 null。 */
  episodeId: string | null
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

export function normalizeHelpScope(projectDir: string, currentFile: string | null): { projectDir: string; currentFile: string | null } {
  if (!path.isAbsolute(projectDir) || (currentFile !== null && !path.isAbsolute(currentFile))) throw new Error('帮助范围必须是绝对路径')
  const dir = realpathSync(projectDir)
  if (!statSync(dir).isDirectory()) throw new Error('项目范围必须是目录')
  const file = currentFile === null ? null : realpathSync(currentFile)
  if (file !== null) {
    const relative = path.relative(dir, file)
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !statSync(file).isFile()) throw new Error('当前文件实际路径不在授权目录内')
  }
  return { projectDir: dir, currentFile: file }
}

export class HelpContextStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`CREATE TABLE IF NOT EXISTS help_contexts (
      id TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      current_file TEXT,
      note TEXT,
      created_at INTEGER NOT NULL,
      episode_id TEXT
    )`)
    // 老库补列：按列名判断，重复打开也安全。
    const columns = (db.prepare('PRAGMA table_info(help_contexts)').all() as Row[]).map(row => String(row.name))
    if (!columns.includes('episode_id')) db.exec('ALTER TABLE help_contexts ADD COLUMN episode_id TEXT')
  }

  add(id: string, projectDir: string, currentFile: string | null, note: string | null, now: number, episodeId: string | null = null): HelpContext {
    const record: HelpContext = { id, projectDir, currentFile, note, createdAt: now, episodeId }
    inTransaction(this.db, () => {
      this.db.prepare('INSERT INTO help_contexts (id, project_dir, current_file, note, created_at, episode_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, projectDir, currentFile, note, now, episodeId)
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
      episodeId: row.episode_id === null || row.episode_id === undefined ? null : String(row.episode_id),
    }))
  }

  get(id: string): HelpContext | null {
    return this.list().find(item => item.id === id) ?? null
  }

  remove(id: string): boolean {
    const result = this.db.prepare('DELETE FROM help_contexts WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  /** 先匹配已批准路径，再检查实际路径，链接改指后拒绝读取。 */
  authorizedScope(projectDir: string): HelpContext | null {
    const wanted = path.resolve(projectDir)
    for (const item of this.list()) {
      if (item.projectDir !== wanted) continue
      try {
        const scope = normalizeHelpScope(item.projectDir, item.currentFile)
        if (scope.projectDir === item.projectDir && scope.currentFile === item.currentFile) return item
      } catch { /* 路径已失效，不读取。 */ }
    }
    return null
  }

  isAuthorized(projectDir: string): boolean { return this.authorizedScope(projectDir) !== null }

  /** 按授权记录 id 复核：记录还在、实际路径没有改指时返回它。帮助任务绑定的就是这一条，撤销即失效。 */
  validById(id: string): HelpContext | null {
    const item = this.get(id)
    if (!item) return null
    try {
      const scope = normalizeHelpScope(item.projectDir, item.currentFile)
      return scope.projectDir === item.projectDir && scope.currentFile === item.currentFile ? item : null
    } catch {
      return null
    }
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
export async function readProjectEvidence(projectDir: string, currentFile: string | null = null): Promise<ProjectEvidence> {
  const scope = normalizeHelpScope(projectDir, currentFile)
  const dir = scope.projectDir
  // 文件级授权不读取项目整体历史或目录列表，也不跟随符号链接读取正文。
  if (scope.currentFile) return {
    projectDir: dir, git: false, branch: null, changedFiles: [], diffStat: [], recentCommits: [],
    entries: [path.relative(dir, scope.currentFile)], truncated: false,
  }
  const root = await git(['rev-parse', '--show-toplevel'], dir)
  // 授权子目录不等于授权父仓库；链接到范围外的 Git 元数据也不能读。
  let isGit = false
  try {
    const metadata = await git(['rev-parse', '--absolute-git-dir'], dir)
    const relative = path.relative(dir, realpathSync(metadata[0] ?? ''))
    isGit = !!root[0] && realpathSync(root[0]) === dir && !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
  } catch { /* 非独立授权仓库仅列顶层文件名。 */ }
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

// ───────────────────────────── 主动帮助 episode（M3-07） ─────────────────────────────

export const EPISODE_STATES = ['offered', 'accepted', 'declined', 'expired', 'scope-pending', 'scoped', 'closed'] as const
export type EpisodeState = (typeof EPISODE_STATES)[number]

/** 用户接受提醒之后给出的一个候选范围。只描述已在本机的事实，不含任何项目内容。 */
export interface HelpCandidate {
  readonly id: string
  readonly kind: 'session-project' | 'authorized' | 'window'
  /** 给用户看的中性描述。 */
  readonly label: string
  /** 候选对应的目录；前台窗口候选不知道目录，需要用户说出来。 */
  readonly projectDir: string | null
  readonly currentFile: string | null
  /** 已授权候选对应的授权记录。 */
  readonly helpContextId: string | null
  readonly window: { readonly process: string; readonly title: string | null } | null
}

export interface HelpEpisode {
  readonly id: string
  readonly origin: 'proactive' | 'user'
  readonly state: EpisodeState
  /** 对应哪一段空闲（同一空闲段只提醒一次）。 */
  readonly idlePeriodStart: number | null
  readonly candidates: readonly HelpCandidate[]
  readonly chosen: string | null
  readonly scopeProposalId: string | null
  readonly helpContextId: string | null
  readonly taskId: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** 生成候选只用这些已经在手的事实；没有的就不给，绝不为了出候选去读项目目录。 */
export interface HelpCandidateFacts {
  /** 当前 dsh 会话的工作目录（会话头里就有）。 */
  readonly sessionCwd?: string | null
  /** 最近一次采样里的前台窗口（已经采集过的数据；标题只在用户授权采集标题时才有）。 */
  readonly foreground?: { readonly process: string; readonly title: string | null } | null
  /** 已有的帮助授权。 */
  readonly authorized?: readonly HelpContext[]
}

/** 提醒发出后多久内点「好」还算这一次的回应。 */
export const OFFER_TTL_MS = 30 * 60_000
/** 接受后多久内算「正在一起看」（期间不再弹主动提醒）。 */
export const ACTIVE_EPISODE_TTL_MS = 2 * 60 * 60_000
const MAX_CANDIDATES = 5

/** 由已有事实生成候选（纯函数）。措辞中性：只说「当前会话目录 / 之前授权过 / 当前窗口」，不揣测用户状态。 */
export function helpCandidates(facts: HelpCandidateFacts): HelpCandidate[] {
  const out: HelpCandidate[] = []
  const seen = new Set<string>()
  const push = (candidate: Omit<HelpCandidate, 'id'>) => {
    const key = `${candidate.projectDir ?? ''}|${candidate.currentFile ?? ''}|${candidate.window?.process ?? ''}`
    if (seen.has(key) || out.length >= MAX_CANDIDATES) return
    seen.add(key)
    out.push({ ...candidate, id: `c${out.length + 1}` })
  }
  const cwd = facts.sessionCwd
  if (typeof cwd === 'string' && path.isAbsolute(cwd)) {
    push({ kind: 'session-project', label: `当前会话所在的目录：${cwd}`, projectDir: path.resolve(cwd), currentFile: null, helpContextId: null, window: null })
  }
  for (const item of facts.authorized ?? []) {
    push({
      kind: 'authorized', label: `之前授权过的范围：${item.currentFile ?? item.projectDir}`,
      projectDir: item.projectDir, currentFile: item.currentFile, helpContextId: item.id, window: null,
    })
  }
  const window = facts.foreground
  if (window && typeof window.process === 'string' && window.process.trim()) {
    const title = typeof window.title === 'string' && window.title.trim() ? window.title.trim().slice(0, 120) : null
    push({
      kind: 'window', label: `当前窗口：${window.process}${title ? ` — ${title}` : ''}（需要你告诉我对应的项目目录）`,
      projectDir: null, currentFile: null, helpContextId: null, window: { process: window.process, title },
    })
  }
  return out
}

function rowToEpisode(row: Row): HelpEpisode {
  let candidates: HelpCandidate[] = []
  try {
    const parsed: unknown = JSON.parse(String(row.candidates))
    if (Array.isArray(parsed)) candidates = parsed as HelpCandidate[]
  } catch { /* 写坏的候选当成没有。 */ }
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value))
  return {
    id: String(row.id),
    origin: row.origin === 'user' ? 'user' : 'proactive',
    state: String(row.state) as EpisodeState,
    idlePeriodStart: row.idle_period_start === null || row.idle_period_start === undefined ? null : Number(row.idle_period_start),
    candidates,
    chosen: text(row.chosen),
    scopeProposalId: text(row.scope_proposal_id),
    helpContextId: text(row.help_context_id),
    taskId: text(row.task_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/**
 * 主动帮助 episode 存储（助理库）。生命周期：
 * offered（气泡已弹）→ accepted（点「好」，生成候选）→ scope-pending（用户选了候选，读取范围待可信批准）
 * → scoped（批准落表）→ 帮助任务关联（taskId）→ closed。
 * offered → declined（点「不用」）或 expired（不回应，过期懒判）：这两条路上一个候选都不生成，什么都不读。
 */
export class HelpEpisodeStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`CREATE TABLE IF NOT EXISTS help_episodes (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      state TEXT NOT NULL,
      idle_period_start INTEGER,
      candidates TEXT NOT NULL,
      chosen TEXT,
      scope_proposal_id TEXT,
      help_context_id TEXT,
      task_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
  }

  get(id: string): HelpEpisode | null {
    const row = this.db.prepare('SELECT * FROM help_episodes WHERE id = ?').get(id) as Row | undefined
    return row ? rowToEpisode(row) : null
  }

  list(limit = 50): HelpEpisode[] {
    return (this.db.prepare('SELECT * FROM help_episodes ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Row[]).map(rowToEpisode)
  }

  private update(id: string, patch: Partial<Record<'state' | 'candidates' | 'chosen' | 'scope_proposal_id' | 'help_context_id' | 'task_id', string | null>>, now: number,
    from?: readonly EpisodeState[]): boolean {
    const sets = Object.keys(patch).map(key => `${key} = ?`)
    const values: (string | number | null)[] = Object.values(patch).map(value => value ?? null)
    sets.push('updated_at = ?')
    values.push(now, id)
    const guard = from && from.length > 0 ? ` AND state IN (${from.map(() => '?').join(', ')})` : ''
    if (from) values.push(...from)
    const result = this.db.prepare(`UPDATE help_episodes SET ${sets.join(', ')} WHERE id = ?${guard}`).run(...values)
    return Number(result.changes) === 1
  }

  /** 提醒气泡弹出时记一条；之前没回应的提醒顺手判过期。 */
  offer(now: number, idlePeriodStart: number | null): HelpEpisode {
    return inTransaction(this.db, () => {
      this.db.prepare(`UPDATE help_episodes SET state = 'expired', updated_at = ? WHERE state = 'offered'`).run(now)
      const id = `episode-${randomUUID()}`
      this.db.prepare(`INSERT INTO help_episodes (id, origin, state, idle_period_start, candidates, created_at, updated_at)
                       VALUES (?, 'proactive', 'offered', ?, '[]', ?, ?)`).run(id, idlePeriodStart, now, now)
      return this.get(id)!
    })
  }

  /** 最近一条还在有效期内、等着用户回应的提醒。 */
  private pendingOffer(now: number): HelpEpisode | null {
    const offered = this.list(10).find(item => item.state === 'offered')
    if (!offered) return null
    if (now - offered.createdAt > OFFER_TTL_MS) {
      this.update(offered.id, { state: 'expired' }, now, ['offered'])
      return null
    }
    return offered
  }

  /**
   * 用户点了「好」：这时才生成候选（facts 是惰性的 —— 拒绝与不回应的路上它根本不会被调用）。
   * 没有对应的提醒（例如重启后点到旧气泡）也照样开一条，用户的同意不该被丢掉。
   */
  accept(now: number, facts: () => HelpCandidateFacts): HelpEpisode {
    const candidates = JSON.stringify(helpCandidates(facts()))
    const offered = this.pendingOffer(now)
    if (offered && this.update(offered.id, { state: 'accepted', candidates }, now, ['offered'])) return this.get(offered.id)!
    const id = `episode-${randomUUID()}`
    this.db.prepare(`INSERT INTO help_episodes (id, origin, state, idle_period_start, candidates, created_at, updated_at)
                     VALUES (?, 'proactive', 'accepted', NULL, ?, ?, ?)`).run(id, candidates, now, now)
    return this.get(id)!
  }

  /** 用户点了「不用」或「关掉提醒」：不生成候选、不读任何东西。 */
  decline(now: number): HelpEpisode | null {
    const offered = this.pendingOffer(now)
    if (!offered) return null
    this.update(offered.id, { state: 'declined' }, now, ['offered'])
    return this.get(offered.id)
  }

  /** 正在进行的帮助（已接受且未结束、未过期）；有它时不再弹主动提醒。 */
  active(now: number): HelpEpisode | null {
    return this.list(10).find(item => ['accepted', 'scope-pending', 'scoped'].includes(item.state)
      && now - item.updatedAt <= ACTIVE_EPISODE_TTL_MS) ?? null
  }

  markScopePending(id: string, candidateId: string, proposalId: string, now: number): boolean {
    return this.update(id, { state: 'scope-pending', chosen: candidateId, scope_proposal_id: proposalId }, now, ['accepted', 'scope-pending'])
  }

  markScoped(id: string, helpContextId: string, now: number): boolean {
    return this.update(id, { state: 'scoped', help_context_id: helpContextId }, now, ['accepted', 'scope-pending', 'scoped'])
  }

  /** 帮助任务能挂上来的 episode：已接受、范围待批或已批。 */
  canAttach(id: string): boolean {
    const episode = this.get(id)
    return !!episode && ['accepted', 'scope-pending', 'scoped'].includes(episode.state)
  }

  attachTask(id: string, taskId: string): boolean {
    return this.update(id, { task_id: taskId }, Date.now(), ['accepted', 'scope-pending', 'scoped'])
  }

  close(id: string, now: number): boolean {
    return this.update(id, { state: 'closed' }, now, ['accepted', 'scope-pending', 'scoped'])
  }
}

interface EpisodeToolHost {
  tools: { register(definition: unknown): () => void }
  systemPrompt: { section(section: { name: string; order: number; text: string }): () => void }
}

export interface HelpEpisodeToolOptions {
  readonly episodes: HelpEpisodeStore
  readonly helpContexts: HelpContextStore
  /** 把读取范围交给可信审批（桌面专用审批窗口）；bridge.submitAssistant 满足这个形状。 */
  submit(submission: AssistantSubmission): { proposalId: string }
  now?: () => number
}

/** 「好」之后的那句中性引导语；桌面点「好」时可以原样替用户发出（接线见报告）。 */
export const PROACTIVE_ACCEPT_GUIDANCE = '好，我们一起看看现在的工作。请先列出可选的项目或窗口让我选择查看范围；'
  + '范围经我在桌面审批窗口确认之前，不要读取任何项目内容，也不要修改文件或运行命令。'

/**
 * 主动帮助的两件工具：列候选、选定候选并提交读取范围的可信审批。
 * 选定只产生一张待批卡片；批准落表时带上 episode id，模型自己没有任何授权入口。
 */
export function registerHelpEpisodeTools(host: EpisodeToolHost, options: HelpEpisodeToolOptions): () => void {
  const now = options.now ?? Date.now
  const releases: Array<() => void> = []
  const json = (value: unknown) => JSON.stringify(value)
  const output = { schema: { type: 'string' } as const, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
  const resolveEpisode = (episodeId: string | undefined): HelpEpisode | null => {
    if (typeof episodeId === 'string' && episodeId) return options.episodes.get(episodeId)
    return options.episodes.active(now())
  }
  try {
    releases.push(host.tools.register(defineTool({
      name: 'personal_assistant_help_candidates',
      description: '用户在主动提醒上点了「好」之后调用：列出可选的查看范围（当前会话目录、之前授权过的范围、当前窗口），让用户选。'
        + '候选只来自已经在本机的信息，调用本身不读取任何项目内容。',
      parameters: { episodeId: { type: 'string', description: '可选；缺省取正在进行的那一次' } },
      output,
      async execute(args: { episodeId?: string }) {
        const episode = resolveEpisode(args.episodeId)
        if (!episode || !['accepted', 'scope-pending', 'scoped'].includes(episode.state)) {
          return json({ ok: false, error: '现在没有进行中的主动帮助。用户直接请求帮助时，请让用户说出项目目录，再调用 personal_assistant_help_context 提交读取范围。' })
        }
        return json({
          ok: true, episodeId: episode.id, state: episode.state, candidates: episode.candidates,
          note: '把候选原样列给用户，请用户选一个（或直接说出目录）；用户选定后调用 personal_assistant_help_choose。在用户于桌面审批窗口确认范围之前，不要读取任何项目内容。',
        })
      },
    })))
    releases.push(host.tools.register(defineTool({
      name: 'personal_assistant_help_choose',
      description: '用户从候选里选定查看范围后调用：提交一张只读范围的可信审批卡（桌面专用审批窗口）。返回 pending 时还没有授权，不能读取；'
        + '前台窗口候选需要用户说出对应的项目目录（绝对路径）。',
      parameters: {
        episodeId: { type: 'string', required: true, description: 'personal_assistant_help_candidates 返回的 episodeId' },
        candidateId: { type: 'string', required: true, description: '用户选中的候选 id（如 c1）' },
        projectDir: { type: 'string', description: '前台窗口候选必填：用户说出的项目目录绝对路径' },
        currentFile: { type: 'string', description: '可选：只授权这个文件（绝对路径，须在项目目录内）' },
        note: { type: 'string', description: '用户描述的目标原文' },
      },
      output,
      async execute(args: { episodeId: string; candidateId: string; projectDir?: string; currentFile?: string; note?: string }) {
        const episode = options.episodes.get(args.episodeId)
        if (!episode || !['accepted', 'scope-pending'].includes(episode.state)) {
          return json({ pending: false, error: '这次主动帮助已经结束或不存在，不能再选范围' })
        }
        const candidate = episode.candidates.find(item => item.id === args.candidateId)
        if (!candidate) return json({ pending: false, error: `没有候选 ${args.candidateId}` })
        const projectDir = candidate.projectDir ?? args.projectDir
        if (!projectDir) return json({ pending: false, error: '这个候选是一个窗口，请让用户说出对应的项目目录（绝对路径）后再提交' })
        if (candidate.projectDir && args.projectDir && path.resolve(args.projectDir) !== path.resolve(candidate.projectDir)) {
          return json({ pending: false, error: '给出的目录与所选候选不一致；请重新确认用户选的是哪一个' })
        }
        let scope: { projectDir: string; currentFile: string | null }
        try {
          scope = normalizeHelpScope(projectDir, args.currentFile ?? candidate.currentFile)
        } catch (error) {
          return json({ pending: false, error: error instanceof Error ? error.message : String(error) })
        }
        const before = options.helpContexts.list()
        const snapshot = { ...scope, episodeId: episode.id, candidate: candidate.id, note: args.note ?? null }
        try {
          const proposal = options.submit({
            subject: 'help', tool: 'personal_assistant_help_context',
            summary: '授权只读帮助证据（来自主动帮助）。范围是下列实际项目目录；指定文件时只允许该文件相关证据。读到的内容会返回当前会话并发送给模型服务商；'
              + '这次批准不包含修改文件或运行命令 —— 之后每一处改动、每一条命令都要单独批准。',
            target: scope.currentFile ?? scope.projectDir, risk: 'high', snapshot,
            validate: () => snapshotDigest(scope) === snapshotDigest(normalizeHelpScope(projectDir, args.currentFile ?? candidate.currentFile))
              && snapshotDigest(before) === snapshotDigest(options.helpContexts.list())
              // 提交瞬间桥接就会重算待办（此时还没来得及标成 scope-pending），所以 accepted 也算有效；
              // 用户拒绝、关闭或这次帮助已结束后，这张卡随即失效。
              && ['accepted', 'scope-pending'].includes(options.episodes.get(episode.id)?.state ?? ''),
            execute: () => {
              const record = options.helpContexts.add(`help-${randomUUID()}`, scope.projectDir, scope.currentFile, args.note ?? null, now(), episode.id)
              options.episodes.markScoped(episode.id, record.id, now())
              return record
            },
          })
          options.episodes.markScopePending(episode.id, candidate.id, proposal.proposalId, now())
          return json({
            pending: true, status: 'pending', proposalId: proposal.proposalId, episodeId: episode.id, scope,
            message: '尚未授权，也还没有读取任何内容。请用户在桌面专用审批窗口核对范围后批准；聊天里的确认不能代替。',
          })
        } catch (error) {
          return json({ pending: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })))
    releases.push(host.systemPrompt.section({
      name: 'personal-assistant-proactive-help',
      order: 155,
      text: [
        '## 主动帮助',
        '主动提醒只在用户一段时间没有输入时出现，只表示「可以一起看看」，不代表用户遇到了什么情况；描述时保持中性。',
        '- 用户点「好」后：先调用 personal_assistant_help_candidates，把候选原样列给用户选；用户选定后调用 personal_assistant_help_choose 提交读取范围，请用户到桌面审批窗口批准。批准前不读取任何项目内容。',
        '- 用户点「不用」或没有回应：什么都不做，不追问、不读取。',
        '- 范围获批后，在团队模式下用 desktop_team_open_help_task（带上 episodeId）开帮助任务；之后的改动与验证命令都要各自经桌面审批。用户同意一起看，不等于同意任何改动。',
      ].join('\n'),
    }))
  } catch (error) {
    while (releases.length > 0) releases.pop()!()
    throw error
  }
  return () => {
    while (releases.length > 0) releases.pop()!()
  }
}
