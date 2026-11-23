import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ROLE_PERSONALITY_LIMIT, ROLE_PRESET_NAME_LIMIT } from '../role-preset-types.ts'
import type { SpeakerVoice } from '../shared/speaker-voice.ts'
import { writeLocalJson } from './local-json.ts'

const MAX_PRESETS = 64
const MAX_SAMPLE_BYTES = 10 * 1024 * 1024
const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const LABEL_ID = /^[a-z0-9_-]{1,64}$/iu
const cleanName = (name: string) => name.trim().normalize('NFKC').toLowerCase()
type Voice = Pick<SpeakerVoice, 'voiceId' | 'design' | 'style' | 'profileId' | 'sampleMime'>

export interface RolePresetData {
  skin: string
  randomActions: readonly string[]
  personality: string
  voice: SpeakerVoice
}

export interface StoredRolePreset extends Omit<RolePresetData, 'voice'> {
  id: string
  name: string
  voice: Voice
  hasSample: boolean
}

export class RolePresetError extends Error {}

function badLibrary(): never { throw new RolePresetError('角色方案库无法读取，请检查本地文件；原文件未覆盖。') }

function parsePreset(value: unknown): StoredRolePreset {
  if (!value || typeof value !== 'object') return badLibrary()
  const v = value as StoredRolePreset
  if (typeof v.id !== 'string' || !ID.test(v.id) || typeof v.name !== 'string' || !v.name.trim() || v.name.length > ROLE_PRESET_NAME_LIMIT
    || typeof v.skin !== 'string' || !LABEL_ID.test(v.skin) || typeof v.personality !== 'string' || v.personality.length > ROLE_PERSONALITY_LIMIT
    || !Array.isArray(v.randomActions) || v.randomActions.length > 16 || v.randomActions.some(action => typeof action !== 'string' || !LABEL_ID.test(action))
    || typeof v.hasSample !== 'boolean' || !v.voice || typeof v.voice !== 'object') return badLibrary()
  const voice: Record<string, string> = {}
  for (const [key, max] of Object.entries({ voiceId: 200, design: 2000, style: 500, profileId: 64, sampleMime: 100 })) {
    const text = v.voice[key as keyof Voice]
    if (text !== undefined && (typeof text !== 'string' || text.length > max)) return badLibrary()
    if (text) voice[key] = text
  }
  return { id: v.id, name: v.name, skin: v.skin, personality: v.personality, randomActions: [...v.randomActions], hasSample: v.hasSample, voice }
}

function sampleStat(file: string): void {
  const stats = lstatSync(file)
  if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_SAMPLE_BYTES) throw new Error('样本不是小于 10 MB 的文件')
}

/** 形象素材沿用已登记的本机资源；克隆样本另外保存，避免源音频被覆盖后整套方案变声。 */
export class RolePresetStore {
  private readonly file: string

  constructor(userData: string) { this.file = path.join(userData, 'role-presets.json') }

  private samplePath(id: string): string {
    if (!ID.test(id)) throw new RolePresetError('角色方案标识无效。')
    return path.join(path.dirname(this.file), `role-preset-${id}.audio`)
  }

  list(): StoredRolePreset[] {
    let raw: string
    try { raw = readFileSync(this.file, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; return badLibrary() }
    try {
      const entries: unknown = JSON.parse(raw)
      if (!Array.isArray(entries) || entries.length > MAX_PRESETS) return badLibrary()
      const presets = entries.map(parsePreset)
      if (new Set(presets.map(item => item.id)).size !== presets.length || new Set(presets.map(item => cleanName(item.name))).size !== presets.length) return badLibrary()
      return presets
    } catch { return badLibrary() }
  }

  save(name: string, source: RolePresetData): StoredRolePreset {
    const presets = this.list()
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > ROLE_PRESET_NAME_LIMIT || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
      throw new RolePresetError(`方案名称需为 1–${ROLE_PRESET_NAME_LIMIT} 个字符。`)
    }
    if (presets.some(item => cleanName(item.name) === cleanName(trimmed))) throw new RolePresetError('已有同名方案。请换个名字，原方案未覆盖。')
    if (presets.length >= MAX_PRESETS) throw new RolePresetError(`最多保存 ${MAX_PRESETS} 套角色方案。`)
    const { sample, sampleFile, ...voice } = source.voice
    const preset = parsePreset({ id: randomUUID(), name: trimmed, skin: source.skin, randomActions: [...new Set(source.randomActions)],
      personality: source.personality, voice, hasSample: Boolean(sampleFile || sample) })
    const audio = this.samplePath(preset.id)
    let copied = false
    try {
      if (preset.hasSample) {
        try {
          if (sampleFile) sampleStat(sampleFile)
          if (sample && sample.length > Math.ceil(MAX_SAMPLE_BYTES / 3) * 4) throw new Error('音频超限')
          const bytes = sampleFile ? readFileSync(sampleFile) : Buffer.from(sample ?? '', 'base64')
          if (bytes.length === 0 || bytes.length > MAX_SAMPLE_BYTES) throw new Error('音频超限或为空')
          writeFileSync(audio, bytes, { flag: 'wx', mode: 0o600 })
          copied = true
        } catch { throw new RolePresetError('当前音色样本读不到或超过 10 MB，角色方案未保存。') }
      }
      writeLocalJson(this.file, [...presets, preset])
      return preset
    } catch (error) {
      if (copied) rmSync(audio, { force: true })
      throw error
    }
  }

  voice(preset: StoredRolePreset): SpeakerVoice {
    if (!preset.hasSample) return { ...preset.voice }
    const sampleFile = this.samplePath(preset.id)
    try { sampleStat(sampleFile) } catch { throw new RolePresetError('这套方案的音色样本已找不到，原配置未改。') }
    return { ...preset.voice, sampleFile }
  }
}
