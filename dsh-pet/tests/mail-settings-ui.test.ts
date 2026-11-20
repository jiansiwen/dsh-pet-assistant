import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'
import { isValidElement, type ReactElement, type ReactNode } from 'react'

/**
 * 邮件页渲染测试：真实组件源码 transpile 后跑，hooks 用最小实现。
 *
 * 重点不是像素，而是三条容易悄悄坏掉的约定：
 * 1. 读回的配置必须回填到表单（否则用户一点保存就把已有配置清空）；
 * 2. 授权码输入框留空时，保存体里不能出现 password 键（否则会用空串覆盖已存授权码）；
 * 3. 值守建议必须标明"只是建议"的语境，风险与类型用中文标签。
 */
const source = readFileSync(new URL('../src/renderer/MailSettings.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
const require = createRequire(import.meta.url)
type Element = ReactElement<Record<string, unknown>>

function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node as Element, ...elements(node.props.children as ReactNode)]
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('')
  if (isValidElement<Record<string, unknown>>(node)) return text(node.props.children as ReactNode)
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}

const mailView = {
  address: 'me@example.com', smtpHost: 'smtp.example.com', smtpPort: 465,
  imapHost: 'imap.example.com', imapPort: 993, hasPassword: true, watchEnabled: true, watchIntervalSeconds: 600,
}
const analyses = [{
  analysisId: 'a1', memberId: '成员甲', uids: [10, 11], result: '有两封邮件需要你确认', createdAt: Date.now(), notifiedAt: null,
  suggestions: [{ uid: 10, kind: 'reply-mail', title: '回复客户', payload: '您好，已收到。', risk: 'low', rationale: '客户在等回复' }],
}]

function mount(options: { mail?: unknown; analyses?: unknown; save?: unknown } = {}) {
  const state = {
    mail: options.mail ?? { ok: true, mail: mailView },
    list: options.analyses ?? { ok: true, analyses },
    save: options.save ?? { ok: true, mail: mailView, message: '邮箱配置已保存。' },
  }
  const saveCalls: Array<Record<string, unknown>> = []
  const slots: unknown[] = []
  const callbackSlots: Array<{ deps?: unknown[]; fn: unknown }> = []
  const effectSlots: Array<{ deps?: unknown[]; fn: () => void | (() => void) }> = []
  const committed: Array<{ deps?: unknown[]; cleanup?: void | (() => void) }> = []
  let cursor = 0
  let callbackCursor = 0
  let effectCursor = 0
  let tree: ReactNode
  const sameDeps = (left?: unknown[], right?: unknown[]): boolean =>
    left !== undefined && right !== undefined && left.length === right.length && left.every((item, index) => Object.is(item, right[index]))
  const hooks = {
    useState<T>(value: T | (() => T)) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof value === 'function' ? (value as () => T)() : value
      return [slots[index], (next: T | ((previous: T) => T)) => {
        slots[index] = typeof next === 'function' ? (next as (previous: T) => T)(slots[index] as T) : next
      }]
    },
    useRef<T>(value: T) { const index = cursor++; if (!(index in slots)) slots[index] = { current: value }; return slots[index] },
    useCallback<T>(fn: T, deps?: unknown[]) {
      const index = callbackCursor++
      const previous = callbackSlots[index]
      if (previous && sameDeps(previous.deps, deps)) return previous.fn as T
      callbackSlots[index] = { deps: deps ? [...deps] : undefined, fn }
      return fn
    },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) {
      const index = effectCursor++
      effectSlots[index] = { deps: deps ? [...deps] : undefined, fn }
    },
  }
  const module = { exports: {} as { default: () => ReactNode } }
  new Function('require', 'module', 'exports', compiled)((name: string) =>
    name === 'react' ? hooks : require(name), module, module.exports)
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { petApi: {
    assistantMailState: async () => state.mail,
    assistantMailAnalyses: async () => state.list,
    assistantMailSave: async (input: Record<string, unknown>) => { saveCalls.push(input); return state.save },
  } } })
  function render() {
    cursor = 0
    callbackCursor = 0
    effectCursor = 0
    tree = module.exports.default()
  }
  function commit() {
    for (const [index, effect] of effectSlots.entries()) {
      const previous = committed[index]
      if (previous && sameDeps(previous.deps, effect.deps)) continue
      previous?.cleanup?.()
      committed[index] = { deps: effect.deps, cleanup: effect.fn() }
    }
  }
  async function flush() {
    await new Promise<void>(resolve => setImmediate(resolve))
    render()
    commit()
  }
  render()
  commit()
  return {
    get text() { return text(tree) },
    saveCalls,
    textOf(node: ReactNode) { return text(node) },
    field(label: string) {
      const parent = elements(tree).find(node => node.type === 'label' && text(node).includes(label))
      assert.ok(parent, `字段缺失：${label}`)
      const field = elements(parent).find(node => node.type === 'input')
      assert.ok(field, `输入框缺失：${label}`)
      return field
    },
    change(label: string, value: string) {
      (this.field(label).props.onChange as (event: unknown) => void)({ target: { value } })
      render()
      commit()
    },
    submit() {
      const form = elements(tree).find(node => node.type === 'form')
      assert.ok(form, '表单缺失')
      ;(form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} })
    },
    flush,
    dispose() { if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window') },
  }
}

test('读取配置后回填表单，并显示值守状态', async () => {
  const view = mount()
  try {
    await view.flush()
    assert.equal(view.field('邮箱地址').props.value, 'me@example.com')
    assert.equal(view.field('SMTP 主机（发信）').props.value, 'smtp.example.com')
    assert.equal(view.field('SMTP 端口').props.value, '465')
    assert.equal(view.field('IMAP 端口').props.value, '993')
    assert.equal(view.field('授权码').props.value, '', '授权码永不回显')
    assert.match(String(view.field('授权码').props.placeholder), /已配置，留空保持不变/u)
    assert.match(view.text, /值守中（每 10 分钟查看未读）/u)
  } finally { view.dispose() }
})

test('保存时授权码留空则不带该字段；成功后清空并提示', async () => {
  const view = mount()
  try {
    await view.flush()
    view.change('邮箱地址', 'new@example.com')
    view.submit()
    await view.flush()
    assert.equal(view.saveCalls.length, 1)
    assert.equal(view.saveCalls[0]!.address, 'new@example.com')
    assert.equal(view.saveCalls[0]!.smtpPort, 465)
    assert.equal('password' in view.saveCalls[0]!, false, '留空不能带 password 键')
    assert.match(view.text, /邮箱配置已保存/u)
  } finally { view.dispose() }
})

test('填写授权码后保存会随请求上桥，但页面不回显', async () => {
  const view = mount()
  try {
    await view.flush()
    view.change('授权码', '新的授权码')
    view.submit()
    await view.flush()
    assert.equal(view.saveCalls[0]!.password, '新的授权码')
    assert.equal(view.field('授权码').props.value, '', '保存成功后清空输入框')
  } finally { view.dispose() }
})

test('值守列表展示摘要、建议中文标签与风险；并说明只是建议', async () => {
  const view = mount()
  try {
    await view.flush()
    assert.match(view.text, /有两封邮件需要你确认/u)
    assert.match(view.text, /回复邮件/u)
    assert.match(view.text, /回复客户/u)
    assert.match(view.text, /低风险/u)
    assert.match(view.text, /值守结果只是建议/u)
  } finally { view.dispose() }
})

test('未配置时提示还没有分析，并说明值守不会自动执行', async () => {
  const view = mount({ mail: { ok: true, mail: null }, analyses: { ok: true, analyses: [] } })
  try {
    await view.flush()
    assert.match(view.text, /值守未开启|还没有值守分析/u)
    assert.match(view.text, /不会自动执行任何动作/u)
  } finally { view.dispose() }
})

test('服务端拒绝时显示具体原因，不显示保存成功', async () => {
  const view = mount({ save: { ok: false, error: 'invalid_input', message: '邮箱地址格式不对，要像 name@example.com' } })
  try {
    await view.flush()
    view.submit()
    await view.flush()
    assert.match(view.text, /邮箱地址格式不对/u)
    assert.equal(view.text.includes('邮箱配置已保存'), false)
  } finally { view.dispose() }
})