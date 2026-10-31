/** 仅使用临时会议库、模拟确认和文件夹选择，不触碰真实录音或用户目录。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { INITIAL_AUDIO_STATE, nextAudio } from '../src/main/audio.ts'
import { MeetingRecorder, registerMeetingIpc } from '../src/main/meeting-recorder.ts'
import { MeetingStore, type MeetingIntegrity, type TranscriptSegment } from '../src/main/meeting-store.ts'

const KEY = Buffer.alloc(32, 31)
const COMPLETE: MeetingIntegrity = { status: 'complete', reasons: [], tracks: { mic: { sent: 0, acknowledged: 0, persisted: 0 } } }
const SEGMENT: TranscriptSegment = { idx: 0, speaker: 'mic-s1', label: '参会人', uncertain: false,
  startMs: 0, endMs: 1000, text: '已确认的会议发言', source: 'asr', track: 'mic' }
const ID = '11111111-1111-4111-8111-111111111111'

function fixture(t: TestContext, options: { integrity?: MeetingIntegrity | null; failed?: boolean; artifactId?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-meeting-artifact-'))
  const data = path.join(root, 'private')
  const destination = path.join(root, 'chosen')
  mkdirSync(destination)
  const stores: MeetingStore[] = []
  const open = () => {
    const store = new MeetingStore(data, { keyProvider: () => ({ status: 'ok', key: KEY }), now: () => 1_800_000_000_000 })
    stores.push(store)
    const recorder = new MeetingRecorder({ store, userDataDir: data, audio: event => nextAudio(INITIAL_AUDIO_STATE, event),
      notifyRenderer: () => {}, ...(options.artifactId ? { newArtifactId: () => options.artifactId! } : {}) })
    return { store, recorder }
  }
  const current = open()
  const started = current.store.startMeeting({ name: '演示会', sources: 'mic', consented: true,
    consentText: '参会人知情', retentionDays: 30 }, options.integrity === null ? undefined : { status: 'pending', reasons: [], tracks: {} })
  if (!started.ok) throw new Error(started.error)
  const meetingId = started.meetingId
  assert.equal(current.store.appendChunk(meetingId, Buffer.alloc(1600, 3), 1_800_000_000_000,
    { track: 'mic', trackSeq: 0, startMs: 0, sourceSampleRate: 16_000 }).ok, true)
  if (options.integrity === null) current.store.stopMeeting(meetingId)
  else assert.equal(current.store.finishRecording(meetingId, options.integrity ?? COMPLETE), true)
  current.store.setMeetingState(meetingId, 'transcribed')
  assert.equal(current.store.replaceSegments(meetingId, [options.failed ? { ...SEGMENT, source: 'failed' } : SEGMENT]).ok, true)
  assert.equal(current.recorder.useLocalMinutes(meetingId).ok, true)
  const minutes = current.store.getMinutes(meetingId)!
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  let picker: () => Promise<string | null> = async () => destination
  let picks = 0
  registerMeetingIpc({ ipc: { handle: (name, handler) => { handlers.set(name, handler) } }, recorder: current.recorder,
    chooseExportDirectory: async () => { picks++; return picker() } })
  const save = (digest = minutes.digest, revision = minutes.revision) => Promise.resolve(handlers.get('meeting-minutes')!({}, meetingId,
    { action: 'save-file', digest, revision })) as Promise<{ ok: boolean; error?: string; artifact?: {
      id: string; meetingId: string; revision: number; digest: string; confirmedAt: number; path: string } }>
  t.after(() => {
    for (const store of stores) { try { store.close() } catch { /* 测试中可能已关闭 */ } }
    rmSync(root, { recursive: true, force: true })
  })
  return { ...current, root, data, destination, meetingId, minutes, save, open,
    confirm: () => current.recorder.confirmMinutes(meetingId, minutes.digest),
    setPicker: (next: () => Promise<string | null>) => { picker = next }, picks: () => picks }
}

test('确认版写入本人选择的目录，内容摘要与会议版本一致，重启可核验且不覆盖', async t => {
  const h = fixture(t, { artifactId: ID })
  assert.equal(h.confirm().ok, true)
  const existing = path.join(h.destination, '已有文件.md')
  writeFileSync(existing, '原文件不能改变')
  const first = await h.save()
  assert.equal(first.ok, true, first.error)
  assert.ok(first.artifact)
  const artifact = first.artifact!
  assert.equal(artifact.meetingId, h.meetingId)
  assert.equal(artifact.revision, h.minutes.revision)
  assert.equal(artifact.digest, h.minutes.digest)
  assert.equal(path.dirname(artifact.path), h.destination)
  const bytes = readFileSync(artifact.path)
  assert.equal(bytes.toString('utf8'), h.minutes.content)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.digest)
  assert.equal(readFileSync(existing, 'utf8'), '原文件不能改变')
  const collision = await h.save()
  assert.equal(collision.ok, false, '相同文件名不能覆盖原文件')
  assert.deepEqual(readFileSync(artifact.path), bytes)
  h.store.close()
  const reopened = h.open()
  const checked = reopened.recorder.readMinutesArtifact(artifact.id)
  assert.equal(checked.ok, true, checked.ok ? undefined : checked.error)
  if (checked.ok) assert.equal(checked.content, h.minutes.content)
  const raw = readFileSync(path.join(h.data, 'meetings.sqlite'))
  assert.equal(raw.includes(Buffer.from(artifact.path)), false, '产物路径不得明文进入加密会议库')
  assert.equal(raw.includes(Buffer.from(h.minutes.content)), false)
})

test('没有确认、录音完整性未知或转写有失败段时，不弹保存窗口也不生成文件', async t => {
  const draft = fixture(t)
  assert.equal((await draft.save()).ok, false)
  assert.equal(draft.picks(), 0)
  for (const integrity of [null, { status: 'unknown', reasons: ['缺回执'], tracks: {} } as const,
    { status: 'incomplete', reasons: ['缺轨'], tracks: {} } as const]) {
    const h = fixture(t, { integrity })
    assert.equal(h.confirm().ok, true)
    assert.equal((await h.save()).ok, false)
    assert.equal(h.picks(), 0)
    assert.deepEqual(readdirSync(h.destination), [])
  }
  const failed = fixture(t, { failed: true })
  assert.equal(failed.confirm().ok, true)
  assert.equal((await failed.save()).ok, false)
  assert.equal(failed.picks(), 0)
})

test('选择目录期间版本变更或本人取消，均不写文件；伪造的摘要和修订也不能打开选择器', async t => {
  const h = fixture(t)
  assert.equal(h.confirm().ok, true)
  assert.equal((await h.save('f'.repeat(64))).ok, false)
  assert.equal((await h.save(h.minutes.digest, h.minutes.revision + 1)).ok, false)
  assert.equal(h.picks(), 0)
  h.setPicker(async () => null)
  assert.equal((await h.save()).ok, false)
  let choose!: (value: string | null) => void
  h.setPicker(() => new Promise(resolve => { choose = resolve }))
  const pending = h.save()
  assert.ok(h.recorder.renameSpeaker(h.meetingId, 'mic-s1', '新名字').ok)
  choose(h.destination)
  assert.equal((await pending).ok, false)
  assert.deepEqual(readdirSync(h.destination), [])
})

test('文件被修改、会议修订或确认失效后，旧产物不能再作为可信版本读取', async t => {
  const h = fixture(t)
  assert.equal(h.confirm().ok, true)
  const saved = await h.save()
  assert.ok(saved.ok && saved.artifact)
  const artifact = saved.artifact!
  assert.equal(h.recorder.readMinutesArtifact(artifact.id).ok, true)
  writeFileSync(artifact.path, '被更改的纪要')
  assert.equal(h.recorder.readMinutesArtifact(artifact.id).ok, false)
  writeFileSync(artifact.path, h.minutes.content)
  assert.ok(h.recorder.renameSpeaker(h.meetingId, 'mic-s1', '修订后').ok)
  assert.equal(h.recorder.readMinutesArtifact(artifact.id).ok, false)
  assert.equal(h.recorder.readMinutesArtifact('伪造产物').ok, false)
})

test('停录后音频文件损坏，不能只凭旧完整性回执导出或继续交接', async t => {
  const h = fixture(t)
  assert.equal(h.confirm().ok, true)
  const saved = await h.save()
  assert.ok(saved.ok && saved.artifact)
  const chunk = h.store.listChunks(h.meetingId)[0]!
  writeFileSync(chunk.path, '测试损坏')
  assert.equal(h.recorder.readMinutesArtifact(saved.artifact!.id).ok, false)
  assert.equal((await h.save()).ok, false)
  assert.equal(h.picks(), 1, '音频损坏后不会再询问保存位置')
})

test('文件写出后登记失败时明确报告可能残留文件，不冒充已登记的有效产物', async t => {
  const h = fixture(t, { artifactId: ID })
  assert.equal(h.confirm().ok, true)
  h.store.saveMinutesArtifact = () => { throw new Error('模拟登记中断') }
  const outcome = await h.save()
  assert.equal(outcome.ok, false)
  assert.match(outcome.error ?? '', /文件.*写出.*不可作为有效产物/u)
  assert.equal(readdirSync(h.destination).length, 1)
  assert.equal(h.recorder.readMinutesArtifact(ID).ok, false)
})
