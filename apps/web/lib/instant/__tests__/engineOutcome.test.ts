import { describe, expect, it } from "vitest";

import { toDigests, toParseOutcome, toPlayersResult, zipEntryFile } from "../engineOutcome";
import type { IntakeFile } from "../types";

const META = { fileName: "x.SC2Replay", relativePath: "d/x.SC2Replay", ms: 640 };

describe("toParseOutcome", () => {
  it("maps a success envelope", () => {
    const outcome = toParseOutcome(
      { ok: true, gameId: "g", json: "{}", date: "2026-01-01T00:00:00Z", myToonHandle: "1-S2-1-1", matchFormat: "1v1", isResumedFromReplay: false, reason: "ignored" },
      META,
      { sha256: "ab", md5: "cd==", sizeBytes: 2 },
    );
    expect(outcome).toEqual({
      ok: true, fileName: "x.SC2Replay", relativePath: "d/x.SC2Replay", gameId: "g", json: "{}", date: "2026-01-01T00:00:00Z",
      myToonHandle: "1-S2-1-1", matchFormat: "1v1", isResumedFromReplay: false, ms: 640, digests: { sha256: "ab", md5: "cd==", sizeBytes: 2 },
    });
  });

  it("keeps the engine's error kind and detail, falling back for unknown kinds", () => {
    expect(toParseOutcome({ ok: false, errorKind: "ai_game", detail: "no" }, META)).toMatchObject({ ok: false, errorKind: "ai_game", detail: "no" });
    expect(toParseOutcome({ ok: false, errorKind: "martian" }, META)).toMatchObject({ ok: false, errorKind: "analysis_failed" });
  });

  it("never returns a mistyped success", () => {
    expect(toParseOutcome({ ok: true, gameId: 3 }, META)).toMatchObject({ ok: false, errorKind: "analysis_failed" });
    expect(toParseOutcome("nope", META)).toMatchObject({ ok: false });
  });
});

describe("toPlayersResult / toDigests", () => {
  it("narrows players and drops unknown results", () => {
    const result = toPlayersResult({
      ok: true, players: [{ name: "A", toon: "", race: "Protoss", result: "Win", pid: 1 }, { name: "B", toon: "1-S2-1-2", race: "Zerg", result: "Undecided", pid: 2 }],
      date: "2026-01-01T00:00:00Z", map: "M", durationSec: 470, matchFormat: "1v1", playerCount: 2, isAiGame: false, toonFromPath: null,
    });
    expect(result.ok && result.players).toEqual([
      { name: "A", toon: null, race: "Protoss", result: "Win", pid: 1 },
      { name: "B", toon: "1-S2-1-2", race: "Zerg", result: null, pid: 2 },
    ]);
    expect(toPlayersResult({ ok: true, players: [{ pid: 1 }] })).toMatchObject({ ok: false, errorKind: "parse_failed" });
    expect(toPlayersResult({ ok: false, errorKind: "corrupt_file", detail: "d" })).toEqual({ ok: false, errorKind: "corrupt_file", detail: "d" });
  });

  it("returns undefined for malformed digests", () => {
    expect(toDigests({ sha256: "a" })).toBeUndefined();
  });
});

describe("zipEntryFile", () => {
  it("nests the entry under the archive path and inherits its timestamp", () => {
    const zip: IntakeFile = { key: "k", name: "r.zip", relativePath: "Downloads/r.zip", size: 9, lastModified: 42, source: "drop", blob: new Blob([]) };
    const file = zipEntryFile(zip, "Accounts/1/1-S2-1-1/Replays/a.SC2Replay", new ArrayBuffer(5));
    expect(file).toMatchObject({
      name: "a.SC2Replay", relativePath: "Downloads/r.zip/Accounts/1/1-S2-1-1/Replays/a.SC2Replay", size: 5, lastModified: 42, source: "zip",
      key: "5:42:Downloads/r.zip/Accounts/1/1-S2-1-1/Replays/a.SC2Replay",
    });
  });
});
