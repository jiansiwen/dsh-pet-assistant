/**
 * 工作台概览的三个只读数字（待办 / 今天的会议 / 今日活动）。
 *
 * 为什么单独成文件：命令处理器长在 `index.ts` 里，那里全是宿主与存储接线，测不干净。
 * 这里只做两件事 —— **把原始数字格式化成一行短文本**（≤40 字，前端直接显示），
 * 以及**在数据源不可用时给出确定的一句话**，而不是抛错或返回空串。
 *
 * 三条纪律：
 * 1. 只读：不写库、不改状态、不需审批。
 * 2. 短：客户端概览是一张卡片，一行放不下就等于没做。
 * 3. 数据源不可用要说清（「暂时读不到」），不能假装是 0 —— 0 和"没读到"是两件事，
 *    把后者显示成前者会让用户以为今天真的没开会。
 */

/** 概览需要的原始数字。任一项为 `null` 表示**这个数据源此刻拿不到**（不是 0）。 */
export interface WorkbenchSummarySnapshot {
  /** 未结束的待办数。 */
  readonly openTodos: number | null
  /** 其中在等用户处理的条数。 */
  readonly awaitingUser: number | null
  /** 今天已经结束的会议场数。 */
  readonly meetingsToday: number | null
  /** 今天被记录到的活动时长（毫秒）。 */
  readonly activeMs: number | null
  /** 今天活动时长最长的应用/项目名。 */
  readonly topSubject: string | null
}

/** 一条概览文本。`available:false` 时前端可以灰掉这张卡片。 */
export interface WorkbenchSummaryLine {
  readonly text: string
  readonly available: boolean
}

/** 数据源读不到时的统一说法：一句话、不含技术细节、不冒充 0。 */
export const UNAVAILABLE_TEXT = '暂时读不到'

/** 把毫秒说成"4 小时 20 分"。不足 1 分钟按 1 分钟算 —— "今天 0 分钟"会让人以为没记录。 */
export function describeDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000))
  if (totalMinutes < 1) return '不到 1 分钟'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} 分钟`
  if (minutes === 0) return `${hours} 小时`
  return `${hours} 小时 ${minutes} 分`
}

export function formatTodoCount(snapshot: Pick<WorkbenchSummarySnapshot, 'openTodos' | 'awaitingUser'>): WorkbenchSummaryLine {
  if (snapshot.openTodos === null) return { text: `${UNAVAILABLE_TEXT}待办数`, available: false }
  if (snapshot.openTodos === 0) return { text: '没有待办', available: true }
  const waiting = snapshot.awaitingUser ?? 0
  return {
    text: waiting > 0 ? `待办 ${snapshot.openTodos} 项（${waiting} 项待你处理）` : `待办 ${snapshot.openTodos} 项`,
    available: true,
  }
}

export function formatMeetingToday(snapshot: Pick<WorkbenchSummarySnapshot, 'meetingsToday'>): WorkbenchSummaryLine {
  if (snapshot.meetingsToday === null) return { text: `${UNAVAILABLE_TEXT}今天的会议`, available: false }
  if (snapshot.meetingsToday === 0) return { text: '今天还没有会议', available: true }
  return { text: `今天 ${snapshot.meetingsToday} 场会议`, available: true }
}

export function formatTodaySummary(snapshot: Pick<WorkbenchSummarySnapshot, 'activeMs' | 'topSubject'>): WorkbenchSummaryLine {
  if (snapshot.activeMs === null) return { text: `${UNAVAILABLE_TEXT}今天的活动`, available: false }
  if (snapshot.activeMs <= 0) return { text: '今天还没有记录到活动', available: true }
  const duration = describeDuration(snapshot.activeMs)
  const subject = snapshot.topSubject?.trim() ?? ''
  return { text: subject === '' ? `今天 ${duration}` : `今天 ${duration}，主要在 ${subject}`, available: true }
}

/**
 * 从一次快照里一次性算出三条文本。
 *
 * 快照函数可能抛（数据源半路挂了）：任何一条抛异常都按"读不到"处理，不能让一条命令
 * 的失败把另外两条也带下去。
 */
export function summarizeWorkbench(read: () => WorkbenchSummarySnapshot): {
  readonly todo: WorkbenchSummaryLine
  readonly meeting: WorkbenchSummaryLine
  readonly today: WorkbenchSummaryLine
} {
  let snapshot: WorkbenchSummarySnapshot
  try {
    snapshot = read()
  } catch {
    const missing = { text: UNAVAILABLE_TEXT, available: false }
    return { todo: missing, meeting: missing, today: missing }
  }
  return {
    todo: formatTodoCount(snapshot),
    meeting: formatMeetingToday(snapshot),
    today: formatTodaySummary(snapshot),
  }
}

// ── 从 DSH 打开工作台：页面参数解析 ──────────────────────────────────────

/**
 * 可以被 `/open-workbench` 打开的页面。**必须与桌宠 `renderer/settings-nav.ts` 的 id 一致**，
 * 自创名字等于让用户点了跳到一个不存在的页。
 */
export const WORKBENCH_PAGES = ['todo', 'meeting', 'report', 'team', 'doc', 'general'] as const
export type WorkbenchPage = (typeof WORKBENCH_PAGES)[number]

/** 中文名，用于把参数说回去（用户可能只记得"日报"两个字）。 */
export const WORKBENCH_PAGE_LABELS: Readonly<Record<WorkbenchPage, string>> = {
  todo: '待办提醒',
  meeting: '会议助手',
  report: '日报周报',
  team: '助理团',
  doc: '文档与讲解',
  general: '通用',
}

/** 参数缺失/不认识时的说明：把可选值直接列出来，别让用户猜。 */
export const WORKBENCH_PAGE_HINT = '要打开哪一页？可选：待办、会议、日报、助理团、文档、通用'

/** 桌宠没在跑：明确说清楚该先做什么，不静默拉起（拉起是 /summon-pet 的职责）。 */
export const WORKBENCH_OFFLINE_TEXT = '桌面宠物没在运行，先召唤它再打开工作台'

/**
 * 从命令的原始输入里取出页面。
 *
 * 接受三种写法（都是用户真的会打的）：`/open-workbench todo`、`/open-workbench 日报`、
 * `/open-workbench`（缺参数）。中英文都认，是因为快捷入口的按钮文案是中文，
 * 而参数名是英文 id —— 两边都得能用。
 */
export function parseWorkbenchPage(rawInput: string | undefined): WorkbenchPage | null {
  const raw = (rawInput ?? '').trim()
  const rest = raw.startsWith('/') ? raw.slice(raw.indexOf(' ') + 1) : raw
  const token = rest.trim().split(/\s+/u)[0] ?? ''
  if (token === '') return null
  const lower = token.toLowerCase()
  for (const page of WORKBENCH_PAGES) if (lower === page) return page
  for (const page of WORKBENCH_PAGES) if (token === WORKBENCH_PAGE_LABELS[page]) return page
  // 中文简写：日报周报 → 日报、文档与讲解 → 文档；"待办提醒"同理。
  for (const page of WORKBENCH_PAGES) {
    const label = WORKBENCH_PAGE_LABELS[page]
    if (label.startsWith(token) || label.includes(token)) return page
  }
  return null
}

// ── 改设置：一命令行 /assistant-set-option ─────────────────────────────────

/** 允许改的三项。值域与桌宠 `settings.set` 的白名单一字不差。 */
export const SET_OPTION_KEYS = ['wake', 'broadcast', 'docSpeech'] as const
export type SetOptionKey = (typeof SET_OPTION_KEYS)[number]

export interface SetOption {
  readonly key: SetOptionKey
  /** 送给桌宠的英文值：on|off / all|voice / source|ai。 */
  readonly value: string
}

/** 参数不对时的提示：把三组可选值一次列全，别让用户猜。 */
export const SET_OPTION_HINT = '用法：/assistant-set-option 键=值（wake=on|off、broadcast=all|voice、docSpeech=source|ai；键也可写 唤醒/播报/讲解）'

/** 键的中文别名：按钮上的文案是中文，括号里打中文最自然。 */
const KEY_ALIASES: Readonly<Record<string, SetOptionKey>> = {
  wake: 'wake', 唤醒: 'wake', 唤醒词: 'wake',
  broadcast: 'broadcast', 播报: 'broadcast', 朗读: 'broadcast',
  docspeech: 'docSpeech', 讲解: 'docSpeech', 讲解模式: 'docSpeech',
}

/** 值域白名单 + 中文别名。桌宠那边是最终裁决者，这里只是提前给出人话提示。 */
const VALUE_ALIASES: Readonly<Record<SetOptionKey, Readonly<Record<string, string>>>> = {
  wake: { on: 'on', off: 'off', 开: 'on', 关: 'off' },
  broadcast: { all: 'all', voice: 'voice', 全部: 'all', 所有: 'all', 语音: 'voice' },
  docSpeech: { source: 'source', ai: 'ai', 原文: 'source', 原文朗读: 'source', 讲解: 'ai', ai讲解: 'ai' },
}

/**
 * 解析 `键=值`。返回 null 表示**参数不可用**（缺等号、键不认识、值不在白名单）。
 *
 * 只做本地白名单校验、不猜意图：把 `broadcast=on` 猜成 `all` 这种事不做 ——
 * 用户会以为改成了"开"，实际改的是"全部念"，这类静默猜测比报错糟得多。
 */
export function parseSetOption(rawInput: string | undefined): SetOption | null {
  const raw = (rawInput ?? '').trim()
  const rest = raw.startsWith('/') ? raw.slice(raw.indexOf(' ') + 1) : raw
  const text = rest.trim()
  const split = text.indexOf('=')
  if (split <= 0) return null
  const keyText = text.slice(0, split).trim().toLowerCase()
  const valueText = text.slice(split + 1).trim().toLowerCase()
  if (keyText === '' || valueText === '') return null
  const key = KEY_ALIASES[keyText]
  if (key === undefined) return null
  const value = VALUE_ALIASES[key][valueText]
  if (value === undefined) return null
  return { key, value }
}

/** 回执文案：成功时把"改成了什么"说清楚（用户点一下要看到结果）。 */
export function describeSetOption(key: string, value: string): string {
  if (key === 'wake') return value === 'on' ? '已开启唤醒' : '已关闭唤醒'
  if (key === 'broadcast') return value === 'all' ? '已设为：所有回复都念' : '已设为：只念语音发起的'
  if (key === 'docSpeech') return value === 'ai' ? '已设为：AI 讲解' : '已设为：原文朗读'
  return `已改为 ${key}=${value}`
}

// ── 改某条待办的优先级（斜杠命令）────────────────────────────────────────

export const SET_PRIORITY_USAGE = '用法：/assistant-set-task-priority <任务ID> high|normal|low'
export const SET_PRIORITY_BAD_VALUE = '优先级只能是 high、normal 或 low'
/** 走审批通道，所以成功的说法只能是"已提交"，**绝不能是"已改成"**。 */
export const SET_PRIORITY_SUBMITTED = '已提交，请在桌面宠物里确认'

export type SetPriorityParse =
  | { readonly ok: true; readonly taskId: string; readonly priority: 'high' | 'normal' | 'low' }
  | { readonly ok: false; readonly problem: 'usage' | 'value' }

/**
 * 解析 `<taskId> <priority>`。
 *
 * 两种失败分开：**参数个数不对**（连值都没给）与**值非法**（给了但不是三选一），
 * 回执文案不同 —— 用户打了三个词却发现值错，和打了两个词，需要看到的下一步不一样。
 * 值不做大小写宽容：`HIGH` 直接判非法，因为审批提案里的值要逐字可比。
 */
export function parseSetPriority(rawInput: string | undefined): SetPriorityParse {
  const raw = (rawInput ?? '').trim()
  const rest = raw.startsWith('/') ? raw.slice(raw.indexOf(' ') + 1) : raw
  const parts = rest.trim() === '' ? [] : rest.trim().split(/\s+/u)
  if (parts.length !== 2) return { ok: false, problem: 'usage' }
  const [taskId, priority] = parts
  if (priority !== 'high' && priority !== 'normal' && priority !== 'low') return { ok: false, problem: 'value' }
  return { ok: true, taskId, priority }
}
