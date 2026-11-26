/**
 * 一句话交给谁：总助理、用户显式点名的成员，还是正在讲解的那一位。
 *
 * 真机事故（2026-11-26）：成员「读者」讲解 PDF 时被插话打断，讲解一直停在那儿（讲解链还在），
 * 之后用户在总助理头顶的会话框里说「结束会议并整理成会议纪要」，全被送进了讲解成员的会话。
 * 根因是旧规则"只要讲解链还在、又是语音/朗读回复，就交给讲解人"。规则因此收紧成：
 * - 显式点名的成员（委派面板等）永远优先；
 * - 其余输入默认交给总助理；
 * - 只有讲解正在播放、或处于插话后的追问窗口里，且这句话是在问文档内容（不是会议/录音/纪要/
 *   提醒/邮件/打开应用之类的动作指令）时，才交给讲解人；讲解停了、讲完了，就不再交给讲解成员。
 *
 * 纯逻辑：不读时钟、不碰 IO。讲解与窗口状态由调用方传进来，每条规则都能被单测钉住。
 */

/**
 * 交给总助理办的业务动作，与复合委托判定共用同一套。
 * 文档动作（打开/讲解）不在这里：「解释一下这段」恰恰是在问文档。
 */
export const CHIEF_ACTION_PATTERNS: readonly RegExp[] = [
  // 会议与录音的开关
  /(?:(?:创建|新建|召开|发起|加入|开始|启动|开启|停止|结束|暂停|关闭).{0,14}(?:会议|开会|录音|录制|麦克风|回环)|(?:会议|开会|录音|录制).{0,14}(?:开始|启动|开启|停止|结束|暂停|关闭|录下来)|(?:先|再|然后|请|帮我)(?:给我|帮我)?录音|(?:^|先|再|然后|请|帮我|我们|去|现在)(?:给我|帮我|去)?开(?:个|一场|场)?会|开录|停录)/u,
  // 发送：邮件、消息、企微、微信
  /(?:发送|转发|邮寄|发(?:一封|给|到|至|往|送|邮件|信息|消息|企微|微信))/u,
  // 提醒：必须是动作指令（建/设/定/改/取消/提醒我…），不能把讲解里问「提醒功能是怎么实现的？」误判成建提醒。
  /(?:(?:建|创建|新建|设|设置|定|加|添|取消|暂停|删除|改|修改|关闭|帮我|给我|请|麻烦).{0,10}(?:提醒|催办|闹钟)|提醒我|定个?闹钟|设个?提醒|(?:分钟|小时|秒)后提醒|\d+点.{0,4}提醒)/u,
  // 搜索
  /(?:搜索|检索|查找|查询|查(?:看|找)?(?:一下)?(?:资料|信息|网页|文件|文档|报告))/u,
  // 安装软件
  /(?:安装|卸载|下载).{0,16}(?:插件|扩展|软件|应用|程序|工具)/u,
  // 翻译、导出
  /(?:翻译|润色|改写|导出)/u,
  // 存文件
  /(?:另存|保存|写入|生成|创建).{0,16}(?:文件|文档|报告|表格|word|pdf)/iu,
  // 开关应用、窗口
  /(?:打开|关闭|启动|停止|退出|切换).{0,12}(?:应用|软件|程序|浏览器|窗口|页面)/u,
]

/** 会议纪要：提到会议/录音/转写，又提到纪要/总结/整理。与 index.ts 的 mentionsMeetingMinutes 同一条规则。 */
const MINUTES_TOPIC = /(会议|开会|录音|转写)/u
const MINUTES_ACTION = /(纪要|总结|整理|归纳|摘要)/u

/**
 * 解释性追问：
 * - "为什么/怎么……"开头，或"这里/这段/这个……为什么/是什么"；
 * - 或任意位置问功能/原理/实现/机制的疑问句（如「提醒功能是怎么实现的？」「邮件值守是什么原理？」），
 *   前提是整句不是"帮我/请 + 创建/生成/停止/发送…"这类明确动作指令。
 */
const EXPLANATION_START = /^(?:(?:请问)?(?:为什么|为何|如何|怎么|怎样)|(?:这里|这段|这个|这份|它|刚才).{0,16}(?:为什么|为何|怎么|如何|是什么))/u
const EXPLANATION_PHRASE = /(?:怎么(?:实现|做|用|工作|运行|处理|触发|运作|配置|设计|做到|来)|如何(?:实现|工作|使用|处理|触发|运作)|什么(?:原理|机制|逻辑|意思|功能|作用|区别)|是什么|原理是什么|怎么回事|为啥|为什么|为何|是不是|能不能|会不会|支持.{0,8}吗|有什么(?:功能|区别|特点|限制|用))/u
const IMPERATIVE_START = /^(?:请|麻烦|帮我|给我|去|现在|立刻|马上)?(?:帮我|给我|请|麻烦)?(?:创建|新建|生成|整理|开始|启动|开启|停止|结束|暂停|关闭|发送|转发|删|删除|保存|打开|安装|卸载|下载)/u

/** 像在提问：交给讲解人时附上当前段原文追问，而不是当普通聊天发过去。 */
const DOC_QUESTION = /[？?]|什么|怎么|为什么|如何|哪|吗|呢|多少|是不是|能不能|这段|这里|这句|这个|刚才/u

export function isExplanationQuestion(text: string): boolean {
  const said = text.trim()
  if (EXPLANATION_START.test(said)) return true
  return !IMPERATIVE_START.test(said) && EXPLANATION_PHRASE.test(said)
}

export function isDocQuestion(text: string): boolean {
  return DOC_QUESTION.test(text)
}

/** 句子里出现了几类交给总助理办的业务动作（含会议纪要，不含文档动作）。 */
export function chiefActionCount(text: string): number {
  const minutes = MINUTES_TOPIC.test(text) && MINUTES_ACTION.test(text) ? 1 : 0
  return CHIEF_ACTION_PATTERNS.filter(pattern => pattern.test(text)).length + minutes
}

/** 这句话是不是给总助理的动作指令（会议/录音/纪要/提醒/邮件/打开应用……），而不是在问文档内容。 */
export function isChiefInstruction(text: string): boolean {
  const said = text.trim()
  return !isExplanationQuestion(said) && chiefActionCount(said) > 0
}

/** 讲解链的投影：路由只关心谁在讲、出不出声、停没停。 */
export interface PresenterState {
  /** 讲解人；为空表示总助理自己在讲。 */
  readonly assistantId?: string
  /** 出声讲解。打字要来的提纲只铺在面板上，不算"讲解在播"。 */
  readonly spoken: boolean
  /** 已暂停或停止。 */
  readonly stopped: boolean
}

export interface ChatRouteInput {
  readonly text: string
  /** 调用方显式点名的成员（委派面板等）。 */
  readonly explicitAssistantId?: string
  /** 复合委托：几件业务一起出现，整句原样交给总助理统一拆解。 */
  readonly compound: boolean
  /** 当前讲解链；没有为 null。 */
  readonly presenter: PresenterState | null
  /** 插话后的追问窗口：刚被口令/插话打断等提问、讲解人还在答问，或答完反问后的等待窗。 */
  readonly askWindow: boolean
}

export type ChatRoute =
  | { readonly to: 'explicit'; readonly assistantId: string }
  /** 交给讲解人；`ask` 为真时按文档追问附上当前段原文。assistantId 为空 = 总助理自己在讲。 */
  | { readonly to: 'presenter'; readonly assistantId?: string; readonly ask: boolean }
  | { readonly to: 'chief' }

export function routeChat(input: ChatRouteInput): ChatRoute {
  if (input.explicitAssistantId) return { to: 'explicit', assistantId: input.explicitAssistantId }
  const talk = input.presenter
  if (talk === null || input.compound || isChiefInstruction(input.text)) return { to: 'chief' }
  const ask = isDocQuestion(input.text)
  const live = talk.spoken && (!talk.stopped || input.askWindow)
  if (live) return { to: 'presenter', ...(talk.assistantId ? { assistantId: talk.assistantId } : {}), ask }
  // 总助理自己讲的文档：讲解人就是总助理，追问照旧附上当前段原文。成员讲解停了就不再交给成员。
  if (!talk.assistantId && ask) return { to: 'presenter', ask: true }
  return { to: 'chief' }
}
