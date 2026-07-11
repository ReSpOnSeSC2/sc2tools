"use client";

import { buildGrudgeLine, grudgeInputFromLive } from "@/lib/grudge";
import type { LiveGamePayload } from "../types";

/**
 * GrudgeLineRow — the rivalry storyline the Grudge Engine derives from a
 * live payload's head-to-head / history. Broadcast-safe and additive:
 * renders NOTHING when there's no story (first meeting, no history), so
 * dropping it into a widget never changes that widget's empty-state
 * behaviour. Inline styles only (OBS Browser Source-safe); the accent
 * pill reads the same `--ov-accent` theme var the shell chrome uses.
 */
export function GrudgeLineRow({ live }: { live: LiveGamePayload | null }) {
  const grudge = buildGrudgeLine(grudgeInputFromLive(live));
  if (!grudge) return null;
  return (
    <div
      style={{
        marginTop: 8,
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        fontSize: 13,
        lineHeight: 1.35,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          padding: "2px 8px",
          borderRadius: 999,
          color: "#0e1218",
          background: "var(--ov-accent, #e6b450)",
          whiteSpace: "nowrap",
        }}
      >
        {grudge.tag}
      </span>
      <span style={{ opacity: 0.92 }}>{grudge.line}</span>
    </div>
  );
}
