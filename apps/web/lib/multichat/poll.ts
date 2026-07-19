// Chat poll tally — pure vote counting over the multichat feed.
// No I/O, no React; unit-tested in __tests__/poll.test.ts.

import type { ChatMessage } from "./types";

/**
 * Parse a chat line as a poll vote. Accepted syntaxes (whitespace
 * trimmed, 1-based option number N):
 *
 *   "!N"       — "!2"
 *   "N"        — "2"
 *   "!vote N"  — "!vote 2" (case-insensitive keyword)
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

/**
 * Tally votes for a studio poll over the multichat message feed.
 *
 * Rules:
 *   - a vote is a message whose trimmed text parses via parsePollVote;
 *   - only messages cast at/after ``startedAtMs`` count;
 *   - ONE vote per (platform, user) — a later message replaces the
 *     voter's earlier choice (feed arrival order decides "later");
 *   - ``status`` does not filter here: the tally counts every
 *     matching message, and the poll widget freezes its rendered
 *     numbers when the poll closes.
 */
export function tallyPollVotes(
  messages: ReadonlyArray<ChatMessage>,
  poll: { options: string[]; startedAtMs: number; status: string },
): { counts: number[]; total: number } {
  const counts = poll.options.map(() => 0);
  // (platform, user) → latest chosen option index. Usernames are
  // platform-scoped, so the same handle on Twitch and Kick is two
  // voters; case-folded so "Viewer" and "viewer" are one.
  const byVoter = new Map<string, number>();
  for (const m of messages) {
    if (m.atMs < poll.startedAtMs) continue;
    const choice = parsePollVote(m.text, poll.options.length);
    if (choice === null) continue;
    byVoter.set(`${m.platform}:${m.user.toLowerCase()}`, choice);
  }
  for (const choice of byVoter.values()) counts[choice] += 1;
  return { counts, total: byVoter.size };
}
