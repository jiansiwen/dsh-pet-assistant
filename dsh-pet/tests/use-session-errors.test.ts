import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import type { SessionCommand, SessionResult, SessionSnapshot, SessionUpdate } from '../src/session-types.ts'

const source = readFileSync(new URL('../src/renderer/useSession.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

function snapshot(error: string, cursor = 1): SessionSnapshot {
  return { sessionId: '测试', bindingId: 'binding', cursor, title: '', status: 'idle', entries: [], hasMore: false,
    model: null, models: [], permissions: [], permission: null,
    capabilities: { prompt: true, cancel: true, models: false, permissions: false, history: true }, error }
}

function mount(result: Promise<SessionResult>, older?: Promise<SessionResult>, command?: Promise<SessionResult>) {
  const slots: unknown[] = []
  let cursor = 0, first = true
  let effect: (() => void | (() => void)) | undefined
  let onUpdate: ((value: SessionUpdate) => void) | undefined
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? (value as (previous: unknown) => unknown)(slots[index]) : value }]
    },
    useRef(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useCallback(value: unknown) { return value },
    useEffect(callback: () => void | (() => void)) { if (first) effect = callback },
  }
  const module = { exports: {} as { useSession(): { error: string; session: SessionSnapshot | null;
    adopt(state: SessionSnapshot): void; loadOlder(): Promise<void>; command(input: SessionCommand): Promise<SessionResult> } } }
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (name === 'react') return hooks
    if (name === './session-view.js') return { mergeEntries: (_a: unknown, b: unknown) => b, mergeSession: (_a: unknown, b: unknown) => b }
    throw new Error(`不应加载 ${name}`)
  }, module, module.exports)
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { petApi: {
    getSession: (...args: unknown[]) => args.length && older ? older : result,
    sessionCommand: () => command ?? Promise.resolve({ ok: true }),
    onSessionUpdate: (callback: typeof onUpdate) => { onUpdate = callback; return () => {} },
    onSessionConnection: () => () => {},
  } } })
  const render = () => { cursor = 0; const value = module.exports.useSession(); first = false; return value }
  render()
  const cleanup = effect?.()
  return { render, update: (value: SessionUpdate) => onUpdate!(value), dispose() {
    if (typeof cleanup === 'function') cleanup()
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  } }
}

test('初始会话快照中的模型目录错误显示给用户', async () => {
  const view = mount(Promise.resolve({ ok: true, state: snapshot('部分模型目录读取失败') }))
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.match(view.render().error, /模型目录读取失败/u)
  } finally { view.dispose() }
})

test('迟到的旧快照不能清掉较新会话事件中的错误', async () => {
  let resolve!: (value: SessionResult) => void
  const view = mount(new Promise(value => { resolve = value }))
  try {
    view.update(snapshot('较新的模型目录错误', 2))
    resolve({ ok: true, state: snapshot('旧快照错误', 1) })
    await new Promise<void>(done => setImmediate(done))
    const state = view.render()
    assert.equal(state.error, '较新的模型目录错误')
    assert.equal(state.session?.cursor, 2)
  } finally { view.dispose() }
})

test('迟到的旧请求失败不能覆盖较新会话事件中的错误', async () => {
  let resolve!: (value: SessionResult) => void
  const view = mount(new Promise(value => { resolve = value }))
  try {
    view.update(snapshot('较新的模型目录错误', 2))
    resolve({ ok: false, error: '旧请求失败' })
    await new Promise<void>(done => setImmediate(done))
    assert.equal(view.render().error, '较新的模型目录错误')
  } finally { view.dispose() }
})

test('迟到的旧请求异常不能覆盖较新会话事件中的错误', async () => {
  let reject!: (reason: Error) => void
  const view = mount(new Promise((_resolve, fail) => { reject = fail }))
  try {
    view.update(snapshot('较新的模型目录错误', 2))
    reject(new Error('旧连接异常'))
    await new Promise<void>(done => setImmediate(done))
    assert.equal(view.render().error, '较新的模型目录错误')
  } finally { view.dispose() }
})

test('新绑定快照中的模型目录错误不会被清空', async () => {
  const view = mount(new Promise(() => {}))
  try {
    view.render().adopt(snapshot('新绑定模型目录读取失败'))
    assert.match(view.render().error, /模型目录读取失败/u)
  } finally { view.dispose() }
})

for (const mode of ['success', 'failure', 'exception'] as const) {
  test(`换绑后迟到的旧历史${mode === 'success' ? '成功回包' : mode === 'failure' ? '失败回包' : '异常'}不能覆盖新会话`, async () => {
    let resolve!: (value: SessionResult) => void
    let reject!: (reason: Error) => void
    const older = new Promise<SessionResult>((yes, no) => { resolve = yes; reject = no })
    const initial = { ...snapshot('旧会话', 1), hasMore: true, beforeSeq: 5 }
    const view = mount(Promise.resolve({ ok: true, state: initial }), older)
    try {
      await new Promise<void>(done => setImmediate(done))
      const loading = view.render().loadOlder()
      view.update({ ...snapshot('新会话错误', 1), bindingId: 'new-binding' })
      if (mode === 'success') resolve({ ok: true, state: snapshot('旧历史内容', 1) })
      else if (mode === 'failure') resolve({ ok: false, error: '旧历史失败' })
      else reject(new Error('旧历史异常'))
      await loading
      assert.equal(view.render().error, '新会话错误')
      assert.equal(view.render().session?.bindingId, 'new-binding')
    } finally { view.dispose() }
  })
}

for (const mode of ['success', 'failure', 'exception'] as const) {
  test(`换绑后旧命令的${mode === 'success' ? '成功回包' : mode === 'failure' ? '失败回包' : '异常'}不能污染新会话`, async () => {
    let resolve!: (value: SessionResult) => void
    let reject!: (reason: Error) => void
    const pending = new Promise<SessionResult>((yes, no) => { resolve = yes; reject = no })
    const view = mount(Promise.resolve({ ok: true, state: snapshot('旧会话', 1) }), undefined, pending)
    try {
      await new Promise<void>(done => setImmediate(done))
      const request = view.render().command({ kind: 'permission', bindingId: 'binding', value: 'full' })
      // 模拟新事件已到达但 React 尚未再次渲染。
      view.update({ ...snapshot('新会话错误', 1), bindingId: 'new-binding' })
      if (mode === 'success') resolve({ ok: true, state: snapshot('旧会话回包', 2) })
      else if (mode === 'failure') resolve({ ok: false, error: '旧命令失败' })
      else reject(new Error('旧命令异常'))
      const result = await request
      assert.equal(result.ok, false)
      assert.match(result.error ?? '', /会话已改变/u)
      const state = view.render()
      assert.equal(state.error, '新会话错误')
      assert.equal(state.session?.bindingId, 'new-binding')
    } finally { view.dispose() }
  })
}
