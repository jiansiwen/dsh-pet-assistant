/**
 * 团队页：待批、任务、成员三块。
 *
 * 与对话页分开是因为两页回答的问题不同 —— 对话页回答"我刚才那句话有没有人接"，
 * 团队页回答"今天谁在做什么、哪件事卡在我这儿"。挤在一页里的话，任务列表和消息区
 * 都要伸缩，而面板是 max-height 500 的硬预算，超预算时被裁掉的是输入框。
 *
 * **这一页不能签发批准。**
 * 舞台渲染器画的是模型写的文本，按设计它没有决定"要不要执行"的权限。下面的「去审批」
 * 只是请主进程打开专用审批窗口，提案内容由主进程自己去桥接取，决定在那个窗口里做
 * （见 `main/approval-window.ts`）。所以这里没有批准/驳回按钮，也没有"已批准"的表态。
 *
 * 排序、措辞、哪条要先给用户看，全部在 `team-panel.ts` 里，这个文件只负责画。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { cardView, formatCountdown } from '../main/approval-policy.js'
import { teamPanelView } from './team-panel.js'
import type { TeamSnapshot } from './types.js'
import type { CancelReceipt } from '../session-types.js'

/** 还能被取消的任务状态：终态与结果不明的任务没有可停的东西，不给按钮。 */
const CANCELLABLE = new Set(['created', 'queued', 'running', 'awaiting-approval', 'awaiting-user', 'review'])
const RECEIPT_LABEL: Record<CancelReceipt['state'], string> = {
  'not-executed': '未执行', cancelling: '取消中', terminated: '已终止', 'partially-executed': '已部分执行', unknown: '结果未知',
}

interface TeamPanelProps {
  /** 整份团队快照。null 表示桥接还没给过数据。 */
  snapshot: TeamSnapshot | null
  /** 按 assistantId 查显示名。查不到就返回 null，`team-panel` 会退回 id 本身。 */
  memberNames: (assistantId: string) => string | null
  /** 请主进程打开专用审批窗口。开不成的那句报错由调用方显示（toast 归 App 管）。 */
  onOpenApproval: (proposalId: string) => void | Promise<void>
  /** 当前会话绑定；任务取消与暂停经会话命令通道送到主进程，没有绑定时不显示这些按钮。 */
  bindingId?: string
}

export default function TeamPanel({ snapshot, memberNames, onOpenApproval, bindingId }: TeamPanelProps) {
  const [now, setNow] = useState(() => Date.now())
  /** 正在开窗的那条提案 id。同一时刻只允许一次请求，见下面 openApproval。 */
  const [opening, setOpening] = useState<string | null>(null)
  /** 正在取消的任务 id，以及每个任务最近一次的取消回执（如实显示 state，不把取消中说成已停止）。 */
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [receipts, setReceipts] = useState<Record<string, { state: CancelReceipt['state'] | null; text: string }>>({})
  const [pauseNote, setPauseNote] = useState<string | null>(null)
  const paused = (snapshot as (TeamSnapshot & { paused?: boolean }) | null)?.paused === true

  /** 定向取消一个团队任务：只作用于插件持有的子代理，回执带运行结束 / 释放证据。 */
  const cancelTask = useCallback(async (taskId: string) => {
    if (!bindingId || cancelling !== null) return
    setCancelling(taskId)
    try {
      const result = await window.petApi.sessionCommand({ kind: 'cancel', bindingId, taskId })
      const text = result.receipt?.message ?? result.notice ?? result.error ?? '取消没有回执，后台状态未知'
      setReceipts(previous => ({ ...previous, [taskId]: { state: result.receipt?.state ?? null, text } }))
    } catch (reason) {
      setReceipts(previous => ({ ...previous, [taskId]: { state: 'unknown', text: `取消没有送达，后台状态未知：${String(reason)}` } }))
    } finally {
      setCancelling(null)
    }
  }, [bindingId, cancelling])

  /** 暂停 / 恢复后续步骤：只挡新的领取，不中止在跑的任务。 */
  const togglePause = useCallback(async () => {
    if (!bindingId) return
    const result = await window.petApi.sessionCommand({ kind: 'cancel', bindingId, scope: paused ? 'resume' : 'pause' })
      .catch(reason => ({ ok: false, error: String(reason), notice: undefined }))
    setPauseNote(result.notice ?? result.error ?? null)
  }, [bindingId, paused])

  const view = useMemo(() => teamPanelView(snapshot, memberNames, now), [snapshot, memberNames, now])

  /**
   * 每秒时钟：只在真有需要跳字的行时才跑。
   *
   * 常驻的每秒定时器会让整页每秒重渲染一次，而绝大多数时候面板上一条提案都没有。
   * 需要跳字的只有两种：带截止时间的提案倒计时、带截止/产物提示的任务行。
   *
   * 依赖是 needsClock 这个布尔值而不是 view：view 每秒都变，拿它当依赖会让定时器
   * 每秒被拆掉重建，倒计时就会一秒一秒地往后漂。
   */
  const needsClock = useMemo(
    () =>
      view.proposals.some((item) => typeof item.expiresAt === 'number') ||
      view.tasks.some((task) => task.note !== null),
    [view],
  )

  useEffect(() => {
    if (!needsClock) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [needsClock])

  /**
   * 打开专用审批窗口。
   *
   * 期间把这一条按钮换成"正在打开…"并且不让别的行也点：连点两条会开两个窗口，
   * 而两个窗口里是同一条提案的话，第二次决定必定撞上"已被消费"。
   */
  const openApproval = useCallback(
    async (proposalId: string) => {
      if (opening !== null) return
      setOpening(proposalId)
      try {
        await onOpenApproval(proposalId)
      } finally {
        setOpening(null)
      }
    },
    [opening, onOpenApproval],
  )

  const nothing = !view.teamEnabled && view.tasks.length === 0 && view.proposals.length === 0

  return (
    <div className="team-page" id="panel-page-team" role="tabpanel" aria-labelledby="panel-tab-team">
      {nothing ? (
        /*
          不给一个空面板：空白会让人分不清"没有任务"和"没连上"。
          这两件事的处置完全不同 —— 前者等着就行，后者要去把运行时起来。
        */
        <div className="team-empty">
          <p className="team-empty-title">团队模式没有开启</p>
          <p className="team-empty-text">
            现在只有总助理一个人在跑，没有分工，也没有等你点头的操作。
          </p>
          <p className="team-empty-hint">
            上面状态行里的「启动团队」会用你选的运行时配置把它拉起来；已经显示已连接而这里还是空的，
            说明用的那份配置里没有开 team。
          </p>
        </div>
      ) : (
        <>
          <section className="team-section">
            <h3 className="team-section-title">
              等你点头
              {view.proposals.length > 0 && <span className="team-count">{view.proposals.length}</span>}
            </h3>
            {view.proposals.length === 0 ? (
              <p className="team-none">现在没有需要你批准的操作。</p>
            ) : (
              <ul className="team-list">
                {view.proposals.map((proposal) => {
                  // 卡片内容走的是审批窗口同一套投影：措辞、风险归档、目标规范化都只有一份。
                  const card = cardView(
                    proposal,
                    proposal.assistantId ? memberNames(proposal.assistantId) : null,
                    now,
                  )
                  const left = card.expiresAt === null ? null : card.expiresAt - now
                  return (
                    <li key={card.proposalId} className={`team-proposal risk-${card.risk}`}>
                      <div className="team-proposal-head">
                        <span className="team-tool">{card.tool}</span>
                        {/* 颜色不是唯一载体：左边框表达风险，这里再用文字说一遍。 */}
                        <span className={`team-risk risk-${card.risk}`}>{card.riskLabel}</span>
                        {left !== null && (
                          <span className={`team-countdown${card.expired ? ' expired' : ''}`}>
                            {formatCountdown(left)}
                          </span>
                        )}
                      </div>
                      {card.target && (
                        <div className="team-target" title={card.target}>
                          {card.target}
                        </div>
                      )}
                      {card.summary && <div className="team-summary">{card.summary}</div>}
                      <div className="team-proposal-foot">
                        {card.requester && <span className="team-who">{card.requester} 提请</span>}
                        {/*
                          提前说清还会再问一次：高风险操作批准后主进程还要弹一个原生确认框，
                          不预告的话用户会以为点了「批准」就完事，看到第二个框反而犹豫。
                        */}
                        {card.needsNativeConfirm && (
                          <span className="team-confirm-hint">批准后还会再确认一次</span>
                        )}
                        <button
                          type="button"
                          className="team-go"
                          disabled={!card.canDecide || opening !== null}
                          onClick={() => void openApproval(card.proposalId)}
                        >
                          {opening === card.proposalId ? '正在打开…' : '去审批'}
                        </button>
                      </div>
                      {/* 不能决定时必须说清为什么：只把按钮灰掉，用户不知道自己在等什么。 */}
                      {card.blockedReason && (
                        <p className="team-blocked" role="status">
                          {card.blockedReason}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section className="team-section">
            <h3 className="team-section-title">
              任务
              {view.runningCount > 0 && <span className="team-count quiet">{view.runningCount} 个在跑</span>}
              {bindingId && view.teamEnabled && (
                <button type="button" className="team-go" onClick={() => void togglePause()}
                  title="暂停后续步骤：排队中的任务不会开始，在跑的任务照常结束（要停下它请点任务上的「取消」）">
                  {paused ? '恢复后续步骤' : '暂停后续步骤'}
                </button>
              )}
            </h3>
            {pauseNote && <p className="team-note" role="status">{pauseNote}</p>}
            {view.tasks.length === 0 ? (
              <p className="team-none">还没有任务。跟总助理说一句要做什么，它就会分派下去。</p>
            ) : (
              <ul className="team-list">
                {view.tasks.map((task) => (
                  <li key={task.taskId} className={`team-task tone-${task.tone}`}>
                    <div className="team-task-head">
                      <span className={`team-status tone-${task.tone}`}>{task.statusLabel}</span>
                      {task.owner && <span className="team-owner">{task.owner}</span>}
                      {task.artifactCount > 0 && (
                        <span className="team-artifacts">{task.artifactCount} 份产物</span>
                      )}
                    </div>
                    <div className="team-goal">{task.goal}</div>
                    {/*
                      note 里可能是「说做完了，但没交出产物」。这句必须显眼：
                      角色说一句"我做完了"不构成成功，替它把话圆过去是在帮倒忙。
                    */}
                    {task.note && (
                      <p className="team-note" role="status">
                        {task.note}
                      </p>
                    )}
                    {bindingId && CANCELLABLE.has(task.status) && (
                      <div className="team-proposal-foot">
                        <button type="button" className="team-go" disabled={cancelling !== null}
                          title="定向取消这个任务：只停插件持有的子代理，不影响主会话；已发生的副作用不会撤回"
                          onClick={() => void cancelTask(task.taskId)}>
                          {cancelling === task.taskId ? '正在取消…' : '取消'}
                        </button>
                      </div>
                    )}
                    {receipts[task.taskId] && (
                      <p className={`team-note${receipts[task.taskId].state ? ` cancel-${receipts[task.taskId].state}` : ''}`} role="status">
                        {receipts[task.taskId].state ? `${RECEIPT_LABEL[receipts[task.taskId].state!]}：` : ''}
                        {receipts[task.taskId].text}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="team-section">
            <h3 className="team-section-title">成员</h3>
            {view.members.length === 0 ? (
              <p className="team-none">还没有编制。</p>
            ) : (
              <ul className="team-members">
                {view.members.map((member) => (
                  <li
                    key={member.assistantId}
                    className={`team-member${member.canWriteFiles ? ' can-write' : ''}${
                      member.enabled ? '' : ' off'
                    }`}
                  >
                    <span className="team-member-name">{member.displayName}</span>
                    {/*
                      能不能改用户的文件是这里最要紧的一条信息，所以既有文字也有左边框。
                      只给一个图标的话，用户得先猜图标是什么意思，而猜错的代价是文件被改了。
                    */}
                    <span className="team-member-scope">{member.scopeLabel}</span>
                    {!member.enabled && <span className="team-member-off">已停用</span>}
                    {(member.activeTasks > 0 || member.pendingApprovals > 0) && (
                      <span className="team-member-load">
                        {member.activeTasks > 0 && `${member.activeTasks} 件在手`}
                        {member.pendingApprovals > 0 && `${member.pendingApprovals} 条待批`}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
