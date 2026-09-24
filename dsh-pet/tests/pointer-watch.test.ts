import assert from 'node:assert/strict'
import { spawn as originalSpawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { mock, test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { PointerPress } from '../src/main/pointer-watch.ts'

// 默认测试只替换进程边界，不安装真实钩子；显式自测才启动自己的 PowerShell helper。
const realSpawn = originalSpawn
const scriptPath = fileURLToPath(new URL('../assets/pointer-watch.ps1', import.meta.url))
let currentPlatform = 'win32'
let spawnError: Error | undefined
let children: FakeChild[] = []
let spawnCalls: { executable: string; args: string[]; options: unknown }[] = []

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  input = ''
  kill = mock.fn(() => true)

  constructor() {
    super()
    this.stdin.on('data', chunk => { this.input += chunk.toString() })
  }

  output(value: unknown): void { this.stdout.write(JSON.stringify(value) + '\n') }
  ready(enabled = false, id = 0): void { this.output({ ready: true, enabled, id }) }
  close(code: number | null = 0, signal: string | null = null): void { this.emit('close', code, signal) }
}

mock.module('node:child_process', {
  namedExports: {
    spawn: (executable: string, args: string[], options: unknown) => {
      if (spawnError) throw spawnError
      const child = new FakeChild()
      children.push(child)
      spawnCalls.push({ executable, args, options })
      return child
    },
  },
})
mock.module('node:os', { namedExports: { platform: () => currentPlatform } })
const { PointerWatcher } = await import('../src/main/pointer-watch.ts')

const press: PointerPress = { x: -1200, y: 450, time: 1789000000123, button: 'left', pid: 2345 }

function make(t: TestContext, onPress?: (event: PointerPress) => void, onError?: (message: string) => void) {
  currentPlatform = 'win32'
  spawnError = undefined
  children = []
  spawnCalls = []
  const events: PointerPress[] = []
  const errors: string[] = []
  const exitListeners = process.listenerCount('exit')
  const watcher = new PointerWatcher(scriptPath, event => {
    events.push(event)
    onPress?.(event)
  }, message => {
    errors.push(message)
    onError?.(message)
  })
  t.after(() => {
    watcher.dispose()
    for (const child of children) child.close()
    assert.equal(process.listenerCount('exit'), exitListeners, '必须移除自己注册的父进程退出监听')
  })
  return { watcher, events, errors }
}

function enable(watcher: InstanceType<typeof PointerWatcher>): FakeChild {
  watcher.setEnabled(true)
  const child = children.at(-1)!
  child.ready()
  child.ready(true, 1)
  return child
}

test('惰性启动、重复启停幂等、空闲复用同一子进程，且不绕过执行策略', t => {
  const { watcher, events, errors } = make(t)
  watcher.setEnabled(false)
  assert.equal(children.length, 0)
  watcher.setEnabled(true)
  watcher.setEnabled(true)
  const child = children[0]
  assert.equal(child.input, '')
  child.output(press)
  assert.equal(events.length, 0)
  child.ready()
  assert.equal(child.input, 'enable 1\n')
  child.ready(true, 1)
  child.output(press)
  watcher.setEnabled(false)
  watcher.setEnabled(false)
  child.output(press)
  child.ready(false, 2)
  watcher.setEnabled(true)
  child.output(press)
  child.ready(true, 3)
  child.output({ ...press, button: 'right' })
  assert.equal(children.length, 1)
  assert.equal(child.input, 'enable 1\ndisable 2\nenable 3\n')
  assert.deepEqual(events, [press, { ...press, button: 'right' }])
  assert.deepEqual(errors, [])
  assert.deepEqual(spawnCalls, [{
    executable: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath],
    options: { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  }])
})

test('启动中禁用以及快速切换合并命令，旧确认和旧事件不能越过最新启用', t => {
  const { watcher, events } = make(t)
  watcher.setEnabled(true)
  watcher.setEnabled(false)
  const child = children[0]
  child.ready()
  assert.equal(child.input, 'disable 2\n')
  watcher.setEnabled(true)
  watcher.setEnabled(false)
  watcher.setEnabled(true)
  assert.equal(child.input, 'disable 2\n', '只有一条在途命令，不能无限写入 stdin')
  child.ready(false, 2)
  child.output(press)
  assert.equal(events.length, 0)
  assert.equal(child.input, 'disable 2\nenable 5\n')
  child.ready(true, 5)
  child.output(press)
  assert.deepEqual(events, [press])
})

test('同一启用确认在途时反复切换，也需要最新确认后才转发事件', t => {
  const { watcher, events } = make(t)
  watcher.setEnabled(true)
  const child = children[0]
  child.ready()
  watcher.setEnabled(false)
  watcher.setEnabled(true)
  child.ready(true, 1)
  child.output(press)
  assert.equal(events.length, 0)
  assert.equal(child.input, 'enable 1\nenable 3\n')
  child.ready(true, 3)
  child.output(press)
  assert.deepEqual(events, [press])
})

test('分块、粘包、空行及 CRLF；原地短点击不合并，保留原始时间和坐标', t => {
  const { watcher, events, errors } = make(t)
  const child = enable(watcher)
  const eventsIn = [press, { ...press, button: 'right' }, { ...press, button: 'middle', pid: 0 }]
  const lines = '\n' + eventsIn.map(value => JSON.stringify(value)).join('\r\n') + '\n'
  const bytes = Buffer.from(lines)
  for (let i = 0; i < bytes.length; i += 7) child.stdout.write(bytes.subarray(i, i + 7))
  assert.deepEqual(events, eventsIn)
  assert.deepEqual(errors, [])
})

for (const [name, value] of Object.entries({
  空值: null, 数组: [], 字符串: '错误', 空对象: {},
  坐标字符串: { ...press, x: '1' }, 坐标小数: { ...press, y: 1.5 }, 坐标越界: { ...press, x: 2147483648 },
  时间负数: { ...press, time: -1 }, 时间不安全: { ...press, time: 9007199254740992 },
  时间非有限: { ...press, time: Infinity }, 进程负数: { ...press, pid: -1 },
  进程越界: { ...press, pid: 4294967296 }, 非按下按钮: { ...press, button: 'wheel' },
  未知字段: { ...press, title: '不应读取标题' }, 缺失字段: { x: 1, y: 2, time: 3, button: 'left' },
  未知确认: { ready: true, enabled: true, id: 999 },
})) {
  test(`拒绝异常 JSON 字段：${name}，停止旧进程且不透传`, t => {
    const { watcher, events, errors } = make(t)
    const child = enable(watcher)
    child.output(value)
    child.output(press)
    child.close(1)
    assert.equal(events.length, 0)
    assert.equal(errors.length, 1)
    assert.ok(child.input.endsWith('exit\n'))
  })
}

for (const name of ['无效 JSON', '超长单块', '无限无换行分块', '超长错误输出']) {
  test(`限制异常输出：${name}`, t => {
    const { watcher, errors } = make(t)
    const child = enable(watcher)
    if (name === '无效 JSON') child.stdout.write('{broken}\n')
    else if (name === '超长单块') child.stdout.write('x'.repeat(1000000) + '\n')
    else if (name === '超长错误输出') child.stderr.write('x'.repeat(1000000))
    else for (let i = 0; i < 100; i++) child.stdout.write('x'.repeat(1024))
    assert.equal(errors.length, 1)
    assert.ok(child.stdin.writableEnded)
  })
}

test('一块包含许多合法事件不按总块大小拒绝，也不丢弃原地按下', t => {
  const { watcher, events, errors } = make(t)
  const child = enable(watcher)
  child.stdout.write((JSON.stringify(press) + '\n').repeat(200))
  assert.equal(events.length, 200)
  assert.deepEqual(errors, [])
})

test('初始化确认必须空闲且序号为零', t => {
  const { watcher, errors } = make(t)
  watcher.setEnabled(true)
  children[0].ready(true, 0)
  assert.equal(errors.length, 1)
})

test('启动和控制确认超时均回收自己的进程；清理完成后才允许重试', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { watcher, errors } = make(t)
  watcher.setEnabled(true)
  const old = children[0]
  t.mock.timers.tick(15000)
  assert.equal(errors.length, 1)
  assert.equal(old.input, 'exit\n')
  watcher.setEnabled(true)
  assert.equal(children.length, 1)
  t.mock.timers.tick(1000)
  assert.equal(old.kill.mock.callCount(), 1)
  old.close(null, 'SIGTERM')
  assert.equal(children.length, 2)
  const current = children[1]
  current.ready()
  t.mock.timers.tick(5000)
  assert.equal(errors.length, 2)
  t.mock.timers.tick(1000)
  assert.equal(current.kill.mock.callCount(), 1)
  old.stdout.write('{broken}\n')
  old.emit('error', new Error('迟到错误'))
  old.close(1)
  assert.equal(errors.length, 2)
})

test('dispose 幂等且不可重启；正常退出取消强杀定时器', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { watcher, events, errors } = make(t)
  const child = enable(watcher)
  watcher.dispose()
  watcher.dispose()
  watcher.setEnabled(true)
  child.output(press)
  child.close()
  t.mock.timers.tick(20000)
  assert.equal(child.input, 'enable 1\nexit\n')
  assert.equal(child.kill.mock.callCount(), 0)
  assert.equal(children.length, 1)
  assert.deepEqual(events, [])
  assert.deepEqual(errors, [])
})

test('父进程退出兜底只终止本实例子进程，不影响其他进程', t => {
  const { watcher } = make(t)
  const before = process.listeners('exit')
  const child = enable(watcher)
  const unrelated = new FakeChild()
  const ownedListeners = process.listeners('exit').filter(listener => !before.includes(listener))
  assert.equal(ownedListeners.length, 1)
  // 只调用新增监听，不触发宿主退出，也不发出真实的进程信号。
  ownedListeners[0](0)
  assert.equal(child.kill.mock.callCount(), 1)
  assert.equal(unrelated.kill.mock.callCount(), 0)
  child.close(null, 'SIGTERM')
})

test('启动过程中 dispose 也会强制回收，不处理迟到 ready', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { watcher, errors } = make(t)
  watcher.setEnabled(true)
  const child = children[0]
  watcher.dispose()
  child.ready()
  t.mock.timers.tick(1000)
  assert.equal(child.kill.mock.callCount(), 1)
  assert.equal(child.input, 'exit\n')
  assert.deepEqual(errors, [])
})

test('同步启动失败、异步进程错误、控制管道错误均可显式重试且只报错一次', t => {
  const { watcher, errors } = make(t)
  spawnError = new Error('启动失败')
  watcher.setEnabled(true)
  assert.equal(children.length, 0)
  spawnError = undefined
  watcher.setEnabled(true)
  const old = children[0]
  old.emit('error', new Error('找不到 PowerShell'))
  old.close(1)
  assert.equal(errors.length, 2)
  watcher.setEnabled(true)
  const current = children[1]
  current.ready()
  current.stdin.emit('error', new Error('EPIPE'))
  current.close(1)
  assert.equal(errors.length, 3)
})

test('注册失败转发标准错误，策略阻止或路径错误包含明确说明，退出后不自动循环重启', t => {
  const { watcher, errors } = make(t)
  watcher.setEnabled(true)
  const child = children[0]
  child.stderr.write('无法加载脚本，因为禁止运行脚本。\n')
  child.close(1)
  assert.match(errors[0], /执行策略/)
  assert.match(errors[0], /禁止运行脚本/)
  assert.equal(children.length, 1)
  watcher.setEnabled(true)
  const next = children[1]
  next.ready()
  next.stderr.write('注册 WH_MOUSE_LL 鼠标钩子失败。\n')
  next.close(1)
  assert.match(errors[1], /WH_MOUSE_LL/)
  assert.equal(children.length, 2)
})

test('回调内禁用或 dispose 立即阻止同一块后续事件；回调异常不破坏清理', t => {
  let seen = 0
  const h = make(t, () => {
    seen++
    if (seen === 1) h.watcher.setEnabled(false)
    else h.watcher.dispose()
    throw new Error('消费者失败')
  }, () => { throw new Error('消费者错误回调也失败') })
  const child = enable(h.watcher)
  child.stdout.write((JSON.stringify(press) + '\n').repeat(2))
  assert.equal(h.events.length, 1)
  child.ready(false, 2)
  h.watcher.setEnabled(true)
  child.ready(true, 3)
  child.stdout.write((JSON.stringify(press) + '\n').repeat(2))
  assert.equal(h.events.length, 2)
  assert.equal(h.errors.length, 2)
})

test('非 Windows 不启动进程，并如实说明这个能力在这台机器上没有', t => {
  const { watcher, errors } = make(t)
  currentPlatform = 'linux'
  watcher.setEnabled(true)
  assert.equal(children.length, 0)
  // 措辞要指向"哪个功能没了"，而不是"不支持 Windows" —— 用户读到的是一句能行动的话。
  // 注意：调用方（index.ts）在非 Windows 上根本不会 setEnabled(true)，
  // 这里是守卫兜底路径的回归。
  assert.match(errors[0], /Windows/)
  assert.match(errors[0], /Esc|面板/)
})

test('macOS 上同样不启动进程（辅助功能授权拿不到，能力不存在）', t => {
  const { watcher, errors } = make(t)
  currentPlatform = 'darwin'
  watcher.setEnabled(true)
  assert.equal(children.length, 0)
  assert.match(errors[0], /Windows/)
})

for (const endWith of ['exit', '关闭输入'] as const) {
  test(`Windows 最小自测：真实编译、安装、卸载、复用和${endWith}，不模拟点击`, {
    skip: process.platform !== 'win32' || process.env.DSH_POINTER_WATCH_SELF_TEST !== '1',
    timeout: 30000,
  }, async t => {
    const child = realSpawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill() })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    const messages = new EventEmitter()
    let buffer = ''
    const waiting: Array<Record<string, unknown>> = []
    child.stdout.setEncoding('utf8').on('data', chunk => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const value = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        buffer = buffer.slice(newline + 1)
        // 不保存真实用户点击；只检查自己的控制确认。
        if (value.ready === true) { waiting.push(value); messages.emit('ready') }
      }
    })
    const closed = once(child, 'close')
    const nextReady = async () => {
      if (!waiting.length) {
        await Promise.race([
          once(messages, 'ready'),
          closed.then(() => { throw new Error(`辅助进程提前退出：${stderr}`) }),
        ])
      }
      return waiting.shift()
    }
    assert.deepEqual(await nextReady(), { ready: true, enabled: false, id: 0 })
    for (let id = 1; id <= 4; id++) {
      const enabled = id % 2 === 1
      child.stdin.write(`${enabled ? 'enable' : 'disable'} ${id}\n`)
      assert.deepEqual(await nextReady(), { ready: true, enabled, id })
    }
    // 在钩子已启用时退出，验证退出路径也能卸钩；全程不制造鼠标输入。
    child.stdin.write('enable 5\n')
    assert.deepEqual(await nextReady(), { ready: true, enabled: true, id: 5 })
    if (endWith === 'exit') child.stdin.write('exit\n')
    else child.stdin.end()
    const [code, signal] = await closed
    assert.equal(code, 0, stderr)
    assert.equal(signal, null)
    assert.equal(stderr, '')
  })
}
