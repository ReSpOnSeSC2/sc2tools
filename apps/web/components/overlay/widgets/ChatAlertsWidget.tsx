"use client";

/**
 * ChatAlertsWidget — platform events (subs, raids, gifts, superchats,
 * follows…) as an on-stream alert toaster.
 *
 * Runs its own multichat feed (same engines as the chat widget — no
 * extra auth) and renders the normalized event stream: the newest
 * event as a prominent card that auto-dismisses after a few seconds,
 * with a small low-opacity stack of the previous events below it.
 * Perfectly transparent while nothing has happened.
 *
 * The shared ``overlay:live`` payload is read for one thing: the
 * Settings Test button. While a test fire targeting this widget is
 * inside its window, a scripted sequence of clearly-labelled sample
 * events feeds through the same toaster path, one every couple of
 * seconds (see lib/multichat/testStudio).
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { API_BASE } from "@/lib/clientApi";
import { EVENT_KIND_LABEL, type ChatEvent } from "@/lib/multichat/events";
import { useMultiChat } from "@/lib/multichat/useMultiChat";
import { useEventSounds } from "@/lib/multichat/useEventSounds";
import { useTestFireFlag } from "@/lib/multichat/useTestFireFlag";
import {
  TEST_EVENT_INTERVAL_MS,
  testEvents,
} from "@/lib/multichat/testStudio";
import type { LiveGamePayload } from "../types";
import { PLATFORM_META } from "./MultiChatMessageList";
import { useMultichatConfig } from "./MultiChatWidget";

/** How long the newest event stays prominent before joining the stack. */
const ALERT_VISIBLE_MS = 8_000;
/** Faded history entries kept under the prominent card. */
const STACK_SIZE = 3;

export function ChatAlertsWidget({
  token,
  studioEvent,
  live,
}: {
  token: string;
  /** Accepted for renderer uniformity — alerts are feed-driven. */
  studioEvent?: unknown;
  /** Shared overlay payload — read ONLY for the Test-fire flag. */
  live?: LiveGamePayload | null;
}) {
  void studioEvent;
  const { platforms, sound } = useMultichatConfig(token);
  const { events: feedEvents } = useMultiChat({
    apiBase: API_BASE,
    token,
    config: platforms,
  });

  // Test-fire demo stream — feed the sample events in one at a time
  // (first immediately) so each rides the normal prominent-card
  // promotion below, exactly like real platform events.
  const testActive = useTestFireFlag(live, "chat-alerts");
  const [demoEvents, setDemoEvents] = useState<ChatEvent[]>([]);
  useEffect(() => {
    if (!testActive) {
      setDemoEvents([]);
      return;
    }
    const sequence = testEvents(Date.now());
    setDemoEvents(sequence.slice(0, 1));
    let index = 1;
    const timer = setInterval(() => {
      if (index >= sequence.length) {
        clearInterval(timer);
        return;
      }
      const next = sequence[index];
      index += 1;
      setDemoEvents((prev) => [...prev, next]);
    }, TEST_EVENT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [testActive]);

  const events = testActive ? demoEvents : feedEvents;

  // Alert sounds — per-event-kind synthesized effects, configured in
  // Settings. Test-fire demo events ride the same path, so the Test
  // button auditions the sounds exactly as a real raid would.
  useEventSounds(events, sound);

  const newest = events.length > 0 ? events[events.length - 1] : null;
  const newestKey = newest ? `${newest.platform}:${newest.id}` : null;

  // Promote each newly-arrived event to the prominent slot for
  // ALERT_VISIBLE_MS, then let it fall back into the faded stack.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!newestKey) return;
    setActiveKey(newestKey);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setActiveKey(null), ALERT_VISIBLE_MS);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [newestKey]);

  if (events.length === 0) return <div style={{ background: "transparent" }} />;

  const prominent = activeKey === newestKey ? newest : null;
  const stack = events
    .slice(0, prominent ? events.length - 1 : events.length)
    .slice(-STACK_SIZE)
    .reverse();

  return (
    <div style={frameStyle}>
      <style>{`
        .chat-alert-card { animation: caPop 260ms cubic-bezier(.34,1.56,.64,1); }
        @keyframes caPop {
          from { opacity: 0; transform: translateY(-10px) scale(0.96); }
          to { opacity: 1; transform: none; }
        }
        @media (prefers-reduced-motion: reduce) {
          .chat-alert-card { animation: none; }
        }
      `}</style>
      {testActive ? <div style={testTagStyle}>TEST</div> : null}
      {prominent ? (
        <AlertCard key={`${prominent.platform}:${prominent.id}`} event={prominent} />
      ) : null}
      {stack.map((e) => (
        <div key={`${e.platform}:${e.id}`} style={stackRowStyle}>
          <span
            style={{
              ...miniChipStyle,
              background: PLATFORM_META[e.platform].color,
              color: PLATFORM_META[e.platform].fg,
            }}
          >
            {PLATFORM_META[e.platform].short}
          </span>
          <span style={{ fontWeight: 700 }}>{e.user}</span>
          <span style={{ opacity: 0.7 }}>{EVENT_KIND_LABEL[e.kind]}</span>
          {e.amount ? <span style={{ opacity: 0.7 }}>{e.amount}</span> : null}
        </div>
      ))}
    </div>
  );
}

function AlertCard({ event }: { event: ChatEvent }) {
  const meta = PLATFORM_META[event.platform];
  return (
    <div className="chat-alert-card" style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ ...miniChipStyle, background: meta.color, color: meta.fg }}>
          {meta.short}
        </span>
        <span style={kindStyle}>{EVENT_KIND_LABEL[event.kind]}</span>
        {event.amount ? <span style={amountStyle}>{event.amount}</span> : null}
      </div>
      <div style={{ marginTop: 6, fontSize: 18, fontWeight: 800, color: "#fff" }}>
        {event.user}
      </div>
      {event.detail ? (
        <div style={{ marginTop: 3, fontSize: 13, lineHeight: 1.4, color: "rgba(255,255,255,0.85)", overflowWrap: "anywhere" }}>
          {event.detail}
        </div>
      ) : null}
    </div>
  );
}

/* ──────────────── styles ──────────────── */

const frameStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  gap: 6,
  fontFamily: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
};

const cardStyle: CSSProperties = {
  width: "100%",
  minWidth: 240,
  maxWidth: 360,
  background:
    "var(--ov-panel-bg, linear-gradient(135deg, rgba(11,13,18,0.94) 0%, rgba(22,26,35,0.94) 100%))",
  border: "1px solid rgba(62,192,199,0.35)",
  borderLeft: "4px solid var(--ov-accent, #3ec0c7)",
  borderRadius: "var(--ov-radius, 12px)",
  boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
  padding: "12px 14px",
  color: "#e6e8ee",
};

// Matches the multichat status-row TEST chip.
const testTagStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.08em",
  color: "#f5b942",
};

const kindStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--ov-accent, #3ec0c7)",
};

const amountStyle: CSSProperties = {
  marginLeft: "auto",
  fontSize: 13,
  fontWeight: 800,
  color: "#e6b450",
  fontVariantNumeric: "tabular-nums",
};

const miniChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 24,
  height: 15,
  padding: "0 4px",
  borderRadius: 4,
  fontSize: 9,
  fontWeight: 800,
  letterSpacing: "0.04em",
  flexShrink: 0,
};

const stackRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  maxWidth: 360,
  padding: "5px 10px",
  borderRadius: 8,
  background: "rgba(11,13,18,0.65)",
  border: "1px solid rgba(255,255,255,0.06)",
  fontSize: 12,
  color: "rgba(255,255,255,0.8)",
  opacity: 0.6,
};
