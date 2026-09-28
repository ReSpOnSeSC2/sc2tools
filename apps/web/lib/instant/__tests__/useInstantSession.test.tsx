/**
 * useInstantSession — the Instant Analysis state machine, driven against a
 * MOCK EngineClient (no worker, no Pyodide) with GA4 `gaEvent` mocked.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineError } from "../engineErrors";
import { MAX_REPLAY_BYTES, MAX_ZIP_ARCHIVE_BYTES } from "../fileIntake";
import { PROGRESS_INTERVAL_MS } from "../sessionProgress";
import type {
  EngineClient,
  EngineInfo,
  EngineProgress,
  IntakeFile,
  ParseOptions,
  ParseOutcome,
  ParseRequest,
  PlayersResult,
  ReplayPlayer,
} from "../types";
import { useInstantSession, type UseInstantSessionOptions } from "../useInstantSession";

const { gaEvent } = vi.hoisted(() => ({ gaEvent: vi.fn() }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent }));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const RECENT_MS = NOW - DAY_MS;
const RECENT_ISO = new Date(RECENT_MS).toISOString();
const OLD_ISO = new Date(NOW - 400 * DAY_MS).toISOString();
const ME = "1-S2-1-111";
const INFO: EngineInfo = { engineVersion: "1.6.3", pyodideVersion: "314.0.7", pythonVersion: "3.14", bundleId: "b", bootMs: 1 };

type OkScan = Extract<PlayersResult, { ok: true }>;

function player(name: string, toon: string, pid: number, race = "Protoss"): ReplayPlayer {
  return { name, toon, race, result: pid === 1 ? "Win" : "Loss", pid };
}

function scan(opponentToon: string, overrides: Partial<OkScan> = {}): OkScan {
  return {
    ok: true,
    players: [player("Me", ME, 1), player(`Opp ${opponentToon}`, opponentToon, 2, "Zerg")],
    date: RECENT_ISO,
    map: "Map",
    durationSec: 600,
    matchFormat: "1v1",
    playerCount: 2,
    isAiGame: false,
    toonFromPath: null,
    ...overrides,
  };
}

function replay(name: string, lastModified = RECENT_MS): File {
  return new File([new Uint8Array([1, 2, 3])], name, { lastModified });
}

/**
 * MOCK EngineClient: answers from per-file-name scripts, records calls and
 * can hold `parseFiles` open until its signal aborts (cancel and throttle
 * tests drive progress through `parseProgress` meanwhile).
 */
class MockEngine implements EngineClient {
  readonly scans = new Map<string, PlayersResult>();
  readonly parseDates = new Map<string, string>();
  readonly zips = new Map<string, IntakeFile[]>();
  bootError: EngineError | null = null;
  holdParse = false;
  parseRequests: ParseRequest[] = [];
  parseProgress: ((event: EngineProgress) => void) | null = null;
  onParseStart: (() => void) | null = null;

  boot = vi.fn(async (options?: ParseOptions): Promise<EngineInfo> => {
    options?.onProgress?.({ phase: "boot", index: 0, total: 1, fileName: "" });
    if (this.bootError) throw this.bootError;
    return INFO;
  });

  listPlayers = vi.fn(async (files: IntakeFile[]): Promise<PlayersResult[]> =>
    files.map((file) => this.scans.get(file.name) ?? scan(`2-S2-1-${file.name}`)),
  );

  parseFiles = vi.fn(async (requests: ParseRequest[], options?: ParseOptions): Promise<ParseOutcome[]> => {
    this.parseRequests = requests;
    this.parseProgress = options?.onProgress ?? null;
    this.onParseStart?.();
    if (this.holdParse) await abortOf(options?.signal);
    else {
      requests.forEach((request, index) =>
        options?.onProgress?.({ phase: "parse", index, total: requests.length, fileName: request.file.name, ms: 5, ok: true }),
      );
    }
    return requests.map((request, index) => this.outcome(request, index));
  });

  expandZip = vi.fn(async (file: IntakeFile): Promise<IntakeFile[]> => this.zips.get(file.name) ?? []);
  cancel = vi.fn();
  dispose = vi.fn();

  private outcome(request: ParseRequest, index: number): ParseOutcome {
    const { name, relativePath } = request.file;
    return {
      ok: true,
      fileName: name,
      relativePath,
      gameId: `g-${name}`,
      json: "{}",
      date: this.parseDates.get(name) ?? RECENT_ISO,
      myToonHandle: request.player.toon,
      matchFormat: "1v1",
      isResumedFromReplay: false,
      ms: 100 * (index + 1),
    };
  }
}

function abortOf(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

function mount(engine: MockEngine, options: Omit<UseInstantSessionOptions, "clientFactory"> = {}) {
  const factory = vi.fn(() => engine);
  const hook = renderHook(() => useInstantSession({ ...options, clientFactory: factory }));
  return { ...hook, factory };
}

type Hook = ReturnType<typeof mount>["result"];

async function add(result: Hook, files: File[], source: "drop" | "picker" | "folder" = "picker"): Promise<void> {
  await act(async () => {
    await result.current.addFiles(files, source);
  });
}

async function start(result: Hook): Promise<void> {
  await act(async () => {
    await result.current.start();
  });
}

function events(name: string): Array<Record<string, unknown> | undefined> {
  return gaEvent.mock.calls.filter(([action]) => action === name).map(([, params]) => params);
}

beforeEach(() => {
  gaEvent.mockClear();
});

afterEach(cleanup);

describe("useInstantSession: engine lifecycle", () => {
  it("never creates the engine on mount or when replays are queued, only on start", async () => {
    const engine = new MockEngine();
    const { result, factory } = mount(engine);
    expect(factory).not.toHaveBeenCalled();
    await add(result, [replay("a.SC2Replay")]);
    expect(result.current.phase).toBe("ready");
    expect(factory).not.toHaveBeenCalled();
    await start(result);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("disposes the engine on unmount", async () => {
    const engine = new MockEngine();
    engine.scans.set("a.SC2Replay", scan("2-S2-1-9", { toonFromPath: ME }));
    const { result, unmount } = mount(engine);
    await add(result, [replay("a.SC2Replay")]);
    await start(result);
    unmount();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("survives StrictMode's double effect run (dispose, then re-activate)", async () => {
    const engine = new MockEngine();
    engine.scans.set("a.SC2Replay", scan("2-S2-1-9", { toonFromPath: ME }));
    const factory = vi.fn(() => engine);
    const { result } = renderHook(() => useInstantSession({ clientFactory: factory }), { wrapper: StrictMode });
    await add(result, [replay("a.SC2Replay")]);
    await start(result);
    expect(result.current.phase).toBe("done");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.current.lastHeapBytes()).toBeNull();
  });

  it("re-runs the same queue after an error once the engine recovers", async () => {
    const engine = new MockEngine();
    engine.bootError = new EngineError("worker_crashed", "crashed");
    engine.scans.set("a.SC2Replay", scan("2-S2-1-9", { toonFromPath: ME }));
    const { result } = mount(engine);
    await add(result, [replay("a.SC2Replay")]);
    await start(result);
    expect(result.current.phase).toBe("error");
    engine.bootError = null;
    await start(result);
    expect(result.current.phase).toBe("done");
    expect(result.current.error).toBeNull();
    expect(result.current.parsed).toHaveLength(1);
  });

  it("moves to error with the boot failure's kind", async () => {
    const engine = new MockEngine();
    engine.bootError = new EngineError("integrity_failed", "integrity check failed");
    const { result } = mount(engine);
    await add(result, [replay("a.SC2Replay")]);
    await start(result);
    expect(result.current.phase).toBe("error");
    expect(result.current.error).toBe("integrity_failed");
    expect(events("instant_error")).toEqual([{ kind: "integrity_failed" }]);
  });
});

describe("useInstantSession: prewarm on intent", () => {
  it("boots the engine once on the first intent, never on mount, and the run reuses it", async () => {
    const engine = new MockEngine();
    engine.scans.set("a.SC2Replay", scan("2-S2-1-9", { toonFromPath: ME }));
    const { result, factory } = mount(engine);
    expect(factory).not.toHaveBeenCalled();
    act(() => {
      result.current.prewarm();
      result.current.prewarm();
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(engine.boot).toHaveBeenCalledTimes(1);
    await add(result, [replay("a.SC2Replay")]);
    await start(result);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("done");
  });

  it("keeps a failed warm-up silent until the run, which then reports the boot error", async () => {
    const engine = new MockEngine();
    engine.bootError = new EngineError("integrity_failed", "integrity check failed");
    const { result } = mount(engine);
    await act(async () => {
      result.current.prewarm();
    });
    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(events("instant_error")).toEqual([]);
    await add(result, [replay("a.SC2Replay")]);
    await start(result);
    expect(result.current.error).toBe("integrity_failed");
    expect(engine.boot).toHaveBeenCalledTimes(2);
  });

  it("does nothing after unmount", async () => {
    const engine = new MockEngine();
    const { result, factory, unmount } = mount(engine);
    const { prewarm } = result.current;
    unmount();
    prewarm();
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("useInstantSession: which player is me (resolved)", () => {
  it("parses straight away when the path names the toon", async () => {
    const engine = new MockEngine();
    engine.scans.set("a.SC2Replay", scan("2-S2-1-7", { toonFromPath: ME }));
    engine.scans.set("b.SC2Replay", scan("2-S2-1-8", { toonFromPath: ME }));
    const { result } = mount(engine, { wantDigests: true });
    await add(result, [replay("a.SC2Replay"), replay("b.SC2Replay")]);
    await start(result);
    expect(result.current.phase).toBe("done");
    expect(result.current.meMode).toBe("path");
    expect(engine.parseRequests.map((request) => request.player)).toEqual([
      { toon: ME, handle: "Me" },
      { toon: ME, handle: "Me" },
    ]);
    expect(engine.parseRequests.every((request) => request.wantDigests === true)).toBe(true);
    expect(result.current.parsed.map((game) => game.gameId)).toEqual(["g-a.SC2Replay", "g-b.SC2Replay"]);
    expect(result.current.parsedWithFiles.map((entry) => entry.file.name)).toEqual(["a.SC2Replay", "b.SC2Replay"]);
    expect(result.current.failed).toEqual([]);
  });

  it("fails replays the path toon did not play in as player_unresolved without parsing them", async () => {
    const engine = new MockEngine();
    engine.scans.set("x.SC2Replay", scan("2-S2-1-3", { toonFromPath: "9-S2-9-999" }));
    const { result } = mount(engine);
    await add(result, [replay("x.SC2Replay")]);
    await start(result);
    expect(result.current.phase).toBe("done");
    expect(engine.parseFiles).not.toHaveBeenCalled();
    expect(result.current.failed.map((failure) => failure.errorKind)).toEqual(["player_unresolved"]);
  });
});

describe("useInstantSession: which player is me (confirmation)", () => {
  it("asks to confirm a majority guess, then parses as the chosen toon", async () => {
    const engine = new MockEngine();
    ["a", "b", "c"].forEach((id) => engine.scans.set(`${id}.SC2Replay`, scan(`2-S2-1-${id}`)));
    const { result } = mount(engine);
    await add(result, ["a", "b", "c"].map((id) => replay(`${id}.SC2Replay`)));
    await start(result);
    expect(result.current.phase).toBe("choosing");
    expect(result.current.meMode).toBe("majority");
    expect(result.current.candidates[0]).toMatchObject({ toon: ME, name: "Me", race: "Protoss", games: 3 });
    expect(engine.parseFiles).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.choose(ME);
    });
    expect(result.current.phase).toBe("done");
    expect(result.current.chosenToon).toBe(ME);
    expect(engine.parseRequests.map((request) => request.player.toon)).toEqual([ME, ME, ME]);
  });

  it("lets the visitor pick either player of a single loose replay", async () => {
    const engine = new MockEngine();
    const opponent = "2-S2-1-5";
    engine.scans.set("solo.SC2Replay", scan(opponent));
    const { result } = mount(engine);
    await add(result, [replay("solo.SC2Replay")]);
    await start(result);
    expect(result.current.phase).toBe("choosing");
    expect(result.current.meMode).toBe("ambiguous");
    expect(result.current.candidates.map((candidate) => candidate.toon).sort()).toEqual([ME, opponent].sort());
    await act(async () => {
      await result.current.choose(opponent);
    });
    expect(engine.parseRequests[0].player).toEqual({ toon: opponent, handle: `Opp ${opponent}` });
  });
});

describe("useInstantSession: filters", () => {
  it("skips non-1v1 and AI games before parsing when onlyOneVsOne is set", async () => {
    const engine = new MockEngine();
    engine.scans.set("team.SC2Replay", scan("2-S2-1-1", { toonFromPath: ME, matchFormat: "team" }));
    engine.scans.set("ai.SC2Replay", scan("2-S2-1-2", { toonFromPath: ME, isAiGame: true }));
    engine.scans.set("ok.SC2Replay", scan("2-S2-1-3", { toonFromPath: ME }));
    const { result } = mount(engine, { onlyOneVsOne: true });
    await add(result, [replay("team.SC2Replay"), replay("ai.SC2Replay"), replay("ok.SC2Replay")]);
    await start(result);
    expect(engine.parseRequests.map((request) => request.file.name)).toEqual(["ok.SC2Replay"]);
    expect(result.current.failed.map((failure) => failure.errorKind).sort()).toEqual(["ai_game", "not_1v1"]);
    expect(result.current.parsed).toHaveLength(1);
  });

  it("skips replays outside the date window before scanning, after scanning and after parsing", async () => {
    const engine = new MockEngine();
    engine.scans.set("s.SC2Replay", scan("2-S2-1-1", { toonFromPath: ME, date: OLD_ISO }));
    engine.scans.set("p.SC2Replay", scan("2-S2-1-2", { toonFromPath: ME }));
    engine.scans.set("ok.SC2Replay", scan("2-S2-1-3", { toonFromPath: ME }));
    engine.parseDates.set("p.SC2Replay", OLD_ISO);
    const { result } = mount(engine);
    const stale = replay("m.SC2Replay", NOW - 400 * DAY_MS);
    await add(result, [stale, replay("s.SC2Replay"), replay("p.SC2Replay"), replay("ok.SC2Replay")]);
    await start(result);
    const scanned = engine.listPlayers.mock.calls[0][0].map((file) => file.name);
    expect(scanned).not.toContain("m.SC2Replay");
    expect(result.current.failed.map((failure) => [failure.fileName, failure.errorKind])).toEqual([
      ["m.SC2Replay", "outside_date_range"],
      ["s.SC2Replay", "outside_date_range"],
      ["p.SC2Replay", "outside_date_range"],
    ]);
    expect(result.current.parsed.map((game) => game.fileName)).toEqual(["ok.SC2Replay"]);
  });

  it("keeps old replays when the window is All time", async () => {
    const engine = new MockEngine();
    engine.scans.set("old.SC2Replay", scan("2-S2-1-1", { toonFromPath: ME, date: OLD_ISO }));
    engine.parseDates.set("old.SC2Replay", OLD_ISO);
    const { result } = mount(engine, { initialDateWindow: { kind: "all" } });
    await add(result, [replay("old.SC2Replay", NOW - 400 * DAY_MS)]);
    await start(result);
    expect(result.current.parsed).toHaveLength(1);
  });
});

describe("useInstantSession: intake", () => {
  it("ignores non-replays, dedupes, and keeps the newest maxFiles", async () => {
    const engine = new MockEngine();
    const { result } = mount(engine, { maxFiles: 2 });
    const files = [replay("old.SC2Replay", RECENT_MS - 3000), replay("mid.SC2Replay", RECENT_MS - 2000), replay("new.SC2Replay", RECENT_MS - 1000)];
    await add(result, [...files, new File(["x"], "notes.txt")]);
    expect(result.current.files.map((file) => file.name)).toEqual(["mid.SC2Replay", "new.SC2Replay"]);
    expect(result.current.truncatedCount).toBe(1);
    expect(result.current.lastIntake).toEqual({ found: 3, added: 3, ignored: 1, rejected: 0 });
    await add(result, [files[2]]);
    expect(result.current.lastIntake).toMatchObject({ found: 1, added: 0 });
    expect(result.current.files).toHaveLength(2);
    expect(result.current.truncatedCount).toBe(1);
    expect(result.current.estimate?.seconds).toBeGreaterThan(0);
  });

  it("rejects oversized replays as too_large without queueing them", async () => {
    const engine = new MockEngine();
    const { result } = mount(engine);
    const huge = replay("huge.SC2Replay");
    Object.defineProperty(huge, "size", { value: MAX_REPLAY_BYTES + 1 });
    await add(result, [huge]);
    expect(result.current.files).toHaveLength(0);
    expect(result.current.phase).toBe("idle");
    expect(result.current.failed.map((failure) => failure.errorKind)).toEqual(["too_large"]);
  });

});

describe("useInstantSession: .zip intake", () => {
  it("expands a .zip through the engine and reports the selection as source zip", async () => {
    const engine = new MockEngine();
    const entry: IntakeFile = {
      key: "3:1:r.zip/a.SC2Replay", name: "a.SC2Replay", relativePath: "r.zip/a.SC2Replay",
      size: 3, lastModified: RECENT_MS, source: "zip", blob: new Blob([new Uint8Array(3)]),
    };
    engine.zips.set("r.zip", [entry]);
    const { result, factory } = mount(engine);
    await add(result, [new File(["zip"], "r.zip", { lastModified: RECENT_MS }), replay("b.SC2Replay")], "drop");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(engine.expandZip).toHaveBeenCalledTimes(1);
    expect(result.current.files.map((file) => file.relativePath)).toEqual(["b.SC2Replay", "r.zip/a.SC2Replay"]);
    expect(result.current.expanding).toBe(false);
    expect(events("instant_files_selected")).toEqual([{ count: 2, source: "zip" }]);
  });

  it("rejects an oversized .zip as too_large without starting the engine", async () => {
    const engine = new MockEngine();
    const { result, factory } = mount(engine);
    const huge = new File(["z"], "library.zip");
    Object.defineProperty(huge, "size", { value: MAX_ZIP_ARCHIVE_BYTES + 1 });
    await add(result, [huge], "drop");
    expect(factory).not.toHaveBeenCalled();
    expect(engine.expandZip).not.toHaveBeenCalled();
    expect(result.current.failed.map((failure) => failure.errorKind)).toEqual(["too_large"]);
  });

  it("never leaves intake locked when the engine cannot be created for a .zip", async () => {
    const factory = vi.fn((): EngineClient => {
      throw new Error("no workers in this browser");
    });
    const { result } = renderHook(() => useInstantSession({ clientFactory: factory }));
    await add(result, [new File(["zip"], "r.zip", { lastModified: RECENT_MS })], "drop");
    expect(result.current.expanding).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(result.current.phase).toBe("error");
    expect(events("instant_files_selected")).toEqual([]);
  });
});

describe("useInstantSession: cancel and analytics", () => {
  it("cancel() during parsing returns to ready and ignores the late answer", async () => {
    const engine = new MockEngine();
    engine.holdParse = true;
    engine.scans.set("a.SC2Replay", scan("2-S2-1-1", { toonFromPath: ME }));
    const { result } = mount(engine);
    await add(result, [replay("a.SC2Replay")]);
    let running: Promise<void> = Promise.resolve();
    act(() => {
      running = result.current.start();
    });
    await waitFor(() => expect(result.current.phase).toBe("parsing"));
    act(() => result.current.cancel());
    await act(async () => {
      await running;
    });
    expect(result.current.phase).toBe("ready");
    expect(result.current.parsed).toEqual([]);
    expect(result.current.files).toHaveLength(1);
    expect(events("instant_parse_done")).toEqual([]);
  });

  it("reports files selected, parse done and one error event per distinct kind", async () => {
    const engine = new MockEngine();
    engine.scans.set("a.SC2Replay", scan("2-S2-1-1", { toonFromPath: ME }));
    engine.scans.set("b.SC2Replay", scan("2-S2-1-2", { toonFromPath: ME }));
    engine.scans.set("c.SC2Replay", scan("2-S2-1-3", { toonFromPath: ME, isAiGame: true }));
    engine.scans.set("d.SC2Replay", scan("2-S2-1-4", { toonFromPath: ME, isAiGame: true }));
    engine.scans.set("e.SC2Replay", { ok: false, errorKind: "corrupt_file" });
    const { result } = mount(engine);
    await add(result, ["a", "b", "c", "d", "e"].map((id) => replay(`${id}.SC2Replay`)), "drop");
    await start(result);
    expect(events("instant_files_selected")).toEqual([{ count: 5, source: "drop" }]);
    expect(events("instant_parse_done")).toEqual([{ ok: 2, failed: 3, median_ms: 150 }]);
    expect(events("instant_error")).toEqual([{ kind: "ai_game" }, { kind: "corrupt_file" }]);
  });
});

describe("useInstantSession: progress throttle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the first sample at once and only the latest one per interval", async () => {
    // Fake the clock before mount: the throttle captures Date.now when created.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const engine = new MockEngine();
    engine.holdParse = true;
    engine.scans.set("a.SC2Replay", scan("2-S2-1-1", { toonFromPath: ME }));
    const parseStarted = new Promise<void>((resolve) => {
      engine.onParseStart = resolve;
    });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useInstantSession({ clientFactory: () => engine });
    });
    await add(result, [replay("a.SC2Replay")]);
    let running: Promise<void> = Promise.resolve();
    await act(async () => {
      running = result.current.start();
      await parseStarted;
    });
    const emit = engine.parseProgress;
    if (!emit) throw new Error("parse progress sink missing");
    // Let the interval since the boot sample elapse, so the next sample leads.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS);
    });
    const before = renders;
    const total = 50;
    for (let index = 0; index < total; index += 1) {
      act(() => emit({ phase: "parse", index, total, fileName: "a.SC2Replay", ms: 1, ok: true }));
    }
    expect(renders - before).toBe(1);
    expect(result.current.progress?.done).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS);
    });
    expect(renders - before).toBe(2);
    expect(result.current.progress).toMatchObject({ phase: "parse", done: total, total });
    act(() => result.current.cancel());
    await act(async () => {
      await running;
    });
    expect(result.current.phase).toBe("ready");
  });
});
