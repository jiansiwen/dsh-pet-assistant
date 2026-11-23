import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { RolePresetStore, type RolePresetData } from '../src/main/role-preset-store.ts'

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-role-tests-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, store: new RolePresetStore(dir) }
}

const source: RolePresetData = {
  skin: 'boy-glasses', randomActions: [], personality: '亲切，开场短一点', voice: { voiceId: '茉莉', style: '温柔' },
}

test('角色方案重读可用，空动作代表不播放；同名不覆盖', t => {
  const { dir, store } = fixture(t)
  const first = store.save('  陪伴 A ', source)
  assert.throws(() => store.save('陪伴 ａ', { ...source, personality: '改写' }), /同名/)
  const second = store.save('办公', { ...source, skin: 'panda', voice: { design: '节奏稳' } })
  assert.deepEqual(new RolePresetStore(dir).list(), [first, second])
  assert.deepEqual(first.randomActions, [])
  assert.equal(first.personality, source.personality)
})

test('音色克隆文件另存，原文件覆盖后方案仍是原声音频；不复制凭据或盘符', t => {
  const { dir, store } = fixture(t)
  const file = path.join(dir, '原始样本.wav')
  writeFileSync(file, '原声音频')
  const preset = store.save('录音版', { ...source, voice: { sampleFile: file, sampleMime: 'audio/wav', apiKey: '隔离凭据' } as never })
  writeFileSync(file, '新的声音')
  assert.notEqual(store.voice(preset).sampleFile, file)
  assert.equal(readFileSync(store.voice(preset).sampleFile!, 'utf8'), '原声音频')
  assert.doesNotMatch(readFileSync(path.join(dir, 'role-presets.json'), 'utf8'), /原始样本|隔离凭据/)
  assert.throws(() => store.save('坏样本', { ...source, voice: { sampleFile: path.join(dir, '不存在.wav') } }), /样本读不到/)
  assert.equal(store.list().length, 1)
})

test('方案库损坏时不会在保存时覆盖原文件', t => {
  const { dir, store } = fixture(t)
  const file = path.join(dir, 'role-presets.json')
  writeFileSync(file, '{坏文件')
  assert.throws(() => store.save('方案', source), /未覆盖/)
  assert.equal(readFileSync(file, 'utf8'), '{坏文件')
})
