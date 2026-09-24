import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceApiInput, VoiceApiKind, VoiceApiProfile, VoiceApiProvider, VoiceApiResult, VoiceApiState } from '../voice-api-types.js'
import './voice-api-settings.css'

const KIND_LABELS: Record<VoiceApiKind, string> = { tts: '语音合成（TTS）', asr: '语音听写（ASR）' }
const PROVIDER_LABELS: Record<VoiceApiProvider, string> = { openai: 'OpenAI 兼容', mimo: 'MiMo（流式）' }
const emptyDraft = (): VoiceApiInput => ({ kind: 'tts', name: '', endpoint: '', model: '', voice: '', provider: 'openai' })

export default function VoiceApiSettings() {
  const [state, setState] = useState<VoiceApiState | null>(null)
  const [draft, setDraft] = useState<VoiceApiInput>(emptyDraft)
  const [editing, setEditing] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const inFlight = useRef(false)

  const run = useCallback(async (action: () => Promise<VoiceApiResult>, success?: () => void) => {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError('')
    setNotice('')
    try {
      const result = await action()
      if (!result.ok) {
        setError(`操作失败：${result.error || '请稍后重试'}`)
        return
      }
      // 列表和两个当前选择都以主进程回执为准，不提前删改界面状态。
      setState(result.state)
      success?.()
    } catch {
      setError('操作失败：无法与语音设置服务通信，请重试。')
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }, [])

  useEffect(() => { void run(() => window.petApi.voiceApiState()) }, [run])

  function resetEditor() {
    setDraft(emptyDraft())
    setApiKey('')
    setClearKey(false)
    setEditing(false)
  }

  function edit(profile?: VoiceApiProfile) {
    setDraft(profile ? {
      id: profile.id, kind: profile.kind, name: profile.name,
      endpoint: profile.endpoint, model: profile.model, voice: profile.voice,
      provider: profile.provider,
    } : emptyDraft())
    setApiKey('')
    setClearKey(false)
    setDeleteId(null)
    setError('')
    setNotice('')
    setEditing(true)
  }

  function save() {
    const input: VoiceApiInput = {
      ...draft,
      name: draft.name.trim(),
      endpoint: draft.endpoint.trim(),
      model: draft.model.trim(),
      voice: draft.kind === 'tts' ? (draft.voice ?? '').trim() : '',
    }
    if (!input.name || !input.endpoint || !input.model || (input.kind === 'tts' && !input.voice)) {
      setError('请填写名称、接口地址、模型，以及语音合成所需的音色 ID。')
      return
    }
    // 不传代表保留原密钥；只有明确勾选清除才发送空串。
    if (clearKey) input.apiKey = ''
    else if (apiKey.trim()) input.apiKey = apiKey.trim()
    void run(() => window.petApi.voiceApiSave(input), () => {
      resetEditor()
      setNotice('配置已保存；可在上方下拉框中选择使用。')
    })
  }

  const currentProfile = state?.profiles.find(profile => profile.id === draft.id)
  const removing = state?.profiles.find(profile => profile.id === deleteId)

  return (
    <section className="voice-api-settings" aria-label="语音接口设置" aria-busy={pending}>
      <h3>语音接口设置</h3>
      <p>仅支持 OpenAI 兼容接口；未配置或选择默认项时，沿用当前方案。</p>
      <p>选择自定义服务后，合成文本或听写音频会发送到您配置的服务，收费由服务商决定。自定义听写是说完后上传，非实时识别；唤醒词和会议仍保持本地处理。</p>
      {error && <p className="voice-api-error" role="alert">{error}</p>}
      <p role="status">{pending ? '正在处理，请稍候…' : notice}</p>
      <button type="button" disabled={pending} onClick={() => void run(() => window.petApi.voiceApiState())}>
        {state ? '刷新配置' : '重新加载'}
      </button>
      <fieldset disabled={pending || !state}>
        <legend>当前使用方案</legend>
        {(['tts', 'asr'] as const).map(kind => (
          <label key={kind}>
            {KIND_LABELS[kind]}
            <select name={`selected-${kind}`} value={state?.selected[kind] ?? ''}
              onChange={event => {
                const id = event.currentTarget.value || null
                void run(() => window.petApi.voiceApiSelect(kind, id), () => setNotice('使用方案已更新。'))
              }}>
              <option value="">默认（沿用原方案）</option>
              {state?.profiles.filter(profile => profile.kind === kind).map(profile => (
                <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>
      <fieldset disabled={pending || !state}>
        <legend>已保存的配置</legend>
        {state?.profiles.length === 0 && <p>尚未配置自定义接口。</p>}
        <ul>
          {state?.profiles.map(profile => (
            <li key={profile.id}>
              <span>{profile.name} · {KIND_LABELS[profile.kind]} · {profile.hasKey ? '已设置密钥' : '未设置密钥'}</span>
              <div className="voice-api-actions">
                <button type="button" onClick={() => edit(profile)} aria-label={`编辑 ${profile.name}`}>编辑</button>
                <button type="button" onClick={() => { setDeleteId(profile.id); setError(''); setNotice('') }}
                  aria-label={`删除 ${profile.name}`}>删除</button>
              </div>
            </li>
          ))}
        </ul>
        {removing && (
          <div className="voice-api-confirm" role="group" aria-label="删除确认">
            <p>确定删除“{removing.name}”？如果正在使用此配置，将恢复默认方案。</p>
            <div className="voice-api-actions">
              <button type="button" onClick={() => void run(() => window.petApi.voiceApiRemove(removing.id), () => {
                setDeleteId(null)
                if (draft.id === removing.id) resetEditor()
                setNotice('配置已删除。')
              })}>确认删除</button>
              <button type="button" onClick={() => setDeleteId(null)}>取消删除</button>
            </div>
          </div>
        )}
        <button type="button" onClick={() => edit()}>新增配置</button>
      </fieldset>
      {editing && (
        <form autoComplete="off" onSubmit={event => { event.preventDefault(); save() }}>
          <fieldset disabled={pending || !state}>
            <legend>{draft.id ? '编辑配置' : '新增配置'}</legend>
            <label>名称
              <input name="name" required value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label>类型
              <select name="kind" value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as VoiceApiKind })}>
                <option value="tts">语音合成（TTS）</option>
                <option value="asr">语音听写（ASR）</option>
              </select>
            </label>
            <label>提供商
              <select name="provider" value={draft.provider ?? 'openai'} onChange={event => setDraft({ ...draft, provider: event.target.value as VoiceApiProvider })}>
                <option value="openai">OpenAI 兼容</option>
                <option value="mimo">MiMo（流式识别）</option>
              </select>
            </label>
            <label>接口地址
              <input name="endpoint" type="url" required value={draft.endpoint}
                aria-describedby="voice-api-endpoint-help" onChange={event => setDraft({ ...draft, endpoint: event.target.value })} />
            </label>
            <p id="voice-api-endpoint-help">可填 API Base URL（需包含服务商版本路径，如 /v1），或完整 /audio/speech（合成）、/audio/transcriptions（听写）地址。</p>
            <label>模型
              <input name="model" required value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} />
            </label>
            {draft.kind === 'tts' && (
              <label>音色 ID（不是音色描述）
                <input name="voice" required value={draft.voice ?? ''} onChange={event => setDraft({ ...draft, voice: event.target.value })} />
              </label>
            )}
            <label>接口密钥{currentProfile?.hasKey ? '（已设置，不回显）' : '（可选）'}
              <input name="apiKey" type="password" autoComplete="new-password" value={apiKey} disabled={clearKey}
                aria-describedby="voice-api-key-help" onChange={event => setApiKey(event.target.value)} />
            </label>
            <p id="voice-api-key-help">编辑时留空会保留原密钥；仅输入新密钥时更新。密钥不存入浏览器本地存储。</p>
            {draft.id && (
              <label className="voice-api-clear-key">
                <input type="checkbox" checked={clearKey} onChange={event => { setClearKey(event.target.checked); setApiKey('') }} />
                明确清除已保存的密钥（保存后生效）
              </label>
            )}
            <div className="voice-api-actions">
              <button type="submit">保存配置</button>
              <button type="button" onClick={resetEditor}>取消编辑</button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  )
}
