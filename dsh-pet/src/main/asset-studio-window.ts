/**
 * 形象与音色工作室窗口：provider 配置、生成作业、皮肤应用、音色克隆的唯一入口。
 * 独立 preload + 固定 IPC；发送方校验只认本窗口；生成/克隆/删除前原生确认费用与影响。
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AssetPipeline, probeFfmpeg } from './asset-pipeline.ts'
import { customAssetsRoot, listCustomSkins, registerCustomSkin } from './custom-skins.ts'
import { extractClip, type SpawnLike } from './video-clip.ts'
import { MediaProviderStore, type MediaProvidersConfig } from './media-providers.ts'
import { VoiceCloneService, type VoiceStoreLike } from './voice-clone.ts'
import { loadSettings, saveSettings } from './settings.ts'

/** 与 asset-pipeline 同形状的 ffmpeg 调用；单独放这里是为了让 video-clip 不依赖 electron。 */
const spawnFfmpeg: SpawnLike = (command, args) => new Promise(resolve => {
  execFile(command, [...args], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stderr: String(stderr ?? '') })
  })
})

export interface AssetStudioDeps {
  userDataDir: string
  pipeline: AssetPipeline
  voices: VoiceCloneService
  providers: MediaProviderStore
  voiceStore: VoiceStoreLike
  broadcast: (event: string) => void
  /** "AI 帮我配"：经插件 LLM 把一句话描述转成形象配置草稿；不触发生成。 */
  studioAssist?: (request: string) => Promise<{ name: string; prompt: string; actions: string[]; notes: string }>
}

type Result = { ok: true; value?: unknown } | { ok: false; error: string }

const ok = (value?: unknown): Result => ({ ok: true, value })
const fail = (error: unknown): Result => ({ ok: false, error: error instanceof Error ? error.message : String(error) })

export class AssetStudio {
  private win: BrowserWindow | null = null
  private ffmpegCache: { at: number; value: string | null } | null = null
  private readonly deps: AssetStudioDeps

  constructor(deps: AssetStudioDeps) {
    this.deps = deps
    this.register()
  }

  open(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.focus()
      return
    }
    const here = path.dirname(fileURLToPath(import.meta.url))
    this.win = new BrowserWindow({
      width: 980,
      height: 720,
      title: '形象与音色工作室',
      webPreferences: {
        preload: path.join(here, '..', 'preload', 'asset-studio.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    this.win.on('closed', () => {
      this.win = null
    })
    void this.win.loadFile(path.join(here, '..', 'renderer', 'asset-studio.html'))
  }

  private trusted(event: Electron.IpcMainInvokeEvent): boolean {
    return this.win !== null && !this.win.isDestroyed() && event.sender === this.win.webContents
  }

  private async confirm(message: string, detail: string): Promise<boolean> {
    const options = {
      type: 'question' as const,
      buttons: ['取消', '确认执行'],
      defaultId: 0,
      cancelId: 0,
      message,
      detail,
    }
    const choice = this.win && !this.win.isDestroyed()
      ? await dialog.showMessageBox(this.win, options)
      : await dialog.showMessageBox(options)
    return choice.response === 1
  }

  private handle(channel: string, fn: (input: unknown) => Promise<Result> | Result): void {
    ipcMain.handle(channel, async (event, input: unknown) => {
      if (!this.trusted(event)) return fail('来源不可信')
      try {
        return await fn(input)
      } catch (error) {
        return fail(error)
      }
    })
  }

  private register(): void {
    this.handle('asset-studio-state', () => {
      const config = this.deps.providers.load()
      const flags: Record<string, boolean> = {}
      for (const provider of [...config.image, ...config.video, ...config.clone]) {
        if (provider.auth?.apiKeyRef) flags[provider.auth.apiKeyRef] = this.deps.providers.hasSecret(provider.auth.apiKeyRef)
      }
      for (const provider of config.clone) {
        if (provider.ttsApiKeyRef) flags[provider.ttsApiKeyRef] = this.deps.providers.hasSecret(provider.ttsApiKeyRef)
      }
      // 探针失败路径有秒级超时：缓存 60 秒，避免无 ffmpeg 机器上每次刷新都卡主进程。
      if (!this.ffmpegCache || Date.now() - this.ffmpegCache.at > 60_000) {
        this.ffmpegCache = { at: Date.now(), value: probeFfmpeg(config.ffmpegPath) }
      }
      return ok({
        config,
        secretFlags: flags,
        jobs: this.deps.pipeline.listJobs(),
        skins: listCustomSkins(this.deps.userDataDir),
        actionAssets: Object.fromEntries(listCustomSkins(this.deps.userDataDir).map(s => [s.id, this.deps.pipeline.actionAssets(s.id)])),
        voices: this.deps.voices.list(),
        ffmpeg: this.ffmpegCache.value,
        selectedTts: this.deps.voiceStore.snapshot().selected.tts,
      })
    })

    this.handle('asset-studio-assist', async (input) => {
      if (!this.deps.studioAssist) return fail('形象配置助手尚未启用（需先配置主助理模型）')
      const request = typeof (input as { request?: unknown })?.request === 'string' ? (input as { request: string }).request : ''
      if (!request.trim()) return fail('请先用一句话描述你想要的形象')
      return ok(await this.deps.studioAssist(request.trim()))
    })

    this.handle('asset-studio-save-providers', (input) => {
      const { config, secrets } = input as { config: MediaProvidersConfig; secrets?: Record<string, string> }
      if (!config || !Array.isArray(config.image) || !Array.isArray(config.video) || !Array.isArray(config.clone)) {
        return fail('配置形状不合法')
      }
      for (const [ref, key] of Object.entries(secrets ?? {})) {
        if (key) this.deps.providers.putSecret(ref, key)
      }
      this.deps.providers.save(config)
      return ok()
    })

    this.handle('asset-studio-test-provider', async (input) => {
      const { kind, id } = input as { kind: 'image' | 'video' | 'clone'; id: string }
      const config = this.deps.providers.load()
      const provider = config[kind].find(p => p.id === id)
      if (!provider) return fail('provider 不存在')
      return ok(await this.deps.providers.ping(provider.baseUrl, provider.auth))
    })

    this.handle('asset-studio-start-job', async (input) => {
      const jobInput = input as { name: string; prompt: string; actions?: string[]; imageProviderId: string; videoProviderId: string }
      const actions = jobInput.actions?.length ? jobInput.actions : ['idle', 'walk', 'think', 'wave', 'jump', 'sleep']
      const confirmed = await this.confirm(
        '开始生成形象与动作？',
        `将调用你配置的图像 provider 1 次、视频 provider ${actions.length} 次，费用计入对应平台账户；素材生成后需预览再应用。`,
      )
      if (!confirmed) return fail('已取消')
      const job = this.deps.pipeline.createJob({ ...jobInput, approved: true })
      void this.deps.pipeline.run(job.id)
      return ok(job)
    })

    this.handle('asset-studio-cancel-job', (input) => {
      this.deps.pipeline.cancel(String((input as { id: string }).id))
      return ok()
    })

    this.handle('asset-studio-rerun-post', (input) => {
      void this.deps.pipeline.postProcess(String((input as { id: string }).id))
      return ok()
    })

    this.handle('asset-studio-apply-skin', (input) => {
      const { skinId, assistantId } = input as { skinId: string; assistantId: string }
      if (!listCustomSkins(this.deps.userDataDir).some(s => s.id === skinId)) return fail('皮肤未登记')
      if (!assistantId) return fail('缺少角色')
      const characters = { ...loadSettings().characters, [assistantId]: { skin: skinId } }
      saveSettings({ characters })
      this.deps.broadcast('pet-settings-changed')
      return ok()
    })

    this.handle('asset-studio-delete-skin', async (input) => {
      const skinId = String((input as { id: string }).id)
      const confirmed = await this.confirm('删除自定义皮肤？', '将删除该皮肤的图片与视频素材；正在使用它的角色会回退默认形象。')
      if (!confirmed) return fail('已取消')
      this.deps.pipeline.deleteSkin(skinId)
      this.deps.broadcast('pet-settings-changed')
      return ok()
    })

    this.handle('asset-studio-pick-video', async () => {
      const options = {
        title: '选择要截取动作的视频文件',
        properties: ['openFile'] as 'openFile'[],
        filters: [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'gif'] }],
      }
      const result = this.win && !this.win.isDestroyed()
        ? await dialog.showOpenDialog(this.win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled) return ok([])
      return ok(result.filePaths.slice(0, 1))
    })

    /*
     * 从本地视频裁一个动作。
     *
     * 与生成流水线共用同一套落地位置与登记表：产出写进
     * `<userData>/custom-assets/pets/webm/<skinId>/<action>.webm`，然后登记皮肤。
     * 这样它在成员编辑器的形象下拉里能直接选到 —— 用户做完的东西必须用得上。
     */
    this.handle('asset-studio-extract-clip', async (input) => {
      const raw = (input ?? {}) as Record<string, unknown>
      const sourcePath = typeof raw.sourcePath === 'string' ? raw.sourcePath : ''
      const action = typeof raw.action === 'string' ? raw.action.trim() : ''
      const skinIdRaw = typeof raw.skinId === 'string' ? raw.skinId.trim() : ''
      const skinName = typeof raw.skinName === 'string' ? raw.skinName.trim() : ''
      if (sourcePath === '') return fail('请先选一个视频文件')
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(action)) return fail('动作名只能是小写字母开头的短横线命名，例如 wave')
      const skinId = skinIdRaw !== '' ? skinIdRaw : `clip-${Date.now().toString(36)}`
      if (!/^[a-z0-9-]{1,64}$/.test(skinId)) return fail('皮肤编号不合法')
      const known = listCustomSkins(this.deps.userDataDir).some(s => s.id === skinId)
      if (skinIdRaw !== '' && !known) return fail('目标皮肤不存在，请先创建或留空新建')
      if (skinIdRaw === '' && skinName === '') return fail('新建皮肤需要起一个名字')

      const config = this.deps.providers.load()
      const ffmpeg = this.ffmpegCache?.value ?? probeFfmpeg(config.ffmpegPath)
      const confirmed = await this.confirm('从这段视频裁一个动作？',
        `源文件：${sourcePath}\n起止：${String(raw.from)}s → ${String(raw.to)}s\n抠像：${String(raw.matte)}\n` +
        `产物会写进：custom-assets/pets/webm/${skinId}/${action}.webm\n` +
        '抠像靠静态背景估计，镜头在动的话会抠不干净；这时会如实失败，不会强行写入。')
      if (!confirmed) return fail('已取消')

      const webmDir = path.join(customAssetsRoot(this.deps.userDataDir), 'pets', 'webm', skinId)
      mkdirSync(webmDir, { recursive: true })
      const output = path.join(webmDir, `${action}.webm`)
      const result = await extractClip({ ffmpeg, spawn: spawnFfmpeg }, sourcePath, output, {
        from: Number(raw.from), to: Number(raw.to),
        matte: raw.matte === 'chroma' ? 'chroma' : raw.matte === 'none' ? 'none' : 'background',
        ...(typeof raw.keyColor === 'string' ? { keyColor: raw.keyColor } : {}),
        ...(typeof raw.size === 'number' ? { size: raw.size } : {}),
      })
      if (!result.ok) return fail(`${result.error ?? '裁剪失败'}${result.hint ? `｜${result.hint}` : ''}`)

      const existing = listCustomSkins(this.deps.userDataDir).find(s => s.id === skinId)
      registerCustomSkin(this.deps.userDataDir, {
        id: skinId,
        name: existing?.name ?? skinName,
        createdAt: existing?.createdAt ?? Date.now(),
        // 已有的动作保留，新动作追加或覆盖 —— 不做"整份替换"，那会把别的动作一起删掉。
        actions: [...new Set([...(existing?.actions ?? []), action])],
        sourceJobId: existing?.sourceJobId ?? `clip-${Date.now().toString(36)}`,
        license: 'generated',
      })
      this.deps.broadcast('pet-settings-changed')
      return ok({ skinId, action, path: output })
    })

    this.handle('asset-studio-generate-action', async (input) => {
      const raw = (input ?? {}) as { skinId?: string; action?: string; prompt?: string; videoProviderId?: string; approved?: boolean }
      const confirmed = await this.confirm('给已有角色生成一个新动作？',
        `将调用你配置的视频 provider 1 次，费用计入对应平台账户；产物先进预览区，你点应用后才写入宠物。`)
      if (!confirmed) return fail('已取消')
      const job = this.deps.pipeline.createActionJob({
        skinId: String(raw.skinId ?? ''), action: String(raw.action ?? ''), prompt: String(raw.prompt ?? ''),
        videoProviderId: String(raw.videoProviderId ?? ''), approved: true,
      })
      void this.deps.pipeline.runAction(job.id)
      return ok(job)
    })

    this.handle('asset-studio-apply-action', (input) => {
      const job = this.deps.pipeline.applyAction(String((input as { id: string }).id))
      this.deps.broadcast('pet-settings-changed')
      return ok(job)
    })

    this.handle('asset-studio-delete-action', async (input) => {
      const { skinId, action } = (input ?? {}) as { skinId?: string; action?: string }
      const confirmed = await this.confirm('删除这个动作？', `将删除 ${String(skinId)} 的 ${String(action)} 素材（视频/帧序列）并从登记表移除。`)
      if (!confirmed) return fail('已取消')
      this.deps.pipeline.deleteAction(String(skinId ?? ''), String(action ?? ''))
      this.deps.broadcast('pet-settings-changed')
      return ok()
    })

    this.handle('asset-studio-pick-audio', async () => {
      const options = {
        title: '选择本人或已授权的声音样本（1–3 个）',
        properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
        filters: [{ name: '音频', extensions: ['wav', 'mp3', 'm4a', 'ogg', 'flac'] }],
      }
      const result = this.win && !this.win.isDestroyed()
        ? await dialog.showOpenDialog(this.win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled) return ok([])
      return ok(result.filePaths.slice(0, 3))
    })

    this.handle('asset-studio-start-clone', async (input) => {
      const cloneInput = input as { providerId: string; name: string; files: string[]; consent: boolean }
      if (cloneInput.consent !== true) return fail('需先确认样本为本人或已授权声音')
      const provider = this.deps.providers.load().clone.find(p => p.id === cloneInput.providerId)
      if (!provider) return fail('克隆 provider 未配置')
      const confirmed = await this.confirm(
        '开始克隆音色？',
        `样本将发送到你配置的克隆端点 ${provider.baseUrl}（出网由你的配置决定）；克隆完成后需手动应用为当前音色。`,
      )
      if (!confirmed) return fail('已取消')
      return ok(await this.deps.voices.enroll({ ...cloneInput, consent: true }))
    })

    this.handle('asset-studio-apply-voice', (input) => {
      this.deps.voices.apply(String((input as { id: string }).id))
      this.deps.broadcast('voice-api-changed')
      return ok()
    })

    this.handle('asset-studio-revoke-voice', async (input) => {
      const confirmed = await this.confirm('撤销自定义音色？', '将删除对应 TTS profile 并回退默认音色；已发送到克隆端点的样本副本无法收回。')
      if (!confirmed) return fail('已取消')
      return ok(this.deps.voices.revoke(String((input as { id: string }).id)))
    })
  }
}