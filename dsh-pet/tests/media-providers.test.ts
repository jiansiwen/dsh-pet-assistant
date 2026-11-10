import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MediaProviderStore, getPath, renderTemplate, generateImage, submitVideo, pollVideo, cloneVoice,
  type ImageProviderConfig, type VideoProviderConfig, type CloneProviderConfig, type FetchLike,
} from '../src/main/media-providers.ts'

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'media-providers-'))
const KEY = Buffer.alloc(32, 7)

function fakeFetch(handler: (url: string, init: any) => any): FetchLike {
  return async (url, init) => {
    const payload = handler(url, init)
    return { ok: true, status: 200, json: async () => payload, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
  }
}

test('getPath 支持点路径与数组下标', () => {
  assert.equal(getPath({ data: [{ b64_json: 'x' }] }, 'data[0].b64_json'), 'x')
  assert.equal(getPath({ a: null }, 'a.b'), undefined)
  assert.equal(getPath(null, 'a'), undefined)
})

test('renderTemplate 整串注入原始类型、其余做字符串替换', () => {
  const samples = [{ base64: 'aa', name: 'a.wav' }]
  assert.deepEqual(renderTemplate({ samples: '{{samples}}', p: 'hi {{name}}' }, { samples, name: '潘' }), { samples, p: 'hi 潘' })
})

test('密钥加密落盘：配置明文不含密钥，同密钥可解回', () => {
  const dir = tmp()
  const store = new MediaProviderStore(dir, { key: () => KEY })
  store.putSecret('ref-1', 'sk-secret-123')
  assert.equal(store.hasSecret('ref-1'), true)
  assert.equal(store.secretOf('ref-1'), 'sk-secret-123')
  const secretRaw = readFileSync(path.join(dir, 'asset-studio', 'providers.secret'), 'utf8')
  assert.ok(!secretRaw.includes('sk-secret-123'))
  const reopened = new MediaProviderStore(dir, { key: () => KEY })
  assert.equal(reopened.secretOf('ref-1'), 'sk-secret-123')
  const wrongKey = new MediaProviderStore(dir, { key: () => Buffer.alloc(32, 9) })
  assert.equal(wrongKey.hasSecret('ref-1'), false)
})

test('系统密钥不可用时拒绝保存密钥，不明文落盘', () => {
  const store = new MediaProviderStore(tmp(), { key: () => null })
  assert.throws(() => store.putSecret('r', 'sk'), /系统密钥/)
})

test('openai-images 与 http-json 图像适配器', async () => {
  const calls: string[] = []
  const store = new MediaProviderStore(tmp(), {
    key: () => KEY,
    fetch: fakeFetch((url, init) => {
      calls.push(url)
      assert.equal(init.headers['content-type'], 'application/json')
      return { data: [{ b64_json: 'AAAA' }] }
    }),
  })
  const openai: ImageProviderConfig = { id: 'i1', name: 'x', type: 'openai-images', baseUrl: 'https://m.example/', model: 'img-1' }
  assert.deepEqual(await generateImage(store, openai, '一只熊猫'), { b64: 'AAAA' })
  assert.ok(calls[0].endsWith('/v1/images/generations'))
  const custom: ImageProviderConfig = {
    id: 'i2', name: 'y', type: 'http-json', baseUrl: 'https://m.example', model: 'm',
    submitPath: '/gen', bodyTemplate: { text: '{{prompt}}' }, resultUrlPath: 'result.url',
  }
  const store2 = new MediaProviderStore(tmp(), { key: () => KEY, fetch: fakeFetch(() => ({ result: { url: 'https://cdn/x.png' } })) })
  assert.deepEqual(await generateImage(store2, custom, 'p'), { url: 'https://cdn/x.png' })
})

test('视频 async-task 提交与轮询三态', async () => {
  const provider: VideoProviderConfig = {
    id: 'v1', name: 'v', type: 'async-task', baseUrl: 'https://v.example', model: 'vid',
    submitPath: '/submit', taskIdPath: 'output.task_id', pollPath: '/tasks/{{task_id}}',
    statusPath: 'output.task_status', videoUrlPath: 'output.video_url',
  }
  let status = 'PENDING'
  const store = new MediaProviderStore(tmp(), {
    key: () => KEY,
    fetch: fakeFetch((url) => {
      if (url.endsWith('/submit')) return { output: { task_id: 't-1' } }
      assert.ok(url.includes('/tasks/t-1'))
      return status === 'SUCCEEDED'
        ? { output: { task_status: status, video_url: 'https://cdn/v.mp4' } }
        : { output: { task_status: status } }
    }),
  })
  assert.deepEqual(await submitVideo(store, provider, { prompt: 'p', imageUrl: 'data:image/png;base64,AA' }), { taskId: 't-1' })
  assert.deepEqual(await pollVideo(store, provider, 't-1'), { state: 'pending' })
  status = 'FAILED'
  assert.deepEqual(await pollVideo(store, provider, 't-1'), { state: 'failed' })
  status = 'SUCCEEDED'
  assert.deepEqual(await pollVideo(store, provider, 't-1'), { state: 'succeeded', url: 'https://cdn/v.mp4' })
})

test('克隆响应缺 voice_id 报形状错误', async () => {
  const provider: CloneProviderConfig = { id: 'c1', name: 'c', type: 'http-json', baseUrl: 'https://c.example', ttsEndpoint: 'https://t.example', ttsModel: 'tts' }
  const store = new MediaProviderStore(tmp(), { key: () => KEY, fetch: fakeFetch(() => ({ nope: 1 })) })
  await assert.rejects(() => cloneVoice(store, provider, [{ base64: 'AA', name: 'a.wav' }]), /voice_id/)
})