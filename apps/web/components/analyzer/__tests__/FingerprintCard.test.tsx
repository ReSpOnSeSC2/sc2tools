import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    { key: "mechanics", label: "Mechanics", percentile: 55, value: 142.1 },
    { key: "spending", label: "Spending", percentile: null, value: null },
    { key: "consistency", label: "Consistency", percentile: 84, value: 6.2 },
    { key: "aggression", label: "Aggression", percentile: 41, value: 25 },
    { key: "ladder", label: "Ladder", percentile: 63, value: 3612 },
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

  it("renders playstyle headline, meta line, and the radar aria summary", () => {
    useApiMock.mockReturnValue({ data: { fingerprint: FP }, isLoading: false });
    render(<FingerprintCard />);

    expect(screen.getByText("Greedy Macro Player")).toBeTruthy();
    expect(screen.getByText(/32 games/)).toBeTruthy();
    expect(screen.getByText(/vs Diamond opposition/)).toBeTruthy();

    const radar = screen.getByRole("img");
    const label = radar.getAttribute("aria-label") || "";
    expect(label).toContain("Skill fingerprint for PvZ");
    expect(label).toContain("versus Diamond opposition");
    expect(label).toContain("Macro 72nd percentile");
    expect(label).toContain("Consistency score 84 of 100");
    expect(label).toContain("Aggression 41st percentile");
    expect(label).toContain("Playstyle: Greedy Macro Player");
    // Null axes are hidden — not narrated, not plotted.
    expect(label).not.toContain("Spending");
  });

  it("lists axes instead of a radar when fewer than 3 are computable", () => {
    const sparse = {
      ...FP,
      axes: FP.axes.map((a) =>
        a.key === "consistency" || a.key === "aggression"
          ? a
          : { ...a, percentile: null },
      ),
    };
    useApiMock.mockReturnValue({
      data: { fingerprint: sparse },
      isLoading: false,
    });
    render(<FingerprintCard />);
    expect(screen.getByText("Consistency")).toBeTruthy();
    expect(screen.getByText("84/100")).toBeTruthy();
    expect(screen.getByText("41st pct")).toBeTruthy();
    expect(screen.queryByText("Macro")).toBeNull();
  });

  it("shows the friendly empty state below 10 games (404 not_enough_games)", () => {
    useApiMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { status: 404, code: "not_enough_games", message: "Not found." },
    });
    render(<FingerprintCard />);
    expect(screen.getByText(/Not enough PvZ games yet/)).toBeTruthy();
    expect(screen.getByText(/at least 10 PvZ games/)).toBeTruthy();
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

    // Active chips carry aria-pressed for assistive tech.
    expect(
      screen
        .getByRole("button", { name: "I play Zerg" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
