/**
 * 讲话队列：分句、播放游标、打断层级。
 *
 * 计划 §2.8 在这里有三条要求，都不是体验优化而是正确性问题：
 *
 * 1. **打断分四层** —— 停止播放 / 取消未播放合成 / 取消当前回答生成 / 申请取消实际任务。
 *    逐层升级："停止讲解"不该顺手把用户后台跑着的编译也撤了，只有"全部停下"才走到第四层。
 * 2. **跟踪已播放片段的 utteranceId、文档段落、句子序号与播放位置**。
 * 3. **打断后上下文只确认实际播放内容**。播到一半被掐掉的那句不能算说过 —— 算说了，
 *    模型会以为结论已经送达，接着往下讲，而用户根本没听到那句结论。
 *
 * 合成 worker（`tts-edge-worker.ts`）一次只吃一句，所以队列留在这里；它只负责把一句变成声音，
 * 以及在被要求停下时立刻停下。
 */

/** 这段讲话来自哪份文档的哪一段。讲解文档时才有，闲聊与回答没有。 */
export interface SpeechOrigin {
  readonly docPath: string
  readonly paragraph: number
}

export interface SpeechRequest {
  readonly utteranceId: string
  readonly text: string
  readonly origin?: SpeechOrigin
  readonly fromIndex?: number
  /**
   * 本次请求的第一句从第几号开始编号。
   *
   * 流式朗读要一段一段地喂同一句话，编号必须在各次之间接得上 —— 否则队列里会出现两个
   * 「#0」，续讲按序号定位时落在哪一句就说不准了。单次请求（文档整段、整条回复）不用传。
   */
  readonly indexBase?: number
  /**
   * 临时话语（快速应答旁路）：照常播出，但不算"这一轮对模型说过什么"。
   * 它不进 DSH 会话，打断后的上下文说明里也不能出现，否则等于间接进了会话。
   */
  readonly ephemeral?: boolean
  /**
   * 这一句用谁的音色说话：给一段**音色设计描述**，暂时覆盖当前语音服务上的描述。
   *
   * 用于"成员自己开口"：小张讲就用小张的描述；不传就沿用服务配置（总助理的声音）。
   */
  readonly voiceDesign?: string
  /**
   * 克隆出来的音色 ID（服务商侧）。优先于 voiceDesign：
   * 设计是"照描述演"，克隆是"就是那个声音"，后者更硬。
   */
  readonly voice?: string
  /** 语气/情绪/方言指令（走 user 消息）。 */
  readonly voiceStyle?: string
  /** 复刻样本文件路径（大样本走文件，不走内部管道）。 */
  readonly voiceSampleFile?: string
  /** 内联复刻样本（base64，不含 data: 前缀）。 */
  readonly voiceSample?: string
  readonly voiceSampleMime?: string
  /** 成员级 TTS 配置 id；空＝跟随全局选中。 */
  readonly ttsProfileId?: string
}

/** 切好的一句，是播放与打断的最小单位。 */
export interface Segment {
  readonly utteranceId: string
  readonly index: number
  readonly text: string
  readonly origin?: SpeechOrigin
  readonly ephemeral?: boolean
  /** 这一句的音色设计描述（来自说话人），缺省沿用服务配置。 */
  readonly voiceDesign?: string
  /** 克隆出来的音色 ID（服务商侧）。优先于 voiceDesign —— 克隆就是"就是那个声音"。 */
  readonly voice?: string
  /** 语气/情绪/方言指令（走 user 消息）。 */
  readonly voiceStyle?: string
  /** 复刻样本文件路径（大样本走文件，不走内部管道）。 */
  readonly voiceSampleFile?: string
  /** 内联复刻样本（base64，不含 data: 前缀）。 */
  readonly voiceSample?: string
  readonly voiceSampleMime?: string
  /** 成员级 TTS 配置 id；空＝跟随全局选中。 */
  readonly ttsProfileId?: string
}

/** 一句的播出结果。complete=false 表示播到一半被打断。 */
export interface SpokenRecord {
  readonly segment: Segment
  readonly complete: boolean
}

/**
 * 一句最长多少字。
 *
 * 这不是为了排版，是为了打断的粒度：一段没有标点的话要是不切，用户喊停之后还得听它
 * 把整段说完。中文按字算，六十个字大约是十二秒话。
 */
export const MAX_SEGMENT_CHARS = 60

/** 硬切时往回找逗号或空格的范围，避免把英文单词或一个短语从中间劈开。 */
const SOFT_CUT_LOOKBACK = 12

/* 换行不算句末：文档里一句话跨行排版时，按行断句会把没说完的话劈成两截播报。 */
const SENTENCE_ENDERS = new Set(['。', '！', '？', '；', '!', '?', ';', '…'])
const SOFT_CUT_POINTS = new Set(['，', '、', ',', ' ', ':', '：'])

/**
 * 一个片段值不值得念出来：至少得有一个字母或数字。
 *
 * 只有标点的片段（比如回答末尾跟着一串感叹号）对合成器是噪音，念出来是一声没来由的停顿。
 */
const WORTH_SPEAKING = /[\p{L}\p{N}]/u

/**
 * 讲解三段标签：`【原文】` / `【解释】` / `【补充】`，以及带后缀的变体（`【原文·第 3 页】`、
 * `【解释：这里说的是…】`）。
 *
 * `document.ts` 的 `explainPrompt` 要求模型分三段并各自标明，但模型经常连整块方括号一起吐
 * 出来。送进合成器就念成"方括号原文方括号"，听起来就是一台朗读器。
 *
 * **只删这三个词开头的方括号块，不无差别删所有 `【…】`**：`【会议结论】`、`【工作事项】`
 * 这类标签在耳朵里是有信息量的分隔，删掉会让后面那句话失去主语；而讲解三段标签的作用只是
 * 给屏幕排版，念出来纯属噪音。这是**白名单**——将来加新的讲解标签得往这里加，
 * 别图省事改成 `【[^】]*】`。
 *
 * 屏幕为什么不清洗：结构标签在屏幕上正是导航（用户一眼看出哪句是原文、哪句是补充），
 * 只有声音这一路需要口语化。所以清洗只发生在 `splitIntoSegments` 里，原文原样留在界面上。
 */
const EXPLAIN_LABEL = /【(?:原文|解释|补充)[^】]*】/gu

/**
 * 行首 / 句首的圆点与短横列表符号。
 *
 * `*` 后面必须跟空白才算列表，否则 `*斜体*` 会被吃掉星号、只剩半截记号；
 * `+` 不收 —— 正文里的加号（`A + B`）比列表更常见。
 */
const BULLET_MARK = /(?:^|(?<=[。！？；!?;\n]))[ \t]*[-*•][ \t]+/gmu

/**
 * 有序列表序号：`1. `、`1) `、`1、`。
 *
 * **点号后面必须有空白**，这是 `3.5 版本` 不被误伤的唯一依据：小数点的后面是数字，
 * 不是空格。用行首/句首锚点再加一层保险，避免把正文里的 "版本 1. 2" 之类当成列表。
 */
const ORDERED_MARK = /(?:^|(?<=[。！？；!?;\n]))[ \t]*(?:\d+[.)][ \t]+|\d+、[ \t]*)/gmu

/** 引用符号只在行首成立：正文中间的 `>` 多半是箭头（`->`），不该吃。 */
const QUOTE_MARK = /^[ \t]*>[ \t]?/gmu

/** Markdown 标题号。只在行首；正文中间的 `#` 是井号或标签。 */
const HEADING_MARK = /^[ \t]*#{1,6}[ \t]*/gmu

/** 成对的粗体 / 斜体记号：只去记号，里面的字要留下。 */
const EMPHASIS_MARK = /\*\*|__/gu

/**
 * 朗读前的文本清洗：去掉机器编号、讲解用的结构标签与列表符号。
 *
 * 两条原则：
 * - **只清洗声音这一路**。屏幕上保留原文（编号、标签、列表都是有用的结构），
 *   `splitIntoSegments` 在切句前调用本函数，界面从不经过这里。
 * - **只删能确定是"排版给眼睛看的"东西**。删不准的（所有方括号、正文里的星号与大于号）
 *   一律留着 —— 多念一个符号只是难听，少念一个字是信息丢失。
 *
 * 清洗后只剩空白时不做特殊处理：`splitIntoSegments` 的 `WORTH_SPEAKING` 会把这样的片段丢掉，
 * 在这里再造一套判断只会多一处会漂移的规则。
 */
export function cleanForSpeech(raw: string): string {
  return raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, '')
    .replace(/\b[0-9a-f]{32}\b/giu, '')
    .replace(/([：:])\s*([，,、。])/gu, '$2')
    .replace(/\s+([，,、。！？!?；;…])/gu, '$1')
    // 结构性的东西先摘掉，再统一收拢留下的空格（顺序不能反：先收空格的话，
    // 标签被删掉后原地会留下两个空格，而那时已经没有收拢规则兜着了）。
    .replace(EXPLAIN_LABEL, '')
    .replace(BULLET_MARK, '')
    .replace(ORDERED_MARK, '')
    .replace(QUOTE_MARK, '')
    .replace(HEADING_MARK, '')
    .replace(EMPHASIS_MARK, '')
    // 列表/标题清洗依赖行首锚点，必须等它们跑完再把换行归一成空格，
    // 否则跨行的同一句会被合成器念出两次停顿。
    .replace(/\r?\n/gu, ' ')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim()
}

/**
 * 把一次讲话请求切成正好由合成器一口吃掉的那些句子。
 *
 * 标点留在句尾（合成器要靠它决定停顿），空白段直接丢掉，序号从 0 递增 ——
 * 序号是"播放位置"的一部分，续讲要靠它接着往下走。
 */
export function splitIntoSegments(request: SpeechRequest): readonly Segment[] {
  const { sentences, rest } = drainSentences(cleanForSpeech(request.text))
  /* 相邻短句先并段再合成，减少"两三个字就发一次请求"造成的句间卡顿。 */
  const raw = rest.length > 0 ? [...sentences, rest] : sentences
  const pieces = shortMergeEnabled ? mergeShortPieces(raw) : raw

  const base = request.indexBase ?? 0
  const segments: Segment[] = []
  for (const piece of pieces) {
    const trimmed = piece.trim()
    if (!WORTH_SPEAKING.test(trimmed)) continue
    segments.push({
      utteranceId: request.utteranceId,
      index: base + segments.length,
      text: trimmed,
      ...(request.origin ? { origin: request.origin } : {}),
      ...(request.ephemeral ? { ephemeral: true } : {}),
    ...(request.voiceDesign === undefined ? {} : { voiceDesign: request.voiceDesign }),
    ...(request.voice === undefined ? {} : { voice: request.voice }),
    ...(request.voiceStyle === undefined ? {} : { voiceStyle: request.voiceStyle }),
    ...(request.voiceSampleFile === undefined ? {} : { voiceSampleFile: request.voiceSampleFile }),
    ...(request.voiceSample === undefined ? {} : { voiceSample: request.voiceSample }),
    ...(request.voiceSampleMime === undefined ? {} : { voiceSampleMime: request.voiceSampleMime }),
    ...(request.ttsProfileId === undefined ? {} : { ttsProfileId: request.ttsProfileId }),
    })
  }
  return segments
}

/**
 * 把已经攒到的文本切成"能念的整句"，末尾没说完的一截原样退回。
 *
 * 流式朗读靠它一段一段地推进：只有完整的句子才值得送去合成，半句送过去会切在词中间。
 * `splitIntoSegments` 与 `Narrator.feed` 共用这一份切法 —— 两处各写一套，接缝处迟早会吞字或重念。
 */
/** 是否合并相邻短句。默认关闭：它会改变播报与打断的粒度，由用户在设置里打开。 */
let shortMergeEnabled = false

export function configureSpeech(options: { mergeShortSentences?: boolean }): void {
  shortMergeEnabled = options.mergeShortSentences === true
}

const MERGE_MIN_CHARS = 10
const MERGE_MAX_CHARS = 90

/**
 * 把相邻的短句并成一段。
 *
 * 以前一句一次合成请求：碰上"好。""嗯。""行。"这种两三个字的句子，
 * 网络往返的开销远大于音频本身，听感就是每句之间卡一下。
 * 合并只改**发请求的粒度**：不换顺序、不跨两个长句硬粘。
 */
function mergeShortPieces(pieces: readonly string[]): string[] {
  const merged: string[] = []
  let buffer = ''
  for (const raw of pieces) {
    const piece = raw.trim()
    if (piece === '') continue
    /*
      短句一律并掉：累计到 MERGE_MIN_CHARS 个字才发出去，
      超过 MERGE_MAX_CHARS 才强制断（一次塞太多，首字延迟反而更长）。
    */
    buffer = buffer === '' ? piece : buffer + piece
    if (buffer.length >= MERGE_MIN_CHARS) {
      merged.push(buffer)
      buffer = ''
    }
  }
  if (buffer !== '') merged.push(buffer)
  return merged
}

export function drainSentences(text: string): { sentences: readonly string[]; rest: string } {
  const sentences: string[] = []
  let current = ''

  for (const char of text) {
    current += char
    if (SENTENCE_ENDERS.has(char)) {
      sentences.push(current)
      current = ''
    } else if (current.length >= MAX_SEGMENT_CHARS) {
      // 退到逗号上切的时候，逗号之后那截还没说完，得留着继续攒 —— 清空就是把字吞了。
      const cut = cutSoftly(current)
      sentences.push(cut)
      current = current.slice(cut.length)
    }
  }
  return { sentences, rest: current }
}

/** 到了长度上限还没有句末标点：优先退到最近的逗号或空格上切。 */
function cutSoftly(chunk: string): string {
  for (let back = 1; back <= SOFT_CUT_LOOKBACK && back < chunk.length; back++) {
    const at = chunk.length - back
    if (SOFT_CUT_POINTS.has(chunk[at])) return chunk.slice(0, at + 1)
  }
  return chunk
}

export interface SpeechState {
  /** 切好了但还没交给合成器的句子。 */
  readonly queue: readonly Segment[]
  /** 已经交给合成器、正在出声的那一句。 */
  readonly playing: Segment | null
  /** 播出记录，按时间顺序。打断之后要告诉模型的东西全在这里。 */
  readonly spoken: readonly SpokenRecord[]
  /** 回答还在流式生成中。第三层打断要取消的就是它。 */
  readonly generating: boolean
  /** 已经申请过取消实际任务。第四层打断只该申请一次。 */
  readonly taskCancelRequested: boolean
}

/**
 * 打断层级，从只让它闭嘴到把后台的活也停掉。
 *
 * 数值就是包含关系：高层级必然做低层级的事。计划里特意写了"停止讲解不默认撤销后台编译，
 * '全部停下'才进入紧急停止"，所以这四层不能塌成一个"全停"按钮。
 */
export const INTERRUPT_LEVELS = ['stop-playback', 'drop-queue', 'cancel-generation', 'cancel-task'] as const
export type InterruptLevel = (typeof INTERRUPT_LEVELS)[number]

const LEVEL_RANK: Record<InterruptLevel, number> = {
  'stop-playback': 1,
  'drop-queue': 2,
  'cancel-generation': 3,
  'cancel-task': 4,
}

export type SpeechEvent =
  | { readonly type: 'enqueue'; readonly request: SpeechRequest }
  /** 回答开始流式生成。 */
  | { readonly type: 'generation-started' }
  | { readonly type: 'generation-ended' }
  /** 队首已经交给合成器。 */
  | { readonly type: 'dispatched' }
  /** 合成器报 finished：这一句完整播出去了。 */
  | { readonly type: 'spoken' }
  /** 合成器报 cancelled：这一句只播了一半。 */
  | { readonly type: 'cut' }
  | { readonly type: 'interrupt'; readonly level: InterruptLevel }
  /** 只丢指定话语（快答交棒）：队列里其他句子不受影响。 */
  | { readonly type: 'drop-utterance'; readonly utteranceId: string }

export type SpeechEffect = 'stop-audio' | 'cancel-generation' | 'request-task-cancel'

export interface SpeechTransition {
  readonly state: SpeechState
  readonly effects: readonly SpeechEffect[]
}

export const INITIAL_SPEECH_STATE: SpeechState = {
  queue: [],
  playing: null,
  spoken: [],
  generating: false,
  taskCancelRequested: false,
}

/**
 * 现在该把哪一句交给合成器。
 *
 * 正在出声时一律返回 null：合成进程一次只吃一句，塞第二句它会拒（报 busy），
 * 而拒了之后这句就丢了 —— 所以由这里把住"一次一句"。
 */
export function pendingDispatch(state: SpeechState): Segment | null {
  if (state.playing !== null) return null
  return state.queue.length > 0 ? state.queue[0] : null
}

function at(state: SpeechState, effects: readonly SpeechEffect[] = []): SpeechTransition {
  return { state, effects }
}

export function nextSpeech(state: SpeechState, event: SpeechEvent): SpeechTransition {
  switch (event.type) {
    case 'enqueue': {
      const segments = splitIntoSegments(event.request).filter(segment => segment.index >= (event.request.fromIndex ?? 0))
      if (segments.length === 0) return at(state)
      return at({ ...state, queue: [...state.queue, ...segments] })
    }

    case 'generation-started':
      return at({ ...state, generating: true })

    case 'generation-ended':
      return at({ ...state, generating: false })

    case 'dispatched': {
      const head = pendingDispatch(state)
      if (head === null) return at(state)
      return at({ ...state, queue: state.queue.slice(1), playing: head })
    }

    case 'spoken': {
      // 合成器可能因为超时和正常结束各报一次，第二次必须什么都不做。
      if (state.playing === null) return at(state)
      return at({
        ...state,
        playing: null,
        spoken: [...state.spoken, { segment: state.playing, complete: true }],
      })
    }

    case 'cut': {
      if (state.playing === null) return at(state)
      // 半句也要记下来，而且必须标成没播完：这是"打断后只确认实际播放内容"的落点。
      return at({
        ...state,
        playing: null,
        spoken: [...state.spoken, { segment: state.playing, complete: false }],
      })
    }

    case 'drop-utterance': {
      const queue = state.queue.filter(segment => segment.utteranceId !== event.utteranceId)
      if (state.playing !== null && state.playing.utteranceId === event.utteranceId) {
        return at({
          ...state,
          queue,
          playing: null,
          spoken: [...state.spoken, { segment: state.playing, complete: false }],
        }, ['stop-audio'])
      }
      return at({ ...state, queue })
    }

    case 'interrupt':
      return interrupt(state, event.level)
  }
}

function interrupt(state: SpeechState, level: InterruptLevel): SpeechTransition {
  const rank = LEVEL_RANK[level]
  const effects: SpeechEffect[] = []
  let next = state

  // 第一层：让它闭嘴。正在播的那一句记成没播完 —— 它既不算说过，也不能当作没发生过。
  if (next.playing !== null) {
    effects.push('stop-audio')
    next = {
      ...next,
      playing: null,
      spoken: [...next.spoken, { segment: next.playing, complete: false }],
    }
  }

  // 第二层：还没交给合成器的也丢掉。留着的话下一句马上就会开播，等于没打断。
  if (rank >= LEVEL_RANK['drop-queue']) {
    next = { ...next, queue: [] }
  }

  if (rank >= LEVEL_RANK['cancel-generation'] && next.generating) {
    effects.push('cancel-generation')
    next = { ...next, generating: false }
  }

  // 第四层只申请一次：反复申请取消同一个任务，只会让用户被同一个确认框问好几遍。
  if (rank >= LEVEL_RANK['cancel-task'] && !next.taskCancelRequested) {
    effects.push('request-task-cancel')
    next = { ...next, taskCancelRequested: true }
  }

  return at(next, effects)
}

/**
 * 打断之后要交给模型的"用户实际听到了什么"。
 *
 * 只列真的播出去的句子，半句必须标明是半句。少了这层区分，模型会以为结论已经送达而接着
 * 往下讲 —— 用户听到的却是半句话加一段沉默。
 */
export function describeSpoken(state: SpeechState): string {
  return describeRecords(state.spoken)
}

/**
 * 同上，但只描述给定的那几条记录。
 *
 * 驱动器要的是"当前这一轮播出了什么"：`state.spoken` 是跨轮累积的（文档续讲要靠它接着往下
 * 走），把上一轮的整段回答也塞进打断说明里，模型就分不清被打断的是哪一段了。
 */
export function describeRecords(records: readonly SpokenRecord[]): string {
  const complete = records.filter((record) => record.complete).map((record) => record.segment.text)
  const partial = records.filter((record) => !record.complete).map((record) => record.segment.text)
  if (complete.length === 0 && partial.length === 0) return NOTHING_SPOKEN
  const lines: string[] = []
  if (complete.length > 0) lines.push('已完整播出：' + complete.join(''))
  for (const text of partial) lines.push('只播出一半就被打断：' + text)
  return lines.join('\n')
}

/** 一句都没播出去时的占位文案。调用方要能把它和"真播过"区分开。 */
export const NOTHING_SPOKEN = '（还没有播出任何内容）'

/** 续讲从哪一句接着走：播出记录里最后一个完整句子的下一句。没有记录就从头开始。 */
export function resumeIndex(state: SpeechState, utteranceId: string): number {
  let last = -1
  for (const record of state.spoken) {
    if (record.segment.utteranceId !== utteranceId) continue
    if (record.complete) last = Math.max(last, record.segment.index)
  }
  return last + 1
}
