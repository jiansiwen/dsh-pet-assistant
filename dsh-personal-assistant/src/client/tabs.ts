/**
 * 个人助理的功能分组与列表列定义。
 *
 * 为什么单独一个文件：这一页的产品信息量全在这张表里 —— 有哪些 tab、每个 tab 是什么列、
 * 空态与"读不到"分别怎么说。把它写进 `.tsx` 里就只能靠开壳数；放在这里，测试可以逐条钉，
 * 加 tab 或改列也只动一处。
 *
 * 服务端契约（`/assistant-*-list`，见 backend 的 `tests/workbench-lists.test.ts`）：
 * `text` 先按 `\n` 分行、每行再按 ` | `（空格-竖线-空格）分列；空字段是 `—` 而不是空串
 * （空串会少一列、整行错位）。回包**不含 ` | `** 时是一句话：`暂时读不到…` 是降级态，
 * 其余（`还没有待办` 等）是真空态 —— 两者必须说成两句不同的话。
 *
 * 列序、列名、`—` 占位符都由服务端测试钉死：**前端只按 split 取，不重排序**。
 * 唯一的例外是「旧回包换列」这段过渡期（见 `LegacyRowLayout`）：那时前端按**格数**认出
 * 旧格式并搬到新位置，否则中间插列会让状态与到期两格显示 `—` 而别人的值落在自己列上。
 * 想改列序要先改服务端，否则两侧会对"第几列是什么"各记一份，迟早错位。
 *
 * 一条硬规矩：**空态和未连接态必须是两句不同的话**。
 * 「还没有待办」= 连上了、确实没有；「暂时读不到待办」= 压根没拿到。混成一句会让用户
 * 以为事情做完了（或者反过来，以为系统坏了）。
 */

export type TabId = 'todo' | 'mail' | 'wecom' | 'report' | 'meeting' | 'team' | 'skills' | 'pet' | 'settings'
export type WorkbenchSection = 'workbench' | 'settings'

/** 列表类 tab：有表头、有行、有空态/读不到两种空。 */
export type ListTabId = Extract<TabId, 'todo' | 'report' | 'meeting' | 'team'>

export interface TabColumn {
  readonly key: string
  readonly label: string
  /** 列宽（CSS grid / table 用）。不传则由表格均分。 */
  readonly width?: string
}

export interface TabDefinition {
  readonly id: TabId
  readonly label: string
  readonly section: WorkbenchSection
  readonly description: string
}

export const TABS: readonly TabDefinition[] = [
  { id: 'todo', label: '待办提醒', section: 'workbench', description: '查看优先级、到期时间和催办提醒。' },
  { id: 'report', label: '日报周报', section: 'workbench', description: '查看草稿与已发布的工作记录。' },
  { id: 'meeting', label: '会议助手', section: 'workbench', description: '查看今天的会议、历史录音和纪要。' },
  { id: 'team', label: '助理团', section: 'settings', description: '查看成员、角色与使用额度。' },
  { id: 'skills', label: '技能与样本', section: 'settings', description: '查阅技能、调整生效状态，核对或撤回学习样本。' },
  { id: 'pet', label: '宠物外观', section: 'settings', description: '调整角色形象、随机动作和显示。' },
  { id: 'mail', label: '邮件配置', section: 'settings', description: '设置审批发信使用的邮箱。' },
  { id: 'wecom', label: '企业微信', section: 'settings', description: '配置企业微信连接与提醒推送。' },
  { id: 'settings', label: '其他设置', section: 'settings', description: '管理语音唤醒、播报和文档讲解模式。' },
]

export function workbenchEntries(section: WorkbenchSection, query = '', category?: TabId): readonly TabDefinition[] {
  const search = query.trim().toLowerCase()
  return TABS.filter(item => item.section === section && (category === undefined || item.id === category)
    && `${item.label} ${item.description}`.toLowerCase().includes(search))
}

/**
 * 旧回包的列数与「旧第 i 格 → 新第几列」的映射。
 *
 * 为什么需要它，而不是"不够就按尾部补 `—`"：待办这次是**中间插列**
 * （旧：`标题 | 状态 | 到期`；新：`标题 | 优先级 | 来源 | 状态 | 到期`）。
 * 尾部补齐会把「状态」塞进「优先级」列、「到期」塞进「来源」列，同时让真正的「状态」
 * 「到期」两格显示 `—` —— 既错位又丢值，用户读到的是别人的列。
 *
 * 按列数判定是安全的：服务端约定空字段写 `—` 而不是空串，所以 5 列回包**每一行必定 5 格**，
 * 出现 3 格只可能是旧回包。后端上线后这段映射就再也不会命中，删掉它只动一处（连测试）。
 *
 * 为什么不删（虽然两侧看起来总是一起发版）：用户重载插件时不一定重建产物，"新前端 × 旧产物"
 * 这个窗口真实存在，撞上的表现是**数据错位**——列名对得上、值悄悄换了位置，是最难查的那种。
 * 几行代码换掉这个风险划算。**待确认两侧始终同包发布后可删。**
 */
export interface LegacyRowLayout {
  /** 旧回包每行的格数。 */
  readonly from: number
  /** 旧第 i 格应落到新第几列（下标即旧列序，值是新列下标）。 */
  readonly to: readonly number[]
}

export interface ListTabDefinition {
  /** 列表命令。**后端尚未提供时这里是 null**：绝不发一个不存在的命令，也不编数据。 */
  readonly command: string | null
  readonly columns: readonly TabColumn[]
  /**
   * **隐藏尾列数**：回包在这一行末尾多带几格"机器用"的字段（如 `taskId`），**不渲染、不进表头**。
   *
   * 为什么放在列定义上而不是在待办那个分支里写死"第 6 格"：这是同一套模式的复用点 ——
   * 会议历史将来要加"会议 id"（点开看详情）、助理团要加"成员 id"，都长这样。写死一次，
   * 下次还得再改一遍解析层。
   *
   * 这个数字是**声明**（说清"末尾有个什么"），不是截断开关：见 `parseList` —— 多出来的
   * 格子一律进 `trailing`，不丢。丢数据比多留数据危险，而且"恰好第 6 格"这种假设
   * 一旦后端加第二列就错位。
   */
  readonly trailing?: number
  /** 连上了、确实没有。 */
  readonly empty: string
  /** 没拿到（命令未就绪 / 通道不通）。 */
  readonly unavailable: string
  /** 表头右侧的一句话，说明这张表是什么。 */
  readonly hint: string
  /** 旧回包的列布局（只有真的换过列数的 tab 才需要）。 */
  readonly legacy?: LegacyRowLayout
}

export const LIST_TABS: Record<ListTabId, ListTabDefinition> = {
  todo: {
    command: '/assistant-todo-list',
    columns: [
      // 标题自适应（`1 1 0` = 不占基础宽度，吃掉剩余空间）；其余四列定宽，
      // 因为它们是**短枚举**（高/中/低、手动/会议/企业/AI、状态、日期），
      // 让它们跟着内容伸缩只会让整张表在切换数据时左右抖动。
      { key: 'title', label: '标题', width: '1 1 0' },
      { key: 'priority', label: '优先级', width: '72px' },
      { key: 'source', label: '来源', width: '72px' },
      { key: 'status', label: '状态', width: '96px' },
      // 128px：服务端 `stampOf()` 输出 `2026-01-03 08:00`，16 个半角字符，13px 下约 115px。
      // 112px 会截断（只剩 3px 余量），128px 留 ~13px。
      // 为什么不跟历史会议日期列一样用 148px：到期是次要信息，不该和标题争宽；而且窄屏本来就隐藏它。
      { key: 'due', label: '到期', width: '128px' },
    ],
    // 旧 3 列 → 新 5 列：标题留在第 1 列，状态从第 2 列搬到第 4 列，到期从第 3 列搬到第 5 列。
    legacy: { from: 3, to: [0, 3, 4] },
    // 等后端把 taskId 追加成第 6 格：用它做"待确认"标记（按 id 记，不按行序）。
    trailing: 1,
    empty: '还没有待办',
    unavailable: '暂时读不到待办',
    hint: '任务清单来自桌面宠物的待办窗口。',
  },
  report: {
    command: '/assistant-report-list',
    columns: [
      { key: 'date', label: '日期', width: '1fr' },
      { key: 'status', label: '状态', width: '1fr' },
      { key: 'digest', label: '摘要', width: '2.4fr' },
    ],
    empty: '还没有日报草稿',
    unavailable: '暂时读不到日报',
    hint: '日报由桌面宠物整理，这里只读。',
  },
  meeting: {
    command: '/assistant-meeting-list',
    columns: [
      { key: 'time', label: '时间', width: '1fr' },
      { key: 'name', label: '名称', width: '2.2fr' },
      { key: 'status', label: '状态', width: '1fr' },
    ],
    empty: '今天还没有会议',
    unavailable: '暂时读不到今天的会议',
    hint: '会议与纪要由桌面宠物录制并整理。',
    // 尾列是会议 id（不渲染）：改名/删除按它定位。
    trailing: 1,
  },
  team: {
    command: '/assistant-team-list',
    columns: [
      { key: 'name', label: '名字', width: '1.2fr' },
      { key: 'role', label: '角色', width: '1.2fr' },
      { key: 'status', label: '状态', width: '1fr' },
      { key: 'quota', label: '额度', width: '1fr' },
    ],
    empty: '还没有成员',
    unavailable: '暂时读不到成员列表',
    hint: '成员与额度在桌面宠物的助理团里管理。',
  },
}

/**
 * 会议 tab 下半段的「最近会议」（历史）。
 *
 * 五列，且**列数按 5 校验**：`parseList` 会按表头列数补 `—` 或截断，所以后端将来加一列
 * 也不会把这张表撑坏 —— 多出来的丢掉，少的补空，用户看到的永远是五列。
 *
 * 为什么缓存 60 秒（比「今天」的 30 秒更长）：历史变化慢，它只在有会议结束时变一次。
 * 这条同样要打桌宠，多打一次不值得。
 */
export const MEETING_HISTORY_COMMAND = '/assistant-meeting-history'

export const MEETING_HISTORY: ListTabDefinition = {
  command: MEETING_HISTORY_COMMAND,
  columns: [
    // 148px：`2026-11-12 14:30` 是 16 个半角字符（13px 下约 115px），132px 只剩 17px 余量，
    // 真机字体回退（雅黑数字偏宽）会吃掉省略号把时间截掉。148px 留出 ~33px。
    { key: 'date', label: '日期', width: '148px' },
    { key: 'name', label: '名称' },
    { key: 'source', label: '来源', width: '132px' },
    { key: 'retention', label: '保留期', width: '72px' },
    { key: 'status', label: '状态', width: '80px' },
  ],
  empty: '还没有历史会议',
  unavailable: '暂时读不到历史会议',
  hint: '最多显示 20 条',
  // 尾列是会议 id（不渲染）：改名/删除按它定位。
  trailing: 1,
}

/**
 * 状态列的最小配色：**只给"看起来成功但其实失败"的那一个词上色**。
 *
 * 为什么必须有：`已转写` 与 `转写失败` 并排时，如果都是灰字，用户根本看不出差别 ——
 * 那等于第五态白加。而"这一行到底转写成功没有"正是历史列表里最要紧的一件事。
 *
 * 为什么只有一条：这不是颜色体系，是**一格的文字颜色**。加背景色/边框/圆点会把表格变成
 * 徽章墙，反而更难扫读。查不到就返回 null，由调用方落默认灰 —— 新增状态自动安全。
 */
export const STATUS_TONE: Readonly<Record<string, string>> = {
  转写失败: '#c2410c',
}

/** 状态文字 → 颜色；没有特殊配色时返回 null（调用方用默认灰）。 */
export function statusTone(value: string): string | null {
  return STATUS_TONE[value.trim()] ?? null
}

/* ── 优先级编辑（提案 + 审批，非直接改） ─────────────────────────── */

/**
 * 改优先级的命令。**两位置参数：taskId 在前、取值在后。**
 *
 * 这条命令走"提案 + 审批"：聊天侧提交只生成一条待确认的改动，本人在桌面宠物里确认后才生效。
 * 所以提交成功后**不能**说"已改为高"，也**不能**乐观更新单元格 —— 那等于替服务端撒谎。
 */
export const SET_TASK_PRIORITY_COMMAND = '/assistant-set-task-priority'

/** 三个取值：命令参数 ↔ 单元格显示。服务端 `describePriority` 翻出来的就是这三个字。 */
export const PRIORITY_CHOICES: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'high', label: '高' },
  { value: 'normal', label: '中' },
  { value: 'low', label: '低' },
]

/** 命令取值 → 单元格显示。未知取值原样返回（不猜、不吞）。 */
export function priorityLabel(value: string): string {
  return PRIORITY_CHOICES.find(choice => choice.value === value)?.label ?? value
}

/**
 * 拼命令：`/assistant-set-task-priority <taskId> high`。
 *
 * `taskId` 里带空白就直接返回 null —— 拼进去会被拆成两个参数，服务端只会回一句用法提示，
 * 而用户会以为"点了没反应"。宁可按钮不出现（`rowTaskId` 已经先挡了一层）。
 */
export function priorityCommand(taskId: string, value: string): string | null {
  const id = taskId.trim()
  const picked = PRIORITY_CHOICES.find(choice => choice.value === value)
  if (id === '' || /\s/u.test(id) || picked === undefined) return null
  return `${SET_TASK_PRIORITY_COMMAND} ${id} ${picked.value}`
}

/**
 * 这一行能不能点：能点才给交互，点不了就纯文字。
 *
 * **这就是"权限由数据决定"的那道闸**：`taskId` 来自隐藏尾列（第 6 格）。后端还没输出它时
 * 恒为 null，于是整个优先级列**自动保持只读**——不需要开关变量，也不会出现"点了没反应"的死按钮。
 */
export function rowTaskId(row: ListRow): string | null {
  const id = row.trailing[0]?.trim()
  if (id === undefined || id === '' || id === EMPTY_CELL) return null
  return /\s/u.test(id) ? null : id
}

/** 会议行的隐藏 id（尾列）。改名/删除按它定位；后端没给 id 时整列自动只读。 */
export function rowMeetingId(row: ListRow): string | null {
  const id = row.trailing[0]?.trim()
  if (id === undefined || id === '' || id === EMPTY_CELL) return null
  return /\s/u.test(id) ? null : id
}

/** 提交后回读的三种结局。回执是**叙述**，列表是**状态**；能读状态就不要读叙述。 */
export type PriorityOutcome = 'applied' | 'pending' | 'gone'

/**
 * 提交完重新拉列表 → 这次提交到底算什么。
 *
 * - `applied`：列表里的优先级已经等于刚提交的值（今天多是提案，所以通常不会走到这里，
 *   但服务端哪天真的直接改，这段不用改判断逻辑）；
 * - `pending`：行还在、值没变 → 一条待确认的提案（界面给"待确认"标记，单元格仍显示旧值）；
 * - `gone`：列表里找不到这个 taskId → 任务被删/被筛掉，**标记必须清掉**，
 *   否则会留一个指向不存在行的标记，用户永远等不到它消失。
 */
export function priorityOutcome(rows: readonly ListRow[], taskId: string, requestedValue: string): PriorityOutcome {
  const row = rows.find(candidate => rowTaskId(candidate) === taskId)
  if (row === undefined) return 'gone'
  const index = LIST_TABS.todo.columns.findIndex(column => column.key === 'priority')
  if (index < 0) return 'pending'
  return row.cells[index]?.trim() === priorityLabel(requestedValue) ? 'applied' : 'pending'
}

/**
 * 每次拿到新列表时，把"待确认"标记与服务端现状对一遍。
 *
 * 为什么必须有这一步：用户在桌宠里确认之后，**列表会在下一次刷新时变成新值**，而这一刻
 * 没有任何"提交"动作发生 —— 如果不在这里收口，标记会永远挂在那行上（显示新值 + 琥珀点，
 * 还半透明），用户会以为"还在等确认"，实际上已经生效了。
 *
 * 两种清除条件，都只看状态不看叙述：
 * - 那一行没了（被删/被筛掉）→ 清；
 * - 那一行的优先级已经等于当初提交的值 → 清（已经生效）。
 * 其余保留（提案还在路上）。
 *
 * 返回新对象：没变化时返回**原引用**，避免每次刷新都触发一次无意义的重渲染。
 */
export function reconcilePending(
  pending: Readonly<Record<string, string>>,
  rows: readonly ListRow[],
): Record<string, string> {
  const keys = Object.keys(pending)
  if (keys.length === 0) return pending as Record<string, string>
  const next: Record<string, string> = {}
  let changed = false
  for (const key of keys) {
    const row = rows.find(candidate => rowTaskId(candidate) === key)
    if (row === undefined) { changed = true; continue }
    const index = LIST_TABS.todo.columns.findIndex(column => column.key === 'priority')
    if (index >= 0 && row.cells[index]?.trim() === priorityLabel(pending[key])) { changed = true; continue }
    next[key] = pending[key]
  }
  return changed ? next : pending as Record<string, string>
}

/**
 * 优先级列的配色：**同样只有一条**，理由与上面完全一致 —— 这不是色阶。
 *
 * `高` 用过同一个砖红（`#c2410c`，与「转写失败」同色）：这两个都是"要留意"的语义，
 * 换一个红只会让用户以为是两种不同的严重程度。`中`/`低` 不在这里登记 —— 它们落默认灰
 * 就是正确表达（一列里只有一个词需要被看见）。
 *
 * 后端将来加档（比如 `紧急`）时会拿到 null，于是原样显示 + 落灰，不抛错、不吞值。
 */
export const PRIORITY_TONE: Readonly<Record<string, string>> = {
  高: '#c2410c',
}

/** 优先级文字 → 颜色；`中`/`低`/未知档一律 null（调用方用默认灰）。 */
export function priorityTone(value: string): string | null {
  return PRIORITY_TONE[value.trim()] ?? null
}

/** 有配色表的列。**只有登记在这里的列才会被染色**，其余列保持默认前景色。 */
const COLUMN_TONES: Readonly<Record<string, (value: string) => string | null>> = {
  status: statusTone,
  priority: priorityTone,
}

/**
 * 某一格该怎么上色，三种结果各有含义，别合并成两态：
 * - `undefined`：这一列没有配色表（标题、日期、名称…）→ 保持默认前景色；
 * - `null`：有配色表、但这个值没命中（`中`/`低`/后端将来加的新档）→ 调用方落默认灰；
 * - 字符串：命中的颜色。
 *
 * 前提是"优先级值已经由服务端翻成中文"（与 `describeTaskStatus` 同一套路）：若服务端漏翻、
 * 直接吐出 `high`，这里会原样显示 `high` 并落灰 —— 难看但**不吞值**，且一眼能看出是契约问题。
 */
export function columnTone(columnKey: string | undefined, value: string): string | null | undefined {
  if (columnKey === undefined) return undefined
  const tone = COLUMN_TONES[columnKey]
  return tone === undefined ? undefined : tone(value)
}

/** 单元格类名。渲染层与窄屏媒体查询**必须**共用它，否则选择器会静默失配。 */
export function columnClassName(prefix: string, key: string): string {
  return `wb-col-${prefix}-${key}`
}

/**
 * 窄屏（<720px）要隐藏的列。
 *
 * 为什么是数据而不是直接写死 CSS：类名是 `wb-col-${prefix}-${key}` 拼出来的，
 * 手写 `.wb-col-source` 这种选择器一旦和 `keyPrefix` 对不上就会**静默失效**
 * —— 不报错、不告警，只是窄屏下没隐藏、表格被挤成省略号。这份清单经
 * `columnClassName()` 生成选择器，改前缀时两侧一起动，测试也能钉住。
 *
 * 选谁隐藏：留「标题 / 优先级 / 状态」= 干什么、急不急、到哪一步了。
 * 「来源 / 到期」是补充信息，窄屏下先让位，不做横向滚动。
 */
export const NARROW_HIDDEN_COLUMNS: readonly { readonly prefix: string; readonly key: string }[] = [
  { prefix: 'todo', key: 'source' },
  { prefix: 'todo', key: 'due' },
  { prefix: 'history', key: 'source' },
  { prefix: 'history', key: 'retention' },
]

/** 生成注入到 `<style>` 里的窄屏规则（客户端没有样式构建链，只能内联）。 */
export function narrowTableCss(): string {
  const selectors = NARROW_HIDDEN_COLUMNS
    .map(column => `.${columnClassName(column.prefix, column.key)}`)
    .join(',\n    ')
  return `@media (max-width: 720px) {\n  ${selectors} { display: none !important; }\n}`
}

/** 表格数据状态：三种"没有行"的原因不同，说法也必须不同。 */
export type TableState = 'loading' | 'rows' | 'empty' | 'unavailable'

export interface TableView {
  readonly state: TableState
  /** 只有 state === 'rows' 时有内容。 */
  readonly message: string | null
}

/**
 * 状态 → 展示口径。`rows === null` 表示没拿到（区分于"拿到了但为空"）。
 *
 * 这条映射是纯的，因此"空态不会被说成读不到"这件事可以被测试钉住，而不是靠人眼检查。
 */
export function tableView(state: TableState, definition: ListTabDefinition): TableView {
  if (state === 'rows') return { state, message: null }
  if (state === 'loading') return { state, message: '读取中…' }
  if (state === 'empty') return { state, message: definition.empty }
  return { state, message: definition.unavailable }
}

/**
 * 列表回包 → 表格行 / 空态 / 降级态。
 *
 * 契约只有两条（分行、` | ` 分列），但两条都必须守住：
 * - 分隔符是**固定常量** `" | "`，不做宽松匹配（`|` 或 ` |` 都不认）——服务端保证字段内部
 *   没有竖线、换行被压成空格，所以列数一定等于表头列数；
 * - 空字段是 `—`；万一服务端漏了，这里补到列数，宁可显示 `—` 也不让整行错位。
 *
 * 不含分隔符的回包是**一句话**：`暂时读不到…` 是降级态，其余是真空态。原句照显示，
 * 不用本地的默认文案覆盖它——服务端那句往往更具体（比如"暂时读不到今天的会议"）。
 */
export const LIST_SEPARATOR = ' | '

/** 空字段占位符。服务端与前端都写它（不是空串，也不是 `无`）。 */
export const EMPTY_CELL = '—'

/**
 * 一格数据对到表头的哪个位置：先看是不是旧回包（按格数判定，见 `LegacyRowLayout`），
 * 不是就按原序从左往右放。多出来的截断、缺的补 `—`，**永远是 `width` 格**。
 *
 * 只处理**可见列**；隐藏尾列由调用方按位置切开后另行返回。
 */
function alignCells(cells: readonly string[], width: number, legacy: LegacyRowLayout | undefined): string[] {
  const aligned = new Array<string>(width).fill(EMPTY_CELL)
  if (legacy !== undefined && cells.length === legacy.from) {
    cells.forEach((cell, index) => {
      const target = legacy.to[index]
      if (target !== undefined && target >= 0 && target < width) aligned[target] = cell
    })
    return aligned
  }
  cells.forEach((cell, index) => {
    if (index < width) aligned[index] = cell
  })
  return aligned
}

/**
 * 一行解析结果：**可见格 + 隐藏尾格**。
 *
 * 为什么是一个结构而不是两个平行数组：两个数组会各自被 map/slice 一次，只要有一处
 * 只处理了 `cells`，`trailing` 就和它对不上了——而"对不上"的表现是**标记跑到别的任务头上**，
 * 用户看不出是渲染错了。绑成一个对象，丢不掉。
 */
export interface ListRow {
  /** 与 `columns` 一一对应，长度恒等于列数。 */
  readonly cells: readonly string[]
  /** 表头之后的隐藏格（如 `taskId`）。**后端还没输出时是空数组**，属正常，不是数据损坏。 */
  readonly trailing: readonly string[]
}

export interface ListParse {
  readonly state: 'rows' | 'empty' | 'unavailable'
  readonly rows: readonly ListRow[]
  /** 只有非 rows 状态有：直接显示的那句话。 */
  readonly message: string | null
}

export function parseList(text: string, definition: ListTabDefinition): ListParse {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  // 空回包按提示语处理：它既不是表格，也不能冒充"读不到"（那是另一种事实）。
  if (lines.length === 0) return { state: 'empty', rows: [], message: '还没有数据' }

  const tableLines = lines.filter(line => line.includes(LIST_SEPARATOR))
  if (tableLines.length === 0) {
    const sentence = lines[0]
    const state = sentence.startsWith('暂时读不到') ? 'unavailable' : 'empty'
    return { state, rows: [], message: sentence }
  }

  const width = definition.columns.length
  const rows = tableLines.map((line): ListRow => {
    const cells = line.split(LIST_SEPARATOR).map(cell => cell.trim())
    // 旧回包没有尾列：按格数认出旧格式后整体重排，尾部一律留空。
    if (definition.legacy !== undefined && cells.length === definition.legacy.from) {
      return {
        cells: alignCells(cells, width, definition.legacy).map(cell => (cell === '' ? EMPTY_CELL : cell)),
        trailing: [],
      }
    }
    const visible = alignCells(cells.slice(0, width), width, undefined).map(cell => (cell === '' ? EMPTY_CELL : cell))
    // 多出来的格子**全部**进 trailing，不按声明值截断：声明值只说明"末尾该有个什么"，
    // 真按它截断的话，后端将来加第二个尾列就会被静默丢掉。
    const trailing = cells.slice(width)
    return { cells: visible, trailing }
  })
  return { state: 'rows', rows, message: null }
}

/** 设置摘要命令：一行一条、` | ` 分两列（标题 / 值）。 */
export const SETTINGS_SUMMARY_COMMAND = '/assistant-settings-summary'

/**
 * 设置页的三项只读摘要（标题 + 一句说明，作为**命令没回来时的兜底文案**）。
 *
 * 为什么是三项而不是四项：原先那行「悬停工具栏」在桌宠主进程里**没有持久化设置**
 * —— 它的开合时序只是渲染层的一个纯函数，开关存在渲染层本地。留着它只能显示 `—`，
 * 是噪音，所以去掉，不为它保留占位行。
 */
export const SETTINGS_SUMMARY: readonly { label: string; note: string }[] = [
  { label: '唤醒', note: '语音唤醒与声纹' },
  { label: '播报', note: '回复是否朗读、外放时是否插话' },
  { label: '讲解模式', note: '原文朗读或逐段讲解' },
]

export interface SettingsParse {
  readonly state: 'rows' | 'unavailable'
  /** 两列：标题、值。 */
  readonly rows: readonly (readonly [string, string])[]
  /** 非 rows 状态时显示的那句话。 */
  readonly message: string | null
}

/**
 * 设置摘要 → 两列表格。
 *
 * 与列表命令同一套分隔约定，但**只认两列**：任何一行不是两列，整条降级成提示语 ——
 * 三列的设置行塞进两列表格只会错位，而错位比不显示更误导（用户会读成"播报 = 唤醒"）。
 */
export function parseSettingsSummary(text: string): SettingsParse {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  const unavailable: SettingsParse = { state: 'unavailable', rows: [], message: '暂时读不到设置' }
  if (lines.length === 0) return unavailable

  const columns = lines.map(line => line.split(LIST_SEPARATOR))
  // 有一行不是两列就整条降级：第一行原话当提示语，不硬拆。
  if (columns.some(cells => cells.length !== 2)) {
    return { state: 'unavailable', rows: [], message: lines[0] }
  }
  return { state: 'rows', rows: columns.map(cells => [cells[0].trim() || '—', cells[1].trim() || '—'] as const), message: null }
}
