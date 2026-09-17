/**
 * `document.ts` 那套规则的真实出口：磁盘、摘要与系统的应用关联。
 *
 * 规则和 I/O 分开是有意的 —— 授权边界那部分要能被 `node --test` 穷举，一旦沾上 electron
 * 就跑不起来了。这里只负责把能力和限额落实，判断一律交回 `document.ts`。
 *
 * 这个文件由 esbuild 打包、不被测试导入，所以本地导入按仓库惯例写 `.js` 说明符。
 */
import { shell } from 'electron'
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath as realpathFs, stat as statFs } from 'node:fs/promises'
import path from 'node:path'
import { type DocFile, type DocFileSystem } from './document.ts'

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

    async realpath(target: string): Promise<string> {
      try {
        return await realpathFs(target)
      } catch {
        // 契约是原样返回而不是抛：解不动就按字面路径做包含判断，那是拒绝，不是放行。
        return target
      }
    },

    async read(target: string): Promise<string> {
      return readFile(target, 'utf8')
    },

    async fingerprint(target: string): Promise<string> {
      // 整份读进来算 sha256：体积上限已经在 open 那一侧挡过（8MB），这个量级一次读完不算贵，
      // 而按 mtime 判改动会漏掉"改了又改回去"和"复制过来 mtime 一致但内容不同"两种情况。
      const buffer = await readFile(target)
      return `${buffer.length}:${createHash('sha256').update(buffer).digest('hex')}`
    },

    async openWithAssociatedApp(target: string): Promise<void> {
      // shell.openPath 把路径交给系统的文件关联，不拼 shell 命令。关联本身可能指向一个
      // 可执行程序，所以能交给它的扩展名由 document.ts 的白名单先挡一道。
      // 它不抛异常：成功返回空串，失败返回原因。
      const failure = await shell.openPath(target)
      if (failure !== '') throw new Error(failure)
    },
  }
}
