/**
 * 首次检查服务的编排测试。
 *
 * 重点不是 `buildFirstRunReport` 算得对不对（那是纯函数的测试），而是**这条接线的安全边界**：
 *
 *   - 用户确认的那一项，必须和主进程现在真的要下的那一项**逐字一致**才执行。
 *     中间模型被别处装好、镜像前缀改了、清单更新了 —— 都要退回"重新确认"，而不是照旧地址下。
 *   - `downloadPlan()` 只读缓存，不许顺手发网络请求或再跑一次 sha256。
 *
 * 这两个性质一旦破了，表现是"用户以为下的是 A、实际下的是 B"，或者"界面一打开就在偷偷读几百 MB"。
 * 所以它们各有一条独立断言，而不是混在 happy path 里。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { FirstRunService, toPlanItemView, toPlanView } from '../src/main/first-run-service.ts'
import type { ModelCheck } from '../src/main/model-resources.ts'
import { resolveAppLayout } from '../src/main/runtime-launch.ts'

const resources = path.join('C:', 'Users', 'u', 'AppData', 'Local', 'Programs', 'dsh', 'resources')
const layout = resolveAppLayout({ mainDir: path.join(resources, 'app.asar', 'dist', 'main'), isPackaged: true })

function tempUserData(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-firstrun-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录 */ } })
  return dir
}

/** 四个模型的检查结果。只给了要用的字段，其余按"完好"填。 */
function checksWith(missing: readonly string[]): ModelCheck[] {
  const all: Array<{ id: ModelCheck['id']; title: string; optional: boolean }> = [
    { id: 'sensevoice', title: '整句识别（SenseVoice）', optional: false },
    { id: 'streaming', title: '流式识别', optional: false },
    { id: 'diarization-segmentation', title: '会议分人（分段）', optional: true },
    { id: 'diarization-embedding', title: '会议分人（声纹）', optional: true },
  ]
  return all.map(entry => {
    const isMissing = missing.includes(entry.id)
    return {
      id: entry.id,
      title: entry.title,
      optional: entry.optional,
      state: isMissing ? 'missing' : 'complete',
      // 缺失项给一条占位文件记录，好让 planModelDownloads 认得出它是哪个文件。
      files: [],
      message: isMissing ? '还没安装' : '已就绪',
    } satisfies ModelCheck
  })
}

function service(t: { after: (fn: () => void) => void }, options: {
  missing?: readonly string[]
  macPermissions?: () => Promise<Record<string, 'granted' | 'denied' | 'unknown'>>
  mirror?: string | null
  inspect?: () => Promise<ModelCheck[]>
  fetchImpl?: (...args: never[]) => Promise<Response>
} = {}) {
  const userDataDir = tempUserData(t)
  let inspectCalls = 0
  const svc = new FirstRunService({
    userDataDir,
    platform: 'darwin',
    layout,
    dshHome: path.join(userDataDir, 'dsh-home'),
    profile: () => 'web',
    mediaAccess: () => 'granted',
    macPermissions: options.macPermissions as never,
    voiceApi: () => ({ asr: false, tts: false }),
    mirror: () => options.mirror ?? null,
    fetchImpl: options.fetchImpl as never,
    inspect: (async (root: string) => {
      inspectCalls += 1
      void root
      if (options.inspect) return options.inspect()
      return checksWith(options.missing ?? [])
    }) as never,
  })
  return { svc, userDataDir, inspectCalls: () => inspectCalls }
}

describe('首次检查：报告与计划', () => {
  test('模型缺失时报告把它列为需要处理，并给出下载入口', async t => {
    const { svc } = service(t, { missing: ['sensevoice'] })
    const snapshot = await svc.snapshot()
    assert.equal(snapshot.report.summary.ready, false)
    assert.ok(snapshot.report.items.some(item => item.id.startsWith('model:') && item.status === 'action'))
    assert.ok(snapshot.plan, '缺失模型必须能出下载计划')
    assert.equal(snapshot.planError, null)
    assert.ok(snapshot.plan!.items.some(item => item.modelId === 'sensevoice'))
  })

  test('模型全部就绪时 plan 为空（运行时尚缺不影响模型计划）', async t => {
    const { svc } = service(t)
    const snapshot = await svc.snapshot()
    assert.equal(snapshot.plan?.items.length, 0)

    // 临时 dshHome 里没有 profile，所以运行时那一项本来就该要用户处理 —— 但这与模型无关：
    // 模型项全部 ready，下载计划也就没有内容。这两件事分开断言，才不会把"环境没配好"
    // 误读成"模型没装好"。
    const modelItems = snapshot.report.items.filter(item => item.group === 'model')
    assert.ok(modelItems.length > 0)
    assert.equal(modelItems.every(item => item.status === 'ready'), true,
      `模型项应全部 ready，实际：${modelItems.map(item => `${item.id}=${item.status}`).join(',')}`)
  })

  test('镜像前缀非法时如实报错，不静默退回直连', async t => {
    const { svc } = service(t, { missing: ['sensevoice'], mirror: 'http://insecure.example/' })
    const snapshot = await svc.snapshot()
    assert.equal(snapshot.plan, null)
    assert.match(snapshot.planError ?? '', /https/)
  })

  test('macOS 权限探测失败不影响整份报告', async t => {
    const { svc } = service(t, { macPermissions: () => Promise.reject(new Error('osascript 挂了')) })
    const snapshot = await svc.snapshot()
    // 报告照出，权限项按 unknown 处理。
    assert.ok(snapshot.report.items.length > 0)
    assert.equal(snapshot.report.dataFlows.length > 0, true)
  })

  test('downloadPlan 复用已缓存的检查，不重复读盘', async t => {
    const { svc, inspectCalls } = service(t, { missing: ['sensevoice'] })
    await svc.snapshot()
    const before = inspectCalls()
    await svc.downloadPlan()
    await svc.downloadPlan()
    assert.equal(inspectCalls(), before, 'downloadPlan 不该重新检查模型')
  })
})

describe('下载确认：确认项与当前计划必须逐字一致', () => {
  test('模型下标对但地址被改过 → 拒绝执行，且不发请求', async t => {
    let fetched = 0
    const { svc } = service(t, {
      missing: ['sensevoice'],
      fetchImpl: (async () => { fetched += 1; throw new Error('不该发请求') }) as never,
    })
    await svc.snapshot()
    const outcome = await svc.download({
      modelId: 'sensevoice',
      url: 'https://evil.example/model.tar.bz2',
      destinationDir: '/somewhere',
    })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.stage, 'unconfirmed')
    assert.equal(outcome.retryable, false, '未确认不可重试：要用户重新看一遍')
    assert.equal(fetched, 0, '确认不符时一个请求都不能发')
  })

  test('目的地被改过 → 同样拒绝', async t => {
    const { svc } = service(t, { missing: ['sensevoice'] })
    const snapshot = await svc.snapshot()
    const item = snapshot.plan!.items[0]
    const outcome = await svc.download({
      modelId: item.modelId,
      url: item.url,
      destinationDir: path.join(item.destinationDir, 'nested'),
    })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.stage, 'unconfirmed')
  })

  test('模型已经装好（计划里没有这一项）→ 明确说不需要下载，而不是照旧地址下', async t => {
    let state = checksWith(['sensevoice'])
    const { svc } = service(t, { inspect: async () => state })
    await svc.snapshot()
    const item = (await svc.downloadPlan()).plan!.items[0]

    // 用户看计划的这段时间里，别处把模型装好了。
    state = checksWith([])
    await svc.snapshot()

    const outcome = await svc.download({ modelId: item.modelId, url: item.url, destinationDir: item.destinationDir })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.stage, 'unconfirmed')
    assert.match(outcome.error, /不需要下载/)
  })

  test('确认一致时才会真的走到下载（网络失败如实回报为可重试）', async t => {
    let requested: string | null = null
    const { svc } = service(t, {
      missing: ['sensevoice'],
      fetchImpl: (async (url: string) => {
        requested = url
        throw new Error('网络断了')
      }) as never,
    })
    const snapshot = await svc.snapshot()
    const item = snapshot.plan!.items[0]
    const outcome = await svc.download({ modelId: item.modelId, url: item.url, destinationDir: item.destinationDir })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    // 网络类失败可重试（界面能直接给"再试一次"），且确实请求了计划里的地址。
    assert.equal(outcome.retryable, true)
    assert.equal(requested, item.url)
  })
})

describe('计划视图：只把界面需要的字段递过去', () => {
  test('视图保留确认三要素，去掉本地文件清单', async t => {
    const { svc } = service(t, { missing: ['sensevoice'] })
    const snapshot = await svc.snapshot()
    const view = toPlanView(snapshot.plan!)
    assert.equal(view.items.length, snapshot.plan!.items.length)
    const first = view.items[0]
    assert.ok(first.modelId && first.url && first.destinationDir, '确认所需的三个字段必须在')
    assert.equal(first.requiresConfirmation, true)
    assert.equal(Object.hasOwn(first, 'writes'), false, '文件清单不进 IPC')

    const one = toPlanItemView(snapshot.plan!.items[0])
    assert.equal(one.modelId, snapshot.plan!.items[0].modelId)
    assert.equal(one.downloadBytes, snapshot.plan!.items[0].downloadBytes)
  })
})
