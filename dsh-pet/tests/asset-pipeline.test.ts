import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AssetPipeline } from '../src/main/asset-pipeline.ts'
import { MediaProviderStore, type FetchLike } from '../src/main/media-providers.ts'
import { listCustomSkins, resolveAssetPath, customAssetsRoot } from '../src/main/custom-skins.ts'

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'asset-pipeline-'))
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function setup(options: { ffmpeg: string | null; videoFails?: boolean }) {
  const dir = tmp()
  const fetch: FetchLike = async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (url.endsWith('/v1/images/generations')) return { data: [{ b64_json: PNG }] }
      if (url.endsWith('/submit')) {
        if (options.videoFails) return { output: { task_id: 't1' } }
        return { url: 'https://cdn/clip.mp4' }
      }
      if (url.includes('/tasks/')) return { output: { task_status: options.videoFails ? 'FAILED' : 'SUCCEEDED', video_url: 'https://cdn/clip.mp4' } }
      return {}
    },
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  })
  const store = new MediaProviderStore(dir, { key: () => Buffer.alloc(32, 1), fetch })
  store.save({
    image: [{ id: 'img', name: 'img', type: 'openai-images', baseUrl: 'https://m.example', model: 'm' }],
    video: [{ id: 'vid', name: 'vid', type: options.videoFails ? 'async-task' : 'sync-url', baseUrl: 'https://v.example', model: 'v', submitPath: '/submit', videoUrlPath: 'url' }],
    clone: [],
  })
  const spawn = async (_cmd: string, args: readonly string[]) => {
    const dest = args[args.length - 1]
    writeFileSync(dest, Buffer.from('webm'))
    return { code: 0, stderr: '' }
  }
  const pipeline = new AssetPipeline({
    userDataDir: dir,
    store,
    spawn,
    probeFfmpeg: () => options.ffmpeg,
    sleep: async () => {},
    now: () => 1_700_000_000_000,
  })
  return { dir, pipeline, store }
}

test('未确认费用不能创建作业；provider 缺失拒绝', () => {
  const { pipeline } = setup({ ffmpeg: 'ffmpeg-fake' })
  assert.throws(() => pipeline.createJob({ name: 'x', prompt: 'p', imageProviderId: 'img', videoProviderId: 'vid', approved: false }), /费用/)
  assert.throws(() => pipeline.createJob({ name: 'x', prompt: 'p', imageProviderId: 'nope', videoProviderId: 'vid', approved: true }), /图像 provider/)
})

test('完整流水线：设计图→clips→转码→登记皮肤', async () => {
  const { dir, pipeline } = setup({ ffmpeg: 'ffmpeg-fake' })
  const job = pipeline.createJob({ name: '测试熊猫', prompt: '一只熊猫', actions: ['idle', 'wave'], imageProviderId: 'img', videoProviderId: 'vid', approved: true })
  const done = await pipeline.run(job.id)
  assert.equal(done.status, 'ready')
  assert.ok(done.skinId)
  const skins = listCustomSkins(dir)
  assert.equal(skins.length, 1)
  assert.deepEqual(skins[0].actions, ['idle', 'wave'])
  const root = customAssetsRoot(dir)
  assert.ok(existsSync(path.join(root, 'pets', `${done.skinId}.png`)))
  assert.ok(existsSync(path.join(root, 'pets', 'webm', done.skinId!, 'idle.webm')))
})

test('无 ffmpeg 停在 needs-postprocess，配置后可续做', async () => {
  const { dir, pipeline, store } = setup({ ffmpeg: null })
  const job = pipeline.createJob({ name: 'x', prompt: 'p', actions: ['idle'], imageProviderId: 'img', videoProviderId: 'vid', approved: true })
  const stopped = await pipeline.run(job.id)
  assert.equal(stopped.status, 'needs-postprocess')
  assert.equal(listCustomSkins(dir).length, 0)
  assert.ok(stopped.clips[0].src && existsSync(stopped.clips[0].src))
  // 模拟用户配置 ffmpegPath 后重试：注入探针改为可用
  const resumed = await new AssetPipeline({
    userDataDir: dir,
    store,
    spawn: async (_c: string, args: readonly string[]) => {
      writeFileSync(args[args.length - 1], Buffer.from('webm'))
      return { code: 0, stderr: '' }
    },
    probeFfmpeg: () => 'ffmpeg-now-available',
  }).postProcess(job.id)
  assert.equal(resumed.status, 'ready')
  assert.equal(listCustomSkins(dir).length, 1)
})

test('视频生成失败作业标 failed 并保留原因', async () => {
  const { pipeline } = setup({ ffmpeg: 'ffmpeg-fake', videoFails: true })
  const job = pipeline.createJob({ name: 'x', prompt: 'p', actions: ['idle'], imageProviderId: 'img', videoProviderId: 'vid', approved: true })
  const done = await pipeline.run(job.id)
  assert.equal(done.status, 'failed')
  assert.match(done.error ?? '', /生成失败/)
})

test('素材路径解析拒绝穿越与绝对路径', () => {
  const root = path.join(tmp(), 'root')
  assert.equal(resolveAssetPath(root, 'pets/a.png'), path.join(root, 'pets', 'a.png'))
  assert.equal(resolveAssetPath(root, '../outside.png'), null)
  assert.equal(resolveAssetPath(root, 'pets/../../outside.png'), null)
  assert.equal(resolveAssetPath(root, '/etc/passwd'), null)
  assert.equal(resolveAssetPath(root, 'C:/windows/x.png'), null)
  assert.equal(resolveAssetPath(root, 'pets/%00.png'), null)
  assert.equal(resolveAssetPath(root, 'pets/%2e%2e/x.png'), null)
})

test('删除皮肤清理素材与登记', async () => {
  const { dir, pipeline } = setup({ ffmpeg: 'ffmpeg-fake' })
  const job = pipeline.createJob({ name: 'x', prompt: 'p', actions: ['idle'], imageProviderId: 'img', videoProviderId: 'vid', approved: true })
  const done = await pipeline.run(job.id)
  pipeline.deleteSkin(done.skinId!)
  assert.equal(listCustomSkins(dir).length, 0)
  assert.ok(!existsSync(path.join(customAssetsRoot(dir), 'pets', `${done.skinId}.png`)))
})

test('单动作：生成→暂存预览→应用登记→删除清理', async () => {
  const { dir, pipeline } = setup({ ffmpeg: 'ffmpeg-fake' })
  const base = pipeline.createJob({ name: '哪吒', prompt: 'p', actions: ['idle'], imageProviderId: 'img', videoProviderId: 'vid', approved: true })
  const skinId = (await pipeline.run(base.id)).skinId!
  assert.throws(() => pipeline.createActionJob({ skinId, action: 'Bad Name', prompt: 'p', videoProviderId: 'vid', approved: true }), /动作名/)
  const job = pipeline.createActionJob({ skinId, action: 'swagger', prompt: '插兜走路', videoProviderId: 'vid', approved: true })
  const done = await pipeline.runAction(job.id)
  assert.equal(done.status, 'ready')
  const root = customAssetsRoot(dir)
  // 应用前：只有 staging 预览产物，登记表与宠物素材不受影响
  assert.ok(existsSync(path.join(root, 'staging', skinId, 'swagger.webm')))
  assert.ok(!existsSync(path.join(root, 'pets', 'webm', skinId, 'swagger.webm')))
  assert.deepEqual(listCustomSkins(dir).find(s => s.id === skinId)!.actions, ['idle'])
  const applied = pipeline.applyAction(job.id)
  assert.ok(applied.appliedAt)
  assert.ok(existsSync(path.join(root, 'pets', 'webm', skinId, 'swagger.webm')))
  assert.deepEqual(listCustomSkins(dir).find(s => s.id === skinId)!.actions, ['idle', 'swagger'])
  assert.equal(pipeline.actionAssets(skinId).swagger, 'webm')
  pipeline.deleteAction(skinId, 'swagger')
  assert.ok(!existsSync(path.join(root, 'pets', 'webm', skinId, 'swagger.webm')))
  assert.deepEqual(listCustomSkins(dir).find(s => s.id === skinId)!.actions, ['idle'])
})