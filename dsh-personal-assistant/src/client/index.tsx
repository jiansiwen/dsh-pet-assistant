/**
 * 客户端插件：左侧导航「个人助理」+ 工作台面板 + 会话头「绑定会话」。
 *
 * 工作台和设置各有分类和可搜索的功能表；真实列表与配置在详情弹窗中打开。
 * 三条贯穿全文件的规矩：
 *
 * 1. **拿不到就说拿不到**：区分「还没有待办」（连上了、确实没有）与「暂时读不到待办」
 *    （压根没拿到）。混成一句会让用户以为事情做完了，或者反过来以为系统坏了。
 * 2. **不编数字**：列表命令没就绪时，详情里给出提示和「在桌面宠物里打开」，
 *    不是一张假表格，也不是点了没反应的死按钮。
 * 3. **所有动作走已有命令**（`/summon-pet`、`/bind-pet`、`/assistant-on|off`、
 *    `/open-workbench <page>`），不另建通信、不新增 IPC。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  TOKENS, badge, configBlock, dockButton, dot, header, page, primaryButton, result as resultStyle,
  secondaryButton, smallButton, statGrid, statLabel, statNote, statTile, statValue, statValueSmall,
  statusBar, statusRow, subtitle, summaryRow, tableEmpty,
  tableHeadRow, tableHint, tableRow, tableWrap, title, workbenchCss,
} from './styles.ts'
import { overviewValue, type OverviewCommand, type OverviewReadout } from './overview.ts'
import {
  LIST_TABS, MEETING_HISTORY, MEETING_HISTORY_COMMAND, PRIORITY_CHOICES, SETTINGS_SUMMARY_COMMAND, TABS,
  columnClassName, columnTone, narrowTableCss, parseList, parseSettingsSummary, priorityCommand,
  priorityOutcome, reconcilePending, rowMeetingId, rowTaskId, tableView, workbenchEntries,
  type ListParse, type ListRow, type ListTabDefinition, type ListTabId, type SettingsParse, type TabDefinition, type TabId, type WorkbenchSection,
} from './tabs.ts'
import {
  EMPTY_SNAPSHOT, MAIL_FIELDS, SETTINGS_OPTIONS, WECOM_FIELDS, buildCommandLine, fieldPlaceholder,
  initialFormValues, looksLikeUnknownCommand, optionCommand, optionValuesOf, parseMailSnapshot,
  parseWecomSnapshot, setOptionFailure, validateMail, validateWecom,
  type ConfigSnapshot, type FieldDefinition, type FormErrors, type FormValues, type OptionKey,
} from './config-forms.ts'
import {
  parseAssistantState, parsePetConfig, petSetCommand,
  type AssistantStateView, type PetCharacterView, type PetConfigSnapshot,
} from './pet-config.ts'
import { ORIGIN_LABEL, STATUS_LABEL, parseSkills, type SkillsSnapshot } from './skills-view.ts'

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
export const KNOWN_COMMANDS = [
  'summon-pet', 'bind-pet', 'assistant-on', 'assistant-off', 'assistant-state', 'open-workbench',
  'assistant-pet-config', 'assistant-pet-set',
] as const

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

/** 只显示有真实数据源的概览，不保留长期显示未连接的日报占位卡。 */
const OVERVIEW: ReadonlyArray<{ icon: IconName; label: string; command: OverviewCommand }> = [
  { icon: 'checklist', label: '待办', command: 'todo' },
  { icon: 'calendar', label: '今天会议', command: 'meeting' },
  { icon: 'clock', label: '今日活动', command: 'summary' },
]

/** 是不是列表类 tab（有表头的四种）。 */
function isListTab(tab: TabId | null): tab is ListTabId {
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

const SECTION_LABEL: Record<WorkbenchSection, string> = { workbench: '工作台', settings: '设置' }
const TAB_ICONS: Record<TabId, IconName> = {
  todo: 'checklist', report: 'document', meeting: 'calendar', team: 'team', skills: 'checklist',
  pet: 'paw', mail: 'mail', wecom: 'link', settings: 'settings',
}

/** 真正的详情弹窗：原生模态保持键盘焦点，关闭后返回原筛选和打开按钮。 */
function WorkbenchDetail({ item, onClose, children }: { item: TabDefinition; onClose(): void; children?: ReactNode }) {
  const ref = useRef<HTMLDialogElement | null>(null)
  useEffect(() => {
    const node = ref.current
    if (node && !node.open) node.showModal()
  }, [])
  return (
    <dialog ref={ref} className="pa-detail" aria-labelledby="pa-detail-heading" onClose={onClose}>
      <header className="pa-detail-head">
        <div>
          <p>个人助理 ／ {SECTION_LABEL[item.section]}</p>
          <h3 id="pa-detail-heading">{item.label}</h3>
        </div>
        <button type="button" className="pa-detail-close" aria-label="关闭详情" onClick={() => ref.current?.close()}>关闭</button>
      </header>
      <div className="pa-detail-body">{children}</div>
    </dialog>
  )
}

function AssistantPanel({ ctx }: { ctx: ClientContext }) {
  const [busy, setBusy] = useState<null | 'summon' | 'assistant' | 'bind' | 'open'>(null)
  /** 工具注入与采集的真实状态：`/assistant-state` 是唯一真源，不按本页点过什么猜。 */
  const [power, setPower] = useState<AssistantStateView | null>(null)
  /** 召唤成功后让「宠物」tab 自动重读：桌宠刚起来时那一页还停在"读不到"。 */
  const [petReload, setPetReload] = useState(0)
  /** 绑定状态同样只能按回执推断；端口从回执文本里取，取不到就不显示。 */
  const [bound, setBound] = useState<{ bound: boolean; port: number | null }>({ bound: false, port: null })
  const [outcome, setOutcome] = useState<(Outcome & { tab: TabId | null }) | null>(null)
  const [readouts, setReadouts] = useState<Record<OverviewCommand, OverviewReadout> | null>(null)
  const [readingOverview, setReadingOverview] = useState(false)
  const [section, setSection] = useState<WorkbenchSection>('workbench')
  const [category, setCategory] = useState<TabId | undefined>(undefined)
  const [search, setSearch] = useState('')
  /** 只有打开详情才取相应列表或配置；总览不批量读取频道和凭据设置。 */
  const [tab, setTab] = useState<TabId | null>(null)
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
  /** 行内改删：正在编辑哪条待办 / 哪场会议；null = 没打开编辑条。 */
  const [taskEdit, setTaskEdit] = useState<{ taskId: string; title: string } | null>(null)
  const [meetingEdit, setMeetingEdit] = useState<{ meetingId: string; name: string } | null>(null)
  const [editNotice, setEditNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [editBusy, setEditBusy] = useState<string | null>(null)

  const sessionId = currentSessionId(ctx)

  /** 回读开关与采集状态。读不到就保持 unknown —— 不把未知显示成"关闭"。 */
  const refreshPower = async (): Promise<void> => {
    if (currentSessionId(ctx) === undefined) {
      setPower(null)
      return
    }
    const result = await executeCommand(ctx, '/assistant-state')
    setPower(result.ok ? parseAssistantState(result.text) : { injection: 'unknown', capture: 'unknown', blocked: null })
  }

  useEffect(() => {
    void refreshPower()
    // 只在进入页面 / 换会话时回读：开关变化由 run() 自己回读，不做轮询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, sessionId])

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
      setOutcome({ ...result, tab })
      if (result.ok && (kind === 'summon' || kind === 'bind')) {
        setBound({ bound: true, port: parsePort(result.text) })
      }
      if (kind === 'summon' && result.ok) setPetReload(value => value + 1)
      if (kind === 'assistant') void refreshPower()
    } finally {
      setBusy(null)
    }
  }

  /**
   * 后端对「桌宠没跑」也返回 success；直接展示回执，不根据它推断连接状态。
   */
  const openInPet = async (pageName: string): Promise<void> => {
    setBusy('open')
    try {
      const result = await executeCommand(ctx, `/open-workbench ${pageName}`)
      setOutcome({ ...result, tab })
    } finally {
      setBusy(null)
    }
  }

  /**
   * 行内改删的统一提交：发命令 → 显示回执 → 成功则强制回读列表。
   *
   * 回读是准绳：改标题/改期/取消走待批提案，列表此刻**不会**变（要等桌面确认），
   * 回执说"已提交"；会议改删是桌宠本机确认后立即生效，回读就能看到行消失/改名。
   * 两种结局都用同一句服务端回执，不替它编"已改成"。
   */
  const runEdit = async (key: string, line: string, close?: () => void): Promise<void> => {
    setEditBusy(key)
    setEditNotice(null)
    try {
      const result = await executeCommand(ctx, line)
      setEditNotice({ tone: result.ok ? 'ok' : 'bad', text: result.text })
      if (result.ok) {
        if (isListTab(tab)) await loadList(tab, { force: true })
        close?.()
      }
    } finally {
      setEditBusy(null)
    }
  }

  const editNoticeNode = editNotice === null ? null : (
    <p role="status" style={{ margin: '8px 0 0', fontSize: 12, color: editNotice.tone === 'ok' ? TOKENS.ok : TOKENS.bad }}>
      {editNotice.text}
    </p>
  )

  /** 待办行尾操作：修改（开编辑条）/ 删除（提交取消提案）。没拿到 taskId 的行只读。 */
  const todoExtra = {
    label: '操作',
    width: '116px',
    render: (row: ListRow): ReactNode => {
      const id = rowTaskId(row)
      if (id === null) return <span style={tableHint}>—</span>
      return (
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <button type="button" style={smallButton} disabled={editBusy !== null}
            onClick={() => { setTaskEdit({ taskId: id, title: row.cells[0] ?? '' }); setEditNotice(null) }}>修改</button>
          <button type="button" style={smallButton} disabled={editBusy !== null}
            onClick={() => void runEdit(`cancel:${id}`, `/assistant-task-set cancel ${id}`)}>删除</button>
        </span>
      )
    },
  }

  /** 会议行尾操作：重命名（开编辑条）/ 删除（桌宠原生确认后删整场）。没拿到 id 的行只读。 */
  const meetingExtra = {
    label: '操作',
    width: '140px',
    render: (row: ListRow): ReactNode => {
      const id = rowMeetingId(row)
      if (id === null) return <span style={tableHint}>—</span>
      return (
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <button type="button" style={smallButton} disabled={editBusy !== null}
            onClick={() => { setMeetingEdit({ meetingId: id, name: row.cells[1] ?? '' }); setEditNotice(null) }}>重命名</button>
          <button type="button" style={smallButton} disabled={editBusy !== null}
            onClick={() => void runEdit(`meeting-del:${id}`, `/assistant-meeting-set delete ${id}`)}>删除</button>
        </span>
      )
    },
  }

  const todoFooter = (
    <>
      {taskEdit !== null && (
        <TaskEditBar
          edit={taskEdit}
          busy={editBusy !== null}
          onClose={() => setTaskEdit(null)}
          onSubmit={(kind, value) => void runEdit(`${kind}:${taskEdit.taskId}`, `/assistant-task-set ${kind} ${taskEdit.taskId} ${value}`, () => setTaskEdit(null))}
        />
      )}
      {editNoticeNode}
    </>
  )

  const meetingFooter = (
    <>
      {meetingEdit !== null && (
        <MeetingEditBar
          edit={meetingEdit}
          busy={editBusy !== null}
          onClose={() => setMeetingEdit(null)}
          onSubmit={name => void runEdit(`meeting-rename:${meetingEdit.meetingId}`, `/assistant-meeting-set rename ${meetingEdit.meetingId} ${name}`, () => setMeetingEdit(null))}
        />
      )}
      {editNoticeNode}
    </>
  )

  const connected = sessionId !== undefined && bound.bound
  const connectionOutcome = outcome?.tab === null ? outcome : null
  const dotColor = connectionOutcome?.ok === false ? TOKENS.amber : connected ? TOKENS.green : TOKENS.grey
  const injectionOn = power?.injection === 'on'
  const powerText = power === null || power.injection === 'unknown' ? '' : injectionOn ? ' · 助理已开启' : ' · 助理已关闭'
  // 采集与注入是两件事：工具开着但"等采集范围确认"/"被配置拦住"都要如实显示，
  // 否则用户会以为记录已经在跑。
  const captureText = power?.capture === 'recording'
    ? ' · 记录中'
    : power?.capture === 'pending'
      ? ' · 采集待确认'
      : power?.capture === 'blocked' ? ' · 采集被拦' : ''
  const connectionText = sessionId === undefined
    ? '尚未打开会话'
    : connected
      ? `会话已绑定桌宠${powerText}${captureText}`
      : `会话尚未绑定桌宠${powerText}${captureText}`
  const connectionHint = [bound.port === null ? '' : `桥接端口 ${bound.port}`, power?.blocked ?? ''].filter(Boolean).join(' · ')
  const navigation = workbenchEntries(section)
  const entries = workbenchEntries(section, search, category)
  const detail = TABS.find(item => item.id === tab)
  const overviewTitle = section === 'settings' ? '全部设置' : '全部功能'
  const filterTitle = navigation.find(item => item.id === category)?.label ?? overviewTitle
  const selectSection = (next: WorkbenchSection): void => { setSection(next); setCategory(undefined); setSearch('') }

  return (
    <div style={page} data-personal-assistant>
      <style>{workbenchCss + NARROW_TABLE_CSS}</style>
      <header style={header}>
        <h2 style={title}>个人助理</h2>
        <p style={subtitle}>在工作台处理待办和会议，在设置中管理助理与桌宠。需要审批的操作仍由你本人确认。</p>
      </header>

      <section style={statusBar} aria-label="连接状态">
        <span style={statusRow} title={connectionHint || undefined}><i style={dot(dotColor)} />{connectionText}</span>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" disabled={busy !== null} onClick={() => void run('summon', '/summon-pet')}
            style={{ ...smallButton, borderColor: TOKENS.primary, background: TOKENS.primary, color: '#fff' }}>
            {busy === 'summon' ? '召唤中…' : '召唤宠物'}
          </button>
          <button
            type="button" disabled={busy !== null}
            onClick={() => void run('assistant', injectionOn ? '/assistant-off' : '/assistant-on')}
            style={smallButton}
          >
            {busy === 'assistant' ? '处理中…' : injectionOn ? '关闭个人助理' : '开启个人助理'}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void run('bind', '/bind-pet')} style={smallButton}>
            {busy === 'bind' ? '绑定中…' : '仅绑定会话'}
          </button>
        </span>
      </section>
      {connectionOutcome !== null && <p role="status" style={{ ...resultStyle, marginTop: 6, color: connectionOutcome.ok ? TOKENS.ok : TOKENS.bad }}>
        {connectionOutcome.text}
      </p>}

      {section === 'workbench' && <section style={statGrid} aria-label="今日概览">
        {OVERVIEW.map(item => {
          const readout = readouts?.[item.command] ?? null
          const loadingThis = readingOverview && readout === null
          const value = loadingThis ? '读取中…' : readout?.value ?? '尚未读取'
          const note = readout?.kind === 'metric' ? readout.detail : null
          const muted = loadingThis || readout === null || readout.kind === 'unavailable'
          return (
            <div key={item.label} style={statTile}>
              <div style={{ ...statLabel, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name={item.icon} />{item.label}</div>
              <div style={{ ...(readout?.kind === 'metric' ? statValue : statValueSmall), color: muted ? TOKENS.muted : TOKENS.ink }}>
                {value}
              </div>
              {note !== null && <div style={statNote}>{note}</div>}
            </div>
          )
        })}
      </section>}

      <div className="pa-workspace">
        <nav className="pa-rail" aria-label="个人助理分类">
          <div className="pa-modes" role="group" aria-label="切换工作台和设置">
            {(['workbench', 'settings'] as const).map(mode => (
              <button type="button" key={mode} aria-pressed={section === mode} onClick={() => selectSection(mode)}>{SECTION_LABEL[mode]}</button>
            ))}
          </div>
          <div className="pa-categories">
            <button type="button" aria-current={category === undefined ? 'page' : undefined}
              onClick={() => selectSection(section)}>{overviewTitle}</button>
            {navigation.map(item => (
              <button type="button" key={item.id} aria-current={category === item.id ? 'page' : undefined}
                onClick={() => { setCategory(item.id); setSearch('') }}><Icon name={TAB_ICONS[item.id]} />{item.label}</button>
            ))}
          </div>
        </nav>
        <section className="pa-content" aria-labelledby="pa-overview-title">
          <div className="pa-tools">
            <h3 id="pa-overview-title">{filterTitle}</h3>
            <input type="search" className="pa-search" value={search} onChange={event => setSearch(event.target.value)}
              aria-label={section === 'settings' ? '搜索设置' : '搜索工作台功能'} placeholder="按功能名称或说明搜索" />
          </div>
          <div className="pa-table-frame">
            <table className="pa-table" aria-labelledby="pa-overview-title">
              <thead><tr><th scope="col">功能</th><th scope="col">说明</th><th scope="col">详情</th></tr></thead>
              <tbody>{entries.map(item => (
                <tr key={item.id}>
                  <th scope="row">{item.label}</th>
                  <td className="pa-description">{item.description}</td>
                  <td><button className="pa-open-detail" type="button" aria-haspopup="dialog" aria-label={`查看${item.label}详情`}
                    onClick={() => setTab(item.id)}>查看详情</button></td>
                </tr>
              ))}</tbody>
            </table>
            {entries.length === 0 && <p className="pa-empty" role="status">没有找到匹配的功能，换个关键词再试。</p>}
          </div>
        </section>
      </div>

      {detail !== undefined && <WorkbenchDetail item={detail} onClose={() => setTab(null)}>
        {outcome?.tab === detail.id && <p role="status" style={{ ...resultStyle, marginBottom: 8,
          color: outcome.ok ? TOKENS.muted : TOKENS.bad }}>{outcome.text}</p>}
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
        ) : tab === 'skills' ? (
          <SkillsPanel ctx={ctx} connected={sessionId !== undefined} />
        ) : tab === 'pet' ? (
          <PetConfigPanel
            ctx={ctx}
            connected={sessionId !== undefined}
            reloadToken={petReload}
            summoning={busy === 'summon'}
            onSummon={() => void run('summon', '/summon-pet')}
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
        ) : isListTab(tab) ? (
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
                  extra: todoExtra,
                  footer: todoFooter,
                }
                : {})}
              {...(tab === 'meeting' ? { extra: meetingExtra, footer: meetingFooter } : {})}
            />
            {tab === 'meeting' && (
              <MeetingHistoryPanel
                result={history}
                loading={historyLoading}
                connected={sessionId !== undefined}
                busy={busy === 'open'}
                onOpen={pageName => void openInPet(pageName)}
                extra={meetingExtra}
                footer={meetingFooter}
              />
            )}
          </>
        ) : null}
      </WorkbenchDetail>}
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
function TableBody({ definition, page, result, loading, connected, busy, onOpen, keyPrefix, rightAlignLast = false, renderCell, extra }: {
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
  /** 行尾追加的操作列（修改/删除等）。不进 definition.columns，避免改动服务端列契约。 */
  extra?: { label: string; width: string; render(row: ListRow): ReactNode }
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
        {extra !== undefined && (
          <span style={{ flex: columnFlex(extra.width), minWidth: 0 }}>{extra.label}</span>
        )}
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
            {extra !== undefined && (
              <span style={{ flex: columnFlex(extra.width), minWidth: 0 }}>{extra.render(row)}</span>
            )}
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
function ListPanel({ tab, result, loading, connected, busy, onOpen, priority, extra, footer }: {
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
  /** 行尾操作列（修改/删除）。 */
  extra?: { label: string; width: string; render(row: ListRow): ReactNode }
  /** 表格下方的编辑条/反馈（改标题/改期/间隔/重命名）。 */
  footer?: ReactNode
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
        extra={extra}
      />
      {tab === 'team' && (result?.state === 'rows' || result?.state === 'empty') && (
        <button type="button" style={{ ...secondaryButton, marginTop: 10 }} disabled={busy}
          onClick={() => onOpen('team')}>{busy ? '打开中…' : '在桌宠管理助理与角色方案'}</button>
      )}
      {footer}
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
function MeetingHistoryPanel({ result, loading, connected, busy, onOpen, extra, footer }: {
  result: ListParse | undefined
  loading: boolean
  connected: boolean
  busy: boolean
  onOpen(pageName: string): void
  extra?: { label: string; width: string; render(row: ListRow): ReactNode }
  footer?: ReactNode
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
        extra={extra}
      />
      {footer}
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
/** 编辑条外壳：贴着表格下方，不被 tableWrap 的圆角裁掉（与优先级选择条同一套路）。 */
const editBarStyle = {
  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const, marginTop: 8,
  padding: '8px 12px', border: `1px solid ${TOKENS.line}`, borderRadius: 10, background: TOKENS.soft,
}
const editInputStyle = {
  font: 'inherit', fontSize: 12.5, padding: '4px 8px', borderRadius: 8,
  border: `1px solid ${TOKENS.line}`, background: '#fff', color: TOKENS.ink,
}

/**
 * 待办编辑条：改标题 / 改期 / 改催办间隔，三个独立保存按钮。
 *
 * 校验在本地先挡（空标题、越界间隔、没选时间），不发半截命令；
 * 真正的写仍走可信通道，回执原样显示在表格下方。
 */
function TaskEditBar({ edit, busy, onSubmit, onClose }: {
  edit: { taskId: string; title: string }
  busy: boolean
  onSubmit(kind: 'title' | 'deadline' | 'interval', value: string): void
  onClose(): void
}) {
  const [title, setTitle] = useState(edit.title)
  const [deadline, setDeadline] = useState('')
  const [interval, setInterval] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const submit = (kind: 'title' | 'deadline' | 'interval', raw: string): void => {
    if (kind === 'title') {
      const value = raw.trim()
      if (value === '' || value.length > 200) { setProblem('标题需为 1–200 字'); return }
      setProblem(null); onSubmit(kind, value); return
    }
    if (kind === 'deadline') {
      if (raw === '') { setProblem('先选一个时间'); return }
      const ms = new Date(raw).getTime()
      if (!Number.isFinite(ms)) { setProblem('时间不合法'); return }
      setProblem(null); onSubmit(kind, String(ms)); return
    }
    const seconds = Number(raw)
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 604_800) { setProblem('间隔需为 60–604800 秒'); return }
    setProblem(null); onSubmit(kind, String(seconds))
  }

  return (
    <div role="group" aria-label={`修改待办「${edit.title}」`} style={editBarStyle}>
      <span style={{ fontSize: 12, color: TOKENS.muted, flexBasis: '100%' }}>修改「{edit.title}」：</span>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
        标题
        <input style={{ ...editInputStyle, width: 160 }} value={title} disabled={busy} onChange={e => setTitle(e.target.value)} />
      </label>
      <button type="button" style={smallButton} disabled={busy} onClick={() => submit('title', title)}>保存标题</button>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
        到期
        <input type="datetime-local" style={editInputStyle} value={deadline} disabled={busy} onChange={e => setDeadline(e.target.value)} />
      </label>
      <button type="button" style={smallButton} disabled={busy} onClick={() => submit('deadline', deadline)}>保存改期</button>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
        间隔秒
        <input type="number" style={{ ...editInputStyle, width: 90 }} value={interval} disabled={busy} onChange={e => setInterval(e.target.value)} />
      </label>
      <button type="button" style={smallButton} disabled={busy} onClick={() => submit('interval', interval)}>保存间隔</button>
      <button type="button" style={secondaryButton} disabled={busy} onClick={onClose}>关闭</button>
      {problem !== null && <span role="alert" style={{ color: TOKENS.bad, fontSize: 12, flexBasis: '100%' }}>{problem}</span>}
      <span style={{ ...tableHint, flexBasis: '100%' }}>
        改标题/改期提交后需在桌面宠物确认才生效；间隔与删除在桌面弹窗确认。重复提醒改期只换首次时间，不抹掉重复规则。
      </span>
    </div>
  )
}

/** 会议编辑条：只改名字；删除整场在行尾按钮（走桌宠原生确认）。 */
function MeetingEditBar({ edit, busy, onSubmit, onClose }: {
  edit: { meetingId: string; name: string }
  busy: boolean
  onSubmit(name: string): void
  onClose(): void
}) {
  const [name, setName] = useState(edit.name)
  const [problem, setProblem] = useState<string | null>(null)
  const submit = (): void => {
    const value = name.trim()
    if (value === '' || value.length > 200) { setProblem('名称需为 1–200 字'); return }
    setProblem(null); onSubmit(value)
  }
  return (
    <div role="group" aria-label={`重命名会议「${edit.name}」`} style={editBarStyle}>
      <span style={{ fontSize: 12, color: TOKENS.muted }}>重命名「{edit.name}」为：</span>
      <input style={{ ...editInputStyle, width: 200 }} value={name} disabled={busy} onChange={e => setName(e.target.value)} />
      <button type="button" style={smallButton} disabled={busy} onClick={submit}>保存名称</button>
      <button type="button" style={secondaryButton} disabled={busy} onClick={onClose}>关闭</button>
      {problem !== null && <span role="alert" style={{ color: TOKENS.bad, fontSize: 12, flexBasis: '100%' }}>{problem}</span>}
    </div>
  )
}

/**
 * 工作台「技能」tab：自动形成的技能在这里查验，也可人工增删改查。
 *
 * 写操作都走 `/assistant-skill-set`（owner=本人桌面可信路由）；每次写完强制回读，
 * 界面显示服务端真实状态。自动形成来源（auto-*）会标出来，自报来源提示"待查验"。
 */
function SkillsPanel({ ctx, connected }: { ctx: ClientContext; connected: boolean }) {
  const [snap, setSnap] = useState<SkillsSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const [cAssistant, setCAssistant] = useState('')
  const [cName, setCName] = useState('')
  const [cBody, setCBody] = useState('')

  const load = async (): Promise<void> => {
    if (!connected) { setSnap(null); return }
    setLoading(true)
    try {
      const result = await executeCommand(ctx, '/assistant-skills')
      setSnap(parseSkills(result.ok ? result.text : ''))
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [ctx, connected])

  const run = async (key: string, line: string, after?: () => void): Promise<void> => {
    setBusy(key); setNotice(null)
    try {
      const result = await executeCommand(ctx, line)
      setNotice({ ok: result.ok, text: result.text })
      if (result.ok) { await load(); after?.() }
    } finally { setBusy(null) }
  }

  if (!connected) return <div style={tableWrap}><div style={tableEmpty}><span>未连接：先在左侧打开或新建一个会话</span></div></div>
  if (snap === null) return <div style={tableWrap}><div style={tableEmpty}><span>{loading ? '读取中…' : '暂时读不到技能'}</span></div></div>
  if (snap.unavailable) return (
    <div style={tableWrap}><div style={tableEmpty}>
      <span>{snap.message ?? '暂时读不到技能'}</span>
      <button type="button" style={secondaryButton} disabled={loading} onClick={() => void load()}>刷新</button>
    </div></div>
  )

  return (
    <section aria-label="技能">
      <div className="pa-tools">
        <h4>已保存技能 <span style={badge}>{snap.skills.length}</span></h4>
        <span className="pa-sample-actions">
          <button type="button" style={smallButton} disabled={loading || busy !== null} onClick={() => void load()}>刷新</button>
          <button type="button" style={smallButton} disabled={busy !== null} onClick={() => { setCreating(v => !v); setEditing(null) }}>{creating ? '收起新建' : '新建技能'}</button>
        </span>
      </div>
      {notice !== null && <p role="status" style={{ ...resultStyle, marginBottom: 8, color: notice.ok ? TOKENS.ok : TOKENS.bad }}>{notice.text}</p>}

      {creating && (
        <div style={editBarStyle}>
          <input style={{ ...editInputStyle, width: 140 }} placeholder="助理ID（member-…）" value={cAssistant} onChange={e => setCAssistant(e.target.value)} />
          <input style={{ ...editInputStyle, width: 140 }} placeholder="技能名称" value={cName} onChange={e => setCName(e.target.value)} />
          <input style={{ ...editInputStyle, flex: 1, minWidth: 200 }} placeholder="正文：做什么、按什么步骤、注意什么" value={cBody} onChange={e => setCBody(e.target.value)} />
          <button type="button" style={smallButton} disabled={busy !== null || !cAssistant || !cName || !cBody}
            onClick={() => void run('create', `/assistant-skill-set create ${cAssistant} ${cName} ${cBody}`, () => { setCreating(false); setCAssistant(''); setCName(''); setCBody('') })}>保存</button>
        </div>
      )}
      {editing && (
        <div style={editBarStyle}>
          <textarea style={{ ...editInputStyle, flex: 1, minWidth: 240, minHeight: 64 }} value={editing.body} onChange={e => setEditing({ ...editing, body: e.target.value })} />
          <button type="button" style={smallButton} disabled={busy !== null || editing.body.trim() === ''}
            onClick={() => void run(`edit:${editing.id}`, `/assistant-skill-set edit ${editing.id} ${editing.body}`, () => setEditing(null))}>保存修改</button>
          <button type="button" style={secondaryButton} onClick={() => setEditing(null)}>取消</button>
        </div>
      )}

      <div className="pa-table-frame">
        {snap.skills.length === 0 ? <p className="pa-empty">还没有技能，可等待可信样本积累，或手动新建。</p> : (
          <table className="pa-table pa-skill-table" aria-label="已保存技能">
            <thead><tr><th scope="col">技能</th><th scope="col">归属</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
            <tbody>{snap.skills.map(skill => (
              <tr key={skill.id}>
                <th scope="row">
                  <strong>{skill.name}</strong>
                  <p style={{ ...tableHint, color: TOKENS.muted, margin: '3px 0 0', fontWeight: 400, whiteSpace: 'pre-wrap' }}>{skill.body.length > 120 ? `${skill.body.slice(0, 120)}…` : skill.body}</p>
                </th>
                <td>{skill.assistantName}</td>
                <td>
                  <span className="pa-row-state" data-tone={skill.status === 'active' ? 'ok' : undefined}>{STATUS_LABEL[skill.status] ?? skill.status}</span>
                  <div style={{ ...tableHint, color: skill.origin === 'auto-selfreport' ? TOKENS.amber : TOKENS.faint }}>第 {skill.version} 版 · {ORIGIN_LABEL[skill.origin] ?? skill.origin}</div>
                </td>
                <td><div className="pa-sample-actions">
                  <button type="button" style={smallButton} disabled={busy !== null} onClick={() => { setEditing({ id: skill.id, body: skill.body }); setCreating(false) }}>编辑</button>
                  {skill.status !== 'active' && <button type="button" style={smallButton} disabled={busy !== null} onClick={() => void run(`promote:${skill.id}`, `/assistant-skill-set promote ${skill.id}`)}>让它生效</button>}
                  {skill.status === 'active' && <button type="button" style={smallButton} disabled={busy !== null} onClick={() => void run(`retire:${skill.id}`, `/assistant-skill-set retire ${skill.id}`)}>退役</button>}
                  {skill.version > 1 && <button type="button" style={smallButton} disabled={busy !== null} onClick={() => void run(`rollback:${skill.id}`, `/assistant-skill-set rollback ${skill.id} ${skill.version - 1}`)}>回滚上一版</button>}
                  <button type="button" style={smallButton} disabled={busy !== null} onClick={() => void run(`delete:${skill.id}`, `/assistant-skill-set delete ${skill.id}`)}>删除</button>
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>

      {(snap.pending.length > 0 || snap.unverified.length > 0) && (
        <section className="pa-samples" aria-labelledby="pa-samples-heading">
          <h4 id="pa-samples-heading">学习样本 <span style={badge}>{snap.unverified.length} 组待核对</span></h4>
          <div className="pa-table-frame">
            <table className="pa-table" aria-labelledby="pa-samples-heading">
              <thead><tr><th scope="col">工作类型</th><th scope="col">助理</th><th scope="col">样本次数</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
              <tbody>
                {snap.unverified.map(item => (
                  <tr key={`u:${item.assistantId}:${item.shape}`}>
                    <th scope="row">{item.shape}</th><td>{item.assistantName}</td><td>{item.count} 次</td><td>待核对</td>
                    <td><div className="pa-sample-actions">
                      <button type="button" style={smallButton} disabled={busy !== null} onClick={() => void run(`verify:${item.shape}`, `/assistant-skill-set verify ${item.assistantId} ${item.shape}`)}>确认属实</button>
                      <button type="button" style={smallButton} disabled={busy !== null} onClick={() => void run(`retract:${item.shape}`, `/assistant-skill-set retract ${item.assistantId} ${item.shape}`)}>撤回</button>
                    </div></td>
                  </tr>
                ))}
                {snap.pending.map(item => (
                  <tr key={`p:${item.assistantId}:${item.shape}`}>
                    <th scope="row">{item.shape}</th><td>{item.assistantName}</td><td>{item.count} 次</td><td>可信样本已达标</td><td>—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  )
}

/**
 * 工作台「宠物」tab：把右键菜单里能改的外观项（形象 / 随机动作 / 显示 / 上台）搬到页面上。
 *
 * 数据只有一条通道：`/assistant-pet-config` 读、`/assistant-pet-set` 写；写入后**强制回读**，
 * 界面显示的是桌宠真实落盘的值，不是乐观更新猜出来的值。桌宠没跑时如实显示"读不到" +
 * 一个真能用的「召唤宠物」，不画一张假表。
 */
function PetConfigPanel({ ctx, connected, reloadToken, summoning, onSummon }: {
  ctx: ClientContext
  connected: boolean
  /** 外部动作（召唤宠物）成功后递增，触发一次重读。 */
  reloadToken: number
  summoning: boolean
  onSummon(): void
}) {
  const [snapshot, setSnapshot] = useState<PetConfigSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const load = async (): Promise<void> => {
    if (!connected) {
      setSnapshot(null)
      return
    }
    setLoading(true)
    try {
      const result = await executeCommand(ctx, '/assistant-pet-config')
      setSnapshot(parsePetConfig(result.ok ? result.text : '暂时读不到宠物配置'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // 只在进入 tab / 会话变化 / 召唤成功后读一次；刷新有按钮，开关变化由别的 tab 负责。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, connected, reloadToken])

  /**
   * 改一项：先乐观更新、失败退回、成功回读为准。
   * 成功文案用命令回执（桌宠说的"已换好形象"），失败原因也原样显示 —— 不统一改成"保存失败"。
   */
  const mutate = async (
    key: string,
    command: string,
    optimistic: (current: PetConfigSnapshot) => PetConfigSnapshot,
  ): Promise<void> => {
    if (snapshot === null) return
    const before = snapshot
    setSnapshot(optimistic(snapshot))
    setBusy(key)
    setNotice(null)
    try {
      const result = await executeCommand(ctx, command)
      if (!result.ok) {
        setSnapshot(before)
        setNotice({ ok: false, text: result.text })
        return
      }
      setNotice({ ok: true, text: result.text })
      const refreshed = await executeCommand(ctx, '/assistant-pet-config')
      setSnapshot(parsePetConfig(refreshed.ok ? refreshed.text : '暂时读不到宠物配置'))
    } finally {
      setBusy(null)
    }
  }

  if (!connected) {
    return (
      <div style={tableWrap}>
        <div style={tableEmpty}><span>未连接：先在左侧打开或新建一个会话，再配置宠物</span></div>
      </div>
    )
  }
  if (snapshot === null) {
    return (
      <div style={tableWrap}>
        <div style={tableEmpty}><span>{loading ? '读取中…' : '暂时读不到宠物配置'}</span></div>
      </div>
    )
  }
  if (snapshot.unavailable) {
    return (
      <div style={tableWrap}>
        <div style={tableEmpty}>
          <span>{snapshot.message ?? '暂时读不到宠物配置'}</span>
          <button type="button" disabled={summoning} onClick={onSummon} style={secondaryButton}>
            {summoning ? '召唤中…' : '召唤宠物'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <section aria-label="宠物配置">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={tableHint}>与桌面宠物右键菜单是同一份设置，改完立即生效。</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={smallButton} disabled={loading || busy !== null} onClick={() => void load()}>
            {loading ? '刷新中…' : '刷新'}
          </button>
          <button
            type="button" style={smallButton} disabled={busy !== null}
            onClick={() => void mutate(
              'stage',
              petSetCommand({ kind: 'stage', value: !snapshot.stageVisible }),
              current => ({ ...current, stageVisible: !current.stageVisible }),
            )}
          >
            {snapshot.stageVisible ? '隐藏角色（截图 / 录屏）' : '显示角色'}
          </button>
        </span>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        {snapshot.characters.map(character => {
          const skin = snapshot.skins.find(item => item.id === character.skin) ?? snapshot.skins[0]
          const actions = skin?.actions ?? []
          return (
            <CharacterConfigCard
              key={character.assistantId}
              character={character}
              skins={snapshot.skins}
              actions={actions}
              busy={busy !== null}
              onSkin={value => void mutate(
                `skin:${character.assistantId}`,
                petSetCommand({ kind: 'skin', assistantId: character.assistantId, value }),
                current => ({
                  ...current,
                  characters: current.characters.map(item => item.assistantId === character.assistantId
                    ? { ...item, skin: value } : item),
                }),
              )}
              onActions={value => void mutate(
                `actions:${character.assistantId}`,
                petSetCommand({ kind: 'actions', assistantId: character.assistantId, value }),
                current => ({
                  ...current,
                  characters: current.characters.map(item => item.assistantId === character.assistantId
                    ? { ...item, randomActions: [...value] } : item),
                }),
              )}
              onStep={value => void mutate(
                `step:${character.assistantId}`,
                petSetCommand({ kind: 'step', assistantId: character.assistantId, value }),
                current => ({
                  ...current,
                  characters: current.characters.map(item => item.assistantId === character.assistantId
                    ? { ...item, steppedDown: value === 'down' } : item),
                }),
              )}
            />
          )
        })}
      </div>

      {notice !== null && (
        <p role="status" style={{ margin: '8px 0 0', fontSize: 12, color: notice.ok ? TOKENS.ok : TOKENS.bad }}>
          {notice.text}
        </p>
      )}
      <p style={{ ...tableHint, marginTop: 8 }}>
        随机动作只影响空闲时的自发表演；形象与动作来自桌面宠物当前可用的素材，自定义形象会出现在形象列表里。
      </p>
    </section>
  )
}

/** 单个角色的配置卡：形象下拉 + 随机动作勾选 + 上台/退下。 */
function CharacterConfigCard({ character, skins, actions, busy, onSkin, onActions, onStep }: {
  /** 客户端插件的 React 类型是极简环境，函数组件需要显式声明 key。 */
  key?: string
  character: PetCharacterView
  skins: PetConfigSnapshot['skins']
  actions: PetConfigSnapshot['skins'][number]['actions']
  busy: boolean
  onSkin(value: string): void
  onActions(value: readonly string[]): void
  onStep(value: 'up' | 'down'): void
}) {
  const selectable = skins.some(skin => skin.id === character.skin)
  return (
    <div style={configBlock}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>{character.displayName}</strong>
        {character.chief && <span style={badge}>总助理</span>}
        {character.steppedDown && <span style={badge}>已退下</span>}
        {!character.chief && (
          <button
            type="button" disabled={busy}
            onClick={() => onStep(character.steppedDown ? 'up' : 'down')}
            style={{ ...smallButton, marginLeft: 'auto' }}
          >
            {character.steppedDown ? '请上台' : '让TA退下（不退出宠物）'}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5 }}>
        <span style={{ color: TOKENS.muted, minWidth: 64 }}>形象</span>
        <select
          aria-label={`${character.displayName} 的形象`}
          value={character.skin}
          disabled={busy}
          onChange={event => onSkin(event.target.value)}
          style={{
            font: 'inherit', padding: '4px 8px', borderRadius: 8,
            border: `1px solid ${TOKENS.line}`, background: '#fff', color: TOKENS.ink,
          }}
        >
          {!selectable && <option value={character.skin}>{character.skin}</option>}
          {skins.map(skin => <option key={skin.id} value={skin.id}>{skin.label}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', fontSize: 12.5 }}>
        <span style={{ color: TOKENS.muted, minWidth: 64, lineHeight: '18px' }}>随机动作</span>
        <span style={{ display: 'inline-flex', gap: 12, flexWrap: 'wrap', lineHeight: '18px' }}>
          {actions.length === 0 && <span style={tableHint}>这个形象没有可勾选的动作</span>}
          {actions.map(action => {
            const checked = character.randomActions.includes(action.id)
            return (
              <label key={action.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy}
                  onChange={event => onActions(event.target.checked
                    ? [...character.randomActions, action.id]
                    : character.randomActions.filter(id => id !== action.id))}
                />
                {action.label}
              </label>
            )
          })}
        </span>
      </div>
    </div>
  )
}

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
