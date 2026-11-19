import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampMaxChars, htmlToText, isBlockedWebHost, safeWebFetch, WEB_FETCH_DEFAULT_CHARS, WEB_FETCH_MAX_CHARS, type FetchLike } from '../src/member-web.ts'

test('isBlockedWebHost：本机/内网/链路本地/特殊域拒绝，公开域放行', () => {
  for (const host of ['localhost', '127.0.0.1', '127.5.5.5', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.169.254', '[::1]', '0.0.0.0', 'foo.local', 'bar.internal']) {
    assert.equal(isBlockedWebHost(host), true, host)
  }
  for (const host of ['github.com', 'api.github.com', 'example.com', '172.32.0.1', '8.8.8.8']) {
    assert.equal(isBlockedWebHost(host), false, host)
  }
})

test('clampMaxChars：缺省/上限/非法值', () => {
  assert.equal(clampMaxChars(undefined), WEB_FETCH_DEFAULT_CHARS)
  assert.equal(clampMaxChars(0), WEB_FETCH_DEFAULT_CHARS)
  assert.equal(clampMaxChars(-5), WEB_FETCH_DEFAULT_CHARS)
  assert.equal(clampMaxChars(500), 500)
  assert.equal(clampMaxChars(999_999), WEB_FETCH_MAX_CHARS)
})

test('htmlToText：去脚本样式标签、解实体、压空白；JSON 原样', () => {
  const html = '<html><head><style>a{color:red}</style><script>evil()</script></head><body><h1>标题</h1><p>你好&nbsp;世界 &amp; 朋友</p><p>第二段</p></body></html>'
  const text = htmlToText(html, 'text/html; charset=utf-8')
  assert.match(text, /标题/)
  assert.match(text, /你好 世界 & 朋友/)
  assert.doesNotMatch(text, /evil/)
  assert.doesNotMatch(text, /color:red/)
  assert.doesNotMatch(text, /<[^>]+>/)
  const json = '{"items":[{"name":"repo-a"}]}'
  assert.equal(htmlToText(json, 'application/json'), json)
})

function fakeFetch(body: string, contentType: string, status = 200): FetchLike {
  return async () => ({ status, headers: { get: (n: string) => n.toLowerCase() === 'content-type' ? contentType : null },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer })
}

const signal = new AbortController().signal

test('safeWebFetch：非法/非https/内网 → 拒绝', async () => {
  assert.equal((await safeWebFetch('not a url', undefined, signal, fakeFetch('', 'text/html'))).ok, false)
  assert.match((await safeWebFetch('http://example.com', undefined, signal, fakeFetch('', 'text/html'))).error!, /https/)
  assert.match((await safeWebFetch('https://127.0.0.1/x', undefined, signal, fakeFetch('', 'text/html'))).error!, /内网/)
  assert.match((await safeWebFetch('https://localhost/x', undefined, signal, fakeFetch('', 'text/html'))).error!, /内网/)
})

test('safeWebFetch：HTML 清洗 + 截断', async () => {
  const res = await safeWebFetch('https://example.com', 20, signal, fakeFetch('<p>abcdefghij</p><p>klmnopqrst</p>', 'text/html'))
  assert.equal(res.ok, true)
  assert.equal(res.status, 200)
  assert.ok(res.text!.length <= 20)
  assert.doesNotMatch(res.text!, /<p>/)
})

test('safeWebFetch：JSON 原样返回', async () => {
  const json = '{"total_count":1,"items":[{"full_name":"a/b"}]}'
  const res = await safeWebFetch('https://api.github.com/search/repositories', undefined, signal, fakeFetch(json, 'application/json'))
  assert.equal(res.ok, true)
  assert.equal(res.text, json)
})

test('safeWebFetch：fetch 抛错 → 如实失败', async () => {
  const failing: FetchLike = async () => { throw new Error('fetch failed') }
  const res = await safeWebFetch('https://example.com', undefined, signal, failing)
  assert.equal(res.ok, false)
  assert.match(res.error!, /fetch failed/)
})