import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyzerProvider, filtersFromViewQuery, toStoredFilters } from "../AnalyzerProvider";
import { filtersToQuery, useFilters } from "@/lib/filterContext";
import { viewFiltersFromQuery } from "@/lib/analyzerViews";
const auth = vi.hoisted(() => ({ userId: "owner-a" as string | null, isLoaded: true, isSignedIn: true }));
const observations: Array<{ owner: string | null; accounts?: string }> = [];
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
vi.mock("@/lib/useSeasons", async original => ({ ...await original<typeof import("@/lib/useSeasons")>(), useSeasons: () => ({ data: undefined }) }));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: () => undefined }));
vi.mock("@/components/analyzer/arcade/hooks/useAnalysisGames", () => ({ AnalysisGamesProvider: ({ children }: { children: React.ReactNode }) => children }));
function Readout() {
  const { filters, setFilters } = useFilters(); observations.push({ owner: auth.userId, accounts: filters.accounts });
  return <><output>{filtersToQuery(filters)}</output><button onClick={() => setFilters({ ...filters, accounts: "2-S2-1-1" })}>Choose account</button></>;
}
beforeEach(() => { Object.assign(auth, { userId: "owner-a", isLoaded: true, isSignedIn: true }); observations.length = 0; localStorage.clear(); window.history.replaceState(null, "", "/app/replays"); });
afterEach(cleanup);
describe("account filter ownership", () => {
  it("keeps account handles out of shared device storage", () => {
    expect(toStoredFilters({ accounts: "2-S2-1-1", race: "P" })).not.toHaveProperty("accounts");
    render(<AnalyzerProvider><Readout /></AnalyzerProvider>);
    fireEvent.click(screen.getByText("Choose account"));
    expect(screen.getByRole("status").textContent).toContain("accounts=");
    expect(localStorage.getItem("analyzer.filters")).not.toContain("accounts");
  });
  it("never exposes a previous-owner cohort while switching, loading or signing out", () => {
    const view = render(<AnalyzerProvider><Readout /></AnalyzerProvider>);
    fireEvent.click(screen.getByText("Choose account")); observations.length = 0;
    auth.userId = "owner-b"; view.rerender(<AnalyzerProvider><Readout /></AnalyzerProvider>);
    expect(observations.every(row => row.accounts === undefined)).toBe(true);
    fireEvent.click(screen.getByText("Choose account")); observations.length = 0;
    auth.isLoaded = false; view.rerender(<AnalyzerProvider><Readout /></AnalyzerProvider>);
    expect(observations.every(row => row.accounts === undefined)).toBe(true);
    Object.assign(auth, { isLoaded: true, isSignedIn: false, userId: null });
    view.rerender(<AnalyzerProvider><Readout /></AnalyzerProvider>);
    expect(screen.getByRole("status").textContent).not.toContain("accounts");
  });
  it("accepts an initial URL cohort after auth loading, while full snapshots without it clear it", async () => {
    Object.assign(auth, { userId: null, isLoaded: false });
    window.history.replaceState(null, "", "/app/replays?filters=1&preset=all&accounts=2-S2-1-1");
    const view = render(<AnalyzerProvider syncUrl><Readout /></AnalyzerProvider>);
    expect(screen.getByRole("status").textContent).not.toContain("accounts");
    Object.assign(auth, { userId: "owner-a", isLoaded: true });
    view.rerender(<AnalyzerProvider syncUrl><Readout /></AnalyzerProvider>);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("accounts="));
    const base = { preset: "all" as const, accounts: "2-S2-1-1" };
    expect(filtersFromViewQuery(base, viewFiltersFromQuery(new URLSearchParams("filters=1&preset=all"))).accounts).toBeUndefined();
    expect(filtersFromViewQuery(base, viewFiltersFromQuery(new URLSearchParams("race=P"))).accounts).toBe("2-S2-1-1");
    expect(filtersFromViewQuery(base, viewFiltersFromQuery(new URLSearchParams("accounts="))).accounts).toBeUndefined();
  });
});
