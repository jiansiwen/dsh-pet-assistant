/**
 * 记忆召回地基：派生投影（recall_proj）+ FTS5 索引（recall_fts）+ 查询期真源存活校验。
 *
 * 交付方案 §5.2 的三层分离在这里落地，刻意切干净：
 *
 * 1. **真源**：`memories` / `memory_sources` / `deletion_ledger`，本文件对它**只读、零触发器**。
 *    写入、确认、删除的全部语义仍然只在 memory.ts 里，召回层不可能绕过它们改事实。
 * 2. **派生投影** `recall_proj`：只用来把 memory_id 映射到一个 **稳定且永不复用** 的 doc_rowid，
 *    随时可以整表 DROP 再重建，不具权威性。
 * 3. **索引** `recall_fts`：FTS5 外部内容表，只负责产出候选 doc_rowid，**不产正文**。
 *    展示/注入用的文本一律回 `memories.body` 取，`fts_text`（bigram 切分串）禁止外泄。
 *
 * 四条实现纪律，都是为了"删掉的记忆不能被召回"这条合规红线：
 *
 * - **查询期强制回连真源**（不依赖对账是否跑过）。对账可能因为进程刚启动、异常退出、
 *   或对账本身被禁用而没跑；只要候选在 `memories` 里查不到对应行，就当场剔除并计数。
 *   这是删除一致性的地基，`reconcile()` 只是省一次浪费的回连，不是正确性前提。
 * - **对账只删孤儿 + 按签名增量重投**。`src_signature` 不含 status/revision，
 *   所以"确认/改判冲突"这类状态变化不会重投 posting（中文 bigram 的 posting 放大是 N−1 倍，
 *   为一次状态变更重建整条记忆的索引太贵）。签名变了才说明正文/主题/范围变了，才值得重投。
 * - **派生投影用物理 DELETE，不用软删除**。它没有任何历史价值（随时可重建），
 *   留着软删标记只会让 FTS 索引里继续存在可命中的 posting，等于给"删掉的记忆"留一条召回通路。
 * - **不 bump `user_version`**。store.ts:39-43 的规则是"库比程序新就拒绝启动"，
 *   bump 是单向破坏：用户回退插件版本后旧程序打不开库。索引代次改记
 *   `user_flags['recall:index_version']`，完整回滚只要 DROP 两表三触发器 + 清掉这个标记，
 *   `memories` 一行没动，旧插件照常启动。
 *
 * 降级原则：FTS 异常/超时一律**不抛异常**，返回 `degraded:true` + 空态注入串，
 * 让主链路继续跑单轮回答——检索是增强项，不是对话的前置条件。
 */
import { performance } from 'node:perf_hooks'
import type { DatabaseSync } from 'node:sqlite'
import {
  MemoryStore,
  effectiveStatus,
  isInjectable,
  kindLabel,
  memoryWeight,
  scopeLabel,
  type MemoryKind,
  type MemoryRecord,
  type Sensitivity,
} from './memory.ts'
import { inTransaction, sha256, tableExists, type Row } from './store.ts'

// ---------------------------------------------------------------------------
// 类型契约（K14 冻结，字段名不得改）
// ---------------------------------------------------------------------------

/**
 * 召回通道，5 值封闭。
 *
 * 本层只实现 `fts-index`（FTS5 候选）。其余 4 个留给后续规则/时间窗/项目/产物指针层，
 * 先占位是为了让 `trace.perChannel` 的形状和消费侧约定一次定死，避免以后改契约。
 */
export type Channel = 'fts-index' | 'rule' | 'time-window' | 'project' | 'artifact-pointer'

/** 命中条目的证据引用。字段对齐交付方案 §5.2 引用的 EvidenceRef，不在这里另造一套。 */
export interface RecallSourceRef {
  sourceId: string
  sourceRevision: number
  digest: string
  kind: 'user' | 'project' | 'task' | 'activity' | 'document' | 'knowledge' | 'business'
  locatorRef: string | null
  capturedAt: string
  sensitivity: 'normal' | 'sensitive'
}

/** 打分理由。消费侧只能断言 kind，不要解析 detail 的自由文本。 */
export interface RecallReason {
  kind: 'fts_term' | 'entity' | 'project_match' | 'recency' | 'target_lock' | 'memory_weight'
  detail?: string
}

export interface RecallHit {
  sourceKind: 'memory'
  sourceId: string
  sourceRef: RecallSourceRef
  /** 一律取自 `memories.body`；绝不是 `fts_text`/bigram 串。 */
  text: string
  channel: Channel
  reasons: RecallReason[]
  score: number
  scopeKind: string
  scopeId: string
  capturedAt: number
}

export type RecallEmptyReason =
  | 'no-match'
  | 'all-filtered'
  | 'match-limit-exceeded'
  | 'budget-exceeded'
  | 'degraded'
  | null

export interface RecallBundle {
  /** 剔除后的全量有效命中集；验收只采样它。 */
  matched: RecallHit[]
  /** = matched.slice(0, maxItems)，且受 maxChars 预算约束。 */
  injected: RecallHit[]
  /** 渲染文本。空态必须是非空字符串——宿主把"变量没有值"当装配错误直接炸。 */
  injection: string
  matchLimit: number
  /** = matched.length，与采样数组同源，避免数字/数组分裂。 */
  totalMatched: number
  /** = trace.rawMatchCount > matchLimit，由本层置位，消费侧不得自行推导。 */
  truncated: boolean
  /** 本轮执行存活校验的候选数（分母）。 */
  aliveChecks: number
  /** 因真源已删/墓碑/区间/保留期被剔除的数（分子）。 */
  deadHitsFiltered: number
  empty: boolean
  emptyReason: RecallEmptyReason
  trace: {
    matchExpr: string
    rawMatchCount: number
    perChannel: Record<Channel, number>
    budget: { maxItems: number; maxChars: number; applied: boolean }
    reconcileDelta: number
    degraded: boolean
  }
  filtered: {
    candidate: number
    conflicting: number
    expired: number
    outOfScope: number
    tombstoned: number
  }
  degraded: boolean
  degradeReason: string | null
  generatedAt: number
}

export interface RecallRequest {
  now: number
  /** 由调用方给的确定性词（不由模型生成）。 */
  queryTerms: string[]
  /** 授权上界；缺省 = 只 global。 */
  scopes?: Array<{ kind: string; id: string }>
  projectId?: string
  /** 注入上限（≤ 调用方的 maxInjectedMemories）。 */
  maxItems: number
  maxChars?: number
  /** 候选上界，默认 200；实现侧会抬到不小于 maxItems。 */
  matchLimit?: number
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** bigram 串的 token 上限。单条记忆正文再长，posting 也不许无限膨胀。 */
export const BIGRAM_TOKEN_LIMIT = 2000
/** 不含主题的正文 token 上限：主题只是分类，不该挤掉正文。 */
const BODY_TOKEN_LIMIT = 1600
const TOPIC_TOKEN_LIMIT = 400
export const DEFAULT_MATCH_LIMIT = 200
export const DEFAULT_MAX_CHARS = 4000
/** FTS 查询的时间预算：超了就按降级处理，不阻塞本轮对话。 */
const FTS_TIME_BUDGET_MS = 2000
/** memoryWeight 的上界：project_fact(400) + project 范围(50)。用于把权重归一成 20 分。 */
const MAX_MEMORY_WEIGHT = 450

/** 空态注入串。必须是非空字符串，且明确告诉模型"没有就是没有"。 */
export const RECALL_EMPTY_INJECTION =
  '（未找到相关记忆。本轮不注入任何长期记忆：不要凭印象补写用户偏好，也不要声称"记得"某件没有记录的事。）'

const INJECTION_HEADER = '以下是与本轮请求相关的长期记忆（只含用户已确认内容，按相关度排序）：'

// ---------------------------------------------------------------------------
// bigram 切分
// ---------------------------------------------------------------------------

const CJK_CHAR = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/
const WORD_CHAR = /[\p{L}\p{N}]/u

/**
 * 中文按相邻二元组切分，非中文整词保留。
 *
 * 为什么不是 trigram（交付方案 §5.2 已定案否决）：中文二字词是最高频词长，而判据里的
 * 查询词恰好全是二字词（项目/结论/会议/纪要/日报/待办）。trigram 对 2 字查询生成不了
 * 任何 3-gram，会把核心查询全打成「未找到」——那是把功能做成永远返回空。
 *
 * 为什么不引 jieba/ICU：那要新增跨平台二进制或词典，而且会让每次真源写入依赖扩展。
 * 应用层 bigram 的代价是 posting 放大 ≈N−1 倍，用 token 上限和 `src_signature`
 * 避免重投来控制体积。
 *
 * 处理顺序：NFKC（全角→半角，全角标点/`｜` 因此自然变成切分点）→ 小写 → 按 CJK/非 CJK
 * 切段 → CJK 段输出 L−1 个二元组（L=1 输出单字）→ 非 CJK 整词保留 → 空格连接 →
 * 保序去重 → 截断 2000 token。
 */
export function bigramSegment(text: string): string {
  const tokens: string[] = []
  let cjkRun = ''
  let wordRun = ''

  const flushCjk = (): void => {
    if (cjkRun.length === 0) return
    if (cjkRun.length === 1) {
      // 单字也必须留：否则"项"这种查询词在索引里彻底不存在。
      tokens.push(cjkRun)
    } else {
      for (let index = 0; index + 1 < cjkRun.length; index += 1) {
        tokens.push(cjkRun.slice(index, index + 2))
      }
    }
    cjkRun = ''
  }
  const flushWord = (): void => {
    if (wordRun.length === 0) return
    tokens.push(wordRun)
    wordRun = ''
  }

  for (const char of text.normalize('NFKC').toLowerCase()) {
    if (CJK_CHAR.test(char)) {
      flushWord()
      cjkRun += char
      continue
    }
    if (WORD_CHAR.test(char)) {
      flushCjk()
      wordRun += char
      continue
    }
    // 标点、空白、全角分隔符、emoji 一律当切分点：绝不让二元组跨标点拼出一个假词。
    flushCjk()
    flushWord()
  }
  flushCjk()
  flushWord()

  const seen = new Set<string>()
  const unique: string[] = []
  for (const token of tokens) {
    if (seen.has(token)) continue
    seen.add(token)
    unique.push(token)
    if (unique.length >= BIGRAM_TOKEN_LIMIT) break
  }
  return unique.join(' ')
}

/** 把已经切好的串再截到 n 个 token（主题/正文分开限流用）。 */
function limitTokens(segment: string, limit: number): string {
  if (segment === '') return ''
  const tokens = segment.split(' ')
  return tokens.length <= limit ? segment : tokens.slice(0, limit).join(' ')
}

/**
 * 投影文本 = 主题 bigram + 正文 bigram。
 *
 * 主题要进索引：用户问"日报有什么结论"时，命中的往往是主题字段。
 * 两段分开切再拼，是为了不让二元组跨过主题/正文边界拼出假词；
 * 也为了让主题不能挤占正文的 token 预算。
 */
function projectionText(topic: string, body: string): string {
  const topicPart = limitTokens(bigramSegment(topic), TOPIC_TOKEN_LIMIT)
  const bodyPart = limitTokens(bigramSegment(body), BODY_TOKEN_LIMIT)
  return `${topicPart} ${bodyPart}`.trim()
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

/**
 * 建投影表、FTS5 外部内容表与 3 个触发器，并写索引代次标记。
 *
 * 全部 `IF NOT EXISTS`，可重复调用；**不碰 `PRAGMA user_version`**（见文件头第 4 条）。
 * `user_flags` 的 DDL 与 store.ts 里那份同构：真实库上已经存在时这里是 no-op，
 * 而测试用的裸连接也能起来。之所以不在 store.ts 里抽一个函数出来：
 * 本批次纪律是"只新增文件、不改 store.ts"，重复 6 行 DDL 比改公共文件安全。
 *
 * 触发器**只挂 `recall_proj`**：`memories` 上零触发器。真源一旦挂触发器，
 * 写入路径就多了一处隐式副作用，回滚时还得先摘触发器，得不偿失。
 */
export function ensureRecallSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_flags (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS recall_proj (
      doc_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      scope_kind TEXT NOT NULL DEFAULT '',
      scope_id TEXT NOT NULL DEFAULT '',
      src_signature TEXT NOT NULL,
      fts_text TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_recall_proj_source ON recall_proj (source_kind, source_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(
      fts_text,
      content='recall_proj',
      content_rowid='doc_rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS recall_proj_ai AFTER INSERT ON recall_proj BEGIN
      INSERT INTO recall_fts (rowid, fts_text) VALUES (new.doc_rowid, new.fts_text);
    END;

    CREATE TRIGGER IF NOT EXISTS recall_proj_ad AFTER DELETE ON recall_proj BEGIN
      INSERT INTO recall_fts (recall_fts, rowid, fts_text) VALUES ('delete', old.doc_rowid, old.fts_text);
    END;

    CREATE TRIGGER IF NOT EXISTS recall_proj_au AFTER UPDATE ON recall_proj BEGIN
      INSERT INTO recall_fts (recall_fts, rowid, fts_text) VALUES ('delete', old.doc_rowid, old.fts_text);
      INSERT INTO recall_fts (rowid, fts_text) VALUES (new.doc_rowid, new.fts_text);
    END;

    INSERT INTO user_flags (key, value) VALUES ('recall:index_version', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `)
}

/**
 * 完整回滚：DROP 三触发器 + 两表，再清掉索引代次标记。
 *
 * 顺序有讲究：先摘触发器，再 DROP FTS 表，最后 DROP 投影表。反过来会在触发器体
 * 仍然引用 recall_fts 的时候先删表，虽然 SQLite 允许（触发器体是运行时解析），
 * 但留下一个短暂的不一致窗口，没有任何好处。
 */
export function dropRecallSchema(db: DatabaseSync): void {
  db.exec(`
    DROP TRIGGER IF EXISTS recall_proj_ai;
    DROP TRIGGER IF EXISTS recall_proj_ad;
    DROP TRIGGER IF EXISTS recall_proj_au;
    DROP TABLE IF EXISTS recall_fts;
    DROP TABLE IF EXISTS recall_proj;
  `)
  if (tableExists(db, 'user_flags')) {
    db.prepare(`DELETE FROM user_flags WHERE key = 'recall:index_version'`).run()
  }
}

// ---------------------------------------------------------------------------
// 对账
// ---------------------------------------------------------------------------

interface MemorySourceRow {
  memory_id: string
  kind: string
  scope_kind: string
  scope_id: string
  topic: string
  body: string
  updated_at: number
}

/**
 * 投影签名。**不含 status/revision**。
 *
 * 理由：确认、改判冲突、到期标 expired 都只改状态，不改"这条记忆说的是什么"。
 * 把它们纳入签名会让每次确认都重投一遍 posting；而中文 bigram 的 posting 是正文长度的
 * 近似 N−1 倍，重投代价远高于收益。反过来，正文/主题/类型/范围任一变化都必须重投，
 * 否则索引里会留着旧文本，召回出"这条记忆从没说过的话"——那比漏召回更糟。
 */
function sourceSignature(input: {
  sourceId: string
  body: string
  topic: string
  kind: string
  scopeKind: string
  scopeId: string
}): string {
  return sha256(
    [input.sourceId, input.body, input.topic, input.kind, input.scopeKind, input.scopeId].join('|'),
  )
}

/**
 * 对账：清孤儿 + 按签名增量 upsert。
 *
 * 孤儿用**物理 DELETE**（派生投影没有历史价值，软删只会让 posting 继续可命中）。
 * 孤儿特指"投影还在、真源行没了"——物理删投影会经 `recall_proj_ad` 触发器摘掉 posting，
 * 从索引层面消除召回通路。但**正确性不依赖它**：查询期还会再回连一次真源。
 *
 * 前置条件：调用方先 `ensureRecallSchema`。表不存在时返回 0/0 而不是替调用方建表——
 * 建表是显式动作，藏在"对账"里的 DDL 会让回滚后的库又悄悄长出表来。
 */
export function reconcileRecallIndex(db: DatabaseSync, now: number): { added: number; removed: number } {
  if (!tableExists(db, 'recall_proj') || !tableExists(db, 'memories')) return { added: 0, removed: 0 }
  return inTransaction(db, () => {
    const orphaned = db
      .prepare(
        `DELETE FROM recall_proj
          WHERE source_kind = 'memory'
            AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.memory_id = recall_proj.source_id)`,
      )
      .run()
    const removed = Number(orphaned.changes)

    const signatures = new Map<string, string>()
    for (const row of db
      .prepare(`SELECT source_id, src_signature FROM recall_proj WHERE source_kind = 'memory'`)
      .all() as Row[]) {
      signatures.set(String(row.source_id), String(row.src_signature))
    }

    const memories = db
      .prepare(
        `SELECT memory_id, kind, scope_kind, scope_id, topic, body, updated_at
           FROM memories ORDER BY memory_id`,
      )
      .all() as unknown as MemorySourceRow[]

    const insert = db.prepare(
      `INSERT INTO recall_proj
         (source_kind, source_id, kind, scope_kind, scope_id, src_signature, fts_text, captured_at, indexed_at)
       VALUES ('memory', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    // 只 UPDATE 内容列，不 DELETE+INSERT：doc_rowid 必须稳定，
    // 否则 fts 里同一来源会留下两个 rowid 的旧 posting。
    const update = db.prepare(
      `UPDATE recall_proj
          SET kind = ?, scope_kind = ?, scope_id = ?, src_signature = ?, fts_text = ?, captured_at = ?, indexed_at = ?
        WHERE source_kind = 'memory' AND source_id = ?`,
    )

    let added = 0
    for (const memory of memories) {
      const topic = String(memory.topic ?? '')
      const body = String(memory.body)
      const signature = sourceSignature({
        sourceId: memory.memory_id,
        body,
        topic,
        kind: memory.kind,
        scopeKind: memory.scope_kind,
        scopeId: memory.scope_id,
      })
      if (signatures.get(memory.memory_id) === signature) continue
      const ftsText = projectionText(topic, body)
      // captured_at 只作为投影自身的时间戳留档（给未来的 time-window 通道和排障用）。
      // 召回打分的时间近度一律读**真源**的 updated_at：确认/改判会改 updated_at 但不改签名，
      // 投影这一列会滞后，拿它打分等于用旧时间算新近度。
      const capturedAt = Number(memory.updated_at)
      if (signatures.has(memory.memory_id)) {
        update.run(
          memory.kind,
          memory.scope_kind,
          memory.scope_id,
          signature,
          ftsText,
          capturedAt,
          now,
          memory.memory_id,
        )
      } else {
        insert.run(
          memory.memory_id,
          memory.kind,
          memory.scope_kind,
          memory.scope_id,
          signature,
          ftsText,
          capturedAt,
          now,
        )
      }
      added += 1
    }
    return { added, removed }
  })
}

// ---------------------------------------------------------------------------
// 召回
// ---------------------------------------------------------------------------

/**
 * 真源读路径复用 MemoryStore：row→record 的映射、`effectiveStatus` 的过期折算、
 * `memory_sources` 的来源读取都只该有一份实现，在召回层重写一遍迟早和真源判定漂移
 * （漂移的后果是把候选当事实注入）。它的构造函数只跑 `CREATE TABLE IF NOT EXISTS`，
 * 幂等且不写数据，可以安全地在读路径复用；按连接缓存避免每次召回都重建语句。
 */
const liveStores = new WeakMap<DatabaseSync, MemoryStore>()

function liveStore(db: DatabaseSync): MemoryStore {
  const cached = liveStores.get(db)
  if (cached) return cached
  const created = new MemoryStore(db)
  liveStores.set(db, created)
  return created
}

/** 记忆类型 → 证据来源类型。语义对齐：偏好来自用户、事实来自项目、断点来自任务。 */
const SOURCE_KIND: Record<MemoryKind, RecallSourceRef['kind']> = {
  user_preference: 'user',
  project_fact: 'project',
  task_breakpoint: 'task',
  team_experience: 'activity',
  role_expression: 'user',
  ephemeral_chat: 'activity',
}

const FTS_RESERVED = new Set(['and', 'or', 'not', 'near'])

/**
 * 把查询词编译成 FTS5 的 MATCH 表达式。
 *
 * 两件事必须做对：
 * 1. 每个 token 都**包双引号**（内部引号加倍）。bigram token 里本来不会有引号，
 *    但用户的查询词可能带，裸拼进去就是一个语法错误，整轮召回变成空。
 * 2. 过滤 `AND/OR/NOT/NEAR` 与 `^`/`-`。这些是 FTS5 的操作符，裸出现在查询里
 *    会把"随便一个词命中"悄悄变成"必须全部命中"，命中集被无声缩小——这正是
 *    假阴性最难查的形态。
 *
 * 多词用 `OR`：召回要的是候选广度，宁可多给候选再靠打分排序，也不要为了精确度
 * 把"项目复盘"这种查询打成必须同时命中"项复"。NEAR 不使用：二元组本身已经蕴含邻接。
 */
function buildMatchExpression(queryTerms: readonly string[]): string {
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const term of queryTerms) {
    if (typeof term !== 'string') continue
    for (const token of bigramSegment(term).split(' ')) {
      if (token === '') continue
      if (FTS_RESERVED.has(token)) continue
      if (/[\^\-"]/.test(token)) continue
      if (seen.has(token)) continue
      seen.add(token)
      tokens.push(token)
    }
  }
  return tokens.map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}

function emptyChannels(): Record<Channel, number> {
  return { 'fts-index': 0, rule: 0, 'time-window': 0, project: 0, 'artifact-pointer': 0 }
}

interface SettledBudget {
  maxItems: number
  maxChars: number
  matchLimit: number
}

function zeroBundle(request: RecallRequest, budget: SettledBudget): RecallBundle {
  return {
    matched: [],
    injected: [],
    injection: RECALL_EMPTY_INJECTION,
    matchLimit: budget.matchLimit,
    totalMatched: 0,
    truncated: false,
    aliveChecks: 0,
    deadHitsFiltered: 0,
    empty: true,
    emptyReason: null,
    trace: {
      matchExpr: '',
      rawMatchCount: 0,
      perChannel: emptyChannels(),
      budget: { maxItems: budget.maxItems, maxChars: budget.maxChars, applied: false },
      // 查询期不跑对账：让对账去掩盖"投影与真源分歧"会让 E-14 永远测不到东西。
      // 这里恒为 0，调用方若刚跑过 reconcileRecallIndex 可以自行回填。
      reconcileDelta: 0,
      degraded: false,
    },
    filtered: { candidate: 0, conflicting: 0, expired: 0, outOfScope: 0, tombstoned: 0 },
    degraded: false,
    degradeReason: null,
    generatedAt: request.now,
  }
}

function degrade(bundle: RecallBundle, reason: string): RecallBundle {
  bundle.degraded = true
  bundle.degradeReason = reason
  bundle.trace.degraded = true
  bundle.matched = []
  bundle.injected = []
  bundle.injection = RECALL_EMPTY_INJECTION
  bundle.totalMatched = 0
  bundle.aliveChecks = 0
  bundle.deadHitsFiltered = 0
  bundle.trace.perChannel = emptyChannels()
  bundle.filtered = { candidate: 0, conflicting: 0, expired: 0, outOfScope: 0, tombstoned: 0 }
  bundle.empty = true
  bundle.emptyReason = 'degraded'
  return bundle
}

function normalizeScopes(
  scopes: RecallRequest['scopes'],
): Array<{ kind: string; id: string }> {
  const out: Array<{ kind: string; id: string }> = []
  const seen = new Set<string>()
  for (const scope of scopes ?? []) {
    const kind = String(scope?.kind ?? '').trim()
    if (kind === '') continue
    const id = kind === 'global' ? '' : String(scope?.id ?? '').trim()
    const key = `${kind}\u0000${id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind, id })
  }
  // 缺省只给 global：调用方没声明授权维度时，不能替它把项目/团队记忆都放进来。
  return out.length > 0 ? out : [{ kind: 'global', id: '' }]
}

/**
 * deletion_ledger 墓碑校验。
 *
 * dedup_key 的拼法与 memory.ts 里 `ledgerKey` 一致，但那边没导出；这里是"只读复用"，
 * 两边一旦漂移就查不到墓碑，所以格式必须与 memory.ts 保持字面一致，改那边必须同步改这里。
 */
function isTombstoned(db: DatabaseSync, record: MemoryRecord): boolean {
  if (!tableExists(db, 'deletion_ledger')) return false
  const key = [record.kind, record.scope.kind, record.scope.id, record.topic, sha256(record.text)].join('|')
  return db.prepare('SELECT 1 FROM deletion_ledger WHERE dedup_key = ?').get(key) !== undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 查询词是否在这条记忆里留下痕迹：任一 bigram token 出现在正文/主题中。 */
function termHit(term: string, haystack: string): boolean {
  const tokens = bigramSegment(term)
  if (tokens === '') return false
  return tokens.split(' ').some(token => haystack.includes(token))
}

interface ScoredCandidate {
  record: MemoryRecord
  rank: number
  terms: string[]
  entityHit: boolean
  ageDays: number
  weight: number
}

/**
 * 召回主入口。
 *
 * 失败一律降级、不抛异常：检索是增强项，抛出去会掐掉整轮对话。
 */
export function recallMemories(db: DatabaseSync, request: RecallRequest): RecallBundle {
  const maxItems = Math.max(0, Math.floor(request.maxItems))
  const maxChars = Math.max(0, Math.floor(request.maxChars ?? DEFAULT_MAX_CHARS))
  // 实现侧保证 matchLimit ≥ maxItems：否则"命中被截断"和"注入预算截断"会混成一个现象，
  // 消费侧就无法区分"库里真没有"和"取少了"（§8.2 的假阴性判据就是这么被绕过的）。
  const matchLimit = Math.max(maxItems, Math.floor(request.matchLimit ?? DEFAULT_MATCH_LIMIT), 1)

  const bundle = zeroBundle(request, { maxItems, maxChars, matchLimit })
  const scopes = normalizeScopes(request.scopes)
  const allowed = new Set(scopes.map(scope => `${scope.kind}\u0000${scope.id}`))
  const expr = buildMatchExpression(request.queryTerms)
  bundle.trace.matchExpr = expr
  if (expr === '') {
    bundle.emptyReason = 'no-match'
    return bundle
  }
  if (!tableExists(db, 'memories') || !tableExists(db, 'recall_proj') || !tableExists(db, 'recall_fts')) {
    return degrade(bundle, '召回索引尚未建立（recall_proj/recall_fts 缺失），本轮不注入记忆')
  }

  // --- 1. FTS 只产候选 -----------------------------------------------------
  let rawMatchCount = 0
  let candidates: Array<{ sourceId: string; rank: number }> = []
  const startedAt = performance.now()
  try {
    const counted = db.prepare('SELECT COUNT(*) AS n FROM recall_fts WHERE recall_fts MATCH ?').get(expr) as Row
    rawMatchCount = Number(counted?.n ?? 0)
    bundle.trace.rawMatchCount = rawMatchCount
    // bm25 越小越相关（负值）；JOIN 投影拿到 source_id，但**不取任何文本列**。
    const rows = db
      .prepare(
        `SELECT p.source_id AS source_id, bm25(recall_fts) AS rank
           FROM recall_fts
           JOIN recall_proj p ON p.doc_rowid = recall_fts.rowid
          WHERE recall_fts MATCH ?
          ORDER BY rank
          LIMIT ?`,
      )
      .all(expr, matchLimit) as Row[]
    candidates = rows.map(row => ({ sourceId: String(row.source_id), rank: Number(row.rank) }))
  } catch (error) {
    return degrade(bundle, `FTS 检索失败：${describe(error)}`)
  }
  if (performance.now() - startedAt > FTS_TIME_BUDGET_MS) {
    return degrade(bundle, `FTS 检索超时（>${FTS_TIME_BUDGET_MS}ms），本轮退化为静态注入`)
  }

  // --- 2. 逐条回连真源 + 复用真源的判定函数 ---------------------------------
  const store = liveStore(db)
  const survivors: ScoredCandidate[] = []
  const loweredTerms = request.queryTerms
    .filter((term): term is string => typeof term === 'string')
    .map(term => term.trim())
    .filter(term => term !== '')

  for (const candidate of candidates) {
    bundle.aliveChecks += 1
    const record = store.get(candidate.sourceId, request.now)
    // 查询期强制回连真源（删除一致性第一道闸门）：
    // 投影和 FTS 索引都可能是旧的——进程在 reconcile 之前被杀、上次对账被跳过、
    // 或者真源行被别的路径删掉。这一行不存在，就说明这条记忆已经不存在，
    // 无论索引里还有什么，都不能召回。
    if (!record) {
      bundle.deadHitsFiltered += 1
      bundle.filtered.tombstoned += 1
      continue
    }
    if (isTombstoned(db, record)) {
      bundle.filtered.tombstoned += 1
      continue
    }
    // 敏感级不进注入：加密存储还没落地，注进提示词就等于把明文发给模型。
    // 归入 outOfScope（"不许看"），而不是某个状态桶，避免语义含糊。
    if ((record.sensitivity as Sensitivity) === 'sensitive') {
      bundle.filtered.outOfScope += 1
      continue
    }
    if (!allowed.has(`${record.scope.kind}\u0000${record.scope.id}`)) {
      bundle.filtered.outOfScope += 1
      continue
    }
    const status = effectiveStatus(record, request.now)
    if (status === 'candidate') {
      bundle.filtered.candidate += 1
      continue
    }
    if (status === 'conflicting') {
      bundle.filtered.conflicting += 1
      continue
    }
    if (status === 'expired') {
      bundle.filtered.expired += 1
      continue
    }
    // 兜底：真源判定说不能注入就不注入（与 tools.ts 用的是同一个函数，口径不会分裂）。
    if (!isInjectable(record, request.now)) {
      bundle.filtered.conflicting += 1
      continue
    }
    const haystack = `${record.topic}\n${record.text}`.toLowerCase()
    survivors.push({
      record,
      rank: candidate.rank,
      terms: loweredTerms.filter(term => termHit(term, haystack)),
      entityHit: loweredTerms.some(term => term.length >= 2 && haystack.includes(term.toLowerCase())),
      ageDays: Math.max(0, request.now - record.updatedAt) / 86_400_000,
      weight: memoryWeight(record),
    })
  }

  // --- 3. 打分 -------------------------------------------------------------
  // bm25 归一化：把"越小越好"的原始分压到 [0,1]，避免一个量纲吃掉时间/项目分。
  const ranks = survivors.map(entry => entry.rank)
  const bestRank = ranks.length > 0 ? Math.min(...ranks) : 0
  const worstRank = ranks.length > 0 ? Math.max(...ranks) : 0
  const rankSpan = worstRank - bestRank

  const scored = survivors.map(entry => {
    const normalizedRank = rankSpan > 0 ? (worstRank - entry.rank) / rankSpan : 1
    const recency = 25 / (1 + entry.ageDays / 30)
    const projectScore =
      request.projectId !== undefined
      && entry.record.scope.kind === 'project'
      && entry.record.scope.id === request.projectId
        ? 50
        : 0
    const entityScore = entry.entityHit ? 20 : 0
    const weightScore = 20 * Math.min(1, entry.weight / MAX_MEMORY_WEIGHT)
    const score = normalizedRank * 40 + recency + projectScore + entityScore + weightScore

    const reasons: RecallReason[] = []
    for (const term of entry.terms) reasons.push({ kind: 'fts_term', detail: term })
    if (entry.entityHit) reasons.push({ kind: 'entity' })
    if (projectScore > 0) reasons.push({ kind: 'project_match', detail: entry.record.scope.id })
    if (entry.ageDays <= 30) reasons.push({ kind: 'recency' })
    reasons.push({ kind: 'memory_weight', detail: String(entry.weight) })

    const hit: RecallHit = {
      sourceKind: 'memory',
      sourceId: entry.record.id,
      sourceRef: {
        sourceId: entry.record.id,
        sourceRevision: entry.record.revision,
        digest: sha256(entry.record.text),
        kind: SOURCE_KIND[entry.record.kind] ?? 'user',
        // 记忆没有外部定位（不存在"第几页"），诚实给 null 而不是编一个路径。
        locatorRef: null,
        capturedAt: new Date(entry.record.updatedAt).toISOString(),
        sensitivity: entry.record.sensitivity,
      },
      // 正文只从真源取；fts_text 是切分串，用它展示会得到"文档 档中 中项"这种东西。
      text: entry.record.text,
      channel: 'fts-index',
      reasons,
      score: Math.round(score * 1000) / 1000,
      scopeKind: entry.record.scope.kind,
      scopeId: entry.record.scope.id,
      capturedAt: entry.record.updatedAt,
    }
    return { hit, record: entry.record }
  })

  scored.sort(
    (a, b) =>
      b.hit.score - a.hit.score
      || b.hit.capturedAt - a.hit.capturedAt
      || (a.hit.sourceId < b.hit.sourceId ? -1 : a.hit.sourceId > b.hit.sourceId ? 1 : 0),
  )

  bundle.matched = scored.map(entry => entry.hit)
  bundle.totalMatched = bundle.matched.length
  bundle.trace.perChannel['fts-index'] = bundle.matched.length
  bundle.truncated = rawMatchCount > matchLimit

  // --- 4. 注入预算（条数 + 字符） -------------------------------------------
  const context = { projectId: request.projectId ?? null }
  const lines: string[] = []
  const injected: RecallHit[] = []
  let usedChars = 0
  const lineBudget = maxChars - INJECTION_HEADER.length - 2
  for (const entry of scored) {
    if (injected.length >= maxItems) {
      bundle.trace.budget.applied = true
      break
    }
    const marks: string[] = []
    marks.push(kindLabel(entry.record.kind))
    if (entry.record.scope.kind !== 'global') {
      marks.push(scopeLabel(entry.record.scope, context))
    }
    const line = `- [${marks.join('｜')}] ${entry.record.text}`
    if (usedChars + line.length + 1 > lineBudget) {
      bundle.trace.budget.applied = true
      break
    }
    lines.push(line)
    injected.push(entry.hit)
    usedChars += line.length + 1
  }

  bundle.injected = injected
  // 空态必须给字符串：tools.ts 注释里那条真机教训——宿主把"变量没有值"当装配错误直接炸。
  bundle.injection =
    injected.length === 0 ? RECALL_EMPTY_INJECTION : `${INJECTION_HEADER}\n${lines.join('\n')}`
  bundle.empty = injected.length === 0
  if (!bundle.empty) {
    bundle.emptyReason = null
  } else if (bundle.matched.length === 0) {
    if (rawMatchCount === 0) bundle.emptyReason = 'no-match'
    // 有候选但全被剔除：如果候选本身还被我方的 matchLimit 截过，先报截断，
    // 不能拿"已剔除干净"当结论——那正是第二层假阴性。
    else if (bundle.truncated) bundle.emptyReason = 'match-limit-exceeded'
    else bundle.emptyReason = 'all-filtered'
  } else {
    bundle.emptyReason = 'budget-exceeded'
  }
  return bundle
}
