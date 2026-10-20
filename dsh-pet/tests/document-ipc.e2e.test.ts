/**
 * 文档 IPC 集成测试：沿用 desktop.e2e.test.ts 的 Electron 模块替身装配真实主进程。
 * 文档读取、授权、指纹、提示词、讲解状态与播出回调均用生产实现。
 * 播放器替身只记录请求，继承真实 Narrator；用假音频传输手动确认完成，不复制状态机。
 * 桥接故意允许取消后迟到的回复，验证主进程不能只依赖传输取消来防止旧讲解复活。
 */
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import type { BridgeCallbacks, ChatReply } from '../src/main/harness.ts'
import type { InterruptLevel, SpeechRequest } from '../src/main/speech.ts'
import { Narrator, type NarratorHooks, type TtsTransport, type TtsWorkerEvent } from '../src/main/tts.ts'
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
const authorized = path.join(sandbox, 'authorized')
mkdirSync(authorized)
const documentPath = path.join(authorized, '讲解样本.txt')
const outsidePath = path.join(sandbox, '未授权样本.txt')
const paragraphs = ['第一段原文：授权范围只包含所选目录。', '第二段原文：缓存根据内容摘要失效。', '第三段原文：播出完成才推进位置。']
const explanation = '先说明授权范围。再解释目录边界。最后补充撤销方式。'
writeFileSync(outsidePath, '这份文档没有获得授权。', 'utf8')

const chatEvents = new EventEmitter()
const session: SessionSnapshot = {
  sessionId: '测试会话', bindingId: '测试绑定', cursor: 0, title: '入口回归', status: 'idle', entries: [], hasMore: false,
  model: null, models: [], permission: null, permissions: [],
  capabilities: { prompt: true, cancel: true, models: false, permissions: false, history: true },
}
let bridgeCallbacks: BridgeCallbacks
const sessionCommands: SessionCommand[] = []
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
const quit = deferred<void>()
let windows = 0
let stage: FakeBrowserWindow
class FakeBrowserWindow {
  webContents = {
    mainFrame: {},
    send(channel: string, payload: unknown) { messages.push({ channel, payload }) },
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
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [authorized] }) },
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
  chat.resolve({ ok: true, reply: text })
  await nextTurn()
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
  bridgeCallbacks.onEvent?.({ type: 'session/update', payload: { ...session } })
  messages.length = 0
  narrator.requests.length = 0
  narrator.interrupts.length = 0
  audioCommands.length = 0
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
