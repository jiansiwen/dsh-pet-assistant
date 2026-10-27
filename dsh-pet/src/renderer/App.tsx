import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TeamStage, { type TeamStageHandle } from './TeamStage.js'
import TeamPanel from './TeamPanel.js'
import DocPanel from './DocPanel.js'
import MeetingPanel from './meeting-panel.js'
import VoiceApiSettings from './VoiceApiSettings.js'
import ChatOverlay from './ChatOverlay.js'
import PetSettingsPanel, { PresentationSettings, ResidencySettings, WorkEvidenceSettings } from './PetSettingsPanel.js'
import { EnvironmentCheck } from './FirstRunSettings.js'
import { useSession } from './useSession.js'
import { CONTINUOUS_IDLE_TIMEOUT_MS, VoiceConversation, isVoiceStop, parseInterruptPhrase } from '../voice-conversation.ts'
import type { VoiceTurn } from '../session-types.js'
import {
  clearStageHitboxes,
  hitTest,
  isWorking,
  projectTaskStatuses,
  stageHitboxes,
  type ExitStage,
  type StageMember,
  type StageTaskStatus,
} from './stage-layout.js'
import { manifestFor, manifestForLegacySkin } from './character-manifest.js'
import { PROACTIVE_ACCEPT_MESSAGE } from './proactive-ui.js'
import { arrayBufferToBase64, pcm16Base64, recordDictation, stopDictation, type DictationHandover } from './dictation.js'
import { installAudioBridge, isWakePhraseOnly } from './barge-in.ts'
import { isSelfSpeech, rememberSelfSpeech } from './self-speech.ts'
import { LOCAL_ACKS } from '../main/greetings.ts'
import { approvalBanner } from './team-panel.js'
import { operationLabels, runtimeCanStart, runtimeDetail, runtimeLabel, runtimeTone } from './runtime-status.js'
import { presentationCutoffOf } from './session-view.js'
import type { PetBehavior } from './usePetBehavior.js'
import type { PortalPhase } from './PortalExit.js'
import type {
  BridgeEventPayload,
  CharacterMenuTarget,
  CompanionState,
  DocRoots,
  DocState,
  OperationalState,
  PetPosition,
  SettingsPage,
  SkinOverrides,
  SpeechStatus,
  TeamProposalSnapshot,
  TeamSnapshot,
} from './types.js'
import './pet-anim.css'
import './portal.css'
import './team.css'
import './hud.css'

const QUICK_COMMANDS = ['开启个人助理模式', '我今天干了啥？', '总结今日工作内容']

/**
 * 提醒气泡在屏幕上停留的上限，与插件侧 OFFER_TTL_MS（30 分钟）对齐。
 * 插件端的 offer 过期后不会再生成候选，气泡继续挂着只会让用户点了没反应。
 */
const PROACTIVE_BUBBLE_TTL_MS = 30 * 60_000

/**
 * 宠物界面的构建标识，显示在通用设置的诊断区。
 *
 * 有个说不清的显示问题时，第一件要排除的事就是「跑的是不是这个构建」——
 * 插件与宠物都是**进程内加载 + 模块缓存**，重建磁盘文件对已运行的进程毫无影响。
 * 看一眼这个标记就知道，不用再靠猜。
 */
const UI_BUILD = '0923-hud1'

/** 语音唤醒命中时的应答。角色被隐藏时这句要等舞台挂回来再补说，所以提成常量。 */
const WAKE_GREETING = '我在呢！找我什么事？'

/**
 * 又只喊了一句名字时的本地应答。
 *
 * 这几句**不进会话、不调模型**：用户只是叫了一声，没有任何需要模型处理的内容；
 * 塞进会话就是凭空多一条用户消息，还会让模型对着一句名字答题。
 * 清单从主进程那份复用：预热缓存与显示必须是同一批句子，否则总有一半要当场合成。
 */
function pickLocalGreeting(): string {
  return LOCAL_ACKS[Math.floor(Math.random() * LOCAL_ACKS.length)]
}

/** 合成进程报的故障码。协议在 `main/tts-edge-worker.ts` 头部。 */
const SPEECH_ERROR_TEXT: Record<string, string> = {
  'no-voice': '这台机器上没有可用的语音合成音色',
  'init-failed': '语音合成起不来',
  'worker-exited': '语音合成进程半路没了',
}

/**
 * 念不出来的原因，说人话。
 *
 * 这是个听不见的故障：不报一句，用户只会觉得"它没反应"，然后去重启整个壳。原始码跟在后面，
 * 真出问题的时候能照着查。
 */
function speechErrorText(code: string): string {
  const text = SPEECH_ERROR_TEXT[code] ?? '语音合成出了状况'
  return `${text}（${code}），这一轮只显示文字`
}

export default function App() {
  const mirror = useSession()
  const { session } = mirror
  const [pet, setPet] = useState('panda')
  /**
   * 用户在本机为每个角色挑的形象，键是 assistantId。
   *
   * 真源是 pet-settings.json，写在主进程（原生菜单里点的那一下）。这里只在启动时读一次、
   * 之后听广播 —— 界面不自己推断"他大概想换成熊猫吧"。
   */
  const [characters, setCharacters] = useState<SkinOverrides>({})
  const [panelOpen, setPanelOpen] = useState(false)
  /** 管理页与会话显隐独立，切页不影响输入草稿或后台任务。 */
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null)
  const [delegateId, setDelegateId] = useState('')
  const [delegateText, setDelegateText] = useState('')
  const [delegating, setDelegating] = useState(false)
  const [delegateResult, setDelegateResult] = useState('')
  const [input, setInput] = useState('')
  /** 仅锁住提交到回执这段时间，不锁住原生会话的整个运行周期。 */
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [voiceConversation, setVoiceConversation] = useState(false)
  const [continuousVoice, setContinuousVoice] = useState(false)
  const [readReplies, setReadReplies] = useState(false)
  /** 会话框停靠方式与尺寸；默认固定在头顶，尺寸 440×560。 */
  const [chatDock, setChatDock] = useState<'top' | 'auto'>('top')
  const [chatSize, setChatSize] = useState<{ width: number; height: number }>({ width: 440, height: 560 })
  const conversation = useRef(new VoiceConversation()).current
  const [continuousActive, setContinuousActive] = useState(false)
  const dictationGeneration = useRef(0)
  const currentBinding = useRef(session?.bindingId)
  currentBinding.current = session?.bindingId
  const continueListening = useRef<() => void>(() => {})
  const continuousTimer = useRef<ReturnType<typeof setTimeout>>()
  /** 回复播完后的静默窗定时器：到点没听到开口就关麦，开一次口就作废。 */
  const idleTimer = useRef<ReturnType<typeof setTimeout>>()
  /** 唤醒应答播完后的开麦回调；由主进程的“实际播放结束”触发，字数估算只做超时兜底。 */
  const wakeListenPending = useRef<(() => void) | null>(null)
  const wakeListenTimer = useRef<ReturnType<typeof setTimeout>>()
  const listeningRef = useRef(false)
  const busyRef = useRef(false)
  /** 角色是不是正在念回答。念的时候面板上要给一个能让它闭嘴的按钮。 */
  const [speech, setSpeech] = useState<SpeechStatus>({ speaking: false })
  /**
   * 文档页的三份状态。
   *
   * `docState` 是主进程的投影，位置的真值在那边；`docBusy` 只覆盖界面自己发起的那一次
   * 操作（解析、请模型讲一段），语音发起的讲解不经这里，所以它拦不住语音那条链，
   * 也不该拦 —— 那条链的停止入口是「停止讲解」和朗读横条。
   */
  const [docState, setDocState] = useState<DocState>({ kind: 'idle' })
  const [docRoots, setDocRoots] = useState<DocRoots>({ roots: [], recent: [] })
  const [docBusy, setDocBusy] = useState(false)
  const [docResults, setDocResults] = useState<Array<{ text: string; error: boolean }>>([])
  const [toast, setToast] = useState('')
  const toastTimer = useRef(0)

  /** 团队编制。null 表示桥接还没给过数据 —— 那时按旧的单宠物模式渲染一个角色。 */
  const [members, setMembers] = useState<StageMember[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [positions, setPositions] = useState<Record<string, PetPosition>>({})
  const [statusByAssistant, setStatusByAssistant] = useState<Record<string, StageTaskStatus>>({})
  /** 待批准的副作用提案。这是唯一必须用户点头才能继续的事，要在面板里显眼。 */
  const [proposals, setProposals] = useState<TeamProposalSnapshot[]>([])
  /**
   * 整份团队快照，给团队页用。
   *
   * 舞台要的是拆好的 members 与 statusByAssistant，团队页要的是原样的任务列表（产物、
   * 截止时间都在里面）。共用同一次 `/team` 的结果，不各拉一次 —— 两次拉取会得到
   * 两个不同时刻的快照，名牌上的状态和团队页里的任务就会互相矛盾。
   */
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null)

  /**
   * 壳的生命周期：运行时连接状态、角色是否可见。
   *
   * 两样都由主进程推进（托盘那一下点击、启动握手的每个阶段），界面只是投影 ——
   * 和团队快照同一个道理：不在这里推断"应该是连上了吧"，只画主进程说的事实。
   */
  const [companion, setCompanion] = useState<CompanionState | null>(null)
  const [stageVisible, setStageVisible] = useState(true)
  /** 主动提醒的候选（§2.7）。null = 没有 待回应的气泡。 */
  const [proactive, setProactive] = useState<{ message: string; suggestDisable: boolean } | null>(null)
  const proactiveTimer = useRef(0)
  /**
   * 演示隐私模式的历史分界（M5-05）。
   *
   * 记的是"开启那一刻已存在条目的最大 seq"，不是当前最大 seq —— 演示期间新产生的消息
   * 要照常显示（用户正在演示它们）。用 seq 而不是下标：往上翻历史会在数组前面插入条目。
   */
  const [presentationCutoff, setPresentationCutoff] = useState<number | null>(null)
  const presentation = companion?.presentationMode === true
  const wasPresenting = useRef(false)
  useEffect(() => {
    if (presentation === wasPresenting.current) return
    wasPresenting.current = presentation
    if (!presentation) { setPresentationCutoff(null); return }
    const entries = session?.entries ?? []
    // 空历史就没得藏：null 表示不隐藏。分界之后的新消息仍然可见。
    setPresentationCutoff(presentationCutoffOf(entries))
  }, [presentation, session])

  const positionsRef = useRef(positions)
  positionsRef.current = positions

  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const interactiveRef = useRef(false)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  /** 最近一次鼠标位置：角色会自己走动，不能只在 mousemove 时判断命中。 */
  const lastMouseRef = useRef({ x: -1, y: -1 })
  /** 唤醒去抖：连续识别到唤醒词时只响应一次。 */
  const wakeLockRef = useRef(0)
  /** 角色隐藏时被唤醒：应答留到舞台挂回来再说，否则用户喊了一声却没人应。 */
  const pendingGreetingRef = useRef(false)
  /** 补发时必须用**当时那句**（语音已经念过这一句）：换成模板会与听到的对不上。 */
  const pendingGreetingLineRef = useRef<string | null>(null)
  const stageRef = useRef<TeamStageHandle | null>(null)

  /**
   * 桥接没连上（插件没启动、dsh 没跑）时的降级编制。
   *
   * 用旧皮肤映射到对应角色，所以单宠物时代的熊猫仍然是总助理、眼镜男生仍然是助理1 ——
   * 桌面宠物不该因为团队服务没起来就变成一片空白。
   */
  const cast = useMemo<StageMember[]>(() => {
    if (members?.length) return members
    const legacy = manifestForLegacySkin(pet)
    return [
      {
        assistantId: legacy.assistantId,
        displayName: legacy.displayName,
        roleId: legacy.roleId,
        skinId: pet,
        enabled: true,
      },
    ]
  }, [members, pet])

  const selectedMember = useMemo(() => {
    const found = cast.find((item) => item.assistantId === selectedId)
    return found ?? cast[0] ?? null
  }, [cast, selectedId])

  const wakeConversation = useCallback((event: React.SyntheticEvent) => {
    if (selectedMember && event.target instanceof Element && event.target.closest('.chat-hud')) {
      stageRef.current?.wakeOf(selectedMember.assistantId)
    }
  }, [selectedMember])

  /** 会话只临时补充选中角色的工作状态；已有团队任务优先，结束后恢复原投影。 */
  const stageStatuses = useMemo(() => {
    if (!selectedMember || (session?.status !== 'running' && session?.status !== 'waiting')) return statusByAssistant
    const who = selectedMember.assistantId
    if (isWorking(statusByAssistant[who])) return statusByAssistant
    return { ...statusByAssistant, [who]: session.status === 'waiting' ? 'awaiting-user' as const : 'running' as const }
  }, [selectedMember, session?.status, statusByAssistant])

  // ---- 退场编排（时间线见 portal.css 顶部注释，总长 4.3s）----
  // none → wave（挥手拜拜）→ turn（转身）→ jump（跳入通道）→ gone（消失，通道消散）
  const [exitStage, setExitStage] = useState<ExitStage>('none')
  const [portalPhase, setPortalPhase] = useState<PortalPhase>('closed')
  const exitingRef = useRef(false)

  const beginExit = useCallback(() => {
    if (exitingRef.current) return
    exitingRef.current = true
    stageRef.current?.freezeAll()
    setPortalPhase('opening')
    window.setTimeout(() => {
      setPortalPhase('open')
      stageRef.current?.forceAll('wave')
      // 只让选中的那个角色说再见：几个角色一起喊拜拜很吵，也没人知道该看谁。
      const who = selectedId ?? cast[0]?.assistantId
      if (who) stageRef.current?.sayTo(who, '拜拜～我先回去啦！', 2200)
    }, 700)
    window.setTimeout(() => setExitStage('turn'), 2000)
    window.setTimeout(() => setExitStage('jump'), 2400)
    window.setTimeout(() => {
      setExitStage('gone')
      setPortalPhase('closing')
    }, 3100)
    window.setTimeout(() => window.petApi.exitDone(), 4300)
  }, [selectedId, cast])

  // 主进程请求退场：会话被销毁（桥接断开）或用户右键"退出桌面宠物"，两者都播动画。
  useEffect(() => {
    window.petApi.onExitRequested(() => beginExit())
  }, [beginExit])

  useEffect(() => {
    void window.petApi.getState().then((state) => {
      setPet(state.pet)
      setVoiceConversation(state.voiceConversation === true)
      setContinuousVoice(state.continuousVoice === true)
      setReadReplies(state.readReplies === true)
      setChatDock(state.chatDock === 'auto' ? 'auto' : 'top')
      if (state.chatSize && Number.isFinite(state.chatSize.width) && Number.isFinite(state.chatSize.height)) {
        setChatSize({ width: state.chatSize.width, height: state.chatSize.height })
      }
      setCharacters(state.characters ?? {})
      setSleepSettings({ idleSleepMinutes: state.idleSleepMinutes ?? 2, sleepMinutes: state.sleepMinutes ?? 20 })
      if (state.positions && Object.keys(state.positions).length > 0) {
        setPositions(state.positions)
        positionsRef.current = state.positions
      } else if (state.bounds) {
        // 老设置只有一个位置：落到那个皮肤对应的角色身上，别让用户觉得拖好的位置丢了。
        const legacy = manifestForLegacySkin(state.pet)
        const migrated = { [legacy.assistantId]: state.bounds }
        setPositions(migrated)
        positionsRef.current = migrated
      }
    })
    window.petApi.onCharactersChanged(setCharacters)
    return () => clearStageHitboxes()
  }, [])

  /**
   * 应用一次团队快照。
   *
   * 快照是唯一权威：事件只用来触发"该重新看一眼了"，不用来逐字段改状态。
   * 增量更新要正确处理十几种事件各自的 payload 形状，漏掉一个字段界面就和真实状态不符 ——
   * 而 `/team` 是本地回环上的内存快照，重拉的代价可以忽略。
   */
  const applySnapshot = useCallback((next: TeamSnapshot) => {
    setSnapshot(next)
    const roster = next.members ?? []
    // 团队没开或编制为空时交回 null，让 cast 退回降级单角色，桌面上不会空无一人。
    setMembers(roster.length > 0 ? roster : null)
    setStatusByAssistant(projectTaskStatuses(next.tasks))
    // 只留还在等决定的：已批准或已驳回的提案继续挂着，用户会以为还得再点一次。
    setProposals((next.proposals ?? []).filter((item) => (item.state ?? 'pending') === 'pending'))
  }, [])

  const refreshTimer = useRef(0)

  const requestRefresh = useCallback(() => {
    // 去抖：插件侧每 400ms 批量 drain 一次团队事件，一次任务推进会连着来好几条。
    window.clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(() => {
      void window.petApi.getTeam().then((snapshot) => {
        if (snapshot) applySnapshot(snapshot)
      })
    }, 200)
  }, [applySnapshot])

  useEffect(() => {
    // 挂载先拉一次：桌面壳可能在任务跑起来之后才启动，此前的事件已经永久错过。
    void window.petApi.getTeam().then((snapshot) => {
      if (snapshot) applySnapshot(snapshot)
    })
    window.petApi.onTeamEvent((event: BridgeEventPayload) => {
      // 主进程刚连上桥接时主动推的快照，payload 就是快照本身，不必再往返一次。
      if (event.type === 'team/snapshot') {
        const payload = event.payload as TeamSnapshot | undefined
        if (payload) applySnapshot(payload)
        return
      }
      // 回复由会话镜像同步，不用高频正文事件触发团队重拉。
      if (event.type === 'reply' || event.type.startsWith('reply/') || event.type === 'session-ended') return
      requestRefresh()
    })
    return () => window.clearTimeout(refreshTimer.current)
  }, [applySnapshot, requestRefresh])

  const showToast = useCallback((text: string) => {
    window.clearTimeout(toastTimer.current)
    setToast(text)
    toastTimer.current = window.setTimeout(() => setToast(''), 4000)
  }, [])

  useEffect(() => {
    const stopSettings = window.petApi.onSettingsOpen(setSettingsPage)
    const stopDismiss = window.petApi.onOverlayDismiss(() => setPanelOpen(false))
    const stopError = window.petApi.onOverlayError(showToast)
    return () => { stopSettings(); stopDismiss(); stopError(); window.clearTimeout(toastTimer.current) }
  }, [showToast])

  useEffect(() => {
    if (mirror.error) showToast(mirror.error)
  }, [mirror.error, showToast])

  // 选宠物只切换舞台锚点，不改变原生会话绑定或发送对象。
  const handleSelect = useCallback((assistantId: string) => {
    setSelectedId(assistantId)
  }, [])

  const handlePersist = useCallback((assistantId: string, x: number, y: number) => {
    const next = { ...positionsRef.current, [assistantId]: { x, y } }
    positionsRef.current = next
    setPositions(next)
    void window.petApi.saveSettings({ positions: next })
  }, [])

  /**
   * 这一轮的输入是不是从麦克风来的。
   *
   * 只有语音发起的那一轮回答才念出来 —— 打字问的话突然出声，是用户没要求过的行为。
   * 用 ref 而不是 state：它只在 send 那一刻被读一次，不值得为它触发一次重渲染。
   */
  const voiceRoundRef = useRef(false)
  const [sleepSettings, setSleepSettings] = useState({ idleSleepMinutes: 2, sleepMinutes: 20 })
  const [savingSleep, setSavingSleep] = useState(false)
  /** 隐藏或卸载后忽略迟到的听写结果，不自动提交或重开会话。 */
  const dictationCancelled = useRef(false)
  /** 语音识别流式增量的累积文本；最终文本以 asrTranscribe 返回值为准。 */
  const asrDeltaText = useRef('')
  const stopContinuous = useCallback((stopSpeech = true) => {
    const active = conversation.active
    conversation.stop()
    ++dictationGeneration.current
    dictationCancelled.current = true
    voiceRoundRef.current = false
    clearTimeout(continuousTimer.current)
    clearTimeout(idleTimer.current)
    setContinuousActive(false)
    stopDictation()
    if (active && stopSpeech) window.petApi.stopSpeech()
  }, [conversation])
  const syncContinuous = useCallback((resume: boolean) => {
    setContinuousActive(conversation.active)
    if (!conversation.active) {
      clearTimeout(continuousTimer.current)
      clearTimeout(idleTimer.current)
    }
    if (resume) continueListening.current()
  }, [conversation])
  /**
   * 静默窗：回复播完、重新开麦之后，连续这么长时间一句都没听到才关麦。
   *
   * 只在这个窗口里生效 —— 生成与播放期间用户本来就不说话，按静默关麦就是"说完一句就再也开不起来"。
   * 用户一开口（`onSpeechStart`）就撤掉计时：那是下一轮的问题，不该被打断。
   */
  const armIdleDeadline = useCallback(() => {
    clearTimeout(idleTimer.current)
    const generation = conversation.generation
    const check = () => {
      if (!conversation.active || conversation.generation !== generation) return
      // 还在等开口（waiting）或已经在收这一句（recording 但没开口）才关；一开口就不再计时了。
      if (conversation.phase !== 'waiting' && conversation.phase !== 'recording') return
      stopContinuous(false)
      showToast(`连续 ${Math.round(CONTINUOUS_IDLE_TIMEOUT_MS / 1000)} 秒没听到你说话，语音输入已关闭`)
    }
    const left = conversation.idleDeadline > 0 ? conversation.idleDeadline - Date.now() : CONTINUOUS_IDLE_TIMEOUT_MS
    idleTimer.current = setTimeout(check, Math.max(0, left))
  }, [conversation, stopContinuous, showToast])
  /** 到墙钟上限即结束；正在说的那句等它说完，交给 submit 判定超时并留在输入框。正在播的回答不掐断。 */
  const armContinuousDeadline = useCallback(() => {
    clearTimeout(continuousTimer.current)
    const generation = conversation.generation
    const check = () => {
      if (!conversation.active || conversation.generation !== generation) return
      if (conversation.phase === 'recording') { continuousTimer.current = setTimeout(check, 1000); return }
      stopContinuous(false)
      showToast('连续对话已到 5 分钟上限，已结束')
    }
    continuousTimer.current = setTimeout(check, Math.max(0, conversation.deadline - Date.now()))
  }, [conversation, stopContinuous, showToast])
  useEffect(() => {
    const offComplete = window.petApi.onVoiceTurnComplete(event => syncContinuous(conversation.complete(event)))
    const offStop = window.petApi.onVoiceConversationStop(() => { if (conversation.active) stopContinuous(false) })
    return () => { offComplete(); offStop(); clearTimeout(continuousTimer.current); clearTimeout(idleTimer.current) }
  }, [conversation, syncContinuous, stopContinuous])
  // 关闭会话框、换绑或断连都退出连续对话，且不会被迟到结果重新打开。
  useEffect(() => {
    if (!conversation.active) return
    if (!panelOpen || session?.bindingId !== conversation.bindingId || session?.status === 'disconnected') stopContinuous()
  }, [panelOpen, session?.bindingId, session?.status, conversation, stopContinuous])
  const saveSleep = useCallback(async (key: 'idleSleepMinutes' | 'sleepMinutes', value: number) => {
    if (!Number.isInteger(value) || value < 1 || value > 120) { showToast('请输入 1–120 之间的整数分钟'); return }
    setSavingSleep(true)
    try {
      const result = await window.petApi.saveSettings({ [key]: value })
      if (result.ok) setSleepSettings(previous => ({ ...previous, [key]: value }))
      else showToast('睡眠设置未保存')
    } catch { showToast('睡眠设置未保存') }
    finally { setSavingSleep(false) }
  }, [showToast])

  const send = useCallback(
    async (raw: string, voiceTurn?: VoiceTurn) => {
      const text = raw.trim()
      if (voiceTurn && !conversation.valid(voiceTurn.generation, voiceTurn.bindingId)) return
      if (!voiceTurn && conversation.active) stopContinuous()
      if (!text || busyRef.current) {
        if (voiceTurn) stopContinuous(false)
        return
      }
      setPanelOpen(true)
      const restoreDraft = () => setInput(draft => !draft || draft.trim() === text ? raw : `${raw}\n${draft}`)
      let target = session
      if (!target?.capabilities.prompt) {
        if (voiceTurn) {
          stopContinuous(false)
          restoreDraft()
          showToast('当前会话暂不能发送，请稍后重试')
          return
        }
        // 会话还没开：先由桌面开启或恢复（运行时都没有时按壳的规则附着或启动），成功后照常发送这一条。
        busyRef.current = true
        setBusy(true)
        try {
          const started = await window.petApi.startSession()
          if (!started.ok || !started.state?.capabilities.prompt) {
            restoreDraft()
            showToast(started.error ?? '助理会话没能开启，请稍后重试')
            return
          }
          mirror.adopt(started.state)
          if (started.notice) showToast(started.notice)
          target = started.state
        } catch (error) {
          restoreDraft()
          showToast(error instanceof Error ? error.message : String(error))
          return
        } finally {
          busyRef.current = false
          setBusy(false)
        }
      }
      busyRef.current = true
      setBusy(true)
      const spoken = voiceRoundRef.current
      voiceRoundRef.current = false
      // 快捷命令不清除尚未提交的其他草稿；消息只从原生镜像进入界面。
      setInput(draft => draft.trim() === text ? '' : draft)
      let accepted = false
      try {
        const result = await mirror.command({ kind: 'prompt', bindingId: target.bindingId, text, spoken, voiceTurn })
        if (voiceTurn && (!conversation.valid(voiceTurn.generation, voiceTurn.bindingId)
          || currentBinding.current !== voiceTurn.bindingId)) return
        accepted = result.ok
        if (result.notice) showToast(result.notice)
        if (!result.ok) {
          restoreDraft()
          showToast(result.error ?? '消息未提交，请重试')
        }
      } catch (error) {
        if (!voiceTurn || conversation.valid(voiceTurn.generation, voiceTurn.bindingId)) {
          restoreDraft()
          showToast(error instanceof Error ? error.message : String(error))
        }
      } finally {
        busyRef.current = false
        setBusy(false)
        if (voiceTurn) syncContinuous(conversation.result(voiceTurn, accepted))
      }
    },
    // send 只读 session 的 bindingId 与 capabilities.prompt：按这两项更新即可，避免每条增量都重建回调。
    [session?.bindingId, session?.capabilities.prompt, mirror.command, mirror.adopt, showToast, conversation, stopContinuous, syncContinuous],
  )

  const openSession = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const started = await window.petApi.startSession()
      if (started.ok && started.state) {
        mirror.adopt(started.state)
        showToast(started.notice ?? (started.outcome === 'existing' ? '助理会话已在线' : '助理会话已开启'))
      } else showToast(started.error ?? '助理会话没能开启，请稍后重试')
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [mirror.adopt, showToast])

  /** 主动提醒气泡上的点选（§2.7）：先撤气泡再回执，「好」把用户带进帮助流程。 */
  const handleProactive = useCallback((kind: 'accept' | 'decline' | 'disable') => {
    setProactive(null)
    window.clearTimeout(proactiveTimer.current)
    window.petApi.respondProactive(kind)
    if (kind !== 'accept') return
    voiceRoundRef.current = false
    // 点「好」必须立刻有可见反应：先打开对话框，助理在忙也要说清楚，不能静默丢掉。
    setPanelOpen(true)
    if (busyRef.current) {
      showToast('助理正在处理上一条，等它说完再一起看')
      return
    }
    void send(PROACTIVE_ACCEPT_MESSAGE)
  }, [send, showToast])

  /**
   * 请主进程打开专用审批窗口。
   *
   * 这**不是**"批准"。舞台渲染器画的是模型写的文本，按设计它没有签发批准的权限：
   * 一个能把不可信内容显示出来的进程，不能同时是决定"要不要执行"的那个进程。
   * 这里能做的只有报出想看哪一条 —— 提案内容由主进程自己去桥接取，决定在那个窗口里做
   * （见 `main/approval-window.ts`）。
   *
   * 界面上也不做"已批准"的表态：决定是从专用窗口回来的，那边成功之后主进程会收到
   * `proposal/decided` 事件并把这条从快照里摘掉，面板重拉一次自然就没了。
   */
  const openApproval = useCallback(
    async (proposalId: string) => {
      const result = await window.petApi.openApproval(proposalId)
      if (!result.ok) showToast(result.error || '审批窗口没能打开')
    },
    [showToast],
  )

  /** 团队管理页顶部的待批摘要；实际审批仍在主进程专用窗口完成。 */
  const banner = useMemo(() => approvalBanner(proposals), [proposals])

  /**
   * 按 assistantId 查显示名，给团队页的任务负责人与提案提请者用。
   *
   * 优先用快照里插件发来的名字（用户在插件侧改过就以那份为准），查不到再走角色清单兜底 ——
   * 清单认识固定编制里的五个角色，编制外的会合成一个，最坏显示成 id 本身，不会是空白。
   */
  const memberNames = useCallback(
    (assistantId: string): string | null => {
      const found = snapshot?.members?.find((item) => item.assistantId === assistantId)
      return manifestFor(found ?? { assistantId }).displayName
    },
    [snapshot],
  )

  /**
   * 第三个参数只在外放插话（M1-05）时给：插话检测器检出用户开口后，把检出点之前的预滚动音频
   * 交给这次听写，用户开头那几个字不丢。
   */
  const startListen = useCallback(async (autoSend = false, continuous = false, takeHandover?: () => DictationHandover | null, gateInterrupt = false) => {
    if (listeningRef.current) {
      if (continuous) stopContinuous(false)
      else if (!autoSend) stopDictation()
      return
    }
    if (busyRef.current && !autoSend) return
    // 手动开麦是用户自己接管：连续对话退出，本次仍按原样只填输入框。
    if (!continuous && conversation.active) stopContinuous(false)
    const generation = conversation.generation
    if (continuous && !conversation.record(generation, conversation.bindingId)) {
      if (conversation.active && conversation.generation === generation) stopContinuous(false)
      return
    }
    const token = ++dictationGeneration.current
    // 停止连续对话先让代号失效，迟到的申请结果和转写都在这里挡掉。
    const cancelled = () => dictationCancelled.current || token !== dictationGeneration.current
      || (continuous && !(conversation.active && conversation.generation === generation))
    listeningRef.current = true
    dictationCancelled.current = false
    // 口令式打断：先听清是不是明确口令，是才停朗读；普通声音（含助理自己的回声）不停。
    if (!gateInterrupt) window.petApi.stopSpeech()
    setListening(true)
    asrDeltaText.current = ''
    const accept = async (text: string): Promise<void> => {
      if (cancelled()) return
      if (gateInterrupt) {
        const phrase = parseInterruptPhrase(text)
        if (!phrase.matched) return
        window.petApi.stopSpeech()
        if (conversation.active) stopContinuous(false)
        if (phrase.rest.length > 0) {
          // 口令后面还带了问题：当场回答，不用再说一遍。
          voiceRoundRef.current = true
          setInput(phrase.rest)
          if (!busyRef.current) void send(phrase.rest)
          else showToast('上一条消息尚未提交完成，语音已保留在输入框')
          return
        }
        // 只说了口令：停下，再开一次麦听你要问什么。
        showToast('已停下，请说你的问题')
        window.setTimeout(() => { void startListen(true) }, 150)
        return
      }
      // 插话时自己念了唤醒词：那是"停下"的意思，不是要发出去的一句话，也不重新进入唤醒流程。
      if (takeHandover && isWakePhraseOnly(text)) {
        showToast('已停下。想问什么直接说，或点麦克风')
        return
      }
      // 自回声：这段是不是助理自己刚说过的话被麦克风录回来了？
      // 外放时唤醒应答会紧跟开麦，不挡住就会凭空多出一句用户消息（现场故障）。
      if (isSelfSpeech(text)) {
        showToast('刚才是我的回声，已忽略；请再说一次')
        return
      }
      // 又只喊了一句名字（没有具体需求）：这是**本地的应答往返**，不该进 DSH 会话，
      // 也不该调模型。回一句"我在，你说"，然后继续等真正的问题。
      if (isWakePhraseOnly(text)) {
        const again = pickLocalGreeting()
        const who = selectedId ?? cast[0]?.assistantId
        if (who) stageRef.current?.sayTo(who, again, 2600)
        rememberSelfSpeech(again)
        // 继续听，不算一轮对话。和首次唤醒一样等应答真正播完，不按字数猜。
        let resumed = false
        const resume = (): void => {
          if (resumed || exitingRef.current) return
          resumed = true
          wakeListenPending.current = null
          clearTimeout(wakeListenTimer.current)
          void startListen(true, continuous)
        }
        wakeListenPending.current = resume
        clearTimeout(wakeListenTimer.current)
        wakeListenTimer.current = setTimeout(resume, 15_000)
        window.petApi.speakLocal(again)
        return
      }
      if (continuous) {
        if (isVoiceStop(text)) {
          stopContinuous(false)
          showToast('已结束连续对话')
          return
        }
        const turn = conversation.submit()
        if (turn === null) {
          setInput(text)
          stopContinuous(false)
          showToast('连续对话已到上限，这句话留在输入框里，可以手动发送')
          return
        }
        voiceRoundRef.current = true
        setInput(text)
        void send(text, turn)
        return
      }
      voiceRoundRef.current = true
      setInput(text)
      if (autoSend && !busyRef.current) void send(text)
      else if (autoSend) showToast('上一条消息尚未提交完成，语音已保留在输入框，请稍后发送')
    }
    // 无论录音还是转写哪一步抛错，finally 都会把状态收回来。
    // 红灯在申请仲裁前就亮：双击的第二下会走进上面的停止分支，而不是发出第二个请求。
    try {
      const granted = await window.petApi.asrBegin()
      if (!granted.ok) {
        showToast(granted.error || '麦克风正被占用')
        return
      }
      if (cancelled()) {
        if (granted.streaming) await window.petApi.asrStreamStop()
        else await window.petApi.asrTranscribe('')
        return
      }
      // 流式模式：每帧 PCM 送给主进程的流式识别器，部分文本实时回显输入框——
      // 说一个字出一个字。喂数串行化（并发 invoke 会乱序）；单帧失败不影响最终收尾。
      const streaming = granted.streaming === true
      let feedChain: Promise<void> = Promise.resolve()
      const { wav, error } = await recordDictation({
        takeHandover,
        // 开口就撤掉静默窗：接下来用户说的是完整一句，不能被"多久没听到"掐断。
        onSpeechStart: () => { if (continuous) clearTimeout(idleTimer.current) },
        onChunk: (pcm16k) => {
          // 若隐藏发生在申请麦克风期间，首个音频帧也要补停，不能重新开始听写。
          if (cancelled()) { stopDictation(); return }
          if (!streaming) return
          feedChain = feedChain
            .then(() => cancelled() ? { text: '' } : window.petApi.asrStreamFeed(pcm16Base64(pcm16k)))
            .then((partial) => {
              if (partial.text && !cancelled()) setInput(partial.text)
            })
            .catch(() => undefined)
        },
      })
      if (cancelled()) {
        await feedChain
        if (streaming) await window.petApi.asrStreamStop()
        else await window.petApi.asrTranscribe('')
        return
      }
      if (streaming) {
        // 双模型接力：流式文本**立即**上屏（体验），随后同一份录音交给 SenseVoice
        // 整句精修（准确），精修结果非空则无感替换。两个模型都在本地。
        await feedChain
        const partial = await window.petApi.asrStreamStop()
        if (cancelled()) return
        if (partial.text) {
          voiceRoundRef.current = true
          setInput(partial.text)
        }
        if (wav === null) {
          if (partial.text) await accept(partial.text)
          else showToast('没有听到说话内容，请靠近麦克风再说一次')
          return
        }
        const refined = await window.petApi.asrTranscribe(arrayBufferToBase64(wav))
        if (refined.ok && refined.text) await accept(refined.text)
        else if (partial.text) await accept(partial.text)
        else showToast(refined.error || '未识别到语音内容')
        return
      }
      if (wav !== null) {
        // 整句回退路径（流式模型没装）：wav 在渲染层转 base64 后交给主进程识别。
        const result = await window.petApi.asrTranscribe(arrayBufferToBase64(wav))
        if (result.ok && result.text) {
          await accept(result.text)
        } else {
          showToast(result.error || '未识别到语音内容')
        }
        return
      }
      // 渲染层没录到内容分两种：管线故障（error 有值）才值得换主进程录音再试；
      // 单纯"没听到说话"再录 12 秒也只是让用户多举着麦克风干等，直接说明就好。
      // 两条路都必须先归还麦克风——空串让主进程立即结算这次听写，
      // 不然仲裁器永远认为听写还在进行，之后每次点击都会被拒（"这一次听完再按"）。
      void window.petApi.asrTranscribe('')
      if (error) {
        showToast(error)
        const result = await window.petApi.asrRecordFallback()
        if (result.ok && result.text) {
          await accept(result.text)
        } else if (result.error) {
          showToast(result.error)
        } else {
          showToast('没有听到说话内容')
        }
        return
      }
      showToast('没有听到说话内容，请靠近麦克风再说一次')
    } catch (error) {
      // 兜住任何意外异常：归还麦克风（空串走"没听到"分支），状态在 finally 复位。
      void window.petApi.asrTranscribe('')
      showToast(error instanceof Error ? error.message : '语音输入出错，请重试')
    } finally {
      listeningRef.current = false
      setListening(false)
      // 这一句没交出去（静默、识别失败、被占用）就结束连续对话：静默一次即退出，不反复重开麦克风。
      if (continuous && conversation.generation === generation && conversation.phase === 'recording') {
        stopContinuous(false)
      }
    }
  }, [send, showToast, conversation, stopContinuous, selectedId, cast])
  /**
   * 外放插话检出（M1-05，实验开关）：渲染层已经本地止声，主进程随后停掉整段播报。
   * 连续对话里插话就是下一轮（本轮作废、立即续听）；不在连续对话里就按一次自动发送的听写。
   */
  const bargeInRef = useRef<(takeHandover: () => DictationHandover | null) => void>(() => undefined)
  bargeInRef.current = (takeHandover) => {
    if (exitingRef.current || listeningRef.current) {
      takeHandover()
      return
    }
    const continuous = conversation.active && conversation.interruptForBargeIn()
    if (continuous) {
      // 插话本身就是下一轮：静默窗从这次接管重新起算，别让上一轮的到期时间马上把麦关掉。
      conversation.awaiting()
      setContinuousActive(true)
      armIdleDeadline()
    }
    // 口令式打断：只有明确口令才停朗读，其余声音（包括助理自己的回声）不打断。
    void startListen(true, continuous, takeHandover, true)
  }
  useEffect(() => {
    const bridge = installAudioBridge(window.petApi, { onBargeIn: take => bargeInRef.current(take) })
    return () => bridge.dispose()
  }, [])
  continueListening.current = () => {
    if (conversation.phase !== 'waiting') return
    // 静默窗从"真的开始听"这一刻起算，并把到期关麦的定时器挂上。
    conversation.awaiting()
    void startListen(true, true)
    armIdleDeadline()
  }

  const onDragStart = useCallback((event: React.MouseEvent, behavior: PetBehavior) => {
    if (event.button !== 0 || exitingRef.current) return
    event.preventDefault()
    const { startDrag, dragMove, endDrag, poke } = behavior
    interactiveRef.current = true
    window.petApi.mouseState(true) // 拖拽期间保持接收鼠标事件
    startDrag()
    const origin = { x: event.clientX, y: event.clientY }
    let initialized = false
    const onMove = (ev: MouseEvent) => {
      // 首次移动先种下按下位置，只有一次移动事件的快速拖拽也能正确识别。
      if (!initialized) { dragMove(origin.x, origin.y); initialized = true }
      dragMove(ev.clientX, ev.clientY)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onBlur)
      const moved = endDrag()
      dragCleanupRef.current = null
      interactiveRef.current = false
      window.petApi.mouseState(false)
      if (!moved) {
        poke()
        setPanelOpen((v) => !v)
      }
    }
    const onBlur = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onBlur)
      endDrag()
      dragCleanupRef.current = null
      interactiveRef.current = false
      window.petApi.mouseState(false)
    }
    dragCleanupRef.current = onBlur
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onBlur)
  }, [])

  const reportOverlay = useCallback(() => {
    window.petApi.overlayState(stageVisible && panelOpen, [...stageHitboxes().values()], stageVisible && settingsPage !== null)
  }, [stageVisible, panelOpen, settingsPage])

  // 显隐变化立即上报；实时位置与命中盒由两个面板自行登记。
  useEffect(() => { reportOverlay() }, [reportOverlay])

  useEffect(() => {
    if (!stageVisible) {
      clearStageHitboxes()
      window.petApi.overlayState(false, [], false)
      return
    }
    return () => {
      dictationCancelled.current = true
      stopDictation()
      if (conversation.active) stopContinuous()
      dragCleanupRef.current?.()
      clearStageHitboxes()
      interactiveRef.current = false
      window.petApi.mouseState(false)
      window.petApi.overlayState(false, [], false)
    }
  }, [stageVisible])

  /**
   * 鼠标穿透判断：命中盒检测。
   *
   * 不能只在 mousemove 时判断 —— 角色会自己走动，走进/走出鼠标位置时鼠标没动、
   * 不触发 mousemove，点击就会穿透失效。也不能把角色坐标提到 state 里靠重渲染驱动，
   * 那等于每秒重渲染六十次。所以这里用一个低频轮询兜住"角色动了但鼠标没动"的情况：
   * 角色移速约 68px/s，100ms 才走 7px，而命中盒有 178px 宽，用户察觉不到这个延迟。
   */
  useEffect(() => {
    // 角色隐藏时窗口也藏起来了，命中盒随舞台一起卸载：这个 100ms 轮询不必跑。
    // 重新显示时 effect 重挂，末尾那次 update() 会立刻按最新命中盒校准一次穿透状态。
    if (!stageVisible) return
    const update = () => {
      if (exitingRef.current || dragCleanupRef.current) return
      const { x, y } = lastMouseRef.current
      if (x < 0) return
      const interactive = hitTest(x, y)
      if (interactive !== interactiveRef.current) {
        interactiveRef.current = interactive
        window.petApi.mouseState(interactive)
      }
    }
    const onMove = (event: MouseEvent) => {
      lastMouseRef.current = { x: event.clientX, y: event.clientY }
      update()
    }
    window.addEventListener('mousemove', onMove)
    const ticker = window.setInterval(() => { update(); reportOverlay() }, 100)
    update()
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.clearInterval(ticker)
    }
  }, [stageVisible, reportOverlay])

  // 唤醒应答真正播完才开麦。主进程用系统播放器的关闭事件回报，比按字数估时可靠。
  useEffect(() => {
    window.petApi.onWakeGreetingFinished(() => {
      const begin = wakeListenPending.current
      if (begin === null) return
      wakeListenPending.current = null
      clearTimeout(wakeListenTimer.current)
      begin()
    })
  }, [])

  // 快捷键 / 语音唤醒只展开会话，不切换独立管理页。
  useEffect(() => {
    const summon = () => {
      if (exitingRef.current) return
      setPanelOpen(true)
      window.setTimeout(() => inputRef.current?.focus(), 60)
    }

    window.petApi.onSummon(summon)
    window.petApi.onWake((greeting) => {
      // 连续对话进行中再听到唤醒词多半是自己播报的回声：不重入、不重开麦克风。
      if (exitingRef.current || conversation.active) return
      const now = Date.now()
      if (now - wakeLockRef.current < 2600) return
      wakeLockRef.current = now
      const who = selectedId ?? cast[0]?.assistantId
      const stage = stageRef.current
      // 主进程已经用 TTS 念了应答；这里只把它显示成气泡，不再另念一遍。
      // 显示的必须是**同一句**：语音说 A、气泡显示 B 会让人以为它答非所问。
      const line = greeting && greeting.length > 0 ? greeting : WAKE_GREETING
      if (who && stage) {
        // 被叫到时先站定：正在走、打盹、看书都收回来，做一个明确的"我在"姿态。
        stage.forceAll('idle')
        stage.sayTo(who, line, 3000)
      } else if (who) {
        // 角色刚被隐藏：主进程先发"显示"再发唤醒事件，这一刻舞台还没挂回来，应答留给下面的 effect。
        pendingGreetingRef.current = true
        pendingGreetingLineRef.current = line
      }
      summon()
      if (!voiceConversation) return
      const binding = currentBinding.current
      // 唤醒应答是**外放**的，而紧接着就要开麦克风听用户说话 —— 两者一重叠，
      // 麦克风就会录到助理自己的声音，识别成一句话当成用户输入发出去
      // （现场现象：对话里凭空多出一句「我在这。」）。
      // 先等应答播完再开麦；同时把这句话记进自回声过滤表，双保险。
      rememberSelfSpeech(line)
      let started = false
      const beginListen = (): void => {
        if (started || exitingRef.current) return
        started = true
        wakeListenPending.current = null
        clearTimeout(wakeListenTimer.current)
        if (continuousVoice && binding && conversation.start(binding, voiceConversation, continuousVoice)) {
          setContinuousActive(true)
          armContinuousDeadline()
          armIdleDeadline()
          void startListen(true, true)
        } else {
          void startListen(true)
        }
      }
      // 正常由主进程在应答真正播完后触发；播放器异常或事件丢失时保底开麦。
      // 不再按字数估算：短问候语会估得比实际播放久，用户听到后立刻说话就被截掉开头。
      wakeListenPending.current = beginListen
      clearTimeout(wakeListenTimer.current)
      wakeListenTimer.current = setTimeout(beginListen, 15_000)
    })
  }, [selectedId, cast, voiceConversation, continuousVoice, startListen, conversation, armContinuousDeadline, armIdleDeadline])

  /** 壳推来的两件事：启动握手走到哪一步、角色该不该在桌面上。 */
  useEffect(() => {
    window.petApi.onCompanionState(setCompanion)
    window.petApi.onStageVisible(setStageVisible)
  }, [])

  /**
   * 主动提醒气泡（design.md §2.7）。收到候选先挂起，显不显示交给 render 处的
   * 专注守卫 —— 用户可能在气泡到达后才开专注，那一刻气泡必须立刻消失。
   */
  useEffect(() => {
    window.petApi.onProactive((payload) => {
      setProactive({ message: payload.message, suggestDisable: payload.suggestDisable === true })
      window.clearTimeout(proactiveTimer.current)
      proactiveTimer.current = window.setTimeout(() => setProactive(null), PROACTIVE_BUBBLE_TTL_MS)
    })
    return () => window.clearTimeout(proactiveTimer.current)
  }, [])

  /**
   * 角色在不在念，以及念不念得出来。
   *
   * 后半句更要紧：合成失败是个听不见的故障，界面上不说一句，用户只会觉得"它没反应"。
   */
  useEffect(() => {
    window.petApi.onSpeechState((status) => {
      setSpeech(status)
      // 语音归属与合成由主进程处理；停止朗读不改变原生会话状态。
      if (status.error) showToast(speechErrorText(status.error))
    })
  }, [showToast])

  /**
   * 语音识别的流式增量（mimo 等服务）：边识别边出字，最终文本以 asrTranscribe 返回值为准。
   * 本地流式识别走 asrStreamFeed，不经过这里。
   */
  useEffect(() => {
    window.petApi.onAsrDelta((delta) => {
      if (delta.text === '' || !listeningRef.current || dictationCancelled.current) return
      asrDeltaText.current += delta.text
      setInput(asrDeltaText.current)
    })
  }, [])

  /** 文档回执不属于原生会话，最近六条仅保存在文档管理结果区。 */
  const addDocResult = useCallback((text: string, error = false) => {
    if (!text.trim()) return
    setDocResults(previous => previous[0]?.text === text && previous[0]?.error === error
      ? previous : [{ text, error }, ...previous].slice(0, 6))
  }, [])

  useEffect(() => {
    window.petApi.onDocState(setDocState)
    window.petApi.onDocReply(reply => addDocResult(reply.text))
    // 文档提示同时弹一条气泡：这条路径不一定打开文档面板，只写结果区用户就看不见。
    window.petApi.onDocNotice(message => { addDocResult(message); showToast(message) })
    void window.petApi.docRoots().then(setDocRoots)
  }, [addDocResult, showToast])

  /**
   * 文档操作的统一收口。
   *
   * 按住按钮避免连点排出两条讲解链；回执留在文档结果区，失败信息不会随提示消失。
   * 措辞全在主进程，界面不重写一遍：两处各写一份，早晚会一边说"已打开"一边说"打不开"。
   */
  const runDoc = useCallback(
    async (action: () => Promise<{ ok: boolean; reply?: string; error?: string }>) => {
      setDocBusy(true)
      try {
        const result = await action()
        const said = result.reply ?? (result.ok ? null : (result.error ?? '这件事没做成'))
        if (said !== null) addDocResult(said, !result.ok)
        if (!result.ok) showToast(result.error ?? '这件事没做成')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        addDocResult(message, true)
        showToast(message)
      } finally {
        setDocBusy(false)
      }
    },
    [showToast, addDocResult],
  )

  const docOpen = useCallback((path: string) => void runDoc(() => window.petApi.openDoc(path)), [runDoc])
  const docExplain = useCallback(
    (path: string, from: number) => void runDoc(() => window.petApi.explainDoc(path, from)),
    [runDoc],
  )
  const docAsk = useCallback(
    (index: number, question: string) => {
      const path = docState.kind === 'outline' ? docState.path : null
      if (path === null) return
      void runDoc(() => window.petApi.askDoc(path, index, question))
    },
    [docState, runDoc],
  )
  /** 加目录要弹原生选择框，用户点了取消也算一次正常收场，不该报错。 */
  const docAddRoot = useCallback(async () => {
    setDocBusy(true)
    try {
      setDocRoots(await window.petApi.addDocRoot())
    } finally {
      setDocBusy(false)
    }
  }, [])
  const docRemoveRoot = useCallback(async (path: string) => {
    setDocRoots(await window.petApi.removeDocRoot(path))
  }, [])
  const docForgetDir = useCallback(async (path: string) => {
    setDocRoots(await window.petApi.forgetDocDir(path))
  }, [])

  /**
   * 舞台挂回来之后，补上被隐藏时错过的那句应答。
   *
   * 不补的话用户对着桌面喊一声"小潘同学"，角色出现了却没人应，看起来像唤醒坏了。
   * 子组件的 ref 在父组件的 effect 之前就赋好了，所以这里能直接拿到舞台句柄。
   */
  useEffect(() => {
    if (!stageVisible || !pendingGreetingRef.current) return
    pendingGreetingRef.current = false
    const who = selectedId ?? cast[0]?.assistantId
    const line = pendingGreetingLineRef.current ?? WAKE_GREETING
    pendingGreetingLineRef.current = null
    if (who) {
      stageRef.current?.forceAll('idle')
      stageRef.current?.sayTo(who, line, 3000)
    }
  }, [stageVisible, selectedId, cast])

  /**
   * 启动/停止团队运行时。
   *
   * 成败不看返回值：IPC 的 ok 只说明主进程收到了请求（壳没了才是 false）。
   * 真正的握手结果由主进程陆续推 companion-state，界面画那个。
   */
  const startRuntime = useCallback(async () => {
    const result = await window.petApi.startRuntime()
    if (!result.ok) showToast('桌面壳正在退出，没法启动运行时')
  }, [showToast])

  const stopRuntime = useCallback(async () => {
    const result = await window.petApi.stopRuntime()
    if (!result.ok) showToast('桌面壳正在退出，没法停止运行时')
  }, [showToast])

  /**
   * 角色隐藏时把整个舞台连同面板一起卸掉，不只是藏起来。
   *
   * 舞台是共享场景时钟的订阅者：卸掉之后最后一个订阅者退订，16ms 的定时器才真的停下 ——
   * 五个看不见的角色继续每帧空转是白烧 CPU。
   *
   * 这个 return 必须排在所有 hook 之后。退场动画、快捷键、语音唤醒的监听都挂在 hook 上，
   * 跟着舞台一起卸掉的话，用户再按快捷键就没人应答，主进程只能靠 7s 兜底定时器退出。
   */
  const [operations, setOperations] = useState<OperationalState | null>(null)
  useEffect(() => {
    if (settingsPage !== 'general' || !stageVisible) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    setOperations(null)
    const refresh = async () => {
      try {
        const state = await window.petApi.getState(true)
        if (!cancelled) setOperations(state.operations ?? null)
      } catch { if (!cancelled) setOperations(null) }
      if (!cancelled) timer = setTimeout(() => void refresh(), 2000)
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [settingsPage, stageVisible])

  if (!stageVisible) return null

  const runtime = companion && {
    tone: runtimeTone(companion),
    label: runtimeLabel(companion),
    detail: runtimeDetail(companion),
    canStart: runtimeCanStart(companion),
    ownPid: companion.ownPid,
  }

  return (
    <div className="stage" onMouseDownCapture={wakeConversation} onKeyDownCapture={wakeConversation}>
      {toast && <div className="toast" role="status">{toast}</div>}

      {panelOpen && (
        <ChatOverlay
          session={session}
          error={mirror.error}
          stageRef={stageRef}
          inputRef={inputRef}
          input={input}
          setInput={value => { voiceRoundRef.current = false; setInput(value) }}
          onSend={() => void send(input)}
          onClose={() => setPanelOpen(false)}
          dock={chatDock}
          size={chatSize}
          onResize={size => {
            setChatSize(size)
            void window.petApi.saveSettings({ chatSize: size })
          }}
          onCommand={command => {
            if (command.kind === 'cancel') stopContinuous(false)
            return mirror.command(command)
          }}
          onListen={() => void startListen()}
          listening={listening}
          sending={busy}
          speaking={speech.speaking}
          onStopSpeech={() => { stopContinuous(false); window.petApi.stopSpeech() }}
          continuous={continuousActive}
          onEndContinuous={() => { stopContinuous(); showToast('已结束连续对话') }}
          onStartSession={() => void openSession()}
          loadingOlder={mirror.loadingOlder}
          loadOlder={mirror.loadOlder}
          hiddenThroughSeq={presentationCutoff}
        />
      )}

      {settingsPage !== null && (
        <PetSettingsPanel page={settingsPage} onPage={setSettingsPage} onClose={() => setSettingsPage(null)}>
          {settingsPage === 'general' ? (
            <div className="management-general">
              <section className="management-section" aria-label="运行时与诊断">
                <h3>运行时与诊断</h3>
                {runtime ? (
                  <div className={`runtime-row tone-${runtime.tone}`} role="status">
                    <div className="runtime-line">
                      <span className="runtime-dot" aria-hidden />
                      <span className="runtime-label">{runtime.label}</span>
                      {runtime.canStart && <button className="runtime-btn" onClick={() => void startRuntime()}>启动团队</button>}
                      {runtime.ownPid !== null && <button className="runtime-btn ghost" onClick={() => void stopRuntime()}>停止</button>}
                    </div>
                    {runtime.detail && <div className="runtime-detail">{runtime.detail}</div>}
                  </div>
                ) : <p className="management-hint">正在获取运行时状态…</p>}
                <dl aria-label="助理能力实际状态">
                  {operations ? operationLabels(operations).map(item => (
                    <div className="card-row" key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>
                  )) : <div><dt>能力状态</dt><dd>尚未取得状态，不能据此判断正在记录或已停止。</dd></div>}
                </dl>
                <p className="management-diagnostic">界面构建 <code>{UI_BUILD}</code></p>
                {companion && <p className="management-diagnostic">运行配置 <code>{companion.profile}</code></p>}
                <button className="management-button" onClick={() => void mirror.refresh().catch(error => showToast(String(error)))}>重新同步会话</button>
              </section>
              <section className="management-section" aria-label="睡眠与唤醒">
                <h3>睡眠与唤醒</h3>
                {(['idleSleepMinutes', 'sleepMinutes'] as const).map(key => (
                  <label className="management-sleep" key={`${key}-${sleepSettings[key]}`}>
                    <span>{key === 'idleSleepMinutes' ? '无互动多久后入睡' : '每次睡眠时长'}</span>
                    <input type="number" min={1} max={120} step={1} defaultValue={sleepSettings[key]} disabled={savingSleep}
                      onBlur={event => {
                        const value = Number(event.currentTarget.value)
                        event.currentTarget.value = String(sleepSettings[key])
                        if (value !== sleepSettings[key]) void saveSleep(key, value)
                      }} />分钟
                  </label>
                ))}
                <label className="management-voice">
                  <input type="checkbox" checked={voiceConversation} disabled={listening}
                    onChange={async event => {
                      const enabled = event.target.checked
                      try {
                        const result = await window.petApi.saveSettings({ voiceConversation: enabled })
                        if (result.ok) setVoiceConversation(enabled)
                        else showToast('语音对话设置未保存')
                      } catch { showToast('语音对话设置未保存') }
                      if (!enabled && conversation.active) stopContinuous()
                    }} />
                  唤醒后自动听取并发送本次语音
                </label>
                <label className="management-voice">
                  <input type="checkbox" checked={continuousVoice} disabled={listening || !voiceConversation}
                    onChange={async event => {
                      const enabled = event.target.checked
                      try {
                        const result = await window.petApi.saveSettings({ continuousVoice: enabled })
                        if (result.ok) setContinuousVoice(enabled)
                        else showToast('连续对话设置未保存')
                      } catch { showToast('连续对话设置未保存') }
                      if (!enabled && conversation.active) stopContinuous()
                    }} />
                  唤醒后的连续对话：最多 10 轮或 5 分钟；一轮回答播完后会继续听，连续 10 秒没听到你开口才结束。沿用当前识别、朗读服务与数据去向。保存后从下一次唤醒起生效，不会立刻开麦。
                </label>
                <label className="management-voice">
                  <input type="checkbox" checked={readReplies}
                    onChange={async event => {
                      const enabled = event.target.checked
                      try {
                        const result = await window.petApi.saveSettings({ readReplies: enabled })
                        if (result.ok) setReadReplies(enabled)
                        else showToast('朗读回复设置未保存')
                      } catch { showToast('朗读回复设置未保存') }
                    }} />
                  朗读回复：打字发出的消息也把回答念出来（语音发起的那一轮本来就会念）
                </label>
                <label className="management-voice">
                  <input type="checkbox" checked={chatDock === 'top'}
                    onChange={async event => {
                      const pinned = event.target.checked
                      const next = pinned ? 'top' : 'auto'
                      try {
                        const result = await window.petApi.saveSettings({ chatDock: next })
                        if (result.ok) setChatDock(next)
                        else showToast('会话框设置未保存')
                      } catch { showToast('会话框设置未保存') }
                    }} />
                  会话框固定在宠物头顶（关闭后按屏幕空间自动换到上/下/左/右）
                </label>
              </section>
              <ResidencySettings
                activity={operations && operations.connection === 'connected' ? operations.activity : null}
                onOpenActivity={() => {
                  // 活动记录的授权走插件的可信审批：这里只把开启指令放进输入框，由用户自己发出去。
                  setSettingsPage(null)
                  setPanelOpen(true)
                  setInput('开启个人助理模式')
                  window.setTimeout(() => inputRef.current?.focus(), 60)
                }}
                showToast={showToast}
              />
              <EnvironmentCheck showToast={showToast} />
              <WorkEvidenceSettings showToast={showToast} />
              <PresentationSettings active={presentation} />
              <VoiceApiSettings />
              <section className="management-section" aria-label="快捷操作">
                <h3>快捷操作</h3>
                <div className="management-quick">
                  {QUICK_COMMANDS.map(command => (
                    <button className="management-button" key={command} disabled={busy} onClick={() => {
                      voiceRoundRef.current = false
                      void send(command)
                    }}>{command}</button>
                  ))}
                  <button className="management-button" onClick={() => void window.petApi.openReportWorkbench()
                    .then(result => { if (!result.ok) showToast('日报工作台未能打开') })
                    .catch(() => showToast('日报工作台未能打开'))}>日报工作台</button>
                  <button className="management-button" onClick={() => void window.petApi.openReportDir()
                    .then(result => { if (!result.ok) showToast('日报文件夹未能打开') })
                    .catch(() => showToast('日报文件夹未能打开'))}>打开日报文件夹</button>
                </div>
              </section>
            </div>
          ) : settingsPage === 'team' ? (
            <>
              <h3 className="management-page-title" id="panel-tab-team">团队管理</h3>
              {banner && (
                <div className="approval-banner" role="status">
                  <span className="approval-banner-dot" aria-hidden />
                  <span className="approval-banner-text">{banner.headline}</span>
                  {banner.count === 1 && <button type="button" className="approval-banner-go"
                    onClick={() => void openApproval(banner.proposalId)}>去审批</button>}
                </div>
              )}
              <p className="management-hint">运行时启停与连接诊断请到通用设置。</p>
              <TeamPanel snapshot={snapshot} memberNames={memberNames} onOpenApproval={openApproval} bindingId={session?.bindingId} />
              {snapshot?.team && <form className="management-section" onSubmit={async event => {
                event.preventDefault()
                if (!delegateId || !delegateText.trim() || delegating) return
                setDelegating(true)
                setDelegateResult('')
                try {
                  const result = await window.petApi.chat(delegateText.trim(), delegateId, false)
                  setDelegateResult(result.reply ?? result.error ?? '任务已完成')
                  if (result.ok) setDelegateText('')
                } catch (error) { setDelegateResult(String(error)) }
                finally { setDelegating(false) }
              }}>
                <h3>委派专家任务</h3>
                <select aria-label="任务接收成员" value={delegateId} onChange={event => setDelegateId(event.target.value)} disabled={delegating}>
                  <option value="">选择成员</option>
                  {snapshot.members?.filter(member => member.roleId !== 'tangseng').map(member =>
                    <option key={member.assistantId} value={member.assistantId}>{member.displayName || member.assistantId}</option>)}
                </select>
                <textarea aria-label="专家任务内容" value={delegateText} onChange={event => setDelegateText(event.target.value)} rows={3} disabled={delegating} />
                <button type="submit" className="management-button" disabled={delegating || !delegateId || !delegateText.trim()}>{delegating ? '正在处理…' : '委派任务'}</button>
                {delegateResult && <p role="status">{delegateResult}</p>}
              </form>}
            </>
          ) : settingsPage === 'meeting' ? (
            <MeetingPanel />
          ) : (
            <>
              <h3 className="management-page-title" id="panel-tab-doc">文档管理</h3>
              <section className="management-doc-results" aria-label="文档操作结果">
                <h4>最近结果</h4>
                <p className="management-hint">文档讲解与问答显示在这里，不进入原生会话。</p>
                <div className="management-doc-log" role="log" aria-live="polite" aria-relevant="additions text">
                  {docResults.length ? docResults.map((result, index) => (
                    <p key={index} className={result.error ? 'is-error' : undefined}>{result.text}</p>
                  )) : <p>尚无文档操作结果。</p>}
                </div>
              </section>
              <DocPanel
                state={docState}
                roots={docRoots}
                busy={docBusy}
                speaking={speech.speaking}
                onOpen={docOpen}
                onExplain={docExplain}
                onAsk={docAsk}
                onStop={() => window.petApi.stopSpeech()}
                onAddRoot={() => void docAddRoot()}
                onRemoveRoot={dir => void docRemoveRoot(dir)}
                onForgetDir={dir => void docForgetDir(dir)}
              />
            </>
          )}
        </PetSettingsPanel>
      )}

      <TeamStage
        members={cast}
        idleSleepMinutes={sleepSettings.idleSleepMinutes}
        sleepMinutes={sleepSettings.sleepMinutes}
        // 共享协议没有个人助理模式字段，不从回答措辞猜测模式开关。
        assistantActive={false}
        statusByAssistant={stageStatuses}
        positions={positions}
        selectedId={selectedId}
        chatOpen={panelOpen}
        onSelect={handleSelect}
        exitStage={exitStage}
        portalPhase={portalPhase}
        showPortal={exitStage !== 'none'}
        focusMode={companion?.focusMode === true}
        characterSkins={characters}
        onPersist={handlePersist}
        onContextMenu={(target: CharacterMenuTarget) => window.petApi.contextMenu(target)}
        onDragStart={onDragStart}
        // 专注模式一开提醒就必须立刻消失：渲染层再挡一道，和主进程的评估输入同一道闸。
        proactive={companion?.focusMode === true || presentation ? null : proactive}
        onProactiveRespond={handleProactive}
        handleRef={stageRef}
      />
    </div>
  )
}
