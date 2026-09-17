/**
 * 文档页的投影：措辞、单位、进度说法都在这里，`DocPanel.tsx` 只负责画。
 *
 * 跟 `team-panel.ts` 一个道理 —— 这些字符串用户要读，读错了就是界面在撒谎，所以它们得能
 * 被 `node --test` 直接钉住，而不是靠开一次 Electron 壳用眼睛看。
 */

/** 体积。1024 进制、标 KB/MB：主进程那条 8MB 解析上限也是这么算的，两处得对得上。 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '体积未知'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** 改动时间。只给到分钟：挑重名文件靠的是"哪份是新的"，秒没有意义。 */
export function formatDate(mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return '时间未知'
  const date = new Date(mtimeMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 提纲里一行的标题。没有标题的段（纯文本、Markdown 的开头）只能报段号。 */
export function sectionLabel(heading: string | null, index: number): string {
  return heading === null || heading.trim() === '' ? `第 ${index + 1} 段` : heading
}

/**
 * 讲解进度的一句话。
 *
 * 没开始和讲完了必须分开说：`next` 是"下一段要讲的下标"，一段没讲时是 0，全讲完时等于
 * 段数，光把数字摆出来用户分不清自己站在哪一头。
 */
export function progressLabel(next: number, total: number, estMinutes: number): string {
  if (total <= 0) return '这份文档没有可讲的段落'
  if (next <= 0) return `共 ${total} 段，全部讲完大约 ${estMinutes} 分钟`
  if (next >= total) return `共 ${total} 段，已经讲完`
  // 剩下的时长按段数摊。整份的估算是按字数算出来的，这里拿不到字数，摊一下比不说强 ——
  // 但必须写"约"，别让用户以为这是个准数。
  const left = Math.max(1, Math.round((estMinutes * (total - next)) / total))
  return `已讲 ${next}/${total} 段，接下来第 ${next + 1} 段，剩下约 ${left} 分钟`
}

/**
 * 一条目录该显示成什么。
 *
 * 长路径中间省略、两头留着：用户认一个目录靠的是最后那一两级，而分清两个同名目录靠的是
 * 前面的盘符。只留尾巴的话 `D:\docs` 和 `E:\docs` 在列表里长得一模一样。
 */
export function shortenDir(dir: string, max = 34): string {
  const clean = dir.replace(/[\\/]+$/, '')
  if (clean.length <= max) return clean
  const head = clean.length > 4 ? clean.slice(0, 3) : clean
  // 尾巴至少留一个字：预算小到放不下时 `-(max - head.length - 1)` 会算成 -0，
  // 而 `slice(-0)` 就是 `slice(0)`，整条路径会被接到省略号后面，越缩越长。
  const tail = Math.max(1, max - head.length - 1)
  return `${head}…${clean.slice(-tail)}`
}
