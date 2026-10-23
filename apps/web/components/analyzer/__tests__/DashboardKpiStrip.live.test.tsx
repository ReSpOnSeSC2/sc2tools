/**
 * DashboardKpiStrip — live refresh (every game card keys on dbRev, MMR
 * does not), honest loading / failed / zero states with Retry, the
 * Today's session record, the phone grid and the MMR card's link.
 * useApi is a MOCK that records keys and serves canned responses.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ANALYZER_FILTERS,
  FiltersContext,
  type FiltersValue,
} from "@/lib/filterContext";
import { clientTimezone, startOfTodayInTz, todayKeyIn } from "@/lib/timeseries";
import { DashboardKpiStrip, computeTodayRecord } from "../DashboardKpiStrip";

interface Canned {
  data?: unknown;
  error?: unknown;
  isLoading?: boolean;
}

const harness = vi.hoisted(() => ({
  keys: [] as string[],
  respond: (_key: string): Canned => ({}),
  mutate: vi.fn(),
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: (key: string) => {
    harness.keys.push(key);
    const canned = harness.respond(key);
    return {
      data: canned.data,
      error: canned.error,
      isLoading: canned.isLoading ?? false,
      isPreviousData: false,
      mutate: () => harness.mutate(key),
    };
  },
}));

const TODAY_POINT = {
  bucket: new Date().toISOString(),
  wins: 4,
  losses: 2,
  total: 6,
  winRate: 4 / 6,
};

const SERVER_ERROR = Object.assign(new Error("Server error"), { status: 500 });

/** Which card a key belongs to. */
function cardOf(key: string): "session" | "range" | "winRate" | "streak" | "mmr" | "other" {
  if (key.startsWith("/v1/streak")) return "streak";
  if (key.startsWith("/v1/me/mmr")) return "mmr";
  if (!key.startsWith("/v1/timeseries")) return "other";
  const query = new URLSearchParams(key.split("?")[1]?.split("#")[0] ?? "");
  if (query.get("interval") === "month") return "range";
  // Today's session asks from the start of today; Win rate from its own preset.
  return query.get("since") === startOfTodayInTz(clientTimezone()).toISOString() ? "session" : "winRate";
}

function ready(overrides: Partial<Record<ReturnType<typeof cardOf>, Canned>> = {}) {
  return (key: string): Canned => {
    const card = cardOf(key);
    if (overrides[card]) return overrides[card];
    switch (card) {
      case "session":
        return { data: { interval: "day", points: [TODAY_POINT] } };
      case "range":
        return { data: { interval: "month", points: [TODAY_POINT] } };
      case "winRate":
        return { data: { interval: "day", points: [TODAY_POINT] } };
      case "streak":
        return { data: { kind: "win", count: 3, lastGameAt: null } };
      case "mmr":
        return { data: { entries: [{ pulseId: "1", region: "NA", mmr: 4200 }], truncated: false } };
      default:
        return {};
    }
  };
}

function contextValue(dbRev: number): FiltersValue {
  return {
    filters: { ...DEFAULT_ANALYZER_FILTERS },
    setFilters: () => undefined,
    dbRev,
    bumpRev: () => undefined,
    seasons: [],
  };
}

function renderStrip(dbRev = 0) {
  const ui = (rev: number) => (
    <FiltersContext.Provider value={contextValue(rev)}>
      <DashboardKpiStrip />
    </FiltersContext.Provider>
  );
  const result = render(ui(dbRev));
  return { ...result, rerenderWith: (rev: number) => result.rerender(ui(rev)) };
}

function sessionCard(): HTMLElement {
  return screen.getByTestId("kpi-today-session");
}

/** The StatCard that holds a label. */
function cardWithLabel(label: string): HTMLElement {
  const el = screen.getByText(label);
  const card = el.closest(".rounded-xl");
  if (!(card instanceof HTMLElement)) throw new Error(`no card for ${label}`);
  return card;
}

beforeEach(() => {
  harness.keys.length = 0;
  harness.respond = ready();
  harness.mutate.mockReset();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("DashboardKpiStrip live refresh", () => {
  it("keys every game card on dbRev and refetches when a game lands", () => {
    const { rerenderWith } = renderStrip(0);
    const gameKeys = () =>
      harness.keys.filter((key) => key.startsWith("/v1/timeseries") || key.startsWith("/v1/streak"));

    const first = new Set(gameKeys());
    expect(first.size).toBe(4);
    for (const key of first) expect(key.endsWith("#0")).toBe(true);
    expect([...first].map(cardOf).sort()).toEqual(["range", "session", "streak", "winRate"]);

    harness.keys.length = 0;
    rerenderWith(1);
    const second = new Set(gameKeys());
    expect(second.size).toBe(4);
    for (const key of second) expect(key.endsWith("#1")).toBe(true);
  });

  it("leaves the MMR request unkeyed: it asks SC2Pulse once per Pulse ID", () => {
    const { rerenderWith } = renderStrip(0);
    rerenderWith(5);
    const mmrKeys = new Set(harness.keys.filter((key) => key.startsWith("/v1/me/mmr")));
    expect([...mmrKeys]).toEqual(["/v1/me/mmr"]);
  });
});

describe("Today's session card", () => {
  it("shows today's games and W-L record", () => {
    renderStrip();
    const card = sessionCard();
    expect(within(card).getByText("Today's session")).toBeTruthy();
    expect(card.textContent).toContain("6 games");
    expect(within(card).getByText("4W 2L")).toBeTruthy();
    expect(within(card).getByText("4 wins, 2 losses")).toBeTruthy();
    expect(card.textContent).not.toContain("Keep the streak alive");
  });

  it("reads 0 games when nothing was played today", () => {
    harness.respond = ready({ session: { data: { interval: "day", points: [] } } });
    renderStrip();
    const card = sessionCard();
    expect(card.textContent).toContain("0 games");
    expect(within(card).getByText("No games yet today")).toBeTruthy();
  });

  it("says 1 game, not 1 games", () => {
    harness.respond = ready({
      session: { data: { interval: "day", points: [{ ...TODAY_POINT, wins: 0, losses: 1, total: 1 }] } },
    });
    renderStrip();
    expect(sessionCard().textContent).toContain("1 game");
    expect(sessionCard().textContent).not.toContain("1 games");
    expect(within(sessionCard()).getByText("0W 1L")).toBeTruthy();
  });

  it("spans both columns on phones so five cards stack 1, 2, 2", () => {
    renderStrip();
    expect(sessionCard().className).toContain("col-span-2");
    expect(sessionCard().className).toContain("lg:col-span-1");
    const grid = screen.getByTestId("dashboard-kpi-strip");
    expect(grid.className).toContain("grid-cols-2");
    expect(grid.className).not.toContain("sm:grid-cols-2");
  });
});

describe("card states", () => {
  it("shows a dash, not 0, while a card loads", () => {
    harness.respond = ready({ session: { isLoading: true }, streak: { isLoading: true } });
    renderStrip();
    expect(sessionCard().textContent).toContain("—");
    expect(sessionCard().textContent).not.toContain("0 games");
    expect(sessionCard().textContent).not.toContain("No games yet today");
    expect(cardWithLabel("Active streak").textContent).not.toContain("Tied or no recent games");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("shows a dash and Retry when the streak request fails", async () => {
    harness.respond = ready({ streak: { error: SERVER_ERROR } });
    let settle: () => void = () => undefined;
    harness.mutate.mockImplementation(
      () => new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    renderStrip();

    const card = cardWithLabel("Active streak");
    expect(card.textContent).toContain("—");
    expect(card.textContent).not.toContain("Tied or no recent games");
    const retry = within(card).getByRole("button", { name: "Couldn't load your streak. Retry" });
    expect(retry.textContent).toContain("Couldn't load");

    fireEvent.click(retry);
    expect(harness.mutate).toHaveBeenCalledTimes(1);
    expect(harness.mutate.mock.calls[0][0]).toMatch(/^\/v1\/streak/);
    expect(retry.getAttribute("aria-busy")).toBe("true");
    // A second press while the request runs is ignored.
    fireEvent.click(retry);
    expect(harness.mutate).toHaveBeenCalledTimes(1);

    await act(async () => settle());
    expect(retry.getAttribute("aria-busy")).toBeNull();
  });

  it("gives each failed card its own Retry", () => {
    harness.respond = ready({
      session: { error: SERVER_ERROR },
      winRate: { error: SERVER_ERROR },
      range: { error: SERVER_ERROR },
      mmr: { error: SERVER_ERROR },
    });
    renderStrip();
    const retries = screen.getAllByRole("button", { name: /Retry/ });
    expect(retries).toHaveLength(4);
    fireEvent.click(within(sessionCard()).getByRole("button", { name: /Retry/ }));
    expect(cardOf(harness.mutate.mock.calls[0][0])).toBe("session");
    fireEvent.click(within(cardWithLabel("MMR")).getByRole("button", { name: /Retry/ }));
    expect(harness.mutate.mock.calls[1][0]).toBe("/v1/me/mmr");
    // A failed MMR request is not "no Pulse ID".
    expect(screen.queryByRole("link", { name: "Add a Pulse ID in Settings" })).toBeNull();
  });

  it("still shows a real zero", () => {
    harness.respond = ready({ streak: { data: { kind: null, count: 0, lastGameAt: null } } });
    renderStrip();
    const card = cardWithLabel("Active streak");
    expect(card.textContent).toContain("0");
    expect(card.textContent).toContain("Tied or no recent games");
  });
});

describe("MMR card", () => {
  it("links to the Pulse ID help when no Pulse ID is saved", () => {
    harness.respond = ready({ mmr: { data: { entries: [], truncated: false } } });
    renderStrip();
    const link = screen.getByRole("link", { name: "Add a Pulse ID in Settings" });
    expect(link.getAttribute("href")).toBe("/settings?tab=profile#pulse-id-help");
  });
});

describe("computeTodayRecord", () => {
  it("picks today's bucket and treats a missing one as a real zero", () => {
    const tz = "UTC";
    const now = new Date("2026-10-23T15:00:00Z");
    const today = todayKeyIn(tz, now);
    const periods = [
      { date: "2026-10-22", games: 9, wins: 5, losses: 4, winRate: 5 / 9, avgMacroScore: null },
      { date: today, games: 6, wins: 4, losses: 2, winRate: 4 / 6, avgMacroScore: null },
    ];
    expect(computeTodayRecord(periods, tz, now)).toEqual({ games: 6, wins: 4, losses: 2 });
    expect(computeTodayRecord(periods.slice(0, 1), tz, now)).toEqual({ games: 0, wins: 0, losses: 0 });
    expect(computeTodayRecord([], tz, now)).toEqual({ games: 0, wins: 0, losses: 0 });
  });
});
