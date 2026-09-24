/** 仅生成合成、无敏感内容的测试 PDF；不使用外部文档或额外依赖。 */
import { createHash } from 'node:crypto'

export function pdfFromObjects(objects: readonly string[], trailer = ''): Uint8Array {
  let body = '%PDF-1.7\n%\x80\x81\x82\x83\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(body, 'latin1'))
}

function rc4(key: Uint8Array, data: Uint8Array): Buffer {
  const state = Array.from({ length: 256 }, (_, index) => index)
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) % 256
    ;[state[i], state[j]] = [state[j], state[i]]
  }
  let i = 0
  j = 0
  return Buffer.from(data.map((byte) => {
    i = (i + 1) % 256
    j = (j + state[i]) % 256
    ;[state[i], state[j]] = [state[j], state[i]]
    return byte ^ state[(state[i] + state[j]) % 256]
  }))
}

const md5 = (data: Uint8Array): Buffer => createHash('md5').update(data).digest()

/** pages 是每页的合成 ASCII 正文，空字符串表示真实空白页。 */
export function syntheticPdf(pages: readonly string[], options: {
  encrypted?: boolean
  imageOnly?: boolean
  catalogExtra?: string
  contentStream?: string
} = {}): Uint8Array {
  const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex')
  const pad = (value: string): Buffer => Buffer.concat([Buffer.from(value), padding]).subarray(0, 32)
  const owner = rc4(md5(pad('synthetic-owner')).subarray(0, 5), pad('synthetic-password'))
  const identifier = Buffer.alloc(16, 7)
  const permissions = Buffer.alloc(4)
  permissions.writeInt32LE(-4)
  const key = md5(Buffer.concat([pad('synthetic-password'), owner, permissions, identifier])).subarray(0, 5)
  const user = rc4(key, padding)
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${options.catalogExtra ?? ''} >>`,
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (const text of pages) {
    const streamId = objects.length + 2
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`)
    let content = options.contentStream ?? (options.imageOnly
      ? 'q 10 0 0 10 40 40 cm BI /W 1 /H 1 /BPC 8 /CS /RGB ID \xff\xff\xff EI Q'
      : text.split('\n').map((line, index) => `BT /F1 12 Tf 50 ${750 - index * 20} Td (${line.replace(/[\\()]/g, '\\$&')}) Tj ET`).join('\n'))
    if (options.encrypted) {
      const reference = Buffer.from([streamId & 255, (streamId >> 8) & 255, (streamId >> 16) & 255, 0, 0])
      content = rc4(md5(Buffer.concat([key, reference])).subarray(0, 10), Buffer.from(content, 'latin1')).toString('latin1')
    }
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`)
  }
  let trailer = ''
  if (options.encrypted) {
    objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> >>`)
    trailer = `/Encrypt ${objects.length} 0 R /ID [<${identifier.toString('hex')}> <${identifier.toString('hex')}>]`
  }
  return pdfFromObjects(objects, trailer)
}
