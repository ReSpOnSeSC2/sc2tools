import { projectX, projectY, type PlaybackBounds } from "./mapReplay";

/**
 * Numbered pins a host draws on the map replayer — the Replay Review
 * Exchange's map-pinned comments. World coordinates, like every other
 * playback position. A pin shows while the clock is near its moment
 * (``t`` … ``endT``), and always while ``active`` or being placed.
 */
export type ReplayMapMarker = {
  id: string;
  x: number;
  y: number;
  t: number;
  endT?: number | null;
  label: string;
  active?: boolean;
  /** An unsaved pin the viewer is placing — drawn dashed. */
  draft?: boolean;
};

/** Seconds before / after a pin's moment during which it is drawn. */
export const MARKER_LEAD_SEC = 3;
export const MARKER_TRAIL_SEC = 8;
export const MARKER_RADIUS_PX = 11;

type Projection = { k: number; ox: number; oy: number };
type View = { z: number; ox: number; oy: number };

function screenPoint(bounds: PlaybackBounds, proj: Projection, view: View, m: ReplayMapMarker) {
  return {
    sx: view.ox + view.z * projectX(bounds, proj, m.x),
    sy: view.oy + view.z * projectY(bounds, proj, m.y),
  };
}

/** The pin under a canvas-local point (CSS px), if any. */
export function markerAt(
  markers: readonly ReplayMapMarker[],
  bounds: PlaybackBounds,
  proj: Projection,
  view: View,
  pt: { x: number; y: number },
): ReplayMapMarker | undefined {
  return markers.find((m) => {
    const { sx, sy } = screenPoint(bounds, proj, view, m);
    return Math.hypot(pt.x - sx, pt.y - sy) <= MARKER_RADIUS_PX + 2;
  });
}

/**
 * Draw the pins in SCREEN space (after the stage vignette) so they keep
 * a constant, legible size at every zoom and are never darkened.
 */
export function drawMarkers(
  ctx: CanvasRenderingContext2D,
  bounds: PlaybackBounds,
  proj: Projection,
  t: number,
  view: View,
  w: number,
  h: number,
  markers: readonly ReplayMapMarker[],
) {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 11px ui-sans-serif, system-ui, sans-serif";
  for (const m of markers) {
    const end = typeof m.endT === "number" ? m.endT : m.t;
    const near = t >= m.t - MARKER_LEAD_SEC && t <= end + MARKER_TRAIL_SEC;
    if (!near && !m.active && !m.draft) continue;
    const { sx, sy } = screenPoint(bounds, proj, view, m);
    if (sx < -MARKER_RADIUS_PX || sy < -MARKER_RADIUS_PX || sx > w + MARKER_RADIUS_PX || sy > h + MARKER_RADIUS_PX) continue;
    ctx.globalAlpha = near || m.draft ? 1 : 0.55;
    ctx.beginPath();
    ctx.arc(sx, sy, MARKER_RADIUS_PX, 0, Math.PI * 2);
    ctx.fillStyle = m.draft ? "rgba(7,10,15,0.85)" : m.active ? "#f0c43c" : "#3ee0d6";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = m.draft ? "#f0c43c" : "#070a0f";
    if (m.draft) ctx.setLineDash([3, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = m.draft ? "#f0c43c" : "#070a0f";
    ctx.fillText(m.label, sx, sy + 0.5);
  }
  ctx.restore();
}
