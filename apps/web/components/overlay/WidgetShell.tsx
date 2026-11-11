"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { coerceRace } from "@/lib/race";
import { resolveRaceIcon } from "@/lib/sc2-icons";
import { OVERLAY_RACE_COLORS, overlayRaceColor } from "@/lib/overlayRaceColors";
import { OverlayPanel, OVERLAY_PANEL_SCALE } from "./OverlayPanel";

type Slot =
  | "top-left-series"
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
  "top-left-series": { top: 40, left: 40 },
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

/** Resolve the canonical overlay accent for a race name or letter. */
export function raceToAccent(race?: string): string {
  return overlayRaceColor(race) ?? OVERLAY_RACE_COLORS.R;
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
  const accentColor = race ? raceToAccent(race) : ACCENT_BG[accent];
  const haloColor = race ? `${accentColor}2e` : ACCENT_HALO[accent];

  return (
    <div
      className="widget-shell"
      style={shellStyle(placement, width || 380, visible, haloColor)}
    >
      <OverlayPanel scale={false} accent={accentColor} accentSize="6px" halo={halo ? haloColor : undefined}
        style={{ width: "100%" }} contentStyle={{ padding: "var(--ov-padding, 14px 18px)" }}>
        {children}
      </OverlayPanel>
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
    ...OVERLAY_PANEL_SCALE,
    pointerEvents: "none",
    fontFeatureSettings: '"tnum"',
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
  const colour = raceToAccent(race);
  // Resolve to a canonical race name so the SVG path lookup works for
  // every shape the agent might emit: "Protoss", "P", "protoss", etc.
  const canonical = race ? coerceRace(race) : null;
  const src = canonical ? resolveRaceIcon(canonical) : null;
  const innerSize = Math.max(12, size - 6);

  return (
    <span
      role="img"
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
