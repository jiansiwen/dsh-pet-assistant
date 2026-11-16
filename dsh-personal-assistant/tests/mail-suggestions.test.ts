/**
 * 邮件建议解析的钉子用例。
 *
 * 这一层的存在意义是让"分析一段话"变成"可执行的建议"，所以钉三件事：
 * 1. 模型不按格式回时，**整段当摘要**，不把"这封邮件要处理"这个结论一起丢掉；
 * 2. 单条非法只丢那一条，其余仍然可用；
 * 3. `kind` / `risk` 是白名单——模型编一个新类型，我们不能假装认识。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_SUGGESTIONS, normalizeSuggestion, parseMailAnalysis } from '../src/mail-suggestions.ts'

void test('解析：规范 JSON（围栏里）', () => {
  const reply = [
    '分析完成。',
    '```json',
    JSON.stringify({
      summary: '3 封新邮件：1 封要改生产数据，2 封通知。',
      suggestions: [
        { uid: 42, kind: 'draft-sql', title: '改生产库某字段', payload: 'UPDATE t SET c=1 WHERE id=9;', risk: 'high', rationale: '邮件要求手工改数据' },
        { uid: 43, kind: 'none', title: '服务通知', payload: '', risk: 'low', rationale: '例行通知' },
      ],
    }),
    '```',
  ].join('\n')
  const parsed = parseMailAnalysis(reply)
  assert.equal(parsed.structured, true)
  assert.equal(parsed.suggestions.length, 2)
  assert.equal(parsed.suggestions[0].kind, 'draft-sql')
  assert.equal(parsed.suggestions[0].uid, 42)
  assert.match(parsed.suggestions[0].payload, /UPDATE/u)
  assert.equal(parsed.suggestions[1].kind, 'none', '不需要处理也是一条合法建议')
  assert.match(parsed.summary, /3 封新邮件/u)
})

void test('解析：干脆不合格式时，整段当摘要（不丢结论）', () => {
  const parsed = parseMailAnalysis('第一封是告警，第二封要你改数据，都在等回复。')
  assert.equal(parsed.structured, false)
  assert.equal(parsed.suggestions.length, 0)
  assert.match(parsed.summary, /要你改数据/u)
})

void test('解析：JSON 前后带说明也能取到', () => {
  const parsed = parseMailAnalysis(`好的，结果如下：{"summary":"两封","suggestions":[{"kind":"reply-mail","title":"回复确认","payload":"收到，今天处理。","risk":"low"}]} 以上。`)
  assert.equal(parsed.structured, true)
  assert.equal(parsed.suggestions.length, 1)
  assert.equal(parsed.suggestions[0].kind, 'reply-mail')
})

void test('解析：单条非法只丢那一条', () => {
  const parsed = parseMailAnalysis(JSON.stringify({
    summary: '混合情况',
    suggestions: [
      { kind: 'draft-sql', title: '好的', payload: 'SELECT 1;', risk: 'high' },
      { kind: 'invented-kind', title: '编出来的类型', payload: 'x' },
      { kind: 'open-ticket', title: '', payload: 'x' },
      { kind: 'reply-mail', title: '缺正文', payload: '' },
      { kind: 'manual-step', title: '你去后台看一下', payload: '' },
    ],
  }))
  assert.equal(parsed.structured, true)
  assert.deepEqual(parsed.suggestions.map(item => item.kind), ['draft-sql', 'manual-step'],
    '非法 kind、空标题、缺 payload 的都要丢；manual-step 允许没有 payload')
})

void test('解析：数量有上限，不会一次生成一屏建议', () => {
  const many = Array.from({ length: MAX_SUGGESTIONS + 5 }, (_, index) => ({
    kind: 'manual-step', title: `第 ${index} 条`, payload: '',
  }))
  const parsed = parseMailAnalysis(JSON.stringify({ summary: '很多', suggestions: many }))
  assert.equal(parsed.suggestions.length, MAX_SUGGESTIONS)
})

void test('归一：risk 缺省是 medium，未知 risk 也退到 medium', () => {
  const a = normalizeSuggestion({ kind: 'reply-mail', title: '回复', payload: '好的' })
  const b = normalizeSuggestion({ kind: 'reply-mail', title: '回复', payload: '好的', risk: 'catastrophic' })
  assert.equal(a?.risk, 'medium')
  assert.equal(b?.risk, 'medium')
})

void test('解析：空回复得到空摘要而不是抛错', () => {
  const parsed = parseMailAnalysis('')
  assert.equal(parsed.structured, false)
  assert.equal(parsed.summary, '')
  assert.deepEqual(parsed.suggestions, [])
})
