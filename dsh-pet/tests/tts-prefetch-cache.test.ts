/**
 * 前瞻缓存的回收规则：**只丢离开窗口的，别把自己刚合成好的扔掉**。
 *
 * 事故：每派发一句就无条件清空缓存（只留当前句），于是后面两句刚合成好的音频
 * 白做，等到要播时又得重新请求一次 —— 听感就是"一到下一句还是卡"。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TtsEdgeEngine } from '../src/main/tts-edge-worker.ts'

function makeEngine() {
  const synthesized: string[] = []
  const engine = new TtsEdgeEngine({
    synthesize: async (text: string) => { synthesized.push(text); return Buffer.from('audio') },
    play: async () => {},
    fallback: async () => {},
    stopAudio: async () => {},
    emit: () => {},
  })
  return { engine, synthesized }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

void test('已预合成的下一句，在派发当前句之后不该被丢掉重做', async () => {
  const { engine, synthesized } = makeEngine()
  /* 第一句 + 前瞻两句：两句都会被预合成。 */
  engine.speak('u#0', '第一句。', undefined, [
    { id: 'u#1', text: '第二句。' },
    { id: 'u#2', text: '第三句。' },
  ])
  await flush()
  const afterFirst = synthesized.length
  assert.ok(afterFirst >= 2, `预合成没跑起来：${synthesized.join('|')}`)

  /* 派发第二句，前瞻窗口前移：第二句本身不该再请求一次合成。 */
  engine.speak('u#1', '第二句。', undefined, [
    { id: 'u#2', text: '第三句。' },
    { id: 'u#3', text: '第四句。' },
  ])
  await flush()
  const secondRound = synthesized.filter(text => text === '第二句。').length
  assert.equal(secondRound, 1, '第二句被重复合成了，说明缓存被误清空')
})
