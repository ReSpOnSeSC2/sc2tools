import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLazyHelpLink } from "@/components/help/__tests__/loadLazyHelpLink";

/**
 * /app/compare with each side's three requests answered independently:
 * a complete game A against a game B whose breakdown and build order
 * were never computed, a failed side, a missing game, and a still-loading
 * side.
 */
type Reply = { data?: unknown; error?: { status: number; code?: string; message?: string }; isLoading?: boolean };
const api = vi.hoisted(() => ({ replies: new Map<string, Reply>(), mutated: [] as string[] }));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) => {
    const reply = path ? api.replies.get(path) : undefined;
    return { data: reply?.data, error: reply?.error, isLoading: path ? reply?.isLoading ?? !reply : false,
      mutate: () => { if (path) api.mutated.push(path); return Promise.resolve(); } };
  },
}));
// Error panels carry lazy help links; load that chunk once up front.
beforeAll(loadLazyHelpLink, 20_000);
const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const { CompareGamesPage } = await import("../CompareGamesPage");

const stats = (workers: number) => Array.from({ length: 41 }, (_, i) => ({ time: i * 15, food_workers: workers + i, food_used: 20 + i * 2, food_made: 30 + i * 2, army_value: i * 100, minerals_collection_rate: 500 + i * 20, vespene_collection_rate: 100 }));

function gameA() {
  api.replies.set("/v1/games/ga", { data: { gameId: "ga", result: "Defeat", map: "Alcyone LE", myRace: "Protoss", durationSec: 600, myBuild: "Chargelot", apm: 150, opponent: { displayName: "Rival", race: "Zerg" } } });
  api.replies.set("/v1/games/ga/macro-breakdown", { data: { ok: true, race: "Protoss", macro_score: 64, stats_events: stats(12), raw: { sq: 78, supply_blocked_seconds: 21, chronos_actual: 30, chronos_expected: 40 } } });
  api.replies.set("/v1/games/ga/build-order", { data: { ok: true, my_status: "ok", events: [
    { time: 18, name: "Pylon" }, { time: 90, name: "Gateway" }, { time: 130, name: "Gateway" }, { time: 12, name: "Probe" },
  ] } });
}

beforeEach(() => { api.replies.clear(); api.mutated.length = 0; router.replace.mockReset(); });
afterEach(() => cleanup());

describe("compare page", () => {
  it("shows both headers and hides only the missing parts of game B", () => {
    gameA();
    api.replies.set("/v1/games/gb", { data: { gameId: "gb", result: "Victory", map: "Ruby Rock LE", myRace: "Protoss", durationSec: 540, apm: 160, opponent: { race: "Zerg" } } });
    api.replies.set("/v1/games/gb/macro-breakdown", { error: { status: 404, code: "macro_not_computed" } });
    api.replies.set("/v1/games/gb/build-order", { error: { status: 404, code: "build_not_computed" } });
    render(<CompareGamesPage a="ga" b="gb" />);

    expect(within(screen.getByTestId("compare-side-a")).getByText("Loss")).toBeTruthy();
    expect(screen.getByTestId("compare-side-a").textContent).toContain("vs Rival");
    expect(screen.getByTestId("compare-side-b").textContent).toContain("Ruby Rock LE");

    const timelines = screen.getByTestId("compare-timelines");
    expect(timelines.textContent).toContain("Game B has no timeline data");
    expect(screen.getByTestId("compare-line-a-workers").getAttribute("d")).toMatch(/^M/);
    expect(screen.getByTestId("compare-line-b-workers").getAttribute("d")).toBe("");
    // At the default 6:00 cursor game A has its sample, game B nothing.
    expect(screen.getByTestId("compare-readout-workers").textContent).toBe("A 36 · B — · Δ —");

    const diff = screen.getByTestId("compare-build-diff");
    expect(diff.textContent).toContain("Game B has no build order");
    expect(within(diff).getAllByTestId("compare-build-row")).toHaveLength(3);
    expect(within(diff).getAllByText("A only")).toHaveLength(3);

    const blocked = screen.getByTestId("compare-mechanic-blocked");
    expect(blocked.textContent).toBe("Supply blocked21 s——");
    const apm = screen.getByTestId("compare-mechanic-apm");
    expect(apm.textContent).toContain("150");
    expect(apm.textContent).toContain("160");
    expect(apm.textContent).toContain("-10");
  });

  it("moves one cursor through every chart", () => {
    gameA();
    api.replies.set("/v1/games/gb", { data: { gameId: "gb", result: "Victory", myRace: "Protoss" } });
    api.replies.set("/v1/games/gb/macro-breakdown", { data: { ok: true, stats_events: stats(10) } });
    api.replies.set("/v1/games/gb/build-order", { data: { ok: true, my_status: "ok", events: [{ time: 20, name: "Pylon" }, { time: 100, name: "Gateway" }] } });
    render(<CompareGamesPage a="ga" b="gb" />);
    fireEvent.change(screen.getByRole("slider", { name: /At / }), { target: { value: "150" } });
    expect(screen.getByTestId("compare-readout-workers").textContent).toBe("A 22 · B 20 · Δ +2");
    expect(screen.getByTestId("compare-readout-supply").textContent).toBe("A 40 · B 40 · Δ 0");
    const rows = within(screen.getByTestId("compare-build-diff")).getAllByTestId("compare-build-row");
    expect(rows.map((row) => row.textContent)).toEqual(["Pylon0:180:20−2 s, about the same time", "Gateway1:301:40−10 s, earlier in game A", "Gateway #22:10—A only"]);
  });

  it("shows a retryable failure for one side and keeps the other side's data", () => {
    gameA();
    api.replies.set("/v1/games/gb", { data: { gameId: "gb", result: "Victory", myRace: "Protoss" } });
    api.replies.set("/v1/games/gb/macro-breakdown", { error: { status: 500, message: "Server error" } });
    api.replies.set("/v1/games/gb/build-order", { error: { status: 503, code: "build_busy", message: "Busy" } });
    render(<CompareGamesPage a="ga" b="gb" />);
    const timelines = screen.getByTestId("compare-timelines");
    expect(within(timelines).getByText("Couldn't load game B's timeline")).toBeTruthy();
    expect(timelines.textContent).not.toContain("no timeline data");
    expect(screen.getByTestId("compare-line-a-army").getAttribute("d")).toMatch(/^M/);
    fireEvent.click(within(timelines).getByRole("button", { name: /retry/i }));
    expect(api.mutated).toEqual(["/v1/games/gb/macro-breakdown"]);
    const diff = screen.getByTestId("compare-build-diff");
    expect(within(diff).getByText("Couldn't load game B's build order")).toBeTruthy();
    expect(within(diff).getAllByTestId("compare-build-row")).toHaveLength(3);
  });

  it("keeps a missing game and a loading game apart, and swaps sides", () => {
    gameA();
    api.replies.set("/v1/games/gone", { error: { status: 404 } });
    const view = render(<CompareGamesPage a="ga" b="gone" />);
    expect(screen.getByTestId("compare-side-b").textContent).toContain("isn't in your synced history");
    expect(screen.getByTestId("compare-side-a").textContent).toContain("Alcyone LE");
    fireEvent.click(screen.getByRole("button", { name: "Swap A and B" }));
    expect(router.replace).toHaveBeenCalledWith("/app/compare?a=gone&b=ga", { scroll: false });
    view.unmount();
    render(<CompareGamesPage a="ga" b="slow" />);
    expect(screen.getByTestId("compare-timelines").textContent).toContain("Loading game B");
  });

  it("asks for two games when the link is incomplete", () => {
    gameA();
    render(<CompareGamesPage a="ga" b={null} />);
    expect(screen.getByText("Choose two games")).toBeTruthy();
    expect(screen.getByTestId("compare-side-b").textContent).toContain("No game chosen");
    expect(screen.queryByTestId("compare-timelines")).toBeNull();
  });
});
