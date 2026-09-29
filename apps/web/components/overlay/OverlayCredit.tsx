/**
 * "Overlay by sc2tools.com" — the small on-stream credit.
 *
 * Design constraints (this renders ON STREAM, like ReconnectDot):
 *  - small and quiet: one line of 13px text on a translucent pill,
 *    no animation, never intercepts clicks;
 *  - it lives where a 1v1 StarCraft II screen and a typical camera
 *    placement leave room: the top-left corner over gameplay (SC2's own
 *    HUD sits top-right and along the bottom), bottom-centre on the
 *    full-canvas Starting Soon / BRB scenes;
 *  - the CALLER decides when it may show: only while overlay content is
 *    on screen, never on a scene that must stay transparent, and never
 *    when the Browser Source URL carries ``?credit=0``
 *    (lib/overlayCredit).
 */
import type { CSSProperties } from "react";
import { OVERLAY_CREDIT_TEXT } from "@/lib/overlayCredit";

export type OverlayCreditPlacement = "top-left" | "bottom-center";

const PLACEMENT_STYLE: Record<OverlayCreditPlacement, CSSProperties> = {
  "top-left": { top: 10, left: 12 },
  "bottom-center": { bottom: 18, left: "50%", transform: "translateX(-50%)" },
};

const BASE_STYLE: CSSProperties = {
  position: "fixed",
  zIndex: 40,
  pointerEvents: "none",
  padding: "3px 9px",
  borderRadius: 999,
  background: "rgba(8, 11, 16, 0.55)",
  color: "rgba(255, 255, 255, 0.8)",
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  fontSize: 13,
  fontWeight: 600,
  lineHeight: "18px",
  letterSpacing: "0.02em",
  whiteSpace: "nowrap",
  textShadow: "0 1px 2px rgba(0, 0, 0, 0.6)",
};

export function OverlayCredit({
  placement = "top-left",
  visible = true,
}: {
  placement?: OverlayCreditPlacement;
  /** The caller's show/hide decision; false renders nothing. */
  visible?: boolean;
}) {
  if (!visible) return null;
  return (
    <span data-testid="overlay-credit" data-placement={placement} style={{ ...BASE_STYLE, ...PLACEMENT_STYLE[placement] }}>
      {OVERLAY_CREDIT_TEXT}
    </span>
  );
}
