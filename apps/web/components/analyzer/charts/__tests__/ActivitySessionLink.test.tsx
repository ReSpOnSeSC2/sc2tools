import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FiltersContext } from "@/lib/filterContext";
import { TrendsDataProvider } from "@/lib/trendsDataContext";
import { ActivityCalendarChart } from "../ActivityCalendarChart";

vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ isLoading: false, error: undefined, mutate: () => undefined,
  data: { timezone: "America/New_York", days: [{ day: "2026-11-01T04:00:00.000Z", wins: 1, losses: 0, total: 1, winRate: 1 }] } }) }));
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-03T12:00:00Z")); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
function calendar(global = false) {
  return <FiltersContext.Provider value={{ filters: { preset: "custom", since: "2026-11-01T04:00:00.000Z", until: "2026-11-02T04:59:59.999Z", map_pool: "all", game_size: "all", exclude_too_short: false, accounts: "1-S2-1-123" }, dbRev: 0, seasons: [], setFilters: () => undefined, bumpRev: () => undefined }}>
    <TrendsDataProvider mode={global ? "global" : "personal"}><ActivityCalendarChart /></TrendsDataProvider>
  </FiltersContext.Provider>;
}

it("links a selected personal local day without replacing membership bounds or All/false facets", () => {
  render(calendar()); fireEvent.click(screen.getByRole("button", { name: /2026-11-01: 1 games/ }));
  const href = screen.getByRole("link", { name: "View sessions on this day" }).getAttribute("href");
  const query = new URL(href ?? "", "https://sc2tools.invalid").searchParams;
  expect(query.get("day")).toBe("2026-11-01"); expect(query.get("tz")).toBe("America/New_York");
  expect(query.get("since")).toBe("2026-11-01T04:00:00.000Z"); expect(query.get("accounts")).toBe("1-S2-1-123");
  expect(query.get("map_pool")).toBe("all"); expect(query.get("game_size")).toBe("all"); expect(query.get("exclude_too_short")).toBe("false");
});

it("keeps private session links out of global Activity", () => {
  render(calendar(true));
  expect(screen.queryByRole("link", { name: "View sessions on this day" })).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("player game records");
});
