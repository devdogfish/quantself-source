export type Rect = { left: number; top: number; right: number; bottom: number };
export type Side = "left" | "right" | "top" | "bottom";
const padding = 12, gap = 12;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

export function chooseTaskPopoverSide(anchor: Rect, width: number, height: number): Side {
  if (anchor.left >= 404) return "left";
  if (width - anchor.right >= 404) return "right";
  return height - anchor.bottom >= 260 || height - anchor.bottom >= anchor.top ? "bottom" : "top";
}

// Keep the opening side throughout a scroll. Follow the task until the panel reaches
// a viewport edge, then pin it there. A clipped source never hides the open editor.
export function positionTaskPopover(anchor: Rect, viewport: Rect, size: { width: number; height: number }, side: Side, sourceVisible: boolean) {
  const width = Math.min(size.width, viewport.right - viewport.left - padding * 2);
  const height = Math.min(size.height, viewport.bottom - viewport.top - padding * 2);
  const centerX = (anchor.left + anchor.right) / 2, centerY = (anchor.top + anchor.bottom) / 2;
  const x = clamp(side === "left" ? anchor.left - gap - width : side === "right" ? anchor.right + gap : centerX - width / 2, viewport.left + padding, viewport.right - padding - width);
  const y = clamp(side === "top" ? anchor.top - gap - height : side === "bottom" ? anchor.bottom + gap : centerY - height / 2, viewport.top + padding, viewport.bottom - padding - height);
  const horizontal = side === "left" || side === "right";
  const arrow = clamp(horizontal ? centerY - y : centerX - x, 28, (horizontal ? height : width) - 28);
  // An arrow is truthful only while its source is visible and on the correct side.
  const pointsToSource = side === "left" ? anchor.left >= x + width : side === "right" ? anchor.right <= x : side === "top" ? anchor.top >= y + height : anchor.bottom <= y;
  return { x, y, width, height, arrow, showArrow: sourceVisible && pointsToSource };
}
