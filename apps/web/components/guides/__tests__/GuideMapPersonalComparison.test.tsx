import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GuideMapPersonalComparison } from "../map/GuideMapPersonalComparison";
import type { GuideMapPayload } from "@/lib/guides/types";

const state = vi.hoisted(() => ({ signedIn: false, loaded: true, paths: [] as (string | null)[], error: false }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: state.loaded, isSignedIn: state.signedIn }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string | null) => { state.paths.push(path); return { data: state.error ? undefined : [{ map: "Alpha [LE]", matchup: "vs Z", wins: 4, losses: 6, total: 12 }], error: state.error ? new Error("Synthetic outage") : undefined, isPreviousData: false, mutate: vi.fn() }; } }));
const payload: GuideMapPayload = { published: true, map: "Alpha", mapSlug: "alpha", era: "after", patch: "5.0.17", computedAt: "2026-10-20", games: 100,
  matchups: [{ matchup: "PvZ", slug: "pvz", games: 100, users: 20, wins: 55, winRate: 0.55, ci: { low: 0.45, high: 0.65 }, openers: [] }] };
beforeEach(() => { state.signedIn = false; state.loaded = true; state.error = false; state.paths = []; });
afterEach(cleanup);

describe("map guide personal comparison", () => {
  it("shows a return-aware sign-in link and never requests private stats while signed out", () => {
    render(<GuideMapPersonalComparison payload={payload} />);
    expect(screen.getByRole("link", { name: "Sign in to compare your map record" }).getAttribute("href")).toContain("guides%2Fmaps%2Falpha");
    expect(state.paths).toEqual([]);
  });
  it("loads one bounded personal map response, matches LE names and uses the selected community side", async () => {
    state.signedIn = true; render(<GuideMapPersonalComparison payload={payload} />);
    expect(await screen.findByText("4W · 6L · n=10 decided")).toBeTruthy();
    expect(state.paths.every((path) => path?.startsWith("/v1/maps/matchups?patch_era=after"))).toBe(true);
    expect(screen.queryByText(/Community 55/)).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Your race" }), { target: { value: "P" } });
    expect(await screen.findByText(/Community 55.*−15.0 pp/)).toBeTruthy();
    expect(state.paths.at(-1)).toBe("/v1/maps/matchups?patch_era=after&race=P");
    expect(screen.getByRole("link", { name: "Open your maps and veto planner" }).getAttribute("href")).toBe("/app/maps?focus=Alpha");
  });
  it("offers recovery without a false empty sample on request failure", async () => {
    state.signedIn = true; state.error = true; render(<GuideMapPersonalComparison payload={payload} />);
    expect(await screen.findByTestId("request-error")).toBeTruthy(); expect(screen.queryByText(/no synced games/)).toBeNull();
  });
});
