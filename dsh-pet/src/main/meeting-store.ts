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
 *
 * ===== 库内敏感字段加密（M4-01） =====
 *
 * 会议名（meetings.name）、知情同意 JSON（meetings.consent）、转写段的 text/label、纪要
 * content 一律用**同一把数据密钥**做 AES-256-GCM 字段加密，落库形态 `enc:v1:` + base64
 * (nonce(12) | ciphertext | tag(16))。AAD = 表名 + 列名 + 行键（转写段/纪要还带 revision）：
 * 密文被挪到别的行、别的列、别的版本，GCM 校验直接失败，读出来标"不可解密"而不是错位内容。
 *
 * 纪要 digest：库里存 `hmac:v1:` + HMAC-SHA256（密钥由数据密钥经 HKDF 派生，消息带行键），
 * 不再存明文的 sha256——后者是可猜内容的确认神谕。读取时解密后重算 sha256(明文) 交给上层，
 * 所以"确认绑定 revision 与 digest"的语义、面板上显示的 digest 都与原来一致；HMAC 对不上
 * 同样按不可解密处理。
 *
 * 读不出来就如实说：解不开的字段返回 UNDECRYPTABLE_TEXT 占位并带 `undecryptable: true`，
 * 绝不当空串或正常内容。带不可解密标记的数据不能被写回（改名/合并/拆分、存纪要、确认纪要
 * 一律拒绝），否则占位文本会被加密成"正常内容"永久冒充原文。
 *
 * 旧库迁移（migrateLegacyPlaintext）：构造时发现无前缀的明文行就尝试迁移。单个 BEGIN
 * IMMEDIATE 事务内逐行加密，任何一步失败整体 ROLLBACK，原明文保持原样；进程中途被杀由
 * SQLite 的 WAL 原子性兜底。只挑没有前缀的列处理，重复跑是空操作（幂等）。密钥不可用时
 * 状态记为 blocked、明文原样保留、不创建也不覆盖密钥，之后 startMeeting 拿到密钥会重试。
 *
 * 残留：连接一打开就 PRAGMA secure_delete = ON（之后的 UPDATE/DELETE 释放的空间会被清零）；
 * 迁移成功后 VACUUM 重建库文件（清掉旧版本删除行留在空闲页里的明文），再
 * wal_checkpoint(TRUNCATE) 把 WAL 截成 0 字节。**这只能保证 SQLite 文件当前内容里没有
 * 明文**：文件系统层面已释放的块、SSD/闪存的磨损均衡副本、卷影复制、外部备份、以及
 * 迁移前被复制走的库文件，都可能还留着旧明文，软件层面无法保证彻底擦除。
 * 明文元数据（时间、来源、状态、speaker id、chunk 路径/sha）不在加密范围内；用户导出到
 * 库外的纪要文本也不在本层保护范围内。
 *
 * ===== 分轨与时间轴（M4-02） =====
 *
 * 麦克风（mic）与系统回环声（loopback）**各自成轨**：渲染层每路单独缓冲、单独送块，块带
 * 音源、轨内序号、起点（相对会议开始的毫秒）、原始采样率与 16k 帧数。块格式不变（同一把
 * 密钥的 chunk-<seq>.enc + sidecar），seq 仍是全会议的存储序号；track/trackSeq/startMs/
 * frames 同时写进 sidecar 与 chunks 表（表是真源，sidecar 丢了也能定位）。读取时按轨分开，
 * 绝不把两路交错拼成一条。旧版没有这些字段的块按"未标音轨、起点取接收时间"读出。
 *
 * transcript_meta 记机器最后一次整体写入转写的 revision（machineRevision）、分人模式与说明：
 * segmentsRevision 比它大 = 之后有人工修订，重转时据此避免覆盖用户的改名/合并/拆分。
 * 说明文字只含音轨、人数、时长、失败计数这类状态，不含会议内容，按明文元数据存。
 *
 * ===== 有来源的纪要与数据去向授权（M4-06） =====
 *
 * minutes 表加 kind（local 本地模板 / model 模型草稿，明文元数据）与 structured（结构化条目
 * JSON，含会议原话摘录，enc:v1 加密，AAD = minutes + structured + 会议 id + revision，与
 * content 同一行键）。meetings 表加 egress：把会议文字发给模型之前的授权事件列表（授予时展示
 * 的那段话、绑定的转写版本与发送内容摘要、拒绝/撤销时间），enc:v1 加密，AAD = meetings +
 * egress + 会议 id。都在同一个库里，不另建会议库。
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getDataKey, keyFilePath, type DpapiDeps, type DpapiResult } from './dpapi.ts'

/** 录音来源。loopback 是系统回环声（会议里别人说话的声音），拿不到时如实标缺失，不伪造。 */
export type MeetingSources = 'mic' | 'mic+loopback'

/** 一条音轨。mic = 本机麦克风，loopback = 系统回环声（线上会议对方的声音）。 */
export type MeetingTrack = 'mic' | 'loopback'

export function isMeetingTrack(value: unknown): value is MeetingTrack {
  return value === 'mic' || value === 'loopback'
}

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
  /** name 或 consent 解不开（密钥不可用/不对、密文被篡改或挪行）。此时它们是占位文本。 */
  readonly undecryptable?: true
}

/**
 * chunk 落盘旁的 sidecar：时间与断流间隔。sha256 是 .enc 文件内容的摘要。
 *
 * track 及之后的字段是分轨块（M4-02）才有的；旧块没有它们。分轨块的 gapAfterMs 是**同一
 * 音轨**下一块起点与这块终点之间的真实缺口；旧块沿用"相邻两块接收时间之差"的老语义。
 */
export interface ChunkSidecar {
  readonly seq: number
  readonly ts: number
  readonly sha256: string
  readonly gapAfterMs: number | null
  readonly track?: MeetingTrack
  /** 轨内单调递增序号（渲染层给）。 */
  readonly trackSeq?: number
  /** 块起点，相对会议开始的毫秒数。 */
  readonly startMs?: number
  /** 16kHz 帧数（= PCM 字节数 / 2）。 */
  readonly frames?: number
  /** 采集端的原始采样率（重采样到 16k 之前）。 */
  readonly sourceSampleRate?: number
}

/** 分轨块的时间轴信息（appendChunk 的可选参数）。 */
export interface ChunkTimeline {
  readonly track: MeetingTrack
  readonly trackSeq: number
  readonly startMs: number
  readonly sourceSampleRate: number
}

/** listChunks 的一行：表里的元数据 + sidecar。音轨/时间轴字段旧块为 null。 */
export interface ChunkEntry {
  readonly seq: number
  readonly path: string
  readonly sha256: string
  readonly sidecar: ChunkSidecar | null
  readonly track: MeetingTrack | null
  readonly trackSeq: number | null
  readonly startMs: number | null
  readonly frames: number | null
}

/** 解密后的一块。frames 由明文长度算出（不信 sidecar）；track/startMs 旧块为 null。 */
export interface StoredChunk {
  readonly seq: number
  readonly ts: number
  readonly gapAfterMs: number | null
  readonly pcm: Buffer
  readonly track: MeetingTrack | null
  readonly trackSeq: number | null
  readonly startMs: number | null
  readonly frames: number
}

/** 一条转写段。speaker 是稳定 id（合并/拆分改它），label 是给人看的名字（改名改它）。 */
export interface TranscriptSegment {
  readonly idx: number
  readonly speaker: string
  readonly label: string
  /** 说话人未经用户确认。机器产出（含自动分人）的段一律 true。 */
  readonly uncertain: boolean
  readonly startMs: number | null
  readonly endMs: number | null
  readonly text: string
  /** asr = 机器转写；assistant = 与助理播报高度重叠（不算真人发言）；failed = 转写失败的占位（可重试）。 */
  readonly source: string
  /** 段的音频来自哪条音轨。旧版段没有这个字段。合并/拆分只改 speaker，不改 track。 */
  readonly track?: MeetingTrack
  /** text 或 label 解不开。此时它们是占位文本，这一段不能被写回。 */
  readonly undecryptable?: true
}

/** 机器整体写入转写时的分人模式：全部分人 / 部分音轨分人 / 未自动分人。 */
export type TranscriptMode = 'diarized' | 'partial' | 'undiarized'

export interface TranscriptMeta {
  /** 机器最后一次整体写入时的段 revision。segmentsRevision 比它大 = 之后有人工修订。 */
  readonly machineRevision: number
  readonly mode: TranscriptMode
  /** 给人看的说明（分人情况、断流、失败计数），不含会议内容。 */
  readonly note: string | null
}

export interface ReplaceSegmentsOptions {
  /** 乐观锁：库里的段 revision 不等于它就拒绝（精修跑的这段时间里有人改过段）。 */
  readonly expectRevision?: number
  /**
   * 机器写入的元数据。advance=true 把 machineRevision 推到写入后的版本（这一版没有人工修订）；
   * false 只更新模式与说明，machineRevision 不动（保留"已有人工修订"这个事实）。
   */
  readonly machine?: { readonly mode: TranscriptMode; readonly note: string | null; readonly advance: boolean }
}

export interface MinutesRecord {
  readonly revision: number
  readonly content: string
  /** sha256(明文纪要) 的 hex；不可解密时为空串（算不出来，不伪造）。 */
  readonly digest: string
  readonly state: 'draft' | 'confirmed'
  readonly confirmedAt: number | null
  /** 生成方式：local = 本地模板（不经模型）；model = 模型草稿（经来源校验）。旧行为 local。 */
  readonly kind: MinutesKind
  /** 结构化条目（JSON 明文，解密后交出）；本地模板版为 null。 */
  readonly structured: string | null
  /** content 解不开或 HMAC 对不上。此时 content 是占位文本，不能确认、不能被覆盖。 */
  readonly undecryptable?: true
}

export type MinutesKind = 'local' | 'model'

/**
 * 数据去向授权的一条事件（M4-06）。granted 记下当时展示给用户的那段话（发什么、发给谁），
 * 以及授权绑定的转写版本与发送内容摘要；denied/revoked 只记时间。
 */
export interface EgressEvent {
  readonly type: 'granted' | 'denied' | 'revoked'
  readonly at: number
  readonly revision?: number
  readonly payloadDigest?: string
  readonly summary?: string
}

export interface EgressRecord {
  readonly events: readonly EgressEvent[]
  /** 当前生效的授权：最后一条事件是 granted 才算。 */
  readonly active: EgressEvent | null
  /** 授权记录解不开。此时按"没有授权"处理。 */
  readonly undecryptable?: true
}

/** 每场会议保留的授权事件条数上限（只留最近的）。 */
const EGRESS_EVENT_LIMIT = 50

/** 字段解不开时给出的占位文本。永远和 `undecryptable: true` 一起出现。 */
export const UNDECRYPTABLE_TEXT = '〔不可解密〕'

/** 加密字段前缀（带版本：将来换算法/格式时新旧并存可辨）。 */
export const FIELD_PREFIX = 'enc:v1:'
/** 纪要 digest 列的 HMAC 前缀。无前缀的 64 位 hex 是旧版明文 sha256。 */
export const DIGEST_PREFIX = 'hmac:v1:'

/**
 * 旧明文库的迁移状态。
 * - not-needed：库里没有明文行；
 * - migrated：本次迁移了 rows 行，checkpoint 为 busy 表示 WAL 没截断成功（有别的读者）；
 * - blocked：密钥不可用，明文原样保留，没动库也没动密钥；
 * - failed：迁移中途出错已整体回滚，明文原样保留，可重试。
 */
export type MigrationStatus =
  | { readonly state: 'not-needed' }
  | { readonly state: 'migrated'; readonly rows: number; readonly checkpoint: 'ok' | 'busy' | 'failed' }
  | { readonly state: 'blocked'; readonly error: string }
  | { readonly state: 'failed'; readonly error: string }

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
  /**
   * 分轨块的断流阈值：同一音轨下一块起点比这块终点晚出它就记 gapAfterMs（真实缺口）。
   * 默认 250ms——采集端按样本计数推时间轴，正常衔接的误差远小于它。
   */
  readonly trackGapThresholdMs?: number
  /**
   * 仅测试注入：迁移逐行处理前回调，抛异常即模拟"迁移进行到一半出错"。
   * 生产代码不传。
   */
  readonly beforeMigrateRow?: (table: string, rowKey: string) => void
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
CREATE TABLE IF NOT EXISTS transcript_meta (
  meetingId TEXT PRIMARY KEY,
  machineRevision INTEGER NOT NULL,
  mode TEXT NOT NULL,
  note TEXT
);
`

/** 旧库补列（M4-02）：分轨块的时间轴与段的音轨。都可为 NULL——旧行没有这些信息，如实留空。 */
const ADDED_COLUMNS: ReadonlyArray<readonly [table: string, column: string, decl: string]> = [
  ['chunks', 'track', 'TEXT'],
  ['chunks', 'trackSeq', 'INTEGER'],
  ['chunks', 'startMs', 'INTEGER'],
  ['chunks', 'frames', 'INTEGER'],
  ['transcript_segments', 'track', 'TEXT'],
  // M4-06：纪要的生成方式（local 本地模板 / model 模型草稿）与结构化条目（enc:v1 加密 JSON），
  // 以及按会议记录的数据去向授权（enc:v1 加密 JSON：授予/拒绝/撤销的事件列表）。
  ['minutes', 'kind', 'TEXT'],
  ['minutes', 'structured', 'TEXT'],
  ['meetings', 'egress', 'TEXT'],
]

const DAY_MS = 86_400_000

/** 16kHz：每毫秒 16 帧。 */
const FRAMES_PER_MS = 16

function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** AAD：表 + 列 + 行键。\0 分隔，任何一项不同都解不开。 */
function fieldAad(table: string, column: string, rowKey: string): Buffer {
  return Buffer.from(`dsh-meeting-field:v1\u0000${table}\u0000${column}\u0000${rowKey}`, 'utf8')
}

function segmentRowKey(meetingId: string, revision: number, idx: number): string {
  return `${meetingId}\u0000${revision}\u0000${idx}`
}

function minutesRowKey(meetingId: string, revision: number): string {
  return `${meetingId}\u0000${revision}`
}

function isSealed(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(FIELD_PREFIX)
}

/** 字段加密：`enc:v1:` + base64(nonce(12) | ciphertext | tag(16))。 */
export function encryptField(key: Buffer, plaintext: string, aad: Buffer): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return FIELD_PREFIX + Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64')
}

/** 字段解密。格式不对、密钥不对、AAD 不对（被挪行）、被篡改一律 null。 */
export function decryptField(key: Buffer, stored: string, aad: Buffer): string | null {
  if (!stored.startsWith(FIELD_PREFIX)) return null
  const raw = Buffer.from(stored.slice(FIELD_PREFIX.length), 'base64')
  if (raw.length < 12 + 16) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
    decipher.setAAD(aad)
    decipher.setAuthTag(raw.subarray(raw.length - 16))
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/** 纪要 digest 的 HMAC 子密钥：HKDF 从数据密钥派生，和加密用途分开。 */
function digestSubkey(key: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'dsh-meeting-minutes-digest:v1', 32))
}

function sealedDigest(subkey: Buffer, rowKey: string, content: string): string {
  return DIGEST_PREFIX + createHmac('sha256', subkey).update(`${rowKey}\u0000`, 'utf8').update(content, 'utf8').digest('hex')
}

type FieldRead = { readonly ok: true; readonly value: string } | { readonly ok: false }

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

/** 分轨块时间轴的边界校验。返回 null 表示通过。字节数必须是非空的完整 16bit 帧。 */
function invalidTimeline(timeline: ChunkTimeline, byteLength: number): string | null {
  if (!isMeetingTrack(timeline.track)) return '音轨只能是 mic 或 loopback'
  if (!Number.isInteger(timeline.trackSeq) || timeline.trackSeq < 0) return '音轨序号必须是非负整数'
  if (typeof timeline.startMs !== 'number' || !Number.isFinite(timeline.startMs) || timeline.startMs < 0) return '块起点必须是非负的毫秒数'
  if (!Number.isInteger(timeline.sourceSampleRate) || timeline.sourceSampleRate < 3000 || timeline.sourceSampleRate > 768000) {
    return '原始采样率不合理'
  }
  if (byteLength === 0 || byteLength % 2 !== 0) return '音频块不是完整的 16bit 帧'
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
  private readonly trackGapThresholdMs: number
  /** 解出来的数据密钥，进程内缓存：每 4 秒 spawn 一次 PowerShell 解包是不可接受的开销。 */
  private cachedKey: Buffer | null = null
  /** 纪要 digest 的 HMAC 子密钥（随 cachedKey 派生）。 */
  private cachedDigestKey: Buffer | null = null
  /**
   * 上次取密钥失败的用户话术。读路径复用它，不每读一行就 spawn 一次 PowerShell；
   * 写路径（开会、存段、存纪要、迁移）带 retry 重新取。
   */
  private keyFailure: string | null = null
  private migration: MigrationStatus = { state: 'not-needed' }

  constructor(userDataDir: string, deps: MeetingStoreDeps = {}) {
    this.userDataDir = userDataDir
    this.deps = deps
    this.gapThresholdMs = deps.gapThresholdMs ?? 8000
    this.trackGapThresholdMs = deps.trackGapThresholdMs ?? 250
    mkdirSync(userDataDir, { recursive: true })
    this.db = new DatabaseSync(path.join(userDataDir, 'meetings.sqlite'))
    this.db.exec('PRAGMA journal_mode = WAL')
    // 迁移与之后所有 UPDATE/DELETE 释放的页内空间、空闲页都清零，不留旧值（旧明文/旧密文）。
    this.db.exec('PRAGMA secure_delete = ON')
    this.db.exec(SCHEMA)
    this.addMissingColumns()
    // 旧版本留下的明文行：有才去取密钥迁移（新装/已迁移的库不碰密钥，不拖慢启动）。
    try {
      if (this.countLegacyPlaintext() > 0) this.migrateLegacyPlaintext()
    } catch (error) {
      this.migration = { state: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }

  close(): void {
    this.db.close()
  }

  /** 旧库补列：只加缺的列，已有的不动（幂等）。只改表结构，不碰任何行。 */
  private addMissingColumns(): void {
    for (const [table, column, decl] of ADDED_COLUMNS) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]
      if (!columns.some(entry => String(entry.name) === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
      }
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /**
   * 取数据密钥（带缓存）。失败时返回带用户话术的错误。
   *
   * 走默认 DPAPI 时额外守一道：key.bin 不在、库里却已有加密数据（chunk 或 enc:v1: 字段），
   * 判 lost，**不让 getDataKey 去生成新密钥**——新密钥解不开旧数据，还会让人以为一切正常。
   */
  private ensureKey(retry = false): { ok: true; key: Buffer } | { ok: false; error: string } {
    if (this.cachedKey !== null) return { ok: true, key: this.cachedKey }
    if (this.keyFailure !== null && !retry) return { ok: false, error: this.keyFailure }
    let error: string | null = null
    if (this.deps.keyProvider === undefined && !existsSync(keyFilePath(this.userDataDir)) && this.hasEncryptedData()) {
      error = keyErrorMessage({ status: 'lost', message: '密钥文件不见了，但库里已有加密的会议数据；不会新建密钥顶替' })
    } else {
      const provider = this.deps.keyProvider ?? ((): DpapiResult => getDataKey(this.userDataDir, this.deps.dpapi ?? {}))
      const result = provider()
      if (result.status !== 'ok') error = keyErrorMessage(result)
      else if (result.key.length !== 32) error = '会议密钥长度不对（应为 32 字节）'
      else {
        this.cachedKey = result.key
        this.keyFailure = null
        return { ok: true, key: result.key }
      }
    }
    this.keyFailure = error
    return { ok: false, error }
  }

  private hasEncryptedData(): boolean {
    const row = this.db
      .prepare('SELECT EXISTS(SELECT 1 FROM chunks) OR EXISTS(SELECT 1 FROM meetings WHERE substr(name, 1, ?) = ?) AS v')
      .get(FIELD_PREFIX.length, FIELD_PREFIX) as Row
    return Number(row.v) === 1
  }

  private digestKey(key: Buffer): Buffer {
    if (this.cachedDigestKey === null) this.cachedDigestKey = digestSubkey(key)
    return this.cachedDigestKey
  }

  /**
   * 读一个可能加密的字段。无前缀 = 旧版明文（迁移前/迁移被阻断），如实原样返回；
   * 有前缀但解不开（没密钥、密钥不对、被篡改、被挪行）返回 ok:false，由调用方标不可解密。
   */
  private readField(stored: unknown, table: string, column: string, rowKey: string): FieldRead {
    const value = String(stored)
    if (!isSealed(value)) return { ok: true, value }
    const key = this.ensureKey()
    if (!key.ok) return { ok: false }
    const plain = decryptField(key.key, value, fieldAad(table, column, rowKey))
    return plain === null ? { ok: false } : { ok: true, value: plain }
  }

  private seal(key: Buffer, plaintext: string, table: string, column: string, rowKey: string): string {
    return encryptField(key, plaintext, fieldAad(table, column, rowKey))
  }

  // ===== 旧明文库迁移 =====

  migrationStatus(): MigrationStatus {
    return this.migration
  }

  /** 还没加密的行数（任一敏感列无前缀即算）。 */
  private countLegacyPlaintext(): number {
    const p = FIELD_PREFIX
    const n = p.length
    const row = this.db
      .prepare(
        'SELECT ' +
          '(SELECT COUNT(*) FROM meetings WHERE substr(name, 1, ?) != ? OR substr(consent, 1, ?) != ?) + ' +
          '(SELECT COUNT(*) FROM transcript_segments WHERE substr(text, 1, ?) != ? OR substr(label, 1, ?) != ?) + ' +
          '(SELECT COUNT(*) FROM minutes WHERE substr(content, 1, ?) != ?) AS n',
      )
      .get(n, p, n, p, n, p, n, p, n, p) as Row
    return Number(row.n)
  }

  /**
   * 把旧版明文行加密回写。幂等（只处理无前缀的列）、全有或全无（单事务，失败回滚）。
   * 密钥不可用时不碰库、不碰密钥，状态记 blocked。
   */
  migrateLegacyPlaintext(): MigrationStatus {
    if (this.countLegacyPlaintext() === 0) {
      this.migration = { state: 'not-needed' }
      return this.migration
    }
    const key = this.ensureKey(true)
    if (!key.ok) {
      this.migration = { state: 'blocked', error: key.error }
      return this.migration
    }
    const p = FIELD_PREFIX
    const n = p.length
    const hook = this.deps.beforeMigrateRow
    let rows = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const meetings = this.db
        .prepare('SELECT id, name, consent FROM meetings WHERE substr(name, 1, ?) != ? OR substr(consent, 1, ?) != ?')
        .all(n, p, n, p) as Row[]
      const updateMeeting = this.db.prepare('UPDATE meetings SET name = ?, consent = ? WHERE id = ?')
      for (const row of meetings) {
        const id = String(row.id)
        hook?.('meetings', id)
        const name = isSealed(row.name) ? String(row.name) : this.seal(key.key, String(row.name), 'meetings', 'name', id)
        const consent = isSealed(row.consent) ? String(row.consent) : this.seal(key.key, String(row.consent), 'meetings', 'consent', id)
        updateMeeting.run(name, consent, id)
        rows++
      }

      const segments = this.db
        .prepare('SELECT meetingId, revision, idx, text, label FROM transcript_segments WHERE substr(text, 1, ?) != ? OR substr(label, 1, ?) != ?')
        .all(n, p, n, p) as Row[]
      const updateSegment = this.db.prepare('UPDATE transcript_segments SET text = ?, label = ? WHERE meetingId = ? AND idx = ?')
      for (const row of segments) {
        const meetingId = String(row.meetingId)
        const rowKey = segmentRowKey(meetingId, Number(row.revision), Number(row.idx))
        hook?.('transcript_segments', rowKey)
        const text = isSealed(row.text) ? String(row.text) : this.seal(key.key, String(row.text), 'transcript_segments', 'text', rowKey)
        const label = isSealed(row.label) ? String(row.label) : this.seal(key.key, String(row.label), 'transcript_segments', 'label', rowKey)
        updateSegment.run(text, label, meetingId, Number(row.idx))
        rows++
      }

      const minutes = this.db
        .prepare('SELECT meetingId, revision, content, digest, state, confirmedAt FROM minutes WHERE substr(content, 1, ?) != ?')
        .all(n, p) as Row[]
      const updateMinutes = this.db.prepare('UPDATE minutes SET content = ?, digest = ?, state = ?, confirmedAt = ? WHERE meetingId = ?')
      for (const row of minutes) {
        const meetingId = String(row.meetingId)
        const rowKey = minutesRowKey(meetingId, Number(row.revision))
        hook?.('minutes', rowKey)
        const content = String(row.content)
        // 旧 digest 与内容对不上：确认绑定已经不成立，不能借迁移把它"洗"成有效确认。
        const bound = String(row.digest) === sha256Hex(content)
        updateMinutes.run(
          this.seal(key.key, content, 'minutes', 'content', rowKey),
          sealedDigest(this.digestKey(key.key), rowKey, content),
          bound ? String(row.state) : 'draft',
          bound ? row.confirmedAt : null,
          meetingId,
        )
        rows++
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* 事务可能已被 SQLite 自行回滚 */ }
      this.migration = { state: 'failed', error: `迁移已回滚，明文原样保留：${error instanceof Error ? error.message : String(error)}` }
      return this.migration
    }
    this.migration = { state: 'migrated', rows, checkpoint: this.scrubResidue() }
    return this.migration
  }

  /**
   * 迁移后清残留：VACUUM 重建文件（旧版本删除行留在空闲页/页内空隙的明文一并消失），
   * 再 TRUNCATE checkpoint 把旧页写回主库并把 WAL 截为 0。只管 SQLite 文件当前内容，
   * 文件系统/闪存/备份里的历史副本管不到（见文件头注释）。
   */
  private scrubResidue(): 'ok' | 'busy' | 'failed' {
    try {
      this.db.exec('VACUUM')
      const row = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as Row | undefined
      return row !== undefined && Number(row.busy) !== 0 ? 'busy' : 'ok'
    } catch (error) {
      console.log('[meeting-store] 迁移后清理残留失败：', error instanceof Error ? error.message : error)
      return 'failed'
    }
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
    const key = this.ensureKey(true)
    if (!key.ok) return { ok: false, error: key.error }
    // 之前因为没密钥被挡住的旧库迁移，借这次拿到密钥补上。
    if (this.migration.state === 'blocked' || this.migration.state === 'failed') this.migrateLegacyPlaintext()
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
      .run(
        id,
        this.seal(key.key, normalized.name, 'meetings', 'name', id),
        this.now(),
        normalized.sources,
        this.seal(key.key, JSON.stringify(normalized), 'meetings', 'consent', id),
        normalized.retentionDays,
        'recording',
      )
    return { ok: true, meetingId: id }
  }

  getMeeting(meetingId: string): MeetingRow | null {
    const row = this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId) as Row | undefined
    if (row === undefined) return null
    return this.toMeetingRow(row)
  }

  private toMeetingRow(row: Row): MeetingRow {
    const id = String(row.id)
    const sources = String(row.sources) as MeetingSources
    const retentionDays = Number(row.retentionDays)
    const name = this.readField(row.name, 'meetings', 'name', id)
    const consentField = this.readField(row.consent, 'meetings', 'consent', id)
    let consent: MeetingConsentInput
    if (!consentField.ok) {
      consent = { name: UNDECRYPTABLE_TEXT, sources, consentText: UNDECRYPTABLE_TEXT, consented: true, retentionDays }
    } else {
      try {
        consent = JSON.parse(consentField.value) as MeetingConsentInput
      } catch {
        // consent 列是 NOT NULL 且只由 startMeeting 写入；真坏了给一份如实标坏的占位，读取路径不炸。
        consent = { name: name.ok ? name.value : UNDECRYPTABLE_TEXT, sources: 'mic', consentText: '(同意记录损坏)', consented: true, retentionDays }
      }
    }
    return {
      id,
      name: name.ok ? name.value : UNDECRYPTABLE_TEXT,
      startedAt: Number(row.startedAt),
      endedAt: row.endedAt === null ? null : Number(row.endedAt),
      sources,
      consent,
      retentionDays,
      state: String(row.state) as MeetingStateName,
      segmentsRevision: Number(row.segmentsRevision),
      ...(!name.ok || !consentField.ok ? { undecryptable: true as const } : {}),
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
   * gap 检测在这里做（gapAfterMs 语义是"这块之后断了多久"，写进**上一块**的 sidecar）：
   * - 分轨块（带 timeline）：只和**同一音轨**的上一块比，起点比上一块终点晚出
   *   trackGapThresholdMs 就记真实缺口；同轨序号重复直接拒（防重复写入）。
   * - 旧调用（不带 timeline）：沿用老语义，ts 与上一块的间隔超过阈值就记。
   */
  appendChunk(
    meetingId: string,
    pcm: Buffer | Uint8Array,
    ts: number,
    timeline?: ChunkTimeline,
  ): { ok: true; seq: number; gapAfterMs: number | null } | { ok: false; error: string } {
    const meeting = this.getMeeting(meetingId)
    if (meeting === null) return { ok: false, error: '没有这场会议' }
    if (meeting.state !== 'recording') return { ok: false, error: '这场会议不在录制中' }
    const key = this.ensureKey()
    if (!key.ok) return { ok: false, error: key.error }
    const plaintext = Buffer.from(pcm)
    const frames = Math.floor(plaintext.length / 2)
    if (timeline !== undefined) {
      const invalid = invalidTimeline(timeline, plaintext.length)
      if (invalid !== null) return { ok: false, error: invalid }
      const duplicate = this.db
        .prepare('SELECT 1 AS v FROM chunks WHERE meetingId = ? AND track = ? AND trackSeq = ?')
        .get(meetingId, timeline.track, timeline.trackSeq)
      if (duplicate !== undefined) return { ok: false, error: '这条音轨的这一块已经收过了' }
    }

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
    const startMs = timeline === undefined ? null : Math.round(timeline.startMs)
    const sidecar: ChunkSidecar = timeline === undefined
      ? { seq, ts, sha256: sha, gapAfterMs: null }
      : {
          seq,
          ts,
          sha256: sha,
          gapAfterMs: null,
          track: timeline.track,
          trackSeq: timeline.trackSeq,
          startMs: startMs ?? 0,
          frames,
          sourceSampleRate: timeline.sourceSampleRate,
        }
    // 先临时文件再改名：崩溃不会留下半个 chunk 冒充完整数据。
    writeFileSync(`${encPath}.tmp`, enc)
    renameSync(`${encPath}.tmp`, encPath)
    writeFileSync(`${sidecarPath}.tmp`, JSON.stringify(sidecar))
    renameSync(`${sidecarPath}.tmp`, sidecarPath)

    // gap 回填到上一块的 sidecar。
    let gapAfterMs: number | null = null
    if (timeline === undefined) {
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
    } else {
      const prev = this.db
        .prepare('SELECT seq, startMs, frames FROM chunks WHERE meetingId = ? AND track = ? ORDER BY seq DESC LIMIT 1')
        .get(meetingId, timeline.track) as Row | undefined
      if (prev !== undefined && prev.startMs !== null && prev.frames !== null) {
        const gap = Math.round((startMs ?? 0) - (Number(prev.startMs) + Number(prev.frames) / FRAMES_PER_MS))
        if (gap > this.trackGapThresholdMs) {
          gapAfterMs = gap
          const prevSidecar = this.readSidecar(meetingId, Number(prev.seq))
          if (prevSidecar !== null) {
            writeFileSync(path.join(dir, `chunk-${Number(prev.seq)}.json`), JSON.stringify({ ...prevSidecar, gapAfterMs: gap }))
          }
        }
      }
    }

    this.db
      .prepare('INSERT INTO chunks (meetingId, seq, path, sha256, track, trackSeq, startMs, frames) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(meetingId, seq, encPath, sha, timeline?.track ?? null, timeline?.trackSeq ?? null, startMs, timeline === undefined ? null : frames)
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

  /**
   * 列出全部块的元数据。音轨与时间轴字段以表为准，表里没有（旧行）再看 sidecar，
   * 都没有就是 null——旧版块没有分轨信息，如实留空。
   */
  listChunks(meetingId: string): ChunkEntry[] {
    const rows = this.db
      .prepare('SELECT seq, path, sha256, track, trackSeq, startMs, frames FROM chunks WHERE meetingId = ? ORDER BY seq')
      .all(meetingId) as Row[]
    return rows.map(row => {
      const seq = Number(row.seq)
      const sidecar = this.readSidecar(meetingId, seq)
      const track = isMeetingTrack(row.track) ? row.track : isMeetingTrack(sidecar?.track) ? sidecar.track : null
      const pick = (column: unknown, fromSidecar: unknown): number | null =>
        column !== null && column !== undefined ? Number(column) : typeof fromSidecar === 'number' && Number.isFinite(fromSidecar) ? fromSidecar : null
      return {
        seq,
        path: String(row.path),
        sha256: String(row.sha256),
        sidecar,
        track,
        trackSeq: pick(row.trackSeq, sidecar?.trackSeq),
        startMs: pick(row.startMs, sidecar?.startMs),
        frames: pick(row.frames, sidecar?.frames),
      }
    })
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

  /**
   * 按 seq 顺序读出全部明文 PCM（各块带音轨与时间轴信息，由调用方按轨分开）。
   * 坏块进 corrupted（seq 列表，老接口）与 corruptedChunks（带定位信息，便于在时间轴上
   * 标缺口），不中断读取。
   */
  readAllChunks(meetingId: string): {
    chunks: StoredChunk[]
    corrupted: number[]
    corruptedChunks: Array<Omit<StoredChunk, 'pcm' | 'frames' | 'gapAfterMs'> & { frames: number | null }>
  } {
    const chunks: StoredChunk[] = []
    const corrupted: number[] = []
    const corruptedChunks: Array<Omit<StoredChunk, 'pcm' | 'frames' | 'gapAfterMs'> & { frames: number | null }> = []
    for (const entry of this.listChunks(meetingId)) {
      const ts = entry.sidecar?.ts ?? 0
      const pcm = this.readChunk(meetingId, entry.seq)
      if (pcm === null) {
        corrupted.push(entry.seq)
        corruptedChunks.push({ seq: entry.seq, ts, track: entry.track, trackSeq: entry.trackSeq, startMs: entry.startMs, frames: entry.frames })
        continue
      }
      chunks.push({
        seq: entry.seq,
        ts,
        gapAfterMs: entry.sidecar?.gapAfterMs ?? null,
        pcm,
        track: entry.track,
        trackSeq: entry.trackSeq,
        startMs: entry.startMs,
        frames: Math.floor(pcm.length / 2),
      })
    }
    return { chunks, corrupted, corruptedChunks }
  }

  // ===== 转写段 =====

  getSegments(meetingId: string): TranscriptSegment[] {
    const rows = this.db
      .prepare('SELECT revision, idx, speaker, label, uncertain, startMs, endMs, text, source, track FROM transcript_segments WHERE meetingId = ? ORDER BY idx')
      .all(meetingId) as Row[]
    return rows.map(row => {
      const idx = Number(row.idx)
      const rowKey = segmentRowKey(meetingId, Number(row.revision), idx)
      const label = this.readField(row.label, 'transcript_segments', 'label', rowKey)
      const text = this.readField(row.text, 'transcript_segments', 'text', rowKey)
      return {
        idx,
        speaker: String(row.speaker),
        label: label.ok ? label.value : UNDECRYPTABLE_TEXT,
        uncertain: Number(row.uncertain) === 1,
        startMs: row.startMs === null ? null : Number(row.startMs),
        endMs: row.endMs === null ? null : Number(row.endMs),
        text: text.ok ? text.value : UNDECRYPTABLE_TEXT,
        source: String(row.source),
        ...(isMeetingTrack(row.track) ? { track: row.track } : {}),
        ...(!label.ok || !text.ok ? { undecryptable: true as const } : {}),
      }
    })
  }

  /**
   * 整表替换转写段并把 revision +1（表里只保留最新一版）。
   * 纪要 revision 落后于段 revision 时自动退回草稿：确认过的文本不能和库里的段脱节。
   * 带不可解密标记的段一律拒收：占位文本一旦加密写回，就会永久冒充原文。
   *
   * opts（会后精修用，不传时行为与旧版完全一致）：expectRevision 是乐观锁——跑精修的这段
   * 时间里有人改过段就拒绝（conflict），绝不拿机器结果盖掉人工修订；machine 在同一事务里
   * 记下机器写入的版本、分人模式与说明。
   */
  replaceSegments(
    meetingId: string,
    segments: readonly TranscriptSegment[],
    opts: ReplaceSegmentsOptions = {},
  ): { ok: true; revision: number } | { ok: false; error: string; conflict?: true } {
    const meeting = this.getMeeting(meetingId)
    if (meeting === null) return { ok: false, error: '没有这场会议' }
    if (segments.some(segment => segment.undecryptable === true)) {
      return { ok: false, error: '有转写段不可解密（密钥不可用或数据损坏），拒绝修订，以免占位文本覆盖原文' }
    }
    if (opts.expectRevision !== undefined && meeting.segmentsRevision !== opts.expectRevision) {
      return { ok: false, error: '转写在处理期间被修订过，没有覆盖', conflict: true }
    }
    const key = this.ensureKey(true)
    if (!key.ok) return { ok: false, error: key.error }
    const revision = meeting.segmentsRevision + 1
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM transcript_segments WHERE meetingId = ?').run(meetingId)
      const insert = this.db.prepare(
        'INSERT INTO transcript_segments (meetingId, revision, idx, speaker, label, uncertain, startMs, endMs, text, source, track) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      segments.forEach((segment, i) => {
        const rowKey = segmentRowKey(meetingId, revision, i)
        insert.run(
          meetingId,
          revision,
          i,
          segment.speaker,
          this.seal(key.key, segment.label, 'transcript_segments', 'label', rowKey),
          segment.uncertain ? 1 : 0,
          segment.startMs,
          segment.endMs,
          this.seal(key.key, segment.text, 'transcript_segments', 'text', rowKey),
          segment.source,
          isMeetingTrack(segment.track) ? segment.track : null,
        )
      })
      this.db.prepare('UPDATE meetings SET segmentsRevision = ? WHERE id = ?').run(revision, meetingId)
      this.db
        .prepare("UPDATE minutes SET state = 'draft', confirmedAt = NULL WHERE meetingId = ? AND revision < ?")
        .run(meetingId, revision)
      if (opts.machine !== undefined) {
        const { mode, note, advance } = opts.machine
        this.db
          .prepare(
            'INSERT INTO transcript_meta (meetingId, machineRevision, mode, note) VALUES (?, ?, ?, ?) ' +
              'ON CONFLICT(meetingId) DO UPDATE SET mode = excluded.mode, note = excluded.note' +
              (advance ? ', machineRevision = excluded.machineRevision' : ''),
          )
          .run(meetingId, advance ? revision : 0, mode, note)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true, revision }
  }

  /** 机器最后一次写入转写的版本、分人模式与说明。没跑过新版精修的会议返回 null。 */
  getTranscriptMeta(meetingId: string): TranscriptMeta | null {
    const row = this.db.prepare('SELECT machineRevision, mode, note FROM transcript_meta WHERE meetingId = ?').get(meetingId) as Row | undefined
    if (row === undefined) return null
    const mode = String(row.mode)
    return {
      machineRevision: Number(row.machineRevision),
      mode: mode === 'diarized' || mode === 'partial' ? mode : 'undiarized',
      note: row.note === null ? null : String(row.note),
    }
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

  /**
   * 合并：fromSpeaker 的段全部归到 intoSpeaker。bump revision。
   *
   * "是不是助理播报"跟着组走：并进助理播报组的段变成 assistant；助理播报组的段并进真人组，
   * 说明用户认定那是真人说的（时间区间判断会误伤播报期间开口的人），回到 asr。失败占位段不变。
   */
  mergeSpeakers(meetingId: string, fromSpeaker: string, intoSpeaker: string): { ok: true; revision: number } | { ok: false; error: string } {
    if (fromSpeaker === intoSpeaker) return { ok: false, error: '不能把说话人合并到自己' }
    const segments = this.getSegments(meetingId)
    const target = segments.find(segment => segment.speaker === intoSpeaker)
    if (target === undefined) return { ok: false, error: '合并目标不存在' }
    if (!segments.some(segment => segment.speaker === fromSpeaker)) return { ok: false, error: '被合并的说话人不存在' }
    const intoAssistant = segments.some(segment => segment.speaker === intoSpeaker && segment.source === 'assistant')
    return this.replaceSegments(
      meetingId,
      segments.map(segment =>
        segment.speaker === fromSpeaker
          ? { ...segment, speaker: intoSpeaker, label: target.label, source: regroupedSource(segment.source, intoAssistant) }
          : segment,
      ),
    )
  }

  /** 拆分：把选中的段（按 idx）挪给一个新说话人（用户起的名字 = 真人，助理播报段因此回到 asr）。bump revision。 */
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
          ? { ...segment, speaker, label: label.trim(), uncertain: false, source: regroupedSource(segment.source, false) }
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
    const row = this.db.prepare('SELECT revision, content, digest, state, confirmedAt, kind, structured FROM minutes WHERE meetingId = ?').get(meetingId) as
      | Row
      | undefined
    if (row === undefined) return null
    const revision = Number(row.revision)
    const state = String(row.state) as 'draft' | 'confirmed'
    const confirmedAt = row.confirmedAt === null ? null : Number(row.confirmedAt)
    const kind: MinutesKind = row.kind === 'model' ? 'model' : 'local'
    const rowKey = minutesRowKey(meetingId, revision)
    const unreadable: MinutesRecord = { revision, content: UNDECRYPTABLE_TEXT, digest: '', state, confirmedAt, kind, structured: null, undecryptable: true }
    const content = this.readField(row.content, 'minutes', 'content', rowKey)
    if (!content.ok) return unreadable
    let structured: string | null = null
    if (row.structured !== null && row.structured !== undefined) {
      // 结构化条目只以密文写入；读到明文（被人改过库）或解不开都按不可解密处理。
      if (!isSealed(row.structured)) return unreadable
      const field = this.readField(row.structured, 'minutes', 'structured', rowKey)
      if (!field.ok) return unreadable
      structured = field.value
    }
    const storedDigest = String(row.digest)
    if (storedDigest.startsWith(DIGEST_PREFIX)) {
      // 新格式：库里是 HMAC，校验通过才交出 sha256(明文)——与旧版对外的 digest 语义一致。
      const key = this.ensureKey()
      if (!key.ok) return unreadable
      const expected = Buffer.from(sealedDigest(this.digestKey(key.key), rowKey, content.value))
      const actual = Buffer.from(storedDigest)
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return unreadable
      return { revision, content: content.value, digest: sha256Hex(content.value), state, confirmedAt, kind, structured }
    }
    // 旧版明文行（迁移被阻断时）：digest 列本身就是 sha256(明文)，原样返回。
    return { revision, content: content.value, digest: storedDigest, state, confirmedAt, kind, structured }
  }

  /**
   * 存一版纪要草稿。同 revision、同生成方式、同内容且已确认的纪要原样保留：重复转写不该把
   * 用户点过的确认悄悄撤掉。内容一变（含改稿）就退回草稿——确认绑定的是 digest。
   *
   * extra（M4-06）：kind 生成方式（默认 local），structured 结构化条目 JSON（模型版才有，
   * 与 content 同一把密钥加密，AAD 带列名与行键）。
   *
   * 拒绝的情形（返回 ok:false，不动库）：密钥不可用；已有纪要不可解密（覆盖等于销毁可能
   * 还救得回的数据）；会议名/同意记录/转写段里有不可解密的——那样生成的纪要里是占位文本。
   */
  saveMinutes(
    meetingId: string,
    content: string,
    revision: number,
    extra: { readonly kind?: MinutesKind; readonly structured?: string | null } = {},
  ): { ok: true } | { ok: false; error: string } {
    const existing = this.getMinutes(meetingId)
    if (existing?.undecryptable === true) return { ok: false, error: '已有纪要不可解密，拒绝覆盖' }
    const meeting = this.getMeeting(meetingId)
    if (meeting?.undecryptable === true || this.getSegments(meetingId).some(segment => segment.undecryptable === true)) {
      return { ok: false, error: '会议信息或转写有不可解密的内容，不生成纪要' }
    }
    const kind: MinutesKind = extra.kind ?? 'local'
    const structured = extra.structured ?? null
    const digest = sha256Hex(content)
    if (
      existing !== null && existing.state === 'confirmed' && existing.revision === revision && existing.digest === digest
      && existing.kind === kind && existing.structured === structured
    ) return { ok: true }
    const key = this.ensureKey(true)
    if (!key.ok) return { ok: false, error: key.error }
    const rowKey = minutesRowKey(meetingId, revision)
    this.db
      .prepare(
        "INSERT INTO minutes (meetingId, revision, content, digest, state, confirmedAt, kind, structured) VALUES (?, ?, ?, ?, 'draft', NULL, ?, ?) " +
          'ON CONFLICT(meetingId) DO UPDATE SET revision = excluded.revision, content = excluded.content, digest = excluded.digest, ' +
          "state = 'draft', confirmedAt = NULL, kind = excluded.kind, structured = excluded.structured",
      )
      .run(
        meetingId,
        revision,
        this.seal(key.key, content, 'minutes', 'content', rowKey),
        sealedDigest(this.digestKey(key.key), rowKey, content),
        kind,
        structured === null ? null : this.seal(key.key, structured, 'minutes', 'structured', rowKey),
      )
    return { ok: true }
  }

  /**
   * 确认纪要。**只有 userClicked === true 才确认**：转写流水线自己不能把纪要变成
   * "已确认"，那需要用户亲手点一下（§2.11 不能伪造 UI 批准，同一原则）。
   * 段修订过（纪要 revision 落后）也拒绝：确认的必须是眼前这一版。
   *
   * digest（M4-06）：界面把它预览的那一版的 digest 带上来；库里的纪要已经变了（预览之后
   * 又被改稿/重生成）就拒绝——确认的必须是用户看到的那份文字，导出才能与预览一致。
   * 幂等：已确认且仍是当前版本时原样返回原来的确认时间（already: true），不再写库。
   */
  confirmMinutes(
    meetingId: string,
    opts: { userClicked: boolean; digest?: string },
  ): { ok: true; confirmedAt: number; already?: true } | { ok: false; error: string } {
    if (opts.userClicked !== true) return { ok: false, error: '纪要确认必须由用户亲手点击' }
    const meeting = this.getMeeting(meetingId)
    if (meeting === null) return { ok: false, error: '没有这场会议' }
    const minutes = this.getMinutes(meetingId)
    if (minutes === null) return { ok: false, error: '纪要还没有生成' }
    if (minutes.undecryptable === true) return { ok: false, error: '纪要不可解密（密钥不可用或数据损坏），不能确认' }
    if (minutes.revision < meeting.segmentsRevision) {
      return { ok: false, error: '转写在纪要生成后被修订过，请重新生成纪要再确认' }
    }
    if (opts.digest !== undefined && opts.digest !== minutes.digest) {
      return { ok: false, error: '纪要在你查看之后又变了，请重新核对后再确认' }
    }
    if (minutes.state === 'confirmed' && minutes.confirmedAt !== null) {
      return { ok: true, confirmedAt: minutes.confirmedAt, already: true }
    }
    const confirmedAt = this.now()
    this.db.prepare("UPDATE minutes SET state = 'confirmed', confirmedAt = ? WHERE meetingId = ?").run(confirmedAt, meetingId)
    return { ok: true, confirmedAt }
  }

  // ===== 数据去向授权（M4-06：把会议文字交给模型之前的明确同意，按会议记录，可撤销） =====

  /** 读一场会议的授权记录。没有记录 = 从未授权；解不开 = 按没有授权处理并标出来。 */
  getEgress(meetingId: string): EgressRecord {
    const row = this.db.prepare('SELECT egress FROM meetings WHERE id = ?').get(meetingId) as Row | undefined
    if (row === undefined || row.egress === null || row.egress === undefined) return { events: [], active: null }
    if (!isSealed(row.egress)) return { events: [], active: null, undecryptable: true }
    const field = this.readField(row.egress, 'meetings', 'egress', meetingId)
    if (!field.ok) return { events: [], active: null, undecryptable: true }
    try {
      const parsed = JSON.parse(field.value) as { events?: unknown }
      const events = Array.isArray(parsed.events) ? (parsed.events as EgressEvent[]).filter(isEgressEvent) : []
      const last = events[events.length - 1]
      return { events, active: last !== undefined && last.type === 'granted' ? last : null }
    } catch {
      return { events: [], active: null, undecryptable: true }
    }
  }

  /**
   * 追加一条授权事件。授予只能在记录可读时写（解不开的旧记录不被覆盖成"正常"历史）；
   * 撤销任何时候都写得进去——收紧数据去向的动作不能被坏记录挡住，旧记录解不开时
   * 以一条只含撤销的新记录替换。
   */
  recordEgress(meetingId: string, event: EgressEvent): { ok: true } | { ok: false; error: string } {
    if (this.getMeeting(meetingId) === null) return { ok: false, error: '没有这场会议' }
    const current = this.getEgress(meetingId)
    if (current.undecryptable === true && event.type !== 'revoked') {
      return { ok: false, error: '这场会议的授权记录不可解密，不记新的授权' }
    }
    const key = this.ensureKey(true)
    if (!key.ok) return { ok: false, error: key.error }
    const events = [...(current.undecryptable === true ? [] : current.events), event].slice(-EGRESS_EVENT_LIMIT)
    this.db
      .prepare('UPDATE meetings SET egress = ? WHERE id = ?')
      .run(this.seal(key.key, JSON.stringify({ events }), 'meetings', 'egress', meetingId), meetingId)
    return { ok: true }
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

/** 授权事件的形状校验：解密出来的 JSON 也不盲信。 */
function isEgressEvent(value: unknown): value is EgressEvent {
  if (value === null || typeof value !== 'object') return false
  const event = value as Partial<EgressEvent>
  return (event.type === 'granted' || event.type === 'denied' || event.type === 'revoked') && typeof event.at === 'number'
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

/**
 * 段换组后的来源：进了助理播报组就是 assistant，离开助理播报组（并进/拆成真人）就回到 asr。
 * 失败占位段始终是 failed——它的文字不是转写原文，不能因为换组被当成正文。
 */
function regroupedSource(source: string, intoAssistant: boolean): string {
  if (source === 'failed') return source
  if (intoAssistant) return 'assistant'
  return source === 'assistant' ? 'asr' : source
}

/**
 * 从既有 speaker id 推出下一个没被占用的 id。既认 s1、s2…，也认自动分人带音源前缀的
 * mic-s1、loop-s2…（取它们编号的最大值再 +1），拆出来的新人编号不会和任何一组撞号。
 */
export function nextSpeakerId(segments: readonly TranscriptSegment[]): string {
  let max = 0
  for (const segment of segments) {
    const match = /(?:^|-)s(\d+)$/.exec(segment.speaker)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  return `s${max + 1}`
}
