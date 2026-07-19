"use client";

/**
 * ChatPollWidget — live chat poll with viewer voting via chat.
 *
 * The poll itself (question, options, open/closed) comes from the
 * studio state (Stream Dock); the VOTES come from the multichat feed
 * this widget runs itself — viewers type "!1" / "2" / "!vote 3" in
 * any connected chat and the tally updates live. When the streamer
 * closes the poll the rendered numbers freeze (the dock shows the
 * same final tally); clearing the poll makes the source transparent.
 *
 * The shared ``overlay:live`` payload is read for one thing: the
 * Settings Test button. While a test fire targeting this widget is
 * inside its window, a clearly-labelled sample poll renders instead
 * of the studio state, stepping through a scripted tally so the
 * animated bars demo themselves (see lib/multichat/testStudio).
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { API_BASE } from "@/lib/clientApi";
import { useMultiChat } from "@/lib/multichat/useMultiChat";
import { tallyPollVotes } from "@/lib/multichat/poll";
import { useStudioState } from "@/lib/multichat/useStudioState";
import { useTestFireFlag } from "@/lib/multichat/useTestFireFlag";
import {
  TEST_POLL_STEP_MS,
  TEST_POLL_TALLY_STEPS,
  testPoll,
} from "@/lib/multichat/testStudio";
import type { LiveGamePayload } from "../types";
import { useMultichatConfig } from "./MultiChatWidget";

export function ChatPollWidget({
  token,
  studioEvent,
  live,
}: {
  token: string;
  /** Latest raw ``overlay:multichat`` socket payload from the host. */
  studioEvent?: unknown;
  /** Shared overlay payload — read ONLY for the Test-fire flag. */
  live?: LiveGamePayload | null;
}) {
  const { platforms } = useMultichatConfig(token);
  const { messages } = useMultiChat({
    apiBase: API_BASE,
    token,
    config: platforms,
  });
  const state = useStudioState(token, studioEvent ?? null);
  const studioPoll = state.poll;

  // Test-fire demo poll: swap in the sample question and walk the
  // scripted tally one step per second so the bars animate.
  const testActive = useTestFireFlag(live, "chat-poll");
  const demoPoll = useMemo(
    () => (testActive ? testPoll(Date.now()) : null),
    [testActive],
  );
  const [testStep, setTestStep] = useState(0);
  useEffect(() => {
    if (!testActive) return;
    setTestStep(0);
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      if (step >= TEST_POLL_TALLY_STEPS.length) {
        clearInterval(timer);
        return;
      }
      setTestStep(step);
    }, TEST_POLL_STEP_MS);
    return () => clearInterval(timer);
  }, [testActive]);

  const poll = testActive ? demoPoll : studioPoll;

  const liveTally = useMemo(
    () => (studioPoll ? tallyPollVotes(messages, studioPoll) : null),
    [messages, studioPoll],
  );

  // Freeze the tally when the poll closes: keep updating a ref while
  // open, stop the moment status flips to "closed". A NEW poll (fresh
  // startedAtMs) resets the freeze.
  const frozenRef = useRef<{
    key: number;
    tally: { counts: number[]; total: number };
  } | null>(null);
  if (studioPoll && liveTally) {
    if (
      studioPoll.status === "open"
      || frozenRef.current?.key !== studioPoll.startedAtMs
    ) {
      frozenRef.current = { key: studioPoll.startedAtMs, tally: liveTally };
    }
  }
  const tally = testActive
    ? TEST_POLL_TALLY_STEPS[Math.min(testStep, TEST_POLL_TALLY_STEPS.length - 1)]
    : studioPoll
      ? frozenRef.current?.tally ?? liveTally
      : null;

  if (!poll || !tally) return <div style={{ background: "transparent" }} />;

  const closed = poll.status === "closed";
  const leader = closed ? Math.max(...tally.counts) : -1;

  return (
    <div style={frameStyle}>
      <div style={cardStyle}>
        <div style={headerRowStyle}>
          <span style={titleStyle}>
            CHAT POLL
            {testActive ? <span style={testTagStyle}>TEST</span> : null}
          </span>
          {closed ? <span style={finalTagStyle}>FINAL</span> : null}
        </div>
        <div style={questionStyle}>{poll.question}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
          {poll.options.map((option, i) => {
            const count = tally.counts[i] ?? 0;
            const pct = tally.total > 0 ? Math.round((count / tally.total) * 100) : 0;
            const winning = closed && count === leader && leader > 0;
            return (
              <div key={`${i}:${option}`}>
                <div style={optionRowStyle}>
                  <span style={{ fontWeight: winning ? 800 : 600, color: winning ? "#3ec07a" : "rgba(255,255,255,0.92)" }}>
                    {i + 1}. {option}
                  </span>
                  <span style={countStyle}>
                    {count} · {pct}%
                  </span>
                </div>
                <div style={trackStyle}>
                  <div
                    style={{
                      ...fillStyle,
                      width: `${pct}%`,
                      background: winning
                        ? "linear-gradient(90deg, #2f9d63, #3ec07a)"
                        : "linear-gradient(90deg, var(--ov-accent, #3ec0c7), rgba(62,192,199,0.55))",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div style={footerStyle}>
          <span>
            {tally.total} vote{tally.total === 1 ? "" : "s"}
          </span>
          {closed ? null : (
            <span style={{ opacity: 0.65 }}>
              vote with !1 / !2 in chat
            </span>
          )}
        </div>
        {/* Build votes: the winner's real win-rate seals the pick. */}
        {closed && poll.meta?.kind === "build" && leader > 0
          ? (() => {
              const winIdx = tally.counts.indexOf(leader);
              const winner = poll.options[winIdx];
              const wr = winner ? poll.meta?.winRates[winner] : undefined;
              return winner ? (
                <div style={buildWinnerStyle}>
                  Chat picked: <b>{winner}</b>
                  {wr !== undefined ? (
                    <span style={{ opacity: 0.75 }}> — {wr}% win rate</span>
                  ) : null}
                </div>
              ) : null;
            })()
          : null}
      </div>
    </div>
  );
}

/* ──────────────── styles ──────────────── */

const buildWinnerStyle: CSSProperties = {
  marginTop: 8,
  paddingTop: 8,
  borderTop: "1px solid rgba(255,255,255,0.12)",
  fontSize: 13,
  color: "#3ec07a",
};

const frameStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "flex-start",
};

const cardStyle: CSSProperties = {
  width: "100%",
  minWidth: 260,
  maxWidth: 420,
  background:
    "var(--ov-panel-bg, linear-gradient(135deg, rgba(11,13,18,0.94) 0%, rgba(22,26,35,0.94) 100%))",
  border: "var(--ov-shell-border, 1px solid rgba(255,255,255,0.10))",
  borderRadius: "var(--ov-radius, 12px)",
  boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
  padding: "14px 16px",
  color: "#e6e8ee",
  fontFamily: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
};

const titleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: "0.14em",
  color: "var(--ov-accent, #3ec0c7)",
};

// Matches the multichat status-row TEST chip.
const testTagStyle: CSSProperties = {
  marginLeft: 8,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.08em",
  color: "#f5b942",
};

const finalTagStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: "0.12em",
  padding: "2px 8px",
  borderRadius: 999,
  background: "rgba(230,180,80,0.18)",
  color: "#e6b450",
};

const questionStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 17,
  fontWeight: 700,
  lineHeight: 1.35,
  color: "rgba(255,255,255,0.95)",
  overflowWrap: "anywhere",
};

const optionRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 10,
  fontSize: 13,
  marginBottom: 4,
};

const countStyle: CSSProperties = {
  fontSize: 12,
  fontVariantNumeric: "tabular-nums",
  color: "rgba(255,255,255,0.7)",
  flexShrink: 0,
};

const trackStyle: CSSProperties = {
  height: 8,
  borderRadius: 999,
  background: "rgba(255,255,255,0.08)",
  overflow: "hidden",
};

const fillStyle: CSSProperties = {
  height: "100%",
  borderRadius: 999,
  transition: "width 400ms ease",
};

const footerStyle: CSSProperties = {
  marginTop: 12,
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 10,
  fontSize: 12,
  color: "rgba(255,255,255,0.75)",
  fontVariantNumeric: "tabular-nums",
};
