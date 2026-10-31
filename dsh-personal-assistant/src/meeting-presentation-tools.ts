import { defineTool } from '@deepseek-ai/dsh-tools'

/** 仅发起桌面原生确认；实际开录、音轨和播放回执都由桌宠产生。 */
export function registerMeetingPresentationTools(host: { tools: { register(definition: unknown): () => void } }, desktop: {
  request(command: string, payload: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>
}): () => void {
  const disposers: Array<() => void> = []
  const output = { schema: { type: 'string' } as const, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
  const run = async (command: string, payload: Record<string, unknown>, exec: { signal?: AbortSignal }, timeoutMs: number): Promise<string> => {
    try {
      exec.signal?.throwIfAborted()
      const result = await desktop.request(command, payload, { signal: exec.signal, timeoutMs })
      exec.signal?.throwIfAborted()
      return JSON.stringify({ ok: true, result })
    }
    catch (error) { return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) }
  }
  try {
    disposers.push(host.tools.register(defineTool({
      name: 'personal_assistant_start_meeting_presentation',
      description: '按用户明确要求准备会议及文档讲解：文档最多 100 段，桌面由本人确认麦克风、系统音频和固定文档，再等待双轨就绪。waiting-to-present 仅表示等待当前回复结束后开讲，不是讲完；不要在同一轮阻塞轮询。',
      parameters: {
        name: { type: 'string', required: true, description: '会议名称' },
        documentName: { type: 'string', description: '已授权目录中的文档名；与 documentPath 二选一' },
        documentPath: { type: 'string', description: '已授权目录中的文档路径；与 documentName 二选一' },
        retentionDays: { type: 'number', description: '录音保留天数，默认 30' },
      }, output,
      async execute(args: { name?: unknown; documentName?: unknown; documentPath?: unknown; retentionDays?: unknown }, exec) {
        const name = typeof args.name === 'string' ? args.name.trim() : ''
        const documentName = typeof args.documentName === 'string' ? args.documentName.trim() : ''
        const documentPath = typeof args.documentPath === 'string' ? args.documentPath.trim() : ''
        const days = args.retentionDays === undefined ? 30 : args.retentionDays
        if (!name || name.length > 80 || (!documentName && !documentPath) || (!!documentName && !!documentPath)
          || documentName.length > 4096 || documentPath.length > 4096 || typeof days !== 'number'
          || !Number.isSafeInteger(days) || days < 1 || days > 3650) return JSON.stringify({ ok: false, error: '会议名称、文档或保留天数无效' })
        return run('meeting.presentation.start', { name, ...(documentPath ? { documentPath } : { documentName }), retentionDays: days }, exec, 75_000)
      },
    })))
    disposers.push(host.tools.register(defineTool({
      name: 'personal_assistant_meeting_presentation_status',
      description: '查看会议讲解的真实状态和已完整播出的段落；部分、暂停、失败和取消都不等于完整讲完。不填编号时查看最近一次；重启后在途步骤只报未知。',
      parameters: { presentationId: { type: 'string', description: '可选讲解编号' } }, output,
      async execute(args: { presentationId?: unknown }, exec) {
        if (args.presentationId !== undefined && (typeof args.presentationId !== 'string' || !args.presentationId.trim() || args.presentationId.length > 200)) {
          return JSON.stringify({ ok: false, error: '讲解编号无效' })
        }
        return run('meeting.presentation.status', args.presentationId ? { presentationId: String(args.presentationId) } : {}, exec, 10_000)
      },
    })))
    disposers.push(host.tools.register(defineTool({
      name: 'personal_assistant_finish_meeting_presentation',
      description: '仅在用户明确要求结束会议时使用：桌面再次确认后停录，等待双轨冲刷与转写，打开纪要草稿供本人审阅。不会自动确认纪要或发送邮件。',
      parameters: { presentationId: { type: 'string', required: true, description: '开始会议时返回的讲解编号' } }, output,
      async execute(args: { presentationId?: unknown }, exec) {
        if (typeof args.presentationId !== 'string' || !args.presentationId.trim() || args.presentationId.length > 200) {
          return JSON.stringify({ ok: false, error: '讲解编号无效' })
        }
        return run('meeting.presentation.finish', { presentationId: args.presentationId }, exec, 360_000)
      },
    })))
  } catch (error) {
    while (disposers.length) disposers.pop()!()
    throw error
  }
  return () => { while (disposers.length) disposers.pop()!() }
}
