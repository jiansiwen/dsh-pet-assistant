/**
 * 会议页：开始表单（名称/来源/知情勾选/保留天数）、录音中的红色常显标识与立即停止、
 * 各音轨收音状态与临时字幕、转写状态、说话人修订列表、纪要预览与确认按钮。
 *
 * 采音在这一层做（getUserMedia）：主进程拿不到 Web 音频设备。麦克风与系统回环声（loopback）
 * **各自一条音轨**：每路单独缓冲、单独切块（TrackChunker，约 4 秒一块），块带音源、轨内序号、
 * 起点（相对会议开始的毫秒）、原始采样率与 16k 帧数，经 petApi.meetingChunk 推上去，主进程
 * 收到立即 AES-256-GCM 加密落盘——明文不过夜，两路也绝不交错拼成一条。两路共用一个
 * AudioContext 的时钟，相对对齐不受墙钟误差影响。
 *
 * loopback 用 chromeMediaSource desktop 尝试；拿不到就如实上报 track 缺失（meetingTrackMissing），
 * **不伪造静音块**：纪要里会写"这条音轨没录到"。某条音轨中途结束（设备拔出）就把它的残块
 * 冲刷掉并停止处理，之后那段时间在时间轴上是缺口，不会被静音填成"录到了"。
 *
 * 停止是两段式：主进程发 meeting-stopping → 这里停轨、把两路缓冲里最后一块都推完 →
 * meetingFlushDone 触发结算。直接停会丢会议最后几秒。采集句柄放在模块级：会议页在录音中被
 * 切走再切回来（组件卸载重建）也找得到它，停得下麦克风。
 *
 * 说话人：停录后主进程用本地模型自动分人（同一音轨内分组，标签如「本机麦克风·发言人1」
 * 「对方·发言人2」），全部标"未确认"；模型缺失或失败时整条音轨归一组并写明"未自动分人"。
 * 最终分组只来自用户在这个页面上的改名/合并/拆分。纪要确认按钮是唯一能把纪要置成 confirmed 的入口。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { pcm16Base64, resampleTo16k } from './dictation.js'
import { TrackChunker, type TrackChunk } from './meeting-capture.js'
import { frameWallMs, sharedCapture, type CaptureSubscription } from './audio-capture.ts'
import MeetingMinutesReview from './meeting-minutes-review.js'
import type {
  LiveCaption,
  MeetingConsentInput,
  MeetingFlushReport,
  MeetingIntegrity,
  MeetingMinutesResult,
  MeetingRuntimeState,
  MeetingSpeakersResult,
  MeetingStartedPayload,
  MeetingTrack,
  TranscriptSegment,
} from './types.js'

/** 开始会议前用户必须勾选知情的文本。主进程会把它整份存进 consent 记录。 */
export const MEETING_CONSENT_TEXT =
  '我知晓本场会议将被录音：音频加密保存在本机、按保留期自动删除，转写与纪要保留；我会告知其他参会者本次录音。'

/** 每块的目标时长（毫秒）。主进程按块做临时字幕，块太长字幕就滞后。 */
const CHUNK_MS = 4000
/** ScriptProcessor 缓冲帧数。两路一样大，回调延迟一致，相对对齐不受影响。 */
const PROCESSOR_FRAMES = 4096
/** 停录时距最后一帧超过此时长，尾部可能丢音，不能按完整录音结算。 */
const TRACK_STALL_MS = 1500

const TRACK_NAME: Record<MeetingTrack, string> = { mic: '本机麦克风', loopback: '对方（系统回环声）' }
const TRACK_SHORT: Record<MeetingTrack, string> = { mic: '本机麦克风', loopback: '对方' }

interface CaptureHandle {
  readonly meetingId: string
  stopAndFlush(): Promise<{ ok: boolean; error?: string }>
}

/** 进行中的采集。模块级而不是组件 ref：会议页卸载重建后仍要能停下它。 */
let activeCapture: CaptureHandle | null = null
/** 采集正在打开设备的会议（getUserMedia 要几百毫秒）。 */
let startingFor: string | null = null
/** 开轨过程中停止时立即撤销已取得的设备，不等待另一条音轨打开。 */
let startingController: AbortController | null = null
/** 设备还没打开完就收到了停止：打开后立刻停。 */
let stopRequestedFor: string | null = null

/**
 * 拿系统回环声（会议里"对方的声音"）。
 *
 * 两条路，按顺序试：
 *
 * 1. **`getDisplayMedia`（Electron 17+ 的正路）**。主进程的 `setDisplayMediaRequestHandler`
 *    决定给什么：这里只批准音频回环，画面拿到后立刻停掉 —— 会议不录屏。
 * 2. **旧的 `chromeMediaSource: 'desktop'` 约束**。老版本 Electron 才认；留作兜底。
 *
 * 两条都失败返回 null，由调用方如实上报缺失。
 *
 * ⚠️ macOS 13 以下不支持 `audio: 'loopback'`：那时第 1 条会成功但要不到音轨
 * （`getAudioTracks()` 为空），所以这里检查的是"有没有音轨"而不是"有没有抛错"。
 */
async function openLoopback(): Promise<{ stream: MediaStream | null; reason: string | null }> {
  const takeAudioOnly = (stream: MediaStream): MediaStream | null => {
    // 不管哪条路，视频轨一律停掉：只录声音是承诺，不是实现细节。
    for (const video of stream.getVideoTracks()) {
      video.stop()
      stream.removeTrack(video)
    }
    if (stream.getAudioTracks().length > 0) return stream
    stream.getTracks().forEach(track => track.stop())
    return null
  }

  // 1) Electron 的正路。需要主进程注册 setDisplayMediaRequestHandler，否则直接 reject。
  const media = navigator.mediaDevices as MediaDevices & {
    getDisplayMedia?: (constraints?: MediaStreamConstraints) => Promise<MediaStream>
  }
  if (typeof media.getDisplayMedia === 'function') {
    try {
      const stream = await media.getDisplayMedia({ audio: true, video: true })
      const audioOnly = takeAudioOnly(stream)
      if (audioOnly !== null) return { stream: audioOnly, reason: null }
      return { stream: null, reason: '这个系统没有提供系统音频轨（macOS 13 以下不支持回环声），只录了本机麦克风' }
    } catch (error) {
      console.error('[meeting] getDisplayMedia failed:', error)
    }
  }

  // 2) 旧约束兜底。
  const attempts = [
    { audio: { mandatory: { chromeMediaSource: 'desktop' } }, video: false },
    { audio: { mandatory: { chromeMediaSource: 'desktop' } }, video: { mandatory: { chromeMediaSource: 'desktop' } } },
  ] as unknown as MediaStreamConstraints[]
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      const audioOnly = takeAudioOnly(stream)
      if (audioOnly !== null) return { stream: audioOnly, reason: null }
    } catch (error) {
      console.error('[meeting] loopback capture attempt failed:', error)
    }
  }
  return { stream: null, reason: null }
}

/**
 * 开始采音。mic 必采；sources 含 loopback 时再试系统回环声，失败只标缺失不中断会议。
 * mic 本身拿不到时也如实上报——会议照常"录"，但状态里能看到缺了什么，纪要不会假装录到了内容。
 */
async function startMeetingCapture(
  payload: MeetingStartedPayload, api: Window['petApi'], signal: AbortSignal, onError: (reason: string) => void,
): Promise<CaptureHandle | null> {
  const { meetingId, sources } = payload
  const wanted: MeetingTrack[] = sources === 'mic+loopback' ? ['mic', 'loopback'] : ['mic']
  let chain: Promise<void> = Promise.resolve()
  const errors: string[] = []
  const progress: Record<MeetingTrack, { sent: number | null; acknowledged: number | null }> = {
    mic: { sent: null, acknowledged: null }, loopback: { sent: null, acknowledged: null },
  }
  const noteError = (reason: string): void => {
    if (errors.length < 32) {
      errors.push(reason.slice(0, 240))
      onError(reason)
    }
    console.error('[meeting]', reason)
  }
  const reportMissing = (track: MeetingTrack, reason?: string): void => {
    noteError(`${track} 音轨缺失或中断：${reason ?? '未能采集'}`)
    // 排在该轨残块之后，避免主进程先将音轨标为缺失而拒收残块。
    chain = chain.then(async () => {
      try {
        const result = await api.meetingTrackMissing(meetingId, track, reason)
        if (!result.ok) noteError(`${track} 音轨缺失报告失败：${result.error ?? '主进程拒绝'}`)
      } catch (error) {
        noteError(`${track} 音轨缺失报告异常：${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    // 不能写 wanted.forEach(reportMissing)：forEach 会把数组下标当第二个参数传进去，
    // 于是"原因"变成 0/1 这种数字。必须显式包一层。
    for (const track of wanted) reportMissing(track)
    await chain
    return null
  }

  let context: AudioContext
  try {
    context = new AudioContext()
    if (context.state === 'suspended') await context.resume().catch(() => undefined)
  } catch {
    for (const track of wanted) reportMissing(track)
    await chain
    return null
  }

  // 时间轴零点是主进程的会议开始时刻；之后全按这一个 AudioContext 的时钟推进。
  const meetingStartedAt = typeof payload.startedAt === 'number' && Number.isFinite(payload.startedAt) ? payload.startedAt : Date.now()
  const anchorWallMs = Date.now()
  const anchorCtx = context.currentTime
  const toMeetingMs = (ctxTime: number): number => anchorWallMs - meetingStartedAt + (ctxTime - anchorCtx) * 1000
  const bufferMs = (PROCESSOR_FRAMES / context.sampleRate) * 1000

  /** 推块串行化：meetingChunk 是异步的，乱序会让主进程的轨内序号校验拒块。 */
  let stopped = false
  let stoppedAt: number | null = null
  let stopping: Promise<{ ok: boolean; error?: string }> | null = null
  let micSubscription: CaptureSubscription | null = null
  const mediaTracks: MediaStreamTrack[] = []
  const chunkers: TrackChunker[] = []
  const lastFrameAt: Record<MeetingTrack, number | null> = { mic: null, loopback: null }
  let contextClosing: Promise<void> | null = null
  const closeContext = (): Promise<void> => {
    if (contextClosing === null) {
      contextClosing = (async () => {
        try { await context.close() } catch (error) { noteError(`采集上下文关闭失败：${error instanceof Error ? error.message : String(error)}`) }
      })()
    }
    return contextClosing
  }
  const stopOpening = (): void => {
    stopped = true
    stoppedAt ??= performance.now()
    try { micSubscription?.close() } catch (error) { noteError(`麦克风释放失败：${error instanceof Error ? error.message : String(error)}`) }
    for (const track of mediaTracks) {
      try { track.stop() } catch (error) { noteError(`音轨释放失败：${error instanceof Error ? error.message : String(error)}`) }
    }
    void closeContext()
  }
  signal.addEventListener('abort', stopOpening, { once: true })
  if (signal.aborted) stopOpening()
  const send = (chunk: TrackChunk): void => {
    const b64 = pcm16Base64(chunk.pcm16k)
    const { track, seq } = chunk.meta
    progress[track].sent = seq
    chain = chain.then(async () => {
      try {
        const result = await api.meetingChunk(meetingId, b64, chunk.meta)
        if (!result.ok || !Number.isSafeInteger(result.seq)) {
          noteError(`${track} 音轨第 ${seq} 块未确认：${result.error ?? '主进程没有给出落盘序号'}`)
          return
        }
        progress[track].acknowledged = seq
      } catch (error) {
        noteError(`${track} 音轨第 ${seq} 块发送异常：${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  // ScriptProcessor 要接到 destination 才跑；直连会外放会议声音，挂一个静音节点。
  let mute: ScriptProcessorNode
  try {
    mute = context.createScriptProcessor(256, 1, 1)
    mute.onaudioprocess = () => undefined
    mute.connect(context.destination)
  } catch (error) {
    for (const track of wanted) reportMissing(track, error instanceof Error ? error.message : '音频处理节点创建失败')
    void closeContext()
    await chain
    await closeContext()
    return null
  }

  const attach = (track: MeetingTrack, stream: MediaStream): void => {
    const chunker = new TrackChunker({ track, sampleRate: context.sampleRate, chunkMs: CHUNK_MS, resample: resampleTo16k })
    chunkers.push(chunker)
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(PROCESSOR_FRAMES, 1, 1)
    let ended = false
    processor.onaudioprocess = (event) => {
      if (stopped || ended) return
      lastFrameAt[track] = performance.now()
      const data = event.inputBuffer.getChannelData(0)
      // playbackTime 是这批样本在音频时钟上的位置；输入大约早一个缓冲。两路同一个 context，偏移一致。
      const ctxTime = Number.isFinite(event.playbackTime) && event.playbackTime > 0 ? event.playbackTime : context.currentTime
      const before = chunker.discontinuities
      const chunks = chunker.push(data, toMeetingMs(ctxTime) - bufferMs)
      if (chunker.discontinuities > before) noteError(`${track} 音轨采集出现时间缺口`)
      for (const chunk of chunks) send(chunk)
    }
    for (const media of stream.getTracks()) {
      mediaTracks.push(media)
      // 设备中途没了：残块冲刷掉、这一路停止处理。之后的时间是缺口，绝不让静音冒充录音。
      media.addEventListener('ended', () => {
        if (ended || stopped) return
        ended = true
        const rest = chunker.flush()
        if (rest !== null) send(rest)
        try { processor.disconnect() } catch { /* 已断开 */ }
        console.error(`[meeting] ${track} 音轨中途结束`)
        reportMissing(track, '音轨中途结束，后续音频未录到')
      })
    }
    source.connect(processor)
    processor.connect(mute)
  }

  // 麦克风轨来自共享采集（M1-03）：会议只是它的一个消费者，凭主进程下发的会议授权订阅
  //（令牌 = 正在录的会议 id），不再自己开设备。帧的时间戳是单调时钟，换算到会议时间轴；
  // 设备重开后采样率变了就换一个切块器，轨内序号接着编。
  let micChunker: TrackChunker | null = null
  let micRate = 0
  let micEnded = false
  try {
    const capture = sharedCapture()
    if (!await capture.waitForGrant('meeting', 2000, meetingId)) throw new Error('没有收到这场会议的麦克风授权')
    if (signal.aborted) {
      reportMissing('mic', '麦克风开轨期间收到停止，未开始采集')
    } else micSubscription = await capture.subscribe({
      kind: 'meeting',
      token: meetingId,
      onFrame: (frame) => {
        if (stopped || micEnded) return
        lastFrameAt.mic = performance.now()
        if (frame.gapBefore) noteError('mic 音轨设备重开或采集出现时间缺口')
        if (micChunker === null || frame.sampleRate !== micRate) {
          const rest = micChunker?.flush() ?? null
          if (rest !== null) send(rest)
          micRate = frame.sampleRate
          micChunker = new TrackChunker({ track: 'mic', sampleRate: micRate, chunkMs: CHUNK_MS, resample: resampleTo16k, firstSeq: micChunker?.seq ?? 0 })
        }
        for (const chunk of micChunker.push(frame.samples, frameWallMs(frame) - meetingStartedAt)) send(chunk)
      },
      onEnd: (receipt) => {
        if (receipt.reason === 'unsubscribed' || micEnded) return
        // 设备中途没了 / 授权被收回：残块冲刷掉、这一路停止处理。之后是缺口，不用静音冒充。
        micEnded = true
        const rest = micChunker?.flush() ?? null
        if (rest !== null) send(rest)
        console.error(`[meeting] mic 音轨中途结束：${receipt.reason}`)
        reportMissing('mic', `麦克风中途结束：${receipt.reason}`)
      },
    })
    if (signal.aborted) micSubscription?.close()
  } catch (error) {
    console.error('[meeting] mic capture failed:', error)
    reportMissing('mic', error instanceof Error ? error.message : '麦克风采集失败')
  }

  if (sources === 'mic+loopback') {
    // 先问主进程"现在能不能采系统音频"。拿不到就直接记缺失并跳过，不去反复试 ——
    // 无权限时每一次尝试都会被拒，而用户只会看到"对方的声音一直没录到"。
    try {
      if (signal.aborted) {
        reportMissing('loopback', '停止时系统音轨尚未开启')
      } else {
        const capability = await api.meetingLoopbackCapability()
        if (signal.aborted) {
          reportMissing('loopback', '停止时系统音轨尚未开启')
        } else if (!capability.available) {
          reportMissing('loopback', capability.reason ?? '这个系统上采不到系统音频')
        } else {
          const loop = await openLoopback()
          if (loop.stream === null) reportMissing('loopback', loop.reason ?? undefined)
          else if (signal.aborted) {
            for (const track of loop.stream.getTracks()) { try { track.stop() } catch { /* 已停 */ } }
            reportMissing('loopback', '停止后系统音轨才返回，已立即关闭')
          } else {
            try { attach('loopback', loop.stream) } catch (error) {
              for (const track of loop.stream.getTracks()) { try { track.stop() } catch { /* 已停 */ } }
              reportMissing('loopback', error instanceof Error ? error.message : '系统音轨连接失败')
            }
          }
        }
      }
    } catch (error) {
      reportMissing('loopback', error instanceof Error ? error.message : '系统音频能力查询失败')
    }
  }

  return {
    meetingId,
    stopAndFlush(): Promise<{ ok: boolean; error?: string }> {
      if (stopping !== null) return stopping
      stopping = (async () => {
        stopped = true
        stoppedAt ??= performance.now()
        signal.removeEventListener('abort', stopOpening)
        for (const track of wanted) {
          const last = lastFrameAt[track]
          if (last !== null && stoppedAt - last > TRACK_STALL_MS) noteError(`${track} 音轨停录前采集长时间中断，尾部可能存在缺口`)
        }
        // 两路各自把缓冲里的最后一块推完，再报 flushDone——顺序反了会丢会议最后几秒。
        for (const chunker of [...chunkers, ...(micChunker === null ? [] : [micChunker])]) {
          try {
            const last = chunker.flush()
            if (last !== null) send(last)
          } catch (error) {
            noteError(`${chunker.track} 音轨冲刷失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        try { micSubscription?.close() } catch (error) { noteError(`麦克风释放失败：${error instanceof Error ? error.message : String(error)}`) }
        for (const track of mediaTracks) {
          try { track.stop() } catch (error) { noteError(`音轨释放失败：${error instanceof Error ? error.message : String(error)}`) }
        }
        await closeContext()
        await chain
        const report: MeetingFlushReport = {
          tracks: Object.fromEntries(wanted.map(track => [track, { ...progress[track] }])),
          errors: [...errors],
        }
        const unconfirmed = wanted.find(track => progress[track].sent === null || progress[track].acknowledged !== progress[track].sent)
        const localFailure = errors[0] ?? (unconfirmed ? `${unconfirmed} 音轨末块未确认` : null)
        try {
          const result = await api.meetingFlushDone(meetingId, report)
          if (!result.ok) return { ok: false, error: result.error ?? '录音冲刷未能确认' }
          if (localFailure !== null) return { ok: false, error: `录音不完整：${localFailure}` }
          return { ok: true }
        } catch (error) {
          return { ok: false, error: `录音冲刷回执异常：${error instanceof Error ? error.message : String(error)}` }
        }
      })()
      return stopping
    },
  }
}

function mmss(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '--:--'
  const total = Math.floor(ms / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function captionText(caption: LiveCaption): string {
  switch (caption.status) {
    case 'ok': return caption.text ?? ''
    case 'pending': return '（转写中…）'
    case 'failed': return '（这块临时转写失败，停录后会重新转写）'
    case 'skipped': return '（来不及临时转写，停录后补上）'
    case 'empty': return '（没听到说话）'
  }
}

export interface MeetingPanelProps {
  /** 主代理接线到面板显示逻辑的关闭回调；不传就不显示关闭按钮。 */
  readonly onClose?: () => void
}

type TranscriptInfo = NonNullable<MeetingSpeakersResult['transcript']>

export default function MeetingPanel({ onClose }: MeetingPanelProps) {
  const api = typeof window !== 'undefined' ? window.petApi : undefined
  const [runtime, setRuntime] = useState<MeetingRuntimeState | null>(null)
  const [name, setName] = useState('')
  const [sources, setSources] = useState<'mic' | 'mic+loopback'>('mic')
  const [consented, setConsented] = useState(false)
  const [retentionDays, setRetentionDays] = useState(30)
  const [formError, setFormError] = useState<string | null>(null)
  /** 当前查看转写/纪要的会议。默认最近一场。 */
  const [selected, setSelected] = useState<string | null>(null)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [transcriptInfo, setTranscriptInfo] = useState<TranscriptInfo | null>(null)
  const [detailIntegrity, setDetailIntegrity] = useState<MeetingIntegrity | null>(null)
  const [revision, setRevision] = useState(0)
  /** 纪要 + 数据去向授权 + 模型是否可用（M4-06）。 */
  const [minutes, setMinutes] = useState<MeetingMinutesResult | null>(null)
  /** 纪要来源点过来要高亮的转写段（idx）。 */
  const [focusSeg, setFocusSeg] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [splitLabel, setSplitLabel] = useState('')
  const [mergeFrom, setMergeFrom] = useState('')
  const [mergeInto, setMergeInto] = useState('')
  const [renameFor, setRenameFor] = useState<{ speaker: string; label: string } | null>(null)
  const [elapsed, setElapsed] = useState('')
  const handledCommands = useRef(new Set<string>())

  const selectedId = selected ?? runtime?.lastMeetingId ?? null
  const recording = runtime?.recording === true
  const stopping = runtime?.stopping === true
  const transcribing = runtime?.transcribe === 'transcribing'

  const loadDetail = useCallback(async (meetingId: string | null) => {
    if (api === undefined || meetingId === null) {
      setSegments([])
      setTranscriptInfo(null)
      setDetailIntegrity(null)
      setMinutes(null)
      return
    }
    const [speakers, minutesResult] = await Promise.all([
      api.meetingSpeakers(meetingId).catch(() => null),
      api.meetingMinutes(meetingId).catch(() => null),
    ])
    if (speakers !== null && speakers.ok) {
      setSegments(speakers.segments ?? [])
      setTranscriptInfo(speakers.transcript ?? null)
      setDetailIntegrity(speakers.integrity ?? null)
      setRevision(speakers.revision ?? 0)
    }
    setMinutes(minutesResult !== null && minutesResult.ok ? minutesResult : null)
  }, [api])

  // 状态投影与采音生命周期。preload 的 subscribe 会先清旧监听，重复挂载不会堆积。
  useEffect(() => {
    if (api === undefined) return
    const showFlush = (result: { ok: boolean; error?: string }): void => {
      if (!result.ok) setNotice(result.error ?? '录音停止结果未能确认')
    }
    const finish = (handle: CaptureHandle): void => {
      void handle.stopAndFlush().then(showFlush).catch(() => setNotice('录音冲刷异常，停止结果未知'))
    }
    const noCapture = (meetingId: string): void => {
      setNotice('录音停止结果未知：渲染层没有可停止和核验的采集句柄')
      void api.meetingFlushDone(meetingId, { tracks: {}, errors: ['渲染层没有可停止和核验的采集句柄'] })
        .then(showFlush).catch(() => setNotice('录音冲刷回执异常，停止结果未知'))
    }
    void api.meetingState().then(setRuntime).catch(() => undefined)
    api.onMeetingState((state) => setRuntime(state))
    api.onMeetingStarted((payload) => {
      startingFor = payload.meetingId
      stopRequestedFor = null
      const controller = new AbortController()
      startingController = controller
      void startMeetingCapture(payload, api, controller.signal, reason => setNotice(`录音不完整：${reason}`)).then((handle) => {
        startingFor = null
        if (startingController === controller) startingController = null
        const stopNow = stopRequestedFor === payload.meetingId
        stopRequestedFor = null
        if (handle === null) {
          if (stopNow) noCapture(payload.meetingId)
          return
        }
        if (stopNow) {
          finish(handle)
          return
        }
        activeCapture = handle
      }).catch(() => {
        startingFor = null
        if (startingController === controller) startingController = null
        setNotice('会议采集启动失败，录音完整性未知')
        if (stopRequestedFor === payload.meetingId) {
          stopRequestedFor = null
          noCapture(payload.meetingId)
        }
      })
    })
    api.onMeetingStopping((payload) => {
      const handle = activeCapture
      if (handle !== null && handle.meetingId === payload.meetingId) {
        activeCapture = null
        finish(handle)
        return
      }
      if (startingFor === payload.meetingId) {
        stopRequestedFor = payload.meetingId
        startingController?.abort()
        return
      }
      // 没有在采（设备一路都没拿到）：没有块要冲刷，直接告诉主进程可以结算，不用干等超时。
      noCapture(payload.meetingId)
    })
  }, [api])

  // 换了一场要看的会议、或转写阶段变了（精修写完库）就重新拉段与纪要。
  useEffect(() => {
    void loadDetail(selectedId)
    setPicked(new Set())
  }, [loadDetail, selectedId, revision, runtime?.transcribe])

  // 录音中的计时显示。
  useEffect(() => {
    if (!recording || runtime?.startedAt == null) {
      setElapsed('')
      return
    }
    const tick = (): void => {
      const seconds = Math.max(0, Math.floor((Date.now() - (runtime.startedAt ?? 0)) / 1000))
      const m = Math.floor(seconds / 60)
      const s = seconds % 60
      setElapsed(`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`)
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [recording, runtime?.startedAt])

  const start = useCallback(async () => {
    if (api === undefined) return
    setFormError(null)
    const result = await api.meetingStart({
      name,
      sources,
      consentText: MEETING_CONSENT_TEXT,
      consented,
      retentionDays,
    }).catch(() => ({ ok: false, error: '主进程没有响应' }))
    if (!result.ok) setFormError(result.error ?? '无法开始会议')
  }, [api, consented, name, retentionDays, sources])

  const stop = useCallback(async () => {
    if (api === undefined) return
    const result = await api.meetingStop().catch(() => ({ ok: false, error: '主进程没有响应' }))
    if (!result.ok) setNotice(result.error ?? null)
  }, [api])

  /** 子助理通过桌面命令发起：用户已在桌面明确要求，直接用这次指令作为知情记录开录。 */
  const startFromCommand = useCallback(async (command: { requestId: string; consent: MeetingConsentInput }) => {
    if (api === undefined || handledCommands.current.has(command.requestId)) return
    handledCommands.current.add(command.requestId)
    setFormError(null)
    setName(command.consent.name)
    setSources(command.consent.sources)
    setRetentionDays(command.consent.retentionDays)
    setConsented(true)
    const result = await api.meetingStart(command.consent, command.requestId).catch(() => ({ ok: false, error: '主进程没有响应' }))
    if (!result.ok) setFormError(result.error ?? '无法开始会议')
  }, [api])

  // 菜单页挂载时取一次待执行命令；已挂载时由 meeting-command 推送，两条路都按 requestId 去重。
  useEffect(() => {
    if (api === undefined) return
    let cancelled = false
    void api.meetingTakeCommand().then(command => {
      if (!cancelled && command) void startFromCommand(command)
    }).catch(() => undefined)
    const off = api.onMeetingCommand(command => { if (!cancelled) void startFromCommand(command) })
    return () => { cancelled = true; off() }
  }, [api, startFromCommand])

  const runEdit = useCallback(async (edit: () => Promise<{ ok: boolean; error?: string; revision?: number }>, okMessage: string) => {
    if (api === undefined) return
    const result: { ok: boolean; error?: string; revision?: number } = await edit().catch(() => ({ ok: false, error: '主进程没有响应' }))
    if (!result.ok) {
      setNotice(result.error ?? '修订失败')
      return
    }
    setNotice(okMessage)
    if (result.revision !== undefined) setRevision(result.revision)
    await loadDetail(selectedId)
  }, [api, loadDetail, selectedId])

  const retranscribe = useCallback(async () => {
    if (api === undefined || selectedId === null) return
    const result = await api.meetingTranscribe(selectedId).catch(() => ({ ok: false, error: '主进程没有响应' }))
    setNotice(result.ok ? '已重新开始转写' : result.error ?? '无法重转写')
  }, [api, selectedId])

  const retryFailed = useCallback(async () => {
    if (api === undefined || selectedId === null) return
    const result = await api.meetingRetryFailed(selectedId).catch(() => ({ ok: false, error: '主进程没有响应' }))
    setNotice(result.ok ? '正在重试失败的片段（其余段与你的修订不动）' : result.error ?? '无法重试')
  }, [api, selectedId])

  /** 纪要条目的来源被点：滚到转写里那一段并高亮，定位回原片段。 */
  const locateSegment = useCallback((idx: number) => {
    setFocusSeg(idx)
    if (typeof document !== 'undefined') {
      document.getElementById(`meeting-seg-${idx}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [])

  const reloadDetail = useCallback(() => loadDetail(selectedId), [loadDetail, selectedId])

  if (api === undefined) return null

  const speakers = segments.reduce<Array<{ speaker: string; label: string; count: number }>>((acc, segment) => {
    const found = acc.find(entry => entry.speaker === segment.speaker)
    if (found !== undefined) found.count++
    else acc.push({ speaker: segment.speaker, label: segment.label, count: 1 })
    return acc
  }, [])
  const failedCount = segments.filter(segment => segment.source === 'failed').length
  const isLatest = selectedId !== null && selectedId === runtime?.lastMeetingId
  const transcribeLabel =
    runtime === null || !isLatest ? '' :
    runtime.transcribe === 'transcribing' ? '转写中（会后精修：按音轨分人、逐段转写）…' :
    runtime.transcribe === 'transcribed' ? '转写完成' :
    runtime.transcribe === 'transcript-failed' ? '转写失败（录音已保留）' : ''
  const runtimeNote = isLatest && runtime?.transcribeNote != null && runtime.transcribeNote !== '' ? runtime.transcribeNote : null
  const storedNote = runtimeNote === null ? transcriptInfo?.note ?? null : null
  const selectedRecent = runtime?.recent.find(item => item.id === selectedId)
  const selectedIntegrity = selectedRecent ? selectedRecent.integrity : detailIntegrity
  const wantedTracks: MeetingTrack[] = runtime?.sources === 'mic+loopback' ? ['mic', 'loopback'] : ['mic']
  const live = runtime?.live ?? null
  const liveCaptions = live === null ? [] : live.captions.filter(caption => caption.status !== 'empty')
  const showLive = live !== null && (recording || stopping || (live.meetingId === selectedId && segments.length === 0))

  return (
    <div className="meeting-page" id="panel-page-meeting" role="tabpanel" aria-labelledby="panel-tab-meeting">
      {/* 录音中红色常显标识：只要还在录，无论切到哪一节都挂着。 */}
      {(recording || stopping) && (
        <div className={'meeting-rec-banner' + (stopping ? ' stopping' : '')} role="status">
          <span className="meeting-rec-dot" aria-hidden="true" />
          <span className="meeting-rec-text">
            {stopping ? '正在停止并保存…' : `录音中：${runtime?.name ?? ''} ${elapsed}`}
          </span>
          {!stopping && (
            <button type="button" className="meeting-btn danger" onClick={() => void stop()}>
              立即停止
            </button>
          )}
        </div>
      )}

      {notice !== null && <p className="meeting-notice">{notice}</p>}

      {(recording || stopping) && runtime !== null && (
        <section className="meeting-section">
          <h3 className="meeting-title">音轨</h3>
          <ul className="meeting-speakers">
            {wantedTracks.map(track => {
              const missing = runtime.missingTracks.includes(track)
              const progress = (runtime.tracks ?? []).find(entry => entry.track === track)
              return (
                <li key={track} className="meeting-speaker">
                  <strong>{TRACK_NAME[track]}</strong>
                  <span className={missing ? 'meeting-error' : 'meeting-count'}>
                    {missing
                      ? '缺失：没有录到这一路（未伪造静音）'
                      : progress !== undefined
                        ? `已收 ${progress.chunks} 块，共 ${mmss(progress.recordedMs)}`
                        : '等待音频…'}
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="meeting-hint">两路各自成轨、各带时间轴，不会交错拼在一起。</p>
        </section>
      )}

      {showLive && (
        <section className="meeting-section">
          <h3 className="meeting-title">临时字幕</h3>
          <p className="meeting-hint">
            录音中逐块转写，仅供参考；停录后会按说话人精修并整体替换这些字幕，不会重复出现。
          </p>
          {liveCaptions.length === 0 ? (
            <p className="meeting-hint">还没有临时字幕。</p>
          ) : (
            <ul className="meeting-segments">
              {liveCaptions.map(caption => (
                <li key={`${caption.track}-${caption.trackSeq}-${caption.startMs}`} className="meeting-segment">
                  <span className="meeting-seg-label">
                    {mmss(caption.startMs)}
                    <em className="meeting-uncertain">
                      {TRACK_SHORT[caption.track]}
                      {caption.assistant === true ? '·小潘（AI 助理）' : ''}
                    </em>
                  </span>
                  <span className="meeting-seg-text">{captionText(caption)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!recording && !stopping && (
        <section className="meeting-section">
          <h3 className="meeting-title">开始一场会议</h3>
          <label className="meeting-field">
            <span>会议名称</span>
            <input
              type="text"
              value={name}
              maxLength={80}
              placeholder="例如：周一晨会"
              onChange={event => setName(event.target.value)}
            />
          </label>
          <fieldset className="meeting-field">
            <legend>录音来源</legend>
            <label className="meeting-radio">
              <input
                type="radio"
                name="meeting-sources"
                checked={sources === 'mic'}
                onChange={() => setSources('mic')}
              />
              仅麦克风
            </label>
            <label className="meeting-radio">
              <input
                type="radio"
                name="meeting-sources"
                checked={sources === 'mic+loopback'}
                onChange={() => setSources('mic+loopback')}
              />
              麦克风 + 系统回环声（线上会议对方的声音，分两条音轨录）
            </label>
          </fieldset>
          <label className="meeting-field">
            <span>保留天数（到期自动删除录音分块）</span>
            <input
              type="number"
              min={1}
              max={3650}
              value={retentionDays}
              onChange={event => setRetentionDays(Number.parseInt(event.target.value, 10) || 0)}
            />
          </label>
          <label className="meeting-consent">
            <input
              type="checkbox"
              checked={consented}
              onChange={event => setConsented(event.target.checked)}
            />
            <span>{MEETING_CONSENT_TEXT}</span>
          </label>
          {formError !== null && <p className="meeting-error">{formError}</p>}
          <button
            type="button"
            className="meeting-btn primary"
            disabled={!consented || name.trim() === ''}
            onClick={() => void start()}
          >
            开始录音
          </button>
          <p className="meeting-hint">开始后唤醒词监听会停止：参会者的谈话不会被当成指令。</p>
          <p className="meeting-hint">停录后在本机自动分人（音频不上传），说话人编号只在本场会议内有效，不建声纹库。</p>
        </section>
      )}

      {/* 最近会议：点开哪场就看哪场的转写与纪要。 */}
      {runtime !== null && runtime.recent.length > 0 && !recording && (
        <section className="meeting-section">
          <h3 className="meeting-title">最近的会议</h3>
          <ul className="meeting-recent">
            {runtime.recent.map(item => (
              <li key={item.id}>
                <button
                  type="button"
                  className={'meeting-recent-btn' + (item.id === selectedId ? ' active' : '')}
                  onClick={() => setSelected(item.id)}
                >
                  {item.name}
                  <span className="meeting-recent-state">{item.state}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {selectedId !== null && !recording && (
        <section className="meeting-section">
          <h3 className="meeting-title">
            转写与说话人
            <span className="meeting-revision">revision {revision}</span>
          </h3>
          {transcribeLabel !== '' && (
            <p className="meeting-transcribe-state">
              {transcribeLabel}
              {runtimeNote !== null ? `：${runtimeNote}` : ''}
              {runtime?.transcribe === 'transcript-failed' && (
                <button type="button" className="meeting-btn" onClick={() => void retranscribe()}>
                  重试转写
                </button>
              )}
            </p>
          )}
          {storedNote !== null && <p className="meeting-hint">{storedNote}</p>}
          {selectedIntegrity === null ? (
            <p className="meeting-hint">历史会议未保存停止回执，录音完整性无法核验。</p>
          ) : selectedIntegrity.status !== 'complete' ? (
            <p className="meeting-error">录音不完整或停止结果未知：{selectedIntegrity.reasons.join('；') || '尚未取得停止回执'}</p>
          ) : null}
          {isLatest && runtime?.missingTracks.length ? (
            <p className="meeting-error">
              音轨缺失：{runtime.missingTracks.map(track => TRACK_NAME[track]).join('、')}（缺失期间没有录到内容，未做伪造）
              {/* 原因逐条列出：麦克风缺授权与系统音频缺授权要去两个不同的设置页。 */}
              {runtime.missingTracks
                .map(track => runtime.missingTrackReasons?.[track])
                .filter((reason): reason is string => typeof reason === 'string' && reason !== '')
                .map(reason => <span key={reason} className="meeting-hint">{reason}</span>)}
            </p>
          ) : null}
          {failedCount > 0 && (
            <p className="meeting-transcribe-state">
              有 {failedCount} 个片段转写失败（录音已保留，缺口如实保留）
              <button type="button" className="meeting-btn" disabled={transcribing} onClick={() => void retryFailed()}>
                重试失败片段
              </button>
            </p>
          )}

          {segments.length === 0 ? (
            <p className="meeting-hint">{transcribing && isLatest ? '精修完成后在这里显示转写段。' : '还没有转写段。'}</p>
          ) : (
            <>
              <ul className="meeting-speakers">
                {speakers.map(entry => (
                  <li key={entry.speaker} className="meeting-speaker">
                    <strong>{entry.label}</strong>
                    <span className="meeting-count">{entry.count} 段</span>
                    <button
                      type="button"
                      className="meeting-btn"
                      onClick={() => setRenameFor({ speaker: entry.speaker, label: entry.label })}
                    >
                      改名
                    </button>
                    {renameFor?.speaker === entry.speaker && (
                      <span className="meeting-rename">
                        <input
                          type="text"
                          value={renameFor.label}
                          onChange={event => setRenameFor({ speaker: entry.speaker, label: event.target.value })}
                        />
                        <button
                          type="button"
                          className="meeting-btn"
                          onClick={() => {
                            const target = renameFor
                            setRenameFor(null)
                            if (target !== null) {
                              void runEdit(
                                () => api.meetingSpeakerRename(selectedId, target.speaker, target.label),
                                '已改名',
                              )
                            }
                          }}
                        >
                          保存
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              <ul className="meeting-segments">
                {segments.map(segment => (
                  <li
                    key={segment.idx}
                    id={`meeting-seg-${segment.idx}`}
                    className={'meeting-segment' + (focusSeg === segment.idx ? ' focused' : '')}
                  >
                    <label className="meeting-pick">
                      <input
                        type="checkbox"
                        checked={picked.has(segment.idx)}
                        onChange={(event) => {
                          const next = new Set(picked)
                          if (event.target.checked) next.add(segment.idx)
                          else next.delete(segment.idx)
                          setPicked(next)
                        }}
                      />
                    </label>
                    <span className="meeting-seg-label">
                      <em className="meeting-uncertain">段{segment.idx + 1}</em>
                      {segment.label}
                      <em className="meeting-uncertain">{mmss(segment.startMs)}–{mmss(segment.endMs)}</em>
                      {segment.uncertain ? <em className="meeting-uncertain">未确认</em> : null}
                      {segment.source === 'assistant' ? <em className="meeting-uncertain">小潘（AI 助理）的发言</em> : null}
                      {segment.source === 'failed' ? <em className="meeting-uncertain">转写失败·可重试</em> : null}
                    </span>
                    <span className="meeting-seg-text">{segment.text}</span>
                  </li>
                ))}
              </ul>

              <div className="meeting-edit-row">
                <span>拆分选中段为：</span>
                <input
                  type="text"
                  placeholder="新说话人名字"
                  value={splitLabel}
                  onChange={event => setSplitLabel(event.target.value)}
                />
                <button
                  type="button"
                  className="meeting-btn"
                  disabled={picked.size === 0 || splitLabel.trim() === ''}
                  onClick={() => void runEdit(
                    () => api.meetingSpeakerSplit(selectedId, [...picked], splitLabel.trim()),
                    '已拆分',
                  )}
                >
                  拆分
                </button>
              </div>
              <div className="meeting-edit-row">
                <span>合并：</span>
                <select value={mergeFrom} onChange={event => setMergeFrom(event.target.value)}>
                  <option value="">从…</option>
                  {speakers.map(entry => (
                    <option key={entry.speaker} value={entry.speaker}>{entry.label}</option>
                  ))}
                </select>
                <select value={mergeInto} onChange={event => setMergeInto(event.target.value)}>
                  <option value="">到…</option>
                  {speakers.map(entry => (
                    <option key={entry.speaker} value={entry.speaker}>{entry.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="meeting-btn"
                  disabled={mergeFrom === '' || mergeInto === '' || mergeFrom === mergeInto}
                  onClick={() => void runEdit(
                    () => api.meetingSpeakerMerge(selectedId, mergeFrom, mergeInto),
                    '已合并',
                  )}
                >
                  合并
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {selectedId !== null && !recording && (
        <MeetingMinutesReview
          api={api}
          meetingId={selectedId}
          result={minutes}
          revision={revision}
          onLocate={locateSegment}
          onChanged={reloadDetail}
          onNotice={setNotice}
        />
      )}

      {onClose !== undefined && (
        <button type="button" className="meeting-btn meeting-close" onClick={onClose}>
          关闭
        </button>
      )}
    </div>
  )
}
