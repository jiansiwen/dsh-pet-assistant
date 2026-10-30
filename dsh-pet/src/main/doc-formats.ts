/**
 * 文档格式的三份名单。
 *
 * 单独住一个零依赖的文件，是因为两边都要读它：`document.ts` 拿它判断一份文件能不能解析、
 * 能不能交给系统关联打开；界面上那块「讲得了什么」要把同一份名单原样念给用户听。
 * 两处各抄一份必然抄歪，而歪的方向是界面在撒谎 —— 用户拿一份明明讲得了的 `.tsv` 来，
 * 被告知讲不了。
 *
 * 名单不能留在 `document.ts` 里再让界面去导：渲染层按 `platform: 'browser'` 打包，
 * 而 `document.ts` 要 `node:path`，吃不进去。
 */

/** 有标题层级、能按标题切段的。 */
export const MARKDOWN_EXTENSIONS: readonly string[] = ['.md', '.markdown']

/** 没有标题层级、按空行切段的。 */
export const PLAINTEXT_EXTENSIONS: readonly string[] = ['.txt', '.log', '.csv', '.tsv', '.json']

/** 通过本地二进制解析、按物理页讲解；扫描件和加密文件不保证可提取。 */
export const PDF_EXTENSIONS: readonly string[] = ['.pdf']

/** Office 2007+ 的 ZIP 容器；旧版二进制 .doc/.ppt 不在此列。 */
export const DOCX_EXTENSIONS: readonly string[] = ['.docx']
export const PPTX_EXTENSIONS: readonly string[] = ['.pptx']
export const OFFICE_EXTENSIONS: readonly string[] = [...DOCX_EXTENSIONS, ...PPTX_EXTENSIONS]

/** 能逐段讲解的。界面上直接念这一份，不要另抄一遍。 */
export const OUTLINE_EXTENSIONS: readonly string[] = [...MARKDOWN_EXTENSIONS, ...PLAINTEXT_EXTENSIONS, ...PDF_EXTENSIONS, ...OFFICE_EXTENSIONS]

/**
 * 允许用系统关联打开的扩展名。
 *
 * 这份名单是按"打开了会怎样"来划的，不是按"常见不常见"：
 * - `.docm/.xlsm/.pptm` 不在里面 —— 计划明确"不执行文档宏"，而打开就可能触发；
 * - `.exe/.bat/.cmd/.ps1/.vbs/.lnk/.reg/.msi` 不在里面 —— 那已经不是打开文档而是执行程序；
 * - `.html` 留着（浏览器打开是只读的），`.js` 不留（关联可能是编辑器，也可能被配成了别的）。
 */
export const OPENABLE_EXTENSIONS: readonly string[] = [
  '.md', '.markdown', '.txt', '.log', '.csv', '.tsv', '.json',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.png', '.jpg', '.jpeg', '.html', '.htm',
]
