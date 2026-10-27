/**
 * 启动运行时之前的核对逻辑：CLI、profile、插件、覆盖层、既有进程、所有权。
 *
 * 这些判断判错一次的代价不对称，所以逐条钉住：
 * - 判错"要不要启动"→ 桌面上出现两个运行时，两份活动采集、两份 token、抢同一份 bridge.json；
 * - 判错"能不能杀"→ 终止用户自己起的 dsh 会话，正在跑的任务全丢；
 * - 判错"起没起来"→ 界面显示已连接，而实际是改造前的构建，团队模式和审批凭据根本不存在。
 *
 * 全部用临时目录里的假装置跑，不碰 `~/.dsh`：测试要是依赖用户机器上的真实 profile，
 * 换台机器就是另一种结果，等于没测。唯一的例外是"随包的 CLI 在不在"那条 ——
 * 它断言的正是本仓 node_modules 里的真实依赖。
 */

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  bundledCliCommandLine,
  CLOCK_SKEW_MS,
  decideStartAction,
  isSafeProfileName,
  listLaunchableProfiles,
  matchesOwnedRuntime,
  MAX_BOOT_MS,
  MIN_DSH_VERSION,
  planRuntimeLaunch,
  resolveAppLayout,
  resolveCli,
  sanitizeOwnership,
  toUnpackedPath,
  verifyRuntimeContract,
  versionAtLeast,
  type LaunchFailure,
  type RuntimeOwnership,
  type RuntimePlan,
} from '../src/main/runtime-launch.ts'

const PLUGIN_PACKAGE = 'dsh-personal-assistant'
const OVERLAY_FILENAME = 'cordis.team.patch.yml'

interface Layout {
  root: string
  dshHome: string
  appDir: string
  profileDir: string
  pluginDir: string
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value))
}

/** 插件包：必须自报包名、版本，并且声明自己是 dsh bundle。 */
function writePlugin(dir: string, version = '0.1.0', bundle = true): void {
  mkdirSync(dir, { recursive: true })
  writeJson(path.join(dir, 'package.json'), {
    name: PLUGIN_PACKAGE,
    version,
    ...(bundle ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
  })
}

function writeOverlay(dir: string): void {
  writeFileSync(path.join(dir, OVERLAY_FILENAME), '- id: personal-assistant\n')
}

/** profile 的依赖声明：`spec` 为 null 表示根本没装插件。 */
function writeProfile(dir: string, spec: string | null): void {
  mkdirSync(dir, { recursive: true })
  writeJson(path.join(dir, 'package.json'), {
    name: 'dsh-profile-web',
    private: true,
    dependencies: spec === null ? {} : { [PLUGIN_PACKAGE]: spec },
  })
}

function writeCli(appDir: string, version = '0.1.1-rc.2'): void {
  const packageDir = path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(path.join(packageDir, 'lib'), { recursive: true })
  writeJson(path.join(packageDir, 'package.json'), {
    name: '@deepseek-ai/dsh',
    version,
    bin: { dsh: './lib/bin.js' },
  })
  writeFileSync(path.join(packageDir, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
}

/** 一套能成功启动的装置：CLI + link: 依赖的 profile + 带覆盖层的插件源码目录。 */
function makeLayout(): Layout {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-launch-'))
  const dshHome = path.join(root, 'dsh-home')
  const appDir = path.join(root, 'app')
  const profileDir = path.join(dshHome, 'profiles', 'web')
  const pluginDir = path.join(root, 'plugin-src')
  writeCli(appDir)
  writePlugin(pluginDir)
  writeOverlay(pluginDir)
  writeProfile(profileDir, `link:${pluginDir}`)
  return { root, dshHome, appDir, profileDir, pluginDir }
}

let layout: Layout | null = null

function fresh(): Layout {
  layout = makeLayout()
  return layout
}

afterEach(() => {
  if (layout) rmSync(layout.root, { recursive: true, force: true })
  layout = null
})

function planOf(target: Layout, profile = 'web'): RuntimePlan | LaunchFailure {
  return planRuntimeLaunch({
    dshHome: target.dshHome,
    profile,
    appDir: target.appDir,
    execPath: '/fake/node',
  })
}

/** 断言成功并把联合类型收窄成 RuntimePlan，失败时把阶段与原因带进断言消息。 */
function expectPlan(target: Layout, profile = 'web'): RuntimePlan {
  const plan = planOf(target, profile)
  if (!plan.ok) {
    throw new assert.AssertionError({ message: `期望产出启动计划，实际失败在 ${plan.stage}：${plan.message}` })
  }
  return plan
}

function expectFailure(target: Layout, profile = 'web'): LaunchFailure {
  const plan = planOf(target, profile)
  if (plan.ok) {
    throw new assert.AssertionError({ message: `期望启动失败，实际产出了指向 ${plan.cliPath} 的计划` })
  }
  return plan
}

describe('启动计划：一切就绪时产出可以直接 spawn 的命令', () => {
  test('launcher 自己的旗标排在传给内层 app 的参数之前', () => {
    const plan = expectPlan(fresh())
    assert.deepEqual([...plan.args], [plan.cliPath, '--profile', 'web', '--patch', plan.overlayPath])
  })

  test('工作目录是 profile 目录，可执行文件由调用方给定', () => {
    const target = fresh()
    const plan = expectPlan(target)
    assert.equal(plan.cwd, target.profileDir)
    assert.equal(plan.command, '/fake/node')
  })

  test('覆盖层是插件目录里的绝对路径：launcher 不接受相对路径', () => {
    const target = fresh()
    const plan = expectPlan(target)
    assert.equal(path.isAbsolute(plan.overlayPath), true)
    assert.equal(plan.overlayPath, path.join(realpathSync(target.pluginDir), OVERLAY_FILENAME))
  })

  test('子进程只要一个额外环境变量：Electron 的可执行文件带上它就是纯 node', () => {
    const plan = expectPlan(fresh())
    assert.deepEqual({ ...plan.env }, { ELECTRON_RUN_AS_NODE: '1' })
  })

  test('版本与目录都回填到计划里，界面可以直接报给用户看', () => {
    const plan = expectPlan(fresh())
    assert.equal(plan.dshVersion, '0.1.1-rc.2')
    assert.equal(plan.pluginVersion, '0.1.0')
    assert.equal(plan.profile, 'web')
  })
})

describe('启动计划：缺什么就停在哪一步，绝不静默降级', () => {
  test('没有随包的 CLI → locate-cli，并告诉用户去装依赖', () => {
    const target = fresh()
    rmSync(path.join(target.appDir, 'node_modules'), { recursive: true, force: true })
    const failure = expectFailure(target)
    assert.equal(failure.stage, 'locate-cli')
    assert.match(failure.message, /安装依赖/)
  })

  test('CLI 版本低于下限 → locate-cli，因为 launcher 那时还不支持 --patch', () => {
    const target = fresh()
    writeCli(target.appDir, '0.1.0')
    const failure = expectFailure(target)
    assert.equal(failure.stage, 'locate-cli')
    assert.match(failure.message, /0\.1\.0/)
    assert.match(failure.message, /--patch/)
  })

  test('profile 不存在 → locate-profile，并给出目录', () => {
    const target = fresh()
    const failure = expectFailure(target, 'sdk')
    assert.equal(failure.stage, 'locate-profile')
    // 用 includes 而不是 match：Windows 的绝对路径里全是反斜杠，当正则会匹配不上。
    assert.equal(failure.message.includes(path.join(target.dshHome, 'profiles', 'sdk')), true, failure.message)
  })

  test('profile 名带路径分隔符 → locate-profile，不拿它去拼目录', () => {
    const target = fresh()
    const failure = expectFailure(target, '../evil')
    assert.equal(failure.stage, 'locate-profile')
    assert.match(failure.message, /不合法/)
  })

  test('profile 里没装插件 → locate-plugin，并给出安装命令', () => {
    const target = fresh()
    writeProfile(target.profileDir, null)
    const failure = expectFailure(target)
    assert.equal(failure.stage, 'locate-plugin')
    assert.match(failure.message, /dsh plugin --profile web add/)
  })

  test('link: 指向不存在的目录 → locate-plugin，而不是把假目录当成插件', () => {
    const target = fresh()
    writeProfile(target.profileDir, `link:${path.join(target.root, 'nowhere')}`)
    assert.equal(expectFailure(target).stage, 'locate-plugin')
  })

  test('插件目录里没有覆盖层 → locate-overlay，说明这份构建早于团队模式', () => {
    const target = fresh()
    rmSync(path.join(target.pluginDir, OVERLAY_FILENAME), { force: true })
    const failure = expectFailure(target)
    assert.equal(failure.stage, 'locate-overlay')
    assert.match(failure.message, /早于团队模式/)
  })

  test('目录不声明自己是 dsh bundle → locate-plugin：挂上去也开不出团队模式', () => {
    const target = fresh()
    writePlugin(target.pluginDir, '0.1.0', false)
    assert.equal(expectFailure(target).stage, 'locate-plugin')
  })

  test('目录里是别的包 → locate-plugin，不能因为路径对得上就当成插件', () => {
    const target = fresh()
    writeJson(path.join(target.pluginDir, 'package.json'), { name: 'something-else', version: '9.9.9' })
    assert.equal(expectFailure(target).stage, 'locate-plugin')
  })
})

describe('pnpm 布局：node_modules 里的链接要跟随到真正的包目录', () => {
  test('普通版本依赖也能解析，覆盖层从 realpath 后的目录里找', t => {
    const target = fresh()
    writeProfile(target.profileDir, '^0.1.0')
    const modules = path.join(target.profileDir, 'node_modules')
    mkdirSync(modules, { recursive: true })
    try {
      symlinkSync(target.pluginDir, path.join(modules, PLUGIN_PACKAGE), 'junction')
    } catch {
      t.skip('当前系统不允许创建目录链接')
      return
    }
    const plan = expectPlan(target)
    assert.equal(plan.pluginDir, realpathSync(target.pluginDir))
    assert.equal(plan.overlayPath, path.join(realpathSync(target.pluginDir), OVERLAY_FILENAME))
  })
})

describe('随包的 dsh CLI：这是本仓的真实依赖，不是假装置', () => {
  test('能在 dsh-pet/node_modules 里找到，且版本满足下限', () => {
    const repoDir = fileURLToPath(new URL('..', import.meta.url))
    const cli = resolveCli(repoDir)
    assert.ok(cli, `没有从 ${repoDir} 找到 @deepseek-ai/dsh 的 bin 入口`)
    assert.equal(
      versionAtLeast(cli.version, MIN_DSH_VERSION),
      true,
      `随包的 dsh 是 ${cli.version}，低于启动团队模式所需的 ${MIN_DSH_VERSION}`,
    )
  })
})

describe('versionAtLeast：预发布标记不能把唯一在用的构建拒之门外', () => {
  test('0.1.1-rc.2 视为满足 0.1.1', () => {
    assert.equal(versionAtLeast('0.1.1-rc.2', MIN_DSH_VERSION), true)
  })

  test('同版本与更高版本都满足', () => {
    assert.equal(versionAtLeast('0.1.1', '0.1.1'), true)
    assert.equal(versionAtLeast('0.2.0', '0.1.9'), true)
    assert.equal(versionAtLeast('1.0.0', '0.1.1'), true)
  })

  test('更低版本与缺段都不满足', () => {
    assert.equal(versionAtLeast('0.1.0', '0.1.1'), false)
    assert.equal(versionAtLeast('0.1', '0.1.1'), false)
    assert.equal(versionAtLeast('0.0.9', '0.1.1'), false)
  })

  test('读不出数字按 0 处理，不抛异常', () => {
    assert.equal(versionAtLeast('garbage', '0.1.1'), false)
  })
})

describe('isSafeProfileName：名字会拼进 $DSH_HOME/profiles/<name>', () => {
  test('正常的 profile 名都放行', () => {
    for (const name of ['web', 'desktop-team', 'headless', 'a.b_c-1', 'a'.repeat(64)]) {
      assert.equal(isSafeProfileName(name), true, name)
    }
  })

  test('越界与绝对路径一律拒绝', () => {
    for (const name of ['../evil', '..\\evil', 'web/x', 'D:/somewhere', '.', '..', '', 'a'.repeat(65)]) {
      assert.equal(isSafeProfileName(name), false, JSON.stringify(name))
    }
  })
})

describe('verifyRuntimeContract：进程起来了不等于团队可用', () => {
  test('没有响应 → 指向运行时日志', () => {
    const failure = verifyRuntimeContract(null, 'web')
    assert.equal(failure.ok, false)
    if (failure.ok) return
    assert.equal(failure.stage, 'verify-contract')
    assert.match(failure.message, /health/)
  })

  test('ok 为 false 时不算连上', () => {
    assert.equal(verifyRuntimeContract({ ok: false, epoch: 'e1', team: true }, 'web').ok, false)
  })

  test('缺 epoch → 是改造前的构建，给出重建与重启的具体动作', () => {
    const failure = verifyRuntimeContract({ ok: true }, 'web')
    assert.equal(failure.ok, false)
    if (failure.ok) return
    assert.match(failure.message, /改造前/)
    assert.match(failure.message, /npm run build/)
    assert.match(failure.message, /web/)
  })

  test('epoch 是空串同样不算：空串过不了代次比对', () => {
    assert.equal(verifyRuntimeContract({ ok: true, epoch: '', team: true }, 'web').ok, false)
  })

  test('team 不为 true → 覆盖层没挂上或配置把它盖回去了，消息里点名覆盖层文件', () => {
    const failure = verifyRuntimeContract({ ok: true, epoch: 'e1', team: false }, 'web')
    assert.equal(failure.ok, false)
    if (failure.ok) return
    assert.equal(failure.message.includes(OVERLAY_FILENAME), true, failure.message)
    assert.match(failure.message, /teamEnabled/)
  })

  test('三项齐全才算真的就绪', () => {
    assert.deepEqual(verifyRuntimeContract({ ok: true, epoch: 'e1', team: true }, 'web'), { ok: true })
  })
})

describe('decideStartAction：只要还有活着的运行时，就绝不启动第二个', () => {
  const deadPid = () => false
  const livePid = () => true

  test('/health 通了就附着，不再 spawn', () => {
    assert.deepEqual(decideStartAction({ health: { ok: true }, bridge: null, pidAlive: livePid }), {
      action: 'attach',
    })
  })

  test('进程活着但 /health 不通 → 等待，并把原因说清楚', () => {
    const decision = decideStartAction({ health: null, bridge: { pid: 4242 }, pidAlive: livePid })
    assert.equal(decision.action, 'wait')
    if (decision.action !== 'wait') return
    assert.match(decision.message, /4242/)
    assert.match(decision.message, /不再启动第二个/)
  })

  test('进程已经没了才启动', () => {
    assert.deepEqual(decideStartAction({ health: null, bridge: { pid: 4242 }, pidAlive: deadPid }), {
      action: 'launch',
    })
  })

  test('根本没有 bridge.json 时启动', () => {
    assert.deepEqual(decideStartAction({ health: null, bridge: null, pidAlive: deadPid }), { action: 'launch' })
  })

  test('pid 字段缺失或非法不当成活进程：那只是旧构建留下的记录', () => {
    for (const bridge of [{}, { pid: 0 }, { pid: -1 }]) {
      assert.deepEqual(decideStartAction({ health: null, bridge, pidAlive: livePid }), { action: 'launch' })
    }
  })

  test('health 存在但 ok 不是 true 不算活着', () => {
    assert.deepEqual(decideStartAction({ health: { ok: false }, bridge: null, pidAlive: livePid }), {
      action: 'launch',
    })
  })
})

describe('sanitizeOwnership：形状不对就当没有，宁可少杀也不误杀', () => {
  const valid = {
    instanceId: 'shell-1',
    pid: 4242,
    spawnedAt: 1_000,
    profile: 'web',
    overlayPath: '/overlay.yml',
  }

  test('合法记录原样恢复，多余字段丢掉', () => {
    assert.deepEqual(sanitizeOwnership({ ...valid, junk: 'x' }), valid)
  })

  test('非对象一律为 null', () => {
    for (const raw of [null, undefined, 'x', 42, []]) {
      assert.equal(sanitizeOwnership(raw), null, JSON.stringify(raw))
    }
  })

  test('任一字段类型不对或为空就是 null', () => {
    assert.equal(sanitizeOwnership({ ...valid, instanceId: '' }), null)
    assert.equal(sanitizeOwnership({ ...valid, pid: 0 }), null)
    assert.equal(sanitizeOwnership({ ...valid, pid: '4242' }), null)
    assert.equal(sanitizeOwnership({ ...valid, spawnedAt: -1 }), null)
    assert.equal(sanitizeOwnership({ ...valid, profile: '' }), null)
    assert.equal(sanitizeOwnership({ ...valid, overlayPath: 7 }), null)
    assert.equal(
      sanitizeOwnership({
        instanceId: valid.instanceId,
        spawnedAt: valid.spawnedAt,
        profile: valid.profile,
        overlayPath: valid.overlayPath,
      }),
      null,
    )
  })
})

describe('matchesOwnedRuntime：PID 会被回收，光凭号码相等不能动手', () => {
  const record: RuntimeOwnership = {
    instanceId: 'shell-1',
    pid: 4242,
    spawnedAt: 1_000_000,
    profile: 'web',
    overlayPath: '/overlay.yml',
  }

  test('PID 与启动时刻都对得上，才是我们启动的那一个', () => {
    assert.equal(matchesOwnedRuntime(record, { pid: 4242, startedAt: record.spawnedAt + 3_000 }), true)
  })

  test('时钟偏差范围内的略微提前也算：两边取时不是同一瞬间', () => {
    assert.equal(matchesOwnedRuntime(record, { pid: 4242, startedAt: record.spawnedAt - CLOCK_SKEW_MS }), true)
  })

  test('明显早于我们的 spawn → 那是用户自己起的运行时，只能附着不能终止', () => {
    assert.equal(matchesOwnedRuntime(record, { pid: 4242, startedAt: record.spawnedAt - CLOCK_SKEW_MS - 1 }), false)
  })

  test('晚得离谱 → PID 已经换主了', () => {
    const now = record.spawnedAt + 10_000
    assert.equal(matchesOwnedRuntime(record, { pid: 4242, startedAt: now + MAX_BOOT_MS + 1 }, now), false)
  })

  test('启动窗口之内 → 认账', () => {
    const now = record.spawnedAt + 10_000
    assert.equal(matchesOwnedRuntime(record, { pid: 4242, startedAt: now + MAX_BOOT_MS }, now), true)
  })

  test('PID 不等、startedAt 缺失、记录或 bridge 为空，都不是我们的', () => {
    assert.equal(matchesOwnedRuntime(record, { pid: 9999, startedAt: record.spawnedAt }), false)
    assert.equal(matchesOwnedRuntime(record, { pid: 4242 }), false)
    assert.equal(matchesOwnedRuntime(record, null), false)
    assert.equal(matchesOwnedRuntime(null, { pid: 4242, startedAt: record.spawnedAt }), false)
  })
})

describe('listLaunchableProfiles：托盘子菜单只列现在真能启动的', () => {
  test('装好插件且有覆盖层的才上榜', () => {
    const target = fresh()
    // sdk：没有插件依赖
    writeProfile(path.join(target.dshHome, 'profiles', 'sdk'), null)
    // bare：装了插件但没有覆盖层
    const barePlugin = path.join(target.root, 'bare-plugin')
    writePlugin(barePlugin)
    writeProfile(path.join(target.dshHome, 'profiles', 'bare'), `link:${barePlugin}`)
    // another：完整，且排序应排在 web 之前
    const anotherPlugin = path.join(target.root, 'another-plugin')
    writePlugin(anotherPlugin)
    writeOverlay(anotherPlugin)
    writeProfile(path.join(target.dshHome, 'profiles', 'another'), `link:${anotherPlugin}`)

    assert.deepEqual(listLaunchableProfiles(target.dshHome), ['another', 'web'])
  })

  test('profiles 目录里的普通文件不会被当成 profile', () => {
    const target = fresh()
    writeFileSync(path.join(target.dshHome, 'profiles', 'note.txt'), 'x')
    assert.deepEqual(listLaunchableProfiles(target.dshHome), ['web'])
  })

  test('没有 profiles 目录时返回空，不抛异常', () => {
    assert.deepEqual(listLaunchableProfiles(path.join(os.tmpdir(), 'no-such-dsh-home')), [])
  })
})

describe('resolveAppLayout：开发态与改造前一致，打包态改走 app.asar.unpacked', () => {
  // 纯路径计算，不碰磁盘：根目录随便取一个绝对路径即可。
  const root = path.resolve(os.tmpdir(), 'layout-fixture')

  test('开发态：dist/main 往上两级就是 dsh-pet 目录，与 companion-host 原来的 ../.. 完全相同', () => {
    const mainDir = path.join(root, 'dsh-pet', 'dist', 'main')
    const layout = resolveAppLayout({ mainDir, isPackaged: false })
    assert.equal(layout.packaged, false)
    assert.equal(layout.appDir, path.resolve(mainDir, '../..'))
    assert.equal(layout.realAppDir, layout.appDir)
    assert.equal(layout.scriptDir, mainDir)
    assert.equal(layout.resourcesDir, layout.appDir)
  })

  test('开发态不理会 Electron 自己的 resources 目录：那里放的是 Electron 的默认应用，与本应用无关', () => {
    const mainDir = path.join(root, 'dsh-pet', 'dist', 'main')
    const electronResources = path.join(root, 'dsh-pet', 'node_modules', 'electron', 'dist', 'resources')
    const layout = resolveAppLayout({ mainDir, isPackaged: false, resourcesPath: electronResources })
    assert.equal(layout.appDir, path.join(root, 'dsh-pet'))
    assert.equal(layout.resourcesDir, path.join(root, 'dsh-pet'))
  })

  test('打包态：应用根是 app.asar，CLI 查找根与脚本目录都在旁边的 app.asar.unpacked', () => {
    const resources = path.join(root, 'dsh 桌面助理团', 'resources')
    const appPath = path.join(resources, 'app.asar')
    const layout = resolveAppLayout({
      mainDir: path.join(appPath, 'dist', 'main'),
      isPackaged: true,
      appPath,
      resourcesPath: resources,
    })
    assert.equal(layout.packaged, true)
    assert.equal(layout.appDir, appPath)
    assert.equal(layout.realAppDir, path.join(resources, 'app.asar.unpacked'))
    assert.equal(layout.scriptDir, path.join(resources, 'app.asar.unpacked', 'dist', 'main'))
    assert.equal(layout.resourcesDir, resources)
  })

  test('打包态没给 appPath / resourcesPath 时，按 mainDir 推出同一套目录', () => {
    const resources = path.join(root, 'resources')
    const layout = resolveAppLayout({ mainDir: path.join(resources, 'app.asar', 'dist', 'main'), isPackaged: true })
    assert.equal(layout.appDir, path.join(resources, 'app.asar'))
    assert.equal(layout.realAppDir, path.join(resources, 'app.asar.unpacked'))
    assert.equal(layout.resourcesDir, resources)
  })

  test('打包时关掉了 asar：应用根 resources/app 本身就是真实目录，不再拼 unpacked', () => {
    const appPath = path.join(root, 'resources', 'app')
    const layout = resolveAppLayout({ mainDir: path.join(appPath, 'dist', 'main'), isPackaged: true, appPath })
    assert.equal(layout.realAppDir, appPath)
    assert.equal(layout.scriptDir, path.join(appPath, 'dist', 'main'))
  })

  test('打包态下 build.mjs 拷到 dist/main 的每个 .ps1 都解析到 app.asar.unpacked 里', () => {
    const resources = path.join(root, 'resources')
    const layout = resolveAppLayout({ mainDir: path.join(resources, 'app.asar', 'dist', 'main'), isPackaged: true })
    for (const script of ['wake.ps1', 'wake-grammar.ps1', 'record.ps1', 'play.ps1', 'play-host.ps1', 'speak-once.ps1', 'asr-wave.ps1', 'win-uia.ps1']) {
      const file = path.join(layout.scriptDir, script)
      assert.equal(file, path.join(resources, 'app.asar.unpacked', 'dist', 'main', script))
      assert.equal(toUnpackedPath(path.join(resources, 'app.asar', 'dist', 'main', script)), file)
    }
  })
})

describe('toUnpackedPath：交给 PowerShell、worker、子进程的路径必须是真实文件', () => {
  test('Windows 安装目录里的脚本（带空格与中文）', () => {
    assert.equal(
      toUnpackedPath('C:\\Users\\u\\AppData\\Local\\Programs\\dsh 桌面助理团\\resources\\app.asar\\dist\\main\\wake.ps1'),
      'C:\\Users\\u\\AppData\\Local\\Programs\\dsh 桌面助理团\\resources\\app.asar.unpacked\\dist\\main\\wake.ps1',
    )
  })

  test('macOS 应用包里的 worker 入口与原生模块解析基点', () => {
    const base = '/Applications/dsh 桌面助理团.app/Contents/Resources'
    assert.equal(toUnpackedPath(`${base}/app.asar/dist/main/doc-pdf-worker.js`), `${base}/app.asar.unpacked/dist/main/doc-pdf-worker.js`)
    assert.equal(toUnpackedPath(`${base}/app.asar/dist/main/index.js`), `${base}/app.asar.unpacked/dist/main/index.js`)
  })

  test('开发态路径原样返回：调用方不必区分开发与打包', () => {
    for (const file of ['D:\\java\\dsh\\dsh-pet\\dist\\main\\wake.ps1', '/Users/me/dsh-pet/dist/main/play.ps1', 'relative/dist/main/x.ps1']) {
      assert.equal(toUnpackedPath(file), file)
    }
  })

  test('已经是 unpacked 的路径不会再加一遍', () => {
    const file = 'C:\\r\\resources\\app.asar.unpacked\\dist\\main\\play.ps1'
    assert.equal(toUnpackedPath(file), file)
    assert.equal(toUnpackedPath(toUnpackedPath('/r/app.asar/x')), '/r/app.asar.unpacked/x')
  })

  test('名字里带 .asar 但不是 asar 段的路径不动', () => {
    for (const file of ['/x/app.asar.bak/y', '/x/my.asarx/y', 'D:\\proj\\foo.asar.d\\bar', '/x/asar/y']) {
      assert.equal(toUnpackedPath(file), file, file)
    }
  })

  test('路径正好停在 app.asar 上', () => {
    assert.equal(toUnpackedPath('/r/resources/app.asar'), '/r/resources/app.asar.unpacked')
  })

  test('只换第一个 asar 段，与 Electron 认归档的规则一致', () => {
    assert.equal(toUnpackedPath('/r/app.asar/inner.asar/f'), '/r/app.asar.unpacked/inner.asar/f')
  })

  test('混用分隔符也能认', () => {
    assert.equal(toUnpackedPath('C:/r/app.asar\\dist\\main\\play.ps1'), 'C:/r/app.asar.unpacked\\dist\\main\\play.ps1')
  })
})

describe('打包态的启动计划：随包 CLI 从 app.asar.unpacked 的真实目录里找', () => {
  /** 安装后的布局：node_modules 按打包配置解包到 app.asar.unpacked。 */
  function installedLayout(target: Layout) {
    const resources = path.join(target.root, 'resources')
    const appPath = path.join(resources, 'app.asar')
    const layout = resolveAppLayout({ mainDir: path.join(appPath, 'dist', 'main'), isPackaged: true, appPath, resourcesPath: resources })
    writeCli(layout.realAppDir)
    return layout
  }

  test('CLI 在解包目录里：计划成功，CLI 路径是真实文件，启动方式与开发态相同', () => {
    const target = fresh()
    const layout = installedLayout(target)
    const plan = planRuntimeLaunch({ dshHome: target.dshHome, profile: 'web', appDir: layout.realAppDir, execPath: '/fake/exe', packaged: true })
    if (!plan.ok) throw new assert.AssertionError({ message: `期望产出启动计划，实际失败在 ${plan.stage}：${plan.message}` })
    assert.equal(plan.cliPath.startsWith(layout.realAppDir + path.sep), true, plan.cliPath)
    assert.equal(toUnpackedPath(plan.cliPath), plan.cliPath)
    assert.deepEqual([...plan.args], [plan.cliPath, '--profile', 'web', '--patch', plan.overlayPath])
    assert.deepEqual({ ...plan.env }, { ELECTRON_RUN_AS_NODE: '1' })
  })

  test('拿 asar 内的应用根去找 CLI → locate-cli，提示重新安装，而不是"去 dsh-pet 目录装依赖"', () => {
    const target = fresh()
    const layout = installedLayout(target)
    const plan = planRuntimeLaunch({ dshHome: target.dshHome, profile: 'web', appDir: layout.appDir, execPath: '/fake/exe', packaged: true })
    assert.equal(plan.ok, false)
    if (plan.ok) return
    assert.equal(plan.stage, 'locate-cli')
    assert.match(plan.message, /重新安装/)
    assert.doesNotMatch(plan.message, /dsh-pet 目录/)
  })

  test('profile 里没装插件 → 给出用壳自身可执行文件跑随包 CLI 的完整命令，并说明会改动 profile', () => {
    const target = fresh()
    const layout = installedLayout(target)
    writeProfile(target.profileDir, null)
    const exe = path.join(target.root, 'dsh 桌面助理团', 'dsh 桌面助理团.exe')
    const plan = planRuntimeLaunch({ dshHome: target.dshHome, profile: 'web', appDir: layout.realAppDir, execPath: exe, packaged: true })
    assert.equal(plan.ok, false)
    if (plan.ok) return
    assert.equal(plan.stage, 'locate-plugin')
    assert.match(plan.message, /ELECTRON_RUN_AS_NODE/)
    assert.equal(plan.message.includes(exe), true, plan.message)
    assert.equal(plan.message.includes(path.join(layout.realAppDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')), true, plan.message)
    assert.match(plan.message, /pnpm/)
    assert.match(plan.message, /改动/)
  })
})

describe('bundledCliCommandLine：安装版里 dsh 不在 PATH 上，给用户一行能直接复制的命令', () => {
  test('Windows：PowerShell 单引号字面量，单引号双写转义，用完删掉环境变量', () => {
    const line = bundledCliCommandLine(
      'win32',
      'C:\\P\\dsh 桌面助理团\\dsh 桌面助理团.exe',
      'C:\\P\\dsh 桌面助理团\\resources\\app.asar.unpacked\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
      ['plugin', '--profile', 'web', 'add', "D:\\x\\it's.tgz"],
    )
    assert.equal(
      line,
      "$env:ELECTRON_RUN_AS_NODE='1'; try { & 'C:\\P\\dsh 桌面助理团\\dsh 桌面助理团.exe' "
        + "'C:\\P\\dsh 桌面助理团\\resources\\app.asar.unpacked\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js' "
        + "'plugin' '--profile' 'web' 'add' 'D:\\x\\it''s.tgz' } finally { Remove-Item Env:ELECTRON_RUN_AS_NODE }",
    )
  })

  test('macOS：环境变量只作用于这一条命令，带空格与中文的路径加单引号', () => {
    const app = '/Applications/dsh 桌面助理团.app/Contents'
    const line = bundledCliCommandLine(
      'darwin',
      `${app}/MacOS/dsh 桌面助理团`,
      `${app}/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js`,
      ['plugin', '--profile', 'web', 'add', "/tmp/it's.tgz"],
    )
    assert.equal(
      line,
      `ELECTRON_RUN_AS_NODE=1 '${app}/MacOS/dsh 桌面助理团' '${app}/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js' `
        + "plugin --profile web add '/tmp/it'\\''s.tgz'",
    )
  })
})

/**
 * 打包配置（build/electron-builder.yml）的不变量。electron-builder 还没装、没法真打包，
 * 这里把"哪些文件必须解包、不签名不发布、权限用途说明不变"钉成测试，改配置时会先撞到它们。
 */
describe('打包配置：asarUnpack 覆盖外部读者要读的文件，只出本地测试包', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const yml = readFileSync(path.join(repo, 'build', 'electron-builder.yml'), 'utf8')
  /** 去掉注释行与行尾注释（本配置的值里没有 #）。 */
  const lines = yml.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).map(line => line.replace(/\s+#.*$/, ''))

  /** 顶层键下的块（直到下一个顶层键）。 */
  function block(key: string): string[] {
    const start = lines.findIndex(line => line === `${key}:` || line.startsWith(`${key}: `))
    assert.ok(start >= 0, `配置里没有 ${key}`)
    const body: string[] = []
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break
      body.push(line)
    }
    return body
  }
  function topValue(key: string): string | undefined {
    return lines.find(line => line.startsWith(`${key}: `))?.slice(key.length + 2).trim()
  }
  function nestedValue(parent: string, key: string): string | undefined {
    const line = block(parent).find(entry => new RegExp(`^\\s+${key}:\\s`).test(entry))
    return line?.replace(new RegExp(`^\\s+${key}:\\s*`), '').trim()
  }
  const unpack = block('asarUnpack')
    .map(line => /^\s+-\s+(.+)$/.exec(line)?.[1].trim().replace(/^'(.*)'$/, '$1'))
    .filter((value): value is string => typeof value === 'string')
  const globRegex = (pattern: string): RegExp => new RegExp(`^${pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')}$`)
  const unpacked = (file: string): boolean => unpack.some(pattern => globRegex(pattern).test(file))

  test('build.mjs 拷进 dist 的每个 .ps1 都会被解包，src/main 里的每个 .ps1 也都在拷贝清单上', () => {
    const build = readFileSync(path.join(repo, 'scripts', 'build.mjs'), 'utf8')
    const copied = [...build.matchAll(/'(dist\/main\/[A-Za-z0-9._-]+\.ps1)'/g)].map(match => match[1])
    assert.ok(copied.length >= 7, `build.mjs 里只找到 ${copied.length} 个 .ps1 拷贝`)
    for (const file of copied) assert.equal(unpacked(file), true, `${file} 没有被 asarUnpack 覆盖`)
    for (const name of readdirSync(path.join(repo, 'src', 'main')).filter(entry => entry.endsWith('.ps1'))) {
      assert.equal(copied.includes(`dist/main/${name}`), true, `src/main/${name} 没有被 build.mjs 拷进 dist/main`)
    }
    // 素材目录整份拷到 dist/assets，其中的 .ps1 交给 PowerShell。
    for (const name of readdirSync(path.join(repo, 'assets')).filter(entry => entry.endsWith('.ps1'))) {
      assert.equal(unpacked(`dist/assets/${name}`), true, `dist/assets/${name} 没有被 asarUnpack 覆盖`)
    }
  })

  test('原生模块（含平台子包）、PDF.js 资源、worker 入口与随包 dsh CLI 都会被解包', () => {
    for (const file of [
      'node_modules/sherpa-onnx-node/sherpa-onnx.js',
      'node_modules/sherpa-onnx-win-x64/sherpa-onnx.node',
      'node_modules/sherpa-onnx-win-x64/onnxruntime.dll',
      'node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node',
      'node_modules/sherpa-onnx-darwin-x64/libonnxruntime.dylib',
      'node_modules/pdfjs-dist/package.json',
      'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
      'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      'node_modules/pdfjs-dist/cmaps/UniGB-UCS2-H.bcmap',
      'node_modules/pdfjs-dist/standard_fonts/FoxitSans.pfb',
      'node_modules/@deepseek-ai/dsh/lib/bin.js',
      'node_modules/@deepseek-ai/dsh/package.json',
      'dist/main/doc-pdf-worker.js',
      'dist/main/tts-edge-worker.js',
    ]) {
      assert.equal(unpacked(file), true, `${file} 没有被 asarUnpack 覆盖`)
    }
  })

  test('本应用自己的页面、主进程与素材仍在 asar 里（只解包外部读者要读的）', () => {
    for (const file of ['dist/main/index.js', 'dist/renderer/main.js', 'dist/preload/index.cjs', 'dist/assets/pets/panda.png', 'package.json']) {
      assert.equal(unpacked(file), false, `${file} 不该被解包`)
    }
    assert.equal(topValue('asar'), 'true')
  })

  test('不签名、不公证、不发布；产物名写明未签名的本地测试包', () => {
    assert.equal(topValue('publish'), 'null')
    assert.equal(topValue('forceCodeSigning'), 'false')
    assert.equal(nestedValue('mac', 'identity'), 'null')
    assert.equal(nestedValue('mac', 'notarize'), 'false')
    assert.match(topValue('artifactName') ?? '', /unsigned-local/)
    for (const key of ['cscLink', 'cscKeyPassword', 'certificateFile', 'certificatePassword', 'signtoolOptions', 'azureSignOptions', 'electronFuses']) {
      assert.equal(lines.some(line => line.includes(`${key}:`)), false, `配置里出现了 ${key}`)
    }
  })

  test('原生模块不按 Electron 重编译：全是 N-API 预编译包', () => {
    assert.equal(topValue('npmRebuild'), 'false')
  })

  test('macOS 权限用途说明与 entitlements 保持原样', () => {
    const mac = block('mac').join('\n')
    assert.equal(mac.includes('NSMicrophoneUsageDescription: 桌面助理需要麦克风来听你说话（语音唤醒与按键听写）。录音只在本机处理，不上传任何音频。'), true)
    assert.equal(mac.includes('NSCameraUsageDescription: 桌面助理不使用摄像头；这一项仅为满足系统对媒体权限的完整性检查。'), true)
    assert.equal(mac.includes('NSAppleEventsUsageDescription: 桌面助理需要它来读取前台应用信息，用于生成你的活动记录（仅在你开启「活动记录」后）。'), true)
    assert.equal(nestedValue('mac', 'LSUIElement'), 'true')
    assert.equal(nestedValue('mac', 'entitlements'), 'build/entitlements.mac.plist')
    assert.equal(nestedValue('mac', 'entitlementsInherit'), 'build/entitlements.mac.plist')
    const plist = readFileSync(path.join(repo, 'build', 'entitlements.mac.plist'), 'utf8')
    for (const key of [
      'com.apple.security.device.audio-input',
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
    ]) {
      assert.match(plist, new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*<true/>`), key)
    }
  })

  test('userData 目录名保持 dsh-pet：打包后的 package.json 不能多出 productName', () => {
    const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')) as Record<string, unknown>
    assert.equal(pkg.name, 'dsh-pet')
    assert.equal('productName' in pkg, false)
    assert.equal(lines.some(line => line.startsWith('extraMetadata:')), false)
  })

  test('不再把素材整份重复拷进 resources：没有代码读那里', () => {
    assert.equal(lines.some(line => line.startsWith('extraResources:')), false)
  })
})
