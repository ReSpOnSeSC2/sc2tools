import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyzerProvider, filtersFromViewQuery } from "../AnalyzerProvider";
import { useFilters } from "@/lib/filterContext";
import { viewFiltersFromQuery } from "@/lib/analyzerViews";
import { AnalyzerFilterUrlSync } from "../analyzer/AnalyzerFilterUrlSync";

const navigation = vi.hoisted(() => ({ path: "/app/maps", query: "", replace: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "owner" }) }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.path, useSearchParams: () => new URLSearchParams(navigation.query), useRouter: () => ({ replace: navigation.replace }) }));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: () => undefined }));
vi.mock("@/lib/useSeasons", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/useSeasons")>(), useSeasons: () => ({ data: undefined }) }));
vi.mock("@/components/analyzer/arcade/hooks/useAnalysisGames", () => ({ AnalysisGamesProvider: ({ children }: { children: React.ReactNode }) => children }));
function Readout() { const { filters, setFilters } = useFilters(); return <><pre data-testid="filters">{JSON.stringify(filters)}</pre><button onClick={() => setFilters({ ...filters, race: "T" })}>Terran</button></>; }
const value = () => JSON.parse(screen.getByTestId("filters").textContent!);
beforeEach(() => { localStorage.clear(); navigation.path = "/app/maps"; navigation.query = ""; navigation.replace.mockReset(); window.history.replaceState(null, "", "/app/maps"); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("analyzer URL hydration", () => {
  it("URL keys override storage for this session and subsequent changes do not persist them", async () => {
    localStorage.setItem("analyzer.filters", JSON.stringify({ preset: "last_30d", race: "Z", regions: "NA", regions_rev: 1 }));
    const stored = localStorage.getItem("analyzer.filters");
    navigation.query = "preset=season%3A67&race=P&build=Pressure&regions=EU";
    window.history.replaceState(null, "", `/app/maps?${navigation.query}`);
    render(<AnalyzerProvider syncUrl><Readout /></AnalyzerProvider>);
    await waitFor(() => expect(value()).toMatchObject({ preset: "season:67", race: "P", regions: "EU", build: "Pressure" }));
    fireEvent.click(screen.getByText("Terran"));
    expect(localStorage.getItem("analyzer.filters")).toBe(stored);
  });

  it("a complete copied view clears a recipient's stored matchup, region and drilldowns", async () => {
    localStorage.setItem("analyzer.filters", JSON.stringify({ preset: "last_30d", race: "Z", regions: "NA", regions_rev: 1 }));
    navigation.query = "filters=1&preset=all"; window.history.replaceState(null, "", `/app/maps?${navigation.query}`);
    render(<AnalyzerProvider syncUrl><Readout /></AnalyzerProvider>);
    await waitFor(() => expect(value().preset).toBe("all"));
    expect(value().race).toBeUndefined(); expect(value().regions).toBeUndefined();
  });

  it("normal manual selections still persist only the existing allowed controls", async () => {
    render(<AnalyzerProvider syncUrl><Readout /></AnalyzerProvider>);
    await waitFor(() => expect(value().preset).toBeTruthy());
    fireEvent.click(screen.getByText("Terran"));
    expect(JSON.parse(localStorage.getItem("analyzer.filters")!).race).toBe("T");
  });

  it("round-trips explicit cleared controls and exact-map bindings without PTR migration", () => {
    const parsed = viewFiltersFromQuery(new URLSearchParams('race=&regions=EU&map=Wrong&map_exact=%5B%22Alpha%22%5D'));
    expect(filtersFromViewQuery({ preset: "all", race: "Z" }, parsed)).toMatchObject({ preset: "all", regions: "EU", map: "Alpha", map_exact_label: "Alpha" });
    expect(filtersFromViewQuery({ preset: "all", race: "Z" }, parsed).race).toBeUndefined();
    const custom = filtersFromViewQuery({ preset: "last_30d", since: "2026-10-01" }, viewFiltersFromQuery(new URLSearchParams("filters=1&preset=custom")));
    expect(custom.preset).toBe("custom"); expect(custom.since).toBeUndefined(); expect(custom.until).toBeUndefined();
  });

  it("restores filter snapshots in both navigation directions without overwriting storage", async () => {
    localStorage.setItem("analyzer.filters", JSON.stringify({ preset: "all", race: "T", regions_rev: 1 }));
    const stored = localStorage.getItem("analyzer.filters");
    navigation.query = "filters=1&preset=all&race=P"; window.history.replaceState(null, "", `/app/maps?${navigation.query}`);
    const view = render(<AnalyzerProvider syncUrl><Readout /></AnalyzerProvider>);
    await waitFor(() => expect(value().race).toBe("P"));
    await act(async () => { await import("../analyzer/AnalyzerFilterUrlSync"); });
    navigation.query = "filters=1&preset=all&race=Z"; window.history.replaceState(null, "", `/app/maps?${navigation.query}`);
    view.rerender(<AnalyzerProvider syncUrl><Readout /></AnalyzerProvider>);
    await waitFor(() => expect(value().race).toBe("Z"));
    navigation.query = "filters=1&preset=all&race=P"; window.history.replaceState(null, "", `/app/maps?${navigation.query}`);
    view.rerender(<AnalyzerProvider syncUrl><Readout /></AnalyzerProvider>);
    await waitFor(() => expect(value().race).toBe("P"));
    expect(localStorage.getItem("analyzer.filters")).toBe(stored);
  });

  it("debounces router.replace without scroll or history pushes and keeps local section state", async () => {
    navigation.query = "q=search&view=cards"; window.history.replaceState(null, "", `/app/maps?${navigation.query}`);
    render(<AnalyzerProvider syncUrl><Readout /></AnalyzerProvider>);
    await act(async () => { await import("../analyzer/AnalyzerFilterUrlSync"); });
    fireEvent.click(screen.getByText("Terran"));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalled());
    const [href, options] = navigation.replace.mock.calls.at(-1)!;
    expect(href).toContain("q=search"); expect(href).toContain("view=cards"); expect(href).toContain("race=T"); expect(options).toEqual({ scroll: false });
  });

  it("does not add filter state to individual game or dossier URLs", async () => {
    navigation.path = "/app/game/g1"; window.history.replaceState(null, "", "/app/game/g1?t=120");
    render(<AnalyzerProvider syncUrl><Readout /></AnalyzerProvider>);
    await act(async () => { await import("../analyzer/AnalyzerFilterUrlSync"); });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("a pending filter write cannot overwrite an incoming Back or Apply cohort before Next rerenders", async () => {
    vi.useFakeTimers();
    navigation.query = "filters=1&preset=all&race=T";
    window.history.replaceState(null, "", `/app/maps?${navigation.query}`);
    const onNavigate = vi.fn();
    const view = render(<AnalyzerFilterUrlSync ready filters={{ preset: "all", race: "T" }} onNavigate={onNavigate} />);
    view.rerender(<AnalyzerFilterUrlSync ready filters={{ preset: "all", race: "Z" }} onNavigate={onNavigate} />);
    window.history.replaceState(null, "", "/app/maps?filters=1&preset=all&race=P");
    await act(async () => { vi.advanceTimersByTime(260); });
    expect(navigation.replace).not.toHaveBeenCalled();
    navigation.query = "filters=1&preset=all&race=P";
    view.rerender(<AnalyzerFilterUrlSync ready filters={{ preset: "all", race: "Z" }} onNavigate={onNavigate} />);
    expect(onNavigate).toHaveBeenLastCalledWith(expect.objectContaining({ filters: { preset: "all", race: "P" } }));
    view.rerender(<AnalyzerFilterUrlSync ready filters={{ preset: "all", race: "P" }} onNavigate={onNavigate} />);
    await act(async () => { vi.advanceTimersByTime(260); });
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("withholds an invalid exact-map view rather than showing a broader substring cohort", async () => {
    navigation.query = "filters=1&map=Sanctuary+II&map_exact=%5Bbroken";
    window.history.replaceState(null, "", `/app/maps?${navigation.query}`);
    const view = render(<AnalyzerProvider syncUrl><Readout /></AnalyzerProvider>);
    await screen.findByRole("alert");
    expect(screen.queryByTestId("filters")).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 275));
    expect(navigation.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use current filters" }));
    const href = navigation.replace.mock.calls.at(-1)![0];
    expect(href).not.toContain("map_exact"); expect(href).not.toContain("Sanctuary");
    navigation.query = href.split("?")[1]; window.history.replaceState(null, "", href);
    view.rerender(<AnalyzerProvider syncUrl><Readout /></AnalyzerProvider>);
    await screen.findByTestId("filters"); expect(screen.queryByRole("alert")).toBeNull();
  });
});
