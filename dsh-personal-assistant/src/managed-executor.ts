/**
 * 受管执行器注册表（4.6 切片1）。
 *
 * 任务类型不再靠 task-runtime 里的硬编码白名单逐个放开：能力方在这里登记
 * kind、固定能力清单与输入校验器，创建任务时逐项校验。未登记的 kind 仍然
 * KIND_UNSUPPORTED；登记不等于可以执行任意命令——执行只走既有执行器通道
 * （/executor/v1）领取/回执，能力清单之外的输入在执行器侧拒绝。
 *
 * 本模块是纯注册表：不持有 store、不发副作用、不调用模型。
 */

export interface ManagedExecutorSpec {
  /** 固定能力名（如 desktop.readback / desktop.action）；执行器只消费清单内的能力。 */
  capabilities: string[]
  /** 输入校验：不合法时抛错（错误信息会转成 INVALID_INPUT 回执）。 */
  validate(input: unknown): void
}

const KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const executors = new Map<string, ManagedExecutorSpec>()

/** 登记受管执行器。重复登记、覆盖内置类型或规格不全一律拒绝，不静默覆盖。 */
export function registerManagedExecutor(kind: string, spec: ManagedExecutorSpec): void {
  if (typeof kind !== 'string' || !KIND_PATTERN.test(kind)) throw new Error('受管执行器 kind 非法')
  if (kind === 'agent' || kind === 'reminder') throw new Error('内置任务类型不能被受管执行器覆盖')
  if (executors.has(kind)) throw new Error(`受管执行器已登记：${kind}`)
  if (!spec || !Array.isArray(spec.capabilities) || spec.capabilities.length === 0 || spec.capabilities.length > 32
    || !spec.capabilities.every(item => typeof item === 'string' && item.length > 0 && item.length <= 200)
    || typeof spec.validate !== 'function') {
    throw new Error('受管执行器必须声明固定能力清单与输入校验器')
  }
  executors.set(kind, { capabilities: [...spec.capabilities], validate: spec.validate })
}

/** 当前已登记的 kind 列表（创建白名单 = 内置 agent/reminder + 本列表）。 */
export function managedKinds(): string[] {
  return [...executors.keys()]
}

export function getManagedExecutor(kind: string): ManagedExecutorSpec | null {
  return executors.get(kind) ?? null
}

/** 仅供测试与装配重置使用；运行期不应注销正在执行的能力。 */
export function resetManagedExecutors(): void {
  executors.clear()
}