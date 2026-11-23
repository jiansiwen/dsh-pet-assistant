import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { arrayBufferToBase64, recordDictation } from './dictation.js'
import type { ResidencyPatch, ResidencyState, SettingsPage } from './types.js'
import type { FastReplyInput, FastReplySnapshot } from '../main/fast-reply.js'
import { registerCharacterHitbox, unregisterCharacterHitbox } from './stage-layout.js'
import { settingsNavGroups, settingsPageMeta } from './settings-nav.js'
import { dragPanelPosition } from './settings-panel-drag.ts'

interface Props {
  page: SettingsPage
  onPage(page: SettingsPage): void
  onClose(): void
  children: React.ReactNode
  quotaPending?: number
}

export default function PetSettingsPanel({ page, onPage, onClose, children, quotaPending = 0 }: Props) {
  const panel = useRef<HTMLDivElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  /** 默认右上角；拖动标题栏时在窗口可见区域内移动浮层。 */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanup.current?.(), [])
  const onHeaderMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return
    const node = panel.current
    if (!node) return
    event.preventDefault()
    dragCleanup.current?.()
    const rect = node.getBoundingClientRect()
    const origin = { x: rect.left, y: rect.top }
    const start = { x: event.clientX, y: event.clientY }
    const move = (ev: MouseEvent) => {
      setPos(dragPanelPosition(origin, { x: ev.clientX - start.x, y: ev.clientY - start.y },
        { width: node.offsetWidth, height: node.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }))
    }
    const stop = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', stop)
      window.removeEventListener('blur', stop)
      dragCleanup.current = null
    }
    dragCleanup.current = stop
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
    window.addEventListener('blur', stop)
  }
  /**
   * 切页时把滚动位置归零。
   *
   * 两处都要归零：`.management-content` 带 `scroll-padding`，在某些窗口尺寸下自身会成为滚动
   * 容器；而更常见的情况是外层 `.pet-management` 在滚。只清前者时，切到内容更短的一页会
   * 出现"停在半空"——用户看到的是空白，以为页面没加载。
   */
  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = 0
    if (panel.current) panel.current.scrollTop = 0
  }, [page])
  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      registerCharacterHitbox('__settings__', { x1: rect.left, y1: rect.top, x2: rect.right, y2: rect.bottom })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); unregisterCharacterHitbox('__settings__') }
  }, [])
  // ResizeObserver 不监听位置变化；拖动后必须同步更新命中盒，否则新位置会点击穿透。
  useLayoutEffect(() => {
    if (!panel.current || pos === null) return
    const rect = panel.current.getBoundingClientRect()
    registerCharacterHitbox('__settings__', { x1: rect.left, y1: rect.top, x2: rect.right, y2: rect.bottom })
  }, [pos])

  const groups = settingsNavGroups()
  const meta = settingsPageMeta(page)

  /*
   * 标题区只留三样：方印、当前页标题、一句话说明。
   *
   * 上一版这里是「小潘 · 桌面伙伴 / 设置与管理 / 一句说明」三行堆叠，正文开头又重复一遍
   * 「第 N 项 / 页名 + 页名」——同一个页名在一屏里出现两次，中间夹着一个 10px 加字距的眉标。
   * 眉标与序号都不编码信息（九项是菜单不是序列），一并删掉；标题层级靠字号差就能立住。
   */
  return <section className="pet-management" ref={panel} data-interactive aria-label="小潘桌面伙伴控制台"
    style={pos ? { left: pos.x, top: pos.y, right: 'auto' } : undefined}>
    <header className="management-header" onMouseDown={onHeaderMouseDown}>
      <div className="management-brand" aria-hidden="true">潘</div>
      <div className="management-brand-copy">
        <h2>{meta.title}</h2>
        <p className="management-header-sub">{meta.summary}</p>
      </div>
      <button type="button" onClick={onClose} aria-label="关闭设置">×</button>
    </header>
    <nav className="management-tabs" aria-label="功能与设置">
      {groups.map(group => (
        <Fragment key={group.id}>
          {/* 组标题只是分组，不可点：它不是页面，点它没有去处。 */}
          <div className="management-nav-group" role="presentation">{group.label}</div>
          {group.items.map(item => (
            <button key={item.id} id={`panel-tab-${item.id}`} type="button"
              aria-current={page === item.id ? 'page' : undefined} onClick={() => onPage(item.id)}>
              <span>{item.title}</span>
              {item.id === 'team' && quotaPending > 0 && <span className="panel-tab-badge" aria-label={`${quotaPending}条额度申请待处理`}>{quotaPending}</span>}
            </button>
          ))}
        </Fragment>
      ))}
    </nav>
    <div className="management-content" ref={content} key={page}>
      {children}
    </div>
  </section>
}

/**
 * 常驻与语音（M1-02 四个独立开关 + M1-05 实验开关）。
 *
 * 每个开关各管一件事、各自授权：
 * - 托盘常驻：隐藏角色后壳与唤醒还留着（壳层 trayResident）。
 * - 唤醒："小潘同学"。Windows 缺省开（System.Speech，自带设备）；macOS 缺省关 —— 开着就是持续采集，
 *   菜单栏会一直亮着麦克风占用标识。引擎与不可用原因如实显示，不循环重试刷错。
 * - 活动记录：只显示状态并跳到会话里由用户自己发起；授权走插件的可信审批，这里不能直接开。
 * - 开机自启：缺省关，关着绝不写系统启动项；打开才写，关掉即移除。
 * - 外放插话（实验）：播报期间监听用户开口并立即停下；打开后朗读改由界面播放。
 */
export interface ResidencySettingsProps {
  readonly activity: { active: boolean; capturing: boolean; titles: boolean } | null
  readonly onOpenActivity: () => void
  readonly showToast: (text: string) => void
}

const ENGINE_LABEL: Record<'system' | 'kws', string> = {
  system: 'Windows 系统语音识别（默认）',
  kws: '本地唤醒模型（sherpa KWS，实验性）',
}

export function ResidencySettings({ activity, onOpenActivity, showToast }: ResidencySettingsProps) {
  const [state, setState] = useState<ResidencyState | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.petApi.residencyState()
        if (!cancelled) setState(next)
      } catch { /* 下一轮再取 */ }
      if (!cancelled) timer = setTimeout(() => void refresh(), 2000)
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [])

  const [wakeNameDraft, setWakeNameDraft] = useState('')
  useEffect(() => {
    if (state !== null) setWakeNameDraft(state.wake.name)
  }, [state?.wake.name])
  const wakeNameProblem = /^[\u4e00-\u9fff]{2,5}$/u.test(wakeNameDraft.trim())
    ? null : '唤醒词只能是 2–5 个汉字'
  const [enrolling, setEnrolling] = useState(false)
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagnosis, setDiagnosis] = useState<Array<{ name: string; ok: boolean; detail: string }>>([])
  const [enrollStep, setEnrollStep] = useState(0)

  /** 录 3 次唤醒词；每次说完停一下自动收尾。录音只在内存里，交给主进程提取后即丢弃。 */
  const enrollVoice = async (wakeName: string): Promise<void> => {
    if (enrolling) return
    setEnrolling(true)
    const wavs: string[] = []
    try {
      for (let i = 0; i < 3; i++) {
        setEnrollStep(i + 1)
        // 留一拍让界面把"第几次"显示出来，用户看到提示再开口。
        await new Promise(resolve => setTimeout(resolve, 900))
        const granted = await window.petApi.asrBegin()
        if (!granted.ok) { showToast(granted.error ?? '麦克风不可用'); return }
        const { wav, error } = await recordDictation({ maxDurationMs: 4000, outputSampleRate: 16000 })
        await window.petApi.asrStreamStop().catch(() => undefined)
        if (!wav) { showToast(error ?? '没有录到声音，请靠近麦克风重试'); return }
        wavs.push(arrayBufferToBase64(wav))
      }
      const result = await window.petApi.voiceprintEnroll(wavs)
      if (!result.ok) { showToast(result.error ?? '声纹注册失败'); return }
      showToast(`声纹已注册（${result.count ?? wavs.length} 段）；现在只认你的声音唤醒`)
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '声纹注册失败')
    } finally {
      setEnrolling(false)
      setEnrollStep(0)
    }
  }

  const apply = async (patch: ResidencyPatch, failure: string): Promise<void> => {
    setSaving(true)
    try {
      const result = await window.petApi.residencySet(patch)
      if (result.state) setState(result.state)
      if (!result.ok) showToast(result.error ?? failure)
    } catch {
      showToast(failure)
    } finally {
      setSaving(false)
    }
  }

  if (state === null) {
    return <section className="management-section" aria-label="常驻与语音"><h3>常驻与语音</h3><p className="management-hint">正在读取开关状态…</p></section>
  }
  const wake = state.wake
  const wakeStatus = !wake.enabled ? '已关闭，不在监听'
    : wake.problem !== null ? `不可用：${wake.problem}`
    : wake.listening ? '正在监听'
    : state.holder === null ? '暂停（专注模式等）' : '麦克风暂时被其他功能占用'
  const activityText = activity === null ? '未取得状态（会话未连接）'
    : activity.capturing ? `采样中${activity.titles ? '（含窗口标题）' : '（不含窗口标题）'}`
    : activity.active ? '模式已开启，但未在采样' : '已关闭'

  return (
    <section className="management-section" aria-label="常驻与语音">
      <h3>常驻与语音</h3>
      <label className="management-voice">
        <input type="checkbox" checked={state.trayResident} disabled={saving}
          onChange={event => void apply({ trayResident: event.target.checked }, '托盘常驻设置未保存')} />
        托盘常驻：隐藏角色后仍保留托盘入口（唤醒是否监听看下一项）
      </label>
      <label className="management-voice">
        <input type="checkbox" checked={wake.enabled} disabled={saving || wake.engines.length === 0}
          onChange={event => void apply({ wakeEnabled: event.target.checked }, '唤醒设置未保存')} />
        语音唤醒“{wake.name}”
        {state.platform === 'darwin' && '（开启后持续采集麦克风，菜单栏会一直显示麦克风占用标识）'}
      </label>
      <label className="management-sleep">
        <span>唤醒词</span>
        <input
          type="text"
          value={wakeNameDraft}
          maxLength={5}
          disabled={saving}
          placeholder="2–5 个汉字"
          onChange={event => setWakeNameDraft(event.target.value)}
        />
        <button
          className="management-button"
          disabled={saving || wakeNameProblem !== null || wakeNameDraft.trim() === wake.name}
          onClick={() => {
            const wasVoiceprint = wake.voiceprint.enabled
            void apply({
              wakeName: wakeNameDraft.trim(),
              wakeEngine: 'kws',
              ...(wasVoiceprint ? { wakeVoiceprint: false } : {}),
            }, '唤醒词未保存').then(() => {
              if (wasVoiceprint) showToast('唤醒词已改：声纹是按旧唤醒词录的，请重新录制后再打开声纹唤醒')
            })
          }}
        >
          保存
        </button>
      </label>
      {wakeNameProblem !== null && <p className="management-hint">{wakeNameProblem}</p>}
      <p className="management-hint">
        改名只对本地唤醒引擎（KWS）生效；System.Speech 仍只认“小潘同学”。保存后会重新加载唤醒模型。
      </p>
      <p className="management-hint" role="status">唤醒状态：{wakeStatus}</p>
      <div className="management-sleep">
        <span>声纹唤醒</span>
        <input
          type="checkbox"
          checked={wake.voiceprint.enabled}
          disabled={saving || !wake.voiceprint.registered || enrolling}
          onChange={event => void apply({ wakeVoiceprint: event.target.checked }, '声纹开关未保存')}
        />
        <select
          value={[0.55, 0.65, 0.75].includes(wake.voiceprint.threshold) ? wake.voiceprint.threshold : 0.65}
          disabled={saving || enrolling}
          onChange={event => void apply({ wakeVoiceprintThreshold: Number(event.target.value) }, '声纹阈值未保存')}
        >
          <option value={0.55}>宽松</option>
          <option value={0.65}>标准</option>
          <option value={0.75}>严格</option>
        </select>
      </div>
      <p className="management-hint">
        {wake.voiceprint.problem ?? (wake.voiceprint.registered
          ? `已注册 ${wake.voiceprint.count} 段声纹；只有你的声音喊「${wake.name}」才会应。`
          : '未注册：先录 3 次唤醒词，才能打开“只认我的声纹”。')}
      </p>
      <div className="management-sleep">
        <span>播报中也响应唤醒</span>
        <input
          type="checkbox"
          checked={wake.wakeDuringSpeech}
          disabled={saving}
          onChange={event => void apply({ wakeDuringSpeech: event.target.checked }, '播报中响应唤醒未保存')}
        />
      </div>
      <p className="management-hint">
        关闭时，正在回答或讲解时喊它不会被响应；讲解文档时始终可以打断提问。
      </p>
      {enrollStep > 0 && (
        <p className="management-hint" role="status">第 {enrollStep}/3 次：请说「{wake.name}」，说完停一下。</p>
      )}
      {/*
        声纹自检：把"注册失败"背后的英文原始报错逐层暴露出来。
        注册可能死在模型文件 / 原生模块 / 系统密钥 / 推理四处，只给一句"注册失败"分不出是哪层。
      */}
      <button className="management-button" disabled={diagnosing} onClick={() => {
        setDiagnosing(true)
        void window.petApi.voiceprintDiagnose().then(result => setDiagnosis(result.steps))
          .catch(() => setDiagnosis([{ name: '自检', ok: false, detail: '无法调用自检' }]))
          .finally(() => setDiagnosing(false))
      }}>{diagnosing ? '正在自检…' : '声纹自检'}</button>
      {diagnosis.length > 0 && (
        <ul className="management-checklist" aria-label="声纹自检结果">
          {diagnosis.map(step => <li key={step.name}>
            <strong>{step.ok ? '✅' : '❌'} {step.name}</strong>
            <span className="management-hint">{step.detail}</span>
          </li>)}
        </ul>
      )}
      <button className="management-button" disabled={saving || enrolling} onClick={() => void enrollVoice(wake.name)}>
        {enrolling ? '正在录制…' : wake.voiceprint.registered ? '重新录制声纹（3 次）' : '录制声纹（3 次）'}
      </button>
      {wake.voiceprint.registered && (
        <button
          className="management-button"
          disabled={saving || enrolling}
          onClick={() => void window.petApi.voiceprintClear().then(result => {
            if (!result.ok) showToast(result.error ?? '声纹删除失败')
            else showToast('声纹已删除')
          }).catch(() => showToast('声纹删除失败'))}
        >
          删除声纹
        </button>
      )}
      <p className="management-hint">
        声纹只保存本地加密的声纹特征，不保存原始录音；它降低别人误唤醒，但不能防录音重放。
      </p>
      {wake.engines.length > 1 && (
        <label className="management-sleep">
          <span>唤醒引擎</span>
          <select value={wake.engine ?? ''} disabled={saving}
            onChange={event => void apply({ wakeEngine: event.target.value as 'system' | 'kws' }, '唤醒引擎未切换')}>
            {wake.engines.map(engine => <option key={engine} value={engine}>{ENGINE_LABEL[engine]}</option>)}
          </select>
        </label>
      )}
      {wake.engine === 'kws' && !wake.kwsVerified && (
        <p className="management-hint">本地唤醒模型只做过合成音频的离线测试，安静 / 办公 / 电视声环境的误唤醒率尚未实测。</p>
      )}
      {wake.enabled && wake.problem !== null && (
        <button className="management-button" disabled={saving} onClick={() => void apply({ retryWake: true }, '重试失败')}>重新监听唤醒词</button>
      )}
      <p className="management-hint" role="status">活动记录：{activityText}</p>
      <button className="management-button" onClick={onOpenActivity}>去会话里开启活动记录（需在审批卡确认）</button>
      <label className="management-voice">
        <input type="checkbox" checked={state.launchAtLogin.enabled} disabled={saving || !state.launchAtLogin.supported}
          onChange={event => void apply({ launchAtLogin: event.target.checked }, '开机自启设置未保存')} />
        开机自启{state.launchAtLogin.supported ? '（关闭时不写系统启动项）' : '（这个系统上不支持）'}
      </label>
      <label className="management-voice">
        <input type="checkbox" checked={state.bargeIn.enabled} disabled={saving}
          onChange={event => void apply({ bargeIn: event.target.checked }, '外放插话设置未保存')} />
        外放插话（实验）：朗读时直接开口即可打断，朗读改由界面播放以便回声消除；音频只在本机处理
      </label>
      {state.bargeIn.enabled && state.bargeIn.problem !== null && <p className="management-hint" role="status">插话监听中断：{state.bargeIn.problem}</p>}
      {state.bargeIn.enabled && state.bargeIn.lastMetrics.length > 0 && (
        <p className="management-diagnostic">最近插话：{state.bargeIn.lastMetrics.slice(-3).map(item =>
          `开口→检出 ${item.onsetToDetectMs}ms / 检出→静音 ${item.detectToSilenceMs ?? '—'}ms`).join('；')}</p>
      )}
    </section>
  )
}

/**
 * 快速应答（快嘴旁路）。
 *
 * 用户说完话，主脑跑长任务时先应一声短应答，避免几分钟静默。接什么模型完全由用户配置
 * （DeepSeek / 豆包 / 千问 / 自建端点），只服务于这一条旁路：短应答用现有音色朗读、
 * 只显示在宠物气泡，不进会话与记忆。开启要过主进程的原生隐私确认，这里不替用户决定。
 */
export function FastReplySettings({ showToast }: { readonly showToast: (text: string) => void }) {
  const [state, setState] = useState<FastReplySnapshot | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [timeoutMs, setTimeoutMs] = useState(2500)
  const [maxChars, setMaxChars] = useState(40)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [sample, setSample] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.petApi.fastReplyState().then(snapshot => {
      if (cancelled || snapshot === null) return
      setState(snapshot)
      setBaseUrl(snapshot.baseUrl)
      setModel(snapshot.model)
      setTimeoutMs(snapshot.timeoutMs)
      setMaxChars(snapshot.maxChars)
    }).catch(() => { /* 主进程未就绪时保持空表单 */ })
    return () => { cancelled = true }
  }, [])

  const save = async (patch: FastReplyInput, failure: string): Promise<void> => {
    setSaving(true)
    try {
      const result = await window.petApi.fastReplySave(patch)
      if (result.state) {
        setState(result.state)
        if (patch.apiKey) setApiKey('')
      }
      if (!result.ok) showToast(result.error ?? failure)
    } catch {
      showToast(failure)
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setSample(null)
    try {
      const result = await window.petApi.fastReplyTest()
      if (result.ok && result.sample) setSample(result.sample)
      else showToast(result.error ?? '测试失败')
    } catch {
      showToast('测试失败')
    } finally {
      setTesting(false)
    }
  }

  if (state === null) {
    return <section className="management-section" aria-label="快速应答"><h3>快速应答（即时回应）</h3><p className="management-hint">正在读取配置…</p></section>
  }

  return (
    <section className="management-section" aria-label="快速应答">
      <h3>快速应答（即时回应）</h3>
      <p className="management-hint">
        你说完话后，主脑思考或执行长任务期间，先用这里配置的模型应一句短话（按总助理性格生成，用当前音色朗读），
        不再干等几分钟。短应答只显示在宠物气泡，不进会话与记忆；主回复一开口就自动接管。仅对语音发起的对话生效。
      </p>
      <label className="management-voice">
        <input type="checkbox" checked={state.enabled} disabled={saving}
          onChange={event => void save({ enabled: event.target.checked }, '快速应答开关未保存')} />
        开启快速应答（开启前需原生确认：你的原话会发给下方配置的接口）
      </label>
      <label className="management-sleep">
        <span>接口地址</span>
        <input type="text" value={baseUrl} maxLength={500} disabled={saving}
          placeholder="OpenAI 兼容地址，如 https://api.deepseek.com/v1"
          onChange={event => setBaseUrl(event.target.value)} />
      </label>
      <label className="management-sleep">
        <span>模型名称</span>
        <input type="text" value={model} maxLength={200} disabled={saving}
          placeholder="如 deepseek-chat（建议选响应快的小模型）"
          onChange={event => setModel(event.target.value)} />
      </label>
      <label className="management-sleep">
        <span>API 密钥</span>
        <input type="password" value={apiKey} maxLength={500} disabled={saving}
          placeholder={state.secretConfigured ? '已保存（留空保持不变）' : '本地无鉴权端点可不填'}
          onChange={event => setApiKey(event.target.value)} />
      </label>
      <label className="management-sleep">
        <span>超时（毫秒）</span>
        <input type="number" value={timeoutMs} min={500} max={10000} step={100} disabled={saving}
          onChange={event => setTimeoutMs(Number(event.target.value))} />
      </label>
      <label className="management-sleep">
        <span>最长字数</span>
        <input type="number" value={maxChars} min={10} max={100} disabled={saving}
          onChange={event => setMaxChars(Number(event.target.value))} />
      </label>
      <div>
        <button className="management-button" disabled={saving}
          onClick={() => void save({
            baseUrl, model, timeoutMs, maxChars,
            ...(apiKey.trim() !== '' ? { apiKey: apiKey.trim() } : {}),
          }, '快速应答配置未保存')}>
          保存配置
        </button>
        <button className="management-button" disabled={saving || testing || baseUrl.trim() === '' || model.trim() === ''}
          onClick={() => void test()}>
          {testing ? '正在测试…' : '测试连接'}
        </button>
      </div>
      {sample !== null && <p className="management-hint" role="status">测试样例应答：{sample}</p>}
      <p className="management-hint">
        密钥只加密保存在本机，配置与日志都不含明文。超时或失败时静默跳过，不影响主回答。
      </p>
    </section>
  )
}

/**
 * 工作证据（M3-03 / M4-06 后续）。
 *
 * 只有一件事：把**当前窗口**的文字记成工作证据。会议纪要的入口在会议页（已确认的纪要才有）。
 *
 * 这里刻意不做成「每隔几分钟自动记一次」：自动采集前台应用与窗口标题的能力已经有了，
 * 但把窗口**正文**也持续记下来是完全不同的隐私决定。所以只接受用户主动点一次，
 * 而且每一次都要在主进程原生对话框里看一遍真实内容再决定。
 */
export function WorkEvidenceSettings({ showToast }: { readonly showToast: (text: string) => void }) {
  const [busy, setBusy] = useState(false)
  const capture = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.petApi.evidenceIntakeWindow()
      if (!result.ok) {
        // 读不到窗口、用户取消、未连上助理都会走到这里 —— 原样显示，不美化。
        showToast(result.error)
        return
      }
      showToast(result.duplicate
        ? '这段内容和之前记过的完全一样，没有产生新证据'
        : `已记为工作证据${result.warning ? `（${result.warning}）` : ''}`)
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="management-section" aria-label="工作证据">
      <h3>工作证据</h3>
      <p className="management-hint">
        把当前窗口里的文字记成一条工作证据，生成日报时可以引用它。每次都会先显示将要记下的内容，
        由你确认后才收；只存本机，不会因此发给模型。
      </p>
      <button className="management-button" disabled={busy} onClick={() => void capture()}>
        {busy ? '正在读取…' : '把当前窗口记为工作证据'}
      </button>
      <p className="management-hint">
        它只能支撑「推断」：屏幕上有测试输出不等于你跑了测试。会议纪要不同 ——
        那是你确认过的原文，可以支撑「直接证据」。
      </p>
    </section>
  )
}

/**
 * 演示隐私模式（M5-05）。
 *
 * 这一页最重要的事不是开关本身，而是**把四件容易混为一谈的事分开讲**：
 * 隐藏宠物 / 专注模式 / 演示隐私 / 停止记录。用户想要"别露出来"时，选错一个的结果差别很大
 * —— 比如为了藏历史去关活动记录，那是白丢数据；为了演示去隐藏角色，讲解时连宠物都不见了。
 *
 * 只影响显示：不删任何历史、不改系统设置、不动麦克风。关掉即恢复。
 */
export function PresentationSettings({ active }: { readonly active: boolean }) {
  return (
    <section className="management-section" aria-label="演示隐私模式">
      <h3>演示隐私模式</h3>
      <label className="management-voice">
        <input type="checkbox" checked={active}
          onChange={event => window.petApi.setPresentationMode(event.target.checked)} />
        隐藏此前的内容（聊天历史、主动提醒、会议与日报预览），新内容照常显示
      </label>
      <p className="management-hint">
        只影响显示，不删除任何数据；关掉后原样恢复。讲解、外放插话、暂停/停止都照常可用 ——
        演示时正是要用它们。不落盘：重启后回到普通模式。
      </p>
      <details className="management-hint">
        <summary>这四项不是一回事</summary>
        <ul>
          <li><strong>隐藏宠物</strong>（托盘）：角色从桌面上消失，截图里什么都不剩。</li>
          <li><strong>专注模式</strong>（托盘）：角色还在，但不闲聊、不开牌局、不听唤醒词。</li>
          <li><strong>演示隐私模式</strong>（本项）：角色和任务状态照常，只藏起过去的内容。</li>
          <li><strong>停止记录</strong>（活动记录）：不再采集前台活动，这会影响数据本身而不是显示。</li>
        </ul>
      </details>
    </section>
  )
}
