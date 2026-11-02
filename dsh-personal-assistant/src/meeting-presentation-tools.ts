import { defineTool } from '@deepseek-ai/dsh-tools'

/** 仅交接桌面命令；实际授权、开录、讲解与播放回执由桌宠产生。 */
export function registerMeetingPresentationTools(host: { tools: { register(definition: unknown): () => void } }, desktop: {
  request(command: string, payload: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>
  binding?(agent: unknown): string | null
}, include?: readonly string[]): () => void {
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
  const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
  const validText = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max
    && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)
  const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))
  const runIndependent = async (command: string, payload: Record<string, unknown>, exec: { agent?: unknown; signal?: AbortSignal }, timeoutMs: number) => {
    const bindingId = desktop.binding?.(exec?.agent)
    if (!bindingId || !(exec?.signal instanceof AbortSignal) || exec.signal.aborted) {
      return JSON.stringify({ ok: false, error: '只接受当前本人桌面会话中的明确请求' })
    }
    try {
      const result = await desktop.request(command, { bindingId, ...payload }, { signal: exec.signal, timeoutMs })
      exec.signal.throwIfAborted()
      if (desktop.binding?.(exec.agent) !== bindingId) throw new Error('会话已变化，操作结果请在桌面核查，不会自动重试')
      return JSON.stringify({ ok: true, result })
    } catch (error) { return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) }
  }
  try {
    if (!include || include.includes('personal_assistant_meeting_recording'))
    disposers.push(host.tools.register(defineTool({
      name: 'personal_assistant_meeting_recording',
      description: '独立控制会议录音：start 只在用户明确要求录音时使用，按桌面设置自动审批或由本人确认；stop 只停止录音；status 查询状态。不会读取或讲解文档。用户同时要求录音和讲解时，分别调用本工具和文档讲解工具。',
      parameters: {
        action: { type: 'string', required: true, enum: ['start', 'stop', 'status'], description: '开始、停止或查询录音' },
        name: { type: 'string', description: '开始时的会议名称；省略为会议录音' },
        sources: { type: 'string', enum: ['mic', 'mic+loopback'], description: '开始时的录音范围，默认麦克风和系统音频' },
        retentionDays: { type: 'number', description: '开始时的录音保留天数，默认 30' },
        meetingId: { type: 'string', description: '停止时可选的当前会议编号' },
      }, output,
      async execute(raw: unknown, exec) {
        const args = record(raw)
        if (!args || !['start', 'stop', 'status'].includes(String(args.action))) return JSON.stringify({ ok: false, error: '录音操作无效' })
        if (args.action === 'start') {
          if (!only(args, ['action', 'name', 'sources', 'retentionDays']) || (args.name !== undefined && !validText(args.name, 80))
            || (args.sources !== undefined && args.sources !== 'mic' && args.sources !== 'mic+loopback')
            || (args.retentionDays !== undefined && (typeof args.retentionDays !== 'number' || !Number.isSafeInteger(args.retentionDays)
              || args.retentionDays < 1 || args.retentionDays > 3650))) return JSON.stringify({ ok: false, error: '录音名称、范围或保留天数无效' })
          return runIndependent('meeting.recording.start', { name: args.name === undefined ? '会议录音' : String(args.name).trim(),
            sources: args.sources ?? 'mic+loopback', retentionDays: args.retentionDays ?? 30 }, exec, 75_000)
        }
        if (args.action === 'stop') {
          if (!only(args, ['action', 'meetingId']) || (args.meetingId !== undefined && !validText(args.meetingId, 200))) {
            return JSON.stringify({ ok: false, error: '会议编号无效' })
          }
          return runIndependent('meeting.recording.stop', args.meetingId === undefined ? {} : { meetingId: String(args.meetingId).trim() }, exec, 45_000)
        }
        if (!only(args, ['action'])) return JSON.stringify({ ok: false, error: '录音状态查询参数无效' })
        return runIndependent('meeting.status', {}, exec, 10_000)
      },
    })))
    if (!include || include.includes('personal_assistant_document_presentation'))
    disposers.push(host.tools.register(defineTool({
      name: 'personal_assistant_document_presentation',
      description: '独立讲解授权目录内的文档：start、pause、resume、stop、status 均不创建会议、不启动或停止录音。讲解会向当前会话模型发送文档片段并产生费用，按桌面设置自动审批或由本人确认；waiting-to-present 仅表示等待会话空闲，不代表讲完。录音和讲解同时需要时分别调用两个工具。',
      parameters: {
        action: { type: 'string', required: true, enum: ['start', 'pause', 'resume', 'stop', 'status'], description: '讲解操作' },
        documentName: { type: 'string', description: '开始时的已授权文档名；与路径二选一' },
        documentPath: { type: 'string', description: '开始时的已授权文档路径；与文档名二选一' },
        from: { type: 'number', description: '开始时的段号，从 0 开始，默认 0' },
        presentationId: { type: 'string', description: '控制或查询时可选的讲解编号' },
      }, output,
      async execute(raw: unknown, exec) {
        const args = record(raw)
        if (!args || !['start', 'pause', 'resume', 'stop', 'status'].includes(String(args.action))) return JSON.stringify({ ok: false, error: '讲解操作无效' })
        if (args.action === 'start') {
          if (!only(args, ['action', 'documentName', 'documentPath', 'from'])
            || (args.documentName !== undefined && !validText(args.documentName, 4096))
            || (args.documentPath !== undefined && !validText(args.documentPath, 4096))
            || (args.documentName !== undefined && args.documentPath !== undefined)
            || (args.from !== undefined && (typeof args.from !== 'number' || !Number.isSafeInteger(args.from) || args.from < 0))) {
            return JSON.stringify({ ok: false, error: '文档名称、路径或段号无效' })
          }
          return runIndependent('document.presentation.start', {
            ...(args.documentName === undefined ? {} : { documentName: String(args.documentName).trim() }),
            ...(args.documentPath === undefined ? {} : { documentPath: String(args.documentPath).trim() }),
            ...(args.from === undefined ? {} : { from: args.from }),
          }, exec, 75_000)
        }
        if (!only(args, ['action', 'presentationId']) || (args.presentationId !== undefined && !validText(args.presentationId, 200))) {
          return JSON.stringify({ ok: false, error: '讲解控制参数无效' })
        }
        return runIndependent('document.presentation.control', { action: args.action,
          ...(args.presentationId === undefined ? {} : { presentationId: String(args.presentationId).trim() }) }, exec, 15_000)
      },
    })))
    if (!include || include.includes('personal_assistant_meeting_presentation_status'))
    disposers.push(host.tools.register(defineTool({
      name: 'personal_assistant_meeting_presentation_status',
      description: '仅查看旧版组合会议讲解的状态，用于历史任务收尾；新的独立讲解请用文档讲解工具查询。',
      parameters: { presentationId: { type: 'string', description: '可选讲解编号' } }, output,
      async execute(args: { presentationId?: unknown }, exec) {
        if (args.presentationId !== undefined && (typeof args.presentationId !== 'string' || !args.presentationId.trim() || args.presentationId.length > 200)) {
          return JSON.stringify({ ok: false, error: '讲解编号无效' })
        }
        return run('meeting.presentation.status', args.presentationId ? { presentationId: String(args.presentationId) } : {}, exec, 10_000)
      },
    })))
    if (!include || include.includes('personal_assistant_finish_meeting_presentation'))
    disposers.push(host.tools.register(defineTool({
      name: 'personal_assistant_finish_meeting_presentation',
      description: '仅用于本人明确结束旧版组合会议任务；新的独立录音和讲解请分别使用各自工具停止。',
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
