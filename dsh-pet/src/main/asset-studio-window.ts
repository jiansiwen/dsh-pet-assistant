/**
 * 形象与音色工作室窗口：provider 配置、生成作业、皮肤应用、音色克隆的唯一入口。
 * 独立 preload + 固定 IPC；发送方校验只认本窗口；生成/克隆/删除前原生确认费用与影响。
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AssetPipeline, probeFfmpeg } from './asset-pipeline.ts'
import { MediaProviderStore, type MediaProvidersConfig } from './media-providers.ts'
import { VoiceCloneService, type VoiceStoreLike } from './voice-clone.ts'
import { listCustomSkins } from './custom-skins.ts'
import { loadSettings, saveSettings } from './settings.ts'

export interface AssetStudioDeps {
  userDataDir: string
  pipeline: AssetPipeline
  voices: VoiceCloneService
  providers: MediaProviderStore
  voiceStore: VoiceStoreLike
  broadcast: (event: string) => void
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
        voices: this.deps.voices.list(),
        ffmpeg: this.ffmpegCache.value,
        selectedTts: this.deps.voiceStore.snapshot().selected.tts,
      })
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