/**
 * 会议录音期间的"语音停录"：匹配规则 + 端到端闭环（命中 → 请求停录 → 指令句不进转写）。
 *
 * 全部用假转写：真 ASR 装不装、识别得多准都不该决定这条逻辑对不对。
 * 判据本身是纯函数（`matchRecordStopCommand`），所以"哪些话算指令"能逐条钉死。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'

import { INITIAL_AUDIO_STATE, nextAudio, type AudioEvent, type AudioState, type AudioTransition } from '../src/main/audio.ts'
import { MeetingRecorder, type MeetingAsrResult } from '../src/main/meeting-recorder.ts'
import { MeetingStore, type MeetingConsentInput } from '../src/main/meeting-store.ts'
import { RECORD_STOP_MAX_CHARS, matchRecordStopCommand } from '../src/main/record-stop-command.ts'

const FAKE_KEY = Buffer.alloc(32, 7)
const CONSENT: MeetingConsentInput = {
  name: '语音停录评审会',
  sources: 'mic',
  consentText: '我知晓本场会议将被录音并加密保存在本机',
  consented: true,
  retentionDays: 30,
}
const roots: string[] = []
after(() => {
  for (const dir of roots) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录 */ }
  }
})

describe('matchRecordStopCommand：只认真正的停录指令', () => {
  test('命中：带唤醒词、指令落在句尾', () => {
    for (const said of ['小潘同学，停止录音', '小潘，结束录音', '小潘同学请停止录音', '小潘同学，停录吧']) {
      assert.equal(matchRecordStopCommand(said), true, said)
    }
  })

  test('命中：整句就是指令（不需要唤醒词）', () => {
    for (const said of ['停录', '停止录音', '结束会议', '停录。', '麻烦结束会议吧', '停止录制']) {
      assert.equal(matchRecordStopCommand(said), true, said)
    }
  })

  test('不命中：讨论、评价、方案，都是正常发言', () => {
    for (const said of [
      '我们停止录音的流程要改一下',
      '停止这个方案的讨论',
      '录音质量要提高',
      '小潘同学说这个录音质量要提高',
      '刚才停止录音的那一下挺快的',
    ]) {
      assert.equal(matchRecordStopCommand(said), false, said)
    }
  })

  test('不命中：超过字数上限的长句', () => {
    const long = `${'这个议题'.repeat(6)}小潘同学停止录音` // 远多于 20 字
    assert.ok([...long].length > RECORD_STOP_MAX_CHARS)
    assert.equal(matchRecordStopCommand(long), false)
  })

  test('不命中：指令词在句中而不是句尾', () => {
    assert.equal(matchRecordStopCommand('小潘同学停止录音之前先把结论过一遍'), false)
  })

  test('不命中：空串、纯标点、非字符串', () => {
    assert.equal(matchRecordStopCommand(''), false)
    assert.equal(matchRecordStopCommand('   '), false)
    assert.equal(matchRecordStopCommand('。。。'), false)
    assert.equal(matchRecordStopCommand(undefined as unknown as string), false)
  })
})

// ---------------------------------------------------------------------------
// 端到端：录音中命中指令 → 请求停录 → 这一句不进转写与纪要
// ---------------------------------------------------------------------------

const COMMAND = '小潘同学，停止录音'
const NORMAL = '这一版方案先按评审意见改'

/**
 * 第一块 PCM 填字节 1、其余填字节 2：转写替身按样本值出字，和"哪块音频说的什么"一一对应。
 * 注意 Int16LE 的两个字节被填成同一个值，所以样本值是 0x0101=257 / 0x0202=514，不是 1 / 2。
 */
const COMMAND_SAMPLE = 0x0101
const firstSample = (wav: ArrayBuffer): number => new Int16Array(wav, 44)[0]

function setup(): {
  recorder: MeetingRecorder
  store: MeetingStore
  events: Array<{ channel: string; payload: unknown }>
  audioState: () => AudioState
  close: () => void
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-meeting-voice-stop-'))
  roots.push(dir)
  let current = 1_700_000_000_000
  const store = new MeetingStore(dir, { keyProvider: () => ({ status: 'ok' as const, key: FAKE_KEY }), now: () => current })
  let audioState: AudioState = INITIAL_AUDIO_STATE
  const events: Array<{ channel: string; payload: unknown }> = []
  const recorder = new MeetingRecorder({
    store,
    userDataDir: dir,
    audio: (event: AudioEvent): AudioTransition => {
      const turn = nextAudio(audioState, event)
      audioState = turn.state
      return turn
    },
    notifyRenderer: (channel, payload) => events.push({ channel, payload }),
    // 第一块说指令，其余说正常发言。
    transcribe: async (wav): Promise<MeetingAsrResult> => ({
      ok: true,
      text: firstSample(wav) === COMMAND_SAMPLE ? COMMAND : NORMAL,
    }),
    liveCaptions: true,
    now: () => current,
  })
  return { recorder, store, events, audioState: () => audioState, close: () => store.close() }
}

function pushChunk(recorder: MeetingRecorder, meetingId: string, value: number): void {
  const pcm = Buffer.alloc(640 * 100, value) // ~4 秒 16k Int16
  const pushed = recorder.pushChunk(meetingId, pcm.toString('base64'))
  assert.equal(pushed.ok, true)
}

test('录音中听到"小潘同学，停止录音"：立刻请求停录，且这句不进转写', async () => {
  const h = setup()
  const started = h.recorder.startMeeting(CONSENT)
  assert.equal(started.ok, true)
  if (!started.ok) return
  const meetingId = started.meetingId

  pushChunk(h.recorder, meetingId, 1) // 这一块说指令
  await h.recorder.whenLiveIdle()

  // 命中的那一刻：请求停流（渲染层收到 meeting-stopping 才会推最后一块），
  // 而且临时字幕里不出现这句指令。
  assert.equal(h.recorder.getState().stopping, true, '命中指令应请求停录')
  assert.ok(h.events.some(event => event.channel === 'meeting-stopping'), '应通知渲染层停流')
  const live = h.recorder.getState().live
  assert.ok(live !== null)
  assert.equal(live.captions.some(caption => caption.text === COMMAND), false, '指令句不能出现在临时字幕里')

  // 渲染层冲刷完最后一块 → 精修转写。指令那句话必须被剔除，正常发言保留。
  pushChunk(h.recorder, meetingId, 2)
  await h.recorder.flushDone(meetingId)
  await h.recorder.whenSettled()

  const segments = h.store.getSegments(meetingId)
  assert.ok(segments.length > 0, '正常发言要留下来')
  assert.equal(segments.some(segment => segment.text === COMMAND), false, '指令句不能进转写')
  assert.equal(segments.every(segment => segment.text === NORMAL), true)
  assert.deepEqual(segments.map(segment => segment.idx), segments.map((_, index) => index), '剔除后段号仍连续')

  // 纪要同样不能出现这句指令。
  const minutes = h.store.getMinutes(meetingId)?.content ?? ''
  assert.equal(minutes.includes(COMMAND), false, '指令句不能进纪要')

  assert.equal(h.audioState().holder, 'wake', '停录后设备照常还回去')
  h.close()
})

test('没命中指令时不打扰：只录不停，正常结算', async () => {
  const h = setup()
  const started = h.recorder.startMeeting(CONSENT)
  assert.equal(started.ok, true)
  if (!started.ok) return
  const meetingId = started.meetingId

  pushChunk(h.recorder, meetingId, 2) // 都是正常发言
  await h.recorder.whenLiveIdle()
  assert.equal(h.recorder.getState().stopping, false, '没听到指令不该自己停')
  assert.equal(h.recorder.getState().recording, true)

  h.recorder.requestStop(meetingId)
  await h.recorder.flushDone(meetingId)
  await h.recorder.whenSettled()
  const segments = h.store.getSegments(meetingId)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].text, NORMAL)
  h.close()
})
