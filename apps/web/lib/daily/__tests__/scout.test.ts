import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readDailyIndex } from "../clip";
import { loadDailySlot } from "../loadDaily";
import { completeDay, readResults, streakOn } from "../progress";
import { practiceDay, shareDaily, utcDay } from "../rules";
import { readScoutPack, SCOUT_ROOT, scoutChoices } from "../scout";
import { scoutPracticeWeek } from "../scoutPractice";
import { detectorLabelsMatch, SCOUT_DETECTOR_FILES, scoutPuzzleFrom } from "../scoutSource";

const detectorRoot = resolve("../replay-engine/core");
const assets = resolve("public/daily/scout/v1");
const source = {
  consented: true, side: "me", labelSource: "detector", strategy: "Terran - Proxy Rax",
  crop: { left: 50, bottom: 100, width: 80, height: 80 },
  file: "private/path.json", recordedOn: "2024-07-03", player: "NameCanary",
};
const playback = {
  replaySha256: "hash-canary", mapName: "map-canary",
  fidelity: { positions: "tracker", complete: true },
  buildings: [
    { owner: "me", name: "Barracks", x: 80.125, y: 110.333, t: 38.25, id: "tag-canary", moves: [120, 10, 12] },
    { owner: "opp", name: "Bunker", x: 77, y: 119, t: 44 },
    { owner: "me", name: "SupplyDepot", x: 71, y: 105, t: 19 },
    { owner: "me", name: "CommandCenter", x: 65, y: 103, t: 0 },
    { owner: "me", name: "Factory", x: 49, y: 108, t: 123 },
    { owner: "me", name: "Bunker", x: 78, y: 125, t: 361 },
    { owner: "me", name: "custom-canary", x: 80, y: 120, t: 30 },
  ],
};

describe("Daily Scout publication", () => {
  it("allows only the selected canonical strategy detector returns", () => {
    const python = SCOUT_DETECTOR_FILES.map(file => readFileSync(resolve(detectorRoot, file), "utf8")).join("\n");
    expect(detectorLabelsMatch(python)).toBe(true);
    expect(detectorLabelsMatch(python.replace('return "Terran - Proxy Rax"', 'return "Terran - My custom build"'))).toBe(false);
    expect(() => scoutPuzzleFrom({ ...source, strategy: "Terran - My custom build" }, playback)).toThrow("Unsupported detector label");
    expect(() => scoutPuzzleFrom({ ...source, labelSource: "custom" }, playback)).toThrow("consent");
    expect(() => scoutPuzzleFrom({ ...source, consented: false }, playback)).toThrow("consent");
    expect(() => scoutPuzzleFrom(source, { ...playback, fidelity: { positions: "engine", complete: true } })).toThrow("Tracker");
    expect(() => scoutPuzzleFrom(source, { ...playback, fidelity: { positions: "tracker", complete: false } })).toThrow("Tracker");
  });

  it("keeps only crop-relative fixed coordinates, building type and relative game time", () => {
    const puzzle = scoutPuzzleFrom(source, playback);
    expect(puzzle).toEqual({
      strategy: source.strategy, width: 80, height: 80,
      buildings: [["CommandCenter", 0, 15, 3], ["SupplyDepot", 19, 21, 5], ["Barracks", 38.25, 30.125, 10.333]],
    });
    expect(scoutPuzzleFrom(source, { ...playback, buildings: [...playback.buildings].reverse() })).toEqual(puzzle);
  });

  it("rejects extra metadata, unknown building keys, range violations and unsorted timelines", () => {
    const [pack] = scoutPracticeWeek();
    const [puzzle, ...rest] = pack.puzzles;
    for (const bad of [
      { ...puzzle, player: "canary" },
      { ...puzzle, strategy: "canary" },
      { ...puzzle, buildings: [["constructor", 0, 2, 2], ...puzzle.buildings] },
      { ...puzzle, buildings: [["Bunker", 0, -1, 2], ...puzzle.buildings] },
      { ...puzzle, buildings: [...puzzle.buildings].reverse() },
    ]) expect(readScoutPack({ ...pack, puzzles: [bad, ...rest] })).toBeNull();
    expect(readScoutPack({ ...pack, map: "canary" })).toBeNull();
  });

  it("commits seven deterministic practice sets and no Tracker days", () => {
    const index = readDailyIndex(JSON.parse(readFileSync(resolve(assets, "index.json"), "utf8")));
    expect(index?.days).toEqual({});
    const week = scoutPracticeWeek();
    expect(new Set(index?.practice).size).toBe(7);
    week.forEach((pack, day) => {
      const json = readFileSync(resolve(assets, "packs", index?.practice[day] ?? "", "pack.json"), "utf8");
      expect(json).toBe(JSON.stringify(pack));
      expect(createHash("sha256").update(json).digest("hex")).toBe(index?.practice[day]);
      expect(readScoutPack(JSON.parse(json))).toEqual(pack);
      for (const puzzle of pack.puzzles) expect(scoutChoices(puzzle.strategy)).toHaveLength(3);
    });
  });
});

it("uses the UTC rotation and keeps fight, Scout and practice progress independent", () => {
  const start = utcDay(Date.parse("2026-11-01T23:59:59Z"));
  expect(utcDay(Date.parse("2026-11-02T00:00:00Z"))).toBe(start + 1);
  expect(practiceDay(start + 7)).toBe(practiceDay(start));
  const keys = new Map<string, string>();
  const storage = { getItem: (key: string) => keys.get(key) ?? null, setItem: (key: string, value: string) => keys.set(key, value) };
  const correct = [true, false, true, false, false];
  completeDay(storage, "practice", start, correct, "scout");
  expect(readResults(storage, "practice")).toEqual({});
  expect(readResults(storage, "recorded", "scout")).toEqual({});
  expect(streakOn(readResults(storage, "practice", "scout"), start)).toBe(1);
  expect(shareDaily(start, true, correct, { title: "Daily Scout", path: "/arcade/scout" })).toBe(
    "Daily Scout practice · 2026-11-01\n■□■□□  2/5\nhttps://sc2tools.com/arcade/scout",
  );
});

it("resolves a scheduled Tracker digest and falls back to practice only on unscheduled days", async () => {
  const scheduled = "a".repeat(64), practice = "b".repeat(64);
  const load = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
    version: 1, days: { 21000: scheduled }, practice: Array.from({ length: 7 }, () => practice),
  })));
  const signal = new AbortController().signal;
  try {
    expect(await loadDailySlot(21000, signal, SCOUT_ROOT)).toEqual({
      kind: "recorded", digest: scheduled, directory: SCOUT_ROOT + "/packs/" + scheduled,
    });
    expect((await loadDailySlot(21001, signal, SCOUT_ROOT)).kind).toBe("practice");
    expect(load).toHaveBeenCalledWith(SCOUT_ROOT + "/index.json", { signal, cache: "no-cache" });
  } finally {
    load.mockRestore();
  }
});
