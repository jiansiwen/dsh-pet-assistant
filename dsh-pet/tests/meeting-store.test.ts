/**
 * 会议持久层与 DPAPI 密钥的测试。
 *
 * 钉住的是几条不能靠肉眼验收的事实：明文 PCM 不落盘（加密 chunk 里搜不到明文标记）、
 * 密钥解不开时拒绝开会且不覆盖 key.bin、consent 必填项一个都不能少、断流 gap 如实
 * 记录、说话人修订 bump revision 并把已确认的纪要打回草稿、保留期到点删录音留转写、
 * 纪要没有用户亲手点就不算 confirmed。
 *
 * 跑法：`npm test`。DPAPI 用假 spawn 注入，不真跑 PowerShell；密钥用假 provider，
 * 不碰真机 key.bin。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { getDataKey, keyFilePath, type DpapiSpawn, type DpapiSpawnResult, type SafeStorageLike } from '../src/main/dpapi.ts'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  DIGEST_PREFIX,
  FIELD_PREFIX,
  MeetingStore,
  UNDECRYPTABLE_TEXT,
  validateMeetingConsent,
  type MeetingConsentInput,
  type TranscriptSegment,
} from '../src/main/meeting-store.ts'

const FAKE_KEY = Buffer.alloc(32, 7)

/**
 * 假的系统密钥库（替代 Electron 的 safeStorage）。
 *
 * 用可逆的 XOR 而不是 base64 —— 目的是让"落盘字节里不该出现明文"这条断言**真的有鉴别力**：
 * 如果实现不小心存了明文，`stored.includes(FAKE_KEY)` 会立刻命中。
 *
 * 返回类型写成可变对象：部分用例要把它改成"解不开"或"不可用"来验证失败路径。
 */
function fakeSafeStorage(): {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
} {
  const MASK = 0x5a
  return {
    isEncryptionAvailable: () => true,
    // Buffer.from(...).map 返回的是 Uint8Array，显式包一层 Buffer 才是 safeStorage 的形状。
    encryptString: (plain: string) => Buffer.from(Buffer.from(plain, 'utf8').map(byte => byte ^ MASK)),
    decryptString: (encrypted: Buffer) => Buffer.from(Buffer.from(encrypted).map(byte => byte ^ MASK)).toString('utf8'),
  }
}

const CONSENT: MeetingConsentInput = {
  name: '周一晨会',
  sources: 'mic',
  consentText: '我知晓本场会议将被录音并加密保存在本机',
  consented: true,
  retentionDays: 30,
}

const roots: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-meeting-'))
  roots.push(dir)
  return dir
}

process.on('exit', () => {
  for (const dir of roots) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录 */ }
  }
})

interface FakeClock {
  now(): number
  advance(ms: number): void
}

function fakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start
  return {
    now: () => current,
    advance: (ms) => { current += ms },
  }
}

function newStore(dir: string = freshDir(), opts: {
  key?: () => ReturnType<typeof getDataKey>
  clock?: FakeClock
  gapThresholdMs?: number
} = {}): MeetingStore {
  const clock = opts.clock ?? fakeClock()
  return new MeetingStore(dir, {
    keyProvider: opts.key ?? ((): DpapiKeyOk => ({ status: 'ok', key: FAKE_KEY })),
    now: clock.now,
    ...(opts.gapThresholdMs !== undefined ? { gapThresholdMs: opts.gapThresholdMs } : {}),
  })
}

type DpapiKeyOk = { status: 'ok'; key: Buffer }

describe('dpapi：密钥的生成、解包与丢失', () => {
  test('真实 Windows DPAPI：创建后重读同一密钥，损坏文件不能被重建覆盖', { skip: process.platform !== 'win32' }, () => {
    const dir = freshDir()
    const created = getDataKey(dir)
    assert.equal(created.status, 'ok', created.status === 'error' ? created.message : created.status)
    if (created.status !== 'ok') return
    assert.equal(created.key.length, 32)
    const file = keyFilePath(dir)
    const wrapped = readFileSync(file)
    assert.ok(!wrapped.equals(created.key))
    const reopened = getDataKey(dir)
    assert.equal(reopened.status, 'ok')
    if (reopened.status === 'ok') assert.ok(reopened.key.equals(created.key), '重读密钥必须一致')
    assert.ok(readFileSync(file).equals(wrapped), '重读不得改写密钥文件')
    const corrupted = Buffer.from('测试用损坏密钥')
    writeFileSync(file, corrupted)
    assert.equal(getDataKey(dir).status, 'lost')
    assert.ok(readFileSync(file).equals(corrupted), '损坏密钥必须保留原样')
  })

  test('真实密钥支持会议加密落盘、关闭后重新解密', { skip: process.platform !== 'win32' }, () => {
    const dir = freshDir()
    const pcm = Buffer.from('仅用于验证加密解密，不采集麦克风')
    const store = new MeetingStore(dir)
    let meetingId = ''
    try {
      const started = store.startMeeting(CONSENT)
      assert.equal(started.ok, true, started.ok ? '' : started.error)
      if (!started.ok) return
      meetingId = started.meetingId
      assert.equal(store.appendChunk(meetingId, pcm, Date.now()).ok, true)
      store.stopMeeting(meetingId)
    } finally {
      store.close()
    }
    const reopened = new MeetingStore(dir)
    try {
      const chunks = reopened.listChunks(meetingId)
      assert.equal(chunks.length, 1)
      assert.ok(reopened.readChunk(meetingId, chunks[0].seq)?.equals(pcm))
    } finally {
      reopened.close()
    }
  })

  test('没有系统密钥库时返回 unsupported，不碰磁盘', () => {
    const dir = freshDir()
    // 没注入 safeStorage 就说明这条实现拿不到（纯 Node 测试、Electron 未 ready 等）。
    const result = getDataKey(dir, { platform: 'darwin' })
    assert.equal(result.status, 'unsupported')
    assert.equal(existsSync(keyFilePath(dir)), false)
  })

  test('macOS：走 safeStorage 包装，落盘的是包装字节而非明文密钥', () => {
    const dir = freshDir()
    const store = fakeSafeStorage()
    const result = getDataKey(dir, { platform: 'darwin', safeStorage: store, randomBytes: () => FAKE_KEY })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.deepEqual(result.key, FAKE_KEY)
    const stored = readFileSync(keyFilePath(dir))
    // 落盘的是"包装后"的字节（假实现是 XOR），既不是明文，也不能含明文密钥字节。
    assert.ok(!stored.includes(FAKE_KEY), 'key.bin 里不能出现明文密钥字节')
    assert.deepEqual(stored, store.encryptString(FAKE_KEY.toString('base64')))
  })

  test('macOS：包装后能重新解出同一密钥（换进程/重启后仍可用）', () => {
    const dir = freshDir()
    const store = fakeSafeStorage()
    const created = getDataKey(dir, { platform: 'darwin', safeStorage: store, randomBytes: () => FAKE_KEY })
    assert.equal(created.status, 'ok')
    const reopened = getDataKey(dir, { platform: 'darwin', safeStorage: store })
    assert.equal(reopened.status, 'ok')
    if (reopened.status === 'ok') assert.deepEqual(reopened.key, FAKE_KEY)
  })

  test('macOS：钥匙串解不开时返回 lost，且绝不覆盖原文件', () => {
    const dir = freshDir()
    const file = keyFilePath(dir)
    writeFileSync(file, 'corrupted-bytes')
    const store = fakeSafeStorage()
    store.decryptString = () => { throw new Error('Keychain 解不开') }
    const result = getDataKey(dir, { platform: 'darwin', safeStorage: store })
    assert.equal(result.status, 'lost')
    // 静默重新生成 = 既有录音永久变乱码。文件必须原样。
    assert.equal(readFileSync(file, 'utf8'), 'corrupted-bytes')
  })

  test('macOS：系统密钥库不可用时返回 unsupported，不退化成明文', () => {
    const dir = freshDir()
    const store = fakeSafeStorage()
    store.isEncryptionAvailable = () => false
    const result = getDataKey(dir, { platform: 'darwin', safeStorage: store, randomBytes: () => FAKE_KEY })
    assert.equal(result.status, 'unsupported')
    // 退化成明文存储是**最坏**的选择：用户以为录音是加密的。
    assert.equal(existsSync(keyFilePath(dir)), false, '不可用就不能落任何密钥文件')
  })

  test('macOS：解出的不是 32 字节密钥时返回 lost', () => {
    const dir = freshDir()
    writeFileSync(keyFilePath(dir), 'wrapped')
    const store = fakeSafeStorage()
    store.decryptString = () => 'not!base64!key'
    assert.equal(getDataKey(dir, { platform: 'darwin', safeStorage: store }).status, 'lost')
  })

  test('key.bin 不在时生成 32 字节随机密钥并落 DPAPI 包装', () => {
    const dir = freshDir()
    const calls: string[][] = []
    const spawn: DpapiSpawn = (_command, args, input) => {
      calls.push([...args])
      assert.equal(input, FAKE_KEY.toString('base64'))
      assert.equal(args.some(arg => arg.includes(input)), false, '明文密钥不得出现在命令行')
      assert.match(args[args.length - 1], /ReadToEnd/)
      return { status: 0, stdout: `W${input}\n` }
    }
    const result = getDataKey(dir, { platform: 'win32', spawn, randomBytes: () => FAKE_KEY })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.deepEqual(result.key, FAKE_KEY)
    assert.equal(calls.length, 1)
    assert.ok(calls[0].join(' ').includes('Protect'), '应调用 DPAPI Protect')
    // 落盘的是"包装结果"的原始字节（假 DPAPI 的包装 = 'W' 前缀 + base64 再解码），
    // 既不是明文密钥，也不能包含明文密钥的字节形态。
    const stored = readFileSync(keyFilePath(dir))
    assert.deepEqual(stored, Buffer.from(`W${FAKE_KEY.toString('base64')}`, 'base64'))
    assert.ok(!stored.includes(FAKE_KEY), 'key.bin 里不能出现明文密钥字节')
  })

  test('key.bin 解包失败返回 lost，且绝不覆盖原文件', () => {
    const dir = freshDir()
    const file = keyFilePath(dir)
    writeFileSync(file, 'corrupted-bytes')
    const spawn: DpapiSpawn = () => ({ status: 1, stdout: '', error: new Error('CryptographicException') })
    const result = getDataKey(dir, { platform: 'win32', spawn })
    assert.equal(result.status, 'lost')
    // 静默重新生成 = 既有录音永久变乱码。文件必须原样。
    assert.equal(readFileSync(file, 'utf8'), 'corrupted-bytes')
  })

  test('key.bin 为空文件也算 lost', () => {
    const dir = freshDir()
    writeFileSync(keyFilePath(dir), '')
    const spawn: DpapiSpawn = () => {
      assert.fail('空文件不该去调 PowerShell')
    }
    assert.equal(getDataKey(dir, { platform: 'win32', spawn }).status, 'lost')
  })

  test('解包输出不是 32 字节密钥时返回 lost', () => {
    const dir = freshDir()
    writeFileSync(keyFilePath(dir), 'wrapped')
    const spawn: DpapiSpawn = () => ({ status: 0, stdout: 'not!base64!key\n' })
    assert.equal(getDataKey(dir, { platform: 'win32', spawn }).status, 'lost')
  })

  test('解包成功返回密钥', () => {
    const dir = freshDir()
    writeFileSync(keyFilePath(dir), 'wrapped')
    const spawn: DpapiSpawn = () => ({ status: 0, stdout: `${FAKE_KEY.toString('base64')}\n` })
    const result = getDataKey(dir, { platform: 'win32', spawn })
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') assert.deepEqual(result.key, FAKE_KEY)
  })
})

describe('meeting-store：没有密钥就没有会议', () => {
  test('密钥 lost 时 startMeeting 被拒，一行都不写', () => {
    const store = newStore(freshDir(), { key: () => ({ status: 'lost', message: '密钥可能已损坏' }) })
    const result = store.startMeeting(CONSENT)
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.error.includes('密钥'), `拒绝原因要如实说密钥问题：${result.error}`)
    assert.deepEqual(store.listMeetings(), [])
    store.close()
  })

  test('非 Windows（unsupported）同样拒绝', () => {
    const store = newStore(freshDir(), { key: () => ({ status: 'unsupported' }) })
    const result = store.startMeeting(CONSENT)
    assert.equal(result.ok, false)
    store.close()
  })
})

describe('meeting-store：consent 必填校验', () => {
  test('缺名字 / 缺同意文本 / 没勾选 / 来源不对 / 保留天数不对，全部拒绝', () => {
    assert.equal(validateMeetingConsent({ ...CONSENT, name: '  ' }), '要给这场会议起个名字')
    assert.equal(validateMeetingConsent({ ...CONSENT, consentText: '' }), '缺少知情同意文本')
    assert.equal(validateMeetingConsent({ ...CONSENT, consented: false })?.includes('知情同意'), true)
    assert.ok(validateMeetingConsent({ ...CONSENT, sources: 'everything' }) !== null)
    assert.ok(validateMeetingConsent({ ...CONSENT, retentionDays: 0 }) !== null)
    assert.ok(validateMeetingConsent({ ...CONSENT, retentionDays: 1.5 }) !== null)
    assert.ok(validateMeetingConsent(null) !== null)
    assert.equal(validateMeetingConsent(CONSENT), null)
  })

  test('store 层也拦：IPC 绕过 recorder 直接进来照样拒', () => {
    const store = newStore()
    const result = store.startMeeting({ ...CONSENT, consented: false })
    assert.equal(result.ok, false)
    store.close()
  })
})

describe('meeting-store：chunk 加密落盘，明文不出现在磁盘上', () => {
  test('加密 chunk 里没有明文标记，sidecar 与表行齐全，解密还原', () => {
    const dir = freshDir()
    const store = newStore(dir)
    const started = store.startMeeting(CONSENT)
    assert.equal(started.ok, true)
    if (!started.ok) return
    const meetingId = started.meetingId

    // 拿一段可识别的"明文"当录音：它要是出现在任何落盘文件里，就是泄了。
    const marker = 'TOPSECRET-PCM-MARKER-周一晨会'
    const pcm = Buffer.concat([Buffer.from(marker, 'utf8'), Buffer.alloc(640, 3)])
    const appended = store.appendChunk(meetingId, pcm, 1_700_000_001_000)
    assert.equal(appended.ok, true)

    const meetingDir = store.meetingDir(meetingId)
    const files = readdirSync(meetingDir)
    assert.ok(files.includes('chunk-0.enc'), '应有加密 chunk 文件')
    assert.ok(files.includes('chunk-0.json'), '应有 sidecar')

    for (const file of files) {
      const content = readFileSync(path.join(meetingDir, file))
      assert.ok(!content.includes(Buffer.from(marker, 'utf8')), `${file} 里出现了明文录音`)
      assert.ok(!content.toString('utf8').includes('TOPSECRET'), `${file} 里出现了明文标记`)
    }

    // sqlite 文件本身也不能有明文（表里只存 seq/path/sha）。
    const dbBytes = readFileSync(path.join(dir, 'meetings.sqlite'))
    assert.ok(!dbBytes.includes(Buffer.from(marker, 'utf8')), '数据库里出现了明文录音')

    // sidecar 形状。
    const sidecar = JSON.parse(readFileSync(path.join(meetingDir, 'chunk-0.json'), 'utf8')) as {
      seq: number; ts: number; sha256: string; gapAfterMs: number | null
    }
    assert.equal(sidecar.seq, 0)
    assert.equal(sidecar.ts, 1_700_000_001_000)
    assert.equal(typeof sidecar.sha256, 'string')
    assert.equal(sidecar.sha256.length, 64)
    assert.equal(sidecar.gapAfterMs, null)

    // 表行只存 seq/path/sha256。
    const rows = store.listChunks(meetingId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].seq, 0)
    assert.equal(rows[0].sha256, sidecar.sha256)
    assert.equal(path.basename(rows[0].path), 'chunk-0.enc')

    // 解密还原。
    const decrypted = store.readChunk(meetingId, 0)
    assert.ok(decrypted !== null)
    assert.deepEqual(decrypted, pcm)

    // 篡改一个字节：sha 校验不过，拒绝交出数据（也不崩溃）。
    const encPath = path.join(meetingDir, 'chunk-0.enc')
    const enc = readFileSync(encPath)
    enc[20] = enc[20] ^ 0xff
    writeFileSync(encPath, enc)
    assert.equal(store.readChunk(meetingId, 0), null)
    store.close()
  })

  test('ts 间隔超过阈值时把 gapAfterMs 记在前一块的 sidecar 上', () => {
    const store = newStore(freshDir(), { gapThresholdMs: 5000 })
    const started = store.startMeeting(CONSENT)
    assert.equal(started.ok, true)
    if (!started.ok) return
    const meetingId = started.meetingId

    store.appendChunk(meetingId, Buffer.alloc(640, 1), 1_000)
    const second = store.appendChunk(meetingId, Buffer.alloc(640, 1), 9_000)
    assert.equal(second.ok, true)
    if (second.ok) assert.equal(second.gapAfterMs, 8_000)

    const sidecar = store.listChunks(meetingId)[0].sidecar
    assert.ok(sidecar !== null)
    assert.equal(sidecar.gapAfterMs, 8_000, '断流间隔要落在前一块上')

    // 正常间隔不记 gap。
    store.appendChunk(meetingId, Buffer.alloc(640, 1), 12_000)
    assert.equal(store.listChunks(meetingId)[1].sidecar?.gapAfterMs, null)
    store.close()
  })

  test('stop 结算：endedAt 落库、chunk 文件保留、停止后拒收新块', () => {
    const store = newStore()
    const started = store.startMeeting(CONSENT)
    if (!started.ok) throw new Error('start 失败')
    const meetingId = started.meetingId
    store.appendChunk(meetingId, Buffer.alloc(640, 1), 1_000)
    store.stopMeeting(meetingId, 2_000)

    const meeting = store.getMeeting(meetingId)
    assert.ok(meeting !== null)
    assert.equal(meeting.state, 'stopped')
    assert.equal(meeting.endedAt, 2_000)
    assert.equal(store.chunkFileCount(meetingId), 1, '结算不删录音')

    const after = store.appendChunk(meetingId, Buffer.alloc(640, 1), 3_000)
    assert.equal(after.ok, false, '停止后不能再塞块进来')
    store.close()
  })
})

describe('meeting-store：说话人修订 bump revision', () => {
  function seeded(): { store: MeetingStore; meetingId: string } {
    const store = newStore()
    const started = store.startMeeting(CONSENT)
    if (!started.ok) throw new Error('start 失败')
    const segments: TranscriptSegment[] = [
      { idx: 0, speaker: 's1', label: '发言人1', uncertain: true, startMs: 0, endMs: 4000, text: '第一段', source: 'asr' },
      { idx: 1, speaker: 's1', label: '发言人1', uncertain: true, startMs: 4000, endMs: 8000, text: '第二段', source: 'asr' },
      { idx: 2, speaker: 's1', label: '发言人1', uncertain: true, startMs: 8000, endMs: 12000, text: '第三段', source: 'asr' },
    ]
    const replaced = store.replaceSegments(started.meetingId, segments)
    assert.equal(replaced.ok, true)
    return { store, meetingId: started.meetingId }
  }

  test('首次写入 revision=1；改名 bump 到 2 并去掉 uncertain', () => {
    const { store, meetingId } = seeded()
    assert.equal(store.getMeeting(meetingId)?.segmentsRevision, 1)
    const renamed = store.renameSpeaker(meetingId, 's1', '张三')
    assert.equal(renamed.ok, true)
    if (renamed.ok) assert.equal(renamed.revision, 2)
    const segments = store.getSegments(meetingId)
    assert.equal(segments.every(segment => segment.label === '张三' && !segment.uncertain), true)
    assert.equal(store.getMeeting(meetingId)?.segmentsRevision, 2)
    store.close()
  })

  test('合并：from 的段归到 into，revision bump', () => {
    const { store, meetingId } = seeded()
    store.splitSegments(meetingId, [2], '李四')
    const before = store.getMeeting(meetingId)?.segmentsRevision ?? 0
    const merged = store.mergeSpeakers(meetingId, 's2', 's1')
    assert.equal(merged.ok, true)
    if (merged.ok) assert.equal(merged.revision, before + 1)
    const segments = store.getSegments(meetingId)
    assert.equal(segments.every(segment => segment.speaker === 's1'), true)
    store.close()
  })

  test('拆分：选中的段进新说话人，revision bump', () => {
    const { store, meetingId } = seeded()
    const split = store.splitSegments(meetingId, [1], '李四')
    assert.equal(split.ok, true)
    const segments = store.getSegments(meetingId)
    assert.equal(segments[1].label, '李四')
    assert.equal(segments[1].uncertain, false)
    assert.notEqual(segments[1].speaker, segments[0].speaker)
    assert.equal(segments[0].label, '发言人1', '没选中的段不动')
    store.close()
  })

  test('非法修订被拒：空名字、合并到自己、没选段', () => {
    const { store, meetingId } = seeded()
    assert.equal(store.renameSpeaker(meetingId, 's1', '  ').ok, false)
    assert.equal(store.mergeSpeakers(meetingId, 's1', 's1').ok, false)
    assert.equal(store.splitSegments(meetingId, [], '新人').ok, false)
    store.close()
  })
})

describe('meeting-store：纪要只有用户点了才算确认', () => {
  function withMinutes(): { store: MeetingStore; meetingId: string } {
    const store = newStore()
    const started = store.startMeeting(CONSENT)
    if (!started.ok) throw new Error('start 失败')
    store.replaceSegments(started.meetingId, [
      { idx: 0, speaker: 's1', label: '发言人1', uncertain: true, startMs: 0, endMs: 4000, text: '第一段', source: 'asr' },
    ])
    store.saveMinutes(started.meetingId, '# 会议纪要\n- [00:00] 发言人1：第一段\n', 1)
    return { store, meetingId: started.meetingId }
  }

  test('未确认时 state=draft；userClicked=false 不能确认', () => {
    const { store, meetingId } = withMinutes()
    assert.equal(store.getMinutes(meetingId)?.state, 'draft')
    const refused = store.confirmMinutes(meetingId, { userClicked: false })
    assert.equal(refused.ok, false, '流水线自己不能把纪要变成已确认')
    assert.equal(store.getMinutes(meetingId)?.state, 'draft')
    store.close()
  })

  test('userClicked=true 才 confirmed，落 confirmedAt', () => {
    const { store, meetingId } = withMinutes()
    const result = store.confirmMinutes(meetingId, { userClicked: true })
    assert.equal(result.ok, true)
    const minutes = store.getMinutes(meetingId)
    assert.equal(minutes?.state, 'confirmed')
    assert.ok(minutes?.confirmedAt !== null && minutes?.confirmedAt !== undefined)
    store.close()
  })

  test('确认后修订说话人：纪要自动退回草稿（确认的文本不能和库脱节）', () => {
    const { store, meetingId } = withMinutes()
    store.confirmMinutes(meetingId, { userClicked: true })
    store.renameSpeaker(meetingId, 's1', '张三')
    assert.equal(store.getMinutes(meetingId)?.state, 'draft')
    // 旧 revision 的确认不再作数，重新生成后才能再确认。
    const stale = store.confirmMinutes(meetingId, { userClicked: true })
    assert.equal(stale.ok, false, 'revision 落后的纪要不能确认')
    store.saveMinutes(meetingId, '# 会议纪要（修订版）\n', store.getMeeting(meetingId)?.segmentsRevision ?? 0)
    assert.equal(store.confirmMinutes(meetingId, { userClicked: true }).ok, true)
    store.close()
  })

  test('纪要还没生成时不能确认', () => {
    const store = newStore()
    const started = store.startMeeting(CONSENT)
    if (!started.ok) throw new Error('start 失败')
    assert.equal(store.confirmMinutes(started.meetingId, { userClicked: true }).ok, false)
    store.close()
  })
})

describe('meeting-store：保留期到点删录音，转写与纪要保留', () => {
  test('enforceRetention 删 chunk 文件与行，state=expired，段还在', () => {
    const dir = freshDir()
    const store = newStore(dir)
    const started = store.startMeeting({ ...CONSENT, retentionDays: 1 })
    if (!started.ok) throw new Error('start 失败')
    const meetingId = started.meetingId
    store.appendChunk(meetingId, Buffer.alloc(640, 1), 1_000)
    store.replaceSegments(meetingId, [
      { idx: 0, speaker: 's1', label: '发言人1', uncertain: true, startMs: 0, endMs: 1, text: '留着的转写', source: 'asr' },
    ])
    const dayMs = 86_400_000
    store.stopMeeting(meetingId, 1_700_000_000_000)

    // 没到期：什么都不动。
    assert.deepEqual(store.enforceRetention(1_700_000_000_000 + dayMs - 1), [])
    assert.equal(store.chunkFileCount(meetingId), 1)

    // 到期：目录、行、状态一起清；转写保留。
    const expired = store.enforceRetention(1_700_000_000_000 + dayMs + 1)
    assert.deepEqual(expired, [meetingId])
    assert.equal(store.chunkFileCount(meetingId), 0)
    assert.equal(existsSync(store.meetingDir(meetingId)), false)
    assert.deepEqual(store.listChunks(meetingId), [])
    const meeting = store.getMeeting(meetingId)
    assert.equal(meeting?.state, 'expired')
    assert.equal(store.getSegments(meetingId).length, 1, '转写不是录音，保留期只删录音')
    assert.equal(store.getSegments(meetingId)[0].text, '留着的转写', '保留期清理后转写仍能解密读出')
    assert.equal(meeting?.name, CONSENT.name)
    store.close()
  })

  test('进行中的会议不被保留期清掉', () => {
    const store = newStore()
    const started = store.startMeeting({ ...CONSENT, retentionDays: 1 })
    if (!started.ok) throw new Error('start 失败')
    store.appendChunk(started.meetingId, Buffer.alloc(640, 1), 1_000)
    // endedAt 为 NULL：还在录的会议没有"到期"一说。
    assert.deepEqual(store.enforceRetention(Date.now() + 10 * 86_400_000), [])
    assert.equal(store.chunkFileCount(started.meetingId), 1)
    store.close()
  })
})

describe('meeting-store：助理播报区间', () => {
  test('记录并按时序读出；endMs<=startMs 的坏区间不进库', () => {
    const store = newStore()
    const started = store.startMeeting(CONSENT)
    if (!started.ok) throw new Error('start 失败')
    store.addAssistantSpeech(started.meetingId, 5000, 9000)
    store.addAssistantSpeech(started.meetingId, 1000, 2000)
    store.addAssistantSpeech(started.meetingId, 9000, 9000)
    const spans = store.listAssistantSpeech(started.meetingId)
    assert.deepEqual(spans, [
      { startMs: 1000, endMs: 2000 },
      { startMs: 5000, endMs: 9000 },
    ])
    store.close()
  })
})

// ===== M4-01：库内敏感字段加密、旧库迁移、密钥丢失 =====

const MARKERS = ['M4MARK-NAME', 'M4MARK-CONSENT', 'M4MARK-TEXT', 'M4MARK-LABEL', 'M4MARK-MINUTES', 'M4MARK-DELETED'] as const

/** 库文件 + WAL + SHM 的全部字节（存在的才读）。 */
function dbFileBytes(dir: string): Array<{ file: string; bytes: Buffer }> {
  return ['meetings.sqlite', 'meetings.sqlite-wal', 'meetings.sqlite-shm']
    .map(file => path.join(dir, file))
    .filter(file => existsSync(file))
    .map(file => ({ file, bytes: readFileSync(file) }))
}

function assertNoMarkers(dir: string, where: string): void {
  const files = dbFileBytes(dir)
  assert.ok(files.length > 0)
  for (const { file, bytes } of files) {
    for (const marker of MARKERS) {
      assert.ok(!bytes.includes(Buffer.from(marker, 'utf8')), `${where}：${path.basename(file)} 里出现了明文 ${marker}`)
    }
  }
}

function anyMarkerPresent(dir: string): boolean {
  return dbFileBytes(dir).some(({ bytes }) => MARKERS.some(marker => bytes.includes(Buffer.from(marker, 'utf8'))))
}

/** 旁路连接读库原始列值（不经 store 解密）。 */
function rawRows(dir: string): { meetings: unknown[]; segments: unknown[]; minutes: unknown[] } {
  const db = new DatabaseSync(path.join(dir, 'meetings.sqlite'))
  try {
    return {
      meetings: db.prepare('SELECT id, name, consent FROM meetings ORDER BY id').all().map(row => ({ ...row })),
      segments: db.prepare('SELECT meetingId, revision, idx, label, text FROM transcript_segments ORDER BY meetingId, idx').all().map(row => ({ ...row })),
      minutes: db.prepare('SELECT meetingId, revision, content, digest, state, confirmedAt FROM minutes ORDER BY meetingId').all().map(row => ({ ...row })),
    }
  } finally {
    db.close()
  }
}

function rawExec(dir: string, sql: string, ...params: Array<string | number | null>): void {
  const db = new DatabaseSync(path.join(dir, 'meetings.sqlite'))
  try {
    db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

const LEGACY_SCHEMA = `
CREATE TABLE meetings (id TEXT PRIMARY KEY, name TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, sources TEXT NOT NULL,
  consent TEXT NOT NULL, retentionDays INTEGER NOT NULL, state TEXT NOT NULL, segmentsRevision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE chunks (meetingId TEXT NOT NULL, seq INTEGER NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY (meetingId, seq));
CREATE TABLE transcript_segments (meetingId TEXT NOT NULL, revision INTEGER NOT NULL, idx INTEGER NOT NULL, speaker TEXT NOT NULL,
  label TEXT NOT NULL, uncertain INTEGER NOT NULL DEFAULT 1, startMs INTEGER, endMs INTEGER, text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'asr', PRIMARY KEY (meetingId, idx));
CREATE TABLE minutes (meetingId TEXT PRIMARY KEY, revision INTEGER NOT NULL, content TEXT NOT NULL, digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft', confirmedAt INTEGER);
CREATE TABLE assistant_speech (meetingId TEXT NOT NULL, startMs INTEGER NOT NULL, endMs INTEGER NOT NULL);
`

const LEGACY_MINUTES = '# 会议纪要 M4MARK-MINUTES\n- 发言人：M4MARK-TEXT-0\n'

/**
 * 按旧版本的写法造一个明文库：会议 m1（两段转写、已确认纪要）、会议 m2（digest 对不上的已确认纪要），
 * 外加一行先插后删的明文——旧版本没开 secure_delete，删掉的行会留在空闲空间里。
 */
function buildLegacyDb(dir: string): void {
  const db = new DatabaseSync(path.join(dir, 'meetings.sqlite'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(LEGACY_SCHEMA)
  const consent = (name: string): string => JSON.stringify({ ...CONSENT, name, consentText: '同意 M4MARK-CONSENT' })
  const insertMeeting = db.prepare(
    "INSERT INTO meetings VALUES (?, ?, 1700000000000, 1700000100000, 'mic', ?, 30, 'transcribed', 1)",
  )
  insertMeeting.run('m1', '旧会 M4MARK-NAME-1', consent('旧会 M4MARK-NAME-1'))
  insertMeeting.run('m2', '旧会 M4MARK-NAME-2', consent('旧会 M4MARK-NAME-2'))
  const insertSegment = db.prepare("INSERT INTO transcript_segments VALUES ('m1', 1, ?, 's1', ?, 1, ?, ?, ?, 'asr')")
  insertSegment.run(0, '发言人 M4MARK-LABEL', 0, 4000, '第一段 M4MARK-TEXT-0')
  insertSegment.run(1, '发言人 M4MARK-LABEL', 4000, 8000, '第二段 M4MARK-TEXT-1')
  db.prepare("INSERT INTO minutes VALUES ('m1', 1, ?, ?, 'confirmed', 1700000200000)").run(LEGACY_MINUTES, sha(LEGACY_MINUTES))
  db.prepare("INSERT INTO minutes VALUES ('m2', 1, ?, ?, 'confirmed', 1700000200000)").run('另一份 M4MARK-MINUTES', 'f'.repeat(64))
  db.prepare("INSERT INTO transcript_segments VALUES ('m2', 1, 9, 's1', 'x', 1, 0, 1, ?, 'asr')").run('删掉的 M4MARK-DELETED '.repeat(20))
  db.prepare("DELETE FROM transcript_segments WHERE meetingId = 'm2'").run()
  db.close()
}

function legacyStore(dir: string, opts: { key?: () => ReturnType<typeof getDataKey>; beforeMigrateRow?: (table: string, rowKey: string) => void } = {}): MeetingStore {
  return new MeetingStore(dir, {
    keyProvider: opts.key ?? ((): DpapiKeyOk => ({ status: 'ok', key: FAKE_KEY })),
    now: fakeClock().now,
    ...(opts.beforeMigrateRow !== undefined ? { beforeMigrateRow: opts.beforeMigrateRow } : {}),
  })
}

/** 新库里造一场带全套敏感字段的会议。 */
function seedEncrypted(store: MeetingStore): string {
  const started = store.startMeeting({ ...CONSENT, name: '评审 M4MARK-NAME', consentText: '同意 M4MARK-CONSENT' })
  if (!started.ok) throw new Error(started.error)
  const replaced = store.replaceSegments(started.meetingId, [
    { idx: 0, speaker: 's1', label: '发言人 M4MARK-LABEL', uncertain: true, startMs: 0, endMs: 4000, text: '第一段 M4MARK-TEXT-0', source: 'asr' },
    { idx: 1, speaker: 's1', label: '发言人 M4MARK-LABEL', uncertain: true, startMs: 4000, endMs: 8000, text: '第二段 M4MARK-TEXT-1', source: 'asr' },
    { idx: 2, speaker: 's1', label: '发言人 M4MARK-LABEL', uncertain: true, startMs: 8000, endMs: 12000, text: '第三段 M4MARK-TEXT-2', source: 'asr' },
  ])
  if (!replaced.ok) throw new Error(replaced.error)
  const saved = store.saveMinutes(started.meetingId, '# 纪要 M4MARK-MINUTES\n', replaced.revision)
  if (!saved.ok) throw new Error(saved.error)
  return started.meetingId
}

/** 假 DPAPI：XOR 包装（自反），Protect/Unprotect 同一实现；可切换成"解不开"。 */
function fakeDpapi(): { spawn: DpapiSpawn; calls: string[]; failUnprotect: boolean } {
  const state = {
    calls: [] as string[],
    failUnprotect: false,
    spawn: ((_command: string, args: readonly string[], input: string): DpapiSpawnResult => {
      const script = args[args.length - 1]
      const op = script.includes('Unprotect') ? 'Unprotect' : 'Protect'
      state.calls.push(op)
      if (op === 'Unprotect' && state.failUnprotect) return { status: 1, stdout: '', error: new Error('CryptographicException') }
      const out = Buffer.from(Buffer.from(input, 'base64').map(byte => byte ^ 0x5a)).toString('base64')
      return { status: 0, stdout: `${out}\n` }
    }) as DpapiSpawn,
  }
  return state
}

describe('meeting-store：库内敏感字段加密（M4-01）', () => {
  test('加密往返：名称/同意/转写/纪要读回原文，库与 WAL 字节里没有明文标记', () => {
    const dir = freshDir()
    const store = newStore(dir)
    const meetingId = seedEncrypted(store)

    const meeting = store.getMeeting(meetingId)
    assert.equal(meeting?.name, '评审 M4MARK-NAME')
    assert.equal(meeting?.consent.consentText, '同意 M4MARK-CONSENT')
    assert.equal(meeting?.undecryptable, undefined)
    const segments = store.getSegments(meetingId)
    assert.deepEqual(segments.map(segment => segment.text), ['第一段 M4MARK-TEXT-0', '第二段 M4MARK-TEXT-1', '第三段 M4MARK-TEXT-2'])
    assert.ok(segments.every(segment => segment.label === '发言人 M4MARK-LABEL' && segment.undecryptable === undefined))
    const minutes = store.getMinutes(meetingId)
    assert.equal(minutes?.content, '# 纪要 M4MARK-MINUTES\n')
    assert.equal(minutes?.digest, sha('# 纪要 M4MARK-MINUTES\n'), '对外 digest 仍是 sha256(明文)')

    // 原始列：全部带版本前缀；digest 列是 HMAC，不是可被猜内容比对的明文 sha256。
    const raw = rawRows(dir) as {
      meetings: Array<{ name: string; consent: string }>
      segments: Array<{ label: string; text: string }>
      minutes: Array<{ content: string; digest: string }>
    }
    assert.ok(raw.meetings.every(row => row.name.startsWith(FIELD_PREFIX) && row.consent.startsWith(FIELD_PREFIX)))
    assert.ok(raw.segments.every(row => row.label.startsWith(FIELD_PREFIX) && row.text.startsWith(FIELD_PREFIX)))
    assert.ok(raw.minutes[0].content.startsWith(FIELD_PREFIX))
    assert.ok(raw.minutes[0].digest.startsWith(DIGEST_PREFIX))
    assert.ok(!raw.minutes[0].digest.includes(sha('# 纪要 M4MARK-MINUTES\n')))

    // 改名/合并/拆分照常可用，写回的仍是密文。
    assert.equal(store.renameSpeaker(meetingId, 's1', '张三').ok, true)
    assert.equal(store.splitSegments(meetingId, [2], '李四').ok, true)
    assert.equal(store.mergeSpeakers(meetingId, 's2', 's1').ok, true)
    assert.ok(store.getSegments(meetingId).every(segment => segment.label === '张三' && segment.undecryptable === undefined))
    assert.equal(store.getSegments(meetingId)[2].text, '第三段 M4MARK-TEXT-2')

    assertNoMarkers(dir, '库打开期间')
    store.close()
    assertNoMarkers(dir, '库关闭后')
  })

  test('密文挪行（AAD 不符）或纪要 HMAC 被改：如实标不可解密，修订与确认都拒绝，库不被改写', () => {
    const dir = freshDir()
    const store = newStore(dir)
    const meetingId = seedEncrypted(store)
    const raw = rawRows(dir) as { segments: Array<{ text: string }> }
    // 把第 0 段的密文搬到第 1 段：GCM 的 AAD 绑了行键，必须解不开。
    rawExec(dir, 'UPDATE transcript_segments SET text = ? WHERE meetingId = ? AND idx = 1', raw.segments[0].text, meetingId)
    const segments = store.getSegments(meetingId)
    assert.equal(segments[0].text, '第一段 M4MARK-TEXT-0')
    assert.equal(segments[1].undecryptable, true)
    assert.equal(segments[1].text, UNDECRYPTABLE_TEXT, '不可解密不能当成正常内容，也不能是空串')
    const before = rawRows(dir)
    const renamed = store.renameSpeaker(meetingId, 's1', '张三')
    assert.equal(renamed.ok, false, '带不可解密段的修订必须拒绝，否则占位文本会被加密写回')
    assert.equal(store.saveMinutes(meetingId, '新纪要', 1).ok, false)
    assert.deepEqual(rawRows(dir), before, '拒绝时库里一个字节都不动')

    // 纪要 digest 被改：内容完整性校验不过，按不可解密处理，不能确认。
    rawExec(dir, 'UPDATE minutes SET digest = ? WHERE meetingId = ?', `${DIGEST_PREFIX}${'0'.repeat(64)}`, meetingId)
    const minutes = store.getMinutes(meetingId)
    assert.equal(minutes?.undecryptable, true)
    assert.equal(minutes?.content, UNDECRYPTABLE_TEXT)
    assert.equal(store.confirmMinutes(meetingId, { userClicked: true }).ok, false)
    store.close()
  })

  test('纪要确认仍绑定 revision 与 digest：同版同文保留确认，改文或修订退回草稿', () => {
    const store = newStore()
    const meetingId = seedEncrypted(store)
    const revision = store.getMeeting(meetingId)?.segmentsRevision ?? 0
    assert.equal(store.confirmMinutes(meetingId, { userClicked: false }).ok, false)
    assert.equal(store.confirmMinutes(meetingId, { userClicked: true }).ok, true)
    // 同 revision 同内容重存：确认保留。
    assert.equal(store.saveMinutes(meetingId, '# 纪要 M4MARK-MINUTES\n', revision).ok, true)
    assert.equal(store.getMinutes(meetingId)?.state, 'confirmed')
    // 内容变了：退回草稿。
    assert.equal(store.saveMinutes(meetingId, '# 纪要（改）\n', revision).ok, true)
    assert.equal(store.getMinutes(meetingId)?.state, 'draft')
    assert.equal(store.getMinutes(meetingId)?.digest, sha('# 纪要（改）\n'))
    assert.equal(store.confirmMinutes(meetingId, { userClicked: true }).ok, true)
    // 段修订：退回草稿且旧版不能再确认。
    store.renameSpeaker(meetingId, 's1', '王五')
    assert.equal(store.getMinutes(meetingId)?.state, 'draft')
    assert.equal(store.confirmMinutes(meetingId, { userClicked: true }).ok, false)
    store.close()
  })
})

describe('meeting-store：旧明文库迁移（M4-01）', () => {
  test('旧库打开即迁移：内容不变、确认保留、库与 WAL 里找不到明文（含已删行残留）；重复迁移幂等', () => {
    const dir = freshDir()
    buildLegacyDb(dir)
    assert.ok(anyMarkerPresent(dir), '前提：旧库里确有明文（否则下面的断言没有鉴别力）')

    const store = legacyStore(dir)
    const status = store.migrationStatus()
    assert.equal(status.state, 'migrated')
    if (status.state === 'migrated') {
      assert.equal(status.rows, 6, '2 场会议 + 2 段转写 + 2 份纪要')
      assert.equal(status.checkpoint, 'ok')
    }
    assertNoMarkers(dir, '迁移后')

    assert.equal(store.getMeeting('m1')?.name, '旧会 M4MARK-NAME-1')
    assert.equal(store.getMeeting('m1')?.consent.consentText, '同意 M4MARK-CONSENT')
    assert.deepEqual(store.getSegments('m1').map(segment => segment.text), ['第一段 M4MARK-TEXT-0', '第二段 M4MARK-TEXT-1'])
    const minutes = store.getMinutes('m1')
    assert.equal(minutes?.content, LEGACY_MINUTES)
    assert.equal(minutes?.digest, sha(LEGACY_MINUTES), '迁移前后 digest 语义一致')
    assert.equal(minutes?.state, 'confirmed', '绑定成立的确认在迁移后保留')
    assert.equal(store.getMinutes('m2')?.state, 'draft', '旧 digest 与内容对不上：不能借迁移洗成有效确认')

    // 幂等：再跑一次是空操作，密文逐字节不变；重开库也一样。
    const snapshot = rawRows(dir)
    assert.equal(store.migrateLegacyPlaintext().state, 'not-needed')
    assert.deepEqual(rawRows(dir), snapshot)
    store.close()
    const reopened = legacyStore(dir)
    assert.equal(reopened.migrationStatus().state, 'not-needed')
    assert.deepEqual(rawRows(dir), snapshot)
    // 迁移后的旧库照常支持改名/确认。
    assert.equal(reopened.renameSpeaker('m1', 's1', '张三').ok, true)
    assert.equal(reopened.getMinutes('m1')?.state, 'draft')
    reopened.close()
    assertNoMarkers(dir, '迁移后再修订')
  })

  test('迁移中途失败：整体回滚、明文原样可读；之后重来能迁完', () => {
    const dir = freshDir()
    buildLegacyDb(dir)
    const before = rawRows(dir)
    let segmentCalls = 0
    const store = legacyStore(dir, {
      beforeMigrateRow: (table) => {
        if (table === 'transcript_segments' && ++segmentCalls === 2) throw new Error('模拟磁盘错误')
      },
    })
    const status = store.migrationStatus()
    assert.equal(status.state, 'failed')
    if (status.state === 'failed') assert.ok(status.error.includes('模拟磁盘错误'))
    assert.deepEqual(rawRows(dir), before, '失败不得留下半迁移状态（已处理的会议行也要回滚）')
    // 读取不受影响：旧明文原样返回、不带不可解密标记。
    assert.equal(store.getMeeting('m1')?.name, '旧会 M4MARK-NAME-1')
    assert.equal(store.getSegments('m1')[1].text, '第二段 M4MARK-TEXT-1')
    assert.equal(store.getMinutes('m1')?.digest, sha(LEGACY_MINUTES))
    store.close()

    const retried = legacyStore(dir)
    assert.equal(retried.migrationStatus().state, 'migrated')
    assert.equal(retried.getSegments('m1')[1].text, '第二段 M4MARK-TEXT-1')
    assert.equal(retried.getMinutes('m1')?.state, 'confirmed')
    retried.close()
    assertNoMarkers(dir, '重试迁移后')
  })

  test('密钥不可用：迁移 blocked、不改库、不崩溃；拿到密钥后（重开）补迁', () => {
    const dir = freshDir()
    buildLegacyDb(dir)
    const before = rawRows(dir)
    const lost = legacyStore(dir, { key: () => ({ status: 'lost', message: '密钥可能已损坏' }) })
    const status = lost.migrationStatus()
    assert.equal(status.state, 'blocked')
    if (status.state === 'blocked') assert.ok(status.error.includes('密钥'))
    assert.deepEqual(rawRows(dir), before)
    assert.equal(lost.getMeeting('m1')?.name, '旧会 M4MARK-NAME-1', '旧明文如实返回（它本来就是明文，不是伪造）')
    assert.equal(lost.startMeeting(CONSENT).ok, false)
    lost.close()

    const ok = legacyStore(dir)
    assert.equal(ok.migrationStatus().state, 'migrated')
    ok.close()
    assertNoMarkers(dir, '补迁后')
  })
})

describe('meeting-store：密钥丢失/不对时读取明确失败（M4-01）', () => {
  test('lost 或换了密钥：字段标不可解密，修订/存纪要/确认全拒，库不被改写', () => {
    const dir = freshDir()
    const store = newStore(dir)
    const meetingId = seedEncrypted(store)
    store.close()
    const snapshot = rawRows(dir)

    for (const key of [
      (): ReturnType<typeof getDataKey> => ({ status: 'lost', message: '密钥可能已损坏' }),
      (): ReturnType<typeof getDataKey> => ({ status: 'ok', key: Buffer.alloc(32, 9) }),
    ]) {
      const reopened = newStore(dir, { key })
      const meeting = reopened.getMeeting(meetingId)
      assert.equal(meeting?.undecryptable, true)
      assert.equal(meeting?.name, UNDECRYPTABLE_TEXT)
      assert.equal(meeting?.consent.consentText, UNDECRYPTABLE_TEXT)
      assert.equal(reopened.listMeetings().length, 1, '列表不崩溃')
      const segments = reopened.getSegments(meetingId)
      assert.ok(segments.length === 3 && segments.every(segment => segment.undecryptable === true && segment.text === UNDECRYPTABLE_TEXT))
      const minutes = reopened.getMinutes(meetingId)
      assert.equal(minutes?.undecryptable, true)
      assert.equal(minutes?.content, UNDECRYPTABLE_TEXT)
      assert.equal(minutes?.digest, '')
      assert.equal(reopened.confirmMinutes(meetingId, { userClicked: true }).ok, false)
      assert.equal(reopened.renameSpeaker(meetingId, 's1', '张三').ok, false)
      assert.equal(reopened.splitSegments(meetingId, [0], '李四').ok, false)
      assert.equal(reopened.saveMinutes(meetingId, '# 新纪要', 1).ok, false)
      reopened.close()
      assert.deepEqual(rawRows(dir), snapshot)
    }
  })

  test('真实 DPAPI 路径（假 spawn）：key.bin 损坏不被覆盖；key.bin 被删也不新建密钥顶替', () => {
    const dir = freshDir()
    const dpapi = fakeDpapi()
    const store = new MeetingStore(dir, { dpapi: { platform: 'win32', spawn: dpapi.spawn }, now: fakeClock().now })
    const meetingId = seedEncrypted(store)
    store.close()
    const wrapped = readFileSync(keyFilePath(dir))

    // 1) 解包失败（损坏/换账户）：读取标不可解密，key.bin 原样。
    dpapi.failUnprotect = true
    const broken = new MeetingStore(dir, { dpapi: { platform: 'win32', spawn: dpapi.spawn } })
    assert.equal(broken.getMeeting(meetingId)?.undecryptable, true)
    assert.equal(broken.getSegments(meetingId)[0].undecryptable, true)
    const refused = broken.startMeeting(CONSENT)
    assert.equal(refused.ok, false)
    if (!refused.ok) assert.ok(refused.error.includes('密钥'))
    broken.close()
    assert.ok(readFileSync(keyFilePath(dir)).equals(wrapped), '损坏密钥文件必须原样保留')

    // 2) key.bin 不见了：库里已有密文，绝不调 Protect 生成新密钥。
    dpapi.failUnprotect = false
    rmSync(keyFilePath(dir))
    dpapi.calls.length = 0
    const missing = new MeetingStore(dir, { dpapi: { platform: 'win32', spawn: dpapi.spawn } })
    assert.equal(missing.getMeeting(meetingId)?.name, UNDECRYPTABLE_TEXT)
    const again = missing.startMeeting(CONSENT)
    assert.equal(again.ok, false)
    if (!again.ok) assert.ok(again.error.includes('密钥'))
    missing.close()
    assert.equal(existsSync(keyFilePath(dir)), false, '不得新建密钥')
    assert.deepEqual(dpapi.calls, [], '不得调用 DPAPI 生成新密钥')

    // 3) 把原 key.bin 放回来：数据完好如初。
    writeFileSync(keyFilePath(dir), wrapped)
    const restored = new MeetingStore(dir, { dpapi: { platform: 'win32', spawn: dpapi.spawn } })
    assert.equal(restored.getMeeting(meetingId)?.name, '评审 M4MARK-NAME')
    assert.equal(restored.getMinutes(meetingId)?.content, '# 纪要 M4MARK-MINUTES\n')
    restored.close()
  })
})
