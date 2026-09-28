/**
 * errorCopy — friendly copy for every ErrorKind and the grouped summary.
 */
import { describe, expect, it } from "vitest";

import { errorCopy, isSkipKind, summarizeFailures } from "../errorCopy";
import { isErrorKind } from "../ledger";
import type { ErrorKind } from "../types";

const ALL_KINDS: ErrorKind[] = [
  "unsupported_version", "corrupt_file", "not_a_replay", "ai_game", "player_unresolved", "player_ambiguous",
  "no_result", "parse_failed", "analysis_failed", "playback_budget_exceeded", "engine_unavailable", "timeout",
  "out_of_memory", "not_1v1", "resumed_replay", "outside_date_range", "too_large", "cancelled",
  "integrity_failed", "engine_boot_failed", "worker_crashed",
];

describe("errorCopy", () => {
  it("has a non-empty title and hint for every ErrorKind", () => {
    for (const kind of ALL_KINDS) {
      expect(isErrorKind(kind)).toBe(true);
      const copy = errorCopy(kind);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.hint.length).toBeGreaterThan(0);
    }
  });

  it("reuses the desktop importer wording where codes overlap", () => {
    expect(errorCopy("ai_game").hint).toBe("Skipped — game vs the AI.");
    expect(errorCopy("no_result").hint).toBe("The replay has no recorded result (left during loading?).");
    expect(errorCopy("outside_date_range").hint).toBe("Skipped — outside your import date range.");
  });

  it("suggests a newer patch for unsupported_version", () => {
    expect(errorCopy("unsupported_version").hint).toMatch(/newer StarCraft II patch/);
  });

  it("blames the upload size limit, not browser memory, for playback_budget_exceeded", () => {
    const copy = errorCopy("playback_budget_exceeded");
    expect(copy.title).toBe("Game too large to upload");
    expect(copy.hint).toMatch(/larger than the upload size limit/);
    expect(copy.hint).toMatch(/same limit/);
    expect(copy.hint).not.toMatch(/memory/);
    expect(copy.hint).not.toMatch(/can import it/);
  });

  it("points large archives to folder import", () => {
    expect(errorCopy("too_large").hint).toMatch(/replay folder instead of a \.zip/);
  });

  it("uses American spelling in every hint", () => {
    for (const kind of ALL_KINDS) expect(errorCopy(kind).hint).not.toMatch(/analys(e|ed|ing)\b/i);
  });
});

describe("summarizeFailures", () => {
  it("counts per kind, real failures before deliberate skips", () => {
    const groups = summarizeFailures([
      { errorKind: "ai_game" },
      { errorKind: "ai_game" },
      { errorKind: "ai_game" },
      { errorKind: "corrupt_file" },
      { errorKind: "timeout" },
      { errorKind: "timeout" },
    ]);
    expect(groups.map((group) => [group.kind, group.count, group.skipped])).toEqual([
      ["timeout", 2, false],
      ["corrupt_file", 1, false],
      ["ai_game", 3, true],
    ]);
    expect(isSkipKind("outside_date_range")).toBe(true);
    expect(summarizeFailures([])).toEqual([]);
  });
});
