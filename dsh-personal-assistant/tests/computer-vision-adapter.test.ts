/** 真实 Cordis/LLM 路由与合成适配器，不读取屏幕、用户附件或外部网络。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AssistantApprovalService } from '../src/assistant-approval.ts'
import { registerComputerTools } from '../src/computer.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6t2wAAAAASUVORK5CYII='
const target = { windowId: '123', pid: 1234, processPath: 'C:\\Apps\\editor.exe', processStartedAt: '1000',
  className: 'EditorWindow', title: '模拟窗口', left: 0, top: 0, width: 1, height: 1 }
const screen = { left: 0, top: 0, width: 1, height: 1,
  displays: [{ name: '\\\\.\\DISPLAY1', left: 0, top: 0, width: 1, height: 1, primary: true }] }

test('真实宿主一次性模型调用与服务代理可用；适配器替换后旧批准立即失效', async t => {
  const root = new Context(), calls: GenerateOptions[] = []
  t.after(() => root.fiber.dispose())
  await root.plugin(LlmRuntime)
  class SyntheticAdapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] as const }
    }
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(request)
      yield { type: 'text-delta', index: 0, text: '合成画面没有真实用户信息' }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  let replace!: (providers: string[]) => void
  await root.plugin(ctx => {
    ctx.provide('attachments', {
      imageLimits: { maxImageBytes: 1_000_000, maxImagesPerMessage: 1, maxMessageImageBytes: 1_000_000,
        maxImagePixels: 1000, maxImageDimension: 1000, mediaTypes: ['image/png'] },
      saveImage: async ({ data }: { data: Uint8Array }) => ({ attachmentId: 'a'.repeat(64), mediaType: 'image/png', bytes: data.length, width: 1, height: 1 }),
    })
    const registration = ctx.get('llm').registerAdapter(['synthetic'], new SyntheticAdapter())
    replace = providers => registration.replace(providers)
  })
  assert.notEqual(root.get('llm'), root.get('llm'), '宿主每次可能生成新代理，不能直接比较引用')
  const agentContext = root.extend({})
  const agent = { id: 'desktop', session: { id: 'desktop', header: { id: 'desktop', version: 4, isSeeded: false } },
    options: { provider: 'synthetic', model: 'test-vision' }, ctx: agentContext }
  const approvals = new AssistantApprovalService({ epoch: 'test', ttlMs: 120_000 })
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  const bridge = { desktopBinding: (value: unknown) => value === agent ? 'binding' : null,
    submitAssistant: (submission: any) => approvals.submit(submission), invalidateAssistantApprovals: (subject: string) => approvals.invalidateAll(subject) }
  const run = async (_script: string, payload: Record<string, unknown>) => payload.action === 'snapshot'
    ? { ok: true, target, screen } : { ok: true, target, screen, pngBase64: png }
  const dispose = registerComputerTools({ tools: { register: (tool: any) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } },
    { bridge: bridge as never, scriptDir: 'C:\\fake', shotDir: 'C:\\fake', approvalMode: () => 'manual', log: () => {}, run, platform: 'win32' })
  t.after(dispose)
  const exec = { agent, signal: new AbortController().signal }
  const look = async (args: unknown) => JSON.parse(await tools.get('personal_assistant_computer_look')!.execute(args, exec))
  const approve = (id: string) => approvals.decide(id, 'approve', 'test', approvals.approvalCapabilityToken)

  const pending = await look({ screenshot: true, question: '请观察合成画面' })
  assert.equal(pending.pending, true, JSON.stringify(pending))
  assert.equal((await approve(pending.proposalId)).ok, true)
  const result = await look({ targetId: pending.targetId })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].messages[0].role, 'user')
  assert.equal(calls[0].messages[0].content[1].type, 'image')
  assert.deepEqual(calls[0].tools, [])
  assert.equal(calls[0].maxTokens, 1024)

  const next = await look({ screenshot: true, question: '重新观察' })
  assert.equal((await approve(next.proposalId)).ok, true)
  replace(['synthetic'])
  assert.equal((await look({ targetId: next.targetId })).ok, false)
  assert.equal(calls.length, 1, '模型适配器换代后不再调用')
})
