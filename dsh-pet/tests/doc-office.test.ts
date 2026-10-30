import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import JSZip from 'jszip'
import { parseOfficeDocument } from '../src/main/doc-office.ts'
import { canOutline, DocumentLibrary, type DocFileSystem } from '../src/main/document.ts'

async function zip(files: Record<string, string>): Promise<Uint8Array> {
  const archive = new JSZip()
  for (const [name, content] of Object.entries(files)) archive.file(name, content)
  return new Uint8Array(await archive.generateAsync({ type: 'nodebuffer' }))
}
function paragraph(text: string, style?: string): string {
  return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`
}
function slide(...paragraphs: string[]): string {
  return `<p:sld><p:cSld><p:spTree>${paragraphs.map(text => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join('')}</p:spTree></p:cSld></p:sld>`
}

test('docx 按 Word 标题层级切段，保留正文与实体', async () => {
  const bytes = await zip({ 'word/document.xml': `<w:document><w:body>${
    paragraph('项目计划', 'Heading1') + paragraph('这里是一段 &amp; 正文') + paragraph('范围', 'Heading2') + paragraph('第二段')
  }</w:body></w:document>` })
  const parsed = await parseOfficeDocument('项目计划.docx', bytes)
  assert.equal(parsed.kind, 'outline')
  if (parsed.kind !== 'outline') return
  assert.equal(parsed.outline.title, '项目计划')
  assert.deepEqual(parsed.outline.sections.map(section => section.heading), ['项目计划', '范围'])
  assert.match(parsed.outline.sections[0]!.text, /一段 & 正文/)
  assert.match(parsed.outline.sections[1]!.text, /第二段/)
  assert.equal(canOutline('项目计划.docx'), true)
})

test('pptx 按幻灯片页序切段，页码从 1 开始，长序号不按字符串排', async () => {
  const bytes = await zip({ 'ppt/slides/slide2.xml': slide('第二页标题', '第二页正文'),
    'ppt/slides/slide10.xml': slide('第十页标题'), 'ppt/slides/slide1.xml': slide('第一页标题', '第一页正文') })
  const parsed = await parseOfficeDocument('方案.pptx', bytes)
  assert.equal(parsed.kind, 'outline')
  if (parsed.kind !== 'outline') return
  assert.deepEqual(parsed.outline.sections.map(section => section.pageNumber), [1, 2, 10])
  assert.deepEqual(parsed.outline.sections.map(section => section.heading), ['第一页标题', '第二页标题', '第十页标题'])
  assert.match(parsed.outline.sections[0]!.text, /第一页正文/)
  assert.equal(canOutline('方案.pptx'), true)
})

test('DocumentLibrary 走授权二进制通道解析 docx，不把它当文本读', async () => {
  const bytes = await zip({ 'word/document.xml': `<w:document><w:body>${paragraph('方案', 'Heading1') + paragraph('正文')}</w:body></w:document>` })
  const root = path.resolve('D:/tmp/dsh-doc-office-root')
  const target = path.join(root, '方案.docx')
  let textReads = 0
  const fileSystem: DocFileSystem = {
    async list() { return [] },
    async stat(value) { return value === target ? { path: target, name: '方案.docx', size: bytes.length, mtimeMs: 1 } : null },
    async realpath(value) { return value },
    async read() { textReads++; return '' },
    async readBytes() { return bytes },
    async fingerprint() { return 'fingerprint-docx' },
    async openWithAssociatedApp() {},
  }
  const library = new DocumentLibrary(fileSystem, () => [root])
  const opened = await library.open(target)
  assert.equal(opened.kind, 'opened')
  if (opened.kind !== 'opened') return
  assert.equal(opened.doc.parsed.kind, 'outline')
  if (opened.doc.parsed.kind !== 'outline') return
  assert.equal(opened.doc.parsed.outline.title, '方案')
  assert.equal(textReads, 0, 'docx 不应该走 UTF-8 文本读取')
})

test('损坏容器、旧版二进制格式与缺少正文都给可读结果', async () => {
  await assert.rejects(parseOfficeDocument('坏.docx', new Uint8Array([1, 2, 3])), /ZIP|损坏|加密/)
  const legacy = await parseOfficeDocument('旧.doc', new Uint8Array([1]))
  assert.equal(legacy.kind, 'unsupported')
  const empty = await parseOfficeDocument('空.docx', await zip({ 'word/document.xml': '<w:document><w:body></w:body></w:document>' }))
  assert.equal(empty.kind, 'empty')
})
