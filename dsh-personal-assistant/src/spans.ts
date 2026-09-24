/**
 * 把一天的采样聚合成活动片段。
 *
 * 独立成模块是因为跟踪器和迁移必须用同一套聚合口径：跟踪器回答"我今天干了啥"，
 * 迁移把旧采样搬进观察库。两边算出来的片段不一致，搬进来的历史就和当天看到的对不上，
 * 用户会以为数据丢了。而放在 tracker 里的话迁移就得 import tracker——tracker 用了
 * 构造函数参数属性，Node 的 strip-only TypeScript 模式解析不了。
 */
import type { Classifier } from './classifier.ts'
import type { ActivitySpan } from './domain.ts'
import type { Sample } from './sampler.ts'

interface SpanDraft {
  app: string
  category: string
  title: string
  start: number
  end: number
}

/**
 * 聚合规则：连续且「进程 + 分类 + 提取后标题」完全相同的采样合并成一段，
 * 短于 minSpanMs 的段当噪声丢掉。
 *
 * 单独一个采样（前后都接不上）start 等于 end，长度 0，必然被丢掉——
 * 这是原有口径，一次前台切换抓不到停留时间，谈不上"在做什么"。
 */
export function buildSpansFrom(
  samples: readonly Sample[],
  classifier: Classifier,
  minSpanMs: number,
  sampleIntervalMs = 5000,
): ActivitySpan[] {
  const spans: ActivitySpan[] = []
  const maxGapMs = Math.max(1000, sampleIntervalMs) * 3
  let current: SpanDraft | null = null
  for (const sample of samples) {
    if (!Number.isFinite(sample.ts)) continue
    const classified = classifySample(sample, classifier)
    if (
      current
      && sample.ts >= current.end
      && sample.ts - current.end <= maxGapMs
      && current.app === classified.app
      && current.category === classified.category
      && current.title === classified.title
    ) {
      current.end = sample.ts
      continue
    }
    if (current) spans.push(finish(current))
    current = { ...classified, start: sample.ts, end: sample.ts }
  }
  if (current) spans.push(finish(current))
  return spans.filter(span => span.end - span.start >= minSpanMs)
}

function classifySample(sample: Sample, classifier: Classifier): { app: string; category: string; title: string } {
  if (sample.excluded) return { app: '', category: 'excluded', title: '' }
  if (sample.idle) return { app: '', category: 'idle', title: '' }
  const proc = sample.proc || 'unknown'
  const classified = classifier.classify(proc, sample.title ?? '')
  // 长时间无输入仍可能在阅读，只标记观察事实，不推断离席或完成工作。
  const noInput = Number.isFinite(sample.idleMs) && (sample.idleMs ?? 0) >= 300_000
  return { app: proc, category: noInput ? 'no-input' : classified.category, title: classified.title }
}

function finish(span: SpanDraft): ActivitySpan {
  return { start: span.start, end: span.end, app: span.app, category: span.category, title: span.title }
}
