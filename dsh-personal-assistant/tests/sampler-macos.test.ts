/**
 * M3-02：macOS 活动采样兼容。在 Windows 上用纯函数与替身覆盖，不启动任何真实采样器。
 *
 * assets/sampler-macos.js 是 JXA 脚本，run() 之上的部分刻意写成不碰 ObjC / Application 的纯 JavaScript：
 * 这里把**同一份文件**放进 Node 的 vm 里求值，直接驱动它的判定逻辑（排除、标题授权、权限缺失、空闲），
 * 不是另抄一份逻辑来自证。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { Classifier } from '../src/classifier.ts'
import {
  describeTitleUnavailable,
  launchSampler,
  platformCaptureBlockedReason,
  readLastSample,
  readSamples,
  samplerCommand,
  samplerEnv,
  samplerScriptName,
  type Sample,
} from '../src/sampler.ts'
import { buildSpansFrom } from '../src/spans.ts'
import { localDateOf } from '../src/time.ts'
import { ActivityTracker } from '../src/tracker.ts'

const assets = fileURLToPath(new URL('../assets/', import.meta.url))
const macScript = path.join(assets, 'sampler-macos.js')
const source = readFileSync(macScript, 'utf8')

interface MacApp { pid: number; executable: string; name: string; bundleId: string }
interface MacConfig {
  dir: string
  intervalMs: number
  captureTitles: boolean
  excludedProcesses: string[]
  excludedTitles: string[]
  error: string | null
}
interface Probe {
  now(): number
  idleMs(): number | null
  frontmost(): MacApp | null
  title(app: MacApp): string
}
interface Jxa {
  DEFAULT_EXCLUDED_PROCESSES: string[]
  IOREG_COMMAND: string
  parseConfig(env: Record<string, string | undefined>): MacConfig
  buildSample(probe: Probe, config: MacConfig): Record<string, unknown>
  sampleLine(sample: Record<string, unknown>): string
  parseHidIdleMs(text: string): number | null
  classifyTitleError(error: unknown): string
  localDate(ms: number): string
  sampleFileName(ms: number): string
  run: unknown
}

/** 在一个没有 ObjC / $ / Application 的干净上下文里求值：顶层若碰了 macOS 专有对象，这里会直接抛错。 */
function loadJxa(): Jxa {
  const context = vm.createContext({})
  vm.runInContext(source, context, { filename: 'sampler-macos.js' })
  return context as unknown as Jxa
}

/** vm 里造的对象原型来自另一个 realm；按落盘口径（JSON）比较。 */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const chrome: MacApp = { pid: 4321, executable: 'Google Chrome', name: 'Google Chrome', bundleId: 'com.google.Chrome' }

function probe(overrides: Partial<Probe> & { titleCalls?: MacApp[] } = {}) {
  const titleCalls: MacApp[] = overrides.titleCalls ?? []
  const fake: Probe = {
    now: overrides.now ?? (() => 1_760_000_000_000),
    idleMs: overrides.idleMs ?? (() => 1200),
    frontmost: overrides.frontmost ?? (() => chrome),
    title: (app: MacApp) => {
      titleCalls.push(app)
      return overrides.title ? overrides.title(app) : '季度总结 - Google Chrome'
    },
  }
  return { titleCalls, probe: fake }
}

function permissionError(errorNumber: number, message: string): Error & { errorNumber: number } {
  return Object.assign(new Error(message), { errorNumber })
}

test('脚本是纯 ASCII，顶层只定义函数、不碰 macOS 专有对象；入口 run 存在', () => {
  assert.equal(/^[\x00-\x7f]*$/.test(source), true, 'osascript 不该去猜源文件编码（与 sampler.ps1 同一约定）')
  const jxa = loadJxa()
  assert.equal(typeof jxa.run, 'function')
  assert.equal(typeof jxa.buildSample, 'function')
})

test('配置解析与 Windows 版一致：默认间隔、最小间隔、标题开关、默认排除名单；名单坏了失败关闭', () => {
  const jxa = loadJxa()
  const ps1 = readFileSync(path.join(assets, 'sampler.ps1'), 'utf8')
  const defaults = /\$excludedProcesses = @\(([^)]*)\)/.exec(ps1)![1].split(',').map(item => item.trim().replace(/^'|'$/g, ''))
  assert.deepEqual(plain(jxa.DEFAULT_EXCLUDED_PROCESSES), defaults, '两个平台的默认排除名单必须一致')

  const env = samplerEnv('/Users/u/.dsh/personal-assistant/samples', 3000, {
    captureTitles: false, excludedProcesses: ['KeePassXC'], excludedTitleKeywords: ['网上银行'],
  })
  assert.deepEqual(plain(jxa.parseConfig(env)), {
    dir: '/Users/u/.dsh/personal-assistant/samples', intervalMs: 3000, captureTitles: false,
    excludedProcesses: ['KeePassXC'], excludedTitles: ['网上银行'], error: null,
  })
  const defaulted = jxa.parseConfig({ DSH_SAMPLE_DIR: '/tmp/s' })
  assert.equal(defaulted.intervalMs, 5000)
  assert.equal(defaulted.captureTitles, true, '与 sampler.ps1 一样：只有显式 0 才关闭')
  assert.deepEqual(plain(defaulted.excludedProcesses), defaults)
  assert.equal(jxa.parseConfig({ DSH_SAMPLE_DIR: '/tmp/s', DSH_SAMPLE_INTERVAL_MS: '200' }).intervalMs, 1000)
  assert.match(String(jxa.parseConfig({}).error), /DSH_SAMPLE_DIR/)
  assert.match(String(jxa.parseConfig({ DSH_SAMPLE_DIR: '/tmp/s', DSH_SAMPLE_EXCLUDED_PROCESSES: '{坏' }).error), /JSON/)
  assert.match(String(jxa.parseConfig({ DSH_SAMPLE_DIR: '/tmp/s', DSH_SAMPLE_EXCLUDED_TITLES: '"x"' }).error), /array/)
})

test('输出字段与 Windows 版相同：有标题、无标题授权、空闲三种样本', () => {
  const jxa = loadJxa()
  const config = jxa.parseConfig({ DSH_SAMPLE_DIR: '/tmp/s', DSH_SAMPLE_TITLES: '1' })
  const titled = probe()
  assert.deepEqual(JSON.parse(jxa.sampleLine(jxa.buildSample(titled.probe, config))),
    { ts: 1_760_000_000_000, pid: 4321, proc: 'Google Chrome', idleMs: 1200, title: '季度总结 - Google Chrome' })

  const untitled = probe()
  const off = jxa.parseConfig({ DSH_SAMPLE_DIR: '/tmp/s', DSH_SAMPLE_TITLES: '0' })
  assert.deepEqual(plain(jxa.buildSample(untitled.probe, off)), { ts: 1_760_000_000_000, pid: 4321, proc: 'Google Chrome', idleMs: 1200 })
  assert.equal(untitled.titleCalls.length, 0, '没有标题授权时压根不读标题')

  for (const frontmost of [() => null, () => ({ ...chrome, bundleId: 'com.apple.loginwindow', executable: 'loginwindow' })]) {
    const idle = probe({ frontmost })
    assert.deepEqual(plain(jxa.buildSample(idle.probe, config)), { ts: 1_760_000_000_000, idle: true, idleMs: 1200 })
    assert.equal(idle.titleCalls.length, 0)
  }
  const noIdle = probe({ idleMs: () => { throw new Error('ioreg 不可用') } })
  assert.equal('idleMs' in plain(jxa.buildSample(noIdle.probe, config)), false, '拿不到空闲指标就不写，不编 0')
})

test('排除先于标题读取：命中排除应用时一次标题都不读，只留 excluded 标记', () => {
  const jxa = loadJxa()
  const config = jxa.parseConfig({
    DSH_SAMPLE_DIR: '/tmp/s', DSH_SAMPLE_TITLES: '1',
    DSH_SAMPLE_EXCLUDED_PROCESSES: JSON.stringify(['keepassxc', '1Password 7', 'com.bitwarden.desktop']),
    DSH_SAMPLE_EXCLUDED_TITLES: JSON.stringify(['网上银行']),
  })
  const apps: MacApp[] = [
    { pid: 1, executable: 'KeePassXC', name: 'KeePassXC', bundleId: 'org.keepassxc.keepassxc' },
    { pid: 2, executable: '1Password 7', name: '1Password 7', bundleId: 'com.agilebits.onepassword7' },
    { pid: 3, executable: 'Bitwarden', name: 'Bitwarden', bundleId: 'com.bitwarden.desktop' },
  ]
  for (const app of apps) {
    const run = probe({ frontmost: () => app, title: () => assert.fail('被排除的应用不能读标题') })
    assert.deepEqual(plain(jxa.buildSample(run.probe, config)), { ts: 1_760_000_000_000, excluded: true }, app.executable)
    assert.equal(run.titleCalls.length, 0, app.executable)
  }
  const keyword = probe({ title: () => '招商银行 网上银行 - Safari' })
  assert.deepEqual(plain(jxa.buildSample(keyword.probe, config)), { ts: 1_760_000_000_000, excluded: true }, '标题命中关键词也整条丢弃')
})

test('没有辅助功能或自动化权限：如实标记标题不可用，不编标题', () => {
  const jxa = loadJxa()
  const config = jxa.parseConfig({ DSH_SAMPLE_DIR: '/tmp/s', DSH_SAMPLE_TITLES: '1' })
  const cases: Array<[unknown, string]> = [
    [permissionError(-1719, 'System Events got an error: osascript is not allowed assistive access.'), 'accessibility'],
    [permissionError(-25211, 'AX API disabled'), 'accessibility'],
    [new Error('osascript不允许辅助访问。'), 'accessibility'],
    [permissionError(-1743, 'Not authorized to send Apple events to System Events.'), 'automation'],
    [permissionError(-1712, 'AppleEvent timed out.'), 'error'],
  ]
  for (const [error, reason] of cases) {
    assert.equal(jxa.classifyTitleError(error), reason)
    const denied = probe({ title: () => { throw error } })
    const sample = plain(jxa.buildSample(denied.probe, config))
    assert.deepEqual(sample, { ts: 1_760_000_000_000, pid: 4321, proc: 'Google Chrome', idleMs: 1200, titleUnavailable: reason })
    assert.equal('title' in sample, false)
  }
})

test('空闲时间解析 ioreg 的 HIDIdleTime（纳秒 → 毫秒）；日期与插件同一口径', () => {
  const jxa = loadJxa()
  assert.equal(jxa.IOREG_COMMAND, '/usr/sbin/ioreg -c IOHIDSystem')
  const ioreg = [
    '+-o IOHIDSystem  <class IOHIDSystem, id 0x100000abc, registered, matched, active, busy 0 (0 ms), retain 22>',
    '    {',
    '      "HIDIdleTime" = 4275000000',
    '      "HIDParameters" = {"HIDClickTime"=500000000}',
    '    }',
  ].join('\r')
  assert.equal(jxa.parseHidIdleMs(ioreg), 4275)
  assert.equal(jxa.parseHidIdleMs('"HIDIdleTime" = 999999'), 0)
  assert.equal(jxa.parseHidIdleMs('no idle here'), null)
  for (const ts of [Date.UTC(2026, 0, 1, 0, 30), Date.UTC(2026, 9, 17, 23, 59), Date.now()]) {
    assert.equal(jxa.localDate(ts), localDateOf(ts))
    assert.equal(jxa.sampleFileName(ts), `${localDateOf(ts)}.jsonl`)
  }
})

test('macOS 样本落盘后走同一套解析与聚合：标题不可用如实保留并可读', () => {
  const jxa = loadJxa()
  const config = jxa.parseConfig({ DSH_SAMPLE_DIR: '/tmp/s', DSH_SAMPLE_TITLES: '1' })
  let now = Date.UTC(2026, 9, 17, 2, 0)
  const lines: string[] = []
  for (let i = 0; i < 4; i += 1) {
    const step = probe({ now: () => now, title: () => { throw permissionError(-1719, 'not allowed assistive access') } })
    lines.push(jxa.sampleLine(jxa.buildSample(step.probe, config)))
    now += 5000
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mac-samples-'))
  try {
    const file = path.join(dir, jxa.sampleFileName(now))
    writeFileSync(file, `${lines.join('\n')}\n`)
    const samples: Sample[] = readSamples(file)
    assert.equal(samples.length, 4)
    assert.ok(samples.every(sample => sample.titleUnavailable === 'accessibility' && sample.title === undefined))
    const spans = buildSpansFrom(samples, new Classifier([]), 3000, 5000)
    assert.deepEqual(spans.map(span => [span.app, span.title]), [['Google Chrome', 'Google Chrome']],
      '没有标题时按应用聚合（展示名退回应用名），样本里不凭空造标题')
    assert.match(String(describeTitleUnavailable(readLastSample(file)?.titleUnavailable)), /辅助功能/)
    assert.match(String(describeTitleUnavailable('automation')), /System Events/)
    assert.equal(describeTitleUnavailable(undefined), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('命令拼装：Windows 走 PowerShell、macOS 走 osascript JXA，两边同一组环境变量；Linux 没有实现', () => {
  assert.equal(samplerScriptName('win32'), 'sampler.ps1')
  assert.equal(samplerScriptName('darwin'), 'sampler-macos.js')
  assert.equal(samplerScriptName('linux'), null)
  assert.deepEqual(samplerCommand('win32', 'C:\\a\\sampler.ps1'), {
    command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\a\\sampler.ps1'],
  })
  assert.deepEqual(samplerCommand('darwin', '/opt/a/sampler-macos.js'), {
    command: '/usr/bin/osascript', args: ['-l', 'JavaScript', '/opt/a/sampler-macos.js'],
  })
  assert.equal(samplerCommand('linux', '/opt/a/sampler.js'), null)
  assert.deepEqual(samplerEnv('/s', 5000, { captureTitles: true }), {
    DSH_SAMPLE_DIR: '/s', DSH_SAMPLE_INTERVAL_MS: '5000', DSH_SAMPLE_TITLES: '1',
    DSH_SAMPLE_EXCLUDED_PROCESSES: '[]', DSH_SAMPLE_EXCLUDED_TITLES: '[]',
  })
  // macOS 脚本读的正是这组变量。
  for (const name of Object.keys(samplerEnv('/s', 5000, { captureTitles: true }))) assert.ok(source.includes(`'${name}'`), name)
})

test('Linux 如实拒绝：平台闸门给出原因，拉起直接报错，跟踪器不启动也不恢复采样', async () => {
  assert.equal(platformCaptureBlockedReason('win32'), null)
  assert.equal(platformCaptureBlockedReason('darwin'), null)
  const reason = platformCaptureBlockedReason('linux')
  assert.match(String(reason), /Windows 与 macOS/)
  assert.match(String(reason), /linux/)
  assert.throws(() => launchSampler('/opt/a/sampler.js', '/tmp/s', 5000, { captureTitles: false }, 'linux'), /linux/)

  const state = { active: true, startedAt: 1 }
  let writes = 0
  const tracker = new ActivityTracker({ global: { get: () => state, set: async () => { writes += 1 } } } as never,
    new Classifier([]), '不存在的采样脚本', '不存在的采样目录', {
      sampleIntervalMs: 1000, minSpanMs: 1000, captureTitles: true,
      captureBlockedReason: () => platformCaptureBlockedReason('linux'), captureScopeAuthorized: () => true,
    })
  await assert.rejects(tracker.start(), /linux/)
  await tracker.ensureSamplerAlive()
  assert.equal(tracker.capturing, false)
  assert.equal(writes, 0, '被拦住时既不拉起也不改状态')
  assert.match(tracker.modeDescription(), /没有在记录活动/)
})
