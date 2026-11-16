import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { knownCharacters } from './character-manifest.js'

type Result = { ok: true; value?: any } | { ok: false; error: string }

interface ProviderBase {
  id: string
  name: string
  type: string
  baseUrl: string
  model?: string
  auth?: { headerName?: string; scheme?: string; apiKeyRef?: string }
  submitPath?: string
  bodyTemplate?: Record<string, unknown>
  [key: string]: any
}

interface StudioState {
  config: { image: ProviderBase[]; video: ProviderBase[]; clone: ProviderBase[]; ffmpegPath?: string; keyColor?: string }
  secretFlags: Record<string, boolean>
  jobs: any[]
  skins: any[]
  voices: any[]
  ffmpeg: string | null
  selectedTts: string | null
}

declare global {
  interface Window { assetStudioApi: any }
}

const api = () => window.assetStudioApi

function useStudio() {
  const [state, setState] = useState<StudioState | null>(null)
  const [error, setError] = useState('')
  const refresh = async () => {
    const result: Result = await api().state()
    if (result.ok) setState(result.value as StudioState)
    else setError(result.error)
  }
  useEffect(() => {
    void refresh()
    return api().onChanged(() => void refresh())
  }, [])
  return { state, error, refresh, setError }
}

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

function ProviderEditor(props: {
  kind: 'image' | 'video' | 'clone'
  provider: ProviderBase
  secretFlags: Record<string, boolean>
  onChange: (p: ProviderBase) => void
  onRemove: () => void
  onTest: () => void
  onSecret: (ref: string, value: string) => void
}) {
  const { provider, onChange } = props
  const [key, setKey] = useState('')
  const [ttsKey, setTtsKey] = useState('')
  const [templateRaw, setTemplateRaw] = useState(JSON.stringify(provider.bodyTemplate ?? {}, null, 2))
  const [templateBad, setTemplateBad] = useState(false)
  const set = (patch: Record<string, any>) => onChange({ ...provider, ...patch })
  const ref = provider.id
  return (
    <div className="card">
      <div className="row">
        <strong>{provider.name || provider.id}</strong>
        <span className="muted">{provider.type}</span>
        <button onClick={props.onTest}>连通检查</button>
        <button onClick={props.onRemove}>删除</button>
      </div>
      <label>名称<input value={provider.name} onChange={e => set({ name: e.target.value })} /></label>
      <label>协议类型
        <select value={provider.type} onChange={e => set({ type: e.target.value })}>
          {props.kind === 'image' && <><option value="openai-images">openai-images</option><option value="http-json">http-json（自定字段）</option></>}
          {props.kind === 'video' && <><option value="async-task">async-task（提交+轮询）</option><option value="sync-url">sync-url（同步返回地址）</option></>}
          {props.kind === 'clone' && <option value="http-json">http-json</option>}
        </select>
      </label>
      <label>baseUrl<input value={provider.baseUrl} onChange={e => set({ baseUrl: e.target.value })} placeholder="https://你的模型服务/" /></label>
      {props.kind !== 'clone' && <label>model<input value={provider.model ?? ''} onChange={e => set({ model: e.target.value })} /></label>}
      <label>提交路径<input value={provider.submitPath ?? ''} onChange={e => set({ submitPath: e.target.value })} placeholder="/v1/xxx" /></label>
      <label>请求体模板（JSON，占位符 {'{{prompt}} {{image_url}} {{model}} {{samples}}'}）
        <textarea
          rows={3}
          value={templateRaw}
          onChange={e => {
            setTemplateRaw(e.target.value)
            try {
              onChange({ ...provider, bodyTemplate: JSON.parse(e.target.value) })
              setTemplateBad(false)
            } catch {
              setTemplateBad(true)
            }
          }}
        />
      </label>
      {templateBad && <div className="muted">模板 JSON 暂不合法，修正后才会保存</div>}
      {props.kind === 'image' && <>
        <label>结果 url 路径<input value={provider.resultUrlPath ?? ''} onChange={e => set({ resultUrlPath: e.target.value })} placeholder="data[0].url" /></label>
        <label>结果 b64 路径<input value={provider.resultB64Path ?? ''} onChange={e => set({ resultB64Path: e.target.value })} placeholder="data[0].b64_json" /></label>
      </>}
      {props.kind === 'video' && <>
        <label>任务 ID 路径<input value={provider.taskIdPath ?? ''} onChange={e => set({ taskIdPath: e.target.value })} placeholder="output.task_id" /></label>
        <label>轮询路径<input value={provider.pollPath ?? ''} onChange={e => set({ pollPath: e.target.value })} placeholder="/v1/tasks/{{task_id}}" /></label>
        <label>状态路径<input value={provider.statusPath ?? ''} onChange={e => set({ statusPath: e.target.value })} placeholder="output.task_status" /></label>
        <label>视频地址路径<input value={provider.videoUrlPath ?? ''} onChange={e => set({ videoUrlPath: e.target.value })} placeholder="output.video_url" /></label>
      </>}
      {props.kind === 'clone' && <>
        <label>voiceId 路径<input value={provider.voiceIdPath ?? ''} onChange={e => set({ voiceIdPath: e.target.value })} placeholder="voice_id" /></label>
        <label>TTS 端点（openai 兼容）<input value={provider.ttsEndpoint ?? ''} onChange={e => set({ ttsEndpoint: e.target.value })} /></label>
        <label>TTS model<input value={provider.ttsModel ?? ''} onChange={e => set({ ttsModel: e.target.value })} /></label>
      </>}
      <label>鉴权头名<input value={provider.auth?.headerName ?? ''} onChange={e => set({ auth: { ...provider.auth, headerName: e.target.value } })} placeholder="authorization" /></label>
      <label>鉴权前缀<input value={provider.auth?.scheme ?? ''} onChange={e => set({ auth: { ...provider.auth, scheme: e.target.value } })} placeholder="Bearer " /></label>
      <label>API 密钥（只写，加密落盘；{props.secretFlags[ref] ? '已保存' : '未保存'}）
        <input type="password" value={key} onChange={e => {
          setKey(e.target.value)
          props.onSecret(ref, e.target.value)
          set({ auth: { ...provider.auth, apiKeyRef: ref } })
        }} />
      </label>
      {props.kind === 'clone' && (
        <label>TTS 密钥（只写；{props.secretFlags[`${ref}-tts`] ? '已保存' : '未保存'}）
          <input type="password" value={ttsKey} onChange={e => {
            setTtsKey(e.target.value)
            props.onSecret(`${ref}-tts`, e.target.value)
            set({ ttsApiKeyRef: `${ref}-tts` })
          }} />
        </label>
      )}
    </div>
  )
}

function App() {
  const { state, error, refresh, setError } = useStudio()
  const [tab, setTab] = useState<'pipeline' | 'clip' | 'voice' | 'providers'>('pipeline')
  /*
   * 从视频裁动作的表单状态。
   *
   * 起止用**秒数输入**而不是时间轴拖拽：拖拽要做好多交互（缩略图、帧对齐、预览），
   * 而这里真正需要的只是"从第几秒到第几秒"，播一遍原片记下数字更快。
   */
  const [clip, setClip] = useState({ sourcePath: '', from: '0', to: '1.5', matte: 'background', action: 'wave', skinId: '', skinName: '', busy: false, note: '' })
  const [draft, setDraft] = useState<StudioState['config'] | null>(null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [job, setJob] = useState({ name: '', prompt: '', imageProviderId: '', videoProviderId: '', approved: false, actions: ['idle', 'walk', 'think', 'wave', 'jump', 'sleep'] as string[] })
  const [clone, setClone] = useState({ providerId: '', name: '', files: [] as string[], consent: false })
  const [applyTarget, setApplyTarget] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [aiRequest, setAiRequest] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [customAction, setCustomAction] = useState('')

  const config = draft ?? state?.config
  const run = async (label: string, fn: () => Promise<Result>) => {
    setBusy(label)
    const result = await fn()
    setBusy('')
    if (!result.ok) setError(result.error)
    else await refresh()
  }

  if (!state || !config) return <div className="wrap">加载中… {error}</div>

  const saveProviders = () => run('保存配置', async () => {
    const result = await api().saveProviders(config, secrets)
    if (result.ok) { setDraft(null); setSecrets({}) }
    return result
  })

  const runAi = async () => {
    if (!aiRequest.trim() || aiBusy) return
    setAiBusy(true)
    const result: Result = await api().assist(aiRequest.trim())
    setAiBusy(false)
    if (!result.ok) { setError(result.error); return }
    const v = result.value as { name: string; prompt: string; actions: string[]; notes: string }
    setJob(j => ({ ...j, name: v.name || j.name, prompt: v.prompt || j.prompt, actions: v.actions?.length ? v.actions : j.actions }))
    setError('')
  }

  const addAction = (name: string) => {
    const a = name.trim().toLowerCase()
    if (!a || !/^[a-z][a-z0-9-]{0,23}$/.test(a)) { setError('动作名用小写英文/数字/短横线，如 dance、tai-chi'); return }
    setJob(j => j.actions.includes(a) ? j : { ...j, actions: [...j.actions, a].slice(0, 8) })
    setCustomAction('')
  }

  return (
    <div className="wrap">
      <h1>形象与音色工作室</h1>
      <div className="row tabs">
        <button className={tab === 'pipeline' ? 'on' : ''} onClick={() => setTab('pipeline')}>形象流水线</button>
        <button className={tab === 'clip' ? 'on' : ''} onClick={() => setTab('clip')}>从视频裁动作</button>
        <button className={tab === 'voice' ? 'on' : ''} onClick={() => setTab('voice')}>自定义音色</button>
        <button className={tab === 'providers' ? 'on' : ''} onClick={() => setTab('providers')}>模型接入配置</button>
      </div>
      {error && <div className="error">{error}<button onClick={() => setError('')}>关闭</button></div>}

      {tab === 'clip' && <>
        <p className="muted">
          从你本地已有的视频里截一小段，扣掉背景，变成某个动作。**不需要视频模型。**
          抠像是靠估计静态背景，所以镜头会动的片段扣不干净——那种情况会如实失败，不会塞一段半透明鬼影给你。
        </p>
        <label>视频文件
          <div className="row">
            <input readOnly value={clip.sourcePath} placeholder="还没选" />
            <button onClick={async () => {
              const result = await api().pickVideo()
              if (!result.ok) { setError(result.error); return }
              const picked = Array.isArray(result.value) ? String(result.value[0] ?? '') : ''
              if (picked !== '') setClip({ ...clip, sourcePath: picked })
            }}>选择…</button>
          </div>
        </label>
        <div className="row">
          <label>从第几秒<input value={clip.from} onChange={e => setClip({ ...clip, from: e.target.value })} /></label>
          <label>到第几秒<input value={clip.to} onChange={e => setClip({ ...clip, to: e.target.value })} /></label>
        </div>
        <div className="row">
          <label>抠像方式
            <select value={clip.matte} onChange={e => setClip({ ...clip, matte: e.target.value })}>
              <option value="background">静态背景估计（镜头不动）</option>
              <option value="chroma">绿幕抠像</option>
              <option value="none">不抠，保留原背景</option>
            </select>
          </label>
          <label>动作名<input value={clip.action} onChange={e => setClip({ ...clip, action: e.target.value })} placeholder="wave" /></label>
        </div>
        <div className="row">
          <label>加到皮肤（留空则新建）
            <select value={clip.skinId} onChange={e => setClip({ ...clip, skinId: e.target.value })}>
              <option value="">新建一个</option>
              {(state.skins ?? []).map(skin => <option key={skin.id} value={skin.id}>{skin.name}</option>)}
            </select>
          </label>
          {clip.skinId === '' && <label>新皮肤名<input value={clip.skinName} onChange={e => setClip({ ...clip, skinName: e.target.value })} placeholder="例如 小张" /></label>}
        </div>
        <button disabled={clip.busy || clip.sourcePath === '' || clip.action.trim() === ''} onClick={async () => {
          setClip({ ...clip, busy: true, note: '' })
          const result = await api().extractClip({
            sourcePath: clip.sourcePath, from: Number(clip.from), to: Number(clip.to),
            matte: clip.matte, action: clip.action.trim(), skinId: clip.skinId, skinName: clip.skinName.trim(),
          })
          setClip({ ...clip, busy: false, note: result.ok ? `已生成：${clip.action}（皮肤 ${String((result.value as { skinId?: string })?.skinId ?? clip.skinId)}）` : (result.error ?? '失败') })
          if (result.ok) await refresh()
        }}>{clip.busy ? '正在裁剪…' : '裁出这个动作'}</button>
        {clip.note !== '' && <p className="muted">{clip.note}</p>}
      </>}

      {tab === 'providers' && <>
        <p className="muted">接你自己的模型：填 baseUrl 与协议字段即可。密钥加密落盘，配置里只留引用。ffmpeg：{state.ffmpeg ?? '未找到（后处理会停住并提示）'}</p>
        <label>ffmpeg 路径（可选）<input value={config.ffmpegPath ?? ''} onChange={e => setDraft({ ...config, ffmpegPath: e.target.value })} /></label>
        <label>抠像底色（可选）<input value={config.keyColor ?? ''} onChange={e => setDraft({ ...config, keyColor: e.target.value })} placeholder="0x00FF00" /></label>
        {(['image', 'video', 'clone'] as const).map(kind => (
          <section key={kind}>
            <div className="row">
              <h2>{kind === 'image' ? '图像模型' : kind === 'video' ? '视频模型' : '音色克隆模型'}</h2>
              <button onClick={() => setDraft({
                ...config,
                [kind]: [...config[kind], {
                  id: newId(kind), name: '', type: kind === 'image' ? 'openai-images' : kind === 'video' ? 'async-task' : 'http-json', baseUrl: '', model: '',
                }],
              })}>添加</button>
            </div>
            {config[kind].map((p, i) => (
              <ProviderEditor
                key={p.id}
                kind={kind}
                provider={p}
                secretFlags={state.secretFlags}
                onChange={np => setDraft({ ...config, [kind]: config[kind].map((old, j) => j === i ? np : old) })}
                onRemove={() => setDraft({ ...config, [kind]: config[kind].filter((_, j) => j !== i) })}
                onTest={() => void run('连通检查', async () => {
                  const r = await api().testProvider(kind, p.id)
                  if (r.ok) setError(`连通检查：HTTP ${r.value.status}${r.value.ok ? '（可达）' : '（不可达或鉴权失败）'}`)
                  return r
                })}
                onSecret={(ref, value) => setSecrets(s => ({ ...s, [ref]: value }))}
              />
            ))}
          </section>
        ))}
        <div className="row">
          <button disabled={busy !== ''} onClick={saveProviders}>保存配置</button>
          {draft && <button onClick={() => { setDraft(null); setSecrets({}) }}>放弃修改</button>}
        </div>
      </>}

      {tab === 'pipeline' && <>
        <div className="card">
          <label>用一句话描述形象（AI 帮我配）
            <textarea rows={2} value={aiRequest} onChange={e => setAiRequest(e.target.value)} placeholder="例：一只戴眼镜的橘猫，温和爱看书，动作有走路、挥手、看书、打盹" />
          </label>
          <div className="row">
            <button disabled={aiBusy || !aiRequest.trim()} onClick={() => void runAi()}>{aiBusy ? '小潘正在想…' : '让 AI 帮我配'}</button>
          </div>
          <p className="muted">AI 只填名称、形象描述和建议动作；是否生成、费用确认仍由你决定。</p>
        </div>
        <div className="card">
          <label>形象名称<input value={job.name} onChange={e => setJob({ ...job, name: e.target.value })} /></label>
          <label>形象描述（prompt）<textarea rows={3} value={job.prompt} onChange={e => setJob({ ...job, prompt: e.target.value })} /></label>
          <label>图像模型
            <select value={job.imageProviderId} onChange={e => setJob({ ...job, imageProviderId: e.target.value })}>
              <option value="">选择…</option>
              {state.config.image.map(p => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
            </select>
          </label>
          <label>视频模型
            <select value={job.videoProviderId} onChange={e => setJob({ ...job, videoProviderId: e.target.value })}>
              <option value="">选择…</option>
              {state.config.video.map(p => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
            </select>
          </label>
          <div className="row">
            {[...new Set(['idle', 'walk', 'think', 'wave', 'jump', 'sleep', ...job.actions])].map(a => (
              <label key={a} className="check">
                <input type="checkbox" checked={job.actions.includes(a)} onChange={e => setJob({ ...job, actions: e.target.checked ? [...job.actions, a] : job.actions.filter(x => x !== a) })} />{a}
              </label>
            ))}
          </div>
          <div className="row">
            <input value={customAction} onChange={e => setCustomAction(e.target.value)} placeholder="自定义动作名，如 dance" />
            <button onClick={() => addAction(customAction)}>添加动作</button>
          </div>
          <p className="muted">可添加任意自定义动作（不受预设限制）；生成时会为每个勾选动作出片，最多 8 个。</p>
          <label className="check">
            <input type="checkbox" checked={job.approved} onChange={e => setJob({ ...job, approved: e.target.checked })} />
            我知悉：1 次图像 + {job.actions.length} 次视频调用，费用计入我所配平台
          </label>
          <button disabled={busy !== '' || !job.approved || !job.imageProviderId || !job.videoProviderId} onClick={() => void run('生成', () => api().startJob(job))}>开始生成</button>
        </div>
        <h2>作业</h2>
        {state.jobs.map(j => (
          <div className="card" key={j.id}>
            <div className="row"><strong>{j.name}</strong><span className="muted">{j.status}</span>
              {(j.status === 'queued' || j.status === 'image' || j.status === 'clips' || j.status === 'post') && <button onClick={() => void run('取消', () => api().cancelJob(j.id))}>取消</button>}
              {j.status === 'needs-postprocess' && <button onClick={() => void run('后处理', () => api().rerunPost(j.id))}>重试后处理</button>}
            </div>
            {j.error && <div className="error">{j.error}</div>}
            {j.skinId && <div className="row">
              <img className="preview" src={`pet-asset://custom/pets/${j.skinId}.png`} alt="皮肤预览" />
              <select value={applyTarget[j.skinId] ?? ''} onChange={e => setApplyTarget({ ...applyTarget, [j.skinId]: e.target.value })}>
                <option value="">应用到角色…</option>
                {knownCharacters().map(c => <option key={c.assistantId} value={c.assistantId}>{c.displayName}</option>)}
              </select>
              <button disabled={!applyTarget[j.skinId]} onClick={() => void run('应用', () => api().applySkin(j.skinId, applyTarget[j.skinId]))}>应用</button>
            </div>}
          </div>
        ))}
        <h2>已登记皮肤</h2>
        {state.skins.map(s => (
          <div className="card row" key={s.id}>
            <img className="preview" src={`pet-asset://custom/pets/${s.id}.png`} alt={s.name} />
            <strong>{s.name}</strong><span className="muted">{s.actions.join('/')}</span>
            <button onClick={() => void run('删除', () => api().deleteSkin(s.id))}>删除</button>
          </div>
        ))}
      </>}

      {tab === 'voice' && <>
        <div className="card">
          <label>克隆模型
            <select value={clone.providerId} onChange={e => setClone({ ...clone, providerId: e.target.value })}>
              <option value="">选择…</option>
              {state.config.clone.map(p => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
            </select>
          </label>
          <label>音色名称<input value={clone.name} onChange={e => setClone({ ...clone, name: e.target.value })} /></label>
          <div className="row">
            <button onClick={() => void run('选样本', async () => {
              const r = await api().pickAudio()
              if (r.ok) setClone({ ...clone, files: r.value as string[] })
              return r
            })}>选择样本（1–3 个音频）</button>
            <span className="muted">{clone.files.map(f => f.split(/[\\/]/).pop()).join('、') || '未选择'}</span>
          </div>
          <label className="check">
            <input type="checkbox" checked={clone.consent} onChange={e => setClone({ ...clone, consent: e.target.checked })} />
            我确认样本为本人或已获授权的声音，并知悉样本将发送到我配置的克隆端点
          </label>
          <button disabled={busy !== '' || !clone.consent || !clone.providerId || clone.files.length === 0} onClick={() => void run('克隆', () => api().startClone(clone))}>开始克隆</button>
        </div>
        <h2>我的音色</h2>
        {state.voices.map(v => (
          <div className="card row" key={v.id}>
            <strong>{v.name}</strong><span className="muted">voiceId {v.voiceId}</span>
            <button onClick={() => void run('应用', () => api().applyVoice(v.id))}>设为当前音色</button>
            <button onClick={() => void run('撤销', () => api().revokeVoice(v.id))}>撤销</button>
          </div>
        ))}
        <p className="muted">当前 TTS profile：{state.selectedTts ?? '默认'}。撤销后回退默认音色；已发送到克隆端点的样本副本无法收回。</p>
      </>}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)