/**
 * The score's pure half: the manifest, deterministic track selection,
 * the battle-intensity curve, the gain function and the persisted
 * preference.
 *
 * Everything asserted here is a plain function of its arguments — no
 * DOM, no audio graph, no clock. The engine and the control are
 * covered in ``MusicControl.test.tsx``.
 *
 * Plain vitest assertions only: this repo has no jest-dom.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  AUDIO_BASE,
  MUSIC_STORAGE_KEY,
  MUSIC_TUNING,
  TRACKS,
  armyPressure,
  battleIntensity,
  battleWindowFor,
  defaultMusicPrefs,
  defaultScoreSettings,
  hashSeed,
  loadMusicPrefs,
  musicGain,
  musicPlan,
  musicSeed,
  normalizeRace,
  saveMusicPrefs,
  trackForSlot,
  trackUrl,
} from "@/lib/replayMusic";
import { payload } from "./fixtures";

const SEEDS = Array.from({ length: 200 }, (_, i) => `game-${i}`);

describe("track manifest", () => {
  it("has one entry per shipped file, with explicit paths", () => {
    expect(TRACKS.length).toBe(5);
    const ids = TRACKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(5);
    for (const t of TRACKS) {
      expect(t.path.endsWith(".mp3")).toBe(true);
      // The path is NOT derived from the id — the two Protoss takes
      // sit under a protoss/ prefix on R2 and the rest do not.
      expect(t.duration > 0).toBe(true);
      expect(t.race === "Terran" || t.race === "Zerg" || t.race === "Protoss").toBe(true);
    }
    expect(TRACKS.find((t) => t.id === "protoss-orbital-reliquary")?.path).toBe(
      "protoss/protoss-orbital-reliquary.mp3",
    );
    expect(TRACKS.find((t) => t.id === "zerg-chitin-rift")?.path).toBe(
      "zerg-chitin-rift.mp3",
    );
  });

  it("builds URLs off the configurable base", () => {
    expect(AUDIO_BASE).toBe("/audio/replay");
    expect(trackUrl(TRACKS[0])).toBe(
      "/audio/replay/terran-iron-front-protocol.mp3",
    );
  });
});

describe("race normalisation", () => {
  it("accepts full names, letters and case", () => {
    expect(normalizeRace("Terran")).toBe("Terran");
    expect(normalizeRace("terran")).toBe("Terran");
    expect(normalizeRace("T")).toBe("Terran");
    expect(normalizeRace("z")).toBe("Zerg");
    expect(normalizeRace("Protoss")).toBe("Protoss");
    expect(normalizeRace("P")).toBe("Protoss");
  });

  it("treats anything else as unknown", () => {
    expect(normalizeRace(null)).toBe(null);
    expect(normalizeRace(undefined)).toBe(null);
    expect(normalizeRace("")).toBe(null);
    expect(normalizeRace("Random")).toBe(null);
  });
});

describe("deterministic track selection", () => {
  it("scores Terran with Iron Front Protocol, every seed", () => {
    for (const seed of SEEDS) {
      expect(trackForSlot("Terran", seed, 0).id).toBe("terran-iron-front-protocol");
    }
  });

  it("opens Zerg on the sting and drops into Chitin Rift", () => {
    for (const seed of SEEDS.slice(0, 20)) {
      expect(trackForSlot("Zerg", seed, 0).id).toBe("zerg-chitin-rift-sting");
      expect(trackForSlot("Zerg", seed, 1).id).toBe("zerg-chitin-rift");
      expect(trackForSlot("Zerg", seed, 2).id).toBe("zerg-chitin-rift");
    }
  });

  it("picks one of the two Protoss takes from the seed, and sticks to it", () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) {
      const first = trackForSlot("Protoss", seed, 0);
      expect(first.race).toBe("Protoss");
      seen.add(first.id);
      // Same replay, same music — a hundred re-openings later.
      for (let i = 0; i < 5; i++) {
        expect(trackForSlot("Protoss", seed, 0).id).toBe(first.id);
      }
    }
    // The seed genuinely decides: both takes occur across the corpus.
    expect(seen.size).toBe(2);
  });

  it("alternates the Protoss takes on every loop", () => {
    const plan = musicPlan("Protoss", "game-7");
    expect(plan.beds.length).toBe(2);
    expect(trackForSlot("Protoss", "game-7", 0).id).toBe(plan.beds[0].id);
    expect(trackForSlot("Protoss", "game-7", 1).id).toBe(plan.beds[1].id);
    expect(trackForSlot("Protoss", "game-7", 2).id).toBe(plan.beds[0].id);
    expect(trackForSlot("Protoss", "game-7", 3).id).toBe(plan.beds[1].id);
    // 30-minute game, ~3-minute tracks: still alternating at loop 9.
    expect(trackForSlot("Protoss", "game-7", 9).id).toBe(plan.beds[1].id);
  });

  it("falls back to a seeded race when the reviewer's race is unknown", () => {
    const races = new Set<string>();
    for (const seed of SEEDS) {
      const a = musicPlan(null, seed);
      const b = musicPlan("Random", seed);
      expect(a.race).toBe(b.race);
      expect(a.guessed).toBe(true);
      expect(trackForSlot(null, seed, 0).id).toBe(trackForSlot(null, seed, 0).id);
      races.add(a.race);
    }
    // All three buckets are reachable, so this is a real choice.
    expect(races.size).toBe(3);
  });

  it("marks a supplied race as not guessed", () => {
    expect(musicPlan("Zerg", "g").guessed).toBe(false);
    expect(musicPlan("Zerg", "g").race).toBe("Zerg");
  });

  it("never calls Math.random: the same seed is stable across processes", () => {
    // FNV-1a of a fixed string is a constant, so a regression in the
    // hash (which would reshuffle every user's music) fails here.
    expect(hashSeed("game-7")).toBe(hashSeed("game-7"));
    expect(hashSeed("game-7")).not.toBe(hashSeed("game-8"));
    expect(hashSeed("")).toBe(0x811c9dc5);
  });

  it("derives a stable seed from the payload when there is no game id", () => {
    const pb = payload();
    expect(musicSeed("g-42", pb)).toBe("g-42");
    expect(musicSeed(null, pb)).toBe(musicSeed(undefined, pb));
    expect(musicSeed("", pb)).toBe(musicSeed(null, pb));
    expect(musicSeed(null, pb)).toContain("Harness Station");
    // A different game on the same map does not collide.
    const other = payload({ units: [] });
    expect(musicSeed(null, other)).not.toBe(musicSeed(null, pb));
  });
});

describe("battle intensity", () => {
  const battles = [{ t: 100 }, { t: 400 }];
  const w = 6;

  it("is silent far from any battle", () => {
    expect(battleIntensity(0, battles, w)).toBe(0);
    expect(battleIntensity(250, battles, w)).toBe(0);
    expect(battleIntensity(1e6, battles, w)).toBe(0);
  });

  it("peaks exactly on the marker", () => {
    expect(battleIntensity(100, battles, w)).toBeCloseTo(1, 12);
    expect(battleIntensity(400, battles, w)).toBeCloseTo(1, 12);
  });

  it("is symmetric either side of the marker", () => {
    for (let d = 0; d <= w; d += 0.25) {
      expect(battleIntensity(100 - d, battles, w)).toBeCloseTo(
        battleIntensity(100 + d, battles, w),
        12,
      );
    }
  });

  it("decays monotonically to zero at the window edge", () => {
    let prev = Infinity;
    for (let d = 0; d <= w; d += 0.1) {
      const v = battleIntensity(100 + d, battles, w);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
    expect(battleIntensity(100 + w, battles, w)).toBe(0);
    expect(battleIntensity(100 + w + 0.001, battles, w)).toBe(0);
  });

  it("eases in and out — no corner at the window edge", () => {
    // A raised cosine has zero slope at both ends; a linear ramp would
    // have slope 1/w there. Sample the first 1 % of the window.
    const eps = w / 100;
    const slopeAtEdge =
      (battleIntensity(100 + w - eps, battles, w) - 0) / eps;
    expect(slopeAtEdge).toBeLessThan(0.02);
  });

  it("stays in [0,1] with overlapping markers, taking the max", () => {
    const cluster = [{ t: 100 }, { t: 101 }, { t: 102 }, { t: 103 }];
    for (let t = 90; t <= 115; t += 0.05) {
      const v = battleIntensity(t, cluster, w);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(battleIntensity(101, cluster, w)).toBeCloseTo(1, 12);
  });

  it("copes with no battles, a zero window and junk times", () => {
    expect(battleIntensity(100, [], w)).toBe(0);
    expect(battleIntensity(100, null, w)).toBe(0);
    expect(battleIntensity(100, battles, 0)).toBe(0);
    expect(battleIntensity(NaN, battles, w)).toBe(0);
  });

  it("widens the window with playback speed so the swell stays audible", () => {
    expect(battleWindowFor(1)).toBe(MUSIC_TUNING.BATTLE_WINDOW_SEC);
    expect(battleWindowFor(16)).toBeCloseTo(24, 6);
    // Wall-clock duration of the swell, both sides, at each speed.
    for (const speed of [1, 4, 8, 16]) {
      const wall = (2 * battleWindowFor(speed)) / speed;
      expect(wall).toBeGreaterThan(1.4);
      expect(wall).toBeLessThanOrEqual(12);
    }
  });
});

describe("army pressure", () => {
  const stats = {
    me: [
      [0, 0, 12, 13],
      [300, 2000, 20, 60],
      [600, 5000, 24, 100],
    ],
    opp: [
      [0, 0, 12, 12],
      [300, 1800, 22, 58],
      [600, 4500, 26, 98],
    ],
  };

  it("runs from silence at the opening to full late", () => {
    expect(armyPressure(0, stats)).toBe(0);
    expect(armyPressure(600, stats)).toBeCloseTo(1, 6);
    expect(armyPressure(300, stats)).toBeGreaterThan(0);
    expect(armyPressure(300, stats)).toBeLessThan(1);
  });

  it("is monotone through the game and clamped", () => {
    let prev = -1;
    for (let t = 0; t <= 700; t += 5) {
      const v = armyPressure(t, stats);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });

  it("does not swell a tiny game to full on 300 minerals of lings", () => {
    const cheese = { me: [[0, 0, 12, 13], [240, 300, 14, 30]], opp: [[0, 0, 12, 12]] };
    expect(armyPressure(240, cheese)).toBeLessThan(0.2);
  });

  it("survives an absent or empty series", () => {
    expect(armyPressure(100, null)).toBe(0);
    expect(armyPressure(100, { me: [], opp: [] })).toBe(0);
  });
});

describe("music gain", () => {
  const pb = payload(); // one battle, at t = 155
  const settings = defaultScoreSettings(0.35);

  it("sits at the user's level away from the action", () => {
    const g = musicGain(0, pb.battles, pb.stats, settings);
    expect(g).toBeGreaterThan(0.34);
    expect(g).toBeLessThan(0.37);
  });

  it("swells by about a third at the centre of a fight", () => {
    const quiet = musicGain(60, pb.battles, pb.stats, settings);
    const loud = musicGain(155, pb.battles, pb.stats, settings);
    expect(loud / quiet).toBeGreaterThan(1.2);
    expect(loud / quiet).toBeLessThan(1.35);
  });

  it("is a pure function of time — scrubbing backwards repeats exactly", () => {
    const forward: number[] = [];
    for (let t = 140; t <= 170; t += 0.5) {
      forward.push(musicGain(t, pb.battles, pb.stats, settings));
    }
    const backward: number[] = [];
    for (let t = 170; t >= 140; t -= 0.5) {
      backward.push(musicGain(t, pb.battles, pb.stats, settings));
    }
    backward.reverse();
    expect(backward).toEqual(forward);
    // …and jumping straight to a time gives the same answer as
    // sweeping into it, because there is no accumulator anywhere.
    expect(musicGain(155, pb.battles, pb.stats, settings)).toBe(forward[30]);
  });

  it("mutes at volume 0 and never exceeds the ceiling", () => {
    expect(musicGain(155, pb.battles, pb.stats, defaultScoreSettings(0))).toBe(0);
    const hot = musicGain(155, pb.battles, pb.stats, defaultScoreSettings(1));
    expect(hot).toBeLessThanOrEqual(MUSIC_TUNING.MAX_GAIN);
  });

  it("keeps the swell subtle — never more than +45 % over the base", () => {
    let peak = 0;
    for (let t = 0; t <= pb.gameLength; t += 0.25) {
      peak = Math.max(peak, musicGain(t, pb.battles, pb.stats, settings) / 0.35);
    }
    expect(peak).toBeLessThanOrEqual(
      1 + MUSIC_TUNING.BATTLE_SWELL + MUSIC_TUNING.ARMY_SWELL + 1e-9,
    );
    expect(peak).toBeGreaterThan(1.2);
  });

  it("survives a payload with no battles and no stats", () => {
    expect(musicGain(100, [], null, settings)).toBeCloseTo(0.35, 12);
  });
});

describe("preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to on at a modest level", () => {
    const prefs = defaultMusicPrefs();
    expect(prefs.enabled).toBe(true);
    expect(prefs.volume).toBe(0.35);
    expect(MUSIC_TUNING.DEFAULT_VOLUME).toBe(0.35);
  });

  it("round-trips through localStorage", () => {
    saveMusicPrefs({ enabled: false, volume: 0.62 });
    const raw = window.localStorage.getItem(MUSIC_STORAGE_KEY);
    expect(typeof raw).toBe("string");
    const back = loadMusicPrefs();
    expect(back.enabled).toBe(false);
    expect(back.volume).toBeCloseTo(0.62, 12);
  });

  it("clamps a hostile stored value instead of blowing an eardrum", () => {
    window.localStorage.setItem(
      MUSIC_STORAGE_KEY,
      JSON.stringify({ enabled: true, volume: 99 }),
    );
    expect(loadMusicPrefs().volume).toBe(1);
    saveMusicPrefs({ enabled: true, volume: -5 });
    expect(loadMusicPrefs().volume).toBe(0);
  });

  it("falls back to the defaults on junk, and never throws", () => {
    window.localStorage.setItem(MUSIC_STORAGE_KEY, "{not json");
    expect(loadMusicPrefs().enabled).toBe(true);
    expect(loadMusicPrefs().volume).toBe(0.35);
    window.localStorage.setItem(MUSIC_STORAGE_KEY, "null");
    expect(loadMusicPrefs().volume).toBe(0.35);
    window.localStorage.setItem(MUSIC_STORAGE_KEY, JSON.stringify({ volume: "loud" }));
    expect(loadMusicPrefs().volume).toBe(0.35);
  });

  it("defaults OFF when the user asks for reduced motion", () => {
    const original = window.matchMedia;
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
      matches: q.includes("reduce"),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    });
    try {
      expect(defaultMusicPrefs().enabled).toBe(false);
      // …but it is only a DEFAULT: an explicit choice still wins.
      saveMusicPrefs({ enabled: true, volume: 0.35 });
      expect(loadMusicPrefs().enabled).toBe(true);
    } finally {
      (window as unknown as { matchMedia: unknown }).matchMedia = original;
    }
  });
});
