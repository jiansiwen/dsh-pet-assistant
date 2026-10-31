/**
 * 文档 IPC 集成测试：沿用 desktop.e2e.test.ts 的 Electron 模块替身装配真实主进程。
 * 文档读取、授权、指纹、提示词、讲解状态与播出回调均用生产实现。
 * 播放器替身只记录请求，继承真实 Narrator；用假音频传输手动确认完成，不复制状态机。
 * 桥接故意允许取消后迟到的回复，验证主进程不能只依赖传输取消来防止旧讲解复活。
 */
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import type { BridgeCallbacks, ChatReply } from '../src/main/harness.ts'
import type { InterruptLevel, SpeechRequest } from '../src/main/speech.ts'
import { Narrator, type NarratorHooks, type TtsTransport, type TtsWorkerEvent } from '../src/main/tts.ts'
import { AudioCaptureService, type CaptureDeps, type CaptureReceipt, type ProcessorLike } from '../src/renderer/audio-capture.ts'
import { installAudioBridge, type AudioBridgeApi, type AudioGrantsPayload } from '../src/renderer/barge-in.ts'
import type { DocRoots, DocState } from '../src/renderer/types.js'
import type { SessionCommand, SessionResult, SessionSnapshot, VoiceTurn, VoiceTurnCompletion } from '../src/session-types.ts'

/** tsconfig 的 lib 停在 ES2022，这里按 tts-edge-worker.test.ts 的写法自备一个延迟量。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

const sandbox = mkdtempSync(path.join(tmpdir(), 'dsh-document-ipc-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = path.join(sandbox, 'dsh-home')
// 只替换系统密钥包装边界；会议数据库与音频授权仍使用生产实现，且所有数据都在沙盒内。
mock.module('../src/main/dpapi.ts', {
  namedExports: {
    getDataKey: () => ({ status: 'ok', key: Buffer.alloc(32, 9) }),
    keyFilePath: (dir: string) => path.join(dir, 'meetings-key.bin'),
  },
})
const authorized = path.join(sandbox, 'authorized')
mkdirSync(authorized)
const documentPath = path.join(authorized, '讲解样本.txt')
const outsidePath = path.join(sandbox, '未授权样本.txt')
const paragraphs = ['第一段原文：授权范围只包含所选目录。', '第二段原文：缓存根据内容摘要失效。', '第三段原文：播出完成才推进位置。']
const explanation = '先说明授权范围。再解释目录边界。最后补充撤销方式。'
writeFileSync(outsidePath, '这份文档没有获得授权。', 'utf8')

const chatEvents = new EventEmitter()
const uiEvents = new EventEmitter()
let fakeMeetingTranscription = false
let confirmMeetingPresentation: () => Promise<{ response: number }> = async () => ({ response: 1 })
let claimDesktopCommand: () => Promise<{ status: number; body: unknown }> = async () => ({ status: 200, body: { claimed: true } })
const meetingPresentationDialogs: Array<Record<string, unknown>> = []
const session: SessionSnapshot = {
  sessionId: '测试会话', bindingId: '测试绑定', cursor: 0, title: '入口回归', status: 'idle', entries: [], hasMore: false,
  model: null, models: [], permission: null, permissions: [],
  capabilities: { prompt: true, cancel: true, models: false, permissions: false, history: true },
}
let bridgeCallbacks: BridgeCallbacks
const sessionCommands: SessionCommand[] = []
const desktopReplies: Array<{ id: string; ok: boolean; result?: unknown; error?: string }> = []
const chats: Array<{
  text: string
  assistantId?: string
  signal?: AbortSignal
  onDelta?: (text: string) => void
  bindingId?: string
  resolve: (reply: ChatReply) => void
}> = []
class FakeBridge {
  async connect(callbacks: BridgeCallbacks): Promise<void> {
    bridgeCallbacks = callbacks
    callbacks.onStatus('connected')
    callbacks.onEvent?.({ type: 'session/update', payload: { ...session } })
  }
  async getSession(): Promise<SessionResult> { return { ok: true, state: { ...session } } }
  async sessionCommand(command: SessionCommand): Promise<SessionResult> {
    sessionCommands.push(command)
    return { ok: true }
  }
  chat(text: string, assistantId?: string, signal?: AbortSignal, onDelta?: (text: string) => void, bindingId?: string): Promise<ChatReply> {
    const deferredReply = deferred<ChatReply>()
    chats.push({ text, assistantId, signal, onDelta, bindingId, resolve: deferredReply.resolve })
    chatEvents.emit('chat')
    return deferredReply.promise
  }
  async reportPetState(): Promise<void> {}
  async companionRequest(_method: string, route: string, body: { id: string; ok?: boolean; result?: unknown; error?: string }): Promise<{ status: number; body: unknown }> {
    if (route === '/companion/v1/desktop/claim') return claimDesktopCommand()
    desktopReplies.push(body as { id: string; ok: boolean; result?: unknown; error?: string })
    return { status: 200, body: {} }
  }
  // 提醒投递定时器每 3 秒轮询一次；文档测试没有普通任务库，永远领不到东西。
  async nextDesktopReminder(): Promise<null> { return null }
  async claimDesktopReminder(): Promise<boolean> { return false }
  async receiptDesktopReminder(): Promise<void> {}
  async desktopMailNotices(): Promise<null> { return null }
  async claimDesktopMailNotice(): Promise<null> { return null }
  async receiptDesktopMailNotice(): Promise<boolean> { return false }
  get connected(): boolean { return true }
  async startSession(): Promise<{ ok: true; outcome: string; owned: boolean }> {
    sessionStarts += 1
    bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, bindingId: '桌面开启绑定', reset: true } })
    return { ok: true, outcome: 'created', owned: true }
  }
  dispose(): void {
    for (const chat of chats) chat.resolve({ ok: false, error: '测试已结束' })
  }
}
let sessionStarts = 0
mock.module('../src/main/harness.ts', {
  namedExports: {
    BridgeClient: FakeBridge,
    readBridgeInfo: () => null,
    probeHealth: () => { throw new Error('文档测试不得连接真实运行时') },
  },
})
const wpsOpens: string[] = []
mock.module('../src/main/wps-control.ts', {
  namedExports: {
    // 端到端不得拉起真实 WPS 辅助脚本：替身一律报"未安装"，只记录被要求打开的真实路径。
    createWpsController: () => ({
      platform: 'win32', unverifiedOnDevice: false,
      open: async (file: string) => {
        wpsOpens.push(file)
        return { ok: false, error: { code: 'not-installed', message: '未安装 WPS', guidance: '请先安装 WPS' }, evidence: {} }
      },
      syncTo: async () => { throw new Error('未打开时不得同步') },
      status: async () => { throw new Error('未打开时不得查询') },
      dispose() {},
    }),
  },
})
mock.module('../src/main/wake.ts', {
  namedExports: { startWakeListener: () => {}, stopWakeListener: () => {} },
})
// 会议命令会打开设置页；隔离测试不能借此启动真实全局鼠标监听。
mock.module('../src/main/pointer-watch.ts', {
  namedExports: { PointerWatcher: class { setEnabled(): void {} dispose(): void {} } },
})
mock.module('../src/main/asr.ts', {
  namedExports: {
    createStreamingSession: () => { throw new Error('隔离测试不得加载真实识别模型') },
    pcm16Base64ToFloat32: () => new Float32Array(0),
    streamingAvailable: () => false,
    transcribeWav: async () => fakeMeetingTranscription ? { ok: true, text: '测试会议转写' } : { ok: false, error: '隔离测试不调用识别模型' },
    warmSenseVoiceAsr: () => false,
    warmStreamingAsr: () => false,
  },
})
// 桌面装配会预热固定话术；这两处必须隔离，不能在测试时联网或启动真实播放器。
mock.module('../src/main/edge-tts.ts', {
  namedExports: {
    DEFAULT_TTS_VOICE: 'zh-CN-XiaoxiaoNeural',
    synthesizeSpeech: async () => Buffer.from('隔离语音'),
  },
})
mock.module('../src/main/play-host.ts', {
  namedExports: {
    PlayHost: class {
      async start(): Promise<boolean> { return true }
      async waitReady(): Promise<boolean> { return true }
      isReady(): boolean { return true }
      play(): null { return null }
      stop(): void {}
    },
  },
})

let deliver: (event: TtsWorkerEvent) => void
let playing: { id: string; b64: string } | null = null
const audioCommands: Array<{ speak?: { id: string; b64: string }; stop?: object }> = []
function fakeAudio(opened: (event: TtsWorkerEvent) => void): TtsTransport {
  deliver = opened
  queueMicrotask(() => opened({ ready: true }))
  return {
    write(line) {
      const command = JSON.parse(line) as (typeof audioCommands)[number]
      audioCommands.push(command)
      if (command.speak) {
        assert.equal(playing, null, '不能同时派发两句音频')
        playing = command.speak
      } else if (command.stop) {
        const id = playing?.id ?? ''
        playing = null
        // 与进程管道一样异步确认，不能在 Narrator.apply 尚未收尾时重入。
        queueMicrotask(() => opened({ cancelled: { id } }))
      }
    },
    close() { playing = null },
  }
}
let narrator: FakeNarrator
class FakeNarrator extends Narrator {
  requests: SpeechRequest[] = []
  interrupts: InterruptLevel[] = []
  callbacks: NarratorHooks
  constructor(open: typeof fakeAudio, hooks: NarratorHooks) {
    super(open, hooks)
    this.callbacks = hooks
    narrator = this
  }
  override speak(request: SpeechRequest): void {
    this.requests.push(request)
    super.speak(request)
  }
  override interrupt(level: InterruptLevel): void {
    this.interrupts.push(level)
    super.interrupt(level)
  }
}
mock.module('../src/main/tts.ts', {
  namedExports: { Narrator: FakeNarrator, spawnTtsEdgeWorker: fakeAudio },
})

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const ipcListeners = new Map<string, (...args: unknown[]) => void>()
const appHandlers = new Map<string, (event: { preventDefault(): void }) => void>()
const messages: Array<{ channel: string; payload: unknown }> = []
let audioGrantsListener: ((grants: AudioGrantsPayload) => void) | null = null
const quit = deferred<void>()
let windows = 0
let stage: FakeBrowserWindow
class FakeBrowserWindow {
  webContents = {
    mainFrame: {},
    send(channel: string, payload: unknown) {
      messages.push({ channel, payload })
      uiEvents.emit('message')
      if (channel === 'audio-grants') audioGrantsListener?.(payload as AudioGrantsPayload)
    },
    on() {},
    setWindowOpenHandler() {},
  }
  constructor() { windows++; stage = this }
  show(): void {}
  focus(): void {}
  async loadFile(): Promise<void> {}
  setAlwaysOnTop(): void {}
  setVisibleOnAllWorkspaces(): void {}
  setIgnoreMouseEvents(): void {}
  isDestroyed(): boolean { return false }
  on(): void {}
}
class FakeTray {
  on(): void {}
  isDestroyed(): boolean { return false }
  setContextMenu(): void {}
  setToolTip(): void {}
  destroy(): void {}
}
mock.module('electron', {
  namedExports: {
    app: {
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      on: (event: string, handler: (event: { preventDefault(): void }) => void) => appHandlers.set(event, handler),
      quit: () => quit.resolve(),
      getPath: (name: string) => path.join(sandbox, `electron-${name}`),
      // macOS 上装配会调 app.dock.hide()。测试在任意平台跑，缺了就是 undefined 崩。
      dock: { hide: () => {} },
      // Windows 通知需要在装配时设置 AppUserModelId（32dc4d0 引入）。
      setAppUserModelId: () => {},
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle(channel: string, handler: (...args: unknown[]) => unknown) {
        assert.ok(!ipcHandlers.has(channel), `重复注册 ${channel}`)
        ipcHandlers.set(channel, handler)
      },
      on: (channel: string, handler: (...args: unknown[]) => void) => ipcListeners.set(channel, handler),
      removeHandler: (channel: string) => ipcHandlers.delete(channel),
      removeAllListeners: (channel: string) => ipcListeners.delete(channel),
    },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    // 提醒投递装配会构造系统通知；文档测试没有待投递提醒，但它不能因缺替身而整包导入失败。
    Notification: class {
      static isSupported(): boolean { return true }
      on(): void {}
      show(): void {}
    },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [authorized] }),
      showMessageBox: async (options: Record<string, unknown>) => { meetingPresentationDialogs.push(options); return confirmMeetingPresentation() } },
    globalShortcut: { register: () => true, unregisterAll() {} },
    Menu: { buildFromTemplate: () => ({ popup() {} }) },
    shell: {
      openPath: () => { throw new Error('文档测试不得打开外部应用') },
      openExternal: () => { throw new Error('文档测试不得打开浏览器') },
    },
    // 会议回环声的桌面采集授权（M4-03）：装配时注册一次。文档测试里没有会议在录，
    // 这个 handler 永远不该被调用，给了就报错。
    session: {
      defaultSession: {
        setDisplayMediaRequestHandler: () => {},
      },
    },
    desktopCapturer: {
      getSources: () => { throw new Error('文档测试不得抓屏') },
    },
    // 模型下载走 Electron 的 net.fetch；文档测试不联网，给了就报错。
    net: {
      fetch: () => { throw new Error('文档测试不得发起网络请求') },
    },
    nativeImage: {
      // resize 的结果要能接 setTemplateImage —— macOS 分支会把托盘图标标成单色蒙版。
      createFromPath: () => ({ resize: () => ({ setTemplateImage: () => {} }) }),
      createEmpty: () => ({ setTemplateImage: () => {} }),
    },
    Tray: FakeTray,
    // 装配时会问一次麦克风权限（macOS 上没声明用途说明会被系统直接终止进程）。
    // 文档测试不关心语音，给一个"已授权"的替身，避免弹系统对话框。
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess: async () => true,
    },
    // 系统密钥库替身：只加前缀就够验"落盘是密文、读回一致"，真加密归真机验。
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`enc:${value}`),
      decryptString: (value: Buffer) => {
        const text = value.toString('utf8')
        if (!text.startsWith('enc:')) throw new Error('解不开')
        return text.slice(4)
      },
    },
  },
})

async function invoke<T = ChatReply>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = ipcHandlers.get(channel)
  assert.ok(handler, `真实主进程未注册 ${channel}`)
  return await handler({ sender: stage.webContents, senderFrame: stage.webContents.mainFrame }, ...args) as T
}
function prompt(text: string, spoken = false): Promise<SessionResult & { reply?: string }> {
  return invoke('session-command', { kind: 'prompt', bindingId: session.bindingId, text, spoken })
}
function send(channel: string): void {
  const listener = ipcListeners.get(channel)
  assert.ok(listener, `真实主进程未注册 ${channel}`)
  listener({ sender: stage.webContents, senderFrame: stage.webContents.mainFrame })
}
function sent<T>(channel: string): T[] {
  return messages.filter(message => message.channel === channel).map(message => message.payload as T)
}
function outline(): Extract<DocState, { kind: 'outline' }> {
  const state = sent<DocState>('doc-state').at(-1)
  assert.equal(state?.kind, 'outline')
  return state as Extract<DocState, { kind: 'outline' }>
}
function assertProgress(next: number, completed: number[] = []): void {
  const state = outline()
  assert.equal(state.next, next)
  assert.deepEqual(state.sections.filter(section => section.spoken).map(section => section.index), completed)
}
async function chatAt(index: number): Promise<(typeof chats)[number]> {
  while (chats.length <= index) await once(chatEvents, 'chat', { signal: AbortSignal.timeout(2000) })
  return chats[index]
}
function finishSentence(): string {
  const current = playing
  assert.ok(current, '没有等待完成的音频句子')
  playing = null
  deliver({ finished: { id: current.id } })
  return Buffer.from(current.b64, 'base64').toString('utf8')
}
async function startExplanation(from = 0): Promise<(typeof chats)[number]> {
  const chatIndex = chats.length
  const result = await invoke('doc-explain', documentPath, from, true, '讲解助理')
  assert.equal(result.ok, true, result.error)
  assert.match(narrator.requests.at(-1)!.utteranceId, /^doc-outline:/)
  assert.equal(chats.length, chatIndex, '开场范围说明未播完，不能提前向模型请求正文')
  finishSentence()
  return chatAt(chatIndex)
}
async function answer(chat: (typeof chats)[number], text = explanation): Promise<void> {
  const before = messages.length
  chat.resolve({ ok: true, reply: text })
  await nextTurn()
  if (chat.text.includes('整份文档的段落提纲：') && !chat.signal?.aborted) {
    while (!chat.signal?.aborted && !messages.slice(before).some(item => item.channel === 'doc-reply' || item.channel === 'doc-notice')) {
      await once(uiEvents, 'message', { signal: AbortSignal.timeout(2000) })
    }
  }
}

before(async () => {
  await import('../src/main/index.ts')
  await nextTurn()
  assert.equal(windows, 1, '真实装配创建一个替身舞台，不加载真实宠物界面')
  assert.ok(narrator.callbacks.onSpoken, '使用真实主进程注册的播出记录回调')
})
beforeEach(async () => {
  writeFileSync(documentPath, paragraphs.join('\n\n'), 'utf8')
  const roots = await invoke<DocRoots>('doc-add-root')
  assert.ok(roots.roots.includes(authorized), '必须经过原生目录选择 IPC 授权临时文档')
  chats.length = 0
  sessionCommands.length = 0
  desktopReplies.length = 0
  // 每个用例切换一次会话绑定，清掉上个用例真实保留的插话上下文；同一用例内仍验证原有续讲语义。
  bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, bindingId: '测试隔离绑定' } })
  bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session } })
  messages.length = 0
  narrator.requests.length = 0
  narrator.interrupts.length = 0
  audioCommands.length = 0
  confirmMeetingPresentation = async () => ({ response: 1 })
  claimDesktopCommand = async () => ({ status: 200, body: { claimed: true } })
  meetingPresentationDialogs.length = 0
  fakeMeetingTranscription = false
})
afterEach(async () => {
  await prompt('结束讲解')
  for (const chat of chats) chat.resolve({ ok: false, error: '测试收尾' })
  await nextTurn()
  assert.equal(narrator.isSpeaking(), false)
  assert.equal(playing, null)
})
after(async () => {
  try {
    const close = appHandlers.get('before-quit')
    if (close) {
      close({ preventDefault() {} })
      await quit.promise
    }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(sandbox, { recursive: true, force: true })
    mock.restoreAll()
  }
})

/** 使用真实音频桥和共享采集，只把设备与浏览器计时器换成隔离替身。 */
function meetingAudioWiring() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext')
  const timers: Array<{ fn: () => void; ms: number }> = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length } },
  })
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: class {
      readonly currentTime = 0
      readonly destination = {}
      async decodeAudioData() { return { duration: 10 } }
      createBufferSource() { return { buffer: null, onended: null, connect() {}, disconnect() {}, start() {}, stop() {} } }
      createGain() { return { gain: { value: 1, setValueAtTime() {} }, connect() {}, disconnect() {} } }
      createScriptProcessor() { return { onaudioprocess: null, connect() {}, disconnect() {} } }
    },
  })
  let processor: ProcessorLike | null = null
  let opens = 0
  let stopped = 0
  let now = performance.now()
  const handovers: Array<() => import('../src/renderer/dictation.ts').DictationHandover | null> = []
  const deps: CaptureDeps = {
    getUserMedia: async () => {
      opens++
      return { getTracks: () => [{ stop: () => { stopped++ }, addEventListener() {}, removeEventListener() {} }] }
    },
    createContext: () => ({
      sampleRate: 16000, destination: {},
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      createScriptProcessor: () => {
        const node: ProcessorLike = { onaudioprocess: null, connect() {}, disconnect() {} }
        if (processor === null) processor = node
        return node
      },
      close: async () => {},
    }),
    now: () => now,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: () => {},
  }
  const capture = new AudioCaptureService(deps, { frameSize: 320 })
  const api: AudioBridgeApi = {
    onAudioGrants: callback => { audioGrantsListener = callback; return () => { audioGrantsListener = null } },
    audioSync: () => invoke<AudioGrantsPayload>('audio-sync'),
    kwsFeed() {}, audioConsumerLost() {},
    onCaptureResume: () => () => {},
    onTtsPlay: () => () => {}, onTtsStop: () => () => {},
    ttsPlaybackReceipt() {}, bargeInDetected: () => send('barge-in-detected'), bargeInMetrics() {},
  }
  const bridge = installAudioBridge(api, { onBargeIn: take => handovers.push(take) }, capture)
  return {
    capture,
    handovers,
    play: () => bridge.player.play('隔离播放', 'AAAA'),
    pump(level = 0.1) {
      now += 20
      processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(320).fill(level) } })
    },
    opens: () => opens,
    stopped: () => stopped,
    dispose() {
      bridge.dispose()
      capture.stopAll()
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
      if (previousAudioContext) Object.defineProperty(globalThis, 'AudioContext', previousAudioContext)
      else Reflect.deleteProperty(globalThis, 'AudioContext')
    },
  }
}

const meetingConsent = {
  name: '隔离会议', sources: 'mic', consented: true,
  consentText: '测试人员知晓隔离会议录音', retentionDays: 30,
}

async function finishAudioMeeting(meetingId: string): Promise<void> {
  // 空听写不会调用识别器；确保失败断言也不会把主进程的听写状态留给下一个测试。
  await invoke('asr-transcribe', '')
  const state = await invoke<{ meetingId: string | null }>('meeting-state')
  if (state.meetingId === meetingId) {
    await invoke('meeting-stop', meetingId)
    await invoke('meeting-flush-done', meetingId)
  }
}

test('会议播报时，真实授权经音频桥使会议与插话共享同一个采集设备', async () => {
  const wiring = meetingAudioWiring()
  let meetingId = ''
  try {
    await nextTurn()
    const started = await invoke<{ ok: boolean; meetingId: string; error?: string }>('meeting-start', meetingConsent)
    assert.equal(started.ok, true, started.error)
    meetingId = started.meetingId
    await wiring.capture.subscribe({ kind: 'meeting', token: meetingId, onFrame() {} })
    narrator.callbacks.onSpeaking!(true)
    await nextTurn()
    assert.equal(wiring.capture.isGranted('barge-in'), true, '会议插话状态必须真实下发给共享采集')
    assert.deepEqual(wiring.capture.snapshot().consumers.sort(), ['barge-in', 'meeting'])
    assert.equal(wiring.opens(), 1, '两种消费者不能各开一个麦克风')
    const lost = ipcListeners.get('audio-consumer-lost')!
    lost({ sender: stage.webContents, senderFrame: stage.webContents.mainFrame }, 'barge-in', '隔离设备中断')
    assert.deepEqual(wiring.capture.snapshot().consumers, ['meeting'], '插话故障只释放插话订阅')
    assert.equal(wiring.capture.isGranted('meeting', meetingId), true)
  } finally {
    if (meetingId) await finishAudioMeeting(meetingId)
    wiring.dispose()
  }
  assert.equal(wiring.stopped(), 1, '最后一个消费者退出后释放设备')
})

test('插话切换听写的真实 IPC 不撤销会议订阅，听写结束后会议继续收到帧', async () => {
  const wiring = meetingAudioWiring()
  const receipts: CaptureReceipt[] = []
  let meetingFrames = 0
  let meetingId = ''
  try {
    await nextTurn()
    const started = await invoke<{ ok: boolean; meetingId: string; error?: string }>('meeting-start', meetingConsent)
    assert.equal(started.ok, true, started.error)
    meetingId = started.meetingId
    await wiring.capture.subscribe({
      kind: 'meeting', token: meetingId, onFrame: () => { meetingFrames++ }, onEnd: receipt => receipts.push(receipt),
    })
    wiring.pump()
    narrator.callbacks.onSpeaking!(true)
    await nextTurn()
    await wiring.play()
    for (let i = 0; i < 40; i++) wiring.pump(0.01)
    for (let i = 0; i < 12 && wiring.handovers.length === 0; i++) wiring.pump(0.1)
    assert.equal(wiring.handovers.length, 1, '实际插话检测必须将交接通知主进程')
    const granted = await invoke<{ ok: boolean; error?: string }>('asr-begin', { bargeIn: true })
    assert.equal(granted.ok, true, granted.error)
    assert.equal(wiring.capture.isGranted('meeting', meetingId), true, '听写不能撤销会议令牌')
    assert.deepEqual(receipts, [], '会议订阅不能因为交接收到 revoked 回执')
    assert.equal(wiring.capture.isGranted('dictation'), true)
    const dictation = await wiring.capture.subscribe({ kind: 'dictation', onFrame() {} })
    assert.ok((wiring.handovers[0]()?.frames.length ?? 0) > 0, '听写应取得插话预滚动帧')
    wiring.pump()
    dictation.close()
    await invoke('asr-transcribe', '')
    wiring.pump()
    assert.ok(meetingFrames >= 53, '交接前、听写中及听写后都收到帧')
    assert.deepEqual(receipts, [])
  } finally {
    if (meetingId) await finishAudioMeeting(meetingId)
    wiring.dispose()
  }
})

test('会议停止时取消未交接插话，不能残留授权、订阅或预滚动', async () => {
  const wiring = meetingAudioWiring()
  let meetingId = ''
  try {
    await nextTurn()
    const started = await invoke<{ ok: boolean; meetingId: string; error?: string }>('meeting-start', meetingConsent)
    assert.equal(started.ok, true, started.error)
    meetingId = started.meetingId
    await wiring.capture.subscribe({ kind: 'meeting', token: meetingId, onFrame() {} })
    narrator.callbacks.onSpeaking!(true)
    await nextTurn()
    await wiring.play()
    for (let i = 0; i < 40; i++) wiring.pump(0.01)
    for (let i = 0; i < 12 && wiring.handovers.length === 0; i++) wiring.pump(0.1)
    assert.equal(wiring.handovers.length, 1, '应先真实检出一次插话')
    await invoke('meeting-stop', meetingId)
    await invoke('meeting-flush-done', meetingId)
    assert.equal(wiring.capture.isGranted('barge-in'), false)
    assert.deepEqual(wiring.capture.snapshot().consumers, [])
    assert.equal(wiring.handovers[0](), null, '撤权后不得交出已取消的预滚动')
  } finally {
    if (meetingId) await finishAudioMeeting(meetingId)
    wiring.dispose()
  }
})

test('听写取消发生在取走预滚动之前时，旧交接必须立即失效且会议继续', async () => {
  const wiring = meetingAudioWiring()
  let meetingId = ''
  try {
    await nextTurn()
    const started = await invoke<{ ok: boolean; meetingId: string; error?: string }>('meeting-start', meetingConsent)
    assert.equal(started.ok, true, started.error)
    meetingId = started.meetingId
    await wiring.capture.subscribe({ kind: 'meeting', token: meetingId, onFrame() {} })
    narrator.callbacks.onSpeaking!(true)
    await nextTurn()
    await wiring.play()
    for (let i = 0; i < 40; i++) wiring.pump(0.01)
    for (let i = 0; i < 12 && wiring.handovers.length === 0; i++) wiring.pump(0.1)
    assert.equal(wiring.handovers.length, 1)
    assert.equal((await invoke<{ ok: boolean }>('asr-begin', { bargeIn: true })).ok, true)
    await invoke('asr-transcribe', '')
    assert.equal(wiring.handovers[0]() === null, true, '已取消的听写不能再取出旧预滚动')
    assert.deepEqual(wiring.capture.snapshot().consumers, ['meeting'])
    assert.equal(wiring.capture.isGranted('meeting', meetingId), true)
  } finally {
    if (meetingId) await finishAudioMeeting(meetingId)
    wiring.dispose()
  }
})

test('会议插话交接超时只关闭插话，会议仍获授权且不打开唤醒', async () => {
  const wiring = meetingAudioWiring()
  let meetingId = ''
  try {
    await nextTurn()
    const started = await invoke<{ ok: boolean; meetingId: string; error?: string }>('meeting-start', meetingConsent)
    assert.equal(started.ok, true, started.error)
    meetingId = started.meetingId
    await wiring.capture.subscribe({ kind: 'meeting', token: meetingId, onFrame() {} })
    narrator.callbacks.onSpeaking!(true)
    await nextTurn()
    assert.equal(wiring.capture.isGranted('barge-in'), true)
    send('barge-in-detected')
    await new Promise(resolve => setTimeout(resolve, 4100))
    const grants = await invoke<AudioGrantsPayload>('audio-sync')
    assert.equal(grants.bargeIn, false, '超时后主进程必须撤回插话授权')
    assert.equal(grants.meetingId, meetingId)
    assert.equal(grants.kws, false)
    assert.deepEqual(wiring.capture.snapshot().consumers, ['meeting'])
  } finally {
    if (meetingId) await finishAudioMeeting(meetingId)
    wiring.dispose()
  }
})

test('文字复合委托保留原文与绑定，不能只执行本地文档动作', async () => {
  const wpsBefore = wpsOpens.length
  const requests = [
    '  先打开讲解样本，再发送到测试邮箱。  ',
    '讲完讲解样本以后，帮我设置一个提醒',
    '请先打开讲解样本并安装所需插件',
    '先查资料，再讲讲讲解样本',
    '先录音，然后讲讲讲解样本',
    '先开会，然后讲讲讲解样本',
    '帮我开个会，再讲讲讲解样本',
    '帮我把会议录下来，接着讲讲讲解样本',
    '念一遍讲解样本，再保存成新的 Word 文件',
    '先讲讲讲解样本，再关闭当前窗口',
  ]
  for (const text of requests) {
    const before = sessionCommands.length
    const result = await prompt(text)
    assert.equal(result.ok, true, result.error)
    assert.equal(sessionCommands.length, before + 1, `整句应进入会话：${text}`)
    assert.deepEqual(sessionCommands.at(-1), { kind: 'prompt', bindingId: session.bindingId, text, spoken: false })
  }
  assert.equal(chats.length, 0)
  assert.equal(sent<DocState>('doc-state').some(state => state.kind === 'outline'), false, '不能提前启动本地讲解')
  assert.equal(wpsOpens.length, wpsBefore)
})

test('录制中停录、纪要、外发和提醒的复合文字只原样交给会话，不提前执行单项', async () => {
  const started = await invoke<{ ok: boolean; meetingId: string; error?: string }>('meeting-start', meetingConsent)
  assert.equal(started.ok, true, started.error)
  try {
    const text = '停止会议录音并整理会议记录生成纪要，发送至测试邮箱，然后两分钟后提醒我查看邮件'
    const result = await prompt(text)
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(sessionCommands.at(-1), { kind: 'prompt', bindingId: session.bindingId, text, spoken: false })
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, true, '入口转交不等于已停录')
    assert.equal(sent('meeting-stopping').length, 0)
  } finally {
    await finishAudioMeeting(started.meetingId)
  }
})

test('语音复合委托保留原文和来源；会话失败不能冒充已完成', async () => {
  const text = '帮我创建一个会议并开启麦克风和系统回环录音，然后按讲解样本讲解一遍'
  const sending = prompt(text, true)
  try {
    await nextTurn()
    assert.equal(chats.length, 1, '语音整句应进入原有语音会话，而不是先执行本地讲解')
    assert.equal(chats[0].text, text)
    assert.equal(chats[0].bindingId, session.bindingId)
    assert.equal(sent<DocState>('doc-state').some(state => state.kind === 'outline'), false)
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, false, '转交不应擅自开录')
    chats[0].resolve({ ok: false, error: '隔离会话拒绝请求' })
    const result = await sending
    assert.equal(result.ok, false)
    assert.equal(result.error, '隔离会话拒绝请求')
  } finally {
    for (const chat of chats) chat.resolve({ ok: false, error: '测试收尾' })
    await sending
  }
})

test('有讲解上下文时，复合委托不能被文档追问分支截断', async () => {
  assert.equal((await prompt('讲讲讲解样本')).ok, true)
  const text = '先停止会议录音，然后讲解讲解样本并提醒我查看邮件'
  assert.equal((await prompt(text)).ok, true)
  assert.equal(sessionCommands.at(-1)?.kind, 'prompt')
  const command = sessionCommands.at(-1)
  assert.equal(command?.kind === 'prompt' ? command.text : '', text)
  assert.equal(chats.length, 0, '不能作为一条文档追问单独请求模型')
})

test('复合委托不被上一段中断播报的上下文改写原文', async () => {
  await answer(await startExplanation())
  assert.equal(finishSentence(), '先说明授权范围。')
  send('speech-stop')
  await nextTurn()
  const text = '先录音，然后讲讲讲解样本'
  assert.equal((await prompt(text)).ok, true)
  const command = sessionCommands.at(-1)
  assert.equal(command?.kind === 'prompt' ? command.text : '', text, '必须交付完整原文，而非拼接旧播报')
})

test('语音复合委托在播报中断后也保持原话与原会话', async () => {
  await answer(await startExplanation())
  finishSentence()
  send('speech-stop')
  await nextTurn()
  const text = '先录音，然后讲讲讲解样本'
  const sending = prompt(text, true)
  const chat = await chatAt(1)
  assert.equal(chat.text, text)
  assert.equal(chat.bindingId, session.bindingId)
  chat.resolve({ ok: false, error: '隔离会话结束' })
  assert.equal((await sending).ok, false)
})

test('单一讲解、讲解追问及斜杠命令继续沿用原有本地路径', async () => {
  assert.equal((await prompt('打开并讲讲讲解样本')).ok, true)
  assert.equal(outline().total, 3)
  assert.equal(sessionCommands.length, 0)
  const asking = prompt('为什么先介绍边界，再解释这里的授权？')
  const chat = await chatAt(0)
  assert.ok(chat.text.includes(paragraphs[0]), '追问仍带当前文档原文')
  await answer(chat, '为了保护资料。')
  assert.equal((await asking).ok, true)
  const askingMail = prompt('这里为什么讲到发送邮件和设置提醒？')
  const mailQuestion = await chatAt(1)
  assert.ok(mailQuestion.text.includes(paragraphs[0]), '解释性追问不能被误当成执行委托')
  await answer(mailQuestion, '这是文档中的例子。')
  assert.equal((await askingMail).ok, true)
  const slash = '/help 停止会议并整理纪要'
  assert.equal((await prompt(slash, true)).ok, true)
  assert.deepEqual(sessionCommands.at(-1), { kind: 'prompt', bindingId: session.bindingId, text: slash, spoken: false, voiceTurn: undefined })
})

test('单一会议纪要请求仍走原有录制中阻拦，不提前请求模型或停止会议', async () => {
  const started = await invoke<{ ok: boolean; meetingId: string; error?: string }>('meeting-start', meetingConsent)
  assert.equal(started.ok, true, started.error)
  try {
    const result = await prompt('整理会议纪要')
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /还在录制/u)
    assert.equal(chats.length, 0)
    assert.equal(sessionCommands.length, 0)
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, true)
  } finally { await finishAudioMeeting(started.meetingId) }
})

test('桌面停录工具必须依据真实冲刷回执，不能因停止状态变化冒充成功', async () => {
  const started = await invoke<{ ok: boolean; meetingId: string; error?: string }>('meeting-start', meetingConsent)
  assert.equal(started.ok, true, started.error)
  try {
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: {
      id: '隔离停止', command: 'meeting.stop', payload: { meetingId: started.meetingId }, expiresAt: Date.now() + 10_000,
    } })
    await nextTurn()
    await invoke('meeting-flush-done', started.meetingId, {
      tracks: { mic: { sent: 0, acknowledged: null } }, errors: ['音频块被拒收'],
    })
    for (let i = 0; i < 20 && desktopReplies.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 50))
    const reply = desktopReplies.find(item => item.id === '隔离停止')
    assert.ok(reply, '桌面命令必须返回停止回执')
    assert.equal(reply.ok, false, '冲刷不完整不能返回成功')
    assert.match(reply.error ?? '', /不完整|失败|拒收|未知/u)
  } finally {
    await finishAudioMeeting(started.meetingId)
  }
})

test('桌面开会命令必须匹配本次请求和原始参数，取消后迟到的开始不能开录', async () => {
  bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: {
    id: '开会请求甲', command: 'meeting.start', payload: { name: '指定会议', sources: 'mic+loopback', retentionDays: 30 }, expiresAt: Date.now() + 10_000,
  } })
  await nextTurn()
  const command = sent<{ requestId: string; consent: typeof meetingConsent }>('meeting-command').at(-1)!
  try {
    assert.equal(command.requestId, '开会请求甲')
    assert.equal((await invoke<{ ok: boolean }>('meeting-start', command.consent, '伪造请求')).ok, false)
    assert.equal((await invoke<{ ok: boolean }>('meeting-start', { ...command.consent, name: '替换会议' }, command.requestId)).ok, false)
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, false)
    bridgeCallbacks.onEvent?.({ type: 'desktop/cancel', payload: { id: command.requestId } })
    await nextTurn()
    assert.equal((await invoke<{ ok: boolean }>('meeting-start', command.consent, command.requestId)).ok, false)
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, false)
  } finally {
    bridgeCallbacks.onEvent?.({ type: 'desktop/cancel', payload: { id: command.requestId } })
    const state = await invoke<{ meetingId: string | null }>('meeting-state')
    if (state.meetingId) await finishAudioMeeting(state.meetingId)
  }
})

test('桌面命令领取失败或领取期间取消，不能开确认窗口或触发录音', async () => {
  claimDesktopCommand = async () => ({ status: 409, body: { claimed: false } })
  const command = (id: string) => bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: {
    id, command: 'meeting.presentation.start', payload: { name: '不能开录', documentPath }, expiresAt: Date.now() + 10_000,
  } })
  command('领取失败')
  await nextTurn(); await nextTurn()
  assert.equal(meetingPresentationDialogs.length, 0)
  assert.equal(sent('meeting-command').length, 0)
  const waiting = deferred<{ status: number; body: unknown }>()
  claimDesktopCommand = () => waiting.promise
  command('领取中取消')
  await nextTurn()
  bridgeCallbacks.onEvent?.({ type: 'desktop/cancel', payload: { id: '领取中取消' } })
  waiting.resolve({ status: 200, body: { claimed: true } })
  await nextTurn(); await nextTurn()
  assert.equal(meetingPresentationDialogs.length, 0)
  assert.equal(sent('meeting-command').length, 0)
  assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, false)
})

test('桌面开会只有两轨真实落块才回成功；等就绪时取消会请求停录且不续做', async () => {
  let cleanupId = ''
  try {
  bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: {
    id: '双轨开会', command: 'meeting.start', payload: { name: '双轨会议' }, expiresAt: Date.now() + 10_000,
  } })
  await nextTurn()
  const command = sent<{ requestId: string; consent: typeof meetingConsent }>('meeting-command').at(-1)!
  const started = await invoke<{ ok: boolean; meetingId: string }>('meeting-start', command.consent, command.requestId)
  assert.equal(started.ok, true)
  cleanupId = started.meetingId
  const pcm = Buffer.alloc(1600, 3).toString('base64')
  for (const track of ['mic', 'loopback']) {
    assert.equal((await invoke<{ ok: boolean }>('meeting-chunk', started.meetingId, pcm,
      { track, seq: 0, startMs: 0, sampleRate: 16_000, frames: 800 })).ok, true)
  }
  for (let i = 0; i < 30 && !desktopReplies.some(item => item.id === command.requestId); i++) await new Promise(resolve => setTimeout(resolve, 25))
  const reply = desktopReplies.find(item => item.id === command.requestId)
  assert.equal(reply?.ok, true)
  assert.deepEqual((reply?.result as { recorded: string[] }).recorded, ['mic', 'loopback'])
  await finishAudioMeeting(started.meetingId)
  cleanupId = ''

  bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: {
    id: '取消中开会', command: 'meeting.start', payload: { name: '待取消会议' }, expiresAt: Date.now() + 10_000,
  } })
  await nextTurn()
  const second = sent<{ requestId: string; consent: typeof meetingConsent }>('meeting-command').at(-1)!
  const running = await invoke<{ ok: boolean; meetingId: string }>('meeting-start', second.consent, second.requestId)
  assert.equal(running.ok, true)
  cleanupId = running.meetingId
  bridgeCallbacks.onEvent?.({ type: 'desktop/cancel', payload: { id: second.requestId } })
  await nextTurn()
  assert.equal((await invoke<{ stopping: boolean }>('meeting-state')).stopping, true)
  assert.equal(desktopReplies.some(item => item.id === second.requestId && item.ok), false)
  await finishAudioMeeting(running.meetingId)
  cleanupId = ''
  } finally { if (cleanupId) await finishAudioMeeting(cleanupId) }
})

test('会议讲解须本人原生确认；拒绝或确认时文档已变化均不开录', async () => {
  const command = (id: string) => bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: {
    id, command: 'meeting.presentation.start', payload: { name: '讲解会议', documentPath }, expiresAt: Date.now() + 10_000,
  } })
  command('拒绝讲解')
  for (let i = 0; i < 50 && !desktopReplies.some(item => item.id === '拒绝讲解'); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(desktopReplies.find(item => item.id === '拒绝讲解')?.ok, false)
  assert.equal(meetingPresentationDialogs.length, 1)
  assert.match(JSON.stringify(meetingPresentationDialogs[0]), /麦克风|录音/u)
  assert.equal(sent('meeting-command').length, 0)
  assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, false)
  const pending = deferred<{ response: number }>()
  confirmMeetingPresentation = () => pending.promise
  command('文档变化')
  for (let i = 0; i < 50 && meetingPresentationDialogs.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10))
  writeFileSync(documentPath, '确认期间文档已变化', 'utf8')
  pending.resolve({ response: 0 })
  for (let i = 0; i < 50 && !desktopReplies.some(item => item.id === '文档变化'); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(desktopReplies.find(item => item.id === '文档变化')?.ok, false)
  assert.equal(sent('meeting-command').length, 0)
})

test('会议讲解文档段数超过安全上限时先要求拆分，不打开录音或大量模型请求', async () => {
  writeFileSync(documentPath, Array.from({ length: 101 }, (_, index) => `测试段落 ${index + 1}。`).join('\n\n'), 'utf8')
  confirmMeetingPresentation = async () => ({ response: 0 })
  bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '段落过多', command: 'meeting.presentation.start',
    payload: { name: '大文档会议', documentPath }, expiresAt: Date.now() + 10_000 } })
  try {
    for (let i = 0; i < 50 && !desktopReplies.some(item => item.id === '段落过多'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    const reply = desktopReplies.find(item => item.id === '段落过多')
    assert.equal(reply?.ok, false)
    assert.match(reply?.error ?? '', /100|拆分/u)
    assert.equal(meetingPresentationDialogs.length, 0)
    assert.equal(sent('meeting-command').length, 0)
    assert.equal(chats.length, 0)
  } finally { bridgeCallbacks.onEvent?.({ type: 'desktop/cancel', payload: { id: '段落过多' } }) }
})

test('会议讲解取消发生在确认窗口时，迟到同意不能开启录音', async () => {
  const pending = deferred<{ response: number }>()
  confirmMeetingPresentation = () => pending.promise
  bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '确认中取消', command: 'meeting.presentation.start',
    payload: { name: '取消会议', documentPath }, expiresAt: Date.now() + 10_000 } })
  for (let i = 0; i < 50 && meetingPresentationDialogs.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(meetingPresentationDialogs.length, 1)
  bridgeCallbacks.onEvent?.({ type: 'desktop/cancel', payload: { id: '确认中取消' } })
  pending.resolve({ response: 0 })
  await nextTurn()
  await nextTurn()
  assert.equal(sent('meeting-command').length, 0)
  assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, false)
})

test('双轨就绪才开始实际讲解，播完等待选择且不自动停录或外发', async () => {
  confirmMeetingPresentation = async () => ({ response: 0 })
  let meetingId = ''
  try {
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '会议讲解链', command: 'meeting.presentation.start',
      payload: { name: '授权讲解会', documentPath }, expiresAt: Date.now() + 10_000 } })
    for (let i = 0; i < 50 && sent('meeting-command').length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    const request = sent<{ requestId: string; consent: typeof meetingConsent }>('meeting-command').at(-1)!
    const started = await invoke<{ ok: boolean; meetingId: string }>('meeting-start', request.consent, request.requestId)
    assert.equal(started.ok, true)
    meetingId = started.meetingId
    const pcm = Buffer.alloc(1600, 3).toString('base64')
    const push = (track: string) => invoke<{ ok: boolean }>('meeting-chunk', meetingId, pcm,
      { track, seq: 0, startMs: 0, sampleRate: 16_000, frames: 800 })
    assert.equal((await push('mic')).ok, true)
    await new Promise(resolve => setTimeout(resolve, 180))
    assert.equal(desktopReplies.some(item => item.id === request.requestId), false)
    assert.equal(narrator.requests.length, 0)
    assert.equal((await push('loopback')).ok, true)
    for (let i = 0; i < 60 && (desktopReplies.every(item => item.id !== request.requestId) || !playing); i++) await new Promise(resolve => setTimeout(resolve, 25))
    const reply = desktopReplies.find(item => item.id === request.requestId)
    assert.equal(reply?.ok, true)
    assert.equal((reply?.result as { state: string }).state, 'waiting-to-present')
    assert.ok(playing, '开场白必须进入真实播放器替身')
    finishSentence()
    for (let index = 0; index < paragraphs.length; index++) {
      await answer(await chatAt(index), `这是第 ${index + 1} 段的讲解。`)
      finishSentence()
    }
    await nextTurn()
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '查讲解状态', command: 'meeting.presentation.status', payload: {}, expiresAt: Date.now() + 5000 } })
    for (let i = 0; i < 30 && !desktopReplies.some(item => item.id === '查讲解状态'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    const status = desktopReplies.find(item => item.id === '查讲解状态')?.result as { state: string; completed: number[] }
    assert.equal(status.state, 'completed')
    assert.deepEqual(status.completed, [0, 1, 2])
    const { MeetingStore } = await import('../src/main/meeting-store.ts')
    const persisted = new MeetingStore(path.join(sandbox, 'electron-userData'), { keyProvider: () => ({ status: 'ok', key: Buffer.alloc(32, 9) }) })
    try {
      const saved = persisted.getMeetingPresentation((reply!.result as { presentationId: string }).presentationId)
      assert.equal(saved?.state, 'completed')
      assert.deepEqual(saved?.completed, [0, 1, 2])
      assert.ok((saved?.revision ?? 0) >= 6, '逐段播放回执必须先持久化')
    } finally { persisted.close() }
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, true)
    assert.match(sent<string>('doc-notice').at(-1)!, /选择|讨论|停录/u)
    assert.equal(sent('meeting-stopping').length, 0)
  } finally { if (meetingId) await finishAudioMeeting(meetingId) }
})

test('会议讲解状态无法登记时不开麦，不把未持久化的步骤当作成功', async () => {
  confirmMeetingPresentation = async () => ({ response: 0 })
  const db = new DatabaseSync(path.join(sandbox, 'electron-userData', 'meetings.sqlite'))
  db.exec(`CREATE TRIGGER fail_presentation_insert BEFORE INSERT ON meeting_presentations
    BEGIN SELECT RAISE(ABORT, '模拟步骤存储失败'); END;`)
  try {
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '步骤落盘失败', command: 'meeting.presentation.start',
      payload: { name: '状态失败会', documentPath }, expiresAt: Date.now() + 10_000 } })
    for (let i = 0; i < 50 && !desktopReplies.some(item => item.id === '步骤落盘失败'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    const reply = desktopReplies.find(item => item.id === '步骤落盘失败')
    assert.equal(reply?.ok, false)
    assert.match(reply?.error ?? '', /保存|存储/u)
    assert.equal(sent('meeting-command').length, 0)
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, false)
  } finally { db.exec('DROP TRIGGER fail_presentation_insert'); db.close() }
})

test('双轨就绪后会话仍忙时不抢播；用户取消后即使恢复空闲也不再开讲', async () => {
  confirmMeetingPresentation = async () => ({ response: 0 })
  bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'running' } })
  let meetingId = ''
  try {
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '忙时讲解', command: 'meeting.presentation.start',
      payload: { name: '忙时会议', documentPath }, expiresAt: Date.now() + 10_000 } })
    for (let i = 0; i < 50 && sent('meeting-command').length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    const request = sent<{ requestId: string; consent: typeof meetingConsent }>('meeting-command').at(-1)!
    const started = await invoke<{ ok: boolean; meetingId: string }>('meeting-start', request.consent, request.requestId)
    assert.ok(started.ok)
    meetingId = started.meetingId
    const pcm = Buffer.alloc(1600, 3).toString('base64')
    for (const track of ['mic', 'loopback']) await invoke('meeting-chunk', meetingId, pcm,
      { track, seq: 0, startMs: 0, sampleRate: 16_000, frames: 800 })
    for (let i = 0; i < 40 && !desktopReplies.some(item => item.id === request.requestId); i++) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(desktopReplies.find(item => item.id === request.requestId)?.ok, true)
    assert.equal(narrator.requests.length, 0)
    assert.equal((await invoke<{ ok: boolean }>('session-command', { kind: 'cancel', bindingId: session.bindingId, scope: 'mute' })).ok, true)
    bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'idle' } })
    await nextTurn()
    assert.equal(narrator.requests.length, 0)
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, true, '取消讲解不暗中声称停录')
  } finally { if (meetingId) await finishAudioMeeting(meetingId) }
})

test('等待开讲时静音只暂停，明确继续后重新核验双轨和文档', async () => {
  const prepared = await prepareMeetingPresentation('准备等待暂停')
  try {
    assert.equal((await invoke<{ ok: boolean }>('session-command', { kind: 'cancel', bindingId: session.bindingId, scope: 'mute' })).ok, true)
    bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'idle' } })
    await nextTurn()
    assert.equal(narrator.requests.length, 0)
    assert.equal((await prompt('继续讲解', true)).ok, true)
    for (let i = 0; i < 50 && !playing; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(playing, '本人明确继续后才允许开讲')
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, true)
  } finally { await finishAudioMeeting(prepared.meetingId) }
})

test('发起会议的语音会话失败时，即使双轨已就绪也不自动开讲', async () => {
  const request = prompt('先开一场会议，然后讲讲讲解样本', true)
  const chat = await chatAt(0)
  const prepared = await prepareMeetingPresentation('发起会话失败')
  try {
    assert.equal(narrator.requests.length, 0)
    chat.resolve({ ok: false, error: '模拟会话失败' })
    assert.equal((await request).ok, false)
    bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'idle' } })
    await nextTurn()
    assert.equal(narrator.requests.length, 0)
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '查发起失败', command: 'meeting.presentation.status',
      payload: { presentationId: prepared.presentationId }, expiresAt: Date.now() + 5000 } })
    for (let i = 0; i < 30 && !desktopReplies.some(item => item.id === '查发起失败'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal((desktopReplies.find(item => item.id === '查发起失败')?.result as { state: string }).state, 'failed')
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, true)
  } finally { await finishAudioMeeting(prepared.meetingId) }
})

test('明确结束会议后等待双轨冲刷与转写，打开待本人审阅的纪要而不自动外发', async () => {
  confirmMeetingPresentation = async () => ({ response: 0 })
  fakeMeetingTranscription = true
  bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'running' } })
  let meetingId = ''
  try {
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '待结束会议', command: 'meeting.presentation.start',
      payload: { name: '可结束会议', documentPath }, expiresAt: Date.now() + 10_000 } })
    for (let i = 0; i < 50 && sent('meeting-command').length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    const request = sent<{ requestId: string; consent: typeof meetingConsent }>('meeting-command').at(-1)!
    const started = await invoke<{ ok: boolean; meetingId: string }>('meeting-start', request.consent, request.requestId)
    assert.ok(started.ok)
    meetingId = started.meetingId
    const pcm = Buffer.alloc(1600, 3).toString('base64')
    for (const track of ['mic', 'loopback']) await invoke('meeting-chunk', meetingId, pcm,
      { track, seq: 0, startMs: 0, sampleRate: 16_000, frames: 800 })
    for (let i = 0; i < 40 && !desktopReplies.some(item => item.id === request.requestId); i++) await new Promise(resolve => setTimeout(resolve, 25))
    const presentationId = (desktopReplies.find(item => item.id === request.requestId)?.result as { presentationId: string }).presentationId
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '结束并转写', command: 'meeting.presentation.finish',
      payload: { presentationId }, expiresAt: Date.now() + 10_000 } })
    for (let i = 0; i < 50 && sent('meeting-stopping').length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(sent('meeting-stopping').length, 1)
    const flush = await invoke<{ ok: boolean }>('meeting-flush-done', meetingId, { tracks: {
      mic: { sent: 0, acknowledged: 0 }, loopback: { sent: 0, acknowledged: 0 },
    }, errors: [] })
    assert.equal(flush.ok, true)
    for (let i = 0; i < 80 && !desktopReplies.some(item => item.id === '结束并转写'); i++) await new Promise(resolve => setTimeout(resolve, 25))
    const result = desktopReplies.find(item => item.id === '结束并转写')
    assert.equal(result?.ok, true, result?.error)
    assert.equal((result?.result as { state: string }).state, 'awaiting-review')
    assert.equal((result?.result as { lectureOutcome: string }).lectureOutcome, 'interrupted', '未曾开讲不能冒充已完成讲解')
    assert.match(String(meetingPresentationDialogs.at(-1)?.detail), /讲解.*未完整/u)
    const minutes = await invoke<{ minutes?: { state: string; content: string } }>('meeting-minutes', meetingId)
    assert.equal(minutes.minutes?.state, 'draft')
    assert.match(minutes.minutes?.content ?? '', /测试会议转写/u)
    assert.equal(sent('meeting-command').length, 1, '未启动新会议或外发步骤')
  } finally { if (meetingId) await finishAudioMeeting(meetingId) }
})

async function prepareMeetingPresentation(id: string, selectedPath = documentPath): Promise<{ meetingId: string; presentationId: string }> {
  confirmMeetingPresentation = async () => ({ response: 0 })
  bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'running' } })
  bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id, command: 'meeting.presentation.start',
    payload: { name: '隔离会议', documentPath: selectedPath }, expiresAt: Date.now() + 10_000 } })
  for (let i = 0; i < 50 && sent('meeting-command').length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  const request = sent<{ requestId: string; consent: typeof meetingConsent }>('meeting-command').at(-1)!
  const started = await invoke<{ ok: boolean; meetingId: string }>('meeting-start', request.consent, request.requestId)
  assert.ok(started.ok)
  const pcm = Buffer.alloc(1600, 3).toString('base64')
  for (const track of ['mic', 'loopback']) await invoke('meeting-chunk', started.meetingId, pcm,
    { track, seq: 0, startMs: 0, sampleRate: 16_000, frames: 800 })
  for (let i = 0; i < 40 && !desktopReplies.some(item => item.id === id); i++) await new Promise(resolve => setTimeout(resolve, 25))
  const reply = desktopReplies.find(item => item.id === id)
  assert.equal(reply?.ok, true)
  return { meetingId: started.meetingId, presentationId: (reply!.result as { presentationId: string }).presentationId }
}

test('停录冲刷不完整时不把转写或纪要当作完成', async () => {
  const prepared = await prepareMeetingPresentation('准备部分录音')
  try {
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '部分停录', command: 'meeting.presentation.finish',
      payload: { presentationId: prepared.presentationId }, expiresAt: Date.now() + 10_000 } })
    for (let i = 0; i < 50 && sent('meeting-stopping').length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    const flushed = await invoke<{ ok: boolean }>('meeting-flush-done', prepared.meetingId, { tracks: {
      mic: { sent: 0, acknowledged: 0 }, loopback: { sent: 0, acknowledged: null },
    }, errors: ['回环块未确认'] })
    assert.equal(flushed.ok, false)
    for (let i = 0; i < 50 && !desktopReplies.some(item => item.id === '部分停录'); i++) await new Promise(resolve => setTimeout(resolve, 25))
    const reply = desktopReplies.find(item => item.id === '部分停录')
    assert.equal(reply?.ok, false)
    assert.match(reply?.error ?? '', /不完整|未知/u)
    assert.equal(narrator.requests.length, 0)
  } finally { await finishAudioMeeting(prepared.meetingId) }
})

test('已不完整停录的会议再次请求结束时仍标失败，不残留伪造的停止中状态', async () => {
  const prepared = await prepareMeetingPresentation('准备旧不完整会议')
  try {
    assert.equal((await invoke<{ ok: boolean }>('meeting-stop', prepared.meetingId)).ok, true)
    assert.equal((await invoke<{ ok: boolean }>('meeting-flush-done', prepared.meetingId, { tracks: {
      mic: { sent: 0, acknowledged: 0 }, loopback: { sent: 0, acknowledged: null },
    }, errors: ['回环不完整'] })).ok, false)
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '再次结束不完整', command: 'meeting.presentation.finish',
      payload: { presentationId: prepared.presentationId }, expiresAt: Date.now() + 10_000 } })
    for (let i = 0; i < 50 && !desktopReplies.some(item => item.id === '再次结束不完整'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(desktopReplies.find(item => item.id === '再次结束不完整')?.ok, false)
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '查不完整会议', command: 'meeting.presentation.status',
      payload: { presentationId: prepared.presentationId }, expiresAt: Date.now() + 5000 } })
    for (let i = 0; i < 30 && !desktopReplies.some(item => item.id === '查不完整会议'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal((desktopReplies.find(item => item.id === '查不完整会议')?.result as { state: string }).state, 'failed')
  } finally { await finishAudioMeeting(prepared.meetingId) }
})

test('停止确认窗口中取消后，即使迟到同意也不停止录音或开始讲解', async () => {
  const prepared = await prepareMeetingPresentation('准备取消停录')
  try {
    const pending = deferred<{ response: number }>()
    confirmMeetingPresentation = () => pending.promise
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '取消停录确认', command: 'meeting.presentation.finish',
      payload: { presentationId: prepared.presentationId }, expiresAt: Date.now() + 10_000 } })
    for (let i = 0; i < 50 && meetingPresentationDialogs.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(meetingPresentationDialogs.length, 2)
    bridgeCallbacks.onEvent?.({ type: 'desktop/cancel', payload: { id: '取消停录确认' } })
    pending.resolve({ response: 0 })
    await nextTurn(); await nextTurn()
    bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'idle' } })
    await nextTurn()
    assert.equal(sent('meeting-stopping').length, 0)
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, true)
    assert.equal(narrator.requests.length, 0)
  } finally { await finishAudioMeeting(prepared.meetingId) }
})

test('双轨就绪后文档变化使讲解失效，不使用旧批准悄悄开始', async () => {
  const prepared = await prepareMeetingPresentation('准备文档变更')
  try {
    writeFileSync(documentPath, '在双轨就绪后被修改', 'utf8')
    bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'idle' } })
    for (let i = 0; i < 30 && sent('doc-notice').length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(narrator.requests.length, 0)
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, true)
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '查文档变更', command: 'meeting.presentation.status',
      payload: { presentationId: prepared.presentationId }, expiresAt: Date.now() + 5000 } })
    for (let i = 0; i < 30 && !desktopReplies.some(item => item.id === '查文档变更'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal((desktopReplies.find(item => item.id === '查文档变更')?.result as { state: string }).state, 'failed')
  } finally { await finishAudioMeeting(prepared.meetingId) }
})

test('会议讲解中插话先停播，回答结束后从未播完的原句续讲，录音不中断', async () => {
  const prepared = await prepareMeetingPresentation('准备插话会议')
  try {
    bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'idle' } })
    for (let i = 0; i < 50 && !playing; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(playing)
    finishSentence()
    await answer(await chatAt(0), explanation)
    assert.equal(finishSentence(), '先说明授权范围。')
    send('barge-in-detected')
    await nextTurn()
    assert.equal(narrator.isSpeaking(), false)
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, true)
    const asking = prompt('这个目录为什么只读？', true)
    await answer(await chatAt(1), '只读可以避免误改原件。')
    assert.equal((await asking).ok, true)
    assert.equal(finishSentence(), '只读可以避免误改原件。')
    await new Promise(resolve => setTimeout(resolve, 1800))
    assert.equal(narrator.requests.at(-1)?.fromIndex, 1, '只能从尚未完整播完的句子继续')
    assert.equal(finishSentence(), '再解释目录边界。')
    assert.equal(finishSentence(), '最后补充撤销方式。')
    await answer(await chatAt(2), '这是第二段的讲解。')
    finishSentence()
    await answer(await chatAt(3), '这是第三段的讲解。')
    finishSentence()
    await nextTurn()
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '查插话讲解', command: 'meeting.presentation.status',
      payload: { presentationId: prepared.presentationId }, expiresAt: Date.now() + 5000 } })
    for (let i = 0; i < 30 && !desktopReplies.some(item => item.id === '查插话讲解'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    const status = desktopReplies.find(item => item.id === '查插话讲解')?.result as { state: string; completed: number[] }
    assert.equal(status.state, 'completed')
    assert.deepEqual(status.completed, [0, 1, 2])
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, true)
  } finally { await finishAudioMeeting(prepared.meetingId) }
})

test('会议插话回答失败后不自动续讲，录音状态仍需本人核查', async () => {
  const prepared = await prepareMeetingPresentation('准备失败插话')
  try {
    bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'idle' } })
    for (let i = 0; i < 50 && !playing; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(playing)
    finishSentence()
    await answer(await chatAt(0), explanation)
    finishSentence()
    send('barge-in-detected')
    await nextTurn()
    const request = prompt('这个问题怎么理解？', true)
    const question = await chatAt(1)
    question.resolve({ ok: false, error: '模拟回答失败' })
    assert.equal((await request).ok, false)
    await new Promise(resolve => setTimeout(resolve, 1500))
    assert.equal(playing, null)
    assert.equal(chats.length, 2)
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '查失败插话', command: 'meeting.presentation.status',
      payload: { presentationId: prepared.presentationId }, expiresAt: Date.now() + 5000 } })
    for (let i = 0; i < 30 && !desktopReplies.some(item => item.id === '查失败插话'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal((desktopReplies.find(item => item.id === '查失败插话')?.result as { state: string }).state, 'failed')
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, true)
  } finally { await finishAudioMeeting(prepared.meetingId) }
})

test('会议讲解明确暂停只保留位置，继续时从未播完的句子恢复', async () => {
  const prepared = await prepareMeetingPresentation('准备暂停讲解')
  try {
    bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'idle' } })
    for (let i = 0; i < 50 && !playing; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(playing)
    finishSentence()
    await answer(await chatAt(0), explanation)
    assert.equal(finishSentence(), '先说明授权范围。')
    assert.equal((await prompt('暂停讲解')).ok, true)
    assert.equal(playing, null)
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '查暂停讲解', command: 'meeting.presentation.status',
      payload: { presentationId: prepared.presentationId }, expiresAt: Date.now() + 5000 } })
    for (let i = 0; i < 30 && !desktopReplies.some(item => item.id === '查暂停讲解'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal((desktopReplies.find(item => item.id === '查暂停讲解')?.result as { state: string }).state, 'paused')
    assert.equal((await prompt('继续讲解', true)).ok, true)
    assert.equal(narrator.requests.at(-1)?.fromIndex, 1)
    assert.equal(finishSentence(), '再解释目录边界。')
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, true)
  } finally { await finishAudioMeeting(prepared.meetingId) }
})

test('会议讲解中途文档被改或授权撤销，下一段不得使用旧批准继续', async () => {
  const prepared = await prepareMeetingPresentation('准备中途改稿')
  try {
    bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'idle' } })
    for (let i = 0; i < 50 && !playing; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(playing)
    finishSentence()
    await answer(await chatAt(0), '这是第一段的讲解。')
    writeFileSync(documentPath, '讲解中修改后的内容', 'utf8')
    finishSentence()
    for (let i = 0; i < 30 && !sent<string>('doc-notice').some(message => /变化|授权/u.test(message)); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(chats.length, 1, '变更后不得请求下一段')
    assert.equal(playing, null)
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '查中途改稿', command: 'meeting.presentation.status',
      payload: { presentationId: prepared.presentationId }, expiresAt: Date.now() + 5000 } })
    for (let i = 0; i < 30 && !desktopReplies.some(item => item.id === '查中途改稿'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal((desktopReplies.find(item => item.id === '查中途改稿')?.result as { state: string }).state, 'failed')
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, true)
  } finally { await finishAudioMeeting(prepared.meetingId) }
})

test('等待模型讲解时文档发生变化，迟到回答不得播放', async () => {
  const prepared = await prepareMeetingPresentation('准备迟到讲解')
  try {
    bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'idle' } })
    for (let i = 0; i < 50 && !playing; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(playing)
    finishSentence()
    const pending = await chatAt(0)
    writeFileSync(documentPath, '模型回复期间修改后的文档', 'utf8')
    await answer(pending, '不该播放的旧回答。')
    for (let i = 0; i < 30 && !sent<string>('doc-notice').some(message => /变化|授权/u.test(message)); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(playing, null)
    assert.equal(narrator.requests.filter(item => item.utteranceId.startsWith('doc:')).length, 0)
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, true)
  } finally { await finishAudioMeeting(prepared.meetingId) }
})

test('播放进度落盘失败时停止推进，不能再请求下一段或声称讲完', async () => {
  const prepared = await prepareMeetingPresentation('准备进度失败')
  const db = new DatabaseSync(path.join(sandbox, 'electron-userData', 'meetings.sqlite'))
  try {
    bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'idle' } })
    for (let i = 0; i < 50 && !playing; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(playing)
    finishSentence()
    await answer(await chatAt(0), '这是第一段的讲解。')
    db.exec(`CREATE TRIGGER fail_presentation_update BEFORE UPDATE ON meeting_presentations
      BEGIN SELECT RAISE(ABORT, '模拟进度落盘失败'); END;`)
    finishSentence()
    await nextTurn()
    assert.equal(chats.length, 1)
    assert.equal(playing, null)
    assert.ok(sent<string>('doc-notice').some(message => /状态.*保存|状态.*失败/u.test(message)))
    assert.equal((await invoke<{ recording: boolean }>('meeting-state')).recording, true)
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_presentation_update')
    db.close()
    await finishAudioMeeting(prepared.meetingId)
  }
})

test('代码或无法提取的文档段落不会冒充整份讲完，状态和提示标明部分完成', async () => {
  const file = path.join(authorized, '部分可讲.md')
  writeFileSync(file, '# 正文\n可讲解的文字。\n\n## 代码\n```js\nconsole.log(1)\n```\n', 'utf8')
  const prepared = await prepareMeetingPresentation('准备部分讲解', file)
  try {
    bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'idle' } })
    for (let i = 0; i < 50 && !playing; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(playing)
    finishSentence()
    await answer(await chatAt(0), '这是可提取文字的讲解。')
    finishSentence()
    for (let i = 0; i < 30 && !sent<string>('doc-notice').some(message => /部分|未讲/u.test(message)); i++) await new Promise(resolve => setTimeout(resolve, 10))
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '查部分讲解', command: 'meeting.presentation.status',
      payload: { presentationId: prepared.presentationId }, expiresAt: Date.now() + 5000 } })
    for (let i = 0; i < 30 && !desktopReplies.some(item => item.id === '查部分讲解'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    const status = desktopReplies.find(item => item.id === '查部分讲解')?.result as { state: string; completed: number[] }
    assert.equal(status.state, 'partial')
    assert.deepEqual(status.completed, [0])
    assert.ok(sent<string>('doc-notice').some(message => /部分|未讲/u.test(message)))
  } finally { await finishAudioMeeting(prepared.meetingId); rmSync(file, { force: true }) }
})

test('隔离黄金链：双轨讲解、停录转写、本人确认文件、审批发信和企微提醒逐步衔接', async () => {
  fakeMeetingTranscription = true
  const prepared = await prepareMeetingPresentation('完整模拟会议')
  const home = mkdtempSync(path.join(sandbox, 'golden-chain-'))
  let disposeTools: (() => void) | undefined
  let runtime: import('../../dsh-personal-assistant/src/task-runtime.ts').CompanionTaskRuntime | undefined
  let team: import('../../dsh-personal-assistant/src/team-domain.ts').TeamStore | undefined
  try {
    bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, status: 'idle' } })
    for (let i = 0; i < 50 && !playing; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(playing)
    finishSentence()
    for (let index = 0; index < paragraphs.length; index++) {
      await answer(await chatAt(index), `这是第 ${index + 1} 段的讲解。`)
      finishSentence()
    }
    await nextTurn()
    bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id: '黄金链停录', command: 'meeting.presentation.finish',
      payload: { presentationId: prepared.presentationId }, expiresAt: Date.now() + 10_000 } })
    for (let i = 0; i < 50 && sent('meeting-stopping').length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal((await invoke<{ ok: boolean }>('meeting-flush-done', prepared.meetingId, { tracks: {
      mic: { sent: 0, acknowledged: 0 }, loopback: { sent: 0, acknowledged: 0 },
    }, errors: [] })).ok, true)
    for (let i = 0; i < 80 && !desktopReplies.some(item => item.id === '黄金链停录'); i++) await new Promise(resolve => setTimeout(resolve, 25))
    const stopped = desktopReplies.find(item => item.id === '黄金链停录')
    assert.equal(stopped?.ok, true, stopped?.error)
    assert.equal((stopped?.result as { lectureOutcome: string }).lectureOutcome, 'completed')
    const preview = await invoke<{ ok: boolean; revision: number; minutes: { digest: string; content: string; state: string } }>('meeting-minutes', prepared.meetingId)
    assert.equal(preview.minutes.state, 'draft')
    assert.equal((await invoke<{ ok: boolean }>('meeting-minutes-confirm', prepared.meetingId, preview.minutes.digest)).ok, true)
    const exported = await invoke<{ ok: boolean; artifact?: { id: string; path: string; digest: string } }>('meeting-minutes', prepared.meetingId,
      { action: 'save-file', digest: preview.minutes.digest, revision: preview.revision })
    assert.ok(exported.ok && exported.artifact)
    const fileContent = readFileSync(exported.artifact!.path, 'utf8')
    assert.equal(fileContent, preview.minutes.content)

    mkdirSync(path.join(home, 'personal-assistant'))
    writeFileSync(path.join(home, 'personal-assistant', 'mail.json'), JSON.stringify({ host: 'smtp.example.com', port: 465,
      secure: true, user: 'sender@example.com', from: 'sender@example.com' }))
    const [{ TeamStore }, { ApprovalService }, { AssistantApprovalService }, { CompanionTaskRuntime }, { registerMeetingMailTools }] = await Promise.all([
      import('../../dsh-personal-assistant/src/team-domain.ts'), import('../../dsh-personal-assistant/src/approval.ts'),
      import('../../dsh-personal-assistant/src/assistant-approval.ts'), import('../../dsh-personal-assistant/src/task-runtime.ts'),
      import('../../dsh-personal-assistant/src/meeting-mail.ts'),
    ])
    team = new TeamStore(path.join(home, 'team.sqlite'))
    let clock = 1_800_000_000_000
    const now = () => clock
    const approval = new AssistantApprovalService({ epoch: 'golden-epoch', ttlMs: 60_000, now })
    runtime = new CompanionTaskRuntime(team, new ApprovalService(team, { ttlMs: 60_000, runtimeEpoch: 'golden-epoch' }),
      { epoch: 'golden-epoch', now, acceptsRecipient: (channel, recipient) => channel === 'wecom' && recipient === 'wecom:single:主人' })
    const bot = 'a'.repeat(64)
    runtime.setChannelAccountKey(() => bot)
    const tools = new Map<string, { execute(args: unknown, exec: { signal: AbortSignal }): Promise<string> }>()
    const sentMail: Array<{ text: string; to: string[] }> = []
    let nextCommand = 0
    const pluginBridge = {
      submitAssistant: (submission: import('../../dsh-personal-assistant/src/assistant-approval.ts').AssistantSubmission) => approval.submit(submission),
      requestDesktopCommand: async (command: string, payload: unknown) => {
        const id = `黄金链交接-${++nextCommand}`
        bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: { id, command, payload, expiresAt: Date.now() + 10_000 } })
        for (let i = 0; i < 100 && !desktopReplies.some(item => item.id === id); i++) await new Promise(resolve => setTimeout(resolve, 10))
        const reply = desktopReplies.find(item => item.id === id)
        if (!reply?.ok) throw new Error(reply?.error ?? '桌面交接没有回执')
        return reply.result
      },
    }
    disposeTools = registerMeetingMailTools({ tools: { register: (value: any) => { tools.set(value.name, value); return () => {} } } },
      { home, bridge: pluginBridge as never, store: team, epoch: 'golden-epoch', now, log: () => {},
        readSecret: async () => '隔离口令', send: async (_config, _secret, draft) => { sentMail.push(draft); return { messageId: '隔离邮件', accepted: draft.to, rejected: [] } },
        wecomBinding: recipient => recipient === 'wecom:single:主人' ? { accountKey: bot, botId: '隔离机器人' } : null,
        wecomRecipients: () => ['wecom:single:主人'], reminderInterval: () => 60,
        ensureReminder: intentId => runtime!.ensureMeetingMailReminder(intentId) })
    const exec = { signal: new AbortController().signal }
    const listed = JSON.parse(await tools.get('personal_assistant_meeting_artifacts')!.execute({ meetingId: prepared.meetingId }, exec))
    assert.equal(listed.artifacts[0].id, exported.artifact!.id)
    const proposed = JSON.parse(await tools.get('personal_assistant_send_meeting_minutes')!.execute({ artifactId: exported.artifact!.id,
      to: 'test@example.com', subject: '隔离会议纪要' }, exec))
    assert.equal(proposed.pending, true)
    assert.equal(sentMail.length, 0)
    const decided = await approval.decide(proposed.proposalId, 'approve', 'golden-epoch', approval.approvalCapabilityToken)
    assert.equal(decided.ok, true)
    assert.equal(sentMail.length, 1)
    assert.equal(sentMail[0]!.text, fileContent)
    assert.equal(team.getMailSendIntent(proposed.intentId)?.state, 'accepted')
    clock += 119_999
    ;(runtime as unknown as { tick(): void }).tick()
    assert.equal(runtime.listChannelDeliveries('wecom').length, 0)
    clock++
    ;(runtime as unknown as { tick(): void }).tick()
    const [delivery] = runtime.listChannelDeliveries('wecom')
    assert.ok(delivery)
    runtime.claimChannelDelivery(delivery.deliveryId)
    runtime.receiptChannelDelivery(delivery.deliveryId, 'succeeded', [`wecom:${delivery.operationId}`])
    assert.equal(runtime.respondChannelReminder('wecom:single:主人', { action: 'ack' }, bot).handled, true)
    clock += 600_000
    ;(runtime as unknown as { tick(): void }).tick()
    assert.equal(runtime.listChannelDeliveries('wecom').length, 0)
  } finally {
    disposeTools?.()
    await runtime?.dispose()
    team?.close()
    await finishAudioMeeting(prepared.meetingId)
    rmSync(home, { recursive: true, force: true })
  }
})

test('桌面停录成功及重复请求只返回已核验的真实完整回执', async () => {
  const started = await invoke<{ ok: boolean; meetingId: string; error?: string }>('meeting-start', meetingConsent)
  assert.equal(started.ok, true, started.error)
  try {
    const pcm = Buffer.alloc(3200, 5)
    const accepted = await invoke<{ ok: boolean; seq?: number }>('meeting-chunk', started.meetingId, pcm.toString('base64'), {
      track: 'mic', seq: 0, startMs: 0, sampleRate: 16000, frames: pcm.length / 2,
    })
    assert.equal(accepted.ok, true)
    const command = (id: string): void => bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: {
      id, command: 'meeting.stop', payload: { meetingId: started.meetingId }, expiresAt: Date.now() + 10_000,
    } })
    command('隔离完整停止')
    await nextTurn()
    const flush = await invoke<{ ok: boolean }>('meeting-flush-done', started.meetingId, {
      tracks: { mic: { sent: 0, acknowledged: 0 } }, errors: [],
    })
    assert.equal(flush.ok, true)
    for (let i = 0; i < 20 && desktopReplies.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 50))
    const first = desktopReplies.find(item => item.id === '隔离完整停止')
    assert.equal(first?.ok, true)
    assert.equal((first?.result as { integrity?: { status?: string } }).integrity?.status, 'complete')
    command('隔离重复停止')
    await nextTurn()
    const repeated = desktopReplies.find(item => item.id === '隔离重复停止')
    assert.equal(repeated?.ok, true)
    assert.equal((repeated?.result as { integrity?: { status?: string } }).integrity?.status, 'complete')
  } finally {
    await finishAudioMeeting(started.meetingId)
  }
})

test('没有停止证据的旧会议不能由桌面任务自动生成完整纪要', async () => {
  const meetingId = '隔离旧会议-完整性未知'
  const db = new DatabaseSync(path.join(sandbox, 'electron-userData', 'meetings.sqlite'))
  try {
    db.prepare(`INSERT INTO meetings
      (id, name, startedAt, endedAt, sources, consent, retentionDays, state, segmentsRevision, integrity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(meetingId, '旧会议', Date.now() - 10_000, Date.now() - 1000, 'mic', JSON.stringify(meetingConsent), 30, 'stopped', 0)
  } finally { db.close() }

  bridgeCallbacks.onEvent?.({ type: 'desktop/command', payload: {
    id: '隔离旧会议纪要', command: 'meeting.minutes', payload: { meetingId }, expiresAt: Date.now() + 10_000,
  } })
  for (let i = 0; i < 20 && desktopReplies.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 25))
  const reply = desktopReplies.find(item => item.id === '隔离旧会议纪要')
  assert.ok(reply, '桌面任务必须返回明确回执')
  assert.equal(reply.ok, false)
  assert.match(reply.error ?? '', /录音.*(?:完整|未知|回执)/u)
  assert.equal(chats.length, 0, '没有完整性证据时不能向模型发送会议内容')
})

test('当前入口的文字与斜杠命令只进入原生队列一次', async () => {
  assert.equal((await prompt('今天做些什么')).ok, true)
  assert.equal((await prompt('/help', true)).ok, true)
  assert.deepEqual(sessionCommands.map(command => command.kind === 'prompt' ? command.text : ''), ['今天做些什么', '/help'])
  assert.equal(chats.length, 0)
  assert.equal(narrator.requests.length, 0)
})

test('当前语音入口首句在最终回复之前播出且终稿不重复', async () => {
  const sending = prompt('介绍一下今天的安排', true)
  const chat = await chatAt(0)
  assert.equal(chat.bindingId, session.bindingId)
  assert.equal(typeof chat.onDelta, 'function', '当前入口必须订阅正文增量')
  chat.onDelta!('先查看工作。')
  await nextTurn()
  assert.equal(finishSentence(), '先查看工作。')
  chat.onDelta!('然后整理日报')
  assert.equal(playing, null, '半句等到流结束再播放')
  await answer(chat, '先查看工作。然后整理日报')
  assert.equal((await sending).ok, true)
  assert.equal(finishSentence(), '然后整理日报')
  assert.equal(playing, null)
  assert.equal(sessionCommands.length, 0)
})

test('当前入口的文档请求本地返回提纲，不误入普通模型队列', async () => {
  const result = await prompt('讲讲讲解样本')
  assert.equal(result.ok, true)
  assert.equal(outline().total, 3)
  assert.equal(sessionCommands.length, 0)
  assert.equal(chats.length, 0)
  assert.equal(narrator.requests.length, 0)
})

test('当前入口无增量时仍朗读一次完整答复', async () => {
  const sending = prompt('简短回答', true)
  await answer(await chatAt(0), '完整答复。')
  assert.equal((await sending).ok, true)
  assert.equal(finishSentence(), '完整答复。')
  assert.equal(playing, null)
})

test('当前入口停止后丢掉半句、队列和迟到终稿', async () => {
  const sending = prompt('讲一段安排', true)
  const chat = await chatAt(0)
  chat.onDelta!('第一句。第二句。没说完')
  await nextTurn()
  send('speech-stop')
  assert.equal(chat.signal?.aborted, true)
  const count = narrator.requests.length
  chat.onDelta!('迟到的句子。')
  await answer(chat, '第一句。第二句。没说完迟到的句子。')
  await sending
  assert.equal(playing, null)
  assert.equal(narrator.requests.length, count)
})

test('流式回复失败时停掉已排队内容，不补播终稿', async () => {
  const sending = prompt('请回答', true)
  const chat = await chatAt(0)
  chat.onDelta!('已经排队。还有一句。')
  await nextTurn()
  chat.resolve({ ok: false, error: '本轮失败' })
  assert.equal((await sending).ok, false)
  await nextTurn()
  assert.equal(playing, null)
})

test('换绑立即停止旧语音，旧增量和终稿不能进入新会话', async () => {
  const sending = prompt('旧会话问题', true)
  const chat = await chatAt(0)
  chat.onDelta!('旧会话第一句。')
  await nextTurn()
  bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, bindingId: '新绑定' } })
  assert.equal(chat.signal?.aborted, true)
  const count = narrator.requests.length
  chat.onDelta!('不能播放的迟到句。')
  await answer(chat)
  assert.equal((await sending).ok, false)
  assert.equal(narrator.requests.length, count)
  assert.equal(playing, null)
})

test('当前入口拒绝伪造来源和旧绑定，专家入口仍只委派一次', async () => {
  const handler = ipcHandlers.get('session-command')!
  const request = { kind: 'prompt', text: '不该发送', bindingId: session.bindingId }
  assert.equal((await handler({}, request) as SessionResult).ok, false)
  assert.equal((await invoke<SessionResult>('session-command', { ...request, bindingId: '旧绑定' })).ok, false)
  assert.equal(chats.length + sessionCommands.length, 0)
  const delegated = invoke('chat-send', '分析这份方案', '指定专家', false)
  const chat = await chatAt(0)
  assert.equal(chat.assistantId, '指定专家')
  assert.equal(chat.bindingId, session.bindingId)
  await answer(chat, '专家答复。')
  assert.equal((await delegated).reply, '专家答复。')
  assert.equal(sessionCommands.length, 0)
  assert.equal(narrator.requests.length, 0)
})

test('当前入口从文档讲解到追问再继续保持原句位置', async () => {
  assert.equal((await prompt('讲讲讲解样本', true)).ok, true)
  finishSentence()
  await answer(await chatAt(0))
  const original = narrator.requests.at(-1)!
  finishSentence()
  const asking = prompt('这里为什么要限制目录？', true)
  const question = await chatAt(1)
  assert.ok(question.text.includes(paragraphs[0]))
  question.onDelta!('为了保护未授权资料。')
  await answer(question, '为了保护未授权资料。')
  assert.equal((await asking).ok, true)
  assert.equal(finishSentence(), '为了保护未授权资料。')
  assertProgress(0)
  assert.equal((await prompt('继续')).ok, true)
  await nextTurn()
  assert.equal(chats.length, 2)
  assert.deepEqual(narrator.requests.at(-1), { ...original, fromIndex: 1 })
  assert.equal(finishSentence(), '再解释目录边界。')
})

test('无文档时普通继续仍走原生会话，文字提纲不被继续命令偷偷朗读', async () => {
  assert.equal((await prompt('继续')).ok, true)
  assert.equal(sessionCommands.length, 1)
  await prompt('讲讲讲解样本')
  assert.equal((await prompt('继续')).ok, false)
  assert.equal(narrator.requests.length, 0)
})

test('当前文档请求换绑后不能继续使用旧位置', async () => {
  assert.equal((await prompt('讲讲讲解样本', true)).ok, true)
  finishSentence()
  const old = await chatAt(0)
  bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, bindingId: '新文档绑定' } })
  assert.equal(old.signal?.aborted, true)
  await answer(old)
  assert.deepEqual(sent<DocState>('doc-state').at(-1), { kind: 'idle' })
  assert.equal(playing, null)
})

test('提纲解析不是已讲：选中第二段也不能把第一段标为播过', async () => {
  const result = await invoke('doc-explain', documentPath, 1, false)
  assert.equal(result.ok, true, result.error)
  assert.match(result.reply!, /共 3 段/)
  assert.equal(outline().total, 3)
  assertProgress(1)
  assert.equal(chats.length, 0)
  assert.equal(narrator.requests.length, 0)
  narrator.speak({ utteranceId: '无关播报', text: '这不是文档讲解。' })
  await nextTurn()
  finishSentence()
  assertProgress(1)
  assert.equal(chats.length, 0, '别的播报结束也不能自动推进纯文字提纲')
})

test('真实文件授权：目录外文档不能解析、播报或请求模型', async () => {
  const result = await invoke('doc-explain', outsidePath, 0, true)
  assert.equal(result.ok, false)
  assert.match(result.error!, /授权目录/)
  assert.equal(chats.length, 0)
  assert.equal(narrator.requests.length, 0)
})

test('生成与播放分开：只有本段最后一句完整播出才标已讲并请求下一段', async () => {
  const first = await startExplanation()
  assert.equal(first.assistantId, '讲解助理')
  assert.ok(first.signal instanceof AbortSignal)
  assert.equal(first.signal.aborted, false)
  assert.match(first.text, /第 1 段/)
  assert.ok(first.text.includes(paragraphs[0]))
  assert.ok(!first.text.includes(paragraphs[1]))
  assertProgress(0)
  await answer(first)
  assert.deepEqual(sent('doc-reply'), [{ index: 0, text: explanation }])
  assertProgress(0)
  assert.equal(finishSentence(), '先说明授权范围。')
  assertProgress(0)
  assert.equal(finishSentence(), '再解释目录边界。')
  assertProgress(0)
  assert.equal(chats.length, 1, '最后一句仍在播放时不得生成下一段')
  assert.equal(finishSentence(), '最后补充撤销方式。')
  assertProgress(1, [0])
  const second = await chatAt(1)
  assert.match(second.text, /第 2 段/)
  assert.ok(second.text.includes(paragraphs[1]))
  assert.ok(!second.text.includes(paragraphs[0]))
  await answer(second, '这是第二段的解释。')
  finishSentence()
  assertProgress(2, [0, 1])
  await answer(await chatAt(2), '这是第三段的解释。')
  finishSentence()
  const states = sent<DocState>('doc-state')
  const completed = states.filter(state => state.kind === 'outline').at(-1)!
  assert.equal(completed.next, 3)
  assert.ok(completed.sections.every(section => section.spoken))
  assert.deepEqual(states.at(-1), { kind: 'idle' })
  assert.match(sent<string>('doc-notice').at(-1)!, /讲完了/)
  assert.equal(chats.length, 3)
})

test('模型未回复时停止：刷新后的 next 仍为零，迟到回复不能复活讲解', async () => {
  const pending = await startExplanation()
  send('speech-stop')
  assert.equal(pending.signal?.aborted, true, '停止必须传到桥接请求的 AbortSignal')
  assertProgress(0)
  const requestsBefore = narrator.requests.length
  await answer(pending, '这条回复来得太晚，不能播放。')
  narrator.callbacks.onSpeaking?.(false)
  assertProgress(0)
  assert.equal(narrator.requests.length, requestsBefore)
  assert.deepEqual(sent('doc-reply'), [])
  assert.equal(chats.length, 1)
})

test('结束后切换同一文档：旧回复不进入新会话，新讲解不会被忙标志卡住', async () => {
  const old = await startExplanation()
  assert.equal((await prompt('结束讲解')).ok, true)
  assert.equal(old.signal?.aborted, true)
  assert.deepEqual(sent<DocState>('doc-state').at(-1), { kind: 'idle' })
  const resume = await prompt('继续讲解')
  assert.equal(resume.ok, false)
  assert.match(resume.error!, /没有可继续/)
  assert.equal((await invoke('doc-explain', documentPath, 0, true)).ok, true)
  finishSentence()
  assert.equal(chats.length, 1, '旧请求尚未收尾时不并发推进新链条')
  await answer(old, '旧会话的回复不能进入新文档。')
  assert.deepEqual(sent('doc-reply'), [])
  const current = await chatAt(1)
  assert.notEqual(current.signal, old.signal)
  await answer(current, '新会话的讲解。')
  assert.deepEqual(sent('doc-reply'), [{ index: 0, text: '新会话的讲解。' }])
  assertProgress(0)
})

test('追问先暂停并清队列；继续复用原回答，从未完整播出的原句编号恢复', async () => {
  await answer(await startExplanation())
  const original = narrator.requests.at(-1)!
  assert.equal(finishSentence(), '先说明授权范围。')
  const asking = invoke('doc-ask', documentPath, 0, '为什么限制目录？', '问答助理')
  assert.equal(narrator.isSpeaking(), false, '追问进入异步文档校验前就应停止播放')
  assert.equal(narrator.interrupts.at(-1), 'drop-queue')
  assert.ok(audioCommands.at(-1)?.stop)
  assertProgress(0)
  const question = await chatAt(1)
  assert.equal(question.assistantId, '问答助理')
  assert.match(question.text, /为什么限制目录/)
  assert.ok(question.text.includes(paragraphs[0]))
  assert.ok(!question.text.includes(paragraphs[1]))
  const requestCount = narrator.requests.length
  await answer(question, '仅限授权目录才能避免误读。')
  const result = await asking
  assert.equal(result.ok, true)
  assert.match(result.reply!, /继续讲解/)
  assert.equal(narrator.requests.length, requestCount, '追问答复不自动恢复原讲解')
  assertProgress(0)
  assert.equal((await prompt('继续讲解')).ok, true)
  await nextTurn()
  assert.equal(chats.length, 2, '继续只能复用缓存，不能重新让模型生成')
  assert.deepEqual(narrator.requests.at(-1), { ...original, fromIndex: 1 })
  assert.equal(playing?.id, `${original.utteranceId}#1`, '恢复编号不能重排为零或跳过被打断的半句')
  assert.equal(finishSentence(), '再解释目录边界。')
  assertProgress(0)
  assert.equal(playing?.id, `${original.utteranceId}#2`)
  send('speech-stop')
  await nextTurn()
  assertProgress(0, [])
  assert.equal(chats.length, 2, '最后一句被打断不能算本段完成')
  assert.equal((await prompt('继续讲解')).ok, true)
  await nextTurn()
  assert.deepEqual(narrator.requests.at(-1), { ...original, fromIndex: 2 })
  assert.equal(playing?.id, `${original.utteranceId}#2`)
  finishSentence()
  assertProgress(1, [0])
  assert.match((await chatAt(2)).text, /第 2 段/)
})

test('追问打断仍在生成的讲解：取消旧请求，迟到正文不能混入追问', async () => {
  const original = await startExplanation()
  const asking = invoke('doc-ask', documentPath, 1, '摘要为什么要变化？')
  assert.equal(original.signal?.aborted, true)
  const question = await chatAt(1)
  await answer(original, '已被取消的第一段讲解。')
  assert.deepEqual(sent('doc-reply'), [])
  assertProgress(0)
  await answer(question, '内容变化会改变摘要。')
  assert.equal((await asking).ok, true)
  assert.equal(narrator.requests.length, 1, '除了开场白，未完整返回的正文不得播出')
  assert.equal(narrator.isSpeaking(), false)
})

test('停止讲解命令保留半句位置，结束讲解命令清除会话', async () => {
  await answer(await startExplanation())
  const original = narrator.requests.at(-1)!
  finishSentence()
  const paused = await prompt('停止讲解')
  assert.match(paused.reply!, /保留位置/)
  assertProgress(0)
  assert.equal((await prompt('继续讲解')).ok, true)
  await nextTurn()
  assert.equal(chats.length, 1)
  assert.deepEqual(narrator.requests.at(-1), { ...original, fromIndex: 1 })
  await prompt('结束讲解')
  assert.deepEqual(sent<DocState>('doc-state').at(-1), { kind: 'idle' })
  assert.equal((await prompt('继续讲解')).ok, false)
  assert.equal(chats.length, 1)
})

test('旧会话的完成回调不能把同路径的新讲解标成已讲', async () => {
  await answer(await startExplanation(), '旧会话的一句解释。')
  const old = narrator.requests.at(-1)!
  await prompt('结束讲解')
  await answer(await startExplanation(), '新会话的一句解释。')
  assert.notEqual(narrator.requests.at(-1)!.utteranceId, old.utteranceId)
  narrator.callbacks.onSpoken?.({
    segment: { utteranceId: old.utteranceId, index: 0, text: old.text, origin: old.origin },
    complete: true,
  })
  assertProgress(0)
  assert.equal(chats.length, 2)
})

test('语音错误保留回答与句子位置，不提前标已讲或生成下一段', async () => {
  await answer(await startExplanation())
  const original = narrator.requests.at(-1)!
  finishSentence()
  deliver({ ok: false, error: '测试音频设备不可用' })
  assertProgress(0)
  assert.equal(chats.length, 1)
  assert.equal(narrator.isSpeaking(), false)
  assert.deepEqual(sent('speech-state').find(value => (value as { error?: string }).error), {
    speaking: false, error: '测试音频设备不可用',
  })
  await prompt('继续讲解')
  await nextTurn()
  assert.deepEqual(narrator.requests.at(-1), { ...original, fromIndex: 1 })
  assert.equal(playing?.id, `${original.utteranceId}#1`)
  assert.equal(chats.length, 1)
})

test('文档更新后追问与继续都拒绝旧定位，不播放缓存中的旧内容', async () => {
  await answer(await startExplanation())
  finishSentence()
  writeFileSync(documentPath, '更新后的第一段，与旧版位置不同。\n\n更新后的第二段。', 'utf8')
  const requestCount = narrator.requests.length
  const question = await invoke('doc-ask', documentPath, 0, '这里是什么？')
  assert.equal(question.ok, false)
  assert.match(question.error!, /定位已经失效/)
  assert.equal(narrator.isSpeaking(), false)
  assert.equal(chats.length, 1)
  const resumed = await prompt('继续讲解')
  assert.equal(resumed.ok, false)
  assert.match(resumed.error!, /文档已变化/)
  assert.deepEqual(sent<DocState>('doc-state').at(-1), { kind: 'idle' })
  assert.equal(narrator.requests.length, requestCount)
  assert.equal(chats.length, 1)
  assert.equal((await invoke('doc-explain', documentPath, 0, false)).ok, true)
  assert.equal(outline().total, 2, '重新解析后才能使用新的提纲')
  assertProgress(0)
})

test('撤销授权后继续拒绝读取，即使旧文档和回答都已缓存', async () => {
  await answer(await startExplanation())
  send('speech-stop')
  await invoke('doc-remove-root', authorized)
  const result = await prompt('继续讲解')
  assert.equal(result.ok, false)
  assert.match(result.error!, /授权范围/)
  assert.equal(chats.length, 1)
  assert.deepEqual(sent<DocState>('doc-state').at(-1), { kind: 'idle' })
})

for (const index of [-1, 3, 99, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`页面追问拒绝无效段号 ${index}，先暂停再校验且不调用模型`, async () => {
    await answer(await startExplanation())
    const result = await invoke('doc-ask', documentPath, index, '请解释所选段落。')
    assert.equal(result.ok, false)
    assert.match(result.error!, /段落不存在/)
    assert.equal(narrator.isSpeaking(), false)
    assert.equal(narrator.interrupts.at(-1), 'drop-queue')
    assertProgress(0)
    assert.equal(chats.length, 1)
  })
  test(`页面开始讲解拒绝无效段号 ${index}，不能悄悄改讲第一段或最后一段`, async () => {
    const result = await invoke('doc-explain', documentPath, index, true)
    assert.equal(result.ok, false, '页面选择的段号无效时必须拒绝，不能夹紧后播放其他段落')
    assert.match(result.error!, /段落|段号/)
    assert.equal(narrator.requests.length, 0)
    assert.equal(chats.length, 0)
  })
}

function voicePrompt(text: string, roundId: string, overrides: Partial<VoiceTurn> = {}): Promise<SessionResult & { reply?: string }> {
  return invoke('session-command', {
    kind: 'prompt', bindingId: session.bindingId, text, spoken: true,
    voiceTurn: { bindingId: session.bindingId, generation: 7, roundId, ...overrides },
  })
}
async function continuousVoice(on: boolean): Promise<void> {
  assert.equal((await invoke<{ ok: boolean }>('save-settings', { voiceConversation: on, continuousVoice: on })).ok, true)
}
const outcomes = () => sent<VoiceTurnCompletion>('voice-turn-complete').map(item => [item.roundId, item.outcome])

test('连续对话：句间空档不算播完，生成结束且最后一句播完才回执一次', async () => {
  await continuousVoice(true)
  try {
    const sending = voicePrompt('说说今天的安排', '7:1')
    const chat = await chatAt(0)
    chat.onDelta!('第一句。')
    await nextTurn()
    assert.equal(finishSentence(), '第一句。')
    await nextTurn()
    assert.deepEqual(outcomes(), [], '生成没结束，句间空档不能触发续听')
    chat.onDelta!('第二句。')
    await nextTurn()
    await answer(chat, '第一句。第二句。')
    assert.equal((await sending).ok, true)
    assert.deepEqual(outcomes(), [], '回复已返回但最后一句还没播完')
    assert.equal(finishSentence(), '第二句。')
    await nextTurn()
    assert.deepEqual(sent('voice-turn-complete'), [{ bindingId: session.bindingId, generation: 7, roundId: '7:1', outcome: 'played' }])
  } finally { await continuousVoice(false) }
})

test('连续对话：模型无回复回执 stopped，不续听', async () => {
  await continuousVoice(true)
  try {
    const sending = voicePrompt('随便问问', '7:2')
    ;(await chatAt(0)).resolve({ ok: false, error: '本轮失败' })
    assert.equal((await sending).ok, false)
    await nextTurn()
    assert.deepEqual(outcomes(), [['7:2', 'stopped']])
  } finally { await continuousVoice(false) }
})

test('连续对话：停止朗读立即回执 stopped，迟到终稿不复活也不重复回执', async () => {
  await continuousVoice(true)
  try {
    const sending = voicePrompt('讲一段', '7:3')
    const chat = await chatAt(0)
    chat.onDelta!('第一句。第二句。')
    await nextTurn()
    send('speech-stop')
    assert.deepEqual(outcomes(), [['7:3', 'stopped']])
    const count = narrator.requests.length
    await answer(chat, '第一句。第二句。迟到的一句。')
    await sending
    await nextTurn()
    assert.equal(playing, null)
    assert.equal(narrator.requests.length, count)
    assert.deepEqual(outcomes(), [['7:3', 'stopped']])
  } finally { await continuousVoice(false) }
})

test('连续对话：斜杠与文档路径退出连续模式，原有处理不变', async () => {
  await continuousVoice(true)
  try {
    assert.equal((await voicePrompt('/help', '7:4')).ok, true)
    const forwarded = sessionCommands.at(-1) as Extract<SessionCommand, { kind: 'prompt' }>
    assert.deepEqual([forwarded.text, forwarded.spoken, forwarded.voiceTurn], ['/help', false, undefined])
    assert.equal((await voicePrompt('讲讲讲解样本', '7:5')).ok, true)
    assert.equal(outline().total, 3)
    assert.deepEqual(outcomes(), [['7:4', 'excluded'], ['7:5', 'excluded']])
    assert.equal(chats.length, 0, '文档开场说明未播完，不能被连续对话提前推进')
  } finally { await continuousVoice(false) }
})

test('连续对话：选项关闭、轮次绑定不符或打字带轮次时拒绝，不请求模型', async () => {
  await continuousVoice(false)
  assert.equal((await voicePrompt('问一句', '7:6')).error, '连续对话选项已关闭')
  await continuousVoice(true)
  try {
    assert.equal((await voicePrompt('问一句', '7:7', { bindingId: '别的绑定' })).error, '连续对话轮次无效')
    const typed = await invoke<SessionResult>('session-command', {
      kind: 'prompt', bindingId: session.bindingId, text: '打字', spoken: false,
      voiceTurn: { bindingId: session.bindingId, generation: 7, roundId: '7:8' },
    })
    assert.equal(typed.error, '连续对话轮次无效')
    assert.equal(chats.length, 0)
    assert.equal(sessionCommands.length, 0)
  } finally { await continuousVoice(false) }
})

test('连续对话：关闭选项时停止本轮朗读并通知界面退出', async () => {
  await continuousVoice(true)
  const sending = voicePrompt('讲一段', '7:9')
  const chat = await chatAt(0)
  chat.onDelta!('第一句。')
  await nextTurn()
  await continuousVoice(false)
  assert.ok(sent('voice-conversation-stop').length >= 1)
  assert.deepEqual(outcomes(), [['7:9', 'stopped']])
  assert.equal(chat.signal?.aborted, true)
  await answer(chat, '第一句。')
  await sending
})

test('会话未开启时桌面开启一次并用新绑定；已在线时原样返回，不抢网页会话', async () => {
  const existing = await invoke<SessionResult & { outcome?: string }>('session-start')
  assert.equal(existing.ok, true)
  assert.equal(existing.outcome, 'existing')
  assert.equal(sessionStarts, 0, '已在线不得再请插件建会话')
  bridgeCallbacks.onEvent?.({ type: 'session/update', payload: {
    ...session, bindingId: '未绑定快照', status: 'disconnected', reset: true,
    capabilities: { ...session.capabilities, prompt: false, cancel: false },
  } })
  const opened = await invoke<SessionResult & { outcome?: string }>('session-start')
  assert.equal(opened.ok, true, opened.error)
  assert.equal(opened.outcome, 'created')
  assert.equal(opened.state?.bindingId, '桌面开启绑定')
  assert.equal(sessionStarts, 1)
  assert.equal((await invoke<SessionResult>('session-command', { kind: 'prompt', bindingId: '桌面开启绑定', text: '开启个人助理模式' })).ok, true)
  assert.deepEqual(sessionCommands.map(command => command.kind === 'prompt' ? [command.bindingId, command.text] : null), [['桌面开启绑定', '开启个人助理模式']])
  bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session, reset: true } })
})

test('打字点名 WPS 讲解：铺提纲并按指定应用打开，WPS 失败如实说明，不退回系统关联', async () => {
  wpsOpens.length = 0
  // 文件名"讲解样本"本身含讲解动词，这句按讲解意图处理：打字只铺提纲，同时把文件交给 WPS 打开。
  const result = await prompt('用wps打开讲解样本')
  assert.equal(result.ok, true)
  assert.equal(outline().total, 3)
  assert.match(result.reply ?? '', /WPS 没能打开《讲解样本.txt》：请先安装 WPS/)
  assert.equal(wpsOpens.length, 1)
  assert.equal(path.basename(wpsOpens[0]), '讲解样本.txt')
  assert.equal(chats.length, 0)
  assert.equal(sessionCommands.length, 0)
})

test('点名 WPS 语音讲解但不能同步：不开讲、不出声，也不悄悄换成阅读视图', async () => {
  const result = await prompt('用wps讲讲讲解样本', true)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /WPS 同步讲解目前只支持 PDF/)
  assert.equal(narrator.requests.length, 0)
  assert.equal(chats.length, 0)
  assert.notEqual(sent<DocState>('doc-state').at(-1)?.kind, 'outline', '没有装上讲解链')
})

test('讲解暂停后又打断了一次回答：一句“继续”不替用户猜，说明两件事并分别给出口令', async () => {
  await answer(await startExplanation())
  assert.match(finishSentence(), /先说明授权范围/)
  assert.equal((await prompt('停止讲解')).ok, true)
  const asking = prompt('顺便问一句别的', true)
  const chat = await chatAt(1)
  chat.onDelta!('回答的第一句。回答的第二句。')
  await nextTurn()
  assert.ok(playing, '回答已经开始播放')
  send('speech-stop')
  await answer(chat, '回答的第一句。回答的第二句。')
  await asking
  const requests = narrator.requests.length
  const ambiguous = await prompt('继续', true)
  assert.equal(ambiguous.ok, true)
  assert.match(ambiguous.reply ?? '', /有两件被打断的事：《讲解样本\.txt》的讲解，和刚才的回答/)
  assert.equal(narrator.requests.length, requests, '没有替用户选，任何一件都没恢复播放')
  assert.equal(chats.length, 2)
  const resumed = await prompt('继续讲解', true)
  assert.equal(resumed.ok, true)
  assert.ok(playing, '明确说继续讲解后从原句接着讲')
})

test('评委插话打断讲解：回答播完后自动接着讲，不用再说“继续讲解”', async () => {
  await answer(await startExplanation())
  assert.equal(finishSentence(), '先说明授权范围。')
  // 第 2 段正在播：讲解场景下主进程据此开插话监听
  assert.ok(narrator.isSpeaking())
  send('barge-in-detected')
  await nextTurn()
  assert.equal(narrator.isSpeaking(), false, '插话要先停掉正在播的讲解')

  const before = narrator.requests.length
  const asking = prompt('这个目录为什么只读？', true)
  const question = await chatAt(1)
  await answer(question, '只读是为了避免误改原始资料。')
  assert.equal((await asking).ok, true)
  assert.equal(narrator.requests.length, before + 1, '回答先播')
  assert.equal(finishSentence(), '只读是为了避免误改原始资料。')

  // 自动续讲在“生成结束 + 播完”之后才安排；生成收尾可能晚一拍，等到 4 秒。
  await new Promise(resolve => setTimeout(resolve, 4000))
  await nextTurn()
  assert.equal(narrator.requests.length, before + 2, '回答播完自动继续原讲解')
  assert.match(narrator.requests.at(-1)!.utteranceId, /^doc:/, '续讲的是原文档，不是新问题')
  finishSentence()
  send('speech-stop')
  await nextTurn()
})
