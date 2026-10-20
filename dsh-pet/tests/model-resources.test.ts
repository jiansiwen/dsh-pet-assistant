/**
 * 本地模型资源：清单、三态检查、下载计划（只产出待确认项）与经确认的下载执行。
 *
 * 钉住的几件事：
 * - 清单与读模型的代码（asr.ts / diarize.ts）用同一组落点，与 setup 脚本用同一组来源地址；
 * - 检查只有三态：缺失 / 损坏（大小或 sha256 不符）/ 完整，部分缺失算缺失；
 * - 计划是纯数据：生成时不发请求、不建目录，每一项都标着要确认；
 * - 执行必须带上与下载项一致的确认；校验不过的东西绝不落位，网络类失败重试，卡住按超时失败。
 *
 * 全部在临时目录里跑，不读用户的 userData。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  executeModelDownload,
  inspectModels,
  localModelRoot,
  mirrorFromEnv,
  MODEL_MANIFEST,
  normalizeMirror,
  planModelDownloads,
  STAGING_DIRNAME,
  tarSupportsBzip2,
  withMirror,
  type DownloadConfirmation,
  type DownloadDeps,
  type DownloadPlanItem,
  type FetchLike,
  type ModelCheck,
  type ModelSpec,
} from '../src/main/model-resources.ts'

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

const MODEL = Buffer.from('sense-voice-model-bytes')
const TOKENS = Buffer.from('tokens-table')
const ARCHIVE = Buffer.from('pretend-this-is-a-tar-bz2-archive')
const EMBEDDING = Buffer.from('speaker-embedding-model')

const ARCHIVE_SPEC: ModelSpec = {
  id: 'sensevoice',
  title: '测试整句模型',
  purpose: '测试用途',
  whenMissing: '测试影响',
  optional: false,
  files: [
    { path: 'model/model.int8.onnx', bytes: MODEL.length, sha256: sha(MODEL), archiveName: 'model.int8.onnx' },
    { path: 'model/tokens.txt', bytes: TOKENS.length, sha256: sha(TOKENS), archiveName: 'tokens.txt' },
  ],
  source: {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/test-model.tar.bz2',
    kind: 'tar.bz2',
    bytes: ARCHIVE.length,
    license: 'MIT',
    licenseUrl: 'https://example.com/LICENSE',
    licenseFile: { archivePrefix: 'LICENSE', path: 'model/LICENSE.txt' },
  },
}

const FILE_SPEC: ModelSpec = {
  id: 'diarization-embedding',
  title: '测试声纹模型',
  purpose: '测试用途',
  whenMissing: '测试影响',
  optional: true,
  files: [{ path: 'diarization/embedding.onnx', bytes: EMBEDDING.length, sha256: sha(EMBEDDING) }],
  source: {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/test-embedding.onnx',
    kind: 'file',
    bytes: EMBEDDING.length,
    license: 'Apache-2.0',
    licenseUrl: 'https://example.com/LICENSE',
  },
}

const TEST_MANIFEST: readonly ModelSpec[] = [ARCHIVE_SPEC, FILE_SPEC]

let roots: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'model-resources-'))
  roots.push(dir)
  return path.join(dir, 'local-asr')
}

afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  roots = []
})

function put(root: string, relative: string, data: Buffer): string {
  const file = path.join(root, ...relative.split('/'))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, data)
  return file
}

function checkOf(checks: readonly ModelCheck[], id: string): ModelCheck {
  const check = checks.find(entry => entry.id === id)
  assert.ok(check, `检查结果里没有 ${id}`)
  return check
}

describe('清单：与读模型的代码、setup 脚本说的是同一套东西', () => {
  test('每一项都有用途、来源、许可证、大小与 64 位十六进制 sha256', () => {
    const ids = new Set<string>()
    for (const spec of MODEL_MANIFEST) {
      assert.equal(ids.has(spec.id), false, `重复的模型 ${spec.id}`)
      ids.add(spec.id)
      assert.ok(spec.title && spec.purpose && spec.whenMissing, spec.id)
      assert.ok(spec.source.license && spec.source.licenseUrl.startsWith('https://'), spec.id)
      assert.ok(spec.source.url.startsWith('https://github.com/k2-fsa/sherpa-onnx/releases/download/'), spec.source.url)
      assert.ok(Number.isInteger(spec.source.bytes) && spec.source.bytes > 0, spec.id)
      assert.ok(spec.files.length > 0, spec.id)
      for (const file of spec.files) {
        assert.match(file.sha256, /^[0-9a-f]{64}$/, file.path)
        assert.ok(Number.isInteger(file.bytes) && file.bytes > 0, file.path)
        assert.match(file.path, /^(model|streaming|diarization)\/[A-Za-z0-9._-]+$/, file.path)
      }
      if (spec.source.kind === 'file') {
        assert.equal(spec.files.length, 1, '单文件下载只能对应一个落点文件')
        assert.equal(spec.source.bytes, spec.files[0].bytes, '单文件下载的大小就是文件大小')
      } else {
        for (const file of spec.files) assert.ok(file.archiveName, `${file.path} 缺下载包里的文件名`)
      }
    }
    // KWS 是扩展点，由唤醒负责人补；这里只确认四个已知模型都在。
    assert.deepEqual([...ids].sort(), ['diarization-embedding', 'diarization-segmentation', 'sensevoice', 'streaming'])
  })

  test('来源地址与 setup-local-asr 的 .ps1 / .sh 完全一致（镜像前缀加在同样的地址前面）', () => {
    const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
    const ps1 = readFileSync(path.join(scripts, 'setup-local-asr.ps1'), 'utf8')
    const sh = readFileSync(path.join(scripts, 'setup-local-asr.sh'), 'utf8')
    for (const spec of MODEL_MANIFEST) {
      assert.equal(ps1.includes(spec.source.url), true, `setup-local-asr.ps1 里没有 ${spec.source.url}`)
      assert.equal(sh.includes(spec.source.url), true, `setup-local-asr.sh 里没有 ${spec.source.url}`)
    }
  })

  test('落点与 asr.ts / diarize.ts 读模型的路径一致：按清单放好文件，读取方就认为装好了', async () => {
    const { localAsrAvailable, streamingAvailable } = await import('../src/main/asr.ts')
    const { diarizationModelPaths, diarizationModelStatus } = await import('../src/main/diarize.ts')
    const root = tempRoot()
    const userData = path.dirname(root)
    assert.equal(localModelRoot(userData), root)
    for (const spec of MODEL_MANIFEST) {
      for (const file of spec.files) {
        // 读取方只看存在与否（分人模型另有 1MB 下限），不必写出真实大小。
        put(root, file.path, Buffer.alloc(file.path.startsWith('diarization/') ? 1_000_001 : 1))
      }
    }
    assert.equal(localAsrAvailable(userData), true)
    assert.equal(streamingAvailable(userData), true)
    assert.equal(diarizationModelStatus(userData).ok, true)
    const diar = diarizationModelPaths(userData)
    assert.deepEqual(
      [diar.segmentation, diar.embedding],
      ['diarization/segmentation.onnx', 'diarization/embedding.onnx'].map(file => path.join(root, ...file.split('/'))),
    )
    // 逐个删掉清单文件，对应的读取方必须跟着判"没装"。
    const probe: Record<string, () => boolean> = {
      sensevoice: () => localAsrAvailable(userData),
      streaming: () => streamingAvailable(userData),
      'diarization-segmentation': () => diarizationModelStatus(userData).ok,
      'diarization-embedding': () => diarizationModelStatus(userData).ok,
    }
    for (const spec of MODEL_MANIFEST) {
      for (const file of spec.files) {
        const absolute = path.join(root, ...file.path.split('/'))
        const kept = readFileSync(absolute)
        rmSync(absolute)
        assert.equal(probe[spec.id](), false, `删掉 ${file.path} 后读取方仍判可用`)
        writeFileSync(absolute, kept)
      }
    }
  })
})

describe('inspectModels：缺失 / 损坏 / 完整 三态', () => {
  test('什么都没装 → 缺失，而且检查不会顺手建目录', async () => {
    const root = tempRoot()
    const checks = await inspectModels(root, TEST_MANIFEST)
    assert.deepEqual(checks.map(check => check.state), ['missing', 'missing'])
    assert.match(checkOf(checks, 'sensevoice').message, /未安装/)
    assert.equal(existsSync(root), false)
  })

  test('只装了一部分 → 仍是缺失，并点名缺哪个文件', async () => {
    const root = tempRoot()
    put(root, 'model/model.int8.onnx', MODEL)
    const check = checkOf(await inspectModels(root, TEST_MANIFEST), 'sensevoice')
    assert.equal(check.state, 'missing')
    assert.match(check.message, /不完整/)
    assert.match(check.message, /tokens\.txt/)
    assert.deepEqual(check.files.map(file => file.state), ['complete', 'missing'])
  })

  test('大小不符 → 损坏，不必算哈希就能认出截断的下载', async () => {
    const root = tempRoot()
    put(root, 'diarization/embedding.onnx', EMBEDDING.subarray(0, 5))
    let hashed = 0
    const check = checkOf(await inspectModels(root, TEST_MANIFEST, { hashFile: async () => { hashed += 1; return '' } }), 'diarization-embedding')
    assert.equal(check.state, 'corrupt')
    assert.equal(check.files[0].problem, 'size')
    assert.equal(check.files[0].actualBytes, 5)
    assert.equal(hashed, 0)
  })

  test('大小相同、内容不同 → 损坏（sha256 不符），提示可能是同名的其他版本', async () => {
    const root = tempRoot()
    put(root, 'diarization/embedding.onnx', Buffer.alloc(EMBEDDING.length, 0x61))
    const check = checkOf(await inspectModels(root, TEST_MANIFEST), 'diarization-embedding')
    assert.equal(check.state, 'corrupt')
    assert.equal(check.files[0].problem, 'hash')
    assert.match(check.message, /sha256 不符/)
    assert.match(check.message, /其他版本/)
  })

  test('有一个文件损坏、另一个缺失 → 判损坏：损坏的文件要先处理', async () => {
    const root = tempRoot()
    put(root, 'model/model.int8.onnx', Buffer.alloc(MODEL.length))
    assert.equal(checkOf(await inspectModels(root, TEST_MANIFEST), 'sensevoice').state, 'corrupt')
  })

  test('大小与 sha256 都对 → 完整', async () => {
    const root = tempRoot()
    put(root, 'model/model.int8.onnx', MODEL)
    put(root, 'model/tokens.txt', TOKENS)
    put(root, 'diarization/embedding.onnx', EMBEDDING)
    const checks = await inspectModels(root, TEST_MANIFEST)
    assert.deepEqual(checks.map(check => check.state), ['complete', 'complete'])
    assert.match(checkOf(checks, 'sensevoice').message, /已安装/)
  })

  test('该是文件的地方是个目录 → 损坏（读不了），不当成已安装', async () => {
    const root = tempRoot()
    mkdirSync(path.join(root, 'diarization', 'embedding.onnx'), { recursive: true })
    const check = checkOf(await inspectModels(root, TEST_MANIFEST), 'diarization-embedding')
    assert.equal(check.state, 'corrupt')
    assert.equal(check.files[0].problem, 'unreadable')
  })
})

/** 一份检查结果：sensevoice 缺失、embedding 损坏。 */
async function brokenChecks(root: string): Promise<ModelCheck[]> {
  put(root, 'diarization/embedding.onnx', Buffer.alloc(EMBEDDING.length, 0x62))
  return inspectModels(root, TEST_MANIFEST)
}

function planItems(root: string, checks: readonly ModelCheck[], mirror: string | null = null): readonly DownloadPlanItem[] {
  const result = planModelDownloads(checks, { root, mirror, manifest: TEST_MANIFEST })
  if (!result.ok) throw new assert.AssertionError({ message: result.error })
  return result.plan.items
}

describe('planModelDownloads：只产出需要用户确认的下载项', () => {
  test('完整的模型不进计划；缺失与损坏各成一项，并写明来源、大小、许可证与去向', async () => {
    const root = tempRoot()
    put(root, 'model/model.int8.onnx', MODEL)
    put(root, 'model/tokens.txt', TOKENS)
    const complete = await inspectModels(root, TEST_MANIFEST)
    assert.deepEqual(planItems(root, complete.filter(check => check.id === 'sensevoice')), [])

    const other = tempRoot()
    const items = planItems(other, await brokenChecks(other))
    assert.deepEqual(items.map(item => [item.modelId, item.reason]), [['sensevoice', 'missing'], ['diarization-embedding', 'corrupt']])
    const [missing, corrupt] = items
    assert.equal(missing.url, ARCHIVE_SPEC.source.url)
    assert.equal(missing.upstreamUrl, ARCHIVE_SPEC.source.url)
    assert.equal(missing.downloadBytes, ARCHIVE.length)
    assert.equal(missing.installBytes, MODEL.length + TOKENS.length)
    assert.equal(missing.license, 'MIT')
    assert.equal(missing.destinationDir, path.join(other, 'model'))
    assert.deepEqual(missing.writes, [path.join(other, 'model', 'model.int8.onnx'), path.join(other, 'model', 'tokens.txt')])
    assert.deepEqual(missing.replaces, [])
    assert.deepEqual(corrupt.replaces, [path.join(other, 'diarization', 'embedding.onnx')])
    for (const item of items) assert.equal(item.requiresConfirmation, true)
  })

  test('计划是纯数据：生成时不发请求、不建目录，原样过一遍 JSON 不丢东西', async t => {
    const root = tempRoot()
    const checks = await inspectModels(root, TEST_MANIFEST)
    const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('生成计划时不应发请求') })
    const result = planModelDownloads(checks, { root, mirror: 'https://gh-proxy.com/', manifest: TEST_MANIFEST })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(request.mock.callCount(), 0)
    assert.equal(existsSync(root), false)
    assert.deepEqual(JSON.parse(JSON.stringify(result.plan)), result.plan)
    assert.equal(result.plan.totalDownloadBytes, ARCHIVE.length + EMBEDDING.length)
    assert.match(result.plan.notes.join('\n'), /确认后才会开始下载/)
  })

  test('镜像前缀沿用 setup 脚本的 MIRROR 语义：去掉末尾斜杠，接在完整的上游地址前面', async () => {
    const root = tempRoot()
    const items = planItems(root, await inspectModels(root, TEST_MANIFEST), 'https://gh-proxy.com//')
    assert.equal(items[0].url, `https://gh-proxy.com/${ARCHIVE_SPEC.source.url}`)
    assert.equal(items[0].upstreamUrl, ARCHIVE_SPEC.source.url)
    assert.equal(items[0].mirror, 'https://gh-proxy.com')
    assert.equal(withMirror('https://github.com/a', null), 'https://github.com/a')
    assert.equal(withMirror('https://github.com/a', 'https://ghproxy.net/'), 'https://ghproxy.net/https://github.com/a')
  })

  test('不像地址前缀的镜像直接拒绝，不拼出一个奇怪的地址去请求', async () => {
    const root = tempRoot()
    const checks = await inspectModels(root, TEST_MANIFEST)
    for (const mirror of ['ghproxy.net', 'http://ghproxy.net/', 'ftp://x/', 'https://', 'https://a b/']) {
      const result = planModelDownloads(checks, { root, mirror, manifest: TEST_MANIFEST })
      assert.equal(result.ok, false, mirror)
    }
    assert.deepEqual(normalizeMirror('  '), { ok: true, mirror: null })
    assert.deepEqual(normalizeMirror(undefined), { ok: true, mirror: null })
  })

  test('环境变量 MIRROR 与 setup-local-asr.sh 同名', () => {
    assert.equal(mirrorFromEnv({ MIRROR: ' https://gh-proxy.com/ ' }), 'https://gh-proxy.com/')
    assert.equal(mirrorFromEnv({}), null)
    assert.equal(mirrorFromEnv({ MIRROR: '' }), null)
  })
})

// ===== 执行 =====

function confirmationOf(item: DownloadPlanItem): DownloadConfirmation {
  return { modelId: item.modelId, url: item.url, destinationDir: item.destinationDir }
}

function serve(...steps: Array<Buffer | number | Error>): { fetch: FetchLike; calls: () => number } {
  let calls = 0
  return {
    fetch: async () => {
      const step = steps[Math.min(calls, steps.length - 1)]
      calls += 1
      if (step instanceof Error) throw step
      if (typeof step === 'number') return new Response('error page', { status: step })
      return new Response(new Uint8Array(step))
    },
    calls: () => calls,
  }
}

function quietDeps(extra: Partial<DownloadDeps> = {}): DownloadDeps {
  return { manifest: TEST_MANIFEST, sleep: async () => undefined, retryDelayMs: 1, ...extra }
}

/** 假解压：往解压目录里写出包内容（含同名变体与许可文件），不碰真实的 tar。 */
function fakeExtract(files: Record<string, Buffer>): NonNullable<DownloadDeps['extract']> {
  return async (_archive, into) => {
    for (const [relative, data] of Object.entries(files)) put(into, relative, data)
  }
}

describe('executeModelDownload：必须经确认，校验通过才落位', () => {
  test('没有确认 → 拒绝执行，一个请求都不发，什么也不写', async () => {
    const root = tempRoot()
    const [item] = planItems(root, await inspectModels(root, TEST_MANIFEST))
    const server = serve(ARCHIVE)
    const outcome = await executeModelDownload(item, null, quietDeps({ fetch: server.fetch }))
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.stage, 'unconfirmed')
    assert.equal(outcome.retryable, false)
    assert.equal(server.calls(), 0)
    assert.equal(existsSync(root), false)
  })

  test('确认时看到的地址与现在不一致（比如中途换了镜像）→ 拒绝，要重新确认', async () => {
    const root = tempRoot()
    const checks = await inspectModels(root, TEST_MANIFEST)
    const [confirmed] = planItems(root, checks)
    const [current] = planItems(root, checks, 'https://gh-proxy.com/')
    const server = serve(ARCHIVE)
    const outcome = await executeModelDownload(current, confirmationOf(confirmed), quietDeps({ fetch: server.fetch }))
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.equal(outcome.stage, 'unconfirmed')
    assert.equal(server.calls(), 0)
  })

  test('单文件：第一次网络出错、第二次成功 → 自动重试后落位，临时目录清掉', async () => {
    const root = tempRoot()
    const item = planItems(root, await inspectModels(root, TEST_MANIFEST)).find(entry => entry.modelId === 'diarization-embedding')!
    const server = serve(new TypeError('fetch failed'), EMBEDDING)
    const waits: number[] = []
    const outcome = await executeModelDownload(item, confirmationOf(item), quietDeps({
      fetch: server.fetch,
      sleep: async ms => { waits.push(ms) },
      retryDelayMs: 100,
    }))
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    if (!outcome.ok) return
    assert.equal(outcome.attempts, 2)
    assert.deepEqual(waits, [100])
    assert.deepEqual(readFileSync(path.join(root, 'diarization', 'embedding.onnx')), EMBEDDING)
    assert.equal(existsSync(path.join(root, STAGING_DIRNAME)), false)
    assert.equal(checkOf(await inspectModels(root, TEST_MANIFEST), 'diarization-embedding').state, 'complete')
  })

  test('服务器 503 后恢复 → 重试成功；404 → 不重试，直接报地址问题', async () => {
    const root = tempRoot()
    const item = planItems(root, await inspectModels(root, TEST_MANIFEST)).find(entry => entry.modelId === 'diarization-embedding')!
    const recovered = await executeModelDownload(item, confirmationOf(item), quietDeps({ fetch: serve(503, EMBEDDING).fetch }))
    assert.equal(recovered.ok, true, JSON.stringify(recovered))

    const other = tempRoot()
    const missing = planItems(other, await inspectModels(other, TEST_MANIFEST)).find(entry => entry.modelId === 'diarization-embedding')!
    const server = serve(404)
    const outcome = await executeModelDownload(missing, confirmationOf(missing), quietDeps({ fetch: server.fetch }))
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.stage, 'download')
    assert.equal(outcome.attempts, 1)
    assert.equal(server.calls(), 1)
    assert.match(outcome.error, /HTTP 404/)
    assert.equal(outcome.retryable, true)
  })

  test('下载内容总是截断 → 重试到上限后失败，已有的（损坏）文件原样不动', async () => {
    const root = tempRoot()
    const checks = await brokenChecks(root)
    const before = readFileSync(path.join(root, 'diarization', 'embedding.onnx'))
    const item = planItems(root, checks).find(entry => entry.modelId === 'diarization-embedding')!
    const server = serve(EMBEDDING.subarray(0, 4))
    const outcome = await executeModelDownload(item, confirmationOf(item), quietDeps({ fetch: server.fetch, maxAttempts: 3 }))
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.stage, 'download')
    assert.equal(outcome.attempts, 3)
    assert.equal(server.calls(), 3)
    assert.match(outcome.error, /字节/)
    assert.deepEqual(readFileSync(path.join(root, 'diarization', 'embedding.onnx')), before)
    assert.equal(existsSync(path.join(root, STAGING_DIRNAME)), false)
  })

  test('大小对、sha256 不对 → 校验失败，不落位，也不白白重下', async () => {
    const root = tempRoot()
    const checks = await brokenChecks(root)
    const before = readFileSync(path.join(root, 'diarization', 'embedding.onnx'))
    const item = planItems(root, checks).find(entry => entry.modelId === 'diarization-embedding')!
    const server = serve(Buffer.alloc(EMBEDDING.length, 0x7a))
    const outcome = await executeModelDownload(item, confirmationOf(item), quietDeps({ fetch: server.fetch }))
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.stage, 'verify')
    assert.equal(server.calls(), 1)
    assert.deepEqual(readFileSync(path.join(root, 'diarization', 'embedding.onnx')), before)
  })

  test('压缩包：按文件名 + 大小 + sha256 认出清单文件，同名变体被跳过，许可文件一并放好', async () => {
    const root = tempRoot()
    const [item] = planItems(root, await inspectModels(root, TEST_MANIFEST))
    const outcome = await executeModelDownload(item, confirmationOf(item), quietDeps({
      fetch: serve(ARCHIVE).fetch,
      extract: fakeExtract({
        // 同名、同大小、内容不同的变体（上游包里 64/、96/ 子目录就是这种情况）。
        'pkg/64/model.int8.onnx': Buffer.alloc(MODEL.length, 0x30),
        'pkg/model.int8.onnx': MODEL,
        'pkg/tokens.txt': TOKENS,
        'pkg/LICENSE': Buffer.from('MIT License'),
      }),
    }))
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    assert.deepEqual(readFileSync(path.join(root, 'model', 'model.int8.onnx')), MODEL)
    assert.deepEqual(readFileSync(path.join(root, 'model', 'tokens.txt')), TOKENS)
    assert.equal(readFileSync(path.join(root, 'model', 'LICENSE.txt'), 'utf8'), 'MIT License')
    assert.equal(existsSync(path.join(root, STAGING_DIRNAME)), false)
  })

  test('压缩包里第二个文件对不上 → 一个都不落位（第一个校验过的也不放进去）', async () => {
    const root = tempRoot()
    put(root, 'model/model.int8.onnx', Buffer.alloc(MODEL.length, 0x31))
    const before = readFileSync(path.join(root, 'model', 'model.int8.onnx'))
    const [item] = planItems(root, await inspectModels(root, TEST_MANIFEST))
    const outcome = await executeModelDownload(item, confirmationOf(item), quietDeps({
      fetch: serve(ARCHIVE).fetch,
      extract: fakeExtract({ 'pkg/model.int8.onnx': MODEL, 'pkg/tokens.txt': Buffer.from('other-tokens') }),
    }))
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.stage, 'verify')
    assert.match(outcome.error, /tokens\.txt/)
    assert.deepEqual(readFileSync(path.join(root, 'model', 'model.int8.onnx')), before)
    assert.equal(existsSync(path.join(root, 'model', 'tokens.txt')), false)
  })

  test('解压失败 → 报解压阶段，不落位任何文件', async () => {
    const root = tempRoot()
    const [item] = planItems(root, await inspectModels(root, TEST_MANIFEST))
    const outcome = await executeModelDownload(item, confirmationOf(item), quietDeps({
      fetch: serve(ARCHIVE).fetch,
      extract: async () => { throw new Error('本机的 tar 不支持 .tar.bz2') },
    }))
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.stage, 'extract')
    assert.match(outcome.error, /tar/)
    assert.equal(existsSync(path.join(root, 'model')), false)
  })

  test('连上了但一直收不到数据 → 按空闲超时失败，不无限等待', async () => {
    const root = tempRoot()
    const item = planItems(root, await inspectModels(root, TEST_MANIFEST)).find(entry => entry.modelId === 'diarization-embedding')!
    const stalled: FetchLike = async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
      },
    }))
    const outcome = await executeModelDownload(item, confirmationOf(item), quietDeps({ fetch: stalled, idleTimeoutMs: 30, maxAttempts: 1 }))
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.stage, 'download')
    assert.match(outcome.error, /没有收到数据/)
  })

  test('取消 → 报已取消，不再重试', async () => {
    const root = tempRoot()
    const [item] = planItems(root, await inspectModels(root, TEST_MANIFEST))
    const controller = new AbortController()
    controller.abort()
    const server = serve(ARCHIVE)
    const outcome = await executeModelDownload(item, confirmationOf(item), quietDeps({ fetch: server.fetch, signal: controller.signal }))
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.equal(outcome.stage, 'cancelled')
    assert.equal(server.calls(), 0)
  })

  test('同一个模型同时只跑一份：第二份直接报正在下载', async () => {
    const root = tempRoot()
    const item = planItems(root, await inspectModels(root, TEST_MANIFEST)).find(entry => entry.modelId === 'diarization-embedding')!
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const slow: FetchLike = async () => {
      await gate
      return new Response(new Uint8Array(EMBEDDING))
    }
    const first = executeModelDownload(item, confirmationOf(item), quietDeps({ fetch: slow }))
    const second = await executeModelDownload(item, confirmationOf(item), quietDeps({ fetch: slow }))
    assert.equal(second.ok, false)
    if (!second.ok) assert.equal(second.stage, 'busy')
    release()
    assert.equal((await first).ok, true)
    assert.deepEqual(readdirSync(path.join(root, 'diarization')), ['embedding.onnx'])
  })
})

describe('tarSupportsBzip2：先认出本机 tar 能不能解，免得卡在找不到的外部 bzip2 上', () => {
  test('GNU tar 与带 bz2lib 的 bsdtar（macOS、新版 Windows 11）可以', () => {
    assert.equal(tarSupportsBzip2('tar (GNU tar) 1.35\nCopyright (C) 2023 Free Software Foundation, Inc.'), true)
    assert.equal(tarSupportsBzip2('bsdtar 3.5.3 - libarchive 3.5.3 zlib/1.2.12 liblzma/5.0.5 bz2lib/1.0.8'), true)
    assert.equal(tarSupportsBzip2('bsdtar 3.7.2 - libarchive 3.7.2 zlib/1.2.13.1-motley liblzma/5.4.1 bz2lib/1.0.8 libzstd/1.5.5'), true)
  })

  test('只有 zlib 的 Windows 自带 bsdtar → 不行；认不出的输出也按不行处理', () => {
    assert.equal(tarSupportsBzip2('bsdtar 3.3.2 - libarchive 3.3.2 zlib/1.2.5.f-ipp'), false)
    // 本机（2026-10-18）System32\tar.exe 的实际输出。
    assert.equal(tarSupportsBzip2('bsdtar 3.5.2 - libarchive 3.5.2 zlib/1.2.5.f-ipp '), false)
    assert.equal(tarSupportsBzip2(''), false)
    assert.equal(tarSupportsBzip2('something else 1.0'), false)
  })
})
