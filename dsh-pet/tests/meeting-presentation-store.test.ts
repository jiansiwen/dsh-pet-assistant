/** 隔离会议库中的讲解步骤：加密、修订冲突与中断后只读核查。 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { INITIAL_AUDIO_STATE, nextAudio } from '../src/main/audio.ts'
import { MeetingRecorder } from '../src/main/meeting-recorder.ts'
import { MeetingStore, type MeetingPresentationRecord } from '../src/main/meeting-store.ts'

test('讲解步骤加密落库并按修订更新；重启时未结束状态只报未知、不自动重放', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-meeting-presentation-store-'))
  const keyProvider = () => ({ status: 'ok' as const, key: Buffer.alloc(32, 41) })
  let store = new MeetingStore(dir, { keyProvider })
  t.after(() => { try { store.close() } catch { /* 已关闭 */ }; rmSync(dir, { recursive: true, force: true }) })
  const record: MeetingPresentationRecord = { id: 'presentation-1', requestId: 'request-1', bindingId: 'binding-1',
    meetingId: 'meeting-1', meetingName: '保密会议', documentName: '保密文档', documentPath: path.join(dir, 'secret.md'),
    fingerprint: 'fingerprint-1', expiresAt: 1_800_000_100_000, state: 'presenting', error: null,
    next: 1, total: 3, completed: [0], revision: 1, updatedAt: 1_800_000_000_000 }
  assert.equal(store.saveMeetingPresentation(record, 0).ok, true)
  assert.equal(store.saveMeetingPresentation({ ...record, revision: 2, next: 2, completed: [0, 1] }, 1).ok, true)
  assert.equal(store.saveMeetingPresentation({ ...record, revision: 2, state: 'completed' }, 1).ok, false, '旧修订不能覆盖新状态')
  store.close()
  const bytes = readFileSync(path.join(dir, 'meetings.sqlite'))
  assert.equal(bytes.includes(Buffer.from('保密会议')), false)
  assert.equal(bytes.includes(Buffer.from('保密文档')), false)
  assert.equal(bytes.includes(Buffer.from(record.documentPath)), false)
  store = new MeetingStore(dir, { keyProvider })
  const recorder = new MeetingRecorder({ store, userDataDir: dir, audio: event => nextAudio(INITIAL_AUDIO_STATE, event), notifyRenderer: () => {} })
  const restored = recorder.savedPresentationStatus(record.id)
  assert.ok(restored)
  assert.equal(restored.state, 'unknown')
  assert.deepEqual(restored.completed, [0, 1])
  assert.match(restored.error ?? '', /中断|核查/u)
  assert.equal(store.getMeetingPresentation(record.id)?.revision, 2)
  assert.equal(recorder.savedPresentationStatus()?.id, record.id, '重启后无需事先知道编号也能查看最近一次')
})

test('讲解记录密文被替换或挪行时不伪造可用状态', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-meeting-presentation-tamper-'))
  const keyProvider = () => ({ status: 'ok' as const, key: Buffer.alloc(32, 42) })
  const store = new MeetingStore(dir, { keyProvider })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const record: MeetingPresentationRecord = { id: 'original', requestId: 'r', bindingId: 'b', meetingId: null,
    meetingName: '会议', documentName: '文档', documentPath: path.join(dir, 'a.md'), fingerprint: 'f', expiresAt: 1,
    state: 'opening', error: null, next: 0, total: 1, completed: [], revision: 1, updatedAt: 1 }
  assert.equal(store.saveMeetingPresentation(record, 0).ok, true)
  const raw = new DatabaseSync(path.join(dir, 'meetings.sqlite'))
  const row = raw.prepare('SELECT data FROM meeting_presentations WHERE id = ?').get(record.id) as { data: string }
  raw.prepare('INSERT INTO meeting_presentations(id, revision, data) VALUES (?, ?, ?)').run('forged', 1, row.data)
  raw.close()
  assert.equal(store.getMeetingPresentation('forged'), null)
})

test('只有讲解步骤密文但密钥丢失时，绝不重新创建密钥覆盖旧数据', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-meeting-presentation-key-'))
  let store = new MeetingStore(dir, { keyProvider: () => ({ status: 'ok', key: Buffer.alloc(32, 43) }) })
  t.after(() => { try { store.close() } catch { /* 已关闭 */ }; rmSync(dir, { recursive: true, force: true }) })
  const record: MeetingPresentationRecord = { id: 'key-test', requestId: 'r', bindingId: 'b', meetingId: null,
    meetingName: '会议', documentName: '文档', documentPath: path.join(dir, 'a.md'), fingerprint: 'f', expiresAt: 1,
    state: 'opening', error: null, next: 0, total: 1, completed: [], revision: 1, updatedAt: 1 }
  assert.ok(store.saveMeetingPresentation(record, 0).ok)
  store.close()
  let wraps = 0
  store = new MeetingStore(dir, { dpapi: { platform: 'win32', spawn: () => {
    wraps++; return { status: 0, stdout: Buffer.alloc(32, 44).toString('base64') }
  } } })
  assert.equal(store.getMeetingPresentation(record.id), null)
  assert.equal(wraps, 0, '有密文时不能调用密钥包装器生成替代密钥')
  assert.equal(existsSync(path.join(dir, 'meetings-key.bin')), false)
})
