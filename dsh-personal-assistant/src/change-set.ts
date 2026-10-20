/**
 * 改动提案的纯逻辑与文件原子提交（M2-06）。
 *
 * 这里只做三件事，全部不碰账本：
 * - 读：严格按 UTF-8 解码、算内容哈希（基线版本），二进制与非 UTF-8 文本直接拒绝；
 * - 算：把模型给的统一 diff 严格套到基线上（不做模糊匹配），再由我们自己重算一份审阅用差异；
 *   审批卡上的差异、增删行数都来自这一份，不采纳模型自报的统计；
 * - 写：先核对每个文件的基线版本，再写同目录临时文件、fsync，提交前再核一次，最后逐个改名覆盖；
 *   中途失败就把已改名的文件恢复成基线。任何一步发现外部修改都不写目标文件（冲突暂停）。
 *
 * 账本、批准与任务状态由 help-task.ts 负责。
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeSync,
} from 'node:fs'
import path from 'node:path'
import { ABSENT_VERSION } from './gate.ts'

export { ABSENT_VERSION }

/** 单个文件读写的上限：超过就不进改动提案（审阅不了，也不该由助理整文件改写）。 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024
/** 一版改动最多涉及的文件数：文件清单在审批卡上必须完整显示，不能截断。 */
export const MAX_CHANGE_FILES = 20

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 严格 UTF-8 解码；含 NUL 或非法字节时返回 null（按二进制处理，不支持）。保留 BOM，写回时原样还原。 */
export function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null ? String((error as { code?: unknown }).code ?? 'ERROR') : 'ERROR'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 一个文件此刻的状态：版本（哈希 / absent / 其他非哈希标记）、原始字节与权限位。 */
export interface FileSnapshot {
  readonly version: string
  readonly bytes: Buffer | null
  readonly mode: number | null
}

/**
 * 读一个（已规范化成真实路径的）文件。符号链接、目录、过大的文件都给出非哈希版本，
 * 与任何基线哈希都不相等 —— 调用方据此判冲突，而不是跟着链接去读别处。
 */
export function readSnapshot(target: string): FileSnapshot {
  let stat
  try {
    stat = lstatSync(target)
  } catch (error) {
    const code = errorCode(error)
    return { version: code === 'ENOENT' || code === 'ENOTDIR' ? ABSENT_VERSION : `unreadable:${code}`, bytes: null, mode: null }
  }
  if (stat.isSymbolicLink()) return { version: 'symlink', bytes: null, mode: null }
  if (!stat.isFile()) return { version: 'not-a-file', bytes: null, mode: null }
  if (stat.size > MAX_FILE_BYTES) return { version: `too-large:${stat.size}`, bytes: null, mode: null }
  try {
    const bytes = readFileSync(target)
    return { version: sha256Hex(bytes), bytes, mode: stat.mode & 0o7777 }
  } catch (error) {
    return { version: `unreadable:${errorCode(error)}`, bytes: null, mode: null }
  }
}

/** 一行：正文与它自己的换行符（最后一行可能没有）。 */
export interface Line {
  readonly body: string
  readonly eol: '' | '\n' | '\r\n'
}

export function splitLines(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue
    const crlf = index > start && text.charCodeAt(index - 1) === 13
    lines.push({ body: text.slice(start, crlf ? index - 1 : index), eol: crlf ? '\r\n' : '\n' })
    start = index + 1
  }
  if (start < text.length) lines.push({ body: text.slice(start), eol: '' })
  return lines
}

export function joinLines(lines: readonly Line[]): string {
  let out = ''
  for (const line of lines) out += line.body + line.eol
  return out
}

/** 文件的主流换行符；没有换行时按 LF。 */
export function dominantEol(lines: readonly Line[]): '\n' | '\r\n' {
  let crlf = 0
  let lf = 0
  for (const line of lines) {
    if (line.eol === '\r\n') crlf += 1
    else if (line.eol === '\n') lf += 1
  }
  return crlf > lf ? '\r\n' : '\n'
}

type EditOp = '=' | '-' | '+'

/**
 * Myers 行差异（只跑掐头去尾后的中段）。编辑距离超过上限时返回 null，调用方退回「中段整体替换」：
 * 结果仍然正确，只是审阅时不那么紧凑。
 */
function myers(a: readonly string[], b: readonly string[], maxD: number): EditOp[] | null {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  const limit = Math.min(maxD, n + m)
  const offset = limit + 1
  const v = new Int32Array(2 * limit + 3).fill(-1)
  v[offset + 1] = 0
  const trace: Int32Array[] = []
  for (let d = 0; d <= limit; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1 }
      v[offset + k] = x
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1))
        return backtrack(trace, n, m)
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1))
  }
  return null
}

function backtrack(trace: readonly Int32Array[], n: number, m: number): EditOp[] {
  const ops: EditOp[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const previous = trace[d - 1]!
    const k = x - y
    const at = (kk: number) => previous[kk + (d - 1)]!
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    const startX = down ? prevX : prevX + 1
    while (x > startX) { ops.push('='); x -= 1; y -= 1 }
    ops.push(down ? '+' : '-')
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) { ops.push('='); x -= 1; y -= 1 }
  return ops.reverse()
}

/** 两段文本的逐行编辑序列：先掐掉公共头尾，中段跑 Myers，超限时中段整体替换。 */
export function diffOps(before: readonly string[], after: readonly string[], maxD = 1500): EditOp[] {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1
  let tail = 0
  while (tail < before.length - head && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1
  const midA = before.slice(head, before.length - tail)
  const midB = after.slice(head, after.length - tail)
  const middle = myers(midA, midB, maxD)
    ?? [...midA.map((): EditOp => '-'), ...midB.map((): EditOp => '+')]
  return [...Array<EditOp>(head).fill('='), ...middle, ...Array<EditOp>(tail).fill('=')]
}

/** 一段审阅用差异：带上下文的统一 diff 文本与增删行数（行数覆盖全部差异，不受展示截断影响）。 */
export interface UnifiedDiff {
  readonly text: string
  readonly added: number
  readonly removed: number
}

function lineView(line: Line): string {
  return line.body
}

/** 由我们自己从基线与新内容重算的统一 diff（3 行上下文）。审批卡展示的就是它。 */
export function unifiedDiff(beforeText: string, afterText: string, context = 3): UnifiedDiff {
  const before = splitLines(beforeText)
  const after = splitLines(afterText)
  const ops = diffOps(before.map(line => line.body + line.eol), after.map(line => line.body + line.eol))
  const rows: { op: EditOp; a: number; b: number }[] = []
  let a = 0
  let b = 0
  let added = 0
  let removed = 0
  for (const op of ops) {
    rows.push({ op, a, b })
    if (op === '=') { a += 1; b += 1 } else if (op === '-') { a += 1; removed += 1 } else { b += 1; added += 1 }
  }
  const changed = rows.flatMap((row, index) => (row.op === '=' ? [] : [index]))
  const out: string[] = []
  let cursor = 0
  while (cursor < changed.length) {
    const blockStart = changed[cursor]!
    let blockEnd = blockStart
    let next = cursor + 1
    // 两块改动之间相等的行不超过 2×上下文时并成一段，和 git 的分段方式一致。
    while (next < changed.length && changed[next]! - blockEnd - 1 <= context * 2) { blockEnd = changed[next]!; next += 1 }
    const start = Math.max(0, blockStart - context)
    const stop = Math.min(rows.length, blockEnd + 1 + context)
    const slice = rows.slice(start, stop)
    const oldStart = slice[0]!.a
    const newStart = slice[0]!.b
    const oldCount = slice.filter(row => row.op !== '+').length
    const newCount = slice.filter(row => row.op !== '-').length
    out.push(`@@ -${oldCount === 0 ? oldStart : oldStart + 1},${oldCount} +${newCount === 0 ? newStart : newStart + 1},${newCount} @@`)
    for (const row of slice) {
      if (row.op === '=') out.push(` ${lineView(before[row.a]!)}`)
      else if (row.op === '-') out.push(`-${lineView(before[row.a]!)}`)
      else out.push(`+${lineView(after[row.b]!)}`)
    }
    cursor = next
  }
  const beforeEol = before.length > 0 ? dominantEol(before) : null
  const afterEol = after.length > 0 ? dominantEol(after) : null
  if (beforeEol && afterEol && beforeEol !== afterEol) out.push(`\\ 换行符由 ${beforeEol === '\r\n' ? 'CRLF' : 'LF'} 改为 ${afterEol === '\r\n' ? 'CRLF' : 'LF'}`)
  const lastBefore = before.at(-1)
  const lastAfter = after.at(-1)
  if (lastBefore && lastAfter && (lastBefore.eol === '') !== (lastAfter.eol === '')) {
    out.push(lastAfter.eol === '' ? '\\ 新内容末尾没有换行' : '\\ 新内容在末尾补了换行')
  }
  return { text: out.join('\n'), added, removed }
}

interface HunkLine {
  readonly kind: ' ' | '-' | '+'
  readonly body: string
  /** 紧跟着 `\ No newline at end of file`。 */
  noEol: boolean
}

interface Hunk {
  readonly oldStart: number
  readonly lines: HunkLine[]
}

function parseHunks(diff: string): Hunk[] | string {
  const raw = diff.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
  // 补丁文本通常以换行结尾：尾部的空串不是一行空上下文。
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  for (const [index, line] of raw.entries()) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      current = { oldStart: Number(header[1]), lines: [] }
      hunks.push(current)
      continue
    }
    if (!current) {
      // 第一段之前的文件头（diff/index/---/+++）不参与应用。
      if (line === '' || /^(diff |index |--- |\+\+\+ |new file mode|deleted file mode|similarity |rename )/.test(line)) continue
      return `补丁在第一个 @@ 段之前有无法识别的内容：${line.slice(0, 80)}`
    }
    if (line.startsWith('\\')) {
      const last = current.lines.at(-1)
      if (last) last.noEol = true
      continue
    }
    // 段内出现完整的「--- / +++ / @@」三行就是第二个文件的头；单独一行 --- 只是删掉了以 -- 开头的内容。
    if (line.startsWith('--- ') && raw[index + 1]?.startsWith('+++ ') && raw[index + 2]?.startsWith('@@')) {
      return '一个补丁只能针对一个文件；多文件改动请在 files 里分开提交'
    }
    const kind = line[0]
    if (kind === '+' || kind === '-' || kind === ' ') current.lines.push({ kind, body: line.slice(1), noEol: false })
    else if (line === '') current.lines.push({ kind: ' ', body: '', noEol: false })
    else return `补丁里有无法识别的行：${line.slice(0, 80)}`
  }
  if (hunks.length === 0) return '补丁里没有 @@ 段'
  for (const hunk of hunks) {
    if (!hunk.lines.some(line => line.kind !== ' ')) return '补丁里有一段没有任何增删'
  }
  return hunks
}

/** 在 cursor 之后找 needle 的出现位置，取离 hint 最近的一个；两个同样近就判为有歧义。 */
function locate(haystack: readonly Line[], needle: readonly string[], cursor: number, hint: number): number | 'missing' | 'ambiguous' {
  if (needle.length === 0) return Math.min(Math.max(cursor, hint), haystack.length)
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  let tie = false
  for (let start = cursor; start + needle.length <= haystack.length; start += 1) {
    let match = true
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index]!.body !== needle[index]) { match = false; break }
    }
    if (!match) continue
    const distance = Math.abs(start - hint)
    if (distance < bestDistance) { best = start; bestDistance = distance; tie = false } else if (distance === bestDistance) tie = true
  }
  if (best < 0) return 'missing'
  return tie ? 'ambiguous' : best
}

/**
 * 把模型给的统一 diff 严格套到基线上。
 *
 * 上下文与删除行必须逐字等于基线（只忽略各自的换行符），位置以段头为提示、找最近的唯一匹配；
 * 对不上或有歧义就拒绝，绝不模糊套用 —— 套歪的补丁哪怕审阅时能看出来，也不该走到审批卡上。
 * 新增行沿用文件原有的主流换行符。
 */
export function applyUnifiedDiff(baseline: string, diff: string): { ok: true; text: string } | { ok: false; error: string } {
  const parsed = parseHunks(diff)
  if (typeof parsed === 'string') return { ok: false, error: parsed }
  const lines = splitLines(baseline)
  const eol = dominantEol(lines)
  const out: Line[] = []
  let cursor = 0
  for (const [index, hunk] of parsed.entries()) {
    const old = hunk.lines.filter(line => line.kind !== '+').map(line => line.body)
    const hint = Math.max(0, hunk.oldStart - (old.length === 0 ? 0 : 1))
    const at = locate(lines, old, cursor, hint)
    if (at === 'missing') return { ok: false, error: `补丁第 ${index + 1} 段的上下文与基线对不上；请重新读取文件后再提交，或改用整文件替换内容` }
    if (at === 'ambiguous') return { ok: false, error: `补丁第 ${index + 1} 段在基线里匹配到多处，无法确定位置；请多带几行上下文` }
    for (let line = cursor; line < at; line += 1) out.push(lines[line]!)
    let consumed = at
    for (const line of hunk.lines) {
      if (line.kind === ' ') { out.push(lines[consumed]!); consumed += 1 } else if (line.kind === '-') consumed += 1
      else out.push({ body: line.body, eol: line.noEol ? '' : eol })
    }
    cursor = consumed
  }
  for (let line = cursor; line < lines.length; line += 1) out.push(lines[line]!)
  // 中间不能有缺换行的行：原文件最后一行在其后被追加了内容时补上换行。
  const fixed = out.map((line, index) => (line.eol === '' && index < out.length - 1 ? { body: line.body, eol } : line))
  return { ok: true, text: joinLines(fixed) }
}

/** 审阅文档里的一个文件（审批卡逐项展示）。 */
export interface ReviewFile {
  /** 相对授权根的路径（统一用 /）。 */
  readonly path: string
  readonly action: 'modify' | 'create'
  readonly added: number
  readonly removed: number
  readonly baseHash: string
  readonly newHash: string
  readonly diff: string
  readonly diffTruncated: boolean
}

export interface ChangeReview {
  readonly format: 'dsh-change-review@1'
  readonly root: string
  readonly revision: number
  readonly files: readonly ReviewFile[]
  readonly totalAdded: number
  readonly totalRemoved: number
  readonly truncated: boolean
  readonly notice: string | null
}

/** 审批卡差异展示的总预算；超出部分如实提示，文件清单与增删行数永远完整。 */
export const REVIEW_LIMITS = { maxLines: 400, maxChars: 48_000 } as const

/** 把每个文件的完整差异压进展示预算：逐行截断，截断就在文件与整体上各标一次。 */
export function buildChangeReview(root: string, revision: number,
  files: readonly { path: string; action: 'modify' | 'create'; baseHash: string; newHash: string; diff: UnifiedDiff }[],
  limits: { maxLines: number; maxChars: number } = REVIEW_LIMITS,
): ChangeReview {
  let lines = 0
  let chars = 0
  let hidden = 0
  const out: ReviewFile[] = files.map(file => {
    const rows = file.diff.text.length === 0 ? [] : file.diff.text.split('\n')
    const kept: string[] = []
    for (const row of rows) {
      if (lines >= limits.maxLines || chars + row.length + 1 > limits.maxChars) { hidden += 1; continue }
      kept.push(row)
      lines += 1
      chars += row.length + 1
    }
    return {
      path: path.relative(root, file.path).split(path.sep).join('/'),
      action: file.action, added: file.diff.added, removed: file.diff.removed,
      baseHash: file.baseHash, newHash: file.newHash,
      diff: kept.join('\n'), diffTruncated: kept.length < rows.length,
    }
  })
  return {
    format: 'dsh-change-review@1', root, revision, files: out,
    totalAdded: out.reduce((sum, file) => sum + file.added, 0),
    totalRemoved: out.reduce((sum, file) => sum + file.removed, 0),
    truncated: hidden > 0,
    notice: hidden > 0 ? `差异太长，审批卡只显示了前 ${lines} 行，另有 ${hidden} 行未显示；增删行数按完整改动统计。看不全时请先驳回，到项目里核对后再让助理拆小提交。` : null,
  }
}

/** 提交里的一个文件：真实路径、批准时的基线版本、新内容与它的哈希。 */
export interface CommitFile {
  readonly path: string
  readonly baseHash: string
  readonly content: string
  readonly newHash: string
}

export interface CommitConflict {
  readonly path: string
  readonly expected: string
  readonly actual: string
}

export type CommitResult =
  | { readonly kind: 'applied'; readonly files: readonly { path: string; beforeHash: string; afterHash: string }[] }
  | { readonly kind: 'conflict'; readonly conflicts: readonly CommitConflict[] }
  | { readonly kind: 'failed'; readonly error: string; readonly wroteTargets: boolean }
  | { readonly kind: 'unknown'; readonly error: string; readonly files: readonly { path: string; state: string }[] }

/** 测试用的故障注入点；生产代码不传。 */
export interface CommitHooks {
  /** 第二次核对之前调用（模拟核对与改名之间的外部修改）。 */
  beforeFinalCheck?(): void
  /** 每次改名之前调用；抛错即模拟这次改名失败。 */
  beforeRename?(target: string, index: number): void
}

function tempPathFor(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.dsh-${randomBytes(6).toString('hex')}.tmp`)
}

/** 写临时文件并落盘；flag wx 保证不覆盖任何已存在的东西。 */
function writeTemp(target: string, bytes: Buffer, mode: number | null): string {
  const temp = tempPathFor(target)
  const fd = openSync(temp, 'wx', mode ?? 0o666)
  try {
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (mode !== null && process.platform !== 'win32') chmodSync(temp, mode)
  return temp
}

function removeQuietly(file: string): void {
  try { rmSync(file, { force: true }) } catch { /* 临时文件清不掉只留下一个隐藏的 .tmp，不影响目标。 */ }
}

/**
 * 改名覆盖。Windows 上杀毒或索引服务可能短暂占住刚写好的临时文件（EPERM / EBUSY / EACCES），
 * 退避重试两次；仍失败就交给调用方回滚。
 */
function renameWithRetry(from: string, to: string): void {
  const delays = process.platform === 'win32' ? [20, 80] : []
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = errorCode(error)
      if (attempt >= delays.length || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]!)
    }
  }
}

/** 上级目录仍是它的真实路径（没被换成链接），否则这次写入的落点无法确认。 */
function parentIntact(target: string): boolean {
  const dir = path.dirname(target)
  try {
    return realpathSync.native(dir) === dir && lstatSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** 原子写回一份内容（回滚用）。 */
function restore(target: string, bytes: Buffer, mode: number | null): void {
  const temp = writeTemp(target, bytes, mode)
  try {
    renameWithRetry(temp, target)
  } catch (error) {
    removeQuietly(temp)
    throw error
  }
}

/**
 * 原子地提交一组文件。
 *
 * 1. 逐个核对基线版本（含上级目录没被换成链接）；任何一个不符 → 冲突，不写任何目标文件；
 * 2. 每个文件写同目录临时文件并 fsync；
 * 3. 改名前再核一次版本（把核对与写入之间的窗口压到最小）；
 * 4. 逐个改名覆盖；第 i 个失败就把前 i-1 个恢复成基线（新建的删除），恢复成功记 failed（项目未改动），
 *    恢复不了记 unknown 并列出每个文件的状态；
 * 5. 全部改名后重读核对新哈希，不符记 unknown。
 *
 * 已知限制：Node 没有 openat 一类的目录句柄，第 3 步与第 4 步之间仍有极短的窗口；
 * 第 5 步的复核用来发现这个窗口里的异常。
 */
export function commitFiles(files: readonly CommitFile[], hooks: CommitHooks = {}): CommitResult {
  const check = (): { conflicts: CommitConflict[]; snapshots: FileSnapshot[] } => {
    const snapshots = files.map(file => readSnapshot(file.path))
    const conflicts: CommitConflict[] = []
    files.forEach((file, index) => {
      const actual = parentIntact(file.path) ? snapshots[index]!.version : 'parent-changed'
      if (actual !== file.baseHash) conflicts.push({ path: file.path, expected: file.baseHash, actual })
    })
    return { conflicts, snapshots }
  }
  const first = check()
  if (first.conflicts.length > 0) return { kind: 'conflict', conflicts: first.conflicts }

  const temps: string[] = []
  try {
    files.forEach((file, index) => {
      const bytes = Buffer.from(file.content, 'utf8')
      if (sha256Hex(bytes) !== file.newHash) throw new Error(`${file.path} 的新内容与批准时的哈希不符`)
      temps.push(writeTemp(file.path, bytes, first.snapshots[index]!.mode))
    })
  } catch (error) {
    for (const temp of temps) removeQuietly(temp)
    return { kind: 'failed', error: `写临时文件失败：${messageOf(error)}`, wroteTargets: false }
  }

  hooks.beforeFinalCheck?.()
  const second = check()
  if (second.conflicts.length > 0) {
    for (const temp of temps) removeQuietly(temp)
    return { kind: 'conflict', conflicts: second.conflicts }
  }

  const committed: number[] = []
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!
    try {
      hooks.beforeRename?.(file.path, index)
      renameWithRetry(temps[index]!, file.path)
      committed.push(index)
    } catch (error) {
      for (const temp of temps.slice(index)) removeQuietly(temp)
      const states = files.map(item => ({ path: item.path, state: 'untouched' }))
      let restored = true
      for (const done of committed) {
        const original = second.snapshots[done]!
        try {
          if (original.bytes === null) rmSync(files[done]!.path, { force: true })
          else restore(files[done]!.path, original.bytes, original.mode)
          states[done] = { path: files[done]!.path, state: 'restored' }
        } catch {
          restored = false
          states[done] = { path: files[done]!.path, state: 'uncertain' }
        }
      }
      const reason = `${file.path} 改名失败（${errorCode(error)}：${messageOf(error)}）`
      if (restored) {
        return { kind: 'failed', error: `${reason}；已把之前写入的 ${committed.length} 个文件恢复成基线，项目未改动`, wroteTargets: committed.length > 0 }
      }
      return { kind: 'unknown', error: `${reason}；部分文件恢复失败，项目处于不确定状态`, files: states }
    }
  }

  const after = files.map(file => readSnapshot(file.path).version)
  const mismatched = files.filter((file, index) => after[index] !== file.newHash)
  if (mismatched.length > 0) {
    return {
      kind: 'unknown',
      error: `写入后重读核对不符：${mismatched.map(file => file.path).join('、')}（可能在写入瞬间被其他程序修改）`,
      files: files.map((file, index) => ({ path: file.path, state: after[index] === file.newHash ? 'written' : `changed:${after[index]}` })),
    }
  }
  return {
    kind: 'applied',
    files: files.map((file, index) => ({ path: file.path, beforeHash: file.baseHash, afterHash: after[index]! })),
  }
}

/** 项目文件快照里的一项。 */
interface TreeEntry {
  readonly size: number
  readonly mtimeMs: number
}

export interface TreeSnapshot {
  readonly files: ReadonlyMap<string, TreeEntry>
  readonly truncated: boolean
}

/** 不进文件快照的目录：版本库元数据与依赖目录体量大、又不是"验证改了什么"关心的东西。 */
const SNAPSHOT_SKIP = new Set(['.git', '.hg', '.svn', 'node_modules'])

/**
 * 授权项目的文件快照（大小 + 修改时间），用于报告验证命令前后的文件变化。
 * 不跟随符号链接，不进版本库元数据与依赖目录，超过上限就截断并如实标注。
 */
export function snapshotTree(root: string, limits: { maxFiles: number; maxDepth: number } = { maxFiles: 5000, maxDepth: 12 }): TreeSnapshot {
  const files = new Map<string, TreeEntry>()
  let truncated = false
  const walk = (dir: string, depth: number) => {
    if (truncated) return
    if (depth > limits.maxDepth) { truncated = true; return }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.size >= limits.maxFiles) { truncated = true; return }
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SNAPSHOT_SKIP.has(entry.name)) walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = lstatSync(full)
        files.set(path.relative(root, full).split(path.sep).join('/'), { size: stat.size, mtimeMs: stat.mtimeMs })
      } catch { /* 运行中被删掉的文件不计。 */ }
    }
  }
  walk(root, 0)
  return { files, truncated }
}

export interface TreeChanges {
  readonly created: readonly string[]
  readonly modified: readonly string[]
  readonly deleted: readonly string[]
  readonly truncated: boolean
}

/** 两次快照之间的变化；每类最多列 50 条。 */
export function diffTrees(before: TreeSnapshot, after: TreeSnapshot, maxEach = 50): TreeChanges {
  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  for (const [file, entry] of after.files) {
    const old = before.files.get(file)
    if (!old) created.push(file)
    else if (old.size !== entry.size || old.mtimeMs !== entry.mtimeMs) modified.push(file)
  }
  for (const file of before.files.keys()) if (!after.files.has(file)) deleted.push(file)
  const cut = (list: string[]) => list.sort().slice(0, maxEach)
  return {
    created: cut(created), modified: cut(modified), deleted: cut(deleted),
    truncated: before.truncated || after.truncated || created.length > maxEach || modified.length > maxEach || deleted.length > maxEach,
  }
}
