"use client";

import type { CSSProperties, ReactNode } from "react";

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

type Accent = "gold" | "cyan" | "magenta" | "green" | "red" | "neutral";

const SLOT_STYLE: Record<Slot, CSSProperties> = {
  "top-center": { top: 40, left: "50%", transform: "translateX(-50%)" },
  "top-center-1": { top: 118, left: "50%", transform: "translateX(-50%)" },
  "top-center-2": { top: 196, left: "50%", transform: "translateX(-50%)" },
  "top-center-3": { top: 274, left: "50%", transform: "translateX(-50%)" },
  "top-right": { top: 40, right: 40 },
  "top-right-mmr": { top: 130, right: 40 },
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

/**
 * Shared chrome for every overlay widget — gradient panel, left
 * accent bar, slot-aware position. All widgets use this so they
 * animate consistently and share styling tokens.
 */
export function WidgetShell({
  slot = "top-center",
  accent = "neutral",
  visible = true,
  width,
  children,
}: {
  slot?: Slot;
  accent?: Accent;
  visible?: boolean;
  width?: number;
  children: ReactNode;
}) {
  const placement = SLOT_STYLE[slot];

  return (
    <div
      className="widget-shell"
      style={{
        position: "absolute",
        ...placement,
        width: width || 340,
        opacity: visible ? 1 : 0,
        transform: `${placement.transform || ""} ${visible ? "" : "translateY(-30px)"}`.trim(),
        transition: "opacity 240ms ease, transform 320ms cubic-bezier(.34,1.56,.64,1)",
        background:
          "linear-gradient(135deg, rgba(11,13,18,0.92) 0%, rgba(22,26,35,0.92) 100%)",
        color: "#e6e8ee",
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
        pointerEvents: "none",
        display: "flex",
        overflow: "hidden",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          width: 6,
          background: ACCENT_BG[accent],
        }}
      />
      <div style={{ flex: 1, padding: "12px 16px" }}>{children}</div>
    </div>
  );
}

export function WidgetHeader({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 8,
        fontSize: 16,
        fontWeight: 600,
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
        marginTop: 4,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        fontSize: 12,
        opacity: 0.85,
      }}
    >
      {children}
    </div>
  );
}

export function Dim({ children }: { children: ReactNode }) {
  return <span style={{ opacity: 0.55, fontSize: 11 }}>{children}</span>;
}

export function RaceIcon({
  race,
  size = 18,
}: {
  race?: string;
  size?: number;
}) {
  const r = (race || "").charAt(0).toUpperCase();
  const colour =
    r === "T" ? "#ff6b6b" : r === "Z" ? "#a78bfa" : r === "P" ? "#7c8cff" : "#9aa3b2";
  const label = r || "?";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: 4,
        background: `${colour}33`,
        color: colour,
        fontSize: Math.max(10, size - 8),
        fontWeight: 700,
      }}
      aria-label={`Race ${r}`}
    >
      {label}
    </span>
  );
}
