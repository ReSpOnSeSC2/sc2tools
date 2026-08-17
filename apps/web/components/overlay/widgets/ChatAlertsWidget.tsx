"use client";

/**
 * ChatAlertsWidget — platform events (subs, raids, gifts, superchats,
 * follows…) as an on-stream alert toaster.
 *
 * Runs its own multichat feed (same engines as the chat widget — no
 * extra auth) and renders the normalized event stream: the newest
 * event as a prominent card that auto-dismisses after a few seconds,
 * with a small low-opacity stack of the previous events below it while
 * that newest alert is active.
 * Perfectly transparent while nothing has happened.
 *
 * The shared ``overlay:live`` payload is read for one thing: the
 * Settings Test button. While a test fire targeting this widget is
 * inside its window, a scripted sequence of clearly-labelled sample
 * events feeds through the same toaster path, one every couple of
 * seconds (see lib/multichat/testStudio).
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { API_BASE } from "@/lib/clientApi";
import {
  chatEventIdentity,
  EVENT_KIND_LABEL,
  type ChatEvent,
} from "@/lib/multichat/events";
import { useMultiChat } from "@/lib/multichat/useMultiChat";
import { useEngagementReporter } from "@/lib/multichat/useEngagementReporter";
import { useEventSounds } from "@/lib/multichat/useEventSounds";
import {
  blockedUserSet,
  excludeBlockedUsers,
  isBlockedUser,
} from "@/lib/multichat/appearance";
import { useStudioState } from "@/lib/multichat/useStudioState";
import { useTestFireFlag } from "@/lib/multichat/useTestFireFlag";
import {
  TEST_EVENT_INTERVAL_MS,
  testEvents,
} from "@/lib/multichat/testStudio";
import {
  overlayFeedTailIsQuiet,
  useOverlayBuildRefresh,
} from "../useOverlayBuildRefresh";
import type { LiveGamePayload } from "../types";
import { PLATFORM_META } from "./MultiChatMessageList";
import { useMultichatConfig } from "./MultiChatWidget";
import {
  useSpeechSynthesisIdle,
  useWidgetAudioOwner,
} from "./widgetAudio";

/** How long the newest event (and its temporary history) stays visible. */
const ALERT_VISIBLE_MS = 8_000;
/** Faded history entries kept under the prominent card. */
const STACK_SIZE = 3;
/** A 50-recipient gift bundle fits without dropping a single recognition. */
const ALERT_QUEUE_CAP = 60;
/** Near-live relay catch-up may still alert; older replay is timeline-only. */
const ALERT_REPLAY_GRACE_MS = 15_000;
const ALERT_SEEN_CAP = 500;

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
  const audioOwner = useWidgetAudioOwner();
  const { platforms, appearance, sound, loaded } = useMultichatConfig(token);
  const studio = useStudioState(token, studioEvent ?? null);
  const { events: feedEvents, messages: feedMessages } = useMultiChat({
    apiBase: API_BASE,
    token,
    config: platforms,
  });
  const blockedUsers = useMemo(
    () => blockedUserSet(appearance, studio.blockedUsers),
    [appearance, studio.blockedUsers],
  );
  const moderationReady = loaded && studio.snapshotReady;
  const moderatedMessages = useMemo(
    () => moderationReady
      ? excludeBlockedUsers(feedMessages, blockedUsers)
      : [],
    [blockedUsers, feedMessages, moderationReady],
  );
  const moderatedFeedEvents = useMemo(
    () => moderationReady
      ? excludeBlockedUsers(feedEvents, blockedUsers)
      : [],
    [blockedUsers, feedEvents, moderationReady],
  );
  useEngagementReporter(token, moderatedMessages, moderatedFeedEvents);

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

  const events = testActive ? demoEvents : moderatedFeedEvents;

  // A real queue, rather than "latest wins": a gift/sub burst must not
  // replace somebody before their recognition card was ever visible.
  const seenRef = useRef<Set<string>>(new Set());
  const [queue, setQueue] = useState<ChatEvent[]>([]);
  const [prominent, setProminent] = useState<ChatEvent | null>(null);
  const [history, setHistory] = useState<ChatEvent[]>([]);
  const feedTail = moderatedFeedEvents.at(-1);
  const feedTailIdentity = feedTail
    ? `${chatEventIdentity(feedTail)}:${feedTail.atMs}:${feedTail.amount ?? ""}`
    : "";
  const feedTailAtMs = feedTail?.atMs ?? 0;
  const initiallyQuiet =
    feedTailAtMs === 0
    || Date.now() - feedTailAtMs >= ALERT_REPLAY_GRACE_MS;
  const [feedQuietForReload, setFeedQuietForReload] = useState(initiallyQuiet);
  const [quietConfirmedTail, setQuietConfirmedTail] = useState<string | null>(
    () => initiallyQuiet ? feedTailIdentity : null,
  );
  const buildRefreshInitializedRef = useRef(false);
  const queueLengthRef = useRef(0);
  queueLengthRef.current = queue.length;
  const prominentAllowed = prominent
    ? !isBlockedUser(prominent.user, blockedUsers)
    : false;
  const visibleProminent = prominentAllowed ? prominent : null;
  const visibleHistory = history.filter(
    (event) => !isBlockedUser(event.user, blockedUsers),
  );
  useEffect(() => {
    // A Dock/Settings block can land while a card is already prominent or
    // waiting in the burst queue. Remove it immediately from every visual and
    // audio state, but deliberately keep seenRef intact so unblocking cannot
    // resurrect retained feed history as a new alert.
    setQueue((current) => current.filter(
      (event) => !isBlockedUser(event.user, blockedUsers),
    ));
    setProminent((current) => (
      current && isBlockedUser(current.user, blockedUsers) ? null : current
    ));
    setHistory((current) => current.filter(
      (event) => !isBlockedUser(event.user, blockedUsers),
    ));
  }, [blockedUsers]);
  useEffect(() => {
    const firstObservation = !buildRefreshInitializedRef.current;
    buildRefreshInitializedRef.current = true;
    if (feedTailAtMs === 0) {
      setQuietConfirmedTail(feedTailIdentity);
      setFeedQuietForReload(true);
      return;
    }
    const remaining = firstObservation
      ? ALERT_REPLAY_GRACE_MS - Math.max(0, Date.now() - feedTailAtMs)
      : ALERT_REPLAY_GRACE_MS;
    if (remaining <= 0) {
      setQuietConfirmedTail(feedTailIdentity);
      setFeedQuietForReload(true);
      return;
    }
    setFeedQuietForReload(false);
    const timer = setTimeout(() => {
      setQuietConfirmedTail(feedTailIdentity);
      setFeedQuietForReload(true);
    }, remaining);
    return () => clearTimeout(timer);
  }, [feedTailAtMs, feedTailIdentity]);
  const feedTailQuiet = overlayFeedTailIsQuiet(
    feedQuietForReload,
    feedTailIdentity,
    quietConfirmedTail,
  );
  useEffect(() => {
    const additions: ChatEvent[] = [];
    for (const event of events) {
      // If the alert Browser Source was merely a few seconds slower to mount,
      // it should still recognize the supporter. A real restart must not turn
      // the whole retained timeline into fresh sounds/toasts.
      if (
        event.replayed &&
        Date.now() - event.atMs > ALERT_REPLAY_GRACE_MS
      ) continue;
      const key = chatEventIdentity(event);
      if (seenRef.current.has(key)) {
        // Cumulative events (YouTube Jewels combos) update the one existing
        // card in place; they do not enqueue another donation or sound.
        if (event.updateKey || event.official) {
          setQueue((current) =>
            current.map((item) =>
              chatEventIdentity(item) === key ? event : item,
            ),
          );
          setProminent((current) =>
            current && chatEventIdentity(current) === key ? event : current,
          );
          setHistory((current) =>
            current.map((item) =>
              chatEventIdentity(item) === key ? event : item,
            ),
          );
        }
        continue;
      }
      seenRef.current.add(key);
      additions.push(event);
    }
    if (seenRef.current.size > ALERT_SEEN_CAP) {
      // Set iteration follows insertion order. Drop only the oldest identities
      // so the full recent replay window remains protected even though the
      // rendered feed itself retains fewer rows.
      const oldestFirst = seenRef.current.values();
      const excess = seenRef.current.size - ALERT_SEEN_CAP;
      for (let index = 0; index < excess; index += 1) {
        const oldest = oldestFirst.next().value;
        if (oldest !== undefined) seenRef.current.delete(oldest);
      }
    }
    if (additions.length > 0) {
      setQueue((current) => appendAlertQueue(current, additions));
    }
  }, [events]);

  useEffect(() => {
    if (prominent || queue.length === 0) return;
    const next = queue[0];
    setQueue((current) => current.slice(1));
    setProminent(next);
    setHistory((current) => [...current, next].slice(-(STACK_SIZE + 1)));
  }, [prominent, queue]);

  useEffect(() => {
    if (!prominent) return;
    // Large gift/sub bursts move briskly enough that everybody is seen while
    // ordinary one-off support still gets the full hero-card dwell.
    const backlog = queueLengthRef.current;
    const dwellMs =
      backlog >= 20 ? 2_000 : backlog >= 8 ? 4_000 : ALERT_VISIBLE_MS;
    const timer = setTimeout(() => setProminent(null), dwellMs);
    return () => clearTimeout(timer);
  }, [prominent]);

  // Sounds follow the visible queue (one supporter at a time), so a burst
  // is neither dropped nor collapsed into an inaudible pile-up.
  const audioSound = useMemo(
    () => (
      audioOwner
        ? sound
        : { ...(sound ?? {}), eventSoundsEnabled: false }
    ),
    [audioOwner, sound],
  );
  useEventSounds(visibleProminent ? [visibleProminent] : [], audioSound);
  const speechIdle = useSpeechSynthesisIdle(audioOwner);
  useOverlayBuildRefresh({
    enabled: !testActive,
    safeToReload:
      visibleProminent === null
      && queue.length === 0
      && feedTailQuiet
      && (!audioOwner || speechIdle),
  });

  const stack = visibleProminent
    ? visibleHistory.slice(0, -1).slice(-STACK_SIZE).reverse()
    : [];

  if (!visibleProminent) return <div style={{ background: "transparent" }} />;

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
      <AlertCard
        key={chatEventIdentity(visibleProminent)}
        event={visibleProminent}
      />
      {stack.map((e) => (
        <div key={chatEventIdentity(e)} style={stackRowStyle}>
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

/**
 * Preserve ordinary gift bundles in full. If a truly pathological burst
 * exceeds the bounded renderer queue, keep the earliest cards and append an
 * explicit summary instead of silently marking omitted supporters as seen.
 * Every individual event remains visible in the unified chat/Dock timeline.
 */
export function appendAlertQueue(
  current: ReadonlyArray<ChatEvent>,
  additions: ReadonlyArray<ChatEvent>,
): ChatEvent[] {
  const combined = [...current, ...additions];
  if (combined.length <= ALERT_QUEUE_CAP) return combined;

  const kept = combined.slice(0, ALERT_QUEUE_CAP - 1);
  const overflow = combined.slice(ALERT_QUEUE_CAP - 1);
  const last = overflow[overflow.length - 1];
  const overflowCount = overflow.reduce(
    (total, event) => total + representedAlertCount(event),
    0,
  );
  return [
    ...kept,
    {
      ...last,
      id: `alert-overflow:${overflow[0].atMs}:${last.atMs}:${overflowCount}`,
      user: `${overflowCount} more supporters`,
      detail: "recognized in the unified chat timeline",
      amount: `${overflowCount} events`,
    },
  ];
}

function representedAlertCount(event: ChatEvent): number {
  const match = event.id.match(/^alert-overflow:[^:]*:[^:]*:(\d+)$/);
  if (!match) return 1;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count > 0 ? count : 1;
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
