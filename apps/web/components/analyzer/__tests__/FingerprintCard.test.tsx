import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { FingerprintCard } from "../FingerprintCard";

const useApiMock = vi.fn();
vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

// recharts' ResponsiveContainer observes its parent unconditionally;
// jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ||
  ResizeObserverStub;

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
  window.localStorage.clear();
});

const FP = {
  matchup: "PvZ",
  band: { leagueId: 4, label: "Diamond" },
  games: 32,
  axes: [
    { key: "macro", label: "Macro", percentile: 72, value: 68.4 },
    { key: "mechanics", label: "Mechanics", percentile: null, value: null },
    { key: "spending", label: "Spending", percentile: null, value: null },
    { key: "consistency", label: "Consistency", percentile: 84, value: 6.2 },
    { key: "aggression", label: "Aggression", percentile: 32, value: 25 },
    { key: "ladder", label: "MMR context", percentile: 63, value: 3612 },
  ],
  playstyle: "Greedy Macro Player",
};

describe("FingerprintCard", () => {
  it("requests the fingerprint endpoint for the default matchup", () => {
    useApiMock.mockReturnValue({ data: undefined, isLoading: true });
    render(<FingerprintCard />);
    expect(useApiMock).toHaveBeenCalledWith(
      "/v1/me/fingerprint?matchup=PvZ",
      { revalidateOnFocus: false },
    );
  });

  it("shows a skeleton while loading", () => {
    useApiMock.mockReturnValue({ data: undefined, isLoading: true });
    render(<FingerprintCard />);
    expect(screen.getByText("Skill fingerprint")).toBeTruthy();
  });

  it("explains the current label and every available signal in plain language", () => {
    useApiMock.mockReturnValue({ data: { fingerprint: FP }, isLoading: false });
    render(<FingerprintCard />);

    expect(
      screen.getByRole("heading", { name: "Greedy Macro Player" }),
    ).toBeTruthy();
    expect(screen.getByText(/Macro scored 72 \(70\+\)/)).toBeTruthy();
    expect(screen.getByText(/Game tempo scored 32 \(below 40\)/)).toBeTruthy();
    expect(screen.getByText(/32 most recent PvZ 1v1 replays/)).toBeTruthy();
    expect(
      screen.getByText("Benchmark: PvZ games against mostly Diamond opponents."),
    ).toBeTruthy();
    expect(screen.getByText("3 of 5 available")).toBeTruthy();
    expect(screen.getByText("63rd MMR percentile")).toBeTruthy();
    expect(
      screen.getByText(/Matchmaking Rating shows the level you play at/),
    ).toBeTruthy();
    expect(screen.getByText(/kept outside the graph/)).toBeTruthy();
    expect(
      screen.getByText(/Three available signals make this a triangle/),
    ).toBeTruthy();

    const signals = screen
      .getByRole("heading", { name: "What the signals mean" })
      .closest("section");
    expect(signals).toBeTruthy();
    const values = within(signals!);
    expect(values.getByText("Macro")).toBeTruthy();
    expect(values.getByText("72nd percentile")).toBeTruthy();
    expect(values.getByText("Consistency")).toBeTruthy();
    expect(values.getByText("84/100")).toBeTruthy();
    expect(values.getByText("Game tempo")).toBeTruthy();
    expect(values.queryByText(/MMR/)).toBeNull();
    expect(values.getByText(/Not shown:/)).toBeTruthy();
    expect(values.getByText(/Mechanics and Spending/)).toBeTruthy();
    expect(screen.getByTestId("fingerprint-radar")).toBeTruthy();
  });

  it("uses the semantic signal list and a friendly note when a radar cannot be drawn", () => {
    const sparse = {
      ...FP,
      axes: FP.axes.map((axis) =>
        axis.key === "consistency" || axis.key === "aggression"
          ? axis
          : { ...axis, percentile: null },
      ),
    };
    useApiMock.mockReturnValue({
      data: { fingerprint: sparse },
      isLoading: false,
    });
    render(<FingerprintCard />);

    const signals = screen
      .getByRole("heading", { name: "What the signals mean" })
      .closest("section");
    expect(signals).toBeTruthy();
    const values = within(signals!);
    expect(values.getByText("Consistency")).toBeTruthy();
    expect(values.getByText("84/100")).toBeTruthy();
    expect(values.getByText("Game tempo")).toBeTruthy();
    expect(values.getByText("32nd percentile")).toBeTruthy();
    expect(screen.queryByTestId("fingerprint-radar")).toBeNull();
    expect(
      screen.getByText(/A radar appears when at least three signals/),
    ).toBeTruthy();
  });

  it("documents the scoring method, MMR meaning, and every playstyle rule", () => {
    useApiMock.mockReturnValue({ data: { fingerprint: FP }, isLoading: false });
    render(<FingerprintCard />);

    const summary = screen.getByText("Calculation and playstyle guide");
    const details = summary.closest("details");
    expect(details).toBeTruthy();
    expect(details!.open).toBe(false);
    fireEvent.click(summary);
    expect(details!.open).toBe(true);

    const guide = within(details!);
    expect(guide.getByText(/latest 10–50 PvZ 1v1 replays/)).toBeTruthy();
    expect(guide.getByText(/score, not a percentile/)).toBeTruthy();
    expect(guide.getByText(/MMR is StarCraft II's matchmaking rating/)).toBeTruthy();
    expect(guide.getByText(/not a radar signal and does not affect/)).toBeTruthy();
    expect(guide.getByText(/first match becomes the label/)).toBeTruthy();
    expect(guide.getByText(/MMR is never part of these rules/)).toBeTruthy();
    for (const label of [
      "Complete Player",
      "All-in Gambler",
      "Greedy Macro Player",
      "Tempo Attacker",
      "Economic Engine",
      "Busy Hands, Idle Bank",
      "Metronome",
      "Coin-Flip Player",
      "Jack of All Trades",
    ]) {
      expect(guide.getByText(label)).toBeTruthy();
    }
    expect(guide.getByText("Your label")).toBeTruthy();
  });

  it("shows the friendly empty state below 10 games", () => {
    useApiMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { status: 404, code: "not_enough_games", message: "Not found." },
    });
    render(<FingerprintCard />);
    expect(screen.getByText(/Not enough PvZ games yet/)).toBeTruthy();
    expect(screen.getByText(/at least 10 PvZ 1v1 games/)).toBeTruthy();
  });

  it("shows a generic failure state on other errors", () => {
    useApiMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { status: 500, message: "boom" },
    });
    render(<FingerprintCard />);
    expect(screen.getByText(/Couldn't load your fingerprint/)).toBeTruthy();
  });

  it("matchup picker refetches and persists the selection", () => {
    useApiMock.mockReturnValue({ data: { fingerprint: FP }, isLoading: false });
    render(<FingerprintCard />);

    fireEvent.click(screen.getByRole("button", { name: "Versus Terran" }));
    expect(useApiMock).toHaveBeenLastCalledWith(
      "/v1/me/fingerprint?matchup=PvT",
      { revalidateOnFocus: false },
    );

    fireEvent.click(screen.getByRole("button", { name: "I play Zerg" }));
    expect(useApiMock).toHaveBeenLastCalledWith(
      "/v1/me/fingerprint?matchup=ZvT",
      { revalidateOnFocus: false },
    );
    expect(window.localStorage.getItem("analyzer.fingerprint.matchup")).toBe(
      "ZvT",
    );
    expect(
      screen
        .getByRole("button", { name: "I play Zerg" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
