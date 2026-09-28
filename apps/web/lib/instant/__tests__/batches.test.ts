import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_BODY_MAX_BYTES,
  BROWSER_BATCH_MAX_BYTES,
  BROWSER_BATCH_MAX_GAMES,
  BrowserGameTagError,
  buildUploadBatches,
  tagBrowserGame,
  utf8Bytes,
} from "../batches";

const MiB = 1024 * 1024;
const FIXTURE = readFileSync(path.join(__dirname, "fixtures", "warpgate_payload.json"), "utf8");

/** A game JSON string of exactly `bytes` UTF-8 bytes. */
function gameOfBytes(gameId: string, bytes: number): { gameId: string; json: string } {
  const head = `{"gameId":"${gameId}","pad":"`;
  const tail = '"}';
  return { gameId, json: head + "x".repeat(bytes - head.length - tail.length) + tail };
}

describe("tagBrowserGame", () => {
  it("splices provenance right after the opening brace, byte-exact", () => {
    const tagged = tagBrowserGame(FIXTURE, "1.6.3");
    const prefix = '{"ingestSource":"browser","engineVersion":"1.6.3",';
    expect(tagged.startsWith(prefix)).toBe(true);
    expect(tagged.slice(prefix.length)).toBe(FIXTURE.slice(1));
    expect(utf8Bytes(tagged)).toBe(utf8Bytes(FIXTURE) + prefix.length - 1);
    const parsed: unknown = JSON.parse(tagged);
    expect(parsed).toMatchObject({ ingestSource: "browser", engineVersion: "1.6.3", result: "Victory" });
  });

  it("handles an empty object without a trailing comma", () => {
    expect(tagBrowserGame("{}", "1.6.3")).toBe('{"ingestSource":"browser","engineVersion":"1.6.3"}');
  });

  it("refuses non-objects, already-tagged games and unsafe versions", () => {
    expect(() => tagBrowserGame("[1]", "1.6.3")).toThrow(BrowserGameTagError);
    expect(() => tagBrowserGame('{"ingestSource":"agent"}', "1.6.3")).toThrow(BrowserGameTagError);
    expect(() => tagBrowserGame('{"engineVersion":"1"}', "1.6.3")).toThrow(BrowserGameTagError);
    expect(() => tagBrowserGame('{"a":1}', '1.6.3","x":"')).toThrow(BrowserGameTagError);
  });

  it("accepts exactly the engine versions the API schema accepts (semver, <= 40 chars)", () => {
    for (const ok of ["1.6.3", "1.6.3-rc.1", "1.6.3+build.5", "10.20.30-alpha.1+sha.abc"]) {
      expect(JSON.parse(tagBrowserGame("{}", ok))).toEqual({ ingestSource: "browser", engineVersion: ok });
    }
    for (const bad of ["1.6", "v1.6.3", "1.6.3_x", "1.6.3-", `1.6.3-${"a".repeat(40)}`]) {
      expect(() => tagBrowserGame("{}", bad)).toThrow(BrowserGameTagError);
    }
  });

  it("does not mistake an escaped string value for a key", () => {
    const json = '{"note":"\\"ingestSource\\":"}';
    expect(tagBrowserGame(json, "1.6.3")).toContain('"note"');
  });
});

describe("buildUploadBatches", () => {
  it("caps batches at 50 games, in order", () => {
    const games = Array.from({ length: 120 }, (_, i) => gameOfBytes(`g${i}`, 200));
    const { batches, oversized } = buildUploadBatches(games);
    expect(batches.map((b) => b.gameIds.length)).toEqual([BROWSER_BATCH_MAX_GAMES, 50, 20]);
    expect(batches.flatMap((b) => b.gameIds)).toEqual(games.map((g) => g.gameId));
    expect(oversized).toEqual([]);
  });

  it("keeps every body within 4.5 MiB and reports exact bytes", () => {
    const games = Array.from({ length: 9 }, (_, i) => gameOfBytes(`g${i}`, MiB));
    const { batches } = buildUploadBatches(games);
    expect(batches.map((b) => b.gameIds.length)).toEqual([4, 4, 1]);
    for (const batch of batches) {
      expect(batch.bytes).toBeLessThanOrEqual(BROWSER_BATCH_MAX_BYTES);
      expect(batch.bytes).toBe(utf8Bytes(batch.body));
    }
  });

  it("builds the exact {\"games\":[...]} body by concatenation", () => {
    const a = gameOfBytes("a", 40);
    const b = gameOfBytes("b", 50);
    const [batch] = buildUploadBatches([a, b]).batches;
    expect(batch.body).toBe(`{"games":[${a.json},${b.json}]}`);
    expect(JSON.parse(batch.body)).toEqual({ games: [JSON.parse(a.json), JSON.parse(b.json)] });
  });

  it("sends a game between 4.5 and 5 MiB alone", () => {
    const small1 = gameOfBytes("s1", 100);
    const big = gameOfBytes("big", Math.floor(4.75 * MiB));
    const small2 = gameOfBytes("s2", 100);
    const { batches, oversized } = buildUploadBatches([small1, big, small2]);
    expect(batches.map((b) => b.gameIds)).toEqual([["s1"], ["big"], ["s2"]]);
    expect(batches[1].bytes).toBeGreaterThan(BROWSER_BATCH_MAX_BYTES);
    expect(batches[1].bytes).toBeLessThanOrEqual(API_BODY_MAX_BYTES);
    expect(oversized).toEqual([]);
  });

  it("never sends a game whose body would exceed 5 MiB", () => {
    const huge = gameOfBytes("huge", API_BODY_MAX_BYTES);
    const fits = gameOfBytes("fits", API_BODY_MAX_BYTES - 12);
    const { batches, oversized } = buildUploadBatches([huge, fits]);
    expect(oversized).toEqual(["huge"]);
    expect(batches.map((b) => b.gameIds)).toEqual([["fits"]]);
    expect(batches[0].bytes).toBe(API_BODY_MAX_BYTES);
  });

  it("counts UTF-8 bytes, not characters", () => {
    expect(utf8Bytes("Ω")).toBe(2);
    const game = { gameId: "u", json: '{"gameId":"u","n":"ΩΩ"}' };
    const [batch] = buildUploadBatches([game]).batches;
    expect(batch.bytes).toBe(batch.body.length + 2);
  });

  it("returns no batches for no games", () => {
    expect(buildUploadBatches([])).toEqual({ batches: [], oversized: [] });
  });
});
