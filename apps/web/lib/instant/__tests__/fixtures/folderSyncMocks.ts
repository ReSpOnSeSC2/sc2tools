/**
 * MOCK collaborators for the Folder Sync runner tests: an EngineClient
 * that never starts a worker or Pyodide, an in-memory ledger store instead
 * of IndexedDB, and an `uploadGames` that accepts everything.
 *
 * Example:
 *   const { input, uploads } = setup([replay("a.SC2Replay")]);
 *   await runFolderSync(input);
 */
import { vi } from "vitest";

import type { FolderReplay } from "../../folderSync";
import type { FolderSyncInput, FolderSyncStore } from "../../folderSyncRunner";
import type { LedgerEntry } from "../../ledger";
import { toonFromPath } from "../../toonPath";
import type { EngineClient, EngineInfo, IntakeFile, ParseOutcome, ParseRequest, PlayersResult, UploadableGame } from "../../types";
import type { UploadDeps, UploadSummary } from "../../uploader";

export const ME = "1-S2-1-111";
export const ROOT = `Accounts/9/${ME}/Replays/Multiplayer`;
export const NOW = Date.parse("2026-09-28T12:00:00Z");
const INFO: EngineInfo = { engineVersion: "1.6.3", pyodideVersion: "314.0.7", pythonVersion: "3.14", bundleId: "b", bootMs: 1 };

export function replay(name: string, dir = ROOT, lastModified = NOW - 1000): FolderReplay {
  const file = new File([new Uint8Array([1, 2, 3])], name, { lastModified });
  return { getFile: async () => file, name, relativePath: `${dir}/${name}`, size: file.size, lastModified };
}

/** MOCK engine: every replay is a 1v1 between the path toon (or ME) and an opponent. */
export class MockEngine implements EngineClient {
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
export function memoryStore(initial: LedgerEntry[] = []) {
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
export function acceptAll(games: ReadonlyArray<UploadableGame>): UploadSummary {
  return {
    accepted: games.map((game) => ({ gameId: game.gameId, created: true })),
    rejected: [],
    skippedExisting: [],
    oversized: [],
    pending: [],
  };
}

export function setup(files: FolderReplay[], ledger: LedgerEntry[] = [], overrides: Partial<FolderSyncInput> = {}) {
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
