import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { sanitizeMapPlayback, unitVisibleAt, type PlaybackBuilding } from "../../mapReplay";
import { selectFights } from "../buildPack";
import { fightPlayback, readDailyIndex, readDailyPack } from "../clip";
import { cropUnit } from "../cropFight";
import { fixtureWeek } from "../fixtureWeek";
import { gradeTrade, unambiguousTrade } from "../rules";

const bounds = { minX: 0, minY: 0, maxX: 120, maxY: 100 };
const sourceIdentity = {
  id: "159773825233",
  replaySha256: "e".repeat(64),
  gameDate: "2026-11-01T02:00:00Z",
  displayName: "Private Opponent",
};

function fighter(owner: "me" | "opp", died: number | null, x = 52) {
  return {
    ...sourceIdentity,
    owner, name: "Marine", born: 10, died,
    wp: [10, x, 55, 20, x, 55, 32, x + 1, 56],
    attacks: [20],
    aim: [20, x, 55],
  };
}

function recording() {
  return {
    ...sourceIdentity,
    v: 7, bounds, gameLength: 90, mapName: "Private map",
    fidelity: { positions: "engine", attacks: "observed", paths: "observed", creep: "estimated", complete: true },
    units: [fighter("me", null), fighter("me", 23), fighter("opp", null),
      fighter("opp", 24), fighter("opp", 24.5), fighter("opp", 25), fighter("opp", 25.5), fighter("opp", 26)],
  };
}

type Recording = ReturnType<typeof recording> & { buildings?: PlaybackBuilding[] };

function selection(raw: Recording = recording(), era = "after" as const, seed = 0, range = { start: 0, end: 60 }) {
  const playback = sanitizeMapPlayback(raw);
  if (!playback) throw new Error("Invalid test playback");
  return selectFights(playback, range, era, seed);
}

describe("D1 offline field-fight selection", () => {
  test("uses observed contact, crops ten seconds, and remaps the original sides with the losses", () => {
    const [first] = selection(), [swapped] = selection(recording(), "after", 1);
    expect(first.fight.losses).toEqual([50, 250]);
    expect(swapped.fight.losses).toEqual([250, 50]);
    expect(swapped.fight.units[0].side).toBe(1);
    expect(first.bounds).toEqual({ minX: 34, minY: 43, maxX: 70, maxY: 67 });
    expect(first.fight.units[0]).toMatchObject({ from: 0, shots: [1], path: [0, 18, 12, 1, 18, 12, 10, 18, 12] });
    expect(first.fight.units[1].until).toBe(4);
    expect(fightPlayback(first.fight)).toMatchObject({ gameLength: 10, mapName: "", stats: { me: [], opp: [] } });
  });

  test("rejects incomplete, tracker-only, or unobserved playback", () => {
    const raw = recording();
    for (const fidelity of [
      { ...raw.fidelity, complete: false },
      { ...raw.fidelity, positions: "tracker" },
      { ...raw.fidelity, attacks: "unavailable" },
    ]) expect(selection({ ...raw, fidelity })).toEqual([]);
  });

  test("rejects split fights, hidden opening armies, and casualties before contact", () => {
    const raw = recording();
    expect(selection({ ...raw, units: [...raw.units, fighter("me", 23, 110), fighter("me", 24, 111)] })).toEqual([]);
    expect(selection({ ...raw, units: raw.units.map(unit => unit.owner === "opp" ? { ...unit, hidden: [15, 21] } : unit) })).toEqual([]);
    expect(selection({ ...raw, units: raw.units.map((unit, index) => index === 1 ? { ...unit, died: 19.5 } : unit) })).toEqual([]);
  });

  test("does not let recorded worker losses or consumed morphs distort a field trade", () => {
    const raw = recording();
    const spent = { ...fighter("me", 23), name: "HighTemplar", sd: true };
    expect(selection({ ...raw, units: [...raw.units, spent] })[0].fight.losses).toEqual([50, 250]);
    const workers = Array.from({ length: 3 }, () => ({ ...fighter("me", 23), name: "SCV" }));
    expect(selection({ ...raw, units: [...raw.units, ...workers] })).toEqual([]);
  });

  test("excludes local shots from surviving structures by aim or firing position", () => {
    const raw = recording();
    const cannon: PlaybackBuilding = {
      owner: "opp", name: "PhotonCannon", t: 10, died: null, x: 77, y: 55, moves: [], attacks: [21],
    };
    expect(selection({ ...raw, buildings: [cannon] })).toHaveLength(1);
    expect(selection({ ...raw, buildings: [{ ...cannon, aim: [21, 52, 55] }] })).toEqual([]);
    expect(selection({ ...raw, buildings: [{ ...cannon, x: 62 }] })).toEqual([]);
    const relocated = { ...cannon, t: 18, moves: [20, 62, 55], attacks: [20] };
    expect(selection({ ...raw, buildings: [relocated] })).toEqual([]);
  });

  test("requires the full quiet interval inside later source segments", () => {
    const raw = recording();
    const withContact = (contact: number) => ({
      ...raw,
      units: raw.units.map(unit => ({
        ...unit,
        born: 60,
        died: unit.died === null ? null : unit.died + 41.1,
        attacks: [contact],
        aim: [contact, 52, 55],
        wp: [60, 52, 55, contact, 52, 55, 75, 52, 55],
      })),
    });
    const range = { start: 60, end: 80 };
    expect(selection(withContact(61.1), "after", 0, range)).toEqual([]);
    expect(selection(withContact(63.1), "after", 0, range)).toHaveLength(1);
  });

  test("keeps surviving units that leave or are unobserved hidden on the frozen result frame", () => {
    const raw = recording();
    const finishUnit = (unit: typeof raw.units[0] & { hidden?: number[] }) => {
      const [draft] = selection({ ...raw, units: [unit, ...raw.units.slice(1)] });
      const playback = fightPlayback(draft.fight);
      if (!playback) throw new Error("Expected cropped playback");
      return playback.units[0];
    };
    const survivor = raw.units[0];
    const outside = finishUnit({ ...survivor, wp: [10, 52, 55, 20, 52, 55, 26, 52, 55, 27, 80, 55, 29, 81, 55] });
    expect(unitVisibleAt(outside, 7)).toBe(true);
    expect(unitVisibleAt(outside, 8)).toBe(false);
    expect(unitVisibleAt(outside, 10)).toBe(false);
    expect(outside.died).toBeNull();
    expect(unitVisibleAt(finishUnit({ ...survivor, hidden: [27, 30] }), 10)).toBe(false);
    expect(unitVisibleAt(finishUnit({ ...survivor, hidden: [27, 29] }), 10)).toBe(true);
  });

  test("hides outside positions, trims observation gaps, and never stores world coordinates beyond the crop", () => {
    const clip = cropUnit({
      owner: "me", name: "Marine", born: 10, died: null,
      wp: [10, 2, 22, 11, 12, 22, 13, 14, 22, 15, 16, 22, 20, 16, 22],
      hidden: [13, 14, 14.5, 15],
    }, { start: 10, end: 20, bounds: { minX: 10, minY: 20, maxX: 20, maxY: 25 } }, false, "after");
    expect(clip?.path.slice(0, 6)).toEqual([0, 0, 2, 1, 2, 2]);
    expect(clip?.gaps).toEqual([0, 1, 3, 4, 4.5, 5]);
  });
});

describe("D1 public pack contract", () => {
  test("ships seven reproducible UTC practice sets, with five unique score buckets per set", () => {
    const directory = resolve("public/daily/v1");
    const index = readDailyIndex(JSON.parse(readFileSync(resolve(directory, "index.json"), "utf8")));
    expect(index).not.toBeNull();
    const practice = fixtureWeek();
    expect(practice).toHaveLength(7);
    expect(new Set(index?.practice).size).toBe(7);
    for (const [day, pack] of practice.entries()) {
      const digest = createHash("sha256").update(JSON.stringify(pack)).digest("hex");
      expect(index?.practice[day]).toBe(digest);
      const publicPack = readDailyPack(JSON.parse(readFileSync(resolve(directory, "packs", digest, "pack.json"), "utf8")));
      expect(publicPack).toEqual(pack);
      expect(new Set(pack.fights.map(fight => gradeTrade(...fight.losses))).size).toBe(5);
    }
  });

  test("discards every source identity and rejects date, hash, or id keys at every depth", () => {
    const [draft] = selection();
    const pack = { version: 1, fights: Array.from({ length: 5 }, () => draft.fight) };
    expect(readDailyPack(pack)).not.toBeNull();
    const json = JSON.stringify(pack);
    for (const value of Object.values(sourceIdentity)) expect(json).not.toContain(value);
    for (const key of ["date", "playedAt", "hash", "sha256", "id", "gameId", "replaySha256"]) {
      expect(readDailyPack({ ...pack, [key]: "private" })).toBeNull();
      const fight = { ...draft.fight, [key]: "private" };
      expect(readDailyPack({ ...pack, fights: [fight, ...pack.fights.slice(1)] })).toBeNull();
      const units = [...draft.fight.units];
      units[0] = { ...units[0], [key]: "private" };
      expect(readDailyPack({ ...pack, fights: [{ ...draft.fight, units }, ...pack.fights.slice(1)] })).toBeNull();
      const forms = [{ at: 1, unit: "Marine", [key]: "private" }];
      units[0] = { ...draft.fight.units[0], forms };
      expect(readDailyPack({ ...pack, fights: [{ ...draft.fight, units }, ...pack.fights.slice(1)] })).toBeNull();
    }
  });

  test("uses the ladder's even band and excludes ambiguous score boundaries", () => {
    expect([gradeTrade(50, 250), gradeTrade(150, 250), gradeTrade(100, 125), gradeTrade(250, 150), gradeTrade(250, 50)])
      .toEqual([0, 1, 2, 3, 4]);
    expect(unambiguousTrade(100, 125)).toBe(false);
    expect(unambiguousTrade(0, 0)).toBe(false);
    expect(unambiguousTrade(150, 250)).toBe(true);
  });
});
