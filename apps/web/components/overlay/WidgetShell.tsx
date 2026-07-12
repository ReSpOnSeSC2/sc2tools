"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { coerceRace } from "@/lib/race";
import { resolveRaceIcon } from "@/lib/sc2-icons";

type Slot =
  | "top-center"
  | "top-center-1"
  | "top-center-2"
  | "top-center-3"
  | "top-right"
  | "top-right-mmr"
  | "bottom-center"
  | "bottom-left"
  | "bottom-right";

export type Accent = "gold" | "cyan" | "magenta" | "green" | "red" | "neutral";

type WidgetShellProps = {
  slot?: Slot;
  accent?: Accent;
  /** When set, takes precedence over `accent` and tints by race. */
  race?: string;
  visible?: boolean;
  width?: number;
  /** Adds a soft pulsing cyan halo behind the panel for primary widgets. */
  halo?: boolean;
  children: ReactNode;
};

const SLOT_STYLE: Record<Slot, CSSProperties> = {
  "top-center": { top: 40, left: "50%", transform: "translateX(-50%)" },
  "top-center-1": { top: 130, left: "50%", transform: "translateX(-50%)" },
  "top-center-2": { top: 220, left: "50%", transform: "translateX(-50%)" },
  "top-center-3": { top: 310, left: "50%", transform: "translateX(-50%)" },
  "top-right": { top: 40, right: 40 },
  "top-right-mmr": { top: 150, right: 40 },
  "bottom-center": { bottom: 60, left: "50%", transform: "translateX(-50%)" },
  "bottom-left": { bottom: 40, left: 40 },
  "bottom-right": { bottom: 40, right: 40 },
};

const ACCENT_BG: Record<Accent, string> = {
  gold: "#e6b450",
  cyan: "#3ec0c7",
  magenta: "#d16ba5",
  green: "#3ec07a",
  red: "#ff6b6b",
  neutral: "#7c8cff",
};

const ACCENT_HALO: Record<Accent, string> = {
  gold: "rgba(230,180,80,0.18)",
  cyan: "rgba(62,192,199,0.22)",
  magenta: "rgba(209,107,165,0.18)",
  green: "rgba(62,192,122,0.18)",
  red: "rgba(255,107,107,0.18)",
  neutral: "rgba(124,140,255,0.18)",
};

const RACE_COLOR: Record<string, string> = {
  T: "#ff6b6b",
  Z: "#a78bfa",
  P: "#7c8cff",
  R: "#9aa3b2",
};

/**
 * Map a free-form race string to an Accent token. Used by widgets that
 * want their accent bar tinted by the opponent's race ("opponent
 * widget" → cyan for Protoss, red for Terran, magenta for Zerg).
 */
export function raceToAccent(race?: string): Accent {
  const r = (race || "").charAt(0).toUpperCase();
  if (r === "T") return "red";
  if (r === "Z") return "magenta";
  if (r === "P") return "cyan";
  return "neutral";
}

/**
 * Shared chrome for every overlay widget — gradient panel, left
 * accent bar, slot-aware position, optional cyan halo for emphasis.
 *
 * Tuned for OBS Browser Source readability at 1080p–1440p:
 *   - hard drop shadow + thin cyan rim → clean edges on chroma key
 *   - Inter system font, 14–18px content range
 *   - subtle fade-in transition; respects prefers-reduced-motion
 *     via the .widget-shell class scoped in app/overlay/layout.tsx
 *
 * THEMING: every piece of shell chrome reads a `--ov-*` CSS custom
 * property with the stock value as the var() fallback. The overlay
 * clients set those vars on their root when the URL carries a
 * ``?theme=`` param (see lib/overlayTheme.ts) — when it doesn't, no
 * var is defined and the fallbacks reproduce today's look at zero
 * cost. A themed accent (`--ov-accent`) deliberately overrides the
 * per-widget accent BAR/halo/rim only — semantic colours inside the
 * widget content (VICTORY green, DEFEAT red, race tints) are content,
 * not chrome, and stay untouched.
 */
export function WidgetShell({
  slot = "top-center",
  accent = "neutral",
  race,
  visible = true,
  width,
  halo = false,
  children,
}: WidgetShellProps) {
  const placement = SLOT_STYLE[slot];
  const effectiveAccent: Accent = race ? raceToAccent(race) : accent;
  const haloColor = ACCENT_HALO[effectiveAccent];

  return (
    <div
      className="widget-shell"
      style={shellStyle(placement, width || 380, visible, haloColor)}
    >
      <div
        className="widget-shell__panel"
        style={panelStyle()}
      >
        <span
          aria-hidden
          className="widget-shell__texture"
          style={textureStyle()}
        />
        <span
          aria-hidden
          className="widget-shell__ornament"
          style={ornamentStyle()}
        />
        {halo ? (
          <span
            aria-hidden
            className="widget-halo"
            style={haloStyle(haloColor)}
          />
        ) : null}
        <span
          aria-hidden
          className="widget-shell__accent"
          style={accentStyle(effectiveAccent)}
        />
        <div className="widget-shell__content" style={contentStyle()}>
          {children}
        </div>
      </div>
    </div>
  );
}

function shellStyle(
  placement: CSSProperties,
  width: number,
  visible: boolean,
  haloColor: string,
): CSSProperties {
  return {
    position: "absolute",
    ...placement,
    width,
    opacity: visible ? 1 : 0,
    transform: `${placement.transform || ""} ${visible ? "" : "translateY(-30px)"}`.trim(),
    transition:
      "opacity 220ms ease, transform 320ms cubic-bezier(.34,1.56,.64,1)",
    color: "#e6e8ee",
    borderRadius: "var(--ov-radius, 12px)",
    boxShadow: `var(--ov-shell-shadow, 0 6px 20px rgba(0,0,0,0.55), 0 0 0 1px var(--ov-rim, rgba(62,192,199,0.10)), 0 0 28px var(--ov-halo, ${haloColor}))`,
    zoom: "var(--ov-scale, 1)",
    pointerEvents: "none",
    fontFamily:
      "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
    fontFeatureSettings: '"tnum"',
  };
}

function panelStyle(): CSSProperties {
  return {
    position: "relative",
    width: "100%",
    display: "flex",
    flexDirection: "var(--ov-panel-flow, row)" as CSSProperties["flexDirection"],
    overflow: "hidden",
    isolation: "isolate",
    background:
      "var(--ov-panel-bg, linear-gradient(135deg, rgba(11,13,18,0.94) 0%, rgba(22,26,35,0.94) 100%))",
    borderRadius: "var(--ov-radius, 12px)",
    border: "var(--ov-shell-border, 1px solid rgba(255,255,255,0.10))",
    clipPath: "var(--ov-clip, none)",
    color: "#e6e8ee",
    minWidth: 0,
  };
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

function accentStyle(accent: Accent): CSSProperties {
  return {
    flex: "0 0 var(--ov-accent-size, 6px)",
    background: `var(--ov-accent-track, var(--ov-accent, ${ACCENT_BG[accent]}))`,
    position: "relative",
    zIndex: 2,
  };
}

function contentStyle(): CSSProperties {
  return {
    flex: 1,
    padding: "var(--ov-padding, 14px 18px)",
    position: "relative",
    zIndex: 2,
    minWidth: 0,
  };
}

export function WidgetHeader({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        fontSize: 18,
        lineHeight: 1.2,
        fontWeight: 600,
        letterSpacing: "var(--ov-header-tracking, -0.01em)",
      }}
    >
      {children}
    </div>
  );
}

export function WidgetFooter({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        marginTop: 6,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        fontSize: 13,
        lineHeight: 1.3,
        opacity: 0.85,
      }}
    >
      {children}
    </div>
  );
}

export function Dim({ children }: { children: ReactNode }) {
  return (
    <span style={{ opacity: 0.55, fontSize: 12, letterSpacing: "0.01em" }}>
      {children}
    </span>
  );
}

/**
 * RevealedTag — small cyan pill surfacing an opponent's SC2Pulse
 * "revealed" identity (the pro/main name behind a barcode). For a
 * barcode opponent the bars are unreadable, so the revealed name is the
 * single most useful label on the widget — render it inline next to the
 * raw name. Renders nothing when there's no reveal or it's identical to
 * the already-shown name. Inline styles only (OBS Browser Source-safe).
 */
export function RevealedTag({
  name,
  size = 13,
}: {
  name?: string | null;
  rawName?: string | null;
  size?: number;
}) {
  const tag = typeof name === "string" ? name.trim() : "";
  if (!tag) return null;
  return (
    <span
      title="Revealed identity (SC2Pulse)"
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 4,
        flexShrink: 0,
        fontSize: size,
        fontWeight: 700,
        padding: "1px 8px",
        borderRadius: 999,
        background: "rgba(34, 211, 238, 0.16)",
        color: "#67e8f9",
        whiteSpace: "nowrap",
        maxWidth: 220,
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      <span style={{ opacity: 0.65, fontSize: size - 2, fontWeight: 600 }}>
        aka
      </span>
      {tag}
    </span>
  );
}

/**
 * RaceIcon — renders the SC2 race SVG inline via a plain ``<img>`` tag.
 *
 * Earlier revisions delegated to the shared ``Icon`` primitive (which
 * uses ``next/image`` with ``loading="lazy"`` by default). In OBS
 * Browser Source's CEF environment lazy-loaded images sometimes never
 * fire — the page can be rendered offscreen / hidden when OBS is
 * minimised — and the streamer would see only the letter fallback chip
 * for the entire match. Skipping ``next/image`` and forcing
 * ``loading="eager"`` makes the icon render the moment the SVG bytes
 * land, which is what we want here: a tiny race glyph whose load
 * latency is dwarfed by the surrounding widget chrome.
 *
 * The text-chip fallback is kept as a graceful degradation path for
 * truly missing or unrecognised race strings — but the happy path now
 * always shows the icon.
 */
export function RaceIcon({
  race,
  size = 22,
}: {
  race?: string;
  size?: number;
}) {
  const [errored, setErrored] = useState(false);
  const r = (race || "").charAt(0).toUpperCase();
  const colour = RACE_COLOR[r] || RACE_COLOR.R;
  // Resolve to a canonical race name so the SVG path lookup works for
  // every shape the agent might emit: "Protoss", "P", "protoss", etc.
  const canonical = race ? coerceRace(race) : null;
  const src = canonical ? resolveRaceIcon(canonical) : null;
  const innerSize = Math.max(12, size - 6);

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: 5,
        background: `${colour}22`,
        padding: 2,
        flexShrink: 0,
      }}
      aria-label={canonical ? `Race ${canonical}` : "Unknown race"}
    >
      {src && !errored ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          width={innerSize}
          height={innerSize}
          loading="eager"
          decoding="sync"
          draggable={false}
          onError={() => setErrored(true)}
          style={{
            width: innerSize,
            height: innerSize,
            objectFit: "contain",
            display: "block",
          }}
        />
      ) : (
        <span
          aria-hidden
          style={{
            color: colour,
            fontSize: Math.max(10, size - 10),
            fontWeight: 700,
            lineHeight: 1,
          }}
        >
          {r || "?"}
        </span>
      )}
    </span>
  );
}
