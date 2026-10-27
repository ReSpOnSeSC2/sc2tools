import { describe, expect, it } from "vitest";
import { getArticle } from "@/lib/help";
import { MAX_TOUR_VERSION, TOURS, isTourId, isTourVersion, tourAvailabilityKey, tourIsDone,
  tourReplayHref, tourStepsPresent, tourUnavailable, tourVersions, validTourGameId, type TourAvailabilityScope, type TourId, type TourStep } from "./tours";

const ids: TourId[] = ["today", "game", "overlay"];

describe("public guided-tour registry and version contracts", () => {
  it("declares three bounded tours with unique stable targets and explicit component owners", () => {
    expect(Object.keys(TOURS).sort()).toEqual([...ids].sort());
    const targets: string[] = [];
    for (const id of ids) {
      const tour = TOURS[id];
      expect(tour.id).toBe(id); expect(isTourVersion(tour.version)).toBe(true);
      expect(tour.steps.length).toBeGreaterThanOrEqual(4); expect(tour.steps.length).toBeLessThanOrEqual(5);
      for (const step of tour.steps) {
        expect(step.target).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(step.owner).toMatch(/^components\/.+\.tsx$/);
        expect(step.title.trim()).not.toBe(""); expect(step.text.trim()).not.toBe(""); targets.push(step.target);
      }
    }
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("admits only known IDs and bounded integer versions", () => {
    for (const id of ids) expect(isTourId(id)).toBe(true);
    for (const id of [null, undefined, "Today", "other", 1, {}, "today.nested"]) expect(isTourId(id)).toBe(false);
    expect(MAX_TOUR_VERSION).toBe(1000);
    for (const version of [1, MAX_TOUR_VERSION]) expect(isTourVersion(version)).toBe(true);
    for (const version of [0, -1, 1.5, MAX_TOUR_VERSION + 1, NaN, Infinity, "1", true, null, undefined, {}]) {
      expect(isTourVersion(version)).toBe(false);
    }
  });

  it("normalizes only own valid known version entries without treating malformed data as done", () => {
    expect(tourVersions({ today: 2, game: "2", overlay: 1001, unknown: 1000 })).toEqual({ today: 2 });
    expect(tourVersions(Object.create({ today: 1 }))).toEqual({});
    for (const value of [null, undefined, [], false, "today", 1]) expect(tourVersions(value)).toEqual({});
    const saved = { today: 3, game: 2, overlay: 1 };
    expect(tourVersions(saved)).toEqual(saved); expect(saved).toEqual({ today: 3, game: 2, overlay: 1 });
  });

  it.each(ids)("suppresses %s only for its current or a newer valid terminal version", id => {
    const current = TOURS[id].version;
    expect(tourIsDone(id, {})).toBe(false);
    expect(tourIsDone(id, { [id]: current - 1 })).toBe(false);
    expect(tourIsDone(id, { [id]: String(current) })).toBe(false);
    expect(tourIsDone(id, { [id]: current })).toBe(true);
    expect(tourIsDone(id, { [id]: MAX_TOUR_VERSION })).toBe(true);
  });

  it.each(ids)("skips absent %s targets in source order and refuses more than half missing", id => {
    const steps: readonly TourStep[] = TOURS[id].steps;
    expect(tourStepsPresent(id, new Set([...steps].reverse().map(step => step.target)))).toEqual(steps);
    const minimum = Math.ceil(steps.length / 2), enough = steps.slice(0, minimum);
    expect(tourStepsPresent(id, new Set(enough.map(step => step.target)))).toEqual(enough);
    const tooFew = new Set(steps.slice(0, minimum - 1).map(step => step.target));
    expect(tourStepsPresent(id, tooFew)).toBeNull();
    expect(tourStepsPresent(id, new Set(["unrelated-target"]))).toBeNull();
  });

  it("links explicit replays to their real routes and preserves the raw encoded game identity", () => {
    expect(tourReplayHref("today")).toBe("/app?tour=today");
    expect(tourReplayHref("overlay")).toBe("/settings?tab=overlay&tour=overlay");
    const gameId = "2026-10-26T20:00:00|Name/A?B#C|Map";
    expect(tourReplayHref("game", gameId)).toBe(`/app/game/${encodeURIComponent(gameId)}?tour=game`);
    expect(validTourGameId("x".repeat(1024))).toBe(true);
  });

  it("never makes a replay URL from a missing, blank, control-bearing or oversized game ID", () => {
    for (const value of [null, undefined, false, 7, {}, "", "  ", "bad\nkey", "bad\u007fkey", "x".repeat(1025)]) {
      expect(validTourGameId(value)).toBe(false);
      if (typeof value === "string" || value === undefined) expect(tourReplayHref("game", value)).toBeNull();
    }
    expect(tourReplayHref("game")).toBeNull();
  });

  it("isolates availability by owner, tour and current version", () => {
    const key = tourAvailabilityKey("owner-a", "today");
    expect(key).toContain("owner-a"); expect(key).toContain(TOURS.today.version);
    expect(key).not.toEqual(tourAvailabilityKey("owner-b", "today"));
    expect(key).not.toEqual(tourAvailabilityKey("owner-a", "game"));
  });

  it("trusts unavailable only from a current active scope for this route", () => {
    const scope: TourAvailabilityScope = { active: true, path: "/app/game/one", recordKey: "one", current: () => true };
    const value = { available: false, scope };
    expect(tourUnavailable(value, "/app/game/one")).toBe(true);
    expect(tourUnavailable(value, "/help/take-a-tour")).toBe(false);
    expect(tourUnavailable(value, "/app/game/two")).toBe(false);
    scope.active = false; expect(tourUnavailable(value, "/app/game/one")).toBe(false);
    scope.active = true; scope.current = () => false; expect(tourUnavailable(value, "/app/game/one")).toBe(false);
    for (const malformed of [null, [], {}, { available: false }, { available: "false", scope },
      { available: false, scope: { active: true, path: "/app/game/one", current: "yes" } },
      { available: false, scope: { ...scope, current: () => { throw new Error("retired parent"); } } }]) {
      expect(tourUnavailable(malformed, "/app/game/one")).toBe(false);
    }
  });
  it("finishes each tour at a real registered Help article or the Stream Studio crash course", () => {
    // The canonical Help generator must include new articles before this test runs.
    for (const id of ids) {
      const steps: readonly TourStep[] = TOURS[id].steps;
      const href = steps.at(-1)?.help;
      if (href?.startsWith("/help/")) {
        const slug = new URL(href, "https://sc2tools.invalid").pathname.split("/").at(-1) ?? "";
        expect(getArticle(slug), `${id} final Help destination ${href}`).toBeDefined();
      } else expect(href).toBe("/stream-studio/learn#crash-course");
    }
  });
});
