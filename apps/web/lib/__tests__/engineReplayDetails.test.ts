import { describe, expect, it } from "vitest";
import { replayCameraAt, sanitizeReplayCamera } from "@/lib/replayCamera";
import { fullReplayAttention, replayAttention } from "@/lib/replayAttention";
import { sanitizeMapPlayback } from "@/lib/mapReplay";
import { unitTrades } from "@/lib/unitTrades";

describe("additive replay details", () => {
  it("retains only valid sides and never borrows the first future camera position", () => {
    const camera = sanitizeReplayCamera({ me: [0, 10, 10, 10, 80, 80], opp: [5, 10, 10, 1, 20, 20] }, 30);
    expect(camera?.opp).toBeUndefined();
    expect(replayCameraAt(camera?.me, -1)).toBeNull();
    expect(replayCameraAt(camera?.me, NaN)).toBeNull();
    expect(replayCameraAt(camera?.me, 9.99)).toEqual({ x: 10, y: 10 });
    expect(replayCameraAt(camera?.me, 10)).toEqual({ x: 80, y: 80 });
  });

  it("bounds attention to the loaded window and leaves an incomplete lookback unknown", () => {
    const replay = sanitizeMapPlayback({ v: 7, mapName: "Test", gameLength: 30,
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, units: [], buildings: [{ t: 0, x: 80, y: 80, owner: "me", name: "Nexus" }],
      battles: [{ t: 12, x: 10, y: 10 }, { t: 17, x: 10, y: 10 }, { t: 18, x: 80, y: 80 }],
      camera: { me: [0, 10, 10, 10, 80, 80] } });
    expect(replay).not.toBeNull();
    const attention = replayAttention(replay!, "me", { start: 10, end: 20 });
    expect(attention?.samples).toBe(10);
    expect(attention?.nearBase).toBe(100);
    expect(attention?.grid.reduce((sum, item) => sum + item, 0)).toBe(10);
    expect(attention?.fights.map(fight => fight.lookedAway)).toEqual([null, true, false]);
  });

  it("weights full-replay samples and classifies fights across a segment seam", async () => {
    const fixture = { v: 7, mapName: "Test", gameLength: 15,
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, units: [],
      buildings: [{ t: 0, x: 10, y: 10, owner: "me", name: "Nexus" }],
      battles: [{ t: 8, x: 10, y: 10 }, { t: 13, x: 10, y: 10 }] };
    const early = sanitizeMapPlayback({ ...fixture, camera: { me: [0, 80, 80, 4, 10, 10] } })!;
    const late = sanitizeMapPlayback({ ...fixture, camera: { me: [7, 80, 80] } })!;
    expect(replayAttention(late, "me", { start: 7, end: 15 })?.fights.map(fight => fight.lookedAway)).toEqual([null, true]);
    async function* sections() {
      yield { start: 0, end: 7, playback: early };
      yield { start: 7, end: 15, playback: late };
    }
    const result = await fullReplayAttention(sections(), 15, new AbortController().signal);
    expect(result.me).toMatchObject({ samples: 15, interval: 1, nearBase: 20 });
    expect(result.me?.fights.map(fight => fight.lookedAway)).toEqual([false, true]);
    expect(result.opp).toBeNull();
  });

  it("keeps unattributed kills separate and excludes impossible lifespans", () => {
    const rows = unitTrades([
      { owner: "me", killer: "opp", category: "units", name: "Marine", killerUnit: "Zergling", bornAt: 12, time: 22 },
      { owner: "me", killer: null, category: "units", name: "Marine", bornAt: 40, time: 32 },
      { owner: "opp", killer: "me", category: "units", name: "Zergling", killerUnit: "Marine", time: 42 },
      { owner: "opp", killer: "me", category: "units", name: "Zergling", time: 52 },
    ], [], "me", undefined, { Marine: 5 });
    expect(rows.find(row => row.name === "Marine")).toMatchObject({ recordedBuilt: 5, kills: 1, lost: 2, median: 10 });
    expect(rows.find(row => row.name === "Unattributed")?.kills).toBe(1);
  });
});
