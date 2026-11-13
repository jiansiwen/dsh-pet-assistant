/**
 * 停靠态渲染体的形状。
 *
 * 为什么这条必须有测试：用户真机报障的原话是"我的宠物形象去哪了"——旧版本只画了一个
 * 48×48 的圆加中间一个状态点，**认不出是宠物**。这类问题在纯逻辑测试里完全看不见
 * （`dockStatusTone` 全绿、`dockPosition` 全绿，用户还是找不到宠物），
 * 所以必须直接断言"渲染结果里有形象元素"。
 *
 * 做法：用 esbuild 在内存里转译组件（不写构建产物），把 `./usePetImage.js` 换成桩，
 * 于是"有素材 / 没素材"两种分支都能在 Node 里跑到。
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'
import { isValidElement, type ReactElement, type ReactNode } from 'react'

/** 换掉素材加载与命中盒两块：前者造"有/无素材"两态，后者记录注册了什么。 */
const stubModules = {
  name: 'stub-docked-deps',
  setup(context: {
    onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; namespace: string }): void
    onLoad(options: { filter: RegExp; namespace: string }, callback: () => { contents: string; loader: 'js' }): void
  }) {
    context.onResolve({ filter: /usePetImage/ }, () => ({ path: 'img', namespace: 'stub' }))
    context.onResolve({ filter: /stage-layout/ }, () => ({ path: 'layout', namespace: 'stub' }))
    context.onLoad({ filter: /^img$/, namespace: 'stub' }, () => ({
      contents: `export function usePetSkinImages(skin) {
        return skin === 'broken' ? {} : { idle: '/assets/pets/' + skin + '.png' }
      }`,
      loader: 'js',
    }))
    // 记录注册/注销：命中盒是"能不能点"的唯一闸，没有它整层窗口是鼠标穿透的。
    context.onLoad({ filter: /^layout$/, namespace: 'stub' }, () => ({
      contents: `
        const boxes = (globalThis.__hitboxes ??= new Map())
        export function registerCharacterHitbox(key, box) { boxes.set(key, box) }
        export function unregisterCharacterHitbox(key) { boxes.delete(key) }
      `,
      loader: 'js',
    }))
  },
}

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/renderer/DockedPet.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  plugins: [stubModules],
})

const require = createRequire(import.meta.url)
type Element = ReactElement<Record<string, unknown>>

/**
 * 展开元素树。
 *
 * 要**下钻函数组件**（`PetSilhouette` 就是普通函数组件）：只收集 `isValidElement` 的话，
 * 剪影那一层只会看到一个 `type: fn` 的空壳，断言"有没有剪影"就永远是 false——
 * 测试会红，但红的原因跟产品无关。所以这里对无状态子组件直接调用求值。
 */
function elements(node: ReactNode, depth = 0): Element[] {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, depth))
  if (!isValidElement<Record<string, unknown>>(node) || depth > 8) return []
  if (typeof node.type === 'function') {
    const rendered = (node.type as (props: unknown) => ReactNode)(node.props)
    return elements(rendered, depth + 1)
  }
  return [node as Element, ...elements(node.props.children as ReactNode, depth)]
}
function content(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(content).join('')
  if (isValidElement<Record<string, unknown>>(node)) return content(node.props.children as ReactNode)
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}

interface DockedPetProps {
  left: number
  top: number
  tone: string
  skin: string
  onRestore(): void
  onContextMenu(event: unknown): void
}

function mount(props: Partial<DockedPetProps> = {}) {
  let restored = 0
  /** 组件挂载后的清理函数（useLayoutEffect 的返回值），用来验"卸载时注销命中盒"。 */
  const cleanups: Array<() => void> = []
  const hooks = {
    useRef<T>(value: T) { return { current: value } },
    useState<T>(value: T) { return [value, () => undefined] as [T, (next: T) => void] },
    useEffect() { /* DockedPet 自身没有副作用；素材加载被桩掉了 */ },
    useLayoutEffect(effect: () => void | (() => void)) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }
  const module = { exports: {} as { default: (props: DockedPetProps) => ReactNode } }
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (name: string) => name === 'react' ? hooks : require(name), module, module.exports,
  )
  const full: DockedPetProps = {
    left: 8, top: 300, tone: 'idle', skin: 'panda',
    onRestore: () => { restored += 1 },
    onContextMenu: () => undefined,
    ...props,
  }
  // 组件里会量一次 DOM 并注册命中盒：给一个最小环境，量出来就是它自己声明的矩形。
  const boxes = new Map<string, { x1: number; y1: number; x2: number; y2: number }>()
  ;(globalThis as unknown as { __hitboxes: typeof boxes }).__hitboxes = boxes
  const listeners = new Set<() => void>()
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: (_name: string, handler: () => void) => listeners.add(handler),
      removeEventListener: (_name: string, handler: () => void) => listeners.delete(handler),
    },
  })
  const tree = module.exports.default(full)
  const nodes = elements(tree)
  return {
    nodes,
    tree,
    boxes,
    listeners,
    unmount() { cleanups.forEach(cleanup => cleanup()); if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow) },
    get restored() { return restored },
    button: () => {
      const found = nodes.find(node => node.type === 'button')
      assert.ok(found, '停靠态必须是一个按钮（否则键盘与读屏都用不了）')
      return found
    },
    byClass(className: string) {
      return nodes.filter(node => node.props.className === className)
    },
  }
}

test('停靠态渲染的是宠物形象，不是一个圆点', () => {
  const view = mount({ skin: 'panda' })
  const images = view.byClass('docked-pet-img')
  assert.equal(images.length, 1, '必须有形象元素（这次报障的本体就是没有它）')
  assert.equal(images[0]!.props.src, '/assets/pets/panda.png')
  // 状态点仍在，但已缩成右下角徽标
  assert.equal(view.byClass('docked-pet-dot').length, 1)
  // 关键反向断言：不能是"只有圆点"的旧形态
  const hasSilhouette = view.byClass('docked-pet-silhouette').length > 0
  assert.equal(hasSilhouette, false, '有形象时不该同时画剪影')
})

test('拿不到形象时退回剪影，绝不退回纯色圆点', () => {
  const view = mount({ skin: 'broken' })
  assert.equal(view.byClass('docked-pet-img').length, 0)
  const silhouettes = view.byClass('docked-pet-silhouette')
  assert.equal(silhouettes.length, 1, '缺素材时必须给剪影：纯圆点就是用户投诉的那个"白点"')
  assert.equal(silhouettes[0]!.type, 'svg')
  // 剪影是"头 + 两只耳朵"三个圆，至少三个子元素
  assert.ok(elements(silhouettes[0]!.props.children as ReactNode).length >= 3)
  assert.equal(view.byClass('docked-pet-dot').length, 1, '状态点不因缺素材而消失')
})

test('读屏与悬浮提示仍然是"已收起 · 状态；单击展开"', () => {
  const view = mount({ tone: 'recording' })
  const label = String(view.button().props['aria-label'])
  assert.match(label, /宠物已收起/)
  assert.match(label, /录音中/)
  assert.match(label, /单击展开/)
  assert.match(String(view.button().props.title), /单击展开/)
  // 录音态是"呼吸"，样式类挂在按钮上
  assert.match(String(view.button().props.className), /is-breathing/)
})

test('单击恢复：鼠标位移 ≤4px 触发，>4px 不触发', () => {
  const view = mount()
  const down = view.button().props.onPointerDown as (event: unknown) => void
  const up = view.button().props.onPointerUp as (event: unknown) => void
  down({ clientX: 100, clientY: 100, pointerType: 'mouse' })
  up({ clientX: 102, clientY: 101 })
  assert.equal(view.restored, 1, '手抖 2px 也必须算点击：点不动等于功能坏了')
})

test('单击恢复：鼠标拖开 20px 不触发（避免误恢复）', () => {
  const view = mount()
  const down = view.button().props.onPointerDown as (event: unknown) => void
  const up = view.button().props.onPointerUp as (event: unknown) => void
  down({ clientX: 100, clientY: 100, pointerType: 'mouse' })
  up({ clientX: 120, clientY: 100 })
  assert.equal(view.restored, 0)
})

test('触摸指针放宽到 10px：手指点 8px 漂移仍然恢复', () => {
  const view = mount()
  const down = view.button().props.onPointerDown as (event: unknown) => void
  const up = view.button().props.onPointerUp as (event: unknown) => void
  down({ clientX: 100, clientY: 100, pointerType: 'touch' })
  up({ clientX: 108, clientY: 100 })
  assert.equal(view.restored, 1, '手指落点漂移 5–10px 是常态，用 4px 会"点了没反应"')
})

test('没有按下就抬起时不恢复（例如从别处拖进来松手）', () => {
  const view = mount()
  const up = view.button().props.onPointerUp as (event: unknown) => void
  up({ clientX: 100, clientY: 100 })
  assert.equal(view.restored, 0)
})
