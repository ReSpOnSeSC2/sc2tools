import { describe, expect, it, vi } from "vitest";

import type { EngineRuntime, UnzipResult } from "../enginePyGlue";
import { createEngineWorkerHost, zipErrorKind, type BootedRuntime } from "../engineWorkerHost";
import type { ParseWorkerRequest, WorkerEvent } from "../protocol";
import type { EngineInfo } from "../types";

const INFO: EngineInfo = { engineVersion: "1.6.3", pyodideVersion: "314.0.7", pythonVersion: "3.14.2", bundleId: "0123456789abcdef", bootMs: 1 };
const HEAP_BYTES = 37_748_736;
const POINTER_URL = "https://sc2tools.test/engine/current.json";

/** Stand-in for Pyodide's PythonError (same constructor name, `type` = Python class). */
class PythonError extends Error {
  constructor(readonly type: string, message: string) {
    super(message);
  }
}

const OK_ENVELOPE = {
  ok: true, gameId: "2026-05-08T19:08:12|Opp|Map|470", json: '{"gameId":"x"}', date: "2026-05-08T19:08:12Z",
  myToonHandle: "1-S2-1-267727", matchFormat: "1v1", isResumedFromReplay: false,
};

function fakeRuntime(overrides: Partial<EngineRuntime> = {}): EngineRuntime & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const runtime: EngineRuntime = {
    players: (...args) => {
      calls.push(["players", ...args]);
      return JSON.stringify({ ok: true, players: [], date: null, map: null, durationSec: 0, matchFormat: null, playerCount: 0, isAiGame: false, toonFromPath: null });
    },
    parse: (...args) => {
      calls.push(["parse", ...args]);
      return JSON.stringify({ envelope: OK_ENVELOPE, digests: { sha256: "ab", md5: "cd==", sizeBytes: 3 } });
    },
    unzip: (): UnzipResult => ({ ok: true, entries: [{ name: "a.SC2Replay", bytes: new ArrayBuffer(2) }] }),
    heapBytes: () => HEAP_BYTES,
    dispose: () => undefined,
    ...overrides,
  };
  return Object.assign(runtime, { calls });
}

function setup(runtime: EngineRuntime = fakeRuntime(), boot?: () => Promise<BootedRuntime>) {
  const events: Array<{ event: WorkerEvent; transfer?: Transferable[] }> = [];
  const bootFn = vi.fn(boot ?? (async () => ({ runtime, info: INFO })));
  const handle = createEngineWorkerHost({ post: (event, transfer) => events.push({ event, transfer }) }, { boot: bootFn, now: () => 0 });
  const posted = (type: WorkerEvent["type"]) => events.filter((e) => e.event.type === type).map((e) => e.event);
  return { handle, events, bootFn, posted };
}

function parseRequest(overrides: Partial<ParseWorkerRequest> = {}): ParseWorkerRequest {
  return {
    type: "parse", id: 7, index: 2, total: 5, fileName: "x.SC2Replay", relativePath: "Accounts/1/1-S2-1-267727/x.SC2Replay",
    bytes: new Uint8Array([77, 80, 81]).buffer, playerToon: null, playerHandle: "Me", wantDigests: true, ...overrides,
  };
}

describe("createEngineWorkerHost: boot", () => {
  it("boots once and answers every boot request with ready", async () => {
    const { handle, bootFn, posted } = setup();
    await Promise.all([handle({ type: "boot", pointerUrl: POINTER_URL }), handle({ type: "boot", pointerUrl: POINTER_URL })]);
    expect(bootFn).toHaveBeenCalledTimes(1);
    expect(bootFn).toHaveBeenCalledWith(POINTER_URL);
    expect(posted("ready")).toEqual([
      { type: "ready", info: INFO, heapBytes: HEAP_BYTES },
      { type: "ready", info: INFO, heapBytes: HEAP_BYTES },
    ]);
  });

  it("reports a boot failure and lets a later boot retry", async () => {
    let attempts = 0;
    const runtime = fakeRuntime();
    const { handle, posted, bootFn } = setup(runtime, async () => {
      attempts += 1;
      if (attempts === 1) throw new RangeError("WebAssembly.Memory(): could not allocate memory");
      return { runtime, info: INFO };
    });
    await handle({ type: "boot", pointerUrl: POINTER_URL });
    expect(posted("boot-error")).toEqual([{ type: "boot-error", errorKind: "out_of_memory", detail: "RangeError: not enough memory to start the engine" }]);
    await handle({ type: "boot", pointerUrl: POINTER_URL });
    expect(bootFn).toHaveBeenCalledTimes(2);
    expect(posted("ready")).toHaveLength(1);
  });

  it("refuses file requests before a successful boot", async () => {
    const { handle, posted } = setup();
    await handle(parseRequest());
    expect(posted("request-error")).toEqual([{ type: "request-error", id: 7, errorKind: "engine_unavailable", detail: "the engine is not booted" }]);
  });
});

describe("createEngineWorkerHost: files", () => {
  it("parses with the relative path, emits progress around the file and returns digests", async () => {
    const runtime = fakeRuntime();
    const { handle, events } = setup(runtime);
    await handle({ type: "boot", pointerUrl: POINTER_URL });
    await handle(parseRequest());
    expect(runtime.calls[0]).toEqual(["parse", expect.any(Uint8Array), "Accounts/1/1-S2-1-267727/x.SC2Replay", "", "Me", true]);
    const tail = events.slice(-3).map((e) => e.event);
    expect(tail[0]).toEqual({ type: "progress", progress: { phase: "parse", index: 2, total: 5, fileName: "x.SC2Replay" } });
    expect(tail[1]).toEqual({ type: "progress", progress: { phase: "parse", index: 2, total: 5, fileName: "x.SC2Replay", ms: 0, ok: true } });
    expect(tail[2]).toMatchObject({
      type: "parsed", id: 7, heapBytes: HEAP_BYTES,
      outcome: { ok: true, gameId: OK_ENVELOPE.gameId, json: OK_ENVELOPE.json, digests: { sha256: "ab", md5: "cd==", sizeBytes: 3 } },
    });
  });

  it("maps Python and JS failures to request-error kinds without leaking messages", async () => {
    const failures: Array<[unknown, string]> = [
      [new PythonError("MemoryError", ""), "out_of_memory"],
      [new PythonError("KeyError", "C:\\Users\\someone\\x"), "analysis_failed"],
      [new Error("RuntimeError: unreachable"), "worker_crashed"],
    ];
    for (const [thrown, kind] of failures) {
      const runtime = fakeRuntime({ parse: () => { throw thrown; } });
      const { handle, posted } = setup(runtime);
      await handle({ type: "boot", pointerUrl: POINTER_URL });
      await handle(parseRequest());
      const [event] = posted("request-error");
      expect(event).toMatchObject({ type: "request-error", id: 7, errorKind: kind });
      expect(JSON.stringify(event)).not.toContain("someone");
    }
  });

  it("transfers unzipped entries and maps zip guard codes", async () => {
    const { handle, events } = setup();
    await handle({ type: "boot", pointerUrl: POINTER_URL });
    await handle({ type: "unzip", id: 3, index: 0, total: 1, fileName: "r.zip", relativePath: "r.zip", bytes: new ArrayBuffer(8) });
    const last = events[events.length - 1];
    expect(last.event.type).toBe("unzipped");
    expect(last.transfer).toHaveLength(1);

    const guarded = setup(fakeRuntime({ unzip: () => ({ ok: false, code: "zip_encrypted" }) }));
    await guarded.handle({ type: "boot", pointerUrl: POINTER_URL });
    await guarded.handle({ type: "unzip", id: 4, index: 0, total: 1, fileName: "r.zip", relativePath: "r.zip", bytes: new ArrayBuffer(8) });
    expect(guarded.posted("request-error")).toEqual([{ type: "request-error", id: 4, errorKind: "corrupt_file", detail: "zip_encrypted" }]);
    expect(zipErrorKind("zip_too_many_entries")).toBe("too_large");
  });
});
