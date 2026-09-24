/**
 * 会议闭环编排（主进程侧）：开始/推块/停止/结算/转写/说话人修订/纪要确认。
 *
 * 数据流：渲染层 getUserMedia 采 16kHz mono Int16 PCM，约每 4 秒推一块 base64 上来，
 * 这里解密钥、加密落盘（MeetingStore）；停止时先让渲染层停流并冲刷最后一块
 * （meeting-stopping → meetingFlushDone），**再**结算与转写——顺序反了会丢最后几秒。
 *
 * 转写按 chunk 逐块拼 wav 调 asr.ts 的 transcribeWav（依赖注入，可测）。失败只标
 * transcript-failed，录音一块不丢。ASR 不猜说话人：产出的段全部 uncertain=true、
 * 单一标签「发言人1」，分组靠用户修订（rename/merge/split，每次 bump revision）。
 *
 * 本模块不 import electron：IPC 通过 registerMeetingIpc(deps) 注入 ipcMain 形状的对象，
 * 于是编排逻辑能在纯 Node 下单测。
 */
import type { AudioEvent, AudioTransition } from './audio.ts'
import {
  MeetingStore,
  validateMeetingConsent,
  type AssistantSpeechSpan,
  type MeetingConsentInput,
  type MeetingRow,
  type MeetingSources,
  type MeetingStoreDeps,
  type TranscriptSegment,
} from './meeting-store.ts'

/** asr.ts 的返回形状（避免静态 import 把 sherpa-onnx 原生模块拖进测试进程）。 */
export interface MeetingAsrResult {
  ok: boolean
  text?: string
  error?: string
}

export type TranscribePhase = 'idle' | 'transcribing' | 'transcribed' | 'transcript-failed'

/** 推给面板的运行时状态。界面只是投影，真源在这里与 MeetingStore。 */
export interface MeetingRuntimeState {
  readonly recording: boolean
  readonly stopping: boolean
  readonly meetingId: string | null
  readonly name: string
  readonly sources: MeetingSources | null
  readonly startedAt: number | null
  /** 拿不到的音轨（loopback 采不到时如实标缺失，不伪造静音块）。 */
  readonly missingTracks: ReadonlyArray<'mic' | 'loopback'>
  readonly transcribe: TranscribePhase
  readonly transcribeNote: string | null
  /** 最近结束（或正在进行）的会议，供面板接着做转写状态/修订/纪要。 */
  readonly lastMeetingId: string | null
  readonly recent: ReadonlyArray<{ id: string; name: string; startedAt: number; state: string }>
}

export interface MeetingRecorderDeps {
  readonly store: MeetingStore
  readonly userDataDir: string
  /** 主进程的麦克风仲裁（index.ts 的 applyAudio 形状）。 */
  readonly audio: (event: AudioEvent) => AudioTransition
  /** 往渲染层发事件（index.ts 的 sendToRenderer 形状）。 */
  readonly notifyRenderer: (channel: string, payload: unknown) => void
  /** 转写实现。默认懒加载 asr.ts 的 transcribeWav；测试注入假的。 */
  readonly transcribe?: (wav: ArrayBuffer, userDataDir: string) => Promise<MeetingAsrResult>
  readonly now?: () => number
  /** 通知渲染层停流后，等它冲刷最后一块的超时。到点强制结算，不能永远挂着。 */
  readonly flushTimeoutMs?: number
}

const SAMPLE_RATE = 16000
/** 16kHz × 16bit mono：每毫秒 32 字节。 */
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000

interface ActiveMeeting {
  readonly meetingId: string
  readonly name: string
  readonly sources: MeetingSources
  readonly startedAt: number
  stopping: boolean
  finalized: boolean
  missingTracks: Array<'mic' | 'loopback'>
}

interface LastMeeting {
  readonly meetingId: string
  readonly name: string
  readonly sources: MeetingSources
  readonly startedAt: number
  readonly missingTracks: ReadonlyArray<'mic' | 'loopback'>
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
}

/**
 * 本地模板生成纪要：议题=会议名、时间线=逐段文本、行动项留空待用户填。
 * 助理播报区间单列一节并注明不算真人发言——TTS 的声音被 loopback 录进去时，
 * 不能让它冒充参会者说过的话。
 */
export function buildMinutesContent(input: MinutesInput): string {
  const lines: string[] = []
  lines.push(`# 会议纪要：${input.name}`)
  lines.push('')
  lines.push(`- 时间：${formatTime(input.startedAt)} — ${formatTime(input.endedAt)}`)
  lines.push(`- 录音来源：${input.sources === 'mic+loopback' ? '麦克风 + 系统回环声' : '麦克风'}`)
  if (input.missingTracks.length > 0) {
    lines.push(`- 音轨缺失：${input.missingTracks.join('、')}（缺失期间未录到内容，不做推测）`)
  }
  lines.push(`- 知情同意：${input.consentText}`)
  lines.push(`- 保留期：${input.retentionDays} 天（到期自动删除录音分块；转写与纪要保留）`)
  lines.push('')
  lines.push('## 时间线')
  if (input.segments.length === 0) {
    lines.push('- （没有可用的转写内容）')
  } else {
    for (const segment of input.segments) {
      const uncertain = segment.uncertain ? '（说话人未经确认）' : ''
      lines.push(`- [${mmss(segment.startMs)}–${mmss(segment.endMs)}] ${segment.label}${uncertain}：${segment.text}`)
    }
  }
  lines.push('')
  lines.push('## 助理播报区间（不算真人发言）')
  if (input.assistantSpeech.length === 0) {
    lines.push('- 无')
  } else {
    for (const span of input.assistantSpeech) {
      lines.push(`- [${mmss(span.startMs)}–${mmss(span.endMs)}] 桌面助理 TTS 播报；此区间的声音是助理自己，不代表任何参会者发言`)
    }
  }
  lines.push('')
  lines.push('## 行动项')
  lines.push('- （待填写：由与会人确认后补充）')
  lines.push('')
  return lines.join('\n')
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
  private closed = false

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

  private broadcast(): void {
    this.deps.notifyRenderer('meeting-state-changed', this.getState())
  }

  getState(): MeetingRuntimeState {
    const active = this.active
    const last = active !== null ? active : this.last
    return {
      recording: active !== null && !active.stopping,
      stopping: active !== null && active.stopping,
      meetingId: active?.meetingId ?? null,
      name: last?.name ?? '',
      sources: last?.sources ?? null,
      startedAt: last?.startedAt ?? null,
      missingTracks: last?.missingTracks ?? [],
      transcribe: active !== null ? 'idle' : this.phase,
      transcribeNote: active !== null ? null : this.note,
      lastMeetingId: this.last?.meetingId ?? null,
      recent: this.store.listMeetings(10).map(m => ({ id: m.id, name: m.name, startedAt: m.startedAt, state: m.state })),
    }
  }

  /** 测试与接线用：等当前结算/转写任务落定。 */
  whenSettled(): Promise<void> {
    return this.settle ?? Promise.resolve()
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
    this.active = {
      meetingId: started.meetingId,
      name: consent.name.trim(),
      sources: consent.sources,
      startedAt: this.now(),
      stopping: false,
      finalized: false,
      missingTracks: [],
    }
    this.phase = 'idle'
    this.note = null
    // 通知渲染层开始流：它收到后用 getUserMedia 采音并逐块推 meetingChunk。
    this.deps.notifyRenderer('meeting-started', {
      meetingId: started.meetingId,
      sources: consent.sources,
      name: this.active.name,
      sampleRate: SAMPLE_RATE,
    })
    this.broadcast()
    return { ok: true, meetingId: started.meetingId }
  }

  /** 渲染层推上来的一块 base64 PCM（16kHz mono Int16）。到这里立即加密落盘。 */
  pushChunk(meetingId: string, chunkBase64: string): { ok: true; seq: number } | { ok: false; error: string } {
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
    const appended = this.store.appendChunk(meetingId, pcm, this.now())
    if (!appended.ok) return appended
    return { ok: true, seq: appended.seq }
  }

  /** 渲染层报告某条音轨拿不到（loopback 采集失败等）。如实记录，不伪造静音。 */
  reportTrackMissing(meetingId: string, kind: 'mic' | 'loopback'): void {
    const active = this.active
    if (active === null || active.meetingId !== meetingId) return
    if (!active.missingTracks.includes(kind)) active.missingTracks.push(kind)
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
    }
    this.store.stopMeeting(active.meetingId, this.now())
    // 先还设备再转写：转写不占麦克风，唤醒词没理由多停一分钟。
    this.deps.audio({ type: 'meeting-finished' })
    const task = this.runTranscribeJob(active.meetingId, this.last)
    this.settle = task
    this.broadcast()
    await task
  }

  /** 手动重转（面板上的重试按钮）。 */
  retranscribe(meetingId: string): { ok: true } | { ok: false; error: string } {
    const meeting = this.store.getMeeting(meetingId)
    if (meeting === null) return { ok: false, error: '没有这场会议' }
    if (meeting.state === 'recording') return { ok: false, error: '会议还在录制中' }
    const last: LastMeeting = {
      meetingId: meeting.id,
      name: meeting.name,
      sources: meeting.sources,
      startedAt: meeting.startedAt,
      missingTracks: this.last?.meetingId === meetingId ? this.last.missingTracks : [],
    }
    this.settle = this.runTranscribeJob(meetingId, last)
    void this.settle
    return { ok: true }
  }

  private async runTranscribeJob(meetingId: string, last: LastMeeting): Promise<void> {
    this.phase = 'transcribing'
    this.note = null
    this.store.setMeetingState(meetingId, 'transcribing')
    this.broadcast()
    const transcribe = this.deps.transcribe ?? ((wav, dir) => this.defaultTranscribe(wav, dir))
    try {
      const { chunks, corrupted } = this.store.readAllChunks(meetingId)
      const segments: TranscriptSegment[] = []
      let failures = corrupted.length
      for (const chunk of chunks) {
        const startMs = Math.max(0, chunk.ts - last.startedAt)
        const result = await transcribe(buildWav16kMono(chunk.pcm), this.deps.userDataDir)
        if (!result.ok || typeof result.text !== 'string' || result.text.trim() === '') {
          failures++
          continue
        }
        // 不猜说话人：机器产出的段全部 uncertain=true、单一默认标签，分组只来自用户修订。
        segments.push({
          idx: segments.length,
          speaker: 's1',
          label: '发言人1',
          uncertain: true,
          startMs,
          endMs: startMs + Math.round(chunk.pcm.length / BYTES_PER_MS),
          text: result.text.trim(),
          source: 'asr',
        })
      }
      if (segments.length === 0 && failures > 0) {
        this.phase = 'transcript-failed'
        this.note = `转写失败（${failures} 块无法识别）。录音已完整保留，可稍后重试。`
        this.store.setMeetingState(meetingId, 'transcript-failed')
      } else {
        const replaced = this.store.replaceSegments(meetingId, segments)
        const revision = replaced.ok ? replaced.revision : 0
        this.saveMinutesDraft(meetingId, last, revision)
        this.phase = 'transcribed'
        this.note =
          failures > 0 ? `有 ${failures} 块音频未能识别，其余已转写；录音完整保留。` : null
        this.store.setMeetingState(meetingId, 'transcribed')
      }
    } catch (error) {
      // 任何异常都不丢录音：chunk 已经加密落盘，这里只改状态。
      this.phase = 'transcript-failed'
      this.note = `转写异常：${error instanceof Error ? error.message : String(error)}。录音已保留。`
      this.store.setMeetingState(meetingId, 'transcript-failed')
    }
    this.broadcast()
  }

  /** 按当前段与助理播报区间生成纪要草稿并落库。 */
  private saveMinutesDraft(meetingId: string, last: LastMeeting | null, revision: number): void {
    const meeting = this.store.getMeeting(meetingId)
    if (meeting === null) return
    const content = buildMinutesContent({
      name: meeting.name,
      startedAt: meeting.startedAt,
      endedAt: meeting.endedAt,
      sources: meeting.sources,
      consentText: meeting.consent.consentText,
      retentionDays: meeting.retentionDays,
      segments: this.store.getSegments(meetingId),
      assistantSpeech: this.store.listAssistantSpeech(meetingId),
      missingTracks: last?.meetingId === meetingId ? [...last.missingTracks] : [],
    })
    this.store.saveMinutes(meetingId, content, revision)
  }

  /** narrator TTS 打点：记进 assistant_speech，纪要里单列并注明不算真人发言。 */
  markAssistantSpeech(startMs: number, endMs: number): void {
    const active = this.active
    if (active === null) return
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return
    this.store.addAssistantSpeech(active.meetingId, Math.max(0, Math.round(startMs)), Math.max(0, Math.round(endMs)))
  }

  // ===== 说话人修订（每次都 bump revision，纪要确认随之作废） =====

  getSpeakers(meetingId: string): {
    ok: true
    revision: number
    segments: TranscriptSegment[]
    speakers: Array<{ speaker: string; label: string; count: number }>
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
    return { ok: true, revision: meeting.segmentsRevision, segments, speakers }
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

  getMinutes(meetingId: string): { ok: true; minutes: ReturnType<MeetingStore['getMinutes']> } | { ok: false; error: string } {
    const meeting = this.store.getMeeting(meetingId)
    if (meeting === null) return { ok: false, error: '没有这场会议' }
    return { ok: true, minutes: this.store.getMinutes(meetingId) }
  }

  confirmMinutes(meetingId: string): { ok: true; confirmedAt: number } | { ok: false; error: string } {
    // userClicked 恒为 true：这条 IPC 只有面板上那个按钮会调，确认动作本身就是用户点的。
    const result = this.store.confirmMinutes(meetingId, { userClicked: true })
    if (result.ok) this.broadcast()
    return result
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
    const settled = this.settle === null || await Promise.race([
      this.settle.then(() => true, () => true),
      new Promise<boolean>(resolve => { setTimeout(() => resolve(false), 1500).unref() }),
    ])
    if (settled && !this.closed) {
      this.closed = true
      this.store.close()
    }
  }
}

/** 建一套默认接线的 store + recorder。主代理只需再提供 audio 与 notifyRenderer。 */
export function createMeetingRecorder(deps: {
  userDataDir: string
  audio: (event: AudioEvent) => AudioTransition
  notifyRenderer: (channel: string, payload: unknown) => void
  storeDeps?: MeetingStoreDeps
  transcribe?: (wav: ArrayBuffer, userDataDir: string) => Promise<MeetingAsrResult>
  now?: () => number
  flushTimeoutMs?: number
}): MeetingRecorder {
  const store = new MeetingStore(deps.userDataDir, deps.storeDeps ?? {})
  return new MeetingRecorder({
    store,
    userDataDir: deps.userDataDir,
    audio: deps.audio,
    notifyRenderer: deps.notifyRenderer,
    ...(deps.transcribe !== undefined ? { transcribe: deps.transcribe } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.flushTimeoutMs !== undefined ? { flushTimeoutMs: deps.flushTimeoutMs } : {}),
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

  ipc.handle('meeting-chunk', (_event, meetingId: unknown, chunkBase64: unknown) => {
    const id = asString(meetingId)
    const chunk = asString(chunkBase64)
    if (id === null || chunk === null) return { ok: false, error: '参数不对' }
    return recorder.pushChunk(id, chunk)
  })

  ipc.handle('meeting-track-missing', (_event, meetingId: unknown, kind: unknown) => {
    const id = asString(meetingId)
    if (id === null || (kind !== 'mic' && kind !== 'loopback')) return { ok: false, error: '参数不对' }
    recorder.reportTrackMissing(id, kind)
    return { ok: true }
  })

  ipc.handle('meeting-flush-done', async (_event, meetingId: unknown) => {
    const id = asString(meetingId)
    if (id === null) return { ok: false, error: '参数不对' }
    return recorder.flushDone(id)
  })

  ipc.handle('meeting-state', () => recorder.getState())

  ipc.handle('meeting-transcribe', (_event, meetingId: unknown) => {
    const id = asString(meetingId)
    if (id === null) return { ok: false, error: '参数不对' }
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

  ipc.handle('meeting-minutes', (_event, meetingId: unknown) => {
    const id = asString(meetingId)
    if (id === null) return { ok: false, error: '参数不对' }
    return recorder.getMinutes(id)
  })

  ipc.handle('meeting-minutes-confirm', (_event, meetingId: unknown) => {
    const id = asString(meetingId)
    if (id === null) return { ok: false, error: '参数不对' }
    return recorder.confirmMinutes(id)
  })
}

export type { MeetingConsentInput, MeetingRow }
