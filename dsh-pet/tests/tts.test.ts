/**
 * 播放驱动器的测试：用假传输跑完整条链路，不出声、不拉 PowerShell。
 *
 * 钉住的是三件在真机上只会表现为"用户觉得不对劲"的事 ——
 * 合成进程一次只吃一句（塞第二句它会拒，拒了那句就丢了）、打断必须立刻落到管道上、
 * 以及**报不回来的句子只能算半句**（说它播完了，就是替用户编造一段他没听过的话）。
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { Narrator, type TtsTransport, type TtsWorkerEvent } from '../src/main/tts.ts'

class FakeTransport implements TtsTransport {
  readonly lines: string[] = []
  closeCount = 0

  write(line: string): void {
    this.lines.push(line)
  }

  close(): void {
    this.closeCount++
  }

  /** 管道上实际写出去的讲话命令，文本已从 base64 UTF-8 还原。 */
  get speaks(): { id: string; text: string }[] {
    const result: { id: string; text: string }[] = []
    for (const line of this.lines) {
      const command = JSON.parse(line) as { speak?: { id: string; b64: string } }
      if (command.speak === undefined) continue
      result.push({
        id: command.speak.id,
        text: Buffer.from(command.speak.b64, 'base64').toString('utf8'),
      })
    }
    return result
  }

  get stopCount(): number {
    return this.lines.filter((line) => line === '{"stop":{}}').length
  }
}

interface Harness {
  readonly narrator: Narrator
  readonly transport: FakeTransport
  /** 把合成进程的事件喂回驱动器。合成进程被拉起之后才有真的落点。 */
  readonly deliver: (event: TtsWorkerEvent) => void
  readonly calls: {
    /** 拉起了几次合成进程。常驻的话应当一直是 1。 */
    opened: number
    cancelGeneration: number
    taskCancel: number
  }
  readonly speaking: boolean[]
  readonly errors: string[]
  readonly voices: string[]
}

function makeHarness(): Harness {
  const transport = new FakeTransport()
  const calls = { opened: 0, cancelGeneration: 0, taskCancel: 0 }
  const speaking: boolean[] = []
  const errors: string[] = []
  const voices: string[] = []

  // 初值抛错是有意的：测试在合成进程被拉起之前就喂事件，说明它验的不是自己想验的那条路径，
  // 静默忽略会让这种测试看起来是过的。
  let deliver: (event: TtsWorkerEvent) => void = () => {
    throw new Error('合成进程还没被拉起来，没有事件可喂')
  }

  const narrator = new Narrator(
    (workerDeliver) => {
      calls.opened++
      deliver = workerDeliver
      return transport
    },
    {
      onSpeaking: value => speaking.push(value),
      onError: reason => errors.push(reason),
      onVoice: voice => voices.push(voice),
      onCancelGeneration: () => calls.cancelGeneration++,
      onRequestTaskCancel: () => calls.taskCancel++,
    },
  )

  return { narrator, transport, deliver: event => deliver(event), calls, speaking, errors, voices }
}

const ready: TtsWorkerEvent = { ready: true, voice: 'Microsoft Huihui Desktop' }
const finished = (id: string): TtsWorkerEvent => ({ finished: { id } })
const cancelled = (id: string): TtsWorkerEvent => ({ cancelled: { id } })

test('从实际播完的句子之后续讲，保留原句编号', () => {
  const h = makeHarness()
  const request = { utteranceId: 'resume', text: '第一句。第二句。第三句。' }
  h.narrator.speak(request)
  h.deliver(ready)
  h.deliver(finished('resume#0'))
  h.narrator.interrupt('drop-queue')
  h.deliver(cancelled('resume#1'))
  assert.equal(h.narrator.resumeFrom('resume'), 1)
  h.narrator.speak({ ...request, fromIndex: h.narrator.resumeFrom('resume') })
  assert.deepEqual(h.transport.speaks.at(-1), { id: 'resume#1', text: '第二句。' })
})

test('未主动停止却收到取消属于播放失败，不自动继续下一句', () => {
  const h = makeHarness()
  h.narrator.speak({ utteranceId: 'failed', text: '第一句。第二句。' })
  h.deliver(ready)
  h.deliver(cancelled('failed#0'))
  assert.equal(h.errors.length, 1)
  assert.equal(h.transport.speaks.length, 1)
  assert.equal(h.narrator.isSpeaking(), false)
  assert.equal(h.transport.closeCount, 1)
})

test('只有完成回执才记录播出，进度先更新再通知播放结束', () => {
  const events: string[] = []
  let deliver!: (event: TtsWorkerEvent) => void
  const transport = new FakeTransport()
  const narrator = new Narrator(callback => { deliver = callback; return transport }, {
    onSpoken: record => events.push(`record:${record.segment.index}:${record.complete}`),
    onSpeaking: value => events.push(`speaking:${value}`),
  })
  narrator.speak({ utteranceId: 'progress', text: '这一句。' })
  deliver(ready)
  assert.deepEqual(events, ['speaking:true'])
  deliver(finished('progress#0'))
  assert.deepEqual(events, ['speaking:true', 'record:0:true', 'speaking:false'])
})

describe('一次只交给合成进程一句', () => {
  test('进程没就绪就先不派句子，就绪事件到了才派', () => {
    const h = makeHarness()
    h.narrator.speak({ utteranceId: 'u1', text: '第一句。第二句。' })
    assert.equal(h.transport.speaks.length, 0, '还没握手就往管道里写，写进去的会卡在缓冲区里没人读')
    h.deliver(ready)
    assert.deepEqual(h.voices, ['Microsoft Huihui Desktop'])
    assert.deepEqual(
      h.transport.speaks.map((item) => item.text),
      ['第一句。'],
    )
  })

  test('上一句报 finished 之前不派下一句', () => {
    const h = makeHarness()
    h.narrator.speak({ utteranceId: 'u1', text: '第一句。第二句。第三句。' })
    h.deliver(ready)
    assert.equal(h.transport.speaks.length, 1)
    h.deliver({ started: { id: 'u1#0' } })
    assert.equal(h.transport.speaks.length, 1, 'started 只是回声，不是可以派下一句的信号')
    h.deliver(finished('u1#0'))
    assert.deepEqual(
      h.transport.speaks.map((item) => item.text),
      ['第一句。', '第二句。'],
    )
  })

  test('中文经 base64 UTF-8 原样送达，id 带上文档序号', () => {
    const h = makeHarness()
    h.narrator.speak({ utteranceId: 'doc-7', text: '麦克风只有一个主人。' })
    h.deliver(ready)
    const [first] = h.transport.speaks
    assert.equal(first.text, '麦克风只有一个主人。', '控制台编码一变，念出来就是一串乱码')
    assert.equal(first.id, 'doc-7#0')
  })

  test('合成进程常驻：只在第一次要出声时拉起，之后不再拉', () => {
    const h = makeHarness()
    assert.equal(h.calls.opened, 0, '没用上语音的用户不该为半个 PowerShell 进程买单')
    h.narrator.speak({ utteranceId: 'u1', text: '第一段。' })
    assert.equal(h.calls.opened, 1)
    h.deliver(ready)
    h.deliver(finished('u1#0'))
    h.narrator.speak({ utteranceId: 'u2', text: '第二段。' })
    assert.equal(h.calls.opened, 1, '一句一个进程，句与句之间就是一道听得见的停顿')
    assert.deepEqual(
      h.transport.speaks.map((item) => item.text),
      ['第一段。', '第二段。'],
    )
  })
})

describe('边收边合成（流式朗读）', () => {
  test('第一句一凑齐就派出去，不必等整段回答', () => {
    const h = makeHarness()
    h.narrator.feed('u1', '你好，今天')
    assert.equal(h.calls.opened, 0, '半句不值得为它拉起合成进程')
    h.narrator.feed('u1', '做了三件事。')
    h.deliver(ready)
    assert.deepEqual(
      h.transport.speaks.map((item) => item.text),
      ['你好，今天做了三件事。'],
    )
    assert.equal(h.transport.speaks[0].id, 'u1#0')
  })

  test('feedEnd 把最后没标点的一截也念完，序号接着上一句', () => {
    const h = makeHarness()
    h.narrator.feed('u1', '开头有标点。尾部还没说完')
    h.deliver(ready)
    h.narrator.feedEnd('u1')
    assert.deepEqual(h.transport.speaks.map((item) => item.text), ['开头有标点。'], '一次只派一句，尾句在队列里等')
    h.deliver(finished('u1#0'))
    assert.deepEqual(
      h.transport.speaks.map((item) => item.text),
      ['开头有标点。', '尾部还没说完'],
    )
    assert.deepEqual(h.transport.speaks.map((item) => item.id), ['u1#0', 'u1#1'], '两次之间序号要接得上')
  })

  test('多段喂入的句子按到达顺序排队，不重新编号', () => {
    const h = makeHarness()
    h.narrator.feed('u1', '第一句。')
    h.narrator.feed('u1', '第二句。')
    h.deliver(ready)
    assert.deepEqual(h.transport.speaks.map((item) => item.id), ['u1#0'])
    h.deliver(finished('u1#0'))
    assert.deepEqual(h.transport.speaks.map((item) => item.id), ['u1#0', 'u1#1'])
  })

  test('打断后丢掉缓冲：残留的半句不会被补念出去', () => {
    const h = makeHarness()
    h.narrator.feed('u1', '只说到一半没有标点')
    h.narrator.dropFeed('u1')
    h.narrator.feedEnd('u1')
    assert.equal(h.transport.speaks.length, 0)
  })

  test('没喂过任何增量的轮次不受影响，整段朗读照常', () => {
    const h = makeHarness()
    h.narrator.feedEnd('u9')
    h.narrator.speak({ utteranceId: 'u9', text: '整段回答。' })
    h.deliver(ready)
    assert.deepEqual(
      h.transport.speaks.map((item) => item.text),
      ['整段回答。'],
      '宿主不吐增量时要能退回整段朗读',
    )
  })
})

describe('自定义 TTS 服务的派发', () => {
  test('选了自定义服务，配置随这一句传进 worker；没选就不带这个字段', () => {
    const transport = new FakeTransport()
    const api = {
      id: 'p1', kind: 'tts' as const, name: '我的服务', endpoint: 'https://example.com/v1',
      model: 'tts-1', voice: 'alloy', apiKey: 'sk-test', provider: 'openai' as const,
    }
    let deliver: (event: TtsWorkerEvent) => void = () => { throw new Error('worker 未就绪') }
    const narrator = new Narrator(
      (onEvent) => { deliver = onEvent; return transport },
      {},
      { ttsApi: () => api },
    )
    narrator.speak({ utteranceId: 'u1', text: '第一句。' })
    deliver(ready)
    const command = JSON.parse(transport.lines[0]) as { speak?: { api?: unknown } }
    assert.deepEqual(command.speak?.api, api, '配置要随句子下发，用户中途换服务下一句就走新的')

    const plain = new FakeTransport()
    const plainNarrator = new Narrator(() => plain, {})
    plainNarrator.speak({ utteranceId: 'u1', text: '第一句。' })
    const plainCommand = JSON.parse(plain.lines.find(line => line.startsWith('{"speak"')) ?? '{"speak":{}}') as { speak?: Record<string, unknown> }
    assert.equal('api' in (plainCommand.speak ?? {}), false, '没选服务就不带配置字段')
  })

  test('配置读不出来要如实停，不悄悄退回默认服务', () => {
    const transport = new FakeTransport()
    const errors: string[] = []
    let deliver: (event: TtsWorkerEvent) => void = () => { throw new Error('worker 未就绪') }
    const narrator = new Narrator(
      (onEvent) => { deliver = onEvent; return transport },
      { onError: reason => errors.push(reason) },
      { ttsApi: () => { throw new Error('密钥解不开') } },
    )
    narrator.speak({ utteranceId: 'u1', text: '第一句。' })
    deliver(ready)
    assert.deepEqual(errors, ['密钥解不开'])
    assert.equal(transport.speaks.length, 0, '一句都不该派出去')
    assert.equal(narrator.isSpeaking(), false)
  })
})

describe('打断', () => {
  test('第二层：立刻写 stop、丢掉队列、当前这句记成半句', () => {
    const h = makeHarness()
    h.narrator.speak({ utteranceId: 'u1', text: '第一句。第二句。第三句。' })
    h.deliver(ready)
    assert.equal(h.transport.speaks.length, 1)
    h.narrator.interrupt('drop-queue')
    assert.equal(h.transport.stopCount, 1)
    h.deliver(cancelled('u1#0'))
    assert.equal(h.transport.speaks.length, 1, '队列丢了，就不该有下一句被派出去')
    assert.equal(h.narrator.isSpeaking(), false)
    const context = h.narrator.interruptedContext()
    assert.ok(context !== null)
    assert.match(context, /只播出一半就被打断：第一句。/)
    assert.doesNotMatch(context, /已完整播出/, '一句都没播完，不该出现"已完整播出"')
  })

  test('第一层只掐当前这句，等合成进程报停了才接着播下一句', () => {
    const h = makeHarness()
    h.narrator.speak({ utteranceId: 'u1', text: '第一句。第二句。' })
    h.deliver(ready)
    h.narrator.interrupt('stop-playback')
    assert.equal(h.transport.stopCount, 1)
    assert.equal(
      h.transport.speaks.length,
      1,
      '合成进程真的停下来之前手上还挂着上一句，这时候塞新句子它会报 busy，报 busy 的这句就丢了',
    )
    h.deliver(cancelled('u1#0'))
    assert.deepEqual(
      h.transport.speaks.map((item) => item.text),
      ['第一句。', '第二句。'],
      '第一层的语义是"跳过这句"，界面上的"停止讲解"必须走第二层',
    )
  })

  test('第三层取消还在生成的回答，钩子只调一次', () => {
    const h = makeHarness()
    h.narrator.generationStarted()
    h.narrator.interrupt('cancel-generation')
    assert.equal(h.calls.cancelGeneration, 1)
    h.narrator.interrupt('cancel-generation')
    assert.equal(h.calls.cancelGeneration, 1, '回答已经不在生成了，第二次没什么可取消的')
  })

  test('第四层申请取消任务，反复按也只申请一次', () => {
    const h = makeHarness()
    h.narrator.interrupt('cancel-task')
    h.narrator.interrupt('cancel-task')
    assert.equal(h.calls.taskCancel, 1, '反复申请只会让用户被同一个确认框问好几遍')
  })
})

describe('合成进程不可用', () => {
  test('起不来时：报错、丢队列、正在播的那句算半句', () => {
    const h = makeHarness()
    h.narrator.speak({ utteranceId: 'u1', text: '第一句。第二句。' })
    h.deliver(ready)
    h.deliver({ ok: false, error: 'no-voice' })
    assert.deepEqual(h.errors, ['no-voice'])
    assert.equal(h.narrator.isSpeaking(), false)
    const context = h.narrator.interruptedContext()
    assert.ok(context !== null)
    assert.match(context, /只播出一半/, '进程没了，那句到底出没出声谁也不知道')
  })

  test('半路没了等同于失败，不当成正常播完', () => {
    const h = makeHarness()
    h.narrator.speak({ utteranceId: 'u1', text: '只有一句。' })
    h.deliver(ready)
    h.deliver({ ok: false, error: 'worker-exited' })
    assert.deepEqual(h.errors, ['worker-exited'])
    assert.doesNotMatch(h.narrator.interruptedContext() ?? '', /已完整播出/)
  })

  test('失败之后下一次讲话会重新拉起进程', () => {
    const h = makeHarness()
    h.narrator.speak({ utteranceId: 'u1', text: '第一句。' })
    h.deliver({ ok: false, error: 'init-failed' })
    assert.equal(h.calls.opened, 1)
    h.narrator.speak({ utteranceId: 'u2', text: '再来一次。' })
    assert.equal(h.calls.opened, 2, '一次失败不该把讲解永久关掉，用户修好声音之后得能接着用')
    h.deliver(ready)
    assert.deepEqual(
      h.transport.speaks.map((item) => item.text),
      ['再来一次。'],
      '失败那次的句子不该被补播出来')
  })

  test('报 busy 只记一条错，不丢队列也不重播', () => {
    const h = makeHarness()
    h.narrator.speak({ utteranceId: 'u1', text: '第一句。第二句。' })
    h.deliver(ready)
    h.deliver({ ok: false, error: 'busy' })
    assert.equal(h.errors.length, 1)
    assert.equal(h.narrator.isSpeaking(), true, '一次一句是由驱动器把住的，失步了也不能把队列扔掉')
  })
})

describe('轮次', () => {
  test('一句都没播出去时返回 null，不塞占位文案给模型', () => {
    const h = makeHarness()
    h.narrator.speak({ utteranceId: 'u1', text: '第一句。第二句。' })
    h.narrator.interrupt('drop-queue')
    assert.equal(h.narrator.interruptedContext(), null, '进程都还没就绪，一个字都没出声，没什么可交代的')
  })

  test('beginRound 之后上一轮的播出记录不再混进来', () => {
    const h = makeHarness()
    h.narrator.speak({ utteranceId: 'r1', text: '甲一。甲二。' })
    h.deliver(ready)
    h.deliver(finished('r1#0'))
    h.deliver(finished('r1#1'))

    h.narrator.beginRound()
    h.narrator.speak({ utteranceId: 'r2', text: '乙一。乙二。' })
    h.deliver(finished('r2#0'))
    h.narrator.interrupt('drop-queue')

    const context = h.narrator.interruptedContext()
    assert.ok(context !== null)
    assert.match(context, /已完整播出：乙一。/)
    assert.match(context, /只播出一半就被打断：乙二。/)
    assert.doesNotMatch(context, /甲/, '把上一轮整段回答也塞进来，模型就分不清被打断的是哪一段了')
  })
})

describe('播出位置', () => {
  test('续讲接在最后一个完整句子之后', () => {
    const h = makeHarness()
    h.narrator.speak({ utteranceId: 'doc', text: '第一段。第二段。第三段。' })
    h.deliver(ready)
    h.deliver(finished('doc#0'))
    h.deliver(finished('doc#1'))
    assert.equal(h.narrator.resumeFrom('doc'), 2)
    h.narrator.interrupt('drop-queue')
    h.deliver(cancelled('doc#2'))
    assert.equal(h.narrator.resumeFrom('doc'), 2, '被打断的那段不算播过，续讲要从它重新开始')
  })

  test('没播过的文档从头开始', () => {
    const h = makeHarness()
    h.narrator.speak({ utteranceId: 'a', text: '甲。' })
    h.deliver(ready)
    h.deliver(finished('a#0'))
    assert.equal(h.narrator.resumeFrom('b'), 0)
  })
})

describe('收尾', () => {
  test('dispose 关掉传输，之后的 speak 不再拉起进程', () => {
    const h = makeHarness()
    h.narrator.speak({ utteranceId: 'u1', text: '一句。' })
    h.deliver(ready)
    h.narrator.dispose()
    assert.equal(h.transport.closeCount, 1)
    assert.deepEqual(h.speaking, [true, false], '关掉的时候得把"正在讲解"收回去，否则界面一直转')
    h.narrator.speak({ utteranceId: 'u2', text: '再说一句。' })
    assert.equal(h.calls.opened, 1, '退出之后又拉起一个合成进程，就是一个杀不掉的孤儿')
  })

  test('onSpeaking 只在状态真的变化时报', () => {
    const h = makeHarness()
    h.narrator.speak({ utteranceId: 'u1', text: '第一句。第二句。' })
    h.deliver(ready)
    h.deliver(finished('u1#0'))
    h.deliver(finished('u1#1'))
    assert.deepEqual(h.speaking, [true, false], '句与句之间的交接不该让界面闪一下')
  })
})
