/**
 * dsh-pet 主进程：铺满工作区的透明置顶角色窗口、IPC 桥接、形象切换、托盘常驻与运行时启动握手。
 *
 * 生命周期分成两层，别混在一起看：
 * - 窗口层（本文件）：建窗、鼠标穿透、自愈重载、退场动画。
 * - 壳层（`companion-host.ts`）：托盘、启动 dsh 团队运行时的分阶段握手、运行时所有权。
 * 壳层活着不代表角色可见，角色可见也不代表运行时连上了 —— 这两件事各自有各自的状态。
 */
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, safeStorage, screen, shell, systemPreferences, type MenuItemConstructorOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { ApprovalWindow } from './approval-window.ts'
import { createStreamingSession, pcm16Base64ToFloat32, streamingAvailable, transcribeWav, type StreamingSession } from './asr.ts'
import { INITIAL_AUDIO_STATE, nextAudio, type AudioEvent, type AudioState, type AudioTransition } from './audio.ts'
import { CompanionHost } from './companion-host.ts'
import { createDocFileSystem } from './doc-fs.ts'
import {
  askPrompt,
  describeOutline,
  detectDocIntent,
  DocumentLibrary,
  explainPrompt,
  MAX_DOC_BYTES,
  mentionsDocs,
  stemOf,
  type DocFile,
  type OpenResult,
  type Outline,
  type ParseResult,
} from './document.ts'
import { BridgeClient, type ChatReply } from './harness.ts'
import {
  addDocRoot,
  docSearchRoots,
  forgetDocDir,
  loadSettings,
  rememberDocDir,
  removeDocRoot,
  saveSettings,
  type PetId,
} from './settings.ts'
import { Narrator, spawnTtsEdgeWorker } from './tts.ts'
import { VoiceApiStore, transcribeApi } from './voice-api.ts'
import type { VoiceApiKind, VoiceApiResult, VoiceApiState, ResolvedVoiceApi } from '../voice-api-types.ts'
import { createMeetingRecorder, markAssistantSpeech, registerMeetingIpc, type MeetingRecorder } from './meeting-recorder.ts'
import { splitIntoSegments } from './speech.ts'
import { startWakeListener, stopWakeListener } from './wake.ts'
import { PointerWatcher } from './pointer-watch.ts'
import { platformOf, recordAudioSpec, supportsGlobalPointerWatch, supportsWakeWord } from './platform.ts'
import { isSessionCommand, shouldDismissOverlay, validBoxes, type OverlayBox } from './overlay-state.ts'
import type { SessionCommand, SessionSnapshot, SessionUpdate, SessionResult } from '../session-types.ts'
import type { SettingsPage } from '../renderer/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))

function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

let win: BrowserWindow | null = null
let ignoreMouse = true
const bridge = new BridgeClient()
let sessionState: SessionSnapshot | null = null
let sessionRevision = 0
let overlayOpen = false
let managementOpen = false
let overlayBoxes: OverlayBox[] = []
let dismissAfter = 0
let contextMenuOpen = false
let submissionCount = 0

/**
 * 全局鼠标监听只在 Windows 上有实现（见 `platform.ts`）。
 *
 * 非 Windows 上**不启用**：`PointerWatcher` 会如实报"这个能力没有"，而界面会把那句报错
 * 弹成 toast —— 用户看到的是"宠物坏了"，实际只是"点面板外面收起"这一个便利功能缺了。
 * 这里静默降级，缺的能力在平台上本来就是已知的、无法修的，没有理由打扰用户。
 */
const pointerWatchSupported = supportsGlobalPointerWatch(platformOf())
function setPointerWatch(enabled: boolean): void {
  if (!pointerWatchSupported) return
  pointerWatcher.setEnabled(enabled)
}

const pointerWatcher = new PointerWatcher(path.join(here, '../assets/pointer-watch.ps1'), press => {
  if (!win || !win.isVisible()) return
  const point = screen.screenToDipPoint({ x: press.x, y: press.y })
  const bounds = win.getBounds()
  const internalWindow = press.pid === process.pid && BrowserWindow.getAllWindows().some(window => window !== win && window.isVisible())
  if (!shouldDismissOverlay({
    open: overlayOpen,
    running: submissionCount > 0 || sessionState?.status === 'running' || sessionState?.status === 'waiting',
    blocked: contextMenuOpen || managementOpen || internalWindow,
    after: dismissAfter,
    boxes: overlayBoxes,
  }, { x: point.x - bounds.x, y: point.y - bounds.y, time: press.time })) return
  overlayOpen = false
  setPointerWatch(managementOpen)
  win.webContents.setBackgroundThrottling(!managementOpen)
  sendToRenderer('overlay-dismiss', null)
}, message => sendToRenderer('overlay-error', message))

function acceptSession(update: SessionUpdate): void {
  if (sessionState?.bindingId === update.bindingId && update.cursor < sessionState.cursor) return
  const wasRunning = sessionState?.status === 'running' || sessionState?.status === 'waiting'
  const changed = sessionState?.bindingId !== update.bindingId
  if (sessionState && (changed || update.status === 'disconnected')) {
    interruptSpeech(false)
    interruptedSpeech = null
    stopDocTalk()
    pushDocState()
  }
  sessionState = update
  sessionRevision += 1
  if (changed || (wasRunning && update.status !== 'running' && update.status !== 'waiting')) dismissAfter = Date.now()
  sendToRenderer('session-update', update)
}

function openSettings(page: SettingsPage): void {
  if (!win) return
  managementOpen = true
  dismissAfter = Date.now()
  setPointerWatch(true)
  win.show()
  win.focus()
  sendToRenderer('settings-open', page)
}

function stageSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
}

/**
 * 专用审批窗口。批准只能从这里签发。
 *
 * 舞台面板上没有"直接批准"这条 IPC 通道，只有一个 `approval-open`：它报出想批哪条提案，
 * 提案的内容由这里自己去桥接取，决定由专用窗口回来，回执还要过 `checkSender`。
 * 舞台渲染器上显示的是模型写的文本，让同一个渲染器能签发批准，等于让不可信内容
 * 有能力影响签发路径 —— 详见 `approval-window.ts` 的文件头。
 */
const approvals = new ApprovalWindow(bridge)
/** 壳层。app ready 之后才建（要用 userData 目录），所以这里是延迟赋值。 */
let host: CompanionHost | null = null
/**
 * 用户自配的 TTS / 语音识别服务（OpenAI 兼容）。密钥用系统密钥库（DPAPI）加密落盘，
 * 只在主进程里解开送给请求；页面拿到的列表里永远没有密钥本体。
 */
let voiceApiStore: VoiceApiStore | null = null

function createWindow(): void {
  const display = screen.getPrimaryDisplay().workArea

  win = new BrowserWindow({
    width: display.width,
    height: display.height,
    x: display.x,
    y: display.y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  void win.loadFile(path.join(here, '../renderer/index.html'))
  win.webContents.on('render-process-gone', (_event, details) => {
    console.log('[dsh-pet] renderer gone:', details.reason, details.exitCode)
    // 透明窗口的 GPU 合成在息屏等场景偶发硬崩溃：自愈重载，避免宠物直接消失
    if (win && !win.isDestroyed() && !exitRequested) {
      setTimeout(() => {
        if (win && !win.isDestroyed()) void win.reload()
      }, 1000)
    }
  })
  win.on('closed', () => {
    overlayOpen = false
    managementOpen = false
    overlayBoxes = []
    setPointerWatch(false)
    win = null
  })
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

/**
 * 显示/隐藏角色。
 *
 * 两个方向都是先通知渲染层、再改窗口可见性：隐藏时渲染层先把舞台卸掉，共享场景时钟的
 * 最后一个订阅者随之退订、定时器停掉 —— 藏起来的五个角色不该继续每 16ms 空转一圈；
 * 显示时舞台在窗口露出之前就挂好了，用户不会先看到一片空桌面再看到角色出现。
 */
/** 主动提醒评估要用的桌面状态：插件侧靠它实现"会议与免打扰不提醒"（design.md §2.7）。 */
let petStageVisible = true
let petFocusMode = false

function reportPetState(): void {
  void bridge.reportPetState({ focus: petFocusMode, visible: petStageVisible })
}

function applyStageVisible(visible: boolean): void {
  petStageVisible = visible
  reportPetState()
  sendToRenderer('stage-visible', visible)
  if (!win || win.isDestroyed()) return
  if (visible) {
    if (!win.isVisible()) win.showInactive()
  } else {
    overlayOpen = false
    managementOpen = false
    overlayBoxes = []
    setPointerWatch(false)
    if (win.isVisible()) win.hide()
  }
}

/**
 * 麦克风仲裁器：这台机器上只有一个默认录音设备，唤醒词监听与按键听写必须轮流用。
 *
 * 规则全在 `audio.ts` 的纯函数里，这里只做两件事 —— 把状态存住，把副作用执行掉。副作用只有
 * 起/停唤醒监听两种：起两次会留下一个抢麦克风的孤儿进程（它拿静音流，日志还一切正常），
 * 所以"起停份数和持有者始终对得上"这条被穷举测试钉住了。
 */
let audioState: AudioState = INITIAL_AUDIO_STATE

function applyAudio(event: AudioEvent): AudioTransition {
  const turn = nextAudio(audioState, event)
  audioState = turn.state
  for (const effect of turn.effects) {
    if (effect === 'start-wake') {
      // 平台上压根没有唤醒词能力时，**同步**把状态改掉，而不是走 onWakeLost 回调。
      //
      // 走回调会造成同步重入：applyAudio → startWakeListener → onLost → applyAudio。
      // 里层那次会看到"外层的 audioState 刚被写进去、但 effects 还没执行完"的中间态，
      // 于是 stopWakeListener 被调用在一个还没启动的监听上，状态机与进程的真实情况就分家了。
      // 这条分支的结论是确定的（能力不存在，不用等任何事件），所以直接改状态最干净。
      if (!supportsWakeWord(platformOf())) {
        audioState = { ...audioState, holder: null, wakeUnavailable: true }
        console.log('[dsh-pet] 语音唤醒只在 Windows 上可用；按键听写与快捷键不受影响')
        continue
      }
      startWakeListener(onWakeWord, onWakeLost)
    } else {
      stopWakeListener()
    }
  }
  return turn
}

function onWakeWord(): void {
  // 用户是冲着说话来的：角色藏着就先叫出来，别对着一个隐藏窗口说话。
  host?.setStageVisible(true)
  sendToRenderer('wake-triggered', null)
}

function onWakeLost(reason: string): void {
  applyAudio({ type: 'wake-lost' })
  // 只写日志，不往渲染层发：界面上还没有读这条的地方，发过去就是个没人接的事件。
  // 用户修好麦克风之后的恢复入口是托盘上"重新监听唤醒词"。
  console.log('[dsh-pet] 唤醒词监听不可用（按键说话仍然可用）：', reason)
}

/**
 * 正在进行的那一轮语音问答。打字发起的轮次是 null。
 *
 * 取消会结束本地请求等待并阻止迟到播报；未取得服务端终止证据前，不声称后台任务已取消。
 */
let spokenRound: { cancelled: boolean; controller: AbortController; utteranceId: string } | null = null

function interruptSpeech(remember = true): void {
  pauseDocTalk()
  if (spokenRound) {
    spokenRound.cancelled = true
    spokenRound.controller.abort()
    narrator.dropFeed(spokenRound.utteranceId)
    narrator.generationEnded()
    spokenRound = null
  }
  const wasSpeaking = narrator.isSpeaking()
  narrator.interrupt('drop-queue')
  if (remember && wasSpeaking) interruptedSpeech = narrator.interruptedContext()
}

function withInterruptedSpeech(text: string): string {
  const heard = interruptedSpeech
  interruptedSpeech = null
  return heard === null ? text : `（上一段讲解被打断了。${heard}。若我要你接着讲，请从这里往下。）\n${text}`
}

async function sendChatReply(text: string, bindingId: string, spoken: boolean, assistantId?: string): Promise<ChatReply> {
  interruptSpeech()
  const outgoing = withInterruptedSpeech(text)
  const round = spoken ? { cancelled: false, controller: new AbortController(), utteranceId: `session-${randomUUID()}` } : null
  spokenRound = round
  if (round) {
    narrator.beginRound()
    narrator.generationStarted()
  }
  const current = () => bindingId === sessionState?.bindingId && sessionState.status !== 'disconnected'
    && (round === null || (spokenRound === round && !round.cancelled))
  let fedChars = 0
  try {
    const reply = await bridge.chat(outgoing, assistantId, round?.controller.signal, round ? delta => {
      if (!current()) return
      fedChars += delta.length
      narrator.feed(round.utteranceId, delta)
    } : undefined, bindingId)
    if (bindingId !== sessionState?.bindingId || sessionState.status === 'disconnected') {
      return { ok: false, error: '会话已改变，原会话的回复已丢弃' }
    }
    if (!current()) return { ok: true }
    if (round) {
      if (reply.ok && reply.reply) {
        if (fedChars > 0) narrator.feedEnd(round.utteranceId)
        else narrator.speak({ utteranceId: round.utteranceId, text: reply.reply })
      } else {
        interruptSpeech()
      }
    }
    return reply
  } catch (error) {
    if (round && current()) interruptSpeech()
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (round && spokenRound === round) {
      narrator.generationEnded()
      spokenRound = null
    }
  }
}

/**
 * 上一轮被打断的讲解，实际播出了什么。
 *
 * 计划 §2.8 要求打断之后交给模型的上下文只能是用户实际听到的内容。少了这一层，模型会以为
 * 结论已经送达而接着往下讲，用户听到的却是半句话加一段沉默。所以这里留一份，在用户下一次
 * 开口时随消息一起送过去，送完即清 —— 一直挂着，三轮之后的消息里还在解释第一轮被打断的事。
 */
let interruptedSpeech: string | null = null

/**
 * 文档查找与讲解（design.md §2.10）。
 *
 * 规则（授权边界、按名字挑、结构化提取、提示词）都在 `document.ts`，磁盘与系统关联在
 * `doc-fs.ts`，这里只做接线：把聊天里的文档意图接过来、把讲解进度投影到界面上。
 *
 * 授权目录每次现取：用户随时可能在面板上增删，缓存一份就等于撤销不生效。
 */
const documents = new DocumentLibrary(createDocFileSystem(), docSearchRoots)

/**
 * 正在逐段讲解的那一份文档。打字或语音问一句普通问题是 null。
 *
 * 讲解必须一段一段来：每讲一段都要先请模型讲一遍，再把回答念出来。一次把整份文档塞进
 * 朗读队列做不到这件事，而一次把整份文档塞给模型正是 §2.10 明令不要的。
 */
interface DocTalk {
  readonly path: string
  readonly name: string
  readonly outline: Outline
  /**
   * 解析这份文档时的内容摘要。
   *
   * 朗读位置按摘要索引而不是按路径索引：文档改过之后摘要就变了，旧位置自然对不上，
   * 续讲会从头开始 —— 这正是 §2.10 要的"旧定位失效"，不需要额外去清一遍。
   */
  readonly fingerprint: string
  /** 讲这份文档时点名给谁。没点名就由总助理接待。 */
  readonly assistantId?: string
  /**
   * 这条链要不要出声。
   *
   * 打字要来的讲解只在面板上铺文字：壳里已有的规矩是"打字问的话突然出声，是用户没要求过的
   * 行为"，讲解也不例外。而且不出声就没有"念完了"这个节拍，一段接一段会连着打十几次模型，
   * 没有任何东西给它限速。
   */
  readonly spoken: boolean
  /** 下一段要讲的下标。 */
  next: number
  readonly sessionId: string
  readonly bindingId?: string
  readonly completed: Set<number>
  readonly explanations: Map<number, string>
  /** 用户按了停止、换了话题或者合成失败就置起来，别让链条在后台自己往下走。 */
  stopped: boolean
}

let docTalk: DocTalk | null = null
/** 链条推进中。onSpeaking 可能连着触发，不挡住就会并行讲两段。 */
let docTalkBusy = false
let docRevision = 0
let docRequest: AbortController | null = null
let meetingRecorder: MeetingRecorder | null = null
let assistantSpeechStartedAt: number | null = null

function pauseDocTalk(): void {
  docRevision += 1
  if (docTalk !== null) docTalk.stopped = true
  docRequest?.abort()
  docRequest = null
}

function stopDocTalk(): void {
  pauseDocTalk()
  docTalk = null
}

function docUtteranceId(talk: DocTalk, index: number): string {
  return `doc:${talk.sessionId}:${talk.fingerprint}:${index}`
}

/** 讲解进度投影到界面。界面只是投影，位置的真值在这里。 */
function pushDocState(): void {
  const talk = docTalk
  if (talk === null) {
    sendToRenderer('doc-state', { kind: 'idle' })
    return
  }
  sendToRenderer('doc-state', {
    kind: 'outline',
    path: talk.path,
    title: talk.outline.title,
    estMinutes: talk.outline.estMinutes,
    total: talk.outline.sections.length,
    next: talk.next,
    sections: talk.outline.sections.map((section) => ({
      index: section.index,
      pageNumber: section.pageNumber,
      heading: section.heading,
      hasCode: section.hasCode,
      spoken: talk.completed.has(section.index),
    })),
  })
}

/**
 * 装上这条讲解链并投影到界面，不出声。
 *
 * 打字要来的讲解走这条：提纲铺在面板上，用户点某一段或者点"开始朗读"再由 `startDocTalk` 接手。
 */
function installDocTalk(talk: DocTalk): void {
  stopDocTalk()
  interruptSpeech()
  docTalk = talk
  pushDocState()
}

/**
 * 从某一段开始逐段讲解。段号越界或者文档读不出结构时什么都不做，由调用方先报过原因。
 *
 * `prelude` 是开讲之前要先说的那一句（"共几段、大约几分钟"）。它必须夹在装链和推进之间
 * 入队：装链那一步会 drop-queue，先入队就被丢掉了；而推进要先等模型回话，晚一步入队
 * 也仍然排在第一段前面。这个顺序不写在这里，调用方迟早会写反。
 */
function startDocTalk(talk: DocTalk, prelude?: { utteranceId: string; text: string }): void {
  installDocTalk(talk)
  if (prelude !== undefined) {
    // 开场白单独算一轮：它被打断时该报的是"范围还没说完"，跟第一段讲了多少无关。
    narrator.beginRound()
    narrator.speak(prelude)
  }
  void advanceDocTalk()
}

/**
 * 讲下一段。
 *
 * 用循环而不是一段一返回：只有代码、没有正文的段念不出声音，播放器不会再报一次"念完了"，
 * 停在那儿等就是整条链断在这里。跳过它继续往下，直到真的排上了一段或者讲完为止。
 */
async function advanceDocTalk(): Promise<void> {
  if (docTalkBusy) return
  const talk = docTalk
  // 不出声的链条不自动往下走。它只是把提纲装在面板上，而 onSpeaking 是别人的语音轮次
  // 结束时也会触发的 —— 捡起来就是一条没有播放节拍限速的链，几十段连着打几十次模型。
  if (talk === null || talk.stopped || !talk.spoken || narrator.isSpeaking()) return
  docTalkBusy = true
  try {
    while (docTalk === talk && !talk.stopped && talk.next < talk.outline.sections.length) {
      const index = talk.next
      if (talk.outline.sections[index].text === '') {
        talk.next++
        pushDocState()
        continue
      }
      let explanation = talk.explanations.get(index)
      if (explanation === undefined) {
        const prompt = explainPrompt(talk.name, talk.outline, index)
        const request = new AbortController()
        docRequest = request
        const reply = await bridge.chat(prompt, talk.assistantId, request.signal, undefined, talk.bindingId)
        if (docRequest === request) docRequest = null
        if (docTalk !== talk || talk.stopped || request.signal.aborted || talk.bindingId !== sessionState?.bindingId) return
        if (!reply.ok || !reply.reply) {
          sendToRenderer('doc-notice', reply.error ? `第 ${index + 1} 段讲不下去：${reply.error}` : `第 ${index + 1} 段没有讲出内容`)
          pauseDocTalk()
          pushDocState()
          return
        }
        explanation = reply.reply
        talk.explanations.set(index, explanation)
        sendToRenderer('doc-reply', { index, text: explanation })
      }
      const utteranceId = docUtteranceId(talk, index)
      narrator.beginRound()
      narrator.speak({
        utteranceId,
        text: explanation,
        fromIndex: narrator.resumeFrom(utteranceId),
        origin: { docPath: talk.path, paragraph: index },
      })
      if (narrator.isSpeaking()) return
      if (talk.completed.has(index)) continue
      pauseDocTalk()
      pushDocState()
      sendToRenderer('doc-notice', '讲解未能播放，已保留位置；请检查语音后继续。')
      return
    }
    if (docTalk === talk && !talk.stopped) {
      sendToRenderer('doc-notice', `《${talk.outline.title}》讲完了`)
      stopDocTalk()
      pushDocState()
    }
  } finally {
    docTalkBusy = false
    // 等模型的时候用户换了文档：新链条在 startDocTalk 里被 busy 挡回去了，旧链条退出后
    // 没人再推它，而它等的那个"念完了"永远不会来。这里补一次。
    const next = docTalk
    if (next !== null && !next.stopped && !narrator.isSpeaking()) void advanceDocTalk()
  }
}

/** 解析结果里"讲不了"的原因。能讲就是空串 —— 调用方据此判断要不要报。 */
function parseProblem(parsed: ParseResult): string {
  if (parsed.kind === 'outline') return ''
  return parsed.kind === 'empty' ? '里面没有念得出的正文' : parsed.reason
}

/**
 * 讲不了、打不开的原因，翻成一句能说给用户听的话。
 *
 * document.ts 已经把每种失败都分了类，这里只负责措辞。分类报出来是有用处的：用户听到
 * "不在授权目录里"会去加目录，听到"读不出来"只会觉得这东西坏了。
 */
function unparseable(result: OpenResult): string {
  switch (result.kind) {
    case 'denied':
      return '它不在授权目录里'
    case 'missing':
      return '它已经不在原来的位置了'
    case 'too-big': {
      const mb = (size: number): string => (size / (1024 * 1024)).toFixed(1)
      return `它有 ${mb(result.size)}MB，超过 ${mb(MAX_DOC_BYTES)}MB 的解析上限`
    }
    case 'unreadable':
      return `读不出来（${result.reason}）`
    case 'opened':
      return parseProblem(result.doc.parsed)
  }
}

/** 重名不自己挑（§2.10："多个重名结果让用户选，禁止全盘搜到第一个就打开"）。 */
function pushDocChoices(name: string, hits: readonly DocFile[]): void {
  sendToRenderer('doc-state', {
    kind: 'choose',
    name,
    hits: hits.map((hit) => ({ path: hit.path, name: hit.name, size: hit.size, mtimeMs: hit.mtimeMs })),
  })
}

/** 查找这一步的三种收场：拿到了文件、要用户挑、或者已经有一句该说的话。 */
type DocLookup =
  | { readonly kind: 'file'; readonly hit: DocFile }
  | { readonly kind: 'reply'; readonly reply: ChatReply }

async function lookupDoc(name: string): Promise<DocLookup> {
  const search = await documents.search(name)
  switch (search.kind) {
    case 'found':
      return { kind: 'file', hit: search.hit }
    case 'ambiguous':
      pushDocChoices(name, search.hits)
      return {
        kind: 'reply',
        reply: { ok: true, reply: `找到 ${search.hits.length} 份名字相近的文档，你在面板上挑一份。` },
      }
    case 'missing':
      return { kind: 'reply', reply: { ok: false, error: `在授权目录里没找到"${name}"。` } }
    case 'denied':
      return { kind: 'reply', reply: { ok: false, error: `"${name}"不在授权目录里，不能打开。` } }
  }
}

/**
 * 「打开某文档」：交给系统的文件关联，不拼 shell 命令（§2.10）。
 *
 * 打开成功顺手解析一次：一是能说清楚这份文档能不能讲，二是把结果留在库里，用户接着说
 * "讲讲"就不用再读一遍磁盘。
 */
async function openDocByName(name: string): Promise<ChatReply> {
  const lookup = await lookupDoc(name)
  if (lookup.kind === 'reply') return lookup.reply
  return openDocByPath(lookup.hit.path)
}

async function openDocByPath(target: string): Promise<ChatReply> {
  const revealed = await documents.reveal(target, rememberDocDir)
  if (!revealed.ok) return { ok: false, error: `打不开：${revealed.error}` }
  const parsed = await documents.open(target)
  // 能开不等于能讲，分开报：只说"打开了"，用户下一步会说"讲讲"，然后被一句失败糊在脸上。
  return parsed.kind === 'opened' && parsed.doc.parsed.kind === 'outline'
    ? { ok: true, reply: `已经打开《${parsed.doc.name}》。想听讲解就说"讲讲${stemOf(parsed.doc.name)}"。` }
    : { ok: true, reply: `已经打开《${path.basename(target)}》。${unparseable(parsed)}，只能打开给你看。` }
}

/**
 * 「讲讲某文档」：先给提纲和估计时长，再逐段讲（§2.10）。
 *
 * 提纲是本地算出来的，不花一次模型调用 —— 让模型去复述文档结构，等于先把整份文档塞给它，
 * 正是那一节明令不要的做法。
 */
async function explainDocByName(name: string, from: number, speak: boolean, assistantId?: string): Promise<ChatReply> {
  const lookup = await lookupDoc(name)
  if (lookup.kind === 'reply') return lookup.reply
  return explainDocByPath(lookup.hit.path, from, speak, assistantId)
}

async function explainDocByPath(
  target: string,
  from: number,
  speak: boolean,
  assistantId?: string,
  strictSection = false,
): Promise<ChatReply> {
  const bindingId = sessionState?.bindingId
  const revision = docRevision
  const opened = await documents.open(target)
  if (bindingId !== sessionState?.bindingId || revision !== docRevision) return { ok: false, error: '会话已改变或讲解已停止，未开始原文档讲解' }
  if (opened.kind !== 'opened') return { ok: false, error: `《${path.basename(target)}》讲不了：${unparseable(opened)}` }
  if (opened.doc.parsed.kind !== 'outline') {
    return { ok: false, error: `《${opened.doc.name}》讲不了：${parseProblem(opened.doc.parsed)}` }
  }

  const outline = opened.doc.parsed.outline
  // 界面点出来的段号必须原样有效：夹一下等于用户点了第 3 段却听第 12 段，还以为文档就是这么写的。
  if (strictSection && (!Number.isInteger(from) || from < 0 || from >= outline.sections.length)) {
    return { ok: false, error: `段号 ${String(from)} 不存在：本文共 ${outline.sections.length} 段，请重新选择。` }
  }
  const talk: DocTalk = {
    path: opened.doc.path,
    name: opened.doc.name,
    outline,
    fingerprint: opened.doc.fingerprint,
    assistantId,
    spoken: speak,
    next: clampSection(from, outline.sections.length),
    sessionId: randomUUID(),
    bindingId,
    completed: new Set(),
    explanations: new Map(),
    stopped: false,
  }
  // 提纲算一次，两处共用：语音那条路念它的第一行，回执铺它的全部。
  const described = describeOutline(outline)
  if (speak) {
    startDocTalk(talk, {
      utteranceId: `doc-outline:${opened.doc.fingerprint}`,
      // 提纲不逐行念（四十行标题念完用户早走了），但"共几段、大约几分钟"必须先说出口：
      // §2.10 要的是先给范围再逐段讲，而语音这条路上面板可能根本没打开，这句就是唯一的展示。
      text: described.split('\n')[0],
    })
  } else {
    installDocTalk(talk)
  }

  const lines = [described]
  // 改过就要说一声：用户记着的"上次讲到第三段"在新版本里指的是别的内容（§2.10：旧定位失效）。
  if (opened.changed) lines.push('这份文档改过了，之前讲到的位置对不上了，重新从头算。')
  lines.push(
    speak
      ? `从第 ${talk.next + 1} 段开始讲，说"停"或者按停止就停下。`
      : `点提纲里的某一段就从那儿开始讲；这一份不会自己出声。`,
  )
  return { ok: true, reply: lines.join('\n') }
}

/** 段号夹进有效范围。用户说"讲第 99 段"而文档只有 12 段时，讲最后一段比报错有用。 */
function clampSection(from: number, total: number): number {
  if (!Number.isFinite(from) || from <= 0) return 0
  return Math.min(Math.floor(from), Math.max(total - 1, 0))
}

/**
 * 针对某一段追问（§2.10："定位到第三页这个概念"）。
 *
 * 只接受界面上点出来的段号，不从消息里猜。把一段原文附上，比让模型凭标题瞎想要靠谱，
 * 也比把整份文档再塞一遍便宜。
 */
async function resumeDocTalk(spoken: boolean): Promise<ChatReply> {
  const talk = docTalk
  if (!talk) return { ok: false, error: '没有可继续的文档讲解，请先选择文档。' }
  if (!talk.spoken && !spoken) return { ok: false, error: '当前是文字提纲，请在文档页选择段落开始朗读。' }
  interruptSpeech()
  const revision = docRevision
  const opened = await documents.open(talk.path)
  if (docTalk !== talk || revision !== docRevision) return { ok: false, error: '文档讲解已切换或停止。' }
  if (opened.kind !== 'opened' || opened.doc.fingerprint !== talk.fingerprint) {
    stopDocTalk()
    pushDocState()
    return { ok: false, error: '文档已变化或不在授权范围，请重新解析后讲解。' }
  }
  if (!talk.spoken) return explainDocByPath(talk.path, talk.next, true, talk.assistantId)
  talk.stopped = false
  void advanceDocTalk()
  return { ok: true, reply: `继续《${talk.name}》，从上次未完整播放的句子接着讲。` }
}

async function askAboutDoc(target: string, index: number, question: string, assistantId?: string, spoken = false): Promise<ChatReply> {
  const talk = docTalk
  const bindingId = sessionState?.bindingId
  interruptSpeech()
  pushDocState()
  const revision = docRevision
  const opened = await documents.open(target)
  if (bindingId !== sessionState?.bindingId || docTalk !== talk || revision !== docRevision) return { ok: false, error: '会话或文档讲解已切换或停止。' }
  if (opened.kind !== 'opened' || opened.doc.parsed.kind !== 'outline'
    || (talk?.path === opened.doc.path && talk.fingerprint !== opened.doc.fingerprint)) {
    return { ok: false, error: `《${path.basename(target)}》的定位已经失效了，请重新解析再问。` }
  }
  if (!Number.isInteger(index) || index < 0 || index >= opened.doc.parsed.outline.sections.length) {
    return { ok: false, error: '该段落不存在，请重新选择提纲中的段落。' }
  }
  const request = new AbortController()
  if (!spoken) docRequest = request
  const prompt = askPrompt(opened.doc.name, opened.doc.parsed.outline, index, question)
  try {
    const result = spoken && bindingId
      ? await sendChatReply(prompt, bindingId, true, assistantId)
      : await bridge.chat(withInterruptedSpeech(prompt), assistantId, request.signal, undefined, bindingId)
    if (request.signal.aborted || bindingId !== sessionState?.bindingId || docTalk !== talk) {
      return { ok: false, error: '追问已停止或会话已切换，旧回答已丢弃。' }
    }
    return result.ok && result.reply
      ? { ...result, reply: `${result.reply}\n\n要继续原来的讲解，可以说“继续讲解”；也可以选择其他段落或结束。` }
      : result
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (docRequest === request) docRequest = null
  }
}

/**
 * 候选文件的短缓存。
 *
 * "讲讲今天干了啥"里没有文件名，可"讲"这个动词已经足够触发一次全目录扫描。半分钟内复用
 * 上一次的结果：刚存进授权目录的文件最多晚半分钟才能被点名，换来的是常见闲聊不再每次都
 * 走一遍磁盘。
 */
const DOC_CANDIDATES_TTL = 30_000
let docCandidatesAt = 0
let docCandidatesCache: readonly DocFile[] = []

async function docCandidates(): Promise<readonly DocFile[]> {
  const now = Date.now()
  if (now - docCandidatesAt < DOC_CANDIDATES_TTL) return docCandidatesCache
  const files = await documents.candidates()
  docCandidatesCache = files
  docCandidatesAt = now
  return files
}

/**
 * 让用户亲手挑一个目录。
 *
 * 授权目录只能从这里来：这是分级授权里"允许查找并讲解"的那一级，不能由模型、文档内容
 * 或者任何一个 IPC 参数替用户选（§2.11）。
 */
async function pickDirectory(): Promise<string | null> {
  const title = '选择允许查找和讲解文档的目录'
  const picked =
    win && !win.isDestroyed()
      ? await dialog.showOpenDialog(win, { title, properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ title, properties: ['openDirectory'] })
  return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]
}

/** 授权目录与最近目录分开报：最近目录是打开文档时自动记下的，撤销授权只撤前者。 */
function docRootsPayload(): { roots: string[]; recent: string[] } {
  const settings = loadSettings()
  return { roots: settings.docRoots ?? [], recent: settings.docRecentDirs ?? [] }
}

/**
 * 讲解播放器：语音发起的那一轮回答，以及文档逐段讲解的每一段，都从这里念出来。
 *
 * 分句、播放游标、四层打断的规则在 `speech.ts`，跟合成进程打交道的胶水在 `tts.ts`，这里只做
 * 三件事 —— 决定哪一轮该出声、把停止请求转成打断、把播出状态投影到界面上。
 *
 * 合成进程是懒起的：没用过语音的用户不该为一个常驻的合成进程买单（计划 §11.2 给五个角色
 * 的闲暇开销定了硬指标，一个空转的进程就吃掉不少）。
 */
const narrator = new Narrator(spawnTtsEdgeWorker, {
  onSpoken: record => {
    const talk = docTalk
    const index = record.segment.origin?.paragraph
    if (!talk || !record.complete || index === undefined
      || record.segment.utteranceId !== docUtteranceId(talk, index)) return
    const text = talk.explanations.get(index)
    if (text === undefined) return
    const count = splitIntoSegments({ utteranceId: record.segment.utteranceId, text }).length
    if (record.segment.index === count - 1) {
      talk.completed.add(index)
      talk.next = index + 1
      pushDocState()
    }
  },
  onSpeaking: (speaking) => {
    sendToRenderer('speech-state', { speaking })
    // 助理播报区间记进会议：纪要里这些段单列，不算真人发言。
    const startedAt = meetingRecorder?.getState().startedAt ?? null
    if (speaking) {
      if (assistantSpeechStartedAt === null && startedAt !== null) assistantSpeechStartedAt = Date.now()
    } else if (assistantSpeechStartedAt !== null) {
      if (startedAt !== null) markAssistantSpeech(assistantSpeechStartedAt - startedAt, Date.now() - startedAt)
      assistantSpeechStartedAt = null
    }
    // 上一段念完了，接着讲下一段。打字问答不受影响：docTalk 为 null 时这里什么都不做。
    if (!speaking) void advanceDocTalk()
  },
  onVoice: voice => console.log('[dsh-pet] 语音合成音色：', voice),
  onError: reason => {
    console.log('[dsh-pet] 语音合成不可用：', reason)
    // 念不出来是个听不见的故障：不报一句，用户只会觉得"它没反应"，然后去重启整个壳。
    sendToRenderer('speech-state', { speaking: false, error: reason })
    if (spokenRound) {
      spokenRound.cancelled = true
      spokenRound.controller.abort()
      narrator.dropFeed(spokenRound.utteranceId)
    }
    // 失败不推进下一段，保留已生成的讲解和实际播放位置。
    pauseDocTalk()
    pushDocState()
  },
  onCancelGeneration: () => {
    if (spokenRound) {
      spokenRound.cancelled = true
      spokenRound.controller.abort()
    }
  },
}, {
  // 派发每一句时才取配置：用户中途换服务，下一句就走新的，不用重启播放器。
  ttsApi: (): ResolvedVoiceApi | null => voiceApiStore?.resolve('tts') ?? null,
})

let exitFallbackTimer: NodeJS.Timeout | null = null
let exitRequested = false

/**
 * 请求渲染层播退场动画（漩涡通道 + 挥手告别）。
 * 动画播完后渲染层会回发 `exit-done`；若渲染层 7s 内没有回应（崩溃/窗口被关），
 * 兜底定时器强制退出，避免应用卡在"正在告别"状态。
 */
function requestPetExit(): void {
  exitRequested = true
  // 先把嘴闭上。退场动画有四秒多，等到 before-quit 才停，角色都已经在漩涡里挥手告别了
  // 还在念上一句回答。dispose 是幂等的，退出收尾时再调一次不要紧。
  narrator.dispose()
  if (!win || win.isDestroyed()) {
    app.quit()
    return
  }
  sendToRenderer('pet-exit-requested', null)
  if (exitFallbackTimer) clearTimeout(exitFallbackTimer)
  exitFallbackTimer = setTimeout(() => app.quit(), 7000)
  exitFallbackTimer.unref()
}

/** 右键的是哪一个角色。主进程不知道台上站着谁，由渲染层报上来。 */
interface MenuTarget {
  readonly assistantId: string
  readonly displayName: string
  readonly skin: string
}

function menuTargetOf(raw: unknown): MenuTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as { assistantId?: unknown; displayName?: unknown; skin?: unknown }
  if (typeof value.assistantId !== 'string' || !value.assistantId) return null
  return {
    assistantId: value.assistantId,
    // 名字只当菜单标题用。截断防的是一个异常长的字符串把原生菜单撑出屏幕。
    displayName: typeof value.displayName === 'string' ? value.displayName.slice(0, 24) : '',
    skin: typeof value.skin === 'string' ? value.skin : '',
  }
}

const PET_OPTIONS: Array<{ id: PetId; label: string }> = [
  { id: 'panda', label: '国宝熊猫' },
  { id: 'girl-glasses', label: '眼镜女生（Q版）' },
  { id: 'boy-glasses', label: '眼镜男生（Q版）' },
]

/**
 * 把某个角色的形象写进设置，并广播整张表。
 *
 * 读-改-写要在主进程这一侧做完：渲染层手里的表可能是上一帧的，两个角色连着点的话
 * 后一次会把前一次冲掉。
 */
function setCharacterSkin(target: MenuTarget, skin: PetId): void {
  const current = loadSettings().characters ?? {}
  const next = { ...current, [target.assistantId]: { skin } }
  saveSettings({ characters: next })
  sendToRenderer('characters-changed', next)
}

function buildContextMenu(target: MenuTarget | null): Menu {
  const stored = target ? loadSettings().characters?.[target.assistantId]?.skin : undefined
  // 本机存过的优先；没有就用渲染层报的当前生效皮肤（插件下发的或编制默认的）。
  const current = stored ?? target?.skin ?? ''
  const items: Array<MenuItemConstructorOptions> = []
  if (target) {
    items.push({
      label: `换个形象：${target.displayName || '这个角色'}`,
      submenu: PET_OPTIONS.map(option => ({
        label: option.label,
        type: 'radio' as const,
        checked: current === option.id,
        click: () => setCharacterSkin(target, option.id),
      })),
    })
    items.push({ type: 'separator' })
  }
  items.push(
    { label: '宠物设置', click: () => openSettings('general') },
    { label: '团队管理', click: () => openSettings('team') },
    { label: '文档管理', click: () => openSettings('doc') },
    { label: '会议', click: () => openSettings('meeting') },
    { label: '日报文件夹', click: () => { void shell.openPath(path.join(dshHome(), 'personal-assistant', 'reports')) } },
    { type: 'separator' },
    { label: '隐藏角色（截图 / 录屏）', click: () => host?.setStageVisible(false) },
    { label: '退出桌面宠物', click: () => requestPetExit() },
  )
  return Menu.buildFromTemplate(items)
}

async function dispatchPrompt(command: Extract<SessionCommand, { kind: 'prompt' }>, assistantId?: string): Promise<SessionResult & ChatReply> {
  if (command.text.trim().startsWith('/')) return bridge.sessionCommand({ ...command, spoken: false })
  const current = () => command.bindingId === sessionState?.bindingId && sessionState.status !== 'disconnected'
  const text = command.text.trim().replace(/[。！!，,\s]+$/u, '')
  let local: ChatReply | null = null
  if (!assistantId) {
    if (/^(继续讲解|接着讲|继续讲)$/.test(text) || (text === '继续' && docTalk !== null)) {
      local = await resumeDocTalk(command.spoken === true)
    } else if (/^(停止讲解|暂停讲解|结束讲解)$/.test(text) || (text === '停一下' && docTalk !== null)) {
      interruptSpeech()
      if (text === '结束讲解') stopDocTalk()
      pushDocState()
      local = { ok: true, reply: text === '结束讲解' ? '已结束讲解。' : '已暂停讲解并保留位置。' }
    } else if (mentionsDocs(text)) {
      const intent = detectDocIntent(text, await docCandidates())
      if (!current()) return { ok: false, error: '会话已改变，文档请求未继续执行' }
      if (intent.kind === 'open') local = await openDocByName(intent.mention.file.name)
      if (intent.kind === 'explain') local = await explainDocByName(intent.mention.file.name, 0, command.spoken === true)
      if (local?.ok && current()) sendToRenderer('settings-open', 'doc')
    }
    if (!local && docTalk && /[？?]|为什么|这里|这句|这一段|这个|刚才/u.test(text)) {
      const talk = docTalk
      local = await askAboutDoc(talk.path, talk.next, command.text, undefined, command.spoken === true)
    }
  }
  if (!current()) return { ok: false, error: '会话已改变，请核对原会话的操作结果' }
  if (local) {
    if (local.reply) sendToRenderer('doc-notice', local.reply)
    return { ...local, notice: local.reply?.split('\n')[0] }
  }
  if (command.spoken || assistantId) return sendChatReply(command.text, command.bindingId, command.spoken === true, assistantId)
  interruptSpeech()
  return bridge.sessionCommand({ ...command, text: withInterruptedSpeech(command.text), spoken: false })
}

function registerIpc(): void {
  meetingRecorder = createMeetingRecorder({
    userDataDir: app.getPath('userData'),
    audio: applyAudio,
    notifyRenderer: sendToRenderer,
    // 密钥包装手段按平台分派（`dpapi.ts`）：Windows 走 DPAPI，macOS/Linux 走 safeStorage。
    // 这里把 safeStorage 递进去 —— dpapi.ts 自己不许 import electron（要能被 node --test 导入）。
    storeDeps: { dpapi: { safeStorage } },
  })
  registerMeetingIpc({ ipc: ipcMain, recorder: meetingRecorder })
  meetingRecorder.sweepRetention()
  setInterval(() => meetingRecorder?.sweepRetention(), 6 * 3_600_000).unref()

  // 用户自配的 TTS / 语音识别服务。密钥用系统密钥库（DPAPI）加密落盘；页面永远拿不到密钥本体。
  voiceApiStore = new VoiceApiStore(path.join(app.getPath('userData'), 'voice-apis.json'), {
    encrypt: (value: string) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥保护不可用，无法保存 API 密钥')
      return safeStorage.encryptString(value)
    },
    decrypt: (value: Buffer) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥保护不可用，无法读取已保存的 API 密钥')
      return safeStorage.decryptString(value)
    },
  })
  const apis = voiceApiStore
  const voiceApiCall = (fn: () => VoiceApiState): VoiceApiResult => {
    try {
      return { ok: true, state: fn() }
    } catch (error) {
      // 配置文件损坏、密钥解不开都走这里：如实说，不静默清空用户存过的东西。
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  ipcMain.handle('voice-api-state', () => voiceApiCall(() => apis.snapshot()))
  ipcMain.handle('voice-api-save', (_event, input: unknown) => voiceApiCall(() => apis.save(input)))
  ipcMain.handle('voice-api-remove', (_event, id: unknown) => voiceApiCall(() => apis.remove(id)))
  ipcMain.handle('voice-api-select', (_event, kind: unknown, id: unknown) => voiceApiCall(() => apis.select(kind as VoiceApiKind, id)))

  ipcMain.on('mouse-state', (_event, interactive: boolean) => {
    if (!win || ignoreMouse === !interactive) return
    ignoreMouse = !interactive
    if (interactive) {
      win.setIgnoreMouseEvents(false)
    } else {
      win.setIgnoreMouseEvents(true, { forward: true })
    }
  })

  ipcMain.handle('get-state', () => {
    const settings = loadSettings()
    return {
      pet: settings.pet,
      voiceConversation: settings.voiceConversation === true,
      bounds: settings.bounds,
      positions: settings.positions,
      characters: settings.characters,
      layoutVersion: settings.layoutVersion,
      idleSleepMinutes: settings.idleSleepMinutes,
      sleepMinutes: settings.sleepMinutes,
    }
  })

  ipcMain.handle(
    'save-settings',
    (_event, patch: { bounds?: { x: number; y: number }; positions?: Record<string, { x: number; y: number }>; voiceConversation?: boolean; idleSleepMinutes?: number; sleepMinutes?: number }) => {
      if (!patch || typeof patch !== 'object') return { ok: false }
      // 设置只接受明确的整数分钟；不让无效输入被默默保存成默认值。
      for (const key of ['idleSleepMinutes', 'sleepMinutes'] as const) {
        if (!(key in patch)) continue
        const value = patch[key]
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 120) return { ok: false }
      }
      saveSettings({
        ...(patch.bounds ? { bounds: patch.bounds } : {}),
        ...(patch.positions ? { positions: patch.positions } : {}),
        ...(typeof patch.voiceConversation === 'boolean' ? { voiceConversation: patch.voiceConversation } : {}),
        ...(patch.idleSleepMinutes !== undefined ? { idleSleepMinutes: patch.idleSleepMinutes } : {}),
        ...(patch.sleepMinutes !== undefined ? { sleepMinutes: patch.sleepMinutes } : {}),
      })
      return { ok: true }
    },
  )

  // 退场动画播完：渲染层确认可以退出
  ipcMain.on('exit-done', () => {
    if (exitFallbackTimer) {
      clearTimeout(exitFallbackTimer)
      exitFallbackTimer = null
    }
    app.quit()
  })

  ipcMain.on('context-menu', (event, target: unknown) => {
    if (!win || !stageSender(event)) return
    contextMenuOpen = true
    buildContextMenu(menuTargetOf(target)).popup({ window: win, callback: () => {
      contextMenuOpen = false
      dismissAfter = Date.now()
    } })
  })

  ipcMain.on('overlay-state', (event, value: unknown) => {
    if (!stageSender(event) || !value || typeof value !== 'object') return
    const state = value as { open?: unknown; boxes?: unknown; settingsOpen?: unknown }
    if (typeof state.open !== 'boolean' || typeof state.settingsOpen !== 'boolean' || !validBoxes(state.boxes)) return
    const changed = overlayOpen !== state.open || managementOpen !== state.settingsOpen
    if (state.open && !overlayOpen) dismissAfter = Date.now()
    overlayOpen = state.open
    managementOpen = state.settingsOpen
    overlayBoxes = state.boxes
    if (changed) {
      setPointerWatch(overlayOpen || managementOpen)
      win?.webContents.setBackgroundThrottling(!overlayOpen && !managementOpen)
    }
  })

  ipcMain.handle('session-get', async (event, beforeSeq?: unknown, bindingId?: unknown): Promise<SessionResult> => {
    if (!stageSender(event)) return { ok: false, error: '会话请求来源无效' }
    if (beforeSeq !== undefined && (typeof beforeSeq !== 'number' || !Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) {
      return { ok: false, error: '历史位置无效' }
    }
    if (bindingId !== undefined && typeof bindingId !== 'string') return { ok: false, error: '会话绑定无效' }
    const revision = sessionRevision
    const result = await bridge.getSession(beforeSeq as number | undefined, bindingId as string | undefined)
    if (beforeSeq === undefined && result.state && revision === sessionRevision) acceptSession({ ...result.state, reset: true })
    return result
  })

  ipcMain.handle('session-command', async (event, value: unknown): Promise<SessionResult> => {
    if (!stageSender(event) || !isSessionCommand(value)) return { ok: false, error: '会话操作参数或来源无效' }
    if (!sessionState || value.bindingId !== sessionState.bindingId) return { ok: false, error: '会话已改变，请重新同步后操作' }
    submissionCount += 1
    try {
      const result = value.kind === 'prompt'
        ? await dispatchPrompt(value)
        : await bridge.sessionCommand(value)
      if (value.bindingId !== sessionState?.bindingId) return { ok: false, error: '会话已改变，请核对原会话的操作结果' }
      if (result.state?.bindingId === value.bindingId) acceptSession(result.state)
      return result
    } finally {
      submissionCount -= 1
      dismissAfter = Date.now()
    }
  })

  ipcMain.handle('chat-send', async (event, text: unknown, assistantId?: unknown, spoken?: unknown) => {
    const command = { kind: 'prompt', bindingId: sessionState?.bindingId, text, spoken }
    if (!stageSender(event) || !isSessionCommand(command) || command.kind !== 'prompt'
      || (assistantId !== undefined && (typeof assistantId !== 'string' || assistantId.length > 256))) {
      return { ok: false, error: '对话参数或来源无效' }
    }
    submissionCount += 1
    try {
      return await dispatchPrompt(command, typeof assistantId === 'string' && assistantId ? assistantId : undefined)
    } finally {
      submissionCount -= 1
      dismissAfter = Date.now()
    }
  })

  ipcMain.on('speech-stop', () => {
    interruptSpeech()
    pushDocState()
  })

  // 主动提醒的用户选择（design.md §2.7）。白名单之外的一律丢掉：
  // 这个通道只改提醒节奏，别让它变成一个能把任意字符串发给桥接的洞。
  ipcMain.on('proactive-respond', (_event, kind: unknown) => {
    if (kind === 'accept' || kind === 'decline' || kind === 'disable' || kind === 'enable') {
      void bridge.respondProactive(kind)
    }
  })

  // ===== 文档面板（design.md §2.10） =====
  //
  // 面板上来的路径一律重新过一遍授权判断（DocumentLibrary 的 open/reveal 内部就做了）：
  // 界面上点过是用户点的，IPC 上来的一个字符串不是证据（§2.11："不能伪造 UI 批准"同理）。

  ipcMain.handle('doc-roots', () => docRootsPayload())

  ipcMain.handle('doc-add-root', async () => {
    const picked = await pickDirectory()
    if (picked !== null) addDocRoot(picked)
    docCandidatesAt = 0
    docCandidatesCache = []
    return docRootsPayload()
  })

  ipcMain.handle('doc-remove-root', (_event, target: unknown) => {
    if (typeof target === 'string' && target !== '') {
      removeDocRoot(target)
      interruptSpeech()
      pushDocState()
      docCandidatesAt = 0
      docCandidatesCache = []
    }
    return docRootsPayload()
  })

  // 最近目录是"打开成功"自动加进查找范围的，用户没点过头，所以也得能撤。
  ipcMain.handle('doc-forget-dir', (_event, target: unknown) => {
    if (typeof target === 'string' && target !== '') {
      forgetDocDir(target)
      interruptSpeech()
      pushDocState()
      docCandidatesAt = 0
      docCandidatesCache = []
    }
    return docRootsPayload()
  })

  ipcMain.handle('doc-open', async (_event, target: unknown) => {
    if (typeof target !== 'string' || target === '') return { ok: false, error: '没有指定文档' }
    return openDocByPath(target)
  })

  ipcMain.handle('doc-explain', async (_event, target: unknown, from: unknown, speak: unknown, assistantId: unknown) => {
    if (typeof target !== 'string' || target === '') return { ok: false, error: '没有指定文档' }
    const who = typeof assistantId === 'string' && assistantId ? assistantId : undefined
    // 段号来自界面上点的那一条，无效就如实拒绝，不夹到别的段去讲。
    return explainDocByPath(target, typeof from === 'number' ? from : 0, speak !== false, who, true)
  })

  /**
   * 就某一段追问。
   *
   * 段号来自界面上点的那一条，不从消息里猜 —— 猜错就是把另一段的原文塞给模型，然后让它
   * 一本正经地答非所问。
   */
  ipcMain.handle('doc-ask', async (_event, target: unknown, index: unknown, question: unknown, assistantId: unknown) => {
    if (typeof target !== 'string' || target === '') return { ok: false, error: '没有指定文档' }
    if (typeof question !== 'string' || question.trim() === '') return { ok: false, error: '还没有要问的内容' }
    const who = typeof assistantId === 'string' && assistantId ? assistantId : undefined
    return askAboutDoc(target, typeof index === 'number' ? index : 0, question.trim(), who)
  })

  ipcMain.handle('team-get', async () => {
    try {
      return await bridge.getTeam()
    } catch {
      return null
    }
  })

  // 舞台不再有"直接批准"这条通道：它只能请求打开专用审批窗口。
  // approval-open / approval-card-read / approval-card-decide / approval-card-close
  // 都在 ApprovalWindow 里注册，回执核验也在那边（checkSender）。
  approvals.registerIpc()

  ipcMain.handle('runtime-start', async (_event, profile?: unknown) => {
    if (!host) return { ok: false }
    await host.startRuntime(typeof profile === 'string' && profile ? profile : undefined)
    return { ok: true }
  })

  ipcMain.handle('runtime-stop', async () => {
    if (!host) return { ok: false }
    await host.stopOwnRuntime()
    return { ok: true }
  })

  ipcMain.on('stage-set-visible', (_event, visible: unknown) => {
    host?.setStageVisible(visible === true)
  })

  ipcMain.on('stage-set-focus', (_event, on: unknown) => {
    host?.setFocusMode(on === true)
  })

  // 听写拆成两拍：begin 只做麦克风仲裁（渲染层录音时唤醒监听已停），transcribe 收 wav
  // 去识别并在收尾时归还麦克风。识别期间录音已结束，不占设备。
  // 保险丝：听写被授予后 120 秒没收尾就强制释放——渲染层任何 bug 都不该把麦克风
  // 永久锁死，那之后用户看到的会是每一次点击都被拒（仲裁器的"这一次听完再按"）。
  let dictationSafety: NodeJS.Timeout | null = null
  const armDictationSafety = (): void => {
    if (dictationSafety) clearTimeout(dictationSafety)
    dictationSafety = setTimeout(() => {
      dictationSafety = null
      streamSession = null
      applyAudio({ type: 'dictation-finished' })
    }, 120_000)
    dictationSafety.unref()
  }
  const disarmDictationSafety = (): void => {
    if (dictationSafety) {
      clearTimeout(dictationSafety)
      dictationSafety = null
    }
  }

  /** 本场流式听写的识别会话；null = 整句模式或未开始。 */
  let streamSession: StreamingSession | null = null

  /**
   * 听写转写：用户挑了自定义识别服务就把这段音频送到那里，没挑走本地识别。
   *
   * 会议转写不走这条路 —— 会议音频承诺只留在这台机器上，要送到别处得先让用户重新知情，
   * 不能因为顺手复用一个函数就悄悄改变了承诺。
   */
  const transcribeDictation = async (wav: ArrayBuffer, onDelta?: (text: string) => void): Promise<{ ok: boolean; text?: string; error?: string }> => {
    try {
      const api = voiceApiStore?.resolve('asr') ?? null
      return api ? await transcribeApi(api, wav, undefined, onDelta) : await transcribeWav(wav, app.getPath('userData'))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  ipcMain.handle('asr-begin', () => {
    const granted = applyAudio({ type: 'dictation-requested' })
    if (granted.denied) return { ok: false, error: granted.denied }
    armDictationSafety()
    // 用户挑的自定义服务是"整段上传"的接口，没有实时部分文本：这时不开本地流式会话。
    let apiAsr: ResolvedVoiceApi | null = null
    try {
      apiAsr = voiceApiStore?.resolve('asr') ?? null
    } catch (error) {
      applyAudio({ type: 'dictation-finished' })
      disarmDictationSafety()
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    // 流式模型装了就开一场会话：渲染层逐帧送 PCM，识别文本实时回显输入框。
    let streaming = false
    try {
      if (apiAsr === null && streamingAvailable(app.getPath('userData'))) {
        streamSession = createStreamingSession(app.getPath('userData'))
        streaming = true
      }
    } catch (error) {
      console.log('[dsh-pet] 流式识别器创建失败，退回整句识别：', error instanceof Error ? error.message : error)
      streamSession = null
      streaming = false
    }
    return { ok: true, streaming }
  })

  /** 流式喂数：帧 PCM 进识别器，返回当前累积文本（渲染层实时回显）。 */
  ipcMain.handle('asr-stream-feed', (_event, chunkB64: unknown) => {
    if (!streamSession || typeof chunkB64 !== 'string' || chunkB64.length === 0) return { text: '' }
    try {
      return { text: streamSession.feed(pcm16Base64ToFloat32(chunkB64)) }
    } catch (error) {
      console.log('[dsh-pet] 流式喂数失败：', error instanceof Error ? error.message : error)
      return { text: '' }
    }
  })

  ipcMain.handle('asr-stream-stop', () => {
    const session = streamSession
    streamSession = null
    disarmDictationSafety()
    applyAudio({ type: 'dictation-finished' })
    if (!session) return { ok: false, text: '' }
    try {
      return { ok: true, text: session.finalize() }
    } catch (error) {
      console.log('[dsh-pet] 流式收尾失败：', error instanceof Error ? error.message : error)
      return { ok: false, text: '' }
    }
  })

  ipcMain.handle('asr-transcribe', (_event, wav: unknown) => {
    // preload 把 wav 编成 base64 传过来（ArrayBuffer 穿不过 contextBridge）。
    if (typeof wav !== 'string' || wav.length === 0) {
      disarmDictationSafety()
      applyAudio({ type: 'dictation-finished' })
      return { ok: false, error: '没有听到说话内容' }
    }
    const buffer = Buffer.from(wav, 'base64')
    if (buffer.length === 0) {
      disarmDictationSafety()
      applyAudio({ type: 'dictation-finished' })
      return { ok: false, error: '没有听到说话内容' }
    }
    return transcribeDictation(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      (text) => sendToRenderer('asr-delta', { text }),
    ).finally(() => {
      // 超时与正常结束都可能走到这里，仲裁器对重复收尾是幂等的。
      disarmDictationSafety()
      applyAudio({ type: 'dictation-finished' })
    })
  })

  // 听写回退：渲染层 Web Audio 录不了时（页面拿不到麦克风接口、音频回调不来等），
  // 主进程录固定窗口，再走同一条转写链路。仲裁的申请与归还都在这条里完成。
  //
  // 录音命令按平台分派：Windows 用 MCI（record.ps1），其他系统上 `recordAudioSpec` 返回 null，
  // 这条回退就如实不可用 —— 不假装录了。主路径（渲染层 getUserMedia）在 macOS 上是通的，
  // 所以这只影响"浏览器音频接口也拿不到"的边角情况。
  ipcMain.handle('asr-record-fallback', async () => {
    const granted = applyAudio({ type: 'dictation-requested' })
    if (granted.denied) return { ok: false, error: granted.denied }
    armDictationSafety()
    const tmp = mkdtempSync(path.join(tmpdir(), 'dsh-dic-'))
    const wavPath = path.join(tmp, 'dictation.wav')
    try {
      const spec = recordAudioSpec(platformOf(), here, wavPath, 12000)
      if (spec === null) return { ok: false, error: '这个系统上还没有录音回退实现，请检查麦克风权限后重试' }
      const code = await new Promise<number>((resolve) => {
        const child = spawn(spec.command, [...spec.args], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
        child.on('error', () => resolve(-1))
        child.on('exit', (exitCode) => resolve(exitCode ?? -1))
      })
      if (code !== 0 || !existsSync(wavPath)) return { ok: false, error: '录音失败：麦克风可能被占用或不可用' }
      const wav = readFileSync(wavPath)
      return await transcribeDictation(
        wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
      )
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 临时目录 */ }
      disarmDictationSafety()
      applyAudio({ type: 'dictation-finished' })
    }
  })

  ipcMain.handle('open-report-dir', async () => {
    const reportDir = path.join(dshHome(), 'personal-assistant', 'reports')
    await shell.openPath(reportDir)
    return { ok: true }
  })
}

/**
 * 平台专属的启动收尾。
 *
 * 两件事，都是"macOS 上不做就会显得很怪"的那类：
 *
 * 1. **隐藏 Dock 图标**。窗口建的时候带了 `skipTaskbar: true`，但那是 Windows/Linux 的语义；
 *    macOS 上要藏 Dock 图标得单独调 `app.dock.hide()`。一只常驻桌面的宠物在 Dock 里占一格
 *    是多余的 —— 它的入口是托盘，不是 Dock。
 * 2. **主动请求麦克风权限**。macOS 10.14+ 起，没在 Info.plist 里声明
 *    `NSMicrophoneUsageDescription` 就调 `getUserMedia` 会**被系统直接终止进程**（不是报错）。
 *    声明了之后还得让用户点一次授权，否则第一次听写会静默失败。这里提前问，
 *    把"授权"这件事发生在用户按下说话键之前。
 *
 * 两处都包了 try：Dock 隐藏失败、权限接口在旧 Electron 上不存在，都不该挡住启动。
 */
function applyPlatformWindowTweaks(): void {
  if (platformOf() !== 'darwin') return
  try {
    app.dock?.hide()
  } catch (error) {
    console.log('[dsh-pet] 隐藏 Dock 图标失败（不影响使用）:', error instanceof Error ? error.message : String(error))
  }
  void requestMicrophoneAccess()
}

/**
 * 请求麦克风权限。只在 macOS 上有意义。
 *
 * 刻意**不 await** 它：授权对话框是模态的，等它会卡住启动。用户点不点都不影响窗口先出来 ——
 * 真正要用麦克风的时候（听写 / 会议）会再走一次 `getUserMedia`，那时权限已经是明确的了。
 * 拒绝也只是让语音功能不可用，不该拖累整个壳。
 */
async function requestMicrophoneAccess(): Promise<void> {
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return
    // not-determined 才会弹系统对话框；denied 之后再调是 no-op，只能用户自己去系统设置开。
    if (status === 'not-determined') await systemPreferences.askForMediaAccess('microphone')
  } catch (error) {
    console.log('[dsh-pet] 请求麦克风权限失败（语音功能可能不可用）:', error instanceof Error ? error.message : String(error))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
    }
  })

  void app.whenReady().then(() => {
    applyPlatformWindowTweaks()
    registerIpc()
    createWindow()

    host = new CompanionHost(
      {
        onState: state => sendToRenderer('companion-state', state),
        onStageVisible: applyStageVisible,
        // 会议里不该让唤醒词把参会者的话当指令，所以专注模式要能掐掉唤醒监听。
        onFocusMode: on => {
          petFocusMode = on
          reportPetState()
          applyAudio({ type: 'focus', on })
        },
        onRetryWake: () => applyAudio({ type: 'wake-retry' }),
        onExit: () => requestPetExit(),
        readSettings: () => {
          const settings = loadSettings()
          return { trayResident: settings.trayResident, runtimeProfile: settings.runtimeProfile }
        },
        saveSettings: patch => {
          saveSettings(patch)
        },
      },
      { mainDir: here, dshHome: dshHome(), instanceId: randomUUID() },
    )
    host.start()

    // 全局快捷键：任何时候按下都唤起输入框。
    //
    // 修饰键按平台挑：macOS 上 `CommandOrControl` 会映射成 **Ctrl**，而 Mac 用户的手指
    // 记的是 Cmd —— 给一个 Ctrl+Option+P 的组合，等于给了个没人会按的快捷键。
    // 所以 macOS 上直接用 `Command`，Windows/Linux 上仍走 `CommandOrControl`。
    // 主选被占用时退到空格那一组；两组都占不到就静默放弃（托盘与角色点击仍可用）。
    const primary = platformOf() === 'darwin' ? 'Command+Alt+P' : 'CommandOrControl+Alt+P'
    const fallback = platformOf() === 'darwin' ? 'Command+Alt+Space' : 'CommandOrControl+Alt+Space'
    for (const accelerator of [primary, fallback]) {
      if (globalShortcut.register(accelerator, () => {
        // 经壳层叫出来，托盘上的"角色：显示中/已隐藏"才和桌面上看到的一致。
        host?.setStageVisible(true)
        sendToRenderer('pet-summon', null)
      })) break
    }

    // 常驻语音唤醒：听到"小潘小潘"就回应并弹出输入框。起不起由仲裁器按当前设置决定，
    // 之后每一次起停也都从它那里出 —— 设备只有一个主人。
    applyAudio({ type: 'boot' })

    // 连接会话桥接：宠物可能先于"召唤"启动，这里持续重试直到桥接出现。
    void bridge.connect({
      onStatus: status => {
        sendToRenderer('bridge-status', status)
        if (status === 'disconnected' && sessionState) {
          acceptSession({ ...sessionState, entries: [], status: 'disconnected', error: '会话连接已断开' })
        }
        host?.noteBridgeChange()
        // 断开之后审批凭据与代次都失效了，卡片上那条提案不可能再被批准：关掉它。
        if (status === 'disconnected') approvals.clear()
      },
      onSessionEnded: () => {
        approvals.clear()
        // 托盘常驻是用户明确启用的一项：启用了，会话结束就只收起角色，壳、唤醒监听、
        // 以及用户自己起的那个运行时都原样留着（下次召唤还能接回来）。
        // 没启用就沿用旧单宠行为 —— 播退场动画然后整个退出。
        if (loadSettings().trayResident) host?.setStageVisible(false)
        else requestPetExit()
      },
      // 事件逐条转发：界面是团队状态的投影，不是自己猜出来的。
      onEvent: event => {
        if (event.type === 'session/update') {
          acceptSession(event.payload as SessionUpdate)
          return
        }
        sendToRenderer('team-event', event)
        // 提案被别处决定（或到期）之后，专用窗口里那张卡片要跟着撤：
        // 留着它，用户会去批一条已经不存在的提案，然后收到一句看不懂的失败。
        if (event.type === 'proposal/decided' && typeof event.id === 'string') approvals.retire(event.id)
      },
      // 会话流水（正文 / 思考 / 工具调用 / 输入）：按发生顺序推给界面，
      // 让宠物的对话框和 DSH 会话完全绑定 —— 那边出什么、进来什么，这边同步什么。
      onChatDelta: item => {
        sendToRenderer('chat-delta', item)
      },
      // 主动提醒（design.md §2.7）：插件侧只推候选与文案，显不显示、怎么回应由这边的
      // 专注/可见状态决定 —— 界面是唯一知道用户此刻在不在会议里的一方。
      onProactive: payload => {
        sendToRenderer('proactive-remind', payload)
      },
    })
  })
}

app.on('window-all-closed', () => {
  if (exitRequested) {
    app.quit()
  } else {
    // 渲染层崩溃连带关窗时自愈重建
    win = null
    createWindow()
  }
})

/** 退出收尾只做一次：第二次 before-quit 是收尾完成后自己放行的那一次。 */
let shutdownStarted = false

app.on('before-quit', event => {
  globalShortcut.unregisterAll()
  pointerWatcher.dispose()
  stopWakeListener()
  // 窗口被关这类退出路径不经过 requestPetExit，漏在这儿就是一个杀不掉的合成进程孤儿。
  narrator.dispose()
  bridge.dispose()
  // 退出过程中不该再留着一个能签发批准的窗口：IPC 摘掉、卡片关掉。
  approvals.dispose()
  // 会议库句柄要关：Windows 上文件锁会一直挂着，进程退了目录都删不干净。
  // 放在 host 判空之前 —— 没开助理也得关。
  const closingMeeting = meetingRecorder?.close() ?? Promise.resolve()
  if (shutdownStarted || !host) {
    void closingMeeting
    return
  }
  // 停自有运行时要等它静止，而同步等是等不到的：子进程的 exit 事件靠事件循环派发，
  // 阻塞主线程期间 exitCode 永远不会被置位。所以先挡下这次退出，收尾完再放行。
  shutdownStarted = true
  event.preventDefault()
  const closing = host
  host = null
  void Promise.allSettled([closing.shutdown(), closingMeeting]).then(() => app.quit())
})
