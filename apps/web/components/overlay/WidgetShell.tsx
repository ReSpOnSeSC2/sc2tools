"use client";

import type { CSSProperties, ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";

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
 */
export function WidgetShell({
  slot = "top-center",
  accent = "neutral",
  race,
  visible = true,
  width,
  halo = false,
  children,
}: {
  slot?: Slot;
  accent?: Accent;
  /** When set, takes precedence over `accent` and tints by race. */
  race?: string;
  visible?: boolean;
  width?: number;
  /** Adds a soft pulsing cyan halo behind the panel for primary widgets. */
  halo?: boolean;
  children: ReactNode;
}) {
  const placement = SLOT_STYLE[slot];
  const effectiveAccent: Accent = race ? raceToAccent(race) : accent;
  const haloColor = ACCENT_HALO[effectiveAccent];

  return (
    <div
      className="widget-shell"
      style={{
        position: "absolute",
        ...placement,
        width: width || 380,
        opacity: visible ? 1 : 0,
        transform: `${placement.transform || ""} ${visible ? "" : "translateY(-30px)"}`.trim(),
        transition: "opacity 220ms ease, transform 320ms cubic-bezier(.34,1.56,.64,1)",
        background:
          "linear-gradient(135deg, rgba(11,13,18,0.94) 0%, rgba(22,26,35,0.94) 100%)",
        color: "#e6e8ee",
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.10)",
        boxShadow: [
          "0 6px 20px rgba(0,0,0,0.55)",
          "0 0 0 1px rgba(62,192,199,0.10)",
          `0 0 28px ${haloColor}`,
        ].join(", "),
        pointerEvents: "none",
        display: "flex",
        overflow: "hidden",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        fontFeatureSettings: '"tnum"',
      }}
    >
      {halo ? (
        <span
          aria-hidden
          className="widget-halo"
          style={{
            position: "absolute",
            inset: -2,
            borderRadius: 14,
            background: `radial-gradient(closest-side, ${haloColor} 0%, transparent 70%)`,
            opacity: 0.7,
            animation: "widgetHaloPulse 8s ease-in-out infinite",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
      ) : null}
      <div
        style={{
          width: 6,
          background: ACCENT_BG[effectiveAccent],
          position: "relative",
          zIndex: 1,
        }}
      />
      <div
        style={{
          flex: 1,
          padding: "14px 18px",
          position: "relative",
          zIndex: 1,
          minWidth: 0,
        }}
      >
        {children}
      </div>
    </div>
  );
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
        letterSpacing: "-0.01em",
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
 * RaceIcon — uses the SC2 race SVG when available, falls back to a
 * race-letter chip if the asset is missing or fails to load.
 *
 * The Icon primitive ships its own missing-asset fallback (text chip),
 * so widgets stay readable on a stripped Browser Source profile that
 * hasn't loaded /icons/sc2/ yet.
 */
export function RaceIcon({
  race,
  size = 22,
}: {
  race?: string;
  size?: number;
}) {
  const r = (race || "").charAt(0).toUpperCase();
  const colour = RACE_COLOR[r] || RACE_COLOR.R;

  if (!race) {
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
          color: colour,
          fontSize: Math.max(10, size - 10),
          fontWeight: 700,
        }}
        aria-label="Unknown race"
      >
        ?
      </span>
    );
  }

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
      }}
      aria-label={`Race ${r || "?"}`}
    >
      <Icon
        name={race}
        kind="race"
        size={Math.max(12, size - 6)}
        decorative
        fallback={r || "?"}
      />
    </span>
  );
}
