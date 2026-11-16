import path from 'node:path'
import { createDecipheriv } from 'node:crypto'
import { VoiceApiStore } from './src/main/voice-api.ts'
import { getDataKey } from './src/main/dpapi.ts'

const dir = process.env.APPDATA + '/dsh-pet'
const got = getDataKey(dir)
if (got.status !== 'ok') { console.log('密钥不可用:', got.status); process.exit(1) }
const codec = {
  encrypt: (v) => Buffer.from(v),
  decrypt: (value) => {
    const d = createDecipheriv('aes-256-gcm', got.key, value.subarray(0, 12))
    d.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8')
  },
}
const store = new VoiceApiStore(path.join(dir, 'voice-apis.json'), codec)
const snap = store.snapshot()
for (const p of snap.profiles) console.log(`${p.kind} | ${p.name} | model=${p.model} | voice="${p.voice}" | endpoint=${p.endpoint}`)
console.log('selected tts =', snap.selected.tts)
