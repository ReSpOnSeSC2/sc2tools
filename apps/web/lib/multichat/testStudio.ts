// Stream Studio Test-fire demo content. When the streamer clicks Test
// in Settings → Overlay for one of the studio widgets (chat-highlight,
// chat-poll, chat-alerts, stream-goals, session-recap), the cloud
// stamps a synthetic ``overlay:live`` payload (isTest + testWidget) at
// the token's socket room; the widget then renders THIS sample content
// for the standard test window so the streamer can position and style
// the source without live studio state from the Stream Dock.
//
// Everything here is unmistakably sample content ("Test fire" copy,
// obviously-synthetic names) — the same contract as the multichat demo
// stream (testMessages.ts) and every other widget's Test button (see
// apps/api/src/services/overlayLiveSamples).

import type { ChatEvent } from "./events";
import type { StudioGoal, StudioHighlight, StudioPoll } from "./useStudioState";
import type { SessionSummary } from "@/components/overlay/widgets/SessionWidget";

/**
 * Demo pinned message for the chat-highlight widget. ``nowMs`` stamps
 * the pin time so the card keys/animates exactly like a real pin.
 */
export function testHighlight(nowMs: number): StudioHighlight {
  return {
    platform: "twitch",
    user: "TestViewer",
    text: "Test fire! Pinned messages from the Stream Dock appear exactly like this.",
    atMs: nowMs,
  };
}

/** Demo poll for the chat-poll widget, opened at ``nowMs``. */
export function testPoll(nowMs: number): StudioPoll {
  return {
    question: "Test poll — which matchup next?",
    options: ["PvT", "PvZ", "PvP"],
    startedAtMs: nowMs,
    status: "open",
  };
}

/**
 * Scripted tally snapshots the poll widget steps through (one per
 * TEST_POLL_STEP_MS) so the demo shows the animated bars filling in —
 * a static tally would hide the widget's best feature.
 */
export const TEST_POLL_TALLY_STEPS: ReadonlyArray<{
  counts: number[];
  total: number;
}> = [
  { counts: [0, 0, 0], total: 0 },
  { counts: [2, 3, 1], total: 6 },
  { counts: [4, 6, 2], total: 12 },
  { counts: [6, 9, 3], total: 18 },
  { counts: [7, 11, 4], total: 22 },
];

/** Cadence of the demo poll tally steps. */
export const TEST_POLL_STEP_MS = 1_000;

/**
 * Demo platform events for the chat-alerts toaster — one per platform
 * and event flavor so the streamer sees the full alert range. Ids are
 * staggered off ``nowMs`` so the toaster's (platform, id) keys never
 * collide across repeated Test fires.
 */
export function testEvents(nowMs: number): ChatEvent[] {
  return [
    {
      platform: "twitch",
      id: `test-event-${nowMs}-0`,
      kind: "sub",
      user: "TestSubscriber",
      detail: "Test fire — a new Twitch sub alert looks like this",
      atMs: nowMs,
    },
    {
      platform: "kick",
      id: `test-event-${nowMs}-1`,
      kind: "raid",
      user: "TestRaider",
      detail: "raided with a test party",
      amount: "150",
      atMs: nowMs + 1,
    },
    {
      platform: "youtube",
      id: `test-event-${nowMs}-2`,
      kind: "superchat",
      user: "TestFan",
      detail: "sent a test Super Chat",
      amount: "$5.00",
      atMs: nowMs + 2,
    },
    {
      platform: "tiktok",
      id: `test-event-${nowMs}-3`,
      kind: "gift",
      user: "test.gifter",
      detail: "sent a test gift",
      amount: "×10",
      atMs: nowMs + 3,
    },
  ];
}

/** Cadence of the demo alert stream. */
export const TEST_EVENT_INTERVAL_MS = 2_000;

/** Demo goal bars for the stream-goals widget. */
export const TEST_GOALS: ReadonlyArray<StudioGoal> = [
  { label: "Test: Follower goal", current: 1168, target: 1200 },
  { label: "Test: Sub goal", current: 1, target: 10 },
];

/**
 * Fallback session block for the session-recap Test fire. ONLY used
 * when the test payload doesn't carry the sample ``session`` block
 * (older API); the recap card otherwise renders ``live.session``
 * exactly like a real Stream Dock recap trigger.
 */
export function testSession(): SessionSummary {
  return {
    wins: 4,
    losses: 2,
    games: 6,
    mmrStart: 4280,
    mmrCurrent: 4314,
    streak: { kind: "win", count: 2 },
    isTest: true,
  };
}
