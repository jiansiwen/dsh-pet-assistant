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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CLOCK_SKEW_MS,
  decideStartAction,
  isSafeProfileName,
  listLaunchableProfiles,
  matchesOwnedRuntime,
  MAX_BOOT_MS,
  MIN_DSH_VERSION,
  planRuntimeLaunch,
  resolveCli,
  sanitizeOwnership,
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
