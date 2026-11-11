import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

export const OVERLAY_PANEL_SCALE = { zoom: "var(--ov-scale, 1)" } satisfies CSSProperties;

type Props = HTMLAttributes<HTMLElement> & {
  as?: "div" | "section";
  children: ReactNode;
  scale?: boolean;
  frame?: boolean;
  accent?: string;
  accentSize?: string;
  halo?: string;
  clipFallback?: string;
  contentStyle?: CSSProperties;
};

const BASE_FONT = "Inter, ui-sans-serif, system-ui, sans-serif";
const BASE_BACKGROUND = "linear-gradient(135deg, rgba(11,13,18,0.94) 0%, rgba(22,26,35,0.94) 100%)";
const BASE_BORDER = "1px solid rgba(255,255,255,0.10)";

/** Shared overlay chrome. Callers own sizing, slot placement and animation. */
export function OverlayPanel({
  as: Element = "div", scale = true, frame = true, accent = "transparent", accentSize = "0px",
  halo, clipFallback = "none", contentStyle, children, className, style, ...attributes
}: Props) {
  const panelStyle: CSSProperties = {
    ...style,
    color: style?.color ?? "#e6e8ee",
    fontFamily: `var(--ov-font, ${style?.fontFamily ?? BASE_FONT})`,
    ...(scale ? OVERLAY_PANEL_SCALE : {}),
  };
  if (frame) Object.assign(panelStyle, {
    position: style?.position ?? "relative",
    display: style?.display ?? "flex",
    flexDirection: "var(--ov-panel-flow, row)",
    overflow: "hidden",
    isolation: "isolate",
    minWidth: style?.minWidth ?? 0,
    background: `var(--ov-panel-bg, ${style?.background ?? BASE_BACKGROUND})`,
    border: `var(--ov-shell-border, ${style?.border ?? BASE_BORDER})`,
    borderRadius: `var(--ov-radius, ${style?.borderRadius ?? "12px"})`,
    boxShadow: style?.boxShadow ? `var(--ov-shell-shadow, ${style.boxShadow})` : undefined,
    clipPath: `var(--ov-clip, ${clipFallback})`,
  } satisfies CSSProperties);

  return <Element {...attributes} data-overlay-panel={frame ? "framed" : "plain"}
    className={frame ? ["widget-shell__panel", className].filter(Boolean).join(" ") : className} style={panelStyle}>
    {frame ? <>
      <span aria-hidden className="widget-shell__texture" style={textureStyle()} />
      <span aria-hidden className="widget-shell__ornament" style={ornamentStyle()} />
      {halo ? <span aria-hidden className="widget-halo" style={haloStyle(halo)} /> : null}
      <span aria-hidden className="widget-shell__accent" style={{
        flex: `0 0 var(--ov-accent-size, ${accentSize})`,
        background: `var(--ov-accent-track, var(--ov-accent, ${accent}))`,
        position: "relative", zIndex: 2,
      }} />
      <div className="widget-shell__content" style={{ flex: 1, position: "relative", zIndex: 2, minWidth: 0, ...contentStyle }}>{children}</div>
    </> : children}
  </Element>;
}

function textureStyle(): CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    zIndex: 0,
    pointerEvents: "none",
    background: "var(--ov-texture, none)",
    backgroundSize: "var(--ov-texture-size, auto)",
    opacity: "var(--ov-texture-opacity, 0)",
  };
}

function ornamentStyle(): CSSProperties {
  return {
    position: "absolute",
    inset: "var(--ov-ornament-inset, 0 0 auto auto)",
    width: "var(--ov-ornament-width, 0px)",
    height: "var(--ov-ornament-height, 0px)",
    zIndex: 1,
    pointerEvents: "none",
    background: "var(--ov-ornament-bg, transparent)",
    clipPath: "var(--ov-ornament-clip, none)",
    opacity: "var(--ov-ornament-opacity, 0)",
  };
}

function haloStyle(haloColor: string): CSSProperties {
  return {
    position: "absolute",
    inset: -2,
    borderRadius: "calc(var(--ov-radius, 12px) + 2px)",
    background: `radial-gradient(closest-side, var(--ov-halo, ${haloColor}) 0%, transparent 70%)`,
    opacity: 0.7,
    animation: "widgetHaloPulse 8s ease-in-out infinite",
    pointerEvents: "none",
    zIndex: 0,
  };
}

