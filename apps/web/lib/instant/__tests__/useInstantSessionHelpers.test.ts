/**
 * Pure helpers behind useInstantSession: the progress throttle, the
 * session reducer/store, the run pipeline rules and archive expansion
 * (against a MOCK EngineClient).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineError } from "../engineErrors";
import { MAX_ZIP_ARCHIVE_BYTES } from "../fileIntake";
import { expandArchives, sortSelection } from "../sessionIntake";
import { finalizeOutcomes, type RunRules } from "../sessionPipeline";
import { createThrottle, toSessionProgress } from "../sessionProgress";
import { capQueue, createSessionStore, initialSessionState, sessionReducer } from "../sessionState";
import type { EngineClient, IntakeFile, ParseOutcome, ParseRequest } from "../types";

function intake(name: string, lastModified: number): IntakeFile {
  return { key: name, name, relativePath: name, size: 1, lastModified, source: "picker", blob: new Blob(["x"]) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createThrottle", () => {
  it("applies the first value now and only the latest value after the interval", () => {
    vi.useFakeTimers();
    const applied: number[] = [];
    const throttle = createThrottle((value: number) => applied.push(value), 100);
    throttle.push(1);
    throttle.push(2);
    throttle.push(3);
    expect(applied).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(applied).toEqual([1, 3]);
  });

  it("drops the pending value on cancel and applies it at once on flush", () => {
    vi.useFakeTimers();
    const applied: number[] = [];
    const throttle = createThrottle((value: number) => applied.push(value), 100);
    throttle.push(1);
    throttle.push(2);
    throttle.cancel();
    vi.advanceTimersByTime(200);
    expect(applied).toEqual([1]);
    throttle.push(3);
    throttle.push(4);
    throttle.flush();
    expect(applied).toEqual([1, 3, 4]);
  });
});

describe("toSessionProgress", () => {
  it("counts a finished file as done", () => {
    expect(toSessionProgress({ phase: "parse", index: 2, total: 5, fileName: "f" }).done).toBe(2);
    expect(toSessionProgress({ phase: "parse", index: 2, total: 5, fileName: "f", ms: 9, ok: true }).done).toBe(3);
  });
});

describe("session state", () => {
  it("capQueue keeps the newest files in queue order", () => {
    const files = [intake("a", 3), intake("b", 1), intake("c", 2)];
    expect(capQueue(files, 2).map((file) => file.name)).toEqual(["a", "c"]);
    expect(capQueue(files).map((file) => file.name)).toEqual(["a", "b", "c"]);
  });

  it("starts a fresh queue when files are added after a finished run", () => {
    let state = initialSessionState({ kind: "days90" });
    state = sessionReducer(state, { type: "files-added", incoming: [intake("a", 1)], failed: [] });
    state = sessionReducer(state, { type: "stage", phase: "booting" });
    expect(sessionReducer(state, { type: "files-added", incoming: [intake("b", 1)], failed: [] })).toBe(state);
    state = sessionReducer(state, { type: "done", parsedWithFiles: [] });
    const unchanged = sessionReducer(state, { type: "files-added", incoming: [], failed: [], ignored: 2 });
    expect(unchanged.files.map((file) => file.name)).toEqual(["a"]);
    expect(unchanged.lastIntake).toEqual({ found: 0, added: 0, ignored: 2, rejected: 0 });
    state = sessionReducer(state, { type: "files-added", incoming: [intake("b", 1)], failed: [] });
    expect(state.phase).toBe("ready");
    expect(state.files.map((file) => file.name)).toEqual(["b"]);
  });

  it("ignores progress outside a run and notifies store subscribers on change only", () => {
    const store = createSessionStore(initialSessionState({ kind: "all" }));
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispatch({ type: "progress", progress: { phase: "parse", index: 0, total: 1, done: 0, fileName: "" } });
    expect(listener).not.toHaveBeenCalled();
    store.dispatch({ type: "date-window", window: { kind: "days90" } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().dateWindow).toEqual({ kind: "days90" });
  });
});

describe("finalizeOutcomes", () => {
  const rules: RunRules = { dateWindow: { kind: "all" }, now: Date.now(), onlyOneVsOne: true };

  it("skips resumed-from-replay sessions in 1v1 mode and pairs games with files", () => {
    const requests: ParseRequest[] = [intake("a", 1), intake("b", 1)].map((file) => ({ file, player: { toon: "t", handle: null } }));
    const base = { ok: true as const, relativePath: "", json: "{}", date: "2026-01-01T00:00:00Z", myToonHandle: "t", matchFormat: "1v1" as const, ms: 1 };
    const outcomes: ParseOutcome[] = [
      { ...base, fileName: "a", gameId: "ga", isResumedFromReplay: true },
      { ...base, fileName: "b", gameId: "gb", isResumedFromReplay: false },
    ];
    const result = finalizeOutcomes(requests, outcomes, rules);
    expect(result.failed.map((failure) => failure.errorKind)).toEqual(["resumed_replay"]);
    expect(result.parsed.map((entry) => [entry.game.gameId, entry.file.name])).toEqual([["gb", "b"]]);
  });
});

describe("sessionIntake", () => {
  it("sorts a selection into replays, archives and ignored files", () => {
    const selection = sortSelection([new File(["r"], "a.SC2Replay"), new File(["z"], "b.ZIP"), new File(["t"], "c.txt")], "folder");
    expect(selection.replays.map((file) => file.source)).toEqual(["folder"]);
    expect(selection.zips.map((file) => file.name)).toEqual(["b.ZIP"]);
    expect(selection.ignoredCount).toBe(1);
  });

  it("rejects an oversized archive as too_large without passing it on to be read", () => {
    const huge = new File(["z"], "library.zip");
    Object.defineProperty(huge, "size", { value: MAX_ZIP_ARCHIVE_BYTES + 1 });
    const fits = new File(["z"], "few.zip");
    const selection = sortSelection([huge, fits], "drop");
    expect(selection.zips.map((file) => file.name)).toEqual(["few.zip"]);
    expect(selection.rejected.map((failure) => [failure.fileName, failure.errorKind])).toEqual([["library.zip", "too_large"]]);
  });

  it("rejects a broken archive on its own but stops when the engine cannot start", async () => {
    /** MOCK EngineClient: only expandZip is exercised. */
    const expandZip = vi
      .fn<(file: IntakeFile) => Promise<IntakeFile[]>>()
      .mockRejectedValueOnce(new EngineError("too_large", "zip_too_large"))
      .mockRejectedValueOnce(new EngineError("engine_boot_failed", "no worker"));
    const engine: EngineClient = {
      boot: vi.fn(), listPlayers: vi.fn(), parseFiles: vi.fn(), expandZip, cancel: vi.fn(), dispose: vi.fn(),
    };
    const result = await expandArchives(engine, [intake("a.zip", 1), intake("b.zip", 1), intake("c.zip", 1)], {});
    expect(result.rejected.map((failure) => [failure.fileName, failure.errorKind])).toEqual([["a.zip", "too_large"]]);
    expect(result.fatal?.kind).toBe("engine_boot_failed");
    expect(expandZip).toHaveBeenCalledTimes(2);
  });
});
