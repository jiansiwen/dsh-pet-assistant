/**
 * 会议编排的测试：假渲染流 + 假转写，不开麦克风、不跑真 ASR。
 *
 * 钉住的是闭环上最容易悄悄坏掉的几条：consent 必填缺一个就拒；麦克风仲裁与听写互斥、
 * 失败要回滚；停止是"先停流落盘、再结算转写"；转写失败只标状态、录音一块不丢；
 * 说话人修订 bump revision；助理播报区间进纪要且注明不算真人发言；纪要没点确认就
 * 永远是 draft。
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { INITIAL_AUDIO_STATE, nextAudio, type AudioEvent, type AudioState, type AudioTransition } from '../src/main/audio.ts'
import {
  MeetingRecorder,
  buildMinutesContent,
  markAssistantSpeech,
  type MeetingAsrResult,
} from '../src/main/meeting-recorder.ts'
import { MeetingStore, type MeetingConsentInput } from '../src/main/meeting-store.ts'

const FAKE_KEY = Buffer.alloc(32, 9)

const CONSENT: MeetingConsentInput = {
  name: '产品评审会',
  sources: 'mic',
  consentText: '我知晓本场会议将被录音并加密保存在本机',
  consented: true,
  retentionDays: 30,
}

const roots: string[] = []
process.on('exit', () => {
  for (const dir of roots) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录 */ }
  }
})

interface Harness {
  recorder: MeetingRecorder
  store: MeetingStore
  clock: { now(): number; advance(ms: number): void }
  events: Array<{ channel: string; payload: unknown }>
  audioEffects: string[]
  audioState: () => AudioState
  transcribed: ArrayBuffer[]
}

function setup(opts: {
  transcribe?: (wav: ArrayBuffer, userDataDir: string) => Promise<MeetingAsrResult>
  keyProvider?: () => { status: 'ok'; key: Buffer } | { status: 'lost'; message: string } | { status: 'unsupported' }
  initialAudio?: AudioState
  flushTimeoutMs?: number
} = {}): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-meeting-rec-'))
  roots.push(dir)
  let current = 1_700_000_000_000
  const clock = {
    now: () => current,
    advance: (ms: number) => { current += ms },
  }
  const store = new MeetingStore(dir, {
    keyProvider: opts.keyProvider ?? (() => ({ status: 'ok' as const, key: FAKE_KEY })),
    now: clock.now,
  })
  let audioState = opts.initialAudio ?? INITIAL_AUDIO_STATE
  const audioEffects: string[] = []
  const events: Array<{ channel: string; payload: unknown }> = []
  const transcribed: ArrayBuffer[] = []
  const recorder = new MeetingRecorder({
    store,
    userDataDir: dir,
    audio: (event: AudioEvent): AudioTransition => {
      const turn = nextAudio(audioState, event)
      audioState = turn.state
      audioEffects.push(...turn.effects)
      return turn
    },
    notifyRenderer: (channel, payload) => events.push({ channel, payload }),
    transcribe: opts.transcribe ?? (async (wav) => {
      transcribed.push(wav)
      return { ok: true, text: `识别文本${transcribed.length}` }
    }),
    now: clock.now,
    ...(opts.flushTimeoutMs !== undefined ? { flushTimeoutMs: opts.flushTimeoutMs } : {}),
  })
  return { recorder, store, clock, events, audioEffects, audioState: () => audioState, transcribed }
}

/** 模拟渲染层：收到 meeting-started 后推 n 块 PCM，每块间隔 chunkGapMs。 */
function fakeRendererPush(h: Harness, meetingId: string, chunks: number): void {
  for (let i = 0; i < chunks; i++) {
    h.clock.advance(4000)
    const pcm = Buffer.alloc(640 * 100, i + 1) // ~4 秒 16kHz Int16
    const pushed = h.recorder.pushChunk(meetingId, pcm.toString('base64'))
    assert.equal(pushed.ok, true, `第 ${i} 块应推成功`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('startMeeting：consent 必填与仲裁', () => {
  test('缺名字 / 没勾知情 / 缺同意文本 / 来源不对 / 保留天数不对，全部拒绝且不动麦克风', () => {
    const h = setup()
    const bad: MeetingConsentInput[] = [
      { ...CONSENT, name: '' },
      { ...CONSENT, consented: false },
      { ...CONSENT, consentText: '  ' },
      { ...CONSENT, sources: 'webcam' as MeetingConsentInput['sources'] },
      { ...CONSENT, retentionDays: 0 },
      { ...CONSENT, retentionDays: 2.5 },
    ]
    for (const consent of bad) {
      const result = h.recorder.startMeeting(consent)
      assert.equal(result.ok, false, JSON.stringify(consent))
      if (!result.ok) assert.ok(result.error.length > 0)
    }
    assert.equal(h.audioState().holder, null, '被拒的开始不该碰麦克风仲裁')
    assert.deepEqual(h.store.listMeetings(), [])
    h.store.close()
  })

  test('设备被听写占着：拒绝开会议，不掐断用户那一句话', () => {
    const dictating = nextAudio(INITIAL_AUDIO_STATE, { type: 'dictation-requested' }).state
    const h = setup({ initialAudio: dictating })
    const result = h.recorder.startMeeting(CONSENT)
    assert.equal(result.ok, false)
    assert.equal(h.audioState().holder, 'dictation', '听写不受影响')
    assert.deepEqual(h.store.listMeetings(), [], '库里不留半场会')
    h.store.close()
  })

  test('密钥 lost：拒绝开会把设备还回去，不能锁死唤醒词', () => {
    // 真实场景是 boot 后唤醒在听：开会议先停唤醒，库拒了要把唤醒恢复回来。
    const awake = nextAudio(INITIAL_AUDIO_STATE, { type: 'boot' }).state
    const h = setup({
      keyProvider: () => ({ status: 'lost', message: '密钥可能已损坏' }),
      initialAudio: awake,
    })
    const result = h.recorder.startMeeting(CONSENT)
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.error.includes('密钥'))
    assert.equal(h.audioState().holder, 'wake', '仲裁要回滚：唤醒监听恢复')
    assert.deepEqual(h.store.listMeetings(), [])
    h.store.close()
  })

  test('唤醒在听时开会议：stop-wake 生效，参会者的话不进命令识别器', () => {
    const awake = nextAudio(INITIAL_AUDIO_STATE, { type: 'boot' }).state
    const h = setup({ initialAudio: awake })
    const result = h.recorder.startMeeting(CONSENT)
    assert.equal(result.ok, true)
    assert.deepEqual(h.audioEffects, ['stop-wake'])
    assert.equal(h.audioState().holder, 'meeting')
    h.store.close()
  })

  test('专注模式不阻止显式会议', () => {
    const focus = nextAudio(nextAudio(INITIAL_AUDIO_STATE, { type: 'boot' }).state, { type: 'focus', on: true }).state
    const h = setup({ initialAudio: focus })
    const result = h.recorder.startMeeting(CONSENT)
    assert.equal(result.ok, true)
    assert.equal(h.audioState().holder, 'meeting')
    h.store.close()
  })

  test('同一时间只有一场会议', () => {
    const h = setup()
    assert.equal(h.recorder.startMeeting(CONSENT).ok, true)
    const second = h.recorder.startMeeting({ ...CONSENT, name: '第二场' })
    assert.equal(second.ok, false)
    h.store.close()
  })
})

describe('录音 → 停止 → 结算：先停流落盘，再转写', () => {
  test('完整闭环：通知开始流、收块落盘、停流冲刷、结算转写、还设备', async () => {
    const h = setup()
    const started = h.recorder.startMeeting(CONSENT)
    assert.equal(started.ok, true)
    if (!started.ok) return
    const meetingId = started.meetingId

    // 渲染层收到"开始流"的通知才会采音。startedAt 是两路时间轴共同的零点。
    const startEvent = h.events.find(event => event.channel === 'meeting-started')
    assert.ok(startEvent !== undefined, '应通知渲染层开始流')
    assert.deepEqual(startEvent.payload, { meetingId, sources: 'mic', name: '产品评审会', sampleRate: 16000, startedAt: 1_700_000_000_000 })

    fakeRendererPush(h, meetingId, 3)
    assert.equal(h.store.chunkFileCount(meetingId), 3, '每块都即时加密落盘')

    // 用户点"立即停止"：主进程先让渲染层停流。
    const stopResult = h.recorder.requestStop(meetingId)
    assert.equal(stopResult.ok, true)
    assert.ok(h.events.some(event => event.channel === 'meeting-stopping'), '应通知渲染层停流')
    assert.equal(h.recorder.getState().stopping, true)

    // 渲染层停轨、推最后一块、回报 flushDone —— 这一块必须进库（先停流落盘再结算）。
    const lastPcm = Buffer.alloc(640 * 50, 42)
    h.clock.advance(1500)
    assert.equal(h.recorder.pushChunk(meetingId, lastPcm.toString('base64')).ok, true)
    const flushed = await h.recorder.flushDone(meetingId)
    assert.equal(flushed.ok, true)
    await h.recorder.whenSettled()

    assert.equal(h.store.chunkFileCount(meetingId), 4, '冲刷的最后一块不能丢')
    const meeting = h.store.getMeeting(meetingId)
    assert.equal(meeting?.state, 'transcribed')
    assert.ok(meeting?.endedAt !== null && meeting?.endedAt !== undefined)

    // 结算后设备还给唤醒监听。
    assert.equal(h.audioState().holder, 'wake')
    assert.ok(h.audioEffects.includes('start-wake'))

    // 转写：逐 chunk 拼 wav（RIFF 头）调注入的 transcribe。
    assert.equal(h.transcribed.length, 4)
    for (const wav of h.transcribed) {
      assert.equal(Buffer.from(wav.slice(0, 4)).toString('ascii'), 'RIFF')
      assert.equal(Buffer.from(wav.slice(8, 12)).toString('ascii'), 'WAVE')
    }

    // 段：全部 uncertain=true。测试目录里没装分人模型 → 退回逐块转写，整条麦克风音轨
    // 归一组并如实标"未分人"（带音源前缀的 id），不按时间瞎合并。
    const segments = h.store.getSegments(meetingId)
    assert.equal(segments.length, 4)
    assert.equal(segments.every(segment => segment.uncertain && segment.label === '本机麦克风·未分人' && segment.speaker === 'mic-s1'), true)
    assert.equal(segments.every(segment => segment.track === 'mic'), true)
    assert.equal(segments[0].startMs, 4000, 'startMs 是相对会议开始的毫秒数')
    assert.ok((segments[0].endMs ?? 0) > (segments[0].startMs ?? 0))
    assert.equal(segments[0].text, '识别文本1')
    assert.ok(h.recorder.getState().transcribeNote?.includes('未自动分人'), '模型缺失要如实写明未自动分人')

    // 纪要草稿已生成（本地模板）。
    const minutes = h.store.getMinutes(meetingId)
    assert.ok(minutes !== null)
    assert.equal(minutes.state, 'draft')
    assert.ok(minutes.content.includes('产品评审会'))
    assert.ok(minutes.content.includes('识别文本1'))
    assert.ok(minutes.content.includes('行动项'))
    assert.ok(minutes.content.includes('待填'))

    assert.equal(h.recorder.getState().transcribe, 'transcribed')
    h.store.close()
  })

  test('转写失败：标 transcript-failed，录音一块不丢，可重试', async () => {
    let calls = 0
    const h = setup({ transcribe: async () => {
      calls++
      return { ok: false, error: '识别器起不来' }
    } })
    const started = h.recorder.startMeeting(CONSENT)
    if (!started.ok) throw new Error('start 失败')
    fakeRendererPush(h, started.meetingId, 2)
    h.recorder.requestStop(started.meetingId)
    await h.recorder.flushDone(started.meetingId)
    await h.recorder.whenSettled()

    const meeting = h.store.getMeeting(started.meetingId)
    assert.equal(meeting?.state, 'transcript-failed')
    assert.equal(h.store.chunkFileCount(started.meetingId), 2, '失败只标状态，不碰录音')
    assert.equal(h.recorder.getState().transcribe, 'transcript-failed')

    // 重试入口 retranscribe：重新跑一遍转写任务，录音仍然完好。
    const before = calls
    const result = h.recorder.retranscribe(started.meetingId)
    assert.equal(result.ok, true)
    await h.recorder.whenSettled()
    assert.ok(calls > before, '重试应真的重新调转写')
    assert.equal(h.store.chunkFileCount(started.meetingId), 2)
    h.store.close()
  })

  test('渲染层没有回报 flushDone：超时兜底强制结算，会议不会停不下来', async () => {
    const h = setup({ flushTimeoutMs: 40 })
    const started = h.recorder.startMeeting(CONSENT)
    if (!started.ok) throw new Error('start 失败')
    fakeRendererPush(h, started.meetingId, 1)
    h.recorder.requestStop(started.meetingId)
    await sleep(120)
    await h.recorder.whenSettled()
    const meeting = h.store.getMeeting(started.meetingId)
    assert.ok(meeting?.state !== 'recording', '到点必须结算')
    assert.equal(h.audioState().holder, 'wake', '设备必须还回去')
    h.store.close()
  })

  test('不在录制中时推块/停止/冲刷都被拒', async () => {
    const h = setup()
    assert.equal(h.recorder.pushChunk('nope', 'AAAA').ok, false)
    assert.equal(h.recorder.requestStop().ok, false)
    assert.equal((await h.recorder.flushDone('nope')).ok, false)
    h.store.close()
  })
})

describe('音频仲裁：会议与听写互斥（纯函数）', () => {
  const AWAKE = nextAudio(INITIAL_AUDIO_STATE, { type: 'boot' }).state
  const MEETING = nextAudio(AWAKE, { type: 'meeting-requested' }).state

  test('会议占着设备时听写被拒，状态一点不动', () => {
    const turn = nextAudio(MEETING, { type: 'dictation-requested' })
    assert.ok(turn.denied !== null)
    assert.equal(turn.state.holder, 'meeting')
    assert.deepEqual(turn.effects, [])
  })

  test('听写占着设备时会议被拒', () => {
    const dictating = nextAudio(AWAKE, { type: 'dictation-requested' }).state
    const turn = nextAudio(dictating, { type: 'meeting-requested' })
    assert.ok(turn.denied !== null)
    assert.equal(turn.state.holder, 'dictation')
  })

  test('会议中再点开始会议：拒绝', () => {
    assert.ok(nextAudio(MEETING, { type: 'meeting-requested' }).denied !== null)
  })

  test('会议结束把设备还给唤醒；专注下不还给唤醒', () => {
    const finished = nextAudio(MEETING, { type: 'meeting-finished' })
    assert.equal(finished.state.holder, 'wake')
    assert.deepEqual(finished.effects, ['start-wake'])

    const focus = nextAudio(AWAKE, { type: 'focus', on: true }).state
    const meetingInFocus = nextAudio(focus, { type: 'meeting-requested' }).state
    const done = nextAudio(meetingInFocus, { type: 'meeting-finished' })
    assert.equal(done.state.holder, null)
    assert.deepEqual(done.effects, [], '专注下会议结束不拉起唤醒词')
  })

  test('重复的 meeting-finished 幂等，不会把刚拉起的唤醒又停掉', () => {
    const first = nextAudio(MEETING, { type: 'meeting-finished' })
    const second = nextAudio(first.state, { type: 'meeting-finished' })
    assert.deepEqual(second.effects, [])
    assert.deepEqual(second.state, first.state)
  })

  test('开专注不打断进行中的会议', () => {
    const turn = nextAudio(MEETING, { type: 'focus', on: true })
    assert.equal(turn.state.holder, 'meeting')
    assert.equal(turn.state.focus, true)
    assert.deepEqual(turn.effects, [])
  })

  test('唤醒进程挂了不带走会议', () => {
    const turn = nextAudio(MEETING, { type: 'wake-lost' })
    assert.equal(turn.state.holder, 'meeting')
    assert.equal(turn.state.wakeUnavailable, true)
    assert.deepEqual(turn.effects, [])
  })
})

describe('narrator TTS 区间：助理播报不算真人发言', () => {
  test('录制中打点进 assistant_speech，纪要单列一节并注明', async () => {
    const h = setup()
    const started = h.recorder.startMeeting(CONSENT)
    if (!started.ok) throw new Error('start 失败')
    const meetingId = started.meetingId
    // 模块级导出（主代理在 narrator 钩子里调的那个）。
    markAssistantSpeech(3000, 7500)
    fakeRendererPush(h, meetingId, 1)
    h.recorder.requestStop(meetingId)
    await h.recorder.flushDone(meetingId)
    await h.recorder.whenSettled()

    const spans = h.store.listAssistantSpeech(meetingId)
    assert.deepEqual(spans, [{ startMs: 3000, endMs: 7500 }])
    const minutes = h.store.getMinutes(meetingId)
    assert.ok(minutes !== null)
    assert.ok(minutes.content.includes('助理播报区间（不算真人发言）'))
    assert.ok(minutes.content.includes('不代表任何参会者发言'))
    assert.ok(minutes.content.includes('[00:03–00:07]'))
    h.store.close()
  })

  test('没有会议在录时打点是 no-op，不炸', () => {
    const h = setup()
    markAssistantSpeech(0, 100)
    assert.equal(h.recorder.getState().recording, false)
    h.store.close()
  })

  test('纪要写出音轨缺失的原因，能把"为什么只有一半声音"说清楚', () => {
    // 只说"缺了一轨"回答不了"我该改哪个开关"：麦克风权限与屏幕录制权限是两个页面。
    const content = buildMinutesContent({
      name: 'x', startedAt: 0, endedAt: 1000, sources: 'mic+loopback', consentText: '同意', retentionDays: 7,
      segments: [], assistantSpeech: [], missingTracks: ['loopback'],
      missingTrackReasons: { loopback: '缺少「屏幕与系统录音」权限' },
    })
    assert.ok(content.includes('缺失原因'))
    assert.ok(content.includes('屏幕与系统录音'))
    // 没有原因时不能编一行空的"- 缺失原因："出来。
    const noReason = buildMinutesContent({
      name: 'y', startedAt: 0, endedAt: 1000, sources: 'mic+loopback', consentText: '同意', retentionDays: 7,
      segments: [], assistantSpeech: [], missingTracks: ['loopback'],
    })
    assert.equal(noReason.includes('缺失原因'), false)
  })

  test('buildMinutesContent 列出缺失音轨，不假装录到了', () => {
    const content = buildMinutesContent({
      name: 'x',
      startedAt: 0,
      endedAt: 1000,
      sources: 'mic+loopback',
      consentText: '同意',
      retentionDays: 7,
      segments: [],
      assistantSpeech: [],
      missingTracks: ['loopback'],
    })
    assert.ok(content.includes('音轨缺失'))
    assert.ok(content.includes('不做推测'))
  })
})

describe('说话人修订与纪要确认（经 recorder 门面）', () => {
  async function transcribedHarness(): Promise<{ h: Harness; meetingId: string }> {
    const h = setup()
    const started = h.recorder.startMeeting(CONSENT)
    if (!started.ok) throw new Error('start 失败')
    fakeRendererPush(h, started.meetingId, 2)
    h.recorder.requestStop(started.meetingId)
    await h.recorder.flushDone(started.meetingId)
    await h.recorder.whenSettled()
    return { h, meetingId: started.meetingId }
  }

  test('改名/合并/拆分每次都 bump revision，并重新生成纪要草稿', async () => {
    const { h, meetingId } = await transcribedHarness()
    const before = h.store.getMeeting(meetingId)?.segmentsRevision ?? 0

    const renamed = h.recorder.renameSpeaker(meetingId, 'mic-s1', '张三')
    assert.equal(renamed.ok, true)
    if (renamed.ok) assert.equal(renamed.revision, before + 1)

    // 拆出来的新人编号避开 mic-s1 的编号：s2。
    const split = h.recorder.splitSegments(meetingId, [1], '李四')
    assert.equal(split.ok, true)
    assert.ok(h.store.getSegments(meetingId).some(segment => segment.speaker === 's2' && segment.label === '李四'))

    const merged = h.recorder.mergeSpeakers(meetingId, 's2', 'mic-s1')
    assert.equal(merged.ok, true)

    const minutes = h.store.getMinutes(meetingId)
    assert.ok(minutes !== null)
    assert.equal(minutes.state, 'draft', '修订后纪要必须重新过目')
    assert.ok(minutes.content.includes('张三'))
    h.store.close()
  })

  test('纪要未确认时永远是 draft；用户点确认后才 confirmed', async () => {
    const { h, meetingId } = await transcribedHarness()
    assert.equal(h.store.getMinutes(meetingId)?.state, 'draft')
    const confirmed = h.recorder.confirmMinutes(meetingId)
    assert.equal(confirmed.ok, true)
    assert.equal(h.store.getMinutes(meetingId)?.state, 'confirmed')

    // 确认之后再修订：纪要退回草稿，旧确认作废。
    h.recorder.renameSpeaker(meetingId, 'mic-s1', '王五')
    assert.equal(h.store.getMinutes(meetingId)?.state, 'draft')
    h.store.close()
  })

  test('getSpeakers 汇总说话人与段数', async () => {
    const { h, meetingId } = await transcribedHarness()
    const result = h.recorder.getSpeakers(meetingId)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.speakers, [{ speaker: 'mic-s1', label: '本机麦克风·未分人', count: 2 }])
    assert.equal(result.segments.length, 2)
    assert.equal(result.transcript?.mode, 'undiarized')
    assert.equal(result.transcript?.userEdited, false)
    h.store.close()
  })
})
