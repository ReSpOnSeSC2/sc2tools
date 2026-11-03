// @vitest-environment node
import { describe, expect, it } from "vitest";
import { replayFilenameAllocator, recordedReplayResult, validReplayFilename, PACK_TEMPLATES } from "./packNames";
import { replayPackManifest } from "./packMetadata";

describe("recorded outcome in descriptive replay packs", () => {
  it.each([["Victory", "Win"], ["DEFEAT", "Loss"], ["draw", "Tie"], [undefined, "Unknown"], ["future", "Unknown"]])("uses recorded %s as %s independently from download status", (result, expected) => {
    const row = { gameId: "one", date: "2026-11-03", matchup: "PvT", opponent: "Other", map: "Map", result };
    const filename = replayFilenameAllocator()(row, "descriptive"); expect(filename).toBe(`2026-11-03 PvT ${expected} vs Other on Map.SC2Replay`);
    const csv = new TextDecoder().decode(replayPackManifest([{ ...row, filename: "", status: "failed" }]));
    expect(csv).toContain("recordedResult,status"); expect(csv).toContain(`"${expected}","failed"`); expect(recordedReplayResult(result)).toBe(expected);
  });
  it("retains old variants and protects descriptive result/metadata, UTF8 caps and full case-fold collisions", () => {
    expect(PACK_TEMPLATES).toEqual(["date-opponent-map", "date-matchup-map", "game-id", "descriptive"]);
    const allocate = replayFilenameAllocator(), row = { gameId: "one", date: "2026-11-03", matchup: "PvT", opponent: "STRASSE", map: "Map", result: "Win" };
    const first = allocate({ ...row, opponent: "straße" }, "descriptive"), second = allocate(row, "descriptive"); expect(first).not.toBe(second); expect(second).toContain(" (2).SC2Replay");
    const unsafe = allocate({ ...row, result: '=HYPERLINK("PRIVATE_URL")', opponent: "Ｂｅａｒｅｒ　PRIVATE_TOKEN", map: "ｈｔｔｐｓ：／／PRIVATE_URL" }, "descriptive");
    expect(unsafe).toContain("Unknown"); expect(unsafe).not.toMatch(/PRIVATE_|Bearer|https/iu); expect(validReplayFilename(unsafe)).toBe(true);
    const long = allocate({ ...row, map: "戦🎮".repeat(200), opponent: "bad\ud800name" }, "descriptive");
    expect(new TextEncoder().encode(long).byteLength).toBeLessThanOrEqual(240); expect(validReplayFilename(long)).toBe(true);
    const csv = new TextDecoder().decode(replayPackManifest([{ ...row, result: "Bearer PRIVATE_TOKEN", map: '=SUM("x",1)', filename: "", status: "unavailable" }]));
    expect(csv).toContain('"Unknown","unavailable"'); expect(csv).toContain('"\'=SUM(""x"",1)"'); expect(csv).not.toContain("PRIVATE_");
  });
});
