/** 原文按讲解标题切分，不解释 HTML 或执行文档中的内容。 */
export function markdownBlocks(text: string, sections: readonly { readonly heading: string | null }[]): string[] {
  if (sections.length < 2) return [text]
  const starts = Array<number>(sections.length).fill(-1)
  starts[0] = 0
  let next = sections[0].heading === null ? 1 : 0
  let offset = 0
  let inFence = false
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const body = line.replace(/\r?\n$/u, '')
    if (/^\s*(```|~~~)/u.test(body)) inFence = !inFence
    else if (!inFence && next < sections.length) {
      const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(body)
      if (match && match[2].trim() === sections[next].heading) {
        if (next > 0) starts[next] = offset
        next++
      }
    }
    offset += line.length
  }
  for (let i = 1; i < starts.length; i++) if (starts[i] < 0) starts[i] = starts[i - 1]
  return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length))
}
