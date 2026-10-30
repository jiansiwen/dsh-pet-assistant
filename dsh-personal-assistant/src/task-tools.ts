import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CompanionTaskRuntime } from './task-runtime.ts'

/** 渠道会话的 sessionId 形如 channel-<hex(chatKey)>-<uuid>；解析失败返回 null。 */
function channelKeyFromExec(exec: unknown): string | null {
  const id = (exec as { agent?: { session?: { header?: { id?: unknown } } } })?.agent?.session?.header?.id
  if (typeof id !== 'string') return null
  const match = /^channel-([0-9a-f]+)-/.exec(id)
  if (!match) return null
  try {
    const key = Buffer.from(match[1]!, 'hex').toString('utf8')
    return key.startsWith('wecom:') ? key : null
  } catch { return null }
}

export function registerCompanionTools(host: { tools: { register(definition: unknown): () => void } }, runtime: CompanionTaskRuntime): () => void {
  const disposers: Array<() => void> = []
  const dispose = () => { while (disposers.length) disposers.pop()!() }
  const output = { schema: { type: 'string' } as const,
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
  const post = async (pathname: string, text: string) => {
    try { return JSON.stringify(await runtime.request('POST', pathname, JSON.parse(text), 'client')) }
    catch { return JSON.stringify({ status: 422, body: { code: 'INVALID_INPUT', message: '请求必须是有效的 JSON' } }) }
  }
  const create = async (title: string, input: unknown) => {
    try {
      const parsed = runtime.parseInput(input)
      const registered = await runtime.request('POST', '/companion/v1/inputs', parsed, 'client')
      const inputRef = (registered.body as { inputRef?: string }).inputRef
      if (!inputRef) return JSON.stringify({ ok: false, error: '输入登记失败，请重试' })
      const command = {
        protocolVersion: 1 as const, commandId: randomUUID(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        payload: { kind: parsed.kind, title, inputRef, dependsOn: [] },
      }
      return JSON.stringify(await runtime.request('POST', '/companion/v1/tasks', command, 'client'))
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  try {
    disposers.push(host.tools.register(defineTool({
      name: 'companion_create_reminder',
      description: '为用户创建桌面或企业微信提醒；按工具回执确认创建，不代表已经送达。时间必须明确；催办间隔默认读取宠物面板设置，用户未指定时不要传 nagEverySeconds。电脑关机时不会触发；“知道了”只结束本轮提醒，不等于业务完成。',
      parameters: {
        title: { type: 'string', required: true, description: '提醒标题' },
        message: { type: 'string', required: true, description: '通知正文' },
        timezone: { type: 'string', required: true, description: 'IANA 时区，如 Asia/Shanghai' },
        runAt: { type: 'string', description: '首次时间，ISO 8601 带时区（once/interval 必填；能用 delayMinutes 时不要自己算）' },
        delayMinutes: { type: 'number', description: '可选：从现在起多少分钟后首次触发；用于“三分钟后”这类相对时间，优先于 runAt' },
        repeatKind: { type: 'string', required: true, description: 'once、interval 或 daily' },
        everySeconds: { type: 'number', description: 'interval 时的重复间隔秒数，至少 60' },
        localTime: { type: 'string', description: 'daily 时的本地时刻 HH:mm' },
        nagEverySeconds: { type: 'number', description: '仅用户明确指定时填写；未回应时的催办间隔秒数，省略则使用宠物面板当前设置' },
        relatedTaskId: { type: 'string', description: '可选：关联的人工待办编号' },
        channel: { type: 'string', description: 'desktop 或 wecom；默认 desktop。企业微信只允许发到用户绑定过提醒的会话' },
        recipientId: { type: 'string', description: '企业微信提醒的会话标识，使用当前渠道提示中的标识' },
      },
      output,
      async execute(args: { title: string; message: string; timezone: string; runAt?: string; delayMinutes?: number; repeatKind: string; everySeconds?: number; localTime?: string; nagEverySeconds?: number; relatedTaskId?: string; channel?: string; recipientId?: string }, exec?: unknown) {
        const delay = Number(args.delayMinutes)
        const runAt = Number.isFinite(delay) && delay > 0 ? new Date(Date.now() + delay * 60_000).toISOString() : args.runAt
        const schedule = args.repeatKind === 'daily'
          ? { kind: 'daily', timezone: args.timezone, localTime: args.localTime }
          : args.repeatKind === 'interval'
            ? { kind: 'interval', timezone: args.timezone, runAt, everySeconds: args.everySeconds }
            : { kind: 'once', timezone: args.timezone, runAt }
        const bound = channelKeyFromExec(exec)
        const channel = bound ? 'wecom' : args.channel === 'wecom' ? 'wecom' : 'desktop'
        return create(String(args.title), {
          kind: 'reminder', message: args.message, schedule,
          ...(args.nagEverySeconds === undefined ? {} : { repeatEverySeconds: args.nagEverySeconds }),
          relatedBusinessTaskId: args.relatedTaskId ?? null, channel,
          ...(channel === 'wecom' ? { recipientId: bound ?? args.recipientId } : {}),
        })
      },
    })))
    disposers.push(host.tools.register(defineTool({
      name: 'companion_create_todo',
      description: '为用户创建一条人工待办，等待本人完成，不会调用模型代做。提交后需本机可信确认；不要声称已自动完成。',
      parameters: {
        title: { type: 'string', required: true, description: '待办标题' },
        description: { type: 'string', required: true, description: '要完成的业务内容' },
      },
      output,
      async execute(args: { title: string; description: string }) {
        return create(String(args.title), { kind: 'agent', executionMode: 'manual', description: args.description })
      },
    })))
    disposers.push(host.tools.register(defineTool({
      name: 'companion_register_input',
      description: '登记普通任务输入，不读文件、不执行动作。只支持人工待办与桌面提醒。人工输入为 kind=agent、executionMode=manual、description；提醒为 kind=reminder、message、明确时区的 schedule、repeatEverySeconds，可关联 relatedBusinessTaskId。返回 inputRef。',
      parameters: { inputJson: { type: 'string', required: true, description: '严格符合普通任务输入契约的 JSON；不接受磁盘路径' } },
      output,
      execute: (args: { inputJson: string }) => post('/companion/v1/inputs', args.inputJson),
    })))
    disposers.push(host.tools.register(defineTool({
      name: 'companion_create_task',
      description: '提交人工待办或桌面提醒创建提案，必须由本人在可信桌面确认后才生效。不会调用模型执行人工待办。不得声称待批准提案已开始提醒。',
      parameters: { commandJson: { type: 'string', required: true,
        description: '命令 JSON：protocolVersion=1、唯一 commandId、expiresAt、payload={kind,title,inputRef,dependsOn}；重试复用完全相同的命令' } },
      output,
      execute: (args: { commandJson: string }) => post('/companion/v1/tasks', args.commandJson),
    })))
    disposers.push(host.tools.register(defineTool({
      name: 'companion_control_task',
      description: '提交普通任务暂停、恢复、取消、人工完成或改期提案，不自行批准。提醒回应必须由可信桌面上的本人点击，不能把聊天中的知道了视为全部确认。',
      parameters: {
        taskId: { type: 'string', required: true, description: '确切任务编号' },
        action: { type: 'string', required: true, description: 'pause、resume、cancel、complete 或 reschedule' },
        commandJson: { type: 'string', required: true, description: '完整命令 JSON，包含 taskId 和 expectedRevision；普通控制 payload={}，改期传 schedule 或人工待办 deadlineAt' },
      }, output,
      async execute(args: { taskId: string; action: string; commandJson: string }) {
        if (!['pause', 'resume', 'cancel', 'complete', 'reschedule'].includes(args.action)) {
          return JSON.stringify({ status: 422, body: { code: 'INVALID_INPUT', message: '不支持此任务动作' } })
        }
        return post(`/companion/v1/tasks/${encodeURIComponent(args.taskId)}/${args.action}`, args.commandJson)
      },
    })))
    disposers.push(host.tools.register(defineTool({
      name: 'companion_task_status', description: '只读查询本人的普通任务、修订及提醒周期；不批准、不完成、不发送通知。',
      parameters: { taskId: { type: 'string', description: '可选的确切任务编号' } }, output,
      async execute(args: { taskId?: string }) {
        return JSON.stringify(await runtime.request('GET', args.taskId ? `/companion/v1/tasks/${encodeURIComponent(args.taskId)}` : '/companion/v1/tasks', null, 'client'))
      },
    })))
  } catch (error) { dispose(); throw error }
  return dispose
}
