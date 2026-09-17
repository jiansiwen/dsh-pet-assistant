import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TeamStage, { type TeamStageHandle } from './TeamStage.js'
import TeamPanel from './TeamPanel.js'
import DocPanel from './DocPanel.js'
import {
  clearStageHitboxes,
  hitTest,
  projectTaskStatuses,
  registerPanelHitbox,
  type ExitStage,
  type StageMember,
  type StageTaskStatus,
} from './stage-layout.js'
import { manifestFor, manifestForLegacySkin } from './character-manifest.js'
import { PET_WIDTH, STAGE_MARGIN } from './pet-metrics.js'
import { PROACTIVE_ACCEPT_MESSAGE } from './proactive-ui.js'
import { arrayBufferToBase64, pcm16Base64, recordDictation, stopDictation } from './dictation.js'
import { approvalBanner } from './team-panel.js'
import { runtimeCanStart, runtimeDetail, runtimeLabel, runtimeTone } from './runtime-status.js'
import type { PetBehavior } from './usePetBehavior.js'
import type { PortalPhase } from './PortalExit.js'
import type {
  BridgeEventPayload,
  CharacterMenuTarget,
  CompanionState,
  DocRoots,
  DocState,
  PetPosition,
  SkinOverrides,
  SpeechStatus,
  TeamProposalSnapshot,
  TeamSnapshot,
} from './types.js'
import './pet-anim.css'
import './portal.css'
import './team.css'

interface Message {
  role: 'user' | 'assistant'
  text: string
  error?: boolean
}

const QUICK_COMMANDS = ['开启个人助理模式', '我今天干了啥？', '总结今日工作内容']

/** 语音唤醒命中时的应答。角色被隐藏时这句要等舞台挂回来再补说，所以提成常量。 */
const WAKE_GREETING = '我在呢！找我什么事？'

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

/** 面板宽度。定位夹边用它；高度是内容驱动的，命中盒靠实测，所以这里只有一个常量。 */
const PANEL_WIDTH = 388

export default function App() {
  const [pet, setPet] = useState('panda')
  /**
   * 用户在本机为每个角色挑的形象，键是 assistantId。
   *
   * 真源是 pet-settings.json，写在主进程（原生菜单里点的那一下）。这里只在启动时读一次、
   * 之后听广播 —— 界面不自己推断"他大概想换成熊猫吧"。
   */
  const [characters, setCharacters] = useState<SkinOverrides>({})
  const [panelOpen, setPanelOpen] = useState(false)
  /**
   * 面板当前停在哪一页。
   *
   * 对话页回答"我刚才那句话有没有人接"，团队页回答"今天谁在做什么、哪件事卡在我这儿"。
   * 分成两页是因为面板高度是 max-height 500 的硬预算：任务列表和消息区都要伸缩，
   * 挤在一页里的话被裁掉的是输入框——面板最不能没有的东西。
   * 默认是对话页，那是用户点开面板时最常在做的动作。
   */
  const [panelTab, setPanelTab] = useState<'chat' | 'team' | 'doc'>('chat')
  const [panelPos, setPanelPos] = useState<PetPosition | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
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
  const [assistantActive, setAssistantActive] = useState(false)
  const [toast, setToast] = useState('')

  /** 团队编制。null 表示桥接还没给过数据 —— 那时按旧的单宠物模式渲染一个角色。 */
  const [members, setMembers] = useState<StageMember[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [positions, setPositions] = useState<Record<string, PetPosition>>({})
  const [statusByAssistant, setStatusByAssistant] = useState<Record<string, StageTaskStatus>>({})
  /** 待批准的副作用提案。这是唯一必须用户点头才能继续的事，要在面板里显眼。 */
  const [proposals, setProposals] = useState<TeamProposalSnapshot[]>([])
  /** 团队模式是否开启。关闭时不显示成员与审批区，界面退回单助理形态。 */
  const [teamEnabled, setTeamEnabled] = useState(false)
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

  const positionsRef = useRef(positions)
  positionsRef.current = positions

  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const interactiveRef = useRef(false)
  /** 最近一次鼠标位置：角色会自己走动，不能只在 mousemove 时判断命中。 */
  const lastMouseRef = useRef({ x: -1, y: -1 })
  /** 唤醒去抖：连续识别到唤醒词时只响应一次。 */
  const wakeLockRef = useRef(0)
  /** 角色隐藏时被唤醒：应答留到舞台挂回来再说，否则用户喊了一声却没人应。 */
  const pendingGreetingRef = useRef(false)
  const stageRef = useRef<TeamStageHandle | null>(null)

  /**
   * 桥接没连上（插件没启动、dsh 没跑）时的降级编制。
   *
   * 用旧皮肤映射到对应角色，所以单宠物时代的熊猫仍然是唐僧、眼镜男生仍然是孙悟空 ——
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

  /** 面板标题跟着选中的角色走：名字与身份色标都取自同一份清单，避免两处各写一份。 */
  const selectedManifest = useMemo(
    () => (selectedMember ? manifestFor(selectedMember, characters) : null),
    [selectedMember, characters],
  )

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
      setCharacters(state.characters ?? {})
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
   * 消息区滚到底。
   *
   * `panelTab` 也在依赖里：切到团队页时消息区整块被卸载，切回来那是个新的 DOM 元素、
   * scrollTop 归零。不重滚一次的话，用户从团队页切回来看到的是对话开头，而不是最新那一句。
   */
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, busy, panelTab])

  /**
   * 应用一次团队快照。
   *
   * 快照是唯一权威：事件只用来触发"该重新看一眼了"，不用来逐字段改状态。
   * 增量更新要正确处理十几种事件各自的 payload 形状，漏掉一个字段界面就和真实状态不符 ——
   * 而 `/team` 是本地回环上的内存快照，重拉的代价可以忽略。
   */
  const applySnapshot = useCallback((next: TeamSnapshot) => {
    setSnapshot(next)
    setTeamEnabled(next.team === true)
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
      // 回复类事件由 chat() 的等待逻辑处理；流式增量尤其频繁，拿它触发重拉纯属浪费。
      if (event.type === 'reply' || event.type.startsWith('reply/') || event.type === 'session-ended') return
      requestRefresh()
    })
    return () => window.clearTimeout(refreshTimer.current)
  }, [applySnapshot, requestRefresh])

  const showToast = useCallback((text: string) => {
    setToast(text)
    setTimeout(() => setToast(''), 4000)
  }, [])

  const handleSelect = useCallback((assistantId: string, position: PetPosition) => {
    setSelectedId(assistantId)
    setPanelPos(position)
  }, [])

  const handlePersist = useCallback((assistantId: string, x: number, y: number) => {
    const next = { ...positionsRef.current, [assistantId]: { x, y } }
    positionsRef.current = next
    setPositions(next)
    void window.petApi.saveSettings({ positions: next })
  }, [])

  /**
   * 点名策略：选中总助理时**不**传 assistantId。
   *
   * 总助理走的是主会话直连路径（agent.followup），"开启个人助理模式""总结今日工作"这些
   * 既有能力都在这条路上。点名会让它绕去建任务、起子代理 —— 对一个简单的开关指令来说
   * 纯属绕远，还会让这些指令的表现和改造前不一致。专家才需要委派。
   *
   * 判据是 `roleId === 'tangseng'`，不是"编制里第一个"：数组顺序是数据库读出来的，
   * 换个查询就可能变，而 roleId 是成员的稳定语义标识。
   */
  const targetAssistantId = useMemo(() => {
    if (!teamEnabled || !selectedMember) return undefined
    return selectedMember.roleId === 'tangseng' ? undefined : selectedMember.assistantId
  }, [teamEnabled, selectedMember])

  /**
   * 这一轮的输入是不是从麦克风来的。
   *
   * 只有语音发起的那一轮回答才念出来 —— 打字问的话突然出声，是用户没要求过的行为。
   * 用 ref 而不是 state：它只在 send 那一刻被读一次，不值得为它触发一次重渲染。
   */
  const voiceRoundRef = useRef(false)

  const send = useCallback(
    async (raw: string, assistantIdOverride?: string) => {
      const text = raw.trim()
      if (!text || busy) return
      const spoken = voiceRoundRef.current
      voiceRoundRef.current = false
      setInput('')
      setMessages((prev) => [...prev, { role: 'user', text }])
      setBusy(true)
      try {
        // 主动提醒的「好」要发给总助理而不是当前选中的专家：提醒是唐僧的职责（§2.2），
        // 用户顺手选中了悟空也不该让这句话被点名带跑。
        const result = await window.petApi.chat(text, assistantIdOverride ?? targetAssistantId, spoken)
        if (result.ok) {
          setMessages((prev) => [...prev, { role: 'assistant', text: result.reply || '（无回复）' }])
          if (/记一下|帮我记|记录/.test(text)) {
            const who = selectedId ?? cast[0]?.assistantId
            if (who) stageRef.current?.writeOf(who)
          }
          if (/开启/.test(text) && /已开启|开始记录/.test(result.reply ?? '')) setAssistantActive(true)
          if (/已退出|已关闭/.test(result.reply ?? '')) setAssistantActive(false)
        } else {
          setMessages((prev) => [...prev, { role: 'assistant', text: `出错了：${result.error}`, error: true }])
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setMessages((prev) => [...prev, { role: 'assistant', text: `出错了：${message}`, error: true }])
      } finally {
        setBusy(false)
      }
    },
    [busy, selectedId, cast, targetAssistantId],
  )

  /** 主动提醒气泡上的点选（§2.7）：先撤气泡再回执，「好」把用户带进帮助流程。 */
  const handleProactive = useCallback((kind: 'accept' | 'decline' | 'disable') => {
    setProactive(null)
    window.petApi.respondProactive(kind)
    if (kind === 'accept') void send(PROACTIVE_ACCEPT_MESSAGE, undefined)
  }, [send])

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

  /** 对话页上那条紧凑提示。完整列表在团队页，这里只负责让人打字时也知道有东西在等。 */
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

  const startListen = useCallback(async () => {
    // 录音中再点一次 = 手动停止：立刻收尾，已录到的话照常转写。
    if (listening) {
      stopDictation()
      return
    }
    if (busy) return
    setListening(true)
    // 🔴 必须灭：无论录音还是转写哪一步抛错，finally 都会把状态收回来。
    // 红灯在申请仲裁前就亮：双击的第二下会走进上面的停止分支，而不是发出第二个请求。
    try {
      const granted = await window.petApi.asrBegin()
      if (!granted.ok) {
        showToast(granted.error || '麦克风正被占用')
        return
      }
      // 流式模式：每帧 PCM 送给主进程的流式识别器，部分文本实时回显输入框——
      // 说一个字出一个字。喂数串行化（并发 invoke 会乱序）；单帧失败不影响最终收尾。
      const streaming = granted.streaming === true
      let feedChain: Promise<void> = Promise.resolve()
      const { wav, error } = await recordDictation(
        streaming
          ? {
              onChunk: (pcm16k) => {
                feedChain = feedChain
                  .then(() => window.petApi.asrStreamFeed(pcm16Base64(pcm16k)))
                  .then((partial) => {
                    if (partial.text) setInput(partial.text)
                  })
                  .catch(() => undefined)
              },
            }
          : {},
      )
      if (streaming) {
        // 双模型接力：流式文本**立即**上屏（体验），随后同一份录音交给 SenseVoice
        // 整句精修（准确），精修结果非空则无感替换。两个模型都在本地。
        const partial = await window.petApi.asrStreamStop()
        if (partial.text) {
          voiceRoundRef.current = true
          setInput(partial.text)
        }
        if (wav === null) {
          if (!partial.text) showToast('没有听到说话内容，请靠近麦克风再说一次')
          return
        }
        const refined = await window.petApi.asrTranscribe(arrayBufferToBase64(wav))
        if (refined.ok && refined.text) {
          voiceRoundRef.current = true
          setInput(refined.text)
        } else if (!partial.text) {
          showToast(refined.error || '未识别到语音内容')
        }
        return
      }
      if (wav !== null) {
        // 整句回退路径（流式模型没装）：wav 在渲染层转 base64 后交给主进程识别。
        const result = await window.petApi.asrTranscribe(arrayBufferToBase64(wav))
        if (result.ok && result.text) {
          // 这一轮是用户开口问的，回答该念出来。识别失败不置 —— 那之后他是打字。
          voiceRoundRef.current = true
          setInput((prev) => (prev + result.text).trim())
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
          voiceRoundRef.current = true
          setInput((prev) => (prev + result.text).trim())
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
      setListening(false)
    }
  }, [listening, busy, showToast])

  const onDragStart = useCallback((event: React.MouseEvent, behavior: PetBehavior) => {
    if (event.button !== 0 || exitingRef.current) return
    event.preventDefault()
    const { startDrag, dragMove, endDrag, poke } = behavior
    window.petApi.mouseState(true) // 拖拽期间保持接收鼠标事件
    startDrag()
    const onMove = (ev: MouseEvent) => dragMove(ev.clientX, ev.clientY)
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const moved = endDrag()
      window.petApi.mouseState(false)
      if (!moved) {
        poke()
        setPanelOpen((v) => !v)
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const anchor = panelPos ?? {
    x: Math.round(window.innerWidth * 0.7),
    y: window.innerHeight - PET_WIDTH - STAGE_MARGIN,
  }
  const panelLeft = Math.min(Math.max(anchor.x - 120, 8), window.innerWidth - PANEL_WIDTH - 8)

  /**
   * 面板命中盒：实测，不按常量算。
   *
   * 面板 CSS 是 `max-height` + `overflow: hidden`，真实高度随内容变化。按固定 500px 登记的话，
   * 面板上方那片空白也会被判成"可交互"，鼠标在那儿点击就被窗口吃掉、穿不到桌面 —— 用户看到的
   * 是桌面点不动了。ResizeObserver 让审批区出现/消失、消息增减时都重新量一次。
   */
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!panelOpen) {
      registerPanelHitbox(null)
      return
    }
    const element = panelRef.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      registerPanelHitbox({ x1: rect.left, y1: rect.top, x2: rect.right, y2: rect.bottom })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
      // 面板收起后必须摘掉盒子，否则留一个永远点不到的区域挡着穿透。
      registerPanelHitbox(null)
    }
  }, [panelOpen, panelLeft])

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
      if (exitingRef.current) return
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
    const ticker = window.setInterval(update, 100)
    update()
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.clearInterval(ticker)
    }
  }, [stageVisible])

  // 快捷键 / 语音唤醒唤起：打开面板并聚焦输入框
  useEffect(() => {
    /**
     * 唤起一律切回对话页。
     *
     * 团队页上没有输入框，停在那一页时 `inputRef.current` 是 null，聚焦会静默失败 ——
     * 用户按了 Ctrl+Alt+P 或者喊了一声"小潘"，看到的是一个能看不能打字的面板。
     * 而这个快捷键存在的唯一理由就是唤起输入框。
     */
    const summon = () => {
      if (exitingRef.current) return
      const position = stageRef.current?.anchorPosition()
      if (position) setPanelPos(position)
      setPanelTab('chat')
      setPanelOpen(true)
      window.setTimeout(() => inputRef.current?.focus(), 60)
    }

    window.petApi.onSummon(summon)
    window.petApi.onWake(() => {
      if (exitingRef.current) return
      const now = Date.now()
      if (now - wakeLockRef.current < 2600) return
      wakeLockRef.current = now
      const who = selectedId ?? cast[0]?.assistantId
      const stage = stageRef.current
      if (who && stage) {
        stage.sayTo(who, WAKE_GREETING, 3000)
        stage.pokeOf(who)
      } else if (who) {
        // 角色刚被隐藏：主进程先发"显示"再发唤醒事件，这一刻舞台还没挂回来，应答留给下面的 effect。
        pendingGreetingRef.current = true
      }
      summon()
    })
  }, [selectedId, cast])

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
    })
  }, [])

  /**
   * 角色在不在念，以及念不念得出来。
   *
   * 后半句更要紧：合成失败是个听不见的故障，界面上不说一句，用户只会觉得"它没反应"。
   */
  useEffect(() => {
    window.petApi.onSpeechState((status) => {
      setSpeech(status)
      if (status.error) showToast(speechErrorText(status.error))
    })
  }, [showToast])

  /**
   * 文档讲解的三条推送各归各处。
   *
   * 逐段正文和一句话提示都铺进对话页，不在文档页再开一个滚动区：同一段话有两个家的话，
   * 两边会各自滚到不同位置，用户不知道该看哪个。文档页只留状态 —— 提纲、进度、授权范围。
   */
  useEffect(() => {
    window.petApi.onDocState(setDocState)
    window.petApi.onDocReply((reply) => {
      setMessages((prev) => [...prev, { role: 'assistant', text: reply.text }])
    })
    window.petApi.onDocNotice((message) => {
      if (message !== '') setMessages((prev) => [...prev, { role: 'assistant', text: message }])
    })
    void window.petApi.docRoots().then(setDocRoots)
  }, [])

  /**
   * 文档操作的统一收口。
   *
   * 按住按钮是因为连点会排出两条讲解链；回执铺到对话页是因为文档页上没有消息区，而失败
   * 只弹一个 toast 的话三秒就没了 —— "这份文档读不出结构"是用户要照着做决定的信息。
   * 措辞全在主进程，界面不重写一遍：两处各写一份，早晚会一边说"已打开"一边说"打不开"。
   */
  const runDoc = useCallback(
    async (action: () => Promise<{ ok: boolean; reply?: string; error?: string }>) => {
      setDocBusy(true)
      try {
        const result = await action()
        const said = result.reply ?? (result.ok ? null : (result.error ?? '这件事没做成'))
        if (said !== null) {
          setMessages((prev) => [...prev, { role: 'assistant', text: said, error: !result.ok }])
        }
        if (!result.ok) showToast(result.error ?? '这件事没做成')
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error))
      } finally {
        setDocBusy(false)
      }
    },
    [showToast],
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
   * 不补的话用户对着桌面喊一声"小潘"，角色出现了却没人应，看起来像唤醒坏了。
   * 子组件的 ref 在父组件的 effect 之前就赋好了，所以这里能直接拿到舞台句柄。
   */
  useEffect(() => {
    if (!stageVisible || !pendingGreetingRef.current) return
    pendingGreetingRef.current = false
    const who = selectedId ?? cast[0]?.assistantId
    if (who) stageRef.current?.sayTo(who, WAKE_GREETING, 3000)
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
  if (!stageVisible) return null

  /** 状态行要显示的内容一次算好：语气、文字、要不要摊开主进程那句话、给哪些按钮。 */
  const runtime = companion && {
    tone: runtimeTone(companion),
    label: runtimeLabel(companion),
    detail: runtimeDetail(companion),
    canStart: runtimeCanStart(companion),
    ownPid: companion.ownPid,
  }

  return (
    <div className="stage">
      {toast && <div className="toast">{toast}</div>}

      {panelOpen && (
        <div ref={panelRef} className="panel" data-interactive style={{ left: panelLeft }}>
          <div className="panel-header">
            <span className="panel-title">
              {selectedManifest && (
                <span
                  className="character-dot"
                  style={{ ['--mark' as string]: selectedManifest.markColor }}
                  aria-hidden
                />
              )}
              {selectedManifest?.displayName ?? '桌面宠物'}
              {assistantActive && <span className="mode-badge">助理中</span>}
            </span>
            <div className="panel-actions">
              <button className="icon-btn" title="日报文件夹" onClick={() => void window.petApi.openReportDir()}>
                📁
              </button>
              <button className="icon-btn" title="收起" onClick={() => setPanelOpen(false)}>
                ✕
              </button>
            </div>
          </div>

          <div className="panel-tabs" role="tablist" aria-label="面板分页">
            <button
              type="button"
              role="tab"
              id="panel-tab-chat"
              aria-selected={panelTab === 'chat'}
              className={`panel-tab${panelTab === 'chat' ? ' active' : ''}`}
              onClick={() => setPanelTab('chat')}
            >
              对话
              {/* 切到团队页之后消息区就看不见了，正在回复得留个记号，否则用户以为那句话没人接。 */}
              {busy && <span className="panel-tab-dot" aria-hidden />}
            </button>
            <button
              type="button"
              role="tab"
              id="panel-tab-team"
              aria-selected={panelTab === 'team'}
              className={`panel-tab${panelTab === 'team' ? ' active' : ''}`}
              onClick={() => setPanelTab('team')}
            >
              团队
              {/* 待批数量挂在标签上而不是藏在页里：这是用户切过去的主要理由。
                  已经在团队页时不显示 —— 那一页的「等你点头」标题上就写着数量。 */}
              {banner && panelTab !== 'team' && <span className="panel-tab-badge">{banner.count}</span>}
            </button>
            <button
              type="button"
              role="tab"
              id="panel-tab-doc"
              aria-selected={panelTab === 'doc'}
              className={`panel-tab${panelTab === 'doc' ? ' active' : ''}`}
              onClick={() => setPanelTab('doc')}
            >
              文档
              {/*
                只有"重名待挑"挂角标：那是文档页唯一在等用户动手的状态。提纲和进度不挂 ——
                讲解本来就在自己往前走，一直亮着一个数字只会让人以为出了什么事。
              */}
              {docState.kind === 'choose' && panelTab !== 'doc' && (
                <span className="panel-tab-badge">{docState.hits.length}</span>
              )}
            </button>
          </div>

          {runtime && (
            <div className={`runtime-row tone-${runtime.tone}`} role="status">
              <div className="runtime-line">
                <span className="runtime-dot" aria-hidden />
                <span className="runtime-label">{runtime.label}</span>
                {runtime.canStart && (
                  <button className="runtime-btn" onClick={() => void startRuntime()}>
                    启动团队
                  </button>
                )}
                {runtime.ownPid !== null && (
                  <button className="runtime-btn ghost" onClick={() => void stopRuntime()}>
                    停止
                  </button>
                )}
              </div>
              {/* 出错或等待召唤时摊开说明：那句话里带着下一步该做什么，藏进 title 就等于没说。 */}
              {runtime.detail && <div className="runtime-detail">{runtime.detail}</div>}
            </div>
          )}

          {panelTab === 'chat' ? (
            <>
              <div className="messages" id="panel-page-chat" role="tabpanel" aria-labelledby="panel-tab-chat" ref={listRef}>
                {messages.length === 0 && (
                  <div className="empty-hint">
                    你好！试试对我说：
                    <br />「开启个人助理模式」
                    <br />
                    我会默默记录你今天的工作，随时可以问我「我今天干了啥」，下班时说「总结今日工作内容」就能生成日报啦。
                  </div>
                )}
                {messages.map((message, index) => (
                  <div key={index} className={`bubble ${message.role}${message.error ? ' error' : ''}`}>
                    {message.text}
                  </div>
                ))}
                {busy && (
                  <div className="tool-hint">
                    {targetAssistantId && selectedManifest
                      ? `${selectedManifest.displayName}正在处理，请稍候…`
                      : '助理正在思考，请稍候（可能需要十几秒）…'}
                  </div>
                )}
              </div>

              {banner && (
                <div className="approval-banner" role="status">
                  <span className="approval-banner-dot" aria-hidden />
                  <span className="approval-banner-text">{banner.headline}</span>
                  {/*
                    一条时直接开审批窗口；多条时先去团队页看列表。
                    两种情况下按钮做的都和提示文字说的对得上：提示只点名了一条操作，
                    按钮却把 N 条里的第一条放行的话，用户会以为自己批了全部。
                  */}
                  {banner.count === 1 ? (
                    <button
                      type="button"
                      className="approval-banner-go"
                      onClick={() => void openApproval(banner.proposalId)}
                    >
                      去审批
                    </button>
                  ) : (
                    <button type="button" className="approval-banner-go" onClick={() => setPanelTab('team')}>
                      看 {banner.count} 条
                    </button>
                  )}
                </div>
              )}

              <div className="quick-row">
                {QUICK_COMMANDS.map((command) => (
                  <button key={command} className="chip" disabled={busy} onClick={() => void send(command)}>
                    {command}
                  </button>
                ))}
              </div>
            </>
          ) : panelTab === 'team' ? (
            <TeamPanel snapshot={snapshot} memberNames={memberNames} onOpenApproval={openApproval} />
          ) : (
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
              onRemoveRoot={(dir) => void docRemoveRoot(dir)}
              onForgetDir={(dir) => void docForgetDir(dir)}
            />
          )}

          {/*
            正在念的时候给一条能让它闭嘴的横条。

            放在输入行上方而不是塞进输入行里：横条出现会挤压上面的消息区（那块自己会滚），
            塞进输入行则会把正在打字的输入框顶窄一截。两个标签页共用，切到团队页也能停。
          */}
          {speech.speaking && (
            <div className="speech-bar" role="status">
              <span className="speech-bar-dot" aria-hidden />
              <span className="speech-bar-text">正在朗读</span>
              <button type="button" className="speech-bar-stop" onClick={() => window.petApi.stopSpeech()}>
                停止
              </button>
            </div>
          )}

          <div className="input-row">
            <button
              className={`mic-btn${listening ? ' listening' : ''}`}
              title={listening ? '正在聆听…' : '语音输入'}
              disabled={busy}
              onClick={() => void startListen()}
            >
              {listening ? '🔴' : '🎤'}
            </button>
            <textarea
              ref={inputRef}
              className="input-box"
              rows={2}
              placeholder={listening ? '正在聆听，请说话…' : '输入消息，Enter 发送'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send(input)
                }
              }}
            />
            <button className="send-btn" disabled={busy || !input.trim()} onClick={() => void send(input)}>
              {busy ? '…' : '发送'}
            </button>
          </div>
        </div>
      )}

      <TeamStage
        members={cast}
        assistantActive={assistantActive}
        statusByAssistant={statusByAssistant}
        positions={positions}
        selectedId={selectedId}
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
        proactive={companion?.focusMode === true ? null : proactive}
        onProactiveRespond={handleProactive}
        handleRef={stageRef}
      />
    </div>
  )
}
