import { useEffect, useRef, useState } from 'react'
import { ROLE_PRESET_NAME_LIMIT, type RolePresetApi, type RolePresetResult, type RolePresetView } from '../role-preset-types.ts'

export function useRolePresetList(read?: RolePresetApi['rolePresets']) {
  const [presets, setPresets] = useState<RolePresetView[]>([])
  const [pending, setPending] = useState(!!read)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!read) return
    let active = true
    void read().then(result => {
      if (!active) return
      if (result.ok) setPresets(result.presets)
      else setError(result.error)
    }).catch(() => { if (active) setError('暂时读不到角色方案。') })
      .finally(() => { if (active) setPending(false) })
    return () => { active = false }
  }, [read])
  return { presets, setPresets, pending, error }
}

export function RolePresetSelect({ presets, value, disabled, onChange, label = '选择角色方案' }: {
  presets: readonly RolePresetView[]; value: string; disabled?: boolean; onChange(id: string): void; label?: string
}) {
  return <label className="role-preset-field"><span>{label}</span>
    <select value={value} onChange={event => onChange(event.target.value)} disabled={disabled || presets.length === 0}>
      <option value="">{presets.length ? '请选择…' : '暂无已保存方案'}</option>
      {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
    </select>
  </label>
}

export function RolePresetPreview({ preset }: { preset: RolePresetView }) {
  return <dl className="role-preset-preview">
    <div><dt>形象</dt><dd>{preset.skinLabel}</dd></div>
    <div><dt>音色</dt><dd>{preset.voiceLabel}</dd></div>
    <div><dt>随机动作</dt><dd>{preset.actions.join('、') || '不播放随机动作'}</dd></div>
    <div><dt>性格</dt><dd>{preset.personality || '默认性格'}</dd></div>
  </dl>
}

export function RolePresetControls({ targets, disabled, onApplied }: {
  targets: readonly { id: string; label: string }[]; disabled?: boolean; onApplied?(): void
}) {
  const api = window.petApi
  const library = useRolePresetList(api.rolePresets)
  const [targetId, selectTarget] = useState('')
  const [presetId, selectPreset] = useState('')
  const [name, setName] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const locked = useRef(false)
  const target = targets.find(item => item.id === targetId) ?? targets[0]
  const preset = library.presets.find(item => item.id === presetId)
  if (!api.rolePresets) return null
  const busy = pending || disabled || library.pending || !target
  async function run(action: () => Promise<RolePresetResult>, success: () => void) {
    if (busy || locked.current) return
    locked.current = true
    setPending(true); setNotice(''); setError('')
    try {
      const result = await action()
      if (!result.ok) { setError(result.error); return }
      library.setPresets(result.presets)
      success()
    } catch { setError('没有收到角色方案操作回执，请重新打开本页核对。') }
    finally { locked.current = false; setPending(false) }
  }
  return <section className="management-section role-preset-controls" aria-label="角色方案" aria-busy={pending || library.pending}>
    <h3>角色方案</h3>
    <p className="management-hint">总助理和子助理共用。切换只替换形象、动作、播报音色和性格，不改变原会话、任务或权限。</p>
    {targets.length > 1 && <label className="role-preset-field"><span>选择助理</span>
      <select value={target?.id ?? ''} disabled={busy} onChange={event => { selectTarget(event.target.value); setNotice(''); setError('') }}>
        {targets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
    </label>}
    <div className="role-preset-row">
      <RolePresetSelect presets={library.presets} value={presetId} disabled={busy} onChange={selectPreset} />
      <button className="management-button" type="button" disabled={busy || !preset} onClick={() => {
        if (target && preset) void run(() => api.applyRolePreset(target.id, preset.id), () => {
          setNotice(`已为${target.label}套用「${preset.name}」。下一次回复和播报使用新性格与音色。`)
          onApplied?.()
        })
      }}>一键应用</button>
    </div>
    {preset && <RolePresetPreview preset={preset} />}
    <div className="role-preset-row">
      <label className="role-preset-field"><span>新方案名称</span><input value={name} onChange={event => setName(event.target.value)}
        maxLength={ROLE_PRESET_NAME_LIMIT} disabled={busy} placeholder="例如：严谨办公" /></label>
      <button className="management-button" type="button" disabled={busy || !name.trim()} onClick={() => {
        if (target) void run(() => api.saveRolePreset(target.id, name), () => {
          setNotice(`已将${target.label}的当前配置保存为「${name.trim()}」。`); setName('')
        })
      }}>保存当前为方案</button>
    </div>
    {(error || library.error) && <p className="assistant-settings-error" role="alert">{error || library.error}</p>}
    {(notice || pending) && <p className="management-hint" role="status">{pending ? '正在处理角色方案…' : notice}</p>}
  </section>
}
