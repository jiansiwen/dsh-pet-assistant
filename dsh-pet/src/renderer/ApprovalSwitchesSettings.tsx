/**
 * 「审批与核对」设置页：集中展示桌宠侧和插件侧全部审批、核对与确认弹窗开关。
 *
 * 每一项都能单独开关；顶部提供「一键全部开启（免审批演示）」和「全部恢复确认」，
 * 方便现场演示时一次性打开所有通路，演示后再一键关回。
 */
import { useCallback, useEffect, useState } from 'react'

export interface LocalApprovalFlags {
  meetingDocumentAutoApprove: boolean
  meetingIntegrityBypass: boolean
  meetingEgressAutoApprove: boolean
  meetingFastTranscribe: boolean
  skipLocalConfirm: boolean
  docRootsOpen: boolean
}

interface PluginSwitchItem {
  key: string
  title: string
  description: string
  enabled: boolean
}

interface Props {
  local: LocalApprovalFlags
  onSaveLocal(patch: Partial<LocalApprovalFlags>): Promise<boolean>
  showToast(message: string): void
}

const LOCAL_ITEMS: ReadonlyArray<{ key: keyof LocalApprovalFlags; title: string; description: string }> = [
  {
    key: 'meetingDocumentAutoApprove',
    title: '会议录音与文档讲解免确认',
    description: '桌面发起开始/停止会议录音、讲解文档时，直接执行，不逐次弹窗。',
  },
  {
    key: 'meetingIntegrityBypass',
    title: '录音不完整也允许生成和导出会议纪要',
    description: '跳过录音采集时间缺口或停止完整性校验，停录后直接出纪要、导出和保存文件。',
  },
  {
    key: 'meetingEgressAutoApprove',
    title: '会议纪要发给模型免确认弹窗',
    description: '用模型整理会议纪要时，跳过「发送会议文字给模型」确认弹窗直接生成。',
  },
  {
    key: 'meetingFastTranscribe',
    title: '会议快速转写（跳过会后声纹重分人，几秒出纪要）',
    description: '停录后直接复用录音期间的实时字幕并按本机/对方双轨分组，跳过耗时数分钟的会后重分人，避免长会议等待超时。',
  },
  {
    key: 'docRootsOpen',
    title: '打开和讲解任意本机文档（不限授权目录）',
    description: '桌面查找、打开、讲解本机路径文档时，不受授权目录清单限制。',
  },
  {
    key: 'skipLocalConfirm',
    title: '跳过桌面本地确认弹窗',
    description: '跳过高风险审批二次弹框、待办窗口、成员管理/新建独立会话、会议删除与行动项导入确认框。',
  },
]

export default function ApprovalSwitchesSettings({ local, onSaveLocal, showToast }: Props) {
  const [pluginSwitches, setPluginSwitches] = useState<PluginSwitchItem[] | null>(null)
  const [pluginError, setPluginError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refreshPlugin = useCallback(async () => {
    try {
      const result = await window.petApi.approvalSwitchesState()
      if (result.ok && result.switches) {
        setPluginSwitches(result.switches)
        setPluginError(null)
      } else {
        setPluginError(result.message ?? '暂时无法读取插件侧开关')
      }
    } catch {
      setPluginError('尚未连接到 DSH 插件，暂时无法读取插件侧开关')
    }
  }, [])

  useEffect(() => { void refreshPlugin() }, [refreshPlugin])

  const toggleLocal = async (key: keyof LocalApprovalFlags, enabled: boolean) => {
    setBusy(true)
    try {
      const ok = await onSaveLocal({ [key]: enabled })
      if (!ok) showToast('桌面免审批开关未保存')
    } finally { setBusy(false) }
  }

  const togglePlugin = async (key: string, enabled: boolean) => {
    setBusy(true)
    try {
      const result = await window.petApi.approvalSwitchesSave({ [key]: enabled })
      if (result.ok && result.switches) {
        setPluginSwitches(result.switches)
        setPluginError(null)
      } else {
        showToast(result.message ?? '插件免审批开关未保存')
      }
    } catch {
      showToast('插件免审批开关未保存')
    } finally { setBusy(false) }
  }

  const setAll = async (enabled: boolean) => {
    setBusy(true)
    try {
      const localOk = await onSaveLocal({
        meetingDocumentAutoApprove: enabled,
        meetingIntegrityBypass: enabled,
        meetingEgressAutoApprove: enabled,
        meetingFastTranscribe: enabled,
        skipLocalConfirm: enabled,
        docRootsOpen: enabled,
      })
      let pluginOk = true
      if (pluginSwitches && pluginSwitches.length > 0) {
        const patch = Object.fromEntries(pluginSwitches.map(item => [item.key, enabled]))
        const result = await window.petApi.approvalSwitchesSave(patch)
        if (result.ok && result.switches) {
          setPluginSwitches(result.switches)
          setPluginError(null)
        } else {
          pluginOk = false
          setPluginError(result.message ?? '插件侧开关未全部保存')
        }
      }
      if (localOk && pluginOk) {
        showToast(enabled ? '已全部开启免审批（演示模式生效）' : '已全部关闭，恢复逐次审批与确认')
      } else if (!localOk) {
        showToast('部分桌面开关未保存，请重试')
      } else {
        showToast('桌面开关已更新；插件侧尚未连上，请稍后重试')
      }
    } finally { setBusy(false) }
  }

  const localEnabledCount = LOCAL_ITEMS.filter(item => local[item.key]).length
  const pluginEnabledCount = (pluginSwitches ?? []).filter(item => item.enabled).length
  const totalCount = LOCAL_ITEMS.length + (pluginSwitches?.length ?? 0)
  const totalEnabled = localEnabledCount + pluginEnabledCount

  return (
    <div className="management-page">
      <section className="management-section" aria-label="演示模式一键切换">
        <h3>演示快捷控制</h3>
        <p className="management-hint">
          当前已开启 {totalEnabled} / {totalCount} 项免审批开关。打开的项将跳过审批卡片、完整性门禁或确认弹窗直接执行；演示完随时可以一键恢复。
        </p>
        <div className="management-quick">
          <button type="button" className="management-button primary" disabled={busy} onClick={() => void setAll(true)}>
            一键全部开启（演示免审批）
          </button>
          <button type="button" className="management-button" disabled={busy} onClick={() => void setAll(false)}>
            全部关闭（恢复逐次确认）
          </button>
          <button type="button" className="management-button" disabled={busy} onClick={() => void refreshPlugin()}>
            刷新状态
          </button>
        </div>
      </section>

      <section className="management-section" aria-label="会议、文档与桌面确认">
        <h3>会议、文档与桌面确认</h3>
        {LOCAL_ITEMS.map(item => (
          <div key={item.key} style={{ marginBottom: 10 }}>
            <label className="management-voice">
              <input
                type="checkbox"
                checked={local[item.key]}
                disabled={busy}
                onChange={event => void toggleLocal(item.key, event.target.checked)}
              />
              <span>{item.title}</span>
            </label>
            <p className="management-hint" style={{ margin: '2px 0 0 22px' }}>{item.description}</p>
          </div>
        ))}
      </section>

      <section className="management-section" aria-label="助理与子助理审批">
        <h3>助理与子助理审批</h3>
        {pluginError && <p className="management-hint">{pluginError}</p>}
        {pluginSwitches === null && !pluginError && <p className="management-hint">正在读取插件开关…</p>}
        {pluginSwitches?.map(item => (
          <div key={item.key} style={{ marginBottom: 10 }}>
            <label className="management-voice">
              <input
                type="checkbox"
                checked={item.enabled}
                disabled={busy}
                onChange={event => void togglePlugin(item.key, event.target.checked)}
              />
              <span>{item.title}</span>
            </label>
            <p className="management-hint" style={{ margin: '2px 0 0 22px' }}>{item.description}</p>
          </div>
        ))}
      </section>
    </div>
  )
}
