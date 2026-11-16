import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import TeamStage, { type TeamStageHandle } from './TeamStage.js'
import TeamPanel from './TeamPanel.js'
import MemberManagement, { useMemberFeed } from './MemberManagement.js'
import DocPanel from './DocPanel.js'
import MeetingPanel from './meeting-panel.js'
import { installMeetingSession } from './meeting-capture-session.ts'
import VoiceApiSettings from './VoiceApiSettings.js'
import AssistantSettings from './AssistantSettings.js'
import MailSettings from './MailSettings.js'
import ChatOverlay from './ChatOverlay.js'
import PetSettingsPanel, { FastReplySettings, PresentationSettings, ResidencySettings, WorkEvidenceSettings } from './PetSettingsPanel.js'
import { EnvironmentCheck } from './FirstRunSettings.js'
import { useSession } from './useSession.js'
import { useChatDelta } from './useChatDelta.js'
import { usePresence } from './usePresence.js'
import { PET_OPACITIES, PET_SCALES, normalizePetOpacity, normalizePetScale, type PetOpacity, type PetScale } from './pet-appearance.js'
import { dockEdge, dockPosition, dockStatusTone, type DockEdge } from './pet-dock.js'
import DockedPet from './DockedPet.js'
import { PET_WIDTH } from './pet-metrics.js'
import { HOVER_CLOSE_MS, HOVER_OPEN_MS, hoverActions, initialHover, reduceHover, type HoverEventKind } from './hover-toolbar.js'
import { CONTINUOUS_IDLE_TIMEOUT_MS, VoiceConversation, isVoiceStop, planInterruptInput, plausibleDirectQuestion } from '../voice-conversation.ts'
import type { VoiceTurn } from '../session-types.js'
import {
  clearStageHitboxes,
  hitTest,
  isWorking,
  projectTaskStatuses,
  stageHitboxes,
  registerCharacterHitbox,
  unregisterCharacterHitbox,
  type ExitStage,
  type StageMember,
  type StageTaskStatus,
} from './stage-layout.js'
import { manifestFor, manifestForLegacySkin, registerCustomSkins } from './character-manifest.js'
import { clearPetAssetCache } from './usePetImage.js'
import { PROACTIVE_ACCEPT_MESSAGE } from './proactive-ui.js'
import { arrayBufferToBase64, pcm16Base64, recordDictation, stopDictation, type DictationHandover } from './dictation.js'
import { agentVoicePatch, preferNonEmpty } from '../shared/agent-voice-rule.ts'
import { installAudioBridge, isWakePhraseOnly } from './barge-in.ts'
import { DEFAULT_QUEUE_LIMITS, drainForStop, enqueue, takeNext, type QueuedInput } from './input-queue.ts'
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
import './tokens.css'
import './pet-anim.css'
import './portal.css'
import './team.css'
import './hud.css'
import './settings-surface.css'

const QUICK_COMMANDS = ['开启个人助理模式', '我今天干了啥？', '总结今日工作内容']

/**
 * 提醒气泡在屏幕上停留的上限，与插件侧 OFFER_TTL_MS（30 分钟）对齐。
 * 插件端的 offer 过期后不会再生成候选，气泡继续挂着只会让用户点了没反应。
 */
const PROACTIVE_BUBBLE_TTL_MS = 30 * 60_000

/**
 * 拖拽 / 退场两个标志的最长存活时间。
 *
 * 正常拖拽不到 15 秒（真实拖拽是 1–3 秒），退场动画 4.3 秒、主进程 7 秒兜底退出。
 * 超过这个时长标志仍为真，就只能是**收尾事件丢了**，不是用户还在操作。
 * 那时强制放行，否则窗口会永久停在"鼠标穿透"——形象还在，但什么都点不动。
 */
const STALL_RELEASE_MS = 15_000

/**
 * 宠物界面的构建标识，显示在通用设置的诊断区。
 *
 * 有个说不清的显示问题时，第一件要排除的事就是「跑的是不是这个构建」——
 * 插件与宠物都是**进程内加载 + 模块缓存**，重建磁盘文件对已运行的进程毫无影响。
 * 看一眼这个标记就知道，不用再靠猜。
 */
const UI_BUILD = '1113-rail-glass.3'

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

/**
 * 「这一页还没建完」的入口卡片（第三块工作台的第一期形态）。
 *
 * 它存在的唯一理由是**不假装已经做完**：标题、这页以后长什么样、以及现在能用的那个入口。
 * 下方一行灰字明说是独立窗口 —— 用户点开一个单独的窗口，不会以为是同一张页面没渲染全。
 */
function SettingsEntryCard({ title, description, action, onAction, secondary, disabled = false, pending }: {
  title: string
  description: string
  action: string
  onAction(): void
  /** 次级入口：不抢主按钮的位置，给"另一个常见去处"。 */
  secondary?: { label: string; onAction(): void }
  disabled?: boolean
  pending?: string
}) {
  /*
   * 一行，不是一张卡。
   *
   * 旧版是「标题 + 说明 + 主按钮 + 次按钮 + 再一句'完整页面正在建设中'」竖着堆在白卡里，
   * 三张卡就是三句一模一样的抱歉；而且用户点了卡片，得到的还是另一个窗口。
   * 现在左边说清是什么、右边一个去处，去向已经写进说明里，那句免责就不必再占一行。
   */
  return <section className="management-entry" aria-label={title}>
    <div className="management-entry-copy">
      <h3>{title}</h3>
      <p className="management-hint">{description}</p>
    </div>
    <div className="management-entry-actions">
      {secondary && <button className="management-button" onClick={secondary.onAction}>{secondary.label}</button>}
      <button className="management-button primary" disabled={disabled} onClick={onAction}>{pending ?? action}</button>
    </div>
  </section>
}

/**
 * 专属词库：行话与它指的是什么。
 *
 * 这一页的存在理由：老板说"去 kms 查一下"，助理得知道 kms 是哪套系统。
 * 与记忆分开是因为它**不是判断而是映射**——查到就替换，不需要模型理解语义。
 *
 * 交互上刻意只有"加一个/删一个"，没有编辑：改一个小词的解释等于换了个词的意思，
 * 删了重加更清楚。
 */
function GlossarySettings({ showToast }: { showToast: (text: string) => void }) {
  const [terms, setTerms] = useState<Array<{ term: string; expansion: string }> | null>(null)
  const [term, setTerm] = useState('')
  const [expansion, setExpansion] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await window.petApi.glossaryState()
      if (result.ok) setTerms(result.terms ?? [])
      else setProblem(result.message ?? '词库暂时读不到')
    } catch { setProblem('词库暂时读不到，请稍后刷新') }
  }, [])
  useEffect(() => { void load() }, [load])

  const apply = async (nextTerm: string, nextExpansion?: string, remove = false): Promise<void> => {
    setBusy(true); setProblem('')
    try {
      const result = await window.petApi.glossaryUpdate(nextTerm, nextExpansion, remove)
      if (!result.ok) { setProblem(result.message ?? '没有保存成功'); return }
      setTerms(result.terms ?? [])
      if (!remove) { setTerm(''); setExpansion('') }
      showToast(remove ? '术语已删除' : '术语已加入词库')
    } catch { setProblem('没有保存成功，请稍后重试') } finally { setBusy(false) }
  }

  return <section className="management-section" aria-label="专属词库">
    <h3>专属词库</h3>
    <p className="management-hint">把公司里的行话记下来。下次你说到这个词，助理就知道它指的是什么；没说到就一个字都不加。</p>
    {problem !== '' && <p className="assistant-settings-error" role="alert">{problem}</p>}
    {terms === null && <p className="management-hint">正在读取词库…</p>}
    {terms !== null && terms.length === 0 && <p className="management-hint">还没有术语。比如：kms → 公司内部知识管理系统。</p>}
    {!!terms?.length && <ul className="management-checklist">{terms.map(item => <li key={item.term}>
      <strong>{item.term}</strong>
      <span>→ {item.expansion}</span>
      <button type="button" className="management-button" disabled={busy}
        onClick={() => void apply(item.term, undefined, true)}>删除</button>
    </li>)}</ul>}
    <div className="management-voice">
      <input aria-label="术语" placeholder="术语，例如 kms" value={term} disabled={busy} maxLength={120}
        onChange={event => setTerm(event.target.value)} />
      <input aria-label="术语的意思" placeholder="它指的是什么" value={expansion} disabled={busy} maxLength={2000}
        onChange={event => setExpansion(event.target.value)} />
      <button type="button" className="management-button primary" disabled={busy || term.trim() === '' || expansion.trim() === ''}
        onClick={() => void apply(term.trim(), expansion.trim())}>加入词库</button>
    </div>
  </section>
}

/**
 * 最近产物：助理给你做出过哪些文件。
 *
 * 这一页回答的是"上次那个文件在哪"。**不显示内容摘要**：它是指针不是记忆，
 * 摘要一放上去，用户就会以为"内容还在这"，而文件可能已经被改过或删了。
 * `state='missing'` 要如实标出来 —— 悄悄从列表消失，用户会以为自己记错了。
 */
function ArtifactsSettings() {
  const [items, setItems] = useState<Array<{ path: string; label: string; state: 'ok' | 'missing'; createdAt: number }> | null>(null)
  const [problem, setProblem] = useState('')
  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await window.petApi.artifactsState()
      if (result.ok) setItems((result.artifacts ?? []).map(item => ({ path: item.path, label: item.label, state: item.state, createdAt: item.createdAt })))
      else setProblem(result.message ?? '产物列表暂时读不到')
    } catch { setProblem('产物列表暂时读不到，请稍后刷新') }
  }, [])
  useEffect(() => { void load() }, [load])
  const stamp = (at: number): string => {
    if (!Number.isFinite(at) || at <= 0) return ''
    const date = new Date(at)
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  return <section className="management-section" aria-label="最近产物">
    <h3>最近产物</h3>
    <p className="management-hint">助理给你做出过的文件。这里只记位置，不存内容；文件被改了或删了，会如实标出来。</p>
    {problem !== '' && <p className="assistant-settings-error" role="alert">{problem}</p>}
    {items === null && problem === '' && <p className="management-hint">正在读取…</p>}
    {items !== null && items.length === 0 && <p className="management-hint">还没有产物记录。日报、纪要这类文件真正写进磁盘之后才会出现在这里。</p>}
    {!!items?.length && <ul className="management-checklist">{items.map(item => <li key={item.path}>
      <strong>{item.label || '产物'}</strong>
      <span className="management-hint">{item.path}</span>
      {item.state === 'missing'
        ? <span className="management-status" data-missing>文件已不在</span>
        : <span className="management-status">{stamp(item.createdAt)}</span>}
    </li>)}</ul>}
    <button type="button" className="management-button" onClick={() => { setItems(null); setProblem(''); void load() }}>刷新</button>
  </section>
}

/**
 * 技能：每个助理自己攒下来的做法。
 *
 * 界面上刻意把**候选**与**生效**分开显示：候选不参与回答，晋升才生效。
 * 回滚只有一个按钮，点它回到上一版 —— 这一版技能是一份文本，
 * 没有可调参数，"回到上一版"就是用户能理解的全部语义。
 */
function SkillsSettings({ showToast }: { showToast: (text: string) => void }) {
  type Row = { id: string; assistantId: string; assistantName: string; name: string; body: string; version: number; status: string; createdAt: number }
  const [rows, setRows] = useState<Row[] | null>(null)
  const [pending, setPending] = useState<Array<{ assistantName: string; shape: string; count: number }>>([])
  const [unverified, setUnverified] = useState<Array<{ assistantId: string; assistantName: string; shape: string; count: number }>>([])
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await window.petApi.skillsState()
      if (result.ok) { setRows(result.skills ?? []); setPending(result.pending ?? []); setUnverified(result.unverified ?? []) }
      else setProblem(result.message ?? '技能库暂时读不到')
    } catch { setProblem('技能库暂时读不到，请稍后刷新') }
  }, [])
  useEffect(() => { void load() }, [load])

  const act = async (action: 'promote' | 'rollback' | 'retire', row: Row, version?: number): Promise<void> => {
    setBusy(`${row.id}:${action}`); setProblem('')
    try {
      const result = await window.petApi.skillsUpdate(action, row.id, version)
      if (!result.ok) { setProblem(result.message ?? '没有保存成功'); return }
      setRows(result.skills ?? [])
      showToast(action === 'promote' ? '技能已生效' : action === 'retire' ? '技能已退役' : '已回到上一版')
    } catch { setProblem('没有保存成功，请稍后重试') } finally { setBusy('') }
  }

  const evidence = async (action: 'verify' | 'retract', assistantId: string, shape: string): Promise<void> => {
    setBusy(`${assistantId}:${shape}:${action}`); setProblem('')
    try {
      const result = await window.petApi.skillsEvidence(action, assistantId, shape)
      if (!result.ok) { setProblem(result.message ?? '没有保存成功'); return }
      setRows(result.skills ?? []); setPending(result.pending ?? []); setUnverified(result.unverified ?? [])
      showToast(action === 'verify' ? '已确认这几次是真的' : '已撤回这类记录')
    } catch { setProblem('没有保存成功，请稍后重试') } finally { setBusy('') }
  }

  const label = (status: string): string => status === 'active' ? '生效中' : status === 'candidate' ? '候选（还没生效）' : '已退役'
  return <section className="management-section" aria-label="技能">
    <h3>技能</h3>
    <p className="management-hint">每个助理在某一类活上攒下来的做法。只在他自己被调用时生效，**不进总助理的提示词**，也不影响别的助理。</p>
    {problem !== '' && <p className="assistant-settings-error" role="alert">{problem}</p>}
    {rows === null && problem === '' && <p className="management-hint">正在读取…</p>}
    {!!unverified.length && <ul className="management-checklist">{unverified.map(item => <li key={`u:${item.assistantId}:${item.shape}`}>
      <strong>{item.assistantName}</strong>
      <span>{item.shape} 有 {item.count} 次「做完了」，但还没核实</span>
      <span className="management-hint">助理自己说做完了不算证据。你确认这几次确实做成了，它才会开始攒成技能。</span>
      <button type="button" className="management-button primary" disabled={busy !== ''}
        onClick={() => void evidence('verify', item.assistantId, item.shape)}>确认这几次是真的</button>
      <button type="button" className="management-button" disabled={busy !== ''}
        onClick={() => void evidence('retract', item.assistantId, item.shape)}>记错了，删掉</button>
    </li>)}</ul>}
    {rows !== null && rows.length === 0 && <p className="management-hint">还没有技能。助理同类活做多了才会攒出候选，届时会出现在这里。</p>}
    {!!pending.length && <ul className="management-checklist">{pending.map(item => <li key={`${item.assistantName}:${item.shape}`}>
      <strong>{item.assistantName}</strong>
      <span>{item.shape} 已经做成功 {item.count} 次</span>
      <span className="management-hint">够格形成技能了。技能正文要由你自己写，代码不替你编经验——告诉总助理"把这个经验总结成技能"即可。</span>
    </li>)}</ul>}
    {!!rows?.length && <ul className="management-checklist">{rows.map(row => <li key={row.id}>
      <strong>{row.assistantName}</strong>
      <span>{row.name}（第 {row.version} 版 · {label(row.status)}）</span>
      <span className="management-hint">{row.body.length > 80 ? `${row.body.slice(0, 80)}…` : row.body}</span>
      {row.status !== 'active' && <button type="button" className="management-button" disabled={busy !== ''}
        onClick={() => void act('promote', row)}>让它生效</button>}
      {row.version > 1 && <button type="button" className="management-button" disabled={busy !== ''}
        onClick={() => void act('rollback', row, row.version - 1)}>回到上一版</button>}
      {row.status === 'active' && <button type="button" className="management-button" disabled={busy !== ''}
        onClick={() => void act('retire', row)}>停用</button>}
    </li>)}</ul>}
    <button type="button" className="management-button" onClick={() => { setRows(null); setProblem(''); void load() }}>刷新</button>
  </section>
}

/**
 * 工作时间线：某段时间里"我干了什么"。
 *
 * 只显示**已经解释过的工作事项**，不显示原始窗口采样。
 * 这条边界很关键：原始片段只说明用过什么应用，没解释过就摆上时间线，
 * 用户会把它当成"我做过的事"，那是把线索当结论。
 */
function TimelineSettings() {
  type Row = { id: string; start: number; end: number; action: string; outcome: string; project: string | null; status: string }
  const [rows, setRows] = useState<Row[] | null>(null)
  const [problem, setProblem] = useState('')
  const [days, setDays] = useState(1)
  const load = useCallback(async (spanDays: number): Promise<void> => {
    setProblem('')
    try {
      const to = Date.now() + 1
      const from = to - spanDays * 24 * 3600_000
      const result = await window.petApi.timelineState(from, to)
      if (result.ok) setRows(result.items ?? [])
      else setProblem(result.message ?? '时间线暂时读不到')
    } catch { setProblem('时间线暂时读不到，请稍后刷新') }
  }, [])
  useEffect(() => { void load(days) }, [days, load])
  const clock = (at: number): string => {
    if (!Number.isFinite(at) || at <= 0) return ''
    const date = new Date(at)
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  const statusLabel = (status: string): string => status === 'user_confirmed' ? '已确认' : status === 'direct' ? '直接证据' : status === 'inferred' ? '推断' : status === 'evidence_removed' ? '证据已删除' : status
  return <section className="management-section" aria-label="工作时间线">
    <h3>工作时间线</h3>
    <p className="management-hint">这里只有「解释过的工作事项」。助理只看到过哪个窗口开着，并不等于你做过什么，所以原始采样不会出现在这里。</p>
    <div className="management-voice" role="radiogroup" aria-label="时间范围">
      <span>范围</span>
      {[1, 7, 30].map(value => <label key={value} style={{ display: 'inline-flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <input type="radio" name="timeline-days" checked={days === value} onChange={() => setDays(value)} />
        <span>{value === 1 ? '今天' : `最近 ${value} 天`}</span>
      </label>)}
    </div>
    {problem !== '' && <p className="assistant-settings-error" role="alert">{problem}</p>}
    {rows === null && problem === '' && <p className="management-hint">正在读取…</p>}
    {rows !== null && rows.length === 0 && <p className="management-hint">这段时间还没有解释过的工作事项。问助理"我今天干了啥"，它会把活动片段解释成事项记下来。</p>}
    {!!rows?.length && <ul className="management-checklist">{rows.map(item => <li key={item.id}>
      <strong>{clock(item.start)}</strong>
      <span>{item.action || '（无动作记录）'}</span>
      <span className="management-hint">{item.project ? `项目：${item.project} · ` : ''}{item.outcome || '（无成果记录）'} · {statusLabel(item.status)}</span>
    </li>)}</ul>}
    <button type="button" className="management-button" onClick={() => void load(days)}>刷新</button>
  </section>
}

/**
 * 总助理的「形象与声音」。
 *
 * 为什么和名字、性格放同一页：这三样回答的是同一个问题 —— **这是谁**。
 * 之前形象只能在工作室里"应用到角色"，音色只能去语音设置里挑全局值，
 * 用户在"总助理设置"里找不到，就等于这两件事没地方配。
 *
 * 形象写进 `characters[总助理id].skin`（与舞台读的是同一份）；
 * 音色写的是全局 TTS 选中项 —— 总助理说话用的就是它。
 */
const CHIEF_ASSISTANT_ID = 'member-tangseng'
const BUILT_IN_SKINS: Array<[string, string]> = [['panda', '熊猫'], ['boy-glasses', '眼镜男生'], ['girl-glasses', '眼镜女生']]

function ChiefLookSettings({ characters, onSkin }: {
  characters: SkinOverrides
  onSkin: (skin: string) => void
}) {
  const [custom, setCustom] = useState<string[]>([])
  /*
   * 这里要拿到**完整**的已选配置：保存音色描述时要把 endpoint/model/provider 一起回传，
   * 只传 id 是不行的（后端 save 是全量字段校验）。
   */
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string; endpoint: string; model: string; voice: string; voiceDesign: string; provider: string }>>([])
  const [selectedVoice, setSelectedVoice] = useState<string | null>(null)
  const [persona, setPersona] = useState('')
  const [agentName, setAgentName] = useState('')
  const [design, setDesign] = useState('')
  /** 克隆音色 ID：从「形象与音色工作室」克隆出来的那个声音。 */
  const [voiceId, setVoiceId] = useState('')
  /** 复刻样本（base64 + mime）；有它就用 voiceclone 模型，优先于描述与克隆 ID。 */
  const [sample, setSample] = useState<{ data: string; mime: string; name: string } | null>(null)
  const [recording, setRecording] = useState(false)
  /** 已保存样本的 base64 长度（0 = 没存过）。 */
  const [savedBytes, setSavedBytes] = useState(0)
  /** 语气/情绪/方言/角色扮演的自然语言指令。 */
  const [voiceStyle, setVoiceStyle] = useState('')
  const [generating, setGenerating] = useState(false)
  const [savingVoice, setSavingVoice] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState('')
  const refreshVoices = useCallback(async (): Promise<void> => {
    /*
      音色三项（描述 / 风格 / 样本）**先从设置读**，而且不论语音配置列表成没成功，
      都要读到 —— 以前它排在语音列表后面，列表一报错就提前 return，
      输入框永远是空的，用户一保存就把空值写回去，等于把自己的配置擦掉。
    */
    try {
      const voice = await window.petApi.agentVoiceState()
      /* 空值不覆盖已输入内容：宁可留旧值，也不能把用户刚写的东西清掉。 */
      setDesign(prev => preferNonEmpty(prev, voice.design))
      setVoiceStyle(prev => preferNonEmpty(prev, voice.style))
      setVoiceId(prev => preferNonEmpty(prev, voice.voiceId))
      setSavedBytes(voice.sampleLength)
      if (voice.sample !== '') setSample({ data: voice.sample, mime: voice.mime || 'audio/wav', name: '已保存的样本' })
    } catch { /* 读不到就保留当前输入框内容，不要清空 */ }
    try {
      const result = await window.petApi.voiceApiState()
      if (!result.ok) { setProblem(result.error); return }
      const tts = result.state.profiles.filter(item => item.kind === 'tts')
      setProfiles(tts.map(item => ({ id: item.id, name: item.name, endpoint: item.endpoint, model: item.model,
        voice: item.voice, voiceDesign: item.voiceDesign, provider: item.provider })))
      setSelectedVoice(result.state.selected.tts)
      /* 音色现在存在总助理自己的设置里，不再属于某条语音配置。 */
    } catch { setProblem('读取语音配置失败，请稍后重试') }
  }, [])
  useEffect(() => {
    void window.petApi.customSkins().then(items => setCustom(Array.isArray(items) ? items.map(item => item.id) : [])).catch(() => undefined)
    void refreshVoices()
    /* 性格和名字从总助理设置里取：音色是**按性格**设计的，不读性格就无从生成。 */
    void window.petApi.assistantSettingsState().then(result => {
      if (!result.ok || !result.state) return
      setPersona(result.state.agent.persona ?? '')
      setAgentName(result.state.agent.name ?? '')
    }).catch(() => undefined)
  }, [refreshVoices])
  const skin = characters[CHIEF_ASSISTANT_ID]?.skin ?? 'panda'
  const current = profiles.find(item => item.id === selectedVoice) ?? null
  const pickVoice = async (id: string): Promise<void> => {
    try {
      const result = await window.petApi.voiceApiSelect('tts', id === '' ? null : id)
      if (!result.ok) { setProblem(result.error); return }
      setSelectedVoice(result.state.selected.tts)
      setProblem(''); setNotice('')
    } catch { setProblem('切换音色失败，请稍后重试') }
  }
  /** 按性格生成一段音色描述。产出是**起点**：生成完还能手改，再试听。 */
  const generate = async (): Promise<void> => {
    if (generating) return
    setGenerating(true); setProblem(''); setNotice('')
    try {
      const result = await window.petApi.voiceDesignAssist({ name: agentName, personality: persona })
      if (!result.ok) { setProblem(result.error); return }
      setDesign(result.description)
      /* 语气风格也一起自动填：只填音色、风格让人手写，等于把这事做了一半。 */
      /* 总是写回去：空串也写，免得旧风格残留让人以为这次生成了。 */
      setVoiceStyle(result.style ?? '')
      if (!result.style) setNotice('音色描述已生成；这次没拿到语气风格，可以再点一次或手写一句。')
      setNotice('已按性格生成，可以改一改再试听。')
    } catch { setProblem('生成失败，请稍后重试') } finally { setGenerating(false) }
  }
  /** 录一段样本（16k 单声道），直接作为复刻样本。 */
  const recordSample = async (): Promise<void> => {
    if (recording) return
    setRecording(true); setProblem(''); setNotice('')
    try {
      const granted = await window.petApi.asrBegin()
      if (!granted.ok) { setProblem(granted.error ?? '麦克风不可用，请检查系统权限'); return }
      /*
        样本录制**关掉静音收尾**：念一段话中间停顿是正常的，
        按静音判定会把句子截断，克隆出来的音色就不完整。
        这里只按 15 秒上限或用户手动停来收尾。
      */
      const { wav, error } = await recordDictation({ maxDurationMs: 15_000, outputSampleRate: 16000, endOnSilence: false })
      await window.petApi.asrStreamStop().catch(() => undefined)
      if (!wav) { setProblem(error ?? '没有录到声音，请靠近麦克风重试'); return }
      setSample({ data: arrayBufferToBase64(wav), mime: 'audio/wav', name: '刚录的样本' })
      setNotice('录音已就绪：点「保存音色描述」存下，再试听效果。')
    } catch (error) {
      setProblem(`录音失败：${error instanceof Error ? error.message : '请检查麦克风权限'}`)
    } finally { setRecording(false) }
  }
  const saveDesign = async (): Promise<void> => {    if (!current || savingVoice) return
    setSavingVoice(true); setProblem(''); setNotice('')
    try {
      /*
       * apiKey 不传 = 保留原密钥（后端语义如此），否则会把已存的密钥覆盖成空。
       * voice 也原样回传：用预置音色时它仍然有效，用设计模型时后端不强制它非空。
       */
      /*
        音色属于"这个人怎么说"，不属于"接哪家服务"：存到总助理自己的设置里，
        不再写进语音配置 —— 那一页只配模型。
      */
      const result = await window.petApi.saveSettings(agentVoicePatch({
        design, style: voiceStyle, voiceId,
        sampleData: sample?.data ?? '', sampleMime: sample?.mime ?? '',
      }))
      if (!result.ok) { setProblem('保存失败：没能写入总助理设置'); return }
      await refreshVoices()
      setNotice('音色描述已保存。')
    } catch { setProblem('保存失败，请稍后重试') } finally { setSavingVoice(false) }
  }
  const preview = async (): Promise<void> => {
    if (!current || previewing) return
    setPreviewing(true); setProblem(''); setNotice('')
    try {
      const result = await window.petApi.voiceApiPreview(current.id, design.trim(), voiceId.trim(),
        sample ? { data: sample.data, mime: sample.mime } : undefined, voiceStyle.trim())
      if (!result.ok) { setProblem(`试听失败：${result.error}`); return }
      const binary = atob(result.audio)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mime }))
      const audio = new Audio(url)
      audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true })
      await audio.play()
      setNotice('正在试听。觉得对就留着，不对可以改描述再来。')
    } catch (cause) {
      setProblem(`试听失败：${cause instanceof Error ? cause.message : '无法播放音频'}`)
    } finally { setPreviewing(false) }
  }
  return <section className="management-section" aria-label="总助理的形象与声音">
    <h3>形象与声音</h3>
    <p className="management-hint">这决定「你自己」长什么样、用什么声音说话。子助理各有一套，在成员编辑窗口里改。</p>
    {problem !== '' && <p className="assistant-settings-error" role="alert">{problem}</p>}
    {notice !== '' && <p className="management-hint" role="status">{notice}</p>}
    <label className="assistant-settings-field">形象
      <select value={skin} onChange={event => onSkin(event.target.value)}>
        {BUILT_IN_SKINS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        {custom.map(id => <option key={id} value={id}>{id}（自定义）</option>)}
        {!BUILT_IN_SKINS.some(([id]) => id === skin) && !custom.includes(skin) && <option value={skin}>{skin}</option>}
      </select>
    </label>
    <label className="assistant-settings-field">用哪套语音服务
      <select value={selectedVoice ?? ''} onChange={event => void pickVoice(event.target.value)}>
        <option value="">默认（内置离线音色）</option>
        {profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    {profiles.length === 0 && <p className="management-hint">还没接入语音服务：先用内置离线音色。接入后这里会列出可用配置（在语音设置里接）。</p>}
    {current !== null && <>
      <div className="management-voice" role="group" aria-label="音色设计">
        <button type="button" className="management-button primary" disabled={generating || persona.trim() === ''}
          onClick={() => void generate()}>{generating ? '正在按性格生成…' : '按性格生成音色'}</button>
        {persona.trim() === '' && <p className="management-hint">先在上面写一点「性格与说话风格」，我才能按它配色。</p>}
      </div>
      <label className="assistant-settings-field">音色描述（生成后可改；用它合成时就按这段演）
        <textarea rows={5} maxLength={2000} value={design} onChange={event => setDesign(event.target.value)}
          placeholder="例如：中低音，语速偏慢，句间留白明显，尾音收得干净。" />
      </label>
      {/*
        克隆音色：从「形象与音色工作室 → 自定义音色」克隆出来的那个声音。
        填了就**优先于**上面的描述 —— 描述是"照我说的演"，克隆是"就是那个声音"。
        想复刻影视/动画角色的嗓音，只有这条路，设计描述做不到。
      */}
      {/*
        MiMo 的预置音色：填这里就**不再需要样本**，稳妥、不会因为样本不合格而报错。
        复刻失败时也会自动回落到这里选的那个。
      */}
      <label className="assistant-settings-field">预置音色（填了它就不必用样本；复刻失败会自动回落到这里）
        <select value={voiceId} onChange={event => setVoiceId(event.target.value)}>
          <option value="">不用（跟随语音配置里的音色）</option>
          {['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'].map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </label>
      <label className="assistant-settings-field">声音样本（复刻用；选文件或直接录一段，优先于上面两项）
        <input type="file" accept="audio/*" onChange={event => {
          const file = event.target.files?.[0]
          if (!file) return
          if (file.size > 3 * 1024 * 1024) { setProblem('音频太大：请控制在 3MB 以内（十几秒的片段就够）'); return }
          const reader = new FileReader()
          reader.onload = () => {
            const raw = String(reader.result ?? '')
            const comma = raw.indexOf(',')
            setSample(comma < 0 ? null : { data: raw.slice(comma + 1), mime: file.type || 'audio/wav', name: file.name })
            setProblem('')
            setNotice('样本已就绪：点「保存音色描述」存下来，再试听。')
          }
          reader.readAsDataURL(file)
        }} />
      </label>
      {/* 语气风格：MiMo 认自然语言指令（走 user 消息），标签会自动拼进正文开头。 */}
      <label className="assistant-settings-field">语气风格（可选：情绪、语速、方言、角色扮演都写这里）
        <textarea rows={3} maxLength={500} value={voiceStyle} onChange={event => setVoiceStyle(event.target.value)}
          placeholder="例如：慵懒、低沉，语速偏慢，句间留白明显，尾音带一点不屑；或「东北话」「御姐音」「孙悟空」。" />
      </label>
      <div className="management-voice" role="group" aria-label="常用风格">
        {['开心', '慵懒', '温柔', '凌厉', '磁性', '沙哑', '御姐音', '正太音', '东北话', '粤语', '四川话', '孙悟空'].map(tag => (
          <button key={tag} type="button" className="management-button" disabled={savingVoice}
            onClick={() => setVoiceStyle(voiceStyle.trim() === '' ? tag : `${voiceStyle.trim()}、${tag}`)}>{tag}</button>
        ))}
      </div>
      <p className="management-hint" role="status">
        {sample !== null
          ? `当前样本：${sample.name}（${sample.mime}，约 ${Math.round(sample.data.length * 0.75 / 1024)} KB）${savedBytes > 0 ? '，已保存' : '，尚未保存'}。复刻会用它，优先于描述与克隆 ID。`
          : `当前没有样本${savedBytes > 0 ? `（配置里存着约 ${Math.round(savedBytes * 0.75 / 1024)} KB，但没读出来）` : '。录一段或选个文件，复刻才有效果。'}`}
      </p>
      {/* 诊断行：把"读到了什么"摆出来，免得再靠猜是没配还是没读到。 */}
      <p className="management-hint">诊断：语音配置 {profiles.length} 条；当前选中 {selectedVoice === null ? '无' : profiles.find(p => p.id === selectedVoice)?.name ?? '未知'}；已保存样本 {savedBytes === 0 ? '无' : `${Math.round(savedBytes * 0.75 / 1024)} KB`}；描述 {design.trim() === '' ? '无' : `${design.trim().length} 字`}。</p>
      {/*
        录音复刻：走的是语音听写那套录音链路（16k 单声道），所以麦克风权限、
        静音检测、时长上限都是现成的。
        想复刻手机里放出来的声音也行 —— 把手机贴着麦克风外放，一边放一边录。
      */}
      <div className="management-voice">
        <button type="button" className="management-button" disabled={recording} onClick={() => void recordSample()}>
          {recording ? '正在录音…（最多 15 秒）' : '打开麦克风录一段'}</button>
        {sample !== null && <button type="button" className="management-button" disabled={recording}
          onClick={() => { setSample(null); setNotice('样本已清除，保存后生效。') }}>清除样本</button>}
      </div>
      <div className="management-voice">
        <button type="button" className="management-button" disabled={previewing} onClick={() => void preview()}>
          {previewing ? '正在合成…' : '试听'}</button>
        <button type="button" className="management-button" disabled={savingVoice} onClick={() => void saveDesign()}>
          {savingVoice ? '保存中…' : '保存音色描述'}</button>
      </div>
      <p className="management-hint">试听会真实调用一次语音服务（消耗额度）。当前模型：{current.model}；用设计描述时模型名要写成 mimo-v2.5-tts-voicedesign。</p>
    </>}
  </section>
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
  /**
   * 逐字呈现（A2）。影子的唯一入口在这里：它只读 `session.entries` 判断"哪些临时尾该让位"，
   * 不往会话里写任何东西 —— 权威条目才是数据。
   */
  const chatDelta = useChatDelta(session?.entries)

  /**
   * 悬停快捷工具栏（3.7.1）。
   *
   * 时序全在 `hover-toolbar.ts` 的纯函数里，这里只负责"把 DOM 事件变成它的输入"和"按时钟
   * 喂 tick"。真源是 ref：鼠标事件比 React 重渲染快得多，走 state 会读到上一次的值。
   */
  const [hoverEnabled, setHoverEnabled] = useState(() => {
    // 主进程的设置表这轮不动，所以这个开关存在渲染层本地；键名带版本，将来搬进 settings 好清理。
    try { return localStorage.getItem('dsh-pet.hoverToolbar') !== '0' } catch { return true }
  })
  const hoverState = useRef(initialHover(hoverEnabled))
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /**
   * 指针当前停在哪个角色上（含它的实际矩形）。
   *
   * 用 `getBoundingClientRect()` 而不是 `positions[id]`：后者是角色**左上角**的坐标，
   * 拿它算头顶中心会整体右偏半个角色宽（真机反馈"工具栏往右偏"就是这个）。
   */
  const hoverPet = useRef<{ id: string; left: number; top: number; bottom: number; width: number } | null>(null)
  /** 工具栏挂在哪个角色上；`open` 期间一直保留，不随指针离开宠物而清空。 */
  const [hoverBar, setHoverBar] = useState<{ id: string; left: number; top: number; bottom: number; width: number } | null>(null)

  /**
   * 喂一个悬停事件，并按"还差多久到下一个判定点"排一个 tick。
   *
   * 只用一个定时器：每次事件都重排，所以反复进出不会堆出两个互相打架的计时器 ——
   * 那正是这类交互最容易出的 bug（展开计时和收起计时同时活着）。
   */
  const feedHover = useCallback((kind: HoverEventKind) => {
    const now = Date.now()
    const previous = hoverState.current
    const next = reduceHover(previous, { kind, at: now })
    hoverState.current = next
    // **不能**用 `hoverPet.current !== null` 判断：指针一离开宠物它就被清空，
    // 那句话会让工具栏在 mouseout 的同一帧消失，600ms 的通行缓冲等于没写（真机反馈"移不过去"）。
    // 展开期间沿用上一份角色信息，只有 `open` 变 false（600ms 到点）才真正清空。
    setHoverBar(prev => (next.open ? (hoverPet.current ?? prev) : null))
    if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current)
    hoverTimer.current = undefined
    const leftAt = next.leftBarAt ?? next.leftPetAt
    const wait = next.open
      ? (leftAt === null ? null : HOVER_CLOSE_MS - (now - leftAt))
      : (next.petSince === null ? null : HOVER_OPEN_MS - (now - next.petSince))
    if (wait === null) return
    hoverTimer.current = setTimeout(() => feedHover('tick'), Math.max(16, wait))
  }, [])

  const [pet, setPet] = useState('panda')
  /**
   * 用户在本机为每个角色挑的形象，键是 assistantId。
   *
   * 真源是 pet-settings.json，写在主进程（原生菜单里点的那一下）。这里只在启动时读一次、
   * 之后听广播 —— 界面不自己推断"他大概想换成熊猫吧"。
   */
  const [characters, setCharacters] = useState<SkinOverrides>({})
  const [assetEpoch, setAssetEpoch] = useState(0)
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
  const [meetingDocumentAutoApprove, setMeetingDocumentAutoApprove] = useState<boolean | null>(null)
  /** 会话框停靠方式与尺寸；默认固定在头顶，尺寸 440×560。 */
  const [chatDock, setChatDock] = useState<'top' | 'auto'>('top')
  const [chatSize, setChatSize] = useState<{ width: number; height: number }>({ width: 440, height: 560 })
  /** 讲解形态：默认照原文念稿（真人会议优先），AI 讲解要用户主动选。 */
  const [docSpeechMode, setDocSpeechMode] = useState<'source' | 'ai'>('source')
  /** 角色大小与透明度：档位制，来源是主进程设置（get-state 回读，不用 localStorage）。 */
  const [petScale, setPetScale] = useState<PetScale>(1)
  const [petOpacity, setPetOpacity] = useState<PetOpacity>(1)
  /** 拖到边缘是否吸附收起，默认开。 */
  const [petDock, setPetDock] = useState(true)
  /** 当前停靠：哪个角色收在哪个边；null = 没有停靠。 */
  const [docked, setDocked] = useState<{ id: string; edge: DockEdge } | null>(null)
  /** 重启后要恢复的停靠边（等角色名单到位再解析成具体角色）。 */
  const pendingDock = useRef<DockEdge | null>(null)
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
  /**
   * 忙时排队的话（A1：把"静默丢弃"改成"诚实入队"）。
   *
   * 真源是 ref 而不是 state：`send` 与出队 effect 都要在**同一个 tick 里**读到最新的队，
   * 走 state 会读到上一次渲染的旧数组，于是刚排上的那条在下一次出队时凭空消失。
   * `queueCount` 只是它的投影，用来触发 effect 重算并让界面上"排了几条"有个可读的值。
   */
  const queueRef = useRef<QueuedInput[]>([])
  const [queueCount, setQueueCount] = useState(0)
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
  /** 拖拽/退场标志从什么时候开始一直为真；0 = 没卡住。见 100ms 轮询里的自愈分支。 */
  const stallSinceRef = useRef(0)
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
  /**
   * 成员上台规则：总助理常驻；其余成员只在有任务/对话活动时出现，
   * 活动结束后再留 10 秒让退场动画走完，然后自动下台。
   */
  const [stageTick, setStageTick] = useState(() => Date.now())
  const lingerUntil = useRef<Record<string, number>>({})
  // 用户手动"让TA退下"的成员：不再自动上台，直到下一次真实任务/讲解活动。
  const hiddenMembers = useRef<Set<string>>(new Set())
  const chiefIdRef = useRef<string | null>(null)
  chiefIdRef.current = members?.find(member => member.roleId === 'tangseng')?.assistantId ?? null
  useEffect(() => {
    const timer = window.setInterval(() => setStageTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    const now = Date.now()
    const presenter = docState.kind === 'outline' && docState.active ? docState.assistantId ?? null : null
    for (const member of members ?? []) {
      if (member.roleId === 'tangseng') continue
      // 手动退下的成员保持隐藏，不因任务/讲解活动自动复活；只有"请TA上台"能解除。
      if (hiddenMembers.current.has(member.assistantId)) {
        lingerUntil.current[member.assistantId] = 0
        continue
      }
      const working = isWorking(statusByAssistant[member.assistantId]) || member.assistantId === presenter
      if (working) lingerUntil.current[member.assistantId] = Number.POSITIVE_INFINITY
      else if (lingerUntil.current[member.assistantId] === Number.POSITIVE_INFINITY) lingerUntil.current[member.assistantId] = now + 10_000
    }
  }, [members, statusByAssistant, docState])

  /**
   * 交接编排：总助 ↔ 成员的讲解者切换瞬间，退场者演 0.9s 退场动画再下台，
   * 登场者播入场动画。没有这一层，换人就是瞬切，成员也没有登场动效。
   */
  const [handover, setHandover] = useState<{ leaving: string | null; entering: string | null }>({ leaving: null, entering: null })
  const handoverTimer = useRef(0)
  const prevPresenterRef = useRef<string | null>(null)
  useEffect(() => {
    const chief = members?.find(member => member.roleId === 'tangseng') ?? members?.[0]
    const chiefId = chief?.assistantId ?? null
    const presenter = docState.kind === 'outline' && docState.active ? docState.assistantId ?? chiefId : null
    const prev = prevPresenterRef.current
    prevPresenterRef.current = presenter
    if (presenter === prev || !members?.length) return
    let leaving: string | null = null
    let entering: string | null = null
    if (prev === null && presenter && presenter !== chiefId) { leaving = chiefId; entering = presenter }
    else if (prev && prev !== chiefId && (presenter === null || presenter === chiefId)) { leaving = prev; entering = chiefId }
    else return
    // 退场成员只留退场动画那么长，不走任务结束后的 10 秒 linger。
    if (leaving && leaving !== chiefId) lingerUntil.current[leaving] = Date.now() + 900
    setHandover({ leaving, entering })
    window.clearTimeout(handoverTimer.current)
    handoverTimer.current = window.setTimeout(() => setHandover({ leaving: null, entering: null }), 900)
  }, [docState, members])
  useEffect(() => () => window.clearTimeout(handoverTimer.current), [])

  const cast = useMemo<StageMember[]>(() => {
    if (members?.length) {
      const chief = members.find(member => member.roleId === 'tangseng') ?? members[0]
      const active = members.filter(member => member !== chief
        && (lingerUntil.current[member.assistantId] ?? 0) > stageTick)
      // 成员在台上讲解时总助退场；讲完/暂停（active 落下）总助再登场。
      // 交接过渡期（handover.leaving）总助多留 0.9s 把退场动画演完。
      const presenter = docState.kind === 'outline' && docState.active ? docState.assistantId ?? null : null
      const chiefOnStage = presenter === null || presenter === chief.assistantId || handover.leaving === chief.assistantId
      return [...(chiefOnStage ? [chief] : []), ...active]
    }
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
  }, [members, pet, stageTick, docState, handover])

  const selectedMember = useMemo(() => {
    const found = cast.find((item) => item.assistantId === selectedId)
    return found ?? cast[0] ?? null
  }, [cast, selectedId])

  const wakeConversation = useCallback((event: React.SyntheticEvent) => {
    if (selectedMember && event.target instanceof Element && event.target.closest('.chat-hud')) {
      stageRef.current?.wakeOf(selectedMember.assistantId)
    }
  }, [selectedMember])

  /** 会话只临时补充选中角色的工作状态；已有团队任务优先，结束后恢复原投影。讲解中的委派成员同样投影为工作中。 */
  const stageStatuses = useMemo(() => {
    // 总助自己讲解时 assistantId 为空：落到总助头上，否则讲解期间宠物还在走来走去。
    const presenter = docState.kind === 'outline' && docState.active
      ? docState.assistantId ?? chiefIdRef.current
      : null
    let projected = statusByAssistant
    if (presenter && !isWorking(projected[presenter])) projected = { ...projected, [presenter]: 'running' as const }
    if (!selectedMember || (session?.status !== 'running' && session?.status !== 'waiting')) return projected
    const who = selectedMember.assistantId
    if (isWorking(projected[who])) return projected
    return { ...projected, [who]: session.status === 'waiting' ? 'awaiting-user' as const : 'running' as const }
  }, [selectedMember, session?.status, statusByAssistant, docState])

  /**
   * 九态聚合（A3）：把渲染层**现在就有**的事实翻成事件，喂给纯函数状态机。
   *
   * 这里只做"取事实"这一件事，判据全在 `presence-facts.ts`（哪些变化该说话、哪些不该）与
   * `presence-view.ts`（优先级与驻留）。`assistantActive` 用它的会话级闩锁，不再另算一份。
   *
   * `muted` 传 false：设置里没有"静音"这个字段（只有 opt-in 的"朗读回复" `readReplies`，
   * 默认关）。把 `!readReplies` 当静音会让宠物在默认配置下永久显示"静音"，那是在撒谎 ——
   * 真静音要先在设置里加一个字段（主进程改动），不在本轮范围。
   */
  const presence = usePresence({
    busy,
    sessionStatus: session?.status ?? '',
    speaking: speech.speaking,
    listening,
    hasStreamingText: (session?.entries ?? []).some(entry => entry.streaming === true && entry.kind === 'text' && entry.text.length > 0),
    hasStreamingThink: (session?.entries ?? []).some(entry => entry.streaming === true && entry.kind === 'think' && entry.text.length > 0),
    hasStreamingTool: (session?.entries ?? []).some(entry => entry.streaming === true && entry.kind === 'tool'),
    taskRunning: Object.values(stageStatuses).some(status => status === 'running'),
    continuous: conversation.active,
    muted: false,
    errorText: mirror.error || speech.error || '',
  })

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
      setMeetingDocumentAutoApprove(state.meetingDocumentAutoApprove === true)
      setChatDock(state.chatDock === 'auto' ? 'auto' : 'top')
      setDocSpeechMode(state.docSpeechMode === 'ai' ? 'ai' : 'source')
      setPetScale(normalizePetScale(state.petScale))
      setPetOpacity(normalizePetOpacity(state.petOpacity))
      setPetDock(state.petDock !== false)
      // 停靠边先记下来：此刻还不知道该由哪个角色代表，等名单到位再解析。
      pendingDock.current = state.dockedAt ?? null
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

  // 自定义皮肤登记变化：注册 id、清素材缓存并重挂舞台，否则 hook 依赖的 skin 字符串不变不会重新探测。
  useEffect(() => {
    const apply = (skins: { id: string; actions?: string[] }[]) => {
      registerCustomSkins(skins)
      clearPetAssetCache()
      setAssetEpoch(epoch => epoch + 1)
    }
    void window.petApi.customSkins().then(apply)
    window.petApi.onCustomSkins(apply)
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
  useEffect(() => window.petApi.onMemberNotice(notice => {
    showToast(`${notice.kind === 'mail' ? '邮件值守' : '成员通知'}：${notice.text.slice(0, 300)}`)
  }), [showToast])
  /**
   * 子助理自行汇报（self 模式，§4.6 ★②）：主进程已按成员音色播报，
   * 这里让该成员的角色上台出气泡——语音说 A、气泡显示 A。
   * 角色不在 cast（未启用/旧宿主）时只播语音不出气泡；气泡文本截到 300 字，与通知一致。
   */
  useEffect(() => window.petApi.onSubassistantReport(report => {
    const text = report.text.slice(0, 300)
    if (!text) return
    // 先把角色留在台上（上台的成员才会在 cast 里），再出气泡。
    lingerUntil.current[report.assistantId] = Date.now() + 15_000
    setStageTick(Date.now())
    stageRef.current?.sayTo(report.assistantId, text, Math.min(4000 + text.length * 60, 12_000))
    showToast(`子助理汇报（${report.displayName || report.assistantId}）：${text}`)
  }), [])
  const memberFeed = useMemberFeed(showToast)
  const quotaPending = memberFeed.state?.requests.filter(item => item.state === 'pending').length ?? 0
  useLayoutEffect(() => {
    const element = document.querySelector('.member-quota-banner')
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      registerCharacterHitbox('__member_quota__', { x1: rect.left, y1: rect.top, x2: rect.right, y2: rect.bottom })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); unregisterCharacterHitbox('__member_quota__') }
  }, [stageVisible, settingsPage, quotaPending])

  /**
   * 停靠时：悬停工具栏一律不弹。
   *
   * 48px 的圆旁边弹一排按钮会直接盖住它和状态点，而状态点正是"出事了要看得见"的那部分。
   * 收起态要操作就用右键菜单 —— 那条路径一直在。
   */
  useEffect(() => {
    if (docked === null) return
    hoverPet.current = null
    setHoverBar(null)
    hoverState.current = initialHover(hoverEnabled)
  }, [docked, hoverEnabled])

  /**
   * 收起时给一句话。
   *
   * 用户报障的原话是"我的宠物形象去哪了"——他不知道自己刚刚把它收起来了。这句话的作用
   * 就是告诉他"东西还在、单击能展开"。
   *
   * **只在第一次弹**：每次收起都弹就成了骚扰。两层去重：
   * - `dockHintShown.current`：本次运行只弹一次（localStorage 读写失败时的兜底）；
   * - `localStorage['dsh-pet.dockHintShown']`：跨重启只弹一次。
   * 用 try/catch 包住读写：隐私模式或存储被禁用时不能让提示逻辑抛错，那会连带停靠功能一起坏。
   */
  const dockHintShown = useRef(false)
  useEffect(() => {
    if (docked === null || dockHintShown.current) return
    dockHintShown.current = true
    let seen = false
    try { seen = localStorage.getItem('dsh-pet.dockHintShown') === '1' } catch { seen = false }
    if (seen) return
    try { localStorage.setItem('dsh-pet.dockHintShown', '1') } catch { /* 存不下就只在本次运行提示一次 */ }
    showToast('已收起到屏幕边缘，单击展开')
  }, [docked, showToast])

  /**
   * 缩放变了：把悬停矩形作废。
   *
   * 工具栏位置来自 `getBoundingClientRect()`（含 transform），所以**重新量一次**就对了；
   * 但"正在悬停时改大小"这一帧用的还是旧矩形，会让工具栏偏出一个角色的高度。
   * 改完立刻清空，下次悬停按新尺寸重测 —— 比在渲染里猜偏移量可靠。
   */
  useEffect(() => {
    hoverPet.current = null
    setHoverBar(null)
    hoverState.current = initialHover(hoverEnabled)
  }, [hoverEnabled, petScale])

  /**
   * 悬停栏的五个动作，全部走**已有能力**：不新增 IPC，也不在这里造第二条业务路径。
   * 会议按钮只把人带到会议页 —— 开始录音需要本人同意，不能让一个悬停按钮替他点掉。
   */
  const runHoverAction = useCallback((id: 'chat' | 'meeting' | 'todo' | 'report' | 'settings') => {
    hoverState.current = initialHover(hoverEnabled)
    setHoverBar(null)
    if (id === 'chat') { setSettingsPage(null); setPanelOpen(true); return }
    if (id === 'settings') { setSettingsPage('general'); return }
    if (id === 'meeting') { setSettingsPage('meeting'); return }
    if (id === 'todo') {
      void window.petApi.openCompanionTasks().then(result => { if (!result.ok) showToast('待办窗口未能打开') })
        .catch(() => showToast('待办窗口未能打开'))
      return
    }
    void window.petApi.openReportWorkbench().then(result => { if (!result.ok) showToast('日报工作台未能打开') })
      .catch(() => showToast('日报工作台未能打开'))
  }, [hoverEnabled, showToast])

  useEffect(() => {
    const stopSettings = window.petApi.onSettingsOpen(setSettingsPage)
    const stopSettingsClose = window.petApi.onSettingsClose(() => setSettingsPage(null))
    const stopDismiss = window.petApi.onOverlayDismiss(() => setPanelOpen(false))
    const stopError = window.petApi.onOverlayError(showToast)
    const stopStepDown = window.petApi.onMemberStepDown(assistantId => {
      if (assistantId === chiefIdRef.current) return
      hiddenMembers.current.add(assistantId)
      lingerUntil.current[assistantId] = 0
      void window.petApi.saveSettings({ stepDownMembers: [...hiddenMembers.current] })
      setStageTick(Date.now())
    })
    const stopStepUp = window.petApi.onMemberStepUp(assistantId => {
      hiddenMembers.current.delete(assistantId)
      lingerUntil.current[assistantId] = Date.now() + 10_000
      void window.petApi.saveSettings({ stepDownMembers: [...hiddenMembers.current] })
      setStageTick(Date.now())
    })
    return () => { stopSettings(); stopSettingsClose(); stopDismiss(); stopError(); stopStepDown(); stopStepUp(); window.clearTimeout(toastTimer.current) }
  }, [showToast])

  // 退下名单持久化：召唤/重启后读取，手动退下的成员不自动复活。
  useEffect(() => {
    void window.petApi.getState().then(state => {
      hiddenMembers.current = new Set(state.stepDownMembers ?? [])
      setStageTick(Date.now())
    }).catch(() => undefined)
  }, [])

  // 录音命令接收与双轨采集常驻安装：设置页不打开也能开录，异常用 toast 如实报。
  useEffect(() => {
    installMeetingSession(window.petApi, showToast)
  }, [showToast])

  useEffect(() => {
    if (mirror.error) showToast(mirror.error)
  }, [mirror.error, showToast])

  // 选宠物只切换舞台锚点，不改变原生会话绑定或发送对象。
  const handleSelect = useCallback((assistantId: string) => {
    setSelectedId(assistantId)
  }, [])

  /**
   * 拖拽结束落位置。**这里是"是否吸附"的唯一判定点** —— 不改拖拽逻辑本身，只在收尾时看一眼。
   *
   * 命中边缘时**不写 positions**：那一格要保住"用户拖出来之前的位置"，取消停靠据此回到原处。
   * 停靠本身只记一条边（`dockedAt`），坐标由边 + 原位算出来，两处不各记一份。
   */
  /**
   * 重启恢复停靠：`dockedAt` 只记了边，具体由谁代表等名单到位再定。
   *
   * 选 `selectedId`（用户最后点的那个）优先，否则第一个成员 —— 与用户心里"我上次在跟谁说话"
   * 一致；都没有（团队还没拉起）就保持不渲染小圆，等名单到了再说。
   */
  useEffect(() => {
    const edge = pendingDock.current
    if (edge === null || docked !== null || cast.length === 0) return
    pendingDock.current = null
    const id = selectedId && cast.some(member => member.assistantId === selectedId) ? selectedId : cast[0].assistantId
    setDocked({ id, edge })
  }, [cast, docked, selectedId])

  const handlePersist = useCallback((assistantId: string, x: number, y: number) => {
    const workArea = { left: 0, top: 0, width: innerWidth, height: innerHeight }
    const edge = petDock ? dockEdge({ left: x, top: y, width: PET_WIDTH, height: PET_WIDTH }, workArea) : null
    if (edge !== null) {
      setDocked({ id: assistantId, edge })
      void window.petApi.saveSettings({ dockedAt: edge })
      return
    }
    const next = { ...positionsRef.current, [assistantId]: { x, y } }
    positionsRef.current = next
    setPositions(next)
    void window.petApi.saveSettings({ positions: next })
  }, [petDock])

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
      if (!text) {
        if (voiceTurn) stopContinuous(false)
        return
      }
      if (busyRef.current) {
        if (voiceTurn) {
          // 语音轮次不入队：它带 generation/binding 代次，排队到下一轮再发时那两个号早已失效，
          // 发出去只会是一条"迟到的、不确定属不属于当前会话"的话。这条链的兜底是继续对话的状态机。
          stopContinuous(false)
          return
        }
        // 打字轮次入队。这是本轮改动的全部意义：忙不是拒绝的理由，只是延后的理由。
        const outcome = enqueue(queueRef.current, {
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          // 原文进队，trim 由 input-queue 负责（它的契约就是"存 trim 后的正本"），
          // 这里再 trim 一次会让"排版用的换行"在两层之间来回变形。
          text: raw,
          enqueuedAt: Date.now(),
          source: 'typed',
          bindingId: session?.bindingId,
        }, DEFAULT_QUEUE_LIMITS)
        if (!outcome.ok) {
          // 排不上也要诚实：原文回填输入框，并说清为什么没排上。绝不静默丢。
          setInput(draft => (!draft || draft.trim() === text ? raw : `${raw}\n${draft}`))
          showToast(outcome.reason === 'full'
            ? `队列已满（最多 ${DEFAULT_QUEUE_LIMITS.maxItems} 条），这条没有排上`
            : outcome.reason === 'too-long' ? '这条太长了，先精简一下再发' : '这条没有排上')
          return
        }
        queueRef.current = outcome.queue
        setQueueCount(outcome.queue.length)
        showToast(`助理还在处理上一条，这条已排队（第 ${outcome.queue.length} 条）`)
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

  /**
   * 串行出队：一次只放一条出去，放完等它跑完再看下一条。
   *
   * 三条纪律：
   * - **先摘队，再 send**。`send` 会同步把 `busyRef` 置真，但它中间还有一步 `startSession`
   *   的 await；若反过来（先 send 再摘队），effect 在这段窗口里重入就会把同一条再发一遍。
   * - **`busy` 与 `busyRef` 都要看**。前者是渲染值、会晚一拍，后者是即刻值；只看一个都会
   *   在"刚提交完、还没重渲染"的那一拍漏过去。
   * - **绑定失效的条目带进 dropped 并说一句**。会话换了还照着旧 `bindingId` 发，等于把用户
   *   的话发进另一个会话里。失效不等于可以静默丢。
   *
   * `queueCount` 进依赖是有意的：入队发生在 busy 为真时（effect 会早退），只有它的变化能把
   * 这条 effect 在"排上了但还没轮到"的这段时间里重新叫醒一次。
   */
  useEffect(() => {
    if (busy || busyRef.current) return
    if (queueRef.current.length === 0) return
    const { next, queue, dropped } = takeNext(
      queueRef.current,
      Date.now(),
      DEFAULT_QUEUE_LIMITS,
      item => !item.bindingId || item.bindingId === session?.bindingId,
    )
    queueRef.current = queue
    setQueueCount(queue.length)
    if (dropped.length > 0) showToast(`${dropped.length} 条排队消息因会话切换已失效，未自动发送`)
    if (!next) return
    void send(next.text)
  }, [busy, send, session?.bindingId, showToast, queueCount])

  /**
   * 把队列里还没说的话按原顺序拼回输入框。
   *
   * 「停止生成」时用它：那一刻用户要的是"从头来一次"，而不是让几条早已过时的请求在他停手
   * 之后继续发出去。拼回而不是逐条弹确认 —— 停止本来就该是一次动作。
   */
  const drainQueueToInput = useCallback(() => {
    if (queueRef.current.length === 0) return
    const { queue, restoredText } = drainForStop(queueRef.current)
    queueRef.current = queue
    setQueueCount(0)
    if (restoredText) setInput(draft => (!draft ? restoredText : `${restoredText}\n${draft}`))
  }, [])

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
  const startListen = useCallback(async (autoSend = false, continuous = false, takeHandover?: () => DictationHandover | null, gateInterrupt = false, bargeIn = false) => {
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
    // 讲解与会议里直接说话就是提问（主进程返回 direct）；日常外放仍只认明确口令，防自回声。
    let directMode = false
    const accept = async (text: string): Promise<void> => {
      if (cancelled()) return
      if (gateInterrupt) {
        const plan = planInterruptInput(text, directMode)
        if (plan.action === 'ignore') return
        if (plan.action === 'send' || plan.action === 'listen') {
          // 口令后直接带问题时，回答播完仍要自动回到原讲解；只说“停一下”则保持暂停。
          window.petApi.stopSpeech(plan.action === 'send')
          if (conversation.active) {
            stopContinuous(false)
            // 这是主动从连续对话转入插话，不是用户取消下一次听写。
            dictationCancelled.current = false
          }
          if (plan.action === 'send') {
            // 口令后面还带了问题：当场回答，不用再说一遍。
            voiceRoundRef.current = true
            setInput(plan.text)
            if (!busyRef.current) void send(plan.text)
            else showToast('上一条消息尚未提交完成，语音已保留在输入框')
            return
          }
          // 只说了口令：等本次听写释放后再听问题；会议内仍按插话来源申请。
          showToast('已停下，请说你的问题')
          const binding = currentBinding.current
          const resumeGeneration = dictationGeneration.current
          window.setTimeout(() => {
            if (!dictationCancelled.current && dictationGeneration.current === resumeGeneration
              && !exitingRef.current && binding && currentBinding.current === binding) {
              void startListen(true, false, undefined, true, true)
            }
          }, 150)
          return
        }
        if (plan.action === 'direct') {
          // 讲解中直接开口提问：先过滤回声与噪声，再停播并把这句话当问题发出去。
          // 停播带 preserveAutoResume=true —— 回答播完后主进程会把讲解接回原处。
          if (isSelfSpeech(text)) {
            showToast('刚才是我的回声，已忽略；请再说一次')
            return
          }
          if (!plausibleDirectQuestion(text)) return
          window.petApi.stopSpeech(true)
          if (conversation.active) {
            stopContinuous(false)
            // 这是主动从连续对话转入插话，不是用户取消下一次听写。
            dictationCancelled.current = false
          }
          voiceRoundRef.current = true
          setInput(text)
          if (!busyRef.current) void send(text)
          else showToast('上一条消息尚未提交完成，语音已保留在输入框')
          return
        }
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
      const granted = await window.petApi.asrBegin({ bargeIn })
      if (!granted.ok) {
        showToast(granted.error || '麦克风正被占用')
        return
      }
      directMode = granted.direct === true
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
    // 日常外放仍然只认明确口令（防自回声）；会议演讲/讲解时由主进程放开为直接提问。
    void startListen(true, continuous, takeHandover, true, true)
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
      /*
       * 两个"应该很短命"的标志：一次拖拽、一次退场。
       *
       * 它们都靠**收尾事件**清空：拖拽等 `mouseup`/`blur`，退场等主进程真正 quit。
       * 收尾事件一旦丢了（在窗口外松手、退出被 before-quit 挡下后没再放行、渲染层换绑），
       * 标志就永久为真，而这个函数是**唯一定期调用 mouseState 的地方**——
       * 于是窗口永远停在"鼠标穿透"，表现就是：形象还在，但右键、悬停、拖拽、快捷键全部没反应。
       *
       * 真机出现过一次。修法不是猜哪条收尾路径漏了，而是**不让任何标志无限期成立**：
       * 正常拖拽不到 15 秒、正常退场 4.3 秒，超过 15 秒仍是真值就说明收尾丢了，强制放行。
       * 强制放行走正规收尾（`onBlur` 会自己注销监听并清空引用），不绕过任何状态。
       */
      const stalled = exitingRef.current || dragCleanupRef.current !== null
      if (stalled) {
        if (stallSinceRef.current === 0) stallSinceRef.current = Date.now()
        else if (Date.now() - stallSinceRef.current > STALL_RELEASE_MS) {
          // 先留证据再释放：下次再出现"点不动"，日志里能直接看出卡的是哪一个标志。
          console.warn('[dsh-pet] 交互标志长期未释放，已强制放行', {
            exiting: exitingRef.current, dragging: dragCleanupRef.current !== null,
            heldMs: Date.now() - stallSinceRef.current, uiBuild: UI_BUILD,
          })
          stallSinceRef.current = 0
          exitingRef.current = false
          setExitStage('none')
          setPortalPhase('closed')
          dragCleanupRef.current?.()
          interactiveRef.current = false
          window.petApi.mouseState(false)
        }
        return
      }
      stallSinceRef.current = 0
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
   * 快嘴短应答：主进程已用 TTS 念出，这里只显示在角色头顶气泡，并记进自回声过滤表
   * （连续对话开着麦，不记就可能把自己的应答识别成用户输入）。它不进会话流水。
   */
  useEffect(() => window.petApi.onFastAck(({ text }) => {
    if (exitingRef.current || text === '') return
    rememberSelfSpeech(text)
    const who = selectedId ?? cast[0]?.assistantId
    if (who) stageRef.current?.sayTo(who, text, 4000)
  }), [selectedId, cast])

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
  const docRead = useCallback(async (path: string) => {
    showToast('正在准备逐页阅读…')
    try {
      const result = await window.petApi.officeOpen(path)
      if (!result.ok) showToast(result.error ?? '逐页阅读窗口未能打开')
    } catch { showToast('逐页阅读窗口未能打开') }
  }, [showToast])
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
  /** 面板上的恢复入口：与说“继续讲解”走同一条主进程路径。 */
  const docResume = useCallback(
    () => void runDoc(() => window.petApi.chat('继续讲解', undefined, true)),
    [runDoc],
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
    <div className="stage" onMouseDownCapture={wakeConversation} onKeyDownCapture={wakeConversation}
      // 悬停在哪个角色上就用哪个角色：工具栏只跟着指针下那一个，不整个舞台弹。
      onMouseOver={event => {
        const slot = (event.target as Element | null)?.closest?.('.character-slot') ?? null
        const id = slot?.getAttribute('data-assistant-id') ?? null
        if (slot === null || id === null || id === hoverPet.current?.id) return
        const rect = slot.getBoundingClientRect()
        hoverPet.current = { id, left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width }
        feedHover('enter-pet')
      }}
      onMouseOut={event => {
        const from = (event.target as Element | null)?.closest?.('.character-slot') ?? null
        if (from === null) return
        const to = (event.relatedTarget as Element | null)?.closest?.('.character-slot') ?? null
        if (to === from) return
        if (to !== null) return // 直接挪到另一个角色：由 mouseover 接管
        hoverPet.current = null
        feedHover('leave-pet')
      }}>
      {toast && <div className="toast" role="status">{toast}</div>}
      {quotaPending > 0 && settingsPage !== 'team' && <div className="member-quota-banner approval-banner" data-interactive role="status">
        <span className="approval-banner-text">{quotaPending} 条成员额度申请待处理</span>
        <button type="button" className="approval-banner-go" onClick={() => setSettingsPage('team')}>打开团队</button>
      </div>}

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
            if (command.kind === 'cancel') {
              // 「停止生成」（scope 缺省或 run）顺手把排队的话拿回手里。mute/pause/resume 不动队列：
              // 那三个不中止在跑的运行，排队的内容照常该发。
              if (command.scope === undefined || command.scope === 'run') drainQueueToInput()
              stopContinuous(false)
            }
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
          liveTurn={chatDelta.live}
          queuedCount={queueCount}
        />
      )}

      {settingsPage !== null && (
        <PetSettingsPanel
          page={settingsPage}
          onPage={next => {
            // 「对话」不是一个设置页：收起面板、回到聊天框。用户点它是想接着说话。
            if (next === 'chat') { setSettingsPage(null); setPanelOpen(true); return }
            setSettingsPage(next)
          }}
          onClose={() => setSettingsPage(null)}
          quotaPending={quotaPending}
        >
          {settingsPage === 'general' ? (
            <div className="management-general">
              <section className="management-section" aria-label="运行时与诊断">
                <h3>运行状态</h3>
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
                <label className="management-voice">
                  <input type="checkbox" checked={hoverEnabled} onChange={event => {
                    const next = event.target.checked
                    setHoverEnabled(next)
                    hoverState.current = initialHover(next)
                    setHoverBar(null)
                    if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current)
                    hoverTimer.current = undefined
                    try { localStorage.setItem('dsh-pet.hoverToolbar', next ? '1' : '0') } catch { /* 存不了就只在本次会话生效 */ }
                  }} />
                  <span>悬停宠物时显示快捷工具栏</span>
                </label>
                {/* 总助理设置已经挪到「助理团」页（那里才是"管理这支队伍"的地方）。
                    这里保留一行指路，避免用过旧版本的找不到。 */}
                <p className="management-hint">总助理的名字与性格在「助理团」页最上面。</p>
                {/*
                 * 诊断信息收进折叠。
                 *
                 * 八条能力状态 + 构建号 + 运行配置 + 重新同步，原来默认全部铺开，占掉首屏一大半，
                 * 而它们**出问题时才需要看**。默认收起，标题只留"诊断信息"四个字。
                 */}
                <details className="setting-details">
                  <summary>诊断信息</summary>
                  <dl aria-label="助理能力实际状态">
                    {operations ? operationLabels(operations).map(item => (
                      <div className="card-row" key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>
                    )) : <div><dt>能力状态</dt><dd>尚未取得状态，不能据此判断正在记录或已停止。</dd></div>}
                  </dl>
                  <p className="management-diagnostic">界面构建 <code>{UI_BUILD}</code></p>
                  {companion && <p className="management-diagnostic">运行配置 <code>{companion.profile}</code></p>}
                  <button className="management-button" onClick={() => void mirror.refresh().catch(error => showToast(String(error)))}>重新同步会话</button>
                </details>
              </section>
              <section className="management-section" aria-label="外观">
                <h3>外观</h3>
                {/* 两档都是三选一：不做滑杆 —— 连续值会造出"点不中自己"的尺寸和"看不见自己"的透明度。 */}
                {([
                  { key: 'scale' as const, label: '大小', values: PET_SCALES, current: petScale, text: (value: number) => `${Math.round(value * 100)}%` },
                  { key: 'opacity' as const, label: '透明度', values: PET_OPACITIES, current: petOpacity, text: (value: number) => `${Math.round(value * 100)}%` },
                ]).map(group => (
                  <div key={group.key} className="management-voice" role="radiogroup" aria-label={group.label}>
                    <span>{group.label}</span>
                    {group.values.map(value => (
                      <label key={value} style={{ display: 'inline-flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <input
                          type="radio"
                          name={`pet-${group.key}`}
                          checked={group.current === value}
                          onChange={() => {
                            // 先回显再落盘：点一下要立刻看到效果；失败回滚并说明。
                            if (group.key === 'scale') {
                              const previous = petScale
                              const next = normalizePetScale(value)
                              setPetScale(next)
                              void window.petApi.saveSettings({ petScale: next })
                                .then(result => { if (!result.ok) { setPetScale(previous); showToast('大小未保存') } })
                                .catch(() => { setPetScale(previous); showToast('大小未保存') })
                              return
                            }
                            const previous = petOpacity
                            const next = normalizePetOpacity(value)
                            setPetOpacity(next)
                            void window.petApi.saveSettings({ petOpacity: next })
                              .then(result => { if (!result.ok) { setPetOpacity(previous); showToast('透明度未保存') } })
                              .catch(() => { setPetOpacity(previous); showToast('透明度未保存') })
                          }}
                        />
                        <span>{group.key === 'opacity' && value === 1 ? '不透明' : group.text(value)}</span>
                      </label>
                    ))}
                  </div>
                ))}
                <label className="management-voice">
                  <input type="checkbox" checked={petDock} onChange={event => {
                    // 关掉时如果正收在边上，顺手展开 —— 否则"关掉了却还是一个小圆"会让人以为没生效。
                    const next = event.target.checked
                    const previous = petDock
                    setPetDock(next)
                    if (!next && docked !== null) {
                      setDocked(null)
                      void window.petApi.saveSettings({ dockedAt: null })
                    }
                    void window.petApi.saveSettings({ petDock: next })
                      .then(result => { if (!result.ok) { setPetDock(previous); showToast('停靠设置未保存') } })
                      .catch(() => { setPetDock(previous); showToast('停靠设置未保存') })
                  }} />
                  <span>拖到屏幕边缘时收起</span>
                </label>
                <details className="setting-details">
                  <summary>透明度与收起后的行为</summary>
                  <p>透明度只作用于角色本身，气泡与快捷工具栏保持清晰。</p>
                  <p>收起后仍会用一个小圆点显示录音、待处理与出错状态；单击展开。</p>
                </details>
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
                  <span>唤醒后自动听取并发送本次语音</span>
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
                  <span>唤醒后的连续对话</span>
                </label>
                <details className="setting-details">
                  <summary>连续对话的规则</summary>
                  <p>最多 10 轮或 5 分钟；一轮回答播完后会继续听，连续 10 秒没听到你开口才结束。沿用当前识别、朗读服务与数据去向。保存后从下一次唤醒起生效，不会立刻开麦。</p>
                </details>
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
                  <span>朗读回复，打字发出的消息也念出来</span>
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
                  <span>会话框固定在宠物头顶</span>
                </label>
                <details className="setting-details">
                  <summary>关闭固定后会怎样</summary>
                  <p>会话框按屏幕空间自动换到上、下、左、右四侧，避免超出屏幕。</p>
                </details>
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
              <FastReplySettings showToast={showToast} />
              <section className="management-section" aria-label="会议与文档审批">
                <h3>会议与文档审批</h3>
                <label className="management-voice">
                  <input type="checkbox" checked={meetingDocumentAutoApprove === true} disabled={meetingDocumentAutoApprove === null}
                    onChange={async event => {
                      const enabled = event.target.checked
                      try {
                        const result = await window.petApi.saveSettings({ meetingDocumentAutoApprove: enabled })
                        if (result.ok) setMeetingDocumentAutoApprove(enabled)
                        else showToast('会议与文档审批设置未保存')
                      } catch { showToast('会议与文档审批设置未保存') }
                    }} />
                  会议录音与文档讲解自动审批（默认开启）
                </label>
                {/* 同意条款收进折叠：它必须能查到，但不该默认占掉半屏、把相邻的开关挤散。 */}
                <details className="setting-details">
                  <summary>开启后会发生什么</summary>
                  <p>开启后，当前桌面请求可不经逐次弹窗开始或停止会议录音、讲解授权目录内的文档。录音会采集麦克风和所选系统音频，讲解会把文档片段发送给当前模型服务商；请确保参会者知情。关闭后恢复逐次确认。邮件、纪要及其他操作仍按各自规则审批。</p>
                  <p>讲解期间会监听麦克风以支持插话；语音识别使用当前配置的识别服务，可能将插话音频发送给该服务。</p>
                </details>
              </section>
              <EnvironmentCheck showToast={showToast} />
              <ArtifactsSettings />
              <TimelineSettings />
              <SkillsSettings showToast={showToast} />
              <GlossarySettings showToast={showToast} />
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
              {banner && (
                <div className="approval-banner" role="status">
                  <span className="approval-banner-dot" aria-hidden />
                  <span className="approval-banner-text">{banner.headline}</span>
                  {banner.count === 1 && <button type="button" className="approval-banner-go"
                    onClick={() => void openApproval(banner.proposalId)}>去审批</button>}
                </div>
              )}
              {/*
               * 总助理也在这支队伍里，所以它的名字与性格放在这一页最上面。
               *
               * 原来它只挂在「通用」页一个按钮上：用户来"管理我的助理们"时，
               * 看到的是成员列表，却改不了队长的性格 —— 那等于把队伍的头放在别处。
               */}
              <section className="management-section" aria-label="总助理">
                <h3>总助理（你自己）</h3>
                <p className="management-hint">成员干活时听你的，而这里定的是"你自己"叫什么、怎么说话。子助理各有自己的性格，在各自的编辑窗口里改。</p>
                <button className="management-button primary" onClick={() => setSettingsPage('agent')}>总助理设置（名字与性格）</button>
              </section>
              <p className="management-hint">运行时启停与连接诊断请到通用设置。</p>
              <MemberManagement feed={memberFeed} />
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
          ) : settingsPage === 'todo' ? (
            <>
              <SettingsEntryCard
                title="待办提醒"
                description="任务清单、催办间隔和到点提醒都在待办窗口里；这里先放打开它的入口。"
                action="打开待办窗口"
                onAction={() => void window.petApi.openCompanionTasks()
                  .then(result => { if (!result.ok) showToast('待办窗口未能打开') })
                  .catch(() => showToast('待办窗口未能打开'))}
              />
              {/* 催办间隔仍然留在这一页：它是"要看的东西"的一部分，挪走就等于藏起来。 */}
              <AssistantSettings key="reminders" section="reminders" />
            </>
          ) : settingsPage === 'mail' ? (
            <MailSettings />
          ) : settingsPage === 'report' ? (
            <SettingsEntryCard
              title="日报周报"
              description="把今天做过的事整理成日报、导出成文件；工作台在独立窗口里。"
              action="打开日报工作台"
              onAction={() => void window.petApi.openReportWorkbench()
                .then(result => { if (!result.ok) showToast('日报工作台未能打开') })
                .catch(() => showToast('日报工作台未能打开'))}
              secondary={{
                label: '打开日报文件夹',
                // 右键菜单里那项将来要撤掉，这里必须能顶上，否则用户找不到导出的文件。
                onAction: () => void window.petApi.openReportDir()
                  .then(result => { if (!result.ok) showToast('日报文件夹未能打开') })
                  .catch(() => showToast('日报文件夹未能打开')),
              }}
            />
          ) : settingsPage === 'wecom' || settingsPage === 'reminders' || settingsPage === 'agent' ? (
            <>
              <AssistantSettings key={settingsPage} section={settingsPage} />
              {/* 形象与声音只属于"总助理"这一页：企业微信与提醒页不需要。 */}
              {settingsPage === 'agent' && <ChiefLookSettings characters={characters} onSkin={skin => {
                const next: SkinOverrides = { ...characters, [CHIEF_ASSISTANT_ID]: { ...characters[CHIEF_ASSISTANT_ID], skin } }
                setCharacters(next)
                void window.petApi.saveSettings({ characters: next }).catch(() => showToast('形象没保存成功，请重试'))
              }} />}
            </>
          ) : (
            <>
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
                onRead={path => void docRead(path)}
                onExplain={docExplain}
                onAsk={docAsk}
                onStop={() => window.petApi.stopSpeech()}
                onResume={docResume}
                onAddRoot={() => void docAddRoot()}
                onRemoveRoot={dir => void docRemoveRoot(dir)}
                onForgetDir={dir => void docForgetDir(dir)}
                docSpeechMode={docSpeechMode}
                onDocSpeechModeChange={async mode => {
                  // 先回显再落盘：设置页点一下要立刻看到选中，失败再回滚并说明。
                  const previous = docSpeechMode
                  setDocSpeechMode(mode)
                  try {
                    const result = await window.petApi.saveSettings({ docSpeechMode: mode })
                    if (!result.ok) { setDocSpeechMode(previous); showToast('讲解模式未保存') }
                  } catch { setDocSpeechMode(previous); showToast('讲解模式未保存') }
                }}
              />
            </>
          )}
        </PetSettingsPanel>
      )}

      {hoverEnabled && hoverBar !== null && (() => {
        const bar = hoverBar
        // 头顶居中：横向取角色矩形的**中心**（不是左上角），纵向底边贴头顶 8px。
        // 8px 是刻意留的缝：太大鼠标跨不过去，太小会盖住角色。
        const below = bar.top < 64
        const left = Math.max(8, Math.round(bar.left + bar.width / 2))
        const top = below ? Math.round(bar.bottom + 8) : Math.round(bar.top - 8)
        return (
          <div
            className={`hover-bar${below ? ' hover-bar-below' : ''}`}
            role="toolbar"
            aria-label="快捷操作"
            data-interactive
            style={{ left, top }}
            onMouseEnter={() => feedHover('enter-bar')}
            onMouseLeave={() => feedHover('leave-bar')}
            // 工具栏区域不吃拖动：否则点按钮会被判成拖宠物。
            onPointerDown={event => event.stopPropagation()}
          >
            {hoverActions(false).map(action => (
              <button key={action.id} type="button" className="hover-bar-btn" aria-label={action.ariaLabel}
                onClick={() => runHoverAction(action.id)}>{action.label}</button>
            ))}
          </div>
        )
      })()}

      {/* 收起后的替身：屏幕边上一个 48×48 的小圆。位置由"边 + 原位"算出来，不另存坐标。 */}
      {docked !== null && (() => {
        const home = positions[docked.id] ?? { x: 0, y: 0 }
        const at = dockPosition(
          docked.edge,
          { left: home.x, top: home.y, width: PET_WIDTH, height: PET_WIDTH },
          { left: 0, top: 0, width: innerWidth, height: innerHeight },
        )
        const member = cast.find(item => item.assistantId === docked.id)
        const tone = dockStatusTone({
          error: Boolean(mirror.error || speech.error),
          recording: operations?.meeting === 'recording',
          pendingApproval: quotaPending > 0,
        })
        return (
          <DockedPet
            left={at.left}
            top={at.top}
            tone={tone}
            // 与舞台同一个形象来源（characters 里那套皮肤）；成员还没到就按默认形象，
            // 反正停靠态要的是"还是那只宠物"，不是精确到某个自定义皮肤。
            skin={characters[docked.id]?.skin ?? 'panda'}
            onRestore={() => {
              // 恢复：只清停靠标记，位置照旧来自 positions —— 于是回到用户拖出来之前那一格。
              setDocked(null)
              void window.petApi.saveSettings({ dockedAt: null })
            }}
            onContextMenu={event => {
              event.preventDefault()
              if (member !== undefined) {
                // 皮肤用本机挑过的那个；没挑过就按默认形象给菜单（菜单只靠它定选中态）。
                window.petApi.contextMenu({
                  assistantId: member.assistantId,
                  displayName: member.displayName || member.assistantId,
                  skin: characters[member.assistantId]?.skin ?? 'panda',
                })
              }
            }}
          />
        )
      })()}

      <TeamStage
        members={cast}
        idleSleepMinutes={sleepSettings.idleSleepMinutes}
        sleepMinutes={sleepSettings.sleepMinutes}
        petScale={petScale}
        petOpacity={petOpacity}
        dockedId={docked?.id ?? null}
        // 共享协议没有个人助理模式字段，不从回答措辞猜测模式开关；这里的"活跃"只是会话级闩锁。
        assistantActive={presence.active}
        statusByAssistant={stageStatuses}
        enteringIds={handover.entering ? new Set([handover.entering]) : null}
        leavingIds={handover.leaving ? new Set([handover.leaving]) : null}
        positions={positions}
        key={assetEpoch}
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
