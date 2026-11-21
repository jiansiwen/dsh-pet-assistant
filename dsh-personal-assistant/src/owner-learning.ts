/** 只消费可信入口的本人原话，不从邮件、模型自述或助手生成的任务材料里学规则。 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { containsMemoryCredential, normalizeTopic, type MemoryKind, type MemoryRecord, type MemoryStore } from './memory.ts'

type Rule = { text: string; topic: string; kind: MemoryKind; private: boolean; explicit: boolean }

export function ownerRule(raw: string): Rule | null {
  const command = raw.trim().normalize('NFKC')
  if (command.length > 420 || /[\r\n]/u.test(command) || containsMemoryCredential(command)) return null
  const direct = /^(?:(?:这条)?只给你知道[，,:：\s]+)?(?:请(?:你)?)?(?:记住(?:一下)?|记下|团队通用经验)[，,:：\s]+(.+)$/u.exec(command)
  const preference = /^我(?:还是)?更喜欢[，,:：\s]*(.+)$/u.exec(command)
  if (!direct && !preference) return null
  const text = (direct?.[1] ?? preference?.[1] ?? '').trim().replace(/^(?:这条)?只给你知道[，,:：\s]+/u, '')
  if (!text || /^(?:(?:只|就)在)?(?:今天|这一次|这次|刚才|临时|本次|当前项目|仅限)/u.test(text)) return null
  const topic = /^(?:以后|今后|下次|长期)?([^，,:：。]{2,45})[，,:：]/u.exec(text)?.[1] ?? '表达偏好'
  return { text, topic: normalizeTopic(topic), kind: command.startsWith('团队通用经验') ? 'team_experience' : 'user_preference',
    private: command.includes('只给你知道') || /^私密/u.test(text), explicit: direct !== null }
}

export class OwnerLearning {
  private readonly db: DatabaseSync
  private readonly memories: MemoryStore
  constructor(db: DatabaseSync, memories: MemoryStore) {
    this.db = db
    this.memories = memories
    db.exec(`CREATE TABLE IF NOT EXISTS owner_learning_signals (
      rule_key TEXT NOT NULL, evidence_key TEXT NOT NULL, observed_at INTEGER NOT NULL,
      PRIMARY KEY(rule_key, evidence_key)
    )`)
  }

  observe(raw: string, scopeId: string | null, session: string, message: string, now = Date.now()): { id: string; explicit: boolean } | null {
    const rule = ownerRule(raw)
    if (!rule || !session || !message) return null
    const digest = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
    const ruleKey = digest([scopeId ?? '', rule.kind, rule.topic, normalizeTopic(rule.text)])
    const evidence = digest([session, message])
    const scope = scopeId ? { kind: 'role' as const, id: scopeId } : { kind: 'global' as const, id: '' }
    const visible = this.memories.list(scopeId ? { roleId: scopeId } : {}, now)
      .filter(record => record.scope.kind === scope.kind && record.scope.id === scope.id)
    const same = visible.find(item => item.kind === rule.kind && item.topic === rule.topic && normalizeTopic(item.text) === normalizeTopic(rule.text))
    // 冲突不靠简单关键词裁决：遇到同主题已有不同生效规则，交给原有明确改写流程。
    if (!same && visible.some(item => item.status === 'confirmed' && item.topic === rule.topic && item.kind === rule.kind)) return null
    if (!rule.explicit) {
      if (same) return null
      const proposed = { id: '', kind: rule.kind, topic: rule.topic, text: rule.text, scope } as MemoryRecord
      if (this.memories.filterRestored([proposed]).blocked.length !== 0) return null
      this.db.prepare('DELETE FROM owner_learning_signals WHERE observed_at < ?').run(now - 90 * 86_400_000)
      // 不把同一聊天里连续重说几遍当成独立偏好；跨会话或隔天才算新的观察。
      const bucket = digest([session, new Date(now).toISOString().slice(0, 10)])
      this.db.prepare('INSERT OR IGNORE INTO owner_learning_signals VALUES (?, ?, ?)').run(ruleKey, bucket, now)
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM owner_learning_signals WHERE rule_key = ?').get(ruleKey)
      if (Number(count?.n ?? 0) < 3) return null
    }
    const stored = this.memories.put({ kind: rule.kind, topic: rule.topic, text: rule.text, scopeKind: scope.kind, scopeId: scope.id,
      sourceRefs: [`owner-message:${evidence}`], ...(rule.private ? { visibility: 'private' as const } : {}), actor: { id: 'local-owner', isUser: true } }, now)
    if (!stored.ok || stored.record.status !== 'confirmed' || same?.revision === stored.record.revision) return null
    this.db.prepare('DELETE FROM owner_learning_signals WHERE rule_key = ?').run(ruleKey)
    return { id: stored.record.id, explicit: rule.explicit }
  }
}
