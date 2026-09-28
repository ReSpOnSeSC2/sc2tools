import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PER_FILE_TIMEOUT_MS,
  DEFAULT_RECYCLE_EVERY,
  createEngineClient,
  type EngineClientOptions,
} from "../engineClient";
import { EngineError } from "../engineErrors";
import type { WorkerEvent, WorkerLike, WorkerRequest } from "../protocol";
import type { EngineInfo, EngineProgress, IntakeFile, ParseRequest } from "../types";

const INFO: EngineInfo = {
  engineVersion: "1.6.3",
  pyodideVersion: "314.0.7",
  pythonVersion: "3.14.2",
  bundleId: "0123456789abcdef",
  bootMs: 2300,
};
const HEAP_BYTES = 54_460_416;
const TIMEOUT_MS = 1_000;

type Script = (worker: MockEngineWorker, request: WorkerRequest) => void;

/**
 * MOCK engine worker: a scripted stand-in for `engineWorker.ts` that
 * answers asynchronously (microtask), records requests and flags any
 * overlapping file request. No Pyodide involved.
 */
class MockEngineWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  readonly received: WorkerRequest[] = [];
  readonly transfers: Transferable[][] = [];
  inFlight = 0;
  overlaps = 0;

  constructor(private readonly script: Script) {}

  postMessage(message: WorkerRequest, transfer: Transferable[] = []): void {
    this.received.push(message);
    this.transfers.push(transfer);
    if (message.type !== "boot") {
      if (this.inFlight > 0) this.overlaps += 1;
      this.inFlight += 1;
    }
    void Promise.resolve().then(() => {
      if (!this.terminated) this.script(this, message);
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(event: WorkerEvent): void {
    if (event.type !== "progress" && event.type !== "ready" && event.type !== "boot-error") this.inFlight -= 1;
    this.onmessage?.(new MessageEvent<WorkerEvent>("message", { data: event }));
  }

  crash(message: string): void {
    this.onerror?.(new ErrorEvent("error", { message }));
  }
}

function progress(worker: MockEngineWorker, request: WorkerRequest, extra: Partial<EngineProgress> = {}): void {
  if (request.type === "boot") return;
  const base = { phase: request.type, index: request.index, total: request.total, fileName: request.fileName };
  worker.emit({ type: "progress", progress: { ...base, ...extra } });
}

/** Happy-path replies for every request type. */
const reply: Script = (worker, request) => {
  if (request.type === "boot") {
    worker.emit({ type: "progress", progress: { phase: "boot", index: 0, total: 1, fileName: "" } });
    worker.emit({ type: "ready", info: INFO, heapBytes: HEAP_BYTES });
    return;
  }
  progress(worker, request);
  progress(worker, request, { ms: 5, ok: true });
  if (request.type === "players") {
    const result = { ok: true as const, players: [], date: null, map: null, durationSec: 0, matchFormat: null, playerCount: 0, isAiGame: false, toonFromPath: null };
    worker.emit({ type: "players", id: request.id, result });
  } else if (request.type === "parse") {
    const outcome = {
      ok: true as const, fileName: request.fileName, relativePath: request.relativePath, gameId: `g-${request.fileName}`,
      json: "{}", date: "2026-05-08T19:08:12Z", myToonHandle: null, matchFormat: "1v1" as const, isResumedFromReplay: false, ms: 5,
    };
    worker.emit({ type: "parsed", id: request.id, outcome, heapBytes: HEAP_BYTES });
  } else {
    worker.emit({ type: "unzipped", id: request.id, entries: [{ name: "a/b.SC2Replay", bytes: new ArrayBuffer(4) }] });
  }
};

/** Reply normally except where `override` returns true (it handled the request). */
function scripted(override: (worker: MockEngineWorker, request: WorkerRequest, nth: number) => boolean): Script {
  let fileRequests = 0;
  return (worker, request) => {
    const nth = request.type === "boot" ? -1 : fileRequests++;
    if (!override(worker, request, nth)) reply(worker, request);
  };
}

function harness(script: Script, options: Omit<EngineClientOptions, "workerFactory"> = {}) {
  const workers: MockEngineWorker[] = [];
  const client = createEngineClient({
    perFileTimeoutMs: TIMEOUT_MS,
    ...options,
    workerFactory: () => {
      const worker = new MockEngineWorker(script);
      workers.push(worker);
      return worker;
    },
  });
  return { client, workers };
}

function intakeFile(name: string, read?: () => Promise<ArrayBuffer>): IntakeFile {
  const bytes = new TextEncoder().encode(`replay ${name}`);
  // jsdom's Blob has no arrayBuffer(); add the one method the client uses.
  const blob = Object.assign(new Blob([bytes]), { arrayBuffer: read ?? (async () => bytes.slice().buffer) });
  return { key: name, name, relativePath: `dir/${name}`, size: bytes.length, lastModified: 0, source: "picker", blob };
}

function parseRequests(count: number): ParseRequest[] {
  return Array.from({ length: count }, (_, i) => ({ file: intakeFile(`r${i}.SC2Replay`), player: { toon: "1-S2-1-1", handle: null } }));
}

const kinds = (outcomes: Array<{ ok: boolean; errorKind?: string }>) => outcomes.map((o) => (o.ok ? "ok" : o.errorKind));

afterEach(() => {
  vi.useRealTimers();
});

describe("createEngineClient: boot", () => {
  it("creates the worker lazily and dedupes concurrent boots", async () => {
    const { client, workers } = harness(reply);
    expect(workers).toHaveLength(0);
    const [first, second] = await Promise.all([client.boot(), client.boot()]);
    expect(first).toEqual(INFO);
    expect(second).toEqual(INFO);
    expect(workers).toHaveLength(1);
    expect(workers[0].received.filter((m) => m.type === "boot")).toHaveLength(1);
    const boot = workers[0].received[0];
    expect(boot.type === "boot" && boot.pointerUrl.endsWith("/engine/current.json")).toBe(true);
  });

  it("propagates a boot error as EngineError and retries with a fresh worker next time", async () => {
    let attempt = 0;
    const script: Script = (worker, request) => {
      if (request.type === "boot" && attempt++ === 0) {
        worker.emit({ type: "boot-error", errorKind: "integrity_failed", detail: "integrity check failed for /x" });
        return;
      }
      reply(worker, request);
    };
    const { client, workers } = harness(script);
    const error = await client.parseFiles(parseRequests(2)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineError);
    expect(error instanceof EngineError && error.kind).toBe("integrity_failed");
    expect(workers[0].terminated).toBe(true);
    expect(kinds(await client.parseFiles(parseRequests(1)))).toEqual(["ok"]);
    expect(workers).toHaveLength(2);
  });

  it("reports a worker that dies before ready (script failed to load) as engine_boot_failed", async () => {
    const script: Script = (worker, request) => {
      if (request.type === "boot") worker.crash("Uncaught SyntaxError: Unexpected token '<'");
    };
    const { client, workers } = harness(script);
    await expect(client.parseFiles(parseRequests(1))).rejects.toMatchObject({ kind: "engine_boot_failed" });
    expect(workers[0].terminated).toBe(true);
  });

  it("reports a worker that cannot be constructed as engine_boot_failed", async () => {
    const client = createEngineClient({
      workerFactory: () => {
        throw new DOMException("blocked by CSP", "SecurityError");
      },
    });
    await expect(client.boot()).rejects.toMatchObject({ kind: "engine_boot_failed", detail: "SecurityError: the engine worker could not be created" });
    await expect(client.listPlayers([intakeFile("a.SC2Replay")])).rejects.toMatchObject({ kind: "engine_boot_failed" });
  });

  it("fails the boot with engine_boot_failed when the worker never becomes ready", async () => {
    vi.useFakeTimers();
    const { client, workers } = harness(() => undefined, { bootTimeoutMs: TIMEOUT_MS });
    const booting = client.boot().catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const error = await booting;
    expect(error instanceof EngineError && error.kind).toBe("engine_boot_failed");
    expect(workers[0].terminated).toBe(true);
  });
});

describe("createEngineClient: parsing", () => {
  it("sends files strictly one at a time, in order, transferring their bytes", async () => {
    const { client, workers } = harness(reply);
    const outcomes = await client.parseFiles(parseRequests(4));
    expect(outcomes.map((o) => o.fileName)).toEqual(["r0.SC2Replay", "r1.SC2Replay", "r2.SC2Replay", "r3.SC2Replay"]);
    const worker = workers[0];
    expect(worker.overlaps).toBe(0);
    const parses = worker.received.filter((m) => m.type === "parse");
    expect(parses.map((m) => m.index)).toEqual([0, 1, 2, 3]);
    parses.forEach((message, i) => expect(worker.transfers[i + 1]).toEqual([message.bytes]));
    expect(parses[0].type === "parse" && parses[0].relativePath).toBe("dir/r0.SC2Replay");
  });

  it("queues concurrent calls behind each other", async () => {
    const { client, workers } = harness(reply);
    const [a, b] = await Promise.all([client.parseFiles(parseRequests(2)), client.listPlayers([intakeFile("p.SC2Replay")])]);
    expect(kinds(a)).toEqual(["ok", "ok"]);
    expect(b[0].ok).toBe(true);
    expect(workers[0].overlaps).toBe(0);
    expect(workers[0].received.map((m) => m.type)).toEqual(["boot", "parse", "parse", "players"]);
  });

  it("forwards boot and per-file progress events", async () => {
    const { client } = harness(reply);
    const events: EngineProgress[] = [];
    await client.parseFiles(parseRequests(2), { onProgress: (event) => events.push(event) });
    expect(events.map((e) => `${e.phase}:${e.index}:${e.ok ?? "start"}`)).toEqual([
      "boot:0:start", "parse:0:start", "parse:0:true", "parse:1:start", "parse:1:true",
    ]);
  });

});

describe("createEngineClient: timeouts, crashes and recycling", () => {
  it("times out a stuck file, respawns the worker and continues", async () => {
    vi.useFakeTimers();
    const { client, workers } = harness(scripted((_worker, request, nth) => request.type === "parse" && nth === 0));
    const events: EngineProgress[] = [];
    const pending = client.parseFiles(parseRequests(2), { onProgress: (event) => events.push(event) });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const outcomes = await pending;
    expect(kinds(outcomes)).toEqual(["timeout", "ok"]);
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].received[0].type).toBe("boot");
    expect(events.some((e) => e.errorKind === "timeout" && e.index === 0)).toBe(true);
  });

  it("uses a 60 s per-file timeout by default", () => {
    expect(DEFAULT_PER_FILE_TIMEOUT_MS).toBe(60_000);
  });

  it("recycles the worker after every `recycleEvery` parses", async () => {
    const { client, workers } = harness(reply, { recycleEvery: 2 });
    expect(kinds(await client.parseFiles(parseRequests(5)))).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(workers).toHaveLength(3);
    expect(workers.map((w) => w.received.filter((m) => m.type === "parse").length)).toEqual([2, 2, 1]);
    expect(workers[0].terminated && workers[1].terminated).toBe(true);
  });

  it("recycles after 150 parses by default", async () => {
    expect(DEFAULT_RECYCLE_EVERY).toBe(150);
    const { client, workers } = harness(reply);
    const outcomes = await client.parseFiles(parseRequests(DEFAULT_RECYCLE_EVERY + 1));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1].received.filter((m) => m.type === "parse")).toHaveLength(1);
  });

});

describe("createEngineClient: crashes and batch failures", () => {
  it("marks a crashed file worker_crashed (or out_of_memory) and continues on a fresh worker", async () => {
    const script = scripted((worker, request, nth) => {
      if (request.type !== "parse" || nth > 1) return false;
      worker.crash(nth === 0 ? "Uncaught RuntimeError: unreachable" : "Uncaught RangeError: Out of memory");
      return true;
    });
    const { client, workers } = harness(script);
    expect(kinds(await client.parseFiles(parseRequests(3)))).toEqual(["worker_crashed", "out_of_memory", "ok"]);
    expect(workers).toHaveLength(3);
  });

  it("kills the worker when a request cannot even be posted, then continues on a fresh one", async () => {
    const workers: MockEngineWorker[] = [];
    let posts = 0;
    const client = createEngineClient({
      perFileTimeoutMs: TIMEOUT_MS,
      workerFactory: () => {
        const worker = new MockEngineWorker(reply);
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (message, transfer) => {
          if (message.type === "parse" && posts++ === 0) throw new DOMException("could not clone", "DataCloneError");
          post(message, transfer);
        };
        workers.push(worker);
        return worker;
      },
    });
    const outcomes = await client.parseFiles(parseRequests(2));
    expect(kinds(outcomes)).toEqual(["worker_crashed", "ok"]);
    expect(outcomes[0]).toMatchObject({ detail: "DataCloneError: unexpected engine response" });
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
  });
});

describe("createEngineClient: failed requests", () => {
  it("recycles the worker after a fatal request-error", async () => {
    const script = scripted((worker, request, nth) => {
      if (request.type !== "parse" || nth !== 0) return false;
      worker.emit({ type: "request-error", id: request.id, errorKind: "out_of_memory", detail: "MemoryError: x" });
      return true;
    });
    const { client, workers } = harness(script);
    expect(kinds(await client.parseFiles(parseRequests(2)))).toEqual(["out_of_memory", "ok"]);
    expect(workers).toHaveLength(2);
  });

  it("reports an unreadable file as parse_failed without touching the worker", async () => {
    const { client, workers } = harness(reply);
    const unreadable = intakeFile("gone.SC2Replay", async () => {
      throw new DOMException("gone", "NotFoundError");
    });
    const outcomes = await client.parseFiles([{ file: unreadable, player: { toon: null, handle: "Me" } }]);
    expect(outcomes[0]).toMatchObject({ ok: false, errorKind: "parse_failed", detail: "NotFoundError: the file could not be read" });
    expect(workers[0].received.map((m) => m.type)).toEqual(["boot"]);
  });

  it("marks the rest of a batch when a re-boot fails mid-batch", async () => {
    vi.useFakeTimers();
    let boots = 0;
    const script: Script = (worker, request) => {
      if (request.type === "boot" && boots++ > 0) {
        worker.emit({ type: "boot-error", errorKind: "engine_unavailable", detail: "engine updated; reload the page" });
        return;
      }
      if (request.type === "parse" && request.index === 0) return;
      reply(worker, request);
    };
    const { client } = harness(script);
    const pending = client.parseFiles(parseRequests(3));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(kinds(await pending)).toEqual(["timeout", "engine_unavailable", "engine_unavailable"]);
  });
});

describe("createEngineClient: cancellation", () => {
  it("cancel() terminates the worker and resolves in-flight and queued work as cancelled", async () => {
    const { client, workers } = harness(scripted((_worker, request) => request.type === "parse"));
    const parsing = client.parseFiles(parseRequests(3));
    const queued = client.listPlayers([intakeFile("q.SC2Replay")]);
    await vi.waitFor(() => expect(workers[0]?.received.some((m) => m.type === "parse")).toBe(true));
    client.cancel();
    expect(kinds(await parsing)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(await queued).toEqual([{ ok: false, errorKind: "cancelled" }]);
    expect(workers[0].terminated).toBe(true);
    expect(workers[0].received.filter((m) => m.type === "parse")).toHaveLength(1);
  });

  it("stays usable after cancel()", async () => {
    const { client, workers } = harness(reply);
    await client.boot();
    client.cancel();
    expect(kinds(await client.parseFiles(parseRequests(1)))).toEqual(["ok"]);
    expect(workers).toHaveLength(2);
  });

  it("an aborted signal cancels only its own call", async () => {
    const { client, workers } = harness(scripted((_worker, request, nth) => request.type === "parse" && nth === 0));
    const controller = new AbortController();
    const aborted = client.parseFiles(parseRequests(2), { signal: controller.signal });
    const next = client.parseFiles(parseRequests(1));
    await vi.waitFor(() => expect(workers[0]?.received.some((m) => m.type === "parse")).toBe(true));
    controller.abort();
    expect(kinds(await aborted)).toEqual(["cancelled", "cancelled"]);
    expect(kinds(await next)).toEqual(["ok"]);
  });

  it("rejects every call after dispose()", async () => {
    const { client } = harness(reply);
    client.dispose();
    await expect(client.boot()).rejects.toMatchObject({ kind: "cancelled" });
    await expect(client.parseFiles(parseRequests(1))).rejects.toBeInstanceOf(EngineError);
  });
});

describe("createEngineClient: zip and players", () => {
  it("expands a zip into IntakeFiles under the archive path", async () => {
    const { client } = harness(reply);
    const zip = intakeFile("replays.zip");
    const files = await client.expandZip(zip);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: "b.SC2Replay", relativePath: "dir/replays.zip/a/b.SC2Replay", size: 4, source: "zip" });
  });

  it("rejects expandZip with the guard's error kind", async () => {
    const script = scripted((worker, request) => {
      if (request.type !== "unzip") return false;
      worker.emit({ type: "request-error", id: request.id, errorKind: "too_large", detail: "zip_too_large" });
      return true;
    });
    const { client } = harness(script);
    await expect(client.expandZip(intakeFile("big.zip"))).rejects.toMatchObject({ kind: "too_large", detail: "zip_too_large" });
  });

  it("maps a players request-error to a failed PlayersResult", async () => {
    const script = scripted((worker, request) => {
      if (request.type !== "players") return false;
      worker.emit({ type: "request-error", id: request.id, errorKind: "parse_failed", detail: "ValueError: x" });
      return true;
    });
    const { client } = harness(script);
    expect(await client.listPlayers([intakeFile("x.SC2Replay")])).toEqual([
      { ok: false, errorKind: "parse_failed", detail: "ValueError: x" },
    ]);
  });
});

describe("createEngineClient: heap accessor", () => {
  it("reports null before boot, then the heap from the latest ready and parsed events", async () => {
    const parsedHeap = HEAP_BYTES * 2;
    const script = scripted((worker, request) => {
      if (request.type !== "parse") return false;
      const outcome = {
        ok: true as const, fileName: request.fileName, relativePath: request.relativePath, gameId: "g",
        json: "{}", date: "2026-05-08T19:08:12Z", myToonHandle: null, matchFormat: "1v1" as const, isResumedFromReplay: false, ms: 5,
      };
      worker.emit({ type: "parsed", id: request.id, outcome, heapBytes: parsedHeap });
      return true;
    });
    const { client } = harness(script);
    expect(client.lastHeapBytes?.()).toBeNull();
    await client.boot();
    expect(client.lastHeapBytes?.()).toBe(HEAP_BYTES);
    await client.parseFiles(parseRequests(1));
    expect(client.lastHeapBytes?.()).toBe(parsedHeap);
  });
});
