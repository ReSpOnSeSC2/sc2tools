import { describe, expect, it } from "vitest";
import {
  CLIP_MAX_SECONDS, clampClipRange, clipFileName, clipFrameCount, clipFrameTime, clipVideoSeconds, defaultClipRange, gifFits,
  parseClipClock, pickVideoMime,
} from "@/lib/clip/clipPlan";

/** Army rows [t, army, workers, supply] with one sharp fight at 200–215 s. */
function statsWithFight() {
  const me: number[][] = [];
  const opp: number[][] = [];
  for (let t = 0; t <= 600; t += 10) {
    me.push([t, t < 200 ? 3000 : 1200, 40, 100]);
    opp.push([t, t < 200 ? 2800 : 900, 40, 100]);
  }
  return { me, opp };
}

describe("clip frames", () => {
  it("renders one frame per 1/fps of video, starting at the range start", () => {
    const range = { start: 100, end: 120 };
    expect(clipVideoSeconds(range, 2)).toBe(10);
    expect(clipFrameCount(range, 2, 30)).toBe(300);
    expect(clipFrameCount(range, 1, 12)).toBe(240);
    expect(clipFrameCount(range, 4, 30)).toBe(150);
    expect(clipFrameTime(range, 2, 30, 0)).toBe(100);
    const last = clipFrameTime(range, 2, 30, 299);
    expect(last).toBeLessThan(120);
    expect(last).toBeCloseTo(119.933, 2);
    expect(clipFrameCount({ start: 5, end: 5 }, 1, 30)).toBe(1);
  });

  it("caps a GIF at 20 seconds of video", () => {
    expect(gifFits({ start: 0, end: 20 }, 1)).toBe(true);
    expect(gifFits({ start: 0, end: 60 }, 2)).toBe(false);
    expect(gifFits({ start: 0, end: 60 }, 4)).toBe(true);
  });
});

describe("clip range", () => {
  it("defaults to the nearest detected fight, padded 10 s each side", () => {
    const range = defaultClipRange(statsWithFight(), 400, 600);
    expect(range.source).toBe("fight");
    expect(range.start).toBeLessThan(200);
    expect(range.end).toBeGreaterThan(200);
    expect(range.end - range.start).toBeLessThanOrEqual(CLIP_MAX_SECONDS);
  });

  it("falls back to 10 s around the clock with no fight, inside the game", () => {
    const flat = { me: [[0, 500, 12, 12], [600, 500, 12, 12]], opp: [[0, 500, 12, 12], [600, 500, 12, 12]] };
    expect(defaultClipRange(flat, 300, 600)).toEqual({ start: 290, end: 310, source: "time" });
    expect(defaultClipRange(flat, 2, 600)).toEqual({ start: 0, end: 12, source: "time" });
    expect(defaultClipRange(flat, 598, 600)).toEqual({ start: 588, end: 600, source: "time" });
  });

  it("clamps to 60 s, the game and the loaded playback section", () => {
    expect(clampClipRange({ start: 100, end: 400 }, 600)).toEqual({ start: 100, end: 160 });
    expect(clampClipRange({ start: -20, end: 10 }, 600)).toEqual({ start: 0, end: 10 });
    expect(clampClipRange({ start: 590, end: 700 }, 600)).toEqual({ start: 590, end: 600 });
    expect(clampClipRange({ start: 100, end: 200 }, 600, { start: 120, end: 180 })).toEqual({ start: 120, end: 180 });
    expect(clampClipRange({ start: 600, end: 600 }, 600)).toEqual({ start: 599, end: 600 });
  });
});

describe("clip formats", () => {
  it("prefers WebM VP9, then VP8, then MP4, and survives a throwing probe", () => {
    expect(pickVideoMime((mime) => mime !== "video/webm;codecs=vp9")).toBe("video/webm;codecs=vp8");
    expect(pickVideoMime((mime) => mime.startsWith("video/mp4"))).toBe("video/mp4;codecs=avc1");
    expect(pickVideoMime(() => { throw new Error("no"); })).toBeNull();
    expect(pickVideoMime(undefined)).toBeNull();
  });

  it("names files by game time and container, never by player", () => {
    expect(clipFileName({ start: 192, end: 222 }, "video", "video/webm;codecs=vp9")).toBe("sc2tools-clip-3m12s-3m42s.webm");
    expect(clipFileName({ start: 5, end: 25 }, "video", "video/mp4")).toBe("sc2tools-clip-0m05s-0m25s.mp4");
    expect(clipFileName({ start: 5, end: 25 }, "gif")).toBe("sc2tools-clip-0m05s-0m25s.gif");
  });

  it("reads m:ss and plain seconds", () => {
    expect(parseClipClock("3:12")).toBe(192);
    expect(parseClipClock(" 75 ")).toBe(75);
    expect(parseClipClock("3:75")).toBeNull();
    expect(parseClipClock("abc")).toBeNull();
  });
});
