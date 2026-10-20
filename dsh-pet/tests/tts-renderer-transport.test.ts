/**
 * "外放插话"开关的 TTS 传输（M1-05）：Narrator 看到的协议一字不变，只是出声的换成渲染层。
 * 也钉住开关关着时的默认路径：切换外壳原样透传，不多不少。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { Narrator, type TtsTransport, type TtsWorkerEvent } from '../src/main/tts.ts'
import { RendererPlayback, createSwitchingTransport, type RendererReceipt, type SynthOnlyEvent } from '../src/main/tts-renderer-transport.ts'
import { TtsEdgeEngine, sniffAudioMime, type SynthOnlyWorkerEvent } from '../src/main/tts-edge-worker.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/** 假的"只合成"进程：speak 后在 audio() 时交出音频；stop 在合成中则报 cancelled。 */
function fakeSynth() {
  const state = { deliver: null as ((event: SynthOnlyEvent) => void) | null, pending: null as string | null, lines: [] as string[], closed: 0 }
  const open = (deliver: (event: SynthOnlyEvent) => void): TtsTransport => {
    state.deliver = deliver
    queueMicrotask(() => deliver({ ready: true, voice: 'fake' }))
    return {
      write(line) {
        state.lines.push(line)
        const message = JSON.parse(line)
        if (message.speak) state.pending = message.speak.id
        if (message.stop && state.pending) { const id = state.pending; state.pending = null; queueMicrotask(() => deliver({ cancelled: { id } })) }
      },
      close() { state.closed++ },
    }
  }
  const audio = () => { const id = state.pending!; state.pending = null; state.deliver!({ audio: { id, b64: 'QUJD', mime: 'audio/mpeg' } }) }
  return { open, state, audio }
}

function fakePort() {
  const calls: Array<{ op: 'play' | 'stop'; id: string }> = []
  return { calls, port: { play: (id: string) => { calls.push({ op: 'play', id }); return true }, stop: (id: string) => { calls.push({ op: 'stop', id }) } } }
}

describe('渲染层播放传输：协议映射', () => {
  test('started 只在渲染层实际开始时报；finished 原样结算', async () => {
    const synth = fakeSynth()
    const { calls, port } = fakePort()
    const playback = new RendererPlayback(synth.open, port, { setTimeout: () => 0, clearTimeout: () => {} })
    const events: TtsWorkerEvent[] = []
    const transport = playback.open(e => events.push(e))
    await tick()
    assert.deepEqual(events, [{ ready: true, voice: 'fake' }])
    transport.write(JSON.stringify({ speak: { id: 'u#0', b64: 'eA==' } }))
    synth.audio()
    assert.deepEqual(calls, [{ op: 'play', id: 'u#0' }])
    assert.equal(events.length, 1, '交给渲染层还不算开始')
    playback.receipt({ id: 'u#0', kind: 'started', durationMs: 1000 })
    playback.receipt({ id: 'u#0', kind: 'finished' })
    assert.deepEqual(events.slice(1), [{ started: { id: 'u#0' } }, { finished: { id: 'u#0' } }])
    playback.receipt({ id: 'u#0', kind: 'finished' })
    assert.equal(events.length, 3, '迟到 / 重复的回执丢掉')
  })

  test('渲染层自己停的（插话）要等 stop 到了才报 cancelled；stop 发给渲染层', async () => {
    const synth = fakeSynth()
    const { calls, port } = fakePort()
    const playback = new RendererPlayback(synth.open, port, { setTimeout: () => 0, clearTimeout: () => {} })
    const events: TtsWorkerEvent[] = []
    const transport = playback.open(e => events.push(e))
    await tick()
    transport.write(JSON.stringify({ speak: { id: 'u#1', b64: 'eA==' } }))
    synth.audio()
    playback.receipt({ id: 'u#1', kind: 'started', durationMs: 1000 })
    playback.receipt({ id: 'u#1', kind: 'cancelled' })
    assert.equal(events.filter(e => 'cancelled' in e).length, 0, 'Narrator 没要求停之前的取消不能转过去')
    transport.write('{"stop":{}}')
    assert.deepEqual(calls.at(-1), { op: 'stop', id: 'u#1' })
    playback.receipt({ id: 'u#1', kind: 'cancelled' })
    assert.deepEqual(events.at(-1), { cancelled: { id: 'u#1' } })
  })

  test('还在合成时 stop：交给合成进程，它报的 cancelled 原样转', async () => {
    const synth = fakeSynth()
    const { calls, port } = fakePort()
    const playback = new RendererPlayback(synth.open, port, { setTimeout: () => 0, clearTimeout: () => {} })
    const events: TtsWorkerEvent[] = []
    const transport = playback.open(e => events.push(e))
    await tick()
    transport.write(JSON.stringify({ speak: { id: 'u#2', b64: 'eA==' } }))
    transport.write('{"stop":{}}')
    await tick()
    assert.deepEqual(events.at(-1), { cancelled: { id: 'u#2' } })
    assert.equal(calls.length, 0, '没交给渲染层就不用让渲染层停')
  })

  test('渲染层停止没有回执：超时按已取消结算，不让 Narrator 一直等', async () => {
    const synth = fakeSynth()
    const { port } = fakePort()
    const timers: Array<() => void> = []
    const playback = new RendererPlayback(synth.open, port, { setTimeout: fn => { timers.push(fn); return timers.length }, clearTimeout: () => {} })
    const events: TtsWorkerEvent[] = []
    const transport = playback.open(e => events.push(e))
    await tick()
    transport.write(JSON.stringify({ speak: { id: 'u#3', b64: 'eA==' } }))
    synth.audio()
    playback.receipt({ id: 'u#3', kind: 'started', durationMs: 1000 })
    transport.write('{"stop":{}}')
    timers.at(-1)!()
    assert.deepEqual(events.at(-1), { cancelled: { id: 'u#3' } })
  })

  test('渲染层不在（窗口没了）/ 解码失败：报错误，Narrator 按失败处理', async () => {
    const synth = fakeSynth()
    const playback = new RendererPlayback(synth.open, { play: () => false, stop: () => {} }, { setTimeout: () => 0, clearTimeout: () => {} })
    const events: TtsWorkerEvent[] = []
    const transport = playback.open(e => events.push(e))
    await tick()
    transport.write(JSON.stringify({ speak: { id: 'u#4', b64: 'eA==' } }))
    synth.audio()
    assert.ok('ok' in events.at(-1)! && (events.at(-1) as { ok: false }).ok === false)
  })

  test('接上真实 Narrator：完整一轮 started/finished、打断 cancelled 都按原协议走', async () => {
    const synth = fakeSynth()
    const { port } = fakePort()
    const playback = new RendererPlayback(synth.open, port, { setTimeout: () => 0, clearTimeout: () => {} })
    const spoken: Array<{ complete: boolean; text: string }> = []
    const narrator = new Narrator(playback.open, { onSpoken: r => spoken.push({ complete: r.complete, text: r.segment.text }) })
    narrator.speak({ utteranceId: 'n', text: '第一句。第二句。' })
    await tick()
    synth.audio()
    playback.receipt({ id: 'n#0', kind: 'started', durationMs: 500 } as RendererReceipt)
    playback.receipt({ id: 'n#0', kind: 'finished' })
    await tick()
    synth.audio()
    playback.receipt({ id: 'n#1', kind: 'started', durationMs: 500 })
    narrator.interrupt('drop-queue')
    playback.receipt({ id: 'n#1', kind: 'cancelled' })
    await tick()
    assert.deepEqual(spoken, [{ complete: true, text: '第一句。' }, { complete: false, text: '第二句。' }])
    assert.equal(narrator.isSpeaking(), false)
    narrator.dispose()
  })
})

describe('切换外壳', () => {
  test('关着开关：原样透传，Narrator 只看到一次 ready', async () => {
    const lines: string[] = []
    const events: TtsWorkerEvent[] = []
    let deliver: ((e: TtsWorkerEvent) => void) | null = null
    const open = createSwitchingTransport<'process' | 'renderer'>(() => 'process', {
      process: d => { deliver = d; queueMicrotask(() => d({ ready: true })); return { write: l => lines.push(l), close() {} } },
      renderer: () => { throw new Error('开关关着不该打开渲染层传输') },
    })
    const transport = open(e => events.push(e))
    await tick()
    transport.write('{"speak":{"id":"a#0","b64":"eA=="}}')
    transport.write('{"stop":{}}')
    deliver!({ cancelled: { id: 'a#0' } })
    assert.deepEqual(lines, ['{"speak":{"id":"a#0","b64":"eA=="}}', '{"stop":{}}'])
    assert.deepEqual(events, [{ ready: true }, { cancelled: { id: 'a#0' } }])
  })

  test('两次讲话之间切换：关旧开新，等新的 ready 再把这句交过去；新 ready 不重复报', async () => {
    let mode: 'process' | 'renderer' = 'process'
    const log: string[] = []
    const make = (name: string) => (d: (e: TtsWorkerEvent) => void): TtsTransport => {
      log.push(`open ${name}`)
      queueMicrotask(() => d({ ready: true }))
      return { write: l => log.push(`${name} ${JSON.parse(l).speak?.id ?? 'stop'}`), close: () => log.push(`close ${name}`) }
    }
    const events: TtsWorkerEvent[] = []
    const transport = createSwitchingTransport(() => mode, { process: make('process'), renderer: make('renderer') })(e => events.push(e))
    await tick()
    transport.write('{"speak":{"id":"x#0","b64":""}}')
    mode = 'renderer'
    transport.write('{"speak":{"id":"x#1","b64":""}}')
    await tick(); await tick()
    assert.deepEqual(log, ['open process', 'process x#0', 'open renderer', 'close process', 'renderer x#1'])
    assert.equal(events.filter(e => 'ready' in e).length, 1)
  })
})

describe('合成进程的只合成模式', () => {
  test('派发不报 started；合成好交出音频即结算（可接下一句）；默认模式行为不变', async () => {
    const emitted: SynthOnlyWorkerEvent[] = []
    const handed: Array<{ id: string; bytes: number }> = []
    const played: string[] = []
    const engine = new TtsEdgeEngine({
      synthesize: async () => Buffer.from('ID3abc'),
      play: () => played.push('play'), fallback: () => played.push('fallback'), stopAudio: () => {},
      emit: e => emitted.push(e), handoff: (id, audio) => handed.push({ id, bytes: audio.length }),
    })
    engine.speak('s#0', '你好')
    await tick()
    assert.deepEqual(emitted, [], '只合成模式下派发时不报 started')
    assert.deepEqual(handed, [{ id: 's#0', bytes: 6 }])
    assert.deepEqual(played, [], '不在本地播')
    assert.equal(engine.busy, false)

    const defaults: SynthOnlyWorkerEvent[] = []
    const local = new TtsEdgeEngine({
      synthesize: async () => Buffer.from('ID3abc'),
      play: (_mp3, done) => done(true), fallback: () => {}, stopAudio: () => {}, emit: e => defaults.push(e),
    })
    local.speak('d#0', '你好')
    await tick()
    assert.deepEqual(defaults, [{ started: { id: 'd#0' } }, { finished: { id: 'd#0' } }])
  })

  test('只合成模式下合成失败走离线回退：本地播放前补 started', async () => {
    const emitted: SynthOnlyWorkerEvent[] = []
    const engine = new TtsEdgeEngine({
      synthesize: async () => { throw new Error('offline') },
      play: () => {}, fallback: (_t, done) => done(true), stopAudio: () => {},
      emit: e => emitted.push(e), handoff: () => { throw new Error('不该交出') },
    })
    engine.speak('f#0', '你好')
    await tick()
    assert.deepEqual(emitted, [{ started: { id: 'f#0' } }, { finished: { id: 'f#0' } }])
  })

  test('MIME 嗅探', () => {
    assert.equal(sniffAudioMime(Buffer.from('RIFF....')), 'audio/wav')
    assert.equal(sniffAudioMime(Buffer.from([0xff, 0xf3, 0, 0])), 'audio/mpeg')
    assert.equal(sniffAudioMime(Buffer.from('OggS')), 'audio/ogg')
  })
})
