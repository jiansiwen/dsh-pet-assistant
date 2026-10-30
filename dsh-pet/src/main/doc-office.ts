/**
 * Office 2007+ 文档（docx / pptx）的本地结构提取。
 *
 * 只读 ZIP 容器里的 XML，不执行宏、不打开 Office、不访问网络。旧版二进制 .doc/.ppt
 * 不在支持范围；加密文档或损坏容器返回可读错误。
 */
import JSZip from 'jszip'
import type { OutlineSection, ParseResult } from './document.ts'

const MAX_OFFICE_CHARS = 200_000

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

function stemOf(name: string): string {
  const extension = extensionOf(name)
  return extension === '' ? name : name.slice(0, name.length - extension.length)
}

function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_whole, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]
    const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _whole
  })
}

function headingLevel(style: string | null): number {
  if (!style) return 0
  if (/^title$/i.test(style)) return 1
  const named = /^heading\s*([1-6])$/i.exec(style)
  if (named) return Number(named[1])
  const numeric = /^([1-6])$/.exec(style)
  return numeric ? Number(numeric[1]) : 0
}

function buildOutline(title: string, sections: Array<{ heading: string | null; level: number; text: string; pageNumber?: number }>): ParseResult {
  const result: OutlineSection[] = []
  let charCount = 0
  let truncated = false
  for (const section of sections) {
    let text = section.text.trim()
    if (!text && section.heading === null) continue
    if (charCount + text.length > MAX_OFFICE_CHARS) {
      text = text.slice(0, Math.max(0, MAX_OFFICE_CHARS - charCount))
      truncated = true
    }
    charCount += text.length
    result.push({ index: result.length, heading: section.heading, level: section.level, text, hasCode: false,
      ...(section.pageNumber !== undefined ? { pageNumber: section.pageNumber } : {}) })
    if (truncated) break
  }
  if (result.length === 0) return { kind: 'empty' }
  return { kind: 'outline', outline: { title, sections: result, charCount,
    estMinutes: Math.max(1, Math.ceil(charCount / 320)), truncated } }
}

function docxOutline(fileName: string, xml: string): ParseResult {
  const sections: Array<{ heading: string | null; level: number; text: string }> = []
  let current: { heading: string | null; level: number; text: string[] } = { heading: null, level: 0, text: [] }
  const flush = (): void => {
    const text = current.text.join('\n').trim()
    if (text || current.heading !== null) sections.push({ heading: current.heading, level: current.level, text })
  }
  for (const paragraph of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const inner = paragraph[1]
    const style = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(inner)?.[1] ?? null
    const texts = [...inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(match => decodeXml(match[1]))
    const hasBreak = /<w:br\b/.test(inner)
    const text = `${texts.join('')}${hasBreak ? '\n' : ''}`.trim()
    const level = headingLevel(style)
    if (level > 0) {
      flush()
      current = { heading: text || null, level, text: [] }
    } else if (text) {
      current.text.push(text)
    }
  }
  flush()
  const firstTitle = sections.find(section => section.level === 1)?.heading ?? null
  return buildOutline(firstTitle ?? stemOf(fileName), sections)
}

function pptxOutline(fileName: string, slides: Array<{ index: number; xml: string }>): ParseResult {
  const sections: Array<{ heading: string | null; level: number; text: string; pageNumber?: number }> = []
  for (const slide of slides) {
    const paragraphs = [...slide.xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
      .map(paragraph => [...paragraph[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(match => decodeXml(match[1])).join('').trim())
      .filter(Boolean)
    const heading = paragraphs[0]?.slice(0, 200) ?? `第 ${slide.index + 1} 页`
    const text = paragraphs.length > 1 ? paragraphs.slice(1).join('\n') : (paragraphs.length === 0 ? '' : '')
    sections.push({ heading, level: 1, text, pageNumber: slide.index + 1 })
  }
  return buildOutline(stemOf(fileName), sections)
}

function slideNumber(name: string): number | null {
  const match = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(name)
  return match ? Number(match[1]) - 1 : null
}

export async function parseOfficeDocument(fileName: string, bytes: Uint8Array): Promise<ParseResult> {
  const extension = extensionOf(fileName)
  if (extension !== '.docx' && extension !== '.pptx') {
    return { kind: 'unsupported', reason: '只支持 Office 2007+ 的 .docx / .pptx；旧版 .doc / .ppt 需另存为新格式' }
  }
  let zip: JSZip
  try { zip = await JSZip.loadAsync(bytes) } catch { throw new Error('Office 文件不是有效的 ZIP 容器，可能已损坏或加密') }
  if (extension === '.docx') {
    const file = zip.file('word/document.xml')
    if (!file) throw new Error('docx 里找不到 word/document.xml，可能不是 Word 文档或已加密')
    return docxOutline(fileName, await file.async('string'))
  }
  const slides = Object.keys(zip.files)
    .map(name => ({ name, index: slideNumber(name) }))
    .filter((item): item is { name: string; index: number } => item.index !== null)
    .sort((a, b) => a.index - b.index)
  if (slides.length === 0) throw new Error('pptx 里没有找到幻灯片，可能不是 PowerPoint 文档或已加密')
  const loaded: Array<{ index: number; xml: string }> = []
  for (const slide of slides) {
    const file = zip.file(slide.name)
    if (file) loaded.push({ index: slide.index, xml: await file.async('string') })
  }
  return pptxOutline(fileName, loaded)
}
