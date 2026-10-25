import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MapGamesModal } from "./MapGamesModal";
const state = vi.hoisted(() => ({ paths: [] as (string | null)[], setFilters: vi.fn() }));
vi.mock("@/lib/filterContext", async (original) => ({ ...(await original<typeof import("@/lib/filterContext")>()), useFilters: () => ({ filters: { race: "P", opp_race: "Z" }, dbRev: 2, setFilters: state.setFilters }) }));
vi.mock("@/lib/useMyDisplayName", () => ({ useMyDisplayName: () => "You" }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string | null) => { state.paths.push(path); return { data: { total: 101, games: [{ id: "owned-game", build: "Blink", map: "Alpha LE" }] }, mutate: vi.fn() }; } }));
vi.mock("../AllGamesTable", () => ({ AllGamesTable: ({ games }: { games: { id: string; my_build: string }[] }) => <output>{games.map((game) => `${game.id}: ${game.my_build}`).join(",")}</output> }));
afterEach(() => { cleanup(); state.paths = []; state.setFilters.mockClear(); });
describe("map sample drilldown", () => {
  it("fetches one bounded cohort, preserves the selected planner window and filters everything by map", () => {
    const close = vi.fn(); render(<MapGamesModal drill={{ map: "Alpha LE", opponent: "T", filters: { since: "2026-09-01", race: "Z" } }} onClose={close} />);
    expect(new URL(state.paths[0]!, "https://example.test").searchParams.toString()).toBe("since=2026-09-01&race=Z&map=Alpha+LE&opp_race=T&sort=date_desc&limit=100");
    expect(screen.getByText("owned-game: Blink")).toBeTruthy(); expect(screen.getByText("Showing the latest 1 of 101 matching games.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Filter everything to this map" }));
    expect(state.setFilters).toHaveBeenCalledWith({ race: "P", opp_race: "Z", map: "Alpha LE" }); expect(close).toHaveBeenCalledOnce();
  });
});
