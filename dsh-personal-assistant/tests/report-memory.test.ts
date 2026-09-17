/**
 * 记忆服务与日报版本化的行为契约。
 *
 * 这里测的全是"用户会被坑到的地方"：专家能不能自己确认自己的候选、内容改了旧批准还
 * 算不算数、删一条来源会不会把没依据的结论继续喂给模型、崩溃之后会不会重复发布。
 * schema 建得对不对不是重点，那部分错了上面的用例一个都过不去。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  MemoryStore,
  deletionReport,
  effectiveStatus,
  isInjectable,
  memoryWeight,
  normalizeTopic,
  renderMemorySection,
  scopeLabel,
  validateMemoryInput,
  visibleScopes,
  type MemoryActor,
  type MemoryRecord,
} from '../src/memory.ts'
import {
  ReportStore,
  makeReportId,
  publishRevisionFile,
  reconcilePublishedFile,
  tempPathFor,
} from '../src/report.ts'
import { sha256 } from '../src/store.ts'

const USER: MemoryActor = { id: 'user', isUser: true }
const EXPERT: MemoryActor = { id: 'member-wukong', isUser: false }
const NOW = 1_757_000_000_000

let db: DatabaseSync
let memories: MemoryStore

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  memories = new MemoryStore(db)
})

afterEach(() => {
  db.close()
})

function put(over: Partial<Parameters<MemoryStore['put']>[0]> = {}, actor: MemoryActor = USER) {
  return memories.put(
    {
      kind: 'user_preference',
      scopeKind: 'global',
      topic: '日报口径',
      text: '日报不要包含午休浏览网页的时间',
      actor,
      ...over,
    },
    NOW,
  )
}

describe('写入校验：认不出来就拒绝，不猜一个最接近的', () => {
  test('六类之外的 kind 一律拒', () => {
    assert.equal(validateMemoryInput({ kind: 'preference', scopeKind: 'global', text: 'x' }), 'unknown_kind')
    assert.equal(validateMemoryInput({ kind: '', scopeKind: 'global', text: 'x' }), 'unknown_kind')
    assert.equal(validateMemoryInput({ kind: 'user_preference', scopeKind: 'global', text: 'x' }), null)
  })

  test('范围之外的 scope 一律拒；非全局范围必须带 id', () => {
    assert.equal(validateMemoryInput({ kind: 'project_fact', scopeKind: 'workspace', text: 'x' }), 'unknown_scope')
    assert.equal(validateMemoryInput({ kind: 'project_fact', scopeKind: 'project', text: 'x' }), 'missing_scope_id')
    assert.equal(
      validateMemoryInput({ kind: 'project_fact', scopeKind: 'project', scopeId: '  ', text: 'x' }),
      'missing_scope_id',
    )
    assert.equal(
      validateMemoryInput({ kind: 'project_fact', scopeKind: 'project', scopeId: 'dsh', text: 'x' }),
      null,
    )
  })

  test('空正文与只有空白的正文都拒', () => {
    assert.equal(validateMemoryInput({ kind: 'user_preference', scopeKind: 'global', text: '   ' }), 'empty_text')
  })

  test('敏感内容在加密落地前拒绝入库，理由要说清下一步', () => {
    const result = put({ sensitivity: 'sensitive' })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.rejection, 'sensitive_without_encryption')
    assert.match(result.message, /DPAPI/)
    // 拒绝就是拒绝，库里不能留下半条
    assert.equal(memories.count(), 0)
  })
})

describe('确认权限：专家只能提交候选', () => {
  test('助理写入落 candidate，且不进提示词', () => {
    const result = put({ kind: 'project_fact', scopeKind: 'project', scopeId: 'dsh', text: '这个仓库用 pnpm' }, EXPERT)
    assert.ok(result.ok)
    assert.equal(result.record.status, 'candidate')
    assert.equal(result.record.confirmedBy, null)
    assert.equal(isInjectable(result.record, NOW), false)
    assert.deepEqual(memories.injectable({ projectId: 'dsh' }, NOW), [])
  })

  test('用户写入直接 confirmed', () => {
    const result = put()
    assert.ok(result.ok)
    assert.equal(result.record.status, 'confirmed')
    assert.equal(result.record.confirmedBy, 'user')
  })

  test('助理不能把自己的候选抬成已确认', () => {
    const created = put({ text: '构建要先跑 typecheck' }, EXPERT)
    assert.ok(created.ok)
    assert.equal(memories.confirm(created.record.id, EXPERT, NOW), null)
    assert.equal(memories.get(created.record.id, NOW)?.status, 'candidate')
  })

  test('用户确认候选后同 topic 的其他说法一并失效', () => {
    const candidate = put({ text: '构建要先跑 typecheck' }, EXPERT)
    assert.ok(candidate.ok)
    const confirmed = memories.confirm(candidate.record.id, USER, NOW)
    assert.equal(confirmed?.status, 'confirmed')

    const other = put({ text: '构建直接跑 build 就行' }, EXPERT)
    assert.ok(other.ok)
    assert.equal(other.record.status, 'conflicting', '候选撞上已确认要被标冲突，而不是并列进提示词')
    // 已确认那条不能被一条候选挤掉
    assert.equal(memories.get(candidate.record.id, NOW)?.status, 'confirmed')
    assert.equal(memories.injectable({}, NOW).length, 1)
  })
})

describe('冲突：保留两边让用户挑，不自动裁决', () => {
  test('用户前后矛盾时两条都停在 conflicting，谁都不注入', () => {
    const first = put({ text: '日报按工作类别组织' })
    assert.ok(first.ok)
    const second = put({ text: '日报按时间顺序流水账' })
    assert.ok(second.ok)
    assert.equal(second.record.status, 'conflicting')
    assert.equal(second.conflicts.length, 1)
    assert.equal(memories.get(first.record.id, NOW)?.status, 'conflicting')
    assert.deepEqual(memories.injectable({}, NOW), [])
  })

  test('同一句话说两遍不算冲突，也不重复入库', () => {
    const first = put({ text: '日报不要包含午休' })
    assert.ok(first.ok)
    const second = put({ text: '  日报不要包含午休  ' })
    assert.ok(second.ok)
    assert.equal(second.record.id, first.record.id, '归一化后同文应该拿回原来那条')
    assert.equal(second.record.status, 'confirmed')
    assert.equal(second.conflicts.length, 0)
    assert.equal(memories.injectable({}, NOW).length, 1, '不能堆两条一模一样的进提示词')
  })

  test('不同 topic 各说各的，互不干扰', () => {
    const first = put({ topic: '日报口径', text: '不要包含午休' })
    const second = put({ topic: '交互习惯', text: '回答尽量短' })
    assert.ok(first.ok && second.ok)
    assert.equal(second.record.status, 'confirmed')
    assert.equal(memories.injectable({}, NOW).length, 2)
  })

  test('topic 归一化：大小写与多余空白不造成漏判', () => {
    assert.equal(normalizeTopic('  Report   Tone '), 'report tone')
    const first = put({ topic: 'Report Tone', text: '正式一点' })
    assert.ok(first.ok)
    const second = put({ topic: 'report tone', text: '随意一点' })
    assert.ok(second.ok)
    assert.equal(second.record.status, 'conflicting')
  })
})

describe('范围与优先级：项目里的更正要压过全局旧偏好', () => {
  test('global 到处可见，project 只在该项目可见', () => {
    const global = put({ text: '全局偏好' })
    const scoped = put({ scopeKind: 'project', scopeId: 'dsh', text: '本项目偏好' })
    assert.ok(global.ok && scoped.ok)

    const inProject = memories.list({ projectId: 'dsh' }, NOW)
    assert.equal(inProject.length, 2)
    const elsewhere = memories.list({ projectId: 'other' }, NOW)
    assert.equal(elsewhere.length, 1)
    assert.equal(elsewhere[0].text, '全局偏好')
    assert.deepEqual(memories.list({}, NOW).map(item => item.text), ['全局偏好'])
  })

  test('可见范围列表：缺哪一维就看不到哪一维', () => {
    assert.deepEqual(visibleScopes({}), [{ kind: 'global', id: '' }])
    assert.deepEqual(visibleScopes({ projectId: 'dsh', roleId: 'wukong' }), [
      { kind: 'global', id: '' },
      { kind: 'project', id: 'dsh' },
      { kind: 'role', id: 'wukong' },
    ])
  })

  test('同为已确认时，项目范围的用户偏好排在全局之前', () => {
    const scoped = put({ scopeKind: 'project', scopeId: 'dsh', text: '本项目：日报只写代码相关' })
    const global = put({ text: '全局：日报写全部活动' })
    assert.ok(scoped.ok && global.ok)
    const ordered = memories.injectable({ projectId: 'dsh' }, NOW)
    assert.deepEqual(ordered.map(item => item.text), ['本项目：日报只写代码相关', '全局：日报写全部活动'])
  })

  test('角色表达设定排在最后', () => {
    put({ text: '全局偏好' })
    put({ kind: 'role_expression', scopeKind: 'role', scopeId: 'wukong', topic: '语气', text: '说话干脆点' })
    const ordered = memories.injectable({ roleId: 'wukong' }, NOW)
    assert.equal(ordered[ordered.length - 1].kind, 'role_expression')
    assert.ok(memoryWeight(ordered[0]) > memoryWeight(ordered[ordered.length - 1]))
  })
})

describe('到期：读取时刻重算，不靠后台任务改行', () => {
  test('过了有效期的已确认记忆立刻不再注入', () => {
    const result = put({ text: '这周先按 A 口径写', expiresAt: NOW + 1000 })
    assert.ok(result.ok)
    assert.equal(result.record.status, 'confirmed')
    assert.equal(effectiveStatus(result.record, NOW + 1000), 'expired')
    assert.equal(memories.get(result.record.id, NOW + 1000)?.status, 'expired')
    assert.deepEqual(memories.injectable({}, NOW + 1000), [])
  })

  test('保留期清理：临时对话直接删，其余只标失效', () => {
    const chat = put({ kind: 'ephemeral_chat', topic: '刚才那句', text: '帮我查一下这个报错', expiresAt: NOW - 1 })
    const fact = put(
      { kind: 'project_fact', scopeKind: 'project', scopeId: 'dsh', topic: '构建', text: '要先 typecheck', expiresAt: NOW - 1 },
    )
    assert.ok(chat.ok && fact.ok)

    const outcome = memories.applyRetention(NOW)
    assert.equal(outcome.deleted, 1)
    assert.equal(outcome.expired, 1)
    assert.equal(memories.get(chat.record.id, NOW), null, '临时对话到期就没了')
    assert.equal(memories.get(fact.record.id, NOW)?.status, 'expired', '已确认成果不因到期被删，只是不再生效')
  })
})

describe('删除传播：没有依据的结论不能继续当事实', () => {
  /** 造一条由 source 支撑的派生记忆。派生记忆只能由助理提交，所以走 confirm 抬成已确认。 */
  function derived(sourceId: string, over: Partial<Parameters<MemoryStore['put']>[0]> = {}) {
    const result = put(
      { kind: 'project_fact', scopeKind: 'project', scopeId: 'dsh', topic: '评审结论', text: '定了 A 方案', sourceRefs: [sourceId], ...over },
      EXPERT,
    )
    assert.ok(result.ok)
    const confirmed = memories.confirm(result.record.id, USER, NOW)
    assert.ok(confirmed)
    return confirmed
  }

  test('来源全没了，派生记忆跟着删', () => {
    const source = put({ kind: 'team_experience', topic: '评审会', text: '会上讨论了 A/B 两个方案' })
    assert.ok(source.ok)
    const child = derived(source.record.id)

    const outcome = memories.delete(source.record.id, '用户要求删除会议记录', NOW)
    assert.deepEqual(outcome.deleted.map(item => item.id), [source.record.id, child.id])
    assert.deepEqual(outcome.weakened, [])
    assert.equal(memories.get(child.id, NOW), null)
    assert.equal(outcome.ledgerEntries, 2)
  })

  test('还剩一条来源时只断边，本体留着但进 weakened', () => {
    const transcript = put({ kind: 'team_experience', topic: '评审会转写', text: '转写片段' })
    const dictated = put({ kind: 'user_preference', topic: '评审会口述', text: '用户口述的结论' })
    assert.ok(transcript.ok && dictated.ok)
    const child = derived(`${transcript.record.id}`, { sourceRefs: [transcript.record.id, dictated.record.id] })

    const outcome = memories.delete(transcript.record.id, '转写到保留期', NOW)
    assert.deepEqual(outcome.deleted.map(item => item.id), [transcript.record.id])
    assert.deepEqual(outcome.weakened.map(item => item.id), [child.id])
    const survivor = memories.get(child.id, NOW)
    assert.ok(survivor)
    assert.deepEqual(survivor.sourceRefs, [dictated.record.id])
  })

  test('传播是传递的：孙子辈一起走', () => {
    const root = put({ kind: 'team_experience', topic: '原始观察', text: '看到用户在改 X' })
    assert.ok(root.ok)
    const child = derived(root.record.id, { topic: '一级推断', text: '用户在修 X 的 bug' })
    const grandchild = derived(child.id, { topic: '二级推断', sourceRefs: [child.id], text: 'X 的 bug 出在缓存层' })

    const outcome = memories.delete(root.record.id, '用户要求删除', NOW)
    assert.deepEqual(outcome.deleted.map(item => item.id), [root.record.id, child.id, grandchild.id])
  })

  test('删不存在的 id 是空操作，不写账本', () => {
    const outcome = memories.delete('nope', '手滑', NOW)
    assert.deepEqual(outcome.deleted, [])
    assert.equal(outcome.ledgerEntries, 0)
  })
})

describe('删除报告：四类结果都得说，不能只报"已删除"', () => {
  test('库外还有副本时不能声称全部遗忘', () => {
    const created = put({ text: '日报不要包含午休' })
    assert.ok(created.ok)
    const outcome = memories.delete(created.record.id, '用户要求删除', NOW)

    const report = deletionReport(outcome, {
      legacyDomain: true,
      sampleFiles: ['C:/Users/me/.dsh/personal-assistant/samples/2026-09-05.jsonl'],
      exportedFiles: ['C:/Users/me/reports/2026-09-05.md'],
      sentToProvider: true,
    })
    assert.equal(report.deleted.length, 1)
    assert.equal(report.invalidated.length, 0)
    assert.equal(report.retained.length, 3)
    assert.match(report.retained[0], /旧 personal_assistant 存储域/)
    assert.match(report.retained[1], /2026-09-05\.jsonl/)
    assert.match(report.retained[2], /2026-09-05\.md/)
    assert.equal(report.uncontrolled.length, 2)
    assert.match(report.uncontrolled[0], /云端模型/)
  })

  test('没有任何库外副本时也要说清"外部复制追不回"', () => {
    const created = put()
    assert.ok(created.ok)
    const report = deletionReport(memories.delete(created.record.id, '用户要求删除', NOW), {
      legacyDomain: false,
      sampleFiles: [],
      exportedFiles: [],
      sentToProvider: false,
    })
    assert.deepEqual(report.retained, [])
    assert.equal(report.uncontrolled.length, 1)
  })
})

describe('删除账本：备份恢复不能复活已删记忆', () => {
  test('同内容换个 id 回来也拦得住', () => {
    const created = put({ text: '日报不要包含午休' })
    assert.ok(created.ok)
    const original = created.record
    memories.delete(original.id, '用户要求删除', NOW)

    // 备份里的同一条，恢复时可能带着完全不同的 id
    const resurrected: MemoryRecord = { ...original, id: 'restored-1', revision: 1 }
    const { accepted, blocked } = memories.filterRestored([resurrected])
    assert.deepEqual(accepted, [])
    assert.deepEqual(blocked.map(item => item.id), ['restored-1'])
  })

  test('没删过的内容正常放行', () => {
    const created = put({ text: '回答尽量短' })
    assert.ok(created.ok)
    const { accepted, blocked } = memories.filterRestored([created.record])
    assert.equal(accepted.length, 1)
    assert.deepEqual(blocked, [])
  })

  test('正常写入不查账本：用户主动重新记一遍是新的意图', () => {
    const created = put({ text: '日报不要包含午休' })
    assert.ok(created.ok)
    memories.delete(created.record.id, '用户要求删除', NOW)
    const again = put({ text: '日报不要包含午休' })
    assert.ok(again.ok, '删过又要重新记，必须让记')
    assert.equal(again.record.status, 'confirmed')
  })
})

describe('提示词渲染', () => {
  test('空列表渲染成 undefined，变量缺省时模板不会留下一行空白', () => {
    assert.equal(renderMemorySection([], {}), undefined)
  })

  test('范围与导入标记要写出来，不能一律渲染成"始终遵守"', () => {
    const scoped = put({ scopeKind: 'project', scopeId: 'dsh', text: '本项目：只写代码相关' })
    const global = put({ text: '全局：写全部活动' })
    assert.ok(scoped.ok && global.ok)
    const rendered = renderMemorySection(memories.injectable({ projectId: 'dsh' }, NOW), { projectId: 'dsh' })
    assert.ok(rendered)
    const lines = rendered.split('\n')
    assert.match(lines[0], /\[用户偏好\]（本项目） 本项目：只写代码相关/)
    assert.match(lines[1], /\[用户偏好\] 全局：写全部活动/, '全局偏好不带范围后缀')
  })

  test('导入的记忆要标明来源不是本系统观察', () => {
    const record: MemoryRecord = {
      id: 'legacy-pref-1',
      kind: 'user_preference',
      scope: { kind: 'global', id: '' },
      topic: '',
      text: '旧偏好',
      sourceRefs: [],
      status: 'confirmed',
      sensitivity: 'normal',
      createdBy: 'migration',
      confirmedBy: 'migration',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: null,
      importBatch: 'legacy-domain-2026-09-05',
    }
    const rendered = renderMemorySection([record], {})
    assert.match(rendered ?? '', /（导入）/)
  })

  test('范围标签在当前项目里说"本项目"，在别处说清是哪个项目', () => {
    assert.equal(scopeLabel({ kind: 'project', id: 'dsh' }, { projectId: 'dsh' }), '本项目')
    assert.equal(scopeLabel({ kind: 'project', id: 'dsh' }, {}), '项目 dsh')
    assert.equal(scopeLabel({ kind: 'session', id: 's1' }, {}), '仅本次会话')
  })
})

// ---------------------------------------------------------------------------
// 日报版本化
// ---------------------------------------------------------------------------

describe('日报：确认绑定内容摘要，改一个字就作废', () => {
  let reports: ReportStore
  const reportId = makeReportId('daily', '2026-09-05')

  beforeEach(() => {
    reports = new ReportStore(db)
  })

  test('每次改内容都产生新版本，旧版本的确认随之作废', () => {
    const first = reports.saveDraft(reportId, '# 日报\n\n上午写代码', NOW)
    assert.equal(first.revision, 1)
    assert.equal(first.state, 'draft')
    const approved = reports.approve(reportId, 1, first.digest, 'C:/reports/2026-09-05.md', USER, NOW)
    assert.ok(approved.ok)

    const second = reports.saveDraft(reportId, '# 日报\n\n上午写代码，下午开会', NOW)
    assert.equal(second.revision, 2)
    const stale = reports.revision(reportId, 1)
    assert.equal(stale?.state, 'revoked')
    assert.match(stale?.revokedReason ?? '', /内容已更新/)
    assert.equal(reports.current(reportId)?.revision, 2)
    assert.equal(reports.history(reportId).length, 2, '旧版本还在库里，只是不再生效')
  })

  test('内容没变就不凭空多一版', () => {
    reports.saveDraft(reportId, '同样的内容', NOW)
    const again = reports.saveDraftIfChanged(reportId, '同样的内容', NOW)
    assert.equal(again.revision, 1)
    assert.equal(reports.history(reportId).length, 1)
  })

  test('摘要对不上就拒绝确认：点头之后正文被改过', () => {
    const draft = reports.saveDraft(reportId, '用户看到的内容', NOW)
    reports.saveDraft(reportId, '模型偷偷改过的内容', NOW)
    const result = reports.approve(reportId, 2, draft.digest, 'C:/reports/x.md', USER, NOW)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.rejection, 'digest_mismatch')
  })

  test('旧版本不能再拿去确认', () => {
    reports.saveDraft(reportId, 'v1', NOW)
    reports.saveDraft(reportId, 'v2', NOW)
    const v1 = reports.revision(reportId, 1)
    assert.ok(v1)
    const result = reports.approve(reportId, 1, v1.digest, 'C:/reports/x.md', USER, NOW)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.rejection, 'stale_revision')
  })

  test('模型转述的"用户已同意"不是确认', () => {
    const draft = reports.saveDraft(reportId, '内容', NOW)
    const result = reports.approve(reportId, 1, draft.digest, 'C:/reports/x.md', EXPERT, NOW)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.rejection, 'not_user')
    assert.equal(reports.revision(reportId, 1)?.state, 'draft')
  })

  test('批准之后状态才允许开发布作业', () => {
    const draft = reports.saveDraft(reportId, '内容', NOW)
    assert.equal(reports.beginPublish('op-1', draft, NOW), null)
    const approved = reports.approve(reportId, 1, draft.digest, 'C:/reports/x.md', USER, NOW)
    assert.ok(approved.ok)
    const job = reports.beginPublish('op-1', approved.record, NOW)
    assert.equal(job?.state, 'running')
    assert.equal(reports.revision(reportId, 1)?.state, 'publishing')
    assert.deepEqual(reports.openJobs().map(item => item.operationId), ['op-1'])
  })
})

describe('发布：临时产物 → 校验摘要 → 原子更名', () => {
  let dir: string
  let target: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dsh-report-'))
    target = path.join(dir, '2026-09-05.md')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('正常发布：目标文件内容就是确认的那份，临时文件不留下', async () => {
    const content = '# 日报\n\n上午写代码'
    const outcome = await publishRevisionFile(target, content, sha256(content), 1)
    assert.ok(outcome.ok)
    assert.equal(await readFile(target, 'utf8'), content)
    await assert.rejects(() => readFile(tempPathFor(target, 1), 'utf8'), '临时文件应该已经更名走')
  })

  test('落盘内容与摘要不一致时绝不覆盖目标', async () => {
    await writeFile(target, '用户上一份日报', 'utf8')
    const outcome = await publishRevisionFile(target, '新内容', sha256('别的内容'), 2)
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.reason, 'digest_mismatch')
    assert.equal(await readFile(target, 'utf8'), '用户上一份日报', '旧日报必须原样还在')
    assert.match(outcome.message, /\.r2\.tmp/, '要说清临时文件在哪，方便人来查')
  })

  test('目标目录不存在会自动建出来', async () => {
    const nested = path.join(dir, 'a', 'b', '2026-09-05.md')
    const content = 'x'
    const outcome = await publishRevisionFile(nested, content, sha256(content), 1)
    assert.ok(outcome.ok)
  })
})

describe('崩溃恢复：按同一个作业核对已有文件，不重复发布', () => {
  let dir: string
  let target: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dsh-recover-'))
    target = path.join(dir, '2026-09-05.md')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('文件已经落盘且内容对得上 → 认账，不再发一次', async () => {
    const content = '# 日报'
    const digest = sha256(content)
    await writeFile(target, content, 'utf8')
    assert.equal(await reconcilePublishedFile(target, digest), 'matches')
  })

  test('文件不在 → 该重发', async () => {
    assert.equal(await reconcilePublishedFile(target, sha256('# 日报')), 'missing')
  })

  test('文件在但内容不是这一版 → 不能当成发布成功', async () => {
    await writeFile(target, '别人写的东西', 'utf8')
    assert.equal(await reconcilePublishedFile(target, sha256('# 日报')), 'differs')
  })
})
