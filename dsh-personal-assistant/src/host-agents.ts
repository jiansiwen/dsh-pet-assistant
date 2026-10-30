import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

export type HostAgentRegistry = Context['agents']
export interface HostLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * 插件的 inject 不声明 agents / llm：没有这些服务的宿主也要能正常装载。
 * 生产里经 ctx.get 现取；单元测试的假 Context 没有 get，退回直接属性。
 */
export function hostAgentRegistry(ctx: Context): HostAgentRegistry | undefined {
  try {
    const get = (ctx as unknown as { get?: (name: string) => unknown }).get
    if (typeof get === 'function') {
      const value = get.call(ctx, 'agents')
      if (value && typeof (value as HostAgentRegistry).create === 'function') return value as HostAgentRegistry
    }
  } catch { /* 服务尚未装载或已经卸载 */ }
  try { return ctx.agents } catch { return undefined }
}

export function hostLlm(ctx: Context): HostLlm | undefined {
  try {
    const get = (ctx as unknown as { get?: (name: string) => unknown }).get
    if (typeof get === 'function') {
      const value = get.call(ctx, 'llm')
      if (value && typeof (value as HostLlm).stream === 'function') return value as HostLlm
    }
  } catch { /* 服务尚未装载或已经卸载 */ }
  try { return (ctx as unknown as { llm?: HostLlm }).llm } catch { return undefined }
}
