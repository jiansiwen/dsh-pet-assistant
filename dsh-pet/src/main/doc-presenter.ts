/**
 * 讲解展示位置：讲解计划、内容锚点与"只按实际播放回执推进"的纯状态机（M5-01 / M5-02）。
 *
 * 这个文件刻意不碰 electron、磁盘与网络，三方共用：
 * - 主进程控制器（`doc-view-window.ts`）用它决定视图该不该动、动到哪；
 * - 阅读视图渲染层（`doc-view-main.tsx`）用同一份文字层拼接规则核对高亮能不能落在真实文字上；
 * - 另一个视图目标（WPS 适配器）实现 `DocViewTarget` 即可套用同一套推进规则。
 *
 * 几条硬规矩，改任何一条都要想清楚是在拆哪层保护：
 * 1. **位置只由播放回执推进**。模型讲解生成得再快，没有 `started` 回执，页面一页都不翻；
 *    `finished` 只确认"这句播完了"，不预先跳到下一段。
 * 2. **暂停不滚动，继续不跳段**。继续只把视图带回最后一次被回执确认的位置，不往前猜。
 * 3. **用户手动翻页即脱离**。脱离后回执照常记录讲解位置，但视图一页都不自动翻，
 *    "回到讲解位置 / 从此处讲"由主进程决定。
 * 4. **锚点只精确到可验证的程度**。段内文字区间只在讲解句与该页真实文字层逐字唯一匹配时给出；
 *    对不上一律退回页级，并如实写明原因。不存在"逐字高亮"。
 */
import type { Outline } from './document.ts'

// ── 锚点 ────────────────────────────────────────────────────────────────

/** 锚点精度。`text` 表示 [textStart, textEnd) 已与该页文字层逐字核对过；`page` 只承诺落在这一页。 */
export type AnchorPrecision = 'page' | 'text'

/** 退回页级的原因。界面要把它说出来：用户需要知道"只定位到页"不是 bug，而是没有更细的可信依据。 */
export type AnchorFallback =
  | 'section'        // 讲解句是解释/补充，不是原文摘录，本来就只对应整段（=整页）
  | 'no-text-layer'  // 扫描件或空白页：没有文字层，未做 OCR
  | 'no-match'       // 讲解句在本页文字层里找不到逐字对应
  | 'ambiguous'      // 能找到但出现不止一次，无法确定是哪一处

export interface DocAnchor {
  /** 对应 outline 的段下标；PDF 一段就是一个物理页。 */
  readonly sectionIndex: number
  /** 从 1 开始的物理页。 */
  readonly page: number
  /** 页内第几个自然段（从 0 开始）。只有文字区间完整落在一个自然段里时才给。 */
  readonly paragraph?: number
  /** 页文字层（与提纲 `text` 同一字符串）里的起止偏移，左闭右开。 */
  readonly textStart?: number
  readonly textEnd?: number
  readonly precision: AnchorPrecision
  readonly fallback?: AnchorFallback
}

/** 页内自然段的字符区间。来自文字层里的空行（`\n\n`），由拼接规则按纵向间距产生。 */
export interface TextRange {
  readonly start: number
  readonly end: number
}

export function paragraphsOf(text: string): readonly TextRange[] {
  const ranges: TextRange[] = []
  const pattern = /\n\s*\n/g
  let start = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > start) ranges.push({ start, end: match.index })
    start = match.index + match[0].length
  }
  if (start < text.length) ranges.push({ start, end: text.length })
  return ranges
}

/** 段落匹配的最短长度（去空白后）。再短的片段在一页里撞车的概率太高，宁可退回页级。 */
export const MIN_ANCHOR_CHARS = 8

/** 讲解句开头的三段标签与引号；它们不是原文的一部分，比对前剥掉。 */
const LABEL = /^\s*【(原文|解释|补充)】\s*[:：]?\s*/u
const QUOTES = /^[\s"'“”‘’「」『』《》]+|[\s"'“”‘’「」『』《》。！？；…，、,.!?;:：]+$/gu

/** 去掉所有空白，并记录每个保留字符在原串里的位置，用于把匹配结果映射回原文偏移。 */
function squeeze(text: string): { readonly chars: string; readonly map: readonly number[] } {
  let chars = ''
  const map: number[] = []
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (/\s/u.test(char)) continue
    chars += char
    map.push(index)
  }
  return { chars, map }
}

// ── 讲解计划 ────────────────────────────────────────────────────────────

export interface PlanSection {
  readonly index: number
  readonly page: number
  /** 该页真实文字层（与 PDF 提纲同一字符串）。空串 = 这一页没有可提取文字。 */
  readonly text: string
  readonly paragraphs: readonly TextRange[]
  /** 页文字的轻量摘要，渲染层据此核对自己拼出的文字层与主进程解析结果是否一致。 */
  readonly textDigest: string | null
  /** 段级锚点：整页。讲解这一段而没有更细的依据时就停在这里。 */
  readonly anchor: DocAnchor
}

export interface DocPlan {
  readonly sessionId: string
  readonly fingerprint: string
  /** 物理页数；扫描件在主进程里拿不到页数（解析报 no-text），由渲染层回报后才知道。 */
  readonly pageCount: number | null
  /** 是否有文字层。false 时一切锚点都只到页，并在界面上标注"扫描件、未做 OCR"。 */
  readonly textLayer: boolean
  readonly sections: readonly PlanSection[]
  readonly startSection: number
}

export type PlanResult = { readonly kind: 'plan'; readonly plan: DocPlan } | { readonly kind: 'not-pdf'; readonly reason: string }

/**
 * 从提纲构造讲解计划，每段对齐到物理页。
 *
 * PDF 提纲一段对应一个物理页（`document.ts` 的 pdfOutline），对齐规则因此是可验证的：
 * 段必须带 `pageNumber`，且从 1 开始逐页连续。任何一条不满足都不建计划——
 * 错位一页的计划比没有计划更糟，用户会看到 A 页却听到 B 页。
 */
export function buildDocPlan(input: {
  readonly sessionId: string
  readonly fingerprint: string
  readonly outline: Outline | null
  readonly startSection?: number
}): PlanResult {
  const { outline } = input
  if (outline === null) {
    // 扫描件：没有文字层，也就没有可讲的段，只能看页。
    return {
      kind: 'plan',
      plan: { sessionId: input.sessionId, fingerprint: input.fingerprint, pageCount: null, textLayer: false, sections: [], startSection: 0 },
    }
  }
  const sections: PlanSection[] = []
  for (let index = 0; index < outline.sections.length; index++) {
    const section = outline.sections[index]
    if (section.pageNumber !== index + 1 || section.index !== index) {
      return { kind: 'not-pdf', reason: '提纲段落与物理页对不齐（不是 PDF 提纲或页码不连续），不建立阅读视图锚点' }
    }
    const empty = section.text === ''
    sections.push({
      index,
      page: section.pageNumber,
      text: section.text,
      paragraphs: paragraphsOf(section.text),
      textDigest: empty ? null : textDigest(section.text),
      anchor: { sectionIndex: index, page: section.pageNumber, precision: 'page', fallback: empty ? 'no-text-layer' : 'section' },
    })
  }
  if (sections.length === 0) return { kind: 'not-pdf', reason: '提纲为空' }
  const start = input.startSection ?? 0
  const startSection = Number.isInteger(start) && start >= 0 && start < sections.length ? start : 0
  return {
    kind: 'plan',
    plan: {
      sessionId: input.sessionId,
      fingerprint: input.fingerprint,
      pageCount: sections.length,
      textLayer: sections.some(section => section.text !== ''),
      sections,
      startSection,
    },
  }
}

/** 物理页对应哪一段。扫描件或越界返回 null："从此处讲"在没有可讲的段时不能被假装成功。 */
export function sectionForPage(plan: DocPlan, page: number): number | null {
  const section = plan.sections.find(item => item.page === page)
  return section === undefined || section.text === '' ? null : section.index
}

/**
 * 某一句讲解在页面上能精确到哪。
 *
 * 只认逐字（忽略空白）唯一匹配：讲解句去掉【原文】标签和引号后，必须在本页文字层里恰好出现一次，
 * 且不短于 MIN_ANCHOR_CHARS。解释性的句子本来就不在原文里，自然落回整页——这是诚实，不是退化。
 */
export function segmentAnchor(section: PlanSection, segmentText: string | undefined): DocAnchor {
  const base = section.anchor
  if (section.text === '') return { ...base, fallback: 'no-text-layer' }
  if (segmentText === undefined) return base
  const label = LABEL.exec(segmentText)
  if (label !== null && label[1] !== '原文') return { ...base, fallback: 'section' }
  const needle = squeeze(segmentText.replace(LABEL, '').replace(QUOTES, '')).chars
  if (needle.length < MIN_ANCHOR_CHARS) return { ...base, fallback: label === null || needle.length === 0 ? 'section' : 'no-match' }
  const hay = squeeze(section.text)
  const first = hay.chars.indexOf(needle)
  if (first < 0) return { ...base, fallback: label === null ? 'section' : 'no-match' }
  if (hay.chars.indexOf(needle, first + 1) >= 0) return { ...base, fallback: 'ambiguous' }
  const textStart = hay.map[first]
  const textEnd = hay.map[first + needle.length - 1] + 1
  const paragraph = section.paragraphs.findIndex(range => range.start <= textStart && textEnd <= range.end)
  return {
    sectionIndex: base.sectionIndex,
    page: base.page,
    ...(paragraph >= 0 ? { paragraph } : {}),
    textStart,
    textEnd,
    precision: 'text',
  }
}

// ── 文字层拼接（工作线程与渲染层共用，二者不得各写一份） ──────────────────

/** pdf.js TextItem 里本规则用得到的那几个字段。 */
export interface PdfTextRun {
  readonly str: string
  readonly transform: readonly number[]
  readonly width: number
  readonly height: number
  readonly hasEOL: boolean
}

/** 纵向下移超过行高的这么多倍算新自然段。启发式：只用来给区间标"第几段"，不影响区间本身的逐字核对。 */
export const PARAGRAPH_GAP = 1.9

/**
 * 逐项拼接 PDF 文字层。
 *
 * 解析线程（提纲正文）和阅读视图（高亮定位）必须拼出**同一个字符串**，否则区间偏移就对不上，
 * 高亮会落在别的字上——所以规则只有这一份。
 */
export class PdfTextJoiner {
  private previous: PdfTextRun | undefined
  private lineEnded = false

  /** 下一项要追加的分隔符与正文；空串项只记录换行并返回 null。 */
  piece(item: PdfTextRun): { readonly separator: string; readonly str: string } | null {
    if (item.str === '') {
      this.lineEnded ||= item.hasEOL
      return null
    }
    let separator = ''
    const previous = this.previous
    if (previous) {
      const lineHeight = Math.max(1, previous.height)
      const drop = previous.transform[5] - item.transform[5]
      const differentLine = Math.abs(drop) > Math.max(1, previous.height / 2)
      const gap = item.transform[4] - (previous.transform[4] + previous.width)
      separator = this.lineEnded || differentLine
        ? (drop > lineHeight * PARAGRAPH_GAP ? '\n\n' : '\n')
        : gap > Math.max(1, previous.height * 0.15) ? ' ' : ''
    }
    this.previous = item
    this.lineEnded = item.hasEOL
    return { separator, str: item.str }
  }
}

/** 整页拼接，并给出每一项在最终（已 trim）文字里的区间；不贡献文字的项为 null。 */
export function joinTextRuns(items: readonly PdfTextRun[]): { readonly text: string; readonly spans: readonly (TextRange | null)[] } {
  const joiner = new PdfTextJoiner()
  let raw = ''
  const rawSpans: (TextRange | null)[] = []
  for (const item of items) {
    const piece = joiner.piece(item)
    if (piece === null) { rawSpans.push(null); continue }
    raw += piece.separator
    rawSpans.push({ start: raw.length, end: raw.length + piece.str.length })
    raw += piece.str
  }
  const lead = raw.length - raw.trimStart().length
  const text = raw.trim()
  const spans = rawSpans.map(span => {
    if (span === null) return null
    const start = Math.max(0, span.start - lead)
    const end = Math.min(text.length, span.end - lead)
    return end > start ? { start, end } : null
  })
  return { text, spans }
}

/** FNV-1a 摘要。只用于"两边拼出的文字是否一致"的自检，不是安全指纹（文件指纹仍是 sha256）。 */
export function textDigest(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${text.length}:${hash.toString(16).padStart(8, '0')}`
}

// ── 播放回执 ────────────────────────────────────────────────────────────

/** 某一句真的开始播 / 播完 / 被掐断。来源只能是合成进程报回来的 started / finished / cancelled。 */
export interface PlaybackReceipt {
  readonly kind: 'started' | 'finished' | 'cancelled'
  readonly utteranceId: string
  readonly segment: number
}

/** 合成进程事件里的 id 是 `${utteranceId}#${segment}`（见 tts.ts 的 pump）。 */
export function parseTtsEventId(id: string): { readonly utteranceId: string; readonly segment: number } | null {
  const hash = id.lastIndexOf('#')
  if (hash <= 0) return null
  const segment = Number(id.slice(hash + 1))
  return Number.isInteger(segment) && segment >= 0 && /^\d+$/.test(id.slice(hash + 1))
    ? { utteranceId: id.slice(0, hash), segment }
    : null
}

export function receiptOfTtsEvent(event: unknown): PlaybackReceipt | null {
  if (event === null || typeof event !== 'object') return null
  for (const kind of ['started', 'finished', 'cancelled'] as const) {
    const body = (event as Record<string, unknown>)[kind]
    if (body !== null && typeof body === 'object' && typeof (body as { id?: unknown }).id === 'string') {
      const parsed = parseTtsEventId((body as { id: string }).id)
      return parsed === null ? null : { kind, ...parsed }
    }
  }
  return null
}

/**
 * 播放回执的旁路订阅：包住 Narrator 的传输工厂，事件先照原样交给 Narrator，再抄送给订阅者。
 *
 * 不改 tts.ts：Narrator 自己忽略 `started`，而阅读视图恰恰需要它。抄送失败（订阅者抛错）
 * 绝不能影响播放本身，所以每个订阅者单独 try。
 */
export function createPlaybackTap<E>() {
  const listeners = new Set<(receipt: PlaybackReceipt) => void>()
  return {
    wrap<T>(open: (deliver: (event: E) => void) => T): (deliver: (event: E) => void) => T {
      return (deliver) => open((event) => {
        deliver(event)
        const receipt = receiptOfTtsEvent(event)
        if (receipt === null) return
        for (const listener of [...listeners]) {
          try { listener(receipt) } catch { /* 视图出错不影响出声 */ }
        }
      })
    },
    subscribe(listener: (receipt: PlaybackReceipt) => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** 与 index.ts 的 docUtteranceId 同一格式：`doc:${sessionId}:${fingerprint}:${index}`。 */
export function docUtteranceId(sessionId: string, fingerprint: string, index: number): string {
  return `doc:${sessionId}:${fingerprint}:${index}`
}

function sectionOfUtterance(plan: DocPlan, utteranceId: string): number | null {
  const prefix = `doc:${plan.sessionId}:${plan.fingerprint}:`
  if (!utteranceId.startsWith(prefix)) return null
  const rest = utteranceId.slice(prefix.length)
  if (!/^\d+$/.test(rest)) return null
  const index = Number(rest)
  return index < plan.sections.length ? index : null
}

// ── 状态机 ──────────────────────────────────────────────────────────────

export type PresenterMode = 'idle' | 'following' | 'detached' | 'stopped'

export type StopReason =
  | 'user'          // 用户按了停止 / 结束讲解
  | 'completed'     // 讲完了
  | 'replaced'      // 换了一份文档或重新开讲
  | 'file-changed'  // 文件内容变了：旧锚点全部失效
  | 'unauthorized'  // 授权目录撤销或文件移出授权范围
  | 'view-closed'   // 用户关掉了阅读视图
  | 'error'         // 视图本身出错（渲染失败、页数对不上等）

export interface Position {
  readonly section: number
  readonly segment: number
}

export interface PresenterState {
  readonly plan: DocPlan | null
  readonly mode: PresenterMode
  readonly paused: boolean
  /** 最近一次被 `started` 回执确认的讲解位置。没有回执就是 null——哪怕模型已经讲完五段。 */
  readonly position: Position | null
  readonly positionStatus: 'playing' | 'finished' | 'cut' | null
  readonly anchor: DocAnchor | null
  /** 每段讲解切出来的句子（与 Narrator 的分句同源），只用于细化锚点，不触发任何翻页。 */
  readonly segments: ReadonlyMap<number, readonly string[]>
  /** 视图当前停在哪一页（主进程最后一次让它去的，或用户自己翻到的）。 */
  readonly viewPage: number | null
  readonly stopReason: StopReason | null
}

export const INITIAL_PRESENTER: PresenterState = {
  plan: null,
  mode: 'idle',
  paused: false,
  position: null,
  positionStatus: null,
  anchor: null,
  segments: new Map(),
  viewPage: null,
  stopReason: null,
}

export type PresenterEvent =
  | { readonly type: 'plan'; readonly plan: DocPlan }
  | { readonly type: 'explanation'; readonly section: number; readonly segments: readonly string[] }
  | { readonly type: 'receipt'; readonly receipt: PlaybackReceipt }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'user-page'; readonly page: number }
  | { readonly type: 'reattach' }
  | { readonly type: 'file-changed' }
  | { readonly type: 'unauthorized' }
  | { readonly type: 'view-closed' }
  /** 视图自己出错（渲染失败、页数与计划不一致）。与主进程叫停不同，需要回报主进程。 */
  | { readonly type: 'view-error' }
  | { readonly type: 'stop'; readonly reason: StopReason }

/** 给视图看的状态快照。视图只是投影，位置的真值在状态机里。 */
export interface PresenterStatus {
  readonly mode: PresenterMode
  readonly paused: boolean
  readonly viewPage: number | null
  /** 讲解位置（最近一次回执确认的锚点）。脱离时视图据此显示"讲解在第 N 页"。 */
  readonly narration: DocAnchor | null
  readonly playing: boolean
  readonly stopReason: StopReason | null
  readonly textLayer: boolean
}

export type ViewCommand =
  | { readonly type: 'goto'; readonly anchor: DocAnchor; readonly highlight: boolean }
  | { readonly type: 'status'; readonly status: PresenterStatus }

export type HostEvent =
  /** 用户手动翻页，视图已脱离讲解位置。需要主进程（经用户）在两个选项里定：回去，或从此处讲。 */
  | {
      readonly type: 'detached'
      readonly page: number
      readonly narration: DocAnchor | null
      readonly fromHereSection: number | null
      readonly options: readonly ['return', 'from-here']
    }
  /** 推进已停止。needsConfirm=true 表示主进程应先暂停讲解并征求用户意见，而不是静默继续。 */
  | { readonly type: 'stopped'; readonly reason: StopReason; readonly needsConfirm: boolean }

export interface PresenterTurn {
  readonly state: PresenterState
  readonly view: readonly ViewCommand[]
  readonly host: readonly HostEvent[]
  /** 被丢弃的事件及原因（测试与日志用）。 */
  readonly dropped?: 'inactive' | 'foreign' | 'stale' | 'duplicate' | 'out-of-order' | 'invalid'
}

export function presenterStatus(state: PresenterState): PresenterStatus {
  return {
    mode: state.mode,
    paused: state.paused,
    viewPage: state.viewPage,
    narration: state.anchor,
    playing: state.positionStatus === 'playing',
    stopReason: state.stopReason,
    textLayer: state.plan?.textLayer ?? false,
  }
}

function compare(a: Position, b: Position): number {
  return a.section === b.section ? a.segment - b.segment : a.section - b.section
}

function turn(state: PresenterState, view: ViewCommand[] = [], host: HostEvent[] = []): PresenterTurn {
  return { state, view: [...view, { type: 'status', status: presenterStatus(state) }], host }
}

function drop(state: PresenterState, dropped: NonNullable<PresenterTurn['dropped']>): PresenterTurn {
  return { state, view: [], host: [], dropped }
}

function stopped(state: PresenterState, reason: StopReason, notifyHost: boolean): PresenterTurn {
  if (state.mode === 'stopped') return drop(state, 'duplicate')
  const next: PresenterState = { ...state, mode: 'stopped', stopReason: reason, positionStatus: state.positionStatus === 'playing' ? 'cut' : state.positionStatus }
  // 只有视图或文件侧发起的停止才需要告诉主进程；主进程自己叫停的不用再回声一次。
  const host: HostEvent[] = notifyHost ? [{ type: 'stopped', reason, needsConfirm: reason === 'view-closed' }] : []
  return turn(next, [], host)
}

export function nextPresenter(state: PresenterState, event: PresenterEvent): PresenterTurn {
  switch (event.type) {
    case 'plan': {
      const plan = event.plan
      const start = plan.sections[plan.startSection]
      const next: PresenterState = {
        ...INITIAL_PRESENTER,
        plan,
        mode: 'following',
        segments: new Map(),
        viewPage: start?.page ?? 1,
      }
      // 开讲前把视图放到起点页，但不高亮：这是"从哪儿开始"，不是"正在讲"。
      return turn(next, start ? [{ type: 'goto', anchor: start.anchor, highlight: false }] : [])
    }

    case 'explanation': {
      if (state.plan === null || state.mode === 'stopped') return drop(state, 'inactive')
      if (!Number.isInteger(event.section) || event.section < 0 || event.section >= state.plan.sections.length) {
        return drop(state, 'invalid')
      }
      const segments = new Map(state.segments)
      segments.set(event.section, [...event.segments])
      // 生成完成本身不是播放事实：只记下句子，不翻页、不高亮，连状态都不用推。
      return { state: { ...state, segments }, view: [], host: [] }
    }

    case 'receipt':
      return onReceipt(state, event.receipt)

    case 'pause':
      if (state.mode === 'idle' || state.mode === 'stopped') return drop(state, 'inactive')
      if (state.paused) return drop(state, 'duplicate')
      return turn({ ...state, paused: true })

    case 'resume': {
      if (state.mode === 'idle' || state.mode === 'stopped') return drop(state, 'inactive')
      if (!state.paused) return drop(state, 'duplicate')
      const next: PresenterState = { ...state, paused: false }
      // 继续不跳段：只回到最后一次被回执确认的位置；下一段要等它真的开始播才翻过去。
      if (state.mode === 'following' && state.anchor !== null && state.viewPage !== state.anchor.page) {
        return turn({ ...next, viewPage: state.anchor.page }, [{ type: 'goto', anchor: state.anchor, highlight: state.positionStatus === 'playing' }])
      }
      return turn(next)
    }

    case 'user-page': {
      if (!Number.isInteger(event.page) || event.page < 1) return drop(state, 'invalid')
      const pageCount = state.plan?.pageCount ?? null
      if (pageCount !== null && event.page > pageCount) return drop(state, 'invalid')
      if (event.page === state.viewPage) return drop(state, 'duplicate')
      if (state.mode !== 'following') {
        // 已脱离 / 已停止 / 空闲时翻页只是自由浏览，不重复征求主进程意见。
        return turn({ ...state, viewPage: event.page })
      }
      const next: PresenterState = { ...state, mode: 'detached', viewPage: event.page }
      return turn(next, [], [{
        type: 'detached',
        page: event.page,
        narration: state.anchor,
        fromHereSection: state.plan === null ? null : sectionForPage(state.plan, event.page),
        options: ['return', 'from-here'],
      }])
    }

    case 'reattach': {
      if (state.mode !== 'detached' || state.plan === null) return drop(state, 'inactive')
      const anchor = state.anchor ?? state.plan.sections[state.plan.startSection]?.anchor ?? null
      const next: PresenterState = { ...state, mode: 'following', viewPage: anchor?.page ?? state.viewPage }
      // 暂停中回到讲解位置也只是"放回去"，不会因此开始推进。
      return turn(next, anchor ? [{ type: 'goto', anchor, highlight: state.positionStatus === 'playing' }] : [])
    }

    case 'file-changed':
      if (state.mode === 'idle') return drop(state, 'inactive')
      return stopped(state, 'file-changed', true)

    case 'unauthorized':
      if (state.mode === 'idle') return drop(state, 'inactive')
      return stopped(state, 'unauthorized', true)

    case 'view-closed':
      if (state.mode === 'idle') return drop(state, 'inactive')
      return stopped(state, 'view-closed', true)

    case 'view-error':
      if (state.mode === 'idle') return drop(state, 'inactive')
      return stopped(state, 'error', true)

    case 'stop':
      if (state.mode === 'idle') return drop(state, 'inactive')
      return stopped(state, event.reason, false)
  }
}

function onReceipt(state: PresenterState, receipt: PlaybackReceipt): PresenterTurn {
  const plan = state.plan
  if (plan === null || state.mode === 'idle' || state.mode === 'stopped') return drop(state, 'inactive')
  const section = sectionOfUtterance(plan, receipt.utteranceId)
  // 别的会话、改版前的指纹、开场白、闲聊回答：一律不是这份计划的播放事实。
  if (section === null) return drop(state, 'foreign')
  if (!Number.isInteger(receipt.segment) || receipt.segment < 0) return drop(state, 'invalid')
  const at: Position = { section, segment: receipt.segment }
  const order = state.position === null ? 1 : compare(at, state.position)

  if (receipt.kind === 'started') {
    if (order < 0) return drop(state, 'stale')
    // 同一句只有在被掐断后重播（续讲 resumeFrom）时才允许再次开始；其他重复一律幂等丢弃。
    if (order === 0 && state.positionStatus !== 'cut') return drop(state, 'duplicate')
    const anchor = segmentAnchor(plan.sections[section], state.segments.get(section)?.[receipt.segment])
    const next: PresenterState = { ...state, position: at, positionStatus: 'playing', anchor }
    if (state.mode === 'following' && !state.paused) {
      return turn({ ...next, viewPage: anchor.page }, [{ type: 'goto', anchor, highlight: true }])
    }
    // 暂停（回执与暂停赛跑）或已脱离：记下讲解位置，但视图一页都不动。
    return turn(next)
  }

  // finished / cancelled 只结算当前正在播的那一句，不预示下一句、更不翻页。
  if (order !== 0) return drop(state, order < 0 ? 'stale' : 'out-of-order')
  if (state.positionStatus !== 'playing') return drop(state, 'duplicate')
  return turn({ ...state, positionStatus: receipt.kind === 'finished' ? 'finished' : 'cut' })
}

// ── 措辞 ────────────────────────────────────────────────────────────────

const FALLBACK_TEXT: Record<AnchorFallback, string> = {
  section: '页级（讲解句不是原文摘录）',
  'no-text-layer': '页级（本页无文字层，未做 OCR）',
  'no-match': '页级（原文摘录与本页文字层对不上）',
  ambiguous: '页级（摘录在本页出现多次，无法确定位置）',
}

/** 锚点的一句话说明。绝不出现"逐字"：文字区间是片段级核对，高亮按文字层片段画。 */
export function describeAnchor(anchor: DocAnchor | null): string {
  if (anchor === null) return '尚未开始播放'
  const head = `第 ${anchor.page} 页（物理页）`
  if (anchor.precision === 'page') return `${head} · ${FALLBACK_TEXT[anchor.fallback ?? 'section']}`
  const paragraph = anchor.paragraph === undefined ? '' : ` · 第 ${anchor.paragraph + 1} 自然段`
  return `${head}${paragraph} · 文字区间 ${anchor.textStart}–${anchor.textEnd}（片段级，非逐字）`
}

const STOP_TEXT: Record<StopReason, string> = {
  user: '讲解已停止',
  completed: '讲解已结束',
  replaced: '已切换到其他讲解',
  'file-changed': '文件内容已变化，讲解位置已失效，已停止推进',
  unauthorized: '授权已撤销或文件不在授权目录内，已停止推进',
  'view-closed': '阅读视图已关闭，讲解推进已停止',
  error: '阅读视图出错，已停止推进',
}

export function describeStatus(status: PresenterStatus): string {
  if (status.mode === 'stopped') return STOP_TEXT[status.stopReason ?? 'user']
  if (status.mode === 'idle') return '未在讲解'
  // 没有文字层就没有可讲的段：别说"等待播放"，那是在暗示它会开讲。
  if (!status.textLayer && status.mode === 'following') return '仅供按页查看：无文字层，不能逐段讲解'
  const scanned = status.textLayer ? '' : '（扫描件/无文字层：仅按页定位，未做 OCR）'
  if (status.mode === 'detached') {
    const where = status.narration === null ? '尚未开始' : `第 ${status.narration.page} 页`
    return `已脱离讲解位置（讲解在${where}），页面不再自动跟随${scanned}`
  }
  if (status.paused) return `讲解已暂停，页面停在原处${scanned}`
  return `${status.playing ? '正在讲解' : '等待播放'}，页面随实际播放推进${scanned}`
}

// ── 视图目标接口（阅读视图窗口与 WPS 适配器共用） ──────────────────────────

/** 视图无法展示这份文档的原因。全部有明确措辞，不留"加载失败"这种让人猜的说法。 */
export type DocViewProblemCode =
  | 'not-pdf' | 'denied' | 'missing' | 'changed' | 'too-big' | 'unreadable'
  | 'password' | 'invalid' | 'page-limit' | 'char-limit' | 'byte-limit' | 'timeout' | 'cancelled' | 'worker-failed'
  | 'invalid-token' | 'fingerprint-mismatch' | 'view-failed'

export interface DocViewProblem {
  readonly code: DocViewProblemCode
  readonly message: string
}

/** 交给视图目标展示的一份文档。plan 为 null 时 problem 必然非 null。 */
export interface DocViewTargetSession {
  readonly realPath: string
  readonly name: string
  readonly fingerprint: string
  readonly plan: DocPlan | null
  readonly problem: DocViewProblem | null
}

/** 视图目标回报的用户动作与取数事实。 */
export type DocViewUserAction =
  | { readonly kind: 'page'; readonly page: number }
  | { readonly kind: 'return' }
  | { readonly kind: 'from-here'; readonly page: number }
  | { readonly kind: 'closed' }
  /** 视图取数时主进程发现文件已变化或授权已撤销。 */
  | { readonly kind: 'denied'; readonly reason: 'changed' | 'unauthorized' }
  | { readonly kind: 'error'; readonly message: string }

/**
 * 视图目标：讲解位置投射到"某个能显示文档的地方"。
 *
 * PDF 阅读视图窗口是一个实现；WPS 适配器实现同一接口即可复用状态机与控制器。
 * 目标只负责"按指令显示"与"如实回报用户动作"，不自己决定翻页——决定权在状态机。
 */
export interface DocViewTarget {
  readonly kind: string
  /** 展示一份文档（或展示它为什么不能展示）。替换之前的会话：旧会话的数据访问必须立即失效。 */
  show(session: DocViewTargetSession): void | Promise<void>
  /** 定位到锚点。highlight=false 只是放到这一页，不表示"正在讲"。 */
  goto(anchor: DocAnchor, options: { readonly highlight: boolean }): void
  /** 推进状态投影（暂停、脱离、停止原因）。 */
  status(status: PresenterStatus): void
  /** 视图实际显示的物理页；尚未显示任何页时为 null。 */
  currentPage(): number | null
  /** 令当前会话的数据访问失效（文件变化、授权撤销）。视图可以保留状态说明，但不得再取到字节。 */
  invalidate(reason: 'changed' | 'unauthorized'): void
  onUserAction(listener: (action: DocViewUserAction) => void): () => void
  /** 关闭视图，之后仍可再次 show。 */
  close(): void
  /** 释放全部资源，之后不可再用。 */
  dispose(): void
}

// ── 阅读视图 IPC 载荷（主进程与渲染层共用的类型） ──────────────────────────

/** 渲染层拿到的会话描述。令牌由主进程签发，绑定 realPath + fingerprint；渲染层永远拿不到路径。 */
export interface DocViewDescriptor {
  readonly token: string | null
  readonly name: string
  readonly fingerprint: string
  readonly textLayer: boolean
  readonly pageCount: number | null
  readonly startPage: number
  readonly problem: DocViewProblem | null
  readonly lastGoto: { readonly anchor: DocAnchor; readonly highlight: boolean } | null
  readonly lastStatus: PresenterStatus | null
}

export type DocViewGrant =
  | {
      readonly ok: true
      readonly page: number
      readonly pageCount: number | null
      /** 该页文字层摘要；null = 无文字层（扫描件/空白页），只能页级定位。 */
      readonly textDigest: string | null
      readonly paragraphs: readonly TextRange[]
    }
  | { readonly ok: false; readonly problem: DocViewProblem }

export type DocViewBytes =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly problem: DocViewProblem }

/** 渲染层回报：用户动作，以及"实际渲染了哪一页"的事实。 */
export type DocViewReport =
  | { readonly kind: 'page'; readonly page: number }
  | { readonly kind: 'return' }
  | { readonly kind: 'from-here'; readonly page: number }
  | { readonly kind: 'rendered'; readonly page: number; readonly numPages: number; readonly textMatch: boolean | null }
  | { readonly kind: 'error'; readonly message: string }
