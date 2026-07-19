import { describe, expect, it } from "vitest";
import { parsePollVote, tallyPollVotes } from "../poll";
import type { ChatMessage, ChatPlatform } from "../types";

function msg(
  platform: ChatPlatform,
  user: string,
  text: string,
  atMs: number,
): ChatMessage {
  return { platform, id: `${platform}:${user}:${atMs}`, user, text, badges: [], atMs };
}

const POLL = { options: ["Zerg", "Protoss", "Terran"], startedAtMs: 1000, status: "open" };

describe("parsePollVote", () => {
  it("accepts bare numbers, bang numbers and !vote N", () => {
    expect(parsePollVote("1", 3)).toBe(0);
    expect(parsePollVote("!2", 3)).toBe(1);
    expect(parsePollVote("!vote 3", 3)).toBe(2);
    expect(parsePollVote("!VOTE 2", 3)).toBe(1);
    expect(parsePollVote("  !1  ", 3)).toBe(0);
  });

  it("rejects non-votes, zero and out-of-range numbers", () => {
    expect(parsePollVote("gg", 3)).toBeNull();
    expect(parsePollVote("0", 3)).toBeNull();
    expect(parsePollVote("!0", 3)).toBeNull();
    expect(parsePollVote("4", 3)).toBeNull();
    expect(parsePollVote("!vote 9", 3)).toBeNull();
    expect(parsePollVote("1 more thing", 3)).toBeNull();
    expect(parsePollVote("vote 1", 3)).toBeNull();
    expect(parsePollVote("!vote", 3)).toBeNull();
    expect(parsePollVote("!!1", 3)).toBeNull();
    expect(parsePollVote("-1", 3)).toBeNull();
    expect(parsePollVote("1.5", 3)).toBeNull();
  });
});

describe("tallyPollVotes", () => {
  it("counts one vote per option across both syntaxes", () => {
    const { counts, total } = tallyPollVotes(
      [
        msg("twitch", "alice", "!1", 2000),
        msg("twitch", "bob", "2", 2100),
        msg("kick", "carol", "!vote 3", 2200),
      ],
      POLL,
    );
    expect(counts).toEqual([1, 1, 1]);
    expect(total).toBe(3);
  });

  it("replaces a voter's earlier choice with their later one", () => {
    const { counts, total } = tallyPollVotes(
      [
        msg("twitch", "alice", "!1", 2000),
        msg("twitch", "alice", "!3", 2500),
      ],
      POLL,
    );
    expect(counts).toEqual([0, 0, 1]);
    expect(total).toBe(1);
  });

  it("scopes voters per platform — same handle on two platforms is two votes", () => {
    const { counts, total } = tallyPollVotes(
      [
        msg("twitch", "alice", "!1", 2000),
        msg("kick", "alice", "!2", 2100),
      ],
      POLL,
    );
    expect(counts).toEqual([1, 1, 0]);
    expect(total).toBe(2);
  });

  it("case-folds usernames within a platform", () => {
    const { counts, total } = tallyPollVotes(
      [
        msg("twitch", "Alice", "!1", 2000),
        msg("twitch", "alice", "!2", 2100),
      ],
      POLL,
    );
    expect(counts).toEqual([0, 1, 0]);
    expect(total).toBe(1);
  });

  it("ignores messages sent before the poll started", () => {
    const { counts, total } = tallyPollVotes(
      [
        msg("twitch", "early", "!1", 999),
        msg("twitch", "ontime", "!1", 1000),
      ],
      POLL,
    );
    expect(counts).toEqual([1, 0, 0]);
    expect(total).toBe(1);
  });

  it("ignores out-of-range and non-vote chatter", () => {
    const { counts, total } = tallyPollVotes(
      [
        msg("twitch", "alice", "!4", 2000),
        msg("twitch", "bob", "hello !1", 2100),
        msg("youtube", "carol", "!vote 2", 2200),
      ],
      POLL,
    );
    expect(counts).toEqual([0, 1, 0]);
    expect(total).toBe(1);
  });

  it("an out-of-range later message does NOT clear an earlier valid vote", () => {
    const { counts, total } = tallyPollVotes(
      [
        msg("twitch", "alice", "!2", 2000),
        msg("twitch", "alice", "!9", 2500),
      ],
      POLL,
    );
    expect(counts).toEqual([0, 1, 0]);
    expect(total).toBe(1);
  });

  it("returns zeroed counts for an empty feed", () => {
    const { counts, total } = tallyPollVotes([], POLL);
    expect(counts).toEqual([0, 0, 0]);
    expect(total).toBe(0);
  });

  it("counts matching messages regardless of poll status (freeze is the widget's job)", () => {
    const closed = { ...POLL, status: "closed" };
    const { counts, total } = tallyPollVotes(
      [msg("tiktok", "dave", "1", 2000)],
      closed,
    );
    expect(counts).toEqual([1, 0, 0]);
    expect(total).toBe(1);
  });
});
