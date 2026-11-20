/**
 * 讲解跟随的滚动决策：只在"这一句已经看不见 / 快到底了"时往下带一屏，
 * 其余时候一页都不动。
 *
 * 为什么单独成纯函数：真人讲一页文档时不会每句话都把纸往上拉；只有讲到接近
 * 页面底部，才整段往下翻。把阈值与目标位置放在这里，就能用单测锁住
 * "同一页内不来回跳"和"到底部才滚"这两条体验要求，而不用靠渲染测试去量像素。
 */

export interface FollowScrollInput {
  /** 当前高亮块在当前页里的纵向位置（相对页面顶端，CSS 像素）。 */
  readonly blockTop: number
  readonly blockHeight: number
  /** 当前页在滚动容器里的顶端位置（已含滚动量）。 */
  readonly pageTop: number
  /** 滚动容器当前 scrollTop。 */
  readonly viewTop: number
  readonly viewportHeight: number
  /** 这一句是否换了页（换页就该把新页带到眼前）。 */
  readonly pageChanged: boolean
  /** 只有页级锚点（没有文字层）：只按页定位，不做块居中。 */
  readonly pageLevel: boolean
}

/** 顶部留白：块被滚到视口上沿附近时往上收。 */
const TOP_MARGIN = 72
/** 底部触发线：块底越过"视口高 - 底部留白"才算到底。 */
const BOTTOM_MARGIN_MIN = 96
/** 顶部舒适带上限：块顶落在视口 45% 以内就算"在眼前"，不再为它滚动。 */
const COMFORT_RATIO = 0.45
/** 滚动后把块放在视口偏上的位置（约 28%），上方留出下一段的预读空间。 */
const LEAD_RATIO = 0.28

/**
 * 返回目标 scrollTop；`null` = 保持不动。
 *
 * 判定顺序刻意如此：
 * 1. 换页：直接对准新页的块（或页顶），这是"翻到下一页"，必须动；
 * 2. 同页内块已经越过顶部或接近底部：动一次，把块带回 28% 处；
 * 3. 其余：不动 —— 这正是"不要每说一句就上下滑一下"的落点。
 */
export function followScrollTop(input: FollowScrollInput): number | null {
  const bottomMargin = Math.max(BOTTOM_MARGIN_MIN, Math.round(input.viewportHeight * 0.16))
  const lead = Math.max(0, Math.round(input.viewportHeight * LEAD_RATIO))
  if (input.pageLevel) {
    if (!input.pageChanged) return null
    return Math.max(0, input.pageTop - 12)
  }
  const target = Math.max(0, input.blockTop - lead)
  if (input.pageChanged) return target
  const offset = input.blockTop - input.viewTop
  /*
    块顶已经在舒适带里（视口 7%–45%）：即使块很长、底部超出视口也不滚。
    没有这条，长段落里每一句都会因为"块底还没进视口"再滚一次 —— 正是要消除的抖动。
  */
  if (offset >= TOP_MARGIN && offset <= Math.round(input.viewportHeight * COMFORT_RATIO)) return null
  const above = offset < TOP_MARGIN
  const below = input.blockTop + input.blockHeight > input.viewTop + input.viewportHeight - bottomMargin
  return above || below ? target : null
}