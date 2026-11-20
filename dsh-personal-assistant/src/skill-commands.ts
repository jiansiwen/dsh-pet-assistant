/**
 * 工作台「技能」tab 的命令解析。只解析形状，真正的写仍走 /companion/v1/skills
 * 的可信路由（owner=本人桌面操作）。增删改查 + 晋升/回滚/退役 + 证据确认/撤回。
 */

export const SKILL_SET_USAGE =
  '用法：/assistant-skill-set create|edit|delete|promote|retire|rollback|verify|retract …（create <助理> <名称> <正文>；edit <id> <正文>；rollback <id> [版本]；verify/retract <助理> <同类签名>）'

export type SkillCommand =
  | { kind: 'create'; assistantId: string; name: string; body: string }
  | { kind: 'edit'; id: string; body: string }
  | { kind: 'delete'; id: string }
  | { kind: 'promote'; id: string }
  | { kind: 'retire'; id: string }
  | { kind: 'rollback'; id: string; version?: number }
  | { kind: 'verify'; assistantId: string; shape: string }
  | { kind: 'retract'; assistantId: string; shape: string }

const ID = /^[^\s]{1,400}$/u
const AID = /^[A-Za-z0-9_-]{1,200}$/u

function parts(rawInput: string | undefined): string[] {
  const raw = (rawInput ?? '').trim()
  const body = raw.startsWith('/') ? raw.slice(raw.indexOf(' ') + 1) : raw
  const trimmed = body.trim()
  return trimmed === '' ? [] : trimmed.split(/\s+/u)
}

export function parseSkillCommand(rawInput: string | undefined): SkillCommand | null {
  const tokens = parts(rawInput)
  const [action, a, b, ...rest] = tokens
  if (action === undefined) return null
  const body = rest.join(' ')
  if (action === 'create') {
    if (!a || !b || body === '' || !AID.test(a)) return null
    return { kind: 'create', assistantId: a, name: b, body }
  }
  if (action === 'edit') {
    const editBody = [b, ...rest].join(' ').trim()
    if (!a || editBody === '' || !ID.test(a)) return null
    return { kind: 'edit', id: a, body: editBody }
  }
  if (action === 'delete' || action === 'promote' || action === 'retire') {
    if (!a || !ID.test(a)) return null
    return { kind: action, id: a }
  }
  if (action === 'rollback') {
    if (!a || !ID.test(a)) return null
    if (b === undefined) return { kind: 'rollback', id: a }
    const version = Number(b)
    return Number.isInteger(version) && version >= 1 ? { kind: 'rollback', id: a, version } : null
  }
  if (action === 'verify' || action === 'retract') {
    const shape = [b, ...rest].join(' ').trim()
    if (!a || shape === '' || !AID.test(a)) return null
    return { kind: action, assistantId: a, shape }
  }
  return null
}

/** 把解析结果转成 /companion/v1/skills 的请求体。 */
export function skillRequestBody(command: SkillCommand): Record<string, unknown> {
  switch (command.kind) {
    case 'create': return { action: 'create', assistantId: command.assistantId, name: command.name, body: command.body }
    case 'edit': return { action: 'edit', id: command.id, body: command.body }
    case 'delete': return { action: 'delete', id: command.id }
    case 'rollback': return { action: 'rollback', id: command.id, ...(command.version === undefined ? {} : { version: command.version }) }
    case 'verify': return { action: 'verify', assistantId: command.assistantId, shape: command.shape }
    case 'retract': return { action: 'retract', assistantId: command.assistantId, shape: command.shape }
    default: return { action: command.kind, id: command.id }
  }
}
