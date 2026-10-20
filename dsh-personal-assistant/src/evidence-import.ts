/**
 * 已授权项目里的文件与仓库差异作为工作证据（M3-03），以及"允许把某份资料正文发给模型"的提案。
 *
 * 读取边界：
 * - 只读用户已授权的帮助范围（help-context.ts 的授权记录，按实际路径核对）；目标先 realpath，
 *   必须仍在授权目录内——符号链接改指、../ 越界、文件级授权之外的文件一律拒；
 * - 只读 UTF-8 文本，不读二进制、不读超限文件；仓库差异只跑 `git diff HEAD`，并关掉仓库配置里
 *   可能被借来执行命令的外部 diff、textconv 与 fsmonitor，也不写索引锁；
 * - 读到的正文要交给模型服务商：帮助授权里说的是"目录列表、Git 状态与提交信息"，不含文件正文，
 *   所以登记前必须经可信审批。审批卡片上就是将要发送的全文，批准后才登记为"可发送模型"的资料。
 *
 * 可见窗口内容读取依赖桌面动作模块，本轮没有接入；这里也不提供任何窗口、聊天库或客户端注入的读取路径。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { snapshotDigest, type AssistantSubmission } from './assistant-approval.ts'
import type { HelpContext } from './help-context.ts'
import { MATERIAL_KIND_LABEL, materialMeta, type MaterialStore } from './materials.ts'
import { formatLocalTime, sha256 } from './store.ts'
import { localDateOf } from './time.ts'

export const MAX_PROJECT_FILE_BYTES = 256 * 1024
/** 一次导入的行数上限：审批卡片要能让人从头读到尾。 */
export const MAX_IMPORT_LINES = 400
const GIT_TIMEOUT_MS = 5000

export interface ProjectMaterialRequest {
  projectDir: string
  kind: 'file' | 'diff'
  /** file：恰好一个文件；diff：可选若干文件，缺省为整个工作区差异。绝对路径或相对项目目录。 */
  paths?: string[]
  startLine?: number
  endLine?: number
}

export interface ProjectMaterialRead {
  kind: 'file_excerpt' | 'repo_diff'
  projectDir: string
  objectLabel: string
  content: string
  coverage: string
  truncated: boolean
  digest: string
  /** 读取依据：再次核对用（文件的大小与修改时间、差异涉及的文件）。 */
  basis: Array<{ path: string; size: number | null; mtimeMs: number | null }>
}

export interface AuthorizedScopes {
  authorizedScope(projectDir: string): HelpContext | null
}

/** root 之内（不含 root 本身）。 */
function strictlyInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** 解析出授权目录内的实际路径；不存在的路径（差异里被删掉的文件）按最近的已存在父目录核对。 */
function resolveInside(scope: HelpContext, candidate: string, mustExist: boolean): { ok: true; real: string; relative: string } | { ok: false; message: string } {
  if (typeof candidate !== 'string' || !candidate.trim()) return { ok: false, message: '没有给出文件路径' }
  const absolute = path.resolve(scope.projectDir, candidate)
  let real: string
  try {
    real = realpathSync(absolute)
  } catch {
    if (mustExist) return { ok: false, message: `文件不存在：${absolute}` }
    let parent = path.dirname(absolute)
    while (true) {
      try { realpathSync(parent); break } catch { /* 继续往上找 */ }
      const up = path.dirname(parent)
      if (up === parent) return { ok: false, message: `路径不在授权范围内：${absolute}` }
      parent = up
    }
    const realParent = realpathSync(parent)
    real = path.join(realParent, path.relative(parent, absolute))
  }
  if (!strictlyInside(scope.projectDir, real)) return { ok: false, message: `实际路径不在已授权的项目目录内：${real}` }
  if (scope.currentFile && real !== scope.currentFile) return { ok: false, message: '这次帮助只授权了一个文件，不能读取它之外的文件' }
  return { ok: true, real, relative: path.relative(scope.projectDir, real) }
}

function decodeText(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args], {
      cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

/** 项目目录本身就是独立 Git 仓库的根（授权子目录不等于授权父仓库，口径同 readProjectEvidence）。 */
function isRepositoryRoot(dir: string): boolean {
  const top = git(['rev-parse', '--show-toplevel'], dir)?.trim()
  const gitDir = git(['rev-parse', '--absolute-git-dir'], dir)?.trim()
  if (!top || !gitDir) return false
  try {
    return realpathSync(top) === dir && strictlyInside(dir, realpathSync(gitDir))
  } catch {
    return false
  }
}

function fileBasis(file: string): { path: string; size: number | null; mtimeMs: number | null } {
  try {
    const stat = statSync(file)
    return { path: file, size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return { path: file, size: null, mtimeMs: null }
  }
}

/** 按授权读取一份项目资料。任何一处不成立都返回拒绝原因，不读取范围外的任何字节。 */
export function readProjectMaterial(scopes: AuthorizedScopes, request: ProjectMaterialRequest, now: number):
  { ok: true; read: ProjectMaterialRead } | { ok: false; message: string } {
  if (typeof request.projectDir !== 'string' || !path.isAbsolute(request.projectDir)) return { ok: false, message: '项目目录必须是绝对路径' }
  const scope = scopes.authorizedScope(request.projectDir)
  if (!scope) return { ok: false, message: '该目录没有被用户授权为帮助上下文（或授权已撤销、实际路径已改指），不能读取' }
  const paths = Array.isArray(request.paths) ? request.paths.filter(item => typeof item === 'string') : []
  if (request.kind === 'file') {
    const target = paths.length === 1 ? paths[0] : scope.currentFile && paths.length === 0 ? scope.currentFile : null
    if (!target) return { ok: false, message: '读取文件时必须且只能指定一个文件' }
    const resolved = resolveInside(scope, target, true)
    if (!resolved.ok) return resolved
    const stat = statSync(resolved.real)
    if (!stat.isFile()) return { ok: false, message: '只能读取普通文件' }
    if (stat.size > MAX_PROJECT_FILE_BYTES) return { ok: false, message: `文件超过 ${MAX_PROJECT_FILE_BYTES / 1024}KB，不读取；请指定行范围较小的文本文件` }
    const decoded = decodeText(readFileSync(resolved.real))
    if (decoded === null) return { ok: false, message: '这不是 UTF-8 文本文件（可能是二进制），不读取' }
    const all = decoded.replace(/\r\n?/g, '\n').split('\n')
    const total = all.length
    const start = Math.max(1, Math.floor(Number(request.startLine ?? 1)) || 1)
    if (start > total) return { ok: false, message: `起始行 ${start} 超过文件总行数 ${total}` }
    const wantedEnd = Math.min(total, Math.floor(Number(request.endLine ?? total)) || total)
    const end = Math.min(wantedEnd, start + MAX_IMPORT_LINES - 1)
    const truncated = end < wantedEnd
    const content = all.slice(start - 1, end).join('\n')
    if (!content.trim()) return { ok: false, message: '所选范围内没有内容' }
    return {
      ok: true,
      read: {
        kind: 'file_excerpt', projectDir: scope.projectDir, objectLabel: resolved.real, content, truncated,
        digest: sha256(content),
        coverage: `项目文件 ${resolved.real} 第 ${start}–${end} 行（全文共 ${total} 行${truncated ? `，超过 ${MAX_IMPORT_LINES} 行的部分已截断` : ''}）；读取于 ${formatLocalTime(now)}，文件修改时间 ${formatLocalTime(stat.mtimeMs)}。只说明文件此刻的内容，不说明谁在何时改过它`,
        basis: [fileBasis(resolved.real)],
      },
    }
  }
  if (request.kind !== 'diff') return { ok: false, message: '只支持读取项目文件（file）或仓库差异（diff）；可见窗口读取尚未接入' }
  const relatives: string[] = []
  const wanted = paths.length > 0 ? paths : scope.currentFile ? [scope.currentFile] : []
  for (const candidate of wanted) {
    const resolved = resolveInside(scope, candidate, false)
    if (!resolved.ok) return resolved
    relatives.push(resolved.relative)
  }
  if (!isRepositoryRoot(scope.projectDir)) return { ok: false, message: '授权目录不是独立的 Git 仓库根目录，不能读取仓库差异' }
  const raw = git(['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', '--', ...relatives], scope.projectDir)
  if (raw === null) return { ok: false, message: '读取仓库差异失败（git 不可用、超时或仓库没有提交）' }
  const lines = raw.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
  if (!raw.trim()) return { ok: false, message: '相对 HEAD 没有差异（未跟踪的新文件不在 git diff 里）' }
  const files = [...new Set(lines.filter(line => line.startsWith('diff --git ')).map(line => line.replace(/^diff --git a\/(.*?) b\/.*$/, '$1')))]
  const truncated = lines.length > MAX_IMPORT_LINES
  const content = lines.slice(0, MAX_IMPORT_LINES).join('\n')
  const shown = files.slice(0, 6).join('、') + (files.length > 6 ? ` 等 ${files.length} 个` : '')
  return {
    ok: true,
    read: {
      kind: 'repo_diff', projectDir: scope.projectDir, objectLabel: `${scope.projectDir}（${relatives.length > 0 ? relatives.join('、') : '整个工作区'}）`,
      content, truncated, digest: sha256(content),
      coverage: `仓库 ${scope.projectDir} 工作区相对 HEAD 的差异：${files.length} 个文件（${shown}），${Math.min(lines.length, MAX_IMPORT_LINES)} 行${truncated ? `，超过 ${MAX_IMPORT_LINES} 行的部分已截断` : ''}；读取于 ${formatLocalTime(now)}。不含未跟踪的新文件与提交历史，也不说明测试是否通过`,
      basis: files.map(file => fileBasis(path.join(scope.projectDir, file))),
    },
  }
}

/** 读取依据还在不在、变没变：授权仍有效，涉及的文件大小与修改时间都没变。 */
function basisUnchanged(scopes: AuthorizedScopes, read: ProjectMaterialRead): boolean {
  if (scopes.authorizedScope(read.projectDir)?.projectDir !== read.projectDir) return false
  return read.basis.every(item => {
    const now = fileBasis(item.path)
    return now.size === item.size && now.mtimeMs === item.mtimeMs
  })
}

/**
 * 读取项目资料并生成可信审批提交。主题带内容摘要：同一份内容重复提交只保留最新一条待批，
 * 不同资料互不顶替；执行时重读一遍，正文与审批时不一致就不登记。
 */
export function projectMaterialSubmission(deps: { scopes: AuthorizedScopes; materials: MaterialStore; now(): number }, request: ProjectMaterialRequest):
  { ok: true; submission: AssistantSubmission; read: ProjectMaterialRead } | { ok: false; message: string } {
  const first = readProjectMaterial(deps.scopes, request, deps.now())
  if (!first.ok) return first
  const read = first.read
  const label = MATERIAL_KIND_LABEL[read.kind]
  return {
    ok: true,
    read,
    submission: {
      subject: `project-material:${read.digest.slice(0, 16)}`,
      tool: 'personal_assistant_import_project_material',
      summary: `读取已授权项目里的${label}，登记为工作证据，并把下方全文发送给当前会话的模型服务商用于整理工作事项和日报。正文会以"不可信资料"标注交给模型，其中的指令不会被执行；发送后无法从服务商处撤回。不读取授权目录以外的任何文件。`,
      target: read.objectLabel,
      risk: 'high',
      snapshot: { 种类: label, 对象: read.objectLabel, 覆盖范围: read.coverage, 内容摘要: read.digest, 将发送的全文: read.content },
      validate: () => basisUnchanged(deps.scopes, read),
      execute: () => {
        const again = readProjectMaterial(deps.scopes, request, deps.now())
        if (!again.ok) throw new Error(`批准后重新读取失败，未登记：${again.message}`)
        if (again.read.digest !== read.digest) throw new Error('批准前后内容已变化，未登记；请重新提交')
        const result = deps.materials.register({
          kind: read.kind, origin: 'authorized_project', sourceLabel: read.kind === 'repo_diff' ? 'git_diff' : 'project_file',
          objectLabel: read.objectLabel, coverage: read.coverage, content: read.content, truncated: read.truncated,
          modelVisible: true, localDate: localDateOf(deps.now()), projectDir: read.projectDir,
        }, deps.now())
        if (!result.ok) throw new Error(result.message)
        return {
          imported: true, materialId: result.material.id, duplicate: result.duplicate, previouslyDeleted: result.previouslyDeleted,
          coverage: result.material.coverage,
        }
      },
    },
  }
}

/** 允许把一份尚未获准的资料正文发送给模型服务商。卡片上展示完整正文。 */
export function materialShareSubmission(deps: { materials: MaterialStore }, materialId: string):
  { ok: true; submission: AssistantSubmission } | { ok: false; message: string } {
  const material = deps.materials.get(materialId)
  if (!material) return { ok: false, message: '找不到这份资料（可能已删除）' }
  if (material.modelVisible) return { ok: false, message: '这份资料的正文已经允许发送给模型，不需要再批准' }
  const fixed = { ...materialMeta(material), content: material.content }
  const digest = snapshotDigest(fixed)
  return {
    ok: true,
    submission: {
      subject: `material-share:${material.id}`,
      tool: 'personal_assistant_share_material',
      summary: '允许把下列资料的正文发送给当前会话的模型服务商，用于整理工作事项与日报。正文会以"不可信资料"标注交给模型，其中的指令不会被执行；发送后无法从服务商处撤回。不批准则正文继续只留在本机。',
      target: `资料 ${material.id}（${MATERIAL_KIND_LABEL[material.kind]}${material.objectLabel ? ` · ${material.objectLabel}` : ''}）`,
      risk: 'high',
      snapshot: { 资料: materialMeta(material), 将发送的全文: material.content },
      validate: () => {
        const current = deps.materials.get(materialId)
        return !!current && !current.modelVisible && snapshotDigest({ ...materialMeta(current), content: current.content }) === digest
      },
      execute: () => {
        const current = deps.materials.get(materialId)
        if (!current || current.digest !== material.digest) throw new Error('资料已删除或内容已变化，未授权发送')
        deps.materials.setModelVisible(materialId, true)
        return { shared: true, materialId }
      },
    },
  }
}
