import { expect, it } from "vitest";
import { newerSession } from "../sessionSnapshot";
it("fences held pre-reset and legacy events while accepting the same/latest anchor", () => {
  const before: { games: number; sessionAnchorAt?: string } = { games: 10, sessionAnchorAt: "2026-10-24T10:00:00.000Z" };
  const reset: typeof before = { games: 0, sessionAnchorAt: "2026-10-25T10:00:00.000Z" };
  expect(newerSession(reset, before)).toBe(reset); expect(newerSession(reset, { games: 10 })).toBe(reset);
  expect(newerSession(reset, { games: 10, sessionAnchorAt: "bad" })).toBe(reset);
  expect(newerSession(before, reset)).toBe(reset); expect(newerSession(null, before)).toBe(before);
  const next = { ...reset, games: 1 }; expect(newerSession(reset, next)).toBe(next);
});
