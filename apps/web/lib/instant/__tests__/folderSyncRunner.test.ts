/**
 * runFolderSync — ledger diffing, lazy engine start, chunking, exact
 * player identity and ledger writes, driven with a MOCK EngineClient
 * (no worker, no Pyodide), a MOCK `uploadGames` and an in-memory MOCK
 * ledger store.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FolderReplay } from "../folderSync";
import { runFolderSync, runFolderSyncExclusive, type FolderSyncInput, type FolderSyncStore } from "../folderSyncRunner";
import { ledgerEntryFor, type LedgerEntry } from "../ledger";
import { toonFromPath } from "../toonPath";
import type { EngineClient, EngineInfo, IntakeFile, ParseOutcome, ParseRequest, PlayersResult, UploadableGame } from "../types";
import type { UploadDeps, UploadSummary } from "../uploader";

const { gaEvent } = vi.hoisted(() => ({ gaEvent: vi.fn() }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent }));

const ME = "1-S2-1-111";
const ROOT = `Accounts/9/${ME}/Replays/Multiplayer`;
const NOW = Date.parse("2026-09-28T12:00:00Z");
const INFO: EngineInfo = { engineVersion: "1.6.3", pyodideVersion: "314.0.7", pythonVersion: "3.14", bundleId: "b", bootMs: 1 };

function replay(name: string, dir = ROOT, lastModified = NOW - 1000): FolderReplay {
  const file = new File([new Uint8Array([1, 2, 3])], name, { lastModified });
  return { getFile: async () => file, name, relativePath: `${dir}/${name}`, size: file.size, lastModified };
}

/** MOCK engine: every replay is a 1v1 between the path toon (or ME) and an opponent. */
class MockEngine implements EngineClient {
  readonly aiGames = new Set<string>();
  readonly failParse = new Set<string>();
  boot = vi.fn(async () => INFO);
  listPlayers = vi.fn(async (files: IntakeFile[]): Promise<PlayersResult[]> =>
    files.map((file) => ({
      ok: true,
      players: [
        { name: "Me", toon: ME, race: "Zerg", result: "Win", pid: 1 },
        { name: "Opp", toon: `2-S2-1-${file.name.length}`, race: "Terran", result: "Loss", pid: 2 },
      ],
      date: "2026-09-01T00:00:00Z",
      map: "Map",
      durationSec: 600,
      matchFormat: "1v1",
      playerCount: 2,
      isAiGame: this.aiGames.has(file.name),
      toonFromPath: toonFromPath(file.relativePath),
    })),
  );
  parseFiles = vi.fn(async (requests: ParseRequest[]): Promise<ParseOutcome[]> =>
    requests.map((request) => {
      const { name, relativePath } = request.file;
      if (this.failParse.has(name)) return { ok: false, fileName: name, relativePath, errorKind: "timeout", ms: 1 };
      return {
        ok: true, fileName: name, relativePath, gameId: `g-${name}`, json: "{}", date: "2026-09-01T00:00:00Z",
        myToonHandle: request.player.toon, matchFormat: "1v1", isResumedFromReplay: false, ms: 1,
      };
    }),
  );
  expandZip = vi.fn(async () => []);
  cancel = vi.fn();
  dispose = vi.fn();
}

/** MOCK store (in memory, instead of IndexedDB). */
function memoryStore(initial: LedgerEntry[] = []) {
  const ledger = new Map(initial.map((entry) => [entry.path, entry]));
  const saves: LedgerEntry[][] = [];
  let lastScan: number | null = null;
  const store: FolderSyncStore = {
    loadLedger: async () => [...ledger.values()],
    saveLedgerEntries: async (entries) => {
      saves.push([...entries]);
      entries.forEach((entry) => ledger.set(entry.path, entry));
    },
    setLastFolderScanAt: async (at) => {
      lastScan = at;
    },
  };
  return { store, ledger, saves, lastScan: () => lastScan };
}

/** MOCK uploadGames: accepts everything unless told otherwise. */
function acceptAll(games: ReadonlyArray<UploadableGame>): UploadSummary {
  return {
    accepted: games.map((game) => ({ gameId: game.gameId, created: true })),
    rejected: [],
    skippedExisting: [],
    oversized: [],
    pending: [],
  };
}

function setup(files: FolderReplay[], ledger: LedgerEntry[] = [], overrides: Partial<FolderSyncInput> = {}) {
  const engine = new MockEngine();
  const engineFactory = vi.fn(() => engine);
  const uploads: string[][] = [];
  const uploadGames = vi.fn(async (games: ReadonlyArray<UploadableGame>, _deps: UploadDeps) => {
    uploads.push(games.map((game) => game.gameId));
    return acceptAll(games);
  });
  const memory = memoryStore(ledger);
  const input: FolderSyncInput = {
    source: { files },
    engineFactory,
    getToken: async () => "token",
    apiBase: "https://api.test",
    engineVersion: "1.6.3",
    profileToons: [],
    now: () => NOW,
    store: memory.store,
    services: { uploadGames },
    ...overrides,
  };
  return { engine, engineFactory, uploadGames, uploads, memory, input };
}

afterEach(() => {
  gaEvent.mockReset();
});

describe("runFolderSync: ledger", () => {
  it("never starts the engine when the ledger already settled every file", async () => {
    const files = [replay("a.SC2Replay"), replay("b.SC2Replay")];
    const ledger = files.map((file) => ledgerEntryFor(file, "uploaded", NOW - 5000, { gameId: `g-${file.name}` }));
    const { engineFactory, uploadGames, memory, input } = setup(files, ledger);

    const summary = await runFolderSync(input);

    expect(engineFactory).not.toHaveBeenCalled();
    expect(uploadGames).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ found: 2, newFiles: 0, engineStarted: false, uploaded: 0 });
    expect(memory.lastScan()).toBe(NOW);
  });

  it("parses and uploads new files as the path toon, then writes the ledger", async () => {
    const files = [replay("a.SC2Replay"), replay("b.SC2Replay")];
    const settled = ledgerEntryFor(files[0], "uploaded", NOW - 5000, { gameId: "g-a.SC2Replay" });
    const { engine, uploads, memory, input } = setup(files, [settled]);

    const summary = await runFolderSync(input);

    expect(engine.parseFiles.mock.calls[0]?.[0].map((request) => request.player)).toEqual([{ toon: ME, handle: "Me" }]);
    expect(uploads).toEqual([["g-b.SC2Replay"]]);
    expect(memory.ledger.get(files[1].relativePath)).toMatchObject({ status: "uploaded", gameId: "g-b.SC2Replay" });
    expect(summary).toMatchObject({ found: 2, newFiles: 1, processed: 1, uploaded: 1, created: 1, engineStarted: true });
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    expect(memory.lastScan()).toBe(NOW);
  });

  it("retries files that failed for a transient reason but not permanent failures", async () => {
    const files = [replay("slow.SC2Replay"), replay("broken.SC2Replay")];
    const ledger = [
      ledgerEntryFor(files[0], "failed", NOW - 5000, { errorKind: "timeout" }),
      ledgerEntryFor(files[1], "failed", NOW - 5000, { errorKind: "corrupt_file" }),
    ];
    const { engine, uploads, input } = setup(files, ledger);

    const summary = await runFolderSync(input);

    expect(engine.listPlayers.mock.calls[0]?.[0].map((file) => file.name)).toEqual(["slow.SC2Replay"]);
    expect(uploads).toEqual([["g-slow.SC2Replay"]]);
    expect(summary.newFiles).toBe(1);
  });

  it("records a transient parse failure as failed (retried next scan) and AI games as skipped", async () => {
    const files = [replay("ai.SC2Replay"), replay("slow.SC2Replay")];
    const { engine, memory, input } = setup(files);
    engine.aiGames.add("ai.SC2Replay");
    engine.failParse.add("slow.SC2Replay");

    const summary = await runFolderSync(input);

    expect(memory.ledger.get(files[0].relativePath)).toMatchObject({ status: "skipped", errorKind: "ai_game" });
    expect(memory.ledger.get(files[1].relativePath)).toMatchObject({ status: "failed", errorKind: "timeout" });
    expect(summary.failed.map((failure) => failure.errorKind).sort()).toEqual(["ai_game", "timeout"]);
  });

});

describe("runFolderSync: player identity", () => {
  it("never guesses the player for replays outside a toon folder", async () => {
    const files = [replay("loose.SC2Replay", "Multiplayer")];
    const { engine, memory, input } = setup(files);

    const summary = await runFolderSync(input);

    expect(engine.parseFiles).not.toHaveBeenCalled();
    expect(summary.failed.map((failure) => failure.errorKind)).toEqual(["player_unresolved"]);
    expect(memory.ledger.get(files[0].relativePath)).toMatchObject({ status: "failed", errorKind: "player_unresolved" });
  });

  it("resolves loose replays through a toon the profile already knows", async () => {
    const files = [replay("loose.SC2Replay", "Multiplayer")];
    const { uploads, input } = setup(files, [], { profileToons: [ME] });
    await runFolderSync(input);
    expect(uploads).toEqual([["g-loose.SC2Replay"]]);
  });

  it("loads profile toons only when there is something new to parse", async () => {
    const files = [replay("loose.SC2Replay", "Multiplayer")];
    const settled = [ledgerEntryFor(files[0], "uploaded", NOW - 5000, { gameId: "g-loose.SC2Replay" })];
    const idle = vi.fn(async () => [ME]);
    await runFolderSync(setup(files, settled, { profileToons: idle }).input);
    expect(idle).not.toHaveBeenCalled();

    const busy = vi.fn(async () => [ME]);
    const { uploads, input } = setup(files, [], { profileToons: busy, chunkSize: 1 });
    await runFolderSync(input);
    expect(busy).toHaveBeenCalledTimes(1);
    expect(uploads).toEqual([["g-loose.SC2Replay"]]);
  });

});

describe("runFolderSync: chunks and early stops", () => {
  it("processes large folders in chunks and saves the ledger after each one", async () => {
    const files = Array.from({ length: 5 }, (_, index) => replay(`r${index}.SC2Replay`));
    const { engine, uploads, memory, input } = setup(files, [], { chunkSize: 2 });

    const summary = await runFolderSync(input);

    expect(engine.listPlayers.mock.calls.map(([batch]) => batch.length)).toEqual([2, 2, 1]);
    expect(uploads.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(memory.saves.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(summary).toMatchObject({ processed: 5, uploaded: 5 });
  });

  it("stops after the daily cap and leaves pending games out of the ledger", async () => {
    const files = Array.from({ length: 4 }, (_, index) => replay(`r${index}.SC2Replay`));
    const { uploadGames, memory, input } = setup(files, [], { chunkSize: 2 });
    uploadGames.mockImplementationOnce(async (games) => ({
      ...acceptAll(games.slice(0, 1)),
      pending: [games[1].gameId],
      stoppedReason: "daily_cap",
    }));

    const summary = await runFolderSync(input);

    expect(uploadGames).toHaveBeenCalledTimes(1);
    expect(memory.ledger.size).toBe(1);
    expect(summary).toMatchObject({ uploaded: 1, pending: 1, stoppedReason: "daily_cap" });
    expect(memory.lastScan()).toBe(NOW);
  });

  it("walks a directory handle when one is given", async () => {
    const files = [replay("a.SC2Replay")];
    const walk = vi.fn(async () => files);
    const handle = { kind: "directory" as const, name: "StarCraft II", values: () => ({ async *[Symbol.asyncIterator]() {} }) };
    const { uploads, input } = setup([], [], { source: { handle } });
    input.services = { ...input.services, walk };

    await runFolderSync(input);

    expect(walk).toHaveBeenCalledWith(handle, expect.objectContaining({ signal: undefined }));
    expect(uploads).toEqual([["g-a.SC2Replay"]]);
  });

});

describe("runFolderSync: cancel and engine failure", () => {
  it("resolves as aborted without recording a scan time when cancelled", async () => {
    const controller = new AbortController();
    const files = [replay("a.SC2Replay")];
    const { engine, memory, input } = setup(files, [], { signal: controller.signal });
    engine.listPlayers.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("cancelled");
    });

    const summary = await runFolderSync(input);

    expect(summary.aborted).toBe(true);
    expect(memory.lastScan()).toBeNull();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("rethrows engine start failures but still waits before the next auto scan", async () => {
    const { engine, memory, input } = setup([replay("a.SC2Replay")]);
    engine.listPlayers.mockRejectedValueOnce(new Error("boot failed"));
    await expect(runFolderSync(input)).rejects.toThrow("boot failed");
    expect(memory.lastScan()).toBe(NOW);
    expect(memory.ledger.size).toBe(0);
  });
});

describe("runFolderSyncExclusive", () => {
  it("runs one pass at a time in a tab", async () => {
    const files = [replay("a.SC2Replay")];
    const { input, uploadGames } = setup(files);
    let release: () => void = () => undefined;
    uploadGames.mockImplementationOnce(
      (games) => new Promise((resolve) => {
        release = () => resolve(acceptAll(games));
      }),
    );
    const first = runFolderSyncExclusive(input);
    await vi.waitFor(() => expect(uploadGames).toHaveBeenCalled());
    await expect(runFolderSyncExclusive(input)).resolves.toBeNull();
    release();
    await expect(first).resolves.toMatchObject({ uploaded: 1 });
  });
});
