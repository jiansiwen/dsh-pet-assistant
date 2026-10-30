/** 成员目录与额度账本；身份字段仅存 assistants，所有写入复用团队库事务。 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { CHILD_LOCAL_TOOLS, READ_ONLY_ALLOW_TOOLS, READ_ONLY_DENY_CANDIDATES } from './gate.ts'
import { MEMBER_CAPABILITIES, MEMBER_PERMISSION_MODES, type MemberDraft, type MemberProfile, type MemberQuotaRequest, type MemberQuotaView } from './member-contract.ts'
import type { MemberConfig, RoleId, ToolPolicy } from './team-domain.ts'

export type { MemberDraft, MemberProfile, MemberQuotaRequest, MemberQuotaView } from './member-contract.ts'
type Row = Record<string, string | number | bigint | null>
type Extension = Omit<MemberProfile, keyof MemberConfig>
type ResetScope = 'daily' | 'total' | 'both'
type Transaction = <T>(body: () => T) => T
const MAX = Number.MAX_SAFE_INTEGER
const SKINS = ['panda', 'girl-glasses', 'boy-glasses']

function defaults(): Extension {
  return { description: '', personality: '', permissionMode: 'ask', provider: '', model: '', maxTokens: 4096, capabilities: [], allowedTools: [],
    dailyTokenLimit: 0, totalTokenLimit: 0, thresholdPercent: 80, timezone: 'Asia/Shanghai', sessionId: null }
}

/** 只在 TeamStore 的版本迁移事务中调用，当前版本打开时不重复建表、写默认值。 */
export function migrateMemberDirectory(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_profiles (
      assistant_id TEXT PRIMARY KEY REFERENCES assistants(assistant_id),
      data TEXT NOT NULL CHECK(json_valid(data))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_member_session ON assistant_profiles(json_extract(data, '$.sessionId'))
      WHERE json_extract(data, '$.sessionId') IS NOT NULL;
    CREATE TABLE IF NOT EXISTS member_quota_accounts (
      assistant_id TEXT PRIMARY KEY REFERENCES assistants(assistant_id),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
    );
    CREATE TABLE IF NOT EXISTS member_usage (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      assistant_id TEXT NOT NULL REFERENCES assistants(assistant_id),
      day TEXT NOT NULL,
      timezone TEXT NOT NULL,
      reserved INTEGER NOT NULL CHECK(reserved > 0),
      tokens INTEGER CHECK(tokens > 0),
      state TEXT NOT NULL CHECK(state IN ('pending', 'finished', 'unknown')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      CHECK((state = 'finished' AND tokens IS NOT NULL) OR (state != 'finished' AND tokens IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_member_usage_account ON member_usage(assistant_id, seq);
    CREATE TABLE IF NOT EXISTS member_quota_requests (
      request_id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL REFERENCES assistants(assistant_id),
      day TEXT NOT NULL,
      quota_revision INTEGER NOT NULL,
      reason TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'approved', 'rejected')),
      created_at INTEGER NOT NULL,
      UNIQUE(assistant_id, quota_revision, day)
    );
    CREATE TABLE IF NOT EXISTS member_quota_resets (
      reset_id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL REFERENCES assistants(assistant_id),
      quota_revision INTEGER NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('daily', 'total', 'both')),
      day TEXT NOT NULL,
      usage_through INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(assistant_id, quota_revision)
    );
  `)
  db.prepare(`INSERT OR IGNORE INTO assistant_profiles(assistant_id, data)
    SELECT assistant_id, ? FROM assistants WHERE role_id != 'tangseng' AND assistant_id NOT IN ('chief', 'member-tangseng')`)
    .run(JSON.stringify(defaults()))
}

function integer(value: number, label: string, min = 0, max = MAX): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}必须是 ${min} 至 ${max} 的安全整数`)
  return value
}
function text(value: string, label: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label}必须是长度不超过 ${max} 的文字`)
  const result = value.trim()
  if (required && !result) throw new Error(`${label}不能为空`)
  return result
}
function timestamp(now: number): number { return integer(now, '时间', 0, 8_640_000_000_000_000) }
function dayAt(timezone: string, now: number): string {
  timestamp(now)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-')
}
function scopeOf(scope: ResetScope): ResetScope {
  if (!['daily', 'total', 'both'].includes(scope)) throw new Error('重置范围必须是日额度、总额度或两者')
  return scope
}
// 超大累计仅展示值饱和，原始回执保留；有限额度不超过 MAX，不能利用精度溢出绕过门禁。
function saturatedAdd(a: number, b: number): number { return b > MAX - a ? MAX : a + b }
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every(value => b.includes(value))
}
function extension(profile: MemberProfile): Extension {
  return { description: profile.description, personality: profile.personality, permissionMode: profile.permissionMode, provider: profile.provider, model: profile.model, maxTokens: profile.maxTokens,
    capabilities: profile.capabilities, allowedTools: profile.allowedTools, dailyTokenLimit: profile.dailyTokenLimit,
    totalTokenLimit: profile.totalTokenLimit, thresholdPercent: profile.thresholdPercent, timezone: profile.timezone, sessionId: profile.sessionId }
}
function normalize(draft: MemberDraft): MemberDraft {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('成员配置无效')
  const skinId = text(draft.skinId ?? 'panda', '形象', 80) || 'panda'
  if (!SKINS.includes(skinId)) throw new Error('请选择已有成员形象')
  if (typeof draft.enabled !== 'boolean') throw new Error('启用状态必须是布尔值')
  const timezone = text(draft.timezone ?? 'Asia/Shanghai', '时区', 100, true)
  try { dayAt(timezone, 0) } catch { throw new Error('成员时区无效') }
  if (!Array.isArray(draft.capabilities) || draft.capabilities.length > MEMBER_CAPABILITIES.length
    || draft.capabilities.some(value => !MEMBER_CAPABILITIES.includes(value))) throw new Error('成员能力无效')
  // 作业输出、目标信息属于全局上下文；不能借通用只读授权读取其他成员的历史。
  const allowed = READ_ONLY_ALLOW_TOOLS.filter(name => !CHILD_LOCAL_TOOLS.includes(name)
    && !READ_ONLY_DENY_CANDIDATES.includes(name) && !['job_list', 'job_output', 'get_goal'].includes(name))
  if (!Array.isArray(draft.allowedTools) || draft.allowedTools.length > allowed.length
    || draft.allowedTools.some(name => !allowed.includes(name))) throw new Error('工具不在成员安全只读白名单内')
  if (!!text(draft.provider, '模型提供方', 200) !== !!text(draft.model, '模型名称', 200)) throw new Error('模型提供方和模型必须同时填写，或同时留空使用默认模型')
  const permissionMode = draft.permissionMode ?? 'ask'
  if (!MEMBER_PERMISSION_MODES.includes(permissionMode)) throw new Error('权限只能是每次询问、自动审批或完全访问')
  return { displayName: text(draft.displayName, '成员名称', 80, true), description: text(draft.description, '职责说明', 4000),
    personality: text(draft.personality ?? '', '性格与表达风格', 2000), permissionMode,
    persona: text(draft.persona, '人设', 16000), skinId, enabled: draft.enabled,
    provider: text(draft.provider, '模型提供方', 200), model: text(draft.model, '模型名称', 200),
    maxTokens: integer(draft.maxTokens, '单次输出额度', 1, 32768), capabilities: [...new Set(draft.capabilities)],
    allowedTools: [...new Set(draft.allowedTools)], dailyTokenLimit: integer(draft.dailyTokenLimit, '日额度'),
    totalTokenLimit: integer(draft.totalTokenLimit, '总额度'), thresholdPercent: integer(draft.thresholdPercent ?? 80, '申请阈值', 1, 100), timezone }
}

export class MemberDirectory {
  private readonly db: DatabaseSync
  private readonly transaction: Transaction

  constructor(db: DatabaseSync, transaction?: Transaction) {
    this.db = db
    // 独立使用时也可重入；TeamStore 必须传入自身事务，避免嵌套 BEGIN。
    this.transaction = transaction ?? (<T>(body: () => T): T => {
      if (db.isTransaction) return body()
      db.exec('BEGIN IMMEDIATE')
      try { const result = body(); db.exec('COMMIT'); return result }
      catch (error) { db.exec('ROLLBACK'); throw error }
    })
    // 单宿主写入：新建目录代表恢复现场，绝不把中断请求当作零消耗或重新派发。
    // 无待恢复请求时只读，当前版本重复打开不补写默认配置。
    const interrupted = db.prepare(`SELECT DISTINCT assistant_id FROM member_usage WHERE state = 'pending'`).all() as Row[]
    if (interrupted.length) this.transaction(() => {
      const now = Date.now()
      db.prepare(`UPDATE member_usage SET state = 'unknown', finished_at = ? WHERE state = 'pending'`).run(now)
      for (const row of interrupted) {
        const profile = this.require(String(row.assistant_id))
        this.notifyThreshold(profile.assistantId, this.measure(profile, now).view, now)
      }
    })
  }

  list(): MemberProfile[] {
    return (this.db.prepare(`SELECT a.*, p.data FROM assistants a LEFT JOIN assistant_profiles p USING(assistant_id)
      WHERE a.role_id != 'tangseng' AND a.assistant_id NOT IN ('chief', 'member-tangseng') ORDER BY a.rowid`).all() as Row[])
      .map(row => this.profile(row))
  }

  get(id: string): MemberProfile | null {
    const row = this.db.prepare(`SELECT a.*, p.data FROM assistants a LEFT JOIN assistant_profiles p USING(assistant_id)
      WHERE a.assistant_id = ? AND a.role_id != 'tangseng' AND a.assistant_id NOT IN ('chief', 'member-tangseng')`).get(id) as Row | undefined
    return row ? this.profile(row) : null
  }

  private profile(row: Row): MemberProfile {
    const extra = { ...defaults(), ...(row.data ? JSON.parse(String(row.data)) as Extension : {}) }
    const policy = JSON.parse(String(row.tool_policy)) as ToolPolicy
    return { ...extra, assistantId: String(row.assistant_id), roleId: row.role_id as RoleId, displayName: String(row.display_name),
      skinId: String(row.skin_id), persona: String(row.persona), voiceProfile: String(row.voice_profile),
      toolPolicy: policy, enabled: Number(row.enabled) === 1, revision: Number(row.revision) }
  }

  private require(id: string): MemberProfile {
    const profile = this.get(id)
    if (!profile) throw new Error('成员不存在或属于总助理')
    return profile
  }

  private validateUnique(draft: MemberDraft, id?: string): void {
    const names = this.db.prepare('SELECT assistant_id, display_name FROM assistants').all() as Row[]
    if (names.some(row => row.assistant_id !== id && String(row.display_name).trim().normalize('NFKC').toLowerCase()
      === draft.displayName.normalize('NFKC').toLowerCase())) throw new Error('成员名称已存在')
    if (draft.enabled && draft.capabilities.includes('wecom')
      && this.list().some(member => member.assistantId !== id && member.enabled && member.capabilities.includes('wecom'))) {
      throw new Error('最多只能启用一位具有企业微信能力的成员')
    }
  }

  private saveExtra(profile: MemberProfile): void {
    this.db.prepare(`INSERT INTO assistant_profiles(assistant_id, data) VALUES (?, ?)
      ON CONFLICT(assistant_id) DO UPDATE SET data = excluded.data`).run(profile.assistantId, JSON.stringify(extension(profile)))
  }

  create(draft: MemberDraft): MemberProfile {
    const normalized = normalize(draft)
    return this.transaction(() => {
      this.validateUnique(normalized)
      const profile: MemberProfile = { ...normalized, assistantId: `member-${randomUUID()}`, roleId: 'custom', voiceProfile: '',
        toolPolicy: { mode: 'read-only', denyTools: [] }, revision: 1, sessionId: null }
      this.db.prepare(`INSERT INTO assistants(assistant_id, role_id, display_name, skin_id, persona, voice_profile, tool_policy, enabled, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(profile.assistantId, profile.roleId, profile.displayName, profile.skinId,
        profile.persona, profile.voiceProfile, JSON.stringify(profile.toolPolicy), Number(profile.enabled), profile.revision)
      this.saveExtra(profile)
      this.ensureAccount(profile.assistantId)
      return profile
    })
  }

  update(id: string, expectedRevision: number, draft: MemberDraft): MemberProfile {
    integer(expectedRevision, '成员修订号', 1, MAX - 1)
    const normalized = normalize(draft)
    return this.transaction(() => {
      const current = this.require(id)
      if (current.revision !== expectedRevision) throw new Error('成员修订冲突，请刷新后重试')
      this.validateUnique(normalized, id)
      const permissionsChanged = !sameSet(current.capabilities, normalized.capabilities) || !sameSet(current.allowedTools, normalized.allowedTools)
        || current.toolPolicy.mode !== 'read-only'
      const next: MemberProfile = { ...current, ...normalized, revision: current.revision + 1,
        toolPolicy: { mode: 'read-only', denyTools: [...current.toolPolicy.denyTools] }, sessionId: permissionsChanged ? null : current.sessionId }
      const changed = this.db.prepare(`UPDATE assistants SET display_name = ?, skin_id = ?, persona = ?, enabled = ?, tool_policy = ?, revision = ?
        WHERE assistant_id = ? AND revision = ?`).run(next.displayName, next.skinId, next.persona, Number(next.enabled),
        JSON.stringify(next.toolPolicy), next.revision, id, expectedRevision)
      if (Number(changed.changes) !== 1) throw new Error('成员修订冲突，请刷新后重试')
      this.saveExtra(next)
      if (current.dailyTokenLimit !== next.dailyTokenLimit || current.totalTokenLimit !== next.totalTokenLimit
        || current.thresholdPercent !== next.thresholdPercent || current.timezone !== next.timezone) {
        this.advanceQuota(id, this.quotaRevision(id))
        const now = Date.now()
        this.notifyThreshold(id, this.measure(next, now).view, now)
      }
      return next
    })
  }

  /**
   * 删除成员本体的配置与额度账本；团队任务、DSH 会话和独立记忆保留作审计，
   * 但目录、路由和记忆入口都不再认识这个 id。进行中的请求必须先结算。
   */
  delete(id: string, expectedRevision: number): void {
    integer(expectedRevision, '成员修订号', 1, MAX - 1)
    this.transaction(() => {
      const profile = this.require(id)
      if (profile.revision !== expectedRevision) throw new Error('成员修订冲突，请刷新后重试')
      if (this.hasInFlight(id)) throw new Error('成员仍有进行中的请求，结算前不能删除')
      for (const table of ['member_usage', 'member_quota_requests', 'member_quota_resets', 'member_quota_accounts', 'assistant_profiles']) {
        this.db.prepare(`DELETE FROM ${table} WHERE assistant_id = ?`).run(id)
      }
      const changed = this.db.prepare('DELETE FROM assistants WHERE assistant_id = ? AND revision = ?').run(id, expectedRevision)
      if (Number(changed.changes) !== 1) throw new Error('成员修订冲突，请刷新后重试')
    })
  }

  /** 会话引用与成员修订分离；权限变化由 update 清空，历史日志仍由宿主管理。 */
  setSession(id: string, sessionId: string | null): void {
    if (sessionId !== null) sessionId = text(sessionId, '会话编号', 256, true)
    this.transaction(() => {
      const profile = this.require(id)
      if (sessionId !== null && this.list().some(member => member.assistantId !== id && member.sessionId === sessionId)) {
        throw new Error('成员必须使用独立会话，不能共用其他成员的会话')
      }
      this.saveExtra({ ...profile, sessionId })
    })
  }

  private ensureAccount(id: string): void {
    this.db.prepare('INSERT OR IGNORE INTO member_quota_accounts(assistant_id) VALUES (?)').run(id)
  }
  private quotaRevision(id: string): number {
    const row = this.db.prepare('SELECT revision FROM member_quota_accounts WHERE assistant_id = ?').get(id) as Row | undefined
    return Number(row?.revision ?? 1)
  }
  private assertQuotaRevision(id: string, expected: number): void {
    integer(expected, '额度修订号', 1, MAX - 1)
    if (this.quotaRevision(id) !== expected) throw new Error('额度修订冲突，请刷新后重试')
  }
  private advanceQuota(id: string, expected: number): void {
    this.assertQuotaRevision(id, expected)
    this.ensureAccount(id)
    const changed = this.db.prepare('UPDATE member_quota_accounts SET revision = revision + 1 WHERE assistant_id = ? AND revision = ?').run(id, expected)
    if (Number(changed.changes) !== 1) throw new Error('额度修订冲突，请刷新后重试')
    // 配额配置或基线已改变，旧申请失效；驳回本身不提升修订，避免反复刷申请。
    this.db.prepare(`UPDATE member_quota_requests SET state = 'rejected' WHERE assistant_id = ? AND state = 'pending'`).run(id)
  }

  private measure(profile: MemberProfile, now: number, bookedDay?: string): { view: MemberQuotaView; remaining: number } {
    const id = profile.assistantId
    const day = bookedDay ?? dayAt(profile.timezone, now)
    const base = this.db.prepare(`SELECT
      COALESCE(MAX(CASE WHEN scope IN ('daily', 'both') AND day = ? THEN usage_through END), 0) AS daily,
      COALESCE(MAX(CASE WHEN scope IN ('total', 'both') THEN usage_through END), 0) AS total,
      COALESCE(MAX(CASE WHEN scope = 'both' THEN usage_through END), 0) AS cleared
      FROM member_quota_resets WHERE assistant_id = ?`).get(day, id) as Row
    let dailyUsed = 0, totalUsed = 0, dailyReserved = 0, totalReserved = 0, unknown = false
    const rows = this.db.prepare(`SELECT seq, day, state, tokens, reserved FROM member_usage WHERE assistant_id = ?
      AND (seq > ? OR (day = ? AND seq > ?) OR (state = 'unknown' AND seq > ?))`)
      .all(id, base.total, day, base.daily, base.cleared) as Row[]
    for (const row of rows) {
      const seq = Number(row.seq)
      if (row.state === 'unknown' && seq > Number(base.cleared)) unknown = true
      const count = Number(row.state === 'finished' ? row.tokens : row.state === 'pending' ? row.reserved : 0)
      if (seq > Number(base.total)) {
        if (row.state === 'finished') totalUsed = saturatedAdd(totalUsed, count)
        else totalReserved = saturatedAdd(totalReserved, count)
      }
      if (row.day === day && seq > Number(base.daily)) {
        if (row.state === 'finished') dailyUsed = saturatedAdd(dailyUsed, count)
        else dailyReserved = saturatedAdd(dailyReserved, count)
      }
    }
    const remaining = Math.max(0, Math.min(profile.maxTokens,
      profile.dailyTokenLimit === 0 ? MAX : profile.dailyTokenLimit - dailyUsed - dailyReserved,
      profile.totalTokenLimit === 0 ? MAX : profile.totalTokenLimit - totalUsed - totalReserved))
    return { view: { day, dailyUsed, totalUsed, dailyTokenLimit: profile.dailyTokenLimit, totalTokenLimit: profile.totalTokenLimit,
      thresholdPercent: profile.thresholdPercent, unknown, blocked: !profile.enabled || unknown || remaining < 1, revision: this.quotaRevision(id) }, remaining }
  }

  private atThreshold(view: MemberQuotaView): boolean {
    // 用整数比较，避免安全整数附近乘百分比后丢精度。
    return view.unknown || [[view.dailyUsed, view.dailyTokenLimit], [view.totalUsed, view.totalTokenLimit]]
      .some(([used, limit]) => limit > 0 && BigInt(used) * 100n >= BigInt(limit) * BigInt(view.thresholdPercent))
  }
  private requestRow(row: Row): MemberQuotaRequest {
    return { requestId: String(row.request_id), assistantId: String(row.assistant_id), reason: String(row.reason),
      state: row.state as MemberQuotaRequest['state'], createdAt: Number(row.created_at), quotaRevision: Number(row.quota_revision) }
  }
  private recordRequest(id: string, view: MemberQuotaView, reason: string, now: number): MemberQuotaRequest {
    this.db.prepare(`INSERT OR IGNORE INTO member_quota_requests(request_id, assistant_id, day, quota_revision, reason, state, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(`quota-${randomUUID()}`, id, view.day, view.revision, reason, timestamp(now))
    return this.requestRow(this.db.prepare(`SELECT * FROM member_quota_requests WHERE assistant_id = ? AND quota_revision = ? AND day = ?`)
      .get(id, view.revision, view.day) as Row)
  }
  private notifyThreshold(id: string, view: MemberQuotaView, now: number): void {
    if (this.atThreshold(view)) this.recordRequest(id, view, view.unknown ? '模型用量未知，请核查并明确重置日额度与总额度' : '成员用量已达到额度申请阈值', now)
  }

  quota(id: string, now = Date.now()): MemberQuotaView {
    return this.transaction(() => {
      const { view } = this.measure(this.require(id), now)
      this.notifyThreshold(id, view, now)
      return view
    })
  }
  requests(): MemberQuotaRequest[] {
    return (this.db.prepare('SELECT * FROM member_quota_requests ORDER BY created_at DESC, rowid DESC').all() as Row[]).map(row => this.requestRow(row))
  }
  requestQuota(id: string, reason: string, now = Date.now()): MemberQuotaRequest {
    reason = text(reason, '申请原因', 2000, true)
    return this.transaction(() => {
      const { view } = this.measure(this.require(id), now)
      if (!this.atThreshold(view)) throw new Error('成员用量尚未达到申请阈值')
      return this.recordRequest(id, view, reason, now)
    })
  }
  private unavailable(profile: MemberProfile, view: MemberQuotaView): string | null {
    if (!profile.enabled) return '成员已停用，无法开始请求'
    if (view.unknown) return '成员存在未知用量，必须核查并明确重置日额度与总额度后才能继续'
    if (view.blocked) return '成员额度已用完或已被进行中的请求预留，请等待结算或申请加额'
    return null
  }
  checkAvailable(id: string, now = Date.now()): void {
    const reason = this.transaction(() => {
      const profile = this.require(id)
      const { view } = this.measure(profile, now)
      this.notifyThreshold(id, view, now)
      return this.unavailable(profile, view)
    })
    if (reason) throw new Error(reason)
  }

  /** 仅保守预留输出。输入和厂商计费只能事后得知，实际用量可越额，不能承诺计费硬上限。 */
  beginUsage(id: string, requestId: string, now = Date.now()): { maxTokens: number } {
    requestId = text(requestId, '请求编号', 256, true)
    const result = this.transaction(() => {
      const profile = this.require(id)
      if (this.db.prepare('SELECT 1 FROM member_usage WHERE request_id = ?').get(requestId)) throw new Error('请求编号已登记，禁止重复执行或跨成员复用')
      const { view, remaining } = this.measure(profile, now)
      this.notifyThreshold(id, view, now)
      const error = this.unavailable(profile, view)
      if (error) return { error, maxTokens: 0 }
      this.db.prepare(`INSERT INTO member_usage(request_id, assistant_id, day, timezone, reserved, tokens, state, started_at)
        VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?)`).run(requestId, id, view.day, profile.timezone, remaining, timestamp(now))
      return { error: null, maxTokens: remaining }
    })
    if (result.error) throw new Error(result.error)
    return { maxTokens: result.maxTokens }
  }

  finishUsage(requestId: string, tokens: number | null, now = Date.now()): void {
    timestamp(now)
    if (tokens !== null) integer(tokens, '实际用量', 1)
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM member_usage WHERE request_id = ?').get(requestId) as Row | undefined
      if (!row) throw new Error('用量请求不存在')
      if (row.state !== 'pending') {
        if ((row.state === 'unknown' && tokens === null) || (row.state === 'finished' && Number(row.tokens) === tokens)) return
        throw new Error('同一请求的用量结算冲突，不能覆盖原账')
      }
      this.db.prepare(`UPDATE member_usage SET tokens = ?, state = ?, finished_at = ? WHERE request_id = ? AND state = 'pending'`)
        .run(tokens, tokens === null ? 'unknown' : 'finished', now, requestId)
      const profile = this.require(String(row.assistant_id))
      // 跨午夜或期间更换时区，仍使用请求起始时保存的归账日期。
      this.notifyThreshold(profile.assistantId, this.measure(profile, now, String(row.day)).view, now)
      const current = this.measure(profile, now).view
      this.notifyThreshold(profile.assistantId, current, now)
    })
  }

  hasInFlight(id: string): boolean {
    this.require(id)
    return !!this.db.prepare(`SELECT 1 FROM member_usage WHERE assistant_id = ? AND state = 'pending' LIMIT 1`).get(id)
  }
  private validateReset(id: string, scope: ResetScope, now: number): MemberQuotaView {
    scopeOf(scope)
    const { view } = this.measure(this.require(id), now)
    if (this.hasInFlight(id)) throw new Error('成员仍有进行中的请求，结算前不能重置额度')
    if (view.unknown && scope !== 'both') throw new Error('未知用量只能同时重置日额度与总额度')
    return view
  }
  private recordReset(id: string, revision: number, scope: ResetScope, view: MemberQuotaView, now: number): void {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM member_usage WHERE assistant_id = ?').get(id) as Row
    // 基线只引用已登记的审计序号，不删用量；未知记录也原样保留，只有 both 的基线解除阻塞。
    this.db.prepare(`INSERT INTO member_quota_resets(reset_id, assistant_id, quota_revision, scope, day, usage_through, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`reset-${randomUUID()}`, id, revision, scope, view.day, row.seq, timestamp(now))
  }
  resetQuota(id: string, expectedQuotaRevision: number, scope: ResetScope, now = Date.now()): void {
    this.transaction(() => {
      this.require(id)
      this.assertQuotaRevision(id, expectedQuotaRevision)
      const view = this.validateReset(id, scope, now)
      this.recordReset(id, expectedQuotaRevision + 1, scope, view, now)
      this.advanceQuota(id, expectedQuotaRevision)
    })
  }

  decideRequest(requestId: string, decision: 'approve' | 'reject', expectedQuotaRevision: number,
    change?: { dailyTokenLimit?: number; totalTokenLimit?: number; reset?: ResetScope }): void {
    if (!['approve', 'reject'].includes(decision)) throw new Error('申请决定无效')
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM member_quota_requests WHERE request_id = ?').get(requestId) as Row | undefined
      if (!row) throw new Error('额度申请不存在')
      if (row.state !== 'pending') throw new Error('额度申请已处理，不能重复决定')
      const id = String(row.assistant_id)
      const profile = this.require(id)
      this.assertQuotaRevision(id, expectedQuotaRevision)
      if (Number(row.quota_revision) !== expectedQuotaRevision) throw new Error('申请所依据的额度修订已失效')
      if (decision === 'reject') {
        if (change && Object.values(change).some(value => value !== undefined)) throw new Error('拒绝申请不能同时修改额度')
        this.db.prepare(`UPDATE member_quota_requests SET state = 'rejected' WHERE request_id = ?`).run(requestId)
        return
      }
      const now = Date.now()
      let changed = false
      const next = { ...profile }
      for (const key of ['dailyTokenLimit', 'totalTokenLimit'] as const) {
        if (change?.[key] === undefined) continue
        const limit = integer(change[key], key === 'dailyTokenLimit' ? '日额度' : '总额度')
        if (limit === profile[key]) continue
        if (profile[key] === 0 || (limit !== 0 && limit < profile[key])) throw new Error('批准申请只能明确增加额度，不能减少额度')
        next[key] = limit
        changed = true
      }
      const reset = change?.reset
      let view: MemberQuotaView | undefined
      if (reset !== undefined) {
        view = this.validateReset(id, reset, now)
        changed ||= (reset !== 'total' && view.dailyUsed > 0) || (reset !== 'daily' && view.totalUsed > 0) || (reset === 'both' && view.unknown)
      }
      if (!changed) throw new Error('批准必须明确加额或有效重置，不能批准空操作')
      if (next.dailyTokenLimit !== profile.dailyTokenLimit || next.totalTokenLimit !== profile.totalTokenLimit) {
        integer(profile.revision, '成员修订号', 1, MAX - 1)
        const result = this.db.prepare('UPDATE assistants SET revision = revision + 1 WHERE assistant_id = ? AND revision = ?').run(id, profile.revision)
        if (Number(result.changes) !== 1) throw new Error('成员修订冲突，请刷新后重试')
        this.saveExtra(next)
      }
      if (reset !== undefined && view) this.recordReset(id, expectedQuotaRevision + 1, reset, view, now)
      this.advanceQuota(id, expectedQuotaRevision)
      this.db.prepare(`UPDATE member_quota_requests SET state = 'approved' WHERE request_id = ?`).run(requestId)
      // 本层只变更额度，不启动或恢复任何任务。
    })
  }
}
