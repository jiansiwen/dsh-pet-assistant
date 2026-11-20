/**
 * 过渡用的 `react` 形态声明 —— **只服务于 `npm run check:client`，不参与构建。**
 *
 * 为什么需要它：客户端代码被打包成 `window.__ModuleLoader__` 的 CJS 包装，`react` 是
 * **外部依赖**（构建时 `external: ['react']`），本包并没有装 `react` / `@types/react`。
 * 于是 `tsc` 一跑客户端就报 `TS2307: Cannot find module 'react'` —— 这条错永远为真，
 * 会让整个检查变成"每次都红"，最后谁都不看。
 *
 * 那为什么还留着这个检查：`tsconfig.json` 里 `exclude: ["src/client"]`，客户端代码从来没被
 * 类型检查过；而 esbuild 把未知标识符当**全局变量**，漏导入不报错、只在运行时炸成
 * `ReferenceError`。这个检查要抓的正是那一类（`priorityCommand` / `rowTaskId` / `listRow`
 * 这种漏导入），它不需要 React 的真实类型。
 *
 * 因此这里把 React 的类型**故意写到最松**（`any` / 泛型直通）：够让标识符解析通过，
 * 又不假装能校验 props 与 hook 参数 —— 那是将来装 `@types/react` + `tsconfig.client.json`
 * 才能做的（记为待办，别为了完整在收尾时动依赖树）。
 *
 * 新增 React API 时在这里补一行即可；**一旦装上 `@types/react`，这个文件应当直接删掉**。
 */
declare module 'react' {
  /** 只用于样式对象：`Record<string, ...>` 比真实 CSSProperties 松，但这里够用。 */
  export type CSSProperties = Record<string, unknown>
  /** 组件可渲染内容。 */
  export type ReactNode = unknown
  export const Fragment: unknown
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown
  export function useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void]
  export function useRef<T>(initial: T): { current: T }
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useCallback<T>(callback: T, deps?: readonly unknown[]): T
  export function useMemo<T>(factory: () => T, deps?: readonly unknown[]): T
}
