/**
 * 会议页：开始表单（名称/来源/知情勾选/保留天数）、录音中的红色常显标识与立即停止、
 * 各音轨收音状态与临时字幕、转写状态、说话人修订列表、纪要预览与确认按钮。
 *
 * 采音与桌面命令接收不在这一层：它们在 meeting-capture-session.ts 由 App 常驻安装，
 * 设置页不打开也能开始录音。采集细节（双轨切块、加密推块、缺口不伪造静音、两段式停止）
 * 见该模块注释。本页只投影状态与提供人工操作。
 *
 * 说话人：停录后主进程用本地模型自动分人（同一音轨内分组，标签如「本机麦克风·发言人1」
 * 「对方·发言人2」），全部标"未确认"；模型缺失或失败时整条音轨归一组并写明"未自动分人"。
 * 最终分组只来自用户在这个页面上的改名/合并/拆分。纪要确认按钮是唯一能把纪要置成 confirmed 的入口。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import MeetingMinutesReview from './meeting-minutes-review.js'
import type {
  LiveCaption,
  MeetingIntegrity,
  MeetingMinutesResult,
  MeetingRuntimeState,
  MeetingSpeakersResult,
  MeetingTrack,
  TranscriptSegment,
} from './types.js'

/** 开始会议前用户必须勾选知情的文本。主进程会把它整份存进 consent 记录。 */
export const MEETING_CONSENT_TEXT =
  '我知晓本场会议将被录音：音频加密保存在本机、按保留期自动删除，转写与纪要保留；我会告知其他参会者本次录音。'

const TRACK_NAME: Record<MeetingTrack, string> = { mic: '本机麦克风', loopback: '对方（系统回环声）' }
const TRACK_SHORT: Record<MeetingTrack, string> = { mic: '本机麦克风', loopback: '对方' }

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
  const [speakerCounts, setSpeakerCounts] = useState<{ mic: number; loopback: number }>({ mic: 0, loopback: 0 })
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
  /** 正在请求删除的会议 id：防止重复点击，也用来禁用按钮。 */
  const [deleting, setDeleting] = useState<string | null>(null)

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

  // 状态投影。采音生命周期与桌面命令接收在 App 层常驻安装（meeting-capture-session），
  // 设置页不打开也能开录；这里只负责把状态画出来。
  useEffect(() => {
    if (api === undefined) return
    void api.meetingState().then(setRuntime).catch(() => undefined)
    // 人数是按音轨存的全局设置：会议页重新打开时把上次的选择带回来。
    // 面板在部分隔离测试里用最小 api 替身，没有 getState 时跳过即可。
    if (typeof api.getState === 'function') {
      void api.getState().then(state => {
        const counts = state.meetingSpeakerCounts
        if (counts) setSpeakerCounts({ mic: counts.mic, loopback: counts.loopback })
      }).catch(() => undefined)
    }
    api.onMeetingState((state) => setRuntime(state))
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

  const updateSpeakerCount = useCallback((track: 'mic' | 'loopback', value: number) => {
    setSpeakerCounts(previous => {
      const next = { ...previous, [track]: value }
      void api?.saveSettings({ meetingSpeakerCounts: next }).then(result => {
        if (!result.ok) setFormError('分人人数未保存')
      }).catch(() => setFormError('分人人数未保存'))
      return next
    })
  }, [api])

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

  const retryFailed = useCallback(async () => {
    if (api === undefined || selectedId === null) return
    const result = await api.meetingRetryFailed(selectedId).catch(() => ({ ok: false, error: '主进程没有响应' }))
    setNotice(result.ok ? '正在重试失败的片段（其余段与你的修订不动）' : result.error ?? '无法重试')
  }, [api, selectedId])

  /** 删除整场会议；主进程会先弹原生确认，取消时不报错。 */
  const removeMeeting = useCallback(async (meetingId: string) => {
    if (api === undefined || deleting !== null) return
    setDeleting(meetingId)
    try {
      const result = await api.meetingDelete(meetingId).catch(() => ({ ok: false, error: '主进程没有响应' }))
      if (result.ok) {
        setNotice('会议已删除（录音、转写与纪要一并清除）')
        if (selectedId === meetingId) setSelected(null)
        const next = await api.meetingState().catch(() => null)
        if (next !== null) setRuntime(next)
      } else if (result.error !== '已取消删除') {
        setNotice(result.error ?? '删除失败')
      }
    } finally {
      setDeleting(null)
    }
  }, [api, deleting, selectedId])

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
    <div className="meeting-page" id="panel-page-meeting" role="region" aria-labelledby="panel-tab-meeting">
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

      {notice !== null && <p className="meeting-notice" role="status">{notice}</p>}

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
          <fieldset className="meeting-field">
            <legend>每条音轨的发言人数（停录后分人用）</legend>
            <label className="meeting-radio">
              本机麦克风
              <select
                value={speakerCounts.mic}
                onChange={event => updateSpeakerCount('mic', Number.parseInt(event.target.value, 10))}
              >
                <option value={0}>自动</option>
                {[1, 2, 3, 4, 5, 6].map(count => <option key={count} value={count}>{count} 人</option>)}
              </select>
            </label>
            <label className="meeting-radio">
              对方（系统回环）
              <select
                value={speakerCounts.loopback}
                disabled={sources === 'mic'}
                onChange={event => updateSpeakerCount('loopback', Number.parseInt(event.target.value, 10))}
              >
                <option value={0}>自动</option>
                {[1, 2, 3, 4, 5, 6].map(count => <option key={count} value={count}>{count} 人</option>)}
              </select>
            </label>
            <p className="meeting-hint">
              线上会议通常本机 1 人、对方多人；线下会议按麦克风实际人数选。填错会把同一个人拆开或把两个人并成一组。
            </p>
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
              <li key={item.id} className="meeting-recent-item">
                <button
                  type="button"
                  className={'meeting-recent-btn' + (item.id === selectedId ? ' active' : '')}
                  onClick={() => setSelected(item.id)}
                >
                  {item.name}
                  <span className="meeting-recent-state">{item.state}</span>
                </button>
                <button
                  type="button"
                  className="meeting-recent-delete"
                  aria-label={`删除会议 ${item.name}`}
                  title="删除这场会议的录音、转写与纪要"
                  disabled={deleting !== null}
                  onClick={() => void removeMeeting(item.id)}
                >
                  {deleting === item.id ? '删除中…' : '删除'}
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
                          aria-label={`${entry.label}的新名字`}
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
                        aria-label={`选择第 ${segment.idx + 1} 段转写`}
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
                  aria-label="拆分后的说话人名字"
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
                <select aria-label="要合并的说话人" value={mergeFrom} onChange={event => setMergeFrom(event.target.value)}>
                  <option value="">从…</option>
                  {speakers.map(entry => (
                    <option key={entry.speaker} value={entry.speaker}>{entry.label}</option>
                  ))}
                </select>
                <select aria-label="合并到的说话人" value={mergeInto} onChange={event => setMergeInto(event.target.value)}>
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
