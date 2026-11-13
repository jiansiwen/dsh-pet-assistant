/**
 * 客户端插件：左侧导航「个人助理」+ 工作台面板 + 会话头「绑定会话」。
 *
 * 这一页的形态是**工作台**，不是入口页：顶部一行状态、四格概览、七个横向 tab 各自给出
 * 真正的列表或配置。三条贯穿全文件的规矩：
 *
 * 1. **拿不到就说拿不到**：区分「还没有待办」（连上了、确实没有）与「暂时读不到待办」
 *    （压根没拿到）。混成一句会让用户以为事情做完了，或者反过来以为系统坏了。
 * 2. **不编数字**：列表命令没就绪时，tab 里是空态 + 一个真能用的「在桌面宠物里打开」，
 *    不是一张假表格，也不是点了没反应的死按钮。
 * 3. **所有动作走已有命令**（`/summon-pet`、`/bind-pet`、`/assistant-on|off`、
 *    `/open-workbench <page>`），不另建通信、不新增 IPC。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  TOKENS, badge, configBlock, dockButton, dot, header, page, primaryButton, result as resultStyle,
  secondaryButton, smallButton, statGrid, statLabel, statNote, statTile, statValue, statValueSmall,
  statusBar, statusRow, subtitle, summaryRow, tabBar, tabButton, tabPanel, tableEmpty,
  tableHeadRow, tableHint, tableRow, tableWrap, title, titleRow,
} from './styles.ts'
import { overviewValue, type OverviewCommand, type OverviewReadout } from './overview.ts'
import {
  LIST_TABS, MEETING_HISTORY, MEETING_HISTORY_COMMAND, PRIORITY_CHOICES, SETTINGS_SUMMARY_COMMAND, TABS,
  columnClassName, columnTone, narrowTableCss, parseList, parseSettingsSummary, priorityCommand,
  priorityOutcome, reconcilePending, rowTaskId, tableView,
  type ListParse, type ListRow, type ListTabDefinition, type ListTabId, type SettingsParse, type TabId,
} from './tabs.ts'
import {
  EMPTY_SNAPSHOT, MAIL_FIELDS, SETTINGS_OPTIONS, WECOM_FIELDS, buildCommandLine, fieldPlaceholder,
  initialFormValues, looksLikeUnknownCommand, optionCommand, optionValuesOf, parseMailSnapshot,
  parseWecomSnapshot, setOptionFailure, validateMail, validateWecom,
  type ConfigSnapshot, type FieldDefinition, type FormErrors, type FormValues, type OptionKey,
} from './config-forms.ts'

const PANEL_ID = 'personal-assistant'

interface ClientContext {
  slots: {
    inject(name: string, callback: () => () => void): unknown
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  uiSession?: { current?: { getSnapshot(): { key?: string } | undefined } }
  remote?: {
    commands?: {
      execute(sessionId: string, line: string, attachments?: unknown[]): Promise<{
        ok: boolean
        value?: { result?: { kind?: string; text?: string } }
        error?: { message?: string }
      }>
    }
  }
}

/**
 * cordis 服务依赖（服务名，不是包名）：
 * slots 提供插槽，uiSession 提供当前会话，remote.commands 执行宿主命令。
 * 包级加载顺序由 package.json 的 dsh.client.inject 负责。
 */
export const inject = ['slots', 'uiSession', 'remote', 'remote.commands']

/** 插件已注册的命令（`src/index.ts`）。表是"能不能做成按钮"的唯一依据。 */
export const KNOWN_COMMANDS = ['summon-pet', 'bind-pet', 'assistant-on', 'assistant-off', 'open-workbench'] as const

/** 概览三条只读命令。`text` 原样显示，不在前端算数。 */
const OVERVIEW_COMMANDS: Record<OverviewCommand, string> = {
  todo: '/assistant-todo-count',
  meeting: '/assistant-meeting-today',
  summary: '/assistant-today-summary',
}

type IconName = 'paw' | 'checklist' | 'calendar' | 'clock' | 'document' | 'team' | 'link' | 'mail' | 'settings'

/** 16px 线性图标，`stroke-width 1.6`。全部内联，不引图标库。 */
function Icon({ name }: { name: IconName }) {
  const common = {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
  }
  switch (name) {
    case 'paw':
      return <svg {...common}><circle cx="7" cy="9" r="1.6" /><circle cx="12" cy="7" r="1.6" /><circle cx="17" cy="9" r="1.6" /><path d="M6.5 15.5c0-2 2.5-3.5 5.5-3.5s5.5 1.5 5.5 3.5S15 19 12 19s-5.5-1.5-5.5-3.5Z" /></svg>
    case 'checklist':
      return <svg {...common}><path d="M4 7h2m0 0L5 8.5M6 7 4.6 8.6" /><path d="M11 7h9" /><path d="M4 15h2m0 0-1.4 1.6M6 15l-1.4 1.6" /><path d="M11 15h9" /></svg>
    case 'calendar':
      return <svg {...common}><rect x="4" y="5.5" width="16" height="14" rx="2.5" /><path d="M8 3.5v4M16 3.5v4M4 10h16" /></svg>
    case 'clock':
      return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 1.8" /></svg>
    case 'document':
      return <svg {...common}><path d="M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" /><path d="M14 3.5V8h4" /><path d="M9 13h6M9 16.5h4" /></svg>
    case 'team':
      return <svg {...common}><circle cx="9" cy="9" r="3" /><path d="M3.5 19c0-2.5 2.5-4.5 5.5-4.5s5.5 2 5.5 4.5" /><path d="M16 6.5a3 3 0 0 1 0 5.6M17.5 14.8c1.8.6 3 2.1 3 4.2" /></svg>
    case 'link':
      return <svg {...common}><path d="M10 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7L11 6.8" /><path d="M14 10.5a4 4 0 0 0-5.7 0L6 12.8a4 4 0 0 0 5.7 5.7l1.3-1.3" /></svg>
    case 'mail':
      return <svg {...common}><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="m4.5 7.5 7.5 5.5 7.5-5.5" /></svg>
    case 'settings':
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.9l1.9 1.1M17.2 15l1.9 1.1M4.9 16.1l1.9-1.1M17.2 9l1.9-1.1" /></svg>
  }
}

/** 左侧导航图标（原样保留：侧边栏用它认这一项）。 */
function AssistantGlyph({ size = 18, active = false }: { size?: number; active?: boolean }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={active ? 2 : 1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M8.2 8.4V6.2a1.8 1.8 0 0 1 3.6 0v2.2M12.2 8.4V6.2a1.8 1.8 0 0 1 3.6 0v2.2" />
      <path d="M4.6 12.6c0-2.4 1.6-4.2 3.6-4.2h7.6c2 0 3.6 1.8 3.6 4.2 0 3.6-3.3 6-7.4 6s-7.4-2.4-7.4-6Z" />
      <circle cx="9.3" cy="12.2" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="12.2" r="0.9" fill="currentColor" stroke="none" />
      <path d="M10.6 15.4c.9.6 1.9.6 2.8 0" />
    </svg>
  )
}

function currentSessionId(ctx: ClientContext): string | undefined {
  try {
    return ctx.uiSession?.current?.getSnapshot()?.key
  } catch {
    return undefined
  }
}

interface Outcome { ok: boolean; text: string }

async function executeCommand(ctx: ClientContext, line: string): Promise<Outcome> {
  const id = currentSessionId(ctx)
  if (!id) return { ok: false, text: '先在左侧打开或新建一个会话，再点这里' }
  try {
    const response = await ctx.remote?.commands?.execute(id, line, [])
    if (!response) return { ok: false, text: '命令通道还没就绪，稍后再试' }
    if (!response.ok) return { ok: false, text: response.error?.message ?? '命令没能执行' }
    const outcome = response.value?.result
    return { ok: outcome?.kind !== 'error', text: outcome?.text ?? '已执行' }
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 从命令回执里取桥接端口。
 *
 * **这是一处对外契约，别当普通解析改。** 服务端有三条分支的回执带端口：
 * 1. `bind-pet`：`当前会话已绑定到桌面宠物（桥接端口 5233）`
 * 2. `summon-pet` 团队模式：`会话已绑定（桥接端口 5233）；团队模式下…`
 * 3. `summon-pet` 拉起失败：`会话已绑定（桥接端口 5233），但没能拉起桌宠…`
 *
 * 服务端已用严格形状 `桥接端口 \d{2,5}`（一个半角空格）钉住生产端（`tests/user-commands.test.ts`
 * 「回执里的桥接端口形状固定」）；这里用 `\s*` 宽松匹配，是消费端的容错 —— 两边形状同源，
 * 谁改文案都会先在服务端红，而不是让端口在界面上**静默消失**。
 *
 * 取不到就返回 null，调用方显示"会话已绑定"而不带端口（不抛错、不猜一个数字）。
 */
export function parsePort(text: string): number | null {
  const matched = /桥接端口\s*(\d{2,5})/u.exec(text)
  return matched === null ? null : Number(matched[1])
}

/** 会话头部右侧的「绑定会话」：只把当前会话接到桌宠，不负责启动它。 */
function BindSessionButton({ ctx }: { ctx: ClientContext }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [hint, setHint] = useState('')

  const bind = async (): Promise<void> => {
    setState('busy')
    setHint('')
    const outcome = await executeCommand(ctx, '/bind-pet')
    setState(outcome.ok ? 'done' : 'error')
    setHint(outcome.text)
  }

  return (
    <button
      type="button"
      disabled={state === 'busy'}
      title={hint || '把桌面宠物绑定到当前会话'}
      onClick={() => void bind()}
      style={dockButton}
    >
      {state === 'busy' ? '绑定中…' : state === 'done' ? '已绑定' : state === 'error' ? '绑定失败' : '绑定会话'}
    </button>
  )
}

/**
 * 概览四格：前三格各有一条只读命令；「日报草稿」没有命令，保持 `—`。
 * `command` 为 null 的格子不发请求 —— 宁可空着，也不为凑齐四格编一个数字。
 */
const OVERVIEW: ReadonlyArray<{ icon: IconName; label: string; command: OverviewCommand | null }> = [
  { icon: 'checklist', label: '待办', command: 'todo' },
  { icon: 'calendar', label: '今天会议', command: 'meeting' },
  { icon: 'clock', label: '今日活动', command: 'summary' },
  { icon: 'document', label: '日报草稿', command: null },
]

/** 是不是列表类 tab（有表头的四种）。 */
function isListTab(tab: TabId): tab is ListTabId {
  return tab === 'todo' || tab === 'report' || tab === 'meeting' || tab === 'team'
}

/**
 * 会议列表要等桌宠（额度 2s），缓存 30 秒；其余三条是本地读，切进 tab 取一次就够。
 * 缓存只用来省掉"来回切 tab 又等两秒"，不用来掩盖新数据 —— 30 秒后照样重取。
 */
const MEETING_LIST_TTL_MS = 30_000
/** 设置摘要也会等桌宠（2s 额度），同样缓存 30 秒。 */
const SETTINGS_TTL_MS = 30_000
/** 历史会议变化慢（一次会议结束才变一条），缓存 60 秒。 */
const HISTORY_TTL_MS = 60_000

/**
 * 窄屏（<720px）隐藏列：**清单在 `tabs.ts` 的 `NARROW_HIDDEN_COLUMNS` 里**，这里只负责
 * 把生成好的规则塞进 `<style>`。客户端没有样式构建链（esbuild 只打 JS），所以响应式规则
 * 只能内联；类名与渲染层共用 `columnClassName()`，改前缀时两侧一起动。
 */
const NARROW_TABLE_CSS = narrowTableCss()

/** 邮件与企业微信：本轮只有配置区（连接状态 + 说明 + 主按钮），因为它们没有数据源。 */
const CONFIG_TABS: Record<'mail' | 'wecom', { title: string; state: string; detail: string; action: string }> = {
  mail: {
    title: '邮件',
    state: '未连接',
    detail: '审批发信需要的邮箱配置在桌面宠物里。这里将来会显示收发记录与草稿。',
    action: '去桌面宠物配置',
  },
  wecom: {
    title: '企业微信',
    state: '未连接',
    detail: '企业微信连接与已配对会话在桌面宠物里管理。这里将来会显示消息与待处理提醒。',
    action: '去桌面宠物配置',
  },
}

function AssistantPanel({ ctx }: { ctx: ClientContext }) {
  const [busy, setBusy] = useState<null | 'summon' | 'assistant' | 'bind' | 'open'>(null)
  /** 助理模式开关：插件没有查询命令，只能按本页执行过的结果记；null = 还没操作过。 */
  const [assistantOn, setAssistantOn] = useState<boolean | null>(null)
  /** 绑定状态同样只能按回执推断；端口从回执文本里取，取不到就不显示。 */
  const [bound, setBound] = useState<{ bound: boolean; port: number | null }>({ bound: false, port: null })
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [readouts, setReadouts] = useState<Record<OverviewCommand, OverviewReadout> | null>(null)
  const [readingOverview, setReadingOverview] = useState(false)
  const [tab, setTab] = useState<TabId>('todo')
  /** 四个列表 tab 的取数结果；没取过的就是 undefined（= 还没查，不是"没有"）。 */
  const [lists, setLists] = useState<Partial<Record<ListTabId, ListParse>>>({})
  const [listLoading, setListLoading] = useState<Partial<Record<ListTabId, boolean>>>({})
  const listFetchedAt = useRef<Partial<Record<ListTabId, number>>>({})
  /** 设置摘要：三项只读值，命令没回来前不显示任何占位数字。 */
  const [settings, setSettings] = useState<SettingsParse | undefined>(undefined)
  const [settingsLoading, setSettingsLoading] = useState(false)
  /** 三项的当前值（乐观更新：点下去先亮，失败再退回）+ 正在提交的那一项 + 该项错误。 */
  const [optionValues, setOptionValues] = useState<Partial<Record<OptionKey, string>>>({})
  const [optionSaving, setOptionSaving] = useState<OptionKey | null>(null)
  const [optionErrors, setOptionErrors] = useState<Partial<Record<OptionKey, string>>>({})
  const settingsFetchedAt = useRef(0)
  /** 会议 tab 下半段：最近会议（历史）。 */
  const [history, setHistory] = useState<ListParse | undefined>(undefined)
  const [historyLoading, setHistoryLoading] = useState(false)
  const historyFetchedAt = useRef(0)
  /**
   * 待确认的优先级提案：**按 taskId 索引**，跨列表刷新存活、不跨页面刷新。
   *
   * 为什么必须按 taskId 而不是行号/标题：列表按优先级排序，提交后行会换位置；行号是渲染产物，
   * 标题可能重名。只有 taskId 稳定。
   * 已知取舍（不写成"持久化"）：刷新页面就丢。用户提交后一般是立刻去桌宠确认，
   * 中间刷新的窗口很短；真要跨刷新，得服务端在列表里带 pending 标志，这一轮不做。
   */
  const [pendingPriority, setPendingPriority] = useState<Record<string, string>>({})
  /** 正在提交的那一行（禁止连点同一行）。 */
  const [priorityBusy, setPriorityBusy] = useState<string | null>(null)
  /** 表格下面那行反馈：四种结局各有各的说法。 */
  const [priorityNotice, setPriorityNotice] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string } | null>(null)

  const sessionId = currentSessionId(ctx)

  /** 并行取三格；每条独立兜底，一条挂了只让那一格显示「暂时读不到」。 */
  useEffect(() => {
    if (currentSessionId(ctx) === undefined) {
      setReadouts(null)
      setReadingOverview(false)
      return
    }
    let cancelled = false
    setReadingOverview(true)
    const read = async (command: OverviewCommand): Promise<OverviewReadout> => {
      try {
        const result = await executeCommand(ctx, OVERVIEW_COMMANDS[command])
        return overviewValue(command, result.ok ? result.text : '暂时读不到')
      } catch {
        return overviewValue(command, '暂时读不到')
      }
    }
    void Promise.all([read('todo'), read('meeting'), read('summary')]).then(([todo, meeting, summary]) => {
      if (cancelled) return
      setReadouts({ todo, meeting, summary })
      setReadingOverview(false)
    })
    return () => { cancelled = true }
  }, [ctx, sessionId])

  /**
   * 取一张列表（可强制绕过缓存），返回解析结果给调用方自己判断。
   *
   * `force: true` 是给"提交完回读"用的：**必须真重新取一次**，不能等 30 秒缓存过期 ——
   * 否则回读拿到的是提交前的旧快照，"值没变"会把一次成功的直接修改误判成"待确认"。
   */
  const loadList = async (id: ListTabId, options: { force?: boolean } = {}): Promise<ListParse | undefined> => {
    if (sessionId === undefined) return undefined
    const definition = LIST_TABS[id]
    const command = definition.command
    if (command === null) return undefined
    const fetchedAt = listFetchedAt.current[id]
    const ttl = id === 'meeting' ? MEETING_LIST_TTL_MS : 0
    if (options.force !== true && fetchedAt !== undefined && Date.now() - fetchedAt < ttl) {
      return lists[id]
    }
    setListLoading(previous => ({ ...previous, [id]: true }))
    const result = await executeCommand(ctx, command)
    const parsed = parseList(result.ok ? result.text : '暂时读不到', definition)
    listFetchedAt.current[id] = Date.now()
    setLists(previous => ({ ...previous, [id]: parsed }))
    // 每次拿到待办列表，都把"待确认"标记与服务端现状对一遍：用户去桌宠确认之后，
    // **下一次刷新**列表就会变新值，而这一刻没有任何提交动作 —— 不在这里收口，标记会永远挂着。
    if (id === 'todo') setPendingPriority(previous => reconcilePending(previous, parsed.rows))
    setListLoading(previous => ({ ...previous, [id]: false }))
    return parsed
  }

  /** 切进列表 tab 时取一次（缓存规则见 `loadList`）。没有会话就不发命令 —— 表格里显示"未连接"。 */
  useEffect(() => {
    if (!isListTab(tab)) return
    void loadList(tab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, sessionId, tab])

  /**
   * 会议 tab 的历史列表：与「今天」那条**同时发起**（两个 effect 在同一次 commit 里跑，
   * 等价于 Promise.all），各自独立兜底，谁失败都不影响另一个。
   *
   * 命令还没上线时回包会是失败/空——不管哪种，这里都落成「暂时读不到历史会议」+ 按钮，
   * 整块**不隐藏**：隐藏会让用户以为根本没有这个功能。
   */
  useEffect(() => {
    if (tab !== 'meeting') return
    if (sessionId === undefined) return
    if (historyFetchedAt.current !== 0 && Date.now() - historyFetchedAt.current < HISTORY_TTL_MS) return
    let cancelled = false
    setHistoryLoading(true)
    void executeCommand(ctx, MEETING_HISTORY_COMMAND).then((result) => {
      if (cancelled) return
      historyFetchedAt.current = Date.now()
      setHistory(parseList(result.ok ? result.text : '暂时读不到历史会议', MEETING_HISTORY))
      setHistoryLoading(false)
    })
    return () => { cancelled = true }
  }, [ctx, sessionId, tab])

  /**
   * 改一个优先级 —— **提案 + 审批，不是直接改**。
   *
   * 这个功能最容易做错的地方是"看起来成功了"：聊天侧提交只生成一条待确认的改动，
   * 本人在桌面宠物里确认后才真的变。所以三条死规矩：
   * 1. **不乐观更新**：单元格始终显示服务端的值，不先亮成新优先级（那是替服务端撒谎）；
   * 2. **不读叙述，读状态**：提交后一律**强制重新拉列表**（绕过缓存），拿真值来判断这次提交
   *    到底算"已生效"还是"待确认"——回执措辞会变、语义会变，列表不会；
   * 3. **三种结局各有各的话**：已生效 / 待确认（给标记，仍显示旧值）/ 行已消失（清标记 + 让他刷新）。
   */
  const setPriority = async (taskId: string, value: string): Promise<void> => {
    const command = priorityCommand(taskId, value)
    // 拼不出合法命令就直接说，不发半截参数（那样服务端只会回一句用法提示）。
    if (command === null) {
      setPriorityNotice({ tone: 'bad', text: '这一行暂时改不了（任务号不可用）' })
      return
    }
    setPriorityBusy(taskId)
    setPriorityNotice(null)
    try {
      const result = await executeCommand(ctx, command)
      // 成败都回读：失败时也可能已经生成了一条提案，而只有列表能告诉我们真相。
      const parsed = await loadList('todo', { force: true })
      const outcome = parsed === undefined ? 'pending' : priorityOutcome(parsed.rows, taskId, value)

      if (outcome === 'gone') {
        // 任务被删 / 被筛掉了：**标记必须清掉**，否则永远等不到它消失。
        setPendingPriority(previous => removeKey(previous, taskId))
        setPriorityNotice({ tone: 'warn', text: '列表已变化，请刷新' })
        return
      }
      if (!result.ok) {
        // 失败：不改标记、不臆断"提案已生成"，把服务端那句原因原样给人看。
        // 这里**不去掉**「优先级没改成：」这个前缀（与设置页不同）：那行提示在表格下方、
        // 离被点的单元格有距离，前缀正好补上"是哪件事没成"，去掉反而不好读。
        setPendingPriority(previous => removeKey(previous, taskId))
        setPriorityNotice({ tone: 'bad', text: result.text })
        return
      }
      if (outcome === 'applied') {
        setPendingPriority(previous => removeKey(previous, taskId))
        setPriorityNotice({ tone: 'ok', text: result.text })
        return
      }
      // 待确认：记标记（按 taskId，跨刷新存活）；**不显示成新优先级**，文案也不引用回执
      // ——回执此刻会说「已把…设为高」，而那是错的（提案而已）。
      setPendingPriority(previous => ({ ...previous, [taskId]: value }))
      setPriorityNotice({ tone: 'warn', text: '已提交，请在桌面宠物里确认' })
    } finally {
      setPriorityBusy(null)
    }
  }

  /**
   * 改一个设置项。
   *
   * 四条按需求做死：
   * 1. **乐观更新**：先亮选中，再发命令；
   * 2. **失败退回**：把值还原成提交前那个，并把服务端原话显示在这一项下面（不能只说"保存失败"）；
   * 3. **"没改成"也走失败分支**：服务端写失败时回的是 `success` + 一句话（见 `setOptionFailure`），
   *    只认 `ok` 会把"一个字都没写进去"显示成成功；
   * 4. **成功以回读为准**：再拉一次摘要，用服务端说的值覆盖本地 —— 防止"页面显示改成功、其实没写进去"。
   */
  const setOption = async (key: OptionKey, value: string): Promise<void> => {
    const previous = optionValues[key]
    setOptionValues(current => ({ ...current, [key]: value }))
    setOptionErrors(current => ({ ...current, [key]: undefined }))
    setOptionSaving(key)
    try {
      const result = await executeCommand(ctx, optionCommand(key, value))
      // 两条失败路都要认：
      // - 现在：服务端写失败回 `kind: 'error'`（文案仍是「设置没改成：<原因>」）；
      // - 兜底：旧产物/语义回退时失败可能装在 `success` 壳子里，靠 `setOptionFailure` 认出来。
      // 两条都过一遍 `setOptionFailure`，红字里只留**原因**，不重复那句前缀。
      const reason = setOptionFailure(result.text)
      const failure = result.ok ? reason : (reason ?? result.text)
      if (failure !== null) {
        setOptionValues(current => ({ ...current, [key]: previous }))
        setOptionErrors(current => ({ ...current, [key]: failure }))
      }
      // 无论成败都回读一次：失败时它能把"文件里其实是啥"补回来（比如唤醒写了但没起来），
      // 成功时它是准绳。回读失败（暂时读不到）不会覆盖这一项，界面保留上面那个结论。
      const refreshed = await executeCommand(ctx, SETTINGS_SUMMARY_COMMAND)
      if (refreshed.ok) {
        const parsed = parseSettingsSummary(refreshed.text)
        setSettings(parsed)
        if (parsed.state === 'rows') setOptionValues(optionValuesOf(parsed.rows))
      }
      settingsFetchedAt.current = Date.now()
    } finally {
      setOptionSaving(null)
    }
  }

  /** 设置 tab：切进来取一次，缓存 30 秒（这条也要等桌宠）。 */
  useEffect(() => {
    if (tab !== 'settings') return
    if (sessionId === undefined) return
    if (settingsFetchedAt.current !== 0 && Date.now() - settingsFetchedAt.current < SETTINGS_TTL_MS) return
    let cancelled = false
    setSettingsLoading(true)
    void executeCommand(ctx, SETTINGS_SUMMARY_COMMAND).then((result) => {
      if (cancelled) return
      settingsFetchedAt.current = Date.now()
      const parsed = parseSettingsSummary(result.ok ? result.text : '暂时读不到设置')
      setSettings(parsed)
      // 服务端回读是准绳：每次取回都覆盖本地乐观值。
      if (parsed.state === 'rows') setOptionValues(optionValuesOf(parsed.rows))
      setSettingsLoading(false)
    })
    return () => { cancelled = true }
  }, [ctx, sessionId, tab])

  const run = async (kind: 'summon' | 'assistant' | 'bind', line: string): Promise<void> => {
    setBusy(kind)
    try {
      const result = await executeCommand(ctx, line)
      setOutcome(result)
      if (result.ok && (kind === 'summon' || kind === 'bind')) {
        setBound({ bound: true, port: parsePort(result.text) })
      }
      if (kind === 'assistant') setAssistantOn(line === '/assistant-off' ? false : result.ok)
    } finally {
      setBusy(null)
    }
  }

  /**
   * 打开桌面宠物里的某一页。后端对"参数不对 / 桌宠没跑"也返回 success，
   * 所以这里只把原话放回状态行，不染成成功色。
   */
  const openInPet = async (pageName: string): Promise<void> => {
    setBusy('open')
    try {
      const result = await executeCommand(ctx, `/open-workbench ${pageName}`)
      setOutcome(result)
    } finally {
      setBusy(null)
    }
  }

  const connected = sessionId !== undefined && bound.bound
  const dotColor = outcome !== null && !outcome.ok ? TOKENS.amber : connected ? TOKENS.green : TOKENS.grey
  const connectionText = sessionId === undefined
    ? '尚未打开会话'
    : connected
      ? `会话已绑定${bound.port === null ? '' : ` · 桥接端口 ${bound.port}`}`
      : '未绑定'

  return (
    <div style={page}>
      {/* 客户端没有 CSS 构建链，响应式规则只能内联；只作用于 .wb-col-* 单元格。 */}
      <style>{NARROW_TABLE_CSS}</style>
      {/* 标题、说明合成一块：不给它们各配一张卡，顶部只占三行。 */}
      <header style={header}>
        <div style={titleRow}>
          <h2 style={title}>个人助理</h2>
          <span style={badge}>{connected ? '已就绪' : '未连接'}</span>
          <span style={subtitle}>召唤桌面宠物、查看待办与会议、整理日报；所有写操作仍走你本人确认。</span>
        </div>
      </header>

      {/* 连接状态条：一行，高 ≤44px。 */}
      <section style={statusBar} aria-label="连接状态">
        <span style={statusRow}><i style={dot(dotColor)} />{connectionText}</span>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" disabled={busy !== null} onClick={() => void run('summon', '/summon-pet')} style={smallButton}>
            {busy === 'summon' ? '召唤中…' : '召唤宠物'}
          </button>
          <button
            type="button" disabled={busy !== null}
            onClick={() => void run('assistant', assistantOn === true ? '/assistant-off' : '/assistant-on')}
            style={smallButton}
          >
            {busy === 'assistant' ? '处理中…' : assistantOn === true ? '关闭个人助理' : '开启个人助理'}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void run('bind', '/bind-pet')} style={smallButton}>
            {busy === 'bind' ? '绑定中…' : '仅绑定会话'}
          </button>
        </span>
      </section>
      <p style={{ ...resultStyle, marginTop: 6, color: outcome === null ? TOKENS.faint : outcome.ok ? TOKENS.ok : TOKENS.bad }}>
        {outcome === null ? '还没有执行操作' : outcome.text}
      </p>

      {/* 概览：一行四格，矮卡。 */}
      <div style={statGrid}>
        {OVERVIEW.map(item => {
          const readout = item.command === null ? null : readouts?.[item.command] ?? null
          const loadingThis = item.command !== null && readingOverview && readout === null
          const value = item.command === null
            ? '—'
            : loadingThis ? '读取中…' : readout === null ? '未连接' : readout.value
          const note = readout?.kind === 'metric' && readout.detail !== null
            ? readout.detail
            : item.command === null ? '未连接' : null
          const muted = item.command === null || loadingThis || readout === null || readout.kind === 'unavailable'
          return (
            <div key={item.label} style={statTile}>
              <div style={{ ...(readout?.kind === 'metric' ? statValue : statValueSmall), color: muted ? TOKENS.faint : TOKENS.ink }}>
                {value}
              </div>
              <div style={statLabel}>{item.label}</div>
              {note !== null && <div style={statNote}>{note}</div>}
            </div>
          )
        })}
      </div>

      {/* 水平 tab：DSH 左侧已有全局导航，这里再来一条竖导航就重复了。 */}
      <nav style={tabBar} role="tablist" aria-label="工作台页面">
        {TABS.map(item => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            style={tabButton(tab === item.id)}
          >{item.label}</button>
        ))}
      </nav>

      <div style={tabPanel} role="tabpanel">
        {tab === 'mail' ? (
          <ConfigFormPanel
            ctx={ctx}
            title="邮件"
            description="审批发信用的邮箱。填好保存即可，随后审批邮件的发信会用这套配置。"
            fields={MAIL_FIELDS}
            command="assistant-mail-config"
            validate={validateMail}
            passwordKeys={['password']}
            readSnapshot={parseMailSnapshot}
          />
        ) : tab === 'wecom' ? (
          <ConfigFormPanel
            ctx={ctx}
            title="企业微信"
            description="企业微信应用的连接信息。填好保存即可，随后消息推送与审批会用这套配置。"
            fields={WECOM_FIELDS}
            command="assistant-wecom-config"
            validate={validateWecom}
            passwordKeys={['secret']}
            readSnapshot={parseWecomSnapshot}
          />
        ) : tab === 'settings' ? (
          <SettingsPanel
            values={optionValues}
            loading={settingsLoading}
            connected={sessionId !== undefined}
            saving={optionSaving}
            errors={optionErrors}
            onSet={(key, value) => void setOption(key, value)}
          />
        ) : (
          <>
            <ListPanel
              tab={tab}
              result={lists[tab]}
              loading={listLoading[tab] === true}
              connected={sessionId !== undefined}
              busy={busy === 'open'}
              onOpen={pageName => void openInPet(pageName)}
              // 优先级编辑只有待办有；其它 tab 不传，连"能点"的样式都不会出现。
              {...(tab === 'todo'
                ? {
                  priority: {
                    pending: pendingPriority,
                    busyId: priorityBusy,
                    notice: priorityNotice,
                    onPick: (taskId: string, value: string) => void setPriority(taskId, value),
                  },
                }
                : {})}
            />
            {tab === 'meeting' && (
              <MeetingHistoryPanel
                result={history}
                loading={historyLoading}
                connected={sessionId !== undefined}
                busy={busy === 'open'}
                onOpen={pageName => void openInPet(pageName)}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 列宽 → flex 值。
 *
 * 表头里写的是"给人看的宽度"（`132px` 这种），而 flex 简写要的是 `0 0 132px`；
 * 不转换的话 `flex: '132px'` 是非法值，浏览器会忽略，列宽就退化成等分 —— 而这正是
 * 最容易"看起来没错、实际全错"的一类问题。
 */
function columnFlex(width: string | undefined): string {
  if (width === undefined) return '1 1 0'
  return width.endsWith('px') ? `0 0 ${width}` : width
}

/**
 * 从记录里删掉一个键（不可变）。`delete` 在 spread 出来的新对象上用不安全，
 * 单独写一个纯函数，避免每处都写一遍三行。
 */
function removeKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next: Record<string, T> = { ...record }
  delete next[key]
  return next
}

/**
 * 优先级单元格：**能识别这一行（有 taskId）才给交互**，否则退回纯文字。
 *
 * 这道闸是数据决定的，不是开关变量：后端还没在列表里给 taskId 时，`rowTaskId` 恒为 null，
 * 整列自动保持只读 —— 不会出现"点了没反应"的死按钮，也不需要发布时切 flag。
 *
 * 三种视觉状态：
 * - 普通：与状态列同一套配色，底部一条极淡虚线提示可点；
 * - 待确认：值仍是**旧值**（不变），左侧一个 6px 琥珀点 + 文字降到 55% 不透明度，
 *   `title` 说明"已提交，等待在桌面宠物里确认"——标记只表示"有提案在路上"，不冒充新值；
 * - 提交中：50% 不透明度、`cursor: progress`、禁点。
 */
function PriorityCell({ value, pending, busy, onOpen }: {
  value: string
  /** 已提交但未确认的取值（有就显示标记）。 */
  pending: string | undefined
  busy: boolean
  onOpen(): void
}) {
  const tone = columnTone('priority', value) ?? TOKENS.muted
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
      {pending !== undefined && (
        <i title="已提交，等待在桌面宠物里确认" style={dot(TOKENS.amber)} aria-label="待确认" />
      )}
      <button
        type="button"
        aria-haspopup="menu"
        // 待确认时仍可点：允许改主意（同一任务只保留最后一次提交，不叠标记）。
        disabled={busy}
        onClick={onOpen}
        title={pending === undefined ? '点击修改优先级' : '已提交，等待在桌面宠物里确认'}
        style={{
          font: 'inherit',
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: tone,
          cursor: busy ? 'progress' : 'pointer',
          borderBottom: `1px dashed ${TOKENS.line}`,
          opacity: busy ? 0.5 : pending === undefined ? 1 : 0.55,
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >{value}</button>
    </span>
  )
}

/**
 * 表体：表头 + 行 + 三种"没有行"的状态。
 *
 * 抽出来是因为「今天」与「最近会议」两张表只差列定义与文案：共用一份渲染，才不会出现
 * 一张表补 `—`、另一张不补这种漂移。`keyPrefix` 只用于让两张表的列类名互不干扰。
 */
function TableBody({ definition, page, result, loading, connected, busy, onOpen, keyPrefix, rightAlignLast = false, renderCell }: {
  definition: ListTabDefinition
  /** 「在桌面宠物里打开」要跳的那一页（列表 tab 用它自己的 id；历史用 meeting）。 */
  page: string
  result: ListParse | undefined
  loading: boolean
  connected: boolean
  busy: boolean
  onOpen(pageName: string): void
  keyPrefix: string
  rightAlignLast?: boolean
  /** 某一列要自定义渲染时用它（目前只有待办的优先级列）。不传就是纯文字。 */
  renderCell?(info: { row: ListRow; column: ListTabDefinition['columns'][number]; cell: string }): ReactNode
}) {
  const state = result?.state
  const message = loading
    ? tableView('loading', definition).message
    : !connected
      ? '未连接'
      : state === 'empty'
        ? (result?.message ?? definition.empty)
        : (result?.message ?? definition.unavailable)
  return (
    <div style={tableWrap}>
      <div style={tableHeadRow}>
        {definition.columns.map((column, index) => (
          <span
            key={column.key}
            className={columnClassName(keyPrefix, column.key)}
            style={{
              flex: columnFlex(column.width),
              minWidth: 0,
              textAlign: rightAlignLast && index === definition.columns.length - 1 ? 'right' : 'left',
            }}
          >{column.label}</span>
        ))}
      </div>
      {state === 'rows' && result !== undefined
        ? result.rows.map((row, rowIndex) => (
          <div key={rowIndex} style={tableRow}>
            {row.cells.map((cell, cellIndex) => {
              const column = definition.columns[cellIndex]
              // 着色查表在 `tabs.ts`（`columnTone`）：undefined = 这列不染色（标题/日期…），
              // null = 这列有配色表但值没命中（`中`/`低`/将来新增的档）→ 落默认灰。
              const tone = columnTone(column?.key, cell)
              return (
                <span
                  key={cellIndex}
                  className={column === undefined ? undefined : columnClassName(keyPrefix, column.key)}
                  style={{
                    flex: columnFlex(column?.width),
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textAlign: rightAlignLast && cellIndex === definition.columns.length - 1 ? 'right' : 'left',
                    ...(tone === undefined ? {} : { color: tone ?? TOKENS.muted }),
                  }}
                  title={cell}
                >{renderCell === undefined || column === undefined ? cell : renderCell({ row, column, cell })}</span>
              )
            })}
          </div>
        ))
        : (
          <div style={tableEmpty}>
            <span>{message}</span>
            {!loading && state !== 'empty' && (
              <button type="button" disabled={busy} onClick={() => onOpen(page)} style={secondaryButton}>
                {busy ? '打开中…' : '在桌面宠物里打开'}
              </button>
            )}
          </div>
        )}
    </div>
  )
}

/**
 * 列表 tab：表头 + 行；没有行时按状态说三句不同的话。
 *
 * - `rows`：真的画表格（服务端保证列数等于表头列数）；
 * - `empty`：连上了、确实没有 —— 一句话；
 * - `unavailable`：没拿到 —— 另一句话，并给一个真能用的「在桌面宠物里打开」。
 *
 * 表格的三条边界都在 `parseList` 里，这里只负责画。
 *
 * **优先级编辑（仅待办）**：点某个值 → 表格正下方出现一条三选条 → 选完提交。
 * 为什么不做"单元格上的浮层菜单"：`tableWrap` 有 `overflow: hidden`（圆角要用），
 * 浮层会被裁掉一半；改成"贴着表格的操作条"既不会被裁，也能放得下标题。
 */
function ListPanel({ tab, result, loading, connected, busy, onOpen, priority }: {
  tab: ListTabId
  result: ListParse | undefined
  loading: boolean
  connected: boolean
  busy: boolean
  onOpen(pageName: string): void
  /** 只对待办传：待确认标记、正在提交的行、四种结局的反馈、提交回调。 */
  priority?: {
    pending: Readonly<Record<string, string>>
    busyId: string | null
    notice: { tone: 'ok' | 'warn' | 'bad'; text: string } | null
    onPick(taskId: string, value: string): void
  }
}) {
  const definition = LIST_TABS[tab]
  /** 正在选哪一行（null = 没打开选择条）。 */
  const [editing, setEditing] = useState<{ taskId: string; title: string; value: string } | null>(null)

  const renderCell = priority === undefined || tab !== 'todo'
    ? undefined
    : ({ row, column, cell }: { row: ListRow; column: ListTabDefinition['columns'][number]; cell: string }) => {
      if (column.key !== 'priority') return cell
      const taskId = rowTaskId(row)
      // 没有 taskId = 这一行无法标识 → 退回纯文字。整列会因此自动只读，直到后端把 id 加进列表。
      if (taskId === null) return cell
      return (
        <PriorityCell
          value={cell}
          pending={priority.pending[taskId]}
          busy={priority.busyId === taskId}
          onOpen={() => setEditing({ taskId, title: row.cells[0]?.trim() ?? taskId, value: cell })}
        />
      )
    }

  return (
    <section aria-label={definition.hint}>
      <TableBody
        definition={definition}
        page={tab}
        result={result}
        loading={loading}
        connected={connected}
        busy={busy}
        onOpen={onOpen}
        keyPrefix={tab}
        renderCell={renderCell}
      />
      {priority !== undefined && editing !== null && (
        <div
          role="menu"
          aria-label={`修改「${editing.title}」的优先级`}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8,
            padding: '8px 12px', border: `1px solid ${TOKENS.line}`, borderRadius: 10, background: TOKENS.soft,
          }}
        >
          <span style={{ fontSize: 12, color: TOKENS.muted }}>
            把「{editing.title}」改成（当前 {editing.value}）：
          </span>
          {PRIORITY_CHOICES.map(choice => (
            <button
              key={choice.value}
              type="button"
              role="menuitem"
              disabled={priority.busyId !== null}
              onClick={() => { const picked = editing; setEditing(null); priority.onPick(picked.taskId, choice.value) }}
              style={choice.label === editing.value ? { ...smallButton, fontWeight: 600 } : smallButton}
            >{choice.label}</button>
          ))}
          <button type="button" onClick={() => setEditing(null)} style={secondaryButton}>取消</button>
          <span style={{ ...tableHint, flexBasis: '100%' }}>
            这条走审批：提交后需要你在桌面宠物里确认，列表才会变。
          </span>
        </div>
      )}
      {priority !== undefined && priority.notice !== null && (
        <p
          role="status"
          style={{
            margin: '8px 0 0',
            fontSize: 12,
            color: priority.notice.tone === 'ok'
              ? TOKENS.ok
              : priority.notice.tone === 'bad' ? TOKENS.bad : TOKENS.amber,
          }}
        >{priority.notice.text}</p>
      )}
      <p style={{ ...tableHint, marginTop: 8 }}>{definition.hint}</p>
    </section>
  )
}

/**
 * 会议 tab 下半段「最近会议」：五列表，最多 20 条。
 *
 * 与「今天」共用 `TableBody`，差别只有三点：列定义、右对齐最后一列（状态）、
 * 以及窄屏时隐藏「来源 / 保留期」（靠类名 + 内联 `<style>` 的媒体查询，不横向滚动）。
 */
function MeetingHistoryPanel({ result, loading, connected, busy, onOpen }: {
  result: ListParse | undefined
  loading: boolean
  connected: boolean
  busy: boolean
  onOpen(pageName: string): void
}) {
  return (
    <section aria-label="最近会议" style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '0 0 8px' }}>
        <strong style={{ fontSize: 13 }}>最近会议</strong>
        <span style={tableHint}>最多显示 20 条</span>
      </div>
      <TableBody
        definition={MEETING_HISTORY}
        page="meeting"
        result={result}
        loading={loading}
        connected={connected}
        busy={busy}
        onOpen={onOpen}
        keyPrefix="history"
        rightAlignLast
      />
    </section>
  )
}

/**
 * 设置三项：**可点的分段按钮**，点击即提交。
 *
 * 为什么不再显示"在桌面宠物里修改"：桌面宠物只是壳，配置必须在工作台里改得动。
 * 交互按三条守：乐观更新（先亮选中）、提交中只禁该项、成功后以服务端回读为准。
 */
function SettingsPanel({ values, loading, connected, saving, errors, onSet }: {
  values: Partial<Record<OptionKey, string>>
  loading: boolean
  connected: boolean
  saving: OptionKey | null
  errors: Partial<Record<OptionKey, string>>
  onSet(key: OptionKey, value: string): void
}) {
  const unavailable = loading ? '读取中…' : !connected ? '未连接' : null
  return (
    <section aria-label="通用设置">
      <div style={tableWrap}>
        {unavailable !== null && (
          <div style={tableEmpty}><span>{unavailable}</span></div>
        )}
        {SETTINGS_OPTIONS.map(definition => {
          const selected = values[definition.key]
          const busy = saving === definition.key
          return (
            <div key={definition.key} style={{ ...summaryRow, alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ minWidth: 72 }}>{definition.label}</span>
              <span role="group" aria-label={definition.label} style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                {definition.choices.map(choice => {
                  const active = selected === choice.value
                  return (
                    <button
                      key={choice.value}
                      type="button"
                      aria-pressed={active}
                      disabled={busy}
                      onClick={() => onSet(definition.key, choice.value)}
                      style={{
                        ...smallButton,
                        // 选中态用品牌色描边 + 极浅底：与设置页的选中语言一致，不引入新控件。
                        ...(active ? { borderColor: 'rgba(74,125,255,.55)', background: 'rgba(74,125,255,.08)', color: TOKENS.primary } : {}),
                        opacity: busy ? 0.6 : 1,
                        cursor: busy ? 'progress' : 'pointer',
                      }}
                    >{busy && active ? '保存中…' : choice.label}</button>
                  )
                })}
                {selected === undefined && <span style={tableHint}>未知（服务端没给这一项）</span>}
              </span>
              {errors[definition.key] !== undefined && (
                <span style={{ color: TOKENS.bad, fontSize: 12, flexBasis: '100%' }} role="alert">{errors[definition.key]}</span>
              )}
            </div>
          )
        })}
      </div>
      <p style={{ ...tableHint, marginTop: 8 }}>改完立即生效；失败会显示具体原因，并退回原来的选择。</p>
    </section>
  )
}

/**
 * 表单头上那行状态：四种事实，四句话，绝不含糊成一句。
 *
 * - `读取中…`：还没读完，不要提前说"未配置"（用户可能马上就看到真值）；
 * - `已配置`：拿到真值了；
 * - `未配置`：**确实没有**，不是失败；
 * - `暂时读不到`：**没拿到**。这句话必须存在，否则用户会以为配置丢了、重填一遍，
 *   把本来好的配置覆盖掉——这是这块最贵的一种误操作。
 *
 * 颜色也跟着事实走：只有"读不到"用琥珀（提醒但不算错），其余落灰。
 */
function configStatusText(snapshot: ConfigSnapshot | null, reading: boolean): { text: string; tone: string } {
  if (reading || snapshot === null) return { text: '读取中…', tone: TOKENS.grey }
  if (snapshot.unavailable) return { text: '暂时读不到当前配置，可以直接填写保存', tone: TOKENS.amber }
  if (snapshot.configured) return { text: '已配置', tone: TOKENS.green }
  return { text: '未配置', tone: TOKENS.grey }
}

/**
 * 邮件 / 企业微信的**可写表单**（读写都有）。
 *
 * 四条硬要求都落在这里：
 * - **进 tab 先读回**：发无参命令（无参=读），非密码字段回填真值；
 * - **密码 / Secret 永远不回填**，只换占位符：存过 → 「已保存，留空表示不修改」，
 *   没存过 → 必填提示（这与服务端"留空=保持原值"的语义一一对应）；
 * - 校验不过就地提示，**不发命令**（半截配置写进去比不写更糟）；
 * - 失败必须看得见：命令不存在时说"接口还没就绪"，其它错误原样显示服务端那句话。
 *
 * 四种状态各自说不同的话（见 `configStatusText`）：读取中 / 已配置 / 未配置 / 读不到。
 * 其中「读不到」**不能**说成"未配置"——前者是没拿到，后者是确实没有；混成一句会让用户
 * 以为配置丢了、于是重填一遍，把本来好的配置覆盖掉。
 */
function ConfigFormPanel({ ctx, title, description, fields, command, validate, passwordKeys, readSnapshot }: {
  ctx: ClientContext
  title: string
  description: string
  fields: readonly FieldDefinition[]
  command: string
  validate(values: FormValues, stored: { hasSecret: boolean }): FormErrors
  passwordKeys: readonly string[]
  /** 无参命令的回包 → 表单初值（纯函数，在 config-forms.ts 里被测试钉住）。 */
  readSnapshot(text: string): ConfigSnapshot
}) {
  const [values, setValues] = useState<FormValues>({})
  const [errors, setErrors] = useState<FormErrors>({})
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  /** 读回状态：null = 还没读完（读取中）。 */
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null)
  const [reading, setReading] = useState(true)
  const readOnce = useRef(false)

  /**
   * 读回当前配置。**只发无参命令**（服务端约定：无参=读，纯读、零写操作、不回显凭据）。
   *
   * 读失败时表单保持空、`notice` 也不写错误：这不是用户做错了什么，只是一次读没成。
   * 用户仍然可以直接填好保存 —— 所以底下会给一句"可以直接填写保存"，而不是一块红。
   */
  const load = async (): Promise<void> => {
    setReading(true)
    const result = await executeCommand(ctx, `/${command}`)
    const next = result.ok ? readSnapshot(result.text) : { unavailable: true, configured: false, values: {}, hasSecret: false }
    setSnapshot(next)
    setReading(false)
    if (next.unavailable) return
    // 回填只在第一次做，避免以后刷新把用户正在输的内容冲掉。
    if (readOnce.current) return
    readOnce.current = true
    setValues(initialFormValues(fields, next))
  }

  useEffect(() => {
    void load()
    // 只在挂载时读一次：切 tab 会重新挂载，正好是"进 tab 读一次"。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stored = { hasSecret: snapshot?.hasSecret === true }

  const submit = async (): Promise<void> => {
    const found = validate(values, stored)
    setErrors(found)
    if (Object.keys(found).length > 0) {
      // 校验不过：本地就地提示，一个命令都不发。
      setNotice({ ok: false, text: '有几项还不合法，先按提示改好再保存' })
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      const result = await executeCommand(ctx, buildCommandLine(command, values, fields.map(field => field.key)))
      if (!result.ok) {
        setNotice({
          ok: false,
          text: looksLikeUnknownCommand(result.text) ? `${title}配置接口还没就绪：${result.text}` : result.text,
        })
        return
      }
      // 成功：密码类字段清空，避免"看起来能在页面上读回密码"。
      const cleared: Record<string, string> = { ...values }
      for (const key of passwordKeys) delete cleared[key]
      setValues(cleared)
      // 存过凭据了 → 占位符改口（"留空表示不修改"），否则下次改端口又会被要求重填。
      setSnapshot(previous => (previous === null || previous.unavailable
        ? { unavailable: false, configured: true, values: previous?.values ?? {}, hasSecret: true }
        : { ...previous, configured: true, hasSecret: true }))
      setNotice({ ok: true, text: '已保存' })
    } finally {
      setSaving(false)
    }
  }

  const status = configStatusText(snapshot, reading)
  return (
    <section style={configBlock} aria-label={title}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <i style={dot(status.tone)} />
        <strong style={{ fontSize: 14 }}>{title}</strong>
        <span style={{ ...tableHint, marginLeft: 'auto' }}>{status.text}</span>
      </div>
      <p style={{ ...tableHint, margin: 0 }}>{description}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {fields.map(field => (
          <label key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5 }}>
            <span style={{ color: TOKENS.muted }}>{field.label}</span>
            <input
              type={field.type}
              value={values[field.key] ?? ''}
              // 密码类字段的值永远来自用户输入；占位符只说"存过没有"，不回显任何内容。
              placeholder={fieldPlaceholder(field, snapshot ?? EMPTY_SNAPSHOT)}
              style={{ width: field.width ?? '100%', boxSizing: 'border-box' }}
              onChange={event => {
                // 边输边清掉这一项的旧错误：报错留在屏幕上会让人以为改错了。
                setValues(previous => ({ ...previous, [field.key]: event.target.value }))
                setErrors(previous => {
                  if (previous[field.key] === undefined) return previous
                  const next = { ...previous }
                  delete next[field.key]
                  return next
                })
              }}
            />
            {errors[field.key] !== undefined && (
              <span style={{ color: TOKENS.bad, fontSize: 12 }} role="alert">{errors[field.key]}</span>
            )}
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
        <button type="button" disabled={saving} onClick={() => void submit()} style={primaryButton}>
          {saving ? '保存中…' : '保存'}
        </button>
        {notice !== null && (
          <span role="status" style={{ fontSize: 12, color: notice.ok ? TOKENS.ok : TOKENS.bad }}>{notice.text}</span>
        )}
      </div>
    </section>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: '个人助理',
  }, AssistantGlyph))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, () => <AssistantPanel ctx={ctx} />))

  // 会话头部右侧的绑定入口：比输入框 dock 更靠近会话标题，且不占输入区空间。
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'bind-session',
    order: 20,
  }, () => <BindSessionButton ctx={ctx} />))
}
