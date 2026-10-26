import { readFileSync } from "node:fs";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({ aging: [] as unknown[], progression: [] as unknown[], mmr: {} as Record<string, unknown>, error: undefined as unknown, global: false, reduced: false, paths: [] as string[], retry: vi.fn() }));
vi.mock("@/lib/clientApi", () => ({ useApi: (url: string) => {
  state.paths.push(url); return { data: state.error ? undefined : url.includes("aging-curve") ? state.aging : state.progression, error: state.error, isLoading: false, mutate: state.retry };
} }));
vi.mock("@/lib/filterContext", () => ({ useFilters: () => ({ filters: { race: "P", opp_race: "T", map: "Synthetic LE" }, dbRev: 7 }), filtersToQuery: () => "?race=P&opp_race=T&map=Synthetic+LE" }));
vi.mock("@/lib/trendsDataContext", () => ({ useTrendsDataScope: () => ({ isGlobal: state.global }), useTrendsApi: (url: string) => ({ data: url.startsWith("/v1/timeseries/mmr") ? state.mmr : undefined, isLoading: false, error: undefined, mutate: state.retry }) }));
vi.mock("../MmrDailySwings", () => ({ MmrDailySwings: () => null }));
vi.mock("@/components/maps/MapArtwork", () => ({ MapLabel: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock("recharts", async () => {
  const React = await import("react");
  const Data = React.createContext<Array<Record<string, unknown>>>([]);
  const Plot = ({ data, children }: { data: Array<Record<string, unknown>>; children: ReactNode }) => <Data.Provider value={data}><svg data-testid="consumer-plot">{children}</svg></Data.Provider>;
  const Line = ({ dataKey, stroke, strokeDasharray, dot, isAnimationActive }: { dataKey: string; stroke: string; strokeDasharray?: string; dot?: unknown; isAnimationActive?: boolean }) => {
    const rows = React.useContext(Data);
    return <svg data-testid="consumer-line" data-key={dataKey} data-stroke={stroke} data-dash={strokeDasharray} data-animation={String(isAnimationActive)}>
      {typeof dot === "function" ? rows.filter(row => typeof row[dataKey] === "number").map((row, index) => <g key={index}>{dot({ cx: index + 1, cy: 10, index, payload: row })}</g>) : null}
    </svg>;
  };
  return { ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>, LineChart: Plot, ComposedChart: Plot, Line,
    CartesianGrid: ({ stroke }: { stroke: string }) => <g data-testid="consumer-grid" data-stroke={stroke} />,
    XAxis: ({ tick }: { tick?: { fontSize?: number } }) => <g data-testid="consumer-axis" data-size={tick?.fontSize} />, YAxis: ({ tick }: { tick?: { fontSize?: number } }) => <g data-testid="consumer-axis" data-size={tick?.fontSize} />,
    Bar: ({ children, dataKey, fill }: { children: ReactNode; dataKey: string; fill: string }) => <g data-testid="consumer-bar" data-key={dataKey} data-fill={fill}>{children}</g>,
    Cell: ({ fillOpacity }: { fillOpacity: number }) => <rect data-testid="consumer-cell" data-opacity={fillOpacity} />,
    Area: () => null, ReferenceLine: () => null, ReferenceDot: () => null, Tooltip: () => null };
});
import { MmrBucketChart } from "../../mmr/MmrBucketChart";
import { BuildAgingCurve } from "../../mmr/BuildAgingCurve";
import { MmrProgressionByBuild } from "../../mmr/MmrProgressionByBuild";
import { MmrProgressionChart } from "../MmrProgressionChart";
import { MatchByMatchTimeline } from "../../h2h/MatchByMatchTimeline";
import { StreaksMomentum } from "../../h2h/StreaksMomentum";
import { CumulativeTooltip, PeriodTooltip } from "../../h2h/shared/h2hTooltip";
import { cumulativeSeries, type H2HGame } from "@/lib/h2hSeries";

const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
function theme(value: "light" | "dark") {
  const selector = value === "light" ? ':root[data-theme="light"]' : ':root:not([data-theme])';
  const declarations = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match => match[1].includes(selector)).map(match => match[2]).join("\n");
  const entries = [...declarations.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2].trim()] as const).filter(([, color]) => /^\d+\s+\d+\s+\d+$/.test(color));
  for (const [name, color] of entries) document.documentElement.style.setProperty(name, color);
  document.documentElement.setAttribute("data-theme", value);
  return Object.fromEntries(entries);
}
const point = (bucket: string, closeMmr: number, wins = 3, losses = 1) => ({ bucket, openMmr: closeMmr - 10, closeMmr, minMmr: closeMmr - 20, maxMmr: closeMmr + 20, total: wins + losses, wins, losses });
const games: H2HGame[] = [
  { id: "g1", date: "2026-10-01T12:00:00Z", result: "Win", map: "Synthetic A", macro_score: 10 },
  { id: "unknown", date: "2026-10-02T12:00:00Z", result: "Unknown", map: "Unknown map" },
  { id: "g2", date: "2026-10-03T12:00:00Z", result: "Win", map: "Synthetic B", macro_score: 90 },
  { id: "g3", date: "2026-10-04T12:00:00Z", result: "Loss", map: "Synthetic C", macro_score: 50 },
];
beforeEach(() => {
  window.localStorage.clear(); state.paths = []; state.error = undefined; state.global = false; state.reduced = false; state.retry.mockReset();
  state.aging = [{ build: "Opening", curve: Array.from({ length: 12 }, (_, index) => ({ n: index + 1, wins: index % 2 ? 0 : 1, losses: index % 2 ? 1 : 0, cumulativeWins: Math.ceil((index + 1) / 2), cumulativeLosses: Math.floor((index + 1) / 2) })) }];
  state.progression = [{ build: "Opening", points: Array.from({ length: 12 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, "0")}T12:00:00Z`, mmr: 4000 + index * 10, result: index % 2 ? "loss" : "win" })) }];
  const series = [{ seriesKey: "main|P", toonHandle: "main", region: "NA", ladderRace: "P", label: "NA main / P", points: [point("2026-10-01", 4000), point("2026-10-03", 4100, 10, 10)], peak: null, trough: null, latest: null },
    { seriesKey: "alt|T", toonHandle: "alt", region: "EU", ladderRace: "T", label: "EU alt / T", points: [point("2026-10-01", 3000)], peak: null, trough: null, latest: null }];
  state.mmr = { interval: "week", points: [point("2026-10-01", 4000)], series, peak: null, trough: null, latest: null };
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduced-motion") && state.reduced, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
  theme("dark");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.documentElement.removeAttribute("style"); document.documentElement.removeAttribute("data-theme"); });

describe.each(["light", "dark"] as const)("chart consumers in %s theme", mode => {
  it("uses comparison rows rather than connecting MMR categories, retaining rates and gates", () => {
    theme(mode); render(<MmrBucketChart rows={[{ series: "Opening", bucket: 4000, label: "4000–4199", games: 5, wins: 1, losses: 1 }, { series: "Sparse", bucket: 4000, label: "4000–4199", games: 2, wins: 2, losses: 0 }]} minSampleSize={3} />);
    expect(screen.queryByTestId("consumer-plot")).toBeNull(); expect(screen.getByText("20%")).toBeTruthy();
    expect(screen.getByText(/Below the current minimum of 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /View as table/ }));
    expect(screen.getByRole("table").textContent).toContain("20%"); expect(screen.getByRole("table").textContent).toContain("Below minimum");
  });
  it("shows build experience values and cumulative samples from the same plot rows", () => {
    theme(mode); const view = render(<BuildAgingCurve />);
    expect(view.container.querySelectorAll("circle").length).toBe(12);
    expect(state.paths.some(url => url === "/v1/mmr-stats/aging-curve?race=P&opp_race=T&map=Synthetic+LE#7")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /View as table/ }));
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows.at(-1)?.textContent).toContain("50%"); expect(rows.at(-1)?.textContent).toContain("6W–6L"); expect(rows.at(-1)?.textContent).toContain("12 · small sample");
  });
  it("keeps build progression's recorded MMR and sample in its table", () => {
    theme(mode); render(<MmrProgressionByBuild />);
    expect(state.paths.some(url => url === "/v1/mmr-stats/progression?race=P&opp_race=T&map=Synthetic+LE#7")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /View as table/ }));
    expect(screen.getByRole("table").textContent).toContain("4110"); expect(screen.getByRole("table").textContent).toContain("12 · small sample");
  });
  it("preserves independent account/race histories and exposes their rated counts", () => {
    const values = theme(mode), view = render(<MmrProgressionChart bucket="day" />);
    expect(screen.getAllByTestId("consumer-grid")[0].getAttribute("data-stroke")).toBe(`rgb(${values["--border"]})`);
    expect(screen.getAllByTestId("consumer-axis").every(axis => axis.getAttribute("data-size") === "12")).toBe(true);
    expect(screen.getAllByTestId("consumer-line")).toHaveLength(2);
    expect(view.container.querySelectorAll('circle[stroke-width="2"]').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /View as table/ }));
    const rows = within(screen.getByRole("table")).getAllByRole("row"); expect(rows).toHaveLength(4);
    expect(screen.getByRole("table").textContent).toContain("NA main / P"); expect(screen.getByRole("table").textContent).toContain("EU alt / T");
    expect(screen.getByRole("table").textContent).toContain("20");
  });
});

it("responds to a live theme change without changing plotted data or enabling animation", async () => {
  render(<MmrProgressionChart bucket="day" />);
  let values: Record<string, string> = {};
  await act(async () => { values = theme("light"); });
  await waitFor(() => expect(screen.getAllByTestId("consumer-grid")[0].getAttribute("data-stroke")).toBe(`rgb(${values["--border"]})`));
  expect(screen.getAllByTestId("consumer-line").every(line => line.getAttribute("data-animation") === "false")).toBe(true);
});
it("keeps the cohort average, effective interval and average rounding distinct from a personal closing MMR", () => {
  state.global = true; state.mmr = { interval: "week", points: [{ ...point("2026-10-01", 4000, 10, 10), avgMmr: 4300.5 }], peak: null, trough: null, latest: null };
  render(<MmrProgressionChart bucket="day" />);
  expect(screen.getByText(/Average of the last verified/).textContent).toContain("per week");
  fireEvent.click(screen.getByRole("button", { name: /View as table/ }));
  expect(screen.getByRole("table").textContent).toContain("Cohort average"); expect(screen.getByRole("table").textContent).toContain("4,301");
});
it("retains timeline keyboard selection and table drilldowns without stealing nested control keys", () => {
  const select = vi.fn(); render(<MatchByMatchTimeline chronoGames={games} oppRace="P" bucket="day" rollingWindow={2} presetLong="Current season" opponentName="Synthetic opponent" onSelectGame={select} />);
  const figure = screen.getByRole("figure", { name: "Match-by-match timeline" });
  fireEvent.keyDown(figure, { key: "End" }); fireEvent.keyDown(figure, { key: "Enter" }); expect(select).toHaveBeenLastCalledWith("g3");
  const periodButton = screen.getByRole("button", { name: /View as table · Games per day/ });
  fireEvent.keyDown(periodButton, { key: "Enter" }); expect(select).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: /View as table · Match-by-match timeline/ }));
  expect(screen.getByRole("table").textContent).not.toContain("Unknown map"); fireEvent.click(screen.getByRole("button", { name: "Select #2" })); expect(select).toHaveBeenLastCalledWith("g2");
});
it("keeps streak callbacks and visible W/L labels when reduced motion disables pulses", () => {
  state.reduced = true; const select = vi.fn(), view = render(<StreaksMomentum chronoGames={games} presetShort="Season" presetLong="Current season" opponentName="Synthetic opponent" onSelectGame={select} />);
  expect(screen.getByText(/n=3 decided/)).toBeTruthy();
  fireEvent.click(screen.getByText(/Notable streaks/));
  const run = screen.getByRole("button", { name: /W2/ }); fireEvent.click(run); expect(select).toHaveBeenLastCalledWith("g1");
  expect(view.container.querySelector('[class*="animate-pulse"]')).toBeNull();
  expect(view.container.querySelectorAll("button span[aria-hidden]").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: /View as table/ })); expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(4);
});
it("uses themed H2H tooltips with unchanged values and explicit small-sample counts", () => {
  const values = theme("light"), data = cumulativeSeries(games, 2);
  render(<><CumulativeTooltip active payload={[{ payload: data[1] }]} rollingLabel="2-game rolling" /><PeriodTooltip active payload={[{ payload: { date: "2026-10-01", wins: 2, losses: 1, total: 3, winRatePct: 67 } }]} bucketLabel="Daily" /></>);
  expect(screen.getAllByRole("tooltip")).toHaveLength(2);
  expect(screen.getAllByText(/Small sample · n=/)).toHaveLength(2);
  expect(screen.getAllByRole("tooltip")[0].getAttribute("style")).toContain("background");
  expect(screen.getAllByRole("tooltip")[0].getAttribute("style")).toContain(values["--bg-elevated"].split(" ")[0]);
  expect(screen.getByText("67%")).toBeTruthy();
});
it("keeps a failed build query distinct from empty chart data", () => {
  state.error = { status: 503, message: "Synthetic chart service unavailable" }; render(<BuildAgingCurve />);
  expect(screen.queryByText("No builds with enough plays yet")).toBeNull(); expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
});
