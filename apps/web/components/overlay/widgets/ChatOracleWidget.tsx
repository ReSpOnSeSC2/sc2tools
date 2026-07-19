"use client";

/**
 * ChatOracleWidget — the Crystal Ball prediction game. While a game
 * is loading/running, chat calls ``!win`` / ``!loss``; when the
 * replay-verified result lands, the server scores every pick and
 * this widget plays the reveal: was chat right, who are the top
 * oracles. Idle state shows the oracle leaderboard; fully
 * transparent with no data.
 *
 * Data: boot summary + ``overlay:engagement`` broadcasts (window
 * open / live tally / settle). The shared ``overlay:live`` payload
 * is read ONLY for the Settings Test-fire flag.
 */

import { useEffect, useState, type CSSProperties } from "react";
import {
  sanitizeTally,
  useEngagementState,
  type OracleEntry,
  type PredictionTally,
} from "@/lib/multichat/useEngagementState";
import { useTestFireFlag } from "@/lib/multichat/useTestFireFlag";
import { PLATFORM_META } from "./MultiChatMessageList";
import type { LiveGamePayload } from "../types";

/** How long the settle reveal stays before falling back to idle. */
const REVEAL_MS = 12_000;

interface Settle {
  result: "win" | "loss";
  tally: PredictionTally;
  correctCount: number;
  pointsEach: number;
  topOracles: OracleEntry[];
}

export function ChatOracleWidget({
  token,
  engagementEvent,
  live,
}: {
  token: string;
  /** Latest raw ``overlay:engagement`` payload from the host. */
  engagementEvent?: unknown;
  /** Shared overlay payload — read ONLY for the Test-fire flag. */
  live?: LiveGamePayload | null;
}) {
  const { summary, lastEvent } = useEngagementState(
    token,
    engagementEvent ?? null,
  );
  const testActive = useTestFireFlag(live, "chat-oracle");

  const [settle, setSettle] = useState<Settle | null>(null);
  useEffect(() => {
    if (!lastEvent || lastEvent.type !== "prediction-settled") return;
    const tally = sanitizeTally(lastEvent.tally);
    setSettle({
      result: lastEvent.result === "win" ? "win" : "loss",
      tally,
      correctCount: Math.max(0, Math.round(Number(lastEvent.correctCount) || 0)),
      pointsEach: Math.max(0, Math.round(Number(lastEvent.pointsEach) || 0)),
      topOracles: Array.isArray(lastEvent.topOracles)
        ? (lastEvent.topOracles as OracleEntry[]).slice(0, 3)
        : [],
    });
    const timer = setTimeout(() => setSettle(null), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [lastEvent]);

  // Test fire: demo window with a lively tally, then a reveal.
  const [demoPhase, setDemoPhase] = useState<0 | 1 | 2>(0);
  useEffect(() => {
    if (!testActive) {
      setDemoPhase(0);
      return;
    }
    setDemoPhase(1);
    const t = setTimeout(() => setDemoPhase(2), 8_000);
    return () => clearTimeout(t);
  }, [testActive]);

  if (testActive) {
    return (
      <Frame test>
        {demoPhase === 2 ? (
          <RevealCard
            settle={{
              result: "win",
              tally: { win: 14, loss: 7, total: 21 },
              correctCount: 14,
              pointsEach: 10,
              topOracles: [
                { user: "TestOracle", platform: "twitch", score: 40, correct: 4, total: 5 },
                { user: "GruntyViewer", platform: "kick", score: 30, correct: 3, total: 4 },
              ],
            }}
          />
        ) : (
          <WindowCard
            opponent="TestOpponent"
            tally={{ win: 9, loss: 4, total: 13 }}
          />
        )}
      </Frame>
    );
  }

  if (settle) {
    return (
      <Frame>
        <RevealCard settle={settle} />
      </Frame>
    );
  }
  if (summary.prediction) {
    return (
      <Frame>
        <WindowCard
          opponent={summary.prediction.opponent}
          tally={summary.prediction.tally}
        />
      </Frame>
    );
  }
  if (summary.oracles.length > 0) {
    return (
      <Frame>
        <LeaderboardCard oracles={summary.oracles} />
      </Frame>
    );
  }
  return <div style={{ background: "transparent" }} />;
}

function Frame({ children, test }: { children: React.ReactNode; test?: boolean }) {
  return (
    <div style={frameStyle}>
      <style>{`
        .oracle-card { animation: ocPop 300ms cubic-bezier(.34,1.56,.64,1); }
        @keyframes ocPop { from { opacity: 0; transform: translateY(-8px) scale(.97); } to { opacity: 1; transform: none; } }
        .oracle-pulse { animation: ocPulse 1.6s ease-in-out infinite; }
        @keyframes ocPulse { 0%,100% { opacity: 1; } 50% { opacity: .65; } }
        @media (prefers-reduced-motion: reduce) { .oracle-card, .oracle-pulse { animation: none; } }
      `}</style>
      {test ? <div style={testTagStyle}>TEST</div> : null}
      {children}
    </div>
  );
}

function WindowCard({
  opponent,
  tally,
}: {
  opponent: string;
  tally: PredictionTally;
}) {
  const winPct = tally.total > 0 ? Math.round((tally.win / tally.total) * 100) : 50;
  return (
    <div className="oracle-card" style={cardStyle}>
      <div style={kickerStyle}>
        <span className="oracle-pulse">🔮</span> CRYSTAL BALL
      </div>
      <div style={titleStyle}>
        Call it{opponent ? ` vs ${opponent}` : ""} — type{" "}
        <b style={{ color: "#3ec07a" }}>!win</b> or{" "}
        <b style={{ color: "#e05656" }}>!loss</b>
      </div>
      <div style={trackStyle}>
        <div
          style={{
            height: "100%",
            width: `${winPct}%`,
            background: "linear-gradient(90deg, #2f9d63, #3ec07a)",
            borderRadius: 999,
            transition: "width 500ms ease",
          }}
        />
      </div>
      <div style={tallyRowStyle}>
        <span style={{ color: "#3ec07a", fontWeight: 800 }}>
          WIN {tally.win}
        </span>
        <span style={{ opacity: 0.6 }}>{tally.total} calls</span>
        <span style={{ color: "#e05656", fontWeight: 800 }}>
          {tally.loss} LOSS
        </span>
      </div>
    </div>
  );
}

function RevealCard({ settle }: { settle: Settle }) {
  const { result, tally, correctCount, pointsEach, topOracles } = settle;
  const majority = tally.win >= tally.loss ? "win" : "loss";
  const majorityPct =
    tally.total > 0
      ? Math.round((Math.max(tally.win, tally.loss) / tally.total) * 100)
      : 0;
  const chatRight = tally.total > 0 && majority === result;
  return (
    <div className="oracle-card" style={cardStyle}>
      <div style={kickerStyle}>🔮 THE ORACLE SPEAKS</div>
      <div style={titleStyle}>
        {tally.total === 0
          ? `Nobody called it — result: ${result.toUpperCase()}`
          : `Chat said ${majorityPct}% ${majority.toUpperCase()} — chat was ${chatRight ? "RIGHT" : "WRONG"}`}
      </div>
      {tally.total > 0 ? (
        <div style={tallyRowStyle}>
          <span style={{ fontWeight: 700 }}>
            {correctCount} oracle{correctCount === 1 ? "" : "s"} +{pointsEach} pts
          </span>
        </div>
      ) : null}
      {topOracles.length > 0 ? (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
          {topOracles.map((o, i) => (
            <OracleRow key={`${o.platform}:${o.user}`} rank={i + 1} entry={o} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LeaderboardCard({ oracles }: { oracles: OracleEntry[] }) {
  return (
    <div className="oracle-card" style={{ ...cardStyle, opacity: 0.92 }}>
      <div style={kickerStyle}>🔮 TOP ORACLES</div>
      <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 3 }}>
        {oracles.map((o, i) => (
          <OracleRow key={`${o.platform}:${o.user}`} rank={i + 1} entry={o} />
        ))}
      </div>
    </div>
  );
}

function OracleRow({ rank, entry }: { rank: number; entry: OracleEntry }) {
  const meta = PLATFORM_META[entry.platform] ?? PLATFORM_META.twitch;
  return (
    <div style={oracleRowStyle}>
      <span style={{ opacity: 0.55, fontVariantNumeric: "tabular-nums" }}>
        {rank}.
      </span>
      <span
        style={{
          ...chipStyle,
          background: meta.color,
          color: meta.fg,
        }}
      >
        {meta.short}
      </span>
      <span style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {entry.user}
      </span>
      <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
        {entry.score} pts
        <span style={{ opacity: 0.55 }}>
          {" "}
          · {entry.correct}/{entry.total}
        </span>
      </span>
    </div>
  );
}

/* ──────────────── styles ──────────────── */

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
  maxWidth: 360,
  background:
    "var(--ov-panel-bg, linear-gradient(135deg, rgba(11,13,18,0.94) 0%, rgba(22,26,35,0.94) 100%))",
  border: "1px solid rgba(150,110,240,0.4)",
  borderLeft: "4px solid #9b6ef0",
  borderRadius: "var(--ov-radius, 12px)",
  boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
  padding: "12px 14px",
  color: "#e6e8ee",
};

const kickerStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: "0.12em",
  color: "#b493f5",
};

const titleStyle: CSSProperties = {
  marginTop: 5,
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.35,
};

const trackStyle: CSSProperties = {
  marginTop: 8,
  height: 10,
  borderRadius: 999,
  background: "rgba(224,86,86,0.45)",
  overflow: "hidden",
};

const tallyRowStyle: CSSProperties = {
  marginTop: 6,
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 8,
  fontSize: 12,
};

const oracleRowStyle: CSSProperties = {
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
