/**
 * 插件入口装配的冒烟验证。
 *
 * 前两个套件都是直接实例化服务，所以入口 apply() 的装配顺序一直没被真跑过：
 * 旧数据迁移、采集闸门、发布崩溃恢复、保留期清理、工具与提示词注册——这些只有在
 * 真装配一次之后才看得出有没有接上。这里用假的宿主上下文（存储域、工具注册表、
 * 系统提示词、effect）把入口跑起来，断言的是"用户装上插件之后实际得到什么"，
 * 各服务内部的对错由单测覆盖，这里不重复。
 *
 * 刻意不验证的部分：真采样进程。两个场景的采集都被闸门挡住（一个关配置、一个迁移失败），
 * 冒烟测试不该在开发机上偷偷拉起一个记录前台窗口的 PowerShell。
 *
 * 跑法：npm run smoke
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Config, type Config as ConfigType } from '../src/config.ts'
import type { DayRecord, ModeState, Preference, ReportMeta, SemanticEvent } from '../src/domain.ts'
import { apply } from '../src/index.ts'
import { sampleFileOf } from '../src/sampler.ts'
import { localDateOf, startOfLocalDate } from '../src/time.ts'

const DAY = 86_400_000
const NOW = Date.now()
const TODAY = localDateOf(NOW)
const YESTERDAY = localDateOf(NOW - DAY)
const STALE = localDateOf(NOW - 12 * DAY)

const EXPECTED_TOOLS = [
  'personal_assistant_summon_pet',
  'personal_assistant_set_team_mode',
  'personal_assistant_start',
  'personal_assistant_stop',
  'personal_assistant_status',
  'personal_assistant_today',
  'personal_assistant_commit_events',
  'personal_assistant_import_records',
  'personal_assistant_save_draft',
  'personal_assistant_get_draft',
  'personal_assistant_submit_report',
  'personal_assistant_confirm_report',
  'personal_assistant_remember_preference',
  'personal_assistant_list_preferences',
  'personal_assistant_forget_preference',
]

let passed = 0

function check(label: string, body: () => void): void {
  body()
  passed += 1
  console.log(`  ok   ${label}`)
}

async function checkAsync(label: string, body: () => Promise<void>): Promise<void> {
  await body()
  passed += 1
  console.log(`  ok   ${label}`)
}

/**
 * 只写要改的字段，其余交给 schema 补默认值。
 *
 * schemastery 的调用签名声明的是完整 Config，运行时接受部分输入——宿主装配插件时
 * 就是这么调的。这里保持一致而不是手抄二十来个默认值：抄错一个，冒烟就跑在一个
 * 用户永远不会遇到的配置上，通过了也说明不了什么。
 */
function configWith(overrides: Partial<ConfigType>): ConfigType {
  return Config(overrides as ConfigType)
}

// ---------------------------------------------------------------------------
// 假宿主
// ---------------------------------------------------------------------------

/**
 * 一张假存储域表。按真 Domain 的契约建模：读同步走内存、写异步、
 * entries() 是快照（写入进行中遍历也不晃）、delete 返回"原来有没有"。
 */
interface FakeTable<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
  readonly size: number
}

function fakeTable<V>(seed: Iterable<readonly [string, V]> = [], failEntries?: string): FakeTable<V> & {
  readonly deleted: string[]
} {
  const rows = new Map<string, V>(seed)
  const deleted: string[] = []
  return {
    deleted,
    get size() {
      return rows.size
    },
    get: (key: string) => rows.get(key),
    entries() {
      // 存储后端读不出来时这里就抛，迁移会把它记成"读旧数据失败"而不是当成空库
      if (failEntries) throw new Error(failEntries)
      return new Map(rows).entries()
    },
    async put(key: string, value: V) {
      rows.set(key, value)
    },
    async delete(key: string) {
      deleted.push(key)
      return rows.delete(key)
    },
  }
}

class FakeDomain {
  closed = false
  private globalValue: ModeState = { active: false, startedAt: 0 }
  private readonly tables: Map<string, FakeTable<never>>

  constructor(tables: Record<string, FakeTable<never>>) {
    this.tables = new Map(Object.entries(tables))
  }

  get global() {
    return {
      get: (): ModeState => this.globalValue,
      set: async (value: ModeState): Promise<void> => {
        this.globalValue = value
      },
    }
  }

  /** 真 Domain 的表句柄是稳定的：重复调用返回同一个实例。跟踪器每次都取 days 表。 */
  table(name: string): FakeTable<never> {
    const table = this.tables.get(name)
    if (!table) throw new Error(`未声明的表：${name}`)
    return table
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

interface RegisteredTool {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
}

interface Harness {
  readonly ctx: never
  readonly domain: FakeDomain
  readonly logs: string[]
  readonly disposers: Array<{ label: string | undefined; dispose(): void }>
  /** 收尾函数被调用的实际顺序，用来核对"与注册顺序相反"这句声明。 */
  readonly disposalOrder: string[]
  readonly listeners: string[]
  toolNames(): string[]
  callTool(name: string, args?: unknown): Promise<Record<string, unknown>>
  variable(name: string): string | undefined
  section(name: string): string
  dispose(): void
}

/**
 * 搭一个只够入口用的假宿主。
 *
 * effect 按 cordis 的语义真跑：立刻执行装配函数、留住它返回的收尾函数，
 * dispose() 时逆序调用——顺序错了（比如先关库再停采样）这里就会炸出来。
 */
function createHarness(domain: FakeDomain): Harness {
  const logs: string[] = []
  const tools = new Map<string, RegisteredTool>()
  const sections = new Map<string, string>()
  const variables = new Map<string, () => string | undefined>()
  const disposers: Harness['disposers'] = []
  const disposalOrder: string[] = []
  const listeners: string[] = []

  const harness: Harness = {
    ctx: {
      storageDomain: {
        async open() {
          return domain
        },
      },
      effect(execute: () => () => void, label?: string) {
        disposers.push({ label, dispose: execute() })
        return () => undefined
      },
      on(event: string) {
        listeners.push(event)
        return () => undefined
      },
      logger() {
        return {
          info: (message: string) => logs.push(`info ${message}`),
          warn: (message: string) => logs.push(`warn ${message}`),
          error: (message: string) => logs.push(`error ${message}`),
        }
      },
      tools: {
        register(definition: RegisteredTool) {
          tools.set(definition.name, definition)
          return () => undefined
        },
      },
      systemPrompt: {
        section(section: { name: string; text: string }) {
          sections.set(section.name, section.text)
          return () => undefined
        },
        variable(name: string, provider: () => string | undefined) {
          variables.set(name, provider)
          return () => undefined
        },
      },
    } as never,
    domain,
    logs,
    disposers,
    disposalOrder,
    listeners,
    toolNames: () => [...tools.keys()],
    async callTool(name: string, args: unknown = {}) {
      const tool = tools.get(name)
      assert.ok(tool, `工具没注册：${name}`)
      const raw = await tool.execute(args, {})
      assert.equal(typeof raw, 'string', `${name} 的输出应该是 JSON 字符串`)
      return JSON.parse(raw as string) as Record<string, unknown>
    },
    variable: (name: string) => variables.get(name)?.(),
    section: (name: string) => {
      const text = sections.get(name)
      assert.ok(text, `系统提示词段没注册：${name}`)
      return text
    },
    dispose() {
      // 与注册顺序相反：先停采样，再关桥接，最后才是库与存储域
      while (disposers.length > 0) {
        const entry = disposers.pop()
        if (!entry) break
        disposalOrder.push(entry.label ?? '(未命名)')
        entry.dispose()
      }
    },
  }
  return harness
}

/** 库里的行数。冒烟只读，不经过任何服务，直接问 SQLite。 */
function countRows(storePath: string, sql: string): number {
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const row = db.prepare(sql).get() as Record<string, number>
    return Number(Object.values(row)[0])
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// 场景一：正常升级——旧数据搬进来、超期原文清掉、采集开关照配置生效
// ---------------------------------------------------------------------------

async function scenarioUpgrade(root: string): Promise<void> {
  const home = path.join(root, 'upgrade')
  const sampleDir = path.join(home, 'personal-assistant', 'samples')
  mkdirSync(sampleDir, { recursive: true })

  // 三天的采样原文：12 天前（超出 7 天保留期）、昨天、今天。今天的按迁移口径要排除。
  const seedSamples = (date: string, title: string): void => {
    const base = startOfLocalDate(date) + 9 * 3_600_000
    const lines = [0, 30_000, 60_000].map(offset => JSON.stringify({ ts: base + offset, pid: 4242, proc: 'WINWORD', title }))
    writeFileSync(sampleFileOf(sampleDir, date), `${lines.join('\n')}\n`)
  }
  seedSamples(STALE, '旧季度总结.docx - Microsoft Word')
  seedSamples(YESTERDAY, '季度总结.docx - Microsoft Word')
  seedSamples(TODAY, '今天还在写的.docx - Microsoft Word')
  writeFileSync(path.join(sampleDir, 'sampler.pid'), '4242')

  const archivedPath = path.join(root, 'archived-report.md')
  writeFileSync(archivedPath, '# 昨天的日报\n\n已经定稿。\n')

  const event: SemanticEvent = {
    id: 'evt-legacy-1',
    start: startOfLocalDate(YESTERDAY) + 9 * 3_600_000,
    end: startOfLocalDate(YESTERDAY) + 10 * 3_600_000,
    summary: '写季度总结',
    evidence: ['WINWORD｜季度总结.docx'],
    source: 'auto',
    confidence: 'high',
    createdAt: NOW - DAY,
  }
  const day: DayRecord = {
    date: YESTERDAY,
    events: [event],
    notes: [{ id: 'note-legacy-1', content: '粘贴的聊天记录全文', source: 'wechat_export', createdAt: NOW - DAY }],
    interpretedUpto: event.end,
  }

  const preferences = fakeTable<Preference>([
    ['pref-1', { id: 'pref-1', text: '日报按工作类别组织', createdAt: NOW - 2 * DAY }],
    ['pref-2', { id: 'pref-2', text: '日报不要包含午休浏览网页的时间', createdAt: NOW - DAY }],
  ])
  const days = fakeTable<DayRecord>([[YESTERDAY, day]])
  const reports = fakeTable<ReportMeta>([
    [YESTERDAY, { date: YESTERDAY, filePath: archivedPath, confirmedAt: NOW - DAY }],
    [localDateOf(NOW - 2 * DAY), { date: localDateOf(NOW - 2 * DAY), draft: '# 还没定稿的草稿' }],
  ])
  const domain = new FakeDomain({
    preferences: preferences as unknown as FakeTable<never>,
    days: days as unknown as FakeTable<never>,
    reports: reports as unknown as FakeTable<never>,
  })

  const harness = createHarness(domain)
  const storePath = path.join(home, 'personal-assistant', 'assistant.sqlite')
  // 关掉采集：这个场景验的是装配与迁移，不该真去启采样进程
  const config = configWith({ captureActivity: false })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await checkAsync('入口装配跑通：库建出来了，工具与提示词都注册上了', async () => {
      await apply(harness.ctx, config)
      assert.ok(existsSync(storePath), `助理库没建出来：${storePath}`)
      assert.deepEqual(harness.toolNames().sort(), [...EXPECTED_TOOLS].sort())
      assert.ok(harness.section('personal-assistant').includes('已确认的记忆'))
      // 提示词变量在**空库**下逐个真调一次：宿主把"变量没有值"当装配错误直接炸，
      // 而这条链路只有真机渲染提示词才走得到 —— 空态返回 undefined 的 bug 就是这么溜过去的。
      for (const name of [
        'personal_assistant_mode',
        'personal_assistant_preferences',
        'personal_assistant_memory_conflicts',
      ]) {
        assert.equal(typeof harness.variable(name), 'string', `变量 ${name} 在空库下必须返回字符串`)
      }
      assert.deepEqual(harness.listeners, ['agent/status', 'agent/disposed'])
    })

    check('旧偏好变成了记忆，并标明是导入来的', () => {
      const prompt = harness.variable('personal_assistant_preferences')
      assert.ok(prompt, '偏好没渲染进系统提示词')
      assert.match(prompt, /日报按工作类别组织/)
      assert.match(prompt, /午休/)
      assert.match(prompt, /导入/, '导入来的记忆必须标明来源不是本系统观察')
    })

    check('旧记录与采样片段都进了观察库，超期的那部分随后被保留期裁掉', () => {
      // 迁移先跑、保留期后跑：12 天前那天确实被导进来了，然后按 7 天保留期删掉。
      // 终态是 3 条而不是 4 条，正是"先搬再删"这个顺序留下的痕迹——反过来的话
      // 原文会在搬进来之前就被删掉，库里一条都不剩。
      assert.equal(countRows(storePath, 'SELECT COUNT(*) AS n FROM observations'), 3)
      assert.equal(
        countRows(storePath, `SELECT COUNT(*) AS n FROM observations WHERE source = 'activity_span'`),
        1,
        '昨天的片段留着，12 天前那条被保留期裁掉',
      )
      assert.equal(countRows(storePath, `SELECT COUNT(*) AS n FROM observations WHERE source = 'legacy_day_event'`), 1)
      assert.equal(countRows(storePath, `SELECT COUNT(*) AS n FROM observations WHERE source = 'user_note'`), 1)
    })

    check('旧日报按定稿/草稿两种状态登记，原文件一个字没动', () => {
      assert.equal(countRows(storePath, 'SELECT COUNT(*) AS n FROM reports'), 2)
      assert.equal(countRows(storePath, `SELECT COUNT(*) AS n FROM reports WHERE state = 'archived'`), 1)
      assert.equal(readFileSync(archivedPath, 'utf8'), '# 昨天的日报\n\n已经定稿。\n')
    })

    check('保留期真删了超期原文，当天的与 PID 文件都留着', () => {
      const left = readdirSync(sampleDir).sort()
      const expected = ['sampler.pid', `${TODAY}.jsonl`, `${YESTERDAY}.jsonl`].sort()
      assert.deepEqual(left, expected, `${STALE}.jsonl 该被删掉`)
      assert.match(harness.logs.join('\n'), /retention/, '保留期一条没删时不该出声，删了就该记一笔')
    })

    check('迁移是只读的：旧表一行都没被删（deleteLegacyAfterMigration 默认关）', () => {
      assert.deepEqual(preferences.deleted, [])
      assert.deepEqual(days.deleted, [])
      assert.deepEqual(reports.deleted, [])
      assert.equal(preferences.size, 2)
    })

    await checkAsync('采集被配置关掉时，开启助理模式的工具直接回绝，不静默启动', async () => {
      const result = await harness.callTool('personal_assistant_start')
      assert.equal(result.status, 'refused')
      assert.match(String(result.message), /captureActivity/)
      assert.equal(harness.domain.global.get().active, false, '回绝之后模式标记不该被置成开启')
    })

    await checkAsync('记忆工具走的是新库：列出来的就是导入的那两条', async () => {
      const result = await harness.callTool('personal_assistant_list_preferences')
      const memories = result.memories as Array<{ text: string; imported: boolean; status: string }>
      assert.equal(memories.length, 2)
      assert.ok(memories.every(item => item.imported), '两条都该标成导入')
      assert.ok(memories.every(item => item.status === 'confirmed'), '用户当时明确说过的偏好不该降级成候选')
    })

    const reportDir = path.join(home, 'personal-assistant', 'reports')
    const targetFile = path.join(reportDir, `${TODAY}.md`)
    const draftOne = '# 今日日报\n\n- 写季度总结 1 小时\n'
    const draftTwo = '# 今日日报（改过）\n\n- 写季度总结 1 小时\n- 需求评审 30 分钟\n'
    let confirmedDigest = ''

    await checkAsync('日报流程：存草稿 → 提交确认 → 落盘；摘要对不上就不写文件', async () => {
      const saved = await harness.callTool('personal_assistant_save_draft', { content: draftOne })
      assert.equal(saved.revision, 1)
      assert.equal(saved.state, 'draft')

      const submitted = await harness.callTool('personal_assistant_submit_report')
      assert.equal(submitted.submitted, true)
      assert.equal(submitted.revision, 1)
      assert.equal(submitted.digest, saved.digest, '提交给用户的摘要必须就是这一版的摘要')
      assert.equal(submitted.targetPath, targetFile)

      // 模型替用户"确认"时最容易编的就是摘要。编出来的摘要必须被挡住，且一个字都不落盘。
      const forged = await harness.callTool('personal_assistant_confirm_report', {
        revision: 1,
        digest: '编出来的摘要',
      })
      assert.equal(forged.confirmed, false)
      assert.equal(forged.reason, 'digest_mismatch')
      assert.equal(existsSync(targetFile), false, '确认没通过就不该创建目标文件')

      confirmedDigest = String(submitted.digest)
      const confirmed = await harness.callTool('personal_assistant_confirm_report', {
        revision: submitted.revision,
        digest: submitted.digest,
      })
      assert.equal(confirmed.confirmed, true)
      assert.equal(confirmed.modeExited, true, '定稿之后该自动退出助理模式')
      assert.equal(readFileSync(String(confirmed.savedPath), 'utf8'), draftOne)
      assert.deepEqual(readdirSync(reportDir), [`${TODAY}.md`], '版本化临时产物不该留下')
    })

    await checkAsync('定稿之后再改草稿：出新版本、旧确认作废、已归档的文件不被覆盖', async () => {
      const saved = await harness.callTool('personal_assistant_save_draft', { content: draftTwo })
      assert.equal(saved.revision, 2, '内容变了就该是新版本，不能在归档版本上改')

      const replay = await harness.callTool('personal_assistant_confirm_report', {
        revision: 1,
        digest: confirmedDigest,
      })
      assert.equal(replay.confirmed, false)
      assert.equal(replay.reason, 'stale_revision')
      assert.equal(readFileSync(targetFile, 'utf8'), draftOne, '新草稿还没确认，磁盘上必须还是定稿那份')

      const draft = await harness.callTool('personal_assistant_get_draft')
      assert.equal(draft.hasDraft, true)
      assert.equal(draft.revision, 2)
      assert.equal(draft.draft, draftTwo)
      const history = draft.history as Array<{ revision: number; state: string }>
      assert.deepEqual(history.map(item => item.revision).sort(), [1, 2])
      assert.ok(history.some(item => item.revision === 1 && item.state === 'archived'))
    })

    const before = countRows(storePath, 'SELECT COUNT(*) AS n FROM observations')
    harness.dispose()

    check('收尾与注册顺序相反：采样器 → 桥接 → 团队 → 主动提醒 → 助理库 → 存储域', () => {
      assert.deepEqual(harness.disposalOrder, [
        'personal-assistant:sampler',
        'personal-assistant:bridge',
        'personal-assistant:team',
        'personal-assistant:proactive',
        'personal-assistant:store',
        'personal-assistant:domain',
      ])
      assert.equal(harness.domain.closed, true)
      assert.equal(harness.disposers.length, 0)
    })

    // 插件重载就是再装配一次。旧数据还在、库也还在，这时候不能导成两份。
    const reloaded = createHarness(
      new FakeDomain({
        preferences: preferences as unknown as FakeTable<never>,
        days: days as unknown as FakeTable<never>,
        reports: reports as unknown as FakeTable<never>,
      }),
    )
    await checkAsync('重载不重复导入：偏好、记录、日报三批都按内容摘要跳过', async () => {
      await apply(reloaded.ctx, config)
      const migrationLogs = reloaded.logs.filter(line => line.includes('migration legacy-'))
      assert.equal(migrationLogs.length, 4)
      for (const batch of ['legacy-preferences', 'legacy-days', 'legacy-reports']) {
        const line = migrationLogs.find(item => item.includes(batch))
        assert.match(line ?? '', /skipped/, `${batch} 第二次不该重导`)
      }
      const prompt = reloaded.variable('personal_assistant_preferences') ?? ''
      assert.equal(prompt.split('日报按工作类别组织').length - 1, 1, '同一条偏好被注入了两遍')
      reloaded.dispose()
    })

    check('重载之后观察行数没变（片段那批会因原文被清理而重跑，靠主键幂等）', () => {
      assert.equal(countRows(storePath, 'SELECT COUNT(*) AS n FROM observations'), before)
    })
  } finally {
    harness.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

// ---------------------------------------------------------------------------
// 场景二：旧数据读不出来——迁移没跑完就不许开始采集
// ---------------------------------------------------------------------------

async function scenarioBrokenLegacy(root: string): Promise<void> {
  const home = path.join(root, 'broken')
  mkdirSync(path.join(home, 'personal-assistant', 'samples'), { recursive: true })

  const preferences = fakeTable<Preference>([
    ['pref-1', { id: 'pref-1', text: '日报按工作类别组织', createdAt: NOW - DAY }],
  ])
  // days 表读不出来（存储后端坏了 / 记录不合 schema），迁移必须老实说没跑完
  const days = fakeTable<DayRecord>([], '存储后端读不出 days 表')
  const reports = fakeTable<ReportMeta>([])
  const domain = new FakeDomain({
    preferences: preferences as unknown as FakeTable<never>,
    days: days as unknown as FakeTable<never>,
    reports: reports as unknown as FakeTable<never>,
  })

  const harness = createHarness(domain)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // 采集是开着的：挡住它的只能是迁移闸门，这样断言才有意义
    await apply(harness.ctx, configWith({}))

    check('迁移没跑完时日志点名了失败的批次，不是一句"迁移完成"', () => {
      const line = harness.logs.find(item => item.includes('migration legacy-days'))
      assert.match(line ?? '', /failed/)
      assert.match(line ?? '', /读旧数据失败/)
    })

    check('能搬的照搬：偏好那批成功了，用户教过的东西不因为别的表坏了就全丢', () => {
      assert.match(harness.variable('personal_assistant_preferences') ?? '', /日报按工作类别组织/)
    })

    await checkAsync('迁移未完成 → 开启助理模式被回绝，采样进程不启动', async () => {
      const result = await harness.callTool('personal_assistant_start')
      assert.equal(result.status, 'refused')
      assert.match(String(result.message), /迁移未完成/)
      assert.equal(harness.domain.global.get().active, false)
    })

    await checkAsync('状态说明如实讲"没在记录活动"，而不是"正在尝试恢复"', async () => {
      // 模式标记本来是关的，这里直接置成开启，模拟"上次开着、这次迁移坏了"。
      // 刻意不写 pid：跟踪器收尾时若没有子进程句柄，会退回按 state.pid 执行
      // taskkill /T /F——冒烟测试编一个 pid 等于在开发机上强杀恰好占用它的真实进程。
      await harness.domain.global.set({ active: true, startedAt: NOW })
      const status = await harness.callTool('personal_assistant_status')
      assert.match(String(status.mode), /没有在记录活动/)
      assert.match(String(status.mode), /迁移未完成/)
    })
  } finally {
    harness.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-apply-'))
  try {
    console.log('== 场景一：从旧版本升级')
    await scenarioUpgrade(root)
    console.log('\n== 场景二：旧数据读不出来')
    await scenarioBrokenLegacy(root)
    console.log(`\n全部通过：${passed} 项`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** 运行器入口：临时目录与假宿主的收尾必须发生在失败路径上，否则 Windows 会挡住目录删除。 */
export async function run(): Promise<void> {
  try {
    await main()
  } catch (error) {
    console.error('\n冒烟验证失败：', error)
    process.exitCode = 1
  }
}
