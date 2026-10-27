/**
 * DashboardKpiStrip — live refresh (every game card keys on dbRev, MMR
 * does not), honest loading / failed / zero states with Retry, the
 * Today's session record, the phone grid and the MMR card's link.
 * useApi is a MOCK that records keys and serves canned responses.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ANALYZER_FILTERS,
  FiltersContext,
  type FiltersValue,
} from "@/lib/filterContext";
import { todayKeyIn } from "@/lib/timeseries";
import { DashboardKpiStrip, computeTodayRecord } from "../DashboardKpiStrip";
import { currentHistory } from "@/components/sessions/__tests__/sessionHistoryFixtures";
import { sessionSummary } from "@/components/sessions/__tests__/sessionCardFixtures";

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

vi.mock("@/components/sessions/useSessionRequest", () => ({
  useSessionRequest: (key: string) => {
    harness.keys.push(key);
    const canned = harness.respond(key);
    return { data: canned.data, error: canned.error, mutate: () => harness.mutate(key), current: () => true, key };
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
  if (key.startsWith("/v1/sessions/current")) return "session";
  if (key.startsWith("/v1/streak")) return "streak";
  if (key.startsWith("/v1/me/mmr")) return "mmr";
  if (!key.startsWith("/v1/timeseries")) return "other";
  const query = new URLSearchParams(key.split("?")[1]?.split("#")[0] ?? "");
  if (query.get("interval") === "month") return "range";
  return "winRate";
}

function ready(overrides: Partial<Record<ReturnType<typeof cardOf>, Canned>> = {}) {
  return (key: string): Canned => {
    const card = cardOf(key);
    if (overrides[card]) return overrides[card];
    switch (card) {
      case "session":
        return { data: currentHistory() };
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

async function renderStrip(dbRev = 0) {
  const ui = (rev: number) => (
    <FiltersContext.Provider value={contextValue(rev)}>
      <DashboardKpiStrip />
    </FiltersContext.Provider>
  );
  const result = render(ui(dbRev));
  await waitFor(() => expect(harness.keys.some(key => key.startsWith("/v1/sessions/current"))).toBe(true));
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
  it("keys every game card on dbRev and refetches when a game lands", async () => {
    const { rerenderWith } = await renderStrip(0);
    const gameKeys = () =>
      harness.keys.filter((key) => key.startsWith("/v1/timeseries") || key.startsWith("/v1/streak") || key.startsWith("/v1/sessions/current"));

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

  it("leaves the MMR request unkeyed: it asks SC2Pulse once per Pulse ID", async () => {
    const { rerenderWith } = await renderStrip(0);
    rerenderWith(5);
    const mmrKeys = new Set(harness.keys.filter((key) => key.startsWith("/v1/me/mmr")));
    expect([...mmrKeys]).toEqual(["/v1/me/mmr"]);
  });
});

describe("Current or last session card", () => {
  it("shows the current live session games and neutral W-L record", async () => {
    await renderStrip();
    const card = sessionCard();
    expect(within(card).getByText("This session")).toBeTruthy();
    expect(card.textContent).toContain("3 games");
    expect(within(card).getByText("1 W · 1 L · 1 unknown")).toBeTruthy();
    expect(card.textContent).not.toContain("Keep the streak alive");
  });

  it("shows an explicit empty current view after a reset", async () => {
    harness.respond = ready({ session: { data: currentHistory({ session: null, activity: "empty" }) } });
    await renderStrip();
    const card = sessionCard();
    expect(card.textContent).not.toContain("0 games");
    expect(within(card).getByText("No session in the current view")).toBeTruthy();
  });

  it("says 1 game, not 1 games", async () => {
    harness.respond = ready({
      session: { data: currentHistory({ session: sessionSummary({ games: 1, wins: 0, losses: 1, unknown: 0, results: "L" }) }) },
    });
    await renderStrip();
    expect(sessionCard().textContent).toContain("1 game");
    expect(sessionCard().textContent).not.toContain("1 games");
    expect(within(sessionCard()).getByText("0 W · 1 L · 0 unknown")).toBeTruthy();
  });

  it("spans both columns on phones so five cards stack 1, 2, 2", async () => {
    await renderStrip();
    expect(sessionCard().className).toContain("col-span-2");
    expect(sessionCard().className).toContain("lg:col-span-1");
    const grid = screen.getByTestId("dashboard-kpi-strip");
    expect(grid.className).toContain("grid-cols-2");
    expect(grid.className).not.toContain("sm:grid-cols-2");
  });
});

describe("card states", () => {
  it("shows a dash, not 0, while a card loads", async () => {
    harness.respond = ready({ session: { isLoading: true }, streak: { isLoading: true } });
    await renderStrip();
    expect(sessionCard().textContent).toContain("Loading session view");
    expect(sessionCard().textContent).not.toContain("0 games");
    expect(sessionCard().textContent).not.toContain("No session in the current view");
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
    await renderStrip();

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

  it("gives each failed card its own Retry", async () => {
    harness.respond = ready({
      session: { error: SERVER_ERROR },
      winRate: { error: SERVER_ERROR },
      range: { error: SERVER_ERROR },
      mmr: { error: SERVER_ERROR },
    });
    await renderStrip();
    const retries = screen.getAllByRole("button", { name: /Retry/ });
    expect(retries).toHaveLength(4);
    fireEvent.click(within(sessionCard()).getByRole("button", { name: /Retry/ }));
    expect(cardOf(harness.mutate.mock.calls[0][0])).toBe("session");
    fireEvent.click(within(cardWithLabel("MMR")).getByRole("button", { name: /Retry/ }));
    expect(harness.mutate.mock.calls[1][0]).toBe("/v1/me/mmr");
    // A failed MMR request is not "no Pulse ID".
    expect(screen.queryByRole("link", { name: "Add a Pulse ID in Settings" })).toBeNull();
  });

  it("still shows a real zero", async () => {
    harness.respond = ready({ streak: { data: { kind: null, count: 0, lastGameAt: null } } });
    await renderStrip();
    const card = cardWithLabel("Active streak");
    expect(card.textContent).toContain("0");
    expect(card.textContent).toContain("Tied or no recent games");
  });
});

describe("MMR card", () => {
  it("links to the Pulse ID help when no Pulse ID is saved", async () => {
    harness.respond = ready({ mmr: { data: { entries: [], truncated: false } } });
    await renderStrip();
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
