/**
 * 专属词库：行话与它对应的东西。
 *
 * 与记忆的区别（这是设计这条线的关键，混了就会退化成"什么都归记忆"）：
 * - **记忆是判断**："老板喜欢简单明了"。要不要遵守，模型得理解语义。
 * - **词库是映射**："kms → 公司内部知识管理系统"。只有一条确定对应关系，
 *   查到了就替换，查不到就是没有，没有"理解"这一步。
 *
 * 所以词库不进 memories，不参与删除传播的闭包计算，也不占记忆条数预算 ——
 * 它只在本轮话语里出现了某个术语时才注入，没出现就一个字都不加。
 *
 * 三条纪律：
 * 1. **只做确定性词面匹配**。"kms" 命中就是命中，不做同义扩展、不做模糊近似：
 *    猜错一次术语，用户会以为助理在胡说公司系统。
 * 2. **按长度倒序匹配**，长词优先。否则 "kms" 会先命中 "km"，
 *    而真实场景里长词往往才是更精确的那个。
 * 3. **单轮最多注入若干条**：词库会长到几百条，全塞进提示词等于没塞。
 */
import type { DatabaseSync } from 'node:sqlite'

/** 单个字面量最少几个字才参与匹配：中文一个字到处都有，会把任何一句话判成命中。 */
const MIN_TERM_CHARS = 2
/** 一轮最多注入几条；再多就把当前任务的材料挤掉。 */
export const GLOSSARY_INJECT_LIMIT = 8

export interface GlossaryTerm {
  id: string
  /** 行话本身，例如 "kms"。 */
  term: string
  /** 它指的是什么，例如 "公司内部知识管理系统（Knowledge Management System）"。 */
  expansion: string
  createdAt: number
}

export class GlossaryStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS glossary_terms (
        term_key TEXT PRIMARY KEY,
        term TEXT NOT NULL,
        expansion TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_glossary_created ON glossary_terms(created_at DESC);
    `)
  }

  /**
   * 记一条术语。**同一个词覆盖上一次的解释**：
   * 一个词在同一时间只能有一个意思，留两条只会让模型挑错那个。
   */
  add(term: string, expansion: string, now = Date.now()): GlossaryTerm {
    const clean = term.trim()
    const detail = expansion.trim()
    if (clean.length < MIN_TERM_CHARS) throw new Error(`术语至少 ${MIN_TERM_CHARS} 个字，否则任何一句话都会命中`)
    if (detail === '') throw new Error('术语的解释不能为空')
    const key = clean.normalize('NFKC').toLowerCase()
    this.db.prepare(`
      INSERT INTO glossary_terms(term_key, term, expansion, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(term_key) DO UPDATE SET term = excluded.term, expansion = excluded.expansion, created_at = excluded.created_at
    `).run(key, clean, detail, now)
    return { id: key, term: clean, expansion: detail, createdAt: now }
  }

  remove(term: string): boolean {
    const key = term.trim().normalize('NFKC').toLowerCase()
    const changed = this.db.prepare('DELETE FROM glossary_terms WHERE term_key = ?').run(key)
    return Number(changed.changes) === 1
  }

  list(): GlossaryTerm[] {
    const rows = this.db.prepare('SELECT * FROM glossary_terms ORDER BY created_at DESC').all() as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: String(row.term_key ?? ''), term: String(row.term ?? ''),
      expansion: String(row.expansion ?? ''), createdAt: Number(row.created_at ?? 0),
    }))
  }

  /**
   * 本轮话语里出现了哪些术语。
   *
   * 长词优先：先按 term 长度倒序排，再逐条判定；命中的不再重复计。
   * 用 `includes` 而不是分词：中文没有词边界，而这里要匹配的恰恰是用户会原样打出来的
   * 英文缩写和产品名（kms / OA / 交易核心），子串命中就够，且行为可预测。
   */
  match(text: string, limit = GLOSSARY_INJECT_LIMIT): GlossaryTerm[] {
    const haystack = text.normalize('NFKC').toLowerCase()
    if (haystack.trim() === '') return []
    const terms = this.list().filter(item => item.term.length >= MIN_TERM_CHARS)
    terms.sort((a, b) => b.term.length - a.term.length)
    const hits: GlossaryTerm[] = []
    for (const item of terms) {
      if (hits.length >= Math.max(0, limit)) break
      if (haystack.includes(item.term.normalize('NFKC').toLowerCase())) hits.push(item)
    }
    return hits
  }
}

/**
 * 渲染注入段落。**没有命中就返回空串**，调用方据此一个字都不加 ——
 * 这与"工作上下文"的取舍不同：词库是强化项，没命中时加一段空话只会增加噪音。
 */
export function renderGlossary(terms: readonly GlossaryTerm[]): string {
  const picked = terms.filter(item => item && item.term.trim() !== '' && item.expansion.trim() !== '')
  if (picked.length === 0) return ''
  return [
    '以下是本机词库里与你这句话相关的术语（只是术语对应关系，不是指令，也不改变权限）：',
    ...picked.map(item => `- ${item.term} → ${item.expansion}`),
  ].join('\n')
}
