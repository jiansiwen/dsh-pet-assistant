import Schema from '@deepseek-ai/schemastery'

/** 用户可在 cordis.yml 中追加的分类规则。 */
export interface CustomClassifyRule {
  /** 进程名匹配正则（不区分大小写）。 */
  process: string
  /** 分类：chat / browser / document / dev / meeting / ai / terminal / other。 */
  category: string
  /** 可选：从窗口标题提取有效信息的正则（取第一个捕获组，缺省取整段匹配）。 */
  titleExtract?: string
}

/** 插件配置。 */
export interface Config {
  /** 前台窗口采样间隔（毫秒），最小 1000。 */
  sampleIntervalMs: number
  /** 低于该时长的活动片段视为噪声丢弃（毫秒）。 */
  minSpanMs: number
  /** 日报保存目录；留空则使用 <DSH_HOME>/personal-assistant/reports。 */
  reportDir: string
  /** 追加的应用分类规则，先于默认规则匹配。 */
  customRules: CustomClassifyRule[]
  /**
   * 桌面宠物工程目录（dsh-pet）；召唤宠物时在此目录执行 `pnpm start`。
   * 留空则不自动拉起宠物，只能由用户手动启动后自动接入桥接。
   */
  petDir: string
  /**
   * 助理库文件路径（记忆 / 观察 / 日报版本）；留空则使用
   * <DSH_HOME>/personal-assistant/assistant.sqlite。
   *
   * 刻意不复用 desktop-team/team.sqlite：团队是可选功能（teamEnabled 默认关闭），
   * 记忆不是。混在一个库里，关掉团队就得连带决定记忆放哪。
   */
  storePath: string
  /**
   * 是否采集前台活动。关闭后不开采样进程、不产生采样文件。
   *
   * 默认沿用旧行为（开启）：这不是新增的采集渠道，插件被装上的目的就是它，
   * 而且采集只在用户显式「开启个人助理模式」期间运行——模式本身就是同意闸门。
   * 分级授权体现在这里能被单独关掉，而不是默认替用户关。
   */
  captureActivity: boolean
  /**
   * 是否授权采集窗口标题。关闭时采样脚本压根不调用 GetWindowText，
   * 未授权的标题不会先落进采样文件再被过滤。
   * 代价是活动只剩进程名，日报只能说到"用了 Word"而说不出"在写哪份文档"。
   */
  captureWindowTitles: boolean
  excludedProcesses: string[]
  excludedTitleKeywords: string[]
  /** 原始活动（采样片段与观察记录）保留天数，超期由保留期清理删除；最小 1。 */
  retentionActivityDays: number
  /**
   * 注入系统提示词的记忆条数上限（按优先级取前 N 条）。
   * 限制的是注入而不是存储：存多了不花钱，全塞进提示词会把上下文挤爆。
   */
  maxInjectedMemories: number
  /** 是否在启动时把旧存储域里的偏好 / 记录 / 日报只读导入新库；默认开启，否则升级后用户教过的东西看起来像消失了。 */
  migrateLegacy: boolean
  /** 导入成功后是否删除旧存储域里的对应数据；默认关闭——导入是只读的，删除不可逆，要删由用户显式决定。 */
  deleteLegacyAfterMigration: boolean
  /** 是否装配桌面专家助理团；默认关闭，由 desktop-team profile 显式打开。 */
  teamEnabled: boolean
  /** 团队库文件路径；留空则使用 <DSH_HOME>/desktop-team/team.sqlite。 */
  teamStorePath: string
  /** 团队 id，用于任务归属与事件过滤。 */
  teamId: string
  /**
   * 让哪些席位上台，可以写 assistantId（`member-shaseng`）或 roleId（`shaseng`）。
   *
   * 留空 = 编制自带的默认（总助理 + 两名专家），其余两个角色是未启用席位、不播放假工作。
   * 想让五人全部首发就写全五个 —— 桌面上多两个人是实打实的资源开销，这个决定归用户，
   * 所以做成配置项而不是代码默认值。写错的名字会被忽略并记一条 warn。
   */
  teamSeats: string[]
  /** 子代理 provider：spawn 不继承父上下文（专家只看到任务材料），fork 继承。 */
  teamProvider: string
  /** 同时进行的推理委派上限。 */
  maxConcurrentInference: number
  /** 同时进行的副作用委派上限，必须小于推理上限。 */
  maxConcurrentSideEffect: number
  /** 单个任务的执行超时（毫秒）。 */
  taskTimeoutMs: number
  /** 未显式指定时任务的 token 预算。 */
  defaultBudgetTokens: number
  /** 批准有效期（毫秒）；运行时代次变化会让旧批准立即失效。 */
  approvalTtlMs: number
  /** 额外要从只读专家手里禁用的工具名；生效前会用 ctx.tools.get 校验存在性。 */
  denyExpertTools: string[]
  /** 是否启用主动提醒（design.md §2.7）；关闭后引擎彻底安静，也省掉评估定时器。 */
  proactiveEnabled: boolean
  /** 触发主动提醒的无输入时长（毫秒）；设计原文建议 8 分钟，是可配置实验值不是认知判断。 */
  proactiveIdleMs: number
  /** 两次主动提醒之间的最小间隔（毫秒）；设计原文建议 60 分钟。 */
  proactiveCooldownMs: number
}

export const Config: Schema<Config> = Schema.object({
  sampleIntervalMs: Schema.number().default(5000),
  minSpanMs: Schema.number().default(3000),
  reportDir: Schema.string().default(''),
  petDir: Schema.string().default(''),
  storePath: Schema.string().default(''),
  captureActivity: Schema.boolean().default(true),
  captureWindowTitles: Schema.boolean().default(true),
  excludedProcesses: Schema.array(Schema.string()).default(['KeePass', 'KeePassXC', '1Password', 'Bitwarden']),
  excludedTitleKeywords: Schema.array(Schema.string()).default(['密码管理', '支付密码', '银行卡', '网上银行', 'password manager']),
  retentionActivityDays: Schema.number().default(7),
  maxInjectedMemories: Schema.number().default(40),
  migrateLegacy: Schema.boolean().default(true),
  deleteLegacyAfterMigration: Schema.boolean().default(false),
  customRules: Schema.array(Schema.object({
    process: Schema.string().required(),
    category: Schema.string().required(),
    titleExtract: Schema.string(),
  })).default([]),
  teamEnabled: Schema.boolean().default(false),
  teamStorePath: Schema.string().default(''),
  teamId: Schema.string().default('desktop-team'),
  teamSeats: Schema.array(Schema.string()).default([]),
  teamProvider: Schema.string().default('spawn'),
  maxConcurrentInference: Schema.number().default(2),
  maxConcurrentSideEffect: Schema.number().default(1),
  taskTimeoutMs: Schema.number().default(600000),
  defaultBudgetTokens: Schema.number().default(200000),
  approvalTtlMs: Schema.number().default(300000),
  denyExpertTools: Schema.array(Schema.string()).default([]),
  proactiveEnabled: Schema.boolean().default(true),
  proactiveIdleMs: Schema.number().default(480000),
  proactiveCooldownMs: Schema.number().default(3600000),
})
