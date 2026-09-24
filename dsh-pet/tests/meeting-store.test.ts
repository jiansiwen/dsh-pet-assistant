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
import {
  MeetingStore,
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
