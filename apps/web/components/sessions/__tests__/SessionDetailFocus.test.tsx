import type { AnchorHTMLAttributes } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FiltersContext, type AnalyzerFilters } from "@/lib/filterContext";
import type { SessionDetailTrack, SessionHistoryDetail } from "@/lib/sessionHistory";
import { sessionScopeQuery } from "@/lib/sessionHistoryUrls";
import { SessionDetail } from "../SessionDetail";
import { historyDetail, historyGame } from "./sessionHistoryFixtures";
import { mmrTrack } from "./sessionCardFixtures";

const h = vi.hoisted(() => ({
  owner: "owner-a", search: "", revision: 0, filters: {} as AnalyzerFilters,
  data: undefined as SessionHistoryDetail | undefined,
  linkEvents: [] as Array<{ href: string; prevented: boolean }>,
}));
vi.mock("@/lib/useUrlQueryWriter", () => ({ useUrlQueryWriter: () => ({ search: h.search, capture: () => null, update: () => false }) }));
vi.mock("../useSessionRequest", () => ({ useSessionRequest: (path: string | null) => ({ owner: h.owner, key: JSON.stringify([h.owner, path]), data: h.data, error: undefined, mutate: () => undefined, current: () => true }) }));
vi.mock("next/dynamic", async () => {
  const { SessionMmrChart } = await import("../SessionMmrChart");
  return { default: () => SessionMmrChart };
});
vi.mock("@/lib/charts/theme", () => ({ useChartKit: () => ({ grid: "currentColor", series: ["currentColor"], tokens: { text: "currentColor" } }) }));
vi.mock("@/components/analyzer/AllGamesTable", () => ({ AllGamesTable: ({ games }: { games: readonly unknown[] }) => <p>{games.length} delivered game rows</p> }));
type FixtureLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; scroll?: boolean };
vi.mock("next/link", async () => {
  const { forwardRef } = await import("react");
  return { default: forwardRef<HTMLAnchorElement, FixtureLinkProps>(function FixtureLink({ href, scroll, onClick, children, ...props }, ref) {
    void scroll;
    return <a {...props} ref={ref} href={href} onClick={event => {
      onClick?.(event); h.linkEvents.push({ href, prevented: event.defaultPrevented });
      event.preventDefault(); // Only the fixture suppresses jsdom navigation, after the real handler.
    }}>{children}</a>;
  }) };
});

const FILTERS: AnalyzerFilters = { preset: "all", map_pool: "all", game_size: "all", exclude_too_short: false };
const DATES = ["2026-10-27T03:40:00.000Z", "2026-10-27T03:55:00.000Z", "2026-10-27T04:15:00.000Z"];
const nativeFocus = HTMLElement.prototype.focus;
let focusCalls: Array<{ target: HTMLElement; options?: FocusOptions }> = [];
function scopeQuery() { const query = sessionScopeQuery(h.filters); query.set("gamesLimit", "1"); return query.toString(); }
function page(position: 1 | 2 | 3 = 1): SessionHistoryDetail {
  const mmr: SessionDetailTrack[] = [
    { ...mmrTrack(), steps: [{ position: 1, date: DATES[0], gameId: null, value: 3000, source: "legacy" }, { position: 2, date: DATES[1], gameId: null, value: 3020, source: "replay" }] },
    { ...mmrTrack({ ladderRace: "R", games: 1, samples: 1, legacySamples: 0, start: 3100, end: 3100, delta: null, peak: 3100 }), steps: [{ position: 3, date: DATES[2], gameId: null, value: 3100, source: "replay" }] },
  ];
  return historyDetail({ mmr, games: [historyGame({ position, date: DATES[position - 1], outcome: position === 1 ? "W" : position === 2 ? "L" : "U", ladderRace: position === 3 ? "R" : "P", myMmr: position === 1 ? 3000 : position === 2 ? 3020 : 3100, myMmrSource: position === 1 ? "legacy" : "replay" })],
    gamePage: { limit: 1, count: 1, total: 3 }, nextGamesBefore: position < 3 ? `page-${position + 1}` : null });
}
function tree(id = "owned-report") {
  return <FiltersContext.Provider value={{ filters: h.filters, dbRev: h.revision, seasons: [], setFilters: () => undefined, bumpRev: () => undefined }}><SessionDetail id={id} /></FiltersContext.Provider>;
}
function nextLink() { return screen.getByRole("link", { name: "Next games in this session" }); }
function gamesRegion() { return screen.getByRole("region", { name: "Games in this session" }); }
function restoredFocus() { return focusCalls.filter(call => call.options?.preventScroll); }
function beginNextPage(view: ReturnType<typeof render>, id = "owned-report") {
  const query = new URLSearchParams(h.search); query.set("gamesBefore", "page-2"); h.search = query.toString();
  h.data = undefined; view.rerender(tree(id));
}
beforeEach(() => {
  h.owner = "owner-a"; h.revision = 0; h.filters = { ...FILTERS }; h.search = scopeQuery(); h.data = page(); h.linkEvents = []; focusCalls = [];
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function(this: HTMLElement, options?: FocusOptions) {
    focusCalls.push({ target: this, options }); nativeFocus.call(this, options);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("restores only the explicit Next-games activation to the fresh games region without scrolling", () => {
  const view = render(tree()); fireEvent.click(screen.getByRole("button", { name: "Load recorded MMR chart" }));
  const oldCurve = screen.getByTestId("recorded-mmr-curve"), oldPath = oldCurve.getAttribute("d"), oldTracks = h.data?.mmr;
  const next = nextLink(); next.focus(); fireEvent.click(next, { button: 0 });
  expect(document.activeElement).toBe(next); expect(restoredFocus()).toHaveLength(0);
  expect(h.linkEvents.at(-1)?.prevented).toBe(false);
  beginNextPage(view);
  expect(screen.getByText("Loading session view…")).toBeTruthy(); expect(screen.queryByRole("region", { name: "Games in this session" })).toBeNull();
  expect(screen.queryByTestId("recorded-mmr-curve")).toBeNull();
  h.data = page(2); view.rerender(tree());
  const region = gamesRegion();
  expect(document.activeElement).toBe(region); expect(region.tabIndex).toBe(-1);
  expect(restoredFocus()).toHaveLength(1); expect(restoredFocus()[0]).toEqual({ target: region, options: { preventScroll: true } });
  expect(screen.getByTestId("recorded-mmr-curve")).not.toBe(oldCurve); expect(screen.getByTestId("recorded-mmr-curve").getAttribute("d")).toBe(oldPath); expect(h.data.mmr).not.toBe(oldTracks);
  expect(screen.queryByRole("button", { name: "Load recorded MMR chart" })).toBeNull();
  h.data = undefined; view.rerender(tree()); h.data = page(2); view.rerender(tree());
  expect(document.activeElement).not.toBe(gamesRegion()); expect(restoredFocus()).toHaveLength(1);
});

it("does not restore games focus for chart inspection or an unsolicited fresh admission", () => {
  const view = render(tree()); fireEvent.click(screen.getByRole("button", { name: "Load recorded MMR chart" }));
  const slider = screen.getByRole("slider", { name: "Inspect a recorded observation" }); slider.focus(); fireEvent.change(slider, { target: { value: "1" } });
  expect(document.activeElement).toBe(slider); expect(restoredFocus()).toHaveLength(0);
  beginNextPage(view); h.data = page(2); view.rerender(tree());
  expect(document.activeElement).not.toBe(gamesRegion()); expect(restoredFocus()).toHaveLength(0);
});

it.each([
  { name: "Control", ctrlKey: true }, { name: "Meta", metaKey: true }, { name: "Shift", shiftKey: true }, { name: "Alt", altKey: true }, { name: "non-primary", button: 1 },
])("does not arm focus or cancel the native $name link activation", ({ name, ...event }) => {
  void name;
  const view = render(tree()); const next = nextLink(); next.focus(); fireEvent.click(next, { button: 0, ...event });
  expect(h.linkEvents.at(-1)?.prevented).toBe(false);
  beginNextPage(view); h.data = page(2); view.rerender(tree());
  expect(document.activeElement).not.toBe(gamesRegion()); expect(restoredFocus()).toHaveLength(0);
});

it("does not arm focus for an already cancelled primary activation", () => {
  const view = render(tree()); const next = nextLink();
  next.addEventListener("click", event => event.preventDefault(), { once: true }); fireEvent.click(next, { button: 0 });
  expect(h.linkEvents.at(-1)?.prevented).toBe(true);
  beginNextPage(view); h.data = page(2); view.rerender(tree());
  expect(document.activeElement).not.toBe(gamesRegion()); expect(restoredFocus()).toHaveLength(0);
});

function retire(kind: string) {
  if (kind === "owner" || kind === "owner ABA") h.owner = "owner-b";
  if (kind === "membership") { h.filters = { ...FILTERS, race: "Z" }; h.search = scopeQuery(); }
  if (kind === "context") h.search += "&contextDays=3";
  if (kind === "current mode") h.search += "&sessionView=current";
  if (kind === "revision") h.revision++;
  return kind === "report" ? "different-owned-report" : "owned-report";
}
it.each(["owner", "owner ABA", "report", "membership", "context", "current mode", "revision"])("retires pending focus with the %s report lifetime", kind => {
  const view = render(tree()); const next = nextLink(); next.focus(); fireEvent.click(next, { button: 0 });
  h.data = undefined; const id = retire(kind); view.rerender(tree(id));
  if (kind === "owner ABA") { h.owner = "owner-a"; view.rerender(tree(id)); }
  const fresh = page(2); h.data = kind === "current mode" ? { ...fresh, definition: { ...fresh.definition, mode: "current" } } : fresh; view.rerender(tree(id));
  expect(document.activeElement).not.toBe(gamesRegion()); expect(restoredFocus()).toHaveLength(0);
});
