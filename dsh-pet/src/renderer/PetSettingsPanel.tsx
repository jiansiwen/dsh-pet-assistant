import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ResidencyPatch, ResidencyState, SettingsPage } from './types.js'
import { registerCharacterHitbox, unregisterCharacterHitbox } from './stage-layout.js'

interface Props {
  page: SettingsPage
  onPage(page: SettingsPage): void
  onClose(): void
  children: React.ReactNode
  quotaPending?: number
}

export default function PetSettingsPanel({ page, onPage, onClose, children, quotaPending = 0 }: Props) {
  const panel = useRef<HTMLDivElement | null>(null)
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

  return <section className="pet-management" ref={panel} data-interactive aria-label="小潘桌面伙伴控制台">
    <header className="management-header"><h2>小潘桌面伙伴控制台</h2><button onClick={onClose} aria-label="关闭设置">×</button></header>
    <nav className="management-tabs" aria-label="设置分类">
      {([['general', '通用'], ['team', '团队'], ['doc', '文档'], ['meeting', '会议'], ['wecom', '渠道'], ['reminders', '提醒']] as const).map(([id, title]) =>
        <button key={id} type="button" aria-current={page === id ? 'page' : undefined} onClick={() => onPage(id)}>{title}
          {id === 'team' && quotaPending > 0 && <span className="panel-tab-badge" aria-label={`${quotaPending}条额度申请待处理`}>{quotaPending}</span>}
        </button>)}
    </nav>
    <div className="management-content">{children}</div>
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
        语音唤醒“小潘同学”
        {state.platform === 'darwin' && '（开启后持续采集麦克风，菜单栏会一直显示麦克风占用标识）'}
      </label>
      <p className="management-hint" role="status">唤醒状态：{wakeStatus}</p>
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
