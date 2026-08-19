/**
 * Shared synthetic playback payloads for the replay HUD tests.
 *
 * Deliberately small and hand-checkable: every expectation in the
 * suites below can be read straight off this literal. Times are chosen
 * so the derived production windows, the interpolated stat rows and
 * the battle window all have obvious boundaries.
 */

import { sanitizeMapPlayback, type MapPlayback } from "@/lib/mapReplay";

/** Two waypoints so a unit has a well-defined position all game. The
 *  last one sits ON ``gameLength``: the sanitizer rewrites the declared
 *  length when it overshoots all recorded activity by >20%, and a
 *  fixture that silently trips that repair is a confusing fixture. */
const GAME_LENGTH = 600;
function wp(t0: number, x: number, y: number): number[] {
  return [t0, x, y, GAME_LENGTH, x, y];
}

export function rawPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 5,
    mapName: "Harness Station",
    gameLength: GAME_LENGTH,
    bounds: { minX: 0, minY: 0, maxX: 200, maxY: 200 },
    spawns: [
      { owner: "me", x: 30, y: 30 },
      { owner: "opp", x: 170, y: 170 },
    ],
    battles: [{ t: 155, x: 100, y: 100 }],
    buildings: [
      { owner: "me", name: "Hatchery", t: 0, x: 30, y: 30, moves: [], died: null },
      { owner: "me", name: "SpawningPool", t: 33, x: 40, y: 30, moves: [], died: null },
      { owner: "me", name: "Extractor", t: 60, x: 44, y: 30, moves: [], died: null },
      { owner: "me", name: "Hatchery", t: 120, x: 80, y: 30, moves: [], died: null },
      { owner: "opp", name: "CommandCenter", t: 0, x: 170, y: 170, moves: [], died: null },
      { owner: "opp", name: "SupplyDepot", t: 25, x: 165, y: 170, moves: [], died: null },
      { owner: "opp", name: "Barracks", t: 50, x: 160, y: 170, moves: [], died: null },
    ],
    units: [
      { owner: "me", name: "Drone", born: 0, died: null, wp: wp(0, 30, 30) },
      { owner: "me", name: "Drone", born: 12, died: null, wp: wp(12, 31, 30) },
      { owner: "me", name: "Overlord", born: 0, died: null, wp: wp(0, 30, 34) },
      // A hatched pair — the feed must collapse these into one ×2 row.
      { owner: "me", name: "Zergling", born: 100, died: 155, wp: wp(100, 100, 100) },
      { owner: "me", name: "Zergling", born: 100.4, died: 156, wp: wp(100.4, 100, 100) },
      { owner: "me", name: "Zergling", born: 150, died: null, wp: wp(150, 60, 60) },
      { owner: "me", name: "Roach", born: 200, died: null, wp: wp(200, 60, 60) },
      { owner: "opp", name: "SCV", born: 0, died: null, wp: wp(0, 170, 170) },
      { owner: "opp", name: "Marine", born: 80, died: null, wp: wp(80, 160, 160) },
      { owner: "opp", name: "Marine", born: 140, died: 158, wp: wp(140, 100, 101) },
      { owner: "opp", name: "Marauder", born: 210, died: null, wp: wp(210, 150, 150) },
    ],
    resources: [],
    casts: [
      { o: 1, a: "EMP", t: 300, x: 100, y: 100 },
      { o: 0, a: "Stim", t: 305 },
    ],
    stats: {
      me: [
        [0, 0, 12, 13],
        [100, 100, 16, 22],
        [200, 400, 20, 34],
      ],
      opp: [
        [0, 0, 12, 12],
        [100, 50, 18, 24],
        [200, 300, 24, 40],
      ],
    },
    ...overrides,
  };
}

export function payload(overrides: Record<string, unknown> = {}): MapPlayback {
  const p = sanitizeMapPlayback(rawPayload(overrides));
  if (!p) throw new Error("fixture failed to sanitize");
  return p;
}

/** A v4 payload: no ``casts`` key at all, which is how every payload
 *  before the spell layer shipped looks on the wire. */
export function v4Payload(): MapPlayback {
  const raw = rawPayload({ v: 4 });
  delete raw.casts;
  const p = sanitizeMapPlayback(raw);
  if (!p) throw new Error("v4 fixture failed to sanitize");
  return p;
}
