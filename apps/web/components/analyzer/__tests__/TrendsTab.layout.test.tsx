import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { TrendsTab } from "../TrendsTab";
import { TrendsDataProvider } from "@/lib/trendsDataContext";
import type { ApiTimeseriesResponse } from "@/lib/timeseries";
import type { ClientApiError } from "@/lib/clientApi";

const useApiMock = vi.fn((_path: string): { data?: ApiTimeseriesResponse; isLoading: boolean; error?: ClientApiError; mutate?: () => unknown } => ({
  data: {
    interval: "week",
    points: [
      {
        bucket: "2026-08-24T00:00:00.000Z",
        wins: 2,
        losses: 1,
        total: 3,
        winRate: 2 / 3,
      },
    ],
  },
  isLoading: false,
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string) => useApiMock(path),
}));

vi.mock("@/lib/filterContext", () => ({
  useFilters: () => ({ filters: {}, dbRev: 3 }),
  filtersToQuery: () => "?scope=test",
}));

vi.mock("recharts", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const ChartStub = () => <div />;
  return {
    ResponsiveContainer: Passthrough,
    ComposedChart: ChartStub,
    Area: ChartStub,
    Bar: ChartStub,
    Line: ChartStub,
    ReferenceLine: ChartStub,
    XAxis: ChartStub,
    YAxis: ChartStub,
    Tooltip: ChartStub,
    CartesianGrid: ChartStub,
    Legend: ChartStub,
  };
});

vi.mock("../FingerprintCard", () => ({
  FingerprintCard: () => (
    <section data-testid="skill-fingerprint">Skill fingerprint</section>
  ),
}));

vi.mock("../explorer/TrendsExplorer", () => ({
  TrendsExplorer: () => <section>Explore performance</section>,
}));

vi.mock("../charts/MapTrendChart", () => ({
  MapTrendChart: () => (
    <section data-testid="map-performance">Map performance over time</section>
  ),
}));

vi.mock("../charts/MatchupOverTimeChart", () => ({
  MatchupOverTimeChart: () => <section>Matchup over time</section>,
}));
vi.mock("../charts/MatchupGameLengthCard", () => ({
  MatchupGameLengthCard: () => <section>Matchup game length</section>,
}));
vi.mock("../charts/TimeOfDayHeatmap", () => ({
  TimeOfDayHeatmap: () => <section>Time of day</section>,
}));
vi.mock("../charts/GameLengthWrChart", () => ({
  GameLengthWrChart: () => <section>Game length</section>,
}));
vi.mock("../charts/ActivityCalendarChart", () => ({
  ActivityCalendarChart: () => <section>Activity calendar</section>,
}));
vi.mock("../charts/MmrProgressionChart", () => ({
  MmrProgressionChart: () => <section>MMR progression</section>,
}));
vi.mock("../charts/MomentumChart", () => ({
  MomentumChart: () => <section>Momentum</section>,
}));
vi.mock("../charts/OppMmrBucketsChart", () => ({
  OppMmrBucketsChart: () => <section>Opponent MMR buckets</section>,
}));
vi.mock("../charts/NetMmrByMatchupChart", () => ({
  NetMmrByMatchupChart: () => <section>Net MMR by matchup</section>,
}));

afterEach(() => {
  cleanup();
  useApiMock.mockClear();
  window.localStorage.clear();
});

describe("TrendsTab layout", () => {
  it("hydrates a saved month bucket without mismatching the server and rejects an invalid bucket", async () => {
    window.localStorage.setItem("analyzer.trends.bucket", JSON.stringify("month"));
    const node = document.createElement("div");
    node.innerHTML = renderToString(<TrendsTab />); document.body.append(node);
    expect(within(node).getByRole("combobox").getAttribute("id")).toBe("trends-period");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => { root = hydrateRoot(node, <TrendsTab />); });
      expect((within(node).getByRole("combobox", { name: "Group charts by" }) as HTMLSelectElement).value).toBe("month");
      expect(errors.mock.calls.flat().join(" ")).not.toMatch(/hydrat|didn't match/i);
    } finally { await act(async () => root?.unmount()); node.remove(); errors.mockRestore(); }
    window.localStorage.setItem("analyzer.trends.bucket", JSON.stringify("invalid"));
    render(<TrendsTab />);
    expect((screen.getByRole("combobox", { name: "Group charts by" }) as HTMLSelectElement).value).toBe("week");
  });

  it("unmounts collapsed chart groups, remembers the choice and expands a reduced-motion jump", () => {
    const view = render(<TrendsTab />);
    fireEvent.click(within(screen.getByRole("heading", { name: "Performance & MMR" })).getByRole("button"));
    expect(screen.queryByText("MMR progression")).toBeNull();
    view.unmount(); render(<TrendsTab />);
    expect(screen.queryByText("MMR progression")).toBeNull();
    const scroll = vi.fn();
    const heading = screen.getByRole("heading", { name: "Performance & MMR" });
    heading.scrollIntoView = scroll;
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Trend sections" })).getByRole("button", { name: "Performance & MMR" }));
    expect(scroll).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByText("MMR progression")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("reserves a summary slot while the overview is loading", () => {
    useApiMock.mockReturnValueOnce({ isLoading: true });
    render(<TrendsTab />);
    expect(screen.getByRole("status", { name: "Loading summary" })).toBeTruthy();
  });
  it.each((["personal", "global"] as const).flatMap((mode) =>
    ["loading", "error", "empty"].map((state) => ({ mode, state })),
  ))("keeps every independent $mode trend section mounted when the overview is $state", ({ mode, state }) => {
    const retry = vi.fn();
    const response: ReturnType<typeof useApiMock> = {
      data: state === "empty" ? { interval: "week", points: [] } : undefined,
      isLoading: state === "loading",
      error: state === "error" ? { status: 0, code: "request_timeout", message: "The API took too long to respond." } : undefined,
      mutate: retry,
    };
    useApiMock.mockReturnValueOnce(response).mockReturnValueOnce(response);
    render(<TrendsDataProvider mode={mode}><TrendsTab /></TrendsDataProvider>);
    for (const title of ["Games played", "Win rate", "MMR progression", "Net MMR by matchup", "Opponent MMR buckets", "Momentum", "Matchup over time", "Matchup game length", "Time of day", "Game length", "Activity calendar", "Map performance over time"]) {
      expect(screen.getByText(title), title).toBeTruthy();
    }
    expect(Boolean(screen.queryByTestId("skill-fingerprint"))).toBe(mode === "personal");
    expect(screen.getByText("Explore performance")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Rolling WR (4)" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Group charts by" })).toBeTruthy();
    if (state === "loading") expect(screen.getByRole("status", { name: "Loading Win rate" })).toBeTruthy();
    if (state === "error") {
      expect(screen.getAllByRole("alert")[0].textContent).toContain("This took too long to load");
      fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
      expect(retry).toHaveBeenCalledOnce();
    }
    if (state === "empty") {
      const title = mode === "personal" ? "No games match these filters" : "No player game records match these filters";
      expect(screen.getAllByText(title)).toHaveLength(2);
      if (mode === "personal") expect(screen.queryByText(/Adjust the player selection/)).toBeNull();
    }
  });

  it("labels the server's wider interval and explains it for global data", () => {
    useApiMock.mockReturnValueOnce({ data: { interval: "month", points: [{ bucket: "2026-08-01T00:00:00.000Z", wins: 3, losses: 0, total: 3, winRate: 1 }] }, isLoading: false });
    render(<TrendsDataProvider mode="global"><TrendsTab /></TrendsDataProvider>);
    expect(screen.getByText("Active months")).toBeTruthy();
    expect(screen.getByText("Recorded results")).toBeTruthy();
    expect(screen.queryByText("Best month")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Showing monthly periods");
  });

  it("keeps all trend groups but excludes fingerprints in global mode", () => {
    useApiMock.mockReturnValueOnce({ data: { interval: "week", points: [{ bucket: "2026-08-24T00:00:00.000Z", wins: 3, losses: 0, total: 3, winRate: 1 }] }, isLoading: false });
    render(<TrendsDataProvider mode="global" cohort={{ excluded_players: ["one"], excluded_races: ["Z"] }}><TrendsTab /></TrendsDataProvider>);

    expect(screen.queryByTestId("skill-fingerprint")).toBeNull();
    expect(screen.queryByText(/Winning streak/)).toBeNull();
    expect(screen.getByTestId("map-performance")).toBeTruthy();
    expect(screen.getByText("MMR progression")).toBeTruthy();
    expect(screen.getByText("Momentum")).toBeTruthy();
    expect(screen.getByText("Player game records")).toBeTruthy();
    const path = String(useApiMock.mock.calls[0][0]);
    expect(path).toContain("/v1/admin/global-trends/timeseries?");
    expect(path).toContain("excluded_players=one");
    expect(path).toContain("excluded_races=Z");
  });

  it("groups rating and outcome charts ahead of time and calendar analysis", () => {
    render(<TrendsTab />);

    const orderedLabels = [
      "Win rate",
      "Matchup over time",
      "MMR progression",
      "Net MMR by matchup",
      "Opponent MMR buckets",
      "Momentum",
      "Matchup game length",
      "Time of day",
      "Game length",
      "Activity calendar",
      "Map performance over time",
      "Explore performance",
      "Skill fingerprint",
    ];
    const positions = orderedLabels.map((label) => {
      const element = screen.getByText(label).closest("section")!;
      const position = Array.from(document.body.querySelectorAll("section"))
        .indexOf(element);
      expect(position, label).toBeGreaterThanOrEqual(0);
      return position;
    });

    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // Matchup win rates sit directly beneath the headline win-rate card.
    const winRateCard = screen.getByText("Win rate").closest("section");
    expect(winRateCard?.nextElementSibling).toBe(screen.getByText("Matchup over time").parentElement);
    expect(screen.getByRole("heading", { name: "Performance & MMR" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Time & activity" })).toBeTruthy();
    expect(screen.queryByText("Macro score over time")).toBeNull();
  });

  it.each(["personal", "global"] as const)("places Explore performance after the original charts and before any fingerprint in %s mode", (mode) => {
    render(<TrendsDataProvider mode={mode}><TrendsTab /></TrendsDataProvider>);

    const mapPerformance = screen.getByTestId("map-performance");
    const skillFingerprint = screen.queryByTestId("skill-fingerprint");
    const explorer = screen.getByText("Explore performance");
    expect(mapPerformance.compareDocumentPosition(explorer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    if (mode === "personal") {
      expect(explorer.compareDocumentPosition(skillFingerprint!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } else {
      expect(skillFingerprint).toBeNull();
    }
    expect(screen.queryByText("Your build mix over time")).toBeNull();
    expect(screen.queryByText("Strategies you're facing")).toBeNull();
  });
});
