/**
 * 会议页：开始表单（名称/来源/知情勾选/保留天数）、录音中的红色常显标识与立即停止、
 * 转写状态、说话人修订列表、纪要预览与确认按钮。
 *
 * 采音在这一层做（getUserMedia）：主进程拿不到 Web 音频设备，PCM 约每 4 秒一块经
 * petApi.meetingChunk 推上去，主进程收到立即 AES-256-GCM 加密落盘——明文不过夜。
 * loopback（系统回环声）用 chromeMediaSource desktop audio 尝试；拿不到就如实上报
 * track 缺失（meetingTrackMissing），**不伪造静音块**：纪要里会写"这段时间没录到"。
 *
 * 停止是两段式：主进程发 meeting-stopping → 这里停轨、把缓冲里最后一块推完 →
 * meetingFlushDone 触发结算。直接停会丢会议最后几秒。
 *
 * 说话人默认全部「发言人1」且 uncertain：ASR 不猜谁在说话，分组只来自用户在这个
 * 页面上的改名/合并/拆分。纪要确认按钮是唯一能把纪要置成 confirmed 的入口。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { pcm16Base64, resampleTo16k } from './dictation.js'
import type {
  MeetingRuntimeState,
  MeetingStartedPayload,
  MinutesRecord,
  TranscriptSegment,
} from './types.js'

/** 开始会议前用户必须勾选知情的文本。主进程会把它整份存进 consent 记录。 */
export const MEETING_CONSENT_TEXT =
  '我知晓本场会议将被录音：音频加密保存在本机、按保留期自动删除，转写与纪要保留；我会告知其他参会者本次录音。'

/** 每块的目标时长（毫秒）。主进程按 ts 间隔做断流检测，块太长会把 gap 判钝。 */
const CHUNK_MS = 4000

interface CaptureHandle {
  stopAndFlush(): Promise<void>
}

/**
 * 开始采音。mic 必采；sources 含 loopback 时再试 chromeMediaSource desktop audio，
 * 失败只标缺失不中断会议。mic 本身拿不到时也如实上报——会议照常"录"，
 * 但状态里能看到缺了什么，纪要不会假装录到了内容。
 */
async function startMeetingCapture(
  payload: MeetingStartedPayload,
  api: Window['petApi'],
): Promise<CaptureHandle | null> {
  const { meetingId, sources } = payload
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    void api.meetingTrackMissing(meetingId, 'mic')
    return null
  }

  let context: AudioContext
  try {
    context = new AudioContext()
  } catch {
    void api.meetingTrackMissing(meetingId, 'mic')
    return null
  }

  const pending: Float32Array[] = []
  let pendingFrames = 0
  const chunkFrames = Math.floor((context.sampleRate * CHUNK_MS) / 1000)
  /** 推块串行化：meetingChunk 是异步的，乱序会让主进程的 ts/gap 记录失真。 */
  let chain: Promise<void> = Promise.resolve()
  let stopped = false
  const tracks: MediaStreamTrack[] = []

  const flush = (): void => {
    if (pendingFrames === 0) return
    const merged = new Float32Array(pendingFrames)
    let offset = 0
    for (const part of pending) {
      merged.set(part, offset)
      offset += part.length
    }
    pending.length = 0
    pendingFrames = 0
    const b64 = pcm16Base64(resampleTo16k(merged, context.sampleRate))
    chain = chain.then(() => api.meetingChunk(meetingId, b64).then(undefined, () => undefined))
  }

  // ScriptProcessor 要接到 destination 才跑；直连会外放会议声音，挂一个静音节点。
  const mute = context.createScriptProcessor(256, 1, 1)
  mute.onaudioprocess = () => undefined
  mute.connect(context.destination)

  const attach = (stream: MediaStream): void => {
    for (const track of stream.getTracks()) tracks.push(track)
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (event) => {
      if (stopped) return
      const chunk = event.inputBuffer.getChannelData(0)
      pending.push(new Float32Array(chunk))
      pendingFrames += chunk.length
      if (pendingFrames >= chunkFrames) flush()
    }
    source.connect(processor)
    processor.connect(mute)
  }

  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    attach(mic)
  } catch (error) {
    console.error('[meeting] mic capture failed:', error)
    void api.meetingTrackMissing(meetingId, 'mic')
  }

  if (sources === 'mic+loopback') {
    // chromeMediaSource desktop audio：Electron 里拿系统回环声的那条路。约束形状不是
    // 标准 MediaTrackConstraints，只能 cast；失败（无源、被策略挡）就标缺失。
    const desktopConstraints = {
      audio: { mandatory: { chromeMediaSource: 'desktop' } },
      video: false,
    } as unknown as MediaStreamConstraints
    try {
      const loop = await navigator.mediaDevices.getUserMedia(desktopConstraints)
      if (loop.getAudioTracks().length === 0) {
        loop.getTracks().forEach(track => track.stop())
        void api.meetingTrackMissing(meetingId, 'loopback')
      } else {
        attach(loop)
      }
    } catch (error) {
      console.error('[meeting] loopback capture failed:', error)
      void api.meetingTrackMissing(meetingId, 'loopback')
    }
  }

  return {
    async stopAndFlush(): Promise<void> {
      stopped = true
      flush()
      for (const track of tracks) {
        try { track.stop() } catch { /* 已停 */ }
      }
      await chain.catch(() => undefined)
      await api.meetingFlushDone(meetingId).catch(() => undefined)
      await context.close().catch(() => undefined)
    },
  }
}

export interface MeetingPanelProps {
  /** 主代理接线到面板显示逻辑的关闭回调；不传就不显示关闭按钮。 */
  readonly onClose?: () => void
}

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
  const [revision, setRevision] = useState(0)
  const [minutes, setMinutes] = useState<MinutesRecord | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [splitLabel, setSplitLabel] = useState('')
  const [mergeFrom, setMergeFrom] = useState('')
  const [mergeInto, setMergeInto] = useState('')
  const [renameFor, setRenameFor] = useState<{ speaker: string; label: string } | null>(null)
  const [elapsed, setElapsed] = useState('')
  const captureRef = useRef<CaptureHandle | null>(null)

  const selectedId = selected ?? runtime?.lastMeetingId ?? null
  const recording = runtime?.recording === true
  const stopping = runtime?.stopping === true

  const loadDetail = useCallback(async (meetingId: string | null) => {
    if (api === undefined || meetingId === null) {
      setSegments([])
      setMinutes(null)
      return
    }
    const [speakers, minutesResult] = await Promise.all([
      api.meetingSpeakers(meetingId).catch(() => null),
      api.meetingMinutes(meetingId).catch(() => null),
    ])
    if (speakers !== null && speakers.ok) {
      setSegments(speakers.segments ?? [])
      setRevision(speakers.revision ?? 0)
    }
    setMinutes(minutesResult !== null && minutesResult.ok ? minutesResult.minutes ?? null : null)
  }, [api])

  // 状态投影与采音生命周期。preload 的 subscribe 会先清旧监听，重复挂载不会堆积。
  useEffect(() => {
    if (api === undefined) return
    void api.meetingState().then(setRuntime).catch(() => undefined)
    api.onMeetingState((state) => setRuntime(state))
    api.onMeetingStarted((payload) => {
      void startMeetingCapture(payload, api).then((handle) => {
        captureRef.current = handle
      })
    })
    api.onMeetingStopping(() => {
      const handle = captureRef.current
      captureRef.current = null
      if (handle !== null) void handle.stopAndFlush()
    })
  }, [api])

  // 换了一场要看的会议就重新拉段与纪要。
  useEffect(() => {
    void loadDetail(selectedId)
    setPicked(new Set())
  }, [loadDetail, selectedId, revision])

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

  const confirmMinutes = useCallback(async () => {
    if (api === undefined || selectedId === null) return
    const result = await api.meetingMinutesConfirm(selectedId).catch(() => ({ ok: false, error: '主进程没有响应' }))
    if (!result.ok) {
      setNotice(result.error ?? '确认失败')
      return
    }
    setNotice('纪要已确认')
    await loadDetail(selectedId)
  }, [api, loadDetail, selectedId])

  if (api === undefined) return null

  const speakers = segments.reduce<Array<{ speaker: string; label: string; count: number }>>((acc, segment) => {
    const found = acc.find(entry => entry.speaker === segment.speaker)
    if (found !== undefined) found.count++
    else acc.push({ speaker: segment.speaker, label: segment.label, count: 1 })
    return acc
  }, [])
  const transcribeLabel =
    runtime === null ? '' :
    runtime.transcribe === 'transcribing' ? '转写中…' :
    runtime.transcribe === 'transcribed' ? '转写完成' :
    runtime.transcribe === 'transcript-failed' ? '转写失败（录音已保留）' : ''

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
              麦克风 + 系统回环声（线上会议对方的声音）
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
              {runtime?.transcribeNote != null && runtime.transcribeNote !== '' ? `：${runtime.transcribeNote}` : ''}
              {runtime?.transcribe === 'transcript-failed' && (
                <button type="button" className="meeting-btn" onClick={() => void retranscribe()}>
                  重试转写
                </button>
              )}
            </p>
          )}
          {runtime?.missingTracks.length ? (
            <p className="meeting-error">音轨缺失：{runtime.missingTracks.join('、')}（缺失期间没有录到内容，未做伪造）</p>
          ) : null}

          {segments.length === 0 ? (
            <p className="meeting-hint">还没有转写段。</p>
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
                  <li key={segment.idx} className="meeting-segment">
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
                      {segment.label}
                      {segment.uncertain ? <em className="meeting-uncertain">未确认</em> : null}
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
        <section className="meeting-section">
          <h3 className="meeting-title">会议纪要</h3>
          {minutes === null ? (
            <p className="meeting-hint">纪要还没有生成（转写完成后自动生成草稿）。</p>
          ) : (
            <>
              <pre className="meeting-minutes">{minutes.content}</pre>
              <p className="meeting-minutes-meta">
                {minutes.state === 'confirmed'
                  ? `已确认（${new Date(minutes.confirmedAt ?? Date.now()).toLocaleString()}），digest ${minutes.digest.slice(0, 12)}…`
                  : `草稿 · revision ${minutes.revision} · digest ${minutes.digest.slice(0, 12)}…`}
              </p>
              {minutes.state !== 'confirmed' && (
                <button type="button" className="meeting-btn primary" onClick={() => void confirmMinutes()}>
                  我核对过了，确认这份纪要
                </button>
              )}
              {minutes.state === 'confirmed' && minutes.revision < revision && (
                <p className="meeting-error">转写在确认后又被修订，纪要已退回草稿，请重新生成并确认。</p>
              )}
            </>
          )}
        </section>
      )}

      {onClose !== undefined && (
        <button type="button" className="meeting-btn meeting-close" onClick={onClose}>
          关闭
        </button>
      )}
    </div>
  )
}
