/** 设置浮层在全屏舞台内的拖动坐标；窗口比浮层小时退回左上角。 */
export function dragPanelPosition(
  origin: { x: number; y: number },
  delta: { x: number; y: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const maxX = Math.max(0, viewport.width - panel.width)
  const maxY = Math.max(0, viewport.height - panel.height)
  return {
    x: Math.min(Math.max(0, origin.x + delta.x), maxX),
    y: Math.min(Math.max(0, origin.y + delta.y), maxY),
  }
}
