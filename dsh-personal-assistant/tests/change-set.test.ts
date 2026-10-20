/**
 * 改动提案的纯逻辑与原子提交（M2-06）：补丁严格套用、审阅差异重算、冲突零写入、临时文件 + 改名、失败回滚。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  ABSENT_VERSION, applyUnifiedDiff, buildChangeReview, commitFiles, decodeText, diffTrees, readSnapshot, sha256Hex,
  snapshotTree, splitLines, unifiedDiff,
} from '../src/change-set.ts'

function tempDir(t: TestContext): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'dsh-change-set-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function hashOf(text: string): string {
  return sha256Hex(Buffer.from(text, 'utf8'))
}

test('统一 diff 严格套用：上下文逐字匹配；对不上、有歧义都拒绝，不做模糊套用', () => {
  const base = 'function add(a, b) {\n  return a - b\n}\n'
  const ok = applyUnifiedDiff(base, '@@ -1,3 +1,3 @@\n function add(a, b) {\n-  return a - b\n+  return a + b\n }\n')
  assert.deepEqual(ok, { ok: true, text: 'function add(a, b) {\n  return a + b\n}\n' })
  // 行号写错但上下文唯一：按上下文定位。
  assert.equal(applyUnifiedDiff(base, '@@ -7,3 +7,3 @@\n function add(a, b) {\n-  return a - b\n+  return a + b\n }').ok, true)
  const mismatch = applyUnifiedDiff(base, '@@ -1,2 +1,2 @@\n function add(x, y) {\n-  return a - b\n+  return a + b\n')
  assert.equal(mismatch.ok, false)
  assert.match(!mismatch.ok ? mismatch.error : '', /对不上/)
  const twice = 'x = 1\ny = 2\nx = 1\ny = 2\n'
  // 段头指向第 3 行：第 2 行与第 4 行的 y = 2 离它一样近，无法确定改哪一处。
  const ambiguous = applyUnifiedDiff(twice, '@@ -3,1 +3,1 @@\n-y = 2\n+y = 3\n')
  assert.equal(ambiguous.ok, false)
  assert.match(!ambiguous.ok ? ambiguous.error : '', /多处/)
  assert.deepEqual(applyUnifiedDiff(twice, '@@ -4,1 +4,1 @@\n-y = 2\n+y = 3\n'), { ok: true, text: 'x = 1\ny = 2\nx = 1\ny = 3\n' })
  assert.equal(applyUnifiedDiff(base, '这不是补丁').ok, false)
  assert.equal(applyUnifiedDiff(base, '@@ -1,1 +1,1 @@\n function add(a, b) {\n').ok, false, '没有任何增删的段不收')
  const multi = '--- a/x.js\n+++ b/x.js\n@@ -1,1 +1,1 @@\n-a\n+b\n--- a/y.js\n+++ b/y.js\n@@ -1,1 +1,1 @@\n-c\n+d\n'
  assert.match((applyUnifiedDiff('a\n', multi) as { error: string }).error, /只能针对一个文件/)
})

test('统一 diff 保留文件原有的 CRLF 换行，处理「末尾没有换行」', () => {
  const crlf = 'a\r\nb\r\nc\r\n'
  const applied = applyUnifiedDiff(crlf, '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n')
  assert.deepEqual(applied, { ok: true, text: 'a\r\nB\r\nc\r\n' })
  const noEol = 'a\nb'
  assert.deepEqual(applyUnifiedDiff(noEol, '@@ -1,2 +1,3 @@\n a\n b\n+c\n\\ No newline at end of file\n'), { ok: true, text: 'a\nb\nc' })
  // 删除以 -- 开头的行（diff 里写作 ---）不能被当成第二个文件头。
  assert.deepEqual(applyUnifiedDiff('-- 注释\nselect 1\n', '@@ -1,2 +1,1 @@\n--- 注释\n select 1\n'), { ok: true, text: 'select 1\n' })
})

test('审阅差异由插件重算：增删行数覆盖全部改动，展示超出预算时如实截断并提示', () => {
  const before = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n') + '\n'
  const after = before.replace('line 3\n', 'line three\n').replace('line 25\n', 'line twenty-five\n')
  const diff = unifiedDiff(before, after)
  assert.equal(diff.added, 2)
  assert.equal(diff.removed, 2)
  assert.equal(diff.text.split('\n').filter(line => line.startsWith('@@')).length, 2, '相距远的两处改动分成两段')
  const created = unifiedDiff('', 'new\nfile\n')
  assert.equal(created.added, 2)
  assert.match(created.text, /^@@ -0,0 \+1,2 @@/)

  const root = path.resolve('/repo')
  const review = buildChangeReview(root, 3, [{ path: path.join(root, 'src', 'a.js'), action: 'modify', baseHash: 'b'.repeat(64), newHash: 'c'.repeat(64), diff }],
    { maxLines: 4, maxChars: 10_000 })
  assert.equal(review.format, 'dsh-change-review@1')
  assert.equal(review.revision, 3)
  assert.equal(review.files[0]!.path, 'src/a.js')
  assert.equal(review.files[0]!.added, 2, '截断不影响增删行数')
  assert.equal(review.truncated, true)
  assert.equal(review.files[0]!.diffTruncated, true)
  assert.match(review.notice ?? '', /只显示了前 4 行/)
  const full = buildChangeReview(root, 1, [{ path: path.join(root, 'a.js'), action: 'modify', baseHash: 'b'.repeat(64), newHash: 'c'.repeat(64), diff }])
  assert.equal(full.truncated, false)
  assert.equal(full.notice, null)
})

test('UTF-8 严格解码：二进制与非法字节拒绝；BOM 原样保留', () => {
  assert.equal(decodeText(Buffer.from([0x61, 0x00, 0x62])), null)
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x41])), null)
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi', 'utf8')])
  const text = decodeText(bom)
  assert.equal(text, '\uFEFFhi')
  assert.equal(sha256Hex(Buffer.from(text!, 'utf8')), sha256Hex(bom), '写回时字节一模一样')
  assert.deepEqual(splitLines('a\r\nb\nc').map(line => line.eol), ['\r\n', '\n', ''])
})

test('原子提交：基线不符直接冲突、一个文件都不写；成功时不留临时文件，前后哈希可核对', t => {
  const dir = tempDir(t)
  const a = path.join(dir, 'a.txt')
  const b = path.join(dir, 'b.txt')
  writeFileSync(a, 'A0\n')
  writeFileSync(b, 'B0\n')
  const files = [
    { path: a, baseHash: hashOf('A0\n'), content: 'A1\n', newHash: hashOf('A1\n') },
    { path: b, baseHash: hashOf('别的版本\n'), content: 'B1\n', newHash: hashOf('B1\n') },
  ]
  const conflict = commitFiles(files)
  assert.equal(conflict.kind, 'conflict')
  assert.equal(readFileSync(a, 'utf8'), 'A0\n', '第一个文件的基线是对的，也不能先写')
  assert.equal(readFileSync(b, 'utf8'), 'B0\n')
  assert.deepEqual(readdirSync(dir).sort(), ['a.txt', 'b.txt'], '冲突时连临时文件都不留')

  const ok = commitFiles([{ ...files[0]! }, { ...files[1]!, baseHash: hashOf('B0\n') },
    { path: path.join(dir, 'c.txt'), baseHash: ABSENT_VERSION, content: '新建\n', newHash: hashOf('新建\n') }])
  assert.equal(ok.kind, 'applied')
  assert.equal(readFileSync(a, 'utf8'), 'A1\n')
  assert.equal(readFileSync(b, 'utf8'), 'B1\n')
  assert.equal(readFileSync(path.join(dir, 'c.txt'), 'utf8'), '新建\n')
  assert.deepEqual(readdirSync(dir).sort(), ['a.txt', 'b.txt', 'c.txt'], '临时文件全部改名成目标，没有残留')
  if (ok.kind === 'applied') {
    assert.equal(ok.files[0]!.beforeHash, hashOf('A0\n'))
    assert.equal(ok.files[0]!.afterHash, hashOf('A1\n'))
    assert.equal(ok.files[2]!.beforeHash, ABSENT_VERSION)
  }
})

test('核对与改名之间被外部修改：第二次核对发现冲突，零写入并清掉临时文件', t => {
  const dir = tempDir(t)
  const a = path.join(dir, 'a.txt')
  writeFileSync(a, 'A0\n')
  const result = commitFiles([{ path: a, baseHash: hashOf('A0\n'), content: 'A1\n', newHash: hashOf('A1\n') }], {
    beforeFinalCheck: () => writeFileSync(a, '用户刚刚改的\n'),
  })
  assert.equal(result.kind, 'conflict')
  assert.equal(readFileSync(a, 'utf8'), '用户刚刚改的\n')
  assert.deepEqual(readdirSync(dir), ['a.txt'])
})

test('改名中途失败：已改名的文件恢复成基线、新建的删除，结果记 failed（项目未改动）', t => {
  const dir = tempDir(t)
  const a = path.join(dir, 'a.txt')
  const created = path.join(dir, 'new.txt')
  const b = path.join(dir, 'b.txt')
  writeFileSync(a, 'A0\n')
  writeFileSync(b, 'B0\n')
  const result = commitFiles([
    { path: a, baseHash: hashOf('A0\n'), content: 'A1\n', newHash: hashOf('A1\n') },
    { path: created, baseHash: ABSENT_VERSION, content: 'N\n', newHash: hashOf('N\n') },
    { path: b, baseHash: hashOf('B0\n'), content: 'B1\n', newHash: hashOf('B1\n') },
  ], { beforeRename: (_target, index) => { if (index === 2) throw Object.assign(new Error('模拟被占用'), { code: 'EBUSY' }) } })
  assert.equal(result.kind, 'failed')
  assert.match(result.kind === 'failed' ? result.error : '', /已把之前写入的 2 个文件恢复成基线/)
  assert.equal(readFileSync(a, 'utf8'), 'A0\n')
  assert.equal(existsSync(created), false)
  assert.equal(readFileSync(b, 'utf8'), 'B0\n')
  assert.deepEqual(readdirSync(dir).sort(), ['a.txt', 'b.txt'], '没有残留的临时文件')
})

test('内容版本：不存在 → absent；目录与过大文件给非哈希版本，永远不等于任何基线哈希', t => {
  const dir = tempDir(t)
  assert.equal(readSnapshot(path.join(dir, 'missing.txt')).version, ABSENT_VERSION)
  assert.equal(readSnapshot(dir).version, 'not-a-file')
  writeFileSync(path.join(dir, 'x.txt'), 'x')
  assert.equal(readSnapshot(path.join(dir, 'x.txt')).version, hashOf('x'))
})

test('项目文件快照：记录新增 / 修改 / 删除，跳过 .git 与 node_modules', t => {
  const dir = tempDir(t)
  writeFileSync(path.join(dir, 'keep.txt'), '1')
  writeFileSync(path.join(dir, 'gone.txt'), '1')
  const before = snapshotTree(dir)
  writeFileSync(path.join(dir, 'keep.txt'), '22')
  rmSync(path.join(dir, 'gone.txt'))
  writeFileSync(path.join(dir, 'report.json'), '{}')
  const changes = diffTrees(before, snapshotTree(dir))
  assert.deepEqual(changes.created, ['report.json'])
  assert.deepEqual(changes.modified, ['keep.txt'])
  assert.deepEqual(changes.deleted, ['gone.txt'])
  assert.equal(changes.truncated, false)
})
