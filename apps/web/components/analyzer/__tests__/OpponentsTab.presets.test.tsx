import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FiltersContext, type AnalyzerFilters } from "@/lib/filterContext";
import { OpponentsTab } from "../OpponentsTab";
import { useOpponentUrlControls } from "../useOpponentUrlControls";
import { OPPONENT_SORTS } from "../useOpponentListNavigation";

const fixture = vi.hoisted(() => ({ replace: vi.fn(), prefetch: vi.fn(), push: vi.fn(), mobile: true,
  opponents: vi.fn(), setFilters: vi.fn() }));
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (notify: () => void) => {
    window.addEventListener("fixture-navigation", notify); window.addEventListener("popstate", notify);
    return () => { window.removeEventListener("fixture-navigation", notify); window.removeEventListener("popstate", notify); };
  };
  return { usePathname: () => useSyncExternalStore(subscribe, () => window.location.pathname, () => ""),
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => "")),
    useRouter: () => fixture };
});
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: { links: {}, partial: false }, isLoading: false }) }));
vi.mock("@/lib/useApiPaginated", () => ({ useApiPaginated: (...args: unknown[]) => fixture.opponents(...args) }));
vi.mock("@/lib/netMmrOpponents", () => ({ useAllNetMmrOpponents: () => ({
  items: [
    { pulseId: "alpha", pairs: 2, netMmr: 10, mmrWon: 20, mmrLost: 10 },
    { pulseId: "beta", pairs: 2, netMmr: -10, mmrWon: 10, mmrLost: 20 },
    { pulseId: "gamma", pairs: 2, netMmr: 5, mmrWon: 10, mmrLost: 5 },
  ], isLoading: false, error: null,
}) }));
vi.mock("../usePlayerChannels", () => ({ usePlayerChannels: () => () => undefined }));
vi.mock("@/lib/useRivals", async original => ({ ...await original<typeof import("@/lib/useRivals")>(),
  useRivals: () => ({ owner: "fixture-owner", keys: [], loading: false, saving: false, toggle: vi.fn() }),
}));
vi.mock("@/lib/useRivalSummary", () => ({ useRivalSummary: () => ({ data: undefined, loading: false, error: false, retry: vi.fn() }) }));
vi.mock("@/lib/useOpponentScoutingPreference", async () => {
  const { useState } = await import("react");
  return { useOpponentScoutingPreference: () => {
    const [groupByPlayer, setGroupByPlayer] = useState(true);
    return { groupByPlayer, setGroupByPlayer, loading: false, saving: false, unavailable: false, error: "", retry: vi.fn() };
  } };
});

const filters: AnalyzerFilters = { race: "P", map: "Ghost River LE", accounts: "1-S2-1-44", since: "2026-10-01", map_pool: "ladder", game_size: "1v1" };
const globalQuery = "filters=1&race=P&map=Ghost+River+LE&accounts=1-S2-1-44&since=2026-10-01&future=keep";
const names = ["Player Alpha", "Player Beta", "Player Gamma"];
const rows = [
  { pulseId: "alpha", name: names[0], wins: 8, losses: 1, games: 9, lastPlayed: "2026-10-27T00:00:00Z" },
  { pulseId: "beta", name: names[1], wins: 2, losses: 7, games: 9, lastPlayed: "2026-10-25T00:00:00Z" },
  { pulseId: "gamma", name: names[2], wins: 1, losses: 1, games: 2, lastPlayed: "2026-10-26T00:00:00Z" },
].map(row => ({ ...row, race: "P", winRate: row.wins / row.games, notes: "A scouting note", mmr: 4200 }));

function navigate(query: string, event = "fixture-navigation") {
  window.history.replaceState({}, "", `/app/opponents?${query}`);
  window.dispatchEvent(new Event(event));
}
/** Same real Tab/URL-controls boundary as OpponentsRoute, without its lazy
 * import/header. Only navigation transport and GET/account providers are seams. */
function ControlledOpponents() {
  const controls = useOpponentUrlControls(), router = useRouter(), pathname = usePathname() || "/app/opponents";
  const query = useSearchParams()?.toString() ?? "";
  const location = useMemo(() => ({ pathname, query, replace: router.replace, navigate: router.push, prefetch: router.prefetch }), [pathname, query, router]);
  return <FiltersContext.Provider value={{ filters, setFilters: fixture.setFilters, dbRev: 7, bumpRev: vi.fn(), seasons: [] }}>
    <OpponentsTab controls={controls} location={location} />
  </FiltersContext.Provider>;
}
function listedNames() {
  const history = screen.queryByRole("list", { name: "Opponent history" });
  const entries = history ? within(history).getAllByRole("listitem") : [...screen.getByRole("table").querySelectorAll("tbody tr")];
  return entries.map(entry => names.find(name => within(entry as HTMLElement).queryByText(name)));
}
const selectedSort = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "Sort opponents" });
function expectScopePreserved() {
  const query = new URLSearchParams(window.location.search);
  for (const [key, value] of new URLSearchParams(globalQuery)) expect(query.get(key)).toBe(value);
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Search opponents" }).value).toBe("Player");
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Filter opponents by MMR impact" }).value).toBe("tracked");
  expect(screen.getByRole("switch", { name: "Has notes" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("switch", { name: "Group same player" }).getAttribute("aria-checked")).toBe("true");
  expect(JSON.parse(localStorage.getItem("analyzer.opponents.minGames")!)).toBe(2);
  expect(JSON.parse(localStorage.getItem("analyzer.opponents.columns")!)).toEqual({ pulseId: true, mmrWon: true });
  expect(fixture.setFilters).not.toHaveBeenCalled();
}
beforeEach(() => {
  fixture.mobile = true; fixture.replace.mockReset(); fixture.push.mockReset(); fixture.prefetch.mockReset(); fixture.setFilters.mockReset();
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem("analyzer.opponents.minGames", "2");
  localStorage.setItem("analyzer.opponents.columns", JSON.stringify({ pulseId: true, mmrWon: true }));
  fixture.opponents.mockReturnValue({ items: rows, isLoading: false, isLoadingMore: false, isRefreshing: false, error: null, mutate: vi.fn() });
  fixture.replace.mockImplementation((href: string) => { window.history.replaceState({}, "", href); window.dispatchEvent(new Event("fixture-navigation")); });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: fixture.mobile && query === "(max-width: 767px)", media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }));
  navigate(`${globalQuery}&q=Player&notes=1&impact=tracked`, "popstate");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps the mobile preset, actual sort, URL and All exit coherent without resetting other controls", () => {
  render(<ControlledOpponents />); expect(listedNames()).toEqual([names[0], names[2], names[1]]);
  fireEvent.click(screen.getByRole("button", { name: "Lost to most" }));
  expect(screen.getByRole("button", { name: "Lost to most" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: /^All opponents$/ }).getAttribute("aria-pressed")).toBe("false");
  expect(selectedSort().value).toBe("losses"); expect(listedNames()[0]).toBe(names[1]);
  expect(new URLSearchParams(window.location.search).get("sort")).toBe("losses:desc"); expectScopePreserved();
  fireEvent.click(screen.getByRole("button", { name: /^All opponents$/ }));
  expect(screen.getByRole("button", { name: /^All opponents$/ }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Lost to most" }).getAttribute("aria-pressed")).toBe("false");
  expect(selectedSort().value).toBe("lastPlayed"); expect(listedNames()).toEqual([names[0], names[2], names[1]]);
  expect(new URLSearchParams(window.location.search).has("sort")).toBe(false); expectScopePreserved();
});

it("allows native mobile loss/win sorting, direction reversal and a real change back to Last played", () => {
  render(<ControlledOpponents />);
  fireEvent.change(selectedSort(), { target: { value: "losses" } }); expect(listedNames()[0]).toBe(names[1]);
  expect(selectedSort().value).toBe("losses");
  fireEvent.click(screen.getByRole("button", { name: "Reverse sort direction" }));
  expect(new URLSearchParams(window.location.search).get("sort")).toBe("losses:asc"); expect(listedNames().at(-1)).toBe(names[1]);
  expect(screen.getByRole("button", { name: "Lost to most" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.change(selectedSort(), { target: { value: "wins" } }); expect(selectedSort().value).toBe("wins"); expect(listedNames()[0]).toBe(names[0]);
  expect(new URLSearchParams(window.location.search).get("sort")).toBe("wins:desc");
  fireEvent.change(selectedSort(), { target: { value: "lastPlayed" } });
  expect(listedNames()).toEqual([names[0], names[2], names[1]]); expect(new URLSearchParams(window.location.search).has("sort")).toBe(false);
});

it.each([...OPPONENT_SORTS])("represents canonical %s in the mobile menu exactly once, including a restored URL", column => {
  navigate(`${globalQuery}&sort=${column}%3Adesc`, "popstate"); render(<ControlledOpponents />);
  const options = [...selectedSort().options].map(option => option.value);
  expect(new Set(options)).toEqual(OPPONENT_SORTS); expect(options).toHaveLength(OPPONENT_SORTS.size);
  expect(options.filter(value => value === column)).toHaveLength(1); expect(selectedSort().value).toBe(column);
});

it("derives preset selection from canonical/legacy URL and Back without persisting passive navigation", () => {
  const saved = { sortBy: "mmr", sortDir: "asc" };
  localStorage.setItem("analyzer.opponents.sort", JSON.stringify(saved));
  navigate(`${globalQuery}&sort=losses&dir=desc`, "popstate"); render(<ControlledOpponents />);
  expect(selectedSort().value).toBe("losses"); expect(listedNames()[0]).toBe(names[1]);
  expect(screen.getByRole("button", { name: "Lost to most" }).getAttribute("aria-pressed")).toBe("true");
  act(() => navigate(`${globalQuery}&sort=wins%3Aasc`, "popstate"));
  expect(selectedSort().value).toBe("wins"); expect(listedNames()[0]).toBe(names[2]);
  expect(screen.getByRole("button", { name: "Lost to most" }).getAttribute("aria-pressed")).toBe("false");
  act(() => navigate(`${globalQuery}&sort=losses%3Adesc`, "popstate"));
  expect(selectedSort().value).toBe("losses"); expect(screen.getByRole("button", { name: "Lost to most" }).getAttribute("aria-pressed")).toBe("true");
  expect(JSON.parse(localStorage.getItem("analyzer.opponents.sort")!)).toEqual(saved); expect(fixture.replace).not.toHaveBeenCalled();
});

it("restores the selected loss sort from device storage and keeps quick filters independent", () => {
  localStorage.setItem("analyzer.opponents.sort", JSON.stringify({ sortBy: "losses", sortDir: "desc" }));
  render(<ControlledOpponents />); expect(selectedSort().value).toBe("losses");
  expect(screen.getByRole("button", { name: "Lost to most" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Regulars: 5+ games" })); expect(listedNames()).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Lost to most" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Lost to most" })); expect(listedNames()).toHaveLength(3);
  expect(selectedSort().value).toBe("losses");
});

it("keeps desktop Losses header and the same preset actions coherent", () => {
  fixture.mobile = false; render(<ControlledOpponents />);
  fireEvent.click(screen.getByRole("button", { name: "Lost to most" }));
  expect(screen.getByRole("columnheader", { name: "L" }).getAttribute("aria-sort")).toBe("descending");
  expect(listedNames()[0]).toBe(names[1]);
  fireEvent.click(screen.getByRole("button", { name: /^All opponents$/ }));
  expect(screen.getByRole("columnheader", { name: "Last" }).getAttribute("aria-sort")).toBe("descending");
  expect(listedNames()[0]).toBe(names[0]);
});
