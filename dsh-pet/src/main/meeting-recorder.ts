/**
 * 会议闭环编排（主进程侧）：开始/推块/停止/结算/转写/说话人修订/纪要确认。
 *
 * 数据流（M4-02 起分轨）：渲染层 getUserMedia 采麦克风与系统回环声，**每一路单独缓冲、单独
 * 送块**（约 4 秒一块，16kHz mono Int16 base64），块带音源、轨内序号、起点（相对会议开始的
 * 毫秒）、原始采样率与 16k 帧数。这里校验后立即加密落盘（MeetingStore），两路各成一条时间轴，
 * 绝不交错拼接。停止时先让渲染层停流并冲刷两路最后一块（meeting-stopping → meetingFlushDone），
 * **再**结算与转写——顺序反了会丢最后几秒。
 *
 * 转写分两层（M4-04）：
 * - 临时字幕：录音中每块落盘后异步逐块转写，只放内存、经状态推给会议页，**不落库**；
 * - 会后精修（M4-05）：停录后按音轨取完整时间轴（块间缺口补静音并记录），本地模型做说话人
 *   分离，按分离出的段转写，结果整体写库并替换临时字幕。说话人 id 带音源前缀（mic-s1 /
 *   loop-s2），仍全部 uncertain=true——机器分的组只是建议，改名/合并/拆分照旧由用户定。
 *   模型缺失或分离失败就退回逐块转写，说明里如实写"未自动分人"。不建跨会议声纹库，不保存
 *   嵌入向量：分离只给出"哪段时间是这条音轨的第几号人"。
 *
 * 写库按版本：精修开始时记下段 revision，写入时库里已被人工修订就不覆盖（乐观锁）；整体重转
 * 遇到人工修订只重试失败片段。转写失败的片段写成 source='failed' 的占位段（缺口如实可见），
 * 可单独重试，重试只替换占位段本身，不碰其余段与用户改过的名字。
 * 助理播报区间（narrator 打点）在转写上落实：与之高度重叠的段标为助理播报，不算真人发言。
 *
 * 纪要（M4-06）两个版本：
 * - 本地模板版：转写写库后自动生成，不经模型，如实标"未经模型"；
 * - 模型草稿：用户在会议页点「用模型生成纪要」→ 先经 confirmEgress（主进程原生对话框）取得
 *   这场会议、这一转写版本的数据去向授权（发什么、发给谁）→ summarize 调模型 → 逐条校验来源
 *   （meeting-minutes.ts）→ 写库。授权按会议记录、可撤销；拒绝时一个字都不发。模型不可用或
 *   输出非法时如实失败，纪要保持本地模板版。改转写/改说话人/改纪要稿都会让旧确认失效。
 *
 * 本模块不 import electron：IPC 通过 registerMeetingIpc(deps) 注入 ipcMain 形状的对象，
 * 于是编排逻辑能在纯 Node 下单测。
 */
import type { AudioEvent, AudioTransition } from './audio.ts'
import { randomBytes } from 'node:crypto'
import {
  applyItemPatch,
  asItemPatch,
  buildMinutesPrompt,
  parseModelReply,
  parseStructured,
  renderStructuredSections,
  validateModelMinutes,
  type StructuredMinutes,
} from './meeting-minutes.ts'
import {
  ASSISTANT_SPEAKER,
  applyAssistantSpeech,
  buildTrackTimeline,
  diarizeTimelineSamples,
  fallbackSpans,
  sliceTimeline,
  splitLongSpans,
  spansFromTurns,
  trackDisplayName,
  trackUnknownSpeakerId,
  uncoveredVoicedSpans,
  type DiarizeFn,
  type DiarizeResult,
  type PlannedSpan,
  type TimelineInputChunk,
  type TrackTimeline,
} from './diarize.ts'
import {
  MeetingStore,
  isMeetingTrack,
  validateMeetingConsent,
  type AssistantSpeechSpan,
  type MeetingConsentInput,
  type MeetingRow,
  type MeetingSources,
  type MeetingStoreDeps,
  type MeetingTrack,
  type MinutesRecord,
  type TranscriptMode,
  type TranscriptSegment,
} from './meeting-store.ts'

/** asr.ts 的返回形状（避免静态 import 把 sherpa-onnx 原生模块拖进测试进程）。 */
export interface MeetingAsrResult {
  ok: boolean
  text?: string
  error?: string
}

export type TranscribePhase = 'idle' | 'transcribing' | 'transcribed' | 'transcript-failed'

/** 渲染层每块随 PCM 一起报上来的时间轴信息。 */
export interface MeetingChunkMeta {
  readonly track: MeetingTrack
  /** 轨内单调递增序号（每条音轨从 0 起）。 */
  readonly seq: number
  /** 块起点，相对会议开始的毫秒数（采集端按样本计数推算）。 */
  readonly startMs: number
  /** 采集端原始采样率（重采样到 16k 之前）。 */
  readonly sampleRate: number
  /** 重采样到 16k 后的帧数，必须等于 PCM 字节数 / 2。 */
  readonly frames: number
}

/** 一条临时字幕（录音中逐块转写，只在内存，停录精修后被替换）。 */
export interface LiveCaption {
  readonly track: MeetingTrack
  readonly trackSeq: number
  readonly startMs: number
  readonly endMs: number
  /** pending 排队中；ok 有文字；empty 没听到说话；failed 这块临时转写失败；skipped 积压被跳过。 */
  readonly status: 'pending' | 'ok' | 'empty' | 'failed' | 'skipped'
  readonly text?: string
  /** 与已知的助理播报区间高度重叠。 */
  readonly assistant?: boolean
}

/** 录音中一条音轨的进度。 */
export interface MeetingTrackState {
  readonly track: MeetingTrack
  readonly chunks: number
  readonly recordedMs: number
  readonly lastEndMs: number | null
}

/** 推给面板的运行时状态。界面只是投影，真源在这里与 MeetingStore。 */
export interface MeetingRuntimeState {
  readonly recording: boolean
  readonly stopping: boolean
  readonly meetingId: string | null
  readonly name: string
  readonly sources: MeetingSources | null
  readonly startedAt: number | null
  /** 拿不到的音轨（loopback 采不到时如实标缺失，不伪造静音块）。 */
  readonly missingTracks: ReadonlyArray<MeetingTrack>
  /**
   * 缺失原因，按轨记。麦克风缺授权要去开麦克风，系统音频缺授权要去开屏幕录制 ——
   * 没有这一项，界面只能说"没录到"，用户不知道该改哪个开关。
   */
  readonly missingTrackReasons: Readonly<Partial<Record<MeetingTrack, string>>>
  readonly transcribe: TranscribePhase
  readonly transcribeNote: string | null
  /** 最近结束（或正在进行）的会议，供面板接着做转写状态/修订/纪要。 */
  readonly lastMeetingId: string | null
  readonly recent: ReadonlyArray<{ id: string; name: string; startedAt: number; state: string }>
  /** 录音中各音轨的收块进度（没在录时为空）。 */
  readonly tracks: ReadonlyArray<MeetingTrackState>
  /** 临时字幕：录音中与精修完成前展示；精修写库后清空，界面改看库里的段。 */
  readonly live: { readonly meetingId: string; readonly captions: ReadonlyArray<LiveCaption> } | null
}

export interface MeetingRecorderDeps {
  readonly store: MeetingStore
  readonly userDataDir: string
  /** 主进程的麦克风仲裁（index.ts 的 applyAudio 形状）。 */
  readonly audio: (event: AudioEvent) => AudioTransition
  /** 往渲染层发事件（index.ts 的 sendToRenderer 形状）。 */
  readonly notifyRenderer: (channel: string, payload: unknown) => void
  /** 转写实现。默认懒加载 asr.ts 的 transcribeWav（内含 trimSilence）；测试注入假的。 */
  readonly transcribe?: (wav: ArrayBuffer, userDataDir: string) => Promise<MeetingAsrResult>
  /** 说话人分离实现。默认 diarize.ts（本地模型、Worker 里跑）；测试注入替身。 */
  readonly diarize?: DiarizeFn
  /**
   * 录音中逐块做临时转写（临时字幕）。createMeetingRecorder（生产接线）默认开；
   * 直接 new 时默认关，免得测试里转写调用次数不确定。
   */
  readonly liveCaptions?: boolean
  readonly now?: () => number
  /** 通知渲染层停流后，等它冲刷最后一块的超时。到点强制结算，不能永远挂着。 */
  readonly flushTimeoutMs?: number
  /**
   * 模型调用（M4-06），由主代理接到 bridge.chat。prompt 里的会议文字已包成不可信数据；
   * signal 中止（撤销授权、超时、退出）时应尽快返回。不注入 = 模型不可用，纪要保持本地模板版。
   */
  readonly summarize?: MeetingSummarizeFn
  /**
   * 数据去向授权（M4-06），由主代理在 index.ts 用主进程原生对话框实现：把 summary 原文展示
   * 给用户，用户明确点「同意发送」才 resolve(true)；关窗/取消/出错一律 false。
   * 只会在用户从会议页发起生成时调用，模型输出永远不会触发它。不注入 = 不发送。
   */
  readonly confirmEgress?: MeetingConfirmEgressFn
  /** 授权摘要里写的接收方。默认"当前助理会话所用的模型服务商"。 */
  readonly egressTarget?: string
  /** 等模型回复的上限，到点中止，结果不采用。默认 180 秒。 */
  readonly summarizeTimeoutMs?: number
}

export type MeetingSummarizeFn = (prompt: string, signal?: AbortSignal) => Promise<{ ok: boolean; reply?: string; error?: string }>
export type MeetingConfirmEgressFn = (summary: string) => Promise<boolean>

const DEFAULT_EGRESS_TARGET = '当前助理会话所用的模型服务商'

const SAMPLE_RATE = 16000
const FRAMES_PER_MS = SAMPLE_RATE / 1000
const TRACK_ORDER: readonly MeetingTrack[] = ['mic', 'loopback']
/** 失败占位段的文字。它带 source='failed'，任何地方都不会把它当成转写原文。 */
export const FAILED_SEGMENT_TEXT = '〔这段转写失败，录音已保留，可重试〕'
/** asr.ts 对"整段没有人声"的报错原文（ERROR_MESSAGES['timeout-empty']）：这不是失败，是没人说话。 */
const NO_SPEECH_ERROR = '没有听到说话内容'
/** 临时字幕积压上限：转写跟不上时宁可跳过旧块，也不让内存无限涨。 */
const LIVE_BACKLOG = 6
/** 状态里最多带多少条临时字幕（界面只显示最近的）。 */
const LIVE_BROADCAST_LIMIT = 80
/** 采集端时间戳最多允许比接收时间超前多少（两进程墙钟差 + 传输），超出按接收时间修正。 */
const START_SKEW_MS = 2000

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

interface TrackProgress {
  lastSeq: number
  lastEndMs: number
  chunks: number
  recordedFrames: number
}

interface ActiveMeeting {
  readonly meetingId: string
  readonly name: string
  readonly sources: MeetingSources
  readonly startedAt: number
  stopping: boolean
  finalized: boolean
  missingTracks: MeetingTrack[]
  /**
   * 缺失的原因，按轨记。
   *
   * 只有"缺了"这个事实是不够的：麦克风没授权和"系统音频没授权"要给用户完全不同的下一步
   * （前者去开麦克风，后者去开屏幕录制），而界面上只写"对方的声音没录到"时，
   * 用户根本不知道该去改哪个开关。
   */
  missingTrackReasons: Partial<Record<MeetingTrack, string>>
  readonly tracks: Map<MeetingTrack, TrackProgress>
}

interface LastMeeting {
  readonly meetingId: string
  readonly name: string
  readonly sources: MeetingSources
  readonly startedAt: number
  readonly missingTracks: ReadonlyArray<MeetingTrack>
  readonly missingTrackReasons: Readonly<Partial<Record<MeetingTrack, string>>>
}

interface LiveEntry {
  storeSeq: number
  caption: LiveCaption
}

type AsrOutcome = { kind: 'ok'; text: string } | { kind: 'empty' } | { kind: 'failed'; error: string }

/** 转写结果三分：有字 / 没人说话 / 真失败。只有真失败才留缺口等重试。 */
function classifyAsr(result: MeetingAsrResult): AsrOutcome {
  if (result.ok && typeof result.text === 'string' && result.text.trim() !== '') return { kind: 'ok', text: result.text.trim() }
  if (result.ok || result.error === NO_SPEECH_ERROR) return { kind: 'empty' }
  return { kind: 'failed', error: result.error ?? '识别失败' }
}

/** PCM（16kHz mono Int16LE）前面拼一个 44 字节 wav 头。 */
export function buildWav16kMono(pcm: Buffer | Uint8Array): ArrayBuffer {
  const data = Buffer.from(pcm)
  const out = Buffer.alloc(44 + data.length)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + data.length, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20) // PCM
  out.writeUInt16LE(1, 22) // mono
  out.writeUInt32LE(SAMPLE_RATE, 24)
  out.writeUInt32LE(SAMPLE_RATE * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(data.length, 40)
  data.copy(out, 44)
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
}

function mmss(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '--:--'
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatTime(wallMs: number | null): string {
  if (wallMs === null) return '（未记录）'
  const d = new Date(wallMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function trackListText(tracks: readonly string[]): string {
  return tracks.map(track => (isMeetingTrack(track) ? `${trackDisplayName(track)}（${track}）` : track)).join('、')
}

export interface MinutesInput {
  readonly name: string
  readonly startedAt: number
  readonly endedAt: number | null
  readonly sources: MeetingSources
  readonly consentText: string
  readonly retentionDays: number
  readonly segments: readonly TranscriptSegment[]
  readonly assistantSpeech: readonly AssistantSpeechSpan[]
  readonly missingTracks: readonly string[]
  /**
   * 缺失原因，按轨记。纪要里要写出来 —— "音轨缺失"只说没录到，
   * 说明缺的是屏幕录制权限还是 Linux 没实现，用户才知道能不能补救。
   */
  readonly missingTrackReasons?: Readonly<Partial<Record<MeetingTrack, string>>>
  /** 转写说明（分人情况、断流、失败片段）。没有就不写这一行。 */
  readonly transcriptNote?: string | null
  /** 生成方式。不传 = 本地模板版。模型版带校验后的结构化条目。 */
  readonly generation?: MinutesGeneration
}

export type MinutesGeneration = { readonly kind: 'local' } | { readonly kind: 'model'; readonly structured: StructuredMinutes }

/** 给会议页的纪要：库里那份 + 解析好的结构化条目 + 是否落后于当前转写版本。 */
export type MinutesView = Omit<MinutesRecord, 'structured'> & {
  readonly structured: StructuredMinutes | null
  /** 纪要基于的转写版本比当前旧（确认已失效，需重新生成）。 */
  readonly stale: boolean
}

export interface MeetingMinutesView {
  readonly ok: true
  readonly minutes: MinutesView | null
  /** 本场会议的数据去向授权：当前是否有效、当时同意的原文、历史事件（不含原文）。 */
  readonly egress: {
    readonly active: { readonly at: number; readonly revision: number | null; readonly summary: string } | null
    readonly history: ReadonlyArray<{ readonly type: 'granted' | 'denied' | 'revoked'; readonly at: number; readonly revision?: number }>
    readonly undecryptable?: true
  }
  /** 模型是否接入（summarize 与 confirmEgress 都注入才算），以及这场会议是否正在生成。 */
  readonly model: { readonly available: boolean; readonly generating: boolean }
  /** 当前转写版本。 */
  readonly revision: number
}

/** sent：会议文字是否已经发出去了（失败发生在发送前还是发送后，给用户的话不一样）。 */
export type MinutesGenerateResult =
  | { readonly ok: true; readonly kept: number; readonly rejected: number; readonly prompted: boolean; readonly sent: true }
  | { readonly ok: false; readonly error: string; readonly sent: boolean }

/**
 * 生成纪要正文（这就是导出文本，界面预览的也是它）。
 *
 * 本地模板版：议题=会议名、时间线=逐段文本、行动项留空待用户填，并注明未经模型。
 * 模型版：摘要/决议/待办三节只列通过来源校验的条目，每条带段号、时间与说话人；剔除的
 * 只计数、不进正文；没说出的负责人/期限写"待确认"。时间线照旧附上，便于对照原话。
 *
 * 助理播报区间单列一节并注明不算真人发言——TTS 的声音被 loopback 录进去时，
 * 不能让它冒充参会者说过的话；与播报高度重叠的转写段不进时间线。
 */
export function buildMinutesContent(input: MinutesInput): string {
  const generation = input.generation ?? { kind: 'local' as const }
  const lines: string[] = []
  lines.push(`# 会议纪要：${input.name}`)
  lines.push('')
  lines.push(`- 时间：${formatTime(input.startedAt)} — ${formatTime(input.endedAt)}`)
  lines.push(`- 录音来源：${input.sources === 'mic+loopback' ? '麦克风 + 系统回环声' : '麦克风'}`)
  if (input.missingTracks.length > 0) {
    lines.push(`- 音轨缺失：${trackListText(input.missingTracks)}（缺失期间未录到内容，不做推测）`)
    // 原因单列一行：纪要要能回答"这场为什么只有一半声音"，而不只是"少了一轨"。
    const reasons = input.missingTracks
      .map(track => (isMeetingTrack(track) ? input.missingTrackReasons?.[track] : undefined))
      .filter((reason): reason is string => typeof reason === 'string' && reason !== '')
    if (reasons.length > 0) lines.push(`- 缺失原因：${reasons.join('；')}`)
  }
  if (input.transcriptNote !== undefined && input.transcriptNote !== null && input.transcriptNote !== '') {
    lines.push(`- 转写说明：${input.transcriptNote}`)
  }
  lines.push(`- 知情同意：${input.consentText}`)
  lines.push(`- 保留期：${input.retentionDays} 天（到期自动删除录音分块；转写与纪要保留）`)
  if (generation.kind === 'model') {
    const structured = generation.structured
    const rejected = structured.items.filter(item => item.status === 'rejected').length
    lines.push(
      `- 纪要生成：模型草稿（基于转写 revision ${structured.basedOnRevision}；每条均已核对来源` +
        (rejected > 0 ? `，另有 ${rejected} 条无来源或无法核对，已剔除，不进入本纪要` : '') +
        '；原文没说出的负责人/期限标"待确认"）',
    )
    lines.push(`- 数据去向：本场转写的 ${structured.sentSegments} 段真人发言文字经你同意（${formatTime(structured.egressGrantedAt)}）发送给模型服务商`)
    lines.push('')
    lines.push(...renderStructuredSections(structured))
  } else {
    lines.push('- 纪要生成：本地模板（未经模型；不含摘要与决议，行动项待人工填写）')
    lines.push('')
  }
  lines.push('## 时间线')
  const people = input.segments.filter(segment => segment.source !== 'assistant')
  const assistantSegments = input.segments.length - people.length
  if (people.length === 0) {
    lines.push('- （没有可用的转写内容）')
  } else {
    for (const segment of people) {
      // 段号与界面上的段号、纪要条目的〔来源：段N〕一致，导出文本里也能对回原话。
      const when = `段${segment.idx + 1} [${mmss(segment.startMs)}–${mmss(segment.endMs)}]`
      if (segment.source === 'failed') {
        lines.push(`- ${when} ${segment.label}：（这段转写失败，录音已保留，可在会议页重试；不做推测）`)
        continue
      }
      const uncertain = segment.uncertain ? '（说话人未经确认）' : ''
      lines.push(`- ${when} ${segment.label}${uncertain}：${segment.text}`)
    }
  }
  lines.push('')
  lines.push('## 助理播报区间（不算真人发言）')
  if (input.assistantSpeech.length === 0 && assistantSegments === 0) {
    lines.push('- 无')
  } else {
    for (const span of input.assistantSpeech) {
      lines.push(`- [${mmss(span.startMs)}–${mmss(span.endMs)}] 桌面助理 TTS 播报；此区间的声音是助理自己，不代表任何参会者发言`)
    }
    if (assistantSegments > 0) {
      lines.push(`- 另有 ${assistantSegments} 段转写与播报高度重叠，已从时间线排除，不计为任何参会者的发言`)
    }
  }
  lines.push('')
  if (generation.kind === 'local') {
    lines.push('## 行动项')
    lines.push('- （待填写：由与会人确认后补充）')
    lines.push('')
  }
  return lines.join('\n')
}

/** 一条音轨在精修里的结局，用来写说明。 */
interface TrackReport {
  readonly track: MeetingTrack
  readonly diarized: boolean
  readonly speakers: number
  readonly reason: string | null
  readonly overlaps: number
  readonly timeline: TrackTimeline
}

/** 精修说明（存进 transcript_meta.note）：分人情况、断流、坏块、助理播报。失败片段数另算（动态）。 */
function composeRefineNote(input: {
  reports: readonly TrackReport[]
  corrupted: number
  assistantMarked: number
  assistantTrimmed: number
  recovered: number
}): { mode: TranscriptMode; note: string } {
  const parts: string[] = []
  const diarized = input.reports.filter(report => report.diarized)
  const undiarized = input.reports.filter(report => !report.diarized)
  let mode: TranscriptMode
  if (input.reports.length === 0) {
    mode = 'undiarized'
    parts.push('没有录到任何音频')
  } else if (undiarized.length === 0) {
    mode = 'diarized'
    parts.push(`已自动分人（本机模型，只在本场会议内分组，说话人待确认）：${diarized.map(report => `${trackDisplayName(report.track)} ${report.speakers} 人`).join('、')}`)
  } else {
    const reasons = [...new Set(undiarized.map(report => report.reason ?? '原因未知'))]
    const why = reasons.join('；')
    if (diarized.length === 0) {
      mode = 'undiarized'
      parts.push(`未自动分人（${why}）：已按音源逐块转写，每条音轨归为一组，说话人请手动修订`)
    } else {
      mode = 'partial'
      parts.push(
        `${diarized.map(report => `${trackDisplayName(report.track)}已自动分人（${report.speakers} 人）`).join('，')}；` +
          `${undiarized.map(report => trackDisplayName(report.track)).join('、')}未自动分人（${why}），整条音轨归为一组`,
      )
    }
  }
  for (const report of input.reports) {
    const gaps = report.timeline.gaps.filter(gap => gap.reason === 'gap')
    if (gaps.length > 0) {
      const seconds = Math.round(gaps.reduce((sum, gap) => sum + (gap.endMs - gap.startMs), 0) / 1000)
      parts.push(`${trackDisplayName(report.track)}断流 ${gaps.length} 处共约 ${seconds} 秒（期间没有录音，按静音处理，不做推测）`)
    }
    if (report.overlaps > 0) parts.push(`${trackDisplayName(report.track)}有 ${report.overlaps} 处重叠发言，只保留先开口者的连续片段`)
  }
  if (input.corrupted > 0) parts.push(`${input.corrupted} 块录音解不开（已损坏），对应时间按缺口处理`)
  if (input.recovered > 0) parts.push(`${input.recovered} 段有声片段分人模型没覆盖到，归为「未分人」单独转写`)
  if (input.assistantMarked > 0) parts.push(`${input.assistantMarked} 段与助理播报高度重叠，已标为助理播报，不算真人发言`)
  if (input.assistantTrimmed > 0) parts.push(`${input.assistantTrimmed} 段裁掉了与助理播报重叠的部分`)
  return { mode, note: `${parts.join('。')}。` }
}

/** 给人看的完整说明 = 精修说明 + 当前失败片段数（失败数随重试变化，现算）。 */
function displayNote(stored: string | null, failed: number): string | null {
  const parts: string[] = []
  if (stored !== null && stored !== '') parts.push(stored)
  if (failed > 0) parts.push(`有 ${failed} 个片段转写失败（录音已保留），可点「重试失败片段」。`)
  return parts.length > 0 ? parts.join('') : null
}

/** 模块级活动实例：narrator 钩子经 markAssistantSpeech(startMs,endMs) 报到这里。 */
let activeRecorder: MeetingRecorder | null = null

/**
 * narrator TTS 区间打点，供主代理在 narrator 钩子里调用（startMs/endMs 是相对会议
 * 开始的毫秒数，可由 getState().startedAt 与墙钟换算）。没有会议在录时是 no-op。
 */
export function markAssistantSpeech(startMs: number, endMs: number): void {
  activeRecorder?.markAssistantSpeech(startMs, endMs)
}

export class MeetingRecorder {
  private readonly deps: MeetingRecorderDeps
  private readonly store: MeetingStore
  private active: ActiveMeeting | null = null
  private last: LastMeeting | null = null
  private phase: TranscribePhase = 'idle'
  private note: string | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** 正在跑的结算+转写任务，测试经 whenSettled 等它落定。 */
  private settle: Promise<void> | null = null
  /** 转写任务进行中：此时拒绝再开重转/重试，免得两个任务抢着写段。 */
  private jobRunning = false
  private closed = false
  // ===== 临时字幕（只在内存） =====
  private liveMeetingId: string | null = null
  private liveAccepting = false
  private readonly liveEntries = new Map<number, LiveEntry>()
  private readonly liveQueue: Array<{ storeSeq: number; pcm: Buffer }> = []
  private liveDrain: Promise<void> | null = null
  // ===== 模型纪要（M4-06）：每场会议同时最多一个生成任务 =====
  private readonly minutesJobs = new Map<string, AbortController>()

  constructor(deps: MeetingRecorderDeps) {
    this.deps = deps
    this.store = deps.store
    activeRecorder = this
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private async defaultTranscribe(wav: ArrayBuffer, userDataDir: string): Promise<MeetingAsrResult> {
    // 懒加载：静态 import 会把 sherpa-onnx 原生模块拖进每个 import 本模块的进程。
    const { transcribeWav } = await import('./asr.ts')
    return transcribeWav(wav, userDataDir)
  }

  private transcriber(): (wav: ArrayBuffer, userDataDir: string) => Promise<MeetingAsrResult> {
    return this.deps.transcribe ?? ((wav, dir) => this.defaultTranscribe(wav, dir))
  }

  private broadcast(): void {
    this.deps.notifyRenderer('meeting-state-changed', this.getState())
  }

  getState(): MeetingRuntimeState {
    const active = this.active
    const last = active !== null ? active : this.last
    const captions = this.liveMeetingId === null
      ? null
      : [...this.liveEntries.values()]
          .map(entry => entry.caption)
          .sort((a, b) => a.startMs - b.startMs || (a.track === b.track ? 0 : a.track === 'mic' ? -1 : 1))
          .slice(-LIVE_BROADCAST_LIMIT)
    return {
      recording: active !== null && !active.stopping,
      stopping: active !== null && active.stopping,
      meetingId: active?.meetingId ?? null,
      name: last?.name ?? '',
      sources: last?.sources ?? null,
      startedAt: last?.startedAt ?? null,
      missingTracks: last?.missingTracks ?? [],
      missingTrackReasons: last?.missingTrackReasons ?? {},
      transcribe: active !== null ? 'idle' : this.phase,
      transcribeNote: active !== null ? null : this.note,
      lastMeetingId: this.last?.meetingId ?? null,
      recent: this.store.listMeetings(10).map(m => ({ id: m.id, name: m.name, startedAt: m.startedAt, state: m.state })),
      tracks: active === null
        ? []
        : TRACK_ORDER.filter(track => active.tracks.has(track)).map(track => {
            const progress = active.tracks.get(track) as TrackProgress
            return { track, chunks: progress.chunks, recordedMs: Math.round(progress.recordedFrames / FRAMES_PER_MS), lastEndMs: Math.round(progress.lastEndMs) }
          }),
      live: this.liveMeetingId === null || captions === null ? null : { meetingId: this.liveMeetingId, captions },
    }
  }

  /** 测试与接线用：等当前结算/转写任务落定。 */
  whenSettled(): Promise<void> {
    return this.settle ?? Promise.resolve()
  }

  /** 测试用：等临时字幕队列跑空。 */
  whenLiveIdle(): Promise<void> {
    return this.liveDrain ?? Promise.resolve()
  }

  startMeeting(consent: MeetingConsentInput): { ok: true; meetingId: string } | { ok: false; error: string } {
    if (this.active !== null) return { ok: false, error: '已经有一场会议在录制' }
    const invalid = validateMeetingConsent(consent)
    if (invalid !== null) return { ok: false, error: invalid }
    // 先过仲裁：设备被听写占着就如实拒绝，不开一场录不到声的会。
    const granted = this.deps.audio({ type: 'meeting-requested' })
    if (granted.denied !== null) return { ok: false, error: granted.denied }
    const started = this.store.startMeeting(consent)
    if (!started.ok) {
      // 库拒了（密钥不可用等）：把刚拿到的设备还回去，别把唤醒词永久锁死。
      this.deps.audio({ type: 'meeting-finished' })
      return started
    }
    const startedAt = this.now()
    this.active = {
      meetingId: started.meetingId,
      name: consent.name.trim(),
      sources: consent.sources,
      startedAt,
      stopping: false,
      finalized: false,
      missingTracks: [],
      missingTrackReasons: {},
      tracks: new Map(),
    }
    this.phase = 'idle'
    this.note = null
    this.liveEntries.clear()
    this.liveQueue.length = 0
    this.liveMeetingId = this.deps.liveCaptions === true ? started.meetingId : null
    this.liveAccepting = this.deps.liveCaptions === true
    // 通知渲染层开始流：它收到后用 getUserMedia 采音并逐块推 meetingChunk。startedAt 是
    // 时间轴的零点：渲染层据此把每块的起点换算成"相对会议开始的毫秒"。
    this.deps.notifyRenderer('meeting-started', {
      meetingId: started.meetingId,
      sources: consent.sources,
      name: this.active.name,
      sampleRate: SAMPLE_RATE,
      startedAt,
    })
    this.broadcast()
    return { ok: true, meetingId: started.meetingId }
  }

  /**
   * 渲染层推上来的一块 base64 PCM（16kHz mono Int16）。到这里立即加密落盘。
   *
   * meta（分轨协议）：音源、轨内序号、起点、原始采样率、16k 帧数，逐项在边界上校验——
   * 序号重复/倒退、帧数与字节数对不上、会议没选回环却来了回环块，一律拒收。起点明显
   * 超前于接收时间（时钟错乱）就按接收时间修正，不让一块录音被放到未来。
   * 不带 meta 是旧协议：按麦克风、起点取接收时间，只为兼容。
   */
  pushChunk(meetingId: string, chunkBase64: string, meta?: unknown): { ok: true; seq: number } | { ok: false; error: string } {
    const active = this.active
    if (active === null || active.meetingId !== meetingId) return { ok: false, error: '没有这场会议在录制' }
    if (typeof chunkBase64 !== 'string' || chunkBase64.length === 0) return { ok: false, error: '空音频块' }
    let pcm: Buffer
    try {
      pcm = Buffer.from(chunkBase64, 'base64')
    } catch {
      return { ok: false, error: '音频块不是合法 base64' }
    }
    if (pcm.length === 0) return { ok: false, error: '空音频块' }
    const now = this.now()
    if (meta === undefined || meta === null) {
      const appended = this.store.appendChunk(meetingId, pcm, now)
      if (!appended.ok) return appended
      const frames = Math.floor(pcm.length / 2)
      const startMs = Math.max(0, now - active.startedAt)
      this.noteProgress(active, 'mic', null, startMs, frames)
      this.enqueueLive(meetingId, appended.seq, 'mic', -1, startMs, frames, pcm)
      this.broadcast()
      return { ok: true, seq: appended.seq }
    }
    const checked = this.checkMeta(active, meta, pcm, now)
    if (!checked.ok) return checked
    const { track, seq: trackSeq, sampleRate, frames } = checked.meta
    const appended = this.store.appendChunk(meetingId, pcm, now, { track, trackSeq, startMs: checked.startMs, sourceSampleRate: sampleRate })
    if (!appended.ok) return appended
    this.noteProgress(active, track, trackSeq, checked.startMs, frames)
    this.enqueueLive(meetingId, appended.seq, track, trackSeq, checked.startMs, frames, pcm)
    this.broadcast()
    return { ok: true, seq: appended.seq }
  }

  private checkMeta(
    active: ActiveMeeting,
    meta: unknown,
    pcm: Buffer,
    now: number,
  ): { ok: true; meta: MeetingChunkMeta; startMs: number } | { ok: false; error: string } {
    if (typeof meta !== 'object' || meta === null) return { ok: false, error: '音频块的时间轴信息不对' }
    const value = meta as Partial<Record<keyof MeetingChunkMeta, unknown>>
    if (!isMeetingTrack(value.track)) return { ok: false, error: '音轨只能是 mic 或 loopback' }
    if (value.track === 'loopback' && active.sources !== 'mic+loopback') return { ok: false, error: '这场会议没有选择录系统回环声' }
    if (active.missingTracks.includes(value.track)) return { ok: false, error: '这条音轨已报告缺失' }
    if (typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq < 0) return { ok: false, error: '音轨序号必须是非负整数' }
    if (typeof value.frames !== 'number' || value.frames !== pcm.length / 2) return { ok: false, error: '帧数与音频长度对不上' }
    if (typeof value.sampleRate !== 'number' || !Number.isInteger(value.sampleRate) || value.sampleRate < 3000 || value.sampleRate > 768000) {
      return { ok: false, error: '原始采样率不合理' }
    }
    const progress = active.tracks.get(value.track)
    if (progress !== undefined && value.seq <= progress.lastSeq) return { ok: false, error: '音轨序号重复或倒退' }
    const durationMs = value.frames / FRAMES_PER_MS
    const elapsed = Math.max(0, now - active.startedAt)
    let startMs = typeof value.startMs === 'number' && Number.isFinite(value.startMs) ? value.startMs : elapsed - durationMs
    if (startMs > elapsed + START_SKEW_MS) startMs = elapsed - durationMs
    startMs = Math.max(0, Math.round(startMs))
    return {
      ok: true,
      meta: { track: value.track, seq: value.seq, startMs, sampleRate: value.sampleRate, frames: value.frames },
      startMs,
    }
  }

  private noteProgress(active: ActiveMeeting, track: MeetingTrack, trackSeq: number | null, startMs: number, frames: number): void {
    const progress = active.tracks.get(track) ?? { lastSeq: -1, lastEndMs: 0, chunks: 0, recordedFrames: 0 }
    progress.lastSeq = trackSeq ?? progress.lastSeq + 1
    progress.lastEndMs = Math.max(progress.lastEndMs, startMs + frames / FRAMES_PER_MS)
    progress.chunks++
    progress.recordedFrames += frames
    active.tracks.set(track, progress)
  }

  // ===== 临时字幕（M4-04） =====

  private enqueueLive(meetingId: string, storeSeq: number, track: MeetingTrack, trackSeq: number, startMs: number, frames: number, pcm: Buffer): void {
    if (!this.liveAccepting || this.liveMeetingId !== meetingId) return
    const caption: LiveCaption = {
      track,
      trackSeq,
      startMs,
      endMs: Math.round(startMs + frames / FRAMES_PER_MS),
      status: 'pending',
      ...(this.overlapsAssistant(meetingId, startMs, startMs + frames / FRAMES_PER_MS) ? { assistant: true } : {}),
    }
    this.liveEntries.set(storeSeq, { storeSeq, caption })
    this.liveQueue.push({ storeSeq, pcm })
    while (this.liveQueue.length > LIVE_BACKLOG) {
      const dropped = this.liveQueue.shift()
      if (dropped === undefined) break
      const entry = this.liveEntries.get(dropped.storeSeq)
      if (entry !== undefined) entry.caption = { ...entry.caption, status: 'skipped' }
    }
    if (this.liveDrain === null) {
      this.liveDrain = this.drainLive().finally(() => {
        this.liveDrain = null
      })
    }
  }

  private async drainLive(): Promise<void> {
    const transcribe = this.transcriber()
    while (this.liveAccepting && this.liveQueue.length > 0) {
      const item = this.liveQueue.shift()
      if (item === undefined) break
      const entry = this.liveEntries.get(item.storeSeq)
      if (entry === undefined) continue
      let outcome: AsrOutcome
      try {
        outcome = classifyAsr(await transcribe(buildWav16kMono(item.pcm), this.deps.userDataDir))
      } catch (error) {
        outcome = { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
      }
      // 精修已经把临时字幕清掉了（或换了会议）：结果作废，不写回。
      if (this.liveEntries.get(item.storeSeq) !== entry) continue
      entry.caption = outcome.kind === 'ok'
        ? { ...entry.caption, status: 'ok', text: outcome.text }
        : { ...entry.caption, status: outcome.kind }
      this.broadcast()
      await yieldToEventLoop()
    }
  }

  /** 停录：临时字幕不再接新块，排队的标 skipped（精修会重新转写它们）。已有结果留给精修复用。 */
  private stopLive(): void {
    this.liveAccepting = false
    for (const item of this.liveQueue.splice(0)) {
      const entry = this.liveEntries.get(item.storeSeq)
      if (entry !== undefined && entry.caption.status === 'pending') entry.caption = { ...entry.caption, status: 'skipped' }
    }
  }

  /** 精修写库后：临时字幕作废，界面改看库里的段（不重复显示两份）。 */
  private clearLive(meetingId: string): void {
    if (this.liveMeetingId !== meetingId) return
    this.liveEntries.clear()
    this.liveQueue.length = 0
    this.liveMeetingId = null
  }

  private overlapsAssistant(meetingId: string, startMs: number, endMs: number): boolean {
    const duration = endMs - startMs
    if (duration <= 0) return false
    let overlap = 0
    for (const span of this.store.listAssistantSpeech(meetingId)) {
      overlap += Math.max(0, Math.min(endMs, span.endMs + 200) - Math.max(startMs, span.startMs - 200))
    }
    return overlap / duration >= 0.6
  }

  /**
   * 渲染层报告某条音轨拿不到（loopback 采集失败、缺屏幕录制权限等）。如实记录，不伪造静音。
   *
   * `reason` 是给用户看的下一步：麦克风缺授权与系统音频缺授权要开的是两个不同的开关，
   * 只写"对方的声音没录到"等于把问题丢回给用户自己猜。
   */
  reportTrackMissing(meetingId: string, kind: MeetingTrack, reason?: string): void {
    const active = this.active
    if (active === null || active.meetingId !== meetingId) return
    if (!active.missingTracks.includes(kind)) active.missingTracks.push(kind)
    if (typeof reason === 'string' && reason.trim() !== '') active.missingTrackReasons[kind] = reason.trim()
    this.broadcast()
  }

  /**
   * 用户点「立即停止」：先通知渲染层停流并冲刷最后一块，等 meetingFlushDone 再结算。
   * 渲染层没回应也有兜底：flushTimeoutMs 到点强制结算，绝不让会议停在"停不下来"。
   */
  requestStop(meetingId?: string): { ok: true } | { ok: false; error: string } {
    const active = this.active
    if (active === null) return { ok: false, error: '没有会议在录制' }
    if (meetingId !== undefined && meetingId !== active.meetingId) return { ok: false, error: '会议对不上' }
    if (active.stopping) return { ok: true }
    active.stopping = true
    this.deps.notifyRenderer('meeting-stopping', { meetingId: active.meetingId })
    const timeout = this.deps.flushTimeoutMs ?? 5000
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.finalize()
    }, timeout)
    this.flushTimer.unref?.()
    this.broadcast()
    return { ok: true }
  }

  /** 渲染层停流并推完最后一块后回报。触发结算（幂等）。 */
  async flushDone(meetingId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const active = this.active
    if (active === null || active.meetingId !== meetingId) return { ok: false, error: '没有这场会议在录制' }
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.finalize()
    return { ok: true }
  }

  /** 结算：落 stopped、还设备、跑转写任务。幂等：重复调用直接返回进行中的任务。 */
  private async finalize(): Promise<void> {
    const active = this.active
    if (active === null || active.finalized) return this.settle ?? undefined
    active.finalized = true
    this.active = null
    this.last = {
      meetingId: active.meetingId,
      name: active.name,
      sources: active.sources,
      startedAt: active.startedAt,
      missingTracks: [...active.missingTracks],
      missingTrackReasons: { ...active.missingTrackReasons },
    }
    this.stopLive()
    this.store.stopMeeting(active.meetingId, this.now())
    // 先还设备再转写：转写不占麦克风，唤醒词没理由多停一分钟。
    this.deps.audio({ type: 'meeting-finished' })
    // 上一个转写任务（例如对旧会议的重试）还没完就排在它后面：两个任务不同时写段与状态。
    const last = this.last
    const previous = this.settle ?? Promise.resolve()
    const task = previous.then(
      () => this.runJob(active.meetingId, () => this.refineJob(active.meetingId, last)),
      () => this.runJob(active.meetingId, () => this.refineJob(active.meetingId, last)),
    )
    this.settle = task
    this.broadcast()
    await task
  }

  /**
   * 手动重转（面板上的重试按钮）。没有人工修订时整体重转（按版本替换）；已有人工修订时
   * 只重试失败片段——整体重转会把用户的改名/合并/拆分盖掉，那不是"重试"该有的副作用。
   */
  retranscribe(meetingId: string): { ok: true } | { ok: false; error: string } {
    const meeting = this.store.getMeeting(meetingId)
    if (meeting === null) return { ok: false, error: '没有这场会议' }
    if (meeting.state === 'recording') return { ok: false, error: '会议还在录制中' }
    if (this.jobRunning) return { ok: false, error: '转写正在进行，请等它跑完' }
    const segments = this.store.getSegments(meetingId)
    if (segments.length > 0 && this.hasUserEdits(meetingId)) {
      if (segments.some(segment => segment.source === 'failed')) return this.retryFailed(meetingId)
      return { ok: false, error: '转写已有人工修订，整体重转会覆盖你的改名/合并/拆分，已取消' }
    }
    const last: LastMeeting = {
      meetingId: meeting.id,
      name: meeting.name,
      sources: meeting.sources,
      startedAt: meeting.startedAt,
      missingTracks: this.last?.meetingId === meetingId ? this.last.missingTracks : [],
      missingTrackReasons: this.last?.meetingId === meetingId ? this.last.missingTrackReasons : {},
    }
    this.settle = this.runJob(meetingId, () => this.refineJob(meetingId, last))
    void this.settle
    return { ok: true }
  }

  /** 只重试失败的片段：成功的替换占位段，没人声的去掉占位，仍失败的保留缺口。其余段原样。 */
  retryFailed(meetingId: string): { ok: true } | { ok: false; error: string } {
    const meeting = this.store.getMeeting(meetingId)
    if (meeting === null) return { ok: false, error: '没有这场会议' }
    if (meeting.state === 'recording') return { ok: false, error: '会议还在录制中' }
    if (this.jobRunning) return { ok: false, error: '转写正在进行，请等它跑完' }
    if (!this.store.getSegments(meetingId).some(segment => segment.source === 'failed')) {
      return { ok: false, error: '没有转写失败的片段' }
    }
    this.settle = this.runJob(meetingId, () => this.retryFailedJob(meetingId))
    void this.settle
    return { ok: true }
  }

  /** segmentsRevision 比机器最后写入的版本新 = 之后有人改过。没有元数据的旧转写一律按"可能改过"保守处理。 */
  private hasUserEdits(meetingId: string): boolean {
    const meeting = this.store.getMeeting(meetingId)
    if (meeting === null) return false
    const meta = this.store.getTranscriptMeta(meetingId)
    return meta === null || meeting.segmentsRevision > meta.machineRevision
  }

  /** 转写任务外壳：状态切换、异常兜底、广播。任何异常都不丢录音：chunk 已经加密落盘。 */
  private async runJob(
    meetingId: string,
    job: () => Promise<{ state: 'transcribed' | 'transcript-failed'; note: string | null }>,
  ): Promise<void> {
    this.jobRunning = true
    this.phase = 'transcribing'
    this.note = null
    this.store.setMeetingState(meetingId, 'transcribing')
    this.broadcast()
    try {
      const result = await job()
      this.phase = result.state
      this.note = result.note
      this.store.setMeetingState(meetingId, result.state)
    } catch (error) {
      this.phase = 'transcript-failed'
      this.note = `转写异常：${error instanceof Error ? error.message : String(error)}。录音已保留。`
      this.store.setMeetingState(meetingId, 'transcript-failed')
    } finally {
      this.jobRunning = false
      this.clearLive(meetingId)
    }
    this.broadcast()
  }

  /**
   * 解密全部块并按音轨铺时间轴。旧块（没有起点）沿用老算法：起点取接收时间相对会议开始的
   * 毫秒。解密出的块 Buffer 只活在这个函数里——时间轴建好就放手，长会议不必两份 PCM 同时常驻。
   */
  private loadTimelines(meetingId: string, startedAt: number): { timelines: Map<MeetingTrack, TrackTimeline>; corrupted: number; chunks: number } {
    const read = this.store.readAllChunks(meetingId)
    const inputs: TimelineInputChunk[] = []
    for (const chunk of read.chunks) {
      inputs.push({
        seq: chunk.seq,
        track: chunk.track ?? 'mic',
        startMs: chunk.startMs ?? Math.max(0, chunk.ts - startedAt),
        pcm: chunk.pcm,
        frames: chunk.frames,
      })
    }
    for (const bad of read.corruptedChunks) {
      // 没有起点的坏块只能计数，定不了位置。
      if (bad.startMs === null) continue
      inputs.push({ seq: bad.seq, track: bad.track ?? 'mic', startMs: bad.startMs, pcm: null, frames: bad.frames ?? 0 })
    }
    const timelines = new Map<MeetingTrack, TrackTimeline>()
    for (const track of TRACK_ORDER) {
      const timeline = buildTrackTimeline(track, inputs)
      if (timeline.placements.length > 0 || timeline.gaps.length > 0) timelines.set(track, timeline)
    }
    return { timelines, corrupted: read.corrupted.length, chunks: read.chunks.length }
  }

  /**
   * 会后精修：逐音轨分人（两条音轨并行，各自在后台线程里跑；失败就逐块兜底，分人漏掉的有声
   * 片段补成"未分人"）→ 助理播报区间落到段上 → 长段切分 → 逐段转写 → 按时间排序、按版本写库。
   * 所有片段都失败（一个字都没出）才算 transcript-failed。
   */
  private async refineJob(meetingId: string, last: LastMeeting): Promise<{ state: 'transcribed' | 'transcript-failed'; note: string | null }> {
    const meeting = this.store.getMeeting(meetingId)
    if (meeting === null) throw new Error('会议记录不见了')
    const baseRevision = meeting.segmentsRevision
    const { timelines, corrupted } = this.loadTimelines(meetingId, last.startedAt)
    const diarize = this.deps.diarize ?? diarizeTimelineSamples
    const tracks = TRACK_ORDER.filter(track => (timelines.get(track)?.placements.length ?? 0) > 0)
    const outcomes = await Promise.all(tracks.map(async (track): Promise<{ result?: DiarizeResult; error?: string }> => {
      try {
        return { result: await diarize((timelines.get(track) as TrackTimeline).samples, this.deps.userDataDir) }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }))
    const reports: TrackReport[] = []
    const plan: PlannedSpan[] = []
    tracks.forEach((track, i) => {
      const timeline = timelines.get(track) as TrackTimeline
      const { result, error } = outcomes[i]
      let spans: PlannedSpan[] | null = null
      let speakers = 0
      let overlaps = 0
      let reason: string | null = null
      if (result === undefined) {
        reason = `分人异常：${error ?? '原因未知'}`
      } else if (!result.ok) {
        reason = result.message
      } else if (result.turns.length === 0) {
        reason = '分人模型在这条音轨上没检测到可分的语音'
      } else {
        const mapped = spansFromTurns(track, result.turns, timeline)
        if (mapped.spans.length === 0) reason = '分人结果里没有可用的语音段'
        else {
          spans = mapped.spans
          speakers = mapped.speakers
          overlaps = mapped.overlapsResolved
        }
      }
      reports.push({ track, diarized: spans !== null, speakers, reason, overlaps, timeline })
      if (spans === null) plan.push(...fallbackSpans(track, timeline))
      else plan.push(...spans, ...uncoveredVoicedSpans(track, timeline, spans))
    })
    const assistant = applyAssistantSpeech(plan, this.store.listAssistantSpeech(meetingId))
    const planned = splitLongSpans(assistant.spans, track => timelines.get(track))
      .sort((a, b) => a.startMs - b.startMs || TRACK_ORDER.indexOf(a.track) - TRACK_ORDER.indexOf(b.track))

    const transcribe = this.transcriber()
    const live = this.liveMeetingId === meetingId ? this.liveEntries : new Map<number, LiveEntry>()
    const segments: TranscriptSegment[] = []
    let failed = 0
    for (const span of planned) {
      const timeline = timelines.get(span.track)
      if (timeline === undefined) continue
      let outcome: AsrOutcome
      const reused = span.chunkSeq !== undefined ? live.get(span.chunkSeq)?.caption : undefined
      if (reused !== undefined && reused.status === 'ok' && reused.text !== undefined) {
        // 逐块兜底且这块录音中已经转写过：同一段音频、同一个识别器，直接复用。
        outcome = { kind: 'ok', text: reused.text }
      } else if (reused !== undefined && reused.status === 'empty') {
        outcome = { kind: 'empty' }
      } else {
        try {
          outcome = classifyAsr(await transcribe(buildWav16kMono(sliceTimeline(timeline, span.startMs, span.endMs)), this.deps.userDataDir))
        } catch (error) {
          outcome = { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
        }
        // 识别是同步原生调用：每段之后让一次事件循环，界面与 IPC 不至于整段卡住。
        await yieldToEventLoop()
      }
      if (outcome.kind === 'empty') continue
      if (outcome.kind === 'failed') failed++
      segments.push({
        idx: segments.length,
        speaker: span.speaker,
        label: span.label,
        // 机器分的组只是建议：一律未确认，改名/拆分后才算确认。
        uncertain: true,
        startMs: span.startMs,
        endMs: span.endMs,
        text: outcome.kind === 'ok' ? outcome.text : FAILED_SEGMENT_TEXT,
        source: outcome.kind === 'failed' ? 'failed' : span.kind === 'assistant' ? 'assistant' : 'asr',
        track: span.track,
      })
    }
    const unknownIds = new Set(TRACK_ORDER.map(trackUnknownSpeakerId))
    const { mode, note } = composeRefineNote({
      reports,
      corrupted,
      assistantMarked: assistant.marked,
      assistantTrimmed: assistant.trimmed,
      recovered: segments.filter(segment => segment.source === 'asr' && unknownIds.has(segment.speaker)).length,
    })
    const usable = segments.filter(segment => segment.source !== 'failed').length
    if (usable === 0 && (failed > 0 || corrupted > 0)) {
      // 一个字都没转出来：不写占位段，整体标失败，录音完整保留等重试。
      const count = failed + corrupted
      return { state: 'transcript-failed', note: `转写失败（${count} 个片段无法识别）。录音已完整保留，可稍后重试。${note}` }
    }
    const replaced = this.store.replaceSegments(meetingId, segments, {
      expectRevision: baseRevision,
      machine: { mode, note, advance: true },
    })
    if (!replaced.ok) {
      if (replaced.conflict === true) {
        return { state: 'transcribed', note: '转写处理期间段被修订过，精修结果没有覆盖你的修订；需要时可再点重转。' }
      }
      throw new Error(replaced.error)
    }
    this.saveMinutesDraft(meetingId, last, replaced.revision)
    return { state: 'transcribed', note: displayNote(note, failed) }
  }

  private async retryFailedJob(meetingId: string): Promise<{ state: 'transcribed' | 'transcript-failed'; note: string | null }> {
    const meeting = this.store.getMeeting(meetingId)
    if (meeting === null) throw new Error('会议记录不见了')
    const baseRevision = meeting.segmentsRevision
    const userEdited = this.hasUserEdits(meetingId)
    const meta = this.store.getTranscriptMeta(meetingId)
    const { timelines, chunks } = this.loadTimelines(meetingId, meeting.startedAt)
    if (chunks === 0) {
      const failedNow = this.store.getSegments(meetingId).filter(segment => segment.source === 'failed').length
      return { state: 'transcribed', note: `${displayNote(meta?.note ?? null, failedNow) ?? ''}录音已不在（可能已过保留期），没法重试。` }
    }
    const transcribe = this.transcriber()
    const next: TranscriptSegment[] = []
    let still = 0
    for (const segment of this.store.getSegments(meetingId)) {
      if (segment.source !== 'failed') {
        next.push(segment)
        continue
      }
      const timeline = timelines.get(segment.track ?? 'mic')
      if (timeline === undefined || segment.startMs === null || segment.endMs === null) {
        next.push(segment)
        still++
        continue
      }
      let outcome: AsrOutcome
      try {
        outcome = classifyAsr(await transcribe(buildWav16kMono(sliceTimeline(timeline, segment.startMs, segment.endMs)), this.deps.userDataDir))
      } catch (error) {
        outcome = { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
      }
      await yieldToEventLoop()
      if (outcome.kind === 'empty') continue
      if (outcome.kind === 'failed') {
        next.push(segment)
        still++
        continue
      }
      // 只换文字与来源：speaker/label/uncertain 保持原样——用户可能已经给这一组改过名。
      next.push({ ...segment, text: outcome.text, source: segment.speaker === ASSISTANT_SPEAKER ? 'assistant' : 'asr' })
    }
    const renumbered = next.map((segment, idx) => ({ ...segment, idx }))
    const replaced = this.store.replaceSegments(meetingId, renumbered, {
      expectRevision: baseRevision,
      // 有人工修订时 machineRevision 不往前推：那个事实要保留，之后的整体重转仍然会被挡住。
      machine: { mode: meta?.mode ?? 'undiarized', note: meta?.note ?? null, advance: !userEdited },
    })
    if (!replaced.ok) {
      if (replaced.conflict === true) {
        return { state: 'transcribed', note: '重试期间段被修订过，没有覆盖你的修订；需要时可再点重试。' }
      }
      throw new Error(replaced.error)
    }
    this.saveMinutesDraft(meetingId, this.last, replaced.revision)
    return { state: 'transcribed', note: displayNote(meta?.note ?? null, still) }
  }

  /** 按当前段与助理播报区间生成纪要草稿（本地模板版，不经模型）并落库。 */
  private saveMinutesDraft(meetingId: string, last: LastMeeting | null, revision: number): void {
    const input = this.minutesInput(meetingId, last)
    if (input === null) return
    this.store.saveMinutes(meetingId, buildMinutesContent(input), revision, { kind: 'local' })
  }

  /** 纪要正文的公共部分（会议信息、转写段、播报区间、缺失音轨、转写说明）。 */
  private minutesInput(meetingId: string, last: LastMeeting | null): MinutesInput | null {
    const meeting = this.store.getMeeting(meetingId)
    if (meeting === null) return null
    const segments = this.store.getSegments(meetingId)
    const meta = this.store.getTranscriptMeta(meetingId)
    return {
      name: meeting.name,
      startedAt: meeting.startedAt,
      endedAt: meeting.endedAt,
      sources: meeting.sources,
      consentText: meeting.consent.consentText,
      retentionDays: meeting.retentionDays,
      segments,
      assistantSpeech: this.store.listAssistantSpeech(meetingId),
      missingTracks: last?.meetingId === meetingId ? [...last.missingTracks] : [],
      missingTrackReasons: last?.meetingId === meetingId ? last.missingTrackReasons : {},
      transcriptNote: meta === null ? null : displayNote(meta.note, segments.filter(segment => segment.source === 'failed').length),
    }
  }

  /** 模型版纪要落库：正文由结构化条目渲染，二者同一事务写入，预览与导出因此一致。 */
  private saveModelMinutes(meetingId: string, structured: StructuredMinutes): { ok: true } | { ok: false; error: string } {
    const input = this.minutesInput(meetingId, this.last)
    if (input === null) return { ok: false, error: '没有这场会议' }
    const content = buildMinutesContent({ ...input, generation: { kind: 'model', structured } })
    return this.store.saveMinutes(meetingId, content, structured.basedOnRevision, { kind: 'model', structured: JSON.stringify(structured) })
  }

  /** narrator TTS 打点：记进 assistant_speech，纪要里单列并注明不算真人发言。 */
  markAssistantSpeech(startMs: number, endMs: number): void {
    const active = this.active
    if (active === null) return
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return
    this.store.addAssistantSpeech(active.meetingId, Math.max(0, Math.round(startMs)), Math.max(0, Math.round(endMs)))
    // 已出来的临时字幕补标"助理播报"：播报区间要到念完才知道。
    if (this.liveMeetingId === active.meetingId && this.liveEntries.size > 0) {
      let changed = false
      for (const entry of this.liveEntries.values()) {
        const hit = this.overlapsAssistant(active.meetingId, entry.caption.startMs, entry.caption.endMs)
        if (hit !== (entry.caption.assistant === true)) {
          const { assistant: _old, ...rest } = entry.caption
          entry.caption = hit ? { ...rest, assistant: true } : rest
          changed = true
        }
      }
      if (changed) this.broadcast()
    }
  }

  // ===== 说话人修订（每次都 bump revision，纪要确认随之作废） =====

  getSpeakers(meetingId: string): {
    ok: true
    revision: number
    segments: TranscriptSegment[]
    speakers: Array<{ speaker: string; label: string; count: number }>
    transcript: { mode: TranscriptMode; note: string | null; userEdited: boolean } | null
  } | { ok: false; error: string } {
    const meeting = this.store.getMeeting(meetingId)
    if (meeting === null) return { ok: false, error: '没有这场会议' }
    const segments = this.store.getSegments(meetingId)
    const speakers: Array<{ speaker: string; label: string; count: number }> = []
    for (const segment of segments) {
      const found = speakers.find(entry => entry.speaker === segment.speaker)
      if (found !== undefined) found.count++
      else speakers.push({ speaker: segment.speaker, label: segment.label, count: 1 })
    }
    const meta = this.store.getTranscriptMeta(meetingId)
    return {
      ok: true,
      revision: meeting.segmentsRevision,
      segments,
      speakers,
      transcript: meta === null
        ? null
        : {
            mode: meta.mode,
            note: displayNote(meta.note, segments.filter(segment => segment.source === 'failed').length),
            userEdited: meeting.segmentsRevision > meta.machineRevision,
          },
    }
  }

  private editSpeakers(
    meetingId: string,
    edit: () => { ok: true; revision: number } | { ok: false; error: string },
  ): { ok: true; revision: number } | { ok: false; error: string } {
    const result = edit()
    if (!result.ok) return result
    // 修订后重新生成纪要草稿：确认过的旧版本已在 replaceSegments 里退回 draft。
    this.saveMinutesDraft(meetingId, this.last, result.revision)
    this.broadcast()
    return result
  }

  renameSpeaker(meetingId: string, speaker: string, label: string): { ok: true; revision: number } | { ok: false; error: string } {
    return this.editSpeakers(meetingId, () => this.store.renameSpeaker(meetingId, speaker, label))
  }

  mergeSpeakers(meetingId: string, fromSpeaker: string, intoSpeaker: string): { ok: true; revision: number } | { ok: false; error: string } {
    return this.editSpeakers(meetingId, () => this.store.mergeSpeakers(meetingId, fromSpeaker, intoSpeaker))
  }

  splitSegments(meetingId: string, indexes: readonly number[], label: string): { ok: true; revision: number } | { ok: false; error: string } {
    return this.editSpeakers(meetingId, () => this.store.splitSegments(meetingId, indexes, label))
  }

  getMinutes(meetingId: string): MeetingMinutesView | { ok: false; error: string } {
    const meeting = this.store.getMeeting(meetingId)
    if (meeting === null) return { ok: false, error: '没有这场会议' }
    const record = this.store.getMinutes(meetingId)
    const egress = this.store.getEgress(meetingId)
    let minutes: MinutesView | null = null
    if (record !== null) {
      const structured = record.kind === 'model' ? parseStructured(record.structured) : null
      minutes = {
        ...record,
        structured,
        stale: record.revision < meeting.segmentsRevision,
      }
    }
    return {
      ok: true,
      minutes,
      egress: {
        active: egress.active === null ? null : { at: egress.active.at, revision: egress.active.revision ?? null, summary: egress.active.summary ?? '' },
        history: egress.events.map(event => ({ type: event.type, at: event.at, ...(event.revision !== undefined ? { revision: event.revision } : {}) })),
        ...(egress.undecryptable === true ? { undecryptable: true as const } : {}),
      },
      model: { available: this.deps.summarize !== undefined && this.deps.confirmEgress !== undefined, generating: this.minutesJobs.has(meetingId) },
      revision: meeting.segmentsRevision,
    }
  }

  /**
   * 确认纪要。digest 是界面预览的那一版：库里已经变了就拒绝。重复确认幂等——已确认的
   * 原样返回原确认时间，不写库、不广播，不产生第二次副作用。
   */
  confirmMinutes(meetingId: string, digest?: string): { ok: true; confirmedAt: number; already?: true } | { ok: false; error: string } {
    // userClicked 恒为 true：这条 IPC 只有面板上那个按钮会调，确认动作本身就是用户点的。
    const result = this.store.confirmMinutes(meetingId, { userClicked: true, ...(digest !== undefined ? { digest } : {}) })
    if (result.ok && result.already !== true) this.broadcast()
    return result
  }

  /**
   * 导出定稿：只有已确认、且仍是当前转写版本的纪要能导出。导出的就是确认时预览的那份
   * 正文（digest 相同），不重新渲染。
   */
  /**
   * 会议名。给"把纪要交给个人助理"这类界面流程用：确认框里得写清是哪场会。
   * 找不到返回 null（调用方退化成"某场会议"，不编一个名字）。
   */
  meetingName(meetingId: string): string | null {
    return this.store.getMeeting(meetingId)?.name ?? null
  }

  exportMinutes(meetingId: string): { ok: true; content: string; digest: string; confirmedAt: number; kind: 'local' | 'model' } | { ok: false; error: string } {
    const meeting = this.store.getMeeting(meetingId)
    if (meeting === null) return { ok: false, error: '没有这场会议' }
    const minutes = this.store.getMinutes(meetingId)
    if (minutes === null) return { ok: false, error: '纪要还没有生成' }
    if (minutes.undecryptable === true) return { ok: false, error: '纪要不可解密，不能导出' }
    if (minutes.state !== 'confirmed' || minutes.confirmedAt === null) return { ok: false, error: '纪要还没确认，不能导出为定稿' }
    if (minutes.revision < meeting.segmentsRevision) return { ok: false, error: '转写在确认后被修订过，请重新确认后再导出' }
    return { ok: true, content: minutes.content, digest: minutes.digest, confirmedAt: minutes.confirmedAt, kind: minutes.kind }
  }

  /** 放弃模型草稿，改回本地模板版（不经模型）。 */
  useLocalMinutes(meetingId: string): { ok: true } | { ok: false; error: string } {
    const meeting = this.store.getMeeting(meetingId)
    if (meeting === null) return { ok: false, error: '没有这场会议' }
    if (this.minutesJobs.has(meetingId)) return { ok: false, error: '模型纪要正在生成，请等它结束' }
    const input = this.minutesInput(meetingId, this.last)
    if (input === null) return { ok: false, error: '没有这场会议' }
    const saved = this.store.saveMinutes(meetingId, buildMinutesContent(input), meeting.segmentsRevision, { kind: 'local' })
    if (saved.ok) this.broadcast()
    return saved
  }

  /**
   * 改纪要稿（模型版的单条）：改文字、填负责人/期限（用户填的记为人工填写，不是模型补的）。
   * 正文随之重渲染、digest 改变，旧确认自动失效。
   */
  editMinutesItem(meetingId: string, itemId: string, patch: unknown): { ok: true; digest: string } | { ok: false; error: string } {
    const meeting = this.store.getMeeting(meetingId)
    if (meeting === null) return { ok: false, error: '没有这场会议' }
    if (this.minutesJobs.has(meetingId)) return { ok: false, error: '模型纪要正在生成，请等它结束' }
    const minutes = this.store.getMinutes(meetingId)
    if (minutes === null || minutes.kind !== 'model') return { ok: false, error: '只有模型生成的纪要可以逐条修改' }
    if (minutes.undecryptable === true) return { ok: false, error: '纪要不可解密，不能修改' }
    const structured = parseStructured(minutes.structured)
    if (structured === null) return { ok: false, error: '纪要的结构化条目读不出来' }
    if (structured.basedOnRevision !== meeting.segmentsRevision || minutes.revision !== meeting.segmentsRevision) {
      return { ok: false, error: '转写已经改过，这份纪要基于旧版本，请重新生成' }
    }
    const checked = asItemPatch(patch)
    if (checked === null) return { ok: false, error: '修改内容不对（文字不能为空，单项不超过 400 字）' }
    const next = applyItemPatch(structured, itemId, checked)
    if ('error' in next) return { ok: false, error: next.error }
    const saved = this.saveModelMinutes(meetingId, next)
    if (!saved.ok) return saved
    this.broadcast()
    return { ok: true, digest: this.store.getMinutes(meetingId)?.digest ?? '' }
  }

  /** 撤销本场会议的数据去向授权；正在跑的生成立即中止，结果不采用。 */
  revokeEgress(meetingId: string): { ok: true } | { ok: false; error: string } {
    if (this.store.getMeeting(meetingId) === null) return { ok: false, error: '没有这场会议' }
    this.minutesJobs.get(meetingId)?.abort(new Error('授权已撤销'))
    const egress = this.store.getEgress(meetingId)
    if (egress.active !== null || egress.undecryptable === true) {
      const recorded = this.store.recordEgress(meetingId, { type: 'revoked', at: this.now() })
      if (!recorded.ok) return recorded
    }
    this.broadcast()
    return { ok: true }
  }

  /**
   * 用模型生成纪要（M4-06）。只能由用户在会议页发起（opts.userInitiated 必须是字面 true）。
   *
   * 顺序：前置检查 → 拼提示词与授权摘要 → 授权（本场会议、本转写版本、同一份发送内容已授权
   * 过就不再问；否则调 confirmEgress，拒绝即返回、零发送）→ summarize → 版本与授权复查 →
   * 解析 JSON（非法即如实失败）→ 逐条来源校验 → 写库（模型版，旧确认随 digest 改变而失效）。
   * 任何一步失败，库里的纪要原样不动（通常是本地模板版）。
   */
  async generateModelMinutes(meetingId: string, opts: { userInitiated: true }): Promise<MinutesGenerateResult> {
    const refuse = (error: string, sent = false): MinutesGenerateResult => ({ ok: false, error, sent })
    if (opts?.userInitiated !== true) return refuse('用模型生成纪要必须由你在会议页亲手发起')
    const meeting = this.store.getMeeting(meetingId)
    if (meeting === null) return refuse('没有这场会议')
    if (meeting.state === 'recording' || this.active?.meetingId === meetingId) return refuse('会议还在录制中')
    if (this.jobRunning) return refuse('转写正在进行，等它跑完再生成')
    if (this.minutesJobs.has(meetingId)) return refuse('这场会议的纪要正在生成')
    if (meeting.undecryptable === true) return refuse('会议信息不可解密，不发送')
    const summarize = this.deps.summarize
    const confirmEgress = this.deps.confirmEgress
    if (summarize === undefined) return refuse('模型不可用（没有接入模型服务）；纪要保持本地模板版（未经模型）')
    if (confirmEgress === undefined) return refuse('没有可用的授权确认方式，不发送；纪要保持本地模板版（未经模型）')
    const revision = meeting.segmentsRevision
    const segments = this.store.getSegments(meetingId)
    const build = buildMinutesPrompt({
      meetingId,
      meetingName: meeting.name,
      revision,
      segments,
      nonce: randomBytes(8).toString('hex'),
      target: this.deps.egressTarget ?? DEFAULT_EGRESS_TARGET,
    })
    if (!build.ok) return refuse(build.error)

    const controller = new AbortController()
    this.minutesJobs.set(meetingId, controller)
    const abortedMessage = (): string => {
      const reason = controller.signal.reason
      return reason instanceof Error ? reason.message : '已中止'
    }
    try {
      const existing = this.store.getEgress(meetingId).active
      const covered = existing !== null && existing.revision === revision && existing.payloadDigest === build.payloadDigest
      let prompted = false
      if (!covered) {
        prompted = true
        let agreed = false
        try {
          agreed = (await confirmEgress(build.egressSummary)) === true
        } catch {
          agreed = false
        }
        if (controller.signal.aborted) return refuse(`${abortedMessage()}，没有发送`)
        if (!agreed) {
          this.store.recordEgress(meetingId, { type: 'denied', at: this.now() })
          return refuse('你没有同意发送：本场会议的文字没有发给任何模型，纪要保持本地模板版（未经模型）')
        }
        const recorded = this.store.recordEgress(meetingId, {
          type: 'granted',
          at: this.now(),
          revision,
          payloadDigest: build.payloadDigest,
          summary: build.egressSummary,
        })
        if (!recorded.ok) return refuse(`授权没能记录（${recorded.error}），不发送`)
      }
      // 对话框可能开了很久：发送前再核一遍版本与授权，任何一项变了都不发。
      if (this.store.getMeeting(meetingId)?.segmentsRevision !== revision) return refuse('转写在你确认期间被修改，没有发送；请重新生成')
      const grant = this.store.getEgress(meetingId).active
      if (grant === null || grant.revision !== revision || grant.payloadDigest !== build.payloadDigest) return refuse('授权已撤销，没有发送')

      const timer = setTimeout(() => controller.abort(new Error('等模型回复超时')), this.deps.summarizeTimeoutMs ?? 180_000)
      timer.unref?.()
      let reply: { ok: boolean; reply?: string; error?: string }
      try {
        reply = await summarize(build.prompt, controller.signal)
      } catch (error) {
        reply = { ok: false, error: error instanceof Error ? error.message : String(error) }
      } finally {
        clearTimeout(timer)
      }
      if (controller.signal.aborted) return refuse(`${abortedMessage()}，模型结果不采用；纪要保持原样`, true)
      if (!reply.ok || typeof reply.reply !== 'string') {
        return refuse(`模型调用失败：${reply.error ?? '没有回复'}；纪要保持本地模板版（未经模型）`, true)
      }
      if (this.store.getMeeting(meetingId)?.segmentsRevision !== revision) {
        return refuse('转写在生成期间被修改，模型结果基于旧版本，未采用；请重新生成', true)
      }
      if (this.store.getEgress(meetingId).active === null) return refuse('授权在生成期间被撤销，模型结果未采用', true)
      const parsed = parseModelReply(reply.reply)
      if (!parsed.ok) return refuse(`${parsed.error}；纪要保持本地模板版（未经模型）`, true)
      const validated = validateModelMinutes(parsed.value, { meetingId, revision, segments })
      if (!validated.ok) return refuse(`${validated.error}；纪要保持本地模板版（未经模型）`, true)
      const structured: StructuredMinutes = {
        version: 1,
        generator: 'model',
        basedOnRevision: revision,
        generatedAt: this.now(),
        sentSegments: build.sentSegments,
        egressGrantedAt: grant.at,
        items: validated.items,
      }
      const saved = this.saveModelMinutes(meetingId, structured)
      if (!saved.ok) return refuse(`纪要没能保存：${saved.error}`, true)
      this.broadcast()
      const kept = validated.items.filter(item => item.status === 'kept').length
      return { ok: true, kept, rejected: validated.items.length - kept, prompted, sent: true }
    } finally {
      this.minutesJobs.delete(meetingId)
    }
  }

  /** 保留期清扫。主代理可在启动时与每日定时各调一次。 */
  sweepRetention(): string[] {
    const expired = this.store.enforceRetention(this.now())
    if (expired.length > 0) this.broadcast()
    return expired
  }

  /**
   * 退出收尾。在录的会直接落 stopped —— 退出路径上不跑转写，那会拖着一个模型进程让用户等。
   * 录音已加密落盘，用户下次点转写照样能出文字。幂等：before-quit 会跑两遍。
   */
  async close(): Promise<void> {
    const active = this.active
    this.stopLive()
    // 退出时正在等模型的纪要生成一律中止：结果不采用，库里的纪要原样。
    for (const controller of this.minutesJobs.values()) controller.abort(new Error('应用正在退出'))
    if (active !== null && !active.finalized) {
      active.finalized = true
      this.active = null
      if (this.flushTimer !== null) {
        clearTimeout(this.flushTimer)
        this.flushTimer = null
      }
      this.store.stopMeeting(active.meetingId, this.now())
      this.deps.audio({ type: 'meeting-finished' })
    }
    // 转写还在跑就不关库：任务里还要写状态，关了只会把异常变成第二次异常。
    // 最多等一拍，剩下的交给进程退出（WAL 不会因此丢数据），别让用户点退出却卡住。
    const pending = [this.settle, this.liveDrain].filter((task): task is Promise<void> => task !== null)
    const settled = pending.length === 0 || await Promise.race([
      Promise.all(pending.map(task => task.then(() => true, () => true))).then(() => true),
      new Promise<boolean>(resolve => { setTimeout(() => resolve(false), 1500).unref() }),
    ])
    if (settled && !this.closed) {
      this.closed = true
      this.store.close()
    }
  }
}

/**
 * 建一套默认接线的 store + recorder。主代理只需再提供 audio 与 notifyRenderer；
 * 要启用"用模型生成纪要"，再提供 summarize（接 bridge.chat）与 confirmEgress（主进程原生对话框）。
 */
export function createMeetingRecorder(deps: {
  userDataDir: string
  audio: (event: AudioEvent) => AudioTransition
  notifyRenderer: (channel: string, payload: unknown) => void
  storeDeps?: MeetingStoreDeps
  transcribe?: (wav: ArrayBuffer, userDataDir: string) => Promise<MeetingAsrResult>
  now?: () => number
  flushTimeoutMs?: number
  summarize?: MeetingSummarizeFn
  confirmEgress?: MeetingConfirmEgressFn
  egressTarget?: string
}): MeetingRecorder {
  const store = new MeetingStore(deps.userDataDir, deps.storeDeps ?? {})
  return new MeetingRecorder({
    store,
    userDataDir: deps.userDataDir,
    audio: deps.audio,
    notifyRenderer: deps.notifyRenderer,
    // 生产接线默认出临时字幕：录音中就能看到大致内容，停录精修后被替换。
    liveCaptions: true,
    ...(deps.transcribe !== undefined ? { transcribe: deps.transcribe } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.flushTimeoutMs !== undefined ? { flushTimeoutMs: deps.flushTimeoutMs } : {}),
    ...(deps.summarize !== undefined ? { summarize: deps.summarize } : {}),
    ...(deps.confirmEgress !== undefined ? { confirmEgress: deps.confirmEgress } : {}),
    ...(deps.egressTarget !== undefined ? { egressTarget: deps.egressTarget } : {}),
  })
}

// ===== IPC 注册 =====

/**
 * ipcMain 的结构子集。刻意不 import electron：本模块要能在纯 Node 下被测，
 * 主代理接线时把真 ipcMain 传进来即可（方法形参双变，结构兼容）。
 */
export interface MeetingIpcMain {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

export interface MeetingIpcDeps {
  readonly ipc: MeetingIpcMain
  readonly recorder: MeetingRecorder
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asIntList(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  const out: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item)) return null
    out.push(item)
  }
  return out
}

/**
 * 注册全部会议 IPC。通道与 preload/index.ts、renderer/types.d.ts 一一对应。
 * 所有参数都在边界上重新校验：IPC 上来的任何东西都不是证据。
 */
export function registerMeetingIpc(deps: MeetingIpcDeps): void {
  const { ipc, recorder } = deps

  ipc.handle('meeting-start', (_event, consent: unknown) => {
    return recorder.startMeeting(consent as MeetingConsentInput)
  })

  ipc.handle('meeting-stop', (_event, meetingId: unknown) => {
    const id = typeof meetingId === 'string' && meetingId !== '' ? meetingId : undefined
    return recorder.requestStop(id)
  })

  // 第三个参数是分轨时间轴（MeetingChunkMeta）；recorder.pushChunk 逐项校验。
  ipc.handle('meeting-chunk', (_event, meetingId: unknown, chunkBase64: unknown, meta: unknown) => {
    const id = asString(meetingId)
    const chunk = asString(chunkBase64)
    if (id === null || chunk === null) return { ok: false, error: '参数不对' }
    return recorder.pushChunk(id, chunk, meta)
  })

  // 第三个参数是给人看的原因（缺哪项权限 / 这个平台不支持系统音频）。
  // 只加可选参数、不改已有两参数调用的行为：老的渲染层代码照旧能用。
  ipc.handle('meeting-track-missing', (_event, meetingId: unknown, kind: unknown, reason: unknown) => {
    const id = asString(meetingId)
    if (id === null || !isMeetingTrack(kind)) return { ok: false, error: '参数不对' }
    recorder.reportTrackMissing(id, kind, typeof reason === 'string' ? reason : undefined)
    return { ok: true }
  })

  ipc.handle('meeting-flush-done', async (_event, meetingId: unknown) => {
    const id = asString(meetingId)
    if (id === null) return { ok: false, error: '参数不对' }
    return recorder.flushDone(id)
  })

  ipc.handle('meeting-state', () => recorder.getState())

  // 第二个参数 mode：'failed-only' = 只重试失败片段（缺口占位段）；不传 = 重转（有人工修订时
  // 自动降为只重试失败片段）。复用这一条通道而不是另开一条：舞台侧的 IPC 面保持不变。
  ipc.handle('meeting-transcribe', (_event, meetingId: unknown, mode: unknown) => {
    const id = asString(meetingId)
    if (id === null) return { ok: false, error: '参数不对' }
    if (mode === 'failed-only') return recorder.retryFailed(id)
    return recorder.retranscribe(id)
  })

  ipc.handle('meeting-speakers', (_event, meetingId: unknown) => {
    const id = asString(meetingId)
    if (id === null) return { ok: false, error: '参数不对' }
    return recorder.getSpeakers(id)
  })

  ipc.handle('meeting-speaker-rename', (_event, meetingId: unknown, speaker: unknown, label: unknown) => {
    const id = asString(meetingId)
    const from = asString(speaker)
    const to = asString(label)
    if (id === null || from === null || to === null) return { ok: false, error: '参数不对' }
    return recorder.renameSpeaker(id, from, to)
  })

  ipc.handle('meeting-speaker-merge', (_event, meetingId: unknown, fromSpeaker: unknown, intoSpeaker: unknown) => {
    const id = asString(meetingId)
    const from = asString(fromSpeaker)
    const into = asString(intoSpeaker)
    if (id === null || from === null || into === null) return { ok: false, error: '参数不对' }
    return recorder.mergeSpeakers(id, from, into)
  })

  ipc.handle('meeting-speaker-split', (_event, meetingId: unknown, indexes: unknown, label: unknown) => {
    const id = asString(meetingId)
    const list = asIntList(indexes)
    const name = asString(label)
    if (id === null || list === null || name === null) return { ok: false, error: '参数不对' }
    return recorder.splitSegments(id, list, name)
  })

  // 第二个参数 request（M4-06）：不传 = 取纪要；{ action: 'generate' } 用模型生成（先经原生
  // 对话框授权）；'revoke-egress' 撤销数据去向授权；'edit' 改一条（itemId + patch）；'export'
  // 取已确认的定稿；'use-local' 改回本地模板版。复用这一条通道，舞台侧的 IPC 面不变。
  // 这条通道只有会议页的按钮会调：模型/工具没有任何路径能走到这里，授权本身还要过主进程对话框。
  ipc.handle('meeting-minutes', async (_event, meetingId: unknown, request: unknown) => {
    const id = asString(meetingId)
    if (id === null) return { ok: false, error: '参数不对' }
    if (request === undefined || request === null) return recorder.getMinutes(id)
    if (typeof request !== 'object' || Array.isArray(request)) return { ok: false, error: '参数不对' }
    const value = request as { action?: unknown; itemId?: unknown; patch?: unknown }
    switch (value.action) {
      case 'generate':
        return recorder.generateModelMinutes(id, { userInitiated: true })
      case 'revoke-egress':
        return recorder.revokeEgress(id)
      case 'edit': {
        const itemId = asString(value.itemId)
        if (itemId === null) return { ok: false, error: '参数不对' }
        return recorder.editMinutesItem(id, itemId, value.patch)
      }
      case 'export':
        return recorder.exportMinutes(id)
      case 'use-local':
        return recorder.useLocalMinutes(id)
      default:
        return { ok: false, error: '参数不对' }
    }
  })

  // 第二个参数 digest：界面预览的那一版。库里的纪要在预览之后变了就拒绝确认。
  ipc.handle('meeting-minutes-confirm', (_event, meetingId: unknown, digest: unknown) => {
    const id = asString(meetingId)
    if (id === null) return { ok: false, error: '参数不对' }
    return recorder.confirmMinutes(id, typeof digest === 'string' && digest !== '' ? digest : undefined)
  })
}

export type { MinutesItem, MinutesItemKind, MinutesItemPatch, MinutesSourceRef, StructuredMinutes } from './meeting-minutes.ts'

export type { MeetingConsentInput, MeetingRow, MeetingTrack }
