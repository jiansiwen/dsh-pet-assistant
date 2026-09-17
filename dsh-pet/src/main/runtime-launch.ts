/**
 * 启动 dsh 团队运行时之前的全部事实核对：CLI、profile、插件、覆盖层、既有运行时、所有权。
 *
 * 这些判断单独成文件、并且完全不碰 Electron，是因为它们判错一次的代价很大：
 * 判错"要不要启动"会拉起第二个运行时（两份活动采集、两份 token 消耗、两个桥接抢同一个文件），
 * 判错"能不能杀"会终止用户自己起的那个 dsh 会话。这类判断必须能用假的 DSH_HOME 在
 * `node --test` 里跑过，而 Electron 的模块进不了 node 的测试运行器。
 *
 * 启动入口用的是 dsh 自己的 launcher（`--profile <name> --patch <overlay>`），不是另写一套：
 * `--patch` 覆盖层排在 profile 层之后，所以团队模式挂在任意一个已经能正常启动的 profile 上即可，
 * 不必新建 profile、也不必改写用户已有的 cordis.patch.yml。
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'

/** 启动握手的阶段。失败时上报具体阶段，绝不出现"已开启"的假成功。 */
export type LaunchStage =
  | 'locate-cli'
  | 'locate-profile'
  | 'locate-plugin'
  | 'locate-overlay'
  | 'check-runtime'
  | 'spawn'
  | 'await-bridge'
  | 'verify-contract'
  | 'ready'

export interface LaunchFailure {
  ok: false
  stage: LaunchStage
  message: string
}

/** 一次可执行的启动计划。所有路径都是核对过存在的绝对路径。 */
export interface RuntimePlan {
  ok: true
  profile: string
  profileDir: string
  pluginDir: string
  pluginVersion: string
  overlayPath: string
  cliPath: string
  dshVersion: string
  command: string
  args: readonly string[]
  cwd: string
  /** 子进程需要的额外环境变量。 */
  env: Readonly<Record<string, string>>
}

export interface LaunchOptions {
  dshHome: string
  profile: string
  /** 桌面壳自身的根目录：dsh CLI 是它的依赖，随包携带。 */
  appDir: string
  /** 用来跑 CLI 的可执行文件。默认 process.execPath + ELECTRON_RUN_AS_NODE。 */
  execPath?: string
}

/**
 * launcher 的最低版本。
 *
 * 只比数字段、忽略预发布标记：本仓随包的正是 `0.1.1-rc.2`，而严格的 semver 比较会把
 * 预发布判成小于 `0.1.1`，于是把唯一实际在用的那个构建拒之门外。这里要守的是
 * `--profile`/`--patch` 这两个 launcher 旗标存在，它们自 0.1.1 起就有。
 */
export const MIN_DSH_VERSION = '0.1.1'

/** 插件包名。profile 的依赖项与 node_modules 里的目录名都用它。 */
const PLUGIN_PACKAGE = 'dsh-personal-assistant'

/** 团队模式覆盖层在插件包里的固定名（已列进插件 package.json 的 files）。 */
const OVERLAY_FILENAME = 'cordis.team.patch.yml'

/** 从 spawn 到运行时写出 bridge.json 的容忍窗口。 */
export const MAX_BOOT_MS = 120_000

/** bridge.json 的 startedAt 与我们记录的 spawn 时刻之间允许的时钟偏差。 */
export const CLOCK_SKEW_MS = 5_000

function fail(stage: LaunchStage, message: string): LaunchFailure {
  return { ok: false, stage, message }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function versionCore(version: string): number[] {
  return version
    .split('-')[0]
    .split('.')
    .map(part => Number.parseInt(part, 10))
    .map(value => (Number.isFinite(value) ? value : 0))
}

/** 数字段比较：a ≥ b 返回 true。缺失的段按 0 处理。 */
export function versionAtLeast(version: string, minimum: string): boolean {
  const left = versionCore(version)
  const right = versionCore(minimum)
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a > b) return true
    if (a < b) return false
  }
  return true
}

/**
 * profile 名必须是单段白名单名字。
 *
 * 它会被拼进 `$DSH_HOME/profiles/<name>`，而值可能来自用户手改过的设置文件。
 * 一个 `../../` 或 `D:/something` 就能让"读 profile 的 package.json"变成读任意目录 ——
 * 白名单比逐个黑名单字符可靠，正常的 profile 名也全都落在里面。
 */
export function isSafeProfileName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name) && name !== '.' && name !== '..'
}

interface CliLocation {
  cliPath: string
  version: string
}

/** 随包携带的 dsh CLI。bin 路径从它自己的 package.json 读，不写死文件名。 */
export function resolveCli(appDir: string): CliLocation | null {
  const manifestPath = path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const manifest = readJson(manifestPath)
  if (!manifest) return null
  const bin = manifest.bin
  const entry = typeof bin === 'string' ? bin : (bin as Record<string, unknown> | undefined)?.dsh
  if (typeof entry !== 'string' || !entry) return null
  const cliPath = path.resolve(path.dirname(manifestPath), entry)
  if (!existsSync(cliPath)) return null
  return { cliPath, version: typeof manifest.version === 'string' ? manifest.version : '0.0.0' }
}

interface PluginLocation {
  pluginDir: string
  version: string
}

/**
 * profile 里装的插件目录。
 *
 * 两条路都走：`link:`/`file:` 依赖直接给出源码目录（本仓的开发布局就是这样），
 * 普通版本依赖则从 profile 的 node_modules 解析并跟随符号链接 —— pnpm 装出来的
 * 那一层是链接，不 realpath 就拿不到真正的包目录，也就找不到覆盖层文件。
 */
export function resolvePluginDir(profileDir: string): PluginLocation | null {
  const manifest = readJson(path.join(profileDir, 'package.json'))
  if (!manifest) return null
  const dependencies = (manifest.dependencies ?? {}) as Record<string, unknown>
  const spec = dependencies[PLUGIN_PACKAGE]

  let candidate: string
  if (typeof spec === 'string' && /^(link|file):/.test(spec)) {
    candidate = path.resolve(profileDir, spec.replace(/^(link|file):/, ''))
  } else {
    candidate = path.join(profileDir, 'node_modules', PLUGIN_PACKAGE)
  }

  let pluginDir: string
  try {
    pluginDir = realpathSync(candidate)
  } catch {
    return null
  }

  const plugin = readJson(path.join(pluginDir, 'package.json'))
  if (!plugin || plugin.name !== PLUGIN_PACKAGE) return null
  // 必须真的是一个 dsh bundle：否则 --patch 挂上去也开不出团队模式，白启动一个运行时。
  const bundle = (plugin.dsh as Record<string, unknown> | undefined)?.bundle
  if (!bundle || typeof bundle !== 'object') return null
  return { pluginDir, version: typeof plugin.version === 'string' ? plugin.version : '0.0.0' }
}

/** 核对启动所需的一切，产出一份可以直接 spawn 的计划；任何一项缺失都给出具体阶段与原因。 */
export function planRuntimeLaunch(options: LaunchOptions): RuntimePlan | LaunchFailure {
  const cli = resolveCli(options.appDir)
  if (!cli) {
    return fail(
      'locate-cli',
      `桌面壳没有找到随包的 dsh 命令行（${path.join(options.appDir, 'node_modules', '@deepseek-ai', 'dsh')}）：请先在 dsh-pet 目录安装依赖`,
    )
  }
  if (!versionAtLeast(cli.version, MIN_DSH_VERSION)) {
    return fail(
      'locate-cli',
      `随包的 dsh 是 ${cli.version}，低于启动团队模式所需的 ${MIN_DSH_VERSION}（launcher 需要支持 --patch 覆盖层）`,
    )
  }

  if (!isSafeProfileName(options.profile)) {
    return fail(
      'locate-profile',
      `profile 名「${options.profile}」不合法：只接受单段名字（字母、数字、点、下划线、连字符），不能包含路径分隔符`,
    )
  }

  const profileDir = path.join(options.dshHome, 'profiles', options.profile)
  if (!existsSync(path.join(profileDir, 'package.json'))) {
    return fail(
      'locate-profile',
      `profile「${options.profile}」不存在（${profileDir}）：先在 dsh 里初始化它，或换一个已装好个人助理插件的 profile`,
    )
  }

  const plugin = resolvePluginDir(profileDir)
  if (!plugin) {
    return fail(
      'locate-plugin',
      `profile「${options.profile}」里没有安装 ${PLUGIN_PACKAGE}：运行 dsh plugin --profile ${options.profile} add <插件目录> 后重试`,
    )
  }

  const overlayPath = path.join(plugin.pluginDir, OVERLAY_FILENAME)
  if (!existsSync(overlayPath)) {
    return fail(
      'locate-overlay',
      `插件目录里没有 ${OVERLAY_FILENAME}（${overlayPath}）：这份插件构建早于团队模式，请更新插件后重试`,
    )
  }

  const execPath = options.execPath ?? process.execPath
  return {
    ok: true,
    profile: options.profile,
    profileDir,
    pluginDir: plugin.pluginDir,
    pluginVersion: plugin.version,
    overlayPath,
    cliPath: cli.cliPath,
    dshVersion: cli.version,
    command: execPath,
    // 参数顺序由 launcher 决定：它自己那几个旗标必须排在传给内层 app 的参数之前。
    args: [cli.cliPath, '--profile', options.profile, '--patch', overlayPath],
    cwd: profileDir,
    // Electron 的可执行文件带上这个开关就是一个纯 node：不必假设用户 PATH 里有 node。
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

/** 托盘子菜单用：哪些 profile 现在就具备启动团队模式的条件。 */
export function listLaunchableProfiles(dshHome: string): string[] {
  const root = path.join(dshHome, 'profiles')
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const launchable: string[] = []
  for (const entry of entries) {
    const profileDir = path.join(root, entry)
    if (!existsSync(path.join(profileDir, 'package.json'))) continue
    const plugin = resolvePluginDir(profileDir)
    if (!plugin) continue
    if (!existsSync(path.join(plugin.pluginDir, OVERLAY_FILENAME))) continue
    launchable.push(entry)
  }
  return launchable.sort()
}

/** `/health` 的响应体。字段全部可选：旧构建的响应里就没有 epoch。 */
export interface HealthBody {
  ok?: boolean
  bound?: boolean
  epoch?: string
  team?: boolean
}

/** bridge.json 里与所有权判定有关的字段。 */
export interface BridgeFacts {
  pid?: number
  startedAt?: number
}

/**
 * 握手成功后的契约核对。
 *
 * 光看进程起来了不算成功 —— 起来了但是个改造前的构建，团队模式与审批凭据全都不存在，
 * 界面会一直空着，而用户看到的是"已开启"。这两条都是能在 /health 里当场证实的。
 */
export function verifyRuntimeContract(health: HealthBody | null, profile: string): { ok: true } | LaunchFailure {
  if (!health || health.ok !== true) {
    return fail('verify-contract', '运行时没有响应 /health：进程可能已经退出，详见运行时日志')
  }
  if (typeof health.epoch !== 'string' || health.epoch.length === 0) {
    return fail(
      'verify-contract',
      `运行时的 /health 没有 epoch 字段，说明它是改造前的构建：代次隔离与团队审批都不可用。请重新构建插件（npm run build）并重启 profile「${profile}」的会话`,
    )
  }
  if (health.team !== true) {
    return fail(
      'verify-contract',
      `运行时已连上但没有开启团队模式：这次启动没有带上 ${OVERLAY_FILENAME} 覆盖层，或 profile「${profile}」的配置把 teamEnabled 覆盖回了 false`,
    )
  }
  return { ok: true }
}

export type StartAction =
  | { action: 'attach' }
  | { action: 'launch' }
  | { action: 'wait'; message: string }

/**
 * 附着还是启动。
 *
 * 唯一硬性规则：只要还有活着的运行时，就绝不启动第二个。/health 一时不通不等于运行时没了 ——
 * 可能只是它刚起来还没绑定端口，或者一次网络闪断；这时候再 spawn 一个，两个进程会抢同一份
 * bridge.json 与同一个采样器，用户看到的现象是"宠物自己重影了"。
 */
export function decideStartAction(input: {
  health: HealthBody | null
  bridge: BridgeFacts | null
  pidAlive: (pid: number) => boolean
}): StartAction {
  if (input.health?.ok === true) return { action: 'attach' }
  const pid = input.bridge?.pid
  if (typeof pid === 'number' && pid > 0 && input.pidAlive(pid)) {
    return {
      action: 'wait',
      message: `进程 ${pid} 还在但没有响应 /health：可能刚启动或端口被挡住。不再启动第二个运行时，稍后自动重试`,
    }
  }
  return { action: 'launch' }
}

/** 壳记录的自有运行时。落盘是为了壳重启后还能认出"这个运行时是我起的"。 */
export interface RuntimeOwnership {
  instanceId: string
  pid: number
  /** 壳记录的 spawn 时刻（毫秒）。 */
  spawnedAt: number
  profile: string
  overlayPath: string
}

/** 从落盘的 JSON 里恢复所有权记录；形状不对就当没有，宁可少杀也不误杀。 */
export function sanitizeOwnership(raw: unknown): RuntimeOwnership | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.instanceId !== 'string' || value.instanceId.length === 0) return null
  if (typeof value.pid !== 'number' || value.pid <= 0) return null
  if (typeof value.spawnedAt !== 'number' || value.spawnedAt <= 0) return null
  if (typeof value.profile !== 'string' || value.profile.length === 0) return null
  if (typeof value.overlayPath !== 'string' || value.overlayPath.length === 0) return null
  return {
    instanceId: value.instanceId,
    pid: value.pid,
    spawnedAt: value.spawnedAt,
    profile: value.profile,
    overlayPath: value.overlayPath,
  }
}

/**
 * 这个还活着的运行时是不是我们启动的那一个。
 *
 * 只凭 PID 相等不算数：PID 会被系统回收，一个无关进程正好占了这个号，杀掉它就是杀掉用户的东西。
 * 所以还要求运行时自己写下的 startedAt 落在我们 spawn 之后的启动窗口内 —— 早于我们的 spawn
 * 说明它本来就在跑（那是用户的运行时，只能附着不能终止），晚得离谱说明 PID 已经换主了。
 */
export function matchesOwnedRuntime(
  record: RuntimeOwnership | null,
  bridge: BridgeFacts | null,
  now: number = Date.now(),
): boolean {
  if (!record || !bridge) return false
  if (typeof bridge.pid !== 'number' || bridge.pid !== record.pid) return false
  const startedAt = bridge.startedAt
  if (typeof startedAt !== 'number') return false
  if (startedAt < record.spawnedAt - CLOCK_SKEW_MS) return false
  if (startedAt > Math.max(now, record.spawnedAt) + MAX_BOOT_MS) return false
  return true
}
