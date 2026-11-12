import { webcrypto } from "node:crypto";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntakeFile, ReplayHeader, ReplayHeaderPlayer, ReplayHeaderResult } from "@/lib/instant/types";
import { idbTransactionOn, requestToPromise } from "@/lib/instant/idb";
import { clearCareerCache, readCareerCache, saveCareerCache } from "./careerCache";
import { careerRecord } from "./careerRecord";
import { scanCareer } from "./careerScan";
import { selectedGamesFromHeaders, type SelectedHeader } from "./headerRows";

const fakeEngine = vi.hoisted(() => ({ scanHeaders: vi.fn(), dispose: vi.fn(), create: vi.fn() }));

vi.mock("@/lib/instant/engineClient", () => ({
  createEngineClient: fakeEngine.create,
}));

const ME: ReplayHeaderPlayer = {
  name: "Fixture Alpha", toon: "1-S2-1-11", race: "Terran", result: "Win", pid: 1,
  selectedRace: null, mmr: 3200, leagueId: null,
};
const OPP: ReplayHeaderPlayer = {
  name: "Fixture Beta", toon: "1-S2-1-22", race: "Zerg", result: "Loss", pid: 2,
  selectedRace: null, mmr: 3200, leagueId: null,
};

function header(overrides: Partial<ReplayHeader> = {}): ReplayHeader & { date: string } {
  return {
    ok: true, players: [ME, OPP], map: "Map One",
    durationSec: 600, matchFormat: "1v1", playerCount: 2, isAiGame: false, toonFromPath: null,
    startedAt: null, utcOffsetHours: null, isLadderGame: true,
    gameVersion: null, gameBuild: null, expansion: "LotV", ...overrides,
    date: overrides.date ?? "2026-06-03T20:00:00Z",
  };
}

function intake(body: string, path = "1-S2-1-11/Fixture.SC2Replay", size = body.length): IntakeFile {
  const blob = new Blob([body]);
  Object.defineProperty(blob, "arrayBuffer", { value: async () => new TextEncoder().encode(body).buffer });
  return {
    key: `same-${size}`, name: path.split("/").at(-1) ?? "", relativePath: path, blob, size,
    lastModified: Date.UTC(2032, 7, 7), source: "folder",
  };
}

function game(date: string, overrides: Partial<ReplayHeader> = {}, player: ReplayHeaderPlayer = ME): SelectedHeader {
  return { key: date, header: header({ date, ...overrides }), me: player, opponent: OPP };
}

const OK = () => ({ signal: new AbortController().signal, onProgress: vi.fn() });
const A = "a".repeat(64);

async function cache() {
  const value = await readCareerCache();
  if (!value) throw new Error("Test IndexedDB unavailable");
  return value;
}

async function replaceSnapshot(value: unknown) {
  const db = await requestToPromise(indexedDB.open("sc2tools-career"));
  try {
    await idbTransactionOn(db, "cache", "readwrite", (tx) => {
      tx.objectStore("cache").put(value, "snapshot");
    });
  } finally {
    db.close();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("crypto", webcrypto);
  fakeEngine.create.mockReturnValue(fakeEngine);
  fakeEngine.scanHeaders.mockReset().mockImplementation(async (files: IntakeFile[]) => files.map(() => header()));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("career replay scan", () => {
  it("uses the replay date across years and skips reparsing identical bytes when mtime or paths differ", async () => {
    fakeEngine.scanHeaders.mockResolvedValueOnce([header({ date: "2019-04-06T22:30:00Z" })]);
    const first = await scanCareer([intake("same")], OK());
    const second = await scanCareer([{ ...intake("same", "1-S2-1-22/Renamed.SC2Replay"), lastModified: 0 }], OK());
    expect(first?.rows[0].header.date).toBe("2019-04-06T22:30:00Z");
    expect(first?.rows[0].header.toonFromPath).toBe("1-S2-1-11");
    expect(second?.rows[0].header.toonFromPath).toBe("1-S2-1-22");
    expect(second?.reused).toBe(1);
    expect(fakeEngine.create).toHaveBeenCalledTimes(1);
    expect(fakeEngine.create).toHaveBeenCalledWith({ refreshPolicy: false });
    expect(fakeEngine.dispose).toHaveBeenCalledTimes(1);
    expect([...(await cache()).rows.values()][0]?.toonFromPath).toBeNull();
  });

  it("parses only additions and same-size replacements, and leaves deleted rows out", async () => {
    const kept = intake("kept");
    const removed = intake("drop");
    const changed = intake("edit");
    await scanCareer([kept, removed], OK());
    const result = await scanCareer([kept, changed], OK());
    expect(result?.reused).toBe(1);
    expect(result?.rows).toHaveLength(2);
    expect(fakeEngine.scanHeaders.mock.lastCall?.[0]).toEqual([changed]);
    expect((await cache()).rows.size).toBe(2);
    expect((await scanCareer([removed], OK()))?.reused).toBe(0);
  });

  it("parses identical copies once but preserves the path hints and distinct session keys", async () => {
    const left = intake("same");
    const right = intake("same", "1-S2-1-22/Fixture.SC2Replay");
    const result = await scanCareer([left, right], OK());
    expect(fakeEngine.scanHeaders.mock.lastCall?.[0]).toEqual([left]);
    const rows = result?.rows ?? [];
    expect(new Set(rows.map(({ key }) => key)).size).toBe(2);
    expect(rows.map(({ header: row }) => row.toonFromPath)).toEqual([ME.toon, OPP.toon]);
    expect(selectedGamesFromHeaders(rows)).toHaveLength(1);
  });

  it("uses the shared ladder filter and caches exclusions, but never caches parse failures", async () => {
    fakeEngine.scanHeaders.mockResolvedValueOnce([
      header(),
      header({ isLadderGame: false }),
      header({ isAiGame: true }),
      { ok: false, errorKind: "corrupt_file" } satisfies ReplayHeaderResult,
    ]);
    const files = [intake("one"), intake("two"), intake("three"), intake("four")];
    const first = await scanCareer(files, OK());
    expect(first).toMatchObject({ reused: 0, unreadable: 1 });
    expect(first?.rows).toHaveLength(1);
    expect((await cache()).rows.size).toBe(3);
    const second = await scanCareer(files, OK());
    expect(second?.reused).toBe(3);
    expect(fakeEngine.scanHeaders.mock.lastCall?.[0]).toEqual([files[3]]);
  });

  it("reports no files, empty ladder data and all-file failures separately", async () => {
    await expect(scanCareer([intake("abc", "hello.txt")], OK())).resolves.toBeNull();
    fakeEngine.scanHeaders.mockResolvedValueOnce([header({ matchFormat: "team" })]);
    await expect(scanCareer([intake("team")], OK())).resolves.toMatchObject({ rows: [], unreadable: 0 });
    await expect(scanCareer([intake("", "empty.SC2Replay")], OK())).rejects.toThrow("Could not read");
  });

  it("still reads headers when storage is refused or a write exceeds the quota", async () => {
    const quota = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("Quota", "QuotaExceededError");
    });
    await expect(scanCareer([intake("quota")], OK())).resolves.toMatchObject({ cacheAvailable: false, unreadable: 0 });
    expect(quota).toHaveBeenCalledTimes(1);
    expect((await cache()).rows.size).toBe(0);
    vi.stubGlobal("indexedDB", undefined);
    await expect(scanCareer([intake("memory")], OK())).resolves.toMatchObject({ cacheAvailable: false, unreadable: 0 });
  });

  it("does not keep a cancelled scan or its worker", async () => {
    const controller = new AbortController();
    fakeEngine.scanHeaders.mockImplementationOnce(async () => {
      controller.abort();
      return [header()];
    });
    await expect(scanCareer([intake("abort")], { ...OK(), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fakeEngine.dispose).toHaveBeenCalledTimes(1);
    expect((await cache()).rows.size).toBe(0);
  });
});

describe("career header storage", () => {
  it("ignores obsolete and invalid cache rows and reloads valid headers", async () => {
    const snapshot = await cache();
    const rows = new Map([[A, header()]]);
    expect(await saveCareerCache({ ...snapshot, rows })).toBe(true);
    expect((await cache()).rows.get(A)).toEqual(header());
    await replaceSnapshot({ format: "obsolete", rows: [...rows] });
    expect((await cache()).rows.size).toBe(0);

    await saveCareerCache({ ...snapshot, rows });
    const db = await requestToPromise(indexedDB.open("sc2tools-career"));
    const saved: unknown = await requestToPromise(db.transaction("cache").objectStore("cache").get("snapshot"));
    db.close();
    if (!saved || typeof saved !== "object" || !("format" in saved)) throw new Error("Missing cache fixture");
    await replaceSnapshot({ format: saved.format, rows: [
      [A, { ok: true, players: "bad" }], ["not-a-hash", header()], [A],
    ] });
    expect((await cache()).rows.size).toBe(0);
  });

  it("atomically clears data and rejects a stale writer from another tab", async () => {
    const stale = await cache();
    const rows = new Map([[A, header()]]);
    await saveCareerCache({ ...stale, rows });
    expect(await clearCareerCache()).toBe(true);
    await saveCareerCache({ ...stale, rows });
    const after = await cache();
    expect(after.rows.size).toBe(0);
    expect(after.generation).not.toBe(stale.generation);
    await saveCareerCache({ ...after, rows });
    expect((await cache()).rows.get(A)).toEqual(header());
  });
});

describe("career record", () => {
  it("summarizes the observed timeline, races, maps, durations and UTC match days", () => {
    const result = careerRecord([
      game("2021-01-01T02:10:00+02:00", { map: "Zulu", durationSec: 0 }, { ...ME, selectedRace: "Random" }),
      game("2020-04-02T23:00:00-02:00", { map: "Beta", durationSec: 3601 }),
      game("2020-01-03T01:00:00Z", { map: "Alpha", durationSec: 600, expansion: "HotS" }),
    ]);
    expect(result).toMatchObject({
      first: { day: "2020-01-03", map: "Alpha" },
      games: 3, seconds: 4201, timedGames: 2, weekdays: [5], weekdayGames: 3,
      eras: [
        { era: "Heart of the Swarm", games: 1 },
        { era: "Legacy of the Void", firstDay: "2020-04-03", lastDay: "2021-01-01", games: 2 },
      ],
      years: [
        { year: 2020, games: 2, map: "Alpha", mapGames: 1, races: [{ race: "Terran", games: 2 }] },
        { year: 2021, games: 1, map: "Zulu", mapGames: 1, races: [{ race: "Random", games: 1 }] },
      ],
      gaps: [{ days: 91, after: "2020-01-03", before: "2020-04-03" }, { days: 273, after: "2020-04-03", before: "2021-01-01" }],
    });
  });

  it("keeps short gaps out and missing expansion, race, map and duration unknown", () => {
    expect(careerRecord([])).toBeNull();
    expect(careerRecord([
      game("2026-01-01T00:00:00Z", { expansion: null, map: " ", durationSec: Infinity }, { ...ME, race: "unrecognized" }),
      game("2026-03-31T00:00:00Z", { expansion: null, map: null, durationSec: -1 }, { ...ME, race: "unrecognized" }),
    ])).toMatchObject({
      seconds: 0, timedGames: 0, gaps: [],
      eras: [{ era: "Unknown", games: 2 }],
      years: [{ year: 2026, games: 2, map: null, mapGames: 0, races: [{ race: "Unknown", games: 2 }] }],
    });
  });
});
