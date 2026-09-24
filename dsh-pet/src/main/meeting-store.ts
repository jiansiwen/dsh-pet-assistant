/**
 * 会议持久层：userData/meetings.sqlite（node:sqlite）+ userData/meetings/<id>/ 下的加密 chunk。
 *
 * 分工：
 * - 数据库只存元数据（会议行、chunk 的 seq/path/sha256、转写段、纪要、助理播报区间）。
 * - 音频本体一律 AES-256-GCM 加密后落 chunk-<seq>.enc，明文 PCM 不写盘；旁边一个
 *   sidecar JSON（seq/ts/sha256/gapAfterMs）记时间与断流间隔，读取时按 sha 校验。
 * - 数据密钥来自 dpapi.ts（DPAPI CurrentUser 包装）。**没拿到密钥就拒绝 startMeeting**：
 *   录了却加密不了，等于把参会者的话明文留在磁盘上。
 *
 * 转写段带 revision：说话人改名/合并/拆分都会 bump，纪要确认绑定 revision——确认过的
 * 纪要再被修订就自动退回草稿，防止"确认的文本"和"库里的段"对不上。
 *
 * 保留期：enforceRetention 到点删除 chunk 文件与行（录音本体），转写与纪要保留。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getDataKey, type DpapiDeps, type DpapiResult } from './dpapi.ts'

/** 录音来源。loopback 是系统回环声（会议里别人说话的声音），拿不到时如实标缺失，不伪造。 */
export type MeetingSources = 'mic' | 'mic+loopback'

export type MeetingStateName =
  | 'recording'
  | 'stopped'
  | 'transcribing'
  | 'transcribed'
  | 'transcript-failed'
  | 'expired'

/** 用户知情同意记录。整份 JSON 存进 meetings.consent：日后要能回答"当时同意的是什么"。 */
export interface MeetingConsentInput {
  readonly name: string
  readonly sources: MeetingSources
  readonly consentText: string
  readonly consented: boolean
  readonly retentionDays: number
}

export interface MeetingRow {
  readonly id: string
  readonly name: string
  readonly startedAt: number
  readonly endedAt: number | null
  readonly sources: MeetingSources
  readonly consent: MeetingConsentInput
  readonly retentionDays: number
  readonly state: MeetingStateName
  readonly segmentsRevision: number
}

/** chunk 落盘旁的 sidecar：时间与断流间隔。sha256 是 .enc 文件内容的摘要。 */
export interface ChunkSidecar {
  readonly seq: number
  readonly ts: number
  readonly sha256: string
  readonly gapAfterMs: number | null
}

/** 一条转写段。speaker 是稳定 id（合并/拆分改它），label 是给人看的名字（改名改它）。 */
export interface TranscriptSegment {
  readonly idx: number
  readonly speaker: string
  readonly label: string
  /** 说话人未经用户确认。ASR 不猜说话人，机器产出的段一律 true。 */
  readonly uncertain: boolean
  readonly startMs: number | null
  readonly endMs: number | null
  readonly text: string
  readonly source: string
}

export interface MinutesRecord {
  readonly revision: number
  readonly content: string
  readonly digest: string
  readonly state: 'draft' | 'confirmed'
  readonly confirmedAt: number | null
}

export interface AssistantSpeechSpan {
  readonly startMs: number
  readonly endMs: number
}

export interface MeetingStoreDeps {
  /** 数据密钥来源。默认走 DPAPI；测试注入假密钥。 */
  readonly keyProvider?: () => DpapiResult
  readonly dpapi?: DpapiDeps
  readonly now?: () => number
  readonly randomId?: () => string
  /**
   * chunk 断流阈值：相邻两个 chunk 的 ts 间隔超过它就往**前一个** chunk 的 sidecar 记
   * gapAfterMs。默认 8000ms（渲染层约每 4 秒推一块，两倍间隔才算断流）。
   */
  readonly gapThresholdMs?: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  startedAt INTEGER NOT NULL,
  endedAt INTEGER,
  sources TEXT NOT NULL,
  consent TEXT NOT NULL,
  retentionDays INTEGER NOT NULL,
  state TEXT NOT NULL,
  segmentsRevision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chunks (
  meetingId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (meetingId, seq)
);
CREATE TABLE IF NOT EXISTS transcript_segments (
  meetingId TEXT NOT NULL,
  revision INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  label TEXT NOT NULL,
  uncertain INTEGER NOT NULL DEFAULT 1,
  startMs INTEGER,
  endMs INTEGER,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'asr',
  PRIMARY KEY (meetingId, idx)
);
CREATE TABLE IF NOT EXISTS minutes (
  meetingId TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  confirmedAt INTEGER
);
CREATE TABLE IF NOT EXISTS assistant_speech (
  meetingId TEXT NOT NULL,
  startMs INTEGER NOT NULL,
  endMs INTEGER NOT NULL
);
`

const DAY_MS = 86_400_000

function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 密钥不可用时给用户的那句话。lost 与 unsupported 分开说：
 * 前者是**数据可能救不回来**（密钥损坏/换了机器），后者是**这台机器上拿不到系统密钥库**。
 * 两种都拒绝开新会议，但用户该做的事完全不同 —— 混成一句会把可修的问题说成灾难。
 */
export function keyErrorMessage(result: DpapiResult): string {
  switch (result.status) {
    case 'lost':
      return `会议密钥解不开（${result.message}）。既有录音无法解密，新会议也不开——重设密钥等于把旧录音永久丢掉。`
    case 'unsupported':
      return '这台机器上拿不到系统密钥库（Windows 的 DPAPI / macOS 的钥匙串），没法安全地保管会议密钥，因此不录制。'
    case 'error':
      return `无法创建会议密钥：${result.message}`
    case 'ok':
      return ''
  }
}

/**
 * 校验知情同意与会议参数。返回 null 表示通过，否则是要给用户看的那句拒绝原因。
 * 这是持久化边界：IPC 上来的对象什么形状都可能有，必填项一个都不能信。
 */
export function validateMeetingConsent(consent: unknown): string | null {
  if (consent === null || typeof consent !== 'object') return '缺少会议参数'
  const value = consent as Partial<MeetingConsentInput>
  if (typeof value.name !== 'string' || value.name.trim() === '') return '要给这场会议起个名字'
  if (value.name.trim().length > 80) return '会议名字太长了（最多 80 字）'
  if (value.sources !== 'mic' && value.sources !== 'mic+loopback') return '录音来源只能是 mic 或 mic+loopback'
  if (typeof value.consentText !== 'string' || value.consentText.trim() === '') return '缺少知情同意文本'
  if (value.consented !== true) return '需要先勾选知情同意：录音会落盘加密保存，参会者应当知情'
  if (
    typeof value.retentionDays !== 'number'
    || !Number.isInteger(value.retentionDays)
    || value.retentionDays < 1
    || value.retentionDays > 3650
  ) {
    return '保留天数必须是 1–3650 之间的整数'
  }
  return null
}

interface Row {
  [key: string]: string | number | bigint | Uint8Array | null
}

export class MeetingStore {
  private readonly db: DatabaseSync
  private readonly userDataDir: string
  private readonly deps: MeetingStoreDeps
  private readonly gapThresholdMs: number
  /** 解出来的数据密钥，进程内缓存：每 4 秒 spawn 一次 PowerShell 解包是不可接受的开销。 */
  private cachedKey: Buffer | null = null

  constructor(userDataDir: string, deps: MeetingStoreDeps = {}) {
    this.userDataDir = userDataDir
    this.deps = deps
    this.gapThresholdMs = deps.gapThresholdMs ?? 8000
    mkdirSync(userDataDir, { recursive: true })
    this.db = new DatabaseSync(path.join(userDataDir, 'meetings.sqlite'))
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** 取数据密钥（带缓存）。失败时返回带用户话术的错误。 */
  private ensureKey(): { ok: true; key: Buffer } | { ok: false; error: string } {
    if (this.cachedKey !== null) return { ok: true, key: this.cachedKey }
    const provider = this.deps.keyProvider ?? ((): DpapiResult => getDataKey(this.userDataDir, this.deps.dpapi ?? {}))
    const result = provider()
    if (result.status !== 'ok') return { ok: false, error: keyErrorMessage(result) }
    if (result.key.length !== 32) return { ok: false, error: '会议密钥长度不对（应为 32 字节）' }
    this.cachedKey = result.key
    return { ok: true, key: result.key }
  }

  meetingDir(meetingId: string): string {
    return path.join(this.userDataDir, 'meetings', meetingId)
  }

  /**
   * 开一场会议。参数校验不过、或拿不到数据密钥，都拒绝——**绝不先录再补加密**。
   */
  startMeeting(consent: MeetingConsentInput): { ok: true; meetingId: string } | { ok: false; error: string } {
    const invalid = validateMeetingConsent(consent)
    if (invalid !== null) return { ok: false, error: invalid }
    const key = this.ensureKey()
    if (!key.ok) return { ok: false, error: key.error }
    const id = (this.deps.randomId ?? randomUUID)()
    const normalized: MeetingConsentInput = {
      name: consent.name.trim(),
      sources: consent.sources,
      consentText: consent.consentText.trim(),
      consented: true,
      retentionDays: consent.retentionDays,
    }
    mkdirSync(this.meetingDir(id), { recursive: true })
    this.db
      .prepare(
        'INSERT INTO meetings (id, name, startedAt, endedAt, sources, consent, retentionDays, state, segmentsRevision) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0)',
      )
      .run(id, normalized.name, this.now(), normalized.sources, JSON.stringify(normalized), normalized.retentionDays, 'recording')
    return { ok: true, meetingId: id }
  }

  getMeeting(meetingId: string): MeetingRow | null {
    const row = this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId) as Row | undefined
    if (row === undefined) return null
    return this.toMeetingRow(row)
  }

  private toMeetingRow(row: Row): MeetingRow {
    let consent: MeetingConsentInput
    try {
      consent = JSON.parse(String(row.consent)) as MeetingConsentInput
    } catch {
      // consent 列是 NOT NULL 且只由 startMeeting 写入；真坏了给一份如实标坏的占位，读取路径不炸。
      consent = { name: String(row.name), sources: 'mic', consentText: '(同意记录损坏)', consented: true, retentionDays: Number(row.retentionDays) }
    }
    return {
      id: String(row.id),
      name: String(row.name),
      startedAt: Number(row.startedAt),
      endedAt: row.endedAt === null ? null : Number(row.endedAt),
      sources: String(row.sources) as MeetingSources,
      consent,
      retentionDays: Number(row.retentionDays),
      state: String(row.state) as MeetingStateName,
      segmentsRevision: Number(row.segmentsRevision),
    }
  }

  listMeetings(limit = 20): MeetingRow[] {
    const rows = this.db.prepare('SELECT * FROM meetings ORDER BY startedAt DESC LIMIT ?').all(limit) as Row[]
    return rows.map(row => this.toMeetingRow(row))
  }

  setMeetingState(meetingId: string, state: MeetingStateName): void {
    this.db.prepare('UPDATE meetings SET state = ? WHERE id = ?').run(state, meetingId)
  }

  stopMeeting(meetingId: string, endedAt: number = this.now()): void {
    this.db.prepare("UPDATE meetings SET endedAt = ?, state = 'stopped' WHERE id = ? AND state = 'recording'").run(endedAt, meetingId)
  }

  /**
   * 追加一块 PCM：AES-256-GCM 加密落盘 + sidecar + 表行。明文只存在于内存。
   *
   * gap 检测在这里做：ts 与上一块的间隔超过阈值，就把间隔写进**上一块**的 sidecar
   * （gapAfterMs 语义是"这块之后断了多久"）。
   */
  appendChunk(
    meetingId: string,
    pcm: Buffer | Uint8Array,
    ts: number,
  ): { ok: true; seq: number; gapAfterMs: number | null } | { ok: false; error: string } {
    const meeting = this.getMeeting(meetingId)
    if (meeting === null) return { ok: false, error: '没有这场会议' }
    if (meeting.state !== 'recording') return { ok: false, error: '这场会议不在录制中' }
    const key = this.ensureKey()
    if (!key.ok) return { ok: false, error: key.error }
    const plaintext = Buffer.from(pcm)

    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next, MAX(seq) AS last FROM chunks WHERE meetingId = ?')
      .get(meetingId) as Row
    const seq = Number(row.next)

    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key.key, nonce)
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    // 文件布局：nonce(12) || ciphertext || authTag(16)
    const enc = Buffer.concat([nonce, body, tag])
    const sha = sha256Hex(enc)

    const dir = this.meetingDir(meetingId)
    mkdirSync(dir, { recursive: true })
    const encPath = path.join(dir, `chunk-${seq}.enc`)
    const sidecarPath = path.join(dir, `chunk-${seq}.json`)
    const sidecar: ChunkSidecar = { seq, ts, sha256: sha, gapAfterMs: null }
    // 先临时文件再改名：崩溃不会留下半个 chunk 冒充完整数据。
    writeFileSync(`${encPath}.tmp`, enc)
    renameSync(`${encPath}.tmp`, encPath)
    writeFileSync(`${sidecarPath}.tmp`, JSON.stringify(sidecar))
    renameSync(`${sidecarPath}.tmp`, sidecarPath)

    // gap 回填到上一块的 sidecar。
    let gapAfterMs: number | null = null
    if (seq > 0) {
      const prevSidecar = this.readSidecar(meetingId, seq - 1)
      if (prevSidecar !== null) {
        const gap = ts - prevSidecar.ts
        if (gap > this.gapThresholdMs) {
          gapAfterMs = gap
          const updated: ChunkSidecar = { ...prevSidecar, gapAfterMs: gap }
          writeFileSync(path.join(dir, `chunk-${seq - 1}.json`), JSON.stringify(updated))
        }
      }
    }

    this.db
      .prepare('INSERT INTO chunks (meetingId, seq, path, sha256) VALUES (?, ?, ?, ?)')
      .run(meetingId, seq, encPath, sha)
    return { ok: true, seq, gapAfterMs }
  }

  private readSidecar(meetingId: string, seq: number): ChunkSidecar | null {
    const file = path.join(this.meetingDir(meetingId), `chunk-${seq}.json`)
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as ChunkSidecar
    } catch {
      return null
    }
  }

  listChunks(meetingId: string): Array<{ seq: number; path: string; sha256: string; sidecar: ChunkSidecar | null }> {
    const rows = this.db
      .prepare('SELECT seq, path, sha256 FROM chunks WHERE meetingId = ? ORDER BY seq')
      .all(meetingId) as Row[]
    return rows.map(row => ({
      seq: Number(row.seq),
      path: String(row.path),
      sha256: String(row.sha256),
      sidecar: this.readSidecar(meetingId, Number(row.seq)),
    }))
  }

  /** 解密一块并校验 sha256。校验不过或 GCM tag 不对返回 null——坏块跳过，不冒充好数据。 */
  readChunk(meetingId: string, seq: number): Buffer | null {
    const row = this.db
      .prepare('SELECT path, sha256 FROM chunks WHERE meetingId = ? AND seq = ?')
      .get(meetingId, seq) as Row | undefined
    if (row === undefined) return null
    const key = this.ensureKey()
    if (!key.ok) return null
    let enc: Buffer
    try {
      enc = readFileSync(String(row.path))
    } catch {
      return null
    }
    if (sha256Hex(enc) !== String(row.sha256)) return null
    return decryptChunk(key.key, enc)
  }

  /** 按 seq 顺序读出全部明文 PCM。坏块进 corrupted，不中断读取。 */
  readAllChunks(meetingId: string): {
    chunks: Array<{ seq: number; ts: number; gapAfterMs: number | null; pcm: Buffer }>
    corrupted: number[]
  } {
    const chunks: Array<{ seq: number; ts: number; gapAfterMs: number | null; pcm: Buffer }> = []
    const corrupted: number[] = []
    for (const entry of this.listChunks(meetingId)) {
      const pcm = this.readChunk(meetingId, entry.seq)
      if (pcm === null) {
        corrupted.push(entry.seq)
        continue
      }
      chunks.push({ seq: entry.seq, ts: entry.sidecar?.ts ?? 0, gapAfterMs: entry.sidecar?.gapAfterMs ?? null, pcm })
    }
    return { chunks, corrupted }
  }

  // ===== 转写段 =====

  getSegments(meetingId: string): TranscriptSegment[] {
    const rows = this.db
      .prepare('SELECT revision, idx, speaker, label, uncertain, startMs, endMs, text, source FROM transcript_segments WHERE meetingId = ? ORDER BY idx')
      .all(meetingId) as Row[]
    return rows.map(row => ({
      idx: Number(row.idx),
      speaker: String(row.speaker),
      label: String(row.label),
      uncertain: Number(row.uncertain) === 1,
      startMs: row.startMs === null ? null : Number(row.startMs),
      endMs: row.endMs === null ? null : Number(row.endMs),
      text: String(row.text),
      source: String(row.source),
    }))
  }

  /**
   * 整表替换转写段并把 revision +1（表里只保留最新一版）。
   * 纪要 revision 落后于段 revision 时自动退回草稿：确认过的文本不能和库里的段脱节。
   */
  replaceSegments(meetingId: string, segments: readonly TranscriptSegment[]): { ok: true; revision: number } | { ok: false; error: string } {
    const meeting = this.getMeeting(meetingId)
    if (meeting === null) return { ok: false, error: '没有这场会议' }
    const revision = meeting.segmentsRevision + 1
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM transcript_segments WHERE meetingId = ?').run(meetingId)
      const insert = this.db.prepare(
        'INSERT INTO transcript_segments (meetingId, revision, idx, speaker, label, uncertain, startMs, endMs, text, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      segments.forEach((segment, i) => {
        insert.run(
          meetingId,
          revision,
          i,
          segment.speaker,
          segment.label,
          segment.uncertain ? 1 : 0,
          segment.startMs,
          segment.endMs,
          segment.text,
          segment.source,
        )
      })
      this.db.prepare('UPDATE meetings SET segmentsRevision = ? WHERE id = ?').run(revision, meetingId)
      this.db
        .prepare("UPDATE minutes SET state = 'draft', confirmedAt = NULL WHERE meetingId = ? AND revision < ?")
        .run(meetingId, revision)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true, revision }
  }

  /** 说话人改名：只动 label（给人看的），speaker id 不变。bump revision。 */
  renameSpeaker(meetingId: string, speaker: string, label: string): { ok: true; revision: number } | { ok: false; error: string } {
    if (label.trim() === '') return { ok: false, error: '新名字不能是空的' }
    const segments = this.getSegments(meetingId)
    if (!segments.some(segment => segment.speaker === speaker)) return { ok: false, error: '没有这个说话人' }
    return this.replaceSegments(
      meetingId,
      segments.map(segment =>
        segment.speaker === speaker
          ? { ...segment, label: label.trim(), uncertain: false }
          : segment,
      ),
    )
  }

  /** 合并：fromSpeaker 的段全部归到 intoSpeaker。bump revision。 */
  mergeSpeakers(meetingId: string, fromSpeaker: string, intoSpeaker: string): { ok: true; revision: number } | { ok: false; error: string } {
    if (fromSpeaker === intoSpeaker) return { ok: false, error: '不能把说话人合并到自己' }
    const segments = this.getSegments(meetingId)
    const target = segments.find(segment => segment.speaker === intoSpeaker)
    if (target === undefined) return { ok: false, error: '合并目标不存在' }
    if (!segments.some(segment => segment.speaker === fromSpeaker)) return { ok: false, error: '被合并的说话人不存在' }
    return this.replaceSegments(
      meetingId,
      segments.map(segment =>
        segment.speaker === fromSpeaker
          ? { ...segment, speaker: intoSpeaker, label: target.label }
          : segment,
      ),
    )
  }

  /** 拆分：把选中的段（按 idx）挪给一个新说话人。bump revision。 */
  splitSegments(meetingId: string, indexes: readonly number[], label: string): { ok: true; revision: number; speaker: string } | { ok: false; error: string } {
    if (label.trim() === '') return { ok: false, error: '新说话人要有名字' }
    if (indexes.length === 0) return { ok: false, error: '先选中要拆出去的段' }
    const segments = this.getSegments(meetingId)
    const wanted = new Set(indexes)
    if (!segments.some(segment => wanted.has(segment.idx))) return { ok: false, error: '选中的段不存在' }
    const speaker = nextSpeakerId(segments)
    const result = this.replaceSegments(
      meetingId,
      segments.map(segment =>
        wanted.has(segment.idx)
          ? { ...segment, speaker, label: label.trim(), uncertain: false }
          : segment,
      ),
    )
    return result.ok ? { ok: true, revision: result.revision, speaker } : result
  }

  // ===== 助理播报区间（TTS 不是真人发言） =====

  addAssistantSpeech(meetingId: string, startMs: number, endMs: number): void {
    if (endMs <= startMs) return
    this.db.prepare('INSERT INTO assistant_speech (meetingId, startMs, endMs) VALUES (?, ?, ?)').run(meetingId, startMs, endMs)
  }

  listAssistantSpeech(meetingId: string): AssistantSpeechSpan[] {
    const rows = this.db
      .prepare('SELECT startMs, endMs FROM assistant_speech WHERE meetingId = ? ORDER BY startMs')
      .all(meetingId) as Row[]
    return rows.map(row => ({ startMs: Number(row.startMs), endMs: Number(row.endMs) }))
  }

  // ===== 纪要 =====

  getMinutes(meetingId: string): MinutesRecord | null {
    const row = this.db.prepare('SELECT revision, content, digest, state, confirmedAt FROM minutes WHERE meetingId = ?').get(meetingId) as
      | Row
      | undefined
    if (row === undefined) return null
    return {
      revision: Number(row.revision),
      content: String(row.content),
      digest: String(row.digest),
      state: String(row.state) as 'draft' | 'confirmed',
      confirmedAt: row.confirmedAt === null ? null : Number(row.confirmedAt),
    }
  }

  /**
   * 存一版纪要草稿。同 revision、同内容且已确认的纪要原样保留：重复转写不该把用户
   * 点过的确认悄悄撤掉。
   */
  saveMinutes(meetingId: string, content: string, revision: number): void {
    const digest = sha256Hex(content)
    const existing = this.getMinutes(meetingId)
    if (existing !== null && existing.state === 'confirmed' && existing.revision === revision && existing.digest === digest) return
    this.db
      .prepare(
        "INSERT INTO minutes (meetingId, revision, content, digest, state, confirmedAt) VALUES (?, ?, ?, ?, 'draft', NULL) " +
          'ON CONFLICT(meetingId) DO UPDATE SET revision = excluded.revision, content = excluded.content, digest = excluded.digest, state = \'draft\', confirmedAt = NULL',
      )
      .run(meetingId, revision, content, digest)
  }

  /**
   * 确认纪要。**只有 userClicked === true 才确认**：转写流水线自己不能把纪要变成
   * "已确认"，那需要用户亲手点一下（§2.11 不能伪造 UI 批准，同一原则）。
   * 段修订过（纪要 revision 落后）也拒绝：确认的必须是眼前这一版。
   */
  confirmMinutes(
    meetingId: string,
    opts: { userClicked: boolean },
  ): { ok: true; confirmedAt: number } | { ok: false; error: string } {
    if (opts.userClicked !== true) return { ok: false, error: '纪要确认必须由用户亲手点击' }
    const meeting = this.getMeeting(meetingId)
    if (meeting === null) return { ok: false, error: '没有这场会议' }
    const minutes = this.getMinutes(meetingId)
    if (minutes === null) return { ok: false, error: '纪要还没有生成' }
    if (minutes.revision < meeting.segmentsRevision) {
      return { ok: false, error: '转写在纪要生成后被修订过，请重新生成纪要再确认' }
    }
    const confirmedAt = this.now()
    this.db.prepare("UPDATE minutes SET state = 'confirmed', confirmedAt = ? WHERE meetingId = ?").run(confirmedAt, meetingId)
    return { ok: true, confirmedAt }
  }

  // ===== 保留期 =====

  /**
   * 到期的会议：删除 chunk 文件与行（录音本体），state 置 expired。
   * 转写段、纪要、同意记录保留——它们是会议闭环的产出，不是录音。
   */
  enforceRetention(nowMs: number = this.now()): string[] {
    const rows = this.db
      .prepare("SELECT id FROM meetings WHERE endedAt IS NOT NULL AND state != 'expired' AND endedAt + retentionDays * ? <= ?")
      .all(DAY_MS, nowMs) as Row[]
    const expired: string[] = []
    for (const row of rows) {
      const id = String(row.id)
      const dir = this.meetingDir(id)
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        // 删不掉的目录（被占用等）下轮再删；行先不动，避免"行没了文件还在"。
        console.log('[meeting-store] 保留期清理失败，下轮重试：', id, error instanceof Error ? error.message : error)
        continue
      }
      this.db.prepare('DELETE FROM chunks WHERE meetingId = ?').run(id)
      this.db.prepare("UPDATE meetings SET state = 'expired' WHERE id = ?").run(id)
      expired.push(id)
    }
    return expired
  }

  /** 会议目录下现存的 chunk 文件数（测试与诊断用）。 */
  chunkFileCount(meetingId: string): number {
    const dir = this.meetingDir(meetingId)
    if (!existsSync(dir)) return 0
    return readdirSync(dir).filter(name => name.endsWith('.enc')).length
  }
}

function decryptChunk(key: Buffer, enc: Buffer): Buffer | null {
  if (enc.length < 12 + 16) return null
  const nonce = enc.subarray(0, 12)
  const tag = enc.subarray(enc.length - 16)
  const body = enc.subarray(12, enc.length - 16)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    return null
  }
}

/** 从既有 speaker id（s1、s2…）推出下一个没被占用的 id。 */
export function nextSpeakerId(segments: readonly TranscriptSegment[]): string {
  let max = 0
  for (const segment of segments) {
    const match = /^s(\d+)$/.exec(segment.speaker)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  return `s${max + 1}`
}
