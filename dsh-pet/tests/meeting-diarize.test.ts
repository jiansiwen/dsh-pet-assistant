/**
 * M4-05 自动分人、M4-04 临时字幕与会后精修、助理播报排除的测试。
 *
 * 分离与转写都用替身（按合成 PCM 的样本值认人/出字），验证的是编排：段怎么映射成带音源
 * 前缀的说话人、标签怎么写、模型缺失/失败怎么如实回退、助理播报区间怎么落到段上、失败片段
 * 怎么保留缺口并局部重试、精修结果怎么按版本替换而不覆盖人工修订、不建跨会议声纹库。
 * 真实模型的效果另见 petsBak 里的实测脚本（不计入单测）。
 * 跑法：`npm test`。
 */
import assert from 'node:assert/strict'
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'

import {
  ASSISTANT_LABEL,
  ASSISTANT_SPEAKER,
  applyAssistantSpeech,
  compressSilence,
  diarizationModelPaths,
  diarizationModelStatus,
  diarizeTimelineSamples,
  fallbackSpans,
  mapCompressedToOriginal,
  spansFromTurns,
  splitLongSpans,
  uncoveredVoicedSpans,
  type DiarizeFn,
  type PlannedSpan,
} from '../src/main/diarize.ts'
import { FAILED_SEGMENT_TEXT, markAssistantSpeech, registerMeetingIpc } from '../src/main/meeting-recorder.ts'
import type { TranscriptSegment } from '../src/main/meeting-store.ts'
import {
  CONSENT_BOTH,
  CONSENT_MIC,
  DEFAULT_SPEAKERS,
  DEFAULT_WORDS,
  START,
  constPcm,
  diarizeByValue,
  meta,
  pattern,
  pushWholeTrack,
  setupRecorder,
  tempDir,
  transcribeByValue,
  type Harness,
} from './meeting-fixtures.ts'

/**
 * 合成会议：麦克风里两个人（甲=3000、乙=6000），回环里一个人（丙=9000）。
 * 丙第一段（2000–2600）与甲（500–3500）在时间上重叠——两路各自成轨，跨轨重叠两边都保留。
 */
const MIC = pattern([[500, 0], [3000, 3000], [700, 0], [2800, 6000], [600, 0], [2400, 3000], [2000, 0]])
const LOOP = pattern([[2000, 0], [600, 9000], [7900, 0], [1000, 9000], [500, 0]])

type Brief = Pick<TranscriptSegment, 'startMs' | 'endMs' | 'speaker' | 'label' | 'text' | 'source' | 'track'>

function brief(segments: readonly TranscriptSegment[]): Brief[] {
  return segments.map(({ startMs, endMs, speaker, label, text, source, track }) => ({ startMs, endMs, speaker, label, text, source, ...(track !== undefined ? { track } : {}) }))
}

async function recordAndRefine(h: Harness, opts: { loop?: boolean; beforeStop?: (meetingId: string) => void } = {}): Promise<string> {
  const loop = opts.loop ?? true
  const started = h.recorder.startMeeting(loop ? CONSENT_BOTH : CONSENT_MIC)
  if (!started.ok) throw new Error(started.error)
  pushWholeTrack(h, started.meetingId, 'mic', MIC)
  if (loop) pushWholeTrack(h, started.meetingId, 'loopback', LOOP)
  opts.beforeStop?.(started.meetingId)
  h.recorder.requestStop(started.meetingId)
  await h.recorder.flushDone(started.meetingId)
  await h.recorder.whenSettled()
  return started.meetingId
}

const DIARIZED: Brief[] = [
  { startMs: 500, endMs: 3500, speaker: 'mic-s1', label: '本机麦克风·发言人1', text: '甲说话', source: 'asr', track: 'mic' },
  { startMs: 2000, endMs: 2600, speaker: 'loop-s1', label: '对方·发言人1', text: '对方丙说话', source: 'asr', track: 'loopback' },
  { startMs: 4200, endMs: 7000, speaker: 'mic-s2', label: '本机麦克风·发言人2', text: '乙说话', source: 'asr', track: 'mic' },
  { startMs: 7600, endMs: 10000, speaker: 'mic-s1', label: '本机麦克风·发言人1', text: '甲说话', source: 'asr', track: 'mic' },
  { startMs: 10500, endMs: 11500, speaker: 'loop-s1', label: '对方·发言人1', text: '对方丙说话', source: 'asr', track: 'loopback' },
]

describe('分离结果 → 说话人段（纯函数）', () => {
  test('按首次出现重新编号、加音源前缀与默认标签；裁掉断流；同轨重叠只转写一次；同人短间隔合并；碎片丢弃', () => {
    const timeline = { samples: new Int16Array(20000 * 16), gaps: [{ startMs: 5000, endMs: 6000, reason: 'gap' as const }] }
    const { spans, speakers, overlapsResolved } = spansFromTurns('mic', [
      { startMs: 1000, endMs: 4000, speaker: 9 },
      { startMs: 2000, endMs: 3000, speaker: 3 },
      { startMs: 3500, endMs: 7000, speaker: 3 },
      { startMs: 7500, endMs: 9000, speaker: 3 },
      { startMs: 9100, endMs: 9300, speaker: 9 },
      { startMs: 12000, endMs: 30000, speaker: 9 },
    ], timeline)
    assert.deepEqual(spans.map(span => [span.speaker, span.label, span.startMs, span.endMs]), [
      ['mic-s1', '本机麦克风·发言人1', 1000, 4000],
      ['mic-s2', '本机麦克风·发言人2', 4000, 5000],
      ['mic-s2', '本机麦克风·发言人2', 6000, 9000],
      ['mic-s1', '本机麦克风·发言人1', 12000, 20000],
    ])
    assert.equal(speakers, 2)
    assert.equal(overlapsResolved, 2, '被包含的一段与部分重叠的一段')
    assert.ok(spans.every(span => span.kind === 'speech' && span.track === 'mic' && span.chunkSeq === undefined))

    const loop = spansFromTurns('loopback', [{ startMs: 0, endMs: 1000, speaker: 4 }], { samples: new Int16Array(16000), gaps: [] })
    assert.deepEqual(loop.spans.map(span => [span.speaker, span.label]), [['loop-s1', '对方·发言人1']])
  })

  test('逐块兜底：一块一段、整条音轨标"未分人"，带块号以便复用临时字幕', () => {
    const spans = fallbackSpans('loopback', { placements: [{ seq: 3, startMs: 0, endMs: 4000 }, { seq: 5, startMs: 4000, endMs: 6000 }] })
    assert.deepEqual(spans.map(span => [span.speaker, span.label, span.startMs, span.endMs, span.chunkSeq]), [
      ['loop-s1', '对方·未分人', 0, 4000, 3],
      ['loop-s1', '对方·未分人', 4000, 6000, 5],
    ])
  })

  test('分人模型漏掉的有声片段补成"未分人"段（够长、够响才补），漏检不吞内容', () => {
    const samples = new Int16Array(10000 * 16)
    samples.fill(3000, 0, 3000 * 16)
    samples.fill(6000, 4000 * 16, 7000 * 16)
    samples.fill(6000, 8500 * 16, 9300 * 16)
    const covered: PlannedSpan[] = [{ track: 'mic', speaker: 'mic-s1', label: 'x', startMs: 0, endMs: 3000, kind: 'speech' }]
    assert.deepEqual(uncoveredVoicedSpans('mic', { samples }, covered), [
      { track: 'mic', speaker: 'mic-unk', label: '本机麦克风·未分人', startMs: 4000, endMs: 7000, kind: 'speech' },
    ], '0.8 秒的零碎声音不补，3 秒的漏检补上')
  })

  test('助理播报：高度重叠整段标助理播报；部分重叠裁掉重叠处；不沾边的不动', () => {
    const spans: PlannedSpan[] = [
      { track: 'mic', speaker: 'mic-s1', label: 'x', startMs: 0, endMs: 2000, kind: 'speech', chunkSeq: 0 },
      { track: 'mic', speaker: 'mic-s1', label: 'x', startMs: 3000, endMs: 6000, kind: 'speech', chunkSeq: 1 },
      { track: 'loopback', speaker: 'loop-s1', label: 'y', startMs: 7000, endMs: 8000, kind: 'speech' },
    ]
    const result = applyAssistantSpeech(spans, [{ startMs: 500, endMs: 1700 }, { startMs: 5000, endMs: 5500 }])
    assert.deepEqual(result.spans, [
      { track: 'mic', speaker: ASSISTANT_SPEAKER, label: ASSISTANT_LABEL, startMs: 0, endMs: 2000, kind: 'assistant', chunkSeq: 0 },
      { track: 'mic', speaker: 'mic-s1', label: 'x', startMs: 3000, endMs: 4800, kind: 'speech' },
      spans[2],
    ])
    assert.equal(result.marked, 1)
    assert.equal(result.trimmed, 1)
  })

  test('长段在目标位置前的低能量处切开，每段不超过上限', () => {
    const samples = new Int16Array(45000 * 16).fill(5000)
    samples.fill(0, 18600 * 16, 18800 * 16)
    samples.fill(0, 37200 * 16, 37400 * 16)
    const spans = splitLongSpans([{ track: 'mic', speaker: 'mic-s1', label: 'x', startMs: 0, endMs: 45000, kind: 'speech', chunkSeq: 3 }], () => ({ samples }))
    assert.equal(spans.length, 3)
    assert.ok(spans.every(span => span.endMs - span.startMs <= 20000 && span.chunkSeq === undefined))
    assert.ok(spans[0].endMs >= 18600 && spans[0].endMs <= 18800, `第一刀应在静音处：${spans[0].endMs}`)
    assert.ok(spans[1].endMs >= 37200 && spans[1].endMs <= 37400, `第二刀应在静音处：${spans[1].endMs}`)
    assert.equal(spans[0].endMs, spans[1].startMs)
    assert.equal(spans[2].endMs, 45000)
  })

  test('送模型前压掉长静音，结果映射回原时间轴；跨拼接点的段在拼接处拆开', () => {
    const samples = new Int16Array(9000 * 16)
    samples.fill(3000, 0, 2000 * 16)
    samples.fill(6000, 7000 * 16, 9000 * 16)
    const compressed = compressSilence(samples)
    assert.equal(compressed.keptMs, 4900, '4.4 秒静音只留首尾各 150ms')
    assert.deepEqual(compressed.pieces, [
      { srcStart: 0, dstStart: 0, length: 2450 * 16 },
      { srcStart: 6550 * 16, dstStart: 2450 * 16, length: 2450 * 16 },
    ])
    assert.ok(Math.abs(compressed.samples[100] - 3000 / 32768) < 1e-9)
    const turns = mapCompressedToOriginal([
      { start: 0, end: 2.0, speaker: 1 },
      { start: 2.9, end: 4.9, speaker: 2 },
      { start: 2.0, end: 3.0, speaker: 3 },
    ], compressed.pieces)
    assert.deepEqual(turns.map(turn => [Math.round(turn.startMs), Math.round(turn.endMs), turn.speaker]), [
      [0, 2000, 1],
      [2000, 2450, 3],
      [6550, 7100, 3],
      [7000, 9000, 2],
    ])
  })

  test('模型缺失或不完整：如实报原因，不加载原生模块', async () => {
    const dir = tempDir()
    assert.deepEqual(diarizationModelStatus(dir), { ok: false, message: '分人模型未安装' })
    const result = await diarizeTimelineSamples(new Int16Array(16000 * 5).fill(3000), dir)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'model-missing')
    const paths = diarizationModelPaths(dir)
    mkdirSync(path.dirname(paths.segmentation), { recursive: true })
    writeFileSync(paths.segmentation, Buffer.alloc(10))
    writeFileSync(paths.embedding, Buffer.alloc(10))
    assert.deepEqual(diarizationModelStatus(dir), { ok: false, message: '分人模型文件不完整（可能下载中断）' })
  })
})

describe('会后精修：同一会议内自动分人（分离替身）', () => {
  test('按音轨分人后按段转写：id 带音源前缀、默认标签、全部未确认、按时间排序、跨轨重叠两边都在', async () => {
    const h = setupRecorder()
    const id = await recordAndRefine(h)
    assert.equal(h.store.getMeeting(id)?.state, 'transcribed')
    const segments = h.store.getSegments(id)
    assert.deepEqual(brief(segments), DIARIZED)
    assert.ok(segments.every(segment => segment.uncertain), '机器分的组只是建议：一律未确认')
    assert.equal(h.diarized.length, 2, '两条音轨各分一次，不拼在一起')
    assert.equal(h.diarized[0].length, 12000 * 16)

    const speakers = h.recorder.getSpeakers(id)
    assert.ok(speakers.ok)
    if (!speakers.ok) return
    assert.deepEqual(speakers.speakers, [
      { speaker: 'mic-s1', label: '本机麦克风·发言人1', count: 2 },
      { speaker: 'loop-s1', label: '对方·发言人1', count: 2 },
      { speaker: 'mic-s2', label: '本机麦克风·发言人2', count: 1 },
    ])
    assert.equal(speakers.transcript?.mode, 'diarized')
    assert.ok(speakers.transcript?.note?.includes('已自动分人'))
    assert.ok(speakers.transcript?.note?.includes('本机麦克风 2 人、对方 1 人'))
    assert.ok(speakers.transcript?.note?.includes('只在本场会议内分组'))

    const minutes = h.store.getMinutes(id)
    assert.ok(minutes?.content.includes('[00:00–00:03] 本机麦克风·发言人1（说话人未经确认）：甲说话'))
    assert.ok(minutes?.content.includes('对方·发言人1（说话人未经确认）：对方丙说话'))
    assert.ok(minutes?.content.includes('转写说明：已自动分人'))
    h.store.close()
  })

  test('改名/合并/拆分对自动分出的组照常有效', async () => {
    const h = setupRecorder()
    const id = await recordAndRefine(h)
    assert.equal(h.recorder.renameSpeaker(id, 'mic-s2', '李四').ok, true)
    assert.equal(h.recorder.mergeSpeakers(id, 'loop-s1', 'mic-s1').ok, true)
    const split = h.recorder.splitSegments(id, [0], '王五')
    assert.equal(split.ok, true)
    const segments = h.store.getSegments(id)
    assert.equal(segments[0].speaker, 's3', '拆出来的新编号避开 mic-s2 这类既有编号')
    assert.equal(segments[0].label, '王五')
    assert.equal(segments.find(segment => segment.startMs === 4200)?.label, '李四')
    assert.equal(segments.filter(segment => segment.speaker === 'mic-s1').length, 3, '合并后对方的段并入 mic-s1')
    assert.ok(segments.every(segment => segment.track !== undefined), '合并只改说话人，不改音频来自哪条音轨')
    assert.equal(segments.find(segment => segment.startMs === 2000)?.track, 'loopback')
    h.store.close()
  })

  test('分人模型缺失：退回逐块转写，整条音轨归一组标"未分人"，说明里如实写"未自动分人"', async () => {
    const missing: DiarizeFn = async () => ({ ok: false, reason: 'model-missing', message: '分人模型未安装' })
    const h = setupRecorder({ diarize: missing })
    const id = await recordAndRefine(h)
    assert.deepEqual(brief(h.store.getSegments(id)).map(segment => [segment.startMs, segment.endMs, segment.speaker, segment.label, segment.text]), [
      [0, 4000, 'mic-s1', '本机麦克风·未分人', '甲说话'],
      [0, 4000, 'loop-s1', '对方·未分人', '对方丙说话'],
      [4000, 8000, 'mic-s1', '本机麦克风·未分人', '乙说话甲说话'],
      [8000, 12000, 'mic-s1', '本机麦克风·未分人', '甲说话'],
      [8000, 12000, 'loop-s1', '对方·未分人', '对方丙说话'],
    ])
    const note = h.recorder.getState().transcribeNote ?? ''
    assert.ok(note.includes('未自动分人（分人模型未安装）'), note)
    const speakers = h.recorder.getSpeakers(id)
    assert.ok(speakers.ok && speakers.transcript?.mode === 'undiarized')
    assert.ok(h.store.getMinutes(id)?.content.includes('未自动分人'))
    h.store.close()
  })

  test('分人抛异常 / 只有一条音轨分成功：分别如实回退与标"部分分人"', async () => {
    const throwing: DiarizeFn = async () => {
      throw new Error('原生模块崩了')
    }
    const h1 = setupRecorder({ diarize: throwing })
    const id1 = await recordAndRefine(h1, { loop: false })
    assert.ok(h1.store.getSegments(id1).every(segment => segment.label === '本机麦克风·未分人'))
    assert.ok((h1.recorder.getState().transcribeNote ?? '').includes('未自动分人（分人异常：原生模块崩了）'))
    h1.store.close()

    const byValue = diarizeByValue(DEFAULT_SPEAKERS)
    const loopFails: DiarizeFn = async (samples, dir) =>
      samples.includes(9000) ? { ok: false, reason: 'failed', message: '分人失败：测试注入' } : byValue(samples, dir)
    const h2 = setupRecorder({ diarize: loopFails })
    const id2 = await recordAndRefine(h2)
    const segments = h2.store.getSegments(id2)
    assert.ok(segments.filter(segment => segment.track === 'mic').some(segment => segment.speaker === 'mic-s2'), '麦克风轨照样分出两人')
    assert.ok(segments.filter(segment => segment.track === 'loopback').every(segment => segment.label === '对方·未分人'))
    const speakers = h2.recorder.getSpeakers(id2)
    assert.ok(speakers.ok && speakers.transcript?.mode === 'partial')
    const note = (speakers.ok && speakers.transcript?.note) || ''
    assert.ok(note.includes('本机麦克风已自动分人（2 人）') && note.includes('对方未自动分人（分人失败：测试注入）'), note)
    h2.store.close()
  })

  test('分人模型漏检了一个人：那段话补成"未分人"照样转写出来，说明里写明', async () => {
    const h = setupRecorder({ diarize: diarizeByValue({ 3000: 7, 9000: 4 }) })
    const id = await recordAndRefine(h)
    const recovered = h.store.getSegments(id).find(segment => segment.startMs === 4200)
    assert.deepEqual([recovered?.speaker, recovered?.label, recovered?.text, recovered?.endMs], ['mic-unk', '本机麦克风·未分人', '乙说话', 7000])
    assert.ok((h.recorder.getState().transcribeNote ?? '').includes('1 段有声片段分人模型没覆盖到'))
    h.store.close()
  })

  test('不建跨会议声纹库：第二场会议重新从 1 编号，磁盘与库里没有任何嵌入/声纹数据', async () => {
    const h = setupRecorder()
    const first = await recordAndRefine(h)
    const started = h.recorder.startMeeting({ ...CONSENT_MIC, name: '第二场' })
    if (!started.ok) throw new Error(started.error)
    pushWholeTrack(h, started.meetingId, 'mic', pattern([[500, 0], [3000, 6000], [500, 0]]))
    h.recorder.requestStop(started.meetingId)
    await h.recorder.flushDone(started.meetingId)
    await h.recorder.whenSettled()
    const second = h.store.getSegments(started.meetingId)
    assert.deepEqual(second.map(segment => [segment.speaker, segment.label, segment.text]), [['mic-s1', '本机麦克风·发言人1', '乙说话']],
      '上一场的"发言人2"不会被认出来：编号只在本场会议内有效')
    assert.equal(h.diarized[h.diarized.length - 1].length, 4000 * 16, '分人只拿到本场本轨的音频')

    for (const meetingId of [first, started.meetingId]) {
      const files = readdirSync(h.store.meetingDir(meetingId))
      assert.ok(files.every(file => /^chunk-\d+\.(enc|json)$/.test(file)), `会议目录里只应有加密块与 sidecar：${files.join(',')}`)
    }
    h.store.close()
    const db = new DatabaseSync(path.join(h.dir, 'meetings.sqlite'))
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      assert.equal(columns.some(column => /embedding|voiceprint|声纹/u.test(column.name)), false, `${table} 不应包含跨会议声纹列`)
    }
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM meeting_presentations').get() as { n: number }).n, 0)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM minutes_artifacts').get() as { n: number }).n, 0)
    db.close()
    assert.deepEqual(tables, ['assistant_speech', 'chunks', 'meeting_presentations', 'meetings', 'minutes', 'minutes_artifacts', 'transcript_meta', 'transcript_segments'])
  })
})

describe('助理播报区间落到转写上', () => {
  test('与播报高度重叠的段标为“小潘（AI 助理）”并留在时间线；部分重叠的裁掉重叠处', async () => {
    const h = setupRecorder()
    const id = await recordAndRefine(h, {
      beforeStop: () => {
        markAssistantSpeech(4200, 7000)
        markAssistantSpeech(9000, 9500)
      },
    })
    const segments = h.store.getSegments(id)
    const assistant = segments.filter(segment => segment.source === 'assistant')
    assert.deepEqual(brief(assistant), [
      { startMs: 4200, endMs: 7000, speaker: ASSISTANT_SPEAKER, label: ASSISTANT_LABEL, text: '乙说话', source: 'assistant', track: 'mic' },
    ])
    const trimmed = segments.find(segment => segment.startMs === 7600)
    assert.deepEqual([trimmed?.endMs, trimmed?.speaker, trimmed?.text], [8800, 'mic-s1', '甲说话'], '9000–9500 播报（外扩 200ms）被裁掉，剩下 7600–8800')
    assert.ok(!segments.some(segment => segment.speaker !== ASSISTANT_SPEAKER && segment.text === '乙说话'), '助理的声音不计为真人发言')

    const minutes = h.store.getMinutes(id)?.content ?? ''
    const timeline = minutes.slice(minutes.indexOf('## 时间线'), minutes.indexOf('## 助理播报区间'))
    assert.match(timeline, /小潘（AI 助理）.*乙说话/s, '助理是独立发言人，发言要留在时间线')
    assert.ok(minutes.includes('[00:04–00:07] 桌面助理 TTS 播报'))
    const note = h.recorder.getState().transcribeNote ?? ''
    assert.ok(note.includes('1 段与助理播报高度重叠') && note.includes('1 段裁掉了与助理播报重叠的部分'), note)
    h.store.close()
  })

  test('误判可纠正：把助理播报段拆成真人，标签随之变化；真人段并进助理组则标为小潘发言', async () => {
    const h = setupRecorder()
    const id = await recordAndRefine(h, { beforeStop: () => markAssistantSpeech(4200, 7000) })
    const idx = h.store.getSegments(id).findIndex(segment => segment.source === 'assistant')
    assert.ok(idx >= 0)
    assert.equal(h.recorder.splitSegments(id, [idx], '乙（真人）').ok, true)
    const fixed = h.store.getSegments(id)[idx]
    assert.deepEqual([fixed.source, fixed.label, fixed.uncertain], ['asr', '乙（真人）', false])
    assert.ok(h.store.getMinutes(id)?.content.includes('乙（真人）：乙说话'), '用户认定是真人后进时间线')

    // 反方向：用户认定对方那组其实是助理的声音，把它并进助理组 → 改标为小潘发言，仍留在时间线。
    const h2 = setupRecorder()
    const id2 = await recordAndRefine(h2, { beforeStop: () => markAssistantSpeech(4200, 7000) })
    assert.equal(h2.recorder.mergeSpeakers(id2, 'loop-s1', ASSISTANT_SPEAKER).ok, true)
    const merged = h2.store.getSegments(id2).filter(segment => segment.track === 'loopback')
    assert.ok(merged.length === 2 && merged.every(segment => segment.source === 'assistant' && segment.speaker === ASSISTANT_SPEAKER))
    const minutes = h2.store.getMinutes(id2)?.content ?? ''
    assert.match(minutes.slice(minutes.indexOf('## 时间线'), minutes.indexOf('## 助理播报区间')),
      /小潘（AI 助理）.*对方丙说话/s)
    h.store.close()
    h2.store.close()
  })
})

describe('增量转写（临时字幕）与会后精修按版本替换', () => {
  test('录音中逐块出临时字幕（只在内存）；精修写库后临时字幕清空，段不重复', async () => {
    const h = setupRecorder({ liveCaptions: true })
    const started = h.recorder.startMeeting(CONSENT_BOTH)
    if (!started.ok) throw new Error(started.error)
    pushWholeTrack(h, started.meetingId, 'mic', MIC)
    pushWholeTrack(h, started.meetingId, 'loopback', LOOP)
    await h.recorder.whenLiveIdle()
    const live = h.recorder.getState().live
    assert.equal(live?.meetingId, started.meetingId)
    assert.deepEqual(live?.captions.map(caption => [caption.track, caption.trackSeq, caption.startMs, caption.status, caption.text ?? null]), [
      ['mic', 0, 0, 'ok', '甲说话'],
      ['loopback', 0, 0, 'ok', '对方丙说话'],
      ['mic', 1, 4000, 'ok', '乙说话甲说话'],
      ['loopback', 1, 4000, 'empty', null],
      ['mic', 2, 8000, 'ok', '甲说话'],
      ['loopback', 2, 8000, 'ok', '对方丙说话'],
    ])
    assert.equal(h.store.getSegments(started.meetingId).length, 0, '临时字幕不落库')

    h.recorder.requestStop(started.meetingId)
    await h.recorder.flushDone(started.meetingId)
    await h.recorder.whenSettled()
    assert.equal(h.recorder.getState().live, null, '精修结果替换临时字幕')
    assert.deepEqual(brief(h.store.getSegments(started.meetingId)), DIARIZED, '只有精修那一份，不重复')
    h.store.close()
  })

  test('未分人兜底时直接复用录音中的临时转写，不重复识别同一块', async () => {
    const missing: DiarizeFn = async () => ({ ok: false, reason: 'model-missing', message: '分人模型未安装' })
    const h = setupRecorder({ liveCaptions: true, diarize: missing })
    const started = h.recorder.startMeeting(CONSENT_BOTH)
    if (!started.ok) throw new Error(started.error)
    pushWholeTrack(h, started.meetingId, 'mic', MIC)
    pushWholeTrack(h, started.meetingId, 'loopback', LOOP)
    await h.recorder.whenLiveIdle()
    assert.equal(h.transcribed.length, 6)
    h.recorder.requestStop(started.meetingId)
    await h.recorder.flushDone(started.meetingId)
    await h.recorder.whenSettled()
    assert.equal(h.transcribed.length, 6, '精修没有再识别一遍')
    assert.equal(h.store.getSegments(started.meetingId).length, 5)
    h.store.close()
  })

  test('失败片段保留缺口（占位段，时间如实），局部重试只替换它，用户改过的名字保留', async () => {
    const failValues = new Set([6000])
    const h = setupRecorder({ transcribe: transcribeByValue(DEFAULT_WORDS, { failValues }) })
    const id = await recordAndRefine(h)
    assert.equal(h.store.getMeeting(id)?.state, 'transcribed', '部分失败不算整体失败')
    const before = h.store.getSegments(id)
    const failed = before.filter(segment => segment.source === 'failed')
    assert.deepEqual(brief(failed), [
      { startMs: 4200, endMs: 7000, speaker: 'mic-s2', label: '本机麦克风·发言人2', text: FAILED_SEGMENT_TEXT, source: 'failed', track: 'mic' },
    ])
    assert.ok((h.recorder.getState().transcribeNote ?? '').includes('有 1 个片段转写失败'))
    assert.ok(h.store.getMinutes(id)?.content.includes('这段转写失败，录音已保留，可在会议页重试'))
    assert.ok(!h.store.getMinutes(id)?.content.includes(FAILED_SEGMENT_TEXT), '占位文字不冒充转写原文进纪要')

    assert.equal(h.recorder.renameSpeaker(id, 'mic-s2', '李四').ok, true)
    failValues.clear()
    const calls = h.transcribed.length
    assert.equal(h.recorder.retryFailed(id).ok, true)
    await h.recorder.whenSettled()
    assert.equal(h.transcribed.length - calls, 1, '只重试那一个失败片段')
    const after = h.store.getSegments(id)
    const fixed = after.find(segment => segment.startMs === 4200)
    assert.deepEqual([fixed?.text, fixed?.source, fixed?.label, fixed?.speaker], ['乙说话', 'asr', '李四', 'mic-s2'])
    const strip = (segments: TranscriptSegment[]): unknown[] => brief(segments.filter(segment => segment.startMs !== 4200))
    assert.deepEqual(strip(after), strip(before), '其余段一个字都不动')
    const speakers = h.recorder.getSpeakers(id)
    assert.ok(speakers.ok && speakers.transcript?.userEdited === true, '人工修订这个事实不因重试而消失')
    assert.equal(h.recorder.retryFailed(id).ok, false, '没有失败片段了')
    const full = h.recorder.retranscribe(id)
    assert.equal(full.ok, false, '有人工修订时整体重转会覆盖修订，必须拒绝')
    if (!full.ok) assert.match(full.error, /人工修订/)
    h.store.close()
  })

  test('有人工修订时点"重试转写"：自动降为只重试失败片段', async () => {
    const failValues = new Set([9000])
    const h = setupRecorder({ transcribe: transcribeByValue(DEFAULT_WORDS, { failValues }) })
    const id = await recordAndRefine(h)
    assert.equal(h.store.getSegments(id).filter(segment => segment.source === 'failed').length, 2)
    assert.equal(h.recorder.renameSpeaker(id, 'mic-s1', '张三').ok, true)
    failValues.clear()
    assert.equal(h.recorder.retranscribe(id).ok, true)
    await h.recorder.whenSettled()
    const segments = h.store.getSegments(id)
    assert.equal(segments.filter(segment => segment.source === 'failed').length, 0)
    assert.equal(segments.filter(segment => segment.label === '张三').length, 2, '改名保留')
    h.store.close()
  })

  test('精修跑到一半用户改了段：结果不覆盖人工修订（乐观锁）', async () => {
    let hook: (() => void) | null = null
    const words = transcribeByValue(DEFAULT_WORDS)
    const h = setupRecorder({
      transcribe: async (wav, dir) => {
        const run = hook
        hook = null
        run?.()
        return words(wav, dir)
      },
    })
    const id = await recordAndRefine(h)
    hook = () => {
      assert.equal(h.recorder.renameSpeaker(id, 'mic-s1', '张三').ok, true)
    }
    assert.equal(h.recorder.retranscribe(id).ok, true, '没有人工修订时允许整体重转')
    await h.recorder.whenSettled()
    const segments = h.store.getSegments(id)
    assert.equal(segments.filter(segment => segment.label === '张三').length, 2, '用户的改名没有被机器结果盖掉')
    assert.ok((h.recorder.getState().transcribeNote ?? '').includes('没有覆盖你的修订'))
    h.store.close()
  })

  test('全部片段都失败：标 transcript-failed、不写占位段；修好后整体重转', async () => {
    const failValues = new Set([3000, 6000, 9000])
    const h = setupRecorder({ transcribe: transcribeByValue(DEFAULT_WORDS, { failValues }) })
    const id = await recordAndRefine(h)
    assert.equal(h.store.getMeeting(id)?.state, 'transcript-failed')
    assert.equal(h.store.getSegments(id).length, 0)
    assert.ok((h.recorder.getState().transcribeNote ?? '').includes('已保存的录音块予以保留'))
    assert.equal(h.recorder.getState().integrity?.status, 'unknown', '旧式冲刷没有末块证据，不能宣称完整')
    const savedChunks = h.store.listChunks(id).length
    assert.ok(savedChunks > 0)
    failValues.clear()
    assert.equal(h.recorder.retranscribe(id).ok, true)
    await h.recorder.whenSettled()
    assert.equal(h.store.getMeeting(id)?.state, 'transcribed')
    assert.equal(h.store.listChunks(id).length, savedChunks, '转写失败及重试都不丢已保存的块')
    assert.deepEqual(brief(h.store.getSegments(id)), DIARIZED)
    h.store.close()
  })

  test('转写进行中再点重转/重试：拒绝，不让两个任务抢着写段', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const words = transcribeByValue(DEFAULT_WORDS)
    let gated = false
    const h = setupRecorder({
      transcribe: async (wav, dir) => {
        if (gated) await gate
        return words(wav, dir)
      },
    })
    const id = await recordAndRefine(h, { loop: false })
    gated = true
    assert.equal(h.recorder.retranscribe(id).ok, true)
    const again = h.recorder.retranscribe(id)
    assert.equal(again.ok, false)
    if (!again.ok) assert.match(again.error, /正在进行/)
    release()
    await h.recorder.whenSettled()
    assert.equal(h.store.getMeeting(id)?.state, 'transcribed')
    h.store.close()
  })
})

// 静音块不产生段、也不计失败（asr.ts 对整段静音报"没有听到说话内容"）。
describe('没人说话不是失败', () => {
  test('整段静音：不产生段、不算失败，状态是转写完成', async () => {
    const h = setupRecorder()
    const started = h.recorder.startMeeting(CONSENT_MIC)
    if (!started.ok) throw new Error(started.error)
    pushWholeTrack(h, started.meetingId, 'mic', constPcm(8000, 0))
    h.recorder.requestStop(started.meetingId)
    await h.recorder.flushDone(started.meetingId)
    await h.recorder.whenSettled()
    assert.equal(h.store.getMeeting(started.meetingId)?.state, 'transcribed')
    assert.equal(h.store.getSegments(started.meetingId).length, 0)
    assert.ok(!(h.recorder.getState().transcribeNote ?? '').includes('失败'))
    h.store.close()
  })
})

describe('IPC 面：分轨协议与局部重试不新增通道', () => {
  test('meeting-chunk 把分轨 meta 交给 recorder 校验；局部重试走 meeting-transcribe 的 failed-only 模式', async () => {
    const failValues = new Set([6000])
    const h = setupRecorder({ transcribe: transcribeByValue(DEFAULT_WORDS, { failValues }) })
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    registerMeetingIpc({ ipc: { handle: (channel, listener) => { handlers.set(channel, listener) } }, recorder: h.recorder })
    assert.deepEqual([...handlers.keys()].sort(), [
      'meeting-chunk', 'meeting-flush-done', 'meeting-minutes', 'meeting-minutes-confirm', 'meeting-speaker-merge',
      'meeting-speaker-rename', 'meeting-speaker-split', 'meeting-speakers', 'meeting-start', 'meeting-state',
      'meeting-stop', 'meeting-track-missing', 'meeting-transcribe',
    ], '通道清单与之前完全一致：分轨/重试都走既有通道的新参数')
    const call = (channel: string, ...args: unknown[]): unknown => (handlers.get(channel) as (event: unknown, ...rest: unknown[]) => unknown)({}, ...args)

    const started = call('meeting-start', CONSENT_MIC) as { ok: boolean; meetingId: string }
    assert.equal(started.ok, true)
    const first = constPcm(4000, 3000)
    const pcm = constPcm(4000, 6000)
    h.clock.set(START + 8100)
    assert.deepEqual(call('meeting-chunk', started.meetingId, first.toString('base64'), meta('mic', 0, 0, first)), { ok: true, seq: 0 })
    assert.deepEqual(call('meeting-chunk', started.meetingId, pcm.toString('base64'), meta('mic', 1, 4000, pcm)), { ok: true, seq: 1 })
    assert.equal((call('meeting-chunk', started.meetingId, pcm.toString('base64'), meta('mic', 1, 4000, pcm)) as { ok: boolean }).ok, false, '同轨同序号的重复块被拒')
    assert.equal((call('meeting-chunk', started.meetingId, pcm.toString('base64'), { ...meta('mic', 2, 8000, pcm), frames: 7 }) as { ok: boolean }).ok, false)
    assert.deepEqual(h.store.listChunks(started.meetingId).map(chunk => [chunk.track, chunk.trackSeq, chunk.startMs]), [['mic', 0, 0], ['mic', 1, 4000]])

    call('meeting-stop', started.meetingId)
    await call('meeting-flush-done', started.meetingId)
    await h.recorder.whenSettled()
    assert.deepEqual(h.store.getSegments(started.meetingId).map(segment => [segment.text, segment.source]), [['甲说话', 'asr'], [FAILED_SEGMENT_TEXT, 'failed']])

    failValues.clear()
    assert.deepEqual(call('meeting-transcribe', started.meetingId, 'failed-only'), { ok: true })
    await h.recorder.whenSettled()
    assert.deepEqual(h.store.getSegments(started.meetingId).map(segment => [segment.text, segment.source]), [['甲说话', 'asr'], ['乙说话', 'asr']])
    assert.equal((call('meeting-transcribe', started.meetingId, 'failed-only') as { ok: boolean }).ok, false, '没有失败片段时如实拒绝')
    h.store.close()
  })
})
