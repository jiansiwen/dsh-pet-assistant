/**
 * 轻量 Markdown 渲染：把文档正文变成**可信的 HTML 字符串**。
 *
 * 为什么不引第三方库：构建是 esbuild 打包，加一个 markdown 库要动锁文件与打包体积，
 * 而这里需要的只是"一屏能读的文档"：标题、列表、表格、代码、引用。真正复杂的东西
 * （脚注、数学、内嵌 HTML）我们**不该支持** —— 文档内容不可信，支持得越多，攻击面越大。
 *
 * 两条安全前提，改动时不能破坏：
 *
 * 1. **先转义，再套标签**。所有文本节点都过 `escapeHtml`，因此文档里写 `<script>` 只会显示
 *    成字面的 `<script>`，不会被解析。原始 HTML **不**透传（这是与"完整 CommonMark"的
 *    主动取舍：文档是别人给的，不是我们自己写的）。
 * 2. **链接只放行 http/https**。`javascript:`、`data:`、`file:` 一律按纯文本处理 ——
 *    点一下就能执行的东西，不能由文档内容决定。
 *
 * 纯函数、不碰 DOM：`.tsx` 里 Node 的类型剥离跑不动，放在这里才能用 `node --test` 逐条钉住
 * "表格真的是 table、标题真的是 h1、注入真的被转义"。
 */

/** HTML 文本转义。顺序必须 `&` 最先，否则会把后面生成的实体再转一次。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

/** 只放行 http/https；其余（javascript:、data:、file:、相对路径）一律当纯文本。 */
export function safeUrl(url: string): string | null {
  const trimmed = url.trim()
  return /^https?:\/\/[^\s]+$/iu.test(trimmed) ? trimmed : null
}

/**
 * 行内格式：行内代码、粗体、斜体、链接。
 *
 * 先按行内代码切段：代码里的 `**` 是字面量，不能被当成粗体（`a ** b` 与 `` `**` `` 不同）。
 * 代码段之外的文字先转义，再套自己的标签 —— 顺序反过来就等于给文档开了注入口子。
 */
export function renderInline(raw: string): string {
  const parts = raw.split(/(`[^`]*`)/u)
  return parts.map((part) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return `<code>${escapeHtml(part.slice(1, -1))}</code>`
    }
    let html = escapeHtml(part)
    // 链接：[文字](https://…)。非 http(s) 时把整段原文留下，不生成 <a>。
    html = html.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/gu, (whole, label: string, href: string) => {
      const url = safeUrl(href.replace(/&amp;/gu, '&'))
      return url === null ? whole : `<a href="${escapeHtml(url)}" rel="noreferrer noopener" target="_blank">${label}</a>`
    })
    html = html.replace(/\*\*([^*\n]+)\*\*/gu, '<strong>$1</strong>')
    html = html.replace(/(?<![\w*])__([^_\n]+)__(?![\w_])/gu, '<strong>$1</strong>')
    html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/gu, '<em>$1</em>')
    html = html.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/gu, '<em>$1</em>')
    return html
  }).join('')
}

/** 分隔线。 */
const isRule = (line: string): boolean => /^ {0,3}([-*_])\1{2,}\s*$/u.test(line)
/** 表格的对齐行：|---|:--:|---:| */
const isTableDivider = (line: string): boolean => /^\s*\|?[\s:-]*-[\s|:-]*$/u.test(line) && line.includes('-') && line.includes('|')

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/u, '').replace(/\|$/u, '')
  return trimmed.split('|').map(cell => cell.trim())
}

function alignOf(cell: string): string | null {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

/**
 * 渲染整段 Markdown。返回值是 HTML 字符串（已全量转义），直接 `innerHTML` 到容器里。
 *
 * 支持：ATX 标题、围栏代码块、引用、有序/无序列表（缩进一层嵌套）、表格、分隔线、段落。
 * 不支持（也刻意不支持）：原始 HTML、脚注、数学、图片外链 —— 文档不可信。
 */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n')
  const out: string[] = []
  let index = 0
  let headingCount = 0

  const paragraph: string[] = []
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    out.push(`<p>${renderInline(paragraph.join(' '))}</p>`)
    paragraph.length = 0
  }

  while (index < lines.length) {
    const line = lines[index]

    // 围栏代码块：语言标记只用来加 class，内容一个字都不解释（不递归渲染）。
    const fence = /^ {0,3}(```+|~~~+)\s*([\w+-]*)\s*$/u.exec(line)
    if (fence !== null) {
      flushParagraph()
      const marker = fence[1]
      const language = fence[2]
      const body: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      const cls = language === '' ? 'md-code' : `md-code language-${escapeHtml(language)}`
      out.push(`<pre class="${cls}"><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    if (line.trim() === '') { flushParagraph(); index += 1; continue }

    const heading = /^ {0,3}(#{1,6})\s+(.*)$/u.exec(line)
    if (heading !== null) {
      flushParagraph()
      const level = heading[1].length
      // 标题带序号锚点：讲解推进时靠它把视图滚到对应段落。
      out.push(`<h${level} id="md-h-${headingCount}">${renderInline(heading[2].trim())}</h${level}>`)
      headingCount += 1
      index += 1
      continue
    }

    if (isRule(line)) { flushParagraph(); out.push('<hr />'); index += 1; continue }

    if (/^ {0,3}>/u.test(line)) {
      flushParagraph()
      const quoted: string[] = []
      while (index < lines.length && /^ {0,3}>/u.test(lines[index])) {
        quoted.push(lines[index].replace(/^ {0,3}>\s?/u, ''))
        index += 1
      }
      out.push(`<blockquote>${renderInline(quoted.join(' '))}</blockquote>`)
      continue
    }

    // 表格：当前行与下一行都像表格才算，否则 `a | b` 只是一句话。
    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      flushParagraph()
      const header = splitRow(line)
      const align = splitRow(lines[index + 1]).map(alignOf)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        rows.push(splitRow(lines[index]))
        index += 1
      }
      const cell = (tag: 'th' | 'td', value: string, column: number): string => {
        const style = align[column] === null ? '' : ` style="text-align:${String(align[column])}"`
        return `<${tag}${style}>${renderInline(value)}</${tag}>`
      }
      const head = header.map((value, column) => cell('th', value, column)).join('')
      const body = rows.map(row => `<tr>${header.map((_, column) => cell('td', row[column] ?? '', column)).join('')}</tr>`).join('')
      out.push(`<table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`)
      continue
    }

    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(line)
    if (listItem !== null) {
      flushParagraph()
      const ordered = /\d/u.test(listItem[2])
      const baseIndent = listItem[1].length
      const items: Array<{ text: string; nested: boolean }> = []
      while (index < lines.length) {
        const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(lines[index])
        if (match === null) break
        items.push({ text: match[3], nested: match[1].length > baseIndent })
        index += 1
      }
      const tag = ordered ? 'ol' : 'ul'
      // 只做一层嵌套：再深就不是"一屏能读"，而是把文档结构原样搬上来了。
      let html = `<${tag}>`
      let nestedOpen = false
      for (const item of items) {
        if (item.nested && !nestedOpen) { html += `<${tag}>`; nestedOpen = true }
        if (!item.nested && nestedOpen) { html += `</${tag}>`; nestedOpen = false }
        html += `<li>${renderInline(item.text)}</li>`
      }
      if (nestedOpen) html += `</${tag}>`
      out.push(`${html}</${tag}>`)
      continue
    }

    paragraph.push(line.trim())
    index += 1
  }
  flushParagraph()
  return out.join('\n')
}

/** 一份文档里有几个标题：讲解分段与标题常常一一对应，滚动定位要用。 */
export function countMarkdownHeadings(source: string): number {
  return source.split('\n').filter(line => /^ {0,3}#{1,6}\s+/u.test(line)).length
}

/**
 * 第 `sectionIndex` 段该滚到哪个元素 id。
 *
 * 段落序号来自提纲（主进程按标题切的），标题 id 来自本渲染器（`md-h-N`）。两者能对上时直接
 * 定位；文档没有标题、或段落比标题多时退化成"按比例找位置"——返回 null，由调用方按比例滚。
 */
export function headingAnchorFor(sectionIndex: number, headingCount: number): string | null {
  if (headingCount === 0) return null
  return sectionIndex >= 0 && sectionIndex < headingCount ? `md-h-${sectionIndex}` : null
}
