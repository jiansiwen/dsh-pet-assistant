/**
 * 技能自动形成：把"同类工作攒够样本 → 模型总结成技能"接成闭环。
 *
 * 分工不变（skills.ts 的硬约束）：**计数与"够不够"归代码，正文归模型**。
 * 这里只负责在样本达标时触发一次模型总结，并把结果按策略落库：
 * - 默认自动生效（人工只做事后查验）；`autoActivate=false` 时停在候选。
 * - 模型若声明 `scopeChanged`（要读新目录/执行命令等扩权），**无论如何停在候选**，
 *   扩权必须本人批准 —— 学习不等于授权。
 *
 * 去重：以 (owner, shape) 为键，已有同名技能或正在总结时不重复触发。
 */
import { SKILL_FORM_THRESHOLD, type SkillStore, type SkillVersion } from './skills.ts'

export interface SkillSample {
  goal: string
  acceptance: string
  artifacts: string
  updatedAt: number
}

export interface SkillSynthesis {
  body: string
  /** 模型声明这次做法是否扩大了权限（读新目录/执行命令等）。 */
  scopeChanged: boolean
}

export interface SkillFormationOptions {
  skills: SkillStore
  autoForm(): boolean
  autoActivate(): boolean
  /** 取该 owner 在这个 shape 下的真实任务记录，供模型总结（不是编造）。 */
  samples(ownerId: string, shape: string): SkillSample[]
  /** 模型总结；返回 null 表示这次没产出可用正文。 */
  synthesize(ownerId: string, shape: string, samples: SkillSample[]): Promise<SkillSynthesis | null>
  log?(message: string): void
  onActive?(skill: SkillVersion, count: number): void
  threshold?: number
}

export class SkillFormation {
  private readonly inflight = new Set<string>()
  private readonly options: SkillFormationOptions
  constructor(options: SkillFormationOptions) { this.options = options }

  /** 记一次样本并尝试形成。verified=true 为本人确认/独立核实；false 为成员自报。 */
  record(ownerId: string, shape: string, verified: boolean, evidence?: { ref: string; sample: SkillSample }): void {
    const owner = ownerId.trim()
    const key = shape.trim()
    if (owner === '' || key === '') return
    this.options.skills.noteSuccess(owner, key, verified, Date.now(), evidence)
    if (verified) void this.consider(owner, key)
  }

  private async consider(owner: string, shape: string): Promise<void> {
    if (!this.options.autoForm()) return
    const flight = `${owner}:${shape}`
    if (this.inflight.has(flight)) return
    const normalized = shape.normalize('NFKC').toLowerCase()
    if (this.options.skills.list(owner).some(item => item.name.normalize('NFKC').toLowerCase() === normalized)) return
    const count = this.options.skills.evidenceCount(owner, shape)
    if (count < (this.options.threshold ?? SKILL_FORM_THRESHOLD)) return
    this.inflight.add(flight)
    try {
      const samples = this.options.samples(owner, shape)
      if (samples.length < (this.options.threshold ?? SKILL_FORM_THRESHOLD)) return
      const result = await this.options.synthesize(owner, shape, samples)
      if (result === null || result.body.trim() === '') {
        this.options.log?.(`技能自动形成未产出正文：${owner}「${shape}」`)
        return
      }
      if (JSON.stringify(this.options.samples(owner, shape)) !== JSON.stringify(samples)
        || this.options.skills.list(owner).some(item => item.name.normalize('NFKC').toLowerCase() === normalized)) return
      const origin: SkillVersion['origin'] = 'auto-verified'
      // 扩权一律候选；其余按 autoActivate 决定生效或候选。
      const status = result.scopeChanged ? 'candidate' : (this.options.autoActivate() ? 'active' : 'candidate')
      const saved = this.options.skills.save(owner, { name: shape, body: result.body }, status, Date.now(), origin)
      this.options.log?.(`技能自动形成：${owner}「${saved.name}」v${saved.version} ${status}（${origin}，样本 ${count}）`)
      if (status === 'active') this.options.onActive?.(saved, samples.length)
    } catch (error) {
      this.options.log?.(`技能自动形成失败：${owner}「${shape}」${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.inflight.delete(flight)
    }
  }
}
