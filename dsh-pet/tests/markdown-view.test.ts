import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markdownBlocks } from '../src/renderer/markdown-view.ts'

test('Markdown 阅读视图保留完整原文，跳过代码块中的伪标题并按同名标题顺序定位', () => {
  const text = '开场\n```md\n# 伪标题\n```\n# 同名\n甲\n# 同名\n乙\n'
  const blocks = markdownBlocks(text, [{ heading: null }, { heading: '同名' }, { heading: '同名' }])
  assert.equal(blocks.join(''), text)
  assert.match(blocks[0], /伪标题/u)
  assert.match(blocks[1], /^# 同名\n甲/u)
  assert.match(blocks[2], /^# 同名\n乙/u)
})

test('只有一个讲解段落时完整展示原文', () => {
  const text = '# 标题\n正文\n```\n代码\n```\n'
  assert.deepEqual(markdownBlocks(text, [{ heading: '标题' }]), [text])
})
