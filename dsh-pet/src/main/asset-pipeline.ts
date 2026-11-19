/**
 * 形象与动作生成流水线：设计图 → 逐动作视频 → 抠像转透明 WebM → 登记自定义皮肤。
 * 图像/视频 provider 全部来自用户配置（media-providers.ts），不绑厂商。
 * 无 ffmpeg 时停在 needs-postprocess 并保留已下载 clips，不假装产出可用皮肤。
 */
import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  /** skin=整套形象流水线；action=给已有皮肤生成单个动作，先暂存预览再应用 */
  kind?: 'skin' | 'action'
  appliedAt?: number
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
    // 部分视频模型（如 wan3.0）不收透明 PNG：先合成白底不透明参考图，失败时退回原图。
    const imageUrl = await this.opaqueRef(design, job.id)
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
    const keyColor = config.keyColor
    for (const clip of job.clips) {
      this.checkCancelled(id)
      if (!clip.src || !existsSync(clip.src)) throw new MediaError(`动作 ${clip.action} 缺少源视频`, 'CLIP_MISSING')
      const dest = path.join(this.jobDir(id), `${clip.action}.webm`)
      await this.keyClip(ffmpeg, clip.src, dest, keyColor, clip.action)
      const jobs = this.listJobs()
      const current = jobs.find(item => item.id === id)!
      this.update(id, { clips: current.clips.map(c => c.action === clip.action ? { ...c, webm: dest } : c) })
    }
    return this.registerSkin(id)
  }

  private async keyClip(ffmpeg: string, src: string, dest: string, keyColor: string | undefined, action: string): Promise<void> {
    // colorkey 在 YUV 空间算相似度，偏色绿幕会连肤色一起抠白（实测）；
    // 默认走 RGB 绿主导规则（念诗管线验证过），先缩到 512 高控制 geq 耗时。
    const vf = keyColor
      ? `colorkey=${keyColor.replace('#', '0x')}:0.30:0.10,fps=24`
      : `fps=12,scale=-2:512,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(g(X,Y),1.15*max(r(X,Y),b(X,Y)))*gt(g(X,Y),90),0,255)'`
    const result = await this.spawn(ffmpeg, [
      '-y', '-i', src,
      '-vf', vf,
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-an', dest,
    ])
    if (result.code !== 0 || !existsSync(dest)) {
      throw new MediaError(`动作 ${action} 转码失败：${result.stderr.slice(0, 300)}`, 'POST_FAILED')
    }
  }

  /** 透明 PNG 合成白底 JPEG 的 data URL；ffmpeg 不可用时退回原 PNG data URL。 */
  private async opaqueRef(pngPath: string, jobId: string): Promise<string> {
    const config = this.deps.store.load()
    const ffmpeg = (this.deps.probeFfmpeg ?? (() => probeFfmpeg(config.ffmpegPath)))()
    if (ffmpeg) {
      const dest = path.join(this.jobDir(jobId), 'ref.jpg')
      mkdirSync(this.jobDir(jobId), { recursive: true })
      const result = await this.spawn(ffmpeg, [
        '-y', '-i', pngPath, '-f', 'lavfi', '-i', 'color=c=white:s=2x2',
        '-filter_complex', '[1:v][0:v]scale2ref[bg][fg];[bg][fg]overlay=format=auto',
        '-frames:v', '1', dest,
      ])
      if (result.code === 0 && existsSync(dest)) {
        return `data:image/jpeg;base64,${readFileSync(dest).toString('base64')}`
      }
    }
    return `data:image/png;base64,${readFileSync(pngPath).toString('base64')}`
  }

  /** 给已有皮肤生成单个动作：参考图用皮肤静图，产物先落 staging 供预览，不直接登记。 */
  createActionJob(input: { skinId: string; action: string; prompt: string; videoProviderId: string; approved: boolean }): SkinJob {
    if (!input.approved) throw new MediaError('生成会计入你所配 provider 的费用，需先确认', 'NOT_APPROVED')
    const skin = listCustomSkins(this.deps.userDataDir).find(s => s.id === input.skinId)
    if (!skin) throw new MediaError('目标皮肤不存在', 'SKIN_MISSING')
    const action = input.action.trim().toLowerCase()
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(action)) throw new MediaError('动作名只能是小写字母开头的短横线命名，例如 swagger', 'BAD_ACTION')
    if (!input.prompt.trim() || input.prompt.length > 2000) throw new MediaError('描述需为 1–2000 字', 'BAD_PROMPT')
    const config = this.deps.store.load()
    if (!config.video.some(p => p.id === input.videoProviderId)) throw new MediaError('视频 provider 未配置', 'PROVIDER_MISSING')
    const job: SkinJob = {
      id: `job-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: `${skin.name} · ${action}`,
      prompt: input.prompt,
      actions: [action],
      imageProviderId: '',
      videoProviderId: input.videoProviderId,
      status: 'queued',
      approvedAt: this.now(),
      createdAt: this.now(),
      updatedAt: this.now(),
      clips: [{ action }],
      skinId: skin.id,
      kind: 'action',
    }
    this.saveJobs([...this.listJobs(), job])
    this.deps.emit?.('asset-jobs-changed')
    return job
  }

  async runAction(id: string): Promise<SkinJob> {
    const config = this.deps.store.load()
    const job = this.listJobs().find(item => item.id === id)
    if (!job || job.kind !== 'action' || !job.skinId) throw new MediaError('作业不存在', 'JOB_MISSING')
    const videoProvider = config.video.find(p => p.id === job.videoProviderId)
    if (!videoProvider) throw new MediaError('provider 配置已变化，请重新选择', 'PROVIDER_MISSING')
    const ffmpeg = (this.deps.probeFfmpeg ?? (() => probeFfmpeg(config.ffmpegPath)))()
    if (!ffmpeg) throw new MediaError('未找到 ffmpeg：配置 ffmpegPath 后重试', 'FFMPEG_MISSING')
    mkdirSync(this.jobDir(id), { recursive: true })
    try {
      this.update(id, { status: 'clips', error: undefined })
      const idle = path.join(customAssetsRoot(this.deps.userDataDir), 'pets', `${job.skinId}.png`)
      if (!existsSync(idle)) throw new MediaError('皮肤静图缺失，无法做形象参考', 'SKIN_MISSING')
      const imageUrl = await this.opaqueRef(idle, id)
      const clip = job.clips[0]
      // 重试时复用已提交的任务 ID：服务端任务仍在跑，重复提交会重复计费。
      const submission = clip.taskId ? { taskId: clip.taskId } : await submitVideo(this.deps.store, videoProvider, {
        prompt: `${job.prompt}。纯色绿幕背景，角色完整居中，结尾恢复初始站姿。`,
        imageUrl,
      })
      if (submission.url) {
        await this.downloadClip(id, clip.action, submission.url)
      } else {
        const taskId = submission.taskId!
        this.update(id, { clips: [{ ...clip, taskId }] })
        const deadline = this.now() + (videoProvider.timeoutMs ?? 600_000)
        for (;;) {
          this.checkCancelled(id)
          const poll = await pollVideo(this.deps.store, videoProvider, taskId)
          if (poll.state === 'succeeded') {
            await this.downloadClip(id, clip.action, poll.url!)
            break
          }
          if (poll.state === 'failed') throw new MediaError(`动作 ${clip.action} 生成失败`, 'VIDEO_FAILED')
          if (this.now() > deadline) throw new MediaError(`动作 ${clip.action} 生成超时`, 'VIDEO_TIMEOUT')
          await this.sleep(videoProvider.pollIntervalMs ?? 15_000)
        }
      }
      this.checkCancelled(id)
      this.update(id, { status: 'post' })
      const current = this.listJobs().find(item => item.id === id)!
      const src = current.clips[0].src!
      const keyColor = config.keyColor
      const stagedDir = path.join(customAssetsRoot(this.deps.userDataDir), 'staging', job.skinId)
      mkdirSync(stagedDir, { recursive: true })
      const staged = path.join(stagedDir, `${clip.action}.webm`)
      await this.keyClip(ffmpeg, src, staged, keyColor, clip.action)
      this.update(id, { clips: [{ ...current.clips[0], webm: staged }] })
      return this.update(id, { status: 'ready' })
    } catch (error) {
      if (error instanceof MediaError && error.code === 'CANCELLED') return this.update(id, { status: 'cancelled' })
      return this.update(id, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** 预览满意后把暂存动作写入皮肤并登记；未应用前宠物不受影响。 */
  applyAction(id: string): SkinJob {
    const job = this.listJobs().find(item => item.id === id)
    if (!job || job.kind !== 'action' || !job.skinId) throw new MediaError('作业不存在', 'JOB_MISSING')
    if (job.status !== 'ready') throw new MediaError('动作尚未生成完成', 'NOT_READY')
    const staged = job.clips[0]?.webm
    if (!staged || !existsSync(staged)) throw new MediaError('暂存视频缺失', 'CLIP_MISSING')
    const skin = listCustomSkins(this.deps.userDataDir).find(s => s.id === job.skinId)
    if (!skin) throw new MediaError('目标皮肤不存在', 'SKIN_MISSING')
    const action = job.clips[0].action
    const webmDir = path.join(customAssetsRoot(this.deps.userDataDir), 'pets', 'webm', job.skinId)
    mkdirSync(webmDir, { recursive: true })
    copyFileSync(staged, path.join(webmDir, `${action}.webm`))
    registerCustomSkin(this.deps.userDataDir, {
      ...skin,
      actions: [...new Set([...skin.actions, action])],
    })
    this.deps.emit?.('custom-skins-changed')
    return this.update(id, { appliedAt: this.now() })
  }

  /** 删除已有皮肤的某个动作：清 webm/帧序列并更新登记表。 */
  deleteAction(skinId: string, action: string): void {
    const skin = listCustomSkins(this.deps.userDataDir).find(s => s.id === skinId)
    if (!skin) throw new MediaError('皮肤不存在', 'SKIN_MISSING')
    if (!skin.actions.includes(action)) throw new MediaError('该皮肤没有这个动作', 'ACTION_MISSING')
    const root = customAssetsRoot(this.deps.userDataDir)
    const webm = path.join(root, 'pets', 'webm', skinId, `${action}.webm`)
    if (existsSync(webm)) rmSync(webm)
    const frames = path.join(root, 'pets', 'frames', skinId, action)
    if (existsSync(frames)) rmSync(frames, { recursive: true })
    registerCustomSkin(this.deps.userDataDir, { ...skin, actions: skin.actions.filter(a => a !== action) })
    this.deps.emit?.('custom-skins-changed')
  }

  /** 每个动作的素材形态：webm 可预览播放，frames 仅宠物可用，none 缺素材。 */
  actionAssets(skinId: string): Record<string, 'webm' | 'frames' | 'none'> {
    const root = customAssetsRoot(this.deps.userDataDir)
    const skin = listCustomSkins(this.deps.userDataDir).find(s => s.id === skinId)
    const out: Record<string, 'webm' | 'frames' | 'none'> = {}
    for (const action of skin?.actions ?? []) {
      out[action] = existsSync(path.join(root, 'pets', 'webm', skinId, `${action}.webm`)) ? 'webm'
        : existsSync(path.join(root, 'pets', 'frames', skinId, action)) ? 'frames' : 'none'
    }
    return out
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