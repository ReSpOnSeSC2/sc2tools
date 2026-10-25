import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ReferenceComparison, type ReferenceComparisonResponse } from "./ReferenceComparison";
import { useApi } from "@/lib/clientApi";

vi.mock("@/lib/clientApi", () => ({ useApi: vi.fn() }));
vi.mock("@/lib/ghostPracticeEvents", () => ({ GHOST_SYNC_EVENT: "ghost-target-changed" }));
vi.mock("@/components/ui/Icon", () => ({ Icon: () => null }));

const mutate = vi.fn();
const ready: ReferenceComparisonResponse = {
  status: "ready", matchup: "PvT", buildKey: "two-gate",
  reference: { name: "Two gate reference", sourceGameId: "source", revision: "reference-revision" },
  rows: [
    { name: "Gateway", occurrence: 1, targetSec: 40, actualSec: 50, deltaSec: 10, kind: "building", timing: "started", status: "observed" },
    { name: "Gateway", occurrence: 2, targetSec: 120, actualSec: 110, deltaSec: -10, kind: "building", timing: "started", status: "observed" },
    { name: "BlinkTech", occurrence: 1, targetSec: 240, actualSec: null, deltaSec: null, kind: "upgrade", timing: "completed", status: "missing" },
    { name: "Stalker", occurrence: 1, targetSec: 130, actualSec: 140, deltaSec: null, kind: "unit", timing: "started", status: "event_mismatch" },
  ],
};

beforeEach(() => {
  vi.mocked(useApi).mockReturnValue({ data: ready, isLoading: false, isPreviousData: false, error: undefined, mutate } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("historical Ghost reference comparison", () => {
  it("uses the exact replay, side and custom build key without implying live completion", () => {
    render(<ReferenceComparison gameId="replay/one" buildKey="two gate+blink" side="opponent" />);
    expect(useApi).toHaveBeenCalledWith("/v1/me/ghost-builds/comparison?gameId=replay%2Fone&side=opponent&buildKey=two+gate%2Bblink", { keepPreviousData: false });
    expect(screen.getByText(/Historical replay timings only, not live completion/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Reference comparison perspective" })).toBeNull();
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText("0:40")).toBeTruthy();
    expect(within(rows[1]).getByText("+10s later")).toBeTruthy();
    expect(within(rows[2]).getByText("Gateway #2")).toBeTruthy();
    expect(within(rows[2]).getByText("−10s earlier")).toBeTruthy();
    expect(screen.getByText("Not in extracted opening")).toBeTruthy();
    expect(screen.getByText("Different event timing")).toBeTruthy();
    expect(screen.getByText(/No build durations are subtracted/)).toBeTruthy();
  });

  it("lets dossier readers compare either player's opening and refreshes when a reference changes", () => {
    render(<ReferenceComparison gameId="game" />);
    fireEvent.click(screen.getByRole("button", { name: "Opponent build" }));
    expect(useApi).toHaveBeenLastCalledWith("/v1/me/ghost-builds/comparison?gameId=game&side=opponent", { keepPreviousData: false });
    window.dispatchEvent(new Event("ghost-target-changed"));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["source_replay", /reference replay itself/],
    ["no_reference", /No reference for this player’s build in this exact matchup/],
    ["replay_pending", /after the game ends/],
  ] as const)("shows an honest %s state instead of invented deltas", (status, message) => {
    vi.mocked(useApi).mockReturnValue({ data: { ...ready, status, rows: [] }, mutate } as never);
    render(<ReferenceComparison gameId="game" />);
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("suppresses another query's answer and exposes a retry after failure", () => {
    vi.mocked(useApi).mockReturnValue({ data: ready, isPreviousData: true, mutate } as never);
    const { rerender } = render(<ReferenceComparison gameId="game" />);
    expect(screen.queryByText("Two gate reference")).toBeNull();
    expect(screen.getByText("Loading reference comparison…")).toBeTruthy();
    vi.mocked(useApi).mockReturnValue({ data: ready, error: { message: "unavailable" }, mutate } as never);
    rerender(<ReferenceComparison gameId="other" />);
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry comparison" }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
