import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MEMBER_CAPABILITIES, MEMBER_CAPABILITY_LABELS, MEMBER_KINDS, MEMBER_KIND_LABELS, MEMBER_PERMISSION_LABELS, MEMBER_PERMISSION_MODES,
  SUB_ASSISTANT_REPORT_LABELS, SUB_ASSISTANT_REPORT_MODES,
  type MemberCapability, type MemberDraft, type MemberEditorContext, type MemberKind, type MemberPermissionMode,
  type MemberResult, type MemberSnapshot, type MemberView, type SubAssistantReportMode,
} from '../member-types.ts'

const CAPABILITY_HINTS: Record<MemberCapability, string> = {
  wecom: '在企业微信单聊里接单',
  mail: '定时收未读并分析；正文发给该成员模型，发送前仍需你确认',
  meeting: '开始/结束录音与系统回环，生成会议纪要',
  document: '打开已授权文档，逐段讲解与追问',
  activity: '读取已授权的活动与日报',
  reminders: '创建提醒和待办',
}
const EXAMPLES = ['每天帮我整理工作日报', '专门接收企业微信消息并提醒我', '帮我管理邮件，发送前先问我']
const SKINS: Array<[string, string]> = [['panda', '熊猫'], ['boy-glasses', '眼镜男生'], ['girl-glasses', '眼镜女生']]
const limitLabel = (limit: number): string => limit === 0 ? '不限' : limit.toLocaleString('zh-CN')

type DraftForm = Omit<MemberDraft, 'maxTokens' | 'dailyTokenLimit' | 'totalTokenLimit' | 'thresholdPercent' | 'kind' | 'binding' | 'reportMode' | 'apiKey'> & {
  maxTokens: string; dailyTokenLimit: string; totalTokenLimit: string; thresholdPercent: string
  kind: MemberKind; reportMode: SubAssistantReportMode
  endpoint: string; platformModel: string; secretId: string
  command: string; argsText: string
  apiKey: string
}
const COMPARE_FIELDS: ReadonlyArray<readonly [keyof DraftForm, string]> = [
  ['displayName', '名称'], ['description', '职责'], ['personality', '性格'], ['persona', '工作要求'],
  ['kind', '成员类型'], ['reportMode', '汇报模式'], ['endpoint', '平台端点'], ['platformModel', '平台模型'],
  ['command', '工具命令'], ['argsText', '工具参数'],
  ['permissionMode', '权限'], ['skinId', '形象'], ['enabled', '启用状态'], ['capabilities', '能力'],
  ['provider', '模型服务商'], ['model', '模型'], ['maxTokens', '单次最大输出量'], ['dailyTokenLimit', '日额度'],
  ['totalTokenLimit', '总额度'], ['thresholdPercent', '申请阈值'], ['timezone', '时区'],
]
function displayDraftValue(key: keyof DraftForm, value: DraftForm[keyof DraftForm]): string {
  if (key === 'permissionMode' && typeof value === 'string') return MEMBER_PERMISSION_LABELS[value as MemberPermissionMode]?.title ?? value
  if (key === 'kind' && typeof value === 'string') return MEMBER_KIND_LABELS[value as MemberKind]?.title ?? value
  if (key === 'reportMode' && typeof value === 'string') return SUB_ASSISTANT_REPORT_LABELS[value as SubAssistantReportMode] ?? value
  if (key === 'skinId' && typeof value === 'string') return SKINS.find(([id]) => id === value)?.[1] ?? value
  if (Array.isArray(value)) return value.length ? value.map(item => MEMBER_CAPABILITY_LABELS[item as MemberCapability] ?? item).join('、') : '（无）'
  if (typeof value === 'boolean') return value ? '已启用' : '未启用'
  return String(value) || '（空）'
}
interface Note { id: number; role: 'user' | 'assistant'; text: string; error?: boolean }

function localTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' } catch { return 'Asia/Shanghai' }
}
function initialForm(member: MemberView | null): DraftForm {
  const p = member?.profile
  const binding = p?.binding ?? null
  return {
    displayName: p?.displayName ?? '新成员', description: p?.description ?? '', personality: p?.personality ?? '',
    permissionMode: p?.permissionMode ?? 'ask', persona: p?.persona ?? '', skinId: p?.skinId ?? 'panda',
    enabled: p?.enabled ?? true, provider: p?.provider ?? '', model: p?.model ?? '', maxTokens: String(p?.maxTokens ?? 16384),
    capabilities: [...(p?.capabilities ?? [])], allowedTools: [], dailyTokenLimit: String(p?.dailyTokenLimit ?? 0),
    totalTokenLimit: String(p?.totalTokenLimit ?? 0), thresholdPercent: String(p?.thresholdPercent ?? 80),
    timezone: p?.timezone ?? localTimezone(),
    kind: p?.kind ?? 'expert', reportMode: p?.reportMode ?? 'chief',
    endpoint: binding?.kind === 'platform' ? binding.endpoint : '', platformModel: binding?.kind === 'platform' ? binding.model : '',
    secretId: binding?.kind === 'platform' ? binding.secretId : '',
    command: binding?.kind === 'local-cli' ? binding.command : '', argsText: binding?.kind === 'local-cli' ? binding.args.join(' ') : '',
    apiKey: '',
  }
}
function fromDraft(draft: MemberDraft): DraftForm {
  const { kind, reportMode, binding, apiKey, ...rest } = draft
  const bound = binding ?? null
  return { ...rest, kind: kind ?? 'expert', reportMode: reportMode ?? 'chief',
    endpoint: bound?.kind === 'platform' ? bound.endpoint : '', platformModel: bound?.kind === 'platform' ? bound.model : '',
    secretId: bound?.kind === 'platform' ? bound.secretId : '',
    command: bound?.kind === 'local-cli' ? bound.command : '', argsText: bound?.kind === 'local-cli' ? bound.args.join(' ') : '',
    apiKey: '',
    capabilities: [...draft.capabilities], allowedTools: [], maxTokens: String(draft.maxTokens),
    dailyTokenLimit: String(draft.dailyTokenLimit), totalTokenLimit: String(draft.totalTokenLimit), thresholdPercent: String(draft.thresholdPercent) }
}
function safeInteger(value: string, fallback: number, min = 0): number {
  const n = Number(value)
  return value.trim() && Number.isSafeInteger(n) && n >= min ? n : fallback
}
/** 给 AI 的基准草稿；表单临时空值用默认值补齐，不用于保存。 */
/** 由表单构建外部绑定；expert 成员恒为 null（绑定变化会清空子助理会话，属预期）。 */
function bindingOf(form: DraftForm): MemberDraft['binding'] {
  if (form.kind === 'platform') return { kind: 'platform', endpoint: form.endpoint.trim(), model: form.platformModel.trim(), secretId: form.secretId }
  if (form.kind === 'local-cli') return { kind: 'local-cli', command: form.command.trim(), args: form.argsText.split(/\s+/).filter(Boolean) }
  return null
}
/** 基础形状校验：深度校验（https/回环、未知字段）在插件录入侧完成，错误如实回显。 */
function validBinding(form: DraftForm): boolean {
  if (form.kind === 'platform') {
    try {
      const url = new URL(form.endpoint.trim())
      if (!/^https?:$/.test(url.protocol)) return false
      if (url.protocol === 'http:' && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(url.host)) return false
    } catch { return false }
    return form.platformModel.trim().length > 0
  }
  if (form.kind === 'local-cli') return form.command.trim().length > 0
  return true
}
function formDraft(form: DraftForm, member: MemberView | null): MemberDraft {
  const { endpoint, platformModel, secretId, command, argsText, apiKey, ...rest } = form
  return {
    ...rest, displayName: rest.displayName.trim() || '新成员', provider: rest.provider.trim(), model: rest.model.trim(),
    maxTokens: safeInteger(rest.maxTokens, member?.profile.maxTokens ?? 16384, 1),
    dailyTokenLimit: safeInteger(rest.dailyTokenLimit, member?.profile.dailyTokenLimit ?? 0),
    totalTokenLimit: safeInteger(rest.totalTokenLimit, member?.profile.totalTokenLimit ?? 0),
    thresholdPercent: safeInteger(rest.thresholdPercent, member?.profile.thresholdPercent ?? 80, 1),
    timezone: rest.timezone.trim() || localTimezone(), allowedTools: [],
    kind: rest.kind, reportMode: rest.reportMode, binding: bindingOf(form),
  }
}
function validDraft(form: DraftForm): boolean {
  const numbers = ['maxTokens', 'dailyTokenLimit', 'totalTokenLimit', 'thresholdPercent'] as const
  if (numbers.some(key => !form[key].trim() || !Number.isSafeInteger(Number(form[key]))
    || Number(form[key]) < (key === 'maxTokens' || key === 'thresholdPercent' ? 1 : 0))) return false
  if (Number(form.maxTokens) > 131072 || Number(form.thresholdPercent) > 100 || !form.displayName.trim()
    || !!form.model.trim() !== !!form.provider.trim() || !form.timezone.trim()) return false
  if (!validBinding(form)) return false
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: form.timezone }).format(); return true } catch { return false }
}
function toDraft(form: DraftForm): MemberDraft {
  const draft = formDraft(form, null)
  // 平台密钥只在用户本次填了才上桥：留空＝沿用已存密钥；经桥后即入加密存储，永不回显。
  if (form.kind === 'platform' && form.apiKey.trim()) draft.apiKey = form.apiKey.trim()
  return draft
}

export interface MemberEditorPanelProps {
  member: MemberView | null
  latest?: MemberView
  pending: boolean
  onSave(draft: MemberDraft, memberId: string | null, expectedRevision?: number): Promise<MemberResult>
  onDelete?(memberId: string, expectedRevision: number): Promise<MemberResult>
  onClose(): void
}
export function MemberEditorPanel({ member, latest, pending, onSave, onDelete, onClose }: MemberEditorPanelProps) {
  const [form, setForm] = useState(() => initialForm(member))
  const [revision, setRevision] = useState(member?.profile.revision)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [request, setRequest] = useState('')
  const [assisting, setAssisting] = useState(false)
  const [notes, setNotes] = useState<Note[]>([{ id: 0, role: 'assistant', text: '用一句话告诉我这个助理负责什么，我先帮你把草稿填好；你也可以直接在下面填写。' }])
  const nextNote = useRef(1)
  const busy = pending || !!latest?.busy
  const stale = !!member && (!latest || latest.profile.revision !== revision)
  const latestForm = latest ? initialForm(latest) : null
  const differences = latestForm ? COMPARE_FIELDS.flatMap(([key, label]) => {
    const saved = displayDraftValue(key, latestForm[key]), draft = displayDraftValue(key, form[key])
    return saved === draft ? [] : [{ label, saved, draft }]
  }) : []
  const set = <K extends keyof DraftForm>(key: K, value: DraftForm[K]): void => { if (!busy) setForm(previous => ({ ...previous, [key]: value })) }
  const push = (role: Note['role'], value: string, isError = false): void => {
    setNotes(previous => [...previous, { id: nextNote.current++, role, text: value, error: isError }])
  }

  async function assist(): Promise<void> {
    const value = request.trim()
    if (!value || assisting || busy) return
    setRequest(''); setError(''); setNotice('')
    push('user', value)
    setAssisting(true)
    try {
      const result = await window.memberEditorApi.memberAssist({ request: value, current: formDraft(form, member) })
      if (!result.ok) { push('assistant', result.error.message, true); return }
      const data = result.data
      if (!data || !('draft' in data)) { push('assistant', '这次没有拿到可用的草稿，请换一种说法再试，或直接在下面填写。', true); return }
      setForm(fromDraft(data.draft))
      setNotice('已按你的描述填好草稿，请核对下面的内容；确认无误后再保存。')
      push('assistant', data.notes)
    } catch {
      push('assistant', '连不上主助理，这次没有生成草稿；可以稍后重试，或直接在下面填写。', true)
    } finally { setAssisting(false) }
  }

  async function save(): Promise<void> {
    if (busy || stale) return
    if (!validDraft(form)) {
      setError('请核对名称、成对填写的服务商/模型、整数额度和有效时区；阈值为 1–100%，最大输出为 1–131072。')
      return
    }
    setError(''); setNotice('')
    const result = await onSave(toDraft(form), member?.profile.assistantId ?? null, member ? revision : undefined)
    if (!result.ok) setError(result.error.message)
  }

  async function remove(): Promise<void> {
    if (busy || stale || !member || !onDelete) return
    setError(''); setNotice('')
    const result = await onDelete(member.profile.assistantId, revision ?? member.profile.revision)
    if (!result.ok) setError(result.error.message)
  }

  return <form className="editor-form" onSubmit={event => { event.preventDefault(); void save() }}>
    <header className="editor-hero">
      <div>
        <p className="editor-kicker">团队成员</p>
        <h1>{member ? `编辑 ${member.profile.displayName}` : '添加一个助理'}</h1>
        <p>说一句你希望它做什么，AI 先把草稿填好；所有改动都要你核对并确认后才会保存。</p>
      </div>
      {member && <span className="editor-badge">配置版本 {revision}</span>}
    </header>

    <section className="editor-card editor-ai" aria-label="用一句话生成草稿">
      <label className="editor-field">
        <span>你想要一个什么样的助理？</span>
        <textarea rows={2} maxLength={2000} value={request} disabled={assisting || busy}
          onChange={event => setRequest(event.target.value)} placeholder="例：每天帮我整理工作日报，语气简洁，只依据真实活动" />
      </label>
      <div className="editor-ai-actions">
        <div className="editor-examples">{EXAMPLES.map(example =>
          <button key={example} type="button" disabled={assisting || busy} onClick={() => setRequest(example)}>{example}</button>)}</div>
        <button type="button" className="editor-primary" disabled={assisting || busy || !request.trim()} onClick={() => void assist()}>
          {assisting ? '小潘正在想…' : '让 AI 帮我填'}
        </button>
      </div>
      <div className="editor-chat" role="log" aria-live="polite">
        {notes.map(note => <p key={note.id} data-role={note.role} className={note.error ? 'is-error' : undefined}>
          <strong>{note.role === 'user' ? '你' : '小潘'}</strong>{note.text}
        </p>)}
      </div>
      <p className="editor-hint">AI 只会填名称、职责、性格、工作要求和能力；模型、额度、时区仍按下面或主默认配置。</p>
    </section>

    {stale && <div className="editor-warning" role="alert">
      <div className="editor-conflict">
        <strong>这个成员刚在别处被改过，你的草稿仍在。</strong>
        {latest ? <>
          <p>最新配置是版本 {latest.profile.revision}。选择覆盖会用你的草稿替换下面所有不同字段；之后仍需保存并在原生窗口确认。</p>
          {differences.length ? <dl>{differences.map(item => <div key={item.label} className="editor-conflict-item">
            <dt>{item.label}</dt><dd><span>最新配置</span><pre>{item.saved}</pre><span>你的草稿</span><pre>{item.draft}</pre></dd>
          </div>)}</dl> : <p>当前可见字段相同，但版本已变化；请核对后继续。</p>}
          <button type="button" className="editor-secondary" disabled={busy} onClick={() => setRevision(latest.profile.revision)}>已核对差异，按草稿覆盖…</button>
        </> : <p>暂时读不到最新配置；请保留草稿，关闭并重新打开后核对。</p>}
      </div>
    </div>}

    <section className="editor-card" aria-label="身份与职责">
      <h2>它是谁</h2>
      <label className="editor-field">
        <span>名称</span>
        <input required maxLength={80} value={form.displayName} disabled={busy} onChange={event => set('displayName', event.target.value)} placeholder="例：日报助理" />
      </label>
      <label className="editor-field">
        <span>职责（总助理据此判断什么时候找它）</span>
        <textarea rows={2} maxLength={2000} value={form.description} disabled={busy} onChange={event => set('description', event.target.value)}
          placeholder="例：负责分析我的工作活动，整理日报草稿" />
      </label>
      <label className="editor-field">
        <span>性格与说话风格</span>
        <textarea rows={2} maxLength={2000} value={form.personality} disabled={busy} onChange={event => set('personality', event.target.value)}
          placeholder="例：简洁直接，先给结论；不夸张，不编造" />
      </label>
      <label className="editor-field">
        <span>工作要求（可选）</span>
        <textarea rows={3} maxLength={8000} value={form.persona} disabled={busy} onChange={event => set('persona', event.target.value)}
          placeholder="例：只依据可核验证据，拿不准就说明" />
      </label>
    </section>

    <section className="editor-card" aria-label="能力">
      <h2>它可以做什么</h2>
      <p className="editor-hint">不选也能创建：只有职责提示词的助理也可以工作。绑定能力后，相关消息和工具才会交给它。</p>
      <div className="editor-capabilities">
        {MEMBER_CAPABILITIES.map(capability => <label key={capability} className={form.capabilities.includes(capability) ? 'is-selected' : undefined}>
          <input type="checkbox" checked={form.capabilities.includes(capability)} disabled={busy}
            onChange={event => set('capabilities', event.target.checked ? [...form.capabilities, capability] : form.capabilities.filter(item => item !== capability))} />
          <strong>{MEMBER_CAPABILITY_LABELS[capability]}</strong>
          <span>{CAPABILITY_HINTS[capability]}</span>
        </label>)}
      </div>
    </section>

    <section className="editor-card" aria-label="成员类型与外部绑定">
      <h2>成员类型</h2>
      <p className="editor-hint">本机专家在本机运行并按权限使用本地工具；平台智能体与本地 AI 工具是子助理——持久独立会话、没有本地工具，越权任务会回退给总助理重新分析。</p>
      <div className="editor-permissions" role="radiogroup" aria-label="成员类型">
        {MEMBER_KINDS.map(kind => <label key={kind} className={form.kind === kind ? 'is-selected' : undefined}>
          <input type="radio" name="memberKind" value={kind} checked={form.kind === kind} disabled={busy}
            onChange={() => setForm(previous => ({ ...previous, kind }))} />
          <strong>{MEMBER_KIND_LABELS[kind].title}</strong>
          <span>{MEMBER_KIND_LABELS[kind].hint}</span>
        </label>)}
      </div>
      {form.kind === 'platform' && <div className="editor-grid">
        <label className="editor-field"><span>平台端点（OpenAI 兼容，https 或本机回环）</span>
          <input autoComplete="off" maxLength={2048} value={form.endpoint} disabled={busy} onChange={event => set('endpoint', event.target.value)}
            placeholder="例：https://api.platform-a.com/v1" /></label>
        <label className="editor-field"><span>平台模型名</span>
          <input autoComplete="off" maxLength={256} value={form.platformModel} disabled={busy} onChange={event => set('platformModel', event.target.value)}
            placeholder="例：agent-1" /></label>
        <label className="editor-field"><span>API 密钥{form.secretId ? '（已配置，留空＝沿用原密钥）' : '（未配置）'}</span>
          <input type="password" autoComplete="new-password" maxLength={4096} value={form.apiKey} disabled={busy}
            onChange={event => set('apiKey', event.target.value)} placeholder={form.secretId ? '留空保持不变' : '保存在本机加密存储，不会回显'} /></label>
      </div>}
      {form.kind === 'local-cli' && <div className="editor-grid">
        <label className="editor-field"><span>工具命令（绝对路径或命令名）</span>
          <input autoComplete="off" maxLength={2048} value={form.command} disabled={busy} onChange={event => set('command', event.target.value)}
            placeholder="例：/usr/local/bin/claude" /></label>
        <label className="editor-field"><span>启动参数（空格分隔）</span>
          <input autoComplete="off" maxLength={2048} value={form.argsText} disabled={busy} onChange={event => set('argsText', event.target.value)}
            placeholder="例：--print --output-format json" /></label>
      </div>}
      {form.kind !== 'expert' && <>
        <h2>汇报方式</h2>
        <div className="editor-permissions" role="radiogroup" aria-label="汇报方式">
          {SUB_ASSISTANT_REPORT_MODES.map(mode => <label key={mode} className={form.reportMode === mode ? 'is-selected' : undefined}>
            <input type="radio" name="reportMode" value={mode} checked={form.reportMode === mode} disabled={busy}
              onChange={() => set('reportMode', mode)} />
            <strong>{SUB_ASSISTANT_REPORT_LABELS[mode]}</strong>
            <span>{mode === 'chief' ? '结果由总助理汇总后播报；子助理不直接出声。' : `子助理直接以「${form.displayName.trim() || '该成员'}」的形象与音色播报；总助理同样收到完整结果。`}</span>
          </label>)}
        </div>
      </>}
    </section>

    <section className="editor-card" aria-label="权限">
      <h2>它可以自己动手吗</h2>
      <div className="editor-permissions" role="radiogroup" aria-label="权限">
        {MEMBER_PERMISSION_MODES.map(mode => <label key={mode} className={form.permissionMode === mode ? 'is-selected' : undefined}>
          <input type="radio" name="permissionMode" value={mode} checked={form.permissionMode === mode} disabled={busy}
            onChange={() => set('permissionMode', mode as MemberPermissionMode)} />
          <strong>{MEMBER_PERMISSION_LABELS[mode].title}</strong>
          <span>{MEMBER_PERMISSION_LABELS[mode].hint}</span>
        </label>)}
      </div>
    </section>

    <details className="editor-card editor-advanced">
      <summary>高级设置：模型、额度、形象</summary>
      <div className="editor-grid">
        <label className="editor-field"><span>形象</span>
          <select value={form.skinId} disabled={busy} onChange={event => set('skinId', event.target.value)}>
            {SKINS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            {!SKINS.some(([value]) => value === form.skinId) && <option value={form.skinId}>{form.skinId}</option>}
          </select>
        </label>
        <label className="editor-check"><input type="checkbox" checked={form.enabled} disabled={busy} onChange={event => set('enabled', event.target.checked)} />启用这个成员</label>
        <label className="editor-field"><span>模型服务商</span>
          <input autoComplete="off" maxLength={128} value={form.provider} disabled={busy} onChange={event => set('provider', event.target.value)} placeholder="留空用主默认" /></label>
        <label className="editor-field"><span>模型名称</span>
          <input autoComplete="off" maxLength={256} value={form.model} disabled={busy} onChange={event => set('model', event.target.value)} placeholder="留空用主默认" /></label>
        <label className="editor-field"><span>单次最大输出量</span>
          <input type="number" required min={1} max={131072} step={1} value={form.maxTokens} disabled={busy} onChange={event => set('maxTokens', event.target.value)} /></label>
        <label className="editor-field"><span>日额度</span>
          <input type="number" required min={0} step={1} value={form.dailyTokenLimit} disabled={busy} onChange={event => set('dailyTokenLimit', event.target.value)} /></label>
        <label className="editor-field"><span>总额度</span>
          <input type="number" required min={0} step={1} value={form.totalTokenLimit} disabled={busy} onChange={event => set('totalTokenLimit', event.target.value)} /></label>
        <label className="editor-field"><span>申请阈值（百分比）</span>
          <input type="number" required min={1} max={100} step={1} value={form.thresholdPercent} disabled={busy} onChange={event => set('thresholdPercent', event.target.value)} /></label>
        <label className="editor-field"><span>日计量时区</span>
          <input required maxLength={128} value={form.timezone} disabled={busy} onChange={event => set('timezone', event.target.value)} /></label>
      </div>
      <p className="editor-hint">服务商和模型同时留空＝跟随主默认；0 额度＝不限。软限额：按模型返回的用量加在途预留停线，单次请求仍可能超出上限，不是计费硬封顶；阈值只产生申请，不自动加额。</p>
    </details>

    {error && <p className="editor-error" role="alert">{error}</p>}
    {notice && <p className="editor-notice" role="status">{notice}</p>}
    {latest?.busy && <p className="editor-warning">成员正在工作，草稿会保留，结束后才能保存。</p>}
    <p className="editor-summary">类型：{MEMBER_KIND_LABELS[form.kind].title} · 权限：{MEMBER_PERMISSION_LABELS[form.permissionMode].title} · 日额度：{limitLabel(safeInteger(form.dailyTokenLimit, 0))} · 总额度：{limitLabel(safeInteger(form.totalTokenLimit, 0))}</p>
    <footer className="editor-actions">
      {member && onDelete && <button type="button" className="editor-danger" disabled={busy || stale} onClick={() => void remove()}>删除成员…</button>}
      <button type="button" className="editor-secondary" disabled={pending} onClick={onClose}>取消</button>
      <button type="submit" className="editor-primary" disabled={busy || stale}>{pending ? '等待原生确认或保存…' : member ? '核对并保存…' : '核对并创建…'}</button>
    </footer>
  </form>
}

export default function MemberEditorApp() {
  const [context, setContext] = useState<MemberEditorContext | null>(null)
  const [snapshot, setSnapshot] = useState<MemberSnapshot | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const active = useRef(false)
  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await window.memberEditorApi.membersState()
      if (!result.ok) { setError(result.error.message); return }
      if (!result.state) { setError('成员列表回包不完整，请关闭窗口后重试。'); return }
      setSnapshot(result.state); setError('')
    } catch { setError('成员服务未连接，请关闭窗口后重试。') }
  }, [])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const initial = await window.memberEditorApi.context()
        if (cancelled) return
        if (!initial) { setError('窗口上下文已失效，请从团队设置重新打开。'); return }
        setContext(initial)
        await load()
      } catch { if (!cancelled) setError('窗口上下文读取失败，请从团队设置重新打开。') }
      finally { if (!cancelled) setLoading(false) }
    })()
    const offContext = window.memberEditorApi.onContext(next => { setContext(next); void load() })
    const offChanged = window.memberEditorApi.onChanged(() => { void load() })
    return () => { cancelled = true; offContext(); offChanged() }
  }, [load])
  const member = context?.memberId ? snapshot?.members.find(item => item.profile.assistantId === context.memberId) ?? null : null
  const missing = !!context?.memberId && !!snapshot && !member
  async function remove(memberId: string, expectedRevision: number): Promise<MemberResult> {
    if (active.current) return { ok: false, error: { code: 'busy', message: '正在处理，请稍候。' } }
    active.current = true
    setPending(true)
    try {
      const result = await window.memberEditorApi.memberCommand('delete', { id: memberId, expectedRevision })
      if (result.ok) { await window.memberEditorApi.close(); return result }
      return result
    } catch {
      return { ok: false, error: { code: 'unavailable', message: '连接中断，结果可能未知；请关闭窗口后刷新团队列表核对，不会自动重发。' } }
    } finally { active.current = false; setPending(false) }
  }
  async function save(draft: MemberDraft, memberId: string | null, expectedRevision?: number): Promise<MemberResult> {
    if (active.current) return { ok: false, error: { code: 'busy', message: '正在处理，请稍候。' } }
    if (expectedRevision !== undefined && !memberId) return { ok: false, error: { code: 'conflict', message: '成员标识丢失，请关闭窗口后重新打开。' } }
    active.current = true
    setPending(true)
    try {
      const result = expectedRevision === undefined
        ? await window.memberEditorApi.memberCommand('create', draft)
        : await window.memberEditorApi.memberCommand('update', { id: memberId!, expectedRevision, ...draft })
      if (result.ok) { await window.memberEditorApi.close(); return result }
      return result
    } catch {
      return { ok: false, error: { code: 'unavailable', message: '连接中断，结果可能未知；请关闭窗口后刷新团队列表核对，不会自动重发。' } }
    } finally { active.current = false; setPending(false) }
  }
  if (loading) return <main className="editor-shell"><p className="editor-loading" role="status">正在读取成员配置…</p></main>
  if (!context || (error && !snapshot)) return <main className="editor-shell">
    <p className="editor-error" role="alert">{error || '窗口上下文已失效，请从团队设置重新打开。'}</p>
    <button type="button" className="editor-secondary" onClick={() => void window.memberEditorApi.close()}>关闭窗口</button>
  </main>
  if (missing) return <main className="editor-shell">
    <p className="editor-error" role="alert">这个成员可能已被删除，请关闭窗口后刷新团队列表。</p>
    <button type="button" className="editor-secondary" onClick={() => void window.memberEditorApi.close()}>关闭窗口</button>
  </main>
  return <main className="editor-shell">
    {error && <p className="editor-error" role="alert">{error}</p>}
    <MemberEditorPanel key={context.memberId ?? 'new'} member={member} latest={member ?? undefined}
      pending={pending} onSave={save} onDelete={member ? remove : undefined} onClose={() => void window.memberEditorApi.close()} />
  </main>
}
