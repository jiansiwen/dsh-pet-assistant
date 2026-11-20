/**
 * Markdown 渲染器的测试。
 *
 * 这一层的两条判据都不能靠开壳看：**表格真的变成 `<table>`**（用户抱怨的就是竖线裸露）、
 * **文档里的 HTML 真的被转义**（文档不可信，`<script>` 一旦透传就是执行）。
 * 另外钉住"只放行 http/https 链接"与"嵌套列表"，它们是安全与可读性的边界。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  countMarkdownHeadings,
  escapeHtml,
  headingAnchorFor,
  renderInline,
  renderMarkdown,
  safeUrl,
} from '../src/renderer/markdown.ts'

describe('转义：文档内容不可信', () => {
  test('五个字符全转义', () => {
    assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;')
  })

  test('<script> 只当文字显示，不会变成标签', () => {
    const html = renderMarkdown('# 标题\n\n<script>alert(1)</script>')
    assert.ok(!html.includes('<script'), html)
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), html)
  })

  test('行内代码里的尖括号同样被转义', () => {
    assert.equal(renderInline('用 `<div>` 包一层'), '用 <code>&lt;div&gt;</code> 包一层')
  })
})

describe('标题', () => {
  test('六级标题映射到 h1–h6，且带滚动锚点 id', () => {
    const html = renderMarkdown('# 一级\n\n### 三级')
    assert.ok(html.includes('<h1 id="md-h-0">一级</h1>'), html)
    assert.ok(html.includes('<h3 id="md-h-1">三级</h3>'), html)
    assert.equal(countMarkdownHeadings('# 一\n\n正文\n\n## 二'), 2)
  })

  test('标题里的行内格式照常渲染', () => {
    assert.ok(renderMarkdown('## **重点** 标题').includes('<h2 id="md-h-0"><strong>重点</strong> 标题</h2>'))
  })
})

describe('表格：用户抱怨的竖线必须变成真正的表格', () => {
  const source = ['| 项目 | 说明 | 状态 |', '| --- | :--: | ---: |', '| 超时 | 3 秒 | 完成 |', '| 重试 | 3 次 | 进行 |'].join('\n')

  test('渲染成 table，表头是 th、数据是 td', () => {
    const html = renderMarkdown(source)
    assert.ok(html.includes('<table class="md-table">'), html)
    assert.ok(html.includes('<thead><tr><th>项目</th>'), html)
    assert.ok(html.includes('<tbody>'), html)
    assert.equal((html.match(/<tr>/gu) ?? []).length, 3, '一行表头 + 两行数据')
    assert.ok(html.includes('<td>超时</td>'), html)
  })

  test('对齐行变成 text-align，且竖线不再裸露', () => {
    const html = renderMarkdown(source)
    assert.ok(html.includes('style="text-align:center"'), html)
    assert.ok(html.includes('style="text-align:right"'), html)
    assert.ok(!html.includes('| --- |'), '对齐行不该被当正文渲染')
    assert.ok(!html.includes('| 超时 |'), '单元格里的竖线不该留下来')
  })

  test('没有对齐行时不当表格：a | b 只是一句话', () => {
    const html = renderMarkdown('这一行里有 a | b 两个变量')
    assert.ok(!html.includes('<table'), html)
    assert.ok(html.includes('a | b'))
  })
})

describe('代码块', () => {
  test('内容按字面保留（不递归渲染、不被当 HTML），语言标记进 class', () => {
    const html = renderMarkdown('```ts\nconst a = 1 < 2 && "<b>"\n```')
    assert.ok(html.includes('<pre class="md-code language-ts"><code>'), html)
    assert.ok(html.includes('const a = 1 &lt; 2 &amp;&amp; &quot;&lt;b&gt;&quot;'), html)
    assert.ok(!html.includes('<b>'), '代码里的标签必须被转义')
  })

  test('列表符号在代码块里不被拆成列表', () => {
    const html = renderMarkdown('```\n- 这是代码里的减号\n1. 也是字面量\n```')
    assert.ok(!html.includes('<ul>') && !html.includes('<ol>'), html)
    assert.ok(html.includes('- 这是代码里的减号'))
  })
})

describe('列表（含一层嵌套）', () => {
  test('无序与有序各自成 list', () => {
    assert.ok(renderMarkdown('- 甲\n- 乙').includes('<ul><li>甲</li><li>乙</li></ul>'))
    assert.ok(renderMarkdown('1. 甲\n2. 乙').includes('<ol><li>甲</li><li>乙</li></ol>'))
  })

  test('缩进一层生成嵌套列表，标签闭合正确', () => {
    const html = renderMarkdown('- 父项\n  - 子项\n- 父项二')
    assert.equal(html, '<ul><li>父项</li><ul><li>子项</li></ul><li>父项二</li></ul>')
  })
})

describe('引用、分隔线、段落', () => {
  test('引用成 blockquote，连续行并成一段', () => {
    assert.equal(renderMarkdown('> 第一行\n> 第二行'), '<blockquote>第一行 第二行</blockquote>')
  })

  test('分隔线成 hr', () => {
    assert.equal(renderMarkdown('上\n\n---\n\n下'), '<p>上</p>\n<hr />\n<p>下</p>')
  })

  test('连续正文并成一段，空行分段', () => {
    assert.equal(renderMarkdown('第一句\n第二句\n\n第三句'), '<p>第一句 第二句</p>\n<p>第三句</p>')
  })
})

describe('链接白名单：只放行 http/https', () => {
  test('http/https 生成 a 标签', () => {
    assert.equal(renderInline('[文档](https://example.com/a)'), '<a href="https://example.com/a" rel="noreferrer noopener" target="_blank">文档</a>')
    assert.equal(safeUrl('https://example.com'), 'https://example.com')
  })

  test('javascript: / data: / file: 与相对路径一律按纯文本，不生成 a 标签', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///C:/secret', '/etc/passwd']) {
      const html = renderInline(`[点我](${url})`)
      assert.ok(!html.includes('<a '), `${url} 不该变成链接：${html}`)
      assert.equal(safeUrl(url), null)
    }
  })

  test('链接文字里的 HTML 同样被转义', () => {
    const html = renderInline('[<img src=x>](https://e.com)')
    assert.ok(!html.includes('<img'), html)
    assert.ok(html.includes('&lt;img src=x&gt;'), html)
  })
})

describe('粗体 / 斜体', () => {
  test('** 与 __ 都是强强调，* 与 _ 是强调', () => {
    assert.equal(renderInline('**粗**'), '<strong>粗</strong>')
    assert.equal(renderInline('__粗__'), '<strong>粗</strong>')
    assert.equal(renderInline('*斜*'), '<em>斜</em>')
    assert.equal(renderInline('_斜_'), '<em>斜</em>')
  })

  test('代码里的星号不被当强调', () => {
    assert.equal(renderInline('`**不是粗体**`'), '<code>**不是粗体**</code>')
  })
})

describe('真实 md 片段：渲染后没有裸 # 与裸 |', () => {
  test('一段带标题、表格、列表、代码的文档', () => {
    const source = [
      '# 接口约定',
      '',
      '返回 200 表示成功，**失败**时看 `code`。',
      '',
      '| 字段 | 类型 |',
      '| --- | --- |',
      '| code | number |',
      '',
      '- 超时 3 秒',
      '- 重试 3 次',
      '',
      '```json',
      '{"code": 0}',
      '```',
    ].join('\n')

    const html = renderMarkdown(source)
    // 行首的 # 与表格竖线都不该以字面形式出现在文本里。
    assert.ok(!/>\s*#\s/u.test(html), `标题号裸露：${html}`)
    assert.ok(!html.includes('| --- |'), `对齐行裸露：${html}`)
    assert.ok(!/>\s*\|/u.test(html), `表格竖线裸露：${html}`)
    // 该有的结构都在。
    for (const piece of ['<h1', '<table class="md-table">', '<ul>', '<pre class="md-code language-json">', '<strong>失败</strong>', '<code>code</code>']) {
      assert.ok(html.includes(piece), `缺了 ${piece}：${html}`)
    }
  })
})

describe('段落序号 → 滚动锚点', () => {
  test('有标题时按序号对齐，没有标题时交给调用方按比例滚', () => {
    assert.equal(headingAnchorFor(0, 3), 'md-h-0')
    assert.equal(headingAnchorFor(2, 3), 'md-h-2')
    assert.equal(headingAnchorFor(3, 3), null, '段落比标题多时不能指向不存在的 id')
    assert.equal(headingAnchorFor(-1, 3), null)
    assert.equal(headingAnchorFor(0, 0), null)
  })
})
