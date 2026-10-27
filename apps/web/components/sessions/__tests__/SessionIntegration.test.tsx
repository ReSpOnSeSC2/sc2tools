import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FiltersContext, type AnalyzerFilters } from "@/lib/filterContext";
import type { SessionHistoryCurrent, SessionHistoryList } from "@/lib/sessionHistory";
import { sessionScopeQuery } from "@/lib/sessionHistoryUrls";
import { CurrentSessionCard } from "../CurrentSessionCard";
import { SessionsPage } from "../SessionsPage";
import { SessionRequestState } from "../SessionRequestState";
import { currentHistory, historyList } from "./sessionHistoryFixtures";

const harness = vi.hoisted(() => ({ search: "", data: undefined as SessionHistoryList | SessionHistoryCurrent | undefined, error: undefined as object | undefined, paths: [] as Array<string | null>, update: vi.fn(), retry: vi.fn() }));
vi.mock("@/lib/useUrlQueryWriter", () => ({ useUrlQueryWriter: () => ({ search: harness.search, capture: () => ({ epoch: 1, key: "current" }), update: harness.update }) }));
vi.mock("../useSessionRequest", () => ({ useSessionRequest: (path: string | null) => { harness.paths.push(path); return { data: harness.data, error: harness.error, mutate: harness.retry, current: () => true, key: path ?? "none" }; } }));
vi.mock("@/lib/timeseries", async original => ({ ...await original<typeof import("@/lib/timeseries")>(), clientTimezone: () => "UTC" }));
const FILTERS: AnalyzerFilters = { preset: "all", map_pool: "all", game_size: "all", exclude_too_short: false };
beforeEach(() => { harness.search = sessionScopeQuery(FILTERS).toString(); harness.data = undefined; harness.error = undefined; harness.paths = []; harness.update.mockReset(); harness.retry.mockReset(); });
afterEach(cleanup);
function host(child: ReactNode, filters = FILTERS) {
  return <FiltersContext.Provider value={{ filters, dbRev: 9, seasons: [], setFilters: () => undefined, bumpRev: () => undefined }}>{child}</FiltersContext.Provider>;
}

it("keeps ready-empty history honest and still offers the previous output window", () => {
  harness.data = historyList({ items: [], nextBefore: null });
  render(host(<SessionsPage />));
  expect(screen.getByText("No sessions in this output window")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Previous output window" }).getAttribute("href")).toContain("windowFrom=2026-09-01");
  expect(screen.queryByRole("link", { name: "Older sessions in this window" })).toBeNull();
});

it("keeps bounded context-required and oversized views distinct from empty", () => {
  const response = historyList({ status: "context_required", items: [], issue: { code: "context", message: "The component edge is not yet proved.", suggestedContextDays: 3 } });
  const { rerender } = render(<SessionRequestState q={{ data: response, mutate: harness.retry }} restartHref="/app/sessions" contextHref={days => `/app/sessions?contextDays=${days}`} isEmpty={data => data.items.length === 0} emptyTitle="False empty">{() => <p>False ready</p>}</SessionRequestState>);
  expect(screen.getByText("More session context is needed")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Check with more context" }).getAttribute("href")).toContain("contextDays=3");
  expect(screen.queryByText("False empty")).toBeNull();
  rerender(<SessionRequestState q={{ data: { ...response, status: "narrow_window" }, mutate: harness.retry }} restartHref="/app/sessions" isEmpty={() => true} emptyTitle="False empty">{() => null}</SessionRequestState>);
  expect(screen.getByText("This session view is too large")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Check with more context" })).toBeNull();
});

it("shows stale recovery ahead of warm data and retires all previous continuation links", () => {
  harness.data = historyList(); harness.error = { status: 409, code: "session_view_changed" };
  render(host(<SessionsPage />));
  expect(screen.getByText("This session view changed")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open fresh session view" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Older sessions in this window" })).toBeNull();
  expect(screen.queryByRole("heading", { name: /Session ·/ })).toBeNull();
});

it("retains membership and timezone when following whole-session continuation", () => {
  harness.data = historyList();
  render(host(<SessionsPage />));
  const href = screen.getByRole("link", { name: "Older sessions in this window" }).getAttribute("href");
  const query = new URL(href ?? "", "https://sc2tools.invalid").searchParams;
  expect(query.get("before")).toBe("older-page");
  expect(query.get("windowFrom")).toBe("2026-10-01T00:00:00.000Z");
  expect(query.get("map_pool")).toBe("all"); expect(query.get("exclude_too_short")).toBe("false"); expect(query.get("tz")).toBe("UTC");
});

it("changes only output selectors and retires both cursors when a local day is submitted", () => {
  harness.data = historyList(); harness.search += "&before=old-list&gamesBefore=old-games";
  render(host(<SessionsPage />));
  fireEvent.change(screen.getByLabelText("Output day"), { target: { value: "2026-11-01" } });
  fireEvent.submit(screen.getByRole("form", { name: "Session output selectors" }));
  const change = harness.update.mock.calls[0][0] as (query: URLSearchParams) => URLSearchParams;
  const next = change(new URLSearchParams(harness.search));
  expect(next.get("day")).toBe("2026-11-01"); expect(next.get("tz")).toBe("UTC");
  expect(next.get("map_pool")).toBe("all"); expect(next.has("before")).toBe(false); expect(next.has("gamesBefore")).toBe(false);
});

it("uses the current-only endpoint with explicit live/manual scope and preserves its ID in detail navigation", () => {
  harness.data = currentHistory();
  render(host(<CurrentSessionCard />, { ...FILTERS, since: "2020-01-01", race: "Z", accounts: "2-S2-1-55" }));
  const request = new URL(harness.paths[0] ?? "", "https://sc2tools.invalid");
  expect(request.pathname).toBe("/v1/sessions/current"); expect([...request.searchParams.keys()]).toEqual(["tz"]);
  expect(screen.getByText("This session")).toBeTruthy(); expect(screen.getByText(/Live 14-day view/)).toBeTruthy();
  expect(screen.getByText(/Since manual reset:/)).toBeTruthy();
  const href = screen.getByRole("link", { name: "View this session" }).getAttribute("href");
  expect(href).toContain("opaque-session-descriptor"); expect(href).toContain("sessionView=current"); expect(href).not.toContain("since=");
});

it("shows last or anchored-empty current views without resurrecting a pre-reset last session", () => {
  harness.data = currentHistory({ activity: "last", session: { ...currentHistory().session!, active: false } });
  const { rerender } = render(host(<CurrentSessionCard />)); expect(screen.getByText("Last session")).toBeTruthy();
  harness.data = currentHistory({ session: null, activity: "empty" }); rerender(host(<CurrentSessionCard />));
  expect(screen.getByText("No session in the current view")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "View this session" })).toBeNull();
  expect(screen.getByRole("link", { name: "Natural session history" })).toBeTruthy();
});

it("revalidates stale recovery even when the restart link has the same semantic URL", () => {
  harness.data = historyList(); harness.error = { status: 409, code: "session_view_changed" };
  render(host(<SessionsPage />));
  const fresh = screen.getByRole("link", { name: "Open fresh session view" });
  window.history.replaceState({}, "", fresh.getAttribute("href") ?? "/app/sessions");
  fireEvent.click(fresh);
  expect(harness.retry).toHaveBeenCalledTimes(1);
});

it("immediately retries an initial noncanonical history URL when the canonical restart has the same API request", () => {
  window.history.replaceState({}, "", "/app/sessions");
  harness.search = ""; harness.data = historyList(); harness.error = { status: 409, code: "session_view_changed" };
  render(host(<SessionsPage />));
  const before = harness.paths.at(-1);
  fireEvent.click(screen.getByRole("link", { name: "Open fresh session view" }));
  expect(harness.retry).toHaveBeenCalledTimes(1); expect(harness.paths.at(-1)).toBe(before);
});

it("retries current stale recovery even when the browser URL carries ignored global filters", () => {
  window.history.replaceState({}, "", "/app?race=Z&since=2020-01-01");
  harness.data = currentHistory(); harness.error = { status: 409, code: "session_view_changed" };
  render(host(<CurrentSessionCard />)); fireEvent.click(screen.getByRole("link", { name: "Open fresh session view" }));
  expect(harness.retry).toHaveBeenCalledTimes(1);
});
