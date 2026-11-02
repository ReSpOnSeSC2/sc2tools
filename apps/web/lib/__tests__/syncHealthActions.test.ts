import { describe, expect, it } from "vitest";
import { canRetrySyncReason, syncActionFeedback, SYNC_RETRY_REASONS } from "../syncHealthActions";

describe("private sync retry policy", () => {
  it("allows only explicit repair reasons and excludes intentional skips and date filtering", () => {
    expect([...SYNC_RETRY_REASONS]).toEqual(["player_unresolved", "parse_failed", "analysis_failed", "file_unstable", "playback_budget_exceeded", "unsupported_replay"]);
    for (const reason of SYNC_RETRY_REASONS) expect(canRetrySyncReason(reason)).toBe(true);
    for (const reason of ["ai_game", "resumed_replay", "no_result", "filtered", "unknown", "full"]) expect(canRetrySyncReason(reason)).toBe(false);
  });
  it("unknown results and malformed accepted counts do not claim success or echo private data", () => {
    for (const result of [{ code: "PRIVATE name", count: 3 }, { code: "accepted", count: -1 }, { code: "accepted", count: 0.5 }]) {
      expect(syncActionFeedback("retry", result)).toEqual({ error: true, text: expect.stringContaining("Couldn't confirm") });
    }
    expect(syncActionFeedback("identity", null, new Error("Private name 1-S2-1-42"))).toMatchObject({ error: true, text: "Couldn't save this account. Check your profile, then try adding it again." });
    expect(syncActionFeedback("identity", { code: "added", count: -1 }).error).toBe(true);
    expect(syncActionFeedback("identity", { code: "already_present", count: 21 }).error).toBe(true);
    expect(syncActionFeedback("retry", { code: "no_matches", count: 3 }).error).toBe(true);
  });
});
