// Chat poll tally — pure vote counting over the multichat feed, plus the
// poll timer, presets and the one vote syntax every surface shows.
// No I/O, no React; unit-tested in __tests__/poll.test.ts.

import type { ChatMessage } from "./types";

/** The timers a poll can run for, in seconds (the server's allowlist). */
export const POLL_DURATIONS_SEC = [30, 60, 120, 300] as const;
export type PollDurationSec = (typeof POLL_DURATIONS_SEC)[number];

export const POLL_DURATION_LABELS: Record<PollDurationSec, string> = {
  30: "30 s",
  60: "1 min",
  120: "2 min",
  300: "5 min",
};

/**
 * The server owns poll deadlines. Clients allow this much clock skew: a
 * closed timed poll keeps counting late-arriving votes cast before its
 * cutoff for this long, then its result is frozen.
 */
export const POLL_CLOCK_SKEW_MS = 2_000;

export function isPollDuration(value: unknown): value is PollDurationSec {
  return POLL_DURATIONS_SEC.includes(value as PollDurationSec);
}

/** The vote syntaxes POLL_VOTE_HINT shows; the parser accepts each one. */
export const POLL_VOTE_EXAMPLES = ["2", "!vote 2"] as const;

/** The single vote instruction used by the Dock, the widget and the guides. */
export const POLL_VOTE_HINT = `Vote by typing the number (${POLL_VOTE_EXAMPLES[0]}) or ${POLL_VOTE_EXAMPLES[1]}`;

export type PollPreset =
  | { id: string; question: string; options: readonly string[]; mode: "custom" }
  | { id: string; question: string; mode: "build" };

/** One tap fills the poll form; "Which build next?" opens Build vote. */
export const POLL_PRESETS: readonly PollPreset[] = [
  { id: "win-or-lose", question: "Win or lose this game?", options: ["Win", "Lose"], mode: "custom" },
  { id: "opponent-race", question: "Next opponent's race?", options: ["Terran", "Zerg", "Protoss"], mode: "custom" },
  { id: "game-length", question: "How long will the next game last?", options: ["Under 10 min", "10–20 min", "20+ min"], mode: "custom" },
  { id: "which-build", question: "Which build next?", mode: "build" },
];

/**
 * Parse a chat line as a poll vote. Accepted syntaxes (whitespace
 * trimmed, 1-based option number N):
 *
 *   "N"        — "2" (shown in POLL_VOTE_HINT)
 *   "!vote N"  — "!vote 2" (case-insensitive keyword; shown in the hint)
 *   "!N"       — "!2" (older on-stream instruction, still accepted)
 *
 * Returns the ZERO-based option index, or null when the line isn't a
 * vote or N is out of range for the option list.
 */
export function parsePollVote(text: string, optionCount: number): number | null {
  const trimmed = text.trim();
  const match =
    /^!?(\d{1,2})$/.exec(trimmed) ?? /^!vote\s+(\d{1,2})$/i.exec(trimmed);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < 1 || n > optionCount) return null;
  return n - 1;
}

/** The timing fields a poll may carry (all server-stamped). */
export type PollTiming = {
  startedAtMs: number;
  status: string;
  durationSec?: number;
  endsAtMs?: number;
  closedAtMs?: number;
};

/**
 * The latest vote time that counts: the server's close stamp, else the
 * deadline of a timed poll, else null (an open untimed poll, or a legacy
 * closed poll without a stamp).
 */
export function pollVoteCutoffMs(poll: PollTiming): number | null {
  if (typeof poll.closedAtMs === "number" && Number.isFinite(poll.closedAtMs)) return poll.closedAtMs;
  if (typeof poll.endsAtMs === "number" && Number.isFinite(poll.endsAtMs)) return poll.endsAtMs;
  return null;
}

/** Closed by the server, or past its deadline on this clock. */
export function pollIsClosed(poll: PollTiming, nowMs: number): boolean {
  return poll.status === "closed" || (typeof poll.endsAtMs === "number" && nowMs >= poll.endsAtMs);
}

/** Milliseconds left on a running timed poll, or null when it has no timer. */
export function pollRemainingMs(poll: PollTiming, nowMs: number): number | null {
  if (poll.status === "closed" || typeof poll.endsAtMs !== "number") return null;
  return Math.max(0, poll.endsAtMs - nowMs);
}

/** "0:42" for a countdown; partial seconds round up so 0:00 means done. */
export function formatPollRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * True while a closed timed poll may still receive late votes cast before
 * its cutoff (feed latency and clock skew). After that the shown result
 * freezes, so a feed that drops old messages cannot shrink it.
 */
export function pollResultSettling(poll: PollTiming, nowMs: number): boolean {
  const cutoff = pollVoteCutoffMs(poll);
  return cutoff !== null && nowMs < cutoff + POLL_CLOCK_SKEW_MS;
}

/**
 * Tally votes for a studio poll over the multichat message feed.
 *
 * Rules:
 *   - a vote is a message whose trimmed text parses via parsePollVote;
 *   - only messages cast at/after ``startedAtMs`` count;
 *   - when the server stamped a cutoff (closedAtMs, or a timed poll's
 *     endsAtMs), messages cast after it never count, whenever they arrive;
 *   - ONE vote per (platform, user) — a later message replaces the
 *     voter's earlier choice (feed arrival order decides "later");
 *   - ``status`` does not filter here: callers freeze the rendered
 *     numbers once a closed poll has settled (see usePollTally).
 */
export function tallyPollVotes(
  messages: ReadonlyArray<ChatMessage>,
  poll: { options: string[] } & PollTiming,
): { counts: number[]; total: number } {
  const counts = poll.options.map(() => 0);
  const cutoff = pollVoteCutoffMs(poll);
  // (platform, user) → latest chosen option index. Usernames are
  // platform-scoped, so the same handle on Twitch and Kick is two
  // voters; case-folded so "Viewer" and "viewer" are one.
  const byVoter = new Map<string, number>();
  for (const m of messages) {
    if (m.atMs < poll.startedAtMs) continue;
    if (cutoff !== null && m.atMs > cutoff) continue;
    const choice = parsePollVote(m.text, poll.options.length);
    if (choice === null) continue;
    byVoter.set(`${m.platform}:${m.user.toLowerCase()}`, choice);
  }
  for (const choice of byVoter.values()) counts[choice] += 1;
  return { counts, total: byVoter.size };
}

/** What "Run again" refills: never timing, never an identity. */
export type PollForm = { question: string; options: string[]; durationSec: PollDurationSec | null };

const FORM_TEXT_MAX = 120;
const FORM_OPTIONS_MAX = 6;

/**
 * Bound a remembered poll form (from storage or a studio poll) to what
 * the Dock form and the server accept: a question, 2–6 options of at most
 * 120 characters and an allowlisted timer. Anything else returns null.
 */
export function sanitizePollForm(raw: unknown): PollForm | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const question = typeof value.question === "string" ? value.question.trim().slice(0, FORM_TEXT_MAX) : "";
  const options = (Array.isArray(value.options) ? value.options : [])
    .filter((option): option is string => typeof option === "string" && option.trim().length > 0)
    .map((option) => option.trim().slice(0, FORM_TEXT_MAX))
    .slice(0, FORM_OPTIONS_MAX);
  if (!question || options.length < 2) return null;
  return { question, options, durationSec: isPollDuration(value.durationSec) ? value.durationSec : null };
}
