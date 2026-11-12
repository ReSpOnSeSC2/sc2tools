import { afterEach, expect, test, vi } from "vitest";
import { loadDaily } from "../loadDaily";
import { fixtureWeek } from "../fixtureWeek";
import { completeDay, readResults, streakOn } from "../progress";
import { practiceDay, shareDaily, utcDay } from "../rules";

afterEach(() => vi.restoreAllMocks());

const digest = "b".repeat(64);
const schedule = (day: number) => ({ version: 1, days: { [day]: "a".repeat(64) }, practice: Array.from({ length: 7 }, () => digest) });
const results = [true, false, false, true, true];

test("selects the same pack at UTC midnight regardless of the original time zone", async () => {
  const day = utcDay(Date.parse("2026-11-12T00:00:00Z"));
  expect(utcDay(Date.parse("2026-11-11T19:00:00-05:00"))).toBe(day);
  expect(utcDay(Date.parse("2026-11-12T08:59:59+09:00"))).toBe(day - 1);
  expect(practiceDay(day + 7)).toBe(practiceDay(day));
  const sample = fixtureWeek()[0];
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async path =>
    new Response(JSON.stringify(String(path).endsWith("index.json") ? schedule(day) : sample)));
  const controller = new AbortController();
  expect((await loadDaily(day, controller.signal)).kind).toBe("recorded");
  expect(fetcher.mock.calls[1][0]).toBe("/daily/v1/packs/" + "a".repeat(64) + "/pack.json");
  expect((await loadDaily(day + 1, controller.signal)).kind).toBe("practice");
  expect(fetcher.mock.calls[3][0]).toBe("/daily/v1/packs/" + digest + "/pack.json");
});

test("rejects failed static loads and malformed pack references", async () => {
  const signal = new AbortController().signal;
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 503 }));
  await expect(loadDaily(12345, signal)).rejects.toThrow("unavailable");
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, days: {}, practice: ["../../private"] })));
  await expect(loadDaily(12345, signal)).rejects.toThrow("invalid");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("stores first completion separately for recorded and practice sets", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
  expect(streakOn(completeDay(storage, "practice", 20000, results), 20000)).toBe(1);
  expect(streakOn(completeDay(storage, "practice", 20001, results), 20002)).toBe(2);
  expect(streakOn(readResults(storage, "practice"), 20003)).toBe(0);
  expect(completeDay(storage, "practice", 20001, [false, false, false, false, false])[20001]).toEqual(results);
  expect(readResults(storage, "recorded")).toEqual({});
  expect(completeDay(null, "practice", 20000, results)[20000]).toEqual(results);
});

test("share copy includes only the UTC day, marks, score and public destination", () => {
  const day = utcDay(Date.parse("2026-11-12T00:00:00Z"));
  expect(shareDaily(day, true, results)).toBe("SC2 Daily practice \u00b7 2026-11-12\n\u25a0\u25a1\u25a1\u25a0\u25a0  3/5\nhttps://sc2tools.com/arcade");
});
