import { useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnalyzerProvider } from "../AnalyzerProvider";
import { useFilters } from "@/lib/filterContext";
import { TODAY_ENTRY } from "@/components/chrome/appNav";
import { CurrentSessionCard } from "@/components/sessions/CurrentSessionCard";
import { SessionsPage } from "@/components/sessions/SessionsPage";
import { AnalyzerViewsDialog } from "@/components/analyzer/AnalyzerViewsDialog";
import type { AnalyzerFilters } from "@/lib/filterContext";
import type { AnalyzerViewPrefs } from "@/lib/analyzerViews";
import type { SeasonRow } from "@/lib/useSeasons";

const h = vi.hoisted(() => ({
  path: "/app", search: "", replace: vi.fn(), io: vi.fn(), paths: [] as string[],
  seasons: undefined as { items: SeasonRow[] } | undefined,
  views: { views: [], defaultViewId: null } as AnalyzerViewPrefs,
  sockets: [] as Array<{ disconnect: ReturnType<typeof vi.fn> }>,
  getToken: async () => "synthetic-token",
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({
  isLoaded: true, isSignedIn: true, userId: "owner-a", getToken: h.getToken,
}) }));
vi.mock("next/navigation", () => ({
  usePathname: () => h.path, useSearchParams: () => new URLSearchParams(h.search),
  useRouter: () => ({ replace: h.replace }),
}));
vi.mock("socket.io-client", () => ({ io: (...args: unknown[]) => h.io(...args) }));
vi.mock("@/lib/useSeasons", async original => ({
  ...await original<typeof import("@/lib/useSeasons")>(), useSeasons: () => ({ data: h.seasons }),
}));
vi.mock("@/lib/clientApi", async () => {
  const React = await import("react");
  const { currentHistory, historyList } = await import("../sessions/__tests__/sessionHistoryFixtures");
  function response(path: string) {
    if (path.startsWith("/v1/sessions/current?")) return currentHistory();
    if (path.startsWith("/v1/sessions?")) return historyList();
    if (path === "/v1/me/preferences/analyzerViews") return h.views;
    throw new Error(`Unexpected synthetic API path: ${path}`);
  }
  function useApi<T>(path: string | null) {
    const [data, setData] = React.useState<T>();
    const read = React.useCallback(() => {
      if (path) { h.paths.push(path); const payload: unknown = response(path); setData(payload as T); }
    }, [path]);
    React.useEffect(read, [read]);
    return { data, error: undefined, isLoading: data === undefined, isPreviousData: false,
      isValidating: false, mutate: read };
  }
  return { API_BASE: "https://api.invalid", useApi,
    apiCall: vi.fn(() => Promise.reject(new Error("Unexpected API mutation"))) };
});

const season68: SeasonRow = { battlenetId: 68, region: "US", year: 2026, number: 3,
  start: "2026-07-19T00:00:00.000Z", end: "2026-10-27T23:59:59.999Z" };
const season69: SeasonRow = { battlenetId: 69, region: "US", year: 2026, number: 4,
  start: "2026-10-28T00:00:00.000Z", end: null };
const custom: AnalyzerFilters = { preset: "custom", since: "2026-06-01T00:00:00.000Z",
  until: "2026-07-01T00:00:00.000Z", race: "P", map_pool: "all", game_size: "all", exclude_too_short: false };
const value = (): AnalyzerFilters => JSON.parse(screen.getByTestId("shared-filters").textContent ?? "{}");
const stored = () => JSON.parse(localStorage.getItem("analyzer.filters") ?? "{}");
const pause = () => new Promise<void>(resolve => window.setTimeout(resolve, 280));

function RouteHost() {
  const { filters, setFilters } = useFilters();
  const [viewsOpen, setViewsOpen] = useState(false);
  return <><pre data-testid="shared-filters">{JSON.stringify(filters)}</pre>
    <button type="button" onClick={() => setFilters({ ...filters, race: "T" })}>Choose Terran</button>
    <button type="button" onClick={() => setViewsOpen(true)}>Open saved views</button>
    {viewsOpen ? <AnalyzerViewsDialog onClose={() => setViewsOpen(false)} /> : null}
    {h.path === "/app" ? <CurrentSessionCard /> : h.path === "/app/sessions" ? <SessionsPage />
      : <p>Report route admitted from the real SessionCard link</p>}
  </>;
}
function tree(): ReactNode { return <AnalyzerProvider syncUrl><RouteHost /></AnalyzerProvider>; }
type View = ReturnType<typeof render>;
async function navigate(view: View, href: string) {
  const url = new URL(href, window.location.href);
  await act(async () => {
    h.path = url.pathname; h.search = url.searchParams.toString();
    window.history.replaceState({}, "", `${h.path}${url.search}`);
    view.rerender(tree());
  });
}
async function settleUrl(view: View) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await act(pause);
    const next = h.replace.mock.calls.at(-1);
    h.replace.mockClear();
    if (!next) return;
    expect(next[1]).toEqual({ scroll: false });
    const href = String(next[0]);
    if (href === `${window.location.pathname}${window.location.search}`) return;
    await navigate(view, href);
  }
  throw new Error("Filter URL failed to settle within three acknowledgments");
}
async function openHistory(view: View) {
  const link = await screen.findByRole("link", { name: "Natural session history" });
  await navigate(view, link.getAttribute("href") ?? "");
  await screen.findByRole("heading", { name: "Session history" });
  await settleUrl(view);
}
async function visitOlderAndReport(view: View) {
  const older = await screen.findByRole("link", { name: "Older sessions in this window" });
  await navigate(view, older.getAttribute("href") ?? "");
  await settleUrl(view);
  expect(new URLSearchParams(window.location.search).get("before")).toBe("older-page");
  const report = await screen.findByRole("link", { name: /^View session details:/ });
  const href = report.getAttribute("href") ?? "";
  expect(href).toContain("opaque-session-descriptor");
  await navigate(view, href); await settleUrl(view);
  expect(screen.getByText("Report route admitted from the real SessionCard link")).toBeTruthy();
}
async function expectAuto() {
  await waitFor(() => expect(value()).toMatchObject({ preset: "current_season" }));
  expect(new URLSearchParams(window.location.search).get("preset")).toBe("current_season");
}

beforeEach(() => {
  localStorage.clear(); h.path = "/app"; h.search = ""; h.paths = [];
  h.seasons = { items: [season68] }; h.views = { views: [], defaultViewId: null };
  h.replace.mockReset(); h.io.mockReset(); h.sockets = [];
  h.io.mockImplementation(() => {
    const socket = { connected: false, on: vi.fn(), off: vi.fn(), connect: vi.fn(), disconnect: vi.fn() };
    socket.on.mockReturnValue(socket); h.sockets.push(socket); return socket;
  });
  window.history.replaceState({}, "", "/app");
});
afterEach(async () => {
  cleanup(); await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 0)); });
  for (const socket of h.sockets) expect(socket.disconnect).toHaveBeenCalledTimes(1);
});

it("keeps Auto through actual history, older and report links, then persists a normal Today edit", async () => {
  localStorage.setItem("analyzer.filters", JSON.stringify({ preset: "current_season", map_pool: "all", exclude_too_short: false, regions_rev: 1 }));
  const view = render(tree());
  await waitFor(() => expect(value()).toMatchObject({ preset: "current_season", since: season68.start }));
  await settleUrl(view); await openHistory(view); await expectAuto();
  await visitOlderAndReport(view); await expectAuto();
  await navigate(view, TODAY_ENTRY.href); await settleUrl(view); await expectAuto();
  expect(stored().preset).toBe("current_season");
  expect(stored()).not.toHaveProperty("since"); expect(stored()).not.toHaveProperty("before");
  fireEvent.click(screen.getByRole("button", { name: "Choose Terran" }));
  expect(stored()).toMatchObject({ preset: "current_season", race: "T", map_pool: "all", exclude_too_short: false });
  await settleUrl(view); view.unmount();
  h.path = "/app"; h.search = ""; window.history.replaceState({}, "", "/app"); render(tree());
  await waitFor(() => expect(value()).toMatchObject({ preset: "current_season", race: "T", since: season68.start }));
}, 15_000);

it("keeps a marked Session scope copied to Maps in the generic copied-view lifetime", async () => {
  localStorage.setItem("analyzer.filters", JSON.stringify({ preset: "current_season", regions_rev: 1 }));
  const original = localStorage.getItem("analyzer.filters");
  const first = render(tree());
  const link = await screen.findByRole("link", { name: "Natural session history" });
  const copied = new URL(link.getAttribute("href") ?? "", window.location.href);
  first.unmount(); h.path = "/app/maps"; h.search = copied.searchParams.toString();
  window.history.replaceState({}, "", `${h.path}?${h.search}`);
  const view = render(tree());
  await waitFor(() => expect(value().preset).toBe("current_season"));
  await settleUrl(view);
  expect(new URLSearchParams(window.location.search).has("sessionScope")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Choose Terran" }));
  expect(localStorage.getItem("analyzer.filters")).toBe(original);
}, 15_000);

it("preserves normal storage updates after reloading a generated current-report URL", async () => {
  localStorage.setItem("analyzer.filters", JSON.stringify({ preset: "current_season", regions_rev: 1 }));
  const first = render(tree());
  const link = await screen.findByRole("link", { name: "View this session" });
  await navigate(first, link.getAttribute("href") ?? ""); await settleUrl(first);
  expect(new URLSearchParams(window.location.search).get("sessionScope")).toBe("1");
  first.unmount();
  const view = render(tree());
  await waitFor(() => expect(value().preset).toBe("current_season"));
  await settleUrl(view);
  fireEvent.click(screen.getByRole("button", { name: "Choose Terran" }));
  expect(stored()).toMatchObject({ preset: "current_season", race: "T" });
}, 15_000);

it("revalidates a same-scope list Refresh without replacing Auto or requiring a new URL", async () => {
  const view = render(tree()); await settleUrl(view); await openHistory(view);
  const before = h.paths.length, path = h.paths.at(-1), href = window.location.href;
  fireEvent.click(screen.getByRole("button", { name: "Refresh session view" }));
  await waitFor(() => expect(h.paths.length).toBeGreaterThan(before));
  expect(h.paths.at(-1)).toBe(path); expect(window.location.href).toBe(href);
  expect(value().preset).toBe("current_season");
}, 15_000);

it("preserves genuinely selected custom dates through history/report and back to Today", async () => {
  localStorage.setItem("analyzer.filters", JSON.stringify({ ...custom, regions_rev: 1 }));
  const view = render(tree()); await waitFor(() => expect(value()).toMatchObject(custom));
  await settleUrl(view); await openHistory(view); await visitOlderAndReport(view);
  await navigate(view, TODAY_ENTRY.href); await settleUrl(view);
  expect(value()).toMatchObject(custom); expect(stored()).toMatchObject(custom);
}, 15_000);

it.each([
  { name: "Saved Auto", filters: { preset: "current_season" } as AnalyzerFilters },
  { name: "Saved custom", filters: custom },
  { name: "Pinned season", filters: { preset: "season:68" } as AnalyzerFilters },
])("keeps intentional $name view semantics and copied-view storage isolation", async ({ name, filters }) => {
  localStorage.setItem("analyzer.filters", JSON.stringify({ preset: "last_30d", race: "Z", regions_rev: 1 }));
  const original = localStorage.getItem("analyzer.filters");
  h.views = { views: [{ id: "saved", name, section: "sessions", filters }], defaultViewId: null };
  const view = render(tree()); await settleUrl(view);
  fireEvent.click(screen.getByRole("button", { name: "Open saved views" }));
  fireEvent.click(await screen.findByRole("button", { name: `Apply ${name}` }));
  const applied = h.replace.mock.calls.at(-1);
  if (!applied) throw new Error("Actual Saved Views Apply did not navigate");
  h.replace.mockClear(); await navigate(view, String(applied[0])); await settleUrl(view);
  await visitOlderAndReport(view); await navigate(view, TODAY_ENTRY.href); await settleUrl(view);
  expect(value().preset).toBe(filters.preset);
  if (filters.preset === "custom") expect(value()).toMatchObject(custom);
  fireEvent.click(screen.getByRole("button", { name: "Choose Terran" }));
  expect(localStorage.getItem("analyzer.filters")).toBe(original);
}, 15_000);

it("keeps Auto relative after a Sessions visit when the shared season catalog rolls over and reloads", async () => {
  localStorage.setItem("analyzer.filters", JSON.stringify({ preset: "current_season", regions_rev: 1 }));
  const view = render(tree()); await settleUrl(view); await openHistory(view);
  await visitOlderAndReport(view); await navigate(view, TODAY_ENTRY.href); await settleUrl(view);
  h.seasons = { items: [season69, season68] }; view.rerender(tree());
  await waitFor(() => expect(value()).toMatchObject({ preset: "current_season", since: season69.start }));
  expect(value().until).toBeUndefined(); await settleUrl(view); await expectAuto();
  expect(stored()).toMatchObject({ preset: "current_season" }); view.unmount();
  h.path = "/app"; h.search = ""; window.history.replaceState({}, "", "/app");
  render(tree());
  await waitFor(() => expect(value()).toMatchObject({ preset: "current_season", since: season69.start }));
  expect(value().until).toBeUndefined();
}, 15_000);
