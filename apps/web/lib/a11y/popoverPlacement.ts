const GUTTER = 16;
const PANEL_WIDTH = 352;

/** Shared horizontal clamp, relative to the trigger's left edge. */
export function notificationPanelPlacement(
  anchor: { left: number; right: number },
  viewportWidth: number,
): { left: number; width: number } {
  const width = Math.max(0, Math.min(PANEL_WIDTH, viewportWidth - GUTTER * 2));
  const maxLeft = viewportWidth - GUTTER - width;
  const viewportLeft = Math.min(Math.max(anchor.right - width, GUTTER), maxLeft);
  return { left: viewportLeft - anchor.left, width };
}

/** A fixed-position panel that flips above its trigger when space is better. */
export function popoverPlacement(
  anchor: { left: number; right: number; top: number; bottom: number },
  panelHeight: number,
  viewport: { width: number; height: number; left?: number; top?: number },
  preferredWidth = PANEL_WIDTH,
) {
  const horizontalGutter = Math.min(GUTTER, Math.max(0, viewport.width / 2));
  const verticalGutter = Math.min(GUTTER, Math.max(0, viewport.height / 2));
  const width = Math.max(0, Math.min(preferredWidth, viewport.width - horizontalGutter * 2));
  const viewportLeft = viewport.left ?? 0;
  const viewportTop = viewport.top ?? 0;
  const viewportRight = viewportLeft + viewport.width;
  const viewportBottom = viewportTop + viewport.height;
  const left = Math.max(viewportLeft + horizontalGutter, Math.min(anchor.right - width, viewportRight - horizontalGutter - width));
  const below = Math.max(0, viewportBottom - verticalGutter - anchor.bottom - 8);
  const above = Math.max(0, anchor.top - 8 - viewportTop - verticalGutter);
  const flipped = panelHeight > below && above > below;
  const maxHeight = Math.min(flipped ? above : below, viewport.height - verticalGutter * 2);
  const top = Math.max(viewportTop + verticalGutter, Math.min(
    flipped ? anchor.top - 8 - Math.min(panelHeight, maxHeight) : anchor.bottom + 8,
    viewportBottom - verticalGutter - Math.min(panelHeight, maxHeight),
  ));
  return { left, top, width, maxHeight };
}
