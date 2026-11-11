import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ replies: new Map<string, unknown>(), paths: [] as string[], request: vi.fn() }));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) => {
    if (path) api.paths.push(path);
    return { data: path ? api.replies.get(path.split("#")[0]) : undefined, error: undefined, isLoading: false, mutate: vi.fn(), request: api.request };
  },
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "u1", isLoaded: true, isSignedIn: true }) }));

const { CompareGamesButton, COMPARE_HINT_KEY } = await import("../CompareGamesButton");
const { CompareSelectionButton } = await import("../CompareSelectionButton");
beforeAll(async () => { await import("../CompareGamePicker"); });

const FIRST = "r-" + "1".repeat(24);
const SECOND = "r-" + "2".repeat(24);
beforeEach(() => {
  window.localStorage.clear(); api.replies.clear(); api.paths.length = 0; router.push.mockReset();
  api.request.mockReset().mockResolvedValue({ references: [FIRST, SECOND] });
});
afterEach(() => cleanup());

const game = { gameId: "g1", result: "Defeat", myBuild: "Chargelot", myRace: "Protoss", opponent: { pulseId: "p1", race: "Zerg", displayName: "Rival" } };

describe("Compare… on the game page", () => {
  it("shows a one-time hint until it is used or dismissed", () => {
    const view = render(<CompareGamesButton game={game} />);
    expect(screen.getByTestId("compare-hint")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByTestId("compare-hint")).toBeNull();
    expect(window.localStorage.getItem(COMPARE_HINT_KEY)).toBe("true");
    view.unmount();
    render(<CompareGamesButton game={game} />);
    expect(screen.queryByTestId("compare-hint")).toBeNull();
  });

  it("opens the picker with the three smart chips and compares with the chosen game", async () => {
    api.replies.set("/v1/replays?build=Chargelot&result=win&limit=25&sort=date_desc&enrich=none", { items: [
      { gameId: "w1", result: "Victory", map: "Alcyone LE", macroScore: 70 },
      { gameId: "w2", result: "Victory", map: "Ruby Rock LE", macroScore: 88 },
    ] });
    api.replies.set("/v1/games/g1/neighbors?scope=opponent", { prev: { gameId: "o1", result: "Victory", map: "Pylon LE" }, next: null });
    api.replies.set("/v1/replays?matchup=PvZ&limit=2&sort=date_desc&enrich=none", { items: [
      { ...game, date: "2026-11-11" }, { gameId: "m1", result: "Defeat", map: "Oceanborn", date: "2026-11-10" },
    ] });
    render(<CompareGamesButton game={game} buildLabel="Chargelot" />);
    fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
    await screen.findByTestId("compare-picker");
    expect(window.localStorage.getItem(COMPARE_HINT_KEY)).toBe("true");
    const best = screen.getByRole("button", { name: /Best recent win with this build/ });
    expect(best.textContent).toContain("Ruby Rock LE");
    expect(screen.getByRole("button", { name: /Previous game vs this opponent/ }).textContent).toContain("Pylon LE");
    expect(screen.getByRole("button", { name: /Last game in this matchup/ }).textContent).toContain("Oceanborn");
    fireEvent.click(best);
    expect(api.request).toHaveBeenCalledWith({ method: "POST", body: JSON.stringify({ gameIds: ["g1", "w2"] }) });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/app/compare?a=${FIRST}&b=${SECOND}`));
  });

  it("disables a chip with nothing to offer", async () => {
    render(<CompareGamesButton game={{ gameId: "g2" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
    await screen.findByTestId("compare-picker");
    expect(screen.getByRole("button", { name: /Best recent win with this build/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Previous game vs this opponent/ }).hasAttribute("disabled")).toBe(true);
    // No build label and no opponent identity: those reads are never made.
    expect(api.paths.some((path) => path.includes("build="))).toBe(false);
    expect(api.paths.some((path) => path.includes("scope=opponent"))).toBe(false);
  });
});

describe("Compare in Replays", () => {
  it("resolves exactly two selected replays, first selected as game A", async () => {
    const legacy = "date|Rival Name|Map";
    const view = render(<CompareSelectionButton ids={[legacy, "x2"]} />);
    fireEvent.click(screen.getByRole("button", { name: /Compare 2 games/ }));
    expect(api.request).toHaveBeenCalledWith({ method: "POST", body: JSON.stringify({ gameIds: [legacy, "x2"] }) });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/app/compare?a=${FIRST}&b=${SECOND}`));
    view.rerender(<CompareSelectionButton ids={["x1"]} />);
    expect(screen.getByRole("button", { name: /Compare/ }).hasAttribute("disabled")).toBe(true);
    view.rerender(<CompareSelectionButton ids={["x1", "x2", "x3"]} />);
    expect(screen.getByRole("button", { name: /Compare/ }).hasAttribute("disabled")).toBe(true);
  });

  it("reports a replay that disappeared before navigation", async () => {
    api.request.mockResolvedValue({ references: [FIRST, null] });
    render(<CompareSelectionButton ids={["x1", "x2"]} />);
    fireEvent.click(screen.getByRole("button", { name: /Compare 2 games/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("no longer in your synced history");
    expect(router.push).not.toHaveBeenCalled();
  });
});
