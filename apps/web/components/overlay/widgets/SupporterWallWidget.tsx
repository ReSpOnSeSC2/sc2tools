"use client";

/**
 * SupporterWallWidget — cross-platform loyalty: today's top
 * supporters with race-themed unit ranks (Settings picks Protoss /
 * Terran / Zerg — see lib/multichat/rankLadders) and XP bars, plus a
 * level-up toast whenever a viewer crosses a threshold.
 * Viewers from all four platforms share one progression — chatting
 * anywhere earns XP (see the engagement service). Transparent until
 * someone has chatted.
 */

import { useEffect, useState, type CSSProperties } from "react";
import {
  useEngagementState,
  type WallEntry,
} from "@/lib/multichat/useEngagementState";
import { useTestFireFlag } from "@/lib/multichat/useTestFireFlag";
import { rankNameFor, sanitizeRankRace } from "@/lib/multichat/rankLadders";
import { PLATFORM_META } from "./MultiChatMessageList";
import { useMultichatConfig } from "./MultiChatWidget";
import type { LiveGamePayload } from "../types";

const TOAST_MS = 8_000;

const TEST_WALL: WallEntry[] = [
  { user: "TestGrinder", platform: "twitch", xp: 1240, level: 4, rank: "" },
  { user: "KickEnjoyer", platform: "kick", xp: 660, level: 3, rank: "" },
  { user: "TubeWatcher", platform: "youtube", xp: 300, level: 2, rank: "" },
  { user: "TokFan", platform: "tiktok", xp: 120, level: 1, rank: "" },
];

export function SupporterWallWidget({
  token,
  engagementEvent,
  live,
}: {
  token: string;
  engagementEvent?: unknown;
  /** Shared overlay payload — read ONLY for the Test-fire flag. */
  live?: LiveGamePayload | null;
}) {
  const { summary, lastEvent } = useEngagementState(
    token,
    engagementEvent ?? null,
  );
  const testActive = useTestFireFlag(live, "supporter-wall");
  // Rank theme rides the token config (Settings → loyalty rank race);
  // levels map to unit names HERE so a race switch re-themes every
  // viewer instantly — nothing rank-related is persisted.
  const { platforms } = useMultichatConfig(token);
  const race = sanitizeRankRace(
    (platforms as { engagement?: { rankRace?: string } } | null)?.engagement
      ?.rankRace,
  );

  const [toast, setToast] = useState<{ user: string; level: number } | null>(null);
  useEffect(() => {
    if (!lastEvent || lastEvent.type !== "level-up") return;
    setToast({
      user: String(lastEvent.user ?? ""),
      level: Math.max(0, Math.round(Number(lastEvent.level) || 0)),
    });
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [lastEvent]);

  const wall = testActive ? TEST_WALL : summary.wall;
  const showToast = testActive
    ? { user: "TestGrinder", level: 4 }
    : toast;
  if (wall.length === 0 && !showToast) {
    return <div style={{ background: "transparent" }} />;
  }
  const maxXp = Math.max(1, ...wall.map((w) => w.xp));

  return (
    <div style={frameStyle}>
      <style>{`
        .sw-card { animation: swIn 300ms ease-out; }
        @keyframes swIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
        @media (prefers-reduced-motion: reduce) { .sw-card { animation: none; } }
      `}</style>
      {testActive ? <div style={testTagStyle}>TEST</div> : null}
      {showToast ? (
        <div className="sw-card" style={{ ...cardStyle, borderLeft: "4px solid #f5b942" }}>
          <div style={{ ...kickerStyle, color: "#f5b942" }}>LEVEL UP</div>
          <div style={{ marginTop: 4, fontSize: 15, fontWeight: 800, color: "#fff" }}>
            {showToast.user} reached {rankNameFor(race, showToast.level)}!
          </div>
        </div>
      ) : null}
      {wall.length > 0 ? (
        <div className="sw-card" style={cardStyle}>
          <div style={kickerStyle}>⚡ TOP SUPPORTERS</div>
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
            {wall.map((w) => {
              const meta = PLATFORM_META[w.platform] ?? PLATFORM_META.twitch;
              return (
                <div key={`${w.platform}:${w.user}`} style={{ minWidth: 0 }}>
                  <div style={rowStyle}>
                    <span style={{ ...chipStyle, background: meta.color, color: meta.fg }}>
                      {meta.short}
                    </span>
                    <span style={nameStyle}>{w.user}</span>
                    <span style={rankStyle}>{rankNameFor(race, w.level)}</span>
                    <span style={xpStyle}>{w.xp} XP</span>
                  </div>
                  <div style={trackStyle}>
                    <div
                      style={{
                        height: "100%",
                        width: `${Math.max(4, Math.round((w.xp / maxXp) * 100))}%`,
                        borderRadius: 999,
                        background:
                          "linear-gradient(90deg, var(--ov-accent, #3ec0c7), #9b6ef0)",
                        transition: "width 600ms ease",
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const frameStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontFamily: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
};

const testTagStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.08em",
  color: "#f5b942",
};

const cardStyle: CSSProperties = {
  width: "100%",
  minWidth: 250,
  maxWidth: 340,
  background:
    "var(--ov-panel-bg, linear-gradient(135deg, rgba(11,13,18,0.94) 0%, rgba(22,26,35,0.94) 100%))",
  border: "var(--ov-shell-border, 1px solid rgba(255,255,255,0.10))",
  borderRadius: "var(--ov-radius, 12px)",
  boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
  padding: "10px 14px",
  color: "#e6e8ee",
};

const kickerStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: "0.12em",
  color: "var(--ov-accent, #3ec0c7)",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  fontSize: 12,
  minWidth: 0,
};

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 22,
  height: 14,
  padding: "0 4px",
  borderRadius: 4,
  fontSize: 9,
  fontWeight: 800,
  flexShrink: 0,
};

const nameStyle: CSSProperties = {
  fontWeight: 700,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const rankStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "#b493f5",
  flexShrink: 0,
};

const xpStyle: CSSProperties = {
  marginLeft: "auto",
  fontVariantNumeric: "tabular-nums",
  opacity: 0.8,
  flexShrink: 0,
};

const trackStyle: CSSProperties = {
  marginTop: 3,
  height: 5,
  borderRadius: 999,
  background: "rgba(255,255,255,0.08)",
  overflow: "hidden",
};
