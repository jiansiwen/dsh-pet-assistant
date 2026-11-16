/**
 * 产物指针的钉子用例。
 *
 * 这张表存在的唯一理由：用户说"上次那个文件再改一下"时，助理得知道"那个"是哪份。
 * 所以钉的不是存储细节，而是三条会直接变成用户可见错误的规则：
 *
 * 1. 同路径重复产出**覆盖**而不是堆历史（否则提示词会变成活动日志）；
 * 2. 文件不在了**只标 missing 不删行**（"我做过，但文件没了"是必须如实说出的事实）；
 * 3. 命中判定**只做确定性词面匹配**，不做语义近似 —— 近似会把"我记得"变成"我猜的"。
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { ArtifactStore, artifactMentioned, digestOf } from '../src/artifacts.ts'

const at = Date.parse('2026-11-14T09:00:00+08:00')

function store(): ArtifactStore {
  return new ArtifactStore(new DatabaseSync(':memory:'))
}

void test('产物：记下路径与摘要，最近的在前面', () => {
  const artifacts = store()
  artifacts.record({ kind: 'report', path: 'D:\\out\\日报-11-13.md', digest: digestOf('a'), label: '日报 2026-11-13' }, at)
  artifacts.record({ kind: 'minutes', path: 'D:\\out\\周会纪要.docx', digest: digestOf('b'), label: '周会纪要' }, at + 1000)
  const recent = artifacts.recent(5)
  assert.deepEqual(recent.map(item => item.path), ['D:\\out\\周会纪要.docx', 'D:\\out\\日报-11-13.md'])
  assert.equal(recent[0].state, 'ok')
})

void test('产物：同路径重复产出覆盖上一次，不堆历史', () => {
  const artifacts = store()
  const first = artifacts.record({ kind: 'report', path: 'D:\\out\\日报.md', digest: digestOf('v1'), label: '日报' }, at)
  const second = artifacts.record({ kind: 'report', path: 'D:\\out\\日报.md', digest: digestOf('v2'), label: '日报（修订）' }, at + 5000)
  assert.equal(second.id, first.id, '同一份文件是同一个指针，不是新的一条')
  const all = artifacts.recent(10)
  assert.equal(all.length, 1)
  assert.equal(all[0].digest, digestOf('v2'), '摘要应更新成最新一版')
  assert.equal(all[0].label, '日报（修订）')
})

void test('产物：文件不在了只标 missing，不删行；默认列表里隐藏', () => {
  const artifacts = store()
  const pointer = artifacts.record({ kind: 'translation', path: 'D:\\out\\译稿.docx', digest: digestOf('x'), label: '译稿' }, at)
  artifacts.markMissing(pointer.id)
  assert.equal(artifacts.get(pointer.id)?.state, 'missing', '行还在，只是状态变了')
  assert.equal(artifacts.recent(5).length, 0, '默认列表不展示已消失的')
  assert.equal(artifacts.recent(5, true).length, 1, '显式要求时仍能查出来，好如实说"那个文件没了"')
})

void test('产物：命中判定只认确定性词面，不做语义近似', () => {
  const pointer = { path: 'D:\\out\\XX需求-中文版.docx', label: '需求翻译稿 会议材料' }
  assert.equal(artifactMentioned('上次那个 XX需求-中文版.docx 再改一下', pointer), true)
  assert.equal(artifactMentioned('把 XX需求-中文版 再翻一遍', pointer), true, '文件名主干也算命中')
  assert.equal(artifactMentioned('顺便看下需求翻译稿', pointer), true, '标签分词命中')
  // 这些都不该命中：没有共同词面就是没有，不许"觉得像"
  assert.equal(artifactMentioned('帮我写一份新的报告', pointer), false)
  assert.equal(artifactMentioned('那个东西呢', pointer), false)
  assert.equal(artifactMentioned('', pointer), false)
})

void test('产物：mentionedIn 只回最近的若干条，且包含已消失的（好如实说明）', () => {
  const artifacts = store()
  const keep = artifacts.record({ kind: 'report', path: 'D:\\out\\季度总结.md', digest: digestOf('a'), label: '季度总结' }, at)
  artifacts.record({ kind: 'report', path: 'D:\\out\\别的.md', digest: digestOf('b'), label: '别的' }, at + 1)
  artifacts.markMissing(keep.id)
  const hits = artifacts.mentionedIn('季度总结那份还能改吗')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].state, 'missing')
})
