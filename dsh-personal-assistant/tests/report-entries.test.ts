/** 日报条目解析、逐条修改与发布目标核对的纯函数/文件级回归（M3-04）。 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { applyReportEdit, linkEntries, parseReportLines, publishRevisionFile } from '../src/report.ts'
import { sha256 } from '../src/store.ts'
import { scratch } from './support/workbench-fixture.ts'

test('条目解析：列表项是条目，标题定小节，"（待确认）"标注识别；CRLF 与有序列表都认', () => {
  const lines = parseReportLines('# 日报\r\n\r\n## 成果\r\n1. 修改退款校验\r\n- 整理文档(待确认)\r\n说明文字\r\n')
  assert.deepEqual(lines.filter(line => line.kind === 'entry').map(line => [line.text, line.section, line.pending]),
    [['修改退款校验', '成果', false], ['整理文档(待确认)', '成果', true]])
  assert.equal(lines.find(line => line.kind === 'text')?.text, '说明文字')
})

test('逐条修改：行号与原文都要对上；保留缩进与列表符号；补充到文末或指向末尾空行都保持文件以换行结尾', () => {
  const content = '# 日报\n\n- 一\n  - 二\n'
  const rewrite = applyReportEdit(content, { type: 'rewrite', line: 3, expectedText: '二', text: '二（改）' })
  assert.ok(rewrite.ok)
  assert.equal(rewrite.ok && rewrite.content, '# 日报\n\n- 一\n  - 二（改）\n')
  const wrongText = applyReportEdit(content, { type: 'delete', line: 3, expectedText: '别的' })
  assert.equal(!wrongText.ok && wrongText.code, 'text_mismatch')
  const heading = applyReportEdit(content, { type: 'delete', line: 0, expectedText: '日报' })
  assert.equal(!heading.ok && heading.code, 'bad_line', '标题不是条目，不能当条目删')
  for (const afterLine of [-1, 4]) {
    const added = applyReportEdit(content, { type: 'add', afterLine, text: '三' })
    assert.equal(added.ok && added.content, '# 日报\n\n- 一\n  - 二\n  - 三\n', `afterLine=${afterLine}`)
  }
  const afterHeading = applyReportEdit(content, { type: 'add', afterLine: 0, text: '零' })
  assert.equal(afterHeading.ok && afterHeading.content, '# 日报\n- 零\n\n- 一\n  - 二\n')
  assert.equal(applyReportEdit(content, { type: 'add', afterLine: 9, text: 'x' }).ok, false)
  assert.equal(applyReportEdit(content, { type: 'add', afterLine: -1, text: '   ' }).ok, false)
  assert.equal(applyReportEdit(content, { type: 'add', afterLine: -1, text: 'x'.repeat(501) }).ok, false)
})

test('条目关联：文字须与正文条目逐字一致（可带列表符号），同文两条按顺序各占一行', () => {
  const content = '# 日报\n\n- 回复张三\n- 回复张三\n'
  const linked = linkEntries(content, [{ text: '- 回复张三', workItemIds: ['a'] }, { text: '回复张三', workItemIds: ['b', 'b'] }])
  assert.ok(linked.ok)
  assert.deepEqual(linked.ok && [...linked.links], [[2, ['a']], [3, ['b']]])
  assert.equal(linkEntries(content, [{ text: '回复张三', workItemIds: [] }]).ok, false, '必须给出事项编号')
})

test('发布目标核对：已是这一版不重写；不是本日报发布过的内容不覆盖；目标被文件夹占住如实报冲突；不传核对时保持旧行为', async t => {
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(path.join(scratch, 'm3-publish-guard-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const target = path.join(dir, 'reports', '2026-10-17.md')
  mkdirSync(path.dirname(target))
  const v1 = '# 第一版\n', v2 = '# 第二版\n'
  writeFileSync(target, v1)
  const mtime = statSync(target).mtimeMs
  const same = await publishRevisionFile(target, v1, sha256(v1), 1, { knownDigests: [] })
  assert.deepEqual(same, { ok: true, path: target, digest: sha256(v1), unchanged: true })
  assert.equal(statSync(target).mtimeMs, mtime)
  const overwrite = await publishRevisionFile(target, v2, sha256(v2), 2, { knownDigests: [sha256(v1)] })
  assert.equal(overwrite.ok, true)
  assert.equal(readFileSync(target, 'utf8'), v2)
  writeFileSync(target, '用户手改')
  const conflict = await publishRevisionFile(target, v1, sha256(v1), 3, { knownDigests: [sha256(v1), sha256(v2)] })
  assert.equal(!conflict.ok && conflict.reason, 'target_conflict')
  assert.equal(readFileSync(target, 'utf8'), '用户手改', '不覆盖')
  const folder = path.join(dir, 'reports', 'folder.md')
  mkdirSync(folder)
  const occupied = await publishRevisionFile(folder, v1, sha256(v1), 1, { knownDigests: [] })
  assert.equal(!occupied.ok && occupied.reason, 'target_conflict')
  const legacy = await publishRevisionFile(target, v1, sha256(v1), 4)
  assert.equal(legacy.ok, true, '不传核对参数时仍按旧行为覆盖（迁移与旧调用方不受影响）')
})
