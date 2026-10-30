/**
 * §2.10 文档打开与讲解的规则测试。
 *
 * 全部跑在假文件系统上：授权边界这种事必须能穷举，真去磁盘上点一遍既点不全也点不快。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'
import {
  askPrompt,
  buildOutline,
  canOpenWithApp,
  canOutline,
  describeOutline,
  detectDocIntent,
  DocumentLibrary,
  explainPrompt,
  extensionOf,
  findMentionedDocs,
  isInsideAuthorized,
  looksLikePath,
  MAX_DOC_BYTES,
  MAX_DOC_CHARS,
  MAX_RECENT_DIRS,
  mentionsDocs,
  pickByName,
  plainSpeech,
  stemOf,
  type DocFile,
  type DocFileSystem,
  type Outline,
} from '../src/main/document.ts'
import { OUTLINE_EXTENSIONS } from '../src/main/doc-formats.ts'

/** 把分隔符统一成正斜杠，好让断言在哪个平台都长一个样。 */
const norm = (target: string): string => target.replace(/\\/g, '/')

class FakeFs implements DocFileSystem {
  /** 真实路径 → 内容。 */
  readonly tree = new Map<string, string>()
  /** 符号链接 → 真实路径。 */
  readonly links = new Map<string, string>()
  /** 报出去的体积，用来试限额而不必真造一个 8MB 的字符串。 */
  readonly sizes = new Map<string, number>()
  readonly mtimes = new Map<string, number>()
  /** 读取黑名单：加密文档、被独占的文件都走这条。 */
  readonly unreadable = new Set<string>()
  /** realpath 解不动时抛出，文档库必须拒绝读取。 */
  readonly unresolvable = new Set<string>()
  readonly openedWithApp: string[] = []
  readonly listedRoots: string[] = []
  readCount = 0
  openShouldFail = false

  seed(target: string, content: string, mtimeMs = 0): this {
    this.tree.set(norm(target), content)
    this.mtimes.set(norm(target), mtimeMs)
    return this
  }

  link(alias: string, target: string): this {
    this.links.set(norm(alias), norm(target))
    return this
  }

  async realpath(target: string): Promise<string> {
    const start = norm(target)
    if (this.unresolvable.has(start)) throw new Error('无法确认真实路径')
    let current = start
    for (let hop = 0; hop < 8; hop++) {
      const next = this.links.get(current)
      if (next === undefined) return current
      current = next
    }
    return current
  }

  async list(root: string): Promise<readonly DocFile[]> {
    const real = await this.realpath(root)
    this.listedRoots.push(norm(real))
    const prefix = norm(real).toLowerCase()
    const inside = prefix.endsWith('/') ? prefix : prefix + '/'
    const hits: DocFile[] = []
    for (const [target, content] of this.tree) {
      if (!target.toLowerCase().startsWith(inside)) continue
      hits.push({
        path: target,
        name: path.basename(target),
        size: this.sizes.get(target) ?? content.length,
        mtimeMs: this.mtimes.get(target) ?? 0,
      })
    }
    return hits
  }

  async stat(target: string): Promise<DocFile | null> {
    const real = await this.realpath(target)
    const content = this.tree.get(norm(real))
    if (content === undefined) return null
    return {
      path: norm(real),
      name: path.basename(norm(real)),
      size: this.sizes.get(norm(real)) ?? content.length,
      mtimeMs: this.mtimes.get(norm(real)) ?? 0,
    }
  }

  async read(target: string): Promise<string> {
    const real = norm(await this.realpath(target))
    this.readCount++
    if (this.unreadable.has(real)) throw new Error('文档已加密，请先解锁')
    const content = this.tree.get(real)
    if (content === undefined) throw new Error('文件不存在')
    return content
  }

  async readBytes(target: string): Promise<Uint8Array> {
    throw new Error(`文本规则测试不应读取二进制：${target}`)
  }

  async fingerprint(target: string): Promise<string> {
    const real = norm(await this.realpath(target))
    return `fp:${this.tree.get(real) ?? ''}`
  }

  async openWithAssociatedApp(target: string): Promise<void> {
    if (this.openShouldFail) throw new Error('没有关联的应用')
    this.openedWithApp.push(norm(target))
  }
}

interface Harness {
  readonly fs: FakeFs
  readonly library: DocumentLibrary
  readonly remembered: string[]
  setRoots(roots: readonly string[]): void
}

function makeHarness(roots: readonly string[] = ['/docs']): Harness {
  const fs = new FakeFs()
  const remembered: string[] = []
  let current = [...roots]
  const library = new DocumentLibrary(fs, () => current)
  return { fs, library, remembered, setRoots: (next) => { current = [...next] } }
}

/** 授权目录里放两份 Markdown、一份纯文本、一份带宏的 Word，够大部分用例用。 */
function seeded(): Harness {
  const h = makeHarness(['/docs', '/recent'])
  h.fs
    .seed('/docs/设计文档.md', '# 设计文档\n\n开头一段话。\n\n## 音频\n\n音频这段的正文。\n', 300)
    .seed('/docs/报告.md', '# 报告\n\n报告正文。\n', 200)
    .seed('/docs/报告2024.md', '# 旧报告\n\n旧正文。\n', 100)
    .seed('/docs/笔记.txt', '第一段。\n\n第二段。\n', 50)
    .seed('/docs/带宏的.docm', 'not really text', 10)
    .seed('/recent/最近选的.md', '# 最近\n\n正文。\n', 400)
    .seed('/elsewhere/机密.md', '# 机密\n\n不该被读到。\n', 1)
  return h
}

const outlineOf = (result: { kind: string; outline?: Outline }): Outline => {
  assert.equal(result.kind, 'outline')
  return (result as { outline: Outline }).outline
}

describe('授权边界', () => {
  test('授权目录里的文件找得到，目录本身不算文档', () => {
    assert.equal(isInsideAuthorized('/docs/a.md', ['/docs']), true)
    assert.equal(isInsideAuthorized('/docs', ['/docs']), false, '根目录自己不是一份文档')
  })

  test('前缀长得像但不是子目录的，不放进来', () => {
    assert.equal(isInsideAuthorized('/docs2/x.md', ['/docs']), false,
      '字符串前缀会把 /docs2 当成 /docs 的子目录')
    assert.equal(isInsideAuthorized('/docsbackup/x.md', ['/docs']), false)
  })

  test('.. 逃不出去', () => {
    assert.equal(isInsideAuthorized('/docs/../elsewhere/机密.md', ['/docs']), false)
  })

  test('大小写与分隔符不影响判断', () => {
    assert.equal(isInsideAuthorized('D:\\Docs\\A.MD', ['d:/docs']), true)
  })

  test('搜索时给的绝对路径越界就拒绝，不去读也不去 stat', async () => {
    const h = seeded()
    const result = await h.library.search('/elsewhere/机密.md')
    assert.deepEqual(result, { kind: 'denied', path: '/elsewhere/机密.md' })
    assert.equal(h.fs.readCount, 0)
  })

  test('符号链接指向授权目录外面时按真实路径拒绝', async () => {
    const h = seeded()
    h.fs.link('/docs/看着在里面.md', '/elsewhere/机密.md')
    const result = await h.library.open('/docs/看着在里面.md')
    assert.equal(result.kind, 'denied', '链接的壳在授权目录里，指向的东西不在')
    assert.equal(h.fs.readCount, 0)
  })

  test('realpath 解不动时拒绝，不以字面路径绕过真实路径授权', async () => {
    const h = seeded()
    h.fs.unresolvable.add('/docs/设计文档.md')
    const result = await h.library.open('/docs/设计文档.md')
    assert.equal(result.kind, 'denied')
    assert.equal(h.fs.readCount, 0)
    assert.equal((await h.library.search('/docs/设计文档.md')).kind, 'denied')
    assert.equal((await h.library.reveal('/docs/设计文档.md', () => {})).ok, false)
  })

  test('open 自己也判一次包含关系：界面点过的路径不是 IPC 上来的路径的担保', async () => {
    const h = seeded()
    assert.equal((await h.library.open('/elsewhere/机密.md')).kind, 'denied')
  })

  test('最近选过的目录也算授权范围', async () => {
    const h = seeded()
    const result = await h.library.search('最近选的.md')
    assert.equal(result.kind, 'found')
  })

  test('授权目录改了立刻生效，不缓存根列表', async () => {
    const h = makeHarness(['/docs'])
    h.fs.seed('/docs/a.md', '# a\n\n正文。\n')
    assert.equal((await h.library.search('a.md')).kind, 'found')
    h.setRoots([])
    assert.equal((await h.library.search('a.md')).kind, 'missing', '撤了授权还找得到，那授权就是摆设')
  })

  test('重叠的授权目录不会产生两份候选', async () => {
    const h = makeHarness(['/docs', '/docs/子目录'])
    h.fs.seed('/docs/子目录/里头的.md', '# 里头\n\n正文。\n')
    const hits = await h.library.candidates()
    assert.equal(hits.filter((file) => file.name === '里头的.md').length, 1)
  })
})

describe('按名字查找', () => {
  const files = (names: readonly string[], mtimes?: readonly number[]): DocFile[] =>
    names.map((name, index) => ({
      path: `/docs/${name}`,
      name,
      size: 10,
      mtimeMs: mtimes?.[index] ?? index,
    }))

  test('完整文件名精确命中', () => {
    const result = pickByName('设计文档.md', files(['设计文档.md', '设计文档v2.md']))
    assert.equal(result.kind, 'found')
  })

  test('不带扩展名时对上主干', () => {
    const result = pickByName('设计文档', files(['设计文档.md']))
    assert.equal(result.kind, 'found')
  })

  test('带扩展名的命中优先：说了报告.md 就不该把报告2024.md 拽进来', () => {
    const result = pickByName('报告.md', files(['报告.md', '报告2024.md']))
    assert.equal(result.kind, 'found')
    if (result.kind === 'found') assert.equal(result.hit.name, '报告.md')
  })

  test('同一档里剩多个就交回界面让用户选，按改动时间从新到旧', () => {
    const result = pickByName('报告', files(['报告.md', '报告.txt'], [100, 900]))
    assert.equal(result.kind, 'ambiguous', '§2.10 明令禁止搜到第一个就打开')
    if (result.kind === 'ambiguous') {
      assert.deepEqual(result.hits.map((hit) => hit.name), ['报告.txt', '报告.md'], '用户要的大概率是最近在动的那份')
    }
  })

  test('主干精确命中优先于前缀命中', () => {
    const result = pickByName('报告', files(['报告2024.md', '报告.md']))
    assert.equal(result.kind, 'found')
    if (result.kind === 'found') assert.equal(result.hit.name, '报告.md')
  })

  test('只剩前缀命中时返回候选', () => {
    const result = pickByName('报告2', files(['报告2024.md', '报告2025.md']))
    assert.equal(result.kind, 'ambiguous')
  })

  test('Windows 上大小写不算差别', () => {
    const result = pickByName('README.MD', files(['readme.md']))
    assert.equal(result.kind, 'found')
  })

  test('显式查找时单字主干也算命中，守卫在消息扫描那一侧', () => {
    // 用户在选择列表里明明白白搜了一个字，那就该找到；不能命中的一句话是在聊天里
    // 顺带出现了一个字（见下面 findMentionedDocs 的用例）。
    assert.equal(pickByName('表', files(['表.md'])).kind, 'found')
  })

  test('空名字与找不着都报 missing', () => {
    assert.equal(pickByName('   ', files(['a.md'])).kind, 'missing')
    assert.equal(pickByName('不存在的文件', files(['a.md'])).kind, 'missing')
  })

  test('looksLikePath 认得出路径，认不出普通文件名', () => {
    assert.equal(looksLikePath('/docs/a.md'), true)
    assert.equal(looksLikePath('docs\\a.md'), true)
    assert.equal(looksLikePath('设计文档.md'), false)
  })

  test('extensionOf 与 stemOf：点开头的文件没有扩展名', () => {
    assert.equal(extensionOf('.gitignore'), '')
    assert.equal(stemOf('.gitignore'), '.gitignore')
    assert.equal(extensionOf('报告.MIN.MD'), '.md')
    assert.equal(stemOf('报告.MIN.MD'), '报告.MIN')
  })
})

describe('用系统关联打开', () => {
  test('带宏的与可执行的一律不开', () => {
    for (const name of ['文档.docm', '表格.xlsm', '幻灯.pptm', '安装.exe', '脚本.ps1', '批处理.bat', '快捷.lnk', '注册.reg']) {
      assert.equal(canOpenWithApp(name), false, `${name} 不该被交给系统关联`)
    }
  })

  test('普通文档可以开', () => {
    for (const name of ['文档.docx', '设计.md', '数据.csv', '扫描.pdf', '图.png']) {
      assert.equal(canOpenWithApp(name), true, `${name} 应该能开`)
    }
  })

  test('reveal 走白名单，被拒的时候不去碰系统关联', async () => {
    const h = seeded()
    const result = await h.library.reveal('/docs/带宏的.docm', (dir) => h.remembered.push(dir))
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : '', /不允许/)
    assert.deepEqual(h.fs.openedWithApp, [])
  })

  test('reveal 成功之后把所在目录记进最近范围', async () => {
    const h = seeded()
    const result = await h.library.reveal('/docs/设计文档.md', (dir) => h.remembered.push(dir))
    assert.equal(result.ok, true)
    assert.deepEqual(h.remembered, ['/docs'])
    assert.deepEqual(h.fs.openedWithApp, ['/docs/设计文档.md'])
  })

  test('reveal 也受授权目录约束', async () => {
    const h = seeded()
    assert.equal((await h.library.reveal('/elsewhere/机密.md', () => {})).ok, false)
  })

  test('系统没有关联应用时把原因报出去', async () => {
    const h = seeded()
    h.fs.openShouldFail = true
    const result = await h.library.reveal('/docs/设计文档.md', () => {})
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : '', /没有关联的应用/)
  })

  test('最近目录条数有上限，防止设置文件被撑爆', () => {
    assert.equal(MAX_RECENT_DIRS, 8)
  })
})

describe('体积与读取限额', () => {
  test('超过体积上限直接拒绝，连读都不读', async () => {
    const h = makeHarness()
    h.fs.seed('/docs/巨大.log', '一小段')
    h.fs.sizes.set('/docs/巨大.log', MAX_DOC_BYTES + 1)
    const result = await h.library.open('/docs/巨大.log')
    assert.equal(result.kind, 'too-big')
    assert.equal(h.fs.readCount, 0, '8MB 以上还去读一遍，光是读就把界面卡住了')
  })

  test('正好在上限上的可以读', async () => {
    const h = makeHarness()
    h.fs.seed('/docs/刚好.log', '# 标题\n\n正文。\n')
    h.fs.sizes.set('/docs/刚好.log', MAX_DOC_BYTES)
    assert.equal((await h.library.open('/docs/刚好.log')).kind, 'opened')
  })

  test('加密或读不动的文档报出原因，不咽成一句打不开', async () => {
    const h = makeHarness()
    h.fs.seed('/docs/加密.docx', 'x')
    h.fs.unreadable.add('/docs/加密.docx')
    const result = await h.library.open('/docs/加密.docx')
    assert.equal(result.kind, 'unreadable')
    assert.match(result.kind === 'unreadable' ? result.reason : '', /加密/)
  })

  test('文件不存在报 missing', async () => {
    const h = makeHarness()
    assert.equal((await h.library.open('/docs/没有这个.md')).kind, 'missing')
  })
})

describe('结构化提取', () => {
  test('Markdown 按标题分段，标题之后的正文归那一段', () => {
    const outline = outlineOf(buildOutline('设计.md', '# 设计文档\n\n开头。\n\n## 音频\n\n音频正文。\n\n## 桥接\n\n桥接正文。\n'))
    assert.equal(outline.title, '设计文档')
    assert.deepEqual(outline.sections.map((section) => section.heading), ['设计文档', '音频', '桥接'])
    assert.deepEqual(outline.sections.map((section) => section.level), [1, 2, 2])
    assert.equal(outline.sections[0].text, '开头。')
    assert.equal(outline.sections[1].text, '音频正文。')
  })

  test('正文出现在第一个标题之前时，开头是一段无标题段', () => {
    const outline = outlineOf(buildOutline('设计.md', '没有标题的开头。\n\n## 音频\n\n音频正文。\n'))
    assert.deepEqual(outline.sections.map((section) => section.heading), [null, '音频'])
    assert.equal(outline.sections[0].text, '没有标题的开头。')
    assert.equal(outline.title, '设计', '没有一级标题就拿文件名当标题')
  })

  test('文档一上来就是标题时不产生空的开头段', () => {
    const outline = outlineOf(buildOutline('a.md', '# 标题\n\n正文。\n'))
    assert.deepEqual(outline.sections.map((section) => section.heading), ['标题'])
  })

  test('代码块不进正文，但要记下这段有代码', () => {
    const outline = outlineOf(buildOutline('a.md', '## 实现\n\n说明一句。\n\n```ts\nconst x = 1\n```\n\n说明第二句。\n'))
    assert.equal(outline.sections.length, 1)
    assert.equal(outline.sections[0].hasCode, true)
    assert.equal(outline.sections[0].text, '说明一句。\n说明第二句。')
    assert.doesNotMatch(outline.sections[0].text, /const/, '逐字符念一段代码谁都听不下去')
  })

  test('围栏里的 # 不当成标题', () => {
    const outline = outlineOf(buildOutline('a.md', '## 真的\n\n```\n# 这是注释不是标题\n```\n'))
    assert.deepEqual(outline.sections.map((section) => section.heading), ['真的'])
  })

  test('只有代码的文档也有一段，正文是空的', () => {
    const outline = outlineOf(buildOutline('a.md', '```\ncode\n```\n'))
    assert.equal(outline.sections.length, 1)
    assert.equal(outline.sections[0].text, '')
    assert.equal(outline.sections[0].hasCode, true)
    assert.equal(outline.estMinutes, 1, '估时长至少给一分钟，别报 0 让用户以为不用听')
  })

  test('行内标记清干净：链接只留锚文本，图片整条丢掉', () => {
    const said = plainSpeech('看 [设计文档](https://example.com/a/b?x=1) 和 ![图](p.png)，还有 **重点** 与 `code`。')
    assert.equal(said, '看 设计文档 和，还有 重点 与 code。', '图片丢掉之后逗号前不该留空格')
    assert.doesNotMatch(said, /https|png|\*|`/, 'URL 和星号会被一个字一个字念出来')
  })

  test('列表符、引用符、分割线与表格竖线都不进正文', () => {
    const said = plainSpeech('> 引用\n\n- 一项\n- 两项\n\n1. 有序\n\n---\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n')
    assert.doesNotMatch(said, /^[-*>|#]/m, '合成器会把这些符号念成停顿或者干脆念出来')
    assert.doesNotMatch(said, /---/, '表格的分隔行只剩短横，念出来是一串没来由的停顿')
    assert.match(said, /甲，乙/, '两个格子之间要停一下，直接咽掉竖线会把它们连成一个词')
    assert.match(said, /引用/)
    assert.match(said, /甲/)
  })

  test('纯文本按空行聚段', () => {
    const outline = outlineOf(buildOutline('笔记.txt', '第一段。\n\n第二段。\n\n第三段。\n'))
    assert.deepEqual(outline.sections.map((section) => section.text), ['第一段。', '第二段。', '第三段。'])
    assert.equal(outline.title, '笔记', '没有标题就拿文件名当标题')
  })

  test('纯文本的段数就是自然段数，不按字数合并', () => {
    const block = '字'.repeat(500)
    const outline = outlineOf(buildOutline('长.txt', [block, block, block, block].join('\n\n')))
    assert.equal(outline.sections.length, 4, '合并之后用户嘴里的"第三段"就跟编号对不上了')
  })

  test('提纲行数有上限，剩下的只报段数', () => {
    const blocks = Array.from({ length: 120 }, (_unused, index) => `第${index}段的内容。`)
    const text = describeOutline(outlineOf(buildOutline('长.txt', blocks.join('\n\n'))))
    assert.match(text, /共 120 段/)
    assert.match(text, /还有 80 段没列出来/)
    assert.equal(text.split('\n').length, 42, '一行标题加四十行提纲加一行剩余说明')
  })

  test('全是空白的文档报 empty', () => {
    assert.equal(buildOutline('a.txt', '\n\n   \n').kind, 'empty')
    assert.equal(buildOutline('a.md', '# 只有一个标题\n').kind, 'outline', '只有标题也算有东西可讲')
  })

  test('读不出结构的格式说清原因，不编一份提纲出来', () => {
    for (const name of ['扫描.pdf', '合同.docx', '数据.xlsx', '没有扩展名']) {
      const result = buildOutline(name, 'whatever')
      assert.equal(result.kind, 'unsupported', name)
      assert.match(result.kind === 'unsupported' ? result.reason : '', /读不出结构|认不出/, name)
    }
  })

  test('能打开的格式多于能讲的格式，这两件事分开', () => {
    assert.equal(canOpenWithApp('扫描.pdf'), true, '打不开的话用户连自己看都做不到')
    assert.equal(canOutline('文字.pdf'), true, 'PDF 支持本地文字提取，扫描无文本由解析结果明确报告')
    assert.equal(canOutline('设计.md'), true)
  })

  test('界面上念给用户的那份名单，就是真讲得了的那份', () => {
    // 文档页「讲得了什么」直接把 OUTLINE_EXTENSIONS 念出去。名单和判据各写一份的话，
    // 漏掉的那个扩展名会让用户拿一份明明讲得了的文件来、被告知讲不了 —— 界面在撒谎，
    // 而且没有任何东西会报错。原先手抄的那份就漏了 .markdown 和 .tsv。
    for (const extension of OUTLINE_EXTENSIONS) {
      assert.equal(canOutline(`文件${extension}`), true, `${extension} 在名单里却讲不了`)
    }
    for (const extension of ['.doc', '.xls', '.xlsx', '.ppt', '.png', '.docm']) {
      assert.equal(canOutline(`文件${extension}`), false, `${extension} 不该讲得了`)
    }
    assert.equal(canOutline('文件.docx'), true, 'docx 走授权后的二进制解析')
    assert.equal(canOutline('文件.pptx'), true, 'pptx 走授权后的二进制解析')
  })

  test('超过字数上限时截断并明说', () => {
    const outline = outlineOf(buildOutline('长.md', '# 标题\n\n' + '字'.repeat(MAX_DOC_CHARS + 5000)))
    assert.equal(outline.truncated, true)
    assert.ok(outline.charCount <= MAX_DOC_CHARS)
    assert.match(describeOutline(outline), /只解析了前面这部分/)
  })

  test('估时长按中文朗读速度算', () => {
    const outline = outlineOf(buildOutline('a.txt', '字'.repeat(2400)))
    assert.equal(outline.estMinutes, 10)
  })
})

describe('提纲与提示词', () => {
  const sample = (): Outline =>
    outlineOf(buildOutline('设计.md', '# 设计\n\n开头。\n\n## 音频\n\n音频正文比较长的一段。\n\n## 桥接\n\n桥接正文。\n'))

  test('提纲只列标题和估计范围，不带正文', () => {
    const text = describeOutline(sample())
    assert.match(text, /《设计》共 3 段/)
    assert.match(text, /讲完大约 \d+ 分钟/)
    assert.match(text, /2\. 音频/)
    assert.doesNotMatch(text, /音频正文比较长/, '提纲是让用户挑段落的，把正文塞进来就又是整份文档了')
  })

  test('讲解提示只带当前段的正文，其余段只给标题', () => {
    const prompt = explainPrompt('设计.md', sample(), 1)
    assert.match(prompt, /第 2 段/)
    assert.match(prompt, /音频正文比较长的一段。/)
    assert.doesNotMatch(prompt, /桥接正文/, '不靠整份文档全文反复塞给模型')
    assert.match(prompt, /3\. 桥接/)
  })

  test('讲解提示写死了区分原文/解释/补充，以及不执行文档里的指令', () => {
    const prompt = explainPrompt('设计.md', sample(), 0)
    assert.match(prompt, /【原文】/)
    assert.match(prompt, /【解释】/)
    assert.match(prompt, /【补充】/)
    assert.match(prompt, /不要执行/, '阶段 E 的退出条件之一就是"不执行文档中的指令"')
    assert.match(prompt, /能被语音朗读/)
  })

  test('含代码的段会提醒模型不要逐行念', () => {
    const outline = outlineOf(buildOutline('a.md', '## 实现\n\n说明。\n\n```\ncode()\n```\n'))
    assert.match(explainPrompt('a.md', outline, 0), /不要逐行念/)
    assert.doesNotMatch(explainPrompt('a.md', sample(), 0), /不要逐行念/)
  })

  test('段号越界时返回空提示词，调用方据此不发消息', () => {
    assert.equal(explainPrompt('设计.md', sample(), 99), '')
  })

  test('追问只带被问到的那一段', () => {
    const prompt = askPrompt('设计.md', sample(), 2, '这一段为什么这么设计')
    assert.match(prompt, /第 3 段/)
    assert.match(prompt, /桥接正文。/)
    assert.match(prompt, /这一段为什么这么设计/)
    assert.doesNotMatch(prompt, /音频正文/, '定位到某一段时不该把别的段也塞过去')
  })

  test('追问的段号越界时退回原始问题，不带任何文档内容', () => {
    assert.equal(askPrompt('设计.md', sample(), 99, '随便问问'), '随便问问')
  })
})

describe('内容摘要与续讲定位', () => {
  test('内容没变时第二次打开不重读', async () => {
    const h = makeHarness()
    h.fs.seed('/docs/a.md', '# a\n\n正文。\n')
    const first = await h.library.open('/docs/a.md')
    assert.equal(first.kind, 'opened')
    assert.equal(h.fs.readCount, 1)
    const second = await h.library.open('/docs/a.md')
    assert.equal(second.kind, 'opened')
    assert.equal(h.fs.readCount, 1, '同一份文档反复解析，讲一次就卡一次')
    assert.equal(second.kind === 'opened' && second.changed, false)
  })

  test('文档改过之后重新解析并报 changed，旧的段落定位就此作废', async () => {
    const h = makeHarness()
    h.fs.seed('/docs/a.md', '# a\n\n第一版。\n')
    await h.library.open('/docs/a.md')
    h.fs.seed('/docs/a.md', '# a\n\n第二版多了一段。\n\n## 新增\n\n新增正文。\n')
    const result = await h.library.open('/docs/a.md')
    assert.equal(result.kind, 'opened')
    assert.equal(result.kind === 'opened' && result.changed, true,
      '摘要不变而定位照旧用，用户听到的会是改之前的那段话')
    if (result.kind === 'opened') {
      const outline = outlineOf(result.doc.parsed)
      assert.equal(outline.sections.length, 2)
    }
  })

  test('同一个文件从不同路径打开命中同一份缓存', async () => {
    const h = makeHarness()
    h.fs.seed('/docs/a.md', '# a\n\n正文。\n')
    await h.library.open('/docs/a.md')
    await h.library.open('/docs//a.md')
    assert.equal(h.fs.readCount, 1)
  })

  test('指纹按真实路径算：链接进来的是同一份文档', async () => {
    const h = makeHarness(['/docs', '/elsewhere'])
    h.fs.seed('/elsewhere/真身.md', '# 真身\n\n正文。\n')
    h.fs.link('/docs/别名.md', '/elsewhere/真身.md')
    await h.library.open('/elsewhere/真身.md')
    const viaLink = await h.library.open('/docs/别名.md')
    assert.equal(viaLink.kind, 'opened')
    assert.equal(h.fs.readCount, 1)
  })
})

describe('消息里的文档意图', () => {
  test('点名了真实文件加上讲解动词才算意图', async () => {
    const h = seeded()
    const files = await h.library.candidates()
    assert.equal(detectDocIntent('讲讲设计文档', files).kind, 'explain')
    assert.equal(detectDocIntent('打开设计文档', files).kind, 'open')
    assert.equal(detectDocIntent('把设计文档.md 打开一下', files).kind, 'open')
  })

  test('有动词但没点到文件时不劫持，消息照常交给模型', async () => {
    const h = seeded()
    const files = await h.library.candidates()
    assert.equal(detectDocIntent('讲讲今天干了啥', files).kind, 'none')
    assert.equal(detectDocIntent('解释一下这段代码', files).kind, 'none')
  })

  test('既有快捷指令不会被当成打开文档', async () => {
    const h = seeded()
    const files = await h.library.candidates()
    // "开启个人助理模式"里的"开启"不是文档动词，而且也没有哪个文件叫这个名字。
    assert.equal(detectDocIntent('开启个人助理模式', files).kind, 'none')
    assert.equal(detectDocIntent('总结今日工作内容', files).kind, 'none')
  })

  test('同时有打开和讲解动词时按讲解走：讲解本来就会把文件开出来', async () => {
    const h = seeded()
    const files = await h.library.candidates()
    assert.equal(detectDocIntent('打开设计文档讲一下', files).kind, 'explain')
  })

  test('点到多个文件时取主干最长的那个', async () => {
    const h = makeHarness()
    h.fs.seed('/docs/报告.md', '# 报告\n\n正文。\n').seed('/docs/报告2024.md', '# 旧\n\n正文。\n')
    const files = await h.library.candidates()
    const intent = detectDocIntent('讲讲报告2024', files)
    assert.equal(intent.kind, 'explain')
    if (intent.kind === 'explain') assert.equal(intent.mention.file.name, '报告2024.md')
  })

  test('findMentionedDocs 里完整文件名优先于主干', () => {
    const files: DocFile[] = [
      { path: '/docs/报告.md', name: '报告.md', size: 1, mtimeMs: 0 },
      { path: '/docs/报告2024.md', name: '报告2024.md', size: 1, mtimeMs: 0 },
    ]
    const mentions = findMentionedDocs('打开报告.md', files)
    assert.deepEqual(mentions.map((mention) => mention.file.name), ['报告.md'])
  })

  test('单字主干的文件不会被随便点到', () => {
    const files: DocFile[] = [{ path: '/docs/表.md', name: '表.md', size: 1, mtimeMs: 0 }]
    assert.deepEqual(findMentionedDocs('这个表格怎么做', files), [])
  })
})

describe('mentionsDocs（意图识别的前置筛子）', () => {
  test('筛子不能比意图识别更窄：被它筛掉的那些必须真的不是意图', async () => {
    // 主进程拿这个函数决定要不要为一个消息走一趟磁盘扫描。它要是把某句"讲讲设计文档"筛掉了，
    // detectDocIntent 根本没机会跑 —— 用户说了一句，壳装作没听见，而日志上一切正常。
    const h = seeded()
    const files = await h.library.candidates()
    const messages = [
      '讲讲设计文档',
      '打开设计文档',
      '把设计文档.md 打开一下',
      '打开设计文档讲一下',
      '讲讲今天干了啥',
      '解释一下这段代码',
      '开启个人助理模式',
      '总结今日工作内容',
      '帮我写个函数',
    ]
    for (const message of messages) {
      if (mentionsDocs(message)) continue
      assert.equal(detectDocIntent(message, files).kind, 'none', `被筛掉了，可它是个意图：${message}`)
    }
  })

  test('点名了文件的每一句都放行', () => {
    assert.equal(mentionsDocs('打开设计文档'), true)
    assert.equal(mentionsDocs('讲讲设计文档'), true)
    assert.equal(mentionsDocs('把设计文档.md 翻开'), true)
    assert.equal(mentionsDocs('给我念一遍周报'), true)
  })

  test('跟文档无关的闲聊不放行：每放行一次就是一趟全目录扫描', () => {
    assert.equal(mentionsDocs('帮我写个函数'), false)
    assert.equal(mentionsDocs('开启个人助理模式'), false)
    assert.equal(mentionsDocs('总结今日工作内容'), false)
    assert.equal(mentionsDocs('今天天气怎么样'), false)
  })

  test('宽动词会误放，这一类由 detectDocIntent 判成 none 挡下来', () => {
    // "讲"和"解释"太常见了，筛子放过它们是有意的：筛子只做几次字符串比较，误放的代价是一趟
    // 扫描（还有半分钟缓存兜着），漏放的代价是用户的话没人接。宁可多扫。
    assert.equal(mentionsDocs('讲讲今天干了啥'), true)
    assert.equal(mentionsDocs('解释一下这段代码'), true)
  })
})

describe('阅读视图快照（不走缓存，每次重查授权与指纹）', () => {
  class BytesFs extends FakeFs {
    override async readBytes(target: string): Promise<Uint8Array> {
      const real = norm(await this.realpath(target))
      this.readCount++
      return new Uint8Array(Buffer.from(this.tree.get(real) ?? ''))
    }
  }

  test('授权内且指纹一致才给字节；撤销、越界、符号链接换指向、改内容、超限都拒', async () => {
    const fs = new BytesFs().seed('D:/docs/a.pdf', 'v1').seed('D:/other/b.pdf', 'evil')
    let roots = ['D:/docs']
    const library = new DocumentLibrary(fs, () => roots)
    const first = await library.snapshot('D:/docs/a.pdf')
    assert.equal(first.kind, 'snapshot')
    assert.ok(first.kind === 'snapshot')
    const fingerprint = first.fingerprint
    assert.equal((await library.snapshot('D:/docs/a.pdf', fingerprint)).kind, 'snapshot')

    fs.seed('D:/docs/a.pdf', 'v2')
    const changed = await library.snapshot('D:/docs/a.pdf', fingerprint)
    assert.equal(changed.kind, 'changed')

    assert.equal((await library.snapshot('D:/other/b.pdf')).kind, 'denied')
    fs.link('D:/docs/a.pdf', 'D:/docs/c.pdf').seed('D:/docs/c.pdf', 'v1')
    assert.equal((await library.snapshot('D:/docs/a.pdf', fingerprint)).kind, 'changed', '链接换了指向不跟着走')
    fs.links.clear()

    fs.sizes.set('D:/docs/a.pdf', MAX_DOC_BYTES + 1)
    assert.equal((await library.snapshot('D:/docs/a.pdf')).kind, 'too-big')
    fs.sizes.clear()

    const reads = fs.readCount
    roots = []
    assert.equal((await library.snapshot('D:/docs/a.pdf')).kind, 'denied')
    assert.equal(fs.readCount, reads, '越权时不读取')
    roots = ['D:/docs']
    fs.tree.delete('D:/docs/a.pdf')
    assert.equal((await library.snapshot('D:/docs/a.pdf')).kind, 'missing')
  })
})
