import type { CSSProperties } from "react";

export type GlowHaloColor = "cyan" | "accent" | "mixed";
export type GlowHaloPosition =
  | "center"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface GlowHaloProps {
  color?: GlowHaloColor;
  position?: GlowHaloPosition;
  /** 0 to 1 — opacity multiplier on the underlying halo color. */
  opacity?: number;
  /** Halo radius as a percentage of the parent box. */
  size?: number;
  className?: string;
}

/**
 * GlowHalo — radial-gradient backdrop, absolute-positioned inside its
 * (relative) parent. Use behind hero sections, feature cards, or
 * section dividers to draw the eye without adding chrome.
 */
export function GlowHalo({
  color = "cyan",
  position = "center",
  opacity = 1,
  size = 80,
  className = "",
}: GlowHaloProps) {
  const colorStop = colorVarFor(color);
  const { x, y } = positionFor(position);
  const style: CSSProperties = {
    background:
      color === "mixed"
        ? `radial-gradient(ellipse ${size}% ${size}% at ${x} ${y}, var(--halo-cyan) 0%, transparent 60%), radial-gradient(ellipse ${size}% ${size}% at calc(100% - ${x}) calc(100% - ${y}), var(--halo-accent) 0%, transparent 60%)`
        : `radial-gradient(ellipse ${size}% ${size}% at ${x} ${y}, ${colorStop} 0%, transparent 60%)`,
    opacity,
  };
  return (
    <div
      aria-hidden
      className={[
        "pointer-events-none absolute inset-0 -z-0",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
    />
  );
}

function colorVarFor(color: GlowHaloColor): string {
  switch (color) {
    case "cyan":
      return "var(--halo-cyan)";
    case "accent":
      return "var(--halo-accent)";
    case "mixed":
      return "var(--halo-cyan)";
  }
}

function positionFor(position: GlowHaloPosition): { x: string; y: string } {
  switch (position) {
    case "center": return { x: "50%", y: "50%" };
    case "top": return { x: "50%", y: "0%" };
    case "bottom": return { x: "50%", y: "100%" };
    case "top-left": return { x: "0%", y: "0%" };
    case "top-right": return { x: "100%", y: "0%" };
    case "bottom-left": return { x: "0%", y: "100%" };
    case "bottom-right": return { x: "100%", y: "100%" };
  }
}
