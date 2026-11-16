import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { VoiceCloneService, type VoiceStoreLike } from '../src/main/voice-clone.ts'
import { MediaProviderStore, type FetchLike } from '../src/main/media-providers.ts'
import type { VoiceApiState } from '../src/voice-api-types.ts'

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'voice-clone-'))

function fakeVoiceStore() {
  const state: VoiceApiState = { profiles: [], selected: { tts: null, asr: null } }
  const calls: string[] = []
  const store: VoiceStoreLike = {
    snapshot: () => state,
    save: (input: any) => {
      calls.push(`save:${input.voice}`)
      const profile = {
        id: `p-${state.profiles.length + 1}`, kind: 'tts' as const, name: input.name, endpoint: input.endpoint,
        model: input.model, voice: input.voice, voiceDesign: '', hasKey: Boolean(input.apiKey), provider: 'openai' as const,
      }
      state.profiles = [...state.profiles, profile]
      return state
    },
    remove: (id: unknown) => {
      calls.push(`remove:${id}`)
      state.profiles = state.profiles.filter(p => p.id !== id)
      return state
    },
    select: (kind: unknown, id: unknown) => {
      calls.push(`select:${kind}:${id}`)
      state.selected = { ...state.selected, tts: id as string | null }
      return state
    },
  }
  return { store, state, calls }
}

function setup() {
  const dir = tmp()
  const fetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ voice_id: 'v-clone-1' }), arrayBuffer: async () => new ArrayBuffer(0) })
  const providers = new MediaProviderStore(dir, { key: () => Buffer.alloc(32, 2), fetch })
  providers.save({
    image: [], video: [],
    clone: [{ id: 'c1', name: '克隆', type: 'http-json', baseUrl: 'https://c.example', submitPath: '/clone', ttsEndpoint: 'https://t.example', ttsModel: 'tts-1' }],
  })
  const sample = path.join(dir, 'sample.wav')
  writeFileSync(sample, Buffer.from('RIFF0000WAVEfmt '))
  const voices = fakeVoiceStore()
  const service = new VoiceCloneService({ userDataDir: dir, store: providers, voices: voices.store })
  return { dir, sample, service, voices }
}

test('未同意拒绝克隆', async () => {
  const { service, sample } = setup()
  await assert.rejects(() => service.enroll({ providerId: 'c1', name: '我的音色', files: [sample], consent: false }), /本人或已授权/)
})

test('样本格式与数量校验', async () => {
  const { service, dir } = setup()
  const bad = path.join(dir, 'x.exe')
  writeFileSync(bad, Buffer.from('x'))
  await assert.rejects(() => service.enroll({ providerId: 'c1', name: 'n', files: [bad], consent: true }), /格式/)
  await assert.rejects(() => service.enroll({ providerId: 'c1', name: 'n', files: [], consent: true }), /1–3/)
})

test('克隆→应用→撤销：profile 建立选中与回退', async () => {
  const { service, sample, voices } = setup()
  const voice = await service.enroll({ providerId: 'c1', name: '我的音色', files: [sample], consent: true })
  assert.equal(voice.voiceId, 'v-clone-1')
  assert.equal(service.list().length, 1)
  service.apply(voice.id)
  assert.equal(voices.state.selected.tts, 'p-1')
  assert.equal(service.list()[0].profileId, 'p-1')
  const result = service.revoke(voice.id)
  assert.equal(result.externalCopiesUncontrolled, true)
  assert.equal(voices.state.selected.tts, null)
  assert.equal(voices.state.profiles.length, 0)
  assert.equal(service.list().length, 0)
  assert.ok(voices.calls.includes('remove:p-1'))
})