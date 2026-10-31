import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import * as contract from '../src/member-types.ts'
import type { MemberDraft, MemberResult, MemberView } from '../src/member-types.ts'

const source = readFileSync(new URL('../src/renderer/MemberEditor.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
const require = createRequire(import.meta.url)
type Element = ReactElement<Record<string, unknown>>
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('')
  if (isValidElement<Record<string, unknown>>(node)) return text(node.props.children as ReactNode)
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}
function member(revision = 3): MemberView {
  return { profile: { assistantId: '成员甲', displayName: '研究员甲', personality: '', permissionMode: 'ask', description: '通用研究', persona: '按证据回答',
    roleId: 'wukong', skinId: 'panda', voiceProfile: '', toolPolicy: { mode: 'read-only', denyTools: [] }, enabled: true, revision, sessionId: '独立会话甲', provider: '', model: '',
    maxTokens: 2048, capabilities: [], allowedTools: [], dailyTokenLimit: 1000, totalTokenLimit: 5000, thresholdPercent: 80, timezone: 'Asia/Shanghai' },
    quota: { day: '2026-10-28', dailyUsed: 900, totalUsed: 4000, dailyReserved: 0, totalReserved: 0, dailyTokenLimit: 1000, totalTokenLimit: 5000, thresholdPercent: 80, unknown: false, blocked: false, revision: 9 }, busy: false }
}
const baseDraft: MemberDraft = { displayName: '日报助理', description: '整理日报', personality: '简洁直接', permissionMode: 'ask', persona: '只依据证据', skinId: 'panda',
  enabled: true, provider: '', model: '', maxTokens: 2048, capabilities: ['activity'], allowedTools: [], dailyTokenLimit: 0, totalTokenLimit: 0, thresholdPercent: 80, timezone: 'Asia/Shanghai' }
function mount(initial: MemberView | null, latest = initial ?? undefined) {
  const slots: unknown[] = []
  let cursor = 0
  let tree: ReactNode
  let assistResult: MemberResult = { ok: true, data: { draft: baseDraft, notes: '已设为每次询问' } }
  const saved: Array<{ draft: MemberDraft; memberId: string | null; expectedRevision?: number }> = []
  const deletes: Array<{ memberId: string; expectedRevision: number }> = []
  const closed: boolean[] = []
  const hooks = {
    useState<T>(value: T | (() => T)) { const index = cursor++; if (!(index in slots)) slots[index] = typeof value === 'function' ? (value as () => T)() : value; return [slots[index], (next: T | ((previous: T) => T)) => { slots[index] = typeof next === 'function' ? (next as (previous: T) => T)(slots[index] as T) : next }] },
    useRef<T>(value: T) { const index = cursor++; if (!(index in slots)) slots[index] = { current: value }; return slots[index] },
    useCallback<T>(value: T) { return value },
    useEffect() {},
  }
  const module = { exports: {} as { MemberEditorPanel: (props: Record<string, unknown>) => ReactNode; default: () => ReactNode } }
  new Function('require', 'module', 'exports', compiled)((name: string) => name === 'react' ? hooks : name === '../member-types.ts' ? contract : require(name), module, module.exports)
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { memberEditorApi: {
    memberAssist: async () => assistResult,
  } } })
  function render() {
    cursor = 0
    tree = module.exports.MemberEditorPanel({ member: initial, latest, pending: false,
      onSave: async (draft: MemberDraft, memberId: string | null, expectedRevision?: number) => { saved.push({ draft: structuredClone(draft), memberId, expectedRevision }); return { ok: true } },
      onDelete: async (memberId: string, expectedRevision: number) => { deletes.push({ memberId, expectedRevision }); return { ok: true } },
      onClose: () => { closed.push(true) } })
  }
  render()
  function button(label: string) { const found = elements(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(found, `按钮缺失：${label}`); return found }
  return {
    saved, deletes, closed,
    get text() { return text(tree) },
    field(label: string) {
      const parent = elements(tree).find(node => node.type === 'label' && text(node).includes(label))
      assert.ok(parent, `字段缺失：${label}`)
      const field = elements(parent).find(node => ['input', 'textarea', 'select'].includes(node.type as string))
      assert.ok(field); return field
    },
    change(label: string, value: string | boolean) { (this.field(label).props.onChange as (event: unknown) => void)({ target: { value, checked: value } }); render() },
    click(label: string) { (button(label).props.onClick as () => void)(); render() },
    choose(label: string, value: string) {
      const parent = elements(tree).find(node => node.type === 'label' && text(node).includes(label) && node.props.children)
      const input = parent && elements(parent).find(node => node.type === 'input' && node.props.value === value)
      assert.ok(input, `单选项缺失：${label}/${value}`); (input.props.onChange as () => void)(); render()
    },
    submit() { const form = elements(tree).find(node => node.type === 'form'); assert.ok(form); (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} }); render() },
    set assist(value: MemberResult) { assistResult = value },
    async flush() { await new Promise<void>(resolve => setImmediate(resolve)); render() },
    dispose() { if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window') },
  }
}

test('一句话生成草稿：AI 只填人看得懂的字段，保存体不携带工具白名单', async () => {
  const view = mount(null)
  try {
    view.change('你想要一个什么样的助理', '每天帮我整理日报')
    view.click('让 AI 帮我填')
    await view.flush()
    assert.equal(view.field('名称').props.value, '日报助理')
    assert.equal(view.field('职责（总助理据此判断什么时候找它）').props.value, '整理日报')
    assert.equal(view.field('性格与说话风格').props.value, '简洁直接')
    assert.match(view.text, /已按你的描述填好草稿/)
    assert.match(view.text, /已设为每次询问/)
    view.submit()
    await view.flush()
    assert.equal(view.saved.length, 1)
    assert.deepEqual(view.saved[0]!.draft.capabilities, ['activity'])
    assert.deepEqual(view.saved[0]!.draft.allowedTools, [])
    assert.equal(view.saved[0]!.draft.displayName, '日报助理')
    assert.equal(view.saved[0]!.memberId, null)
    assert.equal(view.saved[0]!.expectedRevision, undefined)
  } finally { view.dispose() }
})

test('权限三档可选，模型成对填写；忙碌时冻结草稿', async () => {
  const view = mount(member())
  try {
    view.choose('自动审批', 'auto')
    assert.match(view.text, /不再逐次询问/)
    view.change('模型服务商', '服务商甲')
    view.submit()
    assert.equal(view.saved.length, 0)
    assert.match(view.text, /成对填写/)
    view.change('模型名称', '模型甲')
    view.submit()
    await view.flush()
    assert.equal(view.saved[0]!.draft.permissionMode, 'auto')
    assert.equal(view.saved[0]!.memberId, '成员甲')
    assert.equal(view.saved[0]!.expectedRevision, 3)
    assert.equal(view.saved[0]!.draft.model, '模型甲')
  } finally { view.dispose() }
  const busy = member(); busy.busy = true
  const frozen = mount(busy)
  try {
    assert.equal(frozen.field('职责（总助理据此判断什么时候找它）').props.disabled, true)
    assert.equal((elements(frozen.field('职责（总助理据此判断什么时候找它）')).length > 0), true)
    assert.match(frozen.text, /成员正在工作.*结束后才能保存/s)
  } finally { frozen.dispose() }
})

test('编辑窗口也能删除成员，按当前配置版本提交', async () => {
  const view = mount(member())
  try {
    view.click('删除成员…')
    await view.flush()
    assert.deepEqual(view.deletes, [{ memberId: '成员甲', expectedRevision: 3 }])
  } finally { view.dispose() }
})

test('外部版本变化不覆盖草稿，确认后才能按新版本保存', async () => {
  const initial = member(3)
  const latest = member(4); latest.profile.description = '外部改动'
  const view = mount(initial, latest)
  try {
    view.change('职责（总助理据此判断什么时候找它）', '未保存的草稿')
    view.submit()
    assert.equal(view.saved.length, 0)
    assert.match(view.text, /刚在别处被改过/)
    view.click('采用最新版本')
    view.submit()
    await view.flush()
    assert.equal(view.saved[0]!.expectedRevision, 4)
    assert.equal(view.saved[0]!.draft.description, '未保存的草稿')
  } finally { view.dispose() }
})
