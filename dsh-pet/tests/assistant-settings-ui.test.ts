import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import type { AssistantSettingsPage, AssistantSettingsResult, AssistantSettingsSection, AssistantSettingsSnapshot } from '../src/assistant-settings-types.ts'

// 仅在内存转译组件，不写构建产物；模拟钩子驱动事件，真实浏览器布局由真机验收。
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/renderer/AssistantSettings.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
})
const require = createRequire(import.meta.url)
type Element = ReactElement<Record<string, unknown>>
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}
function content(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(content).join('')
  if (isValidElement<Record<string, unknown>>(node)) return content(node.props.children as ReactNode)
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}
function snapshot(): AssistantSettingsSnapshot {
  return {
    revision: 4,
    wecom: { enabled: true, botId: 'bot-1', secretConfigured: true, connected: true, allowedUserIds: ['user-1'], deliverHere: ['chat-1'] },
    reminder: { repeatEverySeconds: 300 },
    agent: { name: '小潘', persona: '协助工作', provider: '', model: '', maxTokens: 2048, tokenBudget: 0 },
    defaultModel: { provider: '真实服务商', model: '真实默认模型' },
  }
}
function mount(section: AssistantSettingsPage, initial: AssistantSettingsResult = { ok: true, state: snapshot() }) {
  const slots: unknown[] = []
  let cursor = 0
  let effects: Array<() => unknown> = []
  const cleanups: Array<() => void> = []
  let tree: ReactNode
  let reads = 0
  let opened = 0
  let readReply = initial
  let saveReply: () => Promise<AssistantSettingsResult> = async () => ({ ok: true, state: { ...snapshot(), revision: 5 } })
  const writes: Array<{ section: AssistantSettingsSection; input: unknown }> = []
  function memo<T>(value: T, deps: unknown[]): T {
    const index = cursor++
    const old = slots[index] as { value: T; deps: unknown[] } | undefined
    if (!old || deps.some((dep, i) => dep !== old.deps[i])) slots[index] = { value, deps }
    return (slots[index] as { value: T }).value
  }
  const hooks = {
    useState<T>(initialValue: T | (() => T)) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue
      return [slots[index], (value: T | ((previous: T) => T)) => {
        slots[index] = typeof value === 'function' ? (value as (previous: T) => T)(slots[index] as T) : value
      }]
    },
    useRef<T>(value: T) { return memo({ current: value }, []) },
    useCallback: memo,
    useEffect(callback: () => void | (() => void), deps: unknown[]) {
      const marker = {}
      if (memo(marker, deps) === marker) effects.push(() => {
        const cleanup = callback()
        if (cleanup) cleanups.push(cleanup)
      })
    },
  }
  const module = { exports: {} as { default: (props: { section: AssistantSettingsPage }) => ReactNode } }
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (name: string) => name === 'react' ? hooks : require(name), module, module.exports,
  )
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { petApi: {
    assistantSettingsState: async () => { reads++; return readReply },
    assistantSettingsSave: async (target: AssistantSettingsSection, input: unknown) => { writes.push({ section: target, input }); return saveReply() },
    openCompanionTasks: async () => { opened++; return { ok: true } },
  } } })
  function render() {
    cursor = 0
    tree = module.exports.default({ section })
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
  }
  render()
  return {
    writes,
    get reads() { return reads },
    get opened() { return opened },
    get text() { return content(tree) },
    get fieldsDisabled() { return elements(tree).find(node => node.type === 'fieldset')?.props.disabled },
    set readReply(value: AssistantSettingsResult) { readReply = value },
    set saveReply(value: () => Promise<AssistantSettingsResult>) { saveReply = value },
    async flush() { await new Promise<void>(resolve => setImmediate(resolve)); render() },
    field(label: string) {
      const parent = elements(tree).find(node => node.type === 'label' && content(node).includes(label))
      assert.ok(parent, `未找到字段：${label}`)
      const input = elements(parent).find(node => node.type === 'input' || node.type === 'textarea')
      assert.ok(input)
      return input
    },
    change(label: string, value: string | boolean) {
      const input = this.field(label)
      ;(input.props.onChange as (event: unknown) => void)({ target: { value, checked: value } })
      render()
    },
    click(label: string) {
      const button = elements(tree).find(node => node.type === 'button' && content(node) === label)
      assert.ok(button, `未找到按钮：${label}`)
      ;(button.props.onClick as () => void)()
      render()
    },
    submit() {
      const form = elements(tree).find(node => node.type === 'form')
      assert.ok(form)
      ;(form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} })
      render()
    },
    dispose() {
      cleanups.forEach(cleanup => cleanup())
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    },
  }
}

test('三个页面读取失败可刷新恢复，未读取时不能保存', async () => {
  for (const section of ['wecom', 'reminders', 'agent'] as const) {
    const view = mount(section, { ok: false, message: '服务离线，请刷新' })
    try {
      await view.flush()
      assert.match(view.text, /服务离线.*刷新/)
      assert.match(view.text, /尚未取得配置，不能编辑/)
      assert.equal(view.writes.length, 0)
      view.readReply = { ok: true, state: snapshot() }
      view.click('刷新配置')
      await view.flush()
      assert.equal(view.reads, 2)
      assert.equal(view.fieldsDisabled, false)
    } finally { view.dispose() }
  }
})

test('渠道空密钥省略、保存禁重复、成功清空密码，列表只读', async () => {
  const view = mount('wecom')
  try {
    await view.flush()
    assert.equal(view.field('密钥（Secret）').props.type, 'password')
    assert.equal(view.field('密钥（Secret）').props.value, '')
    assert.match(view.text, /已配对用户（只读）user-1/)
    assert.match(view.text, /提醒会话（只读）chat-1/)
    view.submit()
    view.submit()
    assert.equal(view.writes.length, 1)
    assert.deepEqual(view.writes[0], { section: 'wecom', input: { expectedRevision: 4, enabled: true, botId: 'bot-1' } })
    assert.equal(view.fieldsDisabled, true)
    await view.flush()
    view.change('密钥（Secret）', '本次测试密钥')
    let resolve!: (value: AssistantSettingsResult) => void
    view.saveReply = () => new Promise(done => { resolve = done })
    view.submit()
    assert.equal(view.field('密钥（Secret）').props.value, '本次测试密钥')
    resolve({ ok: true, state: { ...snapshot(), revision: 6 } })
    await view.flush()
    assert.equal(view.field('密钥（Secret）').props.value, '')
    view.click('重新连接')
    assert.deepEqual(view.writes.at(-1), { section: 'wecom/reconnect', input: { expectedRevision: 6 } })
    resolve({ ok: true, state: snapshot() })
    await view.flush()
  } finally { view.dispose() }
})

test('版本冲突保留密钥且阻止重发，刷新成功后才能再保存', async () => {
  const view = mount('wecom')
  try {
    await view.flush()
    view.change('密钥（Secret）', '保留待提交密钥')
    view.saveReply = async () => ({ ok: false, error: 'conflict' })
    view.submit()
    await view.flush()
    assert.match(view.text, /版本已变化.*刷新配置/)
    assert.equal(view.field('密钥（Secret）').props.value, '保留待提交密钥')
    assert.equal(view.fieldsDisabled, true)
    view.submit()
    assert.equal(view.writes.length, 1)
    view.readReply = { ok: true, state: { ...snapshot(), revision: 12 } }
    view.click('刷新配置')
    await view.flush()
    view.saveReply = async () => ({ ok: true, state: snapshot() })
    view.submit()
    assert.equal((view.writes.at(-1)!.input as { expectedRevision: number }).expectedRevision, 12)
    await view.flush()
    assert.equal(view.field('密钥（Secret）').props.value, '')
  } finally { view.dispose() }
})

test('提醒用分钟编辑，校验整数秒并打开已有任务窗口', async () => {
  const view = mount('reminders')
  try {
    await view.flush()
    assert.equal(view.field('默认催办间隔').props.value, '5')
    assert.match(view.text, /只影响以后新建提醒.*旧任务可在“任务与提醒”内单独修改/)
    view.change('默认催办间隔', '1.001')
    view.submit()
    assert.equal(view.writes.length, 0)
    assert.match(view.text, /秒数必须是整数/)
    view.change('默认催办间隔', '1.5')
    view.submit()
    assert.deepEqual(view.writes[0], { section: 'reminders', input: { expectedRevision: 4, repeatEverySeconds: 90 } })
    await view.flush()
    view.click('打开任务与提醒')
    await view.flush()
    assert.equal(view.opened, 1)
  } finally { view.dispose() }
})

test('独立智能体展示真实宿主默认与预算边界，空模型原样提交', async () => {
  const view = mount('agent')
  try {
    await view.flush()
    assert.match(view.text, /企业微信独立智能体/)
    assert.match(view.text, /与桌面主会话隔离/)
    assert.match(view.text, /下一条消息生效/)
    assert.match(view.text, /配置不会放开敏感操作/)
    assert.match(view.text, /真实服务商.*真实默认模型/)
    assert.match(view.text, /0 表示不限.*达到停线后停止本轮后续请求.*不是计费硬封顶/)
    view.change('单次最大输出', '0')
    view.submit()
    assert.equal(view.writes.length, 0)
    view.change('单次最大输出', '1024')
    view.change('模型服务商', '仅填服务商')
    view.submit()
    assert.equal(view.writes.length, 0)
    assert.match(view.text, /服务商和模型须同时填写/)
    view.change('模型服务商', '')
    view.change('每轮 token', '0')
    view.submit()
    assert.deepEqual(view.writes[0], { section: 'agent', input: { expectedRevision: 4, ...snapshot().agent, maxTokens: 1024 } })
    await view.flush()
    assert.match(view.text, /已保存，下一条企业微信消息生效/)
  } finally { view.dispose() }
})
