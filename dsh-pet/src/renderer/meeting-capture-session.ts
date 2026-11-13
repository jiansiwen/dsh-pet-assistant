/**
 * 会议采集与桌面命令接收的常驻接线。
 *
 * 这两件事曾经挂在会议设置页组件上：页面不打开就没人接收录音命令、没人开采集，
 * 主进程只好每次开录都自动弹设置页，讲解时页面还挡着屏幕。现在上移到 App 层
 * 常驻安装：录音可以完全无页面地开始，设置页只在需要人审阅/核查时才打开。
 *
 * 采音细节（双轨切块、加密推块、缺口不伪造静音）与原会议页实现一致，见下方注释。
 */
import { pcm16Base64, resampleTo16k } from './dictation.ts'
import { TrackChunker, type TrackChunk } from './meeting-capture.ts'
import { frameWallMs, sharedCapture, type CaptureSubscription } from './audio-capture.ts'
import type { MeetingFlushReport, MeetingStartedPayload, MeetingTrack } from './types.ts'

/** 每块的目标时长（毫秒）。主进程按块做临时字幕，块太长字幕就滞后。 */
const CHUNK_MS = 4000
/** ScriptProcessor 缓冲帧数。两路一样大，回调延迟一致，相对对齐不受影响。 */
const PROCESSOR_FRAMES = 4096
/** 停录时距最后一帧超过此时长，尾部可能丢音，不能按完整录音结算。 */
const TRACK_STALL_MS = 1500

interface CaptureHandle {
  readonly meetingId: string
  stopAndFlush(): Promise<{ ok: boolean; error?: string }>
}

/** 进行中的采集。模块级：安装点卸载重建后仍要能停下它。 */
let activeCapture: CaptureHandle | null = null
/** 采集正在打开设备的会议（getUserMedia 要几百毫秒）。 */
let startingFor: string | null = null
/** 开轨过程中停止时立即撤销已取得的设备，不等待另一条音轨打开。 */
let startingController: AbortController | null = null
/** 设备还没打开完就收到了停止：打开后立刻停。 */
let stopRequestedFor: string | null = null
/** 桌面命令按 requestId 去重：推送与挂载时取待执行两条路只执行一次。 */
const handledCommands = new Set<string>()

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
        console.error('[meeting] mic 音轨中途结束:', receipt.reason)
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

/**
 * 常驻安装：接收桌面录音命令 + 会议开始/停止的采集生命周期。
 * note 把异常如实报给用户（气泡/toast），不再依赖设置页是否打开。
 * preload 的 subscribe 按通道清旧监听，App 只安装一次，不会堆积。
 */
export function installMeetingSession(api: Window['petApi'], note: (message: string) => void): void {
  const showFlush = (result: { ok: boolean; error?: string }): void => {
    if (!result.ok) note(result.error ?? '录音停止结果未能确认')
  }
  const finish = (handle: CaptureHandle): void => {
    void handle.stopAndFlush().then(showFlush).catch(() => note('录音冲刷异常，停止结果未知'))
  }
  const noCapture = (meetingId: string): void => {
    note('录音停止结果未知：渲染层没有可停止和核验的采集句柄')
    void api.meetingFlushDone(meetingId, { tracks: {}, errors: ['渲染层没有可停止和核验的采集句柄'] })
      .then(showFlush).catch(() => note('录音冲刷回执异常，停止结果未知'))
  }

  // 子助理通过桌面命令发起：用户已在桌面明确要求，直接用这次指令作为知情记录开录。
  const startFromCommand = (command: { requestId: string; consent: Parameters<Window['petApi']['meetingStart']>[0] }): void => {
    if (handledCommands.has(command.requestId)) return
    handledCommands.add(command.requestId)
    void api.meetingStart(command.consent, command.requestId)
      .then(result => { if (!result.ok) note(result.error ?? '无法开始会议') })
      .catch(() => note('主进程没有响应'))
  }
  void api.meetingTakeCommand().then(command => { if (command) startFromCommand(command) }).catch(() => undefined)
  api.onMeetingCommand(startFromCommand)

  api.onMeetingStarted((payload) => {
    startingFor = payload.meetingId
    stopRequestedFor = null
    const controller = new AbortController()
    startingController = controller
    void startMeetingCapture(payload, api, controller.signal, reason => note(`录音不完整：${reason}`)).then((handle) => {
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
      note('会议采集启动失败，录音完整性未知')
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
}