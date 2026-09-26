import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackSegmentCache, decodePlaybackSegment, readBoundedSegment, sanitizePlaybackManifest, segmentAt, MAX_SEGMENT_BYTES } from "../segmentedPlayback";
import { buildingVisibleAt, sanitizeMapPlayback } from "../mapReplay";
import { makePlayback, makeSegmentFixture } from "./segmentedPlayback.fixture";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe("segmented playback", () => {
  it("selects half-open windows and includes the final timestamp", () => {
    const { manifest } = makeSegmentFixture();
    expect([-1, 59.9, 60, 239, 240, 999].map(t => segmentAt(manifest, t).index)).toEqual([0, 0, 1, 3, 3, 3]);
  });
  it.each(["gap", "overlap", "oversize", "points", "hash", "incomplete", "loose", "missing-final"])("rejects a %s manifest", change => {
    const { raw } = makeSegmentFixture();
    if (change === "gap") raw.manifest.segments[1].start++;
    if (change === "overlap") raw.manifest.segments[1].start--;
    if (change === "oversize") raw.manifest.segments[1].sizeBytes = MAX_SEGMENT_BYTES + 1;
    if (change === "points") raw.manifest.segments[1].points = 60001;
    if (change === "hash") raw.manifest.segments[1].sha256 = "invalid";
    if (change === "incomplete") raw.manifest.fidelity = { ...raw.manifest.fidelity, complete: false };
    if (change === "loose") raw.manifest.fidelity = { ...raw.manifest.fidelity, positionError: .51 };
    if (change === "missing-final") raw.manifest.segments.pop();
    expect(sanitizePlaybackManifest(raw)).toBeNull();
  });
  it("decodes an exact bounded segment with complete lifetimes and same-loop shots", async () => {
    const { bytes, manifest } = makeSegmentFixture();
    const value = await decodePlaybackSegment(bytes[0], manifest, manifest.segments[0]);
    expect(value.units[0].attacks).toEqual([60, 220]);
    expect(value.units[0].died).toBe(220);
    expect(value.gameLength).toBe(240);
    expect(value.buildings[0].hidden).toEqual([100, 101]);
    expect(buildingVisibleAt(value.buildings[0], 100.5)).toBe(false);
    expect(buildingVisibleAt(value.buildings[0], 101)).toBe(true);
  });
  it("rejects corruption, a wrong revision, or a false motion count", async () => {
    const { bytes, manifest } = makeSegmentFixture();
    const damaged = bytes[0].slice(); damaged[50] ^= 1;
    await expect(decodePlaybackSegment(damaged, manifest, manifest.segments[0])).rejects.toThrow("integrity");
    await expect(decodePlaybackSegment(bytes[0], { ...manifest, replaySha256: "d".repeat(64) }, manifest.segments[0])).rejects.toThrow("belong");
    await expect(decodePlaybackSegment(bytes[0], manifest, { ...manifest.segments[0], points: 4 })).rejects.toThrow("motion count");
  });
  it("fails closed instead of silently clipping lifecycle metadata", async () => {
    const { bytes, manifest } = makeSegmentFixture(p => { p.units[0].hidden = Array.from({ length: 16386 }, (_, i) => i); });
    await expect(decodePlaybackSegment(bytes[0], manifest, manifest.segments[0])).rejects.toThrow("entity channel");
  });
  it("reads exact response bytes and rejects truncated or oversized streams", async () => {
    const { bytes } = makeSegmentFixture();
    expect(Array.from(await readBoundedSegment(new Response(bytes[0]), bytes[0].length))).toEqual(Array.from(bytes[0]));
    await expect(readBoundedSegment(new Response(bytes[0].slice(1)), bytes[0].length)).rejects.toThrow("incomplete");
    await expect(readBoundedSegment(new Response(bytes[0]), bytes[0].length - 1)).rejects.toThrow("exceeded");
  });
  it("keeps only three least recently used segment payloads", () => {
    const cache = new PlaybackSegmentCache(3), playback = sanitizeMapPlayback(makePlayback())!;
    for (const key of ["0", "1", "2"]) cache.set(key, playback);
    cache.get("0"); cache.set("3", playback);
    expect(cache.size).toBe(3); expect(cache.get("1")).toBeUndefined(); expect(cache.get("0")).toBe(playback);
    cache.clear(); expect(cache.size).toBe(0);
  });
  it("keeps legacy terminal-shot behavior unless the explicit v7 flag is present", () => {
    const raw = makePlayback();
    expect(sanitizeMapPlayback({ ...raw, v: 6 })!.units[0].attacks).toEqual([60]);
    expect(sanitizeMapPlayback({ ...raw, terminalAttackInclusive: false })!.units[0].attacks).toEqual([60]);
    expect(sanitizeMapPlayback(raw)!.units[0].attacks).toEqual([60, 220]);
  });
  it("does not shorten an early segment's whole-game timeline", () => {
    const raw = makePlayback(); raw.units[0].died = 100; raw.stats = { me: [], opp: [] };
    expect(sanitizeMapPlayback(raw)?.gameLength).toBe(240);
  });
});
