import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HumdingersStatsResp } from "./HumdingersStats";
import { HumdingersStats } from "./HumdingersStats";

const api = vi.hoisted(() => ({ paths: [] as string[], error: null as null | { status: number; message: string }, data: null as unknown }));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string) => {
    api.paths.push(path);
    return { data: api.error ? undefined : api.data, error: api.error, mutate: vi.fn() };
  },
}));

const day = (date: string, loads: number, extra: Partial<HumdingersStatsResp["daily"][number]> = {}) =>
  ({ day: date, loads, players: loads ? 1 : 0, activeSeconds: 0, longPlays: 0, savers: 0, maxChapter: 0, ...extra });

beforeEach(() => {
  api.paths = [];
  api.error = null;
  api.data = {
    days: 30,
    totals: { loads: 5, playerDays: 3, activeSeconds: 11_100, longPlays: 2, savers: 1, maxChapter: 4 },
    daily: [day("2026-11-27", 3, { players: 2, activeSeconds: 7_500, longPlays: 2, savers: 1, maxChapter: 4 }), day("2026-11-26", 0), day("2026-11-25", 2, { activeSeconds: 3_600 })],
  } satisfies HumdingersStatsResp;
});
afterEach(cleanup);

it("shows the range totals and one row per day with plays", () => {
  render(<HumdingersStats />);
  expect(api.paths.at(-1)).toBe("/v1/admin/humdingers/stats?days=30");
  expect(screen.getByText("3 h 5 min")).toBeTruthy();
  expect(screen.getByText("1 h 2 min")).toBeTruthy();
  const rows = within(screen.getByRole("table")).getAllByRole("row");
  expect(rows).toHaveLength(3);
  expect(rows[1].textContent).toContain("Nov 27");
  expect(rows[1].textContent).toContain("2 h 5 min");
  expect(rows[2].textContent).toContain("Nov 25");
  fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
  expect(api.paths.at(-1)).toBe("/v1/admin/humdingers/stats?days=7");
});

it("says when nobody has played and keeps non-admins out", () => {
  api.data = { days: 30, totals: { loads: 0, playerDays: 0, activeSeconds: 0, longPlays: 0, savers: 0, maxChapter: 0 }, daily: [day("2026-11-27", 0)] };
  const { unmount } = render(<HumdingersStats />);
  expect(screen.getByText("No plays yet")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
  unmount();
  api.error = { status: 403, message: "Forbidden" };
  render(<HumdingersStats />);
  expect(screen.queryByText("Humdingers")).toBeNull();
});
