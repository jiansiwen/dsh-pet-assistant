/**
 * 日期归属工具。单独一个模块，是因为采样器、迁移、工具层都要按同一套口径算"哪一天"，
 * 而这个口径不该寄居在 tracker 里——tracker 用了构造函数参数属性，
 * Node 的 strip-only TypeScript 模式解析不了，谁 import 它谁就没法被 node --test 导入。
 */

/** 本机的 YYYY-MM-DD。 */
export function localDateOf(ts: number): string {
  const d = new Date(ts)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/**
 * 保留期的起始日期：这一天（含）之后的原始活动保留，之前的可以清掉。
 *
 * 用固定 86400000 毫秒回退，跨夏令时的那一天会差一小时，结果是多保留一天。
 * 保留期算宽不算窄是故意的：多留一天只是占点磁盘，少留一天是删掉了用户的数据。
 */
export function retentionStartDate(now: number, retentionDays: number): string {
  return localDateOf(now - retentionDays * 86_400_000)
}

/**
 * 本机时区下这一天的零点（epoch 毫秒）；日期串不合法返回 NaN。
 *
 * 保留期用它把「文件名上的日期边界」换算成时间戳，好让磁盘上的采样原文
 * 和库里的观察记录按同一条线裁——两边差一小时就会出现"文件没了但库里还有"
 * 或者反过来的情况，核对起来无从下手。
 */
export function startOfLocalDate(date: string): number {
  return new Date(`${date}T00:00:00`).getTime()
}
