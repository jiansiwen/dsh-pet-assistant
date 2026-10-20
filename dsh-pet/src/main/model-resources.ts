/**
 * 本地语音模型：清单、完整性检查、下载计划，以及经用户确认后的下载执行（M5-06）。
 *
 * 四块按副作用从小到大排列，彼此不越界：
 * 1. **清单** `MODEL_MANIFEST`：每个模型的用途、落点文件、大小、sha256、来源与许可证。
 *    sha256 是 2026-10-18 用本机经 setup-local-asr 脚本装好的文件实算的；下载大小取自上游的
 *    Content-Length（声纹模型是单文件，上游大小与本机文件大小一致，说明本机那份是完整的）。
 * 2. **检查** `inspectModels`：只读 `<userData>/local-asr` 下清单列出的文件，结果三态：
 *    缺失 / 损坏（大小或 sha256 与清单不符）/ 完整。不读别的目录，不写任何东西。
 * 3. **计划** `planModelDownloads`：纯函数，只产出"需要用户确认的下载项"（来源、大小、许可证、去向）。
 *    不发请求、不建目录 —— 下不下载由界面问过用户之后决定。
 * 4. **执行** `executeModelDownload`：必须带上与下载项一致的确认才会联网；临时文件放在与落点
 *    同一个盘的 `.staging` 里 → 逐个校验 sha256 → 改名落位。校验不过的文件绝不落位，
 *    网络类失败自动重试，卡住（长时间收不到数据）按超时失败，不无限等待。
 *
 * 不 import electron、不 import sherpa-onnx-node：能直接进 `node --test`，首次检查也不必先加载原生模块。
 * 读模型的代码（asr.ts / diarize.ts / kws.ts）各自按同一组相对路径找文件，测试里有交叉核对。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'

// ===== 清单 =====

/**
 * 清单里的模型。
 *
 * 扩展点（M1-02 本地唤醒）：`local-asr/kws/` 的唤醒词模型由唤醒负责人补进来 —— 在这里加 `'kws'`，
 * 并在 `MODEL_MANIFEST` 末尾追加一条（落点取 kws.ts 的 `kwsModelPaths`，sha256 用装好的文件实算）。
 * 检查、计划、执行三块都按清单数据工作，不需要为新模型改代码。
 */
export type ModelId = 'sensevoice' | 'streaming' | 'diarization-segmentation' | 'diarization-embedding'

export interface ModelFile {
  /** 相对 local-asr 根目录的落点，正斜杠分隔。读取方用的是同一组名字。 */
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  /** 在下载包里的文件名；按"文件名 + 大小 + sha256"认，包里有同名变体也不会认错。单文件下载时省略。 */
  readonly archiveName?: string
}

export interface ModelSource {
  /** 上游地址（GitHub release，与 setup-local-asr 脚本相同）。镜像前缀在生成下载计划时才加。 */
  readonly url: string
  readonly kind: 'tar.bz2' | 'file'
  /** 下载大小（字节）。 */
  readonly bytes: number
  readonly license: string
  readonly licenseUrl: string
  /** 包里随附的许可文件：解压后一并放到落点旁边（与脚本一致），不参与完整性判断。 */
  readonly licenseFile?: { readonly archivePrefix: string; readonly path: string }
}

export interface ModelSpec {
  readonly id: ModelId
  readonly title: string
  /** 用途，给用户看。 */
  readonly purpose: string
  /** 不装它会怎样，给用户看。 */
  readonly whenMissing: string
  /** 可选能力（缺了不影响听写主流程）。首次检查据此分"需要处理"与"可选"。 */
  readonly optional: boolean
  readonly files: readonly ModelFile[]
  readonly source: ModelSource
}

const GITHUB_RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'

export const MODEL_MANIFEST: readonly ModelSpec[] = [
  {
    id: 'sensevoice',
    title: 'SenseVoice 整句识别模型',
    purpose: '本地听写的整句识别（说完一句再转写），也用于会议的逐段转写；支持中、英、日、韩、粤语。音频只在本机处理。',
    whenMissing: '流式模型在时仍可边说边出字，但会议转写与整句回退不可用；两种模型都没有时，Windows 退回系统自带识别（准确率较低），macOS 上听写不可用。',
    optional: false,
    files: [
      { path: 'model/model.int8.onnx', bytes: 239_233_841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51', archiveName: 'model.int8.onnx' },
      { path: 'model/tokens.txt', bytes: 315_894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc', archiveName: 'tokens.txt' },
    ],
    source: {
      url: `${GITHUB_RELEASES}/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`,
      kind: 'tar.bz2',
      bytes: 163_002_883,
      license: 'FunASR 模型许可（SenseVoiceSmall 上游模型许可，非 OSI 开源许可，使用前请阅读）',
      licenseUrl: 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE',
    },
  },
  {
    id: 'streaming',
    title: '流式 Zipformer 中英识别模型',
    purpose: '边说边出字的本地听写（中英双语）。音频只在本机处理。',
    whenMissing: '听写只能说完整句再出字（需要 SenseVoice 模型）；两种模型都没有时，Windows 退回系统自带识别，macOS 上听写不可用。',
    optional: false,
    files: [
      { path: 'streaming/encoder.int8.onnx', bytes: 42_980_793, sha256: 'db6f51551762e40e549166fe041ea3e45464370b595e9ad23f06478ec3794fbb', archiveName: 'encoder-epoch-99-avg-1.int8.onnx' },
      { path: 'streaming/decoder.int8.onnx', bytes: 3_486_740, sha256: '4b618d383af304cfae281dbf0a53e8bf442c2f0502256cd5694bd6567ebdd834', archiveName: 'decoder-epoch-99-avg-1.int8.onnx' },
      { path: 'streaming/joiner.int8.onnx', bytes: 3_228_485, sha256: 'bdda356d6f9b8c2d7cee9ee0e26075fa537490f7fd06520be408d287073667b9', archiveName: 'joiner-epoch-99-avg-1.int8.onnx' },
      { path: 'streaming/tokens.txt', bytes: 56_317, sha256: 'a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3', archiveName: 'tokens.txt' },
    ],
    source: {
      url: `${GITHUB_RELEASES}/asr-models/sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16.tar.bz2`,
      kind: 'tar.bz2',
      bytes: 458_187_351,
      license: 'Apache-2.0（转换自 csukuangfj/k2fsa-zipformer-bilingual-zh-en-t，社区贡献模型）',
      licenseUrl: 'https://huggingface.co/csukuangfj/k2fsa-zipformer-bilingual-zh-en-t',
    },
  },
  {
    id: 'diarization-segmentation',
    title: '说话人分段模型（pyannote segmentation-3.0）',
    purpose: '会议录音会后按音色分人：找出每段话从哪里开始、到哪里结束。本地推理，不上传音频。',
    whenMissing: '会议照常录音和转写，但不会自动分出说话人（纪要里标"未自动分人"）。',
    optional: true,
    files: [
      { path: 'diarization/segmentation.onnx', bytes: 5_992_913, sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079', archiveName: 'model.onnx' },
    ],
    source: {
      url: `${GITHUB_RELEASES}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
      kind: 'tar.bz2',
      bytes: 6_958_444,
      license: 'MIT（pyannote.audio，© 2022 CNRS；许可文件随包附带）',
      licenseUrl: 'https://github.com/pyannote/pyannote-audio/blob/develop/LICENSE',
      licenseFile: { archivePrefix: 'LICENSE', path: 'diarization/LICENSE.segmentation.txt' },
    },
  },
  {
    id: 'diarization-embedding',
    title: '声纹嵌入模型（3D-Speaker ERes2Net base）',
    purpose: '会议分人时区分不同说话人的音色。只在同一场会议的同一条音轨内比较，不提取、不保存声纹，不建跨会议声纹库。',
    whenMissing: '会议照常录音和转写，但不会自动分出说话人（纪要里标"未自动分人"）。',
    optional: true,
    files: [
      { path: 'diarization/embedding.onnx', bytes: 39_593_761, sha256: '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b' },
    ],
    source: {
      url: `${GITHUB_RELEASES}/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`,
      kind: 'file',
      bytes: 39_593_761,
      license: 'Apache-2.0（modelscope/3D-Speaker）',
      licenseUrl: 'https://github.com/modelscope/3D-Speaker/blob/main/LICENSE',
    },
  },
]

/** 模型根目录名。与 setup-local-asr 脚本、asr.ts / diarize.ts / kws.ts 的落点一致。 */
export const LOCAL_ASR_DIRNAME = 'local-asr'

/** 下载与解压的临时目录名（在模型根目录下，与落点同盘，改名才是原子的）。 */
export const STAGING_DIRNAME = '.staging'

export function localModelRoot(userDataDir: string): string {
  return path.join(userDataDir, LOCAL_ASR_DIRNAME)
}

function absoluteOf(root: string, relative: string): string {
  return path.join(root, ...relative.split('/'))
}

// ===== 检查 =====

/** 三态。部分文件缺失算"缺失"；任何一个文件与清单不符就算"损坏"。 */
export type ModelState = 'missing' | 'corrupt' | 'complete'

export type FileProblem = 'missing' | 'size' | 'hash' | 'unreadable'

export interface FileCheck {
  readonly file: string
  readonly relative: string
  readonly state: ModelState
  readonly problem: FileProblem | null
  readonly expectedBytes: number
  readonly actualBytes: number | null
}

export interface ModelCheck {
  readonly id: ModelId
  readonly title: string
  readonly optional: boolean
  readonly state: ModelState
  readonly files: readonly FileCheck[]
  /** 给用户看的一句话。 */
  readonly message: string
}

export interface InspectDeps {
  /** 测试注入；默认流式计算 sha256。 */
  readonly hashFile?: (file: string) => Promise<string>
}

/** 流式算 sha256：两百多 MB 的模型不整块读进内存。 */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function checkFile(root: string, spec: ModelFile, hashFile: (file: string) => Promise<string>): Promise<FileCheck> {
  const file = absoluteOf(root, spec.path)
  const base = { file, relative: spec.path, expectedBytes: spec.bytes }
  let size: number
  try {
    const info = await stat(file)
    if (!info.isFile()) return { ...base, state: 'corrupt', problem: 'unreadable', actualBytes: null }
    size = info.size
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ...base, state: 'missing', problem: 'missing', actualBytes: null }
    return { ...base, state: 'corrupt', problem: 'unreadable', actualBytes: null }
  }
  // 先比大小：截断的下载用不着算两百多 MB 的哈希就能认出来。
  if (size !== spec.bytes) return { ...base, state: 'corrupt', problem: 'size', actualBytes: size }
  let digest: string
  try {
    digest = await hashFile(file)
  } catch {
    return { ...base, state: 'corrupt', problem: 'unreadable', actualBytes: size }
  }
  if (digest.toLowerCase() !== spec.sha256) return { ...base, state: 'corrupt', problem: 'hash', actualBytes: size }
  return { ...base, state: 'complete', problem: null, actualBytes: size }
}

const PROBLEM_TEXT: Record<Exclude<FileProblem, 'missing'>, string> = {
  size: '大小不符',
  hash: 'sha256 不符',
  unreadable: '读不了',
}

function describeCheck(spec: ModelSpec, state: ModelState, files: readonly FileCheck[]): string {
  if (state === 'complete') return `${spec.title}：已安装，${files.length} 个文件的大小与 sha256 都与清单一致`
  if (state === 'missing') {
    const missing = files.filter(file => file.state === 'missing').map(file => path.posix.basename(file.relative))
    return missing.length === files.length
      ? `${spec.title}：未安装`
      : `${spec.title}：不完整，缺 ${missing.join('、')}`
  }
  const bad = files
    .filter(file => file.state === 'corrupt')
    .map(file => `${path.posix.basename(file.relative)}（${PROBLEM_TEXT[file.problem as Exclude<FileProblem, 'missing'>]}）`)
  return `${spec.title}：${bad.join('、')} 与清单不符，可能是下载中断、文件损坏或同名的其他版本，需要重新下载替换`
}

/** 检查一个模型。逐个文件顺序读，不和正在跑的识别抢磁盘带宽。 */
export async function inspectModel(root: string, spec: ModelSpec, deps: InspectDeps = {}): Promise<ModelCheck> {
  const hashFile = deps.hashFile ?? sha256File
  const files: FileCheck[] = []
  for (const file of spec.files) files.push(await checkFile(root, file, hashFile))
  const state: ModelState = files.some(file => file.state === 'corrupt')
    ? 'corrupt'
    : files.some(file => file.state === 'missing') ? 'missing' : 'complete'
  return { id: spec.id, title: spec.title, optional: spec.optional, state, files, message: describeCheck(spec, state, files) }
}

export async function inspectModels(
  root: string,
  manifest: readonly ModelSpec[] = MODEL_MANIFEST,
  deps: InspectDeps = {},
): Promise<ModelCheck[]> {
  const checks: ModelCheck[] = []
  for (const spec of manifest) checks.push(await inspectModel(root, spec, deps))
  return checks
}

// ===== 镜像 =====

/**
 * 镜像前缀，沿用 setup-local-asr 脚本的 MIRROR 语义：去掉末尾的 `/` 后接 `/` 与完整的上游地址，
 * 例如 `https://gh-proxy.com/` + `https://github.com/...` → `https://gh-proxy.com/https://github.com/...`。
 * 只接受 https 前缀；镜像只是转发，落位前仍按清单 sha256 校验。
 */
export function normalizeMirror(raw: string | null | undefined): { ok: true; mirror: string | null } | { ok: false; error: string } {
  const value = (raw ?? '').trim()
  if (value === '') return { ok: true, mirror: null }
  if (!/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(value)) {
    return { ok: false, error: `镜像前缀「${value}」不可用：只接受 https:// 开头的地址前缀，例如 https://gh-proxy.com/` }
  }
  return { ok: true, mirror: value.replace(/\/+$/, '') }
}

export function withMirror(url: string, mirror: string | null): string {
  return mirror ? `${mirror.replace(/\/+$/, '')}/${url}` : url
}

/** 环境变量 MIRROR（与 setup-local-asr.sh 同名）。开发与测试用；安装版的镜像应来自界面上的设置。 */
export function mirrorFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const value = env.MIRROR?.trim()
  return value ? value : null
}

// ===== 计划 =====

export interface DownloadPlanItem {
  readonly modelId: ModelId
  readonly title: string
  readonly purpose: string
  readonly whenMissing: string
  readonly optional: boolean
  readonly reason: 'missing' | 'corrupt'
  /** 实际请求的地址（已套镜像前缀）。 */
  readonly url: string
  /** 上游来源，给用户看"东西从哪里来"。 */
  readonly upstreamUrl: string
  readonly mirror: string | null
  readonly kind: 'tar.bz2' | 'file'
  readonly downloadBytes: number
  readonly installBytes: number
  readonly license: string
  readonly licenseUrl: string
  /** 模型根目录（local-asr）。 */
  readonly root: string
  /** 文件落到哪个目录。 */
  readonly destinationDir: string
  /** 将写入的文件（绝对路径）。 */
  readonly writes: readonly string[]
  /** 其中会替换掉的、与清单不符的现有文件。完整的文件不会被碰。 */
  readonly replaces: readonly string[]
  /** 永远为 true：本模块不自动下载，执行时必须带上用户的确认。 */
  readonly requiresConfirmation: true
}

export interface DownloadPlan {
  readonly root: string
  readonly items: readonly DownloadPlanItem[]
  readonly totalDownloadBytes: number
  readonly totalInstallBytes: number
  readonly notes: readonly string[]
}

export interface PlanOptions {
  readonly root: string
  readonly mirror?: string | null
  readonly manifest?: readonly ModelSpec[]
}

/**
 * 由检查结果生成下载计划。纯函数：不发请求、不读写文件，结果是可以原样交给界面的纯数据。
 * 完整的模型不进计划；缺失与损坏的各成一项，每一项都要用户逐项确认。
 */
export function planModelDownloads(
  checks: readonly ModelCheck[],
  options: PlanOptions,
): { ok: true; plan: DownloadPlan } | { ok: false; error: string } {
  const mirror = normalizeMirror(options.mirror)
  if (!mirror.ok) return mirror
  const manifest = options.manifest ?? MODEL_MANIFEST
  const items: DownloadPlanItem[] = []
  for (const check of checks) {
    if (check.state === 'complete') continue
    const spec = manifest.find(entry => entry.id === check.id)
    if (!spec) continue
    const writes = spec.files.map(file => absoluteOf(options.root, file.path))
    items.push({
      modelId: spec.id,
      title: spec.title,
      purpose: spec.purpose,
      whenMissing: spec.whenMissing,
      optional: spec.optional,
      reason: check.state,
      url: withMirror(spec.source.url, mirror.mirror),
      upstreamUrl: spec.source.url,
      mirror: mirror.mirror,
      kind: spec.source.kind,
      downloadBytes: spec.source.bytes,
      installBytes: spec.files.reduce((sum, file) => sum + file.bytes, 0),
      license: spec.source.license,
      licenseUrl: spec.source.licenseUrl,
      root: options.root,
      destinationDir: path.dirname(writes[0]),
      writes,
      replaces: check.files.filter(file => file.state === 'corrupt').map(file => file.file),
      requiresConfirmation: true,
    })
  }
  const notes = [
    '每一项都要你确认后才会开始下载；不会在后台自动下载。',
    `下载与解压时在 ${path.join(options.root, STAGING_DIRNAME)} 临时占用磁盘（压缩包与解压内容），结束后自动清理。`,
    '每个文件按清单 sha256 校验通过才替换到位；校验不过的文件不会被使用，已经完整的文件不会被改动。',
  ]
  if (mirror.mirror) notes.push(`经镜像 ${mirror.mirror} 下载：镜像只负责转发，内容仍按清单校验。`)
  return {
    ok: true,
    plan: {
      root: options.root,
      items,
      totalDownloadBytes: items.reduce((sum, item) => sum + item.downloadBytes, 0),
      totalInstallBytes: items.reduce((sum, item) => sum + item.installBytes, 0),
      notes,
    },
  }
}

// ===== 执行（必须经确认）=====

/** 用户在界面上确认的那一项：地址与去向必须与执行时的下载项逐字一致。 */
export interface DownloadConfirmation {
  readonly modelId: ModelId
  readonly url: string
  readonly destinationDir: string
}

export interface DownloadProgress {
  readonly modelId: ModelId
  readonly phase: 'download' | 'extract' | 'verify' | 'install'
  readonly attempt: number
  readonly receivedBytes?: number
  readonly totalBytes?: number
}

export type FetchLike = (url: string, init: { signal: AbortSignal; redirect: 'follow' }) => Promise<Response>

export interface DownloadDeps {
  /** 默认全局 fetch。主进程可以换成 Electron 的 `net.fetch`（走系统代理）。 */
  readonly fetch?: FetchLike
  /** 解压 .tar.bz2。默认调用本机 tar（见 `extractTarBz2`）。 */
  readonly extract?: (archive: string, intoDir: string, signal: AbortSignal) => Promise<void>
  readonly hashFile?: (file: string) => Promise<string>
  /** 网络类失败的最多尝试次数，默认 3。 */
  readonly maxAttempts?: number
  /** 重试间隔基数（毫秒），第 n 次失败后等 n 倍。默认 3000。 */
  readonly retryDelayMs?: number
  /** 多久收不到数据算卡住（毫秒），默认 60 秒。 */
  readonly idleTimeoutMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: DownloadProgress) => void
  readonly manifest?: readonly ModelSpec[]
}

export type DownloadFailureStage = 'unconfirmed' | 'busy' | 'download' | 'extract' | 'verify' | 'install' | 'cancelled'

export type DownloadOutcome =
  | { readonly ok: true; readonly modelId: ModelId; readonly installed: readonly string[]; readonly attempts: number }
  | {
      readonly ok: false
      readonly modelId: ModelId
      readonly stage: DownloadFailureStage
      readonly error: string
      readonly attempts: number
      /** 界面可以直接提供"再试一次"（不需要重新确认）。只有未确认的情况为 false。 */
      readonly retryable: boolean
    }

class StepError extends Error {
  readonly stage: DownloadFailureStage
  /** 网络类的一过性失败：自动重试。内容不符、未确认之类的不重试。 */
  readonly transient: boolean

  constructor(stage: DownloadFailureStage, message: string, transient: boolean) {
    super(message)
    this.stage = stage
    this.transient = transient
  }
}

/** 同一个模型同时只跑一份下载：两份并发会互相删掉对方的临时文件。 */
const running = new Set<string>()

const DEFAULT_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 3_000
const DEFAULT_IDLE_TIMEOUT_MS = 60_000

/**
 * 执行一项下载。确认不匹配时直接拒绝，不发任何请求。
 *
 * 顺序：清空本模型的临时目录 → 下载到 `.part` → 核对字节数 → 解压（tar.bz2）→
 * 按"文件名 + 大小 + sha256"在内容里认出清单文件 → 全部认齐后才逐个改名落位。
 * 网络错误、卡住、5xx/408/429、字节数不符会自动重试；内容与清单不符不自动重下（换个镜像或稍后再试）。
 */
export async function executeModelDownload(
  item: DownloadPlanItem,
  confirmation: DownloadConfirmation | null | undefined,
  deps: DownloadDeps = {},
): Promise<DownloadOutcome> {
  const failure = (stage: DownloadFailureStage, error: string, attempts: number): DownloadOutcome =>
    ({ ok: false, modelId: item.modelId, stage, error, attempts, retryable: stage !== 'unconfirmed' })

  if (
    !confirmation
    || confirmation.modelId !== item.modelId
    || confirmation.url !== item.url
    || confirmation.destinationDir !== item.destinationDir
  ) {
    return failure('unconfirmed', '这一项下载没有经过确认，或确认时看到的地址、去向与现在的下载项不一致：请让用户重新确认后再执行', 0)
  }
  const spec = (deps.manifest ?? MODEL_MANIFEST).find(entry => entry.id === item.modelId)
  if (!spec) return failure('unconfirmed', `清单里没有模型 ${item.modelId}，不执行`, 0)

  const key = `${path.resolve(item.root)}|${item.modelId}`
  if (running.has(key)) return failure('busy', `${spec.title} 已经在下载中，等它出结果`, 0)
  running.add(key)

  const staging = path.join(item.root, STAGING_DIRNAME, item.modelId)
  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_ATTEMPTS)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const hashFile = deps.hashFile ?? sha256File
  const extract = deps.extract ?? extractTarBz2
  const outer = deps.signal ?? new AbortController().signal
  let attempts = 0
  try {
    // 上次崩溃留下的半截东西先清掉：落位只认这一次下载、这一次校验过的文件。
    await rm(staging, { recursive: true, force: true })
    let picked: Map<string, string> | null = null
    let license: string | null = null
    while (picked === null) {
      attempts += 1
      try {
        if (outer.aborted) throw new StepError('cancelled', '下载已取消', false)
        await mkdir(staging, { recursive: true })
        const archive = path.join(staging, spec.source.kind === 'file' ? 'download.bin' : 'download.tar.bz2')
        await downloadOnce(item, spec, archive, attempts, deps, outer)
        let candidates: string[]
        if (spec.source.kind === 'file') {
          candidates = [archive]
        } else {
          const into = path.join(staging, 'extract')
          await rm(into, { recursive: true, force: true })
          await mkdir(into, { recursive: true })
          deps.onProgress?.({ modelId: item.modelId, phase: 'extract', attempt: attempts })
          try {
            await extract(archive, into, outer)
          } catch (error) {
            if (outer.aborted) throw new StepError('cancelled', '下载已取消', false)
            throw new StepError('extract', `解压失败：${errorText(error)}`, false)
          }
          candidates = await listFiles(into)
        }
        deps.onProgress?.({ modelId: item.modelId, phase: 'verify', attempt: attempts })
        picked = await pickVerified(spec, candidates, hashFile)
        license = spec.source.licenseFile
          ? candidates.find(file => path.basename(file).startsWith(spec.source.licenseFile!.archivePrefix)) ?? null
          : null
      } catch (error) {
        const step = error instanceof StepError ? error : new StepError('download', errorText(error), true)
        if (!step.transient || attempts >= maxAttempts) return failure(step.stage, step.message, attempts)
        await sleep((deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS) * attempts)
      }
    }

    deps.onProgress?.({ modelId: item.modelId, phase: 'install', attempt: attempts })
    const installed: string[] = []
    try {
      for (const file of spec.files) await mkdir(path.dirname(absoluteOf(item.root, file.path)), { recursive: true })
      // 全部认齐、校验过才开始改名：同盘 rename 要么是旧文件、要么是校验过的新文件，不存在半截文件。
      for (const file of spec.files) {
        const target = absoluteOf(item.root, file.path)
        await rename(picked.get(file.path)!, target)
        installed.push(target)
      }
    } catch (error) {
      const code = errorCode(error)
      const busy = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      const done = installed.length > 0 ? `（已替换 ${installed.map(file => path.basename(file)).join('、')}，其余未动）` : ''
      return failure('install', busy
        ? `模型文件正被占用（可能正在听写或会议转写），停止相关功能后重试${done}`
        : code === 'ENOSPC' ? `磁盘空间不足，放不下模型文件${done}` : `模型文件落位失败：${errorText(error)}${done}`,
      attempts)
    }
    if (license && spec.source.licenseFile) {
      // 许可文件只是随附说明，放不进去不影响模型可用。
      await rename(license, absoluteOf(item.root, spec.source.licenseFile.path)).catch(() => undefined)
    }
    return { ok: true, modelId: item.modelId, installed, attempts }
  } finally {
    running.delete(key)
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    await rmdir(path.join(item.root, STAGING_DIRNAME)).catch(() => undefined)
  }
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

async function downloadOnce(
  item: DownloadPlanItem,
  spec: ModelSpec,
  target: string,
  attempt: number,
  deps: DownloadDeps,
  outer: AbortSignal,
): Promise<void> {
  const fetchImpl: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init))
  const idleMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const controller = new AbortController()
  let stalled = false
  let idle: ReturnType<typeof setTimeout> | undefined
  const kick = (): void => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => { stalled = true; controller.abort() }, idleMs)
  }
  const onOuterAbort = (): void => controller.abort()
  outer.addEventListener('abort', onOuterAbort, { once: true })
  const part = `${target}.part`
  const expected = spec.source.bytes
  let received = 0
  try {
    kick()
    deps.onProgress?.({ modelId: item.modelId, phase: 'download', attempt, receivedBytes: 0, totalBytes: expected })
    const response = await fetchImpl(item.url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) {
      throw new StepError('download', `服务器返回 HTTP ${response.status}${item.mirror ? `（经镜像 ${item.mirror}）` : ''}：地址不可用时可换一个镜像前缀再试`, transientStatus(response.status))
    }
    if (!response.body) throw new StepError('download', '服务器没有返回内容', true)
    const handle = await open(part, 'w')
    try {
      const reader = response.body.getReader()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        kick()
        await handle.write(chunk.value)
        received += chunk.value.byteLength
        // 比清单大还在收：多半是镜像返回了别的东西，及早停下，不把磁盘写满。
        if (received > expected) {
          await reader.cancel().catch(() => undefined)
          break
        }
        deps.onProgress?.({ modelId: item.modelId, phase: 'download', attempt, receivedBytes: received, totalBytes: expected })
      }
    } finally {
      await handle.close()
    }
    if (received !== expected) {
      throw new StepError('download', `下载到 ${received} 字节，清单是 ${expected} 字节（连接中断、镜像返回了错误页，或上游已更新）`, true)
    }
    await rename(part, target)
  } catch (error) {
    await rm(part, { force: true }).catch(() => undefined)
    if (outer.aborted) throw new StepError('cancelled', '下载已取消', false)
    if (stalled) throw new StepError('download', `超过 ${Math.round(idleMs / 1000)} 秒没有收到数据，已中止这次下载`, true)
    if (error instanceof StepError) throw error
    if (errorCode(error) === 'ENOSPC') throw new StepError('download', '磁盘空间不足，下载已中止', false)
    throw new StepError('download', `网络错误：${errorText(error)}`, true)
  } finally {
    if (idle) clearTimeout(idle)
    outer.removeEventListener('abort', onOuterAbort)
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name))
    .sort()
}

/** 按"文件名 + 大小 + sha256"认出每个清单文件。包里同名的其他变体（如 64/、96/ 子目录）会被跳过。 */
async function pickVerified(
  spec: ModelSpec,
  candidates: readonly string[],
  hashFile: (file: string) => Promise<string>,
): Promise<Map<string, string>> {
  const picked = new Map<string, string>()
  for (const file of spec.files) {
    const name = file.archiveName ?? path.posix.basename(file.path)
    const named = spec.source.kind === 'file' ? [...candidates] : candidates.filter(candidate => path.basename(candidate) === name)
    let match: string | null = null
    for (const candidate of named) {
      if (picked.has(file.path) || [...picked.values()].includes(candidate)) continue
      const info = await stat(candidate)
      if (info.size !== file.bytes) continue
      if ((await hashFile(candidate)).toLowerCase() === file.sha256) {
        match = candidate
        break
      }
    }
    if (match === null) {
      throw new StepError(
        'verify',
        named.length === 0
          ? `下载内容里没有 ${name}：上游的模型包可能已经改版，未落位任何文件`
          : `下载内容里的 ${name} 与清单的大小或 sha256 不符（共 ${named.length} 个同名文件）：未落位任何文件，可换镜像或稍后再试`,
        false,
      )
    }
    picked.set(file.path, match)
  }
  return picked
}

// ===== 解压 =====

/**
 * 本机 tar 能不能解 .tar.bz2。
 *
 * - GNU tar：`-j` 调外部 bzip2（Linux 与 Git for Windows 自带）。
 * - bsdtar（libarchive）：版本行里要有 `bz2lib` 才是内建支持。较早的 Windows 自带 tar 只有 zlib
 *   （实测 `bsdtar 3.5.2 - libarchive 3.5.2 zlib/1.2.5.f-ipp`），遇到 .bz2 会去找外部 bzip2，
 *   setup 脚本记录过这种组合会卡住 —— 所以事先认出来、直接报错，不去碰运气。
 */
export function tarSupportsBzip2(versionText: string): boolean {
  if (/GNU tar/i.test(versionText)) return true
  if (/bsdtar|libarchive/i.test(versionText)) return /bz2lib/i.test(versionText)
  return false
}

const TAR_VERSION_TIMEOUT_MS = 10_000
const TAR_EXTRACT_TIMEOUT_MS = 15 * 60_000

function runTar(
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
  cwd?: string,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const child = spawn('tar', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', kill)
      resolve({ code, stdout, stderr, timedOut })
    }
    const kill = (): void => {
      try { child.kill() } catch { /* 已退出 */ }
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
    signal?.addEventListener('abort', kill, { once: true })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (text: string) => { stdout += text })
    child.stderr?.on('data', (text: string) => { stderr = (stderr + text).slice(-2000) })
    child.on('error', error => { stderr += errorText(error); finish(-1) })
    child.on('close', code => finish(code))
  })
}

/** 默认解压：本机 tar，带超时；不支持 bzip2 时直接报错并给出替代办法，不卡住等待。 */
export async function extractTarBz2(archive: string, intoDir: string, signal?: AbortSignal): Promise<void> {
  const version = await runTar(['--version'], TAR_VERSION_TIMEOUT_MS, signal)
  const versionLine = version.stdout.split(/\r?\n/)[0]?.trim() ?? ''
  if (version.code !== 0 || versionLine === '') throw new Error('本机找不到可用的 tar 命令，无法解压 .tar.bz2')
  if (!tarSupportsBzip2(version.stdout)) {
    throw new Error(`本机的 tar（${versionLine}）不支持 .tar.bz2（较早的 Windows 自带 tar 不含 bzip2）。可改用 scripts/setup-local-asr.ps1 安装模型，或装好 Git for Windows 后在 Git Bash 里运行 scripts/setup-local-asr.sh`)
  }
  // Git for Windows 的 GNU tar 会把 `C:\...` 当成远程主机名，必须加 --force-local（与 setup 脚本相同）；
  // 它还会把 `-C C:\...\Temp\...` 里的反斜杠当转义吃掉（实测"Cannot open"）。所以不用 -C：
  // 在解压目录里运行 tar，归档路径统一写成正斜杠 —— bsdtar 与 GNU tar 在各平台上都认。
  const local = /GNU tar/i.test(version.stdout) ? ['--force-local'] : []
  const archiveArg = archive.split(path.sep).join('/')
  const result = await runTar([...local, '-xjf', archiveArg], TAR_EXTRACT_TIMEOUT_MS, signal, intoDir)
  if (result.timedOut) throw new Error(`解压超过 ${TAR_EXTRACT_TIMEOUT_MS / 60_000} 分钟仍未完成，已中止`)
  if (result.code !== 0) throw new Error(`tar 退出码 ${String(result.code)}${result.stderr.trim() ? `：${result.stderr.trim().split(/\r?\n/).slice(-2).join(' ')}` : ''}`)
}
