"use client";

import { OverlayPanel } from "../OverlayPanel";

/**
 * ClipFlagWidget — a small "🔥 Clip that!" pulse that appears for a
 * few seconds whenever the engagement service detects a clip-worthy
 * moment (chat spike or notable game event). Position it near the
 * camera frame; it stays fully transparent otherwise. The full
 * moment log (with timestamps and sample chat lines) lives in the
 * Stream Dock's Clip moments panel.
 */

import { useEffect, useState, type CSSProperties } from "react";
import { useEngagementState } from "@/lib/multichat/useEngagementState";
import { useTestFireFlag } from "@/lib/multichat/useTestFireFlag";
import type { LiveGamePayload } from "../types";

const SHOW_MS = 8_000;

export function ClipFlagWidget({
  token,
  engagementEvent,
  live,
}: {
  token: string;
  engagementEvent?: unknown;
  /** Shared overlay payload — read ONLY for the Test-fire flag. */
  live?: LiveGamePayload | null;
}) {
  const { lastEvent } = useEngagementState(token, engagementEvent ?? null);
  const testActive = useTestFireFlag(live, "clip-flag");

  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    if (!lastEvent || lastEvent.type !== "clip-moment") return;
    const moment = (lastEvent.moment ?? {}) as Record<string, unknown>;
    setReason(String(moment.reason ?? "Chat is going off"));
    const t = setTimeout(() => setReason(null), SHOW_MS);
    return () => clearTimeout(t);
  }, [lastEvent]);

  const shown = testActive
    ? "Test: chat spiked — 24 messages in 10s"
    : reason;
  if (!shown) return <div style={{ background: "transparent" }} />;

  return (
    <div style={frameStyle}>
      <style>{`
        .cf-chip { animation: cfIn 260ms cubic-bezier(.34,1.56,.64,1), cfGlow 1.2s ease-in-out infinite; }
        @keyframes cfIn { from { opacity: 0; transform: scale(.9); } to { opacity: 1; transform: none; } }
        @keyframes cfGlow { 0%,100% { box-shadow: 0 0 12px rgba(245,185,66,.5); } 50% { box-shadow: 0 0 26px rgba(245,185,66,.85); } }
        @media (prefers-reduced-motion: reduce) { .cf-chip { animation: none; } }
      `}</style>
      {testActive ? <div style={testTagStyle}>TEST</div> : null}
      <OverlayPanel className="cf-chip" style={chipStyle} contentStyle={{ display: "flex", alignItems: "center", gap: 8, padding: "var(--ov-padding, 8px 14px)" }}>
        <span style={{ fontSize: 16 }}>🔥</span>
        <span style={{ fontWeight: 800, letterSpacing: "0.06em" }}>
          CLIP THAT!
        </span>
        <span style={reasonStyle}>{shown}</span>
      </OverlayPanel>
    </div>
  );
}

const frameStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  alignItems: "flex-start",
  fontFamily: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
};

const testTagStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.08em",
  color: "#f5b942",
};

const chipStyle: CSSProperties = {
  display: "inline-flex",
  maxWidth: 380,
  border: "1px solid rgba(245,185,66,0.6)",
  borderRadius: "999px",
  color: "#f5b942",
  fontSize: 13,
};

const reasonStyle: CSSProperties = {
  color: "rgba(255,255,255,0.75)",
  fontSize: 11,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
