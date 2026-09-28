import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRYABLE_KINDS,
  diffAgainstLedger,
  isErrorKind,
  ledgerEntryFor,
  type LedgerEntry,
} from "../ledger";

const file = (relativePath: string, size = 100, lastModified = 1) => ({ relativePath, size, lastModified });

function entry(path: string, patch: Partial<LedgerEntry> = {}): LedgerEntry {
  return { path, size: 100, lastModified: 1, status: "uploaded", updatedAt: 0, ...patch };
}

describe("diffAgainstLedger", () => {
  it("processes new files and skips settled uploads/skips", () => {
    const files = [file("new"), file("up"), file("skip")];
    const ledger = [entry("up"), entry("skip", { status: "skipped", errorKind: "ai_game" })];
    const diff = diffAgainstLedger(files, ledger);
    expect(diff.toProcess.map((f) => f.relativePath)).toEqual(["new"]);
    expect(diff.unchanged.map((f) => f.relativePath)).toEqual(["up", "skip"]);
  });

  it("re-processes files whose size or lastModified changed", () => {
    const diff = diffAgainstLedger([file("a", 101), file("b", 100, 2)], [entry("a"), entry("b")]);
    expect(diff.toProcess).toHaveLength(2);
  });

  it("retries transient failures but not deterministic ones", () => {
    const ledger = [
      entry("t", { status: "failed", errorKind: "timeout" }),
      entry("c", { status: "failed", errorKind: "corrupt_file" }),
      entry("u", { status: "failed" }),
    ];
    const diff = diffAgainstLedger([file("t"), file("c"), file("u")], ledger);
    expect(diff.toProcess.map((f) => f.relativePath)).toEqual(["t", "u"]);
    expect(diff.unchanged.map((f) => f.relativePath)).toEqual(["c"]);
    expect(DEFAULT_RETRYABLE_KINDS).toContain("worker_crashed");
  });

  it("retries every failure with retryFailed, or custom retryable kinds", () => {
    const ledger = [entry("c", { status: "failed", errorKind: "corrupt_file" })];
    expect(diffAgainstLedger([file("c")], ledger, { retryFailed: true }).toProcess).toHaveLength(1);
    expect(
      diffAgainstLedger([file("c")], ledger, { retryableKinds: ["corrupt_file"] }).toProcess,
    ).toHaveLength(1);
  });

  it("re-processes skips whose reason depended on the chosen window", () => {
    const ledger = [entry("old", { status: "skipped", errorKind: "outside_date_range" })];
    expect(diffAgainstLedger([file("old")], ledger).unchanged).toHaveLength(1);
    expect(
      diffAgainstLedger([file("old")], ledger, { reprocessSkippedKinds: ["outside_date_range"] }).toProcess,
    ).toHaveLength(1);
  });
});

describe("ledger helpers", () => {
  it("builds entries from files", () => {
    expect(ledgerEntryFor(file("a"), "uploaded", 42, { gameId: "g" })).toEqual({
      path: "a", size: 100, lastModified: 1, status: "uploaded", gameId: "g", updatedAt: 42,
    });
    expect(ledgerEntryFor(file("b"), "failed", 7, { errorKind: "timeout" }).errorKind).toBe("timeout");
  });

  it("recognises error kinds", () => {
    expect(isErrorKind("player_unresolved")).toBe(true);
    expect(isErrorKind("toString")).toBe(false);
    expect(isErrorKind("made_up")).toBe(false);
  });
});
