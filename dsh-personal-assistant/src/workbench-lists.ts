/**
 * 工作台四张列表（待办 / 会议 / 日报 / 成员）的只读格式化。
 *
 * 客户端只能 `commands.execute(sessionId, '/命令')` 拿文本，然后**按行 split 成表格行**，
 * 所以格式必须死板到可以直接切片：
 * - 一行一条记录，行之间 `\n`；
 * - 字段之间 ` | `（空格-竖线-空格，两侧都有空格，`split(' | ')` 才切得干净）；
 * - 空字段写 `—`（不是空串：空串在 split 后就是"少一列"，前端会错位）；
 * - 不用 markdown 表格、不用 JSON。
 *
 * 三种状态严格分开：
 * - 有数据 → 若干行；
 * - 空列表 → 一句人话（`还没有待办`），**不是**空的成功；
 * - 数据源不可用 → `暂时读不到XXX`，**不能**降级成"空列表"（用户会以为是真没有）。
 */

/** 字段分隔符：两侧都有空格，前端 `split(' | ')` 直接切。 */
export const FIELD_SEPARATOR = ' | '

/** 空字段占位。写空串会让前端少一列。 */
export const EMPTY_FIELD = '—'

/** 单条文本里出现竖线会破坏列结构，统一换成斜杠；换行压成空格（一行一条）。 */
export function cleanField(value: string | null | undefined, max = 40): string {
  const text = (value ?? '').replace(/[\r\n]+/gu, ' ').replace(/\|/gu, '/').trim()
  if (text === '') return EMPTY_FIELD
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 把若干行拼成回包文本。行内字段同样做一次清理，防止个别字段把列冲散。 */
export function joinRows(rows: ReadonlyArray<ReadonlyArray<string | null | undefined>>): string {
  return rows.map(row => row.map(cell => cleanField(cell, 500)).join(FIELD_SEPARATOR)).join('\n')
}

/** `YYYY-MM-DD HH:mm`（本机时区），表格里够短且能直接排序。 */
export function stampOf(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return EMPTY_FIELD
  const d = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 只要 `HH:mm`（会议列表都是"今天"，日期是废话）。 */
export function clockOf(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return EMPTY_FIELD
  const d = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 任务状态说成人话。未知状态原样输出，别把它藏起来。 */
const TASK_STATUS_TEXT: Readonly<Record<string, string>> = {
  created: '已创建',
  queued: '排队中',
  running: '进行中',
  'awaiting-approval': '待批准',
  'awaiting-user': '待你处理',
  review: '待复核',
  done: '已完成',
  blocked: '受阻',
  failed: '失败',
  cancelled: '已取消',
  unknown: '未知',
}

export function describeTaskStatus(status: string): string {
  return TASK_STATUS_TEXT[status] ?? status
}

/**
 * 角色 id 说成人话。
 *
 * 这些 id 只是内部席位标识；西游记称谓曾是首版种子占位（用户口述的比喻），
 * v10 迁移已把未改过的显示名换成通用名称（见 team-domain.ts）。这张表必须与那次
 * 迁移同一套名字，否则列表里又会冒出早已删掉的比喻称谓。
 */
const ROLE_TEXT: Readonly<Record<string, string>> = {
  tangseng: '总助理',
  wukong: '助理1',
  bajie: '助理2',
  shaseng: '助理3',
  bailongma: '助理4',
  custom: '自定义',
}

export function describeRole(roleId: string): string {
  return ROLE_TEXT[roleId] ?? roleId
}

/** 会议状态说成人话（键取自桌宠的 MeetingStateName）。 */
const MEETING_STATE_TEXT: Readonly<Record<string, string>> = {
  recording: '录音中',
  stopping: '停止中',
  transcribed: '已转写',
  'transcript-failed': '转写失败',
  minutes: '已出纪要',
  deleted: '已删除',
}

export function describeMeetingState(state: string): string {
  return MEETING_STATE_TEXT[state] ?? state
}

/**
 * 一条待办的展示形状。字段顺序即表格列序：**标题 | 优先级 | 来源 | 状态 | 到期**。
 * priority/source 缺省时按 normal/manual 处理——老数据在库里已迁移，这里再兜一层。
 */
export interface TodoListRow {
  readonly goal: string
  readonly status: string
  readonly deadlineAt: number | null
  readonly priority?: string
  readonly source?: string
  /** 排序用（同优先级按它倒序）。缺省视为 0。 */
  readonly updatedAt?: number
  /**
   * 隐藏尾格：任务 ID。前端不渲染它，但"点哪一条"必须靠它——
   * 标题会重名、行序会随优先级变，只有 ID 唯一。
   * 缺失时写 `—`，**保证每行格数一致**（格数不齐会让前端那几行的 ID 落空且不报错）。
   */
  readonly taskId?: string
}

const PRIORITY_TEXT: Readonly<Record<string, string>> = { high: '高', normal: '中', low: '低' }
/** 排序权重：high 必须排在最前，所以用小数字（升序更直观）。 */
const PRIORITY_RANK: Readonly<Record<string, number>> = { high: 0, normal: 1, low: 2 }

const SOURCE_TEXT: Readonly<Record<string, string>> = {
  manual: '手动', meeting: '会议', enterprise: '企业', ai: 'AI',
}

export function describePriority(value: unknown): string {
  return (typeof value === 'string' ? PRIORITY_TEXT[value] : undefined) ?? '中'
}

export function describeSource(value: unknown): string {
  return (typeof value === 'string' ? SOURCE_TEXT[value] : undefined) ?? '手动'
}

/**
 * 排序：**先按优先级（高→中→低），同优先级按 updatedAt 倒序**。
 *
 * 为什么不是只按时间：列表的意义就是"先看要紧的"。只按 updatedAt 会退化成
 * "谁刚被碰过谁在上面"，一条低优先级任务只要被挪一下就能盖住高优先级的事。
 */
export function sortTodoRows(rows: readonly TodoListRow[]): TodoListRow[] {
  return [...rows].sort((a, b) => {
    const rankA = PRIORITY_RANK[a.priority ?? 'normal'] ?? 1
    const rankB = PRIORITY_RANK[b.priority ?? 'normal'] ?? 1
    if (rankA !== rankB) return rankA - rankB
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  })
}

export function formatTodoList(rows: readonly TodoListRow[] | null): string {
  if (rows === null) return '暂时读不到待办'
  if (rows.length === 0) return '还没有待办'
  return joinRows(sortTodoRows(rows).slice(0, 20).map(row => [
    row.goal,
    describePriority(row.priority),
    describeSource(row.source),
    describeTaskStatus(row.status),
    stampOf(row.deadlineAt),
    // 第 6 格：隐藏的 taskId。放在末尾，可见的 5 列一格不动；
    // 清洗交给 joinRows→cleanField（`|` 换成 `/`、换行压平），所以 ID 绝不会把行切歪。
    //
    // **前提**：ID 必须是 `[0-9a-f-]`（UUID）这类不含 `|` 与换行的字符。
    // cleanField 是"把会破坏列结构的字符换掉"，不是"无损转义"——如果将来 ID 格式变了
    // （比如有人用 `a|b` 做复合主键），前端拿到的就会是同形但**不同值**的 id，
    // 点下去找不到任务，而且界面上看不出是数据问题。届时要么换成分隔符以外的编码，
    // 要么在这里显式拒绝含 `|` 的 ID（宁可空着也不给一个错的）。
    row.taskId,
  ]))
}

/** 一条会议的展示形状：时间 | 名称 | 状态。 */
export interface MeetingListRow {
  readonly startedAt: number
  readonly name: string
  readonly state: string
  /** 会议 id：尾列，不渲染；工作台的改名/删除按它定位，不能按行号或名字。 */
  readonly id?: string
}

export function formatMeetingList(rows: readonly MeetingListRow[] | null): string {
  if (rows === null) return '暂时读不到今天的会议'
  if (rows.length === 0) return '今天还没有会议'
  return joinRows(rows.slice(0, 10).map(row => [clockOf(row.startedAt), row.name, describeMeetingState(row.state), row.id ?? '']))
}

/** 一份日报的展示形状：日期 | 状态 | 摘要。 */
export interface ReportListRow {
  readonly date: string
  readonly state: string
  readonly summary: string
}

export function formatReportList(rows: readonly ReportListRow[] | null): string {
  if (rows === null) return '暂时读不到日报'
  if (rows.length === 0) return '还没有日报草稿'
  return joinRows(rows.slice(0, 10).map(row => [row.date, row.state, row.summary]))
}

/** 一位成员的展示形状：名字 | 角色 | 职责 | 性格与形象 | 状态 | 额度。 */
export interface TeamListRow {
  readonly name: string
  readonly role: string
  readonly enabled: boolean
  readonly quota: string
  /** 功能职责（成员描述）；旧调用方不传时显示 —。 */
  readonly description?: string
  /** 性格与表达风格。 */
  readonly personality?: string
  /** 形象标识（panda / boy-glasses / girl-glasses / custom-*）。 */
  readonly skinId?: string
  /** 音色档案名；空表示跟随总助理。 */
  readonly voiceProfile?: string
  /** 已绑定能力；职责为空时用它兜底说明能做什么。 */
  readonly capabilities?: readonly string[]
}

const SKIN_LABELS: Record<string, string> = { panda: '熊猫', 'boy-glasses': '眼镜男生', 'girl-glasses': '眼镜女生' }

/** 性格 + 形象 + 音色压成一列，避免表格横向撑爆。 */
function describeStyle(row: TeamListRow): string {
  const parts: string[] = []
  const personality = (row.personality ?? '').trim()
  if (personality) parts.push(cleanField(personality, 200))
  if (row.skinId) parts.push(SKIN_LABELS[row.skinId] ?? '自定义形象')
  const voice = (row.voiceProfile ?? '').trim()
  if (voice) parts.push(`音色 ${cleanField(voice, 40)}`)
  return parts.length > 0 ? parts.join('；') : EMPTY_FIELD
}

/** 职责为空时用能力标签兜底；两者都没有才是 —。 */
function describeDuty(row: TeamListRow): string {
  const description = (row.description ?? '').trim()
  if (description) return cleanField(description, 300)
  const capabilities = row.capabilities ?? []
  return capabilities.length > 0 ? `能力：${capabilities.join('、')}` : EMPTY_FIELD
}

export function formatTeamList(rows: readonly TeamListRow[] | null): string {
  if (rows === null) return '暂时读不到成员'
  if (rows.length === 0) return '还没有成员'
  return joinRows(rows.map(row => [row.name, describeRole(row.role), describeDuty(row), describeStyle(row),
    row.enabled ? '在岗' : '停用', row.quota]))
}

// ── 设置摘要（三行真值，第四行「悬停工具栏」在主进程没有设置，故不出现）─────────

/** 桌宠侧 `settings.summary` 的回包形状。字段缺失按"读不到该行"处理，不猜值。 */
export interface SettingsSummaryRaw {
  readonly wakeEnabled?: unknown
  readonly wakeVoiceprint?: unknown
  readonly readReplies?: unknown
  readonly docSpeechMode?: unknown
}

/**
 * 三行设置摘要。**逐字**：
 * - `唤醒 | 关` / `唤醒 | 开 · 只认我的声音` / `唤醒 | 开 · 谁都行`
 * - `播报 | 所有回复都念` / `播报 | 只念语音发起的`
 * - `讲解模式 | AI 讲解` / `讲解模式 | 原文朗读`
 *
 * 为什么"播报"两行这么说：主进程里真正的开关是 `readReplies`（朗读回复），
 * 它的语义就是"打开后，打字发出的消息也把回答念出来；关着只有语音发起的那一轮会念"。
 * 所以「所有回复都念」/「只念语音发起的」是它**唯一准确**的两种说法。
 */
export function formatSettingsSummary(raw: SettingsSummaryRaw | null): string {
  if (raw === null) return '暂时读不到设置'
  const rows: string[][] = []
  if (typeof raw.wakeEnabled === 'boolean') {
    if (!raw.wakeEnabled) rows.push(['唤醒', '关'])
    else if (raw.wakeVoiceprint === true) rows.push(['唤醒', '开 · 只认我的声音'])
    else rows.push(['唤醒', '开 · 谁都行'])
  }
  if (typeof raw.readReplies === 'boolean') {
    rows.push(['播报', raw.readReplies ? '所有回复都念' : '只念语音发起的'])
  }
  if (raw.docSpeechMode === 'ai' || raw.docSpeechMode === 'source') {
    rows.push(['讲解模式', raw.docSpeechMode === 'ai' ? 'AI 讲解' : '原文朗读'])
  }
  // 三项一项都读不到：整条降级，别回一个空表让前端以为是没数据。
  if (rows.length === 0) return '暂时读不到设置'
  return joinRows(rows)
}

// ── 历史会议列表（/assistant-meeting-history）─────────────────────────────

/** 桌宠 `meeting.history` 的一条记录。字段缺失按"这一格读不到"处理，不猜。 */
export interface MeetingHistoryRaw {
  readonly startedAt?: unknown
  readonly name?: unknown
  readonly sources?: unknown
  readonly retentionDays?: unknown
  readonly transcriptStatus?: unknown
  readonly integrityStatus?: unknown
  /** 会议 id：尾列，不渲染；改名/删除按它定位。 */
  readonly id?: unknown
}

/**
 * 来源说人话。桌宠的 `sources` 只有 `mic` / `mic+loopback` 两个值，
 * 按实际组合给词，缺项就少一个词（不写"无"）。
 */
export function describeMeetingSources(sources: unknown): string {
  if (sources === 'mic') return '仅麦克风'
  if (sources === 'mic+loopback') return '麦克风+系统声'
  return EMPTY_FIELD
}

/** `2026-11-12 14:30`：历史列表跨天，日期必须带上（今天的列表才用纯时刻）。 */
export function dayStampOf(ms: number | null | undefined): string {
  return stampOf(ms)
}

export function formatMeetingHistory(rows: readonly MeetingHistoryRaw[] | null): string {
  if (rows === null) return '暂时读不到历史会议'
  if (rows.length === 0) return '还没有历史会议'
  return joinRows(rows.slice(0, 20).map(row => [
    dayStampOf(typeof row.startedAt === 'number' ? row.startedAt : null),
    typeof row.name === 'string' ? row.name : '',
    describeMeetingSources(row.sources),
    typeof row.retentionDays === 'number' && Number.isFinite(row.retentionDays) ? `${row.retentionDays} 天` : '',
    typeof row.transcriptStatus === 'string' ? row.transcriptStatus : '',
    typeof row.id === 'string' ? row.id : '',
  ]))
}
