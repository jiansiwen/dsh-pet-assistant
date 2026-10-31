/**
 * 真实会议页面 → IPC → 录制器 → 加密存储的隔离回归。
 * 只替换浏览器设备、React 钩子和本地转写；不打开麦克风、不联网、不写用户目录。
 */
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { build } from 'esbuild'
import { isValidElement, type ReactNode } from 'react'
import * as captureModule from '../src/renderer/audio-capture.ts'
import { registerMeetingIpc } from '../src/main/meeting-recorder.ts'
import { MeetingStore } from '../src/main/meeting-store.ts'
import { CONSENT_BOTH, CONSENT_MIC, FAKE_KEY, constPcm, pushTrack, setupRecorder } from './meeting-fixtures.ts'

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/renderer/meeting-panel.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', './audio-capture.ts'],
})
const require = createRequire(import.meta.url)

interface Integrity {
  readonly status: 'pending' | 'complete' | 'incomplete' | 'unknown' | 'legacy'
  readonly reasons: readonly string[]
  readonly tracks?: Record<string, { sent: number | null; acknowledged: number | null; persisted: number | null }>
}
interface FlushReport {
  readonly tracks: Record<string, { sent: number | null; acknowledged: number | null }>
  readonly errors: readonly string[]
}
function integrity(row: unknown): Integrity | undefined {
  return (row as { integrity?: Integrity } | null)?.integrity
}
function textContent(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children)
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

class FakeTrack {
  stopped = false
  private listeners: Array<() => void> = []
  stop(): void { this.stopped = true }
  addEventListener(_type: string, listener: () => void): void { this.listeners.push(listener) }
  removeEventListener(_type: string, listener: () => void): void { this.listeners = this.listeners.filter(item => item !== listener) }
  end(): void { for (const listener of [...this.listeners]) listener() }
}

function panelFixture(options: {
  failure?: 'reject' | 'throw' | 'flush-reject' | 'flush-false' | 'flush-lie' | 'disk'
  slowOpen?: boolean
  slowLoop?: boolean
  failMicOpen?: boolean
  noLoopback?: boolean
  flushTimeoutMs?: number
  dir?: string
} = {}) {
  const h = setupRecorder({ flushTimeoutMs: options.flushTimeoutMs ?? 2000, ...(options.dir ? { dir: options.dir } : {}) })
  const mic = new FakeTrack()
  const loop = new FakeTrack()
  const opening = deferred<{ getTracks(): FakeTrack[] }>()
  const loopOpening = deferred<{ getTracks(): FakeTrack[]; getAudioTracks(): FakeTrack[]; getVideoTracks(): FakeTrack[]; removeTrack(): void }>()
  const flush = deferred<{ report: unknown; result: unknown }>()
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const oldAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext')
  let micProcessor: captureModule.ProcessorLike | null = null
  let loopProcessor: { onaudioprocess: ((event: unknown) => void) | null } | null = null
  let contextsClosed = 0
  let now = performance.now()
  // 主进程与渲染层使用同一模拟墙钟，避免有效音轨因“来自未来”被裁到零点。
  h.clock.set(Math.round(performance.timeOrigin + now))
  let loopTime = 4096 / 16000
  let sends = 0
  let loopOpens = 0
  let startHandler: ((payload: unknown) => void) | undefined
  let stopHandler: ((payload: unknown) => void) | undefined
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  registerMeetingIpc({ ipc: { handle: (name, handler) => { handlers.set(name, handler) } }, recorder: h.recorder })
  const invoke = async (name: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(name)
    assert.ok(handler, `主进程没有注册 ${name}`)
    return await handler({}, ...args)
  }
  const capture = new captureModule.AudioCaptureService({
    getUserMedia: () => options.failMicOpen ? Promise.reject(new Error('模拟麦克风权限被拒'))
      : options.slowOpen ? opening.promise : Promise.resolve({ getTracks: () => [mic] }),
    createContext: () => {
      let first = true
      return {
        sampleRate: 16000, destination: {},
        createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
        createScriptProcessor: () => {
          const node: captureModule.ProcessorLike = { onaudioprocess: null, connect() {}, disconnect() {} }
          if (first) micProcessor = node
          first = false
          return node
        },
        close: async () => { contextsClosed++ },
      }
    },
    now: () => now,
    setTimeout: () => 1,
    clearTimeout() {},
  })
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: class {
      readonly sampleRate = 16000
      readonly currentTime = 0
      readonly destination = {}
      createMediaStreamSource() { return { connect() {}, disconnect() {} } }
      createScriptProcessor(size: number) {
        const node = { onaudioprocess: null as ((event: unknown) => void) | null, connect() {}, disconnect() {} }
        if (size === 4096) loopProcessor = node
        return node
      }
      async close() { contextsClosed++ }
    },
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: {
      getUserMedia: async () => { throw new Error('测试不得访问真实媒体设备') },
      getDisplayMedia: async () => {
        loopOpens++
        if (options.slowLoop) return loopOpening.promise
        return { getTracks: () => options.noLoopback ? [] : [loop], getAudioTracks: () => options.noLoopback ? [] : [loop], getVideoTracks: () => [], removeTrack() {} }
      },
    } },
  })
  const originalAppend = h.store.appendChunk.bind(h.store)
  if (options.failure === 'disk') {
    h.store.appendChunk = (...args) => {
      if (sends === 2) throw new Error('模拟加密块落盘失败')
      return originalAppend(...args)
    }
  }
  const api = {
    meetingState: async () => h.recorder.getState(),
    meetingSpeakers: async (id: string) => h.recorder.getSpeakers(id),
    meetingMinutes: async (id: string) => h.recorder.getMinutes(id),
    meetingTakeCommand: async () => null,
    onMeetingCommand: () => () => {},
    onMeetingState() {},
    onMeetingStarted: (callback: (payload: unknown) => void) => { startHandler = callback },
    onMeetingStopping: (callback: (payload: unknown) => void) => { stopHandler = callback },
    meetingLoopbackCapability: async () => ({ available: true, reason: null }),
    meetingTrackMissing: (id: string, track: string, reason?: string) => invoke('meeting-track-missing', id, track, reason),
    meetingChunk: async (id: string, pcm: string, meta: unknown) => {
      sends++
      if (sends === 1 && (options.failure === 'reject' || options.failure === 'flush-lie')) return { ok: false, error: '模拟接收端拒块' }
      if (sends === 1 && options.failure === 'throw') throw new Error('模拟 IPC 断开')
      return invoke('meeting-chunk', id, pcm, meta)
    },
    meetingFlushDone: async (id: string, report?: unknown) => {
      if (options.failure === 'flush-lie') {
        const result = { ok: true }
        flush.resolve({ report, result })
        return result
      }
      if (options.failure === 'flush-reject') {
        flush.resolve({ report, result: { ok: false, error: '模拟冲刷 IPC 异常' } })
        throw new Error('模拟冲刷 IPC 异常')
      }
      if (options.failure === 'flush-false') {
        const result = { ok: false, error: '模拟冲刷拒绝' }
        flush.resolve({ report, result })
        return result
      }
      const result = await invoke('meeting-flush-done', id, report)
      flush.resolve({ report, result })
      return result
    },
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { petApi: api, setTimeout, clearTimeout },
  })
  const effects: Array<() => void> = []
  const slots: unknown[] = []
  let cursor = 0
  let tree: ReactNode
  const hooks = {
    useState<T>(value: T | (() => T)) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof value === 'function' ? (value as () => T)() : value
      return [slots[index], (next: T | ((previous: T) => T)) => {
        slots[index] = typeof next === 'function' ? (next as (previous: T) => T)(slots[index] as T) : next
      }]
    },
    useRef<T>(value: T) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: value }
      return slots[index]
    },
    useCallback<T>(fn: T) { cursor++; return fn },
    useEffect(fn: () => void) {
      const index = cursor++
      if (!(index in slots)) { slots[index] = true; effects.push(fn) }
    },
  }
  const component = { exports: {} as { default: (props: object) => ReactNode } }
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (name: string) => name === 'react' ? hooks
      : name === './audio-capture.ts' ? { ...captureModule, sharedCapture: () => capture }
        : require(name),
    component, component.exports,
  )
  function render(): void {
    cursor = 0
    tree = component.exports.default({})
    effects.splice(0).forEach(effect => effect())
  }
  render()
  return {
    h, mic, loop, capture, flush,
    render,
    text: () => textContent(tree),
    get contextsClosed() { return contextsClosed },
    get loopOpens() { return loopOpens },
    async start(both = false, wait = true) {
      const result = h.recorder.startMeeting(both ? CONSENT_BOTH : CONSENT_MIC)
      if (!result.ok) throw new Error(result.error)
      capture.setGrants({ meetingId: result.meetingId })
      const event = h.events.find(item => item.channel === 'meeting-started')
      assert.ok(startHandler && event)
      startHandler(event.payload)
      if (wait) { await nextTurn(); await nextTurn() }
      return result.meetingId
    },
    releaseOpen() { opening.resolve({ getTracks: () => [mic] }) },
    releaseLoop() { loopOpening.resolve({ getTracks: () => [loop], getAudioTracks: () => [loop], getVideoTracks: () => [], removeTrack() {} }) },
    pumpMic(samples = 64000) {
      now += samples / 16
      h.clock.advance(samples / 16)
      const node = micProcessor as captureModule.ProcessorLike | null
      assert.ok(node?.onaudioprocess, '测试麦克风应已订阅')
      node.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(samples).fill(0.1) } })
    },
    pumpLoop(samples = 64000) {
      const node = loopProcessor as { onaudioprocess: ((event: unknown) => void) | null } | null
      assert.ok(node?.onaudioprocess, '测试回环应已连接')
      node.onaudioprocess({ playbackTime: loopTime, inputBuffer: { getChannelData: () => new Float32Array(samples).fill(0.2) } })
      loopTime += samples / 16000
    },
    advanceLoop(seconds: number) { loopTime += seconds },
    stop(id: string) {
      assert.equal(h.recorder.requestStop(id).ok, true)
      assert.ok(stopHandler)
      stopHandler({ meetingId: id })
    },
    async dispose() {
      capture.stopAll()
      await h.recorder.close()
      for (const [name, descriptor] of [['window', oldWindow], ['navigator', oldNavigator], ['AudioContext', oldAudioContext]] as const) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
}

test('单轨和双轨正常停止时，渲染层末块回执与加密存储逐轨一致', async () => {
  for (const both of [false, true]) {
    const f = panelFixture()
    try {
      const id = await f.start(both)
      f.pumpMic()
      if (both) f.pumpLoop()
      await nextTurn()
      f.pumpMic(1600)
      if (both) f.pumpLoop(1600)
      f.stop(id)
      const { report, result } = await f.flush.promise
      assert.equal((result as { ok: boolean }).ok, true, JSON.stringify(result))
      const receipt = report as FlushReport
      assert.deepEqual(receipt.errors, [])
      assert.deepEqual(receipt.tracks.mic, { sent: 1, acknowledged: 1 })
      if (both) assert.deepEqual(receipt.tracks.loopback, { sent: 1, acknowledged: 1 })
      const stored = integrity(f.h.store.getMeeting(id))
      assert.equal(stored?.status, 'complete')
      assert.equal(stored?.tracks?.mic.persisted, 1)
      if (both) assert.equal(stored?.tracks?.loopback.persisted, 1)
      assert.equal(f.h.store.readAllChunks(id).corrupted.length, 0)
      assert.equal(f.capture.snapshot().consumers.length, 0)
      if (both) assert.equal(f.loop.stopped, true)
    } finally { await f.dispose() }
  }
})

for (const failure of ['reject', 'throw', 'disk'] as const) {
  test(`渲染层${failure}失败被冲刷报告和持久记录保留，已成功的块不删除`, async () => {
    const f = panelFixture({ failure })
    try {
      const id = await f.start()
      f.pumpMic()
      await nextTurn()
      f.pumpMic(1600)
      f.stop(id)
      const { report, result } = await f.flush.promise
      assert.equal((result as { ok: boolean }).ok, false, '不能把失败回报为完整成功')
      await nextTurn()
      f.render()
      assert.match(f.text(), /不完整|未知|未确认|发送异常/u, '页面必须展示真实的冲刷失败')
      assert.ok((report as FlushReport).errors.length > 0, '渲染层必须报告拒块或异常')
      assert.equal(integrity(f.h.store.getMeeting(id))?.status, 'incomplete')
      assert.ok(f.h.store.listChunks(id).length > 0, '仍然保留成功写入的录音块')
      assert.equal(f.h.recorder.exportMinutes(id).ok, false, '不完整录音不得自动交付完整纪要')
      const generated = await f.h.recorder.generateModelMinutes(id, { userInitiated: true })
      assert.equal(generated.ok, false)
      if (!generated.ok) assert.equal(generated.sent, false, '不完整录音不能自动发送到模型')
      const reopened = new MeetingStore(f.h.dir, { keyProvider: () => ({ status: 'ok', key: FAKE_KEY }) })
      try { assert.equal(integrity(reopened.getMeeting(id))?.status, 'incomplete') } finally { reopened.close() }
    } finally { await f.dispose() }
  })
}

test('录制期间接收端拒块时，页面立即显示错误而不是等到停录', async () => {
  const f = panelFixture({ failure: 'reject' })
  try {
    const id = await f.start()
    f.pumpMic()
    await nextTurn()
    f.render()
    const whileRecording = f.text()
    f.stop(id)
    await f.flush.promise
    assert.match(whileRecording, /录音不完整.*未确认/u)
  } finally { await f.dispose() }
})

test('持久化的失败原因随会议数据加密，重启可读但数据库中不泄露原文', async () => {
  const f = panelFixture({ failure: 'throw' })
  try {
    const id = await f.start()
    f.pumpMic()
    await nextTurn()
    f.pumpMic(1600)
    f.stop(id)
    await f.flush.promise
    const db = new DatabaseSync(path.join(f.h.dir, 'meetings.sqlite'))
    try {
      const row = db.prepare('SELECT integrity FROM meetings WHERE id = ?').get(id) as { integrity: string }
      assert.match(row.integrity, /^enc:v1:/u)
      assert.equal(row.integrity.includes('模拟 IPC 断开'), false)
    } finally { db.close() }
    const reopened = new MeetingStore(f.h.dir, { keyProvider: () => ({ status: 'ok', key: FAKE_KEY }) })
    try { assert.equal(integrity(reopened.getMeeting(id))?.status, 'incomplete') } finally { reopened.close() }
  } finally { await f.dispose() }
})

test('未收到冲刷回执时超时释放，但重启后仍显示未知且保存已有录音', async () => {
  const h = setupRecorder({ flushTimeoutMs: 20 })
  const started = h.recorder.startMeeting(CONSENT_MIC)
  assert.equal(started.ok, true)
  if (!started.ok) return
  const id = started.meetingId
  assert.equal(pushTrack(h, id, 'mic', 0, 0, constPcm(100, 3000)).ok, true)
  assert.equal(h.recorder.requestStop(id).ok, true)
  await delay(80)
  await h.recorder.whenSettled()
  assert.equal(integrity(h.store.getMeeting(id))?.status, 'unknown')
  assert.equal(h.store.listChunks(id).length, 1)
  assert.equal(h.recorder.exportMinutes(id).ok, false)
  await h.recorder.close()
  const reopened = setupRecorder({ dir: h.dir })
  try {
    assert.equal(integrity(reopened.store.getMeeting(id))?.status, 'unknown')
    assert.equal(reopened.store.listChunks(id).length, 1)
    const state = reopened.recorder.getState() as unknown as { recent: Array<{ integrity?: Integrity }> }
    assert.equal(state.recent.find(item => item.integrity?.status === 'unknown')?.integrity?.status, 'unknown')
  } finally { await reopened.recorder.close() }
})

test('缺少系统回环时保留麦克风录音并持久标记不完整', async () => {
  const f = panelFixture({ noLoopback: true })
  try {
    const id = await f.start(true)
    f.pumpMic()
    await nextTurn()
    f.stop(id)
    const { result } = await f.flush.promise
    assert.equal((result as { ok: boolean }).ok, false)
    assert.equal(integrity(f.h.store.getMeeting(id))?.status, 'incomplete')
    assert.ok(integrity(f.h.store.getMeeting(id))?.reasons.some(reason => /loopback/u.test(reason)))
    assert.deepEqual(f.h.store.listChunks(id).map(chunk => chunk.track), ['mic'])
  } finally { await f.dispose() }
})

test('麦克风打开失败仍释放上下文并保留可见的缺轨结果', async () => {
  const f = panelFixture({ failMicOpen: true })
  try {
    const id = await f.start()
    f.stop(id)
    await f.flush.promise
    assert.equal(integrity(f.h.store.getMeeting(id))?.status, 'incomplete')
    assert.ok(integrity(f.h.store.getMeeting(id))?.reasons.some(reason => /mic|麦克风/u.test(reason)))
    assert.ok(f.contextsClosed > 0)
  } finally { await f.dispose() }
})

test('来源声明与实际落盘末序不一致时，主进程拒绝完整回执', async () => {
  const h = setupRecorder()
  try {
    const started = h.recorder.startMeeting(CONSENT_MIC)
    if (!started.ok) throw new Error(started.error)
    assert.equal(pushTrack(h, started.meetingId, 'mic', 0, 0, constPcm(100, 3000)).ok, true)
    assert.equal(h.recorder.requestStop(started.meetingId).ok, true)
    const result = await h.recorder.flushDone(started.meetingId, {
      tracks: { mic: { sent: 1, acknowledged: 1 } }, errors: [],
    })
    assert.equal(result.ok, false)
    const stored = integrity(h.store.getMeeting(started.meetingId))
    assert.equal(stored?.status, 'incomplete')
    assert.deepEqual(stored?.tracks?.mic, { sent: 1, acknowledged: 1, persisted: 0 })
    assert.equal(h.store.listChunks(started.meetingId).length, 1)
  } finally { await h.recorder.close() }
})

test('主进程不能把有时间缺口的连续音频块标为完整', async () => {
  const h = setupRecorder()
  try {
    const started = h.recorder.startMeeting(CONSENT_MIC)
    if (!started.ok) throw new Error(started.error)
    const id = started.meetingId
    assert.equal(pushTrack(h, id, 'mic', 0, 0, constPcm(100, 3000)).ok, true)
    assert.equal(pushTrack(h, id, 'mic', 1, 1000, constPcm(100, 3000)).ok, true)
    assert.equal(h.store.listChunks(id)[0].sidecar?.gapAfterMs, 900)
    assert.equal(h.recorder.requestStop(id).ok, true)
    const result = await h.recorder.flushDone(id, {
      tracks: { mic: { sent: 1, acknowledged: 1 } }, errors: [],
    })
    assert.equal(result.ok, false, '音频块有时间缺口时不能确认完整')
    const saved = integrity(h.store.getMeeting(id))
    assert.equal(saved?.status, 'incomplete')
    assert.ok(saved?.reasons.some(reason => /mic.*缺口/u.test(reason)))
  } finally { await h.recorder.close() }
})

test('缺口标记丢失时仍按已保存时间轴检查录音完整性', async () => {
  const h = setupRecorder()
  try {
    const started = h.recorder.startMeeting(CONSENT_MIC)
    if (!started.ok) throw new Error(started.error)
    const id = started.meetingId
    assert.equal(pushTrack(h, id, 'mic', 0, 0, constPcm(100, 3000)).ok, true)
    assert.equal(pushTrack(h, id, 'mic', 1, 1000, constPcm(100, 3000)).ok, true)
    const sidecar = h.store.listChunks(id)[0].sidecar!
    assert.equal(sidecar.gapAfterMs, 900)
    writeFileSync(path.join(h.store.meetingDir(id), 'chunk-0.json'), JSON.stringify({ ...sidecar, gapAfterMs: null }))
    assert.equal(h.recorder.requestStop(id).ok, true)
    const result = await h.recorder.flushDone(id, {
      tracks: { mic: { sent: 1, acknowledged: 1 } }, errors: [],
    })
    assert.equal(result.ok, false)
    assert.ok(integrity(h.store.getMeeting(id))?.reasons.some(reason => /mic.*缺口/u.test(reason)))
  } finally { await h.recorder.close() }
})

test('旧式不带末块回执的调用仍可停止，但结果是未知而非完整', async () => {
  const h = setupRecorder()
  try {
    const started = h.recorder.startMeeting(CONSENT_MIC)
    if (!started.ok) throw new Error(started.error)
    assert.equal(pushTrack(h, started.meetingId, 'mic', 0, 0, constPcm(100, 3000)).ok, true)
    assert.equal(h.recorder.requestStop(started.meetingId).ok, true)
    const result = await h.recorder.flushDone(started.meetingId)
    assert.equal(result.ok, true, '旧调用仍可结束录制')
    assert.equal(integrity(h.store.getMeeting(started.meetingId))?.status, 'unknown')
    assert.equal(h.recorder.exportMinutes(started.meetingId).ok, false)
  } finally { await h.recorder.close() }
})

test('录制进程中断后重建录制器，未完成会议变为未知而不丢已保存块', async () => {
  const h = setupRecorder()
  const started = h.recorder.startMeeting(CONSENT_MIC)
  if (!started.ok) throw new Error(started.error)
  assert.equal(pushTrack(h, started.meetingId, 'mic', 0, 0, constPcm(100, 3000)).ok, true)
  h.store.close() // 模拟进程崩溃：不调用录制器收尾。
  const reopened = setupRecorder({ dir: h.dir })
  try {
    assert.equal(integrity(reopened.store.getMeeting(started.meetingId))?.status, 'unknown')
    assert.equal(reopened.store.listChunks(started.meetingId).length, 1)
    assert.equal(reopened.recorder.getState().recent[0].integrity?.status, 'unknown')
    assert.equal(reopened.recorder.exportMinutes(started.meetingId).ok, false)
  } finally { await reopened.recorder.close() }
})

test('不完整录音重启后在真实会议页面继续显示错误', async () => {
  const first = panelFixture({ failure: 'throw' })
  let id = ''
  try {
    id = await first.start()
    first.pumpMic()
    await nextTurn()
    first.pumpMic(1600)
    first.stop(id)
    await first.flush.promise
  } finally { await first.dispose() }
  const reopened = panelFixture({ dir: first.h.dir })
  try {
    await nextTurn()
    reopened.render()
    assert.match(reopened.text(), /录音不完整或停止结果未知/u)
    assert.match(reopened.text(), /发送异常/u)
    assert.equal(reopened.h.recorder.getState().lastMeetingId, id)
  } finally { await reopened.dispose() }
})

test('停止状态落盘失败时仍释放设备，重启不能把 pending 冒充完整', async () => {
  const f = panelFixture()
  let id = ''
  try {
    id = await f.start()
    f.pumpMic()
    await nextTurn()
    f.h.store.finishRecording = () => { throw new Error('模拟停止状态落盘失败') }
    f.stop(id)
    const { result } = await f.flush.promise
    assert.equal((result as { ok: boolean }).ok, false)
    assert.equal(f.h.recorder.getRecordingIntegrity(id)?.status, 'unknown')
    assert.equal(f.capture.snapshot().consumers.length, 0)
    assert.equal(f.h.store.listChunks(id).length, 1)
  } finally { await f.dispose() }
  const reopened = setupRecorder({ dir: f.h.dir })
  try {
    assert.equal(integrity(reopened.store.getMeeting(id))?.status, 'unknown')
    assert.equal(reopened.store.listChunks(id).length, 1)
  } finally { await reopened.recorder.close() }
})

test('部分落盘失败后的下一块不得覆盖未登记的加密录音', async () => {
  const h = setupRecorder()
  try {
    const started = h.recorder.startMeeting(CONSENT_MIC)
    if (!started.ok) throw new Error(started.error)
    const dir = h.store.meetingDir(started.meetingId)
    const nonce = Buffer.alloc(12, 1)
    const cipher = createCipheriv('aes-256-gcm', FAKE_KEY, nonce)
    const orphan = Buffer.concat([nonce, cipher.update(constPcm(100, 3000)), cipher.final(), cipher.getAuthTag()])
    const orphanPath = path.join(dir, 'chunk-0.enc')
    // 模拟上次写完密文、写 sidecar 时中断，数据库还没有登记该块。
    writeFileSync(orphanPath, orphan)
    mkdirSync(path.join(dir, 'chunk-0.json.tmp'))
    assert.equal(pushTrack(h, started.meetingId, 'mic', 1, 100, constPcm(100, 6000)).ok, true)
    assert.deepEqual(readFileSync(orphanPath), orphan, '未登记的第一块密文必须原样保留')
    assert.deepEqual(h.store.listChunks(started.meetingId).map(chunk => chunk.seq), [1])
  } finally { await h.recorder.close() }
})

test('设备断开时保留残块并标记缺轨，不能算完整', async () => {
  const f = panelFixture()
  try {
    const id = await f.start()
    f.pumpMic(1600)
    f.mic.end()
    await nextTurn()
    f.stop(id)
    await f.flush.promise
    assert.equal(integrity(f.h.store.getMeeting(id))?.status, 'incomplete')
    assert.equal(f.h.store.listChunks(id).length, 1, '中断前的残块仍应落盘')
    assert.ok(integrity(f.h.store.getMeeting(id))?.reasons.some(reason => /中断|结束|缺失/u.test(reason)))
  } finally { await f.dispose() }
})

test('设备重开产生真实采集缺口时，虽继续收帧也不能标完整', async () => {
  const f = panelFixture()
  try {
    const id = await f.start()
    f.pumpMic(1600)
    f.capture.handleResume()
    await nextTurn()
    await nextTurn()
    f.pumpMic(1600)
    f.stop(id)
    await f.flush.promise
    const stored = integrity(f.h.store.getMeeting(id))
    assert.equal(stored?.status, 'incomplete')
    assert.ok(stored?.reasons.some(reason => /缺口|中断|断流/u.test(reason)))
    assert.ok(f.h.store.listChunks(id).length > 0)
  } finally { await f.dispose() }
})

test('音轨回调长时间停止且未恢复时，停录不能把尾部缺口算成完整', async () => {
  const f = panelFixture()
  try {
    const id = await f.start()
    f.pumpMic(1600)
    await delay(1700)
    f.stop(id)
    await f.flush.promise
    const stored = integrity(f.h.store.getMeeting(id))
    assert.equal(stored?.status, 'incomplete')
    assert.ok(stored?.reasons.some(reason => /缺口|中断|断流/u.test(reason)))
    assert.equal(f.h.store.listChunks(id).length, 1)
  } finally { await f.dispose() }
})

test('系统回环时钟出现缺口时，双轨录音不能标完整', async () => {
  const f = panelFixture()
  try {
    const id = await f.start(true)
    f.pumpMic(1600)
    f.pumpLoop(1600)
    f.advanceLoop(2)
    f.pumpLoop(1600)
    f.stop(id)
    await f.flush.promise
    assert.equal(integrity(f.h.store.getMeeting(id))?.status, 'incomplete')
    assert.ok(integrity(f.h.store.getMeeting(id))?.reasons.some(reason => /loopback.*缺口/u.test(reason)))
  } finally { await f.dispose() }
})

test('开轨过程中收到停止，设备打开后立即释放并报告未完成', async () => {
  const f = panelFixture({ slowOpen: true, flushTimeoutMs: 1000 })
  try {
    const id = await f.start(false, false)
    await nextTurn()
    f.stop(id)
    f.releaseOpen()
    await f.flush.promise
    assert.equal(integrity(f.h.store.getMeeting(id))?.status, 'incomplete')
    assert.equal(f.capture.snapshot().consumers.length, 0)
  } finally { await f.dispose() }
})

test('停止超时后设备才打开时，迟到采集句柄仍被释放且结果保持未知', async () => {
  const f = panelFixture({ slowOpen: true, flushTimeoutMs: 20 })
  try {
    const id = await f.start(false, false)
    await nextTurn()
    f.stop(id)
    await delay(80)
    await f.h.recorder.whenSettled()
    assert.equal(integrity(f.h.store.getMeeting(id))?.status, 'unknown')
    f.releaseOpen()
    const { result } = await f.flush.promise
    assert.equal((result as { ok: boolean }).ok, false)
    assert.equal(f.capture.snapshot().consumers.length, 0)
    assert.equal(integrity(f.h.store.getMeeting(id))?.status, 'unknown')
  } finally { await f.dispose() }
})

test('麦克风开轨期间停止后，不得再启动系统回环采集', async () => {
  const f = panelFixture({ slowOpen: true, flushTimeoutMs: 2000 })
  try {
    const id = await f.start(true, false)
    await nextTurn()
    f.stop(id)
    f.releaseOpen()
    await f.flush.promise
    assert.equal(f.loopOpens, 0, '用户停止后不能再申请新的系统音轨')
    assert.equal(f.capture.snapshot().consumers.length, 0)
    assert.equal(integrity(f.h.store.getMeeting(id))?.status, 'incomplete')
  } finally { await f.dispose() }
})

test('回环开轨尚未返回时停止，已打开的麦克风立即退订，迟到音轨关闭', async () => {
  const f = panelFixture({ slowLoop: true, flushTimeoutMs: 2000 })
  try {
    const id = await f.start(true, false)
    await nextTurn()
    await nextTurn()
    assert.equal(f.loopOpens, 1)
    assert.deepEqual(f.capture.snapshot().consumers, ['meeting'])
    f.stop(id)
    const consumersAtStop = f.capture.snapshot().consumers
    const closedAtStop = f.contextsClosed
    f.releaseLoop()
    await f.flush.promise
    assert.deepEqual(consumersAtStop, [], '停止时不能继续收麦克风，等回环返回')
    assert.ok(closedAtStop > 0, '停止时应立即关闭已打开的会议音频上下文')
    assert.equal(f.loop.stopped, true, '迟到的系统音轨必须立即关闭')
    assert.equal(integrity(f.h.store.getMeeting(id))?.status, 'incomplete')
  } finally { f.releaseLoop(); await f.dispose() }
})

for (const failure of ['flush-reject', 'flush-false'] as const) {
  test(`冲刷回执${failure}时由主进程超时标记未知且释放资源`, async () => {
    const f = panelFixture({ failure, flushTimeoutMs: 30 })
    try {
      const id = await f.start()
      f.pumpMic()
      await nextTurn()
      f.stop(id)
      await f.flush.promise
      await nextTurn()
      f.render()
      assert.match(f.text(), /冲刷.*异常|冲刷拒绝/u, '拒绝或异常必须显示给用户')
      await delay(80)
      await f.h.recorder.whenSettled()
      assert.equal(integrity(f.h.store.getMeeting(id))?.status, 'unknown')
      assert.equal(f.capture.snapshot().consumers.length, 0)
      assert.ok(f.contextsClosed > 0)
    } finally { await f.dispose() }
  })
}

test('旧主进程错误回报冲刷成功时，渲染层仍须展示自己检测到的拒块', async () => {
  const f = panelFixture({ failure: 'flush-lie', flushTimeoutMs: 30 })
  try {
    const id = await f.start()
    f.pumpMic()
    await nextTurn()
    f.stop(id)
    await f.flush.promise
    await nextTurn()
    f.render()
    assert.match(f.text(), /未确认|拒块|不完整/u)
    await delay(80)
    assert.equal(integrity(f.h.store.getMeeting(id))?.status, 'unknown')
  } finally { await f.dispose() }
})

test('没有采集句柄时即使旧主进程回报成功，页面也要提示停止结果未知', async () => {
  const f = panelFixture({ failure: 'flush-lie', flushTimeoutMs: 30 })
  try {
    const started = f.h.recorder.startMeeting(CONSENT_MIC)
    if (!started.ok) throw new Error(started.error)
    // 模拟渲染层重建后找不到原来的采集句柄。
    f.stop(started.meetingId)
    await f.flush.promise
    await nextTurn()
    f.render()
    assert.match(f.text(), /没有可停止|不完整|停止结果未知/u)
  } finally { await f.dispose() }
})
