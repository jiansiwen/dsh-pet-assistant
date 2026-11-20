/** 工作台「技能」tab 的回包解析。读不到/坏了都归 unavailable，不画假表。 */

export interface SkillRow {
  id: string
  assistantId: string
  assistantName: string
  name: string
  body: string
  version: number
  status: string
  createdAt: number
  origin: string
}

export interface SkillEvidenceRow {
  assistantId: string
  assistantName: string
  shape: string
  count: number
}

export interface SkillsSnapshot {
  unavailable: boolean
  message: string | null
  skills: SkillRow[]
  pending: SkillEvidenceRow[]
  unverified: SkillEvidenceRow[]
}

export const SKILLS_UNAVAILABLE: SkillsSnapshot = { unavailable: true, message: null, skills: [], pending: [], unverified: [] }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function rows(value: unknown): SkillRow[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const r = record(item)
    if (!r || typeof r.id !== 'string' || typeof r.name !== 'string') return []
    return [{
      id: r.id,
      assistantId: typeof r.assistantId === 'string' ? r.assistantId : '',
      assistantName: typeof r.assistantName === 'string' ? r.assistantName : String(r.assistantId ?? ''),
      name: r.name,
      body: typeof r.body === 'string' ? r.body : '',
      version: typeof r.version === 'number' ? r.version : 1,
      status: typeof r.status === 'string' ? r.status : 'candidate',
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
      origin: typeof r.origin === 'string' ? r.origin : 'manual',
    }]
  })
}

function evidence(value: unknown): SkillEvidenceRow[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const r = record(item)
    if (!r || typeof r.shape !== 'string') return []
    return [{
      assistantId: typeof r.assistantId === 'string' ? r.assistantId : '',
      assistantName: typeof r.assistantName === 'string' ? r.assistantName : String(r.assistantId ?? ''),
      shape: r.shape,
      count: typeof r.count === 'number' ? r.count : 0,
    }]
  })
}

export function parseSkills(text: string): SkillsSnapshot {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { ...SKILLS_UNAVAILABLE, message: '暂时读不到技能' } }
  const body = record(parsed)
  if (!body || body.ok === false) return { ...SKILLS_UNAVAILABLE, message: typeof body?.message === 'string' ? body.message : '暂时读不到技能' }
  return {
    unavailable: false,
    message: null,
    skills: rows(body.skills),
    pending: evidence(body.pending),
    unverified: evidence(body.unverified),
  }
}

export const ORIGIN_LABEL: Record<string, string> = {
  manual: '人工/显式提交',
  'auto-verified': '自动·本人确认样本',
  'auto-selfreport': '自动·成员自报（待查验）',
}

export const STATUS_LABEL: Record<string, string> = {
  active: '生效中',
  candidate: '候选',
  retired: '已退役',
}
