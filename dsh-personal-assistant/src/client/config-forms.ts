/**
 * 工作台里「可写的配置」：设置三项的选项、邮件/企业微信表单的字段与校验、以及命令行的拼法。
 *
 * 为什么全在这里：
 * - **选项与命令值必须一对一**（`开` ↔ `wake=on`）。散在 JSX 里迟早出现"界面显示开、发出去是 off"。
 * - **校验规则要能被单测**。端口 65536、邮箱少个 @、Secret 带空格 —— 这些不该靠手点发现。
 * - **命令行的形状是对外契约**，只在这一个函数里拼：后端若改成 JSON 参数，改一处即可。
 */

export type OptionKey = 'wake' | 'broadcast' | 'docSpeech'

export interface OptionChoice {
  /** 命令里用的值，例如 `on` / `all` / `ai`。 */
  readonly value: string
  readonly label: string
}

export interface OptionDefinition {
  readonly key: OptionKey
  readonly label: string
  /** 摘要回包里这一行的标题（与服务端 `assistant-settings-summary` 一致）。 */
  readonly summaryLabel: string
  readonly choices: readonly OptionChoice[]
}

export const SETTINGS_OPTIONS: readonly OptionDefinition[] = [
  {
    key: 'wake',
    label: '唤醒',
    summaryLabel: '唤醒',
    choices: [
      { value: 'on', label: '开' },
      { value: 'off', label: '关' },
    ],
  },
  {
    key: 'broadcast',
    label: '播报',
    summaryLabel: '播报',
    choices: [
      { value: 'all', label: '所有回复都念' },
      { value: 'voice', label: '只念语音发起的' },
    ],
  },
  {
    key: 'docSpeech',
    label: '讲解模式',
    summaryLabel: '讲解模式',
    choices: [
      { value: 'source', label: '原文朗读' },
      { value: 'ai', label: 'AI 讲解' },
    ],
  },
]

/**
 * 把摘要回包里那一行**值的描述**翻译成选项值。
 *
 * 服务端给的是一句人话（`开 · 只认我的声音`、`只念语音发起的`），不是枚举。所以这里做
 * 前缀/包含匹配，匹配不上返回 null —— 界面据此显示"未知"，而不是猜一个选中项。
 * 猜错的代价很具体：用户看到"关"被选中，以为自己已经关掉了唤醒。
 */
export function optionValueOf(key: OptionKey, description: string): string | null {
  const text = description.trim()
  if (text === '') return null
  if (key === 'wake') {
    if (text.startsWith('开')) return 'on'
    if (text.startsWith('关')) return 'off'
    return null
  }
  if (key === 'broadcast') {
    if (text.includes('所有回复')) return 'all'
    if (text.includes('只念语音')) return 'voice'
    return null
  }
  if (text.includes('AI')) return 'ai'
  if (text.includes('原文')) return 'source'
  return null
}

/**
 * 设置项的提交命令：`/assistant-set-option wake=on`。
 */
export function optionCommand(key: OptionKey, value: string): string {
  return `/assistant-set-option ${key}=${value}`
}

/**
 * `assistant-set-option` 的失败文案前缀。
 *
 * ## 分层规则（改这里之前先读这一段）
 * **`kind` 是判定层，文案是展示层。**
 * - 成败**只看 `kind`**（服务端现在已统一成 `error`）；
 * - 文案只负责"显示时去掉噪音"（那个 `设置没改成：` 前缀）；
 * - 前缀匹配不上 → 显示整句原话。**难看，但不错判。**
 *
 * 好处：服务端换措辞，最坏结果是"红字里多一句前缀"，而不是"失败被吞掉"或"成功被误报失败"。
 * 所以这条依赖是**软依赖**——钉住形状，不钉住内容。
 *
 * **历史**：服务端最初把"写没进去"回成 `kind: 'success'` + ``设置没改成：<原因>``
 * （只有它一条这么干，邮件/企微两条配置命令一直是 `error`）。前端只看 `ok` 就会把
 * "一个字都没写进去"显示成改好了 —— 那是最不该出现的一类静默失败。当时靠这个前缀识别；
 * 现在降级为**兜底**：新服务端先命中 `!ok`，旧产物 / 语义回退时前缀仍然兜住。
 *
 * **为什么不做"反向防御"**：要防的是"文案命中但不是失败"，那需要成功时也说「设置没改成…」——
 * 不会发生。真发生了也只是红字文案怪，不会让失败变成功（成败仍由 `kind` 说话）。
 *
 * **脆弱点**：服务端改 `kind` 之后，那边测试不再断言这句文案，前缀现在只有**前端**钉着
 * （`tests/client-forms.test.ts`）。换措辞是可自由发生的，降级形态见上。
 */
export const SET_OPTION_FAILURE_PREFIX = '设置没改成'

/** 回包是不是"没改成"；是就返回去掉前缀的原因（空原因回原句），否则 null。 */
export function setOptionFailure(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(SET_OPTION_FAILURE_PREFIX)) return null
  const reason = trimmed.slice(SET_OPTION_FAILURE_PREFIX.length).replace(/^[:：]\s*/u, '').trim()
  return reason === '' ? trimmed : reason
}

/* ── 表单 ─────────────────────────────────────────────────────────── */

export interface FieldDefinition {
  readonly key: string
  readonly label: string
  readonly type: 'text' | 'password' | 'number'
  readonly placeholder?: string
  readonly width?: string
  /**
   * 密码 / Secret 类字段：**永远不回填**，占位符按"存过没有"换一句话。
   * 这类字段留空提交 = 保持原值（服务端两种配置都是这么实现的），所以它不是"必填"。
   */
  readonly secret?: boolean
  /** 还没存过凭据时的占位符（此时它才是必填）。 */
  readonly secretRequiredPlaceholder?: string
}

export const MAIL_FIELDS: readonly FieldDefinition[] = [
  { key: 'address', label: '邮箱地址', type: 'text', placeholder: 'name@example.com' },
  { key: 'smtpHost', label: 'SMTP 主机', type: 'text', placeholder: 'smtp.example.com' },
  { key: 'smtpPort', label: 'SMTP 端口', type: 'number', placeholder: '465', width: '120px' },
  {
    key: 'password', label: '授权码 / 密码', type: 'password', secret: true,
    placeholder: '不显示已保存的值', secretRequiredPlaceholder: '请输入授权码',
  },
  { key: 'imapHost', label: 'IMAP 主机', type: 'text', placeholder: 'imap.example.com' },
  { key: 'imapPort', label: 'IMAP 端口', type: 'number', placeholder: '993', width: '120px' },
]

export const WECOM_FIELDS: readonly FieldDefinition[] = [
  { key: 'corpId', label: '企业 ID', type: 'text', placeholder: 'ww…' },
  {
    key: 'secret', label: '应用 Secret', type: 'password', secret: true,
    placeholder: '不显示已保存的值', secretRequiredPlaceholder: '请输入 Secret',
  },
  { key: 'agentId', label: 'AgentId', type: 'text', placeholder: '1000002', width: '160px' },
  { key: 'toUser', label: '接收人', type: 'text', placeholder: '账号或 @all', width: '200px' },
]

/* ── 读回：把无参命令的「标题 | 值」视图变成表单初值 ───────────────── */

/**
 * 读回结果。三种事实必须分开，界面说的话也不同：
 * - `unavailable`：**没拿到**（命令不通 / 桌宠没跑）→ 表单留空，但**不能**把它当"未配置"，
 *   也不能把失败文案填进字段；
 * - `configured === false`：拿到了、确实还没配 → 空表单 + 必填占位符，**不显示红字**（还没开始填，不是错）；
 * - `configured === true`：拿到真值 → 非密码字段回填，密码/Secret 永远空。
 */
export interface ConfigSnapshot {
  readonly unavailable: boolean
  readonly configured: boolean
  /** 非密码字段的真值。未配置或读不到的字段不出现。 */
  readonly values: Readonly<Record<string, string>>
  /** 服务端说"已保存"（只表示存过，永远不表示值本身）。 */
  readonly hasSecret: boolean
}

export const EMPTY_SNAPSHOT: ConfigSnapshot = { unavailable: false, configured: false, values: {}, hasSecret: false }

/** 服务端把"没有值"写成这些词，回填时都当空。 */
const ABSENT = /^(?:未配置|—|-|没有|none)$/u

/** 密码类字段存过之后的占位符。留空提交 = 不修改，所以这句话要和行为对上。 */
export const SECRET_SAVED_PLACEHOLDER = '已保存，留空表示不修改'

/**
 * 一行「标题 | 值」→ [标题, 值]。
 *
 * 为什么不用 `split(' | ')`：服务端视图里**未配置的邮箱地址**会渲染成 `邮箱 | `（尾部只剩分隔符），
 * 行 trim 之后就是 `邮箱 |` —— 按 `' | '` 切只有一格，整块会被判成"格式不对"而放弃回填。
 * 这里按第一个 `|` 切，右侧允许空。
 */
function splitViewLine(line: string): [string, string] | null {
  const index = line.indexOf('|')
  if (index < 0) return null
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()]
}

/**
 * `host:port` → [host, port]。**前提：服务端只写 `host:port`（`${view.smtpHost}:${view.smtpPort}`）**，
 * 所以按**最后一个**冒号切就是对的。
 *
 * 但"当前前提成立"不等于"以后不会有人填别的"，所以这里有一条防御，**不是 IPv6 支持**：
 * 切完 host 里还留着冒号（裸 IPv6 `2001:db8::1`、或方括号形式 `[::1]:465`）时，
 * **把整串当作 host、端口留空**。这样用户看到的是"主机填进去了、端口要自己补"，
 * 而不是"host 被截成 `2001:db8:` 然后保存失败"——后者最难查：字段看起来填了值，
 * 报错却指向一个他看都看不出来的地方。
 *
 * 为什么不做 IPv6 解析：要同时处理 `[::1]:465`、裸 `2001:db8::1`、端口缺省三种形态，
 * 收益极低（邮件服务器用 IPv6 字面量是极少数场景），而引入新解析 bug 的风险不低。
 * 宁可"不猜"，也不"猜错"。
 */
function splitHostPort(value: string): [string, string] {
  const text = value.trim()
  if (text === '' || ABSENT.test(text)) return ['', '']
  const index = text.lastIndexOf(':')
  if (index < 0) return [text, '']
  const host = text.slice(0, index).trim()
  const port = text.slice(index + 1).trim()
  // 服务端在"字段全空"时会渲染成 `SMTP | :0`（host 空、port 占位）。host 空就整对丢掉，
  // 否则表单会预填一个 `0` 端口 —— 用户点保存才发现端口不合法，而那是我们塞进去的。
  if (host === '') return ['', '']
  // 防御：host 还带冒号 = 未支持的形态（IPv6 字面量等）。整串当 host，端口交给用户填。
  if (host.includes(':')) return [text, '']
  return [host, port === '0' ? '' : port]
}

function viewMap(text: string): Map<string, string> | null {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (lines.length === 0) return null
  const map = new Map<string, string>()
  for (const line of lines) {
    const pair = splitViewLine(line)
    // 一行都不是「标题 | 值」→ 这是别的东西（错误句、用法提示），不猜。
    if (pair === null) return null
    map.set(pair[0], pair[1])
  }
  return map
}

/** 读回没拿到：服务端三处都用「暂时读不到」开头，失败文案原样保留但不进字段。 */
function looksUnavailable(text: string): boolean {
  const trimmed = text.trim()
  return trimmed === '' || trimmed.startsWith('暂时读不到')
}

/**
 * "还没配置"这句话（而不是"没读到"）。
 *
 * 必须单独认：邮件那边**新装机器**的读回根本不是表格，而是一句 `还没有配置邮箱`
 * （`formatMailConfigView(null)`）。把它归到"读不到"会让新用户第一眼就看到琥珀色警告，
 * 而我们其实已经成功读到了答案——答案是"你还没配"。
 */
function looksUnconfigured(text: string): boolean {
  return !text.includes('|') && /还没有配置|尚未配置|未配置|not\s*configured/i.test(text)
}

/** 读不到 / 还没配置 都不该进字段，但两者对用户是两句话。 */
const UNREADABLE: ConfigSnapshot = { unavailable: true, configured: false, values: {}, hasSecret: false }
const UNCONFIGURED: ConfigSnapshot = { unavailable: false, configured: false, values: {}, hasSecret: false }

/**
 * 邮件读回 → 表单初值。
 *
 * 服务端的视图是四行：`邮箱 | <地址>`、`SMTP | host:port`、`IMAP | host:port|未配置`、
 * `授权码 | 已保存|未配置`。**授权码那行只给"存过没有"**，所以这里也只有布尔值。
 */
export function parseMailSnapshot(text: string): ConfigSnapshot {
  if (looksUnavailable(text)) return UNREADABLE
  if (looksUnconfigured(text)) return UNCONFIGURED
  const map = viewMap(text)
  if (map === null) return UNREADABLE

  const values: Record<string, string> = {}
  const address = map.get('邮箱') ?? ''
  if (address !== '' && !ABSENT.test(address)) values.address = address
  const [smtpHost, smtpPort] = splitHostPort(map.get('SMTP') ?? '')
  if (smtpHost !== '') values.smtpHost = smtpHost
  if (smtpPort !== '') values.smtpPort = smtpPort
  const [imapHost, imapPort] = splitHostPort(map.get('IMAP') ?? '')
  if (imapHost !== '') values.imapHost = imapHost
  if (imapPort !== '') values.imapPort = imapPort
  const hasSecret = (map.get('授权码') ?? '') === '已保存'
  // "配过"的判据取地址或凭据任一存在：只看地址会漏掉"地址在、密码没了"这种半截状态。
  return { unavailable: false, configured: Object.keys(values).length > 0 || hasSecret, values, hasSecret }
}

/** 企业微信读回 → 表单初值。四行：`企业 ID` / `AgentId` / `接收人` / `Secret`。 */
export function parseWecomSnapshot(text: string): ConfigSnapshot {
  if (looksUnavailable(text)) return UNREADABLE
  if (looksUnconfigured(text)) return UNCONFIGURED
  const map = viewMap(text)
  if (map === null) return UNREADABLE

  const values: Record<string, string> = {}
  for (const [label, key] of [['企业 ID', 'corpId'], ['AgentId', 'agentId'], ['接收人', 'toUser']] as const) {
    const value = map.get(label) ?? ''
    if (value !== '' && !ABSENT.test(value)) values[key] = value
  }
  const hasSecret = (map.get('Secret') ?? '') === '已保存'
  return { unavailable: false, configured: Object.keys(values).length > 0 || hasSecret, values, hasSecret }
}

/**
 * 字段占位符：密码类只有两种说法，其余用字段自带的示例。
 *
 * 这两句话必须与**保存语义**对上：邮件与企业微信都实现了"留空 = 保持原值"，
 * 所以存过之后写 `已保存，留空表示不修改`；没存过时它是必填，写 `请输入…`。
 */
export function fieldPlaceholder(field: FieldDefinition, snapshot: ConfigSnapshot): string {
  if (field.secret !== true) return field.placeholder ?? ''
  if (snapshot.hasSecret) return SECRET_SAVED_PLACEHOLDER
  return field.secretRequiredPlaceholder ?? field.placeholder ?? ''
}

/** 表单初值：只取非密码字段；读不到就是空表（**不**把失败文案填进去）。 */
export function initialFormValues(fields: readonly FieldDefinition[], snapshot: ConfigSnapshot): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of fields) {
    if (field.secret === true) continue
    const value = snapshot.values[field.key]
    if (value !== undefined) values[field.key] = value
  }
  return values
}

export type FormValues = Readonly<Record<string, string>>
export type FormErrors = Readonly<Record<string, string>>

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

/** 端口：整数且 1–65535。空着也算错 —— 六个字段都是必填，缺一个连不上。 */
function portError(value: string): string | null {
  const text = value.trim()
  if (text === '') return '请填写端口'
  if (!/^\d+$/u.test(text)) return '端口必须是数字'
  const port = Number(text)
  if (!Number.isFinite(port) || port < 1 || port > 65535) return '端口必须在 1–65535 之间'
  return null
}

function required(value: string, label: string): string | null {
  return value.trim() === '' ? `请填写${label}` : null
}

/**
 * 邮件表单校验。规则都是"不合法就不要发命令"——发出去只会得到一句看不懂的服务端错误，
 * 而且可能把半截配置写进文件。
 *
 * `stored.hasSecret` 有一个具体作用：**存过授权码之后，密码格留空是合法的**（服务端留空=保持原值）。
 * 不放开这一条，用户每改一次端口都会被要求重填授权码 —— 而他手里根本没有原文可填。
 */
export function validateMail(values: FormValues, stored: { hasSecret: boolean } = { hasSecret: false }): FormErrors {
  const errors: Record<string, string> = {}
  const address = values.address ?? ''
  const addressMissing = required(address, '邮箱地址')
  if (addressMissing !== null) errors.address = addressMissing
  else if (!EMAIL.test(address.trim())) errors.address = '邮箱地址格式不对'

  const smtpHost = required(values.smtpHost ?? '', 'SMTP 主机')
  if (smtpHost !== null) errors.smtpHost = smtpHost
  const imapHost = required(values.imapHost ?? '', 'IMAP 主机')
  if (imapHost !== null) errors.imapHost = imapHost

  const smtpPort = portError(values.smtpPort ?? '')
  if (smtpPort !== null) errors.smtpPort = smtpPort
  const imapPort = portError(values.imapPort ?? '')
  if (imapPort !== null) errors.imapPort = imapPort

  if ((values.password ?? '').trim() === '' && !stored.hasSecret) errors.password = '请填写授权码'
  return errors
}

/** 企业微信表单校验：其它字段必填，AgentId 必须是数字；Secret 与邮件同一条规则（存过可留空）。 */
export function validateWecom(values: FormValues, stored: { hasSecret: boolean } = { hasSecret: false }): FormErrors {
  const errors: Record<string, string> = {}
  for (const field of WECOM_FIELDS) {
    if (field.secret === true && stored.hasSecret) continue
    const missing = required(values[field.key] ?? '', field.label)
    if (missing !== null) errors[field.key] = missing
  }
  const agentId = (values.agentId ?? '').trim()
  if (agentId !== '' && !/^\d+$/u.test(agentId)) errors.agentId = 'AgentId 必须是数字'
  return errors
}

/**
 * 拼命令行：`/<command> key=value key=value`。
 *
 * **值里含空格或引号时用双引号包起来**（密码里出现空格是常事）。这是与后端约定前先落地
 * 的形状 —— 若后端改成 JSON 参数，只改这一个函数，界面与校验都不用动。
 */
export function buildCommandLine(command: string, values: FormValues, keys: readonly string[]): string {
  const parts: string[] = []
  for (const key of keys) {
    const raw = (values[key] ?? '').trim()
    if (raw === '') continue
    // 含空格或引号的值加双引号：密码里出现空格是常事，不加引号会被拆成两个参数。
    const quoted = /[\s"]/u.test(raw) ? `"${raw.replace(/"/gu, '\\"')}"` : raw
    parts.push(`${key}=${quoted}`)
  }
  return `/${command} ${parts.join(' ')}`.trim()
}

/** 服务端回包像不像"这条命令还不存在"。用来把"接口没就绪"和"参数写错了"分开说。 */
export function looksLikeUnknownCommand(text: string): boolean {
  return /未知|不存在|没有这个命令|unknown|not\s*found|no\s+such/i.test(text)
}

/** 摘要行（标题 | 值）→ 三项当前值。匹配不上的项不出现在结果里（界面显示"未知"）。 */
export function optionValuesOf(rows: readonly (readonly [string, string])[]): Partial<Record<OptionKey, string>> {
  const values: Partial<Record<OptionKey, string>> = {}
  for (const definition of SETTINGS_OPTIONS) {
    const row = rows.find(([label]) => label.trim() === definition.summaryLabel)
    if (row === undefined) continue
    const value = optionValueOf(definition.key, row[1])
    if (value !== null) values[definition.key] = value
  }
  return values
}
