/**
 * 会议录音期间的"语音停录"指令识别。
 *
 * ## 为什么不用唤醒词
 * 录音时渲染层用 `getUserMedia` 占着麦克风。独立的 `wake.ps1`（System.Speech）在 Windows 上
 * 拿不到音频 —— 日志里录音期间**零条「唤醒命中」**、连 `wake.ps1 识别到` 都没有，就是这件事。
 * 这是麦克风抢占，不是状态机问题，改仲裁器没用。
 *
 * 既然纪要本来就靠 ASR，指令也走 ASR：会议转写里出现明确指令就停录，不需要第二次抢麦克风。
 * 也不用去改会议采集的 `echoCancellation / noiseSuppression` 去"抢救唤醒词" —— 那会牺牲
 * 纪要质量，而纪要是这个功能的主产物。
 *
 * ## 为什么判据这么窄
 * 评审现场会说「我们停止录音的流程要改一下」，那是讨论不是指令。误判的代价是把会开一半停掉，
 * 比漏判（用户还能点按钮）严重得多。所以：
 * - 整句就是指令（`停录`、`结束会议`）→ 认；
 * - 带唤醒词（`小潘同学` / `小潘`）且**指令词落在句尾** → 认；
 * - 其余一律不认，包括"句子里出现了停止录音"和"指令词在句中"。
 *
 * 判据跑在**已定稿的分段文本**上（会议转写每块的最终结果），不再做二次猜测。
 */

/** 指令句的字数上限：超过这个长度就是一句话，不是给机器的指令。 */
export const RECORD_STOP_MAX_CHARS = 20

const WAKE_NAMES = /(小潘同学|小潘)/u
/** 停录类动词。`停录` 必须排在允许的后缀里单独出现，别被更长词吞掉。 */
const STOP_WORDS = '(?:停止录音|结束录音|停止录制|停录|结束会议)'
/** 整句即指令：允许礼貌前缀和语气后缀。 */
const BARE_COMMAND = new RegExp(`^(?:请|麻烦)?${STOP_WORDS}(?:吧|了|啦)?$`, 'u')
/** 带唤醒词时，指令词必须落在句尾。 */
const COMMAND_AT_END = new RegExp(`${STOP_WORDS}(?:吧|了|啦)?$`, 'u')

/**
 * 这句话是不是"停止录音"的指令。
 *
 * 纯函数：不读时钟、不碰 IO，所以每条边界都能在单测里钉住（真机上这些分支几乎没法复现 ——
 * 要有人在录音时恰好说出这句、而其他人又没说）。
 */
export function matchRecordStopCommand(text: string): boolean {
  if (typeof text !== 'string') return false
  const said = text.trim().replace(/[。！!，,、；;：:\s]+$/u, '')
  if (said === '') return false
  // 长句直接否掉：指令是短的。这条同时挡住"……停止录音的流程要改一下"这类长讨论。
  if ([...said].length > RECORD_STOP_MAX_CHARS) return false
  if (BARE_COMMAND.test(said)) return true
  return WAKE_NAMES.test(said) && COMMAND_AT_END.test(said)
}
