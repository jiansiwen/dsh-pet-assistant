/**
 * 应用分类引擎：进程名 → 类别 + 窗口标题提取。
 */
import type { CustomClassifyRule } from './config.ts'

export type Category =
  | 'chat'
  | 'browser'
  | 'document'
  | 'dev'
  | 'meeting'
  | 'ai'
  | 'terminal'
  | 'idle'
  | 'other'

export interface Classified {
  category: Category
  /** 提取后的有效标题（文档名/网页标题/聊天对象）。 */
  title: string
  rawTitle: string
}

interface Rule {
  process: RegExp
  category: Category
  extract?: (rawTitle: string) => string
}

/** 浏览器窗口标题的通用后缀，提取页面标题时去掉。 */
const BROWSER_SUFFIXES = [
  'Google Chrome',
  'Microsoft Edge',
  'Mozilla Firefox',
  'Firefox',
  'Brave',
  'Chromium',
  'Vivaldi',
  'Arc',
  'Opera',
  '360安全浏览器',
  '360极速浏览器',
  '360浏览器',
  '搜狗浏览器',
  'QQ浏览器',
  'Internet Explorer',
  '世界之窗',
]

/** 浏览器标签页标题中出现这些关键词时，归类为 ai（AI 网页工具）。 */
const AI_TITLE_PATTERN = /(DeepSeek|ChatGPT|OpenAI|Claude|Gemini|Kimi|豆包|腾讯元宝|通义|文心一言|智谱清言|讯飞星火|Copilot|Perplexity|Grok)/i

function stripSuffix(rawTitle: string, suffixes: readonly string[]): string {
  for (const suffix of suffixes) {
    const marker = rawTitle.lastIndexOf(` - ${suffix}`)
    if (marker >= 0) return rawTitle.slice(0, marker).trim()
    const emMarker = rawTitle.lastIndexOf(` – ${suffix}`)
    if (emMarker >= 0) return rawTitle.slice(0, emMarker).trim()
  }
  return rawTitle.trim()
}

function trimTitle(title: string): string {
  return title.trim().slice(0, 200)
}

const DEFAULT_RULES: Rule[] = [
  // 聊天：窗口标题通常就是聊天对象或群名
  { process: /^WeChat$/i, category: 'chat', extract: t => trimTitle(t) },
  { process: /^WXWork$/i, category: 'chat', extract: t => trimTitle(t) },
  { process: /^(Feishu|Lark)$/i, category: 'chat', extract: t => trimTitle(t) },
  { process: /^DingTalk$/i, category: 'chat', extract: t => trimTitle(t) },
  { process: /^QQ$/i, category: 'chat', extract: t => trimTitle(t) },

  // 浏览器：提取标签页标题
  {
    process: /^(chrome|msedge|firefox|brave|360se|360chrome|sogouexplorer|qqbrowser|operagx|opera|iexplore|vivaldi|arc)$/i,
    category: 'browser',
    extract: t => trimTitle(stripSuffix(t, BROWSER_SUFFIXES)),
  },

  // Office / WPS / PDF：提取文件名
  { process: /^WINWORD$/i, category: 'document', extract: t => trimTitle(stripSuffix(t, ['Microsoft Word', 'Word'])) },
  { process: /^POWERPNT$/i, category: 'document', extract: t => trimTitle(stripSuffix(t, ['Microsoft PowerPoint', 'PowerPoint'])) },
  { process: /^EXCEL$/i, category: 'document', extract: t => trimTitle(stripSuffix(t, ['Microsoft Excel', 'Excel'])) },
  { process: /^(wps|wpscloudsrv)$/i, category: 'document', extract: t => trimTitle(stripSuffix(t, ['WPS Office', 'WPS文字', 'WPS表格', 'WPS演示'])) },
  { process: /^(et|wpp)$/i, category: 'document', extract: t => trimTitle(stripSuffix(t, ['WPS Office', 'WPS表格', 'WPS演示'])) },
  { process: /^(Acrobat|AcroRd64|FoxitPDFReader|SumatraPDF)$/i, category: 'document', extract: t => trimTitle(t) },
  { process: /^notepad$/i, category: 'document', extract: t => trimTitle(stripSuffix(t, ['记事本', 'Notepad'])) },

  // IDE / 开发：提取项目与文件信息
  {
    process: /^(idea64|idea|pycharm64|pycharm|webstorm64|webstorm|goland64|goland|clion64|clion|rider64|rider|phpstorm64|phpstorm|rubymine64|datagrip64)$/i,
    category: 'dev',
    extract: t => trimTitle(t),
  },
  { process: /^(Code|Qoder|Cursor|Windsurf)$/i, category: 'dev', extract: t => trimTitle(stripSuffix(t, ['Visual Studio Code', 'VS Code', 'Qoder', 'Cursor', 'Windsurf'])) },
  { process: /^(devenv|Code - Insiders)$/i, category: 'dev', extract: t => trimTitle(t) },
  { process: /^(eclipse|studio64)$/i, category: 'dev', extract: t => trimTitle(t) },

  // AI 桌面客户端
  { process: /^(Doubao|Yuanbao|Kimi|Qianwen|WenxinYiyan|Zhipuqingyan)$/i, category: 'ai', extract: t => trimTitle(t) },

  // 会议
  { process: /^(wemeetapp|WeMeet)$/i, category: 'meeting', extract: t => trimTitle(t) },
  { process: /^zoom$/i, category: 'meeting', extract: t => trimTitle(t) },
  { process: /^(Teams|ms-teams)$/i, category: 'meeting', extract: t => trimTitle(t) },

  // 终端
  { process: /^(WindowsTerminal|cmd|conhost|pwsh|powershell|bash|mintty|wezterm-gui|Hyper)$/i, category: 'terminal', extract: t => trimTitle(t) },
]

export class Classifier {
  private readonly customRules: Rule[]

  constructor(custom: readonly CustomClassifyRule[] = []) {
    this.customRules = custom.map(rule => {
      const titleExtract = rule.titleExtract
      return {
        process: new RegExp(rule.process, 'i'),
        category: (rule.category as Category) || 'other',
        extract: titleExtract
          ? (t: string) => {
              const match = new RegExp(titleExtract).exec(t)
              return trimTitle(match?.[1] ?? match?.[0] ?? t)
            }
          : (t: string) => trimTitle(t),
      }
    })
  }

  classify(processName: string, rawTitle: string): Classified {
    for (const rule of this.customRules) {
      if (rule.process.test(processName)) {
        return { category: rule.category, title: rule.extract ? rule.extract(rawTitle) : trimTitle(rawTitle), rawTitle }
      }
    }
    for (const rule of DEFAULT_RULES) {
      if (rule.process.test(processName)) {
        const title = rule.extract ? rule.extract(rawTitle) : trimTitle(rawTitle)
        let category = rule.category
        if (category === 'browser' && AI_TITLE_PATTERN.test(title)) category = 'ai'
        return { category, title, rawTitle }
      }
    }
    return { category: 'other', title: trimTitle(rawTitle) || processName, rawTitle }
  }
}
