/**
 * 近期工作上下文（M2）：把"用户最近在做什么"做成一小段背景注入主提示词。
 *
 * 存在的理由：`personal_assistant_preferences` 只解决"长期规则"，解决不了
 * "继续刚才那个""我今天干了啥"——这两类问题问的是**最近的动作**，不是偏好。
 * 工作事项本来就落在 `work_items` 表里（项目 / 时间范围 / 动作 / 成果 / 来源 / 状态），
 * 这里只负责从里面挑出最近几条，渲染成几行指针。
 *
 * 三条渲染纪律（都有对应的用例钉住）：
 *
 * 1. **只带指针，不带正文。** 每条只给 项目 / 动作 / 成果 / 时间，**不输出** `summary`、
 *    `sources`、`discussionTopic`。原因有两层：一是预算——这段每次装配都进上下文，
 *    正文一多就把当前任务的材料挤掉；二是可信度——`summary` 是模型自己写的概括，
 *    `sources` 是一串 ref，模型看到 ref 会倾向于复述"我查到 xxx 文件"，
 *    而这里要的只是"让模型知道有个事"，细节应该去调工具按需取。
 * 2. **按 `updatedAt` 倒序，不是按 `start` 倒序。** 用户说"继续刚才那个"指的是
 *    **最近被改动的那件事**，不是"开始时间最晚的那件事"。一条上午开始、下午还在更新的
 *    事项，比一条中午开始但立刻结束的事项更可能正是"刚才那个"。`listInRange` 按
 *    `start_at` 升序返回（那是给人看时间线的顺序），所以这里必须自己重排。
 * 3. **排除 `evidence_removed`。** 这个状态的意思是"支撑它的来源被删光了，这条结论
 *    已经没有依据"。把它当背景喂给模型，等于让模型拿一条自己都证不了的事去回答
 *    "我今天干了啥"——说不清出处又听起来很确定，比不说更糟。
 *
 * 纯逻辑：零 React、零 IO、零时钟读取（`now` 由调用方传入），便于确定性测试。
 *
 * TODO(M3)：独立成 section，不寄生在记忆标题下。
 * 现状是为了守住"`personal_assistant_preferences` 变量名不改"这条硬约束：这段内容由
 * `joinSections` 拼在偏好串后面，于是渲染位置落在提示词里「## 已确认的记忆」标题之下。
 * 它自带"只是背景，不是本轮任务"抬头，模型能区隔，但语义上确实错位。真要修，需要单开
 * `{{personal_assistant_work_context}}` 占位符，并同步改 `member-runtime.ts` 的共享
 * section 模板——那是跨模块改动，本期刻意不做。**这是已知项，不是遗漏。**
 */

/** 最多注入几条：再多就变成"把今天的时间线整个贴进提示词"，反而淹没当前任务。 */
export const WORK_CONTEXT_LIMIT = 3

/** 时间窗：24 小时。跨天问"昨天下午那个"够用，又不至于把上周的事当"最近"。 */
export const WORK_CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * 段落抬头。明说"只是背景，不是本轮任务"：否则模型容易把这几条当成用户当前指令，
 * 自作主张去"继续"一件用户根本没提的事，或者把背景当成果汇报出来。
 */
export const WORK_CONTEXT_HEADER = '以下是最近 24 小时的工作事项（只是背景，不是本轮任务）：'

export interface WorkContextOptions {
  /** 当前时刻（毫秒）。由调用方传入，函数内不读时钟，保证可复现。 */
  now: number
  /** 最多几条；缺省 {@link WORK_CONTEXT_LIMIT}。 */
  limit?: number
  /** 时间窗宽度；缺省 {@link WORK_CONTEXT_WINDOW_MS}。 */
  windowMs?: number
}

/**
 * 注入只需要这些字段。刻意不直接用 `WorkItem`：
 * 一是调用方（tools.ts）不该为了渲染四行字而依赖整个事项模型，
 * 二是测试只造得出这几项，测试数据的字段少一点，用例意图就更清楚。
 */
export interface WorkContextItem {
  id: string
  /** 项目名/路径；无项目为 null。 */
  project: string | null
  start: number
  end: number
  /** 做了什么；空白视为无效条目（见 {@link selectWorkContext}）。 */
  action: string
  /** 产出了什么；空串渲染成「（无成果记录）」。 */
  outcome: string
  status: string
  updatedAt: number
}

/** 已被排除的状态：不参与注入，见文件头第 3 条。 */
const EXCLUDED_STATUS = 'evidence_removed'

/**
 * 状态中文映射。
 *
 * 真实枚举是 `direct / user_confirmed / inferred / evidence_removed`（见 work-items.ts），
 * 这里额外认 `confirmed`：早期契约里用过这个名字，留着是为了旧库/旧测试数据不至于渲染成
 * 英文原文。
 */
const STATUS_LABEL: Readonly<Record<string, string>> = {
  confirmed: '已确认',
  user_confirmed: '已确认',
  direct: '直接证据',
  inferred: '推断',
}

const NO_PROJECT = '无项目'
const NO_OUTCOME = '（无成果记录）'

/**
 * 压平成单行：动作/成果是模型或用户写的自由文本，可能带换行。
 * 一条事项在提示词里必须只占一行，否则"最多 3 条"的预算判断就失效了。
 */
function collapse(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** `MM-DD HH:mm`（本地时区）。带日期是因为窗口跨天，只给 `HH:mm` 会分不清昨晚还是今早。 */
function formatStamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 排序：`updatedAt` 倒序 → `start` 倒序 → `id` 升序（最后一级只为确定性，不表达业务含义）。 */
function compareItems(a: WorkContextItem, b: WorkContextItem): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  if (a.start !== b.start) return b.start - a.start
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/**
 * 过滤 + 排序 + 截断，返回真正要注入的条目。
 *
 * 过滤三条：开始时间落在 `[now - windowMs, now]`、状态不是 `evidence_removed`、
 * 动作为非空。**没有动作的事项没法当指针用**——"某项目在某时刻有个条目"什么也说明不了，
 * 模型只会被迫猜，猜出来就是编。
 */
export function selectWorkContext(
  items: readonly WorkContextItem[],
  options: WorkContextOptions,
): WorkContextItem[] {
  const now = Number(options?.now)
  if (!Array.isArray(items) || !Number.isFinite(now)) return []

  const rawLimit = Number(options?.limit)
  const limit = Math.max(0, Math.floor(Number.isFinite(rawLimit) ? rawLimit : WORK_CONTEXT_LIMIT))
  const rawWindow = Number(options?.windowMs)
  const windowMs = Math.max(0, Number.isFinite(rawWindow) ? rawWindow : WORK_CONTEXT_WINDOW_MS)
  if (limit === 0) return []

  const from = now - windowMs
  const picked: WorkContextItem[] = []
  for (const item of items) {
    if (!item) continue
    const start = Number(item.start)
    if (!Number.isFinite(start)) continue
    // 时间窗两端都闭：正好落在 24 小时前那一条仍然算"最近"，正好是此刻也算。
    if (start < from || start > now) continue
    if (item.status === EXCLUDED_STATUS) continue
    if (collapse(item.action) === '') continue
    picked.push(item)
  }

  // filter 已经产出了新数组，就地排序不会改到调用方的入参。
  picked.sort(compareItems)
  return picked.slice(0, limit)
}

/**
 * 渲染注入段落。**没有可注入的事项时返回空串**，调用方据此不追加段落
 * （空段落会让提示词出现连续空行，也会让模型以为"最近什么都没干"）。
 */
export function buildWorkContext(
  items: readonly WorkContextItem[],
  options: WorkContextOptions,
): string {
  const selected = selectWorkContext(items, options)
  if (selected.length === 0) return ''

  const lines = selected.map(item => {
    const project = collapse(item.project)
    const projectLabel = project === '' ? NO_PROJECT : `项目：${project}`
    const outcome = collapse(item.outcome) || NO_OUTCOME
    const label = STATUS_LABEL[item.status] ?? item.status
    return `- [${label}] ${projectLabel} · ${collapse(item.action)} → ${outcome}（${formatStamp(Number(item.start))}）`
  })

  return `${WORK_CONTEXT_HEADER}\n${lines.join('\n')}`
}
