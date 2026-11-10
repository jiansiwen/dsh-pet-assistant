/**
 * 形象与动作生成流水线：设计图 → 逐动作视频 → 抠像转透明 WebM → 登记自定义皮肤。
 * 图像/视频 provider 全部来自用户配置（media-providers.ts），不绑厂商。
 * 无 ffmpeg 时停在 needs-postprocess 并保留已下载 clips，不假装产出可用皮肤。
 */
import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  MediaError, MediaProviderStore, generateImage, pollVideo, submitVideo,
  type ImageProviderConfig, type VideoProviderConfig,
} from './media-providers.ts'
import { customAssetsRoot, registerCustomSkin, removeCustomSkin, listCustomSkins } from './custom-skins.ts'

export const DEFAULT_ACTIONS = ['idle', 'walk', 'think', 'wave', 'jump', 'sleep'] as const

export type JobStatus = 'queued' | 'image' | 'clips' | 'post' | 'ready' | 'needs-postprocess' | 'failed' | 'cancelled'

export interface SkinJob {
  id: string
  name: string
  prompt: string
  actions: string[]
  imageProviderId: string
  videoProviderId: string
  status: JobStatus
  approvedAt: number
  createdAt: number
  updatedAt: number
  designImage?: string
  clips: { action: string; src?: string; webm?: string; taskId?: string }[]
  skinId?: string
  error?: string
}

export type SpawnLike = (command: string, args: readonly string[]) => Promise<{ code: number; stderr: string }>

export interface PipelineDeps {
  userDataDir: string
  store: MediaProviderStore
  spawn?: SpawnLike
  probeFfmpeg?: () => string | null
  emit?: (event: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const realSpawn: SpawnLike = (command, args) => new Promise(resolve => {
  execFile(command, [...args], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stderr: String(stderr ?? '') })
  })
})

export function probeFfmpeg(configured: string | undefined): string | null {
  const candidates = configured ? [configured] : ['ffmpeg']
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-version'], { timeout: 5000, stdio: 'ignore' })
      return candidate
    } catch {
      continue
    }
  }
  return null
}

export class AssetPipeline {
  private readonly deps: Required<Pick<PipelineDeps, 'userDataDir' | 'store'>> & PipelineDeps
  private readonly spawn: SpawnLike
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly cancelled = new Set<string>()

  constructor(deps: PipelineDeps) {
    this.deps = deps
    this.spawn = deps.spawn ?? realSpawn
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)))
  }

  private jobsPath(): string {
    return path.join(this.deps.userDataDir, 'asset-studio', 'jobs.json')
  }

  private jobDir(id: string): string {
    return path.join(this.deps.userDataDir, 'asset-studio', 'jobs', id)
  }

  listJobs(): SkinJob[] {
    try {
      const raw = JSON.parse(readFileSync(this.jobsPath(), 'utf8')) as { jobs: SkinJob[] }
      return Array.isArray(raw.jobs) ? raw.jobs : []
    } catch {
      return []
    }
  }

  private saveJobs(jobs: SkinJob[]): void {
    mkdirSync(path.dirname(this.jobsPath()), { recursive: true })
    writeFileSync(this.jobsPath(), JSON.stringify({ jobs }, null, 2), 'utf8')
  }

  private update(id: string, patch: Partial<SkinJob>): SkinJob {
    const jobs = this.listJobs()
    const job = jobs.find(item => item.id === id)
    if (!job) throw new MediaError('作业不存在', 'JOB_MISSING')
    Object.assign(job, patch, { updatedAt: this.now() })
    this.saveJobs(jobs)
    this.deps.emit?.('asset-jobs-changed')
    return job
  }

  createJob(input: { name: string; prompt: string; actions?: string[]; imageProviderId: string; videoProviderId: string; approved: boolean }): SkinJob {
    if (!input.approved) throw new MediaError('生成会计入你所配 provider 的费用，需先确认', 'NOT_APPROVED')
    const config = this.deps.store.load()
    if (!config.image.some(p => p.id === input.imageProviderId)) throw new MediaError('图像 provider 未配置', 'PROVIDER_MISSING')
    if (!config.video.some(p => p.id === input.videoProviderId)) throw new MediaError('视频 provider 未配置', 'PROVIDER_MISSING')
    if (!input.prompt.trim() || input.prompt.length > 2000) throw new MediaError('描述需为 1–2000 字', 'BAD_PROMPT')
    const actions = (input.actions?.length ? input.actions : [...DEFAULT_ACTIONS]).slice(0, 8)
    const job: SkinJob = {
      id: `job-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: input.name.trim().slice(0, 60) || '自定义形象',
      prompt: input.prompt,
      actions,
      imageProviderId: input.imageProviderId,
      videoProviderId: input.videoProviderId,
      status: 'queued',
      approvedAt: this.now(),
      createdAt: this.now(),
      updatedAt: this.now(),
      clips: actions.map(action => ({ action })),
    }
    this.saveJobs([...this.listJobs(), job])
    this.deps.emit?.('asset-jobs-changed')
    return job
  }

  cancel(id: string): void {
    this.cancelled.add(id)
    const job = this.listJobs().find(item => item.id === id)
    if (job && job.status !== 'ready' && job.status !== 'failed') this.update(id, { status: 'cancelled' })
  }

  private checkCancelled(id: string): void {
    if (this.cancelled.has(id)) throw new MediaError('作业已取消', 'CANCELLED')
  }

  async run(id: string): Promise<SkinJob> {
    const config = this.deps.store.load()
    const job = this.listJobs().find(item => item.id === id)
    if (!job) throw new MediaError('作业不存在', 'JOB_MISSING')
    const imageProvider = config.image.find(p => p.id === job.imageProviderId)
    const videoProvider = config.video.find(p => p.id === job.videoProviderId)
    if (!imageProvider || !videoProvider) throw new MediaError('provider 配置已变化，请重新选择', 'PROVIDER_MISSING')
    mkdirSync(this.jobDir(id), { recursive: true })
    try {
      this.update(id, { status: 'image', error: undefined })
      const design = await this.generateDesign(imageProvider, job)
      this.checkCancelled(id)
      this.update(id, { status: 'clips', designImage: design })
      await this.generateClips(videoProvider, job, design)
      this.checkCancelled(id)
      return await this.postProcess(id)
    } catch (error) {
      if (error instanceof MediaError && error.code === 'CANCELLED') return this.update(id, { status: 'cancelled' })
      return this.update(id, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async generateDesign(provider: ImageProviderConfig, job: SkinJob): Promise<string> {
    const result = await generateImage(this.deps.store, provider, job.prompt)
    const dest = path.join(this.jobDir(job.id), 'design.png')
    if (result.b64) writeFileSync(dest, Buffer.from(result.b64, 'base64'))
    else if (result.url) await this.deps.store.download(result.url, dest, data => writeFileSync(dest, data))
    else throw new MediaError('图像结果为空', 'PROVIDER_SHAPE')
    return dest
  }

  private async generateClips(provider: VideoProviderConfig, job: SkinJob, design: string): Promise<void> {
    // 图生视频需要可访问 URL；本地设计图以 data URL 传入，provider 不支持时如实失败。
    const imageUrl = `data:image/png;base64,${readFileSync(design).toString('base64')}`
    for (const clip of job.clips) {
      this.checkCancelled(job.id)
      const submission = await submitVideo(this.deps.store, provider, {
        prompt: `${job.prompt}。动作：${clip.action}，纯色绿幕背景，角色完整居中。`,
        imageUrl,
      })
      if (submission.url) {
        await this.downloadClip(job.id, clip.action, submission.url)
        continue
      }
      const taskId = submission.taskId!
      this.update(job.id, { clips: job.clips.map(c => c.action === clip.action ? { ...c, taskId } : c) })
      const deadline = this.now() + (provider.timeoutMs ?? 300_000)
      for (;;) {
        this.checkCancelled(job.id)
        const poll = await pollVideo(this.deps.store, provider, taskId)
        if (poll.state === 'succeeded') {
          await this.downloadClip(job.id, clip.action, poll.url!)
          break
        }
        if (poll.state === 'failed') throw new MediaError(`动作 ${clip.action} 生成失败`, 'VIDEO_FAILED')
        if (this.now() > deadline) throw new MediaError(`动作 ${clip.action} 生成超时`, 'VIDEO_TIMEOUT')
        await this.sleep(provider.pollIntervalMs ?? 3000)
      }
    }
  }

  private async downloadClip(jobId: string, action: string, url: string): Promise<void> {
    const dest = path.join(this.jobDir(jobId), `${action}.mp4`)
    await this.deps.store.download(url, dest, data => writeFileSync(dest, data))
    const jobs = this.listJobs()
    const job = jobs.find(item => item.id === jobId)!
    this.update(jobId, { clips: job.clips.map(c => c.action === action ? { ...c, src: dest } : c) })
  }

  /** 抠像 + 24fps 透明 WebM；缺 ffmpeg 停在 needs-postprocess，clips 保留可续做。 */
  async postProcess(id: string): Promise<SkinJob> {
    const job = this.listJobs().find(item => item.id === id)
    if (!job) throw new MediaError('作业不存在', 'JOB_MISSING')
    const config = this.deps.store.load()
    const ffmpeg = (this.deps.probeFfmpeg ?? (() => probeFfmpeg(config.ffmpegPath)))()
    if (!ffmpeg) return this.update(id, { status: 'needs-postprocess', error: '未找到 ffmpeg：配置 ffmpegPath 后重试后处理' })
    this.update(id, { status: 'post' })
    const keyColor = (config.keyColor ?? '0x00FF00').replace('#', '0x')
    for (const clip of job.clips) {
      this.checkCancelled(id)
      if (!clip.src || !existsSync(clip.src)) throw new MediaError(`动作 ${clip.action} 缺少源视频`, 'CLIP_MISSING')
      const dest = path.join(this.jobDir(id), `${clip.action}.webm`)
      const result = await this.spawn(ffmpeg, [
        '-y', '-i', clip.src,
        '-vf', `colorkey=${keyColor}:0.30:0.10,fps=24`,
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-an', dest,
      ])
      if (result.code !== 0 || !existsSync(dest)) {
        throw new MediaError(`动作 ${clip.action} 转码失败：${result.stderr.slice(0, 300)}`, 'POST_FAILED')
      }
      const jobs = this.listJobs()
      const current = jobs.find(item => item.id === id)!
      this.update(id, { clips: current.clips.map(c => c.action === clip.action ? { ...c, webm: dest } : c) })
    }
    return this.registerSkin(id)
  }

  private registerSkin(id: string): SkinJob {
    const job = this.listJobs().find(item => item.id === id)!
    const skinId = `custom-${id.replace(/^job-/, '')}`
    const pets = path.join(customAssetsRoot(this.deps.userDataDir), 'pets')
    mkdirSync(path.join(pets, 'webm', skinId), { recursive: true })
    if (job.designImage) copyFileSync(job.designImage, path.join(pets, `${skinId}.png`))
    const actions: string[] = []
    for (const clip of job.clips) {
      if (clip.webm && existsSync(clip.webm)) {
        copyFileSync(clip.webm, path.join(pets, 'webm', skinId, `${clip.action}.webm`))
        actions.push(clip.action)
      }
    }
    if (!actions.length) throw new MediaError('没有可用动作 clip', 'NO_ACTIONS')
    registerCustomSkin(this.deps.userDataDir, {
      id: skinId, name: job.name, createdAt: this.now(), actions, sourceJobId: id, license: 'generated',
    })
    this.deps.emit?.('custom-skins-changed')
    return this.update(id, { status: 'ready', skinId })
  }

  deleteSkin(skinId: string): void {
    removeCustomSkin(this.deps.userDataDir, skinId)
    this.deps.emit?.('custom-skins-changed')
  }

  skins(): ReturnType<typeof listCustomSkins> {
    return listCustomSkins(this.deps.userDataDir)
  }
}