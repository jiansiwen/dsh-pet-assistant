import assert from 'node:assert/strict'
import { test } from 'node:test'
import { followScrollTop } from '../src/renderer/doc-view-follow.ts'

const base = { blockHeight: 40, pageTop: 0, viewTop: 0, viewportHeight: 800, pageChanged: false, pageLevel: false }

test('同一页里块在可视区内：一页都不动（不来回跳）', () => {
  assert.equal(followScrollTop({ ...base, blockTop: 120 }), null)
  assert.equal(followScrollTop({ ...base, blockTop: 400, viewTop: 300 }), null)
})

test('块接近视口底部才滚动，并把它带到视口上方约 28%', () => {
  const target = followScrollTop({ ...base, blockTop: 760, viewTop: 0 })
  assert.equal(target, Math.round(760 - 800 * 0.28))
  assert.ok(target !== null && target > 500, '这一下要往下带大半屏，像翻一页')
})

test('长块已经出现在舒适带里：哪怕块底还在视口外也不滚（长段落不逐句抖）', () => {
  assert.equal(followScrollTop({ ...base, blockTop: 120, blockHeight: 2000 }), null)
  assert.equal(followScrollTop({ ...base, blockTop: 360, blockHeight: 2000, viewTop: 0 }), null)
})

test('块已经滚出视口顶部：往上收回来', () => {
  const target = followScrollTop({ ...base, blockTop: 40, viewTop: 300 })
  assert.equal(target, Math.max(0, 40 - Math.round(800 * 0.28)))
})

test('换页：无论块在哪儿都对准新页，把新内容带到眼前', () => {
  assert.equal(followScrollTop({ ...base, blockTop: 900, pageChanged: true }), Math.round(900 - 800 * 0.28))
})

test('页级锚点：换页只滚到页顶，同页重复不滚', () => {
  assert.equal(followScrollTop({ ...base, blockTop: 0, pageTop: 1200, pageChanged: true, pageLevel: true }), 1188)
  assert.equal(followScrollTop({ ...base, blockTop: 0, pageTop: 1200, pageLevel: true }), null)
})