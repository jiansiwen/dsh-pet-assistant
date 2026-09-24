/** 合成 PDF 的真实 PDF.js 解析，以及真实磁盘授权/二进制/缓存链路。 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test, type TestContext } from 'node:test'
import { Worker } from 'node:worker_threads'
import { createDocFileSystem } from '../src/main/doc-fs.ts'
import {
  DocumentLibrary, MAX_DOC_BYTES, DocSizeError, fingerprintBytes, askPrompt, explainPrompt, describeOutline,
  type OpenResult,
} from '../src/main/document.ts'
import { parsePdf, pdfFailure, MAX_PDF_PAGES, type PdfParser, type PdfParseResult } from '../src/main/doc-pdf.ts'
import { syntheticPdf, pdfFromObjects } from './pdf-fixtures.ts'

function pagesOf(result: PdfParseResult) {
  assert.equal(result.kind, 'pdf-pages', JSON.stringify(result))
  return result.pages
}
function outlineOf(result: OpenResult) {
  assert.equal(result.kind, 'opened', JSON.stringify(result))
  assert.ok(result.kind === 'opened')
  assert.equal(result.doc.parsed.kind, 'outline', JSON.stringify(result.doc.parsed))
  assert.ok(result.doc.parsed.kind === 'outline')
  return result.doc.parsed.outline
}
function errorCode(result: PdfParseResult, code: string) {
  assert.equal(result.kind, 'pdf-error')
  assert.ok(result.kind === 'pdf-error')
  assert.equal(result.code, code, result.reason)
  return result
}

async function fixture(t: TestContext, data = syntheticPdf(['First page', '', 'Third page'])) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-pdf-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'docs')
  await mkdir(root)
  const file = path.join(root, '合成.PDF')
  await writeFile(file, data)
  const fs = createDocFileSystem()
  const read = t.mock.method(fs, 'read', async () => { throw new Error('PDF 不准走 UTF-8 读取') })
  const readBytes = t.mock.method(fs, 'readBytes')
  const fingerprint = t.mock.method(fs, 'fingerprint')
  const parse = t.mock.fn<PdfParser>(parsePdf)
  let roots = [root]
  const library = new DocumentLibrary(fs, () => roots, parse)
  return { base, root, file, fs, read, readBytes, fingerprint, parse, library, setRoots: (next: string[]) => { roots = next } }
}

test('真实 PDF.js 逐物理页提取，前中后空白页不压缩编号，调用方二进制不被转移', async () => {
  const data = syntheticPdf(['', 'Heading\nBody paragraph', '', 'Fourth page', ''])
  const before = data.slice()
  const pages = pagesOf(await parsePdf(data))
  assert.deepEqual(pages.map((page) => page.pageNumber), [1, 2, 3, 4, 5])
  assert.deepEqual(pages.map((page) => page.text), ['', 'Heading\nBody paragraph', '', 'Fourth page', ''])
  assert.equal(pages[1].heading, 'Heading')
  assert.deepEqual(data, before)
})

test('本地 CMap 解析中文文字，不要求系统字体、网络或 OCR', async () => {
  const stream = 'BT /F1 12 Tf 50 750 Td <4e2d6587> Tj ET'
  const pdf = pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>',
  ])
  assert.equal(pagesOf(await parsePdf(pdf))[0].text, '中文')
})

test('扫描图像和全空白页均报无文本，不自动触发 OCR', async () => {
  for (const bytes of [syntheticPdf(['', '']), syntheticPdf([''], { imageOnly: true })]) {
    const result = errorCode(await parsePdf(bytes), 'no-text')
    assert.match(result.reason, /未启动 OCR.*授权/)
  }
})

test('真实密码加密 PDF 报密码保护，不请求密码、不挂起', async () => {
  errorCode(await parsePdf(syntheticPdf(['Encrypted synthetic content'], { encrypted: true })), 'password')
})

test('坏 PDF、空文件及坏内容流有结构化失败，不假装成功', async () => {
  errorCode(await parsePdf(new Uint8Array()), 'invalid')
  errorCode(await parsePdf(new Uint8Array([1, 2, 3, 4])), 'invalid')
  errorCode(await parsePdf(Buffer.from('%PDF-1.7\n1 0 obj\n<< /Broken true >>\nendobj\n')), 'invalid')
  const corruptStream = pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R >>',
    '<< /Length 11 /Filter /FlateDecode >>\nstream\nnot-deflate\nendstream',
  ])
  // PDF.js 将某些解压失败转换为空流，即使 stopAtErrors 开启也无法区分空白与损坏。
  const result = errorCode(await parsePdf(corruptStream), 'no-text')
  assert.match(result.reason, /损坏/)
})

test('页数限额在提取前生效，正好到上限可解析', async () => {
  const bytes = syntheticPdf(['One', 'Two'])
  assert.equal(pagesOf(await parsePdf(bytes, { maxPages: 2 })).length, 2)
  assert.equal(errorCode(await parsePdf(bytes, { maxPages: 1 }), 'page-limit').limit, 1)
  errorCode(await parsePdf(syntheticPdf(Array.from({ length: MAX_PDF_PAGES + 1 }, () => ''))), 'page-limit')
})

test('单页、全文字符限额分别生效，超限不返回部分提纲', async () => {
  const bytes = syntheticPdf(['abcd', 'efgh'])
  assert.equal(pagesOf(await parsePdf(bytes, { maxChars: 8, maxPageChars: 4 })).length, 2)
  const total = errorCode(await parsePdf(bytes, { maxChars: 7 }), 'char-limit')
  assert.equal(total.pageNumber, 2)
  assert.equal(total.limit, 7)
  const page = errorCode(await parsePdf(bytes, { maxPageChars: 3 }), 'char-limit')
  assert.equal(page.pageNumber, 1)
  assert.equal(page.limit, 3)
})

test('直接二进制调用也不能绕过 8MB 限额', async () => {
  errorCode(await parsePdf(new Uint8Array(MAX_DOC_BYTES + 1)), 'byte-limit')
})

test('成功、失败、超时及取消都真正终止线程并移除监听器', async (t) => {
  const workers: Worker[] = []
  const terminate = Worker.prototype.terminate
  t.mock.method(Worker.prototype, 'terminate', function (this: Worker) {
    workers.push(this)
    return terminate.call(this)
  })
  pagesOf(await parsePdf(syntheticPdf(['OK'])))
  errorCode(await parsePdf(new Uint8Array()), 'invalid')
  errorCode(await parsePdf(syntheticPdf(['Timeout']), { timeoutMs: 1 }), 'timeout')
  const controller = new AbortController()
  const pending = parsePdf(syntheticPdf(['Cancel']), { signal: controller.signal })
  controller.abort()
  errorCode(await pending, 'cancelled')
  assert.equal(workers.length, 4)
  for (const worker of workers) {
    assert.equal(worker.threadId, -1, '返回时线程必须已经退出')
    assert.equal(worker.eventNames().length, 0)
  }
  const signal = AbortSignal.abort()
  errorCode(await parsePdf(syntheticPdf(['Never start']), { signal }), 'cancelled')
  assert.equal(workers.length, 4, '预取消不创建解析线程')
})

test('嵌入 JavaScript、OpenAction、URI、XFA 不执行、不联网', async (t) => {
  let requests = 0
  const server = createServer((_request, response) => { requests++; response.end('unexpected') })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/external`
  const bytes = syntheticPdf(['Only local text'], {
    catalogExtra: `/OpenAction << /S /JavaScript /JS (fetch\\(\"${url}\"\\)) >> /AA << /WC << /S /URI /URI (${url}) >> >> /AcroForm << /XFA (${url}) >>`,
  })
  assert.equal(pagesOf(await parsePdf(bytes))[0].text, 'Only local text')
  assert.equal(requests, 0)
})

test('真实路径越界、前缀相似目录、符号链接逃逸不读取二进制/摘要、不调用解析器', async (t) => {
  const h = await fixture(t)
  const outside = path.join(h.base, 'outside.pdf')
  await writeFile(outside, syntheticPdf(['Outside']))
  const linked = path.join(h.root, 'outside-link')
  await symlink(h.base, linked, 'junction')
  for (const target of [outside, path.join(h.root, '..', 'outside.pdf'), path.join(linked, 'outside.pdf')]) {
    assert.equal((await h.library.open(target)).kind, 'denied')
  }
  assert.equal(h.read.mock.callCount(), 0)
  assert.equal(h.readBytes.mock.callCount(), 0)
  assert.equal(h.fingerprint.mock.callCount(), 0)
  assert.equal(h.parse.mock.callCount(), 0)
})

test('stat 的 8MB 检查在摘要和二进制读取之前，磁盘出口也有真实上限', async (t) => {
  const h = await fixture(t)
  const handle = await open(h.file, 'r+')
  await handle.truncate(MAX_DOC_BYTES + 1)
  await handle.close()
  assert.equal((await h.library.open(h.file)).kind, 'too-big')
  assert.equal(h.readBytes.mock.callCount(), 0)
  assert.equal(h.fingerprint.mock.callCount(), 0)
  assert.equal(h.parse.mock.callCount(), 0)
  await assert.rejects(h.fs.readBytes(h.file), DocSizeError)
  await assert.rejects(h.fs.fingerprint(h.file), DocSizeError)
  // 失败也关闭文件句柄，Windows 可以立即删除文件。
  await rm(h.file)
})

test('stat 后文件长大时仍拒绝；入口不向解析器传超限快照', async (t) => {
  const h = await fixture(t)
  t.mock.method(h.fs, 'readBytes', async () => new Uint8Array(MAX_DOC_BYTES + 1))
  assert.equal((await h.library.open(h.file)).kind, 'too-big')
  assert.equal(h.parse.mock.callCount(), 0)
})

test('8MB 边界允许读取，但 PDF 的 UTF-8 出口永远拒绝', async (t) => {
  const h = await fixture(t)
  const fs = createDocFileSystem()
  const handle = await open(h.file, 'r+')
  await handle.truncate(MAX_DOC_BYTES)
  await handle.close()
  assert.equal((await fs.readBytes(h.file)).byteLength, MAX_DOC_BYTES)
  await assert.rejects(fs.read(h.file), /禁止.*UTF-8/)
  const disguised = path.join(h.root, '伪装.txt')
  await writeFile(disguised, syntheticPdf(['Still a PDF']))
  await assert.rejects(fs.read(disguised), /禁止.*UTF-8/)
})

test('文档库保留物理页及空页，提示词引用真实页码而不是段索引', async (t) => {
  const h = await fixture(t)
  const outline = outlineOf(await h.library.open(h.file))
  assert.deepEqual(outline.sections.map((section) => section.pageNumber), [1, 2, 3])
  assert.equal(outline.sections[1].text, '')
  assert.match(describeOutline(outline), /第 2 页 · 无可提取文字/)
  assert.match(explainPrompt('合成.PDF', outline, 2), /第 3 页（物理页/)
  assert.match(askPrompt('合成.PDF', outline, 2, '这一页是什么'), /第 3 页/)
  assert.doesNotMatch(askPrompt('合成.PDF', outline, 2, '这一页是什么'), /First page/)
  assert.match(askPrompt('合成.PDF', outline, 1, '空页'), /不要推测/)
  const relocated = { ...outline, sections: [{ ...outline.sections[2], index: 0, pageNumber: 9 }] }
  assert.match(explainPrompt('合成.PDF', relocated, 0), /第 9 页/)
  assert.match(askPrompt('合成.PDF', relocated, 0, '问题'), /第 9 页/)
  assert.equal(h.read.mock.callCount(), 0)
})

test('指纹缓存避免重复二进制读取/解析，内容更新后废弃旧页码，撤销授权不取缓存', async (t) => {
  const h = await fixture(t)
  const first = await h.library.open(h.file)
  outlineOf(first)
  const second = await h.library.open(h.file)
  assert.ok(second.kind === 'opened' && !second.changed)
  assert.equal(h.readBytes.mock.callCount(), 1)
  assert.equal(h.parse.mock.callCount(), 1)
  assert.equal(h.fingerprint.mock.callCount(), 2)
  const update = syntheticPdf(['New first', '', '', 'New fourth'])
  await writeFile(h.file, update)
  const changed = await h.library.open(h.file)
  assert.ok(changed.kind === 'opened' && changed.changed)
  assert.equal(changed.doc.fingerprint, fingerprintBytes(update))
  assert.deepEqual(outlineOf(changed).sections.map((section) => section.pageNumber), [1, 2, 3, 4])
  assert.equal(h.parse.mock.callCount(), 2)
  h.setRoots([])
  assert.equal((await h.library.open(h.file)).kind, 'denied')
  assert.equal(h.fingerprint.mock.callCount(), 3)
})

test('摘要计算与二进制读取之间更新时，缓存指纹仍对应实际解析快照', async (t) => {
  const h = await fixture(t)
  const update = syntheticPdf(['Updated during read'])
  const read = h.fs.readBytes.bind(h.fs)
  t.mock.method(h.fs, 'readBytes', async (target: string) => { await writeFile(target, update); return read(target) })
  const opened = await h.library.open(h.file)
  assert.ok(opened.kind === 'opened')
  assert.equal(opened.doc.fingerprint, fingerprintBytes(update))
  assert.match(outlineOf(opened).sections[0].text, /Updated/)
  await h.library.open(h.file)
  assert.equal(h.parse.mock.callCount(), 1)
})

test('无文本失败不缓存，取消不遗留成功结果，之后可以重新解析', async (t) => {
  const h = await fixture(t, syntheticPdf(['']))
  const scanned = await h.library.open(h.file)
  assert.ok(scanned.kind === 'opened' && scanned.doc.parsed.kind === 'pdf-error')
  assert.equal(scanned.doc.parsed.code, 'no-text')
  await h.library.open(h.file)
  assert.equal(h.parse.mock.callCount(), 2)
  await writeFile(h.file, syntheticPdf(['Recovered']))
  const cancelled = await h.library.open(h.file, { signal: AbortSignal.abort() })
  assert.ok(cancelled.kind === 'unreadable' && cancelled.code === 'cancelled')
  assert.equal(h.parse.mock.callCount(), 2)
  outlineOf(await h.library.open(h.file))
})

test('运行中的解析取消后不缓存；解析期间撤销目录授权也不返回正文', async (t) => {
  const h = await fixture(t)
  const controller = new AbortController()
  const parser: PdfParser = async (_data, options) => {
    assert.equal(options?.signal, controller.signal)
    controller.abort()
    return pdfFailure('cancelled')
  }
  const library = new DocumentLibrary(h.fs, () => [h.root], parser)
  const cancelled = await library.open(h.file, { signal: controller.signal })
  assert.ok(cancelled.kind === 'unreadable' && cancelled.code === 'cancelled')
  let hRoots = [h.root]
  const revoked = new DocumentLibrary(h.fs, () => hRoots, async (data) => {
    hRoots = []
    return parsePdf(data)
  })
  assert.equal((await revoked.open(h.file)).kind, 'denied')
})
