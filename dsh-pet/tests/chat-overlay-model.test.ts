import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'
import { isValidElement, type ReactElement, type ReactNode } from 'react'

const source = readFileSync(new URL('../src/renderer/ChatOverlay.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ES2022 } }).outputText
const require = createRequire(import.meta.url)
const hooks = { memo: (value: unknown) => value, useEffect: () => {}, useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [value, () => {}] }
const module = { exports: {} as { default: (props: unknown) => ReactNode } }
new Function('require', 'module', 'exports', compiled)((name: string) => {
  if (name === 'react') return hooks
  if (name === './pet-metrics.js') return { PET_WIDTH: 150 }
  if (name === './stage-layout.js') return { registerPanelHitbox: () => {} }
  if (name === './session-view.js') return { entriesForPresentation: (entries: unknown[]) => ({ visible: entries, hidden: 0 }), overlayPosition: () => ({ x: 0, y: 0 }) }
  return require(name)
}, module, module.exports)

function find(node: ReactNode, label: string): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, label)).find(Boolean)
  if (!isValidElement<Record<string, unknown>>(node)) return undefined
  if (node.type === 'select' && node.props['aria-label'] === label) return node
  return find(node.props.children as ReactNode, label)
}

test('不支持会话模型切换时禁用选择并说明应去哪里修改', () => {
  const session = { sessionId: '测试', bindingId: 'test', cursor: 0, title: '', status: 'idle', entries: [], hasMore: false,
    model: { provider: '测试', model: '模型甲', label: '模型甲' }, models: [], permissions: [], permission: null,
    capabilities: { prompt: true, cancel: true, models: false, permissions: false, history: true } }
  const tree = module.exports.default({ session, error: '', stageRef: { current: null }, inputRef: { current: null }, input: '',
    setInput() {}, onSend() {}, onClose() {}, onCommand: async () => ({ ok: false }), onListen() {}, listening: false,
    sending: false, speaking: false, onStopSpeech() {}, loadingOlder: false, loadOlder: async () => {}, dock: 'top',
    size: { width: 400, height: 300 }, onResize() {} })
  const control = find(tree, '会话模型')
  assert.ok(control)
  assert.equal(control.props.disabled, true)
  assert.match(String(control.props.title), /不支持.*模型设置/u)
})
