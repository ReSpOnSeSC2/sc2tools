import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FiltersContext, type AnalyzerFilters } from "@/lib/filterContext";
import type { SessionDetailTrack, SessionHistoryDetail } from "@/lib/sessionHistory";
import { sessionScopeQuery } from "@/lib/sessionHistoryUrls";
import { SessionDetail } from "../SessionDetail";
import { historyDetail, historyGame } from "./sessionHistoryFixtures";

const h = vi.hoisted(() => ({ owner: "owner-a", search: "", data: undefined as SessionHistoryDetail | undefined, tracks: [] as Array<readonly SessionDetailTrack[]> }));
vi.mock("@/lib/useUrlQueryWriter", () => ({ useUrlQueryWriter: () => ({ search: h.search, capture: () => null, update: () => false }) }));
vi.mock("../useSessionRequest", () => ({ useSessionRequest: (path: string | null) => ({ owner: h.owner, key: JSON.stringify([h.owner, path]), data: h.data, error: undefined, mutate: () => undefined, current: () => true }) }));
vi.mock("next/dynamic", () => ({ default: () => function ChartProbe({ tracks }: { tracks: readonly SessionDetailTrack[] }) { h.tracks.push(tracks); return <output aria-label="Loaded recorded MMR chart">Fresh chart data</output>; } }));
vi.mock("../SessionGamesPage", () => ({ SessionGamesPage: () => <p>Delivered game page</p> }));
const FILTERS: AnalyzerFilters = { preset: "all", map_pool: "all", game_size: "all", exclude_too_short: false };
function host(child: ReactNode) { return <FiltersContext.Provider value={{ filters: FILTERS, dbRev: 0, seasons: [], setFilters: () => undefined, bumpRev: () => undefined }}>{child}</FiltersContext.Provider>; }
beforeEach(() => { h.owner = "owner-a"; h.search = sessionScopeQuery(FILTERS).toString(); h.data = historyDetail(); h.tracks = []; });
afterEach(cleanup);

it("preserves loaded-chart intent across game-page loading while admitting only the fresh next-page graph data", () => {
  const view = render(host(<SessionDetail id="owned-report" />));
  fireEvent.click(screen.getByRole("button", { name: "Load recorded MMR chart" }));
  expect(screen.getByLabelText("Loaded recorded MMR chart")).toBeTruthy(); const old = h.data?.mmr;
  h.search += "&gamesBefore=next-page"; h.data = undefined; view.rerender(host(<SessionDetail id="owned-report" />));
  expect(screen.getByText("Loading session view…")).toBeTruthy(); expect(screen.queryByLabelText("Loaded recorded MMR chart")).toBeNull();
  h.data = historyDetail({ games: [historyGame({ position: 2 })] }); view.rerender(host(<SessionDetail id="owned-report" />));
  expect(screen.getByLabelText("Loaded recorded MMR chart")).toBeTruthy(); expect(screen.queryByRole("button", { name: "Load recorded MMR chart" })).toBeNull();
  expect(h.tracks.at(-1)).toBe(h.data.mmr); expect(h.tracks.at(-1)).not.toBe(old);
});

it("does not resurrect loaded intent after owner A→B→A or a different report", () => {
  const view = render(host(<SessionDetail id="owned-report" />)); fireEvent.click(screen.getByRole("button", { name: "Load recorded MMR chart" }));
  h.owner = "owner-b"; h.data = undefined; view.rerender(host(<SessionDetail id="owned-report" />));
  h.owner = "owner-a"; h.data = historyDetail(); view.rerender(host(<SessionDetail id="owned-report" />));
  expect(screen.getByRole("button", { name: "Load recorded MMR chart" })).toBeTruthy(); expect(screen.queryByLabelText("Loaded recorded MMR chart")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load recorded MMR chart" })); view.rerender(host(<SessionDetail id="another-owned-report" />));
  expect(screen.getByRole("button", { name: "Load recorded MMR chart" })).toBeTruthy();
});

it("retires loaded intent when report context changes", () => {
  const view = render(host(<SessionDetail id="owned-report" />)); fireEvent.click(screen.getByRole("button", { name: "Load recorded MMR chart" }));
  h.search += "&contextDays=3"; view.rerender(host(<SessionDetail id="owned-report" />));
  expect(screen.getByRole("button", { name: "Load recorded MMR chart" })).toBeTruthy(); expect(screen.queryByLabelText("Loaded recorded MMR chart")).toBeNull();
});
