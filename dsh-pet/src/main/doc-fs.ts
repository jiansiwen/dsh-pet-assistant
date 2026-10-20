/**
 * `document.ts` 那套规则的真实出口：磁盘、摘要与系统的应用关联。
 *
 * 规则和 I/O 分开是有意的 —— 授权边界那部分要能被 `node --test` 穷举，一旦沾上 electron
 * 就跑不起来了。这里只负责把能力和限额落实，判断一律交回 `document.ts`。
 *
 * electron 只在显式系统关联打开时加载，磁盘出口可直接用 Node 测试。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { open, readdir, realpath as realpathFs, stat as statFs } from 'node:fs/promises'
import path from 'node:path'
import { fail, ok, type ActionResult, type AppLaunchTarget, type OpenOutcome } from './desktop-actions.ts'
import { canOpenWithApp, DocSizeError, fingerprintBytes, MAX_DOC_BYTES, type DocFile, type DocFileSystem } from './document.ts'
import { openWithSpec, platformOf } from './platform.ts'

/** 句柄级再次验体积，并逐块守限，防止文件在 stat 之后增长。所有退出路径都关闭句柄。 */
async function readBoundedBytes(target: string, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted()
  const handle = await open(target, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('目标不是普通文件')
    if (info.size > MAX_DOC_BYTES) throw new DocSizeError(info.size)
    const chunks: Buffer[] = []
    let length = 0
    for (;;) {
      signal?.throwIfAborted()
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_DOC_BYTES + 1 - length))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      length += bytesRead
      if (length > MAX_DOC_BYTES) throw new DocSizeError(length)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, length)
  } finally {
    await handle.close()
  }
}

/**
 * 递归深度上限。
 *
 * 授权目录一般是"文档"这一级，五六层足够。再深就是在扫磁盘 —— 而 Windows 上的 junction
 * 能指回上层目录，没有深度上限的话一次查找能转成死循环。
 */
const MAX_DEPTH = 6

/** 一个授权目录最多列多少候选文件。防的是有人把整个磁盘挂进来当授权目录。 */
const MAX_FILES_PER_ROOT = 5000

/** 这些目录里不会有用户想讲解的文档，进去只是白扫一遍。 */
const SKIPPED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', 'appdata', '$recycle.bin',
])

async function walk(dir: string, depth: number, out: DocFile[]): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES_PER_ROOT) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // 没权限或者刚好被删掉的目录直接跳过：一个读不动的子目录不该让整次查找失败。
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES_PER_ROOT) return
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name.toLowerCase())) continue
      await walk(full, depth + 1, out)
      continue
    }
    // 符号链接不进候选：它指向哪儿由链接决定，而候选列表是拿来按名字匹配的，
    // 匹配上之后 open 还会再落地一次真实路径做包含判断，那边是最后一道。
    if (!entry.isFile()) continue
    try {
      const info = await statFs(full)
      out.push({ path: full, name: entry.name, size: info.size, mtimeMs: info.mtimeMs })
    } catch {
      // 列目录和读元信息之间文件被删掉了，这是正常情况，不是错误。
    }
  }
}

export function createDocFileSystem(): DocFileSystem {
  return {
    async list(root: string): Promise<readonly DocFile[]> {
      const out: DocFile[] = []
      await walk(root, 0, out)
      return out
    },

    async stat(target: string): Promise<DocFile | null> {
      try {
        const info = await statFs(target)
        // 目录也算"存在"，但不是一份文档。放它进去的话讲解会拿一个目录当文件读。
        if (!info.isFile()) return null
        return { path: target, name: path.basename(target), size: info.size, mtimeMs: info.mtimeMs }
      } catch {
        return null
      }
    },

    realpath: realpathFs,

    async read(target: string): Promise<string> {
      if (path.extname(target).toLowerCase() === '.pdf') throw new Error('禁止将 PDF 按 UTF-8 解码')
      const bytes = Buffer.from(await readBoundedBytes(target))
      // 文件改了扩展名仍不该把 PDF 原始字节送去 UTF-8 解码。
      if (bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('禁止将 PDF 按 UTF-8 解码')
      return bytes.toString('utf8')
    },

    readBytes: readBoundedBytes,

    async fingerprint(target: string, signal?: AbortSignal): Promise<string> {
      return fingerprintBytes(await readBoundedBytes(target, signal))
    },

    async openWithAssociatedApp(target: string): Promise<void> {
      // shell.openPath 把路径交给系统的文件关联，不拼 shell 命令。关联本身可能指向一个
      // 可执行程序，所以能交给它的扩展名由 document.ts 的白名单先挡一道。
      // 它不抛异常：成功返回空串，失败返回原因。
      const { shell } = await import('electron')
      const failure = await shell.openPath(target)
      if (failure !== '') throw new Error(failure)
    },
  }
}

/** 启动器：spawn 一条命令并在"进程确实起来了 / 起不来"时返回。测试可替换。 */
export type AppLauncher = (command: string, args: readonly string[]) => Promise<{ pid?: number }>

export const defaultAppLauncher: AppLauncher = (command, args) => new Promise((resolve, reject) => {
  // 参数数组直接交给 CreateProcess / execve，没有 shell 参与；detached + unref 让被打开的
  // 应用不随宠物退出。stdio 全部忽略：WPS 不需要我们的管道，留着反而可能把它挂住。
  const child = nodeSpawn(command, [...args], { detached: true, stdio: 'ignore', windowsHide: false, shell: false })
  child.once('error', reject)
  child.once('spawn', () => {
    child.unref()
    resolve({ pid: child.pid })
  })
})

export interface OpenWithAppDeps {
  platform?: string
  launcher?: AppLauncher
  statFile?: (target: string) => Promise<{ isFile(): boolean } | null>
}

async function defaultStatFile(target: string): Promise<{ isFile(): boolean } | null> {
  try { return await statFs(target) } catch { return null }
}

/**
 * 用**指定的应用**打开文件（不经系统默认关联）。与 `openWithAssociatedApp` 并存：
 * 后者交给系统关联，这里明确指定由哪个 exe / .app 打开，例如"用 WPS 打开"。
 *
 * 前置检查与 `reveal` 同一份白名单（不打开宏文档、不执行程序）。调用方负责传入已经过
 * 授权目录判断的真实路径（DocumentLibrary 的结果）。
 *
 * 成功只表示"已交给目标应用"（`verified: false`）：文档是否真的打开、打开在哪个窗口，
 * 要由 `findWindow` 核验，不能拿这里的成功当成目标达成。
 */
export async function openWithSpecifiedApp(
  target: string,
  app: AppLaunchTarget,
  deps: OpenWithAppDeps = {},
): Promise<ActionResult<OpenOutcome>> {
  const platform = platformOf(deps.platform ?? process.platform)
  const base = { action: 'openWith' as const, platform }
  if (!canOpenWithApp(platform === 'win32' ? path.win32.basename(target) : path.posix.basename(target))) {
    return fail('invalid-argument', '这种文件不允许交给外部应用打开', base)
  }
  const spec = openWithSpec(platform, app, target)
  if (spec === null) {
    return fail(platform === 'linux' ? 'unsupported' : 'invalid-argument',
      platform === 'linux' ? '这个平台没有实现指定应用打开' : '文件或应用路径必须是绝对路径', base)
  }
  const evidence = { ...base, command: { command: spec.command, args: spec.args } }
  const statFile = deps.statFile ?? defaultStatFile
  const file = await statFile(target)
  if (file === null || !file.isFile()) return fail('invalid-argument', '要打开的文件不存在或不是普通文件', evidence)
  // macOS 用 bundle id 打开时可执行文件是 /usr/bin/open，应用本身的存在由定位阶段核过。
  if (platform === 'win32' || app.bundleId === undefined) {
    const exe = await statFile(app.executable)
    if (exe === null) return fail('not-installed', '指定的应用不存在', evidence)
  }
  try {
    const { pid } = await (deps.launcher ?? defaultAppLauncher)(spec.command, spec.args)
    return ok({ launched: true, pid, verified: false }, evidence)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return fail('not-installed', '指定的应用无法启动（找不到可执行文件）', evidence)
    if (code === 'EACCES' || code === 'EPERM') return fail('permission-denied', '没有权限启动指定的应用', evidence)
    return fail('failed', `启动失败：${error instanceof Error ? error.message : String(error)}`, evidence)
  }
}
