/**
 * 环境检查（M5-06 界面部分）：把 `first-run.ts` 算出的清单显示出来，并按用户的确认去做那几件事。
 *
 * 三条边界，界面这边也得守住：
 *
 * 1. **不自动做任何事**。打开这一页只触发一次只读检查；下载、申请权限、打开系统设置都要用户点。
 *    "打开设置就自动开始下模型"是那种用户没同意过的副作用，装完才发现磁盘少了几百 MB。
 * 2. **下载用计划里的原值**。确认时把 `url` / `destinationDir` 原样带回去，主进程会重新出计划
 *    逐字比对。界面**不许**自己拼地址或猜目录 —— 那会让"用户确认 A、实际下 B"变成可能。
 * 3. **不假装成功**。检查失败就说失败（可以重试），下载失败按 `stage` 说清楚卡在哪一步，
 *    可重试的（网络类）才给"再试一次"。
 */
import { useCallback, useEffect, useState } from 'react'
import type { DownloadPlanItemView, FirstRunReportResult } from '../main/first-run-service.js'
import type { FirstRunItem, FirstRunStep } from '../main/first-run.js'
import type { DownloadOutcome } from '../main/model-resources.js'

export interface EnvironmentCheckProps {
  readonly showToast: (text: string) => void
}

type Snapshot = Extract<FirstRunReportResult, { ok: true }>

const GROUP_LABEL: Record<FirstRunItem['group'], string> = {
  runtime: '运行时',
  model: '语音模型',
  permission: '权限',
}

const STATUS_LABEL: Record<FirstRunItem['status'], string> = {
  ready: '就绪',
  action: '需要处理',
  optional: '可选',
  blocked: '装不了',
  checking: '检查中',
  unknown: '读不到状态',
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/**
 * 一条"下一步"。每种 step 各自是一种用户动作，没有一种是自动执行的。
 *
 * 模型下载会走 `onDownload`：它把计划里那一条原样交给主进程。`confirm-download` 的
 * `modelIds` 可能有多条（模型缺失会合并成一次确认），这里逐条执行并汇总结果 ——
 * 一条失败不影响其余（用户可能只想要其中一个）。
 */
async function runStep(
  step: FirstRunStep,
  snapshot: Snapshot,
  onDownload: (item: DownloadPlanItemView) => Promise<void>,
  onOpenSettings: (target: 'microphone') => Promise<void>,
  showToast: (text: string) => void,
): Promise<void> {
  switch (step.kind) {
    case 'confirm-download': {
      const items = (snapshot.plan?.items ?? []).filter(item => step.modelIds.includes(item.modelId))
      if (items.length === 0) {
        showToast('没有可下载的模型，请重新检查')
        return
      }
      for (const item of items) await onDownload(item)
      return
    }
    case 'request-permission':
    case 'open-settings':
      await onOpenSettings('microphone')
      return
    case 'run-command':
      // 插件安装这类命令要用户在终端里自己执行：壳不会替他跑（它会改用户的 profile）。
      await navigator.clipboard?.writeText(step.command).catch(() => {})
      showToast('命令已复制，请在终端里自行执行')
      return
    case 'reinstall':
      showToast('这一项在本机处理不了，需要换一个安装包')
      return
    case 'retry-check':
      return
  }
}

export function EnvironmentCheck({ showToast }: EnvironmentCheckProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<DownloadOutcome[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.petApi.firstRunReport()
      if (result.ok) setSnapshot(result)
      else {
        // 检查失败就说失败：显示一份"全部就绪"的空报告比报错更糟 —— 用户会以为没问题。
        setSnapshot(null)
        setError(result.error)
      }
    } catch (cause) {
      setSnapshot(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  // 只读检查：进这一页就跑一次，不重复轮询（模型检查要读几百 MB 的 sha256）。
  useEffect(() => { void refresh() }, [refresh])

  const download = useCallback(async (item: DownloadPlanItemView): Promise<void> => {
    setDownloading(item.modelId)
    try {
      // 原样带回计划里的三要素。主进程会重新出计划比对，对不上就退回"请重新确认"。
      const result = await window.petApi.firstRunDownload({
        modelId: item.modelId,
        url: item.url,
        destinationDir: item.destinationDir,
      })
      if (!result.ok) {
        showToast(`${item.title}：${result.error}`)
        return
      }
      setOutcomes(previous => [...previous, result.outcome])
      if (!result.outcome.ok) showToast(`${item.title}：${result.outcome.error}`)
    } catch (cause) {
      showToast(`${item.title}：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setDownloading(null)
      // 装完/失败都重查一遍：界面要显示的是当前真实状态，不是我们以为的状态。
      await refresh()
    }
  }, [refresh, showToast])

  const openSettings = useCallback(async (target: 'microphone'): Promise<void> => {
    const result = await window.petApi.firstRunOpenSettings(target)
    if (!result.ok) showToast(result.error ?? '没能打开系统设置')
  }, [showToast])

  if (error !== null) {
    return (
      <section className="management-section" aria-label="环境检查">
        <h3>环境检查</h3>
        <p className="management-hint" role="status">检查没完成：{error}</p>
        <button className="management-button" disabled={busy} onClick={() => void refresh()}>
          {busy ? '正在检查…' : '重新检查'}
        </button>
      </section>
    )
  }

  if (snapshot === null) {
    return (
      <section className="management-section" aria-label="环境检查">
        <h3>环境检查</h3>
        <p className="management-hint">正在检查本机环境…</p>
      </section>
    )
  }

  const { report, plan, planError, modelCheckTimedOut } = snapshot
  const grouped: Array<[FirstRunItem['group'], FirstRunItem[]]> = (['runtime', 'model', 'permission'] as const)
    .map(group => [group, report.items.filter(item => item.group === group)] as [FirstRunItem['group'], FirstRunItem[]])
    .filter(([, items]) => items.length > 0)

  return (
    <section className="management-section" aria-label="环境检查">
      <h3>环境检查</h3>
      <p className="management-hint" role="status">{report.summary.headline}</p>

      {grouped.map(([group, items]) => (
        <div key={group} className="management-group">
          <h4>{GROUP_LABEL[group]}</h4>
          <ul className="management-checklist">
            {items.map(item => (
              <li key={item.id} data-status={item.status}>
                <strong>{item.title}</strong>
                <span className="management-status">{STATUS_LABEL[item.status]}</span>
                <p>{item.detail}</p>
                {item.impact !== null && <p className="management-hint">缺了会怎样：{item.impact}</p>}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {report.nextSteps.length > 0 && (
        <div className="management-group">
          <h4>下一步</h4>
          {report.nextSteps.map((step, index) => (
            <button
              key={`${step.kind}-${index}`}
              className="management-button"
              disabled={busy || downloading !== null}
              onClick={() => void runStep(step, snapshot, download, openSettings, showToast)}
            >{step.label}</button>
          ))}
        </div>
      )}

      {planError !== null && (
        <p className="management-hint" role="status">下载计划不可用：{planError}</p>
      )}
      {plan !== null && plan.items.length > 0 && (
        <div className="management-group">
          <h4>要下载的模型（合计 {formatBytes(plan.totalDownloadBytes)}）</h4>
          <ul className="management-checklist">
            {plan.items.map(item => (
              <li key={item.modelId} data-status={item.reason === 'corrupt' ? 'action' : 'optional'}>
                <strong>{item.title}</strong>
                <span className="management-status">{item.reason === 'corrupt' ? '需修复' : '未安装'}</span>
                <p>{item.purpose}（{item.whenMissing}）</p>
                <p className="management-hint">
                  下载 {formatBytes(item.downloadBytes)}，装好占 {formatBytes(item.installBytes)}；
                  来源 {new URL(item.upstreamUrl).host}；许可证 {item.license}
                </p>
                <p className="management-hint">装到 {item.destinationDir}</p>
                <button className="management-button" disabled={downloading !== null}
                  onClick={() => void download(item)}>
                  {downloading === item.modelId ? '正在下载…' : '下载并校验'}
                </button>
              </li>
            ))}
          </ul>
          {plan.notes.map(note => <p key={note} className="management-hint">{note}</p>)}
        </div>
      )}

      {modelCheckTimedOut && (
        <p className="management-hint" role="status">模型检查超时了，结果可能不完整。</p>
      )}

      {outcomes.length > 0 && (
        <div className="management-group">
          <h4>最近的下载结果</h4>
          {outcomes.map((outcome, index) => (
            <p key={`${outcome.modelId}-${index}`} className="management-diagnostic">
              {outcome.ok
                ? `${outcome.modelId}：装好了（尝试 ${outcome.attempts} 次）`
                : `${outcome.modelId}：失败在「${outcome.stage}」——${outcome.error}${outcome.retryable ? '（可以再试一次）' : ''}`}
            </p>
          ))}
        </div>
      )}

      <div className="management-group">
        <h4>数据去向</h4>
        <ul className="management-checklist">
          {report.dataFlows.map(flow => (
            <li key={flow.id} data-status={flow.active ? 'ready' : 'optional'}>
              <strong>{flow.title}</strong>
              <span className="management-status">{flow.where === 'local' ? '只在本机' : '会出网'}{flow.active ? ' · 正在用' : ''}</span>
              <p>{flow.data} → {flow.destination}</p>
              <p className="management-hint">怎么控制：{flow.control}</p>
            </li>
          ))}
        </ul>
      </div>

      <button className="management-button" disabled={busy || downloading !== null} onClick={() => void refresh()}>
        {busy ? '正在检查…' : '重新检查'}
      </button>
    </section>
  )
}
